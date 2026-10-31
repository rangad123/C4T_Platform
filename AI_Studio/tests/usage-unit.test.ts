/**
 * AI usage and budgets, browser-free: the pure rules (budget decision table, estimates, months, prices, aggregation), the meter that
 * wraps a model client (against a scripted `LlmClient` double and a real SQLite store), the store itself (two instances over one
 * database file, like an API process and a worker) and the settings parsing. No real model is ever called.
 *
 *   node node_modules/vitest/vitest.mjs run tests/usage-unit.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { JobMeter } from "../src/engine/llm/metered.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import {
    BudgetExceeded,
    capDetail,
    capMessage,
    costOf,
    daySeries,
    daysBetween,
    decideBudget,
    estimateTokens,
    groupRows,
    isBudgetExceeded,
    monthBounds,
    monthOf,
    normalisePurpose,
    shortTokens,
    totalsOf,
    warningMessage,
    type Price,
    type UsageRow,
} from "../src/engine/llm/usage.js";
import { Db } from "../src/platform/db.js";
import { aiSkipReason, UsageStore } from "../src/platform/usage-store.js";

const tmp: string[] = [];
const tmpDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usage-unit-"));
    tmp.push(d);
    return d;
};
afterAll(() => {
    for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe("budget decision table", () => {
    const used = (job: number, project = 0, month = 0) => ({ job, project, month });

    it("allows everything when no cap is set", () => {
        const d = decideBudget(used(10_000_000, 10_000_000, 10_000_000), {});
        expect(d).toEqual({ allowed: true, warnings: [] });
        // null and undefined both mean "no limit"
        expect(decideBudget(used(5), { job: null, project: undefined, month: null }).allowed).toBe(true);
    });

    it("refuses exactly at the limit, allows one token under it", () => {
        for (const cap of ["job", "project", "month"] as const) {
            const under = { job: 0, project: 0, month: 0, [cap]: 999 };
            const at = { job: 0, project: 0, month: 0, [cap]: 1000 };
            const over = { job: 0, project: 0, month: 0, [cap]: 1001 };
            expect(decideBudget(under, { [cap]: 1000 }).allowed, `${cap} under`).toBe(true);
            const hit = decideBudget(at, { [cap]: 1000 });
            expect(hit.allowed, `${cap} at`).toBe(false);
            expect(hit.blocked).toMatchObject({ cap, used: 1000, limit: 1000, percent: 100 });
            expect(decideBudget(over, { [cap]: 1000 }).blocked?.percent, `${cap} over`).toBe(100);
        }
    });

    it("refuses a call whose own input would not fit, and not one that fits exactly", () => {
        expect(decideBudget(used(900), { job: 1000 }, { incoming: 100 }).allowed).toBe(true); // 900 + 100 = 1000: fits
        const d = decideBudget(used(900), { job: 1000 }, { incoming: 101 });
        expect(d.allowed).toBe(false);
        expect(d.blocked).toMatchObject({ cap: "job", used: 900, limit: 1000 });
    });

    it("reports the most specific cap when several are hit", () => {
        const all = decideBudget(used(100, 100, 100), { job: 100, project: 100, month: 100 });
        expect(all.blocked?.cap).toBe("job");
        expect(decideBudget(used(5, 100, 100), { job: 100, project: 100, month: 100 }).blocked?.cap).toBe("project");
        expect(decideBudget(used(5, 5, 100), { job: 100, project: 100, month: 100 }).blocked?.cap).toBe("month");
    });

    it("a cap of zero refuses everything; a negative or NaN cap is ignored as no limit", () => {
        expect(decideBudget(used(0), { job: 0 }).allowed).toBe(false);
        expect(decideBudget(used(5), { job: -1 }).allowed).toBe(true);
        expect(decideBudget(used(5), { job: Number.NaN }).allowed).toBe(true);
    });

    it("warns from the threshold (default 80 percent) and only below the limit", () => {
        expect(decideBudget(used(799), { job: 1000 }).warnings).toEqual([]);
        const w = decideBudget(used(800), { job: 1000 });
        expect(w.allowed).toBe(true);
        expect(w.warnings).toEqual([{ cap: "job", used: 800, limit: 1000, percent: 80 }]);
        // a different threshold
        expect(decideBudget(used(500), { job: 1000 }, { warnPercent: 50 }).warnings).toHaveLength(1);
        expect(decideBudget(used(499), { job: 1000 }, { warnPercent: 50 }).warnings).toHaveLength(0);
        // a refused cap is not also a warning; another cap past the threshold still is
        const both = decideBudget(used(1000, 900), { job: 1000, project: 1000 });
        expect(both.blocked?.cap).toBe("job");
        expect(both.warnings.map((h) => h.cap)).toEqual(["project"]);
    });

    it("words: the plain sentence per cap, the numbers, and the warning", () => {
        expect(capMessage("job")).toBe("The AI token limit for this job was reached");
        expect(capMessage("project")).toBe("The AI token limit for this project was reached");
        expect(capMessage("month")).toBe("The AI token limit for this month was reached");
        expect(capDetail({ cap: "project", used: 52_000, limit: 50_000, percent: 104 })).toBe("This project this month: 52,000 of 50,000 tokens used.");
        expect(warningMessage({ cap: "month", used: 85, limit: 100, percent: 85 })).toBe("AI use has reached 85% of the limit for all projects this month (85 of 100 tokens).");
        const e = new BudgetExceeded({ cap: "job", used: 5, limit: 5, percent: 100 });
        expect(e.message).toBe(capMessage("job"));
        expect(e.name).toBe("BudgetExceeded");
        expect(isBudgetExceeded(e)).toBe(true);
        expect(isBudgetExceeded(new Error("x"))).toBe(false);
    });
});

describe("estimates, months, prices", () => {
    it("estimates characters / 4, rounded up, and nothing for an empty text", () => {
        expect(estimateTokens("")).toBe(0);
        expect(estimateTokens("abcd")).toBe(1);
        expect(estimateTokens("abcde")).toBe(2);
        expect(estimateTokens("x".repeat(4000))).toBe(1000);
    });

    it("month and day keys are UTC and roll over at midnight on the first", () => {
        expect(monthOf(Date.parse("2026-10-31T23:59:59Z"))).toBe("2026-10");
        expect(monthOf(Date.parse("2026-11-01T00:00:00Z"))).toBe("2026-11");
        expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
        expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-03-01" });
        expect(daysBetween("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    });

    it("normalises purposes and keeps unknown labels out", () => {
        expect(normalisePurpose("repair")).toBe("repair");
        expect(normalisePurpose("something else")).toBe("other");
        expect(normalisePurpose(undefined)).toBe("other");
    });

    it("cost is per million tokens for input and output separately", () => {
        const p: Price = { inputPerMTok: 3, outputPerMTok: 15 };
        expect(costOf(1_000_000, 0, p)).toBe(3);
        expect(costOf(0, 1_000_000, p)).toBe(15);
        expect(costOf(41_000, 6_000, p)).toBeCloseTo(0.123 + 0.09, 10);
        expect(costOf(0, 0, p)).toBe(0);
    });

    it("short token text", () => {
        expect([0, 999, 1000, 1500, 41_200, 999_999, 1_500_000, 12_000_000].map(shortTokens)).toEqual(["0", "999", "1K", "1.5K", "41K", "1000K", "1.5M", "12M"]);
    });
});

describe("aggregation", () => {
    const row = (o: Partial<UsageRow>): UsageRow => ({ day: "2026-10-01", projectId: "p1", purpose: "analysis", model: "m-a", calls: 1, failedCalls: 0, inputTokens: 100, outputTokens: 10, images: 0, estimatedCalls: 0, ...o });
    const rows = [
        row({}),
        row({ day: "2026-10-01", purpose: "repair", inputTokens: 50, outputTokens: 5, calls: 2, failedCalls: 1 }),
        row({ day: "2026-10-03", projectId: "p2", model: "m-b", inputTokens: 1000, outputTokens: 200, estimatedCalls: 1, images: 2 }),
    ];

    it("totals sum everything and flag estimates; no price means no cost", () => {
        const t = totalsOf(rows);
        expect(t).toMatchObject({ calls: 4, failedCalls: 1, inputTokens: 1150, outputTokens: 215, totalTokens: 1365, images: 2, estimated: true, cost: null, unpricedTokens: 1365 });
    });

    it("prices only the models that have one and says how many tokens are left unpriced", () => {
        const t = totalsOf(rows, new Map([["m-a", { inputPerMTok: 10, outputPerMTok: 20 }]]));
        expect(t.cost).toBeCloseTo((150 / 1e6) * 10 + (15 / 1e6) * 20, 12);
        expect(t.unpricedTokens).toBe(1200);
    });

    it("groups by day (date order), project, purpose and model (largest first)", () => {
        expect(groupRows(rows, "day").map((g) => [g.key, g.totalTokens])).toEqual([["2026-10-01", 165], ["2026-10-03", 1200]]);
        expect(groupRows(rows, "project").map((g) => g.key)).toEqual(["p2", "p1"]);
        expect(groupRows(rows, "purpose").map((g) => [g.key, g.calls])).toEqual([["analysis", 2], ["repair", 2]]);
        expect(groupRows(rows, "model").map((g) => g.key)).toEqual(["m-b", "m-a"]);
    });

    it("the day series has an entry for every day of the range, zeros included", () => {
        const s = daySeries(rows, "2026-09-30", "2026-10-04");
        expect(s.map((g) => [g.key, g.totalTokens])).toEqual([["2026-09-30", 0], ["2026-10-01", 165], ["2026-10-02", 0], ["2026-10-03", 1200], ["2026-10-04", 0]]);
    });
});

// ── the meter ─────────────────────────────────────────────────────────────────

/** A scripted client: each call adds the numbers it was told to report to its own usage, like the real client does. */
function scripted(opts: { report?: { i: number; o: number } | null; images?: boolean; name?: string } = {}) {
    const report = opts.report === undefined ? { i: 100, o: 20 } : opts.report;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const seen = { object: 0, text: 0, image: 0, prompts: [] as string[] };
    const touch = () => {
        if (report) {
            usage.inputTokens += report.i;
            usage.outputTokens += report.o;
        }
    };
    const client: LlmClient = {
        modelName: opts.name ?? "scripted-model",
        model: new MockLanguageModelV3({}),
        usage,
        object: (async ({ prompt }: { prompt: string }) => {
            seen.object++;
            seen.prompts.push(prompt);
            touch();
            return { answer: "ok" };
        }) as LlmClient["object"],
        text: async ({ prompt }) => {
            seen.text++;
            seen.prompts.push(prompt);
            touch();
            return "an answer";
        },
    };
    if (opts.images !== false) {
        client.imageObject = (async () => {
            seen.image++;
            touch();
            return { ok: true };
        }) as NonNullable<LlmClient["imageObject"]>;
    }
    return { client, usage, seen };
}

