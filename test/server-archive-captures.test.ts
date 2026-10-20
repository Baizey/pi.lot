import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {afterEach, beforeEach, mock, test} from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {ArchiveClient} from "../src/server/ArchiveClient.js";
import {ArchiveSessions} from "../src/server/ArchiveSessions.js";
import {SessionArchive} from "../src/server/SessionArchive.js";
import {ArchiveJournal, type ArchivePendingUpload, type ArchiveUploadSnapshot} from "../src/server/ArchiveJournal.js";
import {type Binding, type Publication, type Receipt} from "../src/server/ArchiveProtocol.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

const origin = "https://archive.example";
const binding: Binding = {server_id: randomUUID(), namespace_id: randomUUID(), history_generation: randomUUID()};
const openDatabase = SqliteDatabase.test;

// File-backed isolated fixtures test transactions and close/reopen persistence.
// They deliberately do NOT validate production WAL/shared-memory concurrency.
// The normal journal's database factory is mocked only for this test file.
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

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-archive-captures-"));
    return {directory, file: path.join(directory, "source.jsonl"),
        clean: () => fs.rmSync(directory, {recursive: true, force: true})};
}

function snapshot(file: string, body = "original\n", title = "Title"): ArchiveUploadSnapshot {
    return {file, sessionId: "root", body: Buffer.from(body),
        metadata: {kind: SessionKind.Main, root_session_id: "root", title}};
}

function pending(value: ReturnType<ArchiveJournal["prepare"]>): ArchivePendingUpload {
    assert.equal(value.kind, "pending");
    if (value.kind !== "pending") throw new Error("Expected pending publication");
    return value;
}

function receipt(operation: ArchivePendingUpload, seq = "1"): Receipt {
    return {request: operation.request, revision: {binding: operation.request.binding, seq}};
}

function ids(journal: ArchiveJournal, destination = binding): string[] {
    return journal.captures(origin, destination).captures.map((capture) => capture.id);
}

test("successor bytes survive unresolved predecessor, restart, source deletion, and late receipts", () => {
    const f = fixture();
    let journal = new ArchiveJournal(f.directory);
    try {
        fs.writeFileSync(f.file, "original\nappended\n", {mode: 0o600});
        const original = pending(journal.prepare(origin, binding, snapshot(f.file)));
        const successor = snapshot(f.file, fs.readFileSync(f.file, "utf8"));
        const id = journal.capture(origin, binding, successor);
        const replay = pending(journal.prepareCaptured(origin, binding, id));
        assert.deepEqual(replay, original);
        assert.deepEqual(ids(journal), [id]);
        journal.close();
        fs.unlinkSync(f.file);
        journal = new ArchiveJournal(f.directory);
        assert.deepEqual(journal.pending(origin, binding, "root", original.request.operation_id), original);
        journal.accept(origin, receipt(original));
        assert.deepEqual(ids(journal), [id], "acknowledging A must not clear B");
        const next = pending(journal.prepareCaptured(origin, binding, id));
        assert.deepEqual(next.body, successor.body);
        assert.deepEqual(next.request.condition, {kind: "exact_base_revision", revision: receipt(original).revision});
        assert.notEqual(next.request.operation_id, original.request.operation_id);
        assert.deepEqual(ids(journal), [], "pending operation atomically owns B's bytes now");
        journal.accept(origin, receipt(original));
        assert.deepEqual(journal.pending(origin, binding, "root", next.request.operation_id), next);
        journal.accept(origin, receipt(next, "2"));
        journal.accept(origin, receipt(original));
        assert.deepEqual(journal.prepare(origin, binding, successor), {kind: "unchanged"});
    } finally { journal.close(); f.clean(); }
});

test("compatibility prepare captures distinct successors without replacing their unresolved operation", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const original = pending(journal.prepare(origin, binding, snapshot(f.file)));
        const second = snapshot(f.file, "original\nsecond\n");
        const third = snapshot(f.file, "original\nsecond\nthird\n");
        assert.deepEqual(journal.prepare(origin, binding, second), original);
        assert.deepEqual(journal.prepare(origin, binding, third), original);
        assert.deepEqual(journal.captures(origin, binding).captures.map((item) => item.byteLength).sort((a, b) => a - b),
            [second.body.length, third.body.length]);
        journal.accept(origin, receipt(original));
        assert.equal(ids(journal).length, 2, "accept only owns the exact pending operation");
    } finally { journal.close(); f.clean(); }
});

