import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {constants} from "node:fs";
import {link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, statfs, symlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {Writable} from "node:stream";
import test, {after, before} from "node:test";
import {fileURLToPath} from "node:url";
import {fuseProbeFlags} from "../scripts/native-test-build-flags.mjs";
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
const xattrName = "user.pilot_callback_probe";
let buildDirectory: string;
let executable: string;

before(async () => {
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), "pilot-contract-build-"));
    executable = path.join(buildDirectory, "probe");
    const compiled = spawnSync("cc", [
        "-std=c17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
        "-o", executable, path.join(root, "test/fixtures/native-fuse-callback-probe.c"),
        ...fuseProbeFlags(),
    ], {cwd: root, encoding: "utf8"});
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
});

after(async () => {
    if (buildDirectory) await rm(buildDirectory, {recursive: true, force: true});
});

test("mkdir checks write policy before creation and preserves native existence errors", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "created");
        const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "mkdir", target);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, target, NativeFilesystemAccess.WRITE);
        await assertMissing(target);
        const allowed = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "mkdir", target);
        assert.equal(allowed.result, 0);
        assert.deepEqual(allowed.denials, []);
        const attributes = await lstat(target);
        assert.equal(attributes.isDirectory(), true);
        assert.equal(attributes.mode & 0o777, 0o750 & ~process.umask());
        assert.equal((await probe(directory, [policy(directory)], "mkdir", target)).result, -errno.EEXIST);
        assert.equal((await lstat(target)).ino, attributes.ino);
    });
});

test("rmdir preserves denied and nonempty directories before removing an empty directory", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "directory");
        const child = path.join(target, "child");
        await mkdir(target);
        await writeFile(child, "retained");
        const original = await lstat(target);
        const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "rmdir", target);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, target, NativeFilesystemAccess.WRITE);
        assert.equal((await lstat(target)).ino, original.ino);
        assert.equal(await readFile(child, "utf8"), "retained");
        assert.equal((await probe(directory, [policy(directory)], "rmdir", target)).result, -errno.ENOTEMPTY);
        await rm(child);
        assert.equal((await probe(directory, [policy(directory, PolicyResponse.DENIED)], "rmdir", target)).result, 0);
        await assertMissing(target);
        assert.equal((await probe(directory, [policy(directory)], "rmdir", target)).result, -errno.ENOENT);
    });
});

test("unlink removes only the authorized name and retains a hardlinked inode", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        const alias = path.join(directory, "alias");
        await writeFile(target, "original");
        await link(target, alias);
        const original = await lstat(target);
        const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "unlink", target);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, target, NativeFilesystemAccess.WRITE);
        assert.equal((await lstat(target)).nlink, 2);
        assert.equal((await probe(directory, [policy(directory, PolicyResponse.DENIED)], "unlink", target)).result, 0);
        await assertMissing(target);
        assert.equal((await lstat(alias)).ino, original.ino);
        assert.equal((await lstat(alias)).nlink, 1);
        assert.equal(await readFile(alias, "utf8"), "original");
        assert.equal((await probe(directory, [policy(directory)], "unlink", alias)).result, 0);
        await assertMissing(alias);
        assert.equal((await probe(directory, [policy(directory)], "unlink", alias)).result, -errno.ENOENT);
        const subdirectory = path.join(directory, "directory");
        await mkdir(subdirectory);
        assert.equal((await probe(directory, [policy(directory)], "unlink", subdirectory)).result, -errno.EISDIR);
        assert.equal((await lstat(subdirectory)).isDirectory(), true);
    });
});

test("unlink authorizes a symlink's resolved target but removes the link rather than its target", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "target");
        const name = path.join(directory, "alias");
        await writeFile(target, "original");
        await symlink("target", name);
        const denied = await probe(directory, [policy(directory), policy(target, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "unlink", name);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, target, NativeFilesystemAccess.WRITE);
        assert.equal(await readlink(name), "target");
        const allowed = await probe(directory, [policy(directory), policy(name, PolicyResponse.DENIED, PolicyResponse.DENIED)], "unlink", name);
        assert.equal(allowed.result, 0);
        assert.deepEqual(allowed.denials, []);
        await assertMissing(name);
        assert.equal(await readFile(target, "utf8"), "original");
    });
});

