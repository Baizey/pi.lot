import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {ServerConfigStore, type ServerConfig} from "../src/server/ServerConfig.js";
import {ServerService} from "../src/server/ServerService.js";
import {ServerSessionLifecycle, SHUTDOWN_UPLOAD_TIMEOUT_MS} from "../src/server/ServerSessionLifecycle.js";
import {ArchiveClientError} from "../src/server/ArchiveClient.js";

const CONFIG = {url: "https://sessions.example.com", apiKey: "private-lifecycle-test-key"};
const REPORT = {uploaded: 2, unchanged: 1, failed: 0, warnings: [], failures: []};
type UploadArchive = NonNullable<ConstructorParameters<typeof ServerService>[2]>;
type ShutdownHandler = (event: {type: "session_shutdown"; reason: "quit"}, ctx: ExtensionContext) => void | Promise<void>;

function harness(
    t: TestContext,
    uploadArchive: UploadArchive = async () => REPORT,
    awaitLocalShutdown: () => Promise<void> = async () => {},
) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-lifecycle-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const handlers: ShutdownHandler[] = [];
    let startHandler: (() => void) | undefined;
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    const pi = {
        on(event: string, handler: ShutdownHandler | (() => void)) {
            if (event === "session_start") {
                startHandler = handler as () => void;
                return;
            }
            assert.equal(event, "session_shutdown");
            handlers.push(handler);
        },
        registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
            commands.set(name, command);
        },
    } as ExtensionAPI;
    const check = t.mock.fn(async () => { throw new Error("Lifecycle must not check server status"); });
    const server = new ServerService(store, check, uploadArchive);
    const lifecycle = new ServerSessionLifecycle(pi, server, awaitLocalShutdown);
    lifecycle.registerPreparation();
    lifecycle.register();
    assert.equal(handlers.length, 2);
    assert.ok(startHandler);
    assert.equal(commands.size, 0, "lifecycle is independent of command registration");
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        hasUI: false,
        sessionManager: {getSessionFile: () => path.join(directory, "outgoing.jsonl")},
        ui: {notify(message: string, type = "info") { notifications.push({message, type}); }},
    } as ExtensionCommandContext;
    const event = {type: "session_shutdown", reason: "quit"} as const;
    return {
        pi, commands, store, server, lifecycle, ctx, notifications, check,
        start: () => startHandler!(),
        prepare: () => handlers[0]!(event, ctx),
        shutdown: () => handlers[1]!(event, ctx),
    };
}

test("independent shutdown hook uploads the configured current family exactly once without a startup request", async (t) => {
    const calls: Array<{config: ServerConfig; manager: ExtensionContext["sessionManager"]; scope: string}> = [];
    const {shutdown, ctx, store, notifications, check} = harness(t, async (config, manager, scope, signal) => {
        assert.equal(signal?.aborted, false);
        calls.push({config, manager, scope});
        return REPORT;
    });
    store.save(CONFIG);
    assert.deepEqual(calls, []);
    const ending = shutdown();
    assert.equal(shutdown(), ending);
    await ending;
    await shutdown();
    assert.deepEqual(calls, [{config: CONFIG, manager: ctx.sessionManager, scope: "current"}]);
    assert.equal(check.mock.callCount(), 0);
    assert.deepEqual(notifications, [{
        message: "Automatic archive upload (current): 2 uploaded, 1 unchanged, 0 failed.", type: "info",
    }]);
});

test("shutdown quietly skips unconfigured, logged-out, and ephemeral sessions", async (t) => {
    for (const kind of ["unconfigured", "logged-out", "ephemeral"]) {
        const upload = t.mock.fn(async () => REPORT);
        const {shutdown, ctx, store, notifications, check} = harness(t, upload);
        if (kind !== "unconfigured") store.save(CONFIG);
        if (kind === "logged-out") store.logout();
        if (kind === "ephemeral") {
            ctx.sessionManager = {getSessionFile: () => undefined} as ExtensionContext["sessionManager"];
            t.mock.method(store, "load", () => { throw new Error("Ephemeral shutdown must not load configuration"); });
        }
        await shutdown();
        assert.equal(upload.mock.callCount(), 0);
        assert.deepEqual(notifications, []);
        assert.equal(check.mock.callCount(), 0);
    }
});

