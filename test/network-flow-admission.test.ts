import assert from "node:assert/strict";
import test from "node:test";
import {NetworkFlowAdmission, syntheticUdpMapUpdate} from "../src/policy/network/NetworkFlowAdmission.js";
import type {AdmittedTcpFlow, NetworkFlowAdmissionOptions, SyntheticUdpFlow} from "../src/policy/network/NetworkFlowAdmission.js";
import {NetworkDecisionCoordinator, NetworkTargetKind, DEFAULT_NETWORK_POLICY_GRANULARITY} from "../src/policy/network/NetworkPolicy.js";
import type {NetworkPolicyEvent} from "../src/policy/network/NetworkPolicy.js";
import {NetworkAddressFamily as Family, NetworkDecision as Decision, NetworkOperation as Operation} from "../src/policy/network/network-queue-protocol.js";
import type {NetworkQueueEvent} from "../src/policy/network/network-queue-protocol.js";
import {rewriteDnsResponse, SyntheticDnsLeaseTable} from "../src/policy/network/SyntheticDnsProxy.js";

const signal = new AbortController().signal;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return {promise, resolve};
}

function udp(address: string, port = 8_000, sourcePort = 40_000, family = Family.IPV4): SyntheticUdpFlow {
    return {sequence: 1, operation: Operation.UDP_FLOW, family, transport: "udp",
        source: {address: family === Family.IPV4 ? "10.200.0.2" : "fd42:7069::2", port: sourcePort},
        destination: {address, port}};
}

function tcp(address: string): Extract<NetworkQueueEvent, {operation: Operation.TCP_CONNECT}> {
    return {...udp(address), operation: Operation.TCP_CONNECT, transport: "tcp"};
}

function dns(): NetworkPolicyEvent {
    return {...udp("10.0.2.3", 53), operation: Operation.DNS_QUERY,
        dns: {name: "cache.test", type: "A"}, target: {kind: NetworkTargetKind.HOSTNAME, hostname: "cache.test"}};
}

function lateCnameResponse(): Buffer {
    const name = (value: string) => Buffer.concat([...value.split(".").map((label) =>
        Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(2, 6);
    const record = (owner: string, type: number, ttl: number, data: Buffer) => {
        const metadata = Buffer.alloc(10);
        metadata.writeUInt16BE(type, 0);
        metadata.writeUInt16BE(1, 2);
        metadata.writeUInt32BE(ttl, 4);
        metadata.writeUInt16BE(data.length, 8);
        return Buffer.concat([name(owner), metadata, data]);
    };
    return Buffer.concat([header, name("cache.test"), Buffer.from([0, 1, 0, 1]),
        record("cache.test", 5, 120, name("canonical.test")),
        record("canonical.test", 1, 5, Buffer.from([203, 0, 113, 8]))]);
}

function fixture() {
    let now = 0;
    const order: string[] = [];
    const approved: AdmittedTcpFlow[] = [];
    const kernel = new Map<string, string>();
    const key = (flow: SyntheticUdpFlow) => JSON.stringify([flow.family, flow.source, flow.destination]);
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => {
        order.push("resolver");
        return {receivedAt: now, answers: [{realAddress: "203.0.113.9", ttlSeconds: 5}]};
    }});
    const options: NetworkFlowAdmissionOptions = {
        leases,
        decide: (event) => { order.push(event.operation); return Decision.ALLOW; },
        updateUdp: async (flow, binding, replace) => {
            order.push(binding ? `install:${replace}` : "remove");
            if (replace) assert.equal(kernel.delete(key(flow)), true);
            if (binding) { assert.equal(kernel.has(key(flow)), false); kernel.set(key(flow), binding.realAddress); }
        },
        clearUdp: async () => { kernel.clear(); order.push("clear"); },
        approveTcp: (event) => { approved.push(event); order.push("approveTcp"); },
    };
    return {leases, options, order, approved, kernel, key, setNow: (value: number) => { now = value; }};
}

test("actual admission refreshes a five-second late answer behind a modeled 30-second Java cache", async () => {
    const f = fixture();
    const first = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    f.setNow(56_000);
    const rewritten = rewriteDnsResponse(lateCnameResponse(), "cache.test", f.leases, 56_000);
    assert.equal(rewritten.subarray(-4).join("."), first.syntheticAddress);
    const reissue = await f.leases.resolve(first.syntheticAddress, signal, async () => {});
    assert.equal(reissue.expiresAt, 61_000);
    // Java retains the synthetic identity until 86s, independently of the 61s DNS deadline.
    const admission = new NetworkFlowAdmission(f.options);
    for (const now of [62_000, 70_000]) {
        f.setNow(now);
        assert.equal(await admission.admit(tcp(first.syntheticAddress), signal), Decision.ALLOW);
        const approved = f.approved.at(-1)!;
        assert.equal(approved.target.kind, NetworkTargetKind.HOSTNAME);
        if (approved.target.kind !== NetworkTargetKind.HOSTNAME) assert.fail();
        assert.equal(approved.target.hostname, "cache.test");
        assert.equal(approved.target.syntheticAddress, first.syntheticAddress);
        assert.equal(approved.target.address, "203.0.113.9");
    }
    assert.deepEqual(f.order, [Operation.DNS_QUERY, "resolver", Operation.TCP_CONNECT, "approveTcp",
        Operation.DNS_QUERY, "resolver", Operation.TCP_CONNECT, "approveTcp"]);
    assert.equal(first.realAddress, "203.0.113.8");
    await admission.close();
    await f.leases.close();
});

test("refresh denial and unknown synthetic tokens never perform resolver work or literal fallback", async () => {
    const f = fixture();
    const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 1);
    f.setNow(1_000);
    f.options.decide = (event) => { f.order.push(event.operation); return Decision.DENY; };
    const admission = new NetworkFlowAdmission(f.options);
    await assert.rejects(admission.admit(tcp(lease.syntheticAddress), signal), /DNS refresh policy denied/);
    await assert.rejects(admission.admit(tcp("198.18.0.99"), signal), /unknown synthetic DNS lease/);
    await assert.rejects(admission.admit({...dns(), destination: {address: "203.0.113.53", port: 53}}, signal), /untrusted resolver/);
    assert.deepEqual(f.order, [Operation.DNS_QUERY]);
    assert.equal(f.approved.length, 0);
    await admission.close();
    await f.leases.close();
});

