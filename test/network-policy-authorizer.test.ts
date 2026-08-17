import assert from "node:assert/strict";
import test from "node:test";
import {NetworkPolicyAuthorizer} from "../src/policy/network/NetworkPolicyAuthorizer.js";
import {NetworkAddressFamily, NetworkDecision, NetworkOperation} from "../src/policy/network/network-queue-protocol.js";
import {NetworkTargetKind} from "../src/policy/network/NetworkPolicy.js";
import type {NetworkPolicyEvent, NetworkPolicyScope} from "../src/policy/network/NetworkPolicy.js";
import type {HttpRequestEvent} from "../src/policy/network/HttpRequestBroker.js";
import type {ToolCallPathPolicyEvaluator} from "../src/policy/PolicyRuntime.js";
import {PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse, PolicyResult} from "../src/policy/types.js";

test("network authorizer maps coarse TCP scopes and exact HTTP methods into unified policy", async () => {
    const evaluations: Array<{uri: string; accessType: PolicyAccessType}> = [];
    const authorizer = new NetworkPolicyAuthorizer({
        policyEvaluator: evaluator(evaluations, PolicyResponse.ALLOWED),
        report: () => assert.fail("allowed policy must not be reported"),
    });
    const signal = new AbortController().signal;

    assert.equal(
        await authorizer.decide(tcpEvent(), tcpScope(), signal),
        NetworkDecision.ALLOW,
    );
    assert.equal(await authorizer.authorizeHttpRequest(httpEvent("PATCH"), signal), true);
    assert.deepEqual(evaluations, [
        {uri: "[2001:db8::8]:443", accessType: PolicyAccessType.TCP_ACCESS},
        {uri: "https://example.test/resource", accessType: PolicyAccessType.HTTP_PATCH},
    ]);
});

test("network authorizer fails closed and reports unified policy denials", async () => {
    const reports: string[] = [];
    const authorizer = new NetworkPolicyAuthorizer({
        policyEvaluator: evaluator([], PolicyResponse.DENIED),
        report: (message) => reports.push(message),
    });
    const signal = new AbortController().signal;

    assert.equal(await authorizer.decide(tcpEvent(), tcpScope(), signal), NetworkDecision.DENY);
    assert.equal(await authorizer.authorizeHttpRequest(httpEvent("GET"), signal), false);
    assert.equal(reports.length, 2);
    assert.equal(reports.every((message) => message.startsWith("ACCESS DENIED")), true);
});

function evaluator(
    evaluations: Array<{uri: string; accessType: PolicyAccessType}>,
    status: PolicyResponse,
): ToolCallPathPolicyEvaluator {
    return async (uri, accessType) => {
        evaluations.push({uri, accessType});
        return PolicyResult.of({
            evaluatedUri: uri,
            evaluatedAccessType: accessType,
            matchedPattern: uri,
            matchedLifetime: PolicyLifetime.ONCE,
            matchedStatus: status,
            matchedReason: "test",
            resolutionSource: PolicyResolutionSource.SYSTEM,
        });
    };
}

function tcpEvent(): NetworkPolicyEvent {
    return {
        sequence: 1,
        operation: NetworkOperation.TCP_CONNECT,
        family: NetworkAddressFamily.IPV6,
        transport: "tcp",
        source: {address: "fd42:7069::2", port: 40_000},
        destination: {address: "2001:db8::8", port: 443},
        target: {
            kind: NetworkTargetKind.IP,
            address: "2001:db8::8",
            port: 443,
        },
    };
}

function tcpScope(): NetworkPolicyScope {
    return {
        targetKind: NetworkTargetKind.IP,
        target: "2001:db8::8",
        port: 443,
        operation: "ANY",
        family: "ANY",
    };
}

function httpEvent(method: string): HttpRequestEvent {
    return {
        scheme: "https",
        method,
        url: "https://example.test/resource",
        hostname: "example.test",
        port: 443,
        path: "/resource",
        rawTarget: "/resource",
        family: NetworkAddressFamily.IPV4,
        source: {address: "10.200.0.2", port: 40_001},
        destination: {address: "198.18.0.1", port: 443},
        upstreamAddress: "203.0.113.8",
    };
}
