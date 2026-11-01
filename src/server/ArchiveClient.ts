import {createHash} from "node:crypto";
import type {ServerConfig} from "./ServerConfig.js";
import type {ServerErrorCode} from "./ServerResponses.js";
import {
    ServerHttpError, ServerHttpTransport, SERVER_CONTROL_BYTES,
    type ServerHttpErrorKind, type ServerHttpOptions, type ServerHttpPayload,
} from "./ServerHttpTransport.js";
import {
    ArchiveProtocolError, MAX_ARCHIVE_BYTES, decodeArchiveBinding, decodeArchiveBindingResponse,
    decodeArchiveId, decodeArchiveListPage, decodeArchiveListRequest, decodeArchivePublication,
    decodeArchiveReceiptOutcome, decodeArchiveSessionMetadata, sameArchiveBinding, sameArchivePublication,
    decodeArchivePreservation, decodeArchivePreservationReceiptOutcome, sameArchivePreservation,
    type Preservation, type PreservationReceipt, type PreservationReceiptOutcome,
    type Binding, type BindingResponse, type ListPage, type ListRequest, type Publication,
    type Receipt, type ReceiptOutcome, type Snapshot,
} from "./ArchiveProtocol.js";

export type ArchiveClientOptions = ServerHttpOptions;
export type ArchiveClientErrorKind = ServerHttpErrorKind;

export class ArchiveClientError extends ServerHttpError {
    /** Never discard a pending publication on failure, including a locally rejected upload. */
    readonly publicationUncertain: boolean;

    constructor(message: string, code?: ServerErrorCode, publicationUncertain = false,
        outcome: {kind: ArchiveClientErrorKind; retryAfterMs?: number} = {kind: code === undefined ? "protocol" : "server"}) {
        super(message, code, outcome);
        this.name = "ArchiveClientError";
        this.publicationUncertain = publicationUncertain;
    }
}

const JSON_BYTES = 1024 * 1024;
const CONTROL_BYTES = SERVER_CONTROL_BYTES;
type Payload = ServerHttpPayload;

export class ArchiveClient {
    private readonly transport: ServerHttpTransport;

    constructor(config: ServerConfig, options: ArchiveClientOptions = {}) {
        try { this.transport = new ServerHttpTransport(config, options, "archive"); }
        catch (error) { throw safeError(error); }
    }

    async binding(signal?: AbortSignal): Promise<BindingResponse> {
        return this.exchange("GET", "/v1/binding", {}, "application/json", CONTROL_BYTES,
            (_response, body) => decodeArchiveBindingResponse(this.transport.json(body)), signal);
    }

    async list(request: ListRequest, signal?: AbortSignal): Promise<ListPage> {
        const normalized = localRequest(() => decodeArchiveListRequest(request));
        return this.exchange("POST", "/v1/list", control(normalized), "application/json", JSON_BYTES, (_response, body) => {
            const page = decodeArchiveListPage(this.transport.json(body), normalized.include_preserved);
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
                const outcome = matchingOutcome(this.transport.json(bytes), normalized);
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
            (_response, body) => matchingOutcome(this.transport.json(body), normalized), signal);
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
                const outcome = matchingPreservationOutcome(this.transport.json(bytes), normalized);
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
            (_response, body) => matchingPreservationOutcome(this.transport.json(body), normalized), signal);
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
                const snapshot = decodeArchiveSessionMetadata(this.transport.json(decoded), false);
                if (!sameArchiveBinding(normalized, snapshot.revision.binding) || snapshot.session_id !== id
                    || snapshot.variant_id !== variant || (variant !== undefined && snapshot.metadata === undefined)
                    || this.transport.contentLength(response) !== snapshot.byte_length || body.length !== snapshot.byte_length
                    || sha256(body) !== snapshot.sha256) throw new ArchiveProtocolError();
                return {snapshot, body};
            }, signal);
    }

    private async exchange<T>(
        method: "GET" | "POST", path: string, payload: Payload, accept: string, cap: number,
        decode: (response: Response, body: Buffer) => T, signal?: AbortSignal,
    ): Promise<T> {
        try {
            return await this.transport.exchange(method, path, payload, accept, cap, (response, body) => {
                try { return decode(response, body); }
                catch (error) { throw safeError(error); }
            }, signal);
        } catch (error) { throw safeError(error); }
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

function sha256(body: Uint8Array): string {
    return createHash("sha256").update(body).digest("hex");
}

function safeError(error: unknown): ArchiveClientError {
    if (error instanceof ArchiveClientError) return error;
    if (error instanceof ServerHttpError) return new ArchiveClientError(error.message, error.code, false, error);
    const protocol = error instanceof ArchiveProtocolError;
    return new ArchiveClientError(protocol ? "Invalid archive protocol data." : "Archive server connection or response failed.",
        undefined, false, {kind: protocol ? "protocol" : "transport"});
}
