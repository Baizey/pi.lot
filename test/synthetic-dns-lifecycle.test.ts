import assert from "node:assert/strict";
import test from "node:test";
import {NetworkAddressFamily as Family} from "../src/policy/network/network-queue-protocol.js";
import {resolveDnsResponse, rewriteDnsResponse, SyntheticDnsLeaseTable} from "../src/policy/network/SyntheticDnsProxy.js";
import type {SyntheticDnsResolution} from "../src/policy/network/SyntheticDnsProxy.js";

const signal = new AbortController().signal;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function negativeResponse(hostname: string, type: "A" | "AAAA" | "TXT", flags = 0x8180): Buffer {
    const {message} = dnsResponse(hostname, []);
    message.writeUInt16BE(flags, 2);
    message.writeUInt16BE(type === "A" ? 1 : type === "AAAA" ? 28 : 16, message.length - 4);
    return message;
}

function dnsResponse(hostname: string, records: Array<{owner: string; ttl: number; cname?: string; address?: string}>) {
    const name = (value: string) => Buffer.concat([...value.split(".").map((label) =>
        Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(7, 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const pieces = [header, name(hostname), Buffer.from([0, 1, 0, 1])];
    const ttlOffsets: number[] = [];
    const dataOffsets: number[] = [];
    let offset = pieces.reduce((size, piece) => size + piece.length, 0);
    for (const record of records) {
        const owner = name(record.owner);
        const metadata = Buffer.alloc(10);
        const data = record.cname ? name(record.cname) : Buffer.from(record.address!.split(".").map(Number));
        metadata.writeUInt16BE(record.cname ? 5 : 1, 0);
        metadata.writeUInt16BE(1, 2);
        metadata.writeUInt32BE(record.ttl, 4);
        metadata.writeUInt16BE(data.length, 8);
        ttlOffsets.push(offset + owner.length + 4);
        dataOffsets.push(offset + owner.length + 10);
        pieces.push(owner, metadata, data);
        offset += owner.length + metadata.length + data.length;
    }
    return {message: Buffer.concat(pieces), ttlOffsets, dataOffsets};
}

test("DNS late reissue renews upstream freshness but retains the call-scoped identity across a client cache", async () => {
    let now = 1_000;
    let refreshes = 0;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => {
        refreshes++;
        return {receivedAt: now, answers: [{realAddress: "203.0.113.9", ttlSeconds: 60}]};
    }});
    const first = await leases.lease("dependency.test", Family.IPV4, "203.0.113.8", 120);
    assert.equal(first.expiresAt, 61_000);
    now = 56_000;
    const wire = dnsResponse("dependency.test", [{owner: "dependency.test", address: "203.0.113.8", ttl: 120}]);
    const rewritten = rewriteDnsResponse(wire.message, "dependency.test", leases, now);
    assert.equal(rewritten.subarray(wire.dataOffsets[0], wire.dataOffsets[0]! + 4).join("."), first.syntheticAddress);
    assert.equal(rewritten.readUInt32BE(wire.ttlOffsets[0]!), 60);
    assert.equal((await leases.resolve(first.syntheticAddress, signal, async () => {})).expiresAt, 116_000);
    // A client can reuse the token beyond both its original deadline and a 30-second client-cache window.
    now = 116_000;
    assert.equal(leases.lookup(first.syntheticAddress)?.hostname, "dependency.test");
    const refreshed = await leases.resolve(first.syntheticAddress, signal, async () => {});
    assert.equal(refreshed.syntheticAddress, first.syntheticAddress);
    assert.equal(refreshed.realAddress, "203.0.113.9");
    assert.equal(refreshes, 1);
    assert.equal(first.realAddress, "203.0.113.8", "previously admitted endpoint snapshots stay immutable");
    const reissued = await leases.lease("dependency.test", Family.IPV4, "203.0.113.8", 60);
    assert.equal(reissued.syntheticAddress, first.syntheticAddress);
    await leases.close();
});

test("requested hostname freshness includes every CNAME TTL, without turning TTL zero into one second", async () => {
    let now = 1_000;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("expired"); }});
    const wire = dnsResponse("requested.test", [
        {owner: "requested.test", cname: "middle.test", ttl: 30},
        {owner: "middle.test", cname: "terminal.test", ttl: 5},
        {owner: "terminal.test", address: "203.0.113.8", ttl: 120},
    ]);
    const rewritten = rewriteDnsResponse(wire.message, "requested.test", leases, now);
    assert.equal(rewritten.readUInt32BE(wire.ttlOffsets[2]!), 5);
    const address = rewritten.subarray(wire.dataOffsets[2], wire.dataOffsets[2]! + 4).join(".");
    now = 5_999;
    assert.equal((await leases.resolve(address, signal, async () => {})).hostname, "requested.test");
    now = 6_000;
    await assert.rejects(leases.resolve(address, signal, async () => {}), /expired/);
    const zero = dnsResponse("zero.test", [
        {owner: "zero.test", cname: "terminal.test", ttl: 0},
        {owner: "terminal.test", address: "203.0.113.8", ttl: 120},
    ]);
    assert.equal(rewriteDnsResponse(zero.message, "zero.test", leases, now).readUInt32BE(zero.ttlOffsets[1]!), 0);
    const short = await leases.lease("short.test", Family.IPV4, "203.0.113.8", 1);
    now += 999;
    assert.equal(leases.remainingTtlSeconds(short), 0);
    await leases.close();
});

