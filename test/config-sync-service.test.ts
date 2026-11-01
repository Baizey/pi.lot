import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {ServerHttpError} from "../src/server/ServerHttpTransport.js";
import {ConfigSyncClient, ConfigSyncClientError} from "../src/server/config-sync/ConfigSyncClient.js";
import {ConfigSyncService} from "../src/server/config-sync/ConfigSyncService.js";
import {ConfigSyncJournal, type PendingConfigSync} from "../src/server/config-sync/ConfigSyncJournal.js";
import {configSyncStatus} from "../src/server/config-sync/ConfigSyncStatus.js";
import {
    canonicalConfigContent, configHash, CONFIG_KEYS, type ConfigCheck, type ConfigExchange,
    type ConfigKey, type ConfigOutcome, type ConfigSnapshot, type ConfigState,
} from "../src/server/config-sync/ConfigSyncProtocol.js";
import type {Binding} from "../src/server/ArchiveProtocol.js";
import {mockIsolatedDatabaseOpens} from "./fixtures/IsolatedTestDatabase.js";
import {initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {PolicyAccessType, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";

const CONFIG = {url: "https://configuration.example", apiKey: "connection-secret-never-synchronized"};
const BINDING: Binding = {server_id: "fixture-server", namespace_id: "fixture-namespace", history_generation: "fixture-generation"};
const TIME = "2026-01-01T00:00:00.000Z";
const DISPLAY = {normal: "full", alternate: "minimal"};
const NEW_DISPLAY = {normal: "minimal", alternate: "truncated"};

/** Ordinary CAS authority, not a second implementation of policy merging. No fetch or socket. */
class Authority {
    binding = {...BINDING};
    capabilities = ["config_sync_v1"];
    version = "0.4.0";
    versions = 0;
    bindings = 0;
    readonly checks: ConfigCheck[] = [];
    readonly exchanges: ConfigExchange[] = [];
    readonly states = new Map<ConfigKey, ConfigState>();
    private readonly receipts = new Map<string, {request: ConfigExchange; outcome: ConfigOutcome}>();
    onCheck: ((request: ConfigCheck) => void | Promise<void>) | undefined;
    afterExchange: ((request: ConfigExchange) => void | Promise<void>) | undefined;

    install(t: TestContext): void {
        t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
            assert.equal(new URL(input instanceof Request ? input.url : input).pathname, "/v1/version");
            assert.equal(init?.method, "GET");
            assert.equal(init?.body, undefined);
            this.versions++;
            return Response.json({version: this.version});
        });
        t.mock.method(ConfigSyncClient.prototype, "binding", async () => {
            this.bindings++;
            return {binding: {...this.binding}, head: "0", capabilities: [...this.capabilities]};
        });
        t.mock.method(ConfigSyncClient.prototype, "check", async (request: ConfigCheck) => {
            this.checks.push(structuredClone(request));
            await this.onCheck?.(request);
            const current = this.current(request.key);
            return {binding: {...this.binding}, key: request.key,
                sync_needed: request.known_revision !== current.revision || request.sha256 !== current.sha256};
        });
        t.mock.method(ConfigSyncClient.prototype, "sync", async (request: ConfigExchange) => {
            this.exchanges.push(structuredClone(request));
            const seen = this.receipts.get(request.change_id);
            if (seen) {
                assert.deepEqual(request, seen.request, "a retry retains the complete immutable request");
                return {...this.current(request.key), outcome: seen.outcome};
            }
            let current = this.current(request.key);
            let outcome: ConfigOutcome = "server_won";
            if (current.sha256 === request.sha256) outcome = "unchanged";
            else if (request.base_revision === current.revision || (request.base_revision === null && current.revision === "0" && request.content !== null)) {
                current = this.force(request.key, request.content);
                outcome = "client_won";
            }
            this.receipts.set(request.change_id, {request: structuredClone(request), outcome});
            await this.afterExchange?.(request);
            return {...current, outcome};
        });
    }

    current(key: ConfigKey): ConfigState {
        return this.states.get(key) ?? {binding: {...this.binding}, key, revision: "0", schema_version: 1,
            content: null, sha256: configHash(null), updated_at: null, outcome: "unchanged"};
    }

    force(key: ConfigKey, content: string | null): ConfigState {
        const state: ConfigState = {binding: {...this.binding}, key, revision: String(BigInt(this.current(key).revision) + 1n),
            schema_version: 1, content, sha256: configHash(content), updated_at: TIME, outcome: "client_won"};
        this.states.set(key, state);
        return state;
    }
}

function fixture(t: TestContext, configured = true) {
    mockIsolatedDatabaseOpens(t);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-config-sync-service-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    if (configured) store.save(CONFIG);
    const authority = new Authority();
    authority.install(t);
    const service = new ConfigSyncService(store);
    return {directory, store, authority, service,
        save(key: ConfigKey, value: unknown) { fs.writeFileSync(path.join(directory, `${key}.json`), canonicalConfigContent(value), {mode: 0o600}); },
        read(key: ConfigKey) { return fs.readFileSync(path.join(directory, `${key}.json`), "utf8"); },
        policies(action: (dao: PolicyDao, database: SqliteDatabase) => void) {
            const database = SqliteDatabase.open(path.join(directory, "pilot.sqlite"));
            const dao = new PolicyDao(database);
            try { dao.initializeSchema(); action(dao, database); }
            finally { database.close(); }
        },
        entry(key: ConfigKey) {
            const journal = new ConfigSyncJournal(directory);
            try { return journal.read(JSON.stringify([CONFIG.url, authority.binding]), key); }
            finally { journal.close(); }
        },
    };
}

