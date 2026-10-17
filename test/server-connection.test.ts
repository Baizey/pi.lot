import assert from "node:assert/strict";
import test from "node:test";
import {REQUIRED_SERVER_VERSION} from "../src/server/ServerConfig.js";
import {checkServerVersion, type ServerStatus} from "../src/server/ServerConnection.js";

const CONFIG = Object.freeze({url: "https://sessions.example.com", apiKey: "private-connection-test-key"});
const encoder = new TextEncoder();

function failure(status: ServerStatus): string {
    assert.equal(status.kind, "failure");
    assert.ok("message" in status);
    assert.equal(status.message.includes(CONFIG.apiKey), false);
    return status.message;
}

function streamResponse(chunks: Uint8Array[], options: {status?: number; headers?: HeadersInit; close?: boolean} = {}) {
    let reads = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            reads++;
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else if (options.close !== false) controller.close();
        },
        cancel() { cancellations++; },
    }, {highWaterMark: 0});
    const response = new Response(body, {status: options.status ?? 200, headers: options.headers});
    return {response, body, reads: () => reads, cancellations: () => cancellations};
}

function pendingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    assert.ok(init?.signal);
    const signal = init.signal;
    return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    });
}

test("version check sends one authenticated GET with native TLS defaults and refuses redirects", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), `${CONFIG.url}/v1/version`);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "manual");
        assert.deepEqual(new Headers(init?.headers), new Headers({
            "x-apikey": CONFIG.apiKey, Accept: "application/json",
        }));
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        // No custom agent/dispatcher or TLS overrides, request body, or credential-bearing URL.
        assert.deepEqual(Object.keys(init).sort(), ["headers", "method", "redirect", "signal"]);
        return Response.json({version: REQUIRED_SERVER_VERSION});
    });
    assert.deepEqual(await checkServerVersion(CONFIG), {kind: "compatible", version: REQUIRED_SERVER_VERSION});
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(CONFIG, {url: "https://sessions.example.com", apiKey: "private-connection-test-key"});
});

test("HTTP and HTTPS origins on non-loopback configured hosts are accepted", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({version: REQUIRED_SERVER_VERSION}));
    for (const url of ["http://sessions.example.com:8080", "https://sessions.example.com:8443"]) {
        assert.deepEqual(await checkServerVersion({...CONFIG, url}), {kind: "compatible", version: REQUIRED_SERVER_VERSION});
        assert.equal(String(fetch.mock.calls.at(-1)?.arguments[0]), `${url}/v1/version`);
    }
});

test("well-formed versions other than the exact required string are incompatible", async (t) => {
    let version = "";
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({version}));
    const versions = ["0.1.0", "0.1.1", "1.0.0", "0.1.1-rc.1", "0.1.1+build.7", `1.2.3+${"a".repeat(122)}`]
        .filter((candidate) => candidate !== REQUIRED_SERVER_VERSION);
    for (version of versions) {
        assert.deepEqual(await checkServerVersion(CONFIG), {kind: "incompatible", version});
    }
    assert.equal(fetch.mock.callCount(), versions.length);
});

test("missing, incorrectly typed, or non-object version payloads fail", async (t) => {
    let payload: unknown;
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    for (payload of [{}, {Version: "0.1.1"}, {version: null}, {version: 1}, {version: []}, null, [], "0.1.1", 42]) {
        assert.match(failure(await checkServerVersion(CONFIG)), /invalid.*version/i);
    }
});

test("malformed, unbounded, control-bearing and arbitrary version strings are never reflected", async (t) => {
    let version = "";
    t.mock.method(globalThis, "fetch", async () => Response.json({version}));
    for (version of [
        "", "0.1", "v0.1.1", "00.1.1", "0.01.1", "0.1.01", "0.1.1-01", "0.1.1-", "0.1.1+", "0.1.1-a..b",
        " 0.1.1", "0.1.1 ", "0.1.1\n", "0.1.1\r", "0.1.1\u2028", "0.1.1\u2029", "0.1.1\u0000", "0.1.1\u001b[31m",
        "arbitrary server text", `0.1.1-${CONFIG.apiKey} invalid`, `1.2.3+${"a".repeat(123)}`,
    ]) {
        const result = await checkServerVersion(CONFIG);
        assert.match(failure(result), /invalid.*version/i);
        if (version) assert.equal(JSON.stringify(result).includes(version), false);
    }
});

test("non-JSON, truncated JSON and empty responses fail without returning their contents", async (t) => {
    let body = "";
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    for (body of ["", `<html>${CONFIG.apiKey}</html>`, `{"version":"${CONFIG.apiKey}"`, "undefined"]) {
        assert.match(failure(await checkServerVersion(CONFIG)), /invalid.*JSON/i);
    }
});

