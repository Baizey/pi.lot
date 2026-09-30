import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    createAgentSession,
    SessionManager,
    SettingsManager,
    type ExtensionContext,
    type ExtensionToolContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {AgentMechanismCapability} from "../src/subagents/AgentCapability.js";
import {McpToolRegistry} from "../src/mcp/McpToolRegistry.js";
import type {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {
    createSubagentResourceLoader,
    SdkSubagentSession,
    SdkSubagentSessionFactory,
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

test("SDK child registers only granted native MCP discovery helpers without ambient extensions or connections", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-child-mcp-"));
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const marker = path.join(directory, "ambient-loaded");
    const serverMarker = path.join(directory, "ambient-server-started");
    try {
        for (const extensionDir of [path.join(cwd, ".pi", "extensions"), path.join(agentDir, "extensions")]) {
            mkdirSync(extensionDir, {recursive: true});
            writeFileSync(path.join(extensionDir, "hostile.js"),
                `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
        }
        const hostileConfig = JSON.stringify({
            mcpServers: {hostile: {command: process.execPath, args: ["-e",
                `require('node:fs').writeFileSync(${JSON.stringify(serverMarker)}, 'started')`]}},
        });
        writeFileSync(path.join(cwd, ".pi", "mcp.json"), hostileConfig);
        writeFileSync(path.join(agentDir, "mcp.json"), hostileConfig);
        const request: SubagentSessionRequest = {
            parentAgentIdentifier: "parent", agentIdentifier: "child", task: "inspect",
            role: "test", capabilities: [AgentMechanismCapability.mcp], cwd,
            timeoutSeconds: 30, reasoningSkill: SubagentReasoningSkill.MID,
            reasoningAmount: SubagentReasoningAmount.MID, modelPreference: AUTO_SUBAGENT_MODEL,
        };
        const codemode = childTool("mcp__test__code", "codemode");
        const deferred = childTool("mcp__test__later", "deferred");
        const direct = childTool("mcp__test__direct", "direct");
        const hidden = childTool("mcp__test__hidden", "hidden");

        const inspect = async (capabilities: SubagentSessionRequest["capabilities"],
                               tools: ToolDefinition<any, any>[]) => {
            const childRequest = {...request, capabilities};
            const settingsManager = SettingsManager.inMemory();
            const loader = await createSubagentResourceLoader(childRequest, agentDir, settingsManager, tools);
            assert.deepEqual(loader.getExtensions().errors, []);
            const {session} = await createAgentSession({
                cwd, agentDir, settingsManager, resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd), noTools: "builtin", customTools: tools,
            });
            try {
                await session.bindExtensions({});
                return {
                    registered: session.getAllTools().map((tool) => ({name: tool.name, exposure: tool.exposure})),
                    active: session.getActiveToolNames(),
                    extensions: loader.getExtensions().extensions.length,
                };
            } finally {
                session.dispose();
            }
        };

        const selected = await inspect(request.capabilities, [codemode, deferred, direct, hidden]);
        assert.equal(selected.extensions, 3); // Two public helper factories plus child-only activation.
        assert.ok(selected.registered.some((tool) => tool.name === "codemode"));
        assert.ok(selected.registered.some((tool) => tool.name === "tool_search"));
        assert.ok(selected.registered.some((tool) => tool.name === codemode.name && tool.exposure === "codemode"));
        assert.ok(selected.registered.some((tool) => tool.name === deferred.name && tool.exposure === "deferred"));
        assert.ok(selected.registered.some((tool) => tool.name === hidden.name && tool.exposure === "hidden"));
        assert.ok(selected.active.includes("codemode"));
        assert.ok(selected.active.includes("tool_search"));
        assert.ok(selected.active.includes(direct.name));
        assert.ok(!selected.active.includes(codemode.name));
        assert.ok(!selected.active.includes(deferred.name));
        assert.ok(!selected.active.includes(hidden.name));
        assert.ok(!selected.active.includes("read"));
        assert.ok(!selected.registered.some((tool) => tool.name === "mcp"));
        const codemodeOnly = await inspect(request.capabilities, [codemode]);
        assert.ok(codemodeOnly.active.includes("codemode"));
        assert.ok(!codemodeOnly.registered.some((tool) => tool.name === "tool_search"));
        const deferredOnly = await inspect(request.capabilities, [deferred]);
        assert.ok(deferredOnly.active.includes("tool_search"));
        assert.ok(!deferredOnly.registered.some((tool) => tool.name === "codemode"));
        const hiddenOnly = await inspect(request.capabilities, [hidden]);
        assert.equal(hiddenOnly.extensions, 0);
        assert.ok(!hiddenOnly.active.includes("codemode"));
        assert.ok(!hiddenOnly.active.includes("tool_search"));
        const empty = await inspect([], []);
        assert.equal(empty.extensions, 0);
        assert.ok(!empty.registered.some((tool) => tool.name.startsWith("mcp__")));
        const denied = await inspect([], [codemode, deferred]);
        assert.equal(denied.extensions, 0);
        assert.ok(!denied.registered.some((tool) => tool.name === "codemode" || tool.name === "tool_search"));
        await assert.rejects(
            new SdkSubagentSessionFactory({} as ExtensionContext).create(
                {...request, capabilities: []}, [direct], new AbortController().signal,
            ),
            /MCP tools require the subagent mcp capability/,
        );
        assert.ok(!existsSync(marker));
        assert.ok(!existsSync(serverMarker));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("SDK child executes native MCP proxies through real codemode, search, and nested tool routing", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-child-native-execution-"));
    const cwd = path.join(directory, "child");
    const agentDir = path.join(directory, "agent");
    try {
        mkdirSync(cwd, {recursive: true});
        mkdirSync(agentDir, {recursive: true});
        const registry = new McpToolRegistry({registerTool() {}});
        registry.startSession();
        const executions: Array<{name: string; cwd: string; value: string}> = [];
        const nativeTool = (name: string, exposure: ToolDefinition<any, any>["exposure"]): ToolDefinition<any, any> => ({
            name, label: name, description: `Find ${name} native echo`, exposure,
            namespace: {name: "mcp__demo", description: "Child native test server"},
            parameters: {type: "object", properties: {value: {type: "string"}}, required: ["value"]},
            async execute(_id, params: {value: string}, _signal, _onUpdate, ctx) {
                executions.push({name, cwd: ctx.cwd, value: params.value});
                return {content: [{type: "text", text: `native:${params.value}`}], details: undefined};
            },
        });
        const codeName = "mcp__demo__code";
        const searchName = "mcp__demo__deferred";
        const directName = "mcp__demo__direct";
        const hiddenName = "mcp__demo__hidden";
        for (const [name, exposure] of [
            [codeName, "codemode"], [searchName, "deferred"],
            [directName, "direct"], [hiddenName, "hidden"],
        ] as const) registry.register(nativeTool(name, exposure));
        registry.register(nativeTool("list_mcp_resources", "direct"));
        const snapshot = registry.toolDefinitions();
        assert.deepEqual(snapshot.map((tool) => tool.name), [codeName, searchName, directName]);
        const outcomes: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>[] = [];
        const driver: ToolDefinition<any, any> = {
            name: "child_probe", label: "child probe", description: "Run nested child tools",
            parameters: {type: "object", properties: {}},
            async execute(_id, _params, _signal, _onUpdate, ctx) {
                outcomes.push(await ctx.executeTool(probe.name, probe.args));
                return {content: [{type: "text", text: "probe completed"}], details: undefined};
            },
        };
        let probe: {name: string; args: unknown} = {name: directName, args: {value: "direct"}};
        const request: SubagentSessionRequest = {
            parentAgentIdentifier: "parent", agentIdentifier: "child", task: "inspect", role: "test",
            capabilities: [AgentMechanismCapability.mcp], cwd, timeoutSeconds: 30,
            reasoningSkill: SubagentReasoningSkill.MID, reasoningAmount: SubagentReasoningAmount.MID,
            modelPreference: AUTO_SUBAGENT_MODEL,
        };
        const settingsManager = SettingsManager.inMemory();
        const loader = await createSubagentResourceLoader(request, agentDir, settingsManager, [...snapshot, driver]);
        const {session} = await createAgentSession({
            cwd, agentDir, settingsManager, resourceLoader: loader,
            sessionManager: SessionManager.inMemory(cwd), noTools: "builtin", customTools: [...snapshot, driver],
        });
        try {
            await session.bindExtensions({});
            const nested: string[] = [];
            const unsubscribe = session.subscribe((event) => {
                if (event.type === "tool_execution_start" && event.parentToolCallId) nested.push(event.toolName);
            });
            try {
                const run = async (name: string, args: unknown) => {
                    probe = {name, args};
                    const modelOnly = name === "codemode" || name === "tool_search";
                    const wrappedTool = session.agent.state.tools.find((tool) => tool.name === (
                        modelOnly ? name : driver.name
                    ));
                    assert.ok(wrappedTool, "child tool is registered with the SDK agent");
                    const callId = `probe-${session.agent.state.messages.length}`;
                    // Nested SDK execution requires an assistant turn; synthesize only the call,
                    // without invoking a provider or changing the persisted child transcript.
                    session.agent.state.messages.push({
                        role: "assistant", content: [{type: "toolCall", id: callId,
                            name: modelOnly ? name : driver.name, arguments: modelOnly ? args : {}}],
                    } as (typeof session.agent.state.messages)[number]);
                    if (modelOnly) {
                        // These helpers are model-only, so they cannot be reached by ctx.executeTool().
                        const result = await wrappedTool.execute(callId, args, undefined, undefined);
                        return {result, isError: result.isError === true};
                    }
                    await wrappedTool.execute(callId, {}, undefined, undefined);
                    return outcomes.at(-1)!;
                };
                const direct = await run(directName, {value: "direct"});
                assert.equal(direct.isError, false, JSON.stringify(direct));
                assert.deepEqual(direct.result.content, [{type: "text", text: "native:direct"}]);
                const code = await run("codemode", {
                    code: `const result = await tools.${codeName}({value: "script"}); console.log(JSON.stringify(result));`,
                });
                assert.equal(code.isError, false, JSON.stringify(code.result.content));
                assert.match(JSON.stringify(code.result.content), /native:script/);
                const search = await run("tool_search", {query: searchName});
                assert.equal(search.isError, false, JSON.stringify(search.result.content));
                assert.ok(session.getActiveToolNames().includes(searchName));
                const deferred = await run(searchName, {value: "found"});
                assert.equal(deferred.isError, false);
                assert.deepEqual(deferred.result.content, [{type: "text", text: "native:found"}]);
                assert.equal((await run(hiddenName, {value: "forbidden"})).isError, true);
                assert.equal((await run("list_mcp_resources", {value: "forbidden"})).isError, true);
                registry.register(nativeTool(codeName, "hidden"));
                const withdrawn = await run(codeName, {value: "withdrawn"});
                assert.equal(withdrawn.isError, true);
                assert.match(JSON.stringify(withdrawn.result.content), /no longer exposed/);
                const withdrawnScript = await run("codemode", {
                    code: `await tools.${codeName}({value: "withdrawn script"});`,
                });
                assert.equal(withdrawnScript.isError, true);
                assert.match(JSON.stringify(withdrawnScript.result.content), /no longer exposed/);
                assert.deepEqual(executions, [
                    {name: directName, cwd, value: "direct"},
                    {name: codeName, cwd, value: "script"},
                    {name: searchName, cwd, value: "found"},
                ]);
                assert.ok(nested.includes(directName));
                assert.ok(nested.includes(codeName));
                assert.ok(nested.includes(searchName));
            } finally {
                unsubscribe();
            }
        } finally {
            session.dispose();
            registry.stopSession();
        }
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

function childTool(name: string, exposure: ToolDefinition<any, any>["exposure"]): ToolDefinition<any, any> {
    return {
        name, label: name, description: name, exposure,
        parameters: {type: "object", properties: {}},
        async execute() {
            return {content: [{type: "text", text: "ok"}], details: undefined};
        },
    } as ToolDefinition<any, any>;
}

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
    const policyRuntime = {
        setAgentDecisionFlow() {
        },
        beginShutdown() {
        },
    } as unknown as PolicyRuntime;
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
