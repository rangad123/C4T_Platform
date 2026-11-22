/**
 * The results card's findings (Phase 3 P3-25, Phase 5 U1). In a real browser against a real platform, on a finished exploration's run
 * page: Confirmed findings first, worst severity first; then the ones that need a person's review; the rest folded by state. Every row
 * shows its status (never "Confirmed" below high confidence, and a person's confirmation of a medium-confidence finding reads "Possible
 * …, needs review"), severity and confidence apart, how often it reproduced ("2 of 3"), its test's steps, thumbnails that open larger,
 * the likely cause with its label (said once above the list while no code source is connected), and the four actions a person who may change tests gets where the lifecycle allows them: Confirm,
 * Not a bug (with a reason), Split, File issue. Everything is reachable from the keyboard. The Phase 3 facts stay: objective, expected
 * result and source, what was observed, evidence, a link to the saved test; an observed-only finding looks different. A person who may
 * only look reads the same with no buttons; a refusal from the server is shown as its sentence; an older run without findings says so.
 * Axe in light and dark, no sideways scroll at phone width. Also the pure rules.
 *
 * Real: the findings and their lifecycle (CandidateFindingStore on the platform's database), the screenshots, the run and its tests,
 * GET /api/projects/:id/candidate-findings, the transition and issue routes, and the issue tracker connection. Stand-ins: the person's
 * access to the project, the refusal, and GitHub (a local server on 9909).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs build,browser -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs build,browser -- npx vitest run tests/findings-ui.test.ts
 * Ports: platform 9908, fake GitHub 9909. SHOTS_DIR=<dir> saves screenshots.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { findingFingerprint } from "../src/engine/explore/finding.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { actionsOf, findingOrder, findingSections, reproductionText, shotAlt, sourceText, type FindingRecord } from "../web/src/features/runs/findings.js";

const PORT = 9908;
const BASE = `http://127.0.0.1:${PORT}`;
const GH_PORT = 9909;
const GH_TOKEN = "ghp_findingsUiToken0123456789";
const SHOTS = process.env.SHOTS_DIR;

const CAPTURED = {
    objective: { id: "OBJ-aaaaaaaaaaaaaaaa", kind: "rule", source: "R-checkout-total", operator: "invalid_input" },
    actions: { stepCount: 6 },
    expected: { text: "The total is the items plus the delivery fee.", source: "R-checkout-total" },
    observed: "The total shows 40.00 for two items of 15.00 and a delivery fee of 5.00.",
    // Two pictures, filled in once they are stored (beforeAll).
    evidence: { screenshots: [] as string[], requests: ["POST /api/orders answered 500"], console: ["Console error: TypeError: total is undefined"] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "R-checkout-total", expected: "The total is the items plus the delivery fee.", scenario: "Order total" }),
    modelVersion: "model-7",
    replays: [{ label: "fresh replay 1", outcome: "failed", failedStep: 6, summary: "Stopped at the total check." }],
};
const OBSERVED = {
    objective: { id: "OBJ-bbbbbbbbbbbbbbbb", kind: "workflow", source: "WF-checkout" },
    actions: { stepCount: 4 },
    expected: { text: "The order is placed once.", source: null },
    observed: "Pressing Place order twice made two orders.",
    evidence: { screenshots: [], requests: ["POST /api/orders answered 201", "POST /api/orders answered 201"], console: [] },
    capture: "observed_only",
    independence: "not_run",
    confidence: "low",
    fingerprint: findingFingerprint({ source: null, expected: "The order is placed once.", scenario: "Submit twice" }),
    modelVersion: "model-7",
    replays: [],
};
/** A verified finding of its own: `name` makes its text and fingerprint unique. */
const verified = (name: string) => ({
    ...CAPTURED,
    objective: { id: `OBJ-${name.padEnd(16, "x").slice(0, 16)}`, kind: "rule", source: `R-${name}` },
    expected: { text: `The ${name} page answers as the rule says.`, source: `R-${name}` },
    observed: `The ${name} page answered something else.`,
    evidence: { screenshots: [], requests: [`GET /api/${name} answered 500`], console: [] },
    fingerprint: findingFingerprint({ source: `R-${name}`, expected: `The ${name} page answers as the rule says.`, scenario: name }),
    replays: [],
});
/** Three attempts, two failing the same way: "2 of 3". */
const ATTEMPTS = [
    { outcome: "failed", failedStep: 2, check: "exactText", target: "Total", value: "25.00", requests: [], stack: [] },
    { outcome: "failed", failedStep: 2, check: "exactText", target: "Total", value: "25.00", requests: [], stack: [] },
    { outcome: "passed", requests: [], stack: [] },
];
const score = (confidence: "high" | "medium" | "low", basis: string) => ({ confidence, basis, factors: {} }) as any;
const STEPS = [
    { action: "navigate", url: "/cart" },
    { action: "navigate", url: "/checkout" },
];

