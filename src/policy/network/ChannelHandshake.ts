import type {Socket} from "node:net";
import {MAX_CHANNEL_ENVELOPE_BYTES, type ChannelProbe, type ChannelProtocolDefinition} from "./ChannelProtocol.js";

const HANDSHAKE_TIMEOUT_MILLISECONDS = 5_000;

/** The admitted first request may have effects. Only its confirmed continuation is held back.
 * This is a channel grant, not validation of commands, authentication, or returned content.
 */
export async function exchangeChannelHandshake(
    client: Socket,
    upstream: Socket,
    definition: ChannelProtocolDefinition,
    signal: AbortSignal,
): Promise<boolean> {
    const handshakeSignal = AbortSignal.any([signal, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MILLISECONDS)]);
    const inspectRequest = definition.createClientInspector?.() ?? ((bytes: Buffer) => definition.inspectClient(bytes));
    const request = await readChannelEnvelope(client, inspectRequest, handshakeSignal);
    handshakeSignal.throwIfAborted();
    if (definition.isOneWayRequest?.(request)) {
        // PostgreSQL cancellation has no reply. Close both channels after flushing
        // exactly that request; neither queued operations nor upstream bytes are relayed.
        upstream.end(request, () => upstream.destroy());
        client.end(() => client.destroy());
        return false;
    }
    upstream.write(request);
    const inspectResponse = definition.createServerInspector?.(request) ?? ((bytes: Buffer) => definition.inspectServer(bytes, request));
    const response = await readChannelEnvelope(upstream, inspectResponse, handshakeSignal);
    handshakeSignal.throwIfAborted();
    if (definition.isTerminalResponse?.(response, request)) {
        // A well-framed error may explicitly say this is not the requested service.
        // Return its diagnostics, but never turn it into permission to continue.
        client.end(response, () => client.destroy());
        upstream.destroy();
        return false;
    }
    await definition.confirmServer?.(upstream, request, response, handshakeSignal);
    handshakeSignal.throwIfAborted();
    // Restore the validated envelope before any remaining upstream data, exactly once.
    upstream.unshift(response);
    return true;
}

/** Read one envelope without consuming pipelined operations or losing a coalesced response. */
export function readChannelEnvelope(
    socket: Socket,
    inspect: (bytes: Buffer) => ChannelProbe,
    signal: AbortSignal,
): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let buffered: Buffer = Buffer.alloc(0);
        let settled = false;
        const finish = (error?: Error, envelope?: Buffer) => {
            if (settled) return;
            settled = true;
            socket.off("readable", onReadable);
            socket.off("end", onEnd);
            socket.off("close", onEnd);
            socket.off("error", onError);
            signal.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve(envelope!);
        };
        const onReadable = () => {
            while (!settled && socket.readableLength > 0) {
                const available = Math.min(socket.readableLength, MAX_CHANNEL_ENVELOPE_BYTES - buffered.length);
                if (available <= 0) {
                    finish(new Error("Channel handshake envelope exceeds the size limit"));
                    return;
                }
                const bytes: Buffer | null = socket.read(available);
                if (!bytes) break;
                buffered = Buffer.concat([buffered, bytes]);
                let result: ChannelProbe;
                try {
                    result = inspect(buffered);
                } catch (error) {
                    finish(new Error("Channel handshake parser failed", {cause: error}));
                    return;
                }
                if (result.status === "invalid") {
                    finish(new Error("Channel handshake has an invalid protocol envelope"));
                    return;
                }
                if (result.status === "match") {
                    if (!Number.isSafeInteger(result.length) || result.length < 1 || result.length > buffered.length) {
                        finish(new Error("Channel parser returned an invalid envelope length"));
                        return;
                    }
                    if (buffered.length > result.length) socket.unshift(buffered.subarray(result.length));
                    finish(undefined, buffered.subarray(0, result.length));
                    return;
                }
                if (buffered.length === MAX_CHANNEL_ENVELOPE_BYTES) {
                    finish(new Error("Channel handshake envelope exceeds the size limit"));
                    return;
                }
            }
            if (!settled && (socket.destroyed || socket.readableEnded)) onEnd();
        };
        const onEnd = () => finish(new Error("Channel peer closed during handshake"));
        const onError = (error: Error) => finish(error);
        const onAbort = () => finish(new Error("Channel handshake aborted or timed out"));
        socket.on("readable", onReadable);
        socket.once("end", onEnd);
        socket.once("close", onEnd);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, {once: true});
        onReadable();
    });
}