const schema = z.object({ answer: z.string() });
const call = (c: LlmClient, purpose?: "analysis" | "repair", prompt = "p") => c.object({ system: "s", prompt, schema, purpose });

function setup(clockStart = "2026-10-15T12:00:00Z") {
    const db = new Db(":memory:");
    const clock = { now: Date.parse(clockStart) };
    const store = new UsageStore(db, {}, () => clock.now);
    const events: EngineEvent[] = [];
    const meterFor = (jobId: string, projectId = "p1", refreshEvery = 5) => new JobMeter({ backend: store, jobId, projectId, emit: (e) => events.push(e), now: () => new Date(clock.now), refreshEvery });
    return { db, store, clock, events, meterFor };
}

describe("the meter records every call", () => {
    it("rows per job, purpose, model and day with sums and counts (not one row per call)", async () => {
        const { store, meterFor } = setup();
        const s = scripted();
        const meter = meterFor("job-1");
        const llm = meter.wrap(s.client);
        await call(llm, "analysis");
        await call(llm, "analysis");
        await call(llm, "repair");
        await llm.text({ system: "s", prompt: "p" });
        await llm.imageObject!({ system: "s", prompt: "p", images: [{ data: new Uint8Array(1), mediaType: "image/png" }, { data: new Uint8Array(1), mediaType: "image/png" }], schema });
        meter.finish();

        const rows = store.jobRows("job-1");
        expect(rows).toHaveLength(4); // analysis, repair, other (text), vision
        const by = Object.fromEntries(rows.map((r) => [r.purpose, r]));
        expect(by.analysis).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 40, failedCalls: 0, estimatedCalls: 0, images: 0 });
        expect(by.repair).toMatchObject({ calls: 1, inputTokens: 100 });
        expect(by.other).toMatchObject({ calls: 1 });
        expect(by.vision).toMatchObject({ calls: 1, images: 2 });
        expect(by.analysis!.model).toBe("scripted-model");
        expect(store.jobTokens("job-1")).toBe(5 * 120);
        // the client's own counters are untouched: the engine still reads the same numbers
        expect(llm.usage).toBe(s.client.usage);
        expect(s.usage.inputTokens).toBe(500);
    });

    it("counts a client that reports no usage with the characters / 4 estimate and flags it", async () => {
        const { store, meterFor } = setup();
        const s = scripted({ report: null });
        const llm = meterFor("job-est").wrap(s.client);
        await llm.object({ system: "a".repeat(40), prompt: "b".repeat(360), schema }); // 400 chars in = 100 tokens
        const [r] = store.jobRows("job-est");
        expect(r).toMatchObject({ calls: 1, inputTokens: 100, estimatedCalls: 1 });
        expect(r!.outputTokens).toBe(estimateTokens(JSON.stringify({ answer: "ok" })));
        expect(totalsOf(store.jobRows("job-est")).estimated).toBe(true);
    });

    it("a failed call is counted as failed, and a call the SDK did not finish adds no tokens", async () => {
        const { store, meterFor } = setup();
        const s = scripted();
        s.client.object = (async () => {
            throw new Error("network down");
        }) as LlmClient["object"];
        const llm = meterFor("job-fail").wrap(s.client);
        await expect(call(llm)).rejects.toThrow("network down");
        expect(store.jobRows("job-fail")[0]).toMatchObject({ calls: 1, failedCalls: 1, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 });
    });

    it("keeps 'cannot look at images' true or false exactly as the inner client says, and leaves an unavailable client alone", () => {
        const { meterFor } = setup();
        expect(typeof meterFor("a").wrap(scripted({ images: false }).client).imageObject).toBe("undefined");
        expect(typeof meterFor("b").wrap(scripted().client).imageObject).toBe("function");
        const none = unavailableLlmClient("no key");
        expect(meterFor("c").wrap(none)).toBe(none);
    });

    it("never stores a prompt, an answer or an image: the database holds only counts and labels", async () => {
        const { db, meterFor } = setup();
        const s = scripted();
        const meter = meterFor("job-secret");
        const llm = meter.wrap(s.client);
        const SENTINEL = "SENTINEL-PROMPT-TEXT-7f3a9c";
        await call(llm, "analysis", `Please read ${SENTINEL}`);
        await llm.text({ system: SENTINEL, prompt: SENTINEL });
        meter.finish();
        const everything = ["ai_usage", "ai_prices", "ai_settings", "ai_project_budgets", "ai_budget_stops"].map((t) => JSON.stringify(db.all(`SELECT * FROM ${t}`))).join("\n");
        expect(everything).not.toContain("SENTINEL");
        expect(everything).not.toContain("an answer");
        expect(s.seen.prompts.join("")).toContain(SENTINEL); // the double really saw it; only the store never does
    });
});

