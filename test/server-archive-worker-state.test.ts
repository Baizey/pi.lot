import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {afterEach, beforeEach, mock, test, type TestContext} from "node:test";
import {ArchiveJournal, type ArchiveUploadSnapshot} from "../src/server/ArchiveJournal.js";
import {ArchiveClient, ArchiveClientError} from "../src/server/ArchiveClient.js";
import {ArchiveWorkerEngine} from "../src/server/ArchiveWorkerEngine.js";
import {ArchiveSessions, ArchiveSourceError, type ArchiveSourceEvidence} from "../src/server/ArchiveSessions.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {
    ArchiveWorkerState, ArchiveManifestError, ARCHIVE_WORKING_BYTES, type ArchiveManifest, type WorkCandidate, type WorkOperation, type WorkSource,
} from "../src/server/ArchiveWorkerState.js";
import {MAX_ARCHIVE_BYTES, decodeArchiveReceipt, decodeArchivePreservationReceipt,
    type ArchiveMetadata, type Binding, type Publication, type Revision} from "../src/server/ArchiveProtocol.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

const origin = "https://archive.example";
const generation = "connection-generation";
const binding: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "history"};
const connection = {config: {url: origin}, generation};
const openDatabase = SqliteDatabase.test;

// Real file-backed SQLite and real transactions, isolated to this test file. DELETE fixtures
// do not qualify production WAL/shared-memory behavior; production configuration is unchanged.
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

function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-archive-worker-state-"));
    const file = path.join(directory, "archive.sqlite");
    let current: ArchiveWorkerState | undefined;
    t.after(() => { current?.close(); fs.rmSync(directory, {recursive: true, force: true}); });
    return {
        directory, file,
        open() { current?.close(); current = new ArchiveWorkerState(directory); return current; },
        close() { current?.close(); current = undefined; },
        query<T>(sql: string): T[] {
            const database = SqliteDatabase.test(true, file);
            try { return database.prepare(sql).all() as T[]; }
            finally { database.close(); }
        },
    };
}

function manifest(directory: string, credentialGeneration = generation): ArchiveManifest {
    return {version: 1, id: randomUUID(), origin, generation: credentialGeneration, source: {
        version: 1, scope: "current", activeSession: {sessionId: "session", main: false, identityConflict: false},
        sessionFile: path.join(directory, "missing.jsonl"), sessionDirectory: directory, rootSessionId: "session",
        defaultSessionRoots: [directory],
    }};
}

function capture(state: ArchiveWorkerState, directory: string, body: string, credentialGeneration = generation,
    bindDestination = true): WorkCandidate {
    const enqueue = manifest(directory, credentialGeneration);
    assert.equal(state.import(enqueue), true);
    const scope = state.scope(enqueue.id);
    const destination = state.destinations().find((item) => item.id === scope.destination)!;
    if (bindDestination && !destination.binding) state.bind(destination, binding);
    const file = enqueue.source.sessionFile!;
    assert.equal(state.addSources(scope, [file], null, true), true);
    const source = state.nextSource(Number.MAX_SAFE_INTEGER);
    assert.ok(source);
    assert.equal(source.scope, scope.id);
    const snapshot: ArchiveUploadSnapshot = {file, sessionId: "session", body: Buffer.from(body), metadata: {title: "Title"}};
    assert.equal(state.capture(source, snapshot), true);
    const sha256 = createHash("sha256").update(snapshot.body).digest("hex");
    // Capture IDs are content-addressed. Query the persisted result independently of selection,
    // which deliberately hides successors while their predecessor is unresolved.
    const database = SqliteDatabase.test(true, path.join(directory, "archive.sqlite"));
    try {
        const row = database.prepare("SELECT id FROM archive_worker_candidates WHERE destination=? AND sha256=?")
            .get(scope.destination, sha256) as {id: string} | undefined;
        assert.ok(row);
        return state.candidate(row.id);
    } finally { database.close(); }
}

function publication(candidate: WorkCandidate, destination = binding, base?: Revision): Publication {
    return {binding: destination, session_id: candidate.sessionId, operation_id: randomUUID(),
        condition: base ? {kind: "exact_base_revision", revision: base} : {kind: "absent"},
        byte_length: candidate.byteLength, sha256: candidate.sha256,
        ...(candidate.metadata === null ? {} : {metadata: candidate.metadata})};
}

function operation(state: ArchiveWorkerState, candidate: WorkCandidate): WorkOperation {
    const result = state.nextOperation([candidate.destination], Number.MAX_SAFE_INTEGER);
    assert.ok(result);
    return result;
}

function acceptPreservation(state: ArchiveWorkerState, candidate: WorkCandidate) {
    const revision: Revision = {binding, seq: "9007199254740993"};
    const request = {mode: "current", binding, session_id: candidate.sessionId, operation_id: randomUUID(), revision};
    const snapshot = {session_id: candidate.sessionId, revision, byte_length: 6,
        sha256: createHash("sha256").update("remote").digest("hex"), metadata: null, uploaded_at: "2026-01-01T00:00:00Z"};
    const comparison = JSON.stringify({snapshot, condition: {kind: "exact_base_revision", revision}});
    state.prepare(candidate, "current", request, null, comparison);
    const pending = operation(state, candidate);
    const receipt = {request, source_revision: revision, source_uploaded_at: snapshot.uploaded_at,
        variant: {...snapshot, variant_id: "preserved-variant"}};
    assert.equal(state.accept(pending, receipt, false), true);
    return {pending, request, comparison, receipt, revision};
}

function seedLegacy(directory: string) {
    const file = path.join(directory, "archive.sqlite");
    fs.writeFileSync(file, "", {mode: 0o600});
    const database = SqliteDatabase.test(false, file);
    const body = Buffer.from("frozen predecessor\n");
    const request: Publication = {binding, session_id: "session", operation_id: randomUUID(), condition: {kind: "absent"},
        byte_length: body.length, sha256: createHash("sha256").update(body).digest("hex")};
    const raw = JSON.stringify(request, null, 2);
    const profile = JSON.stringify([origin, binding.server_id, binding.namespace_id, binding.history_generation]);
    try {
        database.exec(`CREATE TABLE archive_uploads (
            profile TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL,
            accepted TEXT, pending TEXT, body BLOB, PRIMARY KEY (profile, session_id)
        )`);
        database.prepare("INSERT INTO archive_uploads VALUES (?,?,?,NULL,?,?)")
            .run(profile, request.session_id, path.join(directory, "missing.jsonl"), raw, body);
        const accepted = {...request, session_id: "accepted-only", operation_id: randomUUID()};
        database.prepare("INSERT INTO archive_uploads VALUES (?,?,?,?,NULL,NULL)")
            .run(profile, accepted.session_id, path.join(directory, "also-missing.jsonl"),
                JSON.stringify({request: accepted, revision: {binding, seq: "2"}}, null, 2));
        return {request, raw, body, before: database.prepare("SELECT * FROM archive_uploads ORDER BY session_id").all()};
    } finally { database.close(); }
}

test("legacy migration retains exact raw requests and bodies without requiring sources or scheduling accepted-only rows", (t) => {
    const f = fixture(t);
    const legacy = seedLegacy(f.directory);
    const state = f.open();
    assert.equal(fs.existsSync(path.join(f.directory, "missing.jsonl")), false);
    const destinations = state.destinations();
    assert.equal(destinations.length, 1);
    const pending = state.nextOperation(destinations.map((d) => d.id), Number.MAX_SAFE_INTEGER);
    assert.ok(pending);
    assert.equal(JSON.parse(pending.request).operation_id, legacy.request.operation_id);
    assert.equal(pending.request, legacy.raw);
    assert.equal(pending.state, "uncertain");
    assert.equal(pending.dispatched, true, "legacy pending requests may already have reached the server");
    assert.deepEqual(state.body(state.candidate(pending.candidate)), legacy.body);
    assert.equal(state.nextScope(Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(f.query("SELECT id FROM archive_worker_candidates").length, 1);
    assert.deepEqual(f.query("SELECT * FROM archive_uploads ORDER BY session_id"), legacy.before);
    f.open();
    assert.deepEqual(f.query("SELECT * FROM archive_uploads ORDER BY session_id"), legacy.before);
});

for (const outcome of ["rejected", "fenced", "accepted"] as const) {
    test(`legacy ${outcome} operations are not resurrected on restart, and late acknowledgments cannot complete new work`, (t) => {
        const f = fixture(t);
        const legacy = seedLegacy(f.directory);
        let state = f.open();
        const destination = state.destinations()[0]!;
        const pending = state.nextOperation([destination.id], Number.MAX_SAFE_INTEGER)!;
        const receipt = {request: legacy.request, revision: {binding, seq: "3"}};
        if (outcome === "rejected") state.reject(pending);
        else if (outcome === "fenced") state.bind(destination, {...binding, history_generation: "restored"});
        else assert.equal(state.accept(pending, receipt, true), true);
        state = f.open();
        assert.equal(state.nextOperation([destination.id], Number.MAX_SAFE_INTEGER), undefined);
        assert.equal(state.accept(pending, receipt, true), false);
        if (outcome !== "accepted") assert.deepEqual(state.body(state.candidate(pending.candidate)), legacy.body);
        assert.deepEqual(f.query<{state: string}>("SELECT state FROM archive_worker_operations"), [{state: outcome}]);
        if (outcome === "accepted") {
            assert.deepEqual(f.query("SELECT pending,body FROM archive_uploads WHERE session_id='session'"), [{pending: null, body: null}]);
            assert.deepEqual(f.query("SELECT request FROM archive_worker_operations"), [{request: legacy.raw}]);
        } else assert.deepEqual(f.query("SELECT * FROM archive_uploads ORDER BY session_id"), legacy.before);
    });
}

test("an independently captured successor survives restart and its predecessor's late receipt", (t) => {
    const f = fixture(t);
    let state = f.open();
    const first = capture(state, f.directory, "first\n");
    const request = publication(first);
    state.prepare(first, "publish", request);
    const pending = operation(state, first);
    const second = capture(state, f.directory, "first\nsecond\n");
    assert.notEqual(second.id, first.id);
    assert.equal(state.nextCandidate([first.destination], Number.MAX_SAFE_INTEGER), undefined);
    assert.deepEqual(state.body(second), Buffer.from("first\nsecond\n"));
    assert.throws(() => state.prepare(second, "publish", publication(second)), /unresolved/);
    state = f.open();
    const receipt = {request, revision: {binding, seq: "1"}};
    assert.equal(state.accept(pending, receipt, true), true);
    assert.equal(state.accept(pending, receipt, true), false);
    assert.equal(state.nextCandidate([first.destination], Number.MAX_SAFE_INTEGER)?.id, second.id);
    assert.deepEqual(state.body(second), Buffer.from("first\nsecond\n"));
    assert.deepEqual(f.query<{candidate: string}>("SELECT candidate FROM archive_worker_coverage"), [{candidate: first.id}]);
});

test("acceptance and candidate coverage roll back together if coverage persistence fails", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "original");
    const request = publication(candidate);
    state.prepare(candidate, "publish", request);
    const pending = operation(state, candidate);
    const prepare = SqliteDatabase.prototype.prepare;
    const injection = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        if (sql.includes("INSERT OR REPLACE INTO archive_worker_coverage")) throw new Error("injected coverage failure");
        return prepare.call(this, sql);
    });
    assert.throws(() => state.accept(pending, {request, revision: {binding, seq: "1"}}, true), /injected coverage failure/);
    injection.mock.restore();
    assert.equal(operation(state, candidate).state, "ready");
    assert.deepEqual(state.body(candidate), Buffer.from("original"));
    assert.deepEqual(f.query("SELECT * FROM archive_worker_coverage"), []);
});

