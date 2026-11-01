/**
 * API drift: the shape recorder and the comparison (tables of cases), and real jobs against a local API that
 * changes between versions (shape-only storage, exact diffs, no false alarms on empty lists, the alert event).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { addObservations, diffSnapshots, loadDriftRuntime, sanitizeShape, templatePath, DRIFT_MAX_SHAPE_BYTES, type ApiSnapshot, type OpObservation } from "../src/engine/contracts/drift.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { KEEP_SNAPSHOTS, apiChanges, listSnapshots, recordObservations } from "../src/platform/drift-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const rt = loadDriftRuntime();

// ── helpers for the table tests ───────────────────────────────────────────────
type Call = { method?: string; path: string; status?: number; body?: unknown };
/** A run's snapshot built the way the platform builds it: from what scripts attach (shape only). */
function snap(calls: Call[], complete = true, jobId = "job"): ApiSnapshot {
    const operations: Record<string, OpObservation> = {};
    addObservations(
        operations,
        calls.map((c) => {
            const method = c.method ?? "GET";
            const status = c.status ?? 200;
            return { method, path: c.path, status, obs: method === "GET" && status < 300 ? rt.driftShape(c.body) : null };
        }),
    );
    return { jobId, at: "2026-10-07T10:00:00.000Z", complete, operations };
}
const text = (list: Array<{ operation: string; message: string }>) => list.map((c) => `${c.operation}: ${c.message}`);
const diff = (a: Call[], b: Call[], opts: { complete?: boolean } = {}) => {
    const d = diffSnapshots(snap(a), snap(b, opts.complete ?? true));
    return { breaking: text(d.breaking), nonBreaking: text(d.nonBreaking) };
};
const NONE = { breaking: [], nonBreaking: [] };

