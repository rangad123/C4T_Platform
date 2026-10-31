/**
 * The screen graph of a phone exploration (R24): states are STRUCTURAL screens (device/uiautomator.ts fingerprintOf: the same screen whatever
 * its lists and counters show), edges are the actions that led from one screen to another, and every screen keeps the actions on it that were
 * not tried yet (its frontier). The map explorer (map-explorer.ts) builds it; the planner reads the result.
 *
 * ── What the planner gets (the API for PLAN) ─────────────────────────────────────────────────────────────────────────────────────────────
 * The result of an exploration is still a `MobileAppModel` (types.ts): `screens`, `edges`, `submits`, `start`. The map explorer also fills:
 *   MobileScreen  fingerprint (structural), textFingerprints (with text, evidence), toolbarTitle, selectedTab, tabs (main navigation labels),
 *                 aiName (the AI's name for it, when asked), depth (fewest navigations from the first screen), untried (safe actions left)
 *   Edge          via: "tab" | "menu" | "list-item" | "button" | "form" | "sign-in" | "back"; unreliable (did not replay twice); replays
 *   model         coverage (depth setting, screens, activities seen and listed by the phone, actions, AI calls, actions tried and left, why it
 *                 stopped as a sentence and as a kind), device (serial, model, emulator: where the exploration ran)
 * and the read-only queries below over any model: `screenOf`, `edgesFrom`, `shortestPath`, `pathFromStart`, `depths`, `mainTabs`,
 * `listDetails`, `screenLabel`. Paths never use an edge that is unreliable, incomplete or a "back" (a written test starts the app fresh and
 * walks forward), unless the query is asked to.
 *
 * Every RecordedAction of an edge carries the element's locator (`loc`, chosen by locators.ts against the whole screen) and its label, never
 * coordinates. A model from the AI-led loop (explorer.ts) has none of the extra fields; the queries work on it too.
 *
 * ── Live progress (for the exploration view) ─────────────────────────────────────────────────────────────────────────────────────────────
 * The explorer emits `mobile_progress` events with data `{ screens, activities, actions, aiCalls, maxScreens, maxActions }` whenever a new
 * screen is found and every 25 actions, and ends with `mobile_exploration_done` whose data is the coverage.
 */
import type { ScreenElement, ScreenSnapshot } from "../device/types.js";
import { scrollContent, staticLabel } from "../device/uiautomator.js";
import { cleanAppText } from "./text.js";
import type { Edge, EdgeVia, MobileAppModel, MobileScreen } from "./types.js";

// ── queries over a model (read-only) ────────────────────────────────────────

export const screenOf = (model: Pick<MobileAppModel, "screens">, id: string): MobileScreen | undefined => model.screens.find((s) => s.id === id);

export interface PathOptions {
    /** Most navigations (default 12). */
    maxEdges?: number;
    /** Also walk "back" edges (default false: a written test cannot rely on what came before). */
    includeBack?: boolean;
    /** Also walk edges that did not replay (default false). */
    includeUnreliable?: boolean;
}

const usable = (e: Edge, o: PathOptions) => !e.incomplete && (o.includeUnreliable || !e.unreliable) && (o.includeBack || (e.via !== "back" && e.action.kind !== "back"));

/** The edges that leave a screen and can be walked (see PathOptions). */
export function edgesFrom(model: Pick<MobileAppModel, "edges">, id: string, o: PathOptions = {}): Edge[] {
    return model.edges.filter((e) => e.from === id && e.to !== id && usable(e, o));
}

/** Fewest navigations from one screen to another (breadth first; among equal lengths the edge recorded first wins). Undefined: no such path. */
export function shortestPath(model: Pick<MobileAppModel, "edges">, from: string, to: string, o: PathOptions = {}): Edge[] | undefined {
    if (from === to) return [];
    const max = o.maxEdges ?? 12;
    const seen = new Map<string, Edge[]>([[from, []]]);
    const queue = [from];
    while (queue.length) {
        const at = queue.shift()!;
        const here = seen.get(at)!;
        if (here.length >= max) continue;
        for (const e of edgesFrom(model, at, o)) {
            if (seen.has(e.to)) continue;
            const path = [...here, e];
            if (e.to === to) return path;
            seen.set(e.to, path);
            queue.push(e.to);
        }
    }
    return undefined;
}

