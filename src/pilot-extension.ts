import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PilotSessionRuntime, PilotSessionRuntimeInterface} from "./runtime/PilotSessionRuntime.js";
import {BashTool} from "./tools/builtin/BashTool";
import {EditTool} from "./tools/builtin/EditTool";
import {ReadTool} from "./tools/builtin/ReadTool";
import {WriteTool} from "./tools/builtin/WriteTool";
import {PolicyDefaultsCommand} from "./commands/PolicyDefaultsCommand.js";
import {SubagentDefaultsCommand} from "./commands/SubagentDefaultsCommand.js";
import {NetworkInspectionCommand} from "./commands/NetworkInspectionCommand.js";
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
import {ViewFullToolCommand} from "./commands/ViewFullToolCommand.js";
import {WebSearchTool} from "./tools/web-search/WebSearchTool.js";
import {SubagentUiRuntime} from "./tui/subagent/SubagentUiRuntime.js";
import {ThinkingLevelUiRuntime} from "./tui/ThinkingLevelUiRuntime.js";
import {PilotDocumentation} from "./runtime/PilotDocumentation.js";

export type PilotExtensionOptions = {
    createSessionRuntime?: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    createMcpExtension?: (pi: ExtensionAPI, displayRows: ToolDisplayRows) => McpExtensionInterface;
    subagentModelRanker?: SubagentModelPerformanceRanker;
    subagentDefaultsStore?: SubagentDefaultsStore;
};

// noinspection JSUnusedGlobalSymbols
export default function pilotExtension(pi: ExtensionAPI): void {
    new PilotExtension(pi).register();
}

export class PilotExtension {
    private readonly createSessionRuntime: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    private readonly displayRows = new ToolDisplayRows();
    private readonly documentation = new PilotDocumentation();
    private readonly thinkingLevelUiRuntime = new ThinkingLevelUiRuntime();
    private readonly bashTool: BashTool;
    private readonly webSearchTool: WebSearchTool;
    private readonly readTool: ReadTool;
    private readonly editTool: EditTool;
    private readonly writeTool: WriteTool;
    private readonly mcpExtension: McpExtensionInterface;
    private readonly subagentRuntime: SubagentRuntime;
    private readonly subagentUiRuntime: SubagentUiRuntime;
    private readonly subagentSpawnTool: SubagentSpawnTool;
    private readonly subagentStatusTool: SubagentStatusTool;
    private readonly subagentMessageTool: SubagentMessageTool;
    private readonly subagentStopTool: SubagentStopTool;
    private sessionRuntime: PilotSessionRuntimeInterface | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        options: PilotExtensionOptions = {},
    ) {
        this.createSessionRuntime = options.createSessionRuntime ?? ((ctx) => new PilotSessionRuntime(ctx));
        const runtimeProvider = () => this.requireSessionRuntime();
        this.bashTool = new BashTool(pi, runtimeProvider, this.displayRows);
        this.webSearchTool = new WebSearchTool(pi, runtimeProvider, this.displayRows);
        this.readTool = new ReadTool(pi, runtimeProvider, this.displayRows);
        this.editTool = new EditTool(pi, runtimeProvider, this.displayRows);
        this.writeTool = new WriteTool(pi, runtimeProvider, this.displayRows);
        this.mcpExtension = (
            options.createMcpExtension
            ?? ((extensionApi, displayRows) => new McpExtension(extensionApi, {displayRows}))
        )(pi, this.displayRows);
        const coordinator = () => this.subagentRuntime.coordinator();
        const subagentDefaults = () => this.subagentRuntime.defaults().values;
        this.subagentSpawnTool = new SubagentSpawnTool(pi, coordinator, subagentDefaults, this.displayRows);
        this.subagentStatusTool = new SubagentStatusTool(pi, coordinator, this.displayRows);
        this.subagentMessageTool = new SubagentMessageTool(pi, coordinator, this.displayRows);
        this.subagentStopTool = new SubagentStopTool(pi, coordinator, this.displayRows);
        const toolProviders: SubagentToolProviders = {
            builtins: () => this.builtinToolDefinitions(),
            mcp: () => this.mcpExtension.toolDefinitions(),
            delegate: () => this.subagentToolDefinitions(),
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
        this.bashTool.register();
        this.webSearchTool.register();
        this.readTool.register();
        this.editTool.register();
        this.writeTool.register();
        new PolicyDefaultsCommand(this.pi, runtimeProvider).register();
        new SubagentDefaultsCommand(
            this.pi,
            () => this.subagentRuntime.defaults(),
            () => this.subagentRuntime.availableModels(),
            (level) => this.subagentRuntime.resolveAutomaticModel(level),
        ).register();
        new ViewFullToolCommand(this.pi, this.displayRows).register();
        new NetworkInspectionCommand(this.pi, runtimeProvider).register();
        this.mcpExtension.register();
        this.subagentSpawnTool.register();
        this.subagentStatusTool.register();
        this.subagentMessageTool.register();
        this.subagentStopTool.register();

        this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
        this.pi.on("before_agent_start", (event, ctx) => {
            this.sessionRuntime?.policyRuntime.updatePolicyPrincipalContext(
                ctx.sessionManager.getSessionId(),
                {task: event.prompt},
            );
            return {systemPrompt: this.documentation.appendToSystemPrompt(event.systemPrompt)};
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
        await this.mcpExtension.startSession(ctx);
        await this.subagentRuntime.startSession(ctx, this.requireSessionRuntime().policyRuntime);
        await this.subagentUiRuntime.startSession(ctx, this.subagentRuntime.coordinator());
        this.thinkingLevelUiRuntime.startSession(ctx);
    }

    private async stopOwnedExtensions(): Promise<void> {
        let firstError: unknown;
        try {
            this.thinkingLevelUiRuntime.stopSession();
        } catch (error) {
            firstError = error;
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

    private builtinToolDefinitions() {
        return [
            this.bashTool.toolDefinition(),
            this.webSearchTool.toolDefinition(),
            this.readTool.toolDefinition(),
            this.editTool.toolDefinition(),
            this.writeTool.toolDefinition(),
        ];
    }

    private subagentToolDefinitions() {
        return [
            this.subagentSpawnTool.toolDefinition(),
            this.subagentStatusTool.toolDefinition(),
            this.subagentMessageTool.toolDefinition(),
            this.subagentStopTool.toolDefinition(),
        ];
    }

    private requireSessionRuntime(): PilotSessionRuntimeInterface {
        if (!this.sessionRuntime) throw new Error("pi.lot session runtime is not available");
        return this.sessionRuntime;
    }
}
