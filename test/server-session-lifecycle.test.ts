import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {ServerService} from "../src/server/ServerService.js";
import {ServerSessionLifecycle} from "../src/server/ServerSessionLifecycle.js";
import {ArchiveBackground} from "../src/server/ArchiveBackground.js";
import {ArchiveRuntime} from "../src/server/ArchiveRuntime.js";
import {ArchiveInbox} from "../src/server/ArchiveInbox.js";
import {ArchiveSessions} from "../src/server/ArchiveSessions.js";
import {recordMainSessionIdentity} from "../src/sessions/SessionIdentity.js";

type Handler = (event: never, ctx: ExtensionContext) => void | Promise<void>;
const CONFIG = {url: "https://sessions.example.com", apiKey: "private-lifecycle-test-key"};

function harness(t: TestContext, awaitLocalShutdown: () => Promise<void> = async () => {}) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-lifecycle-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const runtime = new ArchiveRuntime();
    const initialize = t.mock.method(runtime, "initialize", async () => {});
    const launch = t.mock.method(runtime, "launch", async () => {});
    const background = new ArchiveBackground(store, {runtime});
    const enqueue = t.mock.method(background, "enqueue");
    const inbox = new ArchiveInbox(background.directory);
    const starts: Handler[] = [];
    const stops: Handler[] = [];
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    let manager = SessionManager.create(directory, path.join(directory, "sessions"));
    const pi = {
        on(event: string, handler: Handler) { (event === "session_start" ? starts : stops).push(handler); },
        appendEntry(customType: string, data: unknown) { manager.appendCustomEntry(customType, data); },
        registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    const check = t.mock.fn(async () => { throw new Error("No lifecycle version requests"); });
    const server = new ServerService(store, check, background);
    const lifecycle = new ServerSessionLifecycle(pi, server, awaitLocalShutdown);
    lifecycle.registerPreparation();
    // Match Pilot: identity and cache precede asynchronous child startup / runner initialization.
    pi.on("session_start", (_event, ctx) => {
        recordMainSessionIdentity(pi, ctx.sessionManager);
        lifecycle.captureSource(ctx);
    });
    lifecycle.register();
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        hasUI: false, sessionManager: manager,
        ui: {notify(message: string, type = "info") { notifications.push({message, type}); }},
    } as unknown as ExtensionCommandContext;
    return {
        directory, store, runtime, initialize, launch, background, enqueue, inbox, server, lifecycle, pi, commands, check, ctx, notifications,
        setManager(next: SessionManager) { manager = next; ctx.sessionManager = next; },
        async start() { for (const handler of starts) await handler(undefined as never, ctx); },
        prepare: () => stops[0]!(undefined as never, ctx),
        shutdown: () => stops[1]!(undefined as never, ctx),
    };
}

test("startup caches identity then wakes retained work without scheduling history; departure queues once quietly", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    await h.start();
    assert.equal(h.initialize.mock.callCount(), 1);
    assert.ok(h.launch.mock.callCount() >= 1);
    assert.equal(h.enqueue.mock.callCount(), 0);
    assert.deepEqual(h.inbox.ids(), []);
    const ending = h.shutdown();
    assert.equal(h.shutdown(), ending);
    await ending;
    await h.shutdown();
    assert.equal(h.enqueue.mock.callCount(), 1);
    const source = h.enqueue.mock.calls[0]!.arguments[0];
    assert.equal(source.activeSession.main, true);
    assert.equal(source.rootSessionId, h.ctx.sessionManager.getSessionId());
    assert.equal(source.scope, "current");
    assert.equal(h.inbox.ids().length, 1);
    assert.deepEqual(h.notifications, []);
    assert.equal(h.check.mock.callCount(), 0);
});

test("departure does not access managers, discover pages, capture sources, validate runtime, or perform HTTP", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    await h.start();
    for (const method of ["getSessionId", "getSessionFile", "getSessionDir", "getHeader", "getEntries"] as const) {
        t.mock.method(h.ctx.sessionManager, method, () => { throw new Error(`Departure called ${method}`); });
    }
    const discoverPage = t.mock.method(ArchiveSessions.prototype, "discoverPage", async () => { throw new Error("No scan"); });
    const captureSource = t.mock.method(ArchiveSessions.prototype, "captureSource", async () => { throw new Error("No transcript/hash/copy"); });
    const initialize = t.mock.method(h.background, "initialize", async () => { throw new Error("No departure initialization"); });
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No HTTP"); });
    await h.shutdown();
    assert.equal(h.inbox.ids().length, 1);
    assert.deepEqual(h.notifications, []);
    for (const method of [discoverPage, captureSource, initialize, fetch]) assert.equal(method.mock.callCount(), 0);
});

test("early preparation cancels foreground reads before teardown; an unresolved request cannot block enqueue", async (t) => {
    let finishTeardown!: () => void;
    const barrier = new Promise<void>((resolve) => { finishTeardown = resolve; });
    const h = harness(t, () => barrier);
    h.store.save(CONFIG);
    await h.start();
    let finishStatus!: () => void;
    t.mock.method(h.server, "checkConnection", () => new Promise((resolve) => {
        finishStatus = () => resolve({kind: "compatible", version: "1.2.3"});
    }));
    new ServerCommand(h.pi, h.server).register();
    const pendingStatus = h.commands.get("server")!.handler("", h.ctx);
    const request = h.server.beginRequest()!;
    h.prepare();
    assert.equal(request.signal.aborted, true);
    assert.equal(h.server.beginRequest(), undefined);
    const ending = h.shutdown();
    await Promise.resolve();
    assert.equal(h.enqueue.mock.callCount(), 0);
    finishTeardown();
    await ending;
    assert.equal(h.inbox.ids().length, 1, "no drain of the still-unresolved status request");
    finishStatus();
    await pendingStatus;
    assert.deepEqual(h.notifications, [], "stale foreground status is suppressed");
});

