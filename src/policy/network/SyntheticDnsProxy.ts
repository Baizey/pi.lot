import {randomInt} from "node:crypto";
import {createSocket, type RemoteInfo, type Socket} from "node:dgram";
import {isIP} from "node:net";
import {performance} from "node:perf_hooks";
import {NetworkAddressFamily} from "./network-queue-protocol.js";

const DNS_PORT = 53;
const DNS_HEADER_LENGTH = 12;
const DNS_CLASS_IN = 1;
const DNS_TYPE_A = 1;
const DNS_TYPE_CNAME = 5;
const DNS_TYPE_AAAA = 28;
const MAX_DNS_MESSAGE_LENGTH = 65_535;
const MAX_DNS_LEASES = 4_096;
const MAX_DNS_TTL_SECONDS = 60;
const MAX_DNS_ANSWERS = 64;
const MAX_PENDING_REFRESHES = 64;
const MAX_PENDING_QUERIES = 128;
const MAX_TRACKED_QUERIES = MAX_PENDING_QUERIES + MAX_PENDING_REFRESHES;
const DNS_REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export type SyntheticDnsLease = Readonly<{
    hostname: string;
    family: NetworkAddressFamily;
    syntheticAddress: string;
    realAddress: string;
    expiresAt: number;
    ttlSeconds: number;
}>;

export type SyntheticDnsIdentity = Readonly<{
    hostname: string;
    family: NetworkAddressFamily;
    syntheticAddress: string;
    originalAddress: string;
}>;

export type SyntheticDnsAnswer = Readonly<{realAddress: string; ttlSeconds: number}>;
export type SyntheticDnsResolution = Readonly<{
    receivedAt: number;
    answers: readonly SyntheticDnsAnswer[];
    withdrawal?: "NODATA" | "NXDOMAIN";
}>;

export type SyntheticDnsLeaseTableOptions = {
    refresh: (
        hostname: string,
        family: NetworkAddressFamily,
        signal: AbortSignal,
    ) => Promise<SyntheticDnsResolution>;
    now?: () => number;
};

export type SyntheticDnsQuery = Readonly<{
    release: () => void;
    isCurrent: (family: NetworkAddressFamily) => boolean;
}>;

type FreshAnswer = Readonly<{realAddress: string; expiresAt: number; ttlSeconds: number}>;

type DnsQuestion = {
    id: number;
    name: string;
    type: number;
    questionEnd: number;
};

type DnsResourceRecord = {
    owner: string;
    type: number;
    class: number;
    ttl: number;
    ttlOffset: number;
    dataOffset: number;
    dataLength: number;
    cname?: string;
};

type ParsedDnsResponse = {
    question: DnsQuestion;
    answers: DnsResourceRecord[];
};

export type SyntheticDnsProxyOptions = {
    upstreamAddress: string;
    upstreamPort?: number;
    leases: SyntheticDnsLeaseTable;
    globalIpv6Available?: boolean;
    now?: () => number;
    onError?: (error: unknown) => void;
    onFatalError?: (error: unknown) => void;
};

export class SyntheticDnsLeaseTable {
    private readonly options: SyntheticDnsLeaseTableOptions;
    private readonly identities = new Map<string, SyntheticDnsIdentity>();
    private readonly identitiesByAnswer = new Map<string, SyntheticDnsIdentity>();
    // Positive sets and withdrawal watermarks share one ordering domain: at most
    // MAX_DNS_LEASES retained family keys + 2 * MAX_TRACKED_QUERIES temporary keys.
    private readonly answers = new Map<string, {receivedAt: number; values: readonly FreshAnswer[]}>();
    private readonly pendingRefreshes = new Map<string, Promise<void>>();
    private readonly bindingAnswers = new WeakMap<SyntheticDnsLease, FreshAnswer>();
    private readonly retainedFamilies = new Set<string>();
    private readonly trackedQueries = new Map<string, number>();
    private trackedQueryCount = 0;
    private readonly abortController = new AbortController();
    private closed = false;
    private nextIpv4Lease = 1;
    private nextIpv6Lease = 1;

    constructor(options: SyntheticDnsLeaseTableOptions) {
        this.options = options;
    }

    async lease(
        hostname: string,
        family: NetworkAddressFamily,
        realAddress: string,
        ttlSeconds: number,
    ): Promise<SyntheticDnsLease> {
        return this.recordAnswers(hostname, family, {
            receivedAt: this.now(),
            answers: [{realAddress, ttlSeconds}],
        })[0]!;
    }

