import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext} from "@earendil-works/pi-coding-agent";
import {ServerService} from "../src/server/ServerService.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {SessionArchive} from "../src/server/SessionArchive.js";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {ArchiveTools} from "../src/tools/server/ArchiveTools.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";

const CONFIG = {url: "https://sessions.example.com", apiKey: "private-service-test-key"};
const REPORT = {uploaded: 1, unchanged: 0, failed: 0, warnings: [], failures: []};
const MANAGER = {getSessionFile: () => "/outgoing.jsonl"} as ExtensionContext["sessionManager"];
type UploadArchive = NonNullable<ConstructorParameters<typeof ServerService>[2]>;

function harness(t: TestContext, upload?: UploadArchive) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-service-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const check = t.mock.fn(async () => ({kind: "compatible" as const, version: "1.2.3"}));
    const server = new ServerService(store, check, upload);
    return {server, store, check};
}

test("core service owns request admission, completion, and shutdown cancellation independently of entry points", (t) => {
    const {server} = harness(t);
    const finished = server.beginRequest();
    const active = server.beginRequest();
    assert.ok(finished);
    assert.ok(active);
    server.finishRequest(finished);
    server.beginShutdown();
    assert.equal(finished.signal.aborted, false);
    assert.equal(active.signal.aborted, true);
    assert.equal(server.beginRequest(), undefined);
    server.beginShutdown();
    server.finishRequest(active);
});

test("core upload forwards config, manager, scope and combines caller and owned cancellation", async (t) => {
    const signals: AbortSignal[] = [];
    const finishes: Array<() => void> = [];
    const {server} = harness(t, (config, manager, scope, signal) => {
        assert.equal(config, CONFIG);
        assert.equal(manager, MANAGER);
        assert.equal(scope, "all");
        assert.ok(signal);
        signals.push(signal);
        return new Promise((resolve) => { finishes.push(() => resolve(REPORT)); });
    });
    const controller = new AbortController();
    const first = server.upload(CONFIG, MANAGER, "all", controller.signal);
    const second = server.upload(CONFIG, MANAGER, "all");
    controller.abort();
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false, "caller cancellation does not cancel independent uploads");
    server.abortUploads();
    assert.ok(signals.every((signal) => signal.aborted));
    finishes.forEach((finish) => finish());
    assert.deepEqual(await Promise.all([first, second]), [REPORT, REPORT]);
    await server.drainUploads();
});

test("already-aborted uploads never invoke the archive callback", async (t) => {
    const upload = t.mock.fn(async () => REPORT);
    const {server} = harness(t, upload);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(server.upload(CONFIG, MANAGER, "current", controller.signal), {name: "AbortError"});
    assert.equal(upload.mock.callCount(), 0);
    await server.drainUploads();
});

test("drain waits for all cancelled uploads including failures and removes settled operations", async (t) => {
    const finishes: Array<() => void> = [];
    const {server} = harness(t, () => new Promise((resolve, reject) => {
        const index = finishes.length;
        finishes.push(() => index === 0 ? reject(new Error("cancelled publication")) : resolve(REPORT));
    }));
    const failed = server.upload(CONFIG, MANAGER, "all");
    const failedResult = assert.rejects(failed, /cancelled publication/);
    const succeeded = server.upload(CONFIG, MANAGER, "current");
    server.beginShutdown();
    let drained = false;
    const draining = server.drainUploads().then(() => { drained = true; });
    finishes[1]!();
    await succeeded;
    assert.equal(drained, false, "a superseded upload still owns its journal until it settles");
    finishes[0]!();
    await failedResult;
    await draining;
    assert.equal(drained, true);
    await server.drainUploads();
});

test("repeated shutdown does not abort automatic publication admitted after shutdown preparation", async (t) => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const {server} = harness(t, (_config, _manager, _scope, uploadSignal) => {
        signal = uploadSignal;
        return new Promise((resolve) => { finish = () => resolve(REPORT); });
    });
    server.beginShutdown();
    const automatic = server.upload(CONFIG, MANAGER, "current");
    assert.equal(signal?.aborted, false);
    server.beginShutdown();
    assert.equal(signal?.aborted, false);
    assert.equal(server.beginRequest(), undefined);
    finish();
    await automatic;
});

