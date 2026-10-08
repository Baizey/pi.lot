import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {closeSync, mkdtempSync, openSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const implementations = ["build/native-c/pi-fuse-native", "build/pi-fuse-native"];

type Rule = {layer: number; access: number; decision: number; path: string | Buffer};

// Encode independently of the TypeScript projector to test the native wire
// contract, not merely agreement between two consumers of the same encoder.
function snapshot(rules: Rule[], revision = 1n): Buffer {
    const header = Buffer.alloc(20);
    header.write("PILOTNP2");
    header.writeBigUInt64LE(revision, 8);
    header.writeUInt32LE(rules.length, 16);
    const records = rules.map((rule) => {
        const name = Buffer.isBuffer(rule.path) ? rule.path : Buffer.from(rule.path);
        const record = Buffer.alloc(12);
        record.writeUInt32LE(rule.layer);
        record[4] = rule.access;
        record[5] = rule.decision;
        record.writeUInt32LE(name.length, 8);
        return Buffer.concat([record, name]);
    });
    return Buffer.concat([header, ...records]);
}

function compare(filename: string, target: string): {status: number | null; stdout: string} {
    const results = implementations.map((executable) => {
        // Node closes ignored extra stdio descriptors; use a real descriptor
        // so native setup succeeds and a policy miss observes controller EOF.
        const responses = openSync("/dev/null", "r");
        try {
            const result = spawnSync(path.join(root, executable), [
                "--check-policy-protocol", filename, "3", "4", target,
            ], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe", responses], timeout: 3_000});
            assert.ifError(result.error);
            assert.equal(result.signal, null, `${executable}: unexpected signal`);
            return {status: result.status, stdout: result.stdout, stderr: result.stderr,
                requests: result.output[3] ?? ""};
        } finally { closeSync(responses); }
    });
    assert.deepEqual(results[1], results[0], `Rust/C mismatch for ${target}`);
    return results[0]!;
}

function withSnapshot(run: (filename: string) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-fuse-parity-"));
    try { run(path.join(directory, "policy.snapshot")); }
    finally { rmSync(directory, {recursive: true, force: true}); }
}

const read = (name: string | Buffer, decision: number, layer = 0): Rule => ({path: name, access: 1, decision, layer});

const cases: Array<{name: string; rules: Rule[]; target: string; decision: "allow" | "deny"}> = [
    {name: "root allow covers descendants", rules: [read("/", 1)], target: "/a/b", decision: "allow"},
    {name: "root deny covers root", rules: [read("/", 2)], target: "/", decision: "deny"},
    {name: "specific deny beats broad allow", rules: [read("/", 1), read("/a", 2)], target: "/a/b", decision: "deny"},
    {name: "specific allow beats broad deny", rules: [read("/", 2), read("/a", 1)], target: "/a/b", decision: "allow"},
    {name: "scope boundary excludes similarly named siblings", rules: [read("/", 1), read("/a", 2)], target: "/ab", decision: "allow"},
    {name: "scope matches exact name", rules: [read("/", 1), read("/a", 2)], target: "/a", decision: "deny"},
    {name: "Linux case sensitivity", rules: [read("/", 1), read("/Secret", 2)], target: "/secret", decision: "allow"},
    {name: "trailing slash scope excludes bare parent", rules: [read("/", 2), read("/a/", 1)], target: "/a", decision: "deny"},
    {name: "trailing slash scope includes children", rules: [read("/", 2), read("/a/", 1)], target: "/a/b", decision: "allow"},
    {name: "earlier layer dominates later specificity", rules: [read("/", 2), read("/a/b", 1, 1)], target: "/a/b", decision: "deny"},
    {name: "unmatched earlier layer permits later layer", rules: [read("/other", 2), read("/a", 1, 1)], target: "/a/b", decision: "allow"},
    {name: "first equal-specificity rule wins", rules: [read("/a", 2), read("/a", 1)], target: "/a", decision: "deny"},
    {name: "access types remain separate", rules: [{path: "/", access: 2, decision: 2, layer: 0}, read("/", 1)], target: "/a", decision: "allow"},
    {name: "backslash is a filename byte", rules: [read("/", 1), read("/secret\\", 2)], target: "/secret\\", decision: "deny"},
    {name: "non-UTF8 rules do not affect UTF8 siblings", rules: [read("/", 1), read(Buffer.from([47, 255]), 2)], target: "/secret", decision: "allow"},
    {name: "highest accepted layer", rules: [read("/", 1, 63)], target: "/a", decision: "allow"},
];

for (const fixture of cases) {
    test(`FUSE snapshot parity: ${fixture.name}`, () => withSnapshot((filename) => {
        writeFileSync(filename, snapshot(fixture.rules, 0xffff_ffff_ffff_ffffn));
        const result = compare(filename, fixture.target);
        assert.equal(result.status, fixture.decision === "allow" ? 0 : 2);
        assert.equal(result.stdout, `{"baseRevision":18446744073709551615,"onceRevision":0,"decision":"${fixture.decision}"}\n`);
    }));
}

test("FUSE snapshot parity rejects malformed headers, rules, lengths and truncations", () => withSnapshot((filename) => {
    const valid = snapshot([read("/secret", 2), read("/", 1)]);
    const invalid: Buffer[] = [Buffer.alloc(0), Buffer.alloc(20), Buffer.concat([valid, Buffer.of(0)])];
    for (let length = 0; length < valid.length; length++) invalid.push(valid.subarray(0, length));
    for (const [offset, value] of [[0, 0], [16, 255], [20, 64], [24, 0], [24, 3], [25, 0], [25, 3], [28, 0], [29, 16], [32, 0], [32, 97]] as const) {
        const bytes = Buffer.from(valid);
        bytes[offset] = value;
        invalid.push(bytes);
    }
    for (const bytes of invalid) {
        writeFileSync(filename, bytes);
        const result = compare(filename, "/secret");
        assert.equal(result.status, 64, bytes.toString("hex"));
        assert.equal(result.stdout, "");
    }
}));

test("FUSE snapshot parity covers deterministic malformed-byte mutations", () => withSnapshot((filename) => {
    const valid = snapshot([read("/secret", 2), read("/", 1), read("/later", 2, 63)]);
    let seed = 0x70696c6f;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let index = 0; index < 128; index++) {
        const bytes = Buffer.from(valid);
        for (let mutation = 0; mutation < 1 + index % 4; mutation++) {
            bytes[next() % bytes.length] = next() & 255;
        }
        writeFileSync(filename, bytes);
        compare(filename, "/secret");
    }
}));

for (const ignored of [false, true]) {
    test(`FUSE protocol check preserves inherited ${ignored ? "ignored" : "default"} SIGPIPE`, () => withSnapshot((filename) => {
        writeFileSync(filename, snapshot([]));
        const launcher = `import json, os, signal, subprocess, sys
reader, request = os.pipe()
os.close(reader)
response = os.open('/dev/null', os.O_RDONLY)
ignored = sys.argv[3] == 'true'
result = subprocess.run([sys.argv[1], '--check-policy-protocol', sys.argv[2], str(request), str(response), '/target'],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(request, response),
    preexec_fn=lambda: signal.signal(signal.SIGPIPE, signal.SIG_IGN if ignored else signal.SIG_DFL), timeout=3)
print(json.dumps({'status': result.returncode, 'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()}))
`;
        const results = implementations.map((executable) => {
            const result = spawnSync("python3", ["-c", launcher, path.join(root, executable), filename, String(ignored)], {encoding: "utf8", timeout: 5_000});
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            return JSON.parse(result.stdout) as {status: number; stdout: string; stderr: string};
        });
        assert.deepEqual(results[1], results[0]);
        assert.equal(results[0]!.status, ignored ? 2 : -13);
        assert.equal(results[0]!.stdout, ignored ? '{"baseRevision":1,"onceRevision":0,"decision":"deny"}\n' : "");
        assert.equal(results[0]!.stderr, "");
    }));
}

for (const descriptor of [0, 1, 2]) {
    test(`FUSE protocol check does not silently reopen initially closed standard fd ${descriptor}`, () => withSnapshot((filename) => {
        writeFileSync(filename, snapshot([read("/", 1)]));
        const launcher = `import json, os, subprocess, sys
request = os.open('/dev/null', os.O_RDWR)
closed = int(sys.argv[3])
result = subprocess.run([sys.argv[1], '--check-policy-protocol', sys.argv[2], str(request), str(closed), '/target'],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(request,), preexec_fn=lambda: os.close(closed), timeout=3)
print(json.dumps({'status': result.returncode, 'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()}))
`;
        const results = implementations.map((executable) => {
            const result = spawnSync("python3", ["-c", launcher, path.join(root, executable), filename, String(descriptor)], {encoding: "utf8", timeout: 5_000});
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            return JSON.parse(result.stdout) as {status: number; stdout: string; stderr: string};
        });
        assert.deepEqual(results[1], results[0]);
        assert.equal(results[0]!.status, 64);
        assert.equal(results[0]!.stdout, "");
        assert.equal(results[0]!.stderr, descriptor === 2 ? "" : "configure native policy protocol descriptors: Bad file descriptor\n");
    }));
}

for (const revision of [0n, 1n, 0xffff_ffffn, 0x1_0000_0000n, 0xffff_ffff_ffff_ffffn]) {
    test(`FUSE snapshot parity preserves full-width revision ${revision}`, () => withSnapshot((filename) => {
        writeFileSync(filename, snapshot([read("/", 1)], revision));
        const result = compare(filename, "/a");
        assert.equal(result.status, 0);
        assert.equal(result.stdout, `{"baseRevision":${revision},"onceRevision":0,"decision":"allow"}\n`);
    }));
}