function assertComplete(result: Awaited<ReturnType<ConfigSyncService["synchronize"]>>) {
    assert.equal(result.kind, "complete");
    if (result.kind !== "complete") throw new Error("Expected complete result");
    return result.items;
}

test("LOCAL masks stay private and removing them re-materializes GLOBAL rules without an exchange", async (t) => {
    const h = fixture(t);
    const rule = {pattern: "masked.example:443", accessType: PolicyAccessType.HTTP_GET, status: PolicyResponse.ALLOWED, reason: "shared global"};
    const bundle = canonicalConfigContent({rules: [rule]});
    h.authority.force("global-policies", bundle);
    const mask = () => h.policies((dao) => dao.upsertPolicies([{pattern: rule.pattern,
        info: {[rule.accessType]: {...rule, lifetime: PolicyLifetime.LOCAL, status: PolicyResponse.DENIED, reason: "private local mask"}}}]));
    mask();
    await h.service.synchronize();
    assert.equal(h.entry("global-policies").base!.content, bundle);
    assert.equal(h.entry("global-policies").materialized, null);
    const exchanges = h.authority.exchanges.length;
    h.policies((dao) => dao.deletePolicy(rule.pattern, rule.accessType));
    const restored = assertComplete(await h.service.synchronize());
    assert.equal(restored.find((item) => item.key === "global-policies")!.status, "applied");
    assert.equal(h.entry("global-policies").materialized, bundle);
    assert.equal(h.authority.exchanges.length, exchanges);
    h.policies((dao) => assert.equal(dao.loadPolicies()[0]!.info[rule.accessType]!.lifetime, PolicyLifetime.GLOBAL));
    // Mask a previously materialized rule: this is not a remote GLOBAL deletion.
    mask();
    await h.service.synchronize();
    assert.equal(h.authority.current("global-policies").content, bundle);
    assert.equal(h.authority.exchanges.length, exchanges);
    assert.equal(h.entry("global-policies").materialized, null);
    assert.equal(JSON.stringify(h.authority.exchanges).includes("private local mask"), false);
    h.policies((dao) => dao.deletePolicy(rule.pattern, rule.accessType));
    await h.service.synchronize();
    h.policies((dao) => dao.deletePolicy(rule.pattern, rule.accessType));
    await h.service.synchronize();
    assert.equal(h.authority.current("global-policies").content, null, "a genuine GLOBAL deletion still synchronizes");
});

test("GLOBAL restoration reports application when revision churn returns an unchanged decision", async (t) => {
    const h = fixture(t);
    const rule = {pattern: "revision-churn.example:443", accessType: PolicyAccessType.HTTP_GET,
        status: PolicyResponse.ALLOWED, reason: "shared global"};
    const bundle = canonicalConfigContent({rules: [rule]});
    h.authority.force("global-policies", bundle);
    h.policies((dao) => dao.upsertPolicies([{pattern: rule.pattern,
        info: {[rule.accessType]: {...rule, lifetime: PolicyLifetime.LOCAL, status: PolicyResponse.DENIED}}}]));
    await h.service.synchronize();
    assert.equal(h.entry("global-policies").materialized, null);
    h.policies((dao) => dao.deletePolicy(rule.pattern, rule.accessType));
    h.authority.force("global-policies", null);
    const current = h.authority.force("global-policies", bundle);
    const result = assertComplete(await h.service.synchronize());
    assert.deepEqual(result.find((item) => item.key === "global-policies"),
        {key: "global-policies", status: "applied", outcome: "unchanged"});
    assert.equal(h.entry("global-policies").base!.revision, current.revision);
    assert.equal(h.entry("global-policies").materialized, bundle);
    h.policies((dao) => assert.equal(dao.loadPolicies()[0]!.info[rule.accessType]!.lifetime, PolicyLifetime.GLOBAL));
});

test("disabling automatic sync revokes an in-flight check without losing pending work", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    await h.service.enableAutomatic();
    const exchanges = h.authority.exchanges.length;
    h.save("display-defaults", NEW_DISPLAY);
    h.authority.onCheck = () => h.service.disableAutomatic();
    assert.equal(await h.service.synchronizeAutomatic(), undefined);
    assert.equal(h.authority.exchanges.length, exchanges);
    assert.ok(h.entry("display-defaults").pending);
    h.authority.onCheck = undefined;
    assertComplete(await h.service.synchronize());
    assert.equal(h.authority.current("display-defaults").content, canonicalConfigContent(NEW_DISPLAY));
    assert.equal(await h.service.synchronizeAutomatic(), undefined);
});

test("unconfigured and legacy automatic checks send nothing and create no journal", async (t) => {
    const h = fixture(t, false);
    assert.deepEqual(await h.service.synchronize(), {kind: "unconfigured"});
    assert.equal(await h.service.synchronizeAutomatic(), undefined);
    assert.equal(h.authority.bindings, 0);
    assert.equal(fs.existsSync(path.join(h.directory, "pilot.sqlite")), false);
    h.store.save(CONFIG);
    assert.equal(await h.service.synchronizeAutomatic(), undefined);
    assert.equal(h.authority.bindings, 0);
    assert.equal(fs.existsSync(path.join(h.directory, "pilot.sqlite")), false);
});

