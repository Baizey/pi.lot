import assert from "node:assert/strict";
import {once} from "node:events";
import {createConnection, createServer, type Socket} from "node:net";
import test, {type TestContext} from "node:test";
import {classifyTcpProtocol, sniffTcpProtocol, TcpApplicationProtocol} from "../src/policy/network/TcpProtocol.js";

const protocol = (value: string, direction: "client" | "server" = "client") => classifyTcpProtocol(Buffer.from(value), direction);

test("TCP classification distinguishes HTTP versions, TLS, SSH and SMTP without port guesses", () => {
    assert.equal(protocol("GET / HTTP/1.1\r\n"), TcpApplicationProtocol.HTTP1);
    assert.equal(protocol("OPTIONS * HTTP/1.0\r\n"), TcpApplicationProtocol.HTTP1);
    assert.equal(protocol("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"), TcpApplicationProtocol.HTTP2);
    assert.equal(classifyTcpProtocol(Buffer.from([0x16, 0x03, 0x03]), "client"), TcpApplicationProtocol.TLS);
    assert.equal(protocol("SSH-2.0-OpenSSH_10.0\r\n"), TcpApplicationProtocol.SSH);
    assert.equal(protocol("SSH-1.99-compatible server\r\n"), TcpApplicationProtocol.SSH);
    assert.equal(protocol("EHLO client.example\r\n"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("helo [127.0.0.1]\r\n"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("MAIL FROM:<sender@example.test>\r\n"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("RCPT TO:<recipient@example.test>\r\n"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("EHLO / HTTP/1.1\r\n"), TcpApplicationProtocol.HTTP1);
});

test("fragmented identification and HTTP2 prefaces are not prematurely classified", () => {
    for (const text of ["SSH-2.0-client\r\n", "EHLO client.example\r\n", "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"]) {
        for (let index = 0; index < text.length; index++) {
            assert.equal(protocol(text.slice(0, index)), undefined, JSON.stringify(text.slice(0, index)));
        }
    }
});

test("server-first SSH supports pre-identification and SMTP needs actual greeting evidence", () => {
    assert.equal(protocol("Authorized access only\r\nSSH-2.0-server\r\n", "server"), TcpApplicationProtocol.SSH);
    assert.equal(protocol("220 mail.example ESMTP ready\r\n", "server"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("220 mail.example Microsoft ESMTP MAIL Service ready\r\n", "server"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("220-mail.example ESMTP\r\n220 service ready\r\n", "server"), TcpApplicationProtocol.SMTP);
    assert.equal(protocol("220-mail.example ESMTP\r\n220 service", "server"), undefined);
    assert.equal(protocol("220 FTP server ready\r\n", "server"), TcpApplicationProtocol.OPAQUE);
    assert.equal(protocol("220 service ready\r\n", "server"), TcpApplicationProtocol.OPAQUE);
    assert.equal(protocol("220-mail ESMTP\r\ninvalid continuation\r\n", "server"), TcpApplicationProtocol.OPAQUE);
    assert.equal(protocol("220-mail ESMTP\r\nSSH-2.0-server\r\n", "server"), TcpApplicationProtocol.OPAQUE);
    assert.equal(protocol("unrelated banner\r\n220 mail ESMTP ready\r\n", "server"), TcpApplicationProtocol.OPAQUE);
    assert.equal(protocol("220 FTP server; SMTP disabled\r\n", "server"), TcpApplicationProtocol.OPAQUE);
});

test("malformed, oversized and binary identifications never authorize a stream", () => {
    for (const value of ["SSH-2.0-\r\n", "SSH-1.5-obsolete\r\n", "SSH-2.0-bad\u0000name\r\n", `SSH-2.0-${"x".repeat(250)}\r\n`, "not a protocol\r\n"]) {
        assert.equal(protocol(value), TcpApplicationProtocol.OPAQUE);
    }
    assert.equal(protocol("x".repeat(64 * 1024)), TcpApplicationProtocol.OPAQUE);
    assert.equal(protocol("x".repeat(64 * 1024), "server"), TcpApplicationProtocol.OPAQUE);
});

test("live sniffing returns fragmented bytes exactly once and leaves the socket paused", {timeout: 5_000}, async (t) => {
    const {client, accepted} = await socketPair(t);
    const sniffing = sniffTcpProtocol(accepted, "client", new AbortController().signal);
    client.write("SSH-2.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.write("0-test\r\ntrailing payload");
    const result = await sniffing;
    assert.equal(result.protocol, TcpApplicationProtocol.SSH);
    assert.equal(result.bytes.toString(), "SSH-2.0-test\r\ntrailing payload");
    assert.equal(accepted.isPaused(), true);
});

test("classification limits the envelope rather than a coalesced trailing body", {timeout: 5_000}, async (t) => {
    const {client, accepted} = await socketPair(t);
    const first = `GET /${"x".repeat(60_000)} HTTP/1.1`;
    const last = `\r\n${"body".repeat(8_000)}`;
    const sniffing = sniffTcpProtocol(accepted, "client", new AbortController().signal);
    const firstData = once(accepted, "data");
    client.write(first);
    await firstData;
    client.write(last);
    const result = await sniffing;
    assert.equal(result.protocol, TcpApplicationProtocol.HTTP1);
    const chunks: Buffer[] = [];
    accepted.unshift(result.bytes);
    accepted.on("data", (data: Buffer) => chunks.push(data));
    const ended = once(accepted, "end");
    accepted.resume();
    client.end();
    await ended;
    assert.equal(Buffer.concat(chunks).toString(), first + last);
});

test("cancelling a losing bidirectional reader restores its partial bytes", {timeout: 5_000}, async (t) => {
    const {client, accepted} = await socketPair(t);
    const controller = new AbortController();
    const sniffing = sniffTcpProtocol(accepted, "client", controller.signal, {initialWaitMilliseconds: 5_000});
    const firstData = once(accepted, "data");
    client.write("SSH-2.0-partial");
    await firstData;
    const rejected = assert.rejects(sniffing, /aborted/);
    controller.abort();
    await rejected;
    assert.equal(accepted.isPaused(), true);
    assert.equal(accepted.read().toString(), "SSH-2.0-partial");
});

test("live sniffing settles on disconnect and abort instead of stranding the flow", {timeout: 5_000}, async (t) => {
    const first = await socketPair(t);
    const disconnected = sniffTcpProtocol(first.accepted, "server", new AbortController().signal);
    const rejected = assert.rejects(disconnected, /closed before/);
    first.client.destroy();
    await rejected;
    const second = await socketPair(t);
    const controller = new AbortController();
    const cancelled = sniffTcpProtocol(second.accepted, "client", controller.signal);
    const aborted = assert.rejects(cancelled, /aborted/);
    controller.abort();
    await aborted;
});

async function socketPair(t: TestContext): Promise<{client: Socket; accepted: Socket}> {
    const server = createServer({allowHalfOpen: true});
    t.after(() => { server.close(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const accepting = once(server, "connection");
    const client = createConnection({host: "127.0.0.1", port: address.port});
    const connected = once(client, "connect");
    client.on("error", () => {});
    t.after(() => client.destroy());
    const [accepted] = await accepting as [Socket];
    accepted.on("error", () => {});
    t.after(() => accepted.destroy());
    await connected;
    return {client, accepted};
}