test("early preparation cancels shared requests before teardown and late upload waits for the local barrier", async (t) => {
    const events: string[] = [];
    let finishTeardown!: () => void;
    const barrier = new Promise<void>((resolve) => { finishTeardown = resolve; });
    const {prepare, shutdown, server, store} = harness(t, async () => {
        events.push("upload");
        return REPORT;
    }, async () => {
        events.push("waiting for teardown");
        await barrier;
    });
    store.save(CONFIG);
    const request = server.beginRequest();
    assert.ok(request);
    request.signal.addEventListener("abort", () => { events.push("cancelled"); });
    prepare();
    assert.equal(request.signal.aborted, true);
    assert.equal(server.beginRequest(), undefined);
    events.push("teardown started");
    const ending = shutdown();
    await Promise.resolve();
    assert.deepEqual(events, ["cancelled", "teardown started", "waiting for teardown"]);
    events.push("teardown finished");
    finishTeardown();
    await ending;
    assert.deepEqual(events, ["cancelled", "teardown started", "waiting for teardown", "teardown finished", "upload"]);
});

test("failed local shutdown barrier skips automatic upload even when late listener is dispatched", async (t) => {
    const upload = t.mock.fn(async () => REPORT);
    const {shutdown, store, notifications} = harness(t, upload, async () => { throw new Error(CONFIG.apiKey); });
    store.save(CONFIG);
    const load = t.mock.method(store, "load", () => { throw new Error("Must not load configuration after failed teardown"); });
    await shutdown();
    await shutdown();
    assert.equal(upload.mock.callCount(), 0);
    assert.equal(load.mock.callCount(), 0);
    assert.deepEqual(notifications, [{
        message: "Automatic archive upload skipped because local session shutdown failed.", type: "warning",
    }]);
});

test("shutdown drains even superseded manual uploads through the shared service before automatic upload", async (t) => {
    const finishes: Array<() => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    const {pi, commands, prepare, shutdown, server, ctx, store, notifications} = harness(t,
        (_config, _manager, scope, signal) => {
            signals.push(signal);
            if (signals.length > 2) {
                assert.equal(scope, "current");
                return Promise.resolve(REPORT);
            }
            return new Promise((resolve) => { finishes.push(() => resolve(REPORT)); });
        });
    new ServerCommand(pi, server).register();
    const command = commands.get("server")!;
    store.save(CONFIG);
    const first = command.handler("upload all", ctx);
    const second = command.handler("upload", ctx);
    assert.equal(signals[0]?.aborted, true, "new commands supersede prior uploads");
    assert.equal(signals[1]?.aborted, false);
    prepare();
    const ending = shutdown();
    assert.ok(signals.every((signal) => signal?.aborted));
    await command.handler("logout", ctx);
    assert.deepEqual(store.load(), CONFIG, "new commands cannot change configuration during shutdown");
    finishes[1]!();
    await second;
    assert.equal(signals.length, 2, "superseded upload still owns its journal");
    finishes[0]!();
    await first;
    await ending;
    assert.equal(signals.length, 3);
    assert.equal(notifications.length, 1, "cancelled manual results remain suppressed");
    assert.match(notifications[0]!.message, /^Automatic archive upload/);
});

for (const lateFailure of [false, true]) {
    test(`shutdown deadline aborts upload and suppresses late ${lateFailure ? "errors" : "results"}`, async (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        let finish!: () => void;
        let uploadSignal: AbortSignal | undefined;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => { started = resolve; });
        const {shutdown, server, store, notifications} = harness(t, (_config, _manager, _scope, signal) => {
            uploadSignal = signal;
            started();
            return new Promise((resolve, reject) => {
                finish = () => lateFailure ? reject(new Error(CONFIG.apiKey)) : resolve(REPORT);
            });
        });
        store.save(CONFIG);
        const ending = shutdown();
        await ready;
        assert.equal(SHUTDOWN_UPLOAD_TIMEOUT_MS, 10_000);
        t.mock.timers.tick(SHUTDOWN_UPLOAD_TIMEOUT_MS - 1);
        assert.equal(uploadSignal?.aborted, false);
        assert.equal(notifications.length, 0);
        t.mock.timers.tick(1);
        await ending;
        assert.equal(uploadSignal?.aborted, true);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]!.type, "warning");
        assert.match(notifications[0]!.message, /timed out after 10 seconds/);
        finish();
        await server.drainUploads();
        await shutdown();
        assert.equal(notifications.length, 1);
        assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
    });
}

