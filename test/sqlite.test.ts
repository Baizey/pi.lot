import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import {SqliteDatabase} from "../src/storage/sqlite.js";

for (const failingPragma of ["busy_timeout", "journal_mode"]) {
    test(`SQLite initialization closes the opened handle when ${failingPragma} fails`, (context) => {
        const originalPragma = Database.prototype.pragma;
        const handles: Database.Database[] = [];
        const failure = new Error(`${failingPragma} initialization failed`);
        context.mock.method(Database.prototype, "pragma", function (
            this: Database.Database,
            ...args: Parameters<Database.Database["pragma"]>
        ) {
            handles.push(this);
            if (args[0].startsWith(failingPragma)) throw failure;
            return originalPragma.apply(this, args);
        });
        try {
            assert.throws(() => SqliteDatabase.test(false, ":memory:"), (error) => error === failure);
            const handle = handles.at(-1);
            assert.ok(handle);
            assert.equal(handle.open, false);
        } finally {
            for (const handle of handles) handle.close();
        }
    });
}
