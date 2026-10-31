/** Which tests and which other blocks use which block: computed from the specs and the blocks, never typed in by hand. */
import type { TestSpec } from "../spec/schema.js";
import { BlockError, blockCounts, expandBlocks, isUseBlock } from "./expand.js";
import { blockUses, MAX_ARG_LENGTH, MAX_BLOCK_DEPTH, MAX_EXPANDED_STEPS, type BlockDef, type BlockIndex } from "./model.js";

export interface BlockUsageTest {
    id: string;
    testKey: string;
    title: string;
    spec: Pick<TestSpec, "steps">;
}

export interface BlockUsage {
    /** Tests that use the block, directly or through another block. */
    tests: Array<{ id: string; testKey: string; title: string; steps: number }>;
    /** Names of the blocks whose steps use it directly. */
    blocks: string[];
}

/** Every block a set of names reaches, the names themselves included (a name that is not a block is kept, so a missing block still counts as used). */
export function blockClosure(names: Iterable<string>, index: BlockIndex): Set<string> {
    const seen = new Set<string>();
    const stack = [...names];
    while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        const def = index.get(n);
        if (def) for (const next of blockUses(def.steps)) stack.push(next);
    }
    return seen;
}

/** Block name -> its users. Names nothing uses are absent. */
export function scanBlockUsage(tests: BlockUsageTest[], blocks: Iterable<BlockDef>): Map<string, BlockUsage> {
    const defs = [...blocks];
    const index = new Map(defs.map((b) => [b.name, b]));
    const out = new Map<string, BlockUsage>();
    const entry = (name: string): BlockUsage => {
        let e = out.get(name);
        if (!e) out.set(name, (e = { tests: [], blocks: [] }));
        return e;
    };
    for (const b of defs) for (const used of blockUses(b.steps)) if (used !== b.name) entry(used).blocks.push(b.name);
    for (const t of tests) {
        const direct = blockCounts(t.spec);
        if (!direct.size) continue;
        for (const name of blockClosure(direct.keys(), index)) entry(name).tests.push({ id: t.id, testKey: t.testKey, title: t.title, steps: direct.get(name) ?? 1 });
    }
    return out;
}

/**
 * How many steps each block puts in place (nested blocks counted), worked out from the graph alone: nothing is expanded. The count saturates one
 * above the cap, so a graph that would expand to billions of steps costs the same as one that just passes the cap. A circle or a block that
 * does not exist counts as nothing here (the graph check reports those).
 */
export function expandedStepCounts(index: BlockIndex): Map<string, number> {
    const cap = MAX_EXPANDED_STEPS + 1;
    const memo = new Map<string, number>();
    const open = new Set<string>();
    const count = (name: string): number => {
        const def = index.get(name);
        if (!def || open.has(name)) return 0;
        const known = memo.get(name);
        if (known !== undefined) return known;
        open.add(name);
        let n = 0;
        for (const s of def.steps) {
            n = Math.min(cap, n + (isUseBlock(s) ? count(s.block) : 1));
            if (n >= cap) break;
        }
        open.delete(name);
        memo.set(name, n);
        return n;
    };
    for (const name of index.keys()) count(name);
    return memo;
}

/**
 * Reusable steps that would grow too large once put in place, whatever the test gives them: too many steps (worked out from the graph, before
 * anything is built) or too much text (the block is put in place with the longest value in every parameter; the engine stops at its budget,
 * so this never builds more than that). Circles and a chain that is too deep are left to `blockGraphProblems`.
 */
export function blockSizeProblems(index: BlockIndex): string[] {
    const problems: string[] = [];
    const counts = expandedStepCounts(index);
    for (const [name, def] of index) {
        if ((counts.get(name) ?? 0) > MAX_EXPANDED_STEPS) {
            problems.push(`The reusable steps “${name}” would put more than ${MAX_EXPANDED_STEPS} steps in place once the reusable steps inside them are counted. Use fewer reusable steps inside them.`);
            continue;
        }
        const args: Record<string, string> = {};
        for (const p of def.params) args[p.name] = "x".repeat(MAX_ARG_LENGTH);
        const spec = { kind: def.kind === "api" ? "api" : "web", steps: [{ action: "useBlock", block: name, ...(def.params.length ? { args } : {}) }] };
        try {
            expandBlocks(spec as never, index);
        } catch (e) {
            if (e instanceof BlockError && e.reason === "size") problems.push(`The reusable steps “${name}” grow too large when they are given long values: ${e.message.replace(/^Step 1: /, "")}`);
            else if (!(e instanceof BlockError)) throw e;
        }
    }
    return problems;
}

/**
 * Problems with how the blocks use each other: a circle, or a chain longer than allowed. Empty = fine. Checked when a block is saved (with the new
 * version in the index) and when a backup is restored.
 */
export function blockGraphProblems(index: BlockIndex): string[] {
    const problems: string[] = [];
    const state = new Map<string, "open" | "done">();
    const depth = new Map<string, number>();
    const path: string[] = [];
    const visit = (name: string): number => {
        const def = index.get(name);
        if (!def) return 0;
        if (state.get(name) === "done") return depth.get(name)!;
        if (state.get(name) === "open") {
            const loop = [...path.slice(path.indexOf(name)), name].map((n) => `“${n}”`).join(", which uses ");
            const msg = `Reusable steps can't use each other in a circle: ${loop}.`;
            if (!problems.includes(msg)) problems.push(msg);
            return 0;
        }
        state.set(name, "open");
        path.push(name);
        let deepest = 0;
        for (const next of blockUses(def.steps)) deepest = Math.max(deepest, visit(next));
        path.pop();
        state.set(name, "done");
        depth.set(name, deepest + 1);
        return deepest + 1;
    };
    for (const name of index.keys()) visit(name);
    for (const [name, d] of depth) {
        if (d > MAX_BLOCK_DEPTH) {
            const msg = `The reusable steps “${name}” reach ${d} levels of other reusable steps; at most ${MAX_BLOCK_DEPTH} levels are allowed.`;
            if (!problems.includes(msg)) problems.push(msg);
        }
    }
    // Size is judged only when the shape is right: a circle or too deep a chain can't be put in place at all.
    if (problems.length === 0) problems.push(...blockSizeProblems(index));
    return problems;
}
