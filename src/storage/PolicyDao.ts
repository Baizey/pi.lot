// noinspection SqlNoDataSourceInspection

import {SqliteDatabase} from "./sqlite";
import {Policy, PolicyLifetime, PolicyResponse} from "../policy/types";
import {PolicyAccessType} from "../policy/types";

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
        this.db.exec(`
            create table if not exists "policy_rules"
            (
                "pattern"
                text
                not
                null,
                "accessType"
                text
                not
                null
                check (
                "accessType"
                in
            (
                ${fsAccessTypesSql}
            )),
                "lifetime" text not null check
            (
                "lifetime"
                in
            (
                ${policyLifetimesSql}
            )),
                "status" text not null check
            (
                "status"
                in
            (
                ${policyStatusesSql}
            )),
                "reason" text not null,
                "updatedAt" integer not null,
                primary key
            (
                "pattern",
                "accessType"
            )
                );

            create index if not exists "idx_policy_rules_access"
                on "policy_rules" ("accessType", "pattern");
        `);
        this.schemaInitialized = true;
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

        return {policies: [...policies.values()]}.policies;
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
            for (const policy of ({policies: items}).policies) {
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
