/**
 * Reads the screen description Android's UI Automator gives (`uiautomator dump`) and keeps what a person could see or touch.
 *
 * The XML comes from an app on a phone, so it is untrusted text: it is read by a small scanner of our own (no XML library, no entities beyond the five
 * standard ones and numeric references, no DTD), every text is stripped of control and direction-changing characters and cut short, and the number of
 * elements, the size of the document and the depth of the tree are capped. A password field keeps its flag and loses its text. Malformed input never
 * throws: it returns an explicit error the session turns into a plain sentence.
 */
import { createHash } from "node:crypto";
import type { ScreenElement, ScreenSnapshot } from "./types.js";

export const HIERARCHY_LIMITS = {
    maxElements: 120,
    maxText: 80,
    maxId: 100,
    maxXmlBytes: 2 * 1024 * 1024,
    maxDepth: 80,
    maxNodes: 8000,
} as const;

/** Packages of the system's own dialogs: when one is in front, the app under test is not (permission questions, "isn't responding", the shade). */
export const SYSTEM_DIALOG_PACKAGES: ReadonlySet<string> = new Set([
    "com.android.permissioncontroller",
    "com.google.android.permissioncontroller",
    "com.android.packageinstaller",
    "com.google.android.packageinstaller",
    "com.android.systemui",
    "android",
]);

export interface ParseContext {
    /** The app under test; a different foreground package means the screen is outside it. */
    appPackage: string;
    /** Foreground activity when known (from `dumpsys window`). */
    activity?: string;
    /** True when the keyboard is showing (from `dumpsys input_method`). */
    keyboard?: boolean;
}

export type ParseResult = { ok: true; snapshot: Omit<ScreenSnapshot, "screenshot"> } | { ok: false; error: string };

export const SCREEN_UNREADABLE = "The phone's screen could not be read. It may be changing; try again in a moment.";
export const SCREEN_TOO_LARGE = "The phone's screen description is too large to read.";

// ── text ────────────────────────────────────────────────────────────────────

/** Control characters, bidi overrides/isolates and zero-width characters: they can hide or reorder text, and none is something a person reads. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Page text made safe for a model and a log: no control or direction characters, one line, trimmed, at most `max` characters, no half surrogate pair. */
export function cleanText(raw: string, max: number = HIERARCHY_LIMITS.maxText): string {
    let t = raw.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
    if (t.length > max) {
        t = t.slice(0, max);
        const last = t.charCodeAt(t.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
        t = t.trimEnd();
    }
    // A lone surrogate (cut or broken in the source) is not text.
    return t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
    if (!s.includes("&")) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, body: string) => {
        if (body.startsWith("#")) {
            const cp = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
            return String.fromCodePoint(cp);
        }
        return ENTITIES[body] ?? whole;
    });
}

// ── scanning ────────────────────────────────────────────────────────────────

interface Tag {
    name: string;
    attrs: Map<string, string>;
    closing: boolean;
    selfClosing: boolean;
    end: number;
}

const NAME_CHAR = /[A-Za-z0-9_:.-]/;
const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r";

/** Reads the tag that starts at `<` at position `i`. undefined when it is not well formed. */
function readTag(xml: string, i: number): Tag | undefined {
    let p = i + 1;
    const closing = xml[p] === "/";
    if (closing) p++;
    const nameStart = p;
    while (p < xml.length && NAME_CHAR.test(xml[p]!)) p++;
    if (p === nameStart) return undefined;
    const name = xml.slice(nameStart, p);
    const attrs = new Map<string, string>();
    for (;;) {
        while (isSpace(xml[p])) p++;
        const c = xml[p];
        if (c === undefined) return undefined;
        if (c === ">") return { name, attrs, closing, selfClosing: false, end: p + 1 };
        if (c === "/") return xml[p + 1] === ">" ? { name, attrs, closing, selfClosing: true, end: p + 2 } : undefined;
        if (closing) return undefined;
        const aStart = p;
        while (p < xml.length && NAME_CHAR.test(xml[p]!)) p++;
        if (p === aStart) return undefined;
        const key = xml.slice(aStart, p);
        while (isSpace(xml[p])) p++;
        if (xml[p] !== "=") return undefined;
        p++;
        while (isSpace(xml[p])) p++;
        const q = xml[p];
        if (q !== '"' && q !== "'") return undefined;
        const close = xml.indexOf(q, p + 1);
        if (close < 0) return undefined;
        const value = xml.slice(p + 1, close);
        if (value.includes("<")) return undefined;
        if (!attrs.has(key)) attrs.set(key, value);
        p = close + 1;
    }
}

