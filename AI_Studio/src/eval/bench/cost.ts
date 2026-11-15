/**
 * Cost visibility and limits for paid benchmark runs, on the platform's own usage tracking (no billing of its own):
 *   - a pre-run estimate (calls and tokens from the exploration level's limits, tokens per call from the last benchmark when there is one);
 *   - a price table given by the operator (never built into the code), sent to the platform's price settings so its usage page prices the run;
 *   - a hard stop: the platform's monthly and per-job token limits are set from the approved budget, so AI work stops cleanly at it, and the
 *     controller also stops the run when the priced usage passes the budget.
 * A run with the operator's real model refuses to start without an approved budget.
 */
import fs from "node:fs";
import { z } from "zod";
import { PriceRowSchema, type PriceRow } from "./schema.js";

export function loadPrices(file: string): PriceRow[] {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        throw new Error(`Could not read the price table ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = z.array(PriceRowSchema).min(1).max(20).safeParse(raw);
    if (!parsed.success) throw new Error(`The price table needs [{ "model", "inputPerMTok", "outputPerMTok", "cachedInputPerMTok"?, "cacheWritePerMTok"? }] (US dollars per million tokens): ${parsed.error.issues[0]?.message}`);
    return parsed.data;
}

export interface EstimateInput {
    /** Apps explored from the start (new, or run again from scratch). */
    apps: number;
    /**
     * Apps a stop interrupted that a resume continues in the same project: per app, the planned tests not made yet (the plan's ideas minus
     * those already made and those the stopped creation decided to skip). Their exploration and planning are done, so only the tests
     * still to make are counted.
     */
    continued?: number[];
    /** The exploration level's limits (engine/levels.ts), or the entry's own. */
    maxScenarios: number;
    authoringMaxSteps: number;
    /** From the last benchmark of this kind, if any: its real tokens per AI call and calls per created test. */
    previous?: { inputPerCall: number; outputPerCall: number; callsPerTest: number };
    price?: PriceRow;
}

export interface Estimate {
    low: Point;
    mid: Point;
    high: Point;
    basis: string;
}
interface Point {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
}

/** Fixed calls of an exploration (understanding, planning batches, coverage rounds, cross-area journeys, roles): about this many per app. */
const FIXED_CALLS = 8;

export function estimate(i: EstimateInput): Estimate {
    const point = (scenarioShare: number, stepsPerTest: number, inPerCall: number, outPerCall: number): Point => {
        const tests = Math.ceil(i.maxScenarios * scenarioShare);
        // Each test: its steps, one review, about a third get a repair and a strength pass.
        const perTest = i.previous ? i.previous.callsPerTest : stepsPerTest + 1 + 0.7;
        const left = (i.continued ?? []).reduce((n, t) => n + Math.max(0, t), 0);
        const calls = Math.round(i.apps * (FIXED_CALLS + tests * perTest) + left * perTest);
        const inputTokens = Math.round(calls * inPerCall);
        const outputTokens = Math.round(calls * outPerCall);
        const cost = i.price ? (inputTokens * i.price.inputPerMTok + outputTokens * i.price.outputPerMTok) / 1_000_000 : null;
        return { calls, inputTokens, outputTokens, cost };
    };
    const p = i.previous;
    return {
        low: point(0.4, Math.max(4, Math.round(i.authoringMaxSteps * 0.2)), p ? p.inputPerCall * 0.7 : 5_000, p ? p.outputPerCall * 0.7 : 250),
        mid: point(0.7, Math.round(i.authoringMaxSteps * 0.4), p ? p.inputPerCall : 9_000, p ? p.outputPerCall : 400),
        high: point(1, Math.round(i.authoringMaxSteps * 0.8), p ? p.inputPerCall * 1.5 : 15_000, p ? p.outputPerCall * 1.5 : 700),
        basis:
            (p
                ? "tokens per call and calls per test from the last benchmark run"
                : "the exploration level's limits and assumed tokens per call (no earlier benchmark run to calibrate from); prompt-cache savings are not counted, so the figures lean high") +
            (i.continued?.length ? `; ${i.continued.length} continued app${i.continued.length === 1 ? "" : "s"} counted from ${(i.continued ?? []).reduce((n, t) => n + Math.max(0, t), 0)} planned tests not made yet` : ""),
    };
}

/** Fewer AI calls per created test than this cannot be real (each authored test takes its steps and a review): the record undercounted. */
export const MIN_CALLS_PER_TEST = 1;

/**
 * Calibration from an earlier benchmark result: only finished apps count (a stopped app spent calls on tests it never made), and a result
 * whose usage was undercounted (fewer calls than tests) is not used. Undefined when nothing usable is there.
 */
export function calibrationOf(result: unknown): EstimateInput["previous"] {
    const b = (result as { benchmark?: { apps?: Array<{ status?: string; metrics?: Record<string, unknown> }> } } | null)?.benchmark;
    const t = { calls: 0, input: 0, output: 0, tests: 0 };
    for (const a of b?.apps ?? []) {
        const m = a.metrics ?? {};
        if (a.status !== "done" || typeof m.aiCalls !== "number" || typeof m.testsGenerated !== "number") continue;
        t.calls += m.aiCalls;
        t.input += typeof m.inputTokens === "number" ? m.inputTokens : 0;
        t.output += typeof m.outputTokens === "number" ? m.outputTokens : 0;
        t.tests += m.testsGenerated;
    }
    if (t.calls <= 0 || t.tests <= 0 || t.calls / t.tests < MIN_CALLS_PER_TEST) return undefined;
    return { inputPerCall: t.input / t.calls, outputPerCall: t.output / t.calls, callsPerTest: t.calls / t.tests };
}

/**
 * The platform token limits that keep AI use inside the budget: the whole run (monthly limit on the benchmark's own platform, which has no
 * other use) and each job. Priced as 90% input and 10% output tokens with no cache savings (exploration runs about 95% input), so the
 * limit is reached before the money is.
 */
export function tokenLimits(budget: number, apps: number, price: PriceRow): { monthlyTokens: number; jobTokens: number } {
    const perToken = Math.max(0.9 * price.inputPerMTok + 0.1 * price.outputPerMTok, 1e-9) / 1_000_000;
    const total = Math.max(1_000, Math.floor(budget / perToken));
    return { monthlyTokens: total, jobTokens: Math.max(1_000, Math.floor(total / Math.max(1, apps))) };
}

/**
 * The token limits for what is left of a run's budget: `spent` dollars are gone already (earlier attempts, any month), and the platform's
 * monthly limit counts this month's `monthUsedTokens` too, so the monthly limit is those plus the tokens the rest of the budget buys.
 */
export function tokenLimitsLeft(budget: number, spent: number, monthUsedTokens: number, appsLeft: number, price: PriceRow): { monthlyTokens: number; jobTokens: number } {
    const rest = tokenLimits(Math.max(0, budget - Math.max(0, spent)), appsLeft, price);
    return { monthlyTokens: Math.max(0, Math.floor(monthUsedTokens)) + rest.monthlyTokens, jobTokens: rest.jobTokens };
}

const money = (v: number | null) => (v === null ? "no price given" : `$${v.toFixed(2)}`);
export function estimateLines(e: Estimate): string[] {
    const line = (name: string, p: Point) => `  ${name}: about ${p.calls.toLocaleString("en-US")} AI calls, ${(p.inputTokens / 1e6).toFixed(1)}M input and ${(p.outputTokens / 1e6).toFixed(2)}M output tokens, ${money(p.cost)}`;
    return [`Estimated AI use (${e.basis}):`, line("low", e.low), line("likely", e.mid), line("high", e.high)];
}
