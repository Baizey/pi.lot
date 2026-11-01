import type {ServerConfig} from "./ServerConfig.js";
import {
    decodeRetryAfterMs, decodeServerError, formatServerError, isRetryableServerErrorCode, MAX_RETRY_AFTER_MS,
    type ServerErrorCode,
} from "./ServerResponses.js";

export type ServerHttpOptions = {
    fetch?: typeof fetch;
    timeoutMs?: number;
    beforeRequest?: (method: "GET" | "POST", path: string, signal?: AbortSignal) => Promise<void>;
};
export type ServerHttpErrorKind = "server" | "transport" | "timeout" | "cancelled" | "protocol" | "authorization" | "configuration";
export type ServerHttpPayload = {body?: Buffer<ArrayBuffer>; headers?: Record<string, string>};
export const SERVER_CONTROL_BYTES = 64 * 1024;

export class ServerHttpError extends Error {
    readonly code?: ServerErrorCode;
    readonly kind: ServerHttpErrorKind;
    /** Retry the same request only; conflicts and authentication failures require separate recovery. */
    readonly retryable: boolean;
    /** Validated delta-seconds hint in milliseconds, capped at MAX_RETRY_AFTER_MS. */
    readonly retryAfterMs?: number;

    constructor(message: string, code?: ServerErrorCode,
        outcome: {kind: ServerHttpErrorKind; retryAfterMs?: number} = {kind: code === undefined ? "protocol" : "server"}) {
        super(message);
        this.name = "ServerHttpError";
        this.code = code;
        this.kind = outcome.kind;
        this.retryable = this.kind === "transport" || this.kind === "timeout"
            || (this.kind === "server" && isRetryableServerErrorCode(code));
        const delay = outcome.retryAfterMs;
        this.retryAfterMs = this.kind === "server" && this.retryable && delay !== undefined && Number.isSafeInteger(delay) && delay >= 0
            ? Math.min(delay, MAX_RETRY_AFTER_MS) : undefined;
    }
}

/** Owns the authenticated HTTP boundary; callers own request and response protocol semantics. */
export class ServerHttpTransport {
    private readonly config: ServerConfig;
    private readonly fetcher: typeof fetch;
    private readonly timeoutMs: number;
    private readonly beforeRequest?: ServerHttpOptions["beforeRequest"];
    private readonly title: string;

