import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {
    ModelRuntime,
    SessionManager,
    type ExtensionContext,
    type SessionMessageEntry,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {createAssistantMessageEventStream, type AssistantMessage, type Message} from "@earendil-works/pi-ai";
import {SdkSubagentSessionFactory} from "../src/subagents/SdkSubagentSession.js";
import {SubagentReasoningAmount, SubagentReasoningSkill} from "../src/subagents/SubagentReasoning.js";
import type {SubagentChildSession, SubagentSessionRequest} from "../src/subagents/types.js";

const provider = "pilot-persistence-test";
const modelId = "offline";
const toolOutput = `tool-start:${"x".repeat(55_000)}:tool-end`;
const answer = `answer-start:${"y".repeat(55_000)}:answer-end`;
const cost = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0};

test("SDK subagents save complete ordinary Pi sessions across follow-ups and disposal", async (t) => {
    const fixture = await persistenceFixture(t);
    const request = fixture.request("subagent-history");
    const probe: ToolDefinition = {
        name: "persistence_probe",
        label: "persistence probe",
        description: "Return a large result to verify full history storage",
        parameters: {type: "object", properties: {}},
        async execute() {
            return {content: [{type: "text", text: toolOutput}], details: {persisted: true}};
        },
    };
    const child = await fixture.create(request, [probe]);
    assert.ok(!readdirSync(fixture.sessionDir).some((file) => file.includes(request.agentIdentifier)),
        "setup alone follows Pi's lazy session-file creation");

    assert.equal(await child.prompt("use probe", new AbortController().signal), answer);
    assert.equal(await child.prompt("follow-up question", new AbortController().signal), "reply:follow-up question");
    child.dispose();

    const info = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === request.agentIdentifier);
    assert.ok(info, "child is discoverable through normal Pi session listing");
    assert.equal(info.name, "Subagent: persistence tester");
    assert.equal(info.parentSessionPath, fixture.parent.getSessionFile());
    assert.equal(info.firstMessage, "use probe");
    const stored = SessionManager.open(info.path);
    assert.equal(stored.getSessionId(), request.agentIdentifier);
    assert.equal(stored.getCwd(), fixture.cwd);
    const metadata = stored.getEntries().find((entry) => entry.type === "custom"
        && entry.customType === "pilot.subagent");
    assert.ok(metadata?.type === "custom");
    assert.deepEqual(metadata.data, {parentAgentIdentifier: fixture.parent.getSessionId()});
    assert.ok(stored.getEntries().some((entry) => entry.type === "model_change"
        && entry.provider === provider && entry.modelId === modelId));
    assert.ok(stored.getEntries().some((entry) => entry.type === "thinking_level_change"
        && entry.thinkingLevel === "medium"));

    const messages = sessionMessages(stored);
    assert.deepEqual(messages.map((message) => message.role), [
        "system", "user", "assistant", "toolResult", "assistant", "user", "assistant",
    ]);
    const system = messages[0]!;
    assert.equal(system.role, "system");
    assert.match(JSON.stringify(system), /PERSISTED_CHILD_INSTRUCTIONS/);
    assert.match(JSON.stringify(system), /persistence_probe/);
    const toolCall = messages[2]!;
    assert.equal(toolCall.role, "assistant");
    assert.deepEqual(toolCall.content, [
        {type: "thinking", thinking: "inspect the delegated evidence", thinkingSignature: "signature"},
        {type: "toolCall", id: "probe-call", name: "persistence_probe", arguments: {}},
    ]);
    const result = messages[3]!;
    assert.equal(result.role, "toolResult");
    assert.deepEqual(result.content, [{type: "text", text: toolOutput}]);
    assert.deepEqual(result.details, {persisted: true});
    const response = messages[4]!;
    assert.equal(response.role, "assistant");
    assert.deepEqual(response.content, [{type: "text", text: answer}]);
    assert.equal(response.usage.totalTokens, 30);
    assert.deepEqual(stored.buildSessionContext().messages, messages,
        "the native manager reconstructs the complete stored conversation");
});

