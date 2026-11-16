/**
 * Database schema files (SQL `CREATE TABLE` / `CREATE TYPE … AS ENUM`, Prisma `model` / `enum`) read as text into tables, columns,
 * constraints, foreign keys and enums. The file is untrusted: it is tokenised once, left to right, with no backtracking pattern, and
 * nothing in it is executed. Statements it does not read are skipped and counted; anything over a cap is listed in `truncated`.
 */
import type { ModelFragment } from "../fragment.js";
import { AppModelSchema } from "../model.js";
import { fingerprintText } from "./fingerprint.js";
import { hideSecrets } from "./hide-secrets.js";
import { SECRET_KEY } from "../../../shared/redact-text.js";

export const MAX_SCHEMA_INPUT = 1024 * 1024;
export const MAX_SCHEMA_TABLES = 500;
export const MAX_SCHEMA_COLUMNS = 200;
const MAX_ENUM_VALUES = 200;
const MAX_TEXT = 500;

export interface ParsedColumn {
    name: string;
    type: string;
    line: number;
    nullable: boolean;
    unique: boolean;
    primaryKey: boolean;
    default?: string;
    check?: string;
}

export interface ParsedForeignKey {
    columns: string[];
    table: string;
    refColumns: string[];
    /** The line that states the foreign key. */
    line: number;
}

export interface ParsedTable {
    name: string;
    line: number;
    columns: ParsedColumn[];
    primaryKey: string[];
    unique: string[][];
    checks: { expression: string; line: number }[];
    foreignKeys: ParsedForeignKey[];
}

export interface ParsedEnum {
    name: string;
    values: string[];
    line: number;
}

export interface ParsedSchema {
    dialect: "sql" | "prisma";
    tables: ParsedTable[];
    enums: ParsedEnum[];
    /** Statements or blocks that were not read (indexes, grants, datasource blocks…). */
    skipped: number;
    /** One sentence per cap that was reached. */
    truncated: string[];
}

type Kind = "word" | "string" | "quoted" | "punct";
interface Token {
    kind: Kind;
    /** Words as written; strings and quoted identifiers without their quotes. */
    text: string;
    start: number;
    end: number;
    line: number;
}

const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/** One pass over the text; every character is looked at a bounded number of times. */
function tokenize(src: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    let line = 1;
    const n = src.length;
    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 10) {
            line++;
            i++;
            continue;
        }
        if (c === 32 || c === 9 || c === 13 || c === 12) {
            i++;
            continue;
        }
        const next = src.charCodeAt(i + 1);
        if ((c === 45 && next === 45) || (c === 47 && next === 47)) {
            while (i < n && src.charCodeAt(i) !== 10) i++;
            continue;
        }
        if (c === 47 && next === 42) {
            i += 2;
            while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) {
                if (src.charCodeAt(i) === 10) line++;
                i++;
            }
            i += 2;
            continue;
        }
        const startLine = line;
        if (c === 39 || c === 34 || c === 96) {
            // '…' string, "…" or `…` quoted identifier; a doubled quote is an escaped quote.
            const start = i;
            let text = "";
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === c) {
                    if (src.charCodeAt(i + 1) === c) {
                        text += src[i];
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                if (d === 10) line++;
                if (text.length < MAX_TEXT) text += src[i];
                i++;
            }
            out.push({ kind: c === 39 ? "string" : "quoted", text, start, end: i, line: startLine });
            continue;
        }
        if (isWordChar(c)) {
            const start = i;
            while (i < n && isWordChar(src.charCodeAt(i))) i++;
            out.push({ kind: "word", text: src.slice(start, i), start, end: i, line });
            continue;
        }
        out.push({ kind: "punct", text: src[i], start: i, end: i + 1, line });
        i++;
    }
    return out;
}