test("starting another session reopens admission without losing still-settling publication tracking", async (t) => {
    const finishes: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const {server} = harness(t, (_config, _manager, _scope, signal) => {
        signals.push(signal!);
        return new Promise((resolve) => { finishes.push(() => resolve(REPORT)); });
    });
    const oldRequest = server.beginRequest();
    assert.ok(oldRequest);
    const oldUpload = server.upload(CONFIG, MANAGER, "all");
    server.beginShutdown();
    server.startSession();
    const newRequest = server.beginRequest();
    assert.ok(newRequest);
    assert.equal(oldRequest.signal.aborted, true);
    assert.equal(newRequest.signal.aborted, false);
    const newUpload = server.upload(CONFIG, MANAGER, "current");
    server.beginShutdown();
    assert.equal(newRequest.signal.aborted, true);
    assert.ok(signals.every((signal) => signal.aborted));
    let drained = false;
    const draining = server.drainUploads().then(() => { drained = true; });
    finishes[1]!();
    await newUpload;
    assert.equal(drained, false, "reset must retain the previous session's unsettled upload");
    finishes[0]!();
    await oldUpload;
    await draining;
});

test("default core publication uses the same archive factory as read-only server access", async (t) => {
    const {server} = harness(t);
    const archive = t.mock.method(server, "archive");
    const upload = t.mock.method(SessionArchive.prototype, "upload", async (...[manager, scope, signal]: Parameters<SessionArchive["upload"]>) => {
        assert.equal(manager, MANAGER);
        assert.equal(scope, "current");
        assert.equal(signal?.aborted, false);
        return REPORT;
    });
    assert.deepEqual(await server.upload(CONFIG, MANAGER, "current"), REPORT);
    assert.equal(archive.mock.callCount(), 1);
    assert.deepEqual(archive.mock.calls[0]!.arguments, [CONFIG]);
    assert.equal(upload.mock.callCount(), 1);
});

test("archive tools operate independently without commands or upload lifecycle hooks and share the injected core", async (t) => {
    const {server, store, check} = harness(t);
    const hooks: string[] = [];
    const tools: string[] = [];
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    const pi = {
        on(event: string) { hooks.push(event); },
        registerTool(tool: {name: string}) { tools.push(tool.name); },
        registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); },
    } as unknown as ExtensionAPI;
    const ctx = {
        hasUI: true, mode: "interactive", ui: {notify() {}, input: async () => undefined},
        sessionManager: {getSessionId: () => "service-root", getSessionFile: () => undefined},
    } as unknown as ExtensionCommandContext & ExtensionToolContext;
    const policy = new PolicyRuntime("service-root", {
        initializeSchema() {}, loadPolicies: () => [], upsertPolicies() {}, deletePolicy() {},
    }, new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}));
    const runtime = {policyRuntime: policy} as PilotSessionRuntimeInterface;
    const archive = t.mock.method(server, "archive");
    const page = {binding: {server_id: "server", namespace_id: "namespace", history_generation: "generation"},
        sessions: [], next_cursor: null};
    const list = t.mock.method(SessionArchive.prototype, "list", async () => page);
    const upload = t.mock.method(server, "upload", async () => { throw new Error("Tools must never publish"); });
    const archiveTools = new ArchiveTools(pi, () => runtime, new ToolDisplayRows(), {server});
    archiveTools.register();
    store.save(CONFIG);
    await archiveTools.listToolDefinition().execute("independent-list", {}, undefined, undefined, ctx);
    assert.deepEqual(tools, ["archive_list", "archive_fetch"]);
    assert.equal(commands.size, 0, "archive access does not require command registration");
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(archive.mock.calls[0]!.arguments[0], CONFIG);
    new ServerCommand(pi, server).register();
    await commands.get("server")!.handler("logout", ctx);
    assert.equal(store.load(), undefined);
    await assert.rejects(archiveTools.listToolDefinition().execute("logged-out-list", {}, undefined, undefined, ctx), /Archive list failed/);
    assert.equal(list.mock.callCount(), 1, "tools observe command logout through shared configuration ownership");
    assert.equal(upload.mock.callCount(), 0);
    assert.equal(check.mock.callCount(), 0);
    assert.deepEqual(hooks, [], "neither commands nor tools own upload lifecycle hooks");
});
