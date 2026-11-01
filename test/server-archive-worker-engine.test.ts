import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {afterEach, beforeEach, mock, test} from "node:test";
import {ArchiveWorkerEngine} from "../src/server/ArchiveWorkerEngine.js";
import {ArchiveWorkerState, type ArchiveManifest} from "../src/server/ArchiveWorkerState.js";
import {ArchiveJournal} from "../src/server/ArchiveJournal.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";
import {decodeArchivePublication, decodeArchivePreservation, type ArchiveMetadata, type Binding,
    type Publication, type Preservation, type PreservationReceipt, type Receipt, type SessionMetadata} from "../src/server/ArchiveProtocol.js";

const origin = "https://archive.example";
const nativeId = "root";
const openDatabase = SqliteDatabase.test;
let now = 1_000_000;
beforeEach(() => {
    now = 1_000_000;
    mock.method(Date, "now", () => now);
    // These fixtures exercise real committed SQLite state, not production WAL qualification.
    mock.method(SqliteDatabase, "test", (readonly: boolean, file: string) => {
        const database = openDatabase(readonly, file);
        if (!readonly) database.exec("PRAGMA journal_mode=DELETE");
        return database;
    });
});
afterEach(() => mock.restoreAll());

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-worker-engine-"));
    const archive = path.join(directory, "archive");
    const file = path.join(directory, "root.jsonl");
    const store = new ServerConfigStore(directory);
    let connection: ReturnType<ServerConfigStore["connection"]> = {config: {url: origin, apiKey: "secret"}, generation: randomUUID()};
    mock.method(store, "connection", () => connection);
    const manifest = (): ArchiveManifest => ({version: 1, id: randomUUID(), origin, generation: connection!.generation,
        source: {version: 1, scope: "current", activeSession: {sessionId: nativeId, main: true, rootSessionId: nativeId, identityConflict: false},
            sessionFile: file, sessionDirectory: directory, rootSessionId: nativeId, defaultSessionRoots: [path.join(directory, "defaults")]}});
    return {directory, archive, file, store, manifest, get connection() {return connection;},
        set connection(value) {connection = value;}, clean: () => fs.rmSync(directory, {recursive: true, force: true})};
}

function queued(f: ReturnType<typeof fixture>, body: string, metadata: ArchiveMetadata = {}) {
    const state = new ArchiveWorkerState(f.archive);
    const manifest = f.manifest();
    state.import(manifest);
    const scope = state.nextScope(now)!;
    state.addSources(scope, [f.file], null, true);
    state.capture(state.nextSource(now)!, {file: f.file, sessionId: nativeId, body: Buffer.from(body), metadata});
    state.close();
}

