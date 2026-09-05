import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {
    type Policy,
    type PolicyStatus,
    PolicyAccessType,
    PolicyLifetime,
    PolicyResponse,
} from "../src/policy/types.js";

test("policy storage initializes its schema lazily and idempotently", (context) => {
    const database = createDatabase(context);
    const dao = new PolicyDao(database);

    assert.deepEqual(dao.loadPolicies(), []);
    dao.initializeSchema();
    new PolicyDao(database).initializeSchema();
    dao.upsertPolicies([]);
    dao.deletePolicy("missing", PolicyAccessType.FS_READ);
    assert.deepEqual(dao.loadPolicies(), []);
    assert.deepEqual(database.prepare('pragma index_info("idx_policy_rules_access")').all(), [
        {seqno: 0, cid: 1, name: "accessType"},
        {seqno: 1, cid: 0, name: "pattern"},
    ]);
});

test("policy storage groups sorted filesystem and network rules without changing their contents", (context) => {
    const dao = new PolicyDao(createDatabase(context));
    const path = policy("/work/O'Reilly", status(PolicyAccessType.FS_WRITE), status(PolicyAccessType.FS_READ));
    const network = policy("example.com/v1", status(PolicyAccessType.HTTP_POST, {
        lifetime: PolicyLifetime.GLOBAL,
        status: PolicyResponse.DENIED,
        reason: "Keep 'quoted' reasons\nand newlines intact",
    }));
    path.info[PolicyAccessType.HTTP_GET] = undefined;

    dao.upsertPolicies([network, {pattern: "empty", info: {}}, path]);

    const loaded = dao.loadPolicies();
    assert.deepEqual(loaded, [
        policy(path.pattern, path.info.FS_READ!, path.info.FS_WRITE!),
        network,
    ]);
    assert.deepEqual(Object.keys(loaded[0]!.info), [PolicyAccessType.FS_READ, PolicyAccessType.FS_WRITE]);
    assert.equal(path.info[PolicyAccessType.HTTP_GET], undefined);
});

test("policy upserts replace only matching access types and share one batch timestamp", (context) => {
    const database = createDatabase(context);
    const dao = new PolicyDao(database);
    context.mock.method(Date, "now", () => 100);
    const read = status(PolicyAccessType.FS_READ);
    dao.upsertPolicies([policy("/work", read, status(PolicyAccessType.FS_WRITE))]);

    context.mock.method(Date, "now", () => 200);
    const write = status(PolicyAccessType.FS_WRITE, {
        lifetime: PolicyLifetime.GLOBAL,
        status: PolicyResponse.DENIED,
        reason: "replacement",
    });
    const network = policy("example.com", status(PolicyAccessType.HTTP_GET));
    dao.upsertPolicies([policy("/work", write), network]);

    assert.deepEqual(dao.loadPolicies(), [policy("/work", read, write), network]);
    assert.deepEqual(database.prepare('select "updatedAt" from "policy_rules" order by "pattern", "accessType"').all(), [
        {updatedAt: 100},
        {updatedAt: 200},
        {updatedAt: 200},
    ]);
});

test("deleting a policy leaves other access types and patterns untouched", (context) => {
    const dao = new PolicyDao(createDatabase(context));
    const read = status(PolicyAccessType.FS_READ);
    const other = policy("/other", read);
    dao.upsertPolicies([policy("/work", read, status(PolicyAccessType.FS_WRITE)), other]);

    dao.deletePolicy("/work", PolicyAccessType.FS_WRITE);
    dao.deletePolicy("/work", PolicyAccessType.FS_WRITE);
    assert.deepEqual(dao.loadPolicies(), [other, policy("/work", read)]);
    dao.deletePolicy("/work", PolicyAccessType.FS_READ);
    assert.deepEqual(dao.loadPolicies(), [other]);
});

test("invalid policy rows roll back the entire upsert batch", (context) => {
    const dao = new PolicyDao(createDatabase(context));
    const original = policy("/work", status(PolicyAccessType.FS_READ));
    dao.upsertPolicies([original]);

    const replacement = policy("/work", status(PolicyAccessType.FS_READ, {reason: "must be rolled back"}));
    for (const invalid of [
        {accessType: "invalid" as PolicyAccessType},
        {lifetime: "invalid" as PolicyLifetime},
        {status: "invalid" as PolicyResponse},
    ]) {
        assert.throws(() => dao.upsertPolicies([
            replacement,
            policy("/new", status(PolicyAccessType.FS_WRITE, invalid)),
        ]), /CHECK constraint failed/);
        assert.deepEqual(dao.loadPolicies(), [original]);
    }
});

function createDatabase(context: TestContext): SqliteDatabase {
    // Exercise real SQLite without WAL's file-backed mmap, which FUSE intentionally rejects.
    const database = SqliteDatabase.test(false, ":memory:");
    context.after(() => database.close());
    return database;
}

function policy(pattern: string, ...statuses: PolicyStatus[]): Policy {
    return {pattern, info: Object.fromEntries(statuses.map((entry) => [entry.accessType, entry]))};
}

function status(accessType: PolicyAccessType, overrides: Partial<PolicyStatus> = {}): PolicyStatus {
    return {
        accessType,
        lifetime: PolicyLifetime.LOCAL,
        status: PolicyResponse.ALLOWED,
        reason: "original",
        ...overrides,
    };
}
