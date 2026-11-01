import assert from "node:assert/strict";
import {archiveClient} from "./fixtures/CompatibleServer.js";
import {createHash} from "node:crypto";
import test from "node:test";
import {ArchiveClient, ArchiveClientError} from "../src/server/ArchiveClient.js";
import {
    ArchiveProtocolError, MAX_ARCHIVE_BYTES,
    decodeArchiveBinding, decodeArchiveListFilters, decodeArchiveListPage, decodeArchiveMetadata,
    decodeArchivePublication, decodeArchiveReceipt, decodeArchiveSequence,
    type Binding, type Publication, type Receipt, type SessionMetadata,
} from "../src/server/ArchiveProtocol.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";
import {MAX_RETRY_AFTER_MS, type ServerErrorCode} from "../src/server/ServerResponses.js";

const CONFIG = {url: "https://archive.example.test", apiKey: "private-archive-test-key"};
const BINDING: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "generation"};
const BODY = Buffer.from('opaque bytes: é\n');
const DIGEST = createHash("sha256").update(BODY).digest("hex");
const PUBLICATION: Publication = {
    binding: BINDING, session_id: "session / é", operation_id: "01234567-89ab-cdef-0123-456789abcdef",
    condition: {kind: "absent"}, byte_length: BODY.length, sha256: DIGEST,
    metadata: {kind: SessionKind.Main, root_session_id: "session / é", title: "Title",
        started_at: "2025-01-01T12:00:00.123+02:00", last_activity_at: "2025-01-01T11:00:00.000Z",
        counts: {user_messages: 1, assistant_messages: 2, tool_calls: 3}},
};
const SNAPSHOT: SessionMetadata = {session_id: PUBLICATION.session_id, revision: {binding: BINDING, seq: "9007199254740993"},
    byte_length: BODY.length, sha256: DIGEST};

function receipt(request: Publication = PUBLICATION): Receipt {
    return {request: decodeArchivePublication(request), revision: SNAPSHOT.revision};
}

function accepted(request: Publication = PUBLICATION): Response {
    return Response.json({status: "accepted", receipt: receipt(request)});
}

function client(response: Response, timeoutMs = 1000): ArchiveClient {
    return archiveClient(CONFIG, {fetch: async () => response, timeoutMs});
}

function stream(chunks: Uint8Array[], options: {status?: number; headers?: HeadersInit; stall?: boolean; cancelNeverSettles?: boolean} = {}) {
    let reads = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            reads++;
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else if (!options.stall) controller.close();
        },
        cancel() {
            cancellations++;
            if (options.cancelNeverSettles) return new Promise<void>(() => {});
        },
    }, {highWaterMark: 0});
    return {body, response: new Response(body, {status: options.status ?? 200,
        headers: {"Content-Type": "application/json", ...options.headers}}),
    reads: () => reads, cancellations: () => cancellations};
}

async function failure(pending: Promise<unknown>, pattern?: RegExp): Promise<ArchiveClientError> {
    try {
        await pending;
        assert.fail("Expected rejection");
    } catch (error) {
        assert.ok(error instanceof ArchiveClientError);
        assert.equal(error.message.includes(CONFIG.apiKey), false);
        if (pattern) assert.match(error.message, pattern);
        return error;
    }
}

function downloaded(snapshot: unknown = SNAPSHOT, body: Uint8Array = BODY, headers: HeadersInit = {}): Response {
    return new Response(Buffer.from(body), {headers: {"Content-Type": "application/octet-stream",
        "Content-Length": String(body.length), "X-Pi-Snapshot": Buffer.from(JSON.stringify(snapshot)).toString("base64url"), ...headers}});
}

function reversed(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reversed);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reversed(entry)]));
}

// Journal boundaries use the same normalized wire fingerprint as response verification.
test("session kinds remain stable and protocol sequences are canonical and lossless", () => {
    assert.deepEqual(SessionKind, {Main: "main", Subagent: "subagent", PolicyApprover: "policy_approver"});
    for (const value of ["0", "1", "9007199254740993", "9223372036854775807"]) assert.equal(decodeArchiveSequence(value), value);
    for (const value of [0, 1, "", "01", "+1", "-1", "1.0", "1\n", " 1", "9223372036854775808", "9".repeat(100)]) {
        assert.throws(() => decodeArchiveSequence(value), ArchiveProtocolError);
    }
});

test("journal decoders normalize owned fields, reject extensions, and throw only safe errors", () => {
    const normalized = decodeArchivePublication(PUBLICATION);
    assert.equal(normalized.metadata?.started_at, "2025-01-01T10:00:00.123Z");
    assert.deepEqual(decodeArchivePublication(reversed(PUBLICATION)), normalized);
    assert.deepEqual(decodeArchiveReceipt(reversed(receipt())), receipt());
    for (const value of [null, [], 1, CONFIG.apiKey, {...PUBLICATION, token: CONFIG.apiKey},
        {...PUBLICATION, binding: {...BINDING, secret: CONFIG.apiKey}},
        {...PUBLICATION, condition: {kind: "absent", revision: SNAPSHOT.revision}},
        {...PUBLICATION, metadata: {cwd: CONFIG.apiKey}}]) {
        assert.throws(() => decodeArchivePublication(value), (error: unknown) => {
            assert.ok(error instanceof ArchiveProtocolError);
            assert.equal(error.message, "Invalid archive protocol data.");
            return true;
        });
    }
});

