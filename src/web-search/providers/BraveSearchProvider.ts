import {
    WebSearchFreshness,
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttp,
    type WebSearchProvider,
    type WebSearchProviderResponse,
    type WebSearchRequest,
} from "../SearchProvider.js";
import {normalizeSearchDomainFilters, searchQueryWithDomains} from "../SearchDomainFilters.js";
import type {ApiKeyConfig} from "../WebSearchConfig.js";
import {
    parseProviderJson,
    providerRecord,
    requireSuccessfulProviderResponse,
} from "./ProviderResponse.js";

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const FRESHNESS: Record<WebSearchFreshness, string> = {
    [WebSearchFreshness.DAY]: "pd",
    [WebSearchFreshness.WEEK]: "pw",
    [WebSearchFreshness.MONTH]: "pm",
    [WebSearchFreshness.YEAR]: "py",
};

export class BraveSearchProvider implements WebSearchProvider {
    readonly id = WebSearchProviderId.BRAVE;
    private readonly apiKey: string;

    constructor(config: ApiKeyConfig | undefined) {
        this.apiKey = config?.apiKey ?? "";
    }

    available(): boolean {
        return this.apiKey.length > 0;
    }

    async search(request: WebSearchRequest, http: WebSearchHttp): Promise<WebSearchProviderResponse> {
        if (!this.apiKey) throw new WebSearchProviderRequestError(this.id, "Search backend credentials are unavailable");
        const filters = normalizeSearchDomainFilters(request.domains);
        const url = new URL(SEARCH_URL);
        url.searchParams.set("q", searchQueryWithDomains(request.query, filters));
        url.searchParams.set("count", String(request.domains?.length ? 20 : request.maxResults));
        url.searchParams.set("safesearch", "moderate");
        if (request.freshness) url.searchParams.set("freshness", FRESHNESS[request.freshness]);

        const response = await http({
            url,
            headers: {
                Accept: "application/json",
                "X-Subscription-Token": this.apiKey,
            },
            signal: request.signal,
            sensitiveHeaders: ["X-Subscription-Token"],
        });
        requireSuccessfulProviderResponse(this.id, response, [this.apiKey]);
        const envelope = providerRecord(this.id, parseProviderJson(this.id, response), "response envelope");
        const web = envelope.web === undefined
            ? {}
            : providerRecord(this.id, envelope.web, "web result envelope");
        if (web.results !== undefined && !Array.isArray(web.results)) {
            throw new WebSearchProviderRequestError(this.id, "Search backend returned an invalid results array");
        }

        const results: WebSearchProviderResponse["results"] = [];
        for (const rawResult of web.results ?? []) {
            if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) continue;
            const result = rawResult as Record<string, unknown>;
            if (typeof result.url !== "string" || !result.url) continue;
            results.push({
                title: typeof result.title === "string" ? result.title : result.url,
                url: result.url,
                snippet: typeof result.description === "string" ? result.description : "",
                ...(typeof result.age === "string" ? {publishedAt: result.age} : {}),
            });
        }
        return {results};
    }
}
