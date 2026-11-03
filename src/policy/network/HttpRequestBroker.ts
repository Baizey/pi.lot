import {createHash} from "node:crypto";
import {once} from "node:events";
import {Agent as HttpAgent, request as createHttpRequest, createServer} from "node:http";
import type {ClientRequest, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse} from "node:http";
import {Agent as HttpsAgent, request as createHttpsRequest} from "node:https";
import type {Socket} from "node:net";
import type {Duplex} from "node:stream";
import {NetworkAddressFamily} from "./network-queue-protocol.js";
import {NetworkApplicationProtocol} from "./NetworkProtocol.js";
import type {TcpGatewayApproval} from "./TcpGatewayBroker.js";
import {
    authorizeHttpOperation, createHttpRequestEvent, forwardedRawHeaders, grpcProtocols,
    HTTP_GATEWAY_MAX_HEADER_BYTES, MAX_HTTP_HEADER_COUNT, rawHeaderValues, upstreamTlsOptions,
} from "./HttpRequestPolicy.js";
import type {HttpRequestBrokerOptions, HttpRequestEvent} from "./HttpRequestPolicy.js";

export type {HttpRequestAuthorizer, HttpRequestBrokerOptions, HttpRequestEvent} from "./HttpRequestPolicy.js";
export {HTTP_GATEWAY_MAX_HEADER_BYTES} from "./HttpRequestPolicy.js";

type HttpConnectionContext = {
    approval: TcpGatewayApproval;
    scheme: "http" | "https";
    agent: HttpAgent;
    tail: Promise<void>;
    pendingRequests: number;
};

export class HttpRequestBroker {
    private readonly options: HttpRequestBrokerOptions;
    private readonly server: Server;
    private readonly contexts = new WeakMap<Socket, HttpConnectionContext>();
    private readonly sockets = new Set<Socket>();
    private readonly abortController = new AbortController();
    private stopping = false;

    constructor(options: HttpRequestBrokerOptions = {}) {
        this.options = options;
        this.server = createServer(
            {maxHeaderSize: HTTP_GATEWAY_MAX_HEADER_BYTES},
            (request, response) => this.enqueueRequest(request, response),
        );
        this.server.headersTimeout = 5_000;
        this.server.requestTimeout = 0;
        this.server.keepAliveTimeout = 5_000;
        this.server.maxHeadersCount = MAX_HTTP_HEADER_COUNT;
        this.server.maxRequestsPerSocket = 1_000;
        this.server.on("clientError", (error, socket) => {
            this.reportError(error);
            socket.destroy();
        });
        this.server.on("connect", (_request, socket) => socket.destroy());
        this.server.on("upgrade", (request, socket, head) => {
            void this.handleUpgrade(request, socket, head).catch((error) => {
                this.reportError(error);
                socket.destroy();
            });
        });
    }

    accept(socket: Socket, approval: TcpGatewayApproval, scheme: "http" | "https"): void {
        if (this.stopping) {
            socket.destroy();
            return;
        }
        const agent = scheme === "http"
            ? new HttpAgent({keepAlive: true, maxSockets: 1, maxFreeSockets: 1})
            : new HttpsAgent({keepAlive: true, maxSockets: 1, maxFreeSockets: 1});
        this.contexts.set(socket, {approval, scheme, agent, tail: Promise.resolve(), pendingRequests: 0});
        this.sockets.add(socket);
        socket.once("close", () => {
            this.sockets.delete(socket);
            agent.destroy();
        });
        socket.on("error", (error) => this.reportError(error));
        this.server.emit("connection", socket);
        socket.resume();
    }

    close(): void {
        if (this.stopping) return;
        this.stopping = true;
        this.abortController.abort();
        for (const socket of this.sockets) socket.destroy();
    }

    private enqueueRequest(request: IncomingMessage, response: ServerResponse): void {
        const context = this.contexts.get(request.socket);
        if (!context) {
            denyResponse(request, response, 502, "HTTP gateway failure");
            return;
        }
        // Install cancellation before queuing: an abandoned pipelined request must
        // not become a new upstream effect when its predecessor finishes.
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        response.once("close", abort);
        request.socket.once("close", abort);
        const signal = AbortSignal.any([controller.signal, this.abortController.signal]);
        context.pendingRequests++;
        const operation = context.tail.then(() => this.handleRequest(request, response, context, signal));
        context.tail = operation.catch(() => {}).finally(() => {
            context.pendingRequests--;
            request.removeListener("aborted", abort);
            response.removeListener("close", abort);
            request.socket.removeListener("close", abort);
        });
        void operation.catch((error) => {
            this.reportError(error);
            denyResponse(request, response, 502, "HTTP gateway failure");
        });
    }

