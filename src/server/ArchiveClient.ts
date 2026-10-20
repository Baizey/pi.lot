import {createHash} from "node:crypto";
import type {ServerConfig} from "./ServerConfig.js";
import {
    decodeRetryAfterMs, decodeServerError, formatServerError, isRetryableServerErrorCode, MAX_RETRY_AFTER_MS,
    type ServerErrorCode,
} from "./ServerResponses.js";
import {
    ArchiveProtocolError, MAX_ARCHIVE_BYTES, decodeArchiveBinding, decodeArchiveBindingResponse,
    decodeArchiveId, decodeArchiveListPage, decodeArchiveListRequest, decodeArchivePublication,
    decodeArchiveReceiptOutcome, decodeArchiveSessionMetadata, sameArchiveBinding, sameArchivePublication,
    decodeArchivePreservation, decodeArchivePreservationReceiptOutcome, sameArchivePreservation,
    type Preservation, type PreservationReceipt, type PreservationReceiptOutcome,
    type Binding, type BindingResponse, type ListPage, type ListRequest, type Publication,
    type Receipt, type ReceiptOutcome, type Snapshot,
} from "./ArchiveProtocol.js";

export type ArchiveClientOptions = {
    fetch?: typeof fetch;
    timeoutMs?: number;
    beforeRequest?: (method: "GET" | "POST", path: string, signal?: AbortSignal) => Promise<void>;
};

export type ArchiveClientErrorKind = "server" | "transport" | "timeout" | "cancelled" | "protocol" | "authorization" | "configuration";

export class ArchiveClientError extends Error {
    readonly code?: ServerErrorCode;
    readonly kind: ArchiveClientErrorKind;
    /** Retry the same request only; conflicts and authentication failures require separate recovery. */
    readonly retryable: boolean;
    /** Validated delta-seconds hint in milliseconds, capped at MAX_RETRY_AFTER_MS. */
    readonly retryAfterMs?: number;
    /** Never discard a pending publication on failure, including a locally rejected upload. */
    readonly publicationUncertain: boolean;

    constructor(message: string, code?: ServerErrorCode, publicationUncertain = false,
        outcome: {kind: ArchiveClientErrorKind; retryAfterMs?: number} = {kind: code === undefined ? "protocol" : "server"}) {
        super(message);
        this.name = "ArchiveClientError";
        this.code = code;
        this.kind = outcome.kind;
        this.retryable = this.kind === "transport" || this.kind === "timeout"
            || (this.kind === "server" && isRetryableServerErrorCode(code));
        const delay = outcome.retryAfterMs;
        this.retryAfterMs = this.kind === "server" && this.retryable && delay !== undefined && Number.isSafeInteger(delay) && delay >= 0
            ? Math.min(delay, MAX_RETRY_AFTER_MS) : undefined;
        this.publicationUncertain = publicationUncertain;
    }
}

const JSON_BYTES = 1024 * 1024;
const CONTROL_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type Payload = {body?: Buffer<ArrayBuffer>; headers?: Record<string, string>};

export class ArchiveClient {
    private readonly config: ServerConfig;
    private readonly fetcher: typeof fetch;
    private readonly timeoutMs: number;
    private readonly beforeRequest?: ArchiveClientOptions["beforeRequest"];

