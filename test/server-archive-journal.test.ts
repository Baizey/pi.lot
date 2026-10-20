import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, mock, test, type TestContext} from "node:test";
import {ArchiveJournal, type ArchiveUploadSnapshot} from "../src/server/ArchiveJournal.js";
import type {Binding, Publication, Receipt} from "../src/server/ArchiveProtocol.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

const binding: Binding = {server_id: randomUUID(), namespace_id: randomUUID(), history_generation: randomUUID()};
const origin = "https://archive.example";
const openDatabase = SqliteDatabase.test;

// These private fixtures cover transactions, fsync ordering, and reopen persistence,
// not production WAL/shared-memory or cross-mount concurrency qualification.
beforeEach(() => {
    mock.method(SqliteDatabase, "test", (readonly: boolean, file: string) => {
        const database = openDatabase(readonly, file);
        try {
            if (!readonly) database.exec("PRAGMA journal_mode=DELETE");
            return database;
        } catch (error) {
            database.close();
            throw error;
        }
    });
});
afterEach(() => mock.restoreAll());

function createSymlink(t: TestContext, target: string, link: string): boolean {
    try {
        fs.symlinkSync(target, link);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES") throw error;
        t.skip("Sandbox does not permit creating the symlink fixture.");
        return false;
    }
}

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-archive-journal-"));
    return {directory, clean: () => fs.rmSync(directory, {recursive: true, force: true})};
}
function snapshot(body = "first snapshot\n", title = "Title"): ArchiveUploadSnapshot {
    return {file: "/synthetic/session.jsonl", sessionId: "root", body: Buffer.from(body),
        metadata: {kind: SessionKind.Main, root_session_id: "root", title,
            started_at: "2026-01-01T00:00:00Z"}};
}
function pending(journal: ArchiveJournal, value = snapshot(), namespace = binding) {
    const prepared = journal.prepare(origin, namespace, value);
    assert.equal(prepared.kind, "pending");
    if (prepared.kind !== "pending") throw new Error("Expected pending operation");
    return prepared;
}
function receipt(request: Publication, seq = "1"): Receipt {
    return {request, revision: {binding: request.binding, seq}};
}

function traceJournalIO(t: TestContext, beforeSync: (file: string) => void = () => {}) {
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const close = fs.closeSync;
    const descriptors = new Map<number, string>();
    const events: Array<{kind: "open" | "sync" | "close"; file: string}> = [];
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const descriptor = open(...args);
        const file = String(args[0]);
        descriptors.set(descriptor, file);
        events.push({kind: "open", file});
        return descriptor;
    });
    t.mock.method(fs, "fsyncSync", (descriptor: number) => {
        const file = descriptors.get(descriptor);
        assert.ok(file !== undefined, "fsync must use an owned open descriptor");
        beforeSync(file);
        sync(descriptor);
        events.push({kind: "sync", file});
    });
    t.mock.method(fs, "closeSync", (descriptor: number) => {
        close(descriptor);
        const file = descriptors.get(descriptor);
        if (file !== undefined) {
            events.push({kind: "close", file});
            descriptors.delete(descriptor);
        }
    });
    return {events, descriptors};
}