test("publication validates bounded IDs, UUIDs, lengths and digests", () => {
    for (const session_id of ["", "x\n", "x\u0085", "é".repeat(257), "\ud800"]) {
        assert.throws(() => decodeArchivePublication({...PUBLICATION, session_id}), ArchiveProtocolError);
    }
    for (const operation_id of ["x", PUBLICATION.operation_id.toUpperCase(), `${PUBLICATION.operation_id}\n`]) {
        assert.throws(() => decodeArchivePublication({...PUBLICATION, operation_id}), ArchiveProtocolError);
    }
    for (const byte_length of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, MAX_ARCHIVE_BYTES + 1]) {
        assert.throws(() => decodeArchivePublication({...PUBLICATION, byte_length}), ArchiveProtocolError);
    }
    for (const sha256 of ["x", DIGEST.toUpperCase(), `${DIGEST}\n`]) {
        assert.throws(() => decodeArchivePublication({...PUBLICATION, sha256}), ArchiveProtocolError);
    }
    assert.equal(decodeArchivePublication({...PUBLICATION, byte_length: MAX_ARCHIVE_BYTES}).byte_length, MAX_ARCHIVE_BYTES);
    assert.equal(decodeArchiveBinding({...BINDING, server_id: "é".repeat(256)}).server_id.length, 256);
});

test("metadata validates relationships, calendar dates, ordering, safe counts and UTF-8 size limits", () => {
    const invalid = [
        {kind: "main"}, {kind: "main", root_session_id: "other"},
        {kind: "subagent"}, {kind: "policy_approver", root_session_id: PUBLICATION.session_id},
        {kind: "future"}, {title: " "}, {title: "title\u001b"}, {title: "é".repeat(129)},
        {summary: " "}, {summary: "é".repeat(513)},
        {started_at: "2025-02-29T00:00:00Z"}, {started_at: "2025-04-31T00:00:00Z"},
        {started_at: "2025-01-01"}, {started_at: 1}, {started_at: "2025-01-01T00:00:00.1234Z"},
        {started_at: "2025-01-01T00:00:60Z"}, {started_at: "2025-01-01T00:00:00Z\n"},
        {started_at: "1969-12-31T23:59:59.999Z"}, {started_at: "9999-12-31T23:59:59.999-01:00"},
        {started_at: "2025-01-02T00:00:00Z", last_activity_at: "2025-01-01T00:00:00Z"},
        {counts: {user_messages: -1, assistant_messages: 1, tool_calls: 0}},
        {counts: {user_messages: 0, assistant_messages: Number.MAX_SAFE_INTEGER + 1, tool_calls: 0}},
        {counts: {user_messages: 0, tool_calls: 0}},
        {summary: "\n".repeat(1023) + "x"}, // Escaped JSON, not string length, exceeds 2048 bytes.
    ];
    for (const metadata of invalid) assert.throws(() => decodeArchiveMetadata(metadata, PUBLICATION.session_id), ArchiveProtocolError);
    assert.deepEqual(decodeArchiveMetadata({}, "id"), {});
    assert.deepEqual(decodeArchiveMetadata({kind: "subagent", root_session_id: "root"}, "child"), {kind: "subagent", root_session_id: "root"});
    assert.equal(decodeArchiveMetadata({started_at: "2024-02-29T00:00:00Z"}, "id").started_at, "2024-02-29T00:00:00.000Z");
    assert.equal(decodeArchiveMetadata({started_at: "1970-01-01T00:00:00Z"}, "id").started_at, "1970-01-01T00:00:00.000Z");
    assert.equal(decodeArchiveMetadata({started_at: "9999-12-31T23:59:59.999Z"}, "id").started_at, "9999-12-31T23:59:59.999Z");
});

test("filters are strict and exact-base receipt sequences compare using BigInt", () => {
    assert.throws(() => decodeArchiveListFilters({started_from: "2025-02-01T00:00:00Z", started_to: "2025-01-01T00:00:00Z"}));
    assert.throws(() => decodeArchiveListFilters({search: "unsupported"}));
    const request: Publication = {...PUBLICATION, condition: {kind: "exact_base_revision", revision: {binding: BINDING, seq: "9007199254740992"}}};
    assert.equal(decodeArchiveReceipt(receipt(request)).revision.seq, "9007199254740993");
    assert.throws(() => decodeArchiveReceipt({...receipt(request), revision: request.condition.kind === "exact_base_revision" ? request.condition.revision : null}));
    assert.throws(() => decodeArchivePublication({...request, condition: {kind: "exact_base_revision", revision: {binding: BINDING, seq: "0"}}}));
    assert.throws(() => decodeArchivePublication({...request, condition: {kind: "exact_base_revision", revision: {binding: {...BINDING, server_id: "other"}, seq: "1"}}}));
});