test("accepted preserve-current receipt survives a crash before dependent publication without clearing candidate bytes", (t) => {
    const f = fixture(t);
    let state = f.open();
    const candidate = capture(state, f.directory, "local candidate");
    const preserved = acceptPreservation(state, candidate);
    state = f.open();
    assert.deepEqual(state.dependency(candidate.id, binding), {id: preserved.pending.id, comparison: preserved.comparison});
    assert.deepEqual(state.body(candidate), Buffer.from("local candidate"));
    assert.deepEqual(f.query<{receipt: string}>("SELECT receipt FROM archive_worker_operations"), [{receipt: JSON.stringify(preserved.receipt)}]);
    assert.deepEqual(f.query("SELECT * FROM archive_worker_coverage"), []);
    const request = publication(candidate, binding, preserved.revision);
    state.prepare(candidate, "publish", request, preserved.pending.id, preserved.comparison);
    const pending = operation(state, candidate);
    assert.equal(pending.dependency, preserved.pending.id);
    state = f.open();
    assert.equal(operation(state, candidate).request, JSON.stringify(request));
    assert.equal(state.accept(operation(state, candidate), {request, revision: {binding, seq: "9007199254740994"}}, true), true);
    assert.equal(state.nextCandidate([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
});

function dependentPublicationFixture(t: TestContext, dispatched: boolean) {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local replacement history");
    const revision: Revision = {binding, seq: "10"};
    const remote = Buffer.from("remote history requiring preservation");
    const snapshot = {session_id: candidate.sessionId, revision, byte_length: remote.length,
        sha256: createHash("sha256").update(remote).digest("hex"), metadata: null, uploaded_at: "2026-01-01T00:00:00.000Z"};
    const preservation = {mode: "current", binding, session_id: candidate.sessionId, operation_id: randomUUID(), revision};
    const comparison = JSON.stringify({snapshot, condition: {kind: "exact_base_revision", revision}});
    state.prepare(candidate, "current", preservation, null, comparison);
    const dependency = operation(state, candidate);
    const preservationReceipt = {request: preservation, source_revision: revision, source_uploaded_at: snapshot.uploaded_at,
        variant: {...snapshot, variant_id: "preserved-r10", revision: {binding, seq: "11"}, uploaded_at: "2026-01-02T00:00:00.000Z"}};
    assert.equal(state.accept(dependency, preservationReceipt, false), true);
    const request = publication(candidate, binding, revision);
    state.prepare(candidate, "publish", request, dependency.id, comparison);
    if (dispatched) state.markUncertain(operation(state, candidate).id);
    const pending = operation(state, candidate);
    const protectedEvidence = f.query("SELECT request,receipt,comparison,state FROM archive_worker_operations WHERE kind='current'");
    const corrupted: Publication = {...request, condition: {kind: "exact_base_revision", revision: {binding, seq: "20"}}};
    const raw = JSON.stringify(corrupted);
    assert.deepEqual({...corrupted, condition: request.condition}, request, "the fixture changes only the publication's CAS condition");
    const badReceipt = {request: corrupted, revision: {binding, seq: "21"}};
    decodeArchiveReceipt(badReceipt);
    return {...f, state, candidate, request, pending, dependency, comparison, protectedEvidence, raw, badReceipt,
        corruptPublication() {
            const database = SqliteDatabase.test(false, f.file);
            try { database.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?").run(raw, pending.id); }
            finally { database.close(); }
        }};
}

for (const dispatched of [false, true]) {
    for (const entrypoint of ["enumeration", "direct-accept"] as const) {
        test(`dependent CAS condition corruption fails ${entrypoint} after restart with dispatched=${dispatched}`, (t) => {
            const f = dependentPublicationFixture(t, dispatched);
            const successor = dispatched ? capture(f.state, f.directory, "independent successor history") : undefined;
            f.corruptPublication();
            const state = f.open();
            if (entrypoint === "enumeration") {
                assert.equal(state.nextOperation([f.candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
            }
            assert.equal(state.accept({...f.pending, request: f.raw}, f.badReceipt, true), false,
                "a wire-valid R20 receipt cannot bypass the preservation dependency on R10");
            assert.deepEqual(f.query("SELECT state,request,dependency,comparison FROM archive_worker_operations WHERE kind='publish'"), [{
                state: dispatched ? "blocked" : "invalid", request: f.raw, dependency: f.dependency.id, comparison: f.comparison,
            }]);
            assert.equal(state.nextOperation([f.candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.deepEqual(f.query("SELECT request,receipt,comparison,state FROM archive_worker_operations WHERE kind='current'"), f.protectedEvidence);
            assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
            assert.deepEqual(state.body(f.candidate), Buffer.from("local replacement history"));
            if (successor) {
                assert.equal(state.nextCandidate([successor.destination], Number.MAX_SAFE_INTEGER), undefined);
                assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/);
                assert.deepEqual(state.body(successor), Buffer.from("independent successor history"));
            }
            assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false});
        });
    }

    test(`engine cannot execute a condition-only R10-to-R20 rewrite after restart with dispatched=${dispatched}`, async (t) => {
        const f = dependentPublicationFixture(t, dispatched);
        const successor = dispatched ? capture(f.state, f.directory, "independent successor history") : undefined;
        f.corruptPublication();
        f.close();
        const store = new ServerConfigStore(f.directory);
        t.mock.method(store, "connection", () => ({config: {url: origin, apiKey: "synthetic-key"}, generation}));
        const calls: string[] = [];
        t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo) => {
            const endpoint = new URL(String(url)).pathname;
            calls.push(endpoint);
            assert.equal(endpoint, "/v1/binding", "corrupt publication evidence permits neither mutation nor receipt lookup");
            const body = JSON.stringify({binding, head: "20", capabilities: ["preserved_variants_v1"]});
            return new Response(body, {headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
        });
        const engine = new ArchiveWorkerEngine(f.directory, store);
        try {
            await engine.step();
            await engine.step();
            await engine.step();
            assert.deepEqual(calls, ["/v1/binding"]);
            assert.equal(engine.inspect().eligible, false);
            const state = f.open();
            assert.equal(state.accept({...f.pending, request: f.raw}, f.badReceipt, true), false);
            assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
            assert.deepEqual(f.query("SELECT request,receipt,comparison,state FROM archive_worker_operations WHERE kind='current'"), f.protectedEvidence);
            assert.deepEqual(state.body(f.candidate), Buffer.from("local replacement history"));
            if (successor) {
                assert.equal(state.nextCandidate([successor.destination], Number.MAX_SAFE_INTEGER), undefined);
                assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/);
                assert.deepEqual(state.body(successor), Buffer.from("independent successor history"));
            }
        } finally { engine.close(); }
    });
}

test("historical canonical receipts survive dependency fencing and generation rotation without granting current authority", (t) => {
    const f = dependentPublicationFixture(t, false);
    let state = f.state;
    const receipt = {request: f.request, revision: {binding, seq: "12"}};
    assert.equal(state.accept(f.pending, receipt, true), true);
    const successor = capture(state, f.directory, "local replacement history appended");
    const database = SqliteDatabase.test(false, f.file);
    try { database.prepare("UPDATE archive_worker_operations SET state='fenced' WHERE id=?").run(f.dependency.id); }
    finally { database.close(); }
    state = f.open();
    assert.deepEqual(state.acceptedCanonical(successor, binding), receipt,
        "a historical accepted publication is not contingent on its old dependency remaining executable");
    const restored = {...binding, history_generation: "restored-history"};
    state.bind(state.destinations().find((entry) => entry.id === successor.destination)!, restored);
    state = f.open();
    assert.deepEqual(state.acceptedCanonical(successor, binding), receipt);
    assert.equal(state.acceptedCanonical(successor, restored), undefined);
    assert.equal(state.dependency(f.candidate.id, restored), undefined);
    assert.throws(() => state.prepare(successor, "publish", publication(successor, restored, {binding: restored, seq: "10"}),
        f.dependency.id, f.comparison));
    assert.deepEqual(state.body(successor), Buffer.from("local replacement history appended"));
    assert.deepEqual(f.query("SELECT request,receipt FROM archive_worker_operations WHERE kind='publish'"),
        [{request: f.pending.request, receipt: JSON.stringify(receipt)}]);
});

test("current-generation dependency lookup excludes old-binding rows before validating their owned authority", (t) => {
    const f = dependentPublicationFixture(t, false);
    let state = f.state;
    const restored = {...binding, history_generation: "restored-history"};
    state.bind(state.destinations().find((entry) => entry.id === f.candidate.destination)!, restored);
    const oldRequest = JSON.parse(f.dependency.request) as Record<string, unknown>;
    const database = SqliteDatabase.test(false, f.file);
    try { database.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?")
        .run(JSON.stringify({...oldRequest, session_id: "corrupt-old-session"}), f.dependency.id); }
    finally { database.close(); }
    state = f.open();
    assert.equal(state.dependency(f.candidate.id, restored), undefined,
        "an old binding's invalid operation relationship must not poison current-generation dependency selection");
    assert.throws(() => state.prepare(f.candidate, "publish", publication(f.candidate, restored, {binding: restored, seq: "10"}),
        f.dependency.id, f.comparison));
    assert.deepEqual(state.body(f.candidate), Buffer.from("local replacement history"));
    assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
});

test("corrupt accepted preservation receipts cannot authorize dependent publication after restart", (t) => {
    for (const corruption of ["null", "malformed-json", "wrong-request", "wrong-compared-body"] as const) {
        const f = fixture(t);
        let state = f.open();
        const candidate = capture(state, f.directory, "retained local history");
        const preserved = acceptPreservation(state, candidate);
        const receipt = corruption === "null" ? null : corruption === "malformed-json" ? "{" : JSON.stringify({
            ...preserved.receipt,
            ...(corruption === "wrong-request" ? {request: {...preserved.request, operation_id: randomUUID()}}
                : {variant: {...preserved.receipt.variant, sha256: "0".repeat(64)}}),
        });
        f.close();
        const database = SqliteDatabase.test(false, f.file);
        try {
            database.prepare("UPDATE archive_worker_operations SET receipt=? WHERE id=? AND state='accepted'")
                .run(receipt, preserved.pending.id);
        } finally { database.close(); }
        state = f.open();
        assert.throws(() => state.dependency(candidate.id, binding), corruption);
        assert.throws(() => state.prepare(candidate, "publish", publication(candidate, binding, preserved.revision),
            preserved.pending.id, preserved.comparison), corruption);
        assert.equal(state.nextOperation([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
        assert.deepEqual(f.query("SELECT kind,state FROM archive_worker_operations"), [{kind: "current", state: "accepted"}]);
        assert.deepEqual(f.query("SELECT * FROM archive_worker_coverage"), []);
        assert.deepEqual(state.body(candidate), Buffer.from("retained local history"));
        f.close();
    }
});

test("invalid persisted dependency is retained once without publication or a candidate hot loop", async (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "retained local history");
    const preserved = acceptPreservation(state, candidate);
    f.close();
    const database = SqliteDatabase.test(false, f.file);
    try { database.prepare("UPDATE archive_worker_operations SET receipt=NULL WHERE id=?").run(preserved.pending.id); }
    finally { database.close(); }
    const store = new ServerConfigStore(f.directory);
    t.mock.method(store, "connection", () => ({config: {url: origin, apiKey: "synthetic-key"}, generation}));
    t.mock.method(ArchiveClient.prototype, "binding", async () => ({binding, head: "1", capabilities: ["preserved_variants_v1"]}));
    const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No archive request is authorized by corrupt evidence"); });
    const engine = new ArchiveWorkerEngine(f.directory, store);
    try {
        await engine.step();
        await assert.doesNotReject(() => engine.step());
        const failed = f.query("SELECT state,attempts FROM archive_worker_candidates");
        assert.deepEqual(failed, [{state: "invalid", attempts: 1}]);
        assert.equal(engine.inspect().eligible, false);
        await engine.step();
        assert.deepEqual(f.query("SELECT state,attempts FROM archive_worker_candidates"), failed);
        assert.equal(network.mock.callCount(), 0);
        assert.deepEqual(f.open().body(candidate), Buffer.from("retained local history"));
        assert.deepEqual(f.query("SELECT kind FROM archive_worker_operations"), [{kind: "current"}]);
    } finally { engine.close(); }
});

for (const {kind, field} of [
    {kind: "publish", field: "metadata"}, {kind: "publish", field: "session_id"},
    {kind: "uploaded", field: "metadata"}, {kind: "uploaded", field: "session_id"},
    {kind: "current", field: "session_id"},
] as const) {
    for (const status of ["ready", "uncertain"] as const) {
        test(`stored ${status} ${kind} ${field}-only corruption cannot execute or acknowledge another candidate relationship`, (t) => {
            const f = fixture(t);
            let state = f.open();
            const candidate = capture(state, f.directory, "original local history");
            const revision = {binding, seq: "10"};
            const comparedBody = Buffer.from("different remote canonical body");
            const compared = {session_id: candidate.sessionId, revision, byte_length: comparedBody.length,
                sha256: createHash("sha256").update(comparedBody).digest("hex"), metadata: null, uploaded_at: "2026-01-01T00:00:00.000Z"};
            const request = kind === "publish" ? publication(candidate) : kind === "uploaded"
                ? {mode: "uploaded", binding, session_id: candidate.sessionId, operation_id: randomUUID(),
                    byte_length: candidate.byteLength, sha256: candidate.sha256, metadata: candidate.metadata}
                : {mode: "current", binding, session_id: candidate.sessionId, operation_id: randomUUID(), revision};
            state.prepare(candidate, kind, request, null, kind === "current"
                ? JSON.stringify({snapshot: compared, condition: {kind: "exact_base_revision", revision}}) : null);
            const pending = operation(state, candidate);
            assert.equal(pending.replayBlocked, false);
            if (status === "uncertain") state.markUncertain(pending.id);
            const successor = capture(state, f.directory, "independent successor history");
            const changedMetadata = field === "metadata" ? {title: "Corrupted"} : candidate.metadata;
            const changedSession = field === "session_id" ? "different-session" : candidate.sessionId;
            const corrupted = field === "metadata" ? {...request, metadata: changedMetadata} : {...request, session_id: changedSession};
            const raw = JSON.stringify(corrupted);
            const receiptFor = (wireRequest: unknown, sessionId: string, metadata: ArchiveMetadata | null) => kind === "publish"
                ? {request: wireRequest, revision: {binding, seq: "11"}}
                : {request: wireRequest, variant: {session_id: sessionId, variant_id: "variant", revision: {binding, seq: "11"},
                    byte_length: kind === "current" ? compared.byte_length : candidate.byteLength,
                    sha256: kind === "current" ? compared.sha256 : candidate.sha256,
                    metadata: kind === "current" ? compared.metadata : metadata, uploaded_at: "2026-01-02T00:00:00.000Z"},
                ...(kind === "current" ? {source_revision: revision, source_uploaded_at: compared.uploaded_at} : {})};
            const corruptedReceipt = receiptFor(corrupted, changedSession, changedMetadata);
            if (kind === "publish") decodeArchiveReceipt(corruptedReceipt);
            else decodeArchivePreservationReceipt(corruptedReceipt);
            const originalReceipt = receiptFor(request, candidate.sessionId, candidate.metadata);
            f.close();
            const database = SqliteDatabase.test(false, f.file);
            try { database.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?").run(raw, pending.id); }
            finally { database.close(); }
            state = f.open();
            assert.equal(state.nextOperation([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.deepEqual(f.query("SELECT state,replay_blocked,request FROM archive_worker_operations"), [{
                state: status === "uncertain" ? "blocked" : "invalid", replay_blocked: status === "uncertain" ? 1 : 0, request: raw,
            }]);
            assert.equal(state.accept(pending, originalReceipt, kind !== "current"), false,
                "the original late receipt cannot match overwritten owned request evidence");
            assert.equal(state.accept({...pending, request: raw}, corruptedReceipt, kind !== "current"), false,
                "wire-valid receipts for the corrupt relationship cannot certify the retained candidate");
            assert.deepEqual(state.body(candidate), Buffer.from("original local history"));
            assert.deepEqual(state.body(successor), Buffer.from("independent successor history"));
            assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
            if (status === "uncertain") {
                assert.equal(state.nextCandidate([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
                assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/);
                assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false},
                    "corrupt dispatched evidence blocks the native identity without unsafe receipt requests or a hot loop");
                state = f.open();
                assert.equal(state.nextOperation([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
                assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/);
            } else {
                assert.equal(state.nextCandidate([candidate.destination], Number.MAX_SAFE_INTEGER)?.id, successor.id);
                state.prepare(successor, "publish", publication(successor));
                const next = operation(state, successor);
                assert.equal(state.accept(pending, originalReceipt, kind !== "current"), false);
                assert.equal(operation(state, successor).id, next.id);
            }
            assert.deepEqual(state.body(successor), Buffer.from("independent successor history"));
        });
    }
}

for (const corruption of ["owned-metadata", "owned-session", "receipt-request"] as const) {
    test(`accepted canonical evidence rejects ${corruption} mismatch instead of authorizing a new base`, (t) => {
        const f = fixture(t);
        let state = f.open();
        const candidate = capture(state, f.directory, "base");
        const request = publication(candidate);
        state.prepare(candidate, "publish", request);
        const pending = operation(state, candidate);
        const receipt = {request, revision: {binding, seq: "1"}};
        assert.equal(state.accept(pending, receipt, true), true);
        const successor = capture(state, f.directory, "base with new history");
        const mismatched = corruption === "owned-session" ? {...request, session_id: "different-session"}
            : {...request, metadata: {title: "Corrupted"}};
        decodeArchiveReceipt({...receipt, request: mismatched});
        f.close();
        const database = SqliteDatabase.test(false, f.file);
        try {
            if (corruption === "receipt-request") database.prepare("UPDATE archive_worker_operations SET receipt=? WHERE id=?")
                .run(JSON.stringify({...receipt, request: mismatched}), pending.id);
            else database.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?").run(JSON.stringify(mismatched), pending.id);
        } finally { database.close(); }
        state = f.open();
        assert.throws(() => state.acceptedCanonical(successor, binding));
        assert.equal(state.nextOperation([successor.destination], Number.MAX_SAFE_INTEGER), undefined);
        assert.deepEqual(state.body(successor), Buffer.from("base with new history"));
        assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), [{candidate: candidate.id}]);
        assert.deepEqual(f.query("SELECT id,state FROM archive_worker_operations"), [{id: pending.id, state: "accepted"}]);
    });
}

test("accepted current preservation validates its owned native identity without equating remote and local fingerprints", (t) => {
    const f = fixture(t);
    let state = f.open();
    const candidate = capture(state, f.directory, "local candidate differs from remote");
    const preserved = acceptPreservation(state, candidate);
    assert.notEqual(preserved.receipt.variant.sha256, candidate.sha256);
    assert.notEqual(preserved.receipt.variant.byte_length, candidate.byteLength);
    assert.deepEqual(state.dependency(candidate.id, binding), {id: preserved.pending.id, comparison: preserved.comparison});
    f.close();
    const database = SqliteDatabase.test(false, f.file);
    try { database.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?")
        .run(JSON.stringify({...preserved.request, session_id: "different-session"}), preserved.pending.id); }
    finally { database.close(); }
    state = f.open();
    assert.throws(() => state.dependency(candidate.id, binding));
    assert.throws(() => state.prepare(candidate, "publish", publication(candidate, binding, preserved.revision),
        preserved.pending.id, preserved.comparison));
    assert.deepEqual(state.body(candidate), Buffer.from("local candidate differs from remote"));
    assert.deepEqual(f.query("SELECT kind,state FROM archive_worker_operations"), [{kind: "current", state: "accepted"}]);
    assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
});

test("uncertain or rejected preservation cannot satisfy a dependent publication", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local");
    const revision = {binding, seq: "1"};
    const request = {mode: "current", binding, session_id: candidate.sessionId, operation_id: randomUUID(), revision};
    const comparison = JSON.stringify({condition: {kind: "exact_base_revision", revision}});
    state.prepare(candidate, "current", request, null, comparison);
    const pending = operation(state, candidate);
    state.markUncertain(pending.id);
    assert.throws(() => state.prepare(candidate, "publish", publication(candidate, binding, revision), pending.id, comparison));
    state.reject(pending);
    assert.throws(() => state.prepare(candidate, "publish", publication(candidate, binding, revision), pending.id, comparison), /dependency/);
});

test("a stale dependent publication retires its preservation dependency and retains local bytes for fresh comparison", (t) => {
    const f = fixture(t);
    let state = f.open();
    const candidate = capture(state, f.directory, "local");
    const preserved = acceptPreservation(state, candidate);
    state.prepare(candidate, "publish", publication(candidate, binding, preserved.revision), preserved.pending.id, preserved.comparison);
    const pending = operation(state, candidate);
    state.reject(pending);
    state = f.open();
    assert.equal(state.dependency(candidate.id, binding), undefined);
    assert.equal(state.nextOperation([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(state.accept(pending, {}, true), false);
    assert.deepEqual(state.body(candidate), Buffer.from("local"));
});

test("generation change fences active publication and prevents old-generation accepted dependencies from selection", (t) => {
    const f = fixture(t);
    let state = f.open();
    const candidate = capture(state, f.directory, "local");
    state.bind(state.destinations()[0]!, binding);
    const preserved = acceptPreservation(state, candidate);
    state.prepare(candidate, "publish", publication(candidate, binding, preserved.revision), preserved.pending.id, preserved.comparison);
    const pending = operation(state, candidate);
    state.saveComparison(candidate.id, {revision: preserved.revision}, Buffer.from("remote"));
    const restored = {...binding, history_generation: "restored"};
    state.bind(state.destinations()[0]!, restored);
    state = f.open();
    assert.equal(state.dependency(candidate.id, restored), undefined);
    assert.equal(state.nextOperation([candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(state.comparison(candidate.id), undefined);
    assert.equal(state.accept(pending, {}, true), false);
    assert.deepEqual(state.body(candidate), Buffer.from("local"));
    assert.equal(state.nextCandidate([candidate.destination], Number.MAX_SAFE_INTEGER)?.id, candidate.id);
});

test("read-only inspection preserves a future operation deadline rather than exiting or waking its blocked candidate", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local");
    state.bind(state.destinations()[0]!, binding);
    state.authorize(generation, binding, []);
    state.prepare(candidate, "publish", publication(candidate));
    const pending = operation(state, candidate);
    const due = Date.now() + 300_000;
    state.defer("operations", pending.id, due, "network-backoff");
    f.close();
    const before = fs.readFileSync(f.file);
    const stat = fs.statSync(f.file);
    const files = fs.readdirSync(f.directory);
    mock.method(SqliteDatabase, "test", (readonly: boolean, file: string) => {
        assert.equal(readonly, true, "post-unlock inspect must never open a writer");
        return openDatabase(readonly, file);
    });
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: true, nextDue: due});
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, undefined), {eligible: false});
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readdirSync(f.directory), files);
});

test("inspection does not create an absent journal or migrate an existing legacy journal", (t) => {
    const f = fixture(t);
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false});
    assert.deepEqual(fs.readdirSync(f.directory), []);
    seedLegacy(f.directory);
    const before = fs.readFileSync(f.file);
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: true});
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(f.query("SELECT name FROM sqlite_master WHERE name LIKE 'archive_worker_%'"), []);
});

test("inspection gates local capture deadlines by current authorization and destination identity", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local");
    state.bind(state.destinations()[0]!, binding);
    state.authorize(generation, binding, []);
    assert.equal(ArchiveWorkerState.inspect(f.directory, connection).eligible, true);
    state.authorizationFailure(generation, true, 0);
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false});
    state.authorize(generation, {...binding, namespace_id: "other-namespace"}, []);
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false});
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, {config: {url: "https://other.example"}, generation}), {eligible: false});
    state.authorizationFailure(generation, false, Date.now() + 60_000);
    const authDue = state.authorization(generation).due;
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: true, nextDue: authDue});
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const captureDue = Date.now() + 10_000;
    state.defer("scopes", enqueue.id, captureDue, "scan-backoff");
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, undefined), {eligible: false});
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, {config: {url: "https://other.example"}, generation}), {eligible: false});
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: true, nextDue: authDue});
    state.authorize(generation, binding, []);
    state.defer("candidates", candidate.id, captureDue + 60_000, "candidate-backoff");
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: true, nextDue: captureDue});
    state.authorizationFailure(generation, true, 0);
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false});
    assert.deepEqual(state.body(candidate), Buffer.from("local"));
});

