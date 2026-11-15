import assert from "node:assert/strict";
import {once} from "node:events";
import {createConnection, createServer, type Socket} from "node:net";
import test, {type TestContext} from "node:test";
import {TcpGatewayBroker} from "../src/policy/network/TcpGatewayBroker.js";
import {NetworkApplicationProtocol as Protocol} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {channelEnvelopes} from "./fixtures/channel-envelopes.js";

const ping = Buffer.from("*1\r\n$4\r\nPING\r\n");
const auth = Buffer.from("*2\r\n$4\r\nAUTH\r\n$7\r\nfixture\r\n");
const continuation = Buffer.alloc(128 * 1024, 0xa5);
const challengePattern = /^\*2\r\n\$4\r\nPING\r\n\$(\d+)\r\n([^\r\n]+)\r\n$/;

for (const greeting of ["+OK POP3 server ready\r\n", "+OK Dovecot ready\r\n", "-ERR Unknown command\r\n"]) {
    test(`Redis confirmation cannot admit a POP3 envelope ${JSON.stringify(greeting)}`, {timeout: 4_000}, async (t) => {
        const f = await fixture(t, Protocol.REDIS, (socket) => {
            socket.write(greeting);
            socket.on("data", () => socket.write("-ERR Unknown command\r\n"));
        });
        const pop3 = Buffer.from("USER alice\r\nPASS not-a-real-secret\r\n");
        const client = await f.connect(Buffer.concat([ping, pop3]));
        await client.closed;
        assert.ok(f.received.subarray(0, ping.length).equals(ping));
        assert.equal(f.received.includes(pop3), false);
        assert.equal(client.bytes.length, 0);
        assert.equal(f.reviews, 1);
        assert.ok(f.errors.length > 0);
    });
}

