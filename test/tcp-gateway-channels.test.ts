import assert from "node:assert/strict";
import {once} from "node:events";
import {createConnection, createServer, type Socket} from "node:net";
import {connect as connectTls, createServer as createTlsServer} from "node:tls";
import test, {type TestContext} from "node:test";
import {TcpGatewayBroker, type TcpGatewayBrokerOptions} from "../src/policy/network/TcpGatewayBroker.js";
import {type NetworkProtocolEvent} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";
import {channelEnvelopes, type ChannelEnvelope} from "./fixtures/channel-envelopes.js";

const destinationPort = 15439; // Deliberately unrelated to every protocol's conventional port.
const clientTail = Buffer.alloc(256 * 1024, 0xa5);
const serverTail = Buffer.alloc(256 * 1024, 0x5a);
clientTail.set([0, 255, 13, 10, 128]);
serverTail.set([255, 0, 10, 13, 129]);

for (const envelope of channelEnvelopes) {
    const {protocol, initiation, request, response} = envelope;
    for (const inspection of [true, false]) {
        test(`${protocol}: denial with inspection ${inspection} withholds all application bytes`, {timeout: 4_000}, async (t) => {
            const events: NetworkProtocolEvent[] = [];
            const f = await fixture(t, {
                authorizeHttpRequest: inspection ? () => true : undefined,
                authorizeProtocol: (event) => { events.push(event); return false; },
            }, (socket) => { if (initiation === "server") socket.write(response); });
            const client = await f.connect(initiation === "client" ? Buffer.concat([request, clientTail]) : undefined);
            await client.closed;
            assert.equal(f.connections, initiation === "client" ? 0 : 1);
            assert.equal(f.received.length, 0);
            assert.equal(client.bytes.length, 0);
            assert.deepEqual(events, [targetEvent(envelope)]);
        });
    }

    for (const callback of ["missing", "throwing"] as const) {
        test(`${protocol}: ${callback} protocol policy fails closed`, {timeout: 4_000}, async (t) => {
            let calls = 0;
            const f = await fixture(t, {
                authorizeHttpRequest: () => true,
                authorizeProtocol: callback === "missing" ? undefined : () => { calls++; throw new Error("review unavailable"); },
            }, (socket) => { if (initiation === "server") socket.write(response); });
            const client = await f.connect(initiation === "client" ? Buffer.concat([request, clientTail]) : undefined);
            await client.closed;
            assert.equal(calls, callback === "missing" ? 0 : 1);
            assert.equal(f.connections, initiation === "client" ? 0 : 1);
            assert.equal(f.received.length, 0);
            assert.equal(client.bytes.length, 0);
            assert.ok(f.errors.length > 0);
        });
    }

    test(`${protocol}: fragmented admission waits for one deferred approval and preserves coalesced binary continuation`, {timeout: 6_000}, async (t) => {
        const decision = deferred<boolean>();
        const reviewed = deferred<void>();
        const events: NetworkProtocolEvent[] = [];
        const f = await fixture(t, {
            authorizeHttpRequest: () => true,
            authorizeProtocol: (event) => { events.push(event); reviewed.resolve(); return decision.promise; },
        });
        const client = await f.connect(initiation === "client" ? request.subarray(0, 1) : undefined);
        let upstream: Socket;
        if (initiation === "client") {
            await observe();
            assert.equal(events.length, 0, "a partial request cannot trigger approval");
            assert.equal(f.connections, 0);
            client.socket.write(Buffer.concat([request.subarray(1), clientTail]));
        } else {
            upstream = await f.accepted.promise;
            upstream.write(response.subarray(0, response.length - 1));
            await observe();
            assert.equal(events.length, 0, "a partial greeting cannot trigger approval");
            assert.equal(client.bytes.length, 0);
            upstream.write(Buffer.concat([response.subarray(response.length - 1), serverTail]));
        }
        await reviewed.promise;
        if (initiation === "server") client.socket.write(Buffer.concat([request, clientTail]));
        await observe();
        assert.equal(f.connections, initiation === "client" ? 0 : 1);
        assert.equal(f.received.length, 0);
        assert.equal(client.bytes.length, 0, "server greeting remains private during review");
        decision.resolve(true);
        upstream = await f.accepted.promise;
        if (initiation === "client") {
            await f.waitForReceived(request.length);
            assert.deepEqual(f.received, request, "only the admitted first frame may reach upstream");
            upstream.write(response.subarray(0, response.length - 1));
            await observe();
            assert.deepEqual(f.received, request, "a partial response must not release queued operations");
            assert.equal(client.bytes.length, 0);
            upstream.write(Buffer.concat([response.subarray(response.length - 1), serverTail]));
        }
        await f.waitForReceived(request.length + clientTail.length);
        await client.waitForBytes(response.length + serverTail.length);
        client.socket.end();
        await f.waitForUpstreamEnd(upstream);
        upstream.end();
        await client.closed;
        assert.equal(f.connections, 1, "the transport must use the pinned upstream exactly once");
        assert.deepEqual(events, [targetEvent(envelope)]);
        assert.deepEqual(f.received, Buffer.concat([request, clientTail]));
        assert.deepEqual(client.bytes, Buffer.concat([response, serverTail]));
        assert.deepEqual(f.errors, []);
    });

    if (initiation === "client") {
        const failures = [
            {name: "malformed", bytes: Buffer.alloc(20, 0xff)},
            {name: "truncated", bytes: response.subarray(0, response.length - 1)},
            {name: "different protocol", bytes: Buffer.from("HTTP/1.1 200 OK\r\n\r\n")},
            ...(envelope.contradictoryResponse ? [{name: "contradictory correlation", bytes: envelope.contradictoryResponse}] : []),
        ];
        for (const failure of failures) {
            test(`${protocol}: ${failure.name} response cannot release pipelined operations`, {timeout: 4_000}, async (t) => {
                let calls = 0;
                const f = await fixture(t, {authorizeHttpRequest: () => true, authorizeProtocol: () => { calls++; return true; }},
                    (socket) => socket.once("data", () => socket.end(failure.bytes)));
                const client = await f.connect(Buffer.concat([request, clientTail]));
                await client.closed;
                assert.equal(calls, 1);
                assert.deepEqual(f.received, request);
                assert.equal(client.bytes.length, 0);
                assert.ok(f.errors.length > 0);
            });
        }
    } else {
        for (const failure of ["malformed", "truncated"] as const) {
            test(`${protocol}: ${failure} greeting cannot authorize or disclose bytes`, {timeout: 4_000}, async (t) => {
                let calls = 0;
                const bytes = failure === "truncated" ? response.subarray(0, response.length - 1) : Buffer.from("NOT A PROTOCOL\r\n");
                const f = await fixture(t, {authorizeHttpRequest: () => true, authorizeProtocol: () => { calls++; return true; }},
                    (socket) => socket.end(bytes));
                const client = await f.connect();
                await client.closed;
                assert.equal(calls, 0);
                assert.equal(f.received.length, 0);
                assert.equal(client.bytes.length, 0);
                assert.ok(f.errors.length > 0);
            });
        }
    }
}