class Remote {
    version = "0.4.0";
    versionChecks = 0;
    binding: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "history"};
    body: Buffer | undefined;
    metadata: ArchiveMetadata | null = {};
    revision = 1;
    calls: string[] = [];
    requests: Array<Publication | Preservation> = [];
    receipts = new Map<string, Receipt | PreservationReceipt>();
    variants: Array<{body: Buffer; metadata: ArchiveMetadata | null}> = [];
    failReceipt = false;
    unauthorized = false;
    legacy = false;
    losePreserveReply = false;
    paginateLegacy = false;
    listRequests: Array<{cursor?: string; filters?: unknown}> = [];
    invalidMutationReply: "malformed" | "mismatched" | undefined;
    receiptReplies: Array<"malformed" | "mismatched" | "unknown"> = [];

    install() {
        mock.method(globalThis, "fetch", async (url: URL | RequestInfo, init?: RequestInit) => this.fetch(String(url), init));
    }

    private fetch(url: string, init?: RequestInit): Response {
        const endpoint = new URL(url).pathname;
        if (endpoint === "/v1/version") {
            this.versionChecks++;
            return this.unauthorized ? failure("unauthorized", 401, false) : json({version: this.version});
        }
        this.calls.push(endpoint);
        if (this.unauthorized) return failure("unauthorized", 401, false);
        if (endpoint === "/v1/binding") return json({binding: this.binding, head: String(this.revision), ...(this.legacy ? {} : {capabilities: ["preserved_variants_v1"]})});
        if (endpoint === "/v1/download") {
            if (!this.body) return failure("not_found", 404, false);
            const snapshot = this.snapshot();
            if (this.legacy) { delete snapshot.metadata; delete snapshot.uploaded_at; }
            return new Response(new Uint8Array(this.body), {headers: {"content-type": "application/octet-stream", "content-length": String(this.body.length),
                "x-pi-snapshot": Buffer.from(JSON.stringify(snapshot)).toString("base64url")}});
        }
        if (endpoint === "/v1/list") {
            const request = JSON.parse(Buffer.from(init!.body as Uint8Array).toString()) as {cursor?: string; filters?: unknown};
            this.listRequests.push(request);
            if (this.paginateLegacy && !request.cursor) return json({binding: this.binding, sessions: [], next_cursor: "second-page"});
            return json({binding: this.binding, sessions: this.body ? [{...this.snapshot(), metadata: this.metadata, uploaded_at: "2026-01-01T00:00:00.000Z"}] : [], next_cursor: null});
        }
        if (endpoint === "/v1/receipt" || endpoint === "/v1/preserve-receipt") {
            if (this.failReceipt) throw new Error("offline");
            const request = JSON.parse(Buffer.from(init!.body as Uint8Array).toString()) as {operation_id: string};
            const receipt = this.receipts.get(request.operation_id);
            const reply = this.receiptReplies.shift();
            if (reply === "malformed") return this.malformedReply();
            if (reply === "mismatched" && receipt) return json({status: "accepted", receipt: {...receipt, request: {...receipt.request, session_id: "wrong-session"}}});
            if (reply === "unknown") return json({status: "unknown"});
            return json(receipt ? {status: "accepted", receipt} : {status: "unknown"});
        }
        if (endpoint === "/v1/publish") {
            const header = new Headers(init!.headers).get("x-pi-publication")!;
            const request = decodeArchivePublication(JSON.parse(Buffer.from(header, "base64url").toString()));
            this.requests.push(request);
            if ((request.condition.kind === "absent" && this.body)
                || (request.condition.kind === "exact_base_revision" && request.condition.revision.seq !== String(this.revision))) return failure("stale_base", 409, false);
            this.body = Buffer.from(init!.body as Uint8Array);
            this.metadata = request.metadata ?? null;
            const receipt: Receipt = {request, revision: {binding: this.binding, seq: String(++this.revision)}};
            this.receipts.set(request.operation_id, receipt);
            return this.mutationReply(receipt);
        }
        if (endpoint === "/v1/preserve") {
            const header = new Headers(init!.headers).get("x-pi-preservation");
            const request = decodeArchivePreservation(header ? JSON.parse(Buffer.from(header, "base64url").toString()) : JSON.parse(Buffer.from(init!.body as Uint8Array).toString()));
            this.requests.push(request);
            if (request.mode === "current" && request.revision.seq !== String(this.revision)) return failure("stale_base", 409, false);
            const body = request.mode === "current" ? this.body! : Buffer.from(init!.body as Uint8Array);
            const metadata = request.mode === "current" ? this.metadata : request.metadata ?? null;
            this.variants.push({body: Buffer.from(body), metadata});
            const receipt: PreservationReceipt = {request, variant: {session_id: nativeId, variant_id: randomUUID(), revision: {binding: this.binding, seq: String(this.revision + 1)},
                byte_length: body.length, sha256: digest(body), metadata, uploaded_at: "2026-02-01T00:00:00.000Z"},
                ...(request.mode === "current" ? {source_revision: request.revision, source_uploaded_at: "2026-01-01T00:00:00.000Z"} : {})};
            this.receipts.set(request.operation_id, receipt);
            if (this.losePreserveReply) { this.losePreserveReply = false; throw new Error("lost reply"); }
            return this.mutationReply(receipt);
        }
        throw new Error("Unexpected endpoint");
    }

    private malformedReply(): Response {
        return new Response("{", {headers: {"content-type": "application/json", "content-length": "1"}});
    }

    private mutationReply(receipt: Receipt | PreservationReceipt): Response {
        const invalid = this.invalidMutationReply;
        this.invalidMutationReply = undefined;
        if (invalid === "malformed") return this.malformedReply();
        if (invalid === "mismatched") return json({status: "accepted", receipt: {...receipt, request: {...receipt.request, session_id: "wrong-session"}}});
        return json({status: "accepted", receipt});
    }

    private snapshot(): SessionMetadata {
        return {session_id: nativeId, revision: {binding: this.binding, seq: String(this.revision)}, byte_length: this.body!.length,
            sha256: digest(this.body!), metadata: this.metadata, uploaded_at: "2026-01-01T00:00:00.000Z"};
    }
}

function json(value: unknown): Response {
    const body = JSON.stringify(value);
    return new Response(body, {headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
}
function failure(code: string, status: number, retryable: boolean): Response {
    const body = JSON.stringify({error: {code, retryable, publication_outcome: "unconfirmed"}});
    return new Response(body, {status, headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
}
function digest(body: Buffer): string { return createHash("sha256").update(body).digest("hex"); }
async function cycles(engine: ArchiveWorkerEngine, count: number) {
    for (let index = 0; index < count; index++) { await engine.step(); now += 10; }
}

test("composed divergence commits exact preserve-current receipt before publication and survives restart", async () => {
    const f = fixture();
    const remote = new Remote(); remote.body = Buffer.from("old"); remote.install();
    queued(f, "newer divergent body");
    let engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 3); // binding, download/prepare, preserve-current
        assert.deepEqual(remote.calls, ["/v1/binding", "/v1/download", "/v1/preserve"]);
        assert.equal(remote.body.toString(), "old");
        assert.equal(remote.variants[0]!.body.toString(), "old");
        engine.close();
        engine = new ArchiveWorkerEngine(f.archive, f.store);
        await cycles(engine, 4);
        assert.equal(remote.body.toString(), "newer divergent body");
        assert.equal(remote.calls.filter((call) => call === "/v1/preserve").length, 1);
        const publication = remote.requests.find((request): request is Publication => !("mode" in request))!;
        assert.deepEqual(publication.condition, {kind: "exact_base_revision", revision: {binding: remote.binding, seq: "1"}});
        assert.equal(engine.inspect().eligible, false);
    } finally { engine.close(); f.clean(); }
});

test("lost preservation reply recovers same operation receipt without another variant or unsafe publish", async () => {
    const f = fixture(); const remote = new Remote(); remote.body = Buffer.from("old"); remote.losePreserveReply = true; remote.install();
    queued(f, "newer divergent body"); const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 3);
        const schedule = engine.inspect();
        assert.equal(schedule.eligible, true);
        assert.ok(schedule.nextDue! > now);
        assert.equal(remote.calls.includes("/v1/publish"), false);
        now = schedule.nextDue! + 1;
        await cycles(engine, 4);
        assert.equal(remote.variants.length, 1);
        assert.equal(remote.body.toString(), "newer divergent body");
        assert.ok(remote.calls.includes("/v1/preserve-receipt"));
    } finally { engine.close(); f.clean(); }
});

