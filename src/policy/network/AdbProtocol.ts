import type {Socket} from "node:net";

// The client/server smart-socket protocol uses a four-hex-digit byte count.
// This is distinct from the binary server/device (adbd) transport protocol.
export const MAX_ADB_REQUEST_BYTES = 4 + 0xffff;
const HANDSHAKE_TIMEOUT_MILLISECONDS = 5_000;

export function isAdbRequest(bytes: Buffer): boolean {
    if (bytes.length < 4 || !/^[0-9a-fA-F]{4}$/.test(bytes.subarray(0, 4).toString("latin1"))) return false;
    const length = Number.parseInt(bytes.subarray(0, 4).toString("ascii"), 16);
    if (length === 0 || bytes.length < 4 + length) return false;
    const request = bytes.subarray(4, 4 + length);
    if (request.some((byte) => byte < 0x20 || byte === 0x7f)) return false;
    // Recognize routing syntax, not a port or a list of permitted commands.
    // Device services follow transport selection on the already-admitted stream.
    return /^(?:host(?:-usb|-local)?:|host-serial:.+:|host-transport-id:[0-9]+:)[a-z][a-z0-9_-]*(?::|$)/
        .test(request.toString("utf8"));
}

/** Sends only the first framed request, then validates the server's response.
 * Queued client bytes stay paused until the owner admits the confirmed stream.
 */
export async function exchangeAdbHandshake(client: Socket, upstream: Socket, signal: AbortSignal): Promise<Buffer> {
    const handshakeSignal = AbortSignal.any([signal, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MILLISECONDS)]);
    const header = await readAdbBytes(client, 4, handshakeSignal);
    if (!/^[0-9a-fA-F]{4}$/.test(header.toString("latin1"))) throw new Error("Invalid ADB request length");
    const length = Number.parseInt(header.toString("ascii"), 16);
    const request = Buffer.concat([header, await readAdbBytes(client, length, handshakeSignal)]);
    if (!isAdbRequest(request)) throw new Error("Invalid ADB host request");
    handshakeSignal.throwIfAborted();
    upstream.write(request);
    const status = await readAdbBytes(upstream, 4, handshakeSignal);
    if (status.equals(Buffer.from("OKAY"))) return status;
    if (!status.equals(Buffer.from("FAIL"))) throw new Error("ADB request was not confirmed by the upstream status");
    const failureLength = await readAdbBytes(upstream, 4, handshakeSignal);
    if (!/^[0-9a-fA-F]{4}$/.test(failureLength.toString("latin1"))) throw new Error("Invalid ADB failure length");
    const reason = await readAdbBytes(upstream, Number.parseInt(failureLength.toString("ascii"), 16), handshakeSignal);
    return Buffer.concat([status, failureLength, reason]);
}

function readAdbBytes(socket: Socket, length: number, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    if (length === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
        const onReadable = () => {
            const bytes: Buffer | null = socket.read(length);
            if (bytes?.length === length) finish(undefined, bytes);
            else if (bytes) onEnd();
            else if (socket.destroyed || socket.readableEnded) onEnd();
        };
        const onEnd = () => finish(new Error("ADB peer closed during handshake"));
        const onError = (error: Error) => finish(error);
        const onAbort = () => finish(new Error("ADB handshake aborted or timed out"));
        const finish = (error?: Error, bytes?: Buffer) => {
            socket.off("readable", onReadable);
            socket.off("end", onEnd);
            socket.off("close", onEnd);
            socket.off("error", onError);
            signal.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve(bytes!);
        };
        socket.on("readable", onReadable);
        socket.once("end", onEnd);
        socket.once("close", onEnd);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, {once: true});
        onReadable();
    });
}