test("binding makes one authenticated GET with redirects refused and ordinary TLS defaults", async () => {
    let calls = 0;
    const archive = archiveClient(CONFIG, {fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), `${CONFIG.url}/v1/binding`);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("x-apikey"), CONFIG.apiKey);
        assert.equal(init?.body, undefined);
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal("dispatcher" in init, false);
        assert.equal("agent" in init, false);
        return Response.json({binding: BINDING, head: "9223372036854775807", future: "ignored"});
    }});
    assert.deepEqual(await archive.binding(), {binding: BINDING, head: "9223372036854775807"});
    assert.equal(calls, 1);
});

test("list sends normalized control JSON and returns only lightweight metadata", async () => {
    const row = {...SNAPSHOT, metadata: PUBLICATION.metadata, uploaded_at: "2025-01-01T12:00:00Z", blob: CONFIG.apiKey};
    const archive = archiveClient(CONFIG, {fetch: async (input, init) => {
        assert.equal(String(input), `${CONFIG.url}/v1/list`);
        const request = JSON.parse(Buffer.from(await new Response(init?.body).arrayBuffer()).toString());
        assert.deepEqual(request, {binding: BINDING, filters: {kind: "main", activity_from: "2025-01-01T10:00:00.000Z"}, cursor: null, limit: 2});
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
        assert.equal(Number(new Headers(init?.headers).get("content-length")), Buffer.byteLength(JSON.stringify(request)));
        return Response.json({binding: BINDING, sessions: [row], next_cursor: "opaque-cursor", future: true});
    }});
    const page = await archive.list({binding: BINDING, filters: {kind: SessionKind.Main, activity_from: "2025-01-01T12:00:00+02:00"}, cursor: null, limit: 2});
    assert.equal(page.sessions[0].metadata?.kind, SessionKind.Main);
    assert.equal(page.sessions[0].uploaded_at, "2025-01-01T12:00:00.000Z");
    assert.equal("blob" in page.sessions[0], false);
    assert.equal(page.next_cursor, "opaque-cursor");
    assert.deepEqual(decodeArchiveListPage({binding: BINDING, sessions: [SNAPSHOT], next_cursor: null}).sessions[0].metadata, null);
});

test("list rejects page binding, row revision binding, duplicate rows, bad schema and excessive rows", async () => {
    for (const page of [
        {binding: {...BINDING, namespace_id: "other"}, sessions: [], next_cursor: null},
        {binding: BINDING, sessions: [{...SNAPSHOT, revision: {binding: {...BINDING, history_generation: "other"}, seq: "1"}}], next_cursor: null},
        {binding: BINDING, sessions: [SNAPSHOT, SNAPSHOT], next_cursor: null},
        {binding: BINDING, sessions: {}, next_cursor: null},
        {binding: BINDING, sessions: [{...SNAPSHOT, revision: {binding: BINDING, seq: 1}}], next_cursor: null},
        {binding: BINDING, sessions: [SNAPSHOT, {...SNAPSHOT, session_id: "second"}], next_cursor: null},
        {binding: BINDING, sessions: [], next_cursor: "x".repeat(4097)},
    ]) await failure(client(Response.json(page)).list({binding: BINDING, limit: 1}), /protocol/);
    let calls = 0;
    const archive = archiveClient(CONFIG, {fetch: async () => { calls++; return Response.json({}); }});
    for (const limit of [0, -1, 0.5, 4294967296]) await assert.rejects(archive.list({binding: BINDING, limit}));
    assert.equal(calls, 0);
});

test("publish encodes canonical unpadded base64url publication and accepts reordered receipt fields", async () => {
    const archive = archiveClient(CONFIG, {fetch: async (input, init) => {
        assert.equal(String(input), `${CONFIG.url}/v1/publish`);
        const headers = new Headers(init?.headers);
        const header = headers.get("x-pi-publication");
        assert.ok(header);
        assert.match(header, /^[A-Za-z0-9_-]+$/u);
        assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), decodeArchivePublication(PUBLICATION));
        assert.equal(headers.get("content-type"), "application/octet-stream");
        assert.equal(headers.get("content-length"), String(BODY.length));
        assert.deepEqual(Buffer.from(await new Response(init?.body).arrayBuffer()), BODY);
        return Response.json({status: "accepted", receipt: reversed({...receipt(), future: true}), future: true});
    }});
    assert.deepEqual(await archive.publish(PUBLICATION, BODY), receipt());
});

test("all publish failures remain uncertain, including local integrity errors and unknown outcomes", async () => {
    let calls = 0;
    const archive = archiveClient(CONFIG, {fetch: async () => { calls++; return accepted(); }});
    const error = await failure(archive.publish(PUBLICATION, Buffer.from("wrong")), /protocol/);
    assert.equal(error.publicationUncertain, true);
    assert.equal(error.kind, "protocol");
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, undefined);
    assert.equal(calls, 0);
    const unknown = await failure(client(Response.json({status: "unknown"})).publish(PUBLICATION, BODY));
    assert.equal(unknown.publicationUncertain, true);
    assert.equal(unknown.kind, "protocol");
    assert.equal(unknown.retryable, false);
});