describe("the meter enforces budgets before each call", () => {
    it("refuses with BudgetExceeded once the job cap is reached, never calls the model, and keeps counting what was used", async () => {
        const { store, events, meterFor } = setup();
        store.setPlatformBudget({ jobTokens: 300 }); // each call uses 120
        const s = scripted();
        const meter = meterFor("job-cap");
        const llm = meter.wrap(s.client);
        await call(llm); // 120
        await call(llm); // 240  (warning: 80% of 300 = 240)
        await call(llm); // allowed (240 < 300), ends at 360: one call may overshoot
        expect(store.jobTokens("job-cap")).toBe(360);
        const err = await call(llm).catch((e) => e);
        expect(err).toBeInstanceOf(BudgetExceeded);
        expect(err.message).toBe("The AI token limit for this job was reached");
        expect(err.hit).toMatchObject({ cap: "job", used: 360, limit: 300 });
        expect(s.seen.object).toBe(3); // the fourth never reached the double
        await expect(llm.text({ system: "s", prompt: "p" })).rejects.toBeInstanceOf(BudgetExceeded);
        await expect(llm.imageObject!({ system: "s", prompt: "p", images: [], schema })).rejects.toBeInstanceOf(BudgetExceeded);
        expect(store.jobTokens("job-cap")).toBe(360); // refused calls add nothing

        // one stop event with the cap and the numbers, one record for the UI
        const stops = events.filter((e) => e.kind === "ai_budget_stop");
        expect(stops).toHaveLength(1);
        expect(stops[0]!.message).toBe("The AI token limit for this job was reached. This job: 360 of 300 tokens used. AI work stops here; what was already created is kept.");
        expect(store.stopOf("job-cap")).toMatchObject({ jobId: "job-cap", projectId: "p1", cap: "job", used: 360, limit: 300 });
        expect(meter.stop?.cap).toBe("job");
    });

    it("warns once per cap when the threshold is crossed", async () => {
        const { store, events, meterFor } = setup();
        store.setPlatformBudget({ jobTokens: 600 });
        const llm = meterFor("job-warn").wrap(scripted().client);
        for (let i = 0; i < 4; i++) await call(llm); // 120, 240, 360, 480 (= 80%)
        const warnings = events.filter((e) => e.kind === "ai_budget_warning");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.level).toBe("warn");
        expect(warnings[0]!.message).toBe("AI use has reached 80% of the limit for this job (480 of 600 tokens).");
        await call(llm);
        expect(events.filter((e) => e.kind === "ai_budget_warning")).toHaveLength(1);
    });

    it("checks the call's own estimated input against the room left", async () => {
        const { store, meterFor } = setup();
        store.setPlatformBudget({ jobTokens: 150 });
        const s = scripted();
        const llm = meterFor("job-big").wrap(s.client);
        await call(llm); // 120 used, 30 left
        const big = await call(llm, undefined, "x".repeat(400)).catch((e) => e); // ~100 tokens would not fit
        expect(big).toBeInstanceOf(BudgetExceeded);
        expect(s.seen.object).toBe(1);
        expect(await call(llm, undefined, "short")).toBeTruthy(); // 30 tokens left, ~2 needed
    });

    it("the project cap and the month cap count across jobs; another project is not affected", async () => {
        const { store, meterFor } = setup();
        store.setPlatformBudget({ monthlyTokens: 1000 });
        store.setProjectBudget("p1", { monthlyTokens: 240 });
        const a = meterFor("job-a", "p1").wrap(scripted().client);
        await call(a);
        await call(a); // p1 month: 240 = at the cap
        const b = meterFor("job-b", "p1");
        const err = await call(b.wrap(scripted().client)).catch((e) => e);
        expect(err).toBeInstanceOf(BudgetExceeded);
        expect(err.hit).toMatchObject({ cap: "project", used: 240, limit: 240 });
        expect(err.message).toBe("The AI token limit for this project was reached");

        // project 2 has no project cap of its own and is fine until the platform month cap
        const other = meterFor("job-c", "p2");
        const c = other.wrap(scripted().client);
        for (let i = 0; i < 6; i++) await call(c); // 6 x 120 = 720; with p1's 240 = 960 < 1000
        await call(c); // 960 < 1000 allowed, now 1080
        const err2 = await call(c).catch((e) => e);
        expect(err2.hit).toMatchObject({ cap: "month", limit: 1000 });
        expect(err2.message).toBe("The AI token limit for this month was reached");
    });

    it("the lower of the platform and project job caps applies", async () => {
        const { store } = setup();
        store.setPlatformBudget({ jobTokens: 1000 });
        store.setProjectBudget("p1", { jobTokens: 400 });
        expect(store.capsFor("p1").caps.job).toBe(400);
        expect(store.capsFor("p2").caps.job).toBe(1000);
        store.setProjectBudget("p1", { jobTokens: 5000 });
        expect(store.capsFor("p1").caps.job).toBe(1000);
        store.setProjectBudget("p1", { jobTokens: null });
        store.setPlatformBudget({ jobTokens: null });
        expect(store.capsFor("p1").caps.job).toBeNull();
    });

    it("rolls over at the start of a new month: last month's tokens no longer count", async () => {
        const { store, clock, meterFor } = setup("2026-10-31T23:00:00Z");
        store.setPlatformBudget({ monthlyTokens: 200 });
        const s = scripted();
        const oct = meterFor("job-oct").wrap(s.client);
        await call(oct);
        await call(oct); // 240 in October
        expect(await call(oct).catch((e) => e)).toBeInstanceOf(BudgetExceeded);

        clock.now = Date.parse("2026-11-01T00:00:01Z");
        const nov = meterFor("job-nov").wrap(scripted().client);
        expect(await call(nov)).toBeTruthy();
        expect(store.monthTokens("2026-10")).toBe(240);
        expect(store.monthTokens("2026-11")).toBe(120);
        // the very same meter notices the new month too
        clock.now = Date.parse("2026-12-01T00:00:01Z");
        expect(await call(oct)).toBeTruthy();
    });

    it("with no cap set nothing is ever refused or warned about", async () => {
        const { events, meterFor } = setup();
        const llm = meterFor("job-free").wrap(scripted({ report: { i: 5_000_000, o: 5_000_000 } }).client);
        for (let i = 0; i < 4; i++) await call(llm);
        expect(events).toEqual([]);
    });

    it("accounting trouble never breaks a call", async () => {
        const broken = {
            addUsage: () => {
                throw new Error("disk full");
            },
            totalsFor: () => {
                throw new Error("disk full");
            },
            capsFor: () => {
                throw new Error("disk full");
            },
            recordStop: () => undefined,
        };
        const quiet = console.error;
        console.error = () => undefined;
        try {
            const llm = new JobMeter({ backend: broken, jobId: "j", projectId: "p" }).wrap(scripted().client);
            expect(await call(llm)).toEqual({ answer: "ok" });
        } finally {
            console.error = quiet;
        }
    });
});

