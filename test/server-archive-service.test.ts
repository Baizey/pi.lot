import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {test} from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {SessionArchive, type ArchiveClientInterface, type ArchiveListInput} from "../src/server/SessionArchive.js";
import {ArchiveJournal, type ArchivePendingUpload} from "../src/server/ArchiveJournal.js";
import {getSessionRootId, SessionKind} from "../src/sessions/SessionIdentity.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {sameArchivePublication, type Binding, type ListRequest, type Publication,
    type Receipt, type ReceiptOutcome, type SessionMetadata} from "../src/server/ArchiveProtocol.js";

const config = {url: "https://archive.example", apiKey: "synthetic-never-print-this-key"};
class ServerFixture implements ArchiveClientInterface {
    readonly identity: Binding = {server_id: randomUUID(), namespace_id: randomUUID(), history_generation: randomUUID()};
    readonly requests: Publication[] = [];
    readonly receiptRequests: Publication[] = [];
    readonly receipts = new Map<string, Receipt>();
    readonly sessions = new Map<string, {receipt: Receipt; body: Buffer}>();
    head = 0;
    loseReply = false;
    reject = false;
    requestedList: ListRequest | undefined;

    async binding() { return {binding: this.identity, head: String(this.head)}; }
    async list(request: ListRequest) {
        this.requestedList = request;
        return {binding: this.identity, sessions: [], next_cursor: null};
    }
    async receipt(request: Publication): Promise<ReceiptOutcome> {
        this.receiptRequests.push(request);
        const accepted = this.receipts.get(request.operation_id);
        if (!accepted) return {status: "unknown"};
        assert.ok(sameArchivePublication(accepted.request, request));
        return {status: "accepted", receipt: accepted};
    }
    async publish(request: Publication, body: Uint8Array): Promise<Receipt> {
        this.requests.push(request);
        assert.equal(createHash("sha256").update(body).digest("hex"), request.sha256);
        if (this.reject) throw new Error(`Remote operation failed: ${config.apiKey}`);
        const prior = this.sessions.get(request.session_id);
        if (request.condition.kind === "absent") {
            if (prior) throw new Error("Session already exists; no trusted local base.");
        } else {
            if (!prior || prior.receipt.revision.seq !== request.condition.revision.seq) throw new Error("Stale base.");
        }
        const accepted = {request, revision: {binding: this.identity, seq: String(++this.head)}};
        this.receipts.set(request.operation_id, accepted);
        this.sessions.set(request.session_id, {receipt: accepted, body: Buffer.from(body)});
        if (this.loseReply) { this.loseReply = false; throw new Error("Reply lost after remote commit"); }
        return accepted;
    }
    async download(_binding: Binding, sessionId: string) {
        const stored = this.sessions.get(sessionId);
        if (!stored) throw new Error("Session not found");
        const snapshot: SessionMetadata = {session_id: sessionId, revision: stored.receipt.revision,
            byte_length: stored.body.length, sha256: stored.receipt.request.sha256};
        return {snapshot, body: stored.body};
    }
}

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-archive-service-"));
    const file = path.join(directory, "session.jsonl");
    const stateDirectory = path.join(directory, "state");
    const manager = SessionManager.inMemory(undefined, {id: "root"});
    let body = Buffer.from("original history\n");
    const server = new ServerFixture();
    const snapshots = {
        discover: async (_scope: "current" | "all", signal?: AbortSignal) => {
            signal?.throwIfAborted(); return {files: [file], warnings: []};
        },
        snapshot: async (source: string, signal?: AbortSignal) => {
            signal?.throwIfAborted();
            return {file: source, sessionId: "root", body,
                metadata: {kind: SessionKind.Main, root_session_id: "root"}, warnings: []};
        },
    };
    const service = () => new SessionArchive(config, {client: server, stateDirectory, createSessions: () => snapshots});
    return {directory, stateDirectory, manager, server, snapshots, service,
        setBody: (value: string) => { body = Buffer.from(value); },
        clean: () => fs.rmSync(directory, {recursive: true, force: true})};
}

