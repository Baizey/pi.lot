import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {
    createSubagentResourceLoader,
    SdkSubagentSession,
} from "../src/subagents/SdkSubagentSession.js";
import {SubagentRuntime} from "../src/subagents/SubagentRuntime.js";
import {SubagentReasoningAmount, SubagentReasoningSkill} from "../src/subagents/SubagentReasoning.js";
import type {SubagentSessionRequest} from "../src/subagents/types.js";
import {
    AUTO_SUBAGENT_MODEL,
    initialSubagentDefaults,
} from "../src/subagents/SubagentDefaults.js";

test("SDK subagent resource loader excludes ambient context and system files", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-subagent-resources-"));
    const cwd = path.join(directory, "project", "child");
    const agentDir = path.join(directory, "agent");
    const sentinels = [
        "CLAUDE_CONTEXT_SENTINEL",
        "AGENTS_CONTEXT_SENTINEL",
        "AGENTS_OVERRIDE_CONTEXT_SENTINEL",
        "AGENT_DIR_CONTEXT_SENTINEL",
        "PROJECT_SYSTEM_SENTINEL",
        "AGENT_SYSTEM_SENTINEL",
        "PROJECT_APPEND_SYSTEM_SENTINEL",
        "AGENT_APPEND_SYSTEM_SENTINEL",
    ];
    try {
        mkdirSync(path.join(cwd, ".pi"), {recursive: true});
        mkdirSync(cwd, {recursive: true});
        mkdirSync(agentDir, {recursive: true});
        writeFileSync(path.join(directory, "CLAUDE.md"), sentinels[0]);
        writeFileSync(path.join(directory, "project", "AGENTS.md"), sentinels[1]);
        writeFileSync(path.join(cwd, "AGENTS.override.md"), sentinels[2]);
        writeFileSync(path.join(agentDir, "AGENTS.md"), sentinels[3]);
        writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), sentinels[4]);
        writeFileSync(path.join(agentDir, "SYSTEM.md"), sentinels[5]);
        writeFileSync(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), sentinels[6]);
        writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), sentinels[7]);

        const request: SubagentSessionRequest = {
            parentAgentIdentifier: "parent",
            agentIdentifier: "child",
            task: "inspect resources",
            role: "resource tester",
            capabilities: [],
            cwd,
            timeoutSeconds: 30,
            reasoningSkill: SubagentReasoningSkill.MID,
            reasoningAmount: SubagentReasoningAmount.MID,
            modelPreference: AUTO_SUBAGENT_MODEL,
            systemPrompt: "PARENT_PROMPT_SENTINEL",
        };
        const loader = await createSubagentResourceLoader(request, agentDir);
        const loadedText = [
            ...loader.getAgentsFiles().agentsFiles.map((file) => file.content),
            loader.getSystemPrompt() ?? "",
            ...loader.getAppendSystemPrompt(),
        ].join("\n");

        assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
        assert.equal(loader.getSystemPrompt(), undefined);
        assert.equal(loader.getSystemPromptSource(), undefined);
        assert.deepEqual(loader.getAppendSystemPromptSources(), []);
        assert.equal(loader.getAppendSystemPrompt().length, 1);
        assert.match(loadedText, /PARENT_PROMPT_SENTINEL/);
        for (const sentinel of sentinels) assert.doesNotMatch(loadedText, new RegExp(sentinel));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("SDK subagent signal aborts are coalesced and rejection-safe", async () => {
    let abortCalls = 0;
    let rejectPrompt!: (error: Error) => void;
    const prompt = new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
    });
    const rawSession = {
        messages: [],
        isStreaming: true,
        subscribe() {
            return () => undefined;
        },
        prompt() {
            return prompt;
        },
        steer: async () => undefined,
        async abort() {
            abortCalls++;
            throw new Error("SDK abort failed");
        },
        dispose() {
        },
    };
    const session = new SdkSubagentSession(rawSession as any, {
        model: "provider/model",
        thinkingLevel: "medium",
        source: "test",
    });
    const controller = new AbortController();
    const running = session.prompt("work", controller.signal);

    controller.abort();
    rejectPrompt(new Error("prompt stopped"));

    await assert.rejects(running, /prompt stopped/);
    await assert.rejects(session.abort(), /SDK abort failed/);
    assert.equal(abortCalls, 1);
});

test("subagent runtime owns one coordinator per root session", async () => {
    const runtime = new SubagentRuntime({
        builtins: () => [],
        mcp: () => [],
        delegate: () => [],
    }, {
        defaultsStore: {
            load: () => ({...initialSubagentDefaults}),
            save() {
            },
        },
    });

    assert.throws(() => runtime.coordinator(), /session is not available/);
    assert.throws(() => runtime.defaults(), /session is not available/);
    const ctx = {
        cwd: process.cwd(),
        modelRegistry: {
            getAvailable: () => [{provider: "provider", id: "model"}],
        },
    } as unknown as ExtensionContext;
    const policyRuntime = {} as PolicyRuntime;
    await runtime.startSession(ctx, policyRuntime);
    const coordinator = runtime.coordinator();
    assert.ok(coordinator);
    assert.equal(runtime.coordinator(), coordinator);
    assert.equal(runtime.defaults().values.mid, AUTO_SUBAGENT_MODEL);
    assert.deepEqual(runtime.availableModels(), ["provider/model"]);
    await assert.rejects(runtime.startSession(ctx, policyRuntime), /already started/);

    await runtime.stopSession();
    await runtime.stopSession();
    assert.throws(() => runtime.coordinator(), /session is not available/);
    assert.throws(() => runtime.defaults(), /session is not available/);
    assert.throws(() => runtime.availableModels(), /session is not available/);
});
