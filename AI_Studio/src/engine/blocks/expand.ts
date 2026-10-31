/**
 * Putting a block's steps in place of the step that uses it.
 *
 * A stored spec keeps `{ action: "useBlock", block, args }` (small, and a change to the block reaches every test). Before a spec is rendered or
 * run it is EXPANDED: the step becomes the block's steps with the parameters filled in, nested blocks included. Scripts and the engine therefore
 * never see a `useBlock` step. A spec without such a step is returned untouched (the same object), which is what keeps every script and API
 * answer identical when the feature is not used.
 *
 * Parameters are filled in by plain text replacement of `{{name}}` in the block's text fields. The value is data: it is never evaluated, and the
 * generators escape it like any other text. A value that itself contains `{{...}}` is not replaced a second time.
 *
 * The engine works on expanded specs and may store one again (a repair, a status update). Each expanded step therefore carries a note of the
 * step it came from (`BLOCK_MARK`), and `collapseBlocks` folds a group of unchanged steps back into the one `useBlock` step when the spec is stored.
 * A group that was changed on the way (a repair rewrote a step) is kept as plain steps instead: nothing is lost, it just stops following the block.
 */
import type { Step, TestSpec } from "../spec/schema.js";
import { MAX_BLOCK_DEPTH, MAX_EXPANDED_CHARS, MAX_EXPANDED_STEPS, type BlockDef, type BlockIndex } from "./model.js";

export const BLOCK_MARK = "__block";

type UseBlockStep = Extract<Step, { action: "useBlock" }>;

interface Mark {
    /** Index of the `useBlock` step in the stored spec. */
    at: number;
    call: UseBlockStep;
    /** How many steps the call expanded to. */
    n: number;
    /** What the step looked like when it was expanded; a different text later means someone changed it. */
    sig: string;
}
type Marked = Step & { [BLOCK_MARK]?: Mark };

export interface BlockProblem {
    /** Zero-based index of the `useBlock` step in the spec (absent when the problem is about the whole test). */
    stepIndex?: number;
    message: string;
}

/** A spec whose reusable steps cannot be put in place. `message` is plain language for the person who sees it. */
export class BlockError extends Error {
    constructor(
        message: string,
        readonly problems: BlockProblem[],
        /** "size" when the steps would grow too large (too many steps, or too much text), as opposed to a name, a value or a circle that is wrong. */
        readonly reason?: "size",
    ) {
        super(message);
        this.name = "BlockError";
    }
}

export const isUseBlock = (s: Step): s is UseBlockStep => s.action === "useBlock";
export const hasBlocks = (spec: Pick<TestSpec, "steps">): boolean => spec.steps.some(isUseBlock);

/** Names this spec's steps use directly, each once, in order of first use. */
export function blockNames(spec: Pick<TestSpec, "steps">): string[] {
    const out: string[] = [];
    for (const s of spec.steps) if (isUseBlock(s) && !out.includes(s.block)) out.push(s.block);
    return out;
}

/** How many steps of this spec use each block directly. */
export function blockCounts(spec: Pick<TestSpec, "steps">): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of spec.steps) if (isUseBlock(s)) out.set(s.block, (out.get(s.block) ?? 0) + 1);
    return out;
}

// ── filling in parameters ───────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const tooLarge = () => new BlockError(`With the reusable steps put in place, this test would hold more than ${MAX_EXPANDED_CHARS / 1000} KB of step text. Shorten the values given to the reusable steps, or the steps themselves.`, [], "size");

/**
 * Replaces the placeholders. With a budget, the text a value adds is counted AS IT IS ADDED and the work stops the moment the budget is spent,
 * so nothing larger than the budget is ever built (a value that contains many placeholders, passed down several levels, would otherwise
 * grow by a factor of hundreds at each level).
 */
const fill = (s: string, values: ReadonlyMap<string, string>, budget?: Budget): string =>
    s.replace(PLACEHOLDER, (m, k: string) => {
        if (!values.has(k)) return m;
        const v = values.get(k)!;
        if (budget && (budget.chars -= v.length) < 0) throw tooLarge();
        return v;
    });

function deepFill(v: unknown, values: ReadonlyMap<string, string>, budget: Budget | undefined, depth = 0): unknown {
    if (typeof v === "string") return fill(v, values, budget);
    if (depth > 30) return v;
    if (Array.isArray(v)) return v.map((x) => deepFill(x, values, budget, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deepFill(x, values, budget, depth + 1)]));
    return v;
}