const startsWithDigit = (t: Token | undefined) => !!t && t.kind === "word" && t.text.charCodeAt(0) >= 48 && t.text.charCodeAt(0) <= 57;
const upper = (t: Token | undefined) => (t && t.kind === "word" ? t.text.toUpperCase() : "");
const isPunct = (t: Token | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;
const isName = (t: Token | undefined) => !!t && (t.kind === "word" || t.kind === "quoted");
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

/** Index just past the bracket that closes the one at `open`, or the end of the range. Linear. */
function closeOf(toks: Token[], open: number, end: number): number {
    const o = toks[open].text;
    const c = o === "(" ? ")" : o === "[" ? "]" : "}";
    let depth = 0;
    for (let i = open; i < end; i++) {
        if (isPunct(toks[i], o)) depth++;
        else if (isPunct(toks[i], c) && --depth === 0) return i + 1;
    }
    return end;
}

/** Splits [from, to) at commas outside brackets. */
function splitTopLevel(toks: Token[], from: number, to: number): [number, number][] {
    const parts: [number, number][] = [];
    let depth = 0;
    let s = from;
    for (let i = from; i < to; i++) {
        const t = toks[i];
        if (t.kind !== "punct") continue;
        if (t.text === "(" || t.text === "[") depth++;
        else if (t.text === ")" || t.text === "]") depth--;
        else if (t.text === "," && depth === 0) {
            parts.push([s, i]);
            s = i + 1;
        }
    }
    if (s < to) parts.push([s, to]);
    return parts;
}

/** A possibly qualified name (`schema.table`, `"x"."y"`): the last part. Returns the name and the index after it. */
function readName(toks: Token[], i: number, end: number): [string, number] {
    let name = "";
    while (i < end && isName(toks[i])) {
        name = toks[i].text;
        i++;
        if (isPunct(toks[i], ".") && isName(toks[i + 1])) i++;
        else break;
    }
    return [name, i];
}

/** Names inside a bracket list starting at `open`: `(a, "b")` or `[a, b]`. */
function nameList(toks: Token[], open: number, end: number): [string[], number] {
    const close = closeOf(toks, open, end);
    const names: string[] = [];
    for (let i = open + 1; i < close - 1; i++) if (isName(toks[i]) && names.length < MAX_SCHEMA_COLUMNS) names.push(toks[i].text);
    return [names, close];
}

/** Source text from token `from` up to (not including) token `to`. */
const sourceText = (src: string, toks: Token[], from: number, to: number) => (from < to ? clip(src.slice(toks[from].start, toks[to - 1].end).trim()) : "");

const COLUMN_STOP = new Set(["CONSTRAINT", "NOT", "NULL", "PRIMARY", "UNIQUE", "CHECK", "DEFAULT", "REFERENCES", "GENERATED", "COLLATE", "AUTO_INCREMENT", "IDENTITY"]);
const TABLE_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "KEY", "INDEX", "EXCLUDE", "LIKE", "FULLTEXT", "SPATIAL"]);

/** A table element that is a constraint, not a column: `UNIQUE (a)`, `KEY idx (a)`, `CONSTRAINT …`; a column named `key text` is a column. */
function isTableConstraint(toks: Token[], s: number): boolean {
    const kw = toks[s].kind === "word" ? upper(toks[s]) : "";
    if (!TABLE_CONSTRAINT.has(kw)) return false;
    if (["CONSTRAINT", "PRIMARY", "FOREIGN", "CHECK", "EXCLUDE", "LIKE"].includes(kw)) return true;
    return isPunct(toks[s + 1], "(") || ["KEY", "INDEX"].includes(upper(toks[s + 1])) || (kw !== "UNIQUE" && isName(toks[s + 1]) && isPunct(toks[s + 2], "(") && !startsWithDigit(toks[s + 3]));
}

class Collector {
    readonly tables: ParsedTable[] = [];
    readonly enums: ParsedEnum[] = [];
    readonly truncated = new Set<string>();
    skipped = 0;

    addTable(name: string, line: number): ParsedTable | undefined {
        if (this.tables.length >= MAX_SCHEMA_TABLES) {
            this.truncated.add(`Only the first ${MAX_SCHEMA_TABLES} tables were read.`);
            return undefined;
        }
        const t: ParsedTable = { name, line, columns: [], primaryKey: [], unique: [], checks: [], foreignKeys: [] };
        this.tables.push(t);
        return t;
    }

    addColumn(t: ParsedTable, c: ParsedColumn): boolean {
        if (t.columns.length >= MAX_SCHEMA_COLUMNS) {
            this.truncated.add(`Only the first ${MAX_SCHEMA_COLUMNS} columns of a table were read.`);
            return false;
        }
        t.columns.push(c);
        return true;
    }

    addEnum(name: string, values: string[], line: number) {
        if (this.enums.length >= MAX_SCHEMA_TABLES) {
            this.truncated.add(`Only the first ${MAX_SCHEMA_TABLES} enums were read.`);
            return;
        }
        if (values.length > MAX_ENUM_VALUES) this.truncated.add(`Only the first ${MAX_ENUM_VALUES} values of an enum were read.`);
        this.enums.push({ name, values: values.slice(0, MAX_ENUM_VALUES), line });
    }
}

