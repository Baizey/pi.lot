import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {type Binding} from "../src/server/ArchiveProtocol.js";
import {ConfigSyncAdapters} from "../src/server/config-sync/ConfigSyncAdapters.js";
import {ConfigSyncJournal, type PendingConfigSync} from "../src/server/config-sync/ConfigSyncJournal.js";
import {
    canonicalConfigContent,
    configHash,
    type ConfigKey,
    type ConfigOutcome,
    type ConfigState,
} from "../src/server/config-sync/ConfigSyncProtocol.js";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {PolicyAccessType, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";
import {mockIsolatedDatabaseOpens} from "./fixtures/IsolatedTestDatabase.js";

const binding: Binding = {server_id: "fixture-server", namespace_id: "fixture-namespace", history_generation: "generation-1"};
const origin = "https://first.example.test";
const otherOrigin = "https://second.example.test";
const destination = JSON.stringify([origin, binding]);
const modifiedAt = "2026-01-02T03:04:05.006Z";
const displayA = canonicalConfigContent({normal: "minimal", alternate: "truncated"});
const displayB = canonicalConfigContent({normal: "full", alternate: "minimal"});
const displayC = canonicalConfigContent({normal: "hidden", alternate: "full"});
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

test("begin durably freezes exact request, materialized snapshot, and previous base across reopen", (t) => {
    const {journal, reopen} = fixture(t);
    const initial = makePending("display-defaults", displayA);
    const base = stateFor(initial, displayA, {revision: "7"});
    accept(journal, initial, base);
    const work = makePending("display-defaults", displayB, {baseRevision: "7", changeId: secondId, materialized: displayA});
    const frozen = structuredClone(work);
    journal.begin(destination, "display-defaults", work);

    work.request.content = displayC;
    work.request.sha256 = configHash(displayC);
    work.request.base_revision = "99";
    work.request.binding.history_generation = "mutated-after-begin";
    work.snapshot.content = displayC;
    work.snapshot.materialized = displayC;
    work.snapshot.modifiedAt = "2026-02-03T04:05:06.007Z";
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recovered.read(destination, "display-defaults"), {base, materialized: displayA, pending: frozen});
    const returned = recovered.read(destination, "display-defaults");
    assert.ok(returned.pending);
    returned.pending.request.change_id = firstId;
    returned.pending.snapshot.materialized = null;
    assert.deepEqual(recovered.read(destination, "display-defaults").pending, frozen);
    assert.throws(() => recovered.begin(destination, "display-defaults", frozen), /pending work/);
    assert.deepEqual(recovered.read(destination, "display-defaults").pending, frozen);
});

test("bases and pending identities remain isolated across origins and binding generations", (t) => {
    const {journal, reopen} = fixture(t);
    const work = makePending("display-defaults", displayA);
    const other = makePending("display-defaults", displayB, {changeId: secondId});
    const nextGeneration = {...binding, history_generation: "generation-2"};
    const rebound = makePending("display-defaults", displayC);
    rebound.request.binding = nextGeneration;
    const otherDestination = JSON.stringify([otherOrigin, binding]);
    const reboundDestination = JSON.stringify([origin, nextGeneration]);
    journal.begin(destination, "display-defaults", work);
    journal.begin(otherDestination, "display-defaults", other);
    journal.begin(reboundDestination, "display-defaults", rebound);
    const accepted = stateFor(other);
    journal.complete(otherDestination, "display-defaults", other, accepted,
        () => ({applied: true, materialized: displayB}));
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recovered.read(destination, "display-defaults").pending, work);
    assert.equal(recovered.read(destination, "display-defaults").base, undefined);
    assert.deepEqual(recovered.read(otherDestination, "display-defaults").base, accepted);
    assert.equal(recovered.read(otherDestination, "display-defaults").pending, undefined);
    assert.deepEqual(recovered.read(reboundDestination, "display-defaults").pending, rebound);
    assert.equal(recovered.read(reboundDestination, "display-defaults").base, undefined);
});

test("completion rejects mismatched pending identity, content, base, materialization, timestamp, and destination before applying", (t) => {
    const {journal} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    const original = structuredClone(work);
    const apply = t.mock.fn(() => ({applied: true, materialized: displayB}));
    const winner = stateFor(work, displayB, {outcome: "server_won"});
    const variants: PendingConfigSync[] = [
        {...work, request: {...work.request, change_id: secondId}},
        {...work, request: {...work.request, base_revision: "8"}},
        {...work, snapshot: {...work.snapshot, materialized: displayC}},
        makePending("display-defaults", displayC),
        {...work, request: {...work.request, modified_at: "2026-02-03T04:05:06.007Z"},
            snapshot: {...work.snapshot, modifiedAt: "2026-02-03T04:05:06.007Z"}},
    ];
    for (const changed of variants) {
        assert.throws(() => journal.complete(destination, "display-defaults", changed, winner, apply), /journal changed/);
        assert.deepEqual(journal.read(destination, "display-defaults").pending, original);
    }
    assert.throws(() => journal.complete("different-destination", "display-defaults", work, winner, apply), /journal changed/);
    assert.throws(() => journal.complete(destination, "subagent-defaults", work, winner, apply));
    assert.equal(apply.mock.callCount(), 0);
    assert.deepEqual(recoveries(journal), []);
});

