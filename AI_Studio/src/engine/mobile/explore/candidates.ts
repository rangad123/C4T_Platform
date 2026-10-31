/**
 * From what the exploration saw to tests that can really be written: every candidate is a path the exploration walked (so it can be walked again
 * from a fresh start), the steps that repeat it and the checks drawn from the screens it reaches. The model only chooses among candidates and
 * words them (planner.ts); nothing here is invented.
 *
 * R24: candidates are journeys read from the screen graph (graph.ts): the app start, signing in, each main tab, an item of a list opened and
 * closed again, a search and one of its results, settings pages, forms sent filled in and empty, longer paths through several screens, and every
 * other screen reached; each one says which screens it covers and why, and carries a score so the important ones (main navigation, core flows)
 * come first. A path never uses an edge that did not replay, lost steps or went back. The checks show that each screen arrived (its heading, or
 * an element with a stable id), never feed content that changes by itself, and steps reach list items by scrolling until they show.
 */
import type { Step } from "../../spec/schema.js";
import { listDetails, mainTabs } from "./graph.js";
import { isDynamicText } from "./locators.js";
import { nameScreens } from "./screens.js";
import type { Edge, MobileAppModel, MobileScreen, PhoneFamily, RecordedAction, StoredElement } from "./types.js";
import type { ExploreLimits } from "./types.js";
import { DEFAULT_LIMITS, PASSWORD_PLACEHOLDER, USERNAME_PLACEHOLDER } from "./types.js";

export interface Candidate {
    id: string;
    family: PhoneFamily;
    /** The screen the test ends on. */
    target: string;
    /** Screen titles from the first screen to the one under test. */
    path: string[];
    /** Steps that walk the path (no checks). */
    steps: Step[];
    /** Checks drawn from what the last screen showed. */
    checks: Step[];
    /** The same checks in words. */
    shown: string[];
    usesSignIn: boolean;
    /** What the test does, in the words a template uses when the model does not word it. */
    title: string;
    goal: string;
    /** Plain facts for the model. */
    facts: string;
    /** R24: the screens the test goes through or checks, by name. */
    covers?: string[];
    /** R24: what the test covers and why it is in the plan, in a sentence. */
    why?: string;
    /** R24: higher first (main navigation and core flows before the rest). */
    score?: number;
}

export interface Dropped {
    title: string;
    reason: string;
}

const isCredential = (a: RecordedAction) => a.kind === "type" && (a.text === USERNAME_PLACEHOLDER || a.text === PASSWORD_PLACEHOLDER);

/**
 * Steps that repeat recorded actions. A tap on an element with no usable name cannot be repeated: the reason comes back instead.
 *
 * With `journey` (the plan's tests, R24): scrolling in front of a tap is replaced by "scroll until the element shows" (Android's UiScrollable,
 * so a list that loaded other items first still works), and waiting is left out (every step waits for its element, and each screen's arrival is
 * checked). Without it, the actions are repeated one for one (the phone checks reproduce what happened before a crash).
 */
export function stepsOf(actions: readonly RecordedAction[], o: { journey?: boolean } = {}): { steps: Step[]; problem?: string } {
    const steps: Step[] = [];
    for (let i = 0; i < actions.length; i++) {
        const a = actions[i]!;
        switch (a.kind) {
            case "tap":
                if (!a.loc) return { steps, problem: `“${a.label}” has no name a test can use to find it` };
                steps.push({ action: "click", locator: a.loc, description: "" });
                break;
            case "type":
                if (!a.loc) return { steps, problem: `The field “${a.label}” has no name a test can use to find it` };
                steps.push({ action: "fill", locator: a.loc, value: a.text, description: "" });
                break;
            case "scroll": {
                if (o.journey) {
                    // A run of scrolls followed by an action on a named element: scroll until that element shows instead.
                    let j = i;
                    while (actions[j]?.kind === "scroll") j++;
                    const next = actions[j];
                    if (next && (next.kind === "tap" || next.kind === "type") && next.loc) {
                        steps.push({ action: "press", key: "device:scroll-to", locator: next.loc, description: `Scroll until “${next.label}” shows` });
                        i = j - 1;
                        break;
                    }
                }
                steps.push({ action: "press", key: `device:scroll:${a.direction}`, description: "" });
                break;
            }
            case "back":
            case "hideKeyboard":
                steps.push({ action: "press", key: "device:back", description: "" });
                break;
            case "wait":
                if (!o.journey) steps.push({ action: "wait", ms: Math.min(10_000, a.ms), description: "" });
                break;
        }
    }
    return { steps };
}

