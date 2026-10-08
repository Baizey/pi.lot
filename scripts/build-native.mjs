import {copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {fuseFlags, netfilterQueueFlags} from "./native-build-flags.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = path.resolve(root, process.env.PILOT_NATIVE_BUILD_DIRECTORY ?? "build");
const targetDirectory = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "native/rust/target");
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => !["--reference", "--all"].includes(argument)) || arguments_.length > 1) {
    throw new Error("Usage: node scripts/build-native.mjs [--reference | --all]");
}

// Resolve every SDK before replacing any helper. A failed preflight must leave
// a running installation intact, including during the C-to-Rust migration.
const fuseCompilerFlags = fuseFlags();
const netfilterCompilerFlags = netfilterQueueFlags();
mkdirSync(outputDirectory, {recursive: true});
if (arguments_[0] !== "--reference") buildRust();
if (arguments_[0] === "--reference" || arguments_[0] === "--all") buildReference();

function buildRust() {
    const sdkDirectory = path.join(outputDirectory, "native-sdk");
    mkdirSync(sdkDirectory, {recursive: true});
    for (const [name, flags] of [["fuse3", fuseCompilerFlags], ["libnetfilter_queue", netfilterCompilerFlags]]) {
        writeFileSync(path.join(sdkDirectory, `${name}.flags`), flags.join("\0") + "\0");
    }
    execute("cargo", ["build", "--locked", "--release", "--manifest-path", path.join(root, "native/rust/Cargo.toml")], {
        ...process.env,
        CARGO_TARGET_DIR: targetDirectory,
        PILOT_NATIVE_SDK_FLAGS: sdkDirectory,
    });
    publishRustArtifacts(["pi-exec-clean-native", "pi-fuse-native", "pi-network-queue-native", "pi-tcp-gateway-native",
        "pi-network-queue-probe", "pi-tcp-gateway-probe", "libpilot_native.a"]);
}

function buildReference() {
    const directory = path.join(outputDirectory, "native-c");
    mkdirSync(directory, {recursive: true});
    compileNative("native/pi-exec-clean.c", "pi-exec-clean-native", directory);
    compileNative("native/pi-fuse.c", "pi-fuse-native", directory, fuseCompilerFlags);
    compileNative("native/pi-network-queue.c", "pi-network-queue-native", directory, netfilterCompilerFlags);
    compileNative("native/pi-tcp-gateway.c", "pi-tcp-gateway-native", directory);
    compileNative("test/fixtures/native-network-queue-probe.c", "pi-network-queue-probe", directory, netfilterCompilerFlags);
    compileNative("test/fixtures/native-tcp-gateway-probe.c", "pi-tcp-gateway-probe", directory);
}

function compileNative(sourceName, outputName, directory, extraFlags = []) {
    const output = path.join(directory, outputName);
    const temporary = `${output}.tmp-${process.pid}`;
    try {
        execute("cc", ["-std=c17", "-O2", "-g", "-Wall", "-Wextra", "-Wpedantic", "-o", temporary,
            path.join(root, sourceName), ...extraFlags]);
        renameSync(temporary, output);
    } finally {
        rmSync(temporary, {force: true});
    }
}

function publishRustArtifacts(names) {
    const artifacts = names.map((name) => ({
        source: path.join(targetDirectory, "release", name),
        output: path.join(outputDirectory, name),
        temporary: path.join(outputDirectory, `${name}.tmp-${process.pid}`),
    }));
    try {
        // Stage every artifact before replacing any running helper. Missing
        // output or a failed copy must not install a partial build.
        for (const artifact of artifacts) copyFileSync(artifact.source, artifact.temporary);
        for (const artifact of artifacts) renameSync(artifact.temporary, artifact.output);
    } finally {
        for (const artifact of artifacts) rmSync(artifact.temporary, {force: true});
    }
}

function execute(command, arguments_, env = process.env) {
    const result = spawnSync(command, arguments_, {cwd: root, env, stdio: "inherit"});
    if (result.error) {
        if (command === "cargo") throw new Error("Cargo is required to build Pilot's Rust helpers. Install Rust >= 1.85 and Cargo.", {cause: result.error});
        throw result.error;
    }
    if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}
