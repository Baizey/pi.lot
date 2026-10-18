// pi.server v0.2 archive wire types. Sequences must never pass through a JS number.
export type Binding = {server_id: string; namespace_id: string; history_generation: string};
export type Revision = {binding: Binding; seq: string};
export type Condition = {kind: "absent"} | {kind: "exact_base_revision"; revision: Revision};
export enum SessionKind {
    Main = "main",
    Subagent = "subagent",
    PolicyApprover = "policy_approver",
}
export type SessionCounts = {user_messages: number; assistant_messages: number; tool_calls: number};
export type ArchiveMetadata = {
    kind?: SessionKind;
    root_session_id?: string;
    title?: string;
    started_at?: string;
    last_activity_at?: string;
    counts?: SessionCounts;
    summary?: string;
};
export type Publication = {
    binding: Binding;
    session_id: string;
    operation_id: string;
    condition: Condition;
    byte_length: number;
    sha256: string;
    metadata?: ArchiveMetadata;
};
export type SessionMetadata = {session_id: string; revision: Revision; byte_length: number; sha256: string};
export type ArchiveSession = SessionMetadata & {metadata: ArchiveMetadata | null; uploaded_at: string | null};
export type ListFilters = {
    kind?: SessionKind;
    root_session_id?: string;
    started_from?: string;
    started_to?: string;
    activity_from?: string;
    activity_to?: string;
};
export type ListRequest = {binding: Binding; filters?: ListFilters; cursor?: string | null; limit: number};
export type ListPage = {binding: Binding; sessions: ArchiveSession[]; next_cursor: string | null};
export type BindingResponse = {binding: Binding; head: string};
export type Receipt = {request: Publication; revision: Revision};
export type ReceiptOutcome = {status: "accepted"; receipt: Receipt} | {status: "unknown"};

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_SEQ = 9223372036854775807n;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export class ArchiveProtocolError extends Error {
    constructor() {
        super("Invalid archive protocol data.");
        this.name = "ArchiveProtocolError";
    }
}

/** Strict by default for locally owned requests/journals; response decoders ignore future fields. */
export function decodeArchiveBinding(value: unknown, strict = true): Binding {
    const row = object(value, ["server_id", "namespace_id", "history_generation"], strict);
    return {server_id: decodeArchiveId(row.server_id), namespace_id: decodeArchiveId(row.namespace_id),
        history_generation: decodeArchiveId(row.history_generation)};
}

export function decodeArchiveRevision(value: unknown, strict = true): Revision {
    const row = object(value, ["binding", "seq"], strict);
    const seq = decodeArchiveSequence(row.seq);
    requireValid(seq !== "0");
    return {binding: decodeArchiveBinding(row.binding, strict), seq};
}

export function decodeArchiveSequence(value: unknown): string {
    requireValid(typeof value === "string" && /^(0|[1-9][0-9]{0,18})(?![\s\S])/u.test(value));
    if (typeof value !== "string") throw new ArchiveProtocolError();
    requireValid(BigInt(value) <= MAX_SEQ);
    return value;
}

export function decodeArchiveId(value: unknown): string {
    return text(value, 512, true);
}

export function decodeArchiveMetadata(value: unknown, sessionId: string, strict = true): ArchiveMetadata {
    const row = object(value, ["kind", "root_session_id", "title", "started_at", "last_activity_at", "counts", "summary"], strict);
    const result: ArchiveMetadata = {};
    if (present(row.kind)) result.kind = kind(row.kind);
    if (present(row.root_session_id)) result.root_session_id = decodeArchiveId(row.root_session_id);
    if (present(row.title)) result.title = text(row.title, 256, true, true);
    if (present(row.started_at)) result.started_at = timestamp(row.started_at);
    if (present(row.last_activity_at)) result.last_activity_at = timestamp(row.last_activity_at);
    if (present(row.counts)) {
        const counts = object(row.counts, ["user_messages", "assistant_messages", "tool_calls"], strict);
        result.counts = {user_messages: integer(counts.user_messages), assistant_messages: integer(counts.assistant_messages),
            tool_calls: integer(counts.tool_calls)};
    }
    if (present(row.summary)) result.summary = text(row.summary, 1024, false, true);
    requireValid(result.kind !== "main" || result.root_session_id === sessionId);
    requireValid((result.kind !== "subagent" && result.kind !== "policy_approver")
        || (result.root_session_id !== undefined && result.root_session_id !== sessionId));
    ordered(result.started_at, result.last_activity_at);
    requireValid(Buffer.byteLength(JSON.stringify(result)) <= 2048);
    return result;
}