test("five independent snapshots bootstrap once, then only optimistic checks run", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    h.save("subagent-defaults", initialSubagentDefaults);
    h.save("policy-defaults", initialPolicyDefaults);
    h.save("web-search", {version: 1, providers: ["brave"], brave: {apiKey: "saved-web-search-secret"}});
    fs.writeFileSync(path.join(h.directory, "credential-ipc.json"), "do-not-sync-this-machine-path");
    const connection = fs.readFileSync(h.store.file);
    const first = assertComplete(await h.service.synchronize());
    assert.equal(first.length, 5);
    assert.ok(first.every((item) => item.status !== "failed"));
    assert.deepEqual(h.authority.exchanges.map((request) => request.key), [...CONFIG_KEYS]);
    assert.equal(JSON.stringify(h.authority.exchanges).includes(CONFIG.apiKey), false);
    assert.equal(JSON.stringify(h.authority.exchanges).includes("do-not-sync-this-machine-path"), false);
    assert.deepEqual(fs.readFileSync(h.store.file), connection, "connection config stays local");
    assert.equal(fs.existsSync(path.join(h.directory, "config-sync.enabled")), false, "manual sync does not enable automatic secret upload");
    assert.ok(assertComplete(await h.service.synchronize()).every((item) => item.status === "unchanged"));
    assert.equal(h.authority.exchanges.length, 5);
    assert.equal(h.authority.checks.length, 10);
    h.save("display-defaults", NEW_DISPLAY);
    assert.ok(assertComplete(await h.service.synchronize()).every((item) => item.status !== "failed"));
    assert.equal(h.authority.exchanges.length, 6);
    assert.equal(h.authority.current("display-defaults").revision, "2");
    assert.equal(h.authority.current("subagent-defaults").revision, "1");
});

test("capture precedes the check and a newer local save is deferred, then sent next time", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    let changed = false;
    h.authority.onCheck = (request) => {
        if (request.key === "display-defaults" && !changed) {
            changed = true;
            h.save("display-defaults", NEW_DISPLAY);
        }
    };
    const first = assertComplete(await h.service.synchronize());
    assert.equal(first[0]!.status, "deferred");
    assert.equal(h.authority.exchanges[0]!.content, canonicalConfigContent(DISPLAY));
    assert.equal(h.read("display-defaults"), canonicalConfigContent(NEW_DISPLAY));
    assert.equal(h.entry("display-defaults").materialized, canonicalConfigContent(DISPLAY));
    const next = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(next[0]!.status, "applied");
    assert.equal(h.authority.current("display-defaults").content, canonicalConfigContent(NEW_DISPLAY));
});

test("lost accepted responses reuse the durable identity across restart and receive current state", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    let lose = true;
    h.authority.afterExchange = (request) => {
        if (request.key === "display-defaults" && lose) {
            lose = false;
            throw new ConfigSyncClientError(new ServerHttpError("Connection failed.", undefined, {kind: "transport"}));
        }
    };
    const first = assertComplete(await h.service.synchronize());
    assert.deepEqual(first, [{key: "display-defaults", status: "failed", phase: "exchange"}]);
    const sent = h.authority.exchanges[0]!;
    assert.deepEqual(h.entry("display-defaults").pending!.request, sent);
    const newer = h.authority.force("display-defaults", canonicalConfigContent(NEW_DISPLAY));
    const next = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(next[0]!.status, "applied");
    assert.deepEqual(h.authority.exchanges[1], sent);
    assert.equal(h.authority.current("display-defaults").revision, newer.revision, "retry did not reapply the original operation");
    assert.equal(h.read("display-defaults"), newer.content);
    assert.equal(h.entry("display-defaults").base!.revision, newer.revision);
    assert.equal(h.entry("display-defaults").pending, undefined);
    const journal = new ConfigSyncJournal(h.directory);
    try {
        const row = journal.database().prepare("SELECT snapshot FROM config_sync_recovery WHERE change_id=?").get(sent.change_id) as {snapshot: string};
        assert.equal(JSON.parse(row.snapshot).pending.request.content, sent.content);
    } finally { journal.close(); }
});

test("a lost unchanged response retries its exact identity and visibly imports current state during automatic startup", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    h.authority.force("display-defaults", canonicalConfigContent(DISPLAY));
    h.authority.afterExchange = (request) => {
        if (request.key === "display-defaults") {
            throw new ConfigSyncClientError(new ServerHttpError("Connection failed.", undefined, {kind: "transport"}));
        }
    };
    assert.deepEqual(assertComplete(await h.service.enableAutomatic()),
        [{key: "display-defaults", status: "failed", phase: "exchange"}]);
    const original = structuredClone(h.entry("display-defaults").pending!.request);
    const current = h.authority.force("display-defaults", canonicalConfigContent(NEW_DISPLAY));
    const recovered = await new ConfigSyncService(h.store).synchronizeAutomatic();
    assert.ok(recovered);
    const items = assertComplete(recovered);
    assert.deepEqual(h.authority.exchanges[1], original);
    assert.deepEqual(items[0], {key: "display-defaults", status: "applied", outcome: "unchanged"});
    assert.equal(items.every((item) => item.status === "unchanged"), false, "startup must not suppress the import notice");
    assert.equal(h.read("display-defaults"), current.content);
    assert.equal(h.entry("display-defaults").base!.revision, current.revision);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assert.match(configSyncStatus(recovered).message, /display-defaults: applied \(unchanged\)/);
});

