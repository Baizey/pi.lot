// noinspection SqlNoDataSourceInspection

import {SqliteDatabase} from "./sqlite";

type SqlValue = string | number | bigint | Buffer | null;
type RowValue = string | number | boolean | Date | object | Buffer | null;
enum SqliteType {
    TEXT = "text",
    INTEGER = "integer",
    REAL = "real",
    BLOB = "blob",
}

export enum SortDirection {
    ASC = "asc",
    DESC = "desc",
}

type ColumnConfig<T> = {
    sqliteType: SqliteType;
    encode: (value: T) => SqlValue;
    decode: (value: unknown) => T;
    isPrimaryKey?: boolean;
    isNotNull?: boolean;
    isUnique?: boolean;
    defaultSql?: string;
};

export type Column<T> = ColumnConfig<T> & {
    primaryKey(): Column<T>;
    notNull(): Column<NonNullable<T>>;
    nullable(): Column<T | null>;
    unique(): Column<T>;
    default(sql: string): Column<T>;
};

type AnyColumn = Column<any>;
type ColumnMap = Record<string, AnyColumn>;

export type Table<TColumns extends ColumnMap> = {
    name: string;
    columns: TColumns;
};

export type Row<TTable extends Table<ColumnMap>> = {
    [K in keyof TTable["columns"]]: TTable["columns"][K] extends Column<infer T> ? T : never;
};

export type Insert<TTable extends Table<ColumnMap>> = Partial<Row<TTable>>;
export type Where<TTable extends Table<ColumnMap>> = Partial<Row<TTable>>;
export type OrderBy<TTable extends Table<ColumnMap>> = {
    column: keyof Row<TTable> & string;
    direction?: SortDirection;
};
export type QueryOptions<TTable extends Table<ColumnMap>> = {
    limit?: number;
    orderBy?: OrderBy<TTable> | Array<OrderBy<TTable>>;
};

export type Migration = {
    id: string;
    sql: string;
};

function makeColumn<T>(config: ColumnConfig<T>): Column<T> {
    return {
        ...config,
        primaryKey: () => makeColumn({...config, isPrimaryKey: true, isNotNull: true}),
        notNull: () => makeColumn({...config, isNotNull: true}) as Column<NonNullable<T>>,
        nullable: () => makeColumn({...config, isNotNull: false}) as Column<T | null>,
        unique: () => makeColumn({...config, isUnique: true}),
        default: (sql: string) => makeColumn({...config, defaultSql: sql}),
    };
}

export const column = {
    text: () => makeColumn<string>({
        sqliteType: SqliteType.TEXT,
        encode: value => value,
        decode: value => String(value),
    }),
    integer: () => makeColumn<number>({
        sqliteType: SqliteType.INTEGER,
        encode: value => value,
        decode: value => Number(value),
    }),
    real: () => makeColumn<number>({
        sqliteType: SqliteType.REAL,
        encode: value => value,
        decode: value => Number(value),
    }),
    boolean: () => makeColumn<boolean>({
        sqliteType: SqliteType.INTEGER,
        encode: value => value ? 1 : 0,
        decode: value => Boolean(value),
    }),
    date: () => makeColumn<Date>({
        sqliteType: SqliteType.INTEGER,
        encode: value => value.getTime(),
        decode: value => new Date(Number(value)),
    }),
    json: <T extends object>() => makeColumn<T>({
        sqliteType: SqliteType.TEXT,
        encode: value => JSON.stringify(value),
        decode: value => JSON.parse(String(value)) as T,
    }),
    blob: () => makeColumn<Buffer>({
        sqliteType: SqliteType.BLOB,
        encode: value => value,
        decode: value => Buffer.isBuffer(value) ? value : Buffer.from(value as ArrayBuffer),
    }),
};

export function table<TColumns extends ColumnMap>(name: string, columns: TColumns): Table<TColumns> {
    return {name, columns};
}

export class Orm {
    constructor(private readonly db: SqliteDatabase) {}

    migrate(migrations: Migration[]) {
        this.db.exec(`create table if not exists "schema_migrations" ("id" text primary key, "appliedAt" integer not null)`);
        const hasMigration = this.db.prepare(`select 1 from "schema_migrations" where "id" = ?`);
        const markMigration = this.db.prepare(`insert into "schema_migrations" ("id", "appliedAt") values (?, ?)`);
        const run = this.db.transaction((items: Migration[]) => {
            for (const migration of items) {
                if (hasMigration.get(migration.id)) continue;
                this.db.exec(migration.sql);
                markMigration.run(migration.id, Date.now());
            }
        });
        run(migrations);
        return this;
    }

    createTable<TColumns extends ColumnMap>(target: Table<TColumns>) {
        this.db.exec(createTableSql(target));
        return this;
    }

    insert<TTable extends Table<ColumnMap>>(target: TTable, row: Insert<TTable>) {
        const entries = Object.entries(row) as [keyof Row<TTable> & string, Row<TTable>[keyof Row<TTable>]][];
        if (entries.length === 0) throw new Error(`Cannot insert empty row into ${target.name}`);

        const columns = entries.map(([name]) => name);
        const placeholders = columns.map(name => `@${name}`);
        const sql = `insert into ${quoteIdent(target.name)} (${columns.map(quoteIdent).join(", ")}) values (${placeholders.join(", ")})`;

        this.db.prepare(sql).run(encodeValues(target, row));
        return this;
    }