export function decodeArchivePublication(value: unknown, strict = true): Publication {
    const row = object(value, ["binding", "session_id", "operation_id", "condition", "byte_length", "sha256", "metadata"], strict);
    const binding = decodeArchiveBinding(row.binding, strict);
    const session_id = decodeArchiveId(row.session_id);
    requireValid(typeof row.operation_id === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/u.test(row.operation_id));
    if (typeof row.operation_id !== "string") throw new ArchiveProtocolError();
    const conditionRow = object(row.condition, ["kind", "revision"], false);
    let condition: Condition;
    if (conditionRow.kind === "absent") {
        object(row.condition, ["kind"], strict);
        condition = {kind: "absent"};
    } else {
        requireValid(conditionRow.kind === "exact_base_revision");
        object(row.condition, ["kind", "revision"], strict);
        const revision = decodeArchiveRevision(conditionRow.revision, strict);
        requireValid(sameArchiveBinding(binding, revision.binding));
        condition = {kind: "exact_base_revision", revision};
    }
    const result: Publication = {binding, session_id, operation_id: row.operation_id, condition,
        byte_length: integer(row.byte_length, MAX_ARCHIVE_BYTES), sha256: digest(row.sha256)};
    if (present(row.metadata)) result.metadata = decodeArchiveMetadata(row.metadata, session_id, strict);
    return result;
}

export function decodeArchiveReceipt(value: unknown, strict = true): Receipt {
    const row = object(value, ["request", "revision"], strict);
    const request = decodeArchivePublication(row.request, strict);
    const revision = decodeArchiveRevision(row.revision, strict);
    requireValid(sameArchiveBinding(request.binding, revision.binding));
    if (request.condition.kind === "exact_base_revision") {
        requireValid(BigInt(revision.seq) > BigInt(request.condition.revision.seq));
    }
    return {request, revision};
}

export function decodeArchiveSessionMetadata(value: unknown, strict = true): SessionMetadata {
    const row = object(value, ["session_id", "revision", "byte_length", "sha256"], strict);
    return {session_id: decodeArchiveId(row.session_id), revision: decodeArchiveRevision(row.revision, strict),
        byte_length: integer(row.byte_length, MAX_ARCHIVE_BYTES), sha256: digest(row.sha256)};
}

export function decodeArchiveSession(value: unknown): ArchiveSession {
    const row = object(value, [], false);
    const snapshot = decodeArchiveSessionMetadata(value, false);
    return {...snapshot, metadata: present(row.metadata) ? decodeArchiveMetadata(row.metadata, snapshot.session_id, false) : null,
        uploaded_at: present(row.uploaded_at) ? timestamp(row.uploaded_at) : null};
}

export function decodeArchiveListFilters(value: unknown, strict = true): ListFilters {
    const row = object(value, ["kind", "root_session_id", "started_from", "started_to", "activity_from", "activity_to"], strict);
    const result: ListFilters = {};
    if (present(row.kind)) result.kind = kind(row.kind);
    if (present(row.root_session_id)) result.root_session_id = decodeArchiveId(row.root_session_id);
    if (present(row.started_from)) result.started_from = timestamp(row.started_from);
    if (present(row.started_to)) result.started_to = timestamp(row.started_to);
    if (present(row.activity_from)) result.activity_from = timestamp(row.activity_from);
    if (present(row.activity_to)) result.activity_to = timestamp(row.activity_to);
    ordered(result.started_from, result.started_to);
    ordered(result.activity_from, result.activity_to);
    return result;
}

