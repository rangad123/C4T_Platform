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
import { A11Y_ALL_RULES_PREFIX, A11Y_NEEDS_REVIEW_PREFIX, formatA11yAllRules, formatA11yViolations } from "../src/engine/a11y/audit.js";
import { a11yFinding } from "../src/engine/a11y/specs.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";
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
function check(of: string, jobId: string, type: "accessibility" | "health", page: string, status: ValidationState, reason?: string): string {
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
    return id;
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
        expect(body.counts).toEqual({ issues: 2, clean: 2, notChecked: 2, dismissed: 0, needsCheck: 0 });
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
        expect(body.counts).toEqual({ issues: 1, clean: 0, notChecked: 2, dismissed: 0, needsCheck: 0 });
        expect((await call(`/api/projects/${pid}/workspace/accessibility/outcome?run=${ids.security}`)).status).toBe(404);
    });

    it("says one line for the Workspace card, and nothing before a page is checked", async () => {
        const { body } = await call(`/api/projects/${pid}/workspace/accessibility/outcome`);
        expect(accessibility!.headline(body)).toBe("2 pages with issues, 2 clean, 2 not checked");
        const ws = await call(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "accessibility").headline).toBe("2 pages with issues, 2 clean, 2 not checked");
        const none = await call(`/api/projects/${empty}/workspace/accessibility/outcome`);
        expect(none.body).toEqual({ runs: 0, pages: [], rules: [], counts: { issues: 0, clean: 0, notChecked: 0, dismissed: 0, needsCheck: 0 } });
        expect(accessibility!.headline(none.body)).toBeNull();
        expect(accessibility!.headline({ ...none.body, runs: 1, pages: [{ state: "clean" }], counts: { issues: 0, clean: 1, notChecked: 0, dismissed: 0, needsCheck: 0 } } as never)).toBe("1 page clean");
    });
});

/**
 * An Accessibility agent's run audits with every rule kept (a11y/specs.ts allRules): the run's notes list every rule at every impact
 * (formatA11yAllRules), which the validator keeps as a passing test's reason and a11yFinding appends to a failing one's. A person's
 * "not a bug" on a finding of one of these tests (candidate_findings, state not_a_bug) shows the page as dismissed, out of the counts.
 */