test("ambiguous, cyclic and hostname-mismatched DNS chains cannot issue identities", () => {
    const leases = new SyntheticDnsLeaseTable({now: () => 0, refresh: async () => { throw new Error("unused"); }});
    for (const records of [
        [{owner: "a.test", cname: "b.test", ttl: 60}, {owner: "a.test", cname: "c.test", ttl: 60}],
        [{owner: "a.test", cname: "b.test", ttl: 60}, {owner: "b.test", cname: "a.test", ttl: 60}],
    ]) {
        const wire = dnsResponse("a.test", records);
        assert.throws(() => rewriteDnsResponse(wire.message, "a.test", leases, 0), /CNAME chain/);
    }
    assert.throws(() => rewriteDnsResponse(dnsResponse("a.test", []).message, "wrong.test", leases, 0), /hostname mismatch/);
});

test("same-host refresh coalesces, caller cancellation does not cancel another waiter, and newer DNS wins", async () => {
    let now = 0;
    let calls = 0;
    const response = deferred<SyntheticDnsResolution>();
    const started = deferred<void>();
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => {
        calls++; started.resolve(); return response.promise;
    }});
    const first = await leases.lease("coalesce.test", Family.IPV4, "203.0.113.8", 1);
    now = 1_000;
    const abort = new AbortController();
    const one = leases.resolve(first.syntheticAddress, abort.signal, async () => {});
    const two = leases.resolve(first.syntheticAddress, signal, async () => {});
    await started.promise;
    abort.abort();
    await assert.rejects(one, /aborted/);
    assert.equal(calls, 1);
    now = 2_000;
    const newer = await leases.lease("coalesce.test", Family.IPV4, "203.0.113.10", 60);
    now = 3_000;
    response.resolve({receivedAt: now, answers: [{realAddress: "203.0.113.9", ttlSeconds: 60}]});
    assert.equal((await two).realAddress, "203.0.113.10");
    assert.equal((await leases.resolve(newer.syntheticAddress, signal, async () => {})).realAddress, "203.0.113.10");
    await leases.close();
});

test("refresh failures, wrong families, synthetic upstreams, stale responses and policy denials fail closed", async () => {
    let now = 0;
    let refreshes = 0;
    let resolution: SyntheticDnsResolution = {receivedAt: 0, answers: []};
    let failure: Error | undefined;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => {
        refreshes++;
        if (failure) throw failure;
        return resolution;
    }});
    const lease = await leases.lease("fail.test", Family.IPV4, "203.0.113.8", 1);
    now = 1_000;
    await assert.rejects(leases.resolve(lease.syntheticAddress, signal, async () => { throw new Error("policy denied"); }), /policy denied/);
    assert.equal(refreshes, 0);
    for (const [realAddress, expected] of [["::1", /family/], ["198.18.0.99", /synthetic lease range/]] as const) {
        resolution = {receivedAt: now, answers: [{realAddress, ttlSeconds: 60}]};
        await assert.rejects(leases.resolve(lease.syntheticAddress, signal, async () => {}), expected);
    }
    resolution = {receivedAt: 0, answers: [{realAddress: "203.0.113.9", ttlSeconds: 1}]};
    await assert.rejects(leases.resolve(lease.syntheticAddress, signal, async () => {}), /no fresh/);
    failure = new Error("SERVFAIL");
    await assert.rejects(leases.resolve(lease.syntheticAddress, signal, async () => {}), /SERVFAIL/);
    assert.equal(leases.lookup(lease.syntheticAddress)?.hostname, "fail.test");
    await assert.rejects(leases.resolve("198.18.0.99", signal, async () => {}), /expired or unknown synthetic DNS lease: 198.18.0.99/);
    await leases.close();
});

