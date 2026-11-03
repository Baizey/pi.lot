import assert from "node:assert/strict";
import {once} from "node:events";
import {connect, constants, createServer as createHttp2Server, createSecureServer} from "node:http2";
import type {ClientHttp2Session, ClientHttp2Stream, Http2Server, Http2SecureServer, IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream} from "node:http2";
import {createServer} from "node:net";
import type {Socket} from "node:net";
import test from "node:test";
import type {TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {Http2RequestBroker} from "../src/policy/network/Http2RequestBroker.js";
import type {Http2RequestBrokerOptions} from "../src/policy/network/Http2RequestBroker.js";
import {NetworkApplicationProtocol} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";

const HOST = "policy.invalid:8080";

async function fixture(
    t: TestContext, options: Http2RequestBrokerOptions = {},
    upstream: Http2Server | Http2SecureServer = createHttp2Server(), scheme: "http" | "https" = "http",
    bufferedHandoff = false,
) {
    let connections = 0;
    const sockets = new Set<Socket>();
    const sessions = new Set<ServerHttp2Session>();
    upstream.on("connection", (socket: Socket) => {
        connections++;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    upstream.on("session", (session: ServerHttp2Session) => {
        sessions.add(session);
        session.on("error", () => {});
        session.once("close", () => sessions.delete(session));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const broker = new Http2RequestBroker(options);
    const gateway = createServer((socket) => {
        const accept = () => broker.accept(socket, {
            family: NetworkAddressFamily.IPV4,
            source: {address: "127.0.0.1", port: 12345},
            destination: {address: "192.0.2.5", port: 8080},
            upstream: {address: "127.0.0.1", port: upstreamAddress.port},
            hostname: "policy.invalid",
        }, scheme);
        if (!bufferedHandoff) return accept();
        // Model protocol sniffing: these bytes have left the native socket and
        // must be consumed from its JS readable queue after parser handoff.
        socket.once("data", (chunk: Buffer) => {
            socket.pause();
            socket.unshift(chunk);
            assert.ok(socket.readableLength >= chunk.length);
            accept();
        });
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const address = gateway.address();
    assert.ok(address && typeof address !== "string");
    const client = connect(`http://127.0.0.1:${address.port}`);
    client.on("error", () => {});
    t.after(() => {
        client.destroy();
        broker.close();
        for (const session of sessions) session.destroy();
        for (const socket of sockets) socket.destroy();
        gateway.close();
        upstream.close();
    });
    await once(client, "connect");
    return {broker, upstream, client, scheme, connections: () => connections};
}

function startRequest(client: ClientHttp2Session, headers: IncomingHttpHeaders = {}, scheme = "http") {
    return client.request({":method": "POST", ":scheme": scheme, ":authority": HOST, ":path": "/service/Call?x=1", ...headers},
        {endStream: false, waitForTrailers: true});
}

function collect(stream: ClientHttp2Stream) {
    return new Promise<{headers: IncomingHttpHeaders; trailers: IncomingHttpHeaders; body: Buffer}>((resolve, reject) => {
        let headers: IncomingHttpHeaders = {};
        let trailers: IncomingHttpHeaders = {};
        const chunks: Buffer[] = [];
        stream.on("response", (value) => { headers = value; });
        stream.on("trailers", (value) => { trailers = value; });
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on("end", () => resolve({headers, trailers, body: Buffer.concat(chunks)}));
        stream.on("error", reject);
    });
}

function finishRequest(stream: ClientHttp2Stream, body = "request", trailers: IncomingHttpHeaders = {}) {
    stream.once("wantTrailers", () => stream.sendTrailers(trailers));
    stream.end(body);
}

function respond(server: Http2Server | Http2SecureServer) {
    server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        stream.on("error", () => {});
        assert.equal(headers[":authority"], HOST);
        stream.resume();
        stream.respond({":status": 200, "content-type": "application/grpc"}, {waitForTrailers: true});
        stream.once("wantTrailers", () => stream.sendTrailers({"grpc-status": "0", "result-bin": "AAEC/w=="}));
        stream.end("response");
    });
}

for (const allow of [false, true]) {
    test(`HTTP/2 paused socket with unshifted preface ${allow ? "allows" : "denies"} gRPC without losing buffered bytes`, {timeout: 20_000}, async (t) => {
        const decisions: string[] = [];
        const f = await fixture(t, {
            authorize: (event) => { decisions.push(event.method); return true; },
            authorizeProtocol: (event) => {
                decisions.push(event.protocol);
                assert.equal(event.uri, `http://${HOST}/service/Call?x=1`);
                return allow;
            },
        }, createHttp2Server(), "http", true);
        respond(f.upstream);
        const stream = startRequest(f.client, {"content-type": "application/grpc"});
        const response = collect(stream);
        finishRequest(stream);
        const result = await response;
        assert.equal(result.headers[":status"], allow ? 200 : 403);
        assert.equal(result.body.toString(), allow ? "response" : "");
        assert.equal(result.trailers["grpc-status"], allow ? "0" : undefined);
        assert.deepEqual(decisions, ["POST", "grpc"]);
        assert.equal(f.connections(), allow ? 1 : 0);
    });
}

for (const contentType of [
    "application/grpc", "application/grpc+proto", "application/grpc+proto+custom",
    "application/grpc+json; charset=utf-8", "application/grpc-web", "application/grpc-web+proto",
    "application/grpc-web-text",
    "APPLICATION/GRPC-WEB-TEXT+PROTO; charset=UTF-8",
]) {
    test(`HTTP/2 ${contentType} checks method plus gRPC and pins upstream`, {timeout: 20_000}, async (t) => {
        const calls: string[] = [];
        const f = await fixture(t, {
            authorize: (event) => { calls.push(event.method); return true; },
            authorizeProtocol: (event) => {
                assert.equal(event.protocol, NetworkApplicationProtocol.GRPC);
                assert.equal(event.uri, `http://${HOST}/service/Call?x=1`);
                assert.equal(event.upstreamAddress, "127.0.0.1");
                calls.push(event.protocol);
                return true;
            },
        });
        respond(f.upstream);
        const stream = startRequest(f.client, {"content-type": contentType, te: "trailers", "request-bin": "AAEC/w=="});
        const result = collect(stream);
        finishRequest(stream);
        const response = await result;
        assert.equal(response.headers[":status"], 200);
        assert.equal(response.body.toString(), "response");
        assert.equal(response.trailers["grpc-status"], "0");
        assert.equal(response.trailers["result-bin"], "AAEC/w==");
        assert.deepEqual(calls, ["POST", "grpc"]);
        assert.equal(f.connections(), 1);
    });
}

for (const mode of ["absent", "deny", "throw", "method-deny"] as const) {
    test(`HTTP/2 gRPC fails closed: ${mode}`, {timeout: 20_000}, async (t) => {
        let protocolCalls = 0;
        const f = await fixture(t, {
            authorize: () => mode !== "method-deny",
            authorizeProtocol: mode === "absent" ? undefined : () => {
                protocolCalls++;
                if (mode === "throw") throw new Error("policy unavailable");
                return mode === "method-deny";
            },
        });
        const stream = startRequest(f.client, {"content-type": "application/grpc"});
        const response = collect(stream);
        finishRequest(stream);
        assert.equal((await response).headers[":status"], 403);
        assert.equal(f.connections(), 0);
        if (mode === "method-deny") assert.equal(protocolCalls, 0);
    });
}

test("HTTP/2 generic traffic still checks method without inventing gRPC authorization", {timeout: 20_000}, async (t) => {
    const methods: string[] = [];
    const f = await fixture(t, {authorize: (event) => { methods.push(event.method); return event.method === "GET"; }});
    respond(f.upstream);
    const allowed = startRequest(f.client, {":method": "GET", "content-type": "application/grpc-not-a-protocol"});
    const allowedResponse = collect(allowed);
    finishRequest(allowed, "");
    assert.equal((await allowedResponse).headers[":status"], 200);
    const denied = startRequest(f.client, {":method": "DELETE"});
    const deniedResponse = collect(denied);
    finishRequest(denied, "");
    assert.equal((await deniedResponse).headers[":status"], 403);
    assert.deepEqual(methods, ["GET", "DELETE"]);
    assert.equal(f.connections(), 1);
});

test("HTTP/2 streaming request/response preserves trailers, te and binary metadata", {timeout: 20_000}, async (t) => {
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const f = await fixture(t, {
        authorize: () => true,
        authorizeProtocol: () => { entered(); return new Promise((resolve) => { approve = resolve; }); },
    });
    const payload = Buffer.alloc(256 * 1024, 0x41);
    f.upstream.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        stream.on("error", () => {});
        assert.equal(headers.te, "trailers");
        assert.equal(headers["request-bin"], "AAEC/w==");
        let trailers: IncomingHttpHeaders = {};
        const chunks: Buffer[] = [];
        stream.on("trailers", (value) => { trailers = value; });
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on("end", () => {
            assert.deepEqual(Buffer.concat(chunks), payload);
            assert.equal(trailers["request-trailer-bin"], "AQID");
            stream.respond({":status": 200}, {waitForTrailers: true});
            stream.once("wantTrailers", () => stream.sendTrailers({"grpc-status": "0", "response-bin": "AAEC/w=="}));
            stream.end(payload);
        });
    });
    const stream = startRequest(f.client, {"content-type": "application/grpc", te: "trailers", "request-bin": "AAEC/w=="});
    const response = collect(stream);
    stream.once("wantTrailers", () => stream.sendTrailers({"request-trailer-bin": "AQID"}));
    stream.end(payload);
    await pending;
    await delay(30);
    assert.equal(f.connections(), 0);
    approve(true);
    const result = await response;
    assert.equal(result.headers[":status"], 200);
    assert.deepEqual(result.body, payload);
    assert.equal(result.trailers["grpc-status"], "0");
    assert.equal(result.trailers["response-bin"], "AAEC/w==");
});

test("HTTP/2 pending/denied streams do not block authorized siblings", {timeout: 20_000}, async (t) => {
    let decide!: (value: boolean) => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const f = await fixture(t, {
        authorize: () => true,
        authorizeProtocol: (event) => {
            if (event.uri.endsWith("/denied")) {
                entered();
                return new Promise((resolve) => { decide = resolve; });
            }
            return true;
        },
    });
    const seen: string[] = [];
    f.upstream.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        seen.push(String(headers[":path"]));
        stream.resume();
        stream.respond({":status": 200});
        stream.end("allowed");
    });
    const denied = startRequest(f.client, {":path": "/denied", "content-type": "application/grpc"});
    const deniedResponse = collect(denied);
    finishRequest(denied);
    await pending;
    assert.equal(f.connections(), 0);
    const allowed = startRequest(f.client, {":path": "/allowed", "content-type": "application/grpc-web+proto"});
    const allowedResponse = collect(allowed);
    finishRequest(allowed);
    assert.equal((await allowedResponse).headers[":status"], 200);
    decide(false);
    assert.equal((await deniedResponse).headers[":status"], 403);
    assert.deepEqual(seen, ["/allowed"]);
    assert.equal(f.connections(), 1);
});

test("HTTP/2 retains request trailers received while authorization is pending", {timeout: 20_000}, async (t) => {
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const f = await fixture(t, {
        authorizeProtocol: () => { entered(); return new Promise((resolve) => { approve = resolve; }); },
    });
    f.upstream.on("stream", (stream: ServerHttp2Stream) => {
        let trailer: string | string[] | undefined;
        stream.on("trailers", (headers) => { trailer = headers["request-trailer"]; });
        stream.resume();
        stream.on("end", () => {
            assert.equal(trailer, "early-trailer");
            stream.respond({":status": 200});
            stream.end();
        });
    });
    const stream = startRequest(f.client, {"content-type": "application/grpc"});
    const response = collect(stream);
    finishRequest(stream, "small", {"request-trailer": "early-trailer"});
    await pending;
    await delay(50);
    assert.equal(f.connections(), 0);
    approve(true);
    assert.equal((await response).headers[":status"], 200);
});

test("HTTP/2 reset closes the forwarded upstream stream without affecting a sibling", {timeout: 20_000}, async (t) => {
    const f = await fixture(t, {authorizeProtocol: () => true});
    let arrived!: () => void;
    let closed!: () => void;
    const upstreamArrived = new Promise<void>((resolve) => { arrived = resolve; });
    const upstreamClosed = new Promise<void>((resolve) => { closed = resolve; });
    f.upstream.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        stream.on("error", () => {});
        stream.resume();
        if (headers[":path"] === "/cancel") {
            stream.once("close", closed);
            arrived();
        } else {
            stream.respond({":status": 200});
            stream.end("survived");
        }
    });
    const cancelled = startRequest(f.client, {":path": "/cancel", "content-type": "application/grpc"});
    cancelled.on("error", () => {});
    finishRequest(cancelled);
    await upstreamArrived;
    cancelled.close(constants.NGHTTP2_CANCEL);
    await upstreamClosed;
    const sibling = startRequest(f.client, {":path": "/sibling", "content-type": "application/grpc"});
    const response = collect(sibling);
    finishRequest(sibling);
    assert.equal((await response).body.toString(), "survived");
});

