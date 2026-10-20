import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {ArchiveLock, ensurePrivateDirectory, syncDirectory} from "./ArchiveLock.js";
import {ArchiveInbox} from "./ArchiveInbox.js";

export class ServerConfigError extends Error {
}

export type ServerConfig = {
    url: string;
    apiKey: string;
};

export class ServerConfigStore {
    readonly file: string;
    readonly directory: string;
    readonly archiveDirectory: string;
    private readonly lock: ArchiveLock;

    constructor(directory = path.join(os.homedir(), ".pilot")) {
        this.directory = path.resolve(directory);
        this.file = path.join(this.directory, "server.json");
        this.archiveDirectory = path.join(this.directory, "server-archive");
        this.lock = new ArchiveLock(path.join(this.directory, "server-config.lock"));
    }

    load(): ServerConfig | undefined {
        return this.read()?.config;
    }

    /** No migration, mutation, or lock: reload this before every authenticated request. */
    connection(): {config: ServerConfig; generation: string} | undefined {
        const stored = this.read();
        return stored?.generation ? {config: stored.config, generation: stored.generation} : undefined;
    }

    /** Called at startup/configuration, never as hidden departure work. */
    ensureConnection(): {config: ServerConfig; generation: string} | undefined {
        return this.withLock(() => {
            const stored = this.read();
            if (!stored) return undefined;
            if (stored.generation) return {config: stored.config, generation: stored.generation};
            const generation = randomUUID();
            new ArchiveInbox(this.archiveDirectory).configurationTransition(() => this.replace(stored.config, generation));
            return {config: stored.config, generation};
        });
    }

    save(config: ServerConfig): void {
        const validated = parseConfig(config);
        try {
            this.withLock(() => {
                new ArchiveInbox(this.archiveDirectory).configurationTransition(() => this.replace(validated, randomUUID()));
            });
        } catch {
            throw new ServerConfigError("Unable to save server configuration.");
        }
    }

    logout(): void {
        try {
            this.withLock(() => {
                new ArchiveInbox(this.archiveDirectory).configurationTransition(() => {
                    fs.rmSync(this.file, {force: true});
                    syncDirectory(this.directory);
                });
            });
        } catch {
            throw new ServerConfigError("Unable to remove server configuration.");
        }
    }

    private read(): {config: ServerConfig; generation?: string} | undefined {
        let descriptor: number;
        try {
            descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        } catch (error) {
            if (isMissing(error)) return undefined;
            throw new ServerConfigError("Unable to read server configuration.");
        }
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 16384) {
                throw new ServerConfigError("Server configuration must be a private regular file.");
            }
            const buffer = Buffer.alloc(16385);
            const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
            if (length > 16384) throw new ServerConfigError("Oversized server configuration.");
            const value: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
            if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ServerConfigError("Invalid configuration.");
            const {generation, ...credentials} = value as Record<string, unknown>;
            if (generation !== undefined && (typeof generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(generation))) {
                throw new ServerConfigError("Invalid connection generation.");
            }
            return {config: parseConfig(credentials), ...(typeof generation === "string" ? {generation} : {})};
        } catch {
            // Parser errors can include credential-bearing input. Do not expose them.
            throw new ServerConfigError("Invalid server configuration. Use /server login to replace it, or /server logout to remove it.");
        } finally {
            fs.closeSync(descriptor);
        }
    }

    private withLock<T>(operation: () => T): T {
        ensurePrivateDirectory(this.directory);
        if (!this.lock.acquire(250)) throw new ServerConfigError("Server configuration is busy.");
        try {
            return operation();
        } finally {
            this.lock.release();
        }
    }

    private replace(config: ServerConfig, generation: string): void {
        const directory = this.directory;
        const temporary = path.join(directory, `.server-${randomUUID()}.tmp`);
        let created = false;
        try {
            const descriptor = fs.openSync(temporary, "wx", 0o600);
            created = true;
            try {
                fs.fchmodSync(descriptor, 0o600);
                fs.writeFileSync(descriptor, `${JSON.stringify({...config, generation}, null, 2)}\n`, "utf8");
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            // Replace the directory entry, never follow an existing credential-file symlink.
            fs.renameSync(temporary, this.file);
            syncDirectory(directory);
            syncDirectory(path.dirname(directory));
        } catch {
            throw new ServerConfigError("Unable to save server configuration.");
        } finally {
            if (created) fs.rmSync(temporary, {force: true});
        }
    }
}

function parseConfig(value: unknown): ServerConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ServerConfigError("Server configuration requires a URL and API key.");
    }
    const config = value as Record<string, unknown>;
    if (Object.keys(config).length !== 2 || typeof config.url !== "string" || typeof config.apiKey !== "string") {
        throw new ServerConfigError("Server configuration requires only url and apiKey.");
    }
    let url: URL;
    try {
        url = new URL(config.url.trim());
    } catch {
        throw new ServerConfigError("Enter a valid server URL.");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:")
        || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new ServerConfigError("Use an HTTP or HTTPS server URL without a path, credentials, query, or fragment.");
    }
    const apiKey = config.apiKey.trim();
    if (!/^[\x21-\x7e]+$/.test(apiKey) || Buffer.byteLength(apiKey) > 4096 || url.href.length > 4096) {
        throw new ServerConfigError("Enter a nonempty API key without spaces or control characters, and a server URL no longer than 4096 characters.");
    }
    return {url: url.origin, apiKey};
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