test("committed mutations retain exclusion and exact receipt recovery after malformed or mismatched replies", async () => {
    for (const kind of ["publish", "uploaded", "current"] as const) {
        for (const invalid of ["malformed", "mismatched"] as const) {
            const f = fixture(); const remote = new Remote();
            const local = kind === "uploaded" ? "short" : "long divergent local history";
            if (kind === "uploaded") remote.body = Buffer.from("the remote divergent body is considerably longer than local");
            if (kind === "current") remote.body = Buffer.from("old");
            remote.invalidMutationReply = invalid;
            remote.receiptReplies = [invalid, "unknown"];
            remote.install(); queued(f, local);
            let engine = new ArchiveWorkerEngine(f.archive, f.store);
            try {
                await cycles(engine, 3);
                const schedule = engine.inspect();
                assert.equal(schedule.eligible, true);
                assert.ok(schedule.nextDue! > now, `${kind}/${invalid} persists recovery backoff`);
                queued(f, `${local} successor`);
                let state = new ArchiveWorkerState(f.archive);
                const destination = state.destinations()[0]!;
                const pending = state.nextOperation([destination.id], Number.MAX_SAFE_INTEGER)!;
                assert.equal(pending.kind, kind);
                assert.equal(pending.state, "uncertain");
                assert.equal(pending.dispatched, true);
                assert.equal(pending.replayBlocked, true);
                const db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
                const row = db.prepare("SELECT id FROM archive_worker_candidates WHERE sha256=?").get(digest(Buffer.from(`${local} successor`))) as {id: string}; db.close();
                const successor = state.candidate(row.id);
                const request: Publication = {binding: remote.binding, session_id: nativeId, operation_id: randomUUID(), condition: {kind: "absent"},
                    byte_length: successor.byteLength, sha256: successor.sha256, metadata: successor.metadata ?? undefined};
                assert.throws(() => state.prepare(successor, "publish", request), /unresolved/);
                state.close();
                engine.close(); engine = new ArchiveWorkerEngine(f.archive, f.store);
                await engine.step(); // Credential revalidation, not permission to replay the mutation.
                now = engine.inspect().nextDue! + 1;
                await engine.step(); // Malformed/mismatched receipt response also remains unresolved.
                assert.ok(engine.inspect().nextDue! > now);
                now = engine.inspect().nextDue! + 1;
                await engine.step(); // An unknown receipt must not turn a protocol-blocked request into a resend.
                assert.ok(engine.inspect().nextDue! > now);
                state = new ArchiveWorkerState(f.archive);
                assert.throws(() => state.prepare(successor, "publish", request), /unresolved/);
                assert.equal(state.nextOperation([destination.id], Number.MAX_SAFE_INTEGER)!.request, pending.request);
                state.close();
                now = engine.inspect().nextDue! + 1;
                await engine.step(); // Finally recover the backend's original valid accepted receipt.
                assert.equal(remote.requests.length, 1, `${kind}/${invalid} never resends the mutation`);
                state = new ArchiveWorkerState(f.archive);
                assert.deepEqual(state.body(successor), Buffer.from(`${local} successor`));
                const original = remote.receipts.get(JSON.parse(pending.request).operation_id)!;
                assert.equal(state.accept(pending, original, kind !== "current"), false, "late acknowledgment cannot clear the successor");
                assert.deepEqual(state.body(successor), Buffer.from(`${local} successor`));
                state.close();
            } finally { engine.close(); f.clean(); }
        }
    }
});

test("persisted publication metadata or native-ID corruption cannot mutate or cover the original candidate", async () => {
    for (const field of ["metadata", "session_id"] as const) {
        for (const dispatched of [false, true]) {
            const f = fixture(); const remote = new Remote(); remote.install();
            if (dispatched) remote.invalidMutationReply = "malformed";
            queued(f, "original history", {title: "Original"});
            const engine = new ArchiveWorkerEngine(f.archive, f.store);
            try {
                await cycles(engine, 2);
                if (dispatched) await engine.step();
                let state = new ArchiveWorkerState(f.archive);
                const destination = state.destinations()[0]!;
                const pending = state.nextOperation([destination.id], Number.MAX_SAFE_INTEGER)!;
                const original = state.candidate(pending.candidate);
                state.close();
                const corrupt = {...JSON.parse(pending.request), ...(field === "metadata" ? {metadata: {title: "Wrong"}} : {session_id: "other-session"})};
                let db = SqliteDatabase.test(false, path.join(f.archive, "archive.sqlite"));
                db.prepare("UPDATE archive_worker_operations SET request=? WHERE id=?").run(JSON.stringify(corrupt), pending.id); db.close();
                const calls = remote.calls.length;
                if (dispatched) now = engine.inspect().nextDue! + 1;
                await engine.step();
                assert.equal(remote.calls.length, calls, "corrupt owned requests never reach mutation or receipt transport");
                assert.equal(remote.requests.length, dispatched ? 1 : 0);
                state = new ArchiveWorkerState(f.archive);
                assert.deepEqual(state.body(original), Buffer.from("original history"));
                assert.equal(state.accept({...pending, request: JSON.stringify(corrupt)}, {request: corrupt, revision: {binding: remote.binding, seq: "2"}}, true), false);
                if (dispatched) assert.equal(state.accept(pending, remote.receipts.get(JSON.parse(pending.request).operation_id)!, true), false);
                assert.deepEqual(state.body(original), Buffer.from("original history"));
                state.close();
                db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
                const stored = db.prepare("SELECT state FROM archive_worker_operations WHERE id=?").get(pending.id) as {state: string};
                const coverage = db.prepare("SELECT COUNT(*) AS count FROM archive_worker_coverage").get() as {count: number}; db.close();
                assert.equal(stored.state, dispatched ? "blocked" : "invalid");
                assert.equal(coverage.count, 0);
                queued(f, "original history successor");
                state = new ArchiveWorkerState(f.archive);
                db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
                const next = db.prepare("SELECT id FROM archive_worker_candidates WHERE sha256=?").get(digest(Buffer.from("original history successor"))) as {id: string}; db.close();
                const successor = state.candidate(next.id);
                const request: Publication = {binding: remote.binding, session_id: nativeId, operation_id: randomUUID(), condition: {kind: "absent"},
                    byte_length: successor.byteLength, sha256: successor.sha256, metadata: successor.metadata ?? undefined};
                if (dispatched) assert.throws(() => state.prepare(successor, "publish", request), /unresolved/);
                else state.prepare(successor, "publish", request);
                assert.deepEqual(state.body(successor), Buffer.from("original history successor"));
                state.close();
            } finally { engine.close(); f.clean(); }
        }
    }
});

