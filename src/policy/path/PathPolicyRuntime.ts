import {PathPolicyLogic} from "./PathPolicyLogic.js";
import type {PathPolicy, PathPolicyResult} from "./types.js";
import {FsAccessType} from "./types.js";
import {PolicyLifetime, PolicyResolutionSource, PolicyStatus} from "../types";

export type PathPolicyChoice = {
    path: string;
    accessType: FsAccessType;
    lifetime: PolicyLifetime;
    status: PolicyStatus;
    reason: string;
};

export type PathPolicyToolCall = {
    evaluate(path: string, accessType: FsAccessType): PathPolicyResult | null;
    policyPathFor(path: string): string;
    record(choice: PathPolicyChoice): PathPolicyResult;
};

export type PathPolicyPersistence = {
    loadPolicies(): PathPolicy[];
    replacePolicies(policies: PathPolicy[]): void;
};

export class PathPolicyRuntime {
    private sessionPolicies: PathPolicyLogic;

    constructor(private readonly persistence: PathPolicyPersistence) {
        this.sessionPolicies = new PathPolicyLogic({policies: persistence.loadPolicies()});
    }

    beginToolCall(): PathPolicyToolCall {
        const oncePolicies = new PathPolicyLogic();
        return {
            evaluate: (path, accessType) => this.evaluate(oncePolicies, path, accessType),
            policyPathFor: (path) => this.sessionPolicies.policyPathFor(path),
            record: (choice) => this.record(oncePolicies, choice),
        };
    }

    private evaluate(
        oncePolicies: PathPolicyLogic,
        inputPath: string,
        accessType: FsAccessType,
    ): PathPolicyResult | null {
        const effectivePolicies = new PathPolicyLogic({policies: this.sessionPolicies.policiesSnapshot()});
        effectivePolicies.addPolicies(oncePolicies.policiesSnapshot());
        return effectivePolicies.evaluate(inputPath, accessType);
    }

    private record(oncePolicies: PathPolicyLogic, choice: PathPolicyChoice): PathPolicyResult {
        const policy = {
            path: choice.path,
            info: {
                [choice.accessType]: PathPolicyLogic.createStatus(
                    choice.accessType,
                    choice.lifetime,
                    choice.status,
                    choice.reason,
                ),
            },
        } satisfies PathPolicy;

        if (choice.lifetime === PolicyLifetime.ONCE) {
            oncePolicies.addPolicies([policy]);
        } else {
            const updatedSessionPolicies = new PathPolicyLogic({policies: this.sessionPolicies.policiesSnapshot()});
            updatedSessionPolicies.addPolicies([policy]);
            this.persistence.replacePolicies(updatedSessionPolicies.persistedPolicies());
            this.sessionPolicies = updatedSessionPolicies;
        }

        const result = this.evaluate(oncePolicies, choice.path, choice.accessType);
        if (!result) throw new Error("Recorded path policy could not be evaluated");
        return {...result, resolutionSource: PolicyResolutionSource.NEW_USER_DECISION};
    }
}
