import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ServerService} from "./ServerService.js";
import type {ArchiveSourceScope} from "./ArchiveSourceScope.js";
import {captureArchiveSourceScope} from "./ArchiveSourceScopeCapture.js";
import {configSyncStatus} from "./config-sync/ConfigSyncStatus.js";

/** Cache after identity registration; register departure after hooks that close local writers. */
export class ServerSessionLifecycle {
    private preparationRegistered = false;
    private registered = false;
    private source: ArchiveSourceScope | undefined;
    private shutdownEnqueue: Promise<void> | undefined;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly server: ServerService,
        private readonly awaitLocalShutdown: () => Promise<void> = async () => {},
    ) {
    }

    registerPreparation(): void {
        if (this.preparationRegistered) throw new Error("Server shutdown preparation is already registered");
        this.preparationRegistered = true;
        this.pi.on("session_start", () => {
            this.server.startSession();
            this.source = undefined;
            this.shutdownEnqueue = undefined;
        });
        this.pi.on("session_shutdown", () => this.server.beginShutdown());
    }

    /** Called synchronously after recordMainSessionIdentity, before asynchronous owned startup. */
    captureSource(ctx: ExtensionContext): void {
        this.source = undefined;
        try {
            this.source = captureArchiveSourceScope(ctx.sessionManager, "current");
        } catch {
            ctx.ui.notify("Automatic archive source could not be recorded. Local session files are unchanged.", "warning");
        }
    }

    register(): void {
        if (this.registered) throw new Error("Server lifecycle is already registered");
        this.registered = true;
        this.pi.on("session_start", async (_event, ctx) => {
            try {
                // Startup only wakes retained work, never backfills session history.
                await this.server.background.initialize();
            } catch {
                ctx.ui.notify("Background archive startup failed. Queued work is retained; session use can continue.", "warning");
            }
            this.startConfigurationSync(ctx);
        });
        this.pi.on("session_shutdown", (_event, ctx) => {
            // Capture this departure's plain data before any await or subsequent startup.
            return this.shutdownEnqueue ??= this.enqueueOnShutdown(ctx, this.source);
        });
    }

    private startConfigurationSync(ctx: ExtensionContext): void {
        const controller = this.server.beginRequest();
        if (!controller) return;
        // Explicitly enabled startup checks must not delay session use or departure.
        void this.server.configuration.synchronizeAutomatic(controller.signal).then((result) => {
            if (controller.signal.aborted || !result || result.kind === "busy"
                || (result.kind === "complete" && result.items.every((item) => item.status === "unchanged"))) return;
            const status = configSyncStatus(result);
            ctx.ui.notify(status.message, status.severity);
        }).catch(() => {
            if (!controller.signal.aborted) ctx.ui.notify("Automatic configuration sync failed. Pending work is retained; retry with /server sync.", "warning");
        }).finally(() => this.server.finishRequest(controller));
    }

    private async enqueueOnShutdown(ctx: ExtensionContext, source: ArchiveSourceScope | undefined): Promise<void> {
        this.server.beginShutdown();
        try {
            // Pi continues dispatch after a preceding listener fails. Observe that same
            // teardown promise, but retain the source obligation even on teardown failure.
            await this.awaitLocalShutdown();
        } catch {
            ctx.ui.notify("Local session shutdown failed. Archive capture may not include all final writes.", "warning");
        }
        if (!source?.sessionFile) return;
        try {
            if (!this.server.store.load()) return;
            // No manager access, runtime validation, transcript I/O, or network here.
            const result = await this.server.background.enqueue(source);
            if (result.warning !== undefined) {
                ctx.ui.notify("Archive work is queued, but its background worker could not be launched. It will resume on a later wakeup.", "warning");
            }
        } catch {
            ctx.ui.notify("Automatic archive work could not be queued. Local session files are preserved; retry with /server upload current.", "warning");
        }
    }
}
