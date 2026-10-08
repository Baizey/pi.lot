import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {Socket, connect, createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test, {after, before} from "node:test";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const binaries = ["Rust", "C"].map((language) => ({
    language,
    gateway: path.join(root, "build", language === "C" ? "native-c" : "", "pi-tcp-gateway-native"),
    exec: path.join(root, "build", language === "C" ? "native-c" : "", "pi-exec-clean-native"),
    probe: path.join(root, "build", language === "C" ? "native-c" : "", "pi-tcp-gateway-probe"),
}));
const cProbe = binaries[1].probe;
const environment = {...process.env, LC_ALL: "C"};
let forkPauseDirectory: string;
let forkPauseLibrary: string;

before(() => {
    forkPauseDirectory = mkdtempSync(path.join(os.tmpdir(), "pilot-fork-pause-"));
    forkPauseLibrary = path.join(forkPauseDirectory, "fork-pause.so");
    const compilation = spawnSync("cc", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-fPIC", "-shared",
        path.join(root, "test/fixtures/native-tcp-gateway-fork-pause.c"), "-o", forkPauseLibrary, "-ldl"], {encoding: "utf8"});
    assert.ifError(compilation.error);
    assert.equal(compilation.status, 0, compilation.stderr);
});

after(() => {
    if (forkPauseDirectory) rmSync(forkPauseDirectory, {recursive: true, force: true});
});

function run(binary: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
    const result = spawnSync(binary, args, {env: environment, encoding: "utf8", timeout: 10000, ...options});
    assert.ifError(result.error);
    return {status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr};
}

function differential(program: "exec" | "gateway" | "probe", args: string[], expected: ReturnType<typeof run>) {
    for (const binary of binaries) assert.deepEqual(run(binary[program], args), expected, binary.language);
}

function success(stdout = "") {
    return {status: 0, signal: null, stdout, stderr: ""};
}

// These tests deliberately require the baseline and candidate artifacts. Missing builds
// are failures rather than skips, so differential coverage cannot disappear silently.
test("process parity artifacts are present", () => {
    for (const binary of binaries) for (const program of [binary.exec, binary.gateway, binary.probe]) {
        assert.ok(existsSync(program), `Build required artifact: ${program}`);
    }
});

test("gateway CLI rejects bad arity, invalid IPv4 and ports with exact diagnostics", () => {
    for (const args of [[], ["127.0.0.1"], ["127.0.0.1", "80", "extra"]]) {
        differential("gateway", args, {status: 1, signal: null, stdout: "", stderr: "usage: pi-tcp-gateway BROKER_IPV4 BROKER_PORT\n"});
    }
    for (const args of [["localhost", "80"], ["::1", "80"], ["127.1", "80"], ["127.0.0.1 ", "80"], ["999.0.0.1", "80"], ["127.0.0.1", "0"], ["127.0.0.1", "65536"], ["127.0.0.1", "-1"], ["127.0.0.1", "80 "]]) {
        differential("gateway", args, {status: 1, signal: null, stdout: "", stderr: "pi-tcp-gateway: invalid broker endpoint\n"});
    }
});

for (const ignored of [false, true]) {
    test(`early CLI diagnostics preserve inherited ${ignored ? "ignored" : "default"} SIGPIPE on broken stderr`, () => {
        const launcher = `import json, os, signal, subprocess, sys
reader, writer = os.pipe()
os.close(reader)
ignored = sys.argv[2] == 'true'
result = subprocess.run([sys.argv[1]] + sys.argv[3:], stdout=subprocess.PIPE, stderr=writer,
    preexec_fn=lambda: signal.signal(signal.SIGPIPE, signal.SIG_IGN if ignored else signal.SIG_DFL), timeout=3)
os.close(writer)
print(json.dumps({'status': result.returncode, 'stdout': result.stdout.decode()}))
`;
        for (const binary of binaries) {
            const fuse = path.join(path.dirname(binary.exec), "pi-fuse-native");
            for (const [program, args, status] of [
                [binary.exec, [], 64], [binary.exec, ["-1", "/usr/bin/true"], 64],
                [binary.gateway, [], 1], [binary.gateway, ["invalid", "80"], 1],
                [fuse, [], 64], [fuse, ["--check-policy-protocol"], 64],
            ] as const) {
                const result = spawnSync("python3", ["-c", launcher, program, String(ignored), ...args], {
                    env: environment, encoding: "utf8", timeout: 10_000,
                });
                assert.ifError(result.error);
                assert.equal(result.status, 0, result.stderr);
                assert.deepEqual(JSON.parse(result.stdout), {status: ignored ? status : -13, stdout: ""}, `${binary.language}: ${program} ${args.join(" ")}`);
            }
        }
    });
}

