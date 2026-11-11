/**
 * Cross-browser and responsive checks ("variants").
 *
 * A web test that is VALIDATED on desktop Chrome can be re-run on Firefox, Safari's engine (WebKit), a phone
 * and a tablet. The base validation is never touched: a variant run only adds a *compatibility result* per
 * (test, variant). A test that passes on Chrome but fails on another variant is a compatibility finding;
 * it does not change the test's own status.
 *
 * "Fails here" and "could not run here" are kept apart on purpose:
 *   passed       the script really ran and passed on that variant
 *   failed       the script really ran and failed (the failing step and evidence are kept)
 *   unavailable  the variant could not run at all (browser not installed or not startable) - says nothing about the app
 *   skipped      the test is not the kind of test that is repeated on other browsers (reason given)
 *
 * Nothing here is simulated: results come from the real Playwright runner, one project per variant.
 */
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";
import { throwIfAborted, type EngineContext } from "../context.js";
import type { RenderContext } from "../generators/index.js";
import { localExecutor, renderWithAdapter, type ScriptExecutor } from "../frameworks/index.js";
import type { GenerationSink, GenerationSummary, TestHandle } from "../orchestrator.js";
import type { TestSpec } from "../spec/schema.js";
import { hasScreenshotStep } from "../visual/baseline.js";
import type { RunEnv, RunnerProject, ScriptRun } from "./runner.js";

// ── The fixed set of variants ───────────────────────────────────────────────

export const VARIANT_IDS = ["chromium-desktop", "firefox", "webkit", "mobile-chrome", "tablet"] as const;
export type VariantId = (typeof VARIANT_IDS)[number];
/** The variants a user can ask for. chromium-desktop is the base run that already happens on every validation. */
export const EXTRA_VARIANT_IDS = ["firefox", "webkit", "mobile-chrome", "tablet"] as const;
export type ExtraVariantId = (typeof EXTRA_VARIANT_IDS)[number];

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface VariantDef {
    id: VariantId;
    /** Plain-language name shown in the UI. */
    label: string;
    description: string;
    browser: BrowserName;
    /** Playwright device profile the project starts from (user agent, touch, pixel density). */
    device: string;
    viewport: { width: number; height: number };
}

export const VARIANTS: Record<VariantId, VariantDef> = {
    "chromium-desktop": { id: "chromium-desktop", label: "Chrome (desktop)", description: "The main validation run.", browser: "chromium", device: "Desktop Chrome", viewport: { width: 1280, height: 800 } },
    firefox: { id: "firefox", label: "Firefox", description: "Mozilla's Firefox engine, on a desktop screen.", browser: "firefox", device: "Desktop Firefox", viewport: { width: 1280, height: 800 } },
    webkit: { id: "webkit", label: "Safari (WebKit)", description: "The engine behind Safari on Mac and iPhone, on a desktop screen.", browser: "webkit", device: "Desktop Safari", viewport: { width: 1280, height: 800 } },
    "mobile-chrome": { id: "mobile-chrome", label: "Phone", description: "A phone-sized screen (390 × 844) with touch and a mobile browser.", browser: "chromium", device: "Pixel 7", viewport: { width: 390, height: 844 } },
    tablet: { id: "tablet", label: "Tablet", description: "A tablet-sized screen (820 × 1180) with touch.", browser: "chromium", device: "Galaxy Tab S4", viewport: { width: 820, height: 1180 } },
};

export const variantLabel = (v: string): string => (v in VARIANTS ? VARIANTS[v as VariantId].label : v);

/** Keep the requested variants that exist, once each, in the canonical order. */
export function normalizeVariants(requested: readonly string[] | undefined): ExtraVariantId[] {
    return EXTRA_VARIANT_IDS.filter((v) => requested?.includes(v));
}

// ── Which browsers this machine has ─────────────────────────────────────────

export type BrowserAvailability = Record<BrowserName, boolean>;
/** Injectable so tests (and other hosts) can say "WebKit is not installed here" without uninstalling it. */
export type DetectBrowsers = () => BrowserAvailability;

/**
 * Looks for each Playwright browser on disk. INSTALLED_BROWSERS_OVERRIDE (comma list, e.g. "chromium,firefox")
 * replaces the check: the platform's tests use it to simulate a machine like the Docker image, which only has Chromium.
 */