/** What a step's text fields become once the values are filled in. The words that say what a step does (action, check, method, how to find an element) stay as they are. */
export function fillStep(step: Step, values: ReadonlyMap<string, string>, budget?: Budget): Step {
    if (values.size === 0) return structuredClone(step);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step as unknown as Record<string, unknown>)) {
        if (k === "action" || k === "check" || k === "method" || k === "auth" || k === "block") out[k] = v;
        else if (k === "locator" && v && typeof v === "object") {
            const { by, ref, ...rest } = v as Record<string, unknown>;
            out[k] = { ...(by !== undefined ? { by } : {}), ...(ref !== undefined ? { ref } : {}), ...(deepFill(rest, values, budget) as Record<string, unknown>) };
        } else out[k] = deepFill(v, values, budget);
    }
    return out as unknown as Step;
}

/** The values a call gives the block's parameters: the given value, else the default. Throws a plain message when one is missing or unknown. */
function valuesFor(def: BlockDef, args: Readonly<Record<string, string>> | undefined): Map<string, string> {
    const known = new Set(def.params.map((p) => p.name));
    for (const k of Object.keys(args ?? {})) {
        if (!known.has(k)) throw new BlockError(def.params.length ? `The reusable steps “${def.name}” have no parameter “${k}”. They have: ${def.params.map((p) => p.name).join(", ")}.` : `The reusable steps “${def.name}” have no parameters, so “${k}” can't be given.`, []);
    }
    const values = new Map<string, string>();
    for (const p of def.params) {
        // Own properties only: a parameter called "constructor" or "toString" must not pick up a function from the prototype.
        const given = args && Object.hasOwn(args, p.name) ? args[p.name] : undefined;
        if (given !== undefined && given !== "") values.set(p.name, given);
        else if (p.default !== undefined) values.set(p.name, p.default);
        else throw new BlockError(`The reusable steps “${def.name}” need a value for “${p.name}”.`, []);
    }
    return values;
}

const kindWord = (k: string) => (k === "web" ? "web" : k === "api" ? "API" : k);

// ── expansion ───────────────────────────────────────────────────────────────

/** What is left to spend while one test is expanded: leaf steps, and characters of step text. */
export interface Budget {
    left: number;
    chars: number;
}
const newBudget = (steps: number): Budget => ({ left: steps, chars: MAX_EXPANDED_CHARS });

function expandCall(call: UseBlockStep, stack: readonly string[], blocks: BlockIndex | undefined, testKind: string, budget: Budget): Step[] {
    const def = blocks?.get(call.block);
    if (!def) throw new BlockError(`This test uses the reusable steps “${call.block}”, which are not in this project.`, []);
    if (stack.includes(def.name)) {
        const loop = [...stack.slice(stack.indexOf(def.name)), def.name].map((n) => `“${n}”`).join(", which uses ");
        throw new BlockError(`Reusable steps can't use each other in a circle: ${loop}. Remove one of these uses.`, []);
    }
    if (stack.length >= MAX_BLOCK_DEPTH) {
        throw new BlockError(`Reusable steps can be used inside each other at most ${MAX_BLOCK_DEPTH} levels deep (${[...stack, def.name].map((n) => `“${n}”`).join(", which uses ")}).`, []);
    }
    if (def.kind !== "any" && def.kind !== testKind) {
        throw new BlockError(`The reusable steps “${def.name}” are for ${kindWord(def.kind)} tests; this is ${testKind === "api" ? "an" : "a"} ${kindWord(testKind)} test.`, []);
    }
    const values = valuesFor(def, call.args);
    const out: Step[] = [];
    for (const raw of def.steps) {
        const step = fillStep(raw, values, budget);
        if (isUseBlock(step)) {
            out.push(...expandCall(step, [...stack, def.name], blocks, testKind, budget));
            continue;
        }
        if (--budget.left < 0) throw new BlockError(`With the reusable steps put in place, this test would have more than ${MAX_EXPANDED_STEPS} steps. Shorten the test or the reusable steps.`, [], "size");
        if ((budget.chars -= JSON.stringify(step).length) < 0) throw tooLarge();
        out.push(step);
    }
    return out;
}

/** A step as it was before shared elements were resolved in it, so the note can be compared after the engine has worked on it. */
function sigOf(step: Step): string {
    const { [BLOCK_MARK]: _mark, ...rest } = step as Marked;
    const l = (rest as { locator?: { ref?: unknown } }).locator;
    const plain = l && typeof l === "object" && typeof l.ref === "string" ? { ...rest, locator: { ref: l.ref } } : rest;
    return JSON.stringify(sortKeys(plain));
}
function sortKeys(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
    return x;
}

/**
 * The spec with every `useBlock` step replaced by the block's steps. Throws a `BlockError` (never guesses) when a block is not in the project,
 * is of another kind than the test, is missing a value, is used in a circle or too deep, or makes the test too long. Every problem is listed
 * in `problems`, with the index of the step that uses the block.
 */
