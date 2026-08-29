import crypto from "node:crypto";
import {
    PolicyApprovalReviewSource,
    type AgentPolicyApprovalRequest,
    AgentPolicyDecisionFlow,
    PolicyApprovalRequestContext,
    PolicyPrincipalContext,
    PolicyToolCallContext,
} from "./AgentPolicyDecisionFlow.js";
import type {PolicyChoice} from "./PolicyDecisionFlow.js";
import {PolicyDecisionFlow} from "./PolicyDecisionFlow";
import {PolicyEngine} from "./PolicyEngine";
import {policyScopeCovers, policyScopeHierarchy} from "./PolicyScope.js";
import {
    isPersistedLifetime,
    type Policy,
    PolicyAccessType,
    PolicyArea,
    POLICY_AREAS,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
    type PolicyStatus,
    policyAreaAccessTypes,
    policyAreaForAccessType,
    resolveUri,
} from "./types";
import type {PolicyDaoInterface} from "../storage/PolicyDao";
import {initialPolicyDefaults, type PolicyDefaultJsonStorageInterface, type ResponseDefaults} from "./defaults.js";
import {UNIVERSAL_NETWORK_POLICY_PATTERN} from "./network/ParsedUri.js";
import {
    boundedPolicyApprovalAuditRecord,
    type PolicyApprovalAuditLogInterface,
    type PolicyApprovalAuditOutcome,
    type PolicyApprovalAuditRecord,
} from "./PolicyApprovalAuditLog.js";

export type ToolCallPathPolicyEvaluator = (
    path: string,
    accessType: PolicyAccessType,
    signal?: AbortSignal,
) => Promise<PolicyResult>;

export interface PolicyPrincipalRegistry {
    registerPolicyPrincipal(
        agentIdentifier: string,
        parentAgentIdentifier: string,
        inheritedAreas: readonly PolicyArea[],
        context?: PolicyPrincipalContext,
    ): void;

    updatePolicyPrincipalContext?(
        agentIdentifier: string,
        context: Partial<PolicyPrincipalContext>,
    ): void;

    removePolicyPrincipal(agentIdentifier: string): void;
}

type PolicyPrincipal = {
    agentIdentifier: string;
    parentAgentIdentifier?: string;
    children: Set<string>;
    policies: PolicyEngine;
    policyRevision: number;
    context: PolicyPrincipalContext;
    contextRevision: number;
};

type PrincipalPathSnapshot = {
    path: PolicyPrincipal[];
    policyRevisions: number[];
    contextRevisions: number[];
};

type FallbackSnapshot = {
    area: PolicyArea;
    revision: number;
};

type AncestorAuthority = PrincipalPathSnapshot & {
    authorityPrincipal: PolicyPrincipal;
    authority: PolicyResult;
    fallback?: FallbackSnapshot;
};

type AncestorResolution =
    | {kind: "authority"; value: AncestorAuthority}
    | {kind: "denied"; result: PolicyResult}
    | {kind: "user"};

const MAX_AGENT_POLICY_SCOPES = 32;
const MAX_AGENT_POLICY_SCOPE_CHARS = 32_000;
const MAX_POLICY_URI_CHARS = 16_000;

const ROOT_AGENT_CONTEXT: PolicyPrincipalContext = Object.freeze({
    role: "Root agent",
    task: "Active root orchestration session",
});

export class PolicyRuntime implements PolicyPrincipalRegistry {
    private readonly principals = new Map<string, PolicyPrincipal>();
    private readonly rootFallbackPolicies = new PolicyEngine();
    private readonly rootAgentIdentifier: string;
    private agentDecisionFlow: AgentPolicyDecisionFlow | undefined;
    private readonly fallbackRevisions = initialFallbackRevisions();
    private closing = false;
    readonly defaultResponses: ResponseDefaults;

    constructor(
        agentIdentifier: string,
        private readonly database: PolicyDaoInterface,
        private readonly decisionFlow: PolicyDecisionFlow,
        private readonly defaultsStore?: PolicyDefaultJsonStorageInterface,
        rootContext: PolicyPrincipalContext = ROOT_AGENT_CONTEXT,
        private readonly approvalAudit?: PolicyApprovalAuditLogInterface,
    ) {
        this.rootAgentIdentifier = agentIdentifier;
        this.principals.set(agentIdentifier, {
            agentIdentifier,
            children: new Set(),
            policies: new PolicyEngine(database.loadPolicies()),
            policyRevision: 0,
            context: normalizedPrincipalContext(rootContext),
            contextRevision: 0,
        });
        this.defaultResponses = {...initialPolicyDefaults, ...defaultsStore?.load()};
        this.setFallbacks();
    }

