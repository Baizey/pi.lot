import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import Database from "better-sqlite3";
import {SqliteDatabase} from "../storage/sqlite.js";
import {ArchiveJournal, type ArchiveUploadSnapshot} from "./ArchiveJournal.js";
import {decodeArchiveSourceScope, type ArchiveSourceScope} from "./ArchiveSourceScope.js";
import {decodeArchiveSourceEvidence, type ArchiveSourceCapture, type ArchiveSourceEvidence} from "./ArchiveSessions.js";
import {MAX_ARCHIVE_BYTES, decodeArchiveId, decodeArchiveBinding, decodeArchivePublication, decodeArchiveMetadata, decodeArchivePreservation,
    decodeArchiveSessionMetadata, decodeArchiveReceipt, decodeArchivePreservationReceipt,
    sameArchiveBinding, type Binding, type ArchiveMetadata, type Publication, type Preservation} from "./ArchiveProtocol.js";

export type ArchiveManifest = {version: 1; id: string; origin: string; generation: string; source: ArchiveSourceScope};
/** Only malformed/colliding descriptors; database and durability failures are never wrapped. */
export class ArchiveManifestError extends Error {
    constructor(message = "Invalid archive enqueue manifest.") { super(message); this.name = "ArchiveManifestError"; }
}
export type WorkSchedule = {eligible: boolean; nextDue?: number};
export type WorkDestination = {id: string; origin: string; generation: string; binding?: Binding};
export type WorkScope = {id: string; destination: string; source: ArchiveSourceScope; cursor: string | null; attempts: number};
export type WorkSource = {id: number; scope: string; file: string; kind: "file" | "directory"; retryCursor: string | null; attempts: number; missingAttempts: number};
export type WorkCandidate = {id: string; destination: string; sessionId: string; source: string; byteLength: number; sha256: string; metadata: ArchiveMetadata | null; attempts: number};
export type WorkOperation = {id: string; destination: string; candidate: string; kind: "publish" | "uploaded" | "current"; request: string; state: "ready" | "uncertain"; dispatched: boolean; replayBlocked: boolean; attempts: number; dependency: string | null; comparison: string | null};
export type WorkAuthorization = {generation: string; binding?: Binding; capabilities: string[]; blocked: boolean; attempts: number; due: number};
const CANDIDATE_COLUMNS = ["id", "destination", "session_id", "source", "byte_length", "sha256", "metadata", "attempts", "legacy_profile", "legacy_capture"];
// Disputed owned evidence must retain both complete effect keys. This predicate
// grants exclusion only, never transport, base, or coverage authority. CASE keeps
// malformed/non-string request evidence safe even during readonly inspection.
const UNRESOLVED_OPERATION_MATCH = `o.state IN ('ready','uncertain','blocked') AND (
    (od.binding=cd.binding AND p.session_id=c.session_id)
    OR CASE WHEN json_valid(o.request) AND json_valid(cd.binding) THEN
        CASE WHEN json_type(o.request,'$.session_id')='text'
            AND json_type(o.request,'$.binding.server_id')='text'
            AND json_type(o.request,'$.binding.namespace_id')='text'
            AND json_type(o.request,'$.binding.history_generation')='text'
            AND json_type(cd.binding,'$.server_id')='text'
            AND json_type(cd.binding,'$.namespace_id')='text'
            AND json_type(cd.binding,'$.history_generation')='text'
        THEN json_extract(o.request,'$.session_id')=c.session_id
            AND json_extract(o.request,'$.binding.server_id')=json_extract(cd.binding,'$.server_id')
            AND json_extract(o.request,'$.binding.namespace_id')=json_extract(cd.binding,'$.namespace_id')
            AND json_extract(o.request,'$.binding.history_generation')=json_extract(cd.binding,'$.history_generation')
        ELSE 0 END
    ELSE 0 END
)`;
const BACKLOG = 512 * 1024 * 1024;
export const ARCHIVE_WORKING_BYTES = 128 * 1024 * 1024;

/** Additive worker state. Migration preserves raw legacy rows; verified coverage retires exact body ownership. */
export class ArchiveWorkerState {
    private readonly db: SqliteDatabase;
    private working = 0;

