/**
 * Test-data cleanup, run for real: data-changing API tests create records in a fixture application, and the platform removes
 * exactly those records afterwards. A fixture API holds an in-memory store and logs every mutating request, so the tests can
 * prove what was removed, what was left alone, in which order and with which credentials.
 *
 * Covers: records the test created are gone while pre-seeded ones are untouched; ledger statuses (removed, already gone, failed,
 * no way to remove); newest first; the DELETE that needs the token gets it; a record the test deleted itself is not deleted
 * twice; a downloaded script deletes by itself and a platform run does not double-delete; retry of only the failed items;
 * a failed cleanup changes neither a test's result nor the job; a hostile Location header is never followed; production runs
 * nothing and deletes nothing, staging cleans up with its own credentials; switched-off cleanup leaves the records and says so;
 * only ids and paths are stored; rows past 30 days are pruned; single-test runs clean up too.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/cleanup.test.ts
 * Ports: fixture 5573, platform 5574, hostile server 5575, staging fixture 5576, production fixture 5577.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CleanupStore } from "../src/platform/cleanup-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { BODY_MARKER, startCleanupApp, type CleanupApp } from "./fixtures/cleanup-app.js";

const FX_PORT = 5573;
const PLATFORM_PORT = 5574;
const EVIL_PORT = 5575;
const STAGING_PORT = 5576;
const PROD_PORT = 5577;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const FX = `http://127.0.0.1:${FX_PORT}`;
const TOKEN = "cleanup-token-5d2a91";
const STAGING_TOKEN = "staging-token-7b30c4";
const PROD_TOKEN = "prod-token-e15a88";

let fx: CleanupApp;
let staging: CleanupApp;
let prod: CleanupApp;
let evil: http.Server;
let evilHits = 0;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; text: string; body: any };
};

async function idle(projectId: string): Promise<void> {
    for (let i = 0; i < 600; i++) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("project never became idle");
}

const tests = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; title: string; validationStatus: string }>;
const testByKey = async (projectId: string, key: string) => (await tests(projectId)).find((t) => t.testId === key)!;
const cleanup = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/cleanup`)).body;
const events = async (jobId: string) => ((await call("GET", `/api/test-generation/${jobId}/events`)).body as any[]) ?? [];
const latestJob = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/jobs`)).body[0] as { jobId: string; status: string };

const req = (method: string, p: string, extra: Record<string, unknown> = {}) => ({ action: "request", method, path: p, auth: "default", description: "", ...extra });
const ok = { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" };
const spec = (testId: string, title: string, steps: unknown[]) => ({ testId, title, kind: "api", category: "Items", type: "functional", priority: "medium", tags: ["api"], steps });

/** The imported project: a lifecycle test that deletes its own record, a test that creates two and deletes none, one that also logs in. */
const SPECS = [
    spec("API-001", "An item can be created and deleted", [req("POST", "/api/items", { body: { name: "lifecycle" }, extract: { item: "id" } }), ok, req("DELETE", "/api/items/{{item}}"), ok]),
    spec("API-002", "Two items can be created", [req("POST", "/api/items", { body: { name: "first" } }), ok, req("POST", "/api/items", { body: { name: "second" } }), ok]),
    spec("API-003", "An item can be created after logging in", [req("POST", "/api/login", { body: { name: "x" } }), ok, req("POST", "/api/items", { body: { name: "third" } }), ok]),
];

