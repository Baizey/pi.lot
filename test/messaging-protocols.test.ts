import assert from "node:assert/strict";
import {test} from "node:test";
import {MAX_CHANNEL_ENVELOPE_BYTES, type ChannelProbe} from "../src/policy/network/ChannelProtocol.js";
import {messagingProtocols} from "../src/policy/network/MessagingProtocols.js";
import {NetworkApplicationProtocol} from "../src/policy/network/NetworkProtocol.js";

function definition(protocol: NetworkApplicationProtocol) {
    const result = messagingProtocols.find((entry) => entry.protocol === protocol);
    assert.ok(result);
    return result;
}
const mqtt = definition(NetworkApplicationProtocol.MQTT);
const amqp = definition(NetworkApplicationProtocol.AMQP);
const kafka = definition(NetworkApplicationProtocol.KAFKA);
const nats = definition(NetworkApplicationProtocol.NATS);

function u16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function i16(value: number): Buffer { const b = Buffer.alloc(2); b.writeInt16BE(value); return b; }
function i32(value: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }
function text(value: string): Buffer { const b = Buffer.from(value); return Buffer.concat([u16(b.length), b]); }
function variable(value: number): Buffer {
    const bytes: number[] = [];
    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) byte |= 128;
        bytes.push(byte);
    } while (value > 0);
    return Buffer.from(bytes);
}
function packet(type: number, ...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([type]), variable(body.length), body]);
}
function connect(version = 4, flags = 2, payload: Buffer = text("unit-client"), properties: Buffer = Buffer.from([0])): Buffer {
    return packet(0x10, text(version === 3 ? "MQIsdp" : "MQTT"), Buffer.from([version, flags]),
        u16(60), version === 5 ? properties : Buffer.alloc(0), payload);
}
function connack(version = 4, flags = 0, reason = 0, properties: Buffer = Buffer.from([0])): Buffer {
    return packet(0x20, Buffer.from([flags, reason]), version === 5 ? properties : Buffer.alloc(0));
}
function properties(...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    return Buffer.concat([variable(body.length), body]);
}

function completeAndFragmented(inspect: (bytes: Buffer) => ChannelProbe, envelope: Buffer): void {
    for (let length = 0; length < envelope.length; length++) {
        assert.deepEqual(inspect(envelope.subarray(0, length)), {status: "incomplete"}, `prefix ${length}/${envelope.length}`);
    }
    assert.deepEqual(inspect(envelope), {status: "match", length: envelope.length});
    assert.deepEqual(inspect(Buffer.concat([envelope, Buffer.from("\nopaque continuation\0")])),
        {status: "match", length: envelope.length});
}
function invalid(inspect: (bytes: Buffer) => ChannelProbe, ...frames: Buffer[]): void {
    for (const frame of frames) assert.deepEqual(inspect(frame), {status: "invalid"}, frame.toString("hex"));
}

test("MQTT CONNECT/CONNACK 3.1, 3.1.1 and 5.0, including binary payloads and properties", () => {
    assert.equal(mqtt.initiation, "client");
    for (const version of [3, 4, 5]) {
        const request = connect(version);
        completeAndFragmented(mqtt.inspectClient, request);
        completeAndFragmented((bytes) => mqtt.inspectServer(bytes, request), connack(version));
        completeAndFragmented((bytes) => mqtt.inspectServer(bytes, request), connack(version, 0, version === 5 ? 0x87 : 5));
    }
    const will = Buffer.concat([text("will-client"), text("events/unit"), u16(4), Buffer.from([0, 10, 255, 13]),
        text("username"), u16(3), Buffer.from([10, 0, 255])]);
    completeAndFragmented(mqtt.inspectClient, connect(4, 0xce, will));
    const props = properties(Buffer.from([0x11]), i32(300), Buffer.from([0x21]), u16(10),
        Buffer.from([0x26]), text("name"), text("value"), Buffer.from([0x26]), text("name"), text("other"),
        Buffer.from([0x15]), text("SCRAM-SHA-256"), Buffer.from([0x16]), u16(2), Buffer.from([10, 0]));
    const request = connect(5, 2, text(""), props);
    completeAndFragmented(mqtt.inspectClient, request);
    const response = connack(5, 0, 0, properties(Buffer.from([0x15]), text("SCRAM-SHA-256"),
        Buffer.from([0x16]), u16(2), Buffer.from([10, 255]), Buffer.from([0x12]), text("assigned-client")));
    completeAndFragmented((bytes) => mqtt.inspectServer(bytes, request), response);
    const willProps = properties(Buffer.from([0x18]), i32(60), Buffer.from([0x01, 1]),
        Buffer.from([0x08]), text("reply/topic"), Buffer.from([0x09]), u16(1), Buffer.from([10]));
    completeAndFragmented(mqtt.inspectClient, connect(5, 6, Buffer.concat([text("id"), willProps,
        text("events"), u16(2), Buffer.from([10, 0])])));
    // MQTT 5 permits a Password without a User Name; 3.1.1 does not.
    completeAndFragmented(mqtt.inspectClient, connect(5, 0x42, Buffer.concat([text("id"), u16(1), Buffer.from([10])])));
    completeAndFragmented(mqtt.inspectClient, connect(4, 2, text("π🚀")));
});