test("delivered mid-run steering is stored in the child's normal conversation", async (t) => {
    const fixture = await persistenceFixture(t);
    const request = fixture.request("subagent-steering");
    let child!: SubagentChildSession;
    const probe: ToolDefinition = {
        name: "persistence_probe", label: "steering probe", description: "Accept steering during a tool call",
        parameters: {type: "object", properties: {}},
        async execute() {
            assert.equal(await child.steer("steering task"), true);
            return {content: [{type: "text", text: "probe result"}], details: undefined};
        },
    };
    child = await fixture.create(request, [probe]);
    assert.equal(await child.prompt("use probe", new AbortController().signal), "reply:steering task");
    child.dispose();
    const info = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === request.agentIdentifier);
    assert.ok(info);
    const messages = sessionMessages(SessionManager.open(info.path));
    assert.deepEqual(messages.filter((message) => message.role === "user")
        .map((message) => textContent(message.content)), ["use probe", "steering task"]);
});

test("a persistent root's allocated filename enables storage even before its first message", async (t) => {
    const fixture = await persistenceFixture(t);
    const parentFile = fixture.parent.newSession({id: "parent-without-history"});
    assert.ok(parentFile);
    assert.ok(!existsSync(parentFile));
    const request = fixture.request("subagent-before-root-history");
    const child = await fixture.create(request);
    await child.prompt("child task", new AbortController().signal);
    child.dispose();
    const info = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === request.agentIdentifier);
    assert.ok(info);
    assert.equal(info.parentSessionPath, parentFile);
    assert.ok(!existsSync(parentFile));
});

test("nested subagent sessions link to their immediate parent and keep the actual child cwd", async (t) => {
    const fixture = await persistenceFixture(t);
    const firstRequest = fixture.request("subagent-parent");
    const first = await fixture.create(firstRequest);
    await first.prompt("parent task", new AbortController().signal);
    const otherCwd = path.join(fixture.directory, "other-project");
    mkdirSync(otherCwd);
    const nestedRequest = fixture.request("subagent-nested", {
        parentAgentIdentifier: firstRequest.agentIdentifier,
        cwd: otherCwd,
    });
    const nested = await fixture.create(nestedRequest);
    await nested.prompt("nested task", new AbortController().signal);
    first.dispose();
    nested.dispose();

    const firstInfo = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === firstRequest.agentIdentifier);
    const nestedInfo = (await SessionManager.list(otherCwd, fixture.sessionDir))
        .find((session) => session.id === nestedRequest.agentIdentifier);
    assert.ok(firstInfo);
    assert.ok(nestedInfo);
    assert.equal(path.dirname(nestedInfo.path), fixture.sessionDir,
        "the root's configured session directory is inherited across workspaces");
    const stored = SessionManager.open(nestedInfo.path);
    assert.equal(stored.getHeader()?.parentSession, firstInfo.path);
    assert.equal(stored.getCwd(), otherCwd);
    const metadata = stored.getEntries().find((entry) => entry.type === "custom"
        && entry.customType === "pilot.subagent");
    assert.ok(metadata?.type === "custom");
    assert.deepEqual(metadata.data, {parentAgentIdentifier: firstRequest.agentIdentifier});
});

test("ephemeral parents keep both direct and nested child sessions ephemeral", async (t) => {
    const fixture = await persistenceFixture(t, {ephemeral: true});
    t.mock.method(SessionManager, "create", () => {
        throw new Error("ephemeral children must not create persistent session managers");
    });
    const request = fixture.request("subagent-ephemeral");
    const child = await fixture.create(request);
    assert.equal(await child.prompt("ephemeral task", new AbortController().signal), "reply:ephemeral task");
    const nested = await fixture.create(fixture.request("subagent-ephemeral-nested", {
        parentAgentIdentifier: request.agentIdentifier,
    }));
    assert.equal(await nested.prompt("nested ephemeral task", new AbortController().signal), "reply:nested ephemeral task");
    child.dispose();
    nested.dispose();
    assert.ok(!existsSync(fixture.sessionDir));
});