test("completion rejects a response for another key or pinned binding without applying or acknowledging", (t) => {
    const {journal} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    const apply = t.mock.fn(() => ({applied: true, materialized: null}));
    const otherBinding = {...binding, history_generation: "generation-2"};
    const wrongKey = {...stateFor(work, null), key: "subagent-defaults" as const};
    for (const winner of [wrongKey, stateFor(work, null, {binding: otherBinding})]) {
        assert.throws(() => journal.complete(destination, "display-defaults", work, winner, apply), /Invalid configuration sync response/);
    }
    assert.equal(apply.mock.callCount(), 0);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
    assert.deepEqual(recoveries(journal), []);
});

test("unchanged requires an acknowledged base rather than guessing an uninitialized revision", (t) => {
    const {journal} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    assert.throws(() => journal.unchanged(destination, "display-defaults", work), /Invalid configuration synchronization check/);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
});

for (const mismatch of ["revision", "hash"] as const) {
    test(`unchanged rejects a ${mismatch} mismatch and retains the exact pending exchange`, (t) => {
        const {journal} = fixture(t);
        const initial = makePending("display-defaults", displayA);
        const base = stateFor(initial, displayA, {revision: "7"});
        accept(journal, initial, base);
        const work = makePending("display-defaults", mismatch === "hash" ? displayB : displayA, {
            baseRevision: mismatch === "revision" ? "6" : "7", changeId: secondId,
        });
        journal.begin(destination, "display-defaults", work);
        assert.throws(() => journal.unchanged(destination, "display-defaults", work), /Invalid configuration synchronization check/);
        assert.deepEqual(journal.read(destination, "display-defaults"), {base, materialized: displayA, pending: work});
    });
}

test("unchanged preserves canonical policy base while acknowledging the captured materialized baseline", (t) => {
    const {journal, reopen} = fixture(t);
    const canonical = policyContent("hidden", "visible");
    const actual = policyContent("visible");
    const initial = makePending("global-policies", canonical, {materialized: actual});
    const base = stateFor(initial, canonical, {revision: "3"});
    journal.begin(destination, "global-policies", initial);
    journal.complete(destination, "global-policies", initial, base, () => ({applied: true, materialized: actual}));
    const work = makePending("global-policies", canonical, {baseRevision: "3", materialized: null, changeId: secondId});
    journal.begin(destination, "global-policies", work);
    journal.unchanged(destination, "global-policies", work);
    journal.close();

    const entry = reopen().read(destination, "global-policies");
    assert.deepEqual(entry.base, {...base, outcome: "unchanged"});
    assert.equal(entry.materialized, null);
    assert.equal(entry.pending, undefined);
});

test("explicit reset and absent revision-zero state retain distinct durable bases with null content", (t) => {
    const {journal, reopen} = fixture(t);
    const initial = makePending("display-defaults", displayA);
    accept(journal, initial, stateFor(initial, displayA, {revision: "4"}));
    const reset = makePending("display-defaults", null, {baseRevision: "4", changeId: secondId});
    assert.equal(reset.request.sha256, configHash(null));
    assert.equal(reset.snapshot.materialized, null);
    const resetState = stateFor(reset, null, {revision: "5"});
    accept(journal, reset, resetState);
    const absent = makePending("global-policies", null);
    const absentState = stateFor(absent, null, {revision: "0", outcome: "unchanged"});
    accept(journal, absent, absentState);
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recovered.read(destination, "display-defaults").base, resetState);
    assert.deepEqual(recovered.read(destination, "global-policies").base, absentState);
    assert.equal(recovered.read(destination, "display-defaults").materialized, null);
    assert.equal(recovered.read(destination, "global-policies").materialized, null);
    assert.deepEqual(recoveries(recovered), []);
});

