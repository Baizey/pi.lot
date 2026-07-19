import {PolicyLifetime, PolicyStatus,} from "../types";
import {FsAccessType, PathPolicy, PathPolicyStatus,} from "./types";

export function parseJsonObjectFile<T>(read: () => string): T | null {
    try {
        const parsed = JSON.parse(read()) as unknown;
        return isRecord(parsed) ? parsed as T : null;
    } catch {
        return null;
    }
}

export function sanitizePathPolicySnapshot(value: unknown): { policies: PathPolicy[] } {
    const record = isRecord(value) ? value : {};
    const policies = Array.isArray(record.policies)
        ? record.policies.map(sanitizePathPolicy).filter((it): it is PathPolicy => it !== null)
        : [];
    return {policies};
}

function sanitizePathPolicy(value: unknown): PathPolicy | null {
    if (!isRecord(value) || !isNonEmptyString(value.path) || !isRecord(value.info)) return null;
    const info: PathPolicy["info"] = {};

    for (const accessType of Object.values(FsAccessType)) {
        const status = sanitizePathPolicyStatus(value.info[accessType], accessType);
        if (status) info[accessType] = status;
    }

    return Object.keys(info).length > 0 ? {path: value.path, info} : null;
}

function sanitizePathPolicyStatus(value: unknown, expectedAccessType: FsAccessType): PathPolicyStatus | null {
    if (!isRecord(value)) return null;
    if (value.accessType !== expectedAccessType) return null;
    if (!isPolicyStatus(value.status) || !isPolicyLifetime(value.lifetime) || typeof value.reason !== "string") return null;
    return {accessType: expectedAccessType, status: value.status, lifetime: value.lifetime, reason: value.reason};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isPolicyStatus(value: unknown): value is PolicyStatus {
    return typeof value === "string" && Object.values(PolicyStatus).some((status) => status === value);
}

function isPolicyLifetime(value: unknown): value is PolicyLifetime {
    return typeof value === "string" && Object.values(PolicyLifetime).some((lifetime) => lifetime === value);
}