    constructor(config: ServerConfig, options: ServerHttpOptions, private readonly label: string) {
        this.title = label.charAt(0).toUpperCase() + label.slice(1);
        // The store normally validates these, but this public boundary must not allow credential-bearing URLs.
        try {
            const url = new URL(config.url);
            if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
                || url.pathname !== "/" || url.search || url.hash || url.href.length > 4096
                || !/^[\x21-\x7e]+(?![\s\S])/u.test(config.apiKey) || Buffer.byteLength(config.apiKey) > 4096) {
                throw new Error();
            }
            this.config = {url: url.origin, apiKey: config.apiKey};
        } catch {
            throw new ServerHttpError(`Invalid ${label} server configuration.`, undefined, {kind: "configuration"});
        }
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.timeoutMs = options.timeoutMs ?? 30_000;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2147483647) {
            throw new ServerHttpError(`Invalid ${label} request timeout.`, undefined, {kind: "configuration"});
        }
        this.beforeRequest = options.beforeRequest;
    }

    async exchange<T>(
        method: "GET" | "POST", path: string, payload: ServerHttpPayload, accept: string, cap: number,
        decode: (response: Response, body: Buffer) => T, signal?: AbortSignal,
    ): Promise<T> {
        // Authorization may involve a human: do not start the HTTP deadline or fetch before it finishes.
        try {
            signal?.throwIfAborted();
            if (this.beforeRequest) await abortable(this.beforeRequest(method, path, signal), signal);
            signal?.throwIfAborted();
        } catch {
            throw new ServerHttpError(signal?.aborted ? `${this.title} request cancelled.` : `${this.title} request authorization failed.`,
                undefined, {kind: signal?.aborted ? "cancelled" : "authorization"});
        }
        const timeout = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
        const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let response: Response | undefined;
        const cancelBody = () => { void reader?.cancel().catch(() => {}); };
        const transportFailure = () => this.transportFailure();
        try {
            requestSignal.throwIfAborted();
            const headers = new Headers({"x-apikey": this.config.apiKey, Accept: accept, ...payload.headers});
            if (payload.body) headers.set("Content-Length", String(payload.body.length));
            const pendingResponse = this.transport(() => this.fetcher(new URL(path, this.config.url), {
                method, headers, body: payload.body, redirect: "manual", signal: requestSignal,
            }));
            // Even a custom fetch that ignores abort must not leave a late response body running.
            void pendingResponse.then((late) => {
                if (requestSignal.aborted && late !== response) void late.body?.cancel().catch(() => {});
            }, () => {});
            response = await abortable(pendingResponse, requestSignal, transportFailure);
            reader = response.body?.getReader();
            requestSignal.addEventListener("abort", cancelBody, {once: true});
            requestSignal.throwIfAborted();
            if (response.redirected || (response.status >= 300 && response.status < 400)) {
                throw new ServerHttpError(`${this.title} server redirect refused.`);
            }
            if (response.url && response.url !== new URL(path, this.config.url).href) throw this.protocolFailure();
            if (response.headers.has("content-encoding")) throw this.protocolFailure();
            const success = response.status === 200;
            const limit = success ? cap : SERVER_CONTROL_BYTES;
            const declared = this.contentLength(response);
            if (declared !== undefined && declared > limit) throw new ServerHttpError(`${this.title} response exceeds the size limit.`);
            if (!reader) throw this.protocolFailure();
            const read = reader.read.bind(reader);
            let bytes = Buffer.allocUnsafe(Math.min(limit, 8192));
            let length = 0;
            while (true) {
                const chunk = await abortable(this.transport(read), requestSignal, transportFailure);
                requestSignal.throwIfAborted();
                if (chunk.done) break;
                if (chunk.value.byteLength > limit - length) throw new ServerHttpError(`${this.title} response exceeds the size limit.`);
                const required = length + chunk.value.byteLength;
                if (required > bytes.length) {
                    const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(required, bytes.length * 2)));
                    bytes.copy(grown, 0, 0, length);
                    bytes = grown;
                }
                // Copy producer-owned chunks without retaining unbounded per-chunk bookkeeping.
                bytes.set(chunk.value, length);
                length = required;
            }
            if (declared !== undefined && declared !== length) throw this.protocolFailure();
            const body = bytes.subarray(0, length);
            if (response.headers.get("content-type") !== (success ? accept : "application/json")) throw this.protocolFailure();
            if (!success) {
                const error = decodeServerError(this.json(body), response.status);
                if (error) {
                    const retryAfter = response.headers.get("retry-after");
                    throw new ServerHttpError(formatServerError(error, retryAfter), error.code,
                        {kind: "server", retryAfterMs: decodeRetryAfterMs(retryAfter)});
                }
                throw new ServerHttpError(`Unexpected ${this.label} server response (HTTP ${response.status}).`);
            }
            const result = decode(response, body);
            requestSignal.throwIfAborted();
            return result;
        } catch (error) {
            if (requestSignal.aborted) {
                const cancelled = signal?.aborted && requestSignal.reason === signal.reason;
                throw new ServerHttpError(cancelled ? `${this.title} request cancelled.` : `${this.title} request timed out.`,
                    undefined, {kind: cancelled ? "cancelled" : "timeout"});
            }
            throw error instanceof ServerHttpError ? error : this.transportFailure();
        } finally {
            clearTimeout(timer);
            requestSignal.removeEventListener("abort", cancelBody);
            if (reader) {
                // A hostile/custom stream's cancel promise may never settle. Initiate cancellation and
                // release ownership synchronously, without extending the finite request deadline.
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        }
    }

    json(bytes: Uint8Array): unknown {
        try {
            return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
        } catch {
            throw new ServerHttpError(`${this.title} server returned invalid JSON.`);
        }
    }

    contentLength(response: Response): number | undefined {
        const header = response.headers.get("content-length");
        if (header === null) return undefined;
        if (!/^(0|[1-9][0-9]{0,15})(?![\s\S])/u.test(header)) throw this.protocolFailure();
        const length = Number(header);
        if (!Number.isSafeInteger(length)) throw this.protocolFailure();
        return length;
    }

    private transport<T>(operation: () => Promise<T>): Promise<T> {
        try { return operation(); }
        catch { throw this.transportFailure(); }
    }

    private transportFailure(): ServerHttpError {
        // Classification follows provenance, not an injected fetch/reader's error
        // class or message. Only validated HTTP envelopes may expose server codes.
        return new ServerHttpError(`${this.title} server connection or response failed.`, undefined, {kind: "transport"});
    }

    private protocolFailure(): ServerHttpError {
        return new ServerHttpError(`Invalid ${this.label} protocol data.`);
    }
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal, normalizeFailure?: (error: unknown) => unknown): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener("abort", aborted);
            reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, {once: true});
        void pending.then((value) => {
            signal.removeEventListener("abort", aborted);
            resolve(value);
        }, (error: unknown) => {
            signal.removeEventListener("abort", aborted);
            reject(normalizeFailure ? normalizeFailure(error) : error);
        });
        if (signal.aborted) aborted();
    });
}
