import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {NativeSearchProvider} from "../src/web-search/providers/NativeSearchProvider.js";
import {requestSearchHttp, WebSearchPolicyDeniedError} from "../src/web-search/SearchHttp.js";
import {searchProviders} from "../src/web-search/WebSearch.js";
import {
    PolicyAccessType,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
} from "../src/policy/types.js";
import {
    WebSearchProviderId,
    type WebSearchHttp,
    type WebSearchHttpRequest,
    type WebSearchHttpResponse,
} from "../src/web-search/SearchProvider.js";

test("native search availability follows Pi's active authenticated model", () => {
    const model = nativeModel("google-generative-ai", "google", "gemini-test");
    assert.equal(new NativeSearchProvider(nativeContext(model, {}, true)).available(), true);
    assert.equal(new NativeSearchProvider(nativeContext(model, {}, false)).available(), false);
    assert.equal(new NativeSearchProvider(nativeContext(
        nativeModel("openai-completions", "openai", "gpt-test"),
        {},
        true,
    )).available(), false);
});

test("Gemini native search uses Pi auth and maps grounding sources", async () => {
    const model = nativeModel("google-generative-ai", "google", "gemini-test");
    let request: WebSearchHttpRequest | undefined;
    const provider = new NativeSearchProvider(nativeContext(model, {apiKey: "gemini-secret"}, true));
    const response = await provider.search({query: "question", maxResults: 5}, fakeHttp(async (value) => {
        request = value;
        return sseResponse({
            candidates: [{
                content: {parts: [{text: "Grounded Gemini answer"}]},
                groundingMetadata: {
                    groundingChunks: [{web: {title: "Gemini source", uri: "https://source.example/gemini"}}],
                },
            }],
        });
    }));

    assert.equal(new URL(request!.url).pathname, "/v1/models/gemini-test:streamGenerateContent");
    assert.equal(new Headers(request!.headers).get("x-goog-api-key"), "gemini-secret");
    assert.equal(response.answer, "Grounded Gemini answer");
    assert.equal(response.results[0]?.url, "https://source.example/gemini");
});

test("Copilot native search uses Pi's resolved endpoint and Responses search", async () => {
    const model = nativeModel("openai-responses", "github-copilot", "gpt-test");
    let request: WebSearchHttpRequest | undefined;
    const provider = new NativeSearchProvider(nativeContext(model, {
        apiKey: "copilot-secret",
        baseUrl: "https://api.enterprise-copilot.example/v1",
    }, true));
    const response = await provider.search({query: "question", maxResults: 5}, fakeHttp(async (value) => {
        request = value;
        return sseResponse(
            {
                type: "response.output_text.delta",
                delta: "Copilot answer [cited source](https://source.example/cited)",
            },
            {
                type: "response.output_item.done",
                item: {
                    type: "web_search_call",
                    action: {sources: [{title: "Copilot source", url: "https://source.example/copilot"}]},
                },
            },
        );
    }));

    assert.equal(String(request!.url), "https://api.enterprise-copilot.example/v1/responses");
    assert.deepEqual(JSON.parse(request!.body ?? "{}").tools, [{type: "web_search"}]);
    assert.equal(response.answer, "Copilot answer [cited source](https://source.example/cited)");
    assert.equal(response.results[0]?.url, "https://source.example/cited");
    assert.equal(response.results[1]?.url, "https://source.example/copilot");
});

test("Codex native search uses Pi OAuth metadata and requires server search", async () => {
    const accountId = "account-123";
    const token = jwt({"https://api.openai.com/auth": {chatgpt_account_id: accountId}});
    const model = nativeModel("openai-codex-responses", "openai-codex", "codex-test");
    let request: WebSearchHttpRequest | undefined;
    const provider = new NativeSearchProvider(nativeContext(model, {apiKey: token}, true));
    const response = await provider.search({query: "question", maxResults: 5}, fakeHttp(async (value) => {
        request = value;
        return sseResponse(
            {type: "response.output_text.delta", delta: "Codex answer"},
            {
                type: "response.output_item.done",
                item: {
                    type: "web_search_call",
                    action: {sources: [{title: "Codex source", url: "https://source.example/codex"}]},
                },
            },
        );
    }));

    assert.equal(new URL(request!.url).pathname, "/v1/codex/responses");
    assert.equal(new Headers(request!.headers).get("chatgpt-account-id"), accountId);
    assert.equal(JSON.parse(request!.body ?? "{}").tool_choice, "required");
    assert.equal(response.answer, "Codex answer");
});

