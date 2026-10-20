import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {ArchiveClient, ArchiveClientError} from "../src/server/ArchiveClient.js";
import {
    ArchiveProtocolError, MAX_ARCHIVE_BYTES, decodeArchiveBindingResponse, decodeArchiveListPage,
    decodeArchiveListRequest, decodeArchivePreservation, decodeArchivePreservationReceipt,
    decodeArchivePreservationReceiptOutcome, decodeArchiveSessionMetadata, sameArchivePreservation,
    type Binding, type Preservation, type PreservationReceipt, type Publication,
} from "../src/server/ArchiveProtocol.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";

const CONFIG = {url: "https://archive.example.test", apiKey: "preservation-secret-key"};
const BINDING: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "generation"};
const BODY = Buffer.from("exact opaque bytes é\n");
const DIGEST = createHash("sha256").update(BODY).digest("hex");
const UPLOADED: Preservation = {
    mode: "uploaded", binding: BINDING, session_id: "native / é", operation_id: "01234567-89ab-cdef-0123-456789abcdef",
    byte_length: BODY.length, sha256: DIGEST,
    metadata: {kind: SessionKind.Main, root_session_id: "native / é", title: "Retained"},
};
const CURRENT: Preservation = {
    mode: "current", binding: BINDING, session_id: UPLOADED.session_id, operation_id: UPLOADED.operation_id,
    revision: {binding: BINDING, seq: "9007199254740993"},
};
const VARIANT = {
    session_id: UPLOADED.session_id, variant_id: "opaque / variant é", revision: {binding: BINDING, seq: "2"},
    byte_length: BODY.length, sha256: DIGEST, metadata: UPLOADED.metadata ?? null,
    uploaded_at: "2025-02-01T12:00:00.000Z",
};

function receipt(request: Preservation = UPLOADED): PreservationReceipt {
    return {
        request, variant: {...VARIANT, metadata: request.mode === "uploaded" ? request.metadata ?? null : VARIANT.metadata},
        ...(request.mode === "current" ? {source_revision: request.revision, source_uploaded_at: null} : {}),
    };
}

function client(value: unknown): ArchiveClient {
    return new ArchiveClient(CONFIG, {fetch: async () => Response.json(value)});
}

function accepted(request: Preservation = UPLOADED): unknown {
    return {status: "accepted", receipt: receipt(request)};
}

function downloaded(snapshot: unknown): Response {
    return new Response(BODY, {headers: {"Content-Type": "application/octet-stream", "Content-Length": String(BODY.length),
        "X-Pi-Snapshot": Buffer.from(JSON.stringify(snapshot)).toString("base64url")}});
}

async function failure(pending: Promise<unknown>, uncertain = false): Promise<ArchiveClientError> {
    try {
        await pending;
        assert.fail("Expected rejection");
    } catch (error) {
        assert.ok(error instanceof ArchiveClientError);
        assert.equal(error.message.includes(CONFIG.apiKey), false);
        assert.equal(error.publicationUncertain, uncertain);
        return error;
    }
}

function futureFields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(futureFields);
    if (typeof value !== "object" || value === null) return value;
    return {...Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, futureFields(item)])), future: CONFIG.apiKey};
}

test("publication and uploaded preservation reject wrong body type or length before copying or authorizing", async (t) => {
    const invalidBodies: unknown[] = [new Uint8Array(BODY.length - 1), new Uint8Array(BODY.length + 1),
        {byteLength: BODY.length, length: BODY.length}, undefined];
    const originalFrom = Buffer.from;
    let bodyCopies = 0;
    const copied = t.mock.method(Buffer, "from", (...args: unknown[]) => {
        if (invalidBodies.includes(args[0])) bodyCopies++;
        return Reflect.apply(originalFrom, Buffer, args) as ReturnType<typeof Buffer.from>;
    });
    const authorize = t.mock.fn(async () => {});
    const fetcher = t.mock.fn(async () => { throw new Error("Invalid body must never reach transport"); });
    const archive = new ArchiveClient(CONFIG, {fetch: fetcher, beforeRequest: authorize});
    const publication: Publication = {binding: BINDING, session_id: UPLOADED.session_id, operation_id: UPLOADED.operation_id,
        condition: {kind: "absent"}, byte_length: BODY.length, sha256: DIGEST, metadata: UPLOADED.metadata};
    try {
        for (const invalid of invalidBodies) {
            for (const pending of [archive.publish(publication, invalid as Uint8Array), archive.preserve(UPLOADED, invalid as Uint8Array)]) {
                const error = await failure(pending, true);
                assert.equal(error.kind, "protocol");
                assert.equal(error.retryable, false);
                assert.equal(error.code, undefined);
            }
        }
        assert.equal(bodyCopies, 0, "declared byte length and typed-array checks must precede Buffer.from(body)");
        assert.equal(authorize.mock.callCount(), 0);
        assert.equal(fetcher.mock.callCount(), 0);
    } finally { copied.mock.restore(); }
});

