import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import type {ResponseDefaults} from "../policy/types.js";
import {ResponseType} from "../policy/types.js";
import {initialPolicyDefaults} from "../policy/defaults.js";
import type {PilotSessionRuntimeInterface} from "../runtime/PilotSessionRuntime";

const COMMAND_NAME = "policy-defaults";
const ACTIONS = ["save", "reset"] as const;
const AREAS = ["all", ...Object.keys(initialPolicyDefaults)];
const RESPONSES = Object.values(ResponseType);
const FIRST_ARGUMENTS = [...ACTIONS, ...RESPONSES];
const USAGE = `Usage: /${COMMAND_NAME} [save|reset|<${RESPONSES.join("|")}> <${AREAS.join("|")}>]` as const;

export class PolicyDefaultsCommand {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtime: () => PilotSessionRuntimeInterface,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Policy defaults command is already registered");
        this.registered = true;

        this.pi.registerCommand(COMMAND_NAME, {
            description: "Show or change session policy defaults",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                const provider = this.runtime()
                const args = parseArgs(input).args;
                if (args.length === 0) {
                    ctx.ui.notify(this.renderDefaults(provider.policyRuntime.defaultResponses), "info");
                    return;
                }
                if (args.length === 1 && isValid(ACTIONS, args[0])) {
                    try {
                        if (args[0] === "save") {
                            provider.policyRuntime.saveDefaultResponses();
                            ctx.ui.notify("Saved current policy defaults to ~/.pilot/policy-defaults.json.", "info");
                        } else {
                            const source = provider.policyRuntime.resetDefaultResponses();
                            ctx.ui.notify(`Reset policy defaults from ${source} defaults.`, "info");
                        }
                    } catch (error) {
                        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                    }
                    return;
                }
                if (args.length !== 2 || !isValid(RESPONSES, args[0]) || !isValid(AREAS, args[1])) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }

                const [response, key] = args;
                if (key === "all") {
                    Object.keys(initialPolicyDefaults).forEach(key => {
                        provider.policyRuntime.setDefaultResponse(key as keyof ResponseDefaults, response as ResponseType);
                    })
                } else {
                    provider.policyRuntime.setDefaultResponse(key as keyof ResponseDefaults, response as ResponseType);
                }

                ctx.ui.notify(`Policy default ${key} = ${response} for this session.`, "info");
            },
        });
    }

    private completions(input: string): Array<{ value: string; label: string; description?: string }> | null {
        const parsed = parseArgs(input);
        const midFilling = !parsed.onNext
        const tokens = parsed.args
        if (tokens.length === 0 || (tokens.length === 1 && midFilling)) {
            return matches(FIRST_ARGUMENTS, tokens[0], [])
        }
        if (tokens.length === 1 && isValid(ACTIONS, tokens[0])) return [];
        if (!isValid(RESPONSES, tokens[0])) return null;
        if (tokens.length === 1 || (tokens.length === 2 && midFilling)) {
            return matches(AREAS, tokens[1], [tokens[0]])
        }
        return []
    }

    private renderDefaults(defaults: ResponseDefaults): string {
        return ["Policy defaults for this session:", ...(Object.keys(initialPolicyDefaults)).map((key) => `${key} = ${defaults[key as keyof ResponseDefaults]}`)].join("\n");
    }
}

function matches(
    options: string[],
    prefix: string | undefined,
    previousArgs: string[],
) {
    prefix = prefix || "";
    const matches = options.filter((key) => key.startsWith(prefix));
    return matches.length === 0
        ? null
        : matches.map((area) => ({
            value: `${previousArgs.join(" ")}${previousArgs.length === 0 ? "" : " "}${area}`,
            label: area
        }));
}

function parseArgs(str: string): { args: string[], onNext: boolean } {
    const input = str.trimStart().toLowerCase();
    const tokens = input.trim().split(/\s+/).filter(it => it);
    const endsWithSpace = /.*\s+$/.test(input);
    return {args: tokens, onNext: endsWithSpace};
}

function isValid(options: readonly string[], value: string | undefined): boolean {
    return options.some((key) => key === value);
}