const norm = (t: string) => t.replace(/\d+/g, "#").trim().toLowerCase();
const TITLE_ID = /(title|toolbar|header|heading|action.?bar)/i;
const idWords = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
const locKey = (e: StoredElement) => `${e.loc!.by}|${e.loc!.role ?? ""}|${e.loc!.value ?? ""}|${e.loc!.nth ?? ""}`;
/** What a check of the element says in words. */
const wordsOf = (e: StoredElement) => e.text || e.desc || idWords(e.id);

/**
 * What shows that a screen arrived (R24): up to two elements, best first: its heading, an element with a stable id (a list itself counts: it is
 * there whatever it shows), a static label outside its lists. Never text inside a list or feed (content that changes), never a count or a time,
 * never a field. Things the screen before also showed (a tab bar, a toolbar button) only when nothing else is there.
 */
export function pickChecks(screen: MobileScreen, previous?: MobileScreen): StoredElement[] {
    const before = new Set((previous?.elements ?? []).flatMap((e) => [norm(e.text || e.desc), ...(e.loc ? [locKey(e)] : [])]).filter(Boolean));
    const tabs = new Set((screen.tabs ?? []).map((t) => t.toLowerCase()));
    const heading = (screen.toolbarTitle ?? "").toLowerCase();
    /** Undefined: never a check. Below 1: only when nothing better is there. */
    const score = (e: StoredElement): number | undefined => {
        if (!e.loc || e.password || e.editable) return undefined;
        const t = e.text || e.desc;
        const byId = e.loc.by === "testId";
        // Text inside a list is content, unless the check finds the element by its id (then only "it is there" is checked).
        if (e.inScroll && !byId) return undefined;
        if (!byId && (t.length < 2 || t.length > 50 || isDynamicText(t) || /\(text removed\)|\(hidden\)/.test(t))) return undefined;
        let s = 0;
        if (t && (t.toLowerCase() === heading || (TITLE_ID.test(e.id) && !isDynamicText(t)))) s = 100;
        else if (byId && e.scrollable) s = 70;
        else if (byId) s = e.clickable ? 55 : 80;
        else s = e.clickable ? 40 : 50;
        if (e.inScroll) s -= 30;
        // A tab label is on every screen of the app; the heading that reads the same is still this screen's own.
        if (s !== 100 && tabs.has(t.toLowerCase())) s -= 45;
        // The same element on the screen before (a toolbar button, a tab) says nothing; the same word as a heading still does.
        if (before.has(locKey(e))) s -= 60;
        else if (t && before.has(norm(t))) s -= s === 100 ? 10 : 60;
        return s;
    };
    // A heading found by its id (every screen's toolbar has the same id) is checked by its words: that is what tells this screen arrived.
    const asCheck = (e: StoredElement): StoredElement => {
        const t = e.text.trim();
        const isHeading = t && (t.toLowerCase() === heading || TITLE_ID.test(e.id));
        return isHeading && e.loc?.by === "testId" && !e.inScroll && t.length <= 40 && !t.includes("…") && !isDynamicText(t) ? { ...e, loc: { by: "text", value: t } } : e;
    };
    const ranked = screen.elements
        .map(asCheck)
        .map((e, i) => ({ e, i, s: score(e) }))
        .filter((x): x is { e: StoredElement; i: number; s: number } => x.s !== undefined)
        .sort((a, b) => b.s - a.s || a.i - b.i);
    const fresh = ranked.filter((x) => x.s > 0);
    const pool = fresh.length ? fresh : ranked;
    const seen = new Set<string>();
    const out: StoredElement[] = [];
    for (const { e } of pool) {
        const k = locKey(e);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
        if (out.length === 2) break;
    }
    return out;
}