describe("shape recorder", () => {
    it("keeps field names and types, summarises arrays by their element shape, and never keeps a value", () => {
        const body = { id: 7, name: "SENTINEL-NAME", active: true, note: null, tags: ["SENTINEL-TAG"], rows: [{ a: 1 }, { a: 2, b: "SENTINEL-B" }] };
        const s = rt.driftShape(body)!;
        expect(s.t).toEqual(["object"]);
        expect(Object.keys(s.f!).sort()).toEqual(["active", "id", "name", "note", "rows", "tags"]);
        expect(s.f!.id!.t).toEqual(["number"]);
        expect(s.f!.name!.t).toEqual(["string"]);
        expect(s.f!.note!.t).toEqual(["null"]);
        expect(s.f!.tags!.e!.t).toEqual(["string"]);
        // elements are merged: `a` is in every element, `b` only in some
        expect(Object.keys(s.f!.rows!.e!.f!).sort()).toEqual(["a", "b"]);
        expect(s.f!.rows!.e!.r).toEqual(["a"]);
        expect(JSON.stringify(s)).not.toMatch(/SENTINEL|"7"|true/);
    });

    it("records an empty list without an element shape, and no shape for a missing body", () => {
        expect(rt.driftShape({ items: [] })!.f!.items).toEqual({ t: ["array"] });
        expect(rt.driftShape(undefined)).toBeNull();
        expect(rt.driftShape([])).toEqual({ t: ["array"] });
        expect(rt.driftShape("plain text")).toEqual({ t: ["string"] });
    });

    it("stops describing at depth 4 and marks the rest truncated", () => {
        const deep = { l1: { l2: { l3: { l4: { l5: { l6: 1 } } } } } };
        const s = rt.driftShape(deep)!;
        const l4 = s.f!.l1!.f!.l2!.f!.l3!.f!.l4!;
        expect(l4).toEqual({ t: ["object"], x: true });
        expect(JSON.stringify(s)).not.toContain("l5");
    });

    it("does not treat ids, e-mail addresses or tokens used as keys as field names", () => {
        for (const key of ["123e4567-e89b-12d3-a456-426614174000", "42", "alice@example.test", "eyJhbGciOiJIUzI1NiJ9", "a".repeat(65), "0123456789abcdef01234567", "__proto__"]) {
            const s = rt.driftShape(JSON.parse(`{ ${JSON.stringify(key)}: 1 }`))!;
            expect(s, key).toEqual({ t: ["object"], x: true });
        }
        const wide = rt.driftShape(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, 1])))!;
        expect(wide.x).toBe(true);
        expect(wide.f).toBeUndefined();
    });

    it("stays under the size cap by describing less when a body is huge", () => {
        const fat = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`group${i}`, Object.fromEntries(Array.from({ length: 40 }, (_, j) => [`field_number_${j}`, { inner: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`leaf_${k}`, 1])) }]))]));
        const s = rt.driftShape(fat)!;
        expect(JSON.stringify(s).length).toBeLessThanOrEqual(DRIFT_MAX_SHAPE_BYTES);
        expect(s.t).toEqual(["object"]);
    });

    it("re-validates what a script attached: unknown types, extra properties and value-like keys are dropped", () => {
        const hostile = { t: ["object", "evil"], f: { a: { t: ["string"], value: "SECRET-VALUE" }, b: { t: ["bogus"] } }, r: ["a", "ghost"], leak: "SECRET-LEAK" };
        const clean = sanitizeShape(hostile)!;
        expect(clean).toEqual({ t: ["object"], f: { a: { t: ["string"] } }, r: ["a"] });
        expect(JSON.stringify(clean)).not.toContain("SECRET");
        expect(sanitizeShape({ t: ["nope"] })).toBeNull();
        expect(sanitizeShape("string")).toBeNull();
        expect(sanitizeShape({ t: ["object"], f: { "alice@example.test": { t: ["string"] } } })).toEqual({ t: ["object"], x: true });
    });

    it("keeps only the status of calls that are not safe reads, and ignores responses a script did not mark", () => {
        const ops: Record<string, OpObservation> = {};
        addObservations(ops, [
            { method: "POST", path: "/api/users", status: 201, obs: { t: ["object"], f: { token: { t: ["string"] } }, r: ["token"] } }, // a hostile script attaching a body shape to a POST
            { method: "GET", path: "/api/plain", status: 200 }, // no `obs`: not part of drift
            { method: "GET", path: "/api/err", status: 500, obs: { t: ["object"], f: { x: { t: ["string"] } }, r: ["x"] } },
            { method: "GET", path: "/api/ok?x=1", status: 200, obs: { t: ["object"], f: { x: { t: ["string"] } }, r: ["x"] } },
        ]);
        expect(ops["POST /api/users"]).toEqual({ statuses: [201] });
        expect(ops["GET /api/plain"]).toBeUndefined();
        expect(ops["GET /api/err"]).toEqual({ statuses: [500] });
        expect(ops["GET /api/ok"]!.shape).toBeDefined();
    });

    it("turns ids into {} so /users/1 and /users/{id} are the same endpoint", () => {
        const table: Array<[string, string]> = [
            ["/api/users/42", "/api/users/{}"],
            ["/api/users/{userId}", "/api/users/{}"],
            ["/api/users/123e4567-e89b-12d3-a456-426614174000/posts/9", "/api/users/{}/posts/{}"],
            ["/api/files/0123456789abcdef0123", "/api/files/{}"],
            ["/api/sessions/a1b2c3d4e5f6g7h8", "/api/sessions/{}"],
            ["/api/users?limit=5#top", "/api/users"],
            ["/api/users/", "/api/users"],
            ["/v2/users", "/v2/users"],
            ["http://127.0.0.1:9/api/items/3?x=1", "/api/items/{}"],
            ["/", "/"],
        ];
        for (const [raw, want] of table) expect(templatePath(raw), raw).toBe(want);
    });
});