test("MQTT rejects contradictory headers, flags, lengths, invalid UTF-8 and property schemas", () => {
    invalid(mqtt.inspectClient,
        Buffer.from([0x11]), Buffer.from([0x10, 0]), Buffer.from([0x10, 0x80, 0]),
        Buffer.from([0x10, 0xff, 0xff, 0xff]), Buffer.from([0x10, 12, 1]),
        packet(0x10, text("HTTP"), Buffer.from([4, 2]), u16(0), text("id")),
        connect(2), connect(4, 3), connect(4, 0x1e), connect(4, 0x22), connect(4, 0x42),
        connect(4, 0, text("")), connect(3, 2, text("a".repeat(24))),
        connect(4, 2, Buffer.from([0, 1, 0])), connect(4, 2, Buffer.from([0, 2, 0xc0, 0x80])),
        connect(4, 6, Buffer.concat([text("id"), text("bad/+"), u16(0)])),
        connect(5, 2, text("id"), properties(Buffer.from([0x21]), u16(0))),
        connect(5, 2, text("id"), properties(Buffer.from([0x27]), i32(0))),
        connect(5, 2, text("id"), properties(Buffer.from([0x19, 2]))),
        connect(5, 2, text("id"), properties(Buffer.from([0x11]), i32(1), Buffer.from([0x11]), i32(2))),
        connect(5, 2, text("id"), properties(Buffer.from([0x16]), u16(0))),
        connect(5, 2, text("id"), properties(Buffer.from([0x7f]))),
        packet(0x10, text("MQTT"), Buffer.from([4, 2]), u16(0), u16(0xffff)));
    const excess = Buffer.concat([connect(), Buffer.from([0])]);
    // Increasing the declared length makes the extra byte an invalid part of CONNECT.
    excess[1] = excess[1]! + 1;
    invalid(mqtt.inspectClient, excess);
    const badUtf8 = connect(4, 2, Buffer.from([0, 4, 0xff, 97, 98, 99]));
    invalid(mqtt.inspectClient, badUtf8.subarray(0, -3));
});

test("MQTT CONNACK requires its CONNECT version and respects session/authentication context", () => {
    invalid((bytes) => mqtt.inspectServer(bytes), connack(), connack(5));
    const request = connect();
    invalid((bytes) => mqtt.inspectServer(bytes, request),
        connack(4, 1), connack(4, 2), connack(4, 0, 6), connack(5), Buffer.from([0x20, 3]));
    const persistent = connect(4, 0);
    completeAndFragmented((bytes) => mqtt.inspectServer(bytes, persistent), connack(4, 1));
    invalid((bytes) => mqtt.inspectServer(bytes, persistent), connack(4, 1, 1));
    invalid((bytes) => mqtt.inspectServer(bytes, connect(3, 0)), connack(3, 1));
    invalid((bytes) => mqtt.inspectServer(bytes, connect(5)), connack(5, 0, 1),
        connack(5, 0, 0, properties(Buffer.from([0x15]), text("unexpected"))),
        connack(5, 0, 0, properties(Buffer.from([0x16]), u16(0))),
        connack(5, 0, 0, properties(Buffer.from([0x24, 2]))));
    invalid((bytes) => mqtt.inspectServer(bytes, Buffer.from("invalid")), connack());
    invalid((bytes) => mqtt.inspectServer(bytes, request.subarray(0, -1)), connack());
    invalid((bytes) => mqtt.inspectServer(bytes, connect(5, 2, text(""))), connack(5));
    invalid((bytes) => mqtt.inspectServer(bytes, connect(5)),
        connack(5, 0, 0, properties(Buffer.from([0x12]), text("cannot-replace-client-id"))));
});

