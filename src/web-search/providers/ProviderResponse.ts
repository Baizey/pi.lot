import {
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttpResponse,
    type WebSearchResult,
} from "../SearchProvider.js";

export function requireSuccessfulProviderResponse(
    provider: WebSearchProviderId,
    response: WebSearchHttpResponse,
    secrets: string[] = [],
): void {
    if (response.status >= 200 && response.status < 300) return;
    const detail = redactSecrets(response.body, secrets).replace(/\s+/g, " ").trim().slice(0, 300);
    throw new WebSearchProviderRequestError(
        provider,
        `Search backend returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
    );
}

export function parseProviderJson(provider: WebSearchProviderId, response: WebSearchHttpResponse): unknown {
    try {
        return JSON.parse(response.body) as unknown;
    } catch (error) {
        throw new WebSearchProviderRequestError(
            provider,
            "Search backend returned invalid JSON",
            response.status,
            {cause: error},
        );
    }
}

export function providerRecord(
    provider: WebSearchProviderId,
    value: unknown,
    description: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new WebSearchProviderRequestError(provider, `Search backend returned an invalid ${description}`);
    }
    return value as Record<string, unknown>;
}

export function mapProviderResults(
    rows: readonly unknown[],
    fields: {url: string; snippet: string; publishedAt: string},
): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    for (const row of rows) {
        if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
        const result = row as Record<string, unknown>;
        const url = result[fields.url];
        if (typeof url !== "string" || !url) continue;
        const snippet = result[fields.snippet];
        const publishedAt = result[fields.publishedAt];
        results.push({
            title: typeof result.title === "string" ? result.title : url,
            url,
            snippet: typeof snippet === "string" ? snippet : "",
            ...(typeof publishedAt === "string" ? {publishedAt} : {}),
        });
    }
    return results;
}

function redactSecrets(value: string, secrets: string[]): string {
    let redacted = value;
    for (const secret of secrets) {
        if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
    }
    return redacted;
}
