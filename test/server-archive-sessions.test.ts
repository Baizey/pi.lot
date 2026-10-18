import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync} from "node:fs";
import {open} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {ArchiveSessions, getArchiveRootSessionId, recordArchiveMainIdentity} from "../src/server/ArchiveSessions.js";
import {decodeArchiveMetadata, MAX_ARCHIVE_BYTES, SessionKind} from "../src/server/ArchiveProtocol.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FORK = "33333333-3333-4333-8333-333333333333";
const EPOCH = "1970-01-01T00:00:00.000Z";

test("archive snapshots retain exact native bytes and count every branch, not projected context", async (t) => {
    const f = fixture(t);
    const body = Buffer.from([
        JSON.stringify(header(ROOT)),
        JSON.stringify(entry("message", {message: {role: "system", content: "secret system"}})),
        JSON.stringify(entry("message", {id: "u1", message: {role: "user", content: [
            {type: "image", data: "not a title"}, {type: "text", text: "first task"},
        ]}})),
        JSON.stringify(entry("message", {id: "a1", parentId: "u1", message: {role: "assistant", content: [
            {type: "thinking", thinking: "secret thinking"}, {type: "toolCall", name: "read"},
            {type: "toolCall", name: "write"},
        ]}})),
        JSON.stringify(entry("message", {parentId: "u1", message: {role: "assistant", content: [{type: "toolCall", name: "bash"}]}})),
        JSON.stringify(entry("message", {message: {role: "toolResult", content: [{type: "toolCall"}], timestamp: 9999999999999}})),
        JSON.stringify(entry("custom_message", {content: "not counted"})),
        JSON.stringify(entry("context_edit", {targetId: "a1", replacement: null})),
        JSON.stringify(entry("compaction", {summary: "not the title", timestamp: "1970-01-02T00:00:00Z"})),
        JSON.stringify(entry("future_native_entry", {secret: "preserve this too"})),
    ].join("\r\n") + "\r\n");
    writeFileSync(f.rootFile, body);
    const catalog = await f.archive.discover("current");
    assert.deepEqual(catalog.files, [realpathSync(f.rootFile)]);
    const snapshot = await f.archive.snapshot(catalog.files[0]!);
    assert.deepEqual(snapshot.body, body);
    assert.deepEqual(snapshot.metadata, {
        counts: {user_messages: 1, assistant_messages: 2, tool_calls: 3},
        started_at: EPOCH, last_activity_at: "1970-01-02T00:00:00.000Z", title: "first task",
        kind: SessionKind.Main, root_session_id: ROOT,
    });
    assert.equal(snapshot.sessionId, ROOT);
    assert.deepEqual(snapshot.warnings, []);
    assert.deepEqual(decodeArchiveMetadata(snapshot.metadata, ROOT), snapshot.metadata);
    assert.ok(!JSON.stringify(snapshot.metadata).includes("cwd"));
});

test("titles use the last session name, explicit clears, and a control-free UTF-8 byte cap", async (t) => {
    const f = fixture(t);
    const user = entry("message", {message: {role: "user", content: "\u0000Task\u001b\n " + "😀".repeat(100)}});
    for (const clear of [{name: ""}, {}, {name: "\u0000\u007f"}]) {
        const file = f.save(ROOT, [user, entry("session_info", {name: "old title"}), entry("session_info", clear)]);
        const snapshot = await f.archive.snapshot(file);
        assert.equal(snapshot.metadata.title, "Task " + "😀".repeat(62));
        assert.equal(Buffer.byteLength(snapshot.metadata.title!), 253);
        assert.doesNotMatch(snapshot.metadata.title!, /[\u0000-\u001f\u007f-\u009f]/u);
        decodeArchiveMetadata(snapshot.metadata, ROOT);
    }
    let file = f.save(ROOT, [user, entry("session_info", {name: "\u0001Named\n session"})]);
    assert.equal((await f.archive.snapshot(file)).metadata.title, "Named session");
    file = f.save(ROOT, [entry("message", {message: {role: "assistant", content: [{type: "text", text: "not a title"}]}})]);
    assert.equal((await f.archive.snapshot(file)).metadata.title, undefined);
});

