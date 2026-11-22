/**
 * The harness's AI cost and call count (paid-shop-1: the result said $2.84 and 1,112 calls, the platform's usage records $4.29 and
 * 1,710). It counted the plan and creation jobs only; the reruns, the replays' repairs and the verification jobs of the app's project
 * were left out. An app's figures are now the project's usage records over the trial's days. A stub platform client; no app or model.
 */
import { describe, expect, it } from "vitest";
import { spentOf } from "../src/eval/bench/controller.js";
import type { PlatformClient } from "../src/eval/client.js";

describe("an app's AI use in a bench trial", () => {
    it("is the project's usage records over the trial's days, not only its plan and creation jobs", async () => {
        const asked: string[] = [];
        const client = {
            call: async (_method: string, url: string) => {
                asked.push(url);
                // paid-shop-1's project: 1,710 calls in all, of which 1,112 in the plan and creation jobs.
                return { status: 200, body: { totals: { calls: 1710, inputTokens: 37_000_000, outputTokens: 640_000, cacheReadTokens: 35_000_000, cacheWriteTokens: 0, cost: 4.29 } } };
            },
        } as unknown as PlatformClient;
        const jobs = { aiCalls: 1112, inputTokens: 26_420_303, outputTokens: 389_083, cacheReadTokens: 25_370_948, cacheWriteTokens: 0, cost: 2.84 };
        const spent = await spentOf(client, "p-shop", "2026-11-22T16:42:59.045Z", jobs);
        expect(spent).toMatchObject({ aiCalls: 1710, cost: 4.29, inputTokens: 37_000_000 });
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(/^\/api\/usage\?projectId=p-shop&from=2026-11-22&to=\d{4}-\d{2}-\d{2}$/);
    });

    it("keeps the jobs' figures when the records cannot be read or count fewer calls", async () => {
        const jobs = { aiCalls: 5, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 };
        const down = { call: async () => ({ status: 500, body: {} }) } as unknown as PlatformClient;
        expect(await spentOf(down, "p", "2026-11-22T00:00:00.000Z", jobs)).toEqual(jobs);
        const fewer = { call: async () => ({ status: 200, body: { totals: { calls: 3, inputTokens: 1, outputTokens: 1, cost: 0 } } }) } as unknown as PlatformClient;
        expect(await spentOf(fewer, "p", "2026-11-22T00:00:00.000Z", jobs)).toEqual(jobs);
    });
});
