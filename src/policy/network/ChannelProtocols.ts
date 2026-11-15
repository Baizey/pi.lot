import type {ChannelInspector, ChannelProtocolDefinition} from "./ChannelProtocol.js";
import {databaseProtocols} from "./DatabaseProtocols.js";
import {messagingProtocols} from "./MessagingProtocols.js";
import {fileMailProtocols} from "./FileMailProtocols.js";
import type {NetworkApplicationProtocol} from "./NetworkProtocol.js";

export const channelProtocols: readonly ChannelProtocolDefinition[] = Object.freeze([
    ...databaseProtocols,
    ...messagingProtocols,
    ...fileMailProtocols,
]);

export function channelProtocol(protocol: string): ChannelProtocolDefinition | undefined {
    return channelProtocols.find((definition) => definition.protocol === protocol);
}

export type ChannelClassification = {
    protocol?: NetworkApplicationProtocol;
    incomplete: boolean;
    ambiguous: boolean;
};

type Candidate = {protocol: NetworkApplicationProtocol; inspect: ChannelInspector};

/** One classifier owns the incremental cursors for one socket-reader lifetime. */
export class ChannelClassifier {
    private readonly candidates: readonly Candidate[];

    constructor(direction: "client" | "server") {
        this.candidates = channelProtocols.map((definition) => ({
            protocol: definition.protocol,
            inspect: direction === "client"
                ? definition.createClientInspector?.() ?? ((bytes) => definition.inspectClient(bytes))
                : definition.createServerInspector?.() ?? ((bytes) => definition.inspectServer(bytes)),
        }));
    }

    classify(bytes: Buffer): ChannelClassification {
        return classifyCandidates(this.candidates, bytes);
    }
}

const clientCandidates = channelProtocols.map((definition) => ({
    protocol: definition.protocol, inspect: (bytes: Buffer) => definition.inspectClient(bytes),
}));
const serverCandidates = channelProtocols.map((definition) => ({
    protocol: definition.protocol, inspect: (bytes: Buffer) => definition.inspectServer(bytes),
}));

/** Stateless reference classification also supports independent parser callers and tests. */
export function classifyChannelProtocol(bytes: Buffer, direction: "client" | "server"): ChannelClassification {
    return classifyCandidates(direction === "client" ? clientCandidates : serverCandidates, bytes);
}

function classifyCandidates(candidates: readonly Candidate[], bytes: Buffer): ChannelClassification {
    const matches: NetworkApplicationProtocol[] = [];
    let incomplete = false;
    for (const candidate of candidates) {
        const result = candidate.inspect(bytes);
        if (result.status === "match") matches.push(candidate.protocol);
        else if (result.status === "incomplete") incomplete = true;
    }
    return {protocol: matches.length === 1 ? matches[0] : undefined, incomplete, ambiguous: matches.length > 1};
}
