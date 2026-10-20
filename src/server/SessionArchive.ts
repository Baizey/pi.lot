import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {ArchiveClient, ArchiveClientError} from "./ArchiveClient.js";
import {ensureArchiveDirectory} from "./ArchiveJournal.js";
import type {ServerConfig} from "./ServerConfig.js";
import {
    decodeArchiveId, decodeArchiveListParameters,
    type Binding, type ListFilters, type ListPage, type SessionMetadata,
} from "./ArchiveProtocol.js";

export type ArchiveListInput = {filters?: ListFilters; cursor?: string; limit?: number; include_preserved?: boolean};
export type SessionArchiveOptions = {
    client?: ArchiveClient;
    stateDirectory?: string;
    beforeRequest?: (method: "GET" | "POST", path: string, signal?: AbortSignal) => Promise<void>;
};

/** Lazy archive reads and a private verified-byte cache; publication belongs only to the worker. */
export class SessionArchive {
    private readonly client: ArchiveClient;
    private readonly directory: string;

    constructor(private readonly config: ServerConfig, options: SessionArchiveOptions = {}) {
        this.client = options.client ?? new ArchiveClient(config, {beforeRequest: options.beforeRequest});
        this.directory = options.stateDirectory ?? path.join(os.homedir(), ".pilot", "server-archive");
    }

    async list(input: ArchiveListInput = {}, signal?: AbortSignal): Promise<ListPage> {
        const parameters = decodeArchiveListParameters({...input, limit: input.limit === undefined ? 50 : input.limit});
        const {binding, capabilities} = await this.client.binding(signal);
        if ((parameters.include_preserved === true || parameters.filters?.session_id !== undefined)
            && !capabilities?.includes("preserved_variants_v1")) {
            throw new ArchiveClientError("The archive server does not support preserved variants or exact session lookup.");
        }
        // Omit disabled additive options so legacy 0.2 servers retain their exact request schema.
        if (parameters.include_preserved === false) delete parameters.include_preserved;
        return this.client.list({binding, ...parameters}, signal);
    }

    async fetch(sessionId: string, signal?: AbortSignal, variantId?: string): Promise<{snapshot: SessionMetadata; path: string}> {
        const id = decodeArchiveId(sessionId);
        const variant = variantId === undefined ? undefined : decodeArchiveId(variantId);
        const {binding, capabilities} = await this.client.binding(signal);
        if (variant !== undefined && !capabilities?.includes("preserved_variants_v1")) {
            throw new ArchiveClientError("The archive server does not support preserved variants.");
        }
        const downloaded = await this.client.download(binding, id, signal, variant);
        signal?.throwIfAborted();
        const directory = path.join(this.directory, "downloads", this.bindingKey(binding));
        ensureArchiveDirectory(this.directory);
        ensureArchiveDirectory(path.join(this.directory, "downloads"));
        ensureArchiveDirectory(directory);
        const identity = createHash("sha256").update(JSON.stringify([id, variant ?? null])).digest("hex");
        const destination = path.join(directory, `${identity}-${downloaded.snapshot.sha256}.jsonl`);
        this.writeCache(destination, downloaded.body);
        return {snapshot: downloaded.snapshot, path: destination};
    }

    private bindingKey(binding: Binding): string {
        return createHash("sha256").update(JSON.stringify([
            this.config.url, binding.server_id, binding.namespace_id, binding.history_generation,
        ])).digest("hex");
    }

    private writeCache(destination: string, body: Buffer): void {
        const temporary = path.join(path.dirname(destination), `.download-${randomUUID()}.tmp`);
        let created = false;
        try {
            const descriptor = fs.openSync(temporary, "wx", 0o600);
            created = true;
            try {
                fs.writeFileSync(descriptor, body);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            fs.renameSync(temporary, destination);
        } finally {
            if (created) fs.rmSync(temporary, {force: true});
        }
    }
}
