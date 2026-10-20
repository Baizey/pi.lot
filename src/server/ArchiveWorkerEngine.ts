import {createHash, randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {ServerConfigStore} from "./ServerConfig.js";
import {ArchiveClient, ArchiveClientError} from "./ArchiveClient.js";
import {ArchiveSessions, ArchiveSourceError} from "./ArchiveSessions.js";
import {
    ArchiveProtocolError, MAX_ARCHIVE_BYTES, decodeArchivePublication, decodeArchivePreservation, decodeArchiveSessionMetadata,
    sameArchiveBinding, type Binding, type Condition, type SessionMetadata,
} from "./ArchiveProtocol.js";
import {reconcileArchive} from "./ArchiveReconciler.js";
import {
    ArchiveWorkerState, sameIdentity, type ArchiveManifest, type WorkSchedule,
    type WorkDestination, type WorkCandidate, type WorkOperation, type WorkSource,
} from "./ArchiveWorkerState.js";

type Connection = NonNullable<ReturnType<ServerConfigStore["connection"]>>;
type Comparison = {snapshot: SessionMetadata; condition: Extract<Condition, {kind: "exact_base_revision"}>};

/** Owns bounded capture and one-request scheduling while the runner holds the worker lock. */
export class ArchiveWorkerEngine {
    private state: ArchiveWorkerState | undefined;
    private verifiedGeneration: string | undefined;
    private captureTurn = false;
    private operationTurn = false;

    constructor(private readonly directory: string, private readonly store: ServerConfigStore) {}

    import(manifest: ArchiveManifest): boolean {
        return this.mutable().import(manifest);
    }

    async step(): Promise<WorkSchedule> {
        const state = this.mutable();
        const connection = this.store.connection();
        if (!connection) { state.pruneComparison([]); return this.inspect(); }
        const authorization = state.authorization(connection.generation);
        if (authorization.blocked) return this.inspect();
        const intended = state.destinations().filter((d) => d.origin === connection.config.url
            && (d.binding !== undefined || d.generation === connection.generation));
        const local = intended.filter((d) => !d.binding ? d.generation === connection.generation
            : this.verifiedGeneration === connection.generation && authorization.binding && sameIdentity(d.binding, authorization.binding));
        state.pruneComparison(intended.filter((d) => !d.binding || !authorization.binding || sameIdentity(d.binding, authorization.binding)).map((d) => d.id));
        // Capture is destination-pinned, but independent of a predecessor's network outcome.
        await this.captureOpportunity(state, local.map((d) => d.id));
        if (authorization.due > Date.now()) return this.inspect();
        if (!intended.length) return this.inspect();
        if (this.verifiedGeneration !== connection.generation || !authorization.binding) {
            try {
                const result = await this.client(connection).binding();
                state.authorize(connection.generation, result.binding, result.capabilities ?? []);
                this.verifiedGeneration = connection.generation;
                for (const destination of intended) {
                    if (!destination.binding || sameIdentity(destination.binding, result.binding)) {
                        state.bind(destination, result.binding);
                        state.resumeCandidates(destination.id);
                    }
                }
            } catch (error) {
                this.authorizationFailure(state, connection, error, authorization.attempts);
            }
            return this.inspect();
        }
        const binding = authorization.binding;
        const destinations = intended.filter((d) => d.binding && sameArchiveBinding(d.binding, binding));
        // Newly imported scopes can bind after the credential generation was already verified.
        for (const destination of intended) {
            if (!destination.binding && destination.generation === connection.generation) {
                state.bind(destination, binding);
                destinations.push({...destination, binding});
            }
        }
        const ids = destinations.map((d) => d.id);
        const operation = state.nextOperation(ids, Date.now());
        const candidate = state.nextCandidate(ids, Date.now());
        this.operationTurn = !this.operationTurn;
        const operationBytes = operation && operation.kind !== "current" && operation.state !== "uncertain"
            ? state.candidate(operation.candidate).byteLength * 2 : 0;
        if (operation && (this.operationTurn || !candidate) && operationBytes > state.workingAvailable()) state.releaseComparisonBodies();
        if (operation && operationBytes <= state.workingAvailable() && (this.operationTurn || !candidate)) {
            await this.execute(state, connection, operation);
        } else if (candidate) {
            const destination = destinations.find((d) => d.id === candidate.destination)!;
            await this.reconcile(state, connection, destination, candidate, authorization.capabilities.includes("preserved_variants_v1"));
        }
        return this.inspect();
    }

    /** May run after unlocking: no initialization, migration, import, or generation mutation. */
    inspect(): WorkSchedule {
        return ArchiveWorkerState.inspect(this.directory, this.store.connection());
    }

    close(): void {
        this.state?.close();
        this.state = undefined;
        this.verifiedGeneration = undefined;
    }

    private async captureOpportunity(state: ArchiveWorkerState, destinations: string[]): Promise<void> {
        const source = state.nextSource(Date.now(), destinations);
        const scope = state.nextScope(Date.now(), destinations);
        this.captureTurn = !this.captureTurn;
        if (source && (this.captureTurn || !scope)) {
            await this.captureSource(state, source);
        } else if (scope) {
            try {
                const page = await new ArchiveSessions(scope.source).discoverPage(scope.cursor, 64);
                state.addSources(scope, page.files, page.cursor, page.complete, page.issues);
            } catch (error) {
                state.defer("scopes", scope.id, Date.now() + retryDelay(scope.attempts), sourceDiagnostic(error));
            }
        }
    }

    private async captureSource(state: ArchiveWorkerState, source: WorkSource): Promise<void> {
        const scope = state.scope(source.scope);
        const sessions = new ArchiveSessions(scope.source);
        if (source.kind === "directory") {
            try {
                const page = await sessions.discoverPage(source.retryCursor, 64);
                // Retry cursors are self-contained. The main scan's cursor must not regress.
                if (!state.addSources(scope, page.files, scope.cursor, true, page.issues, false)) {
                    state.defer("sources", source.id, Date.now() + 30_000, "source-capacity");
                    return;
                }
                if (page.complete) state.finishSource(source.id, "captured");
                else if (page.cursor) state.directoryContinuation(source.id, page.cursor);
            } catch (error) {
                this.sourceFailure(state, source, error);
            }
            return;
        }
        const release = state.reserve(MAX_ARCHIVE_BYTES);
        try {
            const snapshot = await sessions.captureSource(source.file, state.sourceEvidence(source.scope));
            state.observeSource(source.id, snapshot.evidence, snapshot.ancestryDependencies);
            if (snapshot.membership === "excluded") {
                state.finishSource(source.id, "excluded");
            } else if (snapshot.membership === "unresolved") {
                state.defer("sources", source.id, Date.now() + 5000, "ancestry-unresolved");
            } else if (!state.capture(source, snapshot)) {
                state.defer("sources", source.id, Date.now() + 30_000, "backlog-capacity");
            }
        } catch (error) {
            this.sourceFailure(state, source, error);
        } finally { release(); }
    }

    private sourceFailure(state: ArchiveWorkerState, source: WorkSource, error: unknown): void {
        if (error instanceof ArchiveSourceError && error.code === "missing") {
            const delays = [5000, 30_000, 300_000];
            if (source.missingAttempts >= delays.length) state.finishSource(source.id, "source-lost");
            else state.defer("sources", source.id, Date.now() + delays[source.missingAttempts]!, "source-missing");
        } else if ((error instanceof ArchiveSourceError && error.code === "invalid") || error instanceof ArchiveProtocolError) {
            state.finishSource(source.id, "invalid");
        } else {
            state.defer("sources", source.id, Date.now() + retryDelay(source.attempts), sourceDiagnostic(error));
        }
    }

    private async reconcile(state: ArchiveWorkerState, connection: Connection, destination: WorkDestination,
        candidate: WorkCandidate, preservationSupported: boolean): Promise<void> {
        const binding = destination.binding!;
        try {
            const dependency = state.dependency(candidate.id, binding);
            if (dependency) {
                const compared = decodeComparison(dependency.comparison);
                this.preparePublication(state, candidate, binding, compared.condition, dependency.id, dependency.comparison);
                return;
            }
            if (candidate.attempts === 0 && this.prepareKnownExtension(state, candidate, binding)) return;
        } catch (error) {
            this.networkFailure(state, connection, "candidates", candidate.id, candidate.attempts, error);
            return;
        }
        state.releaseComparisonBodies(candidate.id);
        const release = state.reserve((state.hasComparisonBody(candidate.id) ? 0 : MAX_ARCHIVE_BYTES) + candidate.byteLength);
        try {
            const previous = state.comparison(candidate.id);
            const compared = previous ? decodeArchiveSessionMetadata(previous.snapshot) : undefined;
            if (previous && compared?.metadata === undefined) {
                const snapshot = compared!;
                // Old 0.2 snapshots omit metadata and do not support the exact-ID filter.
                // Each step reads one bounded page; only its opaque cursor survives, not a catalog.
                // Incoming root metadata cannot filter contradictory or absent remote assertions.
                const page = await this.client(connection).list({binding, limit: 128, ...(previous.cursor ? {cursor: previous.cursor} : {})});
                const row = page.sessions.find((entry) => entry.session_id === candidate.sessionId && !entry.variant_id);
                if (!row) {
                    if (page.next_cursor) state.comparisonCursor(candidate.id, page.next_cursor);
                    else {
                        state.clearComparison(candidate.id);
                        state.defer("candidates", candidate.id, Date.now() + retryDelay(candidate.attempts), "legacy-metadata-raced");
                    }
                    return;
                }
                if (!isDeepStrictEqual(row.revision, snapshot.revision)
                    || row.sha256 !== snapshot.sha256 || row.byte_length !== snapshot.byte_length) {
                    state.clearComparison(candidate.id);
                    state.defer("candidates", candidate.id, Date.now() + retryDelay(candidate.attempts), "metadata-raced");
                    return;
                }
                const coherent = {...snapshot, metadata: row.metadata, uploaded_at: row.uploaded_at};
                if (previous.body) this.decide(state, candidate, binding, coherent, previous.body, preservationSupported);
                else state.coherentComparison(candidate.id, coherent);
            } else {
                try {
                    const remote = await this.client(connection).download(binding, candidate.sessionId);
                    if (remote.snapshot.metadata === undefined && compared?.metadata !== undefined
                        && isDeepStrictEqual(compared.revision, remote.snapshot.revision)
                        && compared.sha256 === remote.snapshot.sha256 && compared.byte_length === remote.snapshot.byte_length) {
                        this.decide(state, candidate, binding, compared, remote.body, preservationSupported);
                    } else if (remote.snapshot.metadata === undefined) {
                        state.saveComparison(candidate.id, remote.snapshot, remote.body);
                    } else {
                        this.decide(state, candidate, binding, remote.snapshot, remote.body, preservationSupported);
                    }
                } catch (error) {
                    if (error instanceof ArchiveClientError && error.code === "not_found") {
                        this.preparePublication(state, candidate, binding, {kind: "absent"});
                    } else throw error;
                }
            }
        } catch (error) {
            if (error instanceof ArchiveClientError && error.code === "cursor_mismatch") {
                state.clearComparison(candidate.id);
                state.defer("candidates", candidate.id, Date.now() + retryDelay(candidate.attempts), "metadata-cursor-raced");
            } else this.networkFailure(state, connection, "candidates", candidate.id, candidate.attempts, error);
        } finally { release(); }
    }

    private prepareKnownExtension(state: ArchiveWorkerState, candidate: WorkCandidate, binding: Binding): boolean {
        const accepted = state.acceptedCanonical(candidate, binding);
        if (!accepted || accepted.request.byte_length >= candidate.byteLength
            || (accepted.request.metadata?.kind !== undefined && accepted.request.metadata.kind !== candidate.metadata?.kind)
            || (accepted.request.metadata?.root_session_id !== undefined && accepted.request.metadata.root_session_id !== candidate.metadata?.root_session_id)) return false;
        const release = state.reserve(candidate.byteLength);
        try {
            const body = state.body(candidate);
            const prefix = body.subarray(0, accepted.request.byte_length);
            if (createHash("sha256").update(prefix).digest("hex") !== accepted.request.sha256) return false;
            // This is a known canonical base, not an assertion that it is still current.
            // CAS rejection retires this request and forces fresh remote comparison.
            this.preparePublication(state, candidate, binding, {kind: "exact_base_revision", revision: accepted.revision});
            return true;
        } finally { release(); }
    }

    private decide(state: ArchiveWorkerState, candidate: WorkCandidate, binding: Binding,
        snapshot: SessionMetadata, remoteBody: Buffer, preservationSupported: boolean): void {
        const decision = reconcileArchive({sessionId: candidate.sessionId, body: state.body(candidate), metadata: candidate.metadata},
            {body: remoteBody, revision: snapshot.revision, metadata: snapshot.metadata}, {preservationSupported});
        switch (decision.kind) {
            case "covered":
                state.cover(candidate.id, {kind: "byte-coverage", snapshot});
                return;
            case "publish":
                this.preparePublication(state, candidate, binding, decision.condition);
                return;
            case "preserve-uploaded": {
                const request = decodeArchivePreservation({mode: "uploaded", binding, session_id: candidate.sessionId,
                    operation_id: randomUUID(), byte_length: candidate.byteLength, sha256: candidate.sha256,
                    ...(candidate.metadata === null ? {} : {metadata: candidate.metadata})});
                state.prepare(candidate, "uploaded", request);
                return;
            }
            case "preserve-current-then-publish": {
                const request = decodeArchivePreservation({mode: "current", binding, session_id: candidate.sessionId,
                    operation_id: randomUUID(), revision: snapshot.revision});
                state.prepare(candidate, "current", request, null, JSON.stringify({snapshot, condition: decision.condition}));
                return;
            }
            case "defer":
                state.pauseCandidate(candidate.id, decision.reason);
        }
    }

    private preparePublication(state: ArchiveWorkerState, candidate: WorkCandidate, binding: Binding,
        condition: Condition, dependency: string | null = null, comparison: string | null = null): void {
        const request = decodeArchivePublication({binding, session_id: candidate.sessionId, operation_id: randomUUID(), condition,
            byte_length: candidate.byteLength, sha256: candidate.sha256, ...(candidate.metadata === null ? {} : {metadata: candidate.metadata})});
        state.prepare(candidate, "publish", request, dependency, comparison);
    }

    private async execute(state: ArchiveWorkerState, connection: Connection, operation: WorkOperation): Promise<void> {
        const candidate = state.candidate(operation.candidate);
        // Transport may copy the outgoing buffer. Reserve both logical materializations before loading.
        const release = state.reserve(operation.kind === "current" || operation.state === "uncertain" ? 0 : candidate.byteLength * 2);
        try {
            const client = this.client(connection);
            if (operation.kind === "publish") {
                const request = decodeArchivePublication(JSON.parse(operation.request));
                if (operation.state === "uncertain") {
                    const outcome = await client.receipt(request);
                    if (outcome.status === "accepted") state.accept(operation, outcome.receipt, true);
                    else state.replay(operation.id, Date.now() + retryDelay(operation.attempts));
                } else {
                    const body = state.body(candidate);
                    state.markUncertain(operation.id);
                    const receipt = await client.publish(request, body);
                    state.accept(operation, receipt, true);
                }
            } else {
                const request = decodeArchivePreservation(JSON.parse(operation.request));
                if (operation.state === "uncertain") {
                    const outcome = await client.preserveReceipt(request);
                    if (outcome.status === "accepted") state.accept(operation, outcome.receipt, operation.kind === "uploaded");
                    else state.replay(operation.id, Date.now() + retryDelay(operation.attempts));
                } else {
                    const body = operation.kind === "uploaded" ? state.body(candidate) : undefined;
                    state.markUncertain(operation.id);
                    const receipt = await client.preserve(request, body);
                    state.accept(operation, receipt, operation.kind === "uploaded");
                }
            }
        } catch (error) {
            const rejectedMutation = operation.state === "ready" && error instanceof ArchiveClientError
                && ((operation.kind === "publish" && (error.code === "stale_base" || error.code === "already_exists"))
                    || (operation.kind === "current" && error.code === "stale_base"));
            if (rejectedMutation) {
                state.reject(operation);
            } else {
                this.networkFailure(state, connection, "operations", operation.id, operation.attempts, error);
            }
        } finally { release(); }
    }

    private client(connection: Connection): ArchiveClient {
        return new ArchiveClient(connection.config, {beforeRequest: async () => {
            const current = this.store.connection();
            if (!current || current.generation !== connection.generation || current.config.url !== connection.config.url
                || current.config.apiKey !== connection.config.apiKey) throw new Error("Archive authorization changed.");
        }});
    }

    private networkFailure(state: ArchiveWorkerState, connection: Connection, table: "candidates" | "operations",
        id: string, attempts: number, error: unknown): void {
        if (error instanceof ArchiveClientError && error.code === "unauthorized") {
            state.authorizationFailure(connection.generation, true, 0);
        } else if (error instanceof ArchiveClientError && error.code === "binding_mismatch") {
            this.verifiedGeneration = undefined;
            state.authorizationFailure(connection.generation, false, Date.now() + 1000);
        } else if (error instanceof ArchiveClientError && error.kind === "authorization") {
            // Configuration changed before dispatch. Never convert a logout into invalid history.
            state.defer(table, id, Date.now() + 5000, "authorization-changed");
        } else if (error instanceof ArchiveClientError && error.retryable) {
            state.defer(table, id, Date.now() + retryDelay(attempts, error.retryAfterMs, error.code === "capacity"), "retryable-network");
        } else if (table === "operations") {
            state.failOperation(id, Date.now() + retryDelay(attempts), "invalid-protocol-or-state");
        } else {
            state.defer(table, id, 0, "invalid-protocol-or-state", true);
        }
    }

    private authorizationFailure(state: ArchiveWorkerState, connection: Connection, error: unknown, attempts: number): void {
        if (error instanceof ArchiveClientError && error.kind === "authorization") return;
        const blocked = !(error instanceof ArchiveClientError) || !error.retryable;
        state.authorizationFailure(connection.generation, blocked, blocked ? 0 : Date.now() + retryDelay(attempts,
            error instanceof ArchiveClientError ? error.retryAfterMs : undefined));
    }

    private mutable(): ArchiveWorkerState {
        return this.state ??= new ArchiveWorkerState(this.directory);
    }
}

function retryDelay(attempts: number, retryAfter?: number, capacity = false): number {
    const exponential = Math.min(300_000, (capacity ? 30_000 : 1000) * 2 ** Math.min(attempts, 12));
    return Math.max(retryAfter ?? 0, Math.floor(exponential * (0.75 + Math.random() * 0.5)));
}

function sourceDiagnostic(error: unknown): string {
    return error instanceof ArchiveSourceError ? `source-${error.code}` : "source-unreadable";
}

function decodeComparison(raw: string): Comparison {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("snapshot" in value) || !("condition" in value)) throw new Error("Invalid archive comparison.");
    const snapshot = decodeArchiveSessionMetadata(value.snapshot);
    const expected: Condition = {kind: "exact_base_revision", revision: snapshot.revision};
    if (!isDeepStrictEqual(value.condition, expected)) throw new Error("Invalid archive comparison base.");
    return {snapshot, condition: expected};
}
