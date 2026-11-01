import {createHash} from "node:crypto";
import {decodeArchiveBinding, decodeArchiveSequence, type Binding} from "../ArchiveProtocol.js";
import {parseDisplayDefaults} from "../../tui/tool/DisplayDefaults.js";
import {parseSubagentDefaults} from "../../subagents/SubagentDefaults.js";
import {parseWebSearchConfig} from "../../web-search/WebSearchConfig.js";
import {POLICY_AREAS, PolicyAccessType, PolicyFallbackResponse, PolicyResponse} from "../../policy/types.js";

export const CONFIG_SYNC_CAPABILITY = "config_sync_v1";
export const CONFIG_KEYS = ["display-defaults", "subagent-defaults", "policy-defaults", "web-search", "global-policies"] as const;
export const MAX_CONFIG_CONTENT_BYTES = 256 * 1024;
export const MAX_CONFIG_WIRE_BYTES = 2 * MAX_CONFIG_CONTENT_BYTES + 8192;
export type ConfigKey = typeof CONFIG_KEYS[number];
export type ConfigOutcome = "client_won" | "server_won" | "merged" | "unchanged";
export type ConfigSnapshot = {content: string | null; modifiedAt: string; materialized: string | null};
export type ConfigBaseline = {content: string | null; materialized: string | null};
export type GlobalPolicyRule = {pattern: string; accessType: PolicyAccessType; status: PolicyResponse; reason: string};
export type ConfigCheck = {binding: Binding; key: ConfigKey; known_revision: string | null; sha256: string};
export type ConfigCheckResult = {binding: Binding; key: ConfigKey; sync_needed: boolean};
export type ConfigExchange = {
    binding: Binding; key: ConfigKey; base_revision: string | null; change_id: string;
    modified_at: string; schema_version: 1; content: string | null; sha256: string;
};
export type ConfigState = {
    binding: Binding; key: ConfigKey; revision: string; schema_version: 1;
    content: string | null; sha256: string; updated_at: string | null; outcome: ConfigOutcome;
};

export class ConfigSyncProtocolError extends Error {
    constructor() {
        super("Invalid configuration synchronization data.");
        this.name = "ConfigSyncProtocolError";
    }
}

/** Canonical saved values, not file formatting, determine whether synchronization is necessary. */
export function canonicalConfigContent(value: unknown): string {
    const content = canonicalValue(value, 0);
    requireConfig(Buffer.byteLength(content) <= MAX_CONFIG_CONTENT_BYTES);
    return content;
}

export function configHash(content: string | null): string {
    return createHash("sha256").update(content ?? "", "utf8").digest("hex");
}

export function validateConfigContent(key: ConfigKey, content: unknown): asserts content is string | null {
    if (content === null) return;
    requireConfig(typeof content === "string" && Buffer.byteLength(content) <= MAX_CONFIG_CONTENT_BYTES);
    try {
        const value: unknown = JSON.parse(content as string);
        // Reject unsupported JSON values and malformed Unicode at this boundary too.
        canonicalConfigContent(value);
        switch (key) {
            case "display-defaults": parseDisplayDefaults(value); break;
            case "subagent-defaults": parseSubagentDefaults(value); break;
            case "web-search": parseWebSearchConfig(value); break;
            case "policy-defaults": {
                const row = configObject(value, POLICY_AREAS);
                const allowed = Object.values(PolicyFallbackResponse);
                for (const area of POLICY_AREAS) requireConfig(allowed.some((entry) => entry === row[area]));
                break;
            }
            case "global-policies": {
                const rules = decodeGlobalPolicyRules(content as string);
                requireConfig(rules.length > 0 && content === canonicalConfigContent({rules}));
                break;
            }
        }
    } catch {
        // JSON/parser messages can quote credentials. Never propagate their causes or input.
        throw new ConfigSyncProtocolError();
    }
}

export function decodeGlobalPolicyRules(content: string | null): GlobalPolicyRule[] {
    if (content === null) return [];
    try {
        requireConfig(Buffer.byteLength(content) <= MAX_CONFIG_CONTENT_BYTES);
        const root = configObject(JSON.parse(content), ["rules"]);
        requireConfig(Array.isArray(root.rules) && root.rules.length <= 1024);
        const identities = new Set<string>();
        const rules = (root.rules as unknown[]).map((entry): GlobalPolicyRule => {
            const row = configObject(entry, ["pattern", "accessType", "status", "reason"]);
            const pattern = configText(row.pattern, 4096);
            requireConfig(pattern.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(pattern));
            const reason = configText(row.reason, 4096);
            requireConfig(Object.values(PolicyAccessType).some((type) => type === row.accessType));
            requireConfig(Object.values(PolicyResponse).some((status) => status === row.status));
            const rule = {pattern, accessType: row.accessType as PolicyAccessType, status: row.status as PolicyResponse, reason};
            const identity = JSON.stringify([pattern, rule.accessType]);
            requireConfig(!identities.has(identity));
            identities.add(identity);
            return rule;
        });
        return rules.sort((a, b) => compareConfigText(a.pattern, b.pattern) || compareConfigText(a.accessType, b.accessType));
    } catch {
        throw new ConfigSyncProtocolError();
    }
}

