import {existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => !["--host", "--no-build"].includes(argument))) {
    throw new Error("Usage: node scripts/test-native.mjs [--host] [--no-build]");
}
const host = arguments_.includes("--host");
if (host && !existsSync("/dev/fuse")) {
    throw new Error("Local filesystem/network integration needs /dev/fuse. Run from your normal Linux terminal outside pi.lot's Bash sandbox. No mounted tests were run.");
}
if (!arguments_.includes("--no-build")) run(process.execPath, ["scripts/build-native.mjs"]);
run("cargo", ["test", "--locked", "--manifest-path", "native/rust/Cargo.toml"]);
console.log(`\n=== Native Pi extension contracts${host ? " (local filesystem/network integration)" : " (mount-free)"} ===`);
const tests = [
    "test/native-fuse-callbacks.test.ts",
    "test/native-fuse-contract.test.ts",
    "test/native-fuse-protocol.test.ts",
    "test/native-fuse-broker-integration.test.ts",
    "test/native-filesystem-policy-view.test.ts",
    "test/builtin-path-authorization.test.ts",
    "test/path-policy.test.ts",
    "test/path-validation.test.ts",
    "test/network-policy-authorizer.test.ts",
    "test/network-policy-logic.test.ts",
    "test/network-policy.test.ts",
    "test/network-sandbox-lifecycle.test.ts",
    "test/host-credential-ipc-config.test.ts",
    "test/client-trust.test.ts",
    "test/managed-child-process.test.ts",
    "test/native-fuse-snapshot.test.ts",
    "test/native-fuse-broker.test.ts",
    "test/native-network-queue.test.ts",
    "test/native-process.test.ts",
    "test/native-build-flags.test.ts",
    "test/native-executable.test.ts",
    "test/native-rust-integration.test.ts",
];
if (host) tests.push(
    "test/native-fuse.test.ts",
    "test/native-fuse-session-broker.test.ts",
    "test/bash-sandbox.test.ts",
    "test/network.test.ts",
);
run(process.execPath, ["--import", "jiti/register", "--test", ...tests]);
console.log(host
    ? "\nNative Pi extension integration passed, including mounted filesystem and network contracts."
    : "\nMount-free native contracts passed. npm run test:native:host additionally tests real FUSE/network behavior from your normal Linux terminal.");

function run(command, arguments_) {
    const result = spawnSync(command, arguments_, {cwd: root, env: process.env, stdio: "inherit"});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
