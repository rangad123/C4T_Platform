/**
 * Picks the one element on the page that a missing locator most likely meant: same role and a similar name, same test id,
 * same label / placeholder / text. Pure functions over `Candidate` records, so every rule is covered by plain unit tests.
 *
 * The rule that keeps this honest: only ONE candidate may score above the threshold. Two similar buttons (two "Add to
 * basket" buttons, "Add to cart" next to "Add to wishlist") mean we would be guessing, so nothing is proposed.
 */
import type { Locator, Step } from "../spec/schema.js";
import type { Candidate } from "./candidates.js";
import { nameSimilarity, normalise, type SimilarityKind } from "./similarity.js";

/** A candidate must score at least this to be proposed. */
export const PROPOSE_THRESHOLD = 0.75;

export type Confidence = "high" | "medium" | "low";
export const confidenceLabel = (score: number): Confidence => (score >= 0.9 ? "high" : score >= 0.8 ? "medium" : "low");

export interface Scored {
    cand: Candidate;
    score: number;
    kind: SimilarityKind;
    /** Which property matched, in words: "name", "text", "label", "hint", "test id", "attributes". */
    matched: string;
}

const none = { score: 0, kind: "none" as SimilarityKind };

/** Pieces of a CSS selector's last part that carry meaning: tag, id, classes and attribute values. */
export function cssTokens(selector: string): { tag?: string; words: string[] } {
    const last = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(last)?.[0]?.toLowerCase();
    const words: string[] = [];
    for (const m of last.matchAll(/[#.]([\w-]+)/g)) words.push(m[1]!);
    for (const m of last.matchAll(/\[\s*[\w-]+\s*[~|^$*]?=\s*["']?([^"'\]]+)["']?\s*\]/g)) words.push(m[1]!);
    return { tag, words };
}

/** How well one candidate matches the old locator's intent (0 = not at all). */
export function scoreCandidate(old: Locator, cand: Candidate): Scored | undefined {
    const value = old.value ?? "";
    let s: { score: number; kind: SimilarityKind } = none;
    let matched = "";
    switch (old.by) {
        case "role": {
            // A role locator without a name says nothing about which element was meant.
            if (!value || !old.role || cand.role !== old.role) return undefined;
            s = nameSimilarity(value, cand.name);
            matched = "name";
            break;
        }
        case "text": {
            if (!value || !cand.ownsText) return undefined;
            s = nameSimilarity(value, cand.text);
            matched = "text";
            break;
        }
        case "label": {
            if (!value || !cand.label) return undefined;
            s = nameSimilarity(value, cand.label);
            matched = "label";
            break;
        }
        case "placeholder": {
            if (!value || !cand.placeholder) return undefined;
            s = nameSimilarity(value, cand.placeholder);
            matched = "hint";
            break;
        }
        case "testId": {
            if (!value || !cand.testId) return undefined;
            s = nameSimilarity(value, cand.testId);
            matched = "test id";
            break;
        }
        case "css": {
            const { tag, words } = cssTokens(value);
            if (!words.length || (tag && cand.tag !== tag)) return undefined;
            const attrs = [cand.id, cand.testId, cand.nameAttr, ...cand.classes].filter((a): a is string => Boolean(a));
            // Every selector word must be matched by some attribute of the candidate.
            const each = words.map((w) => attrs.map((a) => nameSimilarity(w, a)).sort((x, y) => y.score - x.score)[0] ?? none);
            const worst = each.reduce((a, b) => (b.score < a.score ? b : a), each[0]!);
            s = worst;
            matched = "attributes";
            break;
        }
    }
    return s.score > 0 ? { cand, score: s.score, kind: s.kind, matched } : undefined;
}

/** Can the step's action work on this element? (A fill step cannot mean a button.) */
export function suitsAction(action: Step["action"], cand: Candidate): boolean {
    const fields = ["textbox", "searchbox", "combobox", "spinbutton", "slider"];
    switch (action) {
        case "fill":
            return fields.includes(cand.role ?? "") || cand.tag === "input" || cand.tag === "textarea";
        case "select":
            return cand.tag === "select" || cand.role === "combobox" || cand.role === "listbox";
        case "check":
            return ["checkbox", "radio", "switch"].includes(cand.role ?? "") || (cand.tag === "input" && ["checkbox", "radio"].includes(cand.type ?? ""));
        default:
            return true;
    }
}

export type Ranking =
    | { status: "unique"; best: Scored }
    | { status: "ambiguous"; options: Scored[] }
    | { status: "none"; closest?: Scored };

export function rank(old: Locator, action: Step["action"], candidates: Candidate[]): Ranking {
    const scored = candidates
        .filter((c) => suitsAction(action, c))
        .map((c) => scoreCandidate(old, c))
        .filter((s): s is Scored => Boolean(s))
        .sort((a, b) => b.score - a.score);
    const above = scored.filter((s) => s.score >= PROPOSE_THRESHOLD);
    if (above.length === 1) return { status: "unique", best: above[0]! };
    if (above.length > 1) return { status: "ambiguous", options: above.slice(0, 4) };
    return { status: "none", closest: scored[0] };
}

// ── plain-language wording ──────────────────────────────────────────────────

const ROLE_WORD: Record<string, string> = {
    button: "button", link: "link", textbox: "text field", searchbox: "search box", checkbox: "checkbox", radio: "option", combobox: "drop-down",
    heading: "heading", tab: "tab", menuitem: "menu item", switch: "switch", img: "image", listbox: "list", slider: "slider", spinbutton: "number field",
};
const quote = (s: string) => `“${s}”`;

/** "the “Add to cart” button", "the text “Welcome”", ... */
export function describeLocator(l: Locator): string {
    const v = l.value ?? "";
    switch (l.by) {
        case "role":
            return `the ${v ? quote(v) + " " : ""}${ROLE_WORD[l.role ?? ""] ?? l.role ?? "element"}`;
        case "text":
            return `the text ${quote(v)}`;
        case "label":
            return `the ${quote(v)} field`;
        case "placeholder":
            return `the field with the hint ${quote(v)}`;
        case "testId":
            return `the element marked ${quote(v)}`;
        case "css":
            return `the element matching ${quote(v)}`;
    }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Why a candidate was picked, for the person who has to approve it. */
export function whyPicked(old: Locator, s: Scored): string {
    const c = s.cand;
    const found = old.by === "testId" ? c.testId : old.by === "placeholder" ? c.placeholder : old.by === "label" ? c.label : old.by === "text" ? c.text : old.by === "css" ? [c.tag, c.id && `#${c.id}`, c.classes[0] && `.${c.classes[0]}`].filter(Boolean).join("") : c.name;
    const how = s.kind === "same" ? "reads the same" : s.kind === "synonym" ? "means the same thing" : `is close in wording (${Math.round(s.score * 100)}% alike)`;
    const noun = old.by === "role" ? `${ROLE_WORD[c.role ?? ""] ?? "element"} ` : old.by === "css" ? "element " : "";
    return `${cap(describeLocator(old))} is no longer on the page. The only close match is the ${noun}${quote(found ?? "")}, which ${how}.`;
}