// Exercise cancellation and TLS on both state-machine directions, rather than only a client-first happy path.
const representatives = [channelEnvelopes[0]!, channelEnvelopes[1]!];
for (const envelope of representatives) {
    const {protocol, initiation, request, response} = envelope;
    for (const cancel of ["client disconnect", "broker shutdown"] as const) {
        test(`${protocol}: ${cancel} aborts review and ignores a late allow`, {timeout: 4_000}, async (t) => {
            const decision = deferred<boolean>();
            const reviewed = deferred<AbortSignal>();
            let calls = 0;
            const f = await fixture(t, {authorizeHttpRequest: () => true, authorizeProtocol: (_event, signal) => {
                calls++;
                reviewed.resolve(signal);
                return decision.promise;
            }}, (socket) => { if (initiation === "server") socket.write(response); });
            // Keep disconnect detection independent of a full paused read buffer: Node can
            // defer observing RST behind queued unread input. Large queued-byte preservation
            // is exercised separately by admission and broker-shutdown tests.
            const client = await f.connect(initiation === "client" ? request : undefined);
            const signal = await reviewed.promise;
            const aborted = once(signal, "abort");
            if (cancel === "client disconnect") client.socket.resetAndDestroy();
            else await f.gateway.close();
            await aborted;
            await client.closed;
            decision.resolve(true);
            await observe();
            assert.equal(calls, 1);
            assert.equal(f.connections, initiation === "client" ? 0 : 1);
            assert.equal(f.received.length, 0);
            assert.equal(client.bytes.length, 0);
        });
    }

    test(`${protocol}: incomplete upstream envelope times out without exposing or releasing bytes`, {timeout: 8_000}, async (t) => {
        const f = await fixture(t, allowed(), (socket) => {
            const partial = response.subarray(0, response.length - 1);
            if (initiation === "server") socket.write(partial);
            else socket.once("data", () => socket.write(partial));
        });
        const client = await f.connect(initiation === "client" ? Buffer.concat([request, clientTail]) : undefined);
        await client.closed;
        assert.deepEqual(f.received, initiation === "client" ? request : Buffer.alloc(0));
        assert.equal(client.bytes.length, 0);
        assert.ok(f.errors.length > 0);
    });

    test(`${protocol}: TLS without ALPN applies the same policy and verifies the pinned upstream`, {timeout: 6_000}, async (t) => {
        const upstreamCa = new TlsCertificateAuthority();
        const interceptionCa = new TlsCertificateAuthority();
        const events: NetworkProtocolEvent[] = [];
        const f = await fixture(t, {...allowed(), certificateAuthority: interceptionCa, additionalUpstreamCa: upstreamCa.certificatePem,
            authorizeProtocol: (event) => { events.push(event); return true; }}, (socket) => {
            if (initiation === "server") socket.write(response);
            else socket.once("data", () => socket.write(response));
        }, {ca: upstreamCa, hostname: "channels.test"});
        const client = await f.connectTls(interceptionCa);
        if (initiation === "client") client.socket.write(Buffer.concat([request, clientTail]));
        await client.waitForBytes(response.length);
        if (initiation === "server") client.socket.write(Buffer.concat([request, clientTail]));
        await f.waitForReceived(request.length + clientTail.length);
        const upstream = await f.accepted.promise;
        upstream.end(serverTail);
        await client.closed;
        assert.deepEqual(events, [targetEvent(envelope)]);
        assert.deepEqual(f.received, Buffer.concat([request, clientTail]));
        assert.deepEqual(client.bytes, Buffer.concat([response, serverTail]));
        assert.deepEqual(f.errors, []);
    });

    test(`${protocol}: TLS rejects a trusted certificate for the wrong upstream identity`, {timeout: 6_000}, async (t) => {
        const upstreamCa = new TlsCertificateAuthority();
        const interceptionCa = new TlsCertificateAuthority();
        const events: NetworkProtocolEvent[] = [];
        const f = await fixture(t, {...allowed(), certificateAuthority: interceptionCa, additionalUpstreamCa: upstreamCa.certificatePem,
            authorizeProtocol: (event) => { events.push(event); return true; }}, (socket) => {
            if (initiation === "server") socket.write(response);
            else socket.once("data", () => socket.write(response));
        }, {ca: upstreamCa, hostname: "wrong.test"});
        const client = await f.connectTls(interceptionCa);
        if (initiation === "client") client.socket.write(Buffer.concat([request, clientTail]));
        await client.closed;
        assert.equal(f.received.length, 0);
        assert.equal(client.bytes.length, 0);
        assert.deepEqual(events, initiation === "client" ? [targetEvent(envelope)] : []);
        assert.ok(f.errors.some((error) => /hostname|altname|certificate/i.test(String(error))));
    });
}