for (const stage of ["approval", "installation"] as const) {
    for (const change of ["expiry", "removed", "shortened", "NODATA", "NXDOMAIN"] as const) {
        test(`${stage} cannot admit an ${change} binding snapshot`, async () => {
            const f = fixture();
            const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 5);
            const entered = deferred<void>();
            const resume = deferred<void>();
            if (stage === "approval") {
                f.options.decide = async () => { entered.resolve(); await resume.promise; return Decision.ALLOW; };
            } else {
                const update = f.options.updateUdp;
                f.options.updateUdp = async (flow, binding, replace) => {
                    await update(flow, binding, replace);
                    if (binding) { entered.resolve(); await resume.promise; }
                };
            }
            const admission = new NetworkFlowAdmission(f.options);
            const pending = admission.admit(stage === "approval" ? tcp(lease.syntheticAddress) : udp(lease.syntheticAddress), signal);
            await entered.promise;
            f.setNow(change === "expiry" ? 5_000 : 1_000);
            if (change === "NODATA" || change === "NXDOMAIN") {
                const negative = Buffer.from(lateCnameResponse().subarray(0, 28));
                negative.writeUInt16BE(change === "NXDOMAIN" ? 0x8183 : 0x8180, 2);
                negative.writeUInt16BE(0, 6);
                rewriteDnsResponse(negative, "cache.test", f.leases, 1_000);
            } else if (change !== "expiry") {
                await f.leases.lease("cache.test", Family.IPV4, change === "removed" ? "203.0.113.10" : "203.0.113.8", 1);
            }
            resume.resolve();
            await assert.rejects(pending, /expired or superseded/);
            assert.equal(f.approved.length, 0);
            assert.equal(f.kernel.size, 0);
            await admission.close();
            await f.leases.close();
        });
    }
}