test("superseded unbound destinations do not inherit a new credential generation", (t) => {
    const f = fixture(t);
    const state = f.open();
    capture(state, f.directory, "local", "superseded-credentials", false);
    state.import(manifest(f.directory, "superseded-credentials"));
    state.authorize(generation, binding, []);
    assert.deepEqual(ArchiveWorkerState.inspect(f.directory, connection), {eligible: false});
});

// Regression checks below intentionally assert the required invariants, not current broken
// behavior. They identify review blockers until the in-progress state implementation fixes them.
test("migration keeps identical legacy capture IDs independently scheduled for every original destination", (t) => {
    const f = fixture(t);
    const journal = new ArchiveJournal(f.directory);
    const snapshot: ArchiveUploadSnapshot = {file: path.join(f.directory, "missing.jsonl"), sessionId: "session",
        body: Buffer.from("captured"), metadata: {title: "Title"}};
    try {
        const first = journal.capture(origin, binding, snapshot);
        const second = journal.capture("https://other.example", binding, snapshot);
        assert.equal(first, second, "legacy IDs intentionally exclude destination; their table keys include profile");
    } finally { journal.close(); }
    const state = f.open();
    assert.equal(state.destinations().length, 2);
    for (const destination of state.destinations()) {
        const candidate = state.nextCandidate([destination.id], Number.MAX_SAFE_INTEGER);
        assert.ok(candidate, `capture obligation lost for ${destination.origin}`);
        assert.deepEqual(state.body(candidate), snapshot.body);
    }
});

test("a dependency from another generation cannot authorize a newly bound publication", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local");
    state.bind(state.destinations()[0]!, binding);
    const preserved = acceptPreservation(state, candidate);
    const restored = {...binding, history_generation: "restored"};
    state.bind(state.destinations()[0]!, restored);
    assert.equal(state.dependency(candidate.id, restored), undefined);
    assert.throws(() => state.prepare(candidate, "publish", publication(candidate, restored,
        {binding: restored, seq: preserved.revision.seq}), preserved.pending.id, preserved.comparison),
    "durable dependency checks must reject the old binding, not rely only on selection callers");
});

test("accepted preservation authorizes only its exact compared revision, not any supplied publication base", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local");
    state.bind(state.destinations()[0]!, binding);
    const preserved = acceptPreservation(state, candidate);
    assert.throws(() => state.prepare(candidate, "publish", publication(candidate, binding,
        {binding, seq: "9007199254740994"}), preserved.pending.id, preserved.comparison),
    "copied comparison text must not authorize a different CAS base");
});

test("one unresolved operation per binding/native identity spans old and replacement credential destinations", (t) => {
    const f = fixture(t);
    const state = f.open();
    const first = capture(state, f.directory, "first", "old-credentials");
    state.bind(state.destinations().find((d) => d.id === first.destination)!, binding);
    state.prepare(first, "publish", publication(first));
    const second = capture(state, f.directory, "second", "new-credentials");
    state.bind(state.destinations().find((d) => d.id === second.destination)!, binding);
    assert.throws(() => state.prepare(second, "publish", publication(second)),
        "credential-generation destinations sharing a binding must share the native-ID operation lock");
});

function otherOriginCandidate(state: ArchiveWorkerState, directory: string, targetBinding: Binding, sessionId = "session") {
    const enqueue = {...manifest(directory, "other-origin-credentials"), origin: "https://other-origin.example"};
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    state.bind(state.destinations().find((entry) => entry.id === scope.destination)!, targetBinding);
    state.addSources(scope, [enqueue.source.sessionFile!], null, true);
    const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    assert.equal(source.scope, scope.id);
    state.capture(source, {file: source.file, sessionId, body: Buffer.from("other-origin successor"), metadata: {title: "Title"}});
    const database = SqliteDatabase.test(true, path.join(directory, "archive.sqlite"));
    try {
        const row = database.prepare("SELECT id FROM archive_worker_candidates WHERE destination=?").get(scope.destination) as {id: string};
        return {candidate: state.candidate(row.id), connection: {config: {url: enqueue.origin, apiKey: "other-origin-key"}, generation: enqueue.generation}};
    } finally { database.close(); }
}

