import {SqliteDatabase} from "../sqlite.js";
import {PolicyAccessTypeConstraint} from "./PolicyAccessTypeConstraint.js";
import {POLICY_ACCESS_TYPES_V1} from "./PolicySchemaV1.js";

export class PolicyMmapV3 {
    constructor(private readonly db: SqliteDatabase) {}

    up(): void {
        const {sql} = this.db.prepare("select sql from sqlite_master where type='table' and name='policy_rules'")
            .get() as {sql: string};
        new PolicyAccessTypeConstraint(this.db).upgrade(sql, [...POLICY_ACCESS_TYPES_V1, "FS_MMAP"], false,
            ` check ("accessType" <> 'FS_MMAP' or ("lifetime" <> 'GLOBAL' and substr("pattern", 1, 1) = '/'))`);
    }
}
