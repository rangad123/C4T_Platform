/**
 * Queue row 202: a runner's exploration whose platform refuses a save ends with the platform's sentence; it never hangs. The seeded shop
 * (tests/fixtures/objectives-shop.ts, port 9855) explored by objectives with a scripted model double (never a real model), saving through
 * the real remote sink (agent/remote-sink.ts) to a stand-in platform that answers every call until it refuses the batch holding the first
 * test the exploration saves, as the platform's sink route refuses (explore-sink.ts refuse, 400). The job ends as the runner's child ends
 * it (explore-child.ts: runGeneration, then the sink's flush) and fails with that sentence. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/remote-sink-refusal.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SinkRequest } from "../src/agent-protocol/explore-sink.js";
import { ExplorePostError } from "../src/agent/explore-child.js";
import type { ExplorePost } from "../src/agent/explore-transport.js";
import { remoteGenerationSink } from "../src/agent/remote-sink.js";
import { COMPLIANT, exploreShop, scriptedShopModel, startShop, type ShopSite } from "./fixtures/objectives-shop.js";

const PORT = 9855;
const REFUSAL = "This exploration has sent more files than the platform accepts for one job.";
let site: ShopSite;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startShop(PORT);
}, 60_000);
afterAll(() => {
    site?.server.close();
});

/** Answers every call, until a numbered batch holds a createTest: that batch, and every request after it, is refused. */
function refusingPlatform() {
    let ids = 0;
    let keys = 0;
    let refusing = false;
    const post: ExplorePost = async (route, body) => {
        if (route !== "sink") throw new ExplorePostError("not this route", 404);
        const req = SinkRequest.parse(body);
        if (refusing || (req.seq !== undefined && req.calls.some((c) => c.method === "createTest"))) {
            refusing = true;
            throw new ExplorePostError(REFUSAL, 400);
        }
        return {
            results: req.calls.map((c) => {
                switch (c.method) {
                    case "nextTestKey":
                        return `${c.prefix}-${String(++keys).padStart(3, "0")}`;
                    case "saveScript":
                    case "startAgentRun":
                    case "saveImageArtifact":
                        return `id-${++ids}`;
                    case "loadBaselines":
                        return [];
                    case "loadMemory":
                        return { knowledge: null };
                    default:
                        return null;
                }
            }),
        };
    };
    return { post, refused: () => refusing };
}

describe("a platform that refuses a save while a runner explores", () => {
    it("the job fails with the platform's sentence instead of waiting for the refused answer", async () => {
        site.fixed = false;
        const platform = refusingPlatform();
        const sink = remoteGenerationSink({ post: platform.post, retryMs: 0 });
        const { llm } = scriptedShopModel(() => COMPLIANT);
        const started = Date.now();
        const job = (async () => {
            await exploreShop(site, llm, { objectives: true }, { sink });
            await sink.flush();
        })();
        await expect(job).rejects.toThrow(REFUSAL);
        expect(platform.refused()).toBe(true);
        // Ends with the exploration (about a minute on the shop), not at the test's limit.
        expect(Date.now() - started).toBeLessThan(150_000);
    }, 200_000);
});