test("HTTP/2 included NO_ERROR GOAWAY drains the RPC response and trailers without replay", {timeout: 20_000}, async (t) => {
    let methodChecks = 0;
    let protocolChecks = 0;
    const f = await fixture(t, {
        authorize: () => { methodChecks++; return true; },
        authorizeProtocol: () => { protocolChecks++; return true; },
    });
    const payload = Buffer.alloc(1024 * 1024, 0x61);
    const requests: string[] = [];
    f.upstream.on("stream", (stream: ServerHttp2Stream) => {
        stream.on("error", () => {});
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.once("end", () => {
            requests.push(Buffer.concat(chunks).toString());
            const session = stream.session!;
            session.goaway(constants.NGHTTP2_NO_ERROR, stream.id);
            // Keep the RPC unfinished across GOAWAY delivery, then exercise a
            // second graceful frame and a backpressured response with trailers.
            setTimeout(() => {
                if (stream.destroyed) return;
                session.goaway(constants.NGHTTP2_NO_ERROR, stream.id);
                stream.respond({":status": 200, "content-type": "application/grpc"}, {waitForTrailers: true});
                stream.once("wantTrailers", () => stream.sendTrailers({"grpc-status": "0", "result-bin": "AAEC/w=="}));
                stream.end(payload);
            }, 30);
        });
    });
    const stream = startRequest(f.client, {"content-type": "application/grpc"});
    const response = collect(stream);
    stream.once("response", () => {
        stream.pause();
        setTimeout(() => stream.resume(), 50);
    });
    finishRequest(stream, "one accepted RPC");
    const result = await response;
    assert.equal(result.headers[":status"], 200);
    assert.deepEqual(result.body, payload);
    assert.equal(result.trailers["grpc-status"], "0");
    assert.equal(result.trailers["result-bin"], "AAEC/w==");
    await delay(30);
    assert.deepEqual(requests, ["one accepted RPC"]);
    assert.equal(f.connections(), 1);
    assert.equal(methodChecks, 1);
    assert.equal(protocolChecks, 1);
});

