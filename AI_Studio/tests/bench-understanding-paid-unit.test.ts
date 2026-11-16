/**
 * The paid understanding series' guard (src/eval/bench/understanding/paid.ts): every request asks for low effort, a request whose worst
 * case could pass the approved budget is not sent, the real cost is added from the answer's usage at the right price tier, and the key
 * stays out of the platforms' settings. Pure: a stand-in fetch, no provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { callCost, paidKeyFrom, paidPlatformEnv, paidPricesIn, SpendGuard, type PaidPrices } from "../src/eval/bench/understanding/paid.js";

const PRICES: PaidPrices = { provider: "anthropic", model: "claude-haiku-5-5", tiers: [{ upToInputTokens: 100_000, inputPerMTok: 0.1, outputPerMTok: 0.5 }, { inputPerMTok: 0.5, outputPerMTok: 2.5 }] };

/** A stand-in provider: records what it was sent, answers with the given usage. */
function standIn(usage: Record<string, number>) {
    const sent: Array<Record<string, unknown>> = [];
    const f: typeof fetch = async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "{}" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { sent, f };
}
const post = (f: typeof fetch, body: object) => f("https://provider.test/v1/messages", { method: "POST", body: JSON.stringify(body) });

describe("prices", () => {
    it("the first tier up to 100,000 prompt tokens, the second for the whole call beyond", () => {
        // 100,000 in × $0.10 + 1,000 out × $0.50, per million = $0.0105; 100,001 in at $0.50 and 1,000 out at $2.50 = $0.0525005.
        expect(callCost(PRICES, 100_000, 1_000)).toBeCloseTo(0.0105, 10);
        expect(callCost(PRICES, 100_001, 1_000)).toBeCloseTo(0.0525005, 10);
    });
    it("the shipped price file is the paid table; a free model's price rows are not", () => {
        expect(paidPricesIn(path.join(REPO_ROOT, "eval/bench-prices-claude.json"))).toMatchObject(PRICES);
        const rows = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aitp-prices-")), "free.json");
        fs.writeFileSync(rows, JSON.stringify([{ model: "free-model", inputPerMTok: 0, outputPerMTok: 0 }]));
        expect(paidPricesIn(rows)).toBeUndefined();
    });
});

describe("every request", () => {
    it("asks for low effort and keeps the structured-output format the SDK set", async () => {
        const p = standIn({ input_tokens: 10, output_tokens: 5 });
        await post(new SpendGuard(1, PRICES).fetch(p.f), { model: "claude-haiku-5-5", max_tokens: 1000, output_config: { format: { type: "json_schema" } } });
        expect(p.sent[0]!.output_config).toEqual({ format: { type: "json_schema" }, effort: "low" });
    });
    it("is charged from its usage, cache reads and writes as ordinary input", async () => {
        const p = standIn({ input_tokens: 1_000, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 1_000, output_tokens: 2_000 });
        const g = new SpendGuard(1, PRICES);
        await post(g.fetch(p.f), { max_tokens: 4000 });
        // 4,000 in × $0.10 + 2,000 out × $0.50, per million = $0.0014.
        expect(g.spent).toBeCloseTo(0.0014, 10);
        expect(g.calls).toBe(1);
    });
});

describe("the budget", () => {
    it("a request that could pass it is not sent: the run stops before, with the spend under the budget", async () => {
        // Each answer costs 20,000 out × $0.50 / M = $0.01. Worst case of each request: ~60 bytes in + 100,000 out × $0.50 / M ≈ $0.05.
        const p = standIn({ input_tokens: 0, output_tokens: 20_000 });
        const g = new SpendGuard(0.065, PRICES);
        const f = g.fetch(p.f);
        expect((await post(f, { max_tokens: 100_000 })).status).toBe(200); // 0 + 0.05 ≤ 0.065 → spent 0.01
        expect((await post(f, { max_tokens: 100_000 })).status).toBe(200); // 0.01 + 0.05 ≤ 0.065 → spent 0.02
        const third = await post(f, { max_tokens: 100_000 }); // 0.02 + 0.05 > 0.065 → refused
        expect(third.status).toBe(400);
        expect(p.sent).toHaveLength(2);
        expect(g.spent).toBeCloseTo(0.02, 10);
        expect(g.refused).toBe(1);
        expect(g.stopped).toMatch(/Stopped before a call that could take the spend past the approved \$0\.0\d/);
    });
    it("requests in flight at once count against it together: their worst cases are reserved until they answer", async () => {
        // Two requests with a worst case of $0.05 each start before either answers; with a budget of $0.065 only one may be sent.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const sent: unknown[] = [];
        const slow: typeof fetch = async (_url, init) => {
            sent.push(init?.body);
            await gate;
            return new Response(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 20_000 } }), { status: 200 });
        };
        const g = new SpendGuard(0.065, PRICES);
        const f = g.fetch(slow);
        const a = post(f, { max_tokens: 100_000 });
        const b = post(f, { max_tokens: 100_000 });
        await new Promise((r) => setTimeout(r, 20));
        release();
        const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
        expect(statuses).toEqual([200, 400]);
        expect(sent).toHaveLength(1);
        expect(g.spent).toBeCloseTo(0.01, 10);
    });
    it("a request without max_tokens is judged by the largest output the SDK would ask for", async () => {
        // 128,000 out × $0.50 / M = $0.064 > $0.05.
        const p = standIn({ input_tokens: 1, output_tokens: 1 });
        const g = new SpendGuard(0.05, PRICES);
        expect((await post(g.fetch(p.f), {})).status).toBe(400);
        expect(p.sent).toHaveLength(0);
    });
});

describe("the key", () => {
    it("is read from BENCH_ANTHROPIC_API_KEY only, without quotes", () => {
        expect(paidKeyFrom({ BENCH_ANTHROPIC_API_KEY: ' "sk-test-1" ' })).toBe("sk-test-1");
        expect(paidKeyFrom({ ANTHROPIC_API_KEY: "sk-other" })).toBeUndefined();
    });
    it("never reaches the platforms' settings: they get the one model and no provider key", () => {
        const env = paidPlatformEnv({ PATH: "/bin", BENCH_ANTHROPIC_API_KEY: "sk-test-1", ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", LLM_API_KEY: "sk-l", LLM_MODEL_FAST: "paid", LLM_PROVIDER: "openai" });
        expect(env).toEqual({ PATH: "/bin", LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-haiku-5-5" });
    });
});
