import {createConnection, createServer, isIP} from "node:net";
import type {Server, Socket} from "node:net";
import {TLSSocket} from "node:tls";
import {HTTP_GATEWAY_MAX_HEADER_BYTES, HttpRequestBroker} from "./HttpRequestBroker.js";
import type {HttpRequestAuthorizer} from "./HttpRequestBroker.js";
import {NetworkAddressFamily} from "./network-queue-protocol.js";
import type {NetworkEndpoint} from "./network-queue-protocol.js";
import {parseTcpGatewayFlow} from "./tcp-gateway-protocol.js";
import type {TcpGatewayFlow} from "./tcp-gateway-protocol.js";
import {TlsCertificateAuthority} from "./TlsCertificateAuthority.js";

const MAX_HEADER_BYTES = 1_024;
const MAX_PENDING_APPROVALS = 256;
const APPROVAL_TTL_MILLISECONDS = 30_000;
const HEADER_TIMEOUT_MILLISECONDS = 5_000;
const TLS_HANDSHAKE_TIMEOUT_MILLISECONDS = 5_000;
const PROTOCOL_SNIFF_TIMEOUT_MILLISECONDS = 250;
const MAX_PROTOCOL_SNIFF_BYTES = HTTP_GATEWAY_MAX_HEADER_BYTES;

export type TcpGatewayApproval = TcpGatewayFlow & {
    upstream: NetworkEndpoint;
    hostname?: string;
};

export type TcpGatewayBrokerOptions = {
    authorizeHttpRequest?: HttpRequestAuthorizer;
    certificateAuthority?: TlsCertificateAuthority;
    additionalUpstreamCa?: string;
    onError?: (error: unknown) => void;
    onFatalError?: (error: unknown) => void;
};

type PendingApproval = TcpGatewayApproval & {
    expiresAt: number;
};

export class TcpGatewayBroker {
    private readonly options: TcpGatewayBrokerOptions;
    private readonly certificateAuthority: TlsCertificateAuthority | undefined;
    private readonly httpBroker: HttpRequestBroker;
    private readonly approvals = new Map<string, PendingApproval[]>();
    private readonly sockets = new Set<Socket>();
    private server: Server | undefined;
    private listeningPort: number | undefined;
    private pendingApprovalCount = 0;
    private started = false;
    private stopping = false;

    constructor(options: TcpGatewayBrokerOptions = {}) {
        this.options = options;
        this.certificateAuthority = options.certificateAuthority;
        this.httpBroker = new HttpRequestBroker({
            authorize: options.authorizeHttpRequest,
            additionalUpstreamCa: options.additionalUpstreamCa,
            onError: (error) => this.reportError(error),
        });
    }

    get port(): number {
        if (!this.listeningPort) throw new Error("TCP gateway broker is not listening");
        return this.listeningPort;
    }

