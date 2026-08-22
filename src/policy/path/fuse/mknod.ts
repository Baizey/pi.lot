import {fileURLToPath} from "node:url";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";
import {FuseErrnoError} from "./fuse-errors.js";

const MKNOD_HELPER = fileURLToPath(new URL("../../../../build/pi-mknod-native", import.meta.url));

export async function mknod(hostPath: string, mode: number, device: number): Promise<void> {
    const child = ManagedChildProcess.spawn({
        name: "mknod helper",
        command: MKNOD_HELPER,
        arguments: [String(mode), String(device), hostPath],
        spawnOptions: {stdio: "ignore"},
    });
    const {exitCode, signal} = await child.wait();
    if (exitCode === 0) return;
    if (exitCode !== null && exitCode > 0 && exitCode < 256) {
        throw new FuseErrnoError(-exitCode, `mknod failed with errno ${exitCode}`);
    }
    throw new Error(`mknod helper terminated by ${signal ?? "an unknown error"}`);
}
