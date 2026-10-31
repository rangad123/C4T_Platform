/**
 * Quality of ONE test (the test page), without putting the reusable steps of every test of the project in place.
 *
 * `assessProjectQuality` judges a test on its own steps and then looks for an earlier test with exactly the same steps. Only the second part needs
 * other tests, and two tests can have the same steps only if they would have the same number of steps once reusable steps are put in place. So the
 * other tests that use reusable steps are put in place only when their step count (worked out from the graph, nothing built) matches the one
 * requested; all the others are compared as they are. The answer is the same as before; the cost no longer grows with the number of tests.
 */
import { expandedStepCounts, hasBlocks, indexBlocks, isUseBlock } from "../engine/blocks/index.js";
import { assessProjectQuality, type Quality } from "../engine/quality/rules.js";
import type { TestSpec } from "../engine/spec/schema.js";
import { blockView, BlockStore } from "./block-store.js";
import type { Db } from "./db.js";

type Item = { id: string; testKey: string; spec: TestSpec };

/** `tests` in the order the project lists them (creation order); the quality of `targetId`, or null when it is not among them. */
export function qualityOfTest(db: Db, projectId: string, tests: readonly Item[], targetId: string): Quality | null {
    const at = tests.findIndex((t) => t.id === targetId);
    if (at < 0) return null;
    const view = blockView(db, projectId);
    const target = tests[at]!;
    const mine = view(target.spec);
    let counts: Map<string, number> | undefined;
    const sameLength = (spec: TestSpec): boolean => {
        counts ??= expandedStepCounts(indexBlocks(new BlockStore(db).list(projectId)));
        let n = 0;
        for (const s of spec.steps) n += isUseBlock(s) ? (counts.get(s.block) ?? 0) : 1;
        return n === mine.steps.length;
    };
    // Only tests before the requested one can make it a duplicate.
    const earlier = tests.slice(0, at).map((t) => (hasBlocks(t.spec) && sameLength(t.spec) ? { ...t, spec: view(t.spec) } : t));
    return assessProjectQuality([...earlier, { ...target, spec: mine }]).get(targetId) ?? null;
}