test("losing payloads and reset candidates retain their exact prior base and captured snapshot across reopen", (t) => {
    const {journal, reopen} = fixture(t);
    const initial = makePending("display-defaults", displayA);
    const firstBase = stateFor(initial, displayA);
    accept(journal, initial, firstBase);
    const changed = makePending("display-defaults", displayB, {baseRevision: "1", changeId: secondId});
    const secondBase = stateFor(changed, displayC, {revision: "2", outcome: "server_won"});
    accept(journal, changed, secondBase);
    const reset = makePending("display-defaults", null, {baseRevision: "2", changeId: "33333333-3333-4333-8333-333333333333"});
    const thirdBase = stateFor(reset, displayC, {revision: "2", outcome: "server_won"});
    accept(journal, reset, thirdBase);
    assert.throws(() => journal.complete(destination, "display-defaults", reset, thirdBase,
        () => ({applied: true, materialized: displayC})), /journal changed/);
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recoveries(recovered), [
        {base: firstBase, pending: changed},
        {base: secondBase, pending: reset},
    ]);
    assert.deepEqual(recovered.read(destination, "display-defaults").base, thirdBase);
    assert.equal(recovered.read(destination, "display-defaults").pending, undefined);
});

test("partial policy merges remain recoverable and deferred completion stores the adapter-approved guard baseline", (t) => {
    const {journal, reopen} = fixture(t);
    const original = policyContent("local-before-request");
    const approvedGuard = policyContent("explicit-approved-selection");
    const work = makePending("global-policies", policyContent("hidden", "local-before-request"), {materialized: original});
    const winner = stateFor(work, policyContent("hidden", "server-addition"), {outcome: "merged"});
    journal.begin(destination, "global-policies", work);
    assert.deepEqual(journal.complete(destination, "global-policies", work, winner,
        () => ({applied: false, materialized: approvedGuard})), {
        applied: false, materialized: approvedGuard,
    });
    journal.close();

    const recovered = reopen();
    const entry = recovered.read(destination, "global-policies");
    assert.deepEqual(entry.base, winner);
    assert.equal(entry.materialized, approvedGuard);
    assert.equal(entry.pending, undefined);
    assert.deepEqual(recoveries(recovered, "global-policies"), [{pending: work}]);
});

test("item quota rejects begin transactionally without replacing or evicting existing work", (t) => {
    const {journal} = fixture(t);
    const db = journal.database();
    const insert = db.prepare("INSERT INTO config_sync_items(destination,item) VALUES (?,?)");
    db.transaction(() => {
        for (let index = 0; index < 1024; index++) insert.run(`retained-${index}`, "display-defaults");
    })();
    const work = makePending("display-defaults", displayA);
    assert.throws(() => journal.begin(destination, "display-defaults", work), /journal is full/);
    assert.equal(db.prepare("SELECT count(*) FROM config_sync_items").pluck().get(), 1024);
    assert.deepEqual(journal.read(destination, "display-defaults"), {materialized: null});
    journal.begin("retained-0", "display-defaults", work);
    assert.deepEqual(journal.read("retained-0", "display-defaults").pending, work);
});

test("completion reserves recovery quota before external apply and rolls back all tentative metadata on exhaustion", (t) => {
    const {journal} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    const db = journal.database();
    const evidence = JSON.stringify({retained: "fixture evidence"});
    const insert = db.prepare("INSERT INTO config_sync_recovery(destination,item,change_id,snapshot) VALUES (?,?,?,?)");
    db.transaction(() => {
        for (let index = 0; index < 10_000; index++) insert.run("older-destination", "display-defaults", String(index), evidence);
    })();
    const apply = t.mock.fn(() => ({applied: true, materialized: displayB}));
    const winner = stateFor(work, displayB, {outcome: "server_won"});

    assert.throws(() => journal.complete(destination, "display-defaults", work, winner, apply), /journal is full/);

    assert.equal(apply.mock.callCount(), 0);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
    assert.equal(journal.read(destination, "display-defaults").base, undefined);
    assert.equal(db.prepare("SELECT count(*) FROM config_sync_recovery").pluck().get(), 10_000);
    assert.equal(db.prepare("SELECT snapshot FROM config_sync_recovery WHERE change_id='0'").pluck().get(), evidence);
    assert.deepEqual(recoveries(journal), []);
    // Existing quota evidence is not silently removed to make room. A response
    // requiring no new recovery can still acknowledge the retained operation.
    journal.complete(destination, "display-defaults", work, stateFor(work), () => ({applied: true, materialized: displayA}));
    assert.equal(db.prepare("SELECT count(*) FROM config_sync_recovery").pluck().get(), 10_000);
});