const visible = (e: { loc?: StoredElement["loc"] }): Step => ({ action: "assert", check: "visible", locator: e.loc!, description: "" });

/** An edge a written test can walk: it replayed, kept all its steps, and goes forward (a test starts the app fresh and never relies on going back). */
const forward = (e: Edge) => !e.incomplete && !e.unreliable && e.via !== "back" && e.action.kind !== "back";

/** Shortest recorded way from the first screen to each screen (at most `maxEdges` navigations, never through an edge that lost steps or did not replay). */
export function shortestPaths(model: MobileAppModel, maxEdges: number, usable: (e: Edge) => boolean = (e) => !e.incomplete && !e.unreliable): Map<string, Edge[]> {
    const out = new Map<string, Edge[]>([[model.start, []]]);
    const queue = [model.start];
    while (queue.length) {
        const at = queue.shift()!;
        const here = out.get(at)!;
        if (here.length >= maxEdges) continue;
        for (const e of model.edges) {
            if (e.from !== at || !usable(e) || out.has(e.to)) continue;
            out.set(e.to, [...here, e]);
            queue.push(e.to);
        }
    }
    return out;
}

const actionsOfPath = (edges: readonly Edge[]): RecordedAction[] => edges.flatMap((e) => [...e.prelude, e.action]);

const SETTINGS = /settings|preferences/i;
const SEARCH = /search|find|query|look ?up/i;

/** A recorded action that typed into a search field. */
const searched = (a: RecordedAction) => a.kind === "type" && !isCredential(a) && (SEARCH.test(a.label) || SEARCH.test(a.loc?.value ?? ""));

