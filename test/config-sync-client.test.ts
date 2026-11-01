import assert from "node:assert/strict";
import test from "node:test";
import {configClient} from "./fixtures/CompatibleServer.js";
import type {ArchiveClientOptions} from "../src/server/ArchiveClient.js";
import {ArchiveProtocolError, type Binding} from "../src/server/ArchiveProtocol.js";
import {ServerHttpError} from "../src/server/ServerHttpTransport.js";
import {ConfigSyncClient, ConfigSyncClientError} from "../src/server/config-sync/ConfigSyncClient.js";
import {
    CONFIG_SYNC_CAPABILITY, MAX_CONFIG_CONTENT_BYTES, MAX_CONFIG_WIRE_BYTES, ConfigSyncProtocolError,
    configHash, type ConfigCheck, type ConfigExchange, type ConfigState,
} from "../src/server/config-sync/ConfigSyncProtocol.js";

const CONFIG = {url: "https://config.example.test", apiKey: "private-config-test-key"};
const BINDING: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "generation"};
const CONTENT = '{"normal":"minimal","alternate":"truncated"}';
const REQUEST: ConfigExchange = {binding: BINDING, key: "display-defaults", base_revision: "9007199254740993",
    change_id: "01234567-89ab-cdef-0123-456789abcdef", modified_at: "2025-01-01T00:00:00.000Z",
    schema_version: 1, content: CONTENT, sha256: configHash(CONTENT)};
const CHECK: ConfigCheck = {binding: BINDING, key: REQUEST.key, known_revision: REQUEST.base_revision, sha256: REQUEST.sha256};
const STATE: ConfigState = {binding: BINDING, key: REQUEST.key, revision: "9007199254740994", schema_version: 1,
    content: CONTENT, sha256: REQUEST.sha256, updated_at: REQUEST.modified_at, outcome: "client_won"};

function client(response: Response, options: ArchiveClientOptions = {}): ConfigSyncClient {
    return configClient(CONFIG, {fetch: async () => response, ...options});
}

async function failure(pending: Promise<unknown>, kind?: ConfigSyncClientError["kind"]): Promise<ConfigSyncClientError> {
    try { await pending; assert.fail("Expected rejection"); }
    catch (error) {
        assert.ok(error instanceof ConfigSyncClientError);
        assert.equal(error.message.includes(CONFIG.apiKey), false);
        assert.equal(error.message.includes(CONTENT), false);
        assert.equal("cause" in error, false);
        if (kind) assert.equal(error.kind, kind);
        return error;
    }
}

function source(chunks: Uint8Array[] = [], options: {stall?: boolean; cancelNeverSettles?: boolean; status?: number; headers?: HeadersInit} = {}) {
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

function reverse(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)]));
}

test("binding, check and sync use exact authenticated endpoints and normalized JSON wire data", async () => {
    const paths: string[] = [];
    const approved: string[] = [];
    const sync = configClient(CONFIG, {beforeRequest: async (method, path, signal) => {
        assert.equal(signal, undefined);
        approved.push(`${method} ${path}`);
        assert.equal(path.includes(CONFIG.apiKey), false);
    }, fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-apikey"), CONFIG.apiKey);
        assert.equal(headers.get("accept"), "application/json");
        assert.equal(init?.redirect, "manual");
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal("dispatcher" in init, false);
        assert.equal("agent" in init, false);
        if (path === "/v1/binding") {
            assert.equal(init?.method, "GET");
            assert.equal(init.body, undefined);
            return Response.json({binding: BINDING, head: "0", capabilities: [CONFIG_SYNC_CAPABILITY]});
        }
        assert.equal(init?.method, "POST");
        assert.equal(headers.get("content-type"), "application/json");
        const body = await new Response(init?.body).text();
        assert.equal(headers.get("content-length"), String(Buffer.byteLength(body)));
        assert.deepEqual(JSON.parse(body), path.endsWith("check") ? CHECK : REQUEST);
        return Response.json(path.endsWith("check") ? {binding: BINDING, key: REQUEST.key, sync_needed: true} : STATE);
    }});
    assert.deepEqual(await sync.binding(), {binding: BINDING, head: "0", capabilities: [CONFIG_SYNC_CAPABILITY]});
    assert.deepEqual(await sync.check(CHECK), {binding: BINDING, key: REQUEST.key, sync_needed: true});
    assert.deepEqual(await sync.sync(REQUEST), STATE);
    assert.deepEqual(paths, ["/v1/binding", "/v1/config/check", "/v1/config/sync"]);
    assert.deepEqual(approved, ["GET /v1/binding", "POST /v1/config/check", "POST /v1/config/sync"]);
});