test("Claude native search uses Pi auth and Anthropic's server search tool", async () => {
    const model = nativeModel("anthropic-messages", "anthropic", "claude-test");
    let request: WebSearchHttpRequest | undefined;
    const provider = new NativeSearchProvider(nativeContext(model, {apiKey: "anthropic-secret"}, true));
    const response = await provider.search({query: "question", maxResults: 5}, fakeHttp(async (value) => {
        request = value;
        return sseResponse(
            {type: "content_block_delta", delta: {type: "text_delta", text: "Claude answer"}},
            {
                type: "content_block_start",
                content_block: {
                    type: "web_search_tool_result",
                    content: [{title: "Claude source", url: "https://source.example/claude"}],
                },
            },
        );
    }));

    assert.equal(new URL(request!.url).pathname, "/v1/messages");
    assert.deepEqual(JSON.parse(request!.body ?? "{}").tools, [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 10,
    }]);
    assert.equal(response.answer, "Claude answer");
    assert.equal(response.results[0]?.url, "https://source.example/claude");
});

test("Gemini citation resolution propagates HTTP policy denials without trying another provider", async (t) => {
    for (const denyRedirect of [false, true]) {
        await t.test(denyRedirect ? "redirect destination denied" : "citation HEAD denied", async () => {
            const citationUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source";
            const destination = "https://source.example/article";
            const calls: Array<{url: string; accessType: PolicyAccessType}> = [];
            const fetched: string[] = [];
            let fallbackCalls = 0;
            const provider = new NativeSearchProvider(nativeContext(
                nativeModel("google-generative-ai", "google", "gemini-test"), {}, true,
            ));
            const http: WebSearchHttp = (request) => requestSearchHttp(request, async (url, accessType) => {
                calls.push({url, accessType});
                return nativePolicyResult(url, accessType,
                    url === (denyRedirect ? destination : citationUrl) ? PolicyResponse.DENIED : PolicyResponse.ALLOWED);
            }, {timeoutMs: 1_000, maxResponseBytes: 4_096}, async (input) => {
                const url = String(input);
                fetched.push(url);
                return url === citationUrl
                    ? new Response(null, {status: 302, headers: {Location: destination}})
                    : googleGroundingResponse(citationUrl);
            });
            await assert.rejects(searchProviders([provider, {
                id: WebSearchProviderId.DUCKDUCKGO,
                available: () => true,
                async search() {
                    fallbackCalls++;
                    return {results: []};
                },
            }], {query: "question", maxResults: 5}, http), WebSearchPolicyDeniedError);
            assert.deepEqual(calls.map(({accessType}) => accessType), denyRedirect
                ? [PolicyAccessType.HTTP_POST, PolicyAccessType.HTTP_HEAD, PolicyAccessType.HTTP_HEAD]
                : [PolicyAccessType.HTTP_POST, PolicyAccessType.HTTP_HEAD]);
            assert.equal(fetched.length, denyRedirect ? 2 : 1);
            assert.equal(fetched.includes(denyRedirect ? destination : citationUrl), false);
            assert.equal(fallbackCalls, 0);
        });
    }
});

