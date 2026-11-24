/**
 * The UX Testing Agent's outcome (Agent Workspace W2b, .scratch/agent-workspace/SPEC.md §3): the health of each page (broken links, script
 * errors, failed requests and the rest of what the page health check found) and, when AI screen review was allowed, its visual notes. Read
 * from what its runs saved: the page health checks (tests of type "health", health/checks.ts messages) and the AI screen reviews (type
 * "vision", vision/specs.ts messages) of its own runs. Nothing else: no accessibility audit, no test scripts, no other agent's run.
 *
 *   GET /api/projects/:id/workspace/ux/outcome[?run=]
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-outcome-ux.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { outcome as ux } from "../src/platform/agent-outcomes/ux.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobStatus, type ValidationState } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";

const KEY = "agent-outcome-ux-key-3f9a";
const SITE = "http://127.0.0.1:7742";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let stopBeat: (() => void) | undefined;
let pid = "";
let empty = "";
const ids: Record<string, string> = {};
let shotId = "";

const call = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
    return { status: r.statusCode, body: JSON.parse(r.body) } as { status: number; body: any };
};

async function project(name: string, agents: string[]): Promise<string> {
    const id = platform.repo.createProject({ name, platforms: ["web"], testingModes: ["agent"] }).id as string;
    await testingAgentsOf(platform).set(id, agents as never, "test");
    platform.repo.createApplication(id, SITE, { ...DEFAULT_JOB_OPTIONS });
    return id;
}
async function run(of: string, agentId: string | undefined, status: JobStatus, error?: string, extra: Partial<JobOptions> = {}) {
    const appId = platform.repo.getLatestApplicationPublic(of)!.id as string;
    const j = await platform.repo.createJob(of, appId, { ...DEFAULT_JOB_OPTIONS, ...(agentId ? { agentId: agentId as never } : {}), ...extra });
    platform.repo.setJobStatus(j.id, status, error);
    return j.id as string;
}
const STEP = { accessibility: { action: "assert", check: "a11y", expected: "serious" }, health: { action: "assert", check: "noBrokenLinks" }, vision: { action: "assert", check: "looksRight", expected: "" } } as const;
let n = 0;
/** One check as the engine stores it: a web test of `type` opening `page`, with its result and reason. */
function check(of: string, jobId: string, type: keyof typeof STEP, page: string, status: ValidationState, reason?: string): string {
    const spec = TestSpecSchema.parse({ testId: `WEB-${String(++n).padStart(3, "0")}`, title: `${type} of ${page}`, kind: "web", category: "Checks", type, steps: [{ action: "navigate", url: page }, STEP[type]] });
    const suite = platform.repo.getOrCreateSuite(of, "Web", "web");
    const id = platform.repo.insertTest({ projectId: of, suiteId: suite, jobId, spec, framework: "playwright", validationStatus: "PENDING", meta: { [type === "vision" ? "vision" : type]: true } });
    if (status !== "PENDING") platform.repo.updateTest(id, { validationStatus: status, reason: reason ?? null });
    return id;
}

