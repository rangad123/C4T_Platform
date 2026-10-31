/**
 * Flaky-test quarantine on a real platform.
 *  - seeded part (no browser): runs, executions and statuses written the way the worker writes them, then every gating place is
 *    read through the real API: run summary and alerts, readiness and the fleet dashboard, release sign-off, JUnit, the Tests
 *    list, expiry, release, suggestions, history, refusals, API-key protection, isolation, and "nothing changes without quarantine";
 *  - end-to-end part: the real worker validates imported tests under Playwright against a fixture app whose endpoint can be made
 *    flaky or broken; a deploy trigger, a runbook and the `ai-test` command line (a separate process, real exit code) read the result.
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/quarantine.test.ts
 * Ports: fixture app 5790, platform HTTP server for the command line 5791.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, loadConfig } from "../src/config.js";
import type { CiReport } from "../src/cli/model.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { triggeredEvents, headline } from "../src/platform/alerts.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getRunbookServices, type RunbookServices } from "../src/platform/runbook-runner.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { getRunSummary } from "../src/platform/trends.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";
import { Worker } from "../src/platform/worker.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const API_KEY = "test-api-key-quarantine-01";
const FIXTURE_PORT = 5790;
const HTTP_PORT = 5791;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;
const DAY = 86_400_000;

let dataDir: string;
let work: string;
let platform: Platform;
let svc: ScheduleServices;
let rb: RunbookServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;

/** What the fixture app does on demand. */
let flakyMode: "ok" | "alternate" | "down" = "ok";
let flakyCalls = 0;
let switchOn = true;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quar-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quar-cli-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY, CONCURRENCY: "2", PUBLIC_URL: "https://qa.example.test" }));
    svc = getScheduleServices(platform);
    getTriggerServices(platform, { minGapMs: 50 });
    rb = getRunbookServices(platform, { pollMs: 60, waitUnitMs: 100, heartbeatMs: 400 });
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();

    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (req.url === "/api/ok") return json(200, { ok: true });
        if (req.url === "/api/flaky") {
            const fail = flakyMode === "down" || (flakyMode === "alternate" && ++flakyCalls % 2 === 1);
            return fail ? json(404, { error: "not found" }) : json(200, { ok: true });
        }
        if (req.url === "/api/switch") return switchOn ? json(200, { ok: true }) : json(404, { error: "not found" });
        json(404, { error: "not found" });
    });
    await new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
}, 30_000);

afterAll(async () => {
    await rb?.stop();
    await worker?.stop();
    await svc?.flush();
    await server?.close();
    fixture?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, key = true) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: key ? { "x-api-key": API_KEY } : {} });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
const dashboardOf = async (projectId: string) => (await call("GET", "/api/dashboard")).body.projects.find((p: any) => p.id === projectId);
const quarantine = (projectId: string, body: Record<string, unknown>) => call("POST", `/api/projects/${projectId}/quarantine`, body);
const expireNow = (entryId: string) => platform.db.run("UPDATE quarantine_entries SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), entryId);

// ═══ seeded part ═══════════════════════════════════════════════════════════

/** A test with a chosen spec (the fixture's addTest builds an ordinary API test). */
function addSpecTest(s: Seed, key: string, over: Record<string, unknown>): string {
    const framework = defaultFramework("api");
    const spec = TestSpecSchema.parse({ testId: `API-${String(s.tests.size + 1).padStart(3, "0")}`, title: `Check ${key}`, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }], ...over });
    const suite = platform.repo.getOrCreateSuite(s.projectId, "API", "api");
    const id = platform.repo.insertTest({ projectId: s.projectId, suiteId: suite, jobId: null, spec, framework, validationStatus: "PENDING" });
    s.tests.set(key, id);
    s.scripts.set(key, platform.repo.addScript(id, { framework, filename: `${key}.spec.ts`, content: "v1", hash: `h-${key}`, storagePath: `x/${key}`, executable: true }));
    return id;
}

let shop: Seed;
let other: Seed;
let beforeQuarantine: { summary: unknown; dash: any; tests: unknown };

