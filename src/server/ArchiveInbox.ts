import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {ArchiveLock, ensurePrivateDirectory, syncDirectory} from "./ArchiveLock.js";
import {decodeArchiveSourceScope, type ArchiveSourceScope} from "./ArchiveSourceScope.js";

export type ArchiveManifest = {
    version: 1;
    id: string;
    origin: string;
    generation: string;
    source: ArchiveSourceScope;
};
export type ArchiveControl = {version: 1; token: string};
export class ArchiveInboxBusyError extends Error {}
/** Descriptor/schema or immutable enqueue-identity failure, never a storage failure. */
export class ArchiveInboxInvalidError extends Error {}
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_DESCRIPTORS = 1024;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Producer handoff only: SQLite, transcript reads and HTTP never occur under this lock. */
export class ArchiveInbox {
    readonly directory: string;
    private readonly lock: ArchiveLock;

    constructor(readonly root: string) {
        this.directory = path.join(root, "inbox");
        this.lock = new ArchiveLock(path.join(root, "inbox.lock"));
    }

    publish(source: ArchiveSourceScope, origin: string, generation: string, id: string = randomUUID()): ArchiveManifest {
        const manifest = decodeManifest({version: 1, id, origin, generation, source});
        const contents = JSON.stringify(manifest);
        if (Buffer.byteLength(contents) > MAX_DESCRIPTOR_BYTES) throw new Error("Archive descriptor exceeds 16 KiB.");
        this.withLock(() => {
            const file = path.join(this.directory, `${manifest.id}.json`);
            if (fs.existsSync(file)) {
                if (JSON.stringify(this.readManifest(manifest.id)) !== contents) throw new Error("Archive enqueue identity collision.");
                // A previous rename may have succeeded while its directory fsync
                // failed. Idempotent admission must repair durability before success.
                syncDirectory(this.directory);
                return;
            }
            if (this.ids().length >= MAX_DESCRIPTORS) throw new Error("Archive inbox is full; source was not queued.");
            this.replace(file, contents);
        });
        return manifest;
    }

    signal(): ArchiveControl {
        return this.configurationTransition(() => {});
    }

    /** The event is durable before a config commit, and cannot be acknowledged until
     * that commit finishes. Failed admission therefore never changes authorization. */
    configurationTransition(commit: () => void): ArchiveControl {
        const event: ArchiveControl = {version: 1, token: randomUUID()};
        this.withLock(() => {
            this.replace(path.join(this.directory, "control.json"), JSON.stringify(event));
            commit();
        });
        return event;
    }

    /** No creation, lock acquisition or acknowledgment: safe after worker-lock release. */
    ids(): string[] {
        try {
            return fs.readdirSync(this.directory).filter(name => name.endsWith(".json") && ID.test(name.slice(0, -5)))
                .map(name => name.slice(0, -5)).sort();
        } catch (error) {
            if (isMissing(error)) return [];
            throw error;
        }
    }

    readManifest(id: string): ArchiveManifest | undefined {
        if (!ID.test(id)) throw new Error("Invalid archive enqueue identity.");
        const value = this.read(path.join(this.directory, `${id}.json`));
        if (value === undefined) return undefined;
        try {
            const manifest = decodeManifest(value);
            if (manifest.id !== id) throw new Error("Archive descriptor identity mismatch.");
            return manifest;
        } catch {
            throw new ArchiveInboxInvalidError("Invalid archive descriptor; retained for inspection.");
        }
    }

    control(): ArchiveControl | undefined {
        const value = this.read(path.join(this.directory, "control.json"));
        if (value === undefined) return undefined;
        if (!isRecord(value) || value.version !== 1 || typeof value.token !== "string" || !ID.test(value.token)
            || Object.keys(value).length !== 2) throw new ArchiveInboxInvalidError("Invalid archive control event.");
        return {version: 1, token: value.token};
    }

    /** Caller must commit the journal import before calling this method. */
    acknowledge(id: string): void {
        if (!ID.test(id)) throw new Error("Invalid archive enqueue identity.");
        this.withLock(() => {
            fs.rmSync(path.join(this.directory, `${id}.json`), {force: true});
            syncDirectory(this.directory);
        });
    }

    acknowledgeControl(imported: ArchiveControl): void {
        this.withLock(() => {
            if (this.control()?.token !== imported.token) return;
            fs.unlinkSync(path.join(this.directory, "control.json"));
            syncDirectory(this.directory);
        });
    }

    private withLock<T>(operation: () => T): T {
        ensurePrivateDirectory(this.root);
        if (!this.lock.acquire(250)) throw new ArchiveInboxBusyError("Archive inbox is busy; source was not queued.");
        try {
            ensurePrivateDirectory(this.directory);
            // Persist newly created directory entries before declaring handoff durable.
            syncDirectory(this.root);
            syncDirectory(path.dirname(this.root));
            return operation();
        } finally {
            this.lock.release();
        }
    }

    private replace(file: string, contents: string): void {
        const temporary = path.join(this.directory, `.inbox-${randomUUID()}.tmp`);
        let descriptor: number | undefined;
        try {
            descriptor = fs.openSync(temporary, "wx", 0o600);
            fs.writeFileSync(descriptor, contents, "utf8");
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporary, file);
            syncDirectory(this.directory);
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            fs.rmSync(temporary, {force: true});
        }
    }

    private read(file: string): unknown {
        let descriptor: number;
        try {
            descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        } catch (error) {
            if (isMissing(error)) return undefined;
            if (error instanceof Error && "code" in error && (error.code === "ELOOP" || error.code === "EACCES")) {
                throw new ArchiveInboxInvalidError("Archive inbox file is inaccessible or a symlink.");
            }
            throw error;
        }
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > MAX_DESCRIPTOR_BYTES
                || (process.getuid && stat.uid !== process.getuid())) throw new ArchiveInboxInvalidError("Invalid archive inbox file.");
            const buffer = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
            const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
            if (length > MAX_DESCRIPTOR_BYTES) throw new ArchiveInboxInvalidError("Oversized archive inbox file.");
            try {
                return JSON.parse(buffer.subarray(0, length).toString("utf8"));
            } catch {
                throw new ArchiveInboxInvalidError("Invalid archive inbox file.");
            }
        } finally {
            fs.closeSync(descriptor);
        }
    }
}

function decodeManifest(value: unknown): ArchiveManifest {
    if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !ID.test(value.id)
        || typeof value.generation !== "string" || !ID.test(value.generation) || typeof value.origin !== "string"
        || Object.keys(value).length !== 5) throw new Error("Invalid archive descriptor.");
    let url: URL;
    try { url = new URL(value.origin); } catch { throw new Error("Invalid archive descriptor origin."); }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value.origin) {
        throw new Error("Invalid archive descriptor origin.");
    }
    return {version: 1, id: value.id, origin: value.origin, generation: value.generation,
        source: decodeArchiveSourceScope(value.source)};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