describe("the authoring agent's direct use of the model is metered too", () => {
    const usage = { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

    it("each step is checked before it is made and the agent's own token additions are counted as authoring", async () => {
        const { store, events, meterFor } = setup();
        store.setPlatformBudget({ jobTokens: 100 }); // each step is reported as 60 (what the agent adds from onStepFinish)
        let doGenerates = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                doGenerates++;
                return { content: [{ type: "tool-call" as const, toolCallId: `c${doGenerates}`, toolName: "ping", input: "{}" }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
            },
        });
        const s = scripted({ report: null });
        (s.client as { model: unknown }).model = model;
        const meter = meterFor("job-agent");
        const llm = meter.wrap(s.client);

        const tools = { ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
        // exactly what web/author.ts does: use client.model directly and add each step's usage to client.usage
        const run = generateText({
            model: llm.model,
            prompt: "go",
            tools,
            stopWhen: stepCountIs(6),
            onStepFinish: (e) => {
                llm.usage.inputTokens += e.usage.inputTokens ?? 0;
                llm.usage.outputTokens += e.usage.outputTokens ?? 0;
            },
        });
        await expect(run).rejects.toBeInstanceOf(BudgetExceeded);
        // step 1 (60) and step 2 (120 >= 100 after it) -> the third step is refused before the model is asked
        expect(doGenerates).toBe(2);
        meter.finish();
        const rows = store.jobRows("job-agent");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ purpose: "authoring", calls: 2, inputTokens: 100, outputTokens: 20 });
        expect(events.some((e) => e.kind === "ai_budget_stop")).toBe(true);
    });
});