test("timestamps use valid persisted header/entry times, accept epoch zero, and omit unknown dates", async (t) => {
    const f = fixture(t);
    let file = f.save(ROOT, [entry("custom", {timestamp: "1969-12-31T23:59:59Z"}),
        entry("message", {timestamp: "invalid", message: {role: "user", content: "x", timestamp: 9999999999999}})]);
    let metadata = (await f.archive.snapshot(file)).metadata;
    assert.equal(metadata.started_at, EPOCH);
    assert.equal(metadata.last_activity_at, EPOCH);
    file = f.save(ROOT, [entry("custom", {timestamp: "2024-02-30T00:00:00Z"})], {timestamp: "invalid"});
    metadata = (await f.archive.snapshot(file)).metadata;
    assert.equal(metadata.started_at, undefined);
    assert.equal(metadata.last_activity_at, undefined);
    file = f.save(ROOT, [entry("custom", {timestamp: "2024-04-02T12:00:00+02:00"}),
        entry("custom", {timestamp: "2024-04-02T09:00:00Z"})]);
    assert.equal((await f.archive.snapshot(file)).metadata.last_activity_at, "2024-04-02T10:00:00.000Z");
});

test("current family includes nested legacy children and policy reviewers across workspaces; all includes other roots", async (t) => {
    const f = fixture(t);
    const parent = f.save("subagent-parent", [custom({parentAgentIdentifier: ROOT})]);
    const nested = f.save("subagent-nested", [custom({parentAgentIdentifier: "subagent-parent"})], {cwd: "/different/workspace"});
    const reviewer = f.save("policy-approver-review", [custom({parentAgentIdentifier: "subagent-nested"})]);
    const explicit = f.save("subagent-explicit", [boundChild("subagent-explicit", ROOT, ROOT)]);
    const byPath = f.save("subagent-path", [], {parentSession: parent});
    const byHeaderId = f.save("subagent-header-id", [], {parentSession: ROOT});
    const fork = f.save(FORK, [mainIdentity(FORK)], {parentSession: f.rootFile});
    const other = f.save(OTHER, [mainIdentity(OTHER)], {}, f.globalProject);
    const orphan = f.save("subagent-orphan", [], {parentSession: "/unowned/private/session.jsonl"});
    const unknown = f.save("custom-unknown", []);
    const current = await f.archive.discover("current");
    assert.deepEqual(current.files.sort(), [f.rootFile, parent, nested, reviewer, explicit, byPath, byHeaderId].map((file) => realpathSync(file)).sort());
    for (const file of current.files) {
        const snapshot = await f.archive.snapshot(file);
        assert.equal(snapshot.metadata.root_session_id, ROOT);
        assert.equal(snapshot.metadata.kind, file === f.rootFile ? SessionKind.Main
            : file === reviewer ? SessionKind.PolicyApprover : SessionKind.Subagent);
    }
    const all = await f.archive.discover("all");
    for (const file of [fork, other, orphan, unknown]) assert.ok(all.files.includes(realpathSync(file)));
    const forkSnapshot = await f.archive.snapshot(fork);
    assert.equal(forkSnapshot.metadata.kind, SessionKind.Main);
    assert.equal(forkSnapshot.metadata.root_session_id, FORK);
    const orphanSnapshot = await f.archive.snapshot(orphan);
    assert.equal(orphanSnapshot.metadata.kind, undefined);
    assert.equal(orphanSnapshot.metadata.root_session_id, undefined);
    assert.equal(orphanSnapshot.warnings.length, 1);
    assert.deepEqual(orphanSnapshot.body, readFileSync(orphan));
    const unknownSnapshot = await f.archive.snapshot(unknown);
    assert.equal(unknownSnapshot.metadata.kind, undefined);
    assert.equal(unknownSnapshot.metadata.root_session_id, undefined);
    assert.deepEqual(unknownSnapshot.warnings, []);
});

test("session-bound child identity retains creation intent when its original root is unknown", async (t) => {
    const f = fixture(t);
    const id = "intent-defined-child";
    const file = f.save(id, [custom({version: 1, sessionId: id, kind: SessionKind.PolicyApprover,
        parentAgentIdentifier: "subagent-missing-parent"})]);
    assert.ok((await f.archive.discover("all")).files.includes(file));
    const unresolved = await f.archive.snapshot(file);
    assert.equal(unresolved.metadata.kind, undefined);
    assert.equal(unresolved.metadata.root_session_id, undefined);
    assert.equal(unresolved.warnings.length, 1);
    const manager = SessionManager.open(file);
    assert.equal(getArchiveRootSessionId(manager), undefined);
    const appended: unknown[] = [];
    recordArchiveMainIdentity({appendEntry: (customType, data) => { appended.push({customType, data}); }}, manager);
    assert.deepEqual(appended, [], "an explicitly known child must not be relabelled main");
    f.save("subagent-missing-parent", [custom({parentAgentIdentifier: ROOT})]);
    assert.ok((await f.archive.discover("current")).files.includes(file));
    const resolved = await f.archive.snapshot(file);
    assert.equal(resolved.metadata.kind, SessionKind.PolicyApprover);
    assert.equal(resolved.metadata.root_session_id, ROOT);
    assert.deepEqual(resolved.warnings, []);
});