    async once(
        agentIdentifier: string,
        path: string,
        accessType: PolicyAccessType,
        signal?: AbortSignal,
        toolCall: PolicyToolCallContext = {},
    ): Promise<PolicyResult> {
        return this.beginToolCall(agentIdentifier, toolCall)(path, accessType, signal);
    }

    beginToolCall(
        agentIdentifier: string,
        toolCall: PolicyToolCallContext = {},
    ): ToolCallPathPolicyEvaluator {
        const oncePolicies = new PolicyEngine();
        const principal = this.requirePrincipal(agentIdentifier);
        const context = normalizedToolCallContext(toolCall);
        return (path, accessType, signal) => this.evaluate(
            principal,
            path,
            accessType,
            oncePolicies,
            context,
            signal,
        );
    }

    setAgentDecisionFlow(flow: AgentPolicyDecisionFlow | undefined): void {
        this.agentDecisionFlow = flow;
    }

    beginShutdown(): void {
        this.closing = true;
        this.agentDecisionFlow = undefined;
    }

    setDefaultResponse(area: PolicyArea, response: PolicyFallbackResponse): void {
        if (this.defaultResponses[area] === response) return;
        this.defaultResponses[area] = response;
        this.fallbackRevisions[area]++;
        this.setFallback(area, response);
    }

    saveDefaultResponses(): void {
        if (!this.defaultsStore) throw new Error("Policy defaults persistence is not configured.");
        this.defaultsStore.save(this.defaultResponses);
    }

    resetDefaultResponses(): void {
        const defaults = this.defaultsStore?.load() ?? initialPolicyDefaults;
        for (const area of POLICY_AREAS) this.setDefaultResponse(area, defaults[area]);
    }

    registerPolicyPrincipal(
        agentIdentifier: string,
        parentAgentIdentifier: string,
        inheritedAreas: readonly PolicyArea[],
        context: PolicyPrincipalContext = {role: "Subagent", task: "Delegated work"},
    ): void {
        if (this.principals.has(agentIdentifier)) {
            throw new Error(`An agent is already registered with this identifier: ${agentIdentifier}`);
        }
        const parent = this.requirePrincipal(parentAgentIdentifier);
        const policies = this.inheritedPolicySnapshot(parent, inheritedAreas);
        this.principals.set(agentIdentifier, {
            agentIdentifier,
            parentAgentIdentifier,
            children: new Set(),
            policies: new PolicyEngine(policies),
            policyRevision: 0,
            context: normalizedPrincipalContext(context),
            contextRevision: 0,
        });
        parent.children.add(agentIdentifier);
    }

    updatePolicyPrincipalContext(
        agentIdentifier: string,
        context: Partial<PolicyPrincipalContext>,
    ): void {
        const principal = this.requirePrincipal(agentIdentifier);
        principal.context = normalizedPrincipalContext({...principal.context, ...context});
        principal.contextRevision++;
    }

    removePolicyPrincipal(agentIdentifier: string): void {
        const principal = this.requirePrincipal(agentIdentifier);
        if (agentIdentifier === this.rootAgentIdentifier) {
            throw new Error("The root policy principal cannot be removed");
        }
        if (principal.children.size > 0) {
            throw new Error(`Policy principal still has registered children: ${agentIdentifier}`);
        }
        if (principal.parentAgentIdentifier) {
            this.requirePrincipal(principal.parentAgentIdentifier).children.delete(agentIdentifier);
        }
        this.principals.delete(agentIdentifier);
    }

    private async evaluate(
        principal: PolicyPrincipal,
        inputUri: string,
        accessType: PolicyAccessType,
        oncePolicies: PolicyEngine,
        toolCall: PolicyToolCallContext,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        if (inputUri.length > MAX_POLICY_URI_CHARS) {
            return failedClosedResult(
                boundedText(inputUri, MAX_POLICY_URI_CHARS),
                accessType,
                "Policy target exceeds the maximum supported length.",
            );
        }
        const uri = resolveUri(accessType, inputUri);
        if (this.closing) {
            return failedClosedResult(uri, accessType, "Policy runtime is shutting down.");
        }
        const local = principal.policies.evaluate(uri, accessType);
        if (local) return local;

        if (principal.agentIdentifier === this.rootAgentIdentifier) {
            const fallback = this.rootFallbackPolicies.evaluate(uri, accessType);
            if (fallback) return systemFallbackResult(fallback);
        }

        const once = oncePolicies.evaluate(uri, accessType);
        if (once) return once;

        const ancestor = this.resolveAncestorAuthority(principal, uri, accessType);
        if (ancestor.kind === "denied") return ancestor.result;
        if (ancestor.kind === "authority") {
            return this.askAuthorizedAncestor(
                principal,
                ancestor.value,
                uri,
                accessType,
                oncePolicies,
                toolCall,
                signal,
            );
        }

        const fallback = this.defaultResponses[policyAreaForAccessType(accessType)];
        if (fallback === PolicyFallbackResponse.ask_llm) {
            return this.askLlmFallback(
                principal,
                uri,
                accessType,
                oncePolicies,
                toolCall,
                signal,
            );
        }
        if (fallback === PolicyFallbackResponse.ask_user) {
            return this.askUser(principal, uri, accessType, oncePolicies, toolCall, signal);
        }
        return failedClosedResult(
            uri,
            accessType,
            `Policy fallback ${fallback} had no matching automated policy.`,
        );
    }

