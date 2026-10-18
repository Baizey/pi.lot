import {constants} from "node:fs";
import {lstat, open, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {getAgentDir, type ExtensionAPI, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import {MAX_ARCHIVE_BYTES, SessionKind, type ArchiveMetadata} from "./ArchiveProtocol.js";

// Pi exposes this native readonly view through ExtensionContext, not its barrel exports.
type ReadonlySessionManager = ExtensionContext["sessionManager"];
type CatalogEntry = {
    file: string;
    sessionId: string;
    parentSession?: string;
    parentAgentIdentifier?: string;
    rootSessionId?: string;
    childKind?: SessionKind;
    identity?: ArchiveIdentity;
    identityConflict?: boolean;
};
type ArchiveIdentity = {kind: SessionKind; rootSessionId: string; parentAgentIdentifier?: string};
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
        this.currentRootSessionId = getArchiveRootSessionId(manager);
    }

    async discover(scope: "current" | "all", signal?: AbortSignal): Promise<{files: string[]; warnings: string[]}> {
        checkAbort(signal);
        this.catalog.clear();
        this.byId.clear();
        this.collisions.clear();
        this.currentRootSessionId = getArchiveRootSessionId(this.manager);
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
                const previous = this.byId.get(entry.sessionId);
                if (previous && previous.file !== file) this.collisions.add(entry.sessionId);
                else this.byId.set(entry.sessionId, entry);
            } catch {
                checkAbort(signal);
                skippedFiles++;
            }
        }
        for (const id of this.collisions) this.byId.delete(id);
        let unresolvedChildren = 0;
        const files: string[] = [];
        for (const entry of this.catalog.values()) {
            if (this.collisions.has(entry.sessionId)) continue;
            const family = this.resolveFamily(entry);
            if ((entry.childKind || entry.identityConflict) && !family) unresolvedChildren++;
            if (scope === "all" || (family && family.rootSessionId === this.currentRootSessionId)) files.push(entry.file);
        }
        if (skippedFiles) warnings.push(`Skipped ${skippedFiles} unreadable, unsafe, changing, or invalid session file(s).`);
        if (unreadableDirectories) warnings.push(`Could not scan ${unreadableDirectories} session directory/directories.`);
        if (this.collisions.size) warnings.push(`Skipped ${this.collisions.size} duplicate session ID(s) found in different files.`);
        if (unresolvedChildren) warnings.push(`Could not resolve root ancestry for ${unresolvedChildren} child session(s).`);
        if (scope === "current" && files.length === 0) warnings.push("The current session has no persisted session family to upload yet.");
        checkAbort(signal);
        return {files: files.sort(), warnings};
    }

    async snapshot(file: string, signal?: AbortSignal): Promise<Snapshot> {
        const stable = await this.readStable(file, signal);
        const parsed = this.parse(stable.file, stable.body, signal);
        const indexed = this.catalog.get(stable.file);
        if (indexed && indexed.sessionId !== parsed.entry.sessionId) {
            throw new Error("Session identity changed after archive discovery; discover again before uploading.");
        }
        if (this.collisions.has(parsed.entry.sessionId)
            || (this.byId.has(parsed.entry.sessionId) && this.byId.get(parsed.entry.sessionId)?.file !== stable.file)) {
            throw new Error("Duplicate session ID in different files; archive upload is ambiguous.");
        }
        const warnings: string[] = [];
        const family = this.resolveFamily(parsed.entry);
        if (family) {
            parsed.metadata.kind = family.kind;
            parsed.metadata.root_session_id = family.rootSessionId;
        } else if (parsed.entry.childKind || parsed.entry.identityConflict) {
            warnings.push("Session root ancestry is unresolved or conflicting; kind and root session metadata were omitted.");
        }
        checkAbort(signal);
        return {file: stable.file, sessionId: parsed.entry.sessionId, body: stable.body, metadata: parsed.metadata, warnings};
    }

    private resolveFamily(entry: CatalogEntry): Family | undefined {
        if (this.collisions.has(entry.sessionId) || entry.identityConflict) return undefined;
        const activeRootId = this.currentRootSessionId;
        const currentId = this.manager.getSessionId();
        if (!entry.childKind) {
            // UUID shape and native fork provenance do not establish Pilot identity.
            return entry.identity?.kind === SessionKind.Main || (entry.sessionId === currentId && activeRootId === currentId)
                ? {kind: SessionKind.Main, rootSessionId: entry.sessionId}
                : undefined;
        }
        const seen = new Set<string>();
        let expectedRoot: string | undefined;
        let cursor: CatalogEntry | undefined = entry;
        while (cursor) {
            if (seen.has(cursor.sessionId) || this.collisions.has(cursor.sessionId) || cursor.identityConflict) return undefined;
            seen.add(cursor.sessionId);
            if (!cursor.childKind) {
                const isRoot = cursor.identity?.kind === SessionKind.Main
                    || (cursor.sessionId === currentId && activeRootId === currentId)
                    || cursor.sessionId === expectedRoot;
                return isRoot && (!expectedRoot || expectedRoot === cursor.sessionId)
                    ? {kind: entry.childKind, rootSessionId: cursor.sessionId} : undefined;
            }
            if (cursor.rootSessionId) {
                if (expectedRoot && expectedRoot !== cursor.rootSessionId) return undefined;
                expectedRoot = cursor.rootSessionId;
                const root = this.byId.get(expectedRoot);
                if (seen.has(expectedRoot) || this.collisions.has(expectedRoot) || root?.identityConflict || root?.childKind) return undefined;
            }
            if (cursor.parentAgentIdentifier && this.collisions.has(cursor.parentAgentIdentifier)) return undefined;
            const parentById: CatalogEntry | undefined = cursor.parentAgentIdentifier
                ? this.byId.get(cursor.parentAgentIdentifier) : undefined;
            if (parentById) {
                cursor = parentById;
                continue;
            }
            if (cursor.parentAgentIdentifier === currentId && activeRootId && !this.collisions.has(activeRootId)) {
                return !expectedRoot || expectedRoot === activeRootId
                    ? {kind: entry.childKind, rootSessionId: activeRootId} : undefined;
            }
            // Never open parentSession: only look up paths/IDs already in the owned catalog.
            const parentPath: string | undefined = cursor.parentSession
                ? path.resolve(path.dirname(cursor.file), cursor.parentSession) : undefined;
            const parentByPath: CatalogEntry | undefined = parentPath ? this.catalog.get(parentPath) : undefined;
            const parentByHeaderId: CatalogEntry | undefined = cursor.parentSession ? this.byId.get(cursor.parentSession) : undefined;
            const indexedParent: CatalogEntry | undefined = parentByPath ?? parentByHeaderId;
            if (indexedParent) {
                if (cursor.parentAgentIdentifier && indexedParent.sessionId !== cursor.parentAgentIdentifier) return undefined;
                cursor = indexedParent;
                continue;
            }
            const currentFile = this.manager.getSessionFile();
            const pathLinksToCurrent = parentPath && currentFile && parentPath === path.resolve(currentFile);
            if (pathLinksToCurrent && cursor.parentAgentIdentifier && cursor.parentAgentIdentifier !== currentId) return undefined;
            const linksToCurrent = cursor.parentAgentIdentifier === currentId || pathLinksToCurrent;
            if (linksToCurrent && activeRootId && !this.collisions.has(currentId) && !this.collisions.has(activeRootId)) {
                return !expectedRoot || expectedRoot === activeRootId
                    ? {kind: entry.childKind, rootSessionId: activeRootId} : undefined;
            }
            // A self-bound root remains usable when its parent history is unavailable.
            return expectedRoot ? {kind: entry.childKind, rootSessionId: expectedRoot} : undefined;
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
                if (value.type !== "session" || !validId(value.id)
                    || (value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 1))) {
                    throw new Error("Archive session must start with a native session header.");
                }
                header = value;
                entry = {file, sessionId: value.id};
                if (typeof value.parentSession === "string") entry.parentSession = value.parentSession;
                if (value.id.startsWith("policy-approver-")) entry.childKind = SessionKind.PolicyApprover;
                else if (value.id.startsWith("subagent-")) entry.childKind = SessionKind.Subagent;
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
            if (value.type === "custom" && (value.customType === "pilot.subagent" || value.customType === "pilot.archive") && entry) {
                applyIdentityRecord(entry, value.customType, value.data);
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

/** Called only for the active Pilot session, before any children are created. */
export function recordArchiveMainIdentity(pi: Pick<ExtensionAPI, "appendEntry">, manager: ReadonlySessionManager): void {
    const entry = managerIdentity(manager);
    if (!validId(entry.sessionId) || entry.childKind || entry.identity || entry.identityConflict) return;
    pi.appendEntry("pilot.archive", {
        version: 1, sessionId: entry.sessionId, kind: SessionKind.Main, rootSessionId: entry.sessionId,
    });
}

/** Active context supplies positive main identity; resumed children must retain their original root. */
export function getArchiveRootSessionId(manager: ReadonlySessionManager): string | undefined {
    const entry = managerIdentity(manager);
    if (!validId(entry.sessionId) || entry.identityConflict) return undefined;
    if (entry.identity) return entry.identity.rootSessionId;
    return entry.childKind ? undefined : entry.sessionId;
}

function managerIdentity(manager: ReadonlySessionManager): CatalogEntry {
    const sessionId = manager.getSessionId();
    const entry: CatalogEntry = {file: manager.getSessionFile() ?? "", sessionId};
    if (sessionId.startsWith("policy-approver-")) entry.childKind = SessionKind.PolicyApprover;
    else if (sessionId.startsWith("subagent-")) entry.childKind = SessionKind.Subagent;
    for (const value of manager.getEntries()) {
        if (value.type === "custom" && (value.customType === "pilot.subagent" || value.customType === "pilot.archive")) {
            applyIdentityRecord(entry, value.customType, value.data);
        }
    }
    return entry;
}

function applyIdentityRecord(entry: CatalogEntry, customType: string, data: unknown): void {
    if (!isRecord(data)) return;
    if (data.sessionId === undefined) {
        // Old records are useful only for known legacy child IDs. Forks copy custom
        // entries, so an unbound record can never establish identity on ordinary IDs.
        if (customType === "pilot.subagent" && entry.childKind && !entry.identity && validId(data.parentAgentIdentifier)) {
            if (entry.parentAgentIdentifier && entry.parentAgentIdentifier !== data.parentAgentIdentifier) entry.identityConflict = true;
            entry.parentAgentIdentifier = data.parentAgentIdentifier;
        }
        return;
    }
    if (data.sessionId !== entry.sessionId) return;
    const main = customType === "pilot.archive" && data.kind === SessionKind.Main && data.rootSessionId === entry.sessionId;
    const child = customType === "pilot.subagent" && (data.kind === SessionKind.Subagent || data.kind === SessionKind.PolicyApprover)
        && validId(data.parentAgentIdentifier) && data.parentAgentIdentifier !== entry.sessionId && data.rootSessionId !== entry.sessionId;
    if (data.version !== 1 || !validId(data.rootSessionId) || (!main && !child)) {
        entry.identityConflict = true;
        return;
    }
    const identity: ArchiveIdentity = {kind: main ? SessionKind.Main : data.kind as SessionKind, rootSessionId: data.rootSessionId};
    if (child) identity.parentAgentIdentifier = data.parentAgentIdentifier as string;
    if (entry.identity && (entry.identity.kind !== identity.kind || entry.identity.rootSessionId !== identity.rootSessionId
        || entry.identity.parentAgentIdentifier !== identity.parentAgentIdentifier)) entry.identityConflict = true;
    entry.identity = identity;
    entry.rootSessionId = identity.rootSessionId;
    entry.parentAgentIdentifier = identity.parentAgentIdentifier;
    entry.childKind = main ? undefined : identity.kind;
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

function validId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.from(value).toString("utf8") === value;
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
