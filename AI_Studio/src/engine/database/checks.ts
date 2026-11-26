/**
 * Database checks as test steps (Phase 4 C10, T23). A step `assertResponse check: "dbCheck"` names its check in plain words, and the
 * words are the template (names only; a value is a test value, never one read from the database):
 *   exists <table> where <column> = '<value>'[, <column> = '<value>']   the row a 2xx create or update wrote is stored
 *   orphans <table>(<columns>) -> <parent>(<columns>)                     no new row points at a missing parent
 *   duplicates <table>(<columns>)[ any case]                              no new value of a unique key is held twice
 *   relation <table>: <expression>                                        no new row breaks a C5 relation over its columns
 * A value may hold {{placeholders}} (the test's own values, such as an id a write returned); the script sends the name and those values
 * to the run's database check service (./service.ts), which validates the template against the probe's schema and runs it.
 * The last three hold when the test adds no breaking row: the script reads them before its first step and again at the step.
 */
import { resourceName } from "../api/workflows.js";
import { placeholdersIn, type Step } from "../spec/schema.js";
import { DatabaseCheckRefused, DB_NAME, type DbSchema, type DbTable } from "./probe.js";
import type { DbParams, DbTemplate } from "./templates.js";

/** The most database check steps one run generates (spec section 5). */
export const DB_CHECKS_MAX = 40;
/** The longest check name a step holds: a relation's 300 characters, its table and the words around them. */
export const DB_CHECK_NAME_MAX = 400;

const N = "[A-Za-z_][A-Za-z0-9_]{0,62}";
const LIST = `${N}(?:\\s*,\\s*${N})*`;
const names = (s: string) => s.split(",").map((x) => x.trim());
const VALUE = String.raw`'[^']*'|-?\d+(?:\.\d+)?|null`;
const RE = {
    exists: new RegExp(`^exists (${N}) where ((?:${N} = (?:${VALUE}))(?:, ${N} = (?:${VALUE}))*)$`),
    pair: new RegExp(`(${N}) = (${VALUE})(?:, |$)`, "gy"),
    orphans: new RegExp(`^orphans (${N})\\((${LIST})\\) -> (${N})\\((${LIST})\\)$`),
    duplicates: new RegExp(`^duplicates (${N})\\((${LIST})\\)( any case)?$`),
    relation: new RegExp(`^relation (${N}): (.+)$`, "s"),
};

/** A check's template and its params (values may still hold {{placeholders}}), from its name; refused when the name is not one of the forms. */
export function parseDbCheck(name: string): { template: DbTemplate; params: DbParams } {
    const text = name.trim();
    let m: RegExpExecArray | null;
    if ((m = RE.exists.exec(text))) {
        const params: DbParams = {};
        RE.pair.lastIndex = 0;
        for (const p of m[2]!.matchAll(RE.pair)) {
            const raw = p[2]!;
            if (p[1]! in params) throw new DatabaseCheckRefused("a column is named twice");
            params[p[1]!] = raw === "null" ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
        }
        return { template: { kind: "exists", table: m[1]!, where: Object.keys(params) }, params };
    }
    if ((m = RE.orphans.exec(text))) return { template: { kind: "orphans", table: m[1]!, columns: names(m[2]!), references: { table: m[3]!, columns: names(m[4]!) } }, params: {} };
    if ((m = RE.duplicates.exec(text))) return { template: { kind: "duplicates", table: m[1]!, columns: names(m[2]!), ...(m[3] ? { fold: true } : {}) }, params: {} };
    if ((m = RE.relation.exec(text))) return { template: { kind: "relation", table: m[1]!, where: [], expression: m[2]!.trim() }, params: {} };
    throw new DatabaseCheckRefused("the check is not one of: exists <table> where <column> = '<value>', orphans <table>(<columns>) -> <table>(<columns>), duplicates <table>(<columns>), relation <table>: <expression>");
}

