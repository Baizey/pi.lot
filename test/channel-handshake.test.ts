import assert from "node:assert/strict";
import {once} from "node:events";
import {createConnection, createServer, type Socket} from "node:net";
import test, {type TestContext} from "node:test";
import {INCOMPLETE, MAX_CHANNEL_ENVELOPE_BYTES, type ChannelProbe, type ChannelProtocolDefinition} from "../src/policy/network/ChannelProtocol.js";
import {exchangeChannelHandshake, readChannelEnvelope} from "../src/policy/network/ChannelHandshake.js";
import {NetworkApplicationProtocol} from "../src/policy/network/NetworkProtocol.js";

function fixedEnvelope(length: number): (bytes: Buffer) => ChannelProbe {
    return (bytes) => bytes.length < length ? INCOMPLETE : {status: "match", length};
}

test("channel reader preserves a maximum-sized envelope and coalesced continuation", {timeout: 3_000}, async (t) => {
    const {reader, writer} = await socketPair(t);
    const envelope = Buffer.alloc(MAX_CHANNEL_ENVELOPE_BYTES, 0xa5);
    const continuation = Buffer.alloc(256 * 1024, 0x5a);
    const reading = readChannelEnvelope(reader, fixedEnvelope(envelope.length), t.signal);
    writer.write(Buffer.concat([envelope, continuation]));
    assert.deepEqual(await reading, envelope);
    const chunks: Buffer[] = [];
    reader.on("data", (bytes: Buffer) => chunks.push(bytes));
    writer.end();
    reader.resume();
    await once(reader, "end");
    assert.deepEqual(Buffer.concat(chunks), continuation);
});

test("channel reader contains parser exceptions and removes its listeners", {timeout: 3_000}, async (t) => {
    const {reader, writer} = await socketPair(t);
    const failure = new Error("test parser failure");
    const reading = readChannelEnvelope(reader, () => { throw failure; }, t.signal);
    writer.write("envelope");
    await assert.rejects(reading, (error: Error) => error.message === "Channel handshake parser failed" && error.cause === failure);
    assert.equal(reader.listenerCount("readable"), 0);
});

test("channel reader rejects an oversized incomplete envelope without consuming continuation", {timeout: 3_000}, async (t) => {
    const {reader, writer} = await socketPair(t);
    const reading = readChannelEnvelope(reader, () => INCOMPLETE, t.signal);
    writer.write(Buffer.alloc(MAX_CHANNEL_ENVELOPE_BYTES + 1));
    await assert.rejects(reading, /size limit/);
    assert.equal(reader.listenerCount("readable"), 0);
});

for (const payload of [Buffer.alloc(0), Buffer.from("short")]) {
    test(`channel reader rejects truncated EOF with ${payload.length} bytes`, {timeout: 3_000}, async (t) => {
        const {reader, writer} = await socketPair(t);
        const reading = readChannelEnvelope(reader, fixedEnvelope(100), t.signal);
        writer.end(payload);
        await assert.rejects(reading, /closed during handshake/);
        assert.equal(reader.listenerCount("readable"), 0);
    });
}

test("channel reader cancellation rejects and detaches listeners", {timeout: 3_000}, async (t) => {
    const {reader, writer} = await socketPair(t);
    const controller = new AbortController();
    const reading = readChannelEnvelope(reader, fixedEnvelope(100), controller.signal);
    writer.write("partial");
    controller.abort();
    await assert.rejects(reading, /aborted/);
    assert.equal(reader.listenerCount("readable"), 0);
});

test("terminal response returns its envelope without admitting either peer's queued continuation", {timeout: 3_000}, async (t) => {
    const downstream = await socketPair(t);
    const upstream = await socketPair(t);
    const definition: ChannelProtocolDefinition = {
        protocol: NetworkApplicationProtocol.NFS,
        initiation: "client",
        inspectClient: fixedEnvelope(3),
        inspectServer: fixedEnvelope(3),
        isTerminalResponse: () => true,
    };
    const received: Buffer[] = [];
    upstream.reader.on("data", (bytes: Buffer) => {
        received.push(bytes);
        upstream.reader.end("badUPSTREAM-TAIL");
    });
    const returned: Buffer[] = [];
    downstream.writer.on("data", (bytes: Buffer) => returned.push(bytes));
    const closed = once(downstream.writer, "end");
    const exchange = exchangeChannelHandshake(downstream.reader, upstream.writer, definition, t.signal);
    downstream.writer.write("reqCLIENT-TAIL");
    assert.equal(await exchange, false);
    await closed;
    assert.deepEqual(Buffer.concat(received), Buffer.from("req"));
    assert.deepEqual(Buffer.concat(returned), Buffer.from("bad"));
});

test("handshake gives each reader a fresh incremental inspector", {timeout: 3_000}, async (t) => {
    let requests = 0;
    let responses = 0;
    const definition: ChannelProtocolDefinition = {
        protocol: NetworkApplicationProtocol.REDIS,
        initiation: "client",
        inspectClient: () => { throw new Error("stateless request path must not run"); },
        inspectServer: () => { throw new Error("stateless response path must not run"); },
        createClientInspector: () => { requests++; return fixedEnvelope(3); },
        createServerInspector: (request) => {
            responses++;
            assert.deepEqual(request, Buffer.from("req"));
            return fixedEnvelope(3);
        },
    };
    for (let iteration = 0; iteration < 2; iteration++) {
        const downstream = await socketPair(t);
        const upstream = await socketPair(t);
        upstream.reader.once("data", () => upstream.reader.write("yes"));
        const exchange = exchangeChannelHandshake(downstream.reader, upstream.writer, definition, t.signal);
        downstream.writer.write("req");
        assert.equal(await exchange, true);
        assert.deepEqual(upstream.writer.read(3), Buffer.from("yes"));
    }
    assert.equal(requests, 2);
    assert.equal(responses, 2);
});

async function socketPair(t: TestContext): Promise<{reader: Socket; writer: Socket}> {
    const server = createServer({allowHalfOpen: true});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const accepted = once(server, "connection");
    const writer = createConnection({host: "127.0.0.1", port: address.port});
    const [reader] = await accepted as [Socket];
    reader.on("error", () => {});
    writer.on("error", () => {});
    t.after(async () => {
        reader.destroy();
        writer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return {reader, writer};
}