// ---------------------------------------------------------------- SQL

/** `type` text: words spaced, punctuation attached, a space after commas. */
function typeText(toks: Token[], from: number, to: number): string {
    let s = "";
    for (let i = from; i < to && s.length < MAX_TEXT; i++) {
        const t = toks[i];
        const prev = toks[i - 1];
        if (i > from && t.kind !== "punct" && prev.kind !== "punct") s += " ";
        else if (i > from && isPunct(prev, ",")) s += " ";
        s += t.kind === "string" ? `'${t.text}'` : t.text;
    }
    return clip(s);
}

/** A table constraint (`[CONSTRAINT n] PRIMARY KEY (…) | UNIQUE (…) | CHECK (…) | FOREIGN KEY (…) REFERENCES t (…)`) in [i, end). */
function sqlTableConstraint(src: string, toks: Token[], i: number, end: number, table: ParsedTable) {
    if (upper(toks[i]) === "CONSTRAINT") i += 2;
    const kw = upper(toks[i]);
    const line = toks[i]?.line ?? table.line;
    const parenAt = (from: number) => {
        for (let j = from; j < end; j++) if (isPunct(toks[j], "(")) return j;
        return -1;
    };
    if (kw === "PRIMARY" || kw === "UNIQUE") {
        const open = parenAt(i + 1);
        if (open < 0) return;
        const [cols] = nameList(toks, open, end);
        if (kw === "PRIMARY") {
            table.primaryKey = cols;
            for (const c of table.columns) if (cols.includes(c.name)) (c.primaryKey = true), (c.nullable = false);
        } else if (cols.length === 1) {
            const col = table.columns.find((c) => c.name === cols[0]);
            if (col) col.unique = true;
            else table.unique.push(cols);
        } else table.unique.push(cols);
    } else if (kw === "CHECK") {
        const open = parenAt(i + 1);
        if (open < 0) return;
        const close = closeOf(toks, open, end);
        table.checks.push({ expression: sourceText(src, toks, open + 1, close - 1), line });
    } else if (kw === "FOREIGN") {
        const open = parenAt(i + 1);
        if (open < 0) return;
        const [cols, after] = nameList(toks, open, end);
        if (upper(toks[after]) !== "REFERENCES") return;
        const [ref, next] = readName(toks, after + 1, end);
        const refCols = isPunct(toks[next], "(") ? nameList(toks, next, end)[0] : [];
        if (ref) table.foreignKeys.push({ columns: cols, table: ref, refColumns: refCols, line });
    }
}

function sqlColumn(src: string, toks: Token[], i: number, end: number, table: ParsedTable, out: Collector) {
    const nameTok = toks[i];
    let j = i + 1;
    let depth = 0;
    for (; j < end; j++) {
        const t = toks[j];
        if (isPunct(t, "(") || isPunct(t, "[")) depth++;
        else if (isPunct(t, ")") || isPunct(t, "]")) depth--;
        else if (depth === 0 && COLUMN_STOP.has(upper(t))) break;
    }
    const col: ParsedColumn = { name: nameTok.text, type: typeText(toks, i + 1, j), line: nameTok.line, nullable: true, unique: false, primaryKey: false };
    if (!out.addColumn(table, col)) return;
    while (j < end) {
        const kw = upper(toks[j]);
        if (kw === "NOT" && upper(toks[j + 1]) === "NULL") {
            col.nullable = false;
            j += 2;
        } else if (kw === "NULL") {
            j++;
        } else if (kw === "PRIMARY") {
            col.primaryKey = true;
            col.nullable = false;
            table.primaryKey = [col.name];
            j += upper(toks[j + 1]) === "KEY" ? 2 : 1;
        } else if (kw === "UNIQUE") {
            col.unique = true;
            j++;
        } else if (kw === "CHECK" && isPunct(toks[j + 1], "(")) {
            const close = closeOf(toks, j + 1, end);
            col.check = sourceText(src, toks, j + 2, close - 1);
            table.checks.push({ expression: col.check, line: toks[j].line });
            j = close;
        } else if (kw === "DEFAULT") {
            let k = j + 1;
            let d = 0;
            for (; k < end; k++) {
                const t = toks[k];
                if (isPunct(t, "(")) d++;
                else if (isPunct(t, ")")) d--;
                else if (d === 0 && k > j + 1 && COLUMN_STOP.has(upper(t))) break;
            }
            col.default = sourceText(src, toks, j + 1, k);
            j = k;
        } else if (kw === "REFERENCES") {
            const [ref, next] = readName(toks, j + 1, end);
            let after = next;
            let refCols: string[] = [];
            if (isPunct(toks[next], "(")) [refCols, after] = nameList(toks, next, end);
            if (ref) table.foreignKeys.push({ columns: [col.name], table: ref, refColumns: refCols, line: toks[j].line });
            j = Math.max(after, j + 1);
        } else j++;
    }
}