test("captured bodies and metadata are immutable and metadata differences do not deduplicate", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const input = snapshot(f.file);
        const first = journal.capture(origin, binding, input);
        input.body.fill(0);
        input.metadata.title = "mutated after capture";
        assert.equal(journal.capture(origin, binding, snapshot(f.file)), first);
        const renamed = journal.capture(origin, binding, snapshot(f.file, "original\n", "Different title"));
        assert.notEqual(first, renamed);
        const original = pending(journal.prepareCaptured(origin, binding, first));
        assert.deepEqual(original.body, Buffer.from("original\n"));
        assert.equal(original.request.metadata?.title, "Title");
        journal.accept(origin, receipt(original));
        const update = pending(journal.prepareCaptured(origin, binding, renamed));
        assert.equal(update.request.metadata?.title, "Different title");
        assert.equal(update.request.sha256, original.request.sha256);
    } finally { journal.close(); f.clean(); }
});

test("accepted prefix protection rejects publication but retains divergent and shorter captures", () => {
    const f = fixture();
    let journal = new ArchiveJournal(f.directory);
    try {
        const original = pending(journal.prepare(origin, binding, snapshot(f.file)));
        journal.accept(origin, receipt(original));
        for (const body of ["old", "divergent complete history\n"]) {
            assert.throws(() => journal.prepare(origin, binding, snapshot(f.file, body)), /no longer extends/);
        }
        assert.equal(ids(journal).length, 2);
        journal.close();
        journal = new ArchiveJournal(f.directory);
        for (const id of ids(journal)) {
            assert.throws(() => journal.prepareCaptured(origin, binding, id), /no longer extends/);
        }
        assert.equal(ids(journal).length, 2);
        assert.deepEqual(journal.pendingRequests(origin, binding), []);
    } finally { journal.close(); f.clean(); }
});

test("only exact accepted equality consumes a capture; distinct metadata and sources stay retained", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const original = pending(journal.prepare(origin, binding, snapshot(f.file)));
        const identical = journal.capture(origin, binding, snapshot(f.file));
        const metadata = journal.capture(origin, binding, snapshot(f.file, "original\n", "Renamed"));
        const otherPath = journal.capture(origin, binding, snapshot(path.join(f.directory, "other.jsonl")));
        journal.accept(origin, receipt(original));
        assert.equal(ids(journal).length, 3);
        assert.deepEqual(journal.prepareCaptured(origin, binding, identical), {kind: "unchanged"});
        assert.deepEqual(new Set(ids(journal)), new Set([metadata, otherPath]));
        assert.throws(() => journal.prepareCaptured(origin, binding, otherPath), /different local file/);
        assert.deepEqual(new Set(ids(journal)), new Set([metadata, otherPath]));
    } finally { journal.close(); f.clean(); }
});

test("separate connections replay one operation without consuming unrelated successor evidence", () => {
    const f = fixture();
    const first = new ArchiveJournal(f.directory);
    const second = new ArchiveJournal(f.directory);
    try {
        const a = first.capture(origin, binding, snapshot(f.file));
        assert.equal(second.capture(origin, binding, snapshot(f.file)), a);
        const b = second.capture(origin, binding, snapshot(f.file, "original\nnext\n"));
        const original = pending(first.prepareCaptured(origin, binding, a));
        assert.deepEqual(second.prepareCaptured(origin, binding, b), original);
        assert.deepEqual(ids(first), [b]);
        first.accept(origin, receipt(original));
        second.accept(origin, receipt(original));
        const next = pending(second.prepareCaptured(origin, binding, b));
        first.accept(origin, receipt(original));
        assert.deepEqual(first.pending(origin, binding, "root", next.request.operation_id), next);
    } finally { first.close(); second.close(); f.clean(); }
});

