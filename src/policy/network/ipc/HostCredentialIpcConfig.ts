import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {HostCredentialIpcOptions, HostCredentialUnixSocket} from "./HostCredentialIpc.js";

const CONFIG_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DBUS_NAME_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]*\.)+[A-Za-z_][A-Za-z0-9_-]*(?:\.\*)?$/;
const PATH_TEMPLATE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)}/g;

export interface HostCredentialIpcConfigStoreInterface {
    load(environment?: NodeJS.ProcessEnv): HostCredentialIpcOptions;
}

export class HostCredentialIpcConfigStore implements HostCredentialIpcConfigStoreInterface {
    constructor(readonly file = defaultHostCredentialIpcConfigFile()) {}

    load(environment: NodeJS.ProcessEnv = process.env): HostCredentialIpcOptions {
        if (!fs.existsSync(this.file)) return defaultHostCredentialIpcOptions();

        let value: unknown;
        try {
            value = JSON.parse(fs.readFileSync(this.file, "utf8"));
        } catch (error) {
            throw new Error(`Unable to read credential IPC configuration from ${this.file}.`, {cause: error});
        }

        try {
            return parseConfig(value, environment);
        } catch (error) {
            throw new Error(`Invalid credential IPC configuration in ${this.file}.`, {cause: error});
        }
    }
}

export function defaultHostCredentialIpcConfigFile(): string {
    return path.join(os.homedir(), ".pilot", "credential-ipc.json");
}

export function defaultHostCredentialIpcOptions(): HostCredentialIpcOptions {
    return {
        sessionBus: {talk: ["org.freedesktop.secrets"]},
        unixSockets: [{
            id: "ssh-agent",
            environment: "SSH_AUTH_SOCK",
            optional: true,
        }],
    };
}

function parseConfig(value: unknown, environment: NodeJS.ProcessEnv): HostCredentialIpcOptions {
    const root = record(value, "configuration root");
    exactKeys(root, ["version", "sessionBus", "unixSockets"], "configuration root");
    if (root.version !== CONFIG_VERSION) {
        throw new Error(`unsupported credential IPC configuration version: ${String(root.version)}`);
    }

    const sessionBus = parseSessionBus(root.sessionBus);
    if (!Array.isArray(root.unixSockets)) throw new Error("unixSockets must be an array");
    const ids = new Set<string>();
    const unixSockets: HostCredentialUnixSocket[] = [];
    for (const [index, rawSocket] of root.unixSockets.entries()) {
        const socket = parseUnixSocket(rawSocket, environment, index);
        if (ids.has(socket.id)) throw new Error(`duplicate unixSockets id: ${JSON.stringify(socket.id)}`);
        ids.add(socket.id);
        if (socket.enabled !== false) unixSockets.push(withoutEnabled(socket));
    }

    return {
        ...(sessionBus ? {sessionBus} : {}),
        unixSockets,
    };
}

function parseSessionBus(value: unknown): HostCredentialIpcOptions["sessionBus"] {
    const raw = record(value, "sessionBus");
    exactKeys(raw, ["enabled", "talk"], "sessionBus");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        throw new Error("sessionBus.enabled must be a boolean");
    }
    if (raw.enabled === false) return undefined;
    if (!Array.isArray(raw.talk)) throw new Error("sessionBus.talk must be an array");

    const talk = [...new Set(raw.talk.map((name, index) => {
        if (typeof name !== "string" || !DBUS_NAME_PATTERN.test(name)) {
            throw new Error(`sessionBus.talk[${index}] is not a valid D-Bus well-known name`);
        }
        return name;
    }))];
    return {talk};
}

type ParsedUnixSocket = HostCredentialUnixSocket & {enabled?: boolean};

function parseUnixSocket(
    value: unknown,
    environment: NodeJS.ProcessEnv,
    index: number,
): ParsedUnixSocket {
    const description = `unixSockets[${index}]`;
    const raw = record(value, description);
    exactKeys(raw, ["id", "enabled", "optional", "environment", "path"], description);

    if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
        throw new Error(`${description}.id must match ${ID_PATTERN}`);
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        throw new Error(`${description}.enabled must be a boolean`);
    }
    if (raw.optional !== undefined && typeof raw.optional !== "boolean") {
        throw new Error(`${description}.optional must be a boolean`);
    }
    const hasEnvironment = raw.environment !== undefined;
    const hasPath = raw.path !== undefined;
    if (hasEnvironment === hasPath) {
        throw new Error(`${description} must define exactly one of environment or path`);
    }

    const common = {
        id: raw.id,
        enabled: raw.enabled,
        optional: raw.optional ?? true,
    };
    if (hasEnvironment) {
        if (typeof raw.environment !== "string" || !ENVIRONMENT_VARIABLE_PATTERN.test(raw.environment)) {
            throw new Error(`${description}.environment is not a valid environment variable name`);
        }
        return {...common, environment: raw.environment};
    }

    if (typeof raw.path !== "string") throw new Error(`${description}.path must be a string`);
    return {...common, path: expandPathTemplate(raw.path, environment, description)};
}

function expandPathTemplate(template: string, environment: NodeJS.ProcessEnv, description: string): string {
    const expanded = template.replace(PATH_TEMPLATE_PATTERN, (_match, variable: string) => {
        const value = environment[variable];
        if (!value) throw new Error(`${description}.path references unavailable environment variable ${variable}`);
        return value;
    });
    if (expanded.includes("$") || expanded.includes("\0") || !path.isAbsolute(expanded)) {
        throw new Error(`${description}.path must resolve to an absolute path using only \${VARIABLE} expansion`);
    }
    return path.normalize(expanded);
}

function withoutEnabled(socket: ParsedUnixSocket): HostCredentialUnixSocket {
    if (typeof socket.environment === "string") {
        return {id: socket.id, environment: socket.environment, optional: socket.optional};
    }
    return {id: socket.id, path: socket.path, optional: socket.optional};
}

function record(value: unknown, description: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${description} must be an object`);
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], description: string): void {
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unexpected.length > 0) {
        throw new Error(`${description} contains unsupported keys: ${unexpected.join(", ")}`);
    }
}