interface RawNode {
    depth: number;
    top: number;
    attrs: Map<string, string>;
    order: number;
}

/** Walks the document; returns the `node` elements in document order with the index of the top-level window each one is in. */
function scan(xml: string): { nodes: RawNode[]; windows: Array<{ pkg: string; area: number }>; sawRoot: boolean } | string {
    const nodes: RawNode[] = [];
    const windows: Array<{ pkg: string; area: number }> = [];
    const stack: string[] = [];
    let sawRoot = false;
    let order = 0;
    let i = 0;
    while (i < xml.length) {
        const lt = xml.indexOf("<", i);
        if (lt < 0) break;
        if (xml.startsWith("<?", lt)) {
            const end = xml.indexOf("?>", lt + 2);
            if (end < 0) return SCREEN_UNREADABLE;
            i = end + 2;
            continue;
        }
        if (xml.startsWith("<!--", lt)) {
            const end = xml.indexOf("-->", lt + 4);
            if (end < 0) return SCREEN_UNREADABLE;
            i = end + 3;
            continue;
        }
        // A DOCTYPE or CDATA section is never part of a dump; refusing them keeps every entity trick out.
        if (xml.startsWith("<!", lt)) return SCREEN_UNREADABLE;
        const tag = readTag(xml, lt);
        if (!tag) return SCREEN_UNREADABLE;
        i = tag.end;
        if (tag.closing) {
            if (stack.pop() !== tag.name) return SCREEN_UNREADABLE;
            continue;
        }
        if (tag.name === "hierarchy" && stack.length === 0) sawRoot = true;
        else if (!sawRoot) return SCREEN_UNREADABLE;
        // `uiautomator dump` calls every view `node`; the UiAutomator2 server's page source (uia2-source.ts) names each by its class
        // (`<android.widget.Button …>`) with the same attributes: inside <hierarchy>, every element is a view.
        if (tag.name !== "hierarchy") {
            const depth = stack.filter((n) => n !== "hierarchy").length;
            if (depth > HIERARCHY_LIMITS.maxDepth) {
                // Deeper than any real screen: the rest of this branch is skipped, not read.
                if (!tag.selfClosing) stack.push(tag.name);
                continue;
            }
            if (nodes.length >= HIERARCHY_LIMITS.maxNodes) return SCREEN_TOO_LARGE;
            if (depth === 0) windows.push({ pkg: tag.attrs.get("package") ?? "", area: areaOf(tag.attrs.get("bounds")) });
            nodes.push({ depth, top: windows.length - 1, attrs: tag.attrs, order: order++ });
        }
        if (!tag.selfClosing) stack.push(tag.name);
    }
    if (stack.length > 0 || !sawRoot) return SCREEN_UNREADABLE;
    return { nodes, windows, sawRoot };
}

const BOUNDS = /^\[(-?\d{1,6}),(-?\d{1,6})\]\[(-?\d{1,6}),(-?\d{1,6})\]$/;
function boundsOf(raw: string | undefined): [number, number, number, number] | undefined {
    const m = raw ? BOUNDS.exec(raw) : null;
    if (!m) return undefined;
    const v = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
    return v.map((n) => Math.max(-100_000, Math.min(100_000, n))) as [number, number, number, number];
}
function areaOf(raw: string | undefined): number {
    const b = boundsOf(raw);
    return b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0;
}

