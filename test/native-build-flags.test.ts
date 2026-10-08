import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {minimumFuseVersion, parsePkgConfigFlags} from "../scripts/native-build-flags.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const resolver = new URL("../scripts/native-build-flags.mjs", import.meta.url).href;

function withBuildTools(run: (directory: string, environment: NodeJS.ProcessEnv) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-build-flags-"));
    writeFileSync(path.join(directory, "pkg-config"), `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.SDK_MODE === "missing") { console.error("Package fuse3 was not found"); process.exit(1); }
if (args[0] === "--modversion") { console.log(process.env.SDK_MODE === "old" ? "3.16.2" : process.env.SDK_MODE === "unexported" ? "3.17.2" : "3.18.2"); }
else if (args[0] === "--atleast-version=${minimumFuseVersion}") { process.exit(["old", "unexported"].includes(process.env.SDK_MODE) ? 1 : 0); }
else if (args.join(" ") === "--cflags --libs fuse3") { process.stdout.write(process.env.FUSE_FLAGS); }
else if (args.join(" ") === "--cflags --libs libnetfilter_queue") {
    if (process.env.SDK_MODE === "missing-netfilter") { console.error("Package libnetfilter_queue was not found"); process.exit(1); }
    console.log("-lnetfilter_queue");
}
else { console.error("Unexpected pkg-config invocation: " + args.join(" ")); process.exit(9); }
`, {mode: 0o755});
    writeFileSync(path.join(directory, "cc"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMPILER_MARKER, JSON.stringify(args) + "\\n");
fs.writeFileSync(args[args.indexOf("-o") + 1], "reference binary", {mode: 0o755});
if (process.env.COMPILER_FAIL && args.some(arg => arg.endsWith(process.env.COMPILER_FAIL))) process.exit(32);
`, {mode: 0o755});
    writeFileSync(path.join(directory, "cargo"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const flags = fs.readFileSync(path.join(process.env.PILOT_NATIVE_SDK_FLAGS, "fuse3.flags"), "utf8").split("\\0").filter(Boolean);
fs.appendFileSync(process.env.CARGO_MARKER, JSON.stringify({args: process.argv.slice(2), flags}) + "\\n");
if (process.env.CARGO_FAIL) process.exit(33);
const out = path.join(process.env.CARGO_TARGET_DIR, "release");
fs.mkdirSync(out, {recursive:true});
for (const name of ["pi-exec-clean-native", "pi-fuse-native", "pi-network-queue-native", "pi-tcp-gateway-native", "pi-network-queue-probe", "pi-tcp-gateway-probe", "libpilot_native.a"]) {
    if (process.env.CARGO_OMIT !== name) fs.writeFileSync(path.join(out, name), "rust binary", {mode: 0o755});
}
`, {mode: 0o755});
    try {
        run(directory, {
            ...process.env,
            PATH: directory,
            COMPILER_MARKER: path.join(directory, "compiler.calls"),
            CARGO_MARKER: path.join(directory, "cargo.calls"),
            PILOT_NATIVE_BUILD_DIRECTORY: path.join(directory, "build"),
            CARGO_TARGET_DIR: path.join(directory, "target"),
            FUSE_FLAGS: "-I/sdk/include/fuse3 -lfuse3 -lpthread",
        });
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}

function resolveFlags(environment: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, ["--input-type=module", "--eval", `import {fuseFlags} from ${JSON.stringify(resolver)}; console.log(JSON.stringify(fuseFlags()));`], {
        cwd: root, env: environment, encoding: "utf8",
    });
}

function build(environment: NodeJS.ProcessEnv, args: string[] = []) {
    return spawnSync(process.execPath, [path.join(root, "scripts/build-native.mjs"), ...args], {
        cwd: root, env: environment, encoding: "utf8",
    });
}

