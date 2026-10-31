/**
 * Locator ranking: given the candidates the page found for one element (each with how many elements it finds, and whether the
 * recorded element is among them), pick the best unique one and keep a few alternatives.
 *
 * Order, best first: test id, role + accessible name, label, placeholder, text, css. A candidate is never used when its text is
 * long or looks generated (see `looksDynamic`), unless nothing else identifies the element (then `generated` says so).
 */
import { clip, looksDynamic, REC_LIMITS, REC_STRATEGIES, type RecAlternative, type RecLocator, type RecStrategy } from "./model.js";

export interface RawCandidate {
    strategy: RecStrategy;
    value: string;
    name?: string;
    exact?: boolean;
    /** How many elements this locator finds on the page. */
    matches: number;
    /** False when the element that was recorded is not among them (the candidate is then useless). Missing = not checked. */
    hit?: boolean;
}

export interface Ranked {
    chosen: RecLocator;
    matches: number;
    alternatives: RecAlternative[];
    /** The chosen locator looks generated and may not survive the next release. */
    generated: boolean;
    /** The chosen locator is a position in the page (no name, label or id to use). */
    positional: boolean;
}

const ORDER: Record<RecStrategy, number> = Object.fromEntries(REC_STRATEGIES.map((s, i) => [s, i])) as Record<RecStrategy, number>;
const POSITION = /:nth-(of-type|child)\(\d+\)/g;

const toLocator = (c: RawCandidate): RecLocator => ({
    strategy: c.strategy,
    value: c.value,
    ...(c.strategy === "role" && c.name !== undefined ? { name: c.name } : {}),
    ...(c.exact !== undefined ? { exact: c.exact } : {}),
});

/** Plain structural css: no id, name or attribute that identifies the element, only its place. */
export const isPositionalCss = (l: RecLocator): boolean => l.strategy === "css" && !/[#\[.]/.test(l.value);

export function validCandidate(c: RawCandidate): boolean {
    if (!c || typeof c.value !== "string" || !c.value || !Number.isFinite(c.matches) || !REC_STRATEGIES.includes(c.strategy)) return false;
    if (c.strategy === "role") return typeof c.name === "string" && c.name.length > 0 && c.name.length <= REC_LIMITS.maxLocatorText;
    if (c.strategy === "css") return c.value.length <= 300;
    if (c.strategy === "testId") return c.value.length <= 120;
    return c.value.length <= REC_LIMITS.maxLocatorText;
}

/** What a page may send is checked field by field: it is untrusted input. */
export function parseCands(x: unknown): RawCandidate[] {
    if (!Array.isArray(x)) return [];
    const out: RawCandidate[] = [];
    for (const c of x.slice(0, 40)) {
        if (!c || typeof c !== "object") continue;
        const o = c as Record<string, unknown>;
        if (!REC_STRATEGIES.includes(o.strategy as never) || typeof o.value !== "string" || typeof o.matches !== "number") continue;
        const cand: RawCandidate = {
            strategy: o.strategy as RawCandidate["strategy"],
            value: o.value,
            matches: Math.max(0, Math.floor(o.matches)),
            ...(typeof o.name === "string" ? { name: o.name } : {}),
            ...(typeof o.exact === "boolean" ? { exact: o.exact } : {}),
            ...(typeof o.hit === "boolean" ? { hit: o.hit } : {}),
        };
        if (validCandidate(cand)) out.push(cand);
    }
    return out;
}

/** True when a locator carries text that would not survive the next visit. */
export function locatorLooksGenerated(c: Pick<RawCandidate, "strategy" | "value" | "name">): boolean {
    const text = c.strategy === "css" ? c.value.replace(POSITION, "") : c.value;
    return looksDynamic(text) || (c.name !== undefined && looksDynamic(c.name));
}

export function rankCandidates(raw: RawCandidate[]): Ranked | undefined {
    const usable = raw.filter((c) => validCandidate(c) && c.hit !== false);
    const stable = usable.filter((c) => !locatorLooksGenerated(c));
    const byBest = (a: RawCandidate, b: RawCandidate) => Number(a.matches !== 1) - Number(b.matches !== 1) || ORDER[a.strategy] - ORDER[b.strategy];
    // Array.prototype.sort is stable: equal candidates keep the order the page gave them (for example #id before a position).
    const ordered = [...stable].sort((a, b) => ORDER[a.strategy] - ORDER[b.strategy]);
    let chosen = ordered.find((c) => c.matches === 1);
    let generated = false;
    if (!chosen) {
        const fallback = usable.filter((c) => c.matches === 1).sort((a, b) => ORDER[a.strategy] - ORDER[b.strategy])[0];
        if (fallback) {
            chosen = fallback;
            generated = true;
        } else chosen = [...stable].sort((a, b) => a.matches - b.matches || ORDER[a.strategy] - ORDER[b.strategy]).find((c) => c.matches > 0);
    }
    if (!chosen) return undefined;
    const alternatives = [...stable]
        .filter((c) => c !== chosen)
        .sort(byBest)
        .slice(0, REC_LIMITS.maxAlternatives)
        .map((c) => ({ locator: toLocator(c), matches: c.matches }));
    const locator = toLocator(chosen);
    return { chosen: locator, matches: chosen.matches, alternatives, generated, positional: isPositionalCss(locator) };
}

/** Clip long page text so it never reaches a locator or a sentence in full. */
export const shortText = (s: string, max: number = REC_LIMITS.maxLocatorText): string => clip(s.replace(/\s+/g, " ").trim(), max);
