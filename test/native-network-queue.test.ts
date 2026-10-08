import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const probe = path.join(root, "build/pi-network-queue-probe");
const prefix = "PI_NETWORK_QUEUE\t3";
interface Vector { description: string; command: string; expected: string }

function packetVector(description: string, packet: Uint8Array, expected = "DROP"): Vector {
    return {description, command: `P ${Buffer.from(packet).toString("hex")}`, expected};
}

function verdictVector(description: string, sequence: string, dns: boolean, record: string | Buffer, expected = "INVALID"): Vector {
    return {description, command: `V ${sequence} ${dns ? 1 : 0} ${Buffer.from(record).toString("hex")}`, expected};
}

function execute(vectors: readonly Vector[]): void {
    const input = vectors.map(vector => vector.command).join("\n") + "\n";
    const result = spawnSync(probe, [], {input, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const lines = result.stdout.split("\n");
    assert.equal(lines.pop(), "", "probe output must be newline terminated");
    assert.equal(lines.length, vectors.length);
    vectors.forEach((vector, index) => {
        const [kind, first, dnsQuery, record] = vector.command.split(" ");
        const modeled = kind === "P" ? packetOracle(Buffer.from(first, "hex"))
            : verdictOracle(first, dnsQuery === "1", Buffer.from(record, "hex"));
        assert.equal(modeled, vector.expected, `oracle: ${vector.description}`);
        assert.equal(lines[index], vector.expected, `${vector.description}; ${vector.command}`);
    });
}

function event(transport = "udp", destination = 443, family = "IPV4", source = "192.0.2.1", target = "198.51.100.2", dns?: string): string {
    return `${prefix}\tEVENT\t1\t${family}\t${transport}\t${source}\t1234\t${target}\t${destination}${dns ? `\tDNS\t${dns}` : ""}`;
}

function udp(payload: Buffer = Buffer.alloc(0), destination = 443): Buffer {
    const header = Buffer.alloc(8);
    header.writeUInt16BE(1234, 0);
    header.writeUInt16BE(destination, 2);
    header.writeUInt16BE(8 + payload.length, 4);
    return Buffer.concat([header, payload]);
}

function tcp(length = 20, offset = 5, flags = 2): Buffer {
    const header = Buffer.alloc(length);
    header.writeUInt16BE(1234, 0);
    header.writeUInt16BE(443, 2);
    if (length > 12) header[12] = offset << 4;
    if (length > 13) header[13] = flags;
    return header;
}

function ipv4(transport: Buffer = udp(), protocol = 17, options: Buffer = Buffer.alloc(0)): Buffer {
    const header = Buffer.alloc(20);
    header[0] = 0x40 | ((20 + options.length) / 4);
    header.writeUInt16BE(20 + options.length + transport.length, 2);
    header[9] = protocol;
    header.set([192, 0, 2, 1], 12);
    header.set([198, 51, 100, 2], 16);
    return Buffer.concat([header, options, transport]);
}

function ipv6(transport: Buffer = udp(), protocol = 17): Buffer {
    const header = Buffer.alloc(40);
    header[0] = 0x60;
    header.writeUInt16BE(transport.length, 4);
    header[6] = protocol;
    header.set([0x20, 1, 0x0d, 0xb8], 8);
    header[23] = 1;
    header.set([0x20, 1, 0x0d, 0xb8], 24);
    header[39] = 2;
    return Buffer.concat([header, transport]);
}

function dns(labels: readonly string[] = ["WWW", "Example", "COM"], type = 1, queryClass = 1): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4);
    const question = Buffer.alloc(5);
    question.writeUInt16BE(type, 1);
    question.writeUInt16BE(queryClass, 3);
    return Buffer.concat([header, ...labels.map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), question]);
}

function changed(packet: Buffer, offset: number, value: number, width = 1): Buffer {
    const copy = Buffer.from(packet);
    if (width === 2) copy.writeUInt16BE(value, offset);
    else copy[offset] = value;
    return copy;
}

function dnsVector(description: string, query: Buffer, expected = "DROP"): Vector {
    return packetVector(description, ipv4(udp(query, 53)), expected);
}

