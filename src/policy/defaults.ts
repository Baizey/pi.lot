import {POLICY_AREAS, PolicyArea, PolicyFallbackResponse} from "./types.js";
import {JsonDefaultsFile} from "../storage/JsonDefaultsFile.js";
import path from "node:path";
import os from "node:os";

export type ResponseDefaults = Record<PolicyArea, PolicyFallbackResponse>

export const initialPolicyDefaults: Readonly<ResponseDefaults> = {
    fs_read: PolicyFallbackResponse.allow,
    fs_write: PolicyFallbackResponse.ask_user,
    fs_mmap: PolicyFallbackResponse.ask_user,
    web_read: PolicyFallbackResponse.allow,
    web_write: PolicyFallbackResponse.ask_user,
    web_dns: PolicyFallbackResponse.ask_user,
    web_grpc: PolicyFallbackResponse.ask_user,
    web_smtp: PolicyFallbackResponse.ask_user,
    web_adb: PolicyFallbackResponse.ask_user,
    web_postgres: PolicyFallbackResponse.ask_user,
    web_mysql: PolicyFallbackResponse.ask_user,
    web_redis: PolicyFallbackResponse.ask_user,
    web_mongodb: PolicyFallbackResponse.ask_user,
    web_mqtt: PolicyFallbackResponse.ask_user,
    web_amqp: PolicyFallbackResponse.ask_user,
    web_kafka: PolicyFallbackResponse.ask_user,
    web_nats: PolicyFallbackResponse.ask_user,
    web_ftp: PolicyFallbackResponse.ask_user,
    web_smb: PolicyFallbackResponse.ask_user,
    web_nfs: PolicyFallbackResponse.ask_user,
    web_ldap: PolicyFallbackResponse.ask_user,
    web_imap: PolicyFallbackResponse.ask_user,
    web_pop3: PolicyFallbackResponse.ask_user,
    web_ssh: PolicyFallbackResponse.ask_user,
    web_tcp: PolicyFallbackResponse.ask_user,
    web_udp: PolicyFallbackResponse.ask_user,
    web_websocket: PolicyFallbackResponse.ask_user,
};

/** Only these additive fields may be absent in older saved/config-sync snapshots. */
export const ADDITIVE_POLICY_AREAS: readonly PolicyArea[] = Object.freeze([
    PolicyArea.fs_mmap,
    PolicyArea.web_adb,
    PolicyArea.web_postgres,
    PolicyArea.web_mysql,
    PolicyArea.web_redis,
    PolicyArea.web_mongodb,
    PolicyArea.web_mqtt,
    PolicyArea.web_amqp,
    PolicyArea.web_kafka,
    PolicyArea.web_nats,
    PolicyArea.web_ftp,
    PolicyArea.web_smb,
    PolicyArea.web_nfs,
    PolicyArea.web_ldap,
    PolicyArea.web_imap,
    PolicyArea.web_pop3,
]);

type SavedPolicyDefaults = Omit<ResponseDefaults, "fs_mmap"> & {fs_mmap_paths?: PolicyFallbackResponse};
const mmapPathsKey = "fs_mmap_paths";

export function parsePolicyDefaults(value: unknown): ResponseDefaults {
    const row = policyDefaultsRecord(value);
    if (Object.keys(row).some((key) => !POLICY_AREAS.some((area) => area === key))) {
        throw new Error("Unknown policy default area.");
    }
    const defaults = {...initialPolicyDefaults};
    for (const area of POLICY_AREAS) {
        const present = Object.hasOwn(row, area);
        if (!present && ADDITIVE_POLICY_AREAS.includes(area)) continue;
        const response = present ? row[area] : undefined;
        if (!isFallbackResponse(response)) throw new Error("Missing or invalid policy default response.");
        defaults[area] = response;
    }
    return defaults;
}

/** The old saved key described explicit Bash requests, not path authority. */
export function parseSavedPolicyDefaults(value: unknown): ResponseDefaults {
    const row = policyDefaultsRecord(value);
    const hasLegacy = Object.hasOwn(row, PolicyArea.fs_mmap);
    const hasPathDefault = Object.hasOwn(row, mmapPathsKey);
    if (hasLegacy && hasPathDefault) throw new Error("Conflicting policy default areas for mmap.");
    if (hasLegacy && !isFallbackResponse(row[PolicyArea.fs_mmap])) {
        throw new Error("Missing or invalid policy default response.");
    }
    const {[PolicyArea.fs_mmap]: _legacy, [mmapPathsKey]: pathDefault, ...rest} = row;
    return parsePolicyDefaults(hasPathDefault ? {...rest, [PolicyArea.fs_mmap]: pathDefault} : rest);
}

function policyDefaultsRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Policy defaults must be an object.");
    }
    return value as Record<string, unknown>;
}

function isFallbackResponse(value: unknown): value is PolicyFallbackResponse {
    return Object.values(PolicyFallbackResponse).some((response) => response === value);
}

export interface PolicyDefaultJsonStorageInterface {
    load(): ResponseDefaults;
    save(defaults: ResponseDefaults): void;
}

export class PolicyDefaultJsonStorage implements PolicyDefaultJsonStorageInterface {
    readonly file: string;
    private readonly defaultsFile: JsonDefaultsFile<ResponseDefaults | SavedPolicyDefaults>;

    constructor(
        filename: string = "policy-defaults",
        directory = path.join(os.homedir(), ".pilot")
    ) {
        // Keep the shared fallback frozen from the first store construction, as before.
        Object.freeze(initialPolicyDefaults);
        this.file = path.join(directory, `${filename}.json`);
        this.defaultsFile = new JsonDefaultsFile(
            this.file,
            "policy defaults",
            parseSavedPolicyDefaults,
            () => initialPolicyDefaults,
        );
    }

    load(): ResponseDefaults {
        // Both read callbacks return runtime defaults; the union also permits the saved write shape.
        return this.defaultsFile.load() as ResponseDefaults;
    }

    save(defaults: ResponseDefaults): void {
        const {fs_mmap, ...saved} = parsePolicyDefaults(defaults);
        // Omitting the built-in fallback keeps ordinary saves readable by older peers.
        this.defaultsFile.save(fs_mmap === initialPolicyDefaults.fs_mmap ? saved : {...saved, fs_mmap_paths: fs_mmap});
    }
}
