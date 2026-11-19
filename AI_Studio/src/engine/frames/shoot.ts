/**
 * Taking the picture for the Explorer view (the part that touches a browser).
 *
 * Order matters: secret fields are covered first, the picture is taken, and the cover is taken off again in a `finally`, so a failed picture never leaves
 * the page changed. A field is covered when it is secret by the recorder's own rule (`secretKindOfField` in recorder/act.ts, which mirrors the recorder's
 * page script and is kept in step with it by a test), or when its name, id, aria-label, title, placeholder or label text names it like a secret
 * field (shared/secret-field.ts: a password shown as text, a PIN, a token, an API key, also in other languages; CP3 N-6, CP3b R-7). The rule is
 * applied to every input, text area and editable element (`contenteditable`) in the page, in its frames and inside open shadow roots. Besides those,
 * any field that currently holds one of the project's stored secrets is covered, wherever the AI typed it, and so is any element whose text shows
 * one (a stored secret printed as page text).
 *
 * A closed shadow root cannot be entered from the page, so what is inside one cannot be checked. The browser's own view of the document (CDP, with
 * shadow roots pierced) does show where one is: a page or frame holding a closed shadow root gets no picture at all, with the reason
 * UNCHECKED_PART (fail closed).
 *
 * The picture is scaled down by the browser itself (a clip with a scale), so a 1280 px page is never shipped at full size.
 */
import type { CDPSession, Frame, Page } from "playwright";
import { secretKindOfField, type FieldFacts } from "../recorder/act.js";
import { namesSecretField } from "../../shared/secret-field.js";
import { safeAddress } from "./activity.js";

export const FRAME_LIMITS = {
    /** Pictures are never wider than this (CSS pixels); a smaller page is not enlarged. */
    maxWidth: 640,
    /** A JPEG larger than this is retried at lower quality and then dropped. */
    maxBytes: 120 * 1024,
    /** No more often than this. */
    minGapMs: 1000,
    /** JPEG quality to try, best first. */
    qualities: [55, 40, 28] as readonly number[],
} as const;

export interface Shot {
    jpeg: Uint8Array;
    url: string;
    title: string;
}

/** The attribute a covered field carries while the picture is taken (it is gone again afterwards). */
export const MASK_ATTR = "data-aitp-xmask";
/** Why no picture is taken of a page with a part the cover cannot look into (a closed shadow root). */
export const UNCHECKED_PART = "a part of the page could not be checked for secrets";
/** The elements the cover looks at as fields: inputs, text areas and editable elements. */
const FIELD_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
const MAX_FRAMES = 12;
const MAX_FIELDS = 300;

// ── pure decisions ──────────────────────────────────────────────────────────

/** How much to shrink a page that is `width` CSS pixels wide: never enlarge, never wider than the limit. */
export function frameScale(width: number, maxWidth: number = FRAME_LIMITS.maxWidth): number {
    if (!Number.isFinite(width) || width <= 0) return 1;
    return Math.min(1, maxWidth / width);
}

/** The first candidate (best quality first) that fits the byte cap; null when none does. */
export async function firstThatFits(qualities: readonly number[], take: (quality: number) => Promise<Uint8Array | null>, maxBytes: number = FRAME_LIMITS.maxBytes): Promise<Uint8Array | null> {
    for (const q of qualities) {
        const bytes = await take(q);
        if (bytes && bytes.byteLength <= maxBytes) return bytes;
    }
    return null;
}

/** What the cover reads of one field: the recorder's facts, its title, and whether it holds a stored secret. */
export type CoverFacts = FieldFacts & { title?: string; holdsSecret?: boolean };

/** Which of a page's fields to cover: secret by kind, named like a secret field (by name, id, aria-label, title, placeholder or label), or currently holding a stored secret. */
export function fieldsToCover(fields: ReadonlyArray<CoverFacts>): number[] {
    const out: number[] = [];
    fields.forEach((f, i) => {
        if (f.holdsSecret || secretKindOfField(f) !== "" || namesSecretField(f.name, f.id, f.ariaLabel, f.title, f.placeholder, f.label)) out.push(i);
    });
    return out;
}

