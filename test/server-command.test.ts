import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {SessionManager, type ExtensionAPI, type ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {ServerService} from "../src/server/ServerService.js";
import {ServerConfigStore, type ServerConfig} from "../src/server/ServerConfig.js";
import {SERVER_VERSION_REQUIREMENT} from "../src/server/ServerCompatibility.js";
import type {ServerStatus} from "../src/server/ServerConnection.js";
import {ArchiveBackground, type ArchiveEnqueueResult} from "../src/server/ArchiveBackground.js";
import {ArchiveRuntime} from "../src/server/ArchiveRuntime.js";
import {ArchiveInbox} from "../src/server/ArchiveInbox.js";
import {ArchiveSessions} from "../src/server/ArchiveSessions.js";
import type {ConfigSyncResult} from "../src/server/config-sync/ConfigSyncService.js";

const CONFIG = {url: "https://sessions.example.com", apiKey: "private-command-test-key"};
const SERVER_VERSION = "1.2.3";
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type VersionCheck = NonNullable<ConstructorParameters<typeof ServerService>[1]>;

function harness(
    t: TestContext,
    answers: Array<string | undefined> = [],
    hasUI = true,
    checkVersion: VersionCheck = async () => ({kind: "compatible", version: SERVER_VERSION}),
) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-command-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const runtime = new ArchiveRuntime();
    t.mock.method(runtime, "initialize", async () => {});
    t.mock.method(runtime, "launch", async () => {});
    const background = new ArchiveBackground(store, {runtime});
    const wake = t.mock.method(background, "wake", async () => {});
    const initialize = t.mock.method(background, "initialize", async () => { await background.wake(); });
    const enqueue = t.mock.method(background, "enqueue", async (..._args: Parameters<ArchiveBackground["enqueue"]>): Promise<ArchiveEnqueueResult> => ({queued: true}));
    const commands = new Map<string, RegisteredCommand>();
    const hooks: string[] = [];
    const pi = {
        on(event: string) { hooks.push(event); },
        registerCommand(name: string, options: RegisteredCommand) { commands.set(name, options); },
    } as unknown as ExtensionAPI;
    const checks: Array<{config: ServerConfig; signal: AbortSignal | undefined}> = [];
    const server = new ServerService(store, (config, signal) => {
        checks.push({config: {...config}, signal});
        return checkVersion(config, signal);
    }, background);
    const instance = new ServerCommand(pi, server);
    instance.register();
    assert.deepEqual(hooks, [], "commands do not own lifecycle hooks");
    const command = commands.get("server")!;
    const prompts: Array<{title: string; placeholder?: string}> = [];
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        hasUI,
        sessionManager: SessionManager.inMemory(directory),
        ui: {
            async input(title: string, placeholder?: string) {
                prompts.push({title, placeholder});
                return answers.shift();
            },
            notify(message: string, type = "info") { notifications.push({message, type}); },
        },
    } as unknown as ExtensionCommandContext;
    return {directory, store, runtime, background, initialize, wake, enqueue, server, instance, command, prompts, notifications, checks, ctx,
        persisted() { ctx.sessionManager = SessionManager.create(directory, path.join(directory, "sessions")); }};
}