test("invalid UTF-8 is not silently replaced before JSON validation", async (t) => {
    const start = encoder.encode('{"version":"0.1.1","extra":"');
    const end = encoder.encode('"}');
    t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([...start, 0xff, ...end])));
    assert.match(failure(await checkServerVersion(CONFIG)), /invalid.*JSON/i);
});

test("JSON may be chunked at any byte boundary, including across multibyte characters", async (t) => {
    const bytes = encoder.encode(JSON.stringify({version: REQUIRED_SERVER_VERSION, extra: "é"}));
    const stream = streamResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    t.mock.method(globalThis, "fetch", async () => stream.response);
    assert.deepEqual(await checkServerVersion(CONFIG), {kind: "compatible", version: REQUIRED_SERVER_VERSION});
    assert.equal(stream.body.locked, false);
    assert.equal(stream.reads(), bytes.length + 1);
});

test("a valid response of exactly 4 KiB is accepted without trusting Content-Length", async (t) => {
    const json = JSON.stringify({version: REQUIRED_SERVER_VERSION});
    const stream = streamResponse([encoder.encode(json), encoder.encode(" ".repeat(4096 - json.length))], {
        headers: {"Content-Length": "99999999"},
    });
    t.mock.method(globalThis, "fetch", async () => stream.response);
    assert.deepEqual(await checkServerVersion(CONFIG), {kind: "compatible", version: REQUIRED_SERVER_VERSION});
    assert.equal(stream.body.locked, false);
});

test("oversized single-chunk and streamed bodies are cancelled without reading the remainder", async (t) => {
    let response: Response;
    t.mock.method(globalThis, "fetch", async () => response);
    for (const chunks of [
        [new Uint8Array(4097), new Uint8Array(1)],
        [new Uint8Array(2048), new Uint8Array(2048), new Uint8Array(1), new Uint8Array(1)],
    ]) {
        const expectedReads = chunks.length - 1;
        const stream = streamResponse(chunks, {headers: {"Content-Length": "1"}, close: false});
        response = stream.response;
        assert.match(failure(await checkServerVersion(CONFIG)), /4 KiB/);
        assert.equal(stream.reads(), expectedReads);
        assert.equal(stream.cancellations(), 1);
        assert.equal(stream.body.locked, false);
    }
});

test("the response bound counts bytes rather than decoded characters", async (t) => {
    const body = JSON.stringify({version: "0.1.1", extra: "é".repeat(2100)});
    assert.ok(body.length < 4096);
    assert.ok(encoder.encode(body).length > 4096);
    const stream = streamResponse([encoder.encode(body)], {close: false});
    t.mock.method(globalThis, "fetch", async () => stream.response);
    assert.match(failure(await checkServerVersion(CONFIG)), /4 KiB/);
    assert.equal(stream.cancellations(), 1);
});

test("401 decodes the known authentication error; a 403 proxy response is unexpected", async (t) => {
    let response: Response;
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    for (const status of [401, 403]) {
        const stream = streamResponse([encoder.encode(JSON.stringify({error: {
            code: "unauthorized", retryable: false, publication_outcome: "unconfirmed",
        }}))], {status});
        response = stream.response;
        const message = failure(await checkServerVersion(CONFIG));
        assert.match(message, status === 401 ? /unauthorized/ : /Unexpected server response/);
        assert.match(message, new RegExp(`HTTP ${status}`));
        assert.ok(stream.reads() > 0);
        assert.equal(stream.body.locked, false);
    }
    assert.equal(fetch.mock.callCount(), 2);
});

test("429 decodes rate_limited and a numeric Retry-After without reflecting other header content", async (t) => {
    let retryAfter = "900";
    t.mock.method(globalThis, "fetch", async () => Response.json({error: {
        code: "rate_limited", retryable: true, publication_outcome: "unconfirmed",
    }}, {status: 429, headers: {"Retry-After": retryAfter}}));
    const message = failure(await checkServerVersion(CONFIG));
    assert.match(message, /rate_limited.*HTTP 429|HTTP 429.*rate_limited/);
    assert.match(message, /900 seconds/);
    retryAfter = CONFIG.apiKey;
    assert.doesNotMatch(failure(await checkServerVersion(CONFIG)), /Retry after/);
});

