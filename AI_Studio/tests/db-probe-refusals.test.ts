/**
 * Phase 4 T22a: the reference database probe (examples/db-probe) refuses everything on its fixed refusal list: writes, raw SQL, tables
 * and columns off the allow-list, oversized results and slow queries (and a wrong token, too many requests). Every case must be refused,
 * the database must be unchanged afterwards, and nothing returned or audited may hold a row value. The allowed checks answer counts,
 * fingerprints and masked keys only. Below the probe's own checks, SQLite's authorizer and the read-only connection refuse writes and
 * unlisted reads too.
 *
 * The probe runs as its CLI (server.mjs) over a local SQLite file shaped like the practice store (tests/fixtures/practice-store-db.ts).
 * Ports 9881-9885. No browser.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePracticeStoreDb, PRACTICE_ALLOW, PRIVATE_VALUES } from "./fixtures/practice-store-db.js";

const SERVER = path.resolve("examples/db-probe/server.mjs");
const TOKEN = "probe-test-token-0123456789abcdef";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-probe-refusals-"));
const db = path.join(dir, "store.db");
const bigDb = path.join(dir, "big.db");
const children: ChildProcess[] = [];
const audits: string[] = [];

async function startProbe(port: number, file: string, extra: string[] = []): Promise<string> {
    const audit = path.join(dir, `audit-${port}.log`);
    audits.push(audit);
    const child = spawn(process.execPath, [SERVER, "--sqlite", file, "--token-file", path.join(dir, "token"), "--allow", path.join(dir, "allow.json"), "--port", String(port), "--audit", audit, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (b: Buffer) => /listening/.test(String(b)) && resolve());
        child.stderr!.on("data", (b: Buffer) => reject(new Error(String(b))));
        child.once("exit", (c) => reject(new Error(`probe exited ${c}`)));
    });
    return `http://127.0.0.1:${port}`;
}

let main: string;
let slow: string;
let capped: string;
let limited: string;
const call = async (base: string, method: string, p: string, body?: unknown, token = TOKEN) => {
    const res = await fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
    makePracticeStoreDb(db);
    makePracticeStoreDb(bigDb, 300_000);
    fs.writeFileSync(path.join(dir, "token"), `${TOKEN}\n`);
    fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify(PRACTICE_ALLOW));
    [main, slow, capped, limited] = await Promise.all([
        startProbe(9881, db),
        startProbe(9882, bigDb, ["--timeout-ms", "30", "--row-cap", "1000000"]),
        startProbe(9883, db, ["--row-cap", "3"]),
        startProbe(9884, db, ["--per-minute", "3"]),
    ]);
}, 60_000);

afterAll(() => {
    for (const c of children) c.kill();
    fs.rmSync(dir, { recursive: true, force: true });
});

const check = (template: Record<string, unknown>, params?: Record<string, unknown>) => ({ template, ...(params ? { params } : {}) });

/** The fixed refusal list: [what, probe, body, status]. Every entry must be refused, 100%. */
const REFUSALS: Array<[string, () => string, unknown, number]> = [
    ["write: insert", () => main, check({ kind: "insert", table: "users", columns: ["email"] }), 400],
    ["write: update", () => main, check({ kind: "update", table: "orders", where: ["id"] }, { id: 1001 }), 400],
    ["write: delete", () => main, check({ kind: "delete", table: "orders", where: ["id"] }, { id: 1001 }), 400],
    ["raw SQL instead of a template", () => main, { sql: "DELETE FROM users" }, 400],
    ["raw SQL beside a template", () => main, { ...check({ kind: "count", table: "users", where: [] }), sql: "DROP TABLE users" }, 400],
    ["raw SQL inside a template", () => main, check({ kind: "count", table: "users", where: [], sql: "DROP TABLE users" }), 400],
    ["SQL in a table name", () => main, check({ kind: "count", table: "users; DROP TABLE users", where: [] }), 400],
    ["SQL in a column name", () => main, check({ kind: "exists", table: "users", where: ["id) OR 1=1 --"] }, { "id) OR 1=1 --": 1 }), 400],
    ["an object as a value", () => main, check({ kind: "exists", table: "users", where: ["email"] }, { email: { $gt: "" } }), 400],
    ["params beyond the where columns", () => main, check({ kind: "exists", table: "users", where: ["id"] }, { id: 1, role: "admin" }), 400],
    ["unlisted table", () => main, check({ kind: "count", table: "sessions", where: [] }), 400],
    ["unlisted column in a where", () => main, check({ kind: "exists", table: "users", where: ["password_hash"] }, { password_hash: "x" }), 400],
    ["unlisted column in a key check", () => main, check({ kind: "duplicates", table: "users", columns: ["password_hash"] }), 400],
    ["unlisted referenced table", () => main, check({ kind: "orphans", table: "orders", columns: ["user_id"], references: { table: "sessions", columns: ["user_id"] } }), 400],
    ["sqlite's own tables", () => main, check({ kind: "count", table: "sqlite_schema", where: [] }), 400],
    ["a relation over rows", () => main, check({ kind: "relation", table: "orders", where: [], expression: "total == subtotal" }), 400],
    ["oversized request", () => main, check({ kind: "exists", table: "users", where: ["email"] }, { email: "x".repeat(20_000) }), 413],
    ["oversized result: a table above the row cap", () => capped, check({ kind: "count", table: "order_lines", where: [] }), 413],
    ["slow query: past the statement timeout", () => slow, check({ kind: "duplicates", table: "products", columns: ["name"], fold: true }), 504],
    ["not JSON", () => main, "{ not json", 400],
];