async function importProject(name: string, baseUrl = FX, token = TOKEN): Promise<string> {
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: SPECS, baseUrl, credentials: { apiToken: token } });
    expect(imported.status, imported.text).toBe(202);
    await idle(projectId);
    return projectId;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fx = await startCleanupApp(FX_PORT, { token: TOKEN });
    staging = await startCleanupApp(STAGING_PORT, { token: STAGING_TOKEN });
    prod = await startCleanupApp(PROD_PORT, { token: PROD_TOKEN });
    evil = http.createServer((_q, r) => (evilHits++, r.writeHead(204), r.end()));
    await new Promise<void>((r) => evil.listen(EVIL_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cleanup-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await fx?.close();
    await staging?.close();
    await prod?.close();
    evil?.closeAllConnections();
    await new Promise((r) => evil?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("an imported project validated against the fixture", () => {
    let projectId = "";

    it("removes the records its tests created, newest first, and leaves the records it did not create alone", async () => {
        fx.reset();
        fx.seed("items", ["100", "101"]); // already in the application: no test created them
        projectId = await importProject("Cleanup imported");

        // Every test passed, and nothing the tests created is left; the seeded records are exactly as they were.
        expect((await tests(projectId)).map((t) => t.validationStatus)).toEqual(["VALIDATED", "VALIDATED", "VALIDATED"]);
        expect([...fx.store.items!.keys()].sort()).toEqual(["100", "101"]);
        expect(fx.store.items!.get("100")).toMatchObject({ name: "seeded 100" });

        // The ledger: four items created (the login created nothing), all removed, one of them by the test itself.
        const c = await cleanup(projectId);
        expect(c).toMatchObject({ enabled: true, dataChangingTests: 3 });
        expect(c.latest.counts).toMatchObject({ created: 4, removed: 4, leftBehind: 0 });
        expect(c.latest.summary).toBe("Removed 4 of 4 records the tests created.");
        const byTest = (key: string) => c.latest.items.filter((i: any) => i.testId === key);
        expect(byTest("API-001")).toHaveLength(1);
        expect(byTest("API-001")[0]).toMatchObject({ status: "removed", reason: "The test deleted it itself." });
        expect(byTest("API-002").map((i: any) => i.status)).toEqual(["removed", "removed"]);
        expect(byTest("API-003")).toHaveLength(1); // the login answered with an id and a token: not a record
        expect(c.latest.items.some((i: any) => i.path === "/api/login")).toBe(false);

        // The job event says it in plain words; the job itself did not fail because of cleanup.
        const job = await latestJob(projectId);
        expect(job.status).toBe("COMPLETED");
        const evs = await events(job.jobId);
        expect(evs.find((e) => e.kind === "cleanup_finished")).toMatchObject({ level: "info", message: "Removed 4 of 4 records the tests created." });
    }, 240_000);

    it("deleted in reverse creation order, with the credentials the tests used, and never twice", async () => {
        const created = fx.log.filter((l) => l.op === "create").map((l) => Number(l.id));
        expect(created).toHaveLength(4);
        const lifecycle = (await cleanup(projectId)).latest.items.find((i: any) => i.reason === "The test deleted it itself.");
        const deletes = fx.log.filter((l) => l.op === "delete");
        // Every record was deleted exactly once: the lifecycle test's own DELETE is not repeated by the platform.
        expect(deletes.map((l) => Number(l.id)).sort()).toEqual([...created].sort());
        expect(deletes.filter((l) => l.id === lifecycle.recordId)).toHaveLength(1);
        // What the platform deleted came newest first.
        const platformOrder = deletes.map((l) => Number(l.id)).filter((id) => String(id) !== lifecycle.recordId);
        expect(platformOrder).toHaveLength(3);
        expect(platformOrder).toEqual([...platformOrder].sort((a, b) => b - a));
        // The DELETE requires the bearer token; every DELETE carried it.
        expect(deletes.every((l) => l.auth === `Bearer ${TOKEN}`)).toBe(true);
    });

    it("cleans up after a single test run too", async () => {
        fx.log.length = 0;
        const t = await testByKey(projectId, "API-002");
        const started = await call("POST", `/api/tests/${t.id}/validate`);
        expect(started.status, started.text).toBe(202);
        await idle(projectId);
        expect([...fx.store.items!.keys()].sort()).toEqual(["100", "101"]);
        expect(fx.log.filter((l) => l.op === "create")).toHaveLength(2);
        expect(fx.log.filter((l) => l.op === "delete")).toHaveLength(2); // one DELETE per record, none repeated
        const run = (await call("GET", `/api/tests/${t.id}/cleanup`)).body;
        expect(run.latest.counts).toMatchObject({ created: 2, removed: 2 });
        expect(run.latest.items.every((i: any) => i.testId === "API-002")).toBe(true);
    }, 240_000);

    it("a hostile Location header is never followed: the delete goes to the application's own address", async () => {
        fx.log.length = 0;
        fx.evilLocation = `http://127.0.0.1:${EVIL_PORT}`;
        evilHits = 0;
        const t = await testByKey(projectId, "API-003");
        await call("POST", `/api/tests/${t.id}/validate`);
        await idle(projectId);
        fx.evilLocation = undefined;
        expect(evilHits).toBe(0);
        expect([...fx.store.items!.keys()].sort()).toEqual(["100", "101"]); // removed through its id on the application's own address
        expect((await cleanup(projectId)).latest.counts).toMatchObject({ created: 1, removed: 1 });
    }, 240_000);

    it("the script that was stored and downloaded deletes by itself; the platform does not delete again", async () => {
        fx.log.length = 0;
        const t = await testByKey(projectId, "API-002");
        const script = (await call("GET", `/api/tests/${t.id}/script`)).text;
        expect(script).toContain("Test-data cleanup");
        expect(script).not.toContain(TOKEN); // no secret is ever embedded
        expect(script).toContain('"/api/items/{id}"'); // the operation known from the project's other tests travels with it

        // Run it like a person would, outside the platform: no AITP_CLEANUP is set, so the script itself is responsible.
        const runs = await runScripts(platform.config.scratchDir, [{ testId: "API-002", filename: "API-002.spec.ts", content: script }], { baseUrl: FX, apiBaseUrl: FX, apiToken: TOKEN, headless: true }, { workers: 1 });
        expect(runs[0]!.status).toBe("passed");
        expect(runs[0]!.created).toBeUndefined(); // it kept no ledger file: it removed the records itself
        expect([...fx.store.items!.keys()].sort()).toEqual(["100", "101"]);
        const creates = fx.log.filter((l) => l.op === "create").map((l) => l.id);
        const deletes = fx.log.filter((l) => l.op === "delete").map((l) => l.id);
        expect(creates).toHaveLength(2);
        expect(deletes.sort()).toEqual([...creates].sort()); // exactly one DELETE per record
        expect(fx.log.filter((l) => l.op === "delete").every((l) => l.auth === `Bearer ${TOKEN}`)).toBe(true);
    }, 240_000);

    it("a run with cleanup handed to the platform never lets the script delete (exactly one party)", async () => {
        fx.log.length = 0;
        const script = (await call("GET", `/api/tests/${(await testByKey(projectId, "API-002")).id}/script`)).text;
        const runs = await runScripts(platform.config.scratchDir, [{ testId: "API-002", filename: "API-002.spec.ts", content: script }], { baseUrl: FX, apiBaseUrl: FX, apiToken: TOKEN, headless: true, cleanup: "platform" }, { workers: 1 });
        expect(runs[0]!.status).toBe("passed");
        expect(runs[0]!.created?.filter((l) => l.k === "created")).toHaveLength(2); // it wrote down what it created ...
        expect(fx.log.filter((l) => l.op === "delete")).toHaveLength(0); // ... and deleted nothing
        expect(fx.store.items!.size).toBe(4);
        const off = await runScripts(platform.config.scratchDir, [{ testId: "API-002", filename: "API-002.spec.ts", content: script }], { baseUrl: FX, apiBaseUrl: FX, apiToken: TOKEN, headless: true, cleanup: "off" }, { workers: 1 });
        expect(off[0]!.created?.filter((l) => l.k === "created")).toHaveLength(2);
        expect(fx.log.filter((l) => l.op === "delete")).toHaveLength(0);
        for (const id of fx.log.filter((l) => l.op === "create").map((l) => l.id)) fx.store.items!.delete(id); // tidy the fixture for the next tests
    }, 240_000);
});

describe("a project generated from an API description (the DELETE operations come from the description)", () => {
    let projectId = "";

    it("generates data-changing tests, runs them, and removes what they created", async () => {
        fx.reset();
        fx.seed("items", ["100"]);
        fx.seed("widgets", ["200"]);
        projectId = (await call("POST", "/api/projects", { name: "Cleanup generated" })).body.id;
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: FX, targets: ["api"], allowMutatingApiTests: true, securityChecks: false, contractChecks: false, credentials: { apiToken: TOKEN } });
        expect(queued.status, queued.text).toBe(202);
        await idle(projectId);

        // Removed: everything created in items and widgets (widgets answer with a Location header only). Seeds untouched.
        expect([...fx.store.items!.keys()]).toEqual(["100"]);
        expect([...fx.store.widgets!.keys()]).toEqual(["200"]);
        const c = await cleanup(projectId);
        const rows = c.latest.items as Array<{ path: string; status: string; reason: string | null; testId: string }>;
        const statuses = (p: string) => [...new Set(rows.filter((r) => r.path === p).map((r) => r.status))];
        expect(statuses("/api/items")).toEqual(["removed"]);
        expect(statuses("/api/widgets")).toEqual(["removed"]);
        expect(statuses("/api/ghosts")).toEqual(["already-gone"]); // the application answers 404: someone else removed it
        expect(statuses("/api/flaky")).toEqual(["failed"]); // the application answers 500
        expect(statuses("/api/notes")).toEqual(["no-delete-operation"]); // the description has no DELETE for notes
        expect(rows.find((r) => r.path === "/api/notes")!.reason).toMatch(/no way to remove/i);
        expect(rows.find((r) => r.path === "/api/flaky")!.reason).toBe("The application answered HTTP 500.");
        expect(c.latest.counts.leftBehind).toBe(rows.filter((r) => ["failed", "no-delete-operation"].includes(r.status)).length);

        // Every record created in items was deleted exactly once, by whoever was responsible (the workflow test deletes its own).
        const itemIds = fx.log.filter((l) => l.op === "create" && l.resource === "items").map((l) => l.id);
        for (const id of itemIds) expect(fx.log.filter((l) => l.op === "delete" && l.resource === "items" && l.id === id), `item ${id}`).toHaveLength(1);
    }, 300_000);

    it("a failed cleanup changes neither a test's result nor the job, and the job says what was left behind", async () => {
        const all = await tests(projectId);
        const flaky = all.find((t) => /POST \/api\/flaky: succeeds with a valid request/.test(t.title))!;
        expect(flaky.validationStatus).toBe("VALIDATED");
        const notes = all.find((t) => /POST \/api\/notes: succeeds with a valid request/.test(t.title))!;
        expect(notes.validationStatus).toBe("VALIDATED");
        const job = await latestJob(projectId);
        expect(job.status).not.toBe("FAILED");
        const ev = (await events(job.jobId)).find((e) => e.kind === "cleanup_finished");
        expect(ev.level).toBe("warn");
        expect(ev.message).toMatch(/^Removed \d+ of \d+ records the tests created; \d+ left behind\.$/);
        // The test page says it too.
        const detail = (await call("GET", `/api/tests/${flaky.id}/cleanup`)).body;
        expect(detail.latest.items[0]).toMatchObject({ status: "failed", canRetry: true });
    });

    it("retries only the failed items, with the ids recorded then", async () => {
        const before = (await cleanup(projectId)).latest;
        const failedIds = before.items.filter((i: any) => i.status === "failed").map((i: any) => i.recordId);
        expect(failedIds.length).toBeGreaterThan(0);

        // Still broken: the retry fails again, says so, and sends nothing for the other items.
        fx.log.length = 0;
        const again = await call("POST", `/api/projects/${projectId}/cleanup/retry`);
        expect(again.status, again.text).toBe(200);
        expect(again.body).toMatchObject({ retried: failedIds.length, removed: 0, failedAgain: failedIds.length });
        expect(fx.log.every((l) => l.resource === "flaky")).toBe(true);

        // The application recovers: the retry removes exactly those records.
        fx.flakyHealthy = true;
        fx.log.length = 0;
        const fixed = await call("POST", `/api/projects/${projectId}/cleanup/retry`);
        expect(fixed.body).toMatchObject({ retried: failedIds.length, removed: failedIds.length, failedAgain: 0 });
        expect(fx.log.filter((l) => l.op === "delete").map((l) => l.id).sort()).toEqual([...failedIds].sort());
        expect(fx.log.every((l) => l.resource === "flaky")).toBe(true);
        expect(fx.store.flaky!.size).toBe(0);
        const after = (await cleanup(projectId)).latest;
        expect(after.items.filter((i: any) => i.status === "failed")).toHaveLength(0);
        // Nothing left to retry: a plain answer, not a silent success.
        const none = await call("POST", `/api/projects/${projectId}/cleanup/retry`);
        expect(none.status).toBe(409);
        expect(none.body.error).toMatch(/Nothing to retry/);
        // The records nobody can remove stay in the ledger as such.
        expect(after.items.some((i: any) => i.status === "no-delete-operation")).toBe(true);
    }, 120_000);
});

describe("named environments", () => {
    let projectId = "";

    it("production runs no data-changing test and deletes nothing; staging cleans up with its own credentials", async () => {
        fx.reset();
        projectId = await importProject("Cleanup environments");
        const before = (await cleanup(projectId)).latest.jobId;
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: `http://127.0.0.1:${STAGING_PORT}` })).status).toBe(201);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "production", baseUrl: `http://127.0.0.1:${PROD_PORT}`, production: true })).status).toBe(201);
        await call("PUT", `/api/projects/${projectId}/environments/staging/secrets`, { apiToken: STAGING_TOKEN });
        await call("PUT", `/api/projects/${projectId}/environments/production/secrets`, { apiToken: PROD_TOKEN });

        staging.seed("items", ["900"]);
        const run = await call("POST", `/api/projects/${projectId}/environments/staging/runs`, {});
        expect(run.status, run.text).toBe(202);
        await idle(projectId);
        expect([...staging.store.items!.keys()]).toEqual(["900"]); // everything the tests created on staging is gone, the seed stays
        expect(staging.log.filter((l) => l.op === "create").length).toBeGreaterThan(0);
        expect(staging.deletes().every((d) => d.auth === `Bearer ${STAGING_TOKEN}`)).toBe(true); // the environment's own credentials
        const afterStaging = (await cleanup(projectId)).latest;
        expect(afterStaging.jobId).not.toBe(before);
        expect(afterStaging.environment).toBe("staging");
        expect(afterStaging.counts.leftBehind).toBe(0);

        fx.log.length = 0;
        // Every test here changes data, so a production run has nothing it may do: it is refused, with the reason for each test.
        const prodRun = await call("POST", `/api/projects/${projectId}/environments/production/runs`, { confirmProduction: true });
        expect(prodRun.status, prodRun.text).toBe(422);
        expect(prodRun.text).toMatch(/production is read-only/);
        await idle(projectId);
        expect(prod.log).toHaveLength(0); // nothing was created and nothing was deleted on production
        expect(fx.log).toHaveLength(0);
        expect((await cleanup(projectId)).latest.jobId).toBe(afterStaging.jobId); // production added no ledger rows
    }, 300_000);

    it("a retry never sends anything to production", async () => {
        platform.db.run(
            "INSERT INTO cleanup_ledger (project_id, job_id, test_key, seq, method, path, record_id, delete_path, origin, environment, status, reason, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            projectId, "job-prod", "API-002", 1, "POST", "/api/items", "55", "/api/items/55", `http://127.0.0.1:${PROD_PORT}`, "production", "failed", "x", 1, new Date().toISOString(),
        );
        const r = await call("POST", `/api/projects/${projectId}/cleanup/retry`);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toMatchObject({ removed: 0, failedAgain: 1 });
        expect(prod.log).toHaveLength(0);
        expect(r.body.latest.items[0].reason).toMatch(/Production is read-only/);
    });
});

