import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {Writable} from "node:stream";
import test from "node:test";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import type {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import {
    decodeNativeFilesystemControlFrames,
    decodeNativeFilesystemPolicyMiss,
    encodeNativeFilesystemPolicySnapshot,
    encodeNativeFilesystemOnceSnapshotMessage,
    encodeNativeFilesystemResolutionMessage,
    NativeFilesystemDecision,
} from "../src/policy/path/native/NativeFilesystemPolicyProtocol.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResponse,
} from "../src/policy/types.js";
import {resolveNativeExecutable} from "../src/runtime/NativeExecutable.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";

const AGENT = "native-fuse-protocol-test";
const TARGET = "/tmp/native-fuse-protocol-target";

function emptyPolicyDao(): PolicyDaoInterface {
    return {
        initializeSchema() {
        },
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
    };
}

function unresolvedPolicyView() {
    const flow = {
        askForPolicy: () => new Promise(() => undefined),
    } as unknown as PolicyDecisionFlow;
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), flow);
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.ask_user);
    return runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-protocol-test"});
}

test("native FUSE rejects version-one combined snapshots", async () => {
    const view = unresolvedPolicyView();
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-native-protocol-version-test-"));
    const snapshotPath = path.join(directory, "policy.snapshot");
    const obsolete = encodeNativeFilesystemPolicySnapshot(view.baseSnapshot());
    obsolete.write("PILOTNP1", 0, "ascii");
    await writeFile(snapshotPath, obsolete);
    const child = spawn(resolveNativeExecutable("pi-fuse-native"), [
        "--check-policy-protocol",
        snapshotPath,
        "3",
        "4",
        TARGET,
    ], {stdio: ["ignore", "pipe", "pipe", "ignore", "ignore"]});
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });

    view.close();
    await rm(directory, {recursive: true, force: true});
    assert.equal(exitCode, 64);
});

test("native FUSE fails closed when its policy controller disconnects", async () => {
    const result = await runProtocolCheck((_request, responses) => responses.end());

    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"decision":"deny"/);
});

test("native FUSE fails closed on a malformed policy response", async () => {
    const malformed = Buffer.alloc(8);
    malformed.writeUInt32LE(99, 0);
    malformed.writeUInt32LE(0, 4);
    const result = await runProtocolCheck((_request, responses) => responses.end(malformed));

    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"decision":"deny"/);
});

test("native FUSE bounds waits for a truncated control frame", async () => {
    const started = Date.now();
    const result = await runProtocolCheck((_request, responses) => {
        const truncated = Buffer.alloc(9);
        truncated.writeUInt32LE(3, 0);
        truncated.writeUInt32LE(25, 4);
        responses.write(truncated);
    });

    assert.equal(result.exitCode, 2);
    assert.ok(Date.now() - started < 7_000, "truncated frame should fail before the process timeout");
    assert.match(result.stdout, /"decision":"deny"/);
});

