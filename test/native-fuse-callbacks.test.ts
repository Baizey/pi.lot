import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {constants} from "node:fs";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {Writable} from "node:stream";
import test, {after, before} from "node:test";
import {fileURLToPath} from "node:url";
import {fuseFlags} from "../scripts/native-build-flags.mjs";
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
let initExecutable: string;
let initBuildDirectory: string;

before(async () => {
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), "pilot-callback-build-"));
    executable = path.join(buildDirectory, "probe");
    const compiled = spawnSync("cc", [
        "-std=c17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
        "-o", executable, path.join(root, "test/fixtures/native-fuse-callback-probe.c"),
        ...fuseFlags(),
    ], {cwd: root, encoding: "utf8"});
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
});

before(async () => {
    initBuildDirectory = await mkdtemp(path.join(os.tmpdir(), "pilot-init-build-"));
    initExecutable = path.join(initBuildDirectory, "init-probe");
    const compiled = spawnSync("cc", [
        "-std=c17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
        "-o", initExecutable, path.join(root, "test/fixtures/native-fuse-init-probe.c"),
        ...fuseFlags(),
    ], {cwd: root, encoding: "utf8"});
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
});

after(async () => {
    if (buildDirectory) await rm(buildDirectory, {recursive: true, force: true});
    if (initBuildDirectory) await rm(initBuildDirectory, {recursive: true, force: true});
});

for (const capabilities of ["supported", "unsupported"]) {
    test(`real mount-free INIT declines forbidden ${capabilities} features in the wire reply`, () => {
        const executed = spawnSync(initExecutable, [capabilities], {encoding: "utf8", timeout: 5_000});
        assert.ifError(executed.error);
        assert.equal(executed.status, 0, executed.stderr);
        const result = JSON.parse(executed.stdout) as {
            replyValid: boolean;
            initCalled: boolean;
            requestedBeforeInit: boolean;
            requestedAfterInit: boolean;
            forbiddenNegotiated: boolean;
            asyncReadNegotiated: boolean;
            capabilitiesPreserved: boolean;
            configurationSafe: boolean;
            stateReturned: boolean;
        };
        assert.equal(result.replyValid, true);
        assert.equal(result.initCalled, true);
        assert.equal(result.requestedBeforeInit, capabilities === "supported");
        assert.equal(result.requestedAfterInit, false);
        assert.equal(result.forbiddenNegotiated, false);
        assert.equal(result.asyncReadNegotiated, true);
        assert.equal(result.capabilitiesPreserved, true);
        assert.equal(result.configurationSafe, true);
        assert.equal(result.stateReturned, true);
    });
}

for (const capabilities of ["supported", "unsupported"]) {
    test(`init requests unsafe feature disabling through mocked helpers with ${capabilities} capabilities`, async () => {
        await withFixture(async (directory) => {
            const result = await probe(directory, [policy(directory)], "init", capabilities);
            assert.equal(result.forbiddenWant, 0);
            assert.equal(result.forbiddenWantExt, 0);
            assert.equal(result.preservedWant, true);
            assert.equal(result.preservedWantExt, true);
            assert.equal(result.capabilitiesUnchanged, true);
            assert.equal(result.parallelDirectWrites, 0);
            assert.equal(result.nullpathOk, 0);
            assert.equal(result.directIo, 0);
            assert.equal(result.keepCache, 0);
            assert.equal(result.autoCache, 0);
            assert.equal(result.stateReturned, true);
            assert.equal(result.disableRequestsComplete, true);
        });
    });
}

for (const flags of [1, 2, 4, 8, 0xffff_ffff]) {
    test(`rename rejects unsupported flags ${flags} without changing either name`, async () => {
        await withFixture(async (directory) => {
            const source = path.join(directory, "source");
            const destination = path.join(directory, "destination");
            await writeFile(source, "source");
            await writeFile(destination, "destination");
            const result = await probe(directory, [policy(directory)], "rename", source, destination, String(flags));
            assert.equal(result.result, -errno.EOPNOTSUPP);
            assert.equal(await readFile(source, "utf8"), "source");
            assert.equal(await readFile(destination, "utf8"), "destination");
        });
    });
}

