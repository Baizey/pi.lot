import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";

export class ServerConfigError extends Error {
}

export type ServerConfig = {
    url: string;
    apiKey: string;
};

export class ServerConfigStore {
    readonly file: string;

    constructor(directory = path.join(os.homedir(), ".pilot")) {
        this.file = path.join(directory, "server.json");
    }

    load(): ServerConfig | undefined {
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
            const contents = fs.readFileSync(descriptor, "utf8");
            return parseConfig(JSON.parse(contents));
        } catch {
            // Parser errors can include credential-bearing input. Do not expose them.
            throw new ServerConfigError("Invalid server configuration. Use /server login to replace it, or /server logout to remove it.");
        } finally {
            fs.closeSync(descriptor);
        }
    }

    save(config: ServerConfig): void {
        const validated = parseConfig(config);
        const directory = path.dirname(this.file);
        const temporary = path.join(directory, `.server-${randomUUID()}.tmp`);
        let created = false;
        try {
            fs.mkdirSync(directory, {recursive: true, mode: 0o700});
            const descriptor = fs.openSync(temporary, "wx", 0o600);
            created = true;
            try {
                fs.fchmodSync(descriptor, 0o600);
                fs.writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            // Replace the directory entry, never follow an existing credential-file symlink.
            fs.renameSync(temporary, this.file);
        } catch {
            throw new ServerConfigError("Unable to save server configuration.");
        } finally {
            if (created) fs.rmSync(temporary, {force: true});
        }
    }

    logout(): void {
        try {
            fs.unlinkSync(this.file);
        } catch (error) {
            if (!isMissing(error)) throw new ServerConfigError("Unable to remove server configuration.");
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
