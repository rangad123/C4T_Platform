/**
 * D-b, the bench SQLite back end (Phase 4 T21; spec 4.4): with BENCH_DB the benchmark apps also keep their tables in a node:sqlite file,
 * and the engine reads it read-only, only under eval/.data-bench/<trial>/.
 *   - the same stored-data seeds as D-a: red with the seed alone and with every seed on, green clean (tests/fixtures/db-seeds.ts), each
 *     started through the harness's own host (src/eval/bench/apps.ts) with the bench-sqlite back end;
 *   - the file gives the same answers as the data routes (D-a) for every template;
 *   - a path outside the folder (directly, by "..", by a link, or the folder itself) is refused before anything is opened;
 *   - a write through the engine's connection fails;
 *   - a result is counts, fingerprints and masked keys only.
 * Free loopback ports, no browser, no AI. The trial folder is made under eval/.data-bench and removed at the end.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { benchDataProbe } from "../src/engine/database/bench-data.js";
import { BENCH_DATA_ROOT, benchDatabaseFile, benchSqliteProbe, openBenchDatabase } from "../src/engine/database/bench-sqlite.js";
import type { DbTemplate } from "../src/engine/database/templates.js";
import { BENCH_APPS, BenchAppHost } from "../src/eval/bench/apps.js";
import { BENCH_DATA_TEST_TOKEN } from "../src/eval/bench/verify/app.js";
import { BenchClient } from "../src/eval/bench/verify/http.js";
import { DB_SEEDS } from "./fixtures/db-seeds.js";

const TRIAL = path.join(BENCH_DATA_ROOT, `test-db-sqlite-${process.pid}-${Date.now()}`);
const DIR = path.join(TRIAL, "bench-db");
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "db-sqlite-outside-"));
let host: BenchAppHost | undefined;
afterEach(async () => {
    await host?.stop();
    host = undefined;
});
afterAll(() => {
    fs.rmSync(TRIAL, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
});
const freePort = () =>
    new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
const appOf = (id: string) => BENCH_APPS.find((a) => a.id === id)!;
async function started(appId: string, defects: string[] | "none" | "all") {
    host = new BenchAppHost(appOf(appId), await freePort(), undefined, "html", { kind: "bench-sqlite", dir: DIR });
    await host.start(defects);
    return host;
}

describe("the stored-data seeds through the SQLite file", () => {
    for (const s of DB_SEEDS) {
        it(`${s.seed}: red with the seed alone, red with every seed on, green on the clean app`, async () => {
            const red = async (defects: string[] | "none" | "all") => {
                const h = await started(s.app, defects);
                try {
                    return await s.red(h.url, h.probe()!);
                } finally {
                    await h.stop();
                }
            };
            expect(await red([s.seed])).toBe(true);
            expect(await red("all")).toBe(true);
            expect(await red("none")).toBe(false);
        });
    }
});

describe("the file answers as the data routes do", () => {
    it("every template gives the same counts on both back ends, after the actions of every seed", async () => {
        const file = path.join(DIR, "bench-shop-same.sqlite");
        fs.mkdirSync(DIR, { recursive: true });
        const port = await freePort();
        // One app with both back ends on, to compare them on the same data.
        const app = await (async () => {
            const child = spawn(process.execPath, [path.resolve("examples/bench-shop/server.mjs"), String(port)], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", BENCH_DEFECTS: "all", BENCH_DATA_TOKEN: BENCH_DATA_TEST_TOKEN, BENCH_DB: file } });
            for (let i = 0; i < 80; i++) {
                if (await fetch(`http://127.0.0.1:${port}/openapi.json`).then((r) => r.ok, () => false)) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            return { base: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => (child.once("exit", () => r()), child.kill())) };
        })();
        try {
            const c = new BenchClient(app.base);
            await c.signIn("alice@example.test");
            await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 2 });
            await c.call("POST", "/api/checkout/address", { address: "1 Test Road, Leeds" });
            await c.call("POST", "/api/orders");
            await new BenchClient(app.base).call("POST", "/api/register", { name: "Alice Again", email: "ALICE@example.test", password: "Password1!" });
            const a = benchDataProbe({ url: app.base, token: BENCH_DATA_TEST_TOKEN });
            const b = benchSqliteProbe({ file });
            const checks: Array<[DbTemplate, Record<string, string | number | null>]> = [
                [{ kind: "count", table: "orders", where: [] }, {}],
                [{ kind: "count", table: "orders", where: ["userId"] }, { userId: "u1" }],
                [{ kind: "exists", table: "users", where: ["email"] }, { email: "alice@example.test" }],
                [{ kind: "exists", table: "orders", where: ["total"] }, { total: "1350" }],
                [{ kind: "count", table: "carts", where: ["code"] }, { code: null }],
                [{ kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } }, {}],
                [{ kind: "orphans", table: "order_lines", columns: ["orderId"], references: { table: "orders", columns: ["id"] } }, {}],
                [{ kind: "duplicates", table: "users", columns: ["email"], fold: true }, {}],
                [{ kind: "duplicates", table: "users", columns: ["email"] }, {}],
                [{ kind: "relation", table: "orders", where: [], expression: "total == subtotal - discount + shipping" }, {}],
                [{ kind: "relation", table: "order_lines", where: [], expression: "lineTotal == unitPrice * quantity" }, {}],
            ];
            for (const [t, p] of checks) expect({ t, n: (await b.check(t, p)).count }).toEqual({ t, n: (await a.check(t, p)).count });
            expect((await b.schema()).tables.map((t) => [t.name, t.rowCount]).sort()).toEqual((await a.schema()).tables.map((t) => [t.name, t.rowCount]).sort());
            // Values never come back: the e-mail addresses and the address are in the file, not in any result.
            const text = JSON.stringify(await Promise.all(checks.map(([t, p]) => b.check(t, p))));
            for (const v of ["alice@example.test", "ALICE@example.test", "Leeds", "Harbour"]) expect(text).not.toContain(v);
        } finally {
            await app.stop();
        }
    });
});

describe("only a file under eval/.data-bench/<trial>/, only read", () => {
    it("refuses a path outside the folder, through .., through a link, or in the folder itself", () => {
        fs.mkdirSync(DIR, { recursive: true });
        const outside = path.join(OUTSIDE, "x.sqlite");
        fs.writeFileSync(outside, "");
        expect(() => benchDatabaseFile(outside)).toThrow(/only a database file under eval\/.data-bench/);
        expect(() => benchDatabaseFile(path.join(DIR, path.relative(DIR, outside)))).toThrow(/only a database file/);
        const link = path.join(DIR, "link.sqlite");
        fs.rmSync(link, { force: true });
        fs.symlinkSync(outside, link);
        expect(() => benchDatabaseFile(link)).toThrow(/only a database file/);
        expect(() => benchSqliteProbe({ file: link })).toThrow(/only a database file/);
        const atRoot = path.join(BENCH_DATA_ROOT, `test-db-at-root-${process.pid}.sqlite`);
        fs.writeFileSync(atRoot, "");
        try {
            expect(() => benchDatabaseFile(atRoot)).toThrow(/only a database file/);
        } finally {
            fs.rmSync(atRoot, { force: true });
        }
        expect(() => benchDatabaseFile(DIR)).toThrow(/only a database file/);
        expect(() => benchDatabaseFile(path.join(DIR, "missing.sqlite"))).toThrow(/does not exist/);
    });

    it("a write through the engine's connection fails", async () => {
        const h = await started("bench-shop", "none");
        const d = await openBenchDatabase(h.databaseFile!);
        try {
            expect(() => d.exec(`DELETE FROM "users"`)).toThrow(/readonly|read-only|query_only|attempt to write/i);
            expect(() => d.exec(`CREATE TABLE x (a)`)).toThrow();
            expect(() => d.prepare(`INSERT INTO "users" ("id") VALUES (?)`).run("u9")).toThrow();
        } finally {
            d.close();
        }
        // The app's own data is untouched.
        expect((await h.probe()!.check({ kind: "count", table: "users", where: [] })).count).toBe(2);
    });
});
