import {PolicyLifetime, PolicyResponse} from "../policy/types";
import {PolicyAccessType} from "../policy/types.js";

export const policyStatusesSql = sqlStringList(Object.values(PolicyResponse));
export const policyLifetimesSql = sqlStringList(Object.values(PolicyLifetime));
export const fsAccessTypesSql = sqlStringList(Object.values(PolicyAccessType));

function sqlStringList(values: string[]): string {
    return values.map((it) => `'${it.replace(/'/g, "''")}'`).join(", ");
}