    private resolveAncestorAuthority(
        requester: PolicyPrincipal,
        uri: string,
        accessType: PolicyAccessType,
    ): AncestorResolution {
        const path = [requester];
        let current = requester;
        while (current.parentAgentIdentifier) {
            const parent = this.requirePrincipal(current.parentAgentIdentifier);
            path.push(parent);
            const authority = this.evaluatePrincipalAuthority(parent, uri, accessType);
            if (authority?.matchedStatus === PolicyResponse.DENIED) {
                return {kind: "denied", result: authority};
            }
            if (authority?.matchedStatus === PolicyResponse.ALLOWED) {
                return {
                    kind: "authority",
                    value: {
                        authorityPrincipal: parent,
                        authority,
                        ...this.principalPathSnapshot(path),
                        fallback: authority.resolutionSource === PolicyResolutionSource.SYSTEM
                            ? this.fallbackSnapshot(accessType)
                            : undefined,
                    },
                };
            }
            current = parent;
        }
        return {kind: "user"};
    }

    private evaluatePrincipalAuthority(
        principal: PolicyPrincipal,
        uri: string,
        accessType: PolicyAccessType,
    ): PolicyResult | null {
        const local = principal.policies.evaluate(uri, accessType);
        if (local || principal.agentIdentifier !== this.rootAgentIdentifier) return local;
        const fallback = this.rootFallbackPolicies.evaluate(uri, accessType);
        return fallback ? systemFallbackResult(fallback) : null;
    }

    private async askAuthorizedAncestor(
        requester: PolicyPrincipal,
        source: AncestorAuthority,
        uri: string,
        accessType: PolicyAccessType,
        oncePolicies: PolicyEngine,
        toolCall: PolicyToolCallContext,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        const requestId = crypto.randomUUID();
        let request: AgentPolicyApprovalRequest | undefined;
        let choice: PolicyChoice;
        let validatedDecision = false;
        try {
            request = this.agentApprovalRequest(requestId, requester, source, uri, accessType, toolCall);
            if (!this.agentDecisionFlow) throw new Error("Authorized super-agent review is unavailable.");
            choice = await this.agentDecisionFlow.askForPolicy(request, signal);
            if (signal?.aborted || this.closing) throw new Error("the pending operation was aborted");
            if (!this.isActiveAuthorityPath(source)) throw new Error("the policy authority path is no longer active");
            const resolvedWhilePending = requester.policies.evaluate(uri, accessType)
                ?? oncePolicies.evaluate(uri, accessType);
            if (resolvedWhilePending) {
                this.auditStructuredApproval(request, choice, resolvedWhilePending, "SUPERSEDED");
                return resolvedWhilePending;
            }
            const currentResolution = this.resolveAncestorAuthority(requester, uri, accessType);
            if (currentResolution.kind === "denied") {
                this.auditStructuredApproval(request, choice, currentResolution.result, "SUPERSEDED");
                return currentResolution.result;
            }
            if (!this.isUnchangedAuthorityPath(source)) {
                throw new Error("the policy authority or request context changed while approval was pending");
            }
            if (
                currentResolution.kind !== "authority"
                || currentResolution.value.authorityPrincipal !== source.authorityPrincipal
            ) {
                throw new Error("the approving agent is no longer the nearest covering authority");
            }
            choice = this.validatedAgentChoice(choice, request);
            choice = this.validatedAgentChoice(
                choice,
                this.agentApprovalRequest(
                    requestId,
                    requester,
                    currentResolution.value,
                    uri,
                    accessType,
                    toolCall,
                ),
            );
            validatedDecision = true;
        } catch (error) {
            choice = deniedChoice(
                uri,
                accessType,
                `Agent policy approval failed closed: ${errorMessage(error)}`,
            );
        }
        const policy = policyFromChoice(choice);

        if (validatedDecision && this.isActiveAuthorityPath(source)) {
            if (choice.lifetime === PolicyLifetime.SESSION) {
                for (const principal of source.path.slice(0, -1)) {
                    this.addPrincipalPolicies(principal, [policy]);
                }
            } else {
                oncePolicies.addPolicies([policy]);
            }
        }

        const result = PolicyResult.of({
            resolutionSource: PolicyResolutionSource.NEW_AGENT_DECISION,
            evaluatedUri: uri,
            evaluatedAccessType: accessType,
            matchedPattern: resolveUri(accessType, choice.uri),
            matchedLifetime: choice.lifetime,
            matchedStatus: choice.status,
            matchedReason: choice.reason,
        });
        if (request) {
            this.auditStructuredApproval(
                request,
                choice,
                result,
                validatedDecision ? "DECIDED" : "FAILED_CLOSED",
            );
        }
        return result;
    }

