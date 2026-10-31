/**
 * Exploration reuse: a page whose fingerprints have not changed since the last exploration is not sent to the AI again. The understanding
 * step gets one short line for it (its address, its kind, and what the AI understood it is for last time) instead of its accessibility
 * snapshot, and the earlier understanding is kept for it unless the AI says otherwise.
 *
 * "Not changed" is strict: the same address, the same structural fingerprint (headings and form fields, as the change summary uses) AND the
 * same understanding fingerprint (title, every control's role and name, the API calls the page makes; see distill.ts). A page saved by an
 * older version without the second fingerprint is sent again. The crawl itself always runs in full: reuse only changes what the AI is shown.
 * Pure; the orchestrator decides whether it applies (setting on, memory on, no "explore every page again").
 */
import type { AppModel, PageType } from "../understanding/app-model.js";
import { memoryPath, pageFingerprint, understandingFingerprint } from "./distill.js";
import type { SiteKnowledge } from "./types.js";

export interface ReusedPage {
    type: PageType;
    purpose?: string;
}

export interface ReusePlan {
    /** When the exploration whose understanding is reused ran (ISO). */
    since: string;
    /** Crawled page path (as in the AppModel) -> what was understood about it then. */
    pages: Map<string, ReusedPage>;
}

export function planReuse(previous: SiteKnowledge, model: Pick<AppModel, "pages">, secrets: string[] = []): ReusePlan {
    const known = new Map(previous.pages.map((p) => [p.path, p]));
    const pages = new Map<string, ReusedPage>();
    for (const p of model.pages) {
        const before = known.get(memoryPath(p.path, secrets));
        if (!before?.ufp) continue;
        if (before.fp !== pageFingerprint(p) || before.ufp !== understandingFingerprint(p)) continue;
        pages.set(p.path, { type: before.type, ...(before.purpose ? { purpose: before.purpose } : {}) });
    }
    return { since: previous.analysedAt, pages };
}

/** "3 of 5 pages have not changed since the exploration of 2026-10-01 ..." for the job log. */
export function reuseMessage(plan: ReusePlan, total: number): string {
    const n = plan.pages.size;
    const list = [...plan.pages.keys()].slice(0, 8).join(", ");
    const more = n > 8 ? ` and ${n - 8} more` : "";
    return `${n} of ${total} page${total === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} not changed since the exploration of ${plan.since.slice(0, 10)}: what the AI understood about ${n === 1 ? "it" : "them"} then is used, and ${n === 1 ? "it is" : "they are"} not sent to the AI again (${list}${more}).`;
}
