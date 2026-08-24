import {PolicyEngine} from "./PolicyEngine";
import {
    isPersistedLifetime,
    type Policy,
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
    type PolicyStatus,
    policyAreaAccessTypes,
} from "./types";
import type {PolicyDaoInterface} from "../storage/PolicyDao";
import {PolicyDecisionFlow} from "./PolicyDecisionFlow";
import {initialPolicyDefaults, type PolicyDefaultJsonStorageInterface, type ResponseDefaults} from "./defaults.js";
import {UNIVERSAL_NETWORK_POLICY_PATTERN} from "./network/ParsedUri.js";

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
    ): void;

    removePolicyPrincipal(agentIdentifier: string): void;
}

type PolicyPrincipal = {
    agentIdentifier: string;
    parentAgentIdentifier?: string;
    children: Set<string>;
    policies: PolicyEngine;
};

export class PolicyRuntime implements PolicyPrincipalRegistry {
    private readonly principals = new Map<string, PolicyPrincipal>();
    private readonly rootFallbackPolicies = new PolicyEngine();
    private readonly rootAgentIdentifier: string;
    readonly defaultResponses: ResponseDefaults;

    constructor(
        agentIdentifier: string,
        private readonly database: PolicyDaoInterface,
        private readonly decisionFlow: PolicyDecisionFlow,
        private readonly defaultsStore?: PolicyDefaultJsonStorageInterface,
    ) {
        this.rootAgentIdentifier = agentIdentifier;
        this.principals.set(agentIdentifier, {
            agentIdentifier,
            children: new Set(),
            policies: new PolicyEngine(database.loadPolicies()),
        });
        this.defaultResponses = {...initialPolicyDefaults, ...defaultsStore?.load()};
        this.setFallbacks();
    }

    async once(
        agentIdentifier: string,
        path: string,
        accessType: PolicyAccessType,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        return this.beginToolCall(agentIdentifier)(path, accessType, signal);
    }

    beginToolCall(agentIdentifier: string): ToolCallPathPolicyEvaluator {
        const oncePolicies = new PolicyEngine();
        const principal = this.requirePrincipal(agentIdentifier);
        return (path, accessType, signal) => this.evaluate(
            principal,
            path,
            accessType,
            oncePolicies,
            signal,
        );
    }

    setDefaultResponse(area: PolicyArea, response: PolicyFallbackResponse): void {
        this.defaultResponses[area] = response;
        this.setFallback(area, response);
    }

    saveDefaultResponses(): void {
        if (!this.defaultsStore) throw new Error("Policy defaults persistence is not configured.");
        this.defaultsStore.save(this.defaultResponses);
    }

    resetDefaultResponses(): void {
        Object.assign(this.defaultResponses, this.defaultsStore?.load() ?? initialPolicyDefaults);
        this.setFallbacks();
    }

    registerPolicyPrincipal(
        agentIdentifier: string,
        parentAgentIdentifier: string,
        inheritedAreas: readonly PolicyArea[],
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
        });
        parent.children.add(agentIdentifier);
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
        path: string,
        accessType: PolicyAccessType,
        oncePolicies: PolicyEngine,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        const local = principal.policies.evaluate(path, accessType);
        if (local) return local;

        if (principal.agentIdentifier === this.rootAgentIdentifier) {
            const fallback = this.rootFallbackPolicies.evaluate(path, accessType);
            if (fallback) return systemFallbackResult(fallback);
        }

        const once = oncePolicies.evaluate(path, accessType);
        if (once) return once;

        const choice = await this.decisionFlow.askForPolicy(path, accessType, signal);
        const policy = policyFromChoice(choice);

        const persisted = isPersistedLifetime(choice.lifetime);
        if (persisted) {
            this.database.upsertPolicies([policy]);
            this.requirePrincipal(this.rootAgentIdentifier).policies.addPolicies([policy]);
        }

        if (choice.lifetime === PolicyLifetime.ONCE) {
            oncePolicies.addPolicies([policy]);
        } else if (persisted) {
            if (principal.agentIdentifier !== this.rootAgentIdentifier) {
                principal.policies.addPolicies([sessionPolicy(policy)]);
            }
        } else {
            principal.policies.addPolicies([policy]);
        }

        return PolicyResult.of({
            resolutionSource: PolicyResolutionSource.NEW_USER_DECISION,
            evaluatedUri: path,
            evaluatedAccessType: accessType,
            matchedPattern: choice.uri,
            matchedLifetime: choice.lifetime,
            matchedStatus: choice.status,
            matchedReason: choice.reason,
        });
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
        const pattern = area.startsWith("fs_") ? "/" : UNIVERSAL_NETWORK_POLICY_PATTERN;
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

export default PolicyRuntime;