for (const errorCode of [constants.NGHTTP2_NO_ERROR, constants.NGHTTP2_INTERNAL_ERROR]) {
    test(`HTTP/2 GOAWAY before stream admission fails without upstream requests or replay (code ${errorCode})`, {timeout: 20_000}, async (t) => {
        let methodChecks = 0;
        let protocolChecks = 0;
        const f = await fixture(t, {
            authorize: () => { methodChecks++; return true; },
            authorizeProtocol: () => { protocolChecks++; return true; },
        });
        let requests = 0;
        f.upstream.on("session", (session: ServerHttp2Session) => {
            // No stream has been processed: last-stream ID zero excludes the
            // broker's first request, even if its HEADERS are already in flight.
            session.goaway(errorCode, 0);
        });
        f.upstream.on("stream", (stream: ServerHttp2Stream) => {
            requests++;
            stream.on("error", () => {});
            stream.resume();
        });
        const stream = startRequest(f.client, {"content-type": "application/grpc"});
        const response = collect(stream);
        finishRequest(stream, "must not reach an RPC handler");
        const result = await response;
        assert.equal(result.headers[":status"], 502);
        assert.equal(result.body.length, 0);
        assert.equal(result.trailers["grpc-status"], undefined);
        await delay(30);
        assert.equal(requests, 0);
        assert.equal(f.connections(), 1);
        assert.equal(methodChecks, 1);
        assert.equal(protocolChecks, 1);
    });
}