/** The way a written test reaches a screen from a fresh start of the app. */
export const pathFromStart = (model: Pick<MobileAppModel, "edges" | "start">, to: string, o: PathOptions = {}): Edge[] | undefined => shortestPath(model, model.start, to, o);

/** Fewest navigations from the first screen to every screen that can be reached forward. */
export function depths(model: Pick<MobileAppModel, "edges" | "start">, o: PathOptions = {}): Map<string, number> {
    const out = new Map<string, number>([[model.start, 0]]);
    const queue = [model.start];
    while (queue.length) {
        const at = queue.shift()!;
        for (const e of edgesFrom(model, at, o)) {
            if (out.has(e.to)) continue;
            out.set(e.to, out.get(at)! + 1);
            queue.push(e.to);
        }
    }
    return out;
}

/** The main navigation: screens reached through a tab or bottom-navigation entry, with the label of that entry. First seen first. */
export function mainTabs(model: Pick<MobileAppModel, "edges" | "screens">): Array<{ screen: MobileScreen; edge: Edge; label: string }> {
    const out: Array<{ screen: MobileScreen; edge: Edge; label: string }> = [];
    const seen = new Set<string>();
    for (const e of model.edges) {
        if (e.via !== "tab" || e.unreliable || seen.has(e.to)) continue;
        const screen = screenOf(model, e.to);
        if (!screen) continue;
        seen.add(e.to);
        out.push({ screen, edge: e, label: e.action.kind === "tap" ? e.action.label : screen.title });
    }
    return out;
}

/** A list and the detail screen one of its items opened (the edge is the tap on the item). */
export function listDetails(model: Pick<MobileAppModel, "edges" | "screens">): Array<{ list: MobileScreen; detail: MobileScreen; edge: Edge }> {
    const out: Array<{ list: MobileScreen; detail: MobileScreen; edge: Edge }> = [];
    for (const e of model.edges) {
        if (e.via !== "list-item" || e.unreliable) continue;
        const list = screenOf(model, e.from);
        const detail = screenOf(model, e.to);
        if (list && detail && list.id !== detail.id) out.push({ list, detail, edge: e });
    }
    return out;
}

/** The best name the exploration knows for a screen: the AI's, the toolbar heading, the selected tab, else its title. */
export function screenLabel(s: Pick<MobileScreen, "title" | "aiName" | "toolbarTitle" | "selectedTab">): string {
    return s.aiName || s.toolbarTitle || s.selectedTab || s.title;
}

// ── naming elements across visits ───────────────────────────────────────────

/**
 * A key per element that stays the same when the screen is seen again (the index does not: lists move, dialogs come and go). Outside lists:
 * class, resource id and static label, with a number when several share it. Inside a view that scrolls, the clickable rows that repeat (same
 * class and id) are ONE key, `item:…`: a list is opened through its first visible item, never item by item.
 */
export function elementKeys(snap: Pick<ScreenSnapshot, "elements">): string[] {
    const els = snap.elements;
    const inside = scrollContent(els);
    const shape = (e: ScreenElement) => `${e.cls}|${e.id}`;
    const repeats = new Map<string, number>();
    els.forEach((e, i) => {
        if (inside[i] && isTappable(e)) repeats.set(shape(e), (repeats.get(shape(e)) ?? 0) + 1);
    });
    const used = new Map<string, number>();
    return els.map((e, i) => {
        if (inside[i] && isTappable(e) && (repeats.get(shape(e)) ?? 0) >= 2) return `item:${shape(e)}`;
        // A field's text is what was typed into it: a field is named by its id, or by its label when it has none.
        const base = e.editable || e.password ? `field:${shape(e)}|${e.id ? "" : staticLabel(e.desc)}` : `el:${shape(e)}|${staticLabel(e.text || e.desc)}`;
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        return n === 0 ? base : `${base}#${n}`;
    });
}

