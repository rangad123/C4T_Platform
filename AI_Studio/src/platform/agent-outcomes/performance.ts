/**
 * The Performance Testing Agent's outcome (SPEC §3): each page's timings, slowest first, the timings of the safe API calls it made
 * (lead, 2026-11-24: they explain what it did), and the load result of the runs that allowed a load check. Computed on read from what its runs saved: the page speed and load checks the engine made (orchestrator.ts persistNew
 * meta.performance / meta.load), their results, and what they measured (perf-store.ts perf_metrics). A newer run's timing of a page or
 * call replaces an older one's; a stopped run's part counts.
 */
import { LATENCY_FAILURE_PREFIX } from "../../engine/performance/latency.js";
import { LOAD_FAILURE_PREFIX } from "../../engine/performance/load.js";
import { PERFORMANCE_FAILURE_PREFIX } from "../../engine/performance/checks.js";
import { testHistory, type Sample } from "../perf-store.js";
import type { JobRow, TestRow } from "../repo.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";

/** Within its budgets, over one (the check failed on a budget), or no measurement to judge (the check could not run). */
export type Verdict = "within" | "over" | "not-measured";

export interface PageTiming {
    testId: string;
    path: string;
    title: string;
    signedIn: boolean;
    verdict: Verdict;
    /** What was over budget, or why nothing was measured, or a passing check's note. */
    note: string | null;
    metrics: Sample[];
    jobId: string;
}

/** A timed API call, or a load check of one. */
export interface EndpointResult {
    testId: string;
    endpoint: string;
    verdict: Verdict;
    note: string | null;
    metrics: Sample[];
    jobId: string;
}

export interface PerformanceOutcome {
    runs: number;
    /** Slowest first, by when the main content appears (else when the page finished loading); unmeasured pages last. */
    pages: PageTiming[];
    /** Safe API calls timed one at a time. */
    calls: EndpointResult[];
    load: EndpointResult[];
}

const pageOf = (t: TestRow): string | undefined => t.spec.steps.filter((s) => s.action === "navigate").map((s) => (s as { url?: string }).url).at(-1);
/** The check's own sentence, without its prefix, its advice and its severity tags. */
const own = (reason: string, prefix: string) => reason.slice(reason.indexOf(prefix) + prefix.length).split(/^how to fix:/im)[0]!.replace(/\s*\[(?:high|medium|low)\]/g, "").trim();
const verdictOf = (t: TestRow, prefix: string, measured: boolean): { verdict: Verdict; note: string | null } => {
    const reason = t.validationReason ?? "";
    if (reason.includes(prefix)) return { verdict: "over", note: own(reason, prefix) };
    if (t.validationStatus === "VALIDATED" && measured) return { verdict: "within", note: reason || null };
    return { verdict: "not-measured", note: reason.split("\n")[0] || null };
};
const latest = async (ctx: AgentOutcomeCtx, t: TestRow): Promise<Sample[]> => (await testHistory(ctx.p.sql, t.id, 1)).latest.map(({ at: _at, ...s }) => s);

async function build(ctx: AgentOutcomeCtx, runs: JobRow[]): Promise<PerformanceOutcome> {
    const pages = new Map<string, PageTiming>();
    const calls = new Map<string, EndpointResult>();
    const loads = new Map<string, EndpointResult>();
    // Newest run first: a page or endpoint it measured is its row.
    for (const job of runs) {
        for (const t of ctx.p.repo.listTests(ctx.projectId, { jobId: job.id })) {
            const meta = t.generationMeta ?? {};
            if (!meta.performance) continue;
            if (t.kind === "api" && typeof meta.endpoint === "string") {
                const [into, prefix] = meta.load ? [loads, LOAD_FAILURE_PREFIX] : [calls, LATENCY_FAILURE_PREFIX];
                if (into.has(meta.endpoint)) continue;
                const metrics = await latest(ctx, t);
                into.set(meta.endpoint, { testId: t.id, endpoint: meta.endpoint, ...verdictOf(t, prefix, metrics.length > 0), metrics, jobId: job.id });
                continue;
            }
            const path = t.kind === "web" ? pageOf(t) : undefined;
            if (!path) continue;
            const signedIn = Boolean(meta.signedIn);
            const key = `${signedIn ? "signed-in " : ""}${path}`;
            if (pages.has(key)) continue;
            const metrics = await latest(ctx, t);
            pages.set(key, { testId: t.id, path, title: t.title, signedIn, ...verdictOf(t, PERFORMANCE_FAILURE_PREFIX, metrics.length > 0), metrics, jobId: job.id });
        }
    }
    const speed = (p: PageTiming) => (p.metrics.find((x) => x.metric === "lcp") ?? p.metrics.find((x) => x.metric === "load"))?.value ?? -1;
    return { runs: runs.length, pages: [...pages.values()].sort((a, b) => speed(b) - speed(a) || a.path.localeCompare(b.path)), calls: [...calls.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)), load: [...loads.values()] };
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const outcome: AgentOutcomeModule<PerformanceOutcome> = {
    outcome: (ctx) => build(ctx, ctx.runs),
    runOutcome: async (ctx, jobId) => {
        const run = ctx.runs.find((j) => j.id === jobId);
        return run && build(ctx, [run]);
    },
    headline: (o) => {
        if (!o.runs) return null;
        const over = o.pages.filter((p) => p.verdict === "over").length;
        return [counted(o.pages.length, "page") + " timed", over ? `${over} over budget` : null].filter(Boolean).join(", ");
    },
};