test("request snapshots remain immutable across authorization and retries have identical wire identity", async () => {
    const request = structuredClone(REQUEST);
    const original = structuredClone(request);
    const wires: string[] = [];
    let approve: (() => void) | undefined;
    const sync = configClient(CONFIG, {beforeRequest: () => new Promise<void>((resolve) => { approve = resolve; }),
        fetch: async (_input, init) => { wires.push(await new Response(init?.body).text()); return Response.json(STATE); }});
    const pending = sync.sync(request);
    assert.deepEqual(request, original);
    request.binding.namespace_id = "changed";
    request.content = null;
    request.sha256 = configHash(null);
    request.change_id = "11234567-89ab-cdef-0123-456789abcdef";
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(approve);
    approve();
    assert.deepEqual(await pending, STATE);
    const retry = sync.sync(reverse(original) as ConfigExchange);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(approve);
    approve();
    assert.deepEqual(await retry, STATE);
    assert.equal(wires.length, 2);
    assert.equal(wires[0], wires[1]);
    assert.deepEqual(JSON.parse(wires[0]), original);
    const result = await client(Response.json(STATE)).sync(Object.freeze({...original, binding: Object.freeze({...original.binding})}));
    assert.deepEqual(result, STATE);
});

test("a timeout retry preserves the complete change identity and exact content bytes", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const wires: Buffer[] = [];
    const sync = configClient(CONFIG, {timeoutMs: 100, fetch: (_input, init) => {
        assert.ok(Buffer.isBuffer(init?.body));
        wires.push(Buffer.from(init.body));
        return wires.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(Response.json(STATE));
    }});
    const pending = sync.sync(REQUEST);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    await failure(pending, "timeout");
    assert.deepEqual(await sync.sync(REQUEST), STATE);
    assert.equal(wires.length, 2);
    assert.deepEqual(wires[0], wires[1]);
    assert.deepEqual(JSON.parse(wires[1].toString()), REQUEST);
});

test("check snapshots correlation inputs before an authorization wait", async () => {
    const request = structuredClone(CHECK);
    let approve: (() => void) | undefined;
    const sync = client(Response.json({binding: BINDING, key: REQUEST.key, sync_needed: false}), {
        beforeRequest: () => new Promise<void>((resolve) => { approve = resolve; }),
        fetch: async (_input, init) => {
            assert.deepEqual(JSON.parse(await new Response(init?.body).text()), CHECK);
            return Response.json({binding: BINDING, key: REQUEST.key, sync_needed: false});
        },
    });
    const pending = sync.check(request);
    request.binding.history_generation = "changed";
    request.key = "web-search";
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(approve);
    approve();
    assert.equal((await pending).sync_needed, false);
});

test("sync validates binding, key, digest, content schema, timestamp, outcome and lossless base ordering", async () => {
    for (const state of [
        {...STATE, binding: {...BINDING, server_id: "other"}},
        {...STATE, binding: {...BINDING, namespace_id: "other"}},
        {...STATE, binding: {...BINDING, history_generation: "other"}},
        {...STATE, key: "web-search", content: null, sha256: configHash(null)},
        {...STATE, sha256: "0".repeat(64)}, {...STATE, schema_version: 2},
        {...STATE, revision: "9007199254740992"}, {...STATE, revision: "01"}, {...STATE, revision: 1},
        {...STATE, content: "{}", sha256: configHash("{}")},
        {...STATE, content: "not JSON", sha256: configHash("not JSON")},
        {...STATE, updated_at: "2025-02-30T00:00:00.000Z"}, {...STATE, outcome: "unknown"},
        {...STATE, content: undefined},
    ]) assert.equal((await failure(client(Response.json(state)).sync(REQUEST), "protocol")).retryable, false);
    assert.equal((await client(Response.json({...STATE, revision: REQUEST.base_revision, outcome: "unchanged"})).sync(REQUEST)).revision, REQUEST.base_revision);
    const absent: ConfigState = {...STATE, revision: "0", content: null, sha256: configHash(null), updated_at: null, outcome: "unchanged"};
    assert.deepEqual(await client(Response.json(absent)).sync({...REQUEST, base_revision: null}), absent);
    assert.deepEqual(await client(Response.json({...absent, revision: "1", updated_at: STATE.updated_at})).sync({...REQUEST, base_revision: "0"}),
        {...absent, revision: "1", updated_at: STATE.updated_at});
});

