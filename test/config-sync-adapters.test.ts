import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test, {type TestContext} from "node:test";
import {ConfigSyncAdapters} from "../src/server/config-sync/ConfigSyncAdapters.js";
import {
    canonicalConfigContent,
    configHash,
} from "../src/server/config-sync/ConfigSyncProtocol.js";
import {initialDisplayDefaults} from "../src/tui/tool/DisplayDefaults.js";
import {initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {openIsolatedTestDatabase} from "./fixtures/IsolatedTestDatabase.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {PolicyAccessType, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";

type Rule = {pattern: string; accessType: PolicyAccessType; status: PolicyResponse; reason: string};
const savedFiles = [
    ["display-defaults", initialDisplayDefaults],
    ["subagent-defaults", initialSubagentDefaults],
    ["policy-defaults", initialPolicyDefaults],
    ["web-search", {version: 1, providers: ["brave"], brave: {apiKey: "saved-secret"}}],
] as const;

for (const incoming of [null, canonicalConfigContent({normal: "full", alternate: "minimal"})]) {
    test(`JSON ${incoming === null ? "reset" : "replacement"} preserves a local save made during durable checkpoint I/O`, (t) => {
        const {directory, adapters} = fixture(t);
        fs.mkdirSync(directory, {mode: 0o700});
        const file = path.join(directory, "display-defaults.json");
        const original = canonicalConfigContent(initialDisplayDefaults);
        const newer = canonicalConfigContent({normal: "truncated", alternate: "full"});
        fs.writeFileSync(file, original);
        const captured = adapters.capture("display-defaults");
        let checkpoints = 0;
        const result = adapters.apply("display-defaults", captured, incoming, () => {
            checkpoints++;
            fs.writeFileSync(file, newer);
        });
        assert.equal(checkpoints, 1);
        assert.deepEqual(result, {applied: false, materialized: original});
        assert.equal(fs.readFileSync(file, "utf8"), newer);
        assert.equal(captured.content, original);
        assert.deepEqual(fs.readdirSync(directory), ["display-defaults.json"]);
    });
}

for (const [key, value] of savedFiles) {
    test(`${key}: captures only saved JSON, imports privately, and resets to absence`, (t) => {
        const {directory, adapters} = fixture(t);
        const file = path.join(directory, `${key}.json`);
        const unset = adapters.capture(key);
        assert.equal(unset.content, null);
        assert.equal(unset.materialized, null);
        assert.equal(fs.existsSync(directory), false);
        assert.match(unset.modifiedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

        const content = canonicalConfigContent(value);
        assert.deepEqual(adapters.apply(key, unset, content), {applied: true, materialized: content});
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700 & ~process.umask());
        assert.equal(fs.statSync(file).mode & 0o777, 0o600 & ~process.umask());
        assert.equal(fs.readFileSync(file, "utf8"), content);
        assert.equal(fs.existsSync(path.join(directory, "pilot.sqlite")), false);

        fs.writeFileSync(file, JSON.stringify(value, null, 4));
        fs.utimesSync(file, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-02T03:04:05.006Z"));
        const captured = adapters.capture(key);
        assert.equal(captured.content, content);
        assert.equal(captured.materialized, content);
        assert.equal(captured.modifiedAt, "2025-01-02T03:04:05.006Z");
        assert.deepEqual(adapters.apply(key, captured, null), {applied: true, materialized: null});
        assert.equal(fs.existsSync(file), false);
        assert.deepEqual(adapters.apply(key, adapters.capture(key), null), {applied: true, materialized: null});
        assert.deepEqual(fs.readdirSync(directory), []);
    });

    test(`${key}: replays completed replacement and reset after an uncommitted acknowledgement`, (t) => {
        const {directory, adapters} = fixture(t);
        const file = path.join(directory, `${key}.json`);
        const captured = adapters.capture(key);
        const content = canonicalConfigContent(value);
        assert.deepEqual(adapters.apply(key, captured, content), {applied: true, materialized: content});
        const importedInode = fs.statSync(file).ino;

        // The journal still holds the original capture if its commit failed
        // after replacement. Recovery must acknowledge without another rename.
        assert.deepEqual(adapters.apply(key, captured, content), {applied: true, materialized: content});
        assert.equal(fs.statSync(file).ino, importedInode);
        assert.equal(captured.content, null);
        assert.equal(captured.materialized, null);

        const beforeReset = adapters.capture(key);
        assert.deepEqual(adapters.apply(key, beforeReset, null), {applied: true, materialized: null});
        assert.deepEqual(adapters.apply(key, beforeReset, null), {applied: true, materialized: null});
        assert.equal(fs.existsSync(file), false);
        assert.equal(beforeReset.content, content);
        assert.deepEqual(fs.readdirSync(directory), []);
    });
}

test("file replacement is atomic and private, without modifying hard-link peers or unrelated saved files", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory, {mode: 0o700});
    const file = path.join(directory, "display-defaults.json");
    const peer = path.join(directory, "hard-link.json");
    const oldContent = canonicalConfigContent(initialDisplayDefaults);
    fs.writeFileSync(file, oldContent, {mode: 0o644});
    fs.linkSync(file, peer);
    fs.writeFileSync(path.join(directory, "server.json"), "unrelated");
    const before = fs.statSync(file).ino;
    const replacement = canonicalConfigContent({normal: "full", alternate: "minimal"});

    assert.equal(adapters.apply("display-defaults", adapters.capture("display-defaults"), replacement).applied, true);

    assert.notEqual(fs.statSync(file).ino, before);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600 & ~process.umask());
    assert.equal(fs.readFileSync(file, "utf8"), replacement);
    assert.equal(fs.readFileSync(peer, "utf8"), oldContent);
    assert.equal(fs.readFileSync(path.join(directory, "server.json"), "utf8"), "unrelated");
    assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".config-sync-")), false);
});