describe("the shop project, before anything is quarantined", () => {
    it("sets up a flaky test, a stable one and one that will really break", async () => {
        shop = seedProject(platform, "Shop", `http://127.0.0.1:${FIXTURE_PORT}`);
        addTest(platform, shop, "wobbly");
        addTest(platform, shop, "steady");
        addTest(platform, shop, "fragile");
        await seedRun(platform, shop, { wobbly: "flaky", steady: "pass", fragile: "pass" });
        await seedRun(platform, shop, { wobbly: "flaky", steady: "pass", fragile: "pass" });
        const last = await seedRun(platform, shop, { wobbly: "fail", steady: "pass", fragile: "pass" });
        beforeQuarantine = { summary: getRunSummary(platform.db, last.id), dash: await dashboardOf(shop.projectId), tests: (await call("GET", `/api/projects/${shop.projectId}/tests`)).body };
        // with no quarantine, nothing in any answer mentions it
        const text = JSON.stringify(beforeQuarantine);
        expect(text).not.toMatch(/quarantin/i);
        expect(beforeQuarantine.dash.readiness).toMatchObject({ state: "needs-attention" });
        expect(beforeQuarantine.dash.readiness.reasons.map((r: any) => r.text)).toEqual(["1 test failing in the last run", "1 unreliable test"]);
        expect((beforeQuarantine.summary as any).passRate).toBe(66.7);
        expect((beforeQuarantine.summary as any).diff.newlyFailing).toHaveLength(1);
    });

    it("suggests the flaky test with its evidence and nothing else, and never quarantines by itself", async () => {
        const r = await call("GET", `/api/projects/${shop.projectId}/quarantine/suggestions`);
        expect(r.status).toBe(200);
        expect(r.body.suggestions).toHaveLength(1);
        expect(r.body.suggestions[0]).toMatchObject({ testId: shop.tests.get("wobbly"), title: "Check wobbly" });
        expect(r.body.suggestions[0].evidence).toMatch(/^Failed \d+ of the last \d+ runs, passed on re-run twice$/);
        expect(r.body.suggestions[0].suggestedReason).toMatch(/^Passed and failed on identical runs \d+ times$/);
        const view = (await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body;
        expect(view.active).toEqual([]);
        expect(view.summary).toBeNull();
        expect(view.limits).toMatchObject({ defaultDays: 14, maxDays: 60, maxReason: 300 });
    });

    it("says why a test cannot be quarantined, in plain words, with no override", async () => {
        // stable test: not flaky
        const steady = await quarantine(shop.projectId, { testId: shop.tests.get("steady"), by: "Dana" });
        expect(steady.status).toBe(409);
        expect(steady.body.error).toMatch(/not flaky/);
        expect(steady.body.details).toMatchObject({ code: "not-flaky" });
        // a consistent failure: five failing runs in a row
        const lab = seedProject(platform, "Refusals lab");
        addTest(platform, lab, "broken");
        for (let i = 0; i < 5; i++) await seedRun(platform, lab, { broken: "fail" });
        const broken = await quarantine(lab.projectId, { testId: lab.tests.get("broken"), by: "Dana", override: true });
        expect(broken.status).toBe(409);
        expect(broken.body.error).toBe("It failed on each of its last 5 runs. That is a real problem, not flakiness, so it cannot be put in quarantine.");
        // a security check that is flaky, an accessibility audit, a test whose failure is a page-health finding
        for (const [key, over, word] of [
            ["sec", { source: { origin: "security-check" } }, "security"],
            ["a11y", { type: "accessibility" }, "accessibility"],
            ["contract", { source: { origin: "contract-check" } }, "API contract"],
        ] as const) {
            addSpecTest(lab, key, over);
            await seedRun(platform, lab, { [key]: "flaky" });
            await seedRun(platform, lab, { [key]: "flaky" });
            const r = await quarantine(lab.projectId, { testId: lab.tests.get(key), by: "Dana" });
            expect(r.status, key).toBe(409);
            expect(r.body.error, key).toContain(word);
            expect(r.body.error).toMatch(/cannot be put in quarantine/);
            expect(r.body.details).toMatchObject({ code: "protected-family" });
        }
        addTest(platform, lab, "health");
        await seedRun(platform, lab, { health: "flaky" });
        await seedRun(platform, lab, { health: "review:Page health check failed: 1 broken link" });
        expect((await quarantine(lab.projectId, { testId: lab.tests.get("health"), by: "Dana" })).body.error).toContain("page health");
        // none of them were suggested either, and nothing was quarantined
        expect((await call("GET", `/api/projects/${lab.projectId}/quarantine/suggestions`)).body.suggestions).toEqual([]);
        expect((await call("GET", `/api/projects/${lab.projectId}/quarantine`)).body.active).toEqual([]);
    });

    it("checks the request: name, days, reason length, unknown tests, other projects' tests, the API key", async () => {
        const wobbly = shop.tests.get("wobbly");
        expect((await quarantine(shop.projectId, { testId: wobbly })).status).toBe(400);
        expect((await quarantine(shop.projectId, { testId: wobbly, by: "  " })).status).toBe(400);
        expect((await quarantine(shop.projectId, { testId: wobbly, by: "x".repeat(81) })).status).toBe(400);
        expect((await quarantine(shop.projectId, { testId: wobbly, by: "Dana", days: 61 })).status).toBe(400);
        expect((await quarantine(shop.projectId, { testId: wobbly, by: "Dana", days: 0 })).status).toBe(400);
        expect((await quarantine(shop.projectId, { testId: wobbly, by: "Dana", reason: "r".repeat(301) })).status).toBe(400);
        expect((await quarantine(shop.projectId, { testId: "no-such-test", by: "Dana" })).status).toBe(404);
        other = seedProject(platform, "Other shop");
        addTest(platform, other, "theirs");
        expect((await quarantine(shop.projectId, { testId: other.tests.get("theirs"), by: "Dana" })).status).toBe(404);
        expect((await call("POST", `/api/projects/${shop.projectId}/quarantine`, { testId: wobbly, by: "Dana" }, false)).status).toBe(401);
        for (const url of [`/api/projects/${shop.projectId}/quarantine`, `/api/projects/${shop.projectId}/quarantine/suggestions`, `/api/projects/${shop.projectId}/quarantine/history`, `/api/tests/${wobbly}/quarantine`]) expect((await call("GET", url, undefined, false)).status, url).toBe(401);
        expect((await call("GET", "/api/projects/nope/quarantine")).status).toBe(404);
        expect((await call("GET", "/api/tests/nope/quarantine")).status).toBe(404);
        // nothing above created an entry
        expect((await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body.active).toEqual([]);
    });
});

describe("a quarantined test", () => {
    let entryId: string;

    it("is quarantined by a person, with a reason, a name and 14 days by default", async () => {
        const r = await quarantine(shop.projectId, { testId: shop.tests.get("wobbly"), by: "Dana", reason: "Waits on the carousel, fix planned" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        entryId = r.body.id;
        expect(r.body).toMatchObject({ projectId: shop.projectId, testId: shop.tests.get("wobbly"), status: "active", source: "manual", by: "Dana", reason: "Waits on the carousel, fix planned", gating: true, daysLeft: 14 });
        expect(new Date(r.body.expiresAt).getTime() - new Date(r.body.since).getTime()).toBe(14 * DAY);
        // twice is refused
        const again = await quarantine(shop.projectId, { testId: shop.tests.get("wobbly"), by: "Dana" });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/already in quarantine/);
    });

    it("shows in the project view, the Tests list and on the test page, with the history", async () => {
        const view = (await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body;
        expect(view.summary).toBe("1 test is in quarantine and not counted.");
        expect(view.active).toHaveLength(1);
        expect(view.suggestions).toEqual([]); // it is quarantined now, so it is not suggested again
        const tests = (await call("GET", `/api/projects/${shop.projectId}/tests`)).body as any[];
        const wobbly = tests.find((t) => t.title === "Check wobbly");
        expect(wobbly.quarantine).toMatchObject({ reason: "Waits on the carousel, fix planned" });
        expect(wobbly.quarantine.expiresAt).toBeTruthy();
        // still listed, still carrying its real result
        expect(wobbly.validationStatus).toBe("FAILED_VALIDATION");
        expect(tests.filter((t) => t.quarantine)).toHaveLength(1);
        const page = (await call("GET", `/api/tests/${shop.tests.get("wobbly")}/quarantine`)).body;
        expect(page.entry).toMatchObject({ id: entryId, gating: true });
        expect(page.history.map((h: any) => h.kind)).toEqual(["quarantined"]);
        expect(page.history[0]).toMatchObject({ by: "Dana", reason: "Waits on the carousel, fix planned" });
        expect((await call("GET", `/api/tests/${shop.tests.get("wobbly")}`)).body.quarantine).toMatchObject({ reason: "Waits on the carousel, fix planned" });
    });

    it("leaves the readiness: failing and unreliable counts ignore it, and the dashboard says so", async () => {
        const d = await dashboardOf(shop.projectId);
        expect(d.readiness.state).toBe("ready");
        expect(d.readiness.reasons).toEqual([{ code: "quarantined-tests", text: "1 quarantined test is not counted" }]);
        expect(d.quarantine).toMatchObject({ count: 1 });
        expect(d.quarantine.tests[0]).toMatchObject({ testKey: "API-001", title: "Check wobbly", reason: "Waits on the carousel, fix planned" });
        // the real numbers stay what they were
        expect(d.flaky).toBe(beforeQuarantine.dash.flaky);
        // The numbers are unchanged; the sentence about the run now also says that quarantined tests are left out of the pass rate.
        const { sentence: _s, others: _o, ...numbers } = d.latestRun;
        const { sentence: _s0, others: _o0, ...numbersBefore } = beforeQuarantine.dash.latestRun;
        expect(numbers).toEqual(numbersBefore);
        expect(d.latestRun.others).toContain("The pass rate leaves out 1 quarantined test.");
        expect(d.tests).toEqual(beforeQuarantine.dash.tests);
    });

    it("does not lift a quarantine from a second project, and leaves that project untouched", async () => {
        await seedRun(platform, other, { theirs: "fail" });
        const d = await dashboardOf(other.projectId);
        expect(d.readiness.state).toBe("needs-attention");
        expect(JSON.stringify(d)).not.toMatch(/quarantin/i);
        expect((await call("GET", `/api/projects/${other.projectId}/quarantine`)).body.active).toEqual([]);
        expect((await call("POST", `/api/projects/${other.projectId}/quarantine/${entryId}/release`, { by: "Dana" })).status).toBe(404);
        expect((await call("POST", `/api/projects/${other.projectId}/quarantine/${entryId}/review`, { by: "Dana" })).status).toBe(404);
        expect((await call("GET", `/api/projects/${other.projectId}/quarantine/history`)).body.history).toEqual([]);
        expect((await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body.active).toHaveLength(1);
    });

    it("leaves run summaries, the pass rate and the alerts, and the message says so", async () => {
        // wobbly keeps failing; the others pass
        const quiet = await seedRun(platform, shop, { wobbly: "fail", steady: "pass", fragile: "pass" });
        const s1 = getRunSummary(platform.db, quiet.id)!;
        // the real counts stay; the rate and the diff leave the quarantined test out
        expect(s1).toMatchObject({ total: 3, validated: 2, failed: 1, needsReview: 0, passRate: 100, quarantined: { tests: 1, passed: 0, failed: 1, needsReview: 0 } });
        expect(s1.results.filter((r) => r.q).map((r) => r.key)).toEqual(["API-001"]);
        expect(s1.diff).toMatchObject({ newlyFailing: [], stillFailing: [], fixed: [], newFindings: [], flakyPasses: [] });
        expect(triggeredEvents(s1, "low").size).toBe(0);
        const subject = { project: { id: shop.projectId, name: "Shop", url: null }, link: "x" } as never;
        expect(headline(subject, { summary: s1, events: [], newlyFailing: [], recovered: [], flaky: [], failing: [] })).toBe("Shop: run finished. 2 of 2 tests passed (100%) (1 quarantined test ignored).");

        // a test that is not quarantined still gates, next to the quarantined one
        const noisy = await seedRun(platform, shop, { wobbly: "fail", steady: "pass", fragile: "fail" });
        const s2 = getRunSummary(platform.db, noisy.id)!;
        expect(s2).toMatchObject({ passRate: 50, failed: 2, quarantined: { tests: 1 } });
        expect(s2.diff.newlyFailing.map((c) => c.key)).toEqual(["API-003"]);
        const events = triggeredEvents(s2, "low");
        expect([...events.keys()].sort()).toEqual(["regression", "run_failed"]);
        expect(headline(subject, { summary: s2, events: [...events.keys()], newlyFailing: s2.diff.newlyFailing, recovered: [], flaky: [], failing: [{ key: "API-003", title: "Check fragile", id: "x", status: "f" }] })).toBe("Shop: 1 test newly failing. 1 of 2 tests passed (50%) (1 quarantined test ignored).");
        // and the trend uses the same rate
        const trend = (await call("GET", `/api/projects/${shop.projectId}/trends?days=30`)).body;
        expect(trend.runs.at(-1).passRate).toBe(50);
        // a pass on the retry (not a plain failure), so the test does not look like it fails every run
        await seedRun(platform, shop, { wobbly: "flaky", steady: "pass", fragile: "pass" });
    });

    it("keeps a real defect in a non-quarantined test blocking the readiness", async () => {
        await seedRun(platform, shop, { wobbly: "fail", steady: "pass", fragile: "fail" });
        const d = await dashboardOf(shop.projectId);
        expect(d.readiness.state).toBe("needs-attention");
        expect(d.readiness.reasons.map((r: any) => r.text)).toEqual(["1 test failing in the last run", "1 unreliable test", "1 quarantined test is not counted"]); // the unreliable one is the other test, which flips too
        await seedRun(platform, shop, { wobbly: "fail", steady: "pass", fragile: "pass" }); // the real defect is fixed; the flaky test still fails
    });

    it("lists the failing quarantined test in the JUnit file as skipped, not failed", async () => {
        const xml = (await call("GET", `/api/projects/${shop.projectId}/junit`)).body as string;
        expect(xml).toContain('<skipped message="quarantined: Waits on the carousel, fix planned"/>');
        expect(xml).toMatch(/failures="0"/);
        expect(xml).toMatch(/skipped="1"/);
        expect(xml).not.toContain("<failure");
    });

    it("is not hidden from a release approver: sign-off ignores it, the report lists it", async () => {
        const rel = await call("POST", `/api/projects/${shop.projectId}/releases`, { name: "2.0" });
        expect(rel.status, JSON.stringify(rel.body)).toBe(201);
        const view = (await call("GET", `/api/projects/${shop.projectId}/releases/${rel.body.id}`)).body;
        // the quarantined test fails in the last run, yet only the other test's unreliability is held against the project
        expect(view.automated.readiness.reasons.map((r: any) => r.text)).toEqual(["1 unreliable test", "1 quarantined test is not counted"]);
        expect(view.automated.quarantine).toMatchObject({ count: 1 });
        expect(view.automated.quarantine.tests[0]).toMatchObject({ title: "Check wobbly", reason: "Waits on the carousel, fix planned" });
        expect(view.signoff.canApprove).toBe(true);
        expect(view.signoff.warnings.map((w: any) => w.code)).toContain("quarantined-tests");
        const signed = await call("POST", `/api/projects/${shop.projectId}/releases/${rel.body.id}/signoff`, { decision: "approved", by: "Dana" });
        expect(signed.status, JSON.stringify(signed.body)).toBe(200);
        const frozen = (await call("GET", `/api/projects/${shop.projectId}/releases/${rel.body.id}`)).body;
        expect(frozen.automated.quarantine.count).toBe(1);
        const report = (await call("GET", `/api/projects/${shop.projectId}/releases/${rel.body.id}/report?format=html`)).body as string;
        expect(report).toContain("1 quarantined test is not counted above");
        expect(report).toContain("Waits on the carousel, fix planned");
    });

    it("a project with no quarantine gets a release with no mention of it", async () => {
        const rel = await call("POST", `/api/projects/${other.projectId}/releases`, { name: "1.0" });
        const view = (await call("GET", `/api/projects/${other.projectId}/releases/${rel.body.id}`)).body;
        expect(JSON.stringify(view)).not.toMatch(/quarantin/i);
    });

    it("is reviewed and extended, never beyond 60 days", async () => {
        const r = await call("POST", `/api/projects/${shop.projectId}/quarantine/${entryId}/review`, { by: "Sam", extendDays: 30, note: "Still flaky on Fridays" });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ reviewedBy: "Sam" });
        expect(r.body.daysLeft).toBeGreaterThan(14);
        const max = await call("POST", `/api/projects/${shop.projectId}/quarantine/${entryId}/review`, { by: "Sam", extendDays: 60 });
        expect(max.body.daysLeft).toBeLessThanOrEqual(60);
        expect((await call("POST", `/api/projects/${shop.projectId}/quarantine/${entryId}/review`, { by: "Sam", extendDays: 60 })).status).toBe(409);
        expect((await call("POST", `/api/projects/${shop.projectId}/quarantine/${entryId}/review`, { extendDays: 5 })).status).toBe(400);
    });

    it("suggests a release only after ten passing runs in a row, and a person confirms", async () => {
        // the seeded runs are dated in the past; the quarantine began a few days before them
        platform.db.run("UPDATE quarantine_entries SET since = ? WHERE id = ?", new Date(Date.now() - 5 * DAY).toISOString(), entryId);
        let view = (await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body;
        expect(view.active[0].release.suggest).toBe(false);
        for (let i = 0; i < 9; i++) await seedRun(platform, shop, { wobbly: "pass", steady: "pass", fragile: "pass" });
        view = (await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body;
        expect(view.active[0].release).toMatchObject({ suggest: false, passedInARow: 9 });
        await seedRun(platform, shop, { wobbly: "pass", steady: "pass", fragile: "pass" });
        view = (await call("GET", `/api/projects/${shop.projectId}/quarantine`)).body;
        expect(view.active[0].release).toMatchObject({ suggest: true, passedInARow: 10, text: "Passed its last 10 runs. Stable again: release it from quarantine?" });
        expect(view.active[0].status).toBe("active"); // never released by itself
    });

    it("is released early and counts again, and the trail keeps both events", async () => {
        const released = await call("POST", `/api/projects/${shop.projectId}/quarantine/${entryId}/release`, { by: "Dana", note: "Fixed the wait" });
        expect(released.status, JSON.stringify(released.body)).toBe(200);
        expect(released.body).toMatchObject({ status: "released", endedBy: "Dana", gating: false });
        expect((await call("POST", `/api/projects/${shop.projectId}/quarantine/${entryId}/release`, { by: "Dana" })).status).toBe(409);
        const d = await dashboardOf(shop.projectId);
        expect(JSON.stringify(d)).not.toMatch(/quarantin/i);
        const hist = (await call("GET", `/api/projects/${shop.projectId}/quarantine/history?testId=${shop.tests.get("wobbly")}`)).body.history;
        expect(hist.map((h: any) => h.kind)).toEqual(["released", "reviewed", "reviewed", "quarantined"]);
        expect((await call("GET", `/api/projects/${shop.projectId}/quarantine/history`)).body.history.length).toBeGreaterThanOrEqual(4);
    });
});

describe("expiry", () => {
    let late: Seed;
    it("returns the test to gating at read time, and the scheduler tick records it even when nobody looks", async () => {
        late = seedProject(platform, "Late shop");
        const t = addTest(platform, late, "wobbly2");
        await seedRun(platform, late, { wobbly2: "flaky" });
        await seedRun(platform, late, { wobbly2: "flaky" });
        await seedRun(platform, late, { wobbly2: "fail" });
        const made = await quarantine(late.projectId, { testId: t, by: "Dana", days: 3 });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect(made.body.source).toBe("suggested"); // no reason typed: the automatic one
        expect(made.body.reason).toMatch(/^Passed and failed on identical runs \d+ times$/);
        expect((await dashboardOf(late.projectId)).readiness.state).toBe("ready");
        expireNow(made.body.id);
        // read time: no sweep has run, yet the readiness already counts the test again
        expect(platform.db.get("SELECT status FROM quarantine_entries WHERE id = ?", made.body.id)!.status).toBe("active");
        const d = await dashboardOf(late.projectId);
        expect(d.readiness.state).toBe("needs-attention");
        expect(d.readiness.reasons.map((r: any) => r.text)).toEqual(["1 test failing in the last run", "1 unreliable test"]);
        // a summary made now no longer leaves it out
        const s = getRunSummary(platform.db, (await seedRun(platform, late, { wobbly2: "fail" })).id)!;
        expect(s.quarantined).toBeUndefined();
        expect(s.results.find((r) => r.key === "API-001")?.q).toBeUndefined();

        // the tick ends it for the record
        await svc.scheduler.tick();
        expect(platform.db.get("SELECT status, ended_by FROM quarantine_entries WHERE id = ?", made.body.id)).toMatchObject({ status: "expired", ended_by: "system" });
        const page = (await call("GET", `/api/tests/${t}/quarantine`)).body;
        expect(page.entry).toBeNull();
        expect(page.lastEnded).toMatchObject({ status: "expired" });
        expect(page.history.map((h: any) => h.kind)).toEqual(["expired", "quarantined"]);
        // and it can be quarantined again
        expect((await quarantine(late.projectId, { testId: t, by: "Dana", days: 5 })).status).toBe(201);
    });

    it("drops a quarantine whose test now fails every run: a real defect counts again", async () => {
        const t = addTest(platform, late, "turned");
        await seedRun(platform, late, { turned: "flaky" });
        await seedRun(platform, late, { turned: "flaky" });
        const made = await quarantine(late.projectId, { testId: t, by: "Dana" });
        expect(made.status).toBe(201);
        for (let i = 0; i < 5; i++) await seedRun(platform, late, { turned: "fail" });
        const view = (await call("GET", `/api/projects/${late.projectId}/quarantine`)).body;
        const entry = view.active.find((e: any) => e.id === made.body.id);
        expect(entry).toMatchObject({ gating: false });
        expect(entry.note).toMatch(/failed on each of its last 5 runs.*It counts again/);
        const s = getRunSummary(platform.db, (await seedRun(platform, late, { turned: "fail" })).id)!;
        expect(s.results.find((r) => r.key === "API-002")?.q).toBeUndefined();
    });
});

// ═══ the command-line output, from seeded data ═════════════════════════════

describe("the ai-test reports with a quarantined finding", () => {
    it("keeps the exit code, JUnit and SARIF honest", async () => {
        const { collectTests, evaluateGate, summarize, REPORT_SCHEMA_VERSION } = await import("../src/cli/model.js");
        const { renderJunit, renderSarif, renderConsole, renderMarkdown } = await import("../src/cli/render.js");
        const { remoteClient } = await import("../src/cli/client.js");
        const gated = seedProject(platform, "Gate project");
        addTest(platform, gated, "noisy");
        addTest(platform, gated, "solid");
        await seedRun(platform, gated, { noisy: "flaky", solid: "pass" });
        await seedRun(platform, gated, { noisy: "flaky", solid: "pass" });
        await seedRun(platform, gated, { noisy: "review:Something odd happened on the page", solid: "pass" });
        await server.listen({ port: HTTP_PORT, host: "127.0.0.1" });
        const client = remoteClient(`http://127.0.0.1:${HTTP_PORT}`, API_KEY);
        const report = async (): Promise<CiReport> => {
            const tests = await collectTests(client, gated.projectId, { files: false });
            return {
                schemaVersion: REPORT_SCHEMA_VERSION,
                tool: { name: "ai-test" as const, version: "0.0.0" },
                generatedAt: "2026-10-08T00:00:00.000Z",
                mode: "remote-rerun" as const,
                target: "x",
                project: { name: "Gate project" },
                durationMs: 1,
                summary: summarize(tests),
                gate: evaluateGate(tests, "any", true),
                tests,
            };
        };
        // before: the finding gates (exit 1) and the files say so
        const before = await report();
        expect(before.gate.exitCode).toBe(1);
        expect(before.summary).toMatchObject({ findings: 1 });
        expect(before.summary.quarantined).toBeUndefined();
        expect(renderJunit(before)).toContain("<failure");
        expect(JSON.parse(renderSarif(before, { fingerprint: (s) => s })).runs[0].results[0].level).toMatch(/error|warning/);

        const q = await quarantine(gated.projectId, { testId: gated.tests.get("noisy"), by: "Dana", reason: "Flaky on the cookie banner" });
        expect(q.status, JSON.stringify(q.body)).toBe(201);
        const after = await report();
        expect(after.gate).toMatchObject({ passed: true, exitCode: 0, reasons: [] });
        expect(after.summary).toMatchObject({ total: 2, passed: 1, findings: 0, failedValidation: 0, quarantined: 1 });
        expect(after.tests.find((t) => t.testId === "API-001")?.quarantine).toMatchObject({ reason: "Flaky on the cookie banner" });
        const junit = renderJunit(after);
        expect(junit).toContain('<skipped message="quarantined: Flaky on the cookie banner"/>');
        expect(junit).not.toContain("<failure");
        const sarif = JSON.parse(renderSarif(after, { fingerprint: (s) => s }));
        expect(sarif.runs[0].results).toHaveLength(1);
        expect(sarif.runs[0].results[0]).toMatchObject({ level: "note", properties: { quarantined: true } });
        expect(sarif.runs[0].results[0].message.text).toContain("(quarantined: Flaky on the cookie banner)");
        const text = renderConsole(after, []);
        expect(text).toContain("1 quarantined (not counted)");
        expect(text).toContain("[QUARANTINED] API-001");
        expect(renderMarkdown(after)).toContain("Quarantined, not counted");
        // a test that is not quarantined still fails the gate next to it
        addTest(platform, gated, "real");
        await seedRun(platform, gated, { noisy: "fail", solid: "pass", real: "fail" });
        const mixed = await report();
        expect(mixed.gate.exitCode).toBe(1);
        expect(mixed.summary).toMatchObject({ failedValidation: 1, quarantined: 1 });
    }, 60_000);
});

// ═══ end to end with the real worker ═══════════════════════════════════════

const spec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });

async function jobDone(jobId: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (FINAL.includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(250);
    }
}
/** Re-run every test of the project with one retry for failures (a pass after a fail is a flaky pass). */
async function validate(projectId: string, retries = 1) {
    const app = platform.repo.getLatestApplicationPublic(projectId)!;
    const ids = platform.repo.listTests(projectId).map((t) => t.id);
    const job = await platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: ids, retryFailures: retries });
    return jobDone(job.id);
}
async function runDone(projectId: string, runId: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const run = (await call("GET", `/api/projects/${projectId}/runbook-runs/${runId}`)).body;
        if (run.finished) return run;
        if (Date.now() > until) throw new Error("runbook run did not finish");
        await sleep(150);
    }
}
async function idle(projectId: string) {
    for (let i = 0; i < 400; i++) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.every((j) => FINAL.includes(j.status))) return;
        await sleep(250);
    }
    throw new Error("project never became idle");
}
function aiTest(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin/ai-test.mjs"), ...args], { cwd: REPO_ROOT, env: { ...process.env, QKEY: API_KEY, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "", LLM_API_KEY: "" } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => (child.kill(), reject(new Error(`ai-test timed out\n${stdout}\n${stderr}`))), 200_000);
        child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    });
}

