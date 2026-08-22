export type SearchDomainFilters = {
    include: string[];
    exclude: string[];
};

export function normalizeSearchDomainFilters(values: string[] | undefined): SearchDomainFilters {
    const filters: SearchDomainFilters = {include: [], exclude: []};
    for (const rawValue of values ?? []) {
        const excluded = rawValue.trim().startsWith("-");
        const domain = normalizeDomain(rawValue);
        if (!domain) throw new Error(`Invalid web-search domain filter: ${rawValue}`);
        const target = excluded ? filters.exclude : filters.include;
        if (!target.includes(domain)) target.push(domain);
    }
    return filters;
}

export function searchQueryWithDomains(query: string, filters: SearchDomainFilters): string {
    const parts = [query];
    if (filters.include.length === 1) {
        parts.push(`site:${filters.include[0]}`);
    } else if (filters.include.length > 1) {
        parts.push(`(${filters.include.map((domain) => `site:${domain}`).join(" OR ")})`);
    }
    for (const domain of filters.exclude) parts.push(`-site:${domain}`);
    return parts.join(" ");
}

export function matchesSearchDomainFilters(url: string, filters: SearchDomainFilters): boolean {
    if (filters.include.length === 0 && filters.exclude.length === 0) return true;
    let hostname: string;
    try {
        hostname = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
    if (filters.exclude.some(matches)) return false;
    return filters.include.length === 0 || filters.include.some(matches);
}

function normalizeDomain(value: string): string | null {
    let normalized = value.trim().toLowerCase();
    if (normalized.startsWith("-")) normalized = normalized.slice(1).trim();
    if (!normalized) return null;
    try {
        normalized = new URL(normalized.includes("://") ? normalized : `https://${normalized}`).hostname;
    } catch {
        return null;
    }
    normalized = normalized.replace(/^\.+|\.+$/g, "");
    if (!normalized || normalized.includes("..")) return null;
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized)
        ? normalized
        : null;
}