describe("every severity, every rule, and a person's not a bug", () => {
    let levels = "";
    const v = (id: string, impact: string, nodes: number) => ({ id, impact, help: `Help for ${id}`, nodes: Array.from({ length: nodes }, (_, i) => ({ target: [`#${id}-${i}`] })) });
    // Seven rules on one page: the failure message names five of them, the full list all seven.
    const many = [v("image-alt", "critical", 2), v("label", "critical", 1), v("color-contrast", "serious", 4), v("link-name", "serious", 1), v("list", "serious", 1), v("html-xml-lang-mismatch", "moderate", 1), v("server-side-image-map", "minor", 3)];
    /** A failed audit as the engine stores it: a11yFinding on a run whose notes carry the full list. */
    const failedReason = (vs: ReturnType<typeof v>[]) => {
        const msg = formatA11yViolations(vs, "serious")!;
        const spec = TestSpecSchema.parse({ testId: "WEB-900", title: "Audit of a page", kind: "web", type: "accessibility", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "a11y", expected: "serious" }] });
        return a11yFinding(spec, { status: "failed", failedStepIndex: 1, steps: [{ index: 1, title: "2", status: "failed", error: msg }], error: msg, notes: formatA11yAllRules(vs), responses: [] } as unknown as ScriptRun)!;
    };
    let dismissedId = "";

    beforeAll(async () => {
        levels = await project("Levels Store", ["accessibility"]);
        const job = await run(levels, "accessibility", "COMPLETED");
        // Passed: only moderate and minor issues, kept as the passing test's reason (validator: the run's notes).
        check(levels, job, "accessibility", "/levels", "VALIDATED", formatA11yAllRules([v("server-side-image-map", "minor", 1), v("html-xml-lang-mismatch", "moderate", 1)])!.join("\n"));
        check(levels, job, "accessibility", "/many", "NEEDS_REVIEW", failedReason(many));
        dismissedId = check(levels, job, "accessibility", "/promo", "NEEDS_REVIEW", failedReason([v("color-contrast", "serious", 2)]));
        const t = platform.repo.getTest(dismissedId)!;
        const store = new CandidateFindingStore(platform.sql);
        const fake = { status: "failed", failedStepIndex: 1, steps: [{ index: 1, title: "2", status: "failed", error: "Accessibility audit failed" }], responses: [], error: "Accessibility audit failed" } as unknown as ScriptRun;
        const { finding } = await store.upsert({ projectId: levels, jobId: job, testId: dismissedId, finding: executionFinding({ id: t.id, title: t.title, spec: t.spec }, fake) });
        await store.transition(levels, finding.id, { to: "not_a_bug", by: "person", actor: { label: "Asha" }, reason: "The promo banner is decorative and hidden from screen readers." });
    });

    it("lists moderate and minor issues too, on a page that passed the serious threshold", async () => {
        const { body } = await call(`/api/projects/${levels}/workspace/accessibility/outcome`);
        expect(page(body, "/levels")).toMatchObject({ state: "issues", moreRules: 0, issues: [{ rule: "html-xml-lang-mismatch", severity: "moderate" }, { rule: "server-side-image-map", severity: "minor" }] });
        expect(body.rules.map((r: any) => r.severity)).toEqual(expect.arrayContaining(["moderate", "minor"]));
    });

    it("names every rule of a failed page, not only the five its failure message names", async () => {
        const { body } = await call(`/api/projects/${levels}/workspace/accessibility/outcome`);
        const p = page(body, "/many");
        expect(p.issues.map((i: any) => i.rule)).toEqual(["image-alt", "label", "color-contrast", "link-name", "list", "html-xml-lang-mismatch", "server-side-image-map"]);
        expect(p.issues.at(-1)).toMatchObject({ severity: "minor", elements: 3, where: "#server-side-image-map-0, #server-side-image-map-1, #server-side-image-map-2" });
        expect(p.moreRules).toBe(0);
        expect(failedReason(many)).toContain(A11Y_ALL_RULES_PREFIX);
    });

    it("shows a page a person marked not a bug as dismissed, with the reason, and leaves it out of the counts", async () => {
        const { body } = await call(`/api/projects/${levels}/workspace/accessibility/outcome`);
        expect(page(body, "/promo")).toMatchObject({ state: "dismissed", note: "A person marked this not a bug: The promo banner is decorative and hidden from screen readers.", issues: [{ rule: "color-contrast" }] });
        expect(body.counts).toEqual({ issues: 2, clean: 0, notChecked: 0, dismissed: 1, needsCheck: 0 });
        // Its rule counts nowhere: color-contrast is broken on /many only.
        expect(body.rules.find((r: any) => r.rule === "color-contrast")).toMatchObject({ pages: 1, elements: 4 });
        expect(accessibility!.headline(body)).toBe("2 pages with issues, 1 dismissed");
        expect(body.pages.map((x: any) => x.state)).toEqual(["issues", "issues", "dismissed"]);
    });
});

/**
 * What axe cannot decide by itself ("needs review", its `incomplete` results) is kept apart (W3): each page lists it as "Needs a person's
 * check", counted on its own, never as an issue, never in the rules broken, and it never fails a page.
 */
describe("items that need a person's check", () => {
    let pid2 = "";
    const v = (id: string, impact: string) => ({ id, impact, help: `Help for ${id}`, nodes: [{ target: [`#${id}`] }] });
    beforeAll(async () => {
        pid2 = await project("Review Store", ["accessibility"]);
        const job = await run(pid2, "accessibility", "COMPLETED");
        // Passed with nothing broken, one item for a person: a clean page.
        check(pid2, job, "accessibility", "/plan", "VALIDATED", formatA11yAllRules([], [v("server-side-image-map", "minor")])!.join("\n"));
        // Failed: its issue counts as an issue, its item for a person does not.
        const msg = formatA11yViolations([v("label", "critical")], "serious")!;
        check(pid2, job, "accessibility", "/form", "NEEDS_REVIEW", [msg, ...formatA11yAllRules([v("label", "critical")], [v("color-contrast", "serious")])!].join("\n"));
    });

    it("lists them per page apart from the issues, counts them on their own, and never as a failure", async () => {
        const { body } = await call(`/api/projects/${pid2}/workspace/accessibility/outcome`);
        expect(page(body, "/plan")).toMatchObject({ state: "clean", issues: [], review: [{ rule: "server-side-image-map", severity: "minor", help: "Help for server-side-image-map", elements: 1, where: "#server-side-image-map" }] });
        expect(page(body, "/form")).toMatchObject({ state: "issues", issues: [{ rule: "label" }], review: [{ rule: "color-contrast", severity: "serious" }] });
        expect(page(body, "/form").issues).toHaveLength(1);
        expect(body.counts).toEqual({ issues: 1, clean: 1, notChecked: 0, dismissed: 0, needsCheck: 2 });
        expect(body.rules.map((r: any) => r.rule)).toEqual(["label"]);
        expect(accessibility!.headline(body)).toBe("1 page with issues, 1 clean, 2 needing a person's check");
    });
});