/** The element a key names on this screen (the first visible row for a list key), or undefined when it is not there. */
export function findByKey(snap: Pick<ScreenSnapshot, "elements">, key: string): ScreenElement | undefined {
    const keys = elementKeys(snap);
    const i = keys.indexOf(key);
    return i >= 0 ? snap.elements[i] : undefined;
}

export const isTappable = (e: Pick<ScreenElement, "clickable" | "editable" | "enabled" | "password">): boolean => e.clickable && e.enabled && !e.editable && !e.password;

// ── landmarks: headings and main navigation ─────────────────────────────────

const TAB_CLASS = /(Tab|TabView|BottomNavigationItemView|NavigationBarItemView|NavigationRailItemView|BottomNavigationView)$/;
const TAB_ID = /(^|_)(tab|tabs|nav|navigation|bottom_?nav|bottom_?bar|nav_?bar|menu_?item)(_|$)|(tab|nav)_[a-z]+|_tab$/i;
const MENU_ID = /(overflow|more_options|menu|drawer|hamburger|navigation_drawer|toolbar_action|action_)/i;
const MENU_WORDS = /^(more options|more|menu|open navigation drawer|navigation drawer|open menu|settings|search|navigate up)$/i;
const HEADING_ID = /(^|[_.\s-])(title|toolbar|header|heading|action_?bar|app_?bar|top_?bar)([_.\s-]|$)|^(title|toolbar|header|heading)/i;

/** A label as a person reads it on a tab or heading: cleaned, without a trailing count ("Notifications, 3 new" is "Notifications"). */
export function displayLabel(raw: string, max = 40): string {
    const t = cleanAppText(raw.replace(/,\s*\d+.*$/, "").replace(/\(\d+\)\s*$/, "").replace(/\s+\d+\s*(new|unread)?\s*$/i, ""), max);
    return /\p{L}/u.test(t) ? t : "";
}

export interface Landmarks {
    /** Indexes of the elements that are tabs or bottom-navigation entries. */
    tabIndexes: Set<number>;
    /** Indexes of the toolbar's buttons and menus (overflow, drawer, search icon). */
    menuIndexes: Set<number>;
    tabs: string[];
    selectedTab?: string;
    toolbarTitle?: string;
}

/** The screen's heading and main navigation, judged from what is outside its lists. */
export function landmarksOf(snap: Pick<ScreenSnapshot, "elements" | "height">): Landmarks {
    const els = snap.elements;
    const inside = scrollContent(els);
    const h = snap.height > 0 ? snap.height : Math.max(0, ...els.map((e) => e.bounds[3]));
    const chrome = els.map((e, i) => ({ e, i })).filter(({ i }) => !inside[i]);
    const tabIndexes = new Set<number>();
    for (const { e, i } of chrome) if (isTappable(e) && (TAB_CLASS.test(e.cls) || TAB_ID.test(e.id))) tabIndexes.add(i);
    // A row of three to six tappable things along the bottom edge is a bottom navigation, whatever the app calls it.
    const bottom = chrome.filter(({ e }) => isTappable(e) && e.bounds[1] >= h * 0.84 && e.bounds[3] <= h + 4);
    if (bottom.length >= 3 && bottom.length <= 6 && bottom.every(({ e }) => Math.abs(e.bounds[1] - bottom[0]!.e.bounds[1]) <= 24)) for (const { i } of bottom) tabIndexes.add(i);
    const menuIndexes = new Set<number>();
    for (const { e, i } of chrome) {
        if (tabIndexes.has(i) || !isTappable(e)) continue;
        const top = e.bounds[3] <= h * 0.16;
        if ((top && (MENU_ID.test(e.id) || MENU_WORDS.test((e.desc || e.text).trim()) || e.cls === "ImageButton")) || /NavigationMenuItemView$/.test(e.cls)) menuIndexes.add(i);
    }
    const tabs: string[] = [];
    let selectedTab: string | undefined;
    for (const i of [...tabIndexes].sort((a, b) => a - b)) {
        const e = els[i]!;
        const label = displayLabel(e.text || e.desc || e.id.replace(/[_-]+/g, " "));
        if (!label || tabs.includes(label)) continue;
        tabs.push(label);
        if (!selectedTab && (e.selected || (e.checkable && e.checked))) selectedTab = label;
    }
    const heading =
        chrome.find(({ e }) => !e.clickable && !e.editable && HEADING_ID.test(e.id) && displayLabel(e.text || e.desc)) ??
        chrome.find(({ e }) => !e.clickable && !e.editable && e.bounds[3] <= h * 0.16 && e.text.trim().length >= 2 && e.text.trim().length <= 40 && displayLabel(e.text));
    const toolbarTitle = heading ? displayLabel(heading.e.text || heading.e.desc) : undefined;
    return { tabIndexes, menuIndexes, tabs: tabs.slice(0, 8), ...(selectedTab ? { selectedTab } : {}), ...(toolbarTitle ? { toolbarTitle } : {}) };
}