    recordAnswers(
        hostname: string,
        family: NetworkAddressFamily,
        resolution: SyntheticDnsResolution,
    ): readonly SyntheticDnsLease[] {
        this.assertOpen();
        const values = this.validateResolution(hostname, family, resolution);
        if (resolution.withdrawal) {
            this.withdraw(hostname, resolution.withdrawal === "NXDOMAIN" ? null : family, resolution.receivedAt);
            return [];
        }
        const missing = new Set(values.map((answer) => `${hostname}\0${family}\0${answer.realAddress}`)
            .filter((key) => !this.identitiesByAnswer.has(key)));
        if (this.identities.size + missing.size > MAX_DNS_LEASES) {
            throw new Error("synthetic DNS lease limit exceeded");
        }
        const leases = values.map((answer) => {
            const key = `${hostname}\0${family}\0${answer.realAddress}`;
            let identity = this.identitiesByAnswer.get(key);
            if (!identity) {
                identity = Object.freeze({
                    hostname, family, originalAddress: answer.realAddress,
                    syntheticAddress: family === NetworkAddressFamily.IPV4
                        ? this.allocateIpv4Address() : this.allocateIpv6Address(),
                });
                this.identitiesByAnswer.set(key, identity);
                this.identities.set(identity.syntheticAddress, identity);
                this.retainedFamilies.add(`${hostname}\0${family}`);
            }
            return this.binding(identity, answer);
        });
        this.publishAnswers(hostname, family, resolution.receivedAt, values);
        return leases;
    }

    /** Keep withdrawal ordering for not-yet-issued names only while a bounded query is in flight. */
    trackQuery(hostname: string): SyntheticDnsQuery {
        this.assertOpen();
        validateDnsHostname(hostname);
        if (this.trackedQueryCount >= MAX_TRACKED_QUERIES) throw new Error("synthetic DNS tracked query limit exceeded");
        this.trackedQueryCount++;
        this.trackedQueries.set(hostname, (this.trackedQueries.get(hostname) ?? 0) + 1);
        // Receipt timestamps order completed publications; this snapshot also
        // prevents an older pending positive from undoing an intervening withdrawal
        // merely because that old request's response arrives later.
        const previous = new Map([NetworkAddressFamily.IPV4, NetworkAddressFamily.IPV6]
            .map((family) => [family, this.answers.get(`${hostname}\0${family}`)]));
        let released = false;
        const release = () => {
            if (released || this.closed) return;
            released = true;
            this.trackedQueryCount--;
            const remaining = this.trackedQueries.get(hostname)! - 1;
            if (remaining > 0) this.trackedQueries.set(hostname, remaining);
            else {
                this.trackedQueries.delete(hostname);
                for (const family of [NetworkAddressFamily.IPV4, NetworkAddressFamily.IPV6]) {
                    const key = `${hostname}\0${family}`;
                    if (!this.retainedFamilies.has(key)) this.answers.delete(key);
                }
            }
        };
        return Object.freeze({release, isCurrent: (family: NetworkAddressFamily) =>
            !this.closed && !released && this.answers.get(`${hostname}\0${family}`) === previous.get(family)});
    }

    /** Null family is an authoritative name-wide NXDOMAIN withdrawal. */
    withdraw(hostname: string, family: NetworkAddressFamily | null, receivedAt: number): void {
        this.assertOpen();
        validateDnsHostname(hostname);
        this.validateReceptionTime(receivedAt);
        if (family !== null && family !== NetworkAddressFamily.IPV4 && family !== NetworkAddressFamily.IPV6) {
            throw new Error("DNS withdrawal used an invalid address family");
        }
        const families = family === null ? [NetworkAddressFamily.IPV4, NetworkAddressFamily.IPV6] : [family];
        for (const candidate of families) {
            const key = `${hostname}\0${candidate}`;
            // Permanent watermarks are charged to issued identity families. Other
            // names are retained only by tracked in-flight queries, never by an
            // unbounded stream of negative answers for never-issued hostnames.
            if (this.retainedFamilies.has(key) || this.trackedQueries.has(hostname)) {
                this.publishAnswers(hostname, candidate, receivedAt, []);
            }
        }
    }

    async resolve(
        syntheticAddress: string,
        signal: AbortSignal,
        authorizeRefresh: () => Promise<void>,
    ): Promise<SyntheticDnsLease> {
        this.assertOpen(signal);
        const identity = this.lookup(syntheticAddress);
        if (!identity) throw new Error(`expired or unknown synthetic DNS lease: ${syntheticAddress}`);
        const current = this.freshBinding(identity);
        if (current) return current;

        // Authorization belongs to the caller's policy context, not to the address token.
        await authorizeRefresh();
        this.assertOpen(signal);
        const key = `${identity.hostname}\0${identity.family}`;
        if (!this.freshBinding(identity)) {
            let pending = this.pendingRefreshes.get(key);
            if (!pending) {
                if (this.pendingRefreshes.size >= MAX_PENDING_REFRESHES) {
                    throw new Error("synthetic DNS pending refresh limit exceeded");
                }
                pending = this.refresh(identity);
                this.pendingRefreshes.set(key, pending);
                void pending.finally(() => {
                    if (this.pendingRefreshes.get(key) === pending) this.pendingRefreshes.delete(key);
                }).catch(() => {});
            }
            await this.waitForRefresh(pending, signal);
        }
        this.assertOpen(signal);
        const refreshed = this.freshBinding(identity);
        if (!refreshed) throw new Error(`upstream DNS returned no fresh ${identity.family} binding for ${identity.hostname}`);
        return refreshed;
    }