for (const kind of ["regular", "fifo"] as const) {
    test(`mknod creates ${kind} nodes only after write authorization`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, kind);
            const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "mknod", target, kind);
            assert.equal(denied.result, -errno.EACCES);
            assertDenied(denied, target, NativeFilesystemAccess.WRITE);
            await assertMissing(target);
            const allowed = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "mknod", target, kind);
            assert.equal(allowed.result, 0);
            assert.deepEqual(allowed.denials, []);
            const attributes = await lstat(target);
            assert.equal(kind === "fifo" ? attributes.isFIFO() : attributes.isFile(), true);
            assert.equal(attributes.mode & 0o777, 0o600 & ~process.umask());
            assert.equal(attributes.size, 0);
            if (kind === "regular") assert.equal(await readFile(target, "utf8"), "");
            assert.equal((await probe(directory, [policy(directory)], "mknod", target, kind)).result, -errno.EEXIST);
            assert.equal((await lstat(target)).ino, attributes.ino);
        });
    });
}

for (const kind of ["char", "block"]) {
    test(`mknod denies ${kind} device creation through policy before the kernel syscall`, async () => {
        // Device permission is policy-mediated, not an unconditional node-type ban.
        // Deny before mknod so this contract does not depend on CAP_MKNOD or tmpfs nodev.
        await withFixture(async (directory) => {
            const target = path.join(directory, kind);
            const result = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "mknod", target, kind);
            assert.equal(result.result, -errno.EACCES);
            assertDenied(result, target, NativeFilesystemAccess.WRITE);
            await assertMissing(target);
        });
    });
}

for (const target of ["target", "./target", "../target", "../missing"]) {
    test(`symlink preserves relative target ${target} without requiring target permission or existence`, async () => {
        await withFixture(async (directory) => {
            const parent = path.join(directory, "links");
            const destination = path.join(parent, "alias");
            await mkdir(parent);
            await writeFile(path.join(directory, "target"), "outside link parent");
            await writeFile(path.join(parent, "target"), "inside link parent");
            const policies = [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED), policy(destination, PolicyResponse.DENIED)];
            const result = await probe(directory, policies, "symlink", destination, target);
            assert.equal(result.result, 0);
            assert.deepEqual(result.denials, []);
            assert.equal((await lstat(destination)).isSymbolicLink(), true);
            assert.equal(await readlink(destination), target);
            if (target === "../missing") await assert.rejects(stat(destination), {code: "ENOENT"});
            else assert.equal(await readFile(destination, "utf8"), target === "../target" ? "outside link parent" : "inside link parent");
        });
    });
}

test("absolute symlink targets are rejected before destination policy and cannot create a name", async () => {
    await withFixture(async (directory) => {
        const destination = path.join(directory, "alias");
        const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], "symlink", destination, "/etc/passwd");
        assert.equal(result.result, -errno.EPERM);
        assert.deepEqual(result.denials, []);
        await assertMissing(destination);
    });
});

test("symlink destination write denial precedes hidden-target filtering", async () => {
    await withFixture(async (directory) => {
        const parent = path.join(directory, "links");
        const destination = path.join(parent, "alias");
        await mkdir(parent);
        for (const target of ["../hidden/secret", "../hidden/../hidden/secret"]) {
            const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "symlink", destination, target);
            assert.equal(denied.result, -errno.EACCES);
            assertDenied(denied, destination, NativeFilesystemAccess.WRITE);
            await assertMissing(destination);
            const hidden = await probe(directory, [policy(directory)], "symlink", destination, target);
            assert.equal(hidden.result, -errno.ENOENT);
            assert.deepEqual(hidden.denials, []);
            await assertMissing(destination);
        }
        const allowed = await probe(directory, [policy(directory)], "symlink", destination, "../hidden-sibling");
        assert.equal(allowed.result, 0);
        assert.equal(await readlink(destination), "../hidden-sibling");
    });
});