export const detectBrowsers: DetectBrowsers = () => {
    const override = process.env.INSTALLED_BROWSERS_OVERRIDE;
    if (override !== undefined && override.trim() !== "") {
        const listed = override.split(",").map((s) => s.trim().toLowerCase());
        return { chromium: listed.includes("chromium"), firefox: listed.includes("firefox"), webkit: listed.includes("webkit") };
    }
    const has = (type: { executablePath(): string }) => {
        try {
            return fs.existsSync(type.executablePath());
        } catch {
            return false;
        }
    };
    return { chromium: has(chromium), firefox: has(firefox), webkit: has(webkit) };
};

export function variantAvailability(v: VariantId, browsers: BrowserAvailability): { available: boolean; reason?: string } {
    const def = VARIANTS[v];
    return browsers[def.browser] ? { available: true } : { available: false, reason: `${browserName(def.browser)} isn't installed on the computer that runs the platform, so this check couldn't run.` };
}
const browserName = (b: BrowserName) => ({ chromium: "Chromium", firefox: "Firefox", webkit: "Safari's engine (WebKit)" })[b];

/** The variants as the UI needs them: what they are, and whether they can run here. */
export function publicVariants(browsers: BrowserAvailability) {
    return EXTRA_VARIANT_IDS.map((id) => ({ id, label: VARIANTS[id].label, description: VARIANTS[id].description, browser: VARIANTS[id].browser, ...variantAvailability(id, browsers) }));
}

// ── Which tests are re-run ──────────────────────────────────────────────────

/** Only a validated, browser-dependent web test is worth repeating on another browser or screen size. */
export function variantEligibility(spec: TestSpec, validationStatus: string): { eligible: true } | { eligible: false; reason: string } {
    if (spec.kind !== "web") return { eligible: false, reason: "Only web tests depend on the browser." };
    if (validationStatus !== "VALIDATED") return { eligible: false, reason: "It hasn't passed in the main run yet, so there is nothing to compare." };
    if (spec.type === "accessibility" || spec.steps.some((s) => s.action === "assert" && s.check === "a11y")) return { eligible: false, reason: "Accessibility audits are checked once, in the main run." };
    if (spec.type === "visual" || hasScreenshotStep(spec)) return { eligible: false, reason: "Visual comparisons use one approved screenshot per browser and screen size, so they aren't repeated." };
    if (spec.type === "security" || spec.tags.some((t) => /^(health|security)$/i.test(t))) return { eligible: false, reason: "Security and health checks don't depend on the browser." };
    return { eligible: true };
}

// ── Reading a variant run ───────────────────────────────────────────────────

export type CompatStatus = "passed" | "failed" | "unavailable" | "skipped";

// Playwright says one of these when it cannot even start the browser; the app was never reached.
const LAUNCH_FAILURE = /browserType\.launch|Executable doesn't exist|npx playwright install|Host system is missing dependencies|Failed to launch/i;

/** Passed, failed, or "could not run here" - the last must never be reported as a failure of the application. */
export function classifyVariantRun(run: ScriptRun, variant: VariantId): { status: CompatStatus; reason?: string } {
    if (run.status === "passed") return { status: "passed" };
    const label = VARIANTS[variant].label;
    if (run.status === "error") return { status: "unavailable", reason: `${label} couldn't run this check: ${firstLine(run.error) || "the run produced no result"}` };
    if (run.steps.length === 0 && LAUNCH_FAILURE.test(run.error ?? "")) return { status: "unavailable", reason: `${label} couldn't be started on this computer: ${firstLine(run.error)}` };
    return { status: "failed", reason: failureReason(run) };
}

const firstLine = (s: string | undefined) => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";

function failureReason(run: ScriptRun): string {
    const step = run.steps.find((s) => s.status === "failed");
    return `${step ? `${step.title} - ` : ""}${firstLine(step?.error ?? run.error) || run.status}`.slice(0, 400);
}

// ── Running the variants ────────────────────────────────────────────────────

export interface VariantTest {
    handle: TestHandle;
    spec: TestSpec;
    /** The test's own (base) validation status. Only VALIDATED tests are compared. */
    validationStatus: string;
    /** The stored script version the runs belong to, when known. */
    scriptId?: string | null;
    /** A hand-written test: its script is run as it is (never rendered from the spec). */
    custom?: { filename: string; content: string };
}

export interface VariantRecord {
    variant: ExtraVariantId;
    status: CompatStatus;
    reason?: string;
    /** The real Playwright result (absent for skipped / unavailable). */
    run?: ScriptRun;
}

