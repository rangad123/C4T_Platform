/**
 * What the explorer keeps of a screen: who it is (a key that survives typing and changing numbers), what to call it, and its elements
 * in a form that is safe to store and to show.
 */
import { createHash } from "node:crypto";
import type { ScreenElement, ScreenSnapshot } from "../device/types.js";
import { scrollContent } from "../device/uiautomator.js";
import { landmarksOf, screenLabel } from "./graph.js";
import { isDynamicText, isStableId, locatorFor } from "./locators.js";
import { cleanAppText, scrubSecrets } from "./text.js";
import { PASSWORD_PLACEHOLDER, type Edge, type MobileScreen, type ScreenKind, type StoredElement } from "./types.js";

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Numbers in text change by themselves (a cart count, a clock): they do not make a different screen. */
const norm = (t: string) => t.replace(/\d+/g, "#").trim().toLowerCase();

/** Who a screen is: the app, the activity and what is on it. What was typed into a field is not part of it, so filling a form stays on one screen. */
export function screenKeyOf(snap: ScreenSnapshot): string {
    const parts = snap.elements.map((e) => (e.editable || e.password ? `${e.cls}|${e.id}|${norm(e.desc)}` : `${e.cls}|${e.id}|${norm(e.text)}|${norm(e.desc)}`));
    return hash(`${snap.package}|${snap.activity ?? ""}|${parts.sort().join("\n")}`);
}

/** Everything on the screen, typed text included: used to tell whether an action changed anything at all. */
export function fullKeyOf(snap: ScreenSnapshot): string {
    return hash(`${snap.package}|${snap.activity ?? ""}|${snap.elements.map((e) => `${e.cls}|${e.id}|${e.text}|${e.desc}|${e.checked ? 1 : 0}`).join("\n")}`);
}

const TITLE_ID = /(title|toolbar|header|heading|action.?bar)/i;

