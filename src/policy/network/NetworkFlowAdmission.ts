import {isIP} from "node:net";
import {NetworkAddressFamily, NetworkDecision, NetworkOperation} from "./network-queue-protocol.js";
import type {NetworkQueueEvent} from "./network-queue-protocol.js";
import {NetworkTargetKind} from "./NetworkPolicy.js";
import type {NetworkPolicyEvent} from "./NetworkPolicy.js";
import {SyntheticDnsLeaseTable} from "./SyntheticDnsProxy.js";
import type {SyntheticDnsLease} from "./SyntheticDnsProxy.js";

export type SyntheticUdpFlow = Extract<NetworkQueueEvent, {operation: NetworkOperation.UDP_FLOW}>;
export type AdmittedTcpFlow = Extract<NetworkPolicyEvent, {operation: NetworkOperation.TCP_CONNECT}>;

export type NetworkFlowAdmissionOptions = {
    leases: SyntheticDnsLeaseTable;
    decide: (event: NetworkPolicyEvent, signal: AbortSignal) => NetworkDecision | Promise<NetworkDecision>;
    // Replace is one atomic nft transaction. Removal only changes future NAT lookups,
    // never existing conntrack entries or their reverse translation.
    updateUdp: (flow: SyntheticUdpFlow, binding: SyntheticDnsLease | null, replace: boolean) => Promise<void>;
    clearUdp: () => Promise<void>;
    approveTcp: (flow: AdmittedTcpFlow) => void;
};

const MAX_UDP_TUPLES = 4_096;

/** Owns new-flow admission, independently of DNS identity and established-flow lifetime. */
export class NetworkFlowAdmission {
    private readonly options: NetworkFlowAdmissionOptions;
    private readonly abortController = new AbortController();
    private readonly udpEntries = new Map<string, SyntheticUdpFlow>();
    private readonly udpReservations = new Set<string>();
    private readonly pending = new Set<Promise<NetworkDecision>>();
    private closed = false;

    constructor(options: NetworkFlowAdmissionOptions) {
        this.options = options;
    }

    admit(event: NetworkQueueEvent, callerSignal: AbortSignal): Promise<NetworkDecision> {
        const signal = AbortSignal.any([callerSignal, this.abortController.signal]);
        const pending = this.admitFlow(event, signal);
        this.pending.add(pending);
        void pending.finally(() => this.pending.delete(pending)).catch(() => {});
        return pending;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.abortController.abort();
        await Promise.allSettled(this.pending);
        try {
            if (this.udpEntries.size > 0) await this.options.clearUdp();
        } finally {
            this.udpEntries.clear();
            this.udpReservations.clear();
        }
    }

    private async admitFlow(queueEvent: NetworkQueueEvent, signal: AbortSignal): Promise<NetworkDecision> {
        this.assertOpen(signal);
        const identity = queueEvent.operation === NetworkOperation.DNS_QUERY ? null
            : this.options.leases.lookup(queueEvent.destination.address);
        const udp = identity && queueEvent.operation === NetworkOperation.UDP_FLOW ? queueEvent : null;
        const key = udp ? this.udpKey(udp) : null;
        if (key) {
            if (this.udpReservations.has(key)) throw new Error("synthetic UDP tuple admission already pending");
            if (!this.udpEntries.has(key)
                && this.udpEntries.size + [...this.udpReservations].filter((value) => !this.udpEntries.has(value)).length >= MAX_UDP_TUPLES) {
                throw new Error("synthetic UDP tuple limit exceeded");
            }
            this.udpReservations.add(key);
        }
        try {
            // NAT map lookups require ct ALLOW, so a reused tuple's pending or
            // denied packets cannot reach its old value. Keep the owned entry
            // until atomic delete+add replacement; established conntrack NAT
            // remains independent of both the map and DNS freshness.
            this.assertOpen(signal);
            const {event, binding} = await this.attribute(queueEvent, signal);
            const decision = await this.decide(event, signal);
            if (decision === NetworkDecision.DENY) {
                if (udp && key) await this.removeUdp(udp, key);
                return decision;
            }
            if (binding) this.options.leases.assertFresh(binding, signal);
            if (udp && key && binding) {
                const replace = this.udpEntries.has(key);
                // An interrupted nft process can have committed already. Account
                // for attempted installs until exact removal succeeds, including
                // when both install and removal outcomes are uncertain.
                this.udpEntries.set(key, udp);
                await this.options.updateUdp(udp, binding, replace);
                this.options.leases.assertFresh(binding, signal);
            }
            this.assertOpen(signal);
            if (event.operation === NetworkOperation.TCP_CONNECT && event.target.kind !== NetworkTargetKind.LOCALHOST) {
                this.options.approveTcp(event);
            }
            return NetworkDecision.ALLOW;
        } catch (error) {
            if (udp && key) await this.removeUdp(udp, key);
            throw error;
        } finally {
            if (key) this.udpReservations.delete(key);
        }
    }

