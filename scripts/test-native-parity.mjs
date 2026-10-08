import {existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => !["--host", "--no-build"].includes(argument))) {
    throw new Error("Usage: node scripts/test-native-parity.mjs [--host] [--no-build]");
}
const host = arguments_.includes("--host");
if (host && !existsSync("/dev/fuse")) {
    throw new Error("Host parity requires /dev/fuse and a prepared, unsandboxed Linux host. No mounted tests were run.");
}
if (!arguments_.includes("--no-build")) run(process.execPath, ["scripts/build-native.mjs", "--all"]);
run("cargo", ["test", "--locked", "--manifest-path", "native/rust/Cargo.toml"]);

// These are the same contracts, not two implementations of the tests. Each
// process selects its helper and production callback probe explicitly.
const shared = [
    "test/native-fuse-callbacks.test.ts",
    "test/native-fuse-contract.test.ts",
    "test/native-fuse-protocol.test.ts",
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
];
if (host) shared.push(
    "test/native-fuse.test.ts",
    "test/native-fuse-session-broker.test.ts",
    "test/bash-sandbox.test.ts",
    "test/network.test.ts",
);
for (const implementation of ["c", "rust"]) {
    console.log(`\n=== Native contract suite: ${implementation}${host ? " (prepared host)" : " (mount-free)"} ===`);
    run(process.execPath, ["--import", "jiti/register", "--test", ...shared], {
        ...process.env, PILOT_NATIVE_IMPLEMENTATION: implementation,
    });
}
console.log("\n=== Direct C/Rust differential and expected-behavior tests ===");
run(process.execPath, ["--import", "jiti/register", "--test",
    "test/native-fuse-parity.test.ts", "test/native-fuse-broker-parity.test.ts", "test/native-network-queue-parity.test.ts",
    "test/native-process-parity.test.ts", "test/native-build-flags.test.ts",
    "test/native-executable.test.ts",
]);
if (!host) console.log("\nMount-free parity passed. Mounted filesystem/network parity has NOT been verified; run npm run test:native:host on a prepared host.");

function run(command, arguments_, env = process.env) {
    const result = spawnSync(command, arguments_, {cwd: root, env, stdio: "inherit"});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
