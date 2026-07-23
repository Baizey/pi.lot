import {isIP} from "node:net";

const PROTOCOL_NAME = "PI_NETWORK_QUEUE";
const PROTOCOL_VERSION = "3";

export enum NetworkAddressFamily {
    IPV4 = "IPV4",
    IPV6 = "IPV6",
}

export enum NetworkDecision {
    ALLOW = "ALLOW",
    DENY = "DENY",
}

export enum NetworkOperation {
    DNS_QUERY = "DNS_QUERY",
    TCP_CONNECT = "TCP_CONNECT",
    UDP_FLOW = "UDP_FLOW",
}

export type NetworkTransport = "tcp" | "udp";

export type NetworkEndpoint = {
    address: string;
    port: number;
};

export type NetworkDnsQuery = {
    name: string;
    type: string;
};

type NetworkQueueEventBase = {
    sequence: number;
    family: NetworkAddressFamily;
    source: NetworkEndpoint;
    destination: NetworkEndpoint;
};

export type NetworkQueueEvent = NetworkQueueEventBase & (
    | {
        operation: NetworkOperation.DNS_QUERY;
        transport: "udp";
        dns: NetworkDnsQuery;
    }
    | {
        operation: NetworkOperation.TCP_CONNECT;
        transport: "tcp";
    }
    | {
        operation: NetworkOperation.UDP_FLOW;
        transport: "udp";
    }
);

export type NetworkQueueMessage =
    | {type: "READY"}
    | {type: "EVENT"; event: NetworkQueueEvent};

export function parseNetworkQueueMessage(line: string): NetworkQueueMessage {
    const fields = line.split("\t");
    if (fields[0] !== PROTOCOL_NAME || fields[1] !== PROTOCOL_VERSION) {
        throw new Error("network queue helper used an unsupported protocol");
    }

    if (fields[2] === "READY" && fields.length === 3) return {type: "READY"};
    if (fields[2] !== "EVENT" || (fields.length !== 10 && fields.length !== 13)) {
        throw new Error("network queue helper sent a malformed record");
    }

    const sequence = parsePositiveInteger(fields[3], "sequence");
    const family = parseAddressFamily(fields[4]);
    const transport = parseTransport(fields[5]);
    const sourceAddress = parseAddress(fields[6], family, "source address");
    const sourcePort = parsePort(fields[7], "source port");
    const destinationAddress = parseAddress(fields[8], family, "destination address");
    const destinationPort = parsePort(fields[9], "destination port");
    const common = {
        sequence,
        family,
        source: {address: sourceAddress, port: sourcePort},
        destination: {address: destinationAddress, port: destinationPort},
    } satisfies NetworkQueueEventBase;

    if (fields.length === 13) {
        if (transport !== "udp" || destinationPort !== 53 || fields[10] !== "DNS") {
            throw new Error("network queue helper sent malformed DNS metadata");
        }
        return {
            type: "EVENT",
            event: {
                ...common,
                operation: NetworkOperation.DNS_QUERY,
                transport,
                dns: {
                    name: parseDnsName(fields[11]),
                    type: parseDnsType(fields[12]),
                },
            },
        };
    }
    if (transport === "udp" && destinationPort === 53) {
        throw new Error("network queue helper omitted DNS query metadata");
    }

    return transport === "tcp"
        ? {
            type: "EVENT",
            event: {...common, operation: NetworkOperation.TCP_CONNECT, transport},
        }
        : {
            type: "EVENT",
            event: {...common, operation: NetworkOperation.UDP_FLOW, transport},
        };
}

export function formatNetworkQueueVerdict(sequence: number, decision: NetworkDecision): string {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("invalid network queue sequence");
    if (decision !== NetworkDecision.ALLOW && decision !== NetworkDecision.DENY) {
        throw new Error(`invalid network decision: ${String(decision)}`);
    }
    return `${PROTOCOL_NAME}\t${PROTOCOL_VERSION}\tVERDICT\t${sequence}\t${decision}\n`;
}

function parseAddressFamily(value: string | undefined): NetworkAddressFamily {
    if (value === NetworkAddressFamily.IPV4 || value === NetworkAddressFamily.IPV6) return value;
    throw new Error("network queue helper sent an unsupported address family");
}

function parseTransport(value: string | undefined): NetworkTransport {
    if (value === "tcp" || value === "udp") return value;
    throw new Error("network queue helper sent an unsupported transport");
}

function parseAddress(value: string | undefined, family: NetworkAddressFamily, name: string): string {
    const expectedVersion = family === NetworkAddressFamily.IPV4 ? 4 : 6;
    if (!value || isIP(value) !== expectedVersion) throw new Error(`invalid network queue ${name}`);
    return value;
}

function parseDnsName(value: string | undefined): string {
    if (!value || value.length > 253 || value !== value.toLowerCase()) {
        throw new Error("invalid network queue DNS name");
    }
    const labels = value.split(".");
    if (labels.some((label) => (
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)
    ))) {
        throw new Error("invalid network queue DNS name");
    }
    return value;
}

function parseDnsType(value: string | undefined): string {
    const type = parsePositiveInteger(value, "DNS type");
    if (type > 65_535) throw new Error("invalid network queue DNS type");
    return DNS_TYPE_NAMES.get(type) ?? `TYPE${type}`;
}

const DNS_TYPE_NAMES = new Map<number, string>([
    [1, "A"],
    [2, "NS"],
    [5, "CNAME"],
    [6, "SOA"],
    [12, "PTR"],
    [15, "MX"],
    [16, "TXT"],
    [28, "AAAA"],
    [33, "SRV"],
    [64, "SVCB"],
    [65, "HTTPS"],
    [255, "ANY"],
]);

function parsePositiveInteger(value: string | undefined, name: string): number {
    if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid network queue ${name}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`invalid network queue ${name}`);
    return parsed;
}

function parsePort(value: string | undefined, name: string): number {
    const port = parsePositiveInteger(value, name);
    if (port > 65_535) throw new Error(`invalid network queue ${name}`);
    return port;
}
