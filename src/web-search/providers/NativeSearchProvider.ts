import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttp,
    type WebSearchProvider,
    type WebSearchProviderResponse,
    type WebSearchRequest,
    type WebSearchResult,
} from "../SearchProvider.js";
import {normalizeSearchDomainFilters} from "../SearchDomainFilters.js";
import {requireSuccessfulProviderResponse} from "./ProviderResponse.js";

type NativeModel = NonNullable<ExtensionContext["model"]>;
type NativeAuth = {
    ok: true;
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
};

export class NativeSearchProvider implements WebSearchProvider {
    readonly id = WebSearchProviderId.NATIVE;

    constructor(private readonly context: ExtensionContext) {}

    available(): boolean {
        const model = this.context.model;
        if (!model || !supportsNativeSearch(model)) return false;
        try {
            return this.context.modelRegistry.getAvailable().some((available) => (
                available.provider === model.provider
                && available.id === model.id
                && available.api === model.api
            ));
        } catch {
            return false;
        }
    }

    async search(request: WebSearchRequest, http: WebSearchHttp): Promise<WebSearchProviderResponse> {
        const model = this.context.model;
        if (!model || !supportsNativeSearch(model)) {
            throw new WebSearchProviderRequestError(this.id, "The active Pi model does not support native web search");
        }
        const auth = await this.context.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new WebSearchProviderRequestError(this.id, auth.error);
        const prompt = nativeSearchPrompt(request);

        switch (model.api) {
            case "google-generative-ai":
                return searchGoogle(model, auth, prompt, request, http);
            case "openai-responses":
            case "openai-codex-responses":
                return searchOpenAI(model, auth, prompt, request, http);
            case "anthropic-messages":
                return searchAnthropic(model, auth, prompt, request, http);
            default:
                throw new WebSearchProviderRequestError(this.id, "The active Pi model does not support native web search");
        }
    }
}

function supportsNativeSearch(model: NativeModel): boolean {
    return model.api === "google-generative-ai"
        || model.api === "openai-responses"
        || model.api === "openai-codex-responses"
        || model.api === "anthropic-messages";
}

function nativeSearchPrompt(request: WebSearchRequest): string {
    const filters = normalizeSearchDomainFilters(request.domains);
    const instructions = [
        "Use native web search to answer the following query.",
        "Return a concise factual answer grounded in cited web sources.",
        `Cite at most ${request.maxResults} distinct sources.`,
    ];
    if (request.freshness) instructions.push(`Prefer sources published within the last ${request.freshness}.`);
    if (filters.include.length > 0) instructions.push(`Use only sources from: ${filters.include.join(", ")}.`);
    if (filters.exclude.length > 0) instructions.push(`Do not use sources from: ${filters.exclude.join(", ")}.`);
    return `${instructions.join("\n")}\n\nQuery: ${request.query}`;
}

