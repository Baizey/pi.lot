import path from "node:path";
import {PolicyAccessType, PolicyLifetime, PolicyResponse, resolveUri} from "./types";
import type {UiDecision, UiDecisionFlowManager, UiSelectDecisionOption} from "../tui/UiDecisionFlowManager";
import {UiFlowShortcut} from "../tui/UiDecisionFlowManager";
import {ParsedUri} from "./network/ParsedUri";

export type PolicyChoice = {
    uri: string;
    accessType: PolicyAccessType;
    lifetime: PolicyLifetime;
    status: PolicyResponse;
    reason: string;
};

export type PolicyDecisionFlowOptions = {
    decisionFlows: UiDecisionFlowManager;
};

type PolicyApproval = {
    scope: string;
    status: PolicyResponse;
    lifetime: PolicyLifetime;
    reason?: string;
};

export class PolicyDecisionFlow {
    constructor(private readonly options: PolicyDecisionFlowOptions) {
    }

    async askForPolicy(
        inputUri: string,
        accessType: PolicyAccessType,
        signal?: AbortSignal,
    ): Promise<PolicyChoice> {
        const uri = resolveUri(accessType, inputUri);
        const scopes = this.policyScopes(accessType, uri);
        const decisions = this.policyDecisions(uri, accessType, scopes);

        const approval = await this.options.decisionFlows.runFlow(
            decisions.scope,
            decisions,
            (state) => this.cancelledApproval(state, uri),
            {shortcuts: {enabled: true}, signal},
        );

        const resolved = this.resolveShortcut(approval, uri, accessType);
        return {
            uri: resolved.scope,
            accessType,
            lifetime: resolved.lifetime,
            status: resolved.status,
            reason: resolved.reason || this.defaultReason(resolved.status, accessType),
        };
    }

    private policyDecisions(
        evaluatedPath: string,
        accessType: PolicyAccessType,
        scopes: string[],
    ): Record<keyof PolicyApproval, UiDecision<PolicyApproval>> {
        const target = `${accessType} ${evaluatedPath}`;
        const policyKind = this.isFilesystemAccess(accessType) ? "Path" : "Network";

        return {
            scope: {
                type: "select",
                key: "scope",
                title: `${policyKind} policy scope for ${target}\n`,
                options: scopes.map((scope) => ({title: scope, value: scope, next: "status"})),
            },
            status: {
                type: "select",
                key: "status",
                title: (state) => `${policyKind} policy decision for ${target}\nScope: ${state.scope}\n`,
                options: [
                    {title: "Allow", value: PolicyResponse.ALLOWED, next: "lifetime"},
                    {title: "Deny", value: PolicyResponse.DENIED, next: "lifetime"},
                ],
            },
            lifetime: {
                type: "select",
                key: "lifetime",
                title: (state) => `${policyKind} policy lifetime for ${target}\nDecision: ${state.status}\nScope: ${state.scope}\n`,
                options: this.lifeTimeOptions(accessType),
            },
            reason: {
                type: "input",
                key: "reason",
                title: (state) => `Reason for denying ${target} (optional)\nScope: ${state.scope}\n`,
                placeholder: (state) => this.defaultReason(state.status ?? PolicyResponse.DENIED, accessType),
                next: null,
            },
        } satisfies Record<keyof PolicyApproval, UiDecision<PolicyApproval>>;
    }

    private lifeTimeOptions(accessType: PolicyAccessType): UiSelectDecisionOption<PolicyApproval>[] {
        switch (accessType) {
            case PolicyAccessType.FS_READ:
            case PolicyAccessType.FS_WRITE:
            case PolicyAccessType.FS_DELETE:
                return [
                    {title: "Once", value: PolicyLifetime.ONCE, next: this.reasonDecisionAfterDenial},
                    {title: "This session", value: PolicyLifetime.SESSION, next: this.reasonDecisionAfterDenial},
                    {
                        title: "Always on this computer",
                        value: PolicyLifetime.LOCAL,
                        next: this.reasonDecisionAfterDenial
                    },
                ]
            default:
                return [
                    {title: "Once", value: PolicyLifetime.ONCE, next: this.reasonDecisionAfterDenial},
                    {title: "This session", value: PolicyLifetime.SESSION, next: this.reasonDecisionAfterDenial},
                    {
                        title: "Always on this computer",
                        value: PolicyLifetime.LOCAL,
                        next: this.reasonDecisionAfterDenial
                    },
                    {
                        title: "Always synchronized",
                        value: PolicyLifetime.GLOBAL,
                        next: this.reasonDecisionAfterDenial
                    },
                ]
        }
    }

    private resolveShortcut(
        approval: PolicyApproval | UiFlowShortcut,
        evaluatedPath: string,
        accessType: PolicyAccessType,
    ): PolicyApproval {
        if (approval === UiFlowShortcut.ALLOW_ALL_ONCE) {
            return {
                scope: evaluatedPath,
                status: PolicyResponse.ALLOWED,
                lifetime: PolicyLifetime.ONCE,
                reason: this.defaultReason(PolicyResponse.ALLOWED, accessType),
            };
        }
        if (approval === UiFlowShortcut.DENY_ALL_ONCE) {
            return {
                scope: evaluatedPath,
                status: PolicyResponse.DENIED,
                lifetime: PolicyLifetime.ONCE,
                reason: this.defaultReason(PolicyResponse.DENIED, accessType),
            };
        }
        return approval;
    }

    private cancelledApproval(
        state: Partial<PolicyApproval>,
        evaluatedPath: string,
    ): PolicyApproval {
        return {
            scope: state.scope ?? evaluatedPath,
            status: PolicyResponse.DENIED,
            lifetime: PolicyLifetime.ONCE,
            reason: `Access denied: ${this.flowCancelReason(state, evaluatedPath)}`,
        };
    }

    private reasonDecisionAfterDenial(state: Partial<PolicyApproval>): keyof PolicyApproval | null {
        return state.status === PolicyResponse.DENIED ? "reason" : null;
    }

    private flowCancelReason(state: Partial<PolicyApproval>, evaluatedPath: string): string {
        if (!state.scope) return `No uri policy scope selected for ${JSON.stringify(evaluatedPath)}.`;
        if (!state.status) return "No uri policy decision selected.";
        if (!state.lifetime) return "No uri policy lifetime selected.";
        return "No uri policy denial reason was completed.";
    }

    private defaultReason(status: PolicyResponse, accessType: PolicyAccessType): string {
        return `User selected ${status} for ${accessType}.`;
    }

    private policyScopes(accessType: PolicyAccessType, uri: string): string[] {
        return this.isFilesystemAccess(accessType)
            ? this.filesystemScopes(uri)
            : this.networkScopes(uri);
    }

    private isFilesystemAccess(accessType: PolicyAccessType): boolean {
        return accessType === PolicyAccessType.FS_READ
            || accessType === PolicyAccessType.FS_WRITE
            || accessType === PolicyAccessType.FS_DELETE;
    }

    private networkScopes(uri: string) {
        return new ParsedUri(uri).scopeHierarchy().reverse()
    }

    private filesystemScopes(uri: string) {
        const scopes: string[] = [];
        let current = uri;
        while (true) {
            scopes.push(current);
            const parent = path.dirname(current);
            if (parent === current) return scopes;
            current = parent;
        }
    }
}