    private async askLlmFallback(
        requester: PolicyPrincipal,
        uri: string,
        accessType: PolicyAccessType,
        oncePolicies: PolicyEngine,
        toolCall: PolicyToolCallContext,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        const path = this.pathToRoot(requester);
        const pathSnapshot = this.principalPathSnapshot(path);
        const fallback = this.fallbackSnapshot(accessType);
        const requestId = crypto.randomUUID();
        let request: AgentPolicyApprovalRequest | undefined;
        let choice: PolicyChoice;
        let validatedDecision = false;
        try {
            request = this.llmFallbackApprovalRequest(
                requestId,
                requester,
                path,
                uri,
                accessType,
                toolCall,
                fallback,
            );
            if (!this.agentDecisionFlow) throw new Error("LLM policy review is unavailable.");
            choice = await this.agentDecisionFlow.askForPolicy(request, signal);
            if (signal?.aborted || this.closing) throw new Error("the pending operation was aborted");
            const resolvedWhilePending = requester.policies.evaluate(uri, accessType)
                ?? oncePolicies.evaluate(uri, accessType);
            if (resolvedWhilePending) {
                this.auditStructuredApproval(request, choice, resolvedWhilePending, "SUPERSEDED");
                return resolvedWhilePending;
            }
            if (
                !this.isActivePrincipalPath(path)
                || !this.isUnchangedPrincipalPath(pathSnapshot)
                || !this.isUnchangedFallback(fallback)
                || this.defaultResponses[fallback.area] !== PolicyFallbackResponse.ask_llm
            ) {
                throw new Error("the ask_llm policy default or request context changed while review was pending");
            }
            choice = this.validatedAgentChoice(choice, request);
            choice = this.validatedAgentChoice(
                choice,
                this.llmFallbackApprovalRequest(
                    requestId,
                    requester,
                    path,
                    uri,
                    accessType,
                    toolCall,
                    fallback,
                ),
            );
            validatedDecision = true;
        } catch (error) {
            choice = deniedChoice(
                uri,
                accessType,
                `LLM policy approval failed closed: ${errorMessage(error)}`,
            );
        }

        const policy = policyFromChoice(choice);
        if (
            validatedDecision
            && this.isActivePrincipalPath(path)
            && this.isUnchangedPrincipalPath(pathSnapshot)
            && this.isUnchangedFallback(fallback)
            && this.defaultResponses[fallback.area] === PolicyFallbackResponse.ask_llm
        ) {
            if (choice.lifetime === PolicyLifetime.SESSION) {
                for (const principal of path) this.addPrincipalPolicies(principal, [policy]);
            } else {
                oncePolicies.addPolicies([policy]);
            }
        }

        const result = PolicyResult.of({
            resolutionSource: validatedDecision
                ? PolicyResolutionSource.NEW_DEFAULT_LLM_DECISION
                : PolicyResolutionSource.SYSTEM,
            evaluatedUri: uri,
            evaluatedAccessType: accessType,
            matchedPattern: resolveUri(accessType, choice.uri),
            matchedLifetime: choice.lifetime,
            matchedStatus: choice.status,
            matchedReason: choice.reason,
        });
        if (request) {
            this.auditStructuredApproval(
                request,
                choice,
                result,
                validatedDecision ? "DECIDED" : "FAILED_CLOSED",
            );
        }
        return result;
    }

    private principalPathSnapshot(path: PolicyPrincipal[]): PrincipalPathSnapshot {
        return {
            path,
            policyRevisions: path.map((principal) => principal.policyRevision),
            contextRevisions: path.map((principal) => principal.contextRevision),
        };
    }

    private isActiveAuthorityPath(source: AncestorAuthority): boolean {
        return source.path.at(-1) === source.authorityPrincipal
            && this.isActivePrincipalPath(source.path);
    }

    private isUnchangedAuthorityPath(source: AncestorAuthority): boolean {
        return this.isUnchangedPrincipalPath(source)
            && (!source.fallback || this.isUnchangedFallback(source.fallback));
    }

