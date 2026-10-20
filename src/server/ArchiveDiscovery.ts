import {createHash} from "node:crypto";
import type {Dir} from "node:fs";
import fs, {opendir} from "node:fs/promises";
import path from "node:path";
import type {ArchiveSourceScope} from "./ArchiveSourceScope.js";
import {ArchiveSourceError, checkArchiveSourceAbort, type ArchiveSourceFailure} from "./ArchiveSourceError.js";

export type ArchiveDiscoveryIssue = {
    path: string;
    kind: "directory";
    code: ArchiveSourceFailure;
    retryCursor: string;
};

export type ArchiveDiscoveryPage = {
    files: string[];
    cursor: string | null;
    complete: boolean;
    issues: ArchiveDiscoveryIssue[];
};

type Frame = {
    directory: string;
    kind: "collection" | "files";
    position: number;
    stamp: string | null;
    prefix: string;
};
type Cursor = {
    version: 1;
    scopeKey: string;
    seed: number;
    activeEmitted: boolean;
    retry: boolean;
    frames: Frame[];
};
type Reader = {handle: Dir; stamp: string; position: number; prefix: string};
const EMPTY_PREFIX = "";
const ENTRY_BUDGET = 256;
const PAGE_CAPACITY = 256;

/**
 * Owns at most two directory readers and no transcript bodies. A cursor records a
 * verified directory prefix, not an OS handle. Each call replays that prefix
 * with bounded memory, then processes at most ENTRY_BUDGET new entries. Node has
 * no seekable directory API: replay is O(position), not a fixed I/O time bound.
 * Readers always close before return, including cancellation and partial scans.
 */
export class ArchiveDiscovery {
    private readonly readers = new Map<string, Reader>();
    private readonly seeds: {directory: string; kind: Frame["kind"]}[];
    private readonly scopeKey: string;

    constructor(private readonly source: ArchiveSourceScope) {
        this.seeds = [
            ...(source.sessionFile ? [{directory: source.sessionDirectory, kind: "files" as const}] : []),
            ...(source.scope === "all" ? source.defaultSessionRoots.map((directory) => ({directory, kind: "collection" as const})) : []),
        ];
        this.scopeKey = createHash("sha256").update(JSON.stringify({
            scope: source.scope, file: source.sessionFile, seeds: this.seeds,
        })).digest("hex");
    }