// Test-side wire specification: no native code or production TS parser is used.
// Fixed vectors below also check these oracles, so the mutation corpus cannot
// quietly regress to an oracle that always rejects or omits event fields.
function packetOracle(bytes: Buffer): string {
    const word = (buffer: Buffer, offset: number) => offset + 2 <= buffer.length ? buffer.readUInt16BE(offset) : -1;
    const version = (bytes[0] ?? 0) >>> 4;
    let start: number;
    let end: number;
    let protocol: number;
    let source: string;
    let target: string;
    if (version === 4 && bytes.length >= 20) {
        start = (bytes[0] & 15) * 4;
        end = word(bytes, 2);
        if (start < 20 || end < start || end > bytes.length || (word(bytes, 6) & 0x3fff) !== 0) return "DROP";
        protocol = bytes[9];
        source = [...bytes.subarray(12, 16)].join(".");
        target = [...bytes.subarray(16, 20)].join(".");
    } else if (version === 6 && bytes.length >= 40) {
        start = 40;
        end = start + word(bytes, 4);
        if (end <= start || end > bytes.length) return "DROP";
        protocol = bytes[6];
        source = ipv6Text(bytes.subarray(8, 24));
        target = ipv6Text(bytes.subarray(24, 40));
    } else return "DROP";
    const payload = bytes.subarray(start, end);
    const transport = protocol === 6 ? "tcp" : protocol === 17 ? "udp" : null;
    if (transport === "tcp") {
        const size = (payload[12] ?? 0) >>> 4;
        if (payload.length < 20 || size < 5 || size * 4 > payload.length || (payload[13] & 0x17) !== 2) return "DROP";
    } else if (transport === "udp") {
        const size = word(payload, 4);
        if (payload.length < 8 || size < 8 || size > payload.length) return "DROP";
    } else return "DROP";
    const sourcePort = word(payload, 0);
    const targetPort = word(payload, 2);
    if (sourcePort <= 0 || targetPort <= 0) return "DROP";
    const fields = [prefix, "EVENT", "1", `IPV${version}`, transport, source, String(sourcePort), target, String(targetPort)];
    if (transport === "udp" && targetPort === 53) {
        const query = payload.subarray(8, word(payload, 4));
        if (query.length < 17 || (word(query, 2) & 0xf800) !== 0 || word(query, 4) !== 1) return "DROP";
        const labels: string[] = [];
        let cursor = 12;
        while (cursor < query.length && query[cursor] !== 0) {
            const size = query[cursor++];
            if (size > 63 || cursor + size > query.length) return "DROP";
            const label = query.subarray(cursor, cursor + size).toString("latin1");
            if (!/^[a-z0-9_-]+$/i.test(label) || label.startsWith("-") || label.endsWith("-")) return "DROP";
            labels.push(label.toLowerCase());
            cursor += size;
        }
        const name = labels.join(".");
        // Require the root terminator followed by a complete nonzero IN question.
        if (query[cursor] !== 0 || !name || name.length > 255 || cursor + 5 > query.length
            || word(query, cursor + 1) <= 0 || word(query, cursor + 3) !== 1) return "DROP";
        fields.push("DNS", name, String(word(query, cursor + 1)));
    }
    return fields.join("\t");
}