test("explicit upload skips unchanged snapshots and updates only from its own accepted receipt", async () => {
    const f = fixture();
    try {
        assert.deepEqual(await f.service().upload(f.manager, "current"),
            {uploaded: 1, unchanged: 0, failed: 0, warnings: [], failures: []});
        assert.equal((await f.service().upload(f.manager, "current")).unchanged, 1);
        assert.equal(f.server.requests.length, 1);
        f.setBody("original history\nnew turn\n");
        assert.equal((await f.service().upload(f.manager, "all")).uploaded, 1);
        assert.deepEqual(f.server.requests[1]!.condition,
            {kind: "exact_base_revision", revision: f.server.receipts.get(f.server.requests[0]!.operation_id)!.revision});
        assert.deepEqual(f.server.sessions.get("root")!.body, Buffer.from("original history\nnew turn\n"));
    } finally { f.clean(); }
});

test("lost acceptance reply is recovered across service instances before a changed local successor", async () => {
    const f = fixture();
    try {
        f.server.loseReply = true;
        const interrupted = await f.service().upload(f.manager, "current");
        assert.equal(interrupted.failed, 1);
        assert.equal(f.server.requests.length, 1);
        const original = f.server.requests[0]!;
        f.setBody("original history\nafter disconnect\n");
        const recovered = await f.service().upload(f.manager, "current");
        assert.equal(recovered.uploaded, 1);
        assert.equal(recovered.failed, 0);
        assert.equal(f.server.requests.length, 2, "accepted original was recovered by receipt, not republished");
        assert.notEqual(f.server.requests[1]!.operation_id, original.operation_id);
        assert.deepEqual(f.server.requests[1]!.condition,
            {kind: "exact_base_revision", revision: f.server.receipts.get(original.operation_id)!.revision});
    } finally { f.clean(); }
});

test("unknown failed operation is replayed byte-for-byte before a fresh snapshot is published", async () => {
    const f = fixture();
    try {
        f.server.reject = true;
        const failed = await f.service().upload(f.manager, "current");
        assert.equal(failed.failed, 1);
        assert.ok(!JSON.stringify(failed).includes(config.apiKey));
        const original = f.server.requests[0]!;
        f.server.reject = false;
        f.setBody("original history\nappended\n");
        const recovered = await f.service().upload(f.manager, "current");
        assert.equal(recovered.uploaded, 1);
        assert.deepEqual(f.server.requests[1], original);
        assert.notEqual(f.server.requests[2]!.operation_id, original.operation_id);
        assert.deepEqual(f.server.sessions.get("root")!.body, Buffer.from("original history\nappended\n"));
    } finally { f.clean(); }
});

test("truncated local history and another machine's remote update cannot be overwritten", async () => {
    const f = fixture();
    try {
        await f.service().upload(f.manager, "current");
        f.setBody("old\n");
        assert.equal((await f.service().upload(f.manager, "current")).failed, 1);
        assert.equal(f.server.requests.length, 1);
        const prior = f.server.sessions.get("root")!;
        f.server.sessions.set("root", {...prior, receipt: {...prior.receipt,
            revision: {binding: f.server.identity, seq: "99"}}});
        f.setBody("original history\nnew local turn\n");
        assert.equal((await f.service().upload(f.manager, "current")).failed, 1);
        assert.deepEqual(f.server.sessions.get("root")!.body, Buffer.from("original history\n"));
        assert.equal(f.server.requests[1]!.condition.kind, "exact_base_revision");
    } finally { f.clean(); }
});

test("first contact never adopts a remote revision as a trusted local update base", async () => {
    const f = fixture();
    try {
        const foreign = {binding: f.server.identity, session_id: "root", operation_id: randomUUID(),
            condition: {kind: "absent" as const}, byte_length: 7,
            sha256: createHash("sha256").update("foreign").digest("hex")};
        const accepted = {request: foreign, revision: {binding: f.server.identity, seq: "12"}};
        f.server.sessions.set("root", {receipt: accepted, body: Buffer.from("foreign")});
        const report = await f.service().upload(f.manager, "current");
        assert.equal(report.failed, 1);
        assert.equal(f.server.requests[0]!.condition.kind, "absent");
        assert.deepEqual(f.server.sessions.get("root")!.body, Buffer.from("foreign"));
    } finally { f.clean(); }
});

test("list forwards filters and continuation without creating any local upload state", async () => {
    const f = fixture();
    try {
        const input = {filters: {kind: SessionKind.Main, root_session_id: "root"}, cursor: "cursor", limit: 25};
        await f.service().list(input);
        assert.deepEqual(f.server.requestedList, {binding: f.server.identity, ...input});
        assert.equal(fs.existsSync(f.stateDirectory), false);
        assert.equal(f.server.requests.length, 0);
    } finally { f.clean(); }
});

