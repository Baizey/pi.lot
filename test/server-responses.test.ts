import assert from "node:assert/strict";
import test from "node:test";
import {
    decodeServerError, decodeVersionResponse, formatServerError,
    type ServerError, type ServerErrorCode, type ServerVersionResponse,
} from "../src/server/ServerResponses.js";

// Independent expectations from pi.server's error_response wire contract.
const ERRORS = {
    invalid_request: {status: 400, retryable: false, meaning: /request format and identifiers/i},
    integrity: {status: 400, retryable: false, meaning: /content length and SHA-256/i},
    unauthorized: {status: 401, retryable: false, meaning: /API key is missing, invalid, or revoked/i},
    rate_limited: {status: 429, retryable: true, meaning: /temporary IP ban or authentication tracker limit/i},
    method_not_allowed: {status: 405, retryable: false, meaning: /endpoint and method/i},
    unsupported_media_type: {status: 415, retryable: false, meaning: /Content-Type/i},
    payload_too_large: {status: 413, retryable: false, meaning: /reduce the request size/i},
    binding_mismatch: {status: 409, retryable: false, meaning: /stop synchronization.*reconcile.*binding/i},
    cursor_mismatch: {status: 409, retryable: false, meaning: /restart discovery/i},
    stale_base: {status: 409, retryable: false, meaning: /current revision.*resolve the conflict/i},
    already_exists: {status: 409, retryable: false, meaning: /current revision or.*different session ID/i},
    operation_id_mismatch: {status: 409, retryable: false, meaning: /original request.*new ID/i},
    capacity: {status: 507, retryable: true, meaning: /storage.*resource quotas/i},
    overloaded: {status: 503, retryable: true, meaning: /overloaded.*retry later/i},
    corruption: {status: 500, retryable: false, meaning: /administrator.*storage integrity/i},
    not_found: {status: 404, retryable: false, meaning: /server URL.*server version.*resource/i},
    uncertain_commit: {status: 503, retryable: true, meaning: /uncertain.*check the operation receipt before retrying/i},
    internal: {status: 500, retryable: false, meaning: /administrator.*server logs/i},
} satisfies Record<ServerErrorCode, {status: number; retryable: boolean; meaning: RegExp}>;

function envelope(code: string, retryable: boolean) {
    return {error: {code, retryable, publication_outcome: "unconfirmed"}};
}

for (const [code, expected] of Object.entries(ERRORS)) {
    test(`${code}: decodes the exact status, retryable flag and publication outcome`, () => {
        const value = envelope(code, expected.retryable);
        const error = decodeServerError(value, expected.status);
        assert.deepEqual(error, value.error);
        assert.ok(error);
        assert.notEqual(error, value.error, "return an owned typed value, not the untrusted object");
        for (const status of [200, 400, 401, 403, 404, 405, 409, 413, 415, 429, 500, 502, 503, 504, 507, NaN]) {
            if (status !== expected.status) assert.equal(decodeServerError(value, status), undefined);
        }
        for (const retryable of [!expected.retryable, undefined, null, 0, 1, "true", "false"]) {
            assert.equal(decodeServerError({error: {...value.error, retryable}}, expected.status), undefined);
        }
        for (const publication_outcome of [undefined, null, true, "confirmed", "unknown", "Unconfirmed", "unconfirmed\n", {}]) {
            assert.equal(decodeServerError({error: {...value.error, publication_outcome}}, expected.status), undefined);
        }
        const message = formatServerError(error, "7");
        assert.ok(message.includes(`(${code}; HTTP ${expected.status})`));
        assert.match(message, expected.meaning);
        assert.equal(message.includes("Retry after 7 seconds."), expected.retryable);
    });
}

test("error decoder rejects malformed envelopes, unknown codes and proxy response shapes", () => {
    const valid = envelope("unauthorized", false);
    const malformed: unknown[] = [
        undefined, null, false, 401, "Unauthorized", "<html>proxy error</html>", [], [valid], {},
        {error: null}, {error: "unauthorized"}, {error: []}, {error: [valid.error]},
        valid.error, {errors: [valid.error]}, {message: "unauthorized"}, {cause: valid}, {response: valid},
        {error: {code: "unauthorized"}}, {error: {retryable: false, publication_outcome: "unconfirmed"}},
    ];
    for (const value of malformed) assert.equal(decodeServerError(value, 401), undefined);
    for (const code of [undefined, null, true, 401, {}, [], "", "Unauthorized", "UNAUTHORIZED", "future_error", "__proto__", "constructor", "toString", "unauthorized\n"]) {
        assert.equal(decodeServerError({error: {...valid.error, code}}, 401), undefined);
    }
});