test("shutdown deadline bounds manual draining without starting an overlapping upload later", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let finish!: () => void;
    const upload = t.mock.fn(() => new Promise<typeof REPORT>((resolve) => { finish = () => resolve(REPORT); }));
    const {shutdown, server, ctx, store, notifications} = harness(t, upload);
    store.save(CONFIG);
    const manual = server.upload(CONFIG, ctx.sessionManager, "all");
    const ending = shutdown();
    await Promise.resolve();
    t.mock.timers.tick(SHUTDOWN_UPLOAD_TIMEOUT_MS);
    await ending;
    assert.equal(upload.mock.callCount(), 1);
    finish();
    await manual;
    await server.drainUploads();
    await Promise.resolve();
    assert.equal(upload.mock.callCount(), 1);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!.message, /timed out/);
});

test("one deadline covers both draining prior uploads and the automatic upload", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let finishManual!: () => void;
    let autoStarted!: () => void;
    const ready = new Promise<void>((resolve) => { autoStarted = resolve; });
    let autoSignal: AbortSignal | undefined;
    let finishAuto!: () => void;
    const {shutdown, server, store, ctx, notifications} = harness(t, (_config, _manager, scope, signal) => {
        if (scope === "all") return new Promise((resolve) => { finishManual = () => resolve(REPORT); });
        autoSignal = signal;
        autoStarted();
        return new Promise((resolve) => { finishAuto = () => resolve(REPORT); });
    });
    store.save(CONFIG);
    const manual = server.upload(CONFIG, ctx.sessionManager, "all");
    const ending = shutdown();
    await Promise.resolve();
    t.mock.timers.tick(6_000);
    finishManual();
    await manual;
    await ready;
    t.mock.timers.tick(3_999);
    assert.equal(autoSignal?.aborted, false);
    t.mock.timers.tick(1);
    await ending;
    assert.equal(autoSignal?.aborted, true);
    finishAuto();
    await server.drainUploads();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!.message, /timed out after 10 seconds/);
});

test("shutdown failures warn without exposing credentials or preventing shutdown", async (t) => {
    for (const error of [new Error(CONFIG.apiKey), new ArchiveClientError(CONFIG.apiKey, "unauthorized")]) {
        const {shutdown, store, notifications} = harness(t, async () => { throw error; });
        store.save(CONFIG);
        await shutdown();
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]!.type, "warning");
        assert.match(notifications[0]!.message, /^Automatic archive upload failed\./);
        assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
        if (error instanceof ArchiveClientError) assert.match(notifications[0]!.message, /API key is missing, invalid, or revoked/);
        assert.deepEqual(store.load(), CONFIG);
    }
    const {shutdown, store, notifications} = harness(t);
    writeFileSync(store.file, CONFIG.apiKey, {mode: 0o600});
    await shutdown();
    assert.equal(notifications[0]!.type, "warning");
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
});

