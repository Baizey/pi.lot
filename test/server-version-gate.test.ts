import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test, {type TestContext} from "node:test";
import {createServer, type RequestListener} from "node:http";
import {ArchiveClient, ArchiveClientError} from "../src/server/ArchiveClient.js";
import type {Binding, Preservation, Publication} from "../src/server/ArchiveProtocol.js";
import {ServerHttpError, ServerHttpTransport} from "../src/server/ServerHttpTransport.js";
import {ConfigSyncClient, ConfigSyncClientError} from "../src/server/config-sync/ConfigSyncClient.js";
import {configHash, type ConfigExchange} from "../src/server/config-sync/ConfigSyncProtocol.js";

const CONFIG = {url: "https://server.example.test", apiKey: "private-version-gate-key"};
const BINDING: Binding = {server_id: "server", namespace_id: "namespace", history_generation: "generation"};
const BODY = Buffer.from("native session bytes\n");
const PUBLICATION: Publication = {
    binding: BINDING, session_id: "native-session", operation_id: "01234567-89ab-cdef-0123-456789abcdef",
    condition: {kind: "absent"}, byte_length: BODY.length, sha256: createHash("sha256").update(BODY).digest("hex"),
};
const PRESERVATION: Preservation = {mode: "uploaded", binding: BINDING, session_id: PUBLICATION.session_id,
    operation_id: PUBLICATION.operation_id, byte_length: BODY.length, sha256: PUBLICATION.sha256, metadata: {}};
const EXCHANGE: ConfigExchange = {
    binding: BINDING, key: "display-defaults", base_revision: "0", change_id: PUBLICATION.operation_id,
    modified_at: "2026-01-01T00:00:00.000Z", schema_version: 1, content: null, sha256: configHash(null),
};
const CHECK = {binding: BINDING, key: EXCHANGE.key, known_revision: "0", sha256: EXCHANGE.sha256};

const ARCHIVE_OPERATIONS: Array<[string, (client: ArchiveClient) => Promise<unknown>]> = [
    ["binding", (client) => client.binding()],
    ["list", (client) => client.list({binding: BINDING, limit: 50})],
    ["publish", (client) => client.publish(PUBLICATION, BODY)],
    ["receipt", (client) => client.receipt(PUBLICATION)],
    ["preserve", (client) => client.preserve(PRESERVATION, BODY)],
    ["preserve-receipt", (client) => client.preserveReceipt(PRESERVATION)],
    ["download", (client) => client.download(BINDING, PUBLICATION.session_id)],
];
const CONFIG_OPERATIONS: Array<[string, (client: ConfigSyncClient) => Promise<unknown>]> = [
    ["binding", (client) => client.binding()],
    ["check", (client) => client.check(CHECK)],
    ["sync", (client) => client.sync(EXCHANGE)],
];

for (const [name, invoke] of [...ARCHIVE_OPERATIONS.map(([name, invoke]) => ["archive " + name,
    (fetch: typeof globalThis.fetch) => invoke(new ArchiveClient(CONFIG, {fetch}))] as const),
...CONFIG_OPERATIONS.map(([name, invoke]) => ["configuration " + name,
    (fetch: typeof globalThis.fetch) => invoke(new ConfigSyncClient(CONFIG, {fetch}))] as const)]) {
    test(`incompatible connection blocks ${name} before any operational request`, async () => {
        const paths: string[] = [];
        await assert.rejects(invoke(async (input, init) => {
            paths.push(new URL(String(input)).pathname);
            assert.equal(init?.method, "GET");
            assert.equal(init.body, undefined);
            assert.equal(new Headers(init.headers).get("x-apikey"), CONFIG.apiKey);
            return Response.json({version: "0.3.99", capabilities: ["config_sync_v1", "preserved_variants_v1"]});
        }), (error: unknown) => {
            assert.ok(error instanceof ServerHttpError);
            assert.equal(error.kind, "configuration");
            assert.equal(error.retryable, false);
            assert.equal(error.message, "Incompatible pi.server version; required 0.4.*.");
            assert.ok(name.startsWith("archive") ? error instanceof ArchiveClientError : error instanceof ConfigSyncClientError);
            return true;
        });
        assert.deepEqual(paths, ["/v1/version"]);
    });
}

