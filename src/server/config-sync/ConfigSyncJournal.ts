import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {SqliteDatabase} from "../../storage/sqlite.js";
import {syncDirectory} from "../ArchiveLock.js";
import {decodeArchiveBinding, sameArchiveBinding, type Binding} from "../ArchiveProtocol.js";
import {
    canonicalConfigContent, configHash, decodeConfigExchange, decodeConfigState, decodeConfigTimestamp, validateConfigContent,
    type ConfigExchange, type ConfigKey, type ConfigSnapshot, type ConfigState,
} from "./ConfigSyncProtocol.js";

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_ITEMS = 1024;
const MAX_RECOVERIES = 10_000;
export type PendingConfigSync = {
    request: ConfigExchange;
    snapshot: ConfigSnapshot;
    application?: {state: ConfigState; captured: ConfigSnapshot; materialized: string | null};
};
export type ConfigSyncEntry = {base?: ConfigState; materialized: string | null; pending?: PendingConfigSync};
type ItemRow = {baseline: string | null; materialized: string | null; pending: string | null};

/** Pending identities, canonical bases, and GLOBAL materialization share the policy transaction. */
export class ConfigSyncJournal {
    private db: SqliteDatabase | undefined;

    constructor(private readonly directory: string) {}

    database(): SqliteDatabase {
        if (this.db) return this.db;
        const file = path.join(this.directory, "pilot.sqlite");
        const stat = fs.lstatSync(file, {throwIfNoEntry: false});
        if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Invalid configuration sync database.");
        const db = SqliteDatabase.open(file);
        try {
            fs.chmodSync(file, 0o600);
            db.exec(`
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS config_sync_items (
                    destination TEXT NOT NULL, item TEXT NOT NULL,
                    baseline TEXT, materialized TEXT, pending TEXT,
                    PRIMARY KEY(destination,item)
                );
                CREATE TABLE IF NOT EXISTS config_sync_recovery (
                    destination TEXT NOT NULL, item TEXT NOT NULL, change_id TEXT NOT NULL,
                    snapshot TEXT NOT NULL,
                    PRIMARY KEY(destination,item,change_id)
                );
                CREATE TABLE IF NOT EXISTS config_sync_automatic (
                    origin TEXT PRIMARY KEY, binding TEXT NOT NULL
                );
            `);
            this.db = db;
            return db;
        } catch (error) {
            db.close();
            throw error;
        }
    }

    read(destination: string, key: ConfigKey): ConfigSyncEntry {
        const row = this.database().prepare("SELECT baseline,materialized,pending FROM config_sync_items WHERE destination=? AND item=?")
            .get(destination, key) as ItemRow | undefined;
        if (!row) return {materialized: null};
        const base = row.baseline === null ? undefined : decodeConfigState(JSON.parse(row.baseline));
        validateConfigContent(key, row.materialized);
        if (base && base.key !== key) throw new Error("Invalid configuration sync journal.");
        return {base, materialized: row.materialized,
            pending: row.pending === null ? undefined : decodePending(JSON.parse(row.pending), key)};
    }

    begin(destination: string, key: ConfigKey, pending: PendingConfigSync): void {
        const normalized = decodePending(pending, key);
        if (normalized.application) throw new Error("Application intent must be prepared for existing pending work.");
        this.database().transaction(() => {
            const entry = this.read(destination, key);
            if (entry.pending) throw new Error("Configuration synchronization already has pending work.");
            this.database().prepare(`INSERT INTO config_sync_items(destination,item,baseline,materialized,pending)
                VALUES (?,?,?,?,?) ON CONFLICT(destination,item) DO UPDATE SET pending=excluded.pending`)
                .run(destination, key, entry.base ? JSON.stringify(entry.base) : null, entry.materialized, JSON.stringify(normalized));
            this.checkBudget();
        }).immediate();
    }

