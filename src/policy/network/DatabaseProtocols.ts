import {isUtf8} from "node:buffer";
import {randomBytes} from "node:crypto";
import type {Socket} from "node:net";
import {readChannelEnvelope} from "./ChannelHandshake.js";
import {MAX_CHANNEL_ENVELOPE_BYTES, type ChannelInspector, type ChannelProbe, type ChannelProtocolDefinition} from "./ChannelProtocol.js";
import {NetworkApplicationProtocol} from "./NetworkProtocol.js";

/** Initial envelopes only. Admission covers the whole channel, including TLS/GSS
 * upgrades and subsequent opaque traffic; these are not operation filters.
 *
 * PostgreSQL: UTF-8 v3 startup, SSLRequest and GSSENCRequest; initial authentication
 * or UTF-8 ErrorResponse. The fixed 16-byte CancelRequest is a terminal one-way
 * envelope: the broker must send only it, then close without releasing continuation.
 * NegotiateProtocolVersion replies to reserved _pq_. options are supported; startup
 * protocol 3.2 is not (only the 3.0 startup version is recognized).
 * https://www.postgresql.org/docs/current/protocol-message-formats.html
 * MySQL/MariaDB: protocol 10, protocol-4.1 secure-connection greetings (with or
 * without plugin-auth); no old short greeting or client-side recognition.
 * https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase_packets_protocol_handshake_v10.html
 * Redis: array-of-bulk-string commands (RESP2 and RESP3 use the same request
 * format), fixed-length RESP2/3 replies, including attributes. No inline commands,
 * streamed strings/aggregates, or unsolicited server-first recognition. Decimal
 * count/length headers are limited to seven characters (including a minus sign).
 * Simple/error replies require a random-nonce PING round trip: +OK/-ERR alone
 * overlap POP3 greetings. Distinctive RESP framing and exact +PONG for a zero-arg
 * PING need no challenge. The first request must already authenticate when
 * required, and PING must be ACL-permitted. Queued authentication cannot bypass
 * this check. Transaction/monitor modes or intervening pubsub pushes that prevent
 * an exact bulk-nonce/subscribed-pong response fail closed.
 * https://redis.io/docs/latest/develop/reference/protocol-spec/
 * MongoDB: uncompressed OP_MSG commands with $db, document sequences and optional
 * CRC-32C; legacy OP_QUERY direct hello/isMaster, and corresponding OP_REPLY.
 * No OP_COMPRESSED, legacy arbitrary queries, or $query-wrapped hello. Requests
 * with moreToCome are excluded because admission requires a confirming response.
 * https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/
 * https://bsonspec.org/spec.html
 * All parsers inspect exactly one bounded envelope. RESP/BSON nesting is capped
 * at 32; commands allow 4096 arguments, and reply/BSON parsing has a 4096-node
 * budget. These limits also reject otherwise valid unusually large messages.
 */
export const databaseProtocols: readonly ChannelProtocolDefinition[] = [
    {protocol: NetworkApplicationProtocol.POSTGRES, initiation: "client", inspectClient: postgresClient, inspectServer: postgresServer, isOneWayRequest: postgresOneWayRequest},
    {protocol: NetworkApplicationProtocol.MYSQL, initiation: "server", inspectClient: () => INVALID, inspectServer: mysqlGreeting},
    {
        protocol: NetworkApplicationProtocol.REDIS, initiation: "client",
        inspectClient: redisClient, inspectServer: redisServer,
        createClientInspector: createRedisClientInspector, createServerInspector: createRedisServerInspector,
        confirmServer: confirmRedisServer,
    },
    {protocol: NetworkApplicationProtocol.MONGODB, initiation: "client", inspectClient: mongoClient, inspectServer: mongoServer},
];

// Keep the literal discriminants narrow for the parsers that attach BSON metadata.
const INCOMPLETE = {status: "incomplete"} as const;
const INVALID = {status: "invalid"} as const;
const MAX_DEPTH = 32;
const MAX_ITEMS = 4096;
const match = (length: number): ChannelProbe => ({status: "match", length});

// Reject impossible partial length prefixes rather than waiting for their body.
function boundedLengthPrefix(bytes: Buffer, offset: number, width: number, minimum: number, maximum: number, littleEndian = false): boolean {
    let low = 0;
    let high = 0;
    for (let i = 0; i < width; i++) {
        const factor = 256 ** (littleEndian ? i : width - i - 1);
        const known = offset + i < bytes.length;
        low += known ? bytes[offset + i]! * factor : 0;
        high += (known ? bytes[offset + i]! : 255) * factor;
    }
    return low <= maximum && high >= minimum;
}

function postgresClient(bytes: Buffer): ChannelProbe {
    if (!boundedLengthPrefix(bytes, 0, 4, 8, MAX_CHANNEL_ENVELOPE_BYTES)) return INVALID;
    if (bytes.length < 4) return INCOMPLETE;
    const size = bytes.readUInt32BE(0);
    bytes = bytes.subarray(0, size);
    const codes = size === 8 ? [80877103, 80877104] : size === 16 ? [196608, 80877102] : [196608];
    if (size < 16 && size !== 8) return INVALID;
    if (!codes.some((code) => {
        const encoded = Buffer.alloc(4);
        encoded.writeUInt32BE(code);
        return bytes.subarray(4, Math.min(8, bytes.length)).equals(encoded.subarray(0, Math.max(0, Math.min(4, bytes.length - 4))));
    })) return INVALID;
    if (bytes.length < 8) return INCOMPLETE;
    if (size === 8) return match(size);
    // Repeated byte-sized fragments must not repeatedly parse the startup body.
    if (bytes.length < size) return INCOMPLETE;
    if (bytes.readUInt32BE(4) === 80877102) return match(16);
    const end = size;
    let offset = 8;
    let user = false;
    const names = new Set<string>();
    while (offset < end) {
        if (bytes[offset] === 0) return offset === size - 1 && user ? match(size) : INVALID;
        const keyEnd = bytes.indexOf(0, offset);
        if (keyEnd < 0 || keyEnd >= size) return bytes.length >= size ? INVALID : INCOMPLETE;
        const keyBytes = bytes.subarray(offset, keyEnd);
        if (!isUtf8(keyBytes)) return INVALID;
        const key = keyBytes.toString("utf8");
        if (names.has(key)) return INVALID;
        names.add(key);
        offset = keyEnd + 1;
        const valueEnd = bytes.indexOf(0, offset);
        if (valueEnd < 0 || valueEnd >= size - 1) return bytes.length >= size ? INVALID : INCOMPLETE;
        if (!isUtf8(bytes.subarray(offset, valueEnd))) return INVALID;
        if (key === "user") {
            if (valueEnd === offset) return INVALID;
            user = true;
        }
        offset = valueEnd + 1;
    }
    return bytes.length >= size ? INVALID : INCOMPLETE;
}

