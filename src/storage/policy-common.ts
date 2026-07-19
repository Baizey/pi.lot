import {PolicyLifetime, PolicyStatus} from "../policy/types";
import {FsAccessType} from "../policy/path/types.js";

export const policyStatusesSql = sqlStringList(Object.values(PolicyStatus));
export const policyLifetimesSql = sqlStringList(Object.values(PolicyLifetime));
export const fsAccessTypesSql = sqlStringList(Object.values(FsAccessType));

function sqlStringList(values: string[]): string {
    return values.map((it) => `'${it.replace(/'/g, "''")}'`).join(", ");
}
