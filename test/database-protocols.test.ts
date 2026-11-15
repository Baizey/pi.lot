import assert from "node:assert/strict";
import {Socket} from "node:net";
import test, {type TestContext} from "node:test";
import {databaseProtocols} from "../src/policy/network/DatabaseProtocols.js";
import {MAX_CHANNEL_ENVELOPE_BYTES, type ChannelProbe} from "../src/policy/network/ChannelProtocol.js";
import {NetworkApplicationProtocol} from "../src/policy/network/NetworkProtocol.js";

const postgres = databaseProtocols.find((item) => item.protocol === NetworkApplicationProtocol.POSTGRES)!;
const mysql = databaseProtocols.find((item) => item.protocol === NetworkApplicationProtocol.MYSQL)!;
const redis = databaseProtocols.find((item) => item.protocol === NetworkApplicationProtocol.REDIS)!;
const mongo = databaseProtocols.find((item) => item.protocol === NetworkApplicationProtocol.MONGODB)!;

type Inspector = (bytes: Buffer) => ChannelProbe;
function complete(inspect: Inspector, frame: Buffer): void {
    for (let i = 0; i < frame.length; i++) {
        assert.deepEqual(inspect(frame.subarray(0, i)), {status: "incomplete"}, `prefix ${i}/${frame.length}: ${frame.toString("hex")}`);
    }
    assert.deepEqual(inspect(frame), {status: "match", length: frame.length});
    assert.deepEqual(inspect(Buffer.concat([frame, Buffer.from("\nopaque\0continuation")])), {status: "match", length: frame.length});
}
function invalid(inspect: Inspector, frames: Buffer[]): void {
    for (const frame of frames) assert.deepEqual(inspect(frame), {status: "invalid"}, frame.toString("hex"));
}
function int32(value: number, little = true): Buffer {
    const bytes = Buffer.alloc(4);
    if (little) bytes.writeInt32LE(value);
    else bytes.writeUInt32BE(value);
    return bytes;
}
function pgRequest(code: number, body = Buffer.alloc(0)): Buffer {
    return Buffer.concat([int32(8 + body.length, false), int32(code, false), body]);
}
function pgReply(type: string, body: Buffer): Buffer {
    return Buffer.concat([Buffer.from(type), int32(4 + body.length, false), body]);
}
const startup = pgRequest(196608, Buffer.from("user\0alice\0database\0demo\0application_name\0test\nclient\0\0"));
const sslRequest = pgRequest(80877103);
const gssRequest = pgRequest(80877104);
const cancelRequest = pgRequest(80877102, Buffer.from([0, 0, 0, 42, 10, 0, 255, 13]));

function mysqlPacket(payload: Buffer, sequence = 0): Buffer {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = sequence;
    return Buffer.concat([header, payload]);
}
function greeting(plugin = true, maria = false): Buffer {
    const fields = Buffer.alloc(31);
    fields.writeUInt32LE(42, 0);
    Buffer.from("a\nb\rcdef").copy(fields, 4);
    fields.writeUInt16LE(maria ? 0x8200 : 0x8201, 13);
    fields[15] = 45;
    fields.writeUInt16LE(2, 16);
    fields.writeUInt16LE(plugin ? 8 : 0, 18);
    fields[20] = plugin ? 21 : 0;
    if (maria) fields.writeUInt32LE(0x1000000, 27);
    return mysqlPacket(Buffer.concat([
        Buffer.from(`\x0a${maria ? "5.5.5-11.4.2-MariaDB" : "8.0.36"}\0`), fields,
        Buffer.from("ghijklmnopqr\0"), ...(plugin ? [Buffer.from("caching_sha2_password\0")] : []),
    ]));
}
function command(...args: (string | Buffer)[]): Buffer {
    return Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap((arg) => {
        const body = Buffer.isBuffer(arg) ? arg : Buffer.from(arg);
        return [Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")];
    })]);
}

// Small binary constructors keep malformed-length mutations visible in each test.
function bsonElement(type: number, key: string, bytes: Buffer): Buffer {
    return Buffer.concat([Buffer.from([type]), Buffer.from(key + "\0"), bytes]);
}
function bson(...elements: Buffer[]): Buffer {
    const body = Buffer.concat(elements);
    return Buffer.concat([int32(5 + body.length), body, Buffer.from([0])]);
}
function bsonInt(key: string, value: number): Buffer { return bsonElement(16, key, int32(value)); }
function bsonText(key: string, value: string): Buffer {
    const bytes = Buffer.from(value);
    return bsonElement(2, key, Buffer.concat([int32(bytes.length + 1), bytes, Buffer.from([0])]));
}
const hello = bson(bsonInt("hello", 1), bsonText("$db", "admin"));
const mongoOk = bson(bsonInt("ok", 1), bsonElement(8, "isWritablePrimary", Buffer.from([1])));
function mongoFrame(opcode: number, body: Buffer, requestId = 17, responseTo = 0): Buffer {
    return Buffer.concat([int32(body.length + 16), int32(requestId), int32(responseTo), int32(opcode), body]);
}
function opMsg(document = hello, requestId = 17, responseTo = 0, flags = 0, sections = Buffer.alloc(0)): Buffer {
    return mongoFrame(2013, Buffer.concat([int32(flags | 0), Buffer.from([0]), document, sections]), requestId, responseTo);
}
function opQuery(document = bson(bsonInt("isMaster", 1)), requestId = 19): Buffer {
    return mongoFrame(2004, Buffer.concat([int32(4), Buffer.from("admin.$cmd\0"), int32(0), int32(-1), document]), requestId);
}
function opReply(document = mongoOk, responseTo = 19, flags = 0): Buffer {
    return mongoFrame(1, Buffer.concat([int32(flags), Buffer.alloc(8), int32(0), int32(1), document]), 55, responseTo);
}
function withChecksum(frame: Buffer): Buffer {
    const result = Buffer.concat([frame, Buffer.alloc(4)]);
    result.writeInt32LE(result.length, 0);
    result.writeUInt32LE((result.readUInt32LE(16) | 1) >>> 0, 16);
    let crc = 0xffffffff;
    for (const byte of result.subarray(0, -4)) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
    result.writeUInt32LE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
}

