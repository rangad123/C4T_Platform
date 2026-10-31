/**
 * Visual regression: baseline screenshots of key pages, compared on every later validation.
 *
 * Lifecycle (driven by the validator):
 *  1. First run of a visual test has no baseline → Playwright writes one and fails the test with
 *     "A snapshot doesn't exist". The validator stores the new baseline and immediately re-runs.
 *  2. That re-run is a stability check: a page that renders differently on two consecutive loads
 *     (clocks, carousels, ads) cannot be baselined → FAILED_VALIDATION (unreliable test), not a finding.
 *  3. Later runs compare against the approved baseline. A difference is an application change →
 *     NEEDS_REVIEW with expected / actual / diff images; a reviewer either fixes the app or accepts the
 *     new screenshot as the baseline.
 *
 * Playwright's toHaveScreenshot already retakes screenshots until two consecutive ones match before
 * comparing, so no fixed waits are needed.
 */
import { selectKeyPages } from "../a11y/specs.js";
import type { DraftSpec } from "../api/test-specs.js";
import { signedInPageSteps, signedInPreconditions, signedInTitle, type SignedInPlan } from "../identity/signed-in.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";

/** Differing pixels tolerated by default. Same-browser renders are normally pixel-identical. */
export const DEFAULT_MAX_DIFF_PIXELS = 100;

export function maxDiffPixels(expected: string | number | undefined): number {
    const n = Number(expected);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_DIFF_PIXELS;
}

/** Baseline file name for the screenshot assertion at step `index` (0-based) of a test. */
export function snapshotName(testId: string, index: number): string {
    return `${testId}-${index + 1}.png`;
}

const screenshotStep = (): Step => ({ action: "assert", check: "screenshot", expected: DEFAULT_MAX_DIFF_PIXELS, description: "Page matches its approved baseline screenshot" });

export function generateVisualSpecs(model: AppModel, opts: { maxPages: number; /** Pages only a signed-in account can open (they get signed-in specs instead). */ excludePaths?: ReadonlySet<string> }): DraftSpec[] {
    const skip = opts.excludePaths ?? new Set<string>();
    return selectKeyPages(model, opts.maxPages + skip.size)
        .filter(({ page }) => !skip.has(page.path || "/"))
        .slice(0, opts.maxPages)
        .map(({ page, label, priority }) => {
        const path = page.path || "/";
        const steps: Step[] = [
            { action: "navigate", url: path, description: `Open ${path}` },
            screenshotStep(),
        ];
        return {
            title: `${label ? `${label} page` : "Page"} looks the same as its approved baseline (${path})`,
            description: `Full-page screenshot of "${page.title?.trim() || path}" compared with the approved baseline.`,
            kind: "web",
            category: "Visual",
            type: "visual",
            priority,
            preconditions: [],
            steps,
            expectedResults: ["The page renders identically to its approved baseline screenshot"],
            testData: {},
            tags: ["visual"],
            source: { origin: "visual-baseline" },
        };
    });
}

/**
 * Baselines for pages behind a login: sign in as the account, open the page, compare the screenshot. The stability re-run and
 * the "not visually stable" rule are the validator's and apply unchanged (the sign-in is part of every run).
 */
export function generateSignedInVisualSpecs(plan: SignedInPlan): DraftSpec[] {
    return plan.accounts.flatMap(({ account, pages }) =>
        pages.map((p): DraftSpec => ({
            title: signedInTitle(`${p.label ? `${p.label} page` : "Page"} looks the same as its approved baseline (${p.path})`, account),
            description: `Signs in as ${account.who === "the default account" ? "the project's default account" : `the “${account.who}” account`}, then compares a full-page screenshot of "${p.name}" with the approved baseline.`,
            kind: "web",
            category: "Visual",
            type: "visual",
            priority: p.priority,
            preconditions: signedInPreconditions(account),
            steps: signedInPageSteps(account, plan.form, p.path, [screenshotStep()]),
            expectedResults: ["The page renders identically to its approved baseline screenshot"],
            testData: {},
            tags: ["visual", "signed-in"],
            source: { origin: "visual-baseline" },
        })),
    );
}

export function hasScreenshotStep(spec: TestSpec): boolean {
    return spec.steps.some((s) => s.action === "assert" && s.check === "screenshot");
}

const MISSING = /A snapshot doesn't exist at/i;
const DIFFERENT = /(\d+) pixels? \(ratio [\d.]+ of all image pixels\) (?:are|is) different|Expected an image \d+px by \d+px, received \d+px by \d+px/i;

/** The run failed only because baselines did not exist yet (and Playwright has just written them). */
export function isMissingBaseline(run: ScriptRun): boolean {
    return run.status !== "passed" && MISSING.test(run.error ?? "") && (run.newBaselines?.length ?? 0) > 0;
}

/**
 * When a run failed *because the page no longer matches its baseline*, a concise reason; otherwise
 * undefined (the page did not load, etc. — ordinary failures).
 */
export function visualFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (!hasScreenshotStep(spec)) return undefined;
    const failed = run.steps.find((s) => s.status === "failed");
    const step = failed ? spec.steps[failed.index] : undefined;
    if (!step || step.action !== "assert" || step.check !== "screenshot") return undefined;
    const message = failed?.error ?? run.error ?? "";
    const m = DIFFERENT.exec(message);
    if (!m) return undefined;
    const what = m[1] ? `${m[1]} pixels differ` : "the page size changed";
    return `Visual change: ${what} from the approved baseline (step "${failed!.title}"). Review the diff; accept the new screenshot if the change is intended.`;
}
