import path from "node:path";
import {ParsedUri} from "./network/ParsedUri.js";
import {PolicyAccessType, resolveUri} from "./types.js";

export function policyScopeHierarchy(
    inputUri: string,
    accessType: PolicyAccessType,
    maximumScopes = Number.MAX_SAFE_INTEGER,
): string[] {
    const uri = resolveUri(accessType, inputUri);
    const limit = Math.max(1, Math.floor(maximumScopes));
    if (!isFilesystemAccess(accessType)) {
        return new ParsedUri(uri).scopeHierarchy(limit).reverse();
    }

    const scopes: string[] = [];
    let current = uri;
    while (true) {
        if (scopes.length < limit) scopes.push(current);
        else scopes[limit - 1] = current;
        const parent = path.dirname(current);
        if (parent === current) return scopes;
        current = parent;
    }
}

export function policyScopeCovers(
    accessType: PolicyAccessType,
    coveringScope: string,
    candidateScope: string,
): boolean {
    if (!isFilesystemAccess(accessType)) {
        return new ParsedUri(candidateScope).isSubdomainOf(coveringScope);
    }

    const relative = path.relative(coveringScope, candidateScope);
    return relative === ""
        || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isFilesystemAccess(accessType: PolicyAccessType): boolean {
    return accessType === PolicyAccessType.FS_READ || accessType === PolicyAccessType.FS_WRITE;
}