export function expandBlocks(spec: TestSpec, blocks: BlockIndex | undefined): TestSpec {
    if (!hasBlocks(spec)) return spec;
    const problems: BlockProblem[] = [];
    let sizeReason: "size" | undefined;
    const out: Step[] = [];
    const budget = newBudget(MAX_EXPANDED_STEPS - spec.steps.filter((s) => !isUseBlock(s)).length);
    spec.steps.forEach((step, i) => {
        if (!isUseBlock(step)) {
            out.push(step);
            return;
        }
        try {
            const part = expandCall(step, [], blocks, spec.kind, budget);
            for (const p of part) (p as Marked)[BLOCK_MARK] = { at: i, call: step, n: part.length, sig: sigOf(p) };
            out.push(...part);
        } catch (e) {
            // A string too long for the engine to hold is the same thing as a budget spent; anything else is a bug and stays one.
            const err = e instanceof RangeError ? tooLarge() : e;
            if (!(err instanceof BlockError)) throw err;
            if (err.reason === "size") sizeReason = "size";
            problems.push({ stepIndex: i, message: `Step ${i + 1}: ${err.message}` });
            // Once the budget is spent every further call would say the same thing.
            if (budget.left < 0) budget.left = 0;
            if (budget.chars < 0) budget.chars = 0;
        }
    });
    if (problems.length) throw new BlockError(problems[0]!.message, problems, sizeReason);
    return { ...spec, steps: out };
}

/** The same, as a result instead of an exception. */
export function tryExpandBlocks(spec: TestSpec, blocks: BlockIndex | undefined): { ok: true; spec: TestSpec } | { ok: false; error: string; problems: BlockProblem[] } {
    try {
        return { ok: true, spec: expandBlocks(spec, blocks) };
    } catch (e) {
        if (e instanceof BlockError) return { ok: false, error: e.message, problems: e.problems };
        throw e;
    }
}

/** True when some step carries the note of a block it was expanded from. */
export const hasBlockMarks = (spec: Pick<TestSpec, "steps">): boolean => spec.steps.some((s) => (s as Marked)[BLOCK_MARK] !== undefined);

/**
 * Folds expanded steps back into the `useBlock` step they came from, so a run never copies a block's steps into the tests that use it. A group
 * that is incomplete or was changed since it was expanded stays as plain steps (without the note). Returns the same object when no step has a note.
 */
export function collapseBlocks(spec: TestSpec): TestSpec {
    if (!hasBlockMarks(spec)) return spec;
    const out: Step[] = [];
    const steps = spec.steps as Marked[];
    for (let i = 0; i < steps.length; ) {
        const mark = steps[i]![BLOCK_MARK];
        if (!mark) {
            out.push(steps[i]!);
            i++;
            continue;
        }
        let j = i;
        while (j < steps.length && steps[j]![BLOCK_MARK]?.at === mark.at && steps[j]![BLOCK_MARK] !== undefined) j++;
        const group = steps.slice(i, j);
        const intact = group.length === mark.n && group.every((s) => s[BLOCK_MARK]!.sig === sigOf(s));
        if (intact) out.push(mark.call);
        else
            for (const s of group) {
                const { [BLOCK_MARK]: _drop, ...plain } = s;
                out.push(plain as Step);
            }
        i = j;
    }
    return { ...spec, steps: out };
}

/** The spec with references to the block `from` pointing at `to`. Returns the same object when nothing uses `from`. */
export function renameBlockRefs<T extends { steps: Step[] }>(spec: T, from: string, to: string): T {
    if (!spec.steps.some((s) => isUseBlock(s) && s.block === from)) return spec;
    return { ...spec, steps: spec.steps.map((s) => (isUseBlock(s) && s.block === from ? { ...s, block: to } : s)) };
}

/**
 * For each step of the expanded spec, the index of the step of the stored spec it comes from (a step of a block maps to the `useBlock` step that
 * brought it). Lets a message about "step 7" of the steps that run be shown on the step the person sees. `expanded` must come from `expandBlocks(spec)`.
 */
export function sourceIndexes(spec: Pick<TestSpec, "steps">, expanded: Pick<TestSpec, "steps">): number[] {
    if (expanded.steps === spec.steps) return spec.steps.map((_, i) => i);
    const out: number[] = [];
    let j = 0;
    spec.steps.forEach((s, i) => {
        const n = isUseBlock(s) ? ((expanded.steps[j] as Marked | undefined)?.[BLOCK_MARK]?.n ?? 1) : 1;
        for (let k = 0; k < n; k++) out.push(i);
        j += n;
    });
    return out;
}

/** The block a step of an expanded spec came from, if any. */
export const blockOfStep = (step: Step): { at: number; block: string } | undefined => {
    const m = (step as Marked)[BLOCK_MARK];
    return m ? { at: m.at, block: m.call.block } : undefined;
};