    upsert<TTable extends Table<ColumnMap>>(
        target: TTable,
        row: Insert<TTable>,
        conflictColumns: Array<keyof Row<TTable> & string>,
        updateColumns?: Array<keyof Row<TTable> & string>,
    ) {
        const entries = Object.entries(row) as [keyof Row<TTable> & string, Row<TTable>[keyof Row<TTable>]][];
        if (entries.length === 0) throw new Error(`Cannot upsert empty row into ${target.name}`);
        if (conflictColumns.length === 0) throw new Error(`Cannot upsert ${target.name} without conflict columns`);

        const columns = entries.map(([name]) => name);
        const updateTargets = updateColumns ?? columns.filter(name => !conflictColumns.includes(name));
        const insertSql = `insert into ${quoteIdent(target.name)} (${columns.map(quoteIdent).join(", ")}) values (${columns.map(name => `@${name}`).join(", ")})`;
        const conflictSql = ` on conflict(${conflictColumns.map(quoteIdent).join(", ")})`;
        const updateSql = updateTargets.length === 0
            ? " do nothing"
            : ` do update set ${updateTargets.map(name => `${quoteIdent(name)} = excluded.${quoteIdent(name)}`).join(", ")}`;

        this.db.prepare(`${insertSql}${conflictSql}${updateSql}`).run(encodeValues(target, row));
        return this;
    }

    get<TTable extends Table<ColumnMap>>(target: TTable, where: Where<TTable>): Row<TTable> | undefined {
        const rows = this.all(target, where, {limit: 1});
        return rows[0];
    }

    all<TTable extends Table<ColumnMap>>(target: TTable, where: Where<TTable> = {}, optionsOrLimit?: QueryOptions<TTable> | number): Row<TTable>[] {
        const options = typeof optionsOrLimit === "number" ? {limit: optionsOrLimit} : optionsOrLimit ?? {};
        const whereSql = buildWhere(where);
        const orderSql = buildOrderBy(options.orderBy);
        const limitSql = buildLimit(options.limit);
        const sql = `select * from ${quoteIdent(target.name)}${whereSql.sql}${orderSql}${limitSql}`;
        const rows = this.db.prepare(sql).all(encodeValues(target, where)) as Record<string, unknown>[];
        return rows.map(row => decodeRow(target, row));
    }

    update<TTable extends Table<ColumnMap>>(target: TTable, where: Where<TTable>, patch: Partial<Row<TTable>>) {
        const patchEntries = Object.keys(patch);
        if (patchEntries.length === 0) return this;

        const setSql = patchEntries.map(name => `${quoteIdent(name)} = @set_${name}`).join(", ");
        const whereSql = buildWhere(where, "where_");
        if (!whereSql.sql) throw new Error(`Refusing to update all rows from ${target.name}`);
        const sql = `update ${quoteIdent(target.name)} set ${setSql}${whereSql.sql}`;
        const values = {
            ...encodeValues(target, patch, "set_"),
            ...encodeValues(target, where, "where_"),
        };
        this.db.prepare(sql).run(values);
        return this;
    }

    delete<TTable extends Table<ColumnMap>>(target: TTable, where: Where<TTable>) {
        const whereSql = buildWhere(where);
        if (!whereSql.sql) throw new Error(`Refusing to delete all rows from ${target.name}`);
        this.db.prepare(`delete from ${quoteIdent(target.name)}${whereSql.sql}`).run(encodeValues(target, where));
        return this;
    }
}

function createTableSql(target: Table<ColumnMap>) {
    const columns = Object.entries(target.columns).map(([name, config]) => {
        const parts = [quoteIdent(name), config.sqliteType];
        if (config.isPrimaryKey) parts.push("primary key");
        if (config.isNotNull) parts.push("not null");
        if (config.isUnique) parts.push("unique");
        if (config.defaultSql) parts.push("default", config.defaultSql);
        return parts.join(" ");
    });
    return `create table if not exists ${quoteIdent(target.name)} (${columns.join(", ")})`;
}

function encodeValues<TTable extends Table<ColumnMap>>(
    target: TTable,
    values: Partial<Row<TTable>>,
    prefix = "",
): Record<string, SqlValue> {
    const encoded: Record<string, SqlValue> = {};
    for (const [name, value] of Object.entries(values)) {
        const col = target.columns[name];
        if (!col) throw new Error(`Unknown column ${target.name}.${name}`);
        encoded[`${prefix}${name}`] = value === null || value === undefined ? null : col.encode(value as never);
    }
    return encoded;
}

function decodeRow<TTable extends Table<ColumnMap>>(target: TTable, row: Record<string, unknown>): Row<TTable> {
    const decoded: Record<string, RowValue> = {};
    for (const [name, col] of Object.entries(target.columns)) {
        const value = row[name];
        decoded[name] = value === null || value === undefined ? null : col.decode(value as never);
    }
    return decoded as Row<TTable>;
}

function buildWhere(where: object, prefix = "") {
    const entries = Object.entries(where);
    if (entries.length === 0) return {sql: ""};
    return {
        sql: ` where ${entries.map(([name, value]) => value === null || value === undefined
            ? `${quoteIdent(name)} is null`
            : `${quoteIdent(name)} = @${prefix}${name}`).join(" and ")}`,
    };
}

function buildLimit(limit?: number) {
    if (limit === undefined) return "";
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid sqlite limit: ${limit}`);
    return ` limit ${limit}`;
}

function buildOrderBy<TTable extends Table<ColumnMap>>(orderBy?: OrderBy<TTable> | Array<OrderBy<TTable>>) {
    if (!orderBy) return "";
    const items = Array.isArray(orderBy) ? orderBy : [orderBy];
    if (items.length === 0) return "";
    return ` order by ${items.map(item => `${quoteIdent(item.column)} ${item.direction === "desc" ? "desc" : "asc"}`).join(", ")}`;
}

function quoteIdent(name: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid sqlite identifier: ${name}`);
    return `"${name}"`;
}