test("failed ownership transfer rolls back both operation creation and capture removal", (t) => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const id = journal.capture(origin, binding, snapshot(f.file));
        const prepare = SqliteDatabase.prototype.prepare;
        const mock = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
            if (sql.includes("DELETE FROM archive_captures")) throw new Error("injected transfer failure");
            return prepare.call(this, sql);
        });
        assert.throws(() => journal.prepareCaptured(origin, binding, id), /injected transfer failure/);
        mock.mock.restore();
        assert.deepEqual(journal.pendingRequests(origin, binding), []);
        assert.deepEqual(ids(journal), [id]);
        assert.equal(pending(journal.prepareCaptured(origin, binding, id)).request.condition.kind, "absent");
    } finally { journal.close(); f.clean(); }
});

test("compatibility capture and promotion hold one write lock and retain bytes after promotion failure", (t) => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    const contender = SqliteDatabase.test(false, path.join(f.directory, "archive.sqlite"));
    try {
        contender.exec("PRAGMA busy_timeout=0");
        const promote = journal.prepareCaptured.bind(journal);
        const mock = t.mock.method(journal, "prepareCaptured", (...args: Parameters<ArchiveJournal["prepareCaptured"]>) => {
            assert.throws(() => contender.exec("BEGIN IMMEDIATE"), (error: unknown) => error instanceof Error
                && "code" in error && error.code === "SQLITE_BUSY", "a contender cannot consume the capture before promotion");
            return promote(...args);
        });
        const original = pending(journal.prepare(origin, binding, snapshot(f.file)));
        mock.mock.restore();
        journal.accept(origin, receipt(original));
        const prepare = SqliteDatabase.prototype.prepare;
        const failure = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
            if (sql.includes("DELETE FROM archive_captures")) throw new Error("injected promotion failure");
            return prepare.call(this, sql);
        });
        assert.throws(() => journal.prepare(origin, binding, snapshot(f.file, "original\nnext\n")), /injected promotion failure/);
        failure.mock.restore();
        assert.deepEqual(journal.pendingRequests(origin, binding), []);
        assert.equal(ids(journal).length, 1, "failed promotion commits evidence, not a half-created executable operation");
    } finally { contender.close(); journal.close(); f.clean(); }
});

test("logical backlog admission retains existing and grandfathered bytes without eviction", () => {
    const f = fixture();
    const a = snapshot(f.file);
    const b = snapshot(f.file, "original\nnext\n");
    const journal = new ArchiveJournal(f.directory, {backlogByteLimit: a.body.length + b.body.length});
    let restricted: ArchiveJournal | undefined;
    try {
        const original = pending(journal.prepare(origin, binding, a));
        const id = journal.capture(origin, binding, b);
        assert.throws(() => journal.capture(origin, binding, snapshot(f.file, "another retained body\n")), /backlog is full/);
        assert.deepEqual(ids(journal), [id]);
        restricted = new ArchiveJournal(f.directory, {backlogByteLimit: 0});
        assert.equal(restricted.capture(origin, binding, b), id, "existing immutable evidence is idempotent above the limit");
        assert.deepEqual(restricted.prepare(origin, binding, a), original, "grandfathered pending work can still drain");
        restricted.accept(origin, receipt(original));
        assert.deepEqual(pending(restricted.prepareCaptured(origin, binding, id)).body, b.body);
        assert.deepEqual(ids(restricted), []);
    } finally { restricted?.close(); journal.close(); f.clean(); }
});

test("direct capture admission serializes quota checks across connections", (t) => {
    const f = fixture();
    const a = snapshot(f.file);
    const b = snapshot(f.file, "different body\n");
    const open = SqliteDatabase.test;
    t.mock.method(SqliteDatabase, "test", (...args: Parameters<typeof open>) => open(...args).exec("PRAGMA busy_timeout=0"));
    const first = new ArchiveJournal(f.directory, {backlogByteLimit: b.body.length});
    const second = new ArchiveJournal(f.directory, {backlogByteLimit: b.body.length});
    try {
        const prepare = SqliteDatabase.prototype.prepare;
        let checked = false;
        t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
            if (!checked && sql.includes("AS bytes")) {
                checked = true;
                assert.throws(() => second.capture(origin, binding, b), (error: unknown) => error instanceof Error
                    && "code" in error && error.code === "SQLITE_BUSY");
            }
            return prepare.call(this, sql);
        });
        const id = first.capture(origin, binding, a);
        assert.equal(checked, true);
        assert.throws(() => second.capture(origin, binding, b), /backlog is full/);
        assert.deepEqual(ids(first), [id]);
        assert.deepEqual(pending(second.prepareCaptured(origin, binding, id)).body, a.body);
    } finally { first.close(); second.close(); f.clean(); }
});