    /** Commit before JSON rename/unlink; an unresolved intent is never an implicit acknowledgement. */
    prepareApplication(destination: string, key: ConfigKey, pending: PendingConfigSync, state: ConfigState,
        captured: ConfigSnapshot, materialized: string | null): PendingConfigSync {
        const next = decodePending({...pending, application: {state, captured, materialized}}, key);
        return this.independentApplicationDatabase().transaction(() => {
            const entry = this.requirePending(destination, key, pending);
            // Always reserve the original candidate, even if this particular
            // response matches it: a later retry can return a newer winner.
            this.retainPending(destination, key, entry, pending);
            this.database().prepare("UPDATE config_sync_items SET pending=? WHERE destination=? AND item=?")
                .run(JSON.stringify(next), destination, key);
            // The intent contains the complete final state and its canonical
            // materialization in addition to all immutable pending data. Its
            // charged size therefore bounds the eventual ACK's state+target.
            this.checkBudget();
            return next;
        }).immediate();
    }

    /** Explicit keep-local selection: acknowledge the old identity and freeze a fresh operation together. */
    rebase(destination: string, key: ConfigKey, oldPending: PendingConfigSync, state: ConfigState,
        nextPending: PendingConfigSync): void {
        const next = decodePending(nextPending, key);
        const accepted = this.responseState(key, oldPending, state);
        if (next.application || next.request.change_id === oldPending.request.change_id
            || next.request.base_revision !== accepted.revision || !sameArchiveBinding(next.request.binding, accepted.binding)) {
            throw new Error("Invalid configuration sync recovery operation.");
        }
        this.database().transaction(() => {
            const entry = this.requirePending(destination, key, oldPending);
            this.retainPending(destination, key, entry, oldPending);
            this.database().prepare("UPDATE config_sync_items SET baseline=?,materialized=?,pending=? WHERE destination=? AND item=?")
                .run(JSON.stringify(accepted), next.snapshot.materialized, JSON.stringify(next), destination, key);
            this.checkBudget();
        }).immediate();
    }

    /** Explicit accept-server selection is retained before any guarded source mutation. */
    preserveCapture(destination: string, key: ConfigKey, pending: PendingConfigSync, captured: ConfigSnapshot): void {
        const snapshot = decodeSnapshot(captured, key);
        this.independentApplicationDatabase().transaction(() => {
            this.requirePending(destination, key, pending);
            this.database().prepare("INSERT INTO config_sync_recovery(destination,item,change_id,snapshot) VALUES (?,?,?,?)")
                .run(destination, key, randomUUID(), JSON.stringify({captured: snapshot}));
            this.checkBudget();
        }).immediate();
    }

    unchanged(destination: string, key: ConfigKey, pending: PendingConfigSync,
        apply?: () => {applied: boolean; materialized: string | null},
    ): {applied: boolean; materialized: string | null} {
        return this.database().transaction(() => {
            const entry = this.requirePending(destination, key, pending);
            if (!entry.base || entry.base.sha256 !== pending.request.sha256
                || entry.base.revision !== pending.request.base_revision) throw new Error("Invalid configuration synchronization check.");
            if (entry.pending?.application && apply === undefined) throw new Error("Interrupted configuration application requires guarded recovery.");
            return this.complete(destination, key, pending, {...entry.base, outcome: "unchanged"},
                apply ?? (() => ({applied: true, materialized: pending.snapshot.materialized})));
        }).immediate();
    }

