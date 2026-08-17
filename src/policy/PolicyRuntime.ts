import {PolicyLogic} from "./PolicyLogic";
import {
    isPersistedLifetime,
    Policy,
    PolicyAccessType,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResult, ResponseDefaults, ResponseType
} from "./types";
import {PolicyDaoInterface} from "../storage/PolicyDao";
import {PolicyDecisionFlow} from "./PolicyDecisionFlow";
import {initialPolicyDefaults, PolicyDefaultJsonStorageInterface} from "./defaults.js";

export type ToolCallPathPolicyEvaluator = (
    path: string,
    accessType: PolicyAccessType,
    signal?: AbortSignal,
) => Promise<PolicyResult>

export class PolicyRuntime {
    private readonly sessionPolicy: PolicyLogic;
    readonly defaultResponses: ResponseDefaults;

    constructor(
        private readonly database: PolicyDaoInterface,
        private readonly decisionFlow: PolicyDecisionFlow,
        private readonly defaultsStore?: PolicyDefaultJsonStorageInterface,
    ) {
        this.sessionPolicy = new PolicyLogic({policies: database.loadPolicies()});
        this.defaultResponses = {
            ...initialPolicyDefaults,
            ...defaultsStore?.load(),
        };
    }

    async once(
        path: string,
        accessType: PolicyAccessType,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        return this.evaluate(path, accessType, new PolicyLogic(), this.sessionPolicy, signal)
    }

    beginToolCall(): ToolCallPathPolicyEvaluator {
        const oncePolicies = new PolicyLogic()
        const sessionPolicy = this.sessionPolicy
        return (path, accessType, signal) => this.evaluate(path, accessType, oncePolicies, sessionPolicy, signal)
    }

    setDefaultResponse(key: keyof ResponseDefaults, response: ResponseType): void {
        this.defaultResponses[key] = response;
    }

    saveDefaultResponses(): void {
        if (!this.defaultsStore) throw new Error("Policy defaults persistence is not configured.");
        this.defaultsStore.save(this.defaultResponses);
    }

    resetDefaultResponses(): "saved" | "built-in" {
        const savedDefaults = this.defaultsStore?.load();
        Object.assign(
            this.defaultResponses,
            initialPolicyDefaults,
            savedDefaults ?? {},
        );
        return savedDefaults ? "saved" : "built-in";
    }

    private async evaluate(
        path: string,
        accessType: PolicyAccessType,
        oncePolicy: PolicyLogic,
        sessionPolicy: PolicyLogic,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        const resultMaybe = sessionPolicy.evaluate(path, accessType) ?? oncePolicy.evaluate(path, accessType, this.defaultResponses)
        if (resultMaybe) return resultMaybe

        const choice = await this.decisionFlow.askForPolicy(path, accessType, signal)
        const policy = {
            pattern: choice.uri,
            info: {
                [choice.accessType]: PolicyLogic.createStatus(
                    choice.accessType,
                    choice.lifetime,
                    choice.status,
                    choice.reason,
                ),
            },
        } satisfies Policy;

        if (isPersistedLifetime(choice.lifetime)) {
            this.database.upsertPolicies([policy])
        }

        if (choice.lifetime === PolicyLifetime.ONCE) {
            oncePolicy.addPolicies([policy])
        } else {
            sessionPolicy.addPolicies([policy])
        }

        return PolicyResult.of({
            resolutionSource: PolicyResolutionSource.NEW_USER_DECISION,
            evaluatedUri: path,
            evaluatedAccessType: accessType,
            matchedPattern: choice.uri,
            matchedLifetime: choice.lifetime,
            matchedStatus: choice.status,
            matchedReason: choice.reason,
        })
    }
}

export default PolicyRuntime
