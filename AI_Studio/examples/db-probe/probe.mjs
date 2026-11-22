/**
 * The database probe (reference, Phase 4 D-c): a small service a customer runs next to their own database, with their own read-only
 * database user, so that AI Studio can check stored data without ever holding database credentials. Guide: docs/features/database-checks.md.
 *
 *   GET  /schema  → { tables: [{ name, columns, primaryKey, uniqueKeys, foreignKeys, rowCount }] }   allow-listed names and counts only
 *   POST /check   { template, params } → { kind, table, count, ids, examples }                       counts, fingerprints, masked keys
 *
 * A check is one of four fixed read templates, named by table and column names only; values travel apart in `params` and are only bound:
 *   exists     { kind, table, where: [columns] }                    rows whose `where` columns equal the params
 *   count      { kind, table, where: [columns] }                    the same, counted ([] counts the table)
 *   orphans    { kind, table, columns, references: { table, columns } }   rows pointing at no row of the referenced table
 *   duplicates { kind, table, columns, fold? }                      values held by more than one row (fold: case-folded)
 * Refused, with HTTP 400 and the rule: any other kind (writes included), any extra field (a `sql` text, say), a table or column outside
 * the allow-list, params that are not exactly the `where` columns. Also refused: a table above the row cap (413), a check slower than the
 * statement timeout (504), more requests than the rate limit (429), a wrong token (401). Every request is written to the audit log
 * without its values.
 *
 * A result never holds row contents: `ids` are HMAC-SHA256 fingerprints of the matching rows' keys under a key this process makes at
 * start (compare them within one probe run only), `examples` say how long each key is ("•••••• (8 characters)"), at most 20 of each.
 *
 * The adapter interface (sqlite-adapter.mjs implements it with node:sqlite; a Postgres or MySQL adapter uses the customer's driver):
 *   introspect(): Promise<Array<{ name, columns: string[], primaryKey: string[], uniqueKeys: [{ columns }], foreignKeys: [{ columns, references: { table, columns } }] }>>
 *   quote(name): string                    an identifier quoted for the dialect ("x" in SQLite and Postgres, `x` in MySQL)
 *   fold(sqlExpression): string            the case-folding expression (lower(...) in Postgres and MySQL)
 *   same(sqlExpression): string            a condition with one `?` that holds when the stored value is the sent one as sameValue below
 *                                          says (SQLite: a function; Postgres and MySQL: trim, lower for e-mail addresses, a timestamp cast)
 *   read(statements, { timeoutMs }): Promise<rows[][]>   [{ sql, params }] with `?` placeholders, run in ONE read-only transaction
 *                                          (Postgres: BEGIN READ ONLY; SET LOCAL statement_timeout; ...; ROLLBACK. MySQL: START TRANSACTION
 *                                          READ ONLY with MAX_EXECUTION_TIME). Rejects with ProbeTimeout past the timeout.
 *   close(): Promise<void>
 * The statements this file builds hold no string literal, so a Postgres adapter may number the `?` placeholders as $1, $2, ... in order.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const KEYS_MAX = 20;
export const DEFAULTS = { rowCap: 100_000, timeoutMs: 5_000, perMinute: 120, bodyMax: 16 * 1024 };

export class ProbeTimeout extends Error {}
class Refused extends Error {
    constructor(status, reason) {
        super(reason);
        this.status = status;
    }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (o, required, optional = []) => {
    const keys = Object.keys(o);
    return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
};

/** The allow-list ({ table: [columns] }) as a Map, keeping plain names only; a probe without one serves nothing. */
export function parseAllow(raw) {
    if (!isObj(raw)) throw new Error("the allow-list is a JSON object of table names to column lists");
    const out = new Map();
    for (const [t, cols] of Object.entries(raw)) {
        if (!NAME.test(t) || !Array.isArray(cols) || !cols.every((c) => typeof c === "string" && NAME.test(c))) throw new Error(`the allow-list entry ${JSON.stringify(t.slice(0, 60))} is not a table name with a list of column names`);
        out.set(t, new Set(cols));
    }
    return out;
}

