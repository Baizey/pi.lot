import type {TestContext} from "node:test";
import {PolicyDao} from "../../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../../src/storage/sqlite.js";

/** Policy fixtures use SQLite memory storage, never file-backed WAL or shared-memory mappings. */
export function createMemoryPolicyDao(t: TestContext, configure?: (dao: PolicyDao) => void): PolicyDao {
    const database = SqliteDatabase.test(false, ":memory:");
    t.after(() => database.close());
    const dao = new PolicyDao(database);
    dao.initializeSchema();
    configure?.(dao);
    return dao;
}