test("equal bytes with different metadata preserve incoming under original native identity", async () => {
    const f = fixture(); const remote = new Remote(); remote.body = Buffer.from("same"); remote.metadata = {title: "canonical"}; remote.install();
    queued(f, "same", {title: "incoming"}); const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 5);
        assert.deepEqual(remote.metadata, {title: "canonical"});
        assert.deepEqual(remote.variants.map((v) => v.metadata), [{title: "incoming"}]);
        assert.ok(remote.requests.every((request) => request.session_id === nativeId));
        assert.equal(remote.calls.includes("/v1/publish"), false);
        assert.equal(engine.inspect().eligible, false);
    } finally { engine.close(); f.clean(); }
});

test("0.2 coherent list metadata permits prefix extension but retains unsupported divergence", async () => {
    const f = fixture(); const remote = new Remote(); remote.legacy = true; remote.body = Buffer.from("prefix"); remote.install();
    queued(f, "prefix extension"); let engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 6);
        assert.equal(remote.body.toString(), "prefix extension");
        assert.ok(remote.calls.includes("/v1/list"));
        queued(f, "different");
        engine.close(); engine = new ArchiveWorkerEngine(f.archive, f.store);
        await cycles(engine, 5);
        assert.equal(remote.body.toString(), "prefix extension");
        assert.equal(remote.variants.length, 0);
        assert.equal(engine.inspect().eligible, false);
        const state = new ArchiveWorkerState(f.archive);
        assert.ok(state.destinations().length);
        state.close();
    } finally { engine.close(); f.clean(); }
});

test("an incompatible server blocks automatic archive work before binding or publication", async () => {
    const f = fixture(); const remote = new Remote(); remote.version = "0.3.0"; remote.install(); queued(f, "history");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 5);
        assert.equal(remote.versionChecks, 1);
        assert.deepEqual(remote.calls, []);
        assert.deepEqual(remote.requests, []);
        assert.equal(remote.body, undefined);
        assert.equal(remote.receipts.size, 0);
        assert.equal(engine.inspect().eligible, false);
    } finally { engine.close(); f.clean(); }
});

test("401 blocks credential generation, logout sends nothing, mismatching namespace stays paused", async () => {
    const f = fixture(); const remote = new Remote(); remote.unauthorized = true; remote.install(); queued(f, "history");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 4);
        assert.deepEqual(remote.calls, []);
        assert.equal(remote.versionChecks, 1);
        assert.equal(engine.inspect().eligible, false);
        const old = f.connection!;
        f.connection = undefined; await cycles(engine, 2); assert.equal(remote.calls.length, 0);
        // Unbound work cannot inherit replacement credentials, even at the same origin.
        remote.unauthorized = false;
        f.connection = {...old, generation: randomUUID()}; await cycles(engine, 2);
        assert.equal(remote.calls.length, 0);
        f.connection = old; // Same blocked generation stays blocked.
        await cycles(engine, 2); assert.equal(remote.calls.length, 0);
        assert.equal(remote.versionChecks, 1);
    } finally { engine.close(); f.clean(); }
});

test("new captures proceed behind offline legacy predecessor, preserving raw pending operation after source loss", async () => {
    const f = fixture(); const remote = new Remote(); remote.failReceipt = true; remote.install();
    const oldBody = Buffer.from("old bytes");
    const journal = new ArchiveJournal(f.archive);
    const pending = journal.prepare(origin, remote.binding, {file: f.file, sessionId: nativeId, body: oldBody, metadata: {}});
    assert.equal(pending.kind, "pending"); journal.close();
    fs.writeFileSync(f.file, JSON.stringify({type: "session", id: nativeId, version: 3}) + "\n");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        engine.import(f.manifest());
        await cycles(engine, 3);
        fs.unlinkSync(f.file);
        const state = new ArchiveWorkerState(f.archive);
        const destinations = state.destinations();
        const legacy = destinations.find((d) => d.generation.startsWith("legacy:"))!;
        const operation = state.nextOperation([legacy.id], Number.MAX_SAFE_INTEGER)!;
        assert.equal(state.body(state.candidate(operation.candidate)).toString(), "old bytes");
        assert.equal(operation.state, "uncertain");
        const candidate = state.nextCandidate(destinations.filter((d) => d.id !== legacy.id).map((d) => d.id), Number.MAX_SAFE_INTEGER);
        assert.equal(candidate, undefined, "same-binding/native predecessor blocks execution, not capture");
        const db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
        const count = (db.prepare("SELECT COUNT(*) AS n FROM archive_worker_candidates").get() as {n: number}).n;
        db.close(); state.close();
        assert.equal(count, 2);
        assert.equal(engine.inspect().eligible, true);
    } finally { engine.close(); f.clean(); }
});

