import assert from "node:assert/strict";
import {once} from "node:events";
import {createConnection, createServer, type Socket} from "node:net";
import {connect as connectTls, createServer as createTlsServer} from "node:tls";
import test, {type TestContext} from "node:test";
import {TcpGatewayBroker, type TcpGatewayBrokerOptions} from "../src/policy/network/TcpGatewayBroker.js";
import {NetworkApplicationProtocol, type NetworkProtocolEvent} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";

const frame = (service: string) => Buffer.from(Buffer.byteLength(service).toString(16).padStart(4, "0") + service);
const request = frame("host:tport:serial:emulator-5554");
const okay = Buffer.from("OKAY");

for (const inspection of [true, false]) {
    test(`ADB denial blocks host effects with inspection ${inspection}`, {timeout: 3_000}, async (t) => {
        const events: NetworkProtocolEvent[] = [];
        const f = await fixture(t, {
            authorizeHttpRequest: inspection ? () => true : undefined,
            authorizeProtocol: (event) => { events.push(event); return false; },
        });
        const client = await f.connect(request);
        await client.closed;
        assert.equal(f.connections, 0);
        assert.equal(f.received.length, 0);
        assert.equal(events.length, 1);
        assert.deepEqual(events[0], {
            protocol: NetworkApplicationProtocol.ADB, uri: "adb.test:15037", family: NetworkAddressFamily.IPV4,
            source: {address: "10.200.0.2", port: 40001}, destination: {address: "198.18.0.1", port: 15037},
            upstreamAddress: "127.0.0.1",
        });
    });
}

for (const authorizeProtocol of [undefined, () => { throw new Error("review unavailable"); }]) {
    test(`ADB fails closed with ${authorizeProtocol ? "throwing" : "missing"} policy`, {timeout: 3_000}, async (t) => {
        const f = await fixture(t, {authorizeHttpRequest: () => true, authorizeProtocol});
        const client = await f.connect(request);
        await client.closed;
        assert.equal(f.connections, 0);
        assert.ok(f.errors.length > 0);
    });
}

test("ADB waits for approval and a complete server status before forwarding queued binary data", {timeout: 5_000}, async (t) => {
    const decision = deferred<boolean>();
    const reviewed = deferred<void>();
    const server = deferred<Socket>();
    const f = await fixture(t, {
        authorizeHttpRequest: () => true,
        authorizeProtocol: () => { reviewed.resolve(); return decision.promise; },
    }, (socket) => server.resolve(socket));
    const binary = Buffer.alloc(512 * 1024, 0xa5);
    const client = await f.connect(Buffer.concat([request, binary]));
    await reviewed.promise;
    assert.equal(f.connections, 0);
    decision.resolve(true);
    const upstream = await server.promise;
    await f.waitForReceived(request.length);
    assert.deepEqual(f.received, request);
    upstream.write("OK");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.received, request);
    assert.equal(client.bytes.length, 0);
    upstream.write("AY");
    await f.waitForReceived(request.length + binary.length);
    assert.deepEqual(f.received, Buffer.concat([request, binary]));
    upstream.end(binary);
    await client.closed;
    assert.deepEqual(client.bytes, Buffer.concat([okay, binary]));
    assert.deepEqual(f.errors, []);
});

test("ADB transport selection, subsequent service frames and a half-close preserve all bytes", {timeout: 5_000}, async (t) => {
    const server = deferred<Socket>();
    const f = await fixture(t, allowed(), (socket) => server.resolve(socket));
    const client = await f.connect(request);
    const upstream = await server.promise;
    await f.waitForReceived(request.length);
    const transportId = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
    upstream.write(Buffer.concat([okay, transportId]));
    await client.waitForBytes(12);
    const service = frame("exec:screencap -p");
    client.socket.end(service);
    await f.waitForReceived(request.length + service.length);
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 0, 255]);
    upstream.end(Buffer.concat([okay, image]));
    await client.closed;
    assert.deepEqual(f.received, Buffer.concat([request, service]));
    assert.deepEqual(client.bytes, Buffer.concat([okay, transportId, okay, image]));
    assert.deepEqual(f.errors, []);
});