test("publication/receipt responses must match the entire immutable fingerprint and revision binding", async () => {
    const mutations = [
        {...PUBLICATION, session_id: "different", metadata: undefined},
        {...PUBLICATION, operation_id: "11234567-89ab-cdef-0123-456789abcdef"},
        {...PUBLICATION, sha256: "0".repeat(64)}, {...PUBLICATION, byte_length: BODY.length + 1},
        {...PUBLICATION, metadata: {...PUBLICATION.metadata, title: "Changed"}},
        {...PUBLICATION, metadata: undefined}, {...PUBLICATION, metadata: {}},
        {...PUBLICATION, binding: {...BINDING, server_id: "other"}},
        {...PUBLICATION, condition: {kind: "exact_base_revision", revision: {binding: BINDING, seq: "1"}}},
    ];
    for (const changed of mutations) {
        const payload = {status: "accepted", receipt: {request: changed, revision: SNAPSHOT.revision}};
        await failure(client(Response.json(payload)).receipt(PUBLICATION), /protocol/);
        assert.equal((await failure(client(Response.json(payload)).publish(PUBLICATION, BODY), /protocol/)).publicationUncertain, true);
    }
    await failure(client(Response.json({status: "accepted", receipt: {...receipt(), revision: {binding: {...BINDING, namespace_id: "other"}, seq: "1"}}})).receipt(PUBLICATION), /protocol/);
});

test("receipt lookup posts the original normalized request without bytes and preserves unknown", async () => {
    const archive = archiveClient(CONFIG, {fetch: async (input, init) => {
        assert.equal(String(input), `${CONFIG.url}/v1/receipt`);
        assert.deepEqual(JSON.parse(await new Response(init?.body).text()), decodeArchivePublication(PUBLICATION));
        assert.equal(new Headers(init?.headers).has("x-pi-publication"), false);
        return Response.json({status: "unknown", future: true});
    }});
    assert.deepEqual(await archive.receipt(PUBLICATION), {status: "unknown"});
});

test("download verifies one current-version snapshot and returns exact bytes", async () => {
    const archive = archiveClient(CONFIG, {fetch: async (input, init) => {
        assert.equal(String(input), `${CONFIG.url}/v1/download`);
        assert.deepEqual(JSON.parse(await new Response(init?.body).text()), {binding: BINDING, session_id: PUBLICATION.session_id});
        assert.equal(new Headers(init?.headers).get("accept"), "application/octet-stream");
        return downloaded({...SNAPSHOT, future: true});
    }});
    assert.deepEqual(await archive.download(BINDING, PUBLICATION.session_id), {snapshot: SNAPSHOT, body: BODY});
});

test("download rejects bad header encodings, schema, identity, length and digest", async () => {
    const responses = [
        downloaded(SNAPSHOT, BODY, {"X-Pi-Snapshot": "e30="}),
        downloaded(SNAPSHOT, BODY, {"X-Pi-Snapshot": "+/"}),
        downloaded(SNAPSHOT, BODY, {"X-Pi-Snapshot": "Zh"}), // Noncanonical padding bits.
        downloaded(SNAPSHOT, BODY, {"X-Pi-Snapshot": "x".repeat(65537)}),
        downloaded(SNAPSHOT, BODY, {"X-Pi-Snapshot": Buffer.from("not JSON").toString("base64url")}),
        downloaded(SNAPSHOT, BODY, {"X-Pi-Snapshot": Buffer.from([0xff]).toString("base64url")}),
        downloaded({}), downloaded({...SNAPSHOT, session_id: "different"}),
        downloaded({...SNAPSHOT, revision: {binding: {...BINDING, history_generation: "other"}, seq: "1"}}),
        downloaded({...SNAPSHOT, byte_length: BODY.length + 1}),
        downloaded({...SNAPSHOT, sha256: "0".repeat(64)}),
        downloaded(SNAPSHOT, BODY, {"Content-Length": String(BODY.length + 1)}),
        downloaded(SNAPSHOT, BODY, {"Content-Length": "01"}),
        downloaded(SNAPSHOT, BODY, {"Content-Type": "application/json"}),
        downloaded(SNAPSHOT, BODY, {"Content-Encoding": "gzip"}),
    ];
    const noLength = downloaded();
    noLength.headers.delete("content-length");
    responses.push(noLength);
    const noSnapshot = downloaded();
    noSnapshot.headers.delete("x-pi-snapshot");
    responses.push(noSnapshot);
    for (const response of responses) await failure(client(response).download(BINDING, PUBLICATION.session_id));
});

