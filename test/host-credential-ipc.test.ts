import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import type {ChildProcess} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {prepareHostCredentialIpc} from "../src/policy/network/ipc/HostCredentialIpc.js";
import {
    applyWorkerResourceEnvironment,
    workerBindMountArguments,
} from "../src/policy/network/worker/WorkerRuntimeResource.js";

test("host credential IPC imports a live Unix socket from a configured environment variable", async () => {
    const runtimeDirectory = mkdtempSync(path.join(os.tmpdir(), "pilot-ipc-resource-test-"));
    const socketPath = path.join(runtimeDirectory, "agent.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    try {
        const resources = await prepareHostCredentialIpc({
            runtimeDirectory,
            environment: {TEST_AGENT_SOCK: socketPath},
            ipc: {unixSockets: [{id: "test-agent", environment: "TEST_AGENT_SOCK"}]},
        });

        assert.equal(resources.length, 1);
        assert.deepEqual(resources[0]!.mounts(), [{
            source: socketPath,
            destination: socketPath,
            readOnly: true,
        }]);
        assert.equal(
            applyWorkerResourceEnvironment({}, resources).TEST_AGENT_SOCK,
            socketPath,
        );
        assert.deepEqual(workerBindMountArguments(resources[0]!.mounts()), [
            "--ro-bind",
            socketPath,
            socketPath,
        ]);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(runtimeDirectory, {recursive: true, force: true});
    }
});

test("host credential IPC reports stale socket variables without failing unrelated commands", async () => {
    const runtimeDirectory = mkdtempSync(path.join(os.tmpdir(), "pilot-ipc-stale-test-"));
    const errors: unknown[] = [];
    try {
        const resources = await prepareHostCredentialIpc({
            runtimeDirectory,
            environment: {TEST_AGENT_SOCK: path.join(runtimeDirectory, "missing.sock")},
            ipc: {
                unixSockets: [{id: "test-agent", environment: "TEST_AGENT_SOCK", optional: false}],
            },
            onError: (error) => errors.push(error),
        });

        assert.deepEqual(resources, []);
        assert.equal(errors.length, 1);
        assert.match(String(errors[0]), /missing\.sock|ENOENT/);
    } finally {
        rmSync(runtimeDirectory, {recursive: true, force: true});
    }
});

test("Secret Service uses a filtered private D-Bus proxy", async () => {
    const runtimeDirectory = mkdtempSync(path.join(os.tmpdir(), "pilot-secret-service-test-"));
    const upstreamPath = path.join(runtimeDirectory, "upstream-bus");
    const daemon = spawn("/usr/bin/dbus-daemon", [
        "--session",
        "--nofork",
        `--address=unix:path=${upstreamPath}`,
        "--print-address=1",
    ], {stdio: ["ignore", "pipe", "pipe"]});
    const resources: Awaited<ReturnType<typeof prepareHostCredentialIpc>> = [];

    try {
        const upstreamAddress = await firstLine(daemon);
        resources.push(...await prepareHostCredentialIpc({
            runtimeDirectory,
            environment: {DBUS_SESSION_BUS_ADDRESS: upstreamAddress},
            ipc: {sessionBus: {talk: ["org.freedesktop.secrets"]}},
        }));

        assert.equal(resources.length, 1);
        const environment = applyWorkerResourceEnvironment({}, resources);
        assert.match(environment.DBUS_SESSION_BUS_ADDRESS ?? "", /^unix:path=.*credential-session-bus$/);
        assert.equal(resources[0]!.mounts()[0]?.readOnly, true);

        const output = await execFileText("/usr/bin/busctl", [
            `--address=${environment.DBUS_SESSION_BUS_ADDRESS}`,
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "ListNames",
        ]);
        assert.match(output, /org\.freedesktop\.DBus/);
    } finally {
        await Promise.allSettled(resources.map((resource) => resource.close?.()));
        daemon.kill("SIGTERM");
        await settleChild(daemon);
        rmSync(runtimeDirectory, {recursive: true, force: true});
    }
});

test("worker bind plans reject duplicate destinations", () => {
    assert.throws(
        () => workerBindMountArguments([
            {source: "/first", destination: "/worker/socket", readOnly: true},
            {source: "/second", destination: "/worker/socket", readOnly: true},
        ]),
        /duplicate worker bind destination/,
    );
});

function firstLine(child: ChildProcess): Promise<string> {
    const stdout = child.stdout;
    if (!stdout) return Promise.reject(new Error("child stdout is unavailable"));
    return new Promise((resolve, reject) => {
        let buffer = "";
        const cleanup = () => {
            stdout.off("data", onData);
            child.off("error", onError);
            child.off("exit", onExit);
        };
        const onData = (data: Buffer) => {
            buffer += data.toString();
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            cleanup();
            resolve(buffer.slice(0, newline));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            reject(new Error(`child exited before producing a line: ${signal ?? code}`));
        };
        stdout.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
    });
}

function execFileText(executable: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(executable, args, {encoding: "utf8"}, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
                return;
            }
            resolve(stdout);
        });
    });
}

function settleChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once("close", () => resolve()));
}