test("identity capacity is lifetime bounded, repeated answers do not consume new identities, shared IPs stay separate", async () => {
    let now = 0;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("unused"); }});
    const first = await leases.lease("first.test", Family.IPV4, "203.0.113.8", 1);
    for (let i = 0; i < 4_096; i++) {
        now += 1_000;
        assert.equal((await leases.lease("first.test", Family.IPV4, "203.0.113.8", 1)).syntheticAddress, first.syntheticAddress);
    }
    for (let i = 1; i < 4_096; i++) {
        const next = await leases.lease(`host-${i}.test`, Family.IPV4, "203.0.113.8", 1);
        assert.notEqual(next.syntheticAddress, first.syntheticAddress);
    }
    await assert.rejects(leases.lease("overflow.test", Family.IPV4, "203.0.113.8", 1), /lease limit/);
    assert.equal(leases.lookup(first.syntheticAddress)?.hostname, "first.test");
    await leases.close();
    assert.equal(leases.lookup(first.syntheticAddress), null);
    await assert.rejects(leases.lease("closed.test", Family.IPV4, "203.0.113.8", 1), /closed/);
});

test("pending refresh capacity and shutdown are bounded and late responses cannot restore cleared state", async () => {
    let now = 0;
    let requests = 0;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async (_hostname, _family, abort) => {
        requests++;
        return new Promise((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("closed")), {once: true}));
    }});
    const addresses: string[] = [];
    for (let i = 0; i < 65; i++) addresses.push((await leases.lease(`pending-${i}.test`, Family.IPV4, "203.0.113.8", 1)).syntheticAddress);
    now = 1_000;
    const pending = addresses.slice(0, 64).map((address) => leases.resolve(address, signal, async () => {}).then(
        () => assert.fail("shutdown must reject pending refresh"), (error: Error) => assert.match(error.message, /closed/),
    ));
    // authorizeRefresh is asynchronous; let each refresh reserve its slot.
    await Promise.resolve();
    await assert.rejects(leases.resolve(addresses[64]!, signal, async () => {}), /pending refresh limit/);
    assert.equal(requests, 64);
    await leases.close();
    await Promise.all(pending);
    assert.equal(leases.lookup(addresses[0]!), null);
});

test("a DNS RRset uses its minimum TTL and delayed older answers cannot extend current freshness", async () => {
    let now = 1_000;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("no upstream"); }});
    const wire = dnsResponse("rrset.test", [
        {owner: "rrset.test", address: "203.0.113.8", ttl: 30},
        {owner: "rrset.test", address: "203.0.113.9", ttl: 5},
    ]);
    const rewritten = rewriteDnsResponse(wire.message, "rrset.test", leases, now);
    assert.deepEqual(wire.ttlOffsets.map((offset) => rewritten.readUInt32BE(offset)), [5, 5]);
    const token = rewritten.subarray(wire.dataOffsets[0], wire.dataOffsets[0]! + 4).join(".");
    now = 2_000;
    const binding = await leases.resolve(token, signal, async () => {});
    leases.recordAnswers("rrset.test", Family.IPV4, {receivedAt: 2_000,
        answers: [{realAddress: "203.0.113.10", ttlSeconds: 1}]});
    leases.recordAnswers("rrset.test", Family.IPV4, {receivedAt: 1_000,
        answers: [{realAddress: "203.0.113.8", ttlSeconds: 60}]});
    assert.throws(() => leases.assertFresh(binding, signal), /superseded/);
    const current = await leases.resolve(token, signal, async () => {});
    assert.equal(current.realAddress, "203.0.113.10");
    assert.equal(current.expiresAt, 3_000);
    now = 3_000;
    await assert.rejects(leases.resolve(token, signal, async () => {}), /no upstream/);
    await leases.close();
});

