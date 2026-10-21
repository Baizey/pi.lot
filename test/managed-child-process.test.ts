import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {ManagedChildProcess} from "../src/runtime/ManagedChildProcess.js";

test("production subprocess creation has explicit session or archive ownership", () => {
    const imports = sourceFiles(path.resolve("src"))
        .filter((file) => readFileSync(file, "utf8").includes("node:child_process"))
        .map((file) => path.relative(process.cwd(), file));

    // Archive workers must outlive the Pi session; their launcher cannot use its
    // managed-process lifetime. The lock owner separately reaps short flock helpers.
    assert.deepEqual(imports, [
        path.join("src", "runtime", "ManagedChildProcess.ts"),
        path.join("src", "server", "ArchiveLock.ts"),
        path.join("src", "server", "ArchiveRuntime.ts"),
    ]);
});

test("managed child processes own input, output, and normal completion", async () => {
    const child = ManagedChildProcess.spawn({
        name: "echo fixture",
        command: process.execPath,
        arguments: ["-e", "process.stdin.pipe(process.stdout)"],
        spawnOptions: {stdio: ["pipe", "pipe", "pipe"]},
    });
    const output: Buffer[] = [];
    child.stdout?.on("data", (data: Buffer) => output.push(data));

    await child.write(0, "managed input");
    child.end(0);
    const result = await child.wait();

    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(Buffer.concat(output).toString(), "managed input");
});

test("unexpected stdio errors become managed failures instead of uncaught exceptions", async () => {
    const failures: Error[] = [];
    const child = ManagedChildProcess.spawn({
        name: "reset fixture",
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        spawnOptions: {stdio: ["ignore", "pipe", "pipe"]},
        onFailure(error) {
            failures.push(error);
            throw new Error("failure reporter crashed");
        },
    });
    const reset = Object.assign(new Error("read ECONNRESET"), {code: "ECONNRESET"});

    assert.doesNotThrow(() => child.stdout?.emit("error", reset));
    await assert.rejects(child.wait(), /reset fixture stdout failed: read ECONNRESET/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.cause, reset);
});

test("process startup errors are reported through managed completion", async () => {
    const failures: Error[] = [];
    const child = ManagedChildProcess.spawn({
        name: "missing fixture",
        command: path.join(process.cwd(), "missing-managed-child-process"),
        spawnOptions: {stdio: "ignore"},
        onFailure: (error) => failures.push(error),
    });

    await assert.rejects(child.wait(), /missing fixture process failed: spawn .* ENOENT/);
    assert.equal(failures.length, 1);
    assert.equal((failures[0]?.cause as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    assert.equal(await child.settle(), true);
});

test("planned shutdown suppresses teardown stream resets and still permits termination", async () => {
    const failures: Error[] = [];
    const child = ManagedChildProcess.spawn({
        name: "shutdown fixture",
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        spawnOptions: {stdio: ["ignore", "pipe", "pipe"]},
        onFailure: (error) => failures.push(error),
    });

    child.beginShutdown();
    assert.doesNotThrow(() => child.stdout?.emit("error", new Error("read ECONNRESET")));
    child.terminate();
    const result = await child.wait();

    assert.equal(result.signal, "SIGKILL");
    assert.deepEqual(failures, []);
});

test("settle cancels its unreferenced watchdog when process completion wins", async (t) => {
    const child = waitingChild(t);
    const clock = new WatchdogClock(t);
    const settling = child.settle(100);
    let settled = false;
    void settling.then(() => { settled = true; });

    clock.advance(99);
    await Promise.resolve();
    assert.equal(settled, false);
    child.end(0);
    assert.equal(await settling, true);
    clock.advance(1_000);
    assert.deepEqual(clock.timers, [{milliseconds: 100, unrefs: 1, fired: false}]);
    assert.equal((await child.wait()).exitCode, 0);
});

test("settle times out without terminating the child and a later call can observe completion", async (t) => {
    const child = waitingChild(t);
    const clock = new WatchdogClock(t);
    const settling = child.settle(100);
    let settled = false;
    void settling.then(() => { settled = true; });

    clock.advance(99);
    await Promise.resolve();
    assert.equal(settled, false);
    clock.advance(1);
    assert.equal(await settling, false);
    assert.equal(child.failure, undefined);

    const retry = child.settle(500);
    child.end(0);
    assert.equal(await retry, true);
    assert.equal((await child.wait()).exitCode, 0);
    clock.advance(1_000);
    assert.deepEqual(clock.timers, [
        {milliseconds: 100, unrefs: 1, fired: true},
        {milliseconds: 500, unrefs: 1, fired: false},
    ]);
});

test("settle handles completed children repeatedly, including zero and default delays", async (t) => {
    const child = waitingChild(t);
    child.end(0);
    await child.wait();
    const clock = new WatchdogClock(t);

    assert.equal(await child.settle(0), true);
    assert.equal(await child.settle(), true);
    assert.equal(await child.settle(25), true);
    clock.advance(1_000);
    assert.deepEqual(clock.timers, [
        {milliseconds: 0, unrefs: 1, fired: false},
        {milliseconds: 1_000, unrefs: 1, fired: false},
        {milliseconds: 25, unrefs: 1, fired: false},
    ]);
});

test("settle favors completed children when the zero-delay watchdog is also ready", async (t) => {
    const child = waitingChild(t);
    child.end(0);
    await child.wait();
    const clock = new WatchdogClock(t);

    const settling = child.settle(0);
    clock.advance(0);
    assert.equal(await settling, true);
    assert.deepEqual(clock.timers, [{milliseconds: 0, unrefs: 1, fired: true}]);
});

test("settle rejects invalid delays without registering a watchdog", async (t) => {
    const child = waitingChild(t);
    const clock = new WatchdogClock(t);

    for (const milliseconds of [-1, NaN, Infinity, -Infinity]) {
        await assert.rejects(
            child.settle(milliseconds),
            /Managed child-process settle timeout must be a non-negative finite number/,
        );
    }
    assert.deepEqual(clock.timers, []);
});

class WatchdogClock {
    readonly timers: Array<{milliseconds: number; unrefs: number; fired: boolean}> = [];

    constructor(private readonly context: TestContext) {
        context.mock.timers.enable({apis: ["setTimeout"]});
        const schedule = globalThis.setTimeout;
        context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds: number) => {
            const timer = {milliseconds, unrefs: 0, fired: false};
            this.timers.push(timer);
            const handle = schedule(() => {
                timer.fired = true;
                callback();
            }, milliseconds);
            context.mock.method(handle, "unref", () => { timer.unrefs++; return handle; });
            return handle;
        });
    }

    advance(milliseconds: number): void {
        this.context.mock.timers.tick(milliseconds);
    }
}

function waitingChild(context: TestContext): ManagedChildProcess {
    const child = ManagedChildProcess.spawn({
        name: "settle fixture",
        command: process.execPath,
        arguments: ["-e", "process.stdin.resume()"],
        spawnOptions: {stdio: ["pipe", "ignore", "ignore"]},
    });
    context.after(async () => {
        child.terminate();
        await child.waitForExit();
    });
    return child;
}

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(candidate);
        return entry.isFile() && entry.name.endsWith(".ts") ? [candidate] : [];
    }).sort();
}