export function buildCandidates(model: MobileAppModel, limits: Pick<ExploreLimits, "maxPathEdges"> = DEFAULT_LIMITS): { candidates: Candidate[]; dropped: Dropped[] } {
    // Names that tell screens apart (screens.ts), so every title, path and reason below reads right.
    nameScreens(model.screens, model.edges);
    const candidates: Candidate[] = [];
    const dropped: Dropped[] = [];
    const paths = shortestPaths(model, limits.maxPathEdges, forward);
    // A screen only reached by going back (rare) is still offered, through the recorded way that includes it.
    const anyPaths = shortestPaths(model, limits.maxPathEdges);
    const pathTo = (id: string) => paths.get(id) ?? anyPaths.get(id);
    const screenOf = (id: string) => model.screens.find((s) => s.id === id);
    const titleOf = (id: string) => screenOf(id)?.title ?? id;
    const seen = new Set<string>();
    const targeted = new Set<string>();
    const add = (c: Omit<Candidate, "id">): boolean => {
        const sig = JSON.stringify([c.steps, c.checks]);
        if (seen.has(sig)) return false;
        seen.add(sig);
        targeted.add(c.target);
        candidates.push({ ...c, id: `C${candidates.length + 1}` });
        return true;
    };
    const checksFor = (screen: MobileScreen, previous?: MobileScreen) => {
        const els = pickChecks(screen, previous);
        return { checks: els.map(visible), shown: els.map(wordsOf) };
    };
    const titlesOf = (edges: readonly Edge[]) => [titleOf(model.start), ...edges.map((e) => titleOf(e.to))].filter((t, i, all) => i === 0 || t !== all[i - 1]);
    const quote = (list: readonly string[]) => list.map((s) => `“${s}”`).join(" and ");
    const covering = (names: readonly string[]) => {
        const u = [...new Set(names)];
        return u.length <= 1 ? `“${u[0] ?? ""}”` : `${u.slice(0, -1).map((n) => `“${n}”`).join(", ")} and “${u.at(-1)}”`;
    };

    /** Steps that walk `edges` and then do `extra`, with an arrival check of `checkEvery` intermediate screens (journeys). */
    const walk = (edges: readonly Edge[], extra: RecordedAction[] = [], o: { checkEvery?: boolean } = {}): { steps: Step[]; problem?: string } => {
        if (!o.checkEvery) return stepsOf([...actionsOfPath(edges), ...extra], { journey: true });
        const steps: Step[] = [];
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i]!;
            const part = stepsOf([...e.prelude, e.action], { journey: true });
            if (part.problem) return { steps, problem: part.problem };
            steps.push(...part.steps);
            // Every screen on the way shows it arrived, except the last (its checks follow).
            if (i < edges.length - 1) {
                const at = screenOf(e.to);
                const check = at ? pickChecks(at, screenOf(e.from))[0] : undefined;
                if (check) steps.push(visible(check));
            }
        }
        const tail = stepsOf(extra, { journey: true });
        if (tail.problem) return { steps, problem: tail.problem };
        return { steps: [...steps, ...tail.steps] };
    };

    // 1. The app opens.
    const first = screenOf(model.start)!;
    const startChecks = checksFor(first);
    if (startChecks.checks.length) {
        add({ family: "start", target: first.id, path: [first.title], steps: [], ...startChecks, usesSignIn: false, title: `The app opens on “${first.title}”`, goal: `Starting the app shows “${first.title}”.`, facts: `Starting the app shows ${quote(startChecks.shown)}.`, covers: [first.title], why: `Covers the app starting and its first screen, “${first.title}”.`, score: 1000 });
    } else dropped.push({ title: `The app opens on “${first.title}”`, reason: "The first screen shows nothing with a steady name that a test can check" });

    /** One candidate that walks to `screen` (its recorded way from the first screen), with the template words of its family. */
    const toScreen = (screen: MobileScreen, family: PhoneFamily, words: { title: string; goal: string; why: string }, score: number, o: { edges?: Edge[]; extra?: RecordedAction[]; endChecks?: { checks: Step[]; shown: string[] }; checkEvery?: boolean } = {}): void => {
        const edges = o.edges ?? pathTo(screen.id);
        if (!edges) {
            dropped.push({ title: words.title, reason: "It could not be reached again from the first screen in a few steps" });
            return;
        }
        const { steps, problem } = walk(edges, o.extra, { checkEvery: o.checkEvery });
        if (problem) {
            dropped.push({ title: words.title, reason: problem });
            return;
        }
        const last = edges.at(-1);
        const from = last ? screenOf(last.from) : undefined;
        const ends = o.endChecks ?? checksFor(screen, from);
        if (!ends.checks.length) {
            dropped.push({ title: words.title, reason: "The screen shows nothing with a steady name that a test can check" });
            return;
        }
        const actions = [...actionsOfPath(edges), ...(o.extra ?? [])];
        const usesSignIn = actions.some(isCredential);
        const path = titlesOf(edges);
        add({ family, target: screen.id, path, steps, checks: ends.checks, shown: ends.shown, usesSignIn, title: words.title, goal: words.goal, facts: `${words.goal} It then shows ${quote(ends.shown)}.${usesSignIn ? " Needs the project's test account." : ""}`, covers: [...new Set(path)], why: words.why, score });
    };

    // 2. Signing in: every edge that typed the test account and left the sign-in screen.
    for (const e of model.edges) {
        if (!forward(e) || ![...e.prelude, e.action].some(isCredential)) continue;
        const to = screenOf(e.to);
        if (!to || to.kind === "signin" || targeted.has(to.id)) continue;
        const edges = paths.get(e.from);
        if (!edges) continue;
        toScreen(to, "signIn", { title: "Sign in with the test account", goal: `Signing in with the project's test account leads to “${to.title}”.`, why: `Covers signing in with the test account and the screen that follows, “${to.title}”.` }, 950, { edges: [...edges, e] });
    }

    // 3. Each main tab (map exploration: edges through the tab bar or bottom navigation).
    mainTabs(model).forEach(({ screen, edge, label }, i) => {
        const before = paths.get(edge.from);
        if (!before || !forward(edge)) return;
        const tab = label || screen.title;
        toScreen(screen, "tabs", { title: `Open the “${tab}” tab`, goal: `The “${tab}” tab opens and shows “${screen.title}”.`, why: `Covers the main navigation: the “${tab}” tab.` }, 900 - i, { edges: [...before, edge] });
    });

    // 4. An item of a list opened, and closed again when going back was recorded.
    const lists = listDetails(model).filter((x) => forward(x.edge));
    // A model of the AI-led loop has no edge kinds: a tap on a list screen that leads elsewhere is the same thing.
    if (!model.edges.some((e) => e.via)) {
        for (const e of model.edges) {
            const list = screenOf(e.from);
            const detail = screenOf(e.to);
            if (list?.kind === "list" && detail && list.id !== detail.id && e.action.kind === "tap" && forward(e)) lists.push({ list, detail, edge: e });
        }
    }
    const listed = new Set<string>();
    for (const { list, detail, edge } of lists) {
        // A result opened after typing a search is a search (5), not a list.
        if (listed.has(list.id) || edge.prelude.some(searched)) continue;
        const before = paths.get(list.id);
        if (!before) continue;
        listed.add(list.id);
        const backEdge = model.edges.find((b) => b.from === detail.id && b.to === list.id && (b.via === "back" || b.action.kind === "back") && b.prelude.length === 0);
        const listChecks = checksFor(list, detail);
        const detailChecks = checksFor(detail, list);
        if (backEdge && listChecks.checks.length && detailChecks.checks.length) {
            // Open the item, see its details, go back and see the list again: one test.
            const back = stepsOf([backEdge.action], { journey: true });
            const endChecks = { checks: [...detailChecks.checks.slice(0, 1), ...back.steps, ...listChecks.checks.slice(0, 1)], shown: [...detailChecks.shown.slice(0, 1), ...listChecks.shown.slice(0, 1)] };
            toScreen(detail, "lists", { title: `Open an item from “${list.title}” and go back`, goal: `Opening an item from “${list.title}” shows “${detail.title}”, and going back shows “${list.title}” again.`, why: `Covers “${list.title}”, an item's details (“${detail.title}”) and going back.` }, 760, { edges: [...before, edge], endChecks });
        } else {
            toScreen(detail, "lists", { title: `Open an item from “${list.title}”`, goal: `Opening an item from “${list.title}” shows “${detail.title}”.`, why: `Covers “${list.title}” and an item's details (“${detail.title}”).` }, 750, { edges: [...before, edge] });
        }
    }

    // 5. A search and one of its results.
    for (const e of model.edges) {
        if (!forward(e) || ![...e.prelude, e.action].some(searched)) continue;
        const results = screenOf(e.to);
        const from = screenOf(e.from);
        const before = paths.get(e.from);
        if (!results || !from || !before) continue;
        if (e.action.kind === "tap" && e.prelude.some(searched)) {
            // Typed, then tapped a result that showed under the field: the edge itself opens the result.
            toScreen(results, "search", { title: `Search from “${from.title}” and open a result`, goal: `Searching on “${from.title}” and opening a result shows “${results.title}”.`, why: `Covers searching on “${from.title}” and a result's details (“${results.title}”).` }, 800, { edges: [...before, e] });
            break;
        }
        const open = model.edges.find((r) => r.from === results.id && forward(r) && r.action.kind === "tap" && r.to !== results.id && r.to !== from.id);
        const detail = open ? screenOf(open.to) : undefined;
        if (open && detail) {
            toScreen(detail, "search", { title: `Search from “${from.title}” and open a result`, goal: `Searching from “${from.title}” shows “${results.title}”, and opening a result shows “${detail.title}”.`, why: `Covers searching (“${results.title}”) and a result's details (“${detail.title}”).` }, 800, { edges: [...before, e, open], checkEvery: true });
        } else {
            toScreen(results, "search", { title: `Search from “${from.title}”`, goal: `Searching from “${from.title}” shows “${results.title}”.`, why: `Covers searching from “${from.title}” and its results.` }, 790, { edges: [...before, e] });
        }
        break;
    }
    // A search that answered on the same screen (results under the field) is a form that was sent: see 7.

    // 6. Settings pages: screens opened from a settings screen.
    const isSettings = (s: MobileScreen) => SETTINGS.test(s.title) || SETTINGS.test(s.toolbarTitle ?? "") || SETTINGS.test(s.activity ?? "");
    for (const s of model.screens) {
        if (s.id === model.start || targeted.has(s.id)) continue;
        const edges = paths.get(s.id);
        const parent = edges?.length ? screenOf(edges.at(-1)!.from) : undefined;
        if (!edges || !parent || !isSettings(parent) || parent.id === s.id) continue;
        toScreen(s, "settings", { title: `Open “${s.title}” in “${parent.title}”`, goal: `“${s.title}” opens from “${parent.title}”.`, why: `Covers the settings page “${s.title}”.` }, 560);
    }

    // 7. Forms that were sent and answered on the same screen (an error message, a confirmation).
    for (const sub of model.submits) {
        const edges = paths.get(sub.screen) ?? anyPaths.get(sub.screen);
        const screen = screenOf(sub.screen);
        if (!screen) continue;
        const isSearch = [...sub.prelude, sub.tap].some(searched);
        const label = isSearch ? `Search on “${screen.title}”` : sub.filled ? `Fill in the form on “${screen.title}” and send it` : `Send the form on “${screen.title}” without filling it in`;
        if (!edges) {
            dropped.push({ title: label, reason: "The form's screen could not be reached again from the first screen in a few steps" });
            continue;
        }
        const actions = [...actionsOfPath(edges), ...sub.prelude, sub.tap];
        const { steps, problem } = stepsOf(actions, { journey: true });
        const shownWithName = sub.shown.filter((s) => s.loc && !isDynamicText(s.text));
        if (problem || !shownWithName.length) {
            dropped.push({ title: label, reason: problem ?? "What the app showed afterwards has no steady name a test can check" });
            continue;
        }
        const usesSignIn = actions.some(isCredential);
        const said = quote(shownWithName.map((s) => s.text));
        add({
            family: isSearch ? "search" : "forms",
            target: sub.screen,
            path: titlesOf(edges),
            steps,
            checks: shownWithName.map(visible),
            shown: shownWithName.map((s) => s.text),
            usesSignIn,
            title: label,
            goal: isSearch ? `Searching on “${screen.title}” shows ${said}.` : sub.filled ? `Sending the filled-in form on “${screen.title}” shows ${said}.` : `Sending the empty form on “${screen.title}” shows ${said}.`,
            facts: `${isSearch ? "Searching" : sub.filled ? "Sending the form filled in" : "Sending the form empty"} on “${screen.title}” showed ${said}.`,
            covers: [...new Set(titlesOf(edges))],
            why: isSearch ? `Covers searching on “${screen.title}” and what it shows.` : sub.filled ? `Covers the form on “${screen.title}” with valid input.` : `Covers the form on “${screen.title}” left empty: the app must say what is missing.`,
            score: isSearch ? 780 : sub.filled ? 700 : 660,
        });
    }

    // 8. Every other screen reached (and forms that led to another screen).
    for (const screen of model.screens) {
        if (screen.id === model.start || targeted.has(screen.id)) continue;
        const edges = pathTo(screen.id);
        if (!edges) {
            dropped.push({ title: `Open “${screen.title}”`, reason: "It could not be reached again from the first screen in a few steps" });
            continue;
        }
        const last = edges[edges.length - 1]!;
        const from = screenOf(last.from)!;
        const lastActions = [...last.prelude, last.action];
        const signInInLast = lastActions.some(isCredential);
        const typedInLast = lastActions.some((a) => a.kind === "type" && !isCredential(a));
        const family: PhoneFamily = signInInLast ? "signIn" : typedInLast ? "forms" : last.action.kind === "back" ? "back" : from.kind === "list" && last.action.kind === "tap" ? "lists" : "navigation";
        const t: Record<PhoneFamily, [string, string, string]> = {
            signIn: ["Sign in with the test account", `Signing in with the project's test account leads to “${screen.title}”.`, `Covers signing in with the test account and “${screen.title}”.`],
            forms: [`Fill in the form on “${from.title}” and send it`, `Filling in the form on “${from.title}” and sending it leads to “${screen.title}”.`, `Covers the form on “${from.title}” and the screen it leads to, “${screen.title}”.`],
            lists: [`Open an item from “${from.title}”`, `Opening an item from “${from.title}” shows “${screen.title}”.`, `Covers “${from.title}” and an item's details (“${screen.title}”).`],
            back: [`Go back to “${screen.title}”`, `Going back from “${from.title}” shows “${screen.title}” again.`, `Covers going back from “${from.title}” to “${screen.title}”.`],
            navigation: [`Open “${screen.title}” from “${from.title}”`, `“${screen.title}” opens from “${from.title}”.`, `Covers “${screen.title}”, reached from “${from.title}”.`],
            start: ["", "", ""],
            tabs: ["", "", ""],
            search: ["", "", ""],
            settings: ["", "", ""],
            journeys: ["", "", ""],
        };
        const [title, goal, why] = t[family];
        // Main screens first: the fewer steps away and the more often the exploration came back to it, the more it matters.
        const score = family === "signIn" ? 940 : family === "forms" ? 690 : 640 - edges.length * 40 + Math.min(screen.visits, 10);
        toScreen(screen, family, { title, goal, why }, score, { edges });
    }

    // 9. Longer journeys: the deepest paths, each checking every screen on the way, as long as they add screens no other journey covered.
    const inJourney = new Set<string>();
    const deep = [...paths.entries()]
        .filter(([id, edges]) => edges.length >= 3 && id !== model.start)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "en", { numeric: true }));
    for (const [id, edges] of deep) {
        const screen = screenOf(id);
        if (!screen) continue;
        const names = titlesOf(edges);
        const fresh = edges.filter((e) => !inJourney.has(e.to)).length;
        if (fresh < 2) continue;
        edges.forEach((e) => inJourney.add(e.to));
        const via = names.slice(1, -1);
        toScreen(screen, "journeys", { title: `Go from “${names[0]}” to “${screen.title}”`, goal: `Going from “${names[0]}” through ${via.map((n) => `“${n}”`).join(", ")} reaches “${screen.title}”.`, why: `Covers ${edges.length + 1} screens in a row: ${covering(names)}.` }, 500 + fresh * 10, { edges, checkEvery: true });
    }

    // 10. Going back: a recorded back from a screen to the one it was opened from.
    for (const e of model.edges) {
        if (e.incomplete || e.unreliable || !(e.via === "back" || e.action.kind === "back") || e.prelude.length) continue;
        const from = screenOf(e.from);
        const to = screenOf(e.to);
        const before = paths.get(e.from);
        if (!from || !to || !before || before.at(-1)?.from !== to.id) continue;
        toScreen(to, "back", { title: `Go back from “${from.title}” to “${to.title}”`, goal: `Going back from “${from.title}” shows “${to.title}” again.`, why: `Covers going back from “${from.title}” to “${to.title}”.` }, 400, { edges: before, extra: [e.action], endChecks: checksFor(to, from) });
    }

    // Best first; the app start stays first.
    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
    candidates.forEach((c, i) => (c.id = `C${i + 1}`));
    return { candidates, dropped };
}
