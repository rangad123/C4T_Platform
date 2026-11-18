/**
 * An observed-only defect whose replay of its own steps (row 180) the exploration's limits refuse (row 213): it is not reported as a
 * finding. Its test is saved for review with the reason naming the limits, and the event is defect_unverified, not possible_defect.
 * A captured defect whose two independence replays are refused is still reported, with independence "not_run" (a separate path).
 * The loop's replay gate is wrapped to refuse those replays only; the rest of the exploration is the real one on the seeded shop.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-replay-refused.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CandidateFindingSchema } from "../src/engine/explore/finding.js";
import { COMPLIANT, exploreShop, OBJECTIVES_WITH_DATA, scriptedShopModel, startShop, type ShopSite } from "./fixtures/objectives-shop.js";

vi.mock("../src/engine/explore/loop.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../src/engine/explore/loop.js")>();
    return {
        ...real,
        runExploration: (input: Parameters<typeof real.runExploration>[0]) =>
            real.runExploration({
                ...input,
                runObjective: (o, ctx) =>
                    input.runObjective(o, {
                        ...ctx,
                        replay: (steps, what) => (/own steps|independence/.test(what) ? { allowed: false, reason: "the actions budget is spent" } : ctx.replay(steps, what)),
                    }),
            }),
    };
});

const PORT = 9867;
let site: ShopSite;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startShop(PORT);
}, 60_000);

afterAll(() => {
    site?.server.close();
});

describe("a replay the exploration's limits refuse", () => {
    it("an observed-only defect is saved for review and not reported; a captured one is reported without its independence replays", async () => {
        site.fixed = false;
        // The rule as stated: the test writer reports a defect without a check of a stated source, so it is observed only.
        const scripts = { ...COMPLIANT, "As stated": [COMPLIANT["As stated"]![0]!, COMPLIANT["As stated"]![2]!] };
        const { llm } = scriptedShopModel(() => scripts);
        const { events, tests } = await exploreShop(site, llm, OBJECTIVES_WITH_DATA);

        const observed = tests.find((t) => t.meta.capture === "observed_only")!;
        expect(observed).toBeDefined();
        expect(observed.validation).toBe("NEEDS_REVIEW");
        expect(observed.reason).toBe("Not reported as a finding: the exploration's limits did not allow the replay that checks it");
        expect(observed.meta.finding).toBeUndefined();
        expect(events.filter((e) => e.data?.testKey === observed.testId).map((e) => e.kind)).toEqual(["defect_unverified"]);

        const captured = tests.find((t) => t.meta.capture === "captured")!;
        expect(captured.validation).toBe("NEEDS_REVIEW");
        expect(CandidateFindingSchema.parse(captured.meta.finding)).toMatchObject({ capture: "captured", independence: "not_run" });
        expect(events.filter((e) => e.data?.testKey === captured.testId).map((e) => [e.kind, e.data?.independence])).toEqual([["possible_defect", "not_run"]]);
        expect(events.filter((e) => e.kind === "possible_defect")).toHaveLength(1);
    }, 300_000);
});