    private async handleRequest(
        request: IncomingMessage,
        response: ServerResponse,
        context: HttpConnectionContext,
        signal: AbortSignal,
    ): Promise<void> {
        if (signal.aborted || this.stopping) return;
        validateRequestHeaders(request);
        // An Upgrade header without the Connection token may arrive as an ordinary
        // request; never silently downgrade it into an authorized generic request.
        if (request.headers.upgrade !== undefined || request.method === "CONNECT"
            || headerTokens(rawHeaderValues(request.rawHeaders, "connection").join(",").toLowerCase()).includes("upgrade")) {
            denyResponse(request, response, 400, "Unsupported HTTP upgrade");
            return;
        }
        const event = createHttpRequestEvent(
            request.method, request.url, request.headers.host, context.approval, context.scheme,
        );
        const protocols = grpcProtocols(rawHeaderValues(request.rawHeaders, "content-type"));
        if (!await this.authorize(event, protocols, signal)) {
            denyResponse(request, response, 403, "HTTP request denied");
            return;
        }
        if (signal.aborted || this.stopping || request.socket.destroyed) return;
        await forwardRequest(request, response, context, event, this.options.additionalUpstreamCa, signal);
    }

    private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        const context = this.contexts.get(request.socket);
        // Upgrades cannot overtake outstanding HTTP responses on this connection.
        // Reject pipelined upgrades rather than transfer parser ownership mid-queue.
        if (!context || context.pendingRequests !== 0 || this.stopping) {
            socket.destroy();
            return;
        }
        socket.pause();
        validateRequestHeaders(request);
        const handshake = validateWebSocketRequest(request, head);
        const controller = new AbortController();
        const abort = () => controller.abort();
        socket.once("close", abort);
        socket.once("end", abort);
        const signal = AbortSignal.any([controller.signal, this.abortController.signal]);
        let upstream: ClientRequest | undefined;
        let peer: Duplex | undefined;
        let relaying = false;
        const stop = () => {
            upstream?.destroy();
            peer?.destroy();
            socket.destroy();
        };
        const pendingHeads = [head];
        let pendingBytes = head.length;
        const bufferPending = (chunk: Buffer) => {
            pendingBytes += chunk.length;
            if (pendingBytes > HTTP_GATEWAY_MAX_HEADER_BYTES) {
                controller.abort();
                return;
            }
            pendingHeads.push(chunk);
        };
        signal.addEventListener("abort", stop, {once: true});
        socket.on("data", bufferPending);
        socket.resume();
        socket.once("close", () => {
            socket.removeListener("data", bufferPending);
            if (relaying && socket.readableEnded && !socket.errored) {
                // Normal EOF must not discard bytes already queued to a slow peer.
                peer?.end();
            } else {
                stop();
            }
            // Keep shutdown cancellation alive while the other writable drains.
            if (!peer || peer.destroyed) signal.removeEventListener("abort", stop);
        });
        const event = createHttpRequestEvent(
            request.method, request.url, request.headers.host, context.approval, context.scheme,
        );
        const allowed = await this.authorize(event, [
            NetworkApplicationProtocol.WEBSOCKET,
            ...grpcProtocols(rawHeaderValues(request.rawHeaders, "content-type")),
        ], signal);
        if (!allowed || signal.aborted || this.stopping || socket.destroyed) {
            socket.destroy();
            return;
        }
        // Do not negotiate extensions: their syntax and semantics require separate
        // validation. Clients may offer them, but the upstream never sees the offer.
        const headers = forwardedRawHeaders(request.rawHeaders);
        const forwarded: string[] = [];
        for (let index = 0; index < headers.length; index += 2) {
            if (headers[index]!.toLowerCase() !== "sec-websocket-extensions") {
                forwarded.push(headers[index]!, headers[index + 1]!);
            }
        }
        forwarded.push("Connection", "Upgrade", "Upgrade", "websocket");
        const createRequest = event.scheme === "http" ? createHttpRequest : createHttpsRequest;
        upstream = createRequest({
            ...upstreamRequestOptions(context, event, this.options.additionalUpstreamCa),
            headers: forwarded,
            maxHeaderSize: HTTP_GATEWAY_MAX_HEADER_BYTES,
            signal,
        });
        upstream.maxHeadersCount = MAX_HTTP_HEADER_COUNT;
        const timer = setTimeout(stop, 10_000);
        timer.unref();
        upstream.once("error", (error) => {
            clearTimeout(timer);
            this.reportError(error);
            stop();
        });
        upstream.once("response", () => {
            clearTimeout(timer);
            stop();
        });
        upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
            clearTimeout(timer);
            peer = upstreamSocket;
            peer.on("error", stop);
            peer.once("close", () => {
                if (relaying && peer!.readableEnded && !peer!.errored) socket.end();
                else stop();
                if (socket.destroyed) signal.removeEventListener("abort", stop);
            });
            socket.once("error", stop);
            if (signal.aborted || this.stopping || socket.destroyed) return stop();
            try {
                validateWebSocketResponse(response, handshake.key, handshake.protocols, upstreamHead);
            } catch (error) {
                this.reportError(error);
                return stop();
            }
            const responseHeaders = forwardedRawHeaders(response.rawHeaders);
            const lines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket"];
            for (let index = 0; index < responseHeaders.length; index += 2) {
                lines.push(`${responseHeaders[index]}: ${responseHeaders[index + 1]}`);
            }
            // Restore parser head bytes into the readable queues. pipe() then owns
            // backpressure for both heads and all subsequent duplex traffic.
            peer.pause();
            socket.pause();
            socket.removeListener("data", bufferPending);
            socket.removeListener("end", abort);
            if (upstreamHead.length) peer.unshift(upstreamHead);
            if (pendingBytes) socket.unshift(Buffer.concat(pendingHeads, pendingBytes));
            const relay = () => {
                if (signal.aborted || socket.destroyed || peer!.destroyed) return stop();
                relaying = true;
                socket.removeListener("close", abort);
                socket.pipe(peer!);
                peer!.pipe(socket);
            };
            if (socket.write(`${lines.join("\r\n")}\r\n\r\n`)) relay();
            else socket.once("drain", relay);
        });
        upstream.end();
    }

    private async authorize(
        event: HttpRequestEvent,
        protocols: readonly NetworkApplicationProtocol[],
        signal: AbortSignal,
    ): Promise<boolean> {
        try {
            return await authorizeHttpOperation(this.options, event, protocols, signal);
        } catch (error) {
            this.reportError(error);
            return false;
        }
    }

    private reportError(error: unknown): void {
        if (this.stopping) return;
        try {
            this.options.onError?.(error);
        } catch {
            // Error reporting cannot turn a denied request into an allowed request.
        }
    }
}