describe("comparing two runs", () => {
    const users = (rows: unknown[]) => ({ path: "/api/users", body: rows });
    const user = { id: 1, email: "a@b.c", age: 30, profile: { city: "X", zip: "1" } };

    it("reports nothing when the API answered the same way", () => {
        expect(diff([users([user, user])], [users([user])])).toEqual(NONE);
    });

    it("reports a removed field, a changed type and a field that is no longer always present as breaking", () => {
        const { email: _e, ...noEmail } = user;
        expect(diff([users([user])], [users([noEmail])])).toEqual({ breaking: ["GET /api/users: response field [].email was removed"], nonBreaking: [] });
        expect(diff([users([user])], [users([{ ...user, age: "30" }])])).toEqual({ breaking: ["GET /api/users: response field [].age changed type from number to string"], nonBreaking: [] });
        expect(diff([users([{ a: 1, b: 1 }, { a: 1, b: 2 }])], [users([{ a: 1, b: 1 }, { a: 2 }])])).toEqual({ breaking: ["GET /api/users: response field [].b is no longer always present"], nonBreaking: [] });
        expect(diff([{ path: "/api/me", body: user }], [{ path: "/api/me", body: { ...user, profile: { city: "X" } } }]).breaking).toEqual(["GET /api/me: response field profile.zip was removed"]);
        expect(diff([{ path: "/api/me", body: user }], [{ path: "/api/me", body: [user] }]).breaking).toEqual(["GET /api/me: the response body changed type from object to array"]);
    });

    it("reports new fields and new operations as non-breaking", () => {
        expect(diff([users([user])], [users([{ ...user, nickname: "n" }]), { path: "/api/status", body: { ok: true } }])).toEqual({
            breaking: [],
            nonBreaking: ["GET /api/status: new operation", "GET /api/users: new response field [].nickname"],
        });
    });

    it("does not call an empty list a removal, whichever run was empty", () => {
        expect(diff([users([user])], [users([])])).toEqual(NONE);
        expect(diff([users([])], [users([user])])).toEqual(NONE);
        expect(diff([{ path: "/api/box", body: { items: [{ id: 1 }], total: 1 } }], [{ path: "/api/box", body: { items: [], total: 0 } }])).toEqual(NONE);
    });

    it("does not call a field that was only sometimes present a removal", () => {
        expect(diff([users([{ id: 1, nick: "x" }, { id: 2 }])], [users([{ id: 1 }])])).toEqual(NONE);
    });

    it("treats null carefully: only a field that was never null and now only is, counts", () => {
        expect(diff([{ path: "/a", body: { x: "s" } }], [{ path: "/a", body: { x: null } }]).breaking).toEqual(["GET /a: response field x is now always null (it used to be string)"]);
        expect(diff([{ path: "/a", body: { x: null } }], [{ path: "/a", body: { x: "s" } }])).toEqual(NONE);
        expect(diff([{ path: "/a", body: { x: "s" } }], [{ path: "/a", body: { x: "t" } }, { path: "/a", body: { x: null } }])).toEqual(NONE);
    });

    it("does not look inside parts that were cut off (too deep)", () => {
        const a = { l1: { l2: { l3: { l4: { l5: 1 } } } } };
        const b = { l1: { l2: { l3: { l4: { l5: "x" } } } } };
        expect(diff([{ path: "/deep", body: a }], [{ path: "/deep", body: b }])).toEqual(NONE);
    });

    it("reports an operation that vanished only when the later run covered all API tests", () => {
        expect(diff([users([user])], [{ path: "/api/other", body: {} }], { complete: true }).breaking).toEqual(["GET /api/users: this operation was removed (it is no longer reached)"]);
        expect(diff([users([user])], [{ path: "/api/other", body: {} }], { complete: false }).breaking).toEqual([]);
        // an operation that never worked cannot vanish
        expect(diff([{ path: "/api/never", status: 404 }], [{ path: "/api/other", body: {} }]).breaking).toEqual([]);
    });

    it("reports an operation that used to succeed and now errors, and one that now works", () => {
        expect(diff([users([user])], [{ path: "/api/users", status: 404 }])).toEqual({ breaking: ["GET /api/users: this operation no longer exists: it now answers HTTP 404 instead of 200"], nonBreaking: [] });
        expect(diff([users([user])], [{ path: "/api/users", status: 405 }]).breaking[0]).toContain("no longer exists");
        expect(diff([users([user])], [{ path: "/api/users", status: 500 }])).toEqual({ breaking: ["GET /api/users: a request that used to succeed (HTTP 200) now fails with HTTP 500"], nonBreaking: [] });
        expect(diff([{ path: "/api/users", status: 500 }], [users([user])])).toEqual({ breaking: [], nonBreaking: ["GET /api/users: this operation now succeeds (HTTP 200); it used to answer 500"] });
        expect(diff([{ path: "/api/users", status: 500 }], [{ path: "/api/users", status: 404 }])).toEqual(NONE);
        // a negative test answering 401 next to the happy path does not hide a broken happy path
        expect(diff([users([user]), { path: "/api/users", status: 401 }], [{ path: "/api/users", status: 500 }, { path: "/api/users", status: 401 }]).breaking).toHaveLength(1);
    });

    it("ignores new operations that only error (probing a made-up path) and operations that errored when comparing fields", () => {
        expect(diff([users([user])], [users([user]), { path: "/api/users/zzzz-unique", status: 404 }])).toEqual(NONE);
        expect(diff([{ path: "/a", status: 500 }, { path: "/a", body: { x: 1 } }], [{ path: "/a", status: 500 }, { path: "/a", body: { x: 1 } }])).toEqual(NONE);
    });

    it("tracks mutating calls by status alone", () => {
        const post = (status: number): Call => ({ method: "POST", path: "/api/users", status });
        expect(diff([post(201)], [post(500)]).breaking).toEqual(["POST /api/users: a request that used to succeed (HTTP 201) now fails with HTTP 500"]);
        expect(diff([post(201)], [post(201)])).toEqual(NONE);
    });

    it("sorts the result so equal runs always give the same list", () => {
        const a = diff([{ path: "/b", body: { x: 1 } }, { path: "/a", body: { x: 1 } }], [{ path: "/b", body: { x: "1" } }, { path: "/a", body: { x: "1" } }]);
        expect(a.breaking.map((l) => l.split(":")[0])).toEqual(["GET /a", "GET /b"]);
    });
});

