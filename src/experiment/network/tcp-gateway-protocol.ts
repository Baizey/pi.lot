import {isIP} from "node:net";
import {NetworkAddressFamily} from "./network-queue-protocol.js";
import type {NetworkEndpoint} from "./network-queue-protocol.js";

const PROTOCOL_NAME = "PI_TCP_GATEWAY";
const PROTOCOL_VERSION = "1";

export type TcpGatewayFlow = {
    family: NetworkAddressFamily;
    source: NetworkEndpoint;
    destination: NetworkEndpoint;
};

export function parseTcpGatewayFlow(line: string): TcpGatewayFlow {
    const fields = line.split("\t");
    if (fields[0] !== PROTOCOL_NAME || fields[1] !== PROTOCOL_VERSION) {
        throw new Error("TCP gateway ingress used an unsupported protocol");
    }
    if (fields[2] !== "FLOW" || fields.length !== 8) {
        throw new Error("TCP gateway ingress sent a malformed flow record");
    }

    const family = parseAddressFamily(fields[3]);
    return {
        family,
        source: {
            address: parseAddress(fields[4], family, "source address"),
            port: parsePort(fields[5], "source port"),
        },
        destination: {
            address: parseAddress(fields[6], family, "destination address"),
            port: parsePort(fields[7], "destination port"),
        },
    };
}

function parseAddressFamily(value: string | undefined): NetworkAddressFamily {
    if (value === NetworkAddressFamily.IPV4 || value === NetworkAddressFamily.IPV6) return value;
    throw new Error("TCP gateway ingress sent an unsupported address family");
}

function parseAddress(value: string | undefined, family: NetworkAddressFamily, name: string): string {
    const expectedVersion = family === NetworkAddressFamily.IPV4 ? 4 : 6;
    if (!value || isIP(value) !== expectedVersion) throw new Error(`invalid TCP gateway ${name}`);
    return value;
}

function parsePort(value: string | undefined, name: string): number {
    if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid TCP gateway ${name}`);
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port > 65_535) throw new Error(`invalid TCP gateway ${name}`);
    return port;
}