test("PostgreSQL v3 startup and encryption requests preserve every plausible fragment", () => {
    assert.equal(postgres.initiation, "client");
    for (const request of [startup, sslRequest, gssRequest]) complete(postgres.inspectClient, request);
    for (const response of ["S", "N"]) complete((bytes) => postgres.inspectServer(bytes, sslRequest), Buffer.from(response));
    for (const response of ["G", "N"]) complete((bytes) => postgres.inspectServer(bytes, gssRequest), Buffer.from(response));
    invalid((bytes) => postgres.inspectServer(bytes, sslRequest), [Buffer.from("G"), Buffer.from("R")]);
    invalid((bytes) => postgres.inspectServer(bytes, gssRequest), [Buffer.from("S"), Buffer.from("E")]);
    invalid(postgres.inspectServer, [Buffer.from("S"), Buffer.from("N"), pgReply("R", int32(0, false))]);
});

test("PostgreSQL cancellation is a fixed terminal one-way envelope, never a channel", () => {
    complete(postgres.inspectClient, cancelRequest);
    assert.equal(postgres.isOneWayRequest?.(cancelRequest), true);
    for (const ordinary of [startup, sslRequest, gssRequest]) assert.equal(postgres.isOneWayRequest?.(ordinary), false);
    invalid(postgres.inspectClient, [pgRequest(80877102), pgRequest(80877102, Buffer.alloc(7)), pgRequest(80877102, Buffer.alloc(9))]);
    invalid((bytes) => postgres.inspectServer(bytes, cancelRequest), [Buffer.alloc(0), Buffer.from("N"), pgReply("R", int32(0, false))]);
});

test("PostgreSQL validates complete initial authentication and errors, not a type byte", () => {
    const authResponses = [0, 2, 3, 6, 7, 9].map((code) => pgReply("R", int32(code, false)));
    authResponses.push(pgReply("R", Buffer.concat([int32(5, false), Buffer.from([0, 10, 255, 13])])));
    authResponses.push(pgReply("R", Buffer.concat([int32(10, false), Buffer.from("SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0")])));
    const error = pgReply("E", Buffer.from("SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed\nfor user\0\0"));
    const inspect = (bytes: Buffer) => postgres.inspectServer(bytes, startup);
    for (const reply of [...authResponses, error]) complete(inspect, reply);
    invalid(inspect, [pgReply("R", int32(5, false)), pgReply("R", int32(8, false)), pgReply("R", int32(11, false)),
        pgReply("R", Buffer.concat([int32(10, false), Buffer.from("\0")])),
        pgReply("R", Buffer.concat([int32(10, false), Buffer.from("SCRAM-SHA-256\0")])),
        pgReply("R", Buffer.concat([int32(10, false), Buffer.from("bad mechanism\0\0")])),
        pgReply("E", Buffer.from("SFATAL\0Mmissing SQLSTATE\0\0")),
        pgReply("E", Buffer.from("SFATAL\0C123\0Mbad code\0\0")),
        pgReply("E", Buffer.from("SFATAL\0C12345\0Mmessage\0")), Buffer.from("S"),
        Buffer.concat([Buffer.from("R"), int32(MAX_CHANNEL_ENVELOPE_BYTES, false)])]);
});

test("PostgreSQL v3.0 supports bounded reserved-option negotiation, not startup v3.2", () => {
    const request = pgRequest(196608, Buffer.from("user\0alice\0_pq_.unsupported\0value\0_pq_.other\0value\0\0"));
    complete(postgres.inspectClient, request);
    const reply = (minor: number, count: number, options: string) => pgReply("v", Buffer.concat([int32(minor, false), int32(count, false), Buffer.from(options)]));
    const inspect = (bytes: Buffer) => postgres.inspectServer(bytes, request);
    complete(inspect, reply(0, 1, "_pq_.unsupported\0"));
    complete(inspect, reply(2, 2, "_pq_.other\0_pq_.unsupported\0"));
    complete(inspect, reply(0, 0, ""));
    invalid(inspect, [reply(0, 4097, ""), reply(0, 1, ""), reply(0, 1, "_pq_.unsupported"),
        reply(0, 1, "\0"), reply(0, 1, "_pq_.unknown\0"), reply(0, 2, "_pq_.other\0_pq_.other\0"),
        reply(0, 0, "trailing\0"), pgReply("v", Buffer.alloc(7))]);
    assert.equal(postgres.inspectServer(reply(0, 1, "_pq_.unsupported\0"), startup).status, "invalid", "unsupported options must correlate to the startup");
    assert.equal(postgres.inspectClient(pgRequest(196610, Buffer.from("user\0alice\0\0"))).status, "invalid");
});

