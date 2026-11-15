import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {PolicyAccessType, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";
import {ConfigSyncAdapters} from "../src/server/config-sync/ConfigSyncAdapters.js";
import {canonicalConfigContent, decodeGlobalPolicyRules} from "../src/server/config-sync/ConfigSyncProtocol.js";
import {APPLICATION_POLICY_CHANNELS} from "./fixtures/ApplicationPolicyChannels.js";
import {createLegacyPolicySchema, policySchemaObjects, storedPolicyRows} from "./fixtures/LegacyPolicyDatabase.js";

for (const era of ["pre-ADB", "ADB-era", "retired FS_DELETE"] as const) {
    test(`${era} schema upgrades preserve data, metadata, constraints and schema objects`, (t) => {
        const database = legacyDatabase(t, era === "ADB-era", era === "retired FS_DELETE");
        const before = storedPolicyRows(database);
        const objects = policySchemaObjects(database);
        const dao = new PolicyDao(database);
        dao.initializeSchema();
        assert.deepEqual(storedPolicyRows(database), before);
        assert.deepEqual(database.prepare('select * from "saved_policy_metadata" order by rowid').all(), before);
        assert.deepEqual(policySchemaObjects(database).filter(notTable), objects.filter(notTable));
        assert.equal(database.prepare('select count(*) from "policy_migration_audit"').pluck().get(), 0,
            "migration copies must not fire application triggers");
        assert.deepEqual(database.prepare('pragma index_info("idx_policy_rules_access")').all(), [
            {seqno: 0, cid: 1, name: "accessType"}, {seqno: 1, cid: 0, name: "pattern"},
        ]);
        for (const [, accessType] of APPLICATION_POLICY_CHANNELS) {
            dao.upsertPolicies([{pattern: "channels.test:15555", info: {
                [accessType]: {accessType, lifetime: PolicyLifetime.LOCAL, status: PolicyResponse.ALLOWED, reason: accessType},
            }}]);
        }
        const channels = dao.loadPolicies().find((entry) => entry.pattern === "channels.test:15555");
        assert.deepEqual(new Set(Object.keys(channels!.info)), new Set(APPLICATION_POLICY_CHANNELS.map(([, type]) => type)));
        assert.deepEqual(storedPolicyRows(database).slice(0, before.length), before);
        const insert = database.prepare(`insert into "policy_rules"
            ("pattern", "accessType", "lifetime", "status", "reason", "updatedAt") values (?, ?, ?, ?, '', 0)`);
        assert.throws(() => insert.run("channels.test:15555", "ADB", "LOCAL", "ALLOWED"), /UNIQUE constraint failed/);
        for (const [accessType, lifetime, status] of [
            ["UNKNOWN", "LOCAL", "ALLOWED"], ["GET", "FOREVER", "ALLOWED"], ["GET", "GLOBAL", "UNKNOWN"],
        ]) assert.throws(() => insert.run("invalid.test:443", accessType, lifetime, status), /CHECK constraint failed/);
        assert.equal(database.prepare('select count(*) from "policy_migration_audit"').pluck().get(), 15);
        dao.upsertPolicies([{pattern: "channels.test:15555", info: {
            ADB: {accessType: PolicyAccessType.ADB_ACCESS, lifetime: PolicyLifetime.GLOBAL,
                status: PolicyResponse.DENIED, reason: "Updated denial"},
        }}]);
        dao.deletePolicy("channels.test:15555", PolicyAccessType.ADB_ACCESS);
        assert.deepEqual(database.prepare('select action from "policy_migration_audit" order by rowid desc limit 2').all(), [
            {action: "delete"}, {action: "update"},
        ]);
        const version = database.prepare("pragma schema_version").pluck().get();
        const after = storedPolicyRows(database);
        dao.initializeSchema();
        new PolicyDao(database).initializeSchema();
        assert.equal(database.prepare("pragma schema_version").pluck().get(), version, "current schema must not be rebuilt");
        assert.deepEqual(storedPolicyRows(database), after);
        assert.deepEqual(database.prepare("pragma integrity_check").pluck().all(), ["ok"]);
    });
}

test("retired delete rules stay stored without becoming write authority or synchronized GLOBAL rules", (t) => {
    const database = legacyDatabase(t, false, true);
    const retiredRows = () => database.prepare(`select rowid, * from "policy_rules"
        where "accessType" = 'FS_DELETE' order by rowid`).all();
    const before = retiredRows();
    const dao = new PolicyDao(database);
    const policies = dao.loadPolicies();
    assert.ok(policies.every((policy) => !("FS_DELETE" in policy.info)));
    assert.equal(policies.find((policy) => policy.pattern === "/work/delete-only"), undefined);
    assert.equal(policies.find((policy) => policy.pattern === "/work/private")?.info.FS_WRITE?.status, PolicyResponse.DENIED);
    const adapters = new ConfigSyncAdapters(path.join(os.tmpdir(), "unused-retired-policy-settings"), database);
    t.after(() => adapters.close());
    const captured = adapters.capture("global-policies");
    assert.ok(decodeGlobalPolicyRules(captured.content).every((rule) => rule.pattern !== "/work/private"));
    assert.deepEqual(adapters.apply("global-policies", captured, null), {applied: true, materialized: null});
    assert.deepEqual(retiredRows(), before, "sync must retain retired GLOBAL records as well as LOCAL records");
    assert.equal(adapters.capture("global-policies").content, null);
    assert.equal(dao.loadPolicies().find((policy) => policy.pattern === "/work/private")?.info.FS_WRITE?.status, PolicyResponse.DENIED);
});

test("migration rolls back schema, data and indexes when object recreation fails, and the same DAO can retry", (t) => {
    const database = legacyDatabase(t);
    const rows = storedPolicyRows(database);
    const objects = policySchemaObjects(database);
    const version = database.prepare("pragma schema_version").pluck().get();
    const exec = database.exec.bind(database);
    const mocked = t.mock.method(database, "exec", (sql: string) => {
        if (/create trigger "audit_policy_insert"/iu.test(sql)) throw new Error("fixture rejects trigger recreation");
        return exec(sql);
    });
    const dao = new PolicyDao(database);
    assert.throws(() => dao.initializeSchema(), /fixture rejects trigger recreation/);
    mocked.mock.restore();
    assert.equal(database.inTransaction, false);
    assert.deepEqual(storedPolicyRows(database), rows);
    assert.deepEqual(policySchemaObjects(database), objects);
    assert.equal(database.prepare("pragma schema_version").pluck().get(), version);
    assert.deepEqual(database.prepare("select name from sqlite_master where name like '%policy_rules%upgrade%'").all(), []);
    dao.initializeSchema();
    assert.deepEqual(storedPolicyRows(database), rows);
    assert.equal(database.prepare('select count(*) from "policy_migration_audit"').pluck().get(), 0);
});

test("outer transaction rollback restores the old CHECK and metadata without poisoning the DAO initialization cache", (t) => {
    const database = legacyDatabase(t);
    const rows = storedPolicyRows(database);
    const objects = policySchemaObjects(database);
    const dao = new PolicyDao(database);
    const upgrade = database.transaction((fail: boolean) => {
        dao.initializeSchema();
        dao.upsertPolicies([{pattern: "new.test:5037", info: {
            ADB: {accessType: PolicyAccessType.ADB_ACCESS, lifetime: PolicyLifetime.LOCAL,
                status: PolicyResponse.DENIED, reason: "New explicit denial"},
        }}]);
        if (fail) throw new Error("fixture outer acknowledgement failure");
    });
    assert.throws(() => upgrade.immediate(true), /fixture outer acknowledgement failure/);
    assert.deepEqual(storedPolicyRows(database), rows);
    assert.deepEqual(policySchemaObjects(database), objects);
    assert.equal(database.inTransaction, false);
    upgrade.immediate(false);
    assert.equal(dao.loadPolicies().find((entry) => entry.pattern === "new.test:5037")?.info.ADB?.status, PolicyResponse.DENIED);
    assert.deepEqual(storedPolicyRows(database).slice(0, rows.length), rows);
    new PolicyDao(database).initializeSchema();
});

test("invalid legacy rows cannot be silently retained under weakened CHECK constraints", (t) => {
    const database = legacyDatabase(t);
    database.exec(`pragma ignore_check_constraints = on;
        insert into "policy_rules" values ('unknown.test:443', 'UNKNOWN', 'LOCAL', 'ALLOWED', 'Corrupt legacy row', 123);
        pragma ignore_check_constraints = off;`);
    const before = storedPolicyRows(database);
    const objects = policySchemaObjects(database);
    assert.throws(() => new PolicyDao(database).initializeSchema(), /CHECK constraint failed/);
    assert.deepEqual(storedPolicyRows(database), before);
    assert.deepEqual(policySchemaObjects(database), objects);
});

test("a cold config-sync import and schema upgrade roll back with their outer acknowledgement and can retry", (t) => {
    const database = legacyDatabase(t);
    const rows = storedPolicyRows(database);
    const objects = policySchemaObjects(database);
    database.exec('create table "migration_sync_ack" ("revision" text primary key)');
    const adapters = new ConfigSyncAdapters(path.join(os.tmpdir(), "unused-policy-migration-settings"), database);
    t.after(() => adapters.close());
    const originalGlobals = database.prepare(`select "pattern", "accessType", "status", "reason" from "policy_rules"
        where "lifetime" = 'GLOBAL' order by "pattern", "accessType"`).all();
    const originalContent = canonicalConfigContent({rules: originalGlobals});
    const captured = {content: originalContent, materialized: originalContent, modifiedAt: "2025-01-01T00:00:00.000Z"};
    const content = canonicalConfigContent({rules: [{pattern: "adb.test:5037", accessType: PolicyAccessType.ADB_ACCESS,
        status: PolicyResponse.DENIED, reason: "Remote explicit denial"}]});
    const complete = database.transaction((fail: boolean) => {
        assert.deepEqual(adapters.apply("global-policies", captured, content), {applied: true, materialized: content});
        database.prepare('insert into "migration_sync_ack" values (?)').run("1");
        if (fail) throw new Error("fixture fails acknowledgement after migration and import");
    });
    assert.throws(() => complete.immediate(true), /fixture fails acknowledgement/);
    assert.deepEqual(storedPolicyRows(database), rows);
    assert.deepEqual(policySchemaObjects(database), objects);
    assert.equal(database.prepare('select count(*) from "migration_sync_ack"').pluck().get(), 0);
    assert.equal(database.prepare('select count(*) from "policy_migration_audit"').pluck().get(), 0);
    complete.immediate(false);
    assert.equal(database.prepare('select count(*) from "migration_sync_ack"').pluck().get(), 1);
    assert.equal(adapters.capture("global-policies").content, content);
});

test("unsupported foreign-key dependents fail closed without cascading rows or changing schema", (t) => {
    const database = legacyDatabase(t);
    database.exec(`pragma foreign_keys = on;
        create table "policy_dependency" ("pattern" text, "accessType" text,
            foreign key ("pattern", "accessType") references "policy_rules" ("pattern", "accessType") on delete cascade);
        insert into "policy_dependency" values ('/work/allowed', 'FS_READ');`);
    const rows = storedPolicyRows(database);
    const objects = policySchemaObjects(database);
    assert.throws(() => new PolicyDao(database).initializeSchema(), /foreign-key referenced table/);
    assert.deepEqual(storedPolicyRows(database), rows);
    assert.deepEqual(policySchemaObjects(database), objects);
    assert.deepEqual(database.prepare('select * from "policy_dependency"').all(), [{pattern: "/work/allowed", accessType: "FS_READ"}]);
    assert.equal(database.prepare("pragma foreign_keys").pluck().get(), 1);
});

test("a future or unknown schema vocabulary is not silently rewritten or weakened", (t) => {
    const database = SqliteDatabase.test(false, ":memory:");
    t.after(() => database.close());
    database.exec(`create table "policy_rules" (
        "pattern" text not null, "accessType" text not null check ("accessType" in ('FS_READ', 'UNKNOWN')),
        "lifetime" text not null check ("lifetime" in ('LOCAL', 'GLOBAL')),
        "status" text not null check ("status" in ('ALLOWED', 'DENIED')),
        "reason" text not null, "updatedAt" integer not null, primary key ("pattern", "accessType"));
        insert into "policy_rules" values ('/saved', 'FS_READ', 'LOCAL', 'DENIED', 'Existing denial', 123);`);
    const rows = storedPolicyRows(database);
    const objects = policySchemaObjects(database);
    assert.throws(() => new PolicyDao(database).initializeSchema(), /Unsupported policy access-type vocabulary/);
    assert.deepEqual(storedPolicyRows(database), rows);
    assert.deepEqual(policySchemaObjects(database), objects);
});

test("config-sync upgrades a legacy schema and imports every additive channel without losing existing decisions", (t) => {
    const database = legacyDatabase(t);
    const rows = storedPolicyRows(database);
    const adapters = new ConfigSyncAdapters(path.join(os.tmpdir(), "unused-policy-migration-settings"), database);
    t.after(() => adapters.close());
    const captured = adapters.capture("global-policies");
    const originalGlobals = decodeGlobalPolicyRules(captured.content);
    const added = APPLICATION_POLICY_CHANNELS.map(([protocol, accessType], index) => ({
        pattern: `${protocol}.test:15555`, accessType,
        status: index % 2 === 0 ? PolicyResponse.ALLOWED : PolicyResponse.DENIED, reason: `Synced ${protocol} channel`,
    }));
    const rules = [...originalGlobals, ...added].sort((a, b) => Buffer.compare(Buffer.from(a.pattern), Buffer.from(b.pattern))
        || Buffer.compare(Buffer.from(a.accessType), Buffer.from(b.accessType)));
    const content = canonicalConfigContent({rules});
    assert.deepEqual(adapters.apply("global-policies", captured, content), {applied: true, materialized: content});
    assert.equal(adapters.capture("global-policies").content, content);
    const loaded = new PolicyDao(database).loadPolicies();
    for (const entry of added) {
        assert.deepEqual(loaded.find((policy) => policy.pattern === entry.pattern)?.info[entry.accessType], {
            accessType: entry.accessType, lifetime: PolicyLifetime.GLOBAL, status: entry.status, reason: entry.reason,
        });
    }
    // The migration itself preserves all timestamps. The import intentionally
    // replaces GLOBAL rows, but must not rewrite LOCAL/ONCE/SESSION metadata.
    assert.deepEqual(database.prepare(`select rowid, * from "policy_rules" where "lifetime" <> 'GLOBAL' order by rowid`).all(),
        rows.filter((row) => (row as {lifetime: string}).lifetime !== "GLOBAL"));
    for (const original of originalGlobals) {
        assert.deepEqual(loaded.find((policy) => policy.pattern === original.pattern)?.info[original.accessType], {
            accessType: original.accessType, lifetime: PolicyLifetime.GLOBAL, status: original.status, reason: original.reason,
        });
    }
});

function legacyDatabase(t: TestContext, includeAdb = false, includeRetiredDelete = false): SqliteDatabase {
    const database = SqliteDatabase.test(false, ":memory:");
    t.after(() => database.close());
    createLegacyPolicySchema(database, includeAdb, includeRetiredDelete);
    return database;
}

function notTable(value: unknown): boolean {
    return (value as {type: string}).type !== "table";
}
