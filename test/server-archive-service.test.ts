import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import test, {type TestContext} from "node:test";
import {SessionArchive, type ArchiveListInput} from "../src/server/SessionArchive.js";
import {ArchiveClient, ArchiveClientError} from "../src/server/ArchiveClient.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";
import type {Binding, ListRequest, SessionMetadata} from "../src/server/ArchiveProtocol.js";

const config = {url: "https://archive.example", apiKey: "synthetic-never-print-this-key"};
const identity: Binding = {server_id: randomUUID(), namespace_id: randomUUID(), history_generation: randomUUID()};

function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-archive-service-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const stateDirectory = path.join(directory, "state");
    let capable = true;
    let body: Buffer = Buffer.from([0, 255, 1, 2, 3]);
    const client = new ArchiveClient(config, {fetch: async () => { throw new Error("Unexpected real HTTP request"); }});
    const binding = t.mock.method(client, "binding", async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return {binding: identity, head: "0", ...(capable ? {capabilities: ["preserved_variants_v1"]} : {})};
    });
    const list = t.mock.method(client, "list", async (request: ListRequest, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return {binding: request.binding, sessions: [], next_cursor: null};
    });
    const download = t.mock.method(client, "download", async (destination: Binding, sessionId: string,
        signal?: AbortSignal, variantId?: string) => {
        signal?.throwIfAborted();
        const snapshot: SessionMetadata = {session_id: sessionId, revision: {binding: destination, seq: "1"},
            byte_length: body.length, sha256: createHash("sha256").update(body).digest("hex"),
            ...(variantId !== undefined ? {variant_id: variantId} : {}),
            ...(capable ? {metadata: {}, uploaded_at: "2026-01-01T00:00:00.000Z"} : {})};
        return {snapshot, body: Buffer.from(body)};
    });
    const service = (url = config.url) => new SessionArchive({...config, url}, {client, stateDirectory});
    return {directory, stateDirectory, client, binding, list, download, service,
        legacy: () => { capable = false; }, setBody: (value: Buffer) => { body = value; }};
}

test("list forwards filters and continuation without creating upload state or a local catalog", async (t) => {
    const f = fixture(t);
    const input = {filters: {kind: SessionKind.Main, root_session_id: "root"}, cursor: "cursor", limit: 25};
    await f.service().list(input);
    assert.deepEqual(f.list.mock.calls[0]!.arguments[0], {binding: identity, ...input});
    assert.equal(fs.existsSync(f.stateDirectory), false);
    assert.equal(f.download.mock.callCount(), 0);
});

test("local list and selector validation happens before binding or HTTP", async (t) => {
    const f = fixture(t);
    for (const input of [
        {filters: {started_from: "2026-02-30T00:00:00Z"}},
        {filters: {activity_from: "2026-02-01T00:00:00Z", activity_to: "2026-01-01T00:00:00Z"}},
        {filters: {root_session_id: "root\n"}}, {filters: {session_id: ""}},
        ...["", "cursor\u007f", "x".repeat(4097)].map((cursor) => ({cursor})),
        ...[0, -1, 1.5, NaN, Infinity, 4294967296, null].map((limit) => ({limit})),
        {include_preserved: "yes"},
    ]) await assert.rejects(f.service().list(input as ArchiveListInput), /Invalid archive protocol data/);
    for (const id of ["", "id\n", "é".repeat(257), "\ud800"]) {
        await assert.rejects(f.service().fetch(id), /Invalid archive protocol data/);
        await assert.rejects(f.service().fetch("valid", undefined, id), /Invalid archive protocol data/);
    }
    assert.equal(f.binding.mock.callCount(), 0);
    assert.equal(f.list.mock.callCount(), 0);
    assert.equal(f.download.mock.callCount(), 0);
    assert.equal(fs.existsSync(f.stateDirectory), false);
});

test("list normalizes dates and separates exact native identity from variant opt-in", async (t) => {
    const f = fixture(t);
    await f.service().list({filters: {session_id: "root", started_from: "2026-01-01T02:00:00+02:00"},
        cursor: "opaque", include_preserved: true});
    assert.deepEqual(f.list.mock.calls[0]!.arguments[0], {binding: identity, limit: 50,
        filters: {session_id: "root", started_from: "2026-01-01T00:00:00.000Z"}, cursor: "opaque", include_preserved: true});
});

