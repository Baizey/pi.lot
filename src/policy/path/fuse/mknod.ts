import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {FuseErrnoError} from "./fuse-errors.js";

const MKNOD_HELPER = fileURLToPath(new URL("../../../../build/pi-mknod-native", import.meta.url));

export async function mknod(hostPath: string, mode: number, device: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(MKNOD_HELPER, [String(mode), String(device), hostPath], {
            stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
            if (exitCode === 0) {
                resolve();
                return;
            }
            if (exitCode !== null && exitCode > 0 && exitCode < 256) {
                reject(new FuseErrnoError(-exitCode, `mknod failed with errno ${exitCode}`));
                return;
            }
            reject(new Error(`mknod helper terminated by ${signal ?? "an unknown error"}`));
        });
    });
}