test("error decoder ignores extra JSON fields without propagating raw server text", () => {
    const rawText = "private-api-key\u001b[31mhttps://private.example/";
    const error = decodeServerError({
        error: {...envelope("unauthorized", false).error, message: rawText, details: {cause: rawText}},
        message: rawText, extra: "é",
    }, 401);
    assert.deepEqual(error, {code: "unauthorized", retryable: false, publication_outcome: "unconfirmed"});
    assert.ok(error);
    assert.equal(formatServerError(error, rawText), "Server API key is missing, invalid, or revoked (unauthorized; HTTP 401). Check the configured API key.");
    assert.equal(JSON.stringify(error).includes(rawText), false);
});

test("503 overload and uncertain publication have distinct actionable messages", () => {
    const overloaded: ServerError = {code: "overloaded", retryable: true, publication_outcome: "unconfirmed"};
    const uncertain: ServerError = {...overloaded, code: "uncertain_commit"};
    assert.equal(formatServerError(overloaded, "1"), "Server is overloaded (overloaded; HTTP 503). Retry later. Retry after 1 seconds.");
    assert.equal(formatServerError(uncertain, null), "Server publication outcome is uncertain (uncertain_commit; HTTP 503). Check the operation receipt before retrying the same operation.");
});

test("Retry-After accepts only one to nine ASCII digits and only for retryable errors", () => {
    const retryable: ServerError = {code: "rate_limited", retryable: true, publication_outcome: "unconfirmed"};
    for (const [header, seconds] of [["0", 0], ["1", 1], ["000001", 1], ["999999999", 999999999]] as const) {
        assert.ok(formatServerError(retryable, header).endsWith(` Retry after ${seconds} seconds.`));
    }
    for (const header of [null, "", "1000000000", "0000000000", "-1", "+1", "1.0", "1e2", " 1", "1 ", "1\n", "1\r\n", "1\u2028", "1\u2029", "١", "１", "Wed, 21 Oct 2015 07:28:00 GMT", "private-api-key\u001b[31m"]) {
        assert.equal(formatServerError(retryable, header), formatServerError(retryable, null));
    }
    const unauthorized: ServerError = {code: "unauthorized", retryable: false, publication_outcome: "unconfirmed"};
    assert.equal(formatServerError(unauthorized, "5"), formatServerError(unauthorized, null));
    assert.equal(formatServerError({...retryable, retryable: false}, "5"), formatServerError(retryable, null));
});

test("version decoder accepts SemVer and extra fields, returning only the typed version", () => {
    for (const version of ["0.0.0", "1.2.3", "12.34.56", "1.2.3-rc.1", "1.2.3-0", "1.2.3-01a", "1.2.3-alpha-beta", "1.2.3+001", "1.2.3-rc.1+build.7", `1.2.3+${"a".repeat(122)}`]) {
        const value = {version, extra: "é", message: "private text"};
        const decoded: ServerVersionResponse | undefined = decodeVersionResponse(value);
        assert.deepEqual(decoded, {version});
        assert.notEqual(decoded, value);
    }
});

test("version decoder rejects non-object and incorrectly typed version responses", () => {
    for (const value of [undefined, null, [], ["1.2.3"], "1.2.3", 123, true, {}, {Version: "1.2.3"}, {version: undefined}, {version: null}, {version: 123}, {version: true}, {version: []}, {version: {version: "1.2.3"}}]) {
        assert.equal(decodeVersionResponse(value), undefined);
    }
});

test("version decoder enforces the existing strict ASCII SemVer grammar and 128 character limit", () => {
    for (const version of [
        "", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-a.01", "1.2.3-", "1.2.3+", "1.2.3-a..b", "1.2.3+build..7",
        " 1.2.3", "1.2.3 ", "1.2.3\n", "1.2.3\r", "1.2.3\u2028", "1.2.3\u2029", "1.2.3\u0000", "1.2.3\u001b[31m", "1.2.3-é", "１.2.3", "private server text", `1.2.3+${"a".repeat(123)}`,
    ]) {
        assert.equal(decodeVersionResponse({version}), undefined, JSON.stringify(version));
    }
});
