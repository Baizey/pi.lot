import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
    SubagentChildSession,
    SubagentChildSessionFactory,
    SubagentChildUpdate,
    SubagentSessionRequest,
} from "./types.js";
import {
    CatalogueSubagentModelPerformanceRanker,
    type ResolvedSubagentModel,
    SubagentModelResolver,
    type SubagentModelPerformanceRanker,
} from "./SubagentModelResolver.js";
import type {SubagentModelPreference} from "./SubagentDefaults.js";
import type {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "./SubagentReasoning.js";

const MAX_STREAMED_OUTPUT_CHARS = 50_000;

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class SdkSubagentSessionFactory implements SubagentChildSessionFactory {
    private modelRuntime: Promise<ModelRuntime> | undefined;

    constructor(
        private readonly rootContext: ExtensionContext,
        private readonly modelRanker: SubagentModelPerformanceRanker = (
            new CatalogueSubagentModelPerformanceRanker()
        ),
    ) {
    }

    async create(
        request: SubagentSessionRequest,
        tools: ToolDefinition<any, any>[],
        signal: AbortSignal,
    ): Promise<SubagentChildSession> {
        if (signal.aborted) throw abortError();
        const resolved = await this.resolveModel(
            request.reasoningSkill,
            request.reasoningAmount,
            request.modelPreference,
            signal,
        );
        const modelRuntime = await (this.modelRuntime ??= ModelRuntime.create());
        if (signal.aborted) throw abortError();

        const settingsManager = SettingsManager.inMemory();
        const resourceLoader = new DefaultResourceLoader({
            cwd: request.cwd,
            agentDir: getAgentDir(),
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            appendSystemPrompt: [subagentSystemPrompt(request)],
        });
        await resourceLoader.reload();
        if (signal.aborted) throw abortError();

        const sessionManager = SessionManager.inMemory(request.cwd, {id: request.agentIdentifier});
        const {session} = await createAgentSession({
            cwd: request.cwd,
            model: resolved.model,
            thinkingLevel: resolved.thinkingLevel,
            modelRuntime,
            settingsManager,
            sessionManager,
            resourceLoader,
            noTools: "builtin",
            customTools: tools,
        });
        if (signal.aborted) {
            session.dispose();
            throw abortError();
        }
        return new SdkSubagentSession(session, {
            model: `${resolved.model.provider}/${resolved.model.id}`,
            thinkingLevel: resolved.thinkingLevel,
            source: resolved.performanceSource,
        });
    }

    async resolveModel(
        reasoningSkill: SubagentReasoningSkill,
        reasoningAmount: SubagentReasoningAmount,
        modelPreference: SubagentModelPreference,
        signal?: AbortSignal,
    ): Promise<ResolvedSubagentModel> {
        if (signal?.aborted) throw abortError();
        const modelRuntime = await (this.modelRuntime ??= ModelRuntime.create());
        if (signal?.aborted) throw abortError();
        return new SubagentModelResolver(
            modelRuntime,
            this.modelRanker,
            this.rootContext.model?.provider,
        ).resolve(reasoningSkill, reasoningAmount, modelPreference, signal);
    }
}

class SdkSubagentSession implements SubagentChildSession {
    private disposed = false;

    constructor(
        private readonly session: AgentSession,
        readonly modelSelection: NonNullable<SubagentChildSession["modelSelection"]>,
    ) {
    }

    async prompt(
        task: string,
        signal: AbortSignal,
        onUpdate?: (update: SubagentChildUpdate) => void,
    ): Promise<string> {
        let streamedOutput = "";
        let lastOutputUpdate = 0;
        const unsubscribe = this.session.subscribe((event) => {
            if (event.type === "tool_execution_start") {
                onUpdate?.({latestLine: `Using ${event.toolName}`});
                return;
            }
            if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
            streamedOutput = appendBounded(streamedOutput, event.assistantMessageEvent.delta);
            const now = Date.now();
            if (now - lastOutputUpdate >= 100) {
                lastOutputUpdate = now;
                onUpdate?.({latestLine: lastMeaningfulLine(streamedOutput), output: streamedOutput});
            }
        });
        const abort = () => void this.session.abort();
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, {once: true});

        try {
            await this.session.prompt(task);
            const assistant = lastAssistantMessage(this.session.messages);
            if (!assistant) throw new Error("Subagent returned no assistant message");
            const stopReason = stringProperty(assistant, "stopReason");
            const errorMessage = stringProperty(assistant, "errorMessage");
            if (stopReason === "error") throw new Error(errorMessage ?? "Subagent model request failed");
            if (stopReason === "aborted" || signal.aborted) throw abortError(errorMessage);
            const output = assistantText(assistant) || streamedOutput || "(no response was returned)";
            onUpdate?.({latestLine: lastMeaningfulLine(output), output});
            return output;
        } finally {
            signal.removeEventListener("abort", abort);
            unsubscribe();
        }
    }

    abort(): Promise<void> {
        return this.session.abort();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.session.dispose();
    }
}

function subagentSystemPrompt(request: SubagentSessionRequest): string {
    return [
        "You are a scoped subagent working for a parent coding agent.",
        `Role: ${request.role}`,
        `Run mode: ${request.mode}`,
        `Spawn capabilities: ${request.capabilities.length > 0 ? request.capabilities.join(", ") : "(none)"}`,
        `Requested reasoning: ${request.reasoningSkill} skill, ${request.reasoningAmount} amount`,
        "Complete the delegated task independently and return a concise, useful result.",
        "Policy-area capabilities describe inherited policy snapshots, not permanent prohibitions. Missing policies may still be requested when needed.",
        "MCP and delegation are hard capabilities: do not claim or attempt them when they were not provided.",
        request.contextPaths?.length
            ? `Suggested context paths: ${request.contextPaths.join(", ")}`
            : "",
        request.systemPrompt ?? "",
    ].filter(Boolean).join("\n");
}

function lastAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isRecord(message) && message.role === "assistant") return message;
    }
    return undefined;
}

function assistantText(message: Record<string, unknown>): string {
    if (!Array.isArray(message.content)) return "";
    return message.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
        .map((part) => typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
}

function appendBounded(current: string, delta: string): string {
    const combined = current + delta;
    return combined.length <= MAX_STREAMED_OUTPUT_CHARS
        ? combined
        : combined.slice(combined.length - MAX_STREAMED_OUTPUT_CHARS);
}

function lastMeaningfulLine(text: string): string {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = lines.at(-1) ?? "Working";
    return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(message = "Subagent operation was aborted"): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}
