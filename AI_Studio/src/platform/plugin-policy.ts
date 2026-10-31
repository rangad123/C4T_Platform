/**
 * Automated runs (schedules, deploy triggers, runbooks) and adapter plug-in tests.
 *
 * A job that includes a test of a plug-in framework that cannot serve it now is refused with a 409 (plugin-gate.ts). That is right for a person who
 * asked for those tests, but an automated run must not fail as a whole because ONE test of the project uses a plug-in that was removed, switched
 * off, or cannot run where the project runs: those tests are left out of the run, the rest runs, and the job says so in plain words (the same
 * rule hand-written tests follow, see custom-policy.ts).
 */
import { isBuiltInAdapterId } from "../engine/frameworks/index.js";
import type { Repo } from "./repo.js";

/** What the automated run is: a plain run of the tests, or one against a named environment (a plug-in cannot do that). */
export type RunShape = "validate" | "environment";

/** The framework ids of the project's tests that are not built in, with their tests. */
function pluginTests(repo: Repo, projectId: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    // One cheap query first: almost every project has no plug-in test, and then nothing else is read.
    const used = repo.db.all("SELECT DISTINCT framework FROM test_cases WHERE project_id = ?", projectId).map((r) => r.framework as unknown).filter((f): f is string => typeof f === "string" && !isBuiltInAdapterId(f));
    for (const framework of used) {
        out.set(framework, repo.db.all("SELECT id FROM test_cases WHERE project_id = ? AND framework = ?", projectId, framework).map((r) => r.id as string));
    }
    return out;
}

/** The tests of the project an automated run of this shape must leave out, with a plain sentence saying why (undefined when none). */
export async function pluginSkips(repo: Repo, projectId: string, shape: RunShape = "validate"): Promise<{ ids: Set<string>; note?: string }> {
    const ids = new Set<string>();
    if (!repo.pluginPolicy) return { ids };
    const notes: string[] = [];
    for (const [framework, tests] of pluginTests(repo, projectId)) {
        const reason = await repo.pluginPolicy(projectId, framework, shape);
        if (!reason) continue;
        for (const id of tests) ids.add(id);
        notes.push(`${tests.length} test${tests.length === 1 ? " was" : "s were"} not run because ${tests.length === 1 ? "it uses" : "they use"} the plug-in framework "${framework}". ${reason}`);
    }
    return { ids, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** Writes that sentence onto a job (an event), when there is something to say. Never throws. */
export async function notePluginSkipped(repo: Repo, jobId: string, projectId: string, shape: RunShape = "validate"): Promise<void> {
    try {
        const { note } = await pluginSkips(repo, projectId, shape);
        if (note) repo.addEvent(jobId, { stage: "validation", kind: "plugin_skipped", level: "warn", message: note });
    } catch {
        /* a note is a convenience */
    }
}