test("configuration sync commands use their foreground service, offer explicit opt-in, and redact failures", async (t) => {
    const h = harness(t);
    const result: ConfigSyncResult = {kind: "complete", items: [{key: "web-search", status: "unchanged"}]};
    const sync = t.mock.method(h.server.configuration, "synchronize", async () => result);
    const enable = t.mock.method(h.server.configuration, "enableAutomatic", async () => result);
    const disable = t.mock.method(h.server.configuration, "disableAutomatic", () => {});
    const recover = t.mock.method(h.server.configuration, "recover", async () => result);
    await h.command.handler("sync", h.ctx);
    assert.equal(sync.mock.callCount(), 1);
    assert.match(h.notifications.at(-1)!.message, /web-search: unchanged/);
    await h.command.handler(" SYNC ON ", h.ctx);
    assert.equal(enable.mock.callCount(), 1);
    assert.match(h.notifications.at(-1)!.message, /includes saved web-search credentials/);
    await h.command.handler("sync off", h.ctx);
    assert.equal(disable.mock.callCount(), 1);
    assert.match(h.notifications.at(-1)!.message, /disabled on this computer/);
    await h.command.handler("sync recover display-defaults server", h.ctx);
    assert.equal(recover.mock.callCount(), 1);
    assert.equal(recover.mock.calls[0]!.arguments[0], "display-defaults");
    assert.equal(recover.mock.calls[0]!.arguments[1], "server");
    assert.equal(h.checks.length, 0);
    assert.equal(h.enqueue.mock.callCount(), 0);
    assert.deepEqual(await h.command.getArgumentCompletions!("sync "), [
        {value: "sync on", label: "sync on"}, {value: "sync off", label: "sync off"}, {value: "sync recover", label: "sync recover"},
    ]);
    assert.deepEqual(await h.command.getArgumentCompletions!("sync recover d"), [
        {value: "sync recover display-defaults local", label: "sync recover display-defaults local"},
        {value: "sync recover display-defaults server", label: "sync recover display-defaults server"},
    ]);
    t.mock.method(h.server.configuration, "synchronize", async () => { throw new Error(CONFIG.apiKey); });
    await h.command.handler("sync", h.ctx);
    assert.equal(h.notifications.at(-1)!.type, "error");
    assert.equal(JSON.stringify(h.notifications).includes(CONFIG.apiKey), false);
});

test("logout cancels an outstanding configuration sync and suppresses its late result", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    let finish!: (result: ConfigSyncResult) => void;
    let signal: AbortSignal | undefined;
    t.mock.method(h.server.configuration, "synchronize", (requestSignal?: AbortSignal) => {
        signal = requestSignal;
        return new Promise<ConfigSyncResult>((resolve) => { finish = resolve; });
    });
    const pending = h.command.handler("sync", h.ctx);
    await h.command.handler("logout", h.ctx);
    assert.equal(signal!.aborted, true);
    const count = h.notifications.length;
    finish({kind: "complete", items: [{key: "display-defaults", status: "applied", outcome: "server_won"}]});
    await pending;
    assert.equal(h.notifications.length, count);
});

test("bare server with no config makes no request, queue, or startup probe", async (t) => {
    const h = harness(t);
    await h.command.handler("", h.ctx);
    assert.deepEqual(h.notifications, [{message: "Config: none\nStatus: Not configured.", type: "info"}]);
    assert.deepEqual(h.checks, []);
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(readdirSync(h.directory), []);
    assert.equal(h.initialize.mock.callCount(), 0);
    assert.equal(h.enqueue.mock.callCount(), 0);
});

test("login saves credentials before background initialization/wake; status intentionally displays the key", async (t) => {
    const h = harness(t, [CONFIG.url, CONFIG.apiKey]);
    t.mock.method(h.background, "initialize", async () => {
        assert.deepEqual(h.store.load(), CONFIG);
        await h.background.wake();
    });
    await h.command.handler(" LOGIN ", h.ctx);
    assert.deepEqual(h.prompts, [
        {title: "pi.server URL", placeholder: "https://sessions.example.com"},
        {title: "pi.server API key", placeholder: undefined},
    ]);
    assert.deepEqual(h.store.load(), CONFIG);
    assert.ok(h.store.connection()?.generation);
    assert.equal(h.wake.mock.callCount(), 1);
    assert.equal(h.enqueue.mock.callCount(), 0, "login does not backfill history");
    assert.equal(h.checks.length, 0);
    assert.equal(JSON.stringify(h.notifications).includes(CONFIG.apiKey), false);
    assert.match(h.notifications[0]!.message, /queued automatically/);
    await h.command.handler("", h.ctx);
    assert.deepEqual(h.checks.map((check) => check.config), [CONFIG]);
    assert.deepEqual(h.notifications.at(-1), {
        message: `${JSON.stringify(CONFIG, null, 2)}\n\nStatus: Connected (pi.server ${SERVER_VERSION}; compatible).`, type: "info",
    });
});

