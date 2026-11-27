/**
 * Application understanding: turns the raw crawl into an AppModel with page purposes,
 * features and user journeys.
 *
 * The prompt framing (QA expert, ARIA-first, site type/purpose/flows) follows QAAgency's
 * `ExplorerAgent.analyzeSite` (MIT), applied to the *whole* crawl instead of only the landing page.
 */
import { mapLimit, type EngineContext } from "../context.js";
import { classifyLlmError, LlmCallError } from "../llm/errors.js";
import { countStructured } from "../llm/provider.js";
import type { ReusePlan } from "../memory/reuse.js";
import { notesBlock, type SiteNote } from "../memory/notes.js";
import { planAreas } from "../planning/planner.js";

const withNotes = (notes: SiteNote[] | undefined, pages: Array<{ path: string }>) => {
    const b = notesBlock(notes, pages);
    return b ? `\n\n${b}` : "";
};
import {
    AnalysisSchema,
    LinkedAnalysisSchema,
    type Analysis,
    type ApiEndpointModel,
    type AppModel,
    type LinkedAnalysis,
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

/** The page understanding additions: single-goal journeys whose steps name their page and request (an older runner's analysis asks SYSTEM alone). */
export const LINKED_RULES = `
- Each journey is one feature of the application. Give separate actions separate journeys (for example changing a quantity and applying a code are two journeys), but keep an action together with its reverse or alternative on the same thing in one journey (log in and log out, follow and unfollow, add and remove an item, approve or reject a request). Journeys may share pages. Up to 20 journeys.
- Cover every action that changes data: each form and each button that saves, adds, removes, pays or cancels belongs to a journey.
- Viewing a list or the records a page shows is a journey of its own, and so is checking figures a page works out (totals, charges, limits).
- For every step give "page", the exact crawl path it happens on, and "endpoint", the request from the listed API calls that the step sends (the data a page loads when opened, or the write a form or button sends), copied exactly as listed ("METHOD /path"). Leave endpoint empty when no listed request fits; never invent one.`;

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
        /** Ask for single-goal journeys whose steps name their page and request (the page understanding additions). Default true; false asks as an older runner does. */
        linkSteps?: boolean;
    } = {},
): Promise<AppModel> {
    const apiText = base.apis.length
        ? base.apis.slice(0, 40).map((a: ApiEndpointModel) => `${a.method} ${a.path} → ${a.statuses.join("/") || "?"} (${a.source})`).join("\n")
        : "none observed";

    const linked = opts.linkSteps !== false;
    const system = linked ? SYSTEM + LINKED_RULES : SYSTEM;
    const schema = linked ? LinkedAnalysisSchema : AnalysisSchema;
    const head = `Application: ${base.url}
Authentication: ${base.authentication.required ? "login required/available" : "no login form detected"}${base.authentication.loginPath ? ` (login page ${base.authentication.loginPath})` : ""}
Documented tests found on site: ${base.documentedTestCases.length}

API calls observed or documented:
${apiText}`;
    const pagesText = (pages: PageModel[]) =>
        `${opts.reuse?.pages.size ? `${REUSE_NOTE}\n` : ""}${summarisePages(pages, undefined, opts.reuse, opts.digestElementsPerPage)}${opts.memory ? `\n\n${opts.memory}` : ""}${withNotes(opts.notes, pages)}`;
    // Pages only test accounts reached (an admin's page when the project signs in as a user): listed apart, with who reached them, so a
    // journey through one can be named; their purposes come back like the others'.
    const rolePages = base.rolePages ?? [];
    const roleText = rolePages.length
        ? `\n\nPages only some of the project's test accounts reached (${rolePages.length}); a journey through one is done signed in as an account that reached it:\n${rolePages.map((p) => `${p.path}: reached by ${p.reachedBy.map((w) => JSON.stringify(w.slice(0, 100))).join(", ")}`).join("\n")}\n${summarisePages(rolePages, 10_000, undefined, opts.digestElementsPerPage)}`
        : "";
    let analysis: Analysis | LinkedAnalysis;
    try {
        analysis = await ctx.llm.object({
            system,
            schema,
            // One purpose line per page: a larger exploration needs room for all of them.
            maxOutputTokens: Math.min(16_000, 6_000 + 40 * (base.pages.length + rolePages.length)),
            purpose: "analysis",
            cacheAs: "understanding",
            prompt: `${head}

Pages (${base.pages.length}):
${pagesText(base.pages)}${roleText}`,
        });
    } catch (err) {
        // The whole answer was unusable even after the re-ask (too long, as a rule): asked again in smaller parts (task R, R-e).
        if (classifyLlmError(err).cls !== "bad_output") throw err;
        analysis = await splitAnalysis(ctx, base.pages, { system, schema, head, pagesText });
    }

    const byPath = new Map(analysis.pagePurposes.map((p) => [p.path, p]));
    const pages = base.pages.map((p) => {
        const hit = byPath.get(p.path) ?? byPath.get(new URL(p.url).pathname);
        if (hit) return { ...p, type: hit.type, purpose: hit.purpose };
        // Not answered for a page that did not change: what was understood about it last time stays.
        const known = opts.reuse?.pages.get(p.path);
        return known ? { ...p, type: known.type, ...(known.purpose ? { purpose: known.purpose } : {}) } : p;
    });
    const withPurpose = <P extends PageModel>(p: P): P => {
        const hit = byPath.get(p.path);
        return hit ? { ...p, type: hit.type, purpose: hit.purpose } : p;
    };
    const known = new Set([...pages, ...rolePages].map((p) => p.path.split("?")[0]));

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
        ...(rolePages.length ? { rolePages: rolePages.map(withPurpose) } : {}),
        siteType: analysis.siteType,
        purpose: analysis.purpose,
        features: analysis.features,
        journeys: analysis.journeys.map((j) => {
            const steps = j.steps.map((x) => (typeof x === "string" ? { action: x } : x));
            return {
                ...j,
                steps: steps.map((x) => x.action),
                pages: j.pages.filter((p) => known.has(p.split("?")[0])),
                ...(linked ? { stepLinks: steps.map((x) => ({ ...("page" in x && x.page?.trim() ? { page: x.page.trim() } : {}), ...("endpoint" in x && x.endpoint?.trim() ? { endpoint: x.endpoint.trim() } : {}) })) } : {}),
            };
        }),
        authentication: {
            ...base.authentication,
            mechanisms: [...new Set([...base.authentication.mechanisms, ...analysis.authenticationMechanisms])],
        },
    };
}

