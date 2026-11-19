import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import type {PilotSessionRuntimeInterface} from "../runtime/PilotSessionRuntime.js";
import {SandboxingSettings} from "../tui/SandboxingSettings.js";

const NETWORK_MODES = ["on", "off"] as const;
const NETWORK_SETTING = "network-inspection";
const USAGE = "Usage: /sandboxing [network-inspection on|off]";

export class SandboxingCommand {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtime: () => PilotSessionRuntimeInterface,
    ) {}

    register(): void {
        if (this.registered) throw new Error("Sandboxing command is already registered");
        this.registered = true;
        this.pi.registerCommand("sandboxing", {
            description: "Configure network inspection for this session",
            getArgumentCompletions: (input) => this.completions(input),
            handler: async (input, ctx) => {
                const args = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
                const runtime = this.runtime();
                if (args.length === 0) {
                    await this.showSettings(runtime, ctx);
                    return;
                }
                const [setting, mode] = args;
                if (args.length !== 2 || setting !== NETWORK_SETTING || (mode !== "on" && mode !== "off")) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }
                this.set(runtime, mode === "on", ctx);
            },
        });
    }

    private async showSettings(runtime: PilotSessionRuntimeInterface, ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify(
                `Sandboxing for this session:\nNetwork inspection = ${runtime.fullNetworkInspection ? "on" : "off"}`
                + "\nChanges affect new Bash calls, including subagents; this setting is not saved.",
                runtime.fullNetworkInspection ? "info" : "warning",
            );
            return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SandboxingSettings(
            runtime,
            theme,
            (enabled) => this.set(runtime, enabled, ctx),
            () => done(),
            () => tui.requestRender(),
        ), {blocked: {kind: "question", message: "Configure sandboxing"}});
    }

    private set(runtime: PilotSessionRuntimeInterface, enabled: boolean, ctx: ExtensionCommandContext): void {
        runtime.setFullNetworkInspection(enabled);
        ctx.ui.notify(enabled
            ? "Network inspection is on for new Bash calls; HTTPS method/path policy is enabled. Session only."
            : "Network inspection is off for new Bash calls; HTTPS stays end-to-end and opaque traffic has transport-only policy. Recognized plaintext protocols still receive policy checks. Session only.",
        enabled ? "info" : "warning");
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const tokens = input.trimStart().toLowerCase().split(/\s+/);
        if (tokens.length > 2) return [];
        const prefix = tokens.at(-1) ?? "";
        const [setting] = tokens;
        if (tokens.length === 2 && setting !== NETWORK_SETTING) return null;
        const options = tokens.length === 2 ? NETWORK_MODES : [NETWORK_SETTING];
        const matches = options.filter((option) => option.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((option) => ({
            value: tokens.length === 1 ? option : `${tokens[0]} ${option}`,
            label: option,
        }));
    }
}
