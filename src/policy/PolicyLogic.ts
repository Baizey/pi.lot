import {
    isPersistedLifetime,
    Policy,
    PolicyAccessType,
    PolicyDeleteRequest,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
    PolicyStatus,
    resolveUri,
    ResponseDefaults,
    ResponseType
} from "./types";
import path from "node:path";
import {resolvePhysicalPath} from "./path/validation";
import {ParsedUri} from "./network/ParsedUri";

export type PathPolicyLogicOptions = {
    policies?: Policy[];
};

export const defaultPolicyAreas: ResponseDefaults = {
    fs_read: ResponseType.ask_user,
    fs_write: ResponseType.ask_user,
    web_read: ResponseType.ask_user,
    web_write: ResponseType.ask_user,
    web_extra: ResponseType.ask_user,
} as const

export class PolicyLogic {
    private readonly policies: Policy[] = [];

    constructor(options: PathPolicyLogicOptions = {}) {
        if (options.policies) this.addPolicies(options.policies);
    }

    evaluate(
        inputUri: string,
        accessType: PolicyAccessType,
        defaultResponses?: ResponseDefaults
    ): PolicyResult | null {
        const evaluatedUri = resolveUri(accessType, inputUri);
        const policy = this.findPolicy(evaluatedUri, accessType);

        if (!policy) {
            switch (this.findDefaultAction(accessType, defaultResponses)) {
                case ResponseType.ask_user:
                    return null
                case ResponseType.allow:
                    return PolicyResult.of({
                        evaluatedUri: evaluatedUri,
                        evaluatedAccessType: accessType,
                        matchedPattern: "(none)",
                        matchedLifetime: PolicyLifetime.ONCE,
                        matchedStatus: PolicyResponse.ALLOWED,
                        matchedReason: "No matching policy found. denied by default, you cannot access this",
                        resolutionSource: PolicyResolutionSource.SYSTEM,
                    })
                case ResponseType.deny:
                    return PolicyResult.of({
                        evaluatedUri: evaluatedUri,
                        evaluatedAccessType: accessType,
                        matchedPattern: "(none)",
                        matchedLifetime: PolicyLifetime.ONCE,
                        matchedStatus: PolicyResponse.DENIED,
                        matchedReason: "No matching policy found. denied by default, you cannot access this",
                        resolutionSource: PolicyResolutionSource.SYSTEM,
                    })
                case ResponseType.ask_llm:
                    throw new Error(`ask llm is not supported`)
            }
        }

        const status = policy.info[accessType] as PolicyStatus;
        return PolicyResult.of({
            evaluatedUri: evaluatedUri,
            evaluatedAccessType: accessType,
            matchedPattern: policy.pattern,
            matchedLifetime: status.lifetime,
            matchedStatus: status.status,
            matchedReason: status.reason,
            resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
        });
    }

    private findDefaultAction(accessType: PolicyAccessType, defaults?: ResponseDefaults) {
        defaults ??= defaultPolicyAreas;
        switch (accessType) {
            case PolicyAccessType.FS_READ:
                return defaults.fs_read
            case PolicyAccessType.FS_WRITE:
            case PolicyAccessType.FS_DELETE:
                return defaults.fs_write;
            case PolicyAccessType.HTTP_GET:
                return defaults.web_read;
            case PolicyAccessType.HTTP_ACCESS:
            case PolicyAccessType.HTTP_HEAD:
            case PolicyAccessType.HTTP_PATCH:
            case PolicyAccessType.HTTP_DELETE:
            case PolicyAccessType.HTTP_PUT:
            case PolicyAccessType.HTTP_OPTIONS:
            case PolicyAccessType.HTTP_POST:
                return defaults.web_write;
            default:
                return defaults.web_extra;
        }
    }

    addPolicies(policies: Policy[]): void {
        for (const rawPolicy of policies) {
            const policy = this.standardizePolicy(rawPolicy);
            const stored = this.policies.find((it) => it.pattern === policy.pattern);

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
            const stored = this.policies.find((it) => it.pattern === request.uri);
            if (!stored) continue;
            for (const accessType of request.accessTypes) delete stored.info[accessType];
            if (Object.keys(stored.info).length === 0) this.policies.splice(this.policies.indexOf(stored), 1);
        }
    }

    allPolicies(): Policy[] {
        return structuredClone(this.policies)
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
            .sort((left, right) => right.pattern.localeCompare(left.pattern))[0];
    }

    private isUnderPolicy(
        accessType: PolicyAccessType,
        evaluatedUri: string,
        pattern: string
    ): boolean {
        switch (accessType) {
            case PolicyAccessType.FS_READ:
            case PolicyAccessType.FS_WRITE:
            case PolicyAccessType.FS_DELETE:
                return this.isSameOrChildPath(evaluatedUri, pattern)
            default:
                return new ParsedUri(evaluatedUri).isSubdomainOf(pattern)
        }
    }

    private standardizePolicy(policy: Policy): Policy {
        return {
            pattern: resolvePhysicalPath(policy.pattern),
            info: policy.info,
        };
    }

    private standardizeDeleteRequest(request: PolicyDeleteRequest): PolicyDeleteRequest {
        return {
            uri: resolvePhysicalPath(request.uri),
            accessTypes: [...request.accessTypes],
        };
    }

    private isSameOrChildPath(candidate: string, parent: string): boolean {
        const relative = path.relative(parent, candidate);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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
