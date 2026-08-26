import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {BraveSearchProvider} from "../src/web-search/providers/BraveSearchProvider.js";
import {
    DuckDuckGoSearchProvider,
    parseDuckDuckGoResults,
} from "../src/web-search/providers/DuckDuckGoSearchProvider.js";
import {SearXngSearchProvider} from "../src/web-search/providers/SearXngSearchProvider.js";
import {SerperSearchProvider} from "../src/web-search/providers/SerperSearchProvider.js";
import {TavilySearchProvider} from "../src/web-search/providers/TavilySearchProvider.js";
import {
    WebSearchProviderId,
    type WebSearchHttp,
    type WebSearchHttpRequest,
    type WebSearchHttpResponse,
    type WebSearchProvider,
} from "../src/web-search/SearchProvider.js";
import {
    searchProviders,
    WebSearchProviderAttemptStatus,
} from "../src/web-search/WebSearch.js";
import {formatWebSearchResults, WebSearchTool} from "../src/tools/web-search/WebSearchTool.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";

test("JSON providers map their APIs into one normalized response contract", async () => {
    const scenarios = [
        {
            provider: new SearXngSearchProvider({baseUrl: "https://searx.example.test"}),
            response: {results: [{title: "SearX", url: "https://one.example/a", content: "first"}]},
            assertRequest(request: WebSearchHttpRequest) {
                const url = new URL(request.url);
                assert.equal(url.pathname, "/search");
                assert.equal(url.searchParams.get("format"), "json");
            },
        },
        {
            provider: new BraveSearchProvider({apiKey: "brave-secret"}),
            response: {web: {results: [{title: "Brave", url: "https://one.example/b", description: "second"}]}},
            assertRequest(request: WebSearchHttpRequest) {
                assert.equal(new Headers(request.headers).get("x-subscription-token"), "brave-secret");
            },
        },
        {
            provider: new TavilySearchProvider({apiKey: "tavily-secret"}),
            response: {results: [{title: "Tavily", url: "https://one.example/c", content: "third"}]},
            assertRequest(request: WebSearchHttpRequest) {
                assert.equal(request.method, "POST");
                assert.equal(JSON.parse(request.body ?? "{}").max_results, 3);
            },
        },
        {
            provider: new SerperSearchProvider({apiKey: "serper-secret"}),
            response: {organic: [{title: "Serper", link: "https://one.example/d", snippet: "fourth"}]},
            assertRequest(request: WebSearchHttpRequest) {
                assert.equal(request.method, "POST");
                assert.equal(new Headers(request.headers).get("x-api-key"), "serper-secret");
            },
        },
    ] as const;

    for (const scenario of scenarios) {
        let captured: WebSearchHttpRequest | undefined;
        const http = fakeHttp(async (request) => {
            captured = request;
            return httpResponse(JSON.stringify(scenario.response));
        });
        const response = await scenario.provider.search({query: "test", maxResults: 3}, http);
        assert.equal(response.results.length, 1);
        assert.ok(response.results[0]?.title);
        assert.ok(captured);
        scenario.assertRequest(captured);
    }
});

test("DuckDuckGo HTML parsing needs no DOM dependency and resolves redirect URLs", async () => {
    const html = `
        <div class="result results_links">
            <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide&amp;rut=x">Docs &amp; Guide</a></h2>
            <a class="result__snippet">A useful <b>documentation</b> snippet.</a>
        </div>
        <div class="result results_links">
            <a class="result__a" href="https://other.example.com/page">Other result</a>
            <span class="result__snippet">Other snippet</span>
        </div>`;

    assert.deepEqual(parseDuckDuckGoResults(html), [
        {
            title: "Docs & Guide",
            url: "https://docs.example.com/guide",
            snippet: "A useful documentation snippet.",
        },
        {
            title: "Other result",
            url: "https://other.example.com/page",
            snippet: "Other snippet",
        },
    ]);

    const provider = new DuckDuckGoSearchProvider();
    const response = await provider.search({
        query: "docs",
        maxResults: 5,
        domains: ["docs.example.com"],
    }, fakeHttp(async () => httpResponse(html, "text/html")));
    assert.deepEqual(response.results.map((result) => result.url), ["https://docs.example.com/guide"]);
});

test("router hides fallback mechanics while normalizing, filtering, and deduplicating results", async () => {
    const providers: WebSearchProvider[] = [
        fakeProvider(WebSearchProviderId.SEARXNG, false, []),
        fakeProvider(WebSearchProviderId.BRAVE, true, new Error("temporary failure")),
        fakeProvider(WebSearchProviderId.DUCKDUCKGO, true, [
            {title: "First", url: "https://docs.example.com/a?utm_source=test", snippet: "  useful\ntext  "},
            {title: "Duplicate", url: "https://docs.example.com/a", snippet: "duplicate"},
            {title: "Blocked", url: "https://blocked.example.com/a", snippet: "blocked"},
            {title: "Unsafe", url: "javascript:alert(1)", snippet: "unsafe"},
        ]),
    ];
    const response = await searchProviders(providers, {
        query: "query",
        maxResults: 5,
        domains: ["docs.example.com"],
    }, fakeHttp(async () => httpResponse("")));

    assert.equal(response.provider, WebSearchProviderId.DUCKDUCKGO);
    assert.deepEqual(response.results, [{
        title: "First",
        url: "https://docs.example.com/a?utm_source=test",
        snippet: "useful text",
    }]);
    assert.deepEqual(response.attempts.map((attempt) => attempt.status), [
        WebSearchProviderAttemptStatus.UNAVAILABLE,
        WebSearchProviderAttemptStatus.ERROR,
        WebSearchProviderAttemptStatus.SUCCESS,
    ]);
});

test("the public tool has no provider argument and returns provider-neutral citations", async () => {
    const registered: ToolDefinition<any, any>[] = [];
    const runtime = {} as PilotSessionRuntimeInterface;
    new WebSearchTool(
        {
            registerTool: (tool: ToolDefinition<any, any>) => registered.push(tool),
        } as unknown as ExtensionAPI,
        () => runtime,
        new ToolDisplayRows(),
    ).register();

    const tool = registered[0]!;
    assert.equal(tool.name, "web_search");
    assert.equal(tool.renderShell, "self");
    assert.equal("provider" in tool.parameters.properties, false);
    const text = formatWebSearchResults("question", [
        {title: "Result", url: "https://example.test/source", snippet: "Evidence"},
    ]);
    assert.match(text, /untrusted external content/);
    assert.match(text, /https:\/\/example\.test\/source/);
    assert.doesNotMatch(text, /Brave/i);
});

function fakeHttp(
    respond: (request: WebSearchHttpRequest) => Promise<WebSearchHttpResponse>,
): WebSearchHttp {
    return respond;
}

function httpResponse(body: string, contentType = "application/json"): WebSearchHttpResponse {
    return {
        url: "https://provider.example.test/search",
        status: 200,
        statusText: "OK",
        headers: new Headers({"Content-Type": contentType}),
        body,
    };
}

function fakeProvider(
    id: WebSearchProviderId,
    available: boolean,
    outcome: Array<{title: string; url: string; snippet: string}> | Error,
): WebSearchProvider {
    return {
        id,
        available: () => available,
        async search() {
            if (outcome instanceof Error) throw outcome;
            return {results: outcome};
        },
    };
}

