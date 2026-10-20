import path from "node:path";
import {isNativeSessionId, SessionKind, type SessionIdentity, type ChildSessionKind} from "../sessions/SessionIdentity.js";

/** Interpreted identity only: no transcript entries or live session-manager state. */
export type ArchiveSourceIdentity = {
    sessionId: string;
    // Positive bound main identity, not an inference from the active context.
    main: boolean;
    childKind?: ChildSessionKind;
    parentAgentIdentifier?: string;
    rootSessionId?: string;
    identityConflict: boolean;
};

/** Trusted local discovery authority, suitable for a JSON departure descriptor. */
export type ArchiveSourceScope = {
    version: 1;
    scope: "current" | "all";
    activeSession: ArchiveSourceIdentity;
    sessionFile?: string;
    sessionDirectory: string;
    rootSessionId?: string;
    // Ancestry evidence only; never authority to open another file.
    parentSession?: string;
    // Each collection contains the per-workspace directories used by listAll.
    defaultSessionRoots: string[];
};

export function captureArchiveSourceIdentity(identity: SessionIdentity): ArchiveSourceIdentity {
    return {
        sessionId: identity.sessionId,
        main: identity.identity?.kind === SessionKind.Main,
        identityConflict: identity.identityConflict === true,
        ...(identity.childKind !== undefined ? {childKind: identity.childKind} : {}),
        ...(identity.parentAgentIdentifier !== undefined ? {parentAgentIdentifier: identity.parentAgentIdentifier} : {}),
        ...(identity.rootSessionId !== undefined ? {rootSessionId: identity.rootSessionId} : {}),
    };
}

/** Validate and detach deserialized local data before granting filesystem discovery authority. */
export function decodeArchiveSourceScope(value: unknown): ArchiveSourceScope {
    if (!isRecord(value) || value.version !== 1 || (value.scope !== "current" && value.scope !== "all")
        || !isAbsolutePath(value.sessionDirectory)
        || (value.sessionFile !== undefined && !isAbsolutePath(value.sessionFile))
        || !Array.isArray(value.defaultSessionRoots) || value.defaultSessionRoots.length === 0
        || ![...value.defaultSessionRoots].every(isAbsolutePath)
        || (value.rootSessionId !== undefined && !isNativeSessionId(value.rootSessionId))
        || (value.parentSession !== undefined && typeof value.parentSession !== "string")) {
        throw new Error("Invalid archive source scope.");
    }
    const activeSession = decodeArchiveSourceIdentity(value.activeSession);
    if (value.rootSessionId !== knownRoot(activeSession)) throw new Error("Invalid archive source root identity.");
    return {
        version: 1, scope: value.scope, activeSession,
        sessionDirectory: value.sessionDirectory,
        defaultSessionRoots: [...value.defaultSessionRoots],
        ...(value.sessionFile !== undefined ? {sessionFile: value.sessionFile} : {}),
        ...(value.rootSessionId !== undefined ? {rootSessionId: value.rootSessionId} : {}),
        ...(value.parentSession !== undefined ? {parentSession: value.parentSession} : {}),
    };
}

export function decodeArchiveSourceIdentity(identity: unknown): ArchiveSourceIdentity {
    if (!isRecord(identity) || !isNativeSessionId(identity.sessionId)
        || typeof identity.main !== "boolean" || typeof identity.identityConflict !== "boolean"
        || (identity.childKind !== undefined && identity.childKind !== SessionKind.Subagent && identity.childKind !== SessionKind.PolicyApprover)
        || (identity.parentAgentIdentifier !== undefined && !isNativeSessionId(identity.parentAgentIdentifier))
        || (identity.rootSessionId !== undefined && !isNativeSessionId(identity.rootSessionId))
        || (identity.main && (identity.childKind !== undefined || identity.parentAgentIdentifier !== undefined
            || identity.rootSessionId !== identity.sessionId))
        || (!identity.main && identity.childKind === undefined
            && (identity.rootSessionId !== undefined || identity.parentAgentIdentifier !== undefined))
        || (identity.childKind !== undefined && identity.rootSessionId !== undefined
            && (identity.rootSessionId === identity.sessionId || identity.parentAgentIdentifier === undefined
                || identity.parentAgentIdentifier === identity.sessionId))) {
        throw new Error("Invalid archive source identity.");
    }
    return {
        sessionId: identity.sessionId, main: identity.main, identityConflict: identity.identityConflict,
        ...(identity.childKind !== undefined ? {childKind: identity.childKind} : {}),
        ...(identity.parentAgentIdentifier !== undefined ? {parentAgentIdentifier: identity.parentAgentIdentifier} : {}),
        ...(identity.rootSessionId !== undefined ? {rootSessionId: identity.rootSessionId} : {}),
    };
}

function knownRoot(identity: ArchiveSourceIdentity): string | undefined {
    return identity.identityConflict ? undefined : identity.rootSessionId ?? (identity.childKind ? undefined : identity.sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): value is string {
    return typeof value === "string" && !value.includes("\0") && Buffer.from(value).toString("utf8") === value
        && path.isAbsolute(value) && path.resolve(value) === value;
}
