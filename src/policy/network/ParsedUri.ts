import {isIP} from "node:net";

export const UNIVERSAL_NETWORK_POLICY_PATTERN = "*";

export class ParsedUri {
    readonly raw: string
    readonly host: string
    readonly path?: string
    readonly port?: number
    readonly isValid: boolean

    constructor(uri: string) {
        let isValid = true
        uri = uri.trim()

        let stripStart = 0

        const queryIndex = uri.indexOf("?");
        const fragmentIndex = uri.indexOf("#");
        const stripEnd = Math.min(
            queryIndex === -1 ? uri.length : queryIndex,
            fragmentIndex === -1 ? uri.length : fragmentIndex,
        );

        if (uri.toLowerCase().startsWith("https://"))
            stripStart = "https://".length;
        else if (uri.toLowerCase().startsWith("http://"))
            stripStart = "http://".length;
        uri = uri.substring(stripStart, stripEnd);
        // Even in raw from we remove any super flourish info
        this.raw = uri

        const slashIndex = uri.indexOf("/");
        if (slashIndex >= 0) {
            let path = uri.substring(slashIndex);
            if (!path.endsWith("/")) path += "/"
            this.path = path
            uri = uri.substring(0, slashIndex);
        }

        let host = uri;
        let portRaw: string | undefined;
        if (uri.startsWith("[")) {
            const match = /^\[([^\]]+)](?::(.*))?$/.exec(uri);
            if (!match || isIP(match[1]!) !== 6) {
                isValid = false;
            } else {
                host = match[1]!;
                portRaw = match[2];
            }
        } else if (isIP(uri) === 0) {
            const colonIndex = uri.indexOf(":");
            if (colonIndex >= 0) {
                host = uri.slice(0, colonIndex);
                portRaw = uri.slice(colonIndex + 1);
            }
        }

        if (portRaw !== undefined) {
            if (!/^\d+$/.test(portRaw)) {
                isValid = false
            } else {
                this.port = Number(portRaw)
                if (this.port < 1 || this.port > 65_535) isValid = false
            }
        }

        isValid &&= !!host && (!host.includes(":") || isIP(host) === 6)
        this.host = host.toLowerCase()

        this.isValid = isValid
    }

    scopeHierarchy(maximumScopes = Number.MAX_SAFE_INTEGER): string[] {
        if (!this.isValid) return [this.raw]

        const limit = Math.max(1, Math.floor(maximumScopes));
        const result: string[] = []
        const addScope = (scope: string) => {
            result.push(scope);
            if (result.length > limit) result.splice(1, 1);
        };
        let acc = ""
        if (this.port) {
            acc = this.authority()
            addScope(acc);
        } else if (isIP(this.host)) {
            acc = this.host
            addScope(acc);
        } else {
            const host = this.host.split(".")
            for (let i = host.length - 1; i >= 0; i--) {
                acc = host[i] + (acc ? "." : "") + acc
                addScope(acc);
            }
        }

        if (this.path) {
            const path = this.path.split("/").filter(it => it)
            for (let i = 0; i < path.length; i++) {
                acc += "/" + path[i]
                addScope(acc);
            }
        }
        return result
    }

    fullUri(): string {
        if (!this.isValid) return this.raw

        const path = this.path ? this.path : ""
        return this.authority() + path
    }

    private authority(): string {
        const host = isIP(this.host) === 6 && this.port ? `[${this.host}]` : this.host;
        return this.port ? `${host}:${this.port}` : host;
    }

    isSubdomainOf(other: ParsedUri | string): boolean {
        other = typeof other === "string" ? new ParsedUri(other) : other

        if (!this.isValid || this.raw === UNIVERSAL_NETWORK_POLICY_PATTERN) return false
        if (other.raw === UNIVERSAL_NETWORK_POLICY_PATTERN) return true
        if (!other.isValid) return false

        // Exact match required for localhost & IP
        if (this.port !== other.port) return false
        if (this.host === "localhost" || other.host === "localhost")
            if (this.host !== other.host) return false;
        const ipInvolved = isIP(this.host) !== 0 || isIP(other.host) !== 0
        if (ipInvolved && this.host !== other.host) return false;

        // Path scopes apply only to the exact host. Host-only scopes may also
        // cover subdomains, including requests that have a path.
        if (other.path) {
            if (!this.path || this.host !== other.host) return false;
            if (!this.path.startsWith(other.path)) return false;
        }

        if (this.host !== other.host)
            if (!this.host.endsWith("." + other.host)) return false;

        return true
    }

}