test("failed atomic replacement preserves the old saved file and removes its private temporary file", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    const original = canonicalConfigContent(initialDisplayDefaults);
    fs.writeFileSync(file, original);
    const captured = adapters.capture("display-defaults");
    const replacement = canonicalConfigContent({normal: "full", alternate: "full"});
    t.mock.method(fs, "renameSync", () => { throw new Error("fixture rejects replacement"); });

    assert.throws(() => adapters.apply("display-defaults", captured, replacement), /fixture rejects replacement/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(directory), ["display-defaults.json"]);
});

test("captured upload bytes and hash remain frozen when a later edit defers import", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "subagent-defaults.json");
    const original = canonicalConfigContent({...initialSubagentDefaults, high: "provider/saved-preference"});
    fs.writeFileSync(file, original);
    const captured = adapters.capture("subagent-defaults");
    const hash = configHash(captured.content);
    const edited = canonicalConfigContent({...initialSubagentDefaults, high: "provider/new-local"});
    fs.writeFileSync(file, edited);
    const remote = canonicalConfigContent({...initialSubagentDefaults, high: "provider/remote"});

    assert.deepEqual(adapters.apply("subagent-defaults", captured, remote), {
        applied: false, materialized: original,
    });
    assert.equal(captured.content, original);
    assert.equal(configHash(captured.content), hash);
    assert.equal(Object.isFrozen(captured), true);
    assert.equal(fs.readFileSync(file, "utf8"), edited);
    assert.equal(adapters.capture("subagent-defaults").content, edited);
});

test("creation and deletion during exchange also defer both replacement and reset", (t) => {
    const {directory, adapters} = fixture(t);
    const content = canonicalConfigContent(initialDisplayDefaults);
    const absent = adapters.capture("display-defaults");
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, content);
    assert.deepEqual(adapters.apply("display-defaults", absent, null), {applied: false, materialized: null});
    assert.equal(fs.readFileSync(file, "utf8"), content);

    const present = adapters.capture("display-defaults");
    fs.unlinkSync(file);
    assert.deepEqual(adapters.apply("display-defaults", present, content), {applied: false, materialized: content});
    assert.equal(fs.existsSync(file), false);
});

