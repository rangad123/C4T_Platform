/**
 * The model calls whose answers the platform may keep and give again for the same question (the AI response cache,
 * platform/llm-response-cache.ts). Only calls that read something and describe it are here: the understanding of the explored pages, the
 * business rules read from a source, the documentation pages read during discovery and the requirements read from a document.
 *
 * Never here, whatever their inputs: test plans and suite proposals (planning), test authoring and the agents' tool loops (tied to the live
 * browser), vision, review and oracle verdicts, repairs, and anything that judges a result. A call site opts in by passing `cacheAs`; the
 * platform refuses any other id.
 *
 * `version` is part of the stored answer's key. Raise it when the meaning of an answer changes without the prompt or the schema changing
 * (both are part of the key by themselves), so answers kept under the old meaning are never given again.
 */
export const RESPONSE_CACHE_CALLS = {
    understanding: { version: 1, label: "the understanding of the pages" },
    rules: { version: 1, label: "the rules read from a source" },
    docs: { version: 1, label: "a documentation page" },
    requirements: { version: 1, label: "the requirements read from a document" },
} as const;

export type ResponseCacheCall = keyof typeof RESPONSE_CACHE_CALLS;

export const isResponseCacheCall = (v: unknown): v is ResponseCacheCall => typeof v === "string" && Object.prototype.hasOwnProperty.call(RESPONSE_CACHE_CALLS, v);