test("streaming accepts arbitrary byte splits, ignores future response fields and releases reader locks", async () => {
    const bytes = Buffer.from(JSON.stringify({binding: BINDING, head: "1", extra: "é"}));
    const source = stream(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    assert.deepEqual(await client(source.response).binding(), {binding: BINDING, head: "1"});
    assert.equal(source.body.locked, false);
    assert.equal(source.reads(), bytes.length + 1);
});

test("malformed JSON, fatal UTF-8, invalid schema, headers and transport failures are safe", async () => {
    for (const body of [CONFIG.apiKey, "", '{"binding":', "null", "[]", "{}", Buffer.from([0xff])]) {
        const error = await failure(client(new Response(body, {headers: {"Content-Type": "application/json"}})).binding());
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
    }
    await failure(client(Response.json({binding: BINDING, head: 1})).binding(), /protocol/);
    await failure(client(Response.json({binding: BINDING, head: "1"}, {headers: {"Content-Encoding": "gzip"}})).binding(), /protocol/);
    await failure(client(new Response(null)).binding(), /protocol/);
    for (const cause of [new TypeError(CONFIG.apiKey), CONFIG.apiKey]) {
        const error = await failure(archiveClient(CONFIG, {fetch: async () => { throw cause; }}).binding(), /connection or response failed/);
        assert.equal(error.kind, "transport");
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.publicationUncertain, false);
    }
});

test("body read failures cancel and release the reader without exposing the underlying error", async () => {
    const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error(CONFIG.apiKey)); },
    });
    const error = await failure(client(new Response(body, {headers: {"Content-Type": "application/json"}})).binding(), /connection or response failed/);
    assert.equal(error.kind, "transport");
    assert.equal(error.retryable, true);
    assert.equal(body.locked, false);
});

test("control and list responses accept their exact byte caps and reject inconsistent framing", async () => {
    for (const [limit, value, call] of [
        [65536, {binding: BINDING, head: "0"}, (archive: ArchiveClient) => archive.binding()],
        [1024 * 1024, {binding: BINDING, sessions: [], next_cursor: null}, (archive: ArchiveClient) => archive.list({binding: BINDING, limit: 1})],
    ] as const) {
        const bytes = Buffer.from(JSON.stringify(value));
        const padding = Buffer.alloc(limit - bytes.length, 32);
        const source = stream([bytes, padding], {headers: {"Content-Length": String(limit)}});
        await call(client(source.response));
        assert.equal(source.body.locked, false);
    }
    for (const declared of ["0", "999", "1.0", "+1", "1, 1", "9007199254740992"]) {
        await failure(client(Response.json({binding: BINDING, head: "0"}, {headers: {"Content-Length": declared}})).binding());
    }
});

test("all validated server codes expose retry permission independently of publication uncertainty", async () => {
    const cases: [ServerErrorCode, number, boolean][] = [
        ["invalid_request", 400, false], ["integrity", 400, false], ["unauthorized", 401, false],
        ["rate_limited", 429, true], ["method_not_allowed", 405, false], ["unsupported_media_type", 415, false],
        ["payload_too_large", 413, false], ["binding_mismatch", 409, false], ["cursor_mismatch", 409, false],
        ["stale_base", 409, false], ["already_exists", 409, false], ["operation_id_mismatch", 409, false],
        ["capacity", 507, true], ["overloaded", 503, true], ["corruption", 500, false], ["not_found", 404, false],
        ["uncertain_commit", 503, true], ["internal", 500, false],
    ];
    for (const [code, status, retryable] of cases) {
        for (const publish of [false, true]) {
            const archive = client(Response.json({error: {code, retryable, publication_outcome: "unconfirmed"}},
                {status, headers: {"Retry-After": "7"}}));
            const error = await failure(publish ? archive.publish(PUBLICATION, BODY) : archive.binding());
            assert.equal(error.code, code);
            assert.equal(error.kind, "server");
            assert.equal(error.retryable, retryable);
            assert.equal(error.retryAfterMs, retryable ? 7000 : undefined);
            assert.equal(error.publicationUncertain, publish);
        }
    }
});

test("retry hints are validated, capped, and survive the publication error wrapper", async () => {
    for (const [header, expected] of [
        ["0", 0], ["000001", 1000], ["86399", 86_399_000], ["86400", MAX_RETRY_AFTER_MS],
        ["86401", MAX_RETRY_AFTER_MS], ["999999999", MAX_RETRY_AFTER_MS],
        ["1000000000", undefined], ["-1", undefined], ["1.5", undefined], ["1e2", undefined],
        ["Wed, 21 Oct 2015 07:28:00 GMT", undefined], ["1, 2", undefined],
        [CONFIG.apiKey, undefined], [null, undefined],
    ] as const) {
        const headers = new Headers();
        if (header !== null) headers.set("Retry-After", header);
        const error = await failure(client(Response.json({error: {code: "overloaded", retryable: true,
            publication_outcome: "unconfirmed"}}, {status: 503, headers})).publish(PUBLICATION, BODY));
        assert.equal(error.retryAfterMs, expected, String(header));
        assert.equal(error.retryable, true);
        assert.equal(error.kind, "server");
        assert.equal(error.publicationUncertain, true);
    }
});

