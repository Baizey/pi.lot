import path from "node:path";
import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator";
import type {SubagentDefaultValues} from "../../subagents/SubagentDefaults.js";
import {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
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
    capabilities?: AgentCapability[];
    cwd?: string;
    timeoutSeconds?: number;
    reasoning_skill: SubagentReasoningSkill;
    reasoning_amount: SubagentReasoningAmount;
    systemPrompt?: string;
    contextPaths?: string[];
};

type CoordinatorProvider = () => SubagentCoordinator;
type DefaultsProvider = () => Readonly<SubagentDefaultValues>;

const SPAWN_PRESENTATION = {
    toolName: "subagent_spawn",
    arguments: [
        {
            key: "role",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "capabilities",
            format: (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "(none)",
        },
        {key: "reasoning_skill", label: "reasoning skill"},
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
        defaults: DefaultsProvider,
        displayRows: ToolDisplayRows,
    ) {
        this.definition = createDefinition(coordinator, defaults, displayRows) as unknown as ToolDefinition<any, any>;
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
    defaults: DefaultsProvider,
    displayRows: ToolDisplayRows,
): ToolDefinition<any, SubagentToolDetails> {
    const presentation = new ToolPresentationRenderer(SPAWN_PRESENTATION);
    return {
        name: "subagent_spawn",
        label: "Spawn subagent",
        description: "Start a retained child-agent conversation with abstract reasoning capabilities and return its job ID immediately. Policy-area capabilities snapshot the parent's matching policy state; MCP and delegation are hard capabilities.",
        promptSnippet: "Delegate independent work to a retained in-process child-agent conversation with explicit reasoning and mechanism capabilities.",
        parameters: objectSchema({
            task: stringSchema("Task to delegate"),
            role: stringSchema("Concise role or title for the child agent", 120),
            capabilities: arraySchema(
                enumSchema([...AGENT_CAPABILITIES], "Capability"),
                "Policy areas to inherit plus optional MCP and delegation capabilities",
                [],
            ),
            cwd: stringSchema("Child working directory; relative paths resolve from the current tool context"),
            timeoutSeconds: numberSchema("Timeout for each child turn", 1, 3_600, DEFAULT_TIMEOUT_SECONDS),
            reasoning_skill: enumSchema(
                Object.values(SubagentReasoningSkill),
                "Model reasoning skill; min favors cost and max favors estimated performance",
            ),
            reasoning_amount: enumSchema(
                Object.values(SubagentReasoningAmount),
                "Reasoning effort for the selected model",
            ),
            systemPrompt: stringSchema("Optional additional child instructions", 100_000),
            contextPaths: arraySchema(stringSchema("Suggested context path"), "Suggested context paths"),
        }, ["task", "role", "reasoning_skill", "reasoning_amount"]),
        prepareArguments(args) {
            if (!args || typeof args !== "object" || Array.isArray(args) || !("mode" in args)) return args;
            const {mode: _legacyMode, ...current} = args as Record<string, unknown>;
            return current;
        },
        async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as SpawnToolInput;
            const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
            const activeCoordinator = coordinator();
            const modelPreference = defaults()[input.reasoning_skill];
            const result = await activeCoordinator.spawn({
                parentAgentIdentifier: ctx.sessionManager.getSessionId(),
                task: input.task,
                role: input.role,
                capabilities: input.capabilities ?? [],
                cwd,
                timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
                reasoningSkill: input.reasoning_skill,
                reasoningAmount: input.reasoning_amount,
                modelPreference,
                systemPrompt: input.systemPrompt,
                contextPaths: input.contextPaths?.map((entry) => path.resolve(cwd, entry)),
            }, signal);
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
