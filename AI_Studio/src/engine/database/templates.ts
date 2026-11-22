/**
 * The database checks a `DatabaseProbe` runs (Phase 4 C10, spec 4.4). A template holds names only; the values it compares with travel
 * apart, in `params`, and are only ever bound (or compared in memory), never written into a statement:
 *   exists     rows of `table` whose `where` columns equal the params (persistence: the row a 2xx create or update wrote)
 *   count      the same rows, counted (an empty `where` counts the table)
 *   orphans    rows of `table` whose `columns` point at no row of `references.table` (a null in the columns points at nothing)
 *   duplicates values of `columns` held by more than one row of `table`, case-folded with `fold` (nulls never clash)
 *   relation   rows of `table` (narrowed by `where`) on which the C5 expression (validation/relation.ts) does not hold
 * Every name must be in the probe's schema, and every object is strict: an extra field (a "sql" text, say) is refused like a wrong name.
 */
import { sameStoredValue } from "./same-value.js";
import { z } from "zod";
import { parseRelation, checkRelation } from "../validation/relation.js";
import { checkResult, DatabaseCheckRefused, type DbCheckResult, type DbSchema, type DbTable } from "./probe.js";

const Name = z.string().min(1).max(63);
const Columns = z.array(Name).min(1).max(8);
const Where = z.array(Name).max(8);

export const DbTemplateSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("exists"), table: Name, where: Columns }).strict(),
    z.object({ kind: z.literal("count"), table: Name, where: Where }).strict(),
    z.object({ kind: z.literal("orphans"), table: Name, columns: Columns, references: z.object({ table: Name, columns: Columns }).strict() }).strict(),
    z.object({ kind: z.literal("duplicates"), table: Name, columns: Columns, fold: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal("relation"), table: Name, where: Where, expression: z.string().min(1).max(300) }).strict(),
]);
export type DbTemplate = z.infer<typeof DbTemplateSchema>;

/** A value a `where` column is compared with: text, a number or null (no objects, no lists). */
export const DbParamsSchema = z.record(z.string().max(63), z.union([z.string().max(2000), z.number().finite(), z.null()]));
export type DbParams = z.infer<typeof DbParamsSchema>;
export type DbValue = DbParams[string];

/** A template that passed validateCheck: every name is in the schema and the params bind exactly its `where` columns. */
export type ValidCheck = { template: DbTemplate; params: DbParams; table: DbTable; parent?: DbTable; columnsRead: string[] };

/** Column names that hold sign-in details (as database/checks.ts leaves them out of generated checks). */
const CREDENTIAL_COLUMN = /pass(word)?|secret|token|otp|pin$|key$/i;
/** The names of a template as text for a message (the caller's own names, shortened; never a param value). */
const named = (v: unknown) => JSON.stringify(String(v).slice(0, 60));

