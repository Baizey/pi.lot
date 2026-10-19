import type {ExtensionAPI, ExtensionContext, SessionManager} from "@earendil-works/pi-coding-agent";

export enum SessionKind {
    Main = "main",
    Subagent = "subagent",
    PolicyApprover = "policy_approver",
}

export type ChildSessionKind = SessionKind.Subagent | SessionKind.PolicyApprover;
// Pi exposes this native readonly view through ExtensionContext, not its barrel exports.
type ReadonlySessionManager = ExtensionContext["sessionManager"];
type BoundSessionIdentity =
    | {kind: SessionKind.Main; rootSessionId: string; parentAgentIdentifier?: undefined}
    | {kind: ChildSessionKind; rootSessionId?: string; parentAgentIdentifier: string};

/** Interprets one native session's records; ancestry across files belongs to the archive catalog. */
export class SessionIdentity {
    private readonly legacyKind?: ChildSessionKind;
    private legacyParent?: string;
    private boundIdentity?: BoundSessionIdentity;
    private conflict?: boolean;

    constructor(readonly sessionId: string) {
        if (sessionId.startsWith("policy-approver-")) this.legacyKind = SessionKind.PolicyApprover;
        else if (sessionId.startsWith("subagent-")) this.legacyKind = SessionKind.Subagent;
    }

    static fromManager(manager: ReadonlySessionManager): SessionIdentity {
        const identity = new SessionIdentity(manager.getSessionId());
        for (const entry of manager.getEntries()) {
            if (entry.type === "custom") identity.applyRecord(entry.customType, entry.data);
        }
        return identity;
    }

    get identity(): Readonly<BoundSessionIdentity> | undefined {
        return this.boundIdentity;
    }

    get childKind(): ChildSessionKind | undefined {
        return this.boundIdentity
            ? this.boundIdentity.kind === SessionKind.Main ? undefined : this.boundIdentity.kind
            : this.legacyKind;
    }

    get parentAgentIdentifier(): string | undefined {
        return this.boundIdentity ? this.boundIdentity.parentAgentIdentifier : this.legacyParent;
    }

    get rootSessionId(): string | undefined {
        return this.boundIdentity?.rootSessionId;
    }

    get identityConflict(): boolean | undefined {
        return this.conflict;
    }

    applyRecord(customType: string, data: unknown): void {
        if (customType !== "pilot.subagent" && customType !== "pilot.archive") return;
        if (!isRecord(data)) return;
        if (data.sessionId === undefined) {
            // Old records are useful only for known legacy child IDs. Forks copy custom
            // entries, so an unbound record can never establish identity on ordinary IDs.
            if (customType === "pilot.subagent" && this.childKind && !this.identity && isNativeSessionId(data.parentAgentIdentifier)) {
                if (this.parentAgentIdentifier && this.parentAgentIdentifier !== data.parentAgentIdentifier) this.conflict = true;
                this.legacyParent = data.parentAgentIdentifier;
            }
            return;
        }
        if (data.sessionId !== this.sessionId) return;
        let identity: BoundSessionIdentity;
        if (data.version === 1 && customType === "pilot.archive" && data.kind === SessionKind.Main
            && data.rootSessionId === this.sessionId) {
            identity = {kind: SessionKind.Main, rootSessionId: this.sessionId};
        } else if (data.version === 1 && customType === "pilot.subagent"
            && (data.kind === SessionKind.Subagent || data.kind === SessionKind.PolicyApprover)
            && isNativeSessionId(data.parentAgentIdentifier) && data.parentAgentIdentifier !== this.sessionId
            && (data.rootSessionId === undefined || (isNativeSessionId(data.rootSessionId) && data.rootSessionId !== this.sessionId))) {
            identity = {kind: data.kind, parentAgentIdentifier: data.parentAgentIdentifier,
                ...(data.rootSessionId !== undefined ? {rootSessionId: data.rootSessionId} : {})};
        } else {
            this.conflict = true;
            return;
        }
        if (this.identity && (this.identity.kind !== identity.kind || this.identity.rootSessionId !== identity.rootSessionId
            || this.identity.parentAgentIdentifier !== identity.parentAgentIdentifier)) this.conflict = true;
        this.boundIdentity = identity;
    }
}

/** Called only for the active Pilot session, before any children are created. */
export function recordMainSessionIdentity(pi: ExtensionAPI, manager: ReadonlySessionManager): void {
    const entry = SessionIdentity.fromManager(manager);
    if (!isNativeSessionId(entry.sessionId) || entry.childKind || entry.identity || entry.identityConflict) return;
    pi.appendEntry("pilot.archive", {
        version: 1, sessionId: entry.sessionId, kind: SessionKind.Main, rootSessionId: entry.sessionId,
    });
}

export function recordChildSessionIdentity(
    manager: SessionManager,
    child: {parentAgentIdentifier: string; rootSessionId?: string; kind?: ChildSessionKind},
): void {
    manager.appendCustomEntry("pilot.subagent", {
        version: 1,
        sessionId: manager.getSessionId(),
        parentAgentIdentifier: child.parentAgentIdentifier,
        rootSessionId: child.rootSessionId,
        kind: child.kind ?? SessionKind.Subagent,
    });
}

/** Active context supplies positive main identity; resumed children retain their original root. */
export function getSessionRootId(manager: ReadonlySessionManager): string | undefined {
    const entry = SessionIdentity.fromManager(manager);
    if (!isNativeSessionId(entry.sessionId) || entry.identityConflict) return undefined;
    if (entry.identity) return entry.identity.rootSessionId;
    return entry.childKind ? undefined : entry.sessionId;
}

export function isNativeSessionId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.from(value).toString("utf8") === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