test("configured HTTP origins are accepted locally and login atomically replaces previous config", async (t) => {
    const url = "http://192.168.1.10:8080";
    const h = harness(t, [url, CONFIG.apiKey]);
    h.store.save({url: "https://previous.example.com", apiKey: "old-key"});
    const previous = h.store.connection()!.generation;
    await h.command.handler("login", h.ctx);
    assert.deepEqual(h.store.load(), {...CONFIG, url});
    assert.notEqual(h.store.connection()!.generation, previous);
    assert.deepEqual(h.checks, []);
});

test("status retains incompatible and failure presentation without changing stored config", async (t) => {
    for (const entry of [
        {status: {kind: "incompatible", version: "9.8.7"}, message: `Incompatible: server 9.8.7; required ${SERVER_VERSION_REQUIREMENT}.`, type: "error"},
        {status: {kind: "failure", message: "Authentication rejected (HTTP 401)."}, message: "Authentication rejected (HTTP 401).", type: "error"},
        {status: {kind: "failure", message: "Server connection failed."}, message: "Server connection failed.", type: "error"},
    ] satisfies Array<{status: ServerStatus; message: string; type: string}>) {
        const h = harness(t, [], true, async () => entry.status);
        h.store.save(CONFIG);
        const before = readFileSync(h.store.file);
        await h.command.handler("", h.ctx);
        assert.deepEqual(h.notifications, [{message: `${JSON.stringify(CONFIG, null, 2)}\n\nStatus: ${entry.message}`, type: entry.type}]);
        assert.deepEqual(readFileSync(h.store.file), before);
    }
});

test("an incompatible connection can still be inspected, replaced and removed", async (t) => {
    const h = harness(t, ["https://replacement.example.test", "replacement-key"], true,
        async () => ({kind: "incompatible", version: "0.3.0"}));
    h.store.save(CONFIG);
    await h.command.handler("", h.ctx);
    assert.equal(h.notifications.at(-1)!.type, "error");
    await h.command.handler("login", h.ctx);
    assert.equal(h.store.load()!.url, "https://replacement.example.test");
    await h.command.handler("logout", h.ctx);
    assert.equal(h.store.load(), undefined);
    assert.equal(h.checks.length, 1, "connection repair does not require a compatible old connection");
});

test("cancelled or invalid login never changes previous credentials or starts background work", async (t) => {
    for (const answers of [[undefined], [CONFIG.url, undefined], [CONFIG.url, ""], ["not-a-url", CONFIG.apiKey],
        ["https://user:private-command-test-key@sessions.example.com", CONFIG.apiKey]]) {
        const h = harness(t, answers);
        h.store.save(CONFIG);
        const before = readFileSync(h.store.file);
        await h.command.handler("login", h.ctx);
        assert.deepEqual(readFileSync(h.store.file), before);
        assert.equal(h.initialize.mock.callCount(), 0);
        assert.equal(h.wake.mock.callCount(), 0);
        assert.equal(JSON.stringify(h.notifications).includes(CONFIG.apiKey), false);
    }
    const h = harness(t, [CONFIG.url, undefined]);
    await h.command.handler("login", h.ctx);
    assert.deepEqual(readdirSync(h.directory), []);
});

test("login rejects unavailable UI and redacts unexpected dialog failures", async (t) => {
    const h = harness(t, [CONFIG.url, CONFIG.apiKey], false);
    await h.command.handler("login", h.ctx);
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(readdirSync(h.directory), []);
    assert.equal(h.notifications[0]!.type, "error");
    const interactive = harness(t);
    interactive.ctx.ui.input = async () => { throw new Error(CONFIG.apiKey); };
    await interactive.command.handler("login", interactive.ctx);
    assert.deepEqual(interactive.notifications, [{message: "Server configuration operation failed.", type: "error"}]);
});

