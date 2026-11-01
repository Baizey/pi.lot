import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {ExtensionAPI, ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {validateToolArguments, type JsonObject} from "@earendil-works/pi-ai";
import {Compile} from "typebox/compile";
import type {ToolCallPathPolicyEvaluator} from "../src/policy/PolicyRuntime.js";
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
    webSearch,
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

test("JSON providers preserve row defaults and their distinct envelope requirements", async (t) => {
    const scenarios = [
        {
            provider: new SearXngSearchProvider({baseUrl: "https://searx.example.test"}),
            urlField: "url", snippetField: "content", dateField: "publishedDate",
            envelope: (rows: unknown) => ({results: rows}),
        },
        {
            provider: new BraveSearchProvider({apiKey: "secret"}),
            urlField: "url", snippetField: "description", dateField: "age",
            envelope: (rows: unknown) => ({web: {results: rows}}),
        },
        {
            provider: new TavilySearchProvider({apiKey: "secret"}),
            urlField: "url", snippetField: "content", dateField: "published_date",
            envelope: (rows: unknown) => ({results: rows}),
        },
        {
            provider: new SerperSearchProvider({apiKey: "secret"}),
            urlField: "link", snippetField: "snippet", dateField: "date",
            envelope: (rows: unknown) => ({organic: rows}),
        },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.provider.id, async () => {
            const search = (envelope: unknown) => scenario.provider.search(
                {query: "test", maxResults: 1},
                fakeHttp(async () => httpResponse(JSON.stringify(envelope))),
            );
            const response = await search(scenario.envelope([
                null, [], "row", 42, {},
                {[scenario.urlField]: ""},
                {[scenario.urlField]: 123},
                {[scenario.urlField]: "https://example.test/defaults", title: 123,
                    [scenario.snippetField]: false, [scenario.dateField]: 123},
                {[scenario.urlField]: "https://example.test/full", title: "Title",
                    [scenario.snippetField]: "Snippet", [scenario.dateField]: "2026-01-01"},
                {[scenario.urlField]: "https://example.test/full", title: "",
                    [scenario.snippetField]: "", [scenario.dateField]: ""},
                {[scenario.urlField]: "not a URL"},
            ]));
            assert.deepEqual(response.results, [
                {title: "https://example.test/defaults", url: "https://example.test/defaults", snippet: ""},
                {title: "Title", url: "https://example.test/full", snippet: "Snippet", publishedAt: "2026-01-01"},
                {title: "", url: "https://example.test/full", snippet: "", publishedAt: ""},
                {title: "not a URL", url: "not a URL", snippet: ""},
            ]);
            assert.deepEqual(await search(scenario.envelope([])), {results: []});
            for (const invalid of [null, [], "envelope", scenario.envelope(null), scenario.envelope({})]) {
                await assert.rejects(search(invalid), /Search backend returned/);
            }
            for (const absent of [{}, scenario.envelope(undefined)]) {
                if (scenario.provider.id === WebSearchProviderId.BRAVE) {
                    assert.deepEqual(await search(absent), {results: []});
                } else {
                    await assert.rejects(search(absent), /Search backend returned no .*results array/);
                }
            }
            if (scenario.provider.id === WebSearchProviderId.BRAVE) {
                await assert.rejects(search({web: null}), /invalid web result envelope/);
            }
        });
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

test("DuckDuckGo parsing preserves attribute matching, snippet boundaries, and repeated-call results", () => {
    const html = `
        <a data-class="result__a" href="https://ignored.example/data-class">Ignored</a>
        <a class="result__a-extra" href="https://ignored.example/class-suffix">Ignored</a>
        <a class="result__a" data-href="https://ignored.example/data-href">Ignored</a>
        <a CLASS="other result__a" data-href="https://ignored.example/decoy" HREF='https://docs.example/first?a=1&amp;b=2#fragment'>First</a>
        <span data-class="result__snippet">Not the snippet</span>
        <span CLASS='other result__snippet'>First <b>snippet</b></span>
        <a class=result__a href=https://docs.example/second>Second</a>
        <a class=result__snippet>Second snippet</a>
        <a class='result__a' href='https://docs.example/third' href='https://ignored.example/duplicate'>Third</a>`;
    const expected = [
        {title: "First", url: "https://docs.example/first?a=1&b=2", snippet: "First snippet"},
        {title: "Second", url: "https://docs.example/second", snippet: "Second snippet"},
        {title: "Third", url: "https://docs.example/third", snippet: ""},
    ];
    assert.deepEqual(parseDuckDuckGoResults(html), expected);
    assert.deepEqual(parseDuckDuckGoResults(html), expected);
});

test("DuckDuckGo parsing preserves named and numeric entity decoding and unknown entities", () => {
    const text = "&AMP; &apos; &gt; &lt; &nbsp; &QuOt; &#65; &#x1F642; &unknown; &#1114112; &#x110000; &#xZZ; &amp";
    const decoded = "& ' > < \" A 🙂 &unknown; &#1114112; &#x110000; &#xZZ; &amp";
    assert.deepEqual(parseDuckDuckGoResults(`
        <a class="result__a" href="https://docs.example/entities">${text}</a>
        <span class="result__snippet">${text}</span>`), [
        {title: decoded, url: "https://docs.example/entities", snippet: decoded},
    ]);
});

test("DuckDuckGo parsing leaves unknown prototype-named entities literal in titles and snippets", () => {
    const text = "Literal &constructor; &CONSTRUCTOR;";
    assert.deepEqual(parseDuckDuckGoResults(`
        <a class="result__a" href="https://docs.example/unknown-entities">${text}</a>
        <span class="result__snippet">${text}</span>`), [
        {title: text, url: "https://docs.example/unknown-entities", snippet: text},
    ]);
});

test("DuckDuckGo parsing rejects unsafe direct and redirect URLs and preserves safe result order", async () => {
    const hrefs = [
        "javascript:alert(1)",
        "ftp://docs.example/file",
        "https://user:password@docs.example/private",
        "https://[invalid",
        "//duckduckgo.com/l/?rut=missing-destination",
        "//duckduckgo.com/l/?uddg=javascript%3Aalert(1)",
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fuser%3Apassword%40docs.example%2Fprivate",
        "https://ads.docs.example/excluded",
        "https://docs.example/first#fragment",
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fsub.docs.example%2Fsecond%23fragment&amp;rut=x",
        "https://docs.example/third",
    ];
    const html = hrefs.map((href, index) => `<a class="result__a" href="${href}">Result ${index}</a>`).join("\n");
    assert.deepEqual(parseDuckDuckGoResults(html).map((result) => result.url), [
        "https://ads.docs.example/excluded",
        "https://docs.example/first",
        "https://sub.docs.example/second",
        "https://docs.example/third",
    ]);
    const response = await new DuckDuckGoSearchProvider().search({
        query: "docs", maxResults: 2, domains: ["docs.example", "-ads.docs.example"],
    }, fakeHttp(async () => httpResponse(html, "text/html")));
    assert.deepEqual(response.results.map((result) => result.url), [
        "https://docs.example/first", "https://sub.docs.example/second",
    ]);
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

test("web-search query avoids llama.cpp's 2000-repetition boundary without lowering the runtime limit", async (t) => {
    const tool = new WebSearchTool({} as ExtensionAPI, () => assert.fail("schema inspection cannot execute tools"), new ToolDisplayRows())
        .toolDefinition();
    const query = tool.parameters.properties.query;
    assert.equal(Object.hasOwn(query, "maxLength"), false);
    assert.match(query.description ?? "", /2000/);
    for (const length of [2_000, 2_001]) {
        assert.doesNotThrow(() => validateToolArguments(tool, {
            type: "toolCall", id: "query-bound", name: tool.name, arguments: {query: "x".repeat(length)},
        }));
    }

    const home = mkdtempSync(path.join(os.tmpdir(), "pilot-web-search-input-"));
    t.after(() => rmSync(home, {recursive: true, force: true}));
    t.mock.method(os, "homedir", () => home);
    await assert.rejects(webSearch(
        {query: "x".repeat(2_001)},
        {} as ToolCallPathPolicyEvaluator,
        {} as ExtensionContext,
    ), /query exceeds 2000 characters/);
});

test("web-search schema declares integer result counts and the twenty-domain limit", () => {
    const tool = new WebSearchTool({} as ExtensionAPI, () => assert.fail("schema inspection cannot execute tools"), new ToolDisplayRows())
        .toolDefinition();
    const validate = (args: JsonObject) => validateToolArguments(tool, {
        type: "toolCall", id: "search-input", name: tool.name, arguments: args,
    });
    assert.deepEqual(validate({query: "docs"}), {query: "docs"});
    for (const maxResults of [1, 20]) assert.doesNotThrow(() => validate({query: "docs", maxResults}));
    for (const maxResults of [0, 21]) {
        assert.throws(() => validate({query: "docs", maxResults}), /maxResults/);
    }
    assert.equal(Compile(tool.parameters).Check({query: "docs", maxResults: 1.5}), false);
    assert.ok(Number.isInteger(validate({query: "docs", maxResults: 1.5}).maxResults),
        "Pi may coerce inputs, but execution must receive an integer");
    for (const count of [0, 20]) {
        assert.doesNotThrow(() => validate({query: "docs", domains: Array(count).fill("example.com")}));
    }
    assert.throws(() => validate({query: "docs", domains: Array(21).fill("example.com")}), /domains/);
    assert.throws(() => validate({query: "docs", domains: ["x".repeat(301)]}), /domains/);
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