for (const cancel of ["client disconnect", "broker shutdown"] as const) {
    test(`postgres: ${cancel} cancels an admitted but unconfirmed handshake`, {timeout: 4_000}, async (t) => {
        const envelope = channelEnvelopes[0]!;
        let calls = 0;
        const f = await fixture(t, {authorizeHttpRequest: () => true, authorizeProtocol: () => { calls++; return true; }});
        // Broker shutdown must discard a full queued continuation. For disconnect,
        // leave the read buffer below its high-watermark so RST can be observed.
        const payload = cancel === "broker shutdown" ? Buffer.concat([envelope.request, clientTail]) : envelope.request;
        const client = await f.connect(payload);
        const upstream = await f.accepted.promise;
        await f.waitForReceived(envelope.request.length);
        const ended = once(upstream, "end", {signal: t.signal});
        if (cancel === "client disconnect") client.socket.resetAndDestroy();
        else await f.gateway.close();
        await ended;
        await client.closed;
        assert.equal(calls, 1);
        assert.deepEqual(f.received, envelope.request);
        assert.equal(client.bytes.length, 0);
    });
}

for (const envelope of channelEnvelopes.filter((entry) => entry.initiation === "client")) {
    test(`${envelope.protocol}: a delayed client replaces the silent speculative probe before sending its first frame`, {timeout: 5_000}, async (t) => {
        const events: NetworkProtocolEvent[] = [];
        const f = await fixture(t, {authorizeHttpRequest: () => true, authorizeProtocol: (event) => { events.push(event); return true; }},
            (socket) => socket.once("data", () => socket.end(envelope.response)));
        const client = await f.connect();
        const speculative = await f.accepted.promise;
        assert.equal(f.received.length, 0);
        const discarded = once(speculative, "end");
        client.socket.write(envelope.request);
        await discarded;
        await client.closed;
        assert.equal(f.connections, 2);
        assert.deepEqual(events, [targetEvent(envelope)]);
        assert.deepEqual(f.received, envelope.request);
        assert.deepEqual(client.bytes, envelope.response);
        assert.deepEqual(f.errors, []);
    });
}