test("logout durably removes authorization before wake, without network or deleting archives", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    const inbox = new ArchiveInbox(h.store.archiveDirectory);
    const oldControl = inbox.control()!.token;
    for (const file of ["session.jsonl", "archive.sqlite", "download.jsonl"]) writeFileSync(path.join(h.directory, file), file);
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No command network"); });
    t.mock.method(h.background, "wake", async () => {
        assert.equal(h.store.connection(), undefined, "future worker auth is revoked before wake");
        assert.notEqual(inbox.control()!.token, oldControl);
    });
    await h.command.handler("logout", h.ctx);
    await h.command.handler("logout", h.ctx);
    for (const file of ["session.jsonl", "archive.sqlite", "download.jsonl"]) assert.equal(readFileSync(path.join(h.directory, file), "utf8"), file);
    assert.equal(existsSync(h.store.file), false);
    assert.match(h.notifications.at(-1)!.message, /has not been revoked/);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(h.checks, []);
});

test("malformed config is not leaked and can still be removed", async (t) => {
    const h = harness(t);
    writeFileSync(h.store.file, CONFIG.apiKey, {mode: 0o600});
    await h.command.handler("", h.ctx);
    assert.equal(h.notifications[0]!.type, "error");
    assert.equal(JSON.stringify(h.notifications).includes(CONFIG.apiKey), false);
    await h.command.handler("logout", h.ctx);
    assert.equal(h.store.load(), undefined);
});

for (const action of ["login", "logout"] as const) {
    for (const method of ["initialize", "wake"] as const) {
        test(`${action} committed configuration is not misreported as failed when background ${method} fails`, async (t) => {
            const h = harness(t, [CONFIG.url, CONFIG.apiKey]);
            if (action === "logout") h.store.save(CONFIG);
            t.mock.method(h.background, method, async () => { throw new Error(`${CONFIG.apiKey}\u001b[31m`); });
            await h.command.handler(action, h.ctx);
            assert.deepEqual(h.store.load(), action === "login" ? CONFIG : undefined);
            assert.deepEqual(h.notifications.map((notice) => notice.type), ["info", "warning"]);
            assert.match(h.notifications[1]!.message, /configuration changed/);
            assert.doesNotMatch(JSON.stringify(h.notifications), /operation failed|private-command-test-key|31m/);
        });
    }
}

test("manual upload enqueues current by default and all only explicitly, without validation or foreground archive work", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    h.persisted();
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No HTTP"); });
    const discoverPage = t.mock.method(ArchiveSessions.prototype, "discoverPage", async () => { throw new Error("No scan"); });
    const captureSource = t.mock.method(ArchiveSessions.prototype, "captureSource", async () => { throw new Error("No hash/copy"); });
    for (const input of ["upload", "upload current", " UPLOAD ALL "]) await h.command.handler(input, h.ctx);
    assert.deepEqual(h.enqueue.mock.calls.map((call) => call.arguments[0].scope), ["current", "current", "all"]);
    for (const call of h.enqueue.mock.calls) {
        assert.equal(call.arguments.length, 1, "no cancellation signal belongs to background work");
        assert.equal(call.arguments[0].sessionFile, h.ctx.sessionManager.getSessionFile());
        assert.equal(call.arguments[0].activeSession.sessionId, h.ctx.sessionManager.getSessionId());
    }
    assert.equal(h.notifications.length, 3);
    for (const notice of h.notifications) {
        assert.match(notice.message, /queued for background upload/);
        assert.doesNotMatch(notice.message, /uploaded|unchanged|failed/);
        assert.equal(notice.type, "info");
    }
    for (const method of [fetch, discoverPage, captureSource, h.initialize]) assert.equal(method.mock.callCount(), 0);
    assert.deepEqual(h.checks, []);
});

