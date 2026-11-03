import assert from "node:assert/strict";
import test from "node:test";
import {NetworkPolicyAuthorizer} from "../src/policy/network/NetworkPolicyAuthorizer.js";
import {NetworkAddressFamily, NetworkDecision, NetworkOperation} from "../src/policy/network/network-queue-protocol.js";
import {NetworkTargetKind} from "../src/policy/network/NetworkPolicy.js";
import type {NetworkPolicyEvent, NetworkPolicyScope} from "../src/policy/network/NetworkPolicy.js";
import type {HttpRequestEvent} from "../src/policy/network/HttpRequestBroker.js";
import {NetworkApplicationProtocol, type NetworkProtocolEvent} from "../src/policy/network/NetworkProtocol.js";
import type {ToolCallPathPolicyEvaluator} from "../src/policy/PolicyRuntime.js";
import {httpMethodAccessType, PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse, PolicyResult} from "../src/policy/types.js";

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

test("HTTP method classification preserves the full method table, case handling and unknown fallback", async () => {
    const cases: Array<[string, PolicyAccessType]> = [
        ["GET", PolicyAccessType.HTTP_GET],
        ["POST", PolicyAccessType.HTTP_POST],
        ["PUT", PolicyAccessType.HTTP_PUT],
        ["DELETE", PolicyAccessType.HTTP_DELETE],
        ["PATCH", PolicyAccessType.HTTP_PATCH],
        ["HEAD", PolicyAccessType.HTTP_HEAD],
        ["OPTIONS", PolicyAccessType.HTTP_OPTIONS],
        ["CONNECT", PolicyAccessType.HTTP_ACCESS],
        ["TRACE", PolicyAccessType.HTTP_ACCESS],
        ["custom", PolicyAccessType.HTTP_ACCESS],
        ["", PolicyAccessType.HTTP_ACCESS],
        [" GET ", PolicyAccessType.HTTP_ACCESS],
    ];
    const evaluations: Array<{uri: string; accessType: PolicyAccessType}> = [];
    const authorizer = new NetworkPolicyAuthorizer({
        policyEvaluator: evaluator(evaluations, PolicyResponse.ALLOWED),
        report: () => assert.fail("allowed policy must not be reported"),
    });
    for (const [method, expected] of cases) {
        for (const spelling of [method, method.toLowerCase(), method.slice(0, 1) + method.slice(1).toLowerCase()]) {
            assert.equal(httpMethodAccessType(spelling), expected, spelling);
            assert.equal(await authorizer.authorizeHttpRequest(httpEvent(spelling), new AbortController().signal), true);
            assert.equal(evaluations.at(-1)?.accessType, expected, spelling);
        }
    }
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

test("application protocols receive distinct policy checks rather than reusing transport authority", async () => {
    const evaluations: Array<{uri: string; accessType: PolicyAccessType}> = [];
    const reports: string[] = [];
    const authorizer = new NetworkPolicyAuthorizer({
        policyEvaluator: async (uri, accessType) => evaluator(evaluations,
            accessType === PolicyAccessType.TCP_ACCESS ? PolicyResponse.ALLOWED : PolicyResponse.DENIED)(uri, accessType),
        report: (message) => reports.push(message),
    });
    const signal = new AbortController().signal;
    assert.equal(await authorizer.decide(tcpEvent(), tcpScope(), signal), NetworkDecision.ALLOW);
    for (const [protocol, accessType] of [
        [NetworkApplicationProtocol.SSH, PolicyAccessType.SSH_ACCESS],
        [NetworkApplicationProtocol.SMTP, PolicyAccessType.SMTP_ACCESS],
        [NetworkApplicationProtocol.WEBSOCKET, PolicyAccessType.WEBSOCKET_ACCESS],
        [NetworkApplicationProtocol.GRPC, PolicyAccessType.GRPC_ACCESS],
    ] as const) {
        const event = protocolEvent(protocol);
        assert.equal(await authorizer.authorizeProtocol(event, signal), false);
        assert.deepEqual(evaluations.at(-1), {uri: event.uri, accessType});
    }
    assert.equal(reports.length, 4);
    assert.ok(reports.every((message) => message.startsWith("ACCESS DENIED")));
});

test("protocol policy approvals respect explicit allows and cancellation, including a late allow", async () => {
    const evaluations: Array<{uri: string; accessType: PolicyAccessType}> = [];
    const authorizer = new NetworkPolicyAuthorizer({
        policyEvaluator: evaluator(evaluations, PolicyResponse.ALLOWED),
        report: () => assert.fail("allowed policy must not report a denial"),
    });
    const controller = new AbortController();
    const event = protocolEvent(NetworkApplicationProtocol.SSH);
    assert.equal(await authorizer.authorizeProtocol(event, controller.signal), true);
    controller.abort();
    assert.equal(await authorizer.authorizeProtocol(event, controller.signal), false);
    assert.equal(evaluations.length, 1, "already-aborted operations do not start policy evaluation");
    const pending = new AbortController();
    const late = new NetworkPolicyAuthorizer({
        policyEvaluator: async (uri, accessType) => {
            pending.abort();
            return evaluator([], PolicyResponse.ALLOWED)(uri, accessType);
        },
        report: () => assert.fail("cancellation must not manufacture a policy decision"),
    });
    assert.equal(await late.authorizeProtocol(event, pending.signal), false);
});

function protocolEvent(protocol: NetworkApplicationProtocol): NetworkProtocolEvent {
    const event = httpEvent("POST");
    return {
        protocol,
        uri: protocol === NetworkApplicationProtocol.SSH || protocol === NetworkApplicationProtocol.SMTP
            ? "[2001:db8::8]:2222"
            : event.url,
        family: event.family,
        source: event.source,
        destination: event.destination,
        upstreamAddress: event.upstreamAddress,
    };
}

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