test("write-back guard runs after temporary-file preparation and cleans up on deferral", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, canonicalConfigContent(initialDisplayDefaults));
    const captured = adapters.capture("display-defaults");
    const edited = canonicalConfigContent({normal: "full", alternate: "full"});
    const sync = fs.fsyncSync;
    t.mock.method(fs, "fsyncSync", (descriptor: number) => {
        sync(descriptor);
        fs.writeFileSync(file, edited);
    });

    const remote = canonicalConfigContent({normal: "full", alternate: "minimal"});
    assert.deepEqual(adapters.apply("display-defaults", captured, remote), {
        applied: false, materialized: captured.materialized,
    });
    assert.equal(fs.readFileSync(file, "utf8"), edited);
    assert.deepEqual(fs.readdirSync(directory), ["display-defaults.json"]);
});

test("write-back guard acknowledges a winner already materialized during preparation without replacing it again", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, canonicalConfigContent(initialDisplayDefaults));
    const captured = adapters.capture("display-defaults");
    const remote = canonicalConfigContent({normal: "full", alternate: "full"});
    const inode = fs.statSync(file).ino;
    const sync = fs.fsyncSync;
    t.mock.method(fs, "fsyncSync", (descriptor: number) => {
        sync(descriptor);
        fs.writeFileSync(file, remote);
    });

    assert.deepEqual(adapters.apply("display-defaults", captured, remote), {applied: true, materialized: remote});
    assert.equal(fs.statSync(file).ino, inode);
    assert.equal(fs.readFileSync(file, "utf8"), remote);
    assert.equal(captured.content, canonicalConfigContent(initialDisplayDefaults));
    assert.deepEqual(fs.readdirSync(directory), ["display-defaults.json"]);
});

for (const target of [canonicalConfigContent({normal: "full", alternate: "minimal"}), null]) {
    test(`beforeWrite checkpoints immediately before JSON ${target === null ? "reset" : "replacement"} and can abort without source mutation`, (t) => {
        const {directory, adapters} = fixture(t);
        fs.mkdirSync(directory);
        const file = path.join(directory, "display-defaults.json");
        const original = canonicalConfigContent(initialDisplayDefaults);
        fs.writeFileSync(file, original);
        const captured = adapters.capture("display-defaults");
        const blocked = t.mock.fn((materialized: string | null) => {
            assert.equal(materialized, target);
            assert.equal(fs.readFileSync(file, "utf8"), original);
            throw new Error("fixture checkpoint failure");
        });
        assert.throws(() => adapters.apply("display-defaults", captured, target, blocked), /fixture checkpoint failure/);
        assert.equal(blocked.mock.callCount(), 1);
        assert.equal(fs.readFileSync(file, "utf8"), original);
        assert.deepEqual(fs.readdirSync(directory), ["display-defaults.json"]);

        const checkpoint = t.mock.fn((materialized: string | null) => {
            assert.equal(materialized, target);
            assert.equal(fs.readFileSync(file, "utf8"), original);
        });
        assert.deepEqual(adapters.apply("display-defaults", captured, target, checkpoint), {applied: true, materialized: target});
        assert.equal(checkpoint.mock.callCount(), 1);
        assert.equal(target === null ? !fs.existsSync(file) : fs.readFileSync(file, "utf8") === target, true);
        assert.equal(captured.content, original);
        assert.equal(captured.materialized, original);
        assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".config-sync-")), false);
    });
}

test("JSON no-ops, already-applied winners, and concurrency deferral never invoke beforeWrite", (t) => {
    const {directory, adapters} = fixture(t);
    const checkpoint = t.mock.fn(() => { throw new Error("unexpected source mutation checkpoint"); });
    const absent = adapters.capture("display-defaults");
    assert.equal(adapters.apply("display-defaults", absent, null, checkpoint).applied, true);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    const original = canonicalConfigContent(initialDisplayDefaults);
    fs.writeFileSync(file, original);
    assert.equal(adapters.apply("display-defaults", absent, original, checkpoint).applied, true);
    const captured = adapters.capture("display-defaults");
    assert.equal(adapters.apply("display-defaults", captured, original, checkpoint).applied, true);
    fs.writeFileSync(file, canonicalConfigContent({normal: "hidden", alternate: "hidden"}));
    assert.deepEqual(adapters.apply("display-defaults", captured, null, checkpoint), {applied: false, materialized: captured.materialized});
    assert.equal(checkpoint.mock.callCount(), 0);
});

