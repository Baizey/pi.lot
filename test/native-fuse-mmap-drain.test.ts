import assert from "node:assert/strict";
import {fstatSync} from "node:fs";
import {mkdtemp, rm} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {NativeFuseMappedWriteDrain} from "../src/policy/path/native/NativeFuseMappedWriteDrain.js";
import {ManagedChildProcess, type ManagedChildProcessOptions} from "../src/runtime/ManagedChildProcess.js";

for (const fail of [false, true]) {
    test(`mapped-write drain uses and closes a retained frontend descriptor, with helper failure ${fail}`, async (t) => {
        const directory = await mkdtemp(path.join("/dev/shm", "pilot-mmap-drain-"));
        const runtime = new PolicyRuntime("mmap-drain-test", {
            initializeSchema() {}, loadPolicies: () => [], upsertPolicies() {}, deletePolicy() {},
        }, {
            async resolveQueuedPolicy() { throw new Error("Unexpected approval"); },
        });
        const view = runtime.beginNativeFilesystemToolCall("mmap-drain-test", {toolName: "drain-test"});
        const spawn = ManagedChildProcess.spawn;
        const calls: ManagedChildProcessOptions[] = [];
        let child: ManagedChildProcess | undefined;
        t.mock.method(ManagedChildProcess, "spawn", (options: ManagedChildProcessOptions) => {
            calls.push(options);
            child = spawn(fail ? {...options, arguments: ["--syncfs", "2147483647"]} : options);
            return child;
        });
        try {
            const drain = await NativeFuseMappedWriteDrain.open(directory, view);
            const finished = drain.finish();
            assert.equal(drain.finish(), finished, "repeated finish must share one drain");
            if (fail) await assert.rejects(finished, /mapped-write drain failed; dirty changes may be lost/);
            else await finished;
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0]!.arguments, ["--syncfs", "3"]);
            const stdio = calls[0]!.spawnOptions!.stdio;
            assert.ok(Array.isArray(stdio));
            const descriptor = stdio[3];
            assert.equal(typeof descriptor, "number");
            assert.throws(() => fstatSync(descriptor as number), {code: "EBADF"});
            assert.ok(child);
            assert.deepEqual(await child.waitForExit(), {exitCode: fail ? 1 : 0, signal: null});
        } finally {
            view.close();
            runtime.beginShutdown();
            await rm(directory, {recursive: true, force: true});
        }
    });
}