test("check rejects mismatched binding/key and malformed results", async () => {
    for (const value of [null, {}, {binding: BINDING, key: REQUEST.key, sync_needed: 1},
        {binding: {...BINDING, namespace_id: "other"}, key: REQUEST.key, sync_needed: true},
        {binding: BINDING, key: "global-policies", sync_needed: true}]) {
        await failure(client(Response.json(value)).check(CHECK), "protocol");
    }
});

test("local malformed requests are rejected safely before authorization or fetch", async () => {
    let approved = 0;
    let fetched = 0;
    const sync = configClient(CONFIG, {beforeRequest: async () => { approved++; },
        fetch: async () => { fetched++; return Response.json(STATE); }});
    for (const request of [
        {...REQUEST, sha256: "0".repeat(64)}, {...REQUEST, schema_version: 2},
        {...REQUEST, extra: CONFIG.apiKey}, {...REQUEST, base_revision: "01"},
        {...REQUEST, change_id: REQUEST.change_id.toUpperCase()}, {...REQUEST, key: "server.json"},
        {...REQUEST, content: CONFIG.apiKey}, {...REQUEST, content: " ".repeat(MAX_CONFIG_CONTENT_BYTES + 1)},
        {...REQUEST, modified_at: "2025-01-01"}, {...REQUEST, binding: {...BINDING, apiKey: CONFIG.apiKey}},
    ]) await failure(sync.sync(request as ConfigExchange), "protocol");
    for (const request of [
        {...CHECK, sha256: CHECK.sha256.toUpperCase()}, {...CHECK, sha256: `${CHECK.sha256}\n`},
        {...CHECK, known_revision: "9223372036854775808"}, {...CHECK, key: "server.json"},
        {...CHECK, extra: CONFIG.apiKey}, {...CHECK, binding: null},
    ]) await failure(sync.check(request as ConfigCheck), "protocol");
    assert.equal(approved, 0);
    assert.equal(fetched, 0);
});

test("configuration errors reject credential-bearing URLs, invalid origins, keys and timeouts", () => {
    for (const config of [
        {...CONFIG, url: `https://user:${CONFIG.apiKey}@config.example.test`}, {...CONFIG, url: "file:///tmp/config"},
        {...CONFIG, url: `${CONFIG.url}/path`}, {...CONFIG, url: `${CONFIG.url}/?query`},
        {...CONFIG, apiKey: ""}, {...CONFIG, apiKey: "key\n"}, {...CONFIG, apiKey: "é"},
    ]) assert.throws(() => configClient(config), (error: unknown) => error instanceof ConfigSyncClientError && error.kind === "configuration");
    for (const timeoutMs of [0, -1, 0.5, Infinity, 2147483648]) {
        assert.throws(() => configClient(CONFIG, {timeoutMs}), (error: unknown) => error instanceof ConfigSyncClientError && error.kind === "configuration");
    }
});

test("custom fetch/read errors cannot forge server/protocol provenance or leak diagnostics", async () => {
    for (const cause of [new Error(CONFIG.apiKey), new ConfigSyncProtocolError(), new ArchiveProtocolError(),
        new ServerHttpError(CONFIG.apiKey, "overloaded", {kind: "server", retryAfterMs: 7000}),
        new ConfigSyncClientError(new ServerHttpError(CONFIG.apiKey, "unauthorized"))]) {
        for (const readFailure of [false, true]) {
            for (const asynchronous of [false, true]) {
                const sync = configClient(CONFIG, {fetch: () => {
                    if (!readFailure) {
                        if (asynchronous) return Promise.reject(cause);
                        throw cause;
                    }
                    const body = new ReadableStream<Uint8Array>({pull(controller) { controller.error(cause); }});
                    return Promise.resolve(new Response(body, {headers: {"Content-Type": "application/json"}}));
                }});
                const error = await failure(sync.sync(REQUEST), "transport");
                assert.equal(error.retryable, true);
                assert.equal(error.code, undefined);
                assert.equal(error.retryAfterMs, undefined);
            }
        }
    }
});

