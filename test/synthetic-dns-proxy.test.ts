import assert from "node:assert/strict";
import {createSocket, type Socket} from "node:dgram";
import {once} from "node:events";
import test, {type TestContext} from "node:test";
import {SyntheticDnsLeaseTable, SyntheticDnsProxy} from "../src/policy/network/SyntheticDnsProxy.js";
import {NetworkAddressFamily as Family} from "../src/policy/network/network-queue-protocol.js";

const hostname = "dependency.test";

function query(): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(42, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    return Buffer.concat([header, ...hostname.split(".").map((label) =>
        Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
}

function answer(request: Buffer, address: string, ttl: number): Buffer {
    const response = Buffer.concat([request, Buffer.alloc(16)]);
    response.writeUInt16BE(0x8180, 2);
    response.writeUInt16BE(1, 6);
    const offset = request.length;
    response.writeUInt16BE(0xc00c, offset);
    response.writeUInt16BE(1, offset + 2);
    response.writeUInt16BE(1, offset + 4);
    response.writeUInt32BE(ttl, offset + 6);
    response.writeUInt16BE(4, offset + 10);
    Buffer.from(address.split(".").map(Number)).copy(response, offset + 12);
    return response;
}

test("UDP DNS proxy retains a five-second token through a modeled thirty-second client cache", {timeout: 4_000}, async (t) => {
    let now = 56_000;
    let requests = 0;
    let refreshApprovals = 0;
    const f = await fixture(t, () => now, (request) => {
        requests++;
        return answer(request, requests === 1 ? "203.0.113.8" : "203.0.113.9", requests === 1 ? 5 : 60);
    });
    const packet = query();
    const response = await exchange(t, f.proxy.port, packet);
    assert.equal(response.readUInt32BE(packet.length + 6), 5);
    const token = response.subarray(-4).join(".");
    assert.match(token, /^198\.18\./);
    assert.equal(f.leases.lookup(token)?.hostname, hostname);
    const modeledClientExpiry = now + 30_000;
    now = 70_000;
    assert.ok(now < modeledClientExpiry);
    const binding = await f.leases.resolve(token, t.signal, async () => { refreshApprovals++; });
    assert.equal(binding.syntheticAddress, token);
    assert.equal(binding.realAddress, "203.0.113.9");
    assert.equal(binding.expiresAt, 130_000);
    assert.equal(refreshApprovals, 1);
    assert.equal(requests, 2);
    assert.deepEqual(f.errors, []);
});

test("mismatched trusted DNS reply cannot refresh an expired retained identity", {timeout: 4_000}, async (t) => {
    let now = 1_000;
    const f = await fixture(t, () => now, (request) => {
        const response = answer(request, "203.0.113.9", 60);
        response.writeUInt16BE((request.readUInt16BE(0) + 1) % 65_536, 0);
        return response;
    });
    const original = await f.leases.lease(hostname, Family.IPV4, "203.0.113.8", 1);
    now = 2_000;
    await assert.rejects(f.leases.resolve(original.syntheticAddress, t.signal, async () => {}), /did not match its query/);
    assert.equal(f.leases.lookup(original.syntheticAddress)?.hostname, hostname);
    assert.throws(() => f.leases.assertFresh(original, t.signal), /expired|fresh|superseded/);
});

test("cancelling a DNS refresh closes the pending upstream request", {timeout: 4_000}, async (t) => {
    let sent!: () => void;
    const requested = new Promise<void>((resolve) => { sent = resolve; });
    const f = await fixture(t, () => 1_000, () => { sent(); return undefined; });
    const controller = new AbortController();
    const resolving = f.proxy.resolve(hostname, Family.IPV4, controller.signal);
    const rejected = assert.rejects(resolving, /abort|cancel|closed/i);
    await requested;
    controller.abort();
    await rejected;
});

async function fixture(
    t: TestContext,
    now: () => number,
    respond: (request: Buffer) => Buffer | undefined,
) {
    const upstream = createSocket("udp4");
    const errors: unknown[] = [];
    upstream.bind(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    let proxy!: SyntheticDnsProxy;
    const leases = new SyntheticDnsLeaseTable({now, refresh: (name, family, signal) => proxy.resolve(name, family, signal)});
    proxy = new SyntheticDnsProxy({upstreamAddress: "127.0.0.1", upstreamPort: address.port, leases, now,
        onError: (error) => errors.push(error)});
    t.after(async () => {
        await proxy.close();
        await leases.close();
        await close(upstream);
    });
    upstream.on("error", (error) => errors.push(error));
    upstream.on("message", (request, remote) => {
        const response = respond(request);
        if (response) upstream.send(response, remote.port, remote.address);
    });
    await proxy.start();
    return {proxy, leases, errors};
}

async function exchange(t: TestContext, port: number, packet: Buffer): Promise<Buffer> {
    const client = createSocket("udp4");
    t.after(() => close(client));
    const reply = once(client, "message", {signal: t.signal});
    client.send(packet, port, "127.0.0.1");
    return (await reply)[0] as Buffer;
}

async function close(socket: Socket): Promise<void> {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
}