test("a stale ordinary change accepts the server winner and privately retains the losing candidate", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    await h.service.synchronize();
    const remote = {normal: "truncated", alternate: "full"};
    h.authority.force("display-defaults", canonicalConfigContent(remote));
    h.save("display-defaults", NEW_DISPLAY);
    const items = assertComplete(await h.service.synchronize());
    assert.equal(items[0]!.outcome, "server_won");
    assert.equal(h.read("display-defaults"), canonicalConfigContent(remote));
    assert.equal(configSyncStatus({kind: "complete", items}).message.includes(CONFIG.apiKey), false);
    const journal = new ConfigSyncJournal(h.directory);
    try {
        const row = journal.database().prepare("SELECT snapshot FROM config_sync_recovery WHERE item='display-defaults'").get() as {snapshot: string};
        assert.equal(JSON.parse(row.snapshot).pending.request.content, canonicalConfigContent(NEW_DISPLAY));
    } finally { journal.close(); }
});

test("deleting a saved file submits an explicit reset, without resetting other keys", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    await h.service.synchronize();
    fs.unlinkSync(path.join(h.directory, "display-defaults.json"));
    await h.service.synchronize();
    const reset = h.authority.exchanges.at(-1)!;
    assert.equal(reset.key, "display-defaults");
    assert.equal(reset.base_revision, "1");
    assert.equal(reset.content, null);
    assert.equal(h.authority.current("display-defaults").revision, "2");
    assert.equal(h.authority.current("display-defaults").content, null);
    await h.service.synchronize();
    assert.equal(h.authority.exchanges.at(-1)!.change_id, reset.change_id);
});

for (const mode of ["manual", "enable", "recover"] as const) {
    test(`${mode} rejects pi.server 0.3 before binding, capture, or sync state changes even when capability is advertised`, async (t) => {
        const h = fixture(t);
        h.authority.version = "0.3.99";
        fs.writeFileSync(path.join(h.directory, "display-defaults.json"), "invalid-sensitive-source");
        const result = mode === "manual" ? h.service.synchronize() : mode === "enable"
            ? h.service.enableAutomatic() : h.service.recover("display-defaults", "local");
        await assert.rejects(result, {name: "ConfigSyncClientError", kind: "configuration",
            message: "Configuration synchronization requires pi.server 0.4.*."});
        assert.equal(h.authority.versions, 1);
        assert.equal(h.authority.bindings, 0);
        assert.equal(h.authority.checks.length, 0);
        assert.equal(h.authority.exchanges.length, 0);
        assert.equal(fs.existsSync(path.join(h.directory, "pilot.sqlite")), false);
        assert.equal(fs.existsSync(path.join(h.directory, "config-sync.enabled")), false);
        assert.equal(h.read("display-defaults"), "invalid-sensitive-source");
    });
}

test("pi.server 0.4 compatibility, not optional capability metadata, authorizes the configuration pass", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    h.authority.capabilities = [];
    const result = assertComplete(await h.service.synchronize());
    assert.equal(result.length, 5);
    assert.equal(h.authority.versions, 1, "one preflight per pass, not per item");
    assert.equal(h.authority.exchanges.length, 5);
});

test("an opted-in startup pass rejects a downgraded server and preserves local consent and state", async (t) => {
    const h = fixture(t);
    await h.service.enableAutomatic();
    const before = h.entry("display-defaults");
    const bindings = h.authority.bindings;
    const exchanges = h.authority.exchanges.length;
    h.authority.version = "0.3.0";
    await assert.rejects(h.service.synchronizeAutomatic(), /requires pi\.server 0\.4\.\*/);
    assert.equal(h.authority.bindings, bindings);
    assert.equal(h.authority.exchanges.length, exchanges);
    assert.deepEqual(h.entry("display-defaults"), before);
    assert.equal(fs.existsSync(path.join(h.directory, "config-sync.enabled")), true);
});

test("automatic startup checks require per-device opt-in and the exact approved binding", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    await h.service.enableAutomatic();
    assert.equal(fs.existsSync(path.join(h.directory, "config-sync.enabled")), true);
    assert.ok(assertComplete((await h.service.synchronizeAutomatic())!).every((item) => item.status === "unchanged"));
    h.authority.binding = {...BINDING, history_generation: "new-generation"};
    const checks = h.authority.checks.length;
    assert.deepEqual(await h.service.synchronizeAutomatic(), {kind: "binding_changed"});
    assert.equal(h.authority.checks.length, checks);
    h.service.disableAutomatic();
    assert.equal(await h.service.synchronizeAutomatic(), undefined);
    assert.equal(fs.existsSync(path.join(h.directory, "config-sync.enabled")), false);
    assert.equal(fs.existsSync(path.join(h.directory, "pilot.sqlite")), true);
});

test("logout or connection generation changes stop stale response application", async (t) => {
    const h = fixture(t);
    h.save("display-defaults", DISPLAY);
    h.authority.force("display-defaults", canonicalConfigContent(NEW_DISPLAY));
    h.authority.onCheck = (request) => { if (request.key === "display-defaults") h.store.logout(); };
    await assert.rejects(h.service.synchronize(), /authorization changed/);
    assert.equal(h.authority.exchanges.length, 0);
    assert.equal(h.read("display-defaults"), canonicalConfigContent(DISPLAY));
    assert.ok(h.entry("display-defaults").pending);
});