test("only validated HTTP error envelopes may grant retries and bounded retry hints", async () => {
    const valid = {error: {code: "overloaded", retryable: true, publication_outcome: "unconfirmed", message: CONFIG.apiKey}};
    const error = await failure(client(Response.json(valid, {status: 503, headers: {"Retry-After": "999999999"}})).sync(REQUEST), "server");
    assert.equal(error.code, "overloaded");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 86_400_000);
    const denied = await failure(client(Response.json({error: {code: "unauthorized", retryable: false, publication_outcome: "unconfirmed"}},
        {status: 401})).check(CHECK), "server");
    assert.equal(denied.retryable, false);
    for (const response of [
        Response.json(valid, {status: 500}), Response.json({error: {...valid.error, retryable: false}}, {status: 503}),
        Response.json({error: {...valid.error, code: "future"}}, {status: 503}),
        new Response(JSON.stringify(valid), {status: 503, headers: {"Content-Type": "text/html"}}),
        Response.json({message: CONFIG.apiKey}, {status: 502}),
    ]) {
        const rejected = await failure(client(response).sync(REQUEST), "protocol");
        assert.equal(rejected.code, undefined);
        assert.equal(rejected.retryable, false);
    }
});

test("redirects, rewritten origins and encoding are refused before reading and cancel streams", async () => {
    for (const mode of [301, 302, 303, 307, 308, "redirected", "url", "encoding"] as const) {
        const stream = source([], {stall: true, status: typeof mode === "number" ? mode : 200,
            headers: {Location: `https://other.example.test/${CONFIG.apiKey}`}});
        if (mode === "redirected") Object.defineProperty(stream.response, "redirected", {value: true});
        if (mode === "url") Object.defineProperty(stream.response, "url", {value: `https://other.example.test/${CONFIG.apiKey}`});
        if (mode === "encoding") stream.response.headers.set("Content-Encoding", "gzip");
        await failure(client(stream.response).sync(REQUEST), "protocol");
        assert.equal(stream.reads(), 0);
        assert.equal(stream.cancellations(), 1);
        assert.equal(stream.body.locked, false);
    }
});

test("finite deadlines cover uncooperative fetch and body reads without waiting for cancel", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let resolveFetch: ((response: Response) => void) | undefined;
    const sync = configClient(CONFIG, {timeoutMs: 100, fetch: () => new Promise<Response>((resolve) => { resolveFetch = resolve; })});
    const caller = new AbortController();
    const pending = sync.sync(REQUEST, caller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    caller.abort(CONFIG.apiKey);
    assert.equal((await failure(pending, "timeout")).retryable, true);
    const late = source([], {stall: true});
    assert.ok(resolveFetch);
    resolveFetch(late.response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(late.cancellations(), 1);
    const stream = source([], {stall: true, cancelNeverSettles: true});
    const reading = client(stream.response, {timeoutMs: 100}).sync(REQUEST);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stream.body.locked, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    await failure(reading, "timeout");
    assert.equal(stream.body.locked, false);
    assert.equal(stream.cancellations(), 1);
});

test("caller cancellation before approval, during fetch and during reads never leaks abort reasons", async () => {
    let fetched = 0;
    const sync = configClient(CONFIG, {fetch: async () => { fetched++; return new Promise<Response>(() => {}); }});
    await failure(sync.sync(REQUEST, AbortSignal.abort(CONFIG.apiKey)), "cancelled");
    assert.equal(fetched, 0);
    const caller = new AbortController();
    const pending = sync.sync(REQUEST, caller.signal);
    caller.abort(CONFIG.apiKey);
    assert.equal((await failure(pending, "cancelled")).retryable, false);
    const stream = source([], {stall: true});
    const readerAbort = new AbortController();
    const reading = client(stream.response).sync(REQUEST, readerAbort.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    readerAbort.abort(CONFIG.apiKey);
    await failure(reading, "cancelled");
    assert.equal(stream.cancellations(), 1);
    assert.equal(stream.body.locked, false);
    const policyAbort = new AbortController();
    const approving = configClient(CONFIG, {beforeRequest: () => new Promise<void>(() => {}),
        fetch: async () => { assert.fail("No fetch while awaiting approval"); }}).check(CHECK, policyAbort.signal);
    policyAbort.abort(CONFIG.apiKey);
    await failure(approving, "cancelled");
});

test("authorization is rechecked per request, has no HTTP deadline, and may fence logout", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    let connected = true;
    let approve: (() => void) | undefined;
    let fetched = 0;
    let requestSignal: AbortSignal | null | undefined;
    const sync = configClient(CONFIG, {timeoutMs: 100, beforeRequest: async () => {
        await new Promise<void>((resolve) => { approve = resolve; });
        if (!connected) throw new Error(CONFIG.apiKey);
    }, fetch: async (_input, init) => { fetched++; requestSignal = init?.signal; return Response.json(STATE); }});
    const first = sync.sync(REQUEST);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10000);
    assert.equal(fetched, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(approve);
    approve();
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10000);
    assert.equal(requestSignal?.aborted, false);
    const second = sync.sync(REQUEST);
    connected = false;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(approve);
    approve();
    assert.equal((await failure(second, "authorization")).retryable, false);
    assert.equal(fetched, 1);
});

