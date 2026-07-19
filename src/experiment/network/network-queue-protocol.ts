import {isIP} from "node:net";

const PROTOCOL_NAME = "PI_NETWORK_QUEUE";
const PROTOCOL_VERSION = "1";

export enum NetworkAddressFamily {
  IPV4 = "IPV4",
  IPV6 = "IPV6",
}

export enum NetworkDecision {
  ALLOW = "ALLOW",
  DENY = "DENY",
}

export enum NetworkOperation {
  TCP_CONNECT = "TCP_CONNECT",
}

export type NetworkEndpoint = {
  address: string;
  port: number;
};

export type NetworkPolicyEvent = {
  sequence: number;
  operation: NetworkOperation;
  family: NetworkAddressFamily;
  protocol: "tcp";
  source: NetworkEndpoint;
  destination: NetworkEndpoint;
};

export type NetworkQueueMessage =
  | {type: "READY"}
  | {type: "EVENT"; event: NetworkPolicyEvent};

export function parseNetworkQueueMessage(line: string): NetworkQueueMessage {
  const fields = line.split("\t");
  if (fields[0] !== PROTOCOL_NAME || fields[1] !== PROTOCOL_VERSION) {
    throw new Error("network queue helper used an unsupported protocol");
  }

  if (fields[2] === "READY" && fields.length === 3) return {type: "READY"};
  if (fields[2] !== "EVENT" || fields.length !== 9) {
    throw new Error("network queue helper sent a malformed record");
  }

  const sequence = parsePositiveInteger(fields[3], "sequence");
  const family = fields[4];
  const sourceAddress = fields[5];
  const sourcePort = parsePort(fields[6], "source port");
  const destinationAddress = fields[7];
  const destinationPort = parsePort(fields[8], "destination port");
  if (family !== NetworkAddressFamily.IPV4 || isIP(sourceAddress) !== 4 || isIP(destinationAddress) !== 4) {
    throw new Error("network queue helper sent an unsupported address family");
  }

  return {
    type: "EVENT",
    event: {
      sequence,
      operation: NetworkOperation.TCP_CONNECT,
      family,
      protocol: "tcp",
      source: {address: sourceAddress, port: sourcePort},
      destination: {address: destinationAddress, port: destinationPort},
    },
  };
}

export function formatNetworkQueueVerdict(sequence: number, decision: NetworkDecision): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("invalid network queue sequence");
  if (decision !== NetworkDecision.ALLOW && decision !== NetworkDecision.DENY) {
    throw new Error(`invalid network decision: ${String(decision)}`);
  }
  return `${PROTOCOL_NAME}\t${PROTOCOL_VERSION}\tVERDICT\t${sequence}\t${decision}\n`;
}

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
