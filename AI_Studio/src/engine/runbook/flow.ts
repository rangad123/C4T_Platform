/**
 * Runbooks: how a run moves from step to step and how a check judges the run before it. Pure functions, so every rule can be
 * tested without a database, a worker or a browser.
 */
import { ignoredNote } from "../quarantine/rules.js";
import { passRate } from "../summary/pass-rate.js";
import type { Condition, RunbookDefinition, Step } from "./schema.js";

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "stopped" | "timed_out";
export type RunStatus = "running" | "passed" | "failed" | "stopped" | "timed_out" | "cancelled" | "interrupted";
export const FINISHED_RUN_STATUSES: RunStatus[] = ["passed", "failed", "stopped", "timed_out", "cancelled", "interrupted"];

export type Next = { kind: "goto"; index: number } | { kind: "stop" } | { kind: "end" };

/**
 * Where the run goes after a step. A step that passed follows `onPass` (default: the next step); one that failed follows
 * `onFail` (default: stop). A route is "next", "stop" or the id of a later step; validation guarantees the id exists and is
 * later, so this always moves forward.
 */
export function nextAfter(def: Pick<RunbookDefinition, "steps">, index: number, passed: boolean): Next {
    const step = def.steps[index]!;
    const route = (passed ? step.onPass : step.onFail) ?? (passed ? "next" : "stop");
    if (route === "stop") return { kind: "stop" };
    if (route === "next") return index + 1 < def.steps.length ? { kind: "goto", index: index + 1 } : { kind: "end" };
    const to = def.steps.findIndex((s) => s.id === route);
    // Unreachable for a saved runbook; if it ever happens, stopping is the safe reading.
    return to > index ? { kind: "goto", index: to } : { kind: "stop" };
}

/**
 * The run's final status. Reaching the end of the list is "passed" unless some step failed on the way (a failure that was
 * routed around still counts). An explicit stop is "passed" when nothing had failed (an early, successful finish) and
 * "stopped" when a failure led to it.
 */
export function finalStatus(how: "end" | "stop", anyFailure: boolean): "passed" | "failed" | "stopped" {
    if (how === "end") return anyFailure ? "failed" : "passed";
    return anyFailure ? "stopped" : "passed";
}

/** What was measured about the run before a check, gathered by the platform. `null` = could not be measured. */
export interface Facts {
    /** A run or analyze step has produced a job to look at. */
    hasRun: boolean;
    /** The job ended without finishing its work (failed or cancelled), with its reason. */
    jobError: string | null;
    total: number | null;
    passed: number | null;
    /** Tests that failed or found a problem. */
    failed: number | null;
    /** Findings of high or critical severity among the tests of that run. */
    highSeverity: number | null;
    /** Breaking API changes between the previous run and this one; null = nothing to compare with. */
    apiBreaking: number | null;
    /** The project's readiness (ready, needs-attention, blocked, unknown) with its label and top reasons. */
    readiness: { state: string; label: string; reasons: string[] } | null;
    /** Quarantined tests left out of total, passed and failed (flaky tests that decide nothing). Absent when there are none. */
    quarantined?: number;
}

export interface ConditionResult {
    passed: boolean;
    /** What was measured, in a few words ("96% passed (48 of 50)"). */
    measured: string;
    /** One sentence for the run's record. */
    reason: string;
}

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function passRateOf(f: Pick<Facts, "total" | "passed">): number | null {
    return f.total && f.passed !== null ? passRate(f.passed, f.total) : null;
}

