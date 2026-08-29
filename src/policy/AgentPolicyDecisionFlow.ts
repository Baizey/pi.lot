import type {PolicyChoice} from "./PolicyDecisionFlow.js";
import type {
    PolicyAccessType,
    PolicyArea,
    PolicyLifetime,
    PolicyResult,
} from "./types.js";

export type PolicyPrincipalContext = {
    role: string;
    task: string;
};

export type PolicyToolCallContext = {
    toolCallId?: string;
    toolName?: string;
    command?: string;
    purpose?: string;
};

export type PolicyApprovalAgentContext = PolicyPrincipalContext & {
    agentIdentifier: string;
};

export type PolicyApprovalRequestContext = {
    requestId: string;
    requestingAgentIdentifier: string;
    ancestry: PolicyApprovalAgentContext[];
    toolCall: PolicyToolCallContext;
};

export enum PolicyApprovalReviewSource {
    ANCESTOR_AUTHORITY = "ANCESTOR_AUTHORITY",
    POLICY_DEFAULT_ASK_LLM = "POLICY_DEFAULT_ASK_LLM",
}

type BaseAgentPolicyApprovalRequest = PolicyApprovalRequestContext & {
    approvingAgentIdentifier: string;
    uri: string;
    accessType: PolicyAccessType;
    allowedScopes: string[];
    allowedLifetimes: PolicyLifetime[];
};

export type AgentPolicyApprovalRequest = BaseAgentPolicyApprovalRequest & (
    | {
        reviewSource: PolicyApprovalReviewSource.ANCESTOR_AUTHORITY;
        authority: PolicyResult;
    }
    | {
        reviewSource: PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM;
        policyArea: PolicyArea;
        fallbackRevision: number;
    }
);

export interface AgentPolicyDecisionFlow {
    askForPolicy(
        request: AgentPolicyApprovalRequest,
        signal?: AbortSignal,
    ): Promise<PolicyChoice>;
}
