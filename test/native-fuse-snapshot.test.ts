import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {closeSync, mkdtempSync, openSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const executable = path.join(root, "build/pi-fuse-native");

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

function checkPolicy(filename: string, target: string): {status: number | null; stdout: string} {
    // Node closes ignored extra stdio descriptors; use a real descriptor
    // so native setup succeeds and a policy miss observes controller EOF.
    const responses = openSync("/dev/null", "r");
    try {
        const result = spawnSync(executable, [
            "--check-policy-protocol", filename, "3", "4", target,
        ], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe", responses], timeout: 3_000});
        assert.ifError(result.error);
        assert.equal(result.signal, null, `${executable}: unexpected signal`);
        return {status: result.status, stdout: result.stdout};
    } finally { closeSync(responses); }
}

function withSnapshot(run: (filename: string) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-fuse-snapshot-"));
    try { run(path.join(directory, "policy.snapshot")); }
    finally { rmSync(directory, {recursive: true, force: true}); }
}

// A byte-level policy oracle, separate from the production projector/parser.
// Reserved record bytes are opaque; unmatched read policy fails closed on EOF.
function snapshotOracle(bytes: Buffer, target: string): {revision: bigint; decision: "allow" | "deny"} | null {
    if (bytes.length < 20 || bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "50494c4f544e5032") return null;
    const rules: Array<{layer: number; access: number; decision: number; scope: Buffer}> = [];
    const count = bytes.readUInt32LE(16);
    let offset = 20;
    for (let index = 0; index < count; index++) {
        if (offset + 12 > bytes.length) return null;
        const layer = bytes.readUInt32LE(offset);
        const access = bytes[offset + 4];
        const decision = bytes[offset + 5];
        const length = bytes.readUInt32LE(offset + 8);
        offset += 12;
        if (layer > 63 || (access !== 1 && access !== 2) || (decision !== 1 && decision !== 2)
            || length < 1 || length > 4095 || offset + length > bytes.length) return null;
        const scope = bytes.subarray(offset, offset + length);
        if (scope[0] !== 47 || scope.includes(0)) return null;
        rules.push({layer, access, decision, scope});
        offset += length;
    }
    if (offset !== bytes.length) return null;
    const name = Buffer.from(target);
    const matches = rules.filter(rule => rule.access === 1 && name.subarray(0, rule.scope.length).equals(rule.scope)
        && (name.length === rule.scope.length || rule.scope.at(-1) === 47 || name[rule.scope.length] === 47));
    // Stable sorting preserves the first wire rule on specificity ties.
    matches.sort((a, b) => a.layer - b.layer || b.scope.length - a.scope.length);
    return {revision: bytes.readBigUInt64LE(8), decision: matches[0]?.decision === 1 ? "allow" : "deny"};
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
    test(`FUSE snapshot: ${fixture.name}`, () => withSnapshot((filename) => {
        const bytes = snapshot(fixture.rules, 0xffff_ffff_ffff_ffffn);
        writeFileSync(filename, bytes);
        assert.deepEqual(snapshotOracle(bytes, fixture.target), {revision: 0xffff_ffff_ffff_ffffn, decision: fixture.decision});
        const result = checkPolicy(filename, fixture.target);
        assert.equal(result.status, fixture.decision === "allow" ? 0 : 2);
        assert.equal(result.stdout, `{"baseRevision":18446744073709551615,"onceRevision":0,"decision":"${fixture.decision}"}\n`);
    }));
}

test("FUSE snapshot rejects malformed headers, rules, lengths and truncations", () => withSnapshot((filename) => {
    const valid = snapshot([read("/secret", 2), read("/", 1)]);
    const invalid: Buffer[] = [Buffer.alloc(0), Buffer.alloc(20), Buffer.concat([valid, Buffer.of(0)])];
    for (let length = 0; length < valid.length; length++) invalid.push(valid.subarray(0, length));
    for (const [offset, value] of [[0, 0], [16, 255], [20, 64], [24, 0], [24, 3], [25, 0], [25, 3], [28, 0], [29, 16], [32, 0], [32, 97]] as const) {
        const bytes = Buffer.from(valid);
        bytes[offset] = value;
        invalid.push(bytes);
    }
    for (const bytes of invalid) {
        assert.equal(snapshotOracle(bytes, "/secret"), null, `oracle: ${bytes.toString("hex")}`);
        writeFileSync(filename, bytes);
        const result = checkPolicy(filename, "/secret");
        assert.equal(result.status, 64, bytes.toString("hex"));
        assert.equal(result.stdout, "");
    }
}));

test("FUSE snapshot mutation corpus matches independent rejection and policy expectations", () => withSnapshot((filename) => {
    const valid = snapshot([read("/secret", 2), read("/", 1), read("/later", 2, 63)]);
    let seed = 0x70696c6f;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    let accepted = 0;
    let rejected = 0;
    for (let index = 0; index < 128; index++) {
        const bytes = Buffer.from(valid);
        for (let mutation = 0; mutation < 1 + index % 4; mutation++) {
            bytes[next() % bytes.length] = next() & 255;
        }
        writeFileSync(filename, bytes);
        const expected = snapshotOracle(bytes, "/secret");
        if (expected === null) rejected++; else accepted++;
        const result = checkPolicy(filename, "/secret");
        const description = `mutation ${index}: ${bytes.toString("hex")}`;
        assert.equal(result.status, expected === null ? 64 : expected.decision === "allow" ? 0 : 2, description);
        assert.equal(result.stdout, expected === null ? ""
            : `{"baseRevision":${expected.revision},"onceRevision":0,"decision":"${expected.decision}"}\n`, description);
    }
    assert.ok(accepted > 0 && rejected > 0, "corpus must exercise both valid snapshots and rejected encodings");
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
        const launched = spawnSync("python3", ["-c", launcher, executable, filename, String(ignored)], {encoding: "utf8", timeout: 5_000});
        assert.ifError(launched.error);
        assert.equal(launched.status, 0, launched.stderr);
        const result = JSON.parse(launched.stdout) as {status: number; stdout: string; stderr: string};
        assert.equal(result.status, ignored ? 2 : -13);
        assert.equal(result.stdout, ignored ? '{"baseRevision":1,"onceRevision":0,"decision":"deny"}\n' : "");
        assert.equal(result.stderr, "");
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
        const launched = spawnSync("python3", ["-c", launcher, executable, filename, String(descriptor)], {encoding: "utf8", timeout: 5_000});
        assert.ifError(launched.error);
        assert.equal(launched.status, 0, launched.stderr);
        const result = JSON.parse(launched.stdout) as {status: number; stdout: string; stderr: string};
        assert.equal(result.status, 64);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, descriptor === 2 ? "" : "configure native policy protocol descriptors: Bad file descriptor\n");
    }));
}

for (const revision of [0n, 1n, 0xffff_ffffn, 0x1_0000_0000n, 0xffff_ffff_ffff_ffffn]) {
    test(`FUSE snapshot preserves full-width revision ${revision}`, () => withSnapshot((filename) => {
        writeFileSync(filename, snapshot([read("/", 1)], revision));
        const result = checkPolicy(filename, "/a");
        assert.equal(result.status, 0);
        assert.equal(result.stdout, `{"baseRevision":${revision},"onceRevision":0,"decision":"allow"}\n`);
    }));
}