    private fallbackSnapshot(accessType: PolicyAccessType): FallbackSnapshot {
        const area = policyAreaForAccessType(accessType);
        return {area, revision: this.fallbackRevisions[area]};
    }

    private isUnchangedFallback(snapshot: FallbackSnapshot): boolean {
        return this.fallbackRevisions[snapshot.area] === snapshot.revision;
    }

    private isUnchangedPrincipalPath(snapshot: PrincipalPathSnapshot): boolean {
        return snapshot.path.every((principal, index) => (
            principal.policyRevision === snapshot.policyRevisions[index]
            && principal.contextRevision === snapshot.contextRevisions[index]
        ));
    }

    private isActivePrincipalPath(path: PolicyPrincipal[]): boolean {
        for (let index = 0; index < path.length; index++) {
            const principal = path[index]!;
            if (this.principals.get(principal.agentIdentifier) !== principal) return false;
            const parent = path[index + 1];
            if (parent && principal.parentAgentIdentifier !== parent.agentIdentifier) return false;
        }
        return true;
    }

    private agentApprovalRequest(
        requestId: string,
        requester: PolicyPrincipal,
        source: AncestorAuthority,
        uri: string,
        accessType: PolicyAccessType,
        toolCall: PolicyToolCallContext,
    ): AgentPolicyApprovalRequest {
        const sourceScope = resolveUri(accessType, source.authority.matchedPattern);
        const allowedScopes = this.allowedApprovalScopes(uri, accessType, sourceScope);
        if (allowedScopes.length === 0) {
            throw new Error("The approving agent's policy does not cover any valid request scope");
        }
        return {
            ...this.policyRequestContext(requestId, requester, source.path, toolCall),
            reviewSource: PolicyApprovalReviewSource.ANCESTOR_AUTHORITY,
            approvingAgentIdentifier: source.authorityPrincipal.agentIdentifier,
            uri,
            accessType,
            authority: source.authority,
            allowedScopes,
            allowedLifetimes: allowedAgentLifetimes(source.authority.matchedLifetime),
        };
    }

    private llmFallbackApprovalRequest(
        requestId: string,
        requester: PolicyPrincipal,
        path: PolicyPrincipal[],
        uri: string,
        accessType: PolicyAccessType,
        toolCall: PolicyToolCallContext,
        fallback: FallbackSnapshot,
    ): AgentPolicyApprovalRequest {
        const sourceScope = fallbackScope(accessType);
        const allowedScopes = this.allowedApprovalScopes(uri, accessType, sourceScope);
        if (allowedScopes.length === 0) {
            throw new Error("The ask_llm policy default did not produce a valid request scope");
        }
        return {
            ...this.policyRequestContext(requestId, requester, path, toolCall),
            reviewSource: PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM,
            approvingAgentIdentifier: this.rootAgentIdentifier,
            policyArea: fallback.area,
            fallbackRevision: fallback.revision,
            uri,
            accessType,
            allowedScopes,
            allowedLifetimes: [PolicyLifetime.ONCE, PolicyLifetime.SESSION],
        };
    }

    private allowedApprovalScopes(
        uri: string,
        accessType: PolicyAccessType,
        sourceScope: string,
    ): string[] {
        const hierarchy = policyScopeHierarchy(uri, accessType, MAX_AGENT_POLICY_SCOPES);
        if (
            sourceScope !== UNIVERSAL_NETWORK_POLICY_PATTERN
            && !hierarchy.includes(sourceScope)
        ) {
            hierarchy.push(sourceScope);
        }
        return boundedPolicyScopes(
            hierarchy
                .filter((scope) => policyScopeCovers(accessType, sourceScope, scope))
                .map((scope) => resolveUri(accessType, scope)),
            sourceScope === UNIVERSAL_NETWORK_POLICY_PATTERN ? undefined : sourceScope,
        );
    }

    private policyRequestContext(
        requestId: string,
        requester: PolicyPrincipal,
        path: PolicyPrincipal[],
        toolCall: PolicyToolCallContext,
    ): PolicyApprovalRequestContext {
        return {
            requestId,
            requestingAgentIdentifier: requester.agentIdentifier,
            ancestry: path.slice().reverse().map((principal) => ({
                agentIdentifier: principal.agentIdentifier,
                role: principal.context.role,
                task: principal.context.task,
            })),
            toolCall: {...toolCall},
        };
    }

