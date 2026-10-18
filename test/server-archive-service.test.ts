import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {test} from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {SessionArchive, type ArchiveClientInterface} from "../src/server/SessionArchive.js";
import {ArchiveJournal} from "../src/server/ArchiveJournal.js";
import {SessionKind, sameArchivePublication, type Binding, type ListRequest, type Publication,
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
