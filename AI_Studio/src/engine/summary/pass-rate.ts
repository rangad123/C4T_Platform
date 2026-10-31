/**
 * The one pass-rate rule, and the sentence that says what it is made of.
 *
 *   pass rate = tests that passed / tests that produced a verdict in that run (passed, found a problem, or could not be validated)
 *
 * A test that did not take part in the run (not run yet, left out, cancelled before it started, in quarantine) is not in the
 * denominator, and the sentence says so instead of leaving two numbers side by side that cannot both be read. Pure; every place
 * that shows a pass rate (dashboard, release sign-off, project report, run summaries, alerts, the API, MCP) uses these two functions.
 */

/** Percent of the tests that produced a verdict that passed, with one decimal; null when none did. */
export function passRate(passed: number, ran: number): number | null {
    return ran > 0 ? Math.round((passed / ran) * 1000) / 10 : null;
}

/** How the tests of a run came out: all of them produced a verdict. */
export interface RunVerdicts {
    passed: number;
    /** Found a problem in the application (needs review). */
    findings: number;
    /** Could not be validated (the test itself failed or broke). */
    failed: number;
}

/** The project's tests as they are now, for the "other tests" part of the sentence. */
export interface ProjectNow {
    total: number;
    couldNotValidate: number;
    needsAttention: number;
    waiting?: number;
    /** Tests whose recent runs flip between pass and fail. */
    unreliable?: number;
}

export interface RunFigures {
    /** Tests that produced a verdict in the run: the denominator. */
    ran: number;
    passed: number;
    passRate: number | null;
    /** What the number is made of, in one sentence: "17 of 17 tests that ran passed." */
    sentence: string;
    /** When the project has tests that were not part of the run, or problems of its own right now: the other half of the picture. Empty when there is nothing to add. */
    others: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeRun(v: RunVerdicts, now?: ProjectNow): RunFigures {
    const ran = v.passed + v.findings + v.failed;
    const rate = passRate(v.passed, ran);
    const parts: string[] = [];
    if (v.findings) parts.push(`${v.findings} found ${v.findings === 1 ? "a problem" : "problems"}`);
    if (v.failed) parts.push(`${v.failed} could not be run`);
    const sentence = ran === 0 ? "No test produced a result in that run." : `${v.passed} of ${plural(ran, "test")} that ran passed${parts.length ? `, ${parts.join(" and ")}` : ""}.`;

    let others = "";
    if (now) {
        const notInRun = Math.max(0, now.total - ran);
        const facts: string[] = [];
        if (now.couldNotValidate) facts.push(`${now.couldNotValidate} could not be run`);
        if (now.needsAttention) facts.push(`${now.needsAttention} ${now.needsAttention === 1 ? "has" : "have"} a problem to review`);
        if (now.unreliable) facts.push(`${now.unreliable} ${now.unreliable === 1 ? "is" : "are"} unreliable`);
        const out: string[] = [];
        if (notInRun > 0) out.push(`${plural(notInRun, "other test")} did not take part in that run.`);
        if (facts.length && (notInRun > 0 || now.couldNotValidate + now.needsAttention !== v.failed + v.findings || now.unreliable)) out.push(`Across all ${plural(now.total, "test")} right now, ${facts.join(", ")}.`);
        others = out.join(" ");
    }
    return { ran, passed: v.passed, passRate: rate, sentence, others };
}