    /** For GLOBAL policies the caller's application writes through this same database connection. */
    complete(destination: string, key: ConfigKey, pending: PendingConfigSync, state: ConfigState,
        apply: () => {applied: boolean; materialized: string | null}): {applied: boolean; materialized: string | null} {
        state = this.responseState(key, pending, state);
        return this.database().transaction(() => {
            const entry = this.requirePending(destination, key, pending);
            // Keep any losing candidate, including a partially merged policy bundle, recoverable.
            if (state.sha256 !== pending.request.sha256) this.retainPending(destination, key, entry, pending);
            // Reserve ACK capacity before the GLOBAL callback writes in this
            // transaction. JSON mutation already happened outside this transaction;
            // prepareApplication reserved its durable evidence and target first.
            const reservedMaterialized = Buffer.byteLength(state.content ?? "") >= Buffer.byteLength(pending.snapshot.materialized ?? "")
                ? state.content : pending.snapshot.materialized;
            this.database().prepare("UPDATE config_sync_items SET baseline=?,materialized=?,pending=NULL WHERE destination=? AND item=?")
                .run(JSON.stringify(state), reservedMaterialized, destination, key);
            this.checkBudget();
            const result = apply();
            validateConfigContent(key, result.materialized);
            this.database().prepare("UPDATE config_sync_items SET materialized=? WHERE destination=? AND item=?")
                .run(result.materialized, destination, key);
            this.checkBudget();
            return result;
        }).immediate();
    }

    automaticBinding(origin: string): Binding | undefined {
        // Legacy connections must not open the policy database or contact the server
        // for configuration sync before explicit opt-in. The database remains authority.
        if (!fs.existsSync(path.join(this.directory, "config-sync.enabled"))) return undefined;
        const file = path.join(this.directory, "pilot.sqlite");
        if (!fs.existsSync(file)) return undefined;
        if (this.db) return this.readAutomatic(this.db, origin);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid configuration sync database.");
        const db = SqliteDatabase.open(file, true);
        try { return this.readAutomatic(db, origin); }
        finally { db.close(); }
    }