test("cancellation stops the pass without clearing its pending snapshot", async (t) => {
    const h = fixture(t);
    const controller = new AbortController();
    h.save("display-defaults", DISPLAY);
    h.authority.onCheck = () => { controller.abort(new Error("cancelled")); };
    await assert.rejects(h.service.synchronize(controller.signal), /cancelled/);
    assert.equal(h.authority.exchanges.length, 0);
    assert.ok(h.entry("display-defaults").pending);
    assertComplete(await h.service.synchronize());
});

test("invalid local content is not dispatched or exposed and does not block other keys", async (t) => {
    const h = fixture(t);
    const secret = "sensitive-web-search-input";
    fs.writeFileSync(path.join(h.directory, "web-search.json"), `{"${secret}":`, {mode: 0o600});
    const result = await h.service.synchronize();
    const items = assertComplete(result);
    assert.deepEqual(items.find((item) => item.key === "web-search"), {key: "web-search", status: "failed", phase: "capture"});
    assert.equal(h.authority.exchanges.some((request) => request.key === "web-search"), false);
    assert.equal(items.find((item) => item.key === "global-policies")!.status, "unchanged");
    assert.equal(configSyncStatus(result).message.includes(secret), false);
    assert.equal(h.read("web-search"), `{"${secret}":`);
});

const SOURCE_A = canonicalConfigContent(DISPLAY);
const IMPORT_B = canonicalConfigContent(NEW_DISPLAY);
const WINNER_C = canonicalConfigContent({normal: "truncated", alternate: "full"});
const EDIT_D = canonicalConfigContent({normal: "minimal", alternate: "full"});
const WINNER_E = canonicalConfigContent({normal: "full", alternate: "full"});

test("a JSON write surviving failed acknowledgement stays ambiguous after the server advances across repeated restarts", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const latest = h.authority.force("display-defaults", WINNER_C);
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
        assert.equal(result[0]!.status, "needs_recovery");
        assert.equal(savedJson(h), IMPORT_B);
        assert.deepEqual(h.entry("display-defaults").pending, h.interrupted);
        assert.equal(h.entry("display-defaults").base, undefined, "the interrupted import was never acknowledged");
        assert.equal(h.authority.current("display-defaults").revision, latest.revision);
    }
    const requests = displayExchanges(h);
    assert.equal(requests.length, 3);
    for (const request of requests) assert.deepEqual(request, h.interrupted.request);
    assert.equal(requests.some((request) => request.content === IMPORT_B), false, "an imported file is not a fresh local candidate");
});

test("a failed rename followed by the user's independent save of the same target is also ambiguous", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B, true);
    assert.equal(savedJson(h), SOURCE_A, "the durable intent did not imply a successful rename");
    writeJson(h, IMPORT_B);
    h.authority.force("display-defaults", WINNER_C);
    const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(result[0]!.status, "needs_recovery");
    assert.equal(savedJson(h), IMPORT_B);
    assert.deepEqual(h.entry("display-defaults").pending, h.interrupted);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
});

test("a genuinely newer local save is never overwritten or uploaded while an application intent is unresolved", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    writeJson(h, EDIT_D);
    h.authority.force("display-defaults", WINNER_C);
    const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(result[0]!.status, "needs_recovery");
    assert.equal(savedJson(h), EDIT_D);
    assert.deepEqual(h.entry("display-defaults").pending, h.interrupted);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
});

test("automatic recovery is safe when the local file is still the original approved capture", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    writeJson(h, SOURCE_A);
    const latest = h.authority.force("display-defaults", WINNER_C);
    const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(result[0]!.status, "applied");
    assert.equal(savedJson(h), WINNER_C);
    assert.equal(h.entry("display-defaults").base!.revision, latest.revision);
    assert.equal(h.entry("display-defaults").materialized, WINNER_C);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
});

test("automatic recovery acknowledges a local file already equal to the current winner without another rename", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const latest = h.authority.force("display-defaults", WINNER_C);
    writeJson(h, WINNER_C);
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
        if (String(target) === displayFile(h)) throw new Error("already-materialized winner must not be renamed again");
        return rename(source, target);
    });
    const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(result[0]!.status, "applied");
    assert.equal(savedJson(h), WINNER_C);
    assert.equal(h.entry("display-defaults").base!.revision, latest.revision);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
});

test("interrupted reset/replacement combinations remain ambiguous rather than treating null as an acknowledgement", async (t) => {
    for (const [source, imported, latest] of [
        [SOURCE_A, null, WINNER_C],
        [null, IMPORT_B, WINNER_C],
        [SOURCE_A, IMPORT_B, null],
    ] as const) {
        const h = await interruptedJsonApplication(t, source, imported);
        const current = h.authority.force("display-defaults", latest);
        const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
        assert.equal(result[0]!.status, "needs_recovery");
        assert.equal(savedJson(h), imported);
        assert.deepEqual(h.entry("display-defaults").pending, h.interrupted);
        assert.equal(h.authority.current("display-defaults").revision, current.revision);
        assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
    }
});