test("PostgreSQL rejects impossible lengths, wrong versions and malformed startup pairs", () => {
    invalid(postgres.inspectClient, [Buffer.from([1]), int32(0, false), int32(7, false), int32(MAX_CHANNEL_ENVELOPE_BYTES + 1, false),
        pgRequest(196609, Buffer.from("user\0alice\0\0")), pgRequest(80877103, Buffer.from([0])),
        pgRequest(196608), pgRequest(196608, Buffer.from("database\0demo\0\0")),
        pgRequest(196608, Buffer.from("user\0\0\0")), pgRequest(196608, Buffer.from("user\0alice\0")),
        pgRequest(196608, Buffer.from("user\0alice\0\0extra")),
        pgRequest(196608, Buffer.from("user\0alice\0user\0bob\0\0"))]);
    assert.equal(postgres.inspectClient(Buffer.from([0, 0, 0, 8, 0])).status, "invalid", "negotiation code prefix already contradicts v3/SSL/GSS");
});

test("MySQL and MariaDB protocol 10 greetings are server-first, bounded, binary-safe", () => {
    assert.equal(mysql.initiation, "server");
    for (const packet of [greeting(), greeting(false), greeting(true, true), greeting(false, true)]) {
        complete(mysql.inspectServer, packet);
        assert.equal(mysql.inspectClient(packet).status, "invalid");
    }
    invalid(mysql.inspectServer, [Buffer.from([0, 0, 1]), Buffer.from([0xff, 0xff, 1]), Buffer.from([50, 0, 0, 1]),
        Buffer.from([50, 0, 0, 0, 9]), mysqlPacket(Buffer.from("\x0a\0")),
        mysqlPacket(Buffer.from("\x0aSSH-2.0-server\0")), mysqlPacket(Buffer.from("\x0a8.0\nbad\0")),
        mysqlPacket(Buffer.from("\xfferror message"))]);
    const good = greeting();
    const base = good.indexOf(0, 5) + 1;
    for (const [offset, value] of [[base + 12, 1], [base + 14, 0], [base + 15, 0], [base + 20, 0], [base + 21, 1],
        [base + 27, 1], [base + 30, 1], [base + 43, 1], [good.length - 1, 1]] as const) {
        const bad = Buffer.from(good);
        bad[offset] = value;
        assert.equal(mysql.inspectServer(bad).status, "invalid", `field ${offset}`);
    }
    const extra = mysqlPacket(Buffer.concat([good.subarray(4), Buffer.from([0])]));
    assert.equal(mysql.inspectServer(extra).status, "invalid", "trailing bytes inside the declared greeting are not continuation");
});

test("MySQL reserved padding is zero unless MariaDB clears CLIENT_MYSQL for extended capabilities", () => {
    const maria = greeting(true, true);
    const base = maria.indexOf(0, 5) + 1;
    assert.equal(maria.readUInt16LE(base + 13) & 1, 0);
    assert.notEqual(maria.readUInt32LE(base + 27), 0, "fixture actually advertises extended capabilities");
    assert.deepEqual(mysql.inspectServer(maria), {status: "match", length: maria.length});
    maria.writeUInt16LE(maria.readUInt16LE(base + 13) | 1, base + 13);
    assert.equal(mysql.inspectServer(maria).status, "invalid", "CLIENT_MYSQL forbids nonzero final reserved bytes");
});

test("Redis RESP2/3 requests frame arbitrary commands and binary arguments, not an allowlist", () => {
    for (const request of [command("PING"), command("HELLO", "3"), command("AUTH", "user", "secret"),
        command("FUTURE.MODULE.COMMAND", Buffer.from([0, 13, 10, 255]), ""), command("SET", "key", "first\r\nsecond\nthird")]) {
        complete(redis.inspectClient, request);
        complete(redis.createClientInspector!(), request);
    }
    invalid(redis.inspectClient, [Buffer.from("PING\r\n"), Buffer.from("+PING\r\n"), Buffer.from("*0\r\n"), Buffer.from("*-1\r\n"),
        Buffer.from("*4097\r\n"), Buffer.from("*1\r\n$0\r\n\r\n"), Buffer.from("*1\r\n$-1\r\n"),
        Buffer.from("*1\r\n+PING\r\n"), Buffer.from("*1\r\n*1\r\n$4\r\nPING\r\n"),
        Buffer.from("*1\n"), Buffer.from("*1\rx"), Buffer.from("*1\r\n$999999"),
        Buffer.from("*1\r\n$65539\r\n"), Buffer.from("*1\r\n$3\r\nPING\r\n")]);
});