    constructor(readonly directory: string) {
        const foundation = new ArchiveJournal(directory);
        foundation.close();
        this.db = SqliteDatabase.test(false, path.join(directory, "archive.sqlite"));
        try {
            this.db.exec("PRAGMA synchronous=FULL");
            this.db.transaction(() => {
                this.db.exec(`
                CREATE TABLE IF NOT EXISTS archive_worker_destinations(id TEXT PRIMARY KEY, origin TEXT NOT NULL, generation TEXT NOT NULL, binding TEXT);
                CREATE TABLE IF NOT EXISTS archive_worker_scopes(id TEXT PRIMARY KEY, destination TEXT NOT NULL, manifest TEXT NOT NULL, source TEXT NOT NULL, cursor TEXT, state TEXT NOT NULL DEFAULT 'ready', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0, diagnostic TEXT);
                CREATE TABLE IF NOT EXISTS archive_worker_sources(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, file TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file', retry_cursor TEXT, evidence TEXT, state TEXT NOT NULL DEFAULT 'ready', attempts INTEGER NOT NULL DEFAULT 0, missing_attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0, diagnostic TEXT, UNIQUE(scope,file));
                CREATE TABLE IF NOT EXISTS archive_worker_candidates(id TEXT PRIMARY KEY, destination TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL, byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL, metadata TEXT NOT NULL, body BLOB, legacy_profile TEXT, legacy_capture TEXT, state TEXT NOT NULL DEFAULT 'ready', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0, diagnostic TEXT);
                CREATE TABLE IF NOT EXISTS archive_worker_operations(id TEXT PRIMARY KEY, destination TEXT NOT NULL, candidate TEXT NOT NULL, kind TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, replay_blocked INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0, dependency TEXT, comparison TEXT, receipt TEXT, diagnostic TEXT);
                CREATE TABLE IF NOT EXISTS archive_worker_coverage(candidate TEXT PRIMARY KEY, evidence TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS archive_worker_candidate_sources(candidate TEXT NOT NULL, source INTEGER NOT NULL, dependencies TEXT NOT NULL, dependency_key TEXT NOT NULL, PRIMARY KEY(candidate,source));
                CREATE TABLE IF NOT EXISTS archive_worker_authorization(generation TEXT PRIMARY KEY, binding TEXT, capabilities TEXT NOT NULL DEFAULT '[]', blocked INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS archive_worker_comparisons(candidate TEXT PRIMARY KEY, snapshot TEXT NOT NULL, body BLOB, list_cursor TEXT);
                CREATE INDEX IF NOT EXISTS archive_worker_source_due ON archive_worker_sources(state,due,turn);
                CREATE INDEX IF NOT EXISTS archive_worker_candidate_due ON archive_worker_candidates(state,due,turn);
                CREATE INDEX IF NOT EXISTS archive_worker_operation_due ON archive_worker_operations(state,due,turn);
                `);
                this.addColumns("archive_worker_scopes", {catalog_revision: "INTEGER NOT NULL DEFAULT 0", review_target: "INTEGER", review_cursor: "INTEGER NOT NULL DEFAULT 0"});
                this.addColumns("archive_worker_sources", {dependencies: "TEXT", dependency_key: "TEXT"});
                if (this.addColumns("archive_worker_operations", {dispatched: "INTEGER NOT NULL DEFAULT 0", replay_blocked: "INTEGER NOT NULL DEFAULT 0"}).includes("dispatched")) {
                    // Earlier ready rows may already be receipt-unknown replays. Migration
                    // cannot prove non-dispatch, so keep their unresolved wire authority.
                    this.db.prepare("UPDATE archive_worker_operations SET dispatched=1 WHERE state IN ('ready','uncertain')").run();
                }
                this.importLegacy();
            }).immediate();
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    import(manifest: ArchiveManifest): boolean {
        let source: ArchiveSourceScope;
        let raw: string;
        try {
            if (manifest.version !== 1 || typeof manifest.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.id)
                || typeof manifest.generation !== "string" || manifest.generation.length > 512 || !manifest.generation.length
                || typeof manifest.origin !== "string" || new URL(manifest.origin).origin !== manifest.origin
                || !["http:", "https:"].includes(new URL(manifest.origin).protocol)
                || Object.keys(manifest).some((key) => !["version", "id", "origin", "generation", "source"].includes(key))) {
                throw new Error("Invalid archive enqueue manifest.");
            }
            source = decodeArchiveSourceScope(manifest.source);
            raw = JSON.stringify({version: 1, id: manifest.id, origin: manifest.origin, generation: manifest.generation, source});
            if (Buffer.byteLength(raw) > 16 * 1024) throw new Error("Archive enqueue manifest exceeds its bound.");
        } catch { throw new ArchiveManifestError(); }
        return this.db.transaction(() => {
            const existing = this.row("SELECT manifest FROM archive_worker_scopes WHERE id=?", manifest.id);
            if (existing) {
                if (existing.manifest !== raw) throw new ArchiveManifestError("Archive enqueue identity collision.");
                return true;
            }
            if (this.count("archive_worker_scopes", "state IN ('ready','scanned')") >= 1024) return false;
            const destination = this.destinationId(manifest.origin, manifest.generation);
            this.db.prepare("INSERT OR IGNORE INTO archive_worker_destinations(id,origin,generation) VALUES (?,?,?)")
                .run(destination, manifest.origin, manifest.generation);
            this.db.prepare("INSERT INTO archive_worker_scopes(id,destination,manifest,source) VALUES (?,?,?,?)")
                .run(manifest.id, destination, raw, JSON.stringify(source));
            return true;
        }).immediate();
    }

    destinations(): WorkDestination[] {
        return this.rows("SELECT * FROM archive_worker_destinations").map((r) => ({id: text(r.id), origin: text(r.origin), generation: text(r.generation),
            ...(r.binding === null ? {} : {binding: decodeArchiveBinding(JSON.parse(text(r.binding)))})}));
    }

    authorization(generation: string): WorkAuthorization {
        const r = this.row("SELECT * FROM archive_worker_authorization WHERE generation=?", generation);
        return r ? {generation, ...(r.binding === null ? {} : {binding: decodeArchiveBinding(JSON.parse(text(r.binding)))}),
            capabilities: JSON.parse(text(r.capabilities)) as string[], blocked: r.blocked === 1, attempts: number(r.attempts), due: number(r.due)}
            : {generation, capabilities: [], blocked: false, attempts: 0, due: 0};
    }

    authorize(generation: string, binding: Binding, capabilities: string[]): void {
        this.db.transaction(() => {
            this.db.prepare("INSERT INTO archive_worker_authorization(generation,binding,capabilities) VALUES (?,?,?) ON CONFLICT(generation) DO UPDATE SET binding=excluded.binding,capabilities=excluded.capabilities,blocked=0,attempts=0,due=0")
                .run(generation, JSON.stringify(binding), JSON.stringify(capabilities));
        }).immediate();
    }

    authorizationFailure(generation: string, blocked: boolean, due: number): void {
        this.db.prepare("INSERT INTO archive_worker_authorization(generation,blocked,attempts,due) VALUES (?,?,1,?) ON CONFLICT(generation) DO UPDATE SET blocked=excluded.blocked,attempts=attempts+1,due=excluded.due,binding=NULL")
            .run(generation, blocked ? 1 : 0, due);
    }

    bind(destination: WorkDestination, binding: Binding): void {
        this.db.transaction(() => {
            if (destination.binding && JSON.stringify(destination.binding) !== JSON.stringify(binding)) {
                this.db.prepare("UPDATE archive_worker_operations SET state='fenced' WHERE destination=? AND state IN ('ready','uncertain','blocked')").run(destination.id);
                this.db.prepare("DELETE FROM archive_worker_comparisons WHERE candidate IN (SELECT id FROM archive_worker_candidates WHERE destination=?)").run(destination.id);
                this.db.prepare("UPDATE archive_worker_candidates SET state='ready',due=0 WHERE destination=? AND state NOT IN ('covered','invalid')").run(destination.id);
            }
            this.db.prepare("UPDATE archive_worker_destinations SET binding=? WHERE id=?").run(JSON.stringify(binding), destination.id);
        }).immediate();
    }

    nextScope(now: number, destinations?: string[]): WorkScope | undefined {
        if (destinations?.length === 0) return undefined;
        const r = this.row(`SELECT * FROM archive_worker_scopes WHERE state='ready' AND due<=? ${destinations ? `AND destination IN (${destinations.map(() => "?").join(",")})` : ""} ORDER BY turn,id LIMIT 1`, now, ...(destinations ?? []));
        return r ? {id: text(r.id), destination: text(r.destination), source: decodeArchiveSourceScope(JSON.parse(text(r.source))), cursor: r.cursor === null ? null : text(r.cursor), attempts: number(r.attempts)} : undefined;
    }

    scope(id: string): WorkScope {
        const r = this.row("SELECT * FROM archive_worker_scopes WHERE id=?", id);
        if (!r) throw new Error("Missing archive scope.");
        return {id, destination: text(r.destination), source: decodeArchiveSourceScope(JSON.parse(text(r.source))), cursor: r.cursor === null ? null : text(r.cursor), attempts: number(r.attempts)};
    }

    addSources(scope: WorkScope, files: string[], cursor: string | null, complete: boolean,
        issues: Array<{path: string; retryCursor: string; code?: string}> = [], updateScope = true): boolean {
        return this.db.transaction(() => {
            const newFiles = [...new Set(files)].filter((file) => !this.row("SELECT id FROM archive_worker_sources WHERE scope=? AND file=?", scope.id, file));
            const newIssues = [...new Map(issues.map((issue) => [issue.path, issue])).values()]
                .filter((issue) => !newFiles.includes(issue.path) && !this.row("SELECT id FROM archive_worker_sources WHERE scope=? AND file=?", scope.id, issue.path));
            if (this.count("archive_worker_sources", "state='ready'") + newFiles.length + newIssues.length > 10000) {
                this.defer("scopes", scope.id, Date.now() + 30_000, "source-capacity");
                return false;
            }
            for (const file of newFiles) this.db.prepare("INSERT INTO archive_worker_sources(scope,file) VALUES (?,?)").run(scope.id, file);
            for (const issue of newIssues) this.db.prepare("INSERT OR IGNORE INTO archive_worker_sources(scope,file,kind,retry_cursor,due,missing_attempts) VALUES (?,?,'directory',?,?,?)")
                .run(scope.id, issue.path, issue.retryCursor, Date.now() + 5000, issue.code === "missing" ? 1 : 0);
            if (updateScope) this.db.prepare("UPDATE archive_worker_scopes SET cursor=?,state=?,turn=?,attempts=0 WHERE id=?")
                .run(cursor, complete ? "scanned" : "ready", Date.now(), scope.id);
            this.completeScopes();
            return true;
        }).immediate();
    }

    nextSource(now: number, destinations?: string[]): WorkSource | undefined {
        if (destinations?.length === 0) return undefined;
        this.reviewSources(now, destinations);
        const r = this.row(`SELECT * FROM archive_worker_sources WHERE state='ready' AND due<=? ${destinations ? `AND scope IN (SELECT id FROM archive_worker_scopes WHERE destination IN (${destinations.map(() => "?").join(",")}))` : ""} ORDER BY turn,id LIMIT 1`, now, ...(destinations ?? []));
        return r ? {id: number(r.id), scope: text(r.scope), file: text(r.file), kind: text(r.kind) as WorkSource["kind"], retryCursor: r.retry_cursor === null ? null : text(r.retry_cursor), attempts: number(r.attempts), missingAttempts: number(r.missing_attempts)} : undefined;
    }

    capture(source: WorkSource, snapshot: ArchiveUploadSnapshot): boolean {
        if (snapshot.file !== source.file || !Buffer.isBuffer(snapshot.body) || snapshot.body.length > MAX_ARCHIVE_BYTES) throw new Error("Invalid archive captured source.");
        decodeArchiveId(snapshot.sessionId);
        const scope = this.scope(source.scope);
        const metadata = decodeArchiveMetadata(snapshot.metadata, snapshot.sessionId);
        const sha256 = createHash("sha256").update(snapshot.body).digest("hex");
        const id = this.candidateId(scope.destination, snapshot.file, snapshot.sessionId, sha256, metadata);
        return this.db.transaction(() => {
            const existing = this.row("SELECT state,legacy_profile FROM archive_worker_candidates WHERE id=?", id);
            const retained = existing ? this.candidate(id) : undefined;
            if (retained && (retained.byteLength !== snapshot.body.length || retained.destination !== scope.destination
                || retained.source !== snapshot.file || retained.sessionId !== snapshot.sessionId || retained.sha256 !== sha256
                || !isDeepStrictEqual(retained.metadata, metadata))) throw new Error("Archive duplicate capture evidence is inconsistent.");
            const destination = this.row("SELECT binding FROM archive_worker_destinations WHERE id=?", scope.destination)!;
            const coverage = this.row("SELECT evidence FROM archive_worker_coverage WHERE candidate=?", id);
            const coveredBinding: unknown = coverage ? (JSON.parse(text(coverage.evidence)) as {binding?: unknown}).binding : undefined;
            const needsRecapture = existing?.state === "covered" && !isDeepStrictEqual(coveredBinding,
                destination.binding === null ? undefined : JSON.parse(text(destination.binding)));
            if (!existing || needsRecapture) {
                if (this.backlogBytes() + snapshot.body.length > BACKLOG) return false;
                if (needsRecapture) {
                    this.db.prepare("UPDATE archive_worker_candidates SET body=?,state='ready',due=0,attempts=0 WHERE id=?")
                        .run(existing?.legacy_profile === null ? snapshot.body : null, id);
                    this.db.prepare("DELETE FROM archive_worker_coverage WHERE candidate=?").run(id);
                } else this.db.prepare("INSERT INTO archive_worker_candidates(id,destination,session_id,source,byte_length,sha256,metadata,body) VALUES (?,?,?,?,?,?,?,?)")
                    .run(id, scope.destination, snapshot.sessionId, snapshot.file, snapshot.body.length, sha256, JSON.stringify(metadata), snapshot.body);
            } else if (existing.state !== "covered") {
                // The incoming stable read already owns a working reservation. Checking
                // another retained body needs a separate reservation; discard only cache
                // bytes, never candidate history, if comparison staging occupies that room.
                if (retained!.byteLength > this.workingAvailable()) this.releaseComparisonBodies();
                const release = this.reserve(retained!.byteLength);
                try { this.body(retained!); } finally { release(); }
            }
            const observation = this.row("SELECT dependencies,dependency_key FROM archive_worker_sources WHERE id=?", source.id)!;
            const dependencies = observation.dependencies === null ? {files: [], sessionIds: []} : this.decodeDependencies(JSON.parse(text(observation.dependencies)), snapshot.file);
            const dependencyKey = this.dependencyKey(scope.id, dependencies);
            this.db.prepare(`INSERT INTO archive_worker_candidate_sources(candidate,source,dependencies,dependency_key) VALUES (?,?,?,?)
                ON CONFLICT(candidate,source) DO UPDATE SET dependencies=excluded.dependencies,dependency_key=excluded.dependency_key`)
                .run(id, source.id, JSON.stringify(dependencies), dependencyKey);
            this.db.prepare("UPDATE archive_worker_candidates SET state='ready',due=0 WHERE id=? AND state='paused' AND diagnostic='ancestry-changed'").run(id);
            this.finishSource(source.id, "captured");
            return true;
        }).immediate();
    }

    finishSource(id: number, state: "captured" | "invalid" | "source-lost" | "excluded"): void {
        this.db.prepare("UPDATE archive_worker_sources SET state=?,diagnostic=? WHERE id=?").run(state, state, id);
        this.completeScopes();
    }

    sourceEvidence(scope: string): ArchiveSourceEvidence[] {
        return this.rows("SELECT evidence FROM archive_worker_sources WHERE scope=? AND evidence IS NOT NULL", scope)
            .map((r) => decodeArchiveSourceEvidence(JSON.parse(text(r.evidence))));
    }

    observeSource(id: number, evidence: ArchiveSourceEvidence,
        ancestry: ArchiveSourceCapture["ancestryDependencies"] = {files: [], sessionIds: []}): void {
        const normalized = decodeArchiveSourceEvidence(evidence);
        this.db.transaction(() => {
            const source = this.row("SELECT scope,file,evidence FROM archive_worker_sources WHERE id=?", id);
            if (!source || source.file !== normalized.file) throw new Error("Archive source evidence has a different path.");
            const scope = text(source.scope);
            const encoded = JSON.stringify(normalized);
            const dependencies = this.decodeDependencies(ancestry, normalized.file);
            this.db.prepare("UPDATE archive_worker_sources SET evidence=?,missing_attempts=0,dependencies=? WHERE id=?")
                .run(encoded, JSON.stringify(dependencies), id);
            this.db.prepare("UPDATE archive_worker_sources SET dependency_key=? WHERE id=?").run(this.dependencyKey(scope, dependencies), id);
            if (source.evidence !== encoded) {
                // A fixed-target pass finishes its tail even while newer observations arrive.
                // Revalidation is one scope obligation, not an unbounded bulk source enqueue.
                this.db.prepare(`UPDATE archive_worker_scopes SET catalog_revision=catalog_revision+1,
                    review_target=COALESCE(review_target,catalog_revision+1),
                    review_cursor=CASE WHEN review_target IS NULL THEN 0 ELSE review_cursor END,
                    state=CASE WHEN state='complete' THEN 'scanned' ELSE state END,due=0 WHERE id=?`).run(scope);
            }
        }).immediate();
    }

    directoryContinuation(id: number, cursor: string): void {
        this.db.prepare("UPDATE archive_worker_sources SET retry_cursor=?,turn=?,due=0,missing_attempts=0 WHERE id=?").run(cursor, Date.now(), id);
    }

    nextCandidate(destinations: string[], now: number): WorkCandidate | undefined {
        if (!destinations.length) return undefined;
        for (let checked = 0; checked < 64; checked++) {
            const r = this.row(`SELECT ${CANDIDATE_COLUMNS.map((column) => `c.${column}`).join(",")} FROM archive_worker_candidates c WHERE c.state='ready' AND c.due<=? AND c.destination IN (${destinations.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM archive_worker_operations o LEFT JOIN archive_worker_candidates p ON p.id=o.candidate LEFT JOIN archive_worker_destinations od ON od.id=o.destination JOIN archive_worker_destinations cd ON cd.id=c.destination WHERE ${UNRESOLVED_OPERATION_MATCH}) ORDER BY c.turn,c.id LIMIT 1`, now, ...destinations);
            if (!r) return undefined;
            const candidate = this.decodeCandidate(r);
            if (this.candidateAuthorized(candidate.id)) return candidate;
            this.pauseCandidate(candidate.id, "ancestry-changed");
        }
        return undefined;
    }

    candidate(id: string): WorkCandidate {
        const r = this.row(`SELECT ${CANDIDATE_COLUMNS.join(",")} FROM archive_worker_candidates WHERE id=?`, id);
        if (!r) throw new Error("Missing archive candidate.");
        return this.decodeCandidate(r);
    }

    body(candidate: WorkCandidate): Buffer {
        candidate = this.candidate(candidate.id);
        const owner = this.row("SELECT length(body) AS stored_length,legacy_profile,legacy_capture FROM archive_worker_candidates WHERE id=?", candidate.id);
        if (!owner) throw new Error("Missing archive body.");
        let table = "archive_worker_candidates", selector = "id=?";
        let values = [candidate.id];
        let storedLength = owner.stored_length;
        if (storedLength === null && owner.legacy_profile !== null) {
            table = owner.legacy_capture === null ? "archive_uploads" : "archive_captures";
            selector = owner.legacy_capture === null ? "profile=? AND session_id=?" : "profile=? AND capture_id=?";
            values = [text(owner.legacy_profile), owner.legacy_capture === null ? candidate.sessionId : text(owner.legacy_capture)];
            storedLength = this.row(`SELECT length(body) AS stored_length FROM ${table} WHERE ${selector}`, ...values)?.stored_length;
        }
        // SQLite's length(BLOB) is scalar metadata. Reject a corrupt understated
        // length before materializing bytes outside the caller's reservation.
        if (storedLength !== candidate.byteLength) throw new Error("Archive retained body length failed integrity validation.");
        const value = this.row(`SELECT body FROM ${table} WHERE ${selector}`, ...values)?.body;
        if (!Buffer.isBuffer(value) || value.length !== candidate.byteLength || createHash("sha256").update(value).digest("hex") !== candidate.sha256) throw new Error("Archive retained body failed integrity validation.");
        return value;
    }

    prepare(candidate: WorkCandidate, kind: WorkOperation["kind"], value: unknown, dependency: string | null = null, comparison: string | null = null): void {
        candidate = this.candidate(candidate.id);
        if (!this.candidateAuthorized(candidate.id)) throw new Error("Archive candidate ancestry needs revalidation.");
        const request = this.operationRequest(kind, value, candidate);
        this.db.transaction(() => {
            const destination = this.row("SELECT binding FROM archive_worker_destinations WHERE id=?", candidate.destination);
            if (!destination || destination.binding === null
                || !sameArchiveBinding(decodeArchiveBinding(JSON.parse(text(destination.binding))), request.binding)) throw new Error("Archive operation binding is not authorized.");
            const active = this.row(`SELECT o.id FROM archive_worker_operations o LEFT JOIN archive_worker_candidates p ON p.id=o.candidate LEFT JOIN archive_worker_destinations od ON od.id=o.destination JOIN archive_worker_candidates c ON c.id=? JOIN archive_worker_destinations cd ON cd.id=c.destination WHERE ${UNRESOLVED_OPERATION_MATCH}`, candidate.id);
            if (active) throw new Error("Archive identity already has an unresolved operation.");
            this.checkPublicationDependency(candidate, request, dependency, comparison);
            this.db.prepare("INSERT INTO archive_worker_operations(id,destination,candidate,kind,request,state,dependency,comparison) VALUES (?,?,?,?,?,'ready',?,?)")
                .run(request.operation_id, candidate.destination, candidate.id, kind, JSON.stringify(request), dependency, comparison);
            this.db.prepare("UPDATE archive_worker_candidates SET turn=? WHERE id=?").run(Date.now(), candidate.id);
            this.db.prepare("DELETE FROM archive_worker_comparisons WHERE candidate=?").run(candidate.id);
        }).immediate();
    }

    nextOperation(destinations: string[], now: number): WorkOperation | undefined {
        if (!destinations.length) return undefined;
        for (let checked = 0; checked < 64; checked++) {
            const r = this.row(`SELECT * FROM archive_worker_operations WHERE state IN ('ready','uncertain') AND due<=? AND destination IN (${destinations.map(() => "?").join(",")}) ORDER BY turn,id LIMIT 1`, now, ...destinations);
            if (!r) return undefined;
            try { this.checkStoredOperation(r); } catch {
                this.quarantineOperation(r);
                continue;
            }
            if (r.state === "ready" && (r.replay_blocked === 1 || !this.candidateAuthorized(text(r.candidate)))) {
                this.db.transaction(() => {
                    // An unknown receipt is not proof that an earlier dispatch cannot
                    // commit. Only provably never-dispatched requests may be retired here.
                    this.db.prepare("UPDATE archive_worker_operations SET state=? WHERE id=? AND state='ready'")
                        .run(r.dispatched === 1 ? "uncertain" : "fenced", text(r.id));
                    this.pauseCandidate(text(r.candidate), "ancestry-changed");
                }).immediate();
                if (r.dispatched === 0) continue;
                r.state = "uncertain";
            }
            return {id: text(r.id), destination: text(r.destination), candidate: text(r.candidate), kind: text(r.kind) as WorkOperation["kind"], request: text(r.request), state: text(r.state) as WorkOperation["state"], dispatched: r.dispatched === 1, replayBlocked: r.replay_blocked === 1, attempts: number(r.attempts), dependency: r.dependency === null ? null : text(r.dependency), comparison: r.comparison === null ? null : text(r.comparison)};
        }
        return undefined;
    }

    acceptedCanonical(candidate: WorkCandidate, binding: Binding): ReturnType<typeof decodeArchiveReceipt> | undefined {
        const destination = this.destinations().find((entry) => entry.id === candidate.destination)!;
        const own = this.row(`SELECT o.* FROM archive_worker_operations o
            JOIN archive_worker_candidates c ON c.id=o.candidate JOIN archive_worker_destinations d ON d.id=o.destination
            WHERE o.kind='publish' AND o.state='accepted' AND c.session_id=? AND d.origin=?
                AND json_extract(o.request,'$.binding.server_id')=? AND json_extract(o.request,'$.binding.namespace_id')=?
                AND json_extract(o.request,'$.binding.history_generation')=? ORDER BY o.rowid DESC LIMIT 1`,
            candidate.sessionId, destination.origin, binding.server_id, binding.namespace_id, binding.history_generation);
        if (own) {
            const request = this.checkStoredOperation(own);
            const receipt = decodeArchiveReceipt(JSON.parse(text(own.receipt)));
            if (!isDeepStrictEqual(request, receipt.request)) throw new Error("Invalid accepted canonical operation evidence.");
        }
        const legacy = this.row("SELECT accepted FROM archive_uploads WHERE profile=? AND session_id=? AND accepted IS NOT NULL",
            JSON.stringify([destination.origin, binding.server_id, binding.namespace_id, binding.history_generation]), candidate.sessionId);
        const receipts = [own?.receipt, legacy?.accepted].filter((value): value is string => typeof value === "string")
            .map((raw) => decodeArchiveReceipt(JSON.parse(raw)));
        for (const receipt of receipts) {
            if (!sameArchiveBinding(receipt.request.binding, binding) || receipt.request.session_id !== candidate.sessionId) throw new Error("Invalid canonical base evidence.");
        }
        return receipts.reduce<ReturnType<typeof decodeArchiveReceipt> | undefined>((best, receipt) => !best || BigInt(receipt.revision.seq) > BigInt(best.revision.seq) ? receipt : best, undefined);
    }

    dependency(candidate: string, binding: Binding): {id: string; comparison: string} | undefined {
        for (const row of this.rows(`SELECT * FROM archive_worker_operations WHERE candidate=? AND kind='current' AND state='accepted'
            AND json_extract(request,'$.binding.server_id')=? AND json_extract(request,'$.binding.namespace_id')=?
            AND json_extract(request,'$.binding.history_generation')=? ORDER BY rowid DESC`,
            candidate, binding.server_id, binding.namespace_id, binding.history_generation)) {
            const request = this.checkStoredOperation(row);
            if (!("mode" in request)) throw new Error("Invalid preservation dependency kind.");
            if (sameArchiveBinding(request.binding, binding) && typeof row.comparison === "string") {
                const receipt = decodeArchivePreservationReceipt(JSON.parse(text(row.receipt)));
                if (!isDeepStrictEqual(receipt.request, request)) throw new Error("Invalid archive preservation dependency receipt.");
                this.checkCurrentReceipt(receipt, row.comparison);
                return {id: text(row.id), comparison: row.comparison};
            }
        }
        return undefined;
    }

    pauseCandidate(id: string, diagnostic: string): void {
        this.db.transaction(() => {
            this.db.prepare("UPDATE archive_worker_candidates SET state='paused',diagnostic=? WHERE id=?").run(diagnostic, id);
            this.clearComparison(id);
        }).immediate();
    }

    resumeCandidates(destination: string): void {
        this.db.prepare("UPDATE archive_worker_candidates SET state='ready',due=0 WHERE destination=? AND state='paused'").run(destination);
    }

    markUncertain(id: string): void {
        this.db.prepare("UPDATE archive_worker_operations SET state='uncertain',dispatched=1 WHERE id=? AND state='ready'").run(id);
    }

    replay(id: string, recoveryDue: number): void {
        if (!Number.isSafeInteger(recoveryDue) || recoveryDue < 0) throw new Error("Invalid archive receipt recovery deadline.");
        this.db.transaction(() => {
            const operation = this.row("SELECT candidate,replay_blocked FROM archive_worker_operations WHERE id=? AND state='uncertain'", id);
            if (!operation) return;
            if (operation.replay_blocked === 0 && this.candidateAuthorized(text(operation.candidate))) {
                this.db.prepare("UPDATE archive_worker_operations SET state='ready',dispatched=1,turn=?,due=0 WHERE id=?")
                    .run(Date.now(), id);
            } else {
                this.db.prepare("UPDATE archive_worker_operations SET dispatched=1,due=?,attempts=attempts+1,turn=?,diagnostic=CASE WHEN replay_blocked=1 THEN diagnostic ELSE 'ancestry-receipt-only' END WHERE id=?")
                    .run(recoveryDue, Date.now(), id);
                if (operation.replay_blocked === 0) this.pauseCandidate(text(operation.candidate), "ancestry-changed");
            }
        }).immediate();
    }

    failOperation(id: string, recoveryDue: number, diagnostic: string): void {
        this.db.transaction(() => {
            const operation = this.row("SELECT * FROM archive_worker_operations WHERE id=? AND state IN ('ready','uncertain')", id);
            if (!operation) return;
            if (operation.dispatched === 1 || operation.state === "uncertain") {
                // A malformed response may follow a committed mutation. Stop resends,
                // not receipt recovery or this native identity's unresolved exclusion.
                this.db.prepare(`UPDATE archive_worker_operations SET state='uncertain',dispatched=1,replay_blocked=1,
                    due=?,attempts=attempts+1,turn=?,diagnostic=? WHERE id=?`)
                    .run(recoveryDue, Date.now(), diagnostic.slice(0, 160), id);
            } else this.quarantineOperation(operation);
        }).immediate();
    }

    accept(operation: WorkOperation, value: unknown, completes: boolean): boolean {
        const stored = this.row("SELECT * FROM archive_worker_operations WHERE id=? AND request=? AND state IN ('ready','uncertain','blocked')", operation.id, operation.request);
        if (!stored) return false;
        let request: Publication | Preservation;
        try { request = this.checkStoredOperation(stored); } catch {
            this.quarantineOperation(stored);
            return false;
        }
        operation = {...operation, kind: text(stored.kind) as WorkOperation["kind"], candidate: text(stored.candidate), destination: text(stored.destination)};
        const receipt = operation.kind === "publish" ? decodeArchiveReceipt(value) : decodeArchivePreservationReceipt(value);
        if (!isDeepStrictEqual(receipt.request, request) || completes !== (operation.kind !== "current")) throw new Error("Archive receipt does not match its operation.");
        if (operation.kind === "current") {
            if (!("variant" in receipt)) throw new Error("Missing archive preservation evidence.");
            this.checkCurrentReceipt(receipt, operation.comparison);
        }
        return this.db.transaction(() => {
            const result = this.db.prepare("UPDATE archive_worker_operations SET state='accepted',receipt=? WHERE id=? AND request=? AND state IN ('ready','uncertain','blocked')")
                .run(JSON.stringify(value), operation.id, operation.request);
            if (!result.changes) return false;
            if (completes) this.cover(operation.candidate, {kind: operation.kind, operation: operation.id, receipt});
            return true;
        }).immediate();
    }

    reject(operation: WorkOperation): void {
        this.db.transaction(() => {
            this.db.prepare("UPDATE archive_worker_operations SET state='rejected' WHERE id=? AND state IN ('ready','uncertain')").run(operation.id);
            this.db.prepare("DELETE FROM archive_worker_comparisons WHERE candidate=?").run(operation.candidate);
            if (operation.dependency) this.db.prepare("UPDATE archive_worker_operations SET state='fenced' WHERE id=?").run(operation.dependency);
            this.defer("candidates", operation.candidate, Date.now() + 1000 + Math.floor(Math.random() * 4000), "contention");
        }).immediate();
    }

    cover(candidate: string, evidence: unknown): void {
        this.db.transaction(() => {
            this.candidate(candidate);
            const destination = this.row("SELECT d.binding FROM archive_worker_destinations d JOIN archive_worker_candidates c ON c.destination=d.id WHERE c.id=?", candidate);
            if (!destination) throw new Error("Missing archive coverage candidate.");
            this.db.prepare("INSERT OR REPLACE INTO archive_worker_coverage(candidate,evidence) VALUES (?,?)")
                .run(candidate, JSON.stringify({binding: destination.binding === null ? undefined : JSON.parse(text(destination.binding)), evidence}));
            const source = this.row("SELECT legacy_profile,legacy_capture,session_id FROM archive_worker_candidates WHERE id=?", candidate)!;
            if (source.legacy_profile !== null) {
                if (source.legacy_capture !== null) {
                    this.db.prepare("DELETE FROM archive_captures WHERE profile=? AND capture_id=?")
                        .run(text(source.legacy_profile), text(source.legacy_capture));
                } else {
                    // The original raw request is already immutable in worker_operations.
                    // Clear only its exact legacy body ownership, never a newer writer's request.
                    this.db.prepare(`UPDATE archive_uploads SET pending=NULL,body=NULL WHERE profile=? AND session_id=?
                        AND pending IN (SELECT request FROM archive_worker_operations WHERE candidate=? AND kind='publish')`)
                        .run(text(source.legacy_profile), text(source.session_id), candidate);
                }
            }
            this.db.prepare("UPDATE archive_worker_candidates SET state='covered',body=NULL WHERE id=?").run(candidate);
            this.db.prepare("DELETE FROM archive_worker_comparisons WHERE candidate=?").run(candidate);
        }).immediate();
    }

    operationCandidate(id: string): string {
        const row = this.row("SELECT candidate FROM archive_worker_operations WHERE id=?", id);
        if (!row) throw new Error("Missing archive operation.");
        return text(row.candidate);
    }

    clearComparison(candidate: string): void {
        this.db.prepare("DELETE FROM archive_worker_comparisons WHERE candidate=?").run(candidate);
    }

    hasComparisonBody(candidate: string): boolean {
        return Boolean(this.row("SELECT candidate FROM archive_worker_comparisons WHERE candidate=? AND body IS NOT NULL", candidate));
    }

    releaseComparisonBodies(except?: string): void {
        if (except) this.db.prepare("UPDATE archive_worker_comparisons SET body=NULL WHERE candidate<>?").run(except);
        else this.db.prepare("UPDATE archive_worker_comparisons SET body=NULL").run();
    }

    comparisonCursor(candidate: string, cursor: string): void {
        this.db.transaction(() => {
            this.db.prepare("UPDATE archive_worker_comparisons SET list_cursor=? WHERE candidate=?").run(cursor, candidate);
            this.db.prepare("UPDATE archive_worker_candidates SET turn=(SELECT COALESCE(MAX(turn),0)+1 FROM archive_worker_candidates) WHERE id=?").run(candidate);
        }).immediate();
    }

    coherentComparison(candidate: string, snapshot: unknown): void {
        this.db.transaction(() => {
            this.db.prepare("UPDATE archive_worker_comparisons SET snapshot=?,list_cursor=NULL WHERE candidate=?").run(JSON.stringify(snapshot), candidate);
            this.db.prepare("UPDATE archive_worker_candidates SET turn=(SELECT COALESCE(MAX(turn),0)+1 FROM archive_worker_candidates) WHERE id=?").run(candidate);
        }).immediate();
    }

    pruneComparison(destinations: string[]): void {
        if (!destinations.length) this.db.prepare("DELETE FROM archive_worker_comparisons").run();
        else this.db.prepare(`DELETE FROM archive_worker_comparisons WHERE candidate NOT IN (SELECT id FROM archive_worker_candidates WHERE destination IN (${destinations.map(() => "?").join(",")}))`).run(...destinations);
    }

    comparison(candidate: string): {snapshot: unknown; body: Buffer | null; cursor: string | null} | undefined {
        const r = this.row("SELECT * FROM archive_worker_comparisons WHERE candidate=?", candidate);
        if (!r) return undefined;
        const snapshot = decodeArchiveSessionMetadata(JSON.parse(text(r.snapshot)));
        if (r.body !== null && (!Buffer.isBuffer(r.body) || r.body.length !== snapshot.byte_length
            || createHash("sha256").update(r.body).digest("hex") !== snapshot.sha256)) throw new Error("Invalid archive comparison body.");
        return {snapshot, body: r.body as Buffer | null, cursor: r.list_cursor === null ? null : text(r.list_cursor)};
    }

    saveComparison(candidate: string, snapshot: unknown, body: Buffer): void {
        // One cached body, but durable small page continuations survive eviction so
        // a long old-server lookup cannot monopolize or restart other candidates.
        this.db.transaction(() => {
            this.releaseComparisonBodies();
            this.db.prepare("INSERT INTO archive_worker_comparisons(candidate,snapshot,body) VALUES (?,?,?) ON CONFLICT(candidate) DO UPDATE SET snapshot=excluded.snapshot,body=excluded.body,list_cursor=NULL")
                .run(candidate, JSON.stringify(snapshot), body);
            this.db.prepare("UPDATE archive_worker_candidates SET turn=(SELECT COALESCE(MAX(turn),0)+1 FROM archive_worker_candidates) WHERE id=?").run(candidate);
        }).immediate();
    }

    defer(table: "scopes" | "sources" | "candidates" | "operations", id: string | number, due: number, diagnostic: string, terminal = false): void {
        this.db.prepare(`UPDATE archive_worker_${table} SET due=?,attempts=attempts+1,turn=?,diagnostic=?${table === "sources" ? `,missing_attempts=${diagnostic === "source-missing" ? "missing_attempts+1" : "0"}` : ""}${terminal ? ",state='invalid'" : ""} WHERE id=?`)
            .run(due, Date.now(), diagnostic.slice(0, 160), id);
    }

    workingAvailable(): number {
        const staged = number(this.row("SELECT COALESCE(SUM(length(body)),0) AS bytes FROM archive_worker_comparisons")!.bytes);
        return ARCHIVE_WORKING_BYTES - staged - this.working;
    }

    reserve(bytes: number): () => void {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.workingAvailable()) throw new Error("Archive working allowance exhausted.");
        this.working += bytes;
        let released = false;
        return () => { if (!released) { released = true; this.working -= bytes; } };
    }