/** The name of a check (the inverse of parseDbCheck). */
export function dbCheckName(t: DbTemplate, params: DbParams = {}): string {
    const v = (x: DbParams[string]) => (x === null ? "null" : typeof x === "number" ? String(x) : `'${x}'`);
    if (t.kind === "exists") return `exists ${t.table} where ${t.where.map((c) => `${c} = ${v(params[c] ?? null)}`).join(", ")}`;
    if (t.kind === "orphans") return `orphans ${t.table}(${t.columns.join(", ")}) -> ${t.references.table}(${t.references.columns.join(", ")})`;
    if (t.kind === "duplicates") return `duplicates ${t.table}(${t.columns.join(", ")})${t.fold ? " any case" : ""}`;
    if (t.kind === "relation") return `relation ${t.table}: ${t.expression}`;
    throw new DatabaseCheckRefused("a count is not a check step");
}

/** The test values a check's name uses ({{name}}): plain names only, never sign-in details. */
export function dbCheckVars(name: string): string[] {
    const vars = [...new Set(placeholdersIn(name))];
    for (const v of vars) if (!/^\w+$/.test(v)) throw new DatabaseCheckRefused(`a database check uses plain test values only, not {{${v.slice(0, 40)}}}`);
    return vars;
}

/** The params with the test's values in place of their {{placeholders}}; a value the test did not send refuses the check. */
export function resolveParams(params: DbParams, vars: Record<string, string>): DbParams {
    const out: DbParams = {};
    for (const [c, v] of Object.entries(params)) {
        out[c] =
            typeof v !== "string"
                ? v
                : v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => {
                      if (!Object.prototype.hasOwnProperty.call(vars, n)) throw new DatabaseCheckRefused(`the test sent no value for {{${n}}}`);
                      return vars[n]!;
                  });
    }
    return out;
}

/** Whether a check passes when the test adds no breaking row (all but exists). */
export const isAbsenceCheck = (name: string): boolean => !name.trim().startsWith("exists ");

/** The checks the schema's declared keys give: no orphans along each foreign key, no duplicates along each unique key (case-folded where stated). */
export function integrityChecks(schema: DbSchema): string[] {
    const out: string[] = [];
    for (const t of schema.tables) {
        for (const fk of t.foreignKeys) out.push(dbCheckName({ kind: "orphans", table: t.name, columns: fk.columns, references: fk.references }));
        for (const u of t.uniqueKeys) out.push(dbCheckName({ kind: "duplicates", table: t.name, columns: u.columns, ...(u.ignoreCase ? { fold: true } : {}) }));
    }
    return out;
}

/** Field names whose values are sign-in details: never compared through the database (a stored one is hashed anyway). */
const CREDENTIAL = /pass(word)?|secret|token|otp|pin$|key$/i;
const WRITES = new Set(["POST", "PUT", "PATCH"]);
type Request = Extract<Step, { action: "request" }>;

/** A path's resource that is the signed-in account's own record. */
const SELF = /^(?:me|my|self|profile|account|current-?user)$/i;

/** The table a path's resource is stored in: the one table whose name is that resource (orders, order, order_s...). */
function tableOf(path: string, schema: DbSchema): DbTable | undefined {
    const r = resourceName(path).replace(/[-_]/g, "");
    const hits = schema.tables.filter((t) => resourceName(`/${t.name}`).replace(/[-_]/g, "") === r);
    return hits.length === 1 ? hits[0] : undefined;
}

/** The written fields that are columns: text and numbers only, no sign-in details, no quote (a value is written between quotes). */
function writtenColumns(body: unknown, t: DbTable): DbParams | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const out: DbParams = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (!DB_NAME.test(k) || CREDENTIAL.test(k) || !t.columns.includes(k)) continue;
        if ((typeof v === "string" && !v.includes("'") && v.length <= 500) || (typeof v === "number" && Number.isFinite(v))) out[k] = v as string | number;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * The persistence check after one 2xx write, or none: a create that returned an id → that id is stored in the resource's table; an update
 * → the written fields are stored (in the record its path names, or in the one table that has every written field).
 */
