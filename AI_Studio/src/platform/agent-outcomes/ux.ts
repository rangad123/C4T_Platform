/**
 * The UX Testing Agent's outcome (SPEC §3): the health of each page and, when AI screen review was allowed, its visual notes. Computed on
 * read from what its runs saved:
 *   - the page health checks (tests of type "health", health/specs.ts): broken links, script errors, failed requests, insecure content
 *     and page basics, each problem as the check's own message tags it ("- [severity] detail", health/checks.ts); facts, not AI judgement;
 *   - the AI screen reviews (type "vision", vision/specs.ts): a model's judgement, kept apart as "visual notes" with the screenshot it saw.
 * A health check or screen review whose finding a person marked "not a bug" (candidate_findings) is dismissed: listed, never counted.
 * Each page shows its newest result; a run that could not check a page leaves its older result standing. Stopped runs count.
 */
import { HEALTH_ADVICE, HEALTH_CHECKS, HEALTH_FAILURE_PREFIX, healthCheckOf, type HealthCheck } from "../../engine/health/checks.js";
import { VISION_FAILURE_PREFIX, VISION_UNAVAILABLE_PREFIX } from "../../engine/vision/verdict.js";
import type { JobRow } from "../repo.js";
import { countsLine, dismissedTests, newestPerPage, notCheckedNote } from "./accessibility.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";

export interface UxProblem {
    /** As the check tagged it; null for a "...and n more" line. */
    severity: "critical" | "high" | "medium" | "low" | null;
    text: string;
}
export interface UxCheck {
    check: HealthCheck;
    /** The check's own headline ("1 link on this page is broken (checked 12)"). */
    summary: string;
    problems: UxProblem[];
    /** How to fix it, in plain words. */
    advice: string;
}
export interface UxVisual {
    state: "looks-right" | "please-look" | "could-not-run" | "not-checked" | "dismissed";
    notes: UxProblem[];
    note: string | null;
    /** The screenshot the model judged (GET /api/artifacts/:id). */
    screenshot: string | null;
    run: number;
    jobId: string;
}
export interface UxPage {
    path: string;
    state: "problems" | "healthy" | "not-checked" | "dismissed";
    checks: UxCheck[];
    note: string | null;
    run: number;
    jobId: string;
    /** The AI screen review of the page, when one ran. */
    visual: UxVisual | null;
}
export interface UxOutcome {
    runs: number;
    pages: UxPage[];
    counts: { problems: number; healthy: number; notChecked: number; dismissed: number };
    /** True when any of these runs had AI screen review. */
    visualReview: boolean;
}

/** "- [medium] detail" lines; "- ...and 2 more" keeps no severity. */
const problemOf = (line: string): UxProblem => {
    const m = /^- \[(critical|high|medium|low)\] (.*)$/.exec(line);
    return m ? { severity: m[1] as UxProblem["severity"], text: m[2]! } : { severity: null, text: line.slice(2) };
};

/** What a visitor notices first. */
const ORDER: readonly HealthCheck[] = ["noBrokenLinks", "noConsoleErrors", "noFailedRequests", ...HEALTH_CHECKS.filter((c) => !["noBrokenLinks", "noConsoleErrors", "noFailedRequests"].includes(c))];

/**
 * The health reason's blocks (healthFinding): a headline per failed check and its "- " lines. The closing "How to fix:" line names no
 * check, so it drops out; `advice` says it per check instead.
 */
function checksOf(reason: string): UxCheck[] {
    const at = reason.indexOf(HEALTH_FAILURE_PREFIX);
    const out: UxCheck[] = [];
    for (const line of at < 0 ? [] : reason.slice(at + HEALTH_FAILURE_PREFIX.length).trim().split("\n")) {
        if (line.startsWith("- ")) out.at(-1)?.problems.push(problemOf(line));
        else {
            const check = healthCheckOf(line);
            if (check) out.push({ check, summary: line.trim(), problems: [], advice: HEALTH_ADVICE[check] });
        }
    }
    return out.sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check));
}

const STATE_ORDER = { problems: 0, "not-checked": 1, dismissed: 2, healthy: 3 } as const;
/** The screen review's unsure notes a passing review keeps as its reason (vision/judge.ts): shown, never a finding. */
const UNSURE = "AI judgement note";

async function build(ctx: AgentOutcomeCtx, runs: readonly JobRow[]): Promise<UxOutcome> {
    const dismissed = await dismissedTests(ctx);
    const visual = new Map<string, UxVisual>();
    for (const { path, test, run, jobId } of newestPerPage(ctx, runs, "vision")) {
        const reason = test.validationReason ?? "";
        const shot = ctx.p.repo.listArtifacts({ testId: test.id }).filter((a) => a.kind === "screenshot" && !a.pruned_at).at(-1);
        const base = { notes: [] as UxProblem[], note: null as string | null, screenshot: shot ? String(shot.id) : null, run, jobId };
        const v: UxVisual =
            test.validationStatus === "VALIDATED" ? { ...base, state: "looks-right", note: reason.split("\n").filter((l) => l.startsWith(UNSURE)).join(" ").slice(0, 600) || null }
            : test.validationStatus === "NEEDS_REVIEW" && reason.includes(VISION_FAILURE_PREFIX)
              ? { ...base, notes: reason.split(/^how to check:/im)[0]!.split("\n").filter((l) => l.startsWith("- ")).map(problemOf), ...(dismissed.has(test.id) ? { state: "dismissed", note: dismissed.get(test.id)! } : { state: "please-look" }) }
            : reason.includes(VISION_UNAVAILABLE_PREFIX) ? { ...base, state: "could-not-run", note: reason.split("\n")[0]!.slice(0, 300) }
            : { ...base, state: "not-checked", note: notCheckedNote(test) };
        visual.set(path, v);
    }
    const health = newestPerPage(ctx, runs, "health");
    const pages: UxPage[] = health.map(({ path, test, run, jobId }) => {
        const base = { path, run, jobId, checks: [] as UxCheck[], note: null as string | null, visual: visual.get(path) ?? null };
        if (test.validationStatus === "VALIDATED") return { ...base, state: "healthy" };
        if (test.validationStatus === "NEEDS_REVIEW") {
            const checks = checksOf(test.validationReason ?? "");
            return dismissed.has(test.id) ? { ...base, checks, state: "dismissed", note: dismissed.get(test.id)! } : { ...base, checks, state: "problems" };
        }
        return { ...base, state: "not-checked", note: notCheckedNote(test) };
    });
    // A page only the screen review looked at (it looks at fewer pages than the health check).
    for (const [path, v] of visual) if (!health.some((h) => h.path === path)) pages.push({ path, state: "not-checked", checks: [], note: "No page health check of this page yet.", run: v.run, jobId: v.jobId, visual: v });
    pages.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.path.localeCompare(b.path));
    const count = (s: UxPage["state"]) => pages.filter((p) => p.state === s).length;
    return { runs: runs.length, pages, counts: { problems: count("problems"), healthy: count("healthy"), notChecked: count("not-checked"), dismissed: count("dismissed") }, visualReview: visual.size > 0 };
}

export const outcome: AgentOutcomeModule<UxOutcome> = {
    outcome: (ctx) => build(ctx, ctx.runs),
    runOutcome: async (ctx, jobId) => {
        const job = ctx.runs.find((r) => r.id === jobId);
        return job && build(ctx, [job]);
    },
    headline: (o) => countsLine([[o.counts.problems, "with problems"], [o.counts.healthy, "healthy"], [o.counts.notChecked, "not checked"], [o.counts.dismissed, "dismissed"]]),
};
