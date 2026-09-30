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