test("known server failures are decoded by code, including distinct errors sharing HTTP 503", async (t) => {
    let response: Response;
    t.mock.method(globalThis, "fetch", async () => response);
    for (const [code, status, retryable] of [
        ["invalid_request", 400, false], ["not_found", 404, false], ["internal", 500, false],
        ["overloaded", 503, true], ["uncertain_commit", 503, true], ["capacity", 507, true],
    ] as const) {
        response = Response.json({error: {code, retryable, publication_outcome: "unconfirmed"}} , {status});
        const message = failure(await checkServerVersion(CONFIG));
        assert.ok(message.includes(code));
        assert.match(message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(message, /Unexpected server response/);
    }
});

test("non-protocol errors are explicitly unexpected without reflecting arbitrary response text", async (t) => {
    let response: Response;
    t.mock.method(globalThis, "fetch", async () => response);
    for (const status of [201, 400, 404, 418, 500, 503]) {
        const stream = streamResponse([encoder.encode(CONFIG.apiKey)], {status});
        response = stream.response;
        const message = failure(await checkServerVersion(CONFIG));
        assert.match(message, /Unexpected server response/);
        assert.match(message, new RegExp(`HTTP ${status}`));
        assert.equal(stream.body.locked, false);
    }
    response = new Response(null, {status: 204});
    assert.match(failure(await checkServerVersion(CONFIG)), /Unexpected server response.*HTTP 204/);
});

test("redirects are refused without exposing Location or following another request", async (t) => {
    let response: Response;
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    for (const status of [301, 302, 303, 307, 308]) {
        const stream = streamResponse([encoder.encode(CONFIG.apiKey)], {
            status, headers: {Location: `https://other.example.com/${CONFIG.apiKey}`}, close: false,
        });
        response = stream.response;
        assert.match(failure(await checkServerVersion(CONFIG)), /redirect refused/i);
        assert.equal(stream.reads(), 0);
        assert.equal(stream.cancellations(), 1);
    }
    response = new Response(null, {status: 304});
    assert.match(failure(await checkServerVersion(CONFIG)), /redirect refused/i);
    assert.equal(fetch.mock.callCount(), 6);
});

test("connection and TLS exceptions are sanitized and never retried or logged", async (t) => {
    let error: unknown;
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw error; });
    const logs = (["log", "warn", "error"] as const).map((name) => t.mock.method(console, name, () => {}));
    for (error of [new TypeError(`${CONFIG.apiKey}: ${CONFIG.url}`), new Error(`TLS certificate: ${CONFIG.apiKey}`), CONFIG.apiKey]) {
        assert.match(failure(await checkServerVersion(CONFIG)), /unable to connect/i);
    }
    assert.equal(fetch.mock.callCount(), 3);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test("network and TLS causes retain the real code/message and provide relevant hints", async (t) => {
    let error: unknown;
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw error; });
    const cases = [
        {code: "ECONNREFUSED", detail: "connect ECONNREFUSED 192.0.2.10:9696", hint: /listening.*container port/},
        {code: "EHOSTUNREACH", detail: "connect EHOSTUNREACH 192.0.2.10:9696", hint: /routing.*VPN.*firewall/},
        {code: "ENETUNREACH", detail: "network unreachable", hint: /routing.*VPN.*firewall/},
        {code: "ENOTFOUND", detail: "getaddrinfo ENOTFOUND example.invalid", hint: /hostname.*DNS/},
        {code: "ECONNRESET", detail: "socket hang up", hint: /closed unexpectedly.*HTTP or HTTPS/},
        {code: "EPERM", detail: "operation not permitted", hint: /permission or network policy/},
        {code: "UND_ERR_CONNECT_TIMEOUT", detail: "Connect Timeout Error", hint: /timed out.*firewall/},
        {code: "ERR_SSL_WRONG_VERSION_NUMBER", detail: "wrong version number", hint: /plain HTTP rather than HTTPS/},
        {code: "ERR_TLS_CERT_ALTNAME_INVALID", detail: "IP address is not in the cert list", hint: /does not match the certificate/},
        {code: "SELF_SIGNED_CERT_IN_CHAIN", detail: "self-signed certificate in chain", hint: /not trusted by Node/},
        {code: "HPE_INVALID_CONSTANT", detail: "Expected HTTP/", hint: /valid HTTP response/},
        {code: "CUSTOM_PROXY_ERROR", detail: "Unexpected local proxy configuration", hint: /Unexpected local proxy configuration/},
    ];
    for (const {code, detail, hint} of cases) {
        error = new TypeError("fetch failed", {cause: Object.assign(new Error(detail), {code})});
        const message = failure(await checkServerVersion(CONFIG));
        assert.ok(message.includes(code));
        assert.ok(message.includes(detail));
        assert.match(message, hint);
        assert.equal(message.includes("fetch failed"), false);
    }
    assert.equal(fetch.mock.callCount(), cases.length);
});

