import path from "node:path";
import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator";
import {SubagentRunMode} from "../../subagents/types";
import {
    SubagentReasoningAmount,
    SubagentReasoningLevel,
} from "../../subagents/SubagentReasoning.js";
import {
    AGENT_CAPABILITIES,
    type AgentCapability,
} from "../../subagents/AgentCapability.js";
import {
    type SubagentToolDetails,
    subagentToolResult,
} from "../../subagents/SubagentToolResult";
import {
    arraySchema,
    enumSchema,
    numberSchema,
    objectSchema,
    stringSchema,
} from "../types";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {
    ToolArgumentLayout,
    ToolArgumentPlacement,
    ToolTextDirection,
} from "../../tui/tool/ToolPresentation";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";
import {ThemeColor} from "../../tui/Color";

const DEFAULT_TIMEOUT_SECONDS = 900;

type SpawnToolInput = {
    task: string;
    role: string;
    mode?: SubagentRunMode;
    capabilities?: AgentCapability[];
    cwd?: string;
    timeoutSeconds?: number;
    reasoning_level: SubagentReasoningLevel;
    reasoning_amount: SubagentReasoningAmount;
    systemPrompt?: string;
    contextPaths?: string[];
};

type CoordinatorProvider = () => SubagentCoordinator;

const SPAWN_PRESENTATION = {
    toolName: "subagent_spawn",
    arguments: [
        {
            key: "role",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "mode",
            placement: ToolArgumentPlacement.TITLE_SECONDARY,
            format: (value) => ` (${String(value)})`,
        },
        {
            key: "capabilities",
            format: (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "(none)",
        },
        {key: "reasoning_level", label: "reasoning level"},
        {key: "reasoning_amount", label: "reasoning amount"},
        {key: "cwd"},
        {key: "timeoutSeconds", label: "timeout", format: (value) => `${String(value)}s`},
        {
            key: "task",
            layout: ToolArgumentLayout.BLOCK,
            color: ThemeColor.text,
        },
        {
            key: "systemPrompt",
            label: "system prompt",
            layout: ToolArgumentLayout.BLOCK,
        },
        {
            key: "contextPaths",
            label: "context paths",
            layout: ToolArgumentLayout.BLOCK,
            format: (value) => Array.isArray(value) ? value.join("\n") : String(value),
        },
    ],
    result: {direction: ToolTextDirection.TAIL, previewLines: 8},
} satisfies ToolPresentationSpec<SpawnToolInput>;

export class SubagentSpawnTool {
    private readonly definition: ToolDefinition<any, any>;
    private registered = false;

    constructor(
        private readonly pi: Pick<ExtensionAPI, "registerTool">,
        coordinator: CoordinatorProvider,
        displayRows: ToolDisplayRows,
    ) {
        this.definition = createDefinition(coordinator, displayRows) as unknown as ToolDefinition<any, any>;
    }

    register(): void {
        if (this.registered) throw new Error("Subagent spawn tool is already registered");
        this.registered = true;
        this.pi.registerTool(this.definition);
    }

    toolDefinition(): ToolDefinition<any, any> {
        return this.definition;
    }
}

function createDefinition(
    coordinator: CoordinatorProvider,
    displayRows: ToolDisplayRows,
): ToolDefinition<any, SubagentToolDetails> {
    const presentation = new ToolPresentationRenderer(SPAWN_PRESENTATION);
    return {
        name: "subagent_spawn",
        label: "Spawn subagent",
        description: "Start a child agent with abstract reasoning capabilities. Policy-area capabilities snapshot the parent's matching policy state; MCP and delegation are hard capabilities.",
        promptSnippet: "Delegate independent work to an in-process child agent with explicit reasoning and mechanism capabilities.",
        parameters: objectSchema({
            task: stringSchema("Task to delegate"),
            role: stringSchema("Concise role or title for the child agent", 120),
            mode: enumSchema(Object.values(SubagentRunMode), "Run mode", SubagentRunMode.SYNC),
            capabilities: arraySchema(
                enumSchema([...AGENT_CAPABILITIES], "Capability"),
                "Policy areas to inherit plus optional MCP and delegation capabilities",
                [],
            ),
            cwd: stringSchema("Child working directory; relative paths resolve from the current tool context"),
            timeoutSeconds: numberSchema("Timeout for each child turn", 1, 3_600, DEFAULT_TIMEOUT_SECONDS),
            reasoning_level: enumSchema(
                Object.values(SubagentReasoningLevel),
                "Model capability level; min favors cost and max favors estimated performance",
            ),
            reasoning_amount: enumSchema(
                Object.values(SubagentReasoningAmount),
                "Reasoning effort for the selected model",
            ),
            systemPrompt: stringSchema("Optional additional child instructions", 100_000),
            contextPaths: arraySchema(stringSchema("Suggested context path"), "Suggested context paths"),
        }, ["task", "role", "reasoning_level", "reasoning_amount"]),
        async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as SpawnToolInput;
            const mode = input.mode ?? SubagentRunMode.SYNC;
            const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
            const result = await coordinator().spawn({
                parentAgentIdentifier: ctx.sessionManager.getSessionId(),
                task: input.task,
                role: input.role,
                mode,
                capabilities: input.capabilities ?? [],
                cwd,
                timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
                reasoningLevel: input.reasoning_level,
                reasoningAmount: input.reasoning_amount,
                systemPrompt: input.systemPrompt,
                contextPaths: input.contextPaths?.map((entry) => path.resolve(cwd, entry)),
            }, signal, mode === SubagentRunMode.SYNC && onUpdate
                ? (job) => onUpdate(subagentToolResult([job]))
                : undefined);
            return subagentToolResult([result.job]);
        },
        renderCall: (args, theme, context) => {
            displayRows.observe("subagent_spawn", args, context);
            return presentation.renderCall(
                args as SpawnToolInput,
                theme,
                resolveToolDisplayMode(context.expanded, context.state),
            );
        },
        renderResult: (result, options, theme, context) => presentation.renderResult(
            result,
            theme,
            {isError: context.isError},
            resolveToolDisplayMode(options.expanded, context.state),
        ),
    };
}