test("safe original/current-winner autorecovery also handles reset and replacement boundaries", async (t) => {
    for (const [source, imported, latest] of [
        [SOURCE_A, null, WINNER_C],
        [null, IMPORT_B, WINNER_C],
        [SOURCE_A, IMPORT_B, null],
    ] as const) {
        for (const selected of [source, latest]) {
            const h = await interruptedJsonApplication(t, source, imported);
            const current = h.authority.force("display-defaults", latest);
            writeJson(h, selected);
            const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
            assert.equal(result[0]!.status, "applied");
            assert.equal(savedJson(h), latest);
            assert.equal(h.entry("display-defaults").base!.revision, current.revision);
            assert.equal(h.entry("display-defaults").materialized, latest);
            assert.equal(h.entry("display-defaults").pending, undefined);
            assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
        }
    }
});

test("an advisory check returning false cannot bypass an unresolved application intent", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    h.authority.force("display-defaults", WINNER_C);
    const check = ConfigSyncClient.prototype.check;
    t.mock.method(ConfigSyncClient.prototype, "check", async function(this: ConfigSyncClient, ...args: Parameters<ConfigSyncClient["check"]>) {
        const result = await check.apply(this, args);
        return args[0].key === "display-defaults" ? {...result, sync_needed: false} : result;
    });
    const result = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(result[0]!.status, "needs_recovery");
    assert.equal(savedJson(h), IMPORT_B);
    assert.deepEqual(h.entry("display-defaults").pending, h.interrupted);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request, "the original identity must still be reconciled");
});

test("application-intent quota failure occurs before any source mutation and retains the immutable retry", async (t) => {
    const h = fixture(t);
    writeJson(h, SOURCE_A);
    h.authority.force("display-defaults", IMPORT_B);
    const prepare = ConfigSyncJournal.prototype.prepareApplication;
    let checked = false;
    const checkpoint = t.mock.method(ConfigSyncJournal.prototype, "prepareApplication",
        function(this: ConfigSyncJournal, ...args: Parameters<ConfigSyncJournal["prepareApplication"]>) {
            if (args[1] === "display-defaults") {
                checked = true;
                assert.equal(savedJson(h), SOURCE_A, "quota must be reserved before rename/unlink");
                throw new Error("Configuration synchronization journal is full; retained work was not removed.");
            }
            return prepare.apply(this, args);
        });
    const result = assertComplete(await h.service.synchronize());
    assert.equal(checked, true);
    assert.deepEqual(result[0], {key: "display-defaults", status: "failed", phase: "apply"});
    assert.equal(savedJson(h), SOURCE_A);
    const pending = h.entry("display-defaults").pending;
    assert.ok(pending);
    assert.equal(pending.application, undefined);
    assert.deepEqual(pending.request, displayExchanges(h)[0]);
    checkpoint.mock.restore();
    const retried = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(retried[0]!.status, "applied");
    assert.equal(savedJson(h), IMPORT_B);
    assert.deepEqual(displayExchanges(h)[1], pending.request);
});

test("keep-local reconciles the old identity then sends a new based identity containing the pre-check selection, not a later save", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const current = h.authority.force("display-defaults", WINNER_C);
    const selectedTime = fs.statSync(displayFile(h)).mtime.toISOString();
    let changed = false;
    h.authority.onCheck = (request) => {
        if (request.key === "display-defaults" && !changed) {
            changed = true;
            writeJson(h, EDIT_D);
        }
    };
    const result = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "local"));
    assert.deepEqual(result.map((item) => item.status), ["deferred"]);
    assert.equal(savedJson(h), EDIT_D);
    const requests = displayExchanges(h);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[1], h.interrupted.request);
    assert.notEqual(requests[2]!.change_id, h.interrupted.request.change_id);
    assert.equal(requests[2]!.base_revision, current.revision);
    assert.equal(requests[2]!.content, IMPORT_B);
    assert.equal(requests[2]!.sha256, configHash(IMPORT_B));
    assert.equal(requests[2]!.modified_at, selectedTime);
    assert.equal(requests.some((request) => request.content === EDIT_D), false);
    assert.equal(h.authority.current("display-defaults").content, IMPORT_B);
    assert.equal(h.entry("display-defaults").materialized, IMPORT_B);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(h.authority.current("display-defaults").content, EDIT_D, "the later save is a separate subsequent operation");
});

test("accept-server preserves its selected snapshot but defers replacement if another local save occurs during HTTP", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const current = h.authority.force("display-defaults", WINNER_C);
    const selectedTime = fs.statSync(displayFile(h)).mtime.toISOString();
    h.authority.onCheck = (request) => {
        if (request.key === "display-defaults") writeJson(h, EDIT_D);
    };
    const result = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "server"));
    assert.deepEqual(result.map((item) => item.status), ["deferred"]);
    assert.equal(savedJson(h), EDIT_D);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
    assert.equal(displayExchanges(h).length, 2);
    assert.equal(h.authority.current("display-defaults").content, WINNER_C);
    assert.equal(h.entry("display-defaults").base!.revision, current.revision);
    assert.equal(h.entry("display-defaults").materialized, IMPORT_B);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assert.ok(retainedCaptures(h).some((snapshot) => snapshot.content === IMPORT_B && snapshot.modifiedAt === selectedTime));
});

test("accept-server durably preserves the selected file before replacing it with the current winner", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const current = h.authority.force("display-defaults", WINNER_C);
    const result = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "server"));
    assert.equal(result[0]!.status, "applied");
    assert.equal(savedJson(h), WINNER_C);
    assert.ok(retainedCaptures(h).some((snapshot) => snapshot.content === IMPORT_B));
    assert.equal(h.entry("display-defaults").base!.revision, current.revision);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assert.deepEqual(displayExchanges(h)[1], h.interrupted.request);
});