test("capture inventory is bounded, stable, and isolated by complete destination binding", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const expected = ["one", "two", "three"].map((title) => journal.capture(origin, binding, snapshot(f.file, "body", title))).sort();
        const page = journal.captures(origin, binding, {limit: 2});
        assert.deepEqual(page.captures.map((capture) => capture.id), expected.slice(0, 2));
        assert.equal(page.nextCursor, expected[1]);
        const last = journal.captures(origin, binding, {limit: 2, cursor: page.nextCursor});
        assert.deepEqual(last.captures.map((capture) => capture.id), expected.slice(2));
        assert.equal(last.nextCursor, undefined);
        for (const destination of [
            {...binding, server_id: randomUUID()}, {...binding, namespace_id: randomUUID()},
            {...binding, history_generation: randomUUID()},
        ]) {
            assert.deepEqual(journal.captures(origin, destination).captures, []);
            assert.throws(() => journal.prepareCaptured(origin, destination, expected[0]!), /no longer available/);
        }
        assert.deepEqual(journal.captures("https://other.example", binding).captures, []);
        assert.throws(() => journal.captures(origin, binding, {limit: 257}), /page limit/);
        assert.throws(() => journal.captures(origin, binding, {cursor: "invalid"}), /capture ID/);
    } finally { journal.close(); f.clean(); }
});

test("corrupt retained capture bytes fail closed without preparing a replacement operation", () => {
    const f = fixture();
    let journal = new ArchiveJournal(f.directory);
    try {
        const id = journal.capture(origin, binding, snapshot(f.file));
        journal.close();
        const database = SqliteDatabase.test(false, path.join(f.directory, "archive.sqlite"));
        try { database.prepare("UPDATE archive_captures SET body=?").run(Buffer.from("corrupt!\n")); }
        finally { database.close(); }
        journal = new ArchiveJournal(f.directory);
        assert.deepEqual(ids(journal), [id], "metadata enumeration does not load bodies");
        assert.throws(() => journal.capture(origin, binding, snapshot(f.file)), /journal is invalid/,
            "duplicate admission must not acknowledge corrupted retained bytes or silently repair them");
        assert.throws(() => journal.prepareCaptured(origin, binding, id), /journal is invalid/);
        assert.deepEqual(journal.pendingRequests(origin, binding), []);
        assert.deepEqual(ids(journal), [id]);
    } finally { journal.close(); f.clean(); }
});

