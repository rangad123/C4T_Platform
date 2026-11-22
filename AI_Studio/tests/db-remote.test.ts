/**
 * Phase 4 T22b: the engine's remote back end (engine/database/remote.ts) over the reference probe. Against a local SQLite database shaped
 * like the practice store (tests/fixtures/practice-store-db.ts; never the live site), the C10 checks the schema's keys give run through
 * the run's database check service, as a script's dbCheck step sends them, and find the seeded orphan: findings with counts, fingerprints
 * and masked keys only. A probe that answers anything else (row values, another table) is refused, and so is an address that is not
 * https:// (or http:// on loopback). No browser. Ports 9887 (probe) and 9888 (a misbehaving stand-in).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrityChecks } from "../src/engine/database/checks.js";
import { DatabaseCheckRefused } from "../src/engine/database/probe.js";
import { probeUrlProblem, remoteDbProbe } from "../src/engine/database/remote.js";
import { startDbCheckService } from "../src/engine/database/service.js";
import { makePracticeStoreDb, PRACTICE_ALLOW, PRIVATE_VALUES } from "./fixtures/practice-store-db.js";

const TOKEN = "remote-test-token-0123456789abcdef";
const PROBE = "http://127.0.0.1:9887";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-remote-"));
let probe: ChildProcess;
let liar: http.Server;
/** What the misbehaving stand-in answers to POST /check. */
let lie: unknown = {};

beforeAll(async () => {
    const db = path.join(dir, "store.db");
    makePracticeStoreDb(db);
    fs.writeFileSync(path.join(dir, "token"), TOKEN);
    fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify(PRACTICE_ALLOW));
    probe = spawn(process.execPath, [path.resolve("examples/db-probe/server.mjs"), "--sqlite", db, "--token-file", path.join(dir, "token"), "--allow", path.join(dir, "allow.json"), "--port", "9887", "--audit", path.join(dir, "audit.log")], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
        probe.stdout!.on("data", (b: Buffer) => /listening/.test(String(b)) && resolve());
        probe.once("exit", (c) => reject(new Error(`probe exited ${c}`)));
    });
    liar = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/schema" ? { tables: [{ name: "users", columns: ["id", "email"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rowCount: 2 }] } : lie));
    });
    await new Promise<void>((resolve) => liar.listen(9888, "127.0.0.1", resolve));
}, 30_000);

