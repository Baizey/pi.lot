import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PilotSessionRuntime, PilotSessionRuntimeInterface} from "./runtime/PilotSessionRuntime.js";
import {BashTool} from "./tools/builtin-bash/BashTool.js";
import {EditTool} from "./tools/builtin-edit/EditTool.js";
import {ReadTool} from "./tools/builtin-read/ReadTool.js";
import {WriteTool} from "./tools/builtin-write/WriteTool.js";
import {TOOL_MINIMAL_KEY_TEXT} from "./tui/tool/ToolDisplayController.js";
import {PolicyDefaultsCommand} from "./commands/PolicyDefaultsCommand.js";
import {NetworkInspectionCommand} from "./commands/NetworkInspectionCommand.js";
import {McpExtension, type McpExtensionInterface} from "./mcp/McpExtension.js";
import {
    type SubagentCapabilities,
    SubagentRuntime,
    type SubagentRuntimeInterface,
} from "./subagents/SubagentRuntime.js";
import {SubagentSpawnTool} from "./tools/subagent-spawn/SubagentSpawnTool.js";
import {SubagentStatusTool} from "./tools/subagent-status/SubagentStatusTool.js";
import {SubagentMessageTool} from "./tools/subagent-message/SubagentMessageTool.js";
import {SubagentStopTool} from "./tools/subagent-stop/SubagentStopTool.js";

export type PilotExtensionOptions = {
    createSessionRuntime?: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    createMcpExtension?: (pi: ExtensionAPI) => McpExtensionInterface;
    createSubagentRuntime?: (capabilities: SubagentCapabilities) => SubagentRuntimeInterface;
};

// noinspection JSUnusedGlobalSymbols
export default function pilotExtension(pi: ExtensionAPI): void {
    new PilotExtension(pi).register();
}

export class PilotExtension {
    private readonly createSessionRuntime: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    private readonly bashTool: BashTool;
    private readonly mcpExtension: McpExtensionInterface;
    private readonly subagentRuntime: SubagentRuntimeInterface;
    private readonly subagentSpawnTool: SubagentSpawnTool;
    private readonly subagentStatusTool: SubagentStatusTool;
    private readonly subagentMessageTool: SubagentMessageTool;
    private readonly subagentStopTool: SubagentStopTool;
    private sessionRuntime: PilotSessionRuntimeInterface | undefined;
    private lastToolDisplay: PilotSessionRuntimeInterface["toolDisplay"] | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        options: PilotExtensionOptions = {},
    ) {
        this.createSessionRuntime = options.createSessionRuntime ?? ((ctx) => new PilotSessionRuntime(ctx));
        const runtimeProvider = () => this.requireSessionRuntime();
        const toolDisplayProvider = () => this.requireToolDisplay();
        this.bashTool = new BashTool(pi, runtimeProvider, toolDisplayProvider);
        this.mcpExtension = (options.createMcpExtension ?? ((extensionApi) => new McpExtension(extensionApi)))(pi);
        const coordinator = () => this.subagentRuntime.coordinator();
        this.subagentSpawnTool = new SubagentSpawnTool(pi, coordinator);
        this.subagentStatusTool = new SubagentStatusTool(pi, coordinator);
        this.subagentMessageTool = new SubagentMessageTool(pi, coordinator);
        this.subagentStopTool = new SubagentStopTool(pi, coordinator);
        const capabilities: SubagentCapabilities = {
            bash: () => [this.bashTool.toolDefinition()],
            mcp: () => this.mcpExtension.toolDefinitions(),
            delegate: () => this.subagentToolDefinitions(),
        };
        this.subagentRuntime = (
            options.createSubagentRuntime
            ?? ((childCapabilities) => new SubagentRuntime(childCapabilities))
        )(capabilities);
    }

    register(): void {
        if (this.registered) throw new Error("pi.lot extension is already registered");
        this.registered = true;

        const runtimeProvider = () => this.requireSessionRuntime();
        const toolDisplayProvider = () => this.requireToolDisplay();
        this.bashTool.register();
        new ReadTool(this.pi, runtimeProvider, toolDisplayProvider).register();
        new EditTool(this.pi, runtimeProvider, toolDisplayProvider).register();
        new WriteTool(this.pi, runtimeProvider, toolDisplayProvider).register();
        new PolicyDefaultsCommand(this.pi, runtimeProvider).register();
        new NetworkInspectionCommand(this.pi, runtimeProvider).register();
        this.mcpExtension.register();
        this.subagentSpawnTool.register();
        this.subagentStatusTool.register();
        this.subagentMessageTool.register();
        this.subagentStopTool.register();

        this.pi.registerShortcut(TOOL_MINIMAL_KEY_TEXT, {
            description: "Toggle minimal tool display",
            handler: () => {
                this.requireSessionRuntime().toolDisplay.toggleMinimal();
            },
        });
        this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
        this.pi.on("session_shutdown", () => this.stopSession());
    }

    private startSession(ctx: ExtensionContext): Promise<void> {
        if (this.sessionRuntime) throw new Error("pi.lot session runtime is already started");

        const runtime = this.createSessionRuntime(ctx);
        this.sessionRuntime = runtime;
        this.lastToolDisplay = runtime.toolDisplay;
        return this.startOwnedExtensions(ctx).catch(async (error) => {
            this.sessionRuntime = undefined;
            await this.stopOwnedExtensions().catch(() => undefined);
            runtime.close();
            throw error;
        });
    }

    private stopSession(): Promise<void> {
        const runtime = this.sessionRuntime;
        // Keep the display controller reachable after teardown because Pi may render stale tool
        // components until it replaces the transcript during /new, /resume, /fork, or /reload.
        return this.stopOwnedExtensions().finally(() => {
            if (this.sessionRuntime === runtime) this.sessionRuntime = undefined;
            runtime?.close();
        });
    }

    private async startOwnedExtensions(ctx: ExtensionContext): Promise<void> {
        await this.mcpExtension.startSession(ctx);
        await this.subagentRuntime.startSession(ctx);
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

    private requireToolDisplay(): PilotSessionRuntimeInterface["toolDisplay"] {
        const toolDisplay = this.sessionRuntime?.toolDisplay ?? this.lastToolDisplay;
        if (!toolDisplay) throw new Error("pi.lot tool display is not available");
        return toolDisplay;
    }
}
