import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {DisplayDefaultsRuntime} from "../tui/tool/DisplayDefaults.js";
import {displayModeChoices, displayModeTitle, parseDisplayMode} from "../tui/tool/DisplayModeChoice.js";
import {DisplaySettings} from "../tui/tool/DisplaySettings.js";

const ACTIONS = ["save", "reset"] as const;
const MODES = displayModeChoices.map((choice) => choice.value);
const USAGE = `Usage: /display [save|reset|<${MODES.join("|")}> <${MODES.join("|")}>] (Normal, then Alternate)`;

export class DisplayCommand {
    private registered = false;

    constructor(private readonly pi: ExtensionAPI, private readonly defaults: () => DisplayDefaultsRuntime) {}

    register(): void {
        if (this.registered) throw new Error("Display command is already registered");
        this.registered = true;
        this.pi.registerCommand("display", {
            description: "Configure the Normal and Alternate views used by Ctrl+O",
            getArgumentCompletions: (input) => this.completions(input),
            handler: async (input, ctx) => {
                const args = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
                const defaults = this.defaults();
                if (args.length === 0) {
                    await this.showSettings(defaults, ctx);
                    return;
                }
                if (args.length === 1 && (args[0] === "save" || args[0] === "reset")) {
                    try {
                        if (args[0] === "save") {
                            defaults.save();
                            ctx.ui.notify("Saved current display defaults to ~/.pilot/display-defaults.json.", "info");
                        } else {
                            defaults.reset();
                            ctx.ui.notify("Reset display defaults from saved preferences.", "info");
                        }
                    } catch (error) {
                        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                    }
                    return;
                }
                const normal = args[0] ? parseDisplayMode(args[0]) : undefined;
                const alternate = args[1] ? parseDisplayMode(args[1]) : undefined;
                if (args.length !== 2 || !normal || !alternate) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }
                defaults.setViews(normal, alternate);
                ctx.ui.notify(this.status(defaults), "info");
            },
        });
    }

    private async showSettings(defaults: DisplayDefaultsRuntime, ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify(this.status(defaults), "info");
            return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
            return new DisplaySettings(defaults, theme, () => done(), () => tui.requestRender());
        });
    }

    private status(defaults: DisplayDefaultsRuntime): string {
        const {normal, alternate} = defaults.values;
        return `Display for this session:\nNormal view = ${displayModeTitle(normal)}\nAlternate view = ${displayModeTitle(alternate)}`;
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const tokens = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (/\s$/.test(input) && tokens.length > 0) tokens.push("");
        if (tokens.length > 2) return [];
        const prefix = tokens.at(-1) ?? "";
        const previous = tokens.length === 2 ? tokens[0] : undefined;
        if (previous && !parseDisplayMode(previous)) {
            return ACTIONS.some((action) => action === previous) ? [] : null;
        }
        const options = previous ? MODES : [...ACTIONS, ...MODES];
        const matches = options.filter((option) => option.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((option) => ({
            value: previous ? `${previous} ${option}` : option,
            label: displayModeChoices.find((choice) => choice.value === option)?.title ?? option,
        }));
    }
}