test("gateway parse_port retains strtoul whitespace, signs, decimal and unsigned-negation boundaries", () => {
    const cases: [string, string][] = [
        ["", "invalid"], ["0", "invalid"], ["00", "invalid"], ["1", "1"], ["65535", "65535"], ["65536", "invalid"],
        ["00080", "80"], ["+80", "80"], [" \t\r\n\v\f+80", "80"], ["80 ", "invalid"], ["  ", "invalid"],
        ["+", "invalid"], ["-0", "invalid"], ["-1", "invalid"], ["--1", "invalid"], ["0x50", "invalid"], ["1e2", "invalid"],
        ["18446744073709551615", "invalid"], ["18446744073709551616", "invalid"],
        ["-18446744073709551615", "1"], ["-18446744073709486081", "65535"],
        ["-18446744073709486080", "invalid"], ["-18446744073709551616", "invalid"], ["é80", "invalid"],
    ];
    differential("probe", ["parse", ...cases.map(([input]) => input)], success(cases.map(([, output]) => `${output}\n`).join("")));
});

test("exec helper preserves usage, strtoul validation, and execvp failure statuses", () => {
    for (const args of [[], ["2"]]) {
        differential("exec", args, {status: 64, signal: null, stdout: "", stderr: "usage: pi-exec-clean-native MAX_PRESERVED_FD COMMAND [ARG...]\n"});
    }
    for (const value of ["", " ", "2 ", "-1", "4294967295", "4294967296", "18446744073709551616", "+", "0x2", "2x"]) {
        differential("exec", [value, "/bin/true"], {status: 64, signal: null, stdout: "", stderr: `invalid maximum preserved descriptor: ${value}\n`});
    }
    for (const value of ["0", "1", "2", "0002", "+2", " \t+2", "4294967294", "-18446744073709551615"]) {
        differential("exec", [value, "/bin/true"], success());
    }
    differential("exec", ["2", "/pilot-parity-nonexistent-command"], {status: 127, signal: null, stdout: "", stderr: "execvp: No such file or directory\n"});
    differential("exec", ["2", "/"], {status: 127, signal: null, stdout: "", stderr: "execvp: Permission denied\n"});
    differential("exec", ["2", "/bin/sh", "-c", "exit 37"], {status: 37, signal: null, stdout: "", stderr: ""});
});

test("exec retains literal argv, environment, working directory and PID through replacement", () => {
    const args = ["", "a b", "'quotes'", "$(echo unsafe)", "--flag", "λ🦀", "line\nbreak"];
    const script = "process.stdout.write(JSON.stringify({args:process.argv.slice(1),value:process.env.PI_EXEC_VALUE,cwd:process.cwd(),pid:process.pid}))";
    for (const binary of binaries) {
        const child = spawnSync(binary.exec, ["2", process.execPath, "-e", script, ...["--", ...args]], {
            env: {...environment, PI_EXEC_VALUE: "literal $HOME\n🦀"}, cwd: os.tmpdir(), encoding: "utf8",
        });
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), {args, value: "literal $HOME\n🦀", cwd: os.tmpdir(), pid: child.pid});
        assert.equal(child.stderr, "");
    }
});

test("execvp PATH lookup and ENOEXEC shell fallback match independently expected output", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-exec-parity-"));
    try {
        writeFileSync(path.join(directory, "literal-command"), 'printf "<%s>\\n" "$@"\n', {mode: 0o755});
        for (const binary of binaries) {
            assert.deepEqual(run(binary.exec, ["2", "literal-command", "a b", "", "$HOME"], {env: {...environment, PATH: directory}}), success("<a b>\n<>\n<$HOME>\n"));
        }
    } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("exec preserves non-UTF8 argument and environment bytes without lossy Unicode conversion", () => {
    for (const binary of binaries) {
        assert.deepEqual(run(cProbe, ["exec-raw", binary.exec, cProbe]), success("61ff807a\nfe81\n"), binary.language);
    }
});

test("exec invalid descriptor diagnostics preserve non-UTF8 bytes", () => {
    for (const binary of binaries) {
        const result = spawnSync(cProbe, ["exec-invalid-raw", binary.exec, cProbe], {env: environment});
        assert.ifError(result.error);
        assert.equal(result.status, 64);
        assert.deepEqual(result.stdout, Buffer.alloc(0));
        assert.deepEqual(result.stderr, Buffer.concat([Buffer.from("invalid maximum preserved descriptor: a"), Buffer.from([255, 128]), Buffer.from("z\n")]));
    }
});

test("exec preserves the inclusive descriptor boundary and closes every higher inherited descriptor", () => {
    for (const maximum of [0, 1]) for (const binary of binaries) {
        assert.deepEqual(run(binary.exec, [String(maximum), cProbe, "check-fds", String(maximum)], {stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]}), success());
    }
    for (const maximum of [2, 3, 4, 5]) {
        const expected = Array.from({length: 10}, (_, descriptor) => `${descriptor}:${descriptor <= maximum ? 0 : -1}\n`).join("");
        for (const binary of binaries) {
            const result = run(binary.exec, [String(maximum), cProbe, "inspect-fds"], {stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]});
            assert.deepEqual(result, success(expected), `${binary.language}, max=${maximum}`);
        }
    }
});

