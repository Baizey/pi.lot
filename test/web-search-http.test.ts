import assert from "node:assert/strict";
import test from "node:test";
import {requestSearchHttp, WebSearchPolicyDeniedError} from "../src/web-search/SearchHttp.js";
import type {ToolCallPathPolicyEvaluator} from "../src/policy/PolicyRuntime.js";
import {
    PolicyAccessType,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
} from "../src/policy/types.js";

test("search HTTP requests authorize every redirect and strip cross-origin credentials", async () => {
    const policies: Array<{url: string; accessType: PolicyAccessType}> = [];
    const requests: Array<{url: string; method: string; headers: Headers}> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
            url,
            method: String(init?.method),
            headers: new Headers(init?.headers),
        });
        if (requests.length === 1) {
            return new Response(null, {status: 302, headers: {Location: "https://other.example.test/result"}});
        }
        return new Response("final body", {status: 200, headers: {"Content-Type": "text/plain"}});
    }) as typeof globalThis.fetch;
    const response = await requestSearchHttp({
        url: "https://search.example.test/query",
        headers: {Authorization: "Bearer secret", "X-Custom-Secret": "also-secret"},
        sensitiveHeaders: ["X-Custom-Secret"],
    }, allowPolicy(policies), {
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
    }, fetch);

    assert.equal(response.body, "final body");
    assert.deepEqual(policies, [
        {url: "https://search.example.test/query", accessType: PolicyAccessType.HTTP_GET},
        {url: "https://other.example.test/result", accessType: PolicyAccessType.HTTP_GET},
    ]);
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret");
    assert.equal(requests[1]?.headers.has("authorization"), false);
    assert.equal(requests[1]?.headers.has("x-custom-secret"), false);
});

test("search HTTP requests map POST redirects to a newly authorized GET", async () => {
    const policies: Array<{url: string; accessType: PolicyAccessType}> = [];
    const methods: string[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(String(init?.method));
        return methods.length === 1
            ? new Response(null, {status: 303, headers: {Location: "/done"}})
            : new Response("{}", {status: 200});
    }) as typeof globalThis.fetch;
    await requestSearchHttp({
        url: "https://api.example.test/search",
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: "{}",
    }, allowPolicy(policies), {
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
    }, fetch);

    assert.deepEqual(methods, ["POST", "GET"]);
    assert.deepEqual(policies.map((entry) => entry.accessType), [
        PolicyAccessType.HTTP_POST,
        PolicyAccessType.HTTP_GET,
    ]);
});

test("search HTTP requests fail before fetch on denial and bound response bodies", async () => {
    let fetches = 0;
    const fetch = (async () => {
        fetches++;
        return new Response("x".repeat(20), {status: 200});
    }) as typeof globalThis.fetch;
    await assert.rejects(
        requestSearchHttp(
            {url: "https://denied.example.test"},
            async (url, accessType) => policyResult(url, accessType, PolicyResponse.DENIED),
            {timeoutMs: 1_000, maxResponseBytes: 10},
            fetch,
        ),
        WebSearchPolicyDeniedError,
    );
    assert.equal(fetches, 0);

    await assert.rejects(
        requestSearchHttp(
            {url: "https://large.example.test"},
            async (url, accessType) => policyResult(url, accessType, PolicyResponse.ALLOWED),
            {timeoutMs: 1_000, maxResponseBytes: 10},
            fetch,
        ),
        /exceeds 10 bytes/,
    );
    assert.equal(fetches, 1);
});

function allowPolicy(
    calls: Array<{url: string; accessType: PolicyAccessType}>,
): ToolCallPathPolicyEvaluator {
    return async (url, accessType) => {
        calls.push({url, accessType});
        return policyResult(url, accessType, PolicyResponse.ALLOWED);
    };
}

function policyResult(
    url: string,
    accessType: PolicyAccessType,
    status: PolicyResponse,
): PolicyResult {
    return PolicyResult.of({
        evaluatedUri: url,
        evaluatedAccessType: accessType,
        matchedPattern: url,
        matchedLifetime: PolicyLifetime.ONCE,
        matchedStatus: status,
        matchedReason: "test",
        resolutionSource: PolicyResolutionSource.SYSTEM,
    });
}