// ── a real script, run by real Playwright ─────────────────────────────────────
describe("what a generated script attaches", () => {
    const PORT = 5422;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json", "set-cookie": "sid=SENTINEL-COOKIE" });
            res.end(JSON.stringify(req.method === "POST" ? { id: 9, token: "SENTINEL-POST-TOKEN" } : { id: 1, email: "sentinel-get@example.test", tags: ["SENTINEL-TAG"], profile: { city: "SENTINEL-CITY" } }));
        });
    });
    let dir: string;
    beforeAll(async () => {
        await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-drift-"));
    });
    afterAll(async () => {
        await new Promise((r) => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reports the shape of a successful GET, only the status of a POST, and nothing for passive security probes", async () => {
        const mk = (testId: string, origin: string) =>
            TestSpecSchema.parse({
                testId,
                title: "drift probe",
                kind: "api",
                source: { origin },
                steps: [
                    { action: "request", method: "GET", path: "/api/users/42?x=1", auth: "default" },
                    { action: "assertResponse", check: "statusClass", expected: "2xx" },
                    { action: "request", method: "POST", path: "/api/users", auth: "default", body: { name: "SENTINEL-SENT" } },
                    { action: "assertResponse", check: "statusClass", expected: "2xx" },
                ],
            });
        const ctx = { baseUrl: `http://127.0.0.1:${PORT}` };
        const scripts = [mk("API-001", "openapi"), mk("API-002", "security-check")].map((spec) => {
            const r = renderScript(spec, "playwright-api", ctx);
            return { testId: spec.testId, filename: r.filename, content: r.content };
        });
        expect(scripts[0]!.content).toContain("const DRIFT_OBSERVE = true");
        expect(scripts[1]!.content).toContain("const DRIFT_OBSERVE = false");

        const config = loadConfig({ DATA_DIR: dir });
        const runs = await runScripts(config.scratchDir, scripts, { baseUrl: ctx.baseUrl, headless: true }, { workers: 1 });
        const [normal, passive] = runs;
        expect(normal!.status).toBe("passed");
        expect(normal!.responses).toHaveLength(2);
        const [get, post] = normal!.responses;
        expect(get).toMatchObject({ method: "GET", path: "/api/users/42?x=1", status: 200 });
        const shape = sanitizeShape(get!.obs)!;
        expect(Object.keys(shape.f!).sort()).toEqual(["email", "id", "profile", "tags"]);
        expect(shape.f!.id!.t).toEqual(["number"]);
        expect(shape.f!.tags!.e!.t).toEqual(["string"]);
        expect(post).toMatchObject({ method: "POST", status: 201, obs: null });
        // no value, header or cookie anywhere in what the run reports
        expect(JSON.stringify(normal!.responses)).not.toMatch(/SENTINEL|sentinel|sid=/);
        // passive probes take no part in drift
        expect(passive!.responses.every((r) => !("obs" in r))).toBe(true);
    }, 120_000);
});