test("GLOBAL source, losing-payload recovery, and acknowledgement roll back together after a post-apply failure", (t) => {
    const {journal, directory} = fixture(t);
    const db = journal.database();
    const dao = new PolicyDao(db);
    dao.upsertPolicies([
        {pattern: "original", info: {GET: {accessType: PolicyAccessType.HTTP_GET, lifetime: PolicyLifetime.GLOBAL,
            status: PolicyResponse.ALLOWED, reason: "saved"}}},
        {pattern: "local", info: {GET: {accessType: PolicyAccessType.HTTP_GET, lifetime: PolicyLifetime.LOCAL,
            status: PolicyResponse.DENIED, reason: "local decision"}}},
    ]);
    const adapters = new ConfigSyncAdapters(directory, db);
    t.after(() => adapters.close());
    const snapshot = adapters.capture("global-policies");
    const work = makePending("global-policies", snapshot.content, {materialized: snapshot.materialized});
    const winner = stateFor(work, policyContent("remote"), {outcome: "merged"});
    journal.begin(destination, "global-policies", work);

    assert.throws(() => journal.complete(destination, "global-policies", work, winner, () => {
        const result = adapters.apply("global-policies", snapshot, winner.content);
        assert.equal(result.applied, true);
        // Failure after the adapter released its nested savepoint must undo
        // the source rows as well as tentative journal/recovery writes.
        throw new Error("fixture acknowledgement failure after source apply");
    }), /fixture acknowledgement failure after source apply/);
    assert.equal(adapters.capture("global-policies").content, snapshot.content);
    assert.deepEqual(journal.read(destination, "global-policies").pending, work);
    assert.equal(journal.read(destination, "global-policies").base, undefined);
    assert.deepEqual(recoveries(journal, "global-policies"), []);

    journal.complete(destination, "global-policies", work, winner,
        () => adapters.apply("global-policies", snapshot, winner.content));
    assert.equal(adapters.capture("global-policies").content, winner.content);
    assert.deepEqual(journal.read(destination, "global-policies").base, winner);
    assert.deepEqual(recoveries(journal, "global-policies"), [{pending: work}]);
    assert.equal(dao.loadPolicies().find((entry) => entry.pattern === "local")?.info.GET?.lifetime, PolicyLifetime.LOCAL);
});

test("adapter closure does not close its borrowed journal database; the journal owns its lifetime", (t) => {
    const {journal, directory, reopen} = fixture(t);
    const db = journal.database();
    assert.equal(db.file, path.join(directory, "pilot.sqlite"));
    const adapters = new ConfigSyncAdapters(directory, db);
    adapters.capture("global-policies");
    adapters.close();
    assert.equal(journal.database(), db);
    assert.equal(db.prepare("SELECT 1").pluck().get(), 1);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    journal.close();
    assert.throws(() => db.prepare("SELECT 1"), /not open|closed/);
    assert.deepEqual(reopen().read(destination, "display-defaults").pending, work);
});

test("legacy automatic lookup and disabling without opt-in never open or create the policy database", (t) => {
    const {journal, directory} = fixture(t);
    const open = t.mock.method(SqliteDatabase, "open", () => { throw new Error("unexpected database open"); });
    assert.equal(journal.automaticBinding(origin), undefined);
    journal.disableAutomatic();
    assert.equal(fs.existsSync(directory), false);
    fs.mkdirSync(directory, {mode: 0o700});
    fs.writeFileSync(path.join(directory, "config-sync.enabled"), "", {mode: 0o600});
    assert.equal(journal.automaticBinding(origin), undefined);
    assert.equal(open.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(directory), ["config-sync.enabled"]);
});

test("explicit private opt-in is per-origin, pins generation, and survives read-only lookup after reopen", (t) => {
    const {journal, directory, reopen} = fixture(t);
    const otherBinding = {...binding, namespace_id: "other-namespace"};
    const rebound = {...binding, history_generation: "generation-2"};
    journal.setAutomatic(origin, binding);
    journal.setAutomatic(otherOrigin, otherBinding);
    journal.setAutomatic(origin, rebound);
    assert.equal(fs.statSync(path.join(directory, "pilot.sqlite")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, "config-sync.enabled")).mode & 0o777, 0o600 & ~process.umask());
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700 & ~process.umask());
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recovered.automaticBinding(origin), rebound);
    assert.deepEqual(recovered.automaticBinding(otherOrigin), otherBinding);
    assert.equal(recovered.automaticBinding("https://unconfigured.example.test"), undefined);
    fs.unlinkSync(path.join(directory, "config-sync.enabled"));
    assert.equal(recovered.automaticBinding(origin), undefined);
    fs.writeFileSync(path.join(directory, "config-sync.enabled"), "", {mode: 0o600});
    assert.deepEqual(recovered.automaticBinding(origin), rebound);
    recovered.setAutomatic(origin, undefined);
    assert.equal(recovered.automaticBinding(origin), undefined);
    assert.deepEqual(recovered.automaticBinding(otherOrigin), otherBinding);
});

