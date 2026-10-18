const MAX_VERSION_LENGTH = 128;
// SemVer identifiers exclude whitespace, terminal controls, and arbitrary server text.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;

export type ServerVersionResponse = {version: string};

export function decodeVersionResponse(value: unknown): ServerVersionResponse | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("version" in value)) return undefined;
    const version = value.version;
    if (typeof version !== "string" || version.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(version)) return undefined;
    return {version};
}

// pi.server protocol.rs ErrorCode and api.rs error_response define this wire contract.
const ERROR_DEFINITIONS = {
    invalid_request: {status: 400, retryable: false, message: "Server rejected the request", action: "Check the request format and identifiers."},
    integrity: {status: 400, retryable: false, message: "Server rejected the content integrity check", action: "Check the content length and SHA-256 digest before retrying."},
    unauthorized: {status: 401, retryable: false, message: "Server API key is missing, invalid, or revoked", action: "Check the configured API key."},
    rate_limited: {status: 429, retryable: true, message: "Server rate limit reached", action: "A temporary IP ban or authentication tracker limit may apply. Wait before retrying."},
    method_not_allowed: {status: 405, retryable: false, message: "Server does not allow this HTTP method", action: "Check the client endpoint and method."},
    unsupported_media_type: {status: 415, retryable: false, message: "Server does not support this content type or encoding", action: "Check the request Content-Type and Content-Encoding."},
    payload_too_large: {status: 413, retryable: false, message: "Server request exceeds the size limit", action: "Reduce the request size before retrying."},
    binding_mismatch: {status: 409, retryable: false, message: "Server binding does not match", action: "Stop synchronization and reconcile the changed server, namespace, or history binding."},
    cursor_mismatch: {status: 409, retryable: false, message: "Server discovery cursor does not match", action: "Restart discovery with the current binding."},
    stale_base: {status: 409, retryable: false, message: "Server session has a newer revision", action: "Fetch the current revision and resolve the conflict before publishing."},
    already_exists: {status: 409, retryable: false, message: "Server session already exists", action: "Keep the original upload state intact; recover its receipt or fork a new session."},
    operation_id_mismatch: {status: 409, retryable: false, message: "Server operation ID was reused with different content", action: "Use the original request for that operation ID or a new ID for a new operation."},
    capacity: {status: 507, retryable: true, message: "Server capacity limit reached", action: "Check available storage and configured resource quotas before retrying."},
    overloaded: {status: 503, retryable: true, message: "Server is overloaded", action: "Retry later."},
    corruption: {status: 500, retryable: false, message: "Server detected stored data corruption", action: "Contact the server administrator to check storage integrity."},
    not_found: {status: 404, retryable: false, message: "Server endpoint or resource was not found", action: "Check the server URL, server version, and requested resource."},
    uncertain_commit: {status: 503, retryable: true, message: "Server publication outcome is uncertain", action: "Check the operation receipt before retrying the same operation."},
    internal: {status: 500, retryable: false, message: "Server encountered an internal error", action: "Contact the server administrator to check the server logs."},
} as const satisfies Record<string, {status: number; retryable: boolean; message: string; action: string}>;

export type ServerErrorCode = keyof typeof ERROR_DEFINITIONS;

export type ServerError = {
    code: ServerErrorCode;
    retryable: boolean;
    publication_outcome: "unconfirmed";
};

function isServerErrorCode(value: unknown): value is ServerErrorCode {
    return typeof value === "string" && Object.hasOwn(ERROR_DEFINITIONS, value);
}

/** Decode only the owned pi.server error envelope, not proxy or arbitrary error bodies. */
export function decodeServerError(value: unknown, httpStatus: number): ServerError | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("error" in value)) return undefined;
    if (typeof value.error !== "object" || value.error === null || Array.isArray(value.error)) return undefined;
    const error = value.error as Record<string, unknown>;
    if (!isServerErrorCode(error.code)) return undefined;
    const definition = ERROR_DEFINITIONS[error.code];
    if (httpStatus !== definition.status || error.retryable !== definition.retryable || error.publication_outcome !== "unconfirmed") {
        return undefined;
    }
    return {code: error.code, retryable: error.retryable, publication_outcome: "unconfirmed"};
}

/** Presentation may trust a recognized code, never an exception's arbitrary message. */
export function formatServerErrorCode(code: unknown): string | undefined {
    if (!isServerErrorCode(code)) return undefined;
    return formatServerError({code, retryable: ERROR_DEFINITIONS[code].retryable, publication_outcome: "unconfirmed"}, null);
}

/** Format only local messages; never reflect server text or an arbitrary Retry-After header. */
export function formatServerError(error: ServerError, retryAfter: string | null): string {
    const definition = ERROR_DEFINITIONS[error.code];
    // The end assertion also rejects a trailing newline, unlike JavaScript's $ anchor.
    const retry = error.retryable && retryAfter !== null && /^[0-9]{1,9}(?![\s\S])/.test(retryAfter)
        ? ` Retry after ${Number(retryAfter)} seconds.` : "";
    return `${definition.message} (${error.code}; HTTP ${definition.status}). ${definition.action}${retry}`;
}
