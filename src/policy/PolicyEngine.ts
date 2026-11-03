import {policyScopeCovers, resolveUri} from "./PolicyScope.js";
import {
    isPersistedLifetime,
    type Policy,
    PolicyAccessType,
    type PolicyDeleteRequest,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
    type PolicyStatus,
} from "./types";

/** Evaluate stored authority against an already-resolved target without resolving stored paths again. */
export function evaluateStoredPolicies(
    policies: readonly Policy[],
    evaluatedUri: string,
    accessType: PolicyAccessType,
    resolutionSource: PolicyResolutionSource,
): PolicyResult | null {
    let match: {pattern: string; status: PolicyStatus} | undefined;
    for (const policy of policies) {
        const status = policy.info[accessType];
        if (!status || !policyScopeCovers(accessType, policy.pattern, evaluatedUri)) continue;
        if (!match || policy.pattern.length > match.pattern.length) {
            match = {pattern: policy.pattern, status};
        }
    }
    if (!match) return null;
    return PolicyResult.of({
        evaluatedUri,
        evaluatedAccessType: accessType,
        matchedPattern: match.pattern,
        matchedLifetime: match.status.lifetime,
        matchedStatus: match.status.status,
        matchedReason: match.status.reason,
        resolutionSource,
    });
}

export class PolicyEngine {
    private readonly policies: Policy[] = [];

    constructor(policies: Policy[] = []) {
        this.addPolicies(policies);
    }

    evaluate(
        inputUri: string,
        accessType: PolicyAccessType,
    ): PolicyResult | null {
        const evaluatedUri = resolveUri(accessType, inputUri);
        return evaluateStoredPolicies(
            this.policies, evaluatedUri, accessType, PolicyResolutionSource.EXISTING_USER_POLICY,
        );
    }

    addPolicies(policies: Policy[]): void {
        for (const policy of policies) this.mergePolicy(this.standardizePolicy(policy));
    }

    /** Merge already-resolved snapshots without retargeting their stored filesystem scopes. */
    addStoredPolicies(policies: readonly Policy[]): void {
        for (const policy of policies) this.mergePolicy(structuredClone(policy));
    }

    removePolicies(requests: PolicyDeleteRequest[]): void {
        for (const rawRequest of requests) {
            const request = this.standardizeDeleteRequest(rawRequest);
            const stored = this.policies.find((candidate) => candidate.pattern === request.uri);
            if (!stored) continue;
            for (const accessType of request.accessTypes) delete stored.info[accessType];
            if (Object.keys(stored.info).length === 0) this.policies.splice(this.policies.indexOf(stored), 1);
        }
    }

    allPolicies(): Policy[] {
        return structuredClone(this.policies);
    }

    persistedPolicies(): Policy[] {
        return this.policies
            .map((policy) => ({
                pattern: policy.pattern,
                info: Object.fromEntries(
                    Object.entries(policy.info).filter(([, status]) => status && isPersistedLifetime(status.lifetime)),
                ),
            }))
            .filter((policy) => Object.keys(policy.info).length > 0);
    }

    private mergePolicy(policy: Policy): void {
        const stored = this.policies.find((candidate) => candidate.pattern === policy.pattern);
        if (!stored) {
            this.policies.push(policy);
            return;
        }
        for (const incoming of Object.values(policy.info)) {
            if (!incoming) continue;
            stored.info[incoming.accessType] = {...incoming};
        }
    }

    private standardizePolicy(policy: Policy): Policy {
        const accessType = Object.values(policy.info).find((status) => status)?.accessType;
        return {
            pattern: accessType ? resolveUri(accessType, policy.pattern) : policy.pattern,
            info: structuredClone(policy.info),
        };
    }

    private standardizeDeleteRequest(request: PolicyDeleteRequest): PolicyDeleteRequest {
        const accessType = request.accessTypes[0];
        return {
            uri: accessType ? resolveUri(accessType, request.uri) : request.uri,
            accessTypes: [...request.accessTypes],
        };
    }

    static createStatus(
        accessType: PolicyAccessType,
        lifetime: PolicyLifetime,
        status: PolicyResponse,
        reason: string,
    ): PolicyStatus {
        return {accessType, lifetime, status, reason};
    }
}