test("legacy canonical requests omit additive options and unsupported selectors never fall back", async (t) => {
    const f = fixture(t);
    f.legacy();
    await f.service().list({include_preserved: false});
    assert.deepEqual(f.list.mock.calls[0]!.arguments[0], {binding: identity, limit: 50});
    for (const input of [{include_preserved: true}, {filters: {session_id: "root"}}]) {
        await assert.rejects(f.service().list(input), ArchiveClientError);
    }
    await assert.rejects(f.service().fetch("root", undefined, "variant"), ArchiveClientError);
    assert.equal(f.list.mock.callCount(), 1);
    assert.equal(f.download.mock.callCount(), 0);
    assert.equal(fs.existsSync(f.stateDirectory), false);
    const canonical = await f.service().fetch("root");
    assert.equal(canonical.snapshot.variant_id, undefined);
    assert.equal(canonical.snapshot.metadata, undefined, "absence is unknown, not invented empty metadata");
});

test("fetch caches verified opaque bytes privately without importing or creating an upload journal", async (t) => {
    const f = fixture(t);
    const body = Buffer.from([0, 255, 1, 2, 3]);
    f.setBody(body);
    const fetched = await f.service().fetch("../untrusted/session");
    assert.ok(fetched.path.startsWith(`${f.stateDirectory}${path.sep}downloads${path.sep}`));
    assert.deepEqual(fs.readFileSync(fetched.path), body);
    assert.equal(fs.statSync(fetched.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(fetched.path)).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(f.stateDirectory, "archive.sqlite")), false);
    assert.equal(fs.readdirSync(path.dirname(fetched.path)).length, 1);
    assert.equal("upload" in f.service(), false, "foreground reads must not retain the obsolete network-owned uploader");
});

test("variant fetch pins the native ID and exact variant selector through client and cache identity", async (t) => {
    const f = fixture(t);
    const canonical = await f.service().fetch("root");
    const first = await f.service().fetch("root", undefined, "variant-1");
    const second = await f.service().fetch("root", undefined, "variant-2");
    assert.deepEqual(f.download.mock.calls.map((call) => call.arguments.slice(1)), [
        ["root", undefined, undefined], ["root", undefined, "variant-1"], ["root", undefined, "variant-2"],
    ]);
    assert.equal(first.snapshot.session_id, "root");
    assert.equal(first.snapshot.variant_id, "variant-1");
    assert.equal(new Set([canonical.path, first.path, second.path]).size, 3);
    assert.deepEqual(fs.readFileSync(first.path), fs.readFileSync(canonical.path));
});

test("cache identities include origin, server, namespace, history generation and selector", async (t) => {
    const f = fixture(t);
    const original = {...identity};
    const variants = [
        {url: config.url, binding: original}, {url: "https://other-archive.example", binding: original},
        {url: config.url, binding: {...original, server_id: randomUUID()}},
        {url: config.url, binding: {...original, namespace_id: randomUUID()}},
        {url: config.url, binding: {...original, history_generation: randomUUID()}},
    ];
    try {
        const paths = new Set<string>();
        for (const variant of variants) {
            Object.assign(identity, variant.binding);
            paths.add((await f.service(variant.url).fetch("same-id")).path);
        }
        assert.equal(paths.size, variants.length);
        assert.equal(fs.existsSync(path.join(f.stateDirectory, "archive.sqlite")), false);
    } finally { Object.assign(identity, original); }
});

test("cancellation after download prevents cache writes and creates no archive state", async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const download = f.client.download.bind(f.client);
    t.mock.method(f.client, "download", async (...args: Parameters<ArchiveClient["download"]>) => {
        const result = await download(...args);
        controller.abort(new Error("Cancelled"));
        return result;
    });
    await assert.rejects(f.service().fetch("root", controller.signal), /Cancelled/);
    assert.equal(fs.existsSync(f.stateDirectory), false);
});
