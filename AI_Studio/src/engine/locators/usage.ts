/** Which tests use which element: computed from the specs, never typed in by hand. */
import type { TestSpec } from "../spec/schema.js";
import { refCounts } from "./refs.js";

export interface UsageTest {
    id: string;
    testKey: string;
    title: string;
    spec: TestSpec;
}

export interface UsageEntry {
    id: string;
    testKey: string;
    title: string;
    /** How many steps of the test use the element. */
    steps: number;
}

/** Element name -> the tests that refer to it (in the order the tests are given). Names no test refers to are absent. */
export function scanUsage(tests: UsageTest[]): Map<string, UsageEntry[]> {
    const out = new Map<string, UsageEntry[]>();
    for (const t of tests) {
        for (const [name, steps] of refCounts(t.spec)) {
            const list = out.get(name) ?? [];
            list.push({ id: t.id, testKey: t.testKey, title: t.title, steps });
            out.set(name, list);
        }
    }
    return out;
}