test("publication and uploaded preservation freeze valid caller bytes before authorization awaits", async (t) => {
    const publication: Publication = {binding: BINDING, session_id: UPLOADED.session_id, operation_id: UPLOADED.operation_id,
        condition: {kind: "absent"}, byte_length: BODY.length, sha256: DIGEST, metadata: UPLOADED.metadata};
    for (const preservation of [false, true]) {
        const body = new Uint8Array(BODY);
        const authorize = t.mock.fn(async () => { body.fill(0); await Promise.resolve(); });
        const archive = new ArchiveClient(CONFIG, {beforeRequest: authorize, fetch: async (_url, init) => {
            assert.deepEqual(Buffer.from(init!.body as Uint8Array), BODY);
            return Response.json(preservation ? accepted() : {status: "accepted", receipt: {request: publication, revision: {binding: BINDING, seq: "1"}}});
        }});
        if (preservation) await archive.preserve(UPLOADED, body);
        else await archive.publish(publication, body);
        assert.equal(authorize.mock.callCount(), 1);
        assert.ok(body.every((byte) => byte === 0));
    }
});

test("preservation capabilities preserve legacy shape and retain future capability names", async () => {
    assert.deepEqual(decodeArchiveBindingResponse({binding: BINDING, head: "0"}), {binding: BINDING, head: "0"});
    const capabilities = ["preserved_variants_v1", "future_v2"];
    assert.deepEqual((await client({binding: BINDING, head: "0", capabilities, future: true}).binding()).capabilities, capabilities);
    for (const value of [null, {}, "preserved_variants_v1", [null], [1], [""], ["x\n"], ["x".repeat(513)]]) {
        await failure(client({binding: BINDING, head: "0", capabilities: value}).binding());
    }
});

test("owned preservation decoders normalize fingerprints and reject mode-specific or nested extensions", () => {
    assert.deepEqual(decodeArchivePreservation(UPLOADED), UPLOADED);
    assert.deepEqual(decodeArchivePreservation(CURRENT), CURRENT);
    assert.ok(sameArchivePreservation(UPLOADED, decodeArchivePreservation(futureFields(UPLOADED), false)));
    assert.ok(sameArchivePreservation(CURRENT, decodeArchivePreservation(futureFields(CURRENT), false)));
    for (const value of [
        null, [], {}, {...UPLOADED, mode: "future"}, {...UPLOADED, revision: CURRENT.revision},
        {...UPLOADED, condition: {kind: "absent"}}, {...UPLOADED, future: true},
        {...UPLOADED, binding: {...BINDING, future: true}}, {...UPLOADED, metadata: {future: true}},
        {...CURRENT, metadata: {}}, {...CURRENT, byte_length: BODY.length}, {...CURRENT, sha256: DIGEST},
        {...CURRENT, revision: {...CURRENT.revision, future: true}},
        {...CURRENT, revision: {binding: {...BINDING, history_generation: "other"}, seq: "1"}},
        {...CURRENT, revision: {binding: BINDING, seq: "0"}},
    ]) assert.throws(() => decodeArchivePreservation(value), ArchiveProtocolError);
    for (const base of [UPLOADED, CURRENT]) {
        for (const session_id of ["", "x\n", "é".repeat(257), "\ud800"]) {
            assert.throws(() => decodeArchivePreservation({...base, session_id}), ArchiveProtocolError);
        }
        for (const operation_id of ["", base.operation_id.toUpperCase(), `${base.operation_id}\n`]) {
            assert.throws(() => decodeArchivePreservation({...base, operation_id}), ArchiveProtocolError);
        }
    }
    for (const byte_length of [-1, 0.1, MAX_ARCHIVE_BYTES + 1, NaN]) {
        assert.throws(() => decodeArchivePreservation({...UPLOADED, byte_length}), ArchiveProtocolError);
    }
    assert.throws(() => decodeArchivePreservation({...UPLOADED, sha256: DIGEST.toUpperCase()}), ArchiveProtocolError);
});