    assertFresh(lease: SyntheticDnsLease, signal: AbortSignal): void {
        this.assertOpen(signal);
        const identity = this.lookup(lease.syntheticAddress);
        const answer = this.bindingAnswers.get(lease);
        const current = this.answers.get(`${lease.hostname}\0${lease.family}`);
        // An approval is a snapshot, not authority to outlive a newer RRset.
        // Conservatively reject superseded snapshots, even if the new set happens
        // to contain the same address. Already admitted connections are unaffected.
        if (!identity || identity.hostname !== lease.hostname || identity.family !== lease.family
            || !answer || !current?.values.includes(answer) || lease.expiresAt <= this.now()) {
            throw new Error("upstream DNS binding expired or superseded before flow admission");
        }
    }

    remainingTtlSeconds(lease: SyntheticDnsLease): number {
        return Math.max(0, Math.floor((lease.expiresAt - this.now()) / 1_000));
    }

    lookup(syntheticAddress: string): SyntheticDnsIdentity | null {
        const canonical = isIP(syntheticAddress) === 6
            ? formatIpv6(parseIpAddress(syntheticAddress, NetworkAddressFamily.IPV6)) : syntheticAddress;
        return this.identities.get(canonical) ?? null;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.abortController.abort();
        this.identities.clear();
        this.identitiesByAnswer.clear();
        this.answers.clear();
        this.retainedFamilies.clear();
        this.trackedQueries.clear();
        this.trackedQueryCount = 0;
        await Promise.allSettled(this.pendingRefreshes.values());
        this.pendingRefreshes.clear();
    }

    isSyntheticAddress(address: string): boolean {
        if (isIP(address) === 4) {
            const octets = address.split(".").map(Number);
            return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
        }
        if (isIP(address) !== 6) return false;
        try {
            const bytes = parseIpAddress(address, NetworkAddressFamily.IPV6);
            return bytes[0] === 0x20
                && bytes[1] === 0x01
                && bytes[2] === 0x00
                && bytes[3] === 0x02
                && bytes[4] === 0x00
                && bytes[5] === 0x00;
        } catch {
            return false;
        }
    }

    private async refresh(identity: SyntheticDnsIdentity): Promise<void> {
        const signal = this.abortController.signal;
        const key = `${identity.hostname}\0${identity.family}`;
        const previous = this.answers.get(key);
        const resolution = await this.options.refresh(identity.hostname, identity.family, signal);
        this.assertOpen(signal);
        const values = this.validateResolution(identity.hostname, identity.family, resolution);
        if (resolution.withdrawal) {
            // A name-wide withdrawal must reach the other family even if this
            // query's own family changed while it was pending. Receipt ordering
            // still prevents an older negative from withdrawing a newer answer.
            this.withdraw(identity.hostname, resolution.withdrawal === "NXDOMAIN" ? null : identity.family, resolution.receivedAt);
        } else if (this.answers.get(key) === previous) {
            // An intervening trusted publication supersedes an old positive refresh.
            this.publishAnswers(identity.hostname, identity.family, resolution.receivedAt, values);
        }
    }

    private async waitForRefresh(pending: Promise<void>, signal: AbortSignal): Promise<void> {
        if (signal.aborted) throw new Error("synthetic DNS leases closed or aborted");
        await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("synthetic DNS leases closed or aborted"));
            signal.addEventListener("abort", abort, {once: true});
            void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        });
    }

    private validateResolution(
        hostname: string,
        family: NetworkAddressFamily,
        resolution: SyntheticDnsResolution,
    ): readonly FreshAnswer[] {
        validateDnsHostname(hostname);
        if (family !== NetworkAddressFamily.IPV4 && family !== NetworkAddressFamily.IPV6) {
            throw new Error("DNS answer used an invalid address family");
        }
        this.validateReceptionTime(resolution.receivedAt);
        if (resolution.withdrawal !== undefined) {
            if ((resolution.withdrawal !== "NXDOMAIN" && resolution.withdrawal !== "NODATA") || resolution.answers.length !== 0) {
                throw new Error("DNS withdrawal resolution is invalid");
            }
            return [];
        }
        if (resolution.answers.length === 0 || resolution.answers.length > MAX_DNS_ANSWERS) {
            throw new Error("DNS answer count is empty or exceeds the limit");
        }
        const values = resolution.answers.map(({realAddress, ttlSeconds}) => {
            this.validateAnswer(family, realAddress);
            if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 0xffff_ffff) {
                throw new Error("DNS answer used an invalid TTL");
            }
            const boundedTtl = Math.min(MAX_DNS_TTL_SECONDS, Math.floor(ttlSeconds));
            return {realAddress, ttlSeconds: boundedTtl};
        });
        const rrsetTtl = Math.min(...values.map((answer) => answer.ttlSeconds));
        return values.map(({realAddress}) => Object.freeze({realAddress, ttlSeconds: rrsetTtl,
            expiresAt: resolution.receivedAt + rrsetTtl * 1_000}));
    }

    private validateReceptionTime(receivedAt: number): void {
        if (!Number.isFinite(receivedAt) || receivedAt > this.now()) throw new Error("DNS answer used an invalid reception time");
    }

    private publishAnswers(
        hostname: string,
        family: NetworkAddressFamily,
        receivedAt: number,
        values: readonly FreshAnswer[],
    ): void {
        const key = `${hostname}\0${family}`;
        const previous = this.answers.get(key);
        if (!previous || previous.receivedAt <= receivedAt) this.answers.set(key, {receivedAt, values});
    }

    private freshBinding(identity: SyntheticDnsIdentity): SyntheticDnsLease | null {
        const values = this.answers.get(`${identity.hostname}\0${identity.family}`)?.values
            .filter((answer) => answer.expiresAt > this.now());
        const answer = values?.find((value) => value.realAddress === identity.originalAddress) ?? values?.[0];
        return answer ? this.binding(identity, answer) : null;
    }

    private binding(identity: SyntheticDnsIdentity, answer: FreshAnswer): SyntheticDnsLease {
        const binding = Object.freeze({hostname: identity.hostname, family: identity.family,
            syntheticAddress: identity.syntheticAddress, ...answer});
        this.bindingAnswers.set(binding, answer);
        return binding;
    }

    private assertOpen(signal?: AbortSignal): void {
        if (this.closed || signal?.aborted) throw new Error("synthetic DNS leases closed or aborted");
    }

    private allocateIpv4Address(): string {
        if (this.nextIpv4Lease >= 131_072) throw new Error("synthetic IPv4 lease range exhausted");
        const value = this.nextIpv4Lease++;
        return `198.${18 + Math.floor(value / 65_536)}.${Math.floor(value / 256) % 256}.${value % 256}`;
    }

    private allocateIpv6Address(): string {
        if (this.nextIpv6Lease > 0xffff_ffff) throw new Error("synthetic IPv6 lease range exhausted");
        return `2001:2::${(this.nextIpv6Lease++).toString(16)}`;
    }

    private validateAnswer(family: NetworkAddressFamily, address: string): void {
        const expected = family === NetworkAddressFamily.IPV4 ? 4 : 6;
        if (isIP(address) !== expected) throw new Error("DNS answer used an invalid address family");
        if (this.isSyntheticAddress(address)) throw new Error("DNS answer overlaps the synthetic lease range");
    }

    private now(): number {
        return this.options.now?.() ?? performance.now();
    }
}

