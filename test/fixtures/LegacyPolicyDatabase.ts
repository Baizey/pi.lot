import {SqliteDatabase} from "../../src/storage/sqlite.js";

// Literal pre-ADB vocabulary so tests exercise an actual historical CHECK,
// independent of the current enum and DAO's schema builder.
const LEGACY_ACCESS_TYPES = [
    "FS_READ", "FS_WRITE", "HTTP", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
    "WEBSOCKET", "GRPC", "SSH", "TCP", "UDP", "DNS", "SMTP",
];

export function createLegacyPolicySchema(database: SqliteDatabase, includeAdb = false, includeRetiredDelete = false): void {
    const types = [...LEGACY_ACCESS_TYPES, ...(includeAdb ? ["ADB"] : []), ...(includeRetiredDelete ? ["FS_DELETE"] : [])];
    database.exec(`
        create table "policy_rules" (
            "pattern" text not null,
            "accessType" text not null check ("accessType" in (${types.map((type) => `'${type}'`).join(", ")})),
            "lifetime" text not null check ("lifetime" in ('ONCE', 'SESSION', 'LOCAL', 'GLOBAL')),
            "status" text not null check ("status" in ('ALLOWED', 'DENIED')),
            "reason" text not null,
            "updatedAt" integer not null,
            primary key ("pattern", "accessType")
        );
        create index "idx_policy_rules_access" on "policy_rules" ("accessType", "pattern");
    `);
    const insert = database.prepare(`insert into "policy_rules"
        (rowid, "pattern", "accessType", "lifetime", "status", "reason", "updatedAt") values (?, ?, ?, ?, ?, ?, ?)`);
    insert.run(11, "/work/allowed", "FS_READ", "LOCAL", "ALLOWED", "Saved local allow", 1700000000001);
    insert.run(25, "/work/private", "FS_WRITE", "LOCAL", "DENIED", "Saved local denial\nwith details", 1700000000002);
    insert.run(48, "allow.test:443", "GET", "GLOBAL", "ALLOWED", "Saved GLOBAL allow — quoted 'reason'", 1700000000003);
    insert.run(81, "deny.test:443", "POST", "GLOBAL", "DENIED", "Saved GLOBAL denial", 1700000000004);
    insert.run(90, "once.test:22", "SSH", "ONCE", "DENIED", "Preserve all stored lifetimes", 1700000000005);
    insert.run(99, "session.test:25", "SMTP", "SESSION", "ALLOWED", "Preserve session metadata", 1700000000006);
    if (includeRetiredDelete) {
        insert.run(102, "/work/delete-only", "FS_DELETE", "LOCAL", "ALLOWED", "Retired delete grant", 1700000000007);
        insert.run(105, "/work/private", "FS_DELETE", "GLOBAL", "DENIED", "Retired delete denial", 1700000000008);
    }
    database.exec(`
        create index "idx_policy_rules_global" on "policy_rules" ("pattern") where "lifetime" = 'GLOBAL';
        create table "policy_migration_audit" ("action" text not null, "pattern" text not null);
        create trigger "audit_policy_insert" after insert on "policy_rules"
        begin insert into "policy_migration_audit" values ('insert', new."pattern"); end;
        create trigger "audit_policy_update" after update on "policy_rules"
        begin insert into "policy_migration_audit" values ('update', new."pattern"); end;
        create trigger "audit_policy_delete" after delete on "policy_rules"
        begin insert into "policy_migration_audit" values ('delete', old."pattern"); end;
        create view "saved_policy_metadata" as select rowid, * from "policy_rules";
    `);
}

export function storedPolicyRows(database: SqliteDatabase): unknown[] {
    return database.prepare('select rowid, * from "policy_rules" order by rowid').all();
}

export function policySchemaObjects(database: SqliteDatabase): unknown[] {
    return database.prepare(`select type, name, tbl_name, sql from sqlite_master
        where tbl_name = 'policy_rules' or name = 'saved_policy_metadata' order by type, name`).all();
}