test("preservation null metadata normalizes to omission but never equals empty metadata", () => {
    const {metadata: _metadata, ...absent} = UPLOADED;
    assert.deepEqual(decodeArchivePreservation({...absent, metadata: null}), absent);
    assert.ok(sameArchivePreservation(absent, decodeArchivePreservation({...absent, metadata: null})));
    assert.equal(sameArchivePreservation(absent, {...absent, metadata: {}}), false);
    assert.deepEqual(decodeArchivePreservationReceipt(receipt(absent)).variant.metadata, null);
    assert.deepEqual(decodeArchivePreservationReceipt(receipt({...absent, metadata: {}})).variant.metadata, {});
    assert.throws(() => decodeArchivePreservationReceipt({...receipt(absent), variant: {...VARIANT, metadata: {}}}), ArchiveProtocolError);
    assert.throws(() => decodeArchivePreservationReceipt({...receipt({...absent, metadata: {}}),
        variant: {...VARIANT, metadata: null}}), ArchiveProtocolError);
});

test("preservation receipts permit old dedup sequences and retain operation-specific source provenance", () => {
    for (const request of [UPLOADED, CURRENT]) {
        const original = receipt(request);
        assert.deepEqual(decodeArchivePreservationReceipt(original), original);
        assert.deepEqual(decodeArchivePreservationReceipt(futureFields(original), false), original);
        assert.throws(() => decodeArchivePreservationReceipt(futureFields(original)), ArchiveProtocolError);
        assert.deepEqual(decodeArchivePreservationReceiptOutcome(futureFields({status: "accepted", receipt: original})),
            {status: "accepted", receipt: original});
    }
    const copied = {...receipt(CURRENT), source_uploaded_at: "2025-01-01T12:00:00+02:00"};
    const normalized = decodeArchivePreservationReceipt(copied);
    assert.equal(normalized.source_uploaded_at, "2025-01-01T10:00:00.000Z");
    assert.equal(normalized.variant.uploaded_at, VARIANT.uploaded_at);
    assert.equal(normalized.variant.revision.seq, "2");
    assert.deepEqual(decodeArchivePreservationReceiptOutcome({status: "unknown", future: true}), {status: "unknown"});
});

test("preservation receipts reject malformed selectors, binding, metadata and provenance", () => {
    for (const request of [UPLOADED, CURRENT]) {
        for (const variant of [
            {...VARIANT, variant_id: undefined}, {...VARIANT, variant_id: null}, {...VARIANT, variant_id: ""},
            {...VARIANT, session_id: "other", metadata: null},
            {...VARIANT, revision: {binding: {...BINDING, namespace_id: "other"}, seq: "2"}},
            {...VARIANT, metadata: undefined}, {...VARIANT, uploaded_at: undefined}, {...VARIANT, uploaded_at: null},
            {...VARIANT, metadata: {kind: "main", root_session_id: "other"}},
        ]) assert.throws(() => decodeArchivePreservationReceipt({...receipt(request), variant}), ArchiveProtocolError);
    }
    for (const variant of [{...VARIANT, byte_length: BODY.length + 1}, {...VARIANT, sha256: "0".repeat(64)},
        {...VARIANT, metadata: null}, {...VARIANT, metadata: {...VARIANT.metadata, title: "other"}}]) {
        assert.throws(() => decodeArchivePreservationReceipt({...receipt(), variant}), ArchiveProtocolError);
    }
    for (const source of [undefined, null, {binding: BINDING, seq: "3"},
        {binding: {...BINDING, history_generation: "old"}, seq: CURRENT.revision.seq}]) {
        assert.throws(() => decodeArchivePreservationReceipt({...receipt(CURRENT), source_revision: source}), ArchiveProtocolError);
    }
    for (const source_uploaded_at of [undefined, 0, "not a timestamp"]) {
        assert.throws(() => decodeArchivePreservationReceipt({...receipt(CURRENT), source_uploaded_at}), ArchiveProtocolError);
    }
    for (const extra of [{source_revision: CURRENT.revision}, {source_revision: null}, {source_uploaded_at: null}]) {
        assert.throws(() => decodeArchivePreservationReceipt({...receipt(), ...extra}), ArchiveProtocolError);
    }
});