describe("the store: two instances over one database file (an API process and a worker)", () => {
    it("see each other's usage and budgets, and no update is lost", async () => {
        const file = path.join(tmpDir(), "platform.db");
        const dbA = new Db(file);
        const dbB = new Db(file);
        const a = new UsageStore(dbA);
        const b = new UsageStore(dbB);
        const at = new Date("2026-10-15T10:00:00Z");
        const add = (s: UsageStore, jobId: string, tokens: number) => s.addUsage({ jobId, projectId: "p1", purpose: "analysis", model: "m", at, calls: 1, failedCalls: 0, inputTokens: tokens, outputTokens: 0, images: 0, estimatedCalls: 0 });
        for (let i = 0; i < 20; i++) {
            add(a, "j1", 10);
            add(b, "j1", 5); // the same row, from the other process
        }
        expect(a.jobTokens("j1")).toBe(300);
        expect(b.jobTokens("j1")).toBe(300);
        expect(a.jobRows("j1")[0]).toMatchObject({ calls: 40, inputTokens: 300 });
        expect(b.monthTokens("2026-10", "p1")).toBe(300);
        expect(b.monthTokens("2026-10", "other")).toBe(0);

        a.setPlatformBudget({ monthlyTokens: 500 });
        a.setProjectBudget("p1", { jobTokens: 100 });
        a.setPrice("m", { inputPerMTok: 1, outputPerMTok: 2 });
        expect(b.platformBudget()).toMatchObject({ monthlyTokens: 500, monthlySource: "app" });
        expect(b.projectBudget("p1")).toEqual({ monthlyTokens: null, jobTokens: 100 });
        expect(b.prices().get("m")).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
        dbA.close();
        dbB.close();
    });

    it("a second process's spending stops a job within the refresh interval (counters are re-read every N calls)", async () => {
        const file = path.join(tmpDir(), "platform.db");
        const dbA = new Db(file);
        const dbB = new Db(file);
        const worker = new UsageStore(dbA);
        const other = new UsageStore(dbB);
        worker.setProjectBudget("p1", { monthlyTokens: 1000 });
        const now = () => new Date("2026-10-15T10:00:00Z");
        const meter = new JobMeter({ backend: worker, jobId: "mine", projectId: "p1", now, refreshEvery: 2 });
        const llm = meter.wrap(scripted().client);
        await call(llm); // 120, counters seeded here
        // another process (a second worker or the API) spends the rest of the month's budget
        other.addUsage({ jobId: "theirs", projectId: "p1", purpose: "analysis", model: "m", at: now(), calls: 1, failedCalls: 0, inputTokens: 900, outputTokens: 0, images: 0, estimatedCalls: 0 });
        // not visible yet (0 calls since the last read is below the interval of 2), so one more call is allowed...
        await call(llm);
        // ...and by the next one the store has been re-read and the project is over its cap
        const err = await call(llm).catch((e) => e);
        expect(err).toBeInstanceOf(BudgetExceeded);
        expect(err.hit).toMatchObject({ cap: "project", limit: 1000 });
        expect(err.hit.used).toBe(1140); // 900 from the other process + 2 x 120 from this one
        dbA.close();
        dbB.close();
    });
});

