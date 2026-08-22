import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {WebSearchProviderId} from "./SearchProvider.js";

const CONFIG_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PROVIDERS = [
    WebSearchProviderId.SEARXNG,
    WebSearchProviderId.BRAVE,
    WebSearchProviderId.TAVILY,
    WebSearchProviderId.SERPER,
    WebSearchProviderId.NATIVE,
    WebSearchProviderId.DUCKDUCKGO,
] as const;

export type SearXngConfig = {
    baseUrl: string;
};

export type ApiKeyConfig = {
    apiKey: string;
};

export type WebSearchConfig = {
    providers: WebSearchProviderId[];
    requestTimeoutMs: number;
    maxResponseBytes: number;
    searxng?: SearXngConfig;
    brave?: ApiKeyConfig;
    tavily?: ApiKeyConfig;
    serper?: ApiKeyConfig;
};

export function loadWebSearchConfig(file = defaultWebSearchConfigFile()): WebSearchConfig {
    let contents: string;
    try {
        contents = fs.readFileSync(file, "utf8");
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return defaultWebSearchConfig();
        throw new Error(`Unable to read web-search configuration from ${file}.`, {cause: error});
    }

    try {
        return parseConfig(JSON.parse(contents));
    } catch (error) {
        throw new Error(`Invalid web-search configuration in ${file}.`, {cause: error});
    }
}

export function defaultWebSearchConfigFile(): string {
    return path.join(os.homedir(), ".pilot", "web-search.json");
}

export function defaultWebSearchConfig(): WebSearchConfig {
    return {
        providers: [...DEFAULT_PROVIDERS],
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    };
}

function parseConfig(value: unknown): WebSearchConfig {
    const root = record(value, "configuration root");
    exactKeys(
        root,
        ["version", "providers", "requestTimeoutMs", "maxResponseBytes", "searxng", "brave", "tavily", "serper"],
        "configuration root",
    );
    if (root.version !== CONFIG_VERSION) {
        throw new Error(`unsupported web-search configuration version: ${String(root.version)}`);
    }

    const defaults = defaultWebSearchConfig();
    return {
        providers: parseProviders(root.providers),
        requestTimeoutMs: boundedInteger(
            root.requestTimeoutMs,
            "requestTimeoutMs",
            1_000,
            MAX_REQUEST_TIMEOUT_MS,
            defaults.requestTimeoutMs,
        ),
        maxResponseBytes: boundedInteger(
            root.maxResponseBytes,
            "maxResponseBytes",
            1_024,
            MAX_RESPONSE_BYTES,
            defaults.maxResponseBytes,
        ),
        ...(root.searxng === undefined ? {} : {searxng: parseSearXng(root.searxng)}),
        ...(root.brave === undefined ? {} : {brave: parseApiKey(root.brave, "brave")}),
        ...(root.tavily === undefined ? {} : {tavily: parseApiKey(root.tavily, "tavily")}),
        ...(root.serper === undefined ? {} : {serper: parseApiKey(root.serper, "serper")}),
    };
}

function parseProviders(value: unknown): WebSearchProviderId[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error("providers must be a non-empty array");
    const supported = new Set<string>(DEFAULT_PROVIDERS);
    const providers: WebSearchProviderId[] = [];
    for (const [index, rawProvider] of value.entries()) {
        if (typeof rawProvider !== "string" || !supported.has(rawProvider)) {
            throw new Error(`providers[${index}] is not supported: ${String(rawProvider)}`);
        }
        const provider = rawProvider as WebSearchProviderId;
        if (providers.includes(provider)) throw new Error(`providers contains a duplicate: ${provider}`);
        providers.push(provider);
    }
    return providers;
}

function parseSearXng(value: unknown): SearXngConfig {
    const raw = record(value, "searxng");
    exactKeys(raw, ["baseUrl"], "searxng");
    if (typeof raw.baseUrl !== "string") throw new Error("searxng.baseUrl must be a string");
    return {baseUrl: normalizedHttpUrl(raw.baseUrl, "searxng.baseUrl")};
}

function parseApiKey(value: unknown, provider: string): ApiKeyConfig {
    const raw = record(value, provider);
    exactKeys(raw, ["apiKey"], provider);
    if (typeof raw.apiKey !== "string" || !raw.apiKey.trim()) {
        throw new Error(`${provider}.apiKey must be a non-empty string`);
    }
    return {apiKey: raw.apiKey.trim()};
}

function normalizedHttpUrl(value: string, description: string): string {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch (error) {
        throw new Error(`${description} must be an absolute HTTP(S) URL`, {cause: error});
    }
    if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || url.username !== ""
        || url.password !== ""
        || url.search !== ""
        || url.hash !== ""
    ) {
        throw new Error(`${description} must be an absolute HTTP(S) URL without credentials, query, or fragment`);
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
}

function boundedInteger(
    value: unknown,
    description: string,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new Error(`${description} must be an integer between ${minimum} and ${maximum}`);
    }
    return value as number;
}

function record(value: unknown, description: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${description} must be an object`);
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], description: string): void {
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unexpected.length > 0) {
        throw new Error(`${description} contains unsupported keys: ${unexpected.join(", ")}`);
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
