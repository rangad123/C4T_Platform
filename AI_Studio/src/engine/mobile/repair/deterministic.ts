/**
 * Repair without AI for phone tests: before the model is asked which element of the screen a missing locator meant, the same plain rules
 * as for web tests (../../healing/deterministic.ts) are tried on the elements the screen shows, in this order:
 *   shared-element  another locator of the shared element the step uses finds exactly one element;
 *   role-name       the same kind of control with a label or text that reads the same (or means the same: "cart" / "basket"), or, for a
 *                   text locator, an element whose accessibility label reads like that text;
 *   same-text       an element showing the same text (case, spacing and punctuation tidied up), or, for a label locator, showing the label as text;
 *   moved           the element the old resource id meant, under an id that reads the same ("login_button" / "loginButton").
 * A rule counts only with exactly one match among the elements the step can use. Pure: unit-tested without a phone.
 */
import type { ScreenElement } from "../device/types.js";
import { roleOf } from "../explore/locators.js";
import { nameSimilarity } from "../../healing/similarity.js";
import type { FixKind } from "../../healing/deterministic.js";
import type { Locator } from "../../spec/schema.js";
import { matchesOnScreen } from "./screen-match.js";

const usable = (s: string | null | undefined): s is string => Boolean(s && s.trim()) && !s!.includes("{{") && s!.length < 200;
const readsSame = (a: string | undefined, b: string | undefined) => usable(a) && usable(b) && nameSimilarity(a, b).kind === "same";
const meansSame = (a: string | undefined, b: string | undefined) => {
    if (!usable(a) || !usable(b)) return false;
    const k = nameSimilarity(a, b).kind;
    return k === "same" || k === "synonym";
};
const textOf = (e: ScreenElement) => (e.password ? "" : e.text);

export function phoneMatchesRule(kind: Exclude<FixKind, "shared-element">, old: Locator, e: ScreenElement): boolean {
    const v = old.value ?? "";
    switch (kind) {
        case "role-name":
            if (old.by === "role") return Boolean(old.role) && roleOf(e.cls) === old.role && meansSame(v, e.desc || textOf(e));
            if (old.by === "text") return readsSame(v, e.desc);
            return false;
        case "same-text":
            if (old.by === "text" || old.by === "role" || old.by === "label") return readsSame(v, textOf(e));
            if (old.by === "placeholder") return e.editable && readsSame(v, e.desc);
            return false;
        case "moved":
            return old.by === "testId" && readsSame(v, e.id);
    }
}

/** The elements the rules choose, in rule order, at most one per rule and each element once. `candidates` = the elements the step can use. */
export function phoneDeterministicPicks(old: Locator, candidates: readonly ScreenElement[], all: readonly ScreenElement[], alternatives: readonly Locator[] = []): Array<{ kind: FixKind; element: ScreenElement; /** shared-element: the alternative itself. */ locator?: Locator }> {
    const out: Array<{ kind: FixKind; element: ScreenElement; locator?: Locator }> = [];
    const usableIndex = new Set(candidates.map((c) => c.index));
    const add = (kind: FixKind, element: ScreenElement, locator?: Locator) => {
        if (!out.some((o) => o.element.index === element.index)) out.push({ kind, element, ...(locator ? { locator } : {}) });
    };
    for (const alt of alternatives) {
        const hits = matchesOnScreen(alt, all);
        if (hits.length === 1 && usableIndex.has(hits[0]!.index)) add("shared-element", hits[0]!, alt);
    }
    for (const kind of ["role-name", "same-text", "moved"] as const) {
        const hits = candidates.filter((e) => phoneMatchesRule(kind, old, e));
        if (hits.length === 1) add(kind, hits[0]!);
    }
    return out;
}