test("first-use nested journal directories and file are synced before a pending publication can be sent", (t) => {
    const f = fixture();
    const directories = [path.join(f.directory, "new"), path.join(f.directory, "new", "nested"),
        path.join(f.directory, "new", "nested", "archive")];
    const directory = directories[2]!;
    const file = path.join(directory, "archive.sqlite");
    const beforeCreation = new Map(directories.map((entry) => [entry, new Set<string>()]));
    const {events, descriptors} = traceJournalIO(t, (synced) => {
        for (const entry of directories) {
            if (!fs.existsSync(entry)) beforeCreation.get(entry)!.add(synced);
        }
    });
    const send = t.mock.fn(() => {
        for (const entry of directories) {
            const parent = path.dirname(entry);
            assert.ok(beforeCreation.get(entry)!.has(parent), `${parent} must be synced before creating ${entry}`);
            assert.ok(beforeCreation.get(entry)!.has(path.dirname(parent)), "the parent's own name must already be durable");
            const directorySync = events.findIndex((event) => event.kind === "sync" && event.file === entry);
            assert.ok(directorySync >= 0, `${entry} must be synced before publication`);
            assert.ok(events.slice(directorySync + 1).some((event) => event.kind === "sync" && event.file === parent),
                `${parent} must also be synced after creating ${entry}`);
            assert.equal(fs.statSync(entry).mode & 0o777, 0o700);
        }
        const fileSync = events.findIndex((event) => event.kind === "sync" && event.file === file);
        assert.ok(fileSync >= 0, "the new database file must be synced");
        assert.ok(events.slice(fileSync + 1).some((event) => event.kind === "sync" && event.file === directory),
            "the database file's directory entry must be synced before publication");
        assert.equal(descriptors.size, 0, "directory and file sync descriptors must be closed");
    });
    try {
        const journal = new ArchiveJournal(directory);
        try {
            const prepared = pending(journal);
            assert.deepEqual(journal.pending(origin, binding, prepared.request.session_id, prepared.request.operation_id), prepared);
            send();
        } finally { journal.close(); }
        assert.equal(send.mock.callCount(), 1);
    } finally { f.clean(); }
});

test("failed parent fsync blocks preparation and publication and is retried even when nested directories now exist", async (t) => {
    for (const level of [0, 1, 2]) {
        await t.test(`new ancestor level ${level}`, (t) => {
            const f = fixture();
            const directories = [path.join(f.directory, "new"), path.join(f.directory, "new", "nested"),
                path.join(f.directory, "new", "nested", "archive")];
            const directory = directories[2]!;
            const created = directories[level]!;
            const parent = path.dirname(created);
            const failure = new Error("injected parent directory fsync failure");
            let fail = true;
            let failures = 0;
            const {events, descriptors} = traceJournalIO(t, (file) => {
                if (fail && file === parent && fs.existsSync(created)) {
                    failures++;
                    throw failure;
                }
            });
            const send = t.mock.fn();
            let prepared = false;
            const upload = () => {
                const journal = new ArchiveJournal(directory);
                try {
                    const operation = pending(journal);
                    prepared = true;
                    send(operation);
                } finally { journal.close(); }
            };
            try {
                // These are ordering/failure-injection tests, not a simulation of power loss.
                for (let attempt = 0; attempt < 2; attempt++) {
                    assert.throws(upload, (error) => error === failure);
                    assert.equal(failures, attempt + 1, "a retry must not skip the unsynced ancestor's existing name");
                    assert.ok(fs.statSync(created).isDirectory());
                    assert.equal(fs.existsSync(path.join(directory, "archive.sqlite")), false);
                    assert.equal(prepared, false);
                    assert.equal(send.mock.callCount(), 0);
                    assert.equal(descriptors.size, 0, "failed directory fsync must still close its descriptor");
                }
                fail = false;
                const retryStart = events.length;
                const journal = new ArchiveJournal(directory);
                try {
                    assert.deepEqual(journal.pendingRequests(origin, binding), []);
                    const operation = pending(journal);
                    const retry = events.slice(retryStart);
                    for (const entry of [created, parent]) {
                        assert.ok(retry.some((event) => event.kind === "sync" && event.file === entry),
                            `retry must sync ${entry} before publication`);
                    }
                    assert.equal(descriptors.size, 0);
                    send(operation);
                    assert.equal(send.mock.callCount(), 1);
                } finally { journal.close(); }
            } finally { f.clean(); }
        });
    }
});

test("reopening an existing journal resyncs directory names before replaying its pending operation", (t) => {
    const f = fixture();
    const directory = path.join(f.directory, "archive");
    try {
        const first = new ArchiveJournal(directory);
        const original = (() => {
            try { return pending(first); }
            finally { first.close(); }
        })();
        const {events, descriptors} = traceJournalIO(t);
        const reopened = new ArchiveJournal(directory);
        try {
            const replay = pending(reopened, snapshot("new local bytes must not replace the pending operation\n"));
            assert.deepEqual(replay, original);
            for (const entry of [directory, f.directory, path.dirname(f.directory)]) {
                assert.ok(events.some((event) => event.kind === "sync" && event.file === entry),
                    `existing directory name ${entry} must be synced before replay`);
            }
            assert.equal(descriptors.size, 0);
        } finally { reopened.close(); }
    } finally { f.clean(); }
});

