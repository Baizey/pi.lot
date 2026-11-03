import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {once} from "node:events";
import {createConnection, createServer, type Server, type Socket} from "node:net";
import {connect as connectTls, createServer as createTlsServer, type TLSSocket} from "node:tls";
import test, {type TestContext} from "node:test";
import {NetworkApplicationProtocol, type NetworkProtocolEvent} from "../src/policy/network/NetworkProtocol.js";
import {NetworkAddressFamily} from "../src/policy/network/network-queue-protocol.js";
import {TcpGatewayBroker, type TcpGatewayBrokerOptions} from "../src/policy/network/TcpGatewayBroker.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";

const SSH_CLIENT = "SSH-2.0-fixture-client\r\n";
const SSH_SERVER = "Authorized access only\r\nSSH-2.0-fixture-server\r\n";
const SMTP_SERVER = "220-fixture ESMTP\r\n220 mail service ready\r\n";
let upstreamAuthority: TlsCertificateAuthority | undefined;
let interceptionAuthority: TlsCertificateAuthority | undefined;
const upstreamCa = () => upstreamAuthority ??= new TlsCertificateAuthority();
const interceptionCa = () => interceptionAuthority ??= new TlsCertificateAuthority();

for (const application of [NetworkApplicationProtocol.SSH, NetworkApplicationProtocol.SMTP]) {
    test(`${application} denial blocks client-first bytes before even opening upstream`, {timeout: 8_000}, async (t) => {
        const events: NetworkProtocolEvent[] = [];
        const fixture = await GatewayFixture.create(t, {
            authorizeHttpRequest: () => true,
            authorizeProtocol: (event) => { events.push(event); return false; },
        });
        const client = await fixture.connect(application === NetworkApplicationProtocol.SSH ? SSH_CLIENT : "EHLO client.test\r\n");
        await client.closed;
        assert.equal(fixture.connections, 0);
        assert.equal(fixture.received, "");
        assert.equal(events.length, 1);
        assert.equal(events[0]!.protocol, application);
        assert.equal(events[0]!.uri, "service.test:2222");
        assert.equal(events[0]!.upstreamAddress, "127.0.0.1");
    });

    test(`${application} stream on a nonstandard port waits for its own policy and preserves bytes`, {timeout: 8_000}, async (t) => {
        const decision = deferred<boolean>();
        const requested = deferred<void>();
        const greeting = application === NetworkApplicationProtocol.SSH ? SSH_SERVER : SMTP_SERVER;
        const fixture = await GatewayFixture.create(t, {
            authorizeHttpRequest: () => true,
            authorizeProtocol: (event) => {
                assert.equal(event.protocol, application);
                requested.resolve();
                return decision.promise;
            },
        }, greeting);
        const payload = application === NetworkApplicationProtocol.SSH ? SSH_CLIENT : "EHLO client.test\r\n";
        const client = await fixture.connect(payload);
        await requested.promise;
        assert.equal(fixture.connections, 0, "transport allow must not release application bytes");
        decision.resolve(true);
        await client.waitFor(payload);
        assert.equal(fixture.received, payload);
    });

    test(`${application} server-first denial withholds both greeting and client data`, {timeout: 8_000}, async (t) => {
        const decision = deferred<boolean>();
        const requested = deferred<void>();
        const greeting = application === NetworkApplicationProtocol.SSH ? SSH_SERVER : SMTP_SERVER;
        const fixture = await GatewayFixture.create(t, {
            authorizeHttpRequest: () => true,
            authorizeProtocol: (event) => {
                assert.equal(event.protocol, application);
                requested.resolve();
                return decision.promise;
            },
        }, greeting);
        const client = await fixture.connect();
        await requested.promise;
        assert.equal(fixture.connections, 1, "server-first detection needs its already-approved transport");
        assert.equal(client.text, "");
        assert.equal(fixture.received, "");
        client.socket.write(application === NetworkApplicationProtocol.SSH ? SSH_CLIENT : "EHLO client.test\r\n");
        decision.resolve(false);
        await client.closed;
        assert.equal(client.text, "");
        assert.equal(fixture.received, "");
    });

    test(`${application} server-first approval replays the complete greeting exactly once`, {timeout: 8_000}, async (t) => {
        const greeting = application === NetworkApplicationProtocol.SSH ? SSH_SERVER : SMTP_SERVER;
        const fixture = await GatewayFixture.create(t, {
            authorizeHttpRequest: () => true,
            authorizeProtocol: (event) => event.protocol === application,
        }, greeting);
        const client = await fixture.connect();
        await client.waitFor(greeting);
        const payload = application === NetworkApplicationProtocol.SSH ? SSH_CLIENT : "EHLO client.test\r\n";
        client.socket.write(payload);
        await client.waitFor(greeting + payload);
        assert.equal(client.text, greeting + payload);
        assert.equal(fixture.received, payload);
    });
}

