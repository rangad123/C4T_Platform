/**
 * The bounded "previously known" section handed to the understanding and planning prompts.
 * It is context, not instructions to skip anything: the crawl data in the same prompt stays the source of truth.
 */
import type { MemoryChanges, SiteKnowledge } from "./types.js";

/** Marker line tests (and logs) can look for. */
export const MEMORY_HEADING = "Previously known about this application";

/** Hard bound on the section, in characters (~1.2k tokens). */
export const MAX_CONTEXT_CHARS = 5_000;
const MAX_PAGE_LINES = 40;
const MAX_ENDPOINT_LINES = 25;
const MAX_JOURNEY_LINES = 15;

const list = (items: string[], max: number) => (items.length > max ? `${items.slice(0, max).join("; ")}; and ${items.length - max} more` : items.join("; "));

export function memoryContext(k: SiteKnowledge, stage: "understanding" | "planning", early?: MemoryChanges): string {
    const date = k.analysedAt.slice(0, 10);
    const lines: string[] = [
        `${MEMORY_HEADING} (structural notes from the analysis of ${date}; context only, the crawl data below is the source of truth):`,
        `- Type: ${k.siteType || "unknown"}. Purpose: ${k.purpose || "unknown"}.`,
    ];
    if (k.loginPath) lines.push(`- Sign-in page: ${k.loginPath}`);
    if (k.pages.length) {
        lines.push(`- Pages known (${k.pages.length}): ${list(k.pages.map((p) => `${p.path} [${p.type}]${p.title ? ` "${p.title}"` : ""}`), MAX_PAGE_LINES)}`);
    }
    if (k.journeys.length) {
        const js = k.journeys.map((j) => `"${j.name}" (${j.priority}${j.requiresAuth ? ", needs sign-in" : ""}${j.validated.length ? `; validated tests: ${j.validated.slice(0, 3).map((t) => `"${t}"`).join(", ")}` : ""})`);
        lines.push(`- Journeys identified before: ${list(js, MAX_JOURNEY_LINES)}`);
    }
    if (k.apis.length) lines.push(`- API endpoints seen: ${list(k.apis.map((a) => `${a.method} ${a.path}`), MAX_ENDPOINT_LINES)}`);
    if (early) {
        const bits = [
            early.counts.pagesAdded ? `new pages: ${list(early.pagesAdded, 10)}` : "",
            early.counts.pagesChanged ? `pages whose structure changed: ${list(early.pagesChanged, 10)}` : "",
            early.counts.pagesRemoved ? `not found in this crawl: ${list(early.pagesRemoved, 10)}` : "",
            early.counts.endpointsAdded ? `new endpoints: ${list(early.endpointsAdded, 10)}` : "",
            early.counts.endpointsRemoved ? `endpoints not seen now: ${list(early.endpointsRemoved, 10)}` : "",
        ].filter(Boolean);
        lines.push(`- What the new crawl shows compared with that: ${bits.length ? bits.join(" | ") : "nothing structural changed"}`);
    }
    const rule =
        stage === "understanding"
            ? "Use this to keep journey names and wording stable where the journey still exists, and to spend your attention on what is new or changed. Do NOT describe a page, feature or journey that the crawl data does not show; a page missing from the crawl is reported as missing, never assumed."
            : "Use this to keep scenario titles stable where a validated scenario still applies, and to cover what is new or changed first. Do NOT plan scenarios for pages or controls that are not in the model above.";
    // The closing rule always survives; it is the body that gets shortened when the section is too long.
    const body = lines.join("\n");
    const room = MAX_CONTEXT_CHARS - rule.length - 1;
    return `${body.length > room ? `${body.slice(0, room - 1)}…` : body}\n${rule}`;
}
