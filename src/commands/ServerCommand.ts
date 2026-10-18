import {stripVTControlCharacters} from "node:util";
import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {ServerConfigError, ServerConfigStore, type ServerConfig} from "../server/ServerConfig.js";
import {SessionArchive, type ArchiveUploadReport} from "../server/SessionArchive.js";
import {SERVER_VERSION_REQUIREMENT} from "../server/ServerCompatibility.js";
import {checkServerVersion} from "../server/ServerConnection.js";

const ACTIONS = ["login", "logout", "upload"] as const;
const USAGE = "Usage: /server [login|logout|upload [current|all]]";

type UploadArchive = (
    config: ServerConfig, ctx: ExtensionCommandContext, scope: "current" | "all", signal?: AbortSignal,
) => Promise<ArchiveUploadReport>;

export class ServerCommand {
    private registered = false;
    private pendingCheck: AbortController | undefined;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly store = new ServerConfigStore(),
        private readonly checkConnection = checkServerVersion,
        private readonly uploadArchive: UploadArchive = (config, ctx, scope, signal) => (
            new SessionArchive(config).upload(ctx.sessionManager, scope, signal)
        ),
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Server command is already registered");
        this.registered = true;

        this.pi.on("session_shutdown", () => this.cancelStatusCheck());
        this.pi.registerCommand("server", {
            description: "Manage pi.server credentials, check status, or manually upload session archives",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                this.cancelStatusCheck();
                const controller = new AbortController();
                this.pendingCheck = controller;
                try {
                    switch (input.trim().toLowerCase()) {
                        case "":
                            await this.showStatus(ctx, controller);
                            return;
                        case "login":
                            await this.login(ctx, controller);
                            return;
                        case "logout":
                            this.store.logout();
                            ctx.ui.notify("Removed the local server configuration. Session files are unchanged; the server API key has not been revoked.", "info");
                            return;
                        case "upload":
                        case "upload current":
                            await this.upload(ctx, "current", controller);
                            return;
                        case "upload all":
                            await this.upload(ctx, "all", controller);
                            return;
                        default:
                            ctx.ui.notify(USAGE, "error");
                    }
                } catch (error) {
                    if (this.pendingCheck !== controller) return;
                    const archiveOperation = input.trim().toLowerCase().startsWith("upload");
                    ctx.ui.notify(error instanceof ServerConfigError ? error.message
                        : archiveOperation ? "Server archive operation failed." : "Server configuration operation failed.", "error");
                } finally {
                    if (this.pendingCheck === controller) this.pendingCheck = undefined;
                }
            },
        });
    }

    private async showStatus(ctx: ExtensionCommandContext, controller: AbortController): Promise<void> {
        const config = this.store.load();
        if (!config) {
            ctx.ui.notify("Config: none\nStatus: Not configured.", "info");
            return;
        }
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
    }

    private async upload(ctx: ExtensionCommandContext, scope: "current" | "all", controller: AbortController): Promise<void> {
        const config = this.store.load();
        if (!config) {
            ctx.ui.notify("Server is not configured. Use /server login first.", "error");
            return;
        }
        const report = await this.uploadArchive(config, ctx, scope, controller.signal);
        if (this.pendingCheck !== controller) return;
        const summary = `Archive upload (${scope}): ${report.uploaded} uploaded, ${report.unchanged} unchanged, ${report.failed} failed.`;
        const warnings = report.warnings.slice(0, 20)
            .map((warning) => `Warning: ${this.safeArchiveText(warning, config.apiKey)}`);
        const failures = report.failures.slice(0, 20).map(({file, message}) => (
            `Failed: ${this.safeArchiveText(file, config.apiKey, 512)}: ${this.safeArchiveText(message, config.apiKey)}`
        ));
        ctx.ui.notify([summary, ...warnings, ...failures].join("\n"),
            report.failed > 0 || report.warnings.length > 0 ? "warning" : "info");
    }

    private cancelStatusCheck(): void {
        this.pendingCheck?.abort();
        this.pendingCheck = undefined;
    }

    private async login(ctx: ExtensionCommandContext, controller: AbortController): Promise<void> {
        if (!ctx.hasUI) {
            ctx.ui.notify("Use /server login in an interactive session or a client supporting input dialogs.", "error");
            return;
        }
        const url = await ctx.ui.input("pi.server URL", "https://sessions.example.com");
        if (url === undefined || this.pendingCheck !== controller) return;
        const apiKey = await ctx.ui.input("pi.server API key");
        if (apiKey === undefined || this.pendingCheck !== controller) return;
        this.store.save({url, apiKey});
        ctx.ui.notify("Saved the server URL and API key locally. Connection and compatibility have not been checked; no automatic upload is performed.", "info");
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const prefix = input.trimStart().toLowerCase();
        if (prefix.startsWith("upload ")) {
            return ["upload current", "upload all"].filter((action) => action.startsWith(prefix))
                .map((action) => ({value: action, label: action}));
        }
        if (/\s/.test(prefix)) return [];
        const matches = ACTIONS.filter((action) => action.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((action) => ({value: action, label: action}));
    }

    private safeArchiveText(value: string, apiKey: string, limit = 1024): string {
        const sanitized = stripVTControlCharacters(value)
            .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
            .split(apiKey).join("[redacted]");
        return sanitized.length > limit ? `${sanitized.slice(0, limit - 1)}…` : sanitized;
    }
}