test("replacement prepares and fsyncs its private temporary file before calling beforeWrite, with no callback on a late no-op", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    fs.writeFileSync(file, canonicalConfigContent(initialDisplayDefaults));
    const captured = adapters.capture("display-defaults");
    const target = canonicalConfigContent({normal: "full", alternate: "minimal"});
    const events: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    t.mock.method(fs, "fsyncSync", (descriptor: number) => { events.push("fsync"); fsync(descriptor); });
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => { events.push("rename"); rename(from, to); });
    adapters.apply("display-defaults", captured, target, () => { events.push("checkpoint"); });
    assert.deepEqual(events, ["fsync", "checkpoint", "rename", "fsync"]);

    fs.writeFileSync(file, canonicalConfigContent(initialDisplayDefaults));
    t.mock.method(fs, "fsyncSync", (descriptor: number) => { fsync(descriptor); fs.writeFileSync(file, target); });
    const checkpoint = t.mock.fn(() => { throw new Error("unexpected checkpoint for late no-op"); });
    assert.equal(adapters.apply("display-defaults", captured, target, checkpoint).applied, true);
    assert.equal(checkpoint.mock.callCount(), 0);
    assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".config-sync-")), false);
});

test("GLOBAL imports do not use the JSON source-mutation checkpoint", (t) => {
    const {adapters} = policyFixture(t);
    const checkpoint = t.mock.fn(() => { throw new Error("GLOBAL must remain in its SQLite transaction"); });
    assert.equal(adapters.apply("global-policies", adapters.capture("global-policies"), bundle([rule("global")]), checkpoint).applied, true);
    assert.equal(checkpoint.mock.callCount(), 0);
});

test("file reads reject links, dangling links, and linked source directories", (t) => {
    const {root, directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, canonicalConfigContent(initialDisplayDefaults));
    const file = path.join(directory, "display-defaults.json");
    try {
        fs.symlinkSync(target, file);
        fs.unlinkSync(file);
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "ENOTSUP")) {
            t.skip("Host filesystem does not permit symbolic-link fixtures.");
            return;
        }
        throw error;
    }
    for (const destination of [target, path.join(root, "missing")]) {
        fs.symlinkSync(destination, file);
        assert.throws(() => adapters.capture("display-defaults"));
        assert.throws(() => adapters.apply("display-defaults", emptySnapshot(), null));
        fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
    fs.symlinkSync(root, directory);
    assert.throws(() => adapters.capture("display-defaults"), /regular directory/);
    assert.equal(fs.readFileSync(target, "utf8"), canonicalConfigContent(initialDisplayDefaults));
});

test("file reads reject directory sources", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    fs.mkdirSync(path.join(directory, "display-defaults.json"));
    assert.throws(() => adapters.capture("display-defaults"), /regular file/);
});

test("file reads reject FIFO sources without blocking", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const result = spawnSync("mkfifo", [path.join(directory, "display-defaults.json")]);
    if (result.status !== 0) {
        t.skip("Host filesystem does not permit FIFO fixtures.");
        return;
    }
    assert.throws(() => adapters.capture("display-defaults"), /regular file/);
});

test("source size is bounded before parsing, including growth after fstat", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    const compact = canonicalConfigContent(initialDisplayDefaults);
    fs.writeFileSync(file, compact.padEnd(256 * 1024));
    assert.equal(adapters.capture("display-defaults").content, compact);
    fs.appendFileSync(file, " ");
    assert.throws(() => adapters.capture("display-defaults"), /size limit/);

    fs.writeFileSync(file, compact);
    const stat = fs.fstatSync;
    let grew = false;
    t.mock.method(fs, "fstatSync", (descriptor: number) => {
        const result = stat(descriptor);
        if (!grew) {
            grew = true;
            fs.appendFileSync(file, " ".repeat(256 * 1024));
        }
        return result;
    });
    assert.throws(() => adapters.capture("display-defaults"), /size limit/);
});