// The fields are walked in the page the same way by each evaluate below (spelled out in each, since a function cannot be passed into
// the page, and building one there would fail on a page whose content security policy forbids eval): inputs, text areas and editable
// elements (FIELD_SELECTOR) in document order, each open shadow root's after its host, at most MAX_FIELDS, so the indexes of reading and
// covering agree.
// The page-side code declares no helper function of its own (no `const f = () => …`, no `function f`): the platform and the runner
// load the engine through tsx, which keeps function names by wrapping each such helper in a `__name(…)` call the page does not have
// (tests/page-scripts-under-tsx.test.ts). Loops and inline callbacks only.

// ── covering secret fields ──────────────────────────────────────────────────

const COVER = "#475569";

/** What the page tells about each input (never its value: whether it holds a stored secret is worked out inside the page). */
async function readFields(frame: Frame, secrets: readonly string[]): Promise<Array<CoverFacts & { holdsSecret: boolean }>> {
    return frame.evaluate(
        ([max, stored, selector]) => {
            const held = stored as string[];
            // The field walk (see above).
            const els: HTMLElement[] = [];
            const stack: Element[] = Array.from(document.querySelectorAll("*")).reverse();
            while (stack.length && els.length < (max as number)) {
                const el = stack.pop()!;
                if (el.matches(selector as string)) els.push(el as HTMLElement);
                if (el.shadowRoot) stack.push(...Array.from(el.shadowRoot.querySelectorAll("*")).reverse());
            }
            return els.map((el) => {
                const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : undefined;
                // An editable element's value is its text.
                const v = field ? (field.value ?? "") : (el.textContent ?? "");
                const root = el.getRootNode() as Document | ShadowRoot;
                const by = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id) ?? null);
                const label = [...Array.from(field?.labels ?? []), ...by]
                    .map((e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200))
                    .join(" ")
                    .slice(0, 400);
                return {
                    tag: el.tagName.toLowerCase(),
                    type: el instanceof HTMLInputElement ? el.type : "",
                    autocomplete: el.getAttribute("autocomplete") ?? "",
                    name: el.getAttribute("name") ?? "",
                    id: el.id ?? "",
                    ariaLabel: el.getAttribute("aria-label") ?? "",
                    title: el.getAttribute("title") ?? "",
                    placeholder: el.getAttribute("placeholder") ?? "",
                    label,
                    // A short secret must match the whole value (a part of an ordinary word is not a secret); a long one may sit inside it.
                    holdsSecret: v !== "" && held.some((s) => (s.length < 4 ? v === s : v.includes(s))),
                };
            });
        },
        [MAX_FIELDS, secrets as string[], FIELD_SELECTOR] as [number, string[], string],
    );
}

