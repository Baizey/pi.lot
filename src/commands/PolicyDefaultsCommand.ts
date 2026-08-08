import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import type {ResponseDefaults} from "../policy/types.js";
import {ResponseType} from "../policy/types.js";
import {defaultPolicyAreas} from "../policy/PolicyLogic";
import PolicyRuntime from "../policy/PolicyRuntime";

const COMMAND_NAME = "policy-defaults";
const AREAS = ["all", ...Object.keys(defaultPolicyAreas)]
const RESPONSES = Object.keys(ResponseType)
const USAGE = `Usage: /${COMMAND_NAME} <${RESPONSES.join("|")}> <${AREAS.join("|")}>` as const;

export class PolicyDefaultsCommand {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtime: () => PolicyRuntime,
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
                    ctx.ui.notify(this.renderDefaults(provider.defaultResponses), "info");
                    return;
                }
                if (args.length !== 2 || !isValid(RESPONSES, args[0]) || !isValid(AREAS, args[1])) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }

                const [response, key] = args;
                if (key === "all") {
                    Object.keys(defaultPolicyAreas).forEach(key => {
                        provider.setDefaultResponse(key as keyof ResponseDefaults, response as ResponseType);
                    })
                } else {
                    provider.setDefaultResponse(key as keyof ResponseDefaults, response as ResponseType);
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
            return matches(RESPONSES, tokens[0], [])
        } else if (tokens.length === 1 || (tokens.length === 2 && midFilling)) {
            return matches(AREAS, tokens[1], [tokens[0]])
        } else return []
    }

    private renderDefaults(defaults: ResponseDefaults): string {
        return ["Policy defaults for this session:", ...(Object.keys(defaultPolicyAreas)).map((key) => `${key} = ${defaults[key as keyof ResponseDefaults]}`)].join("\n");
    }
}

function matches(
    options: string[],
    prefix: string | undefined,
    previousArgs: string[],
) {
    prefix = prefix || "";
    if (isValid(RESPONSES, prefix)) return null;
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

function isValid(options: string[], value: string | undefined): boolean {
    return options.some((key) => key === value);
}
