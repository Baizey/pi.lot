import {SqliteDatabase} from "../sqlite.js";

// Frozen target for the first versioned policy-store upgrade. Future schema
// changes belong in a new migration, not edits to this vocabulary.
const ACCESS_TYPES = [
    "FS_READ", "FS_WRITE", "HTTP", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
    "WEBSOCKET", "GRPC", "SSH", "ADB", "TCP", "UDP", "DNS", "POSTGRES", "MYSQL", "REDIS",
    "MONGODB", "MQTT", "AMQP", "KAFKA", "NATS", "FTP", "SMB", "NFS", "LDAP", "SMTP", "IMAP", "POP3",
];
const ACCESS_TYPES_SQL = ACCESS_TYPES.map((type) => `'${type}'`).join(", ");

/** One-time upgrade of unversioned policy stores; callers own the transaction. */
export class PolicySchemaV1 {
    constructor(private readonly db: SqliteDatabase) {}

    up(): void {
        this.db.exec(`create table if not exists "policy_rules" (
            "pattern" text not null,
            "accessType" text not null check ("accessType" in (${ACCESS_TYPES_SQL})),
            "lifetime" text not null check ("lifetime" in ('ONCE', 'SESSION', 'LOCAL', 'GLOBAL')),
            "status" text not null check ("status" in ('ALLOWED', 'DENIED')),
            "reason" text not null, "updatedAt" integer not null,
            primary key ("pattern", "accessType")
        )`);
        const {sql} = this.db.prepare("select sql from sqlite_master where type='table' and name='policy_rules'")
            .get() as {sql: string};
        this.upgradeAccessTypeConstraint(sql);
        this.db.exec(`create index if not exists "idx_policy_rules_access"
            on "policy_rules" ("accessType", "pattern")`);
    }

    private upgradeAccessTypeConstraint(sql: string): void {
        const checks = [...sql.matchAll(/\bcheck\s*\(\s*"accessType"\s+in\s*\(([^)]*)\)\s*\)/giu)];
        if (checks.length !== 1) throw new Error("Unsupported policy access-type constraint.");
        const check = checks[0]!;
        const list = check[1]!;
        const literals = list.match(/'(?:[^']|'')*'/gu) ?? [];
        if (literals.length === 0 || list.replace(/'(?:[^']|'')*'/gu, "").replace(/[\s,]/gu, "") !== "") {
            throw new Error("Unsupported policy access-type vocabulary.");
        }
        const previous = new Set(literals.map((literal) => literal.slice(1, -1).replaceAll("''", "'")));
        const current = ACCESS_TYPES;
        const removeDelete = previous.delete("FS_DELETE");
        if ([...previous].some((type) => !current.some((entry) => entry === type))) {
            throw new Error("Unsupported policy access-type vocabulary.");
        }
        if (!removeDelete && current.every((type) => previous.has(type))) return;

        this.assertNoPolicyForeignKeys();
        const createPrefix = /^create\s+table\s+(?:"policy_rules"|policy_rules)\s*(?=\()/iu;
        if (!createPrefix.test(sql)) throw new Error("Unsupported policy table schema.");
        const upgraded = sql.slice(0, check.index) + `check ("accessType" in (${ACCESS_TYPES_SQL}))`
            + sql.slice(check.index + check[0].length);
        const objects = this.db.prepare(`select sql from sqlite_master
            where tbl_name = 'policy_rules' and type in ('index', 'trigger') and sql is not null
            order by type, name`).all() as {sql: string}[];
        const columns = this.db.prepare('pragma table_info("policy_rules")').all() as {name: string}[];
        const names = columns.map((column) => column.name);
        // The owned schema is a rowid table; retain rowids as well as updatedAt
        // and all declared metadata. WITHOUT ROWID variants have no hidden ID.
        if (!/\bwithout\s+rowid\b/iu.test(sql)) names.unshift("rowid");
        const projection = names.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
        this.db.exec(upgraded.replace(createPrefix, 'create table "policy_rules_access_upgrade" '));
        // Recreate at the original name instead of renaming: dependent views
        // keep their SQL/identity. Copy before reinstalling triggers so migration
        // does not fire application audit or config-sync import side effects.
        this.db.exec(`
            insert into "policy_rules_access_upgrade" (${projection}) select ${projection} from "policy_rules"
                ${removeDelete ? `where "accessType" is not 'FS_DELETE'` : ""};
            drop table "policy_rules";
            ${upgraded};
            insert into "policy_rules" (${projection}) select ${projection} from "policy_rules_access_upgrade";
            drop table "policy_rules_access_upgrade";
        `);
        for (const object of objects) this.db.exec(object.sql);
    }

    private assertNoPolicyForeignKeys(): void {
        // No owned table references policy_rules. Fail closed for an unsupported
        // external dependency rather than letting DROP TABLE cascade its rows.
        const tables = this.db.prepare("select name from sqlite_master where type = 'table'").all() as {name: string}[];
        for (const {name} of tables) {
            const references = this.db.prepare(`pragma foreign_key_list("${name.replaceAll('"', '""')}")`)
                .all() as {table: string}[];
            if (references.some((reference) => reference.table.toLowerCase() === "policy_rules")) {
                throw new Error("Policy schema upgrade cannot rebuild a foreign-key referenced table.");
            }
        }
    }
}