test("sync wrapper allows its exact response cap while version/binding/check/error caps stay small", async () => {
    for (const [cap, response, call] of [
        [MAX_CONFIG_WIRE_BYTES, STATE, (sync: ConfigSyncClient) => sync.sync(REQUEST)],
        [65536, {binding: BINDING, head: "0"}, (sync: ConfigSyncClient) => sync.binding()],
        [65536, {binding: BINDING, key: REQUEST.key, sync_needed: true}, (sync: ConfigSyncClient) => sync.check(CHECK)],
    ] as const) {
        const bytes = Buffer.from(JSON.stringify(response));
        const exact = source([bytes, Buffer.alloc(cap - bytes.length, 32)], {headers: {"Content-Length": String(cap)}});
        await call(client(exact.response));
        assert.equal(exact.body.locked, false);
        const overflow = source([Buffer.alloc(cap), Uint8Array.of(1), Uint8Array.of(2)], {stall: true});
        assert.match((await failure(call(client(overflow.response)), "protocol")).message, /size limit/);
        assert.equal(overflow.reads(), 2);
        assert.equal(overflow.cancellations(), 1);
        assert.equal(overflow.body.locked, false);
    }
    for (const declared of [false, true]) {
        const error = source([Buffer.alloc(65537)], {status: 503, stall: true,
            headers: declared ? {"Content-Length": "65537"} : {}});
        await failure(client(error.response).sync(REQUEST), "protocol");
        assert.equal(error.reads(), declared ? 0 : 1);
        assert.equal(error.cancellations(), 1);
    }
});

test("maximum content is sent without enlarging archive/control budgets", async () => {
    const content = CONTENT + " ".repeat(MAX_CONFIG_CONTENT_BYTES - Buffer.byteLength(CONTENT));
    const request = {...REQUEST, content, sha256: configHash(content)};
    let fetched = 0;
    const sync = configClient(CONFIG, {fetch: async (_input, init) => {
        fetched++;
        const body = await new Response(init?.body).text();
        assert.ok(Buffer.byteLength(body) > 65536);
        assert.ok(Buffer.byteLength(body) <= MAX_CONFIG_WIRE_BYTES);
        assert.equal(JSON.parse(body).content, content);
        return Response.json({...STATE, content, sha256: request.sha256});
    }});
    assert.equal((await sync.sync(request)).content, content);
    await failure(sync.sync({...request, content: content + " ", sha256: configHash(content + " ")}), "protocol");
    assert.equal(fetched, 1);
});

test("malformed JSON, invalid UTF-8, missing bodies and inconsistent framing are terminal", async () => {
    for (const body of ["", CONFIG.apiKey, "null", "[]", "{}", Buffer.from([0xff])]) {
        await failure(client(new Response(body, {headers: {"Content-Type": "application/json"}})).sync(REQUEST), "protocol");
    }
    const framingHeaders: HeadersInit[] = [
        {"Content-Length": "0"}, {"Content-Length": "01"}, {"Content-Length": "1.0"},
        {"Content-Length": "9007199254740992"}, {"Content-Type": "application/json; charset=utf-8"},
    ];
    for (const headers of framingHeaders) await failure(client(Response.json(STATE, {headers})).sync(REQUEST), "protocol");
    await failure(client(new Response(null, {headers: {"Content-Type": "application/json"}})).sync(REQUEST), "protocol");
    const bytes = Buffer.from(JSON.stringify(STATE));
    const fragmented = source(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    assert.deepEqual(await client(fragmented.response).sync(REQUEST), STATE);
    assert.equal(fragmented.body.locked, false);
});