for (const [size, expected] of [[64, "relative-target"], [5, "rela"]] as const) {
    test(`readlink size ${size} returns NUL-terminated metadata despite denied content policy`, async () => {
        await withFixture(async (directory) => {
            const name = path.join(directory, "alias");
            await symlink("relative-target", name);
            const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], "readlink", name, String(size));
            assert.equal(result.result, 0);
            assert.deepEqual(result.denials, []);
            const bytes = Buffer.from(result.valueHex, "hex");
            assert.equal(bytes.subarray(0, expected.length).toString(), expected);
            assert.equal(bytes[expected.length], 0);
            assert.deepEqual(bytes.subarray(expected.length + 1), Buffer.alloc(63 - expected.length, 63));
            assert.equal(await readlink(name), "relative-target");
        });
    });
}

test("readlink size one preserves Linux EINVAL from a zero-length backing readlink", async () => {
    await withFixture(async (directory) => {
        const name = path.join(directory, "alias");
        await symlink("relative-target", name);
        const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], "readlink", name, "1");
        assert.equal(result.result, -errno.EINVAL);
        assert.deepEqual(result.denials, []);
        assert.equal(result.valueHex, Buffer.alloc(64, 63).toString("hex"));
    });
});

test("readlink size zero is rejected before path lookup and leaves the buffer untouched", async () => {
    await withFixture(async (directory) => {
        for (const target of [path.join(directory, "missing"), path.join(directory, "hidden", "secret"), `${directory}//alias`]) {
            const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], "readlink", target, "0");
            assert.equal(result.result, -errno.EINVAL);
            assert.deepEqual(result.denials, []);
            assert.equal(result.valueHex, Buffer.alloc(64, 63).toString("hex"));
        }
        const regular = path.join(directory, "file");
        await writeFile(regular, "original");
        assert.equal((await probe(directory, [policy(directory)], "readlink", regular, "64")).result, -errno.EINVAL);
    });
});

for (const mode of [constants.F_OK, constants.R_OK, constants.W_OK, constants.R_OK | constants.W_OK, constants.X_OK]) {
    test(`access mode ${mode} uses backing permissions rather than content policy`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            await writeFile(target, "original", {mode: 0o600});
            const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], "access", target, String(mode));
            assert.equal(result.result, mode === constants.X_OK ? -errno.EACCES : 0);
            assert.deepEqual(result.denials, []);
            assert.equal(await readFile(target, "utf8"), "original");
        });
    });
}

test("access follows symlinks and reports native missing and invalid-mode errors without policy events", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        const alias = path.join(directory, "alias");
        await writeFile(target, "original");
        await symlink("file", alias);
        const policies = [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)];
        assert.equal((await probe(directory, policies, "access", alias, "0")).result, 0);
        const invalid = await probe(directory, policies, "access", target, "8");
        assert.equal(invalid.result, -errno.EINVAL);
        assert.deepEqual(invalid.denials, []);
        const missing = await probe(directory, policies, "access", path.join(directory, "missing"), "0");
        assert.equal(missing.result, -errno.ENOENT);
        assert.deepEqual(missing.denials, []);
    });
});

test("statfs returns backing filesystem geometry despite denied content policy", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        const backing = await statfs(target);
        const policies = [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)];
        for (const name of [directory, target]) {
            const result = await probe(directory, policies, "statfs", name);
            assert.equal(result.result, 0);
            assert.deepEqual(result.denials, []);
            assert.equal(result.blockSize, backing.bsize);
            assert.equal(result.fragmentSize, backing.bsize);
            assert.equal(result.blocks, backing.blocks);
            assert.equal(result.nameMax, 255); // Linux tmpfs NAME_MAX.
        }
        const missing = await probe(directory, policies, "statfs", path.join(directory, "missing"));
        assert.equal(missing.result, -errno.ENOENT);
        assert.deepEqual(missing.denials, []);
    });
});

