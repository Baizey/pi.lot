import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {ToolCallPathPolicyEvaluator} from "../policy/PolicyRuntime.js";
import {requestSearchHttp, WebSearchPolicyDeniedError} from "./SearchHttp.js";
import {matchesSearchDomainFilters, normalizeSearchDomainFilters} from "./SearchDomainFilters.js";
import {
    WebSearchFreshness,
    type WebSearchHttp,
    type WebSearchProvider,
    type WebSearchProviderId,
    type WebSearchRequest,
    type WebSearchResult,
} from "./SearchProvider.js";
import {createSearchProviders} from "./SearchProviders.js";
import {loadWebSearchConfig} from "./WebSearchConfig.js";

export type WebSearchInput = {
    query: string;
    maxResults?: number;
    freshness?: WebSearchFreshness;
    domains?: string[];
};

export enum WebSearchProviderAttemptStatus {
    UNAVAILABLE = "unavailable",
    EMPTY = "empty",
    ERROR = "error",
    SUCCESS = "success",
}

export type WebSearchProviderAttempt = {
    provider: WebSearchProviderId;
    status: WebSearchProviderAttemptStatus;
    error?: string;
};

export type WebSearchResponse = {
    results: WebSearchResult[];
    provider: WebSearchProviderId;
    attempts: WebSearchProviderAttempt[];
    answer?: string;
};

export class WebSearchExhaustedError extends Error {
    constructor(readonly attempts: WebSearchProviderAttempt[]) {
        super("Web search failed across the configured backends");
        this.name = "WebSearchExhaustedError";
    }
}

export async function webSearch(
    input: WebSearchInput,
    policy: ToolCallPathPolicyEvaluator,
    context: ExtensionContext,
    signal?: AbortSignal,
): Promise<WebSearchResponse> {
    const config = loadWebSearchConfig();
    const request = normalizeRequest(input, signal);
    const http: WebSearchHttp = (httpRequest) => requestSearchHttp(httpRequest, policy, {
        timeoutMs: config.requestTimeoutMs,
        maxResponseBytes: config.maxResponseBytes,
    });
    return searchProviders(createSearchProviders(config, context), request, http);
}

export async function searchProviders(
    providers: readonly WebSearchProvider[],
    request: WebSearchRequest,
    http: WebSearchHttp,
): Promise<WebSearchResponse> {
    const attempts: WebSearchProviderAttempt[] = [];
    for (const provider of providers) {
        if (request.signal?.aborted) throw abortError(request.signal);
        if (!provider.available()) {
            attempts.push({provider: provider.id, status: WebSearchProviderAttemptStatus.UNAVAILABLE});
            continue;
        }

        try {
            const response = await provider.search(request, http);
            const results = normalizeResults(response.results, request);
            const answer = normalizedAnswer(response.answer ?? "", 20_000);
            if (results.length === 0 && (!answer || request.domains?.length)) {
                attempts.push({provider: provider.id, status: WebSearchProviderAttemptStatus.EMPTY});
                continue;
            }
            attempts.push({provider: provider.id, status: WebSearchProviderAttemptStatus.SUCCESS});
            return {
                results,
                provider: provider.id,
                attempts,
                ...(answer ? {answer} : {}),
            };
        } catch (error) {
            if (request.signal?.aborted) throw abortError(request.signal);
            if (error instanceof WebSearchPolicyDeniedError) throw error;
            attempts.push({
                provider: provider.id,
                status: WebSearchProviderAttemptStatus.ERROR,
                error: errorMessage(error),
            });
        }
    }
    throw new WebSearchExhaustedError(attempts);
}

function normalizeRequest(input: WebSearchInput, signal?: AbortSignal): WebSearchRequest {
    if (typeof input.query !== "string" || !input.query.trim()) throw new Error("Web-search query is required");
    if (input.query.length > 2_000) throw new Error("Web-search query exceeds 2000 characters");
    const maxResults = input.maxResults ?? 5;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
        throw new Error("Web-search maxResults must be an integer between 1 and 20");
    }
    if (
        input.freshness !== undefined
        && !Object.values(WebSearchFreshness).includes(input.freshness)
    ) {
        throw new Error(`Unsupported web-search freshness: ${String(input.freshness)}`);
    }
    if (input.domains !== undefined && (!Array.isArray(input.domains) || input.domains.length > 20)) {
        throw new Error("Web-search domains must contain at most 20 entries");
    }
    const domains = input.domains?.map((domain) => {
        if (typeof domain !== "string" || !domain.trim() || domain.length > 300) {
            throw new Error("Each web-search domain must be a non-empty string of at most 300 characters");
        }
        return domain.trim();
    });
    normalizeSearchDomainFilters(domains);
    return {
        query: input.query.trim(),
        maxResults,
        freshness: input.freshness,
        domains,
        signal,
    };
}

function normalizeResults(results: WebSearchResult[], request: WebSearchRequest): WebSearchResult[] {
    const filters = normalizeSearchDomainFilters(request.domains);
    const normalized: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const result of results) {
        const url = normalizedResultUrl(result.url);
        if (!url || !matchesSearchDomainFilters(url, filters)) continue;
        const key = canonicalResultKey(url);
        if (seen.has(key)) continue;
        seen.add(key);
        const title = normalizedText(result.title, 300) || new URL(url).hostname;
        const snippet = normalizedText(result.snippet, 2_000);
        const publishedAt = normalizedText(result.publishedAt ?? "", 120);
        normalized.push({
            title,
            url,
            snippet,
            ...(publishedAt ? {publishedAt} : {}),
        });
        if (normalized.length >= request.maxResults) break;
    }
    return normalized;
}

function normalizedResultUrl(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
}

function canonicalResultKey(value: string): string {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) {
        const lower = name.toLowerCase();
        if (lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid") {
            url.searchParams.delete(name);
        }
    }
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
}

function normalizedAnswer(value: string, maximum: number): string {
    return value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, maximum);
}

function normalizedText(value: string, maximum: number): string {
    return value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum);
}

function abortError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error(String(signal.reason ?? "Web search was aborted"));
    error.name = "AbortError";
    return error;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
