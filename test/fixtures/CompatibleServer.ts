import {ArchiveClient} from "../../src/server/ArchiveClient.js";
import {ConfigSyncClient} from "../../src/server/config-sync/ConfigSyncClient.js";
import type {ServerConfig} from "../../src/server/ServerConfig.js";
import type {ServerHttpOptions} from "../../src/server/ServerHttpTransport.js";

/** Protocol-only fixtures assume a compatible, authorized handshake; shared-gate tests exercise it explicitly. */
function compatibleServer(options: ServerHttpOptions): ServerHttpOptions {
    const fetcher = options.fetch ?? globalThis.fetch;
    return {...options,
        fetch: async (input, init) => new URL(input instanceof Request ? input.url : input).pathname === "/v1/version"
            ? Response.json({version: "0.4.0"}) : fetcher(input, init),
        beforeRequest: async (method, path, signal) => {
            if (path !== "/v1/version") await options.beforeRequest?.(method, path, signal);
        },
    };
}

export function archiveClient(config: ServerConfig, options: ServerHttpOptions = {}): ArchiveClient {
    return new ArchiveClient(config, compatibleServer(options));
}

export function configClient(config: ServerConfig, options: ServerHttpOptions = {}): ConfigSyncClient {
    return new ConfigSyncClient(config, compatibleServer(options));
}
