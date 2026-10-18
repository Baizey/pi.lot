import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PilotSessionRuntime, PilotSessionRuntimeInterface} from "./runtime/PilotSessionRuntime.js";
import {BashTool} from "./tools/builtin/BashTool";
import {EditTool} from "./tools/builtin/EditTool";
import {ReadTool} from "./tools/builtin/ReadTool";
import {WriteTool} from "./tools/builtin/WriteTool";
import {PolicyDefaultsCommand} from "./commands/PolicyDefaultsCommand.js";
import {SubagentDefaultsCommand} from "./commands/SubagentDefaultsCommand.js";
import {NetworkInspectionCommand} from "./commands/NetworkInspectionCommand.js";
import {ServerCommand} from "./commands/ServerCommand.js";
import {recordMainSessionIdentity} from "./sessions/SessionIdentity.js";
import {McpExtension, type McpExtensionInterface} from "./mcp/McpExtension.js";
import {SubagentRuntime} from "./subagents/SubagentRuntime.js";
import type {SubagentToolProviders} from "./subagents/SubagentToolCatalog.js";
import type {SubagentModelPerformanceRanker} from "./subagents/SubagentModelResolver.js";
import type {SubagentDefaultsStore} from "./subagents/SubagentDefaults.js";
import {SubagentSpawnTool} from "./tools/subagent/SubagentSpawnTool";
import {SubagentStatusTool} from "./tools/subagent/SubagentStatusTool";
import {SubagentMessageTool} from "./tools/subagent/SubagentMessageTool";
import {SubagentStopTool} from "./tools/subagent/SubagentStopTool";
import {ToolDisplayRows} from "./tui/tool/ToolDisplayRows.js";
import type {ToolDisplayViews} from "./tui/tool/ToolDisplayMode.js";
import {TranscriptDisplayRuntime} from "./tui/TranscriptDisplayRuntime.js";
import {WebSearchTool} from "./tools/web-search/WebSearchTool.js";
import {ArchiveTools} from "./tools/server/ArchiveTools.js";
import {SubagentUiRuntime} from "./tui/subagent/SubagentUiRuntime.js";
import {ThinkingLevelUiRuntime} from "./tui/ThinkingLevelUiRuntime.js";
import {PilotDocumentation} from "./runtime/PilotDocumentation.js";
import {CodemodeExtension} from "./tools/codemode/CodemodeExtension.js";

export type PilotExtensionOptions = {
    createSessionRuntime?: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    createMcpExtension?: (pi: ExtensionAPI, displayRows: ToolDisplayRows) => McpExtensionInterface;
    subagentModelRanker?: SubagentModelPerformanceRanker;
    subagentDefaultsStore?: SubagentDefaultsStore;
    toolDisplayViews?: ToolDisplayViews;
};

// noinspection JSUnusedGlobalSymbols
export default function pilotExtension(pi: ExtensionAPI): void {
    new PilotExtension(pi).register();
}