test("service validates list parameters and fetch IDs before binding and normalizes accepted filters", async () => {
    const f = fixture();
    try {
        let bindings = 0;
        const binding = f.server.binding.bind(f.server);
        f.server.binding = async () => { bindings++; return binding(); };
        for (const input of [
            {filters: {started_from: "2026-02-30T00:00:00Z"}},
            {filters: {activity_from: "2026-02-01T00:00:00Z", activity_to: "2026-01-01T00:00:00Z"}},
            {filters: {root_session_id: "root\n"}},
            ...["", "cursor\u007f", "x".repeat(4097)].map((cursor) => ({cursor})),
            ...[0, -1, 1.5, NaN, Infinity, 4294967296, null].map((limit) => ({limit})),
        ]) await assert.rejects(f.service().list(input as ArchiveListInput), /Invalid archive protocol data/);
        for (const id of ["", "id\n", "é".repeat(257), "\ud800"]) {
            await assert.rejects(f.service().fetch(id), /Invalid archive protocol data/);
        }
        assert.equal(bindings, 0);
        assert.equal(f.server.requestedList, undefined);
        assert.equal(fs.existsSync(f.stateDirectory), false);
        await f.service().list({filters: {started_from: "2026-01-01T02:00:00+02:00"}, cursor: "opaque"});
        assert.equal(bindings, 1);
        assert.deepEqual(f.server.requestedList, {binding: f.server.identity, limit: 50,
            filters: {started_from: "2026-01-01T00:00:00.000Z"}, cursor: "opaque"});
    } finally { f.clean(); }
});

test("fetch caches exact opaque bytes privately using safe names and never imports the session", async () => {
    const f = fixture();
    try {
        const body = Buffer.from([0, 255, 1, 2, 3]);
        const id = "../untrusted/session";
        const request: Publication = {binding: f.server.identity, session_id: id, operation_id: randomUUID(),
            condition: {kind: "absent"}, byte_length: body.length,
            sha256: createHash("sha256").update(body).digest("hex")};
        f.server.sessions.set(id, {receipt: {request, revision: {binding: f.server.identity, seq: "1"}}, body});
        const fetched = await f.service().fetch(id);
        assert.ok(fetched.path.startsWith(`${f.stateDirectory}${path.sep}downloads${path.sep}`));
        assert.deepEqual(fs.readFileSync(fetched.path), body);
        assert.equal(fs.statSync(fetched.path).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(fetched.path)).mode & 0o777, 0o700);
        assert.equal(f.manager.getEntries().length, 0);
        assert.equal(f.server.requests.length, 0);
        assert.equal(fs.existsSync(path.join(f.stateDirectory, "archive.sqlite")), false);
        assert.equal(fs.readdirSync(path.dirname(fetched.path)).length, 1);
    } finally { f.clean(); }
});

test("cancellation before discovery creates no journal and sends no publication", async () => {
    const f = fixture();
    try {
        const controller = new AbortController(); controller.abort(new Error("Cancelled"));
        await assert.rejects(f.service().upload(f.manager, "current", controller.signal), /Cancelled/);
        assert.equal(f.server.requests.length, 0);
        assert.equal(fs.existsSync(f.stateDirectory), false);
    } finally { f.clean(); }
});

for (const accepted of [true, false]) {
    test(`frozen pending upload recovers without a readable live source (remote accepted=${accepted})`, async () => {
        const f = fixture();
        try {
            f.server.loseReply = accepted;
            f.server.reject = !accepted;
            assert.equal((await f.service().upload(f.manager, "current")).failed, 1);
            const original = f.server.requests[0]!;
            f.server.reject = false;
            f.snapshots.discover = async () => ({files: [], warnings: []});
            f.snapshots.snapshot = async () => { throw new Error("Source is missing or invalid"); };
            const recovered = await f.service().upload(f.manager, "current");
            assert.equal(recovered.uploaded, 1);
            assert.equal(recovered.failed, 0);
            assert.deepEqual(f.server.receiptRequests.at(-1), original);
            assert.equal(f.server.requests.length, accepted ? 1 : 2);
            if (!accepted) assert.deepEqual(f.server.requests[1], original);
            assert.deepEqual(f.server.sessions.get("root")!.body, Buffer.from("original history\n"));
            const journal = new ArchiveJournal(f.stateDirectory);
            try { assert.deepEqual(journal.pendingRequests(config.url, f.server.identity), []); }
            finally { journal.close(); }
        } finally { f.clean(); }
    });
}

