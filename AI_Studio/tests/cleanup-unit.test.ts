/**
 * Test-data cleanup, the rules (no browser): which POST answers count as "a record was created", which DELETE operation removes
 * it, what a script's event file may contain, and the cleanup step itself against a real fixture API (order, credentials,
 * 404/410, failures, timeouts, the address guard, the "switched off" mode).
 *
 * Fast tier (no browser). Port 5570.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEANUP_HELPER_SOURCE, canCreateRecords, createdFileName, deleteOperationsOf, deleteOperationsOfSpec, loadCleanupRuntime, mergeOperations } from "../src/engine/cleanup/helper.js";
import { countItems, parseCreatedLog, planItems, summaryLine, type CreatedLine } from "../src/engine/cleanup/ledger.js";
import { CleanupCollector, cleanupHeaders, deleteRecord, finishCleanup } from "../src/engine/cleanup/run.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { startCleanupApp, type CleanupApp } from "./fixtures/cleanup-app.js";

const PORT = 5570;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "cleanup-token-5d2a91";
const rt = loadCleanupRuntime();

let fx: CleanupApp;
beforeAll(async () => {
    fx = await startCleanupApp(PORT, { token: TOKEN });
});
afterAll(async () => {
    await fx?.close();
});

const spec = (steps: unknown[], testId = "API-001") => TestSpecSchema.parse({ testId, title: "A test", kind: "api", steps });
const post = { action: "request", method: "POST", path: "/api/items", body: { name: "x" } } as const;

describe("which answers name a created record", () => {
    it("reads id, <singular>Id, <singular>_id and uuid from the top level of a JSON object, and nothing deeper", () => {
        expect(rt.cleanupIdOf({ id: 7 }, "/api/items")).toBe("7");
        expect(rt.cleanupIdOf({ id: "abc-1" }, "/api/items")).toBe("abc-1");
        expect(rt.cleanupIdOf({ itemId: 12 }, "/api/items")).toBe("12");
        expect(rt.cleanupIdOf({ item_id: "z9" }, "/api/items")).toBe("z9");
        expect(rt.cleanupIdOf({ categoryId: 3 }, "/api/categories")).toBe("3");
        expect(rt.cleanupIdOf({ uuid: "0b6d1e2a-1111-4222-8333-444455556666" }, "/api/things")).toBe("0b6d1e2a-1111-4222-8333-444455556666");
        // Not guessed from nested objects, other fields, arrays, or unusable values.
        expect(rt.cleanupIdOf({ data: { id: 5 } }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ user: { id: 5 }, name: "x" }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf([{ id: 5 }], "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ id: -4 }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ id: 1.5 }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ id: "" }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ id: "x".repeat(201) }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ id: true }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf({ id: "line\nbreak" }, "/api/items")).toBeUndefined();
        expect(rt.cleanupIdOf(null, "/api/items")).toBeUndefined();
    });

    it("leaves logins, token requests and searches alone", () => {
        for (const p of ["/api/login", "/auth/token", "/oauth/token", "/api/search", "/graphql", "/api/v1/signin", "/api/auth/refresh"]) expect(rt.cleanupCandidate(p), p).toBe(false);
        for (const p of ["/api/items", "/api/authors", "/api/users/5/posts", "/orders"]) expect(rt.cleanupCandidate(p), p).toBe(true);
    });

    it("only treats a URL on the API's own address as a path", () => {
        expect(rt.cleanupPathOf("/api/items/5?x=1", BASE)).toBe("/api/items/5");
        expect(rt.cleanupPathOf(`${BASE}/api/items/5`, BASE)).toBe("/api/items/5");
        expect(rt.cleanupPathOf("http://evil.example/api/items/5", BASE)).toBeUndefined();
        expect(rt.cleanupPathOf("//evil.example/api/items/5", BASE)).toBeUndefined();
        expect(rt.cleanupPathOf("ftp://127.0.0.1/x", BASE)).toBeUndefined();
    });
});

describe("which DELETE operation removes it (only one that is known)", () => {
    const ops = ["/api/items/{id}", "/api/users/{userId}/posts/{postId}", "/api/things/latest"];

    it("appends the id to the POST path when a known single-record DELETE matches", () => {
        expect(rt.cleanupDeletePath(ops, "/api/items", "7", undefined)).toBe("/api/items/7");
        expect(rt.cleanupDeletePath(ops, "/api/items/", "7", undefined)).toBe("/api/items/7");
        expect(rt.cleanupDeletePath(ops, "/api/users/5/posts", "9", undefined)).toBe("/api/users/5/posts/9");
        // The id is encoded, never able to add path segments.
        expect(rt.cleanupDeletePath(ops, "/api/items", "../admin", undefined)).toBe("/api/items/..%2Fadmin");
    });

    it("never guesses: no known DELETE, a collection-wide DELETE, a fixed-name DELETE or another resource means nothing is deleted", () => {
        expect(rt.cleanupDeletePath([], "/api/items", "7", undefined)).toBeUndefined();
        expect(rt.cleanupDeletePath(["/api/items"], "/api/items", "7", undefined)).toBeUndefined(); // "delete all" is never used
        expect(rt.cleanupDeletePath(ops, "/api/things", "latest", undefined)).toBeUndefined(); // the last segment is not a parameter
        expect(rt.cleanupDeletePath(ops, "/api/notes", "7", undefined)).toBeUndefined();
        expect(rt.cleanupDeletePath(ops, "/api/items", undefined, undefined)).toBeUndefined();
    });

    it("uses a Location path only when it is the new record's own address one level below the POST path", () => {
        expect(rt.cleanupDeletePath(ops, "/api/items", "7", "/api/items/7")).toBe("/api/items/7");
        expect(rt.cleanupDeletePath(ops, "/api/items", undefined, "/api/items/abc")).toBe("/api/items/abc");
        // A Location that points somewhere else (even a known DELETE operation) is ignored; the id is used instead, or nothing.
        expect(rt.cleanupDeletePath(ops, "/api/items", "7", "/api/users/5/posts/9")).toBe("/api/items/7");
        expect(rt.cleanupDeletePath(ops, "/api/items", undefined, "/api/users/5/posts/9")).toBeUndefined();
        expect(rt.cleanupDeletePath(ops, "/api/items", undefined, "/api/items/5/more")).toBeUndefined();
        expect(rt.cleanupIdFromLocation("/api/items", "/api/items/abc%20d")).toBe("abc d");
        expect(rt.cleanupIdFromLocation("/api/items", "/api/other/abc")).toBeUndefined();
    });

    it("learns operations from the API description and from the test's own DELETE steps", () => {
        expect(
            deleteOperationsOf([
                { method: "DELETE", path: "/api/items/{id}" },
                { method: "DELETE", path: "/api/items" }, // a collection: never
                { method: "GET", path: "/api/items/{id}" },
                { method: "delete", path: "/api/x/{a}/y/{b}" },
            ]),
        ).toEqual(["/api/items/{id}", "/api/x/{id}/y/{id}"]);
        expect(deleteOperationsOf(undefined)).toEqual([]);
        expect(deleteOperationsOfSpec(spec([post, { action: "request", method: "DELETE", path: "/api/items/{{item}}" }]))).toEqual(["/api/items/{id}"]);
        // DELETE of one fixed record is not an operation that can remove another.
        expect(deleteOperationsOfSpec(spec([{ action: "request", method: "DELETE", path: "/api/items/42" }]))).toEqual([]);
        expect(mergeOperations(["/b/{id}", "/a/{id}"], ["/a/{id}"], undefined)).toEqual(["/a/{id}", "/b/{id}"]);
    });

    it("compiles from the very text a generated script carries", () => {
        expect(CLEANUP_HELPER_SOURCE).toContain("function cleanupDeletePath");
        expect(createdFileName("API-001")).toBe("API-001.jsonl");
        expect(createdFileName("../../etc/x")).toBe("______etc_x.jsonl");
    });
});

describe("what a script may tell the platform", () => {
    it("keeps well-formed lines and drops everything else, without throwing", () => {
        const lines = [
            JSON.stringify({ k: "created", path: "/api/items", id: "5", at: "2026-01-01T00:00:00.000Z" }),
            "not json",
            JSON.stringify({ k: "created", path: "https://evil.example/x", id: "6", at: "2026-01-01T00:00:00.000Z" }),
            JSON.stringify({ k: "created", path: "//evil.example/x", id: "6", at: "2026-01-01T00:00:00.000Z" }),
            JSON.stringify({ k: "created", path: "/api/items", id: 7, at: "x" }),
            JSON.stringify({ k: "created", path: "/api/items", id: "8", location: "//evil.example/api/items/8", at: "2026-01-01T00:00:01.000Z" }),
            JSON.stringify({ k: "deleted", path: "/api/items/5", status: 204 }),
            JSON.stringify({ k: "deleted", path: "/api/items/6", status: "ok" }),
            JSON.stringify({ k: "other", path: "/api/items" }),
            JSON.stringify(null),
        ].join("\n");
        const parsed = parseCreatedLog(lines);
        expect(parsed).toEqual([
            { k: "created", path: "/api/items", id: "5", at: "2026-01-01T00:00:00.000Z" },
            { k: "created", path: "/api/items", id: "8", at: "2026-01-01T00:00:01.000Z" }, // the hostile Location is dropped
            { k: "deleted", path: "/api/items/5", status: 204 },
            { k: "deleted", path: "/api/items/6" },
        ]);
        expect(parseCreatedLog("x".repeat(100_000))).toEqual([]);
    });

    it("caps the records kept per test", () => {
        const many = Array.from({ length: 500 }, (_, i) => JSON.stringify({ k: "created", path: "/api/items", id: String(i), at: "2026-01-01T00:00:00.000Z" })).join("\n");
        expect(parseCreatedLog(many).length).toBe(200);
    });

    it("plans each record's delete, marks a record the test deleted itself, and says plainly when there is no way to remove one", () => {
        const s = spec([post, { action: "request", method: "DELETE", path: "/api/items/{{item}}" }]);
        const at = "2026-01-01T00:00:00.000Z";
        const lines: CreatedLine[] = [
            { k: "created", path: "/api/items", id: "1", at },
            { k: "created", path: "/api/items", id: "2", at },
            { k: "created", path: "/api/notes", id: "3", at },
            { k: "deleted", path: "/api/items/1", status: 204 },
            { k: "created", path: "/api/items", id: "4", at },
            { k: "deleted", path: "/api/items/4", status: 404 },
        ];
        const items = planItems(s, lines, [], 10);
        expect(items.map((i) => [i.id, i.seq, i.deletePath, i.status])).toEqual([
            ["1", 10, "/api/items/1", "removed"], // the test's own DELETE came after: nothing more to send
            ["2", 11, "/api/items/2", undefined], // still has to be removed
            ["3", 12, undefined, "no-delete-operation"],
            ["4", 13, "/api/items/4", "already-gone"], // the test's own DELETE got a 404: it was gone before
        ]);
        expect(items[0]!.reason).toMatch(/test deleted it itself/);
        expect(items[2]!.reason).toMatch(/no way to remove/i);
    });

    it("counts and words a run plainly", () => {
        const c = countItems([{ status: "removed" }, { status: "removed" }, { status: "already-gone" }, { status: "failed" }, { status: "no-delete-operation" }]);
        expect(c).toMatchObject({ created: 5, removed: 3, leftBehind: 2, failed: 1, noWay: 1 });
        expect(summaryLine(c)).toBe("Removed 3 of 5 records the tests created; 2 left behind.");
        expect(summaryLine(countItems([{ status: "removed" }]))).toBe("Removed 1 of 1 record the tests created.");
        expect(summaryLine(countItems([{ status: "skipped" }, { status: "skipped" }]))).toMatch(/Cleanup is switched off: 2 records/);
        expect(summaryLine(countItems([]))).toMatch(/created no records/);
    });
});

describe("the script that is rendered", () => {
    const api = (s: unknown[]) => renderScript(spec(s), "playwright-api", { baseUrl: BASE, apiBaseUrl: BASE, deleteOps: ["/api/items/{id}"] }).content;

    it("a test that cannot create records is byte for byte what it was before this feature", () => {
        const get = api([{ action: "request", method: "GET", path: "/api/items" }]);
        expect(get).not.toMatch(/cleanup|AITP_/i);
        expect(canCreateRecords(spec([{ action: "request", method: "GET", path: "/x" }]))).toBe(false);
        expect(canCreateRecords(spec([{ action: "request", method: "PUT", path: "/x/1" }]))).toBe(false);
    });

    it("a test that POSTs carries the helper, the known operations and the plain comment about who deletes", () => {
        const script = api([post]);
        expect(canCreateRecords(spec([post]))).toBe(true);
        expect(script).toContain("Test-data cleanup");
        expect(script).toContain('const CLEANUP_OPS: string[] = ["/api/items/{id}"]');
        expect(script).toContain("cleanupObserve(method, path, out);");
        expect(script).toContain("test.afterEach(");
        expect(script).toMatch(/AITP_CLEANUP=platform/);
        // Credentials come from the same variables the test uses; none is embedded.
        expect(script).not.toContain(TOKEN);
        expect(script).toContain("process.env.API_TOKEN");
        // The DELETE steps of the test itself add their operation too.
        const crud = api([post, { action: "request", method: "DELETE", path: "/api/things/{{id}}" }]);
        expect(crud).toContain("/api/things/{id}");
    });
});

describe("the cleanup step against a real API", () => {
    const events: EngineEvent[] = [];
    const ctx = { emit: (e: EngineEvent) => events.push(e), config: {}, llm: {} } as unknown as EngineContext;
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    const create = async (resource: string, name = "x") => {
        const r = await fetch(`${BASE}/api/${resource}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name }) });
        expect(r.status).toBe(201);
        return String(fx.log.filter((l) => l.op === "create").at(-1)!.id);
    };
    const OPS = ["/api/items/{id}", "/api/widgets/{id}", "/api/flaky/{id}", "/api/ghosts/{id}"];
    const s = spec([post]);
    const run = { enabled: true, apiBaseUrl: BASE, credentials: { apiToken: TOKEN } };
    const fresh = () => {
        fx.reset();
        events.length = 0;
    };

    it("removes what the run created, newest first, with the credentials the tests used, and leaves everything else alone", async () => {
        fresh();
        fx.seed("items", ["100", "101"]); // records no test created
        const collector = new CleanupCollector(OPS);
        const lines: CreatedLine[] = [];
        for (let i = 0; i < 3; i++) lines.push({ k: "created", path: "/api/items", id: await create("items"), at: at(i) });
        collector.add(s, lines);
        const done = await finishCleanup(ctx, collector, run);

        expect(done.map((d) => d.status)).toEqual(["removed", "removed", "removed"]);
        expect([...fx.store.items!.keys()].sort()).toEqual(["100", "101"]); // pre-existing records untouched
        const deletes = fx.deletes();
        expect(deletes.map((d) => d.id)).toEqual(["3", "2", "1"]); // reverse creation order
        expect(deletes.every((d) => d.auth === `Bearer ${TOKEN}`)).toBe(true); // the DELETE needs the token and got it
        expect(events.at(-1)).toMatchObject({ kind: "cleanup_finished", level: "info", message: "Removed 3 of 3 records the tests created." });
    });

    it("records each outcome: removed, already gone, failed and no way to remove", async () => {
        fresh();
        const collector = new CleanupCollector(OPS);
        const lines: CreatedLine[] = [
            { k: "created", path: "/api/items", id: await create("items"), at: at(0) },
            { k: "created", path: "/api/ghosts", id: await create("ghosts"), at: at(1) },
            { k: "created", path: "/api/flaky", id: await create("flaky"), at: at(2) },
            { k: "created", path: "/api/notes", id: await create("notes"), at: at(3) },
        ];
        collector.add(s, lines);
        const done = await finishCleanup(ctx, collector, run);
        const by = Object.fromEntries(done.map((d) => [d.path, d]));
        expect(by["/api/items"]).toMatchObject({ status: "removed" });
        expect(by["/api/ghosts"]).toMatchObject({ status: "already-gone" }); // 404 means someone else already removed it
        expect(by["/api/flaky"]).toMatchObject({ status: "failed" });
        expect(by["/api/flaky"]!.reason).toBe("The application answered HTTP 500.");
        expect(by["/api/notes"]).toMatchObject({ status: "no-delete-operation" });
        // No request at all was made for a record with no known delete operation.
        expect(fx.log.some((l) => l.resource === "notes" && l.op !== "create")).toBe(false);
        expect(events.at(-1)).toMatchObject({ level: "warn", message: "Removed 2 of 4 records the tests created; 2 left behind." });
        // The failure's reason never carries what the application said (the 500 body holds the marker).
        expect(JSON.stringify(done)).not.toContain("body-marker");
    });

    it("keeps a record that cannot be deleted without credentials marked failed, with a plain reason", async () => {
        fresh();
        const collector = new CleanupCollector(OPS);
        collector.add(s, [{ k: "created", path: "/api/items", id: await create("items"), at: at(0) }]);
        const done = await finishCleanup(ctx, collector, { enabled: true, apiBaseUrl: BASE }); // no credentials
        expect(done[0]).toMatchObject({ status: "failed" });
        expect(done[0]!.reason).toMatch(/refused the delete \(HTTP 401\)/);
        expect(fx.store.items!.size).toBe(1);
    });

    it("sends nothing outside the application: another address, a protocol-relative path, or a guard that says no", async () => {
        fresh();
        const base = { apiBaseUrl: BASE, headers: cleanupHeaders({ apiToken: TOKEN }) };
        expect(await deleteRecord({ ...base, deletePath: "//evil.example/api/items/1" })).toMatchObject({ status: "failed", reason: expect.stringMatching(/not a path on the application/) });
        expect(await deleteRecord({ ...base, deletePath: "http://evil.example/x" })).toMatchObject({ status: "failed" });
        expect(await deleteRecord({ ...base, deletePath: "/api/items/1", guard: async () => { throw Object.assign(new Error("Target resolves to a private/loopback address"), { status: 400 }); } })).toMatchObject({ status: "failed", reason: expect.stringMatching(/private/) });
        expect(fx.log).toHaveLength(0);
    });

    it("gives up on a slow application after the timeout and reports it", async () => {
        fresh();
        const id = await create("items");
        fx.deleteDelayMs = 1500;
        const r = await deleteRecord({ apiBaseUrl: BASE, deletePath: `/api/items/${id}`, headers: cleanupHeaders({ apiToken: TOKEN }), timeoutMs: 300 });
        expect(r.status).toBe("failed");
        expect(r.reason).toMatch(/No answer within/);
        fx.deleteDelayMs = 0;
    });

    it("does not follow a redirect (the credentials would travel with it)", async () => {
        fresh();
        let hits = 0;
        const http = await import("node:http");
        const evil = http.createServer((_q, r) => (hits++, r.writeHead(204), r.end()));
        await new Promise<void>((r) => evil.listen(5571, "127.0.0.1", () => r()));
        const redirector = http.createServer((_q, r) => (r.writeHead(302, { location: "http://127.0.0.1:5571/x" }), r.end()));
        await new Promise<void>((r) => redirector.listen(5572, "127.0.0.1", () => r()));
        try {
            const out = await deleteRecord({ apiBaseUrl: "http://127.0.0.1:5572", deletePath: "/api/items/1", headers: cleanupHeaders({ apiToken: TOKEN }) });
            expect(out).toMatchObject({ status: "failed" });
            expect(out.reason).toMatch(/redirect/);
            expect(hits).toBe(0);
        } finally {
            evil.closeAllConnections();
            redirector.closeAllConnections();
            await new Promise((r) => evil.close(r));
            await new Promise((r) => redirector.close(r));
        }
    });

    it("when cleanup is switched off it deletes nothing and says the records stay", async () => {
        fresh();
        const collector = new CleanupCollector(OPS);
        collector.add(s, [
            { k: "created", path: "/api/items", id: await create("items"), at: at(0) },
            { k: "created", path: "/api/notes", id: await create("notes"), at: at(1) },
        ]);
        const done = await finishCleanup(ctx, collector, { ...run, enabled: false });
        expect(done.map((d) => d.status)).toEqual(["skipped", "no-delete-operation"]);
        expect(fx.deletes()).toHaveLength(0);
        expect(fx.store.items!.size).toBe(1);
        expect(done[0]!.reason).toMatch(/switched off/);
        expect(events.at(-1)!.message).toMatch(/left behind|left in the application/);
    });

    it("never throws and reports nothing when the tests created nothing", async () => {
        fresh();
        expect(await finishCleanup(ctx, new CleanupCollector(OPS), run)).toEqual([]);
        expect(events).toHaveLength(0);
    });
});
