/**
 * "What the explorer knows" (GET /api/projects/:id/jobs/:jobId/knowledge, src/platform/routes/knowledge.ts): the answer's shape and the
 * site map's tree. Pure (no React, no network), so a test builds the tree from a recorded answer with the same rules the page uses.
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
    cacheSavings?: { aiCalls: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheReadPercent: number; aiCallsSaved: number };
}

export interface SiteNode {
    /** The page, or undefined for a part of the address no page was found at (a group). */
    page?: KnowledgePage;
    /** The address part this node stands for ("/products"). */
    path: string;
    children: SiteNode[];
}

const segments = (path: string): string[] => path.split("/").filter(Boolean);

/**
 * The pages as a tree by address: "/products/1" sits under "/products" when that page was found, else under a group "/products" with no page.
 * The home page ("/") is the root's first entry, not the parent of everything, so the top level stays the site's sections. Sorted by address.
 */
export function siteTree(pages: readonly KnowledgePage[]): SiteNode[] {
    const root: SiteNode = { path: "", children: [] };
    const byPath = new Map<string, SiteNode>();
    const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
    for (const page of sorted) {
        const segs = segments(page.path);
        if (!segs.length) {
            if (!byPath.has("/")) {
                const n: SiteNode = { page, path: "/", children: [] };
                byPath.set("/", n);
                root.children.unshift(n);
            }
            continue;
        }
        let parent = root;
        for (let i = 1; i <= segs.length; i++) {
            const at = `/${segs.slice(0, i).join("/")}`;
            let n = byPath.get(at);
            if (!n) {
                n = { path: at, children: [] };
                byPath.set(at, n);
                parent.children.push(n);
            }
            if (i === segs.length && !n.page) n.page = page;
            parent = n;
        }
    }
    // A group holding one entry and no page of its own adds nothing: its entry takes its place.
    const lift = (n: SiteNode): SiteNode => {
        const children = n.children.map(lift);
        if (!n.page && children.length === 1) return children[0]!;
        return { ...n, children };
    };
    return root.children.map(lift);
}

/** "reused 2026-11-10" for a page that took earlier results. */
export const reusedWord = (iso: string | null | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `Reused ${iso.slice(0, 10)}` : "Reused");