    private auditStructuredApproval(
        request: AgentPolicyApprovalRequest,
        choice: PolicyChoice,
        result: PolicyResult,
        outcome: PolicyApprovalAuditOutcome,
    ): void {
        const authority: PolicyApprovalAuditRecord["authority"] =
            request.reviewSource === PolicyApprovalReviewSource.ANCESTOR_AUTHORITY
                ? {
                    kind: "ANCESTOR_AUTHORITY",
                    scope: request.authority.matchedPattern,
                    lifetime: request.authority.matchedLifetime,
                    status: request.authority.matchedStatus,
                    reason: request.authority.matchedReason,
                    resolutionSource: request.authority.resolutionSource,
                }
                : {
                    kind: "POLICY_DEFAULT_ASK_LLM",
                    policyArea: request.policyArea,
                    fallbackRevision: request.fallbackRevision,
                };
        this.appendApprovalAudit({
            version: 1,
            timestamp: new Date().toISOString(),
            sessionIdentifier: this.rootAgentIdentifier,
            requestId: request.requestId,
            route: request.reviewSource,
            outcome,
            requester: {
                agentIdentifier: request.requestingAgentIdentifier,
                ancestry: request.ancestry.map((agent) => ({...agent})),
            },
            routingOwner: request.approvingAgentIdentifier,
            operation: {
                target: request.uri,
                accessType: request.accessType,
                toolCall: {...request.toolCall},
            },
            authority,
            decision: auditDecision(choice),
            result: auditResult(result),
        });
    }

    private auditUserApproval(
        context: PolicyApprovalRequestContext,
        uri: string,
        accessType: PolicyAccessType,
        choice: PolicyChoice,
        result: PolicyResult,
        outcome: PolicyApprovalAuditOutcome,
    ): void {
        this.appendApprovalAudit({
            version: 1,
            timestamp: new Date().toISOString(),
            sessionIdentifier: this.rootAgentIdentifier,
            requestId: context.requestId,
            route: "USER",
            outcome,
            requester: {
                agentIdentifier: context.requestingAgentIdentifier,
                ancestry: context.ancestry.map((agent) => ({...agent})),
            },
            routingOwner: "user",
            operation: {
                target: uri,
                accessType,
                toolCall: {...context.toolCall},
            },
            decision: auditDecision(choice),
            result: auditResult(result),
        });
    }

    private appendApprovalAudit(record: PolicyApprovalAuditRecord): void {
        try {
            this.approvalAudit?.append(boundedPolicyApprovalAuditRecord(record));
        } catch {
            // Approval logging is best-effort and must not change the policy decision.
        }
    }

    private validatedAgentChoice(
        choice: PolicyChoice,
        request: AgentPolicyApprovalRequest,
    ): PolicyChoice {
        if (choice.accessType !== request.accessType) {
            throw new Error("the access type did not match the pending operation");
        }
        if (choice.status !== PolicyResponse.ALLOWED && choice.status !== PolicyResponse.DENIED) {
            throw new Error("the response was unsupported");
        }
        const scope = resolveUri(request.accessType, choice.uri);
        if (!request.allowedScopes.includes(scope)) {
            throw new Error("the selected scope exceeded the approving agent's authority");
        }
        if (!request.allowedLifetimes.includes(choice.lifetime)) {
            throw new Error("the selected lifetime exceeded the approving agent's authority");
        }
        return {
            ...choice,
            uri: scope,
            reason: boundedText(choice.reason, 2_000) || "Agent policy approver supplied no reason.",
        };
    }

    private async askUser(
        requester: PolicyPrincipal,
        uri: string,
        accessType: PolicyAccessType,
        oncePolicies: PolicyEngine,
        toolCall: PolicyToolCallContext,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        const path = this.pathToRoot(requester);
        const pathSnapshot = this.principalPathSnapshot(path);
        const fallback = this.fallbackSnapshot(accessType);
        const requestContext = this.policyRequestContext(
            crypto.randomUUID(),
            requester,
            path,
            toolCall,
        );
        const choice = await this.decisionFlow.askForPolicy(uri, accessType, signal, requestContext);
        if (
            signal?.aborted
            || this.closing
            || !this.isUnchangedFallback(fallback)
            || this.defaultResponses[fallback.area] !== PolicyFallbackResponse.ask_user
        ) {
            const result = failedClosedResult(uri, accessType, "User policy approval is no longer active.");
            this.auditUserApproval(requestContext, uri, accessType, choice, result, "FAILED_CLOSED");
            return result;
        }
        const resolvedWhilePending = requester.policies.evaluate(uri, accessType)
            ?? oncePolicies.evaluate(uri, accessType);
        if (resolvedWhilePending) {
            this.auditUserApproval(
                requestContext,
                uri,
                accessType,
                choice,
                resolvedWhilePending,
                "SUPERSEDED",
            );
            return resolvedWhilePending;
        }
        if (
            !this.isActivePrincipalPath(path)
            || !this.isUnchangedPrincipalPath(pathSnapshot)
        ) {
            const result = failedClosedResult(uri, accessType, "User policy approval is no longer active.");
            this.auditUserApproval(requestContext, uri, accessType, choice, result, "FAILED_CLOSED");
            return result;
        }
        const policy = policyFromChoice(choice);
        const root = this.requirePrincipal(this.rootAgentIdentifier);
        const persisted = isPersistedLifetime(choice.lifetime);

        if (persisted) {
            this.database.upsertPolicies([policy]);
            this.addPrincipalPolicies(root, [policy]);
        } else if (choice.lifetime === PolicyLifetime.SESSION) {
            this.addPrincipalPolicies(root, [policy]);
        } else {
            oncePolicies.addPolicies([policy]);
        }

        let effectiveLifetime = choice.lifetime;
        if (requester.agentIdentifier !== this.rootAgentIdentifier && choice.lifetime !== PolicyLifetime.ONCE) {
            const derived = sessionPolicy(policy);
            for (const principal of path.slice(0, -1)) {
                this.addPrincipalPolicies(principal, [derived]);
            }
            effectiveLifetime = PolicyLifetime.SESSION;
        }

        const result = PolicyResult.of({
            resolutionSource: PolicyResolutionSource.NEW_USER_DECISION,
            evaluatedUri: uri,
            evaluatedAccessType: accessType,
            matchedPattern: resolveUri(accessType, choice.uri),
            matchedLifetime: effectiveLifetime,
            matchedStatus: choice.status,
            matchedReason: choice.reason,
        });
        this.auditUserApproval(requestContext, uri, accessType, choice, result, "DECIDED");
        return result;
    }