test("MQTT 5 initial enhanced AUTH confirms its CONNECT method; successful CONNACK retains context", () => {
    const request = Buffer.from("101e00044d5154540502003c1015000d534352414d2d5348412d323536000178", "hex");
    const auth = Buffer.from("f012181015000d534352414d2d5348412d323536", "hex");
    completeAndFragmented(mqtt.inspectClient, request);
    completeAndFragmented((bytes) => mqtt.inspectServer(bytes, request), auth);
    const method = properties(Buffer.from([0x15]), text("SCRAM-SHA-256"));
    const inspect = (bytes: Buffer) => mqtt.inspectServer(bytes, request);
    completeAndFragmented(inspect, connack(5, 0, 0, method));
    completeAndFragmented(inspect, packet(0xf0, Buffer.from([0x18]), properties(Buffer.from([0x15]),
        text("SCRAM-SHA-256"), Buffer.from([0x16]), u16(3), Buffer.from([10, 0, 255]))));
    // A failure can end authentication without reporting a successful method.
    completeAndFragmented(inspect, connack(5, 0, 0x87));
    invalid(inspect, connack(5), connack(5, 0, 0, properties(Buffer.from([0x15]), text("wrong"))),
        packet(0xf0, Buffer.from([0x18]), properties(Buffer.from([0x15]), text("wrong"))),
        packet(0xf0, Buffer.from([0x18]), properties()),
        packet(0xf0, Buffer.from([0]), method), packet(0xf0, Buffer.from([0x19]), method),
        packet(0xf0, Buffer.from([0x18]), properties(Buffer.from([0x15]), text("SCRAM-SHA-256"),
            Buffer.from([0x15]), text("SCRAM-SHA-256"))),
        packet(0xf0, Buffer.from([0x18]), properties(Buffer.from([0x21]), u16(10))),
        Buffer.from([0xf0, 0]), Buffer.from([0xf1]));
    invalid((bytes) => mqtt.inspectServer(bytes), auth);
    invalid((bytes) => mqtt.inspectServer(bytes, connect(5)), auth);
    invalid((bytes) => mqtt.inspectServer(bytes, connect(4)), auth);
    const emptyId = Buffer.from("100d00044d5154540502003c000000", "hex");
    completeAndFragmented(mqtt.inspectClient, emptyId);
    invalid((bytes) => mqtt.inspectServer(bytes, emptyId), Buffer.from("2003000000", "hex"),
        connack(5, 0, 0, properties(Buffer.from([0x12]), text(""))));
    completeAndFragmented((bytes) => mqtt.inspectServer(bytes, emptyId),
        connack(5, 0, 0, properties(Buffer.from([0x12]), text("assigned-client"))));
});

test("MQTT declared length cap includes fixed and variable headers", () => {
    // Construct a maximum-sized CONNECT with a binary Password, not a line parser.
    const prefix = Buffer.concat([text("MQTT"), Buffer.from([4, 0xc2]), u16(0), text("id"), text("u")]);
    const password = Buffer.alloc(MAX_CHANNEL_ENVELOPE_BYTES - 4 - prefix.length - 2, 10);
    const frame = packet(0x10, prefix, u16(password.length), password);
    assert.equal(frame.length, MAX_CHANNEL_ENVELOPE_BYTES);
    assert.deepEqual(mqtt.inspectClient(frame.subarray(0, -1)), {status: "incomplete"});
    assert.deepEqual(mqtt.inspectClient(frame), {status: "match", length: frame.length});
    invalid(mqtt.inspectClient, Buffer.concat([Buffer.from([0x10]), variable(65536)]));
});

const amqp091 = Buffer.from([65, 77, 81, 80, 0, 0, 9, 1]);
const amqp10 = Buffer.from([65, 77, 81, 80, 0, 1, 0, 0]);
const amqpSasl = Buffer.from([65, 77, 81, 80, 3, 1, 0, 0]);
function long(value: Buffer): Buffer { return Buffer.concat([i32(value.length), value]); }
function startFrame(fields: Buffer = Buffer.alloc(0), mechanisms: Buffer = Buffer.from("PLAIN AMQPLAIN")): Buffer {
    const body = Buffer.concat([u16(10), u16(10), Buffer.from([0, 9]), long(fields),
        long(mechanisms), long(Buffer.from("en_US"))]);
    return Buffer.concat([Buffer.from([1]), u16(0), i32(body.length), body, Buffer.from([0xce])]);
}

