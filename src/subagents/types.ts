import type {ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import type {AgentCapability} from "./AgentCapability.js";
import type {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "./SubagentReasoning.js";
import type {SubagentModelPreference} from "./SubagentDefaults.js";

export enum SubagentJobStatus {
    QUEUED = "queued",
    RUNNING = "running",
    IDLE = "idle",
    FAILED = "failed",
    CANCELLED = "cancelled",
    TIMED_OUT = "timed_out",
}

export type SubagentRequest = {
    parentAgentIdentifier: string;
    task: string;
    role: string;
    capabilities: AgentCapability[];
    cwd: string;
    timeoutSeconds: number;
    reasoningSkill: SubagentReasoningSkill;
    reasoningAmount: SubagentReasoningAmount;
    modelPreference: SubagentModelPreference;
    systemPrompt?: string;
    contextPaths?: string[];
};

export type SubagentSessionRequest = SubagentRequest & {
    agentIdentifier: string;
};

export type SubagentJobSnapshot = {
    id: string;
    parentId?: string;
    depth: number;
    createdAt: number;
    status: SubagentJobStatus;
    role: string;
    task: string;
    capabilities: AgentCapability[];
    cwd: string;
    reasoningSkill: SubagentReasoningSkill;
    reasoningAmount: SubagentReasoningAmount;
    resolvedModel?: string;
    resolvedThinkingLevel?: ExtensionContext["thinkingLevel"];
    modelSelectionSource?: string;
    startedAt?: number;
    finishedAt?: number;
    latestLine?: string;
    output?: string;
    error?: string;
    turns: number;
};

export type SubagentJobChange =
    | {kind: "upsert"; job: SubagentJobSnapshot}
    | {kind: "remove"; jobId: string};

export interface SubagentJobMonitor {
    list(jobIds?: string[]): SubagentJobSnapshot[];
    subscribe(listener: (change: SubagentJobChange) => void): () => void;
}

export type SubagentChildUpdate = {
    latestLine: string;
    output?: string;
};

export interface SubagentChildSession {
    readonly modelSelection?: {
        model: string;
        thinkingLevel: ExtensionContext["thinkingLevel"];
        source: string;
    };

    prompt(
        task: string,
        signal: AbortSignal,
        onUpdate?: (update: SubagentChildUpdate) => void,
    ): Promise<string>;

    /** Queue steering for the active prompt; false means the prompt has already settled. */
    steer(task: string): Promise<boolean>;

    abort(): Promise<void>;

    dispose(): void;
}

export interface SubagentChildSessionFactory {
    create(
        request: SubagentSessionRequest,
        tools: ToolDefinition<any, any>[],
        signal: AbortSignal,
    ): Promise<SubagentChildSession>;
}

export type SubagentToolProvider = () => readonly ToolDefinition<any, any>[];