// ── real jobs against an API that changes ─────────────────────────────────────
const PORT = 5420;
const HOOK_PORT = 5421;
const BASE = `http://127.0.0.1:${PORT}`;
type Version = "v1" | "v2";
let version: Version = "v1";
let emptyItems = false;

const USERS_V1 = [
    { id: 1, name: "SENTINEL-NAME-ALICE", email: "sentinel-alice@example.test", age: 31, role: "admin" },
    { id: 2, name: "SENTINEL-NAME-BOB", email: "sentinel-bob@example.test", age: 44, role: "user" },
];
const USERS_V2 = USERS_V1.map(({ email: _email, age, ...u }) => ({ ...u, age: String(age), nickname: `SENTINEL-NICK-${u.id}` }));

const get = (schema: unknown, parameters?: unknown[]) => ({ get: { summary: "x", ...(parameters ? { parameters } : {}), responses: { "200": { description: "ok", content: { "application/json": { schema } } } } } });
const obj = { type: "object" };
const idParam = [{ name: "id", in: "path", required: true, schema: { type: "integer" }, example: 1 }];
const openapi = (v: Version) => ({
    openapi: "3.0.0",
    info: { title: "Drift fixture", version: v },
    servers: [{ url: BASE }],
    paths: {
        "/api/users": get({ type: "array", items: obj }),
        "/api/users/{id}": get(obj, idParam),
        "/api/legacy": get(obj),
        "/api/items": get(obj),
        // removed from the description in v2; added in v2
        ...(v === "v1" ? { "/api/old": get(obj) } : { "/api/status": get(obj) }),
    },
});

const api = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    const v1 = version === "v1";
    if (p === "/openapi.json") return json(200, openapi(version));
    if (p === "/api/users") return json(200, v1 ? USERS_V1 : USERS_V2);
    if (/^\/api\/users\/\d+$/.test(p)) return json(200, v1 ? { id: 1, name: "SENTINEL-NAME-ALICE", email: "sentinel-alice@example.test", profile: { city: "SENTINEL-CITY", zip: "SENTINEL-ZIP" } } : { id: 1, name: "SENTINEL-NAME-ALICE", email: "sentinel-alice@example.test", profile: { city: "SENTINEL-CITY", country: "SENTINEL-COUNTRY" } });
    if (p === "/api/legacy") return v1 ? json(200, { ok: true, token: "SENTINEL-TOKEN-abc123" }) : json(404, { error: "gone" });
    if (p === "/api/old") return v1 ? json(200, { note: "SENTINEL-OLD" }) : json(404, { error: "gone" });
    if (p === "/api/status") return v1 ? json(404, { error: "no" }) : json(200, { state: "SENTINEL-UP" });
    if (p === "/api/items") return json(200, { items: emptyItems ? [] : [{ sku: "SENTINEL-SKU-1", price: 9.5 }, { sku: "SENTINEL-SKU-2", price: 3 }], total: emptyItems ? 0 : 2 });
    json(404, { error: "not found" });
});