test("listxattr queries and fills NUL-separated names; removal checks write policy and native ENODATA", async (context) => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        const original = await stat(target);
        // Preserve inherited security labels rather than assuming a newly-created
        // file has no xattrs. The user attribute's name and size remain explicit.
        const baseline = await probe(directory, [policy(directory)], "listxattr", target, "256");
        const created = await probe(directory, [policy(directory)], "setxattr", target, "1", "attribute-value");
        if (created.result === -errno.ENOTSUP) {
            context.skip("fixture filesystem explicitly returned ENOTSUP for user xattrs");
            return;
        }
        assert.equal(created.result, 0);
        assert.ok(baseline.result >= 0);
        const baselineNames = Buffer.from(baseline.valueHex, "hex").toString().split("\0").filter(Boolean);
        assert.equal(baselineNames.includes(xattrName), false);
        const expectedLength = baseline.result + Buffer.byteLength(xattrName) + 1;
        const query = await probe(directory, [policy(directory)], "listxattr", target, "0");
        assert.equal(query.result, expectedLength);
        assert.equal(query.valueHex, "");
        const list = await probe(directory, [policy(directory)], "listxattr", target, "256");
        assert.equal(list.result, expectedLength);
        const names = Buffer.from(list.valueHex, "hex");
        assert.equal(names.at(-1), 0);
        assert.deepEqual(names.toString().split("\0").filter(Boolean).sort(), [...baselineNames, xattrName].sort());
        assert.deepEqual(list.denials, []);
        assert.equal((await probe(directory, [policy(directory)], "listxattr", target, "1")).result, -errno.ERANGE);
        const deniedList = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "listxattr", target, "1");
        assert.equal(deniedList.result, -errno.EACCES); // Authorization precedes ERANGE.
        assertDenied(deniedList, target, NativeFilesystemAccess.READ);
        assert.equal(deniedList.valueHex, "");
        const deniedRemoval = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "removexattr", target);
        assert.equal(deniedRemoval.result, -errno.EACCES);
        assertDenied(deniedRemoval, target, NativeFilesystemAccess.WRITE);
        assert.equal((await probe(directory, [policy(directory)], "getxattr", target)).value, "attribute-value");
        const removed = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "removexattr", target);
        assert.equal(removed.result, 0);
        assert.deepEqual(removed.denials, []);
        assert.equal((await probe(directory, [policy(directory)], "getxattr", target)).result, -errno.ENODATA);
        const afterRemoval = await probe(directory, [policy(directory)], "listxattr", target, "256");
        assert.equal(afterRemoval.result, baseline.result);
        assert.equal(afterRemoval.valueHex, baseline.valueHex);
        assert.equal((await probe(directory, [policy(directory)], "removexattr", target)).result, -errno.ENODATA);
        const deniedMissing = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "removexattr", target);
        assert.equal(deniedMissing.result, -errno.EACCES); // Even missing attributes are mediated first.
        assertDenied(deniedMissing, target, NativeFilesystemAccess.WRITE);
        assert.equal(await readFile(target, "utf8"), "original");
        assert.equal((await stat(target)).ino, original.ino);
    });
});

for (const [offset, size, expected, error] of [
    [2, 3, "cde", 0], [6, 8, "gh", 0], [8, 4, "", 0], [20, 4, "", 0], [1, 0, "", 0], [-1, 1, "", errno.EINVAL],
] as const) {
    test(`read offset ${offset} size ${size} preserves positioned I/O and EOF`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            await writeFile(target, "abcdefgh");
            const original = await stat(target);
            const result = await probe(directory, [policy(directory)], "io", target, "read", String(constants.O_RDONLY), String(offset), String(size), "");
            assert.equal(result.openResult, 0);
            assert.equal(result.result, error ? -error : expected.length);
            assert.equal(result.valueHex, Buffer.from(expected).toString("hex"));
            assert.equal(result.position, 3);
            assert.deepEqual(result.denials, []);
            assert.equal(await readFile(target, "utf8"), "abcdefgh");
            assert.equal((await stat(target)).ino, original.ino);
        });
    });
}

