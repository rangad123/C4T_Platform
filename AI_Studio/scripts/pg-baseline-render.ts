/**
 * Renders src/platform/pg/baseline.sql from a fresh SQLite database (all migration slots plus the out-of-band column patches and
 * scanner tables). scripts/pg-baseline.ts writes the result; tests/pg-baseline-unit.test.ts renders it again and compares it with the
 * committed file byte for byte, so the file is always exactly what this produces.
 *
 * Order: SQLite's own order (sqlite_master rowid, PRAGMA column and index order) is not stable across migrations. A slot that rebuilds a
 * table moves it to the end, tables made outside the slots (ensureSecurityTables) come after every slot, and an out-of-band column patch
 * lands after columns added by later slots. So the order of tables, columns, constraints and indexes is taken from the previous
 * baseline: what it already has keeps its place, and anything new follows the item the SQLite order puts before it (in practice a
 * new slot's tables and columns are appended). A referenced table still always comes before the tables that reference it.
 */
import { Db, knownSchemaVersion } from "../src/platform/db.js";
import { ensureSecurityTables } from "../src/security/store.js";

/** Tables ordered with `db.dialect.insertionOrder()`: on PostgreSQL they carry `seq`, which SQLite has as its rowid. */
export const SEQ_TABLES: readonly string[] = [
    "agent_tasks", "agent_tokens", "alert_channels", "applications", "artifacts", "generation_jobs", "healing_proposals", "manual_cases", "quarantine_entries",
    "releases", "run_summaries", "runbook_runs", "runbooks", "security_assessments", "security_authorizations", "security_profile_approvals", "test_executions", "trigger_tokens",
];

/** Items whose key `prev` lists keep that order; a new item follows the item before it in `items`. */
function keepOrder<T>(items: readonly T[], key: (x: T) => string, prev: readonly string[]): T[] {
    const at = new Map(prev.map((k, i) => [k, i]));
    let last = -1;
    return items
        .map((x, i) => {
            const p = at.get(key(x));
            if (p !== undefined) last = p;
            return { x, i, k: p ?? last + 0.5 };
        })
        .sort((a, b) => a.k - b.k || a.i - b.i)
        .map((e) => e.x);
}

