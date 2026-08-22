import {
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttp,
    type WebSearchProvider,
    type WebSearchProviderResponse,
    type WebSearchRequest,
} from "../SearchProvider.js";
import {normalizeSearchDomainFilters, searchQueryWithDomains} from "../SearchDomainFilters.js";
import type {SearXngConfig} from "../WebSearchConfig.js";
import {
    parseProviderJson,
    providerRecord,
    requireSuccessfulProviderResponse,
} from "./ProviderResponse.js";

export class SearXngSearchProvider implements WebSearchProvider {
    readonly id = WebSearchProviderId.SEARXNG;
    private readonly configuredBaseUrl: string | undefined;

    constructor(config: SearXngConfig | undefined) {
        this.configuredBaseUrl = config?.baseUrl;
    }

    available(): boolean {
        return Boolean(this.configuredBaseUrl?.trim());
    }

    async search(request: WebSearchRequest, http: WebSearchHttp): Promise<WebSearchProviderResponse> {
        const url = this.searchUrl(request);
        const response = await http({
            url,
            headers: {Accept: "application/json"},
            signal: request.signal,
        });
        requireSuccessfulProviderResponse(this.id, response);
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
                ...(typeof result.publishedDate === "string" ? {publishedAt: result.publishedDate} : {}),
            });
        }
        return {results};
    }

    private searchUrl(request: WebSearchRequest): URL {
        const baseUrl = this.configuredBaseUrl?.trim();
        if (!baseUrl) throw new WebSearchProviderRequestError(this.id, "Search backend is not configured");
        let url: URL;
        try {
            url = new URL(baseUrl);
        } catch (error) {
            throw new WebSearchProviderRequestError(this.id, "Configured SearXNG URL is invalid", undefined, {cause: error});
        }
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
            throw new WebSearchProviderRequestError(this.id, "Configured SearXNG URL must be HTTP(S) without credentials");
        }
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
        url.search = "";
        url.hash = "";
        url.searchParams.set("q", searchQueryWithDomains(request.query, normalizeSearchDomainFilters(request.domains)));
        url.searchParams.set("format", "json");
        url.searchParams.set("safesearch", "1");
        if (request.freshness) url.searchParams.set("time_range", request.freshness);
        return url;
    }
}