function postgresOneWayRequest(request: Buffer): boolean {
    return request.length === 16 && request.readUInt32BE(0) === 16 && request.readUInt32BE(4) === 80877102;
}

function postgresServer(bytes: Buffer, request?: Buffer): ChannelProbe {
    if (!request || request.length < 8) return INVALID;
    const requestLength = request.readUInt32BE(0);
    const code = request.readUInt32BE(4);
    if (requestLength > MAX_CHANNEL_ENVELOPE_BYTES || request.length < requestLength) return INVALID;
    if (code !== 196608) {
        if (code === 80877102 || postgresClient(request).status !== "match") return INVALID;
        if (bytes.length === 0) return INCOMPLETE;
        return bytes[0] === 0x4e || bytes[0] === (code === 80877103 ? 0x53 : 0x47) ? match(1) : INVALID;
    }
    if (requestLength < 16) return INVALID;
    if (bytes.length === 0) return INCOMPLETE;
    if (bytes[0] !== 0x52 && bytes[0] !== 0x45 && bytes[0] !== 0x76) return INVALID;
    const minimum = bytes[0] === 0x76 ? 12 : bytes[0] === 0x52 ? 8 : 5;
    if (!boundedLengthPrefix(bytes, 1, 4, minimum, MAX_CHANNEL_ENVELOPE_BYTES - 1)) return INVALID;
    if (bytes.length < 5) return INCOMPLETE;
    const end = 1 + bytes.readUInt32BE(1);
    bytes = bytes.subarray(0, end);
    if (bytes[0] === 0x76) return postgresVersionNegotiation(bytes, request, end);
    if (bytes[0] === 0x52) {
        // Continuation authentication messages cannot be the first response.
        const fixed = new Map([[0, 9], [2, 9], [3, 9], [5, 13], [6, 9], [7, 9], [9, 9]]);
        const codes = [...fixed].filter(([, size]) => size === end).map(([auth]) => auth);
        if (end >= 12) codes.push(10);
        if (!codes.some((auth) => {
            const encoded = Buffer.alloc(4);
            encoded.writeUInt32BE(auth);
            return bytes.subarray(5, Math.min(9, bytes.length)).equals(encoded.subarray(0, Math.max(0, Math.min(4, bytes.length - 5))));
        })) return INVALID;
        if (bytes.length < 9) return INCOMPLETE;
        const auth = bytes.readUInt32BE(5);
        if (bytes.length < end) return INCOMPLETE;
        if (postgresClient(request).status !== "match") return INVALID;
        if (fixed.has(auth)) {
            if (end !== fixed.get(auth)) return INVALID;
        } else if (auth === 10) {
            if (end < 12) return INVALID;
            let offset = 9;
            while (offset < Math.min(bytes.length, end)) {
                if (bytes[offset] === 0) return offset === end - 1 && offset > 9 ? match(end) : INVALID;
                const nul = bytes.indexOf(0, offset);
                if (nul < 0 || nul >= end) return bytes.length >= end ? INVALID : INCOMPLETE;
                if (!/^[A-Z0-9_-]+$/.test(bytes.subarray(offset, nul).toString("latin1"))) return INVALID;
                offset = nul + 1;
            }
            return bytes.length >= end ? INVALID : INCOMPLETE;
        } else return INVALID;
    } else {
        if (bytes.length < end) return INCOMPLETE;
        if (postgresClient(request).status !== "match") return INVALID;
        let offset = 5;
        const fields = new Map<string, string>();
        while (offset < Math.min(bytes.length, end)) {
            if (bytes[offset] === 0) {
                return offset === end - 1 && fields.has("M") && /^[0-9A-Z]{5}$/.test(fields.get("C") ?? "")
                    && (fields.has("S") || fields.has("V")) ? match(end) : INVALID;
            }
            const field = bytes[offset]!;
            if (field < 0x41 || field > 0x7a) return INVALID;
            const nul = bytes.indexOf(0, offset + 1);
            if (nul < 0 || nul >= end) return bytes.length >= end ? INVALID : INCOMPLETE;
            if (!isUtf8(bytes.subarray(offset + 1, nul))) return INVALID;
            fields.set(String.fromCharCode(field), bytes.subarray(offset + 1, nul).toString("utf8"));
            offset = nul + 1;
        }
        return bytes.length >= end ? INVALID : INCOMPLETE;
    }
    return bytes.length >= end ? match(end) : INCOMPLETE;
}

