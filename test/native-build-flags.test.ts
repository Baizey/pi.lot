import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {minimumFuseVersion, parsePkgConfigFlags} from "../scripts/native-build-flags.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const resolver = new URL("../scripts/native-build-flags.mjs", import.meta.url).href;

function withBuildTools(run: (directory: string, environment: NodeJS.ProcessEnv) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-build-flags-"));
    const marker = path.join(directory, "compiler.calls");
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
require("node:fs").appendFileSync(process.env.COMPILER_MARKER, JSON.stringify(process.argv.slice(2)) + "\\n");
`, {mode: 0o755});
    try {
        run(directory, {
            ...process.env,
            PATH: directory,
            COMPILER_MARKER: marker,
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

function build(environment: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [path.join(root, "scripts/build-native.mjs")], {
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
    test(`native builder rejects ${mode} FUSE3 SDK before invoking a compiler`, () => {
        withBuildTools((_directory, environment) => {
            const result = build({...environment, SDK_MODE: mode});
            assert.ifError(result.error);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /libfuse >= 3\.17\.3 development files are required/);
            assert.match(result.stderr, /fuse3-devel/);
            assert.match(result.stderr, /rpm-ostree install --apply-live/);
            assert.match(result.stderr, /libfuse3-dev/);
            if (mode === "old") assert.match(result.stderr, /3\.16\.2 is too old/);
            if (mode === "unexported") assert.match(result.stderr, /3\.17\.2 is too old/);
            assert.equal(existsSync(environment.COMPILER_MARKER!), false);
        });
    });
}

test("native builder resolves NFQUEUE before invoking a compiler", () => {
    withBuildTools((_directory, environment) => {
        const result = build({...environment, SDK_MODE: "missing-netfilter"});
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /libnetfilter_queue development files are required/);
        assert.equal(existsSync(environment.COMPILER_MARKER!), false);
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

test("native builder forwards system FUSE3 compiler/linker flags without splitting SDK paths", () => {
    withBuildTools((_directory, environment) => {
        const result = build({...environment, FUSE_FLAGS: String.raw`-I/sdk\ directory/include/fuse3 '-L/sdk directory/lib' -lfuse3 -lpthread`});
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const calls = readFileSync(environment.COMPILER_MARKER!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
        assert.equal(calls.length, 4);
        const fuseCall = calls.find((args) => args.includes(path.join(root, "native/pi-fuse.c")))!;
        assert.ok(fuseCall);
        assert.deepEqual(fuseCall.slice(-4), ["-I/sdk directory/include/fuse3", "-L/sdk directory/lib", "-lfuse3", "-lpthread"]);
        assert.equal(fuseCall.some((flag) => flag.includes("fuse-shared-library")), false);
    });
});

for (const flags of ["", "'-Iunterminated", "-Itrailing\\"]) {
    test(`native builder rejects empty/malformed pkg-config output ${JSON.stringify(flags)}`, () => {
        withBuildTools((_directory, environment) => {
            const result = build({...environment, FUSE_FLAGS: flags});
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /no compiler\/linker flags|Malformed pkg-config flags/);
            assert.equal(existsSync(environment.COMPILER_MARKER!), false);
        });
    });
}
