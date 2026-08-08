import {
    NetworkAddressFamily,
    NetworkDecision,
    NetworkOperation,
} from "./network-queue-protocol.js";
import type {NetworkQueueEvent} from "./network-queue-protocol.js";

export type NetworkPolicyGranularity = Readonly<{
    distinguishOperation: boolean;
    distinguishAddressFamily: boolean;
}>;

export const DEFAULT_NETWORK_POLICY_GRANULARITY: NetworkPolicyGranularity = Object.freeze({
    distinguishOperation: false,
    distinguishAddressFamily: false,
});

export enum NetworkTargetKind {
    HOSTNAME = "HOSTNAME",
    IP = "IP",
    LOCALHOST = "LOCALHOST",
}

export type NetworkHostnameResolutionTarget = {
    kind: NetworkTargetKind.HOSTNAME;
    hostname: string;
};

export type NetworkHostnameFlowTarget = {
    kind: NetworkTargetKind.HOSTNAME;
    hostname: string;
    port: number;
    address: string;
    syntheticAddress: string;
};

export type NetworkIpTarget = {
    kind: NetworkTargetKind.IP;
    address: string;
    port: number;
};

export type NetworkLocalhostTarget = {
    kind: NetworkTargetKind.LOCALHOST;
    address: string;
    port: number;
};

export type NetworkPolicyTarget =
    | NetworkHostnameResolutionTarget
    | NetworkHostnameFlowTarget
    | NetworkIpTarget
    | NetworkLocalhostTarget;

type NetworkDnsQueueEvent = Extract<NetworkQueueEvent, {operation: NetworkOperation.DNS_QUERY}>;
type NetworkFlowQueueEvent = Exclude<NetworkQueueEvent, {operation: NetworkOperation.DNS_QUERY}>;

export type NetworkPolicyEvent =
    | (NetworkDnsQueueEvent & {target: NetworkHostnameResolutionTarget})
    | (NetworkFlowQueueEvent & {
        target: NetworkHostnameFlowTarget | NetworkIpTarget | NetworkLocalhostTarget;
    });

export type NetworkPolicyScope = Readonly<{
    targetKind: NetworkTargetKind;
    target: string;
    port: number | null;
    operation: string;
    family: NetworkAddressFamily | "ANY" | "NONE";
}>;

type NetworkDecisionRecord = {
    scope: NetworkPolicyScope;
    decision: NetworkDecision;
};

export type NetworkDecisionCoordinatorOptions = {
    granularity: NetworkPolicyGranularity;
    decide: (
        event: NetworkPolicyEvent,
        scope: NetworkPolicyScope,
        signal: AbortSignal,
    ) => NetworkDecision | Promise<NetworkDecision>;
    onDecisionReuse?: (
        event: NetworkPolicyEvent,
        scope: NetworkPolicyScope,
        decision: NetworkDecision,
    ) => void;
};

export class NetworkPolicyProjector {
    readonly granularity: NetworkPolicyGranularity;

    constructor(granularity: NetworkPolicyGranularity) {
        this.granularity = Object.freeze({...granularity});
    }

    project(event: NetworkPolicyEvent): NetworkPolicyScope {
        return Object.freeze({
            targetKind: event.target.kind,
            target: event.target.kind === NetworkTargetKind.HOSTNAME
                ? event.target.hostname
                : event.target.kind === NetworkTargetKind.LOCALHOST
                    ? "localhost"
                    : event.target.address,
            port: this.projectPort(event),
            operation: this.projectOperation(event),
            family: this.projectFamily(event),
        });
    }

    covers(rule: NetworkPolicyScope, candidate: NetworkPolicyScope): boolean {
        return rule.targetKind === candidate.targetKind
            && rule.target === candidate.target
            && rule.operation === candidate.operation
            && rule.family === candidate.family
            && (rule.port === null || rule.port === candidate.port);
    }

    private projectPort(event: NetworkPolicyEvent): number | null {
        if (event.operation === NetworkOperation.DNS_QUERY) return null;
        const port = event.target.port;
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
            throw new Error("network flow target has an invalid port");
        }
        return port;
    }

    private projectOperation(event: NetworkPolicyEvent): string {
        if (!this.granularity.distinguishOperation) return "ANY";
        if (event.operation !== NetworkOperation.DNS_QUERY) return event.operation;
        return event.dns.type === "A" || event.dns.type === "AAAA"
            ? "DNS_ADDRESS"
            : `DNS_${event.dns.type}`;
    }

    private projectFamily(event: NetworkPolicyEvent): NetworkPolicyScope["family"] {
        if (!this.granularity.distinguishAddressFamily) return "ANY";
        return event.operation === NetworkOperation.DNS_QUERY ? "NONE" : event.family;
    }
}

export class NetworkDecisionCoordinator {
    private readonly options: NetworkDecisionCoordinatorOptions;
    private readonly projector: NetworkPolicyProjector;
    private readonly decisions: NetworkDecisionRecord[] = [];

    constructor(options: NetworkDecisionCoordinatorOptions) {
        this.options = options;
        this.projector = new NetworkPolicyProjector(options.granularity);
    }

    async decide(event: NetworkPolicyEvent, signal: AbortSignal): Promise<NetworkDecision> {
        const scope = this.projector.project(event);
        const existing = this.decisions.find((record) => this.projector.covers(record.scope, scope));
        if (existing) {
            this.reportReuse(event, existing.scope, existing.decision);
            return existing.decision;
        }

        const decision = await this.options.decide(event, scope, signal);
        if (decision !== NetworkDecision.ALLOW && decision !== NetworkDecision.DENY) {
            throw new Error(`invalid network decision: ${String(decision)}`);
        }
        this.decisions.push({scope, decision});
        return decision;
    }

    private reportReuse(
        event: NetworkPolicyEvent,
        scope: NetworkPolicyScope,
        decision: NetworkDecision,
    ): void {
        try {
            this.options.onDecisionReuse?.(event, scope, decision);
        } catch {
            // Reporting a reused decision must not change its verdict.
        }
    }
}