test("uploaded preservation sends exact bytes with a canonical control header", async () => {
    const archive = new ArchiveClient(CONFIG, {fetch: async (url, init) => {
        assert.equal(String(url), `${CONFIG.url}/v1/preserve`);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "manual");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-apikey"), CONFIG.apiKey);
        assert.equal(headers.get("content-type"), "application/octet-stream");
        assert.equal(headers.get("content-length"), String(BODY.length));
        const header = headers.get("x-pi-preservation");
        assert.ok(header);
        assert.match(header, /^[A-Za-z0-9_-]+$/u);
        assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), UPLOADED);
        assert.deepEqual(Buffer.from(await new Response(init?.body).arrayBuffer()), BODY);
        return Response.json(futureFields(accepted()));
    }});
    assert.deepEqual(await archive.preserve(UPLOADED, BODY), receipt());
});

test("current preservation and receipt recovery send only their original normalized control request", async () => {
    for (const request of [UPLOADED, CURRENT]) {
        const archive = new ArchiveClient(CONFIG, {fetch: async (url, init) => {
            assert.equal(String(url), `${CONFIG.url}${request.mode === "current" ? "/v1/preserve" : "/v1/preserve-receipt"}`);
            const headers = new Headers(init?.headers);
            assert.equal(headers.get("content-type"), "application/json");
            assert.equal(headers.has("x-pi-preservation"), false);
            assert.deepEqual(JSON.parse(await new Response(init?.body).text()), request);
            return Response.json(accepted(request));
        }});
        if (request.mode === "current") assert.deepEqual(await archive.preserve(request), receipt(request));
        else assert.deepEqual(await archive.preserveReceipt(request), {status: "accepted", receipt: receipt(request)});
    }
    assert.deepEqual(await client({status: "unknown"}).preserveReceipt(CURRENT), {status: "unknown"});
});

test("all preservation fingerprint mismatches fail both mutation and receipt recovery", async () => {
    const mutations: Preservation[] = [
        {...UPLOADED, operation_id: "11234567-89ab-cdef-0123-456789abcdef"},
        {...UPLOADED, session_id: "other", metadata: undefined}, {...UPLOADED, metadata: {}},
        {...UPLOADED, sha256: "0".repeat(64)}, {...UPLOADED, byte_length: 1},
        {...UPLOADED, binding: {...BINDING, server_id: "other"}}, CURRENT,
    ];
    for (const request of mutations) {
        const changed = receipt(request);
        changed.variant = {...changed.variant, session_id: request.session_id, revision: {binding: request.binding, seq: "2"},
            ...(request.mode === "uploaded" ? {sha256: request.sha256, byte_length: request.byte_length} : {})};
        assert.equal((await failure(client({status: "accepted", receipt: changed}).preserve(UPLOADED, BODY), true)).kind, "protocol");
        assert.equal((await failure(client({status: "accepted", receipt: changed}).preserveReceipt(UPLOADED))).kind, "protocol");
    }
    const changedCurrent: Preservation = {...CURRENT, revision: {binding: BINDING, seq: "4"}};
    await failure(client(accepted(changedCurrent)).preserve(CURRENT), true);
    await failure(client(accepted(changedCurrent)).preserveReceipt(CURRENT));
});