test("failed and interrupted first turns retain their prompts and terminal assistant messages", async (t) => {
    const fixture = await persistenceFixture(t);
    const failedRequest = fixture.request("subagent-failed");
    const failed = await fixture.create(failedRequest);
    await assert.rejects(failed.prompt("fail", new AbortController().signal), /intentional provider failure/);
    failed.dispose();
    const failedInfo = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === failedRequest.agentIdentifier);
    assert.ok(failedInfo);
    const failedMessages = sessionMessages(SessionManager.open(failedInfo.path));
    assert.ok(failedMessages.some((message) => message.role === "user" && textContent(message.content) === "fail"));
    assert.ok(failedMessages.some((message) => message.role === "assistant" && message.stopReason === "error"));

    const interruptedRequest = fixture.request("subagent-interrupted");
    const interrupted = await fixture.create(interruptedRequest);
    const controller = new AbortController();
    const prompting = interrupted.prompt("wait for abort", controller.signal);
    await fixture.waiting;
    const interruptedInfo = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === interruptedRequest.agentIdentifier);
    assert.ok(interruptedInfo, "the initial prompt is on disk before the model completes");
    assert.ok(sessionMessages(SessionManager.open(interruptedInfo.path))
        .some((message) => message.role === "user" && textContent(message.content) === "wait for abort"));
    controller.abort();
    await assert.rejects(prompting, /aborted/);
    interrupted.dispose();
    const interruptedMessages = sessionMessages(SessionManager.open(interruptedInfo.path));
    assert.ok(interruptedMessages.some((message) => message.role === "assistant" && message.stopReason === "aborted"));
    assert.ok(!interruptedMessages.some((message) => message.role === "assistant" && message.stopReason === "pending"));
});

test("child session storage failures do not silently fall back to ephemeral history", async (t) => {
    const fixture = await persistenceFixture(t);
    const blocked = path.join(fixture.directory, "not-a-directory");
    writeFileSync(blocked, "blocked");
    t.mock.method(fixture.parent, "getSessionDir", () => path.join(blocked, "sessions"));
    await assert.rejects(fixture.create(fixture.request("subagent-storage-failed")), /ENOTDIR/);
});

test("first-message storage failures reject before any model or tool execution", async (t) => {
    const fixture = await persistenceFixture(t);
    const child = await fixture.create(fixture.request("subagent-flush-failed"));
    rmSync(fixture.sessionDir, {recursive: true});
    writeFileSync(fixture.sessionDir, "not a directory");
    await assert.rejects(child.prompt("use probe", new AbortController().signal), /ENOTDIR/);
    assert.equal(fixture.modelRequests(), 0);
});

test("relative custom session directories produce absolute parent links", async (t) => {
    const fixture = await persistenceFixture(t, {relativeSessionDir: true});
    const parentFile = fixture.parent.getSessionFile();
    assert.ok(parentFile && !path.isAbsolute(parentFile));
    const request = fixture.request("subagent-relative-storage");
    const child = await fixture.create(request);
    await child.prompt("child task", new AbortController().signal);
    child.dispose();
    const info = (await SessionManager.list(fixture.cwd, fixture.sessionDir))
        .find((session) => session.id === request.agentIdentifier);
    assert.ok(info);
    assert.equal(info.parentSessionPath, path.resolve(parentFile));
});

test("persistent children require a known immediate parent session", async (t) => {
    const fixture = await persistenceFixture(t);
    await assert.rejects(fixture.create(fixture.request("subagent-orphan", {
        parentAgentIdentifier: "unknown-parent",
    })), /Parent subagent session is unavailable: unknown-parent/);
    assert.ok(!readdirSync(fixture.sessionDir).some((file) => file.includes("subagent-orphan")));
});

