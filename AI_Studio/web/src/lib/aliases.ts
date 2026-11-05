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

/** The queries only the runnable tests' list reads (pages/ProjectTests.tsx): an old Test cases link with one of them meant that list. */
export const RUNNABLE_QUERY = ["status", "quality", "quarantine", "start", "git"] as const;

/** `href` with the link's whole query after it. */
const withQuery = (href: string, query: URLSearchParams): string => {
    const q = query.toString();
    return q ? `${href}${href.includes("?") ? "&" : "?"}${q}` : href;
};

/** The `?section=` of an old place's link, when it names one of that place's sections. */
const sectionOf = <T extends string>(q: URLSearchParams, list: readonly T[]): T | undefined => {
    const s = q.get("section");
    return s && (list as readonly string[]).includes(s) ? (s as T) : undefined;
};

/** Where an old link now lives, or null when the link is already current. */
export function resolveAlias(parts: string[], query: URLSearchParams): string | null {
    const [a, id, c, d] = parts;
    // The Folders place became Reusable libraries (round 37).
    if (a === "folders") return routes.libraries;
    // The step editor was its own page; it is the Steps tab of the test's workbench now.
    if (a === "tests" && id && c === "builder") return routes.testTab(id, "steps");
    // Round 38: the Text tab is the DSL tab; its route stays `text` and `dsl` opens it too.
    if (a === "tests" && id && c === "dsl") return withQuery(routes.testTab(id, "text"), query);
    if (a !== "projects" || !id || !c) return null;
    // Round 38: the runnable tests are the Test scripts list; the Test cases place holds the written cases. An old link to the tests
    // with a query about running (a status, weak checks, quarantine, a way of starting a test, Git) opens the scripts list with it.
    if (c === "tests" && !d && RUNNABLE_QUERY.some((k) => query.has(k))) return withQuery(routes.tests(id), query);
    // Round 37: a project's runners moved out of its Settings to the Runners page.
    if (c === "settings" && query.get("section") === "runners") {
        const rest = new URLSearchParams(query);
        rest.delete("section");
        rest.delete("project");
        const extra = rest.toString();
        return extra ? `${routes.runners(id)}&${extra}` : routes.runners(id);
    }
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