// ── elements ────────────────────────────────────────────────────────────────

const EDITABLE_CLASSES = new Set(["EditText", "AutoCompleteTextView", "MultiAutoCompleteTextView", "TextInputEditText", "SearchAutoComplete", "AppCompatEditText"]);
const isLayoutClass = (cls: string) => cls === "View" || /(Layout|ViewGroup)$/.test(cls);
const flag = (a: Map<string, string>, k: string) => a.get(k) === "true";

function shortClass(raw: string): string {
    const last = raw.slice(raw.lastIndexOf(".") + 1).replace(/\$.*$/, "");
    return cleanText(last, 60) || "View";
}

function shortId(raw: string): string {
    const i = raw.lastIndexOf("/");
    return cleanText(i >= 0 ? raw.slice(i + 1) : raw, HIERARCHY_LIMITS.maxId);
}

// ── screen identity ─────────────────────────────────────────────────────────
//
// Two fingerprints (R24). The STRUCTURAL one names the screen: what kind of screen it is, not what it shows right now, so a feed that was
// scrolled or refreshed, a badge count that went up, a switch that was turned on or a field that was typed into is the same screen. The one
// WITH TEXT changes whenever anything visible changes: it tells when a screen has settled and is kept as evidence.
//
// The structural key follows the idea of DroidBot's `structure_str` (a state key from the views' class and resource id, without their text):
// DroidBot, https://github.com/honeynet/droidbot, MIT License, Copyright (c) 2017 Yuanchun Li and the DroidBot contributors. Only the idea is
// used; the rules below are our own. What counts:
//  - package and activity;
//  - outside any view that scrolls (the "chrome": toolbar, tabs, bottom navigation, buttons, headings): class + resource id of every element,
//    the static label of what can be tapped (numbers become #, so "Notifications, 3 new" equals "Notifications, 5 new"; text that is mostly
//    numbers is no label), whether a tab is the selected one, and the text of a heading (an id like title/toolbar/header, or short text in the
//    top band of the screen);
//  - the views that scroll themselves (a list, a feed), by class and resource id; of what is INSIDE them (content that changes by itself) only
//    the text fields of a form that scrolls: every row of a list is the same template, so 5 or 50 posts, an ad or a "people you may know"
//    carousel, change nothing.
// Typed text, checked states of switches and every other text are never part of it.

type StructuralElement = Pick<ScreenElement, "id" | "text" | "desc" | "cls" | "editable" | "password"> &
    Partial<Pick<ScreenElement, "clickable" | "longClickable" | "scrollable" | "checkable" | "bounds" | "inScroll" | "selected">>;

/** Ids that name a heading: their text is part of what a screen is. */
const HEADING_ID = /(^|[_.\s-])(title|toolbar|header|heading|action_?bar|app_?bar|top_?bar)([_.\s-]|$)|^(title|toolbar|header|heading)/i;
/** A heading without such an id: short text whose bottom edge is in the top part of the screen. */
const TOP_BAND = 0.16;

/**
 * The label of an element as part of a screen's identity: lower case, numbers as #, cut; "" when it is mostly numbers (a count, a time, a price)
 * or empty. Equal for "Inbox (3)" and "Inbox (12)".
 */
export function staticLabel(raw: string, max = 40): string {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) return "";
    const digits = (t.match(/\d/g) ?? []).length;
    if (digits * 2 >= t.replace(/\s/g, "").length) return "";
    return t.replace(/\d+/g, "#").toLowerCase().slice(0, max);
}

/**
 * Which elements are content of a view that scrolls. From the hierarchy when the parser marked them (`inScroll`); otherwise (a snapshot from a
 * runner or a farm, a test double) from the bounds: an element whose centre lies inside a larger scrolling element.
 */
