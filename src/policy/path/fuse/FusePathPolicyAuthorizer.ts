import {realpathSync} from "node:fs";
import path from "node:path";
import type {FusePathAccess, FusePolicyEvent} from "./FuseFilesystem.js";
import {FuseAccessType, FuseDecision,} from "./FuseFilesystem.js";
import type {ToolCallPathPolicyEvaluator} from "../../PolicyRuntime";
import {PolicyAccessType} from "../../types.js";
import {PolicyResponse} from "../../types.js";

export type FusePathPolicyAuthorizerOptions = {
    backingRoot: string;
    policyEvaluator: ToolCallPathPolicyEvaluator;
    report: (message: string) => void;
};

export class FusePathPolicyAuthorizer {
    private readonly backingRoot: string;
    private readonly policyEvaluator: ToolCallPathPolicyEvaluator;
    private readonly report: (message: string) => void;

    constructor(options: FusePathPolicyAuthorizerOptions) {
        this.backingRoot = realpathSync.native(options.backingRoot);
        this.policyEvaluator = options.policyEvaluator;
        this.report = options.report;
    }

    async decide(event: FusePolicyEvent, signal?: AbortSignal): Promise<FuseDecision> {
        for (const access of event.pathAccesses) {
            const inputPath = this.backingPath(access.path);
            const accessType = this.pathAccessType(access);
            const result = await this.policyEvaluator(inputPath, accessType, signal);
            if (result.matchedStatus === PolicyResponse.DENIED) {
                this.report(result.toDenyMessage());
                return FuseDecision.DENY;
            }
        }
        return FuseDecision.ALLOW;
    }

    private backingPath(fusePath: string): string {
        if (!fusePath.startsWith("/") || fusePath.includes("\0")) {
            throw new Error(`Invalid FUSE policy path: ${JSON.stringify(fusePath)}`);
        }

        const candidate = path.resolve(this.backingRoot, fusePath.slice(1));
        if (!this.isSameOrChildPath(candidate, this.backingRoot)) {
            throw new Error(`FUSE policy path escapes its backing root: ${JSON.stringify(fusePath)}`);
        }
        return candidate;
    }

    private pathAccessType(access: FusePathAccess): PolicyAccessType {
        switch (access.access) {
            case FuseAccessType.READ:
                return PolicyAccessType.FS_READ;
            case FuseAccessType.WRITE:
                return PolicyAccessType.FS_WRITE;
            case FuseAccessType.DELETE:
                return PolicyAccessType.FS_DELETE;
            default:
                throw new Error(`Unsupported FUSE access type: ${String(access.access)}`);
        }
    }

    private isSameOrChildPath(candidate: string, parent: string): boolean {
        const relative = path.relative(parent, candidate);
        return relative === ""
            || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    }

}