export class SyntheticDnsProxy {
    private readonly options: SyntheticDnsProxyOptions;
    private readonly abortController = new AbortController();
    private readonly pendingQueries = new Set<Promise<void>>();
    private ipv4Socket: Socket | undefined;
    private ipv6Socket: Socket | undefined;
    private listeningPort: number | undefined;
    private started = false;
    private stopping = false;

    constructor(options: SyntheticDnsProxyOptions) {
        this.options = options;
        if (isIP(options.upstreamAddress) === 0) throw new Error("DNS proxy requires an IP upstream resolver");
        if (
            options.upstreamPort !== undefined
            && (!Number.isSafeInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65_535)
        ) {
            throw new Error("DNS proxy requires a valid upstream resolver port");
        }
    }

    get port(): number {
        if (!this.listeningPort) throw new Error("synthetic DNS proxy is not listening");
        return this.listeningPort;
    }

    async start(): Promise<void> {
        if (this.started || this.stopping) throw new Error("synthetic DNS proxy already started");
        this.started = true;
        this.ipv4Socket = createSocket("udp4");
        await bindSocket(this.ipv4Socket, 0, "127.0.0.1");
        const address = this.ipv4Socket.address();
        if (typeof address === "string") throw new Error("synthetic DNS proxy returned an invalid address");
        this.listeningPort = address.port;

        this.ipv6Socket = createSocket({type: "udp6", ipv6Only: true});
        try {
            await bindSocket(this.ipv6Socket, this.listeningPort, "::1");
        } catch (error) {
            this.ipv4Socket.close();
            this.ipv4Socket = undefined;
            this.ipv6Socket = undefined;
            this.listeningPort = undefined;
            throw error;
        }
        const ipv4Socket = this.ipv4Socket;
        const ipv6Socket = this.ipv6Socket;
        ipv4Socket.on("message", (message, remote) => this.handleQuery(ipv4Socket, message, remote));
        ipv6Socket.on("message", (message, remote) => this.handleQuery(ipv6Socket, message, remote));
        ipv4Socket.on("error", (error) => this.reportFatalError(error));
        ipv6Socket.on("error", (error) => this.reportFatalError(error));
    }

    async resolve(
        hostname: string,
        family: NetworkAddressFamily,
        signal: AbortSignal,
    ): Promise<SyntheticDnsResolution> {
        validateDnsHostname(hostname);
        if (family !== NetworkAddressFamily.IPV4 && family !== NetworkAddressFamily.IPV6) {
            throw new Error("DNS refresh used an invalid address family");
        }
        const labels = hostname.split(".").map((label) => Buffer.concat([
            Buffer.from([label.length]), Buffer.from(label, "ascii"),
        ]));
        const header = Buffer.alloc(DNS_HEADER_LENGTH);
        header.writeUInt16BE(randomInt(65_536), 0);
        header.writeUInt16BE(0x0100, 2);
        header.writeUInt16BE(1, 4);
        const question = Buffer.from([0, 0, family === NetworkAddressFamily.IPV4 ? DNS_TYPE_A : DNS_TYPE_AAAA, 0, DNS_CLASS_IN]);
        const query = Buffer.concat([header, ...labels, question]);
        const ownership = this.options.leases.trackQuery(hostname);
        try {
            const {response, receivedAt} = await this.queryUpstream(query, signal);
            return resolveDnsResponse(response, hostname, family, this.options.leases, receivedAt, ownership);
        } finally {
            ownership.release();
        }
    }