/** The schema the adapter found, cut to the allow-list: a key or a foreign key is kept only when every column it names is allowed. */
export function allowedSchema(found, allow) {
    const has = (t, cols) => allow.has(t) && cols.every((c) => allow.get(t).has(c));
    return found
        .filter((t) => allow.has(t.name))
        .map((t) => {
            const columns = t.columns.filter((c) => allow.get(t.name).has(c));
            return {
                name: t.name,
                columns,
                primaryKey: t.primaryKey.length && has(t.name, t.primaryKey) ? t.primaryKey : [],
                uniqueKeys: t.uniqueKeys.filter((u) => has(t.name, u.columns)).map((u) => ({ columns: u.columns })),
                foreignKeys: t.foreignKeys.filter((f) => has(t.name, f.columns) && has(f.references.table, f.references.columns)),
            };
        });
}

/** Checks a request body against the four templates and the schema; returns the template and its params, or throws Refused (400). */
export function validate(body, schema) {
    const no = (reason) => new Refused(400, reason);
    if (!isObj(body) || !exactKeys(body, ["template"], ["params"])) throw no("a check is { template, params } and nothing else; SQL text is never accepted");
    const t = body.template;
    if (!isObj(t) || typeof t.kind !== "string") throw no("the template has no kind");
    const shapes = { exists: [["kind", "table", "where"]], count: [["kind", "table", "where"]], orphans: [["kind", "table", "columns", "references"]], duplicates: [["kind", "table", "columns"], ["fold"]] };
    if (t.kind === "relation") throw no("relation checks are not run by this probe");
    if (!shapes[t.kind]) throw no("only the read checks exists, count, orphans and duplicates are run");
    if (!exactKeys(t, ...shapes[t.kind])) throw no(`a ${t.kind} check has the fields ${shapes[t.kind].flat().join(", ")} only`);
    const byName = new Map(schema.map((x) => [x.name, x]));
    const table = (name) => {
        if (typeof name !== "string" || !byName.has(name)) throw no(`the table ${JSON.stringify(String(name).slice(0, 60))} is not on the probe's allow-list`);
        return byName.get(name);
    };
    const columns = (x, cols, min) => {
        if (!Array.isArray(cols) || cols.length < min || cols.length > 8) throw no(`a column list has ${min} to 8 names`);
        for (const c of cols) if (typeof c !== "string" || !x.columns.includes(c)) throw no(`the column ${JSON.stringify(String(c).slice(0, 60))} of ${x.name} is not on the probe's allow-list`);
        if (new Set(cols).size !== cols.length) throw no("a column is named twice");
        return cols;
    };
    const x = table(t.table);
    const params = body.params ?? {};
    if (!isObj(params)) throw no("params is an object of where columns to values");
    if (t.kind === "exists" || t.kind === "count") {
        columns(x, t.where, t.kind === "exists" ? 1 : 0);
        if (Object.keys(params).length !== t.where.length || !t.where.every((c) => Object.prototype.hasOwnProperty.call(params, c))) throw no("the params must be exactly the where columns");
        for (const v of Object.values(params)) if (!(v === null || (typeof v === "string" && v.length <= 2000) || (typeof v === "number" && Number.isFinite(v)))) throw no("a param is text, a number or null");
        return { kind: t.kind, table: x, where: t.where, params };
    }
    if (Object.keys(params).length) throw no(`${t.kind} takes no params`);
    columns(x, t.columns, 1);
    if (t.kind === "duplicates") {
        if (t.fold !== undefined && typeof t.fold !== "boolean") throw no("fold is true or false");
        return { kind: "duplicates", table: x, columns: t.columns, fold: t.fold === true };
    }
    if (!isObj(t.references) || !exactKeys(t.references, ["table", "columns"])) throw no("references is { table, columns }");
    const parent = table(t.references.table);
    columns(parent, t.references.columns, 1);
    if (t.references.columns.length !== t.columns.length) throw no("orphans names as many columns as the referenced key has");
    return { kind: "orphans", table: x, columns: t.columns, parent, parentColumns: t.references.columns };
}

