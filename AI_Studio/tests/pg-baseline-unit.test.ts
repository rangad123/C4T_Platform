/**
 * The PostgreSQL baseline (src/platform/pg/baseline.sql) must describe the same schema as a fresh SQLite database (POSTGRES_S3_MIGRATION.md
 * §5.3): every table, column, type, not-null, primary key, unique constraint and index on both sides. No PostgreSQL server is used; the
 * baseline is read with a small parser that understands the subset the file is written in. A new SQLite migration (or column patch)
 * without the matching baseline change fails here.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/platform/db.js";
import { ensureSecurityTables } from "../src/security/store.js";

const BASELINE = path.resolve(__dirname, "../src/platform/pg/baseline.sql");

/** Tables ordered with `db.dialect.insertionOrder()`: on PostgreSQL they carry `seq`, which SQLite has as its rowid. */
const SEQ_TABLES = [
    "agent_tasks", "agent_tokens", "applications", "artifacts", "generation_jobs", "healing_proposals", "manual_cases", "quarantine_entries",
    "releases", "run_summaries", "runbook_runs", "runbooks", "security_assessments", "security_authorizations", "test_executions", "trigger_tokens",
];
/** SQLite type as declared → baseline type. Slots from 34 on may declare the portable BIGINT and SMALLINT directly (§5.3). */
const TYPE_MAP: Record<string, string> = { INTEGER: "BIGINT", BIGINT: "BIGINT", SMALLINT: "SMALLINT", TEXT: "TEXT", REAL: "DOUBLE PRECISION" };

interface Table {
    columns: Map<string, { type: string; notNull: boolean; identity: boolean }>;
    primaryKey: string[];
    /** Unique column sets ("a,b"), partial ones with their WHERE. */
    uniques: Set<string>;
    /** Every CREATE INDEX: "name: [UNIQUE ]cols[ WHERE …]". */
    indexes: Set<string>;
    references: Set<string>;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Splits on commas outside parentheses. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    let quoted = false;
    for (const ch of s) {
        if (ch === "'") quoted = !quoted;
        if (!quoted && ch === "(") depth++;
        if (!quoted && ch === ")") depth--;
        if (!quoted && ch === "," && depth === 0) (out.push(cur), (cur = ""));
        else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(norm);
}

function parseBaseline(sql: string): Map<string, Table> {
    const tables = new Map<string, Table>();
    const text = sql.replace(/--[^\n]*/g, "");
    for (const stmt of text.split(";").map(norm).filter(Boolean)) {
        let m = /^CREATE TABLE (\w+) \((.*)\)$/i.exec(stmt);
        if (m) {
            const t: Table = { columns: new Map(), primaryKey: [], uniques: new Set(), indexes: new Set(), references: new Set() };
            tables.set(m[1]!, t);
            for (const part of splitTop(m[2]!)) {
                let c = /^PRIMARY KEY \(([^)]*)\)$/i.exec(part);
                if (c) {
                    t.primaryKey = c[1]!.split(",").map(norm);
                    continue;
                }
                c = /^UNIQUE \(([^)]*)\)$/i.exec(part);
                if (c) {
                    t.uniques.add(c[1]!.split(",").map(norm).join(","));
                    continue;
                }
                if (/^(CONSTRAINT|FOREIGN KEY|CHECK)\b/i.test(part)) throw new Error(`Unsupported table constraint in the baseline: ${part}`);
                const col = /^(\w+) (BIGINT|TEXT|DOUBLE PRECISION|SMALLINT|BOOLEAN)\b(.*)$/i.exec(part);
                if (!col) throw new Error(`Unreadable column in ${m[1]}: ${part}`);
                const rest = col[3]!;
                const pk = /\bPRIMARY KEY\b/i.test(rest);
                t.columns.set(col[1]!, { type: col[2]!.toUpperCase(), notNull: pk || /\bNOT NULL\b/i.test(rest), identity: /\bGENERATED (BY DEFAULT|ALWAYS) AS IDENTITY\b/i.test(rest) });
                if (pk) t.primaryKey = [col[1]!];
                if (/\bUNIQUE\b/i.test(rest)) t.uniques.add(col[1]!);
                const ref = /\bREFERENCES (\w+)\((\w+)\)(.*)$/i.exec(rest);
                if (ref) t.references.add(`${col[1]}->${ref[1]}.${ref[2]}${/ON DELETE (CASCADE|SET NULL)/i.exec(ref[3]!)?.[0].toUpperCase().replace(/^/, " ") ?? ""}`);
            }
            continue;
        }
        m = /^CREATE (UNIQUE )?INDEX (\w+) ON (\w+) \(([^)]*)\)(?: WHERE (.*))?$/i.exec(stmt);
        if (m) {
            const t = tables.get(m[3]!);
            if (!t) throw new Error(`Index ${m[2]} before its table ${m[3]}`);
            const cols = m[4]!.split(",").map(norm).join(",");
            t.indexes.add(`${m[2]}: ${m[1] ? "UNIQUE " : ""}${cols}${m[5] ? ` WHERE ${norm(m[5])}` : ""}`);
            if (m[1]) t.uniques.add(m[5] ? `${cols} WHERE ${norm(m[5])}` : cols);
            continue;
        }
        throw new Error(`Unsupported statement in the baseline: ${stmt.slice(0, 100)}`);
    }
    return tables;
}

