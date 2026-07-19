import {realpathSync} from "node:fs";
import path from "node:path";
import {
    FuseAccessType,
    FuseDecision,
} from "./FuseFilesystem.js";
import type {FusePathAccess, FusePolicyEvent} from "./FuseFilesystem.js";
import type {PathPolicyChoice, PathPolicyToolCall} from "../policy/path/PathPolicyRuntime.js";
import type {PathPolicyResult} from "../policy/path/types.js";
import {FsAccessType} from "../policy/path/types.js";
import {PolicyLifetime, PolicyStatus} from "../policy/types";
import {UiFlowShortcut} from "../tui/UiDecisionFlowManager.js";
import type {UiDecision, UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";

export type FusePathPolicyAuthorizerOptions = {
    backingRoot: string;
    command: string;
    decisionFlows: UiDecisionFlowManager;
    signal?: AbortSignal;
    policy: PathPolicyToolCall;
    report: (message: string) => void;
};

type PathPolicyApproval = {
    scope: string;
    status: PolicyStatus;
    lifetime: PolicyLifetime;
    reason?: string;
};

export class FusePathPolicyAuthorizer {
    private readonly backingRoot: string;
    private readonly command: string;
    private readonly decisionFlows: UiDecisionFlowManager;
    private readonly signal: AbortSignal | undefined;
    private readonly policy: PathPolicyToolCall;
    private readonly report: (message: string) => void;

    constructor(options: FusePathPolicyAuthorizerOptions) {
        this.backingRoot = realpathSync.native(options.backingRoot);
        this.command = options.command;
        this.decisionFlows = options.decisionFlows;
        this.signal = options.signal;
        this.policy = options.policy;
        this.report = options.report;
    }

    async decide(event: FusePolicyEvent): Promise<FuseDecision> {
        for (const access of event.pathAccesses) {
            const inputPath = this.backingPath(access.path);
            const accessType = this.pathAccessType(access);
            let result = this.policy.evaluate(inputPath, accessType);

            if (!result) result = this.policy.record(await this.askForPolicy(event, inputPath, accessType));

            if (result.matchedStatus === PolicyStatus.DENIED) {
                this.reportDenied(result);
                return FuseDecision.DENY;
            }
        }

        return FuseDecision.ALLOW;
    }

    private async askForPolicy(
        event: FusePolicyEvent,
        inputPath: string,
        accessType: FsAccessType,
    ): Promise<PathPolicyChoice> {
        const evaluatedPath = this.policy.policyPathFor(inputPath);
        const scopes = this.policyScopes(evaluatedPath);
        const decisions = this.policyDecisions(event, evaluatedPath, accessType, scopes);
        const approval = await this.decisionFlows.runFlow(
            decisions.scope,
            decisions,
            (state) => this.cancelledApproval(state, evaluatedPath),
            {
                shortcuts: {enabled: true},
                signal: this.signal,
            },
        );

        const resolved = this.resolveShortcut(approval, evaluatedPath, accessType);
        return {
            path: resolved.scope,
            accessType,
            lifetime: resolved.lifetime,
            status: resolved.status,
            reason: resolved.reason || this.defaultReason(resolved.status, accessType),
        };
    }

    private policyDecisions(
        event: FusePolicyEvent,
        evaluatedPath: string,
        accessType: FsAccessType,
        scopes: string[],
    ): Record<keyof PathPolicyApproval, UiDecision<PathPolicyApproval>> {
        const target = `${accessType} ${evaluatedPath}`;
        const requestContext = [
            `FUSE operation: ${event.operation}`,
            `Command: ${JSON.stringify(this.truncateCommand())}`,
        ].join("\n");

        const decisions = {
            scope: {
                type: "select",
                key: "scope",
                title: `Path policy scope for ${target}\n${requestContext}`,
                options: scopes.map((scope) => ({title: scope, value: scope, next: "status"})),
            },
            status: {
                type: "select",
                key: "status",
                title: (state) => `Path policy decision for ${target}\nScope: ${state.scope}\n${requestContext}`,
                options: [
                    {title: "Allow", value: PolicyStatus.ALLOWED, next: "lifetime"},
                    {title: "Deny", value: PolicyStatus.DENIED, next: "lifetime"},
                ],
            },
            lifetime: {
                type: "select",
                key: "lifetime",
                title: (state) => `Path policy lifetime for ${target}\nDecision: ${state.status}\nScope: ${state.scope}`,
                options: [
                    {title: "Once", value: PolicyLifetime.ONCE, next: this.reasonDecisionAfterDenial},
                    {title: "This session", value: PolicyLifetime.SESSION, next: this.reasonDecisionAfterDenial},
                    {title: "Always on this computer", value: PolicyLifetime.LOCAL, next: this.reasonDecisionAfterDenial},
                ],
            },
            reason: {
                type: "input",
                key: "reason",
                title: `Reason for denying ${target} (optional)`,
                placeholder: (state) => this.defaultReason(state.status ?? PolicyStatus.DENIED, accessType),
                next: null,
            },
        } satisfies Record<keyof PathPolicyApproval, UiDecision<PathPolicyApproval>>;
        return decisions;
    }

    private resolveShortcut(
        approval: PathPolicyApproval | UiFlowShortcut,
        evaluatedPath: string,
        accessType: FsAccessType,
    ): PathPolicyApproval {
        if (approval === UiFlowShortcut.ALLOW_ALL_ONCE) {
            return {
                scope: evaluatedPath,
                status: PolicyStatus.ALLOWED,
                lifetime: PolicyLifetime.ONCE,
                reason: this.defaultReason(PolicyStatus.ALLOWED, accessType),
            };
        }
        if (approval === UiFlowShortcut.DENY_ALL_ONCE) {
            return {
                scope: evaluatedPath,
                status: PolicyStatus.DENIED,
                lifetime: PolicyLifetime.ONCE,
                reason: this.defaultReason(PolicyStatus.DENIED, accessType),
            };
        }
        return approval;
    }

    private cancelledApproval(
        state: Partial<PathPolicyApproval>,
        evaluatedPath: string,
    ): PathPolicyApproval {
        return {
            scope: state.scope ?? evaluatedPath,
            status: PolicyStatus.DENIED,
            lifetime: PolicyLifetime.ONCE,
            reason: `Access denied: ${this.flowCancelReason(state, evaluatedPath)}`,
        };
    }

    private reasonDecisionAfterDenial(state: Partial<PathPolicyApproval>): keyof PathPolicyApproval | null {
        return state.status === PolicyStatus.DENIED ? "reason" : null;
    }

    private flowCancelReason(state: Partial<PathPolicyApproval>, evaluatedPath: string): string {
        if (!state.scope) return `No path policy scope selected for ${JSON.stringify(evaluatedPath)}.`;
        if (!state.status) return "No path policy decision selected.";
        if (!state.lifetime) return "No path policy lifetime selected.";
        return "No path policy denial reason was completed.";
    }

    private defaultReason(status: PolicyStatus, accessType: FsAccessType): string {
        return `User selected ${status} for ${accessType}.`;
    }

    private reportDenied(result: PathPolicyResult): void {
        this.report(
            `[pi.lot:path-policy] DENIED ${result.evaluatedAccessType} ${JSON.stringify(result.evaluatedPath)} `
            + `(scope ${JSON.stringify(result.matchedPattern)}, lifetime ${result.matchedLifetime}): `
            + result.matchedReason,
        );
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

    private pathAccessType(access: FusePathAccess): FsAccessType {
        switch (access.access) {
            case FuseAccessType.READ:
                return FsAccessType.READ;
            case FuseAccessType.WRITE:
                return FsAccessType.WRITE;
            case FuseAccessType.DELETE:
                return FsAccessType.DELETE;
            default:
                throw new Error(`Unsupported FUSE access type: ${String(access.access)}`);
        }
    }

    private policyScopes(evaluatedPath: string): string[] {
        const canonicalRoot = this.policy.policyPathFor(this.backingRoot);
        if (!this.isSameOrChildPath(evaluatedPath, canonicalRoot)) return [evaluatedPath];

        const scopes: string[] = [];
        let current = evaluatedPath;
        while (true) {
            scopes.push(current);
            if (current === canonicalRoot) return scopes;
            const parent = path.dirname(current);
            if (parent === current) return scopes;
            current = parent;
        }
    }

    private isSameOrChildPath(candidate: string, parent: string): boolean {
        const relative = path.relative(parent, candidate);
        return relative === ""
            || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    }

    private truncateCommand(): string {
        return this.command.length <= 500 ? this.command : `${this.command.slice(0, 499)}…`;
    }
}
