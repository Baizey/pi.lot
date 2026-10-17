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

function harness(
    t: TestContext,
    answers: Array<string | undefined> = [],
    hasUI = true,
    checkVersion: VersionCheck = async () => ({kind: "compatible", version: SERVER_VERSION}),
) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-command-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
        registerCommand(name: string, options: RegisteredCommand) {
            commands.set(name, options);
        },
    } as ExtensionAPI;
    const checks: Array<{config: ServerConfig; signal: AbortSignal | undefined}> = [];
    const instance = new ServerCommand(pi, store, (config, signal) => {
        checks.push({config: {...config}, signal});
        return checkVersion(config, signal);
    });
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
    return {directory, store, instance, command, prompts, notifications, checks, ctx};
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

test("only login and logout are offered; update and credential arguments are not implemented", async (t) => {
    const {command, ctx, directory, notifications, prompts} = harness(t);
    assert.ok(command.getArgumentCompletions);
    assert.deepEqual(await command.getArgumentCompletions(""), [
        {value: "login", label: "login"}, {value: "logout", label: "logout"},
    ]);
    assert.deepEqual(await command.getArgumentCompletions(" LOGI"), [{value: "login", label: "login"}]);
    assert.deepEqual(await command.getArgumentCompletions("login "), []);
    assert.equal(await command.getArgumentCompletions("update"), null);
    for (const input of ["update", "login https://sessions.example.com", `login ${CONFIG.apiKey}`, "logout extra"]) {
        await command.handler(input, ctx);
        assert.deepEqual(notifications.at(-1), {message: "Usage: /server [login|logout]", type: "error"});
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

test("server command rejects duplicate registration", (t) => {
    const {instance} = harness(t);
    assert.throws(() => instance.register(), /already registered/);
});