export function decodeConfigExchange(value: unknown): ConfigExchange {
    const row = configObject(value, ["binding", "key", "base_revision", "change_id", "modified_at", "schema_version", "content", "sha256"]);
    const key = decodeConfigKey(row.key);
    validateConfigContent(key, row.content);
    requireConfig(row.schema_version === 1 && row.sha256 === configHash(row.content));
    requireConfig(typeof row.change_id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/u.test(row.change_id));
    return {binding: binding(row.binding), key, base_revision: row.base_revision === null ? null : sequence(row.base_revision),
        change_id: row.change_id as string, modified_at: decodeConfigTimestamp(row.modified_at), schema_version: 1,
        content: row.content, sha256: configHash(row.content)};
}

export function decodeConfigState(value: unknown): ConfigState {
    const row = configObject(value, ["binding", "key", "revision", "schema_version", "content", "sha256", "updated_at", "outcome"]);
    const key = decodeConfigKey(row.key);
    const revision = sequence(row.revision);
    validateConfigContent(key, row.content);
    requireConfig(row.schema_version === 1 && row.sha256 === configHash(row.content));
    requireConfig(typeof row.outcome === "string" && ["client_won", "server_won", "merged", "unchanged"].includes(row.outcome));
    const updatedAt = row.updated_at === null ? null : decodeConfigTimestamp(row.updated_at);
    requireConfig(revision === "0" ? row.content === null && updatedAt === null : updatedAt !== null);
    return {binding: binding(row.binding), key, revision, schema_version: 1, content: row.content,
        sha256: configHash(row.content), updated_at: updatedAt, outcome: row.outcome as ConfigOutcome};
}

export function decodeConfigCheckResult(value: unknown): ConfigCheckResult {
    const row = configObject(value, ["binding", "key", "sync_needed"]);
    requireConfig(typeof row.sync_needed === "boolean");
    return {binding: binding(row.binding), key: decodeConfigKey(row.key), sync_needed: row.sync_needed as boolean};
}

export function decodeConfigKey(value: unknown): ConfigKey {
    requireConfig(CONFIG_KEYS.some((key) => key === value));
    return value as ConfigKey;
}

export function decodeConfigTimestamp(value: unknown): string {
    requireConfig(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value));
    const date = new Date(value as string);
    requireConfig(Number.isFinite(date.getTime()) && date.getTime() >= 0 && date.toISOString() === value);
    return value as string;
}

export function compareConfigText(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function configObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    requireConfig(typeof value === "object" && value !== null && !Array.isArray(value));
    const row = value as Record<string, unknown>;
    requireConfig(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
    return row;
}

function canonicalValue(value: unknown, depth: number): string {
    requireConfig(depth <= 32);
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "string") return JSON.stringify(configText(value, MAX_CONFIG_CONTENT_BYTES));
    if (typeof value === "number") {
        requireConfig(Number.isSafeInteger(value));
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalValue(item, depth + 1)).join(",")}]`;
    requireConfig(typeof value === "object" && value !== null
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
    const row = value as Record<string, unknown>;
    // Serialize pairs directly: JSON.stringify(object) reorders integer-like keys.
    return `{${Object.keys(row).sort(compareConfigText).map((key) =>
        `${JSON.stringify(configText(key, MAX_CONFIG_CONTENT_BYTES))}:${canonicalValue(row[key], depth + 1)}`).join(",")}}`;
}

function configText(value: unknown, maxBytes: number): string {
    requireConfig(typeof value === "string" && Buffer.byteLength(value) <= maxBytes && !/[\ud800-\udfff]/u.test(value));
    return value as string;
}

function binding(value: unknown): Binding {
    try { return decodeArchiveBinding(value); }
    catch { throw new ConfigSyncProtocolError(); }
}

function sequence(value: unknown): string {
    try { return decodeArchiveSequence(value); }
    catch { throw new ConfigSyncProtocolError(); }
}

function requireConfig(valid: boolean): asserts valid {
    if (!valid) throw new ConfigSyncProtocolError();
}
