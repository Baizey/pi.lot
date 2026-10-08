import assert from "node:assert/strict";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {createServer, type Socket} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function lines(child: ChildProcessWithoutNullStreams) {
    let bytes = "";
    const ready: string[] = [];
    const pending: Array<(line: string) => void> = [];
    child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.toString();
        while (bytes.includes("\n")) {
            const end = bytes.indexOf("\n");
            const line = bytes.slice(0, end);
            bytes = bytes.slice(end + 1);
            const resolve = pending.shift();
            if (resolve) resolve(line); else ready.push(line);
        }
    });
    return () => ready.length ? Promise.resolve(ready.shift()!) : new Promise<string>((resolve, reject) => {
        const receive = (line: string) => { clearTimeout(timer); resolve(line); };
        const timer = setTimeout(() => {
            const index = pending.indexOf(receive);
            if (index >= 0) pending.splice(index, 1);
            reject(new Error("Timed out waiting for a FUSE broker record"));
        }, 3_000);
        pending.push(receive);
    });
}

async function until(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function dead(pid: number): boolean {
    try { return /^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

test("FUSE broker stops and reaps blocked workers and kills workers on parent death", {timeout: 10_000}, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-fuse-broker-"));
    const endpoint = path.join(directory, "controller.sock");
    const sockets: Socket[] = [];
    const received: string[] = [];
    const server = createServer((socket) => {
        sockets.push(socket);
        socket.on("error", () => {});
        let bytes = "";
        socket.on("data", (chunk: Buffer) => {
            bytes += chunk;
            if (bytes.includes("\n")) received.push(bytes.slice(0, bytes.indexOf("\n")));
            // Intentionally never acknowledge: the real worker is blocked
            // in production controller authentication, before any mount.
        });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    const child = spawn(path.join(root, "build/pi-fuse-native"), ["--broker"], {stdio: ["pipe", "pipe", "pipe"]});
    const next = lines(child);
    const completion = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({code, signal}));
    });
    const start = (token: string) => child.stdin.write(`START\t${token}\t${directory}/mount\t${directory}/hidden\t${directory}/snapshot\t${directory}/stats\t${endpoint}\n`);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    let worker = 0;
    try {
        start("first");
        const started = (await next()).split("\t");
        assert.deepEqual(started.slice(0, 2), ["STARTED", "first"]);
        worker = Number(started[2]);
        assert.ok(Number.isInteger(worker) && worker > 0);
        await until(() => received.includes("first"), "worker must authenticate before STOP");
        child.stdin.write("STOP\tfirst\n");
        assert.equal(await next(), "STOPPED\tfirst");
        assert.equal(existsSync(`/proc/${worker}`), false, "STOP must reap, not merely signal the worker");
        child.stdin.write("STOP\tabsent\n");
        assert.equal(await next(), "STOPPED\tabsent");
        start("second");
        const second = (await next()).split("\t");
        assert.deepEqual(second.slice(0, 2), ["STARTED", "second"]);
        worker = Number(second[2]);
        assert.ok(Number.isInteger(worker) && worker > 0);
        await until(() => received.includes("second"), "second worker must be blocked in controller authentication");
        child.kill("SIGKILL");
        assert.deepEqual(await completion, {code: null, signal: "SIGKILL"});
        await until(() => dead(worker), "worker must die when its broker parent is killed");
        assert.equal(stderr, "");
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (worker && !dead(worker)) { try { process.kill(worker, "SIGKILL"); } catch {} }
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, {recursive: true, force: true});
    }
});
