import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

export function resolveNativeExecutable(name: string): string {
    const candidates = [
        fileURLToPath(new URL(`../../build/${name}`, import.meta.url)),
        fileURLToPath(new URL(`../../../build/${name}`, import.meta.url)),
    ];
    return candidates.find(existsSync) ?? candidates[0]!;
}