test("pkg-config flags preserve quoted/escaped paths and remain literal arguments", () => {
    assert.deepEqual(parsePkgConfigFlags(String.raw` -I/sdk\ directory/include '-L/sdk directory/lib' -lfuse3 -lpthread `), [
        "-I/sdk directory/include", "-L/sdk directory/lib", "-lfuse3", "-lpthread",
    ]);
    assert.deepEqual(parsePkgConfigFlags(String.raw`"-DVALUE=two words" -DOTHER='a\b' -DQUOTE=\"quoted\" '$HOME' '$(touch sentinel)'`), [
        "-DVALUE=two words", "-DOTHER=a\\b", '-DQUOTE="quoted"', "$HOME", "$(touch sentinel)",
    ]);
    assert.deepEqual(parsePkgConfigFlags('"-I/sdk\\directory" "-DVALUE=\\$literal"'), ["-I/sdk\\directory", "-DVALUE=$literal"]);
    assert.deepEqual(parsePkgConfigFlags("\n\t"), []);
    assert.throws(() => parsePkgConfigFlags("'-Iunfinished"), /unterminated quote/);
    assert.throws(() => parsePkgConfigFlags("-Itrailing\\"), /trailing escape/);
});

for (const mode of ["missing", "old", "unexported"] as const) {
    test(`native builder rejects ${mode} FUSE3 SDK before invoking C or Rust compilers`, () => {
        withBuildTools((_directory, environment) => {
            const result = build({...environment, SDK_MODE: mode}, ["--all"]);
            assert.ifError(result.error);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /libfuse >= 3\.17\.3 development files are required/);
            assert.match(result.stderr, /fuse3-devel/);
            assert.match(result.stderr, /rpm-ostree install --apply-live/);
            assert.match(result.stderr, /libfuse3-dev/);
            if (mode === "old") assert.match(result.stderr, /3\.16\.2 is too old/);
            if (mode === "unexported") assert.match(result.stderr, /3\.17\.2 is too old/);
            assert.equal(existsSync(environment.COMPILER_MARKER!), false);
            assert.equal(existsSync(environment.CARGO_MARKER!), false);
        });
    });
}

test("native builder resolves NFQUEUE before invoking C or Rust compilers", () => {
    withBuildTools((_directory, environment) => {
        const result = build({...environment, SDK_MODE: "missing-netfilter"}, ["--all"]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /libnetfilter_queue development files are required/);
        assert.equal(existsSync(environment.COMPILER_MARKER!), false);
        assert.equal(existsSync(environment.CARGO_MARKER!), false);
    });
});

test("missing pkg-config has actionable FUSE3 SDK guidance", () => {
    withBuildTools((directory, environment) => {
        rmSync(path.join(directory, "pkg-config"));
        const result = resolveFlags(environment);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /pkg-config is required to locate fuse3/);
        assert.match(result.stderr, /fuse3-devel/);
    });
});

test("Rust builder locks dependencies, forwards unsplit SDK flags and publishes all helpers", () => {
    withBuildTools((_directory, environment) => {
        const result = build({...environment, FUSE_FLAGS: String.raw`-I/sdk\ directory/include/fuse3 '-L/sdk directory/lib' -lfuse3 -lpthread`});
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const call = JSON.parse(readFileSync(environment.CARGO_MARKER!, "utf8").trim());
        assert.deepEqual(call.args, ["build", "--locked", "--release", "--manifest-path", path.join(root, "native/rust/Cargo.toml")]);
        assert.deepEqual(call.flags, ["-I/sdk directory/include/fuse3", "-L/sdk directory/lib", "-lfuse3", "-lpthread"]);
        assert.equal(existsSync(environment.COMPILER_MARKER!), false);
        for (const name of ["pi-exec-clean-native", "pi-fuse-native", "pi-network-queue-native", "pi-tcp-gateway-native", "libpilot_native.a"]) {
            assert.equal(readFileSync(path.join(environment.PILOT_NATIVE_BUILD_DIRECTORY!, name), "utf8"), "rust binary");
        }
    });
});

