import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {PolicyDao} from "../../storage/PolicyDao.js";
import {SqliteDatabase} from "../../storage/sqlite.js";
import {PolicyLifetime} from "../../policy/types.js";
import {
    canonicalConfigContent,
    decodeGlobalPolicyRules,
    MAX_CONFIG_CONTENT_BYTES,
    type ConfigBaseline,
    type ConfigKey,
    type ConfigSnapshot,
    type GlobalPolicyRule,
    validateConfigContent,
} from "./ConfigSyncProtocol.js";

// Reading is bounded before parsing, including when a file grows after fstat.
const MAX_SOURCE_BYTES = MAX_CONFIG_CONTENT_BYTES;
type ApplyResult = {applied: boolean; materialized: string | null};

/** Saved files and persisted GLOBAL decisions only; never runtime defaults or grants. */
export class ConfigSyncAdapters {
    private database: SqliteDatabase | undefined;
    private policyDao: PolicyDao | undefined;
    private readonly ownsDatabase: boolean;
    private closed = false;

    constructor(
        private readonly directory = path.join(os.homedir(), ".pilot"),
        database?: SqliteDatabase,
    ) {
        this.database = database;
        this.ownsDatabase = database === undefined;
    }

    capture(key: ConfigKey, baseline?: ConfigBaseline): ConfigSnapshot {
        this.assertOpen();
        if (key !== "global-policies") return this.captureFile(key);
        const database = this.policyDatabase();
        return database.transaction(() => {
            const materialized = this.readGlobals(database);
            let content = materialized;
            if (baseline !== undefined) {
                const canonical = this.ruleMap(baseline.content);
                const previous = this.ruleMap(baseline.materialized);
                const current = this.ruleMap(materialized);
                const collision = database.prepare(`
                    select 1 from "policy_rules"
                    where "pattern" = ? and "accessType" = ? and "lifetime" <> ?
                `);
                for (const [identity, before] of previous) {
                    if (current.has(identity)) continue;
                    // Replacing a GLOBAL row with a local-only decision masks
                    // the canonical rule; it does not delete that remote rule.
                    // Look up only removed identities, in the same read snapshot.
                    if (!collision.get(before.pattern, before.accessType, PolicyLifetime.GLOBAL)) canonical.delete(identity);
                }
                for (const [identity, after] of current) {
                    const before = previous.get(identity);
                    if (canonicalConfigContent(before ?? null) !== canonicalConfigContent(after)) canonical.set(identity, after);
                }
                content = this.rulesContent([...canonical.values()]);
            }
            return Object.freeze({content, materialized, modifiedAt: new Date().toISOString()});
        })();
    }

