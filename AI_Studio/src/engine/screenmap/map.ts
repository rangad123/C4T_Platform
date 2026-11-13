/**
 * A map of the application's screens: which action leads from which screen to which (no LLM).
 *
 * A screen is a page template, not an address: the URL pattern (ids become {id}, ../discovery/crawler.ts urlPattern), and sibling
 * addresses with the same structure (same page type, same kinds of forms, same kinds of controls) are one screen too, so
 * /course/algebra and /course/biology are "/course/{slug}". Transitions come from the crawl (links, links revealed by menus and
 * tabs, clicked navigation controls), from each test account's own crawl, and from the steps of authored tests.
 *
 * Planning reads the transitions no test idea follows yet (../planning/planner.ts gap pass); the exploration's result shows
 * "Screens found: N, transitions: M, covered by tests: K".
 */
import { normalizeUrl, urlPattern } from "../discovery/crawler.js";
import type { PageModel, PageType } from "../understanding/app-model.js";
import type { Locator, Scenario, TestSpec } from "../spec/schema.js";

/** How a transition was found. */
export type TransitionVia = "link" | "menu" | "click" | "test";

/** One link or control the crawl saw on a page, pointing at a same-origin address. */
export interface CrawlTransition {
    /** The page it is on (normalised URL). */
    from: string;
    /** Where it leads (normalised URL, after the redirect the crawl saw, when it saw one). */
    to: string;
    label: string;
    via: Exclude<TransitionVia, "test">;
}

export interface Screen {
    key: string;
    /** Main heading (or title) of the first page seen on it. */
    heading: string;
    type: PageType;
    /** Example paths (at most 5). */
    paths: string[];
    /** Test accounts that reached it (absent: only the main exploration did). */
    roles?: string[];
}

export interface Transition {
    from: string;
    to: string;
    /** The link text or control name. */
    action: string;
    via: TransitionVia;
    roles?: string[];
    /** Some authored test follows it. */
    covered?: boolean;
}

/** A form field that appears only after a choice in the same form. */
export interface ConditionalField {
    screen: string;
    /** The choice, e.g. `Role = Other`. */
    when: string;
    shows: string[];
}

export interface ScreenMap {
    screens: Screen[];
    transitions: Transition[];
    conditional: ConditionalField[];
}

/** Bounds, so a huge site cannot flood the stored model. */
const MAX_TRANSITIONS = 600;
const MAX_LABEL = 80;
const SLUG = "{slug}";

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
const norm = (url: string) => normalizeUrl(url, url) ?? url;
const mainHeading = (p: PageModel) => clean(p.headings.find((h) => h.trim()) ?? p.title ?? "");

/** The structure two pages of one template share: page type, kinds of forms, kinds of controls. */
const shape = (p: PageModel) => `${p.type}|${p.forms.map((f) => f.purpose).sort().join(",")}|${[...new Set(p.components.map((c) => c.role))].sort().join(",")}`;