test("AMQP exact protocol headers, 1.0 SASL header exchange and 0-9-1 connection.start", () => {
    assert.equal(amqp.initiation, "client");
    for (const header of [amqp091, amqp10, amqpSasl]) {
        completeAndFragmented(amqp.inspectClient, header);
        completeAndFragmented((bytes) => amqp.inspectServer(bytes, header), header);
        completeAndFragmented((bytes) => amqp.inspectServer(bytes), header);
    }
    // RabbitMQ-style nested capabilities table and a binary long string with LF.
    const capabilities = Buffer.concat([Buffer.from([7]), Buffer.from("confirm"), Buffer.from("t"), Buffer.from([1])]);
    const fields = Buffer.concat([Buffer.from([12]), Buffer.from("capabilities"), Buffer.from("F"), long(capabilities),
        Buffer.from([7]), Buffer.from("product"), Buffer.from("S"), long(Buffer.from("server\nbinary"))]);
    completeAndFragmented((bytes) => amqp.inspectServer(bytes, amqp091), startFrame(fields));
    invalid((bytes) => amqp.inspectServer(bytes), startFrame());
    invalid((bytes) => amqp.inspectServer(bytes, amqp10), startFrame());
    invalid((bytes) => amqp.inspectServer(bytes, amqp10.subarray(0, 7)), amqp10);
});

test("AMQP rejects invalid protocol revisions, frame fields, nested tables and declared sizes", () => {
    invalid(amqp.inspectClient, Buffer.from("HTTP"), Buffer.from("AMQP\x02"),
        Buffer.from([65, 77, 81, 80, 0, 0, 9, 2]), Buffer.from([65, 77, 81, 80, 3, 1, 0, 1]));
    const inspect = (bytes: Buffer) => amqp.inspectServer(bytes, amqp091);
    const badType = startFrame(); badType[0] = 2;
    const badChannel = startFrame(); badChannel[2] = 1;
    const badMethod = startFrame(); badMethod[10] = 11;
    const badVersion = startFrame(); badVersion[12] = 8;
    const badEnd = startFrame(); badEnd[badEnd.length - 1] = 0;
    invalid(inspect, badType, badChannel, badMethod, badVersion, badEnd,
        Buffer.concat([Buffer.from([1, 0, 0]), i32(65532)]),
        Buffer.concat([Buffer.from([1, 0, 0]), i32(0)]),
        startFrame(Buffer.from([1, 120, 0x3f])),
        startFrame(Buffer.from([1, 120, 0x74, 2])),
        startFrame(Buffer.concat([Buffer.from([1, 120, 0x46]), i32(65535)])),
        startFrame(Buffer.alloc(0), Buffer.from([0xd0, 0x4c, 0x41, 0x49, 0x4e])),
        startFrame(Buffer.alloc(0), Buffer.alloc(0)));
});

function kafkaFrame(body: Buffer): Buffer { return Buffer.concat([i32(body.length), body]); }
function compactText(value: string): Buffer {
    const bytes = Buffer.from(value);
    return Buffer.concat([variable(bytes.length + 1), bytes]);
}
function compactArray(...items: Buffer[]): Buffer { return Buffer.concat([variable(items.length + 1), ...items]); }
function tags(...entries: [number, Buffer][]): Buffer {
    return Buffer.concat([variable(entries.length), ...entries.flatMap(([tag, value]) =>
        [variable(tag), variable(value.length), value])]);
}
function kafkaRequest(api: number, version: number, body?: Buffer, correlation = 0x0102030a): Buffer {
    const flexible = api === 18 && version >= 3;
    const content = body ?? (flexible ? Buffer.concat([compactText("librdkafka"), compactText("1.0"), tags()]) : Buffer.alloc(0));
    return kafkaFrame(Buffer.concat([i16(api), i16(version), i32(correlation), text("unit\nclient"),
        flexible ? tags() : Buffer.alloc(0), content]));
}
function kafkaResponse(body: Buffer, correlation = 0x0102030a): Buffer {
    return kafkaFrame(Buffer.concat([i32(correlation), body]));
}
function array(...items: Buffer[]): Buffer { return Buffer.concat([i32(items.length), ...items]); }
function apiVersions(version: number): Buffer {
    const entry = (key: number, max: number) => Buffer.concat([i16(key), i16(0), i16(max),
        version >= 3 ? tags() : Buffer.alloc(0)]);
    const entries = version >= 3 ? compactArray(entry(3, 12), entry(18, 4)) : array(entry(3, 12), entry(18, 4));
    return kafkaResponse(Buffer.concat([i16(0), entries, version >= 1 ? i32(0) : Buffer.alloc(0),
        version >= 3 ? tags() : Buffer.alloc(0)]));
}
function metadata(version: number): Buffer {
    const broker = Buffer.concat([i32(1), text("broker.local"), i32(9092), version === 1 ? i16(-1) : Buffer.alloc(0)]);
    const partition = Buffer.concat([i16(0), i32(0), i32(1), array(i32(1)), array(i32(1))]);
    const topic = Buffer.concat([i16(0), text("events"), version === 1 ? Buffer.from([0]) : Buffer.alloc(0), array(partition)]);
    return kafkaResponse(Buffer.concat([array(broker), version === 1 ? i32(1) : Buffer.alloc(0), array(topic)]));
}

