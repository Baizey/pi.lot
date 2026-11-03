import {createConnection, createServer, isIP} from "node:net";
import type {Server, Socket} from "node:net";
import {finished} from "node:stream";
import {checkServerIdentity, connect as connectTls, rootCertificates, TLSSocket} from "node:tls";
import {HttpRequestBroker} from "./HttpRequestBroker.js";
import type {HttpRequestAuthorizer} from "./HttpRequestBroker.js";
import {Http2RequestBroker} from "./Http2RequestBroker.js";
import {NetworkApplicationProtocol, type NetworkProtocolAuthorizer} from "./NetworkProtocol.js";
import {sniffTcpProtocol, TcpApplicationProtocol, type SniffedTcpProtocol} from "./TcpProtocol.js";
import {NetworkAddressFamily} from "./network-queue-protocol.js";
import type {NetworkEndpoint} from "./network-queue-protocol.js";
import {parseTcpGatewayFlow} from "./tcp-gateway-protocol.js";
import type {TcpGatewayFlow} from "./tcp-gateway-protocol.js";
import {TlsCertificateAuthority} from "./TlsCertificateAuthority.js";

const MAX_HEADER_BYTES = 1_024;
const MAX_PENDING_APPROVALS = 256;
const MAX_ACTIVE_CONNECTIONS = 1_024;
const APPROVAL_TTL_MILLISECONDS = 30_000;
const HEADER_TIMEOUT_MILLISECONDS = 5_000;
const TLS_HANDSHAKE_TIMEOUT_MILLISECONDS = 5_000;
const UPSTREAM_CONNECT_TIMEOUT_MILLISECONDS = 5_000;
const PROBE_CLIENT_WAIT_MILLISECONDS = 5_000;

export type TcpGatewayApproval = TcpGatewayFlow & {
    upstream: NetworkEndpoint;
    hostname?: string;
};