async function coverIn(frame: Frame, secrets: readonly string[]): Promise<void> {
    const fields = await readFields(frame, secrets);
    const which = fieldsToCover(fields);
    // A stored secret shown as text is looked for only when there is one long enough to find (a short one would match ordinary text).
    const shown = secrets.filter((s) => s.length >= 4);
    if (!which.length && !shown.length) return;
    await frame.evaluate(
        ([attr, color, idx, max, selector, stored]) => {
            // The field walk (see above).
            const els: HTMLElement[] = [];
            const stack: Element[] = Array.from(document.querySelectorAll("*")).reverse();
            while (stack.length && els.length < (max as number)) {
                const el = stack.pop()!;
                if (el.matches(selector as string)) els.push(el as HTMLElement);
                if (el.shadowRoot) stack.push(...Array.from(el.shadowRoot.querySelectorAll("*")).reverse());
            }
            // The elements whose text shows a stored secret, from the top down (each open shadow root's after its host): an element with
            // a text of its own holding one, or whose secret is split over its children (no single child holds it whole). Its children
            // that hold one are looked at too, so a child with its own colour is covered as well.
            const secretList = stored as string[];
            const texts: HTMLElement[] = [];
            const down: Element[] = secretList.length ? [document.documentElement] : [];
            while (down.length) {
                const el = down.pop()!;
                if (el.shadowRoot) down.push(...Array.from(el.shadowRoot.children));
                const all = el.textContent ?? "";
                if (!secretList.some((s) => all.includes(s))) continue;
                const kids = Array.from(el.children).filter((c) => secretList.some((s) => (c.textContent ?? "").includes(s)));
                const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && secretList.some((s) => (n.textContent ?? "").includes(s)));
                if (own || !kids.length) texts.push(el as HTMLElement);
                down.push(...kids);
            }
            const w = window as unknown as { __aitpMasked?: Array<{ el: HTMLElement; style: string | null }>; __aitpMaskStyle?: HTMLStyleElement };
            w.__aitpMasked = w.__aitpMasked ?? [];
            if (!w.__aitpMaskStyle) {
                const s = document.createElement("style");
                s.textContent = `[${attr}]::placeholder{color:transparent !important;-webkit-text-fill-color:transparent !important}[${attr}]:-webkit-autofill{-webkit-box-shadow:0 0 0 1000px ${color} inset !important;-webkit-text-fill-color:transparent !important}`;
                document.documentElement.appendChild(s);
                w.__aitpMaskStyle = s;
            }
            for (const el of [...(idx as number[]).map((i) => els[i]), ...texts]) {
                if (!el || el.hasAttribute(attr as string)) continue;
                w.__aitpMasked.push({ el, style: el.getAttribute("style") });
                el.setAttribute(attr as string, "1");
                // Inline and important, so a page's own rules cannot show the text again.
                for (const [prop, val] of [["background", color], ["background-image", "none"], ["color", "transparent"], ["-webkit-text-fill-color", "transparent"], ["text-shadow", "none"], ["caret-color", "transparent"], ["border-color", color], ["box-shadow", "none"]] as const) {
                    el.style.setProperty(prop, val as string, "important");
                }
            }
        },
        [MASK_ATTR, COVER, which, MAX_FIELDS, FIELD_SELECTOR, shown] as [string, string, number[], number, string, string[]],
    );
}

async function uncoverIn(frame: Frame): Promise<void> {
    await frame.evaluate((attr) => {
        const w = window as unknown as { __aitpMasked?: Array<{ el: HTMLElement; style: string | null }>; __aitpMaskStyle?: HTMLStyleElement };
        for (const m of w.__aitpMasked ?? []) {
            if (m.style === null) m.el.removeAttribute("style");
            else m.el.setAttribute("style", m.style);
            m.el.removeAttribute(attr);
        }
        w.__aitpMasked = [];
        w.__aitpMaskStyle?.remove();
        w.__aitpMaskStyle = undefined;
        // Belt and braces: nothing carrying the marker is left behind, in open shadow roots either.
        const stack: Element[] = Array.from(document.querySelectorAll("*"));
        while (stack.length) {
            const el = stack.pop()!;
            if (el.hasAttribute(attr)) el.removeAttribute(attr);
            if (el.shadowRoot) stack.push(...Array.from(el.shadowRoot.querySelectorAll("*")));
        }
    }, MASK_ATTR);
}

/** One node of the browser's own view of a document (CDP DOM.Node), as far as the closed-root check reads it. */
interface DomNode {
    shadowRootType?: string;
    children?: DomNode[];
    shadowRoots?: DomNode[];
    contentDocument?: DomNode;
    templateContent?: DomNode;
}

/** Whether a document, with its shadow roots and same-process frames pierced, holds a closed shadow root. */
function holdsClosedRoot(root: DomNode): boolean {
    const stack: DomNode[] = [root];
    while (stack.length) {
        const n = stack.pop()!;
        if (n.shadowRootType === "closed") return true;
        stack.push(...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : []));
    }
    return false;
}

/**
 * Whether the page, or one of its frames, holds a closed shadow root: read from the browser (CDP DOM.getDocument with shadow roots and
 * frames pierced), since the page itself cannot see one. A frame in its own process (another site) has its own session and is read
 * there; any other failure to read counts as holding one.
 */