test("C reference builder forwards SDK flags and keeps reference artifacts separate", () => {
    withBuildTools((_directory, environment) => {
        const result = build({...environment, FUSE_FLAGS: String.raw`-I/sdk\ directory/include/fuse3 '-L/sdk directory/lib' -lfuse3 -lpthread`}, ["--reference"]);
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const calls = readFileSync(environment.COMPILER_MARKER!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
        assert.equal(calls.length, 6);
        const fuseCall = calls.find((args) => args.includes(path.join(root, "native/pi-fuse.c")))!;
        assert.deepEqual(fuseCall.slice(-4), ["-I/sdk directory/include/fuse3", "-L/sdk directory/lib", "-lfuse3", "-lpthread"]);
        assert.equal(calls.some((args) => args.some((flag) => flag.includes("fuse-shared-library"))), false);
        assert.equal(existsSync(environment.CARGO_MARKER!), false);
        assert.equal(existsSync(path.join(environment.PILOT_NATIVE_BUILD_DIRECTORY!, "pi-fuse-native")), false);
        assert.equal(readFileSync(path.join(environment.PILOT_NATIVE_BUILD_DIRECTORY!, "native-c/pi-fuse-native"), "utf8"), "reference binary");
    });
});

for (const flags of ["", "'-Iunterminated", "-Itrailing\\"]) {
    test(`native builder rejects empty/malformed pkg-config output ${JSON.stringify(flags)}`, () => {
        withBuildTools((_directory, environment) => {
            const result = build({...environment, FUSE_FLAGS: flags}, ["--all"]);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /no compiler\/linker flags|Malformed pkg-config flags/);
            assert.equal(existsSync(environment.COMPILER_MARKER!), false);
            assert.equal(existsSync(environment.CARGO_MARKER!), false);
        });
    });
}

test("failed Cargo build leaves all installed helper binaries unchanged", () => {
    withBuildTools((_directory, environment) => {
        mkdirSync(environment.PILOT_NATIVE_BUILD_DIRECTORY!, {recursive: true});
        const output = path.join(environment.PILOT_NATIVE_BUILD_DIRECTORY!, "pi-fuse-native");
        writeFileSync(output, "running installation");
        const result = build({...environment, CARGO_FAIL: "1"});
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(output, "utf8"), "running installation");
    });
});

test("missing Rust artifact does not publish a partial build and removes staging files", () => {
    withBuildTools((_directory, environment) => {
        mkdirSync(environment.PILOT_NATIVE_BUILD_DIRECTORY!, {recursive: true});
        const output = path.join(environment.PILOT_NATIVE_BUILD_DIRECTORY!, "pi-exec-clean-native");
        writeFileSync(output, "running installation");
        const result = build({...environment, CARGO_OMIT: "pi-fuse-native"});
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(output, "utf8"), "running installation");
        assert.equal(readdirSync(environment.PILOT_NATIVE_BUILD_DIRECTORY!).some((name) => name.includes(".tmp-")), false);
    });
});

test("missing Cargo reports Rust installation guidance without replacing installed helpers", () => {
    withBuildTools((directory, environment) => {
        rmSync(path.join(directory, "cargo"));
        const result = build(environment);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Cargo is required.*Rust helpers/);
        assert.match(result.stderr, /Install Rust >= 1\.85 and Cargo/);
    });
});

test("failed C-reference compilation does not replace the failed helper", () => {
    withBuildTools((_directory, environment) => {
        const directory = path.join(environment.PILOT_NATIVE_BUILD_DIRECTORY!, "native-c");
        mkdirSync(directory, {recursive: true});
        const output = path.join(directory, "pi-fuse-native");
        writeFileSync(output, "previous reference");
        const result = build({...environment, COMPILER_FAIL: "pi-fuse.c"}, ["--reference"]);
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(output, "utf8"), "previous reference");
        assert.equal(readdirSync(directory).some((name) => name.includes(".tmp-")), false);
    });
});
