import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

export function resolveNativeExecutable(name: string): string {
    // Explicit selection supports running the identical integration contracts
    // against the retained C reference. There is no automatic C fallback.
    const implementation = process.env.PILOT_NATIVE_IMPLEMENTATION ?? "rust";
    if (implementation !== "rust" && implementation !== "c") {
        throw new Error(`Invalid PILOT_NATIVE_IMPLEMENTATION: ${implementation}`);
    }
    const directory = implementation === "c" ? "build/native-c" : "build";
    const candidates = [
        fileURLToPath(new URL(`../../${directory}/${name}`, import.meta.url)),
        fileURLToPath(new URL(`../../../${directory}/${name}`, import.meta.url)),
    ];
    return candidates.find(existsSync) ?? candidates[0]!;
}