for (const application of [NetworkApplicationProtocol.SSH, NetworkApplicationProtocol.SMTP]) {
    test(`trusted transport-only callers retain byte-exact ${application} when both authorizers are omitted`, {timeout: 8_000}, async (t) => {
        const fixture = await GatewayFixture.create(t, {});
        const payload = application === NetworkApplicationProtocol.SSH ? SSH_CLIENT : "EHLO client.test\r\n";
        const client = await fixture.connect(payload);
        await client.waitFor(payload);
        assert.equal(fixture.received, payload);
    });
}

for (const authorizeProtocol of [undefined, () => { throw new Error("review unavailable"); }]) {
    test(`recognized SSH fails closed with ${authorizeProtocol ? "throwing" : "missing"} protocol authorization`, {timeout: 8_000}, async (t) => {
        const fixture = await GatewayFixture.create(t, {authorizeHttpRequest: () => true, authorizeProtocol});
        const client = await fixture.connect(SSH_CLIENT);
        await client.closed;
        assert.equal(fixture.connections, 0);
        assert.equal(fixture.received, "");
        assert.ok(fixture.errors.length > 0);
    });
}

test("connection reset during approval aborts it and a late allow cannot create an upstream", {timeout: 8_000}, async (t) => {
    const decision = deferred<boolean>();
    const requested = deferred<AbortSignal>();
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        authorizeProtocol: (_event, signal) => { requested.resolve(signal); return decision.promise; },
    });
    const client = await fixture.connect(SSH_CLIENT);
    const signal = await requested.promise;
    client.socket.resetAndDestroy();
    await client.closed;
    if (!signal.aborted) await once(signal, "abort");
    assert.equal(signal.aborted, true);
    decision.resolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.connections, 0);
});

test("an approved stream preserves a client half-close and the final upstream bytes", {timeout: 8_000}, async (t) => {
    const fixture = await GatewayFixture.create(t, {authorizeHttpRequest: () => true, authorizeProtocol: () => true}, SSH_SERVER);
    const client = await fixture.connect(SSH_CLIENT);
    await client.waitFor(SSH_SERVER + SSH_CLIENT);
    client.socket.end("final payload");
    await client.closed;
    assert.equal(fixture.received, SSH_CLIENT + "final payload");
    assert.equal(client.text, SSH_SERVER + SSH_CLIENT + "final payload");
});

test("broker shutdown cancels pending approval and late completion has no effects", {timeout: 8_000}, async (t) => {
    const decision = deferred<boolean>();
    const requested = deferred<AbortSignal>();
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        authorizeProtocol: (_event, signal) => { requested.resolve(signal); return decision.promise; },
    });
    const client = await fixture.connect(SSH_CLIENT);
    const signal = await requested.promise;
    await fixture.gateway.close();
    assert.equal(signal.aborted, true);
    decision.resolve(true);
    await client.closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.connections, 0);
});

test("an ambiguous FTP-style 220 greeting does not become an SMTP permission", {timeout: 8_000}, async (t) => {
    let reviews = 0;
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        authorizeProtocol: () => { reviews++; return true; },
    }, "220 FTP service ready\r\n");
    const client = await fixture.connect();
    await client.closed;
    assert.equal(reviews, 0);
    assert.equal(client.text, "");
    assert.equal(fixture.received, "");
});

test("plaintext protocol checks remain active when HTTP/TLS inspection is off", {timeout: 8_000}, async (t) => {
    let reviews = 0;
    const fixture = await GatewayFixture.create(t, {
        authorizeProtocol: (event) => { reviews++; assert.equal(event.protocol, NetworkApplicationProtocol.SSH); return false; },
    });
    const client = await fixture.connect(SSH_CLIENT);
    await client.closed;
    assert.equal(reviews, 1);
    assert.equal(fixture.connections, 0);
});