test("automatic partial failures reuse bounded and sanitized upload reports", async (t) => {
    const {shutdown, store, notifications} = harness(t, async () => ({
        ...REPORT, failed: 1, warnings: [`${CONFIG.apiKey}\u001b[31m\nwarning`],
        failures: [{file: "/session.jsonl", message: CONFIG.apiKey}],
    }));
    store.save(CONFIG);
    await shutdown();
    assert.equal(notifications[0]!.type, "warning");
    assert.match(notifications[0]!.message, /1 failed/);
    assert.match(notifications[0]!.message, /\[redacted\]/);
    assert.doesNotMatch(notifications[0]!.message, /\[31m/);
    assert.equal(JSON.stringify(notifications).includes(CONFIG.apiKey), false);
});

test("duplicate shutdown after automatic upload starts does not cancel or republish it", async (t) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const upload = t.mock.fn((_config, _manager, _scope, uploadSignal: AbortSignal | undefined) => {
        signal = uploadSignal;
        started();
        return new Promise<typeof REPORT>((resolve) => { finish = () => resolve(REPORT); });
    });
    const {prepare, shutdown, store, notifications} = harness(t, upload);
    store.save(CONFIG);
    prepare();
    const ending = shutdown();
    await ready;
    prepare();
    assert.equal(shutdown(), ending);
    assert.equal(signal?.aborted, false, "repeated early preparation must not abort the active automatic upload");
    finish();
    await ending;
    assert.equal(upload.mock.callCount(), 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.type, "info");
});

test("logged-out shutdown skips an unsettled cancelled upload without draining or starting a deadline", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const {prepare, shutdown, server, ctx, store, notifications} = harness(t, (_config, _manager, _scope, uploadSignal) => {
        signal = uploadSignal;
        return new Promise((resolve) => { finish = () => resolve(REPORT); });
    });
    store.save(CONFIG);
    const manual = server.upload(CONFIG, ctx.sessionManager, "all");
    store.logout();
    const drain = t.mock.method(server, "drainUploads", async () => {
        throw new Error("Logged-out shutdown must not wait for cancelled publication");
    });
    prepare();
    await shutdown();
    assert.equal(signal?.aborted, true);
    assert.equal(drain.mock.callCount(), 0);
    t.mock.timers.tick(SHUTDOWN_UPLOAD_TIMEOUT_MS);
    assert.deepEqual(notifications, []);
    finish();
    await manual;
});

for (const change of ["logout", "destination"] as const) {
    test(`shutdown rechecks external ${change} after draining before automatic upload`, async (t) => {
        let finish!: () => void;
        const calls: ServerConfig[] = [];
        const {shutdown, server, store, ctx, notifications} = harness(t, (config, _manager, scope) => {
            calls.push(config);
            if (scope === "all") return new Promise((resolve) => { finish = () => resolve(REPORT); });
            return Promise.resolve(REPORT);
        });
        store.save(CONFIG);
        const manual = server.upload(CONFIG, ctx.sessionManager, "all");
        const ending = shutdown();
        await Promise.resolve();
        const replacement = {url: "https://replacement.example.com", apiKey: "replacement-key"};
        if (change === "logout") store.logout();
        else store.save(replacement);
        finish();
        await manual;
        await ending;
        assert.deepEqual(calls, change === "logout" ? [CONFIG] : [CONFIG, replacement]);
        assert.equal(notifications.length, change === "logout" ? 0 : 1);
    });
}

test("same lifecycle starts a subsequent session with fresh admission and one upload per outgoing manager", async (t) => {
    const managers: ExtensionContext["sessionManager"][] = [];
    const {start, prepare, shutdown, server, store, ctx, notifications} = harness(t, async (_config, manager) => {
        managers.push(manager);
        return REPORT;
    });
    store.save(CONFIG);
    const firstManager = ctx.sessionManager;
    start();
    prepare();
    const firstEnding = shutdown();
    await firstEnding;
    assert.equal(server.beginRequest(), undefined);
    const secondManager = {getSessionFile: () => "/second.jsonl"} as ExtensionContext["sessionManager"];
    ctx.sessionManager = secondManager;
    start();
    const request = server.beginRequest();
    assert.ok(request);
    prepare();
    assert.equal(request.signal.aborted, true);
    const secondEnding = shutdown();
    assert.notEqual(secondEnding, firstEnding);
    await secondEnding;
    await shutdown();
    assert.deepEqual(managers, [firstManager, secondManager]);
    assert.equal(notifications.length, 2);
});

test("lifecycle rejects duplicate registration of each independent shutdown phase", (t) => {
    const {lifecycle} = harness(t);
    assert.throws(() => lifecycle.registerPreparation(), /already registered/);
    assert.throws(() => lifecycle.register(), /already registered/);
});
