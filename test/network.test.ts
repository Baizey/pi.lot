import assert from "node:assert/strict";
import {createSocket} from "node:dgram";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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
} from "../src/experiment/network/network-runner.js";

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
      decide(event) {
        events.push({
          family: event.family,
          transport: event.transport,
          destinationPort: event.destination.port,
        });
        return events.length === 1 ? NetworkDecision.DENY : NetworkDecision.ALLOW;
      },
    });

    assert.equal(result.exitCode, 0, `${errorOutput}events=${JSON.stringify(events)}`);
    assert.equal(output, "OK");
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

  try {
    await assert.rejects(
      runNetworkSandboxedCommand({
        command: [
          "/bin/bash",
          "-c",
          [
            `helper=$(pgrep --full --exact ${shellQuote(helperPath)})`,
            "kill -KILL \"$helper\"",
            "sleep 5",
          ].join("; "),
        ],
        cwd: workspace,
        timeoutSeconds: 10,
        decide() {
          throw new Error("no packet should reach the failed helper");
        },
      }),
      /network queue helper exited unexpectedly/,
    );
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
    // ALLOW releases the original held SYN; the replacement is separately queued and denied.
    assert.equal(acceptedConnections, 1);
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
  httpServer.on("connection", () => {
    acceptedConnections++;
  });
  const coordinator = new NetworkDecisionCoordinator({
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
      timeoutSeconds: 10,
      onStdout(data) {
        output += data.toString();
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

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${target}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
