import {REQUIRED_SERVER_VERSION, type ServerConfig} from "./ServerConfig.js";
import {decodeServerError, decodeVersionResponse, formatServerError} from "./ServerResponses.js";

export type ServerStatus =
    | {kind: "compatible" | "incompatible"; version: string}
    | {kind: "failure"; message: string};

const MAX_RESPONSE_BYTES = 4096;
const TIMEOUT_MS = 10_000;

export async function checkServerVersion(config: ServerConfig, signal?: AbortSignal): Promise<ServerStatus> {
    const timeout = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(new DOMException("Timed out", "TimeoutError")), TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let receivedResponse = false;
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
        receivedResponse = true;
        reader = response.body?.getReader();
        requestSignal.addEventListener("abort", cancelBody, {once: true});
        requestSignal.throwIfAborted();
        if (response.status >= 300 && response.status < 400) {
            return {kind: "failure", message: `Server redirect refused (HTTP ${response.status}).`};
        }
        if (!reader) {
            return {kind: "failure", message: `Unexpected server response (HTTP ${response.status}): response body is missing.`};
        }
        const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
        let length = 0;
        while (true) {
            const chunk = await reader.read();
            requestSignal.throwIfAborted();
            if (chunk.done) break;
            if (chunk.value.byteLength > MAX_RESPONSE_BYTES - length) {
                return {kind: "failure", message: `Server response exceeds 4 KiB (HTTP ${response.status}).`};
            }
            bytes.set(chunk.value, length);
            length += chunk.value.byteLength;
        }

        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, length)));
        } catch {
            return {kind: "failure", message: response.status === 200
                ? "Server returned an invalid JSON version response."
                : `Unexpected server response (HTTP ${response.status}): error body is not valid JSON.`};
        }
        if (response.status !== 200) {
            const error = decodeServerError(value, response.status);
            return {kind: "failure", message: error
                ? formatServerError(error, response.headers.get("retry-after"))
                : `Unexpected server response (HTTP ${response.status}): error body does not match the pi.server protocol.`};
        }
        const version = decodeVersionResponse(value);
        if (!version) return {kind: "failure", message: "Server returned an invalid version response."};
        return {kind: version.version === REQUIRED_SERVER_VERSION ? "compatible" : "incompatible", version: version.version};
    } catch (error) {
        if (requestSignal.aborted) {
            return timeout.signal.aborted && requestSignal.reason === timeout.signal.reason
                ? {kind: "failure", message: `Server ${receivedResponse ? "response" : "connection"} timed out after 10 seconds.`}
                : {kind: "failure", message: "Server connection cancelled."};
        }
        if (!(error instanceof Error)) return {kind: "failure", message: "Unable to connect to server: unexpected non-Error rejection."};
        return {kind: "failure", message: connectionFailureMessage(error, config, receivedResponse)};
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

function connectionFailureMessage(error: Error, config: ServerConfig, receivedResponse: boolean): string {
    // Node fetch rejects with TypeError and puts the socket/TLS error in cause.
    const cause = error.cause instanceof Error ? error.cause : error;
    const errors: NodeJS.ErrnoException[] = cause instanceof AggregateError
        ? cause.errors.filter((entry: unknown): entry is Error => entry instanceof Error).slice(0, 4)
        : [cause];
    if (errors.length === 0) errors.push(cause);
    const details = errors.map(({code, message}) => {
        const detail = code && message && !message.includes(code) ? `${code}: ${message}` : message || code || "Unknown transport error";
        return detail.split(config.apiKey).join("[redacted]")
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 512);
    });
    const hint = errors.map(({code}) => connectionHint(code)).find(Boolean);
    const prefix = receivedResponse ? "Server response failed" : "Unable to connect to server";
    return `${prefix}: ${details.join("; ")}${hint ? `\n${hint}` : ""}`;
}

function connectionHint(code: string | undefined): string | undefined {
    switch (code) {
        case "ECONNREFUSED":
            return "Check that pi.server is listening on the configured address/port and that any container port is published.";
        case "EHOSTUNREACH":
        case "ENETUNREACH":
            return "Check routing, VPN, and firewall access from the machine running Pi.";
        case "ENOTFOUND":
        case "EAI_AGAIN":
            return "The server hostname could not be resolved. Check the hostname and DNS configuration.";
        case "EACCES":
        case "EPERM":
            return "A local permission or network policy blocked the request.";
        case "ECONNRESET":
        case "EPIPE":
        case "UND_ERR_SOCKET":
            return "The connection was closed unexpectedly. Check the server/proxy logs and whether the port expects HTTP or HTTPS.";
        case "ETIMEDOUT":
        case "UND_ERR_CONNECT_TIMEOUT":
        case "UND_ERR_HEADERS_TIMEOUT":
        case "UND_ERR_BODY_TIMEOUT":
            return "The connection or response timed out. Check reachability, firewall rules, and server/proxy health.";
        case "ERR_TLS_CERT_ALTNAME_INVALID":
            return "The URL hostname/IP does not match the certificate. Use a matching hostname or a certificate covering that IP.";
        case "DEPTH_ZERO_SELF_SIGNED_CERT":
        case "SELF_SIGNED_CERT_IN_CHAIN":
        case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
        case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
            return "The certificate issuer is not trusted by Node. Configure the issuing CA in Node's trust store.";
        case "CERT_HAS_EXPIRED":
        case "CERT_NOT_YET_VALID":
            return "Check the certificate validity dates and the client's system clock.";
        case "ERR_SSL_WRONG_VERSION_NUMBER":
            return "The port may serve plain HTTP rather than HTTPS. Check the server's protocol configuration.";
    }
    if (code?.startsWith("HPE_")) return "The peer did not send a valid HTTP response. Check the service and protocol on this port.";
    return undefined;
}
