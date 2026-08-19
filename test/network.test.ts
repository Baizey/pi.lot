import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {createSocket} from "node:dgram";
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createServer as createHttpServer} from "node:http";
import {createServer as createHttpsServer} from "node:https";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NetworkAddressFamily,
  NetworkDecision,
  NetworkDecisionCoordinator,
  NetworkOperation,
  NetworkTargetKind,
  parseNetworkQueueMessage,
  runNetworkSandboxedCommand,
} from "../src/policy/network/NetworkSandbox.js";
import {parseTcpGatewayFlow} from "../src/policy/network/tcp-gateway-protocol.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";

const JAVA_TOOLCHAIN_AVAILABLE = ["java", "javac"].every(
  (command) => spawnSync(command, ["-version"], {stdio: "ignore"}).status === 0,
);

test("the network queue protocol validates IPv4, IPv6, TCP, UDP, and DNS events", () => {
  assert.deepEqual(parseNetworkQueueMessage("PI_NETWORK_QUEUE\t3\tREADY"), {type: "READY"});
  assert.deepEqual(
    parseNetworkQueueMessage("PI_NETWORK_QUEUE\t3\tEVENT\t7\tIPV4\ttcp\t10.0.2.100\t33708\t1.1.1.1\t443"),
    {
      type: "EVENT",
      event: {
        sequence: 7,
        operation: NetworkOperation.TCP_CONNECT,
        family: NetworkAddressFamily.IPV4,
        transport: "tcp",
        source: {address: "10.0.2.100", port: 33708},
        destination: {address: "1.1.1.1", port: 443},
      },
    },
  );
  assert.deepEqual(
    parseNetworkQueueMessage("PI_NETWORK_QUEUE\t3\tEVENT\t8\tIPV6\tudp\tfd00::100\t40000\tfd00::3\t53\tDNS\texample.com\t28"),
    {
      type: "EVENT",
      event: {
        sequence: 8,
        operation: NetworkOperation.DNS_QUERY,
        family: NetworkAddressFamily.IPV6,
        transport: "udp",
        source: {address: "fd00::100", port: 40000},
        destination: {address: "fd00::3", port: 53},
        dns: {name: "example.com", type: "AAAA"},
      },
    },
  );
  assert.throws(() => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t2\tREADY"), /unsupported protocol/);
  assert.throws(
    () => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t3\tEVENT\t0\tIPV4\ttcp\t10.0.2.100\t33708\t1.1.1.1\t443"),
    /sequence/,
  );
  assert.throws(
    () => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t3\tEVENT\t9\tIPV4\tudp\t::1\t33708\t1.1.1.1\t53\tDNS\texample.com\t1"),
    /source address/,
  );
  assert.throws(
    () => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t3\tEVENT\t10\tIPV4\tudp\t10.0.2.100\t33708\t10.0.2.3\t53"),
    /omitted DNS query metadata/,
  );
});

test("the TCP gateway protocol validates transparent IPv4 and IPv6 flow metadata", () => {
  assert.deepEqual(
    parseTcpGatewayFlow("PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t10.200.0.2\t41000\t1.1.1.1\t443"),
    {
      family: NetworkAddressFamily.IPV4,
      source: {address: "10.200.0.2", port: 41000},
      destination: {address: "1.1.1.1", port: 443},
    },
  );
  assert.deepEqual(
    parseTcpGatewayFlow("PI_TCP_GATEWAY\t1\tFLOW\tIPV6\tfd42:7069::2\t41001\t2606:4700:4700::1111\t443"),
    {
      family: NetworkAddressFamily.IPV6,
      source: {address: "fd42:7069::2", port: 41001},
      destination: {address: "2606:4700:4700::1111", port: 443},
    },
  );
  assert.throws(
    () => parseTcpGatewayFlow("PI_TCP_GATEWAY\t2\tFLOW\tIPV4\t10.200.0.2\t41000\t1.1.1.1\t443"),
    /unsupported protocol/,
  );
  assert.throws(
    () => parseTcpGatewayFlow("PI_TCP_GATEWAY\t1\tFLOW\tIPV4\tfd42:7069::2\t41000\t1.1.1.1\t443"),
    /source address/,
  );
});

test("the network worker preserves host access, has no gate capabilities, and denies UDP before host effect", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-closed-test-"));
  const hostDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-network-host-access-"));
  const hostWritePath = path.join(hostDirectory, "written-by-worker.txt");
  const socketPath = path.join(hostDirectory, "service.sock");

  const unixServer = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nLOCAL");
    });
  });
  await new Promise<void>((resolve, reject) => {
    unixServer.once("error", reject);
    unixServer.listen(socketPath, resolve);
  });

  const udpServer = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    udpServer.once("error", reject);
    udpServer.bind(0, "127.0.0.1", resolve);
  });
  const udpAddress = udpServer.address();
  let datagrams = 0;
  let decisions = 0;
  udpServer.on("message", () => {
    datagrams++;
  });
  let output = "";

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          "if nft list ruleset >/dev/null 2>&1; then exit 91; fi",
          "printf device-ok > /dev/null",
          `printf host-write > ${shellQuote(hostWritePath)}`,
          "id -u",
          "id -g",
          "printf 'pid=%s\\n' \"$$\"",
          `if [ -e /proc/${process.pid} ]; then exit 92; fi`,
          "grep '^CapEff:' /proc/self/status",
          "grep '^hosts:' /etc/nsswitch.conf",
          `curl --unix-socket ${shellQuote(socketPath)} --silent http://localhost`,
          `printf x > /dev/udp/10.0.2.2/${udpAddress.port} || true`,
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      decide() {
        decisions++;
        return NetworkDecision.DENY;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(result.exitCode, 0);
    assert.match(output, new RegExp(`^${process.getuid?.()}\\n${process.getgid?.()}$`, "m"));
    assert.match(output, /^pid=2$/m);
    assert.match(output, /^CapEff:\s+0+$/m);
    assert.match(output, /^hosts:\s+files myhostname dns$/m);
    assert.match(output, /LOCAL/);
    assert.equal(readFileSync(hostWritePath, "utf8"), "host-write");
    assert.equal(decisions, 1);
    assert.equal(datagrams, 0);
  } finally {
    udpServer.close();
    await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
    rmSync(hostDirectory, {recursive: true, force: true});
  }
});

