/**
 * The Accessibility Testing Agent's outcome (Agent Workspace W2b, .scratch/agent-workspace/SPEC.md §3): the issues on each page, by rule
 * and by severity, and how many pages are clean and how many have issues. Read from what its runs saved: the axe audits (tests of type
 * "accessibility") of its own runs, their result and the audit's own message (a11y/audit.ts formatA11yViolations). Nothing else: no
 * functional tests, no scripts, no other agent's checks.
 *
 *   GET /api/projects/:id/workspace/accessibility/outcome[?run=]
 *
 * Each page's newest result counts (each run grows the outcome); a page a run could not check keeps its older result; a stopped run's
 * audits count too.
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-outcome-accessibility.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { formatA11yViolations } from "../src/engine/a11y/audit.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { outcome as accessibility } from "../src/platform/agent-outcomes/accessibility.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobStatus, type ValidationState } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "agent-outcome-a11y-key-7b2c";
const SITE = "http://127.0.0.1:7741";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let stopBeat: (() => void) | undefined;
let pid = "";
let empty = "";
const ids: Record<string, string> = {};

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
let n = 0;
/** One check as the engine stores it: a web test of `type` opening `page`, with its result and reason. */
function check(of: string, jobId: string, type: "accessibility" | "health", page: string, status: ValidationState, reason?: string) {
    const spec = TestSpecSchema.parse({
        testId: `WEB-${String(++n).padStart(3, "0")}`,
        title: `${type} of ${page}`,
        kind: "web",
        category: type === "health" ? "Health checks" : "Accessibility",
        type,
        steps: [
            { action: "navigate", url: page },
            type === "health" ? { action: "assert", check: "noBrokenLinks" } : { action: "assert", check: "a11y", expected: "serious" },
        ],
    });
    const suite = platform.repo.getOrCreateSuite(of, "Web", "web");
    const id = platform.repo.insertTest({ projectId: of, suiteId: suite, jobId, spec, framework: "playwright", validationStatus: "PENDING", meta: type === "health" ? { health: true } : { accessibility: true } });
    if (status !== "PENDING") platform.repo.updateTest(id, { validationStatus: status, reason: reason ?? null });
}
const audit = (...rules: Array<[string, "critical" | "serious", string, number]>) =>
    formatA11yViolations(rules.map(([id, impact, help, nodes]) => ({ id, impact, help, nodes: Array.from({ length: nodes }, (_, i) => ({ target: [`#el-${i}`] })) })), "serious")!;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outcome-a11y-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", SECRET_KEY: "outcome-a11y-secret-0123456789" } as never));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();

    pid = await project("A11y Store", ["accessibility", "ux", "security"]);
    // An old run that names no agent, with every default switch on: its audit counts here, its health check does not.
    ids.old = await run(pid, undefined, "COMPLETED");
    check(pid, ids.old, "accessibility", "/faq", "VALIDATED");
    check(pid, ids.old, "health", "/faq", "NEEDS_REVIEW", "Page health check failed: 1 link on this page is broken (checked 3)\n- [medium] /gone returned HTTP 404");
    // Run 2: the first of this agent's own runs.
    ids.first = await run(pid, "accessibility", "COMPLETED");
    check(pid, ids.first, "accessibility", "/", "NEEDS_REVIEW", audit(["image-alt", "critical", "Images must have alternate text", 3], ["color-contrast", "serious", "Elements must meet minimum color contrast ratio thresholds", 5]));
    check(pid, ids.first, "accessibility", "/about", "VALIDATED");
    check(pid, ids.first, "accessibility", "/contact", "VALIDATED");
    check(pid, ids.first, "accessibility", "/cart", "FAILED_VALIDATION", "Could not open /cart: net::ERR_CONNECTION_REFUSED\nCall log: …");
    // Another agent's run in the same project: never part of this outcome, even with an audit in it.
    ids.security = await run(pid, "security", "COMPLETED");
    check(pid, ids.security, "accessibility", "/admin", "NEEDS_REVIEW", audit(["label", "critical", "Form elements must have labels", 2]));
    // Run 3, stopped: what it found is kept. /about has an issue now; /contact could not be checked, so its clean result stays.
    ids.stopped = await run(pid, "accessibility", "FAILED", "Cancelled");
    check(pid, ids.stopped, "accessibility", "/about", "NEEDS_REVIEW", audit(["label", "serious", "Form elements must have labels", 1]));
    check(pid, ids.stopped, "accessibility", "/contact", "FAILED_VALIDATION", "Could not open /contact: timeout");
    check(pid, ids.stopped, "accessibility", "/products", "PENDING");

    empty = await project("Fresh Store", ["accessibility"]);
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const page = (o: any, p: string) => o.pages.find((x: any) => x.path === p);

