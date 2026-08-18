import {once} from "node:events";
import {Agent as HttpAgent, request as createHttpRequest} from "node:http";
import type {ClientRequest, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse} from "node:http";
import {createServer} from "node:http";
import {Agent as HttpsAgent, request as createHttpsRequest} from "node:https";
import {isIP} from "node:net";
import type {Socket} from "node:net";
import {checkServerIdentity, rootCertificates} from "node:tls";
import {NetworkAddressFamily} from "./network-queue-protocol.js";
import type {NetworkEndpoint} from "./network-queue-protocol.js";
import type {TcpGatewayApproval} from "./TcpGatewayBroker.js";

export type HttpRequestEvent = {
    scheme: "http" | "https";
    method: string;
    url: string;
    hostname: string;
    port: number;
    path: string;
    rawTarget: string;
    family: NetworkAddressFamily;
    source: NetworkEndpoint;
    destination: NetworkEndpoint;
    upstreamAddress: string;
};

export type HttpRequestAuthorizer = (
    event: HttpRequestEvent,
    signal: AbortSignal,
) => boolean | Promise<boolean>;

export type HttpRequestBrokerOptions = {
    authorize?: HttpRequestAuthorizer;
    additionalUpstreamCa?: string;
    onError?: (error: unknown) => void;
};

export const HTTP_GATEWAY_MAX_HEADER_BYTES = 64 * 1024;
const MAX_HTTP_HEADER_COUNT = 2_000;

type HttpConnectionContext = {
    approval: TcpGatewayApproval;
    scheme: "http" | "https";
    agent: HttpAgent;
    tail: Promise<void>;
};

export class HttpRequestBroker {
    private readonly options: HttpRequestBrokerOptions;
    private readonly server: Server;
    private readonly contexts = new WeakMap<Socket, HttpConnectionContext>();
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
        this.server.on("upgrade", (_request, socket) => socket.destroy());
    }

    accept(socket: Socket, approval: TcpGatewayApproval, scheme: "http" | "https"): void {
        if (this.stopping) {
            socket.destroy();
            return;
        }
        const agent = scheme === "http"
            ? new HttpAgent({keepAlive: true, maxSockets: 1, maxFreeSockets: 1})
            : new HttpsAgent({keepAlive: true, maxSockets: 1, maxFreeSockets: 1});
        this.contexts.set(socket, {approval, scheme, agent, tail: Promise.resolve()});
        socket.once("close", () => agent.destroy());
        this.server.emit("connection", socket);
        socket.resume();
    }

    close(): void {
        if (this.stopping) return;
        this.stopping = true;
        this.abortController.abort();
    }

    private enqueueRequest(request: IncomingMessage, response: ServerResponse): void {
        const context = this.contexts.get(request.socket);
        if (!context) {
            denyResponse(request, response, 502, "HTTP gateway failure");
            return;
        }
        const operation = context.tail.then(() => this.handleRequest(request, response));
        context.tail = operation.catch(() => {});
        void operation.catch((error) => {
            this.reportError(error);
            denyResponse(request, response, 502, "HTTP gateway failure");
        });
    }

    private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const context = this.contexts.get(request.socket);
        if (!context) throw new Error("HTTP gateway request has no approved TCP flow");
        const event = createHttpRequestEvent(request, context.approval, context.scheme);

        let allowed = this.options.authorize === undefined;
        if (this.options.authorize) {
            try {
                allowed = await this.options.authorize(event, this.abortController.signal);
            } catch (error) {
                this.reportError(error);
                allowed = false;
            }
        }
        if (allowed !== true || this.stopping) {
            denyResponse(request, response, 403, "HTTP request denied");
            return;
        }

        await forwardRequest(
            request,
            response,
            context.approval,
            event,
            context.agent,
            this.options.additionalUpstreamCa,
        );
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