for (const status of ["uncertain", "blocked"] as const) {
    test(`cross-origin ${status} dispatch retains same-binding/native exclusion without transferring origin authorization`, async (t) => {
        const f = fixture(t);
        let state = f.open();
        const first = capture(state, f.directory, "original-origin history");
        const request = publication(first);
        state.prepare(first, "publish", request);
        state.markUncertain(operation(state, first).id);
        const pending = operation(state, first);
        assert.equal(pending.dispatched, true);
        if (status === "blocked") {
            // Seed the durable blocked state with intact request evidence to isolate
            // scheduling/settlement from the separately tested corruption quarantine.
            const database = SqliteDatabase.test(false, f.file);
            try { database.prepare("UPDATE archive_worker_operations SET state='blocked',replay_blocked=1 WHERE id=?").run(pending.id); }
            finally { database.close(); }
        }
        const other = otherOriginCandidate(state, f.directory, binding);
        const second = other.candidate;
        state.authorize(other.connection.generation, binding, []);
        for (let restart = 0; restart < 2; restart++) {
            assert.equal(state.nextCandidate([second.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.throws(() => state.prepare(second, "publish", publication(second)), /unresolved/);
            assert.equal(state.nextOperation([second.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.deepEqual(ArchiveWorkerState.inspect(f.directory, other.connection), {eligible: false});
            assert.deepEqual(state.body(first), Buffer.from("original-origin history"));
            assert.deepEqual(state.body(second), Buffer.from("other-origin successor"));
            state = f.open();
        }
        const store = new ServerConfigStore(f.directory);
        t.mock.method(store, "connection", () => other.connection);
        const calls: string[] = [];
        t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo, init?: RequestInit) => {
            const target = new URL(String(url));
            calls.push(target.href);
            assert.equal(target.origin, other.connection.config.url, "B authorization cannot dispatch any request to origin A");
            assert.equal(target.pathname, "/v1/binding", "the shared native exclusion forbids B publication or comparison");
            assert.equal(new Headers(init?.headers).get("x-apikey"), other.connection.config.apiKey);
            const body = JSON.stringify({binding, head: "0", capabilities: []});
            return new Response(body, {headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
        });
        const engine = new ArchiveWorkerEngine(f.directory, store);
        try {
            await engine.step();
            await engine.step();
            assert.deepEqual(calls, [`${other.connection.config.url}/v1/binding`]);
            assert.deepEqual(engine.inspect(), {eligible: false});
            assert.deepEqual(f.query("SELECT state,dispatched,request FROM archive_worker_operations"),
                [{state: status, dispatched: 1, request: pending.request}]);
            assert.equal(state.accept(pending, {request, revision: {binding, seq: "1"}}, true), true);
            assert.equal(state.nextCandidate([second.destination], Number.MAX_SAFE_INTEGER)?.id, second.id);
            assert.equal(state.acceptedCanonical(second, binding), undefined,
                "binding-wide exclusion does not transfer origin-scoped canonical-base evidence");
            assert.deepEqual(ArchiveWorkerState.inspect(f.directory, other.connection), {eligible: true, nextDue: 0});
            assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), [{candidate: first.id}]);
            state.prepare(second, "publish", publication(second));
            assert.equal(operation(state, second).destination, second.destination);
            assert.deepEqual(state.body(second), Buffer.from("other-origin successor"));
        } finally { engine.close(); }
    });
}

for (const difference of ["server", "namespace", "history-generation", "native-id"] as const) {
    test(`cross-origin unresolved exclusion does not block a different ${difference}`, (t) => {
        const f = fixture(t);
        const state = f.open();
        const first = capture(state, f.directory, "original-origin history");
        state.prepare(first, "publish", publication(first));
        state.markUncertain(operation(state, first).id);
        const targetBinding = difference === "server" ? {...binding, server_id: "other-server"}
            : difference === "namespace" ? {...binding, namespace_id: "other-namespace"}
            : difference === "history-generation" ? {...binding, history_generation: "other-history"} : binding;
        const other = otherOriginCandidate(state, f.directory, targetBinding, difference === "native-id" ? "other-session" : "session");
        state.authorize(other.connection.generation, targetBinding, []);
        assert.equal(state.nextCandidate([other.candidate.destination], Number.MAX_SAFE_INTEGER)?.id, other.candidate.id);
        assert.deepEqual(ArchiveWorkerState.inspect(f.directory, other.connection), {eligible: true, nextDue: 0});
        state.prepare(other.candidate, "publish", publication(other.candidate, targetBinding));
        assert.equal(operation(state, other.candidate).state, "ready");
        assert.equal(operation(state, first).state, "uncertain");
        assert.deepEqual(state.body(first), Buffer.from("original-origin history"));
    });
}

for (const corruption of ["candidate-id", "request-id", "wire-binding", "malformed-json",
    "session-object", "server-object", "namespace-object", "generation-object"] as const) {
    test(`dispatched ${corruption} corruption reserves independent complete candidate/wire keys without hybrid identities`, (t) => {
        const f = fixture(t);
        let state = f.open();
        const original = capture(state, f.directory, "original dispatched history");
        const request = publication(original);
        state.prepare(original, "publish", request);
        state.markUncertain(operation(state, original).id);
        const pending = operation(state, original);
        const receipt = {request, revision: {binding, seq: "1"}};
        const wireBinding: Binding = {server_id: "wire-server", namespace_id: "wire-namespace", history_generation: "wire-history"};
        type Key = {binding: Binding; sessionId: string};
        const blocked: Key[] = [{binding, sessionId: original.sessionId}];
        const allowed: Key[] = [];
        let raw = pending.request;
        if (corruption === "candidate-id") {
            blocked.push({binding, sessionId: "candidate-disputed"});
            allowed.push({binding: wireBinding, sessionId: "candidate-disputed"});
        } else if (corruption === "request-id") {
            raw = JSON.stringify({...request, session_id: "wire-disputed"});
            blocked.push({binding, sessionId: "wire-disputed"});
            allowed.push({binding: wireBinding, sessionId: "wire-disputed"});
        } else if (corruption === "wire-binding") {
            raw = JSON.stringify({...request, binding: wireBinding, session_id: "wire-disputed"});
            blocked.push({binding: wireBinding, sessionId: "wire-disputed"});
            allowed.push({binding, sessionId: "wire-disputed"}, {binding: wireBinding, sessionId: original.sessionId},
                {binding: {...wireBinding, history_generation: binding.history_generation}, sessionId: "wire-disputed"});
        } else if (corruption === "malformed-json") {
            raw = "{";
            allowed.push({binding, sessionId: "unrelated-session"});
        } else {
            // json_extract(object) returns JSON text. Only json_type(...)=text may
            // grant a wire-key reservation; coercing an object would reserve this probe.
            const nonstring = {unexpected: corruption};
            if (corruption === "session-object") {
                raw = JSON.stringify({...request, binding: wireBinding, session_id: nonstring});
                allowed.push({binding: wireBinding, sessionId: JSON.stringify(nonstring)});
            } else {
                const field = corruption === "server-object" ? "server_id"
                    : corruption === "namespace-object" ? "namespace_id" : "history_generation";
                raw = JSON.stringify({...request, binding: {...wireBinding, [field]: nonstring}, session_id: "wire-disputed"});
                allowed.push({binding: {...wireBinding, [field]: JSON.stringify(nonstring)}, sessionId: "wire-disputed"});
            }
        }
        const database = SqliteDatabase.test(false, f.file);
        try {
            if (corruption === "candidate-id") database.prepare("UPDATE archive_worker_candidates SET session_id=? WHERE id=?")
                .run("candidate-disputed", original.id);
            else database.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?").run(raw, pending.id);
        } finally { database.close(); }
        assert.equal(state.nextOperation([original.destination], Number.MAX_SAFE_INTEGER), undefined);
        assert.deepEqual(f.query("SELECT state,dispatched,replay_blocked,request FROM archive_worker_operations"),
            [{state: "blocked", dispatched: 1, replay_blocked: 1, request: raw}]);
        let sequence = 0;
        const probe = (key: Key) => {
            const enqueue = {...manifest(f.directory, `probe-credentials-${++sequence}`), origin: `https://probe-${sequence}.example`};
            state.import(enqueue);
            const scope = state.scope(enqueue.id);
            state.bind(state.destinations().find((entry) => entry.id === scope.destination)!, key.binding);
            state.addSources(scope, [enqueue.source.sessionFile!], null, true);
            const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
            assert.equal(source.scope, scope.id);
            state.capture(source, {file: source.file, sessionId: key.sessionId, body: Buffer.from("independent probe history"), metadata: {title: "Probe"}});
            const row = f.query<{id: string; destination: string}>("SELECT id,destination FROM archive_worker_candidates")
                .find((entry) => entry.destination === scope.destination)!;
            return {candidate: state.candidate(row.id), key, connection: {config: {url: enqueue.origin}, generation: enqueue.generation}};
        };
        const blockedProbes = blocked.map(probe);
        const allowedProbes = allowed.map(probe);
        for (let restart = 0; restart < 2; restart++) {
            for (const entry of blockedProbes) {
                state.authorize(entry.connection.generation, entry.key.binding, []);
                assert.equal(state.nextCandidate([entry.candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
                assert.throws(() => state.prepare(entry.candidate, "publish", publication(entry.candidate, entry.key.binding)), /unresolved/);
                assert.deepEqual(ArchiveWorkerState.inspect(f.directory, entry.connection), {eligible: false});
                assert.deepEqual(state.body(entry.candidate), Buffer.from("independent probe history"));
            }
            for (const entry of allowedProbes) {
                state.authorize(entry.connection.generation, entry.key.binding, []);
                assert.equal(state.nextCandidate([entry.candidate.destination], Number.MAX_SAFE_INTEGER)?.id, entry.candidate.id);
                assert.deepEqual(ArchiveWorkerState.inspect(f.directory, entry.connection), {eligible: true, nextDue: 0});
            }
            assert.equal(state.accept(pending, receipt, true), false,
                "a late original receipt cannot clean up a corrupt owned candidate/request relationship");
            assert.deepEqual(f.query<{id: string; body: Buffer}>("SELECT id,body FROM archive_worker_candidates")
                .find((entry) => entry.id === original.id)?.body, Buffer.from("original dispatched history"));
            assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
            state = f.open();
        }
        for (const entry of allowedProbes) {
            state.prepare(entry.candidate, "publish", publication(entry.candidate, entry.key.binding));
            assert.equal(operation(state, entry.candidate).state, "ready");
        }
        for (const entry of blockedProbes) {
            assert.equal(state.nextCandidate([entry.candidate.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.throws(() => state.prepare(entry.candidate, "publish", publication(entry.candidate, entry.key.binding)), /unresolved/);
        }
    });
}

test("a new explicit capture after history rotation cannot reuse obsolete covered evidence", (t) => {
    const f = fixture(t);
    const state = f.open();
    const first = capture(state, f.directory, "local");
    state.bind(state.destinations()[0]!, binding);
    state.cover(first.id, {kind: "byte-coverage", revision: {binding, seq: "1"}});
    state.bind(state.destinations()[0]!, {...binding, history_generation: "restored"});
    const recaptured = capture(state, f.directory, "local");
    const ready = state.nextCandidate([recaptured.destination], Number.MAX_SAFE_INTEGER);
    assert.ok(ready, "new source capture needs current-generation reconciliation, not old coverage");
    assert.deepEqual(state.body(ready), Buffer.from("local"));
});

test("corrupt persisted comparison bytes cannot authorize candidate cleanup after coherent legacy metadata lookup", async (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "local");
    const remoteBody = Buffer.from("remote");
    const snapshot = {session_id: candidate.sessionId, revision: {binding, seq: "7"}, byte_length: remoteBody.length,
        sha256: createHash("sha256").update(remoteBody).digest("hex")};
    state.saveComparison(candidate.id, snapshot, remoteBody);
    f.close();
    const database = SqliteDatabase.test(false, f.file);
    try {
        // Simulate corruption after the verified download was committed, not malformed HTTP data.
        database.prepare("UPDATE archive_worker_comparisons SET body=? WHERE candidate=?")
            .run(Buffer.from("local"), candidate.id);
    } finally { database.close(); }
    const store = new ServerConfigStore(f.directory);
    t.mock.method(store, "connection", () => ({config: {url: origin, apiKey: "synthetic-key"}, generation}));
    t.mock.method(ArchiveClient.prototype, "binding", async () => ({binding, head: "7", capabilities: []}));
    t.mock.method(ArchiveClient.prototype, "list", async () => ({binding, next_cursor: null,
        sessions: [{...snapshot, metadata: candidate.metadata, uploaded_at: "2026-01-01T00:00:00Z"}]}));
    t.mock.method(ArchiveClient.prototype, "download", async () => { throw new Error("Unexpected new download"); });
    const engine = new ArchiveWorkerEngine(f.directory, store);
    try {
        await engine.step(); // Verify current credentials before using durable destination state.
        await engine.step(); // Match coherent list metadata to the stored download revision.
        assert.deepEqual(f.query("SELECT * FROM archive_worker_coverage"), [],
            "corrupt comparison bytes must not create false coverage");
        assert.deepEqual(f.open().body(candidate), Buffer.from("local"));
    } finally { engine.close(); }
});

test("candidate metadata lookups never select retained bodies before working reservation", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "retained bytes");
    const projections: string[] = [];
    const prepare = SqliteDatabase.prototype.prepare;
    t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        const projection = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+archive_worker_candidates\b/iu.exec(sql)?.[1];
        if (projection !== undefined) {
            projections.push(projection);
            assert.doesNotMatch(projection, /(?:^|,)\s*(?:\w+\.)?(?:\*|body)\s*(?:,|$)/iu,
                "candidate()/nextCandidate() must project metadata, not fetch a BLOB that the decoder ignores");
        }
        return prepare.call(this, sql);
    });
    assert.deepEqual(state.candidate(candidate.id), candidate);
    assert.deepEqual(state.nextCandidate([candidate.destination], Number.MAX_SAFE_INTEGER), candidate);
    assert.ok(projections.length >= 2);
    assert.equal(state.workingAvailable(), ARCHIVE_WORKING_BYTES);
});

test("understated retained byte length fails scalar preflight before any unreserved BLOB read", (t) => {
    const f = fixture(t);
    const state = f.open();
    const candidate = capture(state, f.directory, "x");
    assert.equal(candidate.byteLength, 1);
    const database = SqliteDatabase.test(false, f.file);
    try { database.prepare("UPDATE archive_worker_candidates SET body=zeroblob(?) WHERE id=?").run(MAX_ARCHIVE_BYTES, candidate.id); }
    finally { database.close(); }
    let bodyReads = 0;
    const prepare = SqliteDatabase.prototype.prepare;
    const instrumentation = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        const projection = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+archive_worker_candidates\b/iu.exec(sql)?.[1];
        if (projection !== undefined && /(?:^|,)\s*(?:\w+\.)?(?:\*|body)\s*(?:,|$)/iu.test(projection)) {
            bodyReads++;
            throw new Error("Unreserved retained body read");
        }
        return prepare.call(this, sql);
    });
    const release = state.reserve(candidate.byteLength);
    try {
        assert.throws(() => state.body(candidate), /body|length|integrity/i);
        assert.equal(bodyReads, 0, "length(body) must reject the 64 MiB BLOB before SELECT body can materialize it");
    } finally {
        instrumentation.mock.restore();
        release();
    }
    assert.deepEqual(f.query("SELECT byte_length,length(body) AS stored_length,state FROM archive_worker_candidates"),
        [{byte_length: 1, stored_length: MAX_ARCHIVE_BYTES, state: "ready"}]);
    assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
    assert.deepEqual(f.query("SELECT id FROM archive_worker_operations"), []);
});

test("duplicate capture reserves its retained-body read after evicting disposable comparison bytes", (t) => {
    const f = fixture(t);
    const state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    state.addSources(scope, [enqueue.source.sessionFile!], null, true);
    const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    const metadata = {title: "Original"};
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < MAX_ARCHIVE_BYTES; offset += chunk.length) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const id = createHash("sha256").update(JSON.stringify([scope.destination, source.file, "session", sha256, metadata])).digest("hex");
    const snapshot = {session_id: "session", revision: {binding, seq: "1"}, byte_length: MAX_ARCHIVE_BYTES, sha256};
    const database = SqliteDatabase.test(false, f.file);
    try {
        database.transaction(() => {
            database.prepare(`INSERT INTO archive_worker_candidates(id,destination,session_id,source,byte_length,sha256,metadata,body)
                VALUES (?,?,?,?,?,?,?,zeroblob(?))`).run(id, scope.destination, "session", source.file, MAX_ARCHIVE_BYTES,
                sha256, JSON.stringify(metadata), MAX_ARCHIVE_BYTES);
            database.prepare("INSERT INTO archive_worker_comparisons(candidate,snapshot,body) VALUES (?,?,zeroblob(?))")
                .run(id, JSON.stringify(snapshot), MAX_ARCHIVE_BYTES);
        }).immediate();
    } finally { database.close(); }
    assert.equal(state.workingAvailable(), MAX_ARCHIVE_BYTES);
    const releaseInput = state.reserve(MAX_ARCHIVE_BYTES);
    // This one representative input really is 64 MiB. The two persisted fixture BLOBs
    // use zeroblob; hashing uses a reusable 64 KiB buffer instead of another large input.
    const incoming = Buffer.alloc(MAX_ARCHIVE_BYTES);
    let bodyReads = 0;
    const prepare = SqliteDatabase.prototype.prepare;
    const instrumentation = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        const projection = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+archive_worker_candidates\b/iu.exec(sql)?.[1];
        if (projection !== undefined && /(?:^|,)\s*(?:\w+\.)?(?:\*|body)\s*(?:,|$)/iu.test(projection)) {
            bodyReads++;
            assert.equal(state.hasComparisonBody(id), false, "dispose of cached comparison bytes before materializing the retained duplicate");
            assert.equal(state.workingAvailable(), 0, "both 64 MiB input and retained-body materializations must already be reserved");
        }
        return prepare.call(this, sql);
    });
    try {
        assert.equal(state.capture(source, {file: source.file, sessionId: "session", body: incoming, metadata}), true);
        assert.ok(bodyReads > 0, "duplicate acknowledgment still verifies the retained bytes");
        assert.equal(state.workingAvailable(), MAX_ARCHIVE_BYTES, "the retained-body reservation is released, not the caller's input reservation");
    } finally {
        instrumentation.mock.restore();
        releaseInput();
    }
    assert.equal(state.workingAvailable(), ARCHIVE_WORKING_BYTES);
    assert.deepEqual(state.comparison(id), {snapshot, body: null, cursor: null});
    assert.deepEqual(f.query("SELECT state FROM archive_worker_sources"), [{state: "captured"}]);
    assert.deepEqual(f.query("SELECT length(body) AS bytes FROM archive_worker_candidates"), [{bytes: MAX_ARCHIVE_BYTES}]);
    assert.deepEqual(f.query("SELECT id FROM archive_worker_operations"), []);
    assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
});

