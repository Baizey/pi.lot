import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import test from "node:test";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import type {PolicyDecisionFlow, PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResponse,
} from "../src/policy/types.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";
import type {PolicyApprovalAuditLogInterface} from "../src/policy/PolicyApprovalAuditLog.js";
import {
    decodeNativeFilesystemControlFrames,
    encodeNativeFilesystemPolicySnapshot,
    NativeFilesystemAccess,
    NativeFilesystemDecision,
    NativeFilesystemResponseMessage,
} from "../src/policy/path/native/NativeFilesystemPolicyProtocol.js";
import {NativeFilesystemPolicyBridge} from "../src/policy/path/native/NativeFilesystemPolicyBridge.js";

const AGENT = "native-policy-view-test";
const CHILD_AGENT = "native-policy-view-child";

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

function decisionFlow(choices: PolicyChoice[]): PolicyDecisionFlow {
    let index = 0;
    return {
        async askForPolicy(): Promise<PolicyChoice> {
            const choice = choices[index++];
            assert.ok(choice, "Unexpected policy decision request");
            return choice;
        },
    } as unknown as PolicyDecisionFlow;
}

function choice(target: string, lifetime: PolicyLifetime): PolicyChoice {
    return {
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime,
        status: PolicyResponse.ALLOWED,
        reason: "native policy view test",
    };
}

test("a native tool-call view starts with the root filesystem fallback snapshot", () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});

    const baseSnapshot = view.baseSnapshot();
    const onceSnapshot = view.onceSnapshot();
    assert.equal(baseSnapshot.revision, 0);
    assert.equal(baseSnapshot.layers.length, 2);
    assert.deepEqual(baseSnapshot.layers[0]!.policies, []);
    assert.equal(baseSnapshot.layers[1]!.policies.length, 1);
    assert.equal(
        baseSnapshot.layers[1]!.policies[0]!.info[PolicyAccessType.FS_READ]?.status,
        PolicyResponse.ALLOWED,
    );
    assert.equal(onceSnapshot.revision, 0);
    assert.deepEqual(onceSnapshot.layers[0]!.policies, []);

    view.close();
    assert.throws(() => view.baseSnapshot(), /closed/);
});

test("native snapshots have a bounded length-prefixed binary representation", () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});

    const encoded = encodeNativeFilesystemPolicySnapshot(view.baseSnapshot());

    assert.equal(encoded.subarray(0, 8).toString("ascii"), "PILOTNP2");
    assert.equal(encoded.readBigUInt64LE(8), 0n);
    assert.equal(encoded.readUInt32LE(16), 1);
    assert.equal(encoded.readUInt32LE(20), 1);
    assert.equal(encoded.readUInt8(24), NativeFilesystemAccess.READ);
    assert.equal(encoded.readUInt8(25), NativeFilesystemDecision.ALLOW);
    const pathLength = encoded.readUInt32LE(28);
    assert.equal(encoded.subarray(32, 32 + pathLength).toString("utf8"), "/");
    assert.equal(encoded.length, 32 + pathLength);
    view.close();
});

test("an ONCE decision is returned as an updated tool-call snapshot", async () => {
    const target = path.join(os.tmpdir(), "native-policy-once.txt");
    const runtime = new PolicyRuntime(
        AGENT,
        emptyPolicyDao(),
        decisionFlow([choice(target, PolicyLifetime.ONCE)]),
    );
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});

    const evaluation = await view.evaluate(target, PolicyAccessType.FS_WRITE);

    assert.equal(evaluation.result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(evaluation.baseRevision, 0);
    assert.equal(evaluation.onceSnapshot.revision, 1);
    assert.equal(evaluation.onceSnapshot.layers[0]!.policies.length, 1);
    assert.equal(evaluation.onceSnapshot.layers[0]!.policies[0]!.pattern, target);
    view.close();
});