test("implicit TLS SMTP uses a verified pinned upstream before approving and releasing its greeting", {timeout: 12_000}, async (t) => {
    const decision = deferred<boolean>();
    const requested = deferred<NetworkProtocolEvent>();
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        certificateAuthority: interceptionCa(),
        additionalUpstreamCa: upstreamCa().certificatePem,
        authorizeProtocol: (event) => { requested.resolve(event); return decision.promise; },
    }, SMTP_SERVER, "service.test");
    const client = await fixture.connectSecure();
    const event = await requested.promise;
    assert.equal(event.protocol, NetworkApplicationProtocol.SMTP);
    assert.equal(client.text, "");
    assert.equal(fixture.received, "");
    decision.resolve(true);
    await client.waitFor(SMTP_SERVER);
    client.socket.write("EHLO client.test\r\n");
    await client.waitFor(SMTP_SERVER + "EHLO client.test\r\n");
    assert.equal(fixture.received, "EHLO client.test\r\n");
});

for (const trusted of [true, false]) {
    test(`implicit TLS rejects ${trusted ? "wrong upstream identity" : "an untrusted upstream CA"} without protocol authorization`, {timeout: 12_000}, async (t) => {
        let reviews = 0;
        const fixture = await GatewayFixture.create(t, {
            authorizeHttpRequest: () => true,
            certificateAuthority: interceptionCa(),
            additionalUpstreamCa: trusted ? upstreamCa().certificatePem : undefined,
            authorizeProtocol: () => { reviews++; return true; },
        }, SMTP_SERVER, trusted ? "other.test" : "service.test");
        const client = await fixture.connectSecure();
        await client.closed;
        assert.equal(reviews, 0);
        assert.equal(client.text, "");
        assert.equal(fixture.received, "");
        assert.ok(fixture.errors.length > 0);
    });
}

test("TLS negotiated HTTP1 cannot switch to an SMTP channel", {timeout: 12_000}, async (t) => {
    let reviews = 0;
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        certificateAuthority: interceptionCa(),
        additionalUpstreamCa: upstreamCa().certificatePem,
        authorizeProtocol: () => { reviews++; return true; },
    }, SMTP_SERVER, "service.test");
    const client = await fixture.connectSecure(["http/1.1"]);
    client.socket.write("EHLO client.test\r\n");
    await client.closed;
    assert.equal(reviews, 0);
    assert.equal(fixture.connections, 0);
});

for (const inspection of [true, false]) {
    for (const application of [NetworkApplicationProtocol.SSH, NetworkApplicationProtocol.SMTP]) {
        test(`delayed ${application} identification still requires its policy (inspection ${inspection})`, {timeout: 8_000}, async (t) => {
            const requested = deferred<void>();
            const decision = deferred<boolean>();
            const greeting = application === NetworkApplicationProtocol.SSH ? SSH_SERVER : SMTP_SERVER;
            const fixture = await GatewayFixture.create(t, {
                authorizeHttpRequest: inspection ? () => true : undefined,
                authorizeProtocol: (event) => {
                    assert.equal(event.protocol, application);
                    requested.resolve();
                    return decision.promise;
                },
            }, greeting, undefined, {greetingDelayMilliseconds: 500});
            const client = await fixture.connect();
            await fixture.connected;
            client.socket.write(application === NetworkApplicationProtocol.SSH ? SSH_CLIENT : "EHLO client.test\r\n");
            await requested.promise;
            assert.equal(fixture.received, "");
            decision.resolve(false);
            await client.closed;
            await fixture.waitForUpstreamClose();
            assert.equal(fixture.received, "");
        });
    }
}

test("a delayed HTTP request reaches HTTP policy after the speculative server probe", {timeout: 8_000}, async (t) => {
    let methods = 0;
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: (event) => { methods++; assert.equal(event.method, "GET"); return false; },
        authorizeProtocol: () => assert.fail("HTTP is not an SSH/SMTP grant"),
    });
    const client = await fixture.connect();
    await fixture.connected;
    client.socket.write("GET / HTTP/1.1\r\nHost: service.test:2222\r\nConnection: close\r\n\r\n");
    await client.closed;
    assert.match(client.text, /403/);
    assert.equal(methods, 1);
    assert.equal(fixture.received, "");
});

test("simultaneous client identification and server greeting are each replayed once", {timeout: 8_000}, async (t) => {
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        authorizeProtocol: (event) => event.protocol === NetworkApplicationProtocol.SSH,
    }, SSH_SERVER);
    const client = await fixture.connect();
    await fixture.connected;
    client.socket.write(SSH_CLIENT);
    await client.waitFor(SSH_SERVER + SSH_CLIENT);
    assert.equal(client.text, SSH_SERVER + SSH_CLIENT);
    assert.equal(fixture.received, SSH_CLIENT);
});