test("loopback TCP is mediated as a localhost target", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-localhost-test-"));
  let output = "";
  const events: Array<{kind: NetworkTargetKind; address: string}> = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        [
          "import {createServer, get} from 'node:http'",
          "const server = createServer((_request, response) => response.end('LOCAL'))",
          "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))",
          "const port = server.address().port",
          "const body = await new Promise((resolve, reject) => get(`http://127.0.0.1:${port}`, (response) => { let value = ''; response.on('data', (chunk) => value += chunk); response.on('end', () => resolve(value)); }).on('error', reject))",
          "console.log(body)",
          "await new Promise((resolve) => server.close(resolve))",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      decide(event) {
        events.push({
          kind: event.target.kind,
          address: event.operation === NetworkOperation.DNS_QUERY ? "" : event.target.address,
        });
        return NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "LOCAL\n");
    assert.deepEqual(events, [{
      kind: NetworkTargetKind.LOCALHOST,
      address: "127.0.0.1",
    }]);
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("an unknown synthetic destination fails closed without becoming a literal IP target", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-synthetic-deny-test-"));
  const errors: string[] = [];
  let decisions = 0;

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        "curl --noproxy '*' --connect-timeout 2 --silent http://198.18.0.99 >/dev/null 2>&1 || true",
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onDecisionError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      decide() {
        decisions++;
        return NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(decisions, 0);
    assert.deepEqual(errors, ["expired or unknown synthetic DNS lease: 198.18.0.99"]);
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("a denied DNS query has no upstream resolver effect", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-dns-deny-test-"));
  const dnsServer = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    dnsServer.once("error", reject);
    dnsServer.bind(0, "127.0.0.1", resolve);
  });
  const dnsAddress = dnsServer.address();
  let upstreamQueries = 0;
  let decisions = 0;
  dnsServer.on("message", () => {
    upstreamQueries++;
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        "import {resolve4} from 'node:dns/promises'; await resolve4('denied.test').catch(() => {});",
      ],
      cwd: workspace,
      dnsUpstream: {address: dnsAddress.address, port: dnsAddress.port},
      timeoutSeconds: 10,
      decide() {
        decisions++;
        return NetworkDecision.DENY;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(result.exitCode, 0);
    assert.ok(decisions > 0);
    assert.equal(upstreamQueries, 0);
  } finally {
    dnsServer.close();
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the network worker routes ordinary DNS through a gated UDP flow", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-dns-test-"));
  let output = "";
  const events: Array<{
    operation: NetworkOperation;
    transport: string;
    destination: string;
    dns?: {name: string; type: string};
  }> = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        "import {resolve4, resolve6} from 'node:dns/promises'; const first = await Promise.all([resolve4('localhost'), resolve6('localhost')]); const second = await Promise.all([resolve4('localhost'), resolve6('localhost')]); console.log([...first.flat(), ...second.flat()].join('\\n'));",
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      decide(event) {
        events.push({
          operation: event.operation,
          transport: event.transport,
          destination: `${event.destination.address}:${event.destination.port}`,
          dns: event.operation === NetworkOperation.DNS_QUERY ? event.dns : undefined,
        });
        return NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(output, /198\.18\./);
    assert.match(output, /2001:2::/);
    assert.equal(events.length, 4);
    assert.equal(events.every((event) => event.operation === NetworkOperation.DNS_QUERY), true);
    assert.equal(events.every((event) => event.transport === "udp"), true);
    assert.equal(events.every((event) => event.destination === "10.0.2.3:53"), true);
    assert.deepEqual(
      events.map((event) => `${event.dns?.name} ${event.dns?.type}`).sort(),
      ["localhost A", "localhost A", "localhost AAAA", "localhost AAAA"],
    );
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("cancellation closes an in-flight upstream DNS request", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-dns-cancel-test-"));
  const dnsServer = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    dnsServer.once("error", reject);
    dnsServer.bind(0, "127.0.0.1", resolve);
  });
  const dnsAddress = dnsServer.address();
  let receiveQuery!: () => void;
  const queryReceived = new Promise<void>((resolve) => {
    receiveQuery = resolve;
  });
  dnsServer.once("message", receiveQuery);
  const controller = new AbortController();

  try {
    const running = runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        "import {resolve4} from 'node:dns/promises'; await resolve4('cancel.test');",
      ],
      cwd: workspace,
      dnsUpstream: {address: dnsAddress.address, port: dnsAddress.port},
      signal: controller.signal,
      timeoutSeconds: 10,
      decide() {
        return NetworkDecision.ALLOW;
      },
    });

    await Promise.race([
      queryReceived,
      running.then(() => {
        throw new Error("network command exited before sending its DNS query");
      }),
    ]);
    const cancelledAt = Date.now();
    controller.abort();
    await assert.rejects(running, /aborted/);
    assert.ok(Date.now() - cancelledAt < 2_000);
  } finally {
    dnsServer.close();
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("a synthetic IPv4 DNS lease attributes and forwards a hostname connection", async () => {
  await verifySyntheticHostnameConnection({
    hostname: "ipv4.service.test",
    hostListenAddress: "127.0.0.1",
    dnsAddresses: {ipv4: "10.0.2.2"},
    realAddress: "10.0.2.2",
    syntheticAddress: "198.18.0.1",
  });
});

test("a synthetic IPv6 DNS lease attributes and forwards a hostname connection", async () => {
  await verifySyntheticHostnameConnection({
    hostname: "ipv6.service.test",
    hostListenAddress: "::1",
    dnsAddresses: {ipv6: "fd00::2"},
    realAddress: "fd00::2",
    syntheticAddress: "2001:2::1",
    globalIpv6Available: false,
  });
});

test("DNS omits global IPv6 answers when the gateway host cannot route them", async () => {
  await verifySyntheticHostnameConnection({
    hostname: "ipv4-fallback.service.test",
    hostListenAddress: "127.0.0.1",
    dnsAddresses: {ipv4: "10.0.2.2", ipv6: "2001:db8::8"},
    realAddress: "10.0.2.2",
    syntheticAddress: "198.18.0.1",
    globalIpv6Available: false,
  });
});

test("a synthetic lease preserves the requested hostname through a CNAME chain", async () => {
  await verifySyntheticHostnameConnection({
    hostname: "alias.service.test",
    cname: "backend.service.test",
    hostListenAddress: "127.0.0.1",
    dnsAddresses: {ipv4: "10.0.2.2"},
    realAddress: "10.0.2.2",
    syntheticAddress: "198.18.0.1",
  });
});

test("the network worker denies then allows separate TCP connection attempts", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-test-"));
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://10.0.2.2:${address.port}`;

  let acceptedConnections = 0;
  server.on("connection", () => {
    acceptedConnections++;
  });
  const events: Array<{destinationPort: number; decision: NetworkDecision}> = [];
  let output = "";

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `if curl --connect-timeout 4 --silent ${url} >/dev/null 2>&1; then exit 90; fi`,
          `sh -c 'curl --connect-timeout 6 --silent ${url}'`,
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 20,
      onStdout(data) {
        output += data.toString();
      },
      decide(event) {
        const decision = events.length === 0 ? NetworkDecision.DENY : NetworkDecision.ALLOW;
        events.push({destinationPort: event.destination.port, decision});
        return decision;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(output, "OK");
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(events, [
      {destinationPort: address.port, decision: NetworkDecision.DENY},
      {destinationPort: address.port, decision: NetworkDecision.ALLOW},
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTP gateway authorizes actual methods and paths before creating an upstream connection", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-http-gateway-test-"));
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  let output = "";
  const gatewayErrors: string[] = [];
  const requests: Array<{method: string; url: string; path: string}> = [];
  server.on("connection", () => {
    acceptedConnections++;
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `curl --noproxy '*' --silent --path-as-is --request DELETE 'http://10.0.2.2:${address.port}/baizey/allowed/../blocked?ref=main' >/dev/null`,
          `curl --noproxy '*' --silent --path-as-is --request POST --data '' 'http://10.0.2.2:${address.port}/baizey/intermediate/../allowed'`,
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      onDecisionError(error) {
        gatewayErrors.push(error instanceof Error ? error.message : String(error));
      },
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        requests.push({method: event.method, url: event.url, path: event.path});
        assert.equal(acceptedConnections, 0);
        return event.path === "/baizey/allowed";
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "OK");
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(gatewayErrors, []);
    assert.deepEqual(requests, [
      {
        method: "DELETE",
        url: `http://10.0.2.2:${address.port}/baizey/blocked?ref=main`,
        path: "/baizey/blocked?ref=main",
      },
      {
        method: "POST",
        url: `http://10.0.2.2:${address.port}/baizey/allowed`,
        path: "/baizey/allowed",
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway terminates TLS and denies a method and path before upstream TLS", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-https-gateway-test-"));
  const upstreamAuthority = new TlsCertificateAuthority();
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials("10.0.2.2"),
    (_request, response) => response.end("OK"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  let output = "";
  const gatewayErrors: string[] = [];
  const requests: Array<{scheme: string; method: string; url: string; path: string}> = [];
  server.on("connection", () => {
    acceptedConnections++;
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `curl --noproxy '*' --silent --request DELETE 'https://10.0.2.2:${address.port}/baizey/blocked' >/dev/null`,
          `curl --noproxy '*' --silent --request POST --data '' 'https://10.0.2.2:${address.port}/baizey/allowed?ref=main'`,
        ].join("; "),
      ],
      cwd: workspace,
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 15,
      onStdout(data) {
        output += data.toString();
      },
      onDecisionError(error) {
        gatewayErrors.push(error instanceof Error ? error.message : String(error));
      },
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        requests.push({
          scheme: event.scheme,
          method: event.method,
          url: event.url,
          path: event.path,
        });
        assert.equal(acceptedConnections, 0);
        return event.path === "/baizey/allowed?ref=main";
      },
    });

    assert.equal(result.exitCode, 0, gatewayErrors.join("\n"));
    assert.equal(output, "OK");
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(gatewayErrors, []);
    assert.deepEqual(requests, [
      {
        scheme: "https",
        method: "DELETE",
        url: `https://10.0.2.2:${address.port}/baizey/blocked`,
        path: "/baizey/blocked",
      },
      {
        scheme: "https",
        method: "POST",
        url: `https://10.0.2.2:${address.port}/baizey/allowed?ref=main`,
        path: "/baizey/allowed?ref=main",
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway provides its interception CA to Java JSSE clients", {skip: !JAVA_TOOLCHAIN_AVAILABLE}, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-java-trust-test-"));
  const sourceFile = path.join(workspace, "HttpsProbe.java");
  writeFileSync(sourceFile, [
    "import java.io.ByteArrayOutputStream;",
    "import java.io.InputStream;",
    "import java.net.URL;",
    "import javax.net.ssl.HttpsURLConnection;",
    "public class HttpsProbe {",
    "  public static void main(String[] arguments) throws Exception {",
    "    HttpsURLConnection connection = (HttpsURLConnection) new URL(arguments[0]).openConnection();",
    "    connection.setRequestMethod(\"GET\");",
    "    int status = connection.getResponseCode();",
    "    InputStream input = connection.getInputStream();",
    "    ByteArrayOutputStream body = new ByteArrayOutputStream();",
    "    byte[] buffer = new byte[1024];",
    "    for (int read; (read = input.read(buffer)) >= 0;) body.write(buffer, 0, read);",
    "    System.out.print(status + \":\" + new String(body.toByteArray(), \"UTF-8\"));",
    "  }",
    "}",
  ].join("\n"));
  const compilation = spawnSync("javac", [sourceFile], {encoding: "utf8"});
  assert.equal(compilation.status, 0, `${compilation.stdout}\n${compilation.stderr}`);
  const upstreamAuthority = new TlsCertificateAuthority();
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials("10.0.2.2"),
    (_request, response) => response.end("JAVA"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let output = "";
  let errorOutput = "";
  const gatewayErrors: string[] = [];
  const requests: Array<{method: string; path: string}> = [];
  try {
    const result = await runNetworkSandboxedCommand({
      command: ["java", "-cp", workspace, "HttpsProbe", `https://10.0.2.2:${address.port}/from-java?mode=jsse`],
      cwd: workspace,
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 30,
      onStdout(data) {
        output += data.toString();
      },
      onStderr(data) {
        errorOutput += data.toString();
      },
      onDecisionError(error) {
        gatewayErrors.push(error instanceof Error ? error.message : String(error));
      },
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        requests.push({method: event.method, path: event.path});
        return true;
      },
    });

    assert.equal(result.exitCode, 0, `${errorOutput}\n${gatewayErrors.join("\n")}`);
    assert.equal(output, "200:JAVA");
    assert.deepEqual(gatewayErrors, []);
    assert.deepEqual(requests, [{method: "GET", path: "/from-java?mode=jsse"}]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway uses SNI when an application supplies its own address mapping", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-https-sni-test-"));
  const hostname = "application-resolved.test";
  const upstreamAuthority = new TlsCertificateAuthority();
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials(hostname),
    (_request, response) => response.end("SNI"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let output = "";
  const operations: NetworkOperation[] = [];
  const requests: Array<{hostname: string; destination: string; url: string}> = [];
  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        `curl --noproxy '*' --silent --resolve '${hostname}:${address.port}:10.0.2.2' 'https://${hostname}:${address.port}/from-sni'`,
      ],
      cwd: workspace,
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 15,
      onStdout(data) {
        output += data.toString();
      },
      decide(event) {
        operations.push(event.operation);
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        requests.push({
          hostname: event.hostname,
          destination: event.destination.address,
          url: event.url,
        });
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "SNI");
    assert.deepEqual(operations, [NetworkOperation.TCP_CONNECT]);
    assert.deepEqual(requests, [{
      hostname,
      destination: "10.0.2.2",
      url: `https://${hostname}:${address.port}/from-sni`,
    }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("request-aware mode fails closed instead of forwarding an opaque TCP preface", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-opaque-deny-test-"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  const decisionErrors: string[] = [];
  const gatewayErrors: string[] = [];
  server.on("connection", () => {
    acceptedConnections++;
  });
  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        `printf 'SSH-2.0-test\\r\\n' > /dev/tcp/10.0.2.2/${address.port} || true; sleep 0.2`,
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onDecisionError(error) {
        decisionErrors.push(error instanceof Error ? error.message : String(error));
      },
      onNetworkError(error) {
        gatewayErrors.push(error instanceof Error ? error.message : String(error));
      },
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest() {
        throw new Error("opaque bytes must not become an HTTP request event");
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(acceptedConnections, 0);
    assert.deepEqual(decisionErrors, []);
    assert.deepEqual(gatewayErrors, ["request-aware gateway denied an opaque TCP protocol"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("coarse network inspection relays plaintext HTTP bytes without request mediation", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-coarse-http-test-"));
  let expectedRequest = "";
  let receivedRequest = "";
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      receivedRequest += data.toString();
      if (Buffer.byteLength(receivedRequest) >= Buffer.byteLength(expectedRequest)) {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  expectedRequest = [
    "pOsT /raw/../target?mode=coarse HTTP/1.1",
    `hOsT: 10.0.2.2:${address.port}`,
    "X-Unusual-Header: first",
    "x-unusual-header: second",
    "Content-Length: 4",
    "Connection: close",
    "",
    "BODY",
  ].join("\r\n");
  const encodedRequest = Buffer.from(expectedRequest).toString("base64");
  let output = "";
  const operations: NetworkOperation[] = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        [
          "import {createConnection} from 'node:net'",
          `const request = Buffer.from('${encodedRequest}', 'base64')`,
          `const socket = createConnection(${address.port}, '10.0.2.2', () => socket.write(request))`,
          "socket.on('data', (data) => process.stdout.write(data))",
          "await new Promise((resolve, reject) => { socket.once('end', resolve); socket.once('error', reject) })",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      decide(event) {
        operations.push(event.operation);
        return NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(receivedRequest, expectedRequest);
    assert.match(output, /\r\n\r\nOK$/);
    assert.deepEqual(operations, [NetworkOperation.TCP_CONNECT]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("TLS remains end-to-end when request-aware HTTPS mediation is not configured", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-opaque-tls-test-"));
  const upstreamAuthority = new TlsCertificateAuthority();
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials("10.0.2.2"),
    (_request, response) => response.end("OPAQUE"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let output = "";
  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        `curl --noproxy '*' --silent 'https://10.0.2.2:${address.port}/opaque'`,
      ],
      cwd: workspace,
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 15,
      onStdout(data) {
        output += data.toString();
      },
      decide() {
        return NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "OPAQUE");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway observes the exact smart-HTTP URL produced by git fetch", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-https-hostname-test-"));
  const hostname = "secure.service.test";
  const upstreamAuthority = new TlsCertificateAuthority();
  const upstreamPaths: string[] = [];
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials(hostname),
    (request, response) => {
      upstreamPaths.push(request.url ?? "");
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const dnsServer = createSocket("udp4");
  dnsServer.on("message", (query, remote) => {
    dnsServer.send(createTestDnsResponse(query, {ipv4: "10.0.2.2"}), remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    dnsServer.once("error", reject);
    dnsServer.bind(0, "127.0.0.1", resolve);
  });
  const dnsAddress = dnsServer.address();

  const requests: Array<{hostname: string; method: string; url: string; path: string}> = [];
  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          "git init --quiet",
          `git remote add origin 'https://${hostname}:${address.port}/baizey/repository.git'`,
          "GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch origin >/dev/null 2>&1 || true",
        ].join("; "),
      ],
      cwd: workspace,
      dnsUpstream: {address: dnsAddress.address, port: dnsAddress.port},
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 15,
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        requests.push({
          hostname: event.hostname,
          method: event.method,
          url: event.url,
          path: event.path,
        });
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(requests, [{
      hostname,
      method: "GET",
      url: `https://${hostname}:${address.port}/baizey/repository.git/info/refs?service=git-upload-pack`,
      path: "/baizey/repository.git/info/refs?service=git-upload-pack",
    }]);
    assert.deepEqual(upstreamPaths, [
      "/baizey/repository.git/info/refs?service=git-upload-pack",
    ]);
  } finally {
    dnsServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway preserves noninteractive Git credentials without allowing prompts", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-git-auth-test-"));
  const helperPath = path.join(workspace, "credential-helper.sh");
  const askpassPath = path.join(workspace, "askpass.sh");
  const askpassMarker = path.join(workspace, "askpass-invoked");
  writeFileSync(helperPath, [
    "#!/bin/sh",
    "while IFS= read -r line && [ -n \"$line\" ]; do :; done",
    "printf 'username=pilot\\npassword=secret\\n'",
    "",
  ].join("\n"), {mode: 0o700});
  writeFileSync(askpassPath, [
    "#!/bin/sh",
    `touch ${shellQuote(askpassMarker)}`,
    "printf 'should-not-be-used\\n'",
    "",
  ].join("\n"), {mode: 0o700});
  const expectedAuthorization = `Basic ${Buffer.from("pilot:secret").toString("base64")}`;
  const upstreamAuthority = new TlsCertificateAuthority();
  const authorizationHeaders: Array<string | undefined> = [];
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials("10.0.2.2"),
    (request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, {"www-authenticate": "Basic realm=\"pilot-test\""});
        response.end("credentials required");
        return;
      }
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `git -c credential.helper=${shellQuote(`!${helperPath}`)} ls-remote 'https://10.0.2.2:${address.port}/baizey/repository.git' >/dev/null 2>&1 || true`,
          `if git -c credential.helper= ls-remote 'https://10.0.2.2:${address.port}/baizey/repository.git' >/dev/null 2>&1; then exit 90; fi`,
        ].join("; "),
      ],
      cwd: workspace,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "1",
        GIT_ASKPASS: askpassPath,
        GIT_CREDENTIAL_INTERACTIVE: "always",
        GCM_INTERACTIVE: "Always",
        GH_PROMPT_DISABLED: "0",
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: "force",
      },
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 15,
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest() {
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(authorizationHeaders[0], undefined);
    assert.equal(authorizationHeaders.includes(expectedAuthorization), true);
    assert.equal(existsSync(askpassMarker), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway preserves end-to-end request and response data", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-https-integrity-test-"));
  const requestPath = path.join(workspace, "request.bin");
  const responsePath = path.join(workspace, "response.bin");
  const responseHeadersPath = path.join(workspace, "response.headers");
  const requestBody = patternedBuffer(2 * 1024 * 1024, 17);
  const responseBody = patternedBuffer(3 * 1024 * 1024, 91);
  writeFileSync(requestPath, requestBody);
  const upstreamAuthority = new TlsCertificateAuthority();
  let receivedMethod = "";
  let receivedTarget = "";
  let receivedHeaders: string[] = [];
  let receivedBody = Buffer.alloc(0);
  let receivedContinue = false;
  const handleRequest: Parameters<typeof createHttpsServer>[1] = (request, response) => {
    receivedMethod = request.method ?? "";
    receivedTarget = request.url ?? "";
    receivedHeaders = request.rawHeaders;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = Buffer.concat(chunks);
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("x-pilot-duplicate", ["response-one", "response-two"]);
      response.end(responseBody);
    });
  };
  const server = createHttpsServer(upstreamAuthority.serverCredentials("10.0.2.2"));
  server.on("request", handleRequest);
  server.on("checkContinue", (request, response) => {
    receivedContinue = true;
    response.writeContinue();
    handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          "curl --noproxy '*' --silent --show-error --http1.1 --path-as-is",
          "--request POST",
          "--header 'authorization: Bearer pilot-test-token'",
          "--header 'git-protocol: version=2'",
          "--header 'expect: 100-continue'",
          "--header 'x-pilot-duplicate: request-one'",
          "--header 'x-pilot-duplicate: request-two'",
          `--data-binary @${shellQuote(requestPath)}`,
          `--dump-header ${shellQuote(responseHeadersPath)}`,
          `--output ${shellQuote(responsePath)}`,
          `'https://10.0.2.2:${address.port}/repository/a/../git-upload-pack?service=git-upload-pack&token=a%2Fb'`,
        ].join(" "),
      ],
      cwd: workspace,
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 20,
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest() {
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(receivedMethod, "POST");
    assert.equal(receivedContinue, true);
    assert.equal(receivedTarget, "/repository/git-upload-pack?service=git-upload-pack&token=a%2Fb");
    assert.deepEqual(rawHeaderValues(receivedHeaders, "authorization"), ["Bearer pilot-test-token"]);
    assert.deepEqual(rawHeaderValues(receivedHeaders, "git-protocol"), ["version=2"]);
    assert.deepEqual(rawHeaderValues(receivedHeaders, "x-pilot-duplicate"), ["request-one", "request-two"]);
    assert.equal(sha256(receivedBody), sha256(requestBody));
    assert.equal(sha256(readFileSync(responsePath)), sha256(responseBody));
    assert.deepEqual(
      rawHeaderValues(parseRawHttpHeaders(readFileSync(responseHeadersPath, "utf8")), "x-pilot-duplicate"),
      ["response-one", "response-two"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTP gateway preserves long request targets and large header sets", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-http-large-headers-test-"));
  const query = `value=${"a".repeat(12_000)}%2Ftail`;
  const expectedTarget = `/repository/info/refs?${query}`;
  const customHeaders = Array.from({length: 150}, (_value, index) => [
    `x-pilot-header-${index}`,
    `value-${index}`,
  ] as const);
  let receivedTarget = "";
  let receivedHeaders: string[] = [];
  let authorizedRawTarget = "";
  const server = createHttpServer((request, response) => {
    receivedTarget = request.url ?? "";
    receivedHeaders = request.rawHeaders;
    response.end("OK");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          "curl --noproxy '*' --silent --show-error --http1.1",
          ...customHeaders.map(([name, value]) => `--header ${shellQuote(`${name}: ${value}`)}`),
          shellQuote(`http://10.0.2.2:${address.port}${expectedTarget}`),
        ].join(" "),
      ],
      cwd: workspace,
      timeoutSeconds: 20,
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        authorizedRawTarget = event.rawTarget;
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(authorizedRawTarget, expectedTarget);
    assert.equal(receivedTarget, expectedTarget);
    for (const [name, value] of customHeaders) {
      assert.deepEqual(rawHeaderValues(receivedHeaders, name), [value]);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTPS gateway preserves chunked bodies and trailers", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-https-trailers-test-"));
  const upstreamAuthority = new TlsCertificateAuthority();
  let requestBody = "";
  let requestTrailers: Record<string, string | undefined> = {};
  const server = createHttpsServer(
    upstreamAuthority.serverCredentials("10.0.2.2"),
    (request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        requestTrailers = request.trailers;
        response.writeHead(200, {
          "content-type": "text/plain",
          trailer: "x-response-trailer",
        });
        response.write("response-one|");
        response.write("response-two");
        response.addTrailers({"x-response-trailer": "response-finished"});
        response.end();
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let output = "";

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        [
          "import {request} from 'node:https'",
          `const result = await new Promise((resolve, reject) => { const value = request({host: '10.0.2.2', port: ${address.port}, path: '/trailers', method: 'POST', headers: {trailer: 'x-request-trailer'}}, (response) => { let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => body += chunk); response.on('end', () => resolve({body, trailers: response.trailers})); }); value.on('error', reject); value.write('request-one|'); value.write('request-two'); value.addTrailers({'x-request-trailer': 'request-finished'}); value.end(); })`,
          "console.log(JSON.stringify(result))",
        ].join("; "),
      ],
      cwd: workspace,
      additionalUpstreamCa: upstreamAuthority.certificatePem,
      timeoutSeconds: 20,
      onStdout(data) {
        output += data.toString();
      },
      decide() {
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest() {
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(requestBody, "request-one|request-two");
    assert.equal(requestTrailers["x-request-trailer"], "request-finished");
    assert.deepEqual(JSON.parse(output), {
      body: "response-one|response-two",
      trailers: {"x-response-trailer": "response-finished"},
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTP gateway evaluates every request on one keep-alive client connection", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-http-keepalive-test-"));
  const upstreamPaths: string[] = [];
  const server = createHttpServer((request, response) => {
    upstreamPaths.push(request.url ?? "");
    response.end("UPSTREAM");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  let tcpDecisions = 0;
  const authorizedPaths: string[] = [];
  server.on("connection", () => {
    acceptedConnections++;
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        [
          "import {Agent, request} from 'node:http'",
          "const agent = new Agent({keepAlive: true, maxSockets: 1})",
          `const send = (path) => new Promise((resolve, reject) => { const value = request({host: '10.0.2.2', port: ${address.port}, path, agent}, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); value.once('error', reject); value.end(); })`,
          "await send('/first')",
          "await send('/second')",
          "agent.destroy()",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      decide() {
        tcpDecisions++;
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest(event) {
        authorizedPaths.push(event.path);
        return event.path === "/first";
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(tcpDecisions, 1);
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(authorizedPaths, ["/first", "/second"]);
    assert.deepEqual(upstreamPaths, ["/first"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the HTTP gateway reuses one upstream connection for allowed keep-alive requests", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-http-upstream-keepalive-test-"));
  const upstreamPaths: string[] = [];
  const server = createHttpServer((request, response) => {
    upstreamPaths.push(request.url ?? "");
    response.end("OK");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  let tcpDecisions = 0;
  let authorizedRequests = 0;
  server.on("connection", () => {
    acceptedConnections++;
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        [
          "import {Agent, request} from 'node:http'",
          "const agent = new Agent({keepAlive: true, maxSockets: 1})",
          `const send = (path) => new Promise((resolve, reject) => { const value = request({host: '10.0.2.2', port: ${address.port}, path, agent}, (response) => { response.resume(); response.once('end', resolve); }); value.once('error', reject); value.end(); })`,
          "for (let index = 0; index < 20; index++) await send(`/request-${index}`)",
          "agent.destroy()",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 15,
      decide() {
        tcpDecisions++;
        return NetworkDecision.ALLOW;
      },
      authorizeHttpRequest() {
        authorizedRequests++;
        return true;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(tcpDecisions, 1);
    assert.equal(authorizedRequests, 20);
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(upstreamPaths, Array.from({length: 20}, (_value, index) => `/request-${index}`));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the network worker denies then allows separate UDP flows", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-udp-test-"));
  const server = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const datagrams: string[] = [];
  server.on("message", (message) => datagrams.push(message.toString()));
  const events: Array<{operation: NetworkOperation; transport: string; destinationPort: number}> = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `printf denied > /dev/udp/10.0.2.2/${address.port} || true`,
          "sleep 0.05",
          `printf allowed > /dev/udp/10.0.2.2/${address.port} || true`,
          "sleep 0.2",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      decide(event) {
        events.push({
          operation: event.operation,
          transport: event.transport,
          destinationPort: event.destination.port,
        });
        return events.length === 1 ? NetworkDecision.DENY : NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(datagrams, ["allowed"]);
    assert.deepEqual(events, [
      {operation: NetworkOperation.UDP_FLOW, transport: "udp", destinationPort: address.port},
      {operation: NetworkOperation.UDP_FLOW, transport: "udp", destinationPort: address.port},
    ]);
  } finally {
    server.close();
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the network worker denies then allows separate IPv6 TCP connections", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-ipv6-test-"));
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let acceptedConnections = 0;
  server.on("connection", () => {
    acceptedConnections++;
  });
  let output = "";
  let errorOutput = "";
  const gatewayErrors: string[] = [];
  const events: Array<{family: NetworkAddressFamily; transport: string; destinationPort: number}> = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `if curl --noproxy '*' --connect-timeout 4 --silent http://[fd00::2]:${address.port} >/dev/null 2>&1; then exit 90; fi`,
          `curl --noproxy '*' --connect-timeout 6 --silent --show-error http://[fd00::2]:${address.port}`,
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      onStderr(data) {
        errorOutput += data.toString();
      },
      onDecisionError(error) {
        gatewayErrors.push(error instanceof Error ? error.message : String(error));
      },
      decide(event) {
        events.push({
          family: event.family,
          transport: event.transport,
          destinationPort: event.destination.port,
        });
        return events.length === 1 ? NetworkDecision.DENY : NetworkDecision.ALLOW;
      },
    });

    assert.equal(
      result.exitCode,
      0,
      `${errorOutput}events=${JSON.stringify(events)} gatewayErrors=${JSON.stringify(gatewayErrors)}`,
    );
    assert.equal(output, "OK", `gatewayErrors=${JSON.stringify(gatewayErrors)}`);
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(events, [
      {
        family: NetworkAddressFamily.IPV6,
        transport: "tcp",
        destinationPort: address.port,
      },
      {
        family: NetworkAddressFamily.IPV6,
        transport: "tcp",
        destinationPort: address.port,
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("the network worker denies then allows separate IPv6 UDP flows", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-ipv6-udp-test-"));
  const server = createSocket("udp6");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.bind(0, "::1", resolve);
  });
  const address = server.address();
  const datagrams: string[] = [];
  server.on("message", (message) => datagrams.push(message.toString()));
  const events: Array<{family: NetworkAddressFamily; operation: NetworkOperation; destinationPort: number}> = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `printf denied > /dev/udp/fd00::2/${address.port} || true`,
          "sleep 0.05",
          `printf allowed > /dev/udp/fd00::2/${address.port} || true`,
          "sleep 0.2",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      decide(event) {
        events.push({
          family: event.family,
          operation: event.operation,
          destinationPort: event.destination.port,
        });
        return events.length === 1 ? NetworkDecision.DENY : NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(datagrams, ["allowed"]);
    assert.deepEqual(events, [
      {
        family: NetworkAddressFamily.IPV6,
        operation: NetworkOperation.UDP_FLOW,
        destinationPort: address.port,
      },
      {
        family: NetworkAddressFamily.IPV6,
        operation: NetworkOperation.UDP_FLOW,
        destinationPort: address.port,
      },
    ]);
  } finally {
    server.close();
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("cancellation drops a pending queued SYN without a host connection", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-cancel-test-"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  server.on("connection", () => {
    acceptedConnections++;
  });
  let decisionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    decisionStarted = resolve;
  });
  const controller = new AbortController();

  try {
    const running = runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        `curl --connect-timeout 10 --silent http://10.0.2.2:${address.port}`,
      ],
      cwd: workspace,
      signal: controller.signal,
      async decide(_event, signal) {
        decisionStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("decision aborted")), {once: true});
        });
        return NetworkDecision.ALLOW;
      },
    });

    await started;
    assert.equal(acceptedConnections, 0);
    controller.abort();
    await assert.rejects(running, /aborted/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(acceptedConnections, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("queue helper failure terminates the worker instead of restoring connectivity", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-helper-failure-test-"));
  const helperPath = path.resolve("build/pi-network-queue-native");
  let ready!: () => void;
  const workerReady = new Promise<void>((resolve) => {
    ready = resolve;
  });

  try {
    const running = runNetworkSandboxedCommand({
      command: ["/bin/bash", "-c", "echo PI_HELPER_TEST_READY; sleep 5"],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        if (data.toString().includes("PI_HELPER_TEST_READY")) ready();
      },
      decide() {
        throw new Error("no packet should reach the failed helper");
      },
    });
    await waitForWorkerReady(workerReady, running);
    process.kill(directChildPid(helperPath), "SIGKILL");
    await assert.rejects(running, /network queue helper exited unexpectedly/);
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("TCP gateway ingress failure terminates the worker instead of restoring direct forwarding", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-gateway-failure-test-"));
  const helperPath = path.resolve("build/pi-tcp-gateway-native");
  let ready!: () => void;
  const workerReady = new Promise<void>((resolve) => {
    ready = resolve;
  });

  try {
    const running = runNetworkSandboxedCommand({
      command: ["/bin/bash", "-c", "echo PI_HELPER_TEST_READY; sleep 5"],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        if (data.toString().includes("PI_HELPER_TEST_READY")) ready();
      },
      decide() {
        throw new Error("no packet should be approved after the TCP gateway fails");
      },
    });
    await waitForWorkerReady(workerReady, running);
    process.kill(directChildPid(helperPath), "SIGKILL");
    await assert.rejects(running, /TCP gateway ingress exited unexpectedly/);
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("TCP retransmissions produce one decision while the original SYN is pending", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-retransmit-test-"));
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let acceptedConnections = 0;
  let decisions = 0;
  let output = "";
  server.on("connection", () => {
    acceptedConnections++;
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        `curl --connect-timeout 6 --silent http://10.0.2.2:${address.port}`,
      ],
      cwd: workspace,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      async decide() {
        decisions++;
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        assert.equal(acceptedConnections, 0);
        return NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "OK");
    assert.equal(decisions, 1);
    assert.equal(acceptedConnections, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

test("an approval stays with its queued packet when a replacement socket reuses the tuple", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-reuse-test-"));
  const firstEventPath = path.join(workspace, "first-event");
  const replacementPath = path.join(workspace, "replacement-started");
  const sourcePort = 45_679;
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://10.0.2.2:${address.port}`;

  let acceptedConnections = 0;
  server.on("connection", () => {
    acceptedConnections++;
  });
  const events: Array<{sourcePort: number; decision: NetworkDecision}> = [];

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        [
          `curl --local-port ${sourcePort} --connect-timeout 8 --silent ${url} >/dev/null 2>&1 & first=$!`,
          `while [ ! -e ${shellQuote(firstEventPath)} ]; do sleep 0.01; done`,
          "kill -KILL \"$first\" 2>/dev/null || true",
          "wait \"$first\" 2>/dev/null || true",
          `curl --local-port ${sourcePort} --connect-timeout 8 --silent ${url} >/dev/null 2>&1 & second=$!`,
          `printf replacement > ${shellQuote(replacementPath)}`,
          "wait \"$second\" || true",
          "sleep 0.2",
        ].join("; "),
      ],
      cwd: workspace,
      timeoutSeconds: 20,
      async decide(event) {
        const decision = events.length === 0 ? NetworkDecision.ALLOW : NetworkDecision.DENY;
        events.push({sourcePort: event.source.port, decision});
        if (decision === NetworkDecision.ALLOW) {
          writeFileSync(firstEventPath, "captured");
          await waitForPath(replacementPath);
          assert.equal(acceptedConnections, 0);
        }
        return decision;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    // The replacement is separately queued and denied. Because the original socket was
    // already gone when the transparent gateway received its SYN, no upstream connection is created.
    assert.equal(acceptedConnections, 0);
    assert.deepEqual(events, [
      {sourcePort, decision: NetworkDecision.ALLOW},
      {sourcePort, decision: NetworkDecision.DENY},
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
});

async function verifySyntheticHostnameConnection(testCase: {
  hostname: string;
  cname?: string;
  hostListenAddress: string;
  dnsAddresses: {ipv4?: string; ipv6?: string};
  realAddress: string;
  syntheticAddress: string;
  globalIpv6Available?: boolean;
}): Promise<void> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-dns-lease-test-"));
  const httpServer = createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, testCase.hostListenAddress, resolve);
  });
  const httpAddress = httpServer.address();
  assert.ok(httpAddress && typeof httpAddress === "object");

  const dnsServer = createSocket("udp4");
  const cnameAddress = testCase.cname ? testCase.dnsAddresses.ipv4 : undefined;
  if (testCase.cname && !cnameAddress) throw new Error("CNAME test requires an IPv4 answer");
  dnsServer.on("message", (query, remote) => {
    const response = testCase.cname && cnameAddress
      ? createTestCnameDnsResponse(query, testCase.cname, cnameAddress)
      : createTestDnsResponse(query, testCase.dnsAddresses);
    dnsServer.send(response, remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    dnsServer.once("error", reject);
    dnsServer.bind(0, "127.0.0.1", resolve);
  });
  const dnsAddress = dnsServer.address();

  let acceptedConnections = 0;
  let output = "";
  const prompted: Array<{operation: NetworkOperation; target: string}> = [];
  const observed: Array<{
    operation: NetworkOperation;
    targetKind: NetworkTargetKind;
    hostname?: string;
    address?: string;
    syntheticAddress?: string;
  }> = [];
  const httpRequests: Array<{hostname: string; url: string; destination: string}> = [];
  httpServer.on("connection", () => {
    acceptedConnections++;
  });
  const coordinator = new NetworkDecisionCoordinator({
    granularity:  {
      distinguishAddressFamily: false,
      distinguishOperation: false
   },
    decide(event) {
      prompted.push({
        operation: event.operation,
        target: event.target.kind === NetworkTargetKind.HOSTNAME
          ? event.target.hostname
          : event.target.address,
      });
      return NetworkDecision.ALLOW;
    },
  });

  try {
    const result = await runNetworkSandboxedCommand({
      command: [
        "/bin/bash",
        "-c",
        `curl --noproxy '*' --connect-timeout 6 --silent http://${testCase.hostname}:${httpAddress.port}`,
      ],
      cwd: workspace,
      dnsUpstream: {address: dnsAddress.address, port: dnsAddress.port},
      globalIpv6Available: testCase.globalIpv6Available,
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
      },
      authorizeHttpRequest(event) {
        httpRequests.push({
          hostname: event.hostname,
          url: event.url,
          destination: event.destination.address,
        });
        return true;
      },
      decide(event, signal) {
        const flow = event.operation === NetworkOperation.DNS_QUERY ? null : event;
        observed.push({
          operation: event.operation,
          targetKind: event.target.kind,
          hostname: event.target.kind === NetworkTargetKind.HOSTNAME ? event.target.hostname : undefined,
          address: flow?.target.address,
          syntheticAddress: flow?.target.kind === NetworkTargetKind.HOSTNAME
            ? flow.target.syntheticAddress
            : undefined,
        });
        return coordinator.decide(event, signal);
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "OK");
    assert.equal(acceptedConnections, 1);
    assert.deepEqual(prompted, [{operation: NetworkOperation.DNS_QUERY, target: testCase.hostname}]);
    assert.deepEqual(httpRequests, [{
      hostname: testCase.hostname,
      url: `http://${testCase.hostname}:${httpAddress.port}/`,
      destination: testCase.syntheticAddress,
    }]);
    const connection = observed.find((event) => event.operation === NetworkOperation.TCP_CONNECT);
    assert.deepEqual(connection, {
      operation: NetworkOperation.TCP_CONNECT,
      targetKind: NetworkTargetKind.HOSTNAME,
      hostname: testCase.hostname,
      address: testCase.realAddress,
      syntheticAddress: testCase.syntheticAddress,
    });
  } finally {
    dnsServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
  }
}

function createTestDnsResponse(
  query: Buffer,
  addresses: {ipv4?: string; ipv6?: string},
): Buffer {
  const {questionEnd, queryType} = parseTestDnsQuestion(query);
  const address = queryType === 1 && addresses.ipv4
    ? Buffer.from(addresses.ipv4.split(".").map(Number))
    : queryType === 28 && addresses.ipv6
      ? parseTestIpv6Address(addresses.ipv6)
      : null;
  const response = Buffer.alloc(questionEnd + (address ? 12 + address.length : 0));
  query.copy(response, 0, 0, questionEnd);
  response.writeUInt16BE(0x8180, 2);
  response.writeUInt16BE(1, 4);
  response.writeUInt16BE(address ? 1 : 0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  if (address) {
    response.writeUInt16BE(0xc00c, questionEnd);
    response.writeUInt16BE(queryType, questionEnd + 2);
    response.writeUInt16BE(1, questionEnd + 4);
    response.writeUInt32BE(30, questionEnd + 6);
    response.writeUInt16BE(address.length, questionEnd + 10);
    address.copy(response, questionEnd + 12);
  }
  return response;
}

function createTestCnameDnsResponse(query: Buffer, cname: string, ipv4Address: string): Buffer {
  const {questionEnd, queryType} = parseTestDnsQuestion(query);
  if (queryType !== 1) return createTestDnsResponse(query, {});

  const cnameBytes = encodeTestDnsName(cname);
  const addressBytes = Buffer.from(ipv4Address.split(".").map(Number));
  const cnameRecordLength = 12 + cnameBytes.length;
  const addressRecordLength = cnameBytes.length + 10 + addressBytes.length;
  const response = Buffer.alloc(questionEnd + cnameRecordLength + addressRecordLength);
  query.copy(response, 0, 0, questionEnd);
  response.writeUInt16BE(0x8180, 2);
  response.writeUInt16BE(1, 4);
  response.writeUInt16BE(2, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);

  let offset = questionEnd;
  response.writeUInt16BE(0xc00c, offset);
  response.writeUInt16BE(5, offset + 2);
  response.writeUInt16BE(1, offset + 4);
  response.writeUInt32BE(30, offset + 6);
  response.writeUInt16BE(cnameBytes.length, offset + 10);
  cnameBytes.copy(response, offset + 12);

  offset += cnameRecordLength;
  cnameBytes.copy(response, offset);
  offset += cnameBytes.length;
  response.writeUInt16BE(1, offset);
  response.writeUInt16BE(1, offset + 2);
  response.writeUInt32BE(30, offset + 4);
  response.writeUInt16BE(addressBytes.length, offset + 8);
  addressBytes.copy(response, offset + 10);
  return response;
}

function parseTestDnsQuestion(query: Buffer): {questionEnd: number; queryType: number} {
  assert.ok(query.length >= 17);
  let offset = 12;
  while (true) {
    const labelLength = query[offset];
    assert.notEqual(labelLength, undefined);
    offset++;
    if (labelLength === 0) break;
    assert.ok(labelLength < 64 && offset + labelLength <= query.length);
    offset += labelLength;
  }
  assert.ok(offset + 4 <= query.length);
  return {questionEnd: offset + 4, queryType: query.readUInt16BE(offset)};
}

function encodeTestDnsName(name: string): Buffer {
  const labels = name.split(".");
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "ascii");
    assert.ok(bytes.length > 0 && bytes.length <= 63);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function parseTestIpv6Address(address: string): Buffer {
  const halves = address.split("::");
  assert.ok(halves.length <= 2);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  assert.ok(missing >= 0);
  const groups = [...left, ...Array.from({length: missing}, () => "0"), ...right];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

async function waitForWorkerReady(workerReady: Promise<void>, running: Promise<unknown>): Promise<void> {
  await Promise.race([
    workerReady,
    running.then(
      () => {
        throw new Error("network worker exited before the helper-failure test was ready");
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
}

function directChildPid(executable: string): number {
  for (const entry of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const parent = /^PPid:\s+([0-9]+)$/m.exec(status)?.[1];
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")[0];
      if (Number(parent) === process.pid && command === executable) return Number(entry);
    } catch {
      // Processes may exit while /proc is being inspected.
    }
  }
  throw new Error(`direct child not found: ${executable}`);
}

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${target}`);
}

function patternedBuffer(length: number, seed: number): Buffer {
  return Buffer.from(Array.from({length}, (_value, index) => (index * 31 + seed) % 256));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function rawHeaderValues(rawHeaders: string[], name: string): string[] {
  const normalizedName = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === normalizedName) values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function parseRawHttpHeaders(value: string): string[] {
  const result: string[] = [];
  for (const line of value.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    result.push(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
