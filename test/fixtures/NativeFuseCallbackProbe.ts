import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {Writable} from "node:stream";
import {fileURLToPath} from "node:url";
import {fuseFlags, netfilterQueueFlags} from "../../scripts/native-build-flags.mjs";
import {
    decodeNativeFilesystemControlFrames,
    decodeNativeFilesystemPolicyMiss,
    encodeNativeFilesystemOnceSnapshotMessage,
    encodeNativeFilesystemPolicySnapshot,
    NativeFilesystemRequestMessage,
    type NativeFilesystemPolicyMiss,
} from "../../src/policy/path/native/NativeFilesystemPolicyProtocol.js";
import {PolicyResolutionSource, type Policy} from "../../src/policy/types.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The actual C callback driver linked to the production Rust static library. */
export class NativeFuseCallbackProbe {
    private constructor(private readonly buildDirectory: string, readonly executable: string) {}

    static async build(): Promise<NativeFuseCallbackProbe> {
        const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-callback-build-"));
        const executable = path.join(directory, "probe");
        try {
            const compiled = childProcess.spawnSync("cc", [
                "-std=c17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
                "-o", executable, path.join(root, "test/fixtures/native-fuse-callback-probe.c"),
                ...this.buildFlags(),
            ], {cwd: root, encoding: "utf8"});
            assert.ifError(compiled.error);
            assert.equal(compiled.status, 0, compiled.stderr);
            return new NativeFuseCallbackProbe(directory, executable);
        } catch (error) {
            await rm(directory, {recursive: true, force: true});
            throw error;
        }
    }

    // The independent INIT driver links the same production library and SDKs.
    static buildFlags(): string[] {
        return [
            path.join(root, "build/libpilot_native.a"),
            ...fuseFlags(),
            ...netfilterQueueFlags(),
            "-lgcc_s", "-lutil", "-lrt", "-lpthread", "-lm", "-ldl",
        ];
    }

    static async withFixture(run: (directory: string) => Promise<void>): Promise<void> {
        // Linux tmpfs keeps backing fixtures off any inherited FUSE root mount.
        const directory = await mkdtemp(path.join("/dev/shm", "pilot-callback-test-"));
        try {
            await run(directory);
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    }

    async run(directory: string, policies: Policy[], ...args: string[]): Promise<{
        stdout: string;
        denials: NativeFilesystemPolicyMiss[];
    }> {
        const snapshotPath = path.join(directory, "policy.snapshot");
        await writeFile(snapshotPath, encodeNativeFilesystemPolicySnapshot({
            revision: 1,
            layers: [{policies, resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY}],
        }));
        const child = childProcess.spawn(this.executable, [snapshotPath, path.join(directory, "hidden"), ...args], {
            stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        });
        const responses = child.stdio[4] as Writable;
        let responseError: Error | undefined;
        responses.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "EPIPE" && error.code !== "ECONNRESET") responseError = error;
        });
        let spawnError: Error | undefined;
        child.once("error", (error) => { spawnError = error; });
        const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
        let stdout = "";
        let stderr = "";
        const requests: Buffer[] = [];
        child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk; });
        child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
        child.stdio[3]!.on("data", (chunk: Buffer) => { requests.push(chunk); });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        let exitCode: number | null;
        try {
            // Initial ONCE precedes callbacks. Keep the controller live until close:
            // EOF deliberately fails authorization even with allowing snapshots.
            responses.write(encodeNativeFilesystemOnceSnapshotMessage({revision: 1, layers: []}));
            exitCode = await closed;
        } finally {
            clearTimeout(timeout);
            responses.destroy();
        }
        // close, not exit, ensures every output descriptor has drained before decoding.
        assert.ifError(spawnError);
        assert.ifError(responseError);
        assert.equal(exitCode, 0, `${args.join(" ")}: ${stderr}`);
        const decoded = decodeNativeFilesystemControlFrames(Buffer.concat(requests));
        assert.equal(decoded.remainder.length, 0);
        assert.ok(decoded.frames.every((frame) => frame.type === NativeFilesystemRequestMessage.DENIAL), "unexpected policy miss");
        return {
            stdout,
            denials: decoded.frames.map((frame) => decodeNativeFilesystemPolicyMiss(frame.payload)),
        };
    }

    async close(): Promise<void> {
        await rm(this.buildDirectory, {recursive: true, force: true});
    }
}