test("missing source retains three retries then source-loss evidence and explicit enqueue can retry", async () => {
    const f = fixture(); const remote = new Remote(); remote.install();
    const sourceManifest = {version: 1 as const, id: randomUUID(), origin, generation: f.connection!.generation, source: {version: 1 as const, scope: "current" as const,
        activeSession: {sessionId: nativeId, main: true, identityConflict: false, rootSessionId: nativeId}, rootSessionId: nativeId,
        sessionFile: f.file, sessionDirectory: f.directory, defaultSessionRoots: [f.directory]}};
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        engine.import(sourceManifest); await cycles(engine, 2);
        for (const delay of [5000, 30_000, 300_000]) {
            const schedule = engine.inspect(); assert.equal(schedule.eligible, true);
            assert.ok(schedule.nextDue! <= now + delay);
            now = schedule.nextDue! + 1; await engine.step();
        }
        assert.equal(engine.inspect().eligible, false);
        engine.import({...sourceManifest, id: randomUUID()});
        assert.equal(engine.inspect().eligible, true);
    } finally { engine.close(); f.clean(); }
});

test("credential replacement verifies a bound destination before replay and history rotation fences old requests", async () => {
    const f = fixture(); const remote = new Remote(); remote.install(); queued(f, "retained history");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 2);
        const state = new ArchiveWorkerState(f.archive);
        const destination = state.destinations()[0]!;
        const old = state.nextOperation([destination.id], now)!;
        state.close();
        remote.binding = {...remote.binding, history_generation: "restored"};
        f.connection = {config: {url: origin, apiKey: "replacement"}, generation: randomUUID()};
        await cycles(engine, 5);
        assert.equal(remote.body!.toString(), "retained history");
        const publication = remote.requests.find((request): request is Publication => !("mode" in request))!;
        assert.notEqual(publication.operation_id, JSON.parse(old.request).operation_id);
        assert.equal(publication.binding.history_generation, "restored");
        const reopened = new ArchiveWorkerState(f.archive);
        assert.equal(reopened.accept(old, {request: JSON.parse(old.request), revision: {binding: JSON.parse(old.request).binding, seq: "1"}}, true), false);
        reopened.close();
    } finally { engine.close(); f.clean(); }
});

test("bound work cannot follow replacement credentials to another namespace and resumes after verified return", async () => {
    const f = fixture(); const remote = new Remote(); remote.install(); queued(f, "retained history");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 2);
        const original = {...remote.binding};
        remote.binding = {...remote.binding, namespace_id: "different"};
        f.connection = {config: {url: origin, apiKey: "other-namespace"}, generation: randomUUID()};
        await cycles(engine, 3);
        assert.equal(remote.calls.includes("/v1/publish"), false);
        assert.equal(engine.inspect().eligible, false);
        remote.binding = original;
        f.connection = {config: {url: origin, apiKey: "right-namespace"}, generation: randomUUID()};
        await cycles(engine, 3);
        assert.equal(remote.body!.toString(), "retained history");
    } finally { engine.close(); f.clean(); }
});

test("logout after canonical comparison prevents the subsequent publication", async () => {
    const f = fixture(); const remote = new Remote(); remote.install(); queued(f, "retained history");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 2);
        f.connection = undefined;
        await cycles(engine, 4);
        assert.deepEqual(remote.calls, ["/v1/binding", "/v1/download"]);
        assert.equal(engine.inspect().eligible, false);
        f.connection = {config: {url: origin, apiKey: "renewed"}, generation: randomUUID()};
        await cycles(engine, 3);
        assert.equal(remote.body!.toString(), "retained history");
    } finally { engine.close(); f.clean(); }
});

test("a stale publish cannot reuse preservation of an older compared canonical revision", async () => {
    const f = fixture(); const remote = new Remote(); remote.body = Buffer.from("one"); remote.install(); queued(f, "long divergent local");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 4);
        remote.body = Buffer.from("two"); remote.revision = 3;
        await engine.step();
        now = engine.inspect().nextDue! + 1;
        await cycles(engine, 5);
        assert.deepEqual(remote.variants.map((v) => v.body.toString()), ["one", "two"]);
        assert.equal(remote.body.toString(), "long divergent local");
        const publications = remote.requests.filter((request): request is Publication => !("mode" in request));
        assert.equal(publications.length, 2);
        assert.notEqual(publications[0]!.operation_id, publications[1]!.operation_id);
        assert.deepEqual(publications[1]!.condition, {kind: "exact_base_revision", revision: {binding: remote.binding, seq: "3"}});
    } finally { engine.close(); f.clean(); }
});

