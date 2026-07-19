// noinspection SqlNoDataSourceInspection

import {SqliteDatabase} from "./sqlite";
import {fsAccessTypesSql, policyLifetimesSql, policyStatusesSql} from "./policy-common";
import {PolicyLifetime, PolicyStatus} from "../policy/types";
import {FsAccessType, PathPolicy} from "../policy/path/types";
import {sanitizePathPolicySnapshot} from "../policy/path/validation";

type PathPolicyRuleRow = {
    path: string;
    accessType: FsAccessType;
    lifetime: PolicyLifetime;
    status: PolicyStatus;
    reason: string;
};

export class PathPolicyDao {
    private schemaInitialized = false;

    constructor(private readonly db: SqliteDatabase) {
    }

    initializeSchema() {
        if (this.schemaInitialized) return this;
        this.db.exec(`
            create table if not exists "policy_path_rules"
            (
                "path"
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
                "path",
                "accessType"
            )
                );

            create index if not exists "idx_policy_path_rules_access"
                on "policy_path_rules" ("accessType", "path");
        `);
        this.schemaInitialized = true;
        return this;
    }

    loadPolicies(): PathPolicy[] {
        this.initializeSchema();
        const rows = this.db.prepare(`
            select "path", "accessType", "lifetime", "status", "reason"
            from "policy_path_rules"
            order by "path" asc, "accessType" asc
        `).all() as PathPolicyRuleRow[];

        const policies = new Map<string, PathPolicy>();
        for (const row of rows) {
            const policy = policies.get(row.path) ?? {path: row.path, info: {}};
            policy.info[row.accessType] = {
                accessType: row.accessType,
                lifetime: row.lifetime,
                status: row.status,
                reason: row.reason,
            };
            policies.set(row.path, policy);
        }

        return sanitizePathPolicySnapshot({policies: [...policies.values()]}).policies;
    }

    replacePolicies(policies: PathPolicy[]): void {
        this.initializeSchema();
        const now = Date.now();
        const run = this.db.transaction((items: PathPolicy[]) => {
            this.db.prepare(`delete
                             from "policy_path_rules"`).run();
            const insert = this.db.prepare(`
                insert into "policy_path_rules" ("path", "accessType", "lifetime", "status", "reason", "updatedAt")
                values (@path, @accessType, @lifetime, @status, @reason, @updatedAt)
            `);
            for (const policy of sanitizePathPolicySnapshot({policies: items}).policies) {
                for (const status of Object.values(policy.info)) {
                    if (!status) continue;
                    insert.run({path: policy.path, ...status, updatedAt: now});
                }
            }
        });
        run(policies);
    }
}