export function scrollContent(elements: ReadonlyArray<StructuralElement>): boolean[] {
    if (elements.some((e) => e.inScroll === true)) return elements.map((e) => e.inScroll === true);
    const area = (b: readonly number[]) => Math.max(0, b[2]! - b[0]!) * Math.max(0, b[3]! - b[1]!);
    const boxes = elements.flatMap((e) => (e.scrollable && e.bounds ? [e.bounds] : []));
    if (!boxes.length) return elements.map(() => false);
    return elements.map((e) => {
        const b = e.bounds;
        if (!b) return false;
        const cx = (b[0] + b[2]) / 2;
        const cy = (b[1] + b[3]) / 2;
        return boxes.some((c) => c !== b && cx >= c[0] && cx <= c[2] && cy >= c[1] && cy <= c[3] && area(b) < area(c));
    });
}

/** The structural tokens of a screen (sorted, unique): what fingerprintOf hashes. Exported for tests and for explaining a merge. */
export function structureTokens(elements: ReadonlyArray<StructuralElement>, height?: number): string[] {
    const inside = scrollContent(elements);
    const h = height && height > 0 ? height : Math.max(0, ...elements.map((e) => e.bounds?.[3] ?? 0));
    const tokens = new Set<string>();
    elements.forEach((e, i) => {
        const sig = `${e.cls}|${e.id}`;
        if (inside[i]) {
            // List content: only the fields of a form that scrolls. A carousel inside a feed is content too (it comes and goes with scrolling).
            if (e.editable || e.password) tokens.add(`F:${sig}`);
            return;
        }
        if (e.editable || e.password) return void tokens.add(`F:${sig}`);
        if (e.scrollable) return void tokens.add(`S:${sig}`);
        // A search box that is a button shows what was searched or whose page this is ("Alice Smith" on a profile): its words do not count.
        if (e.clickable || e.longClickable || e.checkable) return void tokens.add(`B:${sig}:${/search/i.test(e.id) ? "" : staticLabel(e.text || e.desc)}${e.selected && !e.checkable ? ":selected" : ""}`);
        const heading = HEADING_ID.test(e.id) || (e.bounds !== undefined && h > 0 && e.bounds[3] <= h * TOP_BAND && (e.text || e.desc).trim().length <= 40);
        if (heading) return void tokens.add(`T:${sig}:${staticLabel(e.text || e.desc)}`);
        if (e.id) tokens.add(`V:${sig}`);
    });
    return [...tokens].sort();
}

/**
 * The STRUCTURAL fingerprint of a screen (see above): equal for the same screen whatever it currently shows in its lists and counters, different
 * for another screen. `height` is the screen's height (the heading band); without it the lowest element's bottom edge is used.
 */
export function fingerprintOf(pkg: string, activity: string | undefined, elements: ReadonlyArray<StructuralElement>, height?: number): string {
    return createHash("sha256").update(`${pkg}\n${activity ?? ""}\n${structureTokens(elements, height).join("\n")}`).digest("hex").slice(0, 16);
}

/** The fingerprint WITH text (the earlier definition): package, activity and everything that is not being typed into, texts included. */
export function textFingerprintOf(pkg: string, activity: string | undefined, elements: ReadonlyArray<Pick<ScreenElement, "id" | "text" | "desc" | "cls" | "editable" | "password">>): string {
    const lines = elements.filter((e) => !e.editable && !e.password).map((e) => `${e.id}|${e.text}|${e.desc}|${e.cls}`);
    lines.sort();
    return createHash("sha256").update(`${pkg}\n${activity ?? ""}\n${lines.join("\n")}`).digest("hex").slice(0, 16);
}

