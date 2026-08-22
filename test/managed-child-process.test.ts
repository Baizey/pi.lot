import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {ManagedChildProcess} from "../src/runtime/ManagedChildProcess.js";

test("production subprocess creation is centralized in the managed owner", () => {
    const imports = sourceFiles(path.resolve("src"))
        .filter((file) => readFileSync(file, "utf8").includes("node:child_process"))
        .map((file) => path.relative(process.cwd(), file));

    assert.deepEqual(imports, [path.join("src", "runtime", "ManagedChildProcess.ts")]);
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

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(candidate);
        return entry.isFile() && entry.name.endsWith(".ts") ? [candidate] : [];
    }).sort();
}