test("Kafka bounded ApiVersions v0-v4, Metadata v0-v1 and SaslHandshake v0-v1", () => {
    assert.equal(kafka.initiation, "client");
    for (const version of [0, 1, 2, 3, 4]) {
        const request = kafkaRequest(18, version);
        completeAndFragmented(kafka.inspectClient, request);
        completeAndFragmented((bytes) => kafka.inspectServer(bytes, request), apiVersions(version));
    }
    for (const version of [0, 1]) {
        const request = kafkaRequest(3, version, array(text("events")));
        completeAndFragmented(kafka.inspectClient, request);
        completeAndFragmented((bytes) => kafka.inspectServer(bytes, request), metadata(version));
        const sasl = kafkaRequest(17, version, text("SCRAM-SHA-256"));
        completeAndFragmented(kafka.inspectClient, sasl);
        completeAndFragmented((bytes) => kafka.inspectServer(bytes, sasl),
            kafkaResponse(Buffer.concat([i16(0), array(text("PLAIN"), text("SCRAM-SHA-256"))])));
    }
    completeAndFragmented(kafka.inspectClient, kafkaRequest(3, 1, i32(-1)));
    completeAndFragmented(kafka.inspectClient, kafkaRequest(3, 0, array()));
    completeAndFragmented(kafka.inspectClient, kafkaFrame(Buffer.concat([i16(18), i16(0), i32(-1), i16(-1)])));
});

test("Kafka flexible ApiVersions v3/v4 handles librdkafka, extension tags, known features and v0 rejection", () => {
    const librdkafka = Buffer.from("0000001c0012000300000001000163000b6c696272646b61666b6104312e3000", "hex");
    completeAndFragmented(kafka.inspectClient, librdkafka);
    const entry = Buffer.concat([i16(18), i16(0), i16(4), tags([10, Buffer.from([10, 0])])]);
    const feature = Buffer.concat([compactText("metadata.version"), i16(0), i16(20), tags()]);
    const finalized = Buffer.concat([compactText("metadata.version"), i16(20), i16(20), tags()]);
    const epoch = Buffer.alloc(8); epoch.writeBigInt64BE(5n);
    const body = Buffer.concat([i16(0), compactArray(entry), i32(0),
        tags([0, compactArray(feature)], [1, epoch], [2, compactArray(finalized)],
            [3, Buffer.from([1])], [0xffffffff, Buffer.from([10, 255])])]);
    completeAndFragmented((bytes) => kafka.inspectServer(bytes, librdkafka), kafkaResponse(body, 1));
    for (const version of [3, 4]) {
        const request = kafkaRequest(18, version);
        completeAndFragmented((bytes) => kafka.inspectServer(bytes, request), kafkaResponse(body));
        completeAndFragmented((bytes) => kafka.inspectServer(bytes, request),
            kafkaResponse(Buffer.concat([i16(35), array(Buffer.concat([i16(18), i16(0), i16(2)]))])));
    }
    const header = Buffer.concat([i16(18), i16(3), i32(10), text("c")]);
    const request = kafkaFrame(Buffer.concat([header, tags([0xffffffff, Buffer.from([0, 10])]),
        compactText("librdkafka"), compactText("2.6.0"), tags([42, Buffer.from([10])])]));
    completeAndFragmented(kafka.inspectClient, request);
});

