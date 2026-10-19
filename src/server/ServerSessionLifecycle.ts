import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ServerService} from "./ServerService.js";
import {ArchiveClientError} from "./ArchiveClient.js";
import {archiveUploadNotification} from "./ArchiveUploadPresentation.js";
import {formatServerErrorCode} from "./ServerResponses.js";

export const SHUTDOWN_UPLOAD_TIMEOUT_MS = 10_000;

/** Independent lifecycle access point; register after hooks that finalize local session writers. */
export class ServerSessionLifecycle {
    private preparationRegistered = false;
    private registered = false;
    private shutdownUpload: Promise<void> | undefined;

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
            this.shutdownUpload = undefined;
        });
        this.pi.on("session_shutdown", () => this.server.beginShutdown());
    }

    register(): void {
        if (this.registered) throw new Error("Server lifecycle is already registered");
        this.registered = true;
        this.pi.on("session_shutdown", (_event, ctx) => {
            return this.shutdownUpload ??= this.uploadOnShutdown(ctx);
        });
    }

    private async uploadOnShutdown(ctx: ExtensionContext): Promise<void> {
        this.server.beginShutdown();
        try {
            // Registration order alone is insufficient: Pi continues dispatching
            // shutdown listeners after a preceding listener fails.
            await this.awaitLocalShutdown();
        } catch {
            ctx.ui.notify("Automatic archive upload skipped because local session shutdown failed.", "warning");
            return;
        }
        if (!ctx.sessionManager.getSessionFile()) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
            const config = this.server.store.load();
            if (!config) return;
            const deadline = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    reject(new Error("Shutdown upload deadline exceeded."));
                }, SHUTDOWN_UPLOAD_TIMEOUT_MS);
            });
            const upload = async () => {
                // Cancellation alone does not close a prior upload's journal. Bound
                // this drain too, and never overlap a still-running publication.
                await this.server.drainUploads();
                controller.signal.throwIfAborted();
                // Logout or a destination change in another process may occur while draining.
                const currentConfig = this.server.store.load();
                if (!currentConfig) return;
                const report = await this.server.upload(currentConfig, ctx.sessionManager, "current", controller.signal);
                controller.signal.throwIfAborted();
                const notification = archiveUploadNotification(report, "current", currentConfig.apiKey, true);
                ctx.ui.notify(notification.message, notification.type);
            };
            await Promise.race([upload(), deadline]);
        } catch (error) {
            const diagnostic = error instanceof ArchiveClientError ? formatServerErrorCode(error.code) : undefined;
            ctx.ui.notify(timedOut
                ? "Automatic archive upload timed out after 10 seconds. Retry with /server upload current; pending upload recovery state is preserved."
                : `Automatic archive upload failed.${diagnostic ? ` ${diagnostic}` : ""} Local session files are preserved.`, "warning");
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
}
