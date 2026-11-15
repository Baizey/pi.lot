import type {Socket} from "node:net";
import type {NetworkApplicationProtocol} from "./NetworkProtocol.js";

/** Admission examines only the initial bounded envelope, not subsequent operations. */
export const MAX_CHANNEL_ENVELOPE_BYTES = 65_539;

export type ChannelProbe =
    | {status: "match"; length: number}
    | {status: "incomplete"}
    | {status: "invalid"};

export type ChannelInspector = (bytes: Buffer) => ChannelProbe;

export const INCOMPLETE: ChannelProbe = Object.freeze({status: "incomplete"});
export const INVALID: ChannelProbe = Object.freeze({status: "invalid"});

export interface ChannelProtocolDefinition {
    readonly protocol: NetworkApplicationProtocol;
    readonly initiation: "client" | "server";
    /** Must reject contradictory prefixes and bound all declared lengths. */
    inspectClient(bytes: Buffer): ChannelProbe;
    /** With request supplied, confirm the response to that initial request. */
    inspectServer(bytes: Buffer, request?: Buffer): ChannelProbe;
    /** Optional per-reader cursors. Input is an immutable, monotonically growing prefix. */
    createClientInspector?(): ChannelInspector;
    createServerInspector?(request?: Buffer): ChannelInspector;
    /** One-way terminal messages never admit any queued continuation or server bytes. */
    isOneWayRequest?(request: Buffer): boolean;
    /** A framed rejection can be returned without admitting an unconfirmed service. */
    isTerminalResponse?(response: Buffer, request: Buffer): boolean;
    /** Additional confirmation for envelopes shared with another protocol, such as RESP/POP3. */
    confirmServer?(upstream: Socket, request: Buffer, response: Buffer, signal: AbortSignal): Promise<void>;
}