export type TcpGatewayBrokerOptions = {
    authorizeHttpRequest?: HttpRequestAuthorizer;
    authorizeProtocol?: NetworkProtocolAuthorizer;
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
    private readonly http2Broker: Http2RequestBroker;
    private readonly abortController = new AbortController();
    private readonly approvals = new Map<string, PendingApproval[]>();
    private readonly sockets = new Set<Socket>();
    private readonly clients = new Set<Socket>();
    private server: Server | undefined;
    private listeningPort: number | undefined;
    private pendingApprovalCount = 0;
    private started = false;
    private stopping = false;

    constructor(options: TcpGatewayBrokerOptions = {}) {
        this.options = options;
        this.certificateAuthority = options.certificateAuthority;
        const httpOptions = {
            authorize: options.authorizeHttpRequest,
            authorizeProtocol: options.authorizeProtocol,
            additionalUpstreamCa: options.additionalUpstreamCa,
            onError: (error: unknown) => this.reportError(error),
        };
        this.httpBroker = new HttpRequestBroker(httpOptions);
        this.http2Broker = new Http2RequestBroker(httpOptions);
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
        this.abortController.abort();
        this.httpBroker.close();
        this.http2Broker.close();
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
        if (this.stopping || this.clients.size >= MAX_ACTIVE_CONNECTIONS) {
            socket.destroy();
            return;
        }
        this.clients.add(socket);
        socket.once("close", () => this.clients.delete(socket));
        this.track(socket);
        void this.handle(socket).catch((error) => {
            this.reportError(error);
            socket.destroy();
        });
    }

    private async handle(client: Socket): Promise<void> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        client.once("close", abort);
        client.once("error", abort);
        const signal = AbortSignal.any([controller.signal, this.abortController.signal]);
        try {
            const line = await readHeaderLine(client, signal);
            const approval = this.consumeApproval(parseTcpGatewayFlow(line));
            if (!approval) throw new Error("TCP gateway received a flow without a pending approval");
            if (!this.options.authorizeHttpRequest && !this.options.authorizeProtocol) {
                // Trusted programmatic transport-only callers retain byte-exact
                // forwarding for every protocol. Production Bash always authorizes protocols.
                await this.relayUnmodified(client, approval, signal);
                return;
            }
            const sniffed = await sniffTcpProtocol(client, "client", signal);
            if (sniffed.bytes.length > 0) client.unshift(sniffed.bytes);
            await this.dispatchApplication(client, approval, "http", sniffed.protocol, signal);
        } finally {
            client.off("close", abort);
            client.off("error", abort);
        }
    }

    private async inspectTls(client: Socket, approval: TcpGatewayApproval, signal: AbortSignal): Promise<void> {
        const tlsClient = this.createTlsClient(client, approval);
        const controller = new AbortController();
        const abort = () => controller.abort();
        tlsClient.once("close", abort);
        tlsClient.once("error", abort);
        const tlsSignal = AbortSignal.any([signal, controller.signal]);
        try {
            await waitForTlsHandshake(tlsClient, tlsSignal);
            if (
                approval.hostname
                && tlsClient.servername
                && normalizeServername(tlsClient.servername) !== normalizeServername(approval.hostname)
            ) throw new Error("TLS gateway SNI differs from its approved hostname");
            // A literal-IP flow may carry a valid DNS SNI. Use it only for pinned
            // upstream TLS verification, never to replace the approved policy target.
            const tlsIdentity = approval.hostname || tlsClient.servername || approval.destination.address;
            // Negotiated HTTP pins the parser even when application bytes arrive late.
            if (tlsClient.alpnProtocol === "h2") {
                this.http2Broker.accept(tlsClient, approval, "https");
                return;
            }
            if (tlsClient.alpnProtocol === "http/1.1") {
                this.httpBroker.accept(tlsClient, approval, "https");
                return;
            }
            const decrypted = await sniffTcpProtocol(tlsClient, "client", tlsSignal);
            if (decrypted.bytes.length > 0) tlsClient.unshift(decrypted.bytes);
            await this.dispatchApplication(tlsClient, approval, "https", decrypted.protocol, tlsSignal, tlsIdentity);
        } catch (error) {
            tlsClient.destroy();
            throw error;
        } finally {
            tlsClient.off("close", abort);
            tlsClient.off("error", abort);
        }
    }

    private async dispatchApplication(
        client: Socket,
        approval: TcpGatewayApproval,
        scheme: "http" | "https",
        protocol: TcpApplicationProtocol,
        signal: AbortSignal,
        tlsIdentity?: string,
    ): Promise<void> {
        this.assertFlowActive(client, signal);
        if (protocol === TcpApplicationProtocol.TLS && scheme === "http") {
            // Inspection off intentionally preserves opaque, end-to-end encrypted traffic.
            if (!this.options.authorizeHttpRequest) await this.relayUnmodified(client, approval, signal);
            else await this.inspectTls(client, approval, signal);
        } else if (protocol === TcpApplicationProtocol.HTTP1) {
            this.httpBroker.accept(client, approval, scheme);
        } else if (protocol === TcpApplicationProtocol.HTTP2) {
            this.http2Broker.accept(client, approval, scheme);
        } else if (protocol === TcpApplicationProtocol.SSH || protocol === TcpApplicationProtocol.SMTP) {
            await this.authorizeStream(client, approval, protocol, signal);
            const upstream = await this.connectUpstream(approval, scheme, signal, tlsIdentity);
            try {
                this.assertFlowActive(client, signal);
                // A client's SSH/SMTP identification is only a claim. Confirm it
                // against the actual server envelope before releasing app bytes;
                // otherwise an SSH-shaped request could become an approved SMTP session.
                await this.confirmServerProtocol(upstream, protocol, signal);
                this.assertFlowActive(client, signal);
                relaySockets(client, upstream);
            } catch (error) {
                upstream.destroy();
                throw error;
            }
        } else if (protocol === TcpApplicationProtocol.SILENT) {
            await this.probeServerGreeting(client, approval, scheme, signal, tlsIdentity);
        } else if (!this.options.authorizeHttpRequest && scheme === "http") {
            await this.relayUnmodified(client, approval, signal);
        } else {
            throw new Error("request-aware gateway denied an opaque TCP protocol");
        }
    }

    private createTlsClient(client: Socket, approval: TcpGatewayApproval): TLSSocket {
        const certificateAuthority = this.certificateAuthority;
        if (!certificateAuthority) throw new Error("TLS gateway certificate authority is unavailable");
        const identity = approval.hostname ?? approval.destination.address;
        const socket = new TLSSocket(client, {
            isServer: true,
            secureContext: certificateAuthority.secureContext(identity),
            ALPNProtocols: ["h2", "http/1.1"],
            SNICallback: (servername, callback) => {
                try {
                    if (approval.hostname && normalizeServername(servername) !== normalizeServername(approval.hostname)) {
                        throw new Error("TLS gateway SNI differs from its approved hostname");
                    }
                    callback(null, certificateAuthority.secureContext(servername));
                } catch (error) {
                    callback(error instanceof Error ? error : new Error(String(error)));
                }
            },
        });
        this.track(socket);
        return socket;
    }

    private async confirmServerProtocol(
        upstream: Socket,
        expected: TcpApplicationProtocol.SSH | TcpApplicationProtocol.SMTP,
        signal: AbortSignal,
    ): Promise<void> {
        const sniffed = await sniffTcpProtocol(upstream, "server", signal);
        if (sniffed.bytes.length > 0 && !upstream.destroyed) upstream.unshift(sniffed.bytes);
        if (sniffed.protocol !== expected) {
            throw new Error(`TCP gateway ${expected.toUpperCase()} identification was not confirmed by the upstream greeting`);
        }
    }

    private async authorizeStream(
        client: Socket,
        approval: TcpGatewayApproval,
        protocol: TcpApplicationProtocol.SSH | TcpApplicationProtocol.SMTP,
        signal: AbortSignal,
    ): Promise<void> {
        const hostname = approval.hostname ?? approval.destination.address;
        const host = hostname.includes(":") ? `[${hostname}]` : hostname;
        this.assertFlowActive(client, signal);
        const allowed = await awaitWithAbort(() => this.options.authorizeProtocol?.({
            protocol: protocol === TcpApplicationProtocol.SSH ? NetworkApplicationProtocol.SSH : NetworkApplicationProtocol.SMTP,
            uri: `${host}:${approval.destination.port}`,
            family: approval.family,
            source: approval.source,
            destination: approval.destination,
            upstreamAddress: approval.upstream.address,
        }, signal), signal);
        this.assertFlowActive(client, signal);
        if (allowed !== true) throw new Error(`${protocol.toUpperCase()} connection denied by protocol policy`);
    }

    private async probeServerGreeting(
        client: Socket,
        approval: TcpGatewayApproval,
        scheme: "http" | "https",
        signal: AbortSignal,
        tlsIdentity?: string,
    ): Promise<void> {
        // Transport permission already exists. Server-first identification may open that
        // transport, but never sends client bytes or releases the greeting before approval.
        const upstream = await this.connectUpstream(approval, scheme, signal, tlsIdentity);
        const controller = new AbortController();
        const abort = () => controller.abort();
        const probeSignal = AbortSignal.any([signal, controller.signal]);
        const cancel = () => {
            upstream.destroy();
            client.destroy();
        };
        upstream.once("close", abort);
        upstream.once("error", abort);
        probeSignal.addEventListener("abort", cancel, {once: true});
        let observing = true;
        const cleanup = () => {
            if (!observing) return;
            observing = false;
            upstream.off("close", abort);
            upstream.off("error", abort);
            probeSignal.removeEventListener("abort", cancel);
        };
        try {
            if (upstream.destroyed || probeSignal.aborted) {
                cancel();
                throw new Error("TCP gateway probe was aborted");
            }
            const protocol = await sniffProbeProtocols(client, upstream, probeSignal);
            this.assertFlowActive(client, probeSignal);
            if (isHttpOrTlsProtocol(protocol) && (protocol !== TcpApplicationProtocol.TLS || scheme === "http")) {
                if (!this.options.authorizeHttpRequest && !this.options.authorizeProtocol) {
                    relaySockets(client, upstream);
                    return;
                }
                // HTTP/TLS handlers own their pinned connections; discard only the
                // speculative upstream, without letting its close cancel the client.
                cleanup();
                upstream.destroy();
                await this.dispatchApplication(client, approval, scheme, protocol, signal, tlsIdentity);
                return;
            }
            if (protocol === TcpApplicationProtocol.SSH || protocol === TcpApplicationProtocol.SMTP) {
                await this.authorizeStream(client, approval, protocol, probeSignal);
            } else if (this.options.authorizeHttpRequest || scheme === "https") {
                throw new Error("request-aware gateway denied an unrecognized server greeting");
            }
            this.assertFlowActive(client, probeSignal);
            relaySockets(client, upstream);
        } catch (error) {
            upstream.destroy();
            throw error;
        } finally {
            cleanup();
        }
    }

    private async relayUnmodified(client: Socket, approval: TcpGatewayApproval, signal: AbortSignal): Promise<void> {
        const upstream = await this.connectUpstream(approval, "http", signal);
        try {
            this.assertFlowActive(client, signal);
            relaySockets(client, upstream);
        } catch (error) {
            upstream.destroy();
            throw error;
        }
    }

    private async connectUpstream(
        approval: TcpGatewayApproval,
        scheme: "http" | "https",
        signal: AbortSignal,
        tlsIdentity?: string,
    ): Promise<Socket> {
        if (signal.aborted || this.stopping) throw new Error("TCP gateway connection was aborted");
        const endpoint = {
            host: approval.upstream.address,
            port: approval.upstream.port,
            family: approval.family === NetworkAddressFamily.IPV4 ? 4 : 6,
            allowHalfOpen: true,
        };
        const identity = tlsIdentity ?? approval.hostname ?? approval.destination.address;
        const upstream = scheme === "http" ? createConnection(endpoint) : connectTls({
            ...endpoint,
            servername: isIP(identity) === 0 ? identity : undefined,
            rejectUnauthorized: true,
            checkServerIdentity: (_hostname, certificate) => checkServerIdentity(identity, certificate),
            ca: this.options.additionalUpstreamCa
                ? [...rootCertificates, this.options.additionalUpstreamCa]
                : undefined,
        });
        this.track(upstream);
        const cancel = () => { upstream.destroy(); };
        signal.addEventListener("abort", cancel, {once: true});
        try {
            if (signal.aborted) cancel();
            await waitForSocketReady(upstream, scheme === "http" ? "connect" : "secureConnect", signal,
                UPSTREAM_CONNECT_TIMEOUT_MILLISECONDS, "TCP gateway upstream connection");
            return upstream;
        } catch (error) {
            upstream.destroy();
            throw error;
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    }

    private assertFlowActive(client: Socket, signal: AbortSignal): void {
        if (signal.aborted || this.stopping || client.destroyed) throw new Error("TCP gateway connection was aborted");
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

async function readHeaderLine(socket: Socket, signal: AbortSignal): Promise<string> {
    if (signal.aborted || socket.destroyed) throw new Error("TCP gateway ingress was aborted");
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        let settled = false;
        const timeout = setTimeout(() => finish(new Error("TCP gateway ingress header timed out")), HEADER_TIMEOUT_MILLISECONDS);
        const onData = (data: Buffer) => {
            buffered = Buffer.concat([buffered, data]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) {
                if (buffered.length > MAX_HEADER_BYTES) finish(new Error("TCP gateway ingress header exceeds the size limit"));
                return;
            }
            if (newline > MAX_HEADER_BYTES) {
                finish(new Error("TCP gateway ingress header exceeds the size limit"));
                return;
            }
            socket.pause();
            const remainder = buffered.subarray(newline + 1);
            if (remainder.length > 0) socket.unshift(remainder);
            finish(undefined, buffered.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
        };
        const onEnd = () => finish(new Error("TCP gateway ingress closed before its flow header"));
        const onError = (error: Error) => finish(error);
        const onAbort = () => finish(new Error("TCP gateway ingress was aborted"));
        const finish = (error?: Error, line?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.pause();
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("close", onEnd);
            socket.off("error", onError);
            signal.removeEventListener("abort", onAbort);
            error ? reject(error) : resolve(line!);
        };
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("close", onEnd);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, {once: true});
    });
}

