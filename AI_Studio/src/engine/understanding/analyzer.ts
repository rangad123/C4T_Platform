/**
 * Application understanding: turns the raw crawl into an AppModel with page purposes,
 * features and user journeys.
 *
 * The prompt framing (QA expert, ARIA-first, site type/purpose/flows) follows QAAgency's
 * `ExplorerAgent.analyzeSite` (MIT), applied to the *whole* crawl instead of only the landing page.
 */
import type { EngineContext } from "../context.js";
import type { ReusePlan } from "../memory/reuse.js";
import { notesBlock, type SiteNote } from "../memory/notes.js";

const withNotes = (notes: SiteNote[] | undefined, pages: Array<{ path: string }>) => {
    const b = notesBlock(notes, pages);
    return b ? `\n\n${b}` : "";
};
import {
    AnalysisSchema,
    type ApiEndpointModel,
    type AppModel,
    type PageModel,
} from "./app-model.js";

const SYSTEM = `You are a senior QA engineer analysing a web application from crawl data.
You see accessibility snapshots, forms, controls and API calls for pages of ONE application.
Describe what the application is and identify its important end-to-end user journeys.
Rules:
- Base everything on the crawl data; do not invent pages, features or flows that the data does not support.
- A journey is a goal-directed sequence a real user performs (e.g. "Search for a product and add it to the cart"), not a single click.
- Prefer a focused set of 4-12 journeys ordered by business importance. Authentication, core content/search, and any transaction/CRUD flows are usually critical.
- "pages" must use the exact paths from the crawl.`;

/** Said once above the pages when some of them are given as one line (exploration reuse). */
export const REUSE_NOTE = `Pages marked "unchanged" were understood in an earlier exploration and have not changed since; their snapshot is not repeated. You may leave them out of pagePurposes (their earlier purpose is kept).`;

function summarisePages(pages: PageModel[], budget = 45_000, reuse?: ReusePlan, elements = 14): string {
    // A page that did not change since the last exploration gets one line (exploration reuse, ../memory/reuse.ts): the budget goes to the others.
    const sent = pages.filter((p) => !reuse?.pages.has(p.path)).length;
    const perPage = Math.max(900, Math.floor(budget / Math.max(sent, 1)));
    return pages
        .map((p) => {
            const known = reuse?.pages.get(p.path);
            if (known) return `### ${p.path}  [${known.type}] title="${p.title}" status=${p.status}  (unchanged since the exploration of ${reuse!.since.slice(0, 10)}; understood then as: ${known.purpose ?? "no purpose noted"})`;
            const forms = p.forms
                .map((f) => `    form[${f.purpose}] fields: ${f.fields.map((x) => `${x.label || x.placeholder || x.name || x.type}(${x.type}${x.required ? ",req" : ""})`).join(", ")}`)
                .join("\n");
            // As many controls as the exploration level shows, within the page's share of the prompt.
            const comps = p.components
                .slice(0, elements)
                .map((c) => `${c.role}:"${c.name}"`)
                .join(", ")
                .slice(0, perPage);
            const aria = p.aria.slice(0, Math.max(300, perPage - 500));
            return [
                `### ${p.path}  [${p.type}] title="${p.title}" status=${p.status}`,
                p.headings.length ? `  headings: ${p.headings.slice(0, 6).join(" | ")}` : "",
                forms,
                comps ? `  controls: ${comps}` : "",
                p.revealed.length ? `  revealed by interaction: ${p.revealed.slice(0, 4).join(" ; ")}` : "",
                p.apiCalls.length ? `  api calls: ${p.apiCalls.join(", ")}` : "",
                `  accessibility snapshot:\n${aria.replace(/^/gm, "    ")}`,
            ]
                .filter(Boolean)
                .join("\n");
        })
        .join("\n\n");
}

export async function analyzeApplication(
    ctx: EngineContext,
    base: Omit<AppModel, "siteType" | "purpose" | "features" | "journeys">,
    /** `memory`: the bounded "previously known" section from site memory (context only; the crawl stays the source of truth). */
    opts: {
        memory?: string;
        /** The project's notes for the AI (memory/notes.ts): all of them, a path note beside the pages it covers. */
        notes?: SiteNote[];
        /** Pages that did not change since the last exploration: one line each, their earlier understanding kept. */
        reuse?: ReusePlan;
        /** Controls per page shown to the AI (the exploration level's digestElementsPerPage). Default 14. */
        digestElementsPerPage?: number;
    } = {},
): Promise<AppModel> {
    const apiText = base.apis.length
        ? base.apis.slice(0, 40).map((a: ApiEndpointModel) => `${a.method} ${a.path} → ${a.statuses.join("/") || "?"} (${a.source})`).join("\n")
        : "none observed";

    const analysis = await ctx.llm.object({
        system: SYSTEM,
        schema: AnalysisSchema,
        // One purpose line per page: a larger exploration needs room for all of them.
        maxOutputTokens: Math.min(16_000, 6_000 + 40 * base.pages.length),
        purpose: "analysis",
        prompt: `Application: ${base.url}
Authentication: ${base.authentication.required ? "login required/available" : "no login form detected"}${base.authentication.loginPath ? ` (login page ${base.authentication.loginPath})` : ""}
Documented tests found on site: ${base.documentedTestCases.length}

API calls observed or documented:
${apiText}

Pages (${base.pages.length}):
${opts.reuse?.pages.size ? `${REUSE_NOTE}\n` : ""}${summarisePages(base.pages, undefined, opts.reuse, opts.digestElementsPerPage)}${opts.memory ? `\n\n${opts.memory}` : ""}${withNotes(opts.notes, base.pages)}`,
    });

    const byPath = new Map(analysis.pagePurposes.map((p) => [p.path, p]));
    const pages = base.pages.map((p) => {
        const hit = byPath.get(p.path) ?? byPath.get(new URL(p.url).pathname);
        if (hit) return { ...p, type: hit.type, purpose: hit.purpose };
        // Not answered for a page that did not change: what was understood about it last time stays.
        const known = opts.reuse?.pages.get(p.path);
        return known ? { ...p, type: known.type, ...(known.purpose ? { purpose: known.purpose } : {}) } : p;
    });
    const known = new Set(pages.map((p) => p.path.split("?")[0]));

    ctx.emit({
        stage: "analysis",
        kind: "application_understood",
        message: `${analysis.siteType}: ${analysis.purpose}`,
        data: { features: analysis.features.length, journeys: analysis.journeys.length },
    });
    for (const j of analysis.journeys) {
        ctx.emit({ stage: "analysis", kind: "flow_identified", message: `Journey: ${j.name} (${j.priority})`, data: { pages: j.pages } });
    }

    return {
        ...base,
        pages,
        siteType: analysis.siteType,
        purpose: analysis.purpose,
        features: analysis.features,
        journeys: analysis.journeys.map((j) => ({ ...j, pages: j.pages.filter((p) => known.has(p.split("?")[0])) })),
        authentication: {
            ...base.authentication,
            mechanisms: [...new Set([...base.authentication.mechanisms, ...analysis.authenticationMechanisms])],
        },
    };
}