function ipv6Text(bytes: Buffer): string {
    const dotted = [...bytes.subarray(12)].join(".");
    if (bytes.subarray(0, 12).every(byte => byte === 0) && (bytes[12] !== 0 || bytes[13] !== 0)) return `::${dotted}`;
    if (bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) return `::ffff:${dotted}`;
    // The platform URL parser supplies independent RFC 5952 zero compression.
    const groups = Array.from({length: 8}, (_, index) => bytes.readUInt16BE(index * 2).toString(16));
    return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

function verdictOracle(sequence: string, dnsQuery: boolean, bytes: Buffer): string {
    const newline = bytes.indexOf(10);
    if (newline < 0 || newline >= 255) return "INVALID";
    const record = bytes.subarray(0, bytes[newline - 1] === 13 ? newline - 1 : newline);
    for (const [decision, mark] of [["ALLOW", dnsQuery ? 0x50490004 : 0x50490001], ["DENY", dnsQuery ? 0x50490005 : 0x50490002]] as const) {
        if (record.equals(Buffer.from(`${prefix}\tVERDICT\t${sequence}\t${decision}`))) return `MARK ${mark}`;
    }
    return "INVALID";
}

test("network queue: IPv4 lengths, options, fragments, versions and padding have independent expectations", () => {
    const base = ipv4();
    const vectors: Vector[] = [packetVector("ordinary UDP", base, event())];
    for (let length = 0; length < base.length; length++) vectors.push(packetVector(`truncation ${length}`, base.subarray(0, length)));
    for (const ihl of [0, 1, 4, 8, 15]) vectors.push(packetVector(`invalid IHL ${ihl}`, changed(base, 0, 0x40 | ihl)));
    for (const total of [0, 19, 20, 27, 29, 65535]) vectors.push(packetVector(`total length ${total}`, changed(base, 2, total, 2)));
    for (const fragment of [1, 8191, 0x2000, 0x2001, 0x3fff, 0xffff]) vectors.push(packetVector(`fragment ${fragment}`, changed(base, 6, fragment, 2)));
    for (const fragment of [0, 0x4000, 0x8000, 0xc000]) vectors.push(packetVector(`non-fragment flag ${fragment}`, changed(base, 6, fragment, 2), event()));
    for (const version of [0, 1, 3, 5, 7, 15]) vectors.push(packetVector(`version ${version}`, changed(base, 0, (version << 4) | 5)));
    for (const protocol of [0, 1, 2, 41, 58, 255]) vectors.push(packetVector(`protocol ${protocol}`, changed(base, 9, protocol)));
    for (const length of [4, 8, 40]) vectors.push(packetVector(`opaque IPv4 options ${length}`, ipv4(udp(), 17, Buffer.alloc(length, 255)), event()));
    vectors.push(packetVector("padding beyond IP total length ignored", Buffer.concat([base, Buffer.alloc(100, 255)]), event()));
    vectors.push(packetVector("source unspecified and broadcast destination", Buffer.from(base.map((byte, i) => i >= 12 && i < 16 ? 0 : i >= 16 && i < 20 ? 255 : byte)), event("udp", 443, "IPV4", "0.0.0.0", "255.255.255.255")));
    execute(vectors);
});

test("network queue: IPv6 payload bounds, direct transport requirement and textual addresses", () => {
    const base = ipv6();
    const expected = event("udp", 443, "IPV6", "2001:db8::1", "2001:db8::2");
    const vectors: Vector[] = [packetVector("IPv6 UDP", base, expected), packetVector("IPv6 TCP", ipv6(tcp(), 6), event("tcp", 443, "IPV6", "2001:db8::1", "2001:db8::2"))];
    for (let length = 0; length < base.length; length++) vectors.push(packetVector(`IPv6 truncation ${length}`, base.subarray(0, length)));
    for (const length of [0, 1, 7, 9, 65535]) vectors.push(packetVector(`IPv6 payload length ${length}`, changed(base, 4, length, 2)));
    for (const next of [0, 43, 44, 50, 51, 58, 59, 60, 255]) vectors.push(packetVector(`IPv6 extension/other ${next}`, changed(base, 6, next)));
    vectors.push(packetVector("IPv6 trailing bytes ignored", Buffer.concat([base, Buffer.alloc(50)]), expected));
    const addresses: [string, string][] = [
        ["00000000000000000000000000000000", "::"], ["00000000000000000000000000000001", "::1"],
        ["000000000000000000000000c0000201", "::192.0.2.1"], ["00000000000000000000ffffc0000201", "::ffff:192.0.2.1"],
        ["20010000000000010000000000010001", "2001::1:0:0:1:1"],
        ["20010001000200030004000500060007", "2001:1:2:3:4:5:6:7"],
        ["20010001000000030004000500060007", "2001:1:0:3:4:5:6:7"],
    ];
    for (const [hex, text] of addresses) {
        const copy = Buffer.from(base);
        Buffer.from(hex, "hex").copy(copy, 8);
        vectors.push(packetVector(`IPv6 rendering ${text}`, copy, event("udp", 443, "IPV6", text, "2001:db8::2")));
    }
    execute(vectors);
});

test("network queue: every TCP flag and header offset, UDP size and both port boundaries", () => {
    const vectors: Vector[] = [];
    for (let flags = 0; flags <= 255; flags++) vectors.push(packetVector(`TCP flags ${flags}`, ipv4(tcp(20, 5, flags), 6), (flags & 0x17) === 2 ? event("tcp") : "DROP"));
    for (let offset = 0; offset <= 15; offset++) {
        for (const length of [20, 24, 60, 64]) vectors.push(packetVector(`TCP offset ${offset}, length ${length}`, ipv4(tcp(length, offset), 6), offset >= 5 && offset * 4 <= length ? event("tcp") : "DROP"));
    }
    for (let length = 0; length < 20; length++) vectors.push(packetVector(`short TCP ${length}`, ipv4(tcp(Math.max(4, length), 5).subarray(0, length), 6)));
    const datagram = udp(Buffer.alloc(8));
    for (const length of [0, 1, 7, 8, 9, 16, 17, 65535]) vectors.push(packetVector(`UDP claimed length ${length}`, ipv4(changed(datagram, 4, length, 2)), length >= 8 && length <= 16 ? event() : "DROP"));
    for (let length = 0; length < 8; length++) vectors.push(packetVector(`short UDP ${length}`, ipv4(datagram.subarray(0, length))));
    for (const protocol of [6, 17]) {
        const header = protocol === 6 ? tcp() : udp();
        for (const port of [0, 1, 53, 65535]) {
            vectors.push(packetVector(`source port ${port}, protocol ${protocol}`, ipv4(changed(header, 0, port, 2), protocol), port === 0 ? "DROP" : event(protocol === 6 ? "tcp" : "udp").replace("\t1234\t", `\t${port}\t`)));
            const expected = port === 0 || (port === 53 && protocol === 17) ? "DROP" : event(protocol === 6 ? "tcp" : "udp", port);
            vectors.push(packetVector(`destination port ${port}, protocol ${protocol}`, ipv4(changed(header, 2, port, 2), protocol), expected));
        }
    }
    execute(vectors);
});

test("network queue: DNS labels, folding, invalid characters, compression and maximum name size", () => {
    const vectors: Vector[] = [dnsVector("mixed case", dns(), event("udp", 53, "IPV4", undefined, undefined, "www.example.com\t1"))];
    for (const labels of [["a"], ["_service", "_TCP", "example"], ["a-b", "123"], ["_"], ["A".repeat(63)], ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63)]]) {
        vectors.push(dnsVector(`valid labels ${labels.join(".")}`, dns(labels), event("udp", 53, "IPV4", undefined, undefined, `${labels.join(".").toLowerCase()}\t1`)));
    }
    for (const labels of [[], [""], ["-a"], ["a-"], ["-"], ["a.b"], ["a b"], ["a/b"], ["a\0b"], ["é"], ["a".repeat(64)], ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62), "e"]]) {
        vectors.push(dnsVector(`invalid labels ${JSON.stringify(labels)}`, dns(labels)));
    }
    for (const character of [0, 1, 9, 10, 13, 32, 46, 47, 58, 64, 91, 96, 123, 127, 128, 255]) vectors.push(dnsVector(`invalid label character ${character}`, changed(dns(["abc"]), 14, character)));
    for (const length of [64, 65, 127, 128, 191, 192, 193, 255]) vectors.push(dnsVector(`compression/reserved label ${length}`, changed(dns(), 12, length)));
    // Labels after the first root terminator are opaque trailing bytes, not a second name.
    vectors.push(dnsVector("trailing bytes ignored", Buffer.concat([dns(["a"]), Buffer.from([255, 192, 0])]), event("udp", 53, "IPV4", undefined, undefined, "a\t1")));
    execute(vectors);
});