export function decodeArchiveListRequest(value: unknown): ListRequest {
    const row = object(value, ["binding", "filters", "cursor", "limit"], true);
    const result: ListRequest = {binding: decodeArchiveBinding(row.binding), limit: integer(row.limit, 4294967295)};
    requireValid(result.limit > 0);
    if (row.filters !== undefined) result.filters = decodeArchiveListFilters(row.filters);
    if (row.cursor !== undefined) result.cursor = row.cursor === null ? null : cursor(row.cursor);
    return result;
}

export function decodeArchiveListPage(value: unknown): ListPage {
    const row = object(value, [], false);
    const binding = decodeArchiveBinding(row.binding, false);
    requireValid(Array.isArray(row.sessions));
    if (!Array.isArray(row.sessions)) throw new ArchiveProtocolError();
    const sessions = row.sessions.map((value: unknown) => decodeArchiveSession(value));
    const ids = new Set<string>();
    for (const session of sessions) {
        requireValid(sameArchiveBinding(binding, session.revision.binding) && !ids.has(session.session_id));
        ids.add(session.session_id);
    }
    return {binding, sessions, next_cursor: row.next_cursor === null ? null : cursor(row.next_cursor)};
}

export function decodeArchiveBindingResponse(value: unknown): BindingResponse {
    const row = object(value, [], false);
    return {binding: decodeArchiveBinding(row.binding, false), head: decodeArchiveSequence(row.head)};
}

export function decodeArchiveReceiptOutcome(value: unknown): ReceiptOutcome {
    const row = object(value, [], false);
    if (row.status === "unknown") return {status: "unknown"};
    requireValid(row.status === "accepted");
    return {status: "accepted", receipt: decodeArchiveReceipt(row.receipt, false)};
}

export function sameArchiveBinding(left: Binding, right: Binding): boolean {
    return left.server_id === right.server_id && left.namespace_id === right.namespace_id
        && left.history_generation === right.history_generation;
}

/** Decoding establishes a fixed field order and canonical timestamps, not server JSON property order. */
export function sameArchivePublication(left: Publication, right: Publication): boolean {
    return JSON.stringify(decodeArchivePublication(left)) === JSON.stringify(decodeArchivePublication(right));
}

function object(value: unknown, keys: readonly string[], strict: boolean): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ArchiveProtocolError();
    requireValid(!strict || Object.keys(value).every((key) => keys.includes(key)));
    return value as Record<string, unknown>;
}

function requireValid(valid: boolean): void {
    if (!valid) throw new ArchiveProtocolError();
}

function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function text(value: unknown, maxBytes: number, controlFree: boolean, nonblank = false): string {
    if (typeof value !== "string") throw new ArchiveProtocolError();
    // Reject lone UTF-16 surrogates rather than silently changing identifiers on UTF-8 encoding.
    requireValid(value.length > 0 && Buffer.byteLength(value) <= maxBytes
        && Buffer.from(value).toString("utf8") === value && (!controlFree || !CONTROL.test(value))
        && (!nonblank || value.trim().length > 0));
    return value;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new ArchiveProtocolError();
    return value;
}

function digest(value: unknown): string {
    if (typeof value !== "string" || !/^[0-9a-f]{64}(?![\s\S])/u.test(value)) throw new ArchiveProtocolError();
    return value;
}

function kind(value: unknown): SessionKind {
    if (value === SessionKind.Main || value === SessionKind.Subagent || value === SessionKind.PolicyApprover) return value;
    throw new ArchiveProtocolError();
}

function cursor(value: unknown): string {
    return text(value, 4096, true);
}

function timestamp(value: unknown): string {
    if (typeof value !== "string") throw new ArchiveProtocolError();
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([Zz]|[+-]\d{2}:\d{2})(?![\s\S])/u.exec(value);
    if (!match) throw new ArchiveProtocolError();
    const [, year, month, day, hour, minute, second, , offset] = match;
    const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    requireValid(Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1
        && Number(day) <= days[Number(month) - 1] && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59);
    if (offset !== "Z" && offset !== "z") requireValid(Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) <= 59);
    const millis = Date.parse(value);
    requireValid(Number.isFinite(millis) && millis >= 0 && millis <= 253402300799999);
    return new Date(millis).toISOString();
}

function ordered(from: string | undefined, to: string | undefined): void {
    requireValid(from === undefined || to === undefined || Date.parse(from) <= Date.parse(to));
}