export interface VariantDeps {
    scratchDir: string;
    /** Only the web part is used (base URL, credentials, headless). */
    env: RunEnv;
    render: RenderContext;
    workers: number;
    /** Where the scripts run. Default: the job's executor (`ctx.executor`), else this machine. */
    executor?: ScriptExecutor;
    detect?: DetectBrowsers;
    /** Shared helper modules the hand-written tests import (./helpers/<name>). */
    helpers?: Array<{ name: string; content: string }>;
    /** Where the results go; the platform stores each as an execution row tagged with its variant. */
    sink: Pick<GenerationSink, "counters"> & { recordVariant?: GenerationSink["recordVariant"] };
}

export interface VariantSummary {
    /** Tests that were really run on at least one variant (or would have been, had it been available). */
    checked: number;
    /** Tests that pass on desktop Chrome but failed on at least one variant: the compatibility findings. */
    differing: string[];
    /** Tests that passed everywhere they ran, with nothing unavailable. */
    clean: number;
    cells: Record<CompatStatus, number>;
    unavailable: Array<{ variant: ExtraVariantId; reason: string }>;
}

/**
 * Re-run the eligible tests on each requested variant and record every result. Ineligible web tests get a
 * "skipped" record with the reason so the compatibility view explains the gap instead of leaving it blank.
 */
export async function runVariantChecks(ctx: EngineContext, deps: VariantDeps, tests: VariantTest[], requested: readonly string[]): Promise<VariantSummary> {
    const variants = normalizeVariants(requested);
    const summary: VariantSummary = { checked: 0, differing: [], clean: 0, cells: { passed: 0, failed: 0, unavailable: 0, skipped: 0 }, unavailable: [] };
    const startedAt = new Date().toISOString();
    const record = async (t: VariantTest, r: VariantRecord) => {
        summary.cells[r.status]++;
        await deps.sink.recordVariant?.(t.handle, t.scriptId ?? null, r, startedAt);
        ctx.emit({
            stage: "validation",
            kind: `variant_${r.status}`,
            level: r.status === "failed" ? "warn" : "info",
            message: `${t.spec.testId} on ${variantLabel(r.variant)}: ${r.status === "passed" ? "passed" : r.status}${r.reason ? ` (${r.reason.slice(0, 200)})` : ""}`,
            data: { testId: t.spec.testId, variant: r.variant, status: r.status },
        });
    };

    const eligible: VariantTest[] = [];
    for (const t of tests) {
        if (t.spec.kind !== "web") continue; // an API test has no browser; no row, no noise
        const e = variantEligibility(t.spec, t.validationStatus);
        if (e.eligible) eligible.push(t);
        else for (const v of variants) await record(t, { variant: v, status: "skipped", reason: e.reason });
    }
    if (variants.length === 0 || eligible.length === 0) return summary;

    const browsers = (deps.detect ?? detectBrowsers)();
    const runnable: ExtraVariantId[] = [];
    for (const v of variants) {
        const a = variantAvailability(v, browsers);
        if (a.available) {
            runnable.push(v);
            continue;
        }
        summary.unavailable.push({ variant: v, reason: a.reason! });
        for (const t of eligible) await record(t, { variant: v, status: "unavailable", reason: a.reason });
    }

    const perTest = new Map<string, CompatStatus[]>(eligible.map((t) => [t.spec.testId, []]));
    for (const t of eligible) for (let i = 0; i < summary.unavailable.length; i++) perTest.get(t.spec.testId)!.push("unavailable");

    if (runnable.length) {
        throwIfAborted(ctx.signal);
        ctx.emit({ stage: "validation", kind: "variants_started", message: `Checking ${eligible.length} test(s) on ${runnable.map(variantLabel).join(", ")}` });
        const scripts = eligible.map((t) => {
            if (t.custom) return { testId: t.spec.testId, filename: t.custom.filename, content: t.custom.content, custom: true };
            const s = renderWithAdapter(t.spec, "playwright", deps.render);
            return { testId: t.spec.testId, filename: s.filename, content: s.content };
        });
        const projects: RunnerProject[] = runnable.map((v) => ({ name: v, device: VARIANTS[v].device, viewport: VARIANTS[v].viewport }));
        // Firefox and WebKit are heavy: never more than two at once on a small machine.
        const runs = await (deps.executor ?? ctx.executor ?? localExecutor).execute("playwright", { scratchDir: deps.scratchDir, scripts, ...(deps.helpers?.length && eligible.some((t) => t.custom) ? { helpers: deps.helpers } : {}) }, { run: deps.env }, { workers: Math.max(1, Math.min(deps.workers, 2)), signal: ctx.signal, projects });
        const byKey = new Map(runs.map((r) => [`${r.testId}|${r.variant}`, r]));
        for (const t of eligible) {
            for (const v of runnable) {
                const run = byKey.get(`${t.spec.testId}|${v}`);
                const c: { status: CompatStatus; reason?: string } = run ? classifyVariantRun(run, v) : { status: "unavailable", reason: `${variantLabel(v)} returned no result for this test.` };
                perTest.get(t.spec.testId)!.push(c.status);
                await record(t, { variant: v, status: c.status, reason: c.reason, run });
            }
        }
    }

    summary.checked = eligible.length;
    for (const t of eligible) {
        const s = perTest.get(t.spec.testId)!;
        if (s.includes("failed")) summary.differing.push(t.spec.testId);
        else if (s.every((x) => x === "passed")) summary.clean++;
    }
    await deps.sink.counters({ variantChecks: summary.cells.passed + summary.cells.failed, variantFailures: summary.cells.failed });
    ctx.emit({
        stage: "validation",
        kind: "variants_done",
        level: summary.differing.length ? "warn" : "info",
        message: `Browser and screen-size checks: ${summary.cells.passed} passed, ${summary.cells.failed} failed, ${summary.cells.unavailable} could not run, ${summary.cells.skipped} skipped${summary.differing.length ? `; ${summary.differing.length} test(s) behave differently from desktop Chrome` : ""}`,
        data: { ...summary.cells },
    });
    return summary;
}