for (const [offset, payload, expected, error] of [
    [2, "XY", "abXYefgh", 0], [8, "XY", "abcdefghXY", 0], [11, "Z", "abcdefgh\0\0\0Z", 0],
    [20, "", "abcdefgh", 0], [-1, "X", "abcdefgh", errno.EINVAL],
] as const) {
    test(`write offset ${offset} size ${payload.length} preserves positioned I/O and sparse extension`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            await writeFile(target, "abcdefgh");
            const original = await stat(target);
            const result = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "io", target, "write", String(constants.O_WRONLY), String(offset), String(payload.length), payload);
            assert.equal(result.openResult, 0);
            assert.equal(result.result, error ? -error : payload.length);
            assert.equal(result.position, 3);
            assert.deepEqual(result.denials, []);
            assert.deepEqual(await readFile(target), Buffer.from(expected));
            assert.equal((await stat(target)).size, expected.length);
            assert.equal((await stat(target)).ino, original.ino);
        });
    });
}

test("read checkpoint denial precedes EOF and kernel descriptor errors after a writable open", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        for (const offset of [0, 100]) {
            const denied = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "io", target, "read", String(constants.O_WRONLY), String(offset), "8", "");
            assert.equal(denied.openResult, 0);
            assert.equal(denied.result, -errno.EACCES);
            assertDenied(denied, target, NativeFilesystemAccess.READ);
            assert.equal(denied.valueHex, "");
            assert.equal(denied.position, 3);
        }
        assert.equal(await readFile(target, "utf8"), "original");
    });
});

test("read-only handles deny writes by policy before EBADF, even for a zero-length write", async () => {
    await withFixture(async (directory) => {
        const target = path.join(directory, "file");
        await writeFile(target, "original");
        const original = await stat(target);
        for (const payload of ["X", ""]) {
            const denied = await probe(directory, [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)], "io", target, "write", String(constants.O_RDONLY), "0", String(payload.length), payload);
            assert.equal(denied.openResult, 0);
            assert.equal(denied.result, -errno.EACCES);
            assertDenied(denied, target, NativeFilesystemAccess.WRITE);
            assert.equal(denied.position, 3);
        }
        const nativeDenial = await probe(directory, [policy(directory)], "io", target, "write", String(constants.O_RDONLY), "0", "1", "X");
        assert.equal(nativeDenial.openResult, 0);
        assert.equal(nativeDenial.result, -errno.EBADF);
        assert.deepEqual(nativeDenial.denials, []);
        assert.equal(await readFile(target, "utf8"), "original");
        assert.equal((await stat(target)).ino, original.ino);
    });
});

for (const kind of ["file", "directory"]) {
    test(`flush/fsync ${kind} handles ignore callback paths and content write denial`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, kind);
            if (kind === "file") await writeFile(target, "original");
            else await mkdir(target);
            const original = await stat(target);
            const policies = [policy(directory, PolicyResponse.ALLOWED, PolicyResponse.DENIED)];
            for (const callbackPath of ["null", path.join(directory, "missing"), path.join(directory, "hidden", "secret"), `${directory}//invalid`]) {
                const result = await probe(directory, policies, `sync-${kind}`, target, callbackPath, "valid");
                assert.equal(result.result, 0);
                assert.equal(result.dataResult, 0);
                assert.equal(result.flushResult, kind === "file" ? 0 : -1);
                assert.deepEqual(result.denials, []);
                assert.equal((await stat(target)).ino, original.ino);
            }
            if (kind === "file") assert.equal(await readFile(target, "utf8"), "original");
        });
    });
    test(`sync ${kind} invalid handles report EBADF without policy lookup`, async () => {
        await withFixture(async (directory) => {
            const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], `sync-${kind}`, path.join(directory, "unused"), "null", "invalid");
            assert.equal(result.result, -errno.EBADF);
            assert.equal(result.dataResult, -errno.EBADF);
            assert.equal(result.flushResult, kind === "file" ? 0 : -1);
            assert.deepEqual(result.denials, []);
        });
    });
}