test("legacy metadata lookup persists page continuation across restart without incoming-root filtering", async () => {
    const f = fixture(); const remote = new Remote(); remote.legacy = true; remote.paginateLegacy = true;
    remote.body = Buffer.from("prefix"); remote.metadata = {}; remote.install();
    queued(f, "prefix extension", {kind: SessionKind.Main, root_session_id: nativeId});
    let engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 3);
        assert.equal(remote.listRequests.length, 1);
        assert.equal(remote.listRequests[0]!.filters, undefined);
        engine.close(); engine = new ArchiveWorkerEngine(f.archive, f.store);
        await cycles(engine, 4);
        assert.equal(remote.listRequests[1]!.cursor, "second-page");
        assert.equal(remote.calls.filter((endpoint) => endpoint === "/v1/download").length, 1);
        assert.equal(remote.body.toString(), "prefix extension");
    } finally { engine.close(); f.clean(); }
});

test("source obligations pause on logout, changed origin, and superseded unbound credentials", async () => {
    for (const change of ["logout", "origin", "generation"] as const) {
        const f = fixture(); const remote = new Remote(); remote.install();
        fs.writeFileSync(f.file, JSON.stringify({type: "session", id: nativeId}) + "\n", {mode: 0o600});
        const engine = new ArchiveWorkerEngine(f.archive, f.store);
        try {
            engine.import(f.manifest());
            const original = f.connection!;
            f.connection = change === "logout" ? undefined : {config: {url: change === "origin" ? "https://other.example" : origin, apiKey: "replacement"}, generation: randomUUID()};
            await cycles(engine, 3);
            assert.deepEqual(remote.calls, [], change);
            assert.equal(engine.inspect().eligible, false, change);
            const state = new ArchiveWorkerState(f.archive);
            assert.ok(state.nextScope(Number.MAX_SAFE_INTEGER), "paused scope remains durable");
            assert.equal(state.nextSource(Number.MAX_SAFE_INTEGER), undefined, "no scan was performed");
            state.close();
            f.connection = original;
            await cycles(engine, 6);
            assert.equal(remote.body!.toString(), fs.readFileSync(f.file, "utf8"));
        } finally { engine.close(); f.clean(); }
    }
});

test("ordinary accepted appends use exact canonical prefix evidence without another download", async () => {
    const f = fixture(); const remote = new Remote(); remote.install();
    const classification = {kind: SessionKind.Main, root_session_id: nativeId};
    queued(f, "prefix", classification);
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 4);
        queued(f, "prefix extension", classification);
        await cycles(engine, 3);
        assert.equal(remote.body!.toString(), "prefix extension");
        assert.equal(remote.calls.filter((endpoint) => endpoint === "/v1/download").length, 1);
        queued(f, "prefix extension longer", {});
        await cycles(engine, 5);
        assert.equal(remote.calls.filter((endpoint) => endpoint === "/v1/download").length, 2, "losing explicit metadata requires fresh comparison");
        assert.deepEqual(remote.variants.map((entry) => entry.metadata), [classification]);
        assert.deepEqual(remote.metadata, {});
    } finally { engine.close(); f.clean(); }
});

test("accepted-only legacy rows provide a canonical base only after an explicit new capture", async () => {
    const f = fixture(); const remote = new Remote(); remote.body = Buffer.from("prefix"); remote.install();
    const journal = new ArchiveJournal(f.archive);
    const pending = journal.prepare(origin, remote.binding, {file: f.file, sessionId: nativeId, body: remote.body, metadata: {}});
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") throw new Error("Expected legacy publication");
    journal.accept(origin, {request: pending.request, revision: {binding: remote.binding, seq: "1"}});
    journal.close();
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        assert.equal(engine.inspect().eligible, false);
        queued(f, "prefix extension");
        await cycles(engine, 4);
        assert.equal(remote.body.toString(), "prefix extension");
        assert.equal(remote.calls.includes("/v1/download"), false);
    } finally { engine.close(); f.clean(); }
});

test("stale accepted-prefix CAS retires its request and compares the new canonical body", async () => {
    const f = fixture(); const remote = new Remote(); remote.install(); queued(f, "prefix");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 4);
        remote.body = Buffer.from("other"); remote.revision++;
        queued(f, "prefix extension");
        await cycles(engine, 2);
        assert.equal(remote.body.toString(), "other");
        now = engine.inspect().nextDue! + 1;
        await cycles(engine, 5);
        assert.equal(remote.body.toString(), "prefix extension");
        assert.deepEqual(remote.variants.map((entry) => entry.body.toString()), ["other"]);
        assert.equal(remote.calls.filter((endpoint) => endpoint === "/v1/download").length, 2);
    } finally { engine.close(); f.clean(); }
});

test("accepted preserved variants never authorize a canonical append base", async () => {
    const f = fixture(); const remote = new Remote(); remote.body = Buffer.from("long remote divergent body"); remote.install(); queued(f, "local");
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 4);
        queued(f, "local append");
        await cycles(engine, 4);
        assert.equal(remote.calls.filter((endpoint) => endpoint === "/v1/download").length, 2);
        assert.equal(remote.calls.includes("/v1/publish"), false);
        assert.deepEqual(remote.variants.map((entry) => entry.body.toString()), ["local", "local append"]);
    } finally { engine.close(); f.clean(); }
});

