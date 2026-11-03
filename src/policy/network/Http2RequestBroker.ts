import {connect, constants, performServerHandshake} from "node:http2";
import type {
    ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders,
    ServerHttp2Session, ServerHttp2Stream,
} from "node:http2";
import {createConnection} from "node:net";
import type {Socket} from "node:net";
import {Duplex} from "node:stream";
import {connect as connectTls} from "node:tls";
import {NetworkAddressFamily} from "./network-queue-protocol.js";
import type {TcpGatewayApproval} from "./TcpGatewayBroker.js";
import {
    authorizeHttpOperation, createHttpRequestEvent, formatAuthority, grpcProtocols,
    HTTP_GATEWAY_MAX_HEADER_BYTES, MAX_HTTP_HEADER_COUNT, upstreamTlsOptions,
} from "./HttpRequestPolicy.js";
import type {HttpRequestBrokerOptions, HttpRequestEvent} from "./HttpRequestPolicy.js";

export type Http2RequestBrokerOptions = HttpRequestBrokerOptions;

const MAX_CONCURRENT_STREAMS = 128;
const SESSION_OPTIONS = {
    maxHeaderListPairs: MAX_HTTP_HEADER_COUNT,
    maxSessionMemory: 16,
    maxDeflateDynamicTableSize: 4_096,
    maxOutstandingPings: 2,
    settings: {
        enablePush: false,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
        maxHeaderListSize: HTTP_GATEWAY_MAX_HEADER_BYTES,
        headerTableSize: 4_096,
    },
};

export class Http2RequestBroker {
    private readonly options: Http2RequestBrokerOptions;
    private readonly sockets = new Set<Socket>();
    private readonly sessions = new Set<ServerHttp2Session>();
    private readonly upstreamSessions = new Set<ClientHttp2Session>();
    private readonly abortController = new AbortController();
    private stopping = false;

    constructor(options: Http2RequestBrokerOptions = {}) {
        this.options = options;
    }