test("readdir filters the hidden subtree boundary, not denied visible children or hidden-prefix siblings", async () => {
    await withFixture(async (directory) => {
        await mkdir(path.join(directory, "hidden"));
        await writeFile(path.join(directory, "hidden", "secret"), "secret");
        await writeFile(path.join(directory, "hidden-sibling"), "visible");
        await writeFile(path.join(directory, "denied-child"), "denied content");
        await symlink("hidden", path.join(directory, "visible-alias"));
        const policies = [policy(directory), policy(path.join(directory, "denied-child"), PolicyResponse.DENIED, PolicyResponse.DENIED)];
        const result = await probe(directory, policies, "names", directory);
        assert.equal(result.result, 0);
        assert.equal(result.nameOnly, true);
        assert.deepEqual(result.names.sort(), [".", "..", "denied-child", "hidden-sibling", "policy.snapshot", "visible-alias"].sort());
        assert.deepEqual(result.denials, []);
        assert.equal(await readFile(path.join(directory, "hidden", "secret"), "utf8"), "secret");
        const denied = await probe(directory, [policy(directory, PolicyResponse.DENIED)], "names", directory);
        assert.equal(denied.result, -errno.EACCES);
        assertDenied(denied, directory, NativeFilesystemAccess.READ);
        assert.deepEqual(denied.names, []);
    });
});

const hiddenOperations: readonly (readonly string[])[] = [
    ["getattr", "path"], ["readlink", "64"], ["access", "0"], ["statfs"], ["names"],
    ["open", String(constants.O_RDONLY)], ["unlink"], ["rmdir"], ["listxattr", "256"], ["removexattr"],
];

for (const [operation, ...args] of hiddenOperations) {
    test(`${operation} hides lexical and symlink-resolved hidden paths without denial events`, async () => {
        await withFixture(async (directory) => {
            const hidden = path.join(directory, "hidden");
            const alias = path.join(directory, "alias");
            await mkdir(hidden);
            await writeFile(path.join(hidden, "secret"), "retained secret");
            await symlink("hidden", alias);
            const original = await stat(hidden);
            for (const target of [hidden, path.join(hidden, "secret"), alias, path.join(alias, "secret")]) {
                const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], operation!, target, ...args);
                // getattr/readlink address the alias node itself; other callbacks
                // resolve its target. The hidden child is blocked in either case.
                const aliasMetadata = target === alias && (operation === "getattr" || operation === "readlink");
                assert.equal(result.result, aliasMetadata ? 0 : -errno.ENOENT);
                assert.deepEqual(result.denials, []);
            }
            assert.equal((await stat(hidden)).ino, original.ino);
            assert.equal(await readFile(path.join(hidden, "secret"), "utf8"), "retained secret");
            assert.equal(await readlink(alias), "hidden");
        });
    });
}

for (const [operation, ...args] of [["mkdir"], ["mknod", "regular"], ["symlink", "target"]]) {
    test(`${operation} cannot create new nodes inside the hidden subtree or a resolved alias`, async () => {
        await withFixture(async (directory) => {
            await mkdir(path.join(directory, "hidden"));
            await symlink("hidden", path.join(directory, "alias"));
            for (const parent of ["hidden", "alias"]) {
                const target = path.join(directory, parent, "new");
                const result = await probe(directory, [policy(directory)], operation!, target, ...args);
                assert.equal(result.result, -errno.ENOENT);
                assert.deepEqual(result.denials, []);
                await assertMissing(target);
            }
            assert.deepEqual(await readdir(path.join(directory, "hidden")), []);
        });
    });
}

for (const malformed of ["dotdot", "double-slash", "dot"]) {
    test(`invalid lexical ${malformed} paths fail before authorization or backing mutation`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            await writeFile(target, "original");
            const original = await stat(target);
            const invalid = malformed === "dotdot" ? `${directory}/../${path.basename(directory)}/file`
                : malformed === "dot" ? `${directory}/./file` : `${directory}//file`;
            for (const [operation, ...args] of [
                ["getattr", "path"], ["readlink", "64"], ["access", "0"], ["statfs"], ["names"],
                ["open", String(constants.O_RDONLY)], ["mkdir"], ["mknod", "regular"], ["unlink"], ["rmdir"],
                ["symlink", "relative"], ["listxattr", "256"], ["removexattr"],
            ]) {
                const result = await probe(directory, [policy(directory, PolicyResponse.DENIED, PolicyResponse.DENIED)], operation!, invalid, ...args);
                assert.equal(result.result, -errno.EPERM, operation);
                assert.deepEqual(result.denials, [], operation);
            }
            assert.equal(await readFile(target, "utf8"), "original");
            assert.equal((await stat(target)).ino, original.ino);
            assert.deepEqual((await readdir(directory)).sort(), ["file", "policy.snapshot"]);
        });
    });
}