test("exec inherits initially closed standard descriptors without reopening them", () => {
    for (const binary of binaries) for (const mask of [1, 2, 4, 7]) {
        const result = spawnSync(cProbe, ["exec-closed-stdio", String(mask), binary.exec, "3", cProbe, "inspect-stdio"], {
            env: environment, stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, binary.language);
        assert.deepEqual(result.output[3], Buffer.from(Array.from({length: 3}, (_, descriptor) => `${descriptor}:${mask & (1 << descriptor) ? -1 : 0}\n`).join("")));
    }
});

test("closed inherited stderr does not turn CLI errors into Rust panics", () => {
    for (const binary of binaries) {
        assert.deepEqual(run(cProbe, ["exec-closed-stdio", "4", binary.exec]), {status: 64, signal: null, stdout: "", stderr: ""});
        assert.deepEqual(run(cProbe, ["exec-closed-stdio", "4", binary.exec, "invalid", "/bin/true"]), {status: 64, signal: null, stdout: "", stderr: ""});
        assert.deepEqual(run(cProbe, ["exec-closed-stdio", "4", binary.gateway]), {status: 1, signal: null, stdout: "", stderr: ""});
        assert.deepEqual(run(cProbe, ["exec-closed-stdio", "4", binary.gateway, "bad", "port"]), {status: 1, signal: null, stdout: "", stderr: ""});
    }
});

test("close_range ENOSYS/EINVAL fall back, while other errors abort with 126 before exec", () => {
    for (const binary of binaries) {
        for (const error of [38, 22]) for (const maximum of [2, 3, 4]) {
            assert.deepEqual(run(cProbe, ["filtered-exec", String(error), binary.exec, String(maximum), cProbe, "inspect-fds"], {stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]}),
                success(Array.from({length: 10}, (_, descriptor) => `${descriptor}:${descriptor <= maximum ? 0 : -1}\n`).join("")));
        }
        for (const maximum of [0, 1]) {
            assert.deepEqual(run(cProbe, ["filtered-exec", "38", binary.exec, String(maximum), cProbe, "check-fds", String(maximum)], {stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]}), success());
        }
        assert.deepEqual(run(cProbe, ["filtered-exec", "1", binary.exec, "2", "/bin/echo", "must-not-exec"]),
            {status: 126, signal: null, stdout: "", stderr: "close_range: Operation not permitted\n"});
    }
});

for (const binary of binaries) {
    test(`${binary.language} close_range fallback closes descriptors above a subsequently lowered RLIMIT_NOFILE`, () => {
        for (const error of [38, 22]) {
            assert.deepEqual(run(cProbe, ["filtered-exec-high", String(error), binary.exec, "2", cProbe, "inspect-high"]), success("closed\n"));
            assert.deepEqual(run(cProbe, ["filtered-exec-high", String(error), binary.exec, "512", cProbe, "inspect-high"]), success("open\n"));
        }
    });
    test(`${binary.language} close_range fallback fails closed when it cannot open or read procfs descriptors`, () => {
        for (const [mode, label] of [["unopenable", "opendir"], ["unreadable", "readdir"]]) {
            assert.deepEqual(run(cProbe, [`filtered-exec-${mode}`, "38", binary.exec, "2", "/bin/echo", "must-not-exec"]),
                {status: 126, signal: null, stdout: "", stderr: `${label} /proc/self/fd: Permission denied\n`});
        }
    });
}