    close(): void { this.db.close(); }

    static inspect(directory: string, connection: {config: {url: string}; generation: string} | undefined): WorkSchedule {
        const file = path.join(directory, "archive.sqlite");
        if (!fs.existsSync(file)) return {eligible: false};
        // The general storage wrapper may create a parent when a file disappears.
        // Post-unlock inspection uses the native read-only/file-must-exist boundary instead.
        const db = new Database(file, {readonly: true, fileMustExist: true});
        try {
            if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archive_worker_scopes'").get()) {
                return {eligible: Boolean(connection && db.prepare("SELECT 1 FROM archive_uploads WHERE pending IS NOT NULL LIMIT 1").get())};
            }
            let due: number | null = null;
            if (connection) {
                const auth = db.prepare("SELECT * FROM archive_worker_authorization WHERE generation=?").get(connection.generation) as {blocked: number; due: number; binding: string | null} | undefined;
                if (!auth?.blocked) {
                    const destinations = db.prepare("SELECT * FROM archive_worker_destinations WHERE origin=?").all(connection.config.url) as Array<{id: string; generation: string; binding: string | null}>;
                    const binding = auth?.binding ? decodeArchiveBinding(JSON.parse(auth.binding)) : undefined;
                    for (const destination of destinations) {
                        const stored = destination.binding ? decodeArchiveBinding(JSON.parse(destination.binding)) : undefined;
                        if (stored ? binding && !sameIdentity(stored, binding) : destination.generation !== connection.generation) continue;
                        const pending = db.prepare(`SELECT MIN(due) AS due FROM (SELECT c.due FROM archive_worker_candidates c WHERE c.destination=? AND c.state='ready' AND NOT EXISTS (SELECT 1 FROM archive_worker_operations o LEFT JOIN archive_worker_candidates p ON p.id=o.candidate LEFT JOIN archive_worker_destinations od ON od.id=o.destination JOIN archive_worker_destinations cd ON cd.id=c.destination WHERE ${UNRESOLVED_OPERATION_MATCH}) UNION ALL SELECT due FROM archive_worker_operations WHERE destination=? AND state IN ('ready','uncertain'))`).get(destination.id, destination.id) as {due: number | null};
                        const local = db.prepare(`SELECT MIN(due) AS due FROM (
                            SELECT due FROM archive_worker_scopes WHERE destination=? AND (state='ready' OR review_target IS NOT NULL)
                            UNION ALL SELECT s.due FROM archive_worker_sources s JOIN archive_worker_scopes q ON q.id=s.scope
                                WHERE q.destination=? AND s.state='ready')`).get(destination.id, destination.id) as {due: number | null};
                        for (const next of [pending.due === null ? null : Math.max(pending.due, auth?.due ?? 0),
                            local.due === null ? null : stored ? Math.max(local.due, auth?.due ?? 0) : local.due]) {
                            if (next !== null) due = due === null ? next : Math.min(due, next);
                        }
                    }
                }
            }
            return due === null ? {eligible: false} : {eligible: true, nextDue: due};
        } finally { db.close(); }
    }

    private operationRequest(kind: WorkOperation["kind"], value: unknown, candidate: WorkCandidate): Publication | Preservation {
        const request = kind === "publish" ? decodeArchivePublication(value) : decodeArchivePreservation(value);
        if (request.session_id !== candidate.sessionId || ("mode" in request && request.mode !== kind)
            || ("byte_length" in request && (request.byte_length !== candidate.byteLength || request.sha256 !== candidate.sha256
                || !isDeepStrictEqual(request.metadata ?? null, candidate.metadata)))) throw new Error("Archive operation does not match its candidate.");
        return request;
    }

    private checkPublicationDependency(candidate: WorkCandidate, request: Publication | Preservation, dependency: string | null, comparison: string | null): void {
        if (dependency === null) return;
        const accepted = this.row("SELECT * FROM archive_worker_operations WHERE id=? AND state='accepted' AND kind='current' AND candidate=?", dependency, candidate.id);
        if (!accepted || accepted.comparison !== comparison || !("condition" in request)
            || request.condition.kind !== "exact_base_revision") throw new Error("Archive preservation dependency is not accepted.");
        const preservation = this.checkStoredOperation(accepted);
        if (!("mode" in preservation)) throw new Error("Invalid preservation dependency kind.");
        const acceptedReceipt = decodeArchivePreservationReceipt(JSON.parse(text(accepted.receipt)));
        if (!isDeepStrictEqual(acceptedReceipt.request, preservation)) throw new Error("Invalid archive preservation dependency receipt.");
        this.checkCurrentReceipt(acceptedReceipt, comparison);
        if (preservation.mode !== "current" || preservation.session_id !== request.session_id
            || !sameArchiveBinding(preservation.binding, request.binding)
            || !isDeepStrictEqual(preservation.revision, request.condition.revision)) throw new Error("Archive preservation dependency has a different binding or exact base.");
    }

    private checkStoredOperation(row: Record<string, unknown>): Publication | Preservation {
        if (row.kind !== "publish" && row.kind !== "uploaded" && row.kind !== "current") throw new Error("Invalid archive operation kind.");
        if ((row.dispatched !== 0 && row.dispatched !== 1) || (row.replay_blocked !== 0 && row.replay_blocked !== 1)
            || (row.replay_blocked === 1 && row.dispatched !== 1)) throw new Error("Invalid archive dispatch provenance.");
        const candidate = this.candidate(text(row.candidate));
        const request = this.operationRequest(row.kind, JSON.parse(text(row.request)), candidate);
        if (row.destination !== candidate.destination || (row.id !== request.operation_id
            && row.id !== `legacy:${candidate.destination}:${request.operation_id}`)) throw new Error("Invalid archive operation ownership.");
        if (row.state === "ready" || row.state === "uncertain" || row.state === "blocked") {
            const destination = this.row("SELECT binding FROM archive_worker_destinations WHERE id=?", candidate.destination);
            if (!destination || destination.binding === null
                || !sameArchiveBinding(decodeArchiveBinding(JSON.parse(text(destination.binding))), request.binding)) throw new Error("Archive operation binding is not authorized.");
            this.checkPublicationDependency(candidate, request, row.dependency === null ? null : text(row.dependency),
                row.comparison === null ? null : text(row.comparison));
        }
        // Accepted publications are immutable canonical evidence, not a new attempt
        // to consume a dependency which may since have been fenced or rotated.
        return request;
    }

    private quarantineOperation(operation: Record<string, unknown>): void {
        this.db.transaction(() => {
            // Corrupt owned request evidence cannot be sent, even for receipt lookup.
            // Prior dispatch still owns the exclusion until a verified settlement or
            // authoritative history-generation fence; never infer non-commit here.
            const unresolved = operation.dispatched !== 0 || operation.state === "uncertain" || operation.state === "blocked";
            this.db.prepare("UPDATE archive_worker_operations SET state=?,replay_blocked=?,diagnostic='invalid-operation-evidence' WHERE id=? AND state IN ('ready','uncertain','blocked')")
                .run(unresolved ? "blocked" : "invalid", unresolved ? 1 : 0, text(operation.id));
            this.pauseCandidate(text(operation.candidate), "invalid-operation-evidence");
        }).immediate();
    }

    private addColumns(table: string, columns: Record<string, string>): string[] {
        const existing = new Set(this.rows(`PRAGMA table_info(${table})`).map((column) => text(column.name)));
        const added: string[] = [];
        for (const [name, declaration] of Object.entries(columns)) {
            if (!existing.has(name)) {
                this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
                added.push(name);
            }
        }
        return added;
    }

    private reviewSources(now: number, destinations?: string[]): void {
        this.db.transaction(() => {
            const scope = this.row(`SELECT id,catalog_revision,review_target,review_cursor FROM archive_worker_scopes
                WHERE review_target IS NOT NULL AND due<=? ${destinations ? `AND destination IN (${destinations.map(() => "?").join(",")})` : ""}
                ORDER BY turn,id LIMIT 1`, now, ...(destinations ?? []));
            if (!scope) return;
            const scopeId = text(scope.id);
            const rows = this.rows(`SELECT id,file,state,dependencies,dependency_key FROM archive_worker_sources WHERE scope=? AND id>?
                AND dependencies IS NOT NULL AND (state IN ('captured','excluded') OR (state='ready' AND diagnostic='ancestry-unresolved'))
                ORDER BY id LIMIT 64`, scopeId, number(scope.review_cursor));
            let cursor = number(scope.review_cursor);
            let available = 10000 - this.count("archive_worker_sources", "state='ready'");
            for (const source of rows) {
                const dependencies = this.decodeDependencies(JSON.parse(text(source.dependencies)), text(source.file));
                if (this.dependencyKey(scopeId, dependencies) !== source.dependency_key) {
                    if (source.state !== "ready" && available === 0) {
                        this.db.prepare("UPDATE archive_worker_scopes SET review_cursor=?,due=? WHERE id=?").run(cursor, now + 5000, scopeId);
                        return;
                    }
                    if (source.state !== "ready") available--;
                    this.db.prepare("UPDATE archive_worker_sources SET state='ready',due=0,turn=? WHERE id=?").run(now, number(source.id));
                }
                cursor = number(source.id);
            }
            if (rows.length === 64) {
                this.db.prepare("UPDATE archive_worker_scopes SET review_cursor=?,turn=? WHERE id=?").run(cursor, now, scopeId);
            } else if (number(scope.catalog_revision) > number(scope.review_target)) {
                this.db.prepare("UPDATE archive_worker_scopes SET review_target=catalog_revision,review_cursor=0,turn=? WHERE id=?").run(now, scopeId);
            } else {
                this.db.prepare("UPDATE archive_worker_scopes SET review_target=NULL,review_cursor=0 WHERE id=?").run(scopeId);
                this.completeScopes();
            }
        }).immediate();
    }

    private candidateAuthorized(id: string): boolean {
        const candidate = this.candidate(id);
        const observations = this.rows(`SELECT a.dependencies,a.dependency_key,s.scope FROM archive_worker_candidate_sources a
            JOIN archive_worker_sources s ON s.id=a.source WHERE a.candidate=?`, id);
        if (observations.length === 0) return candidate.id.startsWith("legacy:") || candidate.id.startsWith("capture:");
        return observations.some((row) => this.dependencyKey(text(row.scope),
            this.decodeDependencies(JSON.parse(text(row.dependencies)), candidate.source)) === row.dependency_key);
    }

    private decodeDependencies(value: unknown, ownFile: string): ArchiveSourceCapture["ancestryDependencies"] {
        if (typeof value !== "object" || value === null || !("files" in value) || !("sessionIds" in value)
            || !Array.isArray(value.files) || !Array.isArray(value.sessionIds) || value.files.length > 10000 || value.sessionIds.length > 10000
            || Object.keys(value).some((key) => key !== "files" && key !== "sessionIds")) throw new Error("Invalid archive ancestry dependencies.");
        const files = value.files.map((value: unknown) => {
            const file = text(value);
            if (!path.isAbsolute(file) || path.resolve(file) !== file || file.includes("\0")) throw new Error("Invalid archive ancestry path.");
            return file;
        });
        return {files: [...new Set(files.filter((file) => file !== ownFile))].sort(),
            sessionIds: [...new Set(value.sessionIds.map((value: unknown) => decodeArchiveId(value)))].sort()};
    }

    private dependencyKey(scope: string, dependencies: ArchiveSourceCapture["ancestryDependencies"]): string {
        const filters: string[] = [];
        const values: string[] = [scope];
        if (dependencies.files.length) {
            filters.push(`file IN (${dependencies.files.map(() => "?").join(",")})`);
            values.push(...dependencies.files);
        }
        if (dependencies.sessionIds.length) {
            filters.push(`json_extract(evidence,'$.session.sessionId') IN (${dependencies.sessionIds.map(() => "?").join(",")})`);
            values.push(...dependencies.sessionIds);
        }
        const evidence = filters.length ? this.rows(`SELECT evidence FROM archive_worker_sources WHERE scope=? AND evidence IS NOT NULL
            AND (${filters.join(" OR ")}) ORDER BY file`, ...values).map((row) => decodeArchiveSourceEvidence(JSON.parse(text(row.evidence)))) : [];
        return createHash("sha256").update(JSON.stringify([dependencies, evidence])).digest("hex");
    }

    private importLegacy(): void {
        for (const raw of this.rows("SELECT profile,session_id,source,pending FROM archive_uploads WHERE pending IS NOT NULL")) {
            const request = decodeArchivePublication(JSON.parse(text(raw.pending)));
            const profile = text(raw.profile);
            const identity: unknown = JSON.parse(profile);
            if (!Array.isArray(identity) || identity.length !== 4 || typeof identity[0] !== "string"
                || profile !== JSON.stringify([identity[0], request.binding.server_id, request.binding.namespace_id, request.binding.history_generation])
                || raw.session_id !== request.session_id || !path.isAbsolute(text(raw.source)) || text(raw.source).includes("\0")) throw new Error("Invalid legacy archive profile.");
            const destination = this.destinationId(identity[0], `legacy:${profile}`);
            const operationId = `legacy:${destination}:${request.operation_id}`;
            const id = operationId;
            this.db.prepare("INSERT OR IGNORE INTO archive_worker_destinations(id,origin,generation,binding) VALUES (?,?,?,?)")
                .run(destination, identity[0], `legacy:${profile}`, JSON.stringify(request.binding));
            this.db.prepare("INSERT OR IGNORE INTO archive_worker_candidates(id,destination,session_id,source,byte_length,sha256,metadata,legacy_profile) VALUES (?,?,?,?,?,?,?,?)")
                .run(id, destination, request.session_id, text(raw.source), request.byte_length, request.sha256, JSON.stringify(request.metadata ?? null), profile);
            this.db.prepare("INSERT OR IGNORE INTO archive_worker_operations(id,destination,candidate,kind,request,state,dispatched) VALUES (?,?,?,'publish',?,'uncertain',1)")
                .run(operationId, destination, id, text(raw.pending));
        }
        for (const raw of this.rows("SELECT profile,capture_id,session_id,source,byte_length,sha256,metadata FROM archive_captures")) {
            const profile = text(raw.profile);
            const identity: unknown = JSON.parse(profile);
            if (!Array.isArray(identity) || identity.length !== 4 || typeof identity[0] !== "string") throw new Error("Invalid legacy capture profile.");
            const binding = decodeArchiveBinding({server_id: identity[1], namespace_id: identity[2], history_generation: identity[3]});
            const destination = this.destinationId(identity[0], `legacy:${profile}`);
            this.db.prepare("INSERT OR IGNORE INTO archive_worker_destinations(id,origin,generation,binding) VALUES (?,?,?,?)").run(destination, identity[0], `legacy:${profile}`, JSON.stringify(binding));
            this.db.prepare("INSERT OR IGNORE INTO archive_worker_candidates(id,destination,session_id,source,byte_length,sha256,metadata,legacy_profile,legacy_capture) VALUES (?,?,?,?,?,?,?,?,?)")
                .run(`capture:${createHash("sha256").update(profile).digest("hex")}:${text(raw.capture_id)}`, destination, text(raw.session_id), text(raw.source), number(raw.byte_length), text(raw.sha256), text(raw.metadata), profile, text(raw.capture_id));
        }
    }

    private checkCurrentReceipt(receipt: ReturnType<typeof decodeArchivePreservationReceipt>, comparison: string | null): void {
        if (!comparison || receipt.request.mode !== "current") throw new Error("Missing archive preservation evidence.");
        const value = JSON.parse(comparison) as {snapshot: unknown};
        const snapshot = decodeArchiveSessionMetadata(value.snapshot);
        if (!isDeepStrictEqual(receipt.source_revision, snapshot.revision)
            || receipt.variant.session_id !== snapshot.session_id || receipt.variant.sha256 !== snapshot.sha256
            || receipt.variant.byte_length !== snapshot.byte_length || !isDeepStrictEqual(receipt.variant.metadata, snapshot.metadata)
            || receipt.source_uploaded_at !== snapshot.uploaded_at) throw new Error("Archive preservation receipt does not match compared evidence.");
    }

    private completeScopes(): void {
        this.db.prepare("UPDATE archive_worker_scopes SET state='complete' WHERE state='scanned' AND review_target IS NULL AND NOT EXISTS (SELECT 1 FROM archive_worker_sources WHERE scope=archive_worker_scopes.id AND state='ready')").run();
    }

    private backlogBytes(): number {
        return number(this.row(`SELECT COALESCE((SELECT SUM(length(body)) FROM archive_uploads),0)
            + COALESCE((SELECT SUM(length(body)) FROM archive_captures),0)
            + COALESCE((SELECT SUM(length(body)) FROM archive_worker_candidates),0) AS bytes`)!.bytes);
    }
    private destinationId(origin: string, generation: string): string { return createHash("sha256").update(JSON.stringify([origin, generation])).digest("hex"); }
    private decodeCandidate(r: Record<string, unknown>): WorkCandidate {
        const sessionId = decodeArchiveId(r.session_id);
        const metadata: unknown = JSON.parse(text(r.metadata));
        const candidate = {id: text(r.id), destination: text(r.destination), sessionId, source: text(r.source),
            byteLength: number(r.byte_length), sha256: text(r.sha256), metadata: metadata === null ? null : decodeArchiveMetadata(metadata, sessionId), attempts: number(r.attempts)};
        if (!path.isAbsolute(candidate.source) || candidate.source.includes("\0")
            || !/^[0-9a-f]{64}$/.test(candidate.destination) || !/^[0-9a-f]{64}$/.test(candidate.sha256)
            || candidate.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Invalid archive candidate evidence.");
        if (r.legacy_profile === null) {
            if (r.legacy_capture !== null || candidate.metadata === null || path.resolve(candidate.source) !== candidate.source
                || candidate.id !== this.candidateId(candidate.destination, candidate.source, candidate.sessionId, candidate.sha256, candidate.metadata)) {
                throw new Error("Invalid archive candidate fingerprint.");
            }
        } else {
            this.checkLegacyCandidate(candidate, text(r.legacy_profile), r.legacy_capture === null ? null : text(r.legacy_capture));
        }
        return candidate;
    }

    private candidateId(destination: string, source: string, sessionId: string, sha256: string, metadata: ArchiveMetadata): string {
        return createHash("sha256").update(JSON.stringify([destination, source, sessionId, sha256, metadata])).digest("hex");
    }

    private checkLegacyCandidate(candidate: WorkCandidate, profile: string, captureId: string | null): void {
        const identity: unknown = JSON.parse(profile);
        if (!Array.isArray(identity) || identity.length !== 4 || typeof identity[0] !== "string"
            || this.destinationId(identity[0], `legacy:${profile}`) !== candidate.destination) throw new Error("Invalid legacy archive candidate identity.");
        const binding = decodeArchiveBinding({server_id: identity[1], namespace_id: identity[2], history_generation: identity[3]});
        if (captureId !== null) {
            const expected = createHash("sha256").update(JSON.stringify([
                candidate.source, candidate.sessionId, candidate.byteLength, candidate.sha256, candidate.metadata,
            ])).digest("hex");
            if (candidate.metadata === null || captureId !== expected
                || candidate.id !== `capture:${createHash("sha256").update(profile).digest("hex")}:${captureId}`) throw new Error("Invalid legacy archive capture fingerprint.");
        } else {
            const original = this.row("SELECT request FROM archive_worker_operations WHERE id=? AND candidate=? AND kind='publish'", candidate.id, candidate.id);
            if (!original) throw new Error("Missing legacy archive operation evidence.");
            const request = decodeArchivePublication(JSON.parse(text(original.request)));
            const source = this.row("SELECT source FROM archive_uploads WHERE profile=? AND session_id=?", profile, request.session_id);
            if (candidate.id !== `legacy:${candidate.destination}:${request.operation_id}` || !sameArchiveBinding(binding, request.binding)
                || request.session_id !== candidate.sessionId || request.byte_length !== candidate.byteLength || request.sha256 !== candidate.sha256
                || !isDeepStrictEqual(request.metadata ?? null, candidate.metadata) || source?.source !== candidate.source) throw new Error("Invalid legacy archive candidate fingerprint.");
        }
    }
    private count(table: string, where: string): number { return number(this.row(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)!.count); }
    private row(sql: string, ...args: Array<string | number>): Record<string, unknown> | undefined { return this.db.prepare(sql).get(...args) as Record<string, unknown> | undefined; }
    private rows(sql: string, ...args: Array<string | number>): Array<Record<string, unknown>> { return this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>; }
}

export function sameIdentity(a: Binding, b: Binding): boolean { return a.server_id === b.server_id && a.namespace_id === b.namespace_id; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid archive worker state."); return value; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid archive worker state."); return value; }