for (const field of ["metadata", "session_id", "source"] as const) {
    test(`native candidate ${field} corruption fails closed before duplicate source acknowledgment or history mutation`, (t) => {
        const f = fixture(t);
        const state = f.open();
        const first = manifest(f.directory);
        state.import(first);
        const scope = state.scope(first.id);
        state.bind(state.destinations()[0]!, binding);
        state.addSources(scope, [first.source.sessionFile!], null, true);
        const snapshot: ArchiveUploadSnapshot = {file: first.source.sessionFile!, sessionId: "session",
            body: Buffer.from("retained original bytes"), metadata: {title: "Original"}};
        assert.equal(state.capture(state.nextSource(Number.MAX_SAFE_INTEGER)!, snapshot), true);
        const candidate = state.nextCandidate([scope.destination], Number.MAX_SAFE_INTEGER)!;
        assert.ok(candidate);
        const repeated = manifest(f.directory);
        state.import(repeated);
        state.addSources(state.scope(repeated.id), [snapshot.file], null, true);
        const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
        const corrupted = field === "metadata" ? JSON.stringify({title: "Corrupted"})
            : field === "session_id" ? "different-session" : path.join(f.directory, "different.jsonl");
        const database = SqliteDatabase.test(false, f.file);
        try { database.prepare(`UPDATE archive_worker_candidates SET ${field}=? WHERE id=?`).run(corrupted, candidate.id); }
        finally { database.close(); }
        assert.throws(() => state.candidate(candidate.id), "metadata decoding verifies the stored native fingerprint");
        assert.throws(() => state.nextCandidate([scope.destination], Number.MAX_SAFE_INTEGER));
        assert.throws(() => state.body(candidate), "a previously decoded candidate cannot bypass fresh persisted metadata validation");
        assert.throws(() => state.prepare(candidate, "publish", publication(candidate)));
        assert.throws(() => state.cover(candidate.id, {kind: "byte-coverage", revision: {binding, seq: "1"}}));
        assert.throws(() => state.capture(source, snapshot), "reenqueuing the original input must not acknowledge corrupt retained metadata");
        assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.id, source.id);
        assert.deepEqual(f.query("SELECT state FROM archive_worker_sources WHERE state='ready'"), [{state: "ready"}]);
        assert.deepEqual(f.query("SELECT id,state,body FROM archive_worker_candidates"),
            [{id: candidate.id, state: "ready", body: snapshot.body}]);
        assert.deepEqual(f.query("SELECT id FROM archive_worker_operations"), []);
        assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
        assert.deepEqual(f.query(`SELECT ${field} AS corrupted FROM archive_worker_candidates`), [{corrupted}]);
    });
}

test("manifest collisions are typed and isolated while SQLite failures retain their original identity", (t) => {
    const f = fixture(t);
    const state = f.open();
    const first = manifest(f.directory);
    assert.equal(state.import(first), true);
    const original = state.scope(first.id);
    assert.throws(() => state.import({...first, source: {...first.source, sessionFile: path.join(f.directory, "different.jsonl")}}),
        ArchiveManifestError);
    assert.deepEqual(state.scope(first.id), original);
    assert.throws(() => state.import({...first, id: randomUUID(), origin: "not-a-url"}), ArchiveManifestError);
    const healthy = manifest(f.directory);
    assert.equal(state.import(healthy), true, "a poisoned manifest does not prevent independent healthy admission");
    assert.deepEqual(state.scope(first.id), original);
    const failed = manifest(f.directory, "new-destination");
    const destinations = state.destinations();
    const fault = Object.assign(new Error("injected SQLite I/O failure"), {code: "SQLITE_IOERR"});
    const prepare = SqliteDatabase.prototype.prepare;
    const injection = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        if (sql.includes("INSERT INTO archive_worker_scopes")) throw fault;
        return prepare.call(this, sql);
    });
    assert.throws(() => state.import(failed), (error: unknown) => error === fault && !(error instanceof ArchiveManifestError));
    injection.mock.restore();
    assert.deepEqual(state.destinations(), destinations, "the failed transaction cannot leave a destination behind");
    assert.throws(() => state.scope(failed.id), /Missing archive scope/);
    assert.equal(state.import(healthy), true);
    assert.deepEqual(state.scope(first.id), original);
});

test("scope admission allows exactly 1024 unfinished scopes, replays at capacity, and releases completed slots", (t) => {
    const f = fixture(t);
    const state = f.open();
    const first = manifest(f.directory);
    state.import(first);
    state.addSources(state.scope(first.id), [first.source.sessionFile!], null, true);
    // Seed valid unfinished descriptors in one transaction, then exercise the public boundary.
    const database = SqliteDatabase.test(false, f.file);
    try {
        const insert = database.prepare("INSERT INTO archive_worker_scopes(id,destination,manifest,source) VALUES (?,?,?,?)");
        database.transaction(() => {
            for (let index = 0; index < 1022; index++) {
                const item = manifest(f.directory);
                insert.run(item.id, state.scope(first.id).destination, JSON.stringify(item), JSON.stringify(item.source));
            }
        }).immediate();
    } finally { database.close(); }
    const boundary = manifest(f.directory);
    assert.equal(state.import(boundary), true);
    const overflow = manifest(f.directory, "another-connection");
    const destinations = state.destinations();
    assert.equal(state.import(overflow), false);
    assert.deepEqual(state.destinations(), destinations, "rejected admission must not leave an orphan destination");
    assert.throws(() => state.scope(overflow.id), /Missing archive scope/);
    assert.equal(state.import(boundary), true, "idempotent replay consumes no additional slot");
    assert.throws(() => state.import({...boundary, generation: "collision"}), /collision/);
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_scopes WHERE state IN ('ready','scanned')"), [{n: 1024}]);
    state.finishSource(state.nextSource(Number.MAX_SAFE_INTEGER)!.id, "source-lost");
    assert.equal(state.import(overflow), true, "a completed scanned scope releases one admission slot");
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_scopes WHERE state IN ('ready','scanned')"), [{n: 1024}]);
});

test("source admission is exact at 10000 and refuses a whole page without advancing its cursor", (t) => {
    const f = fixture(t);
    const state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    const files = Array.from({length: 9999}, (_, index) => path.join(f.directory, `${index}.jsonl`));
    assert.equal(state.addSources(scope, files, "before-page", false), true);
    const lastFile = path.join(f.directory, "last.jsonl");
    const directory = {path: path.join(f.directory, "retry-directory"), retryCursor: "retry-token"};
    assert.equal(state.addSources(state.scope(scope.id), [lastFile], "after-page", true, [directory]), false);
    assert.equal(state.scope(scope.id).cursor, "before-page");
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_sources"), [{n: 9999}]);
    assert.equal(state.addSources(state.scope(scope.id), [lastFile, lastFile], "last-page", false), true);
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_sources WHERE state='ready'"), [{n: 10000}]);
    assert.equal(state.addSources(state.scope(scope.id), [lastFile], "last-page", false), true);
    assert.equal(state.addSources(state.scope(scope.id), [], "unadmitted", true, [directory]), false);
    assert.equal(state.scope(scope.id).cursor, "last-page");
    state.finishSource(state.nextSource(Number.MAX_SAFE_INTEGER)!.id, "invalid");
    assert.equal(state.addSources(state.scope(scope.id), [], null, true, [directory]), true);
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_sources WHERE state='ready'"), [{n: 10000}]);
    assert.deepEqual(f.query("SELECT kind,retry_cursor FROM archive_worker_sources WHERE kind='directory'"),
        [{kind: "directory", retry_cursor: "retry-token"}]);
    assert.equal(state.addSources(state.scope(scope.id), [], null, true, [directory]), true,
        "an already admitted directory issue must replay successfully at capacity");
});

test("duplicate directory issues consume only their distinct admission slots", (t) => {
    const f = fixture(t);
    const state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    state.addSources(scope, Array.from({length: 9999}, (_, index) => path.join(f.directory, `${index}.jsonl`)), "before", false);
    const issue = {path: path.join(f.directory, "retry-directory"), retryCursor: "retry-token"};
    assert.equal(state.addSources(state.scope(scope.id), [], null, true, [issue, issue]), true);
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_sources WHERE state='ready'"), [{n: 10000}]);
});

test("source page insertion and cursor advancement roll back together on a commit-path failure", (t) => {
    const f = fixture(t);
    let state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    state.addSources(scope, [], "before", false);
    const before = f.query("SELECT * FROM archive_worker_scopes");
    const prepare = SqliteDatabase.prototype.prepare;
    const injection = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        if (sql.includes("UPDATE archive_worker_scopes SET cursor=")) throw new Error("injected cursor failure");
        return prepare.call(this, sql);
    });
    assert.throws(() => state.addSources(state.scope(scope.id), [enqueue.source.sessionFile!], "after", true,
        [{path: f.directory, retryCursor: "retry"}]), /injected cursor failure/);
    injection.mock.restore();
    state = f.open();
    assert.deepEqual(f.query("SELECT * FROM archive_worker_scopes"), before);
    assert.deepEqual(f.query("SELECT * FROM archive_worker_sources"), []);
    assert.equal(state.addSources(state.scope(scope.id), [enqueue.source.sessionFile!], "after", true), true);
});

test("bounded comparison staging evicts only cached bytes and atomically preserves other page continuations", (t) => {
    const f = fixture(t);
    const state = f.open();
    const first = capture(state, f.directory, "first");
    const second = capture(state, f.directory, "second");
    const body = Buffer.from("remote");
    const snapshot = {session_id: "session", revision: {binding, seq: "1"}, byte_length: body.length,
        sha256: createHash("sha256").update(body).digest("hex")};
    state.saveComparison(first.id, snapshot, body);
    state.comparisonCursor(first.id, "second-list-page");
    const prepare = SqliteDatabase.prototype.prepare;
    const injection = t.mock.method(SqliteDatabase.prototype, "prepare", function(this: SqliteDatabase, sql: string) {
        if (sql.includes("INSERT INTO archive_worker_comparisons")) throw new Error("injected staging failure");
        return prepare.call(this, sql);
    });
    assert.throws(() => state.saveComparison(second.id, snapshot, body), /injected staging failure/);
    injection.mock.restore();
    assert.deepEqual(state.comparison(first.id), {snapshot, body, cursor: "second-list-page"});
    assert.equal(state.comparison(second.id), undefined);
    state.saveComparison(second.id, snapshot, body);
    assert.deepEqual(state.comparison(first.id), {snapshot, body: null, cursor: "second-list-page"});
    assert.deepEqual(state.comparison(second.id), {snapshot, body, cursor: null});
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_comparisons"), [{n: 2}]);
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_comparisons WHERE body IS NOT NULL"), [{n: 1}]);
    assert.deepEqual(state.body(first), Buffer.from("first"));
    assert.deepEqual(state.body(second), Buffer.from("second"));
    const release = state.reserve(ARCHIVE_WORKING_BYTES - body.length);
    assert.throws(() => state.reserve(1), /allowance exhausted/, "persisted staging shares the working allowance");
    state.clearComparison(second.id);
    const reclaimed = state.reserve(body.length);
    reclaimed(); release();
});

test("grandfathered legacy bodies do not consume working reservations, and accepted work releases logical admission", (t) => {
    const f = fixture(t);
    let state = f.open();
    const original = capture(state, f.directory, "original");
    f.close();
    const database = SqliteDatabase.test(false, f.file);
    const requests: Publication[] = [];
    // SQLite writes zero-filled BLOBs without allocating 512 MiB in Node. The hash uses a
    // reusable 64 KiB chunk; no test query ever materializes these large legacy bodies.
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < MAX_ARCHIVE_BYTES; offset += chunk.length) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const profile = JSON.stringify([origin, binding.server_id, binding.namespace_id, binding.history_generation]);
    try {
        const insert = database.prepare("INSERT INTO archive_uploads(profile,session_id,source,pending,body) VALUES (?,?,?,?,zeroblob(?))");
        database.transaction(() => {
            for (let index = 0; index < 8; index++) {
                const request: Publication = {binding, session_id: `legacy-${index}`, operation_id: randomUUID(),
                    condition: {kind: "absent"}, byte_length: MAX_ARCHIVE_BYTES, sha256};
                requests.push(request);
                insert.run(profile, request.session_id, path.join(f.directory, `${index}.jsonl`), JSON.stringify(request, null, 2), MAX_ARCHIVE_BYTES);
            }
        }).immediate();
    } finally { database.close(); }
    state = f.open();
    assert.deepEqual(f.query("SELECT SUM(length(body)) AS n FROM archive_uploads"), [{n: 512 * 1024 * 1024}]);
    const release = state.reserve(ARCHIVE_WORKING_BYTES);
    assert.throws(() => state.reserve(1), /allowance exhausted/);
    release();
    const first = state.reserve(MAX_ARCHIVE_BYTES);
    release(); // Releasing an old reservation twice must not release someone else's bytes.
    const second = state.reserve(MAX_ARCHIVE_BYTES);
    assert.throws(() => state.reserve(1), /allowance exhausted/);
    first(); second();
    for (const invalid of [-1, 0.5, Number.NaN, Infinity]) assert.throws(() => state.reserve(invalid), /allowance exhausted/);
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    state.addSources(state.scope(enqueue.id), [enqueue.source.sessionFile!], null, true);
    const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    const incoming: ArchiveUploadSnapshot = {file: source.file, sessionId: "session", body: Buffer.from("new"), metadata: {title: "Title"}};
    assert.equal(state.capture(source, incoming), false, "new capture cannot exceed the grandfathered backlog");
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.id, source.id);
    assert.equal(state.capture(source, {...incoming, body: Buffer.from("original")}), true,
        "retained duplicate acknowledgment remains available above the admission budget");
    assert.deepEqual(state.body(original), Buffer.from("original"));
    const destinations = state.destinations().map((item) => item.id);
    let accepted = 0;
    for (let pending = state.nextOperation(destinations, Number.MAX_SAFE_INTEGER); pending;
        pending = state.nextOperation(destinations, Number.MAX_SAFE_INTEGER)) {
        const remoteId = (JSON.parse(pending.request) as Publication).operation_id;
        const request = requests.find((item) => item.operation_id === remoteId)!;
        assert.ok(request);
        assert.equal(state.accept(pending, {request, revision: {binding, seq: String(++accepted)}}, true), true);
    }
    assert.equal(accepted, 8);
    const retry = manifest(f.directory);
    state.import(retry);
    state.addSources(state.scope(retry.id), [retry.source.sessionFile!], null, true);
    assert.equal(state.capture(state.nextSource(Number.MAX_SAFE_INTEGER)!, incoming), true,
        "completed legacy bodies must release both physical ownership and logical unfinished-work admission");
});