for (const bound of [false, true]) {
    test(`a resumed child resolves its current archive family through the catalog (bound=${bound})`, async (t) => {
        const f = fixture(t);
        writeFileSync(f.rootFile, [header(ROOT), mainIdentity(ROOT)].map((row) => JSON.stringify(row)).join("\n") + "\n");
        const id = "subagent-resumed-without-root";
        const identity = bound ? custom({version: 1, sessionId: id, kind: SessionKind.Subagent, parentAgentIdentifier: ROOT})
            : custom({parentAgentIdentifier: ROOT});
        const child = f.save(id, [identity], {parentSession: f.rootFile});
        const nested = f.save("subagent-nested-resumed", [custom({parentAgentIdentifier: id})]);
        const reviewer = f.save("policy-approver-resumed", [custom({parentAgentIdentifier: id})]);
        f.save(OTHER, [mainIdentity(OTHER)]);
        const archive = new ArchiveSessions(SessionManager.open(child));
        const discovered = await archive.discover("current");
        assert.equal(discovered.rootSessionId, ROOT);
        assert.deepEqual(discovered.files.sort(), [f.rootFile, child, nested, reviewer].sort());
        for (const file of discovered.files) {
            assert.equal((await archive.snapshot(file)).metadata.root_session_id, ROOT);
        }
    });
}

for (const link of ["path", "id"] as const) {
    test(`a resumed header-only child resolves its current archive family by ${link}`, async (t) => {
        const f = fixture(t);
        writeFileSync(f.rootFile, [header(ROOT), mainIdentity(ROOT)].map((row) => JSON.stringify(row)).join("\n") + "\n");
        const child = f.save("subagent-header-only-resumed", [], {parentSession: link === "path" ? f.rootFile : ROOT});
        const archive = new ArchiveSessions(SessionManager.open(child));
        const discovered = await archive.discover("current");
        assert.equal(discovered.rootSessionId, ROOT);
        assert.deepEqual(discovered.files.sort(), [f.rootFile, child].sort());
        assert.equal((await archive.snapshot(child)).metadata.root_session_id, ROOT);
    });
}