describe("cleanup switched off", () => {
    it("deletes nothing, lists what stays, and says so plainly", async () => {
        fx.reset();
        const projectId = (await call("POST", "/api/projects", { name: "Cleanup off" })).body.id as string;
        expect((await call("PUT", `/api/projects/${projectId}/cleanup/settings`, { cleanupAfter: false })).body).toEqual({ enabled: false });
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: SPECS, baseUrl: FX, credentials: { apiToken: TOKEN } });
        expect(imported.status, imported.text).toBe(202);
        await idle(projectId);

        expect(fx.store.items!.size).toBe(3); // the records stay in the application (the fourth was deleted by its own test)
        expect(fx.log.filter((l) => l.op === "delete")).toHaveLength(1); // only the lifecycle test's own DELETE
        const c = await cleanup(projectId);
        expect(c.enabled).toBe(false);
        // The lifecycle test deleted its own record; the other three were not removed.
        expect(c.latest.counts).toMatchObject({ created: 4, removed: 1, leftBehind: 3, skipped: 3 });
        expect(c.latest.items.filter((i: any) => i.status === "skipped").every((i: any) => /switched off/.test(i.reason))).toBe(true);
        expect(c.latest.summary).toBe("Cleanup is switched off: 3 records the tests created were left in the application.");
        const ev = (await events((await latestJob(projectId)).jobId)).find((e) => e.kind === "cleanup_finished");
        expect(ev.level).toBe("warn");
        expect((await tests(projectId)).every((t) => t.validationStatus === "VALIDATED")).toBe(true);
        // The option also works per job (generation form): a job that says false wins over a project that says true.
        expect((await call("PUT", `/api/projects/${projectId}/cleanup/settings`, { cleanupAfter: true })).body).toEqual({ enabled: true });
        expect((await call("PUT", `/api/projects/${projectId}/cleanup/settings`, { cleanupAfter: "yes" })).status).toBe(400);
    }, 300_000);
});

