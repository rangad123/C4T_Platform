/**
 * The numbers of an evaluation run, worked out from what the platform recorded (pure functions: no I/O, so they are unit-tested on their own).
 *
 * Words used here and in the results:
 *   first run     the run the platform did when it created the test;
 *   reruns        the N extra runs the harness asks for afterwards (same tests, nothing changed in between);
 *   stable        the test gave the same verdict (passing, or not passing) in every rerun;
 *   flaky         it passed in some reruns and not in others;
 *   not run       at least one rerun could not run it (no phone, runner offline...), so its stability is not judged.
 * A failing test is sorted by the reason the platform stored (a heuristic, see `classifyFailure`): a product finding (a check found
 * something, a page said something other than expected, the server answered with an error) or a test that is wrong (an element it
 * looks for is not there, a wait timed out).
 */

export type Verdict = "passed" | "failed" | "finding" | "not_run";
export type Outcome = "stable-pass" | "stable-fail" | "flaky" | "not-run";
export type FailureCategory = "product" | "test-wrong" | "unclear";

export interface TestObservation {
    id: string;
    testId: string;
    title: string;
    firstRun: Verdict | null;
    /** The verdict of each rerun, in order. */
    reruns: Verdict[];
    /** The newest failure reason the platform stored for it, if any (one line). */
    reason?: string;
    /** It repeats another test of the same exploration (same steps, or the same title). */
    duplicate: boolean;
}

export interface TestResult {
    id: string;
    testId: string;
    title: string;
    firstRun: Verdict | null;
    reruns: Verdict[];
    outcome: Outcome;
    failure?: FailureCategory;
    reason?: string;
    duplicate?: true;
}

export interface EntryMetrics {
    planned: number;
    created: number;
    passedFirstRun: number;
    stable: number;
    stablePassing: number;
    stableFailing: number;
    flaky: number;
    notRun: number;
    failingProduct: number;
    failingTestWrong: number;
    failingUnclear: number;
    duplicates: number;
    coverageUnit: "pages" | "screens";
    /** Pages (web) or screens (phone) the exploration found. */
    found: number;
    /** Of those, how many at least one created test visits. */
    covered: number;
    durationMs: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
    /** In the platform's currency; null when no price is set for the model used. */
    cost: number | null;
    /** Actions the AI wanted and the platform refused as unsafe (phone). Null where the platform records none (web). */
    safetyRefusals: number | null;
}

export interface Rates {
    firstPass: number | null;
    stable: number | null;
    flaky: number | null;
    duplicates: number | null;
    coverage: number | null;
    /** Of the tests that kept failing, the share that failed because the test is wrong. */
    testWrong: number | null;
}

export interface Overall extends Omit<EntryMetrics, "coverageUnit" | "safetyRefusals" | "cost"> {
    entries: number;
    entriesDone: number;
    cost: number | null;
    safetyRefusals: number | null;
    rates: Rates;
}