    accept(socket: Socket, approval: TcpGatewayApproval, scheme: "http" | "https"): void {
        if (this.stopping) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        socket.on("error", (error) => this.reportError(error));
        // The adapter hides Socket tuning from HTTP/2; retain its usual TCP_NODELAY.
        socket.setNoDelay(true);
        socket.pause();
        // The gateway may have read and unshifted the HTTP/2 preface, or paused a
        // terminated TLS stream. Direct native socket takeover can bypass those
        // JS-buffered bytes. A distinct public Duplex makes the HTTP/2 handshake
        // consume socket.read(), preserving buffered bytes and backpressure.
        // Passing socket directly to Duplex.from() would return it unchanged.
        // The installed Node typings omit this documented Node-stream pair overload.
        const fromSocketPair = Duplex.from as typeof Duplex.from
            & ((pair: {readable: Socket; writable: Socket}) => Duplex);
        const transport = fromSocketPair({readable: socket, writable: socket});
        transport.on("error", (error) => this.reportError(error));
        let session: ServerHttp2Session;
        try {
            session = performServerHandshake(transport, SESSION_OPTIONS);
        } catch (error) {
            this.reportError(error);
            transport.destroy();
            socket.destroy();
            return;
        }
        this.sessions.add(session);
        session.on("error", (error) => this.reportError(error));
        session.once("close", () => this.sessions.delete(session));
        let activeStreams = 0;
        // Keep the approved flow and scheme in this session's closure: the
        // adapter intentionally does not expose the original TLS socket metadata.
        session.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
            stream.on("error", (error) => this.reportError(error));
            if (this.stopping || activeStreams >= MAX_CONCURRENT_STREAMS) {
                stream.close(constants.NGHTTP2_REFUSED_STREAM);
                return;
            }
            activeStreams++;
            const controller = new AbortController();
            const abort = () => controller.abort();
            stream.once("aborted", abort);
            stream.once("close", () => {
                activeStreams--;
                abort();
            });
            const signal = AbortSignal.any([controller.signal, this.abortController.signal]);
            stream.pause();
            void this.handleStream(stream, headers, approval, scheme, signal).catch((error) => {
                this.reportError(error);
                this.deny(stream, 502);
            });
        });
        // The handshake owns transport reads. Do not resume the original socket:
        // the adapter pulls from it as HTTP/2 consumes data and applies pressure.
    }

    close(): void {
        if (this.stopping) return;
        this.stopping = true;
        this.abortController.abort();
        for (const session of this.upstreamSessions) session.destroy();
        for (const session of this.sessions) session.destroy();
        for (const socket of this.sockets) socket.destroy();
    }

    private async handleStream(
        stream: ServerHttp2Stream,
        headers: IncomingHttpHeaders,
        approval: TcpGatewayApproval,
        scheme: "http" | "https",
        signal: AbortSignal,
    ): Promise<void> {
        if (signal.aborted || this.stopping) return;
        validateHeaders(headers);
        const requestTrailers: {headers: OutgoingHttpHeaders} = {headers: {}};
        stream.on("trailers", (trailers) => {
            try {
                validateHeaders(trailers, true);
                requestTrailers.headers = {...trailers};
            } catch (error) {
                this.reportError(error);
                stream.close(constants.NGHTTP2_PROTOCOL_ERROR);
            }
        });
        const method = scalarHeader(headers, ":method");
        const authority = scalarHeader(headers, ":authority");
        const path = scalarHeader(headers, ":path");
        if (
            method === "CONNECT" || headers[":protocol"] !== undefined
            || headers.upgrade !== undefined || headers["http2-settings"] !== undefined
            || scalarHeader(headers, ":scheme") !== scheme
            || !authority || /[\s\\/@?#]/.test(authority)
            || !path || (!path.startsWith("/") && !(path === "*" && method === "OPTIONS"))
        ) {
            this.deny(stream, 400);
            return;
        }
        // Preserve the HTTP/1 authority rules (including custom-resolution flows),
        // but never permit Host to compete with the HTTP/2 :authority identity.
        const event = createHttpRequestEvent(method, path, authority, approval, scheme);
        if (headers.host !== undefined) {
            const hostEvent = createHttpRequestEvent(method, path, scalarHeader(headers, "host"), approval, scheme);
            if (hostEvent.url !== event.url) throw new Error("HTTP/2 Host differs from :authority");
        }
        // URL parsing must not reinterpret a network-path reference as another host.
        if (path.startsWith("//")) throw new Error("Invalid HTTP/2 origin-form target");
        const contentType = headers["content-type"];
        const protocols = grpcProtocols(contentType === undefined ? [] : Array.isArray(contentType) ? contentType : [contentType]);
        let allowed = false;
        try {
            allowed = await authorizeHttpOperation(this.options, event, protocols, signal);
        } catch (error) {
            this.reportError(error);
        }
        if (signal.aborted || this.stopping || stream.destroyed || stream.closed) return;
        if (!allowed) {
            this.deny(stream, 403);
            return;
        }
        this.forwardStream(stream, headers, event, approval, signal, requestTrailers);
    }

    private forwardStream(
        downstream: ServerHttp2Stream,
        headers: IncomingHttpHeaders,
        event: HttpRequestEvent,
        approval: TcpGatewayApproval,
        signal: AbortSignal,
        requestTrailers: {headers: OutgoingHttpHeaders},
    ): void {
        // Never pool across streams: a refused stream cannot borrow an authorized
        // session, and GOAWAY/reset cannot trigger an implicit replay/retry.
        const authority = `${event.scheme}://${formatAuthority(event.hostname, event.port, event.scheme)}`;
        const upstream = connect(authority, {
            ...SESSION_OPTIONS,
            createConnection: () => {
                const address = {
                    host: approval.upstream.address,
                    port: approval.upstream.port,
                    family: approval.family === NetworkAddressFamily.IPV4 ? 4 : 6,
                };
                return event.scheme === "http"
                    ? createConnection(address)
                    : connectTls({...address, ...upstreamTlsOptions(event, this.options.additionalUpstreamCa), ALPNProtocols: ["h2"]});
            },
        });
        this.upstreamSessions.add(upstream);
        let request: ClientHttp2Stream | undefined;
        let receivedGoaway = false;
        const stop = () => {
            request?.destroy();
            upstream.destroy();
            if (!downstream.destroyed) downstream.close(constants.NGHTTP2_CANCEL);
        };
        const fail = (error: unknown) => {
            this.reportError(error);
            this.deny(downstream, 502);
            request?.destroy();
            upstream.destroy();
        };
        signal.addEventListener("abort", stop, {once: true});
        upstream.once("close", () => {
            this.upstreamSessions.delete(upstream);
            signal.removeEventListener("abort", stop);
            if (!downstream.writableEnded) this.deny(downstream, 502);
        });
        upstream.on("error", fail);
        upstream.on("stream", (pushed) => pushed.close(constants.NGHTTP2_REFUSED_STREAM));
        upstream.on("goaway", (errorCode, lastStreamId) => {
            receivedGoaway = true;
            const streamId = request?.id;
            // NO_ERROR closes admission, not an already included RPC. Node drains
            // existing streams before closing this session. Check every GOAWAY:
            // a subsequent frame can lower the last processed stream ID or fail.
            if (errorCode === constants.NGHTTP2_NO_ERROR
                && streamId !== undefined && streamId > 0 && streamId <= lastStreamId) return;
            fail(new Error(`Upstream HTTP/2 GOAWAY rejected request (code ${errorCode}, last stream ${lastStreamId}); request not retried`));
        });
        downstream.once("close", () => {
            request?.destroy();
            upstream.destroy();
        });
        upstream.once("connect", () => {
            if (signal.aborted || this.stopping || downstream.closed || downstream.destroyed) return stop();
            if (receivedGoaway) return fail(new Error("Upstream HTTP/2 GOAWAY before request admission; request not retried"));
            if (event.scheme === "https" && upstream.alpnProtocol !== "h2") {
                return fail(new Error("Upstream did not negotiate HTTP/2"));
            }
            try {
                const outgoing: OutgoingHttpHeaders = {...headers};
                delete outgoing.host;
                outgoing[":authority"] = formatAuthority(event.hostname, event.port, event.scheme);
                outgoing[":path"] = event.path;
                request = upstream.request(outgoing, {endStream: false, waitForTrailers: true});
                request.on("error", fail);
                request.once("aborted", () => fail(new Error("Upstream HTTP/2 stream aborted")));
                request.once("wantTrailers", () => {
                    if (!request!.destroyed && !signal.aborted) request!.sendTrailers(requestTrailers.headers);
                });
                let responseTrailers: OutgoingHttpHeaders = {};
                request.once("response", (responseHeaders) => {
                    try {
                        validateHeaders(responseHeaders);
                        if (responseHeaders[":status"] === 101) throw new Error("Unsupported HTTP/2 upgrade");
                        downstream.respond(responseHeaders, {waitForTrailers: true});
                        downstream.once("wantTrailers", () => {
                            if (!downstream.destroyed && !signal.aborted) downstream.sendTrailers(responseTrailers);
                        });
                        request!.pipe(downstream);
                    } catch (error) {
                        fail(error);
                    }
                });
                request.on("trailers", (trailers) => {
                    try {
                        validateHeaders(trailers, true);
                        responseTrailers = {...trailers};
                    } catch (error) {
                        fail(error);
                    }
                });
                downstream.pipe(request);
            } catch (error) {
                fail(error);
            }
        });
    }

    private deny(stream: ServerHttp2Stream, status: number): void {
        if (stream.destroyed || stream.closed) return;
        if (stream.headersSent) {
            stream.close(constants.NGHTTP2_CANCEL);
            return;
        }
        stream.respond({":status": status, "content-length": "0"});
        stream.end();
        // Do not drain unlimited denied request bodies. Send the response first,
        // then cancel only this stream, leaving authorized siblings unaffected.
        stream.once("finish", () => stream.close(constants.NGHTTP2_NO_ERROR));
    }

    private reportError(error: unknown): void {
        if (this.stopping) return;
        try {
            this.options.onError?.(error);
        } catch {
            // Diagnostics cannot affect policy decisions or stream isolation.
        }
    }
}

function scalarHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`Invalid HTTP/2 ${name}`);
    return value;
}

function validateHeaders(headers: IncomingHttpHeaders, trailers = false): void {
    let bytes = 0;
    let count = 0;
    for (const [name, value] of Object.entries(headers)) {
        const values = Array.isArray(value) ? value : [String(value)];
        for (const item of values) {
            bytes += Buffer.byteLength(name) + Buffer.byteLength(item) + 32;
            count++;
        }
        if (
            ["connection", "upgrade", "keep-alive", "proxy-connection", "transfer-encoding", "http2-settings"].includes(name)
            || (name === "te" && value !== "trailers")
            || (trailers && name.startsWith(":"))
        ) throw new Error("Unsupported HTTP/2 connection or trailer header");
    }
    if (count > MAX_HTTP_HEADER_COUNT || bytes > HTTP_GATEWAY_MAX_HEADER_BYTES) {
        throw new Error("HTTP/2 header resource limit exceeded");
    }
}
