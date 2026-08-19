import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PilotSessionRuntime, PilotSessionRuntimeInterface} from "./runtime/PilotSessionRuntime.js";
import {BashTool} from "./tools/bash/BashTool.js";
import {EditTool} from "./tools/edit/EditTool.js";
import {ReadTool} from "./tools/read/ReadTool.js";
import {WriteTool} from "./tools/write/WriteTool.js";
import {TOOL_MINIMAL_KEY_TEXT} from "./tui/tool/ToolDisplayController.js";
import {PolicyDefaultsCommand} from "./commands/PolicyDefaultsCommand.js";
import {NetworkInspectionCommand} from "./commands/NetworkInspectionCommand.js";
import {McpExtension, type McpExtensionInterface} from "./mcp/McpExtension.js";

export type PilotExtensionOptions = {
    createSessionRuntime?: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    createMcpExtension?: (pi: ExtensionAPI) => McpExtensionInterface;
};

export default function pilotExtension(pi: ExtensionAPI): void {
    new PilotExtension(pi).register();
}

export class PilotExtension {
    private readonly createSessionRuntime: (ctx: ExtensionContext) => PilotSessionRuntimeInterface;
    private readonly mcpExtension: McpExtensionInterface;
    private sessionRuntime: PilotSessionRuntimeInterface | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        options: PilotExtensionOptions = {},
    ) {
        this.createSessionRuntime = options.createSessionRuntime ?? ((ctx) => new PilotSessionRuntime(ctx));
        this.mcpExtension = (options.createMcpExtension ?? ((extensionApi) => new McpExtension(extensionApi)))(pi);
    }

    register(): void {
        if (this.registered) throw new Error("pi.lot extension is already registered");
        this.registered = true;

        const runtimeProvider = () => this.requireSessionRuntime();
        new BashTool(this.pi, runtimeProvider).register();
        new ReadTool(this.pi, runtimeProvider).register();
        new EditTool(this.pi, runtimeProvider).register();
        new WriteTool(this.pi, runtimeProvider).register();
        new PolicyDefaultsCommand(this.pi, runtimeProvider).register();
        new NetworkInspectionCommand(this.pi, runtimeProvider).register();
        this.mcpExtension.register();

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
        return this.mcpExtension.startSession(ctx).catch((error) => {
            this.sessionRuntime = undefined;
            runtime.close();
            throw error;
        });
    }

    private stopSession(): Promise<void> {
        const runtime = this.sessionRuntime;
        // Existing tool components may render while asynchronous shutdown cleanup is in flight.
        return this.mcpExtension.stopSession().finally(() => {
            if (this.sessionRuntime === runtime) this.sessionRuntime = undefined;
            runtime?.close();
        });
    }

    private requireSessionRuntime(): PilotSessionRuntimeInterface {
        if (!this.sessionRuntime) throw new Error("pi.lot session runtime is not available");
        return this.sessionRuntime;
    }
}
