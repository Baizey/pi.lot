import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {PolicyArea, PolicyFallbackResponse} from "../policy/types.js";
import type {PilotSessionRuntimeInterface} from "../runtime/PilotSessionRuntime.js";
import {SandboxingSettings, type SandboxingSetting} from "../tui/SandboxingSettings.js";

const SETTINGS = ["network-inspection", "mmap"] as const;
const NETWORK_MODES = ["on", "off"] as const;
const MMAP_MODES = Object.values(PolicyFallbackResponse);
const USAGE = "Usage: /sandboxing [network-inspection on|off | mmap allow|deny|ask_user|ask_llm]";

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
            description: "Configure network inspection and the writable mmap request policy",
            getArgumentCompletions: (input) => this.completions(input),
            handler: async (input, ctx) => {
                const args = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
                const runtime = this.runtime();
                if (args.length === 0) {
                    await this.showSettings(runtime, ctx);
                    return;
                }
                const [setting, mode] = args;
                if (args.length === 2 && setting === "mmap" && (mode === "on" || mode === "off")) {
                    ctx.ui.notify("Mmap is now requested per Bash call. Set its fallback with /sandboxing mmap allow|deny|ask_user|ask_llm.", "error");
                    return;
                }
                if (args.length !== 2 || !mode
                    || (setting !== "network-inspection" && setting !== "mmap")
                    || !this.modes(setting).includes(mode)) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }
                this.set(runtime, setting, mode, ctx);
            },
        });
    }

    private async showSettings(runtime: PilotSessionRuntimeInterface, ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI || ctx.mode !== "tui") {
            const mmap = runtime.policyRuntime.defaultResponses[PolicyArea.fs_mmap];
            ctx.ui.notify(
                `Sandboxing for this session:\nNetwork inspection = ${runtime.fullNetworkInspection ? "on" : "off"}`
                + `\nWritable mmap requests = ${mmap} (explicit rules take precedence).`
                + "\nChanges affect new Bash calls, including subagents; existing calls are unchanged."
                + " Use /policy-defaults save to persist the mmap default. Network inspection is session-only.",
                mmap === PolicyFallbackResponse.allow || !runtime.fullNetworkInspection ? "warning" : "info",
            );
            return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SandboxingSettings(
            runtime,
            theme,
            (setting, value) => this.set(runtime, setting, value, ctx),
            () => done(),
            () => tui.requestRender(),
        ), {blocked: {kind: "question", message: "Configure sandboxing"}});
    }

    private set(
        runtime: PilotSessionRuntimeInterface,
        setting: SandboxingSetting,
        value: string,
        ctx: ExtensionCommandContext,
    ): void {
        if (setting === "network-inspection") {
            const enabled = value === "on";
            runtime.setFullNetworkInspection(enabled);
            ctx.ui.notify(enabled
                ? "Network inspection is on for new Bash calls; HTTPS method/path policy is enabled. Session only."
                : "Network inspection is off for new Bash calls; HTTPS stays end-to-end and opaque traffic has transport-only policy. Recognized plaintext protocols still receive policy checks. Session only.",
            enabled ? "info" : "warning");
        } else {
            const response = MMAP_MODES.find((mode) => mode === value);
            if (!response) throw new Error("Invalid writable mmap policy default.");
            runtime.policyRuntime.setDefaultResponse(PolicyArea.fs_mmap, response);
            const description = `Writable mmap request default = ${response}. Explicit rules take precedence.`;
            ctx.ui.notify(response === PolicyFallbackResponse.allow
                ? `${description} Mapped writes are not individually revocable and dirty changes can be lost.`
                : description, response === PolicyFallbackResponse.allow ? "warning" : "info");
        }
    }

    private modes(setting: SandboxingSetting): readonly string[] {
        return setting === "mmap" ? MMAP_MODES : NETWORK_MODES;
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const tokens = input.trimStart().toLowerCase().split(/\s+/);
        if (tokens.length > 2) return [];
        const prefix = tokens.at(-1) ?? "";
        const [setting] = tokens;
        if (tokens.length === 2 && setting !== "network-inspection" && setting !== "mmap") return null;
        const options = tokens.length === 2 && (setting === "network-inspection" || setting === "mmap")
            ? this.modes(setting) : SETTINGS;
        const matches = options.filter((option) => option.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((option) => ({
            value: tokens.length === 1 ? option : `${tokens[0]} ${option}`,
            label: option,
        }));
    }
}
