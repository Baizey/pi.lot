import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {FuseBashTool} from "./fuse/FuseBashTool.js";
import {PilotSessionRuntime} from "./runtime/PilotSessionRuntime.js";

export type PilotSessionRuntimeHandle = Pick<
    PilotSessionRuntime,
    "pathPolicy" | "decisionFlows" | "close"
>;

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

        new FuseBashTool(this.pi, {current: () => this.requireSessionRuntime()}).register();
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
