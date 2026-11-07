/**
 * The shapes of a run read test by test and the sentences that say what a run will do and what it did. Pure: no React, no network,
 * so the words are tested without a browser and never claim more than the platform proved.
 */
import type { Job } from "../../api.js";
import { plural } from "../../lib/format.js";

export type RunState = "waiting" | "running" | "passed" | "failed" | "finding" | "not_run";

export interface RunTest {
    id: string;
    testId: string;
    title: string;
    suite: string;
    state: RunState;
    reason?: string;
    durationMs?: number;
    flaky?: true;
}

export interface RunCounts {
    planned: number;
    ran: number;
    passed: number;
    failed: number;
    findings: number;
    running: number;
    waiting: number;
    notRun: number;
}

export interface RunChange {
    id: string;
    testId: string;
    title: string;
    reason?: string;
}

/** The answer of GET /api/projects/:id/runs/:jobId. */
export interface RunAnswer {
    job: Job;
    jobId: string;
    projectId: string;
    mode: string;
    active: boolean;
    counts: RunCounts;
    tests: RunTest[];
    /** Tests left out because they are waiting for approval. */
    heldBack: { id: string; testId: string; title: string; version: number | null; /** Why it was held back when it is not simply a draft (a shared step changed after approval). */ reason?: string }[];
    startedBy: { kind: "person" | "schedule" | "deploy" | "sequence"; label?: string };
    changes: { comparedWith: { jobId: string; at: string }; newlyFailing: RunChange[]; newlyPassing: RunChange[] } | null;
}

/** What a test did in a run, in the words used everywhere else. */
export const STATE_WORD: Record<RunState, string> = { waiting: "Waiting", running: "Running", passed: "Passing", failed: "Failing", finding: "Needs a look", not_run: "Not run" };
export const STATE_TONE: Record<RunState, "success" | "danger" | "warning" | "info" | "neutral"> = { waiting: "neutral", running: "info", passed: "success", failed: "danger", finding: "warning", not_run: "neutral" };

type Mode = Job["mode"] | undefined;

/** What a kind of job is called: an exploration is the AI exploring the app, a run executes tests. */
export function runTitle(job: Pick<Job, "mode" | "environment"> & { planOnly?: boolean }): string {
    if (job.planOnly) return "Exploration, plan only";
    switch (job.mode) {
        case "plain":
            return "Test from a description";
        case "agent":
            return "Agent run";
        case "environment":
            return `Run on ${job.environment ?? "an environment"}`;
        case "variants":
            return "Browser check";
        case "validate":
            return "Run";
        default:
            return "Exploration";
    }
}

/** The label of the button that stops it. */
export const stopLabel = (mode: Mode): string => (mode === "plain" ? "Stop building" : mode === "generate" || mode === undefined ? "Stop exploring" : "Stop run");

/** "17 of 17 that ran passed, 2 failing, 6 not run": every number with what it is out of. */
export function ranSentence(c: Pick<RunCounts, "ran" | "passed" | "failed" | "findings" | "notRun">): string {
    const parts: string[] = [];
    if (c.failed) parts.push(`${c.failed} failing`);
    if (c.findings) parts.push(`${c.findings} ${c.findings === 1 ? "needs" : "need"} a look`);
    if (c.notRun) parts.push(`${c.notRun} not run`);
    if (c.ran === 0) return parts.length ? `No test produced a result, ${parts.join(", ")}.` : "No test produced a result.";
    return `${c.passed} of ${c.ran} that ran passed${parts.length ? `, ${parts.join(", ")}` : ""}.`;
}

/** "Stopped: 3 of 7 ran". Only from the counts the platform gave for a stopped run. */
export const stoppedLine = (c: { ran: number; planned: number }): string => `Stopped: ${c.ran} of ${c.planned} ran`;

/** The strip's line while a run goes: "Running 7 tests", "Exploring, 12 tests created so far". */
export function runningLine(mode: Mode, c: RunCounts, scopedToTest: boolean): string {
    if (scopedToTest) return "Running this test";
    if (mode === "generate" || mode === undefined) return c.planned ? `Exploring, ${plural(c.planned, "test")} created so far` : "Exploring your app";
    if (mode === "plain") return "Building your test";
    if (mode === "agent") return "The AI agent is working";
    if (mode === "variants") return `Checking ${plural(c.planned, "test")} on other browsers`;
    return `Running ${plural(c.planned, "test")}`;
}