test("UDP tuple ownership separates ports, source addresses, destinations and families, and atomically replaces reuse", async () => {
    const f = fixture();
    const four = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    const six = await f.leases.lease("cache.test", Family.IPV6, "2001:db8::8", 60);
    const other = await f.leases.lease("other.test", Family.IPV4, "203.0.113.8", 60);
    const admission = new NetworkFlowAdmission(f.options);
    const old = udp(four.syntheticAddress);
    const flows = [old, udp(four.syntheticAddress, 8_001), udp(four.syntheticAddress, 8_000, 40_001),
        {...old, source: {address: "10.200.0.3", port: 40_000}},
        udp(other.syntheticAddress), udp(six.syntheticAddress, 8_000, 40_000, Family.IPV6)];
    for (const flow of flows) assert.equal(await admission.admit(flow, signal), Decision.ALLOW);
    assert.equal(f.kernel.size, flows.length);
    await f.leases.lease("cache.test", Family.IPV4, "203.0.113.9", 60);
    assert.equal(await admission.admit(old, signal), Decision.ALLOW);
    assert.equal(f.kernel.get(f.key(old)), "203.0.113.9");
    assert.equal(f.kernel.get(f.key(flows[1]!)), "203.0.113.8", "another tuple's installed snapshot is unchanged");
    assert.equal(f.order.at(-1), "install:true");
    const binding = await f.leases.resolve(four.syntheticAddress, signal, async () => {});
    const batch = syntheticUdpMapUpdate(old, binding, true);
    assert.match(batch, /^delete element inet pi_network synthetic_udp4/);
    assert.match(batch, /\nadd element inet pi_network synthetic_udp4/);
    assert.equal(batch.includes("flush"), false);
    await admission.close();
    assert.equal(f.kernel.size, 0);
    await assert.rejects(admission.admit(old, signal), /closed/);
    await f.leases.close();
});

test("pending tuple ownership serializes replacement, denial removes its old map, and cancellation cleans an installed map", async () => {
    const f = fixture();
    const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    const flow = udp(lease.syntheticAddress);
    const admission = new NetworkFlowAdmission(f.options);
    await admission.admit(flow, signal);
    const entered = deferred<void>();
    const resume = deferred<void>();
    f.options.decide = async () => { entered.resolve(); await resume.promise; return Decision.DENY; };
    const pending = admission.admit(flow, signal);
    await entered.promise;
    await assert.rejects(admission.admit(flow, signal), /already pending/);
    resume.resolve();
    assert.equal(await pending, Decision.DENY);
    assert.equal(f.kernel.size, 0);
    const abort = new AbortController();
    f.options.decide = () => Decision.ALLOW;
    const update = f.options.updateUdp;
    f.options.updateUdp = async (value, binding, replace) => { await update(value, binding, replace); if (binding) abort.abort(); };
    await assert.rejects(admission.admit(flow, abort.signal), /aborted/);
    assert.equal(f.kernel.size, 0);
    await admission.close();
    await f.leases.close();
});

test("uncertain UDP install/removal outcomes remain lifetime bounded, including reservations", async () => {
    const f = fixture();
    const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    let attempts = 0;
    f.options.updateUdp = async () => { attempts++; throw new Error("uncertain kernel outcome"); };
    const admission = new NetworkFlowAdmission(f.options);
    for (let i = 0; i < 4_096; i++) {
        await assert.rejects(admission.admit(udp(lease.syntheticAddress, 8_000, 10_000 + i), signal), /uncertain kernel outcome/);
    }
    assert.equal(attempts, 8_192, "each attempted install is followed by exact cleanup");
    await assert.rejects(admission.admit(udp(lease.syntheticAddress, 8_000, 20_000), signal), /tuple limit/);
    assert.equal(attempts, 8_192);
    await admission.close();
    assert.equal(f.order.at(-1), "clear");
    await f.leases.close();
});

test("UDP reservations share the same bound as installed entries and close cancels every waiter", async () => {
    const f = fixture();
    const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    const approval = deferred<Decision>();
    f.options.decide = () => approval.promise;
    const admission = new NetworkFlowAdmission(f.options);
    const pending = Array.from({length: 4_096}, (_value, i) =>
        admission.admit(udp(lease.syntheticAddress, 8_000, 10_000 + i), signal)
            .then(() => assert.fail("cancelled reservation admitted"), (error: Error) => assert.match(error.message, /aborted/)));
    await assert.rejects(admission.admit(udp(lease.syntheticAddress, 8_000, 20_000), signal), /tuple limit/);
    const closing = admission.close();
    approval.resolve(Decision.ALLOW);
    await Promise.all(pending);
    await closing;
    assert.equal(f.kernel.size, 0);
    assert.equal(f.order.some((item) => item.startsWith("install")), false);
    await f.leases.close();
});