describe("end to end: a really flaky endpoint", () => {
    let projectId: string;
    let flakyTest: string;
    let token: string;

    it("imports three tests that pass, then a retry catches the flaky endpoint failing once", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Live shop" })).body.id;
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: FIXTURE, specs: [spec("Ok endpoint", "/api/ok"), spec("Flaky endpoint", "/api/flaky"), spec("Switch endpoint", "/api/switch")] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        expect((await jobDone(imp.body.jobId)).status).toBe("COMPLETED");
        flakyTest = (await call("GET", `/api/projects/${projectId}/tests`)).body.find((t: any) => t.title === "Flaky endpoint").id;
        flakyMode = "alternate";
        flakyCalls = 0;
        const run = await validate(projectId, 1);
        expect(run.status).toBe("COMPLETED"); // the retry passed
        flakyMode = "ok";
        const s = (await call("GET", `/api/projects/${projectId}/quarantine/suggestions`)).body.suggestions;
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({ testId: flakyTest, title: "Flaky endpoint" });
        expect(s[0].evidence).toBe("Failed 1 of the last 3 runs, passed on re-run once");
    }, 300_000);

    it("the person confirms the suggestion", async () => {
        const r = await quarantine(projectId, { testId: flakyTest, by: "Dana", suggested: true, reason: "Passed and failed on identical runs 2 times" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.source).toBe("suggested");
        token = (await call("POST", `/api/projects/${projectId}/triggers`, { label: "CI" })).body.token;
    });

    it("a deploy run passes although the quarantined test now fails, and lists it", async () => {
        flakyMode = "down";
        const run = await call("POST", `/api/triggers/${token}/run`, { commit: "abc1234" }, false);
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        let status: any;
        for (let i = 0; i < 400; i++) {
            status = (await call("GET", `/api/triggers/${token}/status/${run.body.jobId}`, undefined, false)).body;
            if (status.finished) break;
            await sleep(300);
        }
        expect(status).toMatchObject({ state: "passed", passed: true, failures: [], summary: { total: 3, passed: 2, failed: 1, passRate: 100 } });
        expect(status.quarantined).toEqual([expect.objectContaining({ title: "Flaky endpoint" })]);
        expect(status.message).toBe("Passed (1 quarantined test ignored)");
        const summary = (await call("GET", `/api/projects/${projectId}/runs/${run.body.jobId}/summary`)).body;
        expect(summary).toMatchObject({ validated: 2, failed: 1, passRate: 100, quarantined: { tests: 1, failed: 1 } });
        await idle(projectId);
    }, 240_000);

    it("a real defect next to it still fails the run, and names only that one", async () => {
        switchOn = false;
        await sleep(80);
        const run = await call("POST", `/api/triggers/${token}/run`, {}, false);
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        let status: any;
        for (let i = 0; i < 400; i++) {
            status = (await call("GET", `/api/triggers/${token}/status/${run.body.jobId}`, undefined, false)).body;
            if (status.finished) break;
            await sleep(300);
        }
        expect(status).toMatchObject({ state: "failed", passed: false });
        expect(status.failures.map((f: any) => f.title)).toEqual(["Switch endpoint"]);
        expect(status.quarantined.map((f: any) => f.title)).toEqual(["Flaky endpoint"]);
        expect(status.message).toBe("Failed (1 quarantined test ignored)");
        await idle(projectId);
        switchOn = true;
    }, 240_000);

    it("runbook checks ignore it too, and say how many they ignored", async () => {
        await sleep(80);
        const def = { version: 1, name: "Gate", steps: [{ id: "all", type: "run", scope: "all", retries: 0 }, { id: "rate", type: "condition", condition: { check: "passRate", atLeast: 100 }, onFail: "next" }, { id: "none", type: "condition", condition: { check: "noFailures" }, onFail: "next" }] };
        const created = await call("POST", `/api/projects/${projectId}/runbooks`, def);
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const started = await call("POST", `/api/projects/${projectId}/runbooks/${created.body.id}/run`);
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const done = await runDone(projectId, started.body.runId);
        expect(done.steps.map((s: any) => s.status)).toEqual(["passed", "passed", "passed"]);
        expect(done.steps[0].reason).toBe("All 2 tests passed (1 quarantined test ignored).");
        expect(done.steps[1].measured).toBe("100% passed (2 of 2) (1 quarantined test ignored)");
        expect(done.steps[2].measured).toBe("no failing tests (1 quarantined test ignored)");
        expect(done.status).toBe("passed");
        await idle(projectId);
    }, 240_000);

    it("the command line exits 0 with it failing, 1 once a real test fails, and the files say what was ignored", async () => {
        // one more flaky pass (a failure then a retry that passes), so the streak of failures is not "every run"
        flakyMode = "alternate";
        flakyCalls = 0;
        await validate(projectId, 1);
        flakyMode = "down";
        const out = path.join(work, "run.json");
        const junit = path.join(work, "run.xml");
        const common = ["run", "--server", `http://127.0.0.1:${HTTP_PORT}`, "--project", projectId, "--url", FIXTURE, "--api-key-env", "QKEY", "--json", out, "--junit", junit];
        const green = await aiTest(common);
        expect(green.code, green.stdout + green.stderr).toBe(0);
        const report = JSON.parse(fs.readFileSync(out, "utf8"));
        expect(report.summary).toMatchObject({ total: 3, passed: 2, failedValidation: 0, quarantined: 1 });
        expect(report.gate).toMatchObject({ passed: true, exitCode: 0 });
        expect(report.tests.find((t: any) => t.title === "Flaky endpoint")).toMatchObject({ outcome: "failed", quarantine: { reason: "Passed and failed on identical runs 2 times" } });
        expect(fs.readFileSync(junit, "utf8")).toContain('<skipped message="quarantined: Passed and failed on identical runs 2 times"/>');
        expect(green.stdout).toContain("Quarantined");

        switchOn = false;
        const red = await aiTest(common);
        switchOn = true;
        expect(red.code, red.stdout + red.stderr).toBe(1);
        expect(JSON.parse(fs.readFileSync(out, "utf8")).summary).toMatchObject({ failedValidation: 1, quarantined: 1 });
        await idle(projectId);
    }, 480_000);
});