    async start(): Promise<void> {
        if (this.started || this.stopping) throw new Error("TCP gateway broker already started");
        this.started = true;
        const server = createServer({allowHalfOpen: true}, (socket) => this.accept(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                server.off("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(0, "127.0.0.1");
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("TCP gateway broker returned an invalid address");
        this.listeningPort = address.port;
        server.on("error", (error) => this.reportFatalError(error));
    }

    approve(approval: TcpGatewayApproval): void {
        if (!this.listeningPort || this.stopping) throw new Error("TCP gateway broker is unavailable");
        this.pruneExpiredApprovals();
        if (this.pendingApprovalCount >= MAX_PENDING_APPROVALS) {
            throw new Error("TCP gateway pending approval limit exceeded");
        }
        validateApproval(approval);
        const key = flowKey(approval);
        const pending = this.approvals.get(key) ?? [];
        pending.push({...approval, expiresAt: Date.now() + APPROVAL_TTL_MILLISECONDS});
        this.approvals.set(key, pending);
        this.pendingApprovalCount++;
    }

    async close(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        this.listeningPort = undefined;
        this.httpBroker.close();
        this.approvals.clear();
        this.pendingApprovalCount = 0;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        const server = this.server;
        this.server = undefined;
        if (!server) return;
        await new Promise<void>((resolve) => {
            try {
                server.close(() => resolve());
            } catch {
                resolve();
            }
        });
    }

    private accept(socket: Socket): void {
        if (this.stopping) {
            socket.destroy();
            return;
        }
        this.track(socket);
        void this.handle(socket).catch((error) => {
            this.reportError(error);
            socket.destroy();
        });
    }

    private async handle(client: Socket): Promise<void> {
        const line = await readHeaderLine(client);
        const flow = parseTcpGatewayFlow(line);
        const approval = this.consumeApproval(flow);
        if (!approval) throw new Error("TCP gateway received a flow without a pending approval");

        const sniffed = await sniffClientProtocol(client);
        if (sniffed.bytes.length > 0) client.unshift(sniffed.bytes);
        if (sniffed.protocol === "http1") {
            this.httpBroker.accept(client, approval, "http");
            return;
        }
        if (sniffed.protocol === "tls" && this.options.authorizeHttpRequest) {
            const certificateAuthority = this.certificateAuthority;
            if (!certificateAuthority) throw new Error("TLS gateway certificate authority is unavailable");
            const identity = approval.hostname ?? approval.destination.address;
            const tlsClient = new TLSSocket(client, {
                isServer: true,
                secureContext: certificateAuthority.secureContext(identity),
                ALPNProtocols: ["http/1.1"],
                SNICallback: (servername, callback) => {
                    try {
                        if (
                            approval.hostname
                            && normalizeServername(servername) !== normalizeServername(approval.hostname)
                        ) {
                            throw new Error("TLS gateway SNI differs from its approved hostname");
                        }
                        callback(null, certificateAuthority.secureContext(servername));
                    } catch (error) {
                        callback(error instanceof Error ? error : new Error(String(error)));
                    }
                },
            });
            this.track(tlsClient);
            await waitForTlsHandshake(tlsClient);
            if (
                approval.hostname
                && tlsClient.servername
                && normalizeServername(tlsClient.servername) !== normalizeServername(approval.hostname)
            ) {
                tlsClient.destroy();
                throw new Error("TLS gateway SNI differs from its approved hostname");
            }
            this.httpBroker.accept(tlsClient, approval, "https");
            return;
        }
        if (this.options.authorizeHttpRequest) {
            throw new Error("request-aware gateway denied an opaque TCP protocol");
        }

        const upstream = createConnection({
            host: approval.upstream.address,
            port: approval.upstream.port,
            family: approval.family === NetworkAddressFamily.IPV4 ? 4 : 6,
            allowHalfOpen: true,
        });
        this.track(upstream);
        await waitForConnect(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
    }

    private consumeApproval(flow: TcpGatewayFlow): PendingApproval | undefined {
        this.pruneExpiredApprovals();
        const key = flowKey(flow);
        const pending = this.approvals.get(key);
        if (!pending) return undefined;
        const approval = pending.shift();
        if (!approval) return undefined;
        this.pendingApprovalCount--;
        if (pending.length === 0) this.approvals.delete(key);
        return approval;
    }

    private pruneExpiredApprovals(): void {
        const now = Date.now();
        for (const [key, pending] of this.approvals) {
            const retained = pending.filter((approval) => approval.expiresAt > now);
            this.pendingApprovalCount -= pending.length - retained.length;
            if (retained.length === 0) this.approvals.delete(key);
            else if (retained.length !== pending.length) this.approvals.set(key, retained);
        }
    }

    private track(socket: Socket): void {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        socket.on("error", (error) => {
            if (!this.stopping) this.reportError(error);
        });
    }

    private reportError(error: unknown): void {
        if (this.stopping) return;
        try {
            this.options.onError?.(error);
        } catch {
            // Error reporting cannot make an unapproved flow usable.
        }
    }

    private reportFatalError(error: unknown): void {
        if (this.stopping) return;
        try {
            this.options.onFatalError?.(error);
        } catch {
            // The lifecycle owner still observes the unusable broker.
        }
    }
}

function validateApproval(approval: TcpGatewayApproval): void {
    const expectedVersion = approval.family === NetworkAddressFamily.IPV4 ? 4 : 6;
    for (const [name, endpoint] of [
        ["source", approval.source],
        ["destination", approval.destination],
        ["upstream", approval.upstream],
    ] as const) {
        if (endpoint.port < 1 || endpoint.port > 65_535 || !Number.isSafeInteger(endpoint.port)) {
            throw new Error(`TCP gateway approval used an invalid ${name} port`);
        }
        const actualVersion = isIP(endpoint.address);
        if (actualVersion !== expectedVersion) {
            throw new Error(`TCP gateway approval used an invalid ${name} address family`);
        }
    }
}

function flowKey(flow: TcpGatewayFlow): string {
    return [
        flow.family,
        flow.source.address,
        flow.source.port,
        flow.destination.address,
        flow.destination.port,
    ].join("\0");
}

async function readHeaderLine(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const timeout = setTimeout(() => finish(new Error("TCP gateway ingress header timed out")), HEADER_TIMEOUT_MILLISECONDS);
        const onData = (data: Buffer) => {
            buffered = Buffer.concat([buffered, data]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) {
                if (buffered.length > MAX_HEADER_BYTES) {
                    finish(new Error("TCP gateway ingress header exceeds the size limit"));
                }
                return;
            }
            if (newline > MAX_HEADER_BYTES) {
                finish(new Error("TCP gateway ingress header exceeds the size limit"));
                return;
            }
            const header = buffered.subarray(0, newline);
            const remainder = buffered.subarray(newline + 1);
            socket.pause();
            if (remainder.length > 0) socket.unshift(remainder);
            finish(undefined, header.toString("utf8").replace(/\r$/, ""));
        };
        const onEnd = () => finish(new Error("TCP gateway ingress closed before its flow header"));
        const onError = (error: Error) => finish(error);
        const finish = (error?: Error, line?: string) => {
            clearTimeout(timeout);
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
            if (error) reject(error);
            else if (line !== undefined) resolve(line);
            else reject(new Error("TCP gateway ingress header ended unexpectedly"));
        };
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("error", onError);
    });
}

type SniffedClientProtocol = {
    protocol: "http1" | "tls" | "opaque";
    bytes: Buffer;
};

async function sniffClientProtocol(socket: Socket): Promise<SniffedClientProtocol> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        let settled = false;
        const timeout = setTimeout(
            () => finish(undefined, {protocol: "opaque", bytes: buffered}),
            PROTOCOL_SNIFF_TIMEOUT_MILLISECONDS,
        );
        const onData = (data: Buffer) => {
            buffered = Buffer.concat([buffered, data]);
            const protocol = classifyClientProtocol(buffered);
            if (protocol) finish(undefined, {protocol, bytes: buffered});
        };
        const onEnd = () => {
            if (buffered.length === 0) finish(new Error("TCP gateway client closed before sending protocol data"));
            else finish(undefined, {protocol: "opaque", bytes: buffered});
        };
        const onError = (error: Error) => finish(error);
        const finish = (error?: Error, result?: SniffedClientProtocol) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.pause();
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
            if (error) reject(error);
            else if (result) resolve(result);
            else reject(new Error("TCP gateway protocol sniff ended unexpectedly"));
        };
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("error", onError);
        socket.resume();
    });
}

