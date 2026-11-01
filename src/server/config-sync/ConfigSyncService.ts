import path from "node:path";
import {randomUUID} from "node:crypto";
import {ServerConfigStore} from "../ServerConfig.js";
import {ArchiveLock} from "../ArchiveLock.js";
import {sameArchiveBinding, type Binding} from "../ArchiveProtocol.js";
import type {ArchiveClientOptions} from "../ArchiveClient.js";
import {ConfigSyncClient, ConfigSyncClientError} from "./ConfigSyncClient.js";
import {ConfigSyncAdapters} from "./ConfigSyncAdapters.js";
import {ConfigSyncJournal, type PendingConfigSync} from "./ConfigSyncJournal.js";
import {
    CONFIG_KEYS, canonicalConfigContent, configHash, decodeConfigExchange,
    type ConfigKey, type ConfigOutcome, type ConfigSnapshot,
} from "./ConfigSyncProtocol.js";

export type ConfigSyncItemResult = {
    key: ConfigKey;
    status: "unchanged" | "applied" | "deferred" | "failed" | "needs_recovery";
    outcome?: ConfigOutcome;
    phase?: "capture" | "check" | "exchange" | "apply";
};
export type ConfigSyncResult =
    | {kind: "complete"; items: ConfigSyncItemResult[]}
    | {kind: "unconfigured" | "busy" | "binding_changed"};
type SyncMode = {kind: "manual" | "enable"} | {kind: "automatic"; binding: Binding}
    | {kind: "recover"; key: ConfigKey; direction: "local" | "server"};
type ConfigSyncPass = {
    client: ConfigSyncClient; journal: ConfigSyncJournal; adapters: ConfigSyncAdapters;
    binding: Binding; destination: string; signal?: AbortSignal; assertConnection(): void;
};
class AutomaticSyncDisabled extends Error {}

/** One bounded, snapshot-based pass; no periodic polling or detached configuration writer. */
export class ConfigSyncService {
    constructor(private readonly store = new ServerConfigStore(), private readonly options: ArchiveClientOptions = {}) {}

    synchronize(signal?: AbortSignal): Promise<ConfigSyncResult> {
        return this.run({kind: "manual"}, signal);
    }

    enableAutomatic(signal?: AbortSignal): Promise<ConfigSyncResult> {
        return this.run({kind: "enable"}, signal);
    }

    recover(key: ConfigKey, direction: "local" | "server", signal?: AbortSignal): Promise<ConfigSyncResult> {
        return this.run({kind: "recover", key, direction}, signal);
    }

    async synchronizeAutomatic(signal?: AbortSignal): Promise<ConfigSyncResult | undefined> {
        const connection = this.store.connection();
        if (!connection) return undefined;
        const journal = new ConfigSyncJournal(this.store.directory);
        let binding: Binding | undefined;
        try { binding = journal.automaticBinding(connection.config.url); }
        finally { journal.close(); }
        try { return binding ? await this.run({kind: "automatic", binding}, signal) : undefined; }
        catch (error) {
            if (error instanceof AutomaticSyncDisabled) return undefined;
            throw error;
        }
    }

    disableAutomatic(): void {
        // Consent revocation must work while an automatic pass is awaiting HTTP.
        const journal = new ConfigSyncJournal(this.store.directory);
        try { journal.disableAutomatic(); }
        finally { journal.close(); }
    }

    private async run(mode: SyncMode, signal?: AbortSignal): Promise<ConfigSyncResult> {
        signal?.throwIfAborted();
        const connection = this.store.ensureConnection();
        if (!connection) return {kind: "unconfigured"};
        const lock = new ArchiveLock(path.join(this.store.directory, "config-sync.lock"));
        if (!lock.acquire()) return {kind: "busy"};
        const journal = new ConfigSyncJournal(this.store.directory);
        let adapters: ConfigSyncAdapters | undefined;
        const assertConnection = () => {
            signal?.throwIfAborted();
            const current = this.store.connection();
            if (!current || current.generation !== connection.generation || current.config.url !== connection.config.url
                || current.config.apiKey !== connection.config.apiKey) throw new Error("Configuration sync authorization changed.");
            if (mode.kind === "automatic") {
                const approved = journal.automaticBinding(connection.config.url);
                if (!approved || !sameArchiveBinding(approved, mode.binding)) throw new AutomaticSyncDisabled();
            }
        };
        try {
            const client = new ConfigSyncClient(connection.config, {...this.options, beforeRequest: async (method, route, requestSignal) => {
                assertConnection();
                await this.options.beforeRequest?.(method, route, requestSignal);
                assertConnection();
            }});
            await client.assertCompatible(signal);
            assertConnection();
            const authority = await client.binding(signal);
            assertConnection();
            if (mode.kind === "automatic" && !sameArchiveBinding(authority.binding, mode.binding)) return {kind: "binding_changed"};
            if (mode.kind === "enable") journal.setAutomatic(connection.config.url, authority.binding);
            const destination = JSON.stringify([connection.config.url, authority.binding]);
            adapters = new ConfigSyncAdapters(this.store.directory, journal.database());
            const pass: ConfigSyncPass = {client, journal, adapters, destination, binding: authority.binding, signal, assertConnection};
            const items: ConfigSyncItemResult[] = [];
            for (const key of mode.kind === "recover" ? [mode.key] : CONFIG_KEYS) {
                assertConnection();
                const {item, stop} = await this.synchronizeItem(pass, key, mode.kind === "recover" ? mode.direction : undefined);
                items.push(item);
                if (stop) break;
            }
            return {kind: "complete", items};
        } finally {
            adapters?.close();
            journal.close();
            lock.release();
        }
    }