test("network queue: DNS header flags, question count, type, class and every truncation", () => {
    const query = dns();
    const vectors: Vector[] = [];
    for (let length = 0; length < query.length; length++) vectors.push(dnsVector(`DNS truncation ${length}`, query.subarray(0, length)));
    for (const flags of [0, 1, 0x10, 0x100, 0x200, 0x400, 0x7ff, 0x800, 0x1000, 0x7800, 0x8000, 0xffff]) {
        vectors.push(dnsVector(`DNS flags ${flags}`, changed(query, 2, flags, 2), (flags & 0xf800) === 0 ? event("udp", 53, "IPV4", undefined, undefined, "www.example.com\t1") : "DROP"));
    }
    for (const count of [0, 1, 2, 65535]) vectors.push(dnsVector(`question count ${count}`, changed(query, 4, count, 2), count === 1 ? event("udp", 53, "IPV4", undefined, undefined, "www.example.com\t1") : "DROP"));
    for (const type of [0, 1, 2, 5, 15, 16, 28, 41, 65, 255, 65535]) vectors.push(dnsVector(`query type ${type}`, dns(["example"], type), type === 0 ? "DROP" : event("udp", 53, "IPV4", undefined, undefined, `example\t${type}`)));
    for (const queryClass of [0, 1, 2, 3, 255, 65535]) vectors.push(dnsVector(`query class ${queryClass}`, dns(["example"], 1, queryClass), queryClass === 1 ? event("udp", 53, "IPV4", undefined, undefined, "example\t1") : "DROP"));
    const ignored = Buffer.from(query);
    ignored.fill(255, 0, 2);
    ignored.fill(255, 6, 12);
    vectors.push(dnsVector("ID and other record counts ignored", ignored, event("udp", 53, "IPV4", undefined, undefined, "www.example.com\t1")));
    const dnsPadding = udp(Buffer.concat([query, Buffer.alloc(30, 255)]), 53);
    dnsPadding.writeUInt16BE(8 + query.length, 4);
    vectors.push(packetVector("DNS uses UDP length, not IP payload", ipv4(dnsPadding), event("udp", 53, "IPV4", undefined, undefined, "www.example.com\t1")));
    vectors.push(packetVector("DNS cannot read question from IP padding", ipv4(changed(udp(query, 53), 4, 8 + query.length - 1, 2))));
    vectors.push(packetVector("non-DNS UDP never validates payload", ipv4(udp(Buffer.alloc(50, 255), 54)), event("udp", 54)));
    vectors.push(packetVector("IPv6 DNS", ipv6(udp(query, 53)), event("udp", 53, "IPV6", "2001:db8::1", "2001:db8::2", "www.example.com\t1")));
    execute(vectors);
});

