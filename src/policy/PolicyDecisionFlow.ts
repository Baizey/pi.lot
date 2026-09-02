import {
    PolicyAccessType,
    PolicyLifetime,
    type PolicyResult,
    PolicyResponse,
    resolveUri,
} from "./types";
import type {UiDecision, UiDecisionFlowManager, UiSelectDecisionOption} from "../tui/UiDecisionFlowManager";
import {UiFlowShortcut} from "../tui/UiDecisionFlowManager";
import {policyScopeHierarchy} from "./PolicyScope.js";
import type {PolicyApprovalRequestContext} from "./AgentPolicyDecisionFlow.js";

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

export type QueuedPolicyResolution = {
    beforePrompt: () => PolicyResult | undefined;
    complete: (choice: PolicyChoice) => PolicyResult | Promise<PolicyResult>;
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
        requestContext?: PolicyApprovalRequestContext,
    ): Promise<PolicyChoice> {
        const uri = resolveUri(accessType, inputUri);
        const scopes = policyScopeHierarchy(uri, accessType);
        const decisions = this.policyDecisions(uri, accessType, scopes, requestContext);

        const approval = await this.options.decisionFlows.runFlow(
            decisions.scope,
            decisions,
            (state) => this.cancelledApproval(state, uri),
            {shortcuts: {enabled: true}, signal},
        );

        return this.policyChoice(approval, uri, accessType);
    }

    async resolveQueuedPolicy(
        inputUri: string,
        accessType: PolicyAccessType,
        resolution: QueuedPolicyResolution,
        signal?: AbortSignal,
        requestContext?: PolicyApprovalRequestContext,
    ): Promise<PolicyResult> {
        const uri = resolveUri(accessType, inputUri);
        const scopes = policyScopeHierarchy(uri, accessType);
        const decisions = this.policyDecisions(uri, accessType, scopes, requestContext);
        let resolvedBeforePrompt: PolicyResult | undefined;
        let completion: Promise<PolicyResult> | undefined;
        const complete = (approval: PolicyApproval | UiFlowShortcut): Promise<PolicyResult> => {
            completion ??= Promise.resolve().then(() => resolution.complete(
                this.policyChoice(approval, uri, accessType),
            ));
            return completion;
        };

        const approval = await this.options.decisionFlows.runFlow(
            decisions.scope,
            decisions,
            (state) => this.cancelledApproval(state, uri),
            {
                shortcuts: {enabled: true},
                signal,
                beforeStart: () => {
                    resolvedBeforePrompt = resolution.beforePrompt();
                    return resolvedBeforePrompt
                        ? this.approvalFromResult(resolvedBeforePrompt)
                        : undefined;
                },
                afterFinish: async (result) => {
                    if (!resolvedBeforePrompt) await complete(result);
                },
            },
        );

        return resolvedBeforePrompt ?? await complete(approval);
    }

    private policyDecisions(
        evaluatedPath: string,
        accessType: PolicyAccessType,
        scopes: string[],
        requestContext?: PolicyApprovalRequestContext,
    ): Record<keyof PolicyApproval, UiDecision<PolicyApproval>> {
        const target = `${accessType} ${evaluatedPath}${this.requestContextDetails(requestContext)}`;
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

    private policyChoice(
        approval: PolicyApproval | UiFlowShortcut,
        evaluatedPath: string,
        accessType: PolicyAccessType,
    ): PolicyChoice {
        const resolved = this.resolveShortcut(approval, evaluatedPath, accessType);
        return {
            uri: resolved.scope,
            accessType,
            lifetime: resolved.lifetime,
            status: resolved.status,
            reason: resolved.reason || this.defaultReason(resolved.status, accessType),
        };
    }

    private approvalFromResult(result: PolicyResult): PolicyApproval {
        return {
            scope: result.matchedPattern,
            status: result.matchedStatus,
            lifetime: result.matchedLifetime,
            reason: result.matchedReason,
        };
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

    private requestContextDetails(context?: PolicyApprovalRequestContext): string {
        if (!context) return "";
        const lines = [
            "",
            `Policy request: ${boundedText(context.requestId, 200)}`,
            `Requesting agent: ${boundedText(context.requestingAgentIdentifier, 200)}`,
            "Authority ancestry:",
            ...context.ancestry.map((agent) => (
                `- ${boundedText(agent.role, 120)} [${boundedText(agent.agentIdentifier, 200)}]: ${boundedText(agent.task, 500)}`
            )),
        ];
        if (context.toolCall.toolName || context.toolCall.toolCallId) {
            lines.push(
                `Tool: ${boundedText(context.toolCall.toolName ?? "unknown", 120)}`
                + (context.toolCall.toolCallId
                    ? ` [${boundedText(context.toolCall.toolCallId, 200)}]`
                    : ""),
            );
        }
        if (context.toolCall.purpose) {
            lines.push(`Purpose: ${boundedText(context.toolCall.purpose, 500)}`);
        }
        if (context.toolCall.command) {
            lines.push("Command:", boundedText(context.toolCall.command, 8_000));
        }
        return `\n${lines.join("\n")}`;
    }

    private isFilesystemAccess(accessType: PolicyAccessType): boolean {
        return accessType === PolicyAccessType.FS_READ
            || accessType === PolicyAccessType.FS_WRITE
    }
}

function boundedText(value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
