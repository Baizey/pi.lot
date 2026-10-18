import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {ServerConfigStore, type ServerConfig} from "../src/server/ServerConfig.js";
import {SERVER_VERSION_REQUIREMENT} from "../src/server/ServerCompatibility.js";
import type {ServerStatus} from "../src/server/ServerConnection.js";

const CONFIG = {url: "https://sessions.example.com", apiKey: "private-command-test-key"};
const SERVER_VERSION = "1.2.3";
const OTHER_VERSION = "9.8.7";
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type VersionCheck = NonNullable<ConstructorParameters<typeof ServerCommand>[2]>;
type UploadArchive = NonNullable<ConstructorParameters<typeof ServerCommand>[3]>;
const REPORT = {uploaded: 2, unchanged: 1, failed: 0, warnings: [], failures: []};

function harness(
    t: TestContext,
    answers: Array<string | undefined> = [],
    hasUI = true,
    checkVersion: VersionCheck = async () => ({kind: "compatible", version: SERVER_VERSION}),
    uploadArchive: UploadArchive = async () => REPORT,
) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-command-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const commands = new Map<string, RegisteredCommand>();
    let shutdown: (() => void) | undefined;
    const pi = {
        on(event: string, handler: () => void) {
            if (event === "session_shutdown") shutdown = handler;
        },
        registerCommand(name: string, options: RegisteredCommand) {
            commands.set(name, options);
        },
    } as ExtensionAPI;
    const checks: Array<{config: ServerConfig; signal: AbortSignal | undefined}> = [];
    const instance = new ServerCommand(pi, store, (config, signal) => {
        checks.push({config: {...config}, signal});
        return checkVersion(config, signal);
    }, uploadArchive);
    instance.register();
    const command = commands.get("server");
    assert.ok(command);
    const prompts: Array<{title: string; placeholder?: string}> = [];
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        hasUI,
        ui: {
            async input(title: string, placeholder?: string) {
                prompts.push({title, placeholder});
                return answers.shift();
            },
            notify(message: string, type: "info" | "warning" | "error" = "info") {
                notifications.push({message, type});
            },
        },
    } as ExtensionCommandContext;
    return {directory, store, instance, command, prompts, notifications, checks, ctx, shutdown: () => shutdown?.()};
}

test("server command with no config shows only unconfigured status and makes no request", async (t) => {
    const {command, ctx, directory, notifications, prompts, checks} = harness(t);
    assert.deepEqual(readdirSync(directory), []);
    await command.handler("", ctx);
    assert.deepEqual(notifications, [{message: "Config: none\nStatus: Not configured.", type: "info"}]);
    assert.deepEqual(checks, []);
    assert.deepEqual(prompts, []);
    assert.deepEqual(readdirSync(directory), []);
});

test("login stores inputs locally; bare server shows the complete config and checked status", async (t) => {
    const {command, ctx, store, notifications, prompts, checks} = harness(t, [CONFIG.url, CONFIG.apiKey]);
    await command.handler(" LOGIN ", ctx);
    assert.deepEqual(prompts, [
        {title: "pi.server URL", placeholder: "https://sessions.example.com"},
        {title: "pi.server API key", placeholder: undefined},
    ]);
    assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), CONFIG);
    assert.match(notifications.at(-1)?.message ?? "", /Saved/);
    assert.equal(checks.length, 0);
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
    await command.handler("", ctx);
    assert.deepEqual(checks.map((check) => check.config), [CONFIG]);
    assert.deepEqual(notifications.at(-1), {
        message: `${JSON.stringify(CONFIG, null, 2)}\n\nStatus: Connected (pi.server ${SERVER_VERSION}; compatible).`,
        type: "info",
    });
    assert.equal(notifications.at(-1)?.message.includes("Usage:"), false);
});

test("login accepts an explicitly configured HTTP server outside loopback without connecting", async (t) => {
    const url = "http://192.168.1.10:8080";
    const {command, ctx, store, checks} = harness(t, [url, CONFIG.apiKey]);
    await command.handler("login", ctx);
    assert.deepEqual(store.load(), {...CONFIG, url});
    assert.deepEqual(checks, []);
});

