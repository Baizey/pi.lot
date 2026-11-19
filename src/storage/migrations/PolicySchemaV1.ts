import {SqliteDatabase} from "../sqlite.js";
import {PolicyAccessTypeConstraint} from "./PolicyAccessTypeConstraint.js";

// Frozen target for the first versioned policy-store upgrade. Future schema
// changes belong in a new migration, not edits to this vocabulary.
export const POLICY_ACCESS_TYPES_V1 = Object.freeze([
    "FS_READ", "FS_WRITE", "HTTP", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
    "WEBSOCKET", "GRPC", "SSH", "ADB", "TCP", "UDP", "DNS", "POSTGRES", "MYSQL", "REDIS",
    "MONGODB", "MQTT", "AMQP", "KAFKA", "NATS", "FTP", "SMB", "NFS", "LDAP", "SMTP", "IMAP", "POP3",
]);
const ACCESS_TYPES_SQL = POLICY_ACCESS_TYPES_V1.map((type) => `'${type}'`).join(", ");

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
        new PolicyAccessTypeConstraint(this.db).upgrade(sql, POLICY_ACCESS_TYPES_V1, true);
        this.db.exec(`create index if not exists "idx_policy_rules_access"
            on "policy_rules" ("accessType", "pattern")`);
    }
}
