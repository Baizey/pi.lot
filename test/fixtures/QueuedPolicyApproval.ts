import type {PolicyApprovalRequestContext} from "../../src/policy/AgentPolicyDecisionFlow.js";
import type {PolicyChoice, QueuedPolicyApproval} from "../../src/policy/PolicyDecisionFlow.js";
import {PolicyAccessType, PolicyResolutionSource, PolicyResult} from "../../src/policy/types.js";
import {UiDecisionFlowQueue} from "../../src/tui/UiDecisionFlowQueue.js";

/** Script the user answer while retaining the runtime's required queued recheck/completion contract. */
export function scriptedPolicyApproval(choose: (
    uri: string,
    accessType: PolicyAccessType,
    signal?: AbortSignal,
    context?: PolicyApprovalRequestContext,
) => PolicyChoice | Promise<PolicyChoice>): QueuedPolicyApproval {
    const queue = new UiDecisionFlowQueue();
    return {
        resolveQueuedPolicy(uri, accessType, resolution, signal, context) {
            return queue.enqueue(async () => resolution.beforePrompt()
                ?? await resolution.complete(await choose(uri, accessType, signal, context)));
        },
    };
}

/** Observe a real prompt's choice without installing a runtime policy. */
export async function promptPolicyChoice(
    flow: QueuedPolicyApproval,
    uri: string,
    accessType: PolicyAccessType,
    signal?: AbortSignal,
    context?: PolicyApprovalRequestContext,
): Promise<PolicyChoice> {
    const result = await flow.resolveQueuedPolicy(uri, accessType, {
        beforePrompt: () => undefined,
        complete: (choice) => PolicyResult.of({
            evaluatedUri: uri,
            evaluatedAccessType: accessType,
            matchedPattern: choice.uri,
            matchedLifetime: choice.lifetime,
            matchedStatus: choice.status,
            matchedReason: choice.reason,
            resolutionSource: PolicyResolutionSource.NEW_USER_DECISION,
        }),
    }, signal, context);
    return {
        uri: result.matchedPattern,
        accessType,
        lifetime: result.matchedLifetime,
        status: result.matchedStatus,
        reason: result.matchedReason,
    };
}