describe("the probe's refusal list", () => {
    it("refuses every entry, 100%, and the database is unchanged", async () => {
        const got: Array<[string, number]> = [];
        for (const [what, base, body, status] of REFUSALS) {
            const r = await call(base(), "POST", "/check", body);
            got.push([what, r.status]);
            expect(r.text, what).toMatch(/"error"/);
            for (const v of PRIVATE_VALUES) expect(r.text, what).not.toContain(v);
            void status;
        }
        expect(got).toEqual(REFUSALS.map(([what, , , status]) => [what, status]));
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
        const d = new DatabaseSync(db, { readOnly: true });
        expect(d.prepare("SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM orders) AS o, (SELECT COUNT(*) FROM sessions) AS s").get()).toEqual({ u: 2, o: 2, s: 1 });
        d.close();
    }, 60_000);

    it("refuses a wrong token and more requests than the rate limit", async () => {
        expect((await call(main, "GET", "/schema", undefined, "wrong-token-wrong-token-000000")).status).toBe(401);
        expect((await call(main, "POST", "/check", check({ kind: "count", table: "users", where: [] }), "")).status).toBe(401);
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push((await call(limited, "GET", "/schema")).status);
        expect(statuses).toEqual([200, 200, 200, 429, 429]);
        expect((await call(main, "DELETE", "/check")).status).toBe(404);
    });
});