/** A table body line's identity: the column name, or the whole constraint line. */
const lineKey = (l: string) => (/^\s*(PRIMARY KEY|UNIQUE) \(/.test(l) ? l.trim() : l.trim().split(" ")[0]!);

export function renderBaseline(previous: string): string {
    const prevTables = [...previous.matchAll(/^CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);$/gm)];
    const prevBody = new Map(prevTables.map((m) => [m[1]!, m[2]!.split(",\n").map(lineKey)]));
    const prevIndexes = [...previous.matchAll(/^CREATE (?:UNIQUE )?INDEX (\w+) ON /gm)].map((m) => m[1]!);

    const db = new Db(":memory:");
    ensureSecurityTables(db);
    const d = db.dialect;
    const tables = d.listTables(db);
    const deps = new Map(tables.map((t) => [t, new Set(d.listForeignKeys(db, t).map((f) => f.table).filter((x) => x !== t))]));
    const creation = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").map((r) => r.name as string);
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (t: string) => {
        if (seen.has(t)) return;
        seen.add(t);
        for (const x of [...deps.get(t)!].sort()) visit(x);
        order.push(t);
    };
    for (const t of keepOrder(creation, (t) => t, prevTables.map((m) => m[1]!))) visit(t);

    const type = (t: string) => ({ INTEGER: "BIGINT", BIGINT: "BIGINT", SMALLINT: "SMALLINT", TEXT: "TEXT", REAL: "DOUBLE PRECISION" } as Record<string, string>)[t] ?? (() => { throw new Error("type " + t); })();
    const sqlOf = (name: string) => (db.get("SELECT sql FROM sqlite_master WHERE name = ?", name)?.sql as string) ?? "";
    const out: string[] = [];
    out.push(`-- AI Studio: PostgreSQL baseline schema (POSTGRES_S3_MIGRATION.md §5.3).
--
-- Equal to SQLite migration slots 1-${knownSchemaVersion()} plus the schema changes made outside them (§1.3: addActorColumns,
-- addCacheColumns, ensureScannerTables). A PostgreSQL database starts here and records schema_version ${knownSchemaVersion()};
-- later slots are written in the portable subset. tests/pg-baseline-unit.test.ts compares this file with a fresh SQLite database,
-- so a new SQLite migration without a change here fails the fast tier.
--
-- Mapping (§1.2, phase 1): every INTEGER is BIGINT (epoch milliseconds overflow INTEGER); 0/1 flags stay numbers; REAL is
-- DOUBLE PRECISION (SQLite's REAL is 8 bytes, PostgreSQL's is 4); dates and JSON stay TEXT. AUTOINCREMENT ids are identity
-- columns BY DEFAULT, so the copy tool can keep the ids. The tables ordered by insertion (\`db.dialect.insertionOrder\`) get a
-- \`seq\` identity column, which the copy fills from SQLite's rowid. Create the database with LC_COLLATE 'C' so text sorts as on SQLite.
`);
    for (const t of order) {
        const cols = d.listColumns(db, t);
        const pk = cols.filter((c) => c.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey).map((c) => c.name);
        const auto = /AUTOINCREMENT/i.test(sqlOf(t));
        const fks = d.listForeignKeys(db, t);
        const lines: string[] = [];
        for (const c of cols) {
            let l = `    ${c.name} `;
            if (auto && pk.length === 1 && pk[0] === c.name) l += "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY";
            else {
                l += type(c.type);
                if (c.notNull) l += " NOT NULL";
                if (c.defaultSql !== null) l += ` DEFAULT ${c.defaultSql}`;
                if (pk.length === 1 && pk[0] === c.name) l += " PRIMARY KEY";
            }
            const fk = fks.find((f) => f.from === c.name);
            if (fk) l += ` REFERENCES ${fk.table}(${fk.to ?? d.listColumns(db, fk.table).find((x) => x.primaryKey)!.name})${fk.onDelete !== "NO ACTION" ? ` ON DELETE ${fk.onDelete}` : ""}${fk.onUpdate !== "NO ACTION" ? ` ON UPDATE ${fk.onUpdate}` : ""}`;
            lines.push(l);
        }
        if (SEQ_TABLES.includes(t)) lines.push("    seq BIGINT GENERATED ALWAYS AS IDENTITY");
        if (pk.length > 1) lines.push(`    PRIMARY KEY (${pk.join(", ")})`);
        for (const ix of d.listIndexes(db, t).filter((i) => i.origin === "u")) lines.push(`    UNIQUE (${ix.columns.join(", ")})`);
        out.push(`CREATE TABLE ${t} (\n${keepOrder(lines, lineKey, prevBody.get(t) ?? []).join(",\n")}\n);`);
        const indexes = d.listIndexes(db, t).filter((i) => i.origin === "c").sort((a, b) => a.name.localeCompare(b.name));
        for (const ix of keepOrder(indexes, (i) => i.name, prevIndexes)) {
            const src = sqlOf(ix.name).replace(/\s+/g, " ").trim();
            const m = /^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+) ON (\w+)\s*\(([^)]*)\)(.*)$/i.exec(src);
            if (!m) throw new Error("index " + src);
            out.push(`CREATE ${m[1] ?? ""}INDEX ${m[2]} ON ${m[3]} (${m[4]!.split(",").map((s) => s.trim()).join(", ")})${m[5] ? " " + m[5].trim() : ""};`);
        }
        out.push("");
    }
    // Defaults and indexes copied as text: flag anything that may not be portable.
    for (const t of tables) for (const c of d.listColumns(db, t)) if (c.defaultSql && !/^('[^']*'|-?\d+(\.\d+)?|NULL)$/i.test(c.defaultSql)) console.error("odd default", t, c.name, c.defaultSql);
    for (const t of tables) for (const ix of d.listIndexes(db, t)) if (ix.columns.includes("<expression>")) console.error("expr index", t, ix.name);
    db.close();
    return out.join("\n");
}
