import {PolicyEngine} from "./PolicyEngine";
import {
    isPersistedLifetime,
    Policy,
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult, PolicyStatus
} from "./types";
import {PolicyDaoInterface} from "../storage/PolicyDao";
import {PolicyDecisionFlow} from "./PolicyDecisionFlow";
import {initialPolicyDefaults, PolicyDefaultJsonStorageInterface, ResponseDefaults} from "./defaults.js";
import {UNIVERSAL_NETWORK_POLICY_PATTERN} from "./network/ParsedUri.js";

export type ToolCallPathPolicyEvaluator = (
    path: string,
    accessType: PolicyAccessType,
    signal?: AbortSignal,
) => Promise<PolicyResult>

export class PolicyRuntime {
    private readonly parentChildMapping: Map<string, string[]> = new Map();
    private readonly sessionPolicy: Map<string, PolicyEngine> = new Map();
    private readonly rootAgentIdentifier: string;
    readonly defaultResponses: ResponseDefaults

    constructor(
        agentIdentifier: string,
        private readonly database: PolicyDaoInterface,
        private readonly decisionFlow: PolicyDecisionFlow,
        private readonly defaultsStore?: PolicyDefaultJsonStorageInterface,
    ) {
        this.rootAgentIdentifier = agentIdentifier;
        const rootPolicies = new PolicyEngine({agentIdentifier, policies: database.loadPolicies()})
        this.sessionPolicy.set(agentIdentifier, rootPolicies);
        this.defaultResponses = {...initialPolicyDefaults, ...defaultsStore?.load()};
        this.setFallbacks(agentIdentifier);
    }

    async once(
        agentIdentifier: string,
        path: string,
        accessType: PolicyAccessType,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        return this.beginToolCall(agentIdentifier)(path, accessType, signal);
    }

    beginToolCall(
        agentIdentifier: string
    ): ToolCallPathPolicyEvaluator {
        const oncePolicies = new PolicyEngine({agentIdentifier});
        const sessionPolicies = this.getPolicyLogic(agentIdentifier);
        return (path, accessType, signal) => this.evaluate(
            agentIdentifier,
            path,
            accessType,
            oncePolicies,
            sessionPolicies,
            signal
        )
    }

    setDefaultResponse(key: keyof ResponseDefaults, response: PolicyFallbackResponse): void {
        this.defaultResponses[key] = response;
        this.setFallbacks(this.rootAgentIdentifier);
    }

    saveDefaultResponses(): void {
        if (!this.defaultsStore) throw new Error("Policy defaults persistence is not configured.");
        this.defaultsStore.save(this.defaultResponses);
    }

    resetDefaultResponses(): void {
        Object.assign(this.defaultResponses, this.defaultsStore?.load() ?? initialPolicyDefaults);
        this.setFallbacks(this.rootAgentIdentifier);
    }

    registerPolicyLogic(
        agentIdentifier: string,
        parentAgentIdentifier: string,
        policies: Policy[] = [],
    ): void {
        if (this.sessionPolicy.has(agentIdentifier)) {
            throw new Error(`An agent is already registered with this identifier: ${agentIdentifier}`);
        }
        this.getPolicyLogic(parentAgentIdentifier);

        if (this.parentChildMapping.has(parentAgentIdentifier)) {
            this.parentChildMapping.get(parentAgentIdentifier)!.push(agentIdentifier);
        } else {
            this.parentChildMapping.set(parentAgentIdentifier, [agentIdentifier]);
        }

        this.sessionPolicy.set(agentIdentifier, new PolicyEngine({
            agentIdentifier,
            parentAgentIdentifier,
            policies,
        }));
    }

    removePolicyLogic(agentIdentifier: string): void {
        const children = this.parentChildMapping.get(agentIdentifier) ?? []
        children.forEach(it => this.removePolicyLogic(it));
        this.parentChildMapping.delete(agentIdentifier);
        this.sessionPolicy.delete(agentIdentifier)
    }