export function parseHierarchy(xmlRaw: string, ctx: ParseContext): ParseResult {
    if (typeof xmlRaw !== "string" || xmlRaw.length === 0) return { ok: false, error: SCREEN_UNREADABLE };
    if (Buffer.byteLength(xmlRaw, "utf8") > HIERARCHY_LIMITS.maxXmlBytes) return { ok: false, error: SCREEN_TOO_LARGE };
    // `uiautomator dump` prints a line after the document ("UI hierchary dumped to: /dev/tty"); only the document is read.
    const start = xmlRaw.indexOf("<?xml") >= 0 ? xmlRaw.indexOf("<?xml") : xmlRaw.indexOf("<hierarchy");
    const endTag = xmlRaw.lastIndexOf("</hierarchy>");
    const selfClosed = /<hierarchy[^>]*\/>/.test(xmlRaw);
    if (start < 0 || (endTag < 0 && !selfClosed)) return { ok: false, error: SCREEN_UNREADABLE };
    const xml = selfClosed && endTag < 0 ? xmlRaw.slice(start) : xmlRaw.slice(start, endTag + "</hierarchy>".length);

    const scanned = scan(xml);
    if (typeof scanned === "string") return { ok: false, error: scanned };
    const { nodes, windows } = scanned;

    // The foreground window is the largest top-level one; the status bar and other small windows are not the screen.
    let main = -1;
    let best = -1;
    windows.forEach((w, i) => {
        if (w.area > best) {
            best = w.area;
            main = i;
        }
    });
    const windowPkg = (idx: number): string => {
        const own = windows[idx]?.pkg;
        if (own) return own;
        return nodes.find((n) => n.top === idx && n.attrs.get("package"))?.attrs.get("package") ?? "";
    };
    const pkg = cleanText(main >= 0 ? windowPkg(main) : "", 200);

    let width = 0;
    let height = 0;
    const candidates: Array<{ el: Omit<ScreenElement, "index">; score: number; order: number }> = [];
    // Added by PLAN (R24): the ancestors' ids and scrolling, read in document order (each node's ancestors are the last nodes seen at smaller depths).
    const idAt: string[] = [];
    const scrollAt: boolean[] = [];
    for (const n of nodes) {
        const a = n.attrs;
        idAt.length = n.depth;
        scrollAt.length = n.depth;
        const scopes = idAt.filter((x) => Boolean(x)).slice(-6);
        const inScroll = scrollAt.some(Boolean);
        const rawId = decodeEntities(a.get("resource-id") ?? "");
        idAt[n.depth] = shortId(rawId);
        scrollAt[n.depth] = flag(a, "scrollable");
        const b = boundsOf(a.get("bounds"));
        if (!b) continue;
        if (n.depth === 0 && n.top === main) {
            width = Math.max(width, b[2]);
            height = Math.max(height, b[3]);
        }
        if (n.top !== main) continue;
        // The status bar and navigation bar are drawn by the system inside the same window list on some versions: not part of the app's screen.
        const nodePkg = a.get("package") ?? "";
        if (nodePkg && pkg !== nodePkg && nodePkg === "com.android.systemui") continue;
        if (b[2] - b[0] <= 0 || b[3] - b[1] <= 0) continue;
        width = Math.max(width, b[2]);
        height = Math.max(height, b[3]);

        const cls = shortClass(a.get("class") ?? "");
        const password = flag(a, "password");
        const clickable = flag(a, "clickable");
        const longClickable = flag(a, "long-clickable");
        const scrollable = flag(a, "scrollable");
        const checkable = flag(a, "checkable");
        const editable = EDITABLE_CLASSES.has(cls) || password;
        // A password field's text is the dots the app draws, or in a few apps the password itself: it is never read.
        const text = password ? "" : cleanText(decodeEntities(a.get("text") ?? ""));
        const desc = cleanText(decodeEntities(a.get("content-desc") ?? ""));
        const id = shortId(decodeEntities(a.get("resource-id") ?? ""));
        const interactive = clickable || longClickable || scrollable || editable || checkable;
        if (!interactive && !text && !desc && (!id || isLayoutClass(cls))) continue;
        if (!interactive && isLayoutClass(cls) && !text && !desc) continue;
        candidates.push({
            el: {
                cls,
                text,
                desc,
                id,
                clickable,
                longClickable,
                scrollable,
                editable,
                password,
                checkable,
                checked: flag(a, "checked"),
                enabled: a.get("enabled") !== "false",
                focused: flag(a, "focused"),
                bounds: b,
                ...(scopes.length ? { scopes } : {}),
                ...(inScroll ? { inScroll: true as const } : {}),
                ...(flag(a, "selected") ? { selected: true as const } : {}),
                ...(id && !rawId.includes(":id/") ? { bareId: true as const } : {}),
            },
            score: interactive ? 2 : text || desc ? 1 : 0,
            order: n.order,
        });
    }

    let kept = candidates;
    if (kept.length > HIERARCHY_LIMITS.maxElements) {
        // Too many to list: keep what can be touched first, then what can be read.
        kept = [...kept].sort((x, y) => y.score - x.score || x.order - y.order).slice(0, HIERARCHY_LIMITS.maxElements);
    }
    kept.sort((x, y) => x.el.bounds[1] - y.el.bounds[1] || x.el.bounds[0] - y.el.bounds[0] || x.order - y.order);
    const elements: ScreenElement[] = kept.map((c, index) => ({ index, ...c.el }));

    const appPackage = ctx.appPackage;
    const outsideApp = (appPackage !== "" && pkg !== appPackage) || SYSTEM_DIALOG_PACKAGES.has(pkg);
    const activity = ctx.activity ? cleanText(ctx.activity, 200) : undefined;
    return {
        ok: true,
        snapshot: {
            package: pkg,
            ...(activity ? { activity } : {}),
            width,
            height,
            elements,
            fingerprint: fingerprintOf(pkg, activity, elements, height),
            textFingerprint: textFingerprintOf(pkg, activity, elements),
            keyboard: ctx.keyboard === true,
            outsideApp,
        },
    };
}