test("refresh TTL starts at response reception, never after an approval or completion wait", async () => {
    let now = 0;
    const answer = deferred<SyntheticDnsResolution>();
    const started = deferred<void>();
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => {
        started.resolve(); return answer.promise;
    }});
    const first = await leases.lease("delay.test", Family.IPV4, "203.0.113.8", 1);
    now = 1_000;
    const pending = leases.resolve(first.syntheticAddress, signal, async () => {});
    await started.promise;
    now = 6_000;
    answer.resolve({receivedAt: 1_000, answers: [{realAddress: "203.0.113.9", ttlSeconds: 5}]});
    await assert.rejects(pending, /no fresh/);
    await leases.close();
});

test("closing the call waits for a late refresh but never publishes its answer", async () => {
    let now = 0;
    const answer = deferred<SyntheticDnsResolution>();
    const started = deferred<void>();
    let upstreamSignal: AbortSignal | undefined;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async (_hostname, _family, abort) => {
        upstreamSignal = abort; started.resolve(); return answer.promise;
    }});
    const first = await leases.lease("shutdown.test", Family.IPV4, "203.0.113.8", 1);
    now = 1_000;
    const pending = leases.resolve(first.syntheticAddress, signal, async () => {});
    await started.promise;
    let closed = false;
    const closing = leases.close().then(() => { closed = true; });
    assert.equal(upstreamSignal?.aborted, true);
    await Promise.resolve();
    assert.equal(closed, false);
    answer.resolve({receivedAt: now, answers: [{realAddress: "203.0.113.9", ttlSeconds: 60}]});
    await assert.rejects(pending, /closed/);
    await closing;
    assert.equal(leases.lookup(first.syntheticAddress), null);
});

test("IPv6 identity spelling is canonical and synthetic embedded IPv4 tails never become literal flows", async () => {
    const leases = new SyntheticDnsLeaseTable({refresh: async () => { throw new Error("unused"); }});
    const lease = await leases.lease("six.test", Family.IPV6, "2001:db8::8", 60);
    assert.equal(leases.lookup("2001:0002:0000:0000:0000:0000:0000:0001")?.syntheticAddress, lease.syntheticAddress);
    assert.equal(leases.isSyntheticAddress("2001:2::198.18.0.1"), true);
    assert.equal(leases.lookup("::ffff:192.0.2.1"), null);
    await leases.close();
});

for (const path of ["rewrite", "refresh"] as const) {
    for (const withdrawal of ["NODATA", "NXDOMAIN"] as const) {
        test(`${path} ${withdrawal} supersedes bindings while retaining immutable identities`, async () => {
            let now = 0;
            const hostname = "withdraw.test";
            const packet = negativeResponse(hostname, "A", withdrawal === "NXDOMAIN" ? 0x8183 : 0x8180);
            const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async (_hostname, family) =>
                resolveDnsResponse(packet, hostname, family, leases, now)});
            const four = await leases.lease(hostname, Family.IPV4, "203.0.113.8", path === "refresh" ? 1 : 60);
            const six = await leases.lease(hostname, Family.IPV6, "2001:db8::8", 60);
            now = 1_000;
            if (path === "refresh") await assert.rejects(leases.resolve(four.syntheticAddress, signal, async () => {}), /no fresh/);
            else rewriteDnsResponse(packet, hostname, leases, now);
            assert.throws(() => leases.assertFresh(four, signal), /superseded|expired/);
            if (withdrawal === "NXDOMAIN") assert.throws(() => leases.assertFresh(six, signal), /superseded/);
            else leases.assertFresh(six, signal);
            assert.equal(leases.lookup(four.syntheticAddress)?.hostname, hostname);
            assert.equal(leases.lookup(six.syntheticAddress)?.family, Family.IPV6);
            await assert.rejects(leases.resolve(four.syntheticAddress, signal, async () => {}), /no fresh/);
            await leases.close();
        });
    }
}