test("exec retains both default and ignored inherited SIGPIPE dispositions", () => {
    for (const binary of binaries) {
        const defaultSignal = run("/bin/sh", ["-c", 'trap - PIPE; exec "$1" 2 /bin/sh -c \'kill -PIPE $$; echo incorrectly-survived\'', "probe", binary.exec]);
        assert.deepEqual(defaultSignal, {status: null, signal: "SIGPIPE", stdout: "", stderr: ""}, binary.language);
        const ignoredSignal = run("/bin/sh", ["-c", 'trap "" PIPE; exec "$1" 2 /bin/sh -c \'kill -PIPE $$; echo correctly-survived\'', "probe", binary.exec]);
        assert.deepEqual(ignoredSignal, success("correctly-survived\n"), binary.language);
    }
});

function relay(binary: string) {
    const child = spawn(binary, ["relay"], {env: environment, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]});
    assert.ok(child.stdio[3] instanceof Socket);
    assert.ok(child.stdio[4] instanceof Socket);
    const client = child.stdio[3];
    const broker = child.stdio[4];
    client.allowHalfOpen = true;
    broker.allowHalfOpen = true;
    const stderr: Buffer[] = [];
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exited = once(child, "exit").then(([code, signal]) => {
        assert.equal(signal, null);
        assert.equal(code, 0, Buffer.concat(stderr).toString());
    });
    return {child, client, broker, exited};
}

function readToEnd(socket: Socket) {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = once(socket, "end").then(() => Buffer.concat(chunks));
    socket.resume();
    return ended;
}

function payload(size: number, seed: number) {
    const bytes = Buffer.allocUnsafe(size);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + seed + (index >>> 11)) & 255;
    return bytes;
}

async function withRelay(binary: string, action: (flow: ReturnType<typeof relay>) => Promise<void>) {
    const flow = relay(binary);
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            action(flow).then(() => flow.exited),
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Relay probe timed out")), 15000); }),
        ]);
    } finally {
        clearTimeout(timeout);
        flow.client.destroy();
        flow.broker.destroy();
        if (flow.child.exitCode === null) flow.child.kill("SIGKILL");
    }
}

for (const binary of binaries) {
    test(`${binary.language} relay forwards large simultaneous binary streams with backpressure`, async () => {
        await withRelay(binary.probe, async ({client, broker, exited}) => {
            const outbound = payload(4 * 1024 * 1024 + 7919, 7);
            const inbound = payload(3 * 1024 * 1024 + 65537, 149);
            // Delay both readers so the bounded 64KiB relay buffers and socket send queues
            // fill, forcing partial sends and repeated buffer compaction in both directions.
            client.pause();
            broker.pause();
            assert.equal(client.write(outbound), false);
            assert.equal(broker.write(inbound), false);
            client.end();
            broker.end();
            await new Promise((resolve) => setTimeout(resolve, 75));
            const receivedClient = readToEnd(client);
            const receivedBroker = readToEnd(broker);
            assert.deepEqual(await receivedClient, inbound);
            assert.deepEqual(await receivedBroker, outbound);
            await exited;
        });
    });

    for (const direction of ["client-first", "broker-first"]) {
        test(`${binary.language} relay ${direction} half-close drains data and keeps the reverse stream alive`, async () => {
            await withRelay(binary.probe, async ({client, broker, exited}) => {
                const first = direction === "client-first" ? client : broker;
                const second = direction === "client-first" ? broker : client;
                const request = payload(256 * 1024 + 29, 31);
                const response = payload(512 * 1024 + 97, 93);
                const receivedRequest = readToEnd(second);
                const receivedResponse = readToEnd(first);
                first.end(request);
                assert.deepEqual(await receivedRequest, request);
                // Only generate the response after observing the forwarded EOF. A relay
                // that closes both sockets at the first half-close fails this assertion.
                second.end(response);
                assert.deepEqual(await receivedResponse, response);
                await exited;
            });
        });
    }

    test(`${binary.language} relay empty half-closes terminate cleanly`, async () => {
        await withRelay(binary.probe, async ({client, broker, exited}) => {
            const receivedClient = readToEnd(client);
            const receivedBroker = readToEnd(broker);
            client.end();
            broker.end();
            assert.deepEqual(await receivedClient, Buffer.alloc(0));
            assert.deepEqual(await receivedBroker, Buffer.alloc(0));
            await exited;
        });
    });
}

test("relay returns failure for missing inherited socket descriptors", () => {
    differential("probe", ["relay"], {status: 1, signal: null, stdout: "", stderr: ""});
});

