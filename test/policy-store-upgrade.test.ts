import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {PolicyAccessType} from "../src/policy/types.js";
import {PolicySchemaV1} from "../src/storage/migrations/PolicySchemaV1.js";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {ConfigSyncJournal} from "../src/server/config-sync/ConfigSyncJournal.js";
import {canonicalConfigContent, configHash, decodeConfigExchange, decodeConfigState} from "../src/server/config-sync/ConfigSyncProtocol.js";
import {createLegacyPolicySchema, storedPolicyRows, policySchemaObjects} from "./fixtures/LegacyPolicyDatabase.js";
import {mockIsolatedDatabaseOpens} from "./fixtures/IsolatedTestDatabase.js";

function fixture(t: TestContext): SqliteDatabase {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    createLegacyPolicySchema(db, false, true);
    db.exec(`insert into policy_rules values ('/obsolete','FS_DELETE','LOCAL','ALLOWED','old delete',123);
        delete from policy_migration_audit;`);
    return db;
}

test("policy store v1 removes retired rows and constraints once, preserving current decisions and objects", (t) => {
    const db = fixture(t);
    const before = db.prepare("select rowid,* from policy_rules where accessType <> 'FS_DELETE' order by rowid").all();
    const objects = policySchemaObjects(db).filter((row) => (row as {type: string}).type !== "table");
    new PolicyDao(db).initializeSchema();
    assert.equal(db.prepare("pragma user_version").pluck().get(), 3);
    assert.deepEqual(storedPolicyRows(db), before);
    assert.deepEqual(policySchemaObjects(db).filter((row) => (row as {type: string}).type !== "table"), objects);
    assert.equal(db.prepare("select count(*) from policy_migration_audit").pluck().get(), 0);
    const sql = db.prepare("select sql from sqlite_master where name='policy_rules'").pluck().get() as string;
    assert.doesNotMatch(sql, /FS_DELETE/);
    assert.throws(() => db.exec(`insert into policy_rules values ('/new','FS_DELETE','LOCAL','ALLOWED','',0)`), /CHECK constraint/);
    const version = db.prepare("pragma schema_version").pluck().get();
    const exec = t.mock.method(db, "exec", () => { throw new Error("Current stores must not run migration SQL"); });
    new PolicyDao(db).initializeSchema();
    exec.mock.restore();
    assert.equal(db.prepare("pragma schema_version").pluck().get(), version);
});

test("policy store v1 upgrades the former compatibility schema even when every current permission is present", (t) => {
    const fresh = SqliteDatabase.open(":memory:");
    t.after(() => fresh.close());
    new PolicySchemaV1(fresh).up();
    const current = fresh.prepare("select sql from sqlite_master where name='policy_rules'").pluck().get() as string;
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    db.exec(current.replace("'FS_READ'", "'FS_DELETE', 'FS_READ'"));
    db.exec(`insert into policy_rules values ('/old','FS_DELETE','GLOBAL','DENIED','old',123)`);
    assert.deepEqual(new PolicyDao(db).loadPolicies(), []);
    assert.doesNotMatch(db.prepare("select sql from sqlite_master where name='policy_rules'").pluck().get() as string, /FS_DELETE/);
    assert.equal(db.prepare("pragma user_version").pluck().get(), 3);
});

test("an outer rollback restores the previous policy schema, data and version and permits retry", (t) => {
    const db = fixture(t);
    const before = storedPolicyRows(db);
    const objects = policySchemaObjects(db);
    const dao = new PolicyDao(db);
    assert.throws(() => db.transaction(() => { dao.initializeSchema(); throw new Error("outer failure"); }).immediate(), /outer failure/);
    assert.equal(db.prepare("pragma user_version").pluck().get(), 0);
    assert.deepEqual(storedPolicyRows(db), before);
    assert.deepEqual(policySchemaObjects(db), objects);
    dao.initializeSchema();
    assert.equal(db.prepare("pragma user_version").pluck().get(), 3);
});

test("future policy-store versions fail without changing their data or schema", (t) => {
    const db = fixture(t);
    db.exec("pragma user_version=4");
    const before = storedPolicyRows(db);
    assert.throws(() => new PolicyDao(db).initializeSchema(), /Unsupported policy database version: 4/);
    assert.deepEqual(storedPolicyRows(db), before);
    assert.equal(db.prepare("pragma user_version").pluck().get(), 4);
});