test("legacy pending inventory spans origins and generations without rewriting authority or recapturing accepted rows", () => {
    const f = fixture();
    const file = path.join(f.directory, "archive.sqlite");
    fs.writeFileSync(file, "", {mode: 0o600});
    const old = SqliteDatabase.test(false, file);
    const body = Buffer.from("old frozen operation\n");
    // Construct the old protocol row independently of the new capture/promotion implementation.
    const legacy: Publication = {binding, session_id: "legacy", operation_id: randomUUID(), condition: {kind: "absent"},
        byte_length: body.length, sha256: createHash("sha256").update(body).digest("hex")};
    try {
        // Legacy publications can omit metadata. Text formatting must survive migration unchanged.
        const rawPending = JSON.stringify(legacy, null, 2);
        const acceptedBinding = {...binding, history_generation: randomUUID()};
        const rawAccepted = JSON.stringify({request: {...legacy, binding: acceptedBinding},
            revision: {binding: acceptedBinding, seq: "7"}}, null, 2);
        old.exec(`CREATE TABLE archive_uploads (
            profile TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL,
            accepted TEXT, pending TEXT, body BLOB, PRIMARY KEY (profile, session_id)
        )`);
        const profile = (url: string, destination: Binding) => JSON.stringify([url, destination.server_id,
            destination.namespace_id, destination.history_generation]);
        old.prepare("INSERT INTO archive_uploads VALUES (?, ?, ?, NULL, ?, ?)")
            .run(profile(origin, binding), legacy.session_id, f.file, rawPending, body);
        old.prepare("INSERT INTO archive_uploads VALUES (?, ?, ?, ?, NULL, NULL)")
            .run(profile("https://old.example", acceptedBinding), legacy.session_id, f.file, rawAccepted);
        const otherBinding = {...binding, history_generation: randomUUID()};
        const other = {...legacy, binding: otherBinding, operation_id: randomUUID()};
        old.prepare("INSERT INTO archive_uploads VALUES (?, ?, ?, NULL, ?, ?)")
            .run(profile("https://old.example", otherBinding), other.session_id, f.file, JSON.stringify(other), body);
        const before = old.prepare("SELECT * FROM archive_uploads ORDER BY profile").all();
        old.close();
        const journal = new ArchiveJournal(f.directory);
        try {
            const inventory = [...journal.pendingOperations()];
            assert.equal(inventory.length, 2);
            assert.deepEqual(new Set(inventory.map((entry) => entry.origin)), new Set([origin, "https://old.example"]));
            assert.deepEqual(new Set(inventory.map((entry) => entry.request.operation_id)), new Set([legacy.operation_id, other.operation_id]));
            assert.deepEqual(journal.pending(origin, binding, legacy.session_id, legacy.operation_id)?.body, body);
            assert.deepEqual(ids(journal), [], "accepted-only rows do not create implicit capture work");
        } finally { journal.close(); }
        const inspection = SqliteDatabase.test(false, file);
        try { assert.deepEqual(inspection.prepare("SELECT * FROM archive_uploads ORDER BY profile").all(), before); }
        finally { inspection.close(); }
    } finally { old.close(); f.clean(); }
});

test("pending inventory permits receipt acceptance during iteration and spans bounded metadata pages", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        const operations = Array.from({length: 67}, (_, index) => pending(journal.prepare(origin, binding,
            {...snapshot(f.file), sessionId: `session-${index}`, metadata: {}})));
        const observed = new Set<string>();
        for (const operation of journal.pendingOperations()) {
            observed.add(operation.request.operation_id);
            const frozen = journal.pending(operation.origin, operation.binding,
                operation.request.session_id, operation.request.operation_id);
            assert.ok(frozen);
            journal.accept(operation.origin, receipt(frozen, String(observed.size)));
        }
        assert.deepEqual(observed, new Set(operations.map((operation) => operation.request.operation_id)));
        assert.deepEqual([...journal.pendingOperations()], []);
    } finally { journal.close(); f.clean(); }
});

test("foreground recovery uses the captured outgoing identity after the manager changes during HTTP", async (t) => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    const original = pending(journal.prepare(origin, binding, snapshot(f.file)));
    journal.close();
    try {
        const manager = SessionManager.inMemory(f.directory, {id: "root"});
        let active = "root";
        t.mock.method(manager, "getSessionId", () => active);
        const client = new ArchiveClient({url: origin, apiKey: "synthetic-key"});
        t.mock.method(client, "binding", async () => { active = "newly-selected-session"; return {binding, head: "1"}; });
        const lookup = t.mock.method(client, "receipt", async () => ({status: "accepted" as const, receipt: receipt(original)}));
        const publish = t.mock.method(client, "publish", async () => { throw new Error("No replay required for accepted operation"); });
        const sessions = new ArchiveSessions(manager);
        t.mock.method(sessions, "discover", async () => ({files: [], warnings: []}));
        const service = new SessionArchive({url: origin, apiKey: "synthetic-key"},
            {client, stateDirectory: f.directory, createSessions: () => sessions});
        const report = await service.upload(manager, "current");
        assert.deepEqual(report, {uploaded: 1, unchanged: 0, failed: 0, warnings: [], failures: []});
        assert.deepEqual(lookup.mock.calls.map((call) => call.arguments[0]), [original.request]);
        assert.equal(publish.mock.callCount(), 0);
    } finally { f.clean(); }
});