test("dual-stack aggregate failures retain both socket errors without repeating the fetch wrapper", async (t) => {
    const errors = [
        Object.assign(new Error("connect ECONNREFUSED ::1:9696"), {code: "ECONNREFUSED"}),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9696"), {code: "ECONNREFUSED"}),
    ];
    t.mock.method(globalThis, "fetch", async () => {
        throw new TypeError("fetch failed", {cause: new AggregateError(errors)});
    });
    const message = failure(await checkServerVersion(CONFIG));
    assert.match(message, /::1:9696/);
    assert.match(message, /127.0.0.1:9696/);
    assert.equal(message.includes("fetch failed"), false);
});

test("diagnostics bound causal chains, tolerate cycles, redact credentials and remove terminal controls", async (t) => {
    let error: unknown;
    t.mock.method(globalThis, "fetch", async () => { throw error; });
    const cyclic = Object.assign(new Error(`socket closed ${CONFIG.apiKey} ${CONFIG.url}\u001b[31m`), {code: "ECONNRESET"});
    cyclic.cause = cyclic;
    error = new TypeError("fetch failed", {cause: cyclic});
    const message = failure(await checkServerVersion(CONFIG));
    assert.match(message, /ECONNRESET/);
    assert.equal(message.includes("\u001b"), false);
    let cause: unknown;
    for (let index = 19; index >= 0; index--) cause = new Error(`level${index} ${"x".repeat(1000)}`, {cause});
    error = new TypeError("fetch failed", {cause});
    const bounded = failure(await checkServerVersion(CONFIG));
    assert.ok(bounded.length < 5000);
    assert.ok(bounded.includes("level0"));
    assert.equal(bounded.includes("level7"), false);
});

test("a body read failure is distinguished from connection failure and its lock is released", async (t) => {
    const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(Object.assign(new Error(`response aborted ${CONFIG.apiKey}`), {code: "ECONNRESET"})); },
    });
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    const message = failure(await checkServerVersion(CONFIG));
    assert.match(message, /^Server response failed:.*ECONNRESET/);
    assert.equal(body.locked, false);
});

test("an already cancelled caller performs no request and never exposes the abort reason", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", pendingFetch);
    assert.match(failure(await checkServerVersion(CONFIG, AbortSignal.abort(CONFIG.apiKey))), /cancelled/i);
    assert.equal(fetch.mock.callCount(), 0);
});

test("caller cancellation aborts an in-flight fetch without retries", async (t) => {
    const caller = new AbortController();
    const fetch = t.mock.method(globalThis, "fetch", pendingFetch);
    const pending = checkServerVersion(CONFIG, caller.signal);
    caller.abort(new Error(CONFIG.apiKey));
    assert.match(failure(await pending), /cancelled/i);
    assert.equal(fetch.mock.callCount(), 1);
});

test("caller cancellation cancels a stalled response body and releases its reader", async (t) => {
    const caller = new AbortController();
    const stream = streamResponse([], {close: false});
    t.mock.method(globalThis, "fetch", async () => stream.response);
    const pending = checkServerVersion(CONFIG, caller.signal);
    // Let fetch settle and install the body reader before cancellation.
    await Promise.resolve();
    caller.abort(CONFIG.apiKey);
    assert.match(failure(await pending), /cancelled/i);
    assert.equal(stream.cancellations(), 1);
    assert.equal(stream.body.locked, false);
});

test("a stalled fetch times out after 10 seconds with a sanitized message", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const fetch = t.mock.method(globalThis, "fetch", pendingFetch);
    const pending = checkServerVersion(CONFIG);
    const signal = fetch.mock.calls[0].arguments[1]?.signal;
    assert.ok(signal);
    t.mock.timers.tick(9999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    assert.match(failure(await pending), /timed out.*10 seconds/i);
    assert.equal(fetch.mock.callCount(), 1);
});

test("the same 10-second deadline covers headers and a stalled body", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const stream = streamResponse([], {close: false});
    t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(stream.response), 9000);
    }));
    const pending = checkServerVersion(CONFIG);
    t.mock.timers.tick(9000);
    await Promise.resolve();
    assert.equal(stream.body.locked, true);
    t.mock.timers.tick(1000);
    assert.match(failure(await pending), /timed out/i);
    assert.equal(stream.cancellations(), 1);
    assert.equal(stream.body.locked, false);
});

test("completed checks clear their deadline and do not start background requests", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({version: REQUIRED_SERVER_VERSION}));
    assert.deepEqual(await checkServerVersion(CONFIG), {kind: "compatible", version: REQUIRED_SERVER_VERSION});
    const signal = fetch.mock.calls[0].arguments[1]?.signal;
    assert.ok(signal);
    t.mock.timers.tick(100_000);
    assert.equal(signal.aborted, false);
    assert.equal(fetch.mock.callCount(), 1);
});
