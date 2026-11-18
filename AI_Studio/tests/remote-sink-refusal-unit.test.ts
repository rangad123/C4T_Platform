/**
 * Queue row 202: when the platform refuses a numbered batch, every call of that batch rejects with the refusal, as the queued ones do,
 * so a caller waiting for an answer (createTest, nextTestKey...) gets the platform's sentence instead of waiting forever, and the job ends
 * with it. A stand-in platform (no HTTP); fast tier.
 */
import { describe, expect, it } from "vitest";
import { ExplorePostError } from "../src/agent/explore-child.js";
import type { ExplorePost } from "../src/agent/explore-transport.js";
import { remoteGenerationSink } from "../src/agent/remote-sink.js";

const REFUSAL = "The runner named a test this job did not create.";
const within = <T>(p: Promise<T>, ms = 3_000) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

/** Answers the first `ok` batches, then refuses every request with REFUSAL (400). */
function platform(ok: number) {
    let n = 0;
    const post: ExplorePost = async (_route, body) => {
        if (++n > ok) throw new ExplorePostError(REFUSAL, 400);
        return { results: (body as { calls: unknown[] }).calls.map(() => "WEB-001") };
    };
    return { post, batches: () => n };
}

describe("a refused batch", () => {
    it("rejects every call that was in it with the platform's sentence, and the ones queued after", async () => {
        const p = platform(0);
        const sink = remoteGenerationSink({ post: p.post, retryMs: 0 });
        // Made in one turn: one batch, refused as a whole.
        const key = sink.nextTestKey("WEB");
        const run = sink.startAgentRun("author", "WEB-001");
        const phase = sink.phase("GENERATING", "generation", "running");
        await expect(within(key)).rejects.toThrow(REFUSAL);
        await expect(within(run)).rejects.toThrow(REFUSAL);
        await phase; // queued, not answered: it resolved when it went into the batch
        expect(p.batches()).toBe(1);
        await expect(within(sink.nextTestKey("WEB"))).rejects.toThrow(REFUSAL);
        await expect(within(sink.flush())).rejects.toThrow(REFUSAL);
        expect(p.batches()).toBe(1);
    });

    it("a batch refused after good ones: the earlier answers stand, the refused batch's callers get the sentence", async () => {
        const p = platform(1);
        const sink = remoteGenerationSink({ post: p.post, retryMs: 0 });
        expect(await within(sink.nextTestKey("WEB"))).toBe("WEB-001");
        await expect(within(sink.nextTestKey("WEB"))).rejects.toThrow(REFUSAL);
        await expect(within(sink.flush())).rejects.toThrow(REFUSAL);
    });
});
