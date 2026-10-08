import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {fileURLToPath} from "node:url";
import {NetworkDecision} from "../src/policy/network/network-queue-protocol.js";
import {runNetworkSandboxedCommand} from "../src/policy/network/NetworkSandbox.js";
import {ManagedChildProcess, type ManagedChildProcessOptions} from "../src/runtime/ManagedChildProcess.js";

type StalledStage = "network sandbox worker" | "TCP gateway ingress" | "network queue helper";
type Cancellation = "abort" | "timeout";
const root = fileURLToPath(new URL("..", import.meta.url));

for (const stage of ["network sandbox worker", "TCP gateway ingress", "network queue helper"] as const) {
    for (const cancellation of ["abort", "timeout"] as const) {
        test(`${cancellation} before ${stage} readiness cleans up`, async (t) => {
            await checkCancellation(t, stage, cancellation);
        });
    }
}

test("network runtime launches all three verified Rust helpers from this extension", async (t) => {
    await checkCancellation(t, "network queue helper", "abort");
});

async function checkCancellation(
    t: TestContext,
    stage: StalledStage,
    cancellation: Cancellation,
): Promise<void> {
    const originalSpawn = ManagedChildProcess.spawn;
    const processes: ManagedChildProcess[] = [];
    const workerPidOffset = 1_000_000;
    const namespaceTargets = new Set<number>();
    let gatewayPid: number | undefined;
    let runtimeDirectory: string | undefined;
    let stageStarted!: () => void;
    const stalled = new Promise<void>((resolve) => { stageStarted = resolve; });
    t.mock.method(ManagedChildProcess, "spawn", (options: ManagedChildProcessOptions) => {
        const directory = "build";
        if (options.name === "network sandbox worker") {
            assert.equal(options.command, path.join(root, directory, "pi-exec-clean-native"));
        }
        if (options.name === "TCP gateway ingress" || options.name === "network queue helper") {
            const helper = options.name === "TCP gateway ingress" ? "pi-tcp-gateway-native" : "pi-network-queue-native";
            const executable = options.arguments?.find((argument) => path.basename(argument) === helper);
            assert.equal(executable, path.join(root, directory, helper), `${options.name} must use the selected implementation`);
        }
        if (options.command === "/usr/bin/nsenter") {
            assert.ok(gatewayPid);
            const args = options.arguments ?? [];
            assert.ok(args.includes(`--user=/proc/${gatewayPid}/ns/user`), "trusted helpers must retain gateway namespace authority");
            assert.equal(args.includes("--user"), false, "worker user namespaces must not select helper authority");
            assert.ok(args.includes("--preserve-credentials") && args.includes("--keep-caps"));
            const targetIndex = args.indexOf("--target");
            assert.ok(targetIndex >= 0);
            const networkPid = Number(args[targetIndex + 1]);
            assert.ok(networkPid === gatewayPid || networkPid === gatewayPid + workerPidOffset);
            assert.ok(args.includes(`--net=/proc/${networkPid}/ns/net`));
            assert.equal(args.includes("--net"), false, "automatic pidfd entry must not precede explicit user-namespace entry");
            namespaceTargets.add(networkPid);
            if (options.name === "network queue helper" || options.name === "enable worker loopback") {
                assert.equal(networkPid, gatewayPid + workerPidOffset, "worker helpers must still target the worker network");
            } else if (options.name === "TCP gateway ingress") {
                assert.equal(networkPid, gatewayPid);
            }
        }
        let script: string | undefined;
        switch (options.name) {
            case "network sandbox worker": {
                const args = options.arguments ?? [];
                assert.equal(args.includes("--dev-bind"), false, "host devices must not bypass FUSE policy");
                const privateDev = args.indexOf("--dev");
                assert.ok(privateDev >= 0, "worker must receive a private device filesystem");
                assert.equal(args[privateDev + 1], "/dev");
                assert.ok(privateDev < args.indexOf("--ro-bind"), "explicit resource imports must overlay private /dev");
                assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL", "worker capability restrictions must remain intact");
                const resolver = args.find((argument) => argument.includes("pilot-network-") && argument.endsWith("/resolv.conf"));
                assert.ok(resolver);
                runtimeDirectory = path.dirname(resolver);
                script = stage === options.name
                    ? 'process.stderr.write("STALLED\\n");setInterval(() => {}, 1000);'
                    : `require("node:fs").writeSync(3, JSON.stringify({"child-pid":process.pid+${workerPidOffset},"mnt-namespace":1})+"\\n");`
                        + 'setInterval(() => {}, 1000);';
                break;
            }
            case "TCP gateway ingress":
                script = stage === options.name
                    ? 'process.stderr.write("STALLED\\n");setInterval(() => {}, 1000);'
                    : 'process.stdout.write("PI_TCP_GATEWAY\\t1\\tREADY\\t12345\\n");setInterval(() => {}, 1000);';
                break;
            case "network queue helper":
                script = stage === options.name
                    ? 'process.stderr.write("STALLED\\n");setInterval(() => {}, 1000);'
                    : 'process.stdout.write("PI_NETWORK_QUEUE\\t3\\tREADY\\n");setInterval(() => {}, 1000);';
                break;
            default:
                // Fake nsenter/ip/nft commands; never execute host namespace or firewall tools.
                script = undefined;
        }
        const child = originalSpawn({
            ...options,
            command: script === undefined ? "/bin/sh" : process.execPath,
            // Drain any nft input without launching Node for every setup command.
            arguments: script === undefined ? ["-c", "while IFS= read -r line; do :; done"] : ["-e", script],
        });
        processes.push(child);
        if (options.name === "network sandbox worker") {
            assert.ok(child.pid);
            gatewayPid = child.pid;
        }
        if (options.name === stage) {
            child.stderr?.once("data", (data: Buffer) => {
                assert.match(data.toString(), /STALLED/);
                stageStarted();
            });
        }
        return child;
    });

    const controller = new AbortController();
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    if (cancellation === "timeout") t.mock.timers.enable({apis: ["setTimeout"]});
    const running = runNetworkSandboxedCommand({
        command: ["/bin/true"],
        cwd: tmpdir(),
        signal: controller.signal,
        timeoutSeconds: cancellation === "timeout" ? 4 : 10,
        decide: () => NetworkDecision.DENY,
    });
    let deadline: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            stalled,
            running.then(() => { throw new Error("sandbox finished before stalled helper started"); }),
            new Promise<never>((_, reject) => {
                deadline = realSetTimeout(() => reject(new Error("sandbox did not reach helper startup")), 6000);
            }),
        ]);
        if (deadline) realClearTimeout(deadline);
        const cancelledAt = Date.now();
        if (cancellation === "abort") controller.abort();
        else t.mock.timers.tick(4000);
        await assert.rejects(Promise.race([
            running,
            new Promise<never>((_, reject) => {
                deadline = realSetTimeout(() => reject(new Error("sandbox cancellation remained pending")), 6000);
            }),
        ]), cancellation === "abort" ? /aborted/ : /timeout:4/);
        assert.ok(Date.now() - cancelledAt < 6000);
        assert.ok(runtimeDirectory);
        assert.equal(existsSync(runtimeDirectory), false, "runtime files should be removed");
        if (stage !== "network sandbox worker") {
            assert.ok(gatewayPid);
            assert.deepEqual(namespaceTargets, new Set([gatewayPid, gatewayPid + workerPidOffset]));
        }
        const results = await Promise.all(processes.map((child) => child.waitForExit()));
        assert.ok(results.some((result) => result.signal === "SIGKILL"), "running helpers must be terminated");
        for (const child of processes) {
            assert.ok(!child.pid || !isRunning(child.pid), `process ${child.pid} remains alive`);
        }
    } finally {
        if (deadline) realClearTimeout(deadline);
        controller.abort();
        for (const child of processes) child.terminate();
        await Promise.all(processes.map((child) => child.waitForExit()));
        if (cancellation === "timeout") t.mock.timers.reset();
    }
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