test("teardown failure warns separately but still durably queues usable cached source", async (t) => {
    const h = harness(t, async () => { throw new Error(CONFIG.apiKey); });
    h.store.save(CONFIG);
    await h.start();
    await h.shutdown();
    await h.shutdown();
    assert.equal(h.inbox.ids().length, 1);
    assert.equal(h.enqueue.mock.callCount(), 1);
    assert.deepEqual(h.notifications, [{message: "Local session shutdown failed. Archive capture may not include all final writes.", type: "warning"}]);
});

for (const kind of ["unconfigured", "logged-out", "ephemeral"] as const) {
    test(`automatic departure quietly skips ${kind}`, async (t) => {
        const h = harness(t);
        if (kind !== "unconfigured") h.store.save(CONFIG);
        if (kind === "ephemeral") h.setManager(SessionManager.inMemory(h.directory));
        await h.start();
        if (kind === "logged-out") h.store.logout();
        if (kind === "ephemeral") t.mock.method(h.store, "load", () => { throw new Error("No config read needed"); });
        await h.shutdown();
        assert.equal(h.enqueue.mock.callCount(), 0);
        assert.deepEqual(h.inbox.ids(), []);
        assert.deepEqual(h.notifications, []);
    });
}

test("startup runtime failure is nonfatal; departure retains durable work without retrying validation", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    t.mock.method(h.runtime, "initialize", async () => { throw new Error(CONFIG.apiKey); });
    await h.start();
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!.message, /startup failed/);
    const initialize = t.mock.method(h.background, "initialize", async () => { throw new Error("No departure validation"); });
    await h.shutdown();
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(h.inbox.ids().length, 1);
    assert.match(h.notifications[1]!.message, /work is queued/);
    assert.doesNotMatch(JSON.stringify(h.notifications), /could not be queued|private-lifecycle-test-key/);
});

test("launch failure after admission remains queued, not failed admission, and warnings never reflect raw text", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    await h.start();
    t.mock.method(h.runtime, "launch", async () => { throw new Error(`${CONFIG.apiKey}\u001b[31m`); });
    await h.shutdown();
    assert.equal(h.inbox.ids().length, 1);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!.message, /work is queued/);
    assert.doesNotMatch(JSON.stringify(h.notifications), /could not be queued|private-lifecycle-test-key|31m/);
});

test("admission and local config failures warn once without exposing credentials", async (t) => {
    for (const kind of ["enqueue", "config"] as const) {
        const h = harness(t);
        h.store.save(CONFIG);
        await h.start();
        if (kind === "enqueue") t.mock.method(h.background, "enqueue", async () => { throw new Error(CONFIG.apiKey); });
        else writeFileSync(h.store.file, CONFIG.apiKey, {mode: 0o600});
        await h.shutdown();
        await h.shutdown();
        assert.deepEqual(h.inbox.ids(), []);
        assert.equal(h.notifications.length, 1);
        assert.match(h.notifications[0]!.message, /could not be queued/);
        assert.equal(JSON.stringify(h.notifications).includes(CONFIG.apiKey), false);
    }
});

test("old departure keeps its captured source while another startup changes the live manager and cache", async (t) => {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness(t, () => barrier);
    h.store.save(CONFIG);
    await h.start();
    const oldId = h.ctx.sessionManager.getSessionId();
    const oldFile = h.ctx.sessionManager.getSessionFile();
    const oldDirectory = h.ctx.sessionManager.getSessionDir();
    const ending = h.shutdown();
    const next = SessionManager.create(h.directory, path.join(h.directory, "next-sessions"));
    h.setManager(next);
    await h.start();
    const request = h.server.beginRequest()!;
    finish();
    await ending;
    assert.equal(request.signal.aborted, false, "old completion does not close new admission");
    assert.equal(h.enqueue.mock.calls[0]!.arguments[0].activeSession.sessionId, oldId);
    assert.equal(h.enqueue.mock.calls[0]!.arguments[0].sessionFile, oldFile);
    assert.equal(h.enqueue.mock.calls[0]!.arguments[0].sessionDirectory, oldDirectory);
    await h.shutdown();
    await h.shutdown();
    assert.equal(h.enqueue.mock.callCount(), 2);
    assert.equal(h.enqueue.mock.calls[1]!.arguments[0].activeSession.sessionId, next.getSessionId());
    assert.equal(h.inbox.ids().length, 2);
});

test("departure reads current local configuration only after the teardown barrier", async (t) => {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const h = harness(t, () => barrier);
    h.store.save(CONFIG);
    await h.start();
    const ending = h.shutdown();
    h.store.logout();
    finish();
    await ending;
    assert.equal(h.enqueue.mock.callCount(), 0);
    assert.deepEqual(h.notifications, []);
});

test("invalid startup scope is nonfatal and never recomputed from the manager at departure", async (t) => {
    const h = harness(t);
    h.store.save(CONFIG);
    t.mock.method(h.ctx.sessionManager, "getSessionDir", () => { throw new Error(CONFIG.apiKey); });
    await h.start();
    await h.shutdown();
    assert.equal(h.enqueue.mock.callCount(), 0);
    assert.deepEqual(h.notifications, [{message: "Automatic archive source could not be recorded. Local session files are unchanged.", type: "warning"}]);
});

test("lifecycle rejects duplicate registration of both independent phases", (t) => {
    const {lifecycle} = harness(t);
    assert.throws(() => lifecycle.registerPreparation(), /already registered/);
    assert.throws(() => lifecycle.register(), /already registered/);
});
