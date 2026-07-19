import {
    FsAccessType,
    isPersistedLifetime,
    PathPolicy,
    PathPolicyDeleteRequest,
    PathPolicyResult,
    PathPolicyStatus
} from "./types";
import {PolicyLifetime, PolicyResolutionSource, PolicyStatus} from "../types";
import path from "node:path";
import fs from "node:fs";

export type PathPolicyLogicOptions = {
    policies?: PathPolicy[];
};

export class PathPolicyLogic {
    private readonly policies: PathPolicy[] = [];

    constructor(options: PathPolicyLogicOptions = {}) {
        if (options.policies) this.addPolicies(options.policies);
    }

    evaluate(
        inputPath: string,
        accessType: FsAccessType,
        denyByDefault = false
    ): PathPolicyResult | null {
        const evaluatedPath = PathPolicyLogic.resolvePhysicalPath(inputPath);
        const policy = this.findPolicy(evaluatedPath, accessType);

        if (!policy) {
            if (!denyByDefault) return null;
            return {
                evaluatedPath,
                evaluatedAccessType: accessType,
                matchedPattern: "(none)",
                matchedLifetime: PolicyLifetime.LOCAL,
                matchedStatus: PolicyStatus.DENIED,
                matchedReason: "No matching policy found. denied by default, you cannot access this",
                resolutionSource: PolicyResolutionSource.SYSTEM,
            };
        }

        const status = policy.info[accessType] as PathPolicyStatus;
        return {
            evaluatedPath,
            evaluatedAccessType: accessType,
            matchedPattern: policy.path,
            matchedLifetime: status.lifetime,
            matchedStatus: status.status,
            matchedReason: status.reason,
            resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
        };
    }

    policyPathFor(inputPath: string): string {
        return PathPolicyLogic.resolvePhysicalPath(inputPath);
    }

    addPolicies(policies: PathPolicy[]): void {
        for (const rawPolicy of policies) {
            const policy = this.standardizePolicy(rawPolicy);
            const stored = this.policies.find((it) => it.path === policy.path);

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

    removePolicies(requests: PathPolicyDeleteRequest[]): void {
        for (const rawRequest of requests) {
            const request = this.standardizeDeleteRequest(rawRequest);
            const stored = this.policies.find((it) => it.path === request.path);
            if (!stored) continue;

            for (const accessType of request.accessTypes) delete stored.info[accessType];
            if (Object.keys(stored.info).length === 0) this.policies.splice(this.policies.indexOf(stored), 1);
        }
    }

    policiesSnapshot(): PathPolicy[] {
        return this.policies.map((policy) => ({
            path: policy.path,
            info: Object.fromEntries(
                Object.entries(policy.info).map(([accessType, status]) => [accessType, status ? {...status} : status]),
            ) satisfies PathPolicy["info"],
        } satisfies PathPolicy));
    }

    persistedPolicies(): PathPolicy[] {
        return this.policies
            .map((policy) => ({
                path: policy.path,
                info: Object.fromEntries(
                    Object.entries(policy.info).filter(([, status]) => status && isPersistedLifetime(status.lifetime)),
                ) as PathPolicy["info"],
            }))
            .filter((policy) => Object.keys(policy.info).length > 0);
    }

    toDenyReasonOrNull(result: PathPolicyResult): string | null {
        if (result.matchedStatus === PolicyStatus.ALLOWED) return null;
        return [
            "ACCESS DENIED",
            `The path '${result.evaluatedPath}' had an attempted access of type ${result.evaluatedAccessType}`,
            `The policy for path (and any subfiles without own policies) '${result.matchedPattern}' was triggered`,
            `Policy reason for why this was denied: ${result.matchedReason}`,
            `Policy resolution source: ${result.resolutionSource}`,
            `Policy lifetime: ${result.matchedLifetime}`,
            `This is not an OS err, This is a wakeup-call; rethink what you're attempting, is this what your task requires?`,
            `If this is truly what the user, or your super-agent asked for, report back to them and ask for the appropriate policies`
        ].join("\n");
    }

    private findPolicy(evaluatedPath: string, accessType: FsAccessType): PathPolicy | undefined {
        return this.policies
            .filter((policy) => policy.info[accessType] && this.isSameOrChildPath(evaluatedPath, policy.path))
            .sort((left, right) => right.path.localeCompare(left.path))[0];
    }

    private standardizePolicy(policy: PathPolicy): PathPolicy {
        return {
            path: PathPolicyLogic.resolvePhysicalPath(policy.path),
            info: Object.fromEntries(
                Object.entries(policy.info).map(([accessType, status]) => [accessType, status ? {...status} : status]),
            ) as PathPolicy["info"],
        };
    }

    private standardizeDeleteRequest(request: PathPolicyDeleteRequest): PathPolicyDeleteRequest {
        return {
            path: PathPolicyLogic.resolvePhysicalPath(request.path),
            accessTypes: [...request.accessTypes],
        };
    }

    private isSameOrChildPath(candidate: string, parent: string): boolean {
        const relative = path.relative(parent, candidate);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    }

    private static looksLikeWindowsPath(value: string): boolean {
        return value.length >= 2 && value[1] === ":";
    }


    private static resolvePhysicalPath(input: string): string {
        const normalized = PathPolicyLogic.stripTrailingPathSeparators(path.resolve(input).normalize());
        const existingAncestor = PathPolicyLogic.nearestExistingAncestor(normalized);
        if (!existingAncestor) return normalized;

        try {
            const physicalAncestor = PathPolicyLogic.stripTrailingPathSeparators(fs.realpathSync.native(existingAncestor));
            const suffix = path.relative(existingAncestor, normalized);
            return suffix
                ? PathPolicyLogic.stripTrailingPathSeparators(path.join(physicalAncestor, suffix).normalize())
                : physicalAncestor;
        } catch {
            return normalized;
        }
    }

    private static stripTrailingPathSeparators(
        input: string,
        pathParser: Pick<typeof path, "parse"> = path,
    ): string {
        const root = pathParser.parse(input).root;
        const stripped = input.replace(/[\\/]+$/g, "");
        return stripped.length < root.length ? root : stripped;
    }

    private static nearestExistingAncestor(input: string): string | null {
        let current = input;
        while (true) {
            if (fs.existsSync(current)) return current;
            const parent = path.dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    }

    static createPolicy(
        policyPath: string,
        status: PolicyStatus,
        lifetime: PolicyLifetime,
        reason: string,
    ): PathPolicy {
        return {
            path: policyPath,
            info: {
                [FsAccessType.READ]: PathPolicyLogic.createStatus(FsAccessType.READ, lifetime, status, reason),
                [FsAccessType.WRITE]: PathPolicyLogic.createStatus(FsAccessType.WRITE, lifetime, status, reason),
                [FsAccessType.DELETE]: PathPolicyLogic.createStatus(FsAccessType.DELETE, lifetime, status, reason),
            },
        };
    }

    static createStatus(
        accessType: FsAccessType,
        lifetime: PolicyLifetime,
        status: PolicyStatus,
        reason: string,
    ): PathPolicyStatus {
        return {accessType, lifetime, status, reason};
    }

}