    constructor(config: ServerConfig, options: ArchiveClientOptions = {}) {
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
            throw new ArchiveClientError("Invalid archive server configuration.", undefined, false, {kind: "configuration"});
        }
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2147483647) {
            throw new ArchiveClientError("Invalid archive request timeout.", undefined, false, {kind: "configuration"});
        }
        this.beforeRequest = options.beforeRequest;
    }

    async binding(signal?: AbortSignal): Promise<BindingResponse> {
        return this.exchange("GET", "/v1/binding", {}, "application/json", CONTROL_BYTES,
            (_response, body) => decodeArchiveBindingResponse(json(body)), signal);
    }

    async list(request: ListRequest, signal?: AbortSignal): Promise<ListPage> {
        const normalized = localRequest(() => decodeArchiveListRequest(request));
        return this.exchange("POST", "/v1/list", control(normalized), "application/json", JSON_BYTES, (_response, body) => {
            const page = decodeArchiveListPage(json(body), normalized.include_preserved);
            if (!sameArchiveBinding(normalized.binding, page.binding) || page.sessions.length > normalized.limit
                || (normalized.filters?.session_id !== undefined
                    && page.sessions.some((session) => session.session_id !== normalized.filters?.session_id))) {
                throw new ArchiveProtocolError();
            }
            return page;
        }, signal);
    }

    async publish(request: Publication, body: Uint8Array, signal?: AbortSignal): Promise<Receipt> {
        try {
            const {normalized, bytes, publication} = localRequest(() => {
                const normalized = decodeArchivePublication(request);
                if (!(body instanceof Uint8Array) || body.byteLength !== normalized.byte_length) throw new ArchiveProtocolError();
                const bytes = Buffer.from(body);
                if (bytes.length !== normalized.byte_length || sha256(bytes) !== normalized.sha256) throw new ArchiveProtocolError();
                const publication = Buffer.from(JSON.stringify(normalized));
                if (publication.length > CONTROL_BYTES) throw new ArchiveProtocolError();
                return {normalized, bytes, publication};
            });
            return await this.exchange("POST", "/v1/publish", {body: bytes, headers: {
                "Content-Type": "application/octet-stream",
                "X-Pi-Publication": publication.toString("base64url"),
            }}, "application/json", CONTROL_BYTES, (_response, bytes) => {
                const outcome = matchingOutcome(json(bytes), normalized);
                if (outcome.status !== "accepted") throw new ArchiveProtocolError();
                return outcome.receipt;
            }, signal);
        } catch (error) {
            const safe = safeError(error);
            throw new ArchiveClientError(safe.message, safe.code, true, safe);
        }
    }

    async receipt(request: Publication, signal?: AbortSignal): Promise<ReceiptOutcome> {
        const normalized = localRequest(() => decodeArchivePublication(request));
        return this.exchange("POST", "/v1/receipt", control(normalized), "application/json", CONTROL_BYTES,
            (_response, body) => matchingOutcome(json(body), normalized), signal);
    }

    async preserve(request: Preservation, body?: Uint8Array, signal?: AbortSignal): Promise<PreservationReceipt> {
        try {
            const {normalized, payload} = localRequest(() => {
                const normalized = decodeArchivePreservation(request);
                let payload: Payload;
                if (normalized.mode === "uploaded") {
                    if (!(body instanceof Uint8Array) || body.byteLength !== normalized.byte_length) throw new ArchiveProtocolError();
                    const bytes = Buffer.from(body);
                    if (bytes.length !== normalized.byte_length || sha256(bytes) !== normalized.sha256) throw new ArchiveProtocolError();
                    const header = Buffer.from(JSON.stringify(normalized)).toString("base64url");
                    if (header.length > CONTROL_BYTES) throw new ArchiveProtocolError();
                    payload = {body: bytes, headers: {"Content-Type": "application/octet-stream", "X-Pi-Preservation": header}};
                } else {
                    if (body !== undefined) throw new ArchiveProtocolError();
                    payload = control(normalized);
                }
                return {normalized, payload};
            });
            return await this.exchange("POST", "/v1/preserve", payload, "application/json", CONTROL_BYTES, (_response, bytes) => {
                const outcome = matchingPreservationOutcome(json(bytes), normalized);
                if (outcome.status !== "accepted") throw new ArchiveProtocolError();
                return outcome.receipt;
            }, signal);
        } catch (error) {
            const safe = safeError(error);
            throw new ArchiveClientError(safe.message, safe.code, true, safe);
        }
    }

    async preserveReceipt(request: Preservation, signal?: AbortSignal): Promise<PreservationReceiptOutcome> {
        const normalized = localRequest(() => decodeArchivePreservation(request));
        return this.exchange("POST", "/v1/preserve-receipt", control(normalized), "application/json", CONTROL_BYTES,
            (_response, body) => matchingPreservationOutcome(json(body), normalized), signal);
    }

    async download(binding: Binding, sessionId: string, signal?: AbortSignal,
        variantId?: string): Promise<{snapshot: Snapshot; body: Buffer}> {
        const normalized = localRequest(() => decodeArchiveBinding(binding));
        const id = localRequest(() => decodeArchiveId(sessionId));
        const variant = localRequest(() => variantId === undefined ? undefined : decodeArchiveId(variantId));
        return this.exchange("POST", "/v1/download", control({binding: normalized, session_id: id, variant_id: variant}),
            "application/octet-stream", MAX_ARCHIVE_BYTES, (response, body) => {
                const header = response.headers.get("x-pi-snapshot");
                if (header === null || header.length > CONTROL_BYTES || !/^[A-Za-z0-9_-]+(?![\s\S])/u.test(header)) throw new ArchiveProtocolError();
                const decoded = Buffer.from(header, "base64url");
                if (decoded.toString("base64url") !== header) throw new ArchiveProtocolError();
                const snapshot = decodeArchiveSessionMetadata(json(decoded), false);
                if (!sameArchiveBinding(normalized, snapshot.revision.binding) || snapshot.session_id !== id
                    || snapshot.variant_id !== variant || (variant !== undefined && snapshot.metadata === undefined)
                    || contentLength(response) !== snapshot.byte_length || body.length !== snapshot.byte_length
                    || sha256(body) !== snapshot.sha256) throw new ArchiveProtocolError();
                return {snapshot, body};
            }, signal);
    }

    private async exchange<T>(
        method: "GET" | "POST", path: string, payload: Payload, accept: string, cap: number,
        decode: (response: Response, body: Buffer) => T, signal?: AbortSignal,
    ): Promise<T> {
        // Authorization may involve a human: do not start the HTTP deadline or fetch before it finishes.
        try {
            signal?.throwIfAborted();
            if (this.beforeRequest) await abortable(this.beforeRequest(method, path, signal), signal);
            signal?.throwIfAborted();
        } catch {
            throw new ArchiveClientError(signal?.aborted ? "Archive request cancelled." : "Archive request authorization failed.",
                undefined, false, {kind: signal?.aborted ? "cancelled" : "authorization"});
        }
        const timeout = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
        const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let response: Response | undefined;
        const cancelBody = () => { void reader?.cancel().catch(() => {}); };
        try {
            requestSignal.throwIfAborted();
            const headers = new Headers({"x-apikey": this.config.apiKey, Accept: accept, ...payload.headers});
            if (payload.body) headers.set("Content-Length", String(payload.body.length));
            const pendingResponse = transport(() => this.fetcher(new URL(path, this.config.url), {
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
                throw new ArchiveClientError("Archive server redirect refused.");
            }
            if (response.url && response.url !== new URL(path, this.config.url).href) throw new ArchiveProtocolError();
            if (response.headers.has("content-encoding")) throw new ArchiveProtocolError();
            const success = response.status === 200;
            const limit = success ? cap : CONTROL_BYTES;
            const declared = contentLength(response);
            if (declared !== undefined && declared > limit) throw new ArchiveClientError("Archive response exceeds the size limit.");
            if (!reader) throw new ArchiveProtocolError();
            const read = reader.read.bind(reader);
            let bytes = Buffer.allocUnsafe(Math.min(limit, 8192));
            let length = 0;
            while (true) {
                const chunk = await abortable(transport(read), requestSignal, transportFailure);
                requestSignal.throwIfAborted();
                if (chunk.done) break;
                if (chunk.value.byteLength > limit - length) throw new ArchiveClientError("Archive response exceeds the size limit.");
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
            if (declared !== undefined && declared !== length) throw new ArchiveProtocolError();
            const body = bytes.subarray(0, length);
            if (response.headers.get("content-type") !== (success ? accept : "application/json")) throw new ArchiveProtocolError();
            if (!success) {
                const error = decodeServerError(json(body), response.status);
                if (error) {
                    const retryAfter = response.headers.get("retry-after");
                    throw new ArchiveClientError(formatServerError(error, retryAfter), error.code, false,
                        {kind: "server", retryAfterMs: decodeRetryAfterMs(retryAfter)});
                }
                throw new ArchiveClientError(`Unexpected archive server response (HTTP ${response.status}).`);
            }
            const result = decode(response, body);
            requestSignal.throwIfAborted();
            return result;
        } catch (error) {
            if (requestSignal.aborted) {
                const cancelled = signal?.aborted && requestSignal.reason === signal.reason;
                throw new ArchiveClientError(cancelled ? "Archive request cancelled." : "Archive request timed out.",
                    undefined, false, {kind: cancelled ? "cancelled" : "timeout"});
            }
            throw safeError(error);
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
}

function control(value: unknown): Payload {
    return localRequest(() => {
        const body = Buffer.from(JSON.stringify(value));
        if (body.length > CONTROL_BYTES) throw new ArchiveProtocolError();
        return {body, headers: {"Content-Type": "application/json"}};
    });
}

function localRequest<T>(normalize: () => T): T {
    try { return normalize(); }
    catch { throw new ArchiveClientError("Invalid archive protocol data.", undefined, false, {kind: "protocol"}); }
}

function transport<T>(operation: () => Promise<T>): Promise<T> {
    try { return operation(); }
    catch { throw transportFailure(); }
}

function transportFailure(): ArchiveClientError {
    // Classification follows provenance, not an injected fetch/reader's error
    // class or message. Only validated HTTP envelopes may expose server codes.
    return new ArchiveClientError("Archive server connection or response failed.", undefined, false, {kind: "transport"});
}

function json(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    } catch {
        throw new ArchiveClientError("Archive server returned invalid JSON.");
    }
}

function matchingOutcome(value: unknown, request: Publication): ReceiptOutcome {
    const outcome = decodeArchiveReceiptOutcome(value);
    if (outcome.status === "accepted" && !sameArchivePublication(outcome.receipt.request, request)) throw new ArchiveProtocolError();
    return outcome;
}

function matchingPreservationOutcome(value: unknown, request: Preservation): PreservationReceiptOutcome {
    const outcome = decodeArchivePreservationReceiptOutcome(value);
    if (outcome.status === "accepted" && !sameArchivePreservation(outcome.receipt.request, request)) throw new ArchiveProtocolError();
    return outcome;
}

function contentLength(response: Response): number | undefined {
    const header = response.headers.get("content-length");
    if (header === null) return undefined;
    if (!/^(0|[1-9][0-9]{0,15})(?![\s\S])/u.test(header)) throw new ArchiveProtocolError();
    const length = Number(header);
    if (!Number.isSafeInteger(length)) throw new ArchiveProtocolError();
    return length;
}

function sha256(body: Uint8Array): string {
    return createHash("sha256").update(body).digest("hex");
}

function safeError(error: unknown): ArchiveClientError {
    if (error instanceof ArchiveClientError) return error;
    const protocol = error instanceof ArchiveProtocolError;
    return new ArchiveClientError(protocol ? "Invalid archive protocol data." : "Archive server connection or response failed.",
        undefined, false, {kind: protocol ? "protocol" : "transport"});
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal, normalizeFailure?: (error: unknown) => unknown): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener("abort", aborted);
            reject(new ArchiveClientError("Archive request cancelled.", undefined, false, {kind: "cancelled"}));
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