export class PilotExtension {
    private readonly createSessionRuntime: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    private readonly displayRows = new ToolDisplayRows();
    private readonly documentation = new PilotDocumentation();
    private readonly transcriptDisplayRuntime: TranscriptDisplayRuntime;
    private readonly thinkingLevelUiRuntime: ThinkingLevelUiRuntime;
    private readonly builtinTools: readonly (BashTool | WebSearchTool | ReadTool | EditTool | WriteTool)[];
    private readonly archiveTools: ArchiveTools;
    private readonly mcpExtension: McpExtensionInterface;
    private readonly subagentRuntime: SubagentRuntime;
    private readonly subagentUiRuntime: SubagentUiRuntime;
    private readonly subagentTools: readonly (
        SubagentSpawnTool | SubagentStatusTool | SubagentMessageTool | SubagentStopTool
    )[];
    private sessionRuntime: PilotSessionRuntimeInterface | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        options: PilotExtensionOptions = {},
    ) {
        this.createSessionRuntime = options.createSessionRuntime ?? ((ctx) => new PilotSessionRuntime(ctx));
        if (options.toolDisplayViews) {
            this.displayRows.modes.setViews(options.toolDisplayViews.primary, options.toolDisplayViews.alternate);
        }
        this.transcriptDisplayRuntime = new TranscriptDisplayRuntime(pi, this.displayRows.modes);
        this.thinkingLevelUiRuntime = new ThinkingLevelUiRuntime((tui) => this.transcriptDisplayRuntime.attach(tui));
        const runtimeProvider = () => this.requireSessionRuntime();
        this.builtinTools = [
            new BashTool(pi, runtimeProvider, this.displayRows),
            new WebSearchTool(pi, runtimeProvider, this.displayRows),
            new ReadTool(pi, runtimeProvider, this.displayRows),
            new EditTool(pi, runtimeProvider, this.displayRows),
            new WriteTool(pi, runtimeProvider, this.displayRows),
        ];
        this.archiveTools = new ArchiveTools(pi, runtimeProvider, this.displayRows);
        this.mcpExtension = (
            options.createMcpExtension
            ?? ((extensionApi, displayRows) => new McpExtension(extensionApi, {displayRows}))
        )(pi, this.displayRows);
        const coordinator = () => this.subagentRuntime.coordinator();
        const subagentDefaults = () => this.subagentRuntime.defaults().values;
        this.subagentTools = [
            new SubagentSpawnTool(pi, coordinator, subagentDefaults, this.displayRows),
            new SubagentStatusTool(pi, coordinator, this.displayRows),
            new SubagentMessageTool(pi, coordinator, this.displayRows),
            new SubagentStopTool(pi, coordinator, this.displayRows),
        ];
        const toolProviders: SubagentToolProviders = {
            builtins: () => this.builtinTools.map((tool) => tool.toolDefinition()),
            mcp: () => this.mcpExtension.toolDefinitions(),
            delegate: () => this.subagentTools.map((tool) => tool.toolDefinition()),
        };
        this.subagentRuntime = new SubagentRuntime(toolProviders, {
            modelRanker: options.subagentModelRanker,
            defaultsStore: options.subagentDefaultsStore,
        });
        this.subagentUiRuntime = new SubagentUiRuntime();
    }

    register(): void {
        if (this.registered) throw new Error("pi.lot extension is already registered");
        this.registered = true;

        const runtimeProvider = () => this.requireSessionRuntime();
        this.transcriptDisplayRuntime.register();
        for (const tool of this.builtinTools) tool.register();
        new PolicyDefaultsCommand(this.pi, runtimeProvider).register();
        new SubagentDefaultsCommand(
            this.pi,
            () => this.subagentRuntime.defaults(),
            () => this.subagentRuntime.availableModels(),
            (level) => this.subagentRuntime.resolveAutomaticModel(level),
        ).register();
        new NetworkInspectionCommand(this.pi, runtimeProvider).register();
        new ServerCommand(this.pi).register();
        this.archiveTools.register();
        new CodemodeExtension(this.pi, this.displayRows).register();
        this.mcpExtension.register();
        for (const tool of this.subagentTools) tool.register();

        this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
        this.pi.on("before_agent_start", (event, ctx) => {
            if (event.messageType === "user") {
                this.sessionRuntime?.policyRuntime.updatePolicyPrincipalContext(
                    ctx.sessionManager.getSessionId(),
                    {task: event.prompt},
                );
            }
            event.systemPromptOptions.sections.pilot_docs = this.documentation.routingPrompt();
        });
        this.pi.on("thinking_level_select", () => this.thinkingLevelUiRuntime.update());
        this.pi.on("model_select", () => this.thinkingLevelUiRuntime.update());
        this.pi.on("session_compact", () => this.displayRows.clear());
        this.pi.on("session_tree", () => this.displayRows.clear());
        this.pi.on("session_shutdown", () => this.stopSession());
    }

    private startSession(ctx: ExtensionContext): Promise<void> {
        if (this.sessionRuntime) throw new Error("pi.lot session runtime is already started");

        const runtime = this.createSessionRuntime(ctx);
        this.sessionRuntime = runtime;
        return Promise.resolve(runtime.start?.()).then(() => this.startOwnedExtensions(ctx)).catch(async (error) => {
            this.sessionRuntime = undefined;
            await this.stopOwnedExtensions().catch(() => undefined);
            this.displayRows.clear();
            await runtime.close();
            throw error;
        });
    }

    private stopSession(): Promise<void> {
        const runtime = this.sessionRuntime;
        runtime?.beginShutdown();
        return this.stopOwnedExtensions().finally(async () => {
            if (this.sessionRuntime === runtime) this.sessionRuntime = undefined;
            this.displayRows.clear();
            await runtime?.close();
        });
    }

    private async startOwnedExtensions(ctx: ExtensionContext): Promise<void> {
        recordMainSessionIdentity(this.pi, ctx.sessionManager);
        await this.mcpExtension.startSession(ctx);
        await this.subagentRuntime.startSession(ctx, this.requireSessionRuntime().policyRuntime);
        await this.subagentUiRuntime.startSession(ctx, this.subagentRuntime.coordinator());
        this.transcriptDisplayRuntime.startSession(ctx);
        this.thinkingLevelUiRuntime.startSession(ctx);
    }

    private async stopOwnedExtensions(): Promise<void> {
        let firstError: unknown;
        try {
            this.transcriptDisplayRuntime.stopSession();
        } catch (error) {
            firstError = error;
        }
        try {
            this.thinkingLevelUiRuntime.stopSession();
        } catch (error) {
            firstError ??= error;
        }
        try {
            await this.subagentUiRuntime.stopSession();
        } catch (error) {
            firstError ??= error;
        }
        try {
            await this.subagentRuntime.stopSession();
        } catch (error) {
            firstError ??= error;
        }
        try {
            await this.mcpExtension.stopSession();
        } catch (error) {
            firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
    }

    private requireSessionRuntime(): PilotSessionRuntimeInterface {
        if (!this.sessionRuntime) throw new Error("pi.lot session runtime is not available");
        return this.sessionRuntime;
    }
}