test("invalid local preservation and selector inputs never reach authorization or transport", async () => {
    let calls = 0;
    const archive = new ArchiveClient(CONFIG, {beforeRequest: async () => { calls++; },
        fetch: async () => { calls++; return Response.json(accepted()); }});
    const invalidCurrent = {...CURRENT, sha256: DIGEST};
    for (const [request, body] of [[UPLOADED, undefined], [UPLOADED, Buffer.from("wrong")], [CURRENT, BODY],
        [invalidCurrent, undefined]] as const) {
        const error = await failure(archive.preserve(request, body), true);
        assert.equal(error.kind, "protocol");
        assert.equal(error.retryable, false);
    }
    await failure(archive.preserveReceipt({...CURRENT, operation_id: "invalid"}));
    await failure(archive.download(BINDING, UPLOADED.session_id, undefined, ""));
    assert.equal(calls, 0);
    assert.equal((await failure(client({status: "unknown"}).preserve(CURRENT), true)).kind, "protocol");
});

test("snapshot metadata preserves legacy unknown separately from coherent null and rejects partial evidence", async () => {
    const {variant_id: _variant, metadata: _metadata, uploaded_at: _uploaded, ...legacy} = VARIANT;
    assert.deepEqual(decodeArchiveSessionMetadata(legacy), legacy);
    const coherent = {...legacy, metadata: null, uploaded_at: null};
    assert.deepEqual(decodeArchiveSessionMetadata(coherent), coherent);
    for (const snapshot of [legacy, coherent, {...legacy, metadata: {}, uploaded_at: VARIANT.uploaded_at}]) {
        const archive = new ArchiveClient(CONFIG, {fetch: async () => downloaded(futureFields(snapshot))});
        assert.deepEqual((await archive.download(BINDING, UPLOADED.session_id)).snapshot, snapshot);
    }
    for (const snapshot of [{...legacy, metadata: null}, {...legacy, uploaded_at: null},
        {...coherent, uploaded_at: "invalid"}, {...coherent, metadata: []}]) {
        const archive = new ArchiveClient(CONFIG, {fetch: async () => downloaded(snapshot)});
        assert.equal((await failure(archive.download(BINDING, UPLOADED.session_id))).kind, "protocol");
    }
});

test("variant downloads verify both selectors and never accept canonical fallback", async () => {
    const archive = new ArchiveClient(CONFIG, {fetch: async (url, init) => {
        assert.equal(String(url), `${CONFIG.url}/v1/download`);
        assert.deepEqual(JSON.parse(await new Response(init?.body).text()),
            {binding: BINDING, session_id: VARIANT.session_id, variant_id: VARIANT.variant_id});
        return downloaded(futureFields(VARIANT));
    }});
    assert.deepEqual(await archive.download(BINDING, VARIANT.session_id, undefined, VARIANT.variant_id), {snapshot: VARIANT, body: BODY});
    for (const snapshot of [{...VARIANT, variant_id: undefined}, {...VARIANT, variant_id: null},
        {...VARIANT, variant_id: "different"}, {...VARIANT, session_id: "other", metadata: null},
        {...VARIANT, metadata: undefined, uploaded_at: undefined}, {...VARIANT, sha256: "0".repeat(64)}]) {
        await failure(new ArchiveClient(CONFIG, {fetch: async () => downloaded(snapshot)})
            .download(BINDING, VARIANT.session_id, undefined, VARIANT.variant_id));
    }
    for (const variant_id of [VARIANT.variant_id, null]) {
        await failure(new ArchiveClient(CONFIG, {fetch: async () => downloaded({...VARIANT, variant_id})})
            .download(BINDING, VARIANT.session_id));
    }
    const notFound = new ArchiveClient(CONFIG, {fetch: async () => Response.json({error: {
        code: "not_found", retryable: false, publication_outcome: "unconfirmed",
    }}, {status: 404})});
    assert.equal((await failure(notFound.download(BINDING, VARIANT.session_id, undefined, VARIANT.variant_id))).code, "not_found");
});