for (const corrupt of [false, true]) {
    test(`policy sync journal upgrade ${corrupt ? "rolls back on a corrupt hash" : "rehashes state and renews changed pending IDs"}`, (t) => {
        const db = fixture(t);
        const before = storedPolicyRows(db);
        const binding = {server_id: "00000000-0000-4000-8000-000000000001",
            namespace_id: "00000000-0000-4000-8000-000000000002", history_generation: "00000000-0000-4000-8000-000000000003"};
        const rules = [{pattern: "/old", accessType: "FS_DELETE", status: "ALLOWED", reason: "old"},
            {pattern: "host:5037", accessType: "ADB", status: "DENIED", reason: "keep"}];
        const content = canonicalConfigContent({rules});
        const expected = canonicalConfigContent({rules: rules.slice(1)});
        const time = "2025-01-01T00:00:00.000Z";
        const baseline = {binding, key: "global-policies", revision: "4", schema_version: 1, content,
            sha256: corrupt ? "0".repeat(64) : configHash(content), updated_at: time, outcome: "merged"};
        const request = {binding, key: "global-policies", base_revision: "4", change_id: "00000000-0000-4000-8000-000000000004",
            modified_at: time, schema_version: 1, content, sha256: configHash(content)};
        const pending = {request, snapshot: {content, materialized: content, modifiedAt: time}};
        db.exec(`create table config_sync_items (destination text,item text,baseline text,materialized text,pending text);
            create table config_sync_recovery (destination text,item text,change_id text,snapshot text);`);
        db.prepare("insert into config_sync_items values ('server','global-policies',?,?,?)")
            .run(JSON.stringify(baseline), content, JSON.stringify(pending));
        db.prepare("insert into config_sync_recovery values ('server','global-policies','saved',?)")
            .run(JSON.stringify({base: baseline, pending}));
        if (corrupt) {
            assert.throws(() => new PolicyDao(db).initializeSchema(), /hash mismatch/);
            assert.equal(db.prepare("pragma user_version").pluck().get(), 0);
            assert.deepEqual(storedPolicyRows(db), before);
            return;
        }
        new PolicyDao(db).initializeSchema();
        const row = db.prepare("select * from config_sync_items").get() as {baseline: string; pending: string; materialized: string};
        assert.equal(decodeConfigState(JSON.parse(row.baseline)).content, expected);
        assert.equal(row.materialized, expected);
        const upgraded = JSON.parse(row.pending);
        assert.equal(decodeConfigExchange(upgraded.request).content, expected);
        assert.notEqual(upgraded.request.change_id, request.change_id);
        assert.equal(upgraded.snapshot.content, expected);
        assert.equal(upgraded.snapshot.materialized, expected);
        const recovery = db.prepare("select snapshot from config_sync_recovery").pluck().get() as string;
        assert.doesNotMatch(recovery, /FS_DELETE/);
        assert.equal(JSON.parse(recovery).pending.request.change_id, request.change_id);
    });
}

test("upgrading v2 preserves policies and saved roles and adds local mmap decisions", (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    new PolicySchemaV1(db).up();
    db.exec(`create table role_profiles (id text primary key not null, title text not null, text text not null, description text);
        insert into role_profiles values ('id','Reviewer','Review the patch',null);
        insert into policy_rules values ('/project','FS_WRITE','LOCAL','DENIED','keep',5);
        pragma user_version=2;`);
    const before = storedPolicyRows(db);
    new PolicyDao(db).initializeSchema();
    assert.deepEqual(storedPolicyRows(db), before);
    assert.equal(db.prepare("select title from role_profiles").pluck().get(), "Reviewer");
    db.exec(`insert into policy_rules values ('/project','FS_MMAP','LOCAL','ALLOWED','build',6);`);
    assert.equal(new PolicyDao(db).loadPolicies()[0]?.info.FS_MMAP?.status, "ALLOWED");
    assert.equal(db.prepare("pragma user_version").pluck().get(), 3);
});

test("fresh versioned stores support every current permission and reject unknown permissions", (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    new PolicyDao(db).initializeSchema();
    const insert = db.prepare("insert into policy_rules values ('/test',?,?,'DENIED','',0)");
    for (const type of Object.values(PolicyAccessType)) {
        insert.run(type, type === PolicyAccessType.FS_MMAP ? "LOCAL" : "GLOBAL");
    }
    assert.throws(() => insert.run(PolicyAccessType.FS_MMAP, "GLOBAL"), /CHECK constraint/);
    assert.equal(storedPolicyRows(db).length, Object.values(PolicyAccessType).length);
    assert.throws(() => insert.run("FUTURE_PERMISSION", "GLOBAL"), /CHECK constraint/);
});

