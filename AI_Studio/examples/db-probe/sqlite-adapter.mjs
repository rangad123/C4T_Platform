/**
 * The probe's node:sqlite adapter (see probe.mjs for the interface). The database file is opened read-only in a worker thread:
 *   - `readOnly: true` and `?mode=ro`, so the connection cannot write;
 *   - an authorizer that allows only SELECT, reads of allow-listed tables and columns, the functions count, probe_fold and probe_same, and BEGIN and
 *     ROLLBACK: anything else (a write, a pragma, an attached database, a table off the list) is denied by SQLite itself;
 *   - every check runs in BEGIN ... ROLLBACK;
 *   - the statement timeout: SQLite has none of its own, so a check that runs too long ends the worker, and a new one is started.
 */
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { ProbeTimeout, sameValue } from "./probe.mjs";

if (!isMainThread && workerData?.dbProbe) serve(workerData);

export function sqliteAdapter(file, allow) {
    const allowed = Object.fromEntries([...allow].map(([t, cols]) => [t, [...cols]]));
    let worker;
    let ready;
    let seq = 0;
    const pending = new Map();
    const start = () => {
        worker = new Worker(new URL(import.meta.url), { workerData: { dbProbe: true, href: `${pathToFileURL(file).href}?mode=ro`, allowed } });
        ready = new Promise((resolve, reject) => {
            worker.once("message", (m) => (m.error ? reject(new Error(m.error)) : resolve(m.tables)));
            worker.once("error", reject);
        });
        worker.on("message", (m) => {
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error) p.reject(new Error(m.error));
            else p.resolve(m.rows);
        });
        worker.on("error", (e) => {
            for (const p of pending.values()) p.reject(e);
            pending.clear();
        });
    };
    start();
    return {
        introspect: () => ready,
        quote: (n) => `"${n}"`,
        fold: (e) => `probe_fold(${e})`,
        same: (e) => `probe_same(${e}, ?) = 1`,
        async read(statements, { timeoutMs }) {
            await ready;
            const id = ++seq;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    const old = worker;
                    start();
                    void old.terminate();
                    reject(new ProbeTimeout());
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                worker.postMessage({ id, statements });
            });
        },
        close: async () => {
            await worker.terminate();
        },
    };
}

/** The worker: introspects once (before the authorizer is set), then answers { id, statements } with { id, rows } or { id, error }. */
async function serve({ href, allowed }) {
    const { DatabaseSync, constants: K } = await import("node:sqlite");
    let db;
    try {
        db = new DatabaseSync(href, { readOnly: true, timeout: 1000 });
        db.function("probe_fold", { deterministic: true }, (v) => (typeof v === "string" ? v.toLowerCase() : v));
        db.function("probe_same", { deterministic: true }, (a, b) => (sameValue(a, b) ? 1 : 0));
        const tables = db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all()
            .map(({ name }) => {
                const cols = db.prepare("SELECT name, pk FROM pragma_table_info(?)").all(name);
                const fks = new Map();
                for (const f of db.prepare("SELECT id, \"from\" AS c, \"table\" AS t, \"to\" AS r FROM pragma_foreign_key_list(?) ORDER BY id, seq").all(name)) {
                    const k = fks.get(f.id) ?? { columns: [], references: { table: f.t, columns: [] } };
                    k.columns.push(f.c);
                    k.references.columns.push(f.r ?? "");
                    fks.set(f.id, k);
                }
                const uniqueKeys = db
                    .prepare("SELECT name FROM pragma_index_list(?) WHERE \"unique\" = 1 AND origin != 'pk'")
                    .all(name)
                    .map((i) => ({ columns: db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(i.name).map((c) => c.name) }))
                    .filter((u) => u.columns.every((c) => typeof c === "string"));
                return {
                    name,
                    columns: cols.map((c) => c.name),
                    primaryKey: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
                    uniqueKeys,
                    foreignKeys: [...fks.values()].filter((f) => f.references.columns.every(Boolean)),
                };
            });
        const ok = new Map(Object.entries(allowed).map(([t, cols]) => [t, new Set(cols)]));
        db.setAuthorizer((action, a, b) => {
            if (action === K.SQLITE_SELECT) return K.SQLITE_OK;
            if (action === K.SQLITE_READ) return ok.has(a) && (b === "" || b === null || ok.get(a).has(b)) ? K.SQLITE_OK : K.SQLITE_DENY;
            if (action === K.SQLITE_FUNCTION) return b === "count" || b === "probe_fold" || b === "probe_same" ? K.SQLITE_OK : K.SQLITE_DENY;
            if (action === K.SQLITE_TRANSACTION) return a === "BEGIN" || a === "ROLLBACK" ? K.SQLITE_OK : K.SQLITE_DENY;
            return K.SQLITE_DENY;
        });
        parentPort.postMessage({ tables });
    } catch (e) {
        parentPort.postMessage({ error: `the database could not be opened read-only (${e instanceof Error ? e.message : String(e)})` });
        return;
    }
    parentPort.on("message", ({ id, statements }) => {
        try {
            db.exec("BEGIN");
            try {
                parentPort.postMessage({ id, rows: statements.map((s) => db.prepare(s.sql).all(...s.params)) });
            } finally {
                db.exec("ROLLBACK");
            }
        } catch (e) {
            parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
        }
    });
}