function classifyClientProtocol(bytes: Buffer): "http1" | "tls" | "opaque" | null {
    if (bytes.length >= 3 && bytes[0] === 0x16 && bytes[1] === 0x03) return "tls";
    if (bytes.length > 0 && !isHttpTokenByte(bytes[0]!)) return "opaque";

    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
        const line = bytes.subarray(0, newline).toString("ascii").replace(/\r$/, "");
        return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s+\S+\s+HTTP\/1\.[01]$/.test(line)
            ? "http1"
            : "opaque";
    }
    if (bytes.length >= MAX_PROTOCOL_SNIFF_BYTES) return "opaque";
    return null;
}

function isHttpTokenByte(byte: number): boolean {
    return (byte >= 0x30 && byte <= 0x39)
        || (byte >= 0x41 && byte <= 0x5a)
        || (byte >= 0x61 && byte <= 0x7a)
        || "!#$%&'*+-.^_`|~".includes(String.fromCharCode(byte));
}

async function waitForTlsHandshake(socket: TLSSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(
            () => finish(new Error("TLS gateway handshake timed out")),
            TLS_HANDSHAKE_TIMEOUT_MILLISECONDS,
        );
        const onSecure = () => finish();
        const onError = (error: Error) => finish(error);
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.off("secure", onSecure);
            socket.off("error", onError);
            if (error) reject(error);
            else resolve();
        };
        socket.once("secure", onSecure);
        socket.once("error", onError);
        socket.resume();
    });
}

function normalizeServername(servername: string): string {
    return servername.toLowerCase().replace(/\.$/, "");
}

async function waitForConnect(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
            socket.off("error", onError);
            resolve();
        };
        const onError = (error: Error) => {
            socket.off("connect", onConnect);
            reject(error);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
    });
}