    async discoverPage(cursor: string | null, capacity: number, signal?: AbortSignal): Promise<ArchiveDiscoveryPage> {
        checkArchiveSourceAbort(signal);
        if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 10_000) {
            throw new ArchiveSourceError("invalid", "Archive discovery capacity must be between zero and 10000.");
        }
        const state = this.decodeCursor(cursor);
        const files: string[] = [];
        const issues: ArchiveDiscoveryIssue[] = [];
        if (capacity === 0) return {files, issues, cursor, complete: false};
        const limit = Math.min(capacity, PAGE_CAPACITY);
        let budget = ENTRY_BUDGET;
        try {
            for (const directory of [...this.readers.keys()]) {
                if (!state.frames.some((frame) => frame.directory === directory)) await this.closeReader(directory);
            }
            if (!state.activeEmitted) {
                state.activeEmitted = true;
                if (this.source.sessionFile) files.push(this.source.sessionFile);
            }
            while (budget > 0 && files.length + issues.length < limit) {
                checkArchiveSourceAbort(signal);
                if (state.frames.length === 0) {
                    if (state.retry || state.seed === this.seeds.length) break;
                    const seed = this.seeds[state.seed++]!;
                    state.frames.push(this.frame(seed.directory, seed.kind));
                }
                const frame = state.frames[state.frames.length - 1]!;
                budget--;
                try {
                    const stamp = await this.directoryStamp(frame.directory);
                    if (frame.stamp !== stamp) {
                        await this.closeReader(frame.directory);
                        frame.position = 0;
                        frame.prefix = EMPTY_PREFIX;
                        frame.stamp = stamp;
                    }
                    let reader = this.readers.get(frame.directory);
                    if (reader && (reader.stamp !== stamp || reader.position > frame.position)) {
                        await this.closeReader(frame.directory);
                        reader = undefined;
                    }
                    if (!reader) {
                        const handle = await opendir(frame.directory, {bufferSize: 32});
                        reader = {handle, stamp, position: 0, prefix: EMPTY_PREFIX};
                        this.readers.set(frame.directory, reader);
                    }
                    // Replay cannot be budgeted across calls without retaining a native
                    // handle: a fresh process must reach the saved prefix to progress.
                    while (reader.position < frame.position) {
                        checkArchiveSourceAbort(signal);
                        const entry = await reader.handle.read();
                        if (!entry) throw new ArchiveSourceError("changing", "Archive directory changed during discovery.");
                        this.advance(reader, entry.name);
                    }
                    if (reader.prefix !== frame.prefix) {
                        throw new ArchiveSourceError("changing", "Archive directory order changed during discovery.");
                    }
                    if (budget === 0) break;
                    budget--;
                    const entry = await reader.handle.read();
                    if (!entry) {
                        if (await this.directoryStamp(frame.directory) !== stamp) {
                            throw new ArchiveSourceError("changing", "Archive directory changed during discovery.");
                        }
                        await this.closeReader(frame.directory);
                        state.frames.pop();
                        continue;
                    }
                    this.advance(reader, entry.name);
                    frame.position = reader.position;
                    frame.prefix = reader.prefix;
                    const candidate = path.join(frame.directory, entry.name);
                    if (frame.kind === "collection") {
                        if (entry.isDirectory()) state.frames.push(this.frame(candidate, "files"));
                    } else if (entry.name.endsWith(".jsonl")) {
                        // Unsafe file types still become obligations, so capture records
                        // an explicit invalid result rather than a successful omission.
                        files.push(candidate);
                    }
                } catch (error) {
                    checkArchiveSourceAbort(signal);
                    const failure = ArchiveSourceError.fromFilesystem(error);
                    await this.closeReader(frame.directory);
                    if (state.retry && state.frames.length === 1) throw failure;
                    const retry = this.frame(frame.directory, frame.kind);
                    issues.push({path: frame.directory, kind: "directory", code: failure.code,
                        retryCursor: JSON.stringify({...state, activeEmitted: true, retry: true, frames: [retry]})});
                    state.frames.pop();
                }
            }
            const complete = state.activeEmitted && state.frames.length === 0 && (state.retry || state.seed === this.seeds.length);
            return {files, issues, cursor: complete ? null : JSON.stringify(state), complete};
        } finally {
            await this.close();
        }
    }

    async close(): Promise<void> {
        for (const directory of [...this.readers.keys()]) await this.closeReader(directory);
    }

    ownsFile(file: string): boolean {
        if (!isAbsolutePath(file)) return false;
        if (file === this.source.sessionFile) return true;
        if (!file.endsWith(".jsonl")) return false;
        return this.ownsDirectory(path.dirname(file), "files");
    }

    private ownsDirectory(directory: string, kind: Frame["kind"]): boolean {
        if (kind === "collection") return this.source.scope === "all" && this.source.defaultSessionRoots.includes(directory);
        if (this.source.sessionFile && directory === this.source.sessionDirectory) return true;
        return this.source.scope === "all" && this.source.defaultSessionRoots.includes(path.dirname(directory));
    }

    private decodeCursor(encoded: string | null): Cursor {
        if (encoded === null) return {version: 1, scopeKey: this.scopeKey, seed: 0, activeEmitted: false, retry: false, frames: []};
        let value: unknown;
        try {
            if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 32 * 1024) throw new Error();
            value = JSON.parse(encoded);
        } catch {
            throw new ArchiveSourceError("invalid", "Invalid archive discovery cursor.");
        }
        if (!isRecord(value) || value.version !== 1 || value.scopeKey !== this.scopeKey
            || !isPosition(value.seed) || value.seed > this.seeds.length
            || typeof value.activeEmitted !== "boolean" || typeof value.retry !== "boolean"
            || !Array.isArray(value.frames) || value.frames.length > 2) {
            throw new ArchiveSourceError("invalid", "Invalid archive discovery cursor.");
        }
        const frames: Frame[] = [];
        for (const item of value.frames) {
            if (!isRecord(item) || !isAbsolutePath(item.directory)
                || (item.kind !== "collection" && item.kind !== "files")
                || !this.ownsDirectory(item.directory, item.kind) || !isPosition(item.position)
                || (item.stamp !== null && (typeof item.stamp !== "string" || !/^\d+:\d+:\d+:\d+$/u.test(item.stamp)))
                || typeof item.prefix !== "string" || (item.prefix !== "" && !/^[a-f0-9]{64}$/u.test(item.prefix))) {
                throw new ArchiveSourceError("invalid", "Invalid archive discovery cursor.");
            }
            frames.push({directory: item.directory, kind: item.kind, position: item.position, stamp: item.stamp, prefix: item.prefix});
        }
        if (frames.length === 2 && (frames[0]!.kind !== "collection" || frames[1]!.kind !== "files"
            || path.dirname(frames[1]!.directory) !== frames[0]!.directory)) {
            throw new ArchiveSourceError("invalid", "Invalid archive discovery cursor.");
        }
        return {version: 1, scopeKey: this.scopeKey, seed: value.seed, activeEmitted: value.activeEmitted, retry: value.retry, frames};
    }

    private frame(directory: string, kind: Frame["kind"]): Frame {
        return {directory, kind, position: 0, stamp: null, prefix: EMPTY_PREFIX};
    }

    private async directoryStamp(directory: string): Promise<string> {
        // Descriptor seeds are trusted local aliases, unlike directories found
        // during enumeration. Stamp the target without changing path identity.
        const seed = this.seeds.some((candidate) => candidate.directory === directory);
        const observed = seed ? await fs.stat(directory, {bigint: true}) : await fs.lstat(directory, {bigint: true});
        if (!observed.isDirectory()) throw new ArchiveSourceError("invalid", "Archive discovery requires a directory; enumerated children must not be symlinks.");
        return `${observed.dev}:${observed.ino}:${observed.mtimeNs}:${observed.ctimeNs}`;
    }

    private advance(reader: Reader, name: string): void {
        reader.position++;
        reader.prefix = createHash("sha256").update(reader.prefix).update("\0").update(name).digest("hex");
    }

    private async closeReader(directory: string): Promise<void> {
        const reader = this.readers.get(directory);
        if (!reader) return;
        this.readers.delete(directory);
        await reader.handle.close();
    }
}

function isPosition(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAbsolutePath(value: unknown): value is string {
    return typeof value === "string" && !value.includes("\0") && Buffer.from(value).toString("utf8") === value
        && path.isAbsolute(value) && path.resolve(value) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
