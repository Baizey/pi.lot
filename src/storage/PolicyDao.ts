// noinspection SqlNoDataSourceInspection

import {SqliteDatabase} from "./sqlite";
import {PolicySchemaV1} from "./migrations/PolicySchemaV1.js";
import {PolicySyncV1} from "./migrations/PolicySyncV1.js";
import {type Policy, PolicyAccessType, PolicyLifetime, PolicyResponse} from "../policy/types";

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
            const version = this.db.prepare("pragma user_version").pluck().get();
            if (version === 0) {
                new PolicySchemaV1(this.db).up();
                new PolicySyncV1(this.db).up();
            } else if (version !== 1 && version !== 2) {
                throw new Error(`Unsupported policy database version: ${String(version)}`);
            }
            if (version === 0 || version === 1) {
                this.db.exec(`
                    CREATE TABLE role_profiles (
                        id TEXT PRIMARY KEY NOT NULL,
                        title TEXT NOT NULL,
                        text TEXT NOT NULL,
                        description TEXT
                    );
                    PRAGMA user_version=2;
                `);
            }
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
}