    async close(): Promise<void> {
        this.stopping = true;
        this.abortController.abort();
        const sockets = [this.ipv4Socket, this.ipv6Socket];
        this.ipv4Socket = undefined;
        this.ipv6Socket = undefined;
        this.listeningPort = undefined;
        await Promise.allSettled([
            ...sockets.map((socket) => closeSocket(socket)),
            ...this.pendingQueries,
        ]);
    }

    private handleQuery(server: Socket, query: Buffer, remote: RemoteInfo): void {
        if (this.stopping) return;
        if (this.pendingQueries.size >= MAX_PENDING_QUERIES) {
            // Dropping overload is bounded and cannot create an upstream effect.
            this.reportError(new Error("synthetic DNS pending query limit exceeded"));
            return;
        }
        const pending = this.processQuery(server, query, remote);
        this.pendingQueries.add(pending);
        void pending.finally(() => this.pendingQueries.delete(pending));
    }

    private async processQuery(server: Socket, query: Buffer, remote: RemoteInfo): Promise<void> {
        try {
            const response = await this.answerQuery(query);
            await sendDatagram(server, response, remote.port, remote.address);
        } catch (error) {
            this.reportError(error);
            const failure = createDnsFailureResponse(query);
            if (!failure || this.stopping) return;
            try {
                await sendDatagram(server, failure, remote.port, remote.address);
            } catch (sendError) {
                this.reportError(sendError);
            }
        }
    }

    private async answerQuery(query: Buffer): Promise<Buffer> {
        if (query.length > MAX_DNS_MESSAGE_LENGTH) throw new Error("DNS query exceeds the message limit");
        const question = parseDnsQuestion(query, false);
        const ownership = this.options.leases.trackQuery(question.name);
        try {
            const {response, receivedAt} = await this.queryUpstream(query, this.abortController.signal);
            return rewriteDnsResponse(response, question.name, this.options.leases, receivedAt,
                ownership, this.options.globalIpv6Available);
        } finally {
            ownership.release();
        }
    }

    private async queryUpstream(query: Buffer, signal: AbortSignal): Promise<{
        response: Buffer; parsed: ParsedDnsResponse; receivedAt: number;
    }> {
        if (this.stopping) throw new Error("synthetic DNS proxy closed");
        const question = parseDnsQuestion(query, false);
        const {response, receivedAt} = await forwardDnsQuery(query, this.options.upstreamAddress,
            this.options.upstreamPort ?? DNS_PORT,
            AbortSignal.any([signal, this.abortController.signal]),
            () => this.options.now?.() ?? performance.now());
        const parsed = parseDnsResponse(response);
        if (parsed.question.id !== question.id || parsed.question.name !== question.name
            || parsed.question.type !== question.type) {
            throw new Error("upstream DNS response did not match its query");
        }
        return {response, parsed, receivedAt};
    }

    private reportError(error: unknown): void {
        if (this.stopping) return;
        try {
            this.options.onError?.(error);
        } catch {
            // Error reporting must not affect DNS proxy failure behavior.
        }
    }

    private reportFatalError(error: unknown): void {
        if (this.stopping) return;
        try {
            this.options.onFatalError?.(error);
        } catch {
            // A failed fatal-error callback cannot make the proxy usable again.
        }
    }
}

/** Decode the trusted refresh response, publishing withdrawals before query ownership ends. */
export function resolveDnsResponse(
    response: Buffer,
    requestedName: string,
    family: NetworkAddressFamily,
    leases: SyntheticDnsLeaseTable,
    receivedAt: number,
    ownership?: SyntheticDnsQuery,
): SyntheticDnsResolution {
    const parsed = parseDnsResponse(response);
    const expectedType = family === NetworkAddressFamily.IPV4 ? DNS_TYPE_A : DNS_TYPE_AAAA;
    if (parsed.question.name !== requestedName || parsed.question.type !== expectedType) {
        throw new Error("DNS refresh response question mismatch");
    }
    const flags = response.readUInt16BE(2);
    if ((flags & 0x0200) !== 0 || ((flags & 0x000f) !== 0 && (flags & 0x000f) !== 3)) {
        throw new Error("upstream DNS refresh failed or was truncated");
    }
    if ((flags & 0x000f) === 3) {
        leases.withdraw(requestedName, null, receivedAt);
        return {receivedAt, answers: [], withdrawal: "NXDOMAIN"};
    }
    const answers = attributedAddressAnswers(response, parsed, requestedName)
        .filter((answer) => answer.family === family)
        .map(({realAddress, ttlSeconds}) => ({realAddress, ttlSeconds}));
    if (answers.length === 0) {
        leases.withdraw(requestedName, family, receivedAt);
        return {receivedAt, answers: [], withdrawal: "NODATA"};
    }
    if (ownership && !ownership.isCurrent(family)) throw new Error("DNS refresh response was superseded by a newer trusted answer");
    return {receivedAt, answers};
}

