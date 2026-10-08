import {copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {fuseFlags, netfilterQueueFlags} from "./native-build-flags.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = path.resolve(root, process.env.PILOT_NATIVE_BUILD_DIRECTORY ?? "build");
const targetDirectory = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "native/rust/target");
const rustHelpers = ["pi-exec-clean-native", "pi-fuse-native", "pi-network-queue-native", "pi-tcp-gateway-native"];
if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/build-native.mjs");
}

// Resolve every SDK before replacing any helper. A failed preflight must leave
// the extension's existing helpers intact.
const fuseCompilerFlags = fuseFlags();
const netfilterCompilerFlags = netfilterQueueFlags();
mkdirSync(outputDirectory, {recursive: true});
buildRust();

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
    publishRustArtifacts([...rustHelpers, "pi-network-queue-probe", "pi-tcp-gateway-probe", "libpilot_native.a"]);
}

function publishRustArtifacts(names) {
    const artifacts = names.map((name) => ({
        source: path.join(targetDirectory, "release", name),
        output: path.join(outputDirectory, name),
        temporary: path.join(outputDirectory, `${name}.tmp-${process.pid}`),
    }));
    const receipt = path.join(outputDirectory, "native-rust.json");
    const stagedReceipt = `${receipt}.tmp-${process.pid}`;
    try {
        // Stage every artifact and its build receipt before publishing any.
        // Publishing the receipt last makes stale or partially replaced primary
        // helpers fail runtime validation rather than silently run old C code.
        for (const artifact of artifacts) copyFileSync(artifact.source, artifact.temporary);
        const helpers = Object.fromEntries(artifacts.filter((artifact) => rustHelpers.includes(path.basename(artifact.output)))
            .map((artifact) => [path.basename(artifact.output), createHash("sha256").update(readFileSync(artifact.temporary)).digest("hex")]));
        writeFileSync(stagedReceipt, JSON.stringify({version: 1, implementation: "rust", helpers}) + "\n");
        for (const artifact of artifacts) renameSync(artifact.temporary, artifact.output);
        renameSync(stagedReceipt, receipt);
    } finally {
        for (const artifact of artifacts) rmSync(artifact.temporary, {force: true});
        rmSync(stagedReceipt, {force: true});
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