/** Checks the template against the schema: refuses (DatabaseCheckRefused) anything outside it. Params are checked by name and type only. */
export function validateCheck(template: unknown, params: unknown, schema: DbSchema): ValidCheck {
    const t = DbTemplateSchema.safeParse(template);
    if (!t.success) throw new DatabaseCheckRefused(`the template is not one of exists, count, orphans, duplicates or relation with names only (${t.error.issues[0]?.path.join(".") || "template"}: ${t.error.issues[0]?.message ?? "invalid"})`);
    const p = DbParamsSchema.safeParse(params ?? {});
    if (!p.success) throw new DatabaseCheckRefused("each param must be text, a number or null, named by a where column");
    const tpl = t.data;
    const byName = new Map(schema.tables.map((x) => [x.name, x]));
    const tableOf = (name: string) => {
        const x = byName.get(name);
        if (!x) throw new DatabaseCheckRefused(`there is no table ${named(name)} in the schema`);
        return x;
    };
    const columnsOf = (x: DbTable, cols: string[]) => {
        for (const c of cols) if (!x.columns.includes(c)) throw new DatabaseCheckRefused(`table ${named(x.name)} has no column ${named(c)}`);
        if (new Set(cols).size !== cols.length) throw new DatabaseCheckRefused("a column is named twice");
    };
    // A credential column is never compared with a value or in a relation: a check would be an oracle over it (counts and fingerprints).
    const noCredential = (cols: string[]) => {
        for (const c of cols) if (CREDENTIAL_COLUMN.test(c)) throw new DatabaseCheckRefused(`column ${named(c)} holds sign-in details, which a check never compares`);
    };
    const table = tableOf(tpl.table);
    let parent: DbTable | undefined;
    const read: string[] = [];
    if (tpl.kind === "exists" || tpl.kind === "count" || tpl.kind === "relation") {
        columnsOf(table, tpl.where);
        noCredential(tpl.where);
        const keys = Object.keys(p.data);
        if (keys.length !== tpl.where.length || !tpl.where.every((c) => Object.prototype.hasOwnProperty.call(p.data, c))) throw new DatabaseCheckRefused("the params must be exactly the where columns");
        read.push(...tpl.where);
    } else if (Object.keys(p.data).length) throw new DatabaseCheckRefused(`${tpl.kind} takes no params`);
    if (tpl.kind === "orphans") {
        columnsOf(table, tpl.columns);
        parent = tableOf(tpl.references.table);
        columnsOf(parent, tpl.references.columns);
        if (tpl.columns.length !== tpl.references.columns.length) throw new DatabaseCheckRefused("orphans needs as many columns as the referenced key has");
        read.push(...tpl.columns);
    }
    if (tpl.kind === "duplicates") {
        columnsOf(table, tpl.columns);
        read.push(...tpl.columns);
    }
    if (tpl.kind === "relation") {
        const r = parseRelation(tpl.expression);
        if (!r.ok) throw new DatabaseCheckRefused(`the expression is outside the relation grammar (${r.error})`);
        if (r.refs.vars.length) throw new DatabaseCheckRefused("a database relation reads columns only, not test values ($names)");
        const top = [...new Set(r.refs.paths.map((x) => x.split(/[.[]/)[0]!))];
        if (top.some((c) => c === "")) throw new DatabaseCheckRefused("a database relation names columns, not list positions");
        columnsOf(table, top);
        noCredential(top);
        read.push(...top);
    }
    return { template: tpl, params: p.data, table, ...(parent ? { parent } : {}), columnsRead: [...new Set(read)] };
}

/** The columns that name a row in a result: its primary key, else the columns the check read, else every column. */
export function keyColumns(v: ValidCheck): string[] {
    if (v.template.kind === "duplicates") return v.template.columns;
    if (v.table.primaryKey.length) return v.table.primaryKey;
    return v.columnsRead.length ? v.columnsRead : v.table.columns;
}

type Row = Record<string, unknown>;
const own = (r: Row, k: string): unknown => (Object.prototype.hasOwnProperty.call(r, k) ? r[k] : undefined);
const isNull = (v: unknown) => v === null || v === undefined;
const fold = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
/** First words of the refusal of a rule the stored rows cannot be judged by. */
export const RELATION_UNJUDGED = "the rule cannot be judged on the stored rows";
/**
 * Whether a relation holds on a row: the expression's paths read the row's columns. Its message (which shows values) is dropped.
 * A row it cannot be judged on (text compared with a number, a missing column) refuses the check: an ill-formed rule, not a broken row.
 */
export const relationHolds = (expression: string, row: Row): boolean => {
    const r = checkRelation(expression, { body: row });
    if (!r.held && r.error) throw new DatabaseCheckRefused(`${RELATION_UNJUDGED} (a value of another type than the rule compares, such as text with a number, or no value)`);
    return r.held;
};

/**
 * Runs a validated check over rows held in memory (the D-a back end's tables). A value matches as same-value.ts says (trimmed, e-mail
 * addresses case-folded, dates by instant or day); otherwise strictly (`1` is not `"1"`).
 */
export function runOnRows(v: ValidCheck, tables: Record<string, Row[] | undefined>, evidenceKey: Buffer): DbCheckResult {
    const rows = tables[v.table.name] ?? [];
    const key = keyColumns(v);
    const keyOf = (r: Row) => key.map((c) => own(r, c));
    const t = v.template;
    const matches = (r: Row) => Object.entries(v.params).every(([c, want]) => (want === null ? isNull(own(r, c)) : sameStoredValue(own(r, c), want)));
    let hit: Row[];
    if (t.kind === "exists" || t.kind === "count") hit = rows.filter(matches);
    else if (t.kind === "relation") hit = rows.filter((r) => matches(r) && !relationHolds(t.expression, r));
    else if (t.kind === "orphans") {
        const parents = new Set((tables[v.parent!.name] ?? []).map((r) => JSON.stringify(t.references.columns.map((c) => own(r, c)))));
        hit = rows.filter((r) => {
            const vals = t.columns.map((c) => own(r, c));
            return !vals.some(isNull) && !parents.has(JSON.stringify(vals));
        });
    } else {
        const groups = new Map<string, unknown[]>();
        const counts = new Map<string, number>();
        for (const r of rows) {
            const vals = t.columns.map((c) => own(r, c));
            if (vals.some(isNull)) continue;
            const k = JSON.stringify(t.fold ? vals.map(fold) : vals);
            counts.set(k, (counts.get(k) ?? 0) + 1);
            if (!groups.has(k)) groups.set(k, t.fold ? vals.map(fold) : vals);
        }
        const dup = [...counts].filter(([, n]) => n > 1).map(([k]) => groups.get(k)!);
        return checkResult(t.kind, t.table, dup.length, dup, evidenceKey);
    }
    return checkResult(t.kind, t.table, hit.length, hit.map(keyOf), evidenceKey);
}