for (const partial of [false, true]) {
    test(`discovered ancestry recovers frozen siblings before snapshots (partial identity=${partial})`, async () => {
        const f = fixture();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const discoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
        let uploading: ReturnType<SessionArchive["upload"]> | undefined;
        try {
            const root = "R";
            const currentId = partial ? "resumed-partial-child" : "subagent-resumed-legacy";
            const currentFile = path.join(f.directory, "resumed.jsonl");
            const identity = partial
                ? {version: 1, sessionId: currentId, kind: SessionKind.Subagent, parentAgentIdentifier: "subagent-parent"}
                : {parentAgentIdentifier: "subagent-parent"};
            fs.writeFileSync(currentFile, [
                {type: "session", version: 3, id: currentId, timestamp: "2026-01-01T00:00:00Z", cwd: f.directory},
                {type: "custom", id: "identity", parentId: null, timestamp: "2026-01-01T00:00:00Z",
                    customType: "pilot.subagent", data: identity},
            ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", {mode: 0o600});
            const manager = SessionManager.open(currentFile, f.directory);
            assert.equal(getSessionRootId(manager), undefined, "only discovery can recover this child's root");
            const missingFile = path.join(f.directory, "missing-sibling.jsonl");
            const invalidFile = path.join(f.directory, "invalid-sibling.jsonl");
            fs.writeFileSync(invalidFile, "not valid JSONL\n", {mode: 0o600});
            const freshFile = path.join(f.directory, "fresh.jsonl");
            const journal = new ArchiveJournal(f.stateDirectory);
            const prepare = (sessionId: string, file: string, family = root): ArchivePendingUpload => {
                const value = journal.prepare(config.url, f.server.identity, {sessionId, file,
                    body: Buffer.from(`frozen ${sessionId}\n`),
                    metadata: {kind: SessionKind.Subagent, root_session_id: family}});
                assert.equal(value.kind, "pending");
                if (value.kind !== "pending") throw new Error("Expected frozen operation");
                return value;
            };
            let current: ArchivePendingUpload;
            let missing: ArchivePendingUpload;
            let accepted: ArchivePendingUpload;
            let unrelated: ArchivePendingUpload;
            try {
                current = prepare(currentId, currentFile);
                missing = prepare("subagent-missing", missingFile);
                accepted = prepare("subagent-invalid", invalidFile);
                unrelated = prepare("subagent-unrelated", path.join(f.directory, "unrelated.jsonl"), "other-root");
            } finally { journal.close(); }
            const acceptedReceipt = await f.server.publish(accepted.request, accepted.body);
            f.server.requests.length = 0;
            const sentBodies: Buffer[] = [];
            const publish = f.server.publish.bind(f.server);
            f.server.publish = async (request, body) => {
                sentBodies.push(Buffer.from(body));
                // This operation is eligible in both passes; failure must not cause a second attempt.
                f.server.reject = partial && request.operation_id === current.request.operation_id;
                return publish(request, body);
            };
            const pendingIds = () => {
                const inspection = new ArchiveJournal(f.stateDirectory);
                try { return inspection.pendingRequests(config.url, f.server.identity).map((entry) => entry.request.operation_id).sort(); }
                finally { inspection.close(); }
            };
            const snapshots: string[] = [];
            const service = new SessionArchive(config, {client: f.server, stateDirectory: f.stateDirectory,
                createSessions: () => ({
                    discover: async () => {
                        entered();
                        await gate;
                        return {rootSessionId: root, files: [currentFile, freshFile], warnings: []};
                    },
                    snapshot: async (file) => {
                        snapshots.push(file);
                        assert.deepEqual(new Set(f.server.receiptRequests), new Set([current.request, missing.request, accepted.request]));
                        assert.equal(f.server.receiptRequests.length, 3, "no operation is retried twice");
                        assert.deepEqual(pendingIds(), [unrelated.request.operation_id,
                            ...(partial ? [current.request.operation_id] : [])].sort());
                        assert.ok(file === currentFile || file === freshFile, "missing/invalid sources must not be recaptured");
                        return {file, sessionId: file === currentFile ? currentId : "subagent-fresh",
                            body: file === currentFile ? current.body : Buffer.from("fresh snapshot\n"),
                            metadata: {kind: SessionKind.Subagent, root_session_id: root}, warnings: []};
                    },
                })});
            uploading = service.upload(manager, "current");
            await Promise.race([discoveryEntered, uploading.then(() => assert.fail("Upload finished before discovery gate"))]);
            assert.deepEqual(f.server.receiptRequests, [current.request], "directly identifiable recovery precedes discovery");
            assert.deepEqual(f.server.requests, [current.request]);
            assert.deepEqual(sentBodies, [current.body]);
            assert.deepEqual(snapshots, []);
            assert.deepEqual(pendingIds(), [missing.request.operation_id, accepted.request.operation_id,
                unrelated.request.operation_id, ...(partial ? [current.request.operation_id] : [])].sort());
            if (!partial) assert.deepEqual(f.server.sessions.get(currentId)?.body, current.body);
            release();
            const report = await uploading;
            assert.equal(report.uploaded, partial ? 3 : 4);
            assert.equal(report.failed, partial ? 1 : 0);
            assert.equal(report.unchanged, 0);
            assert.deepEqual(report.failures.map((failure) => failure.file), partial ? [currentFile] : []);
            assert.deepEqual(snapshots, partial ? [freshFile] : [currentFile, freshFile]);
            assert.deepEqual(f.server.requests.slice(0, 2), [current.request, missing.request]);
            assert.deepEqual(sentBodies.slice(0, 2), [current.body, missing.body]);
            assert.equal(f.server.requests.length, 3, "accepted sibling is recovered by receipt, not republished");
            assert.equal(f.server.requests[2]!.session_id, "subagent-fresh");
            assert.deepEqual(f.server.sessions.get(accepted.request.session_id)?.receipt, acceptedReceipt);
            assert.deepEqual(f.server.sessions.get(missing.request.session_id)?.body, missing.body);
            assert.deepEqual(pendingIds(), [unrelated.request.operation_id,
                ...(partial ? [current.request.operation_id] : [])].sort());
            assert.equal(fs.existsSync(missingFile), false);
            assert.equal(fs.readFileSync(invalidFile, "utf8"), "not valid JSONL\n");
        } finally {
            release();
            await uploading?.catch(() => {});
            f.clean();
        }
    });
}

test("discovered-family operation with missing frozen body fails without recapturing its source", async () => {
    const f = fixture();
    try {
        const file = path.join(f.directory, "would-be-live-source.jsonl");
        fs.writeFileSync(file, "new live bytes must not replace the frozen operation\n", {mode: 0o600});
        const body = Buffer.from("lost frozen history\n");
        const request: Publication = {binding: f.server.identity, session_id: "subagent-sibling", operation_id: randomUUID(),
            condition: {kind: "absent"}, byte_length: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
            metadata: {kind: SessionKind.Subagent, root_session_id: "R"}};
        fs.mkdirSync(f.stateDirectory, {mode: 0o700});
        const databaseFile = path.join(f.stateDirectory, "archive.sqlite");
        fs.writeFileSync(databaseFile, "", {mode: 0o600});
        // Deliberately malformed disposable storage models lost bytes. No production
        // checks are disabled: ArchiveJournal must reject the row when recovering it.
        const database = SqliteDatabase.test(false, databaseFile);
        try {
            database.exec(`CREATE TABLE archive_uploads (
                profile TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL,
                accepted TEXT, pending TEXT, body BLOB, PRIMARY KEY (profile, session_id)
            )`);
            database.prepare("INSERT INTO archive_uploads (profile, session_id, source, pending, body) VALUES (?, ?, ?, ?, NULL)")
                .run(JSON.stringify([config.url, f.server.identity.server_id, f.server.identity.namespace_id,
                    f.server.identity.history_generation]), request.session_id, file, JSON.stringify(request));
        } finally { database.close(); }
        let snapshots = 0;
        const manager = SessionManager.inMemory(f.directory, {id: "subagent-resumed"});
        assert.equal(getSessionRootId(manager), undefined);
        const service = new SessionArchive(config, {client: f.server, stateDirectory: f.stateDirectory,
            createSessions: () => ({
                discover: async () => ({rootSessionId: "R", files: [file], warnings: []}),
                snapshot: async () => { snapshots++; throw new Error("Must not replace lost frozen bytes with a live snapshot"); },
            })});
        const report = await service.upload(manager, "current");
        assert.equal(report.failed, 1);
        assert.equal(report.uploaded, 0);
        assert.equal(report.failures[0]?.file, file);
        assert.match(report.failures[0]!.message, /journal is invalid/);
        assert.equal(snapshots, 0);
        assert.deepEqual(f.server.receiptRequests, []);
        assert.deepEqual(f.server.requests, []);
        const journal = new ArchiveJournal(f.stateDirectory);
        try { assert.deepEqual(journal.pendingRequests(config.url, f.server.identity), [{source: file, request}]); }
        finally { journal.close(); }
    } finally { f.clean(); }
});

test("current-family recovery does not publish unrelated frozen operations", async () => {
    const f = fixture();
    try {
        const journal = new ArchiveJournal(f.stateDirectory);
        journal.prepare(config.url, f.server.identity, {file: "/missing/unrelated.jsonl", sessionId: "unrelated",
            body: Buffer.from("frozen unrelated history"), metadata: {kind: SessionKind.Main, root_session_id: "unrelated"}});
        journal.close();
        f.snapshots.discover = async () => ({files: [], warnings: []});
        assert.equal((await f.service().upload(f.manager, "current")).uploaded, 0);
        assert.equal(f.server.requests.length, 0);
        assert.equal(f.server.receiptRequests.length, 0);
        assert.equal((await f.service().upload(f.manager, "all")).uploaded, 1);
        assert.equal(f.server.requests[0]!.session_id, "unrelated");
    } finally { f.clean(); }
});

for (const lostInitialReply of [false, true]) {
    test(`a concurrent stale source capture cannot regress an accepted successor (lost initial reply=${lostInitialReply})`, async () => {
        const f = fixture();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let captured!: () => void;
        const capture = new Promise<void>(resolve => { captured = resolve; });
        try {
            f.server.loseReply = lostInitialReply;
            await f.service().upload(f.manager, "current");
            const stale = new SessionArchive(config, {client: f.server, stateDirectory: f.stateDirectory,
                createSessions: () => ({discover: f.snapshots.discover, snapshot: async (file, signal) => {
                    const value = await f.snapshots.snapshot(file, signal);
                    captured(); await gate;
                    return value;
                }})});
            const uploading = stale.upload(f.manager, "current");
            await capture;
            f.setBody("original history\nnewer accepted turn\n");
            assert.equal((await f.service().upload(f.manager, "current")).uploaded, 1);
            release();
            assert.equal((await uploading).failed, 1);
            assert.equal(f.server.requests.length, 2);
            assert.deepEqual(f.server.sessions.get("root")!.body, Buffer.from("original history\nnewer accepted turn\n"));
        } finally { release(); f.clean(); }
    });
}

test("cache identities include origin, server, namespace, and generation", async () => {
    const f = fixture();
    try {
        const original = {...f.server.identity};
        const variants = [
            {url: config.url, binding: original},
            {url: "https://other-archive.example", binding: original},
            {url: config.url, binding: {...original, server_id: randomUUID()}},
            {url: config.url, binding: {...original, namespace_id: randomUUID()}},
            {url: config.url, binding: {...original, history_generation: randomUUID()}},
        ];
        const paths = new Set<string>();
        for (const variant of variants) {
            const client = new ServerFixture();
            Object.assign(client.identity, variant.binding);
            const body = Buffer.from("same complete opaque snapshot");
            const request: Publication = {binding: client.identity, session_id: "same-id", operation_id: randomUUID(),
                condition: {kind: "absent"}, byte_length: body.length,
                sha256: createHash("sha256").update(body).digest("hex")};
            client.sessions.set("same-id", {body, receipt: {request, revision: {binding: client.identity, seq: "1"}}});
            const archive = new SessionArchive({...config, url: variant.url}, {client, stateDirectory: f.stateDirectory});
            const result = await archive.fetch("same-id");
            paths.add(result.path);
            assert.deepEqual(fs.readFileSync(result.path), body);
        }
        assert.equal(paths.size, variants.length);
        assert.equal(fs.existsSync(path.join(f.stateDirectory, "archive.sqlite")), false);
        assert.equal(f.manager.getEntries().length, 0);
    } finally { f.clean(); }
});