export function persistenceCheck(step: Request, schema: DbSchema): string | undefined {
    if (!WRITES.has(step.method.toUpperCase())) return undefined;
    const pathVar = /\{\{\s*(\w+)\s*\}\}\/?$/.exec(step.path)?.[1];
    if (step.method.toUpperCase() === "POST" && !pathVar) {
        const idVar = Object.entries(step.extract ?? {}).find(([, p]) => p === "id" || /\.id$/.test(p))?.[0];
        const t = tableOf(step.path, schema);
        if (!idVar || !t || t.primaryKey.length !== 1) return undefined;
        return dbCheckName({ kind: "exists", table: t.name, where: [t.primaryKey[0]!] }, { [t.primaryKey[0]!]: `{{${idVar}}}` });
    }
    if (step.method.toUpperCase() === "POST") return undefined;
    if (pathVar) {
        const t = tableOf(step.path.replace(/\/\{\{[^}]*\}\}\/?$/, ""), schema);
        if (!t || t.primaryKey.length !== 1) return undefined;
        const fields = writtenColumns(step.body, t) ?? {};
        const params: DbParams = { [t.primaryKey[0]!]: `{{${pathVar}}}`, ...fields };
        if (Object.keys(params).length < 2) return undefined; // nothing written to compare
        return dbCheckName({ kind: "exists", table: t.name, where: Object.keys(params) }, params);
    }
    // The table of the resource the request wrote (the signed-in account's own record for /me, /profile, /account: its users table),
    // holding every written field; a field it lacks may be stored elsewhere, and another table that happens to hold the field is never
    // guessed (API-159: PATCH /api/me checked in products).
    const t = tableOf(step.path, schema) ?? (SELF.test(resourceName(step.path)) ? (tableOf("/users", schema) ?? tableOf("/accounts", schema)) : undefined);
    const sent = writtenColumns(step.body, { name: "", columns: Object.keys((step.body ?? {}) as object), primaryKey: [], uniqueKeys: [], foreignKeys: [], rowCount: 0 });
    const fields = t && sent && Object.keys(sent).every((k) => t.columns.includes(k)) ? sent : undefined;
    if (!t || !fields) return undefined;
    return dbCheckName({ kind: "exists", table: t.name, where: Object.keys(fields) }, fields);
}

const dbStep = (name: string, description: string, source?: string): Step => ({ action: "assertResponse", check: "dbCheck", name, description, ...(source ? { source } : {}) }) as Step;
const isOk = (s: Step | undefined) => s?.action === "assertResponse" && ((s.check === "statusClass" && String(s.expected) === "2xx") || (s.check === "status" && /^2\d\d$/.test(String(s.expected))));

/**
 * A data-changing test's steps with its database checks: after each 2xx write its persistence check, and right after its last write
 * (before the API assertions on that answer and any read after it) the absence checks (integrity along the declared keys and the C5
 * relations over rows). Placed there, a stored-data defect fails at the database check even when the API check after it would fail too
 * (L8: a documented 409 that was accepted, a read-back that misses a record). `budget.left` is the run's remaining checks (DB_CHECKS_MAX
 * in all).
 * shortcut: every data-changing test gets the same absence checks while the budget lasts; mapping writes to the tables they touch would
 * spread a large schema's checks better.
 */
export function withDatabaseChecks(steps: readonly Step[], schema: DbSchema, absence: ReadonlyArray<{ name: string; source?: string }>, budget: { left: number }): Step[] {
    const lastWrite = steps.findLastIndex((s) => s.action === "request" && (WRITES.has(s.method.toUpperCase()) || s.method.toUpperCase() === "DELETE"));
    const out: Step[] = [];
    let at = -1;
    for (const [i, s] of steps.entries()) {
        out.push(s);
        if (i === lastWrite) at = out.length;
        const prev = steps[i - 1];
        if (prev?.action !== "request" || !isOk(s) || budget.left <= 0) continue;
        const name = persistenceCheck(prev, schema);
        if (name && name.length <= DB_CHECK_NAME_MAX) {
            out.push(dbStep(name, "The write is stored in the database"));
            budget.left--;
        }
    }
    if (at < 0) return out;
    const absent: Step[] = [];
    for (const { name, source } of absence) {
        if (budget.left <= 0) break;
        if (name.length > DB_CHECK_NAME_MAX) continue;
        absent.push(dbStep(name, source ? "The stored rows keep the stated rule" : "The test left no stored row that breaks the database's keys", source));
        budget.left--;
    }
    out.splice(at, 0, ...absent);
    return out;
}

