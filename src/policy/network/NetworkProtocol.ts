import type {NetworkAddressFamily, NetworkEndpoint} from "./network-queue-protocol.js";

export enum NetworkApplicationProtocol {
    SSH = "ssh",
    SMTP = "smtp",
    WEBSOCKET = "websocket",
    GRPC = "grpc",
}

export type NetworkProtocolEvent = {
    protocol: NetworkApplicationProtocol;
    uri: string;
    family: NetworkAddressFamily;
    source: NetworkEndpoint;
    destination: NetworkEndpoint;
    upstreamAddress: string;
};

export type NetworkProtocolAuthorizer = (
    event: NetworkProtocolEvent,
    signal: AbortSignal,
) => boolean | Promise<boolean>;
