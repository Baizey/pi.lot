import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {ServerConfigError} from "../server/ServerConfig.js";
import {ServerService} from "../server/ServerService.js";
import {archiveUploadNotification} from "../server/ArchiveUploadPresentation.js";
import {SERVER_VERSION_REQUIREMENT} from "../server/ServerCompatibility.js";
import {ArchiveClientError} from "../server/ArchiveClient.js";
import {formatServerErrorCode} from "../server/ServerResponses.js";

const ACTIONS = ["login", "logout", "upload"] as const;
const USAGE = "Usage: /server [login|logout|upload [current|all]]";

export class ServerCommand {
    private registered = false;
    private pendingCheck: AbortController | undefined;

    constructor(private readonly pi: ExtensionAPI, private readonly server = new ServerService()) {
    }

    register(): void {
        if (this.registered) throw new Error("Server command is already registered");
        this.registered = true;

        this.pi.registerCommand("server", {
            description: "Manage pi.server credentials, check status, or manually upload session archives",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                this.cancelStatusCheck();
                const controller = this.server.beginRequest();
                if (!controller) return;
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
                            this.server.store.logout();
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
                    if (this.pendingCheck !== controller || controller.signal.aborted) return;
                    const archiveOperation = input.trim().toLowerCase().startsWith("upload");
                    const diagnostic = archiveOperation && error instanceof ArchiveClientError
                        ? formatServerErrorCode(error.code) : undefined;
                    ctx.ui.notify(error instanceof ServerConfigError ? error.message
                        : archiveOperation ? `Server archive operation failed.${diagnostic ? ` ${diagnostic}` : ""}`
                            : "Server configuration operation failed.", "error");
                } finally {
                    this.server.finishRequest(controller);
                    if (this.pendingCheck === controller) this.pendingCheck = undefined;
                }
            },
        });
    }

    private async showStatus(ctx: ExtensionCommandContext, controller: AbortController): Promise<void> {
        const config = this.server.store.load();
        if (!config) {
            ctx.ui.notify("Config: none\nStatus: Not configured.", "info");
            return;
        }
        const status = await this.server.checkConnection(config, controller.signal);
        // Cancelled or superseded commands must not reveal stale credentials/status later.
        if (this.pendingCheck !== controller || controller.signal.aborted) return;
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
        const config = this.server.store.load();
        if (!config) {
            ctx.ui.notify("Server is not configured. Use /server login first.", "error");
            return;
        }
        const report = await this.server.upload(config, ctx.sessionManager, scope, controller.signal);
        if (this.pendingCheck !== controller || controller.signal.aborted) return;
        const notification = archiveUploadNotification(report, scope, config.apiKey);
        ctx.ui.notify(notification.message, notification.type);
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
        if (url === undefined || this.pendingCheck !== controller || controller.signal.aborted) return;
        const apiKey = await ctx.ui.input("pi.server API key");
        if (apiKey === undefined || this.pendingCheck !== controller || controller.signal.aborted) return;
        this.server.store.save({url, apiKey});
        ctx.ui.notify("Saved the server URL and API key locally. Connection and compatibility have not been checked. Persistent session families will upload automatically when their session ends; complete history can contain sensitive data. Use /server logout to disable uploads.", "info");
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
}
