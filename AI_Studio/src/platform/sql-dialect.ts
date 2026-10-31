/**
 * The SQL that differs between SQLite and PostgreSQL, in one place (POSTGRES_S3_MIGRATION.md §1.2 and §3.2).
 *
 * Every statement elsewhere in `src` is written in the portable subset; where the two dialects cannot share a spelling, the
 * statement asks `db.dialect` for the fragment. Only `sqliteDialect` exists today, and each of its fragments is exactly the SQL
 * the code used before, so nothing changes on SQLite. The PostgreSQL implementation is dropped in at M4 behind the same interface.
 * `tests/sql-portability-unit.test.ts` fails when a SQLite-only idiom appears anywhere else.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** What the schema helpers can read through: the platform's `Db`, or the raw connection used while `Db` is still migrating. */
export type SchemaSource = DatabaseSync | { all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] };

export interface ColumnInfo {
    name: string;
    /** The declared type, upper case (`TEXT`, `INTEGER`, `REAL`). */
    type: string;
    notNull: boolean;
    /** Position in the primary key, from 1; 0 when the column is not part of it. */
    primaryKey: number;
    /** The default as written in the DDL, or null. */
    defaultSql: string | null;
}

export interface IndexInfo {
    name: string;
    unique: boolean;
    /** True for an index with a `WHERE`: it does not make the columns unique on its own. */
    partial: boolean;
    /** `pk`, `u` (a UNIQUE constraint in the table) or `c` (CREATE INDEX). */
    origin: "pk" | "u" | "c";
    columns: string[];
}

export interface ForeignKeyInfo {
    from: string;
    table: string;
    /** Null when the reference names only the table (its primary key). */
    to: string | null;
    onDelete: string;
    onUpdate: string;
}

export interface Dialect {
    readonly name: "sqlite" | "postgres";
    /** The text value of a top-level key of a JSON `TEXT` column (an array or object comes back as its JSON text). */
    jsonText(col: string, key: string): string;
    /** The column that orders rows of a table with a `TEXT` primary key in the order they were inserted (`seq` on PostgreSQL). */
    insertionOrder(alias?: string): string;
    /** A case-insensitive `LIKE` against one `?` pattern, for searches people type. */
    likeInsensitive(col: string): string;
    /** Seconds from timestamp `a` to timestamp `b` (both ISO-8601 `TEXT`). */
    secondsBetween(a: string, b: string): string;
    /** Size of a `TEXT` value in bytes (UTF-8), not characters. */
    byteLength(x: string): string;
    /** Appended after `LIMIT` in a claim's subquery, so concurrent claimers skip a row another one holds. Empty on SQLite: its single writer already serialises claims. */
    skipLocked(): string;
    /** True when `e` is a unique or primary key violation (SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY, or PostgreSQL 23505). */
    isUniqueViolation(e: unknown): boolean;
    tableExists(db: SchemaSource, table: string): boolean;
    columnExists(db: SchemaSource, table: string, column: string): boolean;
    /** Schema introspection, for the PostgreSQL baseline comparison (`tests/pg-baseline-unit.test.ts`) and the copy tool. */
    listTables(db: SchemaSource): string[];
    listColumns(db: SchemaSource, table: string): ColumnInfo[];
    listIndexes(db: SchemaSource, table: string): IndexInfo[];
    listForeignKeys(db: SchemaSource, table: string): ForeignKeyInfo[];
}

/** Names that end up inside SQL text: only plain identifiers, so a fragment can never carry anything else. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function ident(s: string): string {
    if (!IDENT.test(s)) throw new Error(`Not a plain SQL identifier: ${JSON.stringify(s)}`);
    return s;
}

function rows<T>(db: SchemaSource, sql: string, ...params: SQLInputValue[]): T[] {
    return ("prepare" in db ? db.prepare(sql).all(...params) : db.all(sql, ...params)) as T[];
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export const sqliteDialect: Dialect = {
    name: "sqlite",
    jsonText: (col, key) => `json_extract(${ident(col)}, '$.${ident(key)}')`,
    insertionOrder: (alias) => (alias ? `${ident(alias)}.rowid` : "rowid"),
    // Without ICU, SQLite's LOWER folds ASCII only, which is exactly what its LIKE ignores, so the result is unchanged here.
    likeInsensitive: (col) => `LOWER(${ident(col)}) LIKE LOWER(?)`,
    secondsBetween: (a, b) => `(julianday(${ident(b)}) - julianday(${ident(a)})) * 86400.0`,
    byteLength: (x) => `LENGTH(CAST(${ident(x)} AS BLOB))`,
    skipLocked: () => "",
    isUniqueViolation: (e) => {
        const code = (e as { errcode?: unknown } | null)?.errcode;
        return code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY;
    },
    tableExists: (db, table) => rows(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", table).length > 0,
    columnExists: (db, table, column) => rows(db, "SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?", table, column).length > 0,
    listTables: (db) => rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name),
    listColumns: (db, table) =>
        rows<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>(db, "SELECT name, type, \"notnull\", pk, dflt_value FROM pragma_table_info(?) ORDER BY cid", table).map((c) => ({
            name: c.name,
            type: c.type.toUpperCase(),
            notNull: Boolean(c.notnull),
            primaryKey: Number(c.pk),
            defaultSql: c.dflt_value,
        })),
    listIndexes: (db, table) =>
        rows<{ name: string; unique: number; origin: "pk" | "u" | "c"; partial: number }>(db, "SELECT name, \"unique\", origin, partial FROM pragma_index_list(?)", table).map((ix) => ({
            name: ix.name,
            unique: Boolean(ix.unique),
            partial: Boolean(ix.partial),
            origin: ix.origin,
            columns: rows<{ name: string | null }>(db, "SELECT name FROM pragma_index_info(?) ORDER BY seqno", ix.name).map((c) => c.name ?? "<expression>"),
        })),
    listForeignKeys: (db, table) =>
        rows<{ from: string; table: string; to: string | null; on_delete: string; on_update: string }>(db, "SELECT \"from\", \"table\", \"to\", on_delete, on_update FROM pragma_foreign_key_list(?) ORDER BY id, seq", table).map((f) => ({
            from: f.from,
            table: f.table,
            to: f.to,
            onDelete: f.on_delete,
            onUpdate: f.on_update,
        })),
};

/**
 * Runs `fn` again when it fails on a unique index, up to `attempts` times. For "read the highest number, insert the next one": a
 * concurrent writer that took the same number makes the insert fail on the unique index instead of writing a duplicate, and the
 * retry reads the new highest number. `fn` must be safe to repeat (one statement, or a whole `tx`, never part of one). On SQLite
 * the single writer means the retry never happens.
 */
export function retryOnUniqueViolation<T>(dialect: Dialect, fn: () => T, attempts = 3): T {
    for (let i = 1; ; i++) {
        try {
            return fn();
        } catch (e) {
            if (i >= attempts || !dialect.isUniqueViolation(e)) throw e;
        }
    }
}