test("legacy remote operation UUIDs may repeat across destinations without collapsing internal operation identities", (t) => {
    const f = fixture(t);
    const legacy = seedLegacy(f.directory);
    const otherBinding = {...binding, namespace_id: "independent-namespace"};
    const otherOrigin = "https://independent.example";
    const otherBody = Buffer.from("independent frozen bytes");
    const other: Publication = {...legacy.request, binding: otherBinding, byte_length: otherBody.length,
        sha256: createHash("sha256").update(otherBody).digest("hex")};
    const raw = JSON.stringify(other, null, 4);
    const database = SqliteDatabase.test(false, f.file);
    try {
        const profile = JSON.stringify([otherOrigin, otherBinding.server_id, otherBinding.namespace_id, otherBinding.history_generation]);
        database.prepare("INSERT INTO archive_uploads VALUES (?,?,?,NULL,?,?)")
            .run(profile, other.session_id, path.join(f.directory, "other-missing.jsonl"), raw, otherBody);
    } finally { database.close(); }
    let state = f.open();
    const destinations = state.destinations();
    assert.equal(destinations.length, 2);
    const firstDestination = destinations.find((item) => item.origin === origin)!;
    const secondDestination = destinations.find((item) => item.origin === otherOrigin)!;
    const first = state.nextOperation([firstDestination.id], Number.MAX_SAFE_INTEGER);
    const second = state.nextOperation([secondDestination.id], Number.MAX_SAFE_INTEGER);
    assert.ok(first);
    assert.ok(second, "same remote UUID is not a global worker operation identity");
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.candidate, second.candidate);
    assert.equal(first.request, legacy.raw);
    assert.equal(second.request, raw);
    assert.equal(JSON.parse(first.request).operation_id, JSON.parse(second.request).operation_id);
    assert.deepEqual(state.body(state.candidate(first.candidate)), legacy.body);
    assert.deepEqual(state.body(state.candidate(second.candidate)), otherBody);
    assert.equal(state.accept(first, {request: legacy.request, revision: {binding, seq: "3"}}, true), true);
    state = f.open();
    assert.equal(state.nextOperation([firstDestination.id], Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(state.nextOperation([secondDestination.id], Number.MAX_SAFE_INTEGER)?.request, raw);
    assert.deepEqual(state.body(state.candidate(second.candidate)), otherBody);
});

test("legacy completion releases exact bodies while preserving prior accepted receipt and worker request history", (t) => {
    const f = fixture(t);
    const file = path.join(f.directory, "missing.jsonl");
    const journal = new ArchiveJournal(f.directory);
    let accepted: {request: Publication; revision: Revision};
    let pending: Publication;
    try {
        const first = journal.prepare(origin, binding, {file, sessionId: "session", body: Buffer.from("first"), metadata: {}});
        assert.equal(first.kind, "pending");
        if (first.kind !== "pending") throw new Error("Expected first publication");
        accepted = {request: first.request, revision: {binding, seq: "1"}};
        journal.accept(origin, accepted);
        const next = journal.prepare(origin, binding, {file, sessionId: "session", body: Buffer.from("first-next"), metadata: {}});
        assert.equal(next.kind, "pending");
        if (next.kind !== "pending") throw new Error("Expected successor publication");
        pending = next.request;
        journal.capture(origin, binding, {file, sessionId: "session", body: Buffer.from("independent"), metadata: {}});
    } finally { journal.close(); }
    let state = f.open();
    const destinations = state.destinations().map((item) => item.id);
    const operation = state.nextOperation(destinations, Number.MAX_SAFE_INTEGER)!;
    const prior = f.query<{accepted: string; pending: string}>("SELECT accepted,pending FROM archive_uploads")[0]!;
    assert.equal(prior.accepted, JSON.stringify(accepted));
    assert.equal(state.accept(operation, {request: pending, revision: {binding, seq: "2"}}, true), true);
    assert.deepEqual(f.query("SELECT accepted,pending,body FROM archive_uploads"),
        [{accepted: prior.accepted, pending: null, body: null}]);
    assert.deepEqual(f.query("SELECT request FROM archive_worker_operations"), [{request: prior.pending}]);
    const retained = state.nextCandidate(destinations, Number.MAX_SAFE_INTEGER)!;
    assert.deepEqual(state.body(retained), Buffer.from("independent"));
    assert.equal(f.query("SELECT capture_id FROM archive_captures").length, 1);
    state.cover(retained.id, {kind: "byte-coverage", revision: {binding, seq: "3"}});
    assert.deepEqual(f.query("SELECT capture_id FROM archive_captures"), []);
    state = f.open();
    assert.equal(state.nextOperation(destinations, Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(state.nextCandidate(destinations, Number.MAX_SAFE_INTEGER), undefined);
    assert.deepEqual(f.query("SELECT request FROM archive_worker_operations"), [{request: prior.pending}]);
});

test("late legacy completion cannot release a newer pending request or its body in the same profile row", (t) => {
    const f = fixture(t);
    const legacy = seedLegacy(f.directory);
    let state = f.open();
    const destinations = state.destinations().map((item) => item.id);
    const old = state.nextOperation(destinations, Number.MAX_SAFE_INTEGER)!;
    const newerBody = Buffer.from("newer pending bytes");
    const newer: Publication = {...legacy.request, operation_id: randomUUID(), byte_length: newerBody.length,
        sha256: createHash("sha256").update(newerBody).digest("hex")};
    const raw = JSON.stringify(newer, null, 4);
    const database = SqliteDatabase.test(false, f.file);
    try { database.prepare("UPDATE archive_uploads SET pending=?,body=? WHERE session_id='session'").run(raw, newerBody); }
    finally { database.close(); }
    assert.equal(state.accept(old, {request: legacy.request, revision: {binding, seq: "1"}}, true), true);
    assert.deepEqual(f.query("SELECT pending,body FROM archive_uploads WHERE session_id='session'"), [{pending: raw, body: newerBody}]);
    state = f.open();
    const current = state.nextOperation(destinations, Number.MAX_SAFE_INTEGER)!;
    assert.ok(current);
    assert.equal(current.request, raw);
    assert.deepEqual(state.body(state.candidate(current.candidate)), newerBody);
    assert.equal(state.accept(old, {}, true), false);
    assert.deepEqual(state.body(state.candidate(current.candidate)), newerBody);
});

function ancestryFixture(t: TestContext) {
    const f = fixture(t);
    const state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    state.bind(state.destinations()[0]!, binding);
    const files = ["child", "parent", "duplicate", "unrelated"].map((name) => path.join(f.directory, `${name}.jsonl`));
    state.addSources(scope, files, null, true);
    const child = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    assert.equal(child.file, files[0]);
    const rows = f.query<{id: number; file: string}>("SELECT id,file FROM archive_worker_sources");
    const id = (file: string) => rows.find((row) => row.file === file)!.id;
    const parentEvidence: ArchiveSourceEvidence = {file: files[1]!, session: {sessionId: "P", main: false,
        identityConflict: false, childKind: SessionKind.Subagent, parentAgentIdentifier: "session", rootSessionId: "session"}};
    const childEvidence: ArchiveSourceEvidence = {file: child.file, session: {sessionId: "child", main: false,
        identityConflict: false, childKind: SessionKind.Subagent, parentAgentIdentifier: "P", rootSessionId: "session"}};
    const dependencies = {files: [files[1]!, child.file], sessionIds: ["P"]};
    state.observeSource(id(parentEvidence.file), parentEvidence);
    state.observeSource(child.id, childEvidence, dependencies);
    const snapshot: ArchiveUploadSnapshot = {file: child.file, sessionId: "child", body: Buffer.from("original child history"),
        metadata: {kind: SessionKind.Subagent, root_session_id: "session"}};
    assert.equal(state.capture(child, snapshot), true);
    const candidate = state.nextCandidate([scope.destination], Number.MAX_SAFE_INTEGER)!;
    assert.ok(candidate);
    const association = f.query<{candidate: string; source: number; dependencies: string; dependency_key: string}>(
        "SELECT candidate,source,dependencies,dependency_key FROM archive_worker_candidate_sources")[0]!;
    assert.equal(association.candidate, candidate.id);
    assert.equal(association.source, child.id);
    assert.deepEqual(JSON.parse(association.dependencies), {files: [parentEvidence.file], sessionIds: ["P"]});
    const observation = f.query<{id: number; dependency_key: string}>("SELECT id,dependency_key FROM archive_worker_sources")
        .find((row) => row.id === child.id)!;
    assert.equal(association.dependency_key, observation.dependency_key);
    return {...f, state, scope, child, files, id, candidate, snapshot, parentEvidence, childEvidence, dependencies, association};
}

for (const mutation of ["duplicate-parent", "changed-parent-id"] as const) {
    for (const status of ["ready", "uncertain"] as const) {
        test(`ancestry guard handles ${status} operations before source review after ${mutation}`, (t) => {
            const f = ancestryFixture(t);
            let state = f.state;
            const request = publication(f.candidate);
            state.prepare(f.candidate, "publish", request);
            const pending = operation(state, f.candidate);
            if (status === "uncertain") state.markUncertain(pending.id);
            else {
                state.defer("operations", pending.id, 0, "pre-dispatch-retry");
                assert.deepEqual(f.query("SELECT attempts,dispatched FROM archive_worker_operations"), [{attempts: 1, dispatched: 0}]);
            }
            if (mutation === "duplicate-parent") {
                state.observeSource(f.id(f.files[2]!), {...f.parentEvidence, file: f.files[2]!});
            } else {
                state.observeSource(f.id(f.parentEvidence.file), {...f.parentEvidence,
                    session: {...f.parentEvidence.session, sessionId: "renamed-P"}});
            }
            state = f.open();
            // Do not enumerate sources: the execution guard cannot wait for the bounded review pass.
            assert.equal(f.query<{id: number; state: string}>("SELECT id,state FROM archive_worker_sources")
                .find((row) => row.id === f.child.id)?.state, "captured");
            const executable = state.nextOperation([f.scope.destination], Number.MAX_SAFE_INTEGER);
            if (status === "ready") {
                assert.equal(executable, undefined);
            } else {
                assert.equal(executable?.id, pending.id);
                assert.equal(executable?.state, "uncertain");
                assert.equal(executable?.request, pending.request, "the immutable request remains available for receipt lookup");
                // Unknown receipts do not prove a dispatched request had no remote effect.
                state.replay(pending.id, Date.now() + 5000);
                const recovery = state.nextOperation([f.scope.destination], Number.MAX_SAFE_INTEGER);
                assert.equal(recovery?.id, pending.id);
                assert.equal(recovery?.state, "uncertain");
                assert.equal(recovery?.dispatched, true);
            }
            assert.deepEqual(f.query("SELECT state,request FROM archive_worker_operations"),
                [{state: status === "ready" ? "fenced" : "uncertain", request: pending.request}]);
            assert.equal(state.nextCandidate([f.scope.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.throws(() => state.prepare(f.candidate, "publish", publication(f.candidate)), /ancestry/);
            assert.deepEqual(state.body(f.candidate), f.snapshot.body);
            assert.deepEqual(f.query("SELECT candidate FROM archive_worker_coverage"), []);
        });
    }
}

for (const kind of ["publish", "uploaded", "current"] as const) {
    for (const change of ["before-unknown", "after-unknown"] as const) {
        test(`dispatched ${kind} survives ancestry change ${change}, restart, and unknown receipts without releasing its successor`, (t) => {
            const f = ancestryFixture(t);
            let state = f.state;
            const revision = {binding, seq: "10"};
            const compared = {session_id: f.candidate.sessionId, revision, byte_length: 6,
                sha256: createHash("sha256").update("remote").digest("hex"), metadata: null, uploaded_at: "2026-01-01T00:00:00.000Z"};
            const comparison = JSON.stringify({snapshot: compared, condition: {kind: "exact_base_revision", revision}});
            const request = kind === "publish" ? publication(f.candidate) : kind === "uploaded"
                ? {mode: "uploaded", binding, session_id: f.candidate.sessionId, operation_id: randomUUID(),
                    byte_length: f.candidate.byteLength, sha256: f.candidate.sha256, metadata: f.candidate.metadata}
                : {mode: "current", binding, session_id: f.candidate.sessionId, operation_id: randomUUID(), revision};
            state.prepare(f.candidate, kind, request, null, kind === "current" ? comparison : null);
            const original = operation(state, f.candidate);
            assert.equal(original.dispatched, false);
            state.markUncertain(original.id);
            assert.deepEqual(f.query("SELECT state,dispatched FROM archive_worker_operations"), [{state: "uncertain", dispatched: 1}]);
            // Capture B independently under the same binding/native ID while A is unresolved.
            const file = path.join(f.directory, "independent-successor.jsonl");
            state.addSources(state.scope(f.scope.id), [file], null, true);
            const source = f.query<WorkSource>(`SELECT id,scope,file,kind,retry_cursor AS retryCursor,attempts,
                missing_attempts AS missingAttempts FROM archive_worker_sources`).find((row) => row.file === file)!;
            state.observeSource(source.id, {...f.childEvidence, file});
            const body = Buffer.from("independent successor history");
            state.capture(source, {file, sessionId: f.candidate.sessionId, body, metadata: f.snapshot.metadata});
            const successorId = f.query<{id: string; source: string}>("SELECT id,source FROM archive_worker_candidates")
                .find((row) => row.source === file)!.id;
            const successor = state.candidate(successorId);
            const nextDue = Date.now() + 5000;
            if (change === "after-unknown") {
                state.replay(original.id, nextDue);
                assert.deepEqual(f.query("SELECT state,dispatched,attempts FROM archive_worker_operations"),
                    [{state: "ready", dispatched: 1, attempts: 0}], "zero retries cannot erase positive dispatch provenance");
                state = f.open();
            }
            state.observeSource(f.id(f.files[2]!), {...f.parentEvidence, file: f.files[2]!});
            if (change === "before-unknown") {
                state.replay(original.id, nextDue);
                assert.deepEqual(f.query("SELECT state,dispatched,due FROM archive_worker_operations"),
                    [{state: "uncertain", dispatched: 1, due: nextDue}]);
                assert.equal(state.nextOperation([f.scope.destination], nextDue - 1), undefined);
            }
            state = f.open();
            const recovery = state.nextOperation([f.scope.destination], Number.MAX_SAFE_INTEGER)!;
            assert.ok(recovery, "ancestry exclusion must not erase uncertain remote effects");
            assert.equal(recovery.id, original.id);
            assert.equal(recovery.request, original.request);
            assert.equal(recovery.state, "uncertain");
            assert.equal(recovery.dispatched, true);
            assert.equal(state.nextCandidate([f.scope.destination], Number.MAX_SAFE_INTEGER), undefined);
            assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/);
            assert.deepEqual(state.body(f.candidate), f.snapshot.body);
            assert.deepEqual(state.body(successor), body);
            state.replay(recovery.id, nextDue + 10_000);
            assert.equal(state.nextOperation([f.scope.destination], nextDue + 9999), undefined);
            assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/,
                "another unknown receipt and its backoff retain the same-native-ID exclusion");
            const receipt = kind === "publish" ? {request, revision: {binding, seq: "11"}} : {
                request, variant: {session_id: f.candidate.sessionId, variant_id: "preserved-a", revision: {binding, seq: "11"},
                    byte_length: kind === "current" ? compared.byte_length : f.candidate.byteLength,
                    sha256: kind === "current" ? compared.sha256 : f.candidate.sha256,
                    metadata: kind === "current" ? compared.metadata : f.candidate.metadata,
                    uploaded_at: "2026-01-02T00:00:00.000Z"},
                ...(kind === "current" ? {source_revision: revision, source_uploaded_at: compared.uploaded_at} : {}),
            };
            assert.equal(state.accept(recovery, receipt, kind !== "current"), true);
            const successorRequest = publication(successor);
            state.prepare(successor, "publish", successorRequest);
            const next = operation(state, successor);
            assert.notEqual(next.id, original.id);
            assert.equal(next.dispatched, false);
            assert.equal(state.accept(recovery, receipt, kind !== "current"), false,
                "late A acknowledgment must not consume B or its immutable operation");
            state = f.open();
            assert.equal(operation(state, successor).id, next.id);
            assert.equal(operation(state, successor).request, JSON.stringify(successorRequest));
            assert.deepEqual(state.body(successor), body);
        });
    }
}

for (const kind of ["publish", "uploaded", "current"] as const) {
    test(`engine ${kind} recovery keeps dispatched ancestry-invalid work receipt-only after unknown and restart`, async (t) => {
        let now = 2_000_000_000_000;
        t.mock.method(Date, "now", () => now);
        const f = ancestryFixture(t);
        let state = f.state;
        const revision = {binding, seq: "10"};
        const compared = {session_id: f.candidate.sessionId, revision, byte_length: 6,
            sha256: createHash("sha256").update("remote").digest("hex"), metadata: null, uploaded_at: "2026-01-01T00:00:00.000Z"};
        const request = kind === "publish" ? publication(f.candidate) : kind === "uploaded"
            ? {mode: "uploaded", binding, session_id: f.candidate.sessionId, operation_id: randomUUID(),
                byte_length: f.candidate.byteLength, sha256: f.candidate.sha256, metadata: f.candidate.metadata}
            : {mode: "current", binding, session_id: f.candidate.sessionId, operation_id: randomUUID(), revision};
        state.prepare(f.candidate, kind, request, null, kind === "current"
            ? JSON.stringify({snapshot: compared, condition: {kind: "exact_base_revision", revision}}) : null);
        const original = operation(state, f.candidate);
        const file = path.join(f.directory, "independent-successor.jsonl");
        state.addSources(state.scope(f.scope.id), [file], null, true);
        const source = f.query<WorkSource>(`SELECT id,scope,file,kind,retry_cursor AS retryCursor,attempts,
            missing_attempts AS missingAttempts FROM archive_worker_sources`).find((row) => row.file === file)!;
        state.observeSource(source.id, {...f.childEvidence, file});
        const successorBody = Buffer.from("independent successor history");
        state.capture(source, {file, sessionId: f.candidate.sessionId, body: successorBody, metadata: f.snapshot.metadata});
        const successor = state.candidate(f.query<{id: string; source: string}>("SELECT id,source FROM archive_worker_candidates")
            .find((row) => row.source === file)!.id);
        const receipt = kind === "publish" ? {request, revision: {binding, seq: "11"}} : {
            request, variant: {session_id: f.candidate.sessionId, variant_id: "preserved-a", revision: {binding, seq: "11"},
                byte_length: kind === "current" ? compared.byte_length : f.candidate.byteLength,
                sha256: kind === "current" ? compared.sha256 : f.candidate.sha256,
                metadata: kind === "current" ? null : f.candidate.metadata, uploaded_at: "2026-01-02T00:00:00.000Z"},
            ...(kind === "current" ? {source_revision: revision, source_uploaded_at: compared.uploaded_at} : {}),
        };
        const store = new ServerConfigStore(f.directory);
        t.mock.method(store, "connection", () => ({config: {url: origin, apiKey: "synthetic-key"}, generation}));
        t.mock.method(ArchiveSessions.prototype, "captureSource", async () => {
            throw new ArchiveSourceError("changing", "Keep independent source obligations deferred");
        });
        const calls: string[] = [];
        const sent = kind === "publish" ? "/v1/publish" : "/v1/preserve";
        const lookup = kind === "publish" ? "/v1/receipt" : "/v1/preserve-receipt";
        let accepted = false;
        const respond = (value: unknown) => {
            const body = JSON.stringify(value);
            return new Response(body, {headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
        };
        t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo, init?: RequestInit) => {
            const endpoint = new URL(String(url)).pathname;
            calls.push(endpoint);
            if (endpoint === "/v1/binding") return respond({binding, head: "10", capabilities: ["preserved_variants_v1"]});
            const stored = f.query<{state: string; dispatched: number}>("SELECT state,dispatched FROM archive_worker_operations");
            assert.deepEqual(stored, [{state: "uncertain", dispatched: 1}], "dispatch provenance must commit before either send or receipt HTTP");
            const header = new Headers(init?.headers).get(kind === "publish" ? "x-pi-publication" : "x-pi-preservation");
            const control = header ? Buffer.from(header, "base64url") : Buffer.from(init!.body as Uint8Array);
            assert.deepEqual(JSON.parse(control.toString()), request, "all recovery requests retain the original immutable fingerprint");
            if (endpoint === sent) throw new Error("lost send reply after possible remote dispatch");
            assert.equal(endpoint, lookup, "ancestry-invalid work permits receipt lookup, never canonical comparison or another send");
            return respond(accepted ? {status: "accepted", receipt} : {status: "unknown"});
        });
        const storedOperation = () => f.query<{state: string; dispatched: number; due: number}>(
            "SELECT state,dispatched,due FROM archive_worker_operations")[0]!;
        let engine = new ArchiveWorkerEngine(f.directory, store);
        try {
            await engine.step(); // Verify the original destination.
            await engine.step(); // The one send loses its reply.
            assert.equal(storedOperation().state, "uncertain");
            assert.equal(storedOperation().dispatched, 1);
            assert.ok(storedOperation().due > now);
            now = storedOperation().due + 1;
            await engine.step(); // Unknown with valid ancestry may make the immutable retry ready.
            assert.equal(storedOperation().state, "ready");
            assert.equal(storedOperation().dispatched, 1);
            state.observeSource(f.id(f.files[2]!), {...f.parentEvidence, file: f.files[2]!});
            engine.close();
            engine = new ArchiveWorkerEngine(f.directory, store);
            state = f.open();
            await engine.step(); // Restart verifies credentials before recovery.
            await engine.step(); // Ready+dispatched converts to uncertain; unknown stays receipt-only.
            assert.equal(storedOperation().state, "uncertain");
            assert.ok(storedOperation().due > now);
            assert.equal(calls.filter((endpoint) => endpoint === sent).length, 1);
            assert.equal(calls.filter((endpoint) => endpoint === lookup).length, 2);
            assert.throws(() => state.prepare(successor, "publish", publication(successor)), /unresolved/);
            assert.equal(state.nextCandidate([f.scope.destination], now), undefined);
            const beforeBackoff = [...calls];
            await engine.step();
            assert.deepEqual(calls, beforeBackoff, "future receipt recovery must not hot-loop or send a successor");
            assert.deepEqual(state.body(f.candidate), f.snapshot.body);
            assert.deepEqual(state.body(successor), successorBody);
            accepted = true;
            now = storedOperation().due + 1;
            await engine.step(); // A delayed accepted receipt settles A without sending it again.
            assert.equal(storedOperation().state, "accepted");
            assert.equal(calls.filter((endpoint) => endpoint === sent).length, 1);
            assert.equal(calls.filter((endpoint) => endpoint === lookup).length, 3);
            state.prepare(successor, "publish", publication(successor));
            const successorOperation = operation(state, successor);
            assert.equal(state.accept(original, receipt, kind !== "current"), false);
            assert.equal(operation(state, successor).id, successorOperation.id);
            assert.deepEqual(state.body(successor), successorBody);
        } finally { engine.close(); }
    });
}

for (const status of ["ready", "uncertain"] as const) {
    test(`dispatch-provenance migration conservatively retains existing ${status} operations`, (t) => {
        const f = fixture(t);
        let state = f.open();
        const candidate = capture(state, f.directory, "retained history");
        state.prepare(candidate, "publish", publication(candidate));
        const pending = operation(state, candidate);
        if (status === "uncertain") state.markUncertain(pending.id);
        f.close();
        const database = SqliteDatabase.test(false, f.file);
        try { database.exec("ALTER TABLE archive_worker_operations DROP COLUMN dispatched"); }
        finally { database.close(); }
        state = f.open();
        const migrated = operation(state, candidate);
        assert.equal(migrated.state, status);
        assert.equal(migrated.dispatched, true, "absence of historical dispatch evidence cannot prove a request was never sent");
        assert.equal(migrated.id, pending.id);
        assert.equal(migrated.request, pending.request);
        assert.deepEqual(state.body(candidate), Buffer.from("retained history"));
    });
}

test("unrelated observations and a candidate's own appended evidence do not invalidate its captured classification", (t) => {
    const f = ancestryFixture(t);
    const state = f.state;
    state.observeSource(f.id(f.files[3]!), {file: f.files[3]!, session: {sessionId: "Q", main: false, identityConflict: false}});
    assert.equal(state.nextCandidate([f.scope.destination], Number.MAX_SAFE_INTEGER)?.id, f.candidate.id);
    const request = publication(f.candidate);
    state.prepare(f.candidate, "publish", request);
    const pending = operation(state, f.candidate);
    state.observeSource(f.child.id, {...f.childEvidence, session: {...f.childEvidence.session, identityConflict: true}}, f.dependencies);
    assert.equal(state.nextOperation([f.scope.destination], Number.MAX_SAFE_INTEGER)?.id, pending.id);
    assert.deepEqual(f.query("SELECT dependencies,dependency_key FROM archive_worker_candidate_sources"),
        [{dependencies: f.association.dependencies, dependency_key: f.association.dependency_key}]);
    assert.deepEqual(state.body(f.candidate), f.snapshot.body);
    assert.deepEqual(state.candidate(f.candidate.id).metadata, f.snapshot.metadata);
});

test("fixed-target ancestry review retains its cursor at capacity and requeues excluded sources in bounded pages", (t) => {
    const f = fixture(t);
    let state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    const parent = path.join(f.directory, "parent.jsonl");
    const children = Array.from({length: 130}, (_, index) => path.join(f.directory, `derived-${index}.jsonl`));
    state.addSources(scope, [parent, ...children], null, true);
    const sources = f.query<{id: number; file: string}>("SELECT id,file FROM archive_worker_sources ORDER BY id");
    const parentId = sources[0]!.id;
    const parentEvidence: ArchiveSourceEvidence = {file: parent, session: {sessionId: "P", main: false,
        identityConflict: false, childKind: SessionKind.Subagent, parentAgentIdentifier: "other-root", rootSessionId: "other-root"}};
    state.observeSource(parentId, parentEvidence);
    state.finishSource(parentId, "excluded");
    for (const [index, child] of sources.slice(1).entries()) {
        state.observeSource(child.id, {file: child.file, session: {sessionId: `derived-${index}`, main: false,
            identityConflict: false, childKind: SessionKind.Subagent, parentAgentIdentifier: "P", rootSessionId: "other-root"}},
        {files: [parent], sessionIds: ["P"]});
        state.finishSource(child.id, "excluded");
    }
    const review = () => f.query<{catalog_revision: number; review_target: number | null; review_cursor: number; due: number}>(
        "SELECT catalog_revision,review_target,review_cursor,due FROM archive_worker_scopes")[0]!;
    const ready = () => f.query<{n: number}>("SELECT COUNT(*) AS n FROM archive_worker_sources WHERE state='ready'")[0]!.n;
    for (let pass = 0; pass < 10 && review().review_target !== null; pass++) state.nextSource(Date.now(), [scope.destination]);
    assert.equal(review().review_target, null, "the unchanged baseline finishes before testing a new review target");
    const fillers = Array.from({length: 10000}, (_, index) => path.join(f.directory, `waiting-${index}.jsonl`));
    assert.equal(state.addSources(state.scope(scope.id), fillers, null, true), true);
    state.observeSource(parentId, {...parentEvidence, session: {...parentEvidence.session, sessionId: "changed-P"}});
    const target = review().review_target;
    assert.ok(target !== null);
    let now = Date.now();
    const waiting = state.nextSource(now, [scope.destination])!;
    assert.equal(ready(), 10000);
    assert.equal(review().review_cursor, parentId, "capacity blocks before the first excluded dependent, not after acknowledging it");
    assert.equal(review().review_target, target);
    state = f.open();
    assert.equal(review().review_cursor, parentId, "the paused cursor survives restart");
    state.finishSource(waiting.id, "invalid");
    now = review().due + 1;
    state.nextSource(now, [scope.destination]);
    assert.equal(ready(), 10000);
    assert.equal(review().review_cursor, sources[1]!.id);
    state.observeSource(parentId, {...parentEvidence, session: {...parentEvidence.session, sessionId: "changed-again-P"}});
    assert.equal(review().review_target, target);
    assert.equal(review().review_cursor, sources[1]!.id, "a newer catalog revision must not restart the fixed-target tail");
    const database = SqliteDatabase.test(false, f.file);
    try {
        database.prepare(`UPDATE archive_worker_sources SET state='invalid' WHERE id IN
            (SELECT id FROM archive_worker_sources WHERE state='ready' AND file LIKE '%/waiting-%' ORDER BY id LIMIT 128)`).run();
    } finally { database.close(); }
    assert.equal(ready(), 9872);
    state.nextSource(++now, [scope.destination]);
    assert.equal(ready(), 9936, "one pass admits at most 64 revalidations");
    assert.equal(review().review_cursor, sources[65]!.id);
    state.observeSource(parentId, {...parentEvidence, session: {...parentEvidence.session, sessionId: "third-P"}});
    assert.equal(review().review_target, target);
    assert.equal(review().review_cursor, sources[65]!.id);
    const available = state.nextSource(++now, [scope.destination])!;
    assert.equal(ready(), 10000);
    assert.equal(review().review_cursor, sources[129]!.id);
    state.nextSource(++now, [scope.destination]);
    assert.equal(ready(), 10000);
    assert.equal(review().review_cursor, sources[129]!.id, "the final excluded tail waits rather than exceeding capacity");
    state.finishSource(available.id, "invalid");
    now = review().due + 1;
    state.nextSource(now, [scope.destination]);
    assert.equal(ready(), 10000);
    assert.equal(review().review_target, review().catalog_revision, "only a completed tail advances to the newer target");
    assert.equal(review().review_cursor, 0);
    assert.deepEqual(f.query("SELECT COUNT(*) AS n FROM archive_worker_sources WHERE file LIKE '%/derived-%' AND state='ready'"), [{n: 130}]);
    assert.deepEqual(f.query("SELECT id FROM archive_worker_candidates"), []);
});

test("directory retry progresses independently without completing or rewinding the unfinished main scan", (t) => {
    const f = fixture(t);
    let state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    const scope = state.scope(enqueue.id);
    state.addSources(scope, [], "main-continuation", false, [{path: f.directory, retryCursor: "directory-start"}]);
    const retry = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    assert.equal(retry.kind, "directory");
    const child = path.join(f.directory, "child.jsonl");
    assert.equal(state.addSources(state.scope(scope.id), [child], scope.cursor, true, [], false), true);
    state.directoryContinuation(retry.id, "directory-next-page");
    state = f.open();
    assert.equal(state.scope(scope.id).cursor, "main-continuation");
    assert.equal(state.nextScope(Number.MAX_SAFE_INTEGER)?.id, scope.id);
    const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    assert.equal(source.file, child, "new file capture receives a turn before continuing the same directory");
    state.finishSource(source.id, "source-lost");
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.retryCursor, "directory-next-page");
    state.finishSource(retry.id, "captured");
    assert.equal(state.nextScope(Number.MAX_SAFE_INTEGER)?.id, scope.id,
        "a complete directory retry does not certify the independent main scan");
    state.addSources(state.scope(scope.id), [], null, true);
    assert.equal(state.nextScope(Number.MAX_SAFE_INTEGER), undefined);
    assert.deepEqual(f.query("SELECT state FROM archive_worker_scopes"), [{state: "complete"}]);
});

test("local discovery and capture stay pinned across logout, origin changes, and credential replacement", async (t) => {
    for (const scenario of ["logout", "other-origin", "superseded-unbound", "other-namespace", "original-unbound", "verified-bound"] as const) {
        await t.test(scenario, async (t) => {
            const f = fixture(t);
            const state = f.open();
            const scan = manifest(f.directory);
            const captureRequest = manifest(f.directory);
            state.import(scan);
            state.import(captureRequest);
            state.addSources(state.scope(captureRequest.id), [captureRequest.source.sessionFile!], null, true);
            const bound = scenario === "other-namespace" || scenario === "verified-bound";
            if (bound) state.bind(state.destinations()[0]!, binding);
            f.close();
            const store = new ServerConfigStore(f.directory);
            const active: ReturnType<ServerConfigStore["connection"]> = scenario === "logout" ? undefined : {
                config: {url: scenario === "other-origin" ? "https://other.example" : origin, apiKey: "synthetic-key"},
                generation: scenario === "superseded-unbound" || bound ? "replacement-generation" : generation,
            };
            t.mock.method(store, "connection", () => active);
            const verify = t.mock.method(ArchiveClient.prototype, "binding", async () => ({
                binding: scenario === "other-namespace" ? {...binding, namespace_id: "other-namespace"} : binding,
                head: "0", capabilities: [],
            }));
            const discover = t.mock.method(ArchiveSessions.prototype, "discoverPage", async () => ({files: [], cursor: null, complete: true, issues: []}));
            const capture = t.mock.method(ArchiveSessions.prototype, "captureSource", async () => {
                throw new ArchiveSourceError("missing", "Synthetic missing source");
            });
            const engine = new ArchiveWorkerEngine(f.directory, store);
            try {
                await engine.step();
                if (scenario === "verified-bound") {
                    assert.equal(discover.mock.callCount(), 0);
                    assert.equal(capture.mock.callCount(), 0, "bound work waits for fresh credential identity verification");
                }
                await engine.step();
                await engine.step();
                if (scenario === "original-unbound" || scenario === "verified-bound") {
                    assert.equal(discover.mock.callCount(), 1);
                    assert.equal(capture.mock.callCount(), 1);
                    assert.equal(verify.mock.callCount(), 1);
                } else {
                    assert.equal(discover.mock.callCount(), 0);
                    assert.equal(capture.mock.callCount(), 0);
                    assert.deepEqual(f.query("SELECT state,attempts FROM archive_worker_sources"), [{state: "ready", attempts: 0}]);
                    assert.equal(engine.inspect().eligible, false);
                    assert.equal(verify.mock.callCount(), scenario === "other-namespace" ? 1 : 0);
                }
            } finally { engine.close(); }
        });
    }
});

test("a backed-off staged comparison cannot exhaust an unrelated candidate's reconciliation reservation", async (t) => {
    const f = fixture(t);
    const state = f.open();
    const staged = capture(state, f.directory, "staged candidate");
    const incoming = capture(state, f.directory, "new candidate");
    state.defer("candidates", staged.id, Date.now() + 300_000, "metadata-backoff");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < MAX_ARCHIVE_BYTES; offset += chunk.length) hash.update(chunk);
    const snapshot = {session_id: staged.sessionId, revision: {binding, seq: "1"}, byte_length: MAX_ARCHIVE_BYTES,
        sha256: hash.digest("hex")};
    f.close();
    const database = SqliteDatabase.test(false, f.file);
    try {
        database.prepare("INSERT INTO archive_worker_comparisons(candidate,snapshot,body) VALUES (?,?,zeroblob(?))")
            .run(staged.id, JSON.stringify(snapshot), MAX_ARCHIVE_BYTES);
    } finally { database.close(); }
    const reopened = f.open();
    assert.equal(reopened.workingAvailable(), MAX_ARCHIVE_BYTES);
    const release = reopened.reserve(MAX_ARCHIVE_BYTES);
    assert.throws(() => reopened.reserve(1), /allowance exhausted/,
        "64 MiB staged plus 64 MiB active exactly fills the separate working allowance");
    release();
    f.close();
    const store = new ServerConfigStore(f.directory);
    t.mock.method(store, "connection", () => ({config: {url: origin, apiKey: "synthetic-key"}, generation}));
    t.mock.method(ArchiveClient.prototype, "binding", async () => ({binding, head: "1", capabilities: []}));
    t.mock.method(ArchiveClient.prototype, "download", async () => {
        throw new ArchiveClientError("offline", undefined, false, {kind: "transport"});
    });
    const engine = new ArchiveWorkerEngine(f.directory, store);
    try {
        await engine.step();
        await assert.doesNotReject(() => engine.step(), "an expendable comparison must not crash the worker's next capture/reconciliation cycle");
        assert.deepEqual(f.query("SELECT id FROM archive_worker_candidates WHERE state='invalid'"), []);
        assert.deepEqual(f.open().body(incoming), Buffer.from("new candidate"));
    } finally { engine.close(); }
});

test("long metadata lookups yield candidate turns without losing evicted-body continuations across restart", (t) => {
    const f = fixture(t);
    let state = f.open();
    const first = capture(state, f.directory, "first lookup");
    const second = capture(state, f.directory, "second lookup");
    const body = Buffer.from("remote");
    const snapshot = {session_id: first.sessionId, revision: {binding, seq: "1"}, byte_length: body.length,
        sha256: createHash("sha256").update(body).digest("hex")};
    state.saveComparison(first.id, snapshot, body);
    state.saveComparison(second.id, snapshot, body);
    for (let page = 0; page < 6; page++) {
        for (const candidate of [first, second]) {
            assert.equal(state.nextCandidate([candidate.destination], Number.MAX_SAFE_INTEGER)?.id, candidate.id);
            state.releaseComparisonBodies(candidate.id);
            state.comparisonCursor(candidate.id, `page-${page + 1}`);
        }
        state = f.open();
        assert.equal(state.comparison(first.id)?.cursor, `page-${page + 1}`);
        assert.equal(state.comparison(second.id)?.cursor, `page-${page + 1}`);
    }
    assert.deepEqual(state.body(first), Buffer.from("first lookup"));
    assert.deepEqual(state.body(second), Buffer.from("second lookup"));
});

test("missing-source attempts are consecutive and independent of unrelated faults, including directory progress", (t) => {
    const f = fixture(t);
    let state = f.open();
    const enqueue = manifest(f.directory);
    state.import(enqueue);
    state.addSources(state.scope(enqueue.id), [enqueue.source.sessionFile!], null, true);
    const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    for (let attempt = 0; attempt < 5; attempt++) state.defer("sources", source.id, 0, "source-changing");
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.missingAttempts, 0);
    state.defer("sources", source.id, 0, "source-missing");
    state.defer("sources", source.id, 0, "source-missing");
    state = f.open();
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.missingAttempts, 2);
    state.defer("sources", source.id, 0, "source-unreadable");
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.missingAttempts, 0);
    state.defer("sources", source.id, 0, "source-missing");
    state.observeSource(source.id, {file: source.file, session: enqueue.source.activeSession});
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.missingAttempts, 0);
    state.finishSource(source.id, "excluded");
    state.addSources(state.scope(enqueue.id), [], null, true, [{path: f.directory, retryCursor: "start"}]);
    const directory = state.nextSource(Number.MAX_SAFE_INTEGER)!;
    assert.equal(directory.kind, "directory");
    state.defer("sources", directory.id, 0, "source-missing");
    state.directoryContinuation(directory.id, "next-page");
    assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER)?.missingAttempts, 0,
        "successfully reading a directory page interrupts its missing-source streak");
});

