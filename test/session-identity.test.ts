import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {
    getSessionRootId, isNativeSessionId, recordChildSessionIdentity, recordMainSessionIdentity,
    SessionIdentity, SessionKind,
} from "../src/sessions/SessionIdentity.js";
import {decodeArchiveMetadata} from "../src/server/ArchiveProtocol.js";
import {createNativeExtensionApi} from "./fixtures/NativeExtensionApi.js";

const ROOT = "original-main";

test("main identity writer round-trips through native storage and is idempotent on resume", async (t) => {
    const f = await fixture(t);
    const manager = f.create(ROOT);
    recordMainSessionIdentity(f.writer(manager), manager);
    const resumed = f.persist(manager);
    assert.deepEqual(records(resumed), [{customType: "pilot.archive", data: {
        version: 1, sessionId: ROOT, kind: SessionKind.Main, rootSessionId: ROOT,
    }}]);
    assert.deepEqual(SessionIdentity.fromManager(resumed).identity, {kind: SessionKind.Main, rootSessionId: ROOT});
    assert.equal(getSessionRootId(resumed), ROOT);
    recordMainSessionIdentity(f.writer(resumed), resumed);
    assert.equal(records(resumed).length, 1);
});

for (const kind of [SessionKind.Subagent, SessionKind.PolicyApprover] as const) {
    for (const rootSessionId of [ROOT, undefined]) {
        test(`${kind} writer-reader round trip with root=${rootSessionId ?? "unknown"}`, async (t) => {
            const f = await fixture(t);
            // Creation intent overrides misleading legacy prefixes.
            const id = kind === SessionKind.Subagent ? "policy-approver-ordinary-child" : "explicit-reviewer";
            const manager = f.create(id);
            recordChildSessionIdentity(manager, {parentAgentIdentifier: "immediate-parent", rootSessionId, kind});
            const resumed = f.persist(manager);
            const data = {version: 1, sessionId: id, parentAgentIdentifier: "immediate-parent",
                ...(rootSessionId === undefined ? {} : {rootSessionId}), kind};
            assert.deepEqual(records(resumed), [{customType: "pilot.subagent", data}]);
            const identity = SessionIdentity.fromManager(resumed);
            assert.equal(identity.sessionId, id);
            assert.equal(identity.childKind, kind);
            assert.equal(identity.parentAgentIdentifier, "immediate-parent");
            assert.equal(identity.rootSessionId, rootSessionId);
            assert.equal(identity.identityConflict, undefined);
            assert.equal(getSessionRootId(resumed), rootSessionId);
            recordMainSessionIdentity(f.writer(resumed), resumed);
            assert.equal(records(resumed).length, 1, "unknown ancestry must not relabel a child as main");
            if (rootSessionId === undefined) {
                assert.throws(() => decodeArchiveMetadata({kind}, id), /Invalid archive protocol/,
                    "publishable classification remains stricter than native child identity");
            }
        });
    }
}

test("child writing defaults to ordinary delegation, retaining an absent root in memory", () => {
    const manager = SessionManager.inMemory("/", {id: "policy-approver-not-a-reviewer"});
    recordChildSessionIdentity(manager, {parentAgentIdentifier: ROOT});
    assert.deepEqual(records(manager), [{customType: "pilot.subagent", data: {
        version: 1, sessionId: manager.getSessionId(), parentAgentIdentifier: ROOT,
        rootSessionId: undefined, kind: SessionKind.Subagent,
    }}]);
    assert.equal(SessionIdentity.fromManager(manager).childKind, SessionKind.Subagent);
    assert.equal(getSessionRootId(manager), undefined);
});

for (const kind of [SessionKind.Main, SessionKind.Subagent, SessionKind.PolicyApprover] as const) {
    test(`native forks ignore copied ${kind} writer records before recording their own main identity`, async (t) => {
        const f = await fixture(t);
        const original = f.create("original-session");
        if (kind === SessionKind.Main) recordMainSessionIdentity(f.writer(original), original);
        else recordChildSessionIdentity(original, {parentAgentIdentifier: ROOT, rootSessionId: ROOT, kind});
        f.persist(original);
        const fork = SessionManager.forkFrom(original.getSessionFile()!, f.directory, f.directory, {id: "fork-session"});
        assert.equal(fork.getHeader()?.parentSession, original.getSessionFile());
        assert.deepEqual(records(fork), records(original));
        assert.equal(SessionIdentity.fromManager(fork).identity, undefined);
        assert.equal(SessionIdentity.fromManager(fork).childKind, undefined);
        assert.equal(getSessionRootId(fork), "fork-session");
        recordMainSessionIdentity(f.writer(fork), fork);
        const resumed = SessionManager.open(fork.getSessionFile()!);
        assert.deepEqual(SessionIdentity.fromManager(resumed).identity, {
            kind: SessionKind.Main, rootSessionId: "fork-session",
        });
        assert.equal(getSessionRootId(resumed), "fork-session");
    });
}