test("checked status reports incompatible versions and failures without changing the config", async (t) => {
    const cases: Array<{status: ServerStatus; message: string; type: string}> = [
        {status: {kind: "incompatible", version: OTHER_VERSION}, message: `Incompatible: server ${OTHER_VERSION}; required ${SERVER_VERSION_REQUIREMENT}.`, type: "warning"},
        {status: {kind: "failure", message: "Authentication rejected (HTTP 401)."}, message: "Authentication rejected (HTTP 401).", type: "error"},
        {status: {kind: "failure", message: "Server connection failed."}, message: "Server connection failed.", type: "error"},
    ];
    for (const entry of cases) {
        const {command, ctx, store, notifications} = harness(t, [], true, async () => entry.status);
        store.save(CONFIG);
        const before = readFileSync(store.file);
        await command.handler("", ctx);
        assert.deepEqual(notifications, [{
            message: `${JSON.stringify(CONFIG, null, 2)}\n\nStatus: ${entry.message}`,
            type: entry.type,
        }]);
        assert.deepEqual(readFileSync(store.file), before);
    }
});

test("login can atomically replace an existing configuration", async (t) => {
    const {command, ctx, store} = harness(t, [CONFIG.url, CONFIG.apiKey]);
    store.save({url: "https://previous.example.com", apiKey: "previous-key"});
    await command.handler("login", ctx);
    assert.deepEqual(store.load(), CONFIG);
});

test("canceling either login input preserves the previous file byte for byte", async (t) => {
    for (const answers of [[undefined], [CONFIG.url, undefined]]) {
        const {command, ctx, store, notifications} = harness(t, answers);
        store.save(CONFIG);
        const before = readFileSync(store.file);
        await command.handler("login", ctx);
        assert.deepEqual(readFileSync(store.file), before);
        assert.deepEqual(notifications, []);
    }
});

test("canceling first-time login does not create a config", async (t) => {
    const {command, ctx, directory} = harness(t, [CONFIG.url, undefined]);
    await command.handler("login", ctx);
    assert.deepEqual(readdirSync(directory), []);
});

test("invalid login input leaves existing credentials untouched and is not reflected", async (t) => {
    for (const answers of [[CONFIG.url, ""], ["not-a-url", CONFIG.apiKey], ["https://user:private-command-test-key@sessions.example.com", CONFIG.apiKey]]) {
        const {command, ctx, store, notifications} = harness(t, answers);
        store.save(CONFIG);
        await command.handler("login", ctx);
        assert.deepEqual(store.load(), CONFIG);
        assert.equal(notifications.at(-1)?.type, "error");
        assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
    }
});

test("logout deletes only connection configuration, without connecting to a server", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
        throw new Error("Commands must not perform network requests");
    });
    const {command, ctx, store, directory, notifications, checks} = harness(t, [CONFIG.url, CONFIG.apiKey]);
    const session = path.join(directory, "session.jsonl");
    writeFileSync(session, "synthetic session");
    await command.handler("login", ctx);
    await command.handler("logout", ctx);
    await command.handler("logout", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /has not been revoked/);
    await command.handler("", ctx);
    assert.deepEqual(checks, []);
    assert.equal(existsSync(store.file), false);
    assert.equal(readFileSync(session, "utf8"), "synthetic session");
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
});

test("malformed credential JSON is not leaked and can still be logged out", async (t) => {
    const {command, ctx, store, notifications} = harness(t);
    writeFileSync(store.file, CONFIG.apiKey, {mode: 0o600});
    await command.handler("", ctx);
    assert.equal(notifications.at(-1)?.type, "error");
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
    await command.handler("logout", ctx);
    assert.equal(existsSync(store.file), false);
});

test("login refuses unsupported UI modes without creating a config", async (t) => {
    const {command, ctx, directory, prompts, notifications} = harness(t, [CONFIG.url, CONFIG.apiKey], false);
    await command.handler("login", ctx);
    assert.deepEqual(prompts, []);
    assert.deepEqual(readdirSync(directory), []);
    assert.equal(notifications.at(-1)?.type, "error");
});