test("Redis AUTH confirmation correlates a private nonce and never leaks the injected exchange", {timeout: 5_000}, async (t) => {
    const f = await fixture(t, Protocol.REDIS);
    const client = await f.connect(Buffer.concat([auth, continuation]));
    const upstream = await f.accepted;
    await f.wait(() => f.received.length >= auth.length);
    assert.deepEqual(f.received, auth);
    upstream.write("+OK\r\n");
    await f.wait(() => challengePattern.test(f.received.subarray(auth.length).toString("ascii")));
    const challenge = Buffer.from(f.received.subarray(auth.length));
    const match = challengePattern.exec(challenge.toString("ascii"))!;
    const nonce = match[2]!;
    assert.equal(Buffer.byteLength(nonce), Number(match[1]));
    assert.ok(nonce.length >= 16, "confirmation must carry an unpredictable nonce");
    const response = Buffer.from(`$${nonce.length}\r\n${nonce}\r\n`);
    upstream.write(response.subarray(0, response.length - 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.received, Buffer.concat([auth, challenge]));
    assert.equal(client.bytes.length, 0);
    const tail = Buffer.from("opaque post-confirmation response\0\xff");
    upstream.write(Buffer.concat([response.subarray(response.length - 1), tail]));
    await f.wait(() => f.received.length >= auth.length + challenge.length + continuation.length);
    upstream.end();
    await client.closed;
    assert.deepEqual(f.received, Buffer.concat([auth, challenge, continuation]));
    assert.deepEqual(client.bytes, Buffer.concat([Buffer.from("+OK\r\n"), tail]));
    assert.deepEqual(f.errors, []);
});

for (const reply of ["$5\r\nwrong\r\n", "-NOPERM PING denied\r\n"]) {
    test(`Redis ambiguous confirmation rejects ${JSON.stringify(reply)}`, {timeout: 4_000}, async (t) => {
        const f = await fixture(t, Protocol.REDIS);
        const client = await f.connect(Buffer.concat([auth, continuation]));
        const upstream = await f.accepted;
        await f.wait(() => f.received.length >= auth.length);
        upstream.write("+OK\r\n");
        await f.wait(() => challengePattern.test(f.received.subarray(auth.length).toString("ascii")));
        upstream.end(reply);
        await client.closed;
        assert.equal(f.received.includes(continuation), false);
        assert.equal(client.bytes.length, 0);
        assert.ok(f.errors.length > 0);
    });
}

test("PostgreSQL cancellation sends exactly its terminal frame and never admits continuation", {timeout: 4_000}, async (t) => {
    const f = await fixture(t, Protocol.POSTGRES);
    const cancel = Buffer.alloc(16);
    cancel.writeUInt32BE(16, 0);
    cancel.writeUInt32BE(80877102, 4);
    cancel.writeUInt32BE(42, 8);
    cancel.writeUInt32BE(123456, 12);
    const client = await f.connect(Buffer.concat([cancel, continuation]));
    const upstream = await f.accepted;
    const ended = once(upstream, "end");
    upstream.write("must-not-be-forwarded");
    await ended;
    await client.closed;
    assert.deepEqual(f.received, cancel);
    assert.equal(client.bytes.length, 0);
    assert.equal(f.reviews, 1);
});

for (const rejected of [
    {name: "PROG_UNAVAIL", words: [42, 1, 0, 0, 0, 1]},
    {name: "PROG_MISMATCH", words: [42, 1, 0, 0, 0, 2, 3, 3]},
    {name: "PROC_UNAVAIL", words: [42, 1, 0, 0, 0, 3]},
    {name: "GARBAGE_ARGS", words: [42, 1, 0, 0, 0, 4]},
    {name: "SYSTEM_ERR", words: [42, 1, 0, 0, 0, 5]},
    {name: "RPC_MISMATCH", words: [42, 1, 1, 0, 2, 2]},
    {name: "AUTH_ERROR", words: [42, 1, 1, 1, 1]},
]) {
    test(`NFS ${rejected.name} cannot admit a queued rpcbind channel`, {timeout: 4_000}, async (t) => {
        const request = channelEnvelopes.find((entry) => entry.protocol === Protocol.NFS)!.request;
        const rpcbind = Buffer.from(request);
        rpcbind.writeUInt32BE(100000, 16);
        const response = Buffer.alloc(4 + rejected.words.length * 4);
        response.writeUInt32BE(0x80000000 + response.length - 4, 0);
        rejected.words.forEach((word, index) => response.writeUInt32BE(word, 4 + index * 4));
        const f = await fixture(t, Protocol.NFS, (socket) => socket.once("data", () => socket.end(response)));
        const client = await f.connect(Buffer.concat([request, rpcbind, continuation]));
        await client.closed;
        assert.deepEqual(f.received, request);
        assert.deepEqual(client.bytes, response, "return the rejection without authorizing continuation");
        assert.equal(f.reviews, 1);
        assert.deepEqual(f.errors, []);
    });
}

async function fixture(t: TestContext, protocol: Protocol, onConnect: (socket: Socket) => void = () => {}) {
    const sockets = new Set<Socket>();
    const chunks: Buffer[] = [];
    const errors: unknown[] = [];
    let reviews = 0;
    let accept!: (socket: Socket) => void;
    const accepted = new Promise<Socket>((resolve) => { accept = resolve; });
    const server = createServer({allowHalfOpen: true}, (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("data", (bytes: Buffer) => chunks.push(bytes));
        accept(socket);
        onConnect(socket);
    });
    const gateway = new TcpGatewayBroker({authorizeHttpRequest: () => true, authorizeProtocol: (event) => {
        reviews++;
        assert.equal(event.protocol, protocol);
        return true;
    }, onError: (error) => errors.push(error)});
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
        accepted, errors,
        get received() { return Buffer.concat(chunks); },
        get reviews() { return reviews; },
        async wait(condition: () => boolean) {
            while (!condition()) {
                t.signal.throwIfAborted();
                await new Promise((resolve) => setTimeout(resolve, 2));
            }
        },
        async connect(payload: Buffer) {
            const socket = createConnection({host: "127.0.0.1", port: gateway.port});
            sockets.add(socket);
            const received: Buffer[] = [];
            socket.on("error", () => {});
            socket.on("data", (bytes: Buffer) => received.push(bytes));
            const closed = new Promise<void>((resolve) => socket.once("close", resolve));
            await once(socket, "connect");
            gateway.approve({family: NetworkAddressFamily.IPV4, source: {address: "10.200.0.2", port: 40001},
                destination: {address: "198.18.0.1", port: 15439}, upstream: {address: "127.0.0.1", port: address.port}, hostname: "service.test"});
            socket.write("PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t40001\t198.18.0.1\t15439\n");
            socket.write(payload);
            return {closed, get bytes() { return Buffer.concat(received); }};
        },
    };
}
