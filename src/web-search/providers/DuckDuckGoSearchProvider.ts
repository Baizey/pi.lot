import {
    WebSearchProviderId,
    WebSearchProviderRequestError,
    type WebSearchHttp,
    type WebSearchProvider,
    type WebSearchProviderResponse,
    type WebSearchRequest,
} from "../SearchProvider.js";
import {
    matchesSearchDomainFilters,
    normalizeSearchDomainFilters,
    searchQueryWithDomains,
} from "../SearchDomainFilters.js";
import {requireSuccessfulProviderResponse} from "./ProviderResponse.js";

const SEARCH_URL = "https://html.duckduckgo.com/html/";

export class DuckDuckGoSearchProvider implements WebSearchProvider {
    readonly id = WebSearchProviderId.DUCKDUCKGO;

    available(): boolean {
        return true;
    }

    async search(request: WebSearchRequest, http: WebSearchHttp): Promise<WebSearchProviderResponse> {
        const filters = normalizeSearchDomainFilters(request.domains);
        const url = new URL(SEARCH_URL);
        url.searchParams.set("q", searchQueryWithDomains(request.query, filters));
        url.searchParams.set("kp", "-1");
        const response = await http({
            url,
            headers: {
                Accept: "text/html",
                "User-Agent": "Mozilla/5.0 (compatible; pi.lot web search)",
            },
            signal: request.signal,
        });
        requireSuccessfulProviderResponse(this.id, response);

        const parsed = parseDuckDuckGoResults(response.body);
        if (parsed.length === 0) {
            throw new WebSearchProviderRequestError(this.id, "Search backend returned no parseable results");
        }
        return {
            results: parsed
                .filter((result) => matchesSearchDomainFilters(result.url, filters))
                .slice(0, request.maxResults),
        };
    }
}

export function parseDuckDuckGoResults(html: string): WebSearchProviderResponse["results"] {
    const anchors: Array<{start: number; end: number; attributes: string; content: string}> = [];
    const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(html)) !== null) {
        const classes = htmlAttribute(match[1] ?? "", "class")?.split(/\s+/) ?? [];
        if (!classes.includes("result__a")) continue;
        anchors.push({
            start: match.index,
            end: anchorPattern.lastIndex,
            attributes: match[1] ?? "",
            content: match[2] ?? "",
        });
    }

    const results: WebSearchProviderResponse["results"] = [];
    for (let index = 0; index < anchors.length; index++) {
        const anchor = anchors[index]!;
        const href = htmlAttribute(anchor.attributes, "href");
        const url = href ? duckDuckGoResultUrl(decodeHtml(href)) : null;
        const title = htmlText(anchor.content);
        if (!url || !title) continue;
        const segment = html.slice(anchor.end, anchors[index + 1]?.start ?? html.length);
        results.push({title, url, snippet: resultSnippet(segment)});
    }
    return results;
}

function resultSnippet(segment: string): string {
    const openingTag = /<([a-z0-9]+)\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = openingTag.exec(segment)) !== null) {
        const classes = htmlAttribute(match[2] ?? "", "class")?.split(/\s+/) ?? [];
        if (!classes.includes("result__snippet")) continue;
        const tag = match[1]!;
        const close = new RegExp(`<\\/${tag}\\s*>`, "i").exec(segment.slice(openingTag.lastIndex));
        const end = close ? openingTag.lastIndex + close.index : segment.length;
        return htmlText(segment.slice(openingTag.lastIndex, end));
    }
    return "";
}

function duckDuckGoResultUrl(href: string): string | null {
    let url: URL;
    try {
        url = new URL(href, SEARCH_URL);
    } catch {
        return null;
    }
    const hostname = url.hostname.toLowerCase();
    if ((hostname === "duckduckgo.com" || hostname.endsWith(".duckduckgo.com")) && url.pathname.replace(/\/+$/, "") === "/l") {
        const destination = url.searchParams.get("uddg");
        if (!destination) return null;
        try {
            url = new URL(destination);
        } catch {
            return null;
        }
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
}

function htmlAttribute(attributes: string, name: string): string | null {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const match = pattern.exec(attributes);
    return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function htmlText(value: string): string {
    return decodeHtml(value
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
        .replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

function decodeHtml(value: string): string {
    return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hexadecimal, named) => {
        if (decimal) return safeCodePoint(Number(decimal), entity);
        if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
        const entities: Record<string, string> = {
            amp: "&",
            apos: "'",
            gt: ">",
            lt: "<",
            nbsp: " ",
            quot: "\"",
        };
        return entities[String(named).toLowerCase()] ?? entity;
    });
}

function safeCodePoint(value: number, fallback: string): string {
    try {
        return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
            ? String.fromCodePoint(value)
            : fallback;
    } catch {
        return fallback;
    }
}