test("Redis validates fixed-length RESP2 and RESP3 replies including nested collections and attributes", () => {
    const inspect = (bytes: Buffer) => redis.inspectServer(bytes, command("arbitrary-command"));
    const replies = ["+OK\r\n", "-ERR unknown command\r\n", ":-9223372036854775808\r\n", ":9223372036854775807\r\n",
        ":+42\r\n", "(+12345678901234567890\r\n", ",+.5e+2\r\n",
        "$-1\r\n", "*-1\r\n", "$6\r\na\r\nb\nx\r\n", "*2\r\n$3\r\nfoo\r\n:42\r\n", "_\r\n", "#t\r\n", "#f\r\n",
        ",1.23e-4\r\n", ",inf\r\n", ",-inf\r\n", ",nan\r\n", "(3492890328409238509324850943850943825024385\r\n",
        "!10\r\nERR broken\r\n", "=7\r\ntxt:foo\r\n", "%1\r\n+key\r\n~2\r\n:1\r\n:2\r\n", ">2\r\n+message\r\n$3\r\nfoo\r\n",
        "|1\r\n+ttl\r\n:5\r\n|0\r\n%1\r\n+key\r\n+value\r\n", "*1\r\n|1\r\n+ttl\r\n:5\r\n+value\r\n"];
    for (const reply of replies) {
        complete(inspect, Buffer.from(reply));
        complete(redis.createServerInspector!(command("arbitrary-command")), Buffer.from(reply));
    }
    invalid(redis.inspectServer, replies.map((reply) => Buffer.from(reply)));
    assert.deepEqual(inspect(Buffer.from("|1\r\n+ttl\r\n:5\r\n")), {status: "incomplete"}, "attributes alone are not a response");
});

test("Redis rejects malformed response fields, excessive nesting/counts and impossible lengths", () => {
    const inspect = (bytes: Buffer) => redis.inspectServer(bytes, command("HELLO", "3"));
    invalid(inspect, [Buffer.from("HTTP/1.1 200 OK\r\n"), Buffer.from("+bad\nline\r\n"), Buffer.from("#yes\r\n"), Buffer.from("_x\r\n"),
        Buffer.from(":9223372036854775808\r\n"), Buffer.from(":-9223372036854775809\r\n"), Buffer.from(":1.2\r\n"),
        Buffer.from(",not-a-number\r\n"), Buffer.from("(12x\r\n"), Buffer.from(":no"), Buffer.from(":9223372036854775808"),
        Buffer.from("#x"), Buffer.from("_x"), Buffer.from(",.e"), Buffer.from(",no"), Buffer.from("*4097"),
        Buffer.from(">0\r\n"), Buffer.from(">1\r\n:2\r\n"), Buffer.from("$-2\r\n"), Buffer.from("$?\r\n"),
        Buffer.from("*?\r\n"), Buffer.from("*-2\r\n"), Buffer.from("%4096\r\n"), Buffer.from("~4097\r\n"),
        Buffer.from("!65539\r\n"), Buffer.from("=3\r\ntxt\r\n"), Buffer.from("=7\r\ntxt-foo\r\n"),
        Buffer.from("$3\r\nfooX"), Buffer.from("$3\r\nfoo\rX"), Buffer.from("*1\r\n".repeat(34) + "+ok\r\n"),
        Buffer.from("+" + "x".repeat(MAX_CHANNEL_ENVELOPE_BYTES))]);
});

test("MongoDB OP_MSG validates BSON commands, sections, checksums and correlated responses", () => {
    const sequenceBody = Buffer.concat([Buffer.from("documents\0"), bson(bsonInt("a", 1)), bson(bsonText("b", "line\nline"))]);
    const sequence = Buffer.concat([Buffer.from([1]), int32(sequenceBody.length + 4), sequenceBody]);
    const insert = opMsg(bson(bsonText("insert", "items"), bsonText("$db", "demo")), 121, 0, 0x10000, sequence);
    for (const request of [opMsg(), insert, withChecksum(opMsg())]) {
        complete(mongo.inspectClient, request);
        const reply = opMsg(mongoOk, 44, request.readInt32LE(4));
        complete((bytes) => mongo.inspectServer(bytes, request), reply);
        complete((bytes) => mongo.inspectServer(bytes, request), withChecksum(reply));
    }
    const req = opMsg();
    invalid((bytes) => mongo.inspectServer(bytes, req), [opMsg(mongoOk, 18, 99), opReply(mongoOk, 17), opMsg(bson(bsonText("message", "no ok")), 44, 17),
        opMsg(bson(bsonInt("ok", 2)), 44, 17)]);
    invalid(mongo.inspectServer, [opMsg(mongoOk), opReply()]);
    const exhaust = opMsg(hello, 17, 0, 0x10000);
    complete((bytes) => mongo.inspectServer(bytes, exhaust), opMsg(mongoOk, 44, 17, 2));
    assert.equal(mongo.inspectServer(opMsg(mongoOk, 44, 17, 2), req).status, "invalid", "unsolicited exhaust response is contradictory");
    const corrupt = withChecksum(opMsg());
    corrupt[corrupt.length - 1]! ^= 1;
    assert.equal(mongo.inspectClient(corrupt).status, "invalid");
    assert.equal(mongo.inspectServer(opMsg(mongoOk, 99, 123).subarray(0, 12), req).status, "invalid", "responseTo mismatch fails before body");
});

