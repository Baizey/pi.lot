import {NetworkApplicationProtocol} from "./NetworkProtocol.js";
import {
    INCOMPLETE, INVALID, MAX_CHANNEL_ENVELOPE_BYTES,
    type ChannelProbe, type ChannelProtocolDefinition,
} from "./ChannelProtocol.js";

/** Initial envelopes only: authorization admits subsequent commands and upgrades, not individual operations.
 * FTP is cleartext control (including subsequent AUTH TLS). Implicit FTPS cannot be distinguished
 * from other TLS applications without TLS termination and an authenticated application greeting.
 * FTP data connections are separate channels; this parser does not authorize or recognize them.
 * RFC 959 §4.2: https://www.rfc-editor.org/rfc/rfc959 ; TLS: https://www.rfc-editor.org/rfc/rfc4217
 * IMAP4: https://www.rfc-editor.org/rfc/rfc9051#section-7.1
 * POP3: https://www.rfc-editor.org/rfc/rfc1939#section-3
 * Only ASCII CRLF greetings (FTP 220, IMAP OK/PREAUTH, POP3 +OK) identifying the service are
 * recognized; FTP evidence includes vsFTPd, ProFTPD and Pure-FTPd product names, or FileZilla's
 * versioned multiline banner ending with its canonical project URL. Narrow conventional Gimap
 * and "+OK Dovecot ready." greetings are also supported; generic 220/+OK banners fail closed.
 * Server-first greetings need policy approval before release.
 */
export const fileMailProtocols: readonly ChannelProtocolDefinition[] = [
    {protocol: NetworkApplicationProtocol.FTP, initiation: "server", inspectClient: () => INVALID,
        inspectServer: inspectFtpGreeting},
    {protocol: NetworkApplicationProtocol.SMB, initiation: "client", inspectClient: inspectSmbClient,
        inspectServer: inspectSmbServer},
    {protocol: NetworkApplicationProtocol.NFS, initiation: "client", inspectClient: inspectNfsClient,
        inspectServer: inspectNfsServer, isTerminalResponse: isTerminalNfsResponse},
    {protocol: NetworkApplicationProtocol.LDAP, initiation: "client", inspectClient: inspectLdapClient,
        inspectServer: inspectLdapServer},
    {protocol: NetworkApplicationProtocol.IMAP, initiation: "server", inspectClient: () => INVALID,
        inspectServer: (bytes) => inspectMailGreeting(bytes, "imap")},
    {protocol: NetworkApplicationProtocol.POP3, initiation: "server", inspectClient: () => INVALID,
        inspectServer: (bytes) => inspectMailGreeting(bytes, "pop3")},
];

function match(length: number): ChannelProbe {
    return {status: "match", length};
}

function agrees(bytes: Buffer, offset: number, expected: Buffer): boolean {
    return bytes.subarray(offset, Math.min(bytes.length, offset + expected.length))
        .equals(expected.subarray(0, Math.max(0, Math.min(expected.length, bytes.length - offset))));
}

