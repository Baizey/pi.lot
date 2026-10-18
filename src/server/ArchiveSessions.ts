import {constants} from "node:fs";
import {lstat, open, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {getAgentDir, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import {MAX_ARCHIVE_BYTES, type ArchiveMetadata} from "./ArchiveProtocol.js";
import {getSessionRootId, isNativeSessionId, SessionIdentity, SessionKind} from "../sessions/SessionIdentity.js";

// Pi exposes this native readonly view through ExtensionContext, not its barrel exports.
type ReadonlySessionManager = ExtensionContext["sessionManager"];
type CatalogEntry = {
    file: string;
    parentSession?: string;
    session: SessionIdentity;
};
type ParsedSession = {entry: CatalogEntry; metadata: ArchiveMetadata};
type Snapshot = {file: string; sessionId: string; body: Buffer; metadata: ArchiveMetadata; warnings: string[]};
type Family = {kind: SessionKind; rootSessionId: string};

/** Owns one upload's catalog, retaining ancestry only, never other sessions' bodies. */
export class ArchiveSessions {
    private readonly catalog = new Map<string, CatalogEntry>();
    private readonly byId = new Map<string, CatalogEntry>();
    private readonly collisions = new Set<string>();
    private currentRootSessionId: string | undefined;

    constructor(private readonly manager: ReadonlySessionManager) {
        this.currentRootSessionId = getSessionRootId(manager);
    }

    async discover(scope: "current" | "all", signal?: AbortSignal): Promise<{files: string[]; warnings: string[]; rootSessionId?: string}> {
        checkAbort(signal);
        this.catalog.clear();
        this.byId.clear();
        this.collisions.clear();
        this.currentRootSessionId = getSessionRootId(this.manager);
        const warnings: string[] = [];
        const currentFile = this.manager.getSessionFile();
        if (scope === "current" && !currentFile) {
            return {files: [], warnings: ["The current session has no persisted history (--no-session)."]};
        }
        const candidates = new Set<string>();
        let unreadableDirectories = 0;
        const addDirectory = async (directory: string) => {
            checkAbort(signal);
            try {
                for (const entry of await readdir(directory, {withFileTypes: true})) {
                    if (entry.name.endsWith(".jsonl")) candidates.add(path.resolve(directory, entry.name));
                }
            } catch (error) {
                checkAbort(signal);
                if (!hasCode(error, "ENOENT")) unreadableDirectories++;
            }
        };
        if (scope === "all") {
            // Mirror SessionManager.listAll's directory layout without its unbounded
            // transcript-text accumulation or following file symlinks/FIFOs.
            const globalDirectory = path.join(getAgentDir(), "sessions");
            try {
                for (const entry of await readdir(globalDirectory, {withFileTypes: true})) {
                    checkAbort(signal);
                    if (entry.isDirectory()) await addDirectory(path.join(globalDirectory, entry.name));
                }
            } catch (error) {
                checkAbort(signal);
                if (!hasCode(error, "ENOENT")) unreadableDirectories++;
            }
        }
        if (currentFile) {
            await addDirectory(path.resolve(this.manager.getSessionDir()));
            candidates.add(path.resolve(currentFile));
        }
        let skippedFiles = 0;
        for (const candidate of [...candidates].sort()) {
            checkAbort(signal);
            try {
                const {file, body} = await this.readStable(candidate, signal);
                if (this.catalog.has(file)) continue;
                const {entry} = this.parse(file, body, signal);
                this.catalog.set(file, entry);
                const previous = this.byId.get(entry.session.sessionId);
                if (previous && previous.file !== file) this.collisions.add(entry.session.sessionId);
                else this.byId.set(entry.session.sessionId, entry);
            } catch {
                checkAbort(signal);
                skippedFiles++;
            }
        }
        for (const id of this.collisions) this.byId.delete(id);
        // A resumed legacy/partial child may need the catalog's parent chain to
        // recover its originating main session. Unknown is not an empty family.
        if (this.currentRootSessionId === undefined) {
            const parentSession = this.manager.getHeader()?.parentSession;
            this.currentRootSessionId = this.resolveFamily({
                file: this.manager.getSessionFile() ?? "",
                parentSession: typeof parentSession === "string" ? parentSession : undefined,
                session: SessionIdentity.fromManager(this.manager),
            })?.rootSessionId;
        }
        let unresolvedChildren = 0;
        const files: string[] = [];
        for (const entry of this.catalog.values()) {
            if (this.collisions.has(entry.session.sessionId)) continue;
            const family = this.resolveFamily(entry);
            if ((entry.session.childKind || entry.session.identityConflict) && !family) unresolvedChildren++;
            if (scope === "all" || (family && family.rootSessionId === this.currentRootSessionId)) files.push(entry.file);
        }
        if (skippedFiles) warnings.push(`Skipped ${skippedFiles} unreadable, unsafe, changing, or invalid session file(s).`);
        if (unreadableDirectories) warnings.push(`Could not scan ${unreadableDirectories} session directory/directories.`);
        if (this.collisions.size) warnings.push(`Skipped ${this.collisions.size} duplicate session ID(s) found in different files.`);
        if (unresolvedChildren) warnings.push(`Could not resolve root ancestry for ${unresolvedChildren} child session(s).`);
        if (scope === "current" && files.length === 0) warnings.push("The current session has no persisted session family to upload yet.");
        checkAbort(signal);
        return {files: files.sort(), warnings,
            ...(this.currentRootSessionId !== undefined ? {rootSessionId: this.currentRootSessionId} : {})};
    }

    async snapshot(file: string, signal?: AbortSignal): Promise<Snapshot> {
        const stable = await this.readStable(file, signal);
        const parsed = this.parse(stable.file, stable.body, signal);
        const indexed = this.catalog.get(stable.file);
        if (indexed && indexed.session.sessionId !== parsed.entry.session.sessionId) {
            throw new Error("Session identity changed after archive discovery; discover again before uploading.");
        }
        if (this.collisions.has(parsed.entry.session.sessionId)
            || (this.byId.has(parsed.entry.session.sessionId) && this.byId.get(parsed.entry.session.sessionId)?.file !== stable.file)) {
            throw new Error("Duplicate session ID in different files; archive upload is ambiguous.");
        }
        const warnings: string[] = [];
        const family = this.resolveFamily(parsed.entry);
        if (family) {
            parsed.metadata.kind = family.kind;
            parsed.metadata.root_session_id = family.rootSessionId;
        } else if (parsed.entry.session.childKind || parsed.entry.session.identityConflict) {
            warnings.push("Session root ancestry is unresolved or conflicting; kind and root session metadata were omitted.");
        }
        checkAbort(signal);
        return {file: stable.file, sessionId: parsed.entry.session.sessionId, body: stable.body, metadata: parsed.metadata, warnings};
    }

    private resolveFamily(entry: CatalogEntry): Family | undefined {
        const session = entry.session;
        if (this.collisions.has(session.sessionId) || session.identityConflict) return undefined;
        const activeRootId = this.currentRootSessionId;
        const currentId = this.manager.getSessionId();
        if (!session.childKind) {
            // UUID shape and native fork provenance do not establish Pilot identity.
            return session.identity?.kind === SessionKind.Main || (session.sessionId === currentId && activeRootId === currentId)
                ? {kind: SessionKind.Main, rootSessionId: session.sessionId}
                : undefined;
        }
        const seen = new Set<string>();
        let expectedRoot: string | undefined;
        let cursor: CatalogEntry | undefined = entry;
        while (cursor) {
            const ancestor: SessionIdentity = cursor.session;
            if (seen.has(ancestor.sessionId) || this.collisions.has(ancestor.sessionId) || ancestor.identityConflict) return undefined;
            seen.add(ancestor.sessionId);
            if (!ancestor.childKind) {
                const isRoot = ancestor.identity?.kind === SessionKind.Main
                    || (ancestor.sessionId === currentId && activeRootId === currentId)
                    || ancestor.sessionId === expectedRoot;
                return isRoot && (!expectedRoot || expectedRoot === ancestor.sessionId)
                    ? {kind: session.childKind, rootSessionId: ancestor.sessionId} : undefined;
            }
            if (ancestor.rootSessionId) {
                if (expectedRoot && expectedRoot !== ancestor.rootSessionId) return undefined;
                expectedRoot = ancestor.rootSessionId;
                const root = this.byId.get(expectedRoot)?.session;
                if (seen.has(expectedRoot) || this.collisions.has(expectedRoot) || root?.identityConflict || root?.childKind) return undefined;
            }
            if (ancestor.parentAgentIdentifier && this.collisions.has(ancestor.parentAgentIdentifier)) return undefined;
            const parentById: CatalogEntry | undefined = ancestor.parentAgentIdentifier
                ? this.byId.get(ancestor.parentAgentIdentifier) : undefined;
            if (parentById) {
                cursor = parentById;
                continue;
            }
            if (ancestor.parentAgentIdentifier === currentId && activeRootId && !this.collisions.has(activeRootId)) {
                return !expectedRoot || expectedRoot === activeRootId
                    ? {kind: session.childKind, rootSessionId: activeRootId} : undefined;
            }
            // Never open parentSession: only look up paths/IDs already in the owned catalog.
            const parentPath: string | undefined = cursor.parentSession
                ? path.resolve(path.dirname(cursor.file), cursor.parentSession) : undefined;
            const parentByPath: CatalogEntry | undefined = parentPath ? this.catalog.get(parentPath) : undefined;
            const parentByHeaderId: CatalogEntry | undefined = cursor.parentSession ? this.byId.get(cursor.parentSession) : undefined;
            const indexedParent: CatalogEntry | undefined = parentByPath ?? parentByHeaderId;
            if (indexedParent) {
                if (ancestor.parentAgentIdentifier && indexedParent.session.sessionId !== ancestor.parentAgentIdentifier) return undefined;
                cursor = indexedParent;
                continue;
            }
            const currentFile = this.manager.getSessionFile();
            const pathLinksToCurrent = parentPath && currentFile && parentPath === path.resolve(currentFile);
            if (pathLinksToCurrent && ancestor.parentAgentIdentifier && ancestor.parentAgentIdentifier !== currentId) return undefined;
            const linksToCurrent = ancestor.parentAgentIdentifier === currentId || pathLinksToCurrent;
            if (linksToCurrent && activeRootId && !this.collisions.has(currentId) && !this.collisions.has(activeRootId)) {
                return !expectedRoot || expectedRoot === activeRootId
                    ? {kind: session.childKind, rootSessionId: activeRootId} : undefined;
            }
            // A self-bound root remains usable when its parent history is unavailable.
            return expectedRoot ? {kind: session.childKind, rootSessionId: expectedRoot} : undefined;
        }
        return undefined;
    }

    private async readStable(file: string, signal?: AbortSignal): Promise<{file: string; body: Buffer}> {
        for (let attempt = 0; attempt < 3; attempt++) {
            checkAbort(signal);
            let changed = false;
            try {
                const original = await lstat(file, {bigint: true});
                if (!original.isFile()) throw new Error("Archive source must be a regular, non-symlink file.");
                const canonical = await realpath(file);
                const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                    const before = await handle.stat({bigint: true});
                    if (!before.isFile()) throw new Error("Archive source must be a regular file.");
                    if (before.size > BigInt(MAX_ARCHIVE_BYTES)) throw new Error("Archive session exceeds the 64 MiB limit.");
                    changed = original.dev !== before.dev || original.ino !== before.ino;
                    const body = Buffer.allocUnsafe(Number(before.size));
                    let offset = 0;
                    while (!changed && offset < body.length) {
                        checkAbort(signal);
                        const {bytesRead} = await handle.read(body, offset, Math.min(64 * 1024, body.length - offset), offset);
                        if (!bytesRead) break;
                        offset += bytesRead;
                    }
                    checkAbort(signal);
                    const probe = Buffer.allocUnsafe(1);
                    const extra = changed ? {bytesRead: 0} : await handle.read(probe, 0, 1, offset);
                    const after = await handle.stat({bigint: true});
                    const named = await lstat(canonical, {bigint: true});
                    changed ||= offset !== body.length || extra.bytesRead !== 0 || !named.isFile()
                        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
                        || after.dev !== named.dev || after.ino !== named.ino || after.size !== named.size
                        || after.mtimeNs !== named.mtimeNs || after.ctimeNs !== named.ctimeNs;
                    if (!changed) return {file: canonical, body};
                } finally {
                    await handle.close();
                }
            } catch (error) {
                checkAbort(signal);
                // Never expose OS paths or parser snippets in upload diagnostics.
                if (error instanceof Error && error.message.startsWith("Archive ")) throw error;
                throw new Error("Archive session could not be safely read.");
            }
        }
        throw new Error("Archive session changed during all three snapshot attempts; try again when it is idle.");
    }

    private parse(file: string, body: Buffer, signal?: AbortSignal): ParsedSession {
        let text: string;
        try {
            text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(body);
        } catch {
            throw new Error("Archive session is not valid UTF-8.");
        }
        const lines = text.split("\n");
        let header: Record<string, unknown> | undefined;
        let entry: CatalogEntry | undefined;
        const metadata: ArchiveMetadata = {counts: {user_messages: 0, assistant_messages: 0, tool_calls: 0}};
        let lastActivity: number | undefined;
        let firstUserText: string | undefined;
        let name: string | undefined;
        for (let index = 0; index < lines.length; index++) {
            if (index % 256 === 0) checkAbort(signal);
            const line = lines[index]!;
            if (index === lines.length - 1 && !line.trim()) continue;
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                throw new Error("Archive session contains invalid JSONL.");
            }
            if (!isRecord(value) || typeof value.type !== "string") throw new Error("Archive session contains invalid native entries.");
            if (!header) {
                if (value.type !== "session" || !isNativeSessionId(value.id)
                    || (value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 1))) {
                    throw new Error("Archive session must start with a native session header.");
                }
                header = value;
                entry = {file, session: new SessionIdentity(value.id)};
                if (typeof value.parentSession === "string") entry.parentSession = value.parentSession;
                const started = persistedTime(value.timestamp);
                if (started !== undefined) {
                    metadata.started_at = new Date(started).toISOString();
                    lastActivity = started;
                }
                continue;
            }
            if (value.type === "session") throw new Error("Archive session contains more than one native header.");
            const time = persistedTime(value.timestamp);
            if (time !== undefined) lastActivity = Math.max(lastActivity ?? time, time);
            if (value.type === "session_info") name = typeof value.name === "string" ? shortTitle(value.name) : undefined;
            if (value.type === "custom" && typeof value.customType === "string" && entry) {
                entry.session.applyRecord(value.customType, value.data);
            }
            if (value.type !== "message" || !isRecord(value.message)) continue;
            const message = value.message;
            if (message.role === "user") {
                metadata.counts!.user_messages++;
                if (firstUserText === undefined) firstUserText = shortTitle(userText(message.content));
            } else if (message.role === "assistant") {
                metadata.counts!.assistant_messages++;
                if (Array.isArray(message.content)) {
                    for (const block of message.content) {
                        if (isRecord(block) && block.type === "toolCall") metadata.counts!.tool_calls++;
                    }
                }
            }
        }
        if (!entry) throw new Error("Archive session has no native header.");
        if (lastActivity !== undefined) metadata.last_activity_at = new Date(lastActivity).toISOString();
        const title = name ?? firstUserText;
        if (title) metadata.title = title;
        return {entry, metadata};
    }
}

function checkAbort(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error("Archive operation was aborted.");
    error.name = "AbortError";
    throw error;
}

function hasCode(error: unknown, code: string): boolean {
    return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedTime(value: unknown): number | undefined {
    if (typeof value !== "string") return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u.exec(value);
    if (!match) return undefined;
    const [, year, month, day, hour, minute, second, zone] = match;
    const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1]!
        || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
        || (zone !== "Z" && zone !== "z" && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))) return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 253402300799999 ? milliseconds : undefined;
}

function userText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter(isRecord).filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text).join(" ");
}

function shortTitle(value: string): string | undefined {
    const clean = Buffer.from(value).toString("utf8").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
    let result = "";
    let bytes = 0;
    for (const point of clean) {
        const size = Buffer.byteLength(point);
        if (bytes + size > 256) break;
        result += point;
        bytes += size;
    }
    return result || undefined;
}