    private pathToRoot(principal: PolicyPrincipal): PolicyPrincipal[] {
        const path = [principal];
        let current = principal;
        while (current.parentAgentIdentifier) {
            current = this.requirePrincipal(current.parentAgentIdentifier);
            path.push(current);
        }
        return path;
    }

    private addPrincipalPolicies(principal: PolicyPrincipal, policies: Policy[]): void {
        principal.policies.addPolicies(policies);
        principal.policyRevision++;
    }

    private inheritedPolicySnapshot(
        parent: PolicyPrincipal,
        inheritedAreas: readonly PolicyArea[],
    ): Policy[] {
        const accessTypes = new Set(
            [...new Set(inheritedAreas)].flatMap((area) => policyAreaAccessTypes(area)),
        );
        if (accessTypes.size === 0) return [];

        return this.effectivePolicies(parent)
            .map((policy) => ({
                pattern: policy.pattern,
                info: Object.fromEntries(
                    Object.entries(policy.info)
                        .filter(([, status]) => status && accessTypes.has(status.accessType))
                        .map(([accessType, status]) => [
                            accessType,
                            status ? {...status, lifetime: PolicyLifetime.SESSION} : status,
                        ]),
                ),
            }))
            .filter((policy) => Object.keys(policy.info).length > 0);
    }

    private effectivePolicies(principal: PolicyPrincipal): Policy[] {
        if (principal.agentIdentifier !== this.rootAgentIdentifier) return principal.policies.allPolicies();
        const effective = new PolicyEngine(this.rootFallbackPolicies.allPolicies());
        effective.addPolicies(principal.policies.allPolicies());
        return effective.allPolicies();
    }

    private requirePrincipal(agentIdentifier: string): PolicyPrincipal {
        const principal = this.principals.get(agentIdentifier);
        if (!principal) throw new Error(`No agent registered with this identifier: ${agentIdentifier}`);
        return principal;
    }

    private setFallbacks(): void {
        for (const [area, response] of Object.entries(this.defaultResponses)) {
            this.setFallback(area as PolicyArea, response);
        }
    }

    private setFallback(area: PolicyArea, response: PolicyFallbackResponse): void {
        const accessTypes = policyAreaAccessTypes(area);
        const pattern = fallbackScope(accessTypes[0]!);
        const status = policyStatus(response);
        if (!status) {
            this.rootFallbackPolicies.removePolicies([{uri: pattern, accessTypes: [...accessTypes]}]);
            return;
        }

        const policy: Policy = {pattern, info: {}};
        for (const accessType of accessTypes) {
            policy.info[accessType] = {
                accessType,
                lifetime: PolicyLifetime.SESSION,
                status,
                reason: "Automated fallback",
            } satisfies PolicyStatus;
        }
        this.rootFallbackPolicies.addPolicies([policy]);
    }
}

function policyFromChoice(choice: {
    uri: string;
    accessType: PolicyAccessType;
    lifetime: PolicyLifetime;
    status: PolicyResponse;
    reason: string;
}): Policy {
    return {
        pattern: choice.uri,
        info: {
            [choice.accessType]: PolicyEngine.createStatus(
                choice.accessType,
                choice.lifetime,
                choice.status,
                choice.reason,
            ),
        },
    };
}