    private getPolicyLogic(agentIdentifier: string): PolicyEngine {
        if (!this.sessionPolicy.has(agentIdentifier)) {
            throw new Error(`No agent registered with this identifier: ${agentIdentifier}`);
        }
        return this.sessionPolicy.get(agentIdentifier)!
    }

    private async evaluate(
        agentIdentifier: string,
        path: string,
        accessType: PolicyAccessType,
        oncePolicy: PolicyEngine,
        sessionPolicy: PolicyEngine,
        signal?: AbortSignal,
    ): Promise<PolicyResult> {
        const resultMaybe = sessionPolicy.evaluate(path, accessType) ?? oncePolicy.evaluate(path, accessType)
        if (resultMaybe) return resultMaybe

        const choice = await this.decisionFlow.askForPolicy(path, accessType, signal)
        const policy = {
            pattern: choice.uri,
            info: {
                [choice.accessType]: PolicyEngine.createStatus(
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

    private setFallbacks(agentIdentifier: string) {
        const engine = this.getPolicyLogic(agentIdentifier);
        Object.entries(this.defaultResponses).forEach(([name, response]) => {
            this.setFallback(name as PolicyArea, response, engine)
        })
    }

    private setFallback(
        area: PolicyArea,
        response: PolicyFallbackResponse,
        policyEngine: PolicyEngine
    ) {
        const areas = this.getAreaCover(area);
        const pattern = area.startsWith("fs_") ? "/" : UNIVERSAL_NETWORK_POLICY_PATTERN;
        const status = this.getPolicyStatus(response)
        if (status) {
            const policy = {pattern: pattern, info: {}} satisfies Policy as Policy
            areas.forEach(it => {
                    policy.info[it] = {
                        accessType: it,
                        lifetime: PolicyLifetime.SESSION,
                        status: status,
                        reason: 'Automated fallback'
                    } satisfies PolicyStatus
                }
            )
            policyEngine.addPolicies([policy]);
        } else {
            policyEngine.removePolicies([{uri: pattern, accessTypes: areas}]);
        }
    }


    private getPolicyStatus(response: PolicyFallbackResponse): PolicyResponse | null {
        switch (response) {
            case PolicyFallbackResponse.allow:
                return PolicyResponse.ALLOWED
            case PolicyFallbackResponse.deny:
                return PolicyResponse.DENIED
            default:
                return null
        }
    }

    private getAreaCover(area: PolicyArea): PolicyAccessType[] {
        switch (area) {
            case PolicyArea.fs_read:
                return [PolicyAccessType.FS_READ]
            case PolicyArea.fs_write:
                return [PolicyAccessType.FS_WRITE];
            case PolicyArea.web_read:
                return [
                    PolicyAccessType.HTTP_ACCESS,
                    PolicyAccessType.HTTP_GET
                ];
            case PolicyArea.web_write:
                return [
                    PolicyAccessType.HTTP_POST,
                    PolicyAccessType.HTTP_PUT,
                    PolicyAccessType.HTTP_PATCH,
                    PolicyAccessType.HTTP_OPTIONS,
                    PolicyAccessType.HTTP_DELETE,
                    PolicyAccessType.HTTP_HEAD,
                ];
            case PolicyArea.web_dns:
                return [PolicyAccessType.DNS_ACCESS]
            case PolicyArea.web_grpc:
                return [PolicyAccessType.GRPC_ACCESS]
            case PolicyArea.web_tcp:
                return [PolicyAccessType.TCP_ACCESS]
            case PolicyArea.web_ssh:
                return [PolicyAccessType.SSH_ACCESS]
            case PolicyArea.web_udp:
                return [PolicyAccessType.UDP_ACCESS]
            case PolicyArea.web_smtp:
                return [PolicyAccessType.SMTP_ACCESS]
            case PolicyArea.web_websocket:
                return [PolicyAccessType.WEBSOCKET_ACCESS]
        }
    }
}

export default PolicyRuntime