describe("what is kept", () => {
    it("holds only ids and paths: no response body, header or token reaches the ledger, the events or the answers", () => {
        const dump = JSON.stringify(platform.db.all("SELECT * FROM cleanup_ledger"));
        expect(dump.length).toBeGreaterThan(100);
        const cleanupEvents = JSON.stringify(platform.db.all("SELECT message, data_json FROM agent_events WHERE kind LIKE 'cleanup_%'"));
        expect(cleanupEvents).toContain("records the tests created");
        for (const secret of [BODY_MARKER, TOKEN, STAGING_TOKEN, PROD_TOKEN, "session-token-not-a-record"]) {
            expect(dump, secret).not.toContain(secret);
            expect(cleanupEvents, secret).not.toContain(secret);
        }
        const columns = Object.keys(platform.db.get("SELECT * FROM cleanup_ledger")!).sort();
        expect(columns).toEqual(["attempts", "cleaned_at", "created_at", "delete_path", "environment", "id", "job_id", "method", "origin", "path", "project_id", "reason", "record_id", "seq", "status", "test_case_id", "test_key"]);
    });

    it("never puts a response body or token into the cleanup answers", async () => {
        const projects = (await call("GET", "/api/projects")).body as Array<{ id: string }>;
        for (const p of projects) {
            const text = (await call("GET", `/api/projects/${p.id}/cleanup`)).text;
            for (const secret of [BODY_MARKER, TOKEN, STAGING_TOKEN, PROD_TOKEN]) expect(text, secret).not.toContain(secret);
        }
    });

    it("prunes ledger rows older than 30 days and keeps newer ones", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Cleanup retention" })).body.id as string;
        const store = new CleanupStore(platform.db);
        const item = (id: string, daysAgo: number) => ({ testId: "API-009", seq: Number(id), method: "POST" as const, path: "/api/items", id, status: "removed" as const, createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });
        store.record({ projectId, jobId: "job-old", items: [item("1", 31)] });
        store.record({ projectId, jobId: "job-new", items: [item("2", 2)] });
        const rows = platform.db.all<{ record_id: string }>("SELECT record_id FROM cleanup_ledger WHERE project_id = ?", projectId);
        expect(rows.map((r) => r.record_id)).toEqual(["2"]);
        expect(store.runs(projectId).map((r) => r.jobId)).toEqual(["job-new"]);
    });
});
