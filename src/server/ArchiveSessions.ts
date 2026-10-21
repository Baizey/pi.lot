import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import path from "node:path";
import {MAX_ARCHIVE_BYTES, type ArchiveMetadata} from "./ArchiveProtocol.js";
import {
    captureArchiveSourceIdentity, decodeArchiveSourceIdentity, decodeArchiveSourceScope,
    type ArchiveSourceIdentity, type ArchiveSourceScope,
} from "./ArchiveSourceScope.js";
import {isNativeSessionId, SessionIdentity, SessionKind} from "../sessions/SessionIdentity.js";
import {ArchiveDiscovery, type ArchiveDiscoveryPage} from "./ArchiveDiscovery.js";
import {ArchiveSourceError, checkArchiveSourceAbort as checkAbort} from "./ArchiveSourceError.js";
import {isIncompleteArchiveJsonPrefix} from "./ArchiveSourceJson.js";

export {ArchiveSourceError} from "./ArchiveSourceError.js";

export type ArchiveSourceEvidence = {
    file: string;
    parentSession?: string;
    session: ArchiveSourceIdentity;
};
type ParsedSession = {entry: ArchiveSourceEvidence; metadata: ArchiveMetadata};
export type ArchiveSourceCapture = Snapshot & {
    evidence: ArchiveSourceEvidence;
    membership: "included" | "excluded" | "unresolved";
    ancestryDependencies: {files: string[]; sessionIds: string[]};
};
type AncestryDependencies = {files: Set<string>; sessionIds: Set<string>};
type Snapshot = {file: string; sessionId: string; body: Buffer; metadata: ArchiveMetadata; warnings: string[]};
type Family = {kind: SessionKind; rootSessionId: string};

/** Discovers source paths and captures one body using caller-owned ancestry evidence. */
export class ArchiveSessions {
    private readonly source: ArchiveSourceScope;
    private readonly discovery: ArchiveDiscovery;

    constructor(source: ArchiveSourceScope) {
        this.source = decodeArchiveSourceScope(source);
        this.discovery = new ArchiveDiscovery(this.source);
    }

    /** Path-only discovery; commit the returned observations and cursor together. */
    async discoverPage(cursor: string | null, capacity: number, signal?: AbortSignal): Promise<ArchiveDiscoveryPage> {
        return this.discovery.discoverPage(cursor, capacity, signal);
    }

    /** One body only. Catalog evidence is reconstructable from durable source rows. */
    async captureSource(file: string, catalog: readonly ArchiveSourceEvidence[], signal?: AbortSignal): Promise<ArchiveSourceCapture> {
        checkAbort(signal);
        if (!this.discovery.ownsFile(file)) throw new ArchiveSourceError("invalid", "Archive source is outside the recorded scope.");
        const stable = await this.readStable(file, signal);
        // Keep the observed path as the candidate key even when trusted ancestor
        // directories resolve through an alias. Native ID is not a source key.
        const parsed = this.parse(file, stable.body, signal);
        const entries = catalog.map(decodeArchiveSourceEvidence)
            .filter((entry) => this.discovery.ownsFile(entry.file) && entry.file !== file);
        entries.push(parsed.entry);
        const dependencies: AncestryDependencies = {files: new Set(), sessionIds: new Set()};
        const active = entries.find((entry) => entry.file === this.source.sessionFile
            && entry.session.sessionId === this.source.activeSession.sessionId);
        const root = this.source.rootSessionId ?? this.resolveSourceFamily(active ?? {
            file: this.source.sessionFile ?? "", session: this.source.activeSession,
            ...(this.source.parentSession !== undefined ? {parentSession: this.source.parentSession} : {}),
        }, entries, dependencies)?.rootSessionId;
        const family = this.resolveSourceFamily(parsed.entry, entries, dependencies, root);
        const warnings: string[] = [];
        if (family) {
            parsed.metadata.kind = family.kind;
            parsed.metadata.root_session_id = family.rootSessionId;
        } else if (parsed.entry.session.childKind || parsed.entry.session.identityConflict) {
            warnings.push("Session root ancestry is unresolved or conflicting; kind and root session metadata were omitted.");
        }
        let membership: ArchiveSourceCapture["membership"] = "included";
        if (this.source.scope === "current") {
            const identity = parsed.entry.session;
            const unrelatedPlainSession = identity.sessionId !== this.source.activeSession.sessionId
                && identity.sessionId !== root && !identity.main && !identity.childKind && !identity.identityConflict
                && !identity.rootSessionId && !identity.parentAgentIdentifier && !parsed.entry.parentSession;
            // No family evidence is not pending ancestry for an unrelated plain
            // native session. Exclude it without inventing Pilot main metadata.
            membership = unrelatedPlainSession ? "excluded"
                : !root || !family ? "unresolved" : root === family.rootSessionId ? "included" : "excluded";
        }
        checkAbort(signal);
        return {file, sessionId: parsed.entry.session.sessionId, body: stable.body, metadata: parsed.metadata,
            evidence: parsed.entry, membership, warnings,
            ancestryDependencies: {files: [...dependencies.files].sort(), sessionIds: [...dependencies.sessionIds].sort()}};
    }

