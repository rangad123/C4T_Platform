/**
 * Phase 3 (P3-25): candidate findings on a finished exploration's run page. In a real browser against a real platform: each finding
 * shows its objective (kind and source), how many actions its test takes, the expected result with its source, what was observed, its
 * evidence (requests and console lines; screenshots are not saved yet, and the page says so), its confidence in words with what that
 * means, and a link to its saved test. Every finding is labelled as found by the AI and needing a person to check; the page never calls
 * one confirmed or a bug. An observed-only finding looks different from a captured one. A person who may only look reads the same; a
 * refusal from the server is shown as its sentence; an older run without findings says so. Axe in light and dark, no sideways scroll
 * at phone width. Also the pure rules.
 *
 * The findings, the run and its tests are real (CandidateFindingStore on the platform's database, GET /api/projects/:id/candidate-findings);
 * the stand-ins are the person's access to the project (as in explore-objectives-ui) and the refusal.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs build,browser -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs build,browser -- npx vitest run tests/candidate-findings-ui.test.ts
 * Ports: platform 9908. SHOTS_DIR=<dir> saves screenshots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { findingFingerprint } from "../src/engine/explore/finding.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { confidenceMeaning, findingOrder, sourceText, type FindingRecord } from "../web/src/features/runs/findings.js";

const PORT = 9908;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;

const CAPTURED = {
    objective: { id: "OBJ-aaaaaaaaaaaaaaaa", kind: "rule", source: "R-checkout-total", operator: "invalid_input" },
    actions: { stepCount: 6 },
    expected: { text: "The total is the items plus the delivery fee.", source: "R-checkout-total" },
    observed: "The total shows 40.00 for two items of 15.00 and a delivery fee of 5.00.",
    evidence: { screenshots: [], requests: ["POST /api/orders answered 500"], console: ["Console error: TypeError: total is undefined"] },
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
const NOT_CONFIRMED = "Found by the AI, needs a person to check";

describe("the rules (no browser)", () => {
    it("says what each confidence means, as the engine states it", () => {
        expect(confidenceMeaning({ confidence: "high", independence: "independent" })).toBe("The expected result has a stated source, the saved test fails at that check, and it failed the same way when replayed from a fresh start.");
        expect(confidenceMeaning({ confidence: "medium", independence: "not_run" })).toBe("The expected result has a stated source and the saved test fails at that check, but it could not be replayed from a fresh start.");
        expect(confidenceMeaning({ confidence: "medium", independence: "state_dependent" })).toBe("The expected result has a stated source and the saved test fails at that check, but replayed from a fresh start it did not fail the same way, so it may depend on what ran before.");
        expect(confidenceMeaning({ confidence: "low", independence: "not_run" })).toBe("The AI saw this while exploring, but no failing check of a stated expected result was kept.");
    });
    it("names where the expected result comes from", () => {
        expect(sourceText("R-checkout-total")).toBe("Stated in R-checkout-total");
        expect(sourceText("expected:2")).toBe("Expected result 2 of the test’s plan");
        expect(sourceText(null)).toBe("No stated source: the AI’s own expectation");
    });
    it("lists captured findings first, then by confidence, keeping the platform's order otherwise", () => {
        const r = (id: string, capture: "captured" | "observed_only", confidence: "high" | "medium" | "low") => ({ id, capture, confidence }) as FindingRecord;
        expect(findingOrder([r("a", "observed_only", "low"), r("b", "captured", "medium"), r("c", "captured", "high"), r("d", "captured", "medium")]).map((f) => f.id)).toEqual(["c", "b", "d", "a"]);
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let run: string;
let olderRun: string;
let capturedTest: string;
let observedTest: string;
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
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-candidate-findings-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "candidate-findings-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await call("POST", "/api/projects", { name: "Findings shop", platforms: ["web"], testingModes: ["agent"] })).body.id;
    const appId = platform.repo.createApplication(projectId, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS });
    // A finished exploration that found two things, and an older one that found nothing.
    run = (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).id;
    platform.repo.setJobStatus(run, "COMPLETED");
    olderRun = (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).id;
    platform.repo.setJobStatus(olderRun, "COMPLETED");
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Exploration", "exploration");
    const newTest = (testId: string, title: string) =>
        platform.repo.insertTest({ projectId, suiteId, jobId: run, spec: TestSpecSchema.parse({ testId, title, kind: "web", category: "Exploration", priority: "high", steps: [{ action: "navigate", url: "/checkout" }] }), framework: "playwright", validationStatus: "NEEDS_REVIEW" });
    capturedTest = newTest("WEB-001", "Order total includes the delivery fee");
    observedTest = newTest("WEB-002", "Submit the order twice");
    const store = new CandidateFindingStore(platform.sql);
    // The observed-only one is stored last, so the platform lists it first; the page still puts the captured one first.
    await store.upsert({ projectId, jobId: run, testId: capturedTest, finding: CAPTURED });
    await store.upsert({ projectId, jobId: run, testId: observedTest, finding: OBSERVED });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
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
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (jobId: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
};
const section = () => page.getByTestId("run-findings");
const findings = () => section().getByTestId("finding");
const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
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
    await page.setViewportSize({ width: 1280, height: 900 });
}
/** Every finding is a candidate: the page never settles it. */
async function neverSettled() {
    const text = (await section().innerText()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/\bconfirmed\b|\bbugs?\b/i);
}

