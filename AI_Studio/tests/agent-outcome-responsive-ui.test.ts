/**
 * The Responsive UI Testing Agent's outcome (Agent Workspace W2c, .scratch/agent-workspace/SPEC.md §3, CONTRACT.md):
 *
 *   - GET /api/projects/:id/workspace/responsive-ui/outcome: a page × screen size grid (desktop from its visual checks, the other sizes
 *     from the browser and screen-size repeats its runs recorded), each cell with its result and the picture kept for it, and the layout
 *     issues: a desktop change only once it is verified, a page that fails on another screen size with its evidence;
 *   - nothing of another agent: the Security run's check in the same project is absent;
 *   - `?run=` answers one run's part, a stopped run's pages included; another agent's run answers 404;
 *   - the Workspace card's headline.
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-outcome-responsive-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";
import { addVariantExecution } from "../src/platform/variants-store.js";

const KEY = "agent-outcome-responsive-key-3e9b";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let pid = "";
const ids: Record<string, string> = {};

const call = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
    return { status: r.statusCode, body: JSON.parse(r.body) } as { status: number; body: any };
};

const visual = (testId: string, page: string) =>
    TestSpecSchema.parse({ testId, title: `Page looks the same as its approved baseline (${page})`, kind: "web", type: "visual", priority: "high", steps: [{ action: "navigate", url: page }, { action: "assert", check: "screenshot", expected: 100 }], expectedResults: ["Same as the baseline."] });
const journey = TestSpecSchema.parse({ testId: "WEB-010", title: "A visitor checks out", kind: "web", type: "functional", priority: "high", steps: [{ action: "navigate", url: "/checkout" }, { action: "click", locator: { by: "role", role: "button", value: "Pay" } }], expectedResults: ["Paid."] });
const headers = TestSpecSchema.parse({ testId: "API-001", title: "Browser security headers are set (/)", kind: "api", type: "security", priority: "medium", steps: [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "securityHeaders" }], expectedResults: ["Set."] });
const failed = (error: string): ScriptRun => ({ testId: "x", status: "failed", durationMs: 10, failedStepIndex: 1, steps: [{ index: 1, title: "screenshot", status: "failed", error }], artifacts: [], responses: [] }) as unknown as ScriptRun;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-rui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "agent-outcome-responsive-0123456789" } as never));
    app = await buildServer(platform);
    await app.ready();

    const repo = platform.repo;
    pid = repo.createProject({ name: "Responsive shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    await testingAgentsOf(platform).set(pid, ["security", "responsive-ui"] as never, "test");
    const appId = repo.createApplication(pid, "http://127.0.0.1:6534", { ...DEFAULT_JOB_OPTIONS });
    const suite = repo.getOrCreateSuite(pid, "General", "general");
    const job = async (agentId: string, extra: Record<string, unknown> = {}) => (await repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, agentId, ...extra } as never)).id;
    ids.first = await job("responsive-ui", { visual: true, variants: ["mobile-chrome", "tablet"] });
    ids.stopped = await job("responsive-ui", { visual: true });
    ids.security = await job("security");
    // An older run that names no agent, with both agents' switches on: it counts for each, and each keeps only its own tests.
    ids.legacy = (await repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, visual: true })).id;
    const add = (jobId: string, s: typeof journey, status: "VALIDATED" | "NEEDS_REVIEW" | "PENDING", meta: Record<string, unknown>, reason?: string) => {
        const id = repo.insertTest({ projectId: pid, suiteId: suite, jobId, spec: s, framework: s.kind === "api" ? "playwright-api" : "playwright", validationStatus: status, meta });
        if (reason) repo.updateTest(id, { reason });
        return id;
    };
    const run = (testId: string, jobId: string, status: string) => repo.addExecution({ testId, scriptId: null, jobId, attempt: 1, status, durationMs: 900, startedAt: new Date().toISOString(), steps: [] });
    const shot = (testId: string, jobId: string, executionId: string | undefined, kind: string) => repo.addArtifact({ projectId: pid, jobId, testId, ...(executionId ? { executionId } : {}), kind, path: `${pid}/_artifacts/${testId}/${kind}.png`, size: 10 });
    const variant = (testId: string, v: string, status: "passed" | "failed" | "skipped" | "unavailable", reason?: string) =>
        addVariantExecution(repo.db, { testId, scriptId: null, jobId: ids.first, variant: v, status, ...(reason ? { reason } : {}), durationMs: 800, startedAt: new Date().toISOString(), steps: [] });

    ids.home = add(ids.first, visual("WEB-001", "/"), "VALIDATED", { visual: true });
    ids.homeShot = shot(ids.home, ids.first, run(ids.home, ids.first, "passed"), "screenshot");
    variant(ids.home, "mobile-chrome", "skipped", "Visual comparisons use one approved screenshot per browser and screen size, so they aren't repeated.");
    variant(ids.home, "tablet", "unavailable", "Tablet couldn't be started on this computer.");
    // On the agent's own phone size the visual check is repeated, and its picture kept on a pass.
    ids.homePhoneShot = shot(ids.home, ids.first, variant(ids.home, "phone-375", "passed"), "screenshot");
    ids.cart = add(ids.first, visual("WEB-002", "/cart"), "NEEDS_REVIEW", { visual: true }, "The page no longer matches its approved baseline: 840 pixels differ.");
    const cartRun = run(ids.cart, ids.first, "failed");
    ids.cartActual = shot(ids.cart, ids.first, cartRun, "visual-actual");
    ids.cartDiff = shot(ids.cart, ids.first, cartRun, "visual-diff");
    ids.about = add(ids.first, visual("WEB-003", "/about"), "NEEDS_REVIEW", { visual: true }, "The page no longer matches its approved baseline: 30 pixels differ.");
    run(ids.about, ids.first, "failed");
    ids.checkout = add(ids.first, journey, "VALIDATED", {});
    run(ids.checkout, ids.first, "passed");
    const phone = variant(ids.checkout, "mobile-chrome", "failed", "Click Pay - the button is covered by the cookie banner");
    ids.phoneShot = shot(ids.checkout, ids.first, phone, "screenshot");
    variant(ids.checkout, "tablet", "passed");
    ids.orders = add(ids.stopped, visual("WEB-004", "/orders"), "PENDING", { visual: true });
    ids.help = add(ids.legacy, visual("WEB-005", "/help"), "PENDING", { visual: true });
    add(ids.legacy, TestSpecSchema.parse({ ...headers, testId: "API-002" }), "VALIDATED", { security: true });
    ids.headers = add(ids.security, headers, "NEEDS_REVIEW", { security: true }, "Security check failed: no CSP.");
    repo.setJobStatus(ids.first, "COMPLETED");
    repo.setJobStatus(ids.stopped, "FAILED", "Cancelled");
    repo.setJobStatus(ids.security, "COMPLETED");
    repo.setJobStatus(ids.legacy, "COMPLETED");

    const store = new CandidateFindingStore(platform.sql);
    const finding = async (testId: string, s: typeof journey, error: string, verified: boolean) => {
        const f = (await store.upsert({ projectId: pid, jobId: ids.first, testId, finding: executionFinding({ id: testId, title: s.title, spec: s }, failed(error)) })).finding;
        await store.transition(pid, f.id, { to: "verification_pending", by: "engine" });
        if (verified) {
            const attempt = { outcome: "failed", failedStep: 2, check: "screenshot", error };
            await store.transition(pid, f.id, { to: "reproduced", by: "engine", set: { severity: "low", attempts: [attempt, attempt] } });
        }
        return f.id;
    };
    ids.cartFinding = await finding(ids.cart, visual("WEB-002", "/cart"), "840 pixels (ratio 0.01 of all image pixels) are different", true);
    ids.aboutFinding = await finding(ids.about, visual("WEB-003", "/about"), "30 pixels (ratio 0.001 of all image pixels) are different", false);
    ids.headersFinding = await finding(ids.headers, headers, "Security check failed: no CSP.", true);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Responsive UI Testing Agent's outcome", () => {
    it("shows each page on each screen size with its picture, and its layout issues, nothing of another agent", async () => {
        const r = await call(`/api/projects/${pid}/workspace/responsive-ui/outcome`);
        expect(r.status).toBe(200);
        const o = r.body;
        expect(o.runs).toBe(3);
        // Narrowest first, desktop last.
        expect(o.viewports.map((v: any) => v.id)).toEqual(["phone-375", "mobile-chrome", "tablet", "desktop"]);
        expect(o.viewports[0]).toMatchObject({ label: "Phone", width: 375, height: 812 });
        expect(o.viewports[1]).toMatchObject({ label: "Phone", width: 390, height: 844 });
        const page = Object.fromEntries(o.pages.map((p: any) => [p.path, p.cells]));
        expect(Object.keys(page)).toEqual(["/", "/cart", "/about", "/orders", "/help", "/checkout"]);
        expect(page["/"].desktop).toMatchObject({ status: "same", shot: ids.homeShot });
        expect(page["/"]["mobile-chrome"]).toMatchObject({ status: "not-checked", shot: null });
        expect(page["/"]["mobile-chrome"].reason).toContain("aren't repeated");
        expect(page["/"].tablet).toMatchObject({ status: "could-not-run" });
        expect(page["/"]["phone-375"]).toMatchObject({ status: "pictured", shot: ids.homePhoneShot });
        expect(page["/cart"].desktop).toMatchObject({ status: "changed", shot: ids.cartActual, diff: ids.cartDiff, finding: { id: ids.cartFinding, label: "Reproduced", verified: true } });
        expect(page["/about"].desktop).toMatchObject({ status: "changed", finding: { label: "Verification pending", verified: false } });
        expect(page["/checkout"].desktop).toMatchObject({ status: "passed" });
        expect(page["/checkout"]["mobile-chrome"]).toMatchObject({ status: "failed", shot: ids.phoneShot });
        expect(page["/checkout"].tablet).toMatchObject({ status: "passed" });
        expect(page["/orders"].desktop).toMatchObject({ status: "not-run", shot: null });

        // Layout issues: the verified desktop change and the phone failure; the change still being verified is not one yet.
        expect(o.issues.map((i: any) => [i.path, i.viewport, i.kind])).toEqual([
            ["/cart", "desktop", "changed"],
            ["/checkout", "mobile-chrome", "fails"],
        ]);
        expect(o.issues[0]).toMatchObject({ testKey: "WEB-002", shots: [ids.cartActual, ids.cartDiff], finding: { id: ids.cartFinding } });
        expect(o.issues[1].reason).toContain("cookie banner");

        const all = JSON.stringify(o);
        expect(all).not.toContain("API-001");
        expect(all).not.toContain("API-002");
        expect(all).not.toContain(ids.headersFinding);
    });

    it("answers one run's part, a stopped run's pages kept, and refuses another agent's run", async () => {
        const first = await call(`/api/projects/${pid}/workspace/responsive-ui/outcome?run=${ids.first}`);
        expect(first.status).toBe(200);
        expect(first.body.pages.map((p: any) => p.path)).toEqual(["/", "/cart", "/about", "/checkout"]);
        expect(first.body.issues).toHaveLength(2);
        const stopped = await call(`/api/projects/${pid}/workspace/responsive-ui/outcome?run=${ids.stopped}`);
        expect(stopped.status).toBe(200);
        expect(stopped.body).toMatchObject({ viewports: [{ id: "desktop" }], pages: [{ path: "/orders", cells: { desktop: { status: "not-run" } } }], issues: [] });
        expect((await call(`/api/projects/${pid}/workspace/responsive-ui/outcome?run=${ids.security}`)).status).toBe(404);
    });

    it("says on the Workspace card what it found", async () => {
        const ws = await call(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "responsive-ui").headline).toBe("2 layout issues, 6 pages on 4 screen sizes");
    });
});