function createHttpRequestEvent(
    request: IncomingMessage,
    approval: TcpGatewayApproval,
    scheme: "http" | "https",
): HttpRequestEvent {
    const method = request.method;
    const rawTarget = request.url;
    if (!method || !rawTarget) throw new Error("HTTP gateway received an incomplete request line");

    const authority = parseAuthority(request.headers.host, approval);
    const authorityText = formatAuthority(authority.hostname, authority.port, scheme);
    if (rawTarget === "*") {
        return {
            scheme,
            method,
            url: `${scheme}://${authorityText}/*`,
            hostname: authority.hostname,
            port: authority.port,
            path: "*",
            rawTarget,
            family: approval.family,
            source: approval.source,
            destination: approval.destination,
            upstreamAddress: approval.upstream.address,
        };
    }

    let parsed: URL;
    try {
        parsed = new URL(rawTarget, `${scheme}://${authorityText}`);
    } catch (error) {
        throw new Error("HTTP gateway received an invalid request target", {cause: error});
    }
    if (
        parsed.protocol !== `${scheme}:`
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.hash !== ""
        || normalizedUrlHostname(parsed) !== authority.hostname
        || effectivePort(parsed, scheme) !== authority.port
    ) {
        throw new Error("HTTP gateway request target changed its approved authority");
    }
    const path = `${parsed.pathname}${parsed.search}`;
    return {
        scheme,
        method,
        url: `${scheme}://${authorityText}${path}`,
        hostname: authority.hostname,
        port: authority.port,
        path,
        rawTarget,
        family: approval.family,
        source: approval.source,
        destination: approval.destination,
        upstreamAddress: approval.upstream.address,
    };
}

function parseAuthority(
    hostHeader: string | undefined,
    approval: TcpGatewayApproval,
): {hostname: string; port: number} {
    const fallbackHostname = approval.hostname ?? approval.destination.address;
    if (!hostHeader) return {hostname: fallbackHostname, port: approval.destination.port};

    let parsed: URL;
    try {
        parsed = new URL(`http://${hostHeader}`);
    } catch (error) {
        throw new Error("HTTP gateway received an invalid Host header", {cause: error});
    }
    if (
        parsed.username !== ""
        || parsed.password !== ""
        || parsed.pathname !== "/"
        || parsed.search !== ""
        || parsed.hash !== ""
    ) {
        throw new Error("HTTP gateway received an invalid Host authority");
    }
    const port = parsed.port === "" ? approval.destination.port : Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port !== approval.destination.port) {
        throw new Error("HTTP gateway Host port differs from its approved destination");
    }
    return {hostname: normalizedUrlHostname(parsed), port};
}

function normalizedUrlHostname(url: URL): string {
    return url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
}

function effectivePort(url: URL, scheme: "http" | "https"): number {
    if (url.port === "") return scheme === "http" ? 80 : 443;
    return Number(url.port);
}

function formatAuthority(hostname: string, port: number, scheme: "http" | "https"): string {
    const host = hostname.includes(":") ? `[${hostname}]` : hostname;
    const defaultPort = scheme === "http" ? 80 : 443;
    return port === defaultPort ? host : `${host}:${port}`;
}

async function forwardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    approval: TcpGatewayApproval,
    event: HttpRequestEvent,
    agent: HttpAgent,
    additionalUpstreamCa: string | undefined,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const createRequest = event.scheme === "http" ? createHttpRequest : createHttpsRequest;
        const upstream = createRequest({
            host: approval.upstream.address,
            port: approval.upstream.port,
            family: approval.family === NetworkAddressFamily.IPV4 ? 4 : 6,
            method: event.method,
            path: event.path,
            headers: forwardedRawHeaders(request.rawHeaders),
            agent,
            ...(event.scheme === "https"
                ? {
                    servername: isIP(event.hostname) === 0 ? event.hostname : undefined,
                    rejectUnauthorized: true,
                    checkServerIdentity: (_hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) => (
                        checkServerIdentity(event.hostname, certificate)
                    ),
                    ca: additionalUpstreamCa
                        ? [...rootCertificates, additionalUpstreamCa]
                        : undefined,
                    ALPNProtocols: ["http/1.1"],
                }
                : {}),
        });
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
            reject(new Error("HTTP gateway does not support protocol upgrades"));
        });
        upstream.once("connect", (_response, socket) => {
            socket.destroy();
            reject(new Error("HTTP gateway does not support upstream CONNECT tunnels"));
        });
        request.once("aborted", () => upstream.destroy());
        response.once("close", () => {
            if (!response.writableEnded) upstream.destroy();
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

function forwardedRawHeaders(rawHeaders: readonly string[]): string[] {
    const excluded = new Set([
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "transfer-encoding",
        "upgrade",
    ]);
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        if (rawHeaders[index]?.toLowerCase() !== "connection") continue;
        for (const token of rawHeaders[index + 1]!.split(",")) {
            const name = token.trim().toLowerCase();
            if (name) excluded.add(name);
        }
    }

    const forwarded: string[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        const name = rawHeaders[index]!;
        if (excluded.has(name.toLowerCase())) continue;
        forwarded.push(name, rawHeaders[index + 1]!);
    }
    return forwarded;
}

function denyResponse(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    message: string,
): void {
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
