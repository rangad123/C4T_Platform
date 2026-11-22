/**
 * D-b (spec 4.4): a benchmark app's tables kept in node:sqlite (BENCH_DB, examples/bench-*), read as a `DatabaseProbe`. Benchmark mode
 * only. The file is opened read-only (`file:…?mode=ro` and readOnly), and only under eval/.data-bench/<trial>/: the real path
 * (links resolved) must sit at least one folder below that root. Templates become parameterised SQL here: names come from the validated
 * schema (plain identifiers, quoted), every value is a bound parameter, and nothing the caller writes is ever SQL text.
 */
import { sameStoredValue } from "./same-value.js";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { checkResult, cleanSchema, DB_NAME, DB_RESULT_KEYS_MAX, newEvidenceKey, type DatabaseProbe, type DbSchema } from "./probe.js";
import { keyColumns, relationHolds, validateCheck, type ValidCheck } from "./templates.js";

/** AI_Studio/eval/.data-bench: the benchmark trials' data folders. */
export const BENCH_DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/.data-bench");
/** Rows a relation check reads at most (it is judged in memory, by the C5 grammar). shortcut: the bench tables are small; a real probe would page. */
const RELATION_ROWS_MAX = 50_000;
/** The table the bench app writes its keys into (examples/bench-*: name, then the JSON of columns, primaryKey, uniqueKeys, foreignKeys). */
const META = "bench_schema";

/**
 * The real path of a bench database file when it is allowed: it exists, and resolved (links followed) it lies in a trial folder under
 * the root, not in the root itself. Otherwise an Error naming the rule (never opened).
 */
export function benchDatabaseFile(file: string, root = BENCH_DATA_ROOT): string {
    let real: string;
    let realRoot: string;
    try {
        realRoot = fs.realpathSync(root);
        real = fs.realpathSync(path.resolve(file));
    } catch {
        throw new Error("the bench database file does not exist under eval/.data-bench/<trial>/");
    }
    const rel = path.relative(realRoot, real);
    const parts = rel.split(path.sep);
    if (!rel || path.isAbsolute(rel) || parts[0] === ".." || parts.length < 2 || !fs.statSync(real).isFile()) throw new Error("only a database file under eval/.data-bench/<trial>/ is opened");
    return real;
}

const q = (name: string) => {
    if (!DB_NAME.test(name)) throw new Error("not a plain name"); // the schema keeps plain names only; this is the last guard
    return `"${name}"`;
};

/** Opens an allowed bench database file (benchDatabaseFile) read-only: a write through the connection fails. */
export async function openBenchDatabase(file: string, root = BENCH_DATA_ROOT): Promise<DatabaseSync> {
    const real = benchDatabaseFile(file, root);
    // As platform/db.ts loads it: the test runner's bundler does not know node:sqlite as a built-in.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(`${pathToFileURL(real).href}?mode=ro`, { readOnly: true, timeout: 2000 });
    // Case folding the way the D-a back end folds (JavaScript's toLowerCase), not SQLite's ASCII-only lower().
    d.function("bench_fold", { deterministic: true }, (v) => (typeof v === "string" ? v.toLowerCase() : v));
    d.function("bench_same", { deterministic: true }, (a, b) => (sameStoredValue(a, b) ? 1 : 0));
    return d;
}

export function benchSqliteProbe(access: { file: string; root?: string; evidenceKey?: Buffer }): DatabaseProbe {
    benchDatabaseFile(access.file, access.root); // refused at once when the path is not allowed
    const evidenceKey = access.evidenceKey ?? newEvidenceKey();
    let db: Promise<DatabaseSync> | undefined;
    const open = (): Promise<DatabaseSync> => (db ??= openBenchDatabase(access.file, access.root));
    const schema = async (): Promise<DbSchema> => {
        const d = await open();
        // A table's columns as the file has them (none: no such table).
        const columnsOf = (name: string) => new Set((d.prepare("SELECT name FROM pragma_table_info(?)").all(name) as Array<{ name: string }>).map((c) => c.name));
        if (!columnsOf(META).size) return { tables: [] };
        const raw = (d.prepare(`SELECT name, spec FROM ${q(META)}`).all() as Array<{ name: unknown; spec: unknown }>)
            .filter((r) => typeof r.name === "string" && DB_NAME.test(r.name) && r.name !== META && columnsOf(r.name).size > 0)
            .map((r) => {
                let spec: Record<string, unknown> = {};
                try {
                    spec = JSON.parse(String(r.spec)) as Record<string, unknown>;
                } catch {
                    /* no keys known */
                }
                const name = r.name as string;
                const real = columnsOf(name);
                const columns = (Array.isArray(spec.columns) ? spec.columns : []).filter((c) => typeof c === "string" && real.has(c));
                const rowCount = Number((d.prepare(`SELECT COUNT(*) AS n FROM ${q(name)}`).get() as { n: number | bigint }).n);
                return { ...spec, name, columns, rowCount };
            });
        return cleanSchema({ tables: raw });
    };
    return {
        schema,
        async check(template, params) {
            const v = validateCheck(template, params, await schema());
            return run(await open(), v, evidenceKey);
        },
    };
}