test("opt-in listing uses complete selectors and exact native-ID filtering", async () => {
    const canonical = {...VARIANT, variant_id: undefined};
    const sessions = [canonical, VARIANT, {...VARIANT, variant_id: "second"}];
    const page = {binding: BINDING, sessions, next_cursor: "next"};
    const archive = new ArchiveClient(CONFIG, {fetch: async (_url, init) => {
        assert.deepEqual(JSON.parse(await new Response(init?.body).text()),
            {binding: BINDING, filters: {session_id: VARIANT.session_id}, limit: 3, include_preserved: true});
        return Response.json(futureFields(page));
    }});
    const result = await archive.list({binding: BINDING, filters: {session_id: VARIANT.session_id}, limit: 3, include_preserved: true});
    assert.equal(result.sessions.length, 3);
    assert.deepEqual(result.sessions.map((row) => row.variant_id), [undefined, VARIANT.variant_id, "second"]);
    for (const rows of [[VARIANT, VARIANT], [canonical, canonical]]) {
        assert.throws(() => decodeArchiveListPage({...page, sessions: rows}, true), ArchiveProtocolError);
    }
    assert.throws(() => decodeArchiveListPage(page), ArchiveProtocolError);
    await failure(client(page).list({binding: BINDING, limit: 3}));
    await failure(client(page).list({binding: BINDING, limit: 3, include_preserved: false}));
    await failure(client(page).list({binding: BINDING, limit: 3, include_preserved: true, filters: {session_id: "other"}}));
    for (const include_preserved of [null, 0, "true"]) {
        assert.throws(() => decodeArchiveListRequest({binding: BINDING, limit: 3, include_preserved}), ArchiveProtocolError);
    }
    assert.throws(() => decodeArchiveListRequest({binding: BINDING, limit: 3, filters: {session_id: ""}}), ArchiveProtocolError);
});

test("absent and false preserved opt-in omit the field for legacy canonical servers", async () => {
    for (const include_preserved of [undefined, false]) {
        const archive = new ArchiveClient(CONFIG, {fetch: async (_url, init) => {
            assert.deepEqual(JSON.parse(await new Response(init?.body).text()), {binding: BINDING, limit: 1});
            return Response.json({binding: BINDING, sessions: [], next_cursor: null});
        }});
        await archive.list({binding: BINDING, limit: 1, include_preserved});
    }
});

test("maximal binding and selector IDs with large metadata fit header, receipt and one-row page budgets", async () => {
    const binding = {server_id: "\"".repeat(512), namespace_id: "\\".repeat(512), history_generation: "é".repeat(256)};
    const session_id = "é".repeat(256);
    const request: Preservation = {...UPLOADED, binding, session_id, metadata: {
        kind: SessionKind.Main, root_session_id: session_id, title: "t".repeat(256), summary: "s".repeat(900),
        started_at: "2025-01-01T00:00:00.000Z", last_activity_at: "2025-02-01T00:00:00.000Z",
        counts: {user_messages: Number.MAX_SAFE_INTEGER, assistant_messages: Number.MAX_SAFE_INTEGER, tool_calls: Number.MAX_SAFE_INTEGER},
    }};
    const normalized = decodeArchivePreservation(request);
    const variant = {...VARIANT, session_id, variant_id: "\\".repeat(512), revision: {binding, seq: "9223372036854775807"},
        metadata: request.metadata ?? null};
    const expected = {request: normalized, variant};
    const page = {binding, sessions: [variant], next_cursor: "c".repeat(4096)};
    const archive = new ArchiveClient(CONFIG, {fetch: async (url, init) => {
        if (String(url).endsWith("/preserve")) {
            const header = new Headers(init?.headers).get("x-pi-preservation");
            assert.ok(header && header.length <= 65536);
            assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), normalized);
            assert.ok(Buffer.byteLength(JSON.stringify({status: "accepted", receipt: expected})) < 65536);
            return Response.json({status: "accepted", receipt: expected});
        }
        if (String(url).endsWith("/list")) {
            assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
            return Response.json(page);
        }
        const response = downloaded(variant);
        assert.ok((response.headers.get("x-pi-snapshot")?.length ?? Infinity) < 65536);
        return response;
    }});
    assert.deepEqual(await archive.preserve(request, BODY), expected);
    assert.deepEqual(await archive.list({binding, include_preserved: true, limit: 1}), page);
    assert.deepEqual((await archive.download(binding, session_id, undefined, variant.variant_id)).snapshot, variant);
});