function validateRequestHeaders(request: IncomingMessage): void {
    if (request.rawHeaders.length / 2 > MAX_HTTP_HEADER_COUNT) throw new Error("Too many HTTP headers");
    // Node's parsed headers discard duplicate Host values, while raw forwarding
    // preserves them. Reject that ambiguity before either policy or upstream I/O.
    if (rawHeaderValues(request.rawHeaders, "host").length > 1) throw new Error("Duplicate Host authority");
    // Authority, framing, classification and handshake fields must survive filtering
    // unchanged. Reject their nomination as hop-by-hop rather than changing identity.
    const protectedHeaders = new Set([
        "host", "content-type", "content-length", "sec-websocket-key", "sec-websocket-version",
        "sec-websocket-protocol", "sec-websocket-extensions", "sec-websocket-accept",
    ]);
    for (const value of rawHeaderValues(request.rawHeaders, "connection")) {
        if (value.split(",").some((token) => protectedHeaders.has(token.trim().toLowerCase()))) {
            throw new Error("HTTP Connection nominates a security-sensitive header");
        }
    }
}

function headerTokens(value: string): string[] {
    return value.split(",").map((token) => token.trim());
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
    const values = rawHeaderValues(request.rawHeaders, name);
    if (values.length > 1) throw new Error(`Duplicate ${name} header`);
    return values[0];
}

function validateWebSocketRequest(request: IncomingMessage, head: Buffer): {key: string; protocols: string[]} {
    const key = singleHeader(request, "sec-websocket-key");
    const upgrade = singleHeader(request, "upgrade");
    const version = singleHeader(request, "sec-websocket-version");
    const host = singleHeader(request, "host");
    const connection = rawHeaderValues(request.rawHeaders, "connection").join(",");
    if (
        request.method !== "GET" || request.httpVersion !== "1.1" || !host
        || upgrade?.toLowerCase() !== "websocket" || version !== "13"
        || !headerTokens(connection.toLowerCase()).includes("upgrade")
        || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key)
        || Buffer.from(key, "base64").toString("base64") !== key
        || request.headers["transfer-encoding"] !== undefined
        || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")
        || head.length > HTTP_GATEWAY_MAX_HEADER_BYTES
    ) throw new Error("Invalid WebSocket upgrade request");
    const offered = singleHeader(request, "sec-websocket-protocol");
    const protocols = offered === undefined ? [] : headerTokens(offered);
    if (protocols.some((protocol) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(protocol))
        || new Set(protocols).size !== protocols.length) throw new Error("Invalid WebSocket subprotocols");
    return {key, protocols};
}