type Row = Record<string, SQLInputValue>;

/** One validated check as parameterised SQL: names quoted from the schema, values bound. */
function run(d: DatabaseSync, v: ValidCheck, evidenceKey: Buffer) {
    const t = v.template;
    const T = q(v.table.name);
    const key = keyColumns(v);
    const where: string[] = [];
    const bound: SQLInputValue[] = [];
    for (const [c, want] of Object.entries(v.params)) {
        if (want === null) where.push(`x.${q(c)} IS NULL`);
        else {
            where.push(`bench_same(x.${q(c)}, ?) = 1`);
            bound.push(want);
        }
    }
    const cond = (extra: string[] = []) => (where.length + extra.length ? ` WHERE ${[...where, ...extra].join(" AND ")}` : "");
    const keysOf = (rows: Row[]) => rows.map((r) => key.map((c) => r[c]));
    const countAndKeys = (from: string, extra: string[] = []) => {
        const n = Number((d.prepare(`SELECT COUNT(*) AS n FROM ${from}${cond(extra)}`).get(...bound) as { n: number | bigint }).n);
        const rows = d.prepare(`SELECT ${key.map((c) => `x.${q(c)}`).join(", ")} FROM ${from}${cond(extra)} LIMIT ${DB_RESULT_KEYS_MAX}`).all(...bound) as Row[];
        return checkResult(t.kind, t.table, n, keysOf(rows), evidenceKey);
    };
    if (t.kind === "exists" || t.kind === "count") return countAndKeys(`${T} AS x`);
    if (t.kind === "orphans") {
        const join = t.columns.map((c, i) => `p.${q(t.references.columns[i]!)} = x.${q(c)}`).join(" AND ");
        return countAndKeys(`${T} AS x`, [...t.columns.map((c) => `x.${q(c)} IS NOT NULL`), `NOT EXISTS (SELECT 1 FROM ${q(t.references.table)} AS p WHERE ${join})`]);
    }
    if (t.kind === "duplicates") {
        const cols = t.columns.map((c) => (t.fold ? `bench_fold(x.${q(c)})` : `x.${q(c)}`));
        const groups = `(SELECT ${cols.map((c, i) => `${c} AS k${i}`).join(", ")} FROM ${T} AS x WHERE ${t.columns.map((c) => `x.${q(c)} IS NOT NULL`).join(" AND ")} GROUP BY ${cols.join(", ")} HAVING COUNT(*) > 1)`;
        const n = Number((d.prepare(`SELECT COUNT(*) AS n FROM ${groups}`).get() as { n: number | bigint }).n);
        const rows = d.prepare(`SELECT * FROM ${groups} LIMIT ${DB_RESULT_KEYS_MAX}`).all() as Row[];
        return checkResult(t.kind, t.table, n, rows.map((r) => t.columns.map((_, i) => r[`k${i}`])), evidenceKey);
    }
    // relation: the rows' named columns, judged by the C5 grammar in memory (the expression is never SQL).
    const cols = [...new Set([...key, ...v.columnsRead])];
    const rows = d.prepare(`SELECT ${cols.map((c) => `x.${q(c)}`).join(", ")} FROM ${T} AS x${cond()} LIMIT ${RELATION_ROWS_MAX}`).all(...bound) as Row[];
    const failed = rows.filter((r) => !relationHolds(t.expression, r as Record<string, unknown>));
    return checkResult(t.kind, t.table, failed.length, keysOf(failed), evidenceKey);
}