for (const conflicting of [false, true]) {
    test(`same-revision base snapshot replacement ${conflicting ? "fails closed and stays latched after restoration" : "accepts identical policy content"}`, async () => {
        await withFixture(async (directory) => {
            const target = path.join(directory, "file");
            const replacement = path.join(directory, "replacement.snapshot");
            const restored = path.join(directory, "restored.snapshot");
            await writeFile(target, "original");
            const policies = [policy(directory)];
            const snapshot = (entries: Policy[]): NativeFilesystemPolicySnapshot => ({
                revision: 1,
                layers: [{policies: entries, resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY}],
            });
            await writeFile(replacement, encodeNativeFilesystemPolicySnapshot(snapshot(conflicting
                ? [policy(directory), policy(target, PolicyResponse.DENIED, PolicyResponse.DENIED)] : policies)));
            await writeFile(restored, encodeNativeFilesystemPolicySnapshot(snapshot(policies)));
            const result = await probe(directory, policies, "base-replace", target, replacement, restored);
            assert.equal(result.result, conflicting ? -errno.EACCES : 0);
            assert.equal(result.restoredResult, conflicting ? -errno.EACCES : 0);
            assert.equal(result.handleAssigned, !conflicting);
            // Conflicting protocol state is not a policy decision and must not emit
            // a normal denial event or recover just because an allow file returns.
            assert.deepEqual(result.denials, []);
            assert.equal(await readFile(target, "utf8"), "original");
        });
    });
}

function policy(pattern: string, read = PolicyResponse.ALLOWED, write = PolicyResponse.ALLOWED): Policy {
    return {
        pattern,
        info: {
            [PolicyAccessType.FS_READ]: {accessType: PolicyAccessType.FS_READ, lifetime: PolicyLifetime.SESSION, status: read, reason: "contract fixture"},
            [PolicyAccessType.FS_WRITE]: {accessType: PolicyAccessType.FS_WRITE, lifetime: PolicyLifetime.SESSION, status: write, reason: "contract fixture"},
        },
    };
}

async function withFixture(run: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(path.join("/dev/shm", "pilot-contract-test-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
}

async function assertMissing(target: string): Promise<void> {
    await assert.rejects(lstat(target), {code: "ENOENT"});
}

type ProbeResult = {
    result: number;
    value: string;
    valueHex: string;
    blockSize: number;
    fragmentSize: number;
    blocks: number;
    nameMax: number;
    openResult: number;
    restoredResult: number;
    handleAssigned: boolean;
    position: number;
    flushResult: number;
    dataResult: number;
    nameOnly: boolean;
    names: string[];
    denials: ReturnType<typeof decodeNativeFilesystemPolicyMiss>[];
};

function assertDenied(result: ProbeResult, target: string, access: NativeFilesystemAccess): void {
    assert.equal(result.denials.length, 1);
    const denial = result.denials[0]!;
    assert.equal(denial.path, target);
    assert.equal(denial.access, access);
    assert.equal(denial.requestId, 0n);
    assert.equal(denial.baseRevision, 1n);
    assert.equal(denial.onceRevision, 1n);
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
    // EOF intentionally fails authorization, so keep the controller live until exit.
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
    assert.equal(exitCode, 0, `${args.join(" ")}: ${stderr}`);
    const decoded = decodeNativeFilesystemControlFrames(Buffer.concat(requests));
    assert.equal(decoded.remainder.length, 0);
    assert.ok(decoded.frames.every((frame) => frame.type === NativeFilesystemRequestMessage.DENIAL), "unexpected policy miss");
    return {
        ...JSON.parse(stdout) as Omit<ProbeResult, "denials">,
        denials: decoded.frames.map((frame) => decodeNativeFilesystemPolicyMiss(frame.payload)),
    };
}
