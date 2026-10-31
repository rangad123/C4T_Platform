/**
 * The explorer's view into frames (iframes): the interactive elements of the frames on a page, each with the frame chain a step needs to reach it.
 * Bounded on purpose: at most MAX_FRAMES frames per page, MAX_FRAME_DEPTH deep, MAX_PER_FRAME elements each, and a short time limit per frame
 * (a frame that does not answer is skipped). A frame with no name, title or address cannot be found again by a test and is skipped too.
 */
import type { Frame, Page } from "playwright";
import { MAX_FRAME_DEPTH, type FrameRef } from "../spec/schema.js";
import { describeFrame, frameSelector } from "./pages.js";

export const FRAME_READ_LIMITS = { frames: 5, perFrame: 30, timeoutMs: 2_000 } as const;

export interface FrameComponent {
    role: string;
    name: string;
    locatorHint: string;
    frame: FrameRef[];
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/** The chain of frames from the page down to `frame` (outermost first), or undefined when one of them cannot be named or it is too deep. */
export async function frameChainOf(frame: Frame): Promise<FrameRef[] | undefined> {
    const chain: FrameRef[] = [];
    let f: Frame | null = frame;
    while (f && f.parentFrame()) {
        const el = await within(f.frameElement(), FRAME_READ_LIMITS.timeoutMs);
        if (!el) return undefined;
        const attrs = await within(el.evaluate((e) => ({ name: (e as Element).getAttribute("name"), title: (e as Element).getAttribute("title"), src: (e as Element).getAttribute("src") })), FRAME_READ_LIMITS.timeoutMs);
        await el.dispose().catch(() => undefined);
        const ref = attrs ? describeFrame(attrs) : undefined;
        if (!ref) return undefined;
        chain.unshift(ref);
        if (chain.length > MAX_FRAME_DEPTH) return undefined;
        f = f.parentFrame();
    }
    return chain;
}

const hintFor = (chain: FrameRef[], role: string, name: string): string => {
    const root = chain.map((f) => `.frameLocator(${JSON.stringify(frameSelector(f))})`).join("");
    const n = JSON.stringify(name);
    return ["button", "link", "checkbox", "radio", "tab", "menuitem", "heading", "textbox", "combobox"].includes(role) ? `page${root}.getByRole(${JSON.stringify(role)}, { name: ${n} })` : `page${root}.getByText(${n})`;
};

/** The interactive elements inside the page's frames (none for a page without frames). Never throws. */
export async function readFrameElements(page: Page): Promise<FrameComponent[]> {
    const out: FrameComponent[] = [];
    const frames = page.frames().filter((f) => f !== page.mainFrame() && !f.isDetached()).slice(0, FRAME_READ_LIMITS.frames);
    for (const frame of frames) {
        const chain = await frameChainOf(frame).catch(() => undefined);
        if (!chain?.length) continue;
        const found = await within(
            frame.evaluate((max) => {
                const items: Array<{ role: string; name: string }> = [];
                const seen = new Set<string>();
                const roleOf = (el: Element): string => {
                    const r = el.getAttribute("role");
                    if (r) return r.split(/\s+/)[0]!;
                    const t = el.tagName.toLowerCase();
                    if (t === "a") return "link";
                    if (t === "button") return "button";
                    if (t === "select") return "combobox";
                    if (t === "textarea") return "textbox";
                    if (t === "input") {
                        const ty = (el.getAttribute("type") || "text").toLowerCase();
                        return ty === "checkbox" ? "checkbox" : ty === "radio" ? "radio" : ty === "submit" || ty === "button" ? "button" : "textbox";
                    }
                    return t;
                };
                for (const el of Array.from(document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role="button"], [role="link"], [role="tab"]'))) {
                    const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
                    const name = (el.getAttribute("aria-label") ?? labelled ?? el.getAttribute("placeholder") ?? (el as HTMLElement).innerText ?? (el as HTMLInputElement).value ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
                    if (!name || seen.has(name)) continue;
                    seen.add(name);
                    items.push({ role: roleOf(el), name });
                    if (items.length >= max) break;
                }
                return items;
            }, FRAME_READ_LIMITS.perFrame),
            FRAME_READ_LIMITS.timeoutMs,
        );
        for (const c of found ?? []) out.push({ role: c.role, name: c.name, locatorHint: hintFor(chain, c.role, c.name), frame: chain });
    }
    return out;
}
