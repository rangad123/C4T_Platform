/**
 * Taking the picture for the Explorer view (the part that touches a browser).
 *
 * Order matters: secret fields are covered first, the picture is taken, and the cover is taken off again in a `finally`, so a failed picture never leaves
 * the page changed. Which fields are secret is decided by the recorder's own rule (`secretKindOfField` in recorder/act.ts, which mirrors the recorder's
 * page script and is kept in step with it by a test), applied to the facts of every input in the page and in its frames. Besides the fields that are
 * secret by kind, any field that currently holds one of the project's stored secrets is covered, wherever the AI typed it.
 *
 * The picture is scaled down by the browser itself (a clip with a scale), so a 1280 px page is never shipped at full size.
 */
import type { CDPSession, Frame, Page } from "playwright";
import { secretKindOfField, type FieldFacts } from "../recorder/act.js";
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

/** Which of a page's inputs to cover: secret by kind, or currently holding a stored secret. */
export function fieldsToCover(fields: ReadonlyArray<FieldFacts & { holdsSecret?: boolean }>): number[] {
    const out: number[] = [];
    fields.forEach((f, i) => {
        if (f.holdsSecret || secretKindOfField(f) !== "") out.push(i);
    });
    return out;
}

// ── covering secret fields ──────────────────────────────────────────────────

const COVER = "#475569";

/** What the page tells about each input (never its value: whether it holds a stored secret is worked out inside the page). */
async function readFields(frame: Frame, secrets: readonly string[]): Promise<Array<FieldFacts & { holdsSecret: boolean }>> {
    return frame.evaluate(
        ([max, stored]) => {
            const held = stored as string[];
            const els = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).slice(0, max as number);
            return els.map((el) => {
                const v = el.value ?? "";
                return {
                    tag: el.tagName.toLowerCase(),
                    type: el instanceof HTMLInputElement ? el.type : "",
                    autocomplete: el.getAttribute("autocomplete") ?? "",
                    name: el.getAttribute("name") ?? "",
                    id: el.id ?? "",
                    ariaLabel: el.getAttribute("aria-label") ?? "",
                    placeholder: el.getAttribute("placeholder") ?? "",
                    // A short secret must match the whole value (a part of an ordinary word is not a secret); a long one may sit inside it.
                    holdsSecret: v !== "" && held.some((s) => (s.length < 4 ? v === s : v.includes(s))),
                };
            });
        },
        [MAX_FIELDS, secrets as string[]] as [number, string[]],
    );
}

async function coverIn(frame: Frame, secrets: readonly string[]): Promise<void> {
    const fields = await readFields(frame, secrets);
    const which = fieldsToCover(fields);
    if (!which.length) return;
    await frame.evaluate(
        ([attr, color, idx]) => {
            const els = Array.from(document.querySelectorAll<HTMLElement>("input, textarea"));
            const w = window as unknown as { __aitpMasked?: Array<{ el: HTMLElement; style: string | null }>; __aitpMaskStyle?: HTMLStyleElement };
            w.__aitpMasked = w.__aitpMasked ?? [];
            if (!w.__aitpMaskStyle) {
                const s = document.createElement("style");
                s.textContent = `[${attr}]::placeholder{color:transparent !important;-webkit-text-fill-color:transparent !important}[${attr}]:-webkit-autofill{-webkit-box-shadow:0 0 0 1000px ${color} inset !important;-webkit-text-fill-color:transparent !important}`;
                document.documentElement.appendChild(s);
                w.__aitpMaskStyle = s;
            }
            for (const i of idx as number[]) {
                const el = els[i];
                if (!el || el.hasAttribute(attr as string)) continue;
                w.__aitpMasked.push({ el, style: el.getAttribute("style") });
                el.setAttribute(attr as string, "1");
                // Inline and important, so a page's own rules cannot show the text again.
                for (const [prop, val] of [["background", color], ["background-image", "none"], ["color", "transparent"], ["-webkit-text-fill-color", "transparent"], ["text-shadow", "none"], ["caret-color", "transparent"], ["border-color", color], ["box-shadow", "none"]] as const) {
                    el.style.setProperty(prop, val as string, "important");
                }
            }
        },
        [MASK_ATTR, COVER, which] as [string, string, number[]],
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
        // Belt and braces: nothing carrying the marker is left behind.
        for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
    }, MASK_ATTR);
}

/**
 * Covers the secret fields of the page and its frames; the returned function takes the cover off again (call it in a `finally`).
 * Fails closed: if a frame that is still there cannot be covered (or there are more frames than are looked at), nothing is returned and no picture is taken.
 */
export async function coverSecretFields(page: Page, secrets: readonly string[]): Promise<() => Promise<void>> {
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

async function captureScaled(page: Page): Promise<Uint8Array | null> {
    try {
        const cdp = await sessionFor(page);
        const m = (await cdp.send("Page.getLayoutMetrics")) as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
        const v = m.cssVisualViewport;
        const scale = frameScale(v.clientWidth);
        return await firstThatFits(FRAME_LIMITS.qualities, async (quality) => {
            const r = (await cdp.send("Page.captureScreenshot", {
                format: "jpeg",
                quality,
                fromSurface: true,
                captureBeyondViewport: false,
                clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale },
            })) as { data: string };
            return Buffer.from(r.data, "base64");
        });
    } catch {
        sessions.delete(page);
        return null;
    }
}

/** A covered, scaled-down picture of the page, or null when none could be taken within the size cap. */
export async function shootPage(page: Page, secrets: readonly string[] = []): Promise<Shot | null> {
    if (page.isClosed()) return null;
    let uncover: (() => Promise<void>) | undefined;
    try {
        // Not covered means not shown: a failure here ends in no picture at all.
        uncover = await coverSecretFields(page, secrets).catch(() => undefined);
        if (!uncover) return null;
        const jpeg = await captureScaled(page);
        if (!jpeg) return null;
        const title = (await page.title().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
        return { jpeg, url: safeAddress(page.url()), title };
    } finally {
        await uncover?.().catch(() => undefined);
    }
}
