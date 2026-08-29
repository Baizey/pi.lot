import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
    PolicyApprovalAgentContext,
    PolicyToolCallContext,
} from "./AgentPolicyDecisionFlow.js";
import type {
    PolicyAccessType,
    PolicyArea,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
} from "./types.js";

export type PolicyApprovalAuditRoute =
    | "USER"
    | "ANCESTOR_AUTHORITY"
    | "POLICY_DEFAULT_ASK_LLM";

export type PolicyApprovalAuditOutcome =
    | "DECIDED"
    | "FAILED_CLOSED"
    | "SUPERSEDED";

export type PolicyApprovalAuditRecord = {
    version: 1;
    timestamp: string;
    sessionIdentifier: string;
    requestId: string;
    route: PolicyApprovalAuditRoute;
    outcome: PolicyApprovalAuditOutcome;
    requester: {
        agentIdentifier: string;
        ancestry: PolicyApprovalAgentContext[];
    };
    routingOwner?: string;
    operation: {
        target: string;
        accessType: PolicyAccessType;
        toolCall: PolicyToolCallContext;
    };
    authority?:
        | {
            kind: "ANCESTOR_AUTHORITY";
            scope: string;
            lifetime: PolicyLifetime;
            status: PolicyResponse;
            reason: string;
            resolutionSource: PolicyResolutionSource;
        }
        | {
            kind: "POLICY_DEFAULT_ASK_LLM";
            policyArea: PolicyArea;
            fallbackRevision: number;
        };
    decision: {
        scope: string;
        lifetime: PolicyLifetime;
        status: PolicyResponse;
        reason: string;
    };
    result: {
        scope: string;
        lifetime: PolicyLifetime;
        status: PolicyResponse;
        reason: string;
        resolutionSource: PolicyResolutionSource;
    };
};

export interface PolicyApprovalAuditLogInterface {
    append(record: PolicyApprovalAuditRecord): void;
}

export class PolicyApprovalAuditLog implements PolicyApprovalAuditLogInterface {
    readonly file: string;

    constructor(
        sessionIdentifier: string,
        directory = path.join(os.homedir(), ".pilot", "logs"),
    ) {
        this.file = path.join(directory, `${safeSessionFilename(sessionIdentifier)}.log`);
    }

    append(record: PolicyApprovalAuditRecord): void {
        const directory = path.dirname(this.file);
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        const directoryFlags = fs.constants.O_RDONLY
            | fs.constants.O_DIRECTORY
            | (fs.constants.O_NOFOLLOW ?? 0);
        const directoryDescriptor = fs.openSync(directory, directoryFlags);
        try {
            fs.fchmodSync(directoryDescriptor, 0o700);
            const fileFlags = fs.constants.O_APPEND
                | fs.constants.O_CREAT
                | fs.constants.O_WRONLY
                | (fs.constants.O_NOFOLLOW ?? 0);
            const descriptorPath = `/proc/self/fd/${directoryDescriptor}/${path.basename(this.file)}`;
            const descriptor = fs.openSync(descriptorPath, fileFlags, 0o600);
            try {
                fs.fchmodSync(descriptor, 0o600);
                fs.writeSync(
                    descriptor,
                    `${JSON.stringify(boundedPolicyApprovalAuditRecord(record))}\n`,
                    undefined,
                    "utf8",
                );
            } finally {
                fs.closeSync(descriptor);
            }
        } finally {
            fs.closeSync(directoryDescriptor);
        }
    }
}

export function boundedPolicyApprovalAuditRecord(
    record: PolicyApprovalAuditRecord,
): PolicyApprovalAuditRecord {
    return {
        ...record,
        timestamp: boundedText(record.timestamp, 64),
        sessionIdentifier: boundedText(record.sessionIdentifier, 500),
        requestId: boundedText(record.requestId, 200),
        requester: {
            agentIdentifier: boundedText(record.requester.agentIdentifier, 200),
            ancestry: record.requester.ancestry.slice(0, 100).map((agent) => ({
                agentIdentifier: boundedText(agent.agentIdentifier, 200),
                role: boundedText(agent.role, 120),
                task: boundedText(agent.task, 500),
            })),
        },
        routingOwner: boundedOptionalText(record.routingOwner, 200),
        operation: {
            target: boundedText(record.operation.target, 16_000),
            accessType: record.operation.accessType,
            toolCall: {
                toolCallId: boundedOptionalText(record.operation.toolCall.toolCallId, 500),
                toolName: boundedOptionalText(record.operation.toolCall.toolName, 120),
                command: boundedOptionalText(record.operation.toolCall.command, 8_000),
                purpose: boundedOptionalText(record.operation.toolCall.purpose, 500),
            },
        },
        authority: record.authority?.kind === "ANCESTOR_AUTHORITY"
            ? {
                ...record.authority,
                scope: boundedText(record.authority.scope, 16_000),
                reason: boundedText(record.authority.reason, 2_000),
            }
            : record.authority,
        decision: {
            ...record.decision,
            scope: boundedText(record.decision.scope, 16_000),
            reason: boundedText(record.decision.reason, 2_000),
        },
        result: {
            ...record.result,
            scope: boundedText(record.result.scope, 16_000),
            reason: boundedText(record.result.reason, 2_000),
        },
    };
}

function boundedOptionalText(value: string | undefined, maximum: number): string | undefined {
    return value === undefined ? undefined : boundedText(value, maximum);
}

function boundedText(value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function safeSessionFilename(sessionIdentifier: string): string {
    if (
        sessionIdentifier.length > 0
        && sessionIdentifier.length <= 120
        && sessionIdentifier !== "."
        && sessionIdentifier !== ".."
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionIdentifier)
    ) {
        return sessionIdentifier;
    }
    const readable = sessionIdentifier
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/\.+/g, "_")
        .slice(0, 80)
        || "session";
    const digest = crypto.createHash("sha256").update(sessionIdentifier).digest("hex").slice(0, 12);
    return `${readable}-${digest}`;
}