function waitForTlsHandshake(socket: TLSSocket, signal: AbortSignal): Promise<void> {
    return waitForSocketReady(socket, "secure", signal, TLS_HANDSHAKE_TIMEOUT_MILLISECONDS, "TLS gateway handshake");
}

function waitForSocketReady(
    socket: Socket,
    event: "connect" | "secureConnect" | "secure",
    signal: AbortSignal,
    milliseconds: number,
    subject: string,
): Promise<void> {
    if (signal.aborted || socket.destroyed) return Promise.reject(new Error(subject + " was aborted"));
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error(subject + " timed out")), milliseconds);
        const onReady = () => finish();
        const onError = (error: Error) => finish(error);
        const onClose = () => finish(new Error(subject + " closed before readiness"));
        const onAbort = () => finish(new Error(subject + " was aborted"));
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.off(event, onReady);
            socket.off("error", onError);
            socket.off("close", onClose);
            signal.removeEventListener("abort", onAbort);
            error ? reject(error) : resolve();
        };
        socket.once(event, onReady);
        socket.once("error", onError);
        socket.once("close", onClose);
        signal.addEventListener("abort", onAbort, {once: true});
    });
}

async function awaitWithAbort<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error("TCP gateway authorization was aborted");
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("TCP gateway authorization was aborted"));
        signal.addEventListener("abort", onAbort, {once: true});
    });
    try {
        if (signal.aborted) onAbort();
        return await Promise.race([
            Promise.resolve().then(() => {
                if (signal.aborted) throw new Error("TCP gateway authorization was aborted");
                return operation();
            }),
            aborted,
        ]);
    } finally {
        // Promise.race also observes late callback rejection/resolution, without
        // allowing an ignoring authorizer to retain the flow's cleanup ownership.
        signal.removeEventListener("abort", onAbort);
    }
}