test("ADB FAIL is preserved and never forwards queued follow-up commands", {timeout: 3_000}, async (t) => {
    const server = deferred<Socket>();
    const f = await fixture(t, allowed(), (socket) => server.resolve(socket));
    const client = await f.connect(Buffer.concat([request, frame("shell:must-not-run")]));
    const upstream = await server.promise;
    await f.waitForReceived(request.length);
    const failure = Buffer.concat([Buffer.from("FAIL"), frame("device offline")]);
    upstream.write(failure.subarray(0, 7));
    await new Promise((resolve) => setImmediate(resolve));
    upstream.end(failure.subarray(7));
    await client.closed;
    assert.deepEqual(client.bytes, failure);
    assert.deepEqual(f.received, request);
    assert.deepEqual(f.errors, []);
});

for (const response of ["HTTP/1.1 200 OK\r\n", "220 mail ESMTP ready\r\n", "NOPE", "OK", "FAILzzzz", "FAIL0008short"]) {
    test(`ADB rejects an invalid or truncated upstream response ${JSON.stringify(response)}`, {timeout: 3_000}, async (t) => {
        const f = await fixture(t, allowed(), (socket) => socket.once("data", () => socket.end(response)));
        const client = await f.connect(Buffer.concat([request, frame("shell:must-not-run")]));
        await client.closed;
        assert.deepEqual(f.received, request);
        assert.equal(client.bytes.length, 0);
        assert.ok(f.errors.length > 0);
    });
}

test("ADB FAIL reclaims connection slots even when clients keep their sending half open", {timeout: 15_000}, async (t) => {
    const failure = Buffer.from("FAIL0007offline");
    const f = await fixture(t, allowed(), (socket) => socket.once("data", () => socket.end(failure)));
    // Exceed the broker's active-connection limit. These clients deliberately do not
    // send FIN after receiving the terminal failure, and have queued service bytes.
    for (let index = 0; index < 1_026; index++) {
        const client = await f.connect(Buffer.concat([request, frame("shell:must-not-run")]), true);
        await once(client.socket, "end");
        assert.deepEqual(client.bytes, failure);
    }
    assert.equal(f.connections, 1_026);
    assert.deepEqual(f.received, Buffer.concat(Array.from({length: 1_026}, () => request)));
});

test("ADB cancellation during policy review prevents a late allow from opening upstream", {timeout: 3_000}, async (t) => {
    const decision = deferred<boolean>();
    const reviewed = deferred<AbortSignal>();
    const f = await fixture(t, {
        authorizeHttpRequest: () => true,
        authorizeProtocol: (_event, signal) => { reviewed.resolve(signal); return decision.promise; },
    });
    const client = await f.connect(request);
    const signal = await reviewed.promise;
    const aborted = once(signal, "abort");
    client.socket.resetAndDestroy();
    await aborted;
    decision.resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.connections, 0);
});

test("ADB client disconnect cancels the pending server handshake", {timeout: 3_000}, async (t) => {
    const server = deferred<Socket>();
    const f = await fixture(t, allowed(), (socket) => server.resolve(socket));
    const client = await f.connect(request);
    const upstream = await server.promise;
    await f.waitForReceived(request.length);
    const closed = once(upstream, "end");
    client.socket.resetAndDestroy();
    await closed;
    assert.ok(f.errors.some((error) => /abort/i.test(String(error))));
});

test("broker shutdown cancels an ADB handshake without releasing queued commands", {timeout: 3_000}, async (t) => {
    const f = await fixture(t, allowed());
    const client = await f.connect(Buffer.concat([request, frame("shell:must-not-run")]));
    await f.waitForReceived(request.length);
    await f.gateway.close();
    await client.closed;
    assert.deepEqual(f.received, request);
});

test("an incomplete ADB status times out without releasing follow-up bytes", {timeout: 7_000}, async (t) => {
    const f = await fixture(t, allowed(), (socket) => socket.once("data", () => socket.write("OK")));
    const client = await f.connect(Buffer.concat([request, frame("shell:must-not-run")]));
    await client.closed;
    assert.deepEqual(f.received, request);
    assert.equal(client.bytes.length, 0);
    assert.ok(f.errors.some((error) => /timed out/.test(String(error))));
});