function sqlCreateTable(src: string, toks: Token[], i: number, end: number, out: Collector): boolean {
    const createLine = toks[i].line;
    i++;
    while (["OR", "REPLACE", "TEMP", "TEMPORARY", "UNLOGGED", "GLOBAL", "LOCAL"].includes(upper(toks[i]))) i++;
    if (upper(toks[i]) !== "TABLE") return false;
    i++;
    if (upper(toks[i]) === "IF" && upper(toks[i + 1]) === "NOT" && upper(toks[i + 2]) === "EXISTS") i += 3;
    const [name, at] = readName(toks, i, end);
    if (!name || !isPunct(toks[at], "(")) return false;
    const table = out.addTable(name, createLine);
    if (!table) return true;
    const close = closeOf(toks, at, end);
    for (const [s, e] of splitTopLevel(toks, at + 1, close - 1)) {
        if (s >= e) continue;
        if (isTableConstraint(toks, s)) {
            sqlTableConstraint(src, toks, s, e, table);
        } else if (isName(toks[s])) sqlColumn(src, toks, s, e, table, out);
    }
    return true;
}

function sqlCreateEnum(toks: Token[], i: number, end: number, out: Collector): boolean {
    const line = toks[i].line;
    if (upper(toks[i + 1]) !== "TYPE") return false;
    const [name, at] = readName(toks, i + 2, end);
    if (!name || upper(toks[at]) !== "AS" || upper(toks[at + 1]) !== "ENUM" || !isPunct(toks[at + 2], "(")) return false;
    const close = closeOf(toks, at + 2, end);
    const values: string[] = [];
    for (let k = at + 3; k < close - 1; k++) if (toks[k].kind === "string" && values.length <= MAX_ENUM_VALUES) values.push(toks[k].text);
    out.addEnum(name, values, line);
    return true;
}

/** `ALTER TABLE [ONLY] [IF EXISTS] t ADD [CONSTRAINT n] …`: pg_dump states keys this way. */
function sqlAlterTable(src: string, toks: Token[], i: number, end: number, out: Collector): boolean {
    if (upper(toks[i + 1]) !== "TABLE") return false;
    i += 2;
    while (["ONLY", "IF", "EXISTS"].includes(upper(toks[i]))) i++;
    const [name, at] = readName(toks, i, end);
    const table = out.tables.find((t) => t.name === name);
    if (!table || upper(toks[at]) !== "ADD") return false;
    if (!TABLE_CONSTRAINT.has(upper(toks[at + 1]))) return false;
    sqlTableConstraint(src, toks, at + 1, end, table);
    return true;
}

function parseSql(src: string, toks: Token[], out: Collector) {
    let s = 0;
    for (let i = 0; i <= toks.length; i++) {
        if (i < toks.length && !isPunct(toks[i], ";")) continue;
        if (s < i) {
            const kw = upper(toks[s]);
            const read = kw === "CREATE" ? sqlCreateTable(src, toks, s, i, out) || sqlCreateEnum(toks, s, i, out) : kw === "ALTER" ? sqlAlterTable(src, toks, s, i, out) : false;
            if (!read) out.skipped++;
        }
        s = i + 1;
    }
}

// ---------------------------------------------------------------- Prisma

interface PrismaField {
    table: ParsedTable;
    column: ParsedColumn;
    typeName: string;
    relation?: { fields: string[]; references: string[] };
}

/** A named argument list inside `@relation(...)`: `fields: [a, b]`. */
function namedList(toks: Token[], from: number, to: number, key: string): string[] {
    for (let k = from; k < to; k++) if (upper(toks[k]) === key.toUpperCase() && isPunct(toks[k + 1], ":") && isPunct(toks[k + 2], "[")) return nameList(toks, k + 2, to)[0];
    return [];
}