function acceptedLegacy(directory: string, metadata: ArchiveMetadata = {}) {
    const journal = new ArchiveJournal(directory);
    try {
        const value = journal.prepare(origin, binding, {file: path.join(directory, "missing.jsonl"), sessionId: "session",
            body: Buffer.from("base"), metadata});
        assert.equal(value.kind, "pending");
        if (value.kind !== "pending") throw new Error("Expected canonical publication");
        const receipt = {request: value.request, revision: {binding, seq: "7"}};
        journal.accept(origin, receipt);
        return receipt;
    } finally { journal.close(); }
}

test("canonical base evidence uses accepted publications, never preservation variants, and is binding scoped", (t) => {
    const f = fixture(t);
    const legacy = acceptedLegacy(f.directory);
    const state = f.open();
    assert.deepEqual(state.destinations(), [], "accepted-only history creates no implicit source or candidate work");
    const candidate = capture(state, f.directory, "base-next");
    assert.deepEqual(state.acceptedCanonical(candidate, binding), legacy);
    const variant = capture(state, f.directory, "separate variant");
    acceptPreservation(state, variant);
    assert.deepEqual(state.acceptedCanonical(candidate, binding), legacy, "preserve-current receipt is not publication evidence");
    const uploaded = {mode: "uploaded", binding, session_id: variant.sessionId, operation_id: randomUUID(),
        byte_length: variant.byteLength, sha256: variant.sha256, metadata: variant.metadata};
    state.prepare(variant, "uploaded", uploaded);
    state.accept(operation(state, variant), {request: uploaded, variant: {session_id: variant.sessionId, variant_id: "variant-id",
        revision: {binding, seq: "9007199254740994"}, byte_length: variant.byteLength, sha256: variant.sha256,
        metadata: variant.metadata, uploaded_at: "2026-01-01T00:00:00.000Z"}}, true);
    assert.deepEqual(state.acceptedCanonical(candidate, binding), legacy, "uploaded variant sequence is not a canonical revision");
    for (const other of [{...binding, history_generation: "restored"}, {...binding, namespace_id: "other"}, {...binding, server_id: "other"}]) {
        assert.equal(state.acceptedCanonical(candidate, other), undefined);
    }
    const request = publication(candidate, binding, legacy.revision);
    state.prepare(candidate, "publish", request);
    const receipt = {request, revision: {binding, seq: "8"}};
    state.accept(operation(state, candidate), receipt, true);
    const successor = capture(state, f.directory, "base-next-new");
    assert.deepEqual(state.acceptedCanonical(successor, binding), receipt);
});