test("a delayed ADB client is recognized after the silent-client probe", {timeout: 3_000}, async (t) => {
    let reviews = 0;
    const f = await fixture(t, {...allowed(), authorizeProtocol: (event) => {
        assert.equal(event.protocol, NetworkApplicationProtocol.ADB);
        reviews++;
        return true;
    }}, (socket) => socket.once("data", () => socket.end("OKAY00040029")));
    const client = await f.connect();
    await new Promise((resolve) => setTimeout(resolve, 350));
    client.socket.write(frame("host:version"));
    await client.closed;
    assert.equal(client.bytes.toString(), "OKAY00040029");
    assert.equal(reviews, 1);
    assert.equal(f.connections, 2, "the speculative connection is replaced by the approved ADB connection");
});

test("ADB over inspected TLS without ALPN uses the same protocol policy and verified upstream", {timeout: 5_000}, async (t) => {
    const upstreamCa = new TlsCertificateAuthority();
    const interceptionCa = new TlsCertificateAuthority();
    const f = await fixture(t, {
        ...allowed(), certificateAuthority: interceptionCa, additionalUpstreamCa: upstreamCa.certificatePem,
    }, (socket) => socket.once("data", () => socket.end("OKAY00040029")), upstreamCa);
    const transport = await f.connect();
    const tls = connectTls({socket: transport.socket, servername: "adb.test", ca: interceptionCa.certificatePem});
    t.after(() => tls.destroy());
    const client = new Client(tls);
    await once(tls, "secureConnect");
    tls.write(frame("host:version"));
    await client.closed;
    assert.equal(client.bytes.toString(), "OKAY00040029");
    assert.deepEqual(f.errors, []);
});

function allowed(): TcpGatewayBrokerOptions {
    return {authorizeHttpRequest: () => true, authorizeProtocol: (event) => event.protocol === NetworkApplicationProtocol.ADB};
}

async function fixture(t: TestContext, options: TcpGatewayBrokerOptions, onConnect: (socket: Socket) => void = () => {}, ca?: TlsCertificateAuthority) {
    const sockets = new Set<Socket>();
    const chunks: Buffer[] = [];
    const errors: unknown[] = [];
    let connections = 0;
    const accept = (socket: Socket) => {
        connections++;
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("data", (data: Buffer) => chunks.push(data));
        onConnect(socket);
    };
    const server = ca ? createTlsServer(ca.serverCredentials("adb.test"), accept) : createServer({allowHalfOpen: true}, accept);
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
    return {
        gateway, errors,
        get connections() { return connections; },
        get received() { return Buffer.concat(chunks); },
        async waitForReceived(length: number) {
            while (Buffer.concat(chunks).length < length) {
                t.signal.throwIfAborted();
                await new Promise((resolve) => setTimeout(resolve, 2));
            }
        },
        async connect(payload?: Buffer, allowHalfOpen = false) {
            const socket = createConnection({host: "127.0.0.1", port: gateway.port, allowHalfOpen});
            sockets.add(socket);
            const client = new Client(socket);
            await once(socket, "connect");
            gateway.approve({family: NetworkAddressFamily.IPV4, source: {address: "10.200.0.2", port: 40001},
                destination: {address: "198.18.0.1", port: 15037}, upstream: {address: "127.0.0.1", port: address.port}, hostname: "adb.test"});
            socket.write("PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t40001\t198.18.0.1\t15037\n");
            if (payload) socket.write(payload);
            return client;
        },
    };
}

class Client {
    private readonly chunks: Buffer[] = [];
    readonly closed: Promise<void>;
    constructor(readonly socket: Socket) {
        socket.on("error", () => {});
        socket.on("data", (data: Buffer) => this.chunks.push(data));
        this.closed = new Promise((resolve) => socket.once("close", resolve));
    }
    get bytes(): Buffer { return Buffer.concat(this.chunks); }
    async waitForBytes(length: number): Promise<void> {
        while (this.bytes.length < length) await once(this.socket, "data");
    }
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    return {promise: new Promise<T>((done) => { resolve = done; }), resolve};
}