test("malformed JSON, invalid UTF-8, unsupported fields, and unsupported saved values fail closed", (t) => {
    const {directory, adapters} = fixture(t);
    fs.mkdirSync(directory);
    const file = path.join(directory, "display-defaults.json");
    for (const raw of ["{", "null", "[]", '{"normal":"invalid","alternate":"minimal"}',
        '{"normal":"minimal","alternate":"minimal","secret":"not allowed"}', Buffer.from([0xff])]) {
        fs.writeFileSync(file, raw);
        assert.throws(() => adapters.capture("display-defaults"));
    }
    for (const [key] of savedFiles) {
        assert.throws(() => adapters.apply(key, emptySnapshot(), '{"unexpected":true}'));
    }
    assert.throws(() => adapters.apply("global-policies", emptySnapshot(), '{"rules":[{"lifetime":"GLOBAL"}]}'));
});

test("GLOBAL imports preserve every non-GLOBAL decision and return only materialized GLOBAL rows", (t) => {
    const {adapters, database, dao} = policyFixture(t);
    for (const lifetime of [PolicyLifetime.LOCAL, PolicyLifetime.SESSION, PolicyLifetime.ONCE]) {
        save(dao, rule(lifetime), lifetime);
    }
    save(dao, rule("old-global"));
    const originalNonGlobals = dao.loadPolicies().filter((policy) => policy.pattern !== "old-global");
    const remote = bundle([rule("LOCAL", "remote collision"), rule("new-global")]);
    const captured = adapters.capture("global-policies");

    const result = adapters.apply("global-policies", captured, remote);

    assert.deepEqual(result, {applied: true, materialized: bundle([rule("new-global")])});
    assert.deepEqual(dao.loadPolicies().filter((policy) => policy.pattern !== "new-global"), originalNonGlobals);
    assert.equal(database.prepare('select count(*) from "policy_rules"').pluck().get(), 4);
});

test("LOCAL collisions do not turn hidden remote GLOBAL rows into deletions on the next export", (t) => {
    const {adapters, dao} = policyFixture(t);
    save(dao, rule("masked", "local decision"), PolicyLifetime.LOCAL);
    const remote = bundle([rule("masked", "remote decision"), rule("visible")]);
    const imported = adapters.apply("global-policies", adapters.capture("global-policies"), remote);
    const baseline = {content: remote, materialized: imported.materialized};
    assert.equal(imported.materialized, bundle([rule("visible")]));
    assert.equal(adapters.capture("global-policies", baseline).content, remote);

    dao.deletePolicy("visible", PolicyAccessType.HTTP_GET);
    save(dao, rule("new-local-global"));
    const changed = adapters.capture("global-policies", baseline);
    assert.equal(changed.content, bundle([rule("masked", "remote decision"), rule("new-local-global")]));
    assert.equal(changed.materialized, bundle([rule("new-local-global")]));

    // Removing the LOCAL blocker does not manufacture a deletion either. A
    // subsequent import can materialize the previously hidden remote decision.
    dao.deletePolicy("masked", PolicyAccessType.HTTP_GET);
    const reapplied = adapters.apply("global-policies", changed, changed.content);
    assert.equal(reapplied.materialized, changed.content);
});

for (const lifetime of [PolicyLifetime.LOCAL, PolicyLifetime.SESSION, PolicyLifetime.ONCE]) {
    test(`GLOBAL replaced by ${lifetime} masks the canonical rule rather than exporting its deletion`, (t) => {
        const {adapters, dao} = policyFixture(t);
        const remote = bundle([rule("masked", "remote decision"), rule("visible")]);
        const imported = adapters.apply("global-policies", adapters.capture("global-policies"), remote);
        const baseline = {content: remote, materialized: imported.materialized};
        save(dao, rule("masked", "private non-global decision"), lifetime);

        const masked = adapters.capture("global-policies", baseline);

        assert.equal(masked.content, remote);
        assert.equal(masked.materialized, bundle([rule("visible")]));
        assert.equal(masked.content?.includes("private non-global decision"), false);
        const acknowledged = adapters.apply("global-policies", masked, remote);
        assert.deepEqual(acknowledged, {applied: true, materialized: masked.materialized});
        assert.equal(dao.loadPolicies().find((entry) => entry.pattern === "masked")?.info.GET?.lifetime, lifetime);

        dao.deletePolicy("masked", PolicyAccessType.HTTP_GET);
        const unmasked = adapters.capture("global-policies", {content: remote, materialized: acknowledged.materialized});
        assert.equal(unmasked.content, remote);
        assert.deepEqual(adapters.apply("global-policies", unmasked, remote), {applied: true, materialized: remote});
    });
}

