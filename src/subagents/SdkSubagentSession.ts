import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    resolveCliModel,
    SessionManager,
    SettingsManager,
    type ExtensionContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
    SubagentChildSession,
    SubagentChildSessionFactory,
    SubagentChildUpdate,
    SubagentRequest,
} from "./types.js";

const MAX_STREAMED_OUTPUT_CHARS = 50_000;

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class SdkSubagentSessionFactory implements SubagentChildSessionFactory {
    private modelRuntime: Promise<ModelRuntime> | undefined;

    constructor(private readonly rootContext: ExtensionContext) {}

    async create(
        request: SubagentRequest,
        tools: ToolDefinition<any, any>[],
        signal: AbortSignal,
    ): Promise<SubagentChildSession> {
        if (signal.aborted) throw abortError();
        const modelRuntime = await (this.modelRuntime ??= ModelRuntime.create());
        if (signal.aborted) throw abortError();

        const resolved = request.model
            ? resolveCliModel({cliModel: request.model, modelRuntime})
            : {model: this.rootContext.model, thinkingLevel: this.rootContext.thinkingLevel, error: undefined};
        if (resolved.error) throw new Error(resolved.error);
        if (!resolved.model) throw new Error("No model is available for the subagent");

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

        const {session} = await createAgentSession({
            cwd: request.cwd,
            model: resolved.model,
            thinkingLevel: resolved.thinkingLevel ?? request.thinkingLevel ?? this.rootContext.thinkingLevel,
            modelRuntime,
            settingsManager,
            sessionManager: SessionManager.inMemory(request.cwd),
            resourceLoader,
            noTools: "builtin",
            customTools: tools,
        });
        if (signal.aborted) {
            session.dispose();
            throw abortError();
        }
        return new SdkSubagentSession(session);
    }
}

class SdkSubagentSession implements SubagentChildSession {
    constructor(private readonly session: AgentSession) {}

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
        this.session.dispose();
    }
}

function subagentSystemPrompt(request: SubagentRequest): string {
    return [
        "You are a scoped subagent working for a parent coding agent.",
        `Role: ${request.role}`,
        `Run mode: ${request.mode}`,
        `Available toolkits: ${request.toolkits.length > 0 ? request.toolkits.join(", ") : "(none)"}`,
        "Complete the delegated task independently and return a concise, useful result.",
        "Do not claim capabilities that were not provided. Policy-mediated tools may require interactive approval from the user.",
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