export function rewriteDnsResponse(
    original: Buffer,
    requestedName: string,
    leases: SyntheticDnsLeaseTable,
    receivedAt: number,
    ownership?: SyntheticDnsQuery,
    globalIpv6Available = true,
): Buffer {
    const response = Buffer.from(original);
    const parsed = parseDnsResponse(response);
    if (parsed.question.name !== requestedName) throw new Error("DNS response hostname mismatch");
    // SERVFAIL/truncation cannot establish or withdraw a binding. NXDOMAIN
    // authoritatively withdraws both families, including for a non-address query.
    const flags = response.readUInt16BE(2);
    if ((flags & 0x020f) !== 0) {
        if ((flags & 0x020f) === 3) leases.withdraw(requestedName, null, receivedAt);
        if (parsed.answers.some((answer) => answer.type === DNS_TYPE_A || answer.type === DNS_TYPE_AAAA)) {
            throw new Error("upstream DNS response failed or was truncated");
        }
        return response;
    }
    if (parsed.question.type === DNS_TYPE_AAAA && !globalIpv6Available
        && hasOnlyGlobalIpv6Answers(response, parsed, requestedName)) {
        leases.withdraw(requestedName, NetworkAddressFamily.IPV6, receivedAt);
        return createDnsNoDataResponse(response);
    }
    const addresses = attributedAddressAnswers(response, parsed, requestedName);
    for (const family of [NetworkAddressFamily.IPV4, NetworkAddressFamily.IPV6]) {
        const answers = addresses.filter((answer) => answer.family === family);
        if (answers.length === 0) {
            const type = family === NetworkAddressFamily.IPV4 ? DNS_TYPE_A : DNS_TYPE_AAAA;
            if (parsed.question.type === type) leases.withdraw(requestedName, family, receivedAt);
            continue;
        }
        if (ownership && !ownership.isCurrent(family)) throw new Error("DNS response was superseded by a newer trusted answer");
        const rewritten = leases.recordAnswers(requestedName, family, {receivedAt,
            answers: answers.map(({realAddress, ttlSeconds}) => ({realAddress, ttlSeconds}))});
        answers.forEach(({record}, index) => {
            const lease = rewritten[index]!;
            parseIpAddress(lease.syntheticAddress, family).copy(response, record.dataOffset);
            response.writeUInt32BE(leases.remainingTtlSeconds(lease), record.ttlOffset);
        });
    }
    if (addresses.length > 0) response.writeUInt16BE(response.readUInt16BE(2) & ~0x0020, 2);
    return response;
}

function attributedAddressAnswers(response: Buffer, parsed: ParsedDnsResponse, requestedName: string): Array<{
    record: DnsResourceRecord; family: NetworkAddressFamily; realAddress: string; ttlSeconds: number;
}> {
    let owner = requestedName;
    let chainTtl = MAX_DNS_TTL_SECONDS;
    const visited = new Set<string>();
    while (true) {
        if (visited.has(owner) || visited.size >= MAX_DNS_ANSWERS) throw new Error("DNS CNAME chain is cyclic or exceeds the limit");
        visited.add(owner);
        const aliases = parsed.answers.filter((answer) => answer.class === DNS_CLASS_IN
            && answer.owner === owner && answer.type === DNS_TYPE_CNAME);
        if (aliases.length === 0) break;
        if (aliases.some((answer) => answer.cname !== aliases[0]!.cname)
            || parsed.answers.some((answer) => answer.owner === owner && answer.class === DNS_CLASS_IN
                && (answer.type === DNS_TYPE_A || answer.type === DNS_TYPE_AAAA))) {
            throw new Error("DNS CNAME chain is ambiguous");
        }
        chainTtl = Math.min(chainTtl, ...aliases.map((answer) => answer.ttl));
        owner = aliases[0]!.cname!;
    }
    return parsed.answers.flatMap((record) => {
        if (record.owner !== owner || record.class !== DNS_CLASS_IN) return [];
        const family = record.type === DNS_TYPE_A ? NetworkAddressFamily.IPV4
            : record.type === DNS_TYPE_AAAA ? NetworkAddressFamily.IPV6 : null;
        if (!family) return [];
        const bytes = response.subarray(record.dataOffset, record.dataOffset + record.dataLength);
        const realAddress = family === NetworkAddressFamily.IPV4 ? formatIpv4(bytes) : formatIpv6(bytes);
        const rrsetTtl = Math.min(...parsed.answers.filter((answer) => answer.owner === owner
            && answer.class === DNS_CLASS_IN && answer.type === record.type).map((answer) => answer.ttl));
        return [{record, family, realAddress, ttlSeconds: Math.min(chainTtl, rrsetTtl)}];
    });
}

function attributedAnswerNames(parsed: ParsedDnsResponse, requestedName: string): Set<string> {
    const attributedNames = new Set([requestedName]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const answer of parsed.answers) {
            if (
                answer.type === DNS_TYPE_CNAME
                && answer.class === DNS_CLASS_IN
                && answer.cname
                && attributedNames.has(answer.owner)
                && !attributedNames.has(answer.cname)
            ) {
                attributedNames.add(answer.cname);
                changed = true;
            }
        }
    }
    return attributedNames;
}

