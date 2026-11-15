/**
 * The money limit on AI work paid by the server's own key (AI_SERVER_KEY_MONTHLY_USD_LIMIT; operator access: the shared access key, a
 * server without accounts). Spend comes from the price table; with a limit set, a model without a price is refused (fail closed); other
 * keys are never limited by it. A scripted client and an in-memory store; no real model is called.
 */
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { JobMeter, SPEND_CAP } from "../src/engine/llm/metered.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { isBudgetExceeded, SpendLimitExceeded, type UsageBilling } from "../src/engine/llm/usage.js";
import { Db } from "../src/platform/db.js";
import { UsageStore, usageStoreFor } from "../src/platform/usage-store.js";

const schema = z.object({ answer: z.string() });

/** A client that reports 1,000,000 input and 100,000 output tokens per call: $1 + $1 at the prices below. */
function client(name = "m-priced"): LlmClient {
    const usage = { inputTokens: 0, outputTokens: 0 };
    return {
        modelName: name,
        model: new MockLanguageModelV3({}),
        usage,
        object: (async () => {
            usage.inputTokens += 1_000_000;
            usage.outputTokens += 100_000;
            return { answer: "ok" };
        }) as LlmClient["object"],
        text: async () => {
            usage.inputTokens += 1_000_000;
            usage.outputTokens += 100_000;
            return "ok";
        },
    };
}

function setup(limitUsd: number | undefined, start = "2026-10-15T12:00:00Z") {
    const db = new Db(":memory:");
    const clock = { now: Date.parse(start) };
    const store = new UsageStore(db, limitUsd === undefined ? {} : { serverMonthlyUsd: limitUsd }, () => clock.now);
    store.setPrice("m-priced", { inputPerMTok: 1, outputPerMTok: 10 });
    const events: EngineEvent[] = [];
    const meter = (billing: UsageBilling, jobId = "job-1", name = "m-priced") =>
        new JobMeter({ backend: store, jobId, projectId: "p1", emit: (e) => events.push(e), now: () => new Date(clock.now), refreshEvery: 1, billing }).wrap(client(name));
    return { db, store, clock, events, meter };
}
const ask = (llm: LlmClient) => llm.object({ system: "s", prompt: "p", schema });
const SERVER: UsageBilling = { owner: "server" };

