import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext, Theme, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {SubagentToolCatalog} from "../src/subagents/SubagentToolCatalog.js";
import type {PolicyPrincipalRegistry} from "../src/policy/PolicyRuntime.js";
import {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "../src/subagents/SubagentReasoning.js";
import {
    initialSubagentDefaults,
} from "../src/subagents/SubagentDefaults.js";
import {AGENT_CAPABILITIES} from "../src/subagents/AgentCapability.js";
import type {SubagentChildSessionFactory} from "../src/subagents/types.js";
import {SubagentMessageTool} from "../src/tools/subagent/SubagentMessageTool";
import {SubagentSpawnTool} from "../src/tools/subagent/SubagentSpawnTool";
import {SubagentStatusTool} from "../src/tools/subagent/SubagentStatusTool";
import {SubagentStopTool} from "../src/tools/subagent/SubagentStopTool";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

const expectedNames = ["subagent_spawn", "subagent_status", "subagent_message", "subagent_stop"];

test("each subagent tool registers independently and delegates only to the coordinator", async () => {
    const registered: ToolDefinition<any, any>[] = [];
    const pi = {
        registerTool(tool: ToolDefinition<any, any>) {
            registered.push(tool);
        },
    };
    let coordinator: SubagentCoordinator | undefined;
    const coordinatorProvider = () => {
        if (!coordinator) throw new Error("Subagent session is not available");
        return coordinator;
    };
    const displayRows = new ToolDisplayRows();
    const tools = [
        new SubagentSpawnTool(pi, coordinatorProvider, () => ({
            ...initialSubagentDefaults,
            mid: "provider/default-mid",
        }), displayRows),
        new SubagentStatusTool(pi, coordinatorProvider, displayRows),
        new SubagentMessageTool(pi, coordinatorProvider, displayRows),
        new SubagentStopTool(pi, coordinatorProvider, displayRows),
    ];
    for (const tool of tools) tool.register();

    assert.deepEqual(registered.map((tool) => tool.name), expectedNames);
    assert.deepEqual(tools.map((tool) => tool.toolDefinition().name), expectedNames);
    assert.equal(registered.every((tool) => tool.renderCall && tool.renderResult), true);
    const spawnProperties = (registered[0]!.parameters as any).properties;
    assert.equal("toolkits" in spawnProperties, false);
    assert.equal("model" in spawnProperties, false);
    assert.deepEqual(spawnProperties.capabilities.items.enum, AGENT_CAPABILITIES);
    assert.deepEqual(spawnProperties.reasoning_skill.enum, Object.values(SubagentReasoningSkill));
    assert.deepEqual(spawnProperties.reasoning_amount.enum, Object.values(SubagentReasoningAmount));
    assert.deepEqual(
        (registered[0]!.parameters as any).required,
        ["task", "role", "reasoning_skill", "reasoning_amount"],
    );

    const theme = plainTheme();
    const reasoning = {
        reasoning_skill: SubagentReasoningSkill.MID,
        reasoning_amount: SubagentReasoningAmount.MID,
    };
    const minimalCalls = [
        [{task: "Delegate work", role: "reviewer", mode: "sync", ...reasoning}, "subagent_spawn | reviewer (sync)"],
        [{jobIds: ["job-1", "job-2"], waitSeconds: 2}, "subagent_status | job-1, job-2 (wait 2s)"],
        [{jobId: "job-1", task: "Continue"}, "subagent_message | job-1"],
        [{jobId: "job-1"}, "subagent_stop | job-1"],
    ] as const;
    for (let index = 0; index < registered.length; index++) {
        const tool = registered[index]!;
        const [args, expected] = minimalCalls[index]!;
        assert.deepEqual(
            tool.renderCall!(args, theme, renderContext(args)).render(120),
            [expected],
        );
    }

    const spawnArgs = {
        task: numberedLines(10),
        role: "reviewer",
        mode: "sync",
        ...reasoning,
    };
    const truncatedCall = registered[0]!.renderCall!(
        spawnArgs,
        theme,
        renderContext(spawnArgs, {}, true),
    ).render(120);
    assert.equal(truncatedCall.at(-1), "        ... (2 more lines)");
    const fullCall = registered[0]!.renderCall!(
        spawnArgs,
        theme,
        renderContext(spawnArgs, {pilotFullDisplay: true}),
    ).render(120);
    assert.equal(fullCall.at(-1), "        line 10");

    const output = {content: [{type: "text" as const, text: numberedLines(10)}], details: {jobs: []}};
    assert.deepEqual(
        registered[0]!.renderResult!(
            output,
            {expanded: true, isPartial: false},
            theme,
            renderContext(spawnArgs, {}, true),
        ).render(120),
        ["", "... (2 earlier lines)", ...numberedLineArray(8, 3)],
    );

    await assert.rejects(
        invoke(registered[0]!, {task: "before", role: "reviewer", ...reasoning}),
        /session is not available/,
    );

    const factory: SubagentChildSessionFactory = {
        async create(request) {
            assert.equal(request.parentAgentIdentifier, "subagent-tool-test-agent");
            assert.equal(request.reasoningSkill, SubagentReasoningSkill.MID);
            assert.equal(request.reasoningAmount, SubagentReasoningAmount.MID);
            assert.equal(request.modelPreference, "provider/default-mid");
            return {
                async prompt(task) {
                    return `completed: ${task}`;
                },
                async abort() {
                },
                dispose() {
                },
            };
        },
    };
    const policyPrincipals: PolicyPrincipalRegistry = {
        registerPolicyPrincipal() {
        },
        removePolicyPrincipal() {
        },
    };
    coordinator = new SubagentCoordinator(
        factory,
        new SubagentToolCatalog({builtins: () => [], mcp: () => [], delegate: () => []}),
        policyPrincipals,
    );
    const result = await invoke(registered[0]!, {task: "work", role: "reviewer", ...reasoning});
    assert.match(textResult(result), /completed: work/);
    assert.match(textResult(result), /Status: completed/);

    await coordinator.close();
});

function plainTheme(): Theme {
    return {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;
}

function renderContext(
    args: unknown,
    state: Record<string, unknown> = {},
    expanded = false,
): any {
    return {
        args,
        state,
        toolCallId: "test-call",
        cwd: process.cwd(),
        invalidate() {
        },
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: false,
    };
}

function numberedLines(count: number): string {
    return numberedLineArray(count, 1).join("\n");
}

function numberedLineArray(count: number, start: number): string[] {
    return Array.from({length: count}, (_, index) => `line ${index + start}`);
}

function invoke(tool: ToolDefinition<any, any>, params: unknown): Promise<unknown> {
    return tool.execute(
        "test-call",
        params,
        undefined,
        undefined,
        {
            cwd: process.cwd(),
            sessionManager: {getSessionId: () => "subagent-tool-test-agent"},
        } as ExtensionContext,
    );
}

function textResult(result: unknown): string {
    if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
    return result.content
        .filter((part): part is { type: "text"; text: string } => (
            typeof part === "object"
            && part !== null
            && "type" in part
            && part.type === "text"
            && "text" in part
            && typeof part.text === "string"
        ))
        .map((part) => part.text)
        .join("\n");
}