function postgresVersionNegotiation(bytes: Buffer, request: Buffer, end: number): ChannelProbe {
    if (!boundedLengthPrefix(bytes, 9, 4, 0, Math.min(MAX_ITEMS, end - 13))) return INVALID;
    if (bytes.length < end) return INCOMPLETE;
    if (postgresClient(request).status !== "match") return INVALID;
    const options = new Set<string>();
    let offset = 8;
    while (request[offset] !== 0) {
        const nameEnd = request.indexOf(0, offset);
        const name = request.subarray(offset, nameEnd).toString("utf8");
        if (name.startsWith("_pq_.")) options.add(name);
        offset = request.indexOf(0, nameEnd + 1) + 1;
    }
    const count = bytes.readUInt32BE(9);
    const seen = new Set<string>();
    offset = 13;
    for (let i = 0; i < count; i++) {
        const nul = bytes.indexOf(0, offset);
        if (nul < 0 || nul >= end || nul === offset || !isUtf8(bytes.subarray(offset, nul))) return INVALID;
        const name = bytes.subarray(offset, nul).toString("utf8");
        if (!options.has(name) || seen.has(name)) return INVALID;
        seen.add(name);
        offset = nul + 1;
    }
    return offset === end ? match(end) : INVALID;
}

function mysqlGreeting(bytes: Buffer): ChannelProbe {
    if (!boundedLengthPrefix(bytes, 0, 3, 47, MAX_CHANNEL_ENVELOPE_BYTES - 4, true)) return INVALID;
    if (bytes.length > 3 && bytes[3] !== 0) return INVALID;
    if (bytes.length > 4 && bytes[4] !== 10) return INVALID;
    if (bytes.length < 5) return INCOMPLETE;
    const end = 4 + bytes.readUIntLE(0, 3);
    bytes = bytes.subarray(0, end);
    const versionEnd = bytes.indexOf(0, 5);
    const availableVersion = bytes.subarray(5, versionEnd < 0 ? Math.min(bytes.length, end) : versionEnd);
    if (availableVersion.some((byte) => byte < 0x20 || byte > 0x7e)
        || (availableVersion.length > 0 && (availableVersion[0]! < 0x30 || availableVersion[0]! > 0x39))) return INVALID;
    if (versionEnd < 0 || versionEnd >= end) return bytes.length >= end ? INVALID : INCOMPLETE;
    if (versionEnd === 5) return INVALID;
    const base = versionEnd + 1;
    // connection-id(4), scramble(8), zero, capabilities(2), charset, status(2),
    // upper capabilities(2), auth-data-length, reserved(10).
    if (base + 31 + 13 > end) return INVALID;
    if (bytes.length > base + 12 && bytes[base + 12] !== 0) return INVALID;
    if (bytes.length < base + 15) return INCOMPLETE;
    const lower = bytes.readUInt16LE(base + 13);
    if ((lower & 0x8200) !== 0x8200) return INVALID; // PROTOCOL_41 | SECURE_CONNECTION
    if (bytes.length > base + 15 && bytes[base + 15] === 0) return INVALID;
    if (bytes.length < base + 21) return INCOMPLETE;
    const pluginAuth = (bytes.readUInt16LE(base + 18) & 8) !== 0;
    const authLength = bytes[base + 20]!;
    if (pluginAuth ? authLength < 9 : authLength !== 0) return INVALID;
    // MariaDB may use the last four reserved bytes for extended capabilities
    // only when CLIENT_MYSQL is absent; MySQL requires all ten bytes to be zero.
    const reservedEnd = (lower & 1) !== 0 ? base + 31 : base + 27;
    for (let i = base + 21; i < Math.min(bytes.length, reservedEnd); i++) if (bytes[i] !== 0) return INVALID;
    const scrambleEnd = base + 31 + Math.max(13, pluginAuth ? authLength - 8 : 13);
    if (scrambleEnd > end || (pluginAuth && scrambleEnd + 2 > end)) return INVALID;
    if (bytes.length < scrambleEnd) return INCOMPLETE;
    if (bytes[scrambleEnd - 1] !== 0) return INVALID;
    if (!pluginAuth) return end === scrambleEnd ? match(end) : INVALID;
    const pluginEnd = bytes.indexOf(0, scrambleEnd);
    const availablePlugin = bytes.subarray(scrambleEnd, pluginEnd < 0 ? Math.min(bytes.length, end) : pluginEnd);
    if (availablePlugin.some((byte) => byte < 0x21 || byte > 0x7e)) return INVALID;
    if (pluginEnd < 0 || pluginEnd >= end) return bytes.length >= end ? INVALID : INCOMPLETE;
    return pluginEnd === end - 1 && pluginEnd > scrambleEnd ? match(end) : INVALID;
}

type RespResult = ChannelProbe;
type ParseBudget = {items: number};

function createRedisClientInspector(): ChannelInspector {
    const framer = new RedisEnvelopeFramer("client", redisClient);
    return (bytes) => framer.inspect(bytes);
}

function createRedisServerInspector(request?: Buffer): ChannelInspector {
    if (!request) return () => INVALID;
    const framer = new RedisEnvelopeFramer("server", (bytes) => redisServer(bytes, request));
    return (bytes) => framer.inspect(bytes);
}

type RedisAggregate = {remaining: number; attributes: boolean; push: boolean; index: number};
type RedisPhase = "type" | "line" | "line-lf" | "bulk" | "bulk-cr" | "bulk-lf";

/** One reader owns one append-only cursor. This locates the envelope in linear
 * work, then invokes the stateless semantic validator exactly once. No request,
 * nesting stack, cursor or verdict is shared between connections/directions.
 */
class RedisEnvelopeFramer {
    private cursor = 0;
    private previousSize = 0;
    private phase: RedisPhase = "type";
    private type = "";
    private lineStart = 0;
    private numeric = false;
    private count = 0;
    private negative = false;
    private bulkEnd = 0;
    private items = 0;
    private readonly stack: RedisAggregate[] = [{remaining: 1, attributes: false, push: false, index: 0}];
    private completeLength: number | undefined;
    private verdict: ChannelProbe | undefined;

    constructor(private readonly direction: "client" | "server", private readonly validate: ChannelInspector) {}

