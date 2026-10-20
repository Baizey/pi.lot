import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {afterEach, mock, test} from "node:test";
import {ArchiveRuntime} from "../src/server/ArchiveRuntime.js";
import {ArchiveLock} from "../src/server/ArchiveLock.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const bootstrap = path.join(root, "src/server/archive-worker.mjs");

function externalNode(): string {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        try {
            const candidate = fs.realpathSync(path.join(directory, "node"));
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* Continue searching only test fixture candidates. */ }
    }
    throw new Error("These subprocess tests require external Node on PATH");
}

function temporaryDirectory(inRepository = false): string {
    return fs.mkdtempSync(path.join(inRepository ? root : os.tmpdir(), ".pilot-archive-runtime-test-"));
}

afterEach(() => mock.restoreAll());

test("initialization executes the production bootstrap SQLite check, without a worker engine", async () => {
    const runtime = new ArchiveRuntime();
    await runtime.initialize();
    await runtime.initialize();
});

test("runtime rejects uninitialized launch and relative executable/bootstrap/directory paths", async () => {
    await assert.rejects(new ArchiveRuntime().launch(root, root), /not initialized/);
    await assert.rejects(new ArchiveRuntime({nodeExecutable: "node"}).initialize(), /must be absolute/);
    await assert.rejects(new ArchiveRuntime({bootstrap: "archive-worker.mjs"}).initialize(), /must be absolute/);
    const runtime = new ArchiveRuntime();
    await runtime.initialize();
    await assert.rejects(runtime.launch("relative", root), /must be absolute/);
    await assert.rejects(runtime.launch(root, "relative"), /must be absolute/);
});

test("validation rejects old Node, Bun, non-Node executables, and malformed versions", async () => {
    for (const version of [
        {node: "22.18.9", name: "node", bun: false},
        {node: "20.99.0", name: "node", bun: false},
        {node: "22.19.0", name: "node", bun: true},
        {node: "24.0.0", name: "bun", bun: false},
        {node: "not-a-version", name: "node", bun: false},
    ]) {
        const check = mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown,
            callback: (error: Error | null, stdout: string) => void) => {
            queueMicrotask(() => callback(null, JSON.stringify(version)));
            return new childProcess.ChildProcess();
        });
        await assert.rejects(new ArchiveRuntime().initialize(), /external Node >=22.19/);
        assert.equal(check.mock.callCount(), 1, "incompatible executables must not run the bootstrap");
        check.mock.restore();
    }
});

test("validation accepts the minimum Node version and uses a bounded clean bootstrap check", async () => {
    const check = mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown,
        callback: (error: Error | null, stdout: string) => void) => {
        queueMicrotask(() => callback(null, args[0] === "--eval"
            ? JSON.stringify({node: "22.19.0", name: "node", bun: false}) : ""));
        return new childProcess.ChildProcess();
    });
    const runtime = new ArchiveRuntime();
    await Promise.all([runtime.initialize(), runtime.initialize()]);
    assert.equal(check.mock.callCount(), 2);
    assert.deepEqual(check.mock.calls[1]?.arguments[1], [fs.realpathSync(bootstrap), "--check"]);
    const options = check.mock.calls[1]?.arguments[2];
    assert.ok(options !== null && typeof options === "object");
    assert.ok("timeout" in options && options.timeout === 5_000);
    assert.ok("maxBuffer" in options && options.maxBuffer === 16 * 1024);
});