describe("what the probe answers", () => {
    it("serves the allow-listed schema only: no unlisted table or column", async () => {
        const r = await call(main, "GET", "/schema");
        expect(r.status).toBe(200);
        const s = JSON.parse(r.text) as { tables: Array<{ name: string; columns: string[]; primaryKey: string[]; foreignKeys: unknown[]; rowCount: number }> };
        expect(s.tables.map((t) => t.name).sort()).toEqual(["order_lines", "orders", "products", "users"]);
        expect(s.tables.find((t) => t.name === "users")!.columns).toEqual(["id", "email", "name", "role"]);
        const fks = s.tables.find((t) => t.name === "order_lines")!.foreignKeys;
        expect(fks).toHaveLength(2);
        expect(fks).toEqual(expect.arrayContaining([{ columns: ["order_id"], references: { table: "orders", columns: ["id"] } }, { columns: ["product_id"], references: { table: "products", columns: ["id"] } }]));
        expect(s.tables.find((t) => t.name === "users")!.rowCount).toBe(2);
        expect(r.text).not.toMatch(/sessions|password_hash/);
    });

    it("answers a check with a count, fingerprints and masked keys, never a row value", async () => {
        const orphans = JSON.parse((await call(main, "POST", "/check", check({ kind: "orphans", table: "order_lines", columns: ["product_id"], references: { table: "products", columns: ["id"] } }))).text);
        expect(orphans).toMatchObject({ kind: "orphans", table: "order_lines", count: 1 });
        expect(orphans.ids).toHaveLength(1);
        expect(orphans.ids[0]).toMatch(/^[0-9a-f]{32}$/);
        expect(orphans.examples).toEqual(["• (1 characters)"]);
        const user = await call(main, "POST", "/check", check({ kind: "exists", table: "users", where: ["email"] }, { email: "user@practice.test" }));
        expect(JSON.parse(user.text)).toMatchObject({ kind: "exists", count: 1 });
        expect((await call(main, "POST", "/check", check({ kind: "duplicates", table: "users", columns: ["email"], fold: true }))).text).toMatch(/"count":0/);
        for (const v of PRIVATE_VALUES) expect(user.text).not.toContain(v);
        // The audit log names the check and its result, never a value it was given.
        const log = audits.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("");
        expect(log).toMatch(/"kind":"exists","table":"users","status":200,"count":1/);
        for (const v of PRIVATE_VALUES) expect(log).not.toContain(v);
        expect(log).not.toContain(TOKEN);
    });

    it("is still answering after a slow check ended its worker", async () => {
        const r = await call(slow, "POST", "/check", check({ kind: "count", table: "users", where: [] }));
        // A fresh worker: either it answers in time, or it is refused as slow again; it never hangs or fails otherwise.
        expect([200, 504]).toContain(r.status);
    });
});

describe("below the probe: the read-only connection and SQLite's authorizer", () => {
    it("refuse a write, a pragma and an unlisted read even if a statement got past the probe's checks", async () => {
        const mod = (await import(pathToFileURL(path.resolve("examples/db-probe/sqlite-adapter.mjs")).href)) as {
            sqliteAdapter: (file: string, allow: Map<string, Set<string>>) => { read(s: Array<{ sql: string; params: unknown[] }>, o: { timeoutMs: number }): Promise<unknown[][]>; close(): Promise<void> };
        };
        const adapter = mod.sqliteAdapter(db, new Map(Object.entries(PRACTICE_ALLOW).map(([t, c]) => [t, new Set(c)])));
        const tryRead = (sql: string) => adapter.read([{ sql, params: [] }], { timeoutMs: 5000 }).then(() => "ran", (e: Error) => e.message);
        try {
            expect(await tryRead("SELECT COUNT(*) AS n FROM users")).toBe("ran");
            for (const sql of ["DELETE FROM users", "UPDATE orders SET total = 0", "INSERT INTO users (id, email, name, role, password_hash) VALUES (9, 'a', 'b', 'c', 'd')", "DROP TABLE orders", "SELECT password_hash FROM users", "SELECT * FROM sessions", "PRAGMA writable_schema = 1", "ATTACH DATABASE ':memory:' AS x", "SELECT load_extension('x')"])
                expect(await tryRead(sql), sql).toMatch(/not authorized|readonly|read-only|prohibited|denied/i);
        } finally {
            await adapter.close();
        }
    });
});

describe("serving over HTTPS", () => {
    const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
    it.runIf(hasOpenssl)("serves with --cert and --key, and refuses a public address without them", async () => {
        const key = path.join(dir, "key.pem");
        const cert = path.join(dir, "cert.pem");
        expect(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"]).status).toBe(0);
        await startProbe(9885, db, ["--cert", cert, "--key", key]);
        const body = await new Promise<string>((resolve, reject) => {
            https.get("https://127.0.0.1:9885/schema", { ca: fs.readFileSync(cert), headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
                let t = "";
                res.on("data", (c) => (t += c));
                res.on("end", () => resolve(t));
            }).on("error", reject);
        });
        expect(JSON.parse(body).tables).toHaveLength(4);
        const refused = spawnSync(process.execPath, [SERVER, "--sqlite", db, "--token-file", path.join(dir, "token"), "--allow", path.join(dir, "allow.json"), "--host", "0.0.0.0", "--port", "9886"], { encoding: "utf8", timeout: 10_000 });
        expect(refused.status).toBe(2);
        expect(refused.stderr).toMatch(/loopback address only/);
    }, 30_000);
});