test("MongoDB ignores unknown optional OP_MSG flags but rejects unknown required flags", () => {
    const request = opMsg();
    for (const optional of [0x20000, 0x40000000, 0x80000000]) {
        const message = opMsg(hello, 17, 0, optional);
        complete(mongo.inspectClient, message);
        complete(mongo.inspectClient, withChecksum(message));
        complete((bytes) => mongo.inspectServer(bytes, request), opMsg(mongoOk, 44, 17, optional));
    }
    for (const required of [4, 8, 0x8000]) {
        assert.equal(mongo.inspectClient(opMsg(hello, 17, 0, required)).status, "invalid");
        assert.equal(mongo.inspectServer(opMsg(mongoOk, 44, 17, required), request).status, "invalid");
    }
});

test("MongoDB legacy OP_QUERY supports direct hello/isMaster and validates OP_REPLY", () => {
    for (const name of ["hello", "isMaster", "ismaster"]) {
        const request = opQuery(bson(bsonInt(name, 1), bsonElement(8, "helloOk", Buffer.from([1]))));
        complete(mongo.inspectClient, request);
        complete((bytes) => mongo.inspectServer(bytes, request), opReply());
        complete((bytes) => mongo.inspectServer(bytes, request), opReply(bson(bsonInt("ok", 0), bsonText("errmsg", "no"))));
        complete((bytes) => mongo.inspectServer(bytes, request), opReply(bson(bsonText("$err", "denied")), 19, 2));
    }
    invalid(mongo.inspectClient, [opQuery(bson(bsonInt("find", 1))), opQuery(bson(bsonInt("hello", 0))),
        opQuery(bson(bsonElement(3, "$query", bson(bsonInt("hello", 1)))))]);
    const request = opQuery();
    for (const offset of [16, 20, 28, 32]) {
        const bad = opReply();
        bad.writeInt32LE(7, offset);
        assert.equal(mongo.inspectServer(bad, request).status, "invalid");
    }
    const badNamespace = Buffer.from(request);
    badNamespace[26] = 0x58;
    assert.equal(mongo.inspectClient(badNamespace).status, "invalid");
});

test("MongoDB validates BSON scalar, nested, deprecated and binary encodings, not just headers", () => {
    const code = Buffer.concat([int32(2), Buffer.from("x\0")]);
    const scope = bson(bsonInt("a", 1));
    const codeScope = Buffer.concat([int32(4 + code.length + scope.length), code, scope]);
    const doc = bson(bsonInt("someCommand", 1), bsonText("$db", "admin"),
        bsonElement(1, "double", Buffer.alloc(8)), bsonElement(3, "object", bson(bsonText("line", "a\nb"))),
        bsonElement(4, "array", bson(bsonInt("0", 3), bsonInt("1", 4))),
        bsonElement(5, "binary", Buffer.concat([int32(3), Buffer.from([0, 10, 0, 255])])),
        bsonElement(5, "oldBinary", Buffer.concat([int32(7), Buffer.from([2]), int32(3), Buffer.from([0, 10, 255])])),
        ...[6, 7, 9, 10, 17, 18, 19, 127, 255].map((type) => bsonElement(type, `type${type}`,
            Buffer.alloc(new Map([[7, 12], [9, 8], [17, 8], [18, 8], [19, 16]]).get(type) ?? 0))),
        bsonElement(11, "regex", Buffer.from("a.*b\0im\0")), bsonElement(12, "pointer", Buffer.concat([code, Buffer.alloc(12)])),
        bsonElement(13, "javascript", code), bsonElement(14, "symbol", code), bsonElement(15, "scope", codeScope));
    complete(mongo.inspectClient, opMsg(doc));
    const malformed = [bson(bsonInt("hello", 1)), // Missing mandatory $db on OP_MSG.
        bson(bsonInt("hello", 1), bsonElement(13, "$db", code)), // JavaScript is not a database-name string.
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(8, "badBool", Buffer.from([2]))),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(42, "unknownType", Buffer.alloc(0))),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(2, "badString", Buffer.concat([int32(2), Buffer.from("xx")]))),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(2, "badUtf8", Buffer.concat([int32(2), Buffer.from([255, 0])]))),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(4, "badArray", bson(bsonInt("1", 1)))),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonText("$db", "other")),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(5, "badBinary", Buffer.concat([int32(5), Buffer.from([2]), int32(2), Buffer.from([0])]))),
        bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(11, "badRegexOptions", Buffer.from("x\0mi\0")))];
    invalid(mongo.inspectClient, malformed.map((document) => opMsg(document)));
    const badEnd = opMsg();
    badEnd[badEnd.length - 1] = 1;
    const badDocSize = opMsg();
    badDocSize.writeInt32LE(MAX_CHANNEL_ENVELOPE_BYTES, 21);
    invalid(mongo.inspectClient, [badEnd, badDocSize, badDocSize.subarray(0, 25)]);
});

