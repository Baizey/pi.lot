import fs from "node:fs";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {SqliteDatabase} from "../storage/sqlite.js";
import {
    decodeArchiveBinding,
    decodeArchiveId,
    decodeArchiveMetadata,
    MAX_ARCHIVE_BYTES,
    decodeArchivePublication,
    decodeArchiveReceipt,
    type ArchiveMetadata,
    type Binding,
    type Publication,
    type Receipt,
} from "./ArchiveProtocol.js";

export type ArchiveUploadSnapshot = {
    file: string;
    sessionId: string;
    body: Buffer;
    metadata: ArchiveMetadata;
};

export type ArchivePendingUpload = {kind: "pending"; request: Publication; body: Buffer};
export type ArchivePreparedUpload = {kind: "unchanged"} | ArchivePendingUpload;
export type ArchiveCaptureSummary = {
    id: string;
    source: string;
    sessionId: string;
    byteLength: number;
    sha256: string;
    metadata: ArchiveMetadata;
};
export type ArchiveCapturePage = {captures: ArchiveCaptureSummary[]; nextCursor?: string};
export type ArchivePendingOperation = {origin: string; binding: Binding; source: string; request: Publication};
export type ArchiveJournalOptions = {backlogByteLimit?: number};
const DEFAULT_BACKLOG_BYTES = 512 * 1024 * 1024;
const INVALID_JOURNAL = "Archive upload journal is invalid. Keep it intact for receipt recovery; no upload was sent.";
type CapturedSnapshot = ArchiveCaptureSummary & {body: Buffer};

type JournalRow = {
    source: string;
    accepted: Receipt | undefined;
    pending: Publication | undefined;
    body: Buffer | undefined;
};

/** One-way upload authority, not a downloaded catalog or a local session mirror. */
export class ArchiveJournal {
    private readonly database: SqliteDatabase;
    private readonly backlogByteLimit: number;