    apply(key: ConfigKey, captured: ConfigSnapshot, content: string | null,
        beforeWrite?: (materialized: string | null) => void): ApplyResult {
        this.assertOpen();
        validateConfigContent(key, content);
        if (key !== "global-policies") return this.applyFile(key, captured, content, beforeWrite);
        const rules = [...this.ruleMap(content).values()];
        const database = this.policyDatabase();
        // IMMEDIATE obtains the writer lock before the concurrency guard, so a
        // different SQLite connection cannot edit between comparison and import.
        return database.transaction((): ApplyResult => {
            const current = this.readGlobals(database);
            if (current !== captured.materialized) {
                return {applied: false, materialized: captured.materialized};
            }
            const collision = database.prepare(`
                select 1 from "policy_rules"
                where "pattern" = ? and "accessType" = ? and "lifetime" <> ?
            `);
            const projected = rules.filter((rule) => !collision.get(rule.pattern, rule.accessType, PolicyLifetime.GLOBAL));
            // Persistent local masks must not churn unchanged GLOBAL rows when
            // the service re-materializes its cached canonical bundle.
            if (this.rulesContent(projected) === current) return {applied: true, materialized: current};
            database.prepare('delete from "policy_rules" where "lifetime" = ?').run(PolicyLifetime.GLOBAL);
            const insert = database.prepare(`
                insert into "policy_rules" ("pattern", "accessType", "lifetime", "status", "reason", "updatedAt")
                values (@pattern, @accessType, 'GLOBAL', @status, @reason, @updatedAt)
                on conflict ("pattern", "accessType") do nothing
            `);
            const updatedAt = Date.now();
            for (const rule of projected) insert.run({...rule, updatedAt});
            return {applied: true, materialized: this.readGlobals(database)};
        }).immediate();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.ownsDatabase) this.database?.close();
    }

    private captureFile(key: Exclude<ConfigKey, "global-policies">): ConfigSnapshot {
        const file = path.join(this.directory, `${key}.json`);
        if (!this.checkDirectory()) return this.unsetSnapshot();
        let descriptor: number;
        try {
            descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        } catch (error) {
            if (this.isMissing(error)) return this.unsetSnapshot();
            throw error;
        }
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile()) throw new Error("Configuration source must be a regular file.");
            if (stat.size > MAX_SOURCE_BYTES) throw new Error("Configuration source exceeds the size limit.");
            const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
            let length = 0;
            while (length < bytes.length) {
                const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
                if (read === 0) break;
                length += read;
            }
            if (length > MAX_SOURCE_BYTES) throw new Error("Configuration source exceeds the size limit.");
            const text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, length));
            validateConfigContent(key, text);
            const content = canonicalConfigContent(JSON.parse(text));
            return Object.freeze({content, materialized: content, modifiedAt: stat.mtime.toISOString()});
        } finally {
            fs.closeSync(descriptor);
        }
    }

    private applyFile(
        key: Exclude<ConfigKey, "global-policies">,
        captured: ConfigSnapshot,
        content: string | null,
        beforeWrite?: (materialized: string | null) => void,
    ): ApplyResult {
        const materialized = content === null ? null : canonicalConfigContent(JSON.parse(content));
        const deferred = {applied: false, materialized: captured.materialized};
        const current = this.captureFile(key).materialized;
        // A file rename/reset can survive a failed journal commit. Replaying
        // that response acknowledges the already-materialized winner rather
        // than misclassifying it as a newer local edit.
        if (current === materialized) return {applied: true, materialized};
        if (current !== captured.materialized) return deferred;
        const file = path.join(this.directory, `${key}.json`);
        if (materialized === null) {
            beforeWrite?.(null);
            // Checkpoint I/O can wait on storage while another process saves.
            const afterCheckpoint = this.captureFile(key).materialized;
            if (afterCheckpoint === null) return {applied: true, materialized: null};
            if (afterCheckpoint !== captured.materialized) return deferred;
            try {
                fs.unlinkSync(file);
            } catch (error) {
                if (!this.isMissing(error)) throw error;
            }
            if (this.checkDirectory()) this.syncDirectory();
            return {applied: true, materialized: null};
        }
        fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
        this.checkDirectory();
        const temporary = path.join(this.directory, `.config-sync-${randomUUID()}.tmp`);
        let created = false;
        try {
            const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
            created = true;
            try {
                fs.writeFileSync(descriptor, materialized, "utf8");
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            // This read is exclusively a write-back guard. The caller's frozen
            // upload is never rebuilt from a newer local file.
            const latest = this.captureFile(key).materialized;
            if (latest === materialized) return {applied: true, materialized};
            if (latest !== captured.materialized) return deferred;
            beforeWrite?.(materialized);
            const afterCheckpoint = this.captureFile(key).materialized;
            if (afterCheckpoint === materialized) return {applied: true, materialized};
            if (afterCheckpoint !== captured.materialized) return deferred;
            fs.renameSync(temporary, file);
            created = false;
            this.syncDirectory();
            return {applied: true, materialized};
        } finally {
            if (created) fs.unlinkSync(temporary);
        }
    }

    private policyDatabase(): SqliteDatabase {
        if (this.database === undefined) {
            if (!this.checkDirectory()) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
            this.checkDirectory();
            const file = path.join(this.directory, "pilot.sqlite");
            try {
                const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
                fs.closeSync(descriptor);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
            if (!fs.lstatSync(file).isFile()) throw new Error("Policy database must be a regular file.");
            this.database = SqliteDatabase.open(file);
        }
        this.policyDao ??= new PolicyDao(this.database);
        this.policyDao.initializeSchema();
        return this.database;
    }

    private readGlobals(database: SqliteDatabase): string | null {
        const rules: GlobalPolicyRule[] = [];
        let bytes = Buffer.byteLength('{"rules":[]}');
        const rows = database.prepare(`
            select "pattern", "accessType", "status", "reason"
            from "policy_rules" where "lifetime" = ?
        `).iterate(PolicyLifetime.GLOBAL);
        for (const row of rows) {
            // SQLite supplies objects; protocol validation below establishes the
            // complete external-content invariant before returning a snapshot.
            const rule = row as GlobalPolicyRule;
            bytes += Buffer.byteLength(JSON.stringify(rule)) + (rules.length === 0 ? 0 : 1);
            if (bytes > MAX_SOURCE_BYTES) throw new Error("Configuration source exceeds the size limit.");
            rules.push(rule);
        }
        return this.rulesContent(rules);
    }

    private ruleMap(content: string | null): Map<string, GlobalPolicyRule> {
        return new Map(decodeGlobalPolicyRules(content).map((rule) => [JSON.stringify([rule.pattern, rule.accessType]), rule]));
    }

    private rulesContent(rules: GlobalPolicyRule[]): string | null {
        if (rules.length === 0) return null;
        rules.sort((left, right) => Buffer.compare(Buffer.from(left.pattern), Buffer.from(right.pattern))
            || Buffer.compare(Buffer.from(left.accessType), Buffer.from(right.accessType)));
        const content = canonicalConfigContent({rules});
        validateConfigContent("global-policies", content);
        return content;
    }

    private checkDirectory(): boolean {
        try {
            const stat = fs.lstatSync(this.directory);
            if (!stat.isDirectory()) throw new Error("Configuration directory must be a regular directory.");
            return true;
        } catch (error) {
            if (this.isMissing(error)) return false;
            throw error;
        }
    }

    private syncDirectory(): void {
        const descriptor = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }

    private unsetSnapshot(): ConfigSnapshot {
        return Object.freeze({content: null, materialized: null, modifiedAt: new Date().toISOString()});
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("Configuration adapters are closed.");
    }

    private isMissing(error: unknown): boolean {
        return error instanceof Error && "code" in error && error.code === "ENOENT";
    }
}