test("unexpected input errors do not expose their messages", async (t) => {
    const {command, ctx, directory, notifications} = harness(t);
    ctx.ui.input = async () => { throw new Error(CONFIG.apiKey); };
    await command.handler("login", ctx);
    assert.deepEqual(readdirSync(directory), []);
    assert.deepEqual(notifications, [{message: "Server configuration operation failed.", type: "error"}]);
});

test("manual upload scopes are offered; update and credential arguments are not implemented", async (t) => {
    const {command, ctx, directory, notifications, prompts} = harness(t);
    assert.ok(command.getArgumentCompletions);
    assert.deepEqual(await command.getArgumentCompletions(""), [
        {value: "login", label: "login"}, {value: "logout", label: "logout"}, {value: "upload", label: "upload"},
    ]);
    assert.deepEqual(await command.getArgumentCompletions(" LOGI"), [{value: "login", label: "login"}]);
    assert.deepEqual(await command.getArgumentCompletions("login "), []);
    assert.deepEqual(await command.getArgumentCompletions("upload "), [
        {value: "upload current", label: "upload current"}, {value: "upload all", label: "upload all"},
    ]);
    assert.deepEqual(await command.getArgumentCompletions("upload a"), [{value: "upload all", label: "upload all"}]);
    assert.equal(await command.getArgumentCompletions("update"), null);
    for (const input of ["update", "login https://sessions.example.com", `login ${CONFIG.apiKey}`, "logout extra", "upload elsewhere", "upload all extra"]) {
        await command.handler(input, ctx);
        assert.deepEqual(notifications.at(-1), {message: "Usage: /server [login|logout|upload [current|all]]", type: "error"});
    }
    assert.deepEqual(prompts, []);
    assert.deepEqual(readdirSync(directory), []);
});

test("logout cancels an outstanding status check and suppresses its stale config", async (t) => {
    let finish!: (status: ServerStatus) => void;
    const {command, ctx, store, notifications, checks} = harness(t, [], true,
        () => new Promise((resolve) => { finish = resolve; }));
    store.save(CONFIG);
    const pending = command.handler("", ctx);
    assert.equal(checks.length, 1);
    await command.handler("logout", ctx);
    assert.equal(checks[0]?.signal?.aborted, true);
    finish({kind: "compatible", version: SERVER_VERSION});
    await pending;
    assert.equal(notifications.length, 1);
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
    assert.equal(existsSync(store.file), false);
});

test("a newer status check supersedes an older response", async (t) => {
    let finish!: (status: ServerStatus) => void;
    let calls = 0;
    const {command, ctx, store, notifications, checks} = harness(t, [], true, () => {
        calls++;
        return calls === 1
            ? new Promise((resolve) => { finish = resolve; })
            : Promise.resolve({kind: "compatible", version: SERVER_VERSION});
    });
    store.save(CONFIG);
    const older = command.handler("", ctx);
    await command.handler("", ctx);
    finish({kind: "incompatible", version: OTHER_VERSION});
    await older;
    assert.equal(checks[0]?.signal?.aborted, true);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.message ?? "", /Status: Connected/);
});

test("upload defaults to current family and all is an explicit backfill", async (t) => {
    const calls: Array<{scope: string; config: ServerConfig; ctx: ExtensionCommandContext; signal?: AbortSignal}> = [];
    const {command, ctx, store, checks, notifications} = harness(t, [], true, undefined,
        async (config, context, scope, signal) => {
            calls.push({scope, config, ctx: context, signal});
            return {...REPORT, failed: 1, failures: [{file: "session.jsonl", message: "Safe conflict"}], warnings: ["Legacy child kind unknown"]};
        });
    store.save(CONFIG);
    for (const input of ["upload", "upload current", " UPLOAD ALL "]) await command.handler(input, ctx);
    assert.deepEqual(calls.map((call) => call.scope), ["current", "current", "all"]);
    assert.ok(calls.every((call) => call.ctx === ctx && call.config.apiKey === CONFIG.apiKey && !call.signal?.aborted));
    assert.deepEqual(checks, []);
    assert.equal(notifications.length, 3);
    assert.match(notifications[0]!.message, /2 uploaded, 1 unchanged, 1 failed/);
    assert.match(notifications[0]!.message, /Legacy child kind unknown/);
    assert.match(notifications[0]!.message, /Failed: session\.jsonl: Safe conflict/);
    assert.equal(notifications[0]!.type, "warning");
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
});

