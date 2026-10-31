/**
 * Which shared elements (object repository) a test reaches through reusable steps. A stored spec spells out only the elements of its own
 * steps; one that sits inside a block shows up only once the block is put in place, so usage counts and "used by" lists need this.
 * Pure: the platform hands in the specs and the blocks.
 */
import { refCounts, refNames } from "../locators/refs.js";
import type { TestSpec } from "../spec/schema.js";
import { blockNames, tryExpandBlocks } from "./expand.js";
import { blockClosure } from "./usage.js";
import { indexBlocks, type BlockDef } from "./model.js";

export interface ThroughBlocks {
    /** Steps of the test (blocks put in place) that reach the element through reusable steps. */
    steps: number;
    /** The reusable steps that hold the element and that this test uses, directly or through another set. */
    blocks: string[];
}

/** Element name -> test id -> how the test reaches it through blocks. Elements and tests with no such path are absent. */
export function elementUsageThroughBlocks(tests: ReadonlyArray<{ id: string; spec: TestSpec }>, blocks: Iterable<BlockDef>): Map<string, Map<string, ThroughBlocks>> {
    const defs = [...blocks];
    const out = new Map<string, Map<string, ThroughBlocks>>();
    if (!defs.length) return out;
    const index = indexBlocks(defs);
    const holders = blocksHoldingElements(defs);
    for (const t of tests) {
        const direct = blockNames(t.spec);
        if (!direct.length) continue;
        const expanded = tryExpandBlocks(t.spec, index);
        // A test whose blocks cannot be put in place is judged (and refused) elsewhere, with the plain reason.
        if (!expanded.ok) continue;
        const own = refCounts(t.spec);
        const reached = blockClosure(direct, index);
        for (const [name, total] of refCounts(expanded.spec)) {
            const viaBlocks = total - (own.get(name) ?? 0);
            if (viaBlocks <= 0) continue;
            const blockList = (holders.get(name) ?? []).filter((b) => reached.has(b));
            const per = out.get(name) ?? new Map<string, ThroughBlocks>();
            per.set(t.id, { steps: viaBlocks, blocks: blockList });
            out.set(name, per);
        }
    }
    return out;
}

/** Element name -> the reusable steps whose own steps refer to it (sorted by name). */
export function blocksHoldingElements(blocks: Iterable<BlockDef>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const b of blocks) {
        for (const name of refNames({ steps: b.steps } as TestSpec)) {
            const list = out.get(name) ?? [];
            list.push(b.name);
            out.set(name, list);
        }
    }
    for (const list of out.values()) list.sort((a, b) => a.localeCompare(b));
    return out;
}
