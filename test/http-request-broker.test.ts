import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {createServer as createHttpServer, request} from "node:http";
import type {Server as HttpServer} from "node:http";
import {createServer as createHttpsServer} from "node:https";
import {createConnection, createServer} from "node:net";
import type {Socket} from "node:net";
import test from "node:test";
import type {TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {HttpRequestBroker} from "../src/policy/network/HttpRequestBroker.js";
import type {HttpRequestBrokerOptions} from "../src/policy/network/HttpRequestBroker.js";
import {NetworkApplicationProtocol} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";
import {authorizeHttpOperation, createHttpRequestEvent, grpcProtocols} from "../src/policy/network/HttpRequestPolicy.js";

test("pure HTTP protocol classification rejects unrelated prefixes and recognizes media variants", () => {
    for (const type of ["application/grpc", "application/grpc+proto", "application/grpc+proto+custom", "application/grpc-web+proto+custom", "application/grpc-web", "application/grpc-web-text+proto; charset=utf-8", "APPLICATION/GRPC+JSON"]) {
        assert.deepEqual(grpcProtocols([type]), [NetworkApplicationProtocol.GRPC]);
    }
    for (const type of ["text/plain", "application/grpcish", "application/grpc-not-a-protocol", "application/grpc-web-textual"]) {
        assert.deepEqual(grpcProtocols([type]), []);
    }
    assert.deepEqual(grpcProtocols(["text/plain", "application/grpc"]), [NetworkApplicationProtocol.GRPC]);
});

test("pure HTTP authorization is additive, canonical, fails closed, and honors cancellation", async () => {
    const event = createHttpRequestEvent("POST", "/service/../rpc?query=1", "policy.invalid:8080", {
        family: NetworkAddressFamily.IPV4,
        source: {address: "127.0.0.1", port: 1000},
        destination: {address: "192.0.2.5", port: 8080},
        upstream: {address: "127.0.0.1", port: 2000},
    }, "https");
    assert.equal(event.url, "https://policy.invalid:8080/rpc?query=1");
    const protocol = [NetworkApplicationProtocol.GRPC];
    const controller = new AbortController();
    const order: string[] = [];
    assert.equal(await authorizeHttpOperation({
        authorize: () => { order.push("method"); return true; },
        authorizeProtocol: (operation) => { order.push(operation.protocol); assert.equal(operation.uri, event.url); return true; },
    }, event, protocol, controller.signal), true);
    assert.deepEqual(order, ["method", "grpc"]);
    assert.equal(await authorizeHttpOperation({authorize: () => true}, event, protocol, controller.signal), false);
    assert.equal(await authorizeHttpOperation({authorize: () => false, authorizeProtocol: () => { assert.fail("method denial must stop protocol authorization"); }}, event, protocol, controller.signal), false);
    await assert.rejects(authorizeHttpOperation({authorizeProtocol: () => { throw new Error("failed"); }}, event, protocol, controller.signal), /failed/);
    let decide!: (value: boolean) => void;
    const pending = authorizeHttpOperation({authorizeProtocol: () => new Promise((resolve) => { decide = resolve; })}, event, protocol, controller.signal);
    controller.abort();
    decide(true);
    assert.equal(await pending, false);
});

const HOST = "policy.invalid:8080";
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const ACCEPT = createHash("sha1").update(`${KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
const UPGRADE = `GET /chat?x=1 HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${KEY}\r\n`;

async function fixture(
    t: TestContext, options: HttpRequestBrokerOptions = {}, upstream: HttpServer = createHttpServer(),
    scheme: "http" | "https" = "http",
) {
    const sockets = new Set<Socket>();
    let connections = 0;
    upstream.on("connection", (socket) => {
        connections++;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const broker = new HttpRequestBroker(options);
    const gateway = createServer((socket) => broker.accept(socket, {
        family: NetworkAddressFamily.IPV4,
        source: {address: "127.0.0.1", port: 12345},
        destination: {address: "192.0.2.5", port: 8080},
        upstream: {address: "127.0.0.1", port: upstreamAddress.port},
        hostname: "policy.invalid",
    }, scheme));
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const address = gateway.address();
    assert.ok(address && typeof address !== "string");
    t.after(() => {
        broker.close();
        for (const socket of sockets) socket.destroy();
        gateway.close();
        upstream.close();
    });
    return {broker, upstream, port: address.port, connections: () => connections};
}

async function httpCall(port: number, headers: Record<string, string> = {}, method = "POST") {
    return new Promise<{status: number; body: string; trailers: NodeJS.Dict<string>}>((resolve, reject) => {
        const call = request({host: "127.0.0.1", port, method, path: "/rpc?x=1", headers: {host: HOST, ...headers}}, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({status: response.statusCode!, body: Buffer.concat(chunks).toString(), trailers: response.trailers}));
        });
        call.on("error", reject);
        call.end("body");
    });
}

async function rawCall(port: number, bytes: string | Buffer, until?: (data: Buffer) => boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({host: "127.0.0.1", port});
        const chunks: Buffer[] = [];
        socket.on("connect", () => socket.write(bytes));
        socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            if (until?.(Buffer.concat(chunks))) socket.destroy();
        });
        socket.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "ECONNRESET") reject(error);
        });
        socket.on("close", () => resolve(Buffer.concat(chunks)));
        socket.setTimeout(3_000, () => socket.destroy(new Error("raw request timed out")));
    });
}

function webSocketUpstream(server: HttpServer, extra = "", accept = ACCEPT) {
    server.on("upgrade", (incoming, socket, head) => {
        assert.equal(incoming.headers.host, HOST);
        assert.equal(incoming.headers["sec-websocket-extensions"], undefined);
        socket.on("error", () => {});
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\nserver-head`);
        if (head.length) socket.write(head);
        socket.pipe(socket);
    });
}

