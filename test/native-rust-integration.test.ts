import assert from "node:assert/strict";
import {spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns} from "node:child_process";
import {createHash} from "node:crypto";
import {
    closeSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath, pathToFileURL} from "node:url";
import {encodeNativeFilesystemPolicySnapshot} from "../src/policy/path/native/NativeFilesystemPolicyProtocol.js";
import type {NativeFilesystemPolicySnapshot} from "../src/policy/path/native/NativeFilesystemPolicyView.js";
import {PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse} from "../src/policy/types.js";

const originalRoot = fileURLToPath(new URL("..", import.meta.url));
const productionNames = [
    "pi-exec-clean-native",
    "pi-fuse-native",
    "pi-network-queue-native",
    "pi-tcp-gateway-native",
] as const;
const oldSources = ["pi-exec-clean.c", "pi-fuse.c", "pi-network-queue.c", "pi-tcp-gateway.c", "pi-fuse-shim.c"];

// This exercises npm's actual install hook, not npm dependency installation.
// Cargo dependencies must already be cached by the initial native build; neither
// package dependencies nor native build artifacts are copied into the fixture.
test("fresh source package installs Rust helpers and preserves them on a failed npm build", {timeout: 200_000}, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-rust-install-"));
    const packageRoot = path.join(directory, "package");
    const targetDirectory = path.join(directory, "cargo-target");
    const cacheDirectory = path.join(directory, "npm-cache");
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        CARGO_TARGET_DIR: targetDirectory,
        CARGO_NET_OFFLINE: "true",
        npm_config_cache: cacheDirectory,
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        LC_ALL: "C",
    };
    delete environment.PILOT_NATIVE_BUILD_DIRECTORY;
    delete environment.PILOT_NATIVE_SDK_FLAGS;
    try {
        copyFreshPackage(packageRoot);
        mkdirSync(cacheDirectory);
        assert.equal(existsSync(targetDirectory), false, "Cargo must start with a fresh target directory");
        assertFreshSourceOnly(packageRoot);

        const installed = execute("npm", ["run", "install"], packageRoot, environment, {timeout: 120_000});
        assert.equal(installed.status, 0, installed.stdout + installed.stderr);
        assert.equal(existsSync(path.join(packageRoot, "node_modules")), false);
        assert.equal(existsSync(path.join(packageRoot, "package-lock.json")), false);
        assert.equal(existsSync(path.join(packageRoot, "build/native-c")), false);
        for (const name of oldSources) assert.equal(existsSync(path.join(packageRoot, "native", name)), false);

        await t.test("the four installed executables are executable ELF files identical to fresh Cargo release outputs", () => {
            for (const name of productionNames) {
                const filename = path.join(packageRoot, "build", name);
                const source = path.join(targetDirectory, "release", name);
                const metadata = statSync(filename);
                const bytes = readFileSync(filename);
                assert.ok(metadata.isFile(), name);
                assert.equal(metadata.mode & 0o111, 0o111, `${name}: executable permissions`);
                assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), `${name}: ELF header`);
                assert.deepEqual(bytes, readFileSync(source), `${name}: installed bytes must come from this Cargo build`);
                assert.equal(sha256(bytes), sha256(readFileSync(source)), `${name}: SHA-256`);
            }
        });

        await t.test("the build receipt identifies exactly the four Rust helpers", () => {
            const receipt: unknown = JSON.parse(readFileSync(path.join(packageRoot, "build/native-rust.json"), "utf8"));
            assert.deepEqual(receipt, rustReceipt(packageRoot));
        });

        await t.test("the copied production resolver anchors all four helpers to its own installed package", () => {
            // Resolve jiti in the original repository, but import the *copied* module.
            // Running from the original root catches accidental cwd-based resolution.
            const moduleURL = pathToFileURL(path.join(packageRoot, "src/runtime/NativeExecutable.ts")).href;
            const script = `
                const loaded = await import(${JSON.stringify(moduleURL)});
                const {resolveNativeExecutable} = loaded.default ?? loaded;
                process.stdout.write(JSON.stringify(${JSON.stringify(productionNames)}.map(resolveNativeExecutable)));
            `;
            const result = execute(process.execPath, ["--import", "jiti/register", "--input-type=module", "--eval", script], originalRoot, environment);
            assert.equal(result.status, 0, result.stderr);
            const resolved: unknown = JSON.parse(result.stdout);
            assert.deepEqual(resolved, productionNames.map((name) => path.join(packageRoot, "build", name)));
        });

        await t.test("installed exec, FUSE protocol, gateway CLI and packet parser run without privileged host integration", () => {
            const executable = (name: string) => path.join(packageRoot, "build", name);
            const literal = "fresh Rust: $HOME $(not-a-shell) 'quoted' 🦀\n";
            const exec = execute(executable("pi-exec-clean-native"), ["2", process.execPath, "--input-type=module", "--eval",
                `process.stdout.write(${JSON.stringify(literal)}); process.exit(23);`], packageRoot, environment);
            assert.equal(exec.status, 23, exec.stderr);
            assert.equal(exec.stdout, literal);
            assert.equal(exec.stderr, "");

            checkFuseProtocol(executable("pi-fuse-native"), directory, packageRoot, environment);

            const gateway = execute(executable("pi-tcp-gateway-native"), [], packageRoot, environment);
            assert.equal(gateway.status, 1);
            assert.equal(gateway.stdout, "");
            assert.equal(gateway.stderr, "usage: pi-tcp-gateway BROKER_IPV4 BROKER_PORT\n");

            // Only the mount-free parser probe runs here. Never invoke the
            // production pi-network-queue-native (it opens a privileged NFQUEUE).
            const packet = "4500001c0000000000110000c0000201c633640204d201bb00080000";
            const parser = execute(executable("pi-network-queue-probe"), [], packageRoot, environment, {
                input: `P \nP ${packet}\n`,
            });
            assert.equal(parser.status, 0, parser.stderr);
            assert.equal(parser.stderr, "");
            assert.equal(parser.stdout, "DROP\nPI_NETWORK_QUEUE\t3\tEVENT\t1\tIPV4\tudp\t192.0.2.1\t1234\t198.51.100.2\t443\n");
        });

        await t.test("actual npm build fails before typecheck and leaves all installed artifacts and receipt intact", () => {
            // Seed a valid receipt even when testing a pre-receipt builder, so the
            // clean-before-Cargo regression can be demonstrated independently.
            writeFileSync(path.join(packageRoot, "build/native-rust.json"), JSON.stringify(rustReceipt(packageRoot)) + "\n");
            const buildDirectory = path.join(packageRoot, "build");
            const retained = readdirSync(buildDirectory).filter((name) => statSync(path.join(buildDirectory, name)).isFile())
                .map((name) => ({name, bytes: readFileSync(path.join(buildDirectory, name)), mode: statSync(path.join(buildDirectory, name)).mode}));
            assert.ok(productionNames.every((name) => retained.some((artifact) => artifact.name === name)));
            const tools = path.join(directory, "failing-tools");
            mkdirSync(tools);
            writeFileSync(path.join(tools, "cargo"), "#!/bin/sh\nprintf 'cargo invoked\\n' > \"$PILOT_TEST_CARGO_MARKER\"\nprintf 'intentional Cargo failure\\n' >&2\nexit 73\n", {mode: 0o755});
            writeFileSync(path.join(tools, "tsc"), "#!/bin/sh\nprintf 'typecheck invoked\\n' > \"$PILOT_TEST_TYPECHECK_MARKER\"\nexit 0\n", {mode: 0o755});
            const cargoMarker = path.join(directory, "cargo-invoked");
            const typecheckMarker = path.join(directory, "typecheck-invoked");
            const failed = execute("npm", ["run", "build"], packageRoot, {
                ...environment,
                PATH: tools + path.delimiter + (environment.PATH ?? ""),
                PILOT_TEST_CARGO_MARKER: cargoMarker,
                PILOT_TEST_TYPECHECK_MARKER: typecheckMarker,
            }, {timeout: 30_000});
            assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
            assert.equal(readFileSync(cargoMarker, "utf8"), "cargo invoked\n", "the failure must come from Cargo, not a missing SDK");
            assert.match(failed.stderr, /intentional Cargo failure/);
            assert.equal(existsSync(typecheckMarker), false, "typecheck must not run after Cargo fails");
            assert.doesNotMatch(failed.stdout, /> (?:pilot@[^\n]+ )?typecheck\b|tsc --noEmit/);
            const missing = retained.filter((artifact) => !existsSync(path.join(buildDirectory, artifact.name))).map((artifact) => artifact.name);
            assert.deepEqual(missing, [], "npm build must not clean installed artifacts before Cargo succeeds");
            for (const artifact of retained) {
                const filename = path.join(buildDirectory, artifact.name);
                assert.deepEqual(readFileSync(filename), artifact.bytes, `${artifact.name}: preserve installed bytes`);
                assert.equal(statSync(filename).mode, artifact.mode, `${artifact.name}: preserve installed permissions`);
            }
            assert.equal(existsSync(path.join(buildDirectory, "native-c")), false);
        });

        await t.test("npm pack exports Rust build inputs but no build outputs or Cargo targets", () => {
            // Dry-run the actual package outside the deliberately minimal copy.
            const packed = execute("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], originalRoot, environment, {timeout: 30_000});
            assert.equal(packed.status, 0, packed.stderr);
            const paths = packedPaths(packed.stdout);
            const required = ["package.json", "native/rust/Cargo.toml", "native/rust/Cargo.lock", "native/rust/build.rs",
                "src/runtime/NativeExecutable.ts", "scripts/build-native.mjs", "scripts/native-build-flags.mjs",
                ...sourceFiles(path.join(originalRoot, "native/rust/src"), "native/rust/src")];
            for (const filename of required) assert.ok(paths.includes(filename), `Missing package input: ${filename}`);
            for (const name of oldSources) assert.equal(paths.includes(`native/${name}`), false, `Retired C source: ${name}`);
            for (const filename of paths) assert.doesNotMatch(filename, /^(?:build|dist|node_modules)\/|(?:^|\/)target\//, filename);
        });
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

function copyFreshPackage(packageRoot: string): void {
    mkdirSync(path.join(packageRoot, "native"), {recursive: true});
    cpSync(path.join(originalRoot, "native/rust"), path.join(packageRoot, "native/rust"), {
        recursive: true,
        filter: (filename) => path.basename(filename) !== "target",
    });
    cpSync(path.join(originalRoot, "scripts"), path.join(packageRoot, "scripts"), {recursive: true});
    mkdirSync(path.join(packageRoot, "src/runtime"), {recursive: true});
    copyFileSync(path.join(originalRoot, "src/runtime/NativeExecutable.ts"), path.join(packageRoot, "src/runtime/NativeExecutable.ts"));
    copyFileSync(path.join(originalRoot, "package.json"), path.join(packageRoot, "package.json"));
}

function assertFreshSourceOnly(packageRoot: string): void {
    assert.deepEqual(readdirSync(packageRoot).sort(), ["native", "package.json", "scripts", "src"]);
    assert.deepEqual(readdirSync(path.join(packageRoot, "native")).sort(), ["rust"]);
    assert.equal(existsSync(path.join(packageRoot, "native/rust/target")), false);
    assert.deepEqual(readFileSync(path.join(packageRoot, "package.json")), readFileSync(path.join(originalRoot, "package.json")));
}

function execute(
    command: string,
    arguments_: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: Pick<SpawnSyncOptionsWithStringEncoding, "input" | "stdio" | "timeout"> = {},
): SpawnSyncReturns<string> {
    const result = spawnSync(command, arguments_, {cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, ...options});
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${command}: ${result.stdout}${result.stderr}`);
    return result;
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function rustReceipt(packageRoot: string): {version: number; implementation: string; helpers: Record<string, string>} {
    return {
        version: 1,
        implementation: "rust",
        helpers: Object.fromEntries(productionNames.map((name) => [name, sha256(readFileSync(path.join(packageRoot, "build", name)))])),
    };
}

function checkFuseProtocol(binary: string, directory: string, cwd: string, env: NodeJS.ProcessEnv): void {
    const snapshot: NativeFilesystemPolicySnapshot = {
        revision: 7,
        layers: [{
            resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
            policies: [
                {pattern: "/", info: {[PolicyAccessType.FS_READ]: {
                    accessType: PolicyAccessType.FS_READ, lifetime: PolicyLifetime.SESSION,
                    status: PolicyResponse.ALLOWED, reason: "fresh-install protocol fixture",
                }}},
                {pattern: "/denied", info: {[PolicyAccessType.FS_READ]: {
                    accessType: PolicyAccessType.FS_READ, lifetime: PolicyLifetime.SESSION,
                    status: PolicyResponse.DENIED, reason: "fresh-install denial fixture",
                }}},
            ],
        }],
    };
    const filename = path.join(directory, "policy.snapshot");
    writeFileSync(filename, encodeNativeFilesystemPolicySnapshot(snapshot));
    const controller = openSync("/dev/null", "r+");
    try {
        for (const [target, decision, status] of [["/allowed/child", "allow", 0], ["/denied/child", "deny", 2]] as const) {
            const result = execute(binary, ["--check-policy-protocol", filename, "3", "4", target], cwd, env, {
                stdio: ["ignore", "pipe", "pipe", controller, controller],
            });
            assert.equal(result.status, status, result.stderr);
            assert.equal(result.stderr, "");
            assert.equal(result.stdout, `{"baseRevision":7,"onceRevision":0,"decision":"${decision}"}\n`);
        }
    } finally {
        closeSync(controller);
    }
}

function packedPaths(output: string): string[] {
    const parsed: unknown = JSON.parse(output);
    assert.ok(parsed !== null && typeof parsed === "object");
    // Recent npm releases report packages keyed by name; others use an array.
    const packages: unknown[] = Array.isArray(parsed) ? parsed : Object.values(parsed);
    assert.equal(packages.length, 1);
    const manifest = packages[0];
    assert.ok(manifest !== null && typeof manifest === "object" && "files" in manifest && Array.isArray(manifest.files));
    return manifest.files.map((candidate: unknown) => {
        assert.ok(candidate !== null && typeof candidate === "object" && "path" in candidate && typeof candidate.path === "string");
        return candidate.path;
    });
}

function sourceFiles(directory: string, prefix: string): string[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const filename = `${prefix}/${entry.name}`;
        return entry.isDirectory() ? sourceFiles(path.join(directory, entry.name), filename) : [filename];
    });
}