test("HTTP/2 error GOAWAY after included graceful GOAWAY fails the RPC without replay", {timeout: 20_000}, async (t) => {
    const f = await fixture(t, {authorizeProtocol: () => true});
    const requests: string[] = [];
    f.upstream.on("stream", (stream: ServerHttp2Stream) => {
        stream.on("error", () => {});
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.once("end", () => {
            requests.push(Buffer.concat(chunks).toString());
            const session = stream.session!;
            session.goaway(constants.NGHTTP2_NO_ERROR, stream.id);
            setTimeout(() => {
                if (!session.destroyed) session.goaway(constants.NGHTTP2_INTERNAL_ERROR, stream.id);
            }, 30);
        });
    });
    const stream = startRequest(f.client, {"content-type": "application/grpc"});
    const response = collect(stream);
    finishRequest(stream, "one RPC before shutdown error");
    const result = await response;
    assert.equal(result.headers[":status"], 502);
    assert.equal(result.body.length, 0);
    assert.equal(result.trailers["grpc-status"], undefined);
    await delay(30);
    assert.deepEqual(requests, ["one RPC before shutdown error"]);
    assert.equal(f.connections(), 1);
});

for (const cancel of ["reset", "disconnect", "shutdown"] as const) {
    test(`HTTP/2 ${cancel} aborts pending authorization and ignores late allow`, {timeout: 20_000}, async (t) => {
        let approve!: (value: boolean) => void;
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
        const stream = startRequest(f.client, {"content-type": "application/grpc"});
        stream.on("error", () => {});
        finishRequest(stream);
        await pending;
        const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {once: true}));
        if (cancel === "reset") stream.close(constants.NGHTTP2_CANCEL);
        else if (cancel === "disconnect") f.client.destroy();
        else f.broker.close();
        await aborted;
        approve(true);
        await delay(30);
        assert.equal(f.connections(), 0);
    });
}