for (const contentType of [
    "application/grpc", "application/grpc+proto", "application/grpc+proto+custom",
    "application/grpc+json; charset=utf-8", "application/grpc-web", "application/grpc-web+proto",
    "application/grpc-web-text",
    "Application/GRPC-Web-Text+Proto; charset=UTF-8",
]) {
    test(`HTTP/1 gRPC media ${contentType} needs additive protocol approval`, {timeout: 5_000}, async (t) => {
        const calls: string[] = [];
        const f = await fixture(t, {
            authorize: (event) => { calls.push(event.method); return true; },
            authorizeProtocol: (event) => {
                calls.push(event.protocol);
                assert.equal(event.uri, `http://${HOST}/rpc?x=1`);
                return true;
            },
        });
        f.upstream.on("request", (req, res) => {
            assert.equal(req.headers["content-type"], contentType);
            assert.equal(req.headers.host, HOST);
            req.resume();
            res.writeHead(200, {trailer: "grpc-status"});
            res.write("ok");
            res.addTrailers({"grpc-status": "0"});
            res.end();
        });
        const result = await httpCall(f.port, {"content-type": contentType});
        assert.equal(result.status, 200);
        assert.equal(result.trailers["grpc-status"], "0");
        assert.deepEqual(calls, ["POST", "grpc"]);
        assert.equal(f.connections(), 1);
    });
}

for (const mode of ["absent", "deny", "throw", "method-deny"] as const) {
    test(`HTTP/1 gRPC and WebSocket fail closed: ${mode}`, {timeout: 5_000}, async (t) => {
        let protocolCalls = 0;
        const f = await fixture(t, {
            authorize: () => mode !== "method-deny",
            authorizeProtocol: mode === "absent" ? undefined : () => {
                protocolCalls++;
                if (mode === "throw") throw new Error("policy failed");
                return mode === "method-deny";
            },
        });
        assert.equal((await httpCall(f.port, {"content-type": "application/grpc-web+proto"})).status, 403);
        assert.equal((await rawCall(f.port, `${UPGRADE}\r\n`)).length, 0);
        assert.equal(f.connections(), 0);
        if (mode === "method-deny") assert.equal(protocolCalls, 0);
    });
}

for (const grpc of [false, true]) {
    for (const reversed of [false, true]) {
        test(`duplicate Host authorities reject before ${grpc ? "gRPC-Web" : "ordinary HTTP"} authorization (${reversed ? "reversed" : "original"} order)`, {timeout: 5_000}, async (t) => {
            let evaluations = 0;
            const f = await fixture(t, {
                authorize: () => { evaluations++; return true; },
                authorizeProtocol: () => { evaluations++; return true; },
            });
            f.upstream.on("request", (request, response) => { request.resume(); response.end("not authorized"); });
            const hosts = [HOST, "denied.invalid:8080"];
            if (reversed) hosts.reverse();
            const response = await rawCall(f.port, [
                "POST /rpc HTTP/1.1",
                ...hosts.map((host) => `Host: ${host}`),
                `Content-Type: ${grpc ? "application/grpc-web+proto" : "text/plain"}`,
                "Content-Length: 0", "Connection: close", "", "",
            ].join("\r\n"));
            assert.equal(f.connections(), 0);
            assert.equal(evaluations, 0);
            assert.match(response.toString(), /^HTTP\/1\.1 [45]\d\d/);
        });
    }
}

