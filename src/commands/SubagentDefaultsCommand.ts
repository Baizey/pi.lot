import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {
    AUTO_SUBAGENT_MODEL,
    type SubagentDefaultValues,
    SubagentDefaultsRuntime,
} from "../subagents/SubagentDefaults.js";
import {SubagentReasoningSkill} from "../subagents/SubagentReasoning.js";

const COMMAND_NAME = "subagent-defaults";
const ACTIONS = ["save", "reset"] as const;
const SKILLS = Object.values(SubagentReasoningSkill);
const TARGETS = ["all", ...SKILLS] as const;
const USAGE = `Usage: /${COMMAND_NAME} [save|reset|<auto|provider/model> <${TARGETS.join("|")}>]`;

type Completion = {value: string; label: string; description?: string};

export class SubagentDefaultsCommand {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly defaults: () => SubagentDefaultsRuntime,
        private readonly availableModels: () => readonly string[],
        private readonly resolveAutomaticModel: (skill: SubagentReasoningSkill) => Promise<string>,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Subagent defaults command is already registered");
        this.registered = true;

        this.pi.registerCommand(COMMAND_NAME, {
            description: "Show or change the model used for each subagent reasoning skill",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                const args = parseArgs(input).args;
                if (args.length === 0) {
                    ctx.ui.notify(await this.renderDefaults(this.defaults().values), "info");
                    return;
                }

                const action = args[0]?.toLowerCase();
                if (args.length === 1 && isValid(ACTIONS, action)) {
                    try {
                        if (action === "save") {
                            this.defaults().save();
                            ctx.ui.notify(
                                "Saved current subagent defaults to ~/.pilot/subagent-defaults.json.",
                                "info",
                            );
                        } else {
                            this.defaults().reset();
                            ctx.ui.notify("Reset subagent defaults.", "info");
                        }
                    } catch (error) {
                        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                    }
                    return;
                }

                const target = args[1]?.toLowerCase();
                const model = this.resolveModelPreference(args[0]);
                if (args.length !== 2 || !isValid(TARGETS, target) || !model) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }

                if (target === "all") {
                    for (const skill of SKILLS) this.defaults().set(skill, model);
                } else {
                    this.defaults().set(target, model);
                }
                ctx.ui.notify(`Subagent default ${target} = ${model} for this session.`, "info");
            },
        });
    }

    private completions(input: string): Completion[] | null {
        const parsed = parseArgs(input);
        const midFilling = !parsed.onNext;
        const tokens = parsed.args;
        if (tokens.length === 0 || (tokens.length === 1 && midFilling)) {
            return matches(this.firstArguments(), tokens[0]);
        }
        if (tokens.length === 1 && isValid(ACTIONS, tokens[0]?.toLowerCase())) return [];
        if (!this.resolveModelPreference(tokens[0])) return null;
        if (tokens.length === 1 || (tokens.length === 2 && midFilling)) {
            return matches(TARGETS, tokens[1], [tokens[0]!]);
        }
        return [];
    }

    private firstArguments(): string[] {
        return [...ACTIONS, AUTO_SUBAGENT_MODEL, ...this.availableModels()];
    }

    private resolveModelPreference(value: string | undefined): string | undefined {
        if (!value) return undefined;
        if (value.toLowerCase() === AUTO_SUBAGENT_MODEL) return AUTO_SUBAGENT_MODEL;
        const normalized = value.toLowerCase();
        return this.availableModels().find((model) => model.toLowerCase() === normalized);
    }

    private async renderDefaults(defaults: SubagentDefaultValues): Promise<string> {
        const mappings = await Promise.all(SKILLS.map(async (skill) => {
            if (defaults[skill] !== AUTO_SUBAGENT_MODEL) return `${skill} = ${defaults[skill]}`;
            try {
                return `${skill} = ${await this.resolveAutomaticModel(skill)} (auto)`;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `${skill} = <unresolved: ${message}> (auto)`;
            }
        }));
        return ["Subagent defaults for this session:", ...mappings].join("\n");
    }
}

function matches(
    options: readonly string[],
    prefix: string | undefined,
    previousArgs: readonly string[] = [],
): Completion[] | null {
    const normalizedPrefix = prefix?.toLowerCase() ?? "";
    const matching = options.filter((option) => option.toLowerCase().startsWith(normalizedPrefix));
    return matching.length === 0
        ? null
        : matching.map((option) => ({
            value: [...previousArgs, option].join(" "),
            label: option,
        }));
}

function parseArgs(value: string): {args: string[]; onNext: boolean} {
    const input = value.trimStart();
    return {
        args: input.trim().split(/\s+/).filter(Boolean),
        onNext: /\s$/.test(input),
    };
}

function isValid<T extends string>(options: readonly T[], value: string | undefined): value is T {
    return options.some((option) => option === value);
}