async function searchGoogle(
    model: NativeModel,
    auth: NativeAuth,
    prompt: string,
    request: WebSearchRequest,
    http: WebSearchHttp,
): Promise<WebSearchProviderResponse> {
    const headers = providerHeaders(model, auth);
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    if (auth.apiKey) headers.set("x-goog-api-key", auth.apiKey);
    const baseUrl = trimTrailingSlash(auth.baseUrl || model.baseUrl);
    const response = await http({
        url: `${baseUrl}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
        method: "POST",
        headers,
        body: JSON.stringify({
            contents: [{role: "user", parts: [{text: prompt}]}],
            tools: [{google_search: {}}],
        }),
        signal: request.signal,
        sensitiveHeaders: [...headers.keys()],
    });
    requireSuccessfulProviderResponse(WebSearchProviderId.NATIVE, response, auth.apiKey ? [auth.apiKey] : []);

    let answer = "";
    let grounding: Record<string, unknown> | undefined;
    for (const event of parseSseJson(response.body)) {
        throwNativeEventError(event);
        const data = record(event.response) ?? event;
        const candidate = array(data.candidates)[0];
        const candidateRecord = record(candidate);
        const content = record(candidateRecord?.content);
        for (const part of array(content?.parts)) {
            const text = record(part)?.text;
            if (typeof text === "string") answer += text;
        }
        const metadata = record(candidateRecord?.groundingMetadata);
        if (metadata) grounding = metadata;
    }

    const chunks = array(grounding?.groundingChunks);
    const snippets = new Map<number, string>();
    for (const support of array(grounding?.groundingSupports)) {
        const value = record(support);
        const snippet = record(value?.segment)?.text;
        if (typeof snippet !== "string") continue;
        for (const index of array(value?.groundingChunkIndices)) {
            if (typeof index === "number" && !snippets.has(index)) snippets.set(index, snippet);
        }
    }
    const results: WebSearchResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
        const web = record(record(chunks[index])?.web);
        if (typeof web?.uri !== "string") continue;
        results.push({
            title: typeof web.title === "string" ? web.title : titleFromUrl(web.uri),
            url: await resolveGoogleSourceUrl(web.uri, request, http),
            snippet: snippets.get(index) ?? "",
        });
    }
    return {answer, results};
}

async function resolveGoogleSourceUrl(
    url: string,
    request: WebSearchRequest,
    http: WebSearchHttp,
): Promise<string> {
    if (!url.startsWith("https://vertexaisearch.cloud.google.com/grounding-api-redirect/")) return url;
    try {
        return (await http({url, method: "HEAD", signal: request.signal})).url;
    } catch {
        return url;
    }
}

async function searchOpenAI(
    model: NativeModel,
    auth: NativeAuth,
    prompt: string,
    request: WebSearchRequest,
    http: WebSearchHttp,
): Promise<WebSearchProviderResponse> {
    const headers = providerHeaders(model, auth);
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    if (auth.apiKey && !headers.has("authorization")) headers.set("Authorization", `Bearer ${auth.apiKey}`);

    const codex = model.api === "openai-codex-responses";
    if (codex) {
        if (!headers.has("authorization")) {
            throw new WebSearchProviderRequestError(WebSearchProviderId.NATIVE, "Pi has no Codex OAuth credential");
        }
        if (!headers.has("chatgpt-account-id")) {
            if (!auth.apiKey) {
                throw new WebSearchProviderRequestError(WebSearchProviderId.NATIVE, "Pi has no Codex account identifier");
            }
            headers.set("chatgpt-account-id", codexAccountId(auth.apiKey));
        }
        if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
    }

    const body: Record<string, unknown> = {
        model: model.id,
        input: codex
            ? [{role: "user", content: [{type: "input_text", text: prompt}]}]
            : prompt,
        tools: [{type: "web_search"}],
        include: codex
            ? ["web_search_call.action.sources"]
            : ["web_search_call.action.sources", "web_search_call.results"],
        stream: true,
        store: false,
    };
    if (model.reasoning) body.reasoning = {effort: "none"};
    if (codex) {
        body.instructions = "Answer the user's request using web search.";
        body.text = {verbosity: "low"};
        body.tool_choice = "required";
        body.parallel_tool_calls = true;
    }

    const response = await http({
        url: openAIResponsesUrl(model, auth),
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
        sensitiveHeaders: [...headers.keys()],
    });
    requireSuccessfulProviderResponse(WebSearchProviderId.NATIVE, response, auth.apiKey ? [auth.apiKey] : []);

    let answer = "";
    const results: WebSearchResult[] = [];
    for (const event of parseSseJson(response.body)) {
        throwNativeEventError(event);
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") answer += event.delta;
        if (event.type === "response.output_text.annotation.added") collectOpenAIAnnotation(event.annotation, results);
        if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
            collectOpenAIItem(event.item, results);
        }
        if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
            for (const item of array(record(event.response)?.output)) {
                collectOpenAIItem(item, results);
                if (!answer) answer += openAIItemText(item);
            }
        }
    }
    return {answer, results};
}

function openAIItemText(value: unknown): string {
    const item = record(value);
    if (item?.type !== "message") return "";
    return array(item.content)
        .map((content) => record(content)?.text)
        .filter((text): text is string => typeof text === "string")
        .join("");
}

function collectOpenAIItem(value: unknown, results: WebSearchResult[]): void {
    const item = record(value);
    if (!item) return;
    if (item.type === "web_search_call") {
        const action = record(item.action);
        for (const source of array(action?.sources)) collectSource(source, results);
        for (const result of array(action?.results)) collectSource(result, results);
        if (typeof action?.url === "string") {
            pushResult(results, {title: titleFromUrl(action.url), url: action.url, snippet: ""});
        }
        return;
    }
    if (item.type !== "message") return;
    for (const content of array(item.content)) {
        for (const annotation of array(record(content)?.annotations)) collectOpenAIAnnotation(annotation, results);
    }
}

function collectOpenAIAnnotation(value: unknown, results: WebSearchResult[]): void {
    const annotation = record(value);
    const nested = record(annotation?.url_citation) ?? record(annotation?.urlCitation);
    const url = annotation?.url ?? nested?.url;
    if (typeof url !== "string") return;
    const title = annotation?.title ?? nested?.title;
    pushResult(results, {
        title: typeof title === "string" ? title : titleFromUrl(url),
        url,
        snippet: "",
    });
}

function collectSource(value: unknown, results: WebSearchResult[]): void {
    const source = record(value);
    if (typeof source?.url !== "string") return;
    const title = source.title ?? source.display_name ?? source.name;
    const snippet = source.snippet ?? source.text;
    pushResult(results, {
        title: typeof title === "string" ? title : titleFromUrl(source.url),
        url: source.url,
        snippet: typeof snippet === "string" ? snippet : "",
    });
}

async function searchAnthropic(
    model: NativeModel,
    auth: NativeAuth,
    prompt: string,
    request: WebSearchRequest,
    http: WebSearchHttp,
): Promise<WebSearchProviderResponse> {
    const headers = providerHeaders(model, auth);
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.set("anthropic-version", "2023-06-01");
    if (auth.apiKey?.includes("sk-ant-oat")) {
        if (!headers.has("authorization")) headers.set("Authorization", `Bearer ${auth.apiKey}`);
        const beta = headers.get("anthropic-beta");
        headers.set("anthropic-beta", beta
            ? `${beta},claude-code-20250219,oauth-2025-04-20`
            : "claude-code-20250219,oauth-2025-04-20");
        if (!headers.has("user-agent")) headers.set("user-agent", "claude-cli/2.1.75");
        if (!headers.has("x-app")) headers.set("x-app", "cli");
    } else if (auth.apiKey && !headers.has("x-api-key")) {
        headers.set("x-api-key", auth.apiKey);
    }

    const response = await http({
        url: anthropicMessagesUrl(auth.baseUrl || model.baseUrl),
        method: "POST",
        headers,
        body: JSON.stringify({
            model: model.id,
            max_tokens: Math.min(Math.max(1_024, Math.floor(model.maxTokens / 3) || 4_096), 8_192),
            messages: [{role: "user", content: prompt}],
            tools: [{type: "web_search_20250305", name: "web_search", max_uses: 10}],
            stream: true,
        }),
        signal: request.signal,
        sensitiveHeaders: [...headers.keys()],
    });
    requireSuccessfulProviderResponse(WebSearchProviderId.NATIVE, response, auth.apiKey ? [auth.apiKey] : []);

    let answer = "";
    const results: WebSearchResult[] = [];
    for (const event of parseSseJson(response.body)) {
        throwNativeEventError(event);
        if (event.type === "content_block_start") {
            const block = record(event.content_block);
            if (block?.type === "text" && typeof block.text === "string") answer += block.text;
            if (block?.type === "web_search_tool_result") {
                for (const source of array(block.content)) collectAnthropicSource(source, results);
            }
        }
        if (event.type === "content_block_delta") {
            const delta = record(event.delta);
            if (delta?.type === "text_delta" && typeof delta.text === "string") answer += delta.text;
            if (delta?.type === "citations_delta") collectAnthropicSource(delta.citation, results);
        }
    }
    return {answer, results};
}

function collectAnthropicSource(value: unknown, results: WebSearchResult[]): void {
    const source = record(value);
    if (typeof source?.url !== "string") return;
    const snippet = source.cited_text ?? source.snippet;
    pushResult(results, {
        title: typeof source.title === "string" ? source.title : titleFromUrl(source.url),
        url: source.url,
        snippet: typeof snippet === "string" ? snippet : "",
        ...(typeof source.page_age === "string" ? {publishedAt: source.page_age} : {}),
    });
}

function throwNativeEventError(event: Record<string, unknown>): void {
    if (event.type !== "error" && event.type !== "response.failed" && event.error === undefined) return;
    const error = record(event.error) ?? record(record(event.response)?.error);
    const message = error?.message ?? event.message;
    throw new WebSearchProviderRequestError(
        WebSearchProviderId.NATIVE,
        typeof message === "string" ? message : "Native search backend returned an error",
    );
}

function providerHeaders(model: NativeModel, auth: NativeAuth): Headers {
    const headers = new Headers();
    appendHeaders(headers, model.headers);
    appendHeaders(headers, auth.headers);
    return headers;
}

function appendHeaders(headers: Headers, values: unknown): void {
    const source = record(values);
    if (!source) return;
    for (const [name, value] of Object.entries(source)) {
        if (typeof value === "string") headers.set(name, value);
    }
}

function openAIResponsesUrl(model: NativeModel, auth: NativeAuth): string {
    let base = auth.baseUrl || model.baseUrl;
    if (model.provider === "github-copilot" && !auth.baseUrl && auth.apiKey) {
        base = copilotBaseUrl(auth.apiKey) ?? base;
    }
    base = trimTrailingSlash(base);
    if (model.api !== "openai-codex-responses") return `${base}/responses`;
    if (base.endsWith("/codex/responses")) return base;
    return base.endsWith("/codex") ? `${base}/responses` : `${base}/codex/responses`;
}

function copilotBaseUrl(token: string): string | null {
    const endpoints = token
        .split(";")
        .filter((part) => part.startsWith("proxy-ep="))
        .map((part) => part.slice("proxy-ep=".length).toLowerCase());
    if (endpoints.length !== 1) return null;
    const labels = endpoints[0]!.split(".");
    if (
        labels.length < 4
        || labels[0] !== "proxy"
        || labels.at(-2) !== "githubcopilot"
        || labels.at(-1) !== "com"
        || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) return null;
    return `https://api.${labels.slice(1).join(".")}`;
}

function codexAccountId(token: string): string {
    const part = token.split(".")[1];
    if (!part) throw codexCredentialError();

    let payload: Record<string, unknown> | undefined;
    try {
        const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
        payload = record(JSON.parse(Buffer.from(base64, "base64url").toString("utf8")));
    } catch (error) {
        throw codexCredentialError(error);
    }
    const accountId = record(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw codexCredentialError();
    return accountId;
}

function codexCredentialError(cause?: unknown): WebSearchProviderRequestError {
    return new WebSearchProviderRequestError(
        WebSearchProviderId.NATIVE,
        "Pi's Codex credential does not contain an account identifier",
        undefined,
        cause === undefined ? {} : {cause},
    );
}

function anthropicMessagesUrl(baseUrl: string): string {
    const base = trimTrailingSlash(baseUrl);
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function parseSseJson(body: string): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = [];
    let data: string[] = [];
    const flush = () => {
        const value = data.join("\n").trim();
        data = [];
        if (!value || value === "[DONE]") return;
        try {
            const parsed = JSON.parse(value);
            const object = record(parsed);
            if (object) events.push(object);
        } catch {
            // Ignore non-JSON stream events.
        }
    };
    for (const line of body.split(/\r?\n/)) {
        if (!line) {
            flush();
        } else if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
        }
    }
    flush();
    return events;
}

function pushResult(results: WebSearchResult[], result: WebSearchResult): void {
    if (results.some((existing) => existing.url === result.url)) return;
    results.push(result);
}

function titleFromUrl(value: string): string {
    try {
        const url = new URL(value);
        return url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    } catch {
        return value;
    }
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