test("a failing bootstrap check rejects initialization and permits retry", async () => {
    const directory = temporaryDirectory();
    try {
        const failedBootstrap = path.join(directory, "bootstrap.mjs");
        fs.writeFileSync(failedBootstrap, "console.error('secret-bootstrap-diagnostic'); process.exitCode = 1;\n");
        const runtime = new ArchiveRuntime({nodeExecutable: externalNode(), bootstrap: failedBootstrap});
        await assert.rejects(runtime.initialize(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /runtime validation failed/);
            assert.equal(error.cause, undefined, "raw execFile errors may expose subprocess stderr");
            assert.ok(!error.stack?.includes("secret-bootstrap-diagnostic"));
            return true;
        });
        await assert.rejects(runtime.launch(root, root), /not initialized/);
        fs.writeFileSync(failedBootstrap, "process.exitCode = 0;\n");
        await runtime.initialize();
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("launch is shell-free, detached, unreferenced, absolute, and does not wait for worker completion", async () => {
    const runtime = new ArchiveRuntime();
    await runtime.initialize();
    const child = new childProcess.ChildProcess();
    const unref = mock.method(child, "unref", () => {});
    const kill = mock.method(child, "kill", () => true);
    const spawn = mock.method(childProcess, "spawn", () => child);
    const launched = runtime.launch(root, root);
    child.emit("spawn");
    await launched;
    assert.equal(unref.mock.callCount(), 1);
    assert.equal(kill.mock.callCount(), 0);
    const args = spawn.mock.calls[0]?.arguments;
    assert.ok(args);
    assert.equal(args[0], externalNode());
    assert.deepEqual(args[1], [fs.realpathSync(bootstrap), root, root]);
    const options = args[2];
    assert.ok(options);
    assert.ok(options.env);
    assert.equal(options.detached, true);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.shell, false);
    assert.equal(options.cwd, path.dirname(fs.realpathSync(bootstrap)));
    assert.deepEqual(Object.keys(options.env).sort(), [
        ...(process.env.HOME && path.isAbsolute(process.env.HOME) ? ["HOME"] : []),
        "PATH",
        ...(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? ["TMPDIR"] : []),
    ].sort());
    assert.equal(options.env.PATH, "/usr/bin:/bin");
    assert.doesNotThrow(() => child.emit("error", new Error("late process error")));
});

test("spawn errors are observed and reaped rather than reported as a successful launch", async () => {
    const runtime = new ArchiveRuntime();
    await runtime.initialize();
    const child = new childProcess.ChildProcess();
    const unref = mock.method(child, "unref", () => {});
    mock.method(childProcess, "spawn", () => child);
    const launched = runtime.launch(root, root);
    child.emit("error", Object.assign(new Error("missing"), {code: "ENOENT"}));
    await assert.rejects(launched, /could not be spawned/);
    assert.equal(unref.mock.callCount(), 1);
    assert.doesNotThrow(() => child.emit("close", -2, null));
});

test("one-second launch deadline rejects before close while retaining kill/reap cleanup", async () => {
    const runtime = new ArchiveRuntime();
    await runtime.initialize();
    const child = new childProcess.ChildProcess();
    Object.defineProperty(child, "pid", {value: 12345});
    const kill = mock.method(child, "kill", () => true);
    const unref = mock.method(child, "unref", () => {});
    mock.method(childProcess, "spawn", () => child);
    mock.timers.enable({apis: ["setTimeout"]});
    try {
        const launched = runtime.launch(root, root);
        mock.timers.tick(1_000);
        await assert.rejects(launched, /timed out after one second/);
        assert.deepEqual(kill.mock.calls[0]?.arguments, ["SIGKILL"]);
        assert.equal(unref.mock.callCount(), 1, "cleanup must not keep the parent alive");
        child.emit("spawn");
        assert.equal(kill.mock.callCount(), 2, "a late spawn must not escape cleanup");
        assert.doesNotThrow(() => child.emit("error", new Error("late cleanup error")));
        assert.doesNotThrow(() => child.emit("close", null, "SIGKILL"));
    } finally {
        mock.timers.reset();
    }
});

test("a child with no PID at deadline is killed if spawn arrives after rejection", async () => {
    const runtime = new ArchiveRuntime();
    await runtime.initialize();
    const child = new childProcess.ChildProcess();
    const kill = mock.method(child, "kill", () => true);
    const unref = mock.method(child, "unref", () => {});
    mock.method(childProcess, "spawn", () => child);
    mock.timers.enable({apis: ["setTimeout"]});
    try {
        const launched = runtime.launch(root, root);
        mock.timers.tick(1_000);
        await assert.rejects(launched, /timed out after one second/);
        assert.equal(kill.mock.callCount(), 0);
        assert.equal(unref.mock.callCount(), 1);
        Object.defineProperty(child, "pid", {value: 12345});
        child.emit("spawn");
        assert.deepEqual(kill.mock.calls[0]?.arguments, ["SIGKILL"]);
        assert.equal(unref.mock.callCount(), 2);
        child.emit("close", null, "SIGKILL");
    } finally {
        mock.timers.reset();
    }
});

test("real failed spawn is reported locally after a validated executable disappears", async () => {
    const directory = temporaryDirectory();
    try {
        const executable = path.join(directory, "node");
        // A symlink is unnecessary (and may be forbidden by the sandbox).
        fs.copyFileSync(externalNode(), executable);
        fs.chmodSync(executable, 0o700);
        const runtime = new ArchiveRuntime({nodeExecutable: executable});
        await runtime.initialize();
        fs.unlinkSync(executable);
        await assert.rejects(runtime.launch(root, root), /could not be spawned/);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("installed production entrypoint imports the actual worker and exits on lock contention without journal mutation", {timeout: 15_000}, async () => {
    const directory = temporaryDirectory();
    const configDirectory = path.join(directory, "config");
    const lockFile = path.join(directory, "worker.lock");
    const lock = new ArchiveLock(lockFile);
    try {
        fs.mkdirSync(configDirectory, {mode: 0o700});
        assert.equal(lock.acquire(), true);
        const inode = fs.statSync(lockFile).ino;
        const output = await new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
            childProcess.execFile(externalNode(), [bootstrap, directory, configDirectory], {
                cwd: configDirectory,
                env: {PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory},
                timeout: 10_000,
                killSignal: "SIGKILL",
                maxBuffer: 16 * 1024,
            }, (error, stdout, stderr) => {
                if (error) reject(new Error("Installed archive entrypoint contention smoke failed"));
                else resolve({stdout, stderr});
            });
        });
        assert.equal(output.stdout, "");
        assert.equal(output.stderr, "");
        assert.equal(fs.statSync(lockFile).ino, inode);
        assert.deepEqual(fs.readdirSync(directory).sort(), ["config", "worker.lock"], "losing election must not create a journal");
        assert.deepEqual(fs.readdirSync(configDirectory), [], "losing election must not mutate configuration");
    } finally {
        lock.release();
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("production bootstrap with a typed fixture worker survives ordinary launcher-parent exit (not an engine test)", {timeout: 15_000}, async () => {
    // Keep the copied, unmodified bootstrap below the package so it resolves production dependencies.
    // This proves launch/bootstrap/lifetime, not the separately owned archive engine or production WAL.
    const directory = temporaryDirectory(true);
    try {
        fs.copyFileSync(bootstrap, path.join(directory, "archive-worker.mjs"));
        fs.writeFileSync(path.join(directory, "ArchiveWorker.ts"), `
import fs from "node:fs";
import path from "node:path";
export async function runArchiveWorker(directory: string, configDirectory: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const parentPid: number = Number(fs.readFileSync(path.join(directory, "parent-pid"), "utf8"));
    let parentAlive = true;
    try { process.kill(parentPid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        parentAlive = false;
    }
    fs.writeFileSync(path.join(directory, "worker-result.json"), JSON.stringify({
        directory, configDirectory, parentAlive, env: process.env,
        execArgv: process.execArgv, cwd: process.cwd()
    }));
}
`);
        const parent = path.join(directory, "parent.mjs");
        fs.writeFileSync(parent, `
import fs from "node:fs";
import {createJiti} from "jiti";
const jiti = createJiti(import.meta.url, {fsCache: false});
const {ArchiveRuntime} = await jiti.import(${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveRuntime.ts")).href)});
process.env.NODE_OPTIONS = "--not-a-valid-node-option";
process.env.OPENAI_API_KEY = "must-not-reach-worker";
process.env.PILOT_SESSION_ID = "must-not-reach-worker";
process.env.LD_PRELOAD = "must-not-reach-worker";
fs.writeFileSync(${JSON.stringify(path.join(directory, "parent-pid"))}, String(process.pid));
const runtime = new ArchiveRuntime({bootstrap: ${JSON.stringify(path.join(directory, "archive-worker.mjs"))}});
await runtime.initialize();
await runtime.launch(${JSON.stringify(directory)}, ${JSON.stringify(root)});
`);
        await new Promise<void>((resolve, reject) => {
            childProcess.execFile(externalNode(), ["--import", "jiti/register", parent], {
                cwd: root, timeout: 10_000, killSignal: "SIGKILL",
                env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR},
            }, (error, _stdout, stderr) => {
                if (error) reject(new Error(`Smoke launcher failed: ${stderr}`, {cause: error}));
                else resolve();
            });
        });
        const resultFile = path.join(directory, "worker-result.json");
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(resultFile) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(fs.existsSync(resultFile), "detached worker must write after launcher exit");
        const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        assert.equal(result.parentAlive, false);
        assert.equal(result.directory, directory);
        assert.equal(result.configDirectory, root);
        assert.equal(result.cwd, directory);
        assert.deepEqual(result.execArgv, []);
        assert.equal(result.env.NODE_OPTIONS, undefined);
        assert.equal(result.env.LD_PRELOAD, undefined);
        assert.equal(result.env.OPENAI_API_KEY, undefined);
        assert.equal(result.env.PILOT_SESSION_ID, undefined);
        assert.ok(Object.keys(result.env).every((key) => ["HOME", "TMPDIR", "PATH"].includes(key)));
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