test("a missing GLOBAL row with no exact non-GLOBAL identity collision still exports a deletion", (t) => {
    const {adapters, dao} = policyFixture(t);
    const remote = bundle([rule("deleted"), rule("visible")]);
    const imported = adapters.apply("global-policies", adapters.capture("global-policies"), remote);
    dao.deletePolicy("deleted", PolicyAccessType.HTTP_GET);
    save(dao, {...rule("deleted"), accessType: PolicyAccessType.FS_READ}, PolicyLifetime.LOCAL);
    save(dao, rule("different-pattern"), PolicyLifetime.LOCAL);

    const captured = adapters.capture("global-policies", {content: remote, materialized: imported.materialized});

    assert.equal(captured.content, bundle([rule("visible")]));
    assert.equal(captured.materialized, bundle([rule("visible")]));
});

test("mask lookups preserve the canonical winner and share the GLOBAL read transaction, looking up only removed identities", (t) => {
    const {adapters, dao, database} = policyFixture(t);
    const original = bundle([rule("masked", "old decision"), rule("deleted"), rule("visible")]);
    const imported = adapters.apply("global-policies", adapters.capture("global-policies"), original);
    save(dao, rule("masked", "local-only decision"), PolicyLifetime.LOCAL);
    dao.deletePolicy("deleted", PolicyAccessType.HTTP_GET);
    dao.upsertPolicies(Array.from({length: 2048}, (_, index) => ({
        pattern: `unrelated-${index}`,
        info: {GET: {accessType: PolicyAccessType.HTTP_GET, lifetime: PolicyLifetime.LOCAL,
            status: PolicyResponse.ALLOWED, reason: "unrelated local decision"}},
    })));
    const canonical = bundle([rule("masked", "new canonical decision"), rule("deleted"), rule("visible")]);
    assert.equal(database.inTransaction, false);
    const prepare = database.prepare.bind(database);
    const lookedUp: unknown[][] = [];
    let globalReads = 0;
    t.mock.method(database, "prepare", (sql: string) => {
        const statement = prepare(sql);
        if (!/\bselect\b/i.test(sql)) return statement;
        assert.equal(database.inTransaction, true);
        if (sql.includes('"lifetime" <> ?')) {
            assert.match(sql, /where "pattern" = \? and "accessType" = \?/);
            const get = statement.get.bind(statement);
            t.mock.method(statement, "get", (...parameters: unknown[]) => {
                assert.equal(database.inTransaction, true);
                lookedUp.push(parameters);
                return get(...parameters);
            });
        } else {
            assert.match(sql, /where "lifetime" = \?/);
            globalReads++;
        }
        return statement;
    });

    const captured = adapters.capture("global-policies", {content: canonical, materialized: imported.materialized});

    assert.equal(captured.content, bundle([rule("masked", "new canonical decision"), rule("visible")]));
    assert.equal(globalReads, 1);
    assert.deepEqual(lookedUp, [
        ["deleted", PolicyAccessType.HTTP_GET, PolicyLifetime.GLOBAL],
        ["masked", PolicyAccessType.HTTP_GET, PolicyLifetime.GLOBAL],
    ]);
    assert.equal(database.inTransaction, false);
});

test("reapplying a canonical bundle under persistent LOCAL masks does not rewrite unchanged GLOBAL rows", (t) => {
    const {adapters, dao, database} = policyFixture(t);
    save(dao, rule("masked", "local-only decision"), PolicyLifetime.LOCAL);
    const remote = bundle([rule("masked"), rule("visible")]);
    const imported = adapters.apply("global-policies", adapters.capture("global-policies"), remote);
    database.prepare('update "policy_rules" set "updatedAt" = ? where "lifetime" = ?').run(123, PolicyLifetime.GLOBAL);
    const before = database.prepare('select * from "policy_rules" order by "pattern", "accessType"').all();
    database.exec(`
        create trigger "reject_global_churn_delete" before delete on "policy_rules"
        when old."lifetime" = 'GLOBAL'
        begin select raise(abort, 'fixture rejects unnecessary GLOBAL deletion'); end;
        create trigger "reject_global_churn_insert" before insert on "policy_rules"
        when new."lifetime" = 'GLOBAL'
        begin select raise(abort, 'fixture rejects unnecessary GLOBAL insertion'); end;
    `);
    const captured = adapters.capture("global-policies", {content: remote, materialized: imported.materialized});

    assert.deepEqual(adapters.apply("global-policies", captured, remote), {applied: true, materialized: imported.materialized});
    assert.deepEqual(database.prepare('select * from "policy_rules" order by "pattern", "accessType"').all(), before);
});

