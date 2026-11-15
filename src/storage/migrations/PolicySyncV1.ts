import {randomUUID} from "node:crypto";
import {SqliteDatabase} from "../sqlite.js";
import {MAX_CONFIG_CONTENT_BYTES, canonicalConfigContent, configHash, validateConfigContent} from "../../server/config-sync/ConfigSyncProtocol.js";

/** Upgrade persisted GLOBAL-policy sync state in the same transaction as its source. */
export class PolicySyncV1 {
    constructor(private readonly db: SqliteDatabase) {}

    up(): void {
        if (this.hasTable("config_sync_items")) {
            const next = this.db.prepare(`select rowid, baseline, materialized, pending from config_sync_items
                where item='global-policies' and (? is null or rowid>?) order by rowid limit 1`).safeIntegers();
            let cursor: bigint | null = null;
            while (true) {
                const row = next.get(cursor, cursor) as {
                    rowid: bigint; baseline: string | null; materialized: string | null; pending: string | null;
                } | undefined;
                if (!row) break;
                this.db.prepare("update config_sync_items set baseline=?,materialized=?,pending=? where rowid=?").run(
                    this.stateJson(row.baseline), this.content(row.materialized), this.pendingJson(row.pending), row.rowid,
                );
                cursor = row.rowid;
            }
        }
        if (this.hasTable("config_sync_recovery")) {
            const next = this.db.prepare(`select rowid,snapshot from config_sync_recovery
                where item='global-policies' and (? is null or rowid>?) order by rowid limit 1`).safeIntegers();
            let cursor: bigint | null = null;
            while (true) {
                const row = next.get(cursor, cursor) as {rowid: bigint; snapshot: string} | undefined;
                if (!row) break;
                const value = this.object(JSON.parse(row.snapshot));
                if (value.base !== undefined) this.state(this.object(value.base));
                if (value.pending !== undefined) this.pending(this.object(value.pending), false);
                if (value.captured !== undefined) this.snapshot(this.object(value.captured));
                this.db.prepare("update config_sync_recovery set snapshot=? where rowid=?")
                    .run(JSON.stringify(value), row.rowid);
                cursor = row.rowid;
            }
        }
    }

    private content(value: unknown): string | null {
        if (value === null) return null;
        if (typeof value !== "string" || Buffer.byteLength(value) > MAX_CONFIG_CONTENT_BYTES) {
            throw new Error("Invalid stored policy sync content.");
        }
        const bundle = this.object(JSON.parse(value));
        if (Object.keys(bundle).length !== 1 || !Array.isArray(bundle.rules) || bundle.rules.length > 1024) {
            throw new Error("Invalid stored policy bundle.");
        }
        const rules = bundle.rules.filter((rule: unknown) => this.object(rule).accessType !== "FS_DELETE");
        const result = rules.length === bundle.rules.length ? value
            : rules.length === 0 ? null : canonicalConfigContent({...bundle, rules});
        validateConfigContent("global-policies", result);
        return result;
    }

    private state(value: Record<string, unknown>): boolean {
        if (typeof value.content !== "string" && value.content !== null) throw new Error("Invalid stored policy state.");
        if (value.sha256 !== configHash(value.content)) throw new Error("Stored policy state hash mismatch.");
        const content = this.content(value.content);
        const changed = content !== value.content;
        value.content = content;
        value.sha256 = configHash(content);
        return changed;
    }

    private snapshot(value: Record<string, unknown>): void {
        value.content = this.content(value.content);
        value.materialized = this.content(value.materialized);
    }

    private pending(value: Record<string, unknown>, renewIdentity: boolean): void {
        // Only live work can be sent again. Recovery records retain their historical
        // identity; a changed outgoing request must not reuse an accepted ID.
        const request = this.object(value.request);
        const changed = this.state(request);
        if (changed && renewIdentity) request.change_id = randomUUID();
        this.snapshot(this.object(value.snapshot));
        if (value.application !== undefined) throw new Error("GLOBAL policies cannot have file application intents.");
    }

    private stateJson(value: string | null): string | null {
        if (value === null) return null;
        const state = this.object(JSON.parse(value));
        return this.state(state) ? JSON.stringify(state) : value;
    }

    private pendingJson(value: string | null): string | null {
        if (value === null) return null;
        const pending = this.object(JSON.parse(value));
        this.pending(pending, true);
        return JSON.stringify(pending);
    }

    private object(value: unknown): Record<string, unknown> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Invalid stored policy migration data.");
        }
        return value as Record<string, unknown>;
    }

    private hasTable(name: string): boolean {
        return !!this.db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name);
    }
}
