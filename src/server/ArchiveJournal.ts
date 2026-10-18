import fs from "node:fs";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {SqliteDatabase} from "../storage/sqlite.js";
import {
    decodeArchiveMetadata,
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

type JournalRow = {
    source: string;
    accepted: Receipt | undefined;
    pending: Publication | undefined;
    body: Buffer | undefined;
};

/** One-way upload authority, not a downloaded catalog or a local session mirror. */
export class ArchiveJournal {
    private readonly database: SqliteDatabase;

    constructor(directory: string) {
        ensureDurableArchiveDirectory(directory);
        const file = path.join(directory, "archive.sqlite");
        this.prepareFile(file);
        for (const suffix of ["-wal", "-shm"]) this.checkFile(`${file}${suffix}`, true);
        const database = SqliteDatabase.test(false, file);
        try {
            database.exec(`
                PRAGMA synchronous=FULL;
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
            `);
            this.database = database;
        } catch {
            database.close();
            throw new Error("Unable to initialize the archive upload journal.");
        }
    }

    prepare(origin: string, binding: Binding, snapshot: ArchiveUploadSnapshot): ArchivePreparedUpload {
        const profile = this.profile(origin, binding);
        return this.database.transaction((): ArchivePreparedUpload => {
            const current = this.read(profile, snapshot.sessionId);
            if (current && current.source !== snapshot.file) {
                throw new Error("This session ID is already associated with a different local file. Upload a separately forked session instead.");
            }
            if (current?.pending && current.body) {
                return {kind: "pending", request: current.pending, body: current.body};
            }
            const sha256 = createHash("sha256").update(snapshot.body).digest("hex");
            if (current?.accepted && this.matches(current.accepted.request, snapshot, sha256)) {
                return {kind: "unchanged"};
            }
            const base = current?.accepted?.request;
            if (base && (snapshot.body.length < base.byte_length
                || createHash("sha256").update(snapshot.body.subarray(0, base.byte_length)).digest("hex") !== base.sha256)) {
                throw new Error("The local session no longer extends its last accepted snapshot. Restore the complete history or fork a new session before uploading.");
            }
            const request = decodeArchivePublication({
                binding,
                session_id: snapshot.sessionId,
                operation_id: randomUUID(),
                condition: current?.accepted
                    ? {kind: "exact_base_revision", revision: current.accepted.revision}
                    : {kind: "absent"},
                byte_length: snapshot.body.length,
                sha256,
                metadata: snapshot.metadata,
            });
            // Commit both the immutable request and its exact bytes BEFORE sending it.
            // Two local Pi processes may replay this same operation concurrently.
            this.database.prepare(`
                INSERT INTO archive_uploads(profile, session_id, source, pending, body)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile, session_id) DO UPDATE SET pending=excluded.pending, body=excluded.body
            `).run(profile, snapshot.sessionId, snapshot.file, JSON.stringify(request), snapshot.body);
            return {kind: "pending", request, body: snapshot.body};
        }).immediate();
    }

    pendingRequests(origin: string, binding: Binding): Array<{source: string; request: Publication}> {
        const profile = this.profile(origin, binding);
        const rows = this.database.prepare(
            "SELECT source, pending FROM archive_uploads WHERE profile=? AND pending IS NOT NULL",
        ).all(profile);
        return rows.map((value) => {
            if (typeof value !== "object" || value === null) throw new Error("Invalid archive upload journal.");
            const row = value as Record<string, unknown>;
            try {
                if (typeof row.source !== "string" || !path.isAbsolute(row.source) || typeof row.pending !== "string") {
                    throw new Error("Invalid journal row");
                }
                const request = decodeArchivePublication(JSON.parse(row.pending));
                if (!this.matchesProfile(profile, request)) throw new Error("Invalid journal profile");
                return {source: row.source, request};
            } catch {
                throw new Error("Archive upload journal is invalid. Keep it intact for receipt recovery; no upload was sent.");
            }
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

    private matches(request: Publication, snapshot: ArchiveUploadSnapshot, sha256: string): boolean {
        return request.session_id === snapshot.sessionId
            && request.byte_length === snapshot.body.length
            && request.sha256 === sha256
            && isDeepStrictEqual(request.metadata, decodeArchiveMetadata(snapshot.metadata, snapshot.sessionId));
    }

    private profile(origin: string, binding: Binding): string {
        return JSON.stringify([origin, binding.server_id, binding.namespace_id, binding.history_generation]);
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