test("native FUSE rejects a resolution whose refreshed snapshot remains unresolved", async () => {
    const result = await runProtocolCheck((request, responses, initialSnapshot) => {
        const miss = decodeNativeFilesystemPolicyMiss(request);
        responses.write(encodeNativeFilesystemOnceSnapshotMessage(initialSnapshot));
        responses.end(encodeNativeFilesystemResolutionMessage(
            miss.requestId,
            Number(miss.baseRevision),
            initialSnapshot.revision,
            NativeFilesystemDecision.ALLOW,
        ));
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"decision":"deny"/);
});

test("native FUSE fails closed on an ONCE snapshot rollback", async () => {
    const result = await runProtocolCheck((request, responses, initialSnapshot) => {
        const miss = decodeNativeFilesystemPolicyMiss(request);
        const newer = structuredClone(initialSnapshot);
        newer.revision = 2;
        newer.layers[0]!.policies.push({
            pattern: TARGET,
            info: {
                [PolicyAccessType.FS_READ]: {
                    accessType: PolicyAccessType.FS_READ,
                    lifetime: PolicyLifetime.ONCE,
                    status: PolicyResponse.ALLOWED,
                    reason: "newer protocol fixture",
                },
            },
        });
        const rollback = structuredClone(initialSnapshot);
        rollback.revision = 1;
        responses.write(encodeNativeFilesystemOnceSnapshotMessage(newer));
        responses.write(encodeNativeFilesystemOnceSnapshotMessage(rollback));
        responses.end(encodeNativeFilesystemResolutionMessage(
            miss.requestId,
            Number(miss.baseRevision),
            newer.revision,
            NativeFilesystemDecision.ALLOW,
        ));
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"decision":"deny"/);
});

test("an explicit native DENY dominates an allowing refreshed snapshot", async () => {
    const result = await runProtocolCheck((request, responses, initialSnapshot) => {
        const miss = decodeNativeFilesystemPolicyMiss(request);
        const allowingSnapshot = structuredClone(initialSnapshot);
        allowingSnapshot.revision++;
        allowingSnapshot.layers[0]!.policies.push({
            pattern: TARGET,
            info: {
                [PolicyAccessType.FS_READ]: {
                    accessType: PolicyAccessType.FS_READ,
                    lifetime: PolicyLifetime.ONCE,
                    status: PolicyResponse.ALLOWED,
                    reason: "contradictory protocol fixture",
                },
            },
        });
        responses.write(encodeNativeFilesystemOnceSnapshotMessage(allowingSnapshot));
        responses.end(encodeNativeFilesystemResolutionMessage(
            miss.requestId,
            Number(miss.baseRevision),
            allowingSnapshot.revision,
            NativeFilesystemDecision.DENY,
        ));
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"decision":"deny"/);
});

function allowingOnceSnapshot(initialSnapshot: ReturnType<ReturnType<typeof unresolvedPolicyView>["onceSnapshot"]>) {
    const snapshot = structuredClone(initialSnapshot);
    snapshot.revision++;
    snapshot.layers[0]!.policies.push({
        pattern: TARGET,
        info: {
            [PolicyAccessType.FS_READ]: {
                accessType: PolicyAccessType.FS_READ,
                lifetime: PolicyLifetime.ONCE,
                status: PolicyResponse.ALLOWED,
                reason: "protocol parity fixture",
            },
        },
    });
    return snapshot;
}

test("native FUSE applies a valid ONCE grant before returning ALLOW", async () => {
    const result = await runProtocolCheck((request, responses, initialSnapshot) => {
        const miss = decodeNativeFilesystemPolicyMiss(request);
        const allowing = allowingOnceSnapshot(initialSnapshot);
        responses.end(Buffer.concat([
            encodeNativeFilesystemOnceSnapshotMessage(allowing),
            encodeNativeFilesystemResolutionMessage(miss.requestId, Number(miss.baseRevision), allowing.revision, NativeFilesystemDecision.ALLOW),
        ]));
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"onceRevision":1,"decision":"allow"/);
});

test("native FUSE accepts identical duplicate ONCE revisions", async () => {
    const result = await runProtocolCheck((request, responses, initialSnapshot) => {
        const miss = decodeNativeFilesystemPolicyMiss(request);
        const allowing = allowingOnceSnapshot(initialSnapshot);
        const update = encodeNativeFilesystemOnceSnapshotMessage(allowing);
        responses.end(Buffer.concat([update, update,
            encodeNativeFilesystemResolutionMessage(miss.requestId, Number(miss.baseRevision), allowing.revision, NativeFilesystemDecision.ALLOW),
        ]));
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"decision":"allow"/);
});

test("native FUSE fails closed on conflicting contents at an equal ONCE revision", async () => {
    const result = await runProtocolCheck((request, responses, initialSnapshot) => {
        const miss = decodeNativeFilesystemPolicyMiss(request);
        const allowing = allowingOnceSnapshot(initialSnapshot);
        const conflicting = structuredClone(allowing);
        conflicting.layers[0]!.policies[0]!.info[PolicyAccessType.FS_READ]!.status = PolicyResponse.DENIED;
        responses.end(Buffer.concat([
            encodeNativeFilesystemOnceSnapshotMessage(allowing),
            encodeNativeFilesystemOnceSnapshotMessage(conflicting),
            encodeNativeFilesystemResolutionMessage(miss.requestId, Number(miss.baseRevision), allowing.revision, NativeFilesystemDecision.ALLOW),
        ]));
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /"decision":"deny"/);
});

for (const invalid of ["request-id", "base-rollback", "base-future", "once-future", "decision", "message-type", "short-payload", "long-payload", "oversized-frame"] as const) {
    test(`native FUSE rejects invalid resolution ${invalid} after a granting snapshot`, async () => {
        const result = await runProtocolCheck((request, responses, initialSnapshot) => {
            const miss = decodeNativeFilesystemPolicyMiss(request);
            const allowing = allowingOnceSnapshot(initialSnapshot);
            let resolution = encodeNativeFilesystemResolutionMessage(miss.requestId, Number(miss.baseRevision), allowing.revision, NativeFilesystemDecision.ALLOW);
            if (invalid === "request-id") resolution.writeBigUInt64LE(miss.requestId + 1n, 8);
            if (invalid === "base-rollback") resolution.writeBigUInt64LE(miss.baseRevision - 1n, 16);
            if (invalid === "base-future") resolution.writeBigUInt64LE(miss.baseRevision + 1n, 16);
            if (invalid === "once-future") resolution.writeBigUInt64LE(BigInt(allowing.revision + 1), 24);
            if (invalid === "decision") resolution[32] = 3;
            if (invalid === "message-type") resolution.writeUInt32LE(99, 0);
            if (invalid === "short-payload") {
                resolution = resolution.subarray(0, 32);
                resolution.writeUInt32LE(24, 4);
            }
            if (invalid === "long-payload") {
                resolution = Buffer.concat([resolution, Buffer.of(0)]);
                resolution.writeUInt32LE(26, 4);
            }
            if (invalid === "oversized-frame") {
                resolution = resolution.subarray(0, 8);
                resolution.writeUInt32LE(16 * 1024 * 1024 + 1, 4);
            }
            responses.end(Buffer.concat([encodeNativeFilesystemOnceSnapshotMessage(allowing), resolution]));
        });
        assert.equal(result.exitCode, 2);
        assert.match(result.stdout, /"decision":"deny"/);
    });
}

async function runProtocolCheck(
    respond: (
        request: Buffer,
        responses: Writable,
        initialSnapshot: ReturnType<ReturnType<typeof unresolvedPolicyView>["onceSnapshot"]>,
    ) => void,
): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
    const view = unresolvedPolicyView();
    const initialSnapshot = view.onceSnapshot();
    const baseSnapshot = view.baseSnapshot();
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-native-protocol-test-"));
    const snapshotPath = path.join(directory, "policy.snapshot");
    await writeFile(snapshotPath, encodeNativeFilesystemPolicySnapshot(baseSnapshot));
    const child = spawn(resolveNativeExecutable("pi-fuse-native"), [
        "--check-policy-protocol",
        snapshotPath,
        "3",
        "4",
        TARGET,
    ], {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const requests = child.stdio[3]!;
    const responses = child.stdio[4] as Writable;
    let responseError: Error | undefined;
    responses.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ECONNRESET") responseError = error;
    });
    let requestBytes = Buffer.alloc(0);
    let responded = false;
    requests.on("data", (chunk: Buffer) => {
        if (responded) return;
        requestBytes = Buffer.concat([requestBytes, chunk]);
        const decoded = decodeNativeFilesystemControlFrames(requestBytes);
        if (decoded.frames.length === 0) return;
        responded = true;
        respond(decoded.frames[0]!.payload, responses, initialSnapshot);
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    clearTimeout(timeout);
    view.close();
    await rm(directory, {recursive: true, force: true});
    if (responseError) throw responseError;
    return {exitCode, stdout, stderr};
}
