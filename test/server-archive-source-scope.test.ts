import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {getAgentDir, SessionManager} from "@earendil-works/pi-coding-agent";
import {ArchiveSessions} from "../src/server/ArchiveSessions.js";
import {decodeArchiveSourceScope} from "../src/server/ArchiveSourceScope.js";
import {captureArchiveSourceScope} from "../src/server/ArchiveSourceScopeCapture.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";

const ROOT = "archive-root";

test("source scope captures resolved local paths, identity and default collection roots as plain JSON", (t) => {
    const f = fixture(t);
    const manager = SessionManager.create(f.directory, path.join(f.directory, "custom"), {id: ROOT});
    manager.appendCustomEntry("pilot.archive", {version: 1, sessionId: ROOT, kind: SessionKind.Main, rootSessionId: ROOT});
    const scope = captureArchiveSourceScope(manager, "all");
    assert.deepEqual(scope, {
        version: 1, scope: "all",
        activeSession: {sessionId: ROOT, main: true, identityConflict: false, rootSessionId: ROOT},
        sessionFile: path.resolve(manager.getSessionFile()!),
        sessionDirectory: path.resolve(manager.getSessionDir()), rootSessionId: ROOT,
        defaultSessionRoots: [path.join(f.directory, "agent", "sessions")],
    });
    assert.deepEqual(decodeArchiveSourceScope(JSON.parse(JSON.stringify(scope))), scope);
    assert.equal(Object.getPrototypeOf(scope), Object.prototype);
    assert.equal(Object.getPrototypeOf(scope.activeSession), Object.prototype);
    assert.ok(!JSON.stringify(scope).includes("getSession"));
});

test("foreground scope factory matches pinned Pi agent-directory path conventions", (t) => {
    const f = fixture(t);
    const manager = SessionManager.inMemory(f.directory, {id: ROOT});
    for (const configured of [undefined, "", "~", "~/archive-test", "relative-agent", `file://${f.directory}/agent`]) {
        if (configured === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = configured;
        assert.deepEqual(captureArchiveSourceScope(manager).defaultSessionRoots, [path.resolve(getAgentDir(), "sessions")]);
    }
});

test("scope retains legacy creation intent and bound child roots, including unresolved/conflicting identity", (t) => {
    const f = fixture(t);
    const manager = SessionManager.inMemory(f.directory, {id: "policy-approver-child"});
    manager.appendCustomEntry("pilot.subagent", {parentAgentIdentifier: ROOT});
    let scope = captureArchiveSourceScope(manager);
    assert.deepEqual(scope.activeSession, {sessionId: "policy-approver-child", main: false, identityConflict: false,
        childKind: SessionKind.PolicyApprover, parentAgentIdentifier: ROOT});
    assert.equal(scope.rootSessionId, undefined);
    assert.equal(scope.sessionFile, undefined);
    manager.appendCustomEntry("pilot.subagent", {version: 1, sessionId: "policy-approver-child", kind: SessionKind.PolicyApprover,
        parentAgentIdentifier: ROOT, rootSessionId: ROOT});
    scope = captureArchiveSourceScope(manager);
    assert.equal(scope.rootSessionId, ROOT);
    assert.equal(scope.activeSession.rootSessionId, ROOT);
    manager.appendCustomEntry("pilot.subagent", {version: 1, sessionId: "policy-approver-child", kind: SessionKind.Subagent,
        parentAgentIdentifier: "other-root", rootSessionId: "other-root"});
    scope = decodeArchiveSourceScope(JSON.parse(JSON.stringify(captureArchiveSourceScope(manager))));
    assert.equal(scope.activeSession.identityConflict, true);
    assert.equal(scope.rootSessionId, undefined);
});

test("source decoding rejects malformed identities, inconsistent roots and unresolved filesystem authority", (t) => {
    const f = fixture(t);
    const scope = captureArchiveSourceScope(SessionManager.inMemory(f.directory, {id: ROOT}));
    const invalid: unknown[] = [
        null, [], {}, {...scope, version: 2}, {...scope, scope: "remote"},
        {...scope, sessionDirectory: "relative"}, {...scope, sessionFile: "relative.jsonl"},
        {...scope, sessionDirectory: path.join(f.directory, "a") + "/../b"},
        {...scope, defaultSessionRoots: []}, {...scope, defaultSessionRoots: new Array(1)},
        {...scope, defaultSessionRoots: ["relative"]},
        {...scope, defaultSessionRoots: [f.directory, 42]}, {...scope, sessionFile: f.directory + "\0secret"},
        {...scope, parentSession: {}}, {...scope, rootSessionId: "wrong-root"},
        {...scope, activeSession: {...scope.activeSession, sessionId: "bad\nID"}},
        {...scope, activeSession: {...scope.activeSession, identityConflict: "false"}},
        {...scope, activeSession: {...scope.activeSession, main: true}},
        {...scope, activeSession: {...scope.activeSession, childKind: "unknown"}},
        {...scope, activeSession: {...scope.activeSession, parentAgentIdentifier: ROOT}},
        {...scope, activeSession: {...scope.activeSession, childKind: SessionKind.Subagent, rootSessionId: ROOT}},
        {...scope, rootSessionId: "other-root",
            activeSession: {...scope.activeSession, childKind: SessionKind.Subagent, rootSessionId: "other-root"}},
        {...scope, activeSession: {...scope.activeSession, identityConflict: true}},
    ];
    for (const value of invalid) assert.throws(() => decodeArchiveSourceScope(value), /Invalid archive source/);
    assert.throws(() => new ArchiveSessions({...scope, sessionDirectory: "relative"}), /Invalid archive source/);
    assert.throws(() => new ArchiveSessions(JSON.parse("null")), /Invalid archive source/);
    // Empty/malformed parent text remains inert ancestry evidence, never file authority.
    for (const parentSession of ["", "\0", "../../unowned/session.jsonl"]) {
        assert.equal(decodeArchiveSourceScope({...scope, parentSession}).parentSession, parentSession);
    }
});

test("decoded scopes copy identity and roots instead of retaining a mutable input graph", (t) => {
    const f = fixture(t);
    const scope = captureArchiveSourceScope(SessionManager.inMemory(f.directory, {id: ROOT}));
    const decoded = decodeArchiveSourceScope(scope);
    scope.activeSession.sessionId = "later-session";
    scope.defaultSessionRoots[0] = path.join(f.directory, "later-agent", "sessions");
    assert.equal(decoded.activeSession.sessionId, ROOT);
    assert.deepEqual(decoded.defaultSessionRoots, [path.join(f.directory, "agent", "sessions")]);
});

function fixture(t: TestContext) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-archive-source-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, {recursive: true, force: true});
    });
    return {directory};
}
