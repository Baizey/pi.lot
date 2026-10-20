import {createHash} from "node:crypto";
import {
    type ArchiveMetadata, type Condition, type Revision, decodeArchiveMetadata,
} from "./ArchiveProtocol.js";

export type ArchiveCandidate = {
    sessionId: string;
    body: Buffer;
    metadata: ArchiveMetadata | null;
};

/** Body and metadata must belong to this exact, integrity-verified canonical revision. */
export type ArchiveCanonicalSnapshot = {
    body: Buffer;
    revision: Revision;
    /** undefined means unknown/incoherent; null means coherently absent, not an empty object. */
    metadata: ArchiveMetadata | null | undefined;
};

export type ArchiveReconciliationOptions = {preservationSupported: boolean};
export type ArchivePreservationReason = "metadata" | "divergence";
export type ArchiveReconciliationDecision =
    | {kind: "covered"; revision: Revision}
    | {kind: "publish"; condition: Condition}
    | {kind: "preserve-uploaded"; reason: ArchivePreservationReason}
    | {kind: "preserve-current-then-publish"; reason: ArchivePreservationReason;
        condition: Extract<Condition, {kind: "exact_base_revision"}>}
    | {kind: "defer"; reason: "unknown-remote-metadata" | "preservation-unsupported"};

type PreservationDecision = Extract<ArchiveReconciliationDecision,
    {kind: "preserve-uploaded" | "preserve-current-then-publish"}>;

/**
 * Decide only; no publication, persistence, or acknowledgment occurs here. Both inputs concern
 * local.sessionId. null remote means verified absence, not a failed or uncertain download.
 * Preservation must be durably accepted before cleanup or dependent publication. The exact
 * condition is also the preserve-current target; a stale result requires fresh reconciliation.
 * Callers must freeze executable requests separately, including their binding and candidate.
 */
export function reconcileArchive(local: ArchiveCandidate, remote: ArchiveCanonicalSnapshot | null,
    options: ArchiveReconciliationOptions): ArchiveReconciliationDecision {
    const localMetadata = local.metadata === null ? null : decodeArchiveMetadata(local.metadata, local.sessionId);
    if (remote === null) return {kind: "publish", condition: {kind: "absent"}};
    if (remote.metadata === undefined) return {kind: "defer", reason: "unknown-remote-metadata"};
    const remoteMetadata = remote.metadata === null ? null : decodeArchiveMetadata(remote.metadata, local.sessionId);
    const condition: Extract<Condition, {kind: "exact_base_revision"}> = {
        kind: "exact_base_revision", revision: remote.revision,
    };

    if (local.body.equals(remote.body)) {
        // The protocol decoder fixes property order and timestamp spelling, without collapsing null.
        if (JSON.stringify(localMetadata) === JSON.stringify(remoteMetadata)) {
            return {kind: "covered", revision: remote.revision};
        }
        // Equal bodies do not order metadata truth: the first canonical metadata stays canonical.
        return preservation({kind: "preserve-uploaded", reason: "metadata"}, options);
    }
    if (properPrefix(local.body, remote.body)) {
        if (losesAssertion(localMetadata, remoteMetadata)) {
            return preservation({kind: "preserve-uploaded", reason: "metadata"}, options);
        }
        return {kind: "covered", revision: remote.revision};
    }
    if (properPrefix(remote.body, local.body)) {
        if (losesAssertion(remoteMetadata, localMetadata)) {
            return preservation({kind: "preserve-current-then-publish", reason: "metadata", condition}, options);
        }
        return {kind: "publish", condition};
    }

    // Only divergent bodies need hashing, and length takes precedence over digest ordering.
    const localPreferred = local.body.length !== remote.body.length
        ? local.body.length > remote.body.length
        : createHash("sha256").update(local.body).digest("hex")
            > createHash("sha256").update(remote.body).digest("hex");
    return preservation(localPreferred
        ? {kind: "preserve-current-then-publish", reason: "divergence", condition}
        : {kind: "preserve-uploaded", reason: "divergence"}, options);
}

function properPrefix(shorter: Buffer, longer: Buffer): boolean {
    return shorter.length < longer.length && shorter.equals(longer.subarray(0, shorter.length));
}

function losesAssertion(shorter: ArchiveMetadata | null, longer: ArchiveMetadata | null): boolean {
    return (shorter?.kind !== undefined && shorter.kind !== longer?.kind)
        || (shorter?.root_session_id !== undefined && shorter.root_session_id !== longer?.root_session_id);
}

function preservation(decision: PreservationDecision,
    options: ArchiveReconciliationOptions): ArchiveReconciliationDecision {
    return options.preservationSupported ? decision : {kind: "defer", reason: "preservation-unsupported"};
}
