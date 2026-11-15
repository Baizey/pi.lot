import {NetworkApplicationProtocol as Protocol} from "../../src/policy/network/NetworkProtocol.js";

/** Wire fixtures are built from the protocol specifications, not production encoders/parsers. */
export interface ChannelEnvelope {
    protocol: Protocol;
    initiation: "client" | "server";
    request: Buffer;
    response: Buffer;
    /** A structurally valid response which contradicts the initial request, where applicable. */
    contradictoryResponse?: Buffer;
}

const text = (value: string) => Buffer.from(value);
const be32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const le32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const le16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const packet = (body: Buffer) => Buffer.concat([be32(body.length), body]);
const rpc = (words: number[]) => Buffer.concat([be32(0x80000000 + words.length * 4), ...words.map(be32)]);
const bson = (fields: Buffer[]) => {
    const body = Buffer.concat([...fields, Buffer.from([0])]);
    return Buffer.concat([le32(body.length + 4), body]);
};
const mongo = (id: number, responseTo: number, document: Buffer) => {
    const body = Buffer.concat([le32(id), le32(responseTo), le32(2013), le32(0), Buffer.from([0]), document]);
    return Buffer.concat([le32(body.length + 4), body]);
};
const smb = (response: boolean, messageId = 42) => {
    const header = Buffer.alloc(64);
    Buffer.from([0xfe, 0x53, 0x4d, 0x42]).copy(header);
    header.writeUInt16LE(64, 4);
    header.writeUInt16LE(1, 6);
    header.writeUInt16LE(1, 14);
    header.writeUInt32LE(response ? 1 : 0, 16);
    header.writeBigUInt64LE(BigInt(messageId), 24);
    const body = Buffer.alloc(response ? 64 : 38);
    body.writeUInt16LE(response ? 65 : 36);
    body.writeUInt16LE(1, 2);
    if (response) {
        body.writeUInt16LE(0x0202, 4);
        body.writeUInt32LE(65_536, 28);
        body.writeUInt32LE(65_536, 32);
        body.writeUInt32LE(65_536, 36);
        body.writeUInt16LE(128, 56);
    } else {
        body.writeUInt16LE(1, 4);
        body.writeUInt16LE(0x0202, 36);
    }
    return packet(Buffer.concat([header, body]));
};

const mysqlGreeting = (() => {
    // Protocol 10: version, connection id, salt, capabilities, charset/status, plugin salt/name.
    const body = Buffer.concat([
        Buffer.from([10]), text("8.0.36\0"), le32(7), text("12345678\0"), le16(0x8201),
        Buffer.from([0x21]), le16(2), le16(0x0008), Buffer.from([21]), Buffer.alloc(10),
        text("abcdefghijkl\0mysql_native_password\0"),
    ]);
    const header = Buffer.alloc(4);
    header.writeUIntLE(body.length, 0, 3);
    return Buffer.concat([header, body]);
})();
const postgresStartup = Buffer.concat([be32(196608), text("user\0fixture\0database\0fixture\0\0")]);
const hello = bson([Buffer.concat([Buffer.from([0x10]), text("hello\0"), le32(1)]),
    Buffer.concat([Buffer.from([0x02]), text("$db\0"), le32(6), text("admin\0")])]);
const okDouble = Buffer.alloc(8);
okDouble.writeDoubleLE(1);
const mongoReply = bson([Buffer.concat([Buffer.from([1]), text("ok\0"), okDouble])]);
const amqpStart = Buffer.concat([Buffer.from([0, 10, 0, 10, 0, 9]), be32(0), be32(5), text("PLAIN"), be32(5), text("en_US")]);

export const channelEnvelopes: readonly ChannelEnvelope[] = [
    {protocol: Protocol.POSTGRES, initiation: "client",
        request: Buffer.concat([be32(postgresStartup.length + 4), postgresStartup]),
        response: Buffer.concat([text("R"), be32(8), be32(0)])},
    {protocol: Protocol.MYSQL, initiation: "server", request: Buffer.from([3, 0, 0, 1, 0, 0xff, 0]), response: mysqlGreeting},
    {protocol: Protocol.REDIS, initiation: "client", request: text("*1\r\n$4\r\nPING\r\n"), response: text("+PONG\r\n")},
    {protocol: Protocol.MONGODB, initiation: "client", request: mongo(42, 0, hello), response: mongo(43, 42, mongoReply),
        contradictoryResponse: mongo(43, 99, mongoReply)},
    {protocol: Protocol.MQTT, initiation: "client",
        request: Buffer.concat([Buffer.from([0x10, 19, 0, 4]), text("MQTT"), Buffer.from([4, 2, 0, 60, 0, 7]), text("fixture")]),
        response: Buffer.from([0x20, 2, 0, 0])},
    {protocol: Protocol.AMQP, initiation: "client", request: Buffer.from([65, 77, 81, 80, 0, 0, 9, 1]),
        response: Buffer.concat([Buffer.from([1, 0, 0]), be32(amqpStart.length), amqpStart, Buffer.from([0xce])])},
    {protocol: Protocol.KAFKA, initiation: "client",
        request: packet(Buffer.concat([Buffer.from([0, 18, 0, 0]), be32(42), Buffer.from([0, 7]), text("fixture")])),
        response: packet(Buffer.concat([be32(42), Buffer.from([0, 0]), be32(1), Buffer.from([0, 18, 0, 0, 0, 3])])),
        contradictoryResponse: packet(Buffer.concat([be32(99), Buffer.from([0, 0]), be32(0)]))},
    {protocol: Protocol.NATS, initiation: "server", request: text("CONNECT {}\r\nPING\r\n"),
        response: text('INFO {"server_id":"fixture","version":"2.10.0","go":"go1.23.1","proto":1,"host":"127.0.0.1","port":4222,"max_payload":1048576}\r\n')},
    {protocol: Protocol.FTP, initiation: "server", request: text("USER fixture\r\n"), response: text("220 fixture FTP server ready\r\n")},
    {protocol: Protocol.SMB, initiation: "client", request: smb(false), response: smb(true), contradictoryResponse: smb(true, 99)},
    {protocol: Protocol.NFS, initiation: "client", request: rpc([42, 0, 2, 100003, 3, 0, 0, 0, 0, 0]),
        response: rpc([42, 1, 0, 0, 0, 0]), contradictoryResponse: rpc([99, 1, 0, 0, 0, 0])},
    {protocol: Protocol.LDAP, initiation: "client", request: Buffer.from("300c020101600702010304008000", "hex"),
        response: Buffer.from("300c02010161070a010004000400", "hex"),
        contradictoryResponse: Buffer.from("300c02010261070a010004000400", "hex")},
    {protocol: Protocol.IMAP, initiation: "server", request: text("A001 CAPABILITY\r\n"), response: text("* OK [CAPABILITY IMAP4rev1] fixture ready\r\n")},
    {protocol: Protocol.POP3, initiation: "server", request: text("USER fixture\r\n"), response: text("+OK fixture POP3 server ready\r\n")},
];