    private resolveSourceFamily(
        entry: ArchiveSourceEvidence,
        catalog: readonly ArchiveSourceEvidence[],
        dependencies: AncestryDependencies,
        activeRoot = this.source.rootSessionId,
    ): Family | undefined {
        const byPath = new Map(catalog.map((candidate) => [candidate.file, candidate]));
        const byId = new Map<string, ArchiveSourceEvidence[]>();
        for (const candidate of byPath.values()) {
            const candidates = byId.get(candidate.session.sessionId) ?? [];
            candidates.push(candidate);
            byId.set(candidate.session.sessionId, candidates);
        }
        const seen = new Set<string>();
        let cursor: ArchiveSourceEvidence | undefined = entry;
        while (cursor) {
            if (cursor.file) dependencies.files.add(cursor.file);
            const identity: ArchiveSourceIdentity = cursor.session;
            if (seen.has(cursor.file) || identity.identityConflict) return undefined;
            seen.add(cursor.file);
            const kind = entry.session.childKind ?? SessionKind.Main;
            // A sibling body with the same ID cannot erase or supply this body's
            // explicit classification. Conflicting assertions remain candidates.
            if (identity.main) return {kind, rootSessionId: identity.sessionId};
            if (identity.childKind && identity.rootSessionId) return {kind, rootSessionId: identity.rootSessionId};
            if (!identity.childKind) {
                return cursor.file === this.source.sessionFile && identity.sessionId === this.source.activeSession.sessionId
                    && activeRoot === identity.sessionId
                    ? {kind, rootSessionId: identity.sessionId} : undefined;
            }
            const parentId = identity.parentAgentIdentifier;
            const parentPath: string | undefined = cursor.parentSession
                ? path.resolve(path.dirname(cursor.file), cursor.parentSession) : undefined;
            if (parentPath && this.discovery.ownsFile(parentPath)) {
                dependencies.files.add(parentPath);
                const pathParent = byPath.get(parentPath);
                // Only the recorded active path has independent cached root evidence
                // when absent. An observed parent always takes precedence over it.
                if (!pathParent && parentPath === this.source.sessionFile
                    && (!parentId || parentId === this.source.activeSession.sessionId) && activeRoot) {
                    return {kind, rootSessionId: activeRoot};
                }
                // Other owned paths must await their own observation, never a sole
                // same-ID substitute or an arbitrary header-supplied file open.
                if (!pathParent || (parentId && pathParent.session.sessionId !== parentId)) return undefined;
                cursor = pathParent;
                continue;
            }
            if (parentId) dependencies.sessionIds.add(parentId);
            const candidates: ArchiveSourceEvidence[] = parentId ? byId.get(parentId) ?? [] : [];
            if (candidates.length === 1) {
                cursor = candidates[0];
            } else if (candidates.length > 1) {
                return undefined;
            } else {
                if (isNativeSessionId(cursor.parentSession)) dependencies.sessionIds.add(cursor.parentSession);
                const headerCandidates: ArchiveSourceEvidence[] = cursor.parentSession ? byId.get(cursor.parentSession) ?? [] : [];
                if (headerCandidates.length === 1 && (!parentId || headerCandidates[0]!.session.sessionId === parentId)) {
                    cursor = headerCandidates[0];
                    continue;
                }
                const linksToActive = parentId === this.source.activeSession.sessionId
                    || (parentPath === this.source.sessionFile && (!parentId || parentId === this.source.activeSession.sessionId));
                if (linksToActive && headerCandidates.length <= 1 && activeRoot) {
                    return {kind, rootSessionId: activeRoot};
                }
                return undefined;
            }
        }
        return undefined;
    }