    constructor(directory: string, options: ArchiveJournalOptions = {}) {
        const limit = options.backlogByteLimit ?? DEFAULT_BACKLOG_BYTES;
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > DEFAULT_BACKLOG_BYTES) {
            throw new Error("Invalid archive backlog byte limit.");
        }
        this.backlogByteLimit = limit;
        ensureDurableArchiveDirectory(directory);
        const file = path.join(directory, "archive.sqlite");
        this.prepareFile(file);
        for (const suffix of ["-wal", "-shm"]) this.checkFile(`${file}${suffix}`, true);
        const database = SqliteDatabase.test(false, file);
        try {
            database.exec("PRAGMA synchronous=FULL");
            // Additive migration: legacy authority, immutable pending bodies, and
            // receipt text are never decoded/re-written just by opening the journal.
            database.transaction(() => database.exec(`
                CREATE TABLE IF NOT EXISTS archive_uploads (
                    profile TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    accepted TEXT,
                    pending TEXT,
                    body BLOB,
                    PRIMARY KEY (profile, session_id),
                    CHECK ((pending IS NULL) = (body IS NULL))
                );
                CREATE TABLE IF NOT EXISTS archive_captures (
                    profile TEXT NOT NULL,
                    capture_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    byte_length INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    metadata TEXT NOT NULL,
                    body BLOB NOT NULL,
                    PRIMARY KEY (profile, capture_id),
                    CHECK (byte_length >= 0 AND byte_length = length(body))
                );
            `)).immediate();
            this.database = database;
        } catch {
            database.close();
            throw new Error("Unable to initialize the archive upload journal.");
        }
    }

    prepare(origin: string, binding: Binding, snapshot: ArchiveUploadSnapshot): ArchivePreparedUpload {
        const profile = this.profile(origin, binding);
        const captured = this.normalizeSnapshot(snapshot);
        const outcome = this.database.transaction((): {result: ArchivePreparedUpload} | {error: unknown} => {
            const current = this.read(profile, captured.sessionId);
            this.checkSource(current, captured.source);
            // Avoid re-storing bytes already owned by this exact pending operation
            // or covered by our accepted receipt, including an over-budget legacy row.
            if (current?.pending && current.body && this.matches(current.pending, captured)) {
                return {result: {kind: "pending", request: current.pending, body: current.body}};
            }
            if (!current?.pending && current?.accepted && this.matches(current.accepted.request, captured)) {
                return {result: {kind: "unchanged"}};
            }
            // Holding the outer lock prevents another process consuming this exact
            // capture between insertion and promotion. A failed promotion rolls back
            // only its savepoint; commit the retained capture before reporting failure.
            this.storeCapture(profile, captured);
            try {
                return {result: this.prepareCaptured(origin, binding, captured.id)};
            } catch (error) {
                return {error};
            }
        }).immediate();
        if ("error" in outcome) throw outcome.error;
        return outcome.result;
    }

    /** Captured evidence is immutable, but does not authorize a publication or adopt a remote base. */
    capture(origin: string, binding: Binding, snapshot: ArchiveUploadSnapshot): string {
        const captured = this.normalizeSnapshot(snapshot);
        this.storeCapture(this.profile(origin, binding), captured);
        return captured.id;
    }

    captures(origin: string, binding: Binding, options: {cursor?: string; limit?: number} = {}): ArchiveCapturePage {
        const limit = options.limit ?? 64;
        if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid archive capture page limit.");
        if (options.cursor !== undefined) this.checkCaptureId(options.cursor);
        const rows = this.database.prepare(`
            SELECT capture_id, session_id, source, byte_length, sha256, metadata
            FROM archive_captures WHERE profile=? AND capture_id>? ORDER BY capture_id LIMIT ?
        `).all(this.profile(origin, binding), options.cursor ?? "", limit + 1);
        const captures = rows.slice(0, limit).map((row) => this.decodeCapture(row));
        return {captures, ...(rows.length > limit ? {nextCursor: captures.at(-1)!.id} : {})};
    }

    prepareCaptured(origin: string, binding: Binding, captureId: string): ArchivePreparedUpload {
        const profile = this.profile(origin, binding);
        this.checkCaptureId(captureId);
        return this.database.transaction((): ArchivePreparedUpload => {
            const captured = this.readCapture(profile, captureId);
            if (!captured) throw new Error("Archive capture is no longer available; enumerate the durable work again.");
            const current = this.read(profile, captured.sessionId);
            this.checkSource(current, captured.source);
            // An unresolved predecessor never consumes or replaces a successor capture.
            if (current?.pending && current.body) return {kind: "pending", request: current.pending, body: current.body};
            if (current?.accepted && this.matches(current.accepted.request, captured)) {
                this.removeCapture(profile, captureId);
                return {kind: "unchanged"};
            }
            const base = current?.accepted?.request;
            if (base && (captured.body.length < base.byte_length
                || createHash("sha256").update(captured.body.subarray(0, base.byte_length)).digest("hex") !== base.sha256)) {
                throw new Error("The local session no longer extends its last accepted snapshot. Restore the complete history or fork a new session before uploading.");
            }
            const request = decodeArchivePublication({
                binding, session_id: captured.sessionId, operation_id: randomUUID(),
                condition: current?.accepted ? {kind: "exact_base_revision", revision: current.accepted.revision} : {kind: "absent"},
                byte_length: captured.byteLength, sha256: captured.sha256, metadata: captured.metadata,
            });
            // Transfer ownership atomically: either the capture or the immutable
            // pending operation retains these bytes after any interrupted commit.
            this.database.prepare(`
                INSERT INTO archive_uploads(profile, session_id, source, pending, body)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile, session_id) DO UPDATE SET pending=excluded.pending, body=excluded.body
            `).run(profile, captured.sessionId, captured.source, JSON.stringify(request), captured.body);
            this.removeCapture(profile, captureId);
            return {kind: "pending", request, body: captured.body};
        }).immediate();
    }

    /** Read-only inventory, not permission to execute against the current configuration. */
    *pendingOperations(): IterableIterator<ArchivePendingOperation> {
        let cursor: {profile: string; sessionId: string} | undefined;
        for (;;) {
            // Finish each statement before yielding. A caller can safely accept an
            // operation (or await HTTP) without pinning a SQLite read iterator.
            const rows = this.database.prepare(`
                SELECT profile, session_id, source, pending FROM archive_uploads
                WHERE pending IS NOT NULL AND (? IS NULL OR (profile, session_id) > (?, ?))
                ORDER BY profile, session_id LIMIT 64
            `).all(cursor?.profile ?? null, cursor?.profile ?? "", cursor?.sessionId ?? "");
            for (const row of rows) {
                const {profile, operation} = this.decodePendingOperation(row);
                cursor = {profile, sessionId: operation.request.session_id};
                yield operation;
            }
            if (rows.length < 64) return;
        }
    }

    pendingRequests(origin: string, binding: Binding): Array<{source: string; request: Publication}> {
        const profile = this.profile(origin, binding);
        const rows = this.database.prepare(
            "SELECT profile, session_id, source, pending FROM archive_uploads WHERE profile=? AND pending IS NOT NULL",
        ).all(profile);
        return rows.map((row) => {
            const {source, request} = this.decodePendingOperation(row).operation;
            return {source, request};
        });
    }

    pending(origin: string, binding: Binding, sessionId: string, operationId: string): ArchivePendingUpload | undefined {
        const current = this.read(this.profile(origin, binding), sessionId);
        return current?.pending?.operation_id === operationId && current.body
            ? {kind: "pending", request: current.pending, body: current.body} : undefined;
    }

    accept(origin: string, receipt: Receipt): void {
        const validated = decodeArchiveReceipt(receipt);
        const profile = this.profile(origin, validated.request.binding);
        this.database.transaction(() => {
            const current = this.read(profile, validated.request.session_id);
            if (!current) throw new Error("Archive receipt has no matching local upload operation.");
            if (!current.pending || !isDeepStrictEqual(current.pending, validated.request)) {
                // A sibling uploader may already have accepted this operation and
                // prepared its successor. Its state must never regress to our reply.
                if (current.accepted && BigInt(current.accepted.revision.seq) >= BigInt(validated.revision.seq)) return;
                throw new Error("Archive receipt does not match the pending local operation.");
            }
            this.database.prepare(`
                UPDATE archive_uploads SET accepted=?, pending=NULL, body=NULL
                WHERE profile=? AND session_id=?
            `).run(JSON.stringify(validated), profile, validated.request.session_id);
        }).immediate();
    }

    close(): void {
        this.database.close();
    }

    private read(profile: string, sessionId: string): JournalRow | undefined {
        const value = this.database.prepare(
            "SELECT source, accepted, pending, body FROM archive_uploads WHERE profile=? AND session_id=?",
        ).get(profile, sessionId);
        if (value === undefined) return undefined;
        if (typeof value !== "object" || value === null) throw new Error("Invalid archive upload journal.");
        const row = value as Record<string, unknown>;
        try {
            if (typeof row.source !== "string" || !path.isAbsolute(row.source)
                || (row.accepted !== null && typeof row.accepted !== "string")
                || (row.pending !== null && typeof row.pending !== "string")
                || (row.body !== null && !Buffer.isBuffer(row.body))) {
                throw new Error("Invalid journal row");
            }
            const accepted = typeof row.accepted === "string" ? decodeArchiveReceipt(JSON.parse(row.accepted)) : undefined;
            const pending = typeof row.pending === "string" ? decodeArchivePublication(JSON.parse(row.pending)) : undefined;
            const body = Buffer.isBuffer(row.body) ? row.body : undefined;
            if (Boolean(pending) !== Boolean(body)
                || (pending && (pending.session_id !== sessionId || !this.matchesProfile(profile, pending)))
                || (accepted && (accepted.request.session_id !== sessionId
                    || !this.matchesProfile(profile, accepted.request)))
                || (pending && body && (body.length !== pending.byte_length
                    || createHash("sha256").update(body).digest("hex") !== pending.sha256))) {
                throw new Error("Invalid journal operation");
            }
            return {source: row.source, accepted, pending, body};
        } catch {
            throw new Error("Archive upload journal is invalid. Keep it intact for receipt recovery; no upload was sent.");
        }
    }

    private decodePendingOperation(value: unknown): {profile: string; operation: ArchivePendingOperation} {
        try {
            if (typeof value !== "object" || value === null) throw new Error("Invalid row");
            const row = value as Record<string, unknown>;
            if (typeof row.profile !== "string" || typeof row.source !== "string" || row.source.includes("\0")
                || !path.isAbsolute(row.source) || typeof row.pending !== "string") throw new Error("Invalid row");
            const identity: unknown = JSON.parse(row.profile);
            if (!Array.isArray(identity) || typeof identity[0] !== "string") throw new Error("Invalid profile");
            const request = decodeArchivePublication(JSON.parse(row.pending));
            if (request.session_id !== row.session_id || !this.matchesProfile(row.profile, request)) throw new Error("Invalid operation");
            return {profile: row.profile, operation: {origin: identity[0], binding: request.binding, source: row.source, request}};
        } catch {
            throw new Error(INVALID_JOURNAL);
        }
    }

    private normalizeSnapshot(snapshot: ArchiveUploadSnapshot): CapturedSnapshot {
        const sessionId = decodeArchiveId(snapshot.sessionId);
        if (typeof snapshot.file !== "string" || !path.isAbsolute(snapshot.file) || snapshot.file.includes("\0")
            || !Buffer.isBuffer(snapshot.body) || snapshot.body.length > MAX_ARCHIVE_BYTES) {
            throw new Error("Invalid archive snapshot.");
        }
        const metadata = decodeArchiveMetadata(snapshot.metadata, sessionId);
        const body = Buffer.from(snapshot.body);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const captured = {source: snapshot.file, sessionId, byteLength: body.length, sha256, metadata};
        return {id: this.captureId(captured), ...captured, body};
    }

    private storeCapture(profile: string, captured: CapturedSnapshot): void {
        this.database.transaction(() => {
            // Idempotent acknowledgment must still prove the retained bytes exist
            // intact; never claim a fresh source is captured over corrupt evidence.
            if (this.readCapture(profile, captured.id)) return;
            // Logical retained-body budget, not an RSS/filesystem bound. Legacy
            // over-budget bodies remain readable and replayable; none are evicted.
            const usage = this.database.prepare(`
                SELECT COALESCE((SELECT SUM(length(body)) FROM archive_uploads), 0)
                    + COALESCE((SELECT SUM(length(body)) FROM archive_captures), 0) AS bytes
            `).get() as {bytes: number};
            if (usage.bytes + captured.byteLength > this.backlogByteLimit) {
                throw new Error("Archive backlog is full. Existing unsent history was retained; this source was not captured.");
            }
            this.database.prepare(`
                INSERT INTO archive_captures(profile, capture_id, session_id, source, byte_length, sha256, metadata, body)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(profile, captured.id, captured.sessionId, captured.source, captured.byteLength,
                captured.sha256, JSON.stringify(captured.metadata), captured.body);
        }).immediate();
    }

    private readCapture(profile: string, captureId: string): CapturedSnapshot | undefined {
        const value = this.database.prepare("SELECT * FROM archive_captures WHERE profile=? AND capture_id=?")
            .get(profile, captureId);
        if (value === undefined) return undefined;
        const summary = this.decodeCapture(value);
        const row = value as Record<string, unknown>;
        if (!Buffer.isBuffer(row.body) || row.body.length !== summary.byteLength
            || createHash("sha256").update(row.body).digest("hex") !== summary.sha256) {
            throw new Error(INVALID_JOURNAL);
        }
        return {...summary, body: row.body};
    }

    private decodeCapture(value: unknown): ArchiveCaptureSummary {
        try {
            if (typeof value !== "object" || value === null) throw new Error("Invalid capture");
            const row = value as Record<string, unknown>;
            const sessionId = decodeArchiveId(row.session_id);
            if (typeof row.capture_id !== "string" || typeof row.source !== "string" || !path.isAbsolute(row.source)
                || row.source.includes("\0") || typeof row.sha256 !== "string" || row.sha256.length !== 64 || !/^[0-9a-f]+$/.test(row.sha256)
                || typeof row.byte_length !== "number" || !Number.isInteger(row.byte_length)
                || row.byte_length < 0 || row.byte_length > MAX_ARCHIVE_BYTES || typeof row.metadata !== "string") {
                throw new Error("Invalid capture");
            }
            const summary = {id: row.capture_id, source: row.source, sessionId, byteLength: row.byte_length,
                sha256: row.sha256, metadata: decodeArchiveMetadata(JSON.parse(row.metadata), sessionId)};
            if (summary.id !== this.captureId(summary)) throw new Error("Invalid capture fingerprint");
            return summary;
        } catch {
            throw new Error(INVALID_JOURNAL);
        }
    }

    private captureId(captured: Omit<ArchiveCaptureSummary, "id">): string {
        return createHash("sha256").update(JSON.stringify([
            captured.source, captured.sessionId, captured.byteLength, captured.sha256, captured.metadata,
        ])).digest("hex");
    }

    private checkCaptureId(value: string): void {
        if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]+$/.test(value)) {
            throw new Error("Invalid archive capture ID.");
        }
    }

    private removeCapture(profile: string, captureId: string): void {
        this.database.prepare("DELETE FROM archive_captures WHERE profile=? AND capture_id=?").run(profile, captureId);
    }

    private checkSource(current: JournalRow | undefined, source: string): void {
        if (current && current.source !== source) {
            throw new Error("This session ID is already associated with a different local file. Upload a separately forked session instead.");
        }
    }

    private matches(request: Publication, captured: ArchiveCaptureSummary): boolean {
        return request.session_id === captured.sessionId && request.byte_length === captured.byteLength
            && request.sha256 === captured.sha256 && isDeepStrictEqual(request.metadata, captured.metadata);
    }

    private profile(origin: string, binding: Binding): string {
        const validated = decodeArchiveBinding(binding);
        return JSON.stringify([origin, validated.server_id, validated.namespace_id, validated.history_generation]);
    }

    private matchesProfile(profile: string, request: Publication): boolean {
        const value: unknown = JSON.parse(profile);
        return Array.isArray(value) && typeof value[0] === "string" && this.profile(value[0], request.binding) === profile;
    }

    private prepareFile(file: string): void {
        let descriptor: number;
        try {
            descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw new Error("Unable to create the private archive upload journal.");
            }
            this.checkFile(file);
            return;
        }
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        syncArchiveDirectory(path.dirname(file));
    }

    private checkFile(file: string, optional = false): void {
        let descriptor: number;
        try {
            descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        } catch (error) {
            if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") return;
            throw new Error("Archive upload journal must be a private regular file.");
        }
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
                throw new Error("Archive upload journal must be a private regular file.");
            }
        } finally {
            fs.closeSync(descriptor);
        }
    }
}

export function ensureArchiveDirectory(directory: string): void {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    checkArchiveDirectory(directory);
}

function ensureDurableArchiveDirectory(directory: string): void {
    const parent = path.dirname(path.resolve(directory));
    try {
        syncArchiveDirectory(parent);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        ensureDurableArchiveDirectory(parent);
    }
    // Establish the parent's name BEFORE creating its child. Incremental
    // creation leaves at most one unsynced link on failure, so retries and
    // concurrent initializers can safely finish the same ordering.
    syncArchiveDirectory(path.dirname(parent));
    try {
        fs.mkdirSync(directory, {mode: 0o700});
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    checkArchiveDirectory(directory);
    syncArchiveDirectory(directory);
    syncArchiveDirectory(parent);
}

function checkArchiveDirectory(directory: string): void {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("Archive storage must be a private directory, not a symlink.");
    }
}

function syncArchiveDirectory(directory: string): void {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}
