/**
 * Queue row 187: a finding's screenshot is optional evidence, so a platform that refuses it never fails the job. A runner newer than its
 * platform sends `saveImageArtifact`, which an older platform does not know (its sink route refuses the whole request, 400). The runner's
 * remote sink sends that call on its own, outside the numbered batches, and takes any refusal or error as "no screenshot": the other
 * saves carry on, and the exploration completes with its findings saved and `screenshots: []`.
 *
 * The seeded shop (tests/fixtures/objectives-shop.ts, port 9854) explored by objectives with a scripted model double (never a real model),
 * saving through the real remote sink (agent/remote-sink.ts) to a stand-in for an older platform: it answers every call it knows and
 * refuses any request that holds `saveImageArtifact`, as SinkRequest's parse does on a platform without the method. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-image-refused.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SinkRequest, type SinkCall } from "../src/agent-protocol/explore-sink.js";
import { ExplorePostError } from "../src/agent/explore-child.js";
import type { ExplorePost } from "../src/agent/explore-transport.js";
import { remoteGenerationSink } from "../src/agent/remote-sink.js";
import { CandidateFindingSchema } from "../src/engine/explore/finding.js";
import { COMPLIANT, exploreShop, scriptedShopModel, startShop, type ShopSite } from "./fixtures/objectives-shop.js";

const PORT = 9854;
let site: ShopSite;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startShop(PORT);
}, 60_000);
afterAll(() => {
    site?.server.close();
});

/** An older platform's sink route: refuses a request with a method it does not know, answers the rest. */
function olderPlatform() {
    const created: Array<Extract<SinkCall, { method: "createTest" }>> = [];
    const refused: string[] = [];
    let keys = 0;
    let ids = 0;
    const post: ExplorePost = async (route, body) => {
        if (route !== "sink") throw new ExplorePostError("not this route", 404);
        const calls = (body as { calls: Array<{ method: string }> }).calls;
        if (calls.some((c) => c.method === "saveImageArtifact")) {
            refused.push(...calls.map((c) => c.method));
            throw new ExplorePostError("The runner sent a save the platform does not accept (calls.0.method: Invalid discriminator value).", 400);
        }
        const req = SinkRequest.parse(body);
        const results = req.calls.map((c) => {
            switch (c.method) {
                case "nextTestKey":
                    return `${c.prefix}-${String(++keys).padStart(3, "0")}`;
                case "createTest":
                    created.push(c);
                    return { id: `h_test${String(++ids).padStart(8, "0")}`, testId: c.spec.testId };
                case "saveScript":
                case "startAgentRun":
                    return `id-${++ids}`;
                case "loadBaselines":
                    return [];
                case "loadMemory":
                    return { knowledge: null };
                default:
                    return null;
            }
        });
        return { results };
    };
    return { post, created, refused };
}

describe("a platform that refuses a finding's screenshot", () => {
    it("the exploration completes, its findings saved with no screenshots; nothing else was refused", async () => {
        site.fixed = false;
        const platform = olderPlatform();
        const sink = remoteGenerationSink({ post: platform.post, retryMs: 0 });
        const { llm } = scriptedShopModel(() => COMPLIANT);
        const { summary } = await exploreShop(site, llm, { objectives: true, allowMutatingApiTests: true }, { sink });
        await sink.flush();

        expect(summary.errors).toEqual([]);
        expect(summary.exploration?.stopReason).toBe("objectives_done");
        // The screenshots were offered (one per replay of each finding), refused, and sent alone each time.
        expect(platform.refused).toEqual(["saveImageArtifact", "saveImageArtifact", "saveImageArtifact", "saveImageArtifact"]);
        const findings = platform.created.filter((c) => c.validation === "NEEDS_REVIEW").map((c) => CandidateFindingSchema.parse(c.meta?.finding));
        expect(findings).toHaveLength(2);
        for (const f of findings) expect(f).toMatchObject({ capture: "captured", independence: "independent", evidence: { screenshots: [] } });
    }, 300_000);

    it("a refused screenshot answers no reference and leaves the calls around it alone", async () => {
        const platform = olderPlatform();
        const sink = remoteGenerationSink({ post: platform.post, retryMs: 0 });
        const before = sink.nextTestKey("WEB");
        const shot = sink.saveImageArtifact!("screenshot", "WEB-001-finding-1.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const after = sink.nextTestKey("WEB");
        expect(await shot).toBeUndefined();
        expect([await before, await after]).toEqual(["WEB-001", "WEB-002"]);
        await sink.flush();
        expect(await sink.nextTestKey("WEB")).toBe("WEB-003");
    });
});
