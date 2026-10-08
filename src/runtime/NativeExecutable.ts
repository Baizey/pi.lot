import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

export type NativeExecutableName =
    | "pi-exec-clean-native"
    | "pi-fuse-native"
    | "pi-network-queue-native"
    | "pi-tcp-gateway-native";

export function resolveNativeExecutable(name: NativeExecutableName): string {
    // Native helpers belong to this Pi extension. Never search another checkout
    // or launch an unverified executable left over from an earlier build.
    const directory = new URL("../../build/", import.meta.url);
    const executable = fileURLToPath(new URL(name, directory));
    try {
        const receipt: unknown = JSON.parse(readFileSync(new URL("native-rust.json", directory), "utf8"));
        if (!isRecord(receipt) || receipt.version !== 1 || receipt.implementation !== "rust" || !isRecord(receipt.helpers)) {
            throw new Error("Missing or invalid Rust build receipt");
        }
        const expected = receipt.helpers[name];
        if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
            throw new Error(`Rust build receipt does not identify ${name}`);
        }
        const actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
        if (actual !== expected) throw new Error(`${name} does not match its Rust build receipt`);
    } catch (cause) {
        throw new Error(`Rust native helper ${name} is missing or outdated. Run npm run build:native and restart Pi.`, {cause});
    }
    return executable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