/** Pulls the activity out of `dumpsys window` ("mCurrentFocus=Window{… u0 com.example/com.example.MainActivity}"), or undefined. */
export function activityFromWindowDump(text: string): { package: string; activity: string } | undefined {
    const m = /mCurrentFocus=Window\{[^}\n]*?\s([A-Za-z][\w.]*)\/([A-Za-z][\w.$]*)\}/.exec(text) ?? /mFocusedApp=.*?\s([A-Za-z][\w.]*)\/([A-Za-z.][\w.$]*)\s/.exec(text);
    return m ? { package: m[1]!, activity: m[2]!.startsWith(".") ? `${m[1]}${m[2]}` : m[2]! } : undefined;
}

/**
 * True when `dumpsys window` says the lock screen is actually in front. A keyguard flag alone is not enough: some emulator images leave
 * `isKeyguardShowing=true` (and `mDreamingLockscreen=true`) set even on the home screen, where the launcher and apps are fully usable. So a
 * keyguard flag counts as locked only when the keyguard/shade is the focused window, or nothing normal is focused — not when a launcher or an
 * app is in front. On a genuinely locked phone the focus is a keyguard/status-bar window or null, so that case still reads as locked.
 */
export function isLockedFromWindowDump(text: string): boolean {
    if (!/isKeyguardShowing=true|mShowingLockscreen=true|mDreamingLockscreen=true|KeyguardShowing=true/.test(text)) return false;
    const focus = `${/mCurrentFocus=[^\n]*/.exec(text)?.[0] ?? ""} ${/mFocusedApp=[^\n]*/.exec(text)?.[0] ?? ""}`;
    if (/Keyguard|NotificationShade|StatusBar|DreamActivity|ScreenDecor/i.test(focus)) return true; // the lock screen / shade is in front
    if (/ActivityRecord\{[^}]*\/[^}]*\}|Window\{[^}]*\/[^}]*\}/.test(focus)) return false; // a launcher or an app is focused → usable
    return true; // nothing clearly in focus with the keyguard flag set: treat it as blocking
}

/** True when `dumpsys input_method` says the on-screen keyboard is showing. */
export function keyboardFromInputDump(text: string): boolean {
    return /mInputShown=true|mIsInputViewShown=true|isInputViewShown=true/.test(text);
}