test("non-missing deferrals do not consume the first missing-source retry", async () => {
    const f = fixture(); const remote = new Remote(); remote.install();
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        const manifest = f.manifest(); engine.import(manifest);
        await engine.step();
        const state = new ArchiveWorkerState(f.archive);
        const source = state.nextSource(Number.MAX_SAFE_INTEGER)!;
        for (const reason of ["source-changing", "ancestry-unresolved", "backlog-capacity"]) state.defer("sources", source.id, 0, reason);
        state.close();
        await engine.step();
        assert.equal(engine.inspect().nextDue, now + 5000);
    } finally { engine.close(); f.clean(); }
});

test("a stable but unfinished trailing record remains retryable until its writer completes it", async () => {
    const f = fixture(); const remote = new Remote(); remote.install();
    const partial = JSON.stringify({type: "session", version: 3, id: nativeId}) + "\n" + '{"type":"session_info","name":"unfinished';
    fs.writeFileSync(f.file, partial, {mode: 0o600});
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        engine.import(f.manifest());
        await cycles(engine, 2);
        const schedule = engine.inspect();
        assert.equal(schedule.eligible, true);
        assert.ok(schedule.nextDue! > now);
        assert.equal(remote.calls.includes("/v1/publish"), false);
        fs.appendFileSync(f.file, '"}\n');
        now = schedule.nextDue! + 1;
        await cycles(engine, 5);
        assert.equal(remote.body!.toString(), fs.readFileSync(f.file, "utf8"));
        assert.equal(engine.inspect().eligible, false);
    } finally { engine.close(); f.clean(); }
});

test("incremental owned parent paths resolve the same child in both observation orders across restart", async () => {
    for (const rightFirst of [false, true]) {
        const f = fixture();
        const binding: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "history"};
        mock.method(globalThis, "fetch", async (url: URL | RequestInfo) => {
            const endpoint = new URL(String(url)).pathname;
            if (endpoint === "/v1/version") return json({version: "0.4.0"});
            return endpoint === "/v1/binding"
                ? json({binding, head: "0", capabilities: ["preserved_variants_v1"]}) : failure("overloaded", 503, true);
        });
        const wrong = path.join(f.directory, "wrong-parent.jsonl");
        const right = path.join(f.directory, "right-parent.jsonl");
        const child = path.join(f.directory, "child.jsonl");
        const parentId = "subagent-parent", childId = "subagent-child";
        const record = (id: string, parent: string, root?: string) => ({type: "custom", customType: "pilot.subagent", data: {
            version: 1, sessionId: id, kind: SessionKind.Subagent, parentAgentIdentifier: parent,
            ...(root ? {rootSessionId: root} : {}),
        }});
        const body = (id: string, entry: unknown, parentSession?: string) => [
            {type: "session", version: 3, id, ...(parentSession ? {parentSession} : {})}, entry,
        ].map((row) => JSON.stringify(row)).join("\n") + "\n";
        fs.writeFileSync(wrong, body(parentId, record(parentId, "other-root", "other-root")));
        fs.writeFileSync(right, body(parentId, record(parentId, nativeId, nativeId)));
        fs.writeFileSync(child, body(childId, record(childId, parentId), right));
        const state = new ArchiveWorkerState(f.archive);
        const manifest = f.manifest(); state.import(manifest);
        state.addSources(state.scope(manifest.id), rightFirst ? [right, child, wrong] : [wrong, child, right], null, true);
        state.close();
        let engine = new ArchiveWorkerEngine(f.archive, f.store);
        try {
            await cycles(engine, 2);
            engine.close(); engine = new ArchiveWorkerEngine(f.archive, f.store);
            await cycles(engine, 7);
            const db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
            const captures = db.prepare("SELECT metadata,body FROM archive_worker_candidates WHERE session_id=?").all(childId) as Array<{metadata: string; body: Buffer}>;
            const observation = db.prepare("SELECT state FROM archive_worker_sources WHERE file=?").get(child) as {state: string};
            db.close();
            assert.equal(captures.length, 1, `observation order right-first=${rightFirst}`);
            assert.equal(JSON.parse(captures[0]!.metadata).root_session_id, nativeId);
            assert.equal(JSON.parse(captures[0]!.metadata).kind, SessionKind.Subagent);
            assert.deepEqual(captures[0]!.body, fs.readFileSync(child));
            assert.equal(observation.state, "captured");
        } finally { engine.close(); f.clean(); }
    }
});

