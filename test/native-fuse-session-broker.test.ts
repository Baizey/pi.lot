import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync} from "node:fs";
import {createConnection} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {PolicyDecisionFlow, PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {NativeFuseSessionBroker} from "../src/policy/path/native/NativeFuseSessionBroker.js";
import {runNativeFuseSandboxedCommand} from "../src/policy/path/native/native-fuse-runner.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResponse,
} from "../src/policy/types.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";

const AGENT = "native-fuse-session-broker-test";
const CHILD_AGENT = "native-fuse-session-broker-child";

function policyDao(): PolicyDaoInterface {
    return {
        initializeSchema() {
        },
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
    };
}

function decisionFlow(choices: PolicyChoice[] = []): PolicyDecisionFlow {
    let index = 0;
    return {
        async askForPolicy(): Promise<PolicyChoice> {
            const choice = choices[index++];
            assert.ok(choice, "Unexpected session-broker policy request");
            return choice;
        },
    } as unknown as PolicyDecisionFlow;
}

function allowingRuntime(flow: PolicyDecisionFlow = decisionFlow()): PolicyRuntime {
    const runtime = new PolicyRuntime(AGENT, policyDao(), flow);
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);
    return runtime;
}

test("session broker startup and shutdown are idempotent", async () => {
    const broker = new NativeFuseSessionBroker();
    await Promise.all([broker.start(), broker.start()]);
    const pid = broker.pid;
    assert.ok(pid);
    await broker.start();
    assert.equal(broker.pid, pid);
    await broker.close();
    await broker.close();
    assert.equal(broker.pid, undefined);
});

test("session broker close waits for an overlapping startup", async () => {
    const broker = new NativeFuseSessionBroker();
    const starting = broker.start();
    const closing = broker.close();
    await Promise.all([starting, closing]);

    assert.equal(broker.pid, undefined);
    assert.equal(broker.hiddenHostPath, undefined);
});

test("idle broker handshakes cannot block shutdown", async () => {
    const broker = new NativeFuseSessionBroker();
    await broker.start();
    const socketPath = path.join(broker.hiddenHostPath!, "policy.sock");
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native broker shutdown timed out")), 2_000);
    });
    try {
        await Promise.race([broker.close(), timeout]);
        assert.equal(socket.destroyed, true);
    } finally {
        if (timer) clearTimeout(timer);
        socket.destroy();
    }
});

test("one session-owned native broker serves sequential Bash mounts", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-broker-sequential-"));
    const broker = new NativeFuseSessionBroker();
    const runtime = allowingRuntime();
    await broker.start();
    const brokerPid = broker.pid;
    assert.ok(brokerPid);

    try {
        for (let index = 0; index < 2; index++) {
            const target = path.join(workspace, `file-${index}.txt`);
            const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: `broker-test-${index}`});
            try {
                const result = await runNativeFuseSandboxedCommand({
                    command: ["/bin/bash", "-c", `printf '${index}' > ${shellQuote(target)}`],
                    cwd: workspace,
                    policyView: view,
                    sessionBroker: broker,
                    timeoutSeconds: 20,
                });
                assert.equal(result.exitCode, 0);
                assert.equal(readFileSync(target, "utf8"), String(index));
                assert.equal(broker.pid, brokerPid);
                assert.equal(broker.activeMountCount, 0);
                assert.equal(brokerChildren(brokerPid!), "");
            } finally {
                view.close();
            }
        }
    } finally {
        await broker.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("one broker concurrently routes isolated tool-call policy views", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-broker-concurrent-"));
    const target = path.join(workspace, "shared.txt");
    const choices: PolicyChoice[] = [
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.DENIED,
            reason: "first tool call is denied",
        },
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "second tool call is allowed",
        },
    ];
    const runtime = new PolicyRuntime(AGENT, policyDao(), decisionFlow(choices));
    runtime.registerPolicyPrincipal(CHILD_AGENT, AGENT, [PolicyArea.fs_read]);
    const deniedView = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "broker-denied"});
    const allowedView = runtime.beginNativeFilesystemToolCall(CHILD_AGENT, {toolName: "broker-allowed"});
    await deniedView.evaluate(target, PolicyAccessType.FS_WRITE);
    await allowedView.evaluate(target, PolicyAccessType.FS_WRITE);
    const broker = new NativeFuseSessionBroker();
    await broker.start();
    const brokerPid = broker.pid;

    try {
        const [denied, allowed] = await Promise.all([
            runNativeFuseSandboxedCommand({
                command: ["/bin/bash", "-c", `if printf denied > ${shellQuote(target)}; then exit 91; fi`],
                cwd: workspace,
                policyView: deniedView,
                sessionBroker: broker,
                timeoutSeconds: 20,
            }),
            runNativeFuseSandboxedCommand({
                command: ["/bin/bash", "-c", `sleep 0.1; printf allowed > ${shellQuote(target)}`],
                cwd: workspace,
                policyView: allowedView,
                sessionBroker: broker,
                timeoutSeconds: 20,
            }),
        ]);

        assert.equal(denied.exitCode, 0);
        assert.equal(allowed.exitCode, 0);
        assert.equal(readFileSync(target, "utf8"), "allowed");
        assert.equal(broker.pid, brokerPid);
        assert.equal(broker.activeMountCount, 0);
    } finally {
        deniedView.close();
        allowedView.close();
        runtime.removePolicyPrincipal(CHILD_AGENT);
        await broker.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("session broker hides its control subtree and symlink aliases from workers", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-broker-hidden-"));
    const alias = path.join(workspace, "broker-alias");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "broker-hidden"});
    const broker = new NativeFuseSessionBroker();
    await broker.start();
    const hiddenPath = broker.hiddenHostPath;
    assert.ok(hiddenPath);
    symlinkSync(hiddenPath, alias);

    try {
        const hiddenName = path.basename(hiddenPath);
        const result = await runNativeFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `test ! -e ${shellQuote(hiddenPath)}`,
                    `test -L ${shellQuote(alias)}`,
                    `if ls ${shellQuote(`${alias}/`)} >/dev/null 2>&1; then exit 91; fi`,
                    `if ls /var/tmp | grep -Fx ${shellQuote(hiddenName)}; then exit 92; fi`,
                ].join(" && "),
            ],
            cwd: workspace,
            policyView: view,
            sessionBroker: broker,
            timeoutSeconds: 20,
        });

        assert.equal(result.exitCode, 0);
    } finally {
        view.close();
        await broker.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("session-broker shutdown aborts active mounts and removes their temporary state", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-broker-shutdown-"));
    const target = path.join(workspace, "late.txt");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "broker-shutdown"});
    const broker = new NativeFuseSessionBroker();
    await broker.start();
    const started = performance.now();

    try {
        const run = runNativeFuseSandboxedCommand({
            command: ["/bin/bash", "-c", `sleep 10; printf late > ${shellQuote(target)}`],
            cwd: workspace,
            policyView: view,
            sessionBroker: broker,
            timeoutSeconds: 20,
        });
        const rejected = assert.rejects(run, /aborted|terminated|signal/i);
        await waitFor(() => broker.mountedFilesystemCount === 1);
        await broker.close();
        await rejected;

        assert.equal(performance.now() - started < 5_000, true);
        assert.equal(broker.activeMountCount, 0);
        assert.equal(existsSync(target), false);
    } finally {
        view.close();
        await broker.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

function brokerChildren(pid: number): string {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = performance.now() + 5_000;
    while (!condition()) {
        if (performance.now() >= deadline) throw new Error("Timed out waiting for native broker state");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