    inspect(bytes: Buffer): ChannelProbe {
        if (this.verdict) return this.verdict;
        if (bytes.length < this.previousSize) return this.reject();
        this.previousSize = bytes.length;
        const limit = Math.min(bytes.length, MAX_CHANNEL_ENVELOPE_BYTES);
        while (this.cursor < limit && this.completeLength === undefined) {
            if (this.phase === "bulk") {
                // Bulk data is binary: embedded CR/LF never changes framing.
                this.cursor = Math.min(limit, this.bulkEnd);
                if (this.cursor < this.bulkEnd) break;
                this.phase = "bulk-cr";
                continue;
            }
            const byte = bytes[this.cursor++]!;
            if (!this.consume(byte)) return this.reject();
        }
        if (this.completeLength !== undefined) {
            const checked = this.validate(bytes.subarray(0, this.completeLength));
            this.verdict = checked.status === "match" && checked.length === this.completeLength ? checked : INVALID;
            return this.verdict;
        }
        return this.cursor >= MAX_CHANNEL_ENVELOPE_BYTES ? this.reject() : INCOMPLETE;
    }

    private consume(byte: number): boolean {
        switch (this.phase) {
            case "type": return this.startValue(byte);
            case "line": return this.consumeLine(byte);
            case "line-lf":
                if (byte !== 10) return false;
                return this.finishLine();
            case "bulk-cr":
                if (byte !== 13) return false;
                this.phase = "bulk-lf";
                return true;
            case "bulk-lf":
                if (byte !== 10) return false;
                this.finishValue();
                return true;
            case "bulk": return false; // Skipped by inspect(), never consumed bytewise.
        }
    }

    private startValue(byte: number): boolean {
        const depth = this.stack.length - 1;
        if (depth > MAX_DEPTH || ++this.items > MAX_ITEMS + (this.direction === "client" ? 1 : 0)) return false;
        const type = String.fromCharCode(byte);
        if (this.direction === "client") {
            if (type !== (this.items === 1 ? "*" : "$")) return false;
        } else if (!"+-:$*!=(,_#%~>|".includes(type)) return false;
        const parent = this.stack[this.stack.length - 1]!;
        if (parent.push && parent.index === 0 && type !== "+" && type !== "$") return false;
        this.type = type;
        this.lineStart = this.cursor;
        this.numeric = "$*!=%~>|".includes(type);
        this.count = 0;
        this.negative = false;
        this.phase = "line";
        return true;
    }

    private consumeLine(byte: number): boolean {
        if (byte === 13) {
            this.phase = "line-lf";
            return true;
        }
        if (byte === 10) return false;
        const index = this.cursor - this.lineStart - 1;
        if (this.numeric) {
            if (index >= 7) return false;
            if (index === 0 && byte === 45) {
                if (this.direction === "client" || (this.type !== "$" && this.type !== "*")) return false;
                this.negative = true;
                return true;
            }
            if (this.negative) return index === 1 && byte === 49;
            if (byte < 48 || byte > 57) return false;
            this.count = this.count * 10 + byte - 48;
            return this.count <= ("$!=".includes(this.type) ? MAX_CHANNEL_ENVELOPE_BYTES : MAX_ITEMS);
        }
        if (this.type === "_") return false;
        if (this.type === "#") return index === 0 && (byte === 116 || byte === 102);
        if (this.type === ":" || this.type === "(") {
            if (this.type === ":" && index >= 21) return false;
            return (index === 0 && (byte === 43 || byte === 45)) || (byte >= 48 && byte <= 57);
        }
        // Floating-point syntax and simple-string contents are validated once,
        // after the bounded line terminator, rather than rescanned per fragment.
        return true;
    }

    private finishLine(): boolean {
        if (!this.numeric) {
            this.finishValue();
            return true;
        }
        const digits = this.cursor - this.lineStart - 2;
        if (digits === 0 || (this.negative && digits !== 2)) return false;
        if (this.negative) {
            this.finishValue();
            return true;
        }
        if ("$!=".includes(this.type)) {
            if (this.direction === "client" && this.items === 2 && this.count === 0) return false;
            if (this.type === "=" && this.count < 4) return false;
            this.bulkEnd = this.cursor + this.count;
            if (this.bulkEnd + 2 > MAX_CHANNEL_ENVELOPE_BYTES) return false;
            this.phase = "bulk";
            return true;
        }
        if ((this.direction === "client" || this.type === ">") && this.count === 0) return false;
        const children = this.type === "%" || this.type === "|" ? this.count * 2 : this.count;
        const budget = MAX_ITEMS + (this.direction === "client" ? 1 : 0);
        if (children > budget - this.items || this.cursor + children * 3 > MAX_CHANNEL_ENVELOPE_BYTES) return false;
        if (children === 0) {
            if (this.type === "|") this.phase = "type";
            else this.finishValue();
        } else {
            this.stack.push({remaining: children, attributes: this.type === "|", push: this.type === ">", index: 0});
            this.phase = "type";
        }
        return true;
    }

    private finishValue(): void {
        this.phase = "type";
        while (this.stack.length > 0) {
            const parent = this.stack[this.stack.length - 1]!;
            parent.remaining--;
            parent.index++;
            if (parent.remaining > 0) return;
            this.stack.pop();
            // An attribute aggregate annotates the next value without consuming
            // its parent's slot. Its own nested children did consume their slots.
            if (parent.attributes) return;
        }
        this.completeLength = this.cursor;
    }

    private reject(): ChannelProbe {
        this.verdict = INVALID;
        return INVALID;
    }
}