test("ordinary HTTP is method-authorized without false gRPC prefix classification", {timeout: 5_000}, async (t) => {
    const f = await fixture(t, {authorize: () => true, authorizeProtocol: () => { throw new Error("not gRPC"); }});
    f.upstream.on("request", (req, res) => { req.resume(); res.end("ok"); });
    assert.equal((await httpCall(f.port, {"content-type": "application/grpc-not-a-protocol"})).status, 200);
});

test("WebSocket approves GET and canonical HTTP URL before opening pinned upstream; relays both heads", {timeout: 5_000}, async (t) => {
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const methods: string[] = [];
    const f = await fixture(t, {
        authorize: (event) => { methods.push(event.method); return true; },
        authorizeProtocol: (event) => {
            assert.equal(event.protocol, NetworkApplicationProtocol.WEBSOCKET);
            assert.equal(event.uri, `http://${HOST}/chat?x=1`);
            entered();
            return new Promise((resolve) => { approve = resolve; });
        },
    });
    webSocketUpstream(f.upstream, "Sec-WebSocket-Protocol: chat\r\n");
    const response = rawCall(f.port, `${UPGRADE}Sec-WebSocket-Protocol: chat\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\nclient-head`,
        (data) => data.includes("server-head") && data.includes("client-head"));
    await pending;
    await delay(30);
    assert.equal(f.connections(), 0);
    approve(true);
    const data = await response;
    assert.match(data.toString(), /^HTTP\/1.1 101/);
    assert.match(data.toString(), /server-head/);
    assert.match(data.toString(), /client-head/);
    assert.deepEqual(methods, ["GET"]);
});

for (const extra of ["Sec-WebSocket-Protocol: not-offered\r\n", "Sec-WebSocket-Extensions: permessage-deflate\r\n", "Sec-WebSocket-Accept: duplicate\r\n"]) {
    test(`WebSocket rejects invalid upstream handshake: ${extra.trim()}`, {timeout: 5_000}, async (t) => {
        const f = await fixture(t, {authorize: () => true, authorizeProtocol: () => true});
        webSocketUpstream(f.upstream, extra);
        assert.equal((await rawCall(f.port, `${UPGRADE}\r\n`)).length, 0);
    });
}

test("WebSocket rejects incorrect accept digest", {timeout: 5_000}, async (t) => {
    const f = await fixture(t, {authorizeProtocol: () => true});
    webSocketUpstream(f.upstream, "", "wrong");
    assert.equal((await rawCall(f.port, `${UPGRADE}\r\n`)).length, 0);
});

