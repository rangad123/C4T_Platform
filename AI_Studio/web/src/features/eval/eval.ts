/** Shapes of the evaluation routes (see src/platform/routes/eval.ts and src/eval/run.ts). Only counts, rates, titles and one-line reasons. */

export interface Rates {
    firstPass: number | null;
    stable: number | null;
    flaky: number | null;
    duplicates: number | null;
    coverage: number | null;
    testWrong: number | null;
}
export interface Overall {
    entries: number;
    entriesDone: number;
    planned: number;
    created: number;
    passedFirstRun: number;
    stable: number;
    flaky: number;
    notRun: number;
    failingProduct: number;
    failingTestWrong: number;
    failingUnclear: number;
    duplicates: number;
    found: number;
    covered: number;
    durationMs: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    safetyRefusals: number | null;
    rates: Rates;
}
export type Change = "better" | "worse" | "same" | "changed" | "new";
export interface MetricChange {
    metric: string;
    previous: number | null;
    current: number | null;
    change: Change;
}
export interface Comparison {
    comparedWith: { id: string; startedAt: string };
    overall: MetricChange[];
    entries: Array<{ id: string; metrics: MetricChange[] }>;
}
export interface RunSummary {
    id: string;
    corpus: string;
    planOnly: boolean;
    startedAt: string;
    finishedAt: string;
    overall: Overall;
    comparison: Comparison | null;
}
export interface EntryResult {
    id: string;
    kind: "web" | "android";
    status: "done" | "planned" | "skipped" | "failed";
    reason?: string;
    metrics?: Overall & { coverageUnit: "pages" | "screens" };
    rates?: Rates;
    tests?: Array<{ id: string; testId: string; title: string; outcome: "stable-pass" | "stable-fail" | "flaky" | "not-run"; failure?: "product" | "test-wrong" | "unclear"; reason?: string; duplicate?: true }>;
}
export interface RunDetail extends RunSummary {
    run: { repeat: number; planOnly: boolean; platform: { mode: string; model: string }; entries: EntryResult[]; gates?: Array<{ name: string; passed: boolean; message: string }> };
}

export const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "Not measured" : `${Math.round(v * 1000) / 10}%`);
export const duration = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`);
export const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The four headline measures, in the order they are shown. */
export const HEADLINE: Array<{ key: keyof Rates; label: string; hint: string }> = [
    { key: "stable", label: "Stable", hint: "Share of the created tests with the same result in every rerun: passing every time or failing every time." },
    { key: "flaky", label: "Flaky", hint: "Share of the created tests that passed in some reruns and failed in others." },
    { key: "firstPass", label: "Passing first time", hint: "Share of the created tests that passed in the run that created them." },
    { key: "coverage", label: "Coverage", hint: "Share of the pages or screens the exploration found that at least one created test visits." },
];

export const STATUS_WORD: Record<EntryResult["status"], string> = { done: "Done", planned: "Planned only", skipped: "Skipped", failed: "Could not finish" };
export const OUTCOME_WORD: Record<NonNullable<EntryResult["tests"]>[number]["outcome"], string> = { "stable-pass": "Passing every time", "stable-fail": "Failing every time", flaky: "Flaky", "not-run": "Not run every time" };
export const FAILURE_WORD = { product: "looks like a product problem", "test-wrong": "looks like the test is wrong", unclear: "reason unclear" } as const;