for (const cancelledPeer of ["client", "upstream"]) {
    test(`server-first ${cancelledPeer} reset promptly releases a deferred review and the other peer`, {timeout: 8_000}, async (t) => {
        const decision = deferred<boolean>();
        const requested = deferred<AbortSignal>();
        const fixture = await GatewayFixture.create(t, {
            authorizeHttpRequest: () => true,
            authorizeProtocol: (_event, signal) => { requested.resolve(signal); return decision.promise; },
        }, SSH_SERVER);
        const client = await fixture.connect();
        const signal = await requested.promise;
        if (cancelledPeer === "client") client.socket.resetAndDestroy();
        else fixture.resetUpstream();
        if (!signal.aborted) await once(signal, "abort");
        await client.closed;
        await fixture.waitForUpstreamClose();
        assert.equal(client.text, "");
        assert.equal(fixture.received, "");
        decision.resolve(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fixture.connections, 1, "late allow must not open a replacement connection");
    });
}

test("normal upstream close drains a large response to a slow half-closed client", {timeout: 12_000}, async (t) => {
    const response = Buffer.from("large-response-".repeat(300_000));
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true, authorizeProtocol: () => true,
    }, SSH_SERVER, undefined, {response});
    const client = await fixture.connect(SSH_CLIENT);
    await client.waitFor(SSH_SERVER + SSH_CLIENT);
    client.socket.on("data", () => { client.socket.pause(); setTimeout(() => client.socket.resume(), 1); });
    client.socket.end();
    await client.closed;
    assert.equal(createHash("sha256").update(client.text).digest("hex"),
        createHash("sha256").update(SSH_SERVER).update(SSH_CLIENT).update(response).digest("hex"));
});

test("literal-IP implicit TLS retains the accepted SNI without changing the protocol policy target", {timeout: 12_000}, async (t) => {
    let servername: string | false | null | undefined;
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        certificateAuthority: interceptionCa(),
        additionalUpstreamCa: upstreamCa().certificatePem,
        authorizeProtocol: (event) => {
            assert.equal(event.protocol, NetworkApplicationProtocol.SMTP);
            assert.equal(event.uri, "198.18.0.1:2222");
            return true;
        },
    }, SMTP_SERVER, "service.test", {hostname: null});
    fixture.upstream.on("secureConnection", (socket: TLSSocket) => { servername = socket.servername; });
    const client = await fixture.connectSecure();
    await client.waitFor(SMTP_SERVER);
    assert.equal(servername, "service.test");
});

test("a delayed TLS ClientHello is handed back to TLS inspection, not raw forwarding", {timeout: 12_000}, async (t) => {
    let reviews = 0;
    const fixture = await GatewayFixture.create(t, {
        authorizeHttpRequest: () => true,
        certificateAuthority: interceptionCa(),
        additionalUpstreamCa: upstreamCa().certificatePem,
        authorizeProtocol: (event) => { reviews++; return event.protocol === NetworkApplicationProtocol.SMTP; },
    }, SMTP_SERVER, "service.test");
    const client = await fixture.connectSecure(undefined, true);
    await client.waitFor(SMTP_SERVER);
    assert.equal(reviews, 1);
});

class LiveClient {
    private readonly chunks: Buffer[] = [];
    readonly closed: Promise<void>;

    constructor(readonly socket: Socket) {
        socket.on("data", (data: Buffer) => this.chunks.push(data));
        socket.on("error", () => {});
        this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
    }

    get text(): string { return Buffer.concat(this.chunks).toString(); }

    async waitFor(expected: string): Promise<void> {
        if (this.text.includes(expected)) return;
        await new Promise<void>((resolve, reject) => {
            const onData = () => { if (this.text.includes(expected)) finish(); };
            const onClose = () => finish(new Error(`client closed before ${JSON.stringify(expected)}: ${JSON.stringify(this.text)}`));
            const finish = (error?: Error) => {
                this.socket.off("data", onData);
                this.socket.off("close", onClose);
                error ? reject(error) : resolve();
            };
            this.socket.on("data", onData);
            this.socket.once("close", onClose);
        });
    }
}

type GatewaySettings = {hostname?: string | null; response?: Buffer; greetingDelayMilliseconds?: number};