test("unknown or malformed HTTP errors never grant retries based on status, headers, or text", async () => {
    const valid = {code: "overloaded", retryable: true, publication_outcome: "unconfirmed"};
    for (const [status, body] of [
        [503, {error: {...valid, code: "future_error"}}], [503, {error: {...valid, code: "toString"}}],
        [503, {error: {...valid, retryable: false}}], [429, {error: valid}],
        [503, {error: {...valid, publication_outcome: "confirmed"}}],
        [502, {message: `retryable overloaded ${CONFIG.apiKey}`}], [500, {}],
    ] as const) {
        const error = await failure(client(Response.json(body, {status, headers: {"Retry-After": "7"}})).binding());
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
        assert.equal(error.code, undefined);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.publicationUncertain, false);
    }
    for (const body of ["<html>proxy overloaded</html>", CONFIG.apiKey, Buffer.from([0xff])]) {
        const error = await failure(client(new Response(body, {status: 503, headers: {"Retry-After": "7"}})).publish(PUBLICATION, BODY));
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.publicationUncertain, true);
    }
});

test("all local request validation is classified before authorization or fetch", async () => {
    let authorized = 0;
    let fetched = 0;
    const archive = archiveClient(CONFIG, {beforeRequest: async () => { authorized++; },
        fetch: async () => { fetched++; throw new Error("Must not fetch invalid local requests"); }});
    for (const [call, uncertain] of [
        [() => archive.list({binding: BINDING, limit: 0}), false],
        [() => archive.receipt({...PUBLICATION, byte_length: -1}), false],
        [() => archive.download(BINDING, ""), false],
        [() => archive.download({...BINDING, namespace_id: ""}, PUBLICATION.session_id), false],
        [() => archive.publish(PUBLICATION, Buffer.from("wrong bytes")), true],
    ] as const) {
        const error = await failure(call());
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
        assert.equal(error.code, undefined);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.publicationUncertain, uncertain);
    }
    assert.equal(authorized, 0);
    assert.equal(fetched, 0);
});

test("fetch and stream error provenance cannot forge validated server or protocol classification", async () => {
    for (const cause of [new Error(CONFIG.apiKey), new ArchiveProtocolError(),
        new ArchiveClientError(CONFIG.apiKey, "overloaded", false, {kind: "server", retryAfterMs: 7000})]) {
        for (const readFailure of [false, true]) {
            for (const publish of [false, true]) {
                const archive = archiveClient(CONFIG, {fetch: () => {
                    if (!readFailure) throw cause;
                    const body = new ReadableStream<Uint8Array>({pull(controller) { controller.error(cause); }});
                    return Promise.resolve(new Response(body, {headers: {"Content-Type": "application/json"}}));
                }});
                const error = await failure(publish ? archive.publish(PUBLICATION, BODY) : archive.binding());
                assert.equal(error.kind, "transport");
                assert.equal(error.retryable, true);
                assert.equal(error.code, undefined);
                assert.equal(error.retryAfterMs, undefined);
                assert.equal(error.publicationUncertain, publish);
                assert.equal(error.message, "Archive server connection or response failed.");
            }
        }
    }
});

test("server error classification requires the protocol JSON media type", async () => {
    for (const contentType of [undefined, "text/html", "application/octet-stream"]) {
        const body = JSON.stringify({error: {code: "overloaded", retryable: true, publication_outcome: "unconfirmed"}});
        const headers = new Headers({"Retry-After": "7"});
        if (contentType) headers.set("Content-Type", contentType);
        const error = await failure(client(new Response(Buffer.from(body), {status: 503, headers})).publish(PUBLICATION, BODY));
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
        assert.equal(error.code, undefined);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.publicationUncertain, true);
    }
});

test("configuration and protocol failures are terminal even when HTTP says retry later", async () => {
    for (const create of [
        () => archiveClient({...CONFIG, url: "https://user:password@archive.example.test"}),
        () => archiveClient(CONFIG, {timeoutMs: 0}),
    ]) assert.throws(create, (error: unknown) => {
        assert.ok(error instanceof ArchiveClientError);
        assert.equal(error.kind, "configuration");
        assert.equal(error.retryable, false);
        assert.equal(error.publicationUncertain, false);
        return true;
    });
    for (const response of [
        new Response(CONFIG.apiKey, {status: 307, headers: {"Retry-After": "7"}}),
        Response.json({binding: BINDING, head: "1"}, {headers: {"Content-Length": "65537", "Retry-After": "7"}}),
        Response.json({binding: BINDING, head: "1"}, {headers: {"Content-Encoding": "gzip", "Retry-After": "7"}}),
        downloaded({...SNAPSHOT, sha256: "0".repeat(64)}, BODY, {"Retry-After": "7"}),
    ]) {
        const error = await failure(client(response).download(BINDING, PUBLICATION.session_id));
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
        assert.equal(error.retryAfterMs, undefined);
    }
});

