import {constants} from "node:fs";
import {open, type FileHandle} from "node:fs/promises";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";
import {resolveNativeExecutable} from "../../../runtime/NativeExecutable.js";
import type {NativeFilesystemPolicyView} from "./NativeFilesystemPolicyView.js";

const DRAIN_TIMEOUT_MILLISECONDS = 30_000;

/** Holds a frontend descriptor from before the worker starts, so syncfs can
 * observe this call's superblock writeback errors even after file handles close.
 * Finish while policy control is live, after all worker processes have stopped.
 */
export class NativeFuseMappedWriteDrain {
    private finishing: Promise<void> | undefined;

    private constructor(
        private readonly descriptor: FileHandle,
        private readonly policyView: NativeFilesystemPolicyView,
    ) {}

    static async open(mountpoint: string, policyView: NativeFilesystemPolicyView): Promise<NativeFuseMappedWriteDrain> {
        const descriptor = await open(mountpoint, constants.O_RDONLY | constants.O_DIRECTORY);
        return new NativeFuseMappedWriteDrain(descriptor, policyView);
    }

    finish(): Promise<void> {
        this.finishing ??= this.drain().finally(() => this.descriptor.close());
        return this.finishing;
    }

    private async drain(): Promise<void> {
        const child = ManagedChildProcess.spawn({
            name: "native FUSE mapped-write drain",
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
            if (timedOut) throw new Error("Native FUSE mapped-write drain timed out; dirty changes may be lost");
            if (result.exitCode !== 0 || result.signal) {
                throw new Error(
                    `Native FUSE mapped-write drain failed; dirty changes may be lost: `
                    + `code=${String(result.exitCode)} signal=${String(result.signal)} ${stderr}`,
                );
            }
        } finally {
            timeout.dispose();
        }
    }
}
