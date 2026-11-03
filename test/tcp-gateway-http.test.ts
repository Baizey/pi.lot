import assert from "node:assert/strict";
import {once} from "node:events";
import {connect, createServer, createSecureServer, type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream} from "node:http2";
import {createConnection, type Socket} from "node:net";
import {connect as connectTls} from "node:tls";
import test from "node:test";
import {TcpGatewayBroker} from "../src/policy/network/TcpGatewayBroker.js";
import {NetworkApplicationProtocol} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";

let interceptionAuthority: TlsCertificateAuthority | undefined;
let upstreamAuthority: TlsCertificateAuthority | undefined;

for (const tls of [false, true]) {
    for (const allow of [false, true]) {
        test(`complete TCP gateway ${tls ? "TLS ALPN h2" : "HTTP2 preface"} routing ${allow ? "allows" : "denies"} gRPC before upstream effects`, {timeout: 12_000}, async (t) => {
            const sockets = new Set<Socket>();
            const sessions = new Set<ServerHttp2Session>();
            let upstreamConnections = 0;
            let upstreamRequests = 0;
            const upstreamCa = tls ? upstreamAuthority ??= new TlsCertificateAuthority() : undefined;
            const gatewayCa = tls ? interceptionAuthority ??= new TlsCertificateAuthority() : undefined;
            const upstream = upstreamCa ? createSecureServer(upstreamCa.serverCredentials("service.test")) : createServer();
            upstream.on("connection", (socket: Socket) => {
                upstreamConnections++;
                sockets.add(socket);
                socket.on("error", () => {});
                socket.once("close", () => sockets.delete(socket));
            });
            upstream.on("session", (session) => {
                sessions.add(session);
                session.on("error", () => {});
                session.once("close", () => sessions.delete(session));
            });
            upstream.on("stream", (stream: ServerHttp2Stream) => {
                upstreamRequests++;
                stream.on("error", () => {});
                stream.resume();
                stream.respond({":status": 200, "content-type": "application/grpc"}, {waitForTrailers: true});
                stream.once("wantTrailers", () => stream.sendTrailers({"grpc-status": "0"}));
                stream.end("gateway-response");
            });
            upstream.listen(0, "127.0.0.1");
            await once(upstream, "listening");
            const address = upstream.address();
            assert.ok(address && typeof address !== "string");
            const scheme = tls ? "https" : "http";
            const evaluations: string[] = [];
            const gateway = new TcpGatewayBroker({
                onError: (error) => t.diagnostic(`gateway: ${String(error)}`),
                certificateAuthority: gatewayCa,
                additionalUpstreamCa: upstreamCa?.certificatePem,
                authorizeHttpRequest: (event) => {
                    evaluations.push(event.method);
                    assert.equal(event.url, `${scheme}://service.test:8443/service/Call`);
                    return true;
                },
                authorizeProtocol: (event) => {
                    evaluations.push(event.protocol);
                    assert.equal(event.protocol, NetworkApplicationProtocol.GRPC);
                    assert.equal(event.uri, `${scheme}://service.test:8443/service/Call`);
                    return allow;
                },
            });
            t.after(async () => {
                await gateway.close();
                for (const session of sessions) session.destroy();
                for (const socket of sockets) socket.destroy();
                upstream.close();
            });
            await gateway.start();
            const transport = createConnection({host: "127.0.0.1", port: gateway.port});
            transport.on("error", () => {});
            t.after(() => transport.destroy());
            await once(transport, "connect");
            gateway.approve({
                family: NetworkAddressFamily.IPV4,
                source: {address: "10.200.0.2", port: 40_000},
                destination: {address: "198.18.0.1", port: 8_443},
                upstream: {address: "127.0.0.1", port: address.port},
                hostname: "service.test",
            });
            transport.write("PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t40000\t198.18.0.1\t8443\n");
            const client = connect(`${scheme}://service.test:8443`, {
                createConnection: () => gatewayCa ? connectTls({
                    socket: transport,
                    servername: "service.test",
                    ca: gatewayCa.certificatePem,
                    ALPNProtocols: ["h2"],
                }) : transport,
            });
            client.on("error", () => {});
            t.after(() => client.destroy());
            await once(client, "connect");
            if (tls) assert.equal(client.alpnProtocol, "h2");
            const stream = client.request({
                ":method": "POST", ":scheme": scheme, ":authority": "service.test:8443",
                ":path": "/service/Call", "content-type": "application/grpc+proto", te: "trailers",
            });
            let headers: IncomingHttpHeaders = {};
            let trailers: IncomingHttpHeaders = {};
            const chunks: Buffer[] = [];
            stream.on("response", (value) => { headers = value; });
            stream.on("trailers", (value) => { trailers = value; });
            stream.on("data", (data: Buffer) => chunks.push(data));
            const ended = once(stream, "end");
            stream.end("request");
            await ended;
            assert.equal(headers[":status"], allow ? 200 : 403);
            assert.equal(Buffer.concat(chunks).toString(), allow ? "gateway-response" : "");
            if (allow) assert.equal(trailers["grpc-status"], "0");
            assert.deepEqual(evaluations, ["POST", "grpc"]);
            assert.equal(upstreamConnections, allow ? 1 : 0);
            assert.equal(upstreamRequests, allow ? 1 : 0);
        });
    }
}