/**
 * Whether a stored value is the value a test sent: text trimmed, an e-mail address on either side case-folded, two dates equal at the same
 * instant (or the same day when either is a date alone). Nothing else: other text keeps its case, a number is not its text. The engine's
 * own back ends use the same rule (src/engine/database/same-value.ts).
 */
export function sameValue(stored, sent) {
    if (typeof stored !== "string" || typeof sent !== "string") return stored === sent;
    const a = stored.trim();
    const b = sent.trim();
    if (a === b) return true;
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.test(a) || email.test(b)) return a.toLowerCase() === b.toLowerCase();
    const dateOf = (s) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? undefined : { day: s };
        if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return undefined;
        const ms = Date.parse(s.replace(" ", "T"));
        return Number.isNaN(ms) ? undefined : { day: new Date(ms).toISOString().slice(0, 10), ms };
    };
    const da = dateOf(a);
    const db = dateOf(b);
    if (!da || !db) return false;
    return da.ms !== undefined && db.ms !== undefined ? da.ms === db.ms : da.day === db.day;
}

/** The statements of a validated check: [the count, the keys of at most 20 matching rows]. Names are quoted from the schema, values bound. */
export function plan(c, adapter) {
    const q = (n) => {
        if (!NAME.test(n)) throw new Error("not a plain name"); // the last guard: the schema holds plain names only
        return adapter.quote(n);
    };
    const T = `${q(c.table.name)} AS x`;
    if (c.kind === "duplicates") {
        const cols = c.columns.map((n) => (c.fold ? adapter.fold(`x.${q(n)}`) : `x.${q(n)}`));
        const groups = `(SELECT ${cols.map((e, i) => `${e} AS k${i}`).join(", ")} FROM ${T} WHERE ${c.columns.map((n) => `x.${q(n)} IS NOT NULL`).join(" AND ")} GROUP BY ${cols.join(", ")} HAVING COUNT(*) > 1) AS g`;
        return { key: c.columns.map((_, i) => `k${i}`), statements: [{ sql: `SELECT COUNT(*) AS n FROM ${groups}`, params: [] }, { sql: `SELECT * FROM ${groups} LIMIT ${KEYS_MAX}`, params: [] }] };
    }
    const key = c.table.primaryKey.length ? c.table.primaryKey : c.kind === "orphans" ? c.columns : c.where.length ? c.where : c.table.columns;
    const where = [];
    const params = [];
    if (c.kind === "orphans") {
        const join = c.columns.map((n, i) => `p.${q(c.parentColumns[i])} = x.${q(n)}`).join(" AND ");
        where.push(...c.columns.map((n) => `x.${q(n)} IS NOT NULL`), `NOT EXISTS (SELECT 1 FROM ${q(c.parent.name)} AS p WHERE ${join})`);
    } else
        for (const n of c.where) {
            if (c.params[n] === null) where.push(`x.${q(n)} IS NULL`);
            else {
                where.push(adapter.same(`x.${q(n)}`));
                params.push(c.params[n]);
            }
        }
    const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    return {
        key,
        statements: [
            { sql: `SELECT COUNT(*) AS n FROM ${T}${cond}`, params },
            { sql: `SELECT ${key.map((n) => `x.${q(n)} AS ${q(n)}`).join(", ")} FROM ${T}${cond} LIMIT ${KEYS_MAX}`, params },
        ],
    };
}

const mask = (v) => `${"•".repeat(Math.min(6, Math.max(1, v.length)))} (${v.length} characters)`;

