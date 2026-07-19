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
  NetworkOperation,
  parseNetworkQueueMessage,
  runNetworkSandboxedCommand,
} from "../src/experiment/network/network-runner.js";

test("the network queue protocol validates readiness and IPv4 TCP events", () => {
  assert.deepEqual(parseNetworkQueueMessage("PI_NETWORK_QUEUE\t1\tREADY"), {type: "READY"});
  assert.deepEqual(
    parseNetworkQueueMessage("PI_NETWORK_QUEUE\t1\tEVENT\t7\tIPV4\t10.0.2.100\t33708\t1.1.1.1\t443"),
    {
      type: "EVENT",
      event: {
        sequence: 7,
        operation: NetworkOperation.TCP_CONNECT,
        family: NetworkAddressFamily.IPV4,
        protocol: "tcp",
        source: {address: "10.0.2.100", port: 33708},
        destination: {address: "1.1.1.1", port: 443},
      },
    },
  );
  assert.throws(() => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t2\tREADY"), /unsupported protocol/);
  assert.throws(
    () => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t1\tEVENT\t0\tIPV4\t10.0.2.100\t33708\t1.1.1.1\t443"),
    /sequence/,
  );
  assert.throws(
    () => parseNetworkQueueMessage("PI_NETWORK_QUEUE\t1\tEVENT\t8\tIPV6\t::1\t33708\t::2\t443"),
    /unsupported address family/,
  );
});

test("the network worker preserves host access, has no gate capabilities, and fails closed for UDP", async () => {
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
    assert.match(output, /LOCAL/);
    assert.equal(readFileSync(hostWritePath, "utf8"), "host-write");
    assert.equal(decisions, 0);
    assert.equal(datagrams, 0);
  } finally {
    udpServer.close();
    await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    rmSync(workspace, {recursive: true, force: true});
    rmSync(hostDirectory, {recursive: true, force: true});
  }
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
