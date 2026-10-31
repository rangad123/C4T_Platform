/**
 * What a run needs to execute hand-written tests: each test's stored script and the shared helper modules it imports.
 * Used by validation, browser/screen-size checks and environment runs (platform/job-runner.ts, environment-run.ts).
 */
import { applyExecutorPolicy } from "./custom-run-policy.js";
import { CustomScriptStore } from "./custom-script-store.js";
import type { Repo } from "./repo.js";

export interface CustomRunInputs {
    /** The hand-written tests among the given ones: test id -> the script to run. */
    byTest: Map<string, { filename: string; content: string; scriptId: string | null }>;
    /** Helper modules those scripts import (also through each other, up to three levels). */
    helpers: Array<{ name: string; content: string }>;
    /** Helper names some script imports that the project does not have: the run will fail on them, and says so. */
    missing: string[];
}

export function customRunInputs(repo: Repo, projectId: string, testIds: readonly string[]): CustomRunInputs {
    const store = new CustomScriptStore(repo.db);
    const byTest: CustomRunInputs["byTest"] = new Map();
    for (const id of store.customAmong(testIds)) {
        const s = repo.getCurrentScript(id);
        if (s) byTest.set(id, { filename: s.filename as string, content: s.content as string, scriptId: (s.id as string | undefined) ?? null });
    }
    if (byTest.size === 0) return { byTest, helpers: [], missing: [] };
    const closure = store.helpersFor(projectId, [...byTest.values()].map((c) => c.content));
    return { byTest, helpers: closure.helpers, missing: closure.missing };
}

export { applyExecutorPolicy };
