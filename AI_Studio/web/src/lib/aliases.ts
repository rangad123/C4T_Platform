import { LIBRARY_SECTIONS, RELEASE_SECTIONS, SETUP_SECTIONS, routes } from "./router.js";

/**
 * Links that were written for earlier versions of the project's places (the six places of round 16, and before them single pages):
 * bookmarks, links in emails and in run-sequence messages, hash routes of earlier versions.
 * Each old page maps to the place and section that now holds it, so nothing that used to open stops opening.
 *
 * Kept as a table (not a chain of ifs) so a test can walk it and prove every row lands somewhere that renders.
 */
interface Alias {
    /** The old path segment after `projects/:id/`. */
    old: string;
    /** Old `/projects/:id/<old>/:extra` forms, when the page took an extra segment. */
    extra?: "release";
    to: (id: string, extra: string | undefined, query: URLSearchParams) => string;
}

export const ROUTE_ALIASES: Alias[] = [
    { old: "schedule", to: (id, _x, q) => routes.schedule(id, q.get("run") ?? undefined) },
    { old: "runners", to: (id) => routes.runners(id) },
    { old: "objects", to: (id) => routes.objects(id) },
    { old: "blocks", to: (id, _x, q) => routes.blocks(id, q.get("edit") ?? undefined) },
    { old: "helpers", to: (id) => routes.helpers(id) },
    { old: "releases", extra: "release", to: (id, x) => (x ? routes.release(id, x) : routes.releases(id)) },
    { old: "manual-cases", to: (id) => routes.manualCases(id) },
    { old: "compliance", to: (id) => routes.compliance(id) },
];

/** The `?section=` of an old place's link, when it names one of that place's sections. */
const sectionOf = <T extends string>(q: URLSearchParams, list: readonly T[]): T | undefined => {
    const s = q.get("section");
    return s && (list as readonly string[]).includes(s) ? (s as T) : undefined;
};

/** Where an old link now lives, or null when the link is already current. */
export function resolveAlias(parts: string[], query: URLSearchParams): string | null {
    const [a, id, c, d] = parts;
    // The step editor was its own page; it is the Steps tab of the test's workbench now.
    if (a === "tests" && id && c === "builder") return routes.testTab(id, "steps");
    if (a !== "projects" || !id || !c) return null;
    // Round 25 replaced three places: Setup became Settings, and the sections of Library and Release moved to Test scripts,
    // Settings, Test cases and Runs. The old route helpers already point at the new homes (lib/router.ts). Any other query (the
    // welcome page's `start=phone`) is kept.
    if (c === "setup" || c === "library" || (c === "release" && !d)) {
        const to = c === "setup" ? routes.setup(id, sectionOf(query, SETUP_SECTIONS)) : c === "library" ? routes.library(id, sectionOf(query, LIBRARY_SECTIONS)) : routes.releaseHub(id, sectionOf(query, RELEASE_SECTIONS));
        const rest = new URLSearchParams(query);
        rest.delete("section");
        const extra = rest.toString();
        return extra ? `${to}${to.includes("?") ? "&" : "?"}${extra}` : to;
    }
    const row = ROUTE_ALIASES.find((r) => r.old === c);
    return row ? row.to(id, row.extra ? d : undefined, query) : null;
}