describe("the server key's monthly money limit", () => {
    it("lets work go on under the limit and counts what it cost from the price table", async () => {
        const { store, meter } = setup(5);
        const llm = meter(SERVER);
        await ask(llm);
        await ask(llm);
        const spend = store.serverSpend("2026-10");
        expect(spend.usd).toBeCloseTo(4, 6);
        expect(spend).toMatchObject({ calls: 2, unpricedModels: [], limitUsd: 5 });
    });

    it("stops the work cleanly at the limit, with a sentence in dollars, a stop record and an event", async () => {
        const { store, meter, events } = setup(3);
        const llm = meter(SERVER);
        await ask(llm);
        await ask(llm); // $4 spent: the next call is refused
        const err = await ask(llm).catch((e) => e);
        expect(err).toBeInstanceOf(SpendLimitExceeded);
        expect(isBudgetExceeded(err)).toBe(true);
        expect(err.message).toBe("The server key's monthly AI spending limit was reached: about $4.00 of $3.00 this month.");
        expect(store.stopOf("job-1")).toMatchObject({ cap: SPEND_CAP, used: 400, limit: 300 });
        expect(events.find((e) => e.kind === "ai_budget_stop")?.message).toContain("AI work stops here");
        expect(store.serverSpend("2026-10").calls).toBe(2);
    });

    it("starts again in a new month (UTC)", async () => {
        const { clock, meter } = setup(3);
        const llm = meter(SERVER);
        await ask(llm);
        await ask(llm);
        await expect(ask(llm)).rejects.toThrow(/spending limit was reached/);
        clock.now = Date.parse("2026-11-01T00:00:01Z");
        await expect(ask(meter(SERVER, "job-2"))).resolves.toEqual({ answer: "ok" });
    });

    it("never limits work paid by an organisational or a personal key", async () => {
        const { meter, store } = setup(1);
        await ask(meter(SERVER));
        await ask(meter(SERVER, "job-x")).catch(() => undefined);
        for (const billing of [{ owner: "crowd4test" }, { owner: "personal", personId: "u1" }] as UsageBilling[]) {
            const llm = meter(billing, `job-${billing.owner}`, "m-unpriced");
            await expect(ask(llm)).resolves.toEqual({ answer: "ok" });
            await expect(ask(llm)).resolves.toEqual({ answer: "ok" });
        }
        expect(store.spendBlock({ owner: "crowd4test" }, "m-unpriced", "2026-10")).toBeNull();
        expect(store.spendBlock({ owner: "personal" }, "m-unpriced", "2026-10")).toBeNull();
    });

    it("with a limit set, a model without a price is refused: its cost is unknown, never counted as zero", async () => {
        const { store, meter } = setup(100);
        const err = await ask(meter(SERVER, "job-u", "m-unpriced")).catch((e) => e);
        expect(err.message).toBe("The server key's monthly AI spending limit cannot be checked: no price is set for m-unpriced. Set its price in Settings, AI usage.");
        // Work already done on an unpriced model keeps the amount incomplete and refuses priced calls too, until a price is set.
        store.addUsage({ jobId: "old", projectId: "p1", purpose: "analysis", model: "m-old", at: new Date("2026-10-02T00:00:00Z"), calls: 1, failedCalls: 0, inputTokens: 500, outputTokens: 50, images: 0, estimatedCalls: 0, billing: SERVER });
        expect(store.serverSpend("2026-10")).toMatchObject({ usd: 0, unpricedModels: ["m-old"] });
        await expect(ask(meter(SERVER, "job-p"))).rejects.toThrow(/no price is set for m-old/);
        store.setPrice("m-old", { inputPerMTok: 1, outputPerMTok: 1 });
        await expect(ask(meter(SERVER, "job-q"))).resolves.toEqual({ answer: "ok" });
    });

    it("without a limit nothing is checked, priced or not", async () => {
        const { meter, store } = setup(undefined);
        await expect(ask(meter(SERVER, "job-n", "m-unpriced"))).resolves.toEqual({ answer: "ok" });
        expect(store.spendBlock(SERVER, "m-unpriced", "2026-10")).toBeNull();
        expect(store.serverSpend("2026-10").limitUsd).toBeNull();
    });

    it("server-key work still counts in the platform's monthly token total (Crowd4Test pays for it)", async () => {
        const { store, meter } = setup(undefined);
        await ask(meter(SERVER));
        expect(store.monthTokens("2026-10")).toBe(1_100_000);
        expect(store.jobRows("job-1")[0]?.billingOwner).toBe("server");
    });

    it("reads AI_SERVER_KEY_MONTHLY_USD_LIMIT from the settings (empty means off)", () => {
        expect(loadConfig({}).AI_SERVER_KEY_MONTHLY_USD_LIMIT).toBeUndefined();
        expect(loadConfig({ AI_SERVER_KEY_MONTHLY_USD_LIMIT: "" }).AI_SERVER_KEY_MONTHLY_USD_LIMIT).toBeUndefined();
        const c = loadConfig({ AI_SERVER_KEY_MONTHLY_USD_LIMIT: "12.5" });
        expect(c.AI_SERVER_KEY_MONTHLY_USD_LIMIT).toBe(12.5);
        expect(() => loadConfig({ AI_SERVER_KEY_MONTHLY_USD_LIMIT: "-1" })).toThrow();
        const store = usageStoreFor(new Db(":memory:"), c);
        expect(store.serverSpend().limitUsd).toBe(12.5);
    });
});