for (const {headers, nativeProtocolError} of [
    {headers: {":authority": "policy.invalid:9999"}, nativeProtocolError: false},
    {headers: {":authority": "policy.invalid:80"}, nativeProtocolError: false},
    {headers: {":authority": "user:password@policy.invalid:8080"}, nativeProtocolError: true},
    {headers: {":authority": "policy.invalid:8080/path"}, nativeProtocolError: true},
    {headers: {":scheme": "https"}, nativeProtocolError: false},
    {headers: {host: "other.invalid:8080"}, nativeProtocolError: false},
    {headers: {":path": "http://other.invalid:8080/"}, nativeProtocolError: true},
    {headers: {":path": "//other.invalid:8080/"}, nativeProtocolError: false},
]) {
    test(`HTTP/2 malformed authority/target fails closed: ${JSON.stringify(headers)}`, {timeout: 20_000}, async (t) => {
        const f = await fixture(t, {authorize: () => true, authorizeProtocol: () => true});
        const stream = startRequest(f.client, headers);
        const response = collect(stream);
        finishRequest(stream);
        if (nativeProtocolError) {
            // nghttp2 rejects these malformed fields before emitting a server
            // stream. Only this precise framing error is an expected outcome.
            await assert.rejects(response, {
                code: "ERR_HTTP2_STREAM_ERROR",
                message: "Stream closed with error code NGHTTP2_PROTOCOL_ERROR",
            });
            assert.equal(stream.rstCode, constants.NGHTTP2_PROTOCOL_ERROR);
        } else {
            assert.ok(Number((await response).headers[":status"]) >= 400);
        }
        assert.equal(f.connections(), 0);
    });
}

test("HTTP/2 CONNECT cannot turn HTTP allow into a tunnel", {timeout: 20_000}, async (t) => {
    const f = await fixture(t, {authorize: () => true, authorizeProtocol: () => true});
    const stream = f.client.request({":method": "CONNECT", ":authority": HOST}, {endStream: false});
    const response = collect(stream);
    stream.end();
    assert.equal((await response).headers[":status"], 400);
    assert.equal(f.connections(), 0);
});

for (const tlsMode of ["trusted", "untrusted", "wrong-name"] as const) {
    test(`HTTP/2 TLS upstream ${tlsMode} uses pinned IP and verifies original identity`, {timeout: 30_000}, async (t) => {
        const ca = new TlsCertificateAuthority();
        const upstream = createSecureServer(ca.serverCredentials(tlsMode === "wrong-name" ? "other.invalid" : "policy.invalid"));
        const f = await fixture(t, {
            authorize: () => true,
            authorizeProtocol: (event) => {
                assert.equal(event.uri, `https://${HOST}/service/Call?x=1`);
                return true;
            },
            additionalUpstreamCa: tlsMode === "untrusted" ? undefined : ca.certificatePem,
        }, upstream, "https");
        let requests = 0;
        upstream.on("stream", () => requests++);
        respond(upstream);
        const stream = startRequest(f.client, {"content-type": "application/grpc"}, "https");
        const response = collect(stream);
        finishRequest(stream);
        assert.equal((await response).headers[":status"], tlsMode === "trusted" ? 200 : 502);
        assert.equal(requests, tlsMode === "trusted" ? 1 : 0);
    });
}