/** The duplicate checks (along a declared unique key) whose columns the test's writes all send: a documented 409's database view. */
export function duplicateChecksOf(steps: readonly Step[], absence: ReadonlyArray<{ name: string; source?: string }>): Array<{ name: string; source?: string }> {
    const sent = new Set(steps.flatMap((s) => (s.action === "request" && WRITES.has(s.method.toUpperCase()) && s.body && typeof s.body === "object" && !Array.isArray(s.body) ? Object.keys(s.body) : [])));
    return absence.filter(({ name }) => {
        const m = RE.duplicates.exec(name.trim());
        return !!m && names(m[2]!).every((c) => sent.has(c));
    });
}

/**
 * The persistence checks of a written web test (C10 after a C4 write): from the answers its actions caused while it was written
 * (web/correlation.ts CapturedCall). Only fields sent with a value the test itself types (a literal fill or select value) are compared, so
 * a replay writes the same value; a create is not checked (its id differs in every run). Each path's last write only, since a later write
 * may change what an earlier one stored. The checks go at the end of the test, after every step that may still be saving.
 */
export function webPersistenceChecks(
    steps: readonly Step[],
    calls: ReadonlyArray<{ step?: number; method: string; path: string; status: number; sent?: Record<string, string | number>; readBack?: boolean }>,
    schema: DbSchema,
    budget: { left: number },
): Step[] {
    const typed = new Set(steps.flatMap((s) => ((s.action === "fill" || s.action === "select") && !s.value.includes("{{") ? [s.value] : [])));
    const last = new Map<string, (typeof calls)[number]>();
    for (const c of calls) if (c.step !== undefined && !c.readBack && WRITES.has(c.method.toUpperCase()) && c.status >= 200 && c.status <= 299) last.set(`${c.method.toUpperCase()} ${c.path.split(/[?#]/)[0]}`, c);
    const out: Step[] = [];
    for (const c of last.values()) {
        if (budget.left <= 0) break;
        const body = Object.fromEntries(Object.entries(c.sent ?? {}).filter(([, v]) => typed.has(String(v))));
        if (!Object.keys(body).length) continue;
        const name = persistenceCheck({ action: "request", method: c.method.toUpperCase(), path: c.path.split(/[?#]/)[0]!, body } as Request, schema);
        if (!name || name.length > DB_CHECK_NAME_MAX || out.some((s) => (s as { name?: string }).name === name)) continue;
        out.push(dbStep(name, "What the page saved is stored in the database"));
        budget.left--;
    }
    return out;
}

/** The script helper (pasted into API and web scripts that have a database check). */
export const DB_CHECK_HELPER_SOURCE = `
/** Database checks (C10): sent by name to this run's database check service; the answer is counts and fingerprints, never row contents. */
type DbCheckAnswer = { kind: string; count: number; examples: string[] };
async function dbCheckRun(name: string, vars: Record<string, string>): Promise<DbCheckAnswer | undefined> {
    const url = process.env.DB_CHECK_URL, token = process.env.DB_CHECK_TOKEN;
    if (!url || !token) return undefined;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: \`Bearer \${token}\` }, body: JSON.stringify({ name, vars }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as Partial<DbCheckAnswer> & { error?: string };
    if (res.status !== 200 || typeof body.count !== "number") throw new Error(\`Database check "\${name}" could not run: \${String(body.error ?? "HTTP " + res.status).slice(0, 300)}\`);
    return body as DbCheckAnswer;
}
/** The counts of the absence checks before the test's first step. */
async function dbBaseline(names: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const n of names) {
        const r = await dbCheckRun(n, {});
        if (r) out[n] = r.count;
    }
    return out;
}
async function dbAssert(name: string, vars: Record<string, string>, before: Record<string, number>, source: string): Promise<void> {
    const r = await dbCheckRun(name, vars);
    if (!r) {
        test.info().annotations.push({ type: "database", description: \`The database check "\${name}" was skipped: this run has no read-only database access.\` });
        return;
    }
    const cite = source ? \` (\${source})\` : "";
    if (r.kind === "exists") {
        if (r.count < 1) throw new Error(\`Database check failed\${cite}: \${name}: no stored row matches what the write sent.\`);
        return;
    }
    const was = before[name] ?? 0;
    if (r.count > was) throw new Error(\`Database check failed\${cite}: \${name}: \${r.count - was} more row(s) break it than before the test (\${was} before, \${r.count} now; masked keys: \${r.examples.join(", ")}).\`);
}
`;