const MAX_REASON = 240;
const oneLine = (s: string | undefined): string | undefined => {
    const t = (s ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
    return t || undefined;
};

/**
 * Why a test failed, from the reason the platform stored. Order matters: an expectation that timed out because the element never
 * appeared is about the test ("element(s) not found"), one that found the element with other content is about the product.
 */
export function classifyFailure(reason: string | undefined, verdict: Verdict = "failed"): FailureCategory {
    if (verdict === "finding") return "product";
    const r = (reason ?? "").toLowerCase();
    if (!r) return "unclear";
    if (/\b5\d\d\b.*(status|error|response)|(status|response|answered)\D{0,20}\b5\d\d\b|internal server error|server error|bad gateway|service unavailable/.test(r)) return "product";
    if (/element\(s\) not found|resolved to 0 elements|no element|not found on the (page|screen)|could not find|locator .*not found|waiting for (locator|selector|element)|strict mode violation|element is not (visible|attached|enabled)|detached from the dom|no node found/.test(r)) return "test-wrong";
    if (/expected|received|tohave|tocontain|tobe|assert|does not (show|contain)|shows .* instead/.test(r)) return "product";
    if (/time(d)? ?out|timeout/.test(r)) return "test-wrong";
    return "unclear";
}

const passes = (v: Verdict) => v === "passed";

/** One test's judgement over its reruns. */
export function judgeTest(o: TestObservation): TestResult {
    const ran = o.reruns.filter((v) => v !== "not_run");
    let outcome: Outcome;
    if (o.reruns.length === 0 || ran.length < o.reruns.length) outcome = "not-run";
    else if (ran.every(passes)) outcome = "stable-pass";
    else if (ran.every((v) => !passes(v))) outcome = "stable-fail";
    else outcome = "flaky";
    const last = [...o.reruns].reverse().find((v) => v !== "not_run" && !passes(v));
    const failure = outcome === "stable-fail" ? classifyFailure(o.reason, last ?? "failed") : undefined;
    const reason = oneLine(o.reason);
    return {
        id: o.id,
        testId: o.testId,
        title: o.title,
        firstRun: o.firstRun,
        reruns: o.reruns,
        outcome,
        ...(failure ? { failure } : {}),
        ...(reason && outcome !== "stable-pass" ? { reason } : {}),
        ...(o.duplicate ? { duplicate: true as const } : {}),
    };
}

export interface EntryFacts {
    planned: number;
    tests: TestObservation[];
    coverageUnit: "pages" | "screens";
    found: number;
    covered: number;
    durationMs: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    safetyRefusals: number | null;
}

export function entryMetrics(f: EntryFacts): { metrics: EntryMetrics; tests: TestResult[] } {
    const tests = f.tests.map(judgeTest);
    const count = (p: (t: TestResult) => boolean) => tests.filter(p).length;
    const metrics: EntryMetrics = {
        planned: f.planned,
        created: tests.length,
        passedFirstRun: count((t) => t.firstRun === "passed"),
        stable: count((t) => t.outcome === "stable-pass" || t.outcome === "stable-fail"),
        stablePassing: count((t) => t.outcome === "stable-pass"),
        stableFailing: count((t) => t.outcome === "stable-fail"),
        flaky: count((t) => t.outcome === "flaky"),
        notRun: count((t) => t.outcome === "not-run"),
        failingProduct: count((t) => t.failure === "product"),
        failingTestWrong: count((t) => t.failure === "test-wrong"),
        failingUnclear: count((t) => t.failure === "unclear"),
        duplicates: count((t) => t.duplicate === true),
        coverageUnit: f.coverageUnit,
        found: f.found,
        covered: Math.min(f.covered, f.found),
        durationMs: f.durationMs,
        aiCalls: f.aiCalls,
        inputTokens: f.inputTokens,
        outputTokens: f.outputTokens,
        cost: f.cost,
        safetyRefusals: f.safetyRefusals,
    };
    return { metrics, tests };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export function ratesOf(m: Pick<EntryMetrics, "created" | "passedFirstRun" | "stable" | "flaky" | "duplicates" | "found" | "covered" | "stableFailing" | "failingTestWrong">): Rates {
    return {
        firstPass: ratio(m.passedFirstRun, m.created),
        stable: ratio(m.stable, m.created),
        flaky: ratio(m.flaky, m.created),
        duplicates: ratio(m.duplicates, m.created),
        coverage: ratio(m.covered, m.found),
        testWrong: ratio(m.failingTestWrong, m.stableFailing),
    };
}

const SUMMED = ["planned", "created", "passedFirstRun", "stable", "stablePassing", "stableFailing", "flaky", "notRun", "failingProduct", "failingTestWrong", "failingUnclear", "duplicates", "found", "covered", "durationMs", "aiCalls", "inputTokens", "outputTokens"] as const;

/** All entries together: counts are summed, rates are worked out from the sums (not averaged per entry). */
export function overallOf(entries: Array<{ metrics?: EntryMetrics }>): Overall {
    const done = entries.map((e) => e.metrics).filter((m): m is EntryMetrics => Boolean(m));
    const sums = Object.fromEntries(SUMMED.map((k) => [k, done.reduce((n, m) => n + m[k], 0)])) as Record<(typeof SUMMED)[number], number>;
    const costs = done.map((m) => m.cost).filter((c): c is number => c !== null);
    const refusals = done.map((m) => m.safetyRefusals).filter((c): c is number => c !== null);
    return {
        entries: entries.length,
        entriesDone: done.length,
        ...sums,
        cost: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 10_000) / 10_000 : null,
        safetyRefusals: refusals.length ? refusals.reduce((a, b) => a + b, 0) : null,
        rates: ratesOf(sums),
    };
}

// ── quality gates ─────────────────────────────────────────────────────────────

/** Gate names: a rate, and whether a higher value is better ("at least") or a lower one ("at most"). */
export const GATES = { stable: "min", firstPass: "min", coverage: "min", flaky: "max", duplicates: "max", testWrong: "max" } as const satisfies Record<keyof Rates, "min" | "max">;
export type GateName = keyof typeof GATES;
export interface Gate {
    name: GateName;
    limit: number;
}
export interface GateResult extends Gate {
    kind: "min" | "max";
    value: number | null;
    passed: boolean;
    message: string;
}

/** "stable=0.8,flaky=0.1" -> gates. Throws with a plain message for anything else. */
export function parseGates(text: string): Gate[] {
    const out: Gate[] = [];
    for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
        const m = /^([A-Za-z]+)=(\d*\.?\d+)$/.exec(part);
        if (!m) throw new Error(`“${part}” is not a gate. Write it like stable=0.8`);
        const name = m[1] as GateName;
        if (!(name in GATES)) throw new Error(`“${m[1]}” is not a gate. Use ${Object.keys(GATES).join(", ")}`);
        const limit = Number(m[2]);
        if (!(limit >= 0 && limit <= 1)) throw new Error(`The limit for ${name} must be between 0 and 1`);
        if (out.some((g) => g.name === name)) throw new Error(`${name} is given twice`);
        out.push({ name, limit });
    }
    if (!out.length) throw new Error("Give at least one gate, like stable=0.8,flaky=0.1");
    return out;
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export function checkGates(rates: Rates, gates: Gate[]): GateResult[] {
    return gates.map((g) => {
        const kind = GATES[g.name];
        const value = rates[g.name];
        // Nothing to measure (no test was created, or none kept failing for testWrong) fails a "min" gate and passes a "max" gate:
        // no tests at all must never look like a stable suite, and zero failing tests cannot be wrong ones.
        const passed = value === null ? kind === "max" : kind === "min" ? value >= g.limit : value <= g.limit;
        const shown = value === null ? "nothing to measure" : pct(value);
        const message = `${g.name} ${shown}, ${kind === "min" ? "at least" : "at most"} ${pct(g.limit)} wanted: ${passed ? "passed" : "failed"}`;
        return { ...g, kind, value, passed, message };
    });
}

// ── comparison with the previous run ──────────────────────────────────────────

export type Change = "better" | "worse" | "same" | "changed" | "new";
export interface MetricChange {
    metric: string;
    previous: number | null;
    current: number | null;
    change: Change;
}

/** Which way is better for each compared number (`neutral`: more tests planned is neither better nor worse in itself). */
const DIRECTION: Record<string, "up" | "down" | "neutral"> = {
    "rates.firstPass": "up",
    "rates.stable": "up",
    "rates.coverage": "up",
    "rates.flaky": "down",
    "rates.duplicates": "down",
    "rates.testWrong": "down",
    planned: "neutral",
    created: "neutral",
    durationMs: "down",
    aiCalls: "down",
    cost: "down",
    safetyRefusals: "neutral",
};
export const COMPARED = Object.keys(DIRECTION);

const pick = (o: unknown, key: string): number | null => {
    let v: unknown = o;
    for (const k of key.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Each compared number of `current` against `previous` (overall or one entry: both have the same fields, entries' rates are added by the caller). */
export function compareMetrics(previous: unknown, current: unknown): MetricChange[] {
    return COMPARED.map((metric) => {
        const p = previous === undefined ? null : pick(previous, metric);
        const c = pick(current, metric);
        let change: Change;
        if (previous === undefined || (p === null && c !== null)) change = "new";
        else if (p === null || c === null) change = p === c ? "same" : "changed";
        else {
            const dir = DIRECTION[metric]!;
            // Rates within half a point, and times within a tenth, count as the same: runs on a real app wobble that much.
            const tolerance = metric.startsWith("rates.") ? 0.005 : metric === "durationMs" ? Math.max(p, c) * 0.1 : 0;
            if (Math.abs(c - p) <= tolerance) change = "same";
            else if (dir === "neutral") change = "changed";
            else change = (c > p) === (dir === "up") ? "better" : "worse";
        }
        return { metric, previous: p, current: c, change };
    });
}