test("Gemini citation resolution propagates cancellation from the HTTP fetch signal", async () => {
    const controller = new AbortController();
    const reason = new Error("search cancelled during citation HEAD");
    const citationUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source";
    const calls: PolicyAccessType[] = [];
    let fetches = 0;
    let fallbackCalls = 0;
    const provider = new NativeSearchProvider(nativeContext(
        nativeModel("google-generative-ai", "google", "gemini-test"), {}, true,
    ));
    const http: WebSearchHttp = (request) => requestSearchHttp(request, async (url, accessType) => {
        calls.push(accessType);
        return nativePolicyResult(url, accessType, PolicyResponse.ALLOWED);
    }, {timeoutMs: 1_000, maxResponseBytes: 4_096}, async (_input, init) => {
        fetches++;
        if (init?.method !== "HEAD") return googleGroundingResponse(citationUrl);
        controller.abort(reason);
        // Exercise Fetch's real cancellation with the transport's combined signal, without network I/O.
        return globalThis.fetch("data:text/plain,unused", init);
    });
    try {
        await assert.rejects(searchProviders([provider, {
            id: WebSearchProviderId.DUCKDUCKGO,
            available: () => true,
            async search() {
                fallbackCalls++;
                return {results: []};
            },
        }], {query: "question", maxResults: 5, signal: controller.signal}, http), (error) => error === reason);
        assert.deepEqual(calls, [PolicyAccessType.HTTP_POST, PolicyAccessType.HTTP_HEAD]);
        assert.equal(fetches, 2);
        assert.equal(fallbackCalls, 0);
    } finally {
        controller.abort();
    }
});

test("Gemini citation resolution retains the original URL on ordinary HTTP resolution failure", async () => {
    const citationUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source";
    const provider = new NativeSearchProvider(nativeContext(
        nativeModel("google-generative-ai", "google", "gemini-test"), {}, true,
    ));
    const http: WebSearchHttp = (request) => requestSearchHttp(request,
        async (url, accessType) => nativePolicyResult(url, accessType, PolicyResponse.ALLOWED),
        {timeoutMs: 1_000, maxResponseBytes: 4_096},
        async (_input, init) => init?.method === "HEAD"
            ? new Response(null, {status: 302, headers: {Location: "https://[invalid"}})
            : googleGroundingResponse(citationUrl),
    );
    const response = await searchProviders([provider], {query: "question", maxResults: 5}, http);
    assert.equal(response.results[0]?.url, citationUrl);
    assert.equal(response.answer, "Grounded answer");
});

function googleGroundingResponse(citationUrl: string): Response {
    const response = sseResponse({
        candidates: [{
            content: {parts: [{text: "Grounded answer"}]},
            groundingMetadata: {
                groundingChunks: [{web: {title: "Source", uri: citationUrl}}],
            },
        }],
    });
    return new Response(response.body, {headers: response.headers});
}

function nativePolicyResult(url: string, accessType: PolicyAccessType, status: PolicyResponse): PolicyResult {
    return PolicyResult.of({
        evaluatedUri: url,
        evaluatedAccessType: accessType,
        matchedPattern: url,
        matchedLifetime: PolicyLifetime.ONCE,
        matchedStatus: status,
        matchedReason: "citation policy decision",
        resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
    });
}

function nativeModel(api: string, provider: string, id: string): NonNullable<ExtensionContext["model"]> {
    return {
        api,
        provider,
        id,
        name: id,
        baseUrl: "https://api.provider.example/v1",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 8_192,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    } as NonNullable<ExtensionContext["model"]>;
}

function nativeContext(
    model: NonNullable<ExtensionContext["model"]>,
    auth: {apiKey?: string; baseUrl?: string; headers?: Record<string, string>},
    available: boolean,
): ExtensionContext {
    return {
        model,
        modelRegistry: {
            getAvailable: () => available ? [model] : [],
            getApiKeyAndHeaders: async () => ({ok: true, ...auth}),
        },
    } as unknown as ExtensionContext;
}

function fakeHttp(
    respond: (request: WebSearchHttpRequest) => Promise<WebSearchHttpResponse>,
): WebSearchHttp {
    return respond;
}

function sseResponse(...events: unknown[]): WebSearchHttpResponse {
    return {
        url: "https://api.provider.example/search",
        status: 200,
        statusText: "OK",
        headers: new Headers({"Content-Type": "text/event-stream"}),
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    };
}

function jwt(payload: unknown): string {
    return [
        Buffer.from(JSON.stringify({alg: "none"})).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "signature",
    ].join(".");
}