const HOME_HEALTH = [
    "Page health check failed: 2 JavaScript errors were reported on this page",
    "- [medium] Uncaught error: cart is not defined",
    "- [medium] console.error: Could not load the basket",
    "1 link on this page is broken (checked 12)",
    "- [medium] /old-offers returned HTTP 404",
    "How to fix: Open the page with the browser's developer console (F12) to see the error, then fix the script that throws it. Fix or remove the listed links so visitors do not land on a missing page.",
].join("\n");
const PRODUCTS_HEALTH = [
    "Page health check failed: 3 requests to this site failed",
    "- [high] GET /api/stock returned HTTP 500",
    "- [medium] GET /img/x.png returned HTTP 404",
    "- ...and 1 more",
    "How to fix: Check the listed addresses.",
].join("\n");
const HOME_LOOK = "AI judgement — please look: a screen may not look right\n- [medium] Step 2 (high confidence): The footer covers the Add to cart button\nHow to check: A vision model judged the attached screenshot, so it can be wrong.";

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outcome-ux-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", SECRET_KEY: "outcome-ux-secret-0123456789" } as never));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();

    pid = await project("UX Store", ["ux", "accessibility", "security"]);
    // An old run that names no agent: its health check counts here, its accessibility audit does not.
    ids.old = await run(pid, undefined, "COMPLETED");
    check(pid, ids.old, "health", "/faq", "VALIDATED");
    check(pid, ids.old, "accessibility", "/faq", "NEEDS_REVIEW", "Accessibility audit failed: 1 WCAG rule violated at \"serious\" impact or above\n- image-alt [critical]: Images must have alternate text (1 node: img)");
    // Run 2: with AI screen review.
    ids.first = await run(pid, "ux", "COMPLETED", undefined, { visionChecks: true });
    check(pid, ids.first, "health", "/", "NEEDS_REVIEW", HOME_HEALTH);
    const look = check(pid, ids.first, "vision", "/", "NEEDS_REVIEW", HOME_LOOK);
    shotId = platform.repo.addArtifact({ projectId: pid, jobId: ids.first, testId: look, kind: "screenshot", path: `${pid}/_artifacts/x/screenshot.png`, size: 10 });
    check(pid, ids.first, "health", "/about", "VALIDATED");
    check(pid, ids.first, "vision", "/about", "VALIDATED");
    check(pid, ids.first, "health", "/cart", "FAILED_VALIDATION", "Could not open /cart: net::ERR_CONNECTION_REFUSED");
    check(pid, ids.first, "vision", "/cart", "FAILED_VALIDATION", "AI judgement could not run: no AI model is set up.");
    // Another agent's run with a health check in it: never part of this outcome.
    ids.security = await run(pid, "security", "COMPLETED");
    check(pid, ids.security, "health", "/admin", "NEEDS_REVIEW", "Page health check failed: 1 link on this page is broken (checked 1)\n- [medium] /x returned HTTP 404");
    // Run 3, stopped, no screen review: /products has problems; /about was not reached again, so it stays healthy.
    ids.stopped = await run(pid, "ux", "FAILED", "Cancelled");
    check(pid, ids.stopped, "health", "/products", "NEEDS_REVIEW", PRODUCTS_HEALTH);
    check(pid, ids.stopped, "health", "/about", "PENDING");

    empty = await project("Fresh Store", ["ux"]);
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const page = (o: any, p: string) => o.pages.find((x: any) => x.path === p);