// ── Job mode "variants": compatibility checks only, no re-validation ────────

export interface VariantsJobRequest {
    url: string;
    credentials?: { username?: string; password?: string };
    /** Named test accounts, for tests that sign in as one of them (signed-in speed checks). */
    roles?: RunEnv["roles"];
    /** The project's test data sets, for tests that name one (rendered once per row). */
    dataSets?: RenderContext["dataSets"];
    /** Shared helper modules the hand-written tests import. */
    helpers?: Array<{ name: string; content: string }>;
}

/**
 * The job that runs when someone asks "check these tests on other browsers". The base status of every test is
 * left exactly as it was; only compatibility results are added.
 */
export async function runVariantsJob(ctx: EngineContext, req: VariantsJobRequest, tests: VariantTest[], variants: readonly string[], sink: GenerationSink, detect?: DetectBrowsers): Promise<GenerationSummary> {
    const summary: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    for (const [status, phase] of [["DISCOVERING", "discovery"], ["ANALYZING", "understanding"], ["PLANNING", "planning"], ["GENERATING", "generation"]] as const) await sink.phase(status, phase, "skipped");
    await sink.phase("VALIDATING", "validation", "running");
    const origin = new URL(req.url).origin;
    const creds = req.credentials?.username && req.credentials.password ? { username: req.credentials.username, password: req.credentials.password } : undefined;
    const result = await runVariantChecks(
        ctx,
        { scratchDir: ctx.config.scratchDir, env: { baseUrl: origin, credentials: creds, roles: req.roles, headless: ctx.config.HEADLESS }, render: { baseUrl: origin, ...(req.dataSets ? { dataSets: req.dataSets } : {}) }, workers: ctx.config.CONCURRENCY, detect, sink, ...(req.helpers?.length ? { helpers: req.helpers } : {}) },
        tests,
        variants,
    );
    // "Generated" = tests that were compared; "validated" = those that behaved the same everywhere they ran;
    // "needing review" = the ones that differ. No test's own validation status is touched.
    summary.testsGenerated = result.checked;
    summary.testsValidated = result.clean;
    summary.testsNeedingReview = result.differing.length;
    for (const u of result.unavailable) summary.errors.push(u.reason);
    if (result.checked === 0) summary.errors.push("None of the selected tests can be checked on other browsers.");
    await sink.counters({ testsGenerated: summary.testsGenerated, testsValidated: summary.testsValidated, testsNeedingReview: summary.testsNeedingReview });
    await sink.phase("VALIDATING", "validation", "done");
    throwIfAborted(ctx.signal);
    return summary;
}