test("explicit server recovery can itself be interrupted repeatedly without losing its original request or selected snapshots", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const complete = ConfigSyncJournal.prototype.complete;
    const acknowledgement = t.mock.method(ConfigSyncJournal.prototype, "complete",
        function(this: ConfigSyncJournal, ...args: Parameters<ConfigSyncJournal["complete"]>) {
            if (args[1] === "display-defaults") throw new Error("fixture interruption before recovery acknowledgement");
            return complete.apply(this, args);
        });
    for (const [selected, winner] of [[IMPORT_B, WINNER_C], [WINNER_C, EDIT_D]] as const) {
        const current = h.authority.force("display-defaults", winner);
        const result = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "server"));
        assert.equal(result[0]!.status, "needs_recovery");
        assert.equal(savedJson(h), winner);
        const pending = h.entry("display-defaults").pending!;
        assert.deepEqual(pending.request, h.interrupted.request);
        assert.deepEqual(pending.snapshot, h.interrupted.snapshot);
        assert.equal(pending.application!.captured.materialized, selected);
        assert.equal(pending.application!.state.revision, current.revision);
        assert.equal(pending.application!.materialized, winner);
        assert.ok(retainedCaptures(h).some((snapshot) => snapshot.content === selected));
    }
    acknowledgement.mock.restore();
    h.authority.force("display-defaults", WINNER_E);
    const unresolved = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(unresolved[0]!.status, "needs_recovery");
    assert.equal(savedJson(h), EDIT_D);
    const recovered = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "server"));
    assert.equal(recovered[0]!.status, "applied");
    assert.equal(savedJson(h), WINNER_E);
    assert.equal(h.entry("display-defaults").pending, undefined);
    for (const request of displayExchanges(h)) assert.deepEqual(request, h.interrupted.request);
});

test("an interrupted keep-local rebase retains the old intent until a fresh explicit choice completes atomically", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const current = h.authority.force("display-defaults", WINNER_C);
    const rebase = t.mock.method(ConfigSyncJournal.prototype, "rebase", () => { throw new Error("fixture rebase transaction interrupted"); });
    const interrupted = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "local"));
    assert.equal(interrupted[0]!.status, "needs_recovery");
    assert.equal(savedJson(h), IMPORT_B);
    assert.deepEqual(h.entry("display-defaults").pending, h.interrupted);
    assert.equal(h.entry("display-defaults").base, undefined);
    rebase.mock.restore();
    const recovered = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "local"));
    assert.equal(recovered[0]!.status, "applied");
    const requests = displayExchanges(h);
    assert.deepEqual(requests[1], h.interrupted.request);
    assert.deepEqual(requests[2], h.interrupted.request);
    assert.notEqual(requests[3]!.change_id, h.interrupted.request.change_id);
    assert.equal(requests[3]!.base_revision, current.revision);
    assert.equal(requests[3]!.content, IMPORT_B);
    assert.equal(savedJson(h), IMPORT_B);
    assert.equal(h.entry("display-defaults").pending, undefined);
});

test("lost keep-local responses reopen the new pending identity without rereading a still-newer local save", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    const current = h.authority.force("display-defaults", WINNER_C);
    let lose = true;
    h.authority.afterExchange = (request) => {
        if (request.key === "display-defaults" && request.change_id !== h.interrupted.request.change_id && lose) {
            lose = false;
            throw new ConfigSyncClientError(new ServerHttpError("Connection failed.", undefined, {kind: "transport"}));
        }
    };
    const interrupted = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "local"));
    assert.deepEqual(interrupted, [{key: "display-defaults", status: "failed", phase: "exchange"}]);
    const pending = h.entry("display-defaults").pending!;
    assert.notEqual(pending.request.change_id, h.interrupted.request.change_id);
    assert.equal(pending.request.content, IMPORT_B);
    assert.equal(pending.request.base_revision, current.revision);
    assert.equal(pending.application, undefined);
    assert.equal(h.entry("display-defaults").base!.revision, current.revision);
    writeJson(h, EDIT_D);
    const recovered = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(recovered[0]!.status, "deferred");
    assert.equal(savedJson(h), EDIT_D);
    const requests = displayExchanges(h);
    assert.deepEqual(requests[1], h.interrupted.request);
    assert.deepEqual(requests[2], pending.request);
    assert.deepEqual(requests[3], pending.request);
    assert.equal(h.entry("display-defaults").pending, undefined);
    assert.equal(h.authority.current("display-defaults").content, IMPORT_B);
});