test("an uncertain committed install can release capacity only after conclusive exact removal", async () => {
    const f = fixture();
    const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    const update = f.options.updateUdp;
    f.options.updateUdp = async (flow, binding, replace) => {
        await update(flow, binding, replace);
        if (binding) throw new Error("lost completion after kernel commit");
    };
    const admission = new NetworkFlowAdmission(f.options);
    const flow = udp(lease.syntheticAddress);
    await assert.rejects(admission.admit(flow, signal), /lost completion/);
    assert.equal(f.kernel.size, 0);
    f.options.updateUdp = update;
    assert.equal(await admission.admit(flow, signal), Decision.ALLOW);
    assert.equal(f.order.at(-1), "install:false", "successful exact cleanup removed the old ownership record");
    await admission.close();
    await f.leases.close();
});

test("close cancels pending admission and waits for installed-map cleanup without publishing ALLOW", async () => {
    const f = fixture();
    const lease = await f.leases.lease("cache.test", Family.IPV4, "203.0.113.8", 60);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const update = f.options.updateUdp;
    f.options.updateUdp = async (flow, binding, replace) => {
        await update(flow, binding, replace);
        if (binding) { entered.resolve(); await resume.promise; }
    };
    const admission = new NetworkFlowAdmission(f.options);
    const pending = admission.admit(udp(lease.syntheticAddress), signal);
    await entered.promise;
    const closed = admission.close();
    resume.resolve();
    await assert.rejects(pending, /closed or aborted/);
    await closed;
    assert.equal(f.kernel.size, 0);
    await f.leases.close();
});

test("cached DNS scope revalidates its original event while retaining cross-port/transport/family coverage", async () => {
    const checked: NetworkPolicyEvent[] = [];
    let live = Decision.ALLOW;
    const coordinator = new NetworkDecisionCoordinator({granularity: DEFAULT_NETWORK_POLICY_GRANULARITY,
        decide: (event, scope) => { checked.push(event); assert.equal(scope.port, null); return live; }});
    const original = dns();
    assert.equal(await coordinator.decide(original, signal), Decision.ALLOW);
    const flow = {...udp("2001:2::1", 9_000, 40_001, Family.IPV6), target: {
        kind: NetworkTargetKind.HOSTNAME, hostname: "cache.test", address: "2001:db8::8", syntheticAddress: "2001:2::1", port: 9_000,
    }} as const;
    assert.equal(await coordinator.decide(flow, signal), Decision.ALLOW);
    assert.deepEqual(checked, [original, original]);
    live = Decision.DENY;
    assert.equal(await coordinator.decide(flow, signal), Decision.DENY);
    assert.deepEqual(checked, [original, original, original]);
    assert.equal(await coordinator.decide(original, signal), Decision.DENY);
});

for (const result of ["deny", "error", "cancel"] as const) {
    test(`older overlapping ALLOW cannot resurrect a newer ${result} revalidation`, async () => {
        const old = deferred<Decision>();
        let calls = 0;
        const abort = new AbortController();
        const coordinator = new NetworkDecisionCoordinator({granularity: DEFAULT_NETWORK_POLICY_GRANULARITY,
            decide: () => {
                calls++;
                if (calls === 1) return Decision.ALLOW;
                if (calls === 2) return old.promise;
                if (result === "error") throw new Error("live policy failed");
                if (result === "cancel") { abort.abort(); return Decision.ALLOW; }
                return Decision.DENY;
            }});
        await coordinator.decide(dns(), signal);
        const pending = coordinator.decide(dns(), signal);
        if (result === "deny") assert.equal(await coordinator.decide(dns(), signal), Decision.DENY);
        else await assert.rejects(coordinator.decide(dns(), abort.signal), result === "error" ? /live policy failed/ : /aborted/);
        old.resolve(Decision.ALLOW);
        assert.equal(await pending, Decision.DENY);
        if (result === "deny") {
            assert.equal(await coordinator.decide(dns(), signal), Decision.DENY);
            assert.equal(calls, 3);
        } else {
            // Failed revalidation deleted the old ALLOW, so a fresh check is mandatory.
            await coordinator.decide(dns(), signal).catch(() => {});
            assert.equal(calls, 4);
        }
    });
}