// ── the live graph the explorer builds ──────────────────────────────────────

/** One thing that can be done on a screen, named so it is the same on every visit. */
export interface ActionSlot {
    /** elementKeys key of the element, or "scroll:down", "form", "sign-in". */
    key: string;
    kind: "tap" | "scroll" | "form" | "sign-in";
    label: string;
    via: EdgeVia;
    /** Lower is tried first: main navigation, the toolbar, buttons, a form, one scroll, list items. */
    priority: number;
    /** Times it was tried. */
    tries: number;
    /** Tried, refused or given up: never chosen again. */
    done: boolean;
}

/** A step of an edge, by element key, so the explorer can walk the edge again on a later visit. */
export type ReplayStep =
    | { kind: "tap"; key: string }
    | { kind: "type"; key: string; text: string }
    | { kind: "scroll"; direction: "up" | "down" | "left" | "right" }
    | { kind: "back" }
    | { kind: "hideKeyboard" };

export interface GraphLimits {
    maxEdges: number;
    maxListItems: number;
}

/**
 * The graph while it is built. Screens and edges are the model's own objects (MobileScreen, Edge), so the result needs no conversion; what
 * only the explorer needs (fingerprint aliases, frontiers, replay steps) stays here.
 */
export class ScreenGraph {
    readonly screens: MobileScreen[] = [];
    readonly edges: Edge[] = [];
    private readonly byPrint = new Map<string, MobileScreen>();
    private readonly slots = new Map<string, Map<string, ActionSlot>>();
    private readonly replay = new Map<string, ReplayStep[]>();
    private readonly edgeSigs = new Map<string, Edge>();
    /** List items opened per screen (a cap per screen, not per list). */
    private readonly listTaps = new Map<string, number>();

    constructor(private readonly limits: GraphLimits) {}

    screen(id: string): MobileScreen | undefined {
        return this.screens.find((s) => s.id === id);
    }

    /** The screen a fingerprint belongs to (also a fingerprint seen once for it, an "alias"). */
    byFingerprint(print: string): MobileScreen | undefined {
        return this.byPrint.get(print);
    }

    add(screen: MobileScreen, print: string): void {
        this.screens.push(screen);
        this.byPrint.set(print, screen);
        this.slots.set(screen.id, new Map());
    }

    /** Another fingerprint of a known screen (a scroll revealed a part with a different shape): it is the same screen from now on. */
    alias(print: string, screen: MobileScreen): void {
        if (!this.byPrint.has(print)) this.byPrint.set(print, screen);
    }

    /** Adds the actions of a visit that the screen did not have yet (a scroll reveals more). Known ones keep their state. */
    offer(screenId: string, offered: ReadonlyArray<Omit<ActionSlot, "tries" | "done">>): void {
        const map = this.slots.get(screenId);
        if (!map) return;
        for (const s of offered) if (!map.has(s.key)) map.set(s.key, { ...s, tries: 0, done: false });
    }

    /** Marks an action as tried (or refused). */
    tried(screenId: string, key: string): void {
        const slot = this.slots.get(screenId)?.get(key);
        if (!slot) return;
        slot.tries++;
        slot.done = true;
        if (slot.kind === "tap" && slot.via === "list-item") this.listTaps.set(screenId, (this.listTaps.get(screenId) ?? 0) + 1);
    }