/** Parent of a plain path pattern (no query, no hash route), or null when there is none to merge under. */
function parentOf(pattern: string): string | null {
    if (/[?#]/.test(pattern)) return null;
    const segs = pattern.split("/").filter(Boolean);
    if (segs.length < 2 || segs[segs.length - 1] === "{id}") return null;
    return `/${segs.slice(0, -1).join("/")}`;
}

/** Turns addresses into screen keys, learned from the pages that were visited. */
export class ScreenIndex {
    private byUrl = new Map<string, string>();
    private byPattern = new Map<string, string>();
    /** Parents whose children were merged into one {slug} screen. */
    private slugParents = new Set<string>();
    readonly screens = new Map<string, Screen>();

    constructor(pages: PageModel[]) {
        // Siblings with the same shape (a template's heading is one instance's, so it never identifies the screen) under one parent are one screen.
        const groups = new Map<string, Set<string>>();
        for (const p of pages) {
            const pat = urlPattern(norm(p.url));
            const parent = parentOf(pat);
            if (!parent) continue;
            const k = `${parent}\u0000${shape(p)}`;
            groups.set(k, (groups.get(k) ?? new Set()).add(pat));
        }
        const merged = new Map<string, string>();
        for (const [k, pats] of groups) {
            if (pats.size < 2) continue;
            const parent = k.split("\u0000")[0]!;
            this.slugParents.add(parent);
            for (const pat of pats) merged.set(pat, `${parent}/${SLUG}`);
        }
        for (const p of pages) this.add(p, merged);
    }

    private add(p: PageModel, merged: Map<string, string>, role?: string): string {
        const url = norm(p.url);
        const pat = urlPattern(url);
        const key = merged.get(pat) ?? this.byPattern.get(pat) ?? pat;
        this.byUrl.set(url, key);
        this.byPattern.set(pat, key);
        const s = this.screens.get(key);
        if (!s) this.screens.set(key, { key, heading: mainHeading(p), type: p.type, paths: [p.path], ...(role ? { roles: [role] } : {}) });
        else {
            if (s.paths.length < 5 && !s.paths.includes(p.path)) s.paths.push(p.path);
            if (role && !(s.roles ?? []).includes(role)) s.roles = [...(s.roles ?? []), role];
        }
        return key;
    }

    /** A page a test account reached: joins its screen, or makes a new one. */
    addRolePage(p: PageModel, role: string): string {
        return this.add(p, new Map(), role);
    }

    /** The screen an address belongs to, if any visited page tells. */
    keyOf(url: string): string | undefined {
        const u = norm(url);
        const hit = this.byUrl.get(u);
        if (hit) return hit;
        let pat: string;
        try {
            pat = urlPattern(u);
        } catch {
            return undefined;
        }
        const byPat = this.byPattern.get(pat);
        if (byPat) return byPat;
        const parent = parentOf(pat);
        return parent && this.slugParents.has(parent) ? `${parent}/${SLUG}` : undefined;
    }
}

export interface RoleCrawl {
    who: string;
    pages: PageModel[];
    transitions: CrawlTransition[];
}

/**
 * The map from the main crawl, each test account's crawl, and the conditional fields the crawl found in forms. Transitions to
 * addresses no visited page explains (a logout link, an unvisited page of a new template) are left out.
 */
export function buildScreenMap(main: { pages: PageModel[]; transitions: CrawlTransition[] }, roles: RoleCrawl[] = []): ScreenMap {
    const index = new ScreenIndex(main.pages);
    for (const r of roles) for (const p of r.pages) if (p.type !== "error" && p.type !== "login") index.addRolePage(p, r.who);
    const edges = new Map<string, Transition>();
    const addAll = (list: CrawlTransition[], role?: string) => {
        for (const t of list) {
            const from = index.keyOf(t.from);
            const to = index.keyOf(t.to);
            const action = clean(t.label);
            if (!from || !to || from === to || !action) continue;
            const k = `${from}\u0000${to}\u0000${action.toLowerCase()}`;
            const e = edges.get(k);
            if (e) {
                if (role && !(e.roles ?? []).includes(role)) e.roles = [...(e.roles ?? []), role];
                continue;
            }
            if (edges.size >= MAX_TRANSITIONS) continue;
            edges.set(k, { from, to, action, via: t.via, ...(role ? { roles: [role] } : {}) });
        }
    };
    addAll(main.transitions);
    for (const r of roles) addAll(r.transitions, r.who);
    const conditional: ConditionalField[] = [];
    for (const p of main.pages) {
        const screen = index.keyOf(p.url);
        if (!screen) continue;
        for (const f of p.forms) for (const c of f.conditional ?? []) if (!conditional.some((x) => x.screen === screen && x.when === c.when)) conditional.push({ screen, when: c.when, shows: c.shows });
    }
    return { screens: [...index.screens.values()], transitions: [...edges.values()], conditional };
}

// ── coverage ─────────────────────────────────────────────────────────────────

const locatorText = (l: Locator | undefined) => clean(String(l?.value ?? "")).toLowerCase();
const sameAction = (a: string, b: string) => !!a && !!b && (a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b)));

/** The screen key of an example path or address, from a map alone (no pages at hand). */
function keyFromMap(map: ScreenMap, pathOrUrl: string, origin: string): string | undefined {
    let pat: string;
    try {
        pat = urlPattern(new URL(pathOrUrl, origin).toString());
    } catch {
        return undefined;
    }
    const direct = map.screens.find((s) => s.key === pat);
    if (direct) return direct.key;
    const parent = parentOf(pat);
    return parent ? map.screens.find((s) => s.key === `${parent}/${SLUG}`)?.key : undefined;
}

/**
 * Marks the transitions authored tests follow, and adds the ones a test took that the crawl did not see (via "test"). A test is
 * walked step by step: a navigation sets the current screen; a click whose element is named like a transition from the current
 * screen follows it; a URL assertion after a click names where the click led. Returns how many transitions are covered.
 */
