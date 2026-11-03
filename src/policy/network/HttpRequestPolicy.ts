import {isIP} from "node:net";
import {checkServerIdentity, rootCertificates} from "node:tls";
import type {ConnectionOptions} from "node:tls";
import type {NetworkAddressFamily, NetworkEndpoint} from "./network-queue-protocol.js";
import {NetworkApplicationProtocol} from "./NetworkProtocol.js";
import type {NetworkProtocolAuthorizer} from "./NetworkProtocol.js";
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
    authorizeProtocol?: NetworkProtocolAuthorizer;
    additionalUpstreamCa?: string;
    onError?: (error: unknown) => void;
};

export const HTTP_GATEWAY_MAX_HEADER_BYTES = 64 * 1024;
export const MAX_HTTP_HEADER_COUNT = 2_000;

export async function authorizeHttpOperation(
    options: HttpRequestBrokerOptions,
    event: HttpRequestEvent,
    protocols: readonly NetworkApplicationProtocol[],
    signal: AbortSignal,
): Promise<boolean> {
    if (signal.aborted) return false;
    if (options.authorize && await options.authorize(event, signal) !== true) return false;
    for (const protocol of protocols) {
        if (signal.aborted || !options.authorizeProtocol) return false;
        if (await options.authorizeProtocol({
            protocol,
            uri: event.url,
            family: event.family,
            source: event.source,
            destination: event.destination,
            upstreamAddress: event.upstreamAddress,
        }, signal) !== true) return false;
    }
    return !signal.aborted;
}

// Inspect original values, before hop-by-hop filtering. Duplicated media headers
// must not let a downstream/upstream parser disagreement bypass protocol policy.
export function grpcProtocols(contentTypes: readonly string[]): NetworkApplicationProtocol[] {
    return contentTypes.some((value) => value.split(",").some((media) => (
        /^application\/grpc(?:-web(?:-text)?)?(?:\+[!#$%&'*+.^_`|~0-9a-z-]+)?$/i.test(media.split(";", 1)[0]!.trim())
    ))) ? [NetworkApplicationProtocol.GRPC] : [];
}

export function upstreamTlsOptions(event: HttpRequestEvent, additionalCa?: string): ConnectionOptions {
    return {
        servername: isIP(event.hostname) === 0 ? event.hostname : undefined,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(event.hostname, certificate),
        ca: additionalCa ? [...rootCertificates, additionalCa] : undefined,
    };
}

export function createHttpRequestEvent(
    method: string | undefined,
    rawTarget: string | undefined,
    hostHeader: string | undefined,
    approval: TcpGatewayApproval,
    scheme: "http" | "https",
): HttpRequestEvent {
    if (!method || !rawTarget) throw new Error("HTTP gateway received an incomplete request line");
    const authority = parseAuthority(hostHeader, approval);
    const authorityText = formatAuthority(authority.hostname, authority.port, scheme);
    if (rawTarget === "*") {
        return {
            scheme, method, url: `${scheme}://${authorityText}/*`,
            hostname: authority.hostname, port: authority.port, path: "*", rawTarget,
            family: approval.family, source: approval.source, destination: approval.destination,
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
    ) throw new Error("HTTP gateway request target changed its approved authority");
    const path = `${parsed.pathname}${parsed.search}`;
    return {
        scheme, method, url: `${scheme}://${authorityText}${path}`,
        hostname: authority.hostname, port: authority.port, path, rawTarget,
        family: approval.family, source: approval.source, destination: approval.destination,
        upstreamAddress: approval.upstream.address,
    };
}

function parseAuthority(
    hostHeader: string | undefined,
    approval: TcpGatewayApproval,
): {hostname: string; port: number} {
    const fallbackHostname = approval.hostname ?? approval.destination.address;
    if (!hostHeader) return {hostname: fallbackHostname, port: approval.destination.port};
    if (/[\s\\/@?#]/.test(hostHeader)) throw new Error("HTTP gateway received an invalid Host authority");
    let parsed: URL;
    try {
        parsed = new URL(`http://${hostHeader}`);
    } catch (error) {
        throw new Error("HTTP gateway received an invalid Host header", {cause: error});
    }
    if (
        parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/"
        || parsed.search !== "" || parsed.hash !== ""
    ) throw new Error("HTTP gateway received an invalid Host authority");
    // URL normalizes an explicit :80 away under the HTTP parsing base. Preserve
    // that port for the flow check rather than silently replacing it with the destination.
    const explicitPort = /:(\d+)$/.exec(hostHeader)?.[1];
    const port = explicitPort === undefined ? approval.destination.port : Number(explicitPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port !== approval.destination.port) {
        throw new Error("HTTP gateway Host port differs from its approved destination");
    }
    return {hostname: normalizedUrlHostname(parsed), port};
}

function normalizedUrlHostname(url: URL): string {
    return url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1) : url.hostname;
}

function effectivePort(url: URL, scheme: "http" | "https"): number {
    if (url.port === "") return scheme === "http" ? 80 : 443;
    return Number(url.port);
}

export function formatAuthority(hostname: string, port: number, scheme: "http" | "https"): string {
    const host = hostname.includes(":") ? `[${hostname}]` : hostname;
    const defaultPort = scheme === "http" ? 80 : 443;
    return port === defaultPort ? host : `${host}:${port}`;
}

export function forwardedRawHeaders(rawHeaders: readonly string[]): string[] {
    const excluded = new Set([
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "proxy-connection", "te", "transfer-encoding", "upgrade",
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

export function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
    const values: string[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        if (rawHeaders[index]!.toLowerCase() === name) values.push(rawHeaders[index + 1]!);
    }
    return values;
}