type DirectionalProbe = {direction: "client" | "server"; value: SniffedTcpProtocol};

async function sniffProbeProtocols(client: Socket, upstream: Socket, signal: AbortSignal): Promise<TcpApplicationProtocol> {
    const controller = new AbortController();
    const sniffSignal = AbortSignal.any([signal, controller.signal]);
    let failure: {error: unknown} | undefined;
    const sniff = (socket: Socket, direction: "client" | "server"): Promise<DirectionalProbe> => sniffTcpProtocol(
        socket, direction, sniffSignal,
        direction === "client" ? {initialWaitMilliseconds: PROBE_CLIENT_WAIT_MILLISECONDS} : undefined,
    ).then((value) => ({direction, value})).catch((error: unknown) => {
        if (!controller.signal.aborted) failure ??= {error};
        throw error;
    });
    // Each direction owns its own bounded buffer and classification timer. The
    // client remains eligible after the original short, silent-client window.
    const clientProbe = sniff(client, "client");
    const upstreamProbe = sniff(upstream, "server");
    let results: [PromiseSettledResult<DirectionalProbe>, PromiseSettledResult<DirectionalProbe>];
    try {
        const first = await Promise.race([clientProbe, upstreamProbe]);
        // A client-side SSH/SMTP claim must not cancel the server classifier:
        // otherwise a delayed contradictory greeting can still approve the flow.
        const requiresServerConfirmation = first.direction === "client"
            && (first.value.protocol === TcpApplicationProtocol.SSH
                || first.value.protocol === TcpApplicationProtocol.SMTP);
        if (!isIdentifiedProtocol(first.value.protocol) || requiresServerConfirmation) {
            await Promise.all([clientProbe, upstreamProbe]);
        }
    } finally {
        controller.abort();
        results = await Promise.allSettled([clientProbe, upstreamProbe]);
        // Cancelled sniffers restore their own partial bytes. Successful sniffers
        // transfer bytes to us, even if both classifications won the same turn.
        for (const result of results) {
            if (result.status !== "fulfilled") continue;
            const {direction, value} = result.value;
            if (value.bytes.length === 0) continue;
            const socket = direction === "client" ? client : upstream;
            if (!socket.destroyed) socket.unshift(value.bytes);
        }
    }
    if (signal.aborted) throw new Error("TCP gateway probe was aborted");
    if (failure) throw failure.error;
    const protocols = new Set<TcpApplicationProtocol>();
    let opaque = false;
    for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const {value} = result.value;
        if (isIdentifiedProtocol(value.protocol)) protocols.add(value.protocol);
        else if (value.protocol === TcpApplicationProtocol.OPAQUE) opaque = true;
    }
    if (protocols.size > 1) throw new Error("TCP gateway received contradictory protocol identifications");
    const clientProtocol = results[0].status === "fulfilled" ? results[0].value.value.protocol : undefined;
    const serverProtocol = results[1].status === "fulfilled" ? results[1].value.value.protocol : undefined;
    if ((clientProtocol === TcpApplicationProtocol.SSH || clientProtocol === TcpApplicationProtocol.SMTP)
        && serverProtocol !== clientProtocol) {
        throw new Error(`TCP gateway ${clientProtocol.toUpperCase()} identification was not confirmed by the upstream greeting`);
    }
    return protocols.values().next().value ?? (opaque ? TcpApplicationProtocol.OPAQUE : TcpApplicationProtocol.SILENT);
}

