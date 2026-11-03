import assert from "node:assert/strict";
import test from "node:test";
import {createHttpRequestEvent} from "../src/policy/network/HttpRequestPolicy.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import type {TcpGatewayApproval} from "../src/policy/network/TcpGatewayBroker.js";

const approval = (port: number): TcpGatewayApproval => ({
    family: NetworkAddressFamily.IPV4,
    source: {address: "10.200.0.2", port: 40_000},
    destination: {address: "198.18.0.1", port},
    upstream: {address: "127.0.0.1", port: 12_345},
    hostname: "service.test",
});

for (const scheme of ["http", "https"] as const) {
    test(`${scheme} authority preserves explicit default ports when checking the approved destination`, () => {
        for (const host of ["service.test:80", "service.test:00080", "[2001:db8::8]:80"]) {
            assert.throws(() => createHttpRequestEvent("POST", "/rpc", host, approval(8_080), scheme), /Host port differs/);
        }
        const matching = createHttpRequestEvent("POST", "/rpc", "service.test:80", approval(80), scheme);
        assert.equal(matching.port, 80);
        assert.equal(matching.url, scheme === "http" ? "http://service.test/rpc" : "https://service.test:80/rpc");
    });
}

test("authority syntax cannot hide a port through URL whitespace or path normalization", () => {
    for (const host of ["service.test:8\t0", "service.test:80/", "@service.test:80", " service.test:80"]) {
        assert.throws(() => createHttpRequestEvent("POST", "/rpc", host, approval(8_080), "http"), /invalid Host authority/);
    }
});

test("an omitted authority port still uses the approved flow and never selects the pinned upstream", () => {
    const event = createHttpRequestEvent("POST", "/service/../rpc?x=1", "service.test", approval(8_080), "https");
    assert.equal(event.url, "https://service.test:8080/rpc?x=1");
    assert.equal(event.port, 8_080);
    assert.equal(event.upstreamAddress, "127.0.0.1");
    assert.equal(event.destination.port, 8_080);
});
