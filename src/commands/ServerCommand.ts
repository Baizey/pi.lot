import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {ServerConfigError, ServerConfigStore} from "../server/ServerConfig.js";
import {SERVER_VERSION_REQUIREMENT} from "../server/ServerCompatibility.js";
import {checkServerVersion} from "../server/ServerConnection.js";

const ACTIONS = ["login", "logout"] as const;
const USAGE = "Usage: /server [login|logout]";

export class ServerCommand {
    private registered = false;
    private pendingCheck: AbortController | undefined;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly store = new ServerConfigStore(),
        private readonly checkConnection = checkServerVersion,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Server command is already registered");
        this.registered = true;

        this.pi.registerCommand("server", {
            description: "Show pi.server configuration and connection status, or save/remove credentials",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                try {
                    switch (input.trim().toLowerCase()) {
                        case "":
                            await this.showStatus(ctx);
                            return;
                        case "login":
                            this.cancelStatusCheck();
                            await this.login(ctx);
                            return;
                        case "logout":
                            this.cancelStatusCheck();
                            this.store.logout();
                            ctx.ui.notify("Removed the local server configuration. Session files are unchanged; the server API key has not been revoked.", "info");
                            return;
                        default:
                            ctx.ui.notify(USAGE, "error");
                    }
                } catch (error) {
                    ctx.ui.notify(error instanceof ServerConfigError ? error.message : "Server configuration operation failed.", "error");
                }
            },
        });
    }

    private async showStatus(ctx: ExtensionCommandContext): Promise<void> {
        this.cancelStatusCheck();
        const config = this.store.load();
        if (!config) {
            ctx.ui.notify("Config: none\nStatus: Not configured.", "info");
            return;
        }
        const controller = new AbortController();
        this.pendingCheck = controller;
        try {
            const status = await this.checkConnection(config, controller.signal);
            // Logout or a newer command must not reveal stale credentials/status later.
            if (this.pendingCheck !== controller) return;
            let message: string;
            let severity: "info" | "warning" | "error";
            switch (status.kind) {
                case "compatible":
                    message = `Connected (pi.server ${status.version}; compatible).`;
                    severity = "info";
                    break;
                case "incompatible":
                    message = `Incompatible: server ${status.version}; required ${SERVER_VERSION_REQUIREMENT}.`;
                    severity = "warning";
                    break;
                case "failure":
                    message = status.message;
                    severity = "error";
            }
            ctx.ui.notify(`${JSON.stringify(config, null, 2)}\n\nStatus: ${message}`, severity);
        } finally {
            if (this.pendingCheck === controller) this.pendingCheck = undefined;
        }
    }

    private cancelStatusCheck(): void {
        this.pendingCheck?.abort();
        this.pendingCheck = undefined;
    }

    private async login(ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI) {
            ctx.ui.notify("Use /server login in an interactive session or a client supporting input dialogs.", "error");
            return;
        }
        const url = await ctx.ui.input("pi.server URL", "https://sessions.example.com");
        if (url === undefined) return;
        const apiKey = await ctx.ui.input("pi.server API key");
        if (apiKey === undefined) return;
        this.cancelStatusCheck();
        this.store.save({url, apiKey});
        ctx.ui.notify("Saved the server URL and API key locally. Connection and compatibility have not been checked; no synchronization is performed.", "info");
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const prefix = input.trimStart().toLowerCase();
        if (/\s/.test(prefix)) return [];
        const matches = ACTIONS.filter((action) => action.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((action) => ({value: action, label: action}));
    }
}
