import {
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttpResponse,
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

function redactSecrets(value: string, secrets: string[]): string {
    let redacted = value;
    for (const secret of secrets) {
        if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
    }
    return redacted;
}