test("network queue: exact verdict bytes, sequence extremes, CRLF, NUL, EOF and mark selection", () => {
    const vectors: Vector[] = [];
    for (const sequence of ["0", "1", "42", "18446744073709551615"]) {
        for (const dnsQuery of [false, true]) {
            for (const decision of ["ALLOW", "DENY"]) {
                const record = `${prefix}\tVERDICT\t${sequence}\t${decision}`;
                const mark = dnsQuery ? decision === "ALLOW" ? 0x50490004 : 0x50490005 : decision === "ALLOW" ? 0x50490001 : 0x50490002;
                for (const end of ["\n", "\r\n", "\nignored next record", "\n\0junk"]) vectors.push(verdictVector(`${decision} ${sequence} DNS ${dnsQuery} ending ${JSON.stringify(end)}`, sequence, dnsQuery, record + end, `MARK ${mark}`));
                for (const end of ["", "\r", " \n", "\t\n", "\r\r\n", "\0\n", "\r \n"]) vectors.push(verdictVector(`invalid terminator ${JSON.stringify(end)}`, sequence, dnsQuery, record + end));
            }
        }
    }
    const valid = `${prefix}\tVERDICT\t42\tALLOW\n`;
    for (const record of ["", "\n", valid.replace("42", "041"), valid.replace("42", "042"), valid.replace("42", "43"), valid.replace("42", "+42"), valid.replace("42", "-42"), valid.replace("42", "42 "), valid.replace("ALLOW", "allow"), valid.replace("ALLOW", "DENIED"), valid.replace("VERDICT", "EVENT"), valid.replace("\t3\t", "\t2\t"), valid.replaceAll("\t", " "), ` ${valid}`, `\0${valid}`, "x".repeat(254) + "\n", "x".repeat(255) + "\n", valid.slice(0, -1) + "x".repeat(300) + "\n"]) {
        vectors.push(verdictVector(`malformed verdict ${JSON.stringify(record)}`, "42", false, record));
    }
    for (let length = 0; length < valid.length; length++) vectors.push(verdictVector(`verdict truncation ${length}`, "42", false, valid.slice(0, length)));
    for (let index = 0; index < valid.length - 1; index++) {
        const bytes = Buffer.from(valid);
        bytes[index] = 0;
        vectors.push(verdictVector(`embedded NUL ${index}`, "42", false, bytes));
    }
    execute(vectors);
});

test("network queue: deterministic mutation corpus matches independent packet and verdict oracles", () => {
    let state = 0x50494c4f;
    const random = (): number => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    const seeds = [ipv4(), ipv4(tcp(), 6), ipv4(udp(dns(), 53)), ipv6(), ipv6(tcp(60, 15), 6), ipv6(udp(dns(["_srv", "example"], 65), 53))];
    const vectors: Vector[] = [];
    for (let index = 0; index < 6000; index++) {
        let bytes = Buffer.from(seeds[index % seeds.length]);
        const mode = index % 4;
        if (mode === 0) bytes = bytes.subarray(0, random() % (bytes.length + 1));
        else if (mode === 1) bytes = Buffer.concat([bytes, Buffer.alloc(random() % 24, random() & 255)]);
        const mutations = 1 + random() % 5;
        for (let mutation = 0; mutation < mutations && bytes.length; mutation++) bytes[random() % bytes.length] = random() & 255;
        vectors.push(packetVector(`seeded mutation ${index}`, bytes, packetOracle(bytes)));
    }
    assert.ok(vectors.some(vector => vector.expected === "DROP"), "mutations must include rejected packets");
    assert.ok(vectors.some(vector => vector.expected.startsWith(`${prefix}\tEVENT\t`)), "mutations must include accepted packets with exact event expectations");
    for (let index = 0; index < 500; index++) {
        const record = Buffer.from(`${prefix}\tVERDICT\t42\tALLOW\n`);
        for (let mutation = 0; mutation < 1 + index % 4; mutation++) record[random() % record.length] = random() & 255;
        vectors.push(verdictVector(`verdict mutation ${index}`, "42", index % 2 === 1, record, verdictOracle("42", index % 2 === 1, record)));
    }
    execute(vectors);
});
