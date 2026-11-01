import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {ServerConfigError} from "../server/ServerConfig.js";
import {ServerService} from "../server/ServerService.js";
import {captureArchiveSourceScope} from "../server/ArchiveSourceScopeCapture.js";
import {SERVER_VERSION_REQUIREMENT} from "../server/ServerCompatibility.js";
import {configSyncStatus} from "../server/config-sync/ConfigSyncStatus.js";
import {CONFIG_KEYS} from "../server/config-sync/ConfigSyncProtocol.js";
import type {ConfigSyncResult} from "../server/config-sync/ConfigSyncService.js";

const ACTIONS = ["login", "logout", "upload", "sync"] as const;
const USAGE = "Usage: /server [login|logout|upload [current|all]|sync [on|off|recover <json-key> <local|server>]]";

export class ServerCommand {
    private registered = false;
    private pendingCheck: AbortController | undefined;

    constructor(private readonly pi: ExtensionAPI, private readonly server = new ServerService()) {
    }

    register(): void {
        if (this.registered) throw new Error("Server command is already registered");
        this.registered = true;

        this.pi.registerCommand("server", {
            description: "Manage pi.server credentials, session archives, and saved pi.lot configuration sync",
            getArgumentCompletions: (prefix) => this.completions(prefix),
            handler: async (input, ctx) => {
                this.cancelStatusCheck();
                const controller = this.server.beginRequest();
                if (!controller) return;
                this.pendingCheck = controller;
                try {
                    const parts = input.trim().toLowerCase().split(/\s+/u);
                    const key = CONFIG_KEYS.find((candidate) => candidate === parts[2]);
                    const direction = parts[3];
                    if (parts.length === 4 && parts[0] === "sync" && parts[1] === "recover"
                        && key && key !== "global-policies" && (direction === "local" || direction === "server")) {
                        const result = await this.server.configuration.recover(key, direction, controller.signal);
                        this.notifySync(ctx, result, controller);
                        return;
                    }
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
                            await this.wakeAfterConfiguration(ctx, controller);
                            return;
                        case "upload":
                        case "upload current":
                            await this.upload(ctx, "current", controller);
                            return;
                        case "upload all":
                            await this.upload(ctx, "all", controller);
                            return;
                        case "sync":
                        case "sync on":
                            await this.sync(ctx, input.trim().toLowerCase() === "sync on", controller);
                            return;
                        case "sync off":
                            this.server.configuration.disableAutomatic();
                            ctx.ui.notify("Automatic configuration sync is disabled on this computer. Saved configuration, retained sync work, and session archival are unchanged.", "info");
                            return;
                        default:
                            ctx.ui.notify(USAGE, "error");
                    }
                } catch (error) {
                    if (this.pendingCheck !== controller || controller.signal.aborted) return;
                    const archiveOperation = input.trim().toLowerCase().startsWith("upload");
                    ctx.ui.notify(archiveOperation ? "Server archive work could not be queued. Local session files are unchanged."
                        : error instanceof ServerConfigError ? error.message
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
        const source = captureArchiveSourceScope(ctx.sessionManager, scope);
        if (scope === "current" && !source.sessionFile) {
            ctx.ui.notify("Current session is ephemeral and was not queued. Use /server upload all to queue persisted history.", "warning");
            return;
        }
        // Request cancellation suppresses presentation, not committed background work.
        const result = await this.server.background.enqueue(source);
        if (this.pendingCheck !== controller || controller.signal.aborted) return;
        ctx.ui.notify(result.warning !== undefined
            ? `Server archive work (${scope}) is queued, but its background worker could not be launched. It will resume on a later wakeup.`
            : `Server archive work (${scope}) queued for background upload.`, result.warning !== undefined ? "warning" : "info");
    }

    private async sync(ctx: ExtensionCommandContext, enableAutomatic: boolean, controller: AbortController): Promise<void> {
        const result = await (enableAutomatic ? this.server.configuration.enableAutomatic(controller.signal)
            : this.server.configuration.synchronize(controller.signal));
        this.notifySync(ctx, result, controller, enableAutomatic);
    }

    private notifySync(ctx: ExtensionCommandContext, result: ConfigSyncResult, controller: AbortController, enableAutomatic = false): void {
        if (this.pendingCheck !== controller || controller.signal.aborted) return;
        const status = configSyncStatus(result);
        const enabled = enableAutomatic && result.kind === "complete"
            ? "\n\nAutomatic checks are enabled for this server binding at session startup. This includes saved web-search credentials. Use /server sync off to disable them." : "";
        ctx.ui.notify(status.message + enabled, status.severity);
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
        ctx.ui.notify("Saved the server URL and API key locally. Connection and compatibility have not been checked. Persistent session families will be queued automatically when their session ends; complete history can contain sensitive data. Use /server logout to disable uploads.", "info");
        await this.wakeAfterConfiguration(ctx, controller);
    }

    private async wakeAfterConfiguration(ctx: ExtensionCommandContext, controller: AbortController): Promise<void> {
        try {
            // Initialization validates the local runner and wakes retained work;
            // its runtime probe is cached, but configuration wakeups are not.
            await this.server.background.initialize();
        } catch {
            if (this.pendingCheck !== controller || controller.signal.aborted) return;
            ctx.ui.notify("Server configuration changed, but the background archive worker could not be started. Queued work is retained for a later wakeup.", "warning");
        }
    }

    private completions(input: string): Array<{value: string; label: string}> | null {
        const prefix = input.trimStart().toLowerCase();
        if (prefix.startsWith("upload ")) {
            return ["upload current", "upload all"].filter((action) => action.startsWith(prefix))
                .map((action) => ({value: action, label: action}));
        }
        if (prefix.startsWith("sync recover ")) {
            return CONFIG_KEYS.filter((key) => key !== "global-policies")
                .flatMap((key) => ["local", "server"].map((direction) => `sync recover ${key} ${direction}`))
                .filter((action) => action.startsWith(prefix)).map((action) => ({value: action, label: action}));
        }
        if (prefix.startsWith("sync ")) {
            return ["sync on", "sync off", "sync recover"].filter((action) => action.startsWith(prefix))
                .map((action) => ({value: action, label: action}));
        }
        if (/\s/.test(prefix)) return [];
        const matches = ACTIONS.filter((action) => action.startsWith(prefix));
        return matches.length === 0 ? null : matches.map((action) => ({value: action, label: action}));
    }
}