function redisClient(bytes: Buffer): ChannelProbe {
    if (bytes.length === 0) return INCOMPLETE;
    if (bytes[0] !== 0x2a) return INVALID;
    const header = respLine(bytes, 1, MAX_ITEMS);
    if (header.status !== "match") return header;
    const count = respCount(bytes, 1, header.length - 2, MAX_ITEMS);
    if (count === undefined || count < 1) return INVALID;
    let offset = header.length;
    for (let i = 0; i < count; i++) {
        if (offset >= bytes.length) return offset >= MAX_CHANNEL_ENVELOPE_BYTES ? INVALID : INCOMPLETE;
        if (bytes[offset] !== 0x24) return INVALID;
        const line = respLine(bytes, offset + 1, MAX_CHANNEL_ENVELOPE_BYTES);
        if (line.status !== "match") return line;
        const size = respCount(bytes, offset + 1, line.length - 2, MAX_CHANNEL_ENVELOPE_BYTES);
        if (size === undefined || size < 0 || (i === 0 && size === 0)) return INVALID;
        const body = respBulk(bytes, line.length, size);
        if (body.status !== "match") return body;
        offset = body.length;
    }
    return match(offset);
}

function redisServer(bytes: Buffer, request?: Buffer): ChannelProbe {
    if (!request) return INVALID;
    const response = respValue(bytes, 0, 0, {items: 0});
    // Do not reparse a large request on every fragment of its response.
    if (response.status !== "match") return response;
    return redisClient(request).status === "match" ? response : INVALID;
}

async function confirmRedisServer(upstream: Socket, request: Buffer, response: Buffer, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (response[0] !== 0x2b && response[0] !== 0x2d) return;
    if (response.equals(Buffer.from("+PONG\r\n")) && redisZeroArgumentPing(request)) return;
    const nonce = randomBytes(32).toString("hex");
    const command = Buffer.from(`*2\r\n$4\r\nPING\r\n$${nonce.length}\r\n${nonce}\r\n`);
    const bulk = `$${nonce.length}\r\n${nonce}\r\n`;
    const replies = [Buffer.from(bulk), Buffer.from(`*2\r\n$4\r\npong\r\n${bulk}`)];
    upstream.write(command);
    // Consume only the challenge response. The owner restores the original
    // response after this resolves and still holds every queued client byte.
    await readChannelEnvelope(upstream, (bytes) => {
        for (const reply of replies) {
            if (bytes.subarray(0, Math.min(bytes.length, reply.length)).equals(reply.subarray(0, bytes.length))) {
                return bytes.length >= reply.length ? match(reply.length) : INCOMPLETE;
            }
        }
        return INVALID;
    }, signal);
}

function redisZeroArgumentPing(request: Buffer): boolean {
    if (request[0] !== 0x2a) return false;
    const array = respLine(request, 1, MAX_ITEMS);
    if (array.status !== "match" || respCount(request, 1, array.length - 2, MAX_ITEMS) !== 1 || request[array.length] !== 0x24) return false;
    const bulk = respLine(request, array.length + 1, MAX_CHANNEL_ENVELOPE_BYTES);
    return bulk.status === "match" && respCount(request, array.length + 1, bulk.length - 2, MAX_CHANNEL_ENVELOPE_BYTES) === 4
        && request.subarray(bulk.length, bulk.length + 4).toString("latin1").toUpperCase() === "PING";
}

function respValue(bytes: Buffer, start: number, depth: number, budget: ParseBudget): RespResult {
    let offset = start;
    // Attributes can annotate nested values too. Iteration bounds stack use for
    // repeated attributes at the same depth; they are not independent replies.
    while (true) {
        const attributes = bytes[offset] === 0x7c;
        const value = respNode(bytes, offset, depth, budget);
        if (value.status !== "match") return value;
        offset = value.length;
        if (!attributes) return match(offset);
    }
}

function respNode(bytes: Buffer, start: number, depth: number, budget: ParseBudget): RespResult {
    if (start >= MAX_CHANNEL_ENVELOPE_BYTES || depth > MAX_DEPTH || ++budget.items > MAX_ITEMS) return INVALID;
    if (start >= bytes.length) return INCOMPLETE;
    const type = String.fromCharCode(bytes[start]!);
    if (!"+-:$*!=(,_#%~>|".includes(type)) return INVALID;
    const numeric = "$*!=%~>|".includes(type);
    const maximum = "$!=".includes(type) ? MAX_CHANNEL_ENVELOPE_BYTES : MAX_ITEMS;
    const line = respLine(bytes, start + 1, numeric ? maximum : undefined);
    if (!respScalarPrefix(bytes, start + 1, line.status === "match" ? line.length - 2 : undefined, type)) return INVALID;
    if (line.status !== "match") return line;
    const text = bytes.subarray(start + 1, line.length - 2).toString("latin1");
    if (type === "+" || type === "-") return match(line.length);
    if (type === ":") return /^[+-]?\d+$/.test(text) && text.length <= 21
        && BigInt(text) >= -(1n << 63n) && BigInt(text) < (1n << 63n) ? match(line.length) : INVALID;
    if (type === "(") return /^[+-]?\d+$/.test(text) ? match(line.length) : INVALID;
    if (type === ",") return /^(?:inf|-inf|nan|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(text) ? match(line.length) : INVALID;
    if (type === "_") return text === "" ? match(line.length) : INVALID;
    if (type === "#") return text === "t" || text === "f" ? match(line.length) : INVALID;
    const count = respCount(bytes, start + 1, line.length - 2, type === "$" || type === "!" || type === "=" ? MAX_CHANNEL_ENVELOPE_BYTES : MAX_ITEMS);
    if (count === undefined) return INVALID;
    if (count === -1) return type === "$" || type === "*" ? match(line.length) : INVALID;
    if (type === "$" || type === "!" || type === "=") {
        const bulk = respBulk(bytes, line.length, count);
        if (bulk.status !== "match") return bulk;
        if (type === "=" && (count < 4 || bytes[line.length + 3] !== 0x3a
            || bytes.subarray(line.length, line.length + 3).some((byte) => byte < 0x21 || byte > 0x7e))) return INVALID;
        return bulk;
    }
    if (type === ">" && count === 0) return INVALID;
    const children = type === "%" || type === "|" ? count * 2 : count;
    if (children > MAX_ITEMS - budget.items || line.length + children * 3 > MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
    let offset = line.length;
    for (let i = 0; i < children; i++) {
        if (type === ">" && i === 0 && offset < bytes.length && bytes[offset] !== 0x2b && bytes[offset] !== 0x24) return INVALID;
        const child = respValue(bytes, offset, depth + 1, budget);
        if (child.status !== "match") return child;
        offset = child.length;
    }
    return match(offset);
}

function respScalarPrefix(bytes: Buffer, start: number, end: number | undefined, type: string): boolean {
    if (!":(_,#".includes(type)) return true;
    const available = bytes.subarray(start, end ?? MAX_CHANNEL_ENVELOPE_BYTES);
    const cr = available.indexOf(13);
    const lf = available.indexOf(10);
    const delimiter = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
    const text = available.subarray(0, delimiter < 0 ? available.length : delimiter).toString("latin1");
    if (type === "_") return text === "";
    if (type === "#") return text === "" || text === "t" || text === "f";
    if (type === ",") return ["inf", "-inf", "nan"].some((word) => word.startsWith(text))
        || /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d*)?|\.)?$/.test(text);
    if (!/^[+-]?\d*$/.test(text)) return false;
    if (type === "(") return true;
    if (text.length > 21) return false;
    const digits = text.replace(/^[+-]/, "");
    return digits === "" || BigInt(digits) <= (text.startsWith("-") ? 1n << 63n : (1n << 63n) - 1n);
}

