import {REQUIRED_SERVER_VERSION, type ServerConfig} from "./ServerConfig.js";

export type ServerStatus =
    | {kind: "compatible" | "incompatible"; version: string}
    | {kind: "failure"; message: string};

const MAX_RESPONSE_BYTES = 4096;
const MAX_VERSION_LENGTH = 128;
const TIMEOUT_MS = 10_000;
// SemVer identifiers exclude whitespace, terminal controls, and arbitrary server text.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;

export async function checkServerVersion(config: ServerConfig, signal?: AbortSignal): Promise<ServerStatus> {
    const timeout = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(new DOMException("Timed out", "TimeoutError")), TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Cancel the body explicitly too: the total deadline covers reading, not only response headers.
    const cancelBody = () => { void reader?.cancel().catch(() => {}); };
    try {
        requestSignal.throwIfAborted();
        const response = await fetch(new URL("/v1/version", config.url), {
            method: "GET",
            headers: {"x-apikey": config.apiKey, Accept: "application/json"},
            redirect: "manual",
            signal: requestSignal,
        });
        reader = response.body?.getReader();
        requestSignal.addEventListener("abort", cancelBody, {once: true});
        requestSignal.throwIfAborted();
        if (response.status >= 300 && response.status < 400) {
            return {kind: "failure", message: "Server redirect refused."};
        }
        if (response.status === 401 || response.status === 403) {
            return {kind: "failure", message: "Server authentication rejected (HTTP " + response.status + ")."};
        }
        if (response.status === 429) {
            const retryAfter = response.headers.get("retry-after");
            const retry = retryAfter && /^\d{1,9}$/.test(retryAfter) ? ` Retry after ${Number(retryAfter)} seconds.` : "";
            return {kind: "failure", message: `Server rate limit reached (HTTP 429).${retry}`};
        }
        if (response.status !== 200) {
            return {kind: "failure", message: `Server returned HTTP ${response.status}.`};
        }
        if (!reader) return {kind: "failure", message: "Server returned an invalid version response."};

        const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
        let length = 0;
        while (true) {
            const chunk = await reader.read();
            requestSignal.throwIfAborted();
            if (chunk.done) break;
            if (chunk.value.byteLength > MAX_RESPONSE_BYTES - length) {
                return {kind: "failure", message: "Server version response exceeds 4 KiB."};
            }
            bytes.set(chunk.value, length);
            length += chunk.value.byteLength;
        }

        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, length)));
        } catch {
            return {kind: "failure", message: "Server returned an invalid JSON version response."};
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return {kind: "failure", message: "Server returned an invalid version response."};
        }
        const version = (value as Record<string, unknown>).version;
        if (typeof version !== "string" || version.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(version)) {
            return {kind: "failure", message: "Server returned an invalid version response."};
        }
        return {kind: version === REQUIRED_SERVER_VERSION ? "compatible" : "incompatible", version};
    } catch {
        if (requestSignal.aborted) {
            return timeout.signal.aborted && requestSignal.reason === timeout.signal.reason
                ? {kind: "failure", message: "Server connection timed out after 10 seconds."}
                : {kind: "failure", message: "Server connection cancelled."};
        }
        // Fetch/TLS errors and parser errors may contain credentials, URLs, or server-controlled text.
        return {kind: "failure", message: "Unable to connect to server."};
    } finally {
        clearTimeout(timer);
        requestSignal.removeEventListener("abort", cancelBody);
        if (reader) {
            try {
                await reader.cancel();
            } catch {
                // An already failed/aborted stream still needs its reader lock released.
            } finally {
                reader.releaseLock();
            }
        }
    }
}
