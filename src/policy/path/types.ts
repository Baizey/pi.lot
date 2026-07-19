import {PolicyLifetime, PolicyResolutionSource, PolicyStatus} from "../types";

export enum FsAccessType {
    READ = "READ",
    WRITE = "WRITE",
    DELETE = "DELETE",
}

export type PathPolicyStatus = {
    accessType: FsAccessType;
    lifetime: PolicyLifetime;
    status: PolicyStatus;
    reason: string;
};

export type PathPolicy = {
    path: string;
    info: Partial<Record<FsAccessType, PathPolicyStatus>>;
};

export type PathPolicyDeleteRequest = {
    path: string;
    accessTypes: FsAccessType[];
};

export type PathPolicySnapshot = {
    policies: PathPolicy[];
};

export type PathPolicyResult = {
    evaluatedPath: string;
    evaluatedAccessType: FsAccessType;
    matchedPattern: string;
    matchedLifetime: PolicyLifetime;
    matchedStatus: PolicyStatus;
    matchedReason: string;
    resolutionSource: PolicyResolutionSource;
};

export const isPersistedLifetime = (lifetime: PolicyLifetime): boolean =>
    lifetime === PolicyLifetime.LOCAL || lifetime === PolicyLifetime.GLOBAL;

export const isModifyingAccess = (accessType: FsAccessType): boolean =>
    accessType !== FsAccessType.READ;
