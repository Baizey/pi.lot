import assert from "node:assert/strict";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {openIsolatedTestDatabase} from "./fixtures/IsolatedTestDatabase.js";

test("file-backed SQLite fixtures retain close/reopen persistence without shared-memory mappings", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-sqlite-fixture-"));
    const file = path.join(directory, "fixture.sqlite");
    let database = openIsolatedTestDatabase(file);
    try {
        assert.deepEqual(database.prepare("pragma journal_mode").get(), {journal_mode: "delete"});
        database.exec("create table fixture (value text); insert into fixture values ('persisted')");
        assert.equal(existsSync(`${file}-shm`), false);
        database.close();

        database = openIsolatedTestDatabase(file);
        assert.deepEqual(database.prepare("select value from fixture").get(), {value: "persisted"});
        assert.equal(existsSync(`${file}-shm`), false);
    } finally {
        database.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("isolated SQLite fixture setup failures close the database and preserve the original error", (context) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-sqlite-fixture-failure-"));
    const originalClose = SqliteDatabase.prototype.close;
    const failure = new Error("fixture configuration failed");
    let closes = 0;
    context.mock.method(SqliteDatabase.prototype, "exec", () => { throw failure; });
    context.mock.method(SqliteDatabase.prototype, "close", function (this: SqliteDatabase) {
        closes++;
        originalClose.call(this);
    });
    try {
        assert.throws(() => openIsolatedTestDatabase(path.join(directory, "fixture.sqlite")), (error) => error === failure);
        assert.equal(closes, 1);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