test("only a decoded compatible stable version opens the shared transport", async () => {
    for (const version of ["0.4.0", "0.4.42", "0.4.0+build.7"]) {
        const paths: string[] = [];
        const transport = new ServerHttpTransport(CONFIG, {fetch: async (input) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            return Response.json(path === "/v1/version" ? {version} : {ok: true});
        }}, "test");
        for (const path of ["/v1/binding", "/v1/future-feature"]) {
            assert.deepEqual(await transport.exchange("GET", path, {}, "application/json", 1024,
                (_response, body) => transport.json(body)), {ok: true});
        }
        assert.deepEqual(paths, ["/v1/version", "/v1/binding", "/v1/future-feature"]);
    }
    for (const value of [{version: "0.2.0"}, {version: "0.5.0"}, {version: "0.4.0-rc.1"},
        {version: "0.4.0\n"}, {version: CONFIG.apiKey}, {version: 4}, {}, null]) {
        const paths: string[] = [];
        const client = new ArchiveClient(CONFIG, {fetch: async (input) => {
            paths.push(new URL(String(input)).pathname);
            return Response.json(value);
        }});
        await assert.rejects(client.binding(), (error: unknown) => error instanceof ArchiveClientError
            && error.kind === "configuration" && !error.message.includes(CONFIG.apiKey));
        assert.deepEqual(paths, ["/v1/version"]);
    }
});

test("compatible archive and configuration clients perform normal operations without a feature-specific check", async () => {
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/v1/version") return Response.json({version: "0.4.0"});
        if (path === "/v1/binding") return Response.json({binding: BINDING, head: "0"});
        if (path === "/v1/list") return Response.json({binding: BINDING, sessions: [], next_cursor: null});
        if (path === "/v1/config/check") return Response.json({binding: BINDING, key: EXCHANGE.key, sync_needed: false});
        assert.equal(path, "/v1/config/sync");
        return Response.json({binding: BINDING, key: EXCHANGE.key, revision: "0", schema_version: 1,
            content: null, sha256: EXCHANGE.sha256, updated_at: null, outcome: "unchanged"});
    };
    const archive = new ArchiveClient(CONFIG, {fetch: fetcher});
    await archive.binding();
    await archive.list({binding: BINDING, limit: 50});
    const config = new ConfigSyncClient(CONFIG, {fetch: fetcher});
    await config.binding();
    await config.check(CHECK);
    await config.sync(EXCHANGE);
    assert.deepEqual(paths, ["/v1/version", "/v1/binding", "/v1/list",
        "/v1/version", "/v1/binding", "/v1/config/check", "/v1/config/sync"]);
});

test("successful compatibility cannot authorize a replacement connection or skip per-request fencing", async () => {
    const paths: string[] = [];
    const approved: string[] = [];
    const config = {...CONFIG};
    let version = "0.4.0";
    let expectedKey = CONFIG.apiKey;
    let revoked = false;
    const options = {
        beforeRequest: async (_method: "GET" | "POST", path: string) => {
            approved.push(path);
            if (revoked) throw new Error(CONFIG.apiKey);
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            assert.equal(new Headers(init?.headers).get("x-apikey"), expectedKey);
            return Response.json(path === "/v1/version" ? {version} : {binding: BINDING, head: "0"});
        },
    };
    const archive = new ArchiveClient(config, options);
    await archive.binding();
    config.apiKey = "replacement-key";
    revoked = true;
    await assert.rejects(archive.binding(), (error: unknown) => error instanceof ArchiveClientError && error.kind === "authorization");
    assert.deepEqual(paths, ["/v1/version", "/v1/binding"]);
    assert.deepEqual(approved, ["/v1/version", "/v1/binding", "/v1/binding"]);
    revoked = false;
    version = "0.3.0";
    expectedKey = config.apiKey;
    await assert.rejects(new ConfigSyncClient(config, options).binding(), (error: unknown) => error instanceof ConfigSyncClientError
        && error.kind === "configuration");
    assert.deepEqual(paths, ["/v1/version", "/v1/binding", "/v1/version"]);
});

