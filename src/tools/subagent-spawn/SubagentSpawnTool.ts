import path from "node:path";
import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator.js";
import {
    SubagentRunMode,
    SubagentToolkit,
} from "../../subagents/types.js";
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

const DEFAULT_TIMEOUT_SECONDS = 900;

type SpawnToolInput = {
    task: string;
    role: string;
    mode?: SubagentRunMode;
    toolkits?: SubagentToolkit[];
    cwd?: string;
    timeoutSeconds?: number;
    model?: string;
    systemPrompt?: string;
    contextPaths?: string[];
};

type CoordinatorProvider = () => SubagentCoordinator;

export class SubagentSpawnTool {
    private readonly definition: ToolDefinition<any, any>;
    private registered = false;

    constructor(
        private readonly pi: Pick<ExtensionAPI, "registerTool">,
        coordinator: CoordinatorProvider,
    ) {
        this.definition = createDefinition(coordinator) as unknown as ToolDefinition<any, any>;
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

function createDefinition(coordinator: CoordinatorProvider): ToolDefinition<any, SubagentToolDetails> {
    return {
        name: "subagent_spawn",
        label: "Spawn subagent",
        description: "Start a scoped child agent. Sync waits for its result; async and conversation return a job id immediately.",
        promptSnippet: "Delegate independent work to an in-process child agent with explicit toolkits.",
        parameters: objectSchema({
            task: stringSchema("Task to delegate"),
            role: stringSchema("Concise role or title for the child agent", 120),
            mode: enumSchema(Object.values(SubagentRunMode), "Run mode", SubagentRunMode.SYNC),
            toolkits: arraySchema(enumSchema(Object.values(SubagentToolkit), "Toolkit"), "Explicit capabilities", []),
            cwd: stringSchema("Child working directory; relative paths resolve from the current tool context"),
            timeoutSeconds: numberSchema("Timeout for each child turn", 1, 3_600, DEFAULT_TIMEOUT_SECONDS),
            model: stringSchema("Optional provider/model selection"),
            systemPrompt: stringSchema("Optional additional child instructions", 100_000),
            contextPaths: arraySchema(stringSchema("Suggested context path"), "Suggested context paths"),
        }, ["task", "role"]),
        async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as SpawnToolInput;
            const mode = input.mode ?? SubagentRunMode.SYNC;
            const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
            const result = await coordinator().spawn({
                task: input.task,
                role: input.role,
                mode,
                toolkits: input.toolkits ?? [],
                cwd,
                timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
                model: input.model ?? canonicalModel(ctx.model),
                thinkingLevel: ctx.thinkingLevel,
                systemPrompt: input.systemPrompt,
                contextPaths: input.contextPaths?.map((entry) => path.resolve(cwd, entry)),
            }, signal, mode === SubagentRunMode.SYNC && onUpdate
                ? (job) => onUpdate(subagentToolResult([job]))
                : undefined);
            return subagentToolResult([result.job]);
        },
    };
}

function canonicalModel(model: {provider: string; id: string} | undefined): string | undefined {
    return model ? `${model.provider}/${model.id}` : undefined;
}
