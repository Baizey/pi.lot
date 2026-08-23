// noinspection JSUnusedGlobalSymbols

import {resolvePhysicalPath} from "./path/validation";
import {ParsedUri} from "./network/ParsedUri";

export type PolicyStatus = {
    accessType: PolicyAccessType;
    lifetime: PolicyLifetime;
    status: PolicyResponse;
    reason: string;
};


export function resolveUri(accessType: PolicyAccessType, uri: string): string {
    switch (accessType) {
        case PolicyAccessType.FS_READ:
        case PolicyAccessType.FS_WRITE:
            return resolvePhysicalPath(uri)
        default:
            return new ParsedUri(uri).fullUri()
    }
}

export type Policy = {
    pattern: string;
    info: Partial<Record<PolicyAccessType, PolicyStatus>>;
};

export type PolicyDeleteRequest = {
    uri: string;
    accessTypes: PolicyAccessType[];
};

export enum PolicyAccessType {
    // File system
    FS_READ = "FS_READ",
    FS_WRITE = "FS_WRITE",

    // HTTP and HTTPS
    HTTP_ACCESS = "HTTP",
    HTTP_GET = "GET",
    HTTP_POST = "POST",
    HTTP_PUT = "PUT",
    HTTP_DELETE = "DELETE",
    HTTP_PATCH = "PATCH",
    HTTP_HEAD = "HEAD",
    HTTP_OPTIONS = "OPTIONS",

    // Real-time / RPC
    WEBSOCKET_ACCESS = "WEBSOCKET",
    GRPC_ACCESS = "GRPC",

    // Remote access
    SSH_ACCESS = "SSH",

    // Generic transport
    TCP_ACCESS = "TCP",
    UDP_ACCESS = "UDP",

    // Network services
    DNS_ACCESS = "DNS",

    // Email
    SMTP_ACCESS = "SMTP",
}

export enum PolicyFallbackResponse {
    allow = "allow",
    deny = "deny",
    ask_user = "ask_user",
    ask_llm = "ask_llm", // not implemented
}

export enum PolicyArea {
    fs_read = "fs_read",
    fs_write = "fs_write",
    web_read = "web_read",
    web_write = "web_write",
    web_tcp = "web_tcp",
    web_dns = "web_dns",
    web_udp = "web_udp",
    web_ssh = "web_ssh",
    web_websocket = "web_websocket",
    web_grpc = "web_grpc",
    web_smtp = "web_smtp",
}

export type PolicySnapshot = {
    policies: Policy[];
};

export class PolicyResult {
    constructor(
        readonly evaluatedUri: string,
        readonly evaluatedAccessType: PolicyAccessType,
        readonly matchedPattern: string,
        readonly matchedLifetime: PolicyLifetime,
        readonly matchedStatus: PolicyResponse,
        readonly matchedReason: string,
        readonly resolutionSource: PolicyResolutionSource
    ) {
    }

    static of(data: {
        evaluatedUri: string,
        evaluatedAccessType: PolicyAccessType,
        matchedPattern: string,
        matchedLifetime: PolicyLifetime,
        matchedStatus: PolicyResponse,
        matchedReason: string,
        resolutionSource: PolicyResolutionSource
    }) {
        return new PolicyResult(
            data.evaluatedUri,
            data.evaluatedAccessType,
            data.matchedPattern,
            data.matchedLifetime,
            data.matchedStatus,
            data.matchedReason,
            data.resolutionSource
        )
    }

    toDenyMessage(): string {
        return [
            `ACCESS ${this.matchedStatus}`,
            `The uri '${this.evaluatedUri}' had an attempted access of type ${this.evaluatedAccessType}`,
            `The policy for uri (and any subfiles without own policies) '${this.matchedPattern}' was triggered`,
            `Policy reason for why this was denied: ${this.matchedReason}`,
            `Policy resolution source: ${this.resolutionSource}`,
            `Policy lifetime: ${this.matchedLifetime}`,
            `This is not an OS err, This is a wakeup-call; rethink what you're attempting, is this what your task requires?`,
            `If this is truly what the user, or your super-agent asked for, report back to them for clarification`
        ].join("\n");
    }
}

export enum PolicyResponse {
    ALLOWED = "ALLOWED",
    DENIED = "DENIED",
}

export enum PolicyLifetime {
    ONCE = "ONCE",
    SESSION = "SESSION",
    LOCAL = "LOCAL",
    GLOBAL = "GLOBAL",
}

export enum PolicyResolutionSource {
    SYSTEM = "SYSTEM",
    EXISTING_USER_POLICY = "EXISTING_USER_POLICY",
    NEW_USER_DECISION = "NEW_USER_DECISION",
}

export const isModifyingAccess = (accessType: PolicyAccessType): boolean =>
    accessType !== PolicyAccessType.FS_READ && accessType !== PolicyAccessType.HTTP_GET;

export const isPersistedLifetime = (lifetime: PolicyLifetime): boolean =>
    lifetime === PolicyLifetime.LOCAL || lifetime === PolicyLifetime.GLOBAL;