async function persistenceFixture(t: TestContext, options: {ephemeral?: boolean; relativeSessionDir?: boolean} = {}) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-subagent-persistence-"));
    const cwd = path.join(directory, "project");
    const sessionDir = path.join(directory, "configured-sessions");
    const children: SubagentChildSession[] = [];
    t.after(() => {
        for (const child of children) child.dispose();
        rmSync(directory, {recursive: true, force: true});
    });
    mkdirSync(cwd);
    const parent = options.ephemeral
        ? SessionManager.inMemory(cwd, {id: "parent"})
        : SessionManager.create(cwd, options.relativeSessionDir ? path.relative(process.cwd(), sessionDir) : sessionDir,
            {id: "parent"});
    parent.appendMessage({role: "user", content: "parent task", timestamp: Date.now()});

    const runtime = await ModelRuntime.create({
        credentials: {
            async read() { return undefined; },
            async list() { return []; },
            async modify() { throw new Error("unexpected credential mutation"); },
            async delete() { throw new Error("unexpected credential deletion"); },
        },
        modelsPath: null,
        refreshOnCreate: false,
    });
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { notifyWaiting = resolve; });
    let modelRequests = 0;
    runtime.registerProvider(provider, {
        apiKey: "test-only-key",
        baseUrl: "https://offline.invalid",
        api: "openai-responses",
        models: [{
            id: modelId, name: "Offline persistence test", reasoning: true, input: ["text"],
            cost, contextWindow: 1_000_000, maxTokens: 100_000,
        }],
        streamSimple(model, context, options) {
            modelRequests++;
            const last = context.messages.at(-1);
            const task = last?.role === "user" ? textContent(last.content) : "";
            const stopReason = task === "fail" ? "error" : task === "use probe" ? "toolUse" : "stop";
            const message: AssistantMessage = {
                role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: task === "use probe" ? [
                    {type: "thinking", thinking: "inspect the delegated evidence", thinkingSignature: "signature"},
                    {type: "toolCall", id: "probe-call", name: "persistence_probe", arguments: {}},
                ] : [{type: "text", text: last?.role === "toolResult" ? answer : `reply:${task}`}],
                usage: {input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost},
                stopReason, timestamp: Date.now(),
            };
            const stream = createAssistantMessageEventStream();
            stream.push({type: "start", partial: {...message, content: [], stopReason: "pending"}});
            if (task === "wait for abort") {
                assert.ok(options?.signal);
                const abort = () => stream.push({
                    type: "error", reason: "aborted",
                    error: {...message, stopReason: "aborted", errorMessage: "request aborted"},
                });
                if (options.signal.aborted) abort();
                else options.signal.addEventListener("abort", abort, {once: true});
                notifyWaiting();
            } else if (stopReason === "error") {
                stream.push({type: "error", reason: "error", error: {...message, errorMessage: "intentional provider failure"}});
            } else {
                stream.push({type: "done", reason: stopReason, message});
            }
            return stream;
        },
    });
    t.mock.method(ModelRuntime, "create", async () => runtime);
    const factory = new SdkSubagentSessionFactory({sessionManager: parent} as unknown as ExtensionContext);
    return {
        directory, cwd, sessionDir, parent, waiting, modelRequests: () => modelRequests,
        request(agentIdentifier: string, overrides: Partial<SubagentSessionRequest> = {}): SubagentSessionRequest {
            return {
                parentAgentIdentifier: parent.getSessionId(), agentIdentifier, cwd,
                task: "delegated task", role: "persistence tester", capabilities: [], timeoutSeconds: 30,
                reasoningSkill: SubagentReasoningSkill.MID, reasoningAmount: SubagentReasoningAmount.MID,
                modelPreference: `${provider}/${modelId}`, systemPrompt: "PERSISTED_CHILD_INSTRUCTIONS",
                ...overrides,
            };
        },
        async create(request: SubagentSessionRequest, tools: ToolDefinition[] = []) {
            const child = await factory.create(request, tools, new AbortController().signal);
            children.push(child);
            return child;
        },
    };
}

function textContent(content: Message["content"]): string {
    return typeof content === "string" ? content : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function sessionMessages(sessionManager: SessionManager) {
    return sessionManager.getEntries()
        .filter((entry): entry is SessionMessageEntry => entry.type === "message")
        .map((entry) => entry.message);
}
