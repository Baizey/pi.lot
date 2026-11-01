import type {ServerConfig} from "../ServerConfig.js";
import {
    decodeArchiveBinding, decodeArchiveBindingResponse, decodeArchiveSequence, sameArchiveBinding,
    type BindingResponse,
} from "../ArchiveProtocol.js";
import {
    ServerHttpError, ServerHttpTransport, SERVER_CONTROL_BYTES,
    type ServerHttpOptions, type ServerHttpPayload,
} from "../ServerHttpTransport.js";
import {
    ConfigSyncProtocolError, MAX_CONFIG_WIRE_BYTES, decodeConfigCheckResult, decodeConfigExchange,
    decodeConfigKey, decodeConfigState,
    type ConfigCheck, type ConfigCheckResult, type ConfigExchange, type ConfigState,
} from "./ConfigSyncProtocol.js";

export type ConfigSyncClientOptions = ServerHttpOptions;

export class ConfigSyncClientError extends ServerHttpError {
    constructor(error: ServerHttpError) {
        super(error.message, error.code, error);
        this.name = "ConfigSyncClientError";
    }
}

/** Protocol validation and response correlation over the shared authenticated HTTP boundary. */
export class ConfigSyncClient {
    private readonly transport: ServerHttpTransport;

    constructor(config: ServerConfig, options: ConfigSyncClientOptions = {}) {
        try { this.transport = new ServerHttpTransport(config, options, "configuration synchronization"); }
        catch (error) { throw safeError(error); }
    }

    async binding(signal?: AbortSignal): Promise<BindingResponse> {
        return this.exchange("GET", "/v1/binding", {}, SERVER_CONTROL_BYTES,
            (value) => decodeArchiveBindingResponse(value), signal);
    }

    async check(request: ConfigCheck, signal?: AbortSignal): Promise<ConfigCheckResult> {
        const normalized = localRequest(() => normalizeCheck(request));
        return this.exchange("POST", "/v1/config/check", control(normalized, SERVER_CONTROL_BYTES), SERVER_CONTROL_BYTES, (value) => {
            const result = decodeConfigCheckResult(value);
            if (!sameArchiveBinding(result.binding, normalized.binding) || result.key !== normalized.key) throw new ConfigSyncProtocolError();
            return result;
        }, signal);
    }

    async sync(request: ConfigExchange, signal?: AbortSignal): Promise<ConfigState> {
        // Decode and serialize before authorization yields: caller mutation cannot change wire identity or correlation.
        const normalized = localRequest(() => decodeConfigExchange(request));
        return this.exchange("POST", "/v1/config/sync", control(normalized, MAX_CONFIG_WIRE_BYTES), MAX_CONFIG_WIRE_BYTES, (value) => {
            const state = decodeConfigState(value);
            if (!sameArchiveBinding(state.binding, normalized.binding) || state.key !== normalized.key
                || (normalized.base_revision !== null && BigInt(state.revision) < BigInt(normalized.base_revision))) {
                throw new ConfigSyncProtocolError();
            }
            return state;
        }, signal);
    }

    private async exchange<T>(method: "GET" | "POST", path: string, payload: ServerHttpPayload, cap: number,
        decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
        try {
            return await this.transport.exchange(method, path, payload, "application/json", cap, (_response, body) => {
                const value = this.transport.json(body);
                // Only this owned decoding boundary can classify schema failures as protocol errors.
                return localRequest(() => decode(value));
            }, signal);
        } catch (error) { throw safeError(error); }
    }
}

function normalizeCheck(value: ConfigCheck): ConfigCheck {
    if (typeof value !== "object" || value === null || Array.isArray(value)
        || Object.keys(value).length !== 4 || !["binding", "key", "known_revision", "sha256"].every((key) => Object.hasOwn(value, key))
        || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}(?![\s\S])/u.test(value.sha256)) throw new ConfigSyncProtocolError();
    return {binding: decodeArchiveBinding(value.binding), key: decodeConfigKey(value.key),
        known_revision: value.known_revision === null ? null : decodeArchiveSequence(value.known_revision), sha256: value.sha256};
}

function control(value: unknown, cap: number): ServerHttpPayload {
    return localRequest(() => {
        const body = Buffer.from(JSON.stringify(value));
        if (body.length > cap) throw new ConfigSyncProtocolError();
        return {body, headers: {"Content-Type": "application/json"}};
    });
}

function localRequest<T>(decode: () => T): T {
    try { return decode(); }
    catch { throw new ConfigSyncClientError(new ServerHttpError("Invalid configuration synchronization data.")); }
}

function safeError(error: unknown): ConfigSyncClientError {
    if (error instanceof ConfigSyncClientError) return error;
    if (error instanceof ServerHttpError) return new ConfigSyncClientError(error);
    return new ConfigSyncClientError(new ServerHttpError("Configuration synchronization server connection or response failed.",
        undefined, {kind: "transport"}));
}