    private async removeUdp(flow: SyntheticUdpFlow, key: string): Promise<void> {
        if (!this.udpEntries.has(key)) return;
        await this.options.updateUdp(flow, null, true);
        this.udpEntries.delete(key);
    }

    private async attribute(event: NetworkQueueEvent, signal: AbortSignal): Promise<{
        event: NetworkPolicyEvent; binding?: SyntheticDnsLease;
    }> {
        if (event.operation === NetworkOperation.DNS_QUERY) {
            const resolver = event.family === NetworkAddressFamily.IPV4 ? "10.0.2.3" : "fd00::3";
            if (event.destination.address !== resolver) {
                throw new Error(`direct DNS to an untrusted resolver is denied: ${event.destination.address}`);
            }
            return {event: {...event, target: {kind: NetworkTargetKind.HOSTNAME, hostname: event.dns.name}}};
        }
        const identity = this.options.leases.lookup(event.destination.address);
        if (identity) {
            if (identity.family !== event.family) throw new Error("synthetic DNS lease family mismatch");
            const binding = await this.options.leases.resolve(event.destination.address, signal, async () => {
                const dns: NetworkPolicyEvent = {
                    ...event, operation: NetworkOperation.DNS_QUERY, transport: "udp",
                    destination: {address: event.family === NetworkAddressFamily.IPV4 ? "10.0.2.3" : "fd00::3", port: 53},
                    dns: {name: identity.hostname, type: identity.family === NetworkAddressFamily.IPV4 ? "A" : "AAAA"},
                    target: {kind: NetworkTargetKind.HOSTNAME, hostname: identity.hostname},
                };
                if (await this.decide(dns, signal) !== NetworkDecision.ALLOW) throw new Error("DNS refresh policy denied");
            });
            return {binding, event: {...event, target: {
                kind: NetworkTargetKind.HOSTNAME, hostname: binding.hostname,
                port: event.destination.port, address: binding.realAddress, syntheticAddress: binding.syntheticAddress,
            }}};
        }
        if (this.options.leases.isSyntheticAddress(event.destination.address)) {
            throw new Error(`expired or unknown synthetic DNS lease: ${event.destination.address}`);
        }
        const address = event.destination.address;
        const loopback = address === "::1" || (isIP(address) === 4 && address.split(".")[0] === "127");
        return {event: {...event, target: {
            kind: loopback ? NetworkTargetKind.LOCALHOST : NetworkTargetKind.IP,
            address, port: event.destination.port,
        }}};
    }

    private async decide(event: NetworkPolicyEvent, signal: AbortSignal): Promise<NetworkDecision> {
        this.assertOpen(signal);
        const decision = await this.options.decide(event, signal);
        this.assertOpen(signal);
        if (decision !== NetworkDecision.ALLOW && decision !== NetworkDecision.DENY) {
            throw new Error(`invalid network decision: ${String(decision)}`);
        }
        return decision;
    }

    private udpKey(event: SyntheticUdpFlow): string {
        return `${event.family}\0${event.source.address}\0${event.source.port}\0${event.destination.address}\0${event.destination.port}`;
    }

    private assertOpen(signal: AbortSignal): void {
        if (this.closed || signal.aborted) throw new Error("network flow admission closed or aborted");
    }
}

/** Both addresses and ports are validated at the queue/DNS trust boundaries. */
export function syntheticUdpMapUpdate(flow: SyntheticUdpFlow, binding: SyntheticDnsLease | null, replace: boolean): string {
    const map = flow.family === NetworkAddressFamily.IPV4 ? "synthetic_udp4" : "synthetic_udp6";
    const tuple = `${flow.source.address} . ${flow.source.port} . ${flow.destination.address} . ${flow.destination.port}`;
    return (replace ? `delete element inet pi_network ${map} { ${tuple} }\n` : "")
        + (binding ? `add element inet pi_network ${map} { ${tuple} : ${binding.realAddress} }\n` : "");
}