/** Said in the dialog before a run is stopped. `counts` undefined: the platform could not say how many finished, so nothing is promised about them. */
export function stopQuestion(mode: Mode, counts: RunCounts | undefined, planOnly?: boolean): { title: string; body: string } {
    // An exploration that stops at a plan has created nothing: stopping it only means there is no plan.
    if (planOnly) return { title: "Stop exploring?", body: "No plan is made and nothing is created. Tests you already have are unchanged. You can explore again at any time." };
    if (mode === "plain") return { title: "Stop building this test?", body: "Stopping ends this attempt. You can describe the test again at any time." };
    if (mode === "agent") return { title: "Stop this agent run?", body: "The agent stops at its next step. What it did so far is kept." };
    if (mode === "generate" || mode === undefined) {
        const made = counts ? (counts.planned === 0 ? "No tests have been created yet." : `The ${plural(counts.planned, "test")} created so far ${counts.planned === 1 ? "is" : "are"} kept.`) : "Tests that were already created are kept.";
        return { title: "Stop exploring?", body: `${made} Tests that were not run yet show as Not run yet.` };
    }
    const kept = counts ? (counts.ran === 0 ? "No results have been recorded yet." : `${plural(counts.ran, "result")} ${counts.ran === 1 ? "is" : "are"} kept.`) : "";
    return { title: "Stop this run?", body: `${kept ? `${kept} ` : ""}Tests that did not finish keep their previous result.` };
}

// ── what a run will do (the one sentence in the Run panel) ───────────────────

export interface PlanFacts {
    count: number;
    /** The runner's name; null = this server. */
    runner: string | null;
    environment?: string;
    /** Names of the browsers or screen sizes asked for. */
    variants: string[];
    retry: boolean;
    /** Tests left out because they cannot run in the chosen place. */
    leftOut?: number;
    /** What happens before the tests (the test data reset), as a sentence; absent when nothing does. */
    before?: string;
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function planSentence(f: PlanFacts): string {
    if (f.count === 0) return "Choose at least one test to run.";
    let s = `Runs ${plural(f.count, "test")} on ${f.runner ?? "this server"}${f.environment ? ` against ${f.environment}` : ""}.`;
    s += f.environment ? ` The results are kept for ${f.environment}; the tests’ own results do not change.` : " Results replace the last results of these tests.";
    if (!f.environment && f.variants.length) s += ` Tests that pass are also checked on ${list(f.variants)}.`;
    if (!f.environment && f.retry) s += " A failing test runs once more straight away.";
    if (f.leftOut) s += ` ${plural(f.leftOut, "test")} cannot run against an environment and ${f.leftOut === 1 ? "is" : "are"} left out.`;
    if (f.before) s += ` ${f.before}`;
    return s;
}

/** Where a run ran, as a short phrase: the runner's name, or this server. */
export const whereOf = (job: Pick<Job, "ranOn">): string => (job.ranOn?.kind === "agent" ? job.ranOn.name : "this server");

/** Who started it, in words. */
export function startedByText(by: RunAnswer["startedBy"]): string {
    switch (by.kind) {
        case "schedule":
            return by.label ? `The schedule “${by.label}”` : "A schedule";
        case "deploy":
            return by.label ? `A deploy (${by.label})` : "A deploy";
        case "sequence":
            return "A run sequence";
        default:
            return "A person";
    }
}


/** The one line a run row shows from the job's own counters, with every number out of something. Null when there is nothing to say yet. */
export function runCountsLine(job: Pick<Job, "mode" | "counters" | "environment">): string | null {
    const c = job.counters;
    const planned = c.testsGenerated;
    if (planned <= 0) return null;
    const ran = c.testsValidated + c.testsFailedValidation + c.testsNeedingReview;
    const figures = ranSentence({ ran, passed: c.testsValidated, failed: c.testsFailedValidation, findings: c.testsNeedingReview, notRun: Math.max(0, planned - ran) });
    switch (job.mode) {
        case "plain":
            return `${plural(planned, "test")} built from your description, ${c.testsValidated} passed.`;
        case "variants":
            return `${c.testsValidated} of ${plural(planned, "test")} behave the same everywhere.`;
        case "environment":
            return `${figures.replace(/\.$/, "")} on ${job.environment ?? "the environment"}.`;
        case "validate":
            return figures;
        default:
            return `${plural(planned, "test")} created. ${figures}`;
    }
}