test("MongoDB rejects impossible envelope fields, unsupported compression, nesting and oversized declarations promptly", () => {
    const bare = mongoFrame(2013, Buffer.concat([int32(0), Buffer.from([0]), bson()]));
    const unknownSection = mongoFrame(2013, Buffer.concat([int32(0), Buffer.from([2]), hello]));
    const duplicateBody = opMsg(hello, 17, 0, 0, Buffer.concat([Buffer.from([0]), hello]));
    const emptySequence = Buffer.concat([Buffer.from([1]), int32(14), Buffer.from("documents\0")]);
    const duplicateSequence = opMsg(hello, 17, 0, 0, Buffer.concat([emptySequence, emptySequence]));
    let nested = bson();
    for (let i = 0; i < 34; i++) nested = bson(bsonElement(3, "child", nested));
    invalid(mongo.inspectClient, [int32(MAX_CHANNEL_ENVELOPE_BYTES + 1), int32(-1), int32(25), bare, unknownSection, duplicateBody, duplicateSequence,
        mongoFrame(2012, Buffer.alloc(20)), opMsg(hello, 17, 1), opMsg(hello, 17, 0, 2), opMsg(hello, 17, 0, 4),
        opMsg(bson(bsonInt("hello", 1), bsonText("$db", "admin"), bsonElement(3, "deep", nested)))]);
    assert.equal(mongo.inspectClient(Buffer.from([255, 255, 1])).status, "invalid", "partial LE size already exceeds bound");
    assert.equal(mongo.inspectClient(opMsg().subarray(0, 16)).status, "incomplete", "header alone does not recognize MongoDB");
});

test("database families do not confuse each other's initial envelopes or text protocols", () => {
    const requests = [startup, sslRequest, command("PING"), opMsg(), opQuery()];
    for (const definition of databaseProtocols) {
        for (const request of requests) {
            const owns = definition === postgres ? request === startup || request === sslRequest
                : definition === redis ? request === requests[2] : definition === mongo && (request === requests[3] || request === requests[4]);
            if (!owns || definition === mysql) assert.equal(definition.inspectClient(request).status, "invalid", `${definition.protocol}: ${request.toString("hex")}`);
        }
        invalid(definition.inspectClient, [Buffer.from("GET / HTTP/1.1\r\n"), Buffer.from("SSH-2.0-test\r\n"), Buffer.from("000chost:version"), greeting()]);
        if (definition !== mysql) assert.equal(definition.inspectServer(greeting()).status, "invalid");
    }
    invalid(mysql.inspectServer, [startup, command("PING"), opMsg(), Buffer.from("220 mail ESMTP ready\r\n"), Buffer.from("SSH-2.0-server\r\n")]);
});

