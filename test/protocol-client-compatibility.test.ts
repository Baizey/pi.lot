import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {createServer, type Socket} from "node:net";
import test, {type TestContext} from "node:test";
import {channelProtocol} from "../src/policy/network/ChannelProtocols.js";
import {NetworkApplicationProtocol as Protocol} from "../src/policy/network/NetworkProtocol.js";
import {channelEnvelopes} from "./fixtures/channel-envelopes.js";

// Optional local client checks supplement canonical wire fixtures. They use disposable
// loopback listeners, never configured databases, shares, directories, or credentials.
for (const client of [
    {command: "ldapsearch", protocol: Protocol.LDAP,
        args: (port: number) => ["-x", "-H", `ldap://127.0.0.1:${port}`, "-s", "base", "-b", "", "(objectClass=*)", "-o", "nettimeout=2"]},
    {command: "smbclient", protocol: Protocol.SMB,
        args: (port: number) => ["-L", "127.0.0.1", "-p", String(port), "-N", "--option=client min protocol=SMB2"]},
    {command: "mariadb", protocol: Protocol.MYSQL,
        args: (port: number) => ["--no-defaults", "--skip-ssl", "--protocol=TCP", "--host=127.0.0.1", `--port=${port}`, "--user=fixture", "--password=fixture", "--connect-timeout=2"]},
]) {
    const installed = !spawnSync(client.command, ["--version"], {timeout: 2_000, stdio: "ignore"}).error;
    test(`installed ${client.command} emits a supported ${client.protocol} initial envelope`,
        {skip: !installed, timeout: 8_000}, async (t) => {
            const greeting = client.protocol === Protocol.MYSQL
                ? channelEnvelopes.find((entry) => entry.protocol === Protocol.MYSQL)!.response : undefined;
            const capture = await captureClient(t, client.command, client.protocol, client.args, greeting);
            if (client.protocol === Protocol.MYSQL) {
                assert.ok(capture.length >= 36, "client must accept the protocol-10 greeting and send its authentication response");
                assert.equal(capture[3], 1);
                assert.equal(capture.readUIntLE(0, 3) + 4, capture.length);
            } else {
                assert.deepEqual(channelProtocol(client.protocol)!.inspectClient(capture),
                    {status: "match", length: capture.length}, `unsupported real ${client.command} frame: ${capture.toString("hex")}`);
            }
        });
}

async function captureClient(
    t: TestContext,
    command: string,
    protocol: Protocol,
    args: (port: number) => string[],
    greeting?: Buffer,
): Promise<Buffer> {
    const sockets = new Set<Socket>();
    const chunks: Buffer[] = [];
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        if (greeting) socket.write(greeting);
        socket.on("data", (bytes: Buffer) => {
            chunks.push(bytes);
            const buffered = Buffer.concat(chunks);
            if (protocol === Protocol.MYSQL) {
                if (buffered.length >= 4 && buffered.length >= 4 + buffered.readUIntLE(0, 3)) socket.end();
            } else if (channelProtocol(protocol)!.inspectClient(buffered).status !== "incomplete") {
                socket.end();
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(command, args(address.port), {stdio: ["ignore", "ignore", "pipe"], timeout: 5_000});
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { diagnostic += chunk; });
    t.after(async () => {
        child.kill();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, `${command} did not complete its disposable handshake (exit ${code})`);
    assert.ok(chunks.length > 0, `${command} sent no initial request: ${diagnostic}`);
    return Buffer.concat(chunks);
}