test("Kafka ApiVersions v1/v2 accepts only precisely framed v0 UNSUPPORTED_VERSION fallback", () => {
    const emptyReply = Buffer.from("0000000a00000001002300000000", "hex");
    const entries = [array(), array(Buffer.concat([i16(3), i16(0), i16(1)]),
        Buffer.concat([i16(18), i16(0), i16(0)]))];
    for (const version of [1, 2]) {
        const request = Buffer.from(`0000000a0012000${version}000000010000`, "hex");
        completeAndFragmented(kafka.inspectClient, request);
        const inspect = (bytes: Buffer) => kafka.inspectServer(bytes, request);
        completeAndFragmented(inspect, emptyReply);
        for (const apis of entries) {
            const body = Buffer.concat([i16(35), apis]);
            completeAndFragmented(inspect, kafkaResponse(body, 1));
            // A response using its requested v1/v2 schema still has a throttle.
            completeAndFragmented(inspect, kafkaResponse(Buffer.concat([body, i32(0)]), 1));
            invalid(inspect, kafkaResponse(body, 2),
                kafkaResponse(Buffer.concat([body, Buffer.from([0])]), 1),
                kafkaResponse(Buffer.concat([body, i32(0), Buffer.from([0])]), 1));
            for (const error of [0, -1, 36]) {
                invalid(inspect, kafkaResponse(Buffer.concat([i16(error), apis]), 1));
            }
        }
        invalid(inspect,
            kafkaResponse(Buffer.concat([i16(35), i32(1)]), 1),
            kafkaResponse(Buffer.concat([i16(35), array(Buffer.concat([i16(18), i16(2), i16(1)]))]), 1));
    }
});

test("Kafka flexible fields reject nulls, malformed varints, unordered tags and invalid feature bodies", () => {
    const header = Buffer.concat([i16(18), i16(3), i32(1), text("c")]);
    const software = Buffer.concat([compactText("librdkafka"), compactText("1.0")]);
    const frame = (headerTags: Buffer, body: Buffer) => kafkaFrame(Buffer.concat([header, headerTags, body]));
    const body = Buffer.concat([software, tags()]);
    invalid(kafka.inspectClient,
        frame(tags(), Buffer.concat([Buffer.from([0]), compactText("1.0"), tags()])),
        frame(tags(), Buffer.concat([compactText(""), compactText("1.0"), tags()])),
        frame(tags(), Buffer.concat([compactText("librdkafka"), Buffer.from([0]), tags()])),
        frame(tags(), Buffer.concat([software, tags([2, Buffer.alloc(0)], [2, Buffer.alloc(0)])])),
        frame(tags([2, Buffer.alloc(0)], [1, Buffer.alloc(0)]), body),
        frame(Buffer.from([0x80, 0]), body), frame(Buffer.from([1, 0, 127]), body),
        frame(tags(), Buffer.concat([Buffer.from([0x80, 0]), software, tags()])),
        frame(tags(), Buffer.concat([Buffer.from([2, 0xff]), compactText("1.0"), tags()])),
        frame(tags(), Buffer.concat([software, tags(), Buffer.from([0])])));
    const request = kafkaRequest(18, 3, undefined, 1);
    const inspect = (bytes: Buffer) => kafka.inspectServer(bytes, request);
    const response = (entries: Buffer, bodyTags: Buffer = tags()) =>
        kafkaResponse(Buffer.concat([i16(0), entries, i32(0), bodyTags]), 1);
    invalid(inspect, response(Buffer.from([0])),
        response(compactArray(Buffer.concat([i16(18), i16(4), i16(0), tags()]))),
        response(compactArray(Buffer.concat([i16(18), i16(0), i16(4), tags([1, Buffer.alloc(0)], [0, Buffer.alloc(0)])]))),
        response(compactArray(), tags([1, Buffer.alloc(7)])),
        response(compactArray(), tags([3, Buffer.from([2])])),
        response(compactArray(), tags([0, compactArray(Buffer.concat([compactText("feature"), i16(3), i16(1), tags()]))])),
        response(compactArray(), tags([2, Buffer.from([0])])),
        response(compactArray(), tags([9, Buffer.alloc(0)], [9, Buffer.alloc(0)])),
        kafkaResponse(Buffer.concat([i16(0), compactArray(), i32(0), tags()]), 2),
        kafkaResponse(Buffer.concat([Buffer.from([0]), i16(0), compactArray(), i32(0), tags()]), 1));
});

test("Kafka rejects generic framed data, unimplemented APIs and malformed classic schemas", () => {
    invalid(kafka.inspectClient, Buffer.from([1]), Buffer.from([0, 1]), i32(65536), i32(-1), i32(9),
        kafkaRequest(0, 0), kafkaRequest(18, 5), kafkaRequest(3, 2, array()),
        kafkaRequest(36, 0, long(Buffer.from("token"))), kafkaRequest(18, -1),
        kafkaRequest(18, 0, Buffer.from([0])), kafkaRequest(3, 0, i32(-1)),
        kafkaRequest(3, 0, i32(0x7fffffff)), kafkaRequest(3, 0, array(text(""))),
        kafkaRequest(17, 0, text("not a mechanism")),
        kafkaFrame(Buffer.concat([i16(18), i16(0), i32(1), i16(-2)])),
        kafkaFrame(Buffer.concat([i16(18), i16(0), i32(1), u16(2), Buffer.from([0xc0, 0x80])])));
    invalid(kafka.inspectClient, Buffer.from([0, 0, 0, 20, 1]), Buffer.from([0, 0, 0, 20, 0, 18, 1]));
});