test("real discovery and pending recovery stay with the serialized outgoing family across HTTP", async (t) => {
    const f = fixture();
    try {
        const aFile = path.join(f.directory, "a.jsonl");
        const bFile = path.join(f.directory, "b.jsonl");
        const header = (id: string) => JSON.stringify({type: "session", version: 3, id,
            timestamp: "2026-01-01T00:00:00Z", cwd: f.directory}) + "\n";
        const aPrefix = header("a");
        const aBody = aPrefix + JSON.stringify({type: "session_info", id: "name", parentId: null,
            timestamp: "2026-01-01T00:00:01Z", name: "Outgoing"}) + "\n";
        fs.writeFileSync(aFile, aBody, {mode: 0o600});
        fs.writeFileSync(bFile, header("b"), {mode: 0o600});
        const journal = new ArchiveJournal(f.directory);
        let other: ArchivePendingUpload;
        try {
            pending(journal.prepare(origin, binding, {file: aFile, sessionId: "a", body: Buffer.from(aPrefix), metadata: {}}));
            other = pending(journal.prepare(origin, binding, {file: bFile, sessionId: "b", body: Buffer.from(header("b")), metadata: {}}));
        } finally { journal.close(); }
        const manager = SessionManager.open(aFile, f.directory);
        let active = {id: "a", file: aFile};
        t.mock.method(manager, "getSessionId", () => active.id);
        t.mock.method(manager, "getSessionFile", () => active.file);
        const client = new ArchiveClient({url: origin, apiKey: "synthetic-key"});
        t.mock.method(client, "binding", async () => { active = {id: "b", file: bFile}; return {binding, head: "0"}; });
        const lookups: Publication[] = [];
        t.mock.method(client, "receipt", async (request: Publication) => { lookups.push(request); return {status: "unknown" as const}; });
        const published: Array<{request: Publication; body: Buffer}> = [];
        t.mock.method(client, "publish", async (request: Publication, body: Uint8Array): Promise<Receipt> => {
            published.push({request, body: Buffer.from(body)});
            return {request, revision: {binding, seq: String(published.length)}};
        });
        const report = await new SessionArchive({url: origin, apiKey: "synthetic-key"},
            {client, stateDirectory: f.directory}).upload(manager, "current");
        assert.equal(report.failed, 0);
        assert.equal(report.uploaded, 1);
        assert.equal(published.length, 2);
        assert.ok(published.every(({request}) => request.session_id === "a"));
        assert.ok(lookups.every((request) => request.session_id === "a"));
        assert.deepEqual(published.at(-1)!.body, Buffer.from(aBody));
        const reopened = new ArchiveJournal(f.directory);
        try { assert.deepEqual(reopened.pending(origin, binding, "b", other.request.operation_id), other); }
        finally { reopened.close(); }
    } finally { f.clean(); }
});

test("capture rejects invalid paths, identities, metadata, and budget configuration", () => {
    const f = fixture();
    const journal = new ArchiveJournal(f.directory);
    try {
        assert.throws(() => journal.capture(origin, binding, {...snapshot("relative.jsonl")}), /Invalid archive snapshot/);
        assert.throws(() => journal.capture(origin, binding, {...snapshot(f.file), sessionId: ""}));
        assert.throws(() => journal.capture(origin, binding, {...snapshot(f.file), metadata: {kind: SessionKind.Main}}));
        assert.throws(() => new ArchiveJournal(f.directory, {backlogByteLimit: -1}), /byte limit/);
        const options = {backlogByteLimit: 0};
        const restricted = new ArchiveJournal(f.directory, options);
        try {
            options.backlogByteLimit = Infinity;
            assert.throws(() => restricted.capture(origin, binding, snapshot(f.file)), /backlog is full/);
        } finally { restricted.close(); }
        assert.deepEqual(ids(journal), []);
    } finally { journal.close(); f.clean(); }
});
