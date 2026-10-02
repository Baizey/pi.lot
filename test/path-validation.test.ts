import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {PolicyEngine} from "../src/policy/PolicyEngine.js";
import {resolvePhysicalPath} from "../src/policy/path/validation.js";
import {encodeNativeFilesystemPolicySnapshot} from "../src/policy/path/native/NativeFilesystemPolicyProtocol.js";
import {PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse} from "../src/policy/types.js";
import {resolveNativeExecutable} from "../src/runtime/NativeExecutable.js";

test("physical Linux paths preserve trailing backslashes in existing and missing names", (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-path-backslash-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const physicalDirectory = realpathSync.native(directory);
    const file = path.join(directory, "secret\\");
    writeFileSync(file, "fixture");
    const childDirectory = path.join(directory, "parent\\");
    mkdirSync(childDirectory);

    assert.equal(resolvePhysicalPath(file), path.join(physicalDirectory, "secret\\"));
    assert.equal(resolvePhysicalPath(path.join(directory, "missing\\")), path.join(physicalDirectory, "missing\\"));
    assert.equal(resolvePhysicalPath(`${childDirectory}/`), path.join(physicalDirectory, "parent\\"));
    assert.equal(resolvePhysicalPath(path.join(childDirectory, "missing\\")), path.join(physicalDirectory, "parent\\", "missing\\"));
    assert.equal(resolvePhysicalPath("/"), "/");
});

test("physical symlink resolution preserves a backslash in the target name", (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-path-backslash-symlink-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const target = path.join(directory, "target\\");
    const alias = path.join(directory, "alias");
    mkdirSync(target);
    symlinkSync(path.basename(target), alias);

    assert.equal(resolvePhysicalPath(alias), realpathSync.native(target));
    assert.equal(resolvePhysicalPath(path.join(alias, "missing\\")), path.join(realpathSync.native(target), "missing\\"));
});

test("TypeScript and native policy agree on denies for Linux backslash filenames", (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-native-path-backslash-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const target = path.join(directory, "secret\\");
    const sibling = path.join(directory, "secret");
    writeFileSync(target, "denied fixture");
    writeFileSync(sibling, "allowed sibling");
    const policy = (pattern: string, status: PolicyResponse) => ({
        pattern,
        info: {
            [PolicyAccessType.FS_READ]: {
                accessType: PolicyAccessType.FS_READ,
                lifetime: PolicyLifetime.SESSION,
                status,
                reason: "backslash parity fixture",
            },
        },
    });
    const engine = new PolicyEngine([
        policy(directory, PolicyResponse.ALLOWED),
        policy(target, PolicyResponse.DENIED),
    ]);
    const snapshotPath = path.join(directory, "policy.snapshot");
    writeFileSync(snapshotPath, encodeNativeFilesystemPolicySnapshot({
        revision: 1,
        layers: [{policies: engine.allPolicies(), resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY}],
    }));

    for (const [filename, denied] of [[target, true], [sibling, false]] as const) {
        assert.equal(engine.evaluate(filename, PolicyAccessType.FS_READ)?.matchedStatus,
            denied ? PolicyResponse.DENIED : PolicyResponse.ALLOWED);
        const result = spawnSync(resolveNativeExecutable("pi-fuse-native"), [
            "--check-policy-protocol", snapshotPath, "3", "4", realpathSync.native(filename),
        ], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], timeout: 2_000});
        assert.ifError(result.error);
        assert.equal(result.status, denied ? 2 : 0, result.stderr);
        assert.match(result.stdout, denied ? /"decision":"deny"/ : /"decision":"allow"/);
    }
});
