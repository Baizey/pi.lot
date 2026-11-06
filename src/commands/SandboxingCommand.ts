import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import type {PilotSessionRuntimeInterface} from "../runtime/PilotSessionRuntime.js";
import {SandboxingSettings, type SandboxingSetting} from "../tui/SandboxingSettings.js";

const SETTINGS = ["network-inspection", "mmap"] as const;
const MODES = ["on", "off"] as const;
const USAGE = "Usage: /sandboxing [network-inspection|mmap on|off]";

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
            description: "Configure network inspection and writable mmap for this session only",
            getArgumentCompletions: (input) => this.completions(input),
            handler: async (input, ctx) => {
                const args = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
                const runtime = this.runtime();
                if (args.length === 0) {
                    await this.showSettings(runtime, ctx);
                    return;
                }
                const [setting, mode] = args;
                if (args.length !== 2 || !SETTINGS.some((value) => value === setting)
                    || !MODES.some((value) => value === mode)) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }
                // Validation above narrows the user-controlled setting at this boundary.
                this.set(runtime, setting as SandboxingSetting, mode === "on", ctx);
            },
        });
    }

    private async showSettings(runtime: PilotSessionRuntimeInterface, ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify(
                `Sandboxing for this session:\nNetwork inspection = ${runtime.fullNetworkInspection ? "on" : "off"}`
                + `\nWritable mmap = ${runtime.writableMmap ? "on" : "off"}`
                + "\nChanges affect new Bash calls, including subagents; existing calls are unchanged."
                + " Settings are never saved. Use /sandboxing <network-inspection|mmap> <on|off> to change them.",
                runtime.writableMmap || !runtime.fullNetworkInspection ? "warning" : "info",
            );
            return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SandboxingSettings(
            runtime,
            theme,
            (setting, enabled) => this.set(runtime, setting, enabled, ctx),
            () => done(),
            () => tui.requestRender(),
        ), {blocked: {kind: "question", message: "Configure sandboxing"}});
    }

    private set(
        runtime: PilotSessionRuntimeInterface,
        setting: SandboxingSetting,
        enabled: boolean,
        ctx: ExtensionCommandContext,
    ): void {
        if (setting === "network-inspection") {
            runtime.setFullNetworkInspection(enabled);
            ctx.ui.notify(enabled
                ? "Network inspection is on for new Bash calls; HTTPS method/path policy is enabled. Session only."
                : "Network inspection is off for new Bash calls; HTTPS stays end-to-end and opaque traffic has transport-only policy. Recognized plaintext protocols still receive policy checks. Session only.",
            enabled ? "info" : "warning");
        } else {
            runtime.setWritableMmap(enabled);
            ctx.ui.notify(enabled
                ? "Writable mmap compatibility is on for new Bash calls. Cached write-through I/O still checks opens and backing I/O, but memory stores are not individually checked or revocable. Revocation or cancellation can lose dirty changes; writeback errors may be delayed. Host/cross-call SQLite WAL remains unsupported. Session only."
                : "Writable mmap compatibility is off for new Bash calls; writable handles use direct I/O. Existing calls and mappings are unchanged. Session only.",
            enabled ? "warning" : "info");
        }
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const tokens = input.trimStart().toLowerCase().split(/\s+/);
        if (tokens.length > 2) return [];
        const prefix = tokens.at(-1) ?? "";
        if (tokens.length === 2 && !SETTINGS.some((setting) => setting === tokens[0])) return null;
        const options = tokens.length === 1 ? SETTINGS : MODES;
        const matches = options.filter((option) => option.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((option) => ({
            value: tokens.length === 1 ? option : `${tokens[0]} ${option}`,
            label: option,
        }));
    }
}
