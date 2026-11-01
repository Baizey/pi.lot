import type {TestContext} from "node:test";
import {SqliteDatabase} from "../../src/storage/sqlite.js";

/** File-backed fixtures exercise close/reopen persistence, not WAL concurrency. */
export function openIsolatedTestDatabase(file: string): SqliteDatabase {
    const database = SqliteDatabase.test(false, file);
    try {
        // Rollback journaling avoids WAL's writable shared-memory mmap on mediated FUSE.
        // Switch before schema/data access on every open; production journaling stays unchanged.
        return database.exec("pragma journal_mode = DELETE");
    } catch (error) {
        database.close();
        throw error;
    }
}

/** Keep production open paths intact while choosing a supported test-only journal mode. */
export function mockIsolatedDatabaseOpens(t: TestContext): void {
    const open = SqliteDatabase.open.bind(SqliteDatabase);
    t.mock.method(SqliteDatabase, "open", (file: string, readonly = false) => {
        const database = open(file, readonly);
        return readonly ? database : database.exec("pragma journal_mode = DELETE");
    });
}