/** Read one strict ASCII CRLF line, without inspecting queued continuation after that line. */
function greetingLine(bytes: Buffer, start: number): {text: string; end: number} | ChannelProbe {
    for (let index = start; index < Math.min(bytes.length, MAX_CHANNEL_ENVELOPE_BYTES); index++) {
        const byte = bytes[index]!;
        if (byte === 13) {
            if (index + 1 >= MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
            if (index + 1 >= bytes.length) return INCOMPLETE;
            if (bytes[index + 1] !== 10) return INVALID;
            return {text: bytes.toString("ascii", start, index), end: index + 2};
        }
        if (byte < 32 || byte > 126) return INVALID;
    }
    return bytes.length >= MAX_CHANNEL_ENVELOPE_BYTES ? INVALID : INCOMPLETE;
}

function inspectFtpGreeting(bytes: Buffer): ChannelProbe {
    if (!agrees(bytes, 0, Buffer.from("220")) || (bytes.length >= 4 && bytes[3] !== 32 && bytes[3] !== 45)) {
        return INVALID;
    }
    let start = 0;
    let evidence = false;
    let multiline = false;
    let fileZilla = false;
    while (true) {
        const line = greetingLine(bytes, start);
        if ("status" in line) return line;
        if (start === 0) {
            if (!/^220[- ]/.test(line.text)) return INVALID;
            multiline = line.text[3] === "-";
            fileZilla = /^220-FileZilla Server [0-9]+(?:\.[0-9]+){1,3}(?: (?:beta|rc[0-9]+))?$/.test(line.text);
        }
        // FTP multiline replies allow unnumbered intermediate lines, unlike SMTP.
        if (/\b(?:E?SMTP|POP3|IMAP(?:4(?:rev[12])?)?)\b/i.test(line.text)) return INVALID;
        evidence ||= /\b(?:FTPS?|vsFTPd|ProFTPD|Pure-FTPd)\b/i.test(line.text);
        if (!multiline || (start > 0 && line.text.startsWith("220 "))) {
            evidence ||= fileZilla && line.text === "220 Please visit https://filezilla-project.org/";
            return evidence ? match(line.end) : INVALID;
        }
        start = line.end;
    }
}

function inspectMailGreeting(bytes: Buffer, protocol: "imap" | "pop3"): ChannelProbe {
    const prefixes = protocol === "imap" ? ["* OK ", "* PREAUTH "] : ["+OK "];
    if (!prefixes.some((prefix) => prefix.toLowerCase().startsWith(
        bytes.subarray(0, prefix.length).toString("latin1").toLowerCase()))) return INVALID;
    const line = greetingLine(bytes, 0);
    if ("status" in line) return line;
    if (protocol === "pop3") {
        const evidence = /^\+OK Dovecot ready\.$/i.test(line.text) || /\bPOP3\b/i.test(line.text);
        return /^\+OK .+/i.test(line.text) && evidence ? match(line.end) : INVALID;
    }
    const text = /^\* (?:OK|PREAUTH) (.+)$/i.exec(line.text)?.[1];
    if (!text || (!/\bIMAP(?:4(?:rev[12])?)?\b/i.test(text)
        && !/^Gimap ready for requests from [0-9a-f:.]+(?: .+)?$/i.test(text))) return INVALID;
    // A bracketed response code must close and be followed by response text.
    if (text.startsWith("[") && !/^\[[A-Za-z0-9][A-Za-z0-9._=-]*(?: [^\[\]]+)?\] .+$/.test(text)) return INVALID;
    return match(line.end);
}

/** Direct TCP SMB2/3 NEGOTIATE, not SMB1-wrapped negotiation, NetBIOS session service,
 * encrypted transforms, or compression transforms. Supports dialects 2.0.2/2.1/3.0/3.0.2/3.1.1.
 * 3.1.1 requires a structurally valid SHA-512 preauthentication context. Other contexts are
 * length-framed extensions; this is channel recognition, not capability/algorithm policy.
 * MS-SMB2 §§2.2.1, 2.2.3, 2.2.4: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/
 */
const SMB_SIGNATURE = Buffer.from([0xfe, 0x53, 0x4d, 0x42]);
const SMB_DIALECTS = new Set([0x0202, 0x0210, 0x0300, 0x0302, 0x0311]);

function inspectSmbClient(bytes: Buffer): ChannelProbe {
    return inspectSmb(bytes, false);
}

function inspectSmbServer(bytes: Buffer, request?: Buffer): ChannelProbe {
    if (!request || inspectSmbClient(request).status !== "match") return INVALID;
    return inspectSmb(bytes, true, request);
}

function inspectSmb(bytes: Buffer, server: boolean, request?: Buffer): ChannelProbe {
    if (bytes.length > 0 && bytes[0] !== 0) return INVALID;
    if (bytes.length < 4) return INCOMPLETE;
    const length = bytes.readUIntBE(1, 3);
    if (length < (server ? 72 : 102) || length + 4 > MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
    const packet = bytes.subarray(4, 4 + length);
    if (!agrees(packet, 0, SMB_SIGNATURE) || !agrees(packet, 4, Buffer.from([64, 0]))
        || !agrees(packet, 12, Buffer.alloc(2))
        || !agrees(packet, 16, Buffer.from([server ? 1 : 0, 0, 0, 0]))
        || !agrees(packet, 20, Buffer.alloc(4))
        || !agrees(packet, 36, Buffer.alloc(28))) return INVALID;
    if (!server && !agrees(packet, 8, Buffer.alloc(4))) return INVALID;
    if (server && packet.length >= 12 && packet.readUInt32LE(8) === 0 && length < 128) return INVALID;
    if (request && packet.length > 24 && !agrees(packet, 24, request.subarray(28, 36))) return INVALID;
    if (packet.length < 64) return INCOMPLETE;
    const error = server && packet.readUInt32LE(8) !== 0;
    if (error) {
        if (!agrees(packet, 64, Buffer.from([9, 0])) || (packet.length > 67 && packet[67] !== 0)) return INVALID;
        if (packet.length < 72) return INCOMPLETE;
        if (packet.readUInt32LE(68) !== length - 72) return INVALID;
        // SMB 3.1.1 error contexts are not parsed here: only the legacy opaque ErrorData form.
        if (packet[66] !== 0) return INVALID;
    } else {
        if (!agrees(packet, 64, Buffer.from([server ? 65 : 36, 0]))) return INVALID;
        if (packet.length >= 68 && (server ? ![1, 2, 3].includes(packet.readUInt16LE(66))
            : packet.readUInt16LE(66) === 0 || 100 + packet.readUInt16LE(66) * 2 > length)) return INVALID;
        if (!server && packet.length >= 70 && (packet.readUInt16LE(68) < 1 || packet.readUInt16LE(68) > 3)) return INVALID;
        if (!server && !agrees(packet, 70, Buffer.alloc(2))) return INVALID;
        if (server && length < 128) return INVALID;
        if (packet.length < (server ? 128 : 100)) return INCOMPLETE;
        if (!server) {
            const count = packet.readUInt16LE(66);
            const dialectEnd = 100 + count * 2;
            if (dialectEnd > length) return INVALID;
            if (packet.length < dialectEnd) return INCOMPLETE;
            const dialects = Array.from({length: count}, (_, index) => packet.readUInt16LE(100 + index * 2));
            if (!dialects.some((dialect) => SMB_DIALECTS.has(dialect)) || dialects.includes(0x02ff)
                || new Set(dialects).size !== count) return INVALID;
            const contextOffset = packet.readUInt32LE(92);
            const contextCount = packet.readUInt16LE(96);
            if (packet.readUInt16LE(98) !== 0) return INVALID;
            if (dialects.includes(0x0311)) {
                const result = smbContexts(packet, length, contextOffset, contextCount, dialectEnd, false);
                if (result) return result;
            } else if (contextOffset !== 0 || contextCount !== 0 || length !== dialectEnd) return INVALID;
        } else {
            const dialect = packet.readUInt16LE(68);
            const count = request!.readUInt16LE(70);
            const offered = Array.from({length: count}, (_, index) => request!.readUInt16LE(104 + index * 2));
            if (!SMB_DIALECTS.has(dialect) || !offered.includes(dialect)) return INVALID;
            if (packet.readUInt32LE(92) === 0 || packet.readUInt32LE(96) === 0 || packet.readUInt32LE(100) === 0) return INVALID;
            const securityOffset = packet.readUInt16LE(120);
            const securityLength = packet.readUInt16LE(122);
            if ((securityLength > 0 && securityOffset < 128) || (securityOffset !== 0 && securityOffset < 128)
                || securityOffset + securityLength > length) return INVALID;
            const securityEnd = Math.max(128, securityOffset + securityLength);
            const contextCount = packet.readUInt16LE(70);
            const contextOffset = packet.readUInt32LE(124);
            if (dialect === 0x0311) {
                const result = smbContexts(packet, length, contextOffset, contextCount, securityEnd, true);
                if (result) return result;
            } else if (contextCount !== 0 || contextOffset !== 0 || securityEnd !== length) return INVALID;
        }
    }
    return bytes.length < length + 4 ? INCOMPLETE : match(length + 4);
}

function smbContexts(packet: Buffer, length: number, offset: number, count: number, minimum: number, server: boolean): ChannelProbe | undefined {
    if (count === 0 || offset < minimum || offset % 8 !== 0 || offset + count * 8 > length) return INVALID;
    if (packet.subarray(minimum, Math.min(offset, packet.length)).some((byte) => byte !== 0)) return INVALID;
    const types = new Set<number>();
    for (let index = 0; index < count; index++) {
        if (packet.length < offset + 8) return INCOMPLETE;
        const type = packet.readUInt16LE(offset);
        const size = packet.readUInt16LE(offset + 2);
        const end = offset + 8 + size;
        if (size === 0 || end > length || types.has(type) || packet.readUInt32LE(offset + 4) !== 0) return INVALID;
        types.add(type);
        if (packet.length < end) return INCOMPLETE;
        if (type === 1) {
            if (size < 6) return INVALID;
            const hashes = packet.readUInt16LE(offset + 8);
            const salt = packet.readUInt16LE(offset + 10);
            if (hashes === 0 || (server && hashes !== 1) || 4 + hashes * 2 + salt !== size) return INVALID;
            let sha512 = false;
            for (let hash = 0; hash < hashes; hash++) sha512 ||= packet.readUInt16LE(offset + 12 + hash * 2) === 1;
            if (!sha512) return INVALID;
        }
        if (index + 1 === count) return end === length && types.has(1) ? undefined : INVALID;
        offset = Math.ceil(end / 8) * 8;
        if (packet.subarray(end, Math.min(offset, packet.length)).some((byte) => byte !== 0)) return INVALID;
    }
    return INVALID;
}

/** ONC RPC v2 single-fragment TCP records for NFS program 100003, versions 3 and 4.
 * No rpcbind/mount programs: their replies do not confirm an NFS service, and discovery/mount
 * requires separately authorized endpoints. No UDP, RPC-over-RDMA, or multi-fragment initial
 * records (fail closed on the first record marker). Later records on the admitted TCP stream
 * are opaque, including multi-fragment records. RPCSEC_GSS privacy/integrity wrappers are not
 * decoded; only calls retaining the checked NFS envelope can be recognized.
 * RPC arguments/results remain opaque after the NFS procedure's minimum envelope; authorization
 * is not per NFS operation. Opaque authentication is bounded by RFC 5531's 400-byte limit.
 * RPC rejection envelopes do not establish an NFS service: return them as terminal responses,
 * never releasing queued requests or admitting arbitrary RPC program continuation.
 * https://www.rfc-editor.org/rfc/rfc5531#section-11
 * https://www.rfc-editor.org/rfc/rfc1813 ; https://www.rfc-editor.org/rfc/rfc7530
 */
function rpcRecord(bytes: Buffer, server: boolean): ChannelProbe {
    if (bytes.length > 0 && (bytes[0]! & 0x80) === 0) return INVALID;
    if (bytes.length < 4) return INCOMPLETE;
    const size = bytes.readUInt32BE(0) & 0x7fffffff;
    if (size < (server ? 12 : 40) || size % 4 !== 0 || size + 4 > MAX_CHANNEL_ENVELOPE_BYTES) return INVALID;
    const body = bytes.subarray(4, size + 4);
    if (!agrees(body, 4, Buffer.from([0, 0, 0, server ? 1 : 0]))) return INVALID;
    if (!server && (!agrees(body, 8, Buffer.from([0, 0, 0, 2]))
        || !agrees(body, 12, Buffer.from([0, 1, 0x86, 0xa3])))) return INVALID;
    return bytes.length < size + 4 ? INCOMPLETE : match(size + 4);
}

function inspectNfsClient(bytes: Buffer): ChannelProbe {
    const frame = rpcRecord(bytes, false);
    if (frame.status === "invalid" || bytes.length < 4) return frame;
    const length = bytes.readUInt32BE(0) & 0x7fffffff;
    const body = bytes.subarray(4, 4 + length);
    if (body.length >= 20 && body.readUInt32BE(16) !== 3 && body.readUInt32BE(16) !== 4) return INVALID;
    if (body.length >= 24) {
        const version = body.readUInt32BE(16);
        const procedure = body.readUInt32BE(20);
        if (procedure > (version === 3 ? 21 : 1)) return INVALID;
    }
    if (body.length < 24) return INCOMPLETE;
    let offset = 24;
    for (let auth = 0; auth < 2; auth++) {
        const next = rpcAuthEnd(body, offset, length);
        if (typeof next !== "number") return next;
        offset = next;
    }
    if (body.readUInt32BE(20) === 0) return offset === length ? frame : INVALID;
    if (body.readUInt32BE(16) === 3) return length - offset >= 4 ? frame : INVALID;
    return nfsCompound(body, offset, length, false) ?? frame;
}

function inspectNfsServer(bytes: Buffer, request?: Buffer): ChannelProbe {
    if (!request || inspectNfsClient(request).status !== "match") return INVALID;
    const frame = rpcRecord(bytes, true);
    if (frame.status === "invalid" || bytes.length < 4) return frame;
    const length = bytes.readUInt32BE(0) & 0x7fffffff;
    const body = bytes.subarray(4, length + 4);
    if (!agrees(body, 0, request.subarray(4, 8))) return INVALID;
    if (body.length < 12) return INCOMPLETE;
    const replyStatus = body.readUInt32BE(8);
    if (replyStatus === 1) {
        if (body.length < 16) return length < 16 ? INVALID : INCOMPLETE;
        const rejected = body.readUInt32BE(12);
        if (rejected === 0) {
            if (length !== 24) return INVALID;
            if (body.length >= 24 && body.readUInt32BE(16) > body.readUInt32BE(20)) return INVALID;
        } else if (rejected === 1) {
            if (length !== 20 || (body.length >= 20 && body.readUInt32BE(16) > 14)) return INVALID;
        } else return INVALID;
        return frame;
    }
    if (replyStatus !== 0) return INVALID;
    const offset = rpcAuthEnd(body, 12, length);
    if (typeof offset !== "number") return offset;
    if (offset + 4 > length) return INVALID;
    if (body.length < offset + 4) return INCOMPLETE;
    const accepted = body.readUInt32BE(offset);
    if (accepted > 5) return INVALID;
    if (accepted === 2) {
        if (length !== offset + 12) return INVALID;
        if (body.length >= offset + 12 && body.readUInt32BE(offset + 4) > body.readUInt32BE(offset + 8)) return INVALID;
        return frame;
    }
    if (accepted !== 0) return length === offset + 4 ? frame : INVALID;
    const procedure = request.readUInt32BE(24);
    if (procedure === 0) return length === offset + 4 ? frame : INVALID;
    if (request.readUInt32BE(20) === 3) return length - offset >= 8 ? frame : INVALID;
    const requestBody = request.subarray(4, 4 + (request.readUInt32BE(0) & 0x7fffffff));
    let requestOffset = 24;
    for (let auth = 0; auth < 2; auth++) {
        const next = rpcAuthEnd(requestBody, requestOffset, requestBody.length);
        if (typeof next !== "number") return INVALID; // The request has already passed validation.
        requestOffset = next;
    }
    return nfsCompound(body, offset + 4, length, true, requestBody.subarray(requestOffset)) ?? frame;
}

function isTerminalNfsResponse(response: Buffer, request: Buffer): boolean {
    // Be conservative if called outside the owner's normal matched-envelope path.
    if (inspectNfsServer(response, request).status !== "match") return true;
    const length = response.readUInt32BE(0) & 0x7fffffff;
    const body = response.subarray(4, length + 4);
    if (body.readUInt32BE(8) !== 0) return true; // MSG_DENIED, including RPC_MISMATCH/AUTH_ERROR.
    const acceptedOffset = rpcAuthEnd(body, 12, length);
    return typeof acceptedOffset !== "number" || body.readUInt32BE(acceptedOffset) !== 0;
}

function rpcAuthEnd(body: Buffer, offset: number, length: number): number | ChannelProbe {
    if (offset + 8 > length) return INVALID;
    if (body.length < offset + 8) return INCOMPLETE;
    const flavor = body.readUInt32BE(offset);
    const size = body.readUInt32BE(offset + 4);
    const end = offset + 8 + Math.ceil(size / 4) * 4;
    if (size > 400 || end > length || (flavor === 0 && size !== 0)) return INVALID;
    if (body.length < end) return INCOMPLETE;
    if (body.subarray(offset + 8 + size, end).some((byte) => byte !== 0)) return INVALID;
    return end;
}

function nfsCompound(body: Buffer, offset: number, length: number, server: boolean, request?: Buffer): ChannelProbe | undefined {
    // COMPOUND4args: tag, minorversion, argarray. COMPOUND4res: status, tag, resarray.
    if (server) offset += 4;
    if (offset + (server ? 8 : 12) > length) return INVALID;
    if (body.length < offset + 4) return INCOMPLETE;
    const tagLength = body.readUInt32BE(offset);
    const afterTag = offset + 4 + Math.ceil(tagLength / 4) * 4;
    const fixedEnd = afterTag + (server ? 4 : 8);
    if (fixedEnd > length) return INVALID;
    if (request && (request.readUInt32BE(0) !== tagLength
        || !agrees(body, offset + 4, request.subarray(4, 4 + tagLength)))) return INVALID;
    if (body.length < fixedEnd) return INCOMPLETE;
    if (body.subarray(offset + 4 + tagLength, afterTag).some((byte) => byte !== 0)) return INVALID;
    if (!server && body.readUInt32BE(afterTag) > 2) return INVALID;
    const count = body.readUInt32BE(fixedEnd - 4);
    if (request && count > request.readUInt32BE(4 + Math.ceil(tagLength / 4) * 4 + 4)) return INVALID;
    if (count * (server ? 8 : 4) > length - fixedEnd || (count === 0 && length !== fixedEnd)) return INVALID;
    return undefined;
}

/** LDAPv3 definite-length BER: simple/SASL Bind, Search, and StartTLS ExtendedRequest.
 * Supports corresponding BindResponse, SearchResultEntry/Reference/Done, and StartTLS response,
 * correlated by positive message ID. Search filter nesting is limited to 32 levels. No LDAPv2,
 * indefinite BER, or unrelated extended operations.
 * https://www.rfc-editor.org/rfc/rfc4511#section-4
 * Search filters and controls are structurally validated, not authorized individually.
 */
type BerValue = {tag: number; start: number; end: number};
const START_TLS_OID = "1.3.6.1.4.1.1466.20037";

class BerReader {
    constructor(readonly bytes: Buffer, public offset: number, readonly end: number) {}

    header(expected?: number | readonly number[]): BerValue {
        if (this.offset >= this.end) throw INVALID;
        if (this.offset >= this.bytes.length) throw INCOMPLETE;
        const tag = this.bytes[this.offset]!;
        if ((tag & 31) === 31 || (expected !== undefined
            && (typeof expected === "number" ? tag !== expected : !expected.includes(tag)))) throw INVALID;
        if (this.offset + 1 >= this.end) throw INVALID;
        if (this.offset + 1 >= this.bytes.length) throw INCOMPLETE;
        const first = this.bytes[this.offset + 1]!;
        let start = this.offset + 2;
        let length = first;
        if (first >= 128) {
            const count = first & 127;
            if (count === 0 || count > 4 || start + count > this.end) throw INVALID;
            if (start + count > this.bytes.length) throw INCOMPLETE;
            length = this.bytes.readUIntBE(start, count);
            start += count;
        }
        if (start + length > this.end || start + length > MAX_CHANNEL_ENVELOPE_BYTES) throw INVALID;
        return {tag, start, end: start + length};
    }

    read(expected?: number): BerValue {
        const value = this.header(expected);
        if (value.end > this.bytes.length) throw INCOMPLETE;
        this.offset = value.end;
        return value;
    }

    child(value: BerValue): BerReader {
        return new BerReader(this.bytes, value.start, value.end);
    }

    integer(tag = 2, zero = true): number {
        const value = this.header(tag);
        const size = value.end - value.start;
        if (size < 1 || size > 4) throw INVALID;
        this.read(tag);
        if ((this.bytes[value.start]! & 128) !== 0
            || (size > 1 && this.bytes[value.start] === 0 && (this.bytes[value.start + 1]! & 128) === 0)) throw INVALID;
        const integer = this.bytes.readUIntBE(value.start, size);
        if (!zero && integer === 0) throw INVALID;
        return integer;
    }

    octets(tag = 4): Buffer {
        const value = this.read(tag);
        return this.bytes.subarray(value.start, value.end);
    }

    done(): void {
        if (this.offset !== this.end) throw INVALID;
    }
}

function inspectLdapClient(bytes: Buffer): ChannelProbe {
    return inspectLdap(bytes);
}

function inspectLdapServer(bytes: Buffer, request?: Buffer): ChannelProbe {
    if (!request || inspectLdapClient(request).status !== "match") return INVALID;
    return inspectLdap(bytes, request);
}

function inspectLdap(bytes: Buffer, request?: Buffer): ChannelProbe {
    try {
        const outer = new BerReader(bytes, 0, MAX_CHANNEL_ENVELOPE_BYTES).header(0x30);
        const reader = new BerReader(bytes, outer.start, outer.end);
        const id = reader.integer(2, false);
        let allowed = [0x60, 0x63, 0x77];
        if (request) {
            const requestOuter = new BerReader(request, 0, MAX_CHANNEL_ENVELOPE_BYTES).header(0x30);
            const initial = new BerReader(request, requestOuter.start, requestOuter.end);
            if (initial.integer(2, false) !== id) return INVALID;
            const requestTag = initial.header().tag;
            allowed = requestTag === 0x60 ? [0x61] : requestTag === 0x63 ? [0x64, 0x65, 0x73] : [0x78];
        }
        const operationHeader = reader.header(allowed);
        const operation = reader.child(operationHeader);
        validateLdapOperation(operation, operationHeader.tag);
        operation.done();
        reader.offset = operationHeader.end;
        if (reader.offset < reader.end) validateControls(reader.child(reader.read(0xa0)));
        reader.done();
        return match(outer.end);
    } catch (error) {
        if (error === INVALID) return INVALID;
        if (error === INCOMPLETE) return INCOMPLETE;
        throw error;
    }
}

function validateLdapOperation(reader: BerReader, tag: number): void {
    if (tag === 0x60) {
        if (reader.integer() !== 3) throw INVALID;
        reader.octets();
        const auth = reader.header([0x80, 0xa3]);
        if (auth.tag === 0xa3) {
            const sasl = reader.child(auth);
            if (!/^[A-Z0-9_-]{1,20}$/.test(sasl.octets().toString("latin1"))) throw INVALID;
            if (sasl.offset < sasl.end) sasl.octets();
            sasl.done();
            reader.offset = auth.end;
        } else if (auth.tag === 0x80) reader.read(0x80);
        else throw INVALID;
    } else if (tag === 0x63) {
        reader.octets();
        if (reader.integer(10) > 2 || reader.integer(10) > 3) throw INVALID;
        reader.integer();
        reader.integer();
        validateBoolean(reader);
        validateFilter(reader, 0);
        const attributes = reader.child(reader.read(0x30));
        while (attributes.offset < attributes.end) attributes.octets();
    } else if (tag === 0x77) {
        if (reader.octets(0x80).toString("latin1") !== START_TLS_OID) throw INVALID;
    } else if (tag === 0x64) {
        reader.octets();
        const attributes = reader.child(reader.read(0x30));
        while (attributes.offset < attributes.end) {
            const attribute = attributes.child(attributes.read(0x30));
            if (attribute.octets().length === 0) throw INVALID;
            const values = attribute.child(attribute.read(0x31));
            while (values.offset < values.end) values.octets();
            attribute.done();
        }
    } else if (tag === 0x73) {
        if (reader.offset === reader.end) throw INVALID;
        while (reader.offset < reader.end) if (reader.octets().length === 0) throw INVALID;
    } else {
        // LDAPResult: resultCode, matchedDN, diagnosticMessage, optional referral.
        if (reader.integer(10) > 127) throw INVALID;
        reader.octets();
        reader.octets();
        if (reader.offset < reader.end && reader.bytes[reader.offset] === 0xa3) {
            const referrals = reader.child(reader.read(0xa3));
            if (referrals.offset === referrals.end) throw INVALID;
            while (referrals.offset < referrals.end) if (referrals.octets().length === 0) throw INVALID;
        }
        if (tag === 0x61 && reader.offset < reader.end) reader.octets(0x87);
        // StartTLS responseName may be omitted, but if present must identify StartTLS.
        // responseValue is forbidden (RFC 4511 §4.14.2), including after a valid responseName.
        if (tag === 0x78 && reader.offset < reader.end
            && reader.octets(0x8a).toString("latin1") !== START_TLS_OID) throw INVALID;
    }
}

function validateBoolean(reader: BerReader): void {
    const header = reader.header(1);
    if (header.end - header.start !== 1) throw INVALID;
    const value = reader.octets(1);
    if (value[0] !== 0 && value[0] !== 255) throw INVALID;
}

function validateControls(reader: BerReader): void {
    if (reader.offset === reader.end) throw INVALID;
    while (reader.offset < reader.end) {
        const control = reader.child(reader.read(0x30));
        if (!/^[0-9]+(?:\.[0-9]+)+$/.test(control.octets().toString("latin1"))) throw INVALID;
        if (control.offset < control.end && control.bytes[control.offset] === 1) validateBoolean(control);
        if (control.offset < control.end) control.octets();
        control.done();
    }
}

function validateFilter(reader: BerReader, depth: number): void {
    if (depth > 32) throw INVALID;
    const value = reader.header([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0x87, 0xa8, 0xa9]);
    const filter = reader.child(value);
    if (value.tag === 0xa0 || value.tag === 0xa1) {
        if (filter.offset === filter.end) throw INVALID;
        while (filter.offset < filter.end) validateFilter(filter, depth + 1);
    } else if (value.tag === 0xa2) {
        validateFilter(filter, depth + 1);
    } else if ([0xa3, 0xa5, 0xa6, 0xa8].includes(value.tag)) {
        if (filter.octets().length === 0) throw INVALID;
        filter.octets();
    } else if (value.tag === 0x87) {
        if (value.start === value.end) throw INVALID;
        filter.offset = filter.end;
    } else if (value.tag === 0xa4) {
        if (filter.octets().length === 0) throw INVALID;
        const parts = filter.child(filter.read(0x30));
        if (parts.offset === parts.end) throw INVALID;
        let previous = -1;
        while (parts.offset < parts.end) {
            const part = parts.read();
            const kind = part.tag - 0x80;
            if (kind < 0 || kind > 2 || kind < previous || (kind !== 1 && kind === previous)) throw INVALID;
            previous = kind;
        }
    } else if (value.tag === 0xa9) {
        let previous = 0x80;
        let attribute = false;
        let rule = false;
        let assertion = false;
        while (filter.offset < filter.end) {
            const field = filter.read();
            if (field.tag <= previous || field.tag > 0x84) throw INVALID;
            previous = field.tag;
            if (field.tag === 0x81) rule = field.end > field.start;
            if (field.tag === 0x82) attribute = field.end > field.start;
            if (field.tag === 0x83) assertion = true;
            if (field.tag === 0x84 && (field.end - field.start !== 1
                || ![0, 255].includes(filter.bytes[field.start]!))) throw INVALID;
        }
        if (!assertion || (!attribute && !rule)) throw INVALID;
    } else throw INVALID;
    filter.done();
    if (value.end > reader.bytes.length) throw INCOMPLETE;
    reader.offset = value.end;
}