test("NXDOMAIN from a non-address query withdraws both families; NODATA is family-specific", async () => {
    let now = 0;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("not available"); }});
    const four = await leases.lease("families.test", Family.IPV4, "203.0.113.8", 60);
    const six = await leases.lease("families.test", Family.IPV6, "2001:db8::8", 60);
    now = 1_000;
    rewriteDnsResponse(negativeResponse("families.test", "TXT"), "families.test", leases, now);
    leases.assertFresh(four, signal);
    leases.assertFresh(six, signal);
    rewriteDnsResponse(negativeResponse("families.test", "AAAA"), "families.test", leases, now);
    leases.assertFresh(four, signal);
    assert.throws(() => leases.assertFresh(six, signal), /superseded/);
    rewriteDnsResponse(negativeResponse("families.test", "TXT", 0x8183), "families.test", leases, now);
    assert.throws(() => leases.assertFresh(four, signal), /superseded/);
    await leases.close();
});

for (const flags of [0x8182, 0x8380, 0x8383]) {
    test(`SERVFAIL/truncation flags ${flags.toString(16)} are not authoritative withdrawals`, async () => {
        let now = 0;
        const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("unused"); }});
        const lease = await leases.lease("transient.test", Family.IPV4, "203.0.113.8", 60);
        now = 1_000;
        const packet = negativeResponse("transient.test", "A", flags);
        rewriteDnsResponse(packet, "transient.test", leases, now);
        assert.throws(() => resolveDnsResponse(packet, "transient.test", Family.IPV4, leases, now), /failed or was truncated/);
        leases.assertFresh(lease, signal);
        assert.equal((await leases.resolve(lease.syntheticAddress, signal, async () => {})).realAddress, lease.realAddress);
        await leases.close();
    });
}

test("an older positive refresh cannot resurrect a newer withdrawal even when received later", async () => {
    let now = 0;
    const response = deferred<SyntheticDnsResolution>();
    const started = deferred<void>();
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { started.resolve(); return response.promise; }});
    const old = await leases.lease("pending-withdraw.test", Family.IPV4, "203.0.113.8", 1);
    now = 1_000;
    const pending = leases.resolve(old.syntheticAddress, signal, async () => {});
    await started.promise;
    now = 2_000;
    rewriteDnsResponse(negativeResponse("pending-withdraw.test", "A", 0x8183), "pending-withdraw.test", leases, now);
    now = 3_000;
    response.resolve({receivedAt: now, answers: [{realAddress: "203.0.113.9", ttlSeconds: 60}]});
    await assert.rejects(pending, /no fresh/);
    assert.throws(() => leases.assertFresh(old, signal), /expired|superseded/);
    await leases.close();
});

for (const path of ["rewrite", "refresh"] as const) {
    test(`a pending never-issued ${path} response cannot resurrect an intervening NXDOMAIN`, async () => {
        let now = 0;
        const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("unused"); }});
        const ownership = leases.trackQuery("never-issued.test");
        now = 1_000;
        const negative = leases.trackQuery("never-issued.test");
        rewriteDnsResponse(negativeResponse("never-issued.test", "A", 0x8183), "never-issued.test", leases, now, negative);
        negative.release();
        now = 2_000;
        const positive = dnsResponse("never-issued.test", [{owner: "never-issued.test", address: "203.0.113.8", ttl: 60}]);
        assert.throws(() => path === "rewrite"
            ? rewriteDnsResponse(positive.message, "never-issued.test", leases, now, ownership)
            : resolveDnsResponse(positive.message, "never-issued.test", Family.IPV4, leases, now, ownership), /superseded/);
        assert.equal(leases.lookup("198.18.0.1"), null);
        ownership.release();
        await leases.close();
    });
}

test("negative watermarks respect reception ordering and internal typed negative results withdraw both families", async () => {
    let now = 1_000;
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () =>
        ({receivedAt: now, answers: [], withdrawal: "NXDOMAIN"})});
    const four = await leases.lease("typed-negative.test", Family.IPV4, "203.0.113.8", 1);
    const six = await leases.lease("typed-negative.test", Family.IPV6, "2001:db8::8", 60);
    rewriteDnsResponse(negativeResponse("typed-negative.test", "A", 0x8183), "typed-negative.test", leases, 0);
    leases.assertFresh(four, signal);
    leases.assertFresh(six, signal);
    now = 2_000;
    await assert.rejects(leases.resolve(four.syntheticAddress, signal, async () => {}), /no fresh/);
    assert.throws(() => leases.assertFresh(six, signal), /superseded/);
    await leases.close();
});

