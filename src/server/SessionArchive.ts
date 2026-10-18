import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ArchiveClient} from "./ArchiveClient.js";
import {ArchiveJournal, ensureArchiveDirectory, type ArchivePendingUpload, type ArchiveUploadSnapshot} from "./ArchiveJournal.js";
import {ArchiveSessions, getArchiveRootSessionId} from "./ArchiveSessions.js";
import type {ServerConfig} from "./ServerConfig.js";
import {decodeArchiveMetadata, type Binding, type ListFilters, type ListPage, type Publication, type SessionMetadata} from "./ArchiveProtocol.js";

type ArchiveSessionManager = ExtensionContext["sessionManager"];
export type ArchiveClientInterface = Pick<ArchiveClient, "binding" | "list" | "publish" | "receipt" | "download">;
export type ArchiveUploadReport = {
    uploaded: number;
    unchanged: number;
    failed: number;
    warnings: string[];
    failures: Array<{file: string; message: string}>;
};
export type ArchiveListInput = {filters?: ListFilters; cursor?: string; limit?: number};
export type SessionArchiveOptions = {
    client?: ArchiveClientInterface;
    stateDirectory?: string;
    beforeRequest?: (method: "GET" | "POST", path: string, signal?: AbortSignal) => Promise<void>;
    createSessions?: (manager: ArchiveSessionManager) => Pick<ArchiveSessions, "discover" | "snapshot">;
};

/** Explicit one-way uploads and lazy retrieval, never a startup/shutdown synchronizer. */
export class SessionArchive {
    private readonly client: ArchiveClientInterface;
    private readonly directory: string;

    constructor(private readonly config: ServerConfig, private readonly options: SessionArchiveOptions = {}) {
        this.client = options.client ?? new ArchiveClient(config, {beforeRequest: options.beforeRequest});
        this.directory = options.stateDirectory ?? path.join(os.homedir(), ".pilot", "server-archive");
    }

    async upload(
        manager: ArchiveSessionManager,
        scope: "current" | "all",
        signal?: AbortSignal,
    ): Promise<ArchiveUploadReport> {
        signal?.throwIfAborted();
        const sessions = this.options.createSessions?.(manager) ?? new ArchiveSessions(manager);
        const report: ArchiveUploadReport = {uploaded: 0, unchanged: 0, failed: 0, warnings: [], failures: []};
        let binding: Binding | undefined;
        let journal: ArchiveJournal | undefined;
        const recovered = new Set<string>();
        const failed = new Set<string>();
        try {
            // Frozen operations are independently recoverable even if their live
            // files were deleted, became invalid, or changed identity after a crash.
            if (fs.existsSync(path.join(this.directory, "archive.sqlite"))) {
                binding = (await this.client.binding(signal)).binding;
                journal = new ArchiveJournal(this.directory);
                const root = getArchiveRootSessionId(manager);
                for (const pending of journal.pendingRequests(this.config.url, binding)) {
                    const selected = scope === "all" || pending.request.session_id === manager.getSessionId()
                        || (root !== undefined && pending.request.metadata?.root_session_id === root);
                    if (!selected) continue;
                    signal?.throwIfAborted();
                    try {
                        const operation = journal.pending(this.config.url, binding,
                            pending.request.session_id, pending.request.operation_id);
                        if (!operation) continue;
                        await this.publishPending(journal, operation, signal);
                        recovered.add(pending.source);
                    } catch (error) {
                        signal?.throwIfAborted();
                        failed.add(pending.source);
                        this.recordFailure(report, pending.source, error);
                    }
                }
            }
            const discovered = await sessions.discover(scope, signal);
            report.warnings.push(...discovered.warnings.slice(0, 20));
            if (discovered.files.length === 0) {
                report.uploaded += recovered.size;
                return report;
            }
            const uploadBinding = binding ?? (await this.client.binding(signal)).binding;
            const uploadJournal = journal ?? new ArchiveJournal(this.directory);
            journal = uploadJournal;
            for (const file of discovered.files) {
                signal?.throwIfAborted();
                if (failed.has(file)) continue;
                try {
                    const outcome = await this.uploadFile(uploadJournal, sessions, uploadBinding, file, report.warnings, signal);
                    report[outcome === "unchanged" && recovered.has(file) ? "uploaded" : outcome]++;
                } catch (error) {
                    signal?.throwIfAborted();
                    this.recordFailure(report, file, error);
                }
                recovered.delete(file);
            }
            report.uploaded += recovered.size;
            return report;
        } finally {
            journal?.close();
        }
    }