    /** The next untried action of a screen, best first; list items stop after the per-screen cap. */
    next(screenId: string): ActionSlot | undefined {
        const map = this.slots.get(screenId);
        if (!map) return undefined;
        const listFull = (this.listTaps.get(screenId) ?? 0) >= this.limits.maxListItems;
        let best: ActionSlot | undefined;
        for (const s of map.values()) {
            if (s.done || (listFull && s.via === "list-item")) continue;
            if (!best || s.priority < best.priority) best = s;
        }
        return best;
    }

    /** Untried actions left on a screen (what the planner is told as `untried`). */
    left(screenId: string): number {
        const map = this.slots.get(screenId);
        if (!map) return 0;
        const listFull = (this.listTaps.get(screenId) ?? 0) >= this.limits.maxListItems;
        let n = 0;
        for (const s of map.values()) if (!s.done && !(listFull && s.via === "list-item")) n++;
        return n;
    }

    /** Every action given up on a screen (it cannot be reached any more). */
    abandon(screenId: string): number {
        const map = this.slots.get(screenId);
        let n = 0;
        for (const s of map?.values() ?? []) {
            if (!s.done) {
                s.done = true;
                n++;
            }
        }
        return n;
    }

    /** Labels of the taps already tried on a screen (what the AI is told not to choose again). */
    triedLabels(screenId: string): string[] {
        const out: string[] = [];
        for (const s of this.slots.get(screenId)?.values() ?? []) if (s.tries > 0 && s.kind === "tap" && out.length < 12) out.push(s.label);
        return out;
    }

    triedCount(): number {
        let n = 0;
        for (const map of this.slots.values()) for (const s of map.values()) if (s.tries > 0) n++;
        return n;
    }

    leftCount(): number {
        return this.screens.reduce((t, s) => t + this.left(s.id), 0);
    }

    /** Records an edge once (same screens, same steps); returns it (the known one when it existed). Undefined when the cap is reached. */
    addEdge(e: Omit<Edge, "id">, steps: ReplayStep[]): Edge | undefined {
        const sig = JSON.stringify([e.from, e.to, e.prelude, e.action]);
        const known = this.edgeSigs.get(sig);
        if (known) return known;
        if (this.edges.length >= this.limits.maxEdges) return undefined;
        const edge: Edge = { id: `T${this.edges.length + 1}`, ...e };
        this.edges.push(edge);
        this.edgeSigs.set(sig, edge);
        this.replay.set(edge.id, steps);
        return edge;
    }

    stepsOf(edgeId: string): ReplayStep[] | undefined {
        return this.replay.get(edgeId);
    }

    /** A replay of the edge reached its screen (or did not: twice and it is unreliable). */
    replayed(edge: Edge, ok: boolean): void {
        const r = (edge.replays ??= { ok: 0, failed: 0 });
        if (ok) r.ok++;
        else r.failed++;
        if (r.failed >= 2 && r.failed > r.ok) edge.unreliable = true;
    }

    /**
     * The nearest screen (fewest edges forward from `from`, through edges that replay) that still has an untried action, and the way there.
     * `from` itself when it has one. Undefined when none can be reached from here.
     */
    nearestFrontier(from: string, maxEdges: number): { target: string; path: Edge[] } | undefined {
        if (this.next(from)) return { target: from, path: [] };
        const model = { edges: this.edges };
        const seen = new Map<string, Edge[]>([[from, []]]);
        const queue = [from];
        while (queue.length) {
            const at = queue.shift()!;
            const here = seen.get(at)!;
            if (here.length >= maxEdges) continue;
            for (const e of edgesFrom(model, at)) {
                if (seen.has(e.to) || !this.replay.has(e.id)) continue;
                const path = [...here, e];
                if (this.next(e.to)) return { target: e.to, path };
                seen.set(e.to, path);
                queue.push(e.to);
            }
        }
        return undefined;
    }

    /** Screens with untried actions that cannot be reached forward from `from` (they are given up when even a fresh start cannot reach them). */
    frontierScreens(): string[] {
        return this.screens.filter((s) => this.next(s.id)).map((s) => s.id);
    }
}