test("Kafka server confirmation correlates request IDs and validates complete response bodies", () => {
    invalid((bytes) => kafka.inspectServer(bytes), apiVersions(0), metadata(0));
    const request = kafkaRequest(18, 0);
    const inspect = (bytes: Buffer) => kafka.inspectServer(bytes, request);
    invalid(inspect, kafkaResponse(Buffer.concat([i16(0), array()]), 42),
        kafkaFrame(Buffer.from([2])), // mismatching correlation prefix is rejected without waiting for all four bytes
        kafkaResponse(Buffer.concat([i16(0), i32(65535)])),
        kafkaResponse(Buffer.concat([i16(0), array(Buffer.concat([i16(18), i16(3), i16(0)]))])),
        kafkaResponse(Buffer.concat([i16(0), array(Buffer.concat([i16(18), i16(0), i16(1)]),
            Buffer.concat([i16(18), i16(0), i16(1)]))])),
        kafkaResponse(Buffer.concat([i16(0), array(), Buffer.from([0])])));
    invalid((bytes) => kafka.inspectServer(bytes, kafkaRequest(18, 1)),
        kafkaResponse(Buffer.concat([i16(0), array(), i32(-1)])));
    const metaRequest = kafkaRequest(3, 0, array());
    invalid((bytes) => kafka.inspectServer(bytes, metaRequest),
        kafkaResponse(Buffer.concat([array(Buffer.concat([i32(1), text("broker"), i32(0)])), array()])),
        kafkaResponse(Buffer.concat([array(), i32(-1)])));
    invalid((bytes) => kafka.inspectServer(bytes, kafkaRequest(17, 0, text("PLAIN"))),
        kafkaResponse(Buffer.concat([i16(0), array(text("bad mechanism"))])));
    invalid((bytes) => kafka.inspectServer(bytes, Buffer.from("invalid")), apiVersions(0));
    invalid((bytes) => kafka.inspectServer(bytes, request.subarray(0, -1)), apiVersions(0));
});

const info = {server_id: "ND3NATSSERVER", server_name: "unit", version: "2.10.22", go: "go1.23.2",
    host: "0.0.0.0", port: 4222, proto: 1, max_payload: 1048576, headers: true,
    auth_required: true, client_id: 10, connect_urls: ["nats.local:4222"]};
function natsInfo(value: unknown = info, pretty = false): Buffer {
    return Buffer.from(`INFO ${JSON.stringify(value, null, pretty ? 2 : undefined)}\r\n`);
}

test("NATS server-first single-line INFO validates identity, case-insensitive names and escaped newlines", () => {
    assert.equal(nats.initiation, "server");
    completeAndFragmented(nats.inspectServer, natsInfo());
    completeAndFragmented(nats.inspectServer, natsInfo({...info, server_name: 'braces } { [ ] and "quoted"\nnext line'}));
    completeAndFragmented(nats.inspectServer, Buffer.from(natsInfo().toString().replace('"unit"', '"\\u0075nit"')));
    for (const name of ["info", "iNfO", "InfO"]) {
        completeAndFragmented(nats.inspectServer, Buffer.from(natsInfo().toString().replace("INFO", name)));
    }
    const large = natsInfo({...info, nonce: "x".repeat(12000)});
    assert.deepEqual(nats.inspectServer(large.subarray(0, 10000)), {status: "incomplete"});
    assert.deepEqual(nats.inspectServer(large), {status: "match", length: large.length});
    assert.deepEqual(nats.inspectClient(Buffer.alloc(0)), {status: "invalid"});
    invalid(nats.inspectClient, Buffer.from("CONNECT {}\r\n"));
});

