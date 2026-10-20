import path from "node:path";
import {ArchiveInbox, ArchiveInboxBusyError, ArchiveInboxInvalidError, type ArchiveControl} from "./ArchiveInbox.js";
import {ArchiveLock} from "./ArchiveLock.js";
import {ServerConfigStore} from "./ServerConfig.js";
import {ArchiveWorkerEngine} from "./ArchiveWorkerEngine.js";
import {ArchiveManifestError} from "./ArchiveWorkerState.js";

const POLL_MILLISECONDS = 5000;

/** The detached process, not an agent session, owns this resource lifetime. */
export class ArchiveWorker {
    private readonly inbox: ArchiveInbox;
    private readonly lock: ArchiveLock;

    constructor(private readonly directory: string, private readonly store: ServerConfigStore) {
        this.inbox = new ArchiveInbox(directory);
        this.lock = new ArchiveLock(path.join(directory, "worker.lock"));
    }

    async run(): Promise<void> {
        if (!this.lock.acquire()) return;
        let engine: ArchiveWorkerEngine | undefined;
        let ownsLock = true;
        try {
            engine = new ArchiveWorkerEngine(this.directory, this.store);
            for (;;) {
                const generation = this.store.connection()?.generation;
                const control = this.control();
                const retained: string[] = [];
                let retryAcknowledgment = false;
                for (const id of this.inbox.ids()) {
                    try {
                        const manifest = this.inbox.readManifest(id);
                        if (!manifest) continue;
                        if (!engine.import(manifest)) {
                            retained.push(id);
                            continue;
                        }
                    } catch (error) {
                        if (!(error instanceof ArchiveInboxInvalidError) && !(error instanceof ArchiveManifestError)) throw error;
                        // Validation includes immutable-ID collisions discovered by
                        // the transactional importer. Retain evidence, but never turn
                        // a storage/I/O failure into an invalid-descriptor outcome.
                        retained.push(id);
                        continue;
                    }
                    // The engine transaction is committed before producer admission is
                    // locked for removal. Re-import after a crash is idempotent.
                    try { this.inbox.acknowledge(id); } catch (error) {
                        if (!(error instanceof ArchiveInboxBusyError)) throw error;
                        retryAcknowledgment = true;
                    }
                }
                const state = await engine.step();
                if (control) {
                    try { this.inbox.acknowledgeControl(control); } catch (error) {
                        if (error instanceof ArchiveInboxBusyError) retryAcknowledgment = true;
                        else if (!(error instanceof ArchiveInboxInvalidError)) throw error;
                    }
                }
                if (state.eligible || retryAcknowledgment) {
                    // Keep a referenced timer even for distant persisted retries. Poll
                    // new descriptors and authorization at least every five seconds.
                    const delay = retryAcknowledgment ? 250 : state.nextDue === undefined ? 0
                        : Math.min(POLL_MILLISECONDS, Math.max(0, state.nextDue - Date.now()));
                    await new Promise<void>(resolve => setTimeout(resolve, delay));
                    continue;
                }

                // Never move this inspection above release: a losing contender may
                // have published its event just before our final locked iteration.
                // Closing a writable WAL connection can checkpoint. Do that while
                // still elected; inspect() uses its own fresh read-only connection.
                engine.close();
                this.lock.release();
                ownsLock = false;
                const changed = this.inbox.ids().join(",") !== retained.join(",")
                    || this.control() !== undefined
                    || this.store.connection()?.generation !== generation;
                const remaining = engine.inspect(); // Strictly read-only, fresh SQLite reads.
                if (!changed && !remaining.eligible) return;
                if (!this.lock.acquire()) return; // The winner now owns all mutations.
                ownsLock = true;
            }
        } finally {
            try {
                if (ownsLock) engine?.close();
            } finally {
                this.lock.release();
            }
        }
    }

    private control(): ArchiveControl | undefined {
        try {
            return this.inbox.control();
        } catch (error) {
            if (!(error instanceof ArchiveInboxInvalidError)) throw error;
            // A malformed control file conveys no authorization. Leave its evidence,
            // reload config directly, and allow a subsequent real event to replace it.
            return undefined;
        }
    }
}

export async function runArchiveWorker(directory: string, configDirectory: string): Promise<void> {
    if (!path.isAbsolute(directory) || !path.isAbsolute(configDirectory)) throw new Error("Archive worker requires absolute state paths.");
    await new ArchiveWorker(directory, new ServerConfigStore(configDirectory)).run();
}