describe("the Accessibility Testing Agent's outcome", () => {
    it("lists each page's issues by rule and severity, and counts clean pages and pages with issues", async () => {
        const { status, body } = await call(`/api/projects/${pid}/workspace/accessibility/outcome`);
        expect(status).toBe(200);
        expect(body.runs).toBe(3);
        expect(body.counts).toEqual({ issues: 2, clean: 2, notChecked: 2 });
        expect(page(body, "/")).toMatchObject({
            state: "issues",
            run: 2,
            jobId: ids.first,
            moreRules: 0,
            issues: [
                { rule: "image-alt", severity: "critical", help: "Images must have alternate text", elements: 3, where: "#el-0, #el-1, #el-2" },
                { rule: "color-contrast", severity: "serious", help: "Elements must meet minimum color contrast ratio thresholds", elements: 5 },
            ],
        });
        expect(page(body, "/faq")).toMatchObject({ state: "clean", run: 1, issues: [] });
        // Worst first: pages with issues, then those not checked, then clean ones.
        expect(body.pages.map((x: any) => x.state)).toEqual(["issues", "issues", "not-checked", "not-checked", "clean", "clean"]);
        // Across pages, one row per rule, worst first.
        expect(body.rules).toEqual([
            { rule: "image-alt", severity: "critical", help: "Images must have alternate text", pages: 1, elements: 3 },
            { rule: "color-contrast", severity: "serious", help: "Elements must meet minimum color contrast ratio thresholds", pages: 1, elements: 5 },
            { rule: "label", severity: "serious", help: "Form elements must have labels", pages: 1, elements: 1 },
        ]);
    });

    it("keeps each page's newest result, and an older result when the newer run could not check the page", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/accessibility/outcome`);
        expect(page(body, "/about")).toMatchObject({ state: "issues", run: 3, jobId: ids.stopped, issues: [{ rule: "label", severity: "serious", elements: 1 }] });
        expect(page(body, "/contact")).toMatchObject({ state: "clean", run: 2 });
        expect(page(body, "/cart")).toMatchObject({ state: "not-checked", note: "Could not be checked: Could not open /cart: net::ERR_CONNECTION_REFUSED" });
        expect(page(body, "/products")).toMatchObject({ state: "not-checked", note: "Not checked yet." });
    });

    it("holds only this agent's items: no other agent's run, no health check, no test scripts", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/accessibility/outcome`);
        expect(body.pages.map((x: any) => x.path)).not.toContain("/admin");
        expect(JSON.stringify(body)).not.toMatch(/broken|\/gone|WEB-\d|Health/);
        expect(Object.keys(body).sort()).toEqual(["counts", "pages", "rules", "runs"]);
    });

    it("shows what one run found (?run=), a stopped run's partial part included", async () => {
        const { status, body } = await call(`/api/projects/${pid}/workspace/accessibility/outcome?run=${ids.stopped}`);
        expect(status).toBe(200);
        expect(body.runs).toBe(1);
        expect(body.pages.map((x: any) => [x.path, x.state, x.run])).toEqual([["/about", "issues", 3], ["/contact", "not-checked", 3], ["/products", "not-checked", 3]]);
        expect(body.counts).toEqual({ issues: 1, clean: 0, notChecked: 2 });
        expect((await call(`/api/projects/${pid}/workspace/accessibility/outcome?run=${ids.security}`)).status).toBe(404);
    });

    it("says one line for the Workspace card, and nothing before a page is checked", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/accessibility/outcome`);
        expect(accessibility!.headline(body)).toBe("2 pages with issues, 2 clean, 2 not checked");
        const ws = await call(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "accessibility").headline).toBe("2 pages with issues, 2 clean, 2 not checked");
        const none = await call(`/api/projects/${empty}/workspace/accessibility/outcome`);
        expect(none.body).toEqual({ runs: 0, pages: [], rules: [], counts: { issues: 0, clean: 0, notChecked: 0 } });
        expect(accessibility!.headline(none.body)).toBeNull();
        expect(accessibility!.headline({ ...none.body, runs: 1, pages: [{ state: "clean" }], counts: { issues: 0, clean: 1, notChecked: 0 } } as never)).toBe("1 page clean");
    });
});
