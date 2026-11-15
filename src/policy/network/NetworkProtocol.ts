import type {NetworkAddressFamily, NetworkEndpoint} from "./network-queue-protocol.js";

export enum NetworkApplicationProtocol {
    SSH = "ssh",
    SMTP = "smtp",
    ADB = "adb",
    POSTGRES = "postgres",
    MYSQL = "mysql",
    REDIS = "redis",
    MONGODB = "mongodb",
    MQTT = "mqtt",
    AMQP = "amqp",
    KAFKA = "kafka",
    NATS = "nats",
    FTP = "ftp",
    SMB = "smb",
    NFS = "nfs",
    LDAP = "ldap",
    IMAP = "imap",
    POP3 = "pop3",
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