/**
 * The probe's request handler (node:http or node:https). `allow` is parseAllow's Map; `audit(entry)` receives one object per request
 * (time, address, endpoint, kind, table, status, count or reason; never a param value or a row value).
 */
export function createProbe({ adapter, token, allow, rowCap = DEFAULTS.rowCap, timeoutMs = DEFAULTS.timeoutMs, perMinute = DEFAULTS.perMinute, audit = () => {}, now = Date.now }) {
    if (typeof token !== "string" || token.length < 24) throw new Error("the probe token has at least 24 characters");
    const want = Buffer.from(`Bearer ${token}`);
    const hashKey = randomBytes(32);
    let schemaOnce;
    const schema = () => (schemaOnce ??= adapter.introspect().then((found) => allowedSchema(found, allow)));
    // A sliding minute: the times of the requests answered in the last 60 seconds (at most perMinute of them).
    const recent = [];
    const read = async (statements) => {
        try {
            return await adapter.read(statements, { timeoutMs });
        } catch (e) {
            if (e instanceof ProbeTimeout) throw new Refused(504, `the check took longer than the statement timeout (${timeoutMs} ms)`);
            throw e;
        }
    };
    const rowsOf = async (names) => (await read(names.map((n) => ({ sql: `SELECT COUNT(*) AS n FROM ${adapter.quote(n)}`, params: [] })))).map((r) => Number(r[0].n));

    return async function handle(req, res) {
        const entry = { at: new Date(now()).toISOString(), from: req.socket?.remoteAddress ?? "", endpoint: `${req.method} ${String(req.url).slice(0, 80)}` };
        const send = (status, body, more = {}) => {
            audit({ ...entry, status, ...more });
            res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(body));
        };
        try {
            const got = Buffer.from(req.headers.authorization ?? "");
            if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Refused(401, "not authorised");
            const at = now();
            while (recent.length && at - recent[0] >= 60_000) recent.shift();
            if (recent.length >= perMinute) throw new Refused(429, `more than ${perMinute} requests in a minute`);
            recent.push(at);
            if (req.method === "GET" && req.url === "/schema") {
                const s = await schema();
                const counts = await rowsOf(s.map((t) => t.name));
                return send(200, { tables: s.map((t, i) => ({ ...t, rowCount: counts[i] })) });
            }
            if (req.method !== "POST" || req.url !== "/check") throw new Refused(404, "GET /schema and POST /check only");
            const chunks = [];
            let size = 0;
            for await (const c of req) {
                size += c.length;
                if (size > DEFAULTS.bodyMax) throw new Refused(413, `a check is at most ${DEFAULTS.bodyMax} bytes`);
                chunks.push(c);
            }
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                throw new Refused(400, "the body is not JSON");
            }
            const c = validate(body, await schema());
            Object.assign(entry, { kind: c.kind, table: c.table.name });
            const sizes = await rowsOf([c.table.name, ...(c.parent ? [c.parent.name] : [])]);
            if (sizes.some((n) => n > rowCap)) throw new Refused(413, `the table has more rows than the probe's row cap (${rowCap})`);
            const p = plan(c, adapter);
            const [countRows, keyRows] = await read(p.statements);
            const keys = keyRows.slice(0, KEYS_MAX).map((r) => p.key.map((k) => (r[k] === null || r[k] === undefined ? "" : String(r[k]))));
            const count = Number(countRows[0].n);
            return send(200, { kind: c.kind, table: c.table.name, count, ids: keys.map((k) => createHmac("sha256", hashKey).update(JSON.stringify(k)).digest("hex").slice(0, 32)), examples: keys.map((k) => mask(k.join(" | ") || "-")) }, { count });
        } catch (e) {
            if (e instanceof Refused) return send(e.status, { error: e.message }, { reason: e.message });
            // The database's own message can name values: the caller gets one neutral line, the audit log the error's class.
            return send(502, { error: "the database could not be read" }, { reason: e instanceof Error ? e.name : "error" });
        }
    };
}