function sessionPolicy(policy: Policy): Policy {
    return {
        pattern: policy.pattern,
        info: Object.fromEntries(
            Object.entries(policy.info).map(([accessType, status]) => [
                accessType,
                status ? {...status, lifetime: PolicyLifetime.SESSION} : status,
            ]),
        ),
    };
}

function auditDecision(choice: PolicyChoice): PolicyApprovalAuditRecord["decision"] {
    return {
        scope: choice.uri,
        lifetime: choice.lifetime,
        status: choice.status,
        reason: choice.reason,
    };
}

function auditResult(result: PolicyResult): PolicyApprovalAuditRecord["result"] {
    return {
        scope: result.matchedPattern,
        lifetime: result.matchedLifetime,
        status: result.matchedStatus,
        reason: result.matchedReason,
        resolutionSource: result.resolutionSource,
    };
}

function failedClosedResult(
    uri: string,
    accessType: PolicyAccessType,
    reason: string,
): PolicyResult {
    return PolicyResult.of({
        resolutionSource: PolicyResolutionSource.SYSTEM,
        evaluatedUri: uri,
        evaluatedAccessType: accessType,
        matchedPattern: uri,
        matchedLifetime: PolicyLifetime.ONCE,
        matchedStatus: PolicyResponse.DENIED,
        matchedReason: reason,
    });
}

function deniedChoice(
    uri: string,
    accessType: PolicyAccessType,
    reason: string,
): PolicyChoice {
    return {
        uri,
        accessType,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.DENIED,
        reason,
    };
}

function boundedPolicyScopes(scopes: string[], requiredScope?: string): string[] {
    const selected: string[] = [];
    const requiredChars = requiredScope?.length ?? 0;
    let selectedChars = 0;
    for (const scope of scopes) {
        if (scope === requiredScope || selected.includes(scope)) continue;
        if (selected.length >= MAX_AGENT_POLICY_SCOPES - (requiredScope ? 1 : 0)) break;
        if (selectedChars + scope.length + requiredChars > MAX_AGENT_POLICY_SCOPE_CHARS) continue;
        selected.push(scope);
        selectedChars += scope.length;
    }
    if (requiredScope && !selected.includes(requiredScope)) selected.push(requiredScope);
    return selected;
}

function allowedAgentLifetimes(source: PolicyLifetime): PolicyLifetime[] {
    return source === PolicyLifetime.ONCE
        ? [PolicyLifetime.ONCE]
        : [PolicyLifetime.ONCE, PolicyLifetime.SESSION];
}

function normalizedPrincipalContext(context: PolicyPrincipalContext): PolicyPrincipalContext {
    return {
        role: boundedText(context.role, 120) || "Agent",
        task: boundedText(context.task, 4_000) || "Unspecified work",
    };
}

function normalizedToolCallContext(context: PolicyToolCallContext): PolicyToolCallContext {
    return {
        toolCallId: boundedOptionalText(context.toolCallId, 500),
        toolName: boundedOptionalText(context.toolName, 120),
        command: boundedOptionalText(context.command, 8_000),
        purpose: boundedOptionalText(context.purpose, 500),
    };
}

function boundedOptionalText(value: string | undefined, maximum: number): string | undefined {
    if (value === undefined) return undefined;
    return boundedText(value, maximum) || undefined;
}

function boundedText(value: unknown, maximum: number): string {
    if (typeof value !== "string") return "";
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function initialFallbackRevisions(): Record<PolicyArea, number> {
    return Object.fromEntries(POLICY_AREAS.map((area) => [area, 0])) as Record<PolicyArea, number>;
}

function fallbackScope(accessType: PolicyAccessType): string {
    return accessType === PolicyAccessType.FS_READ || accessType === PolicyAccessType.FS_WRITE
        ? "/"
        : UNIVERSAL_NETWORK_POLICY_PATTERN;
}

function policyStatus(response: PolicyFallbackResponse): PolicyResponse | null {
    switch (response) {
        case PolicyFallbackResponse.allow:
            return PolicyResponse.ALLOWED;
        case PolicyFallbackResponse.deny:
            return PolicyResponse.DENIED;
        default:
            return null;
    }
}

function systemFallbackResult(result: PolicyResult): PolicyResult {
    return PolicyResult.of({
        evaluatedUri: result.evaluatedUri,
        evaluatedAccessType: result.evaluatedAccessType,
        matchedPattern: result.matchedPattern,
        matchedLifetime: result.matchedLifetime,
        matchedStatus: result.matchedStatus,
        matchedReason: result.matchedReason,
        resolutionSource: PolicyResolutionSource.SYSTEM,
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default PolicyRuntime;
