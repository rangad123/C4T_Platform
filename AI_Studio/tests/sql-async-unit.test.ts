/**
 * The asynchronous `Sql` interface on SQLite (sql.ts, POSTGRES_S3_MIGRATION.md §3.2): the same answers as `Db`, today's
 * atomicity for a `tx` body that awaits only its handle, and the rule that catches a body yielding to the event loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { Db } from "../src/platform/db.js";
import { sqliteSql, SqlTxRuleError } from "../src/platform/sql.js";
import { recordMetrics, projectSlowest, testHistory } from "../src/platform/perf-store.js";

const open: Db[] = [];
function fresh(): Db {
    const db = new Db(":memory:");
    db.raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, n INTEGER NOT NULL DEFAULT 0)");
    open.push(db);
    return db;
}
const names = (db: Db) => db.all<{ name: string }>("SELECT name FROM t ORDER BY id").map((r) => r.name);

afterEach(() => {
    vi.restoreAllMocks();
    for (const db of open.splice(0)) db.close();
});

describe("Sql on SQLite", () => {
    it("answers exactly as Db does for the same statements", async () => {
        const db = fresh();
        const sql = db.sql;
        expect(sql).toBe(sqliteSql(db)); // one adapter per connection
        expect(sql.dialect).toBe(db.dialect);
        expect(await sql.run("INSERT INTO t (name, n) VALUES (?, ?), (?, ?)", "a", 1, "b", 2)).toEqual({ changes: 2 });
        expect(await sql.get("SELECT * FROM t WHERE name = ?", "a")).toEqual(db.get("SELECT * FROM t WHERE name = ?", "a"));
        expect(await sql.get("SELECT * FROM t WHERE name = ?", "zzz")).toBeUndefined();
        expect(await sql.all("SELECT * FROM t ORDER BY id")).toEqual(db.all("SELECT * FROM t ORDER BY id"));
        // RETURNING, not a last insert id.
        expect(await sql.get<{ id: number }>("INSERT INTO t (name) VALUES (?) RETURNING id", "c")).toEqual({ id: 3 });
        expect(await sql.run("UPDATE t SET n = n + 1")).toEqual({ changes: 3 });
        await expect(sql.run("INSERT INTO t (name) VALUES (?)", "a")).rejects.toThrow(/UNIQUE/);
    });

    it("a body that awaits only its handle is atomic: a timer's write lands after it, never in the middle", async () => {
        const db = fresh();
        const sql = db.sql;
        let timers: Promise<unknown>[] = [];
        const seenInside: string[][] = [];
        await sql.tx(async (t) => {
            // Macrotasks that try to write as soon as anything lets them run.
            timers = [new Promise((r) => setTimeout(() => void sql.run("INSERT INTO t (name) VALUES ('timer')").then(r), 0)), new Promise((r) => setImmediate(() => void sql.run("INSERT INTO t (name) VALUES ('immediate')").then(r)))];
            for (let i = 0; i < 200; i++) {
                await t.run("INSERT INTO t (name) VALUES (?)", `tx${i}`);
                if (i % 50 === 0) seenInside.push((await t.all<{ name: string }>("SELECT name FROM t")).map((r) => r.name));
            }
        });
        await Promise.all(timers);
        expect(seenInside.flat()).not.toContain("timer");
        const all = names(db);
        expect(all).toHaveLength(202);
        expect(all.slice(0, 200)).toEqual(Array.from({ length: 200 }, (_, i) => `tx${i}`));
        expect(all.slice(200).sort()).toEqual(["immediate", "timer"]);
    });

    it("a sibling's synchronous db.tx never meets an open transaction (the overlap with unconverted stores)", async () => {
        const db = fresh();
        const sql = db.sql;
        // Concurrent jobs: each continuation runs a synchronous store call right after its asynchronous one, as a real validation run did.
        const job = async (j: number) => {
            for (let i = 0; i < 25; i++) {
                await sql.tx(async (t) => {
                    await t.run("INSERT INTO t (name) VALUES (?)", `a${j}.${i}`);
                    await t.run("INSERT INTO t (name) VALUES (?)", `b${j}.${i}`);
                });
                db.tx(() => db.run("INSERT INTO t (name) VALUES (?)", `sync${j}.${i}`));
                await Promise.resolve();
            }
        };
        await Promise.all([job(0), job(1), job(2), job(3)]);
        expect(names(db)).toHaveLength(4 * 25 * 3);
        // Continuations already queued when the transaction is asked for: they run first, not between the body's awaits.
        const queued = [1, 2, 3, 4, 5, 6].map(async (n) => {
            for (let i = 0; i < n; i++) await null;
            db.tx(() => db.run("INSERT INTO t (name) VALUES (?)", `queued${n}`));
        });
        await sql.tx(async (t) => {
            for (let i = 0; i < 4; i++) await t.run("INSERT INTO t (name) VALUES (?)", `body${i}`);
        });
        await Promise.all(queued);
        expect(names(db).slice(-10, -4)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `queued${n}`));
    });

    it("work started beside a transaction never lands inside it, even when a body broke the rule", async () => {
        const db = fresh();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const sql = sqliteSql(db, { strict: false }); // production: the slow body keeps running, so its transaction stays open across ticks
        let sibling: Promise<unknown> | undefined;
        let second: Promise<unknown> | undefined;
        const first = sql.tx(async (t) => {
            await t.run("INSERT INTO t (name) VALUES ('first-1')");
            await sleep(5);
            await t.run("INSERT INTO t (name) VALUES ('first-2')");
            throw new Error("undo first");
        });
        // Started while the first body waits: these requests come from outside it.
        await sleep(1);
        sibling = sql.run("INSERT INTO t (name) VALUES ('sibling')");
        second = sql.tx(async (t) => {
            await t.run("INSERT INTO t (name) VALUES ('second')");
        });
        await expect(first).rejects.toThrow("undo first");
        await Promise.all([sibling, second]);
        // The sibling's write survived the first transaction's rollback, and the second transaction ran after it.
        expect(names(db)).toEqual(["sibling", "second"]);
    });

    it("a throw rolls back every statement of the body, and the error reaches the caller", async () => {
        const db = fresh();
        db.run("INSERT INTO t (name) VALUES ('kept')");
        await expect(
            db.sql.tx(async (t) => {
                await t.run("INSERT INTO t (name) VALUES ('gone')");
                await t.run("UPDATE t SET n = 9");
                await t.run("INSERT INTO t (name) VALUES ('kept')"); // unique violation
            }),
        ).rejects.toThrow(/UNIQUE/);
        expect(db.all("SELECT name, n FROM t")).toEqual([{ name: "kept", n: 0 }]);
        // The connection is usable afterwards, by both interfaces.
        expect(await db.sql.tx(async (t) => (await t.run("INSERT INTO t (name) VALUES ('after')")).changes)).toBe(1);
        expect(db.tx(() => db.run("INSERT INTO t (name) VALUES ('sync')").changes)).toBe(1);
        expect(names(db)).toEqual(["kept", "after", "sync"]);
    });

    it("returns the body's value and commits", async () => {
        const db = fresh();
        const id = await db.sql.tx(async (t) => (await t.get<{ id: number }>("INSERT INTO t (name) VALUES ('x') RETURNING id"))!.id);
        expect(id).toBe(1);
        expect(names(db)).toEqual(["x"]);
    });

    it("transactions do not nest, as with Db.tx: the inner call rejects and the outer rolls back", async () => {
        const db = fresh();
        expect(() => db.tx(() => db.tx(() => 1))).toThrow();
        await expect(
            db.sql.tx(async (t) => {
                await t.run("INSERT INTO t (name) VALUES ('outer')");
                await t.tx(async () => undefined);
            }),
        ).rejects.toThrow(/do not nest/);
        // The outer Sql's tx from inside a body is refused too.
        await expect(
            db.sql.tx(async (t) => {
                await t.run("INSERT INTO t (name) VALUES ('outer')");
                await db.sql.tx(async () => undefined);
            }),
        ).rejects.toThrow(/do not nest/);
        expect(names(db)).toEqual([]);
    });

    it("the outer Sql used from inside a body joins the transaction, so a store method needs no handle passed down", async () => {
        const db = fresh();
        const store = { add: async (name: string) => void (await db.sql.run("INSERT INTO t (name) VALUES (?)", name)) };
        await db.sql.tx(async () => {
            await store.add("kept");
            await Promise.resolve();
            await store.add("kept too");
        });
        expect(names(db)).toEqual(["kept", "kept too"]);
        // It rolls back with the transaction.
        await expect(
            db.sql.tx(async () => {
                await store.add("gone");
                throw new Error("no");
            }),
        ).rejects.toThrow("no");
        expect(names(db)).toEqual(["kept", "kept too"]);
    });

    it("a handle cannot be used after its transaction ended", async () => {
        const db = fresh();
        let kept: Parameters<Parameters<typeof db.sql.tx>[0]>[0] | undefined;
        await db.sql.tx(async (t) => {
            kept = t;
        });
        await expect(kept!.run("INSERT INTO t (name) VALUES ('late')")).rejects.toThrow(/already ended/);
        expect(names(db)).toEqual([]);
    });
});

describe("the microtask rule", () => {
    it("fails a body that awaits a timer, and rolls it back", async () => {
        const db = fresh();
        await expect(
            db.sql.tx(async (t) => {
                await t.run("INSERT INTO t (name) VALUES ('before the wait')");
                await sleep(5);
                await t.run("INSERT INTO t (name) VALUES ('after the wait')");
            }),
        ).rejects.toBeInstanceOf(SqlTxRuleError);
        expect(names(db)).toEqual([]);
    });

    it("fails a body that awaits a fetch-like call (resolved from the event loop)", async () => {
        const db = fresh();
        const fakeFetch = () => new Promise<{ ok: boolean }>((resolve) => setImmediate(() => resolve({ ok: true })));
        await expect(
            db.sql.tx(async (t) => {
                const res = await fakeFetch();
                await t.run("INSERT INTO t (name) VALUES (?)", String(res.ok));
            }),
        ).rejects.toThrow(/awaited something other than the database/);
        expect(names(db)).toEqual([]);
    });

    it("is not fooled by fake timers in the test", async () => {
        vi.useFakeTimers();
        try {
            const db = fresh();
            // node:timers/promises is real even while the globals are faked: the body really yields to the event loop.
            const slow = db.sql.tx(async (t) => {
                await sleep(5);
                await t.run("INSERT INTO t (name) VALUES ('x')");
            });
            await expect(slow).rejects.toBeInstanceOf(SqlTxRuleError);
        } finally {
            vi.useRealTimers();
        }
    });

    it("in production it logs the broken rule and commits, as before the interface existed", async () => {
        const db = fresh();
        const sql = sqliteSql(db, { strict: false });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await sql.tx(async (t) => {
            await sleep(1);
            await t.run("INSERT INTO t (name) VALUES ('x')");
        });
        expect(names(db)).toEqual(["x"]);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]![0])).toMatch(/awaited something other than the database/);
    });
});

describe("the pattern store (perf-store.ts) through Sql", () => {
    it("records a run's values together, and reads history and the slowest pages back", async () => {
        const db = new Db(":memory:");
        open.push(db);
        const now = "2026-01-01T00:00:00.000Z";
        db.run("INSERT INTO users (id, email, created_at) VALUES ('u', 'u@x', ?)", now);
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p', 'u', 'P', ?, ?)", now, now);
        db.run("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES ('s', 'p', 'S', 's', ?)", now);
        for (const id of ["t1", "t2"])
            db.run(
                "INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?, 'p', 's', ?, ?, 'web', 'performance', 'high', 'VALIDATED', 'playwright', '{}', ?, ?)",
                id,
                id.toUpperCase(),
                `Page ${id}`,
                now,
                now,
            );
        await recordMetrics(db.sql, { projectId: "p", testId: "t1", executionId: "e1", samples: [{ metric: "lcp", value: 1200, unit: "ms", budget: 2500 }, { metric: "cls", value: 0.01, unit: "score" }], at: "2026-01-01T00:00:01.000Z" });
        await recordMetrics(db.sql, { projectId: "p", testId: "t1", executionId: "e2", samples: [{ metric: "lcp", value: 3000, unit: "ms", budget: 2500 }], at: "2026-01-01T00:00:02.000Z" });
        await recordMetrics(db.sql, { projectId: "p", testId: "t2", executionId: "e3", samples: [{ metric: "load", value: 900, unit: "ms" }], at: "2026-01-01T00:00:03.000Z" });
        // A sample that cannot be stored (value is NOT NULL) leaves none of its run behind.
        await expect(recordMetrics(db.sql, { projectId: "p", testId: "t2", executionId: "e4", samples: [{ metric: "load", value: 1, unit: "ms" }, { metric: "x", value: null as unknown as number, unit: "ms" }] })).rejects.toThrow();
        expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM perf_metrics WHERE execution_id = 'e4'")!.n).toBe(0);

        const h = await testHistory(db.sql, "t1");
        expect(h.latest).toEqual([{ metric: "lcp", value: 3000, unit: "ms", budget: 2500, at: "2026-01-01T00:00:02.000Z" }]);
        expect(h.history.map((r) => [r.executionId, r.values])).toEqual([
            ["e1", { lcp: 1200, cls: 0.01 }],
            ["e2", { lcp: 3000 }],
        ]);
        expect((await projectSlowest(db.sql, "p")).map((r) => [r.testKey, r.metric, r.value, r.budget])).toEqual([
            ["T1", "lcp", 3000, 2500],
            ["T2", "load", 900, null],
        ]);
    });
});