test("publish preserves transport, timeout, cancellation and authorization classification", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const transport = await failure(archiveClient(CONFIG, {fetch: async () => { throw new Error(CONFIG.apiKey); }})
        .publish(PUBLICATION, BODY));
    assert.equal(transport.kind, "transport");
    assert.equal(transport.retryable, true);
    assert.equal(transport.publicationUncertain, true);
    const archive = archiveClient(CONFIG, {timeoutMs: 100, fetch: () => new Promise<Response>(() => {})});
    const caller = new AbortController();
    const pendingTimeout = archive.publish(PUBLICATION, BODY, caller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    // A later caller cancellation must not turn an already elapsed deadline into a cancellation.
    caller.abort(CONFIG.apiKey);
    const timeout = await failure(pendingTimeout);
    assert.equal(timeout.kind, "timeout");
    assert.equal(timeout.retryable, true);
    assert.equal(timeout.publicationUncertain, true);
    const pendingCancelled = archive.publish(PUBLICATION, BODY, AbortSignal.abort(CONFIG.apiKey));
    const cancelled = await failure(pendingCancelled);
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.retryable, false);
    assert.equal(cancelled.publicationUncertain, true);
    const denied = await failure(archiveClient(CONFIG, {beforeRequest: async () => { throw new Error(CONFIG.apiKey); }})
        .publish(PUBLICATION, BODY));
    assert.equal(denied.kind, "authorization");
    assert.equal(denied.retryable, false);
    assert.equal(denied.publicationUncertain, true);
});

test("error construction keeps retry classification independent of arbitrary presentation strings", () => {
    assert.equal(new ArchiveClientError("retry after 7 seconds: overloaded").retryable, false);
    assert.equal(new ArchiveClientError("not retryable", "overloaded").retryable, true);
    assert.equal(new ArchiveClientError("retryable", "unauthorized").retryable, false);
    for (const code of ["toString", "future_error", CONFIG.apiKey]) {
        assert.equal(new ArchiveClientError("retryable", code as ServerErrorCode).retryable, false);
    }
    for (const delay of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const error = new ArchiveClientError("safe", "overloaded", false, {kind: "server", retryAfterMs: delay});
        assert.equal(error.retryAfterMs, undefined);
    }
    assert.equal(new ArchiveClientError("safe", "overloaded", false,
        {kind: "server", retryAfterMs: MAX_RETRY_AFTER_MS + 1}).retryAfterMs, MAX_RETRY_AFTER_MS);
    assert.equal(new ArchiveClientError("safe", "unauthorized", false,
        {kind: "server", retryAfterMs: 1000}).retryAfterMs, undefined);
});

test("native server errors validate status, code and retry semantics without reflecting server strings", async () => {
    for (const [code, status, retryable] of [["uncertain_commit", 503, true], ["binding_mismatch", 409, false], ["unauthorized", 401, false]] as const) {
        const response = Response.json({error: {code, retryable, publication_outcome: "unconfirmed", message: CONFIG.apiKey}},
            {status, headers: {"Retry-After": CONFIG.apiKey}});
        const error = await failure(client(response).publish(PUBLICATION, BODY));
        assert.equal(error.code, code);
        assert.equal(error.kind, "server");
        assert.equal(error.retryable, retryable);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.publicationUncertain, true);
    }
    for (const error of [
        {code: CONFIG.apiKey, retryable: true, publication_outcome: "unconfirmed"},
        {code: "uncertain_commit", retryable: false, publication_outcome: "unconfirmed"},
        {code: "unauthorized", retryable: false, publication_outcome: "unconfirmed"},
    ]) assert.equal((await failure(client(Response.json({error}, {status: 503})).binding())).code, undefined);
});

test("redirects are refused before reading and cancel bodies without following Location", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
        const source = stream([Buffer.from(CONFIG.apiKey)], {status, headers: {Location: `https://other.test/${CONFIG.apiKey}`}, stall: true});
        await failure(client(source.response).binding(), /redirect refused/);
        assert.equal(source.reads(), 0);
        assert.equal(source.cancellations(), 1);
        assert.equal(source.body.locked, false);
    }
});

test("response caps apply to streamed control, receipts, lists, and downloads without trusting lengths", async () => {
    for (const [limit, call] of [
        [65536, (archive: ArchiveClient) => archive.binding()],
        [65536, (archive: ArchiveClient) => archive.receipt(PUBLICATION)],
        [1024 * 1024, (archive: ArchiveClient) => archive.list({binding: BINDING, limit: 10})],
        [MAX_ARCHIVE_BYTES, (archive: ArchiveClient) => archive.download(BINDING, PUBLICATION.session_id)],
    ] as const) {
        const source = stream([new Uint8Array(limit), Uint8Array.of(1), Uint8Array.of(2)], {stall: true});
        await failure(call(client(source.response)), /size limit/);
        assert.equal(source.reads(), 2);
        assert.equal(source.cancellations(), 1);
        assert.equal(source.body.locked, false);
    }
    const oversizedError = stream([new Uint8Array(65537)], {status: 500, stall: true});
    await failure(client(oversizedError.response).list({binding: BINDING, limit: 1}), /size limit/);
    const declared = stream([], {headers: {"Content-Length": "65537"}, stall: true});
    await failure(client(declared.response).binding(), /size limit/);
    assert.equal(declared.reads(), 0);
    assert.equal(declared.cancellations(), 1);
});