test("authorization must allow the handshake and still allow the operation after verification", async () => {
    for (const initiallyAllowed of [false, true]) {
        let allowed = initiallyAllowed;
        const approved: string[] = [];
        const fetched: string[] = [];
        const client = new ConfigSyncClient(CONFIG, {
            beforeRequest: async (_method, path) => {
                approved.push(path);
                if (!allowed) throw new Error(CONFIG.apiKey);
            },
            fetch: async (input) => {
                fetched.push(new URL(String(input)).pathname);
                allowed = false;
                return Response.json({version: "0.4.0"});
            },
        });
        await assert.rejects(client.sync(EXCHANGE), (error: unknown) => error instanceof ConfigSyncClientError
            && error.kind === "authorization" && !error.message.includes(CONFIG.apiKey));
        assert.deepEqual(fetched, initiallyAllowed ? ["/v1/version"] : []);
        assert.deepEqual(approved, initiallyAllowed ? ["/v1/version", "/v1/config/sync"] : ["/v1/version"]);
    }
});

test("failed, malformed, oversized and redirected handshakes never open the gate", async () => {
    for (const response of [
        Response.json({error: {code: "unauthorized", retryable: false}}, {status: 401}),
        new Response(CONFIG.apiKey, {headers: {"Content-Type": "application/json"}}),
        new Response(" ".repeat(4097), {headers: {"Content-Type": "application/json"}}),
        new Response(null, {status: 302, headers: {Location: "https://elsewhere.example.test"}}),
    ]) {
        const paths: string[] = [];
        const archive = new ArchiveClient(CONFIG, {fetch: async (input) => {
            paths.push(new URL(String(input)).pathname);
            return response;
        }});
        await assert.rejects(archive.binding(), (error: unknown) => error instanceof ArchiveClientError
            && !error.message.includes(CONFIG.apiKey));
        assert.deepEqual(paths, ["/v1/version"]);
    }
});

async function mockHttp(t: TestContext, handler: RequestListener) {
    const server = createServer((request, reply) => {
        reply.setHeader("Connection", "close");
        handler(request, reply);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => error ? reject(error) : resolve());
    }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {...CONFIG, url: `http://127.0.0.1:${address.port}`};
}

test("real HTTP handshakes are authenticated, bodyless, and bounded to 4 KiB with or without a declared length", async (t) => {
    let version = JSON.stringify({version: "0.4.0"});
    version += " ".repeat(4096 - Buffer.byteLength(version));
    let declared = true;
    const paths: string[] = [];
    const config = await mockHttp(t, (request, reply) => {
        paths.push(request.url!);
        assert.equal(request.method, "GET");
        assert.equal(request.headers["x-apikey"], CONFIG.apiKey);
        assert.equal(request.headers.accept, "application/json");
        assert.equal(request.headers["content-type"], undefined);
        assert.equal(request.headers["content-length"], undefined);
        const body = request.url === "/v1/version" ? version : JSON.stringify({binding: BINDING, head: "0"});
        reply.writeHead(200, {"Content-Type": "application/json", ...(declared ? {"Content-Length": Buffer.byteLength(body)} : {})});
        reply.end(body);
    });
    await new ArchiveClient(config).binding();
    version += " ";
    for (declared of [true, false]) {
        await assert.rejects(new ArchiveClient(config).binding(), (error: unknown) => error instanceof ArchiveClientError
            && error.kind === "protocol" && /size limit/u.test(error.message));
    }
    assert.deepEqual(paths, ["/v1/version", "/v1/binding", "/v1/version", "/v1/version"]);
});

test("an unverified slow connection times out or aborts without dispatching the requested operation", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    for (const abort of [false, true]) {
        const paths: string[] = [];
        const caller = new AbortController();
        const archive = new ArchiveClient(CONFIG, {timeoutMs: 100, fetch: async (input) => {
            paths.push(new URL(String(input)).pathname);
            return new Promise<Response>(() => {});
        }});
        const pending = archive.binding(caller.signal);
        if (abort) caller.abort(CONFIG.apiKey);
        else t.mock.timers.tick(100);
        await assert.rejects(pending, (error: unknown) => error instanceof ArchiveClientError
            && error.kind === (abort ? "cancelled" : "timeout") && !error.message.includes(CONFIG.apiKey));
        assert.deepEqual(paths, ["/v1/version"]);
    }
});