test("disabling automatic sync removes all origin pins and marker but preserves pending work, bases, and recovery history", (t) => {
    const {journal, directory, reopen} = fixture(t);
    const initial = makePending("display-defaults", displayA);
    const base = stateFor(initial, displayB, {outcome: "server_won"});
    accept(journal, initial, base);
    const work = makePending("display-defaults", null, {baseRevision: "1", changeId: secondId});
    journal.begin(destination, "display-defaults", work);
    const before = journal.read(destination, "display-defaults");
    const evidence = recoveries(journal);
    journal.setAutomatic(origin, binding);
    journal.setAutomatic(otherOrigin, {...binding, namespace_id: "second-namespace"});

    journal.disableAutomatic();
    journal.disableAutomatic();
    assert.equal(fs.existsSync(path.join(directory, "config-sync.enabled")), false);
    assert.equal(journal.automaticBinding(origin), undefined);
    assert.equal(journal.automaticBinding(otherOrigin), undefined);
    assert.equal(journal.database().prepare("SELECT count(*) FROM config_sync_automatic").pluck().get(), 0);
    assert.deepEqual(journal.read(destination, "display-defaults"), before);
    assert.deepEqual(recoveries(journal), evidence);
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recovered.read(destination, "display-defaults"), before);
    assert.deepEqual(recoveries(recovered), evidence);
    assert.equal(recovered.automaticBinding(origin), undefined);
});

for (const target of [displayB, null]) {
    test(`JSON ${target === null ? "reset" : "replacement"} intent survives source success, failed ACK, and reopen without changing the wire identity`, (t) => {
        const {journal, directory, reopen} = fixture(t);
        let work = makePending("display-defaults", displayA);
        const original = structuredClone(work);
        journal.begin(destination, "display-defaults", work);
        const file = path.join(directory, "display-defaults.json");
        fs.writeFileSync(file, displayA);
        const adapters = new ConfigSyncAdapters(directory, journal.database());
        t.after(() => adapters.close());
        const captured = adapters.capture("display-defaults");
        const winner = stateFor(work, target, {revision: "8", outcome: "server_won"});
        const result = adapters.apply("display-defaults", captured, target, (materialized) => {
            assert.equal(fs.readFileSync(file, "utf8"), displayA);
            work = journal.prepareApplication(destination, "display-defaults", work, winner, captured, materialized);
            assert.deepEqual(work.request, original.request);
            assert.deepEqual(work.snapshot, original.snapshot);
        });
        assert.deepEqual(result, {applied: true, materialized: target});
        journal.database().exec(`
            CREATE TRIGGER fail_json_ack BEFORE UPDATE ON config_sync_items
            WHEN NEW.pending IS NULL BEGIN SELECT RAISE(ABORT, 'fixture ACK failure'); END;
        `);
        assert.throws(() => journal.complete(destination, "display-defaults", work, winner, () => result), /fixture ACK failure/);
        journal.close();

        const recovered = reopen();
        const entry = recovered.read(destination, "display-defaults");
        assert.equal(entry.base, undefined);
        assert.deepEqual(entry.pending, work);
        assert.deepEqual(entry.pending?.application, {state: winner, captured, materialized: target});
        assert.deepEqual(entry.pending?.request, original.request);
        assert.equal(target === null ? !fs.existsSync(file) : fs.readFileSync(file, "utf8") === target, true);
        assert.throws(() => recovered.begin(destination, "display-defaults", makePending("display-defaults", target)), /pending work/);
        assert.deepEqual(recoveries(recovered), [{pending: original}]);
        // A later server winner does not itself clear/rebase this interrupted
        // application. The orchestrator must classify the saved source first.
        assert.notEqual(target, displayC);
        assert.deepEqual(recovered.read(destination, "display-defaults").pending, work);
    });
}