test("conflicting writer records remain unresolved, including after another matching record", async (t) => {
    const f = await fixture(t);
    let index = 0;
    for (const conflict of [
        {parentAgentIdentifier: "other-parent", rootSessionId: ROOT, kind: SessionKind.Subagent},
        {parentAgentIdentifier: ROOT, rootSessionId: "other-root", kind: SessionKind.Subagent},
        {parentAgentIdentifier: ROOT, rootSessionId: ROOT, kind: SessionKind.PolicyApprover},
        {parentAgentIdentifier: ROOT, kind: SessionKind.Subagent},
    ] as const) {
        const manager = f.create(`child-${index++}`);
        const child = {parentAgentIdentifier: ROOT, rootSessionId: ROOT, kind: SessionKind.Subagent} as const;
        recordChildSessionIdentity(manager, child);
        recordChildSessionIdentity(manager, conflict);
        recordChildSessionIdentity(manager, child);
        const resumed = f.persist(manager);
        assert.equal(SessionIdentity.fromManager(resumed).identityConflict, true);
        assert.equal(getSessionRootId(resumed), undefined);
        recordMainSessionIdentity(f.writer(resumed), resumed);
        assert.equal(records(resumed).length, 3);
    }
    const main = f.create("main-child-conflict");
    recordMainSessionIdentity(f.writer(main), main);
    recordChildSessionIdentity(main, {parentAgentIdentifier: ROOT, rootSessionId: ROOT});
    assert.equal(getSessionRootId(f.persist(main)), undefined);
});

test("legacy records are limited to known child prefixes and conflicting parents remain unknown", () => {
    for (const id of ["ordinary-session", "subagent-legacy", "policy-approver-legacy"]) {
        const manager = SessionManager.inMemory("/", {id});
        manager.appendCustomEntry("pilot.subagent", {parentAgentIdentifier: ROOT});
        const identity = SessionIdentity.fromManager(manager);
        assert.equal(identity.parentAgentIdentifier, id === "ordinary-session" ? undefined : ROOT);
        assert.equal(getSessionRootId(manager), id === "ordinary-session" ? id : undefined);
        manager.appendCustomEntry("pilot.subagent", {parentAgentIdentifier: "different-parent"});
        assert.equal(SessionIdentity.fromManager(manager).identityConflict, id === "ordinary-session" ? undefined : true);
    }
});

test("identity interpretation keeps existing tolerant-record and invalid-bound-record rules", () => {
    const manager = SessionManager.inMemory("/", {id: "child"});
    for (const data of [null, [], "not-an-object", {sessionId: "copied-id", version: 99}]) {
        manager.appendCustomEntry("pilot.subagent", data);
    }
    manager.appendCustomEntry("unrelated-extension", {sessionId: "child", kind: "unknown"});
    assert.equal(getSessionRootId(manager), "child");
    manager.appendCustomEntry("pilot.subagent", {sessionId: "child", version: 99});
    recordChildSessionIdentity(manager, {parentAgentIdentifier: ROOT, rootSessionId: ROOT});
    assert.equal(SessionIdentity.fromManager(manager).identityConflict, true);
    assert.equal(getSessionRootId(manager), undefined);
});

test("native ID validation retains UTF-8, length, and control-character boundaries", () => {
    for (const id of ["root", "a".repeat(512), "é".repeat(256), " "]) assert.equal(isNativeSessionId(id), true);
    for (const id of [undefined, null, 1, "", "a".repeat(513), "é".repeat(257), "a\n", "a\u0080", "\ud800"]) {
        assert.equal(isNativeSessionId(id), false);
    }
});

function records(manager: SessionManager) {
    return manager.getEntries().filter((entry) => entry.type === "custom")
        .map((entry) => ({customType: entry.customType, data: entry.data}));
}

async function fixture(t: TestContext) {
    const pi = await createNativeExtensionApi();
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-session-identity-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    return {
        directory,
        create(id: string) { return SessionManager.create(directory, directory, {id}); },
        writer(manager: SessionManager) {
            t.mock.method(pi, "appendEntry", (customType: string, data: unknown) => { manager.appendCustomEntry(customType, data); });
            return pi;
        },
        persist(manager: SessionManager) {
            manager.appendMessage({role: "user", content: "persist identity", timestamp: Date.now()});
            return SessionManager.open(manager.getSessionFile()!);
        },
    };
}
