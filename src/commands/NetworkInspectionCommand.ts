import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import type {PilotSessionRuntimeInterface} from "../runtime/PilotSessionRuntime.js";

const COMMAND_NAME = "network-inspection";
const MODES = ["on", "off"] as const;
const USAGE = `Usage: /${COMMAND_NAME} [${MODES.join("|")}]`;

export class NetworkInspectionCommand {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtime: () => PilotSessionRuntimeInterface,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Network inspection command is already registered");
        this.registered = true;

        this.pi.registerCommand(COMMAND_NAME, {
            description: "Show or change HTTPS method/path inspection for this session",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                const mode = input.trim().toLowerCase();
                const runtime = this.runtime();
                if (mode === "") {
                    ctx.ui.notify(this.status(runtime.fullNetworkInspection), "info");
                    return;
                }
                if (!isMode(mode)) {
                    ctx.ui.notify(USAGE, "error");
                    return;
                }

                runtime.setFullNetworkInspection(mode === "on");
                ctx.ui.notify(this.status(runtime.fullNetworkInspection), "info");
            },
        });
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const normalized = input.trimStart().toLowerCase();
        if (/\s/.test(normalized)) return [];
        const matches = MODES.filter((mode) => mode.startsWith(normalized));
        return matches.length === 0
            ? null
            : matches.map((mode) => ({value: mode, label: mode}));
    }

    private status(enabled: boolean): string {
        return enabled
            ? "Full network inspection is on; HTTPS method and path policy is enabled."
            : "Full network inspection is off; HTTPS remains end-to-end and policy is limited to hostname and port.";
    }
}

function isMode(value: string): value is typeof MODES[number] {
    return MODES.some((mode) => mode === value);
}