function readSqlite(): Map<string, Table> {
    const db = new Db(":memory:");
    // The scanner tables and the approval column are created on first use, not by a numbered slot (§1.3).
    ensureSecurityTables(db);
    const d = db.dialect;
    const out = new Map<string, Table>();
    for (const name of d.listTables(db)) {
        const cols = d.listColumns(db, name);
        const t: Table = { columns: new Map(), primaryKey: [], uniques: new Set(), indexes: new Set(), references: new Set() };
        t.primaryKey = cols.filter((c) => c.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey).map((c) => c.name);
        for (const c of cols) {
            const type = TYPE_MAP[c.type];
            if (!type) throw new Error(`${name}.${c.name}: SQLite type ${c.type} has no baseline mapping`);
            t.columns.set(c.name, { type, notNull: c.notNull || c.primaryKey > 0, identity: false });
        }
        for (const ix of d.listIndexes(db, name)) {
            const cols = ix.columns.join(",");
            if (ix.origin === "u") t.uniques.add(cols);
            if (ix.origin !== "c") continue;
            const where = ix.partial ? norm(String(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?", ix.name)!.sql).replace(/^.*\bWHERE\b/is, "")) : "";
            t.indexes.add(`${ix.name}: ${ix.unique ? "UNIQUE " : ""}${cols}${where ? ` WHERE ${where}` : ""}`);
            if (ix.unique) t.uniques.add(where ? `${cols} WHERE ${where}` : cols);
        }
        for (const f of d.listForeignKeys(db, name)) {
            const to = f.to ?? d.listColumns(db, f.table).find((c) => c.primaryKey)!.name;
            t.references.add(`${f.from}->${f.table}.${to}${f.onDelete === "CASCADE" || f.onDelete === "SET NULL" ? ` ON DELETE ${f.onDelete}` : ""}`);
        }
        out.set(name, t);
    }
    db.close();
    return out;
}

describe("PostgreSQL baseline", () => {
    const pg = parseBaseline(fs.readFileSync(BASELINE, "utf8"));
    const lite = readSqlite();

    it("has the same tables as a fresh SQLite database", () => {
        expect([...pg.keys()].sort()).toEqual([...lite.keys()].sort());
    });

    it("has the same columns, types and not-null on every table, plus seq where rows are ordered by insertion", () => {
        const diffs: string[] = [];
        for (const [name, l] of lite) {
            const p = pg.get(name);
            if (!p) continue;
            for (const [col, c] of l.columns) {
                const q = p.columns.get(col);
                if (!q) diffs.push(`${name}.${col}: missing in the baseline`);
                else if (q.type !== c.type || q.notNull !== c.notNull) diffs.push(`${name}.${col}: SQLite ${c.type}${c.notNull ? " NOT NULL" : ""}, baseline ${q.type}${q.notNull ? " NOT NULL" : ""}`);
            }
            for (const col of p.columns.keys()) if (!l.columns.has(col) && !(col === "seq" && SEQ_TABLES.includes(name))) diffs.push(`${name}.${col}: only in the baseline`);
            if (SEQ_TABLES.includes(name) && !p.columns.get("seq")?.identity) diffs.push(`${name}: needs seq BIGINT GENERATED ALWAYS AS IDENTITY`);
        }
        expect(diffs).toEqual([]);
    });

    it("has the same primary keys, unique constraints, indexes and references", () => {
        const diffs: string[] = [];
        for (const [name, l] of lite) {
            const p = pg.get(name);
            if (!p) continue;
            if (p.primaryKey.join(",") !== l.primaryKey.join(",")) diffs.push(`${name}: primary key SQLite (${l.primaryKey}) baseline (${p.primaryKey})`);
            for (const [what, a, b] of [["unique", l.uniques, p.uniques], ["index", l.indexes, p.indexes], ["reference", l.references, p.references]] as const) {
                for (const x of a) if (!b.has(x)) diffs.push(`${name}: ${what} ${x} missing in the baseline`);
                for (const x of b) if (!a.has(x)) diffs.push(`${name}: ${what} ${x} only in the baseline`);
            }
        }
        expect(diffs).toEqual([]);
    });

    it("makes every AUTOINCREMENT id an identity column, and uses no SQLite-only DDL", () => {
        const sql = fs.readFileSync(BASELINE, "utf8").replace(/--[^\n]*/g, "");
        expect(sql).not.toMatch(/\b(AUTOINCREMENT|INTEGER|REAL|WITHOUT ROWID|COLLATE NOCASE|IF NOT EXISTS)\b/i);
        const db = new Db(":memory:");
        ensureSecurityTables(db);
        const autoTables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'").map((r) => r.name);
        db.close();
        expect(autoTables.length).toBeGreaterThan(0);
        for (const t of autoTables) expect(pg.get(t)?.columns.get("id")?.identity, t).toBe(true);
    });

    it("creates each referenced table before the tables that reference it", () => {
        const text = fs.readFileSync(BASELINE, "utf8");
        const pos = new Map([...text.matchAll(/CREATE TABLE (\w+)/g)].map((m) => [m[1]!, m.index!]));
        for (const [name, t] of pg) for (const r of t.references) {
            const target = /->(\w+)\./.exec(r)![1]!;
            if (target !== name) expect(pos.get(target)! < pos.get(name)!, `${name} references ${target}`).toBe(true);
        }
    });
});