function prismaModel(src: string, toks: Token[], open: number, close: number, table: ParsedTable, fields: PrismaField[], out: Collector) {
    let i = open + 1;
    const end = close - 1;
    while (i < end) {
        // One field or block attribute per line.
        const line = toks[i].line;
        let e = i;
        while (e < end && toks[e].line === line) e = isPunct(toks[e], "(") || isPunct(toks[e], "[") || isPunct(toks[e], "{") ? closeOf(toks, e, end) : e + 1;
        if (isPunct(toks[i], "@") && isPunct(toks[i + 1], "@")) {
            const attr = upper(toks[i + 2]);
            const list = isPunct(toks[i + 3], "(") && isPunct(toks[i + 4], "[") ? nameList(toks, i + 4, e)[0] : [];
            if (attr === "ID" && list.length) table.primaryKey = list;
            else if (attr === "UNIQUE" && list.length) table.unique.push(list);
        } else if (isName(toks[i]) && isName(toks[i + 1])) {
            const typeName = toks[i + 1].text;
            let k = i + 2;
            let type = typeName;
            if (isPunct(toks[k], "(")) k = closeOf(toks, k, e); // Unsupported("…")
            let nullable = false;
            if (isPunct(toks[k], "[") && isPunct(toks[k + 1], "]")) {
                type += "[]";
                k += 2;
            } else if (isPunct(toks[k], "?")) {
                nullable = true;
                k++;
            }
            const column: ParsedColumn = { name: toks[i].text, type, line, nullable, unique: false, primaryKey: false };
            const field: PrismaField = { table, column, typeName };
            while (k < e) {
                if (!isPunct(toks[k], "@")) {
                    k++;
                    continue;
                }
                const attr = upper(toks[k + 1]);
                let after = k + 2;
                while (isPunct(toks[after], ".") && isName(toks[after + 1])) after += 2;
                const argsEnd = isPunct(toks[after], "(") ? closeOf(toks, after, e) : after;
                if (attr === "ID") column.primaryKey = true;
                else if (attr === "UNIQUE") column.unique = true;
                else if (attr === "DEFAULT" && argsEnd > after) column.default = sourceText(src, toks, after + 1, argsEnd - 1);
                else if (attr === "RELATION" && argsEnd > after) field.relation = { fields: namedList(toks, after, argsEnd, "fields"), references: namedList(toks, after, argsEnd, "references") };
                k = argsEnd;
            }
            fields.push(field);
        }
        i = Math.max(e, i + 1);
    }
}

function parsePrisma(src: string, toks: Token[], out: Collector) {
    const fields: PrismaField[] = [];
    const models = new Set<string>();
    let i = 0;
    while (i < toks.length) {
        const kw = upper(toks[i]);
        const open = i + 2;
        if (!isName(toks[i + 1]) || !isPunct(toks[open], "{")) {
            i++;
            continue;
        }
        const close = closeOf(toks, open, toks.length);
        const name = toks[i + 1].text;
        if (kw === "MODEL") {
            models.add(name);
            const table = out.addTable(name, toks[i].line);
            if (table) prismaModel(src, toks, open, close, table, fields, out);
        } else if (kw === "ENUM") {
            const values: string[] = [];
            let lastLine = -1;
            for (let k = open + 1; k < close - 1; k++) {
                const t = toks[k];
                if (t.line !== lastLine && t.kind === "word") values.push(t.text);
                lastLine = t.line;
            }
            out.addEnum(name, values, toks[i].line);
        } else out.skipped++;
        i = close;
    }
    for (const f of fields) {
        if (models.has(f.typeName)) {
            // A relation field is not a column; it is a foreign key only when it names its fields and references.
            if (f.relation && f.relation.fields.length) f.table.foreignKeys.push({ columns: f.relation.fields, table: f.typeName, refColumns: f.relation.references, line: f.column.line });
            continue;
        }
        if (f.column.primaryKey) {
            f.column.nullable = false;
            f.table.primaryKey = [f.column.name];
        }
        out.addColumn(f.table, f.column);
    }
}

/** Prisma when the first statement opens a `name Name {` block; SQL otherwise. */
function looksPrisma(toks: Token[]): boolean {
    return ["MODEL", "ENUM", "DATASOURCE", "GENERATOR", "VIEW", "TYPE"].includes(upper(toks[0])) && isName(toks[1]) && isPunct(toks[2], "{");
}

export function parseSchema(text: string): ParsedSchema {
    const out = new Collector();
    let src = text;
    if (src.length > MAX_SCHEMA_INPUT) {
        src = src.slice(0, MAX_SCHEMA_INPUT);
        out.truncated.add("The schema file is over 1 MB; only the first 1 MB was read.");
    }
    const toks = tokenize(src);
    const dialect = looksPrisma(toks) ? "prisma" : "sql";
    if (dialect === "prisma") parsePrisma(src, toks, out);
    else parseSql(src, toks, out);
    return { dialect, tables: out.tables, enums: out.enums, skipped: out.skipped, truncated: [...out.truncated] };
}