test("rename with zero flags retains source and destination write checkpoints", async () => {
    await withFixture(async (directory) => {
        const source = path.join(directory, "source");
        const destination = path.join(directory, "destination");
        await writeFile(source, "source");
        await writeFile(destination, "destination");
        for (const target of [source, destination]) {
            const denied = await probe(directory, [policy(directory), policy(target, PolicyResponse.ALLOWED, PolicyResponse.DENIED)],
                "rename", source, destination, "0");
            assert.equal(denied.result, -errno.EACCES);
            assertDenied(denied, target, NativeFilesystemAccess.WRITE);
            assert.equal(await readFile(source, "utf8"), "source");
            assert.equal(await readFile(destination, "utf8"), "destination");
        }
        const allowed = await probe(directory, [policy(directory)], "rename", source, destination, "0");
        assert.equal(allowed.result, 0);
        await assert.rejects(stat(source), {code: "ENOENT"});
        assert.equal(await readFile(destination, "utf8"), "source");
    });
});

test("truncate without a handle retains pathname authorization", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "truncate", target);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, target, NativeFilesystemAccess.WRITE);
        assert.equal(await readFile(target, "utf8"), "original");
        assert.equal((await probe(directory, [policy(directory)], "truncate", target)).result, 0);
        assert.equal(await readFile(target, "utf8"), "or");
    });
});

for (const operation of ["chmod", "chown", "utimens"]) {
    test(`${operation} with a retained handle still acts on the authorized pathname`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            const moved = path.join(directory, "moved");
            await writeFile(target, "original", {mode: 0o600});
            const original = await stat(target);
            const result = await probe(directory, [policy(directory), policy(moved, PolicyResponse.DENIED, PolicyResponse.DENIED)],
                "metadata", target, moved, operation);
            assert.equal(result.result, 0);
            assert.equal(await readFile(moved, "utf8"), "original");
            assert.equal(await readFile(target, "utf8"), "replacement");
            if (operation === "chmod") {
                assert.equal((await stat(moved)).mode & 0o777, 0o600);
                assert.equal((await stat(target)).mode & 0o777, 0o640);
            } else if (operation === "utimens") {
                assert.equal((await stat(moved)).mtimeMs, original.mtimeMs);
                assert.equal((await stat(target)).mtimeMs, 123456789000);
            }
        });
    });
    test(`${operation} with a retained handle does not bypass pathname write denial`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            const moved = path.join(directory, "moved");
            await writeFile(target, "original");
            const result = await probe(directory, [policy(directory), policy(target, PolicyResponse.ALLOWED, PolicyResponse.DENIED)],
                "metadata", target, moved, operation);
            assert.equal(result.result, -errno.EACCES);
            assertDenied(result, target, NativeFilesystemAccess.WRITE);
            assert.equal(await readFile(moved, "utf8"), "original");
            assert.equal(await readFile(target, "utf8"), "replacement");
        });
    });
}

for (const mode of ["path", "handle"]) {
    test(`getattr consolidates ${mode} metadata lookup`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            await writeFile(target, "original");
            const result = await probe(directory, [policy(directory)], "getattr", target, mode);
            assert.equal(result.result, 0);
            assert.equal(result.size, 8);
        });
    });
}

test("readdir PLUS requests retain name-only filling, offsets and directory getattr", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "directory");
        await mkdir(target);
        await writeFile(path.join(target, "a"), "a");
        await writeFile(path.join(target, "b"), "b");
        const result = await probe(directory, [policy(directory)], "readdir", target);
        assert.equal(result.result, 0);
        assert.equal(result.firstEntries, 1);
        assert.equal(result.entries, 4);
        assert.equal(result.nameOnly, true);
        assert.equal(result.directoryAttributes, true);
        assert.equal(result.pointerHandleRejected, true);
        const denied = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "readdir", target);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, target, NativeFilesystemAccess.READ);
        assert.equal(denied.entries, 0);
    });
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
    forbiddenWant: number;
    forbiddenWantExt: number;
    preservedWant: boolean;
    preservedWantExt: boolean;
    capabilitiesUnchanged: boolean;
    parallelDirectWrites: number;
    nullpathOk: number;
    autoCache: number;
    stateReturned: boolean;
    disableRequestsComplete: boolean;
    size: number;
    firstEntries: number;
    entries: number;
    nameOnly: boolean;
    directoryAttributes: boolean;
    pointerHandleRejected: boolean;
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