test("a legacy child uses cached active-root evidence after root source loss and worker restart", async () => {
    const f = fixture();
    const binding: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "history"};
    mock.method(globalThis, "fetch", async (url: URL | RequestInfo) => {
        const endpoint = new URL(String(url)).pathname;
        if (endpoint === "/v1/version") return json({version: "0.4.0"});
        return endpoint === "/v1/binding"
            ? json({binding, head: "0", capabilities: ["preserved_variants_v1"]}) : failure("overloaded", 503, true);
    });
    const childId = "subagent-missing-root-child";
    const child = path.join(f.directory, "legacy-child.jsonl");
    const childBody = Buffer.from([
        {type: "session", version: 3, id: childId, parentSession: path.basename(f.file)},
        {type: "custom", customType: "pilot.subagent", data: {parentAgentIdentifier: nativeId}},
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    fs.writeFileSync(child, childBody);
    const state = new ArchiveWorkerState(f.archive);
    const manifest = f.manifest(); state.import(manifest);
    state.addSources(state.scope(manifest.id), [f.file, child], null, true);
    state.close();
    const childDue = now + 1_000_000;
    let db = SqliteDatabase.test(false, path.join(f.archive, "archive.sqlite"));
    db.prepare("UPDATE archive_worker_sources SET due=? WHERE file=?").run(childDue, child); db.close();
    let engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await engine.step();
        for (const delay of [5000, 30_000, 300_000]) {
            assert.equal(engine.inspect().nextDue, now + delay);
            now += delay;
            await engine.step();
        }
        db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
        const lost = db.prepare("SELECT state FROM archive_worker_sources WHERE file=?").get(f.file) as {state: string}; db.close();
        assert.equal(lost.state, "source-lost");
        engine.close(); engine = new ArchiveWorkerEngine(f.archive, f.store);
        now = childDue;
        await cycles(engine, 3);
        db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
        const captures = db.prepare("SELECT session_id,metadata,body FROM archive_worker_candidates").all() as Array<{session_id: string; metadata: string; body: Buffer}>;
        const observations = db.prepare("SELECT file,state FROM archive_worker_sources ORDER BY id").all() as Array<{file: string; state: string}>;
        db.close();
        assert.equal(captures.length, 1);
        assert.equal(captures[0]!.session_id, childId);
        assert.equal(JSON.parse(captures[0]!.metadata).kind, SessionKind.Subagent);
        assert.equal(JSON.parse(captures[0]!.metadata).root_session_id, nativeId);
        assert.deepEqual(captures[0]!.body, childBody);
        assert.deepEqual(observations, [{file: f.file, state: "source-lost"}, {file: child, state: "captured"}]);
    } finally { engine.close(); f.clean(); }
});

test("a later duplicate native parent invalidates an excluded ID-derived source after restart", async () => {
    const f = fixture(); const remote = new Remote(); remote.install();
    const wrong = path.join(f.directory, "wrong.jsonl"), right = path.join(f.directory, "right.jsonl"), child = path.join(f.directory, "child.jsonl");
    const parentId = "subagent-duplicate", childId = "subagent-dependent";
    const native = (id: string, parent: string, root?: string, parentSession?: string) => [
        {type: "session", id, version: 3, ...(parentSession ? {parentSession} : {})},
        {type: "custom", customType: "pilot.subagent", data: {version: 1, sessionId: id, kind: SessionKind.Subagent,
            parentAgentIdentifier: parent, ...(root ? {rootSessionId: root} : {})}},
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    fs.writeFileSync(wrong, native(parentId, "other-root", "other-root"));
    fs.writeFileSync(right, native(parentId, nativeId, nativeId));
    fs.writeFileSync(child, native(childId, parentId));
    const state = new ArchiveWorkerState(f.archive);
    const manifest = f.manifest(); state.import(manifest);
    state.addSources(state.scope(manifest.id), [wrong, child, right], null, true); state.close();
    let engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        await cycles(engine, 2);
        let db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
        const before = db.prepare("SELECT state FROM archive_worker_sources WHERE file=?").get(child) as {state: string}; db.close();
        assert.equal(before.state, "excluded");
        engine.close(); engine = new ArchiveWorkerEngine(f.archive, f.store);
        await cycles(engine, 4);
        db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
        const after = db.prepare("SELECT state,diagnostic FROM archive_worker_sources WHERE file=?").get(child) as {state: string; diagnostic: string}; db.close();
        assert.equal(after.state, "ready");
        assert.equal(after.diagnostic, "ancestry-unresolved");
        fs.writeFileSync(child, native(childId, parentId, undefined, right));
        now += 6000;
        await cycles(engine, 3);
        db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
        const captured = db.prepare("SELECT metadata FROM archive_worker_candidates WHERE session_id=?").get(childId) as {metadata: string}; db.close();
        assert.equal(JSON.parse(captured.metadata).root_session_id, nativeId);
    } finally { engine.close(); f.clean(); }
});

test("definitively malformed unterminated JSON is terminal rather than keeping the engine alive", async () => {
    for (const ending of ["}", '{"type":"message",}', '{"type":truX}']) {
        const f = fixture(); const remote = new Remote(); remote.install();
        fs.writeFileSync(f.file, JSON.stringify({type: "session", id: nativeId}) + "\n" + ending);
        const engine = new ArchiveWorkerEngine(f.archive, f.store);
        try {
            engine.import(f.manifest()); await cycles(engine, 3);
            assert.equal(engine.inspect().eligible, false, ending);
            assert.equal(remote.calls.includes("/v1/publish"), false);
            const db = SqliteDatabase.test(true, path.join(f.archive, "archive.sqlite"));
            const observation = db.prepare("SELECT state,diagnostic FROM archive_worker_sources WHERE file=?").get(f.file) as {state: string; diagnostic: string}; db.close();
            assert.deepEqual(observation, {state: "invalid", diagnostic: "invalid"});
        } finally { engine.close(); f.clean(); }
    }
});

test("import freezes the outgoing source DTO before live context identity changes", async () => {
    const f = fixture(); const remote = new Remote(); remote.install();
    fs.writeFileSync(f.file, JSON.stringify({type: "session", version: 3, id: nativeId}) + "\n", {mode: 0o600});
    const engine = new ArchiveWorkerEngine(f.archive, f.store);
    try {
        const manifest = f.manifest();
        engine.import(manifest);
        manifest.source.sessionFile = path.join(f.directory, "new-selected.jsonl");
        manifest.source.activeSession.sessionId = "new-selected";
        manifest.source.rootSessionId = "new-selected";
        await cycles(engine, 6);
        assert.equal(remote.body!.toString(), fs.readFileSync(f.file, "utf8"));
        assert.ok(remote.requests.every((request) => request.session_id === nativeId));
    } finally { engine.close(); f.clean(); }
});
