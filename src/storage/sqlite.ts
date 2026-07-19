import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function databasePath(name: string) {
    return path.join(os.homedir(), ".pi", "agent", `${name}.sqlite`);
}

export class SqliteDatabase {
    private readonly db: Database.Database;

    readonly file: string;
    readonly isReadonly: boolean;

    static test(
        isReadonly: boolean,
        filepath: string,
    ) {
        return new SqliteDatabase(filepath, isReadonly);
    }

    static readwrite(name: string) {
        const preferredFile = databasePath(name);
        return new SqliteDatabase(preferredFile, false);
    }

    static readonly(name: string) {
        return new SqliteDatabase(databasePath(name), true);
    }

    private constructor(
        filepath: string,
        isReadonly: boolean,
    ) {
        this.file = filepath;
        this.isReadonly = isReadonly;
        if (!fs.existsSync(this.file)) {
            fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
        }
        this.db = new Database(this.file, {readonly: isReadonly});
        this.db.pragma("busy_timeout = 5000");
        if (!isReadonly) this.db.pragma("journal_mode = WAL");
    }

    exec(sql: string) {
        this.db.exec(sql);
        return this;
    }

    prepare(sql: string) {
        return this.db.prepare(sql);
    }

    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
        return this.db.transaction(fn);
    }

    close(): void {
        this.db.close();
    }
}

export {SqliteDatabase as DatabaseOrm};