function wordsOfActivity(a: string | undefined): string {
    const last = (a ?? "").split(".").pop() ?? "";
    return last.replace(/Activity$|Fragment$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ").trim();
}

/** A label that can name a screen: not a count, a time or a long piece of content. */
const nameable = (t: string) => t.trim().length >= 2 && t.trim().length <= 40 && !isDynamicText(t);

/**
 * A name for the screen a person would recognise (R24): the heading of its toolbar, else the selected tab of its main navigation, else a short
 * static text outside its lists, else the words of its activity. Never a count, a time or feed content.
 */
export function titleOf(snap: ScreenSnapshot, secrets: readonly string[] = []): string {
    const clean = (s: string) => cleanAppText(scrubSecrets(s, secrets), 40);
    const inside = scrollContent(snap.elements);
    const marks = landmarksOf(snap);
    if (marks.toolbarTitle && nameable(marks.toolbarTitle)) return clean(marks.toolbarTitle);
    const labelled = snap.elements.find((e) => TITLE_ID.test(e.id) && !e.password && nameable(e.text || e.desc));
    if (labelled) return clean(labelled.text || labelled.desc);
    if (marks.selectedTab && nameable(marks.selectedTab)) return clean(marks.selectedTab);
    const outside = snap.elements.filter((_, i) => !inside[i]);
    const text = outside.find((e) => !e.clickable && !e.editable && nameable(e.text));
    if (text) return clean(text.text);
    const any = outside.find((e) => (e.clickable || e.editable) && !e.password && nameable(e.text));
    if (any) return clean(any.text);
    return wordsOfActivity(snap.activity) || "Screen";
}

/** Elements as stored: cleaned, capped, passwords empty, locators (with their fallbacks) chosen against the whole screen. */
export function storeElements(snap: ScreenSnapshot, secrets: readonly string[] = [], cap = 80): StoredElement[] {
    const clean = (s: string) => cleanAppText(scrubSecrets(s, secrets), 60);
    // Inside a list or feed: from the hierarchy, or (a snapshot without it) from the bounds.
    const inside = scrollContent(snap.elements);
    const named: ScreenElement[] = snap.elements.map((e, i) => ({ ...e, text: e.password ? "" : e.text, desc: e.desc, ...(inside[i] ? { inScroll: true as const } : {}) }));
    return named.slice(0, cap).map((e) => {
        const { loc } = locatorFor(e, named);
        // Cleaned text is what is stored; the locator keeps the real text (a test must find the element by what it really says).
        return {
            cls: e.cls,
            text: clean(e.text),
            desc: clean(e.desc),
            id: e.id,
            clickable: e.clickable,
            scrollable: e.scrollable,
            editable: e.editable,
            password: e.password,
            checkable: e.checkable,
            ...(loc ? { loc: scrubLoc(loc, secrets) } : {}),
            ...(e.inScroll ? { inScroll: true as const } : {}),
        };
    });
}

// ── names that tell screens apart ──────────────────────────────────────────

const ORDINAL = ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const KIND_WORDS: Partial<Record<ScreenKind, string>> = { list: "list", form: "form", signin: "sign-in", detail: "details" };
/** A title made unique by an earlier version with a number ("Search (4)"): the number says nothing, so it goes. */
const NUMBERED = /\s*\(\d+\)$/;
const WEAK = /^(screen|view|page|main|activity|fragment|home activity)?$/i;

/** Words of a resource id as a person reads them ("job_details_header" reads "job details header"). */
const idWords = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();

/**
 * Names screens so that no two share one, in words (R24): never "Search (4)". Each screen keeps its best name (the AI's name, the toolbar
 * heading, the selected tab, its title); when several share it, the first one found keeps it and the others get what tells them apart: their
 * selected tab, their activity, what kind of screen they are, a label only they show, an id only they have, or the screen they are opened from.
 * Changes `title` in place; running it again changes nothing.
 */
export function nameScreens(screens: MobileScreen[], edges: ReadonlyArray<Pick<Edge, "from" | "to" | "action" | "prelude" | "via">> = []): void {
    const fix = (t: string) => cleanAppText(t.replace(NUMBERED, ""), 60).replace(/\s+/g, " ").trim();
    for (const s of screens) {
        let base = fix(s.title);
        if (WEAK.test(base) || isDynamicText(base)) base = fix(screenLabel({ ...s, title: "" }) || wordsOfActivity(s.activity) || base || "Screen") || "Screen";
        s.title = base;
    }
    const taken = new Set<string>();
    const groups = new Map<string, MobileScreen[]>();
    for (const s of screens) groups.set(s.title.toLowerCase(), [...(groups.get(s.title.toLowerCase()) ?? []), s]);
    for (const s of screens) if ((groups.get(s.title.toLowerCase()) ?? []).length === 1) taken.add(s.title.toLowerCase());
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const [first, ...rest] = group;
        taken.add(first!.title.toLowerCase());
        const base = first!.title;
        const labelsOf = (x: MobileScreen) => new Set(x.elements.filter((e) => !e.inScroll && !e.password && nameable(e.text || e.desc)).map((e) => cleanAppText(e.text || e.desc, 30)));
        const idsOf = (x: MobileScreen) => new Set(x.elements.filter((e) => e.id && isStableId(e.id)).map((e) => e.id));
        rest.forEach((s, i) => {
            const others = group.filter((x) => x !== s);
            const otherLabels = new Set(others.flatMap((x) => [...labelsOf(x)].map((l) => l.toLowerCase())));
            const otherIds = new Set(others.flatMap((x) => [...idsOf(x)]));
            const from = edges.find((e) => e.to === s.id && e.from !== s.id);
            const fromTitle = from ? screens.find((x) => x.id === from.from)?.title : undefined;
            const activity = wordsOfActivity(s.activity);
            const signedIn = edges.some((e) => e.to === s.id && e.from !== s.id && (e.via === "sign-in" || [...(e.prelude ?? []), e.action].some((a) => a?.kind === "type" && a.text === PASSWORD_PLACEHOLDER)));
            // What only this screen shows: the labels of its buttons first (a greeting or a name is content), never a hidden or removed text.
            const own = [...labelsOf(s)].filter((l) => l.toLowerCase() !== base.toLowerCase() && !otherLabels.has(l.toLowerCase()) && !/\((hidden|text removed)\)/.test(l));
            const buttons = new Set(s.elements.filter((e) => e.clickable).map((e) => cleanAppText(e.text || e.desc, 30)));
            const hints = [
                s.selectedTab,
                activity && !others.some((x) => wordsOfActivity(x.activity) === activity) ? activity : undefined,
                others.every((x) => x.kind !== s.kind) ? KIND_WORDS[s.kind] : undefined,
                signedIn && !others.some((x) => edges.some((e) => e.to === x.id && e.via === "sign-in")) ? "signed in" : undefined,
                own.find((l) => buttons.has(l)) ?? own[0],
                [...idsOf(s)].filter((id) => !otherIds.has(id)).map(idWords).find((w) => w.length >= 3 && w.length <= 30),
                fromTitle && fromTitle.toLowerCase() !== base.toLowerCase() ? `from ${fromTitle}` : undefined,
            ];
            let name = "";
            for (const h of hints) {
                const hint = (h ?? "").trim();
                if (!hint || hint.toLowerCase() === base.toLowerCase()) continue;
                const candidate = fix(`${base}, ${hint}`);
                if (!taken.has(candidate.toLowerCase())) {
                    name = candidate;
                    break;
                }
            }
            for (let k = i; !name; k++) {
                const candidate = fix(`${base}, ${ORDINAL[k] ? `${ORDINAL[k]} view` : `view ${k + 2}`}`);
                if (!taken.has(candidate.toLowerCase())) name = candidate;
            }
            taken.add(name.toLowerCase());
            s.title = name;
        });
    }
}

