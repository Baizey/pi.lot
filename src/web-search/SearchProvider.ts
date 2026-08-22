export enum WebSearchProviderId {
    NATIVE = "native",
    SEARXNG = "searxng",
    BRAVE = "brave",
    TAVILY = "tavily",
    SERPER = "serper",
    DUCKDUCKGO = "duckduckgo",
}

export enum WebSearchFreshness {
    DAY = "day",
    WEEK = "week",
    MONTH = "month",
    YEAR = "year",
}

export type WebSearchRequest = {
    query: string;
    maxResults: number;
    freshness?: WebSearchFreshness;
    domains?: string[];
    signal?: AbortSignal;
};

export type WebSearchResult = {
    title: string;
    url: string;
    snippet: string;
    publishedAt?: string;
};

export type WebSearchProviderResponse = {
    results: WebSearchResult[];
    answer?: string;
};

export type WebSearchHttpRequest = {
    url: string | URL;
    method?: string;
    headers?: HeadersInit;
    body?: string;
    signal?: AbortSignal;
    sensitiveHeaders?: string[];
};

export type WebSearchHttpResponse = {
    url: string;
    status: number;
    statusText: string;
    headers: Headers;
    body: string;
};

export type WebSearchHttp = (request: WebSearchHttpRequest) => Promise<WebSearchHttpResponse>;

export interface WebSearchProvider {
    readonly id: WebSearchProviderId;
    available(): boolean;
    search(request: WebSearchRequest, http: WebSearchHttp): Promise<WebSearchProviderResponse>;
}

export class WebSearchProviderRequestError extends Error {
    constructor(
        readonly provider: WebSearchProviderId,
        message: string,
        readonly status?: number,
        options: ErrorOptions = {},
    ) {
        super(message, options);
        this.name = "WebSearchProviderRequestError";
    }
}