// ---------------------------------------------------------------- Model fragment

/** Constraint words for a column, in a fixed order. */
function columnConstraints(c: ParsedColumn, table: ParsedTable, enums: Map<string, ParsedEnum>): string[] {
    const out: string[] = [];
    if (c.primaryKey) out.push("primary key");
    if (!c.nullable) out.push("not null");
    if (c.unique) out.push("unique");
    // A default of a secret-named column is never kept; other defaults and checks are stored only after secret hiding.
    if (c.default !== undefined) out.push(`default ${SECRET_COLUMN.test(c.name) ? "[hidden]" : hideSecrets(c.default, { max: 150 })}`);
    if (c.check !== undefined) out.push(`check (${hideSecrets(c.check, { max: 150 })})`);
    for (const fk of table.foreignKeys) if (fk.columns.length === 1 && fk.columns[0] === c.name) out.push(`references ${fk.table}${fk.refColumns.length ? `(${fk.refColumns.join(", ")})` : ""}`);
    const e = enums.get(c.type.replace(/\[\]$/, "").toLowerCase());
    if (e) out.push(`one of: ${e.values.join(", ")}`);
    return out.map((s) => clip200(s)).slice(0, 20);
}
const RELATIONSHIP_CAP = "Only the first 2000 foreign keys were recorded as relationships.";
const SECRET_COLUMN = new RegExp(`^(?:${SECRET_KEY})$|(?:^|_)(?:pw|pin|otp)(?:_|$)`, "i");
const clip200 = (s: string) => (s.length > 200 ? s.slice(0, 200) : s);

/**
 * A schema file as a model fragment: tables become entities, each foreign key a relationship (with the line that states it; nothing
 * else makes one), enum values the possible states of the columns that use them. No rules and no transitions: a schema says which
 * states exist, not which changes between them are intended.
 */
export function schemaFragment(text: string, opts: { ref: string; now?: string }): ModelFragment {
    const now = opts.now ?? new Date().toISOString();
    const ref = opts.ref.slice(0, 480);
    const fingerprint = fingerprintText(text);
    const parsed = parseSchema(text);
    const model = AppModelSchema.parse({ contextSources: ["db_schema"] });
    if (!parsed.tables.length) {
        const error = "The file has no table definition (SQL CREATE TABLE or Prisma model) that could be read.";
        return { source: { kind: "db_schema", ref: opts.ref.slice(0, 500), fingerprint, status: "failed", processedAt: now, error }, model: AppModelSchema.parse({}), rules: [], notes: [] };
    }
    const at = (line: number) => ({ kind: "file" as const, ref: `${ref}:${line}` });
    const enums = new Map(parsed.enums.map((e) => [e.name.toLowerCase(), e]));
    const notes: string[] = [...parsed.truncated];
    for (const t of parsed.tables.slice(0, 500)) {
        model.entities.push({
            id: t.name.slice(0, 100),
            name: t.name.slice(0, 100),
            fields: t.columns.slice(0, 100).map((c) => ({ name: c.name.slice(0, 100), type: c.type.slice(0, 50), constraints: columnConstraints(c, t, enums) })),
            evidence: [at(t.line)],
        });
        for (const fk of t.foreignKeys) {
            if (model.relationships.length >= 2000) {
                if (!notes.includes(RELATIONSHIP_CAP)) notes.push(RELATIONSHIP_CAP);
                break;
            }
            model.relationships.push({ from: t.name.slice(0, 100), to: fk.table.slice(0, 100), kind: "belongs_to", evidence: [at(fk.line)] });
        }
        for (const c of t.columns) {
            const e = enums.get(c.type.replace(/\[\]$/, "").toLowerCase());
            if (e && notes.length < 50) notes.push(clip(`Enum ${e.name} (${e.values.join(", ")}) lists the possible states of ${t.name}.${c.name}; which changes between them are intended needs a document.`));
        }
    }
    if (parsed.skipped) notes.push(`${parsed.skipped} statement${parsed.skipped === 1 ? " in the file was" : "s in the file were"} not read (only tables, keys and enums are).`);
    return { source: { kind: "db_schema", ref: opts.ref.slice(0, 500), fingerprint, status: "processed", processedAt: now }, model, rules: [], notes: notes.slice(0, 50) };
}
