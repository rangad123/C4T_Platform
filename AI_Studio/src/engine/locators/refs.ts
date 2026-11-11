/**
 * References from a spec to the object repository.
 *
 * A stored spec step may carry `{ ref: "<element name>" }` instead of a locator. Before a spec is rendered or run it is RESOLVED:
 * the reference becomes the element's concrete locator (with `ref` kept next to it as a note of where it came from), so scripts
 * and the engine never see a reference. When the spec is stored again the notes are folded back into `{ ref }` (`collapseRefs`),
 * so a run never copies an element's locator into the tests that use it.
 *
 * A spec without references is returned untouched (the same object), which is what keeps every script and API answer identical
 * when the feature is not used.
 */
import { isLocatorRef, type Locator, type Step, type TestSpec } from "../spec/schema.js";
import { tidy, type ElementKind } from "./model.js";

export interface ObjectEntry {
    kind: ElementKind;
    locator: Locator;
    /** Other ways to find the same element, tried by a repair without AI when `locator` finds nothing. Never rendered into a script. */
    alternatives?: Locator[];
}
/** The project's elements by exact name. */
export type ObjectIndex = ReadonlyMap<string, ObjectEntry>;

/** A spec that cannot be resolved. `message` is plain language for the person who sees it. */
export class RefError extends Error {
    constructor(
        message: string,
        readonly problems: string[],
    ) {
        super(message);
        this.name = "RefError";
    }
}

type WithLocator = Step & { locator?: unknown };

/** The locator slot of a step, if its action has one (click, fill, select, check, press, hover, assert). */
export function locatorOf(step: Step): Locator | undefined {
    const l = (step as WithLocator).locator;
    return l && typeof l === "object" ? (l as Locator) : undefined;
}

/** The name a locator refers to: an unresolved reference, or a resolved locator that remembers where it came from. */
export function refOf(l: unknown): string | undefined {
    const r = l && typeof l === "object" ? (l as { ref?: unknown }).ref : undefined;
    return typeof r === "string" ? r : undefined;
}

const mapLocators = (spec: TestSpec, fn: (l: Locator, stepIndex: number) => Locator): TestSpec => {
    let changed = false;
    const steps = spec.steps.map((step, i) => {
        const l = locatorOf(step);
        if (!l) return step;
        const next = fn(l, i);
        if (next === l) return step;
        changed = true;
        return { ...step, locator: next } as Step;
    });
    return changed ? { ...spec, steps } : spec;
};

/** Names this spec's steps refer to (resolved or not), each once, in order of first use. */
export function refNames(spec: TestSpec): string[] {
    const out: string[] = [];
    for (const step of spec.steps) {
        const r = refOf(locatorOf(step));
        if (r !== undefined && !out.includes(r)) out.push(r);
    }
    return out;
}

/** How many steps of this spec refer to each name. */
export function refCounts(spec: TestSpec): Map<string, number> {
    const out = new Map<string, number>();
    for (const step of spec.steps) {
        const r = refOf(locatorOf(step));
        if (r !== undefined) out.set(r, (out.get(r) ?? 0) + 1);
    }
    return out;
}

/** True when some step still has a reference to resolve. */
export const hasUnresolvedRefs = (spec: TestSpec): boolean => spec.steps.some((s) => isLocatorRef(locatorOf(s)));

const kindWord = (k: string) => (k === "web" ? "web" : k === "mobile" ? "mobile" : "desktop");

/** Plain-language problems with the references of a spec (unknown name, wrong kind). Empty = every reference can be resolved. */
export function refProblems(spec: TestSpec, objects: ObjectIndex | undefined): string[] {
    const out: string[] = [];
    for (const step of spec.steps) {
        const l = locatorOf(step);
        if (!isLocatorRef(l)) continue;
        const entry = objects?.get(l.ref);
        const msg = !entry
            ? `This test refers to '${l.ref}', which is not in the object repository.`
            : entry.kind !== spec.kind
              ? `This test refers to '${l.ref}', which is a ${kindWord(entry.kind)} element; a ${kindWord(spec.kind)} test can only use ${kindWord(spec.kind)} elements.`
              : undefined;
        if (msg && !out.includes(msg)) out.push(msg);
    }
    return out;
}

/**
 * The spec with every reference replaced by the element's concrete locator. Throws a `RefError` (never guesses) when a name is
 * not in the repository or the element is of another kind than the test.
 */
export function resolveSpecRefs(spec: TestSpec, objects: ObjectIndex | undefined): TestSpec {
    if (!hasUnresolvedRefs(spec)) return spec;
    const problems = refProblems(spec, objects);
    if (problems.length) throw new RefError(problems[0]!, problems);
    return mapLocators(spec, (l) => (isLocatorRef(l) ? ({ ...tidy(objects!.get(l.ref)!.locator), ref: l.ref } as Locator) : l));
}

/** The same, as a result instead of an exception. */
export function tryResolveSpecRefs(spec: TestSpec, objects: ObjectIndex | undefined): { ok: true; spec: TestSpec } | { ok: false; error: string } {
    try {
        return { ok: true, spec: resolveSpecRefs(spec, objects) };
    } catch (e) {
        if (e instanceof RefError) return { ok: false, error: e.message };
        throw e;
    }
}

/** Folds resolved locators (the ones that remember an element) back into `{ ref }`. Returns the same object when there are none. */
export function collapseRefs(spec: TestSpec): TestSpec {
    return mapLocators(spec, (l) => {
        const r = refOf(l);
        return r !== undefined && (l as { by?: unknown }).by !== undefined ? ({ ref: r } as unknown as Locator) : l;
    });
}

/** The spec with references to `from` pointing at `to`. Returns the same object when nothing refers to `from`. */
export function renameRefs(spec: TestSpec, from: string, to: string): TestSpec {
    return mapLocators(spec, (l) => (refOf(l) === from ? ({ ...l, ref: to } as Locator) : l));
}

/** The spec with the given steps' locators replaced by references (extraction). `names` maps step index to element name. */
export function useRefsAt(spec: TestSpec, names: ReadonlyMap<number, string>): TestSpec {
    return mapLocators(spec, (_l, i) => (names.has(i) ? ({ ref: names.get(i)! } as unknown as Locator) : _l));
}

/** Builds the lookup table `resolveSpecRefs` needs from stored elements. */
export function indexOf(elements: Iterable<{ name: string; kind: ElementKind; locator: Locator; alternatives?: Locator[] }>): ObjectIndex {
    const m = new Map<string, ObjectEntry>();
    for (const e of elements) m.set(e.name, { kind: e.kind, locator: e.locator, ...(e.alternatives?.length ? { alternatives: e.alternatives } : {}) });
    return m;
}