function hasOnlyGlobalIpv6Answers(
    response: Buffer,
    parsed: ParsedDnsResponse,
    requestedName: string,
): boolean {
    const attributedNames = attributedAnswerNames(parsed, requestedName);
    const addresses = parsed.answers.filter((answer) => (
        answer.class === DNS_CLASS_IN
        && attributedNames.has(answer.owner)
        && (answer.type === DNS_TYPE_A || answer.type === DNS_TYPE_AAAA)
    ));
    return addresses.length > 0 && addresses.every((answer) => (
        answer.type === DNS_TYPE_AAAA
        && answer.dataLength === 16
        && isGlobalIpv6Bytes(response.subarray(answer.dataOffset, answer.dataOffset + answer.dataLength))
    ));
}

function isGlobalIpv6Bytes(bytes: Buffer): boolean {
    return bytes.length === 16 && (bytes[0]! & 0xe0) === 0x20;
}

function validateDnsHostname(hostname: string): void {
    if (!hostname || hostname.length > 253 || hostname !== hostname.toLowerCase()) {
        throw new Error("DNS hostname is invalid");
    }
    const labels = hostname.split(".");
    if (labels.some((label) => (
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)
    ))) {
        throw new Error("DNS hostname is invalid");
    }
}

function parseDnsQuestion(message: Buffer, response: boolean): DnsQuestion {
    if (message.length < DNS_HEADER_LENGTH) throw new Error("DNS message is truncated");
    const flags = message.readUInt16BE(2);
    const isResponse = (flags & 0x8000) !== 0;
    if (isResponse !== response || (flags & 0x7800) !== 0 || message.readUInt16BE(4) !== 1) {
        throw new Error("DNS message has unsupported header fields");
    }
    const decoded = readDnsName(message, DNS_HEADER_LENGTH);
    if (!decoded.name || decoded.nextOffset + 4 > message.length) {
        throw new Error("DNS question is truncated");
    }
    const type = message.readUInt16BE(decoded.nextOffset);
    const dnsClass = message.readUInt16BE(decoded.nextOffset + 2);
    if (type === 0 || dnsClass !== DNS_CLASS_IN) throw new Error("DNS question is unsupported");
    return {
        id: message.readUInt16BE(0),
        name: decoded.name,
        type,
        questionEnd: decoded.nextOffset + 4,
    };
}

function parseDnsResponse(message: Buffer): ParsedDnsResponse {
    const question = parseDnsQuestion(message, true);
    const answerCount = message.readUInt16BE(6);
    const authorityCount = message.readUInt16BE(8);
    const additionalCount = message.readUInt16BE(10);
    let offset = question.questionEnd;
    const answers: DnsResourceRecord[] = [];
    for (let index = 0; index < answerCount + authorityCount + additionalCount; index++) {
        const owner = readDnsName(message, offset);
        offset = owner.nextOffset;
        if (offset + 10 > message.length) throw new Error("DNS resource record is truncated");
        const type = message.readUInt16BE(offset);
        const dnsClass = message.readUInt16BE(offset + 2);
        const ttl = message.readUInt32BE(offset + 4);
        const dataLength = message.readUInt16BE(offset + 8);
        const ttlOffset = offset + 4;
        const dataOffset = offset + 10;
        const dataEnd = dataOffset + dataLength;
        if (dataEnd > message.length) throw new Error("DNS resource data is truncated");

        let cname: string | undefined;
        if (type === DNS_TYPE_CNAME && dnsClass === DNS_CLASS_IN) {
            const decodedCname = readDnsName(message, dataOffset);
            if (!decodedCname.name || decodedCname.nextOffset !== dataEnd) {
                throw new Error("DNS CNAME data is malformed");
            }
            cname = decodedCname.name;
        }
        if (index < answerCount) {
            answers.push({
                owner: owner.name,
                type,
                class: dnsClass,
                ttl,
                ttlOffset,
                dataOffset,
                dataLength,
                cname,
            });
        }
        offset = dataEnd;
    }
    if (offset !== message.length) throw new Error("DNS response has trailing bytes");
    return {question, answers};
}

function readDnsName(message: Buffer, startOffset: number): {name: string; nextOffset: number} {
    const labels: string[] = [];
    const visited = new Set<number>();
    let offset = startOffset;
    let nextOffset: number | undefined;
    while (true) {
        if (offset >= message.length || visited.has(offset)) throw new Error("DNS name is malformed");
        visited.add(offset);
        const length = message[offset]!;
        if ((length & 0xc0) === 0xc0) {
            if (offset + 1 >= message.length) throw new Error("DNS compression pointer is truncated");
            const pointer = ((length & 0x3f) << 8) | message[offset + 1]!;
            if (pointer >= message.length) throw new Error("DNS compression pointer is invalid");
            nextOffset ??= offset + 2;
            offset = pointer;
            continue;
        }
        if ((length & 0xc0) !== 0 || length > 63) throw new Error("DNS label is invalid");
        offset++;
        if (length === 0) {
            nextOffset ??= offset;
            break;
        }
        if (offset + length > message.length) throw new Error("DNS label is truncated");
        const labelBytes = message.subarray(offset, offset + length);
        if (labelBytes.some((byte) => byte > 0x7f)) throw new Error("DNS label is not ASCII");
        const label = labelBytes.toString("ascii").toLowerCase();
        if (!/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)) {
            throw new Error("DNS label contains unsupported characters");
        }
        labels.push(label);
        offset += length;
        if (labels.join(".").length > 253) throw new Error("DNS name is too long");
    }
    return {name: labels.join("."), nextOffset};
}

