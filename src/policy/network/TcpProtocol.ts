import type {Socket} from "node:net";

const HTTP2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const MAX_CLASSIFICATION_BYTES = 64 * 1024;
const MAX_SSH_IDENTIFICATION_BYTES = 255;
const INITIAL_CLIENT_WAIT_MILLISECONDS = 250;
const CLASSIFICATION_TIMEOUT_MILLISECONDS = 5_000;

export enum TcpApplicationProtocol {
    HTTP1 = "http1",
    HTTP2 = "http2",
    TLS = "tls",
    SSH = "ssh",
    SMTP = "smtp",
    OPAQUE = "opaque",
    SILENT = "silent",
}

export type SniffedTcpProtocol = {
    protocol: TcpApplicationProtocol;
    bytes: Buffer;
};

export type TcpProtocolSniffOptions = {
    initialWaitMilliseconds?: number;
};

/** Looks only at bounded protocol envelopes, never command names or destination ports. */
export function classifyTcpProtocol(bytes: Buffer, direction: "client" | "server"): TcpApplicationProtocol | undefined {
    if (bytes.length === 0) return undefined;
    if (direction === "server") return classifyServerGreeting(bytes);
    if (bytes.length >= 3 && bytes[0] === 0x16 && bytes[1] === 0x03) return TcpApplicationProtocol.TLS;
    const prefaceLength = Math.min(bytes.length, HTTP2_PREFACE.length);
    if (bytes.subarray(0, prefaceLength).equals(HTTP2_PREFACE.subarray(0, prefaceLength))) {
        return bytes.length >= HTTP2_PREFACE.length ? TcpApplicationProtocol.HTTP2 : undefined;
    }
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return bytes.length >= MAX_CLASSIFICATION_BYTES ? TcpApplicationProtocol.OPAQUE : undefined;
    const lineBytes = bytes.subarray(0, newline + 1);
    if (!printableLine(lineBytes)) return TcpApplicationProtocol.OPAQUE;
    const line = lineBytes.toString("ascii").replace(/\r?\n$/, "");
    if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s+\S+\s+HTTP\/1\.[01]$/.test(line)) return TcpApplicationProtocol.HTTP1;
    if (isSshIdentification(line, lineBytes.length)) return TcpApplicationProtocol.SSH;
    if (/^(?:EHLO|HELO) [^\s]+$/i.test(line) || /^(?:MAIL FROM:|RCPT TO:)/i.test(line)) {
        return TcpApplicationProtocol.SMTP;
    }
    return TcpApplicationProtocol.OPAQUE;
}

/** Returns the consumed bytes to the owner; it must replay them exactly once after authorization. */
export async function sniffTcpProtocol(
    socket: Socket,
    direction: "client" | "server",
    signal: AbortSignal,
    options: TcpProtocolSniffOptions = {},
): Promise<SniffedTcpProtocol> {
    if (signal.aborted || socket.destroyed) throw new Error("TCP protocol classification was aborted");
    return new Promise((resolve, reject) => {
        let buffered: Buffer = Buffer.alloc(0);
        let settled = false;
        let receiving = false;
        let timeout = setTimeout(onTimeout, options.initialWaitMilliseconds ?? (direction === "client"
            ? INITIAL_CLIENT_WAIT_MILLISECONDS
            : CLASSIFICATION_TIMEOUT_MILLISECONDS));
        const onData = (data: Buffer) => {
            // The final chunk can include a valid short envelope and a large body.
            // Bound the inspected prefix, retaining the rest for exactly-once replay.
            buffered = buffered.length === 0 ? data : Buffer.concat([buffered, data]);
            if (!receiving && direction === "client") {
                receiving = true;
                clearTimeout(timeout);
                timeout = setTimeout(onTimeout, CLASSIFICATION_TIMEOUT_MILLISECONDS);
            }
            const protocol = classifyTcpProtocol(buffered.subarray(0, MAX_CLASSIFICATION_BYTES), direction);
            if (protocol) finish(undefined, {protocol, bytes: buffered});
        };
        const onEnd = () => finish(new Error("TCP peer closed before a recognizable protocol envelope"));
        const onError = (error: Error) => finish(error);
        const onAbort = () => {
            if (settled) return;
            finish(new Error("TCP protocol classification was aborted"));
            // A bidirectional probe cancels its losing reader. Put its partial data
            // back before the winning handler takes ownership of either socket.
            if (buffered.length > 0 && !socket.destroyed && !socket.readableEnded) socket.unshift(buffered);
        };
        const finish = (error?: Error, result?: SniffedTcpProtocol) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.pause();
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("close", onEnd);
            socket.off("error", onError);
            signal.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve(result!);
        };
        function onTimeout(): void {
            finish(undefined, {
                protocol: buffered.length === 0 ? TcpApplicationProtocol.SILENT : TcpApplicationProtocol.OPAQUE,
                bytes: buffered,
            });
        }
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("close", onEnd);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, {once: true});
        socket.resume();
    });
}

function classifyServerGreeting(bytes: Buffer): TcpApplicationProtocol | undefined {
    let start = 0;
    let smtpGreeting = false;
    let smtpEvidence = false;
    while (start < bytes.length) {
        const newline = bytes.indexOf(0x0a, start);
        if (newline < 0) break;
        const lineBytes = bytes.subarray(start, newline + 1);
        if (!printableLine(lineBytes)) return TcpApplicationProtocol.OPAQUE;
        const line = lineBytes.toString("ascii").replace(/\r?\n$/, "");
        if (smtpGreeting) {
            if (!/^220[- ]/.test(line)) return TcpApplicationProtocol.OPAQUE;
            smtpEvidence ||= /^220[- ](?:[^\s]+\s+)?(?:Microsoft\s+)?E?SMTP(?:\s|$)/i.test(line);
            if (line[3] === " ") return smtpEvidence ? TcpApplicationProtocol.SMTP : TcpApplicationProtocol.OPAQUE;
        } else if (isSshIdentification(line, lineBytes.length)) {
            return TcpApplicationProtocol.SSH;
        } else if (/^220[- ]/.test(line)) {
            // Only SSH permits pre-identification lines. Do not mix that allowance
            // into SMTP's multiline greeting grammar or classify a generic FTP 220.
            if (start !== 0) return TcpApplicationProtocol.OPAQUE;
            smtpGreeting = true;
            smtpEvidence = /^220[- ](?:[^\s]+\s+)?(?:Microsoft\s+)?E?SMTP(?:\s|$)/i.test(line);
            if (line[3] === " ") return smtpEvidence ? TcpApplicationProtocol.SMTP : TcpApplicationProtocol.OPAQUE;
        } else if (line.startsWith("SSH-")) {
            return TcpApplicationProtocol.OPAQUE;
        }
        start = newline + 1;
    }
    return bytes.length >= MAX_CLASSIFICATION_BYTES ? TcpApplicationProtocol.OPAQUE : undefined;
}

function isSshIdentification(line: string, bytes: number): boolean {
    return bytes <= MAX_SSH_IDENTIFICATION_BYTES
        && /^SSH-(?:2\.0|1\.99)-[^\x00-\x20\x7f]+(?: [\x20-\x7e]*)?$/.test(line);
}

function printableLine(bytes: Buffer): boolean {
    return bytes.every((byte, index) => (byte >= 0x20 && byte < 0x7f)
        || (byte === 0x0a && index === bytes.length - 1)
        || (byte === 0x0d && index === bytes.length - 2));
}