describe("the UX Testing Agent's outcome", () => {
    it("shows each page's health: broken links and script errors, each problem with its severity", async () => {
        const { status, body } = await call(`/api/projects/${pid}/workspace/ux/outcome`);
        expect(status).toBe(200);
        expect(body.runs).toBe(3);
        expect(body.counts).toEqual({ problems: 2, healthy: 2, notChecked: 1, dismissed: 0 });
        expect(page(body, "/")).toMatchObject({
            state: "problems",
            run: 2,
            jobId: ids.first,
            checks: [
                { check: "noBrokenLinks", summary: "1 link on this page is broken (checked 12)", problems: [{ severity: "medium", text: "/old-offers returned HTTP 404" }] },
                { check: "noConsoleErrors", summary: "2 JavaScript errors were reported on this page", problems: [{ severity: "medium", text: "Uncaught error: cart is not defined" }, { severity: "medium", text: "console.error: Could not load the basket" }] },
            ],
        });
        expect(page(body, "/products").checks).toMatchObject([
            { check: "noFailedRequests", summary: "3 requests to this site failed", problems: [{ severity: "high", text: "GET /api/stock returned HTTP 500" }, { severity: "medium", text: "GET /img/x.png returned HTTP 404" }, { severity: null, text: "...and 1 more" }], advice: "Check the listed addresses: fix the server error or remove/repair the request the page makes to them." },
        ]);
        expect(page(body, "/about")).toMatchObject({ state: "healthy", run: 2, checks: [] });
        expect(page(body, "/cart")).toMatchObject({ state: "not-checked", note: "Could not be checked: Could not open /cart: net::ERR_CONNECTION_REFUSED" });
        expect(body.pages.map((x: any) => x.state)).toEqual(["problems", "problems", "not-checked", "healthy", "healthy"]);
    });

    it("adds the AI screen review's visual notes, with the screenshot, when it was allowed", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/ux/outcome`);
        expect(body.visualReview).toBe(true);
        expect(page(body, "/").visual).toEqual({ state: "please-look", notes: [{ severity: "medium", text: "Step 2 (high confidence): The footer covers the Add to cart button" }], note: null, screenshot: shotId, run: 2, jobId: ids.first });
        expect(page(body, "/about").visual).toMatchObject({ state: "looks-right", notes: [] });
        expect(page(body, "/cart").visual).toMatchObject({ state: "could-not-run", note: "AI judgement could not run: no AI model is set up." });
        expect(page(body, "/products").visual).toBeNull();
    });

    it("holds only this agent's items: no other agent's run, no accessibility audit, no test scripts", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/ux/outcome`);
        expect(body.pages.map((x: any) => x.path)).not.toContain("/admin");
        expect(JSON.stringify(body)).not.toMatch(/image-alt|WCAG|WEB-\d|How to fix/);
        expect(Object.keys(body).sort()).toEqual(["counts", "pages", "runs", "visualReview"]);
    });

    it("shows what one run found (?run=), a stopped run's partial part included", async () => {
        const { status, body } = await call(`/api/projects/${pid}/workspace/ux/outcome?run=${ids.stopped}`);
        expect(status).toBe(200);
        expect(body.pages.map((x: any) => [x.path, x.state, x.run])).toEqual([["/products", "problems", 3], ["/about", "not-checked", 3]]);
        expect(body).toMatchObject({ runs: 1, counts: { problems: 1, healthy: 0, notChecked: 1, dismissed: 0 }, visualReview: false });
        expect((await call(`/api/projects/${pid}/workspace/ux/outcome?run=${ids.security}`)).status).toBe(404);
    });

    it("says one line for the Workspace card, and nothing before a page is checked", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/ux/outcome`);
        expect(ux!.headline(body)).toBe("2 pages with problems, 2 healthy, 1 not checked");
        const ws = await call(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "ux").headline).toBe("2 pages with problems, 2 healthy, 1 not checked");
        const none = await call(`/api/projects/${empty}/workspace/ux/outcome`);
        expect(none.body).toEqual({ runs: 0, pages: [], counts: { problems: 0, healthy: 0, notChecked: 0, dismissed: 0 }, visualReview: false });
        expect(ux!.headline(none.body)).toBeNull();
    });
});

/** A person's "not a bug" on a health check or a screen review (candidate_findings, state not_a_bug), and a low-confidence screen note. */
describe("a person's not a bug, and the screen review's unsure notes", () => {
    let other = "";
    const dismiss = async (of: string, jobId: string, testId: string, reason: string) => {
        const t = platform.repo.getTest(testId)!;
        const store = new CandidateFindingStore(platform.sql);
        const fake = { status: "failed", failedStepIndex: 1, steps: [{ index: 1, title: "2", status: "failed", error: "failed" }], responses: [], error: "failed" } as unknown as ScriptRun;
        const { finding } = await store.upsert({ projectId: of, jobId, testId, finding: executionFinding({ id: t.id, title: t.title, spec: t.spec }, fake) });
        await store.transition(of, finding.id, { to: "not_a_bug", by: "person", actor: { label: "Asha" }, reason });
    };

    beforeAll(async () => {
        other = await project("Dismiss Store", ["ux"]);
        const job = await run(other, "ux", "COMPLETED", undefined, { visionChecks: true });
        await dismiss(other, job, check(other, job, "health", "/old", "NEEDS_REVIEW", PRODUCTS_HEALTH), "The stock service is switched off on this test site.");
        await dismiss(other, job, check(other, job, "vision", "/old", "NEEDS_REVIEW", HOME_LOOK), "The footer is meant to overlap there.");
        check(other, job, "health", "/", "NEEDS_REVIEW", HOME_HEALTH);
        check(other, job, "vision", "/", "VALIDATED", "AI judgement note (not sure): step 2 — the model thought this might look wrong (a cut-off logo) but was not confident, so the test still passes.");
    });

    it("shows a dismissed page with the reason, out of the problem counts", async () => {
        const { body } = await call(`/api/projects/${other}/workspace/ux/outcome`);
        expect(page(body, "/old")).toMatchObject({ state: "dismissed", note: "A person marked this not a bug: The stock service is switched off on this test site.", checks: [{ check: "noFailedRequests" }] });
        expect(page(body, "/old").visual).toMatchObject({ state: "dismissed", note: "A person marked this not a bug: The footer is meant to overlap there.", notes: [{ severity: "medium" }] });
        expect(body.counts).toEqual({ problems: 1, healthy: 0, notChecked: 0, dismissed: 1 });
        expect(ux!.headline(body)).toBe("1 page with problems, 1 dismissed");
    });

    it("keeps the screen review's unsure note on a page that looks right", async () => {
        const { body } = await call(`/api/projects/${other}/workspace/ux/outcome`);
        expect(page(body, "/").visual).toMatchObject({ state: "looks-right", note: expect.stringContaining("a cut-off logo") });
    });
});