test("policy capture overlays edits and deletions onto canonical baseline without losing unrelated remote state", (t) => {
    const {adapters, dao} = policyFixture(t);
    const original = bundle([rule("edit"), rule("delete"), rule("unchanged")]);
    adapters.apply("global-policies", adapters.capture("global-policies"), original);
    save(dao, rule("edit", "local edit"));
    dao.deletePolicy("delete", PolicyAccessType.HTTP_GET);
    save(dao, rule("add"));
    const canonical = bundle([rule("edit"), rule("delete"), rule("unchanged"), rule("remote-only")]);

    const captured = adapters.capture("global-policies", {content: canonical, materialized: original});

    assert.equal(captured.content, bundle([rule("edit", "local edit"), rule("unchanged"), rule("add"), rule("remote-only")]));
    assert.equal(captured.materialized, bundle([rule("edit", "local edit"), rule("unchanged"), rule("add")]));
});

test("a deferred policy import acknowledges the captured baseline, so later local edits rebase onto the winner", (t) => {
    const {adapters, dao} = policyFixture(t);
    save(dao, rule("edited"));
    save(dao, rule("deleted"));
    const captured = adapters.capture("global-policies");
    const oldContent = captured.content;
    save(dao, rule("edited", "edited during request"));
    dao.deletePolicy("deleted", PolicyAccessType.HTTP_GET);
    save(dao, rule("local-addition"));
    const remote = bundle([rule("edited", "remote edit"), rule("deleted"), rule("server-addition")]);

    const result = adapters.apply("global-policies", captured, remote);

    assert.deepEqual(result, {applied: false, materialized: captured.materialized});
    assert.equal(captured.content, oldContent);
    const next = adapters.capture("global-policies", {content: remote, materialized: result.materialized});
    assert.equal(next.content, bundle([
        rule("edited", "edited during request"), rule("local-addition"), rule("server-addition"),
    ]));
});

test("GLOBAL reset preserves LOCAL rows and policy import rolls back deletion and partial insertion on failure", (t) => {
    const {adapters, dao, database} = policyFixture(t);
    save(dao, rule("local"), PolicyLifetime.LOCAL);
    save(dao, rule("original"));
    const captured = adapters.capture("global-policies");
    database.exec(`
        create trigger "fail_import" before insert on "policy_rules"
        when new."pattern" = 'z-fail'
        begin select raise(abort, 'fixture rejects insert'); end;
    `);

    assert.throws(() => adapters.apply("global-policies", captured, bundle([rule("a-first"), rule("z-fail")])), /fixture rejects insert/);
    assert.equal(adapters.capture("global-policies").content, captured.content);
    assert.equal(dao.loadPolicies().length, 2);
    assert.deepEqual(adapters.apply("global-policies", captured, null), {applied: true, materialized: null});
    assert.equal(dao.loadPolicies().length, 1);
    assert.equal(dao.loadPolicies()[0].info.GET?.lifetime, PolicyLifetime.LOCAL);
});