test("repeated interruptions before source mutation checkpoint newer winners while preserving one original candidate", (t) => {
    const {journal, directory, reopen} = fixture(t);
    let active = journal;
    let work = makePending("display-defaults", displayA);
    const original = structuredClone(work);
    active.begin(destination, "display-defaults", work);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, displayA);
    const adapters = new ConfigSyncAdapters(directory);
    t.after(() => adapters.close());
    const captured = adapters.capture("display-defaults");
    for (const [index, target] of [displayB, displayC].entries()) {
        const winner = stateFor(work, target, {revision: String(index + 2), outcome: "server_won"});
        assert.throws(() => adapters.apply("display-defaults", captured, target, (materialized) => {
            work = active.prepareApplication(destination, "display-defaults", work, winner, captured, materialized);
            throw new Error("fixture interruption before rename");
        }), /fixture interruption before rename/);
        assert.equal(fs.readFileSync(file, "utf8"), displayA);
        active.close();
        active = reopen();
        assert.deepEqual(active.read(destination, "display-defaults").pending, work);
        assert.deepEqual(work.request, original.request);
        assert.deepEqual(work.snapshot, original.snapshot);
        assert.equal(work.application?.state.revision, String(index + 2));
        assert.deepEqual(recoveries(active), [{pending: original}]);
    }
    const winner = stateFor(work, displayC, {revision: "3", outcome: "server_won"});
    const result = adapters.apply("display-defaults", captured, winner.content, (materialized) => {
        work = active.prepareApplication(destination, "display-defaults", work, winner, captured, materialized);
    });
    active.complete(destination, "display-defaults", work, winner, () => result);
    assert.equal(fs.readFileSync(file, "utf8"), displayC);
    assert.equal(active.read(destination, "display-defaults").pending, undefined);
    assert.deepEqual(active.read(destination, "display-defaults").base, winner);
    assert.deepEqual(recoveries(active), [{pending: original}]);
});

test("application checkpoint validates canonical target and guard, exact fields, key/binding, and rejects GLOBAL intent", (t) => {
    const {journal} = fixture(t);
    const original = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", original);
    const winner = stateFor(original, displayB);
    const captured = original.snapshot;
    for (const attempt of [
        () => journal.prepareApplication(destination, "display-defaults", original, winner, captured, displayC),
        () => journal.prepareApplication(destination, "display-defaults", original, winner, {...captured, materialized: displayC}, displayB),
        () => journal.prepareApplication(destination, "display-defaults", original,
            {...winner, binding: {...binding, history_generation: "different"}}, captured, displayB),
    ]) {
        assert.throws(attempt);
        assert.deepEqual(journal.read(destination, "display-defaults").pending, original);
        assert.deepEqual(recoveries(journal), []);
    }
    const prepared = journal.prepareApplication(destination, "display-defaults", original, winner, captured, displayB);
    assert.ok(prepared.application);
    const application = prepared.application;
    const invalid = [
        {...prepared, application: {...application, unknown: true}},
        {...prepared, application: {...application, state: {...winner, unknown: true}}},
        {...prepared, application: {...application, captured: {...captured, unknown: true}}},
        {...prepared, application: {...application, captured: {...captured, modifiedAt: "not-a-timestamp"}}},
        {...prepared, application: {...application, materialized: ' {"normal":"full","alternate":"minimal"}'}},
        {...prepared, application: {...application, materialized: "x".repeat(256 * 1024 + 1)}},
        {...prepared, application: {...application, state: {...winner, key: "subagent-defaults"}}},
    ];
    const update = journal.database().prepare("UPDATE config_sync_items SET pending=? WHERE destination=? AND item=?");
    for (const value of invalid) {
        update.run(JSON.stringify(value), destination, "display-defaults");
        assert.throws(() => journal.read(destination, "display-defaults"));
    }
    update.run(JSON.stringify(prepared), destination, "display-defaults");
    const globals = makePending("global-policies", policyContent("global"));
    journal.begin(destination, "global-policies", globals);
    assert.throws(() => journal.prepareApplication(destination, "global-policies", globals,
        stateFor(globals), globals.snapshot, globals.snapshot.materialized), /GLOBAL/);
    assert.deepEqual(journal.read(destination, "global-policies").pending, globals);
});

test("application evidence refuses nested savepoints before a non-transactional file mutation", (t) => {
    const {journal, directory} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, displayA);
    const adapters = new ConfigSyncAdapters(directory);
    t.after(() => adapters.close());
    journal.database().transaction(() => {
        assert.throws(() => adapters.apply("display-defaults", work.snapshot, displayB, (materialized) => {
            journal.prepareApplication(destination, "display-defaults", work, stateFor(work, displayB), work.snapshot, materialized);
        }), /independent transaction/);
        assert.throws(() => journal.preserveCapture(destination, "display-defaults", work, work.snapshot), /independent transaction/);
    }).immediate();
    assert.equal(fs.readFileSync(file, "utf8"), displayA);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
    assert.deepEqual(recoveries(journal), []);
});

test("an advisory unchanged assertion cannot implicitly acknowledge an interrupted JSON application", (t) => {
    const {journal} = fixture(t);
    const initial = makePending("display-defaults", displayA);
    const base = stateFor(initial);
    accept(journal, initial, base);
    const work = makePending("display-defaults", displayA, {baseRevision: "1", changeId: secondId});
    journal.begin(destination, "display-defaults", work);
    const pending = journal.prepareApplication(destination, "display-defaults", work,
        stateFor(work, displayB, {revision: "2"}), work.snapshot, displayB);
    assert.throws(() => journal.unchanged(destination, "display-defaults", pending), /guarded recovery/);
    assert.deepEqual(journal.read(destination, "display-defaults").base, base);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, pending);
});

