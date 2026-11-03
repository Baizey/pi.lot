import type {HttpRequestEvent} from "./HttpRequestBroker.js";
import type {NetworkPolicyEvent, NetworkPolicyScope} from "./NetworkPolicy.js";
import {NetworkDecision, NetworkOperation} from "./network-queue-protocol.js";
import type {ToolCallPathPolicyEvaluator} from "../PolicyRuntime.js";
import {httpMethodAccessType, PolicyAccessType, PolicyResponse} from "../types.js";
import {NetworkApplicationProtocol, type NetworkProtocolEvent} from "./NetworkProtocol.js";

const PROTOCOL_ACCESS_TYPES = {
    [NetworkApplicationProtocol.SSH]: PolicyAccessType.SSH_ACCESS,
    [NetworkApplicationProtocol.SMTP]: PolicyAccessType.SMTP_ACCESS,
    [NetworkApplicationProtocol.WEBSOCKET]: PolicyAccessType.WEBSOCKET_ACCESS,
    [NetworkApplicationProtocol.GRPC]: PolicyAccessType.GRPC_ACCESS,
} satisfies Record<NetworkApplicationProtocol, PolicyAccessType>;

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
        return this.authorize(event.url, httpMethodAccessType(event.method), signal);
    };

    readonly authorizeProtocol = async (
        event: NetworkProtocolEvent,
        signal: AbortSignal,
    ): Promise<boolean> => {
        return this.authorize(event.uri, PROTOCOL_ACCESS_TYPES[event.protocol], signal);
    };

    private async authorize(uri: string, accessType: PolicyAccessType, signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) return false;
        const result = await this.options.policyEvaluator(uri, accessType, signal);
        if (signal.aborted) return false;
        if (result.matchedStatus === PolicyResponse.ALLOWED) return true;
        this.options.report(result.toDenyMessage());
        return false;
    }
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
