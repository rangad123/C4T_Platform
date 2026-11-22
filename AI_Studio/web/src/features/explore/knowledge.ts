/**
 * "What the explorer knows" (GET /api/projects/:id/jobs/:jobId/knowledge, src/platform/routes/knowledge.ts): the answer's shape and the
 * reused badge's words. Pure (no React, no network).
 */

export interface KnowledgePage {
    path: string;
    title: string;
    type: string;
    depth: number;
    /** The date (ISO) of the exploration whose probe results this page took; absent: tried this run. */
    reusedFrom?: string;
    /** The id of its covered thumbnail (GET /api/artifacts/:id), while the file is kept. */
    thumbnail?: string;
    tests: Array<{ id: string; testKey: string; title: string }>;
}

export interface Knowledge {
    siteMap: { pages: KnowledgePage[]; from: "model" | "events" };
    reused: {
        pages: Array<{ path: string; since: string | null }>;
        total: number;
        spotChecked: number;
        expired: number;
        changed: number;
        reprobed: number;
        signIn: { path: string | null; since: string | null } | null;
        pagesFromMemory: { pages: number; gone: number } | null;
        understanding: { pages: number; of: number } | null;
        requirements: { total: number; inAreas: number; catchAll: number; notShown: number } | null;
        memory: string | null;
    };
    reuseOff: Array<{ reason: string; message: string }>;
    thumbnails: { keep: boolean; count: number };
    /** Left out by the platform for people who may not see AI usage and cost. */
    cacheSavings?: { aiCalls: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheReadPercent: number; aiCallsSaved: number; savedInputTokens?: number; savedOutputTokens?: number };
}

/** "reused 2026-11-10" for a page that took earlier results. */
export const reusedWord = (iso: string | null | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `Reused ${iso.slice(0, 10)}` : "Reused");