test("an ONCE change outside miss handling is published to an attached bridge", async () => {
    const target = path.join(os.tmpdir(), "native-policy-external-once.txt");
    const runtime = new PolicyRuntime(
        AGENT,
        emptyPolicyDao(),
        decisionFlow([choice(target, PolicyLifetime.ONCE)]),
    );
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => assert.fail(error.message),
    );
    const framesPromise = waitForControlFrames(responses, 2);

    await bridge.synchronizeSnapshot();
    await view.evaluate(target, PolicyAccessType.FS_WRITE);
    const frames = await framesPromise;

    assert.equal(frames[0]!.type, NativeFilesystemResponseMessage.ONCE_SNAPSHOT);
    assert.equal(frames[0]!.payload.readBigUInt64LE(8), 0n);
    assert.equal(frames[1]!.type, NativeFilesystemResponseMessage.ONCE_SNAPSHOT);
    assert.equal(frames[1]!.payload.readBigUInt64LE(8), 1n);
    bridge.close();
    view.close();
    requests.destroy();
    responses.destroy();
});

test("a native miss is resolved by PolicyRuntime and returns a refreshed snapshot first", async () => {
    const target = path.join(os.tmpdir(), "native-policy-bridge.txt");
    const runtime = new PolicyRuntime(
        AGENT,
        emptyPolicyDao(),
        decisionFlow([choice(target, PolicyLifetime.ONCE)]),
    );
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    let bridgeError: Error | undefined;
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => {
            bridgeError = error;
        },
    );
    const response = waitForControlFrames(responses, 2);

    requests.write(encodePolicyMiss(7n, 0n, 0n, NativeFilesystemAccess.WRITE, target));
    const frames = await response;

    assert.equal(bridgeError, undefined);
    assert.equal(frames[0]!.type, NativeFilesystemResponseMessage.ONCE_SNAPSHOT);
    assert.equal(frames[0]!.payload.subarray(0, 8).toString("ascii"), "PILOTNP2");
    assert.equal(frames[0]!.payload.readBigUInt64LE(8), 1n);
    assert.equal(frames[1]!.type, NativeFilesystemResponseMessage.RESOLUTION);
    assert.equal(frames[1]!.payload.readBigUInt64LE(0), 7n);
    assert.equal(frames[1]!.payload.readBigUInt64LE(8), 0n);
    assert.equal(frames[1]!.payload.readBigUInt64LE(16), 1n);
    assert.equal(frames[1]!.payload.readUInt8(24), NativeFilesystemDecision.ALLOW);
    assert.equal(view.onceSnapshot().layers[0]!.policies[0]!.pattern, target);
    bridge.close();
    view.close();
    requests.destroy();
    responses.destroy();
});

test("native readiness reports the snapshots actually applied by the daemon", async () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    let applied: [bigint, bigint] | undefined;
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => assert.fail(error.message),
        undefined,
        undefined,
        (baseRevision, onceRevision) => {
            applied = [baseRevision, onceRevision];
        },
    );
    const payload = Buffer.alloc(16);
    const ready = Buffer.alloc(24);
    ready.writeUInt32LE(4, 0);
    ready.writeUInt32LE(payload.length, 4);
    payload.copy(ready, 8);

    await bridge.synchronizeSnapshot();
    requests.write(ready);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(applied, [0n, 0n]);
    bridge.close();
    view.close();
    requests.destroy();
    responses.destroy();
});

test("a known native denial renders the standard policy denial message", async () => {
    const target = path.join(os.tmpdir(), "native-policy-denial.txt");
    let auditRecords = 0;
    const audit = {
        append() {
            auditRecords++;
        },
    } satisfies PolicyApprovalAuditLogInterface;
    const runtime = new PolicyRuntime(
        AGENT,
        emptyPolicyDao(),
        decisionFlow([]),
        undefined,
        undefined,
        audit,
    );
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.deny);
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    let resolveDenial!: (message: string) => void;
    const denial = new Promise<string>((resolve) => {
        resolveDenial = resolve;
    });
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => assert.fail(error.message),
        undefined,
        resolveDenial,
    );

    requests.write(encodePolicyEvent(2, 0n, 1n, 0n, NativeFilesystemAccess.READ, target));
    const message = await Promise.race([
        denial,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("denial timed out")), 2_000)),
    ]);

    assert.match(message, /^ACCESS DENIED/);
    assert.match(message, /FS_READ/);
    assert.match(message, /Policy resolution source: SYSTEM/);
    assert.equal(auditRecords, 0);
    bridge.close();
    view.close();
    requests.destroy();
    responses.destroy();
});