async function forwardDnsQuery(
    query: Buffer,
    upstreamAddress: string,
    upstreamPort: number,
    signal: AbortSignal,
    now: () => number,
): Promise<{response: Buffer; receivedAt: number}> {
    const type = isIP(upstreamAddress) === 4 ? "udp4" : "udp6";
    const socket = createSocket(type);
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error("upstream DNS request timed out")), DNS_REQUEST_TIMEOUT_MILLISECONDS);
        const onAbort = () => finish(new Error("synthetic DNS proxy closed"));
        const finish = (error?: Error, response?: {response: Buffer; receivedAt: number}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            try {
                socket.close();
            } catch {
                // A failed or already closed request socket has no reusable state.
            }
            if (error) reject(error);
            else if (response) resolve(response);
            else reject(new Error("upstream DNS request ended without a response"));
        };
        signal.addEventListener("abort", onAbort, {once: true});
        if (signal.aborted) {
            onAbort();
            return;
        }
        socket.once("error", (error) => finish(error));
        socket.once("message", (response) => finish(undefined, {response, receivedAt: now()}));
        socket.connect(upstreamPort, upstreamAddress, () => {
            if (settled) return;
            socket.send(query, (error) => {
                if (error) finish(error);
            });
        });
    });
}

function createDnsNoDataResponse(message: Buffer): Buffer {
    const question = parseDnsQuestion(message, true);
    const response = Buffer.from(message.subarray(0, question.questionEnd));
    const preservedFlags = message.readUInt16BE(2) & 0x0110;
    response.writeUInt16BE(0x8080 | preservedFlags, 2);
    response.writeUInt16BE(0, 6);
    response.writeUInt16BE(0, 8);
    response.writeUInt16BE(0, 10);
    return response;
}

function createDnsFailureResponse(query: Buffer): Buffer | null {
    try {
        const question = parseDnsQuestion(query, false);
        const response = Buffer.from(query.subarray(0, question.questionEnd));
        const recursionDesired = query.readUInt16BE(2) & 0x0100;
        response.writeUInt16BE(0x8082 | recursionDesired, 2);
        response.writeUInt16BE(0, 6);
        response.writeUInt16BE(0, 8);
        response.writeUInt16BE(0, 10);
        return response;
    } catch {
        return null;
    }
}

function parseIpAddress(address: string, family: NetworkAddressFamily): Buffer {
    if (family === NetworkAddressFamily.IPV4) {
        const octets = address.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
            throw new Error("invalid synthetic IPv4 address");
        }
        return Buffer.from(octets);
    }

    // inet_ntop and clients can use an IPv4 tail for any IPv6 prefix.
    // Normalize it before inspecting the reserved synthetic prefix or identity.
    const tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (tail) {
        const bytes = parseIpAddress(tail[1]!, NetworkAddressFamily.IPV4);
        address = address.slice(0, -tail[1]!.length)
            + `${bytes.readUInt16BE(0).toString(16)}:${bytes.readUInt16BE(2).toString(16)}`;
    }
    const halves = address.toLowerCase().split("::");
    if (halves.length > 2) throw new Error("invalid synthetic IPv6 address");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
        throw new Error("invalid synthetic IPv6 address");
    }
    const groups = [...left, ...Array.from({length: missing}, () => "0"), ...right];
    const bytes = Buffer.alloc(16);
    groups.forEach((group, index) => {
        if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error("invalid synthetic IPv6 address");
        bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
    });
    return bytes;
}

function formatIpv4(bytes: Buffer): string {
    if (bytes.length !== 4) throw new Error("invalid IPv4 DNS answer");
    return [...bytes].join(".");
}

function formatIpv6(bytes: Buffer): string {
    if (bytes.length !== 16) throw new Error("invalid IPv6 DNS answer");
    const groups = Array.from({length: 8}, (_, index) => bytes.readUInt16BE(index * 2));
    let bestStart = -1;
    let bestLength = 0;
    for (let index = 0; index < groups.length;) {
        if (groups[index] !== 0) {
            index++;
            continue;
        }
        let end = index;
        while (end < groups.length && groups[end] === 0) end++;
        if (end - index > bestLength && end - index >= 2) {
            bestStart = index;
            bestLength = end - index;
        }
        index = end;
    }
    if (bestStart < 0) return groups.map((group) => group.toString(16)).join(":");
    const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":");
    const right = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":");
    return `${left}::${right}`;
}

async function bindSocket(socket: Socket, port: number, address: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(port, address, () => {
            socket.off("error", reject);
            resolve();
        });
    });
}

async function sendDatagram(socket: Socket, message: Buffer, port: number, address: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.send(message, port, address, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function closeSocket(socket: Socket | undefined): Promise<void> {
    if (!socket) return;
    await new Promise<void>((resolve) => {
        try {
            socket.close(() => resolve());
        } catch {
            resolve();
        }
    });
}
