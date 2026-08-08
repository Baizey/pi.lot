import assert from "node:assert/strict";
import test from "node:test";
import {
    NetworkAddressFamily,
    NetworkDecision,
    NetworkDecisionCoordinator,
    NetworkOperation,
    NetworkPolicyProjector,
    NetworkTargetKind,
} from "../src/experiment/network/network-runner.js";
import type {
    NetworkPolicyEvent,
    NetworkPolicyGranularity,
    NetworkPolicyScope,
} from "../src/experiment/network/network-runner.js";
import {DEFAULT_NETWORK_POLICY_GRANULARITY} from "../src/experiment/network/NetworkPolicy.js";
import {SyntheticDnsLeaseTable} from "../src/experiment/network/SyntheticDnsProxy.js";

const signal = new AbortController().signal;

test("default network policy granularity does not distinguish operation or address family", () => {
    assert.deepEqual(DEFAULT_NETWORK_POLICY_GRANULARITY, {
        distinguishOperation: false,
        distinguishAddressFamily: false,
    });
});

test("network policy granularity projects one hostname into the configured approval matrix", async () => {
    const cases: Array<{
        granularity: NetworkPolicyGranularity;
        expectedDecisions: number;
        expectedReuses: number;
    }> = [
        {
            granularity: {distinguishOperation: false, distinguishAddressFamily: false},
            expectedDecisions: 1,
            expectedReuses: 3,
        },
        {
            granularity: {distinguishOperation: true, distinguishAddressFamily: false},
            expectedDecisions: 2,
            expectedReuses: 2,
        },
        {
            granularity: {distinguishOperation: false, distinguishAddressFamily: true},
            expectedDecisions: 3,
            expectedReuses: 1,
        },
        {
            granularity: {distinguishOperation: true, distinguishAddressFamily: true},
            expectedDecisions: 3,
            expectedReuses: 1,
        },
    ];

    for (const testCase of cases) {
        const decisions: NetworkPolicyScope[] = [];
        const reuses: NetworkPolicyScope[] = [];
        const coordinator = new NetworkDecisionCoordinator({
            granularity: testCase.granularity,
            decide(_event, scope) {
                decisions.push(scope);
                return NetworkDecision.ALLOW;
            },
            onDecisionReuse(_event, scope) {
                reuses.push(scope);
            },
        });

        for (const event of googleEvents()) {
            assert.equal(await coordinator.decide(event, signal), NetworkDecision.ALLOW);
        }
        assert.equal(decisions.length, testCase.expectedDecisions, JSON.stringify(testCase.granularity));
        assert.equal(reuses.length, testCase.expectedReuses, JSON.stringify(testCase.granularity));
    }
});

test("coarse hostname resolution grants host scope while direct flows grant one port", async () => {
    const projector = new NetworkPolicyProjector({
        distinguishOperation: false,
        distinguishAddressFamily: false,
    });
    const dnsScope = projector.project(dnsEvent(1, "example.com", "A"));
    const httpScope = projector.project(tcpEvent(2, "example.com", NetworkAddressFamily.IPV4, 80));
    const httpsScope = projector.project(tcpEvent(3, "example.com", NetworkAddressFamily.IPV4, 443));
    assert.equal(projector.covers(dnsScope, httpScope), true);
    assert.equal(projector.covers(dnsScope, httpsScope), true);
    assert.equal(projector.covers(httpScope, httpsScope), false);

    const reusedScopes: NetworkPolicyScope[] = [];
    const coordinator = new NetworkDecisionCoordinator({
        granularity:  {
            distinguishOperation: false,
            distinguishAddressFamily: false,
        },
        decide() {
            return NetworkDecision.ALLOW;
        },
        onDecisionReuse(_event, scope) {
            reusedScopes.push(scope);
        },
    });
    await coordinator.decide(dnsEvent(4, "example.com", "A"), signal);
    await coordinator.decide(tcpEvent(5, "example.com", NetworkAddressFamily.IPV4, 443), signal);
    assert.equal(reusedScopes[0]?.port, null);
});

test("synthetic DNS leases keep shared real addresses separated by authoritative hostname", async () => {
    let now = 1_000;
    const installed: string[] = [];
    const leases = new SyntheticDnsLeaseTable({
        now: () => now,
        install(lease) {
            installed.push(`${lease.syntheticAddress}->${lease.realAddress}`);
        },
    });
    const first = await leases.lease("first.example", NetworkAddressFamily.IPV4, "203.0.113.8", 120);
    const repeated = await leases.lease("first.example", NetworkAddressFamily.IPV4, "203.0.113.8", 120);
    const shared = await leases.lease("second.example", NetworkAddressFamily.IPV4, "203.0.113.8", 120);

    assert.equal(first, repeated);
    assert.notEqual(first.syntheticAddress, shared.syntheticAddress);
    assert.equal(first.expiresAt, 61_000);
    assert.equal(leases.remainingTtlSeconds(first), 60);
    assert.equal(leases.lookup(first.syntheticAddress)?.hostname, "first.example");
    assert.deepEqual(installed, [
        "198.18.0.1->203.0.113.8",
        "198.18.0.2->203.0.113.8",
    ]);

    now = first.expiresAt;
    assert.equal(leases.lookup(first.syntheticAddress), null);
    assert.equal(leases.isSyntheticAddress(first.syntheticAddress), true);
    assert.equal(leases.isSyntheticAddress("2001:2::1"), true);
    assert.equal(leases.isSyntheticAddress("2001:2:1::1"), false);
    await assert.rejects(
        leases.lease("invalid.example", NetworkAddressFamily.IPV4, "198.18.0.99", 30),
        /overlaps the synthetic lease range/,
    );
});

