import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ServerConfigStore, type ServerConfig} from "./ServerConfig.js";
import {checkServerVersion} from "./ServerConnection.js";
import {SessionArchive, type ArchiveUploadReport, type SessionArchiveOptions} from "./SessionArchive.js";

type SessionManager = ExtensionContext["sessionManager"];
type UploadArchive = (
    config: ServerConfig, manager: SessionManager, scope: "current" | "all", signal?: AbortSignal,
) => Promise<ArchiveUploadReport>;

/** Shared server access and publication ownership, independent of commands, tools, and hooks. */
export class ServerService {
    private readonly pendingUploads = new Map<Promise<ArchiveUploadReport>, AbortController>();
    private readonly requests = new Set<AbortController>();
    private closing = false;

    constructor(
        readonly store = new ServerConfigStore(),
        readonly checkConnection = checkServerVersion,
        private readonly uploadArchive: UploadArchive = (config, manager, scope, signal) => (
            this.archive(config).upload(manager, scope, signal)
        ),
    ) {
    }

    startSession(): void {
        this.closing = false;
    }

    beginRequest(): AbortController | undefined {
        if (this.closing) return undefined;
        const controller = new AbortController();
        this.requests.add(controller);
        return controller;
    }

    finishRequest(controller: AbortController): void {
        this.requests.delete(controller);
    }

    beginShutdown(): void {
        if (this.closing) return;
        this.closing = true;
        for (const controller of this.requests) controller.abort();
        this.abortUploads();
    }

    archive(config: ServerConfig, options: SessionArchiveOptions = {}): SessionArchive {
        return new SessionArchive(config, options);
    }

    async upload(
        config: ServerConfig, manager: SessionManager, scope: "current" | "all", signal?: AbortSignal,
    ): Promise<ArchiveUploadReport> {
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        combined.throwIfAborted();
        const pending = this.uploadArchive(config, manager, scope, combined);
        this.pendingUploads.set(pending, controller);
        try {
            return await pending;
        } finally {
            this.pendingUploads.delete(pending);
        }
    }

    abortUploads(): void {
        for (const controller of this.pendingUploads.values()) controller.abort();
    }

    async drainUploads(): Promise<void> {
        await Promise.allSettled([...this.pendingUploads.keys()]);
    }
}