test("caller abort propagates before fetch, during fetch and while reading stalled bodies", async () => {
    let calls = 0;
    let transportSignal: AbortSignal | null | undefined;
    const archive = archiveClient(CONFIG, {fetch: async (_input, init) => {
        calls++;
        transportSignal = init?.signal;
        return new Promise<Response>(() => {}); // Deliberately does not cooperate with abort.
    }});
    const preAborted = await failure(archive.binding(AbortSignal.abort(CONFIG.apiKey)), /cancelled/);
    assert.equal(preAborted.kind, "cancelled");
    assert.equal(preAborted.retryable, false);
    assert.equal(preAborted.publicationUncertain, false);
    assert.equal(calls, 0);
    const caller = new AbortController();
    const pending = archive.binding(caller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    caller.abort(CONFIG.apiKey);
    const cancelled = await failure(pending, /cancelled/);
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.retryable, false);
    assert.equal(cancelled.retryAfterMs, undefined);
    assert.equal(transportSignal?.aborted, true);
    const source = stream([], {stall: true});
    const readerAbort = new AbortController();
    const reading = client(source.response).binding(readerAbort.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    readerAbort.abort(CONFIG.apiKey);
    const readCancelled = await failure(reading, /cancelled/);
    assert.equal(readCancelled.kind, "cancelled");
    assert.equal(readCancelled.retryable, false);
    assert.equal(source.cancellations(), 1);
    assert.equal(source.body.locked, false);
});

test("one finite deadline covers fetch and body; cancellation cannot prolong it", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const pendingFetch = archiveClient(CONFIG, {timeoutMs: 100, fetch: async () => new Promise<Response>(() => {})}).binding();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    const fetchTimeout = await failure(pendingFetch, /timed out/);
    assert.equal(fetchTimeout.kind, "timeout");
    assert.equal(fetchTimeout.retryable, true);
    assert.equal(fetchTimeout.retryAfterMs, undefined);
    assert.equal(fetchTimeout.publicationUncertain, false);
    const source = stream([], {stall: true, cancelNeverSettles: true});
    const archive = archiveClient(CONFIG, {timeoutMs: 100, fetch: () => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(source.response), 80);
    })});
    const pending = archive.binding();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(80);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(source.body.locked, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(20);
    const readTimeout = await failure(pending, /timed out/);
    assert.equal(readTimeout.kind, "timeout");
    assert.equal(readTimeout.retryable, true);
    assert.equal(source.cancellations(), 1);
    assert.equal(source.body.locked, false);
});

test("late fetch responses are cancelled after the request deadline", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const source = stream([], {stall: true});
    let resolveFetch: ((response: Response) => void) | undefined;
    const pending = archiveClient(CONFIG, {timeoutMs: 100, fetch: () => new Promise<Response>((resolve) => { resolveFetch = resolve; })}).binding();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    await failure(pending, /timed out/);
    assert.ok(resolveFetch);
    resolveFetch(source.response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(source.cancellations(), 1);
    assert.equal(source.body.locked, false);
});

test("policy approval precedes fetch and HTTP timer, and completed operations clear timers", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let approve: (() => void) | undefined;
    let calls = 0;
    let transportSignal: AbortSignal | null | undefined;
    const archive = archiveClient(CONFIG, {timeoutMs: 100, beforeRequest: async (method, path, signal) => {
        assert.equal(method, "GET");
        assert.equal(path, "/v1/binding");
        assert.equal(signal, undefined);
        await new Promise<void>((resolve) => { approve = resolve; });
    }, fetch: async (_input, init) => {
        calls++;
        transportSignal = init?.signal;
        return Response.json({binding: BINDING, head: "0"});
    }});
    const pending = archive.binding();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10000);
    assert.equal(calls, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(approve);
    approve();
    assert.deepEqual(await pending, {binding: BINDING, head: "0"});
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10000);
    assert.equal(transportSignal?.aborted, false);
    assert.equal(calls, 1);
});

test("policy denial and cancellation perform no network request and expose no policy reason", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return accepted(); };
    const denied = await failure(archiveClient(CONFIG, {fetch: fetcher, beforeRequest: async () => { throw new Error(CONFIG.apiKey); }}).binding(), /authorization failed/);
    assert.equal(denied.kind, "authorization");
    assert.equal(denied.retryable, false);
    const caller = new AbortController();
    const pending = archiveClient(CONFIG, {fetch: fetcher, beforeRequest: () => new Promise<void>(() => {})}).binding(caller.signal);
    caller.abort(CONFIG.apiKey);
    const cancelled = await failure(pending, /cancelled/);
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.retryable, false);
    assert.equal(calls, 0);
});