test("a newer internal NXDOMAIN still reaches both families when the queried family changed during refresh", async () => {
    let now = 0;
    const response = deferred<SyntheticDnsResolution>();
    const started = deferred<void>();
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { started.resolve(); return response.promise; }});
    const old = await leases.lease("changed-family.test", Family.IPV4, "203.0.113.8", 1);
    const six = await leases.lease("changed-family.test", Family.IPV6, "2001:db8::8", 60);
    now = 1_000;
    const pending = leases.resolve(old.syntheticAddress, signal, async () => {});
    await started.promise;
    now = 2_000;
    const newer = await leases.lease("changed-family.test", Family.IPV4, "203.0.113.9", 60);
    now = 3_000;
    response.resolve({receivedAt: now, answers: [], withdrawal: "NXDOMAIN"});
    await assert.rejects(pending, /no fresh/);
    assert.throws(() => leases.assertFresh(newer, signal), /superseded/);
    assert.throws(() => leases.assertFresh(six, signal), /superseded/);
    await leases.close();
});

test("withdrawal state is bounded by issued families plus 192 in-flight queries, and temporary watermarks are released", async () => {
    const leases = new SyntheticDnsLeaseTable({now: () => 1_000, refresh: async () => { throw new Error("unused"); }});
    for (let i = 0; i < 10_000; i++) leases.withdraw(`negative-${i}.test`, null, 1_000);
    // Never-issued names without active queries must retain no permanent watermark.
    const issued = leases.recordAnswers("negative-9999.test", Family.IPV4, {receivedAt: 0,
        answers: [{realAddress: "203.0.113.8", ttlSeconds: 60}]})[0]!;
    leases.assertFresh(issued, signal);
    const pending = Array.from({length: 192}, (_value, i) => leases.trackQuery(`tracked-${i}.test`));
    assert.throws(() => leases.trackQuery("overflow.test"), /tracked query limit/);
    for (let i = 0; i < pending.length; i++) leases.withdraw(`tracked-${i}.test`, null, 1_000);
    for (const ownership of pending) { ownership.release(); ownership.release(); }
    const next = leases.trackQuery("after-release.test");
    next.release();
    const after = leases.recordAnswers("tracked-191.test", Family.IPV4, {receivedAt: 0,
        answers: [{realAddress: "203.0.113.8", ttlSeconds: 60}]})[0]!;
    leases.assertFresh(after, signal);
    await leases.close();
    assert.throws(() => leases.trackQuery("closed.test"), /closed/);
});

test("filtered global AAAA NODATA withdraws a prior local binding, but transient failures do not", async () => {
    let now = 0;
    const hostname = "filter.test";
    const leases = new SyntheticDnsLeaseTable({now: () => now, refresh: async () => { throw new Error("unused"); }});
    const local = await leases.lease(hostname, Family.IPV6, "::1", 60);
    const four = await leases.lease(hostname, Family.IPV4, "203.0.113.8", 60);
    const wire = dnsResponse(hostname, [{owner: hostname, address: "32.1.13.184", ttl: 60}]);
    const packet = Buffer.concat([wire.message.subarray(0, wire.dataOffsets[0]), Buffer.from("20010db8000000000000000000000008", "hex")]);
    packet.writeUInt16BE(28, hostname.length + 14);
    packet.writeUInt16BE(28, wire.ttlOffsets[0]! - 4);
    packet.writeUInt16BE(16, wire.dataOffsets[0]! - 2);
    now = 1_000;
    for (const flags of [0x8182, 0x8380]) {
        packet.writeUInt16BE(flags, 2);
        assert.throws(() => rewriteDnsResponse(packet, hostname, leases, now, undefined, false), /failed or was truncated/);
        leases.assertFresh(local, signal);
    }
    packet.writeUInt16BE(0x8180, 2);
    const noData = rewriteDnsResponse(packet, hostname, leases, now, undefined, false);
    assert.equal(noData.readUInt16BE(6), 0);
    assert.equal(noData.readUInt16BE(2) & 0x000f, 0);
    assert.throws(() => leases.assertFresh(local, signal), /superseded/);
    leases.assertFresh(four, signal);
    await leases.close();
});
