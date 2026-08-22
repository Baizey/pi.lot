import type {ToolCallPathPolicyEvaluator} from "../policy/PolicyRuntime.js";
import {PolicyAccessType, PolicyResponse} from "../policy/types.js";
import type {WebSearchHttpRequest, WebSearchHttpResponse} from "./SearchProvider.js";

const MAX_REDIRECTS = 5;
const SENSITIVE_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "x-api-key",
    "x-subscription-token",
]);

export class WebSearchPolicyDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebSearchPolicyDeniedError";
    }
}

export async function requestSearchHttp(
    request: WebSearchHttpRequest,
    policy: ToolCallPathPolicyEvaluator,
    limits: {timeoutMs: number; maxResponseBytes: number},
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<WebSearchHttpResponse> {
    let url = validatedUrl(request.url);
    let method = (request.method ?? "GET").toUpperCase();
    let headers = new Headers(request.headers);
    let body = request.body;
    const sensitiveHeaders = new Set([
        ...SENSITIVE_HEADERS,
        ...(request.sensitiveHeaders ?? []).map((name) => name.toLowerCase()),
    ]);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const policyResult = await policy(url.toString(), httpAccessType(method), request.signal);
        if (policyResult.matchedStatus !== PolicyResponse.ALLOWED) {
            throw new WebSearchPolicyDeniedError(policyResult.toDenyMessage());
        }

        const timeoutSignal = AbortSignal.timeout(limits.timeoutMs);
        const signal = request.signal
            ? AbortSignal.any([request.signal, timeoutSignal])
            : timeoutSignal;
        const response = await translateTimeout(
            () => fetchImplementation(url, {method, headers, body, redirect: "manual", signal}),
            request.signal,
            timeoutSignal,
            limits.timeoutMs,
        );
        const location = response.headers.get("location");
        if (!isRedirect(response.status) || !location) {
            return {
                url: url.toString(),
                status: response.status,
                statusText: response.statusText,
                headers: new Headers(response.headers),
                body: await translateTimeout(
                    () => readBoundedBody(response, limits.maxResponseBytes),
                    request.signal,
                    timeoutSignal,
                    limits.timeoutMs,
                ),
            };
        }
        if (redirects === MAX_REDIRECTS) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Web-search HTTP request exceeded ${MAX_REDIRECTS} redirects`);
        }

        const destination = validatedUrl(new URL(location, url));
        if (destination.origin !== url.origin) {
            headers = headersWithout(headers, sensitiveHeaders);
        }
        if (redirectChangesToGet(response.status, method)) {
            method = "GET";
            body = undefined;
            headers.delete("content-length");
            headers.delete("content-type");
        }
        await response.body?.cancel().catch(() => undefined);
        url = destination;
    }

    throw new Error("Web-search HTTP redirect handling failed");
}

async function translateTimeout<T>(
    operation: () => Promise<T>,
    requestSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
    timeoutMs: number,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!requestSignal?.aborted && timeoutSignal.aborted) {
            throw new Error(`Web-search HTTP request timed out after ${timeoutMs}ms`, {cause: error});
        }
        throw error;
    }
}

function validatedUrl(value: string | URL): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch (error) {
        throw new Error("Web-search HTTP request URL is invalid", {cause: error});
    }
    if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || url.username !== ""
        || url.password !== ""
        || url.hash !== ""
    ) {
        throw new Error("Web-search HTTP requests require an HTTP(S) URL without credentials or fragments");
    }
    return url;
}

function isRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectChangesToGet(status: number, method: string): boolean {
    return status === 303 || ((status === 301 || status === 302) && method === "POST");
}

function headersWithout(headers: Headers, removed: ReadonlySet<string>): Headers {
    const filtered = new Headers(headers);
    for (const name of [...filtered.keys()]) {
        if (removed.has(name.toLowerCase())) filtered.delete(name);
    }
    return filtered;
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximum) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Web-search HTTP response exceeds ${maximum} bytes`);
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximum) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`Web-search HTTP response exceeds ${maximum} bytes`);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString("utf8");
}

function httpAccessType(method: string): PolicyAccessType {
    switch (method) {
        case "GET": return PolicyAccessType.HTTP_GET;
        case "POST": return PolicyAccessType.HTTP_POST;
        case "PUT": return PolicyAccessType.HTTP_PUT;
        case "DELETE": return PolicyAccessType.HTTP_DELETE;
        case "PATCH": return PolicyAccessType.HTTP_PATCH;
        case "HEAD": return PolicyAccessType.HTTP_HEAD;
        case "OPTIONS": return PolicyAccessType.HTTP_OPTIONS;
        default: return PolicyAccessType.HTTP_ACCESS;
    }
}
