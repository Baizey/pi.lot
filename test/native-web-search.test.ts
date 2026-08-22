import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {NativeSearchProvider} from "../src/web-search/providers/NativeSearchProvider.js";
import type {
    WebSearchHttp,
    WebSearchHttpRequest,
    WebSearchHttpResponse,
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
            {type: "response.output_text.delta", delta: "Copilot answer"},
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
    assert.equal(response.answer, "Copilot answer");
    assert.equal(response.results[0]?.url, "https://source.example/copilot");
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
