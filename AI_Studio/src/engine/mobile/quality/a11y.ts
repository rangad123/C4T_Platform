/**
 * Accessibility of one phone screen, read from the same UI Automator description the device session parses (no extra call to the phone).
 *
 * Rules (each a plain sentence in the finding):
 *  - something a person can touch has no label a screen reader can say (no text, no content description, and no text inside it): medium;
 *  - an image button with no content description: medium;
 *  - a touch target smaller than 48 × 48 dp (Android's guideline), unless it sits inside a larger touchable area or is cut by a list's edge: low;
 *  - several touchable things with the same label on one screen (a screen reader user cannot tell them apart): low.
 *
 * Not checked, and said so: text size (UI Automator does not report it) and colour contrast (it would need the picture and the colours behind
 * each text; a cheap guess would be wrong too often). Password fields are not checked for a label (their hint is never read).
 */
import type { ScreenElement } from "../device/types.js";
import type { PhoneA11yIssue, ScreenA11y } from "./types.js";

export const MIN_TARGET_DP = 48;
/** The width in dp a phone screen is assumed to have when its density is not known. */
export const ASSUMED_WIDTH_DP = 400;
export const MAX_ISSUES_PER_SCREEN = 20;
export const NOT_CHECKED = "Text size and colour contrast are not checked on phone screens: the screen description does not report text sizes, and contrast cannot be measured reliably from it.";

type Box = ScreenElement["bounds"];
const touchable = (e: ScreenElement) => e.clickable || e.longClickable || e.checkable || e.editable;
const inside = (a: Box, b: Box) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
const same = (a: Box, b: Box) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function kindWord(e: ScreenElement): string {
    if (/ImageButton|ImageView|FloatingActionButton/.test(e.cls)) return "image button";
    if (e.editable) return "text field";
    if (/CheckBox/.test(e.cls)) return "checkbox";
    if (/Switch|Toggle/.test(e.cls)) return "switch";
    if (/RadioButton/.test(e.cls)) return "option";
    if (/Button/.test(e.cls)) return "button";
    return "item";
}

function where(e: ScreenElement, w: number, h: number): string {
    const cx = (e.bounds[0] + e.bounds[2]) / 2;
    const cy = (e.bounds[1] + e.bounds[3]) / 2;
    const v = cy < h / 3 ? "top" : cy > (2 * h) / 3 ? "bottom" : "middle";
    const hz = cx < w / 3 ? "left" : cx > (2 * w) / 3 ? "right" : "centre";
    return v === "middle" && hz === "centre" ? "in the middle" : `at the ${v}${hz === "centre" ? "" : ` ${hz}`}`;
}

/** How a person finds the element in the finding: its label, else its id, else its kind and place on the screen. */
export function nameOf(e: ScreenElement, w: number, h: number, label?: string): string {
    const k = kindWord(e);
    if (label) return `the ${k} “${label.slice(0, 60)}”`;
    if (e.id) return `the ${k} with id “${e.id.slice(0, 60)}”`;
    return `an unlabelled ${k} ${where(e, w, h)}`;
}

/**
 * Checks one screen. `densityDpi` is the phone's screen density (160 = 1 px per dp); without it, dp sizes are estimated from the screen width
 * (assumed 400 dp wide) and the result says so.
 */
export function checkScreenA11y(snap: { elements: readonly ScreenElement[]; width: number; height: number }, o: { screen: string; title: string; densityDpi?: number }): ScreenA11y {
    const els = snap.elements;
    const w = Math.max(1, snap.width);
    const h = Math.max(1, snap.height);
    const pxPerDp = o.densityDpi && o.densityDpi > 0 ? o.densityDpi / 160 : w / ASSUMED_WIDTH_DP;
    const issues: PhoneA11yIssue[] = [];
    const targets = els.filter(touchable);

    /** The text a screen reader says for an element: its own text or description, else the texts inside it. */
    const spoken = (e: ScreenElement): string => {
        const own = (e.text || e.desc).trim();
        if (own) return own;
        return els
            .filter((x) => x !== e && !touchable(x) && (x.text || x.desc).trim() && inside(x.bounds, e.bounds))
            .map((x) => (x.text || x.desc).trim())
            .join(" ")
            .trim();
    };

    for (const e of targets) {
        if (e.password) continue;
        const label = spoken(e);
        if (label) continue;
        const image = /ImageButton|ImageView|FloatingActionButton/.test(e.cls);
        issues.push(
            image
                ? { rule: "image-no-description", severity: "medium", message: `${cap(nameOf(e, w, h))} has no content description, so a screen reader cannot say what it does` }
                : { rule: "no-label", severity: "medium", message: `${cap(nameOf(e, w, h))} has no label a screen reader can say (no text and no content description)` },
        );
    }

    for (const e of targets) {
        if (!e.enabled) continue;
        const wd = (e.bounds[2] - e.bounds[0]) / pxPerDp;
        const hd = (e.bounds[3] - e.bounds[1]) / pxPerDp;
        if (wd >= MIN_TARGET_DP - 0.5 && hd >= MIN_TARGET_DP - 0.5) continue;
        // Inside a larger touchable area (a row that is itself a target): the row is what a finger hits.
        const bigger = targets.some((p) => p !== e && !same(p.bounds, e.bounds) && inside(e.bounds, p.bounds) && (p.bounds[2] - p.bounds[0]) / pxPerDp >= MIN_TARGET_DP && (p.bounds[3] - p.bounds[1]) / pxPerDp >= MIN_TARGET_DP);
        if (bigger) continue;
        // Cut by the edge of the screen or of a scrolling list: only part of it is visible, its real size is unknown.
        const cut = e.bounds[1] <= 0 || e.bounds[3] >= h || els.some((s) => s.scrollable && s !== e && inside(e.bounds, s.bounds) && (e.bounds[1] === s.bounds[1] || e.bounds[3] === s.bounds[3]));
        if (cut) continue;
        const label = spoken(e) || undefined;
        issues.push({ rule: "small-target", severity: "low", message: `${cap(nameOf(e, w, h, label))} is ${Math.round(wd)} × ${Math.round(hd)} dp; touch targets should be at least ${MIN_TARGET_DP} × ${MIN_TARGET_DP} dp` });
    }

    const byLabel = new Map<string, { label: string; n: number; e: ScreenElement }>();
    for (const e of targets) {
        if (e.editable) continue;
        const label = (e.text || e.desc).trim();
        if (!label) continue;
        const k = norm(label);
        const cur = byLabel.get(k);
        if (cur) cur.n++;
        else byLabel.set(k, { label, n: 1, e });
    }
    for (const { label, n, e } of byLabel.values()) {
        if (n < 2) continue;
        issues.push({ rule: "duplicate-label", severity: "low", message: `${n} ${kindWord(e)}s are all called “${label.slice(0, 60)}”, so a screen reader user cannot tell them apart` });
    }

    return { screen: o.screen, title: o.title, checked: els.length, issues: issues.slice(0, MAX_ISSUES_PER_SCREEN), ...(o.densityDpi && o.densityDpi > 0 ? {} : { densityAssumed: true as const }) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