/** A locator that would carry a secret value is dropped (the element then has no stable name). */
function scrubLoc(loc: NonNullable<StoredElement["loc"]>, secrets: readonly string[]): StoredElement["loc"] {
    const carries = (v: string | undefined) => secrets.some((s) => s.length >= 4 && (v ?? "").includes(s));
    if (carries(loc.value)) return undefined;
    // A fallback that would carry one is dropped on its own; the locator keeps the others.
    if (!loc.fallbacks?.some((f) => carries(f.value))) return loc;
    const fallbacks = loc.fallbacks.filter((f) => !carries(f.value));
    const { fallbacks: _f, ...rest } = loc;
    return fallbacks.length ? { ...rest, fallbacks } : rest;
}

/** Is there something to type into and a button to send it? */
export function hasForm(snap: ScreenSnapshot): boolean {
    return snap.elements.some((e) => e.editable) && snap.elements.some((e) => e.clickable && !e.editable && !e.checkable);
}

export function isSignIn(snap: ScreenSnapshot): boolean {
    return snap.elements.some((e) => e.password);
}

/** A list: something scrolls and several same-looking things can be tapped. */
export function hasList(snap: ScreenSnapshot): boolean {
    if (!snap.elements.some((e) => e.scrollable)) return false;
    const counts = new Map<string, number>();
    for (const e of snap.elements) if (e.clickable && !e.editable) counts.set(e.cls, (counts.get(e.cls) ?? 0) + 1);
    return [...counts.values()].some((n) => n >= 3);
}

export function kindOf(snap: ScreenSnapshot, isStart: boolean): ScreenKind {
    if (isSignIn(snap)) return "signin";
    if (hasForm(snap)) return "form";
    if (hasList(snap)) return "list";
    return isStart ? "start" : "other";
}

export function newScreen(id: string, snap: ScreenSnapshot, isStart: boolean, secrets: readonly string[]): MobileScreen {
    return {
        id,
        title: titleOf(snap, secrets),
        package: snap.package,
        ...(snap.activity ? { activity: cleanAppText(snap.activity, 120) } : {}),
        kind: kindOf(snap, isStart),
        elements: storeElements(snap, secrets),
        visits: 1,
        hasForm: hasForm(snap),
        scrollable: snap.elements.some((e) => e.scrollable),
    };
}
