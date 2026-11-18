/**
 * The repeat-run benchmark's report (src/eval/bench/repeat/report.ts), pure: medians and ranges per arm, the savings of the repeat run
 * with reuse and caches on against the same repeat with them off, the lead's targets (at least 30% fewer AI calls and 25% less time),
 * the "no loss" checks (pages, test ideas, requirements covered, the changed page reported), and when a series cannot be judged.
 */
import { describe, expect, it } from "vitest";
import { buildRepeatReport, median, renderRepeatMd, REPEAT_TARGETS, type RepeatTrial, type RunMetrics } from "../src/eval/bench/repeat/report.js";

const run = (o: Partial<RunMetrics> = {}): RunMetrics => ({ wallMs: 10_000, aiCalls: 10, cachedCalls: 0, inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null, pages: 8, scenarios: 20, requirementsCovered: 6, reuseEvents: 0, ...o });

/** Five alternating trials per arm for one app: "on" repeats cost `on`, "off" repeats cost `off`. */
function series(on: Partial<RunMetrics>, off: Partial<RunMetrics>, o: { trials?: number; change?: { on: boolean; off: boolean } } = {}): RepeatTrial[] {
    const out: RepeatTrial[] = [];
    for (let t = 1; t <= (o.trials ?? 5); t++) {
        for (const arm of t % 2 ? (["on", "off"] as const) : (["off", "on"] as const)) {
            out.push({
                app: "bench-shop",
                arm,
                trial: t,
                status: "completed",
                cold: run(),
                repeat: run(arm === "on" ? on : off),
                ...(o.change ? { change: { id: "fewer-fields", applied: true, seen: o.change[arm] } } : {}),
            });
        }
    }
    return out;
}

describe("median", () => {
    it("is the middle value, or the mean of the two middle values", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([])).toBeNull();
    });
});

describe("the repeat-run report", () => {
    it("meets the targets when the repeat with reuse on uses 40% fewer calls and 30% less time, and nothing is lost", () => {
        const r = buildRepeatReport({ apps: ["bench-shop"], trials: series({ aiCalls: 6, wallMs: 7_000 }, { aiCalls: 10, wallMs: 10_000 }, { change: { on: true, off: true } }), repeat: 5 });
        const app = r.apps[0]!;
        expect(app.savings.aiCalls).toBeCloseTo(0.4);
        expect(app.savings.wallMs).toBeCloseTo(0.3);
        expect(app.noLoss.ok).toBe(true);
        expect(app.change).toEqual({ trials: 10, applied: 10, seenOn: 5, seenOff: 5 });
        expect(r.verdict).toBe("meets");
        expect(r.reasons).toEqual([]);
    });

    it("misses when the AI calls fall by less than the target, and says by how much", () => {
        const r = buildRepeatReport({ apps: ["bench-shop"], trials: series({ aiCalls: 8, wallMs: 7_000 }, { aiCalls: 10, wallMs: 10_000 }), repeat: 5 });
        expect(r.verdict).toBe("misses");
        expect(r.reasons.join("\n")).toMatch(/bench-shop: AI calls fell by 20% \(target at least 30%\)/);
        expect(REPEAT_TARGETS).toEqual({ aiCalls: 0.3, wallMs: 0.25 });
    });

    it("misses when reuse loses pages, test ideas or requirement coverage, even when it saves", () => {
        const r = buildRepeatReport({ apps: ["bench-shop"], trials: series({ aiCalls: 2, wallMs: 2_000, scenarios: 15, requirementsCovered: 4 }, { aiCalls: 10, wallMs: 10_000 }), repeat: 5 });
        expect(r.verdict).toBe("misses");
        expect(r.apps[0]!.noLoss.ok).toBe(false);
        expect(r.reasons.join("\n")).toMatch(/test ideas: 15 with reuse on, 20 with it off/);
        expect(r.reasons.join("\n")).toMatch(/requirements covered: 4 with reuse on, 6 with it off/);
    });

    it("misses when the repeat with reuse on did not report the changed page", () => {
        const r = buildRepeatReport({ apps: ["bench-shop"], trials: series({ aiCalls: 2, wallMs: 2_000 }, { aiCalls: 10, wallMs: 10_000 }, { change: { on: false, off: true } }), repeat: 5 });
        expect(r.verdict).toBe("misses");
        expect(r.reasons.join("\n")).toMatch(/the changed page was reported in 0 of 5 repeat runs with reuse on/);
    });

    it("is inconclusive with fewer than five completed trials per arm, or a trial that failed", () => {
        const few = buildRepeatReport({ apps: ["bench-shop"], trials: series({ aiCalls: 2, wallMs: 2_000 }, { aiCalls: 10, wallMs: 10_000 }, { trials: 3 }), repeat: 3 });
        expect(few.verdict).toBe("inconclusive");
        expect(few.reasons.join("\n")).toMatch(/bench-shop: 3 completed trials with reuse on and 3 with it off; at least 5 each are needed/);

        const trials = series({ aiCalls: 2, wallMs: 2_000 }, { aiCalls: 10, wallMs: 10_000 });
        trials[3] = { ...trials[3]!, status: "failed", error: "The exploration failed: boom", repeat: undefined };
        const failed = buildRepeatReport({ apps: ["bench-shop"], trials, repeat: 5 });
        expect(failed.verdict).toBe("inconclusive");
        expect(failed.complete).toBe(false);
        expect(failed.reasons.join("\n")).toMatch(/1 trial\(s\) did not complete/);
    });

    it("a change that could not be applied to the page makes the series inconclusive instead of a pass", () => {
        const trials = series({ aiCalls: 2, wallMs: 2_000 }, { aiCalls: 10, wallMs: 10_000 }, { change: { on: true, off: true } });
        trials[0] = { ...trials[0]!, change: { id: "fewer-fields", applied: false, seen: false } };
        const r = buildRepeatReport({ apps: ["bench-shop"], trials, repeat: 5 });
        expect(r.verdict).toBe("inconclusive");
        expect(r.reasons.join("\n")).toMatch(/the change was not applied in 1 trial/);
    });

    it("reports medians and ranges per arm, the cold runs too, and notes when the time ranges overlap", () => {
        const trials = series({ aiCalls: 6, wallMs: 7_000 }, { aiCalls: 10, wallMs: 10_000 });
        trials.find((t) => t.arm === "on")!.repeat!.wallMs = 11_000;
        const r = buildRepeatReport({ apps: ["bench-shop"], trials, repeat: 5 });
        const on = r.apps[0]!.arms.on.repeat;
        expect(on.wallMs).toEqual({ median: 7_000, min: 7_000, max: 11_000 });
        expect(r.apps[0]!.arms.off.cold.aiCalls).toEqual({ median: 10, min: 10, max: 10 });
        expect(r.notes.join("\n")).toMatch(/bench-shop: the time ranges of the two arms overlap/);
        const md = renderRepeatMd(r);
        expect(md).toMatch(/\| AI calls \| 6 \(6–6\) \| 10 \(10–10\) \| 40% fewer \|/);
        expect(md).toMatch(/Verdict: meets/);
    });

    it("the cache-read share is the cache reads over all input tokens", () => {
        const r = buildRepeatReport({ apps: ["bench-shop"], trials: series({ inputTokens: 40_000, cacheReadTokens: 10_000 }, {}), repeat: 5 });
        expect(r.apps[0]!.arms.on.repeat.cacheReadShare.median).toBeCloseTo(0.25);
        expect(r.apps[0]!.arms.off.repeat.cacheReadShare.median).toBe(0);
    });
});
