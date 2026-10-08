import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolveNativeExecutable} from "../src/runtime/NativeExecutable.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const names = ["pi-fuse-native", "pi-exec-clean-native", "pi-network-queue-native", "pi-tcp-gateway-native"] as const;

function withImplementation(implementation: string | undefined, run: () => void): void {
    const previous = process.env.PILOT_NATIVE_IMPLEMENTATION;
    if (implementation === undefined) delete process.env.PILOT_NATIVE_IMPLEMENTATION;
    else process.env.PILOT_NATIVE_IMPLEMENTATION = implementation;
    try { run(); }
    finally {
        if (previous === undefined) delete process.env.PILOT_NATIVE_IMPLEMENTATION;
        else process.env.PILOT_NATIVE_IMPLEMENTATION = previous;
    }
}

test("native executable resolution defaults to receipt-verified Rust for all four helpers", () => {
    withImplementation(undefined, () => {
        for (const name of names) assert.equal(resolveNativeExecutable(name), path.join(root, "build", name));
    });
});

test("obsolete implementation overrides cannot select old C helpers", () => {
    for (const implementation of ["c", "", "other", "../outside"]) withImplementation(implementation, () => {
        for (const name of names) assert.equal(resolveNativeExecutable(name), path.join(root, "build", name));
    });
});

function withPackage(run: (directory: string, receipt: {version: number; implementation: string; helpers: Record<string, string>}) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-native-resolver-"));
    const packageRoot = path.join(directory, "package");
    mkdirSync(path.join(packageRoot, "src/runtime"), {recursive: true});
    mkdirSync(path.join(packageRoot, "build"), {recursive: true});
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({type: "module"}));
    copyFileSync(path.join(root, "src/runtime/NativeExecutable.ts"), path.join(packageRoot, "src/runtime/NativeExecutable.ts"));
    const helpers: Record<string, string> = {};
    for (const name of names) {
        const bytes = Buffer.from(`verified build fixture: ${name}`);
        writeFileSync(path.join(packageRoot, "build", name), bytes, {mode: 0o755});
        helpers[name] = createHash("sha256").update(bytes).digest("hex");
    }
    const receipt = {version: 1, implementation: "rust", helpers};
    writeFileSync(path.join(packageRoot, "build/native-rust.json"), JSON.stringify(receipt));
    try { run(packageRoot, receipt); }
    finally { rmSync(directory, {recursive: true, force: true}); }
}

function resolvePackage(packageRoot: string) {
    const environment = {...process.env};
    return spawnSync(process.execPath, ["--import", "jiti/register", "--input-type=module", "--eval", `
const loaded = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "src/runtime/NativeExecutable.ts")).href)});
const {resolveNativeExecutable} = loaded.default ?? loaded;
console.log(JSON.stringify(${JSON.stringify(names)}.map(resolveNativeExecutable)));
`], {cwd: root, env: environment, encoding: "utf8", timeout: 10_000});
}

test("installed package resolves its own verified helpers, not another checkout", () => {
    withPackage((directory) => {
        const result = resolvePackage(directory);
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), names.map((name) => path.join(directory, "build", name)));
    });
});

test("missing package helpers never select executable lookalikes from the parent directory", () => {
    withPackage((directory, receipt) => {
        const parentBuild = path.join(path.dirname(directory), "build");
        mkdirSync(parentBuild, {recursive: true});
        for (const name of names) {
            copyFileSync(path.join(directory, "build", name), path.join(parentBuild, name));
            rmSync(path.join(directory, "build", name));
        }
        writeFileSync(path.join(parentBuild, "native-rust.json"), JSON.stringify(receipt));
        const missingRust = resolvePackage(directory);
        assert.ifError(missingRust.error);
        assert.notEqual(missingRust.status, 0);
        assert.match(missingRust.stderr, /npm run build:native/);
    });
});

test("successful resolution is not cached across an in-process executable replacement", () => {
    withPackage((directory) => {
        const environment = {...process.env};
        delete environment.PILOT_NATIVE_IMPLEMENTATION;
        const moduleURL = pathToFileURL(path.join(directory, "src/runtime/NativeExecutable.ts")).href;
        const result = spawnSync(process.execPath, ["--import", "jiti/register", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const loaded = await import(${JSON.stringify(moduleURL)});
const {resolveNativeExecutable} = loaded.default ?? loaded;
const executable = resolveNativeExecutable('pi-fuse-native');
writeFileSync(executable, 'replaced with an unverified legacy executable');
assert.throws(() => resolveNativeExecutable('pi-fuse-native'), /npm run build:native/);
console.log('replacement rejected');
`], {cwd: root, env: environment, encoding: "utf8", timeout: 10_000});
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "replacement rejected\n");
    });
});

for (const receipt of [undefined, "not JSON", "null", "[]", '{"version":2,"implementation":"rust","helpers":{}}', '{"version":1,"implementation":"c","helpers":{}}', '{"version":1,"implementation":"rust","helpers":{}}']) {
    test(`stale primary binaries fail closed with missing or invalid Rust receipt ${receipt ?? "(absent)"}`, () => {
        withPackage((directory) => {
            if (receipt === undefined) rmSync(path.join(directory, "build/native-rust.json"));
            else writeFileSync(path.join(directory, "build/native-rust.json"), receipt);
            const result = resolvePackage(directory);
            assert.ifError(result.error);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Rust native helper.*npm run build:native/);
        });
    });
}

for (const name of names) {
    test(`changed ${name} is rejected instead of launching an unverified executable`, () => {
        withPackage((directory) => {
            writeFileSync(path.join(directory, "build", name), "stale legacy C binary");
            const result = resolvePackage(directory);
            assert.ifError(result.error);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, new RegExp(`Rust native helper ${name}.*npm run build:native`));
        });
    });
}