test("automatic recovery can use the approved capture from an interrupted explicit choice rather than the original upload snapshot", async (t) => {
    const h = await interruptedJsonApplication(t, SOURCE_A, IMPORT_B);
    h.authority.force("display-defaults", WINNER_C);
    const complete = ConfigSyncJournal.prototype.complete;
    const acknowledgement = t.mock.method(ConfigSyncJournal.prototype, "complete",
        function(this: ConfigSyncJournal, ...args: Parameters<ConfigSyncJournal["complete"]>) {
            if (args[1] === "display-defaults") throw new Error("fixture explicit acknowledgement interrupted");
            return complete.apply(this, args);
        });
    const interrupted = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", "server"));
    assert.equal(interrupted[0]!.status, "needs_recovery");
    acknowledgement.mock.restore();
    const pending = h.entry("display-defaults").pending!;
    assert.equal(pending.snapshot.materialized, SOURCE_A);
    assert.equal(pending.application!.captured.materialized, IMPORT_B);
    assert.equal(savedJson(h), WINNER_C);
    writeJson(h, IMPORT_B);
    const latest = h.authority.force("display-defaults", EDIT_D);
    const recovered = assertComplete(await new ConfigSyncService(h.store).synchronize());
    assert.equal(recovered[0]!.status, "applied");
    assert.equal(savedJson(h), EDIT_D);
    assert.equal(h.entry("display-defaults").base!.revision, latest.revision);
    assert.equal(h.entry("display-defaults").pending, undefined);
    for (const request of displayExchanges(h)) assert.deepEqual(request, h.interrupted.request);
});

test("both explicit recovery choices retain reset/null semantics across file deletion and replacement", async (t) => {
    for (const direction of ["local", "server"] as const) {
        for (const [source, imported, latest] of [
            [SOURCE_A, null, WINNER_C],
            [null, IMPORT_B, null],
        ] as const) {
            const h = await interruptedJsonApplication(t, source, imported);
            const current = h.authority.force("display-defaults", latest);
            const result = assertComplete(await new ConfigSyncService(h.store).recover("display-defaults", direction));
            assert.deepEqual(result.map((item) => item.status), ["applied"]);
            const selected = direction === "local" ? imported : latest;
            assert.equal(savedJson(h), selected);
            assert.equal(h.authority.current("display-defaults").content, selected);
            assert.equal(h.entry("display-defaults").materialized, selected);
            assert.equal(h.entry("display-defaults").pending, undefined);
            const requests = displayExchanges(h);
            assert.deepEqual(requests[1], h.interrupted.request);
            if (direction === "local") {
                assert.equal(requests.length, 3);
                assert.notEqual(requests[2]!.change_id, h.interrupted.request.change_id);
                assert.equal(requests[2]!.base_revision, current.revision);
                assert.equal(requests[2]!.content, imported);
                assert.equal(requests[2]!.sha256, configHash(imported));
            } else {
                assert.equal(requests.length, 2);
                assert.ok(retainedCaptures(h).some((capture) => capture.content === imported));
            }
        }
    }
});

function displayFile(h: ReturnType<typeof fixture>): string {
    return path.join(h.directory, "display-defaults.json");
}

function writeJson(h: ReturnType<typeof fixture>, content: string | null): void {
    if (content === null) fs.rmSync(displayFile(h), {force: true});
    else fs.writeFileSync(displayFile(h), content, {mode: 0o600});
}

function savedJson(h: ReturnType<typeof fixture>): string | null {
    return fs.existsSync(displayFile(h)) ? h.read("display-defaults") : null;
}

function displayExchanges(h: ReturnType<typeof fixture>): ConfigExchange[] {
    return h.authority.exchanges.filter((request) => request.key === "display-defaults");
}

function retainedCaptures(h: ReturnType<typeof fixture>): ConfigSnapshot[] {
    const journal = new ConfigSyncJournal(h.directory);
    try {
        const rows = journal.database().prepare("SELECT snapshot FROM config_sync_recovery WHERE item='display-defaults'").all() as {snapshot: string}[];
        return rows.flatMap((row) => {
            const recovery = JSON.parse(row.snapshot) as {captured?: ConfigSnapshot};
            return recovery.captured ? [recovery.captured] : [];
        });
    } finally { journal.close(); }
}

async function interruptedJsonApplication(t: TestContext, source: string | null, winner: string | null, beforeMutation = false) {
    const h = fixture(t);
    writeJson(h, source);
    const remote = h.authority.force("display-defaults", winner);
    const complete = ConfigSyncJournal.prototype.complete;
    const acknowledgement = t.mock.method(ConfigSyncJournal.prototype, "complete",
        function(this: ConfigSyncJournal, ...args: Parameters<ConfigSyncJournal["complete"]>) {
            if (args[1] === "display-defaults" && !beforeMutation) {
                assert.equal(savedJson(h), winner, "the file mutation precedes metadata acknowledgement");
                throw new Error("fixture crash before metadata acknowledgement");
            }
            return complete.apply(this, args);
        });
    const rename = fs.renameSync;
    const interruption = beforeMutation ? t.mock.method(fs, "renameSync", (temporary: fs.PathLike, target: fs.PathLike) => {
        if (String(target) === displayFile(h)) throw new Error("fixture rename failed after durable beforeWrite checkpoint");
        return rename(temporary, target);
    }) : undefined;
    const result = assertComplete(await h.service.synchronize());
    acknowledgement.mock.restore();
    interruption?.mock.restore();
    assert.deepEqual(result[0], {key: "display-defaults", status: "needs_recovery", phase: "apply"});
    assert.equal(savedJson(h), beforeMutation ? source : winner);
    const pending = h.entry("display-defaults").pending;
    assert.ok(pending?.application);
    assert.equal(pending.request.content, source);
    assert.equal(pending.snapshot.materialized, source);
    assert.deepEqual(pending.application.state, {...remote, outcome: "server_won"});
    assert.equal(pending.application.captured.materialized, source);
    assert.equal(pending.application.materialized, winner);
    const interrupted: PendingConfigSync = structuredClone(pending);
    return {...h, interrupted};
}