function isHttpOrTlsProtocol(protocol: TcpApplicationProtocol): boolean {
    return protocol === TcpApplicationProtocol.HTTP1 || protocol === TcpApplicationProtocol.HTTP2
        || protocol === TcpApplicationProtocol.TLS;
}

function isIdentifiedProtocol(protocol: TcpApplicationProtocol): boolean {
    return protocol !== TcpApplicationProtocol.OPAQUE && protocol !== TcpApplicationProtocol.SILENT;
}

function relaySockets(client: Socket, upstream: Socket): void {
    if (client.destroyed || upstream.destroyed) throw new Error("TCP gateway relay peer is unavailable");
    let settled = false;
    let completed = 0;
    const cleanup = () => {
        cleanupClient();
        cleanupUpstream();
        client.unpipe(upstream);
        upstream.unpipe(client);
    };
    const complete = (error?: Error | null) => {
        if (settled) return;
        if (error) {
            settled = true;
            client.destroy();
            upstream.destroy();
            cleanup();
        } else if (++completed === 2) {
            settled = true;
            cleanup();
        }
    };
    // finished distinguishes graceful end+finish from errors/premature close. A
    // normally closed peer must not truncate the other's still-buffered writes.
    const cleanupClient = finished(client, complete);
    const cleanupUpstream = finished(upstream, complete);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
}

function normalizeServername(servername: string): string {
    return servername.toLowerCase().replace(/\.$/, "");
}