    private async synchronizeItem(pass: ConfigSyncPass, key: ConfigKey, recovery?: "local" | "server"):
        Promise<{item: ConfigSyncItemResult; stop: boolean}> {
        const {client, journal, adapters, destination, binding, signal, assertConnection} = pass;
        let phase: NonNullable<ConfigSyncItemResult["phase"]> = "capture";
        let pending: PendingConfigSync | undefined;
        try {
            let entry = journal.read(destination, key);
            pending = entry.pending;
            if (recovery && (key === "global-policies" || !pending?.application)) throw new Error("No interrupted JSON application.");
            // A recovery choice freezes its selected local file before any advisory check.
            const selected = recovery ? adapters.capture(key) : undefined;
            if (!pending) {
                const snapshot = adapters.capture(key, entry.base
                    ? {content: entry.base.content, materialized: entry.materialized} : undefined);
                pending = this.createPending(binding, key, entry.base?.revision ?? null, snapshot);
                journal.begin(destination, key, pending);
            }
            // Keep-local may reconcile the original identity and then send one NEW,
            // durably based operation. Neither operation is rebuilt from a later read.
            for (let attempt = 0; attempt < (recovery === "local" ? 2 : 1); attempt++) {
                this.assertPendingBinding(pending, binding, key);
                phase = "check";
                const check = await client.check({binding, key,
                    known_revision: pending.request.base_revision, sha256: pending.request.sha256}, signal);
                assertConnection();
                if (!check.sync_needed && !pending.application && !(recovery && attempt === 0)) {
                    phase = "apply";
                    const captured = pending.snapshot;
                    // Removing a LOCAL collision reveals its cached GLOBAL rule
                    // even when the authoritative bundle needs no network exchange.
                    const result = journal.unchanged(destination, key, pending,
                        key === "global-policies" && entry.base && entry.base.content !== captured.materialized
                            ? () => { assertConnection(); return adapters.apply(key, captured, entry.base!.content); } : undefined);
                    return {item: {key, status: !result.applied ? "deferred"
                        : result.materialized !== captured.materialized ? "applied" : "unchanged"}, stop: false};
                }
                phase = "exchange";
                const state = await client.sync(pending.request, signal);
                assertConnection();
                phase = "apply";
                if (recovery === "local" && attempt === 0) {
                    const next = this.createPending(binding, key, state.revision, selected!);
                    journal.rebase(destination, key, pending, state, next);
                    entry = journal.read(destination, key);
                    pending = entry.pending!;
                    continue;
                }
                const captured = recovery === "server" ? selected! : pending.application?.captured ?? pending.snapshot;
                let result: {applied: boolean; materialized: string | null};
                if (key === "global-policies") {
                    result = journal.complete(destination, key, pending, state, () => {
                        assertConnection();
                        return adapters.apply(key, captured, state.content);
                    });
                } else {
                    const winner = state.content === null ? null : canonicalConfigContent(JSON.parse(state.content));
                    if (pending.application && recovery !== "server") {
                        // This later read is solely a recovery/write-back guard, never an upload.
                        const current = adapters.capture(key).materialized;
                        if (current !== captured.materialized && current !== winner) {
                            return {item: {key, status: "needs_recovery", outcome: state.outcome}, stop: false};
                        }
                    }
                    if (recovery === "server" && captured.materialized !== winner) {
                        journal.preserveCapture(destination, key, pending, captured);
                    }
                    // A durable checkpoint must commit BEFORE the file operation,
                    // not inside its subsequent acknowledgement transaction.
                    result = adapters.apply(key, captured, state.content, (materialized) => {
                        pending = journal.prepareApplication(destination, key, pending!, state, captured, materialized);
                        assertConnection();
                    });
                    assertConnection();
                    journal.complete(destination, key, pending, state, () => result);
                }
                // A retry returns current state with the original operation's outcome.
                // That old decision cannot hide a newly imported winner or GLOBAL restoration.
                const unchanged = state.outcome === "unchanged" && state.sha256 === pending.request.sha256
                    && result.materialized === captured.materialized;
                return {item: {key, status: !result.applied ? "deferred" : unchanged ? "unchanged" : "applied",
                    outcome: state.outcome}, stop: false};
            }
            throw new Error("Configuration recovery did not produce a new operation.");
        } catch (error) {
            // Never reflect JSON, filesystem, SQLite, or transport input into UI/logs.
            assertConnection();
            return {item: {key, status: phase === "apply" && pending?.application ? "needs_recovery" : "failed", phase},
                // Shared authority failures must not hammer the remaining keys.
                stop: error instanceof ConfigSyncClientError};
        }
    }

    private createPending(binding: Binding, key: ConfigKey, base: string | null, snapshot: ConfigSnapshot): PendingConfigSync {
        const request = decodeConfigExchange({binding, key, base_revision: base, change_id: randomUUID(), modified_at: snapshot.modifiedAt,
            schema_version: 1, content: snapshot.content, sha256: configHash(snapshot.content)});
        return {request, snapshot};
    }

    private assertPendingBinding(pending: PendingConfigSync, binding: Binding, key: ConfigKey): void {
        if (pending.request.key !== key || !sameArchiveBinding(pending.request.binding, binding)) {
            throw new Error("Pending configuration sync belongs to a different authority.");
        }
    }
}
