import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext} from "@earendil-works/pi-coding-agent";
import {ServerService} from "../src/server/ServerService.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {ArchiveBackground} from "../src/server/ArchiveBackground.js";
import {captureArchiveSourceScope} from "../src/server/ArchiveSourceScopeCapture.js";
import {SessionArchive} from "../src/server/SessionArchive.js";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {ArchiveTools} from "../src/tools/server/ArchiveTools.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";

const CONFIG = {url: "https://sessions.example.com", apiKey: "private-service-test-key"};

function harness(t: TestContext) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-service-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const background = new ArchiveBackground(store);
    t.mock.method(background, "initialize", async () => {});
    t.mock.method(background, "wake", async () => {});
    const check = t.mock.fn(async () => ({kind: "compatible" as const, version: "1.2.3"}));
    const server = new ServerService(store, check, background);
    return {server, store, check, background, directory};
}

test("core service owns foreground admission and cancellation, not committed background work", async (t) => {
    const {server, background, directory} = harness(t);
    let finish!: () => void;
    const enqueue = t.mock.method(background, "enqueue", (...args: Parameters<ArchiveBackground["enqueue"]>) => {
        assert.equal(args.length, 1, "no request or session AbortSignal crosses queue ownership");
        return new Promise<{queued: true}>((resolve) => { finish = () => resolve({queued: true}); });
    });
    const source = captureArchiveSourceScope(SessionManager.inMemory(directory), "all");
    const committed = server.background.enqueue(source);
    const finished = server.beginRequest()!;
    const active = server.beginRequest()!;
    server.finishRequest(finished);
    server.beginShutdown();
    server.beginShutdown();
    assert.equal(finished.signal.aborted, false);
    assert.equal(active.signal.aborted, true);
    assert.equal(server.beginRequest(), undefined);
    finish();
    assert.deepEqual(await committed, {queued: true});
    assert.equal(enqueue.mock.callCount(), 1);
    server.finishRequest(active);
});

test("starting a new session reopens foreground admission without replacing background ownership", (t) => {
    const {server, background} = harness(t);
    const old = server.beginRequest()!;
    server.beginShutdown();
    server.startSession();
    const next = server.beginRequest()!;
    assert.equal(old.signal.aborted, true);
    assert.equal(next.signal.aborted, false);
    assert.equal(server.background, background);
    server.beginShutdown();
    assert.equal(next.signal.aborted, true);
});

test("service constructs a concrete queue and separate read-only archive service without starting either", (t) => {
    const {store} = harness(t);
    const initialize = t.mock.method(ArchiveBackground.prototype, "initialize", async () => { throw new Error("Not at construction"); });
    const server = new ServerService(store);
    assert.ok(server.background instanceof ArchiveBackground);
    assert.equal(server.background.directory, path.join(store.directory, "server-archive"));
    assert.ok(server.archive(CONFIG) instanceof SessionArchive);
    assert.equal(initialize.mock.callCount(), 0);
    for (const removed of ["upload", "abortUploads", "drainUploads"]) assert.equal(removed in server, false);
});

test("archive tools remain independent foreground reads and share only configuration with commands", async (t) => {
    const {server, store, check, background} = harness(t);
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
    const enqueue = t.mock.method(background, "enqueue", async () => { throw new Error("Tools must never enqueue"); });
    const archiveTools = new ArchiveTools(pi, () => runtime, new ToolDisplayRows(), {server});
    archiveTools.register();
    store.save(CONFIG);
    await archiveTools.listToolDefinition().execute("independent-list", {}, undefined, undefined, ctx);
    assert.deepEqual(tools, ["archive_list", "archive_fetch"]);
    assert.equal(commands.size, 0);
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(archive.mock.calls[0]!.arguments[0], CONFIG);
    new ServerCommand(pi, server).register();
    await commands.get("server")!.handler("logout", ctx);
    assert.equal(store.load(), undefined);
    await assert.rejects(archiveTools.listToolDefinition().execute("logged-out-list", {}, undefined, undefined, ctx), /Archive list failed/);
    assert.equal(list.mock.callCount(), 1);
    assert.equal(enqueue.mock.callCount(), 0);
    assert.equal(check.mock.callCount(), 0);
    assert.deepEqual(hooks, []);
});
