import {
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttp,
    type WebSearchProvider,
    type WebSearchProviderResponse,
    type WebSearchRequest,
} from "../SearchProvider.js";
import {normalizeSearchDomainFilters} from "../SearchDomainFilters.js";
import type {ApiKeyConfig} from "../WebSearchConfig.js";
import {
    parseProviderJson,
    providerRecord,
    requireSuccessfulProviderResponse,
} from "./ProviderResponse.js";

const SEARCH_URL = "https://api.tavily.com/search";

export class TavilySearchProvider implements WebSearchProvider {
    readonly id = WebSearchProviderId.TAVILY;
    private readonly apiKey: string;

    constructor(config: ApiKeyConfig | undefined) {
        this.apiKey = config?.apiKey ?? "";
    }

    available(): boolean {
        return this.apiKey.length > 0;
    }

    async search(request: WebSearchRequest, http: WebSearchHttp): Promise<WebSearchProviderResponse> {
        if (!this.apiKey) throw new WebSearchProviderRequestError(this.id, "Search backend credentials are unavailable");
        const domains = normalizeSearchDomainFilters(request.domains);
        const response = await http({
            url: SEARCH_URL,
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query: request.query,
                search_depth: "basic",
                max_results: request.maxResults,
                include_answer: false,
                include_raw_content: false,
                ...(request.freshness ? {time_range: request.freshness} : {}),
                ...(domains.include.length > 0 ? {include_domains: domains.include} : {}),
                ...(domains.exclude.length > 0 ? {exclude_domains: domains.exclude} : {}),
            }),
            signal: request.signal,
            sensitiveHeaders: ["Authorization"],
        });
        requireSuccessfulProviderResponse(this.id, response, [this.apiKey]);
        const envelope = providerRecord(this.id, parseProviderJson(this.id, response), "response envelope");
        if (!Array.isArray(envelope.results)) {
            throw new WebSearchProviderRequestError(this.id, "Search backend returned no results array");
        }

        const results: WebSearchProviderResponse["results"] = [];
        for (const rawResult of envelope.results) {
            if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) continue;
            const result = rawResult as Record<string, unknown>;
            if (typeof result.url !== "string" || !result.url) continue;
            results.push({
                title: typeof result.title === "string" ? result.title : result.url,
                url: result.url,
                snippet: typeof result.content === "string" ? result.content : "",
                ...(typeof result.published_date === "string" ? {publishedAt: result.published_date} : {}),
            });
        }
        return {results};
    }
}