    async list(input: ArchiveListInput = {}, signal?: AbortSignal): Promise<ListPage> {
        const {binding} = await this.client.binding(signal);
        return this.client.list({binding, filters: input.filters, cursor: input.cursor, limit: input.limit ?? 50}, signal);
    }

    async fetch(sessionId: string, signal?: AbortSignal): Promise<{snapshot: SessionMetadata; path: string}> {
        const {binding} = await this.client.binding(signal);
        const downloaded = await this.client.download(binding, sessionId, signal);
        signal?.throwIfAborted();
        const directory = path.join(this.directory, "downloads", this.bindingKey(binding));
        ensureArchiveDirectory(this.directory);
        ensureArchiveDirectory(path.join(this.directory, "downloads"));
        ensureArchiveDirectory(directory);
        const identity = createHash("sha256").update(sessionId).digest("hex");
        const destination = path.join(directory, `${identity}-${downloaded.snapshot.sha256}.jsonl`);
        this.writeCache(destination, downloaded.body);
        return {snapshot: downloaded.snapshot, path: destination};
    }

    private async uploadFile(
        journal: ArchiveJournal,
        sessions: Pick<ArchiveSessions, "snapshot">,
        binding: Binding,
        file: string,
        warnings: string[],
        signal?: AbortSignal,
    ): Promise<"uploaded" | "unchanged"> {
        let accepted = false;
        // Normally one operation. A previous interrupted snapshot is settled
        // first, then the live file is recaptured before preparing its successor.
        for (let attempt = 0; attempt < 3; attempt++) {
            const snapshot = await sessions.snapshot(file, signal);
            for (const warning of snapshot.warnings) {
                if (warnings.length < 20 && !warnings.includes(warning)) warnings.push(warning);
            }
            signal?.throwIfAborted();
            const prepared = journal.prepare(this.config.url, binding, snapshot);
            if (prepared.kind === "unchanged") return accepted ? "uploaded" : "unchanged";
            // Unknown is not rejection: publish precisely the same durable
            // operation, never a fresh operation ID or a newly observed base.
            await this.publishPending(journal, prepared, signal);
            accepted = true;
            if (this.matches(prepared.request, snapshot)) return "uploaded";
        }
        throw new Error("The local upload state kept changing concurrently. Retry the same command after other uploaders finish.");
    }

    private async publishPending(journal: ArchiveJournal, pending: ArchivePendingUpload, signal?: AbortSignal): Promise<void> {
        const outcome = await this.client.receipt(pending.request, signal);
        const receipt = outcome.status === "accepted" ? outcome.receipt
            : await this.client.publish(pending.request, pending.body, signal);
        journal.accept(this.config.url, receipt);
    }

    private recordFailure(report: ArchiveUploadReport, file: string, error: unknown): void {
        report.failed++;
        if (report.failures.length < 20) report.failures.push({file, message: this.failureMessage(error)});
    }

    private matches(request: Publication, snapshot: ArchiveUploadSnapshot): boolean {
        return request.byte_length === snapshot.body.length
            && request.sha256 === createHash("sha256").update(snapshot.body).digest("hex")
            && isDeepStrictEqual(request.metadata, decodeArchiveMetadata(snapshot.metadata, snapshot.sessionId));
    }

    private bindingKey(binding: Binding): string {
        return createHash("sha256").update(JSON.stringify([
            this.config.url, binding.server_id, binding.namespace_id, binding.history_generation,
        ])).digest("hex");
    }

    private writeCache(destination: string, body: Buffer): void {
        const temporary = path.join(path.dirname(destination), `.download-${randomUUID()}.tmp`);
        let created = false;
        try {
            const descriptor = fs.openSync(temporary, "wx", 0o600);
            created = true;
            try {
                fs.writeFileSync(descriptor, body);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            fs.renameSync(temporary, destination);
        } finally {
            if (created) fs.rmSync(temporary, {force: true});
        }
    }

    private failureMessage(error: unknown): string {
        const message = error instanceof Error ? error.message : "Archive upload failed.";
        return message.split(this.config.apiKey).join("[redacted]")
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 1024);
    }
}