export function coverWithTests(map: ScreenMap, specs: TestSpec[], origin: string): number {
    for (const spec of specs) {
        let current: string | undefined;
        let pendingClick: string | undefined;
        for (const step of spec.steps) {
            if (step.action === "navigate") {
                current = keyFromMap(map, step.url, origin) ?? current;
                pendingClick = undefined;
            } else if (step.action === "click") {
                const name = locatorText(step.locator);
                const t = current ? map.transitions.find((x) => x.from === current && sameAction(x.action.toLowerCase(), name)) : undefined;
                if (t) {
                    t.covered = true;
                    current = t.to;
                    pendingClick = undefined;
                } else pendingClick = name || undefined;
            } else if (step.action === "assert" && step.check === "url" && typeof step.expected === "string") {
                const to = keyFromMap(map, step.expected.startsWith("http") || step.expected.startsWith("/") ? step.expected : `/${step.expected}`, origin);
                if (to && current && pendingClick && to !== current && map.transitions.length < MAX_TRANSITIONS) {
                    const have = map.transitions.find((x) => x.from === current && x.to === to && sameAction(x.action.toLowerCase(), pendingClick!));
                    if (have) have.covered = true;
                    else map.transitions.push({ from: current, to, action: pendingClick, via: "test", covered: true });
                }
                if (to) current = to;
                pendingClick = undefined;
            }
        }
    }
    return map.transitions.filter((t) => t.covered).length;
}

/** Transition gaps a planner can be given: a label for the prompt and the page whose detail it needs. */
export interface TransitionGap {
    page: string;
    label: string;
}

/**
 * Transitions no planned scenario follows yet: the scenario starts on (or its journey passes) the screen the transition leaves,
 * and its text names the action or the screen it reaches. Deterministic, from the scenario text; at most `max`.
 */
export function uncoveredTransitions(map: ScreenMap | undefined, scenarios: Array<Pick<Scenario, "startPath" | "title" | "description" | "expectedResults" | "preconditions"> & { journey?: string }>, origin: string, journeys: Array<{ name: string; pages: string[] }> = [], max = 40): TransitionGap[] {
    if (!map?.transitions.length) return [];
    const byScreen = new Map<string, string[]>();
    const journeyPages = new Map(journeys.map((j) => [j.name.toLowerCase(), j.pages]));
    for (const s of scenarios) {
        const text = [s.title, s.description, ...s.preconditions, ...s.expectedResults].join(" \n ").toLowerCase();
        for (const p of [s.startPath, ...(journeyPages.get((s.journey ?? "").toLowerCase()) ?? [])]) {
            const k = keyFromMap(map, p || "/", origin);
            if (k) byScreen.set(k, [...(byScreen.get(k) ?? []), text]);
        }
    }
    const example = new Map(map.screens.map((s) => [s.key, s]));
    const out: TransitionGap[] = [];
    for (const t of map.transitions) {
        if (t.covered || out.length >= max) continue;
        const to = example.get(t.to);
        const texts = byScreen.get(t.from) ?? [];
        const action = t.action.toLowerCase();
        const target = (to?.paths[0] ?? t.to).toLowerCase();
        if (texts.some((x) => (action.length >= 3 && x.includes(action)) || (target.length > 1 && x.includes(target)) || (!!to?.heading && to.heading.length >= 4 && !to.key.includes("{") && x.includes(to.heading.toLowerCase())))) continue;
        const from = example.get(t.from);
        out.push({
            page: (from?.paths[0] ?? t.from).split("?")[0] || "/",
            label: `transition on ${from?.paths[0] ?? t.from}: "${t.action}" leads to ${to?.paths[0] ?? t.to}${to?.heading ? ` ("${to.heading}")` : ""}${t.roles?.length ? ` (seen as ${t.roles.join(", ")})` : ""}`,
        });
    }
    return out;
}

/** Plain lines about forms whose later fields depend on an earlier answer, for the planner. */
export function conditionalNotes(map: ScreenMap | undefined, path: string, origin: string): string[] {
    if (!map?.conditional.length) return [];
    const key = keyFromMap(map, path, origin);
    return map.conditional.filter((c) => c.screen === key).map((c) => `after choosing ${c.when}, the form shows: ${c.shows.join(", ")}`);
}

/** The numbers the exploration's result shows. */
export function mapCounts(map: ScreenMap): { screens: number; transitions: number; covered: number } {
    return { screens: map.screens.length, transitions: map.transitions.length, covered: map.transitions.filter((t) => t.covered).length };
}