test("current-family fallback does not adopt conflicting, cyclic, or colliding ancestry", async (t) => {
    const f = fixture(t);
    writeFileSync(f.rootFile, [header(ROOT), mainIdentity(ROOT)].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const conflicting = f.save("subagent-resumed-conflict", [boundChild("subagent-resumed-conflict", ROOT, ROOT),
        boundChild("subagent-resumed-conflict", ROOT, OTHER)]);
    const cycle = f.save("subagent-resumed-cycle", [custom({parentAgentIdentifier: "subagent-cycle-parent"})]);
    f.save("subagent-cycle-parent", [custom({parentAgentIdentifier: "subagent-resumed-cycle"})]);
    const headerMismatch = f.save("subagent-resumed-header-mismatch", [custom({parentAgentIdentifier: "missing-parent"})],
        {parentSession: f.rootFile});
    for (const file of [conflicting, cycle, headerMismatch]) {
        const discovered = await new ArchiveSessions(SessionManager.open(file)).discover("current");
        assert.equal(discovered.rootSessionId, undefined);
        assert.deepEqual(discovered.files, []);
    }
    const child = f.save("subagent-resumed-collision", [custom({parentAgentIdentifier: ROOT})]);
    f.save(ROOT, [mainIdentity(ROOT)]);
    const collision = await new ArchiveSessions(SessionManager.open(child)).discover("current");
    assert.equal(collision.rootSessionId, undefined);
    assert.deepEqual(collision.files, []);
    assert.match(collision.warnings.join(" "), /duplicate session ID/);
});

test("legacy parent paths never open arbitrary files, cycles stay unclassified, and ID collisions are skipped", async (t) => {
    const f = fixture(t);
    const outside = f.save(OTHER, [], {}, path.join(f.directory, "unowned"));
    const orphan = f.save("subagent-private-parent", [], {parentSession: outside});
    const a = f.save("subagent-cycle-a", [custom({parentAgentIdentifier: "subagent-cycle-b"})]);
    f.save("subagent-cycle-b", [custom({parentAgentIdentifier: "subagent-cycle-a"})]);
    const duplicateOne = f.save(OTHER, []);
    const duplicateTwo = f.save(OTHER, [], {}, f.globalProject);
    const dependent = f.save("subagent-ambiguous", [custom({parentAgentIdentifier: OTHER})]);
    const all = await f.archive.discover("all");
    assert.ok(all.warnings.some((warning) => /duplicate session ID/.test(warning)));
    assert.ok(!all.files.includes(duplicateOne));
    assert.ok(!all.files.includes(duplicateTwo));
    for (const file of [orphan, a, dependent]) {
        const snapshot = await f.archive.snapshot(file);
        assert.equal(snapshot.metadata.kind, undefined);
        assert.equal(snapshot.metadata.root_session_id, undefined);
        assert.equal(snapshot.warnings.length, 1);
    }
    await assert.rejects(f.archive.snapshot(duplicateOne), /Duplicate session ID/);
    assert.ok(!JSON.stringify(all.warnings).includes(outside));
});

test("legacy path fallback cannot contradict a recorded parent agent ID", async (t) => {
    const f = fixture(t);
    const other = f.save(OTHER, [mainIdentity(OTHER)]);
    const mismatched = f.save("subagent-wrong-path", [custom({parentAgentIdentifier: "subagent-missing-parent"})], {parentSession: other});
    const mismatchedCurrent = f.save("subagent-wrong-current-path", [custom({parentAgentIdentifier: "subagent-missing-parent"})], {parentSession: f.rootFile});
    const validById = f.save("subagent-valid-id-stale-path", [custom({parentAgentIdentifier: ROOT})], {parentSession: other});
    const all = await f.archive.discover("all");
    for (const file of [mismatched, mismatchedCurrent]) {
        assert.ok(all.files.includes(file), "unclassified sessions remain available for full-byte uploads");
        const snapshot = await f.archive.snapshot(file);
        assert.equal(snapshot.metadata.kind, undefined);
        assert.equal(snapshot.metadata.root_session_id, undefined);
        assert.equal(snapshot.warnings.length, 1);
        assert.deepEqual(snapshot.body, readFileSync(file));
    }
    assert.equal((await f.archive.snapshot(validById)).metadata.root_session_id, ROOT);
    assert.deepEqual((await f.archive.discover("current")).files.sort(), [f.rootFile, validById].sort());
    rmSync(f.rootFile);
    assert.deepEqual((await f.archive.discover("current")).files, [validById]);
    const missingRootSnapshot = await f.archive.snapshot(mismatchedCurrent);
    assert.equal(missingRootSnapshot.metadata.kind, undefined);
    assert.equal(missingRootSnapshot.metadata.root_session_id, undefined);
    assert.equal(missingRootSnapshot.warnings.length, 1);
});

test("an unpersisted current root still resolves children, while ephemeral current discovery is empty", async (t) => {
    const f = fixture(t);
    rmSync(f.rootFile);
    const empty = await f.archive.discover("current");
    assert.deepEqual(empty.files, []);
    assert.ok(empty.warnings.some((warning) => /no persisted/.test(warning)));
    const child = f.save("subagent-first", [custom({parentAgentIdentifier: ROOT})]);
    assert.deepEqual((await f.archive.discover("current")).files, [child]);
    assert.equal((await f.archive.snapshot(child)).metadata.root_session_id, ROOT);
    const global = f.save(OTHER, [], {}, f.globalProject);
    const ephemeral = new ArchiveSessions(SessionManager.inMemory(f.directory));
    assert.deepEqual((await ephemeral.discover("current")).files, []);
    assert.match((await ephemeral.discover("current")).warnings.join(" "), /--no-session/);
    assert.ok((await ephemeral.discover("all")).files.includes(global));
});

test("unsafe files, oversize sessions, invalid UTF-8, and malformed JSONL fail without exposing content", async (t) => {
    const f = fixture(t);
    const large = f.save("subagent-large", []);
    truncateSync(large, MAX_ARCHIVE_BYTES + 1);
    const invalidUtf8 = path.join(f.sessionDir, "utf8.jsonl");
    writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe]));
    const invalidJson = path.join(f.sessionDir, "json.jsonl");
    writeFileSync(invalidJson, JSON.stringify(header(OTHER)) + '\n{"secret":"DO_NOT_DUMP_SECRET",');
    const notHeader = path.join(f.sessionDir, "not-header.jsonl");
    writeFileSync(notHeader, JSON.stringify(entry("message", {message: {role: "user", content: "DO_NOT_DUMP_SECRET"}})));
    for (const file of [large, invalidUtf8, invalidJson, notHeader]) {
        await assert.rejects(f.archive.snapshot(file), (error: Error) => {
            assert.doesNotMatch(error.message, /DO_NOT_DUMP_SECRET/);
            assert.ok(!error.message.includes(f.directory));
            return true;
        });
    }
    const discovered = await f.archive.discover("all");
    assert.deepEqual(discovered.files, [f.rootFile]);
    assert.match(discovered.warnings.join(" "), /Skipped 4/);
});

