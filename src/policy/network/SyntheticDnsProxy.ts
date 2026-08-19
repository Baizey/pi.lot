import {createSocket, type RemoteInfo, type Socket} from "node:dgram";
import {isIP} from "node:net";
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
const MIN_DNS_TTL_SECONDS = 1;
const DNS_REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export type SyntheticDnsLease = Readonly<{
    hostname: string;
    family: NetworkAddressFamily;
    syntheticAddress: string;
    realAddress: string;
    expiresAt: number;
    ttlSeconds: number;
}>;

export type SyntheticDnsLeaseTableOptions = {
    install: (lease: SyntheticDnsLease) => void | Promise<void>;
    now?: () => number;
};

type PendingLease = Promise<SyntheticDnsLease>;

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
    onError?: (error: unknown) => void;
    onFatalError?: (error: unknown) => void;
};

export class SyntheticDnsLeaseTable {
    private readonly options: SyntheticDnsLeaseTableOptions;
    private readonly leasesBySyntheticAddress = new Map<string, SyntheticDnsLease>();
    private readonly leasesByAnswer = new Map<string, SyntheticDnsLease>();
    private readonly pendingByAnswer = new Map<string, PendingLease>();
    private installedLeaseCount = 0;
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
        validateDnsHostname(hostname);
        this.validateAnswer(family, realAddress);
        if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 0xffff_ffff) {
            throw new Error("DNS answer used an invalid TTL");
        }
        const answerKey = `${hostname}\0${family}\0${realAddress}`;
        const existing = this.leasesByAnswer.get(answerKey);
        if (existing && existing.expiresAt > this.now()) return existing;
        if (existing) {
            this.leasesByAnswer.delete(answerKey);
            this.leasesBySyntheticAddress.delete(existing.syntheticAddress);
        }

        const pending = this.pendingByAnswer.get(answerKey);
        if (pending) return pending;
        const creation = this.createLease(hostname, family, realAddress, ttlSeconds, answerKey);
        this.pendingByAnswer.set(answerKey, creation);
        try {
            return await creation;
        } finally {
            this.pendingByAnswer.delete(answerKey);
        }
    }

    remainingTtlSeconds(lease: SyntheticDnsLease): number {
        return Math.max(1, Math.floor((lease.expiresAt - this.now()) / 1_000));
    }

    lookup(syntheticAddress: string): SyntheticDnsLease | null {
        const lease = this.leasesBySyntheticAddress.get(syntheticAddress);
        if (!lease) return null;
        if (lease.expiresAt > this.now()) return lease;
        this.leasesBySyntheticAddress.delete(syntheticAddress);
        this.leasesByAnswer.delete(this.answerKey(lease));
        return null;
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

    private async createLease(
        hostname: string,
        family: NetworkAddressFamily,
        realAddress: string,
        ttlSeconds: number,
        answerKey: string,
    ): Promise<SyntheticDnsLease> {
        this.pruneExpiredLeases();
        if (this.installedLeaseCount >= MAX_DNS_LEASES) {
            throw new Error("synthetic DNS lease limit exceeded");
        }
        const boundedTtl = Math.max(
            MIN_DNS_TTL_SECONDS,
            Math.min(MAX_DNS_TTL_SECONDS, Math.floor(ttlSeconds)),
        );
        const syntheticAddress = family === NetworkAddressFamily.IPV4
            ? this.allocateIpv4Address()
            : this.allocateIpv6Address();
        const lease = Object.freeze({
            hostname,
            family,
            syntheticAddress,
            realAddress,
            expiresAt: this.now() + boundedTtl * 1_000,
            ttlSeconds: boundedTtl,
        });
        this.installedLeaseCount++;
        try {
            await this.options.install(lease);
        } catch (error) {
            this.installedLeaseCount--;
            throw error;
        }
        this.leasesBySyntheticAddress.set(syntheticAddress, lease);
        this.leasesByAnswer.set(answerKey, lease);
        return lease;
    }

    private pruneExpiredLeases(): void {
        const now = this.now();
        for (const [address, lease] of this.leasesBySyntheticAddress) {
            if (lease.expiresAt > now) continue;
            this.leasesBySyntheticAddress.delete(address);
            this.leasesByAnswer.delete(this.answerKey(lease));
        }
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

    private answerKey(lease: SyntheticDnsLease): string {
        return `${lease.hostname}\0${lease.family}\0${lease.realAddress}`;
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
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
        const response = await forwardDnsQuery(
            query,
            this.options.upstreamAddress,
            this.options.upstreamPort ?? DNS_PORT,
            this.abortController.signal,
        );
        const parsed = parseDnsResponse(response);
        if (
            parsed.question.id !== question.id
            || parsed.question.name !== question.name
            || parsed.question.type !== question.type
        ) {
            throw new Error("upstream DNS response did not match its query");
        }
        if (
            question.type === DNS_TYPE_AAAA
            && this.options.globalIpv6Available === false
            && hasOnlyGlobalIpv6Answers(response, parsed, question.name)
        ) {
            return createDnsNoDataResponse(query);
        }
        return rewriteAddressAnswers(response, parsed, question.name, this.options.leases);
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

async function rewriteAddressAnswers(
    original: Buffer,
    parsed: ParsedDnsResponse,
    requestedName: string,
    leases: SyntheticDnsLeaseTable,
): Promise<Buffer> {
    const response = Buffer.from(original);
    const attributedNames = attributedAnswerNames(parsed, requestedName);

    let rewritten = false;
    for (const answer of parsed.answers) {
        if (answer.class !== DNS_CLASS_IN || !attributedNames.has(answer.owner)) continue;
        const family = answer.type === DNS_TYPE_A && answer.dataLength === 4
            ? NetworkAddressFamily.IPV4
            : answer.type === DNS_TYPE_AAAA && answer.dataLength === 16
                ? NetworkAddressFamily.IPV6
                : null;
        if (!family) continue;

        const realAddress = family === NetworkAddressFamily.IPV4
            ? formatIpv4(response.subarray(answer.dataOffset, answer.dataOffset + answer.dataLength))
            : formatIpv6(response.subarray(answer.dataOffset, answer.dataOffset + answer.dataLength));
        const lease = await leases.lease(requestedName, family, realAddress, answer.ttl);
        const syntheticBytes = parseIpAddress(lease.syntheticAddress, family);
        syntheticBytes.copy(response, answer.dataOffset);
        response.writeUInt32BE(leases.remainingTtlSeconds(lease), answer.ttlOffset);
        rewritten = true;
    }
    if (rewritten) response.writeUInt16BE(response.readUInt16BE(2) & ~0x0020, 2);
    return response;
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
): Promise<Buffer> {
    const type = isIP(upstreamAddress) === 4 ? "udp4" : "udp6";
    const socket = createSocket(type);
    return new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error("upstream DNS request timed out")), DNS_REQUEST_TIMEOUT_MILLISECONDS);
        const onAbort = () => finish(new Error("synthetic DNS proxy closed"));
        const finish = (error?: Error, response?: Buffer) => {
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
        socket.once("message", (response) => finish(undefined, response));
        socket.connect(upstreamPort, upstreamAddress, () => {
            if (settled) return;
            socket.send(query, (error) => {
                if (error) finish(error);
            });
        });
    });
}

function createDnsNoDataResponse(query: Buffer): Buffer {
    const question = parseDnsQuestion(query, false);
    const response = Buffer.from(query.subarray(0, question.questionEnd));
    const preservedFlags = query.readUInt16BE(2) & 0x0110;
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