test("application checkpoint stores actual canonical materialization even when the server JSON uses other formatting", (t) => {
    const {journal, reopen} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    const formatted = '{ "normal": "full", "alternate": "minimal" }';
    const winner = stateFor(work, formatted);
    const pending = journal.prepareApplication(destination, "display-defaults", work, winner, work.snapshot, displayB);
    journal.close();
    assert.equal(reopen().read(destination, "display-defaults").pending?.application?.materialized, displayB);
    assert.equal(pending.application?.state.content, formatted);
});

test("checkpoint recovery quota exhaustion prevents JSON mutation and rolls back intent and candidate reservation", (t) => {
    const {journal, directory} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    fillRecoveryQuota(journal);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, displayA);
    const adapters = new ConfigSyncAdapters(directory);
    t.after(() => adapters.close());
    const winner = stateFor(work, displayB);
    assert.throws(() => adapters.apply("display-defaults", work.snapshot, displayB, (materialized) => {
        journal.prepareApplication(destination, "display-defaults", work, winner, work.snapshot, materialized);
    }), /journal is full/);
    assert.equal(fs.readFileSync(file, "utf8"), displayA);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
    assert.equal(journal.database().prepare("SELECT count(*) FROM config_sync_recovery").pluck().get(), 10_000);
    assert.deepEqual(recoveries(journal), []);
    assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".config-sync-")), false);
});

test("checkpoint byte budget includes actual canonical target and full ACK state before source mutation", (t) => {
    const {journal} = fixture(t);
    const content = canonicalConfigContent({version: 1, providers: ["brave"], brave: {apiKey: "small"}});
    const target = canonicalConfigContent({version: 1, providers: ["brave"], brave: {apiKey: "x".repeat(8192)}});
    const work = makePending("web-search", content);
    journal.begin(destination, "web-search", work);
    // Quota-only evidence is intentionally never decoded as a recovery entry.
    // SQLite allocates it without constructing a 64-MiB JavaScript fixture.
    journal.database().prepare("INSERT INTO config_sync_recovery VALUES (?,?,?,CAST(zeroblob(?) AS TEXT))")
        .run("quota-fixture", "web-search", "retained", 64 * 1024 * 1024 - 4096);
    assert.throws(() => journal.prepareApplication(destination, "web-search", work, stateFor(work, target), work.snapshot, target), /journal is full/);
    assert.deepEqual(journal.read(destination, "web-search").pending, work);
    assert.equal(journal.database().prepare("SELECT count(*) FROM config_sync_recovery").pluck().get(), 1);
});

test("explicit keep-local rebase atomically preserves old identity and installs a new frozen selection on the exact current revision", (t) => {
    const {journal, reopen} = fixture(t);
    const original = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", original);
    const winner = stateFor(original, displayB, {revision: "9", outcome: "server_won"});
    const oldPending = journal.prepareApplication(destination, "display-defaults", original, winner, original.snapshot, displayB);
    const next = makePending("display-defaults", displayC, {baseRevision: "9", changeId: secondId});
    const selected = structuredClone(next);
    journal.rebase(destination, "display-defaults", oldPending, winner, next);
    next.snapshot.content = displayA;
    next.snapshot.materialized = displayA;
    next.request.content = displayA;
    journal.close();

    const recovered = reopen();
    assert.deepEqual(recovered.read(destination, "display-defaults"), {base: winner, materialized: displayC, pending: selected});
    assert.equal(recovered.read(destination, "display-defaults").pending?.application, undefined);
    assert.deepEqual(recoveries(recovered), [{pending: original}]);
    assert.throws(() => recovered.rebase(destination, "display-defaults", oldPending, winner, selected), /journal changed/);
});

test("rebase rejects identity/base/binding changes and quota exhaustion without changing the original pending intent", (t) => {
    const {journal} = fixture(t);
    const original = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", original);
    const winner = stateFor(original, displayB, {revision: "9"});
    for (const next of [
        makePending("display-defaults", displayC, {baseRevision: "9"}),
        makePending("display-defaults", displayC, {baseRevision: "8", changeId: secondId}),
        {...makePending("display-defaults", displayC, {baseRevision: "9", changeId: secondId}),
            request: {...makePending("display-defaults", displayC, {baseRevision: "9", changeId: secondId}).request,
                binding: {...binding, history_generation: "different"}}},
    ]) {
        assert.throws(() => journal.rebase(destination, "display-defaults", original, winner, next));
        assert.deepEqual(journal.read(destination, "display-defaults").pending, original);
        assert.equal(journal.read(destination, "display-defaults").base, undefined);
    }
    fillRecoveryQuota(journal);
    const next = makePending("display-defaults", displayC, {baseRevision: "9", changeId: secondId});
    assert.throws(() => journal.rebase(destination, "display-defaults", original, winner, next), /journal is full/);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, original);
    assert.equal(journal.read(destination, "display-defaults").base, undefined);
    assert.deepEqual(recoveries(journal), []);
});