test("snapshot retries changing descriptors at most three times and honors cancellation", async (t) => {
    const f = fixture(t);
    const handle = await open(f.rootFile, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const original = prototype.stat;
    let calls = 0;
    t.mock.method(prototype, "stat", async function (this: typeof handle, options: {bigint: true}) {
        const stats = await original.call(this, options);
        calls++;
        if (calls % 2 === 0) stats.ctimeNs += 1n;
        return stats;
    });
    await assert.rejects(f.archive.snapshot(f.rootFile), /all three snapshot attempts/);
    assert.equal(calls, 6);
    t.mock.restoreAll();
    const controller = new AbortController();
    controller.abort(new Error("DO_NOT_DUMP_SECRET"));
    for (const operation of [() => f.archive.discover("all", controller.signal), () => f.archive.snapshot(f.rootFile, controller.signal)]) {
        await assert.rejects(operation(), (error: Error) => {
            assert.equal(error.name, "AbortError");
            assert.doesNotMatch(error.message, /DO_NOT_DUMP_SECRET/);
            return true;
        });
    }
});

test("a changed snapshot retries successfully and an abort during bounded reads closes the descriptor", async (t) => {
    const f = fixture(t);
    const handle = await open(f.rootFile, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalStat = prototype.stat;
    let calls = 0;
    t.mock.method(prototype, "stat", async function (this: typeof handle, options: {bigint: true}) {
        const stats = await originalStat.call(this, options);
        if (++calls === 2) stats.mtimeNs += 1n;
        return stats;
    });
    assert.deepEqual((await f.archive.snapshot(f.rootFile)).body, readFileSync(f.rootFile));
    assert.equal(calls, 4);
    t.mock.restoreAll();
    const controller = new AbortController();
    const originalRead = prototype.read;
    let closed = 0;
    t.mock.method(prototype, "read", async function (this: typeof handle, ...args: unknown[]) {
        const close = this.close;
        t.mock.method(this, "close", async () => {
            closed++;
            return close.call(this);
        });
        controller.abort();
        return originalRead.apply(this, args);
    });
    await assert.rejects(f.archive.snapshot(f.rootFile, controller.signal), {name: "AbortError"});
    assert.equal(closed, 1);
});

test("symlinks and FIFOs are rejected without following or blocking", async (t) => {
    const f = fixture(t);
    for (const kind of ["symlink", "fifo"] as const) {
        await t.test(kind, async (child) => {
            const file = path.join(f.sessionDir, `${kind}.jsonl`);
            try {
                if (kind === "symlink") symlinkSync(f.rootFile, file);
                else execFileSync("mkfifo", [file], {stdio: "pipe"});
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES"
                    || (kind === "fifo" && /Operation not permitted|Permission denied/i.test(String(error)))) {
                    child.skip("Host sandbox does not allow this filesystem fixture.");
                    return;
                }
                throw error;
            }
            await assert.rejects(f.archive.snapshot(file), /regular.*file/);
        });
    }
});

test("bound identities survive resumes, reject conflicts, and do not leak across native forks", async (t) => {
    const f = fixture(t);
    const childId = "subagent-bound";
    const childRecord = boundChild(childId, ROOT, ROOT);
    const childFile = f.save(childId, [childRecord]);
    const nativeFork = SessionManager.forkFrom(childFile, f.directory, f.sessionDir, {id: FORK});
    const copied = path.resolve(nativeFork.getSessionFile()!);
    const unrelated = f.save(OTHER, [entry("custom", {customType: "some-other-extension", data: {kind: "main"}})]);
    const conflicting = f.save("subagent-conflicting", [boundChild("subagent-conflicting", ROOT, ROOT),
        boundChild("subagent-conflicting", OTHER, OTHER)]);
    const cycle = f.save("subagent-bound-cycle-a", [boundChild("subagent-bound-cycle-a", "subagent-bound-cycle-b", ROOT)]);
    f.save("subagent-bound-cycle-b", [boundChild("subagent-bound-cycle-b", "subagent-bound-cycle-a", ROOT)]);
    await f.archive.discover("all");
    for (const file of [copied, unrelated, conflicting, cycle]) {
        const snapshot = await f.archive.snapshot(file);
        assert.equal(snapshot.metadata.kind, undefined);
        assert.equal(snapshot.metadata.root_session_id, undefined);
    }
    assert.equal((await f.archive.snapshot(conflicting)).warnings.length, 1);
    const resumed = SessionManager.open(childFile);
    assert.equal(getArchiveRootSessionId(resumed), ROOT);
    const notCalled = {appendEntry() { assert.fail("A resumed child must not become a main root"); }};
    recordArchiveMainIdentity(notCalled, resumed);
    assert.equal(getArchiveRootSessionId(SessionManager.open(conflicting)), undefined);
    const forkManager = SessionManager.open(copied);
    const records: unknown[] = [];
    recordArchiveMainIdentity({appendEntry(customType, data) {
        records.push(data);
        forkManager.appendCustomEntry(customType, data);
    }}, forkManager);
    assert.deepEqual(records, [{version: 1, sessionId: FORK, kind: SessionKind.Main, rootSessionId: FORK}]);
    const forkArchive = new ArchiveSessions(forkManager);
    const snapshot = await forkArchive.snapshot(copied);
    assert.equal(snapshot.metadata.kind, SessionKind.Main);
    assert.equal(snapshot.metadata.root_session_id, FORK);
    recordArchiveMainIdentity(notCalled, forkManager);
    const legacyPrefix = SessionManager.inMemory(f.directory, {id: "policy-approver-legacy"});
    recordArchiveMainIdentity(notCalled, legacyPrefix);
    assert.equal(getArchiveRootSessionId(legacyPrefix), undefined);
});

function fixture(t: TestContext) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-archive-sessions-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, {recursive: true, force: true});
    });
    const sessionDir = path.join(directory, "custom-session-dir");
    const globalProject = path.join(directory, "agent", "sessions", "--another-workspace--");
    const manager = SessionManager.create(directory, sessionDir, {id: ROOT});
    const rootFile = path.resolve(manager.getSessionFile()!);
    mkdirSync(sessionDir, {recursive: true});
    writeFileSync(rootFile, JSON.stringify(header(ROOT)) + "\n");
    return {
        directory, sessionDir, globalProject, manager, rootFile, archive: new ArchiveSessions(manager),
        save(id: string, entries: unknown[], overrides: Record<string, unknown> = {}, target = sessionDir): string {
            mkdirSync(target, {recursive: true});
            const file = path.join(target, `${id}.jsonl`);
            writeFileSync(file, [header(id, overrides), ...entries].map((row) => JSON.stringify(row)).join("\n") + "\n");
            return file;
        },
    };
}

function header(id: string, overrides: Record<string, unknown> = {}) {
    return {type: "session", version: 3, id, timestamp: EPOCH, cwd: "/private/cwd", ...overrides};
}

function entry(type: string, overrides: Record<string, unknown> = {}) {
    return {type, id: "entry", parentId: null, timestamp: EPOCH, ...overrides};
}

function custom(data: Record<string, unknown>) {
    return entry("custom", {customType: "pilot.subagent", data});
}

function boundChild(id: string, parent: string, root: string) {
    return custom({version: 1, sessionId: id, parentAgentIdentifier: parent, rootSessionId: root, kind: SessionKind.Subagent});
}

function mainIdentity(id: string) {
    return entry("custom", {customType: "pilot.archive", data: {version: 1, sessionId: id, rootSessionId: id, kind: SessionKind.Main}});
}