test("manual all permits ephemeral context; current explains that it was not queued", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    await h.command.handler("upload current", h.ctx);
    assert.equal(h.enqueue.mock.callCount(), 0);
    assert.match(h.notifications[0]!.message, /ephemeral and was not queued/);
    await h.command.handler("upload all", h.ctx);
    assert.equal(h.enqueue.mock.callCount(), 1);
    assert.equal(h.enqueue.mock.calls[0]!.arguments[0].sessionFile, undefined);
    assert.equal(h.enqueue.mock.calls[0]!.arguments[0].scope, "all");
});

test("enqueue requires configuration and failures produce fixed bounded warnings without exception data", async (t) => {
    const h = harness(t);
    await h.command.handler("upload all", h.ctx);
    assert.equal(h.enqueue.mock.callCount(), 0);
    assert.match(h.notifications[0]!.message, /not configured/);
    h.store.save(CONFIG);
    t.mock.method(h.background, "enqueue", async () => { throw new Error(`${CONFIG.apiKey}\u001b[31m${"x".repeat(10000)}`); });
    await h.command.handler("upload all", h.ctx);
    assert.deepEqual(h.notifications.at(-1), {message: "Server archive work could not be queued. Local session files are unchanged.", type: "error"});
});

test("durable admission followed by launch failure reports queued and retains the manifest", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    h.enqueue.mock.restore();
    // Deliberately unavailable runtime: enqueue must not initialize it on the manual path.
    await h.command.handler("upload all", h.ctx);
    const inbox = new ArchiveInbox(h.background.directory);
    assert.equal(inbox.ids().length, 1);
    assert.equal(inbox.readManifest(inbox.ids()[0]!)!.source.scope, "all");
    assert.match(h.notifications[0]!.message, /is queued, but/);
    assert.doesNotMatch(h.notifications[0]!.message, /could not be queued/);
    assert.equal(h.notifications[0]!.type, "warning");
    assert.equal(h.initialize.mock.callCount(), 0);
});

test("committed manual work survives request shutdown and logout while its local launcher is still pending", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    h.enqueue.mock.restore();
    h.initialize.mock.restore();
    h.wake.mock.restore();
    await h.background.initialize();
    let finishLaunch!: () => void;
    t.mock.method(h.runtime, "launch", (...args: Parameters<ArchiveRuntime["launch"]>) => {
        assert.equal(args.length, 2, "the launcher receives archive/config roots, not request cancellation");
        return new Promise<void>((resolve) => { finishLaunch = resolve; });
    });
    const pending = h.command.handler("upload all", h.ctx);
    const inbox = new ArchiveInbox(h.background.directory);
    const ids = inbox.ids();
    assert.equal(ids.length, 1, "admission commits before waiting for launch outcome");
    const original = inbox.readManifest(ids[0]!);
    h.server.beginShutdown();
    h.store.logout();
    assert.equal(h.store.connection(), undefined);
    assert.deepEqual(inbox.readManifest(ids[0]!), original, "logout pauses authorization without deleting committed work");
    finishLaunch();
    await pending;
    assert.deepEqual(h.notifications, [], "cancelled command cannot publish a stale queued result");
    assert.deepEqual(inbox.ids(), ids);
});

test("queue warning text is never reflected, even when it contains credentials or terminal control sequences", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    t.mock.method(h.background, "enqueue", async () => ({queued: true as const, warning: `${CONFIG.apiKey}\u001b[31m${"x".repeat(10000)}`}));
    await h.command.handler("upload all", h.ctx);
    assert.match(h.notifications[0]!.message, /is queued, but/);
    assert.ok(h.notifications[0]!.message.length < 250);
    assert.doesNotMatch(JSON.stringify(h.notifications), /private-command-test-key|31m/);
});

