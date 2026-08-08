import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PilotSessionRuntime} from "./runtime/PilotSessionRuntime.js";
import type {PilotSessionRuntimeHandle} from "./runtime/PilotSessionRuntime.js";
import {BashTool} from "./tools/bash/BashTool.js";
import {EditTool} from "./tools/edit/EditTool.js";
import {ReadTool} from "./tools/read/ReadTool.js";
import {WriteTool} from "./tools/write/WriteTool.js";
import {TOOL_MINIMAL_KEY_TEXT} from "./tui/tool/ToolDisplayController.js";
import {registerExperiments} from "./experiment/registerExperiments.js";
import {PolicyDefaultsCommand} from "./commands/PolicyDefaultsCommand.js";

export type PilotExtensionOptions = {
    createSessionRuntime?: (ctx: ExtensionContext) => PilotSessionRuntimeHandle;
};

export default function pilotExtension(pi: ExtensionAPI): void {
    new PilotExtension(pi).register();
}

export class PilotExtension {
    private readonly createSessionRuntime: (ctx: ExtensionContext) => PilotSessionRuntimeHandle;
    private sessionRuntime: PilotSessionRuntimeHandle | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        options: PilotExtensionOptions = {},
    ) {
        this.createSessionRuntime = options.createSessionRuntime ?? ((ctx) => new PilotSessionRuntime(ctx));
    }

    register(): void {
        if (this.registered) throw new Error("pi.lot extension is already registered");
        this.registered = true;

        const runtimeProvider = () => this.requireSessionRuntime();
        new BashTool(this.pi, runtimeProvider).register();
        new ReadTool(this.pi, runtimeProvider).register();
        new EditTool(this.pi, runtimeProvider).register();
        new WriteTool(this.pi, runtimeProvider).register();
        new PolicyDefaultsCommand(this.pi, () => runtimeProvider().policyRuntime).register();

        registerExperiments(this.pi, () => {
            runtimeProvider();
        });

        this.pi.registerShortcut(TOOL_MINIMAL_KEY_TEXT, {
            description: "Toggle minimal tool display",
            handler: () => {
                this.requireSessionRuntime().toolDisplay.toggleMinimal();
            },
        });
        this.pi.on("session_start", (_event, ctx) => this.startSession(ctx));
        this.pi.on("session_shutdown", () => this.stopSession());
    }

    private startSession(ctx: ExtensionContext): void {
        if (this.sessionRuntime) throw new Error("pi.lot session runtime is already started");

        this.sessionRuntime = this.createSessionRuntime(ctx);
    }

    private stopSession(): void {
        const runtime = this.sessionRuntime;
        this.sessionRuntime = undefined;
        runtime?.close();
    }

    private requireSessionRuntime(): PilotSessionRuntimeHandle {
        if (!this.sessionRuntime) throw new Error("pi.lot session runtime is not available");
        return this.sessionRuntime;
    }
}