describe("a finished exploration with findings", () => {
    it("a captured finding shows its objective, actions, expected result and source, what was observed, evidence, confidence and test", async () => {
        await visit(run);
        await pwExpect(findings()).toHaveCount(2);
        await pwExpect(section().getByRole("heading", { level: 2 })).toHaveText("Findings to check (2)");
        await pwExpect(section()).toContainText(`${NOT_CONFIRMED}.`);
        const f = findings().first();
        await pwExpect(f).toHaveAttribute("data-capture", "captured");
        await pwExpect(f.getByTestId("finding-status")).toHaveText("Needs a person to check");
        await pwExpect(f.getByTestId("finding-capture")).toHaveText("Kept as a failing check");
        await pwExpect(f.getByTestId("finding-objective")).toHaveText("Rule R-checkout-total · Invalid input");
        await pwExpect(f.getByTestId("finding-actions")).toHaveText("6 actions");
        await pwExpect(f.getByTestId("finding-expected")).toHaveText(CAPTURED.expected.text);
        await pwExpect(f.getByTestId("finding-source")).toHaveText("Stated in R-checkout-total");
        await pwExpect(f.getByTestId("finding-observed")).toHaveText(CAPTURED.observed);
        await pwExpect(f.getByTestId("finding-confidence")).toHaveText(`High confidence: ${confidenceMeaning({ confidence: "high", independence: "independent" })}`);
        const link = f.getByRole("link", { name: /Open the saved test/ });
        await pwExpect(link).toHaveAttribute("href", `#/tests/${capturedTest}`);
        // The evidence: requests and console lines as recorded, behind one disclosure.
        await f.getByText(/^Evidence/).click();
        const ev = f.getByTestId("finding-evidence");
        await pwExpect(ev.getByTestId("finding-requests")).toHaveText(CAPTURED.evidence.requests[0]!);
        await pwExpect(ev.getByTestId("finding-console")).toHaveText(CAPTURED.evidence.console[0]!);
        await pwExpect(ev).toContainText("Replayed from a fresh start: failed at step 6. Stopped at the total check.");
        await neverSettled();
        await shot("findings-captured");
        await axeBoth();
        await noSidewaysScroll();
        await shot("findings-phone");
    }, 120_000);

    it("an observed-only finding says so, has low confidence and no stated source, and looks different", async () => {
        await visit(run);
        const f = findings().nth(1);
        await pwExpect(f).toHaveAttribute("data-capture", "observed_only");
        await pwExpect(f.getByTestId("finding-status")).toHaveText("Needs a person to check");
        await pwExpect(f.getByTestId("finding-capture")).toHaveText("Seen only, not kept as a check");
        await pwExpect(f.getByTestId("finding-objective")).toHaveText("Workflow WF-checkout");
        await pwExpect(f.getByTestId("finding-source")).toHaveText("No stated source: the AI’s own expectation");
        await pwExpect(f.getByTestId("finding-confidence")).toHaveText(`Low confidence: ${confidenceMeaning({ confidence: "low", independence: "not_run" })}`);
        await pwExpect(f.getByRole("link", { name: /Open the saved test/ })).toHaveAttribute("href", `#/tests/${observedTest}`);
        // Visibly distinct: an observed-only finding has a dashed border, a captured one a solid border.
        const border = (n: number) => findings().nth(n).evaluate((el) => getComputedStyle(el).borderTopStyle);
        expect(await border(0)).toBe("solid");
        expect(await border(1)).toBe("dashed");
        await neverSettled();
    }, 60_000);

    it("says plainly that screenshots are not saved with findings yet", async () => {
        await visit(run);
        for (const n of [0, 1]) {
            const f = findings().nth(n);
            await f.getByText(/^Evidence/).click();
            await pwExpect(f.getByTestId("finding-screenshots")).toHaveText("Screenshots are not saved with findings yet.");
        }
        await pwExpect(section().getByRole("img")).toHaveCount(0);
    }, 60_000);

    it("a person who may only look reads the same findings, with no action to take on them", async () => {
        fake.access = { projectAdmin: false, permissions: ["ai_studio.access", "ai_studio.reports.export"] };
        try {
            await visit(run);
            await pwExpect(findings()).toHaveCount(2);
            await pwExpect(findings().first().getByTestId("finding-observed")).toHaveText(CAPTURED.observed);
            await pwExpect(section().getByRole("link", { name: /Open the saved test/ })).toHaveCount(2);
            await pwExpect(section().getByRole("button")).toHaveCount(0);
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

describe("an older run", () => {
    it("without findings says so in one sentence", async () => {
        await visit(olderRun);
        await pwExpect(page.getByTestId("run-findings-none")).toHaveText("This run has no findings to check: the AI found none, or the run is from before findings were recorded.");
        await pwExpect(findings()).toHaveCount(0);
        await shot("findings-older-run");
    }, 60_000);

    it("left no console errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