function validateWebSocketResponse(
    response: IncomingMessage, key: string, protocols: readonly string[], head: Buffer,
): void {
    const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const selected = singleHeader(response, "sec-websocket-protocol");
    if (
        response.statusCode !== 101
        || singleHeader(response, "upgrade")?.toLowerCase() !== "websocket"
        || !headerTokens(rawHeaderValues(response.rawHeaders, "connection").join(",").toLowerCase()).includes("upgrade")
        || singleHeader(response, "sec-websocket-accept") !== expected
        || (selected !== undefined && !protocols.includes(selected))
        || response.headers["sec-websocket-extensions"] !== undefined
        || response.headers["content-length"] !== undefined
        || response.headers["transfer-encoding"] !== undefined
        || response.rawHeaders.length / 2 > MAX_HTTP_HEADER_COUNT
        || head.length > HTTP_GATEWAY_MAX_HEADER_BYTES
    ) throw new Error("Invalid upstream WebSocket handshake");
    validateRequestHeaders(response);
}

function upstreamRequestOptions(context: HttpConnectionContext, event: HttpRequestEvent, additionalCa?: string) {
    return {
        host: context.approval.upstream.address,
        port: context.approval.upstream.port,
        family: context.approval.family === NetworkAddressFamily.IPV4 ? 4 : 6,
        method: event.method,
        path: event.path,
        agent: context.agent,
        ...(event.scheme === "https" ? {...upstreamTlsOptions(event, additionalCa), ALPNProtocols: ["http/1.1"]} : {}),
    };
}

async function forwardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    context: HttpConnectionContext,
    event: HttpRequestEvent,
    additionalUpstreamCa: string | undefined,
    signal: AbortSignal,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const createRequest = event.scheme === "http" ? createHttpRequest : createHttpsRequest;
        const upstream = createRequest({
            ...upstreamRequestOptions(context, event, additionalUpstreamCa),
            headers: forwardedRawHeaders(request.rawHeaders),
            maxHeaderSize: HTTP_GATEWAY_MAX_HEADER_BYTES,
            signal,
        });
        upstream.maxHeadersCount = MAX_HTTP_HEADER_COUNT;
        upstream.once("response", (upstreamResponse) => {
            response.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.statusMessage,
                forwardedRawHeaders(upstreamResponse.rawHeaders),
            );
            upstreamResponse.once("end", () => {
                const trailers = forwardedRawHeaders(upstreamResponse.rawTrailers);
                if (trailers.length > 0) response.addTrailers(outgoingHeaders(trailers));
                resolve();
            });
            upstreamResponse.pipe(response);
            upstreamResponse.once("error", reject);
        });
        upstream.once("error", reject);
        upstream.once("upgrade", (_response, socket) => {
            socket.destroy();
            reject(new Error("Unexpected upstream protocol upgrade"));
        });
        upstream.once("connect", (_response, socket) => {
            socket.destroy();
            reject(new Error("HTTP gateway does not support upstream CONNECT tunnels"));
        });
        void forwardRequestBody(request, upstream).catch((error) => {
            upstream.destroy();
            reject(error);
        });
    });
}

async function forwardRequestBody(request: IncomingMessage, upstream: ClientRequest): Promise<void> {
    for await (const chunk of request) {
        if (!upstream.write(chunk)) await once(upstream, "drain");
    }
    const trailers = forwardedRawHeaders(request.rawTrailers);
    if (trailers.length > 0) upstream.addTrailers(outgoingHeaders(trailers));
    upstream.end();
}

function outgoingHeaders(rawHeaders: readonly string[]): OutgoingHttpHeaders {
    const result: OutgoingHttpHeaders = {};
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        const name = rawHeaders[index]!;
        const value = rawHeaders[index + 1]!;
        const existing = result[name];
        if (existing === undefined) result[name] = value;
        else if (Array.isArray(existing)) result[name] = [...existing, value];
        else result[name] = [String(existing), value];
    }
    return result;
}

function denyResponse(request: IncomingMessage, response: ServerResponse, status: number, message: string): void {
    request.resume();
    if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
    }
    response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(message),
        connection: "close",
    });
    response.end(message);
}