test("GLOBAL import savepoint rolls back with source acknowledgement in an outer immediate transaction", (t) => {
    const {adapters, dao, database} = policyFixture(t);
    save(dao, rule("original"));
    save(dao, rule("local"), PolicyLifetime.LOCAL);
    database.exec('create table "config_sync_adapter_fixture" ("revision" text not null)');
    const captured = adapters.capture("global-policies");
    const remote = bundle([rule("remote")]);
    const complete = database.transaction((fail: boolean) => {
        assert.deepEqual(adapters.apply("global-policies", captured, remote), {applied: true, materialized: remote});
        database.prepare('insert into "config_sync_adapter_fixture" ("revision") values (?)').run("1");
        if (fail) throw new Error("fixture acknowledgement fails");
    });

    assert.throws(() => complete.immediate(true), /fixture acknowledgement fails/);
    assert.equal(adapters.capture("global-policies").content, captured.content);
    assert.equal(database.prepare('select count(*) from "config_sync_adapter_fixture"').pluck().get(), 0);
    complete.immediate(false);
    assert.equal(adapters.capture("global-policies").content, remote);
    assert.equal(database.prepare('select count(*) from "config_sync_adapter_fixture"').pluck().get(), 1);
    assert.equal(dao.loadPolicies().find((entry) => entry.pattern === "local")?.info.GET?.lifetime, PolicyLifetime.LOCAL);
});

test("GLOBAL capture is canonical UTF-8 identity order and rejects oversized database content", (t) => {
    const {adapters, dao, database} = policyFixture(t);
    const rules = [rule("é"), rule("z"), rule("a"), {...rule("a"), accessType: PolicyAccessType.FS_READ}];
    for (const entry of rules) save(dao, entry);
    assert.equal(adapters.capture("global-policies").content, bundle(rules));
    database.prepare('update "policy_rules" set "reason" = ? where "pattern" = ?').run("x".repeat(256 * 1024), "z");
    assert.throws(() => adapters.capture("global-policies"), /size limit/);
});

test("self-created policy database is lazy and closed, while injected databases remain caller-owned", (t) => {
    const {directory, adapters} = fixture(t);
    // Keep the production opener/lifecycle under test while avoiding writable
    // WAL mmap, unsupported by the mediated filesystem running this fixture.
    const open = SqliteDatabase.open;
    t.mock.method(SqliteDatabase, "open", (file: string) => open(file).exec("pragma journal_mode = DELETE"));
    adapters.capture("display-defaults");
    assert.equal(fs.existsSync(directory), false);
    assert.equal(adapters.capture("global-policies").content, null);
    assert.equal(fs.existsSync(path.join(directory, "pilot.sqlite")), true);
    assert.equal(fs.statSync(path.join(directory, "pilot.sqlite")).mode & 0o777, 0o600 & ~process.umask());
    adapters.close();
    adapters.close();
    assert.throws(() => adapters.capture("global-policies"), /closed/);
    assert.throws(() => adapters.apply("display-defaults", emptySnapshot(), null), /closed/);

    const isolated = policyFixture(t);
    isolated.adapters.close();
    assert.equal(isolated.database.prepare("select 1").pluck().get(), 1);
});

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-config-adapters-"));
    const directory = path.join(root, "settings");
    const adapters = new ConfigSyncAdapters(directory);
    t.after(() => {
        adapters.close();
        fs.rmSync(root, {recursive: true, force: true});
    });
    return {root, directory, adapters};
}

function policyFixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-config-policies-"));
    const database = openIsolatedTestDatabase(path.join(root, "fixture.sqlite"));
    const dao = new PolicyDao(database);
    dao.initializeSchema();
    const adapters = new ConfigSyncAdapters(path.join(root, "settings"), database);
    t.after(() => {
        adapters.close();
        database.close();
        fs.rmSync(root, {recursive: true, force: true});
    });
    return {adapters, dao, database};
}

function rule(pattern: string, reason = "saved reason"): Rule {
    return {pattern, accessType: PolicyAccessType.HTTP_GET, status: PolicyResponse.ALLOWED, reason};
}

function save(dao: PolicyDao, entry: Rule, lifetime = PolicyLifetime.GLOBAL): void {
    dao.upsertPolicies([{
        pattern: entry.pattern,
        info: {[entry.accessType]: {accessType: entry.accessType, lifetime, status: entry.status, reason: entry.reason}},
    }]);
}

function bundle(entries: Rule[]): string | null {
    if (entries.length === 0) return null;
    const rules = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.pattern), Buffer.from(right.pattern))
        || Buffer.compare(Buffer.from(left.accessType), Buffer.from(right.accessType)));
    return canonicalConfigContent({rules});
}

function emptySnapshot() {
    return {content: null, materialized: null, modifiedAt: "2025-01-01T00:00:00.000Z"};
}
