/**
 * The database layer's one interface (Phase 4 C10, spec 4.4). Every back end (D-a bench data route, D-b bench SQLite, D-c the customer's
 * probe) answers the same two calls:
 *   - schema(): table and column names, keys and row counts (names and counts only, never a value);
 *   - check(template, params): one of the fixed templates in ./templates.ts, validated against schema() first.
 * There is no call that takes SQL text or a connection string. A result is counts, keyed fingerprints (HMAC under the run's evidence key,
 * the identity/access.ts pattern) and at most 20 masked keys: never row contents.
 */
import { maskValue, newEvidenceKey, valueHash } from "../identity/access.js";
import type { DbParams, DbTemplate } from "./templates.js";

export interface DbTable {
    name: string;
    columns: string[];
    primaryKey: string[];
    uniqueKeys: Array<{ columns: string[]; ignoreCase?: boolean }>;
    foreignKeys: Array<{ columns: string[]; references: { table: string; columns: string[] } }>;
    rowCount: number;
}
export interface DbSchema {
    tables: DbTable[];
}

/** What a check found. `count` is rows (for `duplicates`, key values held by more than one row); ids and examples name at most 20 of them. */
export interface DbCheckResult {
    kind: DbTemplate["kind"];
    table: string;
    count: number;
    /** Fingerprints of the matching rows' keys under the run's evidence key: compare within the run only, never look up. */
    ids: string[];
    /** The same keys masked ("•••••• (8 characters)"): what kind of key matched without any of it. */
    examples: string[];
}

export interface DatabaseProbe {
    /** false: the back end does not judge relations over rows (a customer's probe), so none is proposed for it. */
    rowRelations?: false;
    schema(): Promise<DbSchema>;
    check(template: DbTemplate, params?: DbParams): Promise<DbCheckResult>;
}

export const DB_RESULT_KEYS_MAX = 20;
/** First words of every refused check: the template named something outside the schema or the grammar. */
export const DB_REFUSED_PREFIX = "Database check refused";

export class DatabaseCheckRefused extends Error {
    constructor(reason: string) {
        super(`${DB_REFUSED_PREFIX}: ${reason}`);
        this.name = "DatabaseCheckRefused";
    }
}

/** A table or column name a back end may use: a plain identifier. Anything else is left out of the schema, so no template can name it. */
export const DB_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * The schema a back end reported, kept to what the templates can use: tables and columns with plain identifier names, keys whose
 * columns all exist, foreign keys whose table and columns exist. The source is the bench or the customer's probe, so it is checked too.
 */
export function cleanSchema(raw: unknown): DbSchema {
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 500) : []);
    const names = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === "string" && DB_NAME.test(x)).slice(0, 200);
    const allIn = (cols: string[], have: Set<string>, given: unknown) => cols.length > 0 && cols.length === list(given).length && cols.every((c) => have.has(c));
    const tables = list((raw as { tables?: unknown } | null)?.tables)
        .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>) : {}))
        .filter((t) => typeof t.name === "string" && DB_NAME.test(t.name));
    const seen = new Set<string>();
    const pre = tables
        .filter((t) => !seen.has(t.name as string) && seen.add(t.name as string))
        .map((t) => ({ t, name: t.name as string, columns: [...new Set(names(t.columns))] }));
    const cols = new Map(pre.map((x) => [x.name, new Set(x.columns)]));
    return {
        tables: pre.map(({ t, name, columns }) => {
            const have = cols.get(name)!;
            const pk = names(t.primaryKey);
            return {
                name,
                columns,
                primaryKey: allIn(pk, have, t.primaryKey) ? pk : [],
                uniqueKeys: list(t.uniqueKeys)
                    .map((u) => u as { columns?: unknown; ignoreCase?: unknown })
                    .filter((u) => u && allIn(names(u.columns), have, u.columns))
                    .map((u) => ({ columns: names(u.columns), ...(u.ignoreCase === true ? { ignoreCase: true } : {}) })),
                foreignKeys: list(t.foreignKeys)
                    .map((f) => f as { columns?: unknown; references?: { table?: unknown; columns?: unknown } })
                    .filter((f) => {
                        const parent = typeof f?.references?.table === "string" ? cols.get(f.references.table) : undefined;
                        const c = names(f?.columns);
                        return !!parent && allIn(c, have, f.columns) && allIn(names(f.references!.columns), parent, f.references!.columns) && c.length === names(f.references!.columns).length;
                    })
                    .map((f) => ({ columns: names(f.columns), references: { table: f.references!.table as string, columns: names(f.references!.columns) } })),
                rowCount: Number.isSafeInteger(t.rowCount) && (t.rowCount as number) >= 0 ? (t.rowCount as number) : 0,
            };
        }),
    };
}

/**
 * The result of a check from the keys of what matched: the count, then at most 20 keys as fingerprints and masked previews. A key is
 * the list of its column values; only its fingerprint and its length leave this function.
 */
export function checkResult(kind: DbTemplate["kind"], table: string, count: number, keys: unknown[][], evidenceKey: Buffer): DbCheckResult {
    const shown = keys.slice(0, DB_RESULT_KEYS_MAX).map((k) => k.map((v) => (v === null || v === undefined ? "" : String(v))));
    return {
        kind,
        table,
        count,
        ids: shown.map((k) => valueHash(JSON.stringify(k), evidenceKey)),
        examples: shown.map((k) => maskValue(k.join(" | ") || "-")),
    };
}

export { newEvidenceKey };