/**
 * The understanding asked in parts: what the pages are, one call per area (the planner's grouping), then the journeys over the page paths
 * those calls named. Each part is a slice of the same schema, the merge is deterministic (the site type and purpose of the start page's part, features
 * and mechanisms joined in order, each page once), and the whole is validated by the same schema. A part that names a page the crawl does
 * not have is refused: the parts are joined by page path, so a wrong one cannot be dropped in silence.
 */
export async function splitAnalysis(
    ctx: EngineContext,
    pages: PageModel[],
    a: { system: string; schema: typeof AnalysisSchema | typeof LinkedAnalysisSchema; head: string; pagesText: (pages: PageModel[]) => string },
): Promise<Analysis | LinkedAnalysis> {
    const areas = planAreas({ pages });
    countStructured(ctx.llm.usage, "split");
    ctx.emit({ stage: "analysis", kind: "analysis_split", level: "warn", message: `The AI's answer about the whole application could not be used, so it was asked in ${areas.length + 1} smaller parts.` });
    const bare = (path: string) => path.split("?")[0] || "/";
    const crawled = new Set(pages.flatMap((p) => [bare(p.path), bare(new URL(p.url).pathname)]));
    const refuse = (what: string, path: string) => {
        throw new LlmCallError({ cls: "bad_output", detail: `${what} named the page "${path.slice(0, 200)}", which the crawl does not have` });
    };
    // The slices are typed as the linked schema's (a plain step is one of its forms); the merged whole is parsed by the caller's own schema.
    const linked = a.schema as typeof LinkedAnalysisSchema;
    const screensSchema = linked.pick({ siteType: true, purpose: true, features: true, pagePurposes: true, authenticationMechanisms: true });
    const parts = await mapLimit(areas, ctx.config.CONCURRENCY, (area) =>
        ctx.llm.object({
            system: a.system,
            schema: screensSchema,
            maxOutputTokens: Math.min(16_000, 3_000 + 40 * area.pages.length),
            purpose: "analysis",
            prompt: `${a.head}

Describe the application and these pages only (part of ${pages.length} pages; the other pages and the journeys are asked in other calls).
Pages (${area.pages.length}):
${a.pagesText(area.pages)}`,
        }),
    );
    const screens = parts.map((r) => {
        if (!r.ok) throw r.error;
        return r.value;
    });
    for (const [i, s] of screens.entries()) {
        const area = new Set(areas[i]!.pages.flatMap((p) => [bare(p.path), bare(new URL(p.url).pathname)]));
        for (const p of s.pagePurposes) if (!area.has(bare(p.path))) refuse("The description of a part of the pages", p.path);
    }
    const seen = new Set<string>();
    const pagePurposes = screens.flatMap((s) => s.pagePurposes).filter((p) => !seen.has(p.path) && !!seen.add(p.path));
    const purposeOf = new Map(pagePurposes.map((p) => [bare(p.path), p]));
    const pageList = pages.map((p) => `- ${p.path} [${purposeOf.get(bare(p.path))?.type ?? p.type}] ${purposeOf.get(bare(p.path))?.purpose ?? p.title}${p.apiCalls.length ? ` | api calls: ${p.apiCalls.join(", ")}` : ""}`).join("\n");
    const flows = await ctx.llm.object({
        system: a.system,
        schema: linked.pick({ journeys: true }),
        maxOutputTokens: 16_000,
        purpose: "analysis",
        prompt: `${a.head}

The pages of the application (path [type] purpose), described in earlier calls. Give the journeys only, over these exact paths.
Pages (${pages.length}):
${pageList}`,
    });
    for (const j of flows.journeys) {
        for (const p of j.pages) if (!crawled.has(bare(p))) refuse(`The journey "${j.name.slice(0, 100)}"`, p);
        for (const step of j.steps) {
            const page = typeof step === "string" ? "" : step.page.trim();
            if (page && !crawled.has(bare(page))) refuse(`A step of the journey "${j.name.slice(0, 100)}"`, page);
        }
    }
    const union = (lists: string[][]) => [...new Set(lists.flat())];
    // The site type and purpose of the part with the crawl's start page.
    const main = screens[Math.max(0, areas.findIndex((x) => x.pages.includes(pages[0]!)))]!;
    return a.schema.parse({
        siteType: main.siteType,
        purpose: main.purpose,
        features: union(screens.map((s) => s.features)),
        pagePurposes,
        journeys: flows.journeys,
        authenticationMechanisms: union(screens.map((s) => s.authenticationMechanisms)),
    });
}