test("superseding commands and shutdown suppress late queue results/errors without cancelling owned work", async (t) => {
    for (const next of ["", "login", "logout", "invalid", "shutdown"]) {
        for (const fail of [false, true]) {
            const h = harness(t, [undefined]);
            h.store.save(CONFIG);
            let finish!: () => void;
            let completed = false;
            t.mock.method(h.background, "enqueue", (...args: Parameters<ArchiveBackground["enqueue"]>) => {
                assert.equal(args.length, 1);
                return new Promise<ArchiveEnqueueResult>((resolve, reject) => {
                    finish = () => {
                        completed = true;
                        if (fail) reject(new Error(CONFIG.apiKey));
                        else resolve({queued: true});
                    };
                });
            });
            const pending = h.command.handler("upload all", h.ctx);
            if (next === "shutdown") h.server.beginShutdown();
            else await h.command.handler(next, h.ctx);
            const count = h.notifications.length;
            finish();
            await pending;
            assert.equal(completed, true);
            assert.equal(h.notifications.length, count);
        }
    }
});

test("logout suppresses an outstanding status result and invalidates credentials before it completes", async (t) => {
    let finish!: (status: ServerStatus) => void;
    const h = harness(t, [], true, () => new Promise((resolve) => { finish = resolve; }));
    h.store.save(CONFIG);
    const pending = h.command.handler("", h.ctx);
    await h.command.handler("logout", h.ctx);
    assert.equal(h.checks[0]!.signal!.aborted, true);
    assert.equal(h.store.connection(), undefined);
    finish({kind: "compatible", version: SERVER_VERSION});
    await pending;
    assert.equal(h.notifications.length, 1);
    assert.equal(JSON.stringify(h.notifications).includes(CONFIG.apiKey), false);
});

test("superseded login cannot save credentials after logout or publish a stale wake failure", async (t) => {
    const h = harness(t);
    let finish!: (value: string) => void;
    h.ctx.ui.input = () => new Promise((resolve) => { finish = resolve; });
    const pending = h.command.handler("login", h.ctx);
    await h.command.handler("logout", h.ctx);
    finish(CONFIG.url);
    await pending;
    assert.equal(h.store.load(), undefined);
    assert.equal(h.notifications.length, 1);

    const second = harness(t, [CONFIG.url, CONFIG.apiKey]);
    let rejectWake!: () => void;
    let initialized!: () => void;
    const ready = new Promise<void>((resolve) => { initialized = resolve; });
    t.mock.method(second.background, "initialize", () => new Promise<void>((_resolve, reject) => {
        initialized();
        rejectWake = () => reject(new Error(CONFIG.apiKey));
    }));
    const login = second.command.handler("login", second.ctx);
    await ready;
    await second.command.handler("invalid", second.ctx);
    const count = second.notifications.length;
    rejectWake();
    await login;
    assert.equal(second.notifications.length, count);
    assert.deepEqual(second.store.load(), CONFIG);
});

test("manual scopes are offered and unsupported credential arguments are not reflected", async (t) => {
    const h = harness(t);
    assert.deepEqual(await h.command.getArgumentCompletions!(""), [
        {value: "login", label: "login"}, {value: "logout", label: "logout"}, {value: "upload", label: "upload"}, {value: "sync", label: "sync"},
    ]);
    assert.deepEqual(await h.command.getArgumentCompletions!("upload "), [
        {value: "upload current", label: "upload current"}, {value: "upload all", label: "upload all"},
    ]);
    assert.deepEqual(await h.command.getArgumentCompletions!("upload a"), [{value: "upload all", label: "upload all"}]);
    assert.equal(await h.command.getArgumentCompletions!("update"), null);
    for (const input of ["update", `login ${CONFIG.apiKey}`, "logout extra", "upload elsewhere", "upload all extra",
        "sync recover global-policies server", "sync recover web-search unknown", `sync recover display-defaults local ${CONFIG.apiKey}`]) {
        await h.command.handler(input, h.ctx);
        assert.deepEqual(h.notifications.at(-1), {message: "Usage: /server [login|logout|upload [current|all]|sync [on|off|recover <json-key> <local|server>]]", type: "error"});
    }
    assert.deepEqual(readdirSync(h.directory), []);
    assert.throws(() => h.instance.register(), /already registered/);
});
