import {policyScopeCovers} from "./PolicyScope.js";
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
    resolveUri,
} from "./types";

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
        const policy = this.findPolicy(evaluatedUri, accessType);
        if (!policy) return null;

        const status = policy.info[accessType] as PolicyStatus;
        return PolicyResult.of({
            evaluatedUri,
            evaluatedAccessType: accessType,
            matchedPattern: policy.pattern,
            matchedLifetime: status.lifetime,
            matchedStatus: status.status,
            matchedReason: status.reason,
            resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
        });
    }

    addPolicies(policies: Policy[]): void {
        for (const rawPolicy of policies) {
            const policy = this.standardizePolicy(rawPolicy);
            const stored = this.policies.find((candidate) => candidate.pattern === policy.pattern);

            if (!stored) {
                this.policies.push(policy);
                continue;
            }

            for (const incoming of Object.values(policy.info)) {
                if (!incoming) continue;
                stored.info[incoming.accessType] = {...incoming};
            }
        }
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

    private findPolicy(evaluatedPath: string, accessType: PolicyAccessType): Policy | undefined {
        return this.policies
            .filter((policy) => policy.info[accessType] && this.isUnderPolicy(accessType, evaluatedPath, policy.pattern))
            .sort((left, right) => right.pattern.length - left.pattern.length)[0];
    }

    private isUnderPolicy(
        accessType: PolicyAccessType,
        evaluatedUri: string,
        pattern: string,
    ): boolean {
        return policyScopeCovers(accessType, pattern, evaluatedUri);
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
