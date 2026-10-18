import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {ArchiveJournal, type ArchiveUploadSnapshot} from "../src/server/ArchiveJournal.js";
import {SessionKind, type Binding, type Publication, type Receipt} from "../src/server/ArchiveProtocol.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

const binding: Binding = {server_id: randomUUID(), namespace_id: randomUUID(), history_generation: randomUUID()};
const origin = "https://archive.example";
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