describe("settings and schedule skipping", () => {
    it("environment defaults apply until the app sets a value; the app's value (or 'no limit') wins", () => {
        const db = new Db(":memory:");
        const s = new UsageStore(db, { monthlyTokens: 5000, jobTokens: 700 });
        expect(s.platformBudget()).toMatchObject({ monthlyTokens: 5000, monthlySource: "environment", jobTokens: 700, jobSource: "environment", warnPercent: 80 });
        s.setPlatformBudget({ monthlyTokens: 9000, warnPercent: 90 });
        expect(s.platformBudget()).toMatchObject({ monthlyTokens: 9000, monthlySource: "app", jobTokens: 700, warnPercent: 90 });
        s.setPlatformBudget({ monthlyTokens: null });
        expect(s.platformBudget()).toMatchObject({ monthlyTokens: null, monthlySource: "none" });
        // leaving a field out keeps it
        s.setPlatformBudget({ jobTokens: 800 });
        expect(s.platformBudget()).toMatchObject({ monthlyTokens: null, jobTokens: 800 });
    });

    it("the .env limits are whole numbers, empty means unset, and nonsense is refused at start-up", () => {
        expect(loadConfig({}).AI_MONTHLY_TOKEN_LIMIT).toBeUndefined();
        expect(loadConfig({ AI_MONTHLY_TOKEN_LIMIT: "", AI_JOB_TOKEN_LIMIT: "  " }).AI_JOB_TOKEN_LIMIT).toBeUndefined();
        const c = loadConfig({ AI_MONTHLY_TOKEN_LIMIT: "5000000", AI_JOB_TOKEN_LIMIT: "400_000" });
        expect([c.AI_MONTHLY_TOKEN_LIMIT, c.AI_JOB_TOKEN_LIMIT]).toEqual([5_000_000, 400_000]);
        for (const bad of ["abc", "0", "-5", "1.5"]) expect(() => loadConfig({ AI_MONTHLY_TOKEN_LIMIT: bad }), bad).toThrow();
    });

    it("a project is barred from new AI runs only by a monthly cap that is used up; per-job caps and other months never bar it", () => {
        const clock = { now: Date.parse("2026-10-15T00:00:00Z") };
        const s = new UsageStore(new Db(":memory:"), {}, () => clock.now);
        const spend = (project: string, tokens: number, at = clock.now) => s.addUsage({ jobId: `j-${project}-${at}`, projectId: project, purpose: "analysis", model: "m", at: new Date(at), calls: 1, failedCalls: 0, inputTokens: tokens, outputTokens: 0, images: 0, estimatedCalls: 0 });
        expect(aiSkipReason(s, "p1")).toBeNull(); // nothing set
        s.setPlatformBudget({ monthlyTokens: 1000, jobTokens: 1 });
        spend("p1", 999);
        expect(aiSkipReason(s, "p1")).toBeNull(); // 999 < 1000, and a job cap of 1 is not a monthly bar
        spend("p2", 1);
        expect(aiSkipReason(s, "p1")).toBe("Skipped: the AI token limit for this month was reached, so a new analysis could not run. Raise the limit in Settings or wait until next month. Runs that only re-run existing tests are not affected.");
        s.setProjectBudget("p3", { monthlyTokens: 5 });
        spend("p3", 5, Date.parse("2026-09-30T23:00:00Z")); // last month: does not count
        s.setPlatformBudget({ monthlyTokens: null });
        expect(aiSkipReason(s, "p3")).toBeNull();
        spend("p3", 5);
        expect(aiSkipReason(s, "p3")).toMatch(/limit for this project was reached/);
        expect(aiSkipReason(s, "p1")).toBeNull();
        clock.now = Date.parse("2026-11-02T00:00:00Z"); // next month everyone is free again
        expect(aiSkipReason(s, "p3")).toBeNull();
    });

    it("prices: set, replace, remove, and the currency label", () => {
        const s = new UsageStore(new Db(":memory:"));
        expect(s.prices().size).toBe(0); // no built-in prices
        expect(s.currency()).toBe("");
        s.setPrice("m1", { inputPerMTok: 3, outputPerMTok: 15 });
        s.setPrice("m1", { inputPerMTok: 4, outputPerMTok: 16 });
        s.setCurrency("EUR");
        expect([...s.prices()]).toEqual([["m1", { inputPerMTok: 4, outputPerMTok: 16 }]]);
        expect(s.currency()).toBe("EUR");
        expect(s.deletePrice("m1")).toBe(true);
        expect(s.deletePrice("m1")).toBe(false);
    });
});