for (const raw of [
    `${UPGRADE.replace("GET", "POST")}\r\n`,
    `${UPGRADE.replace("websocket", "h2c")}\r\n`,
    `${UPGRADE.replace(KEY, "invalid")}\r\n`,
    `${UPGRADE.replace("Version: 13", "Version: 12")}\r\n`,
    `${UPGRADE.replace(HOST, "policy.invalid:9999")}\r\n`,
    `${UPGRADE.replace("/chat?x=1", "http://other.invalid:8080/chat")}\r\n`,
    `${UPGRADE}Sec-WebSocket-Key: ${KEY}\r\n\r\n`,
    `CONNECT ${HOST} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
    `POST /rpc HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/grpc\r\nConnection: content-type, close\r\nContent-Length: 0\r\n\r\n`,
]) {
    test(`malformed/unsupported HTTP request has no upstream effect: ${raw.split("\r\n")[0]}`, {timeout: 5_000}, async (t) => {
        const f = await fixture(t, {authorize: () => true, authorizeProtocol: () => true});
        await rawCall(f.port, raw);
        assert.equal(f.connections(), 0);
    });
}

for (const websocket of [false, true]) {
    for (const shutdown of [false, true]) {
        test(`${websocket ? "WebSocket" : "HTTP/1"} cancellation aborts policy and ignores late allow (${shutdown ? "shutdown" : "disconnect"})`, {timeout: 5_000}, async (t) => {
            let approve!: (allowed: boolean) => void;
            let entered!: () => void;
            let signal!: AbortSignal;
            const pending = new Promise<void>((resolve) => { entered = resolve; });
            const f = await fixture(t, {
                authorize: () => true,
                authorizeProtocol: (_event, currentSignal) => {
                    signal = currentSignal;
                    entered();
                    return new Promise((resolve) => { approve = resolve; });
                },
            });
            const client = createConnection({host: "127.0.0.1", port: f.port});
            client.on("error", () => {});
            await once(client, "connect");
            client.write(websocket ? `${UPGRADE}\r\n` : `POST /rpc HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/grpc\r\nContent-Length: 0\r\n\r\n`);
            await pending;
            assert.equal(f.connections(), 0);
            const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {once: true}));
            if (shutdown) f.broker.close();
            else client.destroy();
            await aborted;
            approve(true);
            await delay(30);
            assert.equal(f.connections(), 0);
            client.destroy();
        });
    }
}

test("WebSocket refuses upgrade pipelined behind pending HTTP authorization", {timeout: 5_000}, async (t) => {
    let approve!: (allowed: boolean) => void;
    const f = await fixture(t, {authorize: () => new Promise((resolve) => { approve = resolve; }), authorizeProtocol: () => true});
    await rawCall(f.port, `GET /first HTTP/1.1\r\nHost: ${HOST}\r\n\r\n${UPGRADE}\r\n`);
    approve?.(true);
    await delay(20);
    assert.equal(f.connections(), 0);
});

for (const direction of ["download", "upload"] as const) {
    test(`WebSocket normal EOF drains a large ${direction} to a slow receiver`, {timeout: 20_000}, async (t) => {
        const f = await fixture(t, {authorizeProtocol: () => true});
        const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
        let received!: (body: Buffer) => void;
        const uploaded = new Promise<Buffer>((resolve) => { received = resolve; });
        f.upstream.on("upgrade", (_request, socket, head) => {
            socket.on("error", () => {});
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${ACCEPT}\r\n\r\n`);
            if (direction === "download") {
                socket.end(payload);
            } else {
                const chunks: Buffer[] = [head];
                socket.pause();
                socket.on("data", (chunk: Buffer) => chunks.push(chunk));
                socket.on("end", () => {
                    received(Buffer.concat(chunks));
                    socket.end();
                });
                setTimeout(() => socket.resume(), 100);
            }
        });
        const client = createConnection({host: "127.0.0.1", port: f.port});
        t.after(() => client.destroy());
        const downloaded = new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let handshakeComplete = false;
            client.on("connect", () => client.write(`${UPGRADE}\r\n`));
            client.on("error", reject);
            client.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
                if (!handshakeComplete && Buffer.concat(chunks).includes("\r\n\r\n")) {
                    handshakeComplete = true;
                    if (direction === "upload") client.end(payload);
                    else {
                        client.pause();
                        setTimeout(() => client.resume(), 100);
                    }
                }
            });
            client.on("end", () => {
                const data = Buffer.concat(chunks);
                resolve(data.subarray(data.indexOf("\r\n\r\n") + 4));
            });
        });
        if (direction === "download") assert.deepEqual(await downloaded, payload);
        else {
            assert.deepEqual(await uploaded, payload);
            await downloaded;
        }
    });
}

test("HTTPS WebSocket verifies original hostname while dialing pinned address", {timeout: 10_000}, async (t) => {
    const ca = new TlsCertificateAuthority();
    const upstream = createHttpsServer(ca.serverCredentials("policy.invalid"));
    const f = await fixture(t, {authorizeProtocol: () => true, additionalUpstreamCa: ca.certificatePem}, upstream, "https");
    webSocketUpstream(upstream);
    const result = await rawCall(f.port, `${UPGRADE}\r\n`, (data) => data.includes("server-head"));
    assert.match(result.toString(), /^HTTP\/1.1 101/);
});

test("HTTPS WebSocket rejects untrusted upstream TLS", {timeout: 10_000}, async (t) => {
    const ca = new TlsCertificateAuthority();
    const upstream = createHttpsServer(ca.serverCredentials("policy.invalid"));
    const f = await fixture(t, {authorizeProtocol: () => true}, upstream, "https");
    let upgrades = 0;
    upstream.on("upgrade", () => upgrades++);
    assert.equal((await rawCall(f.port, `${UPGRADE}\r\n`)).length, 0);
    assert.equal(upgrades, 0);
});