test("opening the journal upgrades persisted work once and keeps current pending identities across restart", (t) => {
    mockIsolatedDatabaseOpens(t);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-store-upgrade-"));
    const journal = new ConfigSyncJournal(directory);
    t.after(() => {
        journal.close();
        fs.rmSync(directory, {recursive: true, force: true});
    });
    const db = SqliteDatabase.open(path.join(directory, "pilot.sqlite"));
    createLegacyPolicySchema(db, false, true);
    db.exec(`create table config_sync_items (destination text,item text,baseline text,materialized text,pending text,
        primary key(destination,item));
        create table config_sync_recovery (destination text,item text,change_id text,snapshot text,
        primary key(destination,item,change_id));`);
    const binding = {server_id: "server", namespace_id: "namespace", history_generation: "generation"};
    const modifiedAt = "2025-01-01T00:00:00.000Z";
    const changeId = "00000000-0000-4000-8000-000000000004";
    const current = canonicalConfigContent({rules: [
        {pattern: "host:5037", accessType: "ADB", status: "DENIED", reason: "keep"},
    ]});
    for (const [destination, content] of [
        ["retired", canonicalConfigContent({rules: [
            {pattern: "/old", accessType: "FS_DELETE", status: "ALLOWED", reason: "old"},
        ]})],
        ["current", current],
    ] as const) {
        const baseline = {binding, key: "global-policies", revision: "4", schema_version: 1,
            content, sha256: configHash(content), updated_at: modifiedAt, outcome: "merged"};
        const request = {binding, key: "global-policies", base_revision: "4", change_id: changeId,
            modified_at: modifiedAt, schema_version: 1, content, sha256: configHash(content)};
        const snapshot = {content, materialized: content, modifiedAt};
        db.prepare("insert into config_sync_items values (?,'global-policies',?,?,?)")
            .run(destination, JSON.stringify(baseline), content, JSON.stringify({request, snapshot}));
        db.prepare("insert into config_sync_recovery values (?,'global-policies','capture',?)")
            .run(destination, JSON.stringify({captured: snapshot}));
    }
    db.close();
    const retired = journal.read("retired", "global-policies");
    assert.equal(retired.base?.content, null);
    assert.equal(retired.base?.sha256, configHash(null));
    assert.equal(retired.materialized, null);
    assert.equal(retired.pending?.request.content, null);
    assert.notEqual(retired.pending?.request.change_id, changeId);
    const kept = journal.read("current", "global-policies");
    assert.equal(kept.pending?.request.change_id, changeId);
    assert.equal(kept.pending?.request.content, current);
    const capture = journal.database().prepare("select snapshot from config_sync_recovery where destination='retired'")
        .pluck().get() as string;
    assert.deepEqual(JSON.parse(capture), {captured: {content: null, materialized: null, modifiedAt}});
    journal.close();
    assert.deepEqual(journal.read("retired", "global-policies"), retired);
    assert.deepEqual(journal.read("current", "global-policies"), kept);
    assert.equal(journal.database().prepare("pragma user_version").pluck().get(), 3);
    assert.equal(journal.database().prepare("pragma integrity_check").pluck().get(), "ok");
});

test("unsupported sync payloads roll back the policy upgrade instead of being discarded with retired rules", (t) => {
    const db = fixture(t);
    const before = storedPolicyRows(db);
    db.exec("create table config_sync_items (destination text,item text,baseline text,materialized text,pending text)");
    const content = canonicalConfigContent({unknown: true, rules: [
        {pattern: "/old", accessType: "FS_DELETE", status: "ALLOWED", reason: "old"},
    ]});
    db.prepare("insert into config_sync_items values ('server','global-policies',null,?,null)").run(content);
    assert.throws(() => new PolicyDao(db).initializeSchema(), /Invalid stored policy bundle/);
    assert.deepEqual(storedPolicyRows(db), before);
    assert.equal(db.prepare("pragma user_version").pluck().get(), 0);
    assert.equal(db.prepare("select materialized from config_sync_items").pluck().get(), content);
});