class GatewayFixture {
    readonly gateway: TcpGatewayBroker;
    readonly errors: unknown[] = [];
    readonly upstream: Server;
    private readonly opened = deferred<void>();
    readonly connected = this.opened.promise;
    private readonly flowHostname: string | undefined;
    private readonly upstreamSockets = new Set<Socket>();
    private readonly clients = new Set<Socket>();
    private readonly chunks: Buffer[] = [];
    private upstreamPort = 0;
    private sourcePort = 40_000;
    connections = 0;

    private constructor(options: TcpGatewayBrokerOptions, greeting: string | undefined, tlsIdentity: string | undefined,
        settings: GatewaySettings) {
        this.flowHostname = settings.hostname === null ? undefined : settings.hostname ?? "service.test";
        this.gateway = new TcpGatewayBroker({...options, onError: (error) => this.errors.push(error)});
        const accept = (socket: Socket) => {
            this.connections++;
            socket.on("data", (data: Buffer) => { this.chunks.push(data); socket.write(data); });
            socket.on("end", () => settings.response ? socket.end(settings.response) : socket.end());
            socket.on("error", () => {});
            if (greeting) {
                if (settings.greetingDelayMilliseconds) {
                    setTimeout(() => { if (!socket.destroyed) socket.write(greeting); }, settings.greetingDelayMilliseconds);
                } else socket.write(greeting);
            }
        };
        this.upstream = tlsIdentity
            ? createTlsServer({...upstreamCa().serverCredentials(tlsIdentity), allowHalfOpen: true}, accept)
            : createServer({allowHalfOpen: true}, accept);
        this.upstream.on("tlsClientError", () => {});
        this.upstream.on("connection", (socket: Socket) => {
            this.opened.resolve();
            this.upstreamSockets.add(socket);
            socket.on("error", () => {});
            socket.once("close", () => this.upstreamSockets.delete(socket));
        });
    }

    static async create(t: TestContext, options: TcpGatewayBrokerOptions, greeting?: string, tlsIdentity?: string,
        settings: GatewaySettings = {}): Promise<GatewayFixture> {
        const fixture = new GatewayFixture(options, greeting, tlsIdentity, settings);
        t.after(async () => {
            for (const socket of fixture.clients) socket.destroy();
            for (const socket of fixture.upstreamSockets) socket.destroy();
            await fixture.gateway.close();
            await new Promise<void>((resolve) => fixture.upstream.close(() => resolve()));
        });
        fixture.upstream.listen(0, "127.0.0.1");
        await once(fixture.upstream, "listening");
        const address = fixture.upstream.address();
        assert.ok(address && typeof address !== "string");
        fixture.upstreamPort = address.port;
        await fixture.gateway.start();
        return fixture;
    }

    get received(): string { return Buffer.concat(this.chunks).toString(); }

    async connect(payload = ""): Promise<LiveClient> {
        const socket = await this.transport();
        const client = new LiveClient(socket);
        if (payload) socket.write(payload);
        return client;
    }

    async connectSecure(alpn?: string[], delayed = false): Promise<LiveClient> {
        const transport = await this.transport();
        if (delayed) await this.connected;
        const socket: TLSSocket = connectTls({
            socket: transport,
            servername: "service.test",
            ca: interceptionCa().certificatePem,
            ALPNProtocols: alpn,
        });
        this.clients.add(socket);
        const client = new LiveClient(socket);
        await once(socket, "secureConnect");
        return client;
    }

    resetUpstream(): void {
        for (const socket of this.upstreamSockets) socket.resetAndDestroy();
    }

    async waitForUpstreamClose(): Promise<void> {
        await Promise.all([...this.upstreamSockets].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))));
    }

    private async transport(): Promise<Socket> {
        const socket = createConnection({host: "127.0.0.1", port: this.gateway.port});
        this.clients.add(socket);
        socket.on("error", () => {});
        await once(socket, "connect");
        const sourcePort = ++this.sourcePort;
        this.gateway.approve({
            family: NetworkAddressFamily.IPV4,
            source: {address: "10.200.0.2", port: sourcePort},
            destination: {address: "198.18.0.1", port: 2222},
            upstream: {address: "127.0.0.1", port: this.upstreamPort},
            hostname: this.flowHostname,
        });
        socket.write(`PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t${sourcePort}\t198.18.0.1\t2222\n`);
        return socket;
    }
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    return {promise: new Promise<T>((done) => { resolve = done; }), resolve};
}