test("upload shows bounded failure paths and reasons with credentials and terminal controls removed", async (t) => {
    const {command, ctx, store, notifications} = harness(t, [], true, undefined, async () => ({
        ...REPORT,
        failed: 25,
        warnings: [`Warning contains ${CONFIG.apiKey}\u001b[31m\ncontrol`],
        failures: Array.from({length: 25}, (_, index) => ({
            file: `/sessions/${CONFIG.apiKey}\u001b[31m\n${index}.jsonl`,
            message: `Restore or fork: ${CONFIG.apiKey}\u001b[0m\r\u0000${"x".repeat(2000)}`,
        })),
    }));
    store.save(CONFIG);
    await command.handler("upload", ctx);
    const output = notifications[0]!.message;
    assert.equal(output.includes(CONFIG.apiKey), false);
    assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    assert.doesNotMatch(output, /\[31m|\[0m/);
    assert.match(output, /Failed: \/sessions\/\[redacted\] 0\.jsonl: Restore or fork: \[redacted\]/);
    assert.match(output, /Warning: Warning contains \[redacted\] control/);
    const failures = output.split("\n").filter((line) => line.startsWith("Failed: "));
    assert.equal(failures.length, 20);
    assert.ok(failures.every((line) => line.length <= 7 + 512 + 2 + 1024));
    assert.ok(failures.every((line) => line.endsWith("…")));
});

test("upload requires configuration and archive exceptions are sanitized", async (t) => {
    let calls = 0;
    const {command, ctx, store, notifications} = harness(t, [], true, undefined, async () => {
        calls++;
        throw new Error(CONFIG.apiKey);
    });
    await command.handler("upload", ctx);
    assert.equal(calls, 0);
    assert.match(notifications.at(-1)!.message, /not configured/i);
    store.save(CONFIG);
    await command.handler("upload", ctx);
    assert.deepEqual(notifications.at(-1), {message: "Server archive operation failed.", type: "error"});
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
});

test("every new command and shutdown cancel uploads and suppress late results or errors", async (t) => {
    for (const next of ["", "login", "logout", "invalid", "shutdown"]) {
        for (const reject of [false, true]) {
            let finish!: () => void;
            let uploadSignal: AbortSignal | undefined;
            const {command, ctx, store, notifications, shutdown} = harness(t, [undefined], true, undefined,
                (_config, _ctx, _scope, signal) => {
                    uploadSignal = signal;
                    return new Promise((resolve, fail) => { finish = () => reject ? fail(new Error(CONFIG.apiKey)) : resolve(REPORT); });
                });
            store.save(CONFIG);
            const pending = command.handler("upload", ctx);
            if (next === "shutdown") shutdown();
            else await command.handler(next, ctx);
            assert.equal(uploadSignal?.aborted, true);
            const count = notifications.length;
            finish();
            await pending;
            assert.equal(notifications.length, count);
        }
    }
});

test("logout preserves archive journal and downloads", async (t) => {
    const {command, ctx, store, directory} = harness(t);
    store.save(CONFIG);
    const journal = path.join(directory, "archive.sqlite");
    const download = path.join(directory, "download.jsonl");
    writeFileSync(journal, "journal");
    writeFileSync(download, "download");
    await command.handler("logout", ctx);
    assert.equal(readFileSync(journal, "utf8"), "journal");
    assert.equal(readFileSync(download, "utf8"), "download");
});

test("a superseded login cannot save credentials after logout", async (t) => {
    const {command, ctx, store} = harness(t);
    let finish!: (value: string) => void;
    ctx.ui.input = () => new Promise((resolve) => { finish = resolve; });
    const pending = command.handler("login", ctx);
    await command.handler("logout", ctx);
    finish(CONFIG.url);
    await pending;
    assert.equal(store.load(), undefined);
});

test("server command rejects duplicate registration", (t) => {
    const {instance} = harness(t);
    assert.throws(() => instance.register(), /already registered/);
});
