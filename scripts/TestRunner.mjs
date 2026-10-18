import {spawnSync} from "node:child_process";
import {existsSync, readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nativeContracts = [
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
const hostContracts = [
    "test/native-fuse.test.ts",
    "test/native-fuse-session-broker.test.ts",
    "test/bash-sandbox.test.ts",
    "test/network.test.ts",
];

export class TestRunner {
    #run;
    #testFiles;
    #hasFuse;
    #log;

    constructor({
        run = runCommand,
        testFiles = () => readdirSync(new URL("../test", import.meta.url)),
        hasFuse = () => existsSync("/dev/fuse"),
        log = console.log,
    } = {}) {
        this.#run = run;
        this.#testFiles = testFiles;
        this.#hasFuse = hasFuse;
        this.#log = log;
    }

    all() {
        this.#run("npm", ["run", "build"]);
        const executed = this.native({build: false});
        this.runtime(executed);
    }

    native({host = false, build = true} = {}) {
        if (host && !this.#hasFuse()) {
            throw new Error("Local filesystem/network integration needs /dev/fuse. Run from your normal Linux terminal outside pi.lot's Bash sandbox. No mounted tests were run.");
        }
        if (build) this.#run(process.execPath, ["scripts/build-native.mjs"]);
        this.#run("cargo", ["test", "--locked", "--manifest-path", "native/rust/Cargo.toml"]);
        this.#log(`\n=== Native Pi extension contracts${host ? " (local filesystem/network integration)" : " (mount-free)"} ===`);
        const tests = host ? [...nativeContracts, ...hostContracts] : [...nativeContracts];
        this.#nodeTests(tests);
        this.#log(host
            ? "\nNative Pi extension integration passed, including mounted filesystem and network contracts."
            : "\nMount-free native contracts passed. npm run test:native:host additionally tests real FUSE/network behavior from your normal Linux terminal.");
        return tests;
    }

    runtime(executed = []) {
        const omitted = new Set(executed);
        const tests = this.#testFiles()
            .filter((name) => /\.test\.(ts|mjs)$/.test(name))
            .sort().map((name) => `test/${name}`)
            .filter((file) => !omitted.has(file));
        this.#nodeTests(tests);
    }

    #nodeTests(tests) {
        this.#run(process.execPath, ["--import", "jiti/register", "--test", ...tests]);
    }
}

function runCommand(command, arguments_) {
    const result = spawnSync(command, arguments_, {cwd: root, env: process.env, stdio: "inherit"});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