function allowed(): TcpGatewayBrokerOptions {
    return {authorizeHttpRequest: () => true, authorizeProtocol: () => true};
}

function targetEvent(envelope: ChannelEnvelope): NetworkProtocolEvent {
    return {protocol: envelope.protocol, uri: `channels.test:${destinationPort}`, family: NetworkAddressFamily.IPV4,
        source: {address: "10.200.0.2", port: 40001}, destination: {address: "198.18.0.1", port: destinationPort},
        upstreamAddress: "127.0.0.1"};
}

async function fixture(t: TestContext, options: TcpGatewayBrokerOptions, onConnect: (socket: Socket) => void = () => {},
    tls?: {ca: TlsCertificateAuthority; hostname: string}) {
    const sockets = new Set<Socket>();
    const chunks: Buffer[] = [];
    const errors: unknown[] = [];
    const accepted = deferred<Socket>();
    let connections = 0;
    const accept = (socket: Socket) => {
        connections++;
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("data", (data: Buffer) => chunks.push(data));
        accepted.resolve(socket);
        onConnect(socket);
    };
    const server = tls ? createTlsServer(tls.ca.serverCredentials(tls.hostname), accept) : createServer({allowHalfOpen: true}, accept);
    server.on("tlsClientError", () => {});
    const gateway = new TcpGatewayBroker({...options, onError: (error) => errors.push(error)});
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await gateway.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await gateway.start();
    const connect = async (payload?: Buffer) => {
        const socket = createConnection({host: "127.0.0.1", port: gateway.port});
        sockets.add(socket);
        const client = new Client(socket, t.signal);
        await once(socket, "connect");
        gateway.approve({family: NetworkAddressFamily.IPV4, source: {address: "10.200.0.2", port: 40001},
            destination: {address: "198.18.0.1", port: destinationPort}, upstream: {address: "127.0.0.1", port: address.port}, hostname: "channels.test"});
        socket.write(`PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t40001\t198.18.0.1\t${destinationPort}\n`);
        if (payload) socket.write(payload);
        return client;
    };
    return {
        gateway, errors, accepted, connect,
        get connections() { return connections; },
        get received() { return Buffer.concat(chunks); },
        async waitForReceived(length: number) { await until(() => Buffer.concat(chunks).length >= length, t.signal); },
        async waitForUpstreamEnd(socket: Socket) { if (!socket.readableEnded) await once(socket, "end", {signal: t.signal}); },
        async connectTls(ca: TlsCertificateAuthority) {
            const transport = await connect();
            const socket = connectTls({socket: transport.socket, servername: "channels.test", ca: ca.certificatePem});
            sockets.add(socket);
            const client = new Client(socket, t.signal);
            await once(socket, "secureConnect", {signal: t.signal});
            assert.equal(socket.alpnProtocol, false);
            return client;
        },
    };
}

class Client {
    private readonly chunks: Buffer[] = [];
    readonly closed: Promise<void>;
    constructor(readonly socket: Socket, private readonly signal: AbortSignal) {
        socket.on("error", () => {});
        socket.on("data", (data: Buffer) => this.chunks.push(data));
        this.closed = new Promise((resolve) => socket.once("close", resolve));
    }
    get bytes(): Buffer { return Buffer.concat(this.chunks); }
    async waitForBytes(length: number): Promise<void> { await until(() => this.bytes.length >= length, this.signal); }
}

async function until(predicate: () => boolean, signal: AbortSignal): Promise<void> {
    while (!predicate()) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

// Deliberate negative-observation window after writing a fragment or pending-policy bytes.
async function observe(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 20)); }

function deferred<T = void>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    return {promise: new Promise<T>((done) => { resolve = done; }), resolve};
}