test("Redis incremental readers keep client and nested server aggregate work linear and isolated", () => {
    const request = command("X", ...Array.from({length: 999}, () => ""));
    const response = Buffer.from("*2\r\n*1000\r\n" + ":1\r\n".repeat(1000) + "%1\r\n+key\r\n|1\r\n+ttl\r\n:2\r\n$3\r\nval\r\n");
    const client = redis.createClientInspector!();
    const server = redis.createServerInspector!(request);
    for (const [inspect, frame] of [[client, request], [server, response]] as const) {
        let reads = 0;
        let validationSlices = 0;
        for (let i = 0; i <= frame.length; i++) {
            const counted = new Proxy(frame.subarray(0, i), {
                get(target, property) {
                    if (typeof property === "string" && /^\d+$/.test(property)) reads++;
                    if (property === "subarray") validationSlices++;
                    const value = Reflect.get(target, property, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const result = inspect(counted);
            assert.equal(result.status, i === frame.length ? "match" : "incomplete", `fragment ${i}`);
        }
        assert.ok(reads <= frame.length, `${reads} indexed byte reads for ${frame.length} fragmented bytes`);
        assert.equal(validationSlices, 1, "the complete boundary invokes the reference validator only once");
        assert.deepEqual(inspect(Buffer.concat([frame, Buffer.from("opaque")])), {status: "match", length: frame.length});
    }
    const interrupted = redis.createClientInspector!();
    assert.equal(interrupted(request.subarray(0, 8)).status, "incomplete");
    complete(redis.createClientInspector!(), command("AUTH", "secret"));
    assert.deepEqual(interrupted(request), {status: "match", length: request.length}, "another reader cannot replace this reader's cursor");
    assert.equal(redis.createServerInspector!()(Buffer.from("+OK\r\n")).status, "invalid");
});

test("Redis incremental readers bound declarations, aggregate budgets, nesting and binary terminators", () => {
    for (const frame of ["*4097", "*1\r\n$65539\r\n", "*1\r\n$1\r\nxX", "*1\r\n$-1\r\n", "*1\r\n$0\r\n\r\n"]) {
        assert.equal(redis.createClientInspector!()(Buffer.from(frame)).status, "invalid", frame);
    }
    for (const frame of ["*4096\r\n", "%2048\r\n", "*1\r\n".repeat(34), "$65539\r\n", "$2\r\nx\nxX", "#x", "_x"]) {
        assert.equal(redis.createServerInspector!(command("X"))(Buffer.from(frame)).status, "invalid", frame);
    }
});

test("Redis accepts envelope/count boundaries without inspecting opaque queued continuation", () => {
    const maximum = command("X", Buffer.alloc(MAX_CHANNEL_ENVELOPE_BYTES - 21, 10));
    assert.equal(maximum.length, MAX_CHANNEL_ENVELOPE_BYTES);
    assert.deepEqual(redis.inspectClient(maximum), {status: "match", length: maximum.length});
    assert.deepEqual(redis.inspectClient(maximum.subarray(0, -1)), {status: "incomplete"});
    const tooLong = command("X", Buffer.alloc(MAX_CHANNEL_ENVELOPE_BYTES - 20));
    assert.equal(redis.inspectClient(tooLong.subarray(0, 19)).status, "invalid", "bulk declaration alone exceeds total envelope bound");
    const manyArgs = command("X", ...Array.from({length: 4095}, () => ""));
    assert.deepEqual(redis.inspectClient(manyArgs), {status: "match", length: manyArgs.length});
    const reply = Buffer.from("*4095\r\n" + "_\r\n".repeat(4095));
    assert.deepEqual(redis.inspectServer(reply, command("X")), {status: "match", length: reply.length});
    assert.equal(redis.inspectServer(Buffer.from("*4096\r\n"), command("X")).status, "invalid", "root also consumes a reply node");
});

type RedisReply = (nonce: string) => Buffer | undefined;
function redisUpstream(t: TestContext, respond: RedisReply, fragmented = false): {socket: Socket; nonces: string[]} {
    // A real, never-connected Socket exercises the handshake reader's ownership
    // and readable buffering without creating any localhost/host connection.
    const socket = new Socket();
    t.after(() => socket.destroy());
    // push() supplies all transport bytes; do not let Socket._read wait for a
    // connection or add connect listeners on each artificially injected fragment.
    t.mock.method(socket, "_read", () => {});
    const nonces: string[] = [];
    t.mock.method(socket, "write", (chunk: Buffer) => {
        const wire = chunk.toString("ascii");
        const parsed = /^\*2\r\n\$4\r\nPING\r\n\$64\r\n([0-9a-f]{64})\r\n$/.exec(wire);
        assert.ok(parsed, "only a canonical nonce PING may be injected");
        const nonce = parsed[1]!;
        nonces.push(nonce);
        const reply = respond(nonce);
        if (reply && fragmented) {
            let offset = 0;
            const push = () => {
                if (socket.destroyed || offset === reply.length) return;
                socket.push(reply.subarray(offset, offset + 1));
                offset++;
                setImmediate(push);
            };
            setImmediate(push);
        } else if (reply) socket.push(reply);
        return true;
    });
    return {socket, nonces};
}

function nonceBulk(nonce: string): Buffer { return Buffer.from(`$${nonce.length}\r\n${nonce}\r\n`); }

test("Redis ambiguous replies require a fresh nonce; consume its reply but preserve opaque upstream continuation", async (t) => {
    assert.ok(redis.confirmServer);
    const tail = Buffer.from([0, 255, 10, 13, 42]);
    const first = redisUpstream(t, (nonce) => Buffer.concat([nonceBulk(nonce), tail]));
    const second = redisUpstream(t, nonceBulk, true);
    const original = Buffer.from("+OK\r\n");
    await redis.confirmServer(first.socket, command("AUTH", "secret"), original, new AbortController().signal);
    await redis.confirmServer(second.socket, command("SET", "key", "value"), original, new AbortController().signal);
    assert.equal(first.nonces.length, 1);
    assert.equal(second.nonces.length, 1);
    assert.notEqual(first.nonces[0], second.nonces[0], "nonce must not be reused across connections");
    assert.deepEqual(first.socket.read(), tail, "internal challenge consumes no unrelated server continuation");
    assert.equal(second.socket.readableLength, 0, "challenge reply is never restored to the client");
    assert.deepEqual(original, Buffer.from("+OK\r\n"), "owner retains the original response for replay after confirmation");
});

test("Redis nonce confirmation rejects POP3/SMTP replies, wrong echoes and missing authentication/ACL permission", async (t) => {
    assert.ok(redis.confirmServer);
    for (const response of ["+OK\r\n", "+OK POP3 ready\r\n", "-ERR unrecognized command\r\n", "-ERR POP3 denied\r\n"]) {
        for (const reply of ["+OK\r\n", "-ERR unknown command\r\n", "220 SMTP ready\r\n", "-NOAUTH Authentication required\r\n", "-NOPERM permission denied\r\n", "$3\r\nbad\r\n"]) {
            const {socket, nonces} = redisUpstream(t, () => Buffer.from(reply));
            await assert.rejects(redis.confirmServer(socket, command("AUTH", "bad-secret"), Buffer.from(response), new AbortController().signal), /invalid protocol envelope/);
            assert.equal(nonces.length, 1);
        }
    }
});

test("Redis subscribed RESP2 pong is correlated, and generic simple replies cannot masquerade as zero-arg PING", async (t) => {
    assert.ok(redis.confirmServer);
    const subscribed = redisUpstream(t, (nonce) => Buffer.concat([Buffer.from("*2\r\n$4\r\npong\r\n"), nonceBulk(nonce)]), true);
    await redis.confirmServer(subscribed.socket, command("SUBSCRIBE", "topic"), Buffer.from("+OK\r\n"), new AbortController().signal);
    assert.equal(subscribed.nonces.length, 1);
    const wrongNonce = redisUpstream(t, (nonce) => nonceBulk((nonce[0] === "a" ? "b" : "a") + nonce.slice(1)));
    await assert.rejects(redis.confirmServer(wrongNonce.socket, command("AUTH", "secret"), Buffer.from("+OK\r\n"), new AbortController().signal), /invalid protocol envelope/);
    for (const request of [command("AUTH", "secret"), command("PING", "argument")]) {
        const {socket, nonces} = redisUpstream(t, nonceBulk);
        await redis.confirmServer(socket, request, Buffer.from("+PONG\r\n"), new AbortController().signal);
        assert.equal(nonces.length, 1);
    }
});

test("Redis distinctive replies and canonical zero-arg PONG need no injected command", async (t) => {
    assert.ok(redis.confirmServer);
    const {socket, nonces} = redisUpstream(t, () => { throw new Error("unexpected challenge"); });
    for (const response of [":1\r\n", "$3\r\nfoo\r\n", "*0\r\n", "_\r\n", "#t\r\n", "%0\r\n", "!3\r\nERR\r\n"]) {
        await redis.confirmServer(socket, command("arbitrary-command"), Buffer.from(response), new AbortController().signal);
    }
    for (const name of ["PING", "ping", "PiNg"]) await redis.confirmServer(socket, command(name), Buffer.from("+PONG\r\n"), new AbortController().signal);
    assert.equal(nonces.length, 0);
});

test("Redis challenge observes cancellation before writes and while waiting, and removes reader listeners", async (t) => {
    assert.ok(redis.confirmServer);
    const {socket, nonces} = redisUpstream(t, () => undefined);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(redis.confirmServer(socket, command("AUTH", "secret"), Buffer.from("+OK\r\n"), alreadyAborted.signal));
    assert.equal(nonces.length, 0);
    const counts = ["readable", "end", "close", "error"].map((event) => socket.listenerCount(event));
    const controller = new AbortController();
    const pending = redis.confirmServer(socket, command("AUTH", "secret"), Buffer.from("+OK\r\n"), controller.signal);
    controller.abort();
    await assert.rejects(pending, /aborted or timed out/);
    assert.equal(nonces.length, 1);
    assert.deepEqual(["readable", "end", "close", "error"].map((event) => socket.listenerCount(event)), counts);
});

test("PostgreSQL and MongoDB defer deep body parsing across large byte-sized fragments", () => {
    const parameters = Array.from({length: 350}, (_, i) => `parameter${i}\0${"v".repeat(150)}\0`).join("");
    const largeStartup = pgRequest(196608, Buffer.from(`user\0alice\0${parameters}\0`));
    const largeCommand = opMsg(bson(bsonInt("someCommand", 1), bsonText("$db", "admin"),
        ...Array.from({length: 3500}, (_, i) => bsonInt(`field${i}`, i))));
    for (const [inspect, frame] of [[postgres.inspectClient, largeStartup], [mongo.inspectClient, largeCommand]] as const) {
        for (let i = 0; i < frame.length; i++) assert.equal(inspect(frame.subarray(0, i)).status, "incomplete", `fragment ${i}`);
        assert.deepEqual(inspect(frame), {status: "match", length: frame.length});
    }
    const error = pgReply("E", Buffer.from(`SFATAL\0C28P01\0M${"m".repeat(60000)}\0\0`));
    for (let i = 0; i < error.length; i++) assert.equal(postgres.inspectServer(error.subarray(0, i), largeStartup).status, "incomplete");
    assert.deepEqual(postgres.inspectServer(error, largeStartup), {status: "match", length: error.length});
});

test("database probes stay tri-state and bounded on deterministic malformed binary inputs", () => {
    let seed = 12345;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    };
    const sources = [startup, sslRequest, greeting(), command("SET", "a", "b"), opMsg(), opQuery(), opReply()];
    for (let i = 0; i < 1500; i++) {
        let input: Buffer;
        if (i % 2 === 0) {
            input = Buffer.alloc(random() % 128);
            for (let j = 0; j < input.length; j++) input[j] = random() >>> 24;
        } else {
            input = Buffer.from(sources[random() % sources.length]!);
            input[random() % input.length] = random() >>> 24;
            input = input.subarray(0, random() % (input.length + 1));
        }
        for (const definition of databaseProtocols) {
            const request = definition === postgres ? startup : definition === redis ? command("X") : opMsg();
            for (const probe of [definition.inspectClient(input), definition.inspectServer(input, request)]) {
                assert.ok(["match", "incomplete", "invalid"].includes(probe.status));
                if (probe.status === "match") {
                    assert.ok(probe.length > 0 && probe.length <= input.length && probe.length <= MAX_CHANNEL_ENVELOPE_BYTES);
                }
            }
        }
    }
});