    private async readStable(file: string, signal?: AbortSignal): Promise<{file: string; body: Buffer}> {
        let sawChange = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            checkAbort(signal);
            let changed = false;
            let observed = false;
            try {
                const original = await lstat(file, {bigint: true});
                observed = true;
                if (!original.isFile()) throw new ArchiveSourceError("invalid", "Archive source must be a regular, non-symlink file.");
                const canonical = await realpath(file);
                const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                    const before = await handle.stat({bigint: true});
                    if (!before.isFile()) throw new ArchiveSourceError("invalid", "Archive source must be a regular file.");
                    if (before.size > BigInt(MAX_ARCHIVE_BYTES)) throw new ArchiveSourceError("invalid", "Archive session exceeds the 64 MiB limit.");
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
                    const originalName = canonical === file ? named : await lstat(file, {bigint: true});
                    changed ||= !originalName.isFile() || named.dev !== originalName.dev || named.ino !== originalName.ino
                        || offset !== body.length || extra.bytesRead !== 0 || !named.isFile()
                        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
                        || after.dev !== named.dev || after.ino !== named.ino || after.size !== named.size
                        || after.mtimeNs !== named.mtimeNs || after.ctimeNs !== named.ctimeNs;
                    if (!changed) return {file: canonical, body};
                    sawChange = true;
                } finally {
                    await handle.close();
                }
            } catch (error) {
                checkAbort(signal);
                const failure = ArchiveSourceError.fromFilesystem(error);
                // Disappearance after observation is an unstable read, not evidence
                // that the original source obligation was already missing.
                if (failure.code === "missing" && (observed || sawChange)) {
                    sawChange = true;
                    continue;
                }
                throw failure;
            }
        }
        throw new ArchiveSourceError("changing", "Archive session changed during all three snapshot attempts; try again when it is idle.");
    }

    private parse(file: string, body: Buffer, signal?: AbortSignal): ParsedSession {
        if (body.length === 0) throw new ArchiveSourceError("changing", "Archive session header is not yet complete.");
        let text: string;
        const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
        try {
            text = decoder.decode(body, {stream: true});
        } catch {
            throw new ArchiveSourceError("invalid", "Archive session is not valid UTF-8.");
        }
        let incompleteUtf8 = false;
        try {
            decoder.decode();
        } catch {
            // A stable descriptor can still belong to a paused writer. Validate
            // earlier complete records before treating its truncated suffix as due.
            incompleteUtf8 = true;
        }
        const lines = text.split("\n");
        let header: Record<string, unknown> | undefined;
        let session: SessionIdentity | undefined;
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
                if (index === lines.length - 1 && isIncompleteArchiveJsonPrefix(line, signal)) {
                    throw new ArchiveSourceError("changing", "Archive session ends with an incomplete JSONL record.");
                }
                throw new ArchiveSourceError("invalid", "Archive session contains invalid JSONL.");
            }
            if (!isRecord(value) || typeof value.type !== "string") throw new ArchiveSourceError("invalid", "Archive session contains invalid native entries.");
            if (!header) {
                if (value.type !== "session" || !isNativeSessionId(value.id)
                    || (value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 1))) {
                    throw new ArchiveSourceError("invalid", "Archive session must start with a native session header.");
                }
                header = value;
                session = new SessionIdentity(value.id);
                const started = persistedTime(value.timestamp);
                if (started !== undefined) {
                    metadata.started_at = new Date(started).toISOString();
                    lastActivity = started;
                }
                continue;
            }
            if (value.type === "session") throw new ArchiveSourceError("invalid", "Archive session contains more than one native header.");
            const time = persistedTime(value.timestamp);
            if (time !== undefined) lastActivity = Math.max(lastActivity ?? time, time);
            if (value.type === "session_info") name = typeof value.name === "string" ? shortTitle(value.name) : undefined;
            if (value.type === "custom" && typeof value.customType === "string" && session) {
                session.applyRecord(value.customType, value.data);
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
        if (incompleteUtf8) throw new ArchiveSourceError("changing", "Archive session ends with an incomplete UTF-8 sequence.");
        if (!session || !header) {
            throw new ArchiveSourceError(text.endsWith("\n") ? "invalid" : "changing", "Archive session has no complete native header.");
        }
        if (lastActivity !== undefined) metadata.last_activity_at = new Date(lastActivity).toISOString();
        const title = name ?? firstUserText;
        if (title) metadata.title = title;
        return {entry: {file, session: captureArchiveSourceIdentity(session),
            ...(typeof header.parentSession === "string" && Buffer.byteLength(header.parentSession) <= 4096
                ? {parentSession: header.parentSession} : {})}, metadata};
    }
}

/** Validate body-free catalog evidence reconstructed from durable source rows. */
export function decodeArchiveSourceEvidence(value: unknown): ArchiveSourceEvidence {
    if (!isRecord(value) || typeof value.file !== "string" || !path.isAbsolute(value.file)
        || value.file.includes("\0") || path.resolve(value.file) !== value.file
        || Buffer.from(value.file).toString("utf8") !== value.file
        || (value.parentSession !== undefined && (typeof value.parentSession !== "string" || Buffer.byteLength(value.parentSession) > 4096))) {
        throw new ArchiveSourceError("invalid", "Invalid archive source evidence.");
    }
    try {
        return {file: value.file, session: decodeArchiveSourceIdentity(value.session),
            ...(value.parentSession !== undefined ? {parentSession: value.parentSession} : {})};
    } catch {
        throw new ArchiveSourceError("invalid", "Invalid archive source evidence.");
    }
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