test("gateway privilege dropping disables dumpability, clears capabilities and forbids privilege acquisition", () => {
    differential("probe", ["privileges"], success("dumpable=0 no_new_privs=1\n0:0:0\n0:0:0\n"));
});

async function waitUntil(condition: () => boolean, description: string) {
    const deadline = Date.now() + 10000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, `Timed out: ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

for (const binary of binaries) {
    test(`${binary.language} relay rejects a changed parent before registering PDEATHSIG under a subreaper`, () => {
        assert.deepEqual(run("python3", [path.join(root, "test/fixtures/native-tcp-gateway-parent-death.py"), binary.probe, forkPauseLibrary], {timeout: 30000}), success("relay-rejected\n"));
    });

    test(`${binary.language} gateway process relays enforce capacity, reap exits, frame endpoints and die with parent`, {timeout: 60000}, async () => {
        // Only the listener is mount-free/non-transparent. The probe calls the actual
        // production accept_client/handle_client, including fork, signals and pdeathsig.
        const flows: {socket: Socket; data: Buffer; closed: boolean}[] = [];
        const broker = createServer((socket) => {
            const flow = {socket, data: Buffer.alloc(0), closed: false};
            flows.push(flow);
            socket.on("data", (data: Buffer) => { flow.data = Buffer.concat([flow.data, data]); });
            socket.on("close", () => { flow.closed = true; });
            socket.on("error", () => {}); // Killing a relay can reset an idle broker socket.
        });
        const clients: Socket[] = [];
        broker.listen(0, "127.0.0.1");
        await once(broker, "listening");
        const address = broker.address();
        assert.ok(address && typeof address !== "string");
        const gateway = spawn(binary.probe, ["serve", String(address.port)], {env: environment, stdio: ["ignore", "pipe", "pipe"]});
        let readiness = "";
        let errors = "";
        gateway.stdout.on("data", (data: Buffer) => { readiness += data.toString(); });
        gateway.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
        const exited = once(gateway, "exit");
        try {
            await waitUntil(() => readiness.includes("\n") || gateway.exitCode !== null, "gateway readiness");
            assert.equal(gateway.exitCode, null, errors);
            const match = /^PI_TCP_GATEWAY\t1\tREADY\t([0-9]+)\n$/.exec(readiness);
            assert.ok(match, readiness);
            const ingressPort = Number(match[1]);
            const openClient = async () => {
                const client = connect({host: "127.0.0.1", port: ingressPort, allowHalfOpen: true});
                clients.push(client);
                client.on("error", () => {});
                await once(client, "connect");
                return client;
            };
            for (let index = 0; index < 128; index++) await openClient();
            await waitUntil(() => flows.length === 128 && flows.every((flow) => flow.data.includes(10)), "128 relay broker headers");
            const expectedHeaders = clients.map((client) => `PI_TCP_GATEWAY\t1\tFLOW\tIPV4\t127.0.0.1\t${client.localPort}\t127.0.0.1\t${ingressPort}\n`);
            assert.deepEqual(flows.map((flow) => flow.data.toString()).sort(), expectedHeaders.sort());
            const overflow = await openClient();
            let overflowEnded = false;
            overflow.on("end", () => { overflowEnded = true; });
            overflow.resume();
            await waitUntil(() => overflowEnded, "capacity overflow rejected without a broker flow");
            assert.equal(flows.length, 128);
            assert.ok(flows.every((flow) => !flow.closed), "Existing relays remain alive at capacity");
            overflow.destroy();

            // Complete one flow and allow SIGCHLD reaping to make a slot available.
            clients[0].resume();
            clients[0].end();
            await waitUntil(() => flows.filter((flow) => flow.closed).length === 1, "released relay closes broker socket");
            await new Promise((resolve) => setTimeout(resolve, 75));
            await openClient();
            await waitUntil(() => flows.length === 129 && flows[128].data.includes(10), "capacity slot reclaimed after SIGCHLD");

            // pdeathsig must kill every still-live child, not merely close the listener.
            gateway.kill("SIGKILL");
            const [code, signal] = await exited;
            assert.equal(code, null);
            assert.equal(signal, "SIGKILL");
            await waitUntil(() => flows.every((flow) => flow.closed), "relay children killed on parent death");
            assert.equal(errors, "");
        } finally {
            if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGKILL");
            for (const client of clients) client.destroy();
            for (const flow of flows) flow.socket.destroy();
            await new Promise<void>((resolve) => broker.close(() => resolve()));
            await exited;
        }
    });
}