test("localhost identity collapses loopback address families only when configured", async () => {
    for (const [distinguishAddressFamily, expectedDecisions] of [[false, 1], [true, 2]] as const) {
        let decisions = 0;
        const coordinator = new NetworkDecisionCoordinator({
            granularity: {distinguishOperation: false, distinguishAddressFamily},
            decide() {
                decisions++;
                return NetworkDecision.ALLOW;
            },
        });
        await coordinator.decide(localhostEvent(1, NetworkAddressFamily.IPV4), signal);
        await coordinator.decide(localhostEvent(2, NetworkAddressFamily.IPV6), signal);
        assert.equal(decisions, expectedDecisions);
    }
});

test("operation-sensitive policy groups A and AAAA but separates other DNS types and UDP", async () => {
    const decisions: string[] = [];
    const coordinator = new NetworkDecisionCoordinator({
        granularity: {distinguishOperation: true, distinguishAddressFamily: false},
        decide(_event, scope) {
            decisions.push(scope.operation);
            return NetworkDecision.ALLOW;
        },
    });
    const events = [
        dnsEvent(1, "example.com", "A"),
        dnsEvent(2, "example.com", "AAAA"),
        dnsEvent(3, "example.com", "TXT"),
        tcpEvent(4, "example.com", NetworkAddressFamily.IPV4, 443),
        udpEvent(5, "example.com", NetworkAddressFamily.IPV4, 443),
    ];
    for (const event of events) await coordinator.decide(event, signal);
    assert.deepEqual(decisions, ["DNS_ADDRESS", "DNS_TXT", "TCP_CONNECT", "UDP_FLOW"]);
});

function localhostEvent(sequence: number, family: NetworkAddressFamily): NetworkPolicyEvent {
    const ipv4 = family === NetworkAddressFamily.IPV4;
    return {
        sequence,
        operation: NetworkOperation.TCP_CONNECT,
        family,
        transport: "tcp",
        source: {address: ipv4 ? "127.0.0.1" : "::1", port: 40_000 + sequence},
        destination: {address: ipv4 ? "127.0.0.1" : "::1", port: 8_080},
        target: {
            kind: NetworkTargetKind.LOCALHOST,
            address: ipv4 ? "127.0.0.1" : "::1",
            port: 8_080,
        },
    };
}

function googleEvents(): NetworkPolicyEvent[] {
    return [
        dnsEvent(1, "google.com", "A"),
        dnsEvent(2, "google.com", "AAAA"),
        tcpEvent(3, "google.com", NetworkAddressFamily.IPV6, 80),
        tcpEvent(4, "google.com", NetworkAddressFamily.IPV4, 80),
    ];
}

function dnsEvent(sequence: number, hostname: string, type: string): NetworkPolicyEvent {
    return {
        sequence,
        operation: NetworkOperation.DNS_QUERY,
        family: NetworkAddressFamily.IPV4,
        transport: "udp",
        source: {address: "10.0.2.100", port: 40_000 + sequence},
        destination: {address: "10.0.2.3", port: 53},
        dns: {name: hostname, type},
        target: {kind: NetworkTargetKind.HOSTNAME, hostname},
    };
}

function tcpEvent(
    sequence: number,
    hostname: string,
    family: NetworkAddressFamily,
    port: number,
): NetworkPolicyEvent {
    const ipv4 = family === NetworkAddressFamily.IPV4;
    return {
        sequence,
        operation: NetworkOperation.TCP_CONNECT,
        family,
        transport: "tcp",
        source: {address: ipv4 ? "10.0.2.100" : "fd00::100", port: 40_000 + sequence},
        destination: {address: ipv4 ? "198.18.0.1" : "2001:2::1", port},
        target: {
            kind: NetworkTargetKind.HOSTNAME,
            hostname,
            port,
            address: ipv4 ? "142.250.1.1" : "2001:4860:4860::8888",
            syntheticAddress: ipv4 ? "198.18.0.1" : "2001:2::1",
        },
    };
}

function udpEvent(
    sequence: number,
    hostname: string,
    family: NetworkAddressFamily,
    port: number,
): NetworkPolicyEvent {
    const ipv4 = family === NetworkAddressFamily.IPV4;
    return {
        sequence,
        operation: NetworkOperation.UDP_FLOW,
        family,
        transport: "udp",
        source: {address: ipv4 ? "10.0.2.100" : "fd00::100", port: 40_000 + sequence},
        destination: {address: ipv4 ? "198.18.0.1" : "2001:2::1", port},
        target: {
            kind: NetworkTargetKind.HOSTNAME,
            hostname,
            port,
            address: ipv4 ? "142.250.1.1" : "2001:4860:4860::8888",
            syntheticAddress: ipv4 ? "198.18.0.1" : "2001:2::1",
        },
    };
}