afterAll(async () => {
    probe.kill();
    await new Promise((r) => liar.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the C10 checks through the customer's probe", () => {
    it("run from the schema's keys and find the seeded orphan, with counts and fingerprints only", async () => {
        const remote = remoteDbProbe({ url: PROBE, token: TOKEN });
        const schema = await remote.schema();
        expect(schema.tables.map((t) => t.name).sort()).toEqual(["order_lines", "orders", "products", "users"]);
        const names = integrityChecks(schema);
        expect(names).toEqual(expect.arrayContaining(["orphans order_lines(product_id) -> products(id)", "orphans order_lines(order_id) -> orders(id)", "orphans orders(user_id) -> users(id)", "duplicates users(email)"]));

        // As a script's dbCheck step does: by name, through the run's service.
        const service = await startDbCheckService(remote);
        const ask = async (name: string, vars: Record<string, string> = {}) => {
            const r = await fetch(service.url, { method: "POST", headers: { authorization: `Bearer ${service.token}`, "content-type": "application/json" }, body: JSON.stringify({ name, vars }) });
            return { status: r.status, text: await r.text() };
        };
        try {
            const results: Record<string, { count: number; ids: string[]; examples: string[] }> = {};
            for (const n of [...names, "exists orders where id = '{{orderId}}'"]) {
                const r = await ask(n, { orderId: "1001" });
                expect(r.status, `${n}: ${r.text}`).toBe(200);
                for (const v of PRIVATE_VALUES) expect(r.text, n).not.toContain(v);
                results[n] = JSON.parse(r.text);
            }
            expect(results["orphans order_lines(product_id) -> products(id)"]!.count).toBe(1);
            expect(results["orphans order_lines(product_id) -> products(id)"]!.ids[0]).toMatch(/^[0-9a-f]{32}$/);
            expect(results["orphans order_lines(order_id) -> orders(id)"]!.count).toBe(0);
            expect(results["duplicates users(email)"]!.count).toBe(0);
            // The persistence check of a create (the id it returned, as text) finds the stored row.
            expect(results["exists orders where id = '{{orderId}}'"]!.count).toBe(1);
            // A table off the allow-list is refused by the probe and said so.
            const off = await ask("exists sessions where token = 'x'");
            expect(off.status).toBe(400);
            expect(off.text).toMatch(/the database probe refused it: the table \\"sessions\\" is not on the probe.s allow-list/);
        } finally {
            await service.close();
        }
    });

    it("proposes no relation over rows for a probe, and refuses one before sending it", async () => {
        const remote = remoteDbProbe({ url: PROBE, token: TOKEN });
        expect(remote.rowRelations).toBe(false);
        await expect(remote.check({ kind: "relation", table: "orders", where: [], expression: "total == subtotal" })).rejects.toBeInstanceOf(DatabaseCheckRefused);
    });

    it("says a wrong token in one line, without the token", async () => {
        const err = await remoteDbProbe({ url: PROBE, token: "a-wrong-token-a-wrong-token-0000" })
            .schema()
            .then(() => "", (e: Error) => e.message);
        expect(err).toBe("the database probe answered HTTP 401: not authorised");
    });
});

describe("what the engine accepts from a probe", () => {
    const liarProbe = () => remoteDbProbe({ url: "http://127.0.0.1:9888", token: TOKEN });
    const ok = { kind: "count", table: "users", count: 2, ids: ["0123456789abcdef0123456789abcdef"], examples: ["•• (2 characters)"] };
    it("takes a count, fingerprints and masked keys", async () => {
        lie = ok;
        expect(await liarProbe().check({ kind: "count", table: "users", where: [] })).toEqual(ok);
    });
    it.each([
        ["row values as examples", { ...ok, examples: ["user@practice.test"] }],
        ["row values as ids", { ...ok, ids: ["user@practice.test"] }],
        ["the rows themselves", { ...ok, rows: [{ email: "user@practice.test" }] }],
        ["another table", { ...ok, table: "orders" }],
        ["another kind", { ...ok, kind: "exists" }],
        ["a count that is not one", { ...ok, count: -1 }],
        ["more than 20 keys", { ...ok, ids: Array(21).fill(ok.ids[0]) }],
    ])("refuses %s", async (_what, answer) => {
        lie = answer;
        const err = await liarProbe()
            .check({ kind: "count", table: "users", where: [] })
            .then(() => "accepted", (e: Error) => e.message);
        expect(err).toMatch(/not a check result/);
    });
});

describe("an answer that is too big or too slow is cut off", () => {
    it("stops reading at 2 MB, also when the answer is compressed, and the time limit covers the body", async () => {
        const zlib = await import("node:zlib");
        const { guardedFetch } = await import("../src/platform/guarded-fetch.js");
        const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024, 0x20));
        const server = http.createServer((req, res) => {
            if (req.url === "/schema") {
                res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
                res.end(bomb);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.write("{"); // and then nothing: a body that never ends
            }
        });
        await new Promise<void>((r) => server.listen(9889, "127.0.0.1", () => r()));
        try {
            const probe = remoteDbProbe({ url: "http://127.0.0.1:9889", token: TOKEN, fetch: guardedFetch, timeoutMs: 1500 });
            let started = Date.now();
            await expect(probe.schema()).rejects.toThrow(/more than 2097152 bytes/);
            expect(Date.now() - started).toBeLessThan(3000);
            started = Date.now();
            await expect(probe.check({ kind: "count", table: "users", where: [] })).rejects.toThrow(/took longer than/);
            expect(Date.now() - started).toBeLessThan(4000);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((r) => server.close(() => r()));
        }
    });
});

describe("the probe address", () => {
    it.each([
        ["https://probe.example.com", undefined],
        ["https://probe.example.com:8443/db", undefined],
        ["http://127.0.0.1:8790", undefined],
        ["http://localhost:8790", undefined],
        ["http://probe.example.com", "https://"],
        ["http://10.0.0.5:8790", "https://"],
        ["ftp://probe.example.com", "https://"],
        ["https://user:pw@probe.example.com", "no user name"],
        ["https://probe.example.com/?token=x", "no user name"],
        ["not a url", "not a web address"],
    ])("%s", (url, problem) => {
        const got = probeUrlProblem(url);
        if (problem === undefined) expect(got).toBeUndefined();
        else expect(got).toContain(problem);
        if (problem) expect(() => remoteDbProbe({ url, token: TOKEN })).toThrow();
    });
});