function respLine(bytes: Buffer, start: number, maximum?: number): ChannelProbe {
    if (maximum === undefined) {
        // Native searches keep repeatedly fragmented long simple strings out of
        // a JavaScript byte loop. Binary bulk payloads never go through here.
        const bounded = bytes.subarray(0, MAX_CHANNEL_ENVELOPE_BYTES);
        const cr = bounded.indexOf(13, start);
        const lf = bounded.indexOf(10, start);
        if (lf >= 0 && (cr < 0 || lf < cr)) return INVALID;
        if (cr >= 0) {
            if (cr + 2 > MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
            if (cr + 1 >= bytes.length) return INCOMPLETE;
            return bytes[cr + 1] === 10 ? match(cr + 2) : INVALID;
        }
        return bytes.length >= MAX_CHANNEL_ENVELOPE_BYTES ? INVALID : INCOMPLETE;
    }
    for (let offset = start; offset < Math.min(bytes.length, MAX_CHANNEL_ENVELOPE_BYTES); offset++) {
        const byte = bytes[offset]!;
        if (byte === 13) {
            if (offset + 2 > MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
            if (offset + 1 >= bytes.length) return INCOMPLETE;
            return bytes[offset + 1] === 10 ? match(offset + 2) : INVALID;
        }
        if (byte === 10) return INVALID;
        if (maximum !== undefined) {
            if (!((byte >= 48 && byte <= 57) || (byte === 45 && offset === start))) return INVALID;
            if (offset - start > 6) return INVALID;
            if (bytes[start] === 45) {
                if ((offset === start + 1 && byte !== 49) || offset > start + 1) return INVALID;
            } else if (Number(bytes.subarray(start, offset + 1).toString("ascii")) > maximum) return INVALID;
        }
    }
    return bytes.length >= MAX_CHANNEL_ENVELOPE_BYTES ? INVALID : INCOMPLETE;
}

function respCount(bytes: Buffer, start: number, end: number, maximum: number): number | undefined {
    const text = bytes.subarray(start, end).toString("ascii");
    if (text === "-1") return -1;
    if (!/^\d+$/.test(text)) return undefined;
    const count = Number(text);
    return Number.isSafeInteger(count) && count <= maximum ? count : undefined;
}

function respBulk(bytes: Buffer, start: number, size: number): ChannelProbe {
    const end = start + size + 2;
    if (end > MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
    if (bytes.length > end - 2 && bytes[end - 2] !== 13) return INVALID;
    if (bytes.length > end - 1 && bytes[end - 1] !== 10) return INVALID;
    return bytes.length >= end ? match(end) : INCOMPLETE;
}

type BsonScalar = string | number | bigint | boolean | null;
type BsonDocument = {status: "match"; length: number; fields: Map<string, BsonScalar | undefined>; first: string} | {status: "incomplete" | "invalid"};
type MongoEnvelope = {status: "match"; length: number; opcode: number; fields: Map<string, BsonScalar | undefined>; first: string} | {status: "incomplete" | "invalid"};

function mongoClient(bytes: Buffer): ChannelProbe {
    const parsed = mongoEnvelope(bytes, false);
    if (parsed.status !== "match") return parsed;
    if (bytes.readInt32LE(8) !== 0) return INVALID;
    if (parsed.opcode === 2013) {
        return parsed.first !== "" && parsed.first !== "$db" && typeof parsed.fields.get("$db") === "string"
            && parsed.fields.get("$db") !== "" ? match(parsed.length) : INVALID;
    }
    const hello = parsed.first === "hello" || parsed.first === "isMaster" || parsed.first === "ismaster";
    const value = parsed.fields.get(parsed.first);
    return hello && (value === 1 || value === 1n) ? match(parsed.length) : INVALID;
}

function mongoServer(bytes: Buffer, request?: Buffer): ChannelProbe {
    if (!request || request.length < 16) return INVALID;
    const requestLength = request.readInt32LE(0);
    if (requestLength < 26 || requestLength > MAX_CHANNEL_ENVELOPE_BYTES || request.length < requestLength
        || request.readInt32LE(8) !== 0 || ![2013, 2004].includes(request.readInt32LE(12))) return INVALID;
    if (bytes.length >= 12 && bytes.readInt32LE(8) !== request.readInt32LE(4)) return INVALID;
    const expectedOpcode = request.readInt32LE(12) === 2013 ? 2013 : 1;
    const parsed = mongoEnvelope(bytes, true, expectedOpcode);
    if (parsed.status !== "match") return parsed;
    if (mongoClient(request).status !== "match") return INVALID;
    if (expectedOpcode === 1 && bytes.readUInt32LE(16) === 2) {
        return typeof parsed.fields.get("$err") === "string" ? match(parsed.length) : INVALID;
    }
    if (expectedOpcode === 2013 && (bytes.readUInt32LE(16) & 2) !== 0 && (request.readUInt32LE(16) & 0x10000) === 0) return INVALID;
    const ok = parsed.fields.get("ok");
    return ok === 0 || ok === 1 || ok === 0n || ok === 1n ? match(parsed.length) : INVALID;
}

function mongoEnvelope(bytes: Buffer, server: boolean, expectedOpcode?: number): MongoEnvelope {
    if (!boundedLengthPrefix(bytes, 0, 4, 26, MAX_CHANNEL_ENVELOPE_BYTES, true)) return INVALID;
    if (bytes.length < 4) return INCOMPLETE;
    const end = bytes.readInt32LE(0);
    bytes = bytes.subarray(0, end);
    const opcodes = expectedOpcode === undefined ? [2013, 2004] : [expectedOpcode];
    if (!opcodes.some((opcode) => {
        const encoded = Buffer.alloc(4);
        encoded.writeInt32LE(opcode);
        return bytes.subarray(12, Math.min(bytes.length, 16)).equals(encoded.subarray(0, Math.max(0, Math.min(bytes.length - 12, 4))));
    })) return INVALID;
    if (!server) for (let i = 8; i < Math.min(bytes.length, 12); i++) if (bytes[i] !== 0) return INVALID;
    if (bytes.length < 16) return INCOMPLETE;
    const opcode = bytes.readInt32LE(12);
    const budget = {items: 0};
    let body: BsonDocument | undefined;
    if (opcode === 2013) {
        if (end < 26) return INVALID;
        if (bytes.length < 20) return INCOMPLETE;
        const flags = bytes.readUInt32LE(16);
        // Bits 0..15 are required flags; unknown bits 16..31 are optional and
        // MUST be ignored. The known exhaustAllowed bit remains client-only.
        if ((flags & 0xfffc) !== 0 || (!server && (flags & 2) !== 0) || (server && (flags & 0x10000) !== 0)) return INVALID;
        const sectionsEnd = end - ((flags & 1) !== 0 ? 4 : 0);
        if (sectionsEnd < 26) return INVALID;
        if (bytes.length > 20) {
            if (bytes[20] !== 0 && bytes[20] !== 1) return INVALID;
            if (!boundedLengthPrefix(bytes, 21, 4, 5, sectionsEnd - 21, true)) return INVALID;
        }
        // Only cheap framing checks run while fragmented. BSON validation waits
        // for the complete bounded message rather than reparsing every prefix.
        if (bytes.length < end) return INCOMPLETE;
        const identifiers = new Set<string>();
        let offset = 20;
        while (offset < sectionsEnd) {
            if (offset >= bytes.length) return INCOMPLETE;
            if (++budget.items > MAX_ITEMS) return INVALID;
            const kind = bytes[offset++]!;
            if (kind === 0) {
                if (body) return INVALID;
                const document = bsonDocument(bytes, offset, sectionsEnd, 0, budget);
                if (document.status !== "match") return document;
                body = document;
                offset = document.length;
            } else if (kind === 1) {
                if (!boundedLengthPrefix(bytes, offset, 4, 5, sectionsEnd - offset, true)) return INVALID;
                if (bytes.length < offset + 4) return INCOMPLETE;
                const sequenceEnd = offset + bytes.readInt32LE(offset);
                const name = bsonCString(bytes, offset + 4, sequenceEnd);
                if (name.status !== "match") return name;
                if (name.length === offset + 5) return INVALID;
                const identifier = bytes.subarray(offset + 4, name.length - 1).toString("utf8");
                if (identifiers.has(identifier)) return INVALID;
                identifiers.add(identifier);
                offset = name.length;
                while (offset < sequenceEnd) {
                    const document = bsonDocument(bytes, offset, sequenceEnd, 0, budget);
                    if (document.status !== "match") return document;
                    offset = document.length;
                }
            } else return INVALID;
        }
        if (!body || body.status !== "match") return INVALID;
        for (const identifier of identifiers) if (body.fields.has(identifier)) return INVALID;
        if (bytes.length < end) return INCOMPLETE;
        if ((flags & 1) !== 0 && crc32c(bytes.subarray(0, end - 4)) !== bytes.readUInt32LE(end - 4)) return INVALID;
    } else if (opcode === 2004) {
        if (bytes.length < 20) return INCOMPLETE;
        if ((bytes.readUInt32LE(16) & ~4) !== 0) return INVALID;
        if (bytes.length < end) return INCOMPLETE;
        const namespace = bsonCString(bytes, 20, end - 13);
        if (namespace.status !== "match") return namespace;
        if (!/^[^.\x00]+\.\$cmd$/.test(bytes.subarray(20, namespace.length - 1).toString("utf8"))) return INVALID;
        if (bytes.length < namespace.length + 8) return INCOMPLETE;
        if (bytes.readInt32LE(namespace.length) !== 0 || ![-1, 1].includes(bytes.readInt32LE(namespace.length + 4))) return INVALID;
        body = bsonDocument(bytes, namespace.length + 8, end, 0, budget);
        if (body.status !== "match") return body;
        if (body.length !== end) return INVALID;
    } else if (opcode === 1) {
        if (end < 41) return INVALID;
        if (bytes.length < 36) return INCOMPLETE;
        if (![0, 2].includes(bytes.readUInt32LE(16)) || bytes.readBigInt64LE(20) !== 0n
            || bytes.readInt32LE(28) !== 0 || bytes.readInt32LE(32) !== 1) return INVALID;
        if (bytes.length < end) return INCOMPLETE;
        body = bsonDocument(bytes, 36, end, 0, budget);
        if (body.status !== "match") return body;
        if (body.length !== end) return INVALID;
    } else return INVALID;
    if (!body || body.status !== "match") return INVALID;
    return {status: "match", length: end, opcode, fields: body.fields, first: body.first};
}

function bsonDocument(bytes: Buffer, start: number, limit: number, depth: number, budget: ParseBudget, array = false): BsonDocument {
    if (depth > MAX_DEPTH || ++budget.items > MAX_ITEMS || !boundedLengthPrefix(bytes, start, 4, 5, limit - start, true)) return INVALID;
    if (bytes.length < start + 4) return INCOMPLETE;
    const end = start + bytes.readInt32LE(start);
    const fields = new Map<string, BsonScalar | undefined>();
    let first = "";
    let offset = start + 4;
    let index = 0;
    while (offset < end - 1) {
        if (offset >= bytes.length) return INCOMPLETE;
        if (++budget.items > MAX_ITEMS) return INVALID;
        const type = bytes[offset++]!;
        if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 127, 255].includes(type)) return INVALID;
        const name = bsonCString(bytes, offset, end - 1);
        if (name.status !== "match") return name;
        const key = bytes.subarray(offset, name.length - 1).toString("utf8");
        if (fields.has(key) || (array && key !== String(index++))) return INVALID;
        if (fields.size === 0) first = key;
        offset = name.length;
        let value: BsonScalar | undefined;
        const fixed = new Map([[1, 8], [6, 0], [7, 12], [8, 1], [9, 8], [10, 0], [16, 4], [17, 8], [18, 8], [19, 16], [127, 0], [255, 0]]);
        const width = fixed.get(type);
        if (width !== undefined) {
            if (offset + width > end - 1) return INVALID;
            if (bytes.length < offset + width) return INCOMPLETE;
            if (type === 1) value = bytes.readDoubleLE(offset);
            if (type === 8) {
                if (bytes[offset] !== 0 && bytes[offset] !== 1) return INVALID;
                value = bytes[offset] === 1;
            }
            if (type === 10) value = null;
            if (type === 16) value = bytes.readInt32LE(offset);
            if (type === 18) value = bytes.readBigInt64LE(offset);
            offset += width;
        } else if (type === 3 || type === 4) {
            const child = bsonDocument(bytes, offset, end - 1, depth + 1, budget, type === 4);
            if (child.status !== "match") return child;
            offset = child.length;
        } else if (type === 2 || type === 13 || type === 14 || type === 12) {
            const string = bsonString(bytes, offset, end - 1);
            if (string.status !== "match") return string;
            if (type === 2) value = bytes.subarray(offset + 4, string.length - 1).toString("utf8");
            offset = string.length;
            if (type === 12) {
                if (offset + 12 > end - 1) return INVALID;
                if (bytes.length < offset + 12) return INCOMPLETE;
                offset += 12;
                value = undefined;
            }
        } else if (type === 5) {
            if (!boundedLengthPrefix(bytes, offset, 4, 0, end - 1 - offset - 5, true)) return INVALID;
            if (bytes.length < offset + 5) return INCOMPLETE;
            const size = bytes.readInt32LE(offset);
            const subtype = bytes[offset + 4]!;
            if (subtype === 2) {
                if (size < 4) return INVALID;
                if (bytes.length < offset + 9) return INCOMPLETE;
                if (bytes.readInt32LE(offset + 5) !== size - 4) return INVALID;
            }
            if (bytes.length < offset + 5 + size) return INCOMPLETE;
            offset += 5 + size;
        } else if (type === 11) {
            const pattern = bsonCString(bytes, offset, end - 1);
            if (pattern.status !== "match") return pattern;
            const options = bsonCString(bytes, pattern.length, end - 1);
            if (options.status !== "match") return options;
            if (!/^(?:i?l?m?s?u?x?)$/.test(bytes.subarray(pattern.length, options.length - 1).toString("ascii"))) return INVALID;
            offset = options.length;
        } else if (type === 15) {
            if (!boundedLengthPrefix(bytes, offset, 4, 14, end - 1 - offset, true)) return INVALID;
            if (bytes.length < offset + 4) return INCOMPLETE;
            const scopeEnd = offset + bytes.readInt32LE(offset);
            const code = bsonString(bytes, offset + 4, scopeEnd - 5);
            if (code.status !== "match") return code;
            const scope = bsonDocument(bytes, code.length, scopeEnd, depth + 1, budget);
            if (scope.status !== "match") return scope;
            if (scope.length !== scopeEnd) return INVALID;
            offset = scopeEnd;
        }
        fields.set(key, value);
    }
    if (offset !== end - 1) return INVALID;
    if (bytes.length < end) return INCOMPLETE;
    return bytes[end - 1] === 0 ? {status: "match", length: end, fields, first} : INVALID;
}

function bsonCString(bytes: Buffer, start: number, limit: number): ChannelProbe {
    if (start >= limit) return INVALID;
    const relativeNul = bytes.subarray(start, limit).indexOf(0);
    if (relativeNul < 0) return bytes.length >= limit ? INVALID : INCOMPLETE;
    const nul = start + relativeNul;
    return isUtf8(bytes.subarray(start, nul)) ? match(nul + 1) : INVALID;
}

function bsonString(bytes: Buffer, start: number, limit: number): ChannelProbe {
    if (!boundedLengthPrefix(bytes, start, 4, 1, limit - start - 4, true)) return INVALID;
    if (bytes.length < start + 4) return INCOMPLETE;
    const end = start + 4 + bytes.readInt32LE(start);
    if (bytes.length < end) return INCOMPLETE;
    return bytes[end - 1] === 0 && isUtf8(bytes.subarray(start + 4, end - 1)) ? match(end) : INVALID;
}

function crc32c(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0x82f63b78 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
