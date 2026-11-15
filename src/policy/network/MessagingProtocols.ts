import {NetworkApplicationProtocol} from "./NetworkProtocol.js";
import {
    INCOMPLETE, INVALID, MAX_CHANNEL_ENVELOPE_BYTES,
    type ChannelProbe, type ChannelProtocolDefinition,
} from "./ChannelProtocol.js";

// Admission covers the resulting channel, not individual messages/commands. These
// parsers intentionally recognize only bounded initial negotiations, never a bare
// length prefix or arbitrary application traffic.
const NEED_MORE = Symbol("incomplete envelope");
const BAD = Symbol("invalid envelope");
const utf8 = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});

function probe(parse: () => number): ChannelProbe {
    try {
        return {status: "match", length: parse()};
    } catch (error) {
        if (error === NEED_MORE) return INCOMPLETE;
        if (error === BAD) return INVALID;
        throw error;
    }
}

/** Distinguishes unavailable bytes from fields exceeding the declared envelope. */
class Reader {
    constructor(readonly bytes: Buffer, readonly end: number, public offset = 0) {}

    take(length: number): Buffer {
        if (length < 0 || this.offset + length > this.end) throw BAD;
        if (this.offset + length > this.bytes.length) throw NEED_MORE;
        const result = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    u8(): number { return this.take(1)[0]!; }
    u16(): number { return this.take(2).readUInt16BE(); }
    i16(): number { return this.take(2).readInt16BE(); }
    u32(): number { return this.take(4).readUInt32BE(); }
    i32(): number { return this.take(4).readInt32BE(); }

    variable(): number {
        let value = 0;
        for (let index = 0; index < 4; index++) {
            const byte = this.u8();
            value += (byte & 127) * 2 ** (7 * index);
            expect(value <= MAX_CHANNEL_ENVELOPE_BYTES);
            if (!(byte & 128)) {
                if (index > 0 && byte === 0) throw BAD; // canonical encoding
                return value;
            }
        }
        throw BAD;
    }

    text(length: number, mqtt = false): string {
        expect(length >= 0 && this.offset + length <= this.end);
        const available = this.bytes.subarray(this.offset, this.offset + length);
        const partial = available.length < length;
        let value: string;
        try {
            // An invalid UTF-8 prefix cannot be repaired by later fragments.
            value = partial ? new TextDecoder("utf-8", {fatal: true, ignoreBOM: true})
                .decode(available, {stream: true}) : utf8.decode(available);
        } catch { throw BAD; }
        if (mqtt && /[\u0000\ud800-\udfff\ufdd0-\ufdef\ufffe\uffff]/u.test(value)) throw BAD;
        if (mqtt && [...value].some((character) => (character.codePointAt(0)! & 0xffff) >= 0xfffe)) throw BAD;
        if (partial) throw NEED_MORE;
        this.offset += length;
        return value;
    }

    mqttText(): string { return this.text(this.u16(), true); }
    binary(): Buffer { return this.take(this.u16()); }

    finish(): number {
        if (this.offset !== this.end) throw BAD;
        return this.end;
    }
}

function expect(condition: boolean): void {
    if (!condition) throw BAD;
}

function completeRequest<T>(parse: () => T): T {
    try { return parse(); }
    catch (error) {
        // A response can only be correlated with a complete initial request.
        if (error === NEED_MORE) throw BAD;
        throw error;
    }
}

// MQTT 3.1, 3.1.1 and 5.0 CONNECT/CONNACK, plus MQTT 5 initial enhanced-auth
// AUTH continuation. MQTT-SN and re-authentication as an initial packet are not supported.
// https://public.dhe.ibm.com/software/dw/webservices/ws-mqtt/mqtt-v3r1.html
// https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html
// https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html
interface MqttConnect { version: number; clean: boolean; clientId: string; authMethod?: string }

function mqttPacket(bytes: Buffer, type: number): Reader {
    if (bytes.length === 0) throw NEED_MORE;
    expect(bytes[0] === type);
    const header = new Reader(bytes, MAX_CHANNEL_ENVELOPE_BYTES, 1);
    // Reject a size already known to exceed the cap before its varint completes.
    let remaining = 0;
    for (let index = 0; index < 4; index++) {
        const byte = header.u8();
        remaining += (byte & 127) * 2 ** (7 * index);
        expect(remaining + header.offset <= MAX_CHANNEL_ENVELOPE_BYTES);
        if (!(byte & 128)) {
            expect(index === 0 || byte !== 0);
            return new Reader(bytes, header.offset + remaining, header.offset);
        }
    }
    throw BAD;
}

type MqttProperties = Map<number, string | number>;
function mqttProperties(reader: Reader, kind: "connect" | "will" | "connack" | "auth"): MqttProperties {
    const length = reader.variable();
    expect(reader.offset + length <= reader.end);
    const properties = new Reader(reader.bytes, reader.offset + length, reader.offset);
    const values: MqttProperties = new Map();
    const allowed = kind === "connect" ? [0x11, 0x21, 0x27, 0x22, 0x19, 0x17, 0x26, 0x15, 0x16]
        : kind === "will" ? [0x18, 0x01, 0x02, 0x03, 0x08, 0x09, 0x26]
            : kind === "auth" ? [0x15, 0x16, 0x1f, 0x26]
                : [0x11, 0x21, 0x24, 0x25, 0x27, 0x12, 0x22, 0x1f, 0x26, 0x28, 0x29, 0x2a,
                0x13, 0x1a, 0x1c, 0x15, 0x16];
    while (properties.offset < properties.end) {
        const id = properties.variable();
        expect(allowed.includes(id) && (id === 0x26 || !values.has(id)));
        let value: string | number = 0;
        if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) {
            value = properties.u8();
            expect(value <= 1);
        } else if ([0x21, 0x22, 0x13].includes(id)) {
            value = properties.u16();
            expect(id !== 0x21 || value !== 0);
        } else if ([0x11, 0x18, 0x02, 0x27].includes(id)) {
            value = properties.u32();
            expect(id !== 0x27 || value !== 0);
        } else if ([0x16, 0x09].includes(id)) {
            properties.binary();
        } else if (id === 0x26) {
            properties.mqttText();
            properties.mqttText();
        } else {
            value = properties.mqttText();
            if ([0x08, 0x12, 0x15].includes(id)) expect(value.length > 0);
            if (id === 0x08) expect(!/[+#]/.test(value));
        }
        values.set(id, value);
    }
    reader.offset = properties.finish();
    if (kind === "connect") expect(!values.has(0x16) || values.has(0x15));
    return values;
}

function mqttConnect(bytes: Buffer): {length: number; connect: MqttConnect} {
    const reader = mqttPacket(bytes, 0x10);
    expect(reader.end - reader.offset >= 12);
    // Validate the literal protocol name progressively, not only after its tail arrives.
    expect(reader.u8() === 0);
    const nameLength = reader.u8();
    expect(nameLength === 4 || nameLength === 6);
    const name = Buffer.from(nameLength === 4 ? "MQTT" : "MQIsdp");
    for (const byte of name) expect(reader.u8() === byte);
    const version = reader.u8();
    expect(nameLength === 6 ? version === 3 : version === 4 || version === 5);
    const flags = reader.u8();
    const clean = !!(flags & 2);
    const will = !!(flags & 4);
    const willQos = (flags >> 3) & 3;
    expect(!(flags & 1) && willQos !== 3 && (will || !(flags & 0x38)));
    if (version !== 5) expect(!(flags & 0x40) || !!(flags & 0x80));
    reader.u16(); // Keep Alive can be zero.
    const properties: MqttProperties = version === 5 ? mqttProperties(reader, "connect") : new Map();
    const clientId = reader.mqttText();
    if (version === 3) expect(clientId.length > 0 && [...clientId].length <= 23);
    if (version === 4) expect(clientId.length > 0 || clean);
    if (will) {
        if (version === 5) mqttProperties(reader, "will");
        const topic = reader.mqttText();
        expect(topic.length > 0 && !/[+#]/.test(topic));
        reader.binary(); // A binary Will payload may contain LF (or arbitrary bytes).
    }
    if (flags & 0x80) reader.mqttText();
    if (flags & 0x40) reader.binary();
    const authMethod = properties.get(0x15);
    return {length: reader.finish(), connect: {version, clean, clientId,
        authMethod: typeof authMethod === "string" ? authMethod : undefined}};
}

function mqttConnack(bytes: Buffer, request?: Buffer): number {
    if (!request) throw BAD;
    const {connect} = completeRequest(() => mqttConnect(request));
    if (bytes[0] === 0xf0 && connect.version === 5) return mqttInitialAuth(bytes, connect);
    const reader = mqttPacket(bytes, 0x20);
    expect(connect.version === 5 ? reader.end - reader.offset >= 3 : reader.end - reader.offset === 2);
    const flags = reader.u8();
    expect(flags <= 1 && (flags === 0 || !connect.clean));
    const reason = reader.u8();
    expect(reason === 0 || flags === 0);
    if (connect.version === 3) expect(flags === 0);
    if (connect.version !== 5) {
        expect(reason <= 5);
    } else {
        expect([0, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8a, 0x8c, 0x90, 0x95, 0x97, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9f].includes(reason));
        const properties = mqttProperties(reader, "connack");
        if (properties.has(0x12)) expect(connect.clientId.length === 0);
        if (reason === 0 && connect.clientId.length === 0) expect(properties.has(0x12));
        if (properties.has(0x15)) expect(properties.get(0x15) === connect.authMethod);
        if (reason === 0 && connect.authMethod !== undefined) expect(properties.has(0x15));
        if (properties.has(0x16)) expect(connect.authMethod !== undefined);
    }
    return reader.finish();
}

function mqttInitialAuth(bytes: Buffer, connect: MqttConnect): number {
    expect(connect.authMethod !== undefined);
    const reader = mqttPacket(bytes, 0xf0);
    // Initial enhanced authentication is continued by the server using 0x18;
    // successful initial authentication concludes with CONNACK, not AUTH 0x00.
    // Require the method on this first confirmation to identify the negotiation.
    expect(reader.u8() === 0x18);
    const properties = mqttProperties(reader, "auth");
    expect(properties.get(0x15) === connect.authMethod);
    // A confirmed AUTH admits the entire channel, including remaining auth rounds.
    return reader.finish();
}

// AMQP protocol headers: 0-9-1, 1.0 and 1.0 SASL (protocol id 3).
// A 0-9-1 server confirms with connection.start, not an echoed protocol header.
// https://www.rabbitmq.com/resources/specs/amqp0-9-1.pdf
// https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-transport-v1.0-os.html#doc-idp285936
// https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-security-v1.0-os.html#doc-idp51312
const amqpHeaders = [Buffer.from([65, 77, 81, 80, 0, 0, 9, 1]),
    Buffer.from([65, 77, 81, 80, 0, 1, 0, 0]), Buffer.from([65, 77, 81, 80, 3, 1, 0, 0])];

function amqpHeader(bytes: Buffer): number {
    expect(amqpHeaders.some((header) => bytes.subarray(0, Math.min(8, bytes.length))
        .equals(header.subarray(0, Math.min(8, bytes.length)))));
    if (bytes.length < 8) throw NEED_MORE;
    return 8;
}

function amqpLong(reader: Reader): Buffer { return reader.take(reader.u32()); }

function amqpFields(reader: Reader, table: boolean, depth = 0): void {
    expect(depth <= 16);
    const length = reader.u32();
    expect(reader.offset + length <= reader.end);
    const fields = new Reader(reader.bytes, reader.offset + length, reader.offset);
    while (fields.offset < fields.end) {
        if (table) {
            const key = fields.text(fields.u8());
            expect(key.length > 0 && !key.includes("\0"));
        }
        const tag = String.fromCharCode(fields.u8());
        if (tag === "t") expect(fields.u8() <= 1);
        else if (tag === "b" || tag === "B") fields.take(1);
        else if (["s", "U", "u"].includes(tag)) fields.take(2);
        else if (["I", "i", "f"].includes(tag)) fields.take(4);
        else if (["l", "L", "d", "T"].includes(tag)) fields.take(8);
        else if (tag === "D") fields.take(5);
        else if (tag === "S" || tag === "x") amqpLong(fields);
        else if (tag === "F" || tag === "A") amqpFields(fields, tag === "F", depth + 1);
        else expect(tag === "V");
    }
    reader.offset = fields.finish();
}

function amqpServer(bytes: Buffer, request?: Buffer): number {
    if (request) completeRequest(() => amqpHeader(request));
    // A supported protocol header is independently distinctive, including a
    // version/SASL negotiation counter-offer. TLS protocol id 2 is not supported.
    if (!request || !request.subarray(0, 8).equals(amqpHeaders[0]!)) return amqpHeader(bytes);
    if (bytes.length === 0) throw NEED_MORE;
    if (bytes[0] === 65) return amqpHeader(bytes);
    const header = new Reader(bytes, MAX_CHANNEL_ENVELOPE_BYTES);
    expect(header.u8() === 1); // METHOD frame
    expect(header.u8() === 0 && header.u8() === 0); // connection channel
    const size = header.u32();
    expect(size >= 20 && size + 8 <= MAX_CHANNEL_ENVELOPE_BYTES);
    const reader = new Reader(bytes, 7 + size, 7);
    // class-id, method-id, version-major and version-minor, byte by byte.
    for (const byte of [0, 10, 0, 10, 0, 9]) expect(reader.u8() === byte);
    amqpFields(reader, true);
    const mechanisms = amqpLong(reader).toString("latin1");
    const locales = amqpLong(reader).toString("latin1");
    expect(/^[A-Z0-9_-]+(?: [A-Z0-9_-]+)*$/.test(mechanisms));
    expect(/^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/.test(locales));
    reader.finish();
    const terminator = new Reader(bytes, reader.end + 1, reader.end);
    expect(terminator.u8() === 0xce);
    return terminator.finish();
}

// Kafka initial negotiations: ApiVersions v0-v4 (v3/v4 are flexible), Metadata
// v0-v1, and SaslHandshake v0-v1. SaslAuthenticate is not an initial negotiation.
// Tagged fields are size-bounded, ordered and unique; unknown extension tags are
// skipped, while known ApiVersions feature tags are structurally validated.
// https://kafka.apache.org/protocol.html#protocol_messages
// https://kafka.apache.org/protocol.html#The_Messages_ApiVersions
// https://kafka.apache.org/protocol.html#The_Messages_Metadata
// https://kafka.apache.org/protocol.html#The_Messages_SaslHandshake
interface KafkaRequest { api: number; version: number; correlation: number; length: number }

function kafkaFrame(bytes: Buffer): Reader {
    for (let index = 0; index < Math.min(bytes.length, 4); index++) {
        // Minimum possible value of this partial big-endian signed length.
        const minimum = bytes.subarray(0, index + 1).reduce((n, byte) => n * 256 + byte, 0)
            * 256 ** (3 - index);
        expect(minimum <= MAX_CHANNEL_ENVELOPE_BYTES - 4);
    }
    if (bytes.length < 4) throw NEED_MORE;
    const length = bytes.readInt32BE();
    expect(length >= 0 && length <= MAX_CHANNEL_ENVELOPE_BYTES - 4);
    return new Reader(bytes, length + 4, 4);
}

function kafkaString(reader: Reader, nullable = false): string | null {
    const length = reader.i16();
    if (length === -1 && nullable) return null;
    expect(length >= 0);
    return reader.text(length);
}

function kafkaArray(reader: Reader, minimumItemBytes: number, item: () => void, nullable = false): void {
    const count = reader.i32();
    if (count === -1 && nullable) return;
    expect(count >= 0 && count <= Math.floor((reader.end - reader.offset) / minimumItemBytes));
    for (let index = 0; index < count; index++) item();
}

function kafkaMechanism(reader: Reader): void {
    expect(/^[A-Z0-9_-]+$/.test(kafkaString(reader)!));
}

function kafkaUnsigned(reader: Reader, maximum = 0xffffffff): number {
    let value = 0;
    for (let index = 0; index < 5; index++) {
        const byte = reader.u8();
        value += (byte & 127) * 2 ** (7 * index);
        expect(value <= maximum);
        if (!(byte & 128)) {
            expect(index === 0 || byte !== 0);
            return value;
        }
    }
    throw BAD;
}

function kafkaCompactString(reader: Reader): string {
    const length = kafkaUnsigned(reader, MAX_CHANNEL_ENVELOPE_BYTES + 1);
    expect(length > 0); // non-nullable compact string
    return reader.text(length - 1);
}

function kafkaCompactArray(reader: Reader, minimumItemBytes: number, item: () => void): void {
    const count = kafkaUnsigned(reader, MAX_CHANNEL_ENVELOPE_BYTES + 1) - 1;
    expect(count >= 0 && count <= Math.floor((reader.end - reader.offset) / minimumItemBytes));
    for (let index = 0; index < count; index++) item();
}

function kafkaTags(reader: Reader, known?: (tag: number, field: Reader) => boolean): void {
    const count = kafkaUnsigned(reader, MAX_CHANNEL_ENVELOPE_BYTES);
    expect(count <= Math.floor((reader.end - reader.offset) / 2));
    let previous = -1;
    for (let index = 0; index < count; index++) {
        const tag = kafkaUnsigned(reader);
        expect(tag > previous);
        previous = tag;
        const size = kafkaUnsigned(reader, MAX_CHANNEL_ENVELOPE_BYTES);
        expect(reader.offset + size <= reader.end);
        const field = new Reader(reader.bytes, reader.offset + size, reader.offset);
        if (!known?.(tag, field)) field.take(size);
        reader.offset = field.finish();
    }
}

function kafkaFeatureTag(tag: number, field: Reader): boolean {
    if (tag === 0 || tag === 2) {
        kafkaCompactArray(field, 6, () => {
            expect(kafkaCompactString(field).length > 0);
            const first = field.i16();
            const second = field.i16();
            // SupportedFeatures uses min/max; FinalizedFeatures uses max/min.
            const min = tag === 0 ? first : second;
            const max = tag === 0 ? second : first;
            expect(min >= 0 && max >= min);
            kafkaTags(field);
        });
    } else if (tag === 1) expect(field.take(8).readBigInt64BE() >= -1n);
    else if (tag === 3) expect(field.u8() <= 1);
    else return false;
    return true;
}

function kafkaApiVersions(reader: Reader, version: number): void {
    const error = reader.i16();
    expect(error >= -1);
    // ApiVersions uniquely keeps response header v0 even for flexible versions.
    // Older brokers can answer any unsupported version using the v0 body.
    const downgrade = version >= 3 && error === 35 && reader.bytes[reader.offset] === 0;
    const flexible = version >= 3 && !downgrade;
    const keys = new Set<number>();
    const entry = () => {
        const key = reader.i16();
        const min = reader.i16();
        const max = reader.i16();
        expect(key >= 0 && min >= 0 && max >= min && !keys.has(key));
        keys.add(key);
        if (flexible) kafkaTags(reader);
    };
    if (flexible) kafkaCompactArray(reader, 7, entry);
    else kafkaArray(reader, 6, entry);
    // v1/v2 otherwise share v0's array schema. Only UNSUPPORTED_VERSION
    // permits the throttle field to be absent, with no unconsumed body bytes.
    const v0Rejection = version <= 2 && error === 35 && reader.offset === reader.end;
    if (version >= 1 && !downgrade && !v0Rejection) expect(reader.i32() >= 0);
    if (flexible) kafkaTags(reader, kafkaFeatureTag);
}

function kafkaRequest(bytes: Buffer): KafkaRequest {
    const reader = kafkaFrame(bytes);
    expect(reader.end >= 14); // fixed v1 header, including a nullable client_id
    expect(reader.u8() === 0);
    const api = reader.u8();
    expect([3, 17, 18].includes(api));
    expect(reader.u8() === 0);
    const version = reader.u8();
    expect(version >= 0 && version <= (api === 18 ? 4 : 1));
    const correlation = reader.i32();
    kafkaString(reader, true); // client_id remains a classic nullable string
    if (api === 18 && version >= 3) {
        kafkaTags(reader); // request header v2
        expect(kafkaCompactString(reader).length > 0); // client_software_name
        expect(kafkaCompactString(reader).length > 0); // client_software_version
        kafkaTags(reader);
    } else if (api === 3) {
        kafkaArray(reader, 2, () => { expect(kafkaString(reader)!.length > 0); }, version >= 1);
    } else if (api === 17) kafkaMechanism(reader);
    return {api, version, correlation, length: reader.finish()};
}

function kafkaResponse(bytes: Buffer, request?: Buffer): number {
    if (!request) throw BAD;
    const initial = completeRequest(() => kafkaRequest(request));
    const reader = kafkaFrame(bytes);
    expect(reader.end >= (initial.api === 3 ? 16 : 14));
    const correlation = Buffer.alloc(4);
    correlation.writeInt32BE(initial.correlation);
    for (const byte of correlation) expect(reader.u8() === byte);
    const errorCode = () => { expect(reader.i16() >= -1); };
    if (initial.api === 18) {
        kafkaApiVersions(reader, initial.version);
    } else if (initial.api === 17) {
        errorCode();
        kafkaArray(reader, 2, () => kafkaMechanism(reader));
    } else {
        kafkaArray(reader, initial.version === 0 ? 10 : 12, () => {
            expect(reader.i32() >= 0); // broker node_id
            expect(kafkaString(reader)!.length > 0);
            const port = reader.i32();
            expect(port > 0 && port <= 65535);
            if (initial.version >= 1) kafkaString(reader, true); // rack
        });
        if (initial.version >= 1) expect(reader.i32() >= -1); // controller_id
        kafkaArray(reader, initial.version === 0 ? 8 : 9, () => {
            errorCode();
            expect(kafkaString(reader)!.length > 0);
            if (initial.version >= 1) expect(reader.u8() <= 1); // is_internal
            kafkaArray(reader, 18, () => {
                errorCode();
                expect(reader.i32() >= 0); // partition_index
                expect(reader.i32() >= -1); // leader_id
                kafkaArray(reader, 4, () => { expect(reader.i32() >= 0); });
                kafkaArray(reader, 4, () => { expect(reader.i32() >= 0); });
            });
        });
    }
    return reader.finish();
}

// NATS is server-first; operation names are case-insensitive. Recognizes a
// single CRLF-terminated INFO control line with modern server_id, version, go,
// host, port, proto (0 or 1), and max_payload fields. JSON escapes may encode
// newlines, but raw CR/LF within its JSON/whitespace are not protocol framing.
// https://docs.nats.io/reference/reference-protocols/nats-protocol#info
const natsPrefix = Buffer.from("info");
function natsInfo(bytes: Buffer): number {
    for (let index = 0; index < Math.min(bytes.length, 4); index++) {
        expect((bytes[index]! | 0x20) === natsPrefix[index]);
    }
    if (bytes.length < 5) throw NEED_MORE;
    expect(bytes[4] === 0x20);
    const bounded = bytes.subarray(0, MAX_CHANNEL_ENVELOPE_BYTES);
    let start = 5;
    while (bounded[start] === 0x20 || bounded[start] === 0x09) start++;
    if (start < bounded.length) expect(bounded[start] === 0x7b);
    // Native searches avoid allocating a Buffer view per byte and parsing JSON
    // again for every small fragment. Only the completed control line is decoded.
    const newline = bounded.indexOf(0x0a, 5);
    const carriage = bounded.indexOf(0x0d, 5);
    if (newline < 0) {
        expect(carriage < 0 || carriage === bounded.length - 1);
        expect(bytes.length < MAX_CHANNEL_ENVELOPE_BYTES);
        throw NEED_MORE;
    }
    expect(carriage === newline - 1);
    let info: unknown;
    try { info = JSON.parse(utf8.decode(bounded.subarray(5, carriage))); }
    catch { throw BAD; }
    expect(validNatsInfo(info));
    return newline + 1;
}

function validNatsInfo(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const info = value as Record<string, unknown>;
    for (const field of ["server_id", "version", "go", "host"]) {
        if (typeof info[field] !== "string" || !info[field] || /[\s\x00]/.test(info[field])) return false;
    }
    if (typeof info.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(info.version)) return false;
    if (info.proto !== 0 && info.proto !== 1) return false;
    if (!Number.isSafeInteger(info.port) || Number(info.port) < 1 || Number(info.port) > 65535) return false;
    if (!Number.isSafeInteger(info.max_payload) || Number(info.max_payload) < 1) return false;
    for (const field of ["auth_required", "tls_required", "tls_verify", "headers", "jetstream", "ldm", "tls_available"]) {
        if (field in info && typeof info[field] !== "boolean") return false;
    }
    for (const field of ["server_name", "nonce", "ip", "client_ip", "cluster", "domain"]) {
        if (field in info && typeof info[field] !== "string") return false;
    }
    for (const field of ["connect_urls", "ws_connect_urls"]) {
        if (field in info && (!Array.isArray(info[field])
            || !info[field].every((url: unknown) => typeof url === "string" && url.length > 0))) return false;
    }
    if ("client_id" in info && (!Number.isSafeInteger(info.client_id) || Number(info.client_id) < 0)) return false;
    return true;
}

export const messagingProtocols: readonly ChannelProtocolDefinition[] = [
    {
        protocol: NetworkApplicationProtocol.MQTT,
        initiation: "client",
        inspectClient: (bytes) => probe(() => mqttConnect(bytes).length),
        inspectServer: (bytes, request) => probe(() => mqttConnack(bytes, request)),
    },
    {
        protocol: NetworkApplicationProtocol.AMQP,
        initiation: "client",
        inspectClient: (bytes) => probe(() => amqpHeader(bytes)),
        inspectServer: (bytes, request) => probe(() => amqpServer(bytes, request)),
    },
    {
        protocol: NetworkApplicationProtocol.KAFKA,
        initiation: "client",
        inspectClient: (bytes) => probe(() => kafkaRequest(bytes).length),
        inspectServer: (bytes, request) => probe(() => kafkaResponse(bytes, request)),
    },
    {
        protocol: NetworkApplicationProtocol.NATS,
        initiation: "server",
        inspectClient: () => INVALID,
        inspectServer: (bytes) => probe(() => natsInfo(bytes)),
    },
];
