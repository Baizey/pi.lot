// noinspection SqlNoDataSourceInspection

import {SqliteDatabase} from "./sqlite";
import {type Policy, PolicyAccessType, PolicyLifetime, PolicyResponse} from "../policy/types";

export const policyStatusesSql = sqlStringList(Object.values(PolicyResponse));
export const policyLifetimesSql = sqlStringList(Object.values(PolicyLifetime));
export const fsAccessTypesSql = sqlStringList(Object.values(PolicyAccessType));

function sqlStringList(values: string[]): string {
    return values.map((it) => `'${it.replace(/'/g, "''")}'`).join(", ");
}


type PathPolicyRuleRow = {
    pattern: string;
    accessType: PolicyAccessType;
    lifetime: PolicyLifetime;
    status: PolicyResponse;
    reason: string;
};

export type PolicyDaoInterface = {
    initializeSchema(): void
    loadPolicies(): Policy[]
    upsertPolicies(policies: Policy[]): void
    deletePolicy(pattern: string, accessType: PolicyAccessType): void
}

export class PolicyDao implements PolicyDaoInterface {
    private schemaInitialized = false;

    constructor(private readonly db: SqliteDatabase) {
    }

    initializeSchema(): void {
        if (this.schemaInitialized) return;
        const initialize = this.db.transaction(() => {
            this.db.exec(`
                create table if not exists "policy_rules" (
                    "pattern" text not null,
                    "accessType" text not null check ("accessType" in (${fsAccessTypesSql})),
                    "lifetime" text not null check ("lifetime" in (${policyLifetimesSql})),
                    "status" text not null check ("status" in (${policyStatusesSql})),
                    "reason" text not null,
                    "updatedAt" integer not null,
                    primary key ("pattern", "accessType")
                );
            `);
            const table = this.db.prepare("select sql from sqlite_master where type = 'table' and name = 'policy_rules'")
                .get() as {sql: string};
            this.upgradeAccessTypeConstraint(table.sql);
            this.db.exec(`create index if not exists "idx_policy_rules_access"
                on "policy_rules" ("accessType", "pattern")`);
        });
        // Acquire the writer lock before inspecting/rebuilding the schema. Nested
        // calls are savepoints in the config-sync acknowledgement transaction.
        if (this.db.isReadonly) initialize();
        else initialize.immediate();
        // An outer rollback can undo both creation and migration. Do not cache an
        // initialization whose transaction has not committed yet.
        this.schemaInitialized = !this.db.inTransaction;
    }

    loadPolicies(): Policy[] {
        this.initializeSchema();
        const rows = this.db.prepare(`
            select "pattern", "accessType", "lifetime", "status", "reason"
            from "policy_rules"
            order by "pattern" asc, "accessType" asc
        `).all() as PathPolicyRuleRow[];

        const policies = new Map<string, Policy>();
        for (const row of rows) {
            const policy = policies.get(row.pattern) ?? {pattern: row.pattern, info: {}};
            policy.info[row.accessType] = {
                accessType: row.accessType,
                lifetime: row.lifetime,
                status: row.status,
                reason: row.reason,
            };
            policies.set(row.pattern, policy);
        }

        return [...policies.values()];
    }

    upsertPolicies(policies: Policy[]): void {
        this.initializeSchema();
        const now = Date.now();
        const run = this.db.transaction((items: Policy[]) => {
            const upsert = this.db.prepare(`
                insert into "policy_rules" ("pattern", "accessType", "lifetime", "status", "reason", "updatedAt")
                values (@pattern, @accessType, @lifetime, @status, @reason,
                        @updatedAt) on conflict ("pattern", "accessType") do
                update set
                    "lifetime" = excluded."lifetime",
                    "status" = excluded."status",
                    "reason" = excluded."reason",
                    "updatedAt" = excluded."updatedAt"
            `);
            for (const policy of items) {
                for (const status of Object.values(policy.info)) {
                    if (!status) continue;
                    upsert.run({pattern: policy.pattern, ...status, updatedAt: now});
                }
            }
        });
        run(policies);
    }

    deletePolicy(pattern: string, accessType: PolicyAccessType): void {
        this.initializeSchema();
        this.db.prepare(`
            delete
            from "policy_rules"
            where "pattern" = @pattern
              and "accessType" = @accessType
        `).run({pattern, accessType});
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
        const current = Object.values(PolicyAccessType);
        if ([...previous].some((type) => !current.some((entry) => entry === type))) {
            throw new Error("Unsupported policy access-type vocabulary.");
        }
        if (current.every((type) => previous.has(type))) return;

        this.assertNoPolicyForeignKeys();
        const createPrefix = /^create\s+table\s+(?:"policy_rules"|policy_rules)\s*(?=\()/iu;
        if (!createPrefix.test(sql)) throw new Error("Unsupported policy table schema.");
        const upgraded = sql.slice(0, check.index) + `check ("accessType" in (${fsAccessTypesSql}))`
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
            insert into "policy_rules_access_upgrade" (${projection}) select ${projection} from "policy_rules";
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
