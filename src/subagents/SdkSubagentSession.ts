import path from "node:path";
import {
    createAgentSession,
    createCodemodeExtension,
    createToolSearchExtension,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionContext,
    type InlineExtension,
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
import {AgentMechanismCapability} from "./AgentCapability.js";
import type {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "./SubagentReasoning.js";

const MAX_STREAMED_OUTPUT_CHARS = 50_000;

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class SdkSubagentSessionFactory implements SubagentChildSessionFactory {
    private modelRuntime: Promise<ModelRuntime> | undefined;
    private readonly sessionFiles = new Map<string, string>();

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
        if (!request.capabilities.includes(AgentMechanismCapability.mcp) && tools.some(isMcpTool)) {
            throw new Error("MCP tools require the subagent mcp capability");
        }
        const resolved = await this.resolveModel(
            request.reasoningSkill,
            request.reasoningAmount,
            request.modelPreference,
            signal,
        );
        const modelRuntime = await (this.modelRuntime ??= ModelRuntime.create());
        if (signal.aborted) throw abortError();

        const settingsManager = SettingsManager.inMemory();
        const resourceLoader = await createSubagentResourceLoader(request, getAgentDir(), settingsManager, tools);
        if (signal.aborted) throw abortError();

        const sessionManager = this.createSessionManager(request);
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
        try {
            if (signal.aborted) throw abortError();
            if (resourceLoader.getExtensions().extensions.length > 0) await session.bindExtensions({});
            if (signal.aborted) throw abortError();
        } catch (error) {
            try {
                session.dispose();
            } catch (disposeError) {
                throw new Error(
                    `Failed to dispose subagent session ${request.agentIdentifier}: ${errorMessage(disposeError)}`,
                    {cause: error},
                );
            }
            throw error;
        }
        const sessionFile = sessionManager.getSessionFile();
        if (sessionFile) this.sessionFiles.set(request.agentIdentifier, sessionFile);
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

    private createSessionManager(request: SubagentSessionRequest): SessionManager {
        const root = this.rootContext.sessionManager;
        const rootFile = root.getSessionFile();
        let sessionManager: SessionManager;
        if (rootFile) {
            const parentSession = request.parentAgentIdentifier === root.getSessionId()
                ? path.resolve(rootFile)
                : this.sessionFiles.get(request.parentAgentIdentifier);
            if (!parentSession) {
                throw new Error(`Parent subagent session is unavailable: ${request.parentAgentIdentifier}`);
            }
            // Use the root's resolved directory, including --session-dir or custom storage.
            sessionManager = SessionManager.create(request.cwd, path.resolve(root.getSessionDir()), {
                id: request.agentIdentifier,
                parentSession,
            });
        } else {
            sessionManager = SessionManager.inMemory(request.cwd, {id: request.agentIdentifier});
        }
        sessionManager.appendSessionInfo(`Subagent: ${request.role}`);
        sessionManager.appendCustomEntry("pilot.subagent", {
            parentAgentIdentifier: request.parentAgentIdentifier,
        });
        return sessionManager;
    }
}

/**
 * Creates the deliberately isolated resource loader used by SDK child sessions.
 *
 * Child instructions are supplied solely by `subagentSystemPrompt`; project and
 * agent-dir context/system files must never affect delegated work.
 */
export async function createSubagentResourceLoader(
    request: SubagentSessionRequest,
    agentDir = getAgentDir(),
    settingsManager = SettingsManager.inMemory(),
    tools: readonly ToolDefinition<any, any>[] = [],
): Promise<DefaultResourceLoader> {
    const extensionFactories: InlineExtension[] = [];
    if (request.capabilities.includes(AgentMechanismCapability.mcp)) {
        // Pi registers default MCP codemode tools as deferred so their declarations
        // stay out of codemode. Either helper can reach the same granted tool snapshot.
        const codemode = tools.some((tool) => tool.exposure === "codemode" || tool.exposure === "deferred");
        const toolSearch = tools.some((tool) => tool.exposure === "deferred");
        if (codemode) extensionFactories.push(createCodemodeExtension({mode: "on", models: false}));
        if (toolSearch) extensionFactories.push(createToolSearchExtension());
        if (codemode || toolSearch) {
            const namespaceSection = subagentMcpServersSection(tools);
            extensionFactories.push((pi) => {
                pi.on("session_start", () => {
                    pi.setActiveTools([
                        ...pi.getActiveTools(),
                        ...(codemode ? ["codemode"] : []),
                        ...(toolSearch ? ["tool_search"] : []),
                    ]);
                });
                pi.on("before_agent_start", (event) => {
                    if (namespaceSection) event.systemPromptOptions.sections.mcp_servers = namespaceSection;
                });
            });
        }
    }
    const resourceLoader = new DefaultResourceLoader({
        extensionFactories,
        cwd: request.cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // An explicit empty source prevents DefaultResourceLoader from discovering SYSTEM.md.
        systemPrompt: "",
        appendSystemPrompt: [subagentSystemPrompt(request)],
    });
    await resourceLoader.reload();
    return resourceLoader;
}

export class SdkSubagentSession implements SubagentChildSession {
    private disposed = false;
    private promptStarting = false;
    private abortPromise: Promise<void> | undefined;

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
        if (this.disposed) throw new Error("Subagent session is disposed");
        if (signal.aborted) throw abortError();
        this.promptStarting = true;
        let streamedOutput = "";
        let lastOutputUpdate = 0;
        const unsubscribe = this.session.subscribe((event) => {
            if (event.type === "agent_start") {
                this.promptStarting = false;
                return;
            }
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
        const abort = () => {
            void this.abort().catch(() => undefined);
        };
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
            this.promptStarting = false;
            signal.removeEventListener("abort", abort);
            unsubscribe();
        }
    }

    async steer(task: string): Promise<boolean> {
        if (this.disposed) return false;
        if (!this.promptStarting && !this.session.isStreaming) return false;
        await this.session.steer(task);
        return true;
    }

    abort(): Promise<void> {
        return this.abortPromise ??= Promise.resolve().then(() => this.session.abort());
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.session.dispose();
    }
}

function isMcpTool(tool: ToolDefinition<any, any>): boolean {
    return tool.name.startsWith("mcp__")
        || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(tool.name)
        || tool.exposure === "codemode"
        || tool.exposure === "deferred";
}

/** Discovery hints come only from the immutable granted snapshot, never the root's live catalog. */
function subagentMcpServersSection(tools: readonly ToolDefinition<any, any>[]): string | undefined {
    const namespaces = new Map<string, NonNullable<ToolDefinition["namespace"]>>();
    for (const tool of tools) {
        if ((tool.exposure === "codemode" || tool.exposure === "deferred") && tool.namespace) {
            namespaces.set(tool.namespace.name, tool.namespace);
        }
    }
    if (namespaces.size === 0) return undefined;
    const lines = [
        "MCP servers in your granted tool snapshot. Find tools with searchTools(query, { namespace }) or tool_search; "
        + "read instructions and tool names with describeNamespace(name).",
    ];
    const ordered = [...namespaces.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const [index, namespace] of ordered.entries()) {
        const summary = (namespace.description?.trim() || namespace.instructions || "").split("\n", 1)[0]!.trim();
        const line = `- ${namespace.name} (codemode or tool_search)${summary ? `: ${summary.slice(0, 250)}` : ""}`;
        // Reserve room for the omission notice; match Pi's 4096-character section budget.
        if (lines.join("\n").length + line.length + 100 > 4096) {
            lines.push(`- … ${ordered.length - index} more servers; find their tools with searchTools()`);
            break;
        }
        lines.push(line);
    }
    return lines.join("\n");
}

function subagentSystemPrompt(request: SubagentSessionRequest): string {
    return [
        "You are a scoped subagent working for a parent coding agent.",
        `Role: ${request.role}`,
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function abortError(message = "Subagent operation was aborted"): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}