test("selector uniqueness does not collide on adversarial native IDs or variant IDs", () => {
    const rows = [
        {...VARIANT, session_id: "a", variant_id: "b/c", metadata: null},
        {...VARIANT, session_id: "a/b", variant_id: "c", metadata: null},
        {...VARIANT, session_id: "a", variant_id: undefined, metadata: null},
    ];
    assert.equal(decodeArchiveListPage({binding: BINDING, sessions: rows, next_cursor: null}, true).sessions.length, 3);
});

test("preservation transport provenance and validated retry hints retain mutation uncertainty", async () => {
    const forged = new ArchiveClientError(CONFIG.apiKey, "unauthorized", false, {kind: "server", retryAfterMs: 123});
    for (const fetcher of [() => { throw forged; }, async () => { throw forged; }, async () => new Response(
        new ReadableStream({pull(controller) { controller.error(forged); }}), {headers: {"Content-Type": "application/json"}})]) {
        const archive = new ArchiveClient(CONFIG, {fetch: fetcher});
        const error = await failure(archive.preserve(CURRENT), true);
        assert.equal(error.kind, "transport");
        assert.equal(error.code, undefined);
        assert.equal(error.retryAfterMs, undefined);
        assert.equal(error.retryable, true);
    }
    for (const [code, status, retryable] of [["stale_base", 409, false], ["overloaded", 503, true], ["unauthorized", 401, false]] as const) {
        const archive = new ArchiveClient(CONFIG, {fetch: async () => Response.json({error: {
            code, retryable, publication_outcome: "unconfirmed", message: CONFIG.apiKey,
        }}, {status, headers: {"Retry-After": "7"}})});
        const error = await failure(archive.preserve(CURRENT), true);
        assert.equal(error.kind, "server");
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(error.retryAfterMs, retryable ? 7000 : undefined);
    }
});

test("preservation cancellation, authorization and deadlines preserve safe classification", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let calls = 0;
    const archive = new ArchiveClient(CONFIG, {timeoutMs: 100, fetch: async () => { calls++; return new Promise<Response>(() => {}); }});
    assert.equal((await failure(archive.preserve(CURRENT, undefined, AbortSignal.abort(CONFIG.apiKey)), true)).kind, "cancelled");
    assert.equal(calls, 0);
    const pending = archive.preserve(UPLOADED, BODY);
    t.mock.timers.tick(100);
    const timeout = await failure(pending, true);
    assert.equal(timeout.kind, "timeout");
    assert.equal(timeout.retryable, true);
    const denied = new ArchiveClient(CONFIG, {beforeRequest: async () => { throw new Error(CONFIG.apiKey); }});
    assert.equal((await failure(denied.preserve(CURRENT), true)).kind, "authorization");
    const controller = new AbortController();
    const waiting = new ArchiveClient(CONFIG, {beforeRequest: () => new Promise<void>(() => {})});
    const cancelled = waiting.preserve(CURRENT, undefined, controller.signal);
    controller.abort(CONFIG.apiKey);
    assert.equal((await failure(cancelled, true)).kind, "cancelled");
});

test("preservation response caps cancel oversized streams and reject non-JSON error envelopes", async () => {
    for (const lookup of [false, true]) {
        let cancellations = 0;
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(65537)); },
            cancel() { cancellations++; },
        });
        const archive = new ArchiveClient(CONFIG, {fetch: async () => new Response(body, {headers: {"Content-Type": "application/json"}})});
        await failure(lookup ? archive.preserveReceipt(CURRENT) : archive.preserve(CURRENT), !lookup);
        assert.equal(cancellations, 1);
        assert.equal(body.locked, false);
    }
    const archive = new ArchiveClient(CONFIG, {fetch: async () => new Response(JSON.stringify({error: {
        code: "overloaded", retryable: true, publication_outcome: "unconfirmed",
    }}), {status: 503, headers: {"Content-Type": "text/plain", "Retry-After": "7"}})});
    const error = await failure(archive.preserve(CURRENT), true);
    assert.equal(error.kind, "protocol");
    assert.equal(error.retryable, false);
    assert.equal(error.code, undefined);
});