    setAutomatic(origin: string, binding: Binding | undefined): void {
        this.database().transaction(() => {
            if (binding) {
                this.database().prepare(`INSERT INTO config_sync_automatic(origin,binding) VALUES (?,?)
                    ON CONFLICT(origin) DO UPDATE SET binding=excluded.binding`).run(origin, JSON.stringify(binding));
            } else {
                this.database().prepare("DELETE FROM config_sync_automatic WHERE origin=?").run(origin);
            }
            this.checkBudget();
        }).immediate();
        if (binding) {
            const descriptor = fs.openSync(path.join(this.directory, "config-sync.enabled"),
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
            try { fs.fsyncSync(descriptor); }
            finally { fs.closeSync(descriptor); }
            syncDirectory(this.directory);
        }
    }

    disableAutomatic(): void {
        if (fs.existsSync(path.join(this.directory, "pilot.sqlite"))) {
            this.database().prepare("DELETE FROM config_sync_automatic").run();
        }
        try { fs.unlinkSync(path.join(this.directory, "config-sync.enabled")); }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (fs.existsSync(this.directory)) syncDirectory(this.directory);
    }

    close(): void {
        this.db?.close();
        this.db = undefined;
    }

    private independentApplicationDatabase(): SqliteDatabase {
        const db = this.database();
        // A nested transaction only releases a savepoint: it cannot make an
        // application checkpoint durable before a non-transactional file write.
        if (db.inTransaction) throw new Error("File application evidence requires an independent transaction.");
        return db;
    }

    private responseState(key: ConfigKey, pending: PendingConfigSync, state: ConfigState): ConfigState {
        const accepted = decodeConfigState(state);
        if (accepted.key !== key || !sameArchiveBinding(accepted.binding, pending.request.binding)) {
            throw new Error("Invalid configuration sync response.");
        }
        return accepted;
    }

    private retainPending(destination: string, key: ConfigKey, entry: ConfigSyncEntry, pending: PendingConfigSync): void {
        this.database().prepare("INSERT OR IGNORE INTO config_sync_recovery(destination,item,change_id,snapshot) VALUES (?,?,?,?)")
            .run(destination, key, pending.request.change_id, JSON.stringify({base: entry.base, pending: decodePending(pending, key)}));
    }

    private requirePending(destination: string, key: ConfigKey, expected: PendingConfigSync): ConfigSyncEntry {
        const entry = this.read(destination, key);
        if (!entry.pending || JSON.stringify(entry.pending) !== JSON.stringify(decodePending(expected, key))) throw new Error("Configuration sync journal changed.");
        return entry;
    }

    private readAutomatic(db: SqliteDatabase, origin: string): Binding | undefined {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_sync_automatic'").get()) return undefined;
        const row = db.prepare("SELECT binding FROM config_sync_automatic WHERE origin=?").get(origin) as {binding: string} | undefined;
        return row ? decodeArchiveBinding(JSON.parse(row.binding)) : undefined;
    }

    private checkBudget(): void {
        const db = this.database();
        const items = db.prepare(`SELECT count(*) AS count,coalesce(sum(
            length(CAST(coalesce(baseline,'') AS BLOB))+length(CAST(coalesce(materialized,'') AS BLOB))+
            length(CAST(coalesce(pending,'') AS BLOB))),0) AS bytes FROM config_sync_items`).get() as {count: number; bytes: number};
        const recovery = db.prepare("SELECT count(*) AS count,coalesce(sum(length(CAST(snapshot AS BLOB))),0) AS bytes FROM config_sync_recovery")
            .get() as {count: number; bytes: number};
        const automatic = db.prepare("SELECT count(*) AS count,coalesce(sum(length(CAST(binding AS BLOB))),0) AS bytes FROM config_sync_automatic")
            .get() as {count: number; bytes: number};
        if (items.count > MAX_JOURNAL_ITEMS || recovery.count > MAX_RECOVERIES || automatic.count > MAX_JOURNAL_ITEMS
            || items.bytes + recovery.bytes + automatic.bytes > MAX_JOURNAL_BYTES) {
            throw new Error("Configuration synchronization journal is full; retained work was not removed.");
        }
    }
}

function decodePending(value: unknown, key: ConfigKey): PendingConfigSync {
    const row = ownedObject(value, ["request", "snapshot"], ["application"]);
    const request = decodeConfigExchange(row.request);
    const snapshot = decodeSnapshot(row.snapshot, key);
    if (request.key !== key || snapshot.content !== request.content || snapshot.modifiedAt !== request.modified_at
        || request.sha256 !== configHash(snapshot.content)) throw new Error("Invalid pending configuration sync.");
    if (row.application === undefined) return {request, snapshot};
    if (key === "global-policies") throw new Error("GLOBAL policies do not use file application intents.");
    const application = ownedObject(row.application, ["state", "captured", "materialized"]);
    const rawState = ownedObject(application.state, ["binding", "key", "revision", "schema_version", "content", "sha256", "updated_at", "outcome"]);
    const state = decodeConfigState(rawState);
    const captured = decodeSnapshot(application.captured, key);
    validateConfigContent(key, application.materialized);
    const target = state.content === null ? null : canonicalConfigContent(JSON.parse(state.content));
    const source = captured.content === null ? null : canonicalConfigContent(JSON.parse(captured.content));
    if (state.key !== key || !sameArchiveBinding(state.binding, request.binding)
        || application.materialized !== target || captured.content !== source || captured.materialized !== source) {
        throw new Error("Invalid configuration sync application intent.");
    }
    return {request, snapshot, application: {state, captured, materialized: application.materialized}};
}

function decodeSnapshot(value: unknown, key: ConfigKey): ConfigSnapshot {
    const snapshot = ownedObject(value, ["content", "materialized", "modifiedAt"]);
    validateConfigContent(key, snapshot.content);
    validateConfigContent(key, snapshot.materialized);
    return {content: snapshot.content, materialized: snapshot.materialized, modifiedAt: decodeConfigTimestamp(snapshot.modifiedAt)};
}

function ownedObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid configuration sync journal data.");
    const row = value as Record<string, unknown>;
    if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) {
        throw new Error("Invalid configuration sync journal data.");
    }
    return row;
}
