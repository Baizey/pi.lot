import {constants} from "node:fs";
import {open, type FileHandle} from "node:fs/promises";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";
import {resolveNativeExecutable} from "../../../runtime/NativeExecutable.js";
import type {NativeFilesystemPolicyView} from "./NativeFilesystemPolicyView.js";

const DRAIN_TIMEOUT_MILLISECONDS = 30_000;

/** Completes filesystem I/O before unmounting or closing policy control. */
export class NativeFuseMountCompletion {
    static async run<T>(mountpoint: string, view: NativeFilesystemPolicyView, run: () => Promise<T>): Promise<T> {
        const completion = await this.open(mountpoint, view);
        let failure: {error: unknown} | undefined;
        try {
            return await run();
        } catch (error) {
            failure = {error};
            throw error;
        } finally {
            try {
                await completion.finish();
            } catch (error) {
                if (failure) throw new AggregateError([failure.error, error], "Native FUSE run and filesystem sync both failed");
                throw error;
            }
        }
    }

    private finishing: Promise<void> | undefined;

    private constructor(
        private readonly descriptor: FileHandle,
        private readonly policyView: NativeFilesystemPolicyView,
    ) {}

    static async open(mountpoint: string, policyView: NativeFilesystemPolicyView): Promise<NativeFuseMountCompletion> {
        // Retain the frontend before the worker runs so syncfs can observe earlier errors.
        const descriptor = await open(mountpoint, constants.O_RDONLY | constants.O_DIRECTORY);
        return new NativeFuseMountCompletion(descriptor, policyView);
    }

    finish(): Promise<void> {
        this.finishing ??= this.drain().finally(() => this.descriptor.close());
        return this.finishing;
    }

    private async drain(): Promise<void> {
        const child = ManagedChildProcess.spawn({
            name: "native FUSE filesystem sync",
            command: resolveNativeExecutable("pi-fuse-native"),
            arguments: ["--syncfs", "3"],
            spawnOptions: {stdio: ["ignore", "ignore", "pipe", this.descriptor.fd]},
        });
        let stderr = "";
        child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
        let timedOut = false;
        const timeout = this.policyView.approvalWaitScope.setTimeout(() => {
            timedOut = true;
            child.terminate();
        }, DRAIN_TIMEOUT_MILLISECONDS);
        try {
            const result = await child.wait();
            if (timedOut) throw new Error("Native FUSE filesystem sync timed out; dirty changes may be lost");
            if (result.exitCode !== 0 || result.signal) {
                throw new Error(
                    `Native FUSE filesystem sync failed; dirty changes may be lost: `
                    + `code=${String(result.exitCode)} signal=${String(result.signal)} ${stderr}`,
                );
            }
        } finally {
            timeout.dispose();
        }
    }
}
