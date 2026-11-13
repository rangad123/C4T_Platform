// How the exploration child on a runner talks to the platform (round 51).
// `route` picks the endpoint: "llm" -> POST /api/agent/tasks/:id/explore/llm,
// "sink" -> POST /api/agent/tasks/:id/explore/sink, "frame" -> .../explore/frame (Watch live). The body is JSON; the
// answer is the parsed JSON reply. A non-2xx reply rejects (409 = this task
// or attempt is no longer ours: stop).
export type ExploreRoute = "llm" | "sink" | "frame";
export type ExplorePost = (route: ExploreRoute, body: unknown, o?: { signal?: AbortSignal }) => Promise<unknown>;

/** How long a call is tried again while the platform is away (a restart, a deploy): a couple of minutes. */
export const EXPLORE_RETRY_MS = 150_000;

/**
 * The agent could not reach the platform, or something in front of it said it is not there right now (explore-child.ts ExplorePostError:
 * no status, or 502/503/504). Never a refusal of the platform's own.
 */
const platformAway = (e: unknown): boolean => {
    if (!(e instanceof Error) || e.name !== "ExplorePostError") return false;
    const status = (e as { status?: unknown }).status;
    return status === undefined || status === 502 || status === 503 || status === 504;
};

/**
 * The same post, tried again with backoff (1 s doubling to 15 s) while the platform is away, for up to `withinMs`. A refusal (4xx, 500) or a
 * stop rejects at once. Safe for both routes: the platform applies a sink batch once by its sequence number, and a model call asked twice
 * costs only that call.
 */
export function retrying(post: ExplorePost, withinMs = EXPLORE_RETRY_MS): ExplorePost {
    if (withinMs <= 0) return post;
    return async (route, body, o) => {
        const until = Date.now() + withinMs;
        for (let wait = 1_000; ; wait = Math.min(wait * 2, 15_000)) {
            try {
                return await post(route, body, o);
            } catch (e) {
                if (o?.signal?.aborted || !platformAway(e) || Date.now() + wait > until) throw e;
                await new Promise<void>((resolve) => {
                    const t = setTimeout(done, wait);
                    function done() {
                        clearTimeout(t);
                        o?.signal?.removeEventListener("abort", done);
                        resolve();
                    }
                    o?.signal?.addEventListener("abort", done, { once: true });
                });
                if (o?.signal?.aborted) throw e;
            }
        }
    };
}