const received: Array<Record<string, any>> = [];
const hook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200).end("ok");
    });
});

describe("on a real API that changes between runs", () => {
    let platform: Platform;
    let worker: Worker;
    let svc: ScheduleServices;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function finished(jobId: string) {
        for (let i = 0; i < 360; i++) {
            const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await sleep(500);
        }
        // the worker's after-job hook (summary, drift alert) runs just after the status flips
        await sleep(1_500);
        await svc.flush();
    }
    async function analyze(projectId: string, v: Version, opts: { empty?: boolean } = {}): Promise<string> {
        version = v;
        emptyItems = opts.empty ?? false;
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: BASE, targets: ["api"], securityChecks: false, contractChecks: false });
        expect(queued.status).toBe(202);
        await finished(queued.body.jobId);
        return queued.body.jobId as string;
    }
    const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;
    const changes = async (projectId: string, query = "") => (await call("GET", `/api/projects/${projectId}/api-changes${query}`)).body as { from: { jobId: string } | null; to: { jobId: string } | null; breaking: Array<{ operation: string; message: string }>; nonBreaking: Array<{ operation: string; message: string }>; message?: string };

    beforeAll(async () => {
        await Promise.all([new Promise<void>((r) => api.listen(PORT, "127.0.0.1", r)), new Promise<void>((r) => hook.listen(HOOK_PORT, "127.0.0.1", r))]);
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-driftjobs-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: "https://qa.example.test" }));
        svc = getScheduleServices(platform, { delivery: { backoffMs: [20, 20], timeoutMs: 2_000 } });
        server = await buildServer(platform);
        worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await svc?.scheduler.stop();
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => hook.close(r))]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    let projectA = "";
    const jobs: string[] = [];

    it("has nothing to compare after the first run, and an identical second run changes nothing", async () => {
        projectA = await newProject("Drift A");
        // This file re-runs tests the AI wrote: with the default policy they are drafts and wait for approval (tests/reviews-api.test.ts).
        await call("PUT", `/api/projects/${projectA}/review-policy`, { aiGenerated: false });
        const ch = await call("POST", `/api/projects/${projectA}/alert-channels`, { kind: "webhook", url: `http://127.0.0.1:${HOOK_PORT}/hook`, events: ["api_breaking_change"] });
        expect(ch.status).toBe(201);
        expect((await changes(projectA)).message).toMatch(/No API requests have been recorded yet/);

        jobs.push(await analyze(projectA, "v1"));
        const one = await changes(projectA);
        expect(one).toMatchObject({ from: null, to: { jobId: jobs[0] }, breaking: [], nonBreaking: [] });
        expect(one.message).toMatch(/Only one run/);

        jobs.push(await analyze(projectA, "v1"));
        const two = await changes(projectA);
        expect(two.from!.jobId).toBe(jobs[0]);
        expect(two.to!.jobId).toBe(jobs[1]);
        expect({ breaking: two.breaking, nonBreaking: two.nonBreaking }).toEqual({ breaking: [], nonBreaking: [] });
        expect(received).toHaveLength(0);
    }, 300_000);

    it("stores only shapes: no response value, token or cookie is anywhere in the snapshots", () => {
        const snapshots = listSnapshots(platform.db, projectA);
        expect(snapshots).toHaveLength(2);
        const raw = platform.db.all<{ operations_json: string }>("SELECT operations_json FROM api_snapshots").map((r) => r.operations_json).join("\n");
        expect(raw).not.toMatch(/sentinel/i);
        expect(raw).not.toMatch(/example\.test|abc123/);
        // ...and it is not vacuous: the field names and types are there
        const users = snapshots[1]!.operations["GET /api/users"]!;
        expect(users.statuses).toEqual([200]);
        expect(Object.keys(users.shape!.e!.f!).sort()).toEqual(["age", "email", "id", "name", "role"]);
        expect(users.shape!.e!.f!.age!.t).toEqual(["number"]);
        // the generated tests also probe a made-up id ("/api/users/abc"): recorded by status only, and never reported as a new endpoint
        expect(Object.keys(snapshots[1]!.operations).sort()).toEqual(["GET /api/items", "GET /api/legacy", "GET /api/old", "GET /api/users", "GET /api/users/abc", "GET /api/users/{}"]);
        expect(snapshots[1]!.operations["GET /api/users/abc"]).toEqual({ statuses: [404] });
        // the script of a test carries the recorder, not any value
        const script = platform.db.get<{ content: string }>("SELECT content FROM generated_scripts WHERE content LIKE '%driftObserve%' LIMIT 1");
        expect(script?.content).toContain("function driftShape");
    });

    it("reports exactly what changed when the API changes, and alerts once", async () => {
        jobs.push(await analyze(projectA, "v2"));
        const c = await changes(projectA);
        expect(c.from!.jobId).toBe(jobs[1]);
        expect(c.to!.jobId).toBe(jobs[2]);
        expect(text(c.breaking)).toEqual([
            "GET /api/legacy: this operation no longer exists: it now answers HTTP 404 instead of 200",
            "GET /api/old: this operation was removed (it is no longer reached)",
            "GET /api/users: response field [].age changed type from number to string",
            "GET /api/users: response field [].email was removed",
            "GET /api/users/{}: response field profile.zip was removed",
        ]);
        expect(text(c.nonBreaking)).toEqual(["GET /api/status: new operation", "GET /api/users: new response field [].nickname", "GET /api/users/{}: new response field profile.country"]);

        // `since` compares against an older run: the first run gives the same list here
        expect(text((await changes(projectA, `?since=${jobs[0]}`)).breaking)).toEqual(text(c.breaking));
        expect((await call("GET", `/api/projects/${projectA}/api-changes?since=nope`)).status).toBe(404);
        expect((await call("GET", `/api/projects/nope/api-changes`)).status).toBe(404);

        // one alert event, through the existing pipeline, carrying the plain-language changes and no values
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ event: "api_breaking_change", events: ["api_breaking_change"], test: false, project: { name: "Drift A" }, apiChanges: { breakingCount: 5, otherChanges: 3, to: { jobId: jobs[2] } } });
        expect(received[0]!.apiChanges.breaking).toContainEqual({ operation: "GET /api/users", message: "response field [].email was removed" });
        expect(received[0]!.summary).toMatch(/can break existing clients/);
        expect(JSON.stringify(received[0])).not.toMatch(/sentinel/i);
        const log = (await call("GET", `/api/projects/${projectA}/alert-log`)).body as Array<{ event: string; status: string; jobId: string }>;
        expect(log.filter((l) => l.event === "api_breaking_change").map((l) => [l.status, l.jobId])).toEqual([["sent", jobs[2]]]);
    }, 300_000);

    it("says nothing more when the next run matches the changed API (the change is no longer news)", async () => {
        jobs.push(await analyze(projectA, "v2"));
        const c = await changes(projectA);
        expect(c.from!.jobId).toBe(jobs[2]);
        expect({ breaking: c.breaking, nonBreaking: c.nonBreaking }).toEqual({ breaking: [], nonBreaking: [] });
        expect(received).toHaveLength(1);
    }, 300_000);

    it("does not call a part run a removal: re-running one test compares only what it ran", async () => {
        const tests = (await call("GET", `/api/projects/${projectA}/tests`)).body as Array<{ id: string; title: string }>;
        const items = tests.find((t) => t.title === "GET /api/items: succeeds with a valid request")!;
        const res = await call("POST", `/api/tests/${items.id}/validate`);
        expect(res.status).toBe(202);
        await finished(res.body.jobId);
        const c = await changes(projectA);
        expect(c.to!.jobId).toBe(res.body.jobId);
        expect(Object.keys(listSnapshots(platform.db, projectA).at(-1)!.operations)).toEqual(["GET /api/items"]);
        expect(listSnapshots(platform.db, projectA).at(-1)!.complete).toBe(false);
        expect({ breaking: c.breaking, nonBreaking: c.nonBreaking }).toEqual({ breaking: [], nonBreaking: [] });
        expect(received).toHaveLength(1);
    }, 300_000);

    it("does not report a removal when a list is empty in one run", async () => {
        const projectB = await newProject("Drift B");
        await analyze(projectB, "v1");
        await analyze(projectB, "v1", { empty: true });
        const c = await changes(projectB);
        expect(c.from).not.toBeNull();
        expect({ breaking: c.breaking, nonBreaking: c.nonBreaking }).toEqual({ breaking: [], nonBreaking: [] });
        // the empty list really was recorded as such (an array with no element shape)
        const items = listSnapshots(platform.db, projectB).at(-1)!.operations["GET /api/items"]!.shape!;
        expect(items.f!.items).toEqual({ t: ["array"] });
        expect(received).toHaveLength(1); // still only the alert of project A: B has no channel and no break
    }, 300_000);

    it("is opt-in: a channel created without choosing events hears about runs, not about API changes", async () => {
        const project = await newProject("Drift defaults");
        const ch = await call("POST", `/api/projects/${project}/alert-channels`, { kind: "webhook", url: `http://127.0.0.1:${HOOK_PORT}/hook` });
        expect(ch.status).toBe(201);
        expect(ch.body.events).toEqual(["run_failed", "regression", "recovered", "flaky"]);
        const bad = await call("POST", `/api/projects/${project}/alert-channels`, { kind: "webhook", url: `http://127.0.0.1:${HOOK_PORT}/hook`, events: ["nope"] });
        expect(bad.status).toBe(400);
    });

    it("keeps the latest snapshots of a project and never fails on malformed input", async () => {
        const repo = platform.repo;
        const project = repo.createProject({ name: "Retention" }).id as string;
        const app = repo.createApplication(project, BASE, {});
        const ids: string[] = [];
        for (let i = 0; i < KEEP_SNAPSHOTS + 3; i++) {
            const job = await repo.createJob(project, app, { ...DEFAULT_JOB_OPTIONS, targets: ["api"] });
            // closed in the same tick, so the worker never picks this job up
            platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED' WHERE id = ?", job.id);
            ids.push(job.id);
            recordObservations(platform.db, { projectId: project, jobId: job.id, responses: [{ method: "GET", path: `/api/r${i % 2}`, status: 200, obs: { t: ["object"], f: { a: { t: ["string"] } }, r: ["a"] } }] });
        }
        const kept = listSnapshots(platform.db, project);
        expect(kept).toHaveLength(KEEP_SNAPSHOTS);
        expect(kept.map((s) => s.jobId)).toEqual(ids.slice(-KEEP_SNAPSHOTS));
        expect(apiChanges(platform.db, project)!.from!.jobId).toBe(ids.at(-2));

        // calls on unknown rows or with garbage are swallowed (drift detection must never fail a job)
        expect(() => recordObservations(platform.db, { projectId: "nope", jobId: "nope", responses: [{ method: "GET", path: "/x", status: 200, obs: null }] })).not.toThrow();
        expect(() => recordObservations(platform.db, { projectId: project, jobId: ids[0]!, responses: [null as never, { method: 5 as never, path: "/", status: 200, obs: 1 }] })).not.toThrow();
    });
});