test("explicit accept-server preserves each frozen displaced selection under its own durable recovery identity", (t) => {
    const {journal, reopen} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    const selected = makePending("display-defaults", displayC).snapshot;
    const frozen = structuredClone(selected);
    journal.preserveCapture(destination, "display-defaults", work, selected);
    journal.preserveCapture(destination, "display-defaults", work, selected);
    selected.materialized = displayB;
    selected.content = displayB;
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
    journal.close();
    const recovered = reopen();
    assert.deepEqual(recoveries(recovered), [{captured: frozen}, {captured: frozen}]);
    assert.equal(recovered.database().prepare("SELECT count(DISTINCT change_id) FROM config_sync_recovery").pluck().get(), 2);
    assert.deepEqual(recovered.read(destination, "display-defaults").pending, work);
});

test("preserving an explicit displaced selection fails atomically at quota and never clears pending work", (t) => {
    const {journal} = fixture(t);
    const work = makePending("display-defaults", displayA);
    journal.begin(destination, "display-defaults", work);
    fillRecoveryQuota(journal);
    assert.throws(() => journal.preserveCapture(destination, "display-defaults", work,
        makePending("display-defaults", displayC).snapshot), /journal is full/);
    assert.deepEqual(journal.read(destination, "display-defaults").pending, work);
    assert.deepEqual(recoveries(journal), []);
    assert.equal(journal.database().prepare("SELECT count(*) FROM config_sync_recovery").pluck().get(), 10_000);
});

function fillRecoveryQuota(journal: ConfigSyncJournal): void {
    const insert = journal.database().prepare("INSERT INTO config_sync_recovery VALUES (?,?,?,?)");
    journal.database().transaction(() => {
        for (let index = 0; index < 10_000; index++) insert.run("quota-fixture", "display-defaults", String(index), "{}");
    })();
}

function fixture(t: TestContext) {
    mockIsolatedDatabaseOpens(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-config-journal-"));
    const directory = path.join(root, "settings");
    const journals: ConfigSyncJournal[] = [];
    const reopen = () => {
        const journal = new ConfigSyncJournal(directory);
        journals.push(journal);
        return journal;
    };
    t.after(() => {
        for (const journal of journals) journal.close();
        fs.rmSync(root, {recursive: true, force: true});
    });
    return {root, directory, journal: reopen(), reopen};
}

function makePending(key: ConfigKey, content: string | null, options: {
    baseRevision?: string | null; materialized?: string | null; changeId?: string;
} = {}): PendingConfigSync {
    return {
        request: {binding: {...binding}, key, base_revision: options.baseRevision ?? null,
            change_id: options.changeId ?? firstId, modified_at: modifiedAt, schema_version: 1,
            content, sha256: configHash(content)},
        snapshot: {content, materialized: options.materialized === undefined ? content : options.materialized, modifiedAt},
    };
}

function stateFor(work: PendingConfigSync, content = work.request.content, options: {
    revision?: string; outcome?: ConfigOutcome; binding?: Binding;
} = {}): ConfigState {
    const revision = options.revision ?? "1";
    return {binding: options.binding ?? {...work.request.binding}, key: work.request.key, revision,
        schema_version: 1, content, sha256: configHash(content), updated_at: revision === "0" ? null : modifiedAt,
        outcome: options.outcome ?? "client_won"};
}

function accept(journal: ConfigSyncJournal, work: PendingConfigSync, state: ConfigState): void {
    journal.begin(destination, work.request.key, work);
    journal.complete(destination, work.request.key, work, state, () => ({applied: true, materialized: state.content}));
}

function recoveries(journal: ConfigSyncJournal, key: ConfigKey = "display-defaults"): unknown[] {
    const rows = journal.database().prepare(`SELECT snapshot FROM config_sync_recovery
        WHERE destination=? AND item=? ORDER BY change_id`).all(destination, key) as {snapshot: string}[];
    return rows.map((row): unknown => JSON.parse(row.snapshot));
}

function policyContent(...patterns: string[]): string {
    return canonicalConfigContent({rules: [...patterns].sort().map((pattern) => ({
        pattern, accessType: PolicyAccessType.HTTP_GET, reason: "saved", status: PolicyResponse.ALLOWED,
    }))});
}