async function hasClosedShadowRoot(page: Page): Promise<boolean> {
    const own: CDPSession[] = [];
    try {
        const sessions: CDPSession[] = [await sessionFor(page)];
        for (const f of page.frames()) {
            if (f === page.mainFrame()) continue;
            try {
                const s = await page.context().newCDPSession(f);
                own.push(s);
                sessions.push(s);
            } catch (e) {
                // Playwright's answer for a frame that is part of its parent's session (read with the page).
                if (!/separate CDP session/i.test(String((e as Error)?.message ?? e))) throw e;
            }
        }
        for (const s of sessions) {
            const { root } = (await s.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
            await s.send("DOM.disable").catch(() => undefined);
            if (holdsClosedRoot(root)) return true;
        }
        return false;
    } finally {
        for (const s of own) await s.detach().catch(() => undefined);
    }
}

/**
 * Covers the secret fields of the page and its frames; the returned function takes the cover off again (call it in a `finally`).
 * Fails closed: if a frame that is still there cannot be covered (or there are more frames than are looked at), or a part of the page
 * cannot be looked into (a closed shadow root: the error says UNCHECKED_PART), nothing is returned and no picture is taken.
 */
export async function coverSecretFields(page: Page, secrets: readonly string[]): Promise<() => Promise<void>> {
    if (await hasClosedShadowRoot(page)) throw new Error(UNCHECKED_PART);
    const all = page.frames();
    const touched: Frame[] = [];
    const release = async () => {
        for (const f of touched) await uncoverIn(f).catch(() => undefined);
    };
    try {
        if (all.length > MAX_FRAMES) throw new Error("too many frames to cover");
        for (const f of all) {
            touched.push(f);
            try {
                await coverIn(f, secrets);
            } catch (e) {
                // A frame that went away while we looked has nothing to cover; any other failure means a secret might show.
                if (!f.isDetached()) throw e;
            }
        }
    } catch (e) {
        await release();
        throw e;
    }
    return release;
}

// ── the picture ─────────────────────────────────────────────────────────────

const sessions = new WeakMap<Page, Promise<CDPSession>>();
function sessionFor(page: Page): Promise<CDPSession> {
    let s = sessions.get(page);
    if (!s) {
        s = page.context().newCDPSession(page);
        sessions.set(page, s);
        s.catch(() => sessions.delete(page));
    }
    return s;
}

/** How wide, how large and at which qualities a picture is taken (the Explorer view's FRAME_LIMITS, or THUMBNAIL_LIMITS). */
export interface ShotLimits {
    maxWidth: number;
    maxBytes: number;
    qualities: readonly number[];
}

/**
 * A page thumbnail kept with an exploration (sheet #8, "Keep page thumbnails"): 320 px wide at most and at most 40 KB, with the same covering
 * as the Explorer view's pictures.
 */
export const THUMBNAIL_LIMITS: ShotLimits = { maxWidth: 320, maxBytes: 40 * 1024, qualities: [50, 36, 24] };

async function captureScaled(page: Page, limits: ShotLimits = FRAME_LIMITS): Promise<Uint8Array | null> {
    try {
        const cdp = await sessionFor(page);
        const m = (await cdp.send("Page.getLayoutMetrics")) as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
        const v = m.cssVisualViewport;
        const scale = frameScale(v.clientWidth, limits.maxWidth);
        return await firstThatFits(limits.qualities, async (quality) => {
            const r = (await cdp.send("Page.captureScreenshot", {
                format: "jpeg",
                quality,
                fromSurface: true,
                captureBeyondViewport: false,
                clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale },
            })) as { data: string };
            return Buffer.from(r.data, "base64");
        }, limits.maxBytes);
    } catch {
        sessions.delete(page);
        return null;
    }
}

/** A covered, scaled-down picture of the page, or null when none could be taken within the size cap. */
export async function shootPage(page: Page, secrets: readonly string[] = [], limits: ShotLimits = FRAME_LIMITS): Promise<Shot | null> {
    if (page.isClosed()) return null;
    let uncover: (() => Promise<void>) | undefined;
    try {
        // Not covered means not shown: a failure here ends in no picture at all.
        uncover = await coverSecretFields(page, secrets).catch(() => undefined);
        if (!uncover) return null;
        const jpeg = await captureScaled(page, limits);
        if (!jpeg) return null;
        const title = (await page.title().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
        return { jpeg, url: safeAddress(page.url()), title };
    } finally {
        await uncover?.().catch(() => undefined);
    }
}