describe("the rules (no browser)", () => {
    it("names where the expected result comes from", () => {
        expect(sourceText("R-checkout-total")).toBe("Stated in R-checkout-total");
        expect(sourceText("expected:2")).toBe("Expected result 2 of the test’s plan");
        expect(sourceText(null)).toBe("No stated source: the AI’s own expectation");
    });
    it("within a state, lists captured findings first, then by confidence, keeping the platform's order otherwise", () => {
        const r = (id: string, capture: "captured" | "observed_only", confidence: "high" | "medium" | "low") => ({ id, capture, confidence }) as FindingRecord;
        expect(findingOrder([r("a", "observed_only", "low"), r("b", "captured", "medium"), r("c", "captured", "high"), r("d", "captured", "medium")]).map((f) => f.id)).toEqual(["c", "b", "d", "a"]);
    });
    it("orders Confirmed by severity, then the ones needing review by severity, then the rest folded by state", () => {
        const RANK: Record<string, number> = { candidate: 1, unconfirmed: 5 };
        const r = (id: string, state: FindingRecord["state"], label: string, severity: "critical" | "high" | "medium" | "low") =>
            ({ id, state, capture: "captured", confidence: "high", review: { label, severity, stateLabel: label, stateRank: RANK[state] ?? 0 } }) as FindingRecord;
        const s = findingSections([
            r("unconf", "unconfirmed", "Unconfirmed", "critical"),
            r("cand-low", "candidate", "Candidate", "low"),
            r("high", "confirmed", "Confirmed high bug", "high"),
            r("nmr-low", "needs_manual_review", "Needs manual review", "low"),
            r("possible", "confirmed", "Possible medium bug, needs review", "medium"),
            r("crit", "reported", "Confirmed critical bug", "critical"),
            r("sec", "confirmed", "Possible high security issue, needs review", "high"),
            r("cand-crit", "candidate", "Candidate", "critical"),
        ]);
        expect(s.confirmed.map((f) => f.id)).toEqual(["crit", "high"]);
        expect(s.review.map((f) => f.id)).toEqual(["sec", "possible", "nmr-low"]);
        expect(s.folded.map((g) => `${g.label}: ${g.findings.map((f) => f.id).join(" ")}`)).toEqual(["Candidate: cand-low cand-crit", "Unconfirmed: unconf"]);
    });
    it("offers only the moves the lifecycle allows a person", () => {
        // The verdicts come from the server's lifecycle check (personMay); split needs a group, File issue a tracker and a filable state.
        const a = (state: FindingRecord["state"], confirm: boolean, notABug: boolean, groupId: string | null = null, tracker = true) =>
            actionsOf({ state, groupId, review: { personMay: { confirm, notABug } } as FindingRecord["review"] }, tracker);
        expect(a("candidate", false, true)).toEqual({ confirm: false, notABug: true, split: false, fileIssue: false });
        expect(a("needs_manual_review", true, true)).toEqual({ confirm: true, notABug: true, split: false, fileIssue: true });
        expect(a("confirmed", false, true, "g1")).toEqual({ confirm: false, notABug: true, split: true, fileIssue: true });
        expect(a("confirmed", false, true, null, false).fileIssue).toBe(false);
        expect(a("reported", false, true).fileIssue).toBe(false);
    });
    it("says how often it reproduced", () => {
        expect(reproductionText({ same: 2, of: 3 })).toBe("Failed the same way 2 of 3 times");
        expect(reproductionText({ same: 1, of: 1 })).toBe("Failed once, not replayed yet");
        expect(reproductionText({ same: 0, of: 0 })).toBe("Not tried yet");
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let gh: http.Server;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let run: string;
let olderRun: string;
let capturedTest: string;
let observedTest: string;
let store: CandidateFindingStore;
const ids = { captured: "", observed: "", crit: "", high: "", possible: "", review: "", unconfirmed: "" };
const issues: Array<{ title: string }> = [];
const consoleErrors: string[] = [];

const fake = {
    /** The person's access to the project (null: as the platform answers). */
    access: null as null | { projectAdmin: boolean; permissions: string[] },
    /** A refusal of the findings (null: the real platform's answer). */
    refusal: null as null | { status: number; json: Record<string, unknown> },
};

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    gh = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            const send = (code: number, obj: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
            if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
            if (req.method === "GET") return send(200, { full_name: "acme/shop", has_issues: true, archived: false });
            if (req.method === "POST" && /\/issues$/.test(req.url!)) {
                issues.push({ title: JSON.parse(raw).title });
                return send(201, { number: issues.length, html_url: `https://github.example/acme/shop/issues/${issues.length}` });
            }
            send(404, { message: "Not Found" });
        });
    });
    await new Promise<void>((r) => gh.listen(GH_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-findings-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "findings-ui-secret-0123456789abcdef", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await call("POST", "/api/projects", { name: "Findings shop", platforms: ["web"], testingModes: ["agent"] })).body.id;
    const appId = platform.repo.createApplication(projectId, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS });
    // A finished exploration with findings in several states, and an older one that found nothing.
    run = (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).id;
    platform.repo.setJobStatus(run, "COMPLETED");
    olderRun = (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).id;
    platform.repo.setJobStatus(olderRun, "COMPLETED");
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Exploration", "exploration");
    const newTest = (testId: string, title: string) =>
        platform.repo.insertTest({ projectId, suiteId, jobId: run, spec: TestSpecSchema.parse({ testId, title, kind: "web", category: "Exploration", priority: "medium", steps: STEPS }), framework: "playwright", validationStatus: "NEEDS_REVIEW" });
    capturedTest = newTest("WEB-001", "Order total includes the delivery fee");
    observedTest = newTest("WEB-002", "Submit the order twice");
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    // Two small JPEG pictures, stored the way RepoSink.saveImageArtifact stores a finding's (row 173).
    for (const n of [1, 2]) {
        await page.setContent(`<h1 style="font:32px sans-serif">Checkout total ${n}</h1>`);
        const jpeg = await page.screenshot({ type: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 320, height: 200 } });
        const rel = path.posix.join(projectId, "_artifacts", run, `WEB-001-finding-${n}.jpg`);
        const saved = await platform.store.put(rel, jpeg, { contentType: "image/jpeg" });
        CAPTURED.evidence.screenshots.push(platform.repo.addArtifact({ projectId, jobId: run, kind: "screenshot", path: rel, size: saved.size }));
    }
    store = new CandidateFindingStore(platform.sql);
    const add = async (code: string, finding: unknown) => (await store.upsert({ projectId, jobId: run, testId: newTest(code, `Finding ${code}`), finding })).finding.id;
    /** Verified by the engine: replayed 2 of 3, with this severity and confidence. */
    const reproduced = async (id: string, severity: string, confidence: "high" | "medium") => {
        await store.transition(projectId, id, { to: "verification_pending", by: "engine" });
        await store.transition(projectId, id, { to: "reproduced", by: "engine", set: { severity, attempts: ATTEMPTS, confidence: score(confidence, confidence === "high" ? "the same failure in 2 of 3 attempts" : "the expectation is the planner's guess") } });
    };
    const person = { label: "Test lead" };
    // Stored critical first and high last, so the platform lists high first; the page puts critical first.
    ids.crit = await add("WEB-010", verified("payments"));
    await reproduced(ids.crit, "critical", "high");
    await store.transition(projectId, ids.crit, { to: "confirmed", by: "engine" });
    ids.high = await add("WEB-011", verified("profile"));
    await reproduced(ids.high, "high", "high");
    await store.transition(projectId, ids.high, { to: "confirmed", by: "engine" });
    await store.group(projectId, [ids.crit, ids.high], { by: "test" });
    // A person confirmed a medium-confidence finding: it must not read "Confirmed".
    ids.possible = await add("WEB-012", verified("search"));
    await reproduced(ids.possible, "medium", "medium");
    await store.transition(projectId, ids.possible, { to: "confirmed", by: "person", actor: person });
    ids.review = await add("WEB-013", verified("coupons"));
    await store.transition(projectId, ids.review, { to: "needs_manual_review", by: "engine", set: { severity: "low", attempts: ATTEMPTS, confidence: score("medium", "the expectation is the planner's guess") } });
    ids.unconfirmed = await add("WEB-014", verified("wishlist"));
    await store.transition(projectId, ids.unconfirmed, { to: "verification_pending", by: "engine" });
    await store.transition(projectId, ids.unconfirmed, { to: "unconfirmed", by: "engine", reason: "No replay failed." });
    // The Phase 3 pair, still candidates. The observed-only one is stored last, so the platform lists it first.
    ids.captured = (await store.upsert({ projectId, jobId: run, testId: capturedTest, finding: CAPTURED })).finding.id;
    ids.observed = (await store.upsert({ projectId, jobId: run, testId: observedTest, finding: OBSERVED })).finding.id;
    const tracker = await call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: `http://127.0.0.1:${GH_PORT}` });
    expect(tracker.status, JSON.stringify(tracker.body)).toBe(201);

    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.route("**/api/me/runner", (route) => route.fulfill({ json: { runner: null } }));
    await page.route(`**/api/projects/${projectId}/candidate-findings?*`, (route) => (fake.refusal ? route.fulfill({ status: fake.refusal.status, json: fake.refusal.json }) : route.continue()));
    await page.route(`**/api/projects/${projectId}`, async (route) => {
        if (route.request().method() !== "GET" || !fake.access) return route.continue();
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), access: fake.access } });
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => gh?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (jobId: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
};
const section = () => page.getByTestId("run-findings");
const findings = () => section().getByTestId("finding");
const row = (observed: string) => findings().filter({ has: page.getByTestId("finding-observed").getByText(observed, { exact: true }) });
const fold = (state: string) => section().locator(`[data-testid="findings-folded"][data-state="${state}"]`);
const openFold = async (state: string) => {
    const d = fold(state);
    if (!(await d.evaluate((el: HTMLDetailsElement) => el.open))) await d.locator(":scope > summary").click();
};
const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
/** Press Tab until `target` has the focus: it is reachable from the keyboard. */
async function tabTo(target: Locator, max = 400) {
    for (let i = 0; i < max; i++) {
        await page.keyboard.press("Tab");
        if (await target.evaluate((el) => el === document.activeElement)) return;
    }
    throw new Error("Not reachable with the Tab key");
}
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}
async function noSidewaysScroll() {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
/** V6: a row reads "Confirmed" only at high confidence; a candidate never reads confirmed. */
async function v6() {
    const n = await findings().count();
    for (let i = 0; i < n; i++) {
        const f = findings().nth(i);
        const status = ((await f.getByTestId("finding-status").textContent()) ?? "").trim();
        if (/^Confirmed\b/.test(status)) expect((await f.getByTestId("finding-confidence").textContent()) ?? "").toMatch(/^High confidence/);
        if ((await f.getAttribute("data-state")) === "candidate") expect(status).toBe("Candidate");
    }
}

describe("a finished exploration with findings", () => {
    it("lists Confirmed first by severity, then Needs manual review, then the rest folded by state", async () => {
        await visit(run);
        await pwExpect(section().getByRole("heading", { level: 2 })).toHaveText("Findings to check (7)");
        const confirmed = section().getByTestId("findings-confirmed");
        await pwExpect(confirmed.locator(":scope > h3")).toHaveText("Confirmed (2)");
        await pwExpect(confirmed.getByTestId("finding-status")).toHaveText(["Confirmed critical bug", "Confirmed high bug"]);
        const review = section().getByTestId("findings-review");
        await pwExpect(review.locator(":scope > h3")).toHaveText("Needs manual review (2)");
        await pwExpect(review.getByTestId("finding-status")).toHaveText(["Possible medium bug, needs review", "Needs manual review"]);
        // The section order on the page.
        const order = await section().locator('[data-testid^="findings-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-testid")}${e.getAttribute("data-state") ? `:${e.getAttribute("data-state")}` : ""}`));
        expect(order).toEqual(["findings-confirmed", "findings-review", "findings-folded:candidate", "findings-folded:unconfirmed"]);
        // Folded: closed until opened.
        await pwExpect(fold("candidate").locator(":scope > summary")).toHaveText("Candidate (2)");
        await pwExpect(fold("unconfirmed").locator(":scope > summary")).toHaveText("Unconfirmed (1)");
        expect(await fold("candidate").evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
        // A verified row: status, severity, confidence apart, "2 of 3", steps, the likely cause with its label.
        const crit = row("The payments page answered something else.");
        await pwExpect(crit.getByTestId("finding-severity")).toHaveText("Critical severity");
        await pwExpect(crit.getByTestId("finding-confidence")).toHaveText("High confidence · failed the same way 2 of 3 times");
        // The reasons for both levels are in the folded details, not on the row.
        await crit.getByText(/^Evidence/).click();
        await pwExpect(crit.getByTestId("finding-reasons").getByRole("listitem")).toHaveText([/^Critical severity/, "High confidence: the same failure in 2 of 3 attempts"]);
        await crit.getByText(/^Evidence/).click();
        // No code source: the likely cause is said once above the list, not on each row; no model line on a row.
        await pwExpect(section().getByTestId("run-findings-no-cause")).toHaveText("Likely cause not shown: no code source is connected to this project, so no code location can be checked.");
        await pwExpect(section().getByTestId("finding-cause")).toHaveCount(0);
        await pwExpect(section()).not.toContainText("model-7");
        await crit.getByTestId("finding-actions").click();
        await pwExpect(crit.getByTestId("finding-steps").getByRole("listitem")).toHaveText(["navigate /cart", "navigate /checkout"]);
        const possible = row("The search page answered something else.");
        await pwExpect(possible.getByTestId("finding-confidence")).toHaveText("Medium confidence · failed the same way 2 of 3 times");
        // The same rule in the answer itself.
        const answer = (await call("GET", `/api/projects/${projectId}/candidate-findings?job=${run}`)).body.findings as FindingRecord[];
        for (const f of answer) if (f.review.label.startsWith("Confirmed")) expect(f.review.confidence).toBe("high");
        await openFold("candidate");
        await v6();
        await shot("findings-desktop");
        await axeBoth();
        await noSidewaysScroll();
        await shot("findings-phone");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 120_000);

    it("a captured finding shows its objective, steps, expected result and source, what was observed, evidence, thumbnails and test", async () => {
        await visit(run);
        await openFold("candidate");
        const f = row(CAPTURED.observed);
        await pwExpect(f).toHaveAttribute("data-capture", "captured");
        await pwExpect(f.getByTestId("finding-status")).toHaveText("Candidate");
        await pwExpect(f.getByTestId("finding-capture")).toHaveText("Captured: kept as a failing check");
        await pwExpect(f.getByTestId("finding-objective")).toHaveText("Rule R-checkout-total · Invalid input");
        await pwExpect(f.getByTestId("finding-actions")).toHaveText("2 steps");
        await pwExpect(f.getByTestId("finding-expected")).toHaveText(CAPTURED.expected.text);
        await pwExpect(f.getByTestId("finding-source")).toHaveText("Stated in R-checkout-total");
        await pwExpect(f.getByTestId("finding-confidence")).toContainText(/^(High|Medium|Low) confidence · ./);
        await pwExpect(f.getByRole("link", { name: /Open the saved test/ })).toHaveAttribute("href", `#/tests/${capturedTest}`);
        // Its two screenshots as thumbnails on the row, each opening larger from the keyboard.
        const shots = f.getByTestId("finding-screenshots").getByRole("img");
        await pwExpect(shots).toHaveCount(2);
        await pwExpect(shots.nth(0)).toHaveAttribute("alt", shotAlt(0, 2));
        await pwExpect(shots.nth(1)).toHaveAttribute("alt", shotAlt(1, 2));
        await pwExpect.poll(() => shots.nth(1).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
        const open = f.getByRole("link", { name: `${shotAlt(0, 2)} Open larger` });
        await open.focus();
        const [larger] = await Promise.all([page.context().waitForEvent("page"), page.keyboard.press("Enter")]);
        await larger.waitForLoadState();
        expect(larger.url()).toContain(`/api/artifacts/${CAPTURED.evidence.screenshots[0]}`);
        expect(await larger.evaluate(() => document.contentType)).toBe("image/jpeg");
        await larger.close();
        // The rest of the evidence: requests and console lines as recorded, behind one disclosure.
        await f.getByText(/^Evidence/).click();
        const ev = f.getByTestId("finding-evidence");
        await pwExpect(ev.getByTestId("finding-requests")).toHaveText(CAPTURED.evidence.requests[0]!);
        await pwExpect(ev.getByTestId("finding-console")).toHaveText(CAPTURED.evidence.console[0]!);
        await pwExpect(ev).toContainText("Replayed from a fresh start: failed at step 6. Stopped at the total check.");
        await pwExpect(f.getByText(/^Evidence/)).toHaveText("Evidence (2 screenshots, 1 request, 1 console line)");
        // A candidate may only be called Not a bug by a person; the engine verifies it first.
        await pwExpect(f.getByRole("button")).toHaveText(["Not a bug"]);
    }, 120_000);

    it("an observed-only finding says so, has no stated source, no screenshot, and looks different", async () => {
        await visit(run);
        await openFold("candidate");
        const f = row(OBSERVED.observed);
        await pwExpect(f).toHaveAttribute("data-capture", "observed_only");
        await pwExpect(f.getByTestId("finding-capture")).toHaveText("Seen, not kept as a check");
        await pwExpect(f.getByTestId("finding-objective")).toHaveText("Workflow WF-checkout");
        await pwExpect(f.getByTestId("finding-source")).toHaveText("No stated source: the AI’s own expectation");
        await pwExpect(f.getByTestId("finding-confidence")).toContainText(/^Low confidence · /);
        await pwExpect(f.getByRole("link", { name: /Open the saved test/ })).toHaveAttribute("href", `#/tests/${observedTest}`);
        await f.getByText(/^Evidence/).click();
        await pwExpect(f.getByTestId("finding-screenshots")).toHaveText("No screenshot was saved for this finding.");
        await pwExpect(f.getByRole("img")).toHaveCount(0);
        // Visibly distinct: an observed-only finding has a dashed border, a captured one a solid border.
        expect(await row(CAPTURED.observed).evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
        expect(await f.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
    }, 60_000);

    it("a person who may only look reads the same findings, with no action to take on them", async () => {
        fake.access = { projectAdmin: false, permissions: ["ai_studio.access", "ai_studio.reports.export"] };
        try {
            await visit(run);
            await pwExpect(findings()).toHaveCount(7);
            await pwExpect(fold("candidate").getByTestId("finding").first()).toBeHidden();
            await openFold("candidate");
            await openFold("unconfirmed");
            await pwExpect(fold("candidate").getByTestId("finding").first()).toBeVisible();
            await pwExpect(section().getByRole("link", { name: /Open the saved test/ })).toHaveCount(7);
            await pwExpect(section().getByRole("button")).toHaveCount(0);
            // The pictures too: reading them needs only read access to the project (finding-screenshot-access.test.ts).
            const pic = row(CAPTURED.observed).getByTestId("finding-screenshots").getByRole("img").first();
            await pwExpect.poll(() => pic.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
            await shot("findings-viewer");
        } finally {
            fake.access = null;
        }
    }, 60_000);

    it("a refusal from the server is shown as its sentence", async () => {
        fake.refusal = { status: 403, json: { error: "You no longer have access to this project's findings." } };
        try {
            await visit(run);
            await pwExpect(section().getByRole("alert")).toHaveText("You no longer have access to this project's findings.");
            await pwExpect(findings()).toHaveCount(0);
        } finally {
            fake.refusal = null;
        }
    }, 60_000);
});

describe("a person's actions, from the keyboard", () => {
    it("Confirm on a medium-confidence finding reads 'Possible …, needs review', never Confirmed", async () => {
        await visit(run);
        const f = row("The coupons page answered something else.");
        await pwExpect(f.getByTestId("finding-status")).toHaveText("Needs manual review");
        await tabTo(f.getByRole("button", { name: "Confirm" }));
        await page.keyboard.press("Enter");
        await pwExpect(f.getByTestId("finding-status")).toHaveText("Possible low bug, needs review");
        await pwExpect(section().getByTestId("findings-confirmed").getByTestId("finding")).toHaveCount(2);
        expect((await store.get(projectId, ids.review))!.state).toBe("confirmed");
        await v6();
    }, 60_000);

    it("Not a bug asks why, and the finding folds under Not a bug", async () => {
        await visit(run);
        await tabTo(fold("candidate").locator(":scope > summary"));
        await page.keyboard.press("Enter");
        await tabTo(row(CAPTURED.observed).getByRole("button", { name: "Not a bug" }));
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Not a bug" });
        await pwExpect(dialog.getByLabel("Why is this not a bug?")).toBeFocused();
        await dialog.getByRole("button", { name: "Not a bug" }).click();
        await pwExpect(dialog.getByRole("alert")).toHaveText("Say why this is not a bug.");
        await shot("findings-not-a-bug");
        await dialog.getByLabel("Why is this not a bug?").fill("The delivery fee is added at payment, as the pricing page says.");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await pwExpect(dialog).toHaveCount(0);
        await pwExpect(fold("not_a_bug").locator(":scope > summary")).toHaveText("Not a bug (1)");
        await pwExpect(fold("candidate").locator(":scope > summary")).toHaveText("Candidate (1)");
        const saved = (await store.history(projectId, ids.captured)).at(-1)!;
        expect([saved.to, saved.by, saved.reason]).toEqual(["not_a_bug", "person", "The delivery fee is added at payment, as the pricing page says."]);
    }, 60_000);

    it("File issue files a confirmed finding once, to the connected tracker", async () => {
        await visit(run);
        const f = row("The payments page answered something else.");
        await tabTo(f.getByRole("button", { name: "File issue" }));
        await page.keyboard.press("Enter");
        await pwExpect(f.getByTestId("finding-issue")).toContainText("Filed as GitHub #1");
        await pwExpect(f.getByTestId("finding-issue").getByRole("link")).toHaveAttribute("href", "https://github.example/acme/shop/issues/1");
        expect(issues).toHaveLength(1);
    }, 60_000);

    it("Split takes a finding out of its group", async () => {
        await visit(run);
        const f = row("The profile page answered something else.");
        const before = (await store.get(projectId, ids.high))!.groupId;
        expect(before).toBe((await store.get(projectId, ids.crit))!.groupId);
        await tabTo(f.getByRole("button", { name: "Split" }));
        await page.keyboard.press("Enter");
        await pwExpect.poll(async () => (await store.get(projectId, ids.high))!.groupId).not.toBe(before);
        expect((await store.get(projectId, ids.crit))!.groupId).toBe(before);
        // Alone in its group now: splitting again is refused with the platform's sentence.
        await f.getByRole("button", { name: "Split" }).click();
        await pwExpect(f.getByRole("alert")).toHaveText("This finding is not grouped with others, so there is nothing to split.");
    }, 60_000);
});

describe("an older run", () => {
    it("without findings says so in one sentence", async () => {
        await visit(olderRun);
        await pwExpect(page.getByTestId("run-findings-none")).toHaveText("This run has no findings to check: the AI found none, or the run is from before findings were recorded.");
        await pwExpect(findings()).toHaveCount(0);
    }, 60_000);

    it("left no console errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