test("NATS rejects generic INFO JSON, invalid fields, invalid JSON and unbounded greetings", () => {
    invalid(nats.inspectServer, Buffer.from("HTTP/1.1 200 OK\r\n"), Buffer.from("INFOX"),
        natsInfo({}), natsInfo({message: "hello"}), natsInfo([]), natsInfo({...info, proto: 2}),
        natsInfo(info, true), Buffer.from(`INFO \n${JSON.stringify(info)}\r\n`),
        Buffer.from(`INFO ${JSON.stringify(info)}\r \r\n`),
        Buffer.from(`INFO ${JSON.stringify(info).replace('"unit"', '"raw\rnewline"')}\r\n`),
        natsInfo({...info, port: 0}), natsInfo({...info, max_payload: -1}), natsInfo({...info, version: "hello"}),
        natsInfo({...info, headers: "true"}), natsInfo({...info, connect_urls: [1]}),
        natsInfo({...info, server_id: ""}), natsInfo({...info, go: null}),
        Buffer.from('INFO {"a":]}\r\n'), Buffer.from('INFO {"a":"bad\nstring"}\r\n'),
        Buffer.from('INFO {"a":undefined}\r\n'), Buffer.from('INFO {"a":"\\q"}\r\n'),
        Buffer.concat([Buffer.from('INFO {"a":"'), Buffer.from([0xff]), Buffer.from('"}\r\n')]),
        Buffer.from(`INFO ${JSON.stringify(info)}\n`),
        Buffer.concat([Buffer.from('INFO {"nonce":"'), Buffer.alloc(MAX_CHANNEL_ENVELOPE_BYTES, 120)]));
    const base = natsInfo({...info, nonce: ""});
    const maximum = natsInfo({...info, nonce: "x".repeat(MAX_CHANNEL_ENVELOPE_BYTES - base.length)});
    assert.equal(maximum.length, MAX_CHANNEL_ENVELOPE_BYTES);
    assert.deepEqual(nats.inspectServer(maximum.subarray(0, -1)), {status: "incomplete"});
    assert.deepEqual(nats.inspectServer(maximum), {status: "match", length: maximum.length});
});

test("NATS near-limit INFO remains inexpensive in 64-byte fragments", (context) => {
    const base = natsInfo({...info, nonce: ""});
    const frame = natsInfo({...info, nonce: "x".repeat(MAX_CHANNEL_ENVELOPE_BYTES - base.length)});
    const start = performance.now();
    for (let length = 64; length < frame.length; length += 64) {
        assert.deepEqual(nats.inspectServer(frame.subarray(0, length)), {status: "incomplete"});
    }
    assert.deepEqual(nats.inspectServer(frame), {status: "match", length: frame.length});
    context.diagnostic(`65KB INFO in 64-byte fragments: ${(performance.now() - start).toFixed(2)}ms`);
});

test("AMQP and Kafka accept bounded envelopes at the cap, not overflowing declared frames", () => {
    const fields = (length: number) => Buffer.concat([Buffer.from([1, 120, 0x53]), long(Buffer.alloc(length, 10))]);
    const base = startFrame(fields(0));
    const greeting = startFrame(fields(MAX_CHANNEL_ENVELOPE_BYTES - base.length));
    assert.equal(greeting.length, MAX_CHANNEL_ENVELOPE_BYTES);
    assert.deepEqual(amqp.inspectServer(greeting.subarray(0, -1), amqp091), {status: "incomplete"});
    assert.deepEqual(amqp.inspectServer(greeting, amqp091), {status: "match", length: greeting.length});
    const request = kafkaFrame(Buffer.concat([i16(3), i16(0), i32(10), i16(-1),
        array(text("a".repeat(32767)), text("b".repeat(32750)))]));
    assert.equal(request.length, MAX_CHANNEL_ENVELOPE_BYTES);
    assert.deepEqual(kafka.inspectClient(request.subarray(0, -1)), {status: "incomplete"});
    assert.deepEqual(kafka.inspectClient(request), {status: "match", length: request.length});
    invalid(kafka.inspectClient, i32(MAX_CHANNEL_ENVELOPE_BYTES - 3));
});

test("Messaging envelopes do not cross-classify as another family's negotiation", () => {
    const requests = [connect(), amqp10, kafkaRequest(18, 0), Buffer.from("CONNECT {}\r\n")];
    const definitions = [mqtt, amqp, kafka, nats];
    for (let owner = 0; owner < requests.length; owner++) {
        for (let other = 0; other < definitions.length; other++) {
            if (other !== owner) invalid(definitions[other]!.inspectClient, requests[owner]!);
        }
    }
    for (const foreign of [Buffer.from("GET / HTTP/1.1\r\n"), Buffer.from("SSH-2.0-client\r\n"),
        Buffer.from([0x16, 3, 3, 0, 10]), Buffer.from("0010host:version\n")]) {
        for (const entry of definitions) invalid(entry.inspectClient, foreign);
    }
    invalid(mqtt.inspectServer, amqp10, apiVersions(0), natsInfo());
    invalid(amqp.inspectServer, connack(), apiVersions(0), natsInfo());
    invalid(kafka.inspectServer, connack(), amqp10, natsInfo());
    invalid(nats.inspectServer, connack(), amqp10, apiVersions(0));
});
