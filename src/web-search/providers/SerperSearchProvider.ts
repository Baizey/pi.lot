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
    mapProviderResults,
    parseProviderJson,
    providerRecord,
    requireSuccessfulProviderResponse,
} from "./ProviderResponse.js";

const SEARCH_URL = "https://google.serper.dev/search";
const RECENCY: Record<WebSearchFreshness, string> = {
    [WebSearchFreshness.DAY]: "qdr:d",
    [WebSearchFreshness.WEEK]: "qdr:w",
    [WebSearchFreshness.MONTH]: "qdr:m",
    [WebSearchFreshness.YEAR]: "qdr:y",
};

export class SerperSearchProvider implements WebSearchProvider {
    readonly id = WebSearchProviderId.SERPER;
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
        const response = await http({
            url: SEARCH_URL,
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-API-KEY": this.apiKey,
            },
            body: JSON.stringify({
                q: searchQueryWithDomains(request.query, filters),
                num: request.domains?.length ? Math.min(20, request.maxResults + 5) : request.maxResults,
                ...(request.freshness ? {tbs: RECENCY[request.freshness]} : {}),
            }),
            signal: request.signal,
            sensitiveHeaders: ["X-API-KEY"],
        });
        requireSuccessfulProviderResponse(this.id, response, [this.apiKey]);
        const envelope = providerRecord(this.id, parseProviderJson(this.id, response), "response envelope");
        if (!Array.isArray(envelope.organic)) {
            throw new WebSearchProviderRequestError(this.id, "Search backend returned no organic results array");
        }

        return {
            results: mapProviderResults(envelope.organic, {
                url: "link",
                snippet: "snippet",
                publishedAt: "date",
            }),
        };
    }
}
