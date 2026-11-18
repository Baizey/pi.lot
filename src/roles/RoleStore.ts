import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PolicyDao} from "../storage/PolicyDao.js";
import {SqliteDatabase} from "../storage/sqlite.js";
import {parseRoleCatalog, type RoleCatalog} from "./RoleCatalog.js";

const MAX_CATALOG_BYTES = 256 * 1024;

export class RoleStore {
    constructor(private readonly db: SqliteDatabase) {}

    catalog(): RoleCatalog {
        const rows = this.db.prepare("SELECT id,title,text,description FROM role_profiles ORDER BY id").all() as
            {id: string; title: string; text: string; description: string | null}[];
        return parseRoleCatalog({roles: rows.map(({description, ...role}) => description === null ? role : {...role, description})});
    }

    /** Caller owns the sync transaction, including the acknowledgement. */
    replace(catalog: RoleCatalog): void {
        const validated = parseRoleCatalog(catalog);
        if (Buffer.byteLength(JSON.stringify(validated)) > MAX_CATALOG_BYTES) throw new Error("The saved role library is too large.");
        if (!this.db.inTransaction) throw new Error("Replacing saved roles requires a transaction.");
        this.db.exec("DELETE FROM role_profiles");
        const insert = this.db.prepare("INSERT INTO role_profiles(id,title,text,description) VALUES (?,?,?,?)");
        for (const {id, title, text, description} of validated.roles) insert.run(id, title, text, description ?? null);
    }
}

/** Open lazily; neither displaying a tool nor starting a session requires the role library. */
export class RoleLibrary {
    constructor(private readonly file = path.join(os.homedir(), ".pilot", "pilot.sqlite")) {}

    catalog(): RoleCatalog {
        return this.withStore((_db, store) => store.catalog());
    }

    save(expected: RoleCatalog, replacement: RoleCatalog): void {
        this.withStore((db, store) => db.transaction(() => {
            if (JSON.stringify(store.catalog()) !== JSON.stringify(expected)) {
                throw new Error("Saved roles changed. Review the update and try again.");
            }
            store.replace(replacement);
        }).immediate());
    }

    private withStore<T>(operation: (db: SqliteDatabase, store: RoleStore) => T): T {
        fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
        try {
            fs.closeSync(fs.openSync(this.file, "wx", 0o600));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        if (!fs.lstatSync(this.file).isFile()) throw new Error("Invalid saved role database.");
        const db = SqliteDatabase.open(this.file);
        try {
            new PolicyDao(db).initializeSchema();
            return operation(db, new RoleStore(db));
        } finally {
            db.close();
        }
    }
}
