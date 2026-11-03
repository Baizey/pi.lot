import assert from "node:assert/strict";
import {once} from "node:events";
import {createConnection, createServer, type Socket} from "node:net";
import test from "node:test";
import type {TestContext} from "node:test";
import {TcpGatewayBroker} from "../src/policy/network/TcpGatewayBroker.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";

const SSH_SERVER = "Authorized access only\r\nSSH-2.0-fixture-server\r\n";
const SSH_CLIENT = "SSH-2.0-fixture-client\r\n";

type StreamFixtureOptions = {
    authorizeProtocol: (protocol: string) => boolean;
    onUpstream: (socket: Socket) => void;
};

async function fixture(t: TestContext, options: StreamFixtureOptions) {
    const sockets = new Set<Socket>();
    const reviews: string[] = [];
    const errors: unknown[] = [];
    const upstream = createServer({allowHalfOpen: true}, (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        options.onUpstream(socket);
    });
    const gateway = new TcpGatewayBroker({
        authorizeHttpRequest: () => false,
        onError: (error) => errors.push(error),
        authorizeProtocol: (event) => {
            reviews.push(event.protocol);
            return options.authorizeProtocol(event.protocol);
        },
    });
    t.after(async () => {
        await gateway.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    await gateway.start();
    return {gateway, reviews, errors, upstreamPort: address.port};
}

function smtpServer(onAccepted: () => void): (socket: Socket) => void {
    return (socket) => {
        socket.write("220 mail.test ESMTP ready\r\n");
        let buffered = "";
        let data = false;
        socket.on("data", (chunk) => {
            buffered += chunk.toString();
            let newline: number;
            while ((newline = buffered.indexOf("\r\n")) >= 0) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 2);
                if (data) {
                    if (line === ".") {
                        data = false;
                        onAccepted();
                        socket.write("250 fixture accepted\r\n");
                    }
                } else if (/^EHLO /i.test(line)) socket.write("250 mail.test\r\n");
                else if (/^(MAIL FROM:|RCPT TO:)/i.test(line)) socket.write("250 OK\r\n");
                else if (line.toUpperCase() === "DATA") {
                    data = true;
                    socket.write("354 fixture data\r\n");
                } else socket.write("500 unknown command\r\n");
            }
        });
    };
}

async function connectClient(t: TestContext, port: number) {
    const client = createConnection({host: "127.0.0.1", port});
    t.after(() => client.destroy());
    client.on("error", () => {});
    await once(client, "connect");
    return client;
}

function sendFlow(client: Socket, sourcePort: number, destinationPort: number, payload: string): void {
    client.write(`PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t${sourcePort}\t198.18.0.1\t${destinationPort}\n${payload}`);
}

async function waitForClose(client: Socket): Promise<void> {
    if (client.destroyed || client.readableEnded) return;
    await once(client, "close");
}

test("an SSH identification cannot admit an SMTP transaction when SMTP is denied", {timeout: 8_000}, async (t) => {
    let accepted = false;
    const f = await fixture(t, {
        authorizeProtocol: (protocol) => protocol === "ssh",
        onUpstream: smtpServer(() => { accepted = true; }),
    });
    f.gateway.approve({
        family: NetworkAddressFamily.IPV4,
        source: {address: "10.200.0.2", port: 40_001},
        destination: {address: "198.18.0.1", port: 2_525},
        upstream: {address: "127.0.0.1", port: f.upstreamPort},
        hostname: "mail.test",
    });
    const client = await connectClient(t, f.gateway.port);
    sendFlow(client, 40_001, 2_525, `${SSH_CLIENT}EHLO fixture.test\r\nMAIL FROM:<sender@example.test>\r\nRCPT TO:<recipient@example.test>\r\nDATA\r\nSubject: local fixture\r\n\r\nbody\r\n.\r\n`);
    await waitForClose(client);
    assert.equal(accepted, false);
    assert.deepEqual(f.reviews, ["ssh"]);
    assert.ok(f.errors.some((error) => /not confirmed|contradictory/.test(String(error))));
});

test("a client-first SMTP conversation still relays after the upstream greeting confirms SMTP", {timeout: 8_000}, async (t) => {
    let accepted = false;
    const f = await fixture(t, {
        authorizeProtocol: (protocol) => protocol === "smtp",
        onUpstream: smtpServer(() => { accepted = true; }),
    });
    f.gateway.approve({
        family: NetworkAddressFamily.IPV4,
        source: {address: "10.200.0.2", port: 40_002},
        destination: {address: "198.18.0.1", port: 2_525},
        upstream: {address: "127.0.0.1", port: f.upstreamPort},
        hostname: "mail.test",
    });
    const client = await connectClient(t, f.gateway.port);
    sendFlow(client, 40_002, 2_525, "EHLO fixture.test\r\nMAIL FROM:<sender@example.test>\r\nRCPT TO:<recipient@example.test>\r\nDATA\r\nSubject: local fixture\r\n\r\nbody\r\n.\r\n");
    const chunks: Buffer[] = [];
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    while (!Buffer.concat(chunks).includes("250 fixture accepted")) await once(client, "data");
    assert.equal(accepted, true);
    assert.deepEqual(f.reviews, ["smtp"]);
});

test("a matching client-first SSH identification relays after the upstream greeting confirms SSH", {timeout: 8_000}, async (t) => {
    const received: string[] = [];
    const f = await fixture(t, {
        authorizeProtocol: (protocol) => protocol === "ssh",
        onUpstream: (socket) => {
            socket.write(SSH_SERVER);
            socket.on("data", (chunk) => {
                received.push(chunk.toString());
                socket.write(chunk);
            });
        },
    });
    f.gateway.approve({
        family: NetworkAddressFamily.IPV4,
        source: {address: "10.200.0.2", port: 40_003},
        destination: {address: "198.18.0.1", port: 2_222},
        upstream: {address: "127.0.0.1", port: f.upstreamPort},
        hostname: "ssh.test",
    });
    const client = await connectClient(t, f.gateway.port);
    const chunks: Buffer[] = [];
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    sendFlow(client, 40_003, 2_222, SSH_CLIENT);
    while (!Buffer.concat(chunks).includes(SSH_SERVER + SSH_CLIENT)) await once(client, "data");
    assert.equal(received.join(""), SSH_CLIENT);
    assert.deepEqual(f.reviews, ["ssh"]);
});

test("a delayed SSH claim cannot override a slow server-first SMTP greeting", {timeout: 8_000}, async (t) => {
    let accepted = false;
    const f = await fixture(t, {
        authorizeProtocol: (protocol) => protocol === "ssh",
        onUpstream: (socket) => {
            setTimeout(() => smtpServer(() => { accepted = true; })(socket), 800);
        },
    });
    f.gateway.approve({
        family: NetworkAddressFamily.IPV4,
        source: {address: "10.200.0.2", port: 40_004},
        destination: {address: "198.18.0.1", port: 2_525},
        upstream: {address: "127.0.0.1", port: f.upstreamPort},
        hostname: "mail.test",
    });
    const client = await connectClient(t, f.gateway.port);
    client.write("PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t40004\t198.18.0.1\t2525\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.write(`${SSH_CLIENT}EHLO fixture.test\r\nMAIL FROM:<sender@example.test>\r\nRCPT TO:<recipient@example.test>\r\nDATA\r\nSubject: local fixture\r\n\r\nbody\r\n.\r\n`);
    await waitForClose(client);
    assert.equal(accepted, false);
    assert.deepEqual(f.reviews, []);
    assert.ok(f.errors.some((error) => /not confirmed|contradictory/.test(String(error))));
});
