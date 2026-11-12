// How the exploration child on a runner talks to the platform (round 51).
// `route` picks the endpoint: "llm" -> POST /api/agent/tasks/:id/explore/llm,
// "sink" -> POST /api/agent/tasks/:id/explore/sink. The body is JSON; the
// answer is the parsed JSON reply. A non-2xx reply rejects (409 = this task
// or attempt is no longer ours: stop).
export type ExplorePost = (route: "llm" | "sink", body: unknown, o?: { signal?: AbortSignal }) => Promise<unknown>;