test("journal initialization rejects directory symlinks, including an ancestor of a new journal", (t) => {
    const f = fixture();
    const {descriptors} = traceJournalIO(t);
    try {
        const target = path.join(f.directory, "target");
        const link = path.join(f.directory, "link");
        fs.mkdirSync(target, {mode: 0o700});
        if (!createSymlink(t, target, link)) return;
        assert.throws(() => new ArchiveJournal(link), /private directory/);
        assert.throws(() => new ArchiveJournal(path.join(link, "archive")));
        assert.equal(fs.existsSync(path.join(target, "archive")), false);
        assert.equal(fs.existsSync(path.join(target, "archive.sqlite")), false);
        assert.equal(descriptors.size, 0);
    } finally { f.clean(); }
});

test("a directory left by a failed first use is revalidated before retrying", (t) => {
    const f = fixture();
    const directory = path.join(f.directory, "archive");
    let fail = true;
    const {descriptors} = traceJournalIO(t, (file) => {
        if (fail && file === f.directory && fs.existsSync(directory)) throw new Error("injected fsync failure");
    });
    try {
        assert.throws(() => new ArchiveJournal(directory), /injected fsync failure/);
        fail = false;
        fs.chmodSync(directory, 0o755);
        assert.throws(() => new ArchiveJournal(directory), /private directory/);
        assert.equal(fs.existsSync(path.join(directory, "archive.sqlite")), false);
        fs.chmodSync(directory, 0o700);
        const moved = path.join(f.directory, "moved");
        fs.renameSync(directory, moved);
        if (!createSymlink(t, moved, directory)) return;
        assert.throws(() => new ArchiveJournal(directory), /private directory/);
        assert.equal(fs.existsSync(path.join(moved, "archive.sqlite")), false);
        assert.equal(descriptors.size, 0);
        fs.unlinkSync(directory);
        fs.renameSync(moved, directory);
        const journal = new ArchiveJournal(directory);
        try { assert.equal(pending(journal).request.condition.kind, "absent"); }
        finally { journal.close(); }
        assert.equal(descriptors.size, 0);
    } finally { f.clean(); }
});

test("pending request and exact snapshot bytes survive reopening before any send", () => {
    const f = fixture();
    try {
        const first = new ArchiveJournal(f.directory);
        const prepared = pending(first);
        first.close();
        const reopened = new ArchiveJournal(f.directory);
        try {
            const replay = pending(reopened, snapshot("a newer local snapshot\n"));
            assert.deepEqual(replay.request, prepared.request);
            assert.deepEqual(replay.body, prepared.body);
            assert.equal(replay.request.condition.kind, "absent");
            assert.equal(fs.statSync(path.join(f.directory, "archive.sqlite")).mode & 0o777, 0o600);
        } finally { reopened.close(); }
    } finally { f.clean(); }
});

test("accepted receipt is the only update base and normalized unchanged metadata is skipped", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const initial = pending(journal);
        journal.accept(origin, receipt(initial.request));
        assert.deepEqual(journal.prepare(origin, binding, snapshot()), {kind: "unchanged"});
        const updated = pending(journal, snapshot("first snapshot\nappended\n"));
        assert.deepEqual(updated.request.condition, {kind: "exact_base_revision", revision: receipt(initial.request).revision});
        assert.notEqual(updated.request.operation_id, initial.request.operation_id);
        journal.accept(origin, receipt(updated.request, "2"));
        assert.deepEqual(journal.prepare(origin, binding, snapshot("first snapshot\nappended\n")), {kind: "unchanged"});
        const renamed = pending(journal, snapshot("first snapshot\nappended\n", "Renamed"));
        assert.equal(renamed.request.condition.kind, "exact_base_revision");
        assert.equal(renamed.request.sha256, updated.request.sha256);
    } finally { journal.close(); f.clean(); }
});

