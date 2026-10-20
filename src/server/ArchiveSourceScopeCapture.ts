import path from "node:path";
import {getAgentDir, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import {SessionIdentity} from "../sessions/SessionIdentity.js";
import {captureArchiveSourceIdentity, decodeArchiveSourceScope, type ArchiveSourceScope} from "./ArchiveSourceScope.js";

/** Foreground only: capture after identity registration, never during departure. */
export function captureArchiveSourceScope(
    manager: ExtensionContext["sessionManager"],
    scope: "current" | "all" = "current",
): ArchiveSourceScope {
    const activeSession = captureArchiveSourceIdentity(SessionIdentity.fromManager(manager));
    const file = manager.getSessionFile();
    const parentSession = manager.getHeader()?.parentSession;
    const rootSessionId = activeSession.identityConflict ? undefined
        : activeSession.rootSessionId ?? (activeSession.childKind ? undefined : activeSession.sessionId);
    return decodeArchiveSourceScope({
        version: 1, scope, activeSession,
        ...(file ? {sessionFile: path.resolve(file)} : {}),
        sessionDirectory: path.resolve(manager.getSessionDir()),
        ...(rootSessionId !== undefined ? {rootSessionId} : {}),
        ...(typeof parentSession === "string" ? {parentSession} : {}),
        defaultSessionRoots: [path.resolve(getAgentDir(), "sessions")],
    });
}
