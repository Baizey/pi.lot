import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PilotSessionRuntime, PilotSessionRuntimeInterface} from "./runtime/PilotSessionRuntime.js";
import {BashTool} from "./tools/builtin/BashTool";
import {EditTool} from "./tools/builtin/EditTool";
import {ReadTool} from "./tools/builtin/ReadTool";
import {WriteTool} from "./tools/builtin/WriteTool";
import {PolicyDefaultsCommand} from "./commands/PolicyDefaultsCommand.js";
import {NetworkInspectionCommand} from "./commands/NetworkInspectionCommand.js";
import {McpExtension, type McpExtensionInterface} from "./mcp/McpExtension.js";
import {SubagentRuntime} from "./subagents/SubagentRuntime.js";
import type {SubagentToolProviders} from "./subagents/SubagentToolCatalog.js";
import type {SubagentModelPerformanceRanker} from "./subagents/SubagentModelResolver.js";
import {SubagentSpawnTool} from "./tools/subagent/SubagentSpawnTool";
import {SubagentStatusTool} from "./tools/subagent/SubagentStatusTool";
import {SubagentMessageTool} from "./tools/subagent/SubagentMessageTool";
import {SubagentStopTool} from "./tools/subagent/SubagentStopTool";
import {ToolDisplayRows} from "./tui/tool/ToolDisplayRows.js";
import {ViewFullToolCommand} from "./commands/ViewFullToolCommand.js";
import {WebSearchTool} from "./tools/web-search/WebSearchTool.js";

export type PilotExtensionOptions = {
    createSessionRuntime?: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    createMcpExtension?: (pi: ExtensionAPI, displayRows: ToolDisplayRows) => McpExtensionInterface;
    subagentModelRanker?: SubagentModelPerformanceRanker;
};

// noinspection JSUnusedGlobalSymbols
export default function pilotExtension(pi: ExtensionAPI): void {
    new PilotExtension(pi).register();
}

export class PilotExtension {
    private readonly createSessionRuntime: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    private readonly displayRows = new ToolDisplayRows();
    private readonly bashTool: BashTool;
    private readonly webSearchTool: WebSearchTool;
    private readonly readTool: ReadTool;
    private readonly editTool: EditTool;
    private readonly writeTool: WriteTool;
    private readonly mcpExtension: McpExtensionInterface;
    private readonly subagentRuntime: SubagentRuntime;
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
        this.subagentSpawnTool = new SubagentSpawnTool(pi, coordinator, this.displayRows);
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
        });
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
        new ViewFullToolCommand(this.pi, this.displayRows).register();
        new NetworkInspectionCommand(this.pi, runtimeProvider).register();
        this.mcpExtension.register();
        this.subagentSpawnTool.register();
        this.subagentStatusTool.register();
        this.subagentMessageTool.register();
        this.subagentStopTool.register();

        this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
        this.pi.on("session_compact", () => this.displayRows.clear());
        this.pi.on("session_tree", () => this.displayRows.clear());
        this.pi.on("session_shutdown", () => this.stopSession());
    }

    private startSession(ctx: ExtensionContext): Promise<void> {
        if (this.sessionRuntime) throw new Error("pi.lot session runtime is already started");

        const runtime = this.createSessionRuntime(ctx);
        this.sessionRuntime = runtime;
        return this.startOwnedExtensions(ctx).catch(async (error) => {
            this.sessionRuntime = undefined;
            await this.stopOwnedExtensions().catch(() => undefined);
            this.displayRows.clear();
            runtime.close();
            throw error;
        });
    }

    private stopSession(): Promise<void> {
        const runtime = this.sessionRuntime;
        return this.stopOwnedExtensions().finally(() => {
            if (this.sessionRuntime === runtime) this.sessionRuntime = undefined;
            this.displayRows.clear();
            runtime?.close();
        });
    }

    private async startOwnedExtensions(ctx: ExtensionContext): Promise<void> {
        await this.mcpExtension.startSession(ctx);
        await this.subagentRuntime.startSession(ctx, this.requireSessionRuntime().policyRuntime);
    }

    private async stopOwnedExtensions(): Promise<void> {
        let firstError: unknown;
        try {
            await this.subagentRuntime.stopSession();
        } catch (error) {
            firstError = error;
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
