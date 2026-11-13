/**
 * Deterministic page-speed specs (no LLM): one "performance" spec per important anonymous page = open the page and
 * assert `pageSpeed` (median of 3 cold loads against budgets). Also classifies a failed run as an application finding.
 */
import { selectKeyPages } from "../a11y/specs.js";
import type { DraftSpec } from "../api/test-specs.js";
import { signedInBudgets, signedInPageSteps, signedInPreconditions, signedInTitle, type SignedInPlan } from "../identity/signed-in.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { PERFORMANCE_ADVICE, PERFORMANCE_FAILURE_PREFIX, worstPerfTag, type PerfSample } from "./checks.js";

export interface PerformanceGenOptions {
    maxPages: number;
    /** Times the usual per-type limit of key pages (engine/levels perTypeScale); default 1. */
    perTypeScale?: number;
    /** Budget overrides, e.g. "lcp:3000 weight:5000000"; "slow-4g" throttles. Goes into each spec's `expected`. */
    budgets?: string;
    /** Pages only a signed-in account can open: they get signed-in specs instead (see generateSignedInPerformanceSpecs). */
    excludePaths?: ReadonlySet<string>;
}

/** The speed step's own wording, shared by the anonymous and the signed-in spec. */
const speedStep = (expected: string | undefined): Step => ({ action: "assert", check: "pageSpeed", ...(expected ? { expected } : {}), description: "The page loads within its speed budgets (median of 3 fresh loads)" });

export function generatePerformanceSpecs(model: AppModel, opts: PerformanceGenOptions): DraftSpec[] {
    const skip = opts.excludePaths ?? new Set<string>();
    // Ask for enough pages that dropping the signed-in-only ones still leaves maxPages.
    return selectKeyPages(model, opts.maxPages + skip.size, opts.perTypeScale)
        .filter(({ page }) => !skip.has(page.path || "/"))
        .slice(0, opts.maxPages)
        .map(({ page, label, priority }) => {
        const path = page.path || "/";
        const name = page.title?.trim() || path;
        const steps: Step[] = [
            { action: "navigate", url: path, description: `Open ${path}` },
            speedStep(opts.budgets),
        ];
        return {
            title: `${label ? `${label} page` : "Page"} loads quickly (${path})`,
            description: `Loads "${name}" three times from scratch and compares the median server response, first and main content, layout stability, page weight and request count with the budgets.`,
            kind: "web",
            category: "Performance",
            type: "performance",
            priority,
            preconditions: [],
            steps,
            expectedResults: ["Main content appears within 2.5 s, the layout stays stable, and the page stays within its weight and request budgets"],
            testData: {},
            tags: ["performance"],
            source: { origin: "performance-check" },
        };
    });
}

/**
 * Speed specs for pages behind a login: sign in as the account, open the page, measure it with the session carried into the
 * fresh measurement contexts. Same category and origin as the anonymous ones, so findings, history and severity work unchanged.
 */
export function generateSignedInPerformanceSpecs(plan: SignedInPlan, opts: { budgets?: string }): DraftSpec[] {
    return plan.accounts.flatMap(({ account, pages }) =>
        pages.map((p): DraftSpec => ({
            title: signedInTitle(`${p.label ? `${p.label} page` : "Page"} loads quickly (${p.path})`, account),
            description: `Signs in as ${account.who === "the default account" ? "the project's default account" : `the “${account.who}” account`}, then loads "${p.name}" three times from scratch (each time with the same session) and compares the median server response, first and main content, layout stability, page weight and request count with the budgets.`,
            kind: "web",
            category: "Performance",
            type: "performance",
            priority: p.priority,
            preconditions: signedInPreconditions(account),
            steps: signedInPageSteps(account, plan.form, p.path, [speedStep(signedInBudgets(opts.budgets))]),
            expectedResults: ["Main content appears within 2.5 s, the layout stays stable, and the page stays within its weight and request budgets"],
            testData: {},
            tags: ["performance", "signed-in"],
            source: { origin: "performance-check" },
        })),
    );
}

/** The failure text of the page-speed step, minus any call log Playwright appended. */
function ownMessage(text: string): string | undefined {
    const at = text.indexOf(PERFORMANCE_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/**
 * When `run` failed because a budget was exceeded (the failing step is the page-speed assert and its error is the
 * check's own message) return the finding with how to fix it; otherwise undefined — e.g. the page did not load.
 */
export function performanceFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isStep = (s: Step | undefined) => s?.action === "assert" && s.check === "pageSpeed";
    let message: string | undefined;
    for (const st of run.steps) {
        if (st.status === "failed" && isStep(spec.steps[st.index])) message = ownMessage(st.error ?? "") ?? message;
    }
    if (!message && run.steps.length === 0 && spec.steps.some(isStep)) message = ownMessage(run.error ?? "");
    return message ? `${message}\nHow to fix: ${PERFORMANCE_ADVICE}`.slice(0, 2500) : undefined;
}

/** Worst severity of a page-speed finding reason (undefined if it is not one). */
export function parsePerformanceReason(reason: string): "high" | "medium" | "low" | undefined {
    if (!reason.includes(PERFORMANCE_FAILURE_PREFIX)) return undefined;
    return worstPerfTag(reason.split(/^how to fix:/im)[0] ?? "") ?? "low";
}

/** Metrics attached to a run ("metrics" attachment), parsed defensively. */
export function parseMetrics(body: string): PerfSample[] {
    try {
        const raw = JSON.parse(body) as unknown;
        if (!Array.isArray(raw)) return [];
        return raw.filter((m): m is PerfSample => !!m && typeof m === "object" && typeof (m as PerfSample).metric === "string" && Number.isFinite((m as PerfSample).value));
    } catch {
        return [];
    }
}
