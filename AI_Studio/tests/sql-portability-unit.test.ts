/**
 * Portability lint (POSTGRES_S3_MIGRATION.md §1.2, §3.2): no SQLite-only idiom in the SQL of `src/**`. The SQL that has to differ
 * lives in src/platform/sql-dialect.ts (`db.dialect`). Only string and template literals are read, so comments may name an idiom;
 * `lastInsertRowid` is also caught as a property name. A hit fails with its file and line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const DIALECT = "platform/sql-dialect.ts";

const RULES: Array<{ id: string; re: RegExp; allowedIn: string[] }> = [
    { id: "INSERT OR", re: /\bINSERT\s+OR\s+(REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\b/i, allowedIn: [] },
    { id: "rowid", re: /\browid\b/, allowedIn: [DIALECT] },
    { id: "json_extract", re: /\bjson_extract\s*\(/i, allowedIn: [DIALECT] },
    { id: "julianday", re: /\bjulianday\s*\(/i, allowedIn: [DIALECT] },
    { id: "COLLATE NOCASE", re: /\bCOLLATE\s+NOCASE\b/i, allowedIn: [] },
    { id: "PRAGMA", re: /\bPRAGMA\b/i, allowedIn: [DIALECT, "platform/db.ts"] },
    { id: "sqlite_master", re: /\bsqlite_(master|schema)\b/i, allowedIn: [DIALECT] },
    { id: "LIMIT -1", re: /\bLIMIT\s+-\s*1\b/i, allowedIn: [] },
    // SQLite's `x IS ?` / `x IS NOT ?` compare values; PostgreSQL accepts only IS [NOT] NULL/TRUE/FALSE there. Use IS [NOT] DISTINCT FROM.
    { id: "IS ?", re: /\bIS\s+(NOT\s+)?\?/i, allowedIn: [] },
    // Upper case only: "blob:" URLs and the Blob class are not SQL.
    { id: "BLOB", re: /\bBLOB\b/, allowedIn: [DIALECT] },
];

/** Whole files exempt from one rule, with the reason. Keep it short. */
const ALLOW: Record<string, { rule: string; why: string }[]> = {
    "platform/ops/backup-schedule.ts": [{ rule: "PRAGMA", why: "Verifies a copied SQLite backup file (journal mode, quick_check). SQLite-only by nature; RDS snapshots replace it on PostgreSQL (§4.6)." }],
};

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? sourceFiles(p) : p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
    });
}

interface Hit {
    file: string;
    line: number;
    rule: string;
    text: string;
}

function scan(file: string): Hit[] {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const hits: Hit[] = [];
    const check = (node: ts.Node, text: string) => {
        for (const r of RULES) {
            if (r.allowedIn.includes(rel) || ALLOW[rel]?.some((a) => a.rule === r.id)) continue;
            if (r.re.test(text)) hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, rule: r.id, text: text.replace(/\s+/g, " ").slice(0, 120) });
        }
    };
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
        else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node, node.text);
        else if (ts.isIdentifier(node) && node.text === "lastInsertRowid") hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, rule: "lastInsertRowid", text: "use INSERT … RETURNING" });
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return hits;
}

describe("portable SQL in src", () => {
    it("uses no SQLite-only idiom outside the dialect", () => {
        const hits = sourceFiles(SRC).flatMap(scan);
        expect(hits.map((h) => `src/${h.file}:${h.line} ${h.rule}: ${h.text}`)).toEqual([]);
    });

    it("catches each idiom it is meant to catch, and not a comment", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sql-lint-"));
        try {
            const f = path.join(tmp, "probe.ts");
            fs.writeFileSync(
                f,
                [
                    "// INSERT OR REPLACE and rowid in a comment are fine",
                    'const a = "INSERT OR IGNORE INTO t (x) VALUES (?)";',
                    "const b = `SELECT * FROM t ORDER BY rowid ${'x'} LIMIT -1 OFFSET 2`;",
                    "const c = \"SELECT json_extract(j, '$.k'), julianday(x) FROM sqlite_master\";",
                    'const d = "ORDER BY name COLLATE NOCASE"; const e = "PRAGMA table_info(t)"; const g = "CAST(x AS BLOB)";',
                    "const h = r.lastInsertRowid; const i = \"WHERE a IS NOT ? AND b IS NOT NULL\";",
                    'const ok = "blob:" + "INSERT INTO t ON CONFLICT DO NOTHING";',
                ].join("\n"),
            );
            const rules = scan(f).map((h) => `${h.line}:${h.rule}`);
            expect(rules.sort()).toEqual(["2:INSERT OR", "3:LIMIT -1", "3:rowid", "4:json_extract", "4:julianday", "4:sqlite_master", "5:BLOB", "5:COLLATE NOCASE", "5:PRAGMA", "6:lastInsertRowid", "6:IS ?"].sort());
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("keeps the allow-list to files that exist and still need it", () => {
        for (const [rel, entries] of Object.entries(ALLOW)) {
            const file = path.join(SRC, rel);
            expect(fs.existsSync(file), rel).toBe(true);
            const text = fs.readFileSync(file, "utf8");
            for (const a of entries) expect(RULES.find((r) => r.id === a.rule)!.re.test(text), `${rel}: ${a.rule} no longer used, remove it from ALLOW`).toBe(true);
        }
    });
});