test("truncated or diverging local histories cannot overwrite an accepted complete history", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const initial = pending(journal);
        journal.accept(origin, receipt(initial.request));
        for (const body of ["first", "different longer snapshot\n"]) {
            assert.throws(() => journal.prepare(origin, binding, snapshot(body)), /no longer extends/);
        }
        assert.deepEqual(journal.prepare(origin, binding, snapshot()), {kind: "unchanged"});
    } finally { journal.close(); f.clean(); }
});

test("different local files with the same session identity do not silently share authority", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const initial = pending(journal);
        assert.throws(() => journal.prepare(origin, binding, {...snapshot(), file: "/another/session.jsonl"}), /different local file/);
        assert.deepEqual(pending(journal).request, initial.request);
    } finally { journal.close(); f.clean(); }
});

test("concurrent uploaders replay one operation and late receipts cannot clear its successor", () => {
    const f = fixture();
    const first = new ArchiveJournal(f.directory);
    const second = new ArchiveJournal(f.directory);
    try {
        const original = pending(first);
        assert.deepEqual(pending(second).request, original.request);
        first.accept(origin, receipt(original.request));
        second.accept(origin, receipt(original.request));
        const successor = pending(first, snapshot("first snapshot\nnext\n"));
        second.accept(origin, receipt(original.request));
        assert.deepEqual(pending(second).request, successor.request);
        first.accept(origin, receipt(successor.request, "2"));
        second.accept(origin, receipt(original.request));
        assert.deepEqual(second.prepare(origin, binding, snapshot("first snapshot\nnext\n")), {kind: "unchanged"});
        const third = pending(second, snapshot("first snapshot\nnext\nlast\n"));
        assert.deepEqual(third.request.condition, {kind: "exact_base_revision", revision: receipt(successor.request, "2").revision});
    } finally { first.close(); second.close(); f.clean(); }
});

test("wrong receipts leave the durable original operation untouched", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const initial = pending(journal);
        const wrong = receipt({...initial.request, operation_id: randomUUID()});
        assert.throws(() => journal.accept(origin, wrong), /does not match/);
        assert.deepEqual(pending(journal).request, initial.request);
    } finally { journal.close(); f.clean(); }
});

test("origin and complete server binding isolate accepted bases and pending retries", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const initial = pending(journal);
        journal.accept(origin, receipt(initial.request));
        for (const isolated of [
            {...binding, server_id: randomUUID()},
            {...binding, namespace_id: randomUUID()},
            {...binding, history_generation: randomUUID()},
        ]) {
            const rotated = pending(journal, snapshot(), isolated);
            assert.equal(rotated.request.condition.kind, "absent");
            assert.notEqual(rotated.request.operation_id, initial.request.operation_id);
        }
        const moved = journal.prepare("http://archive.example", binding, snapshot());
        assert.equal(moved.kind, "pending");
        if (moved.kind === "pending") assert.equal(moved.request.condition.kind, "absent");
        assert.deepEqual(journal.prepare(origin, binding, snapshot()), {kind: "unchanged"});
    } finally { journal.close(); f.clean(); }
});

test("corrupt persisted pending bytes fail closed without inventing a successor", () => {
    const f = fixture();
    try {
        const first = new ArchiveJournal(f.directory);
        pending(first);
        first.close();
        const database = SqliteDatabase.test(false, path.join(f.directory, "archive.sqlite"));
        database.prepare("UPDATE archive_uploads SET body=?").run(Buffer.from("corrupt"));
        database.close();
        const reopened = new ArchiveJournal(f.directory);
        try { assert.throws(() => pending(reopened), /journal is invalid/); }
        finally { reopened.close(); }
    } finally { f.clean(); }
});

test("shared directories and public journal files are rejected", () => {
    const f = fixture();
    try {
        fs.chmodSync(f.directory, 0o755);
        assert.throws(() => new ArchiveJournal(f.directory), /private directory/);
        fs.chmodSync(f.directory, 0o700);
        const journal = new ArchiveJournal(f.directory);
        journal.close();
        fs.chmodSync(path.join(f.directory, "archive.sqlite"), 0o644);
        assert.throws(() => new ArchiveJournal(f.directory), /private regular file/);
    } finally { f.clean(); }
});
