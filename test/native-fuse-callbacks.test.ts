import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {constants} from "node:fs";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {Writable} from "node:stream";
import test, {after, before} from "node:test";
import {fileURLToPath} from "node:url";
import {
    decodeNativeFilesystemControlFrames,
    decodeNativeFilesystemPolicyMiss,
    encodeNativeFilesystemOnceSnapshotMessage,
    encodeNativeFilesystemPolicySnapshot,
    NativeFilesystemAccess,
    NativeFilesystemRequestMessage,
} from "../src/policy/path/native/NativeFilesystemPolicyProtocol.js";
import type {NativeFilesystemPolicySnapshot} from "../src/policy/path/native/NativeFilesystemPolicyView.js";
import {PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse, type Policy} from "../src/policy/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const errno = os.constants.errno;
let buildDirectory: string;
let executable: string;

before(async () => {
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), "pilot-callback-build-"));
    executable = path.join(buildDirectory, "probe");
    const packageOutput = (name: string): string => {
        const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(name)})`], {
            cwd: root, encoding: "utf8",
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.trim());
        return result.stdout.trim();
    };
    const compiled = spawnSync("cc", [
        "-std=c17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
        "-o", executable, path.join(root, "test/fixtures/native-fuse-callback-probe.c"),
        `-I${packageOutput("fuse-shared-library/include")}`,
        packageOutput("fuse-shared-library/lib"), "-pthread",
    ], {cwd: root, encoding: "utf8"});
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
});

after(async () => {
    if (buildDirectory) await rm(buildDirectory, {recursive: true, force: true});
});

test("hardlink requires source write permission and leaves no denied alias", async () => {
    await withFixture(async (directory) => {
        const source = path.join(directory, "source");
        const alias = path.join(directory, "alias");
        await writeFile(source, "original");
        const denied = await probe(directory, [policy(directory), policy(source, PolicyResponse.ALLOWED, PolicyResponse.DENIED)],
            "link", source, alias);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, source, NativeFilesystemAccess.WRITE);
        await assert.rejects(stat(alias), {code: "ENOENT"});
        assert.equal((await stat(source)).nlink, 1);
        const allowed = await probe(directory, [policy(directory)], "link", source, alias);
        assert.equal(allowed.result, 0);
        assert.equal((await stat(source)).ino, (await stat(alias)).ino);
        assert.equal((await stat(source)).nlink, 2);
    });
});

for (const [name, access] of [["readonly", constants.O_RDONLY], ["writeonly", constants.O_WRONLY], ["readwrite", constants.O_RDWR]] as const) {
    test(`create preserves ${name} access mode and cache contract`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "created");
            const result = await probe(directory, [policy(directory)], "create", target, String(access));
            assert.equal(result.result, 0);
            assert.equal(result.statusFlags & 3, access);
            assert.equal(result.directIo, access === constants.O_RDONLY ? 0 : 1);
            assert.equal(result.keepCache, 0);
            assert.equal(result.handleAssigned, true);
            assert.equal((await stat(target)).size, 0);
            const exclusive = await probe(directory, [policy(directory)], "create", target, String(access));
            assert.equal(exclusive.result, -errno.EEXIST);
        });
    });
}

test("create preserves append and nonblocking status flags", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "append");
        const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK;
        const result = await probe(directory, [policy(directory)], "create-append", target, String(flags));
        assert.equal(result.result, 0);
        assert.equal(result.statusFlags & constants.O_APPEND, constants.O_APPEND);
        assert.equal(result.statusFlags & constants.O_NONBLOCK, constants.O_NONBLOCK);
        assert.equal(result.firstWrite, 1);
        assert.equal(result.secondWrite, 1);
        assert.equal(await readFile(target, "utf8"), "ab");
    });
});

test("readonly create checks read policy before exposing a cached handle", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "created");
        const result = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "create", target, String(constants.O_RDONLY));
        assert.equal(result.result, -errno.EACCES);
        assertDenied(result, target, NativeFilesystemAccess.READ);
        assert.equal(result.handleAssigned, false);
        assert.equal(result.directIo, 1);
        assert.equal(result.keepCache, 1);
        await assert.rejects(stat(target), {code: "ENOENT"});
        // Writable descriptors remain direct and can be created without read permission.
        const writable = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "create", target, String(constants.O_WRONLY));
        assert.equal(writable.result, 0);
        assert.equal(writable.directIo, 1);
    });
});

test("readonly truncating open checks write policy before changing contents (defense in depth)", async () => {
    // Default FUSE dispatch strips O_TRUNC and invokes truncate separately; this tests the callback itself.
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        const result = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)],
            "open", target, String(constants.O_RDONLY | constants.O_TRUNC));
        assert.equal(result.result, -errno.EACCES);
        assertDenied(result, target, NativeFilesystemAccess.WRITE);
        assert.equal(result.handleAssigned, false);
        assert.equal(await readFile(target, "utf8"), "original");
        const allowed = await probe(directory, [policy(directory)], "open", target, String(constants.O_RDONLY | constants.O_TRUNC));
        assert.equal(allowed.result, 0);
        assert.equal(await readFile(target, "utf8"), "");
    });
});

test("xattr create/replace flags preserve native success and errno", async (context) => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        const set = (flags: number, value = "first") => probe(directory, [policy(directory)], "setxattr", target, String(flags), value);
        const created = await set(1); // Linux XATTR_CREATE
        if (created.result === -errno.ENOTSUP) {
            context.skip("fixture filesystem explicitly returned ENOTSUP for user xattrs");
            return;
        }
        assert.equal(created.result, 0);
        assert.equal((await set(1)).result, -errno.EEXIST);
        assert.equal((await set(2, "second")).result, 0); // Linux XATTR_REPLACE
        assert.equal((await probe(directory, [policy(directory)], "getxattr", target)).value, "second");
        assert.equal((await set(0, "third")).result, 0);
        // Linux accepts both bits and reports native existence errors.
        assert.equal((await set(3)).result, -errno.EEXIST);
        assert.equal((await set(4)).result, -errno.EINVAL);
        assert.equal((await set(-1)).result, -errno.EINVAL);
        assert.equal((await probe(directory, [policy(directory)], "getxattr", target)).value, "third");
        const empty = path.join(directory, "empty");
        await writeFile(empty, "");
        assert.equal((await probe(directory, [policy(directory)], "setxattr", empty, "2", "missing")).result, -errno.ENODATA);
        assert.equal((await probe(directory, [policy(directory)], "setxattr", empty, "3", "missing")).result, -errno.ENODATA);
    });
});

for (const operation of ["read", "write", "truncate"] as const) {
    test(`retained ${operation} rejects path replacement without changing the moved inode`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "allowed");
            const moved = path.join(directory, "denied");
            await writeFile(target, "original");
            const result = await probe(directory, [policy(directory), policy(moved, PolicyResponse.DENIED, PolicyResponse.DENIED)],
                "handle", target, moved, operation, "replace");
            assert.equal(result.result, -errno.EACCES);
            assert.equal(result.readValue, "");
            assert.equal(result.retainedValue, "original");
            assert.equal(await readFile(moved, "utf8"), "original");
            assert.equal(await readFile(target, "utf8"), "replacement");
        });
    });
    test(`retained ${operation} accepts same inode despite external content changes`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "allowed");
            await writeFile(target, "original");
            const result = await probe(directory, [policy(directory)], "handle", target, path.join(directory, "unused"), operation, "same");
            const expected = operation === "write" ? "Xriginal!" : operation === "truncate" ? "or" : "original!";
            assert.equal(result.result, operation === "read" ? 9 : operation === "write" ? 1 : 0);
            assert.equal(result.retainedValue, expected);
            assert.equal(await readFile(target, "utf8"), expected);
        });
    });
    for (const mutation of ["missing", "invalid", "closed"] as const) {
        test(`retained ${operation} fails closed for ${mutation} handle/path`, async () => {
            await withFixture(async (directory) => {
                const target = path.join(directory, "allowed");
                await writeFile(target, "original");
                const result = await probe(directory, [policy(directory)], "handle", target, path.join(directory, "unused"), operation, mutation);
                assert.ok(result.result < 0);
                assert.equal(result.readValue, "");
                if (mutation === "missing") assert.equal(result.retainedValue, "original");
                else assert.equal(await readFile(target, "utf8"), "original");
            });
        });
    }
}

for (const operation of ["open", "read", "write", "truncate"] as const) {
    test(`${operation} fails closed after controller EOF despite allowing snapshots`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "allowed");
            await writeFile(target, "original");
            const result = await probe(directory, [policy(directory)], "disconnect", target, operation);
            assert.equal(result.result, -errno.EACCES);
            assert.equal(result.readValue, "");
            assert.equal(await readFile(target, "utf8"), "original");
            if (operation === "open") {
                assert.equal(result.handleAssigned, false);
                assert.equal(result.directIo, 1);
                assert.equal(result.keepCache, 1);
            } else {
                assert.equal(result.retainedValue, "original");
            }
        });
    });
}

function policy(pattern: string, read = PolicyResponse.ALLOWED, write = PolicyResponse.ALLOWED): Policy {
    return {
        pattern,
        info: {
            [PolicyAccessType.FS_READ]: {accessType: PolicyAccessType.FS_READ, lifetime: PolicyLifetime.SESSION, status: read, reason: "callback fixture"},
            [PolicyAccessType.FS_WRITE]: {accessType: PolicyAccessType.FS_WRITE, lifetime: PolicyLifetime.SESSION, status: write, reason: "callback fixture"},
        },
    };
}

async function withFixture(run: (directory: string) => Promise<void>): Promise<void> {
    // Linux tmpfs keeps native callback fixtures off any inherited FUSE root mount.
    const directory = await mkdtemp(path.join("/dev/shm", "pilot-callback-test-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
}

type ProbeResult = {
    result: number;
    statusFlags: number;
    directIo: number;
    keepCache: number;
    handleAssigned: boolean;
    firstWrite: number;
    secondWrite: number;
    value: string;
    readValue: string;
    retainedValue: string;
    denials: ReturnType<typeof decodeNativeFilesystemPolicyMiss>[];
};

function assertDenied(result: ProbeResult, target: string, access: NativeFilesystemAccess): void {
    assert.equal(result.denials.length, 1);
    assert.equal(result.denials[0]!.path, target);
    assert.equal(result.denials[0]!.access, access);
}

async function probe(directory: string, policies: Policy[], ...args: string[]): Promise<ProbeResult> {
    const snapshot: NativeFilesystemPolicySnapshot = {
        revision: 1,
        layers: [{policies, resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY}],
    };
    const snapshotPath = path.join(directory, "policy.snapshot");
    await writeFile(snapshotPath, encodeNativeFilesystemPolicySnapshot(snapshot));
    const child = spawn(executable, [snapshotPath, path.join(directory, "hidden"), ...args], {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const responses = child.stdio[4] as Writable;
    let responseError: Error | undefined;
    responses.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ECONNRESET") responseError = error;
    });
    // Keep the controller pipe live until the child exits: EOF deliberately fails authorization.
    responses.write(encodeNativeFilesystemOnceSnapshotMessage({revision: 1, layers: []}));
    let stdout = "";
    let stderr = "";
    const requests: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.stdio[3]!.on("data", (chunk: Buffer) => { requests.push(chunk); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    let exitCode: number | null;
    try {
        exitCode = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
    } finally {
        clearTimeout(timeout);
    }
    assert.ifError(responseError);
    assert.equal(exitCode, 0, stderr);
    const decoded = decodeNativeFilesystemControlFrames(Buffer.concat(requests));
    assert.equal(decoded.remainder.length, 0);
    assert.ok(decoded.frames.every((frame) => frame.type === NativeFilesystemRequestMessage.DENIAL), "unexpected policy miss");
    return {
        ...JSON.parse(stdout) as Omit<ProbeResult, "denials">,
        denials: decoded.frames.map((frame) => decodeNativeFilesystemPolicyMiss(frame.payload)),
    };
}
