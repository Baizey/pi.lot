import {mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {fuseFlags, netfilterQueueFlags} from "./native-build-flags.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../build", import.meta.url));

// Resolve SDKs before replacing any helper; a missing SDK must leave the running installation intact.
const fuseCompilerFlags = fuseFlags();
const netfilterCompilerFlags = netfilterQueueFlags();
mkdirSync(outputDirectory, {recursive: true});
compileNative("pi-exec-clean.c", "pi-exec-clean-native");
compileNative("pi-fuse.c", "pi-fuse-native", fuseCompilerFlags);
compileNative("pi-network-queue.c", "pi-network-queue-native", netfilterCompilerFlags);
compileNative("pi-tcp-gateway.c", "pi-tcp-gateway-native");

function compileNative(sourceName, outputName, extraFlags = []) {
    const source = fileURLToPath(new URL(`../native/${sourceName}`, import.meta.url));
    const output = fileURLToPath(new URL(`../build/${outputName}`, import.meta.url));
    const result = spawnSync("cc", [
        "-std=c17",
        "-O2",
        "-g",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-o",
        output,
        source,
        ...extraFlags,
    ], {cwd: root, stdio: "inherit"});

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