test("a stale native denial revision never receives current-policy attribution", async () => {
    const target = path.join(os.tmpdir(), "native-policy-stale-denial.txt");
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.deny);
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    let resolveDenial!: (message: string) => void;
    const denial = new Promise<string>((resolve) => {
        resolveDenial = resolve;
    });
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => assert.fail(error.message),
        undefined,
        resolveDenial,
    );

    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.allow);
    requests.write(encodePolicyEvent(2, 0n, 1n, 0n, NativeFilesystemAccess.READ, target));
    const message = await Promise.race([
        denial,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("denial timed out")), 2_000)),
    ]);

    assert.match(message, /native filesystem policy state denied/);
    assert.doesNotMatch(message, /Policy resolution source: SYSTEM/);
    bridge.close();
    view.close();
    requests.destroy();
    responses.destroy();
});

test("throwing native bridge reporters cannot strand policy control", async () => {
    const target = path.join(os.tmpdir(), "native-policy-throwing-reporters.txt");
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.deny);
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        () => {
            throw new Error("throwing error reporter");
        },
        undefined,
        () => {
            throw new Error("throwing denial reporter");
        },
    );

    requests.write(encodePolicyEvent(2, 0n, 1n, 0n, NativeFilesystemAccess.READ, target));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.destroyed, false);

    const malformed = Buffer.alloc(8);
    malformed.writeUInt32LE(99, 0);
    requests.write(malformed);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.destroyed, true);
    assert.equal(responses.destroyed, true);

    bridge.close();
    view.close();
});

test("closing a native tool view immediately closes its policy channel", async () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    let reported: Error | undefined;
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => {
            reported = error;
        },
    );

    view.close();
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(reported?.message ?? "", /view closed/);
    assert.equal(requests.destroyed, true);
    assert.equal(responses.destroyed, true);
    bridge.close();
});

test("a partial native request frame times out fail closed", async () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const requests = new PassThrough();
    const responses = new PassThrough();
    let reported: Error | undefined;
    const bridge = new NativeFilesystemPolicyBridge(
        view,
        requests,
        responses,
        (error) => {
            reported = error;
        },
    );

    requests.write(Buffer.alloc(4));
    await new Promise((resolve) => setTimeout(resolve, 5_100));

    assert.match(reported?.message ?? "", /timed out/);
    assert.equal(requests.destroyed, true);
    assert.equal(responses.destroyed, true);
    bridge.close();
    view.close();
});

test("native base policy publication is shared by an agent's active tool calls", () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const first = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const second = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const published: number[] = [];
    first.policyBase.onSnapshotChanged((snapshot) => published.push(snapshot.revision));

    assert.equal(first.policyBase, second.policyBase);
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);
    assert.deepEqual(published, [1]);
    assert.equal(second.baseSnapshot().revision, 1);
    assert.equal(first.onceSnapshot().revision, 0);
    assert.equal(second.onceSnapshot().revision, 0);

    first.close();
    second.close();
});

test("subagents receive a distinct shared base checkpoint", () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    runtime.registerPolicyPrincipal(CHILD_AGENT, AGENT, [PolicyArea.fs_read]);
    const root = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "root"});
    const firstChild = runtime.beginNativeFilesystemToolCall(CHILD_AGENT, {toolName: "child-one"});
    const secondChild = runtime.beginNativeFilesystemToolCall(CHILD_AGENT, {toolName: "child-two"});

    assert.notEqual(root.policyBase, firstChild.policyBase);
    assert.equal(firstChild.policyBase, secondChild.policyBase);

    root.close();
    firstChild.close();
    secondChild.close();
    runtime.removePolicyPrincipal(CHILD_AGENT);
});