export function evaluateCondition(c: Condition, f: Facts): ConditionResult {
    // Readiness is about the project, not about one run, so it needs no earlier step.
    if (c.check === "readiness") {
        if (!f.readiness) return { passed: false, measured: "not available", reason: "The project’s readiness could not be worked out." };
        const ok = f.readiness.state === "ready";
        const why = f.readiness.reasons.slice(0, 2).join("; ");
        return { passed: ok, measured: f.readiness.label, reason: ok ? "The project is ready to release." : `The project is not ready to release: ${f.readiness.label}${why ? ` (${why})` : ""}.` };
    }
    if (!f.hasRun) return { passed: false, measured: "no earlier run", reason: "There was no earlier run to check, because the steps before it did not run tests." };
    if (f.jobError) return { passed: false, measured: "the run did not finish", reason: `The earlier run did not finish: ${f.jobError}` };

    switch (c.check) {
        case "passRate": {
            const rate = passRateOf(f);
            if (rate === null) return { passed: false, measured: "no tests ran", reason: "No tests ran, so there is no pass rate." };
            const ok = rate >= c.atLeast;
            const q = f.quarantined ? ` ${ignoredNote(f.quarantined)}` : "";
            return { passed: ok, measured: `${pct(rate)} passed (${f.passed} of ${f.total})${q}`, reason: (ok ? `${pct(rate)} passed, which meets the ${pct(c.atLeast)} needed.` : `${pct(rate)} passed, below the ${pct(c.atLeast)} needed.`) + q };
        }
        case "noFailures": {
            if (f.failed === null) return { passed: false, measured: "not measured", reason: "The failures of the earlier run could not be counted." };
            const ok = f.failed === 0;
            const q = f.quarantined ? ` ${ignoredNote(f.quarantined)}` : "";
            return { passed: ok, measured: (ok ? "no failing tests" : `${plural(f.failed, "failing test")}`) + q, reason: (ok ? "No test failed." : `${plural(f.failed, "test")} failed or found a problem.`) + q };
        }
        case "noHighSeverity": {
            if (f.highSeverity === null) return { passed: false, measured: "not measured", reason: "The severity of the findings could not be worked out." };
            const ok = f.highSeverity === 0;
            return { passed: ok, measured: ok ? "no high-severity findings" : plural(f.highSeverity, "high-severity finding"), reason: ok ? "There are no high or critical findings." : `${plural(f.highSeverity, "finding")} of high or critical severity.` };
        }
        case "noApiBreakingChange": {
            // Nothing to compare is not a breaking change; the record says so, so nobody mistakes it for a clean comparison.
            if (f.apiBreaking === null) return { passed: true, measured: "nothing to compare yet", reason: "No earlier API record to compare with, so no breaking change was found." };
            const ok = f.apiBreaking === 0;
            return { passed: ok, measured: ok ? "no breaking API changes" : plural(f.apiBreaking, "breaking API change"), reason: ok ? "The API did not change in a way that breaks clients." : `${plural(f.apiBreaking, "change")} in the API can break existing clients.` };
        }
    }
}

/** A short plain-language name for a step, used when the author did not give it a title. */
export function stepTitle(step: Step): string {
    if (step.title) return step.title;
    switch (step.type) {
        case "run": {
            const scope = step.scope === "all" ? "all tests" : [step.scope.suite && `the “${step.scope.suite}” suite`, step.scope.tag && `tests tagged “${step.scope.tag}”`, step.scope.testIds && plural(step.scope.testIds.length, "chosen test")].filter(Boolean).join(" and ");
            return `Run ${scope}${step.environment ? ` on ${step.environment}` : ""}`;
        }
        case "analyze":
            return "Analyze the application again";
        case "condition":
            return describeCondition(step.condition);
        case "notify":
            return "Tell the team";
        case "wait":
            return `Wait ${plural(step.seconds, "second")}`;
    }
}

export function describeCondition(c: Condition): string {
    switch (c.check) {
        case "passRate":
            return `Check that at least ${c.atLeast}% passed`;
        case "noFailures":
            return "Check that nothing failed";
        case "noHighSeverity":
            return "Check there are no high-severity findings";
        case "noApiBreakingChange":
            return "Check the API has no breaking changes";
        case "readiness":
            return "Check the project is ready to release";
    }
}