test("accepted-prefix fast path proves bytes and preserves shorter classification; stale CAS forces comparison", async (t) => {
    for (const scenario of ["extension", "not-byte-prefix", "omitted-classification"] as const) {
        await t.test(scenario, async (t) => {
            const f = fixture(t);
            const legacy = acceptedLegacy(f.directory, scenario === "omitted-classification"
                ? {kind: SessionKind.Main, root_session_id: "session"} : {});
            const state = f.open();
            const candidate = capture(state, f.directory, scenario === "not-byte-prefix" ? "BASE-next" : "base-next");
            f.close();
            const store = new ServerConfigStore(f.directory);
            t.mock.method(store, "connection", () => ({config: {url: origin, apiKey: "synthetic-key"}, generation}));
            t.mock.method(ArchiveClient.prototype, "binding", async () => ({binding, head: "7", capabilities: ["preserved_variants_v1"]}));
            const download = t.mock.method(ArchiveClient.prototype, "download", async () => {
                const body = Buffer.from(scenario === "extension" ? "a longer remote replacement" : "base");
                return {body, snapshot: {session_id: candidate.sessionId, revision: {binding, seq: scenario === "extension" ? "8" : "7"},
                    byte_length: body.length, sha256: createHash("sha256").update(body).digest("hex"),
                    metadata: legacy.request.metadata ?? null, uploaded_at: "2026-01-01T00:00:00.000Z"}};
            });
            const engine = new ArchiveWorkerEngine(f.directory, store);
            try {
                await engine.step();
                await engine.step();
                const current = f.open();
                const prepared = operation(current, candidate);
                if (scenario === "extension") {
                    assert.equal(download.mock.callCount(), 0);
                    assert.equal(prepared.kind, "publish");
                    assert.deepEqual((JSON.parse(prepared.request) as Publication).condition,
                        {kind: "exact_base_revision", revision: legacy.revision});
                    current.reject(prepared);
                    const now = Date.now() + 30_000;
                    t.mock.method(Date, "now", () => now);
                    await engine.step();
                    assert.equal(download.mock.callCount(), 1, "stale attempts cannot repeatedly reuse an old accepted base");
                    assert.equal(operation(current, candidate).kind, "uploaded", "fresh remote evidence wins after divergence");
                } else {
                    assert.equal(download.mock.callCount(), 1);
                    assert.equal(prepared.kind, "current", "non-prefix or classification-omitting replacement must preserve compared remote bytes");
                }
            } finally { engine.close(); }
        });
    }
});

test("every engine request path rechecks configuration immediately before transport without invalidating history", async (t) => {
    for (const endpoint of ["binding", "download", "list", "publish", "receipt", "preserve", "preserve-receipt"] as const) {
        await t.test(endpoint, async (t) => {
            const f = fixture(t);
            const state = f.open();
            const candidate = capture(state, f.directory, "local");
            const snapshot = {session_id: candidate.sessionId, revision: {binding, seq: "1"}, byte_length: 6,
                sha256: createHash("sha256").update("remote").digest("hex")};
            if (endpoint === "list") state.saveComparison(candidate.id, snapshot, Buffer.from("remote"));
            if (endpoint === "publish" || endpoint === "receipt") {
                state.prepare(candidate, "publish", publication(candidate));
                if (endpoint === "receipt") state.markUncertain(operation(state, candidate).id);
            }
            if (endpoint === "preserve" || endpoint === "preserve-receipt") {
                const request = {mode: "uploaded", binding, session_id: candidate.sessionId, operation_id: randomUUID(),
                    byte_length: candidate.byteLength, sha256: candidate.sha256, metadata: candidate.metadata};
                state.prepare(candidate, "uploaded", request);
                if (endpoint === "preserve-receipt") state.markUncertain(operation(state, candidate).id);
            }
            f.close();
            const store = new ServerConfigStore(f.directory);
            const authorized = {config: {url: origin, apiKey: "synthetic-key"}, generation};
            let racing = false;
            let reads = 0;
            t.mock.method(store, "connection", (): ReturnType<ServerConfigStore["connection"]> => {
                if (!racing || reads++ === 0) return authorized;
                if (endpoint === "download" || endpoint === "preserve") return {...authorized, generation: "replacement-generation"};
                if (endpoint === "list" || endpoint === "preserve-receipt") return {...authorized, config: {...authorized.config, url: "https://other.example"}};
                if (endpoint === "publish") return {...authorized, config: {...authorized.config, apiKey: "replacement-key"}};
                return undefined;
            });
            const calls: string[] = [];
            t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo) => {
                calls.push(new URL(String(url)).pathname);
                assert.equal(new URL(String(url)).pathname, "/v1/binding");
                const body = JSON.stringify({binding, head: "1", capabilities: ["preserved_variants_v1"]});
                return new Response(body, {headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
            });
            const engine = new ArchiveWorkerEngine(f.directory, store);
            try {
                if (endpoint !== "binding") await engine.step();
                const before = [...calls];
                racing = true;
                await engine.step();
                assert.deepEqual(calls, before, "configuration changed after scheduling but before fetch");
                const reopened = f.open();
                assert.deepEqual(reopened.body(candidate), Buffer.from("local"));
                assert.deepEqual(f.query("SELECT id FROM archive_worker_candidates WHERE state='invalid'"), []);
                assert.deepEqual(f.query("SELECT id FROM archive_worker_operations WHERE state='invalid'"), []);
                assert.equal(reopened.authorization(generation).blocked, false);
            } finally { engine.close(); }
        });
    }
});