test("tool calls sharing a base retain private ONCE overlays", async () => {
    const target = path.join(os.tmpdir(), "native-policy-private-once.txt");
    const runtime = new PolicyRuntime(
        AGENT,
        emptyPolicyDao(),
        decisionFlow([
            {...choice(target, PolicyLifetime.ONCE), status: PolicyResponse.DENIED},
            choice(target, PolicyLifetime.ONCE),
        ]),
    );
    const denied = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "denied"});
    const allowed = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "allowed"});

    await denied.evaluate(target, PolicyAccessType.FS_WRITE);
    await allowed.evaluate(target, PolicyAccessType.FS_WRITE);

    assert.equal(denied.policyBase, allowed.policyBase);
    assert.equal(
        denied.onceSnapshot().layers[0]!.policies[0]!.info[PolicyAccessType.FS_WRITE]?.status,
        PolicyResponse.DENIED,
    );
    assert.equal(
        allowed.onceSnapshot().layers[0]!.policies[0]!.info[PolicyAccessType.FS_WRITE]?.status,
        PolicyResponse.ALLOWED,
    );
    denied.close();
    allowed.close();
});

test("session policy changes refresh every active native tool-call view", async () => {
    const target = path.join(os.tmpdir(), "native-policy-session.txt");
    const runtime = new PolicyRuntime(
        AGENT,
        emptyPolicyDao(),
        decisionFlow([choice(target, PolicyLifetime.SESSION)]),
    );
    const decidingView = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const observingView = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const updates: number[] = [];
    observingView.policyBase.onSnapshotChanged((snapshot) => updates.push(snapshot.revision));

    const evaluation = await decidingView.evaluate(target, PolicyAccessType.FS_WRITE);

    assert.deepEqual(updates, [1]);
    assert.equal(evaluation.onceSnapshot.revision, 0);
    const policy = observingView.baseSnapshot().layers[0]!.policies.find((candidate) => candidate.pattern === target);
    assert.equal(policy?.info[PolicyAccessType.FS_WRITE]?.status, PolicyResponse.ALLOWED);
    decidingView.close();
    observingView.close();
});

test("network-only fallback changes do not republish filesystem base state", () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    const revision = view.baseRevision;

    runtime.setDefaultResponse(PolicyArea.web_read, PolicyFallbackResponse.allow);

    assert.equal(view.baseRevision, revision);
    view.close();
});

test("automated fallback updates are projected to active native views", () => {
    const runtime = new PolicyRuntime(AGENT, emptyPolicyDao(), decisionFlow([]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "bash"});
    let latestStatus: PolicyResponse | undefined;
    view.policyBase.onSnapshotChanged((snapshot) => {
        latestStatus = snapshot.layers[1]!.policies[0]?.info[PolicyAccessType.FS_WRITE]?.status;
    });

    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);

    assert.equal(latestStatus, PolicyResponse.ALLOWED);
    view.close();
});

function encodePolicyMiss(
    requestId: bigint,
    baseRevision: bigint,
    onceRevision: bigint,
    access: NativeFilesystemAccess,
    target: string,
): Buffer {
    return encodePolicyEvent(1, requestId, baseRevision, onceRevision, access, target);
}

function encodePolicyEvent(
    messageType: number,
    requestId: bigint,
    baseRevision: bigint,
    onceRevision: bigint,
    access: NativeFilesystemAccess,
    target: string,
): Buffer {
    const pathBytes = Buffer.from(target, "utf8");
    const payload = Buffer.alloc(32 + pathBytes.length);
    payload.writeBigUInt64LE(requestId, 0);
    payload.writeBigUInt64LE(baseRevision, 8);
    payload.writeBigUInt64LE(onceRevision, 16);
    payload.writeUInt8(access, 24);
    payload.writeUInt32LE(pathBytes.length, 28);
    pathBytes.copy(payload, 32);
    const message = Buffer.alloc(8 + payload.length);
    message.writeUInt32LE(messageType, 0);
    message.writeUInt32LE(payload.length, 4);
    payload.copy(message, 8);
    return message;
}

function waitForControlFrames(
    stream: PassThrough,
    count: number,
): Promise<ReturnType<typeof decodeNativeFilesystemControlFrames>["frames"]> {
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for native filesystem control frames"));
        }, 5_000);
        const onData = (chunk: Buffer) => {
            bytes = Buffer.concat([bytes, chunk]);
            try {
                const decoded = decodeNativeFilesystemControlFrames(bytes);
                if (decoded.frames.length < count) return;
                cleanup();
                resolve(decoded.frames);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        const cleanup = () => {
            clearTimeout(timeout);
            stream.off("data", onData);
        };
        stream.on("data", onData);
    });
}
