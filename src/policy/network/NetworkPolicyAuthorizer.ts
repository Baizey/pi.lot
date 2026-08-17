import type {HttpRequestEvent} from "./HttpRequestBroker.js";
import type {NetworkPolicyEvent, NetworkPolicyScope} from "./NetworkPolicy.js";
import {NetworkDecision, NetworkOperation} from "./network-queue-protocol.js";
import type {ToolCallPathPolicyEvaluator} from "../PolicyRuntime.js";
import {PolicyAccessType, PolicyResponse} from "../types.js";

export type NetworkPolicyAuthorizerOptions = {
    policyEvaluator: ToolCallPathPolicyEvaluator;
    report: (message: string) => void;
};

export class NetworkPolicyAuthorizer {
    constructor(private readonly options: NetworkPolicyAuthorizerOptions) {
    }

    readonly decide = async (
        event: NetworkPolicyEvent,
        scope: NetworkPolicyScope,
        signal: AbortSignal,
    ): Promise<NetworkDecision> => {
        const result = await this.options.policyEvaluator(
            networkScopeUri(scope),
            networkAccessType(event),
            signal,
        );
        if (result.matchedStatus === PolicyResponse.ALLOWED) return NetworkDecision.ALLOW;

        this.options.report(result.toDenyMessage());
        return NetworkDecision.DENY;
    };

    readonly authorizeHttpRequest = async (
        event: HttpRequestEvent,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await this.options.policyEvaluator(
            event.url,
            httpAccessType(event.method),
            signal,
        );
        if (result.matchedStatus === PolicyResponse.ALLOWED) return true;

        this.options.report(result.toDenyMessage());
        return false;
    };
}

function networkScopeUri(scope: NetworkPolicyScope): string {
    if (scope.port === null) return scope.target;
    const host = scope.target.includes(":") ? `[${scope.target}]` : scope.target;
    return `${host}:${scope.port}`;
}

function networkAccessType(event: NetworkPolicyEvent): PolicyAccessType {
    switch (event.operation) {
        case NetworkOperation.DNS_QUERY:
            return PolicyAccessType.DNS_ACCESS;
        case NetworkOperation.TCP_CONNECT:
            return PolicyAccessType.TCP_ACCESS;
        case NetworkOperation.UDP_FLOW:
            return PolicyAccessType.UDP_ACCESS;
    }
}

function httpAccessType(method: string): PolicyAccessType {
    switch (method.toUpperCase()) {
        case "GET":
            return PolicyAccessType.HTTP_GET;
        case "POST":
            return PolicyAccessType.HTTP_POST;
        case "PUT":
            return PolicyAccessType.HTTP_PUT;
        case "DELETE":
            return PolicyAccessType.HTTP_DELETE;
        case "PATCH":
            return PolicyAccessType.HTTP_PATCH;
        case "HEAD":
            return PolicyAccessType.HTTP_HEAD;
        case "OPTIONS":
            return PolicyAccessType.HTTP_OPTIONS;
        default:
            return PolicyAccessType.HTTP_ACCESS;
    }
}
