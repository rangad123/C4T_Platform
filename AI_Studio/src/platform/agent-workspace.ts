/**
 * The Agent Workspace (.scratch/agent-workspace/SPEC.md, owner decisions D1–D4): a project tested by the AI agent alone, with its agents
 * chosen, shows one card per agent. Each run is one agent's (`JobOptions.agentId`, testing-agents.ts agentRunOptions); this file says
 * which runs are an agent's and what its status is. Code and mixed projects, and agent projects with no choice saved, have no Workspace.
 */
import { isCaseRun, runStatusOf } from "./case-outcome.js";
import { projectSetupOf } from "./project-setup.js";
import type { Row } from "./db.js";
import { TERMINAL_STATES, type JobRow } from "./repo.js";
import type { Sql } from "./sql.js";
import { agentsMatching, type AgentId, type TestingAgentStore } from "./testing-agents.js";

export type AgentStatus = "not-run" | "running" | "done" | "stopped" | "failed" | "needs-input";

/** The project's chosen agents when it has the Workspace (agent mode alone, a saved choice); undefined otherwise. */
export async function workspaceAgents(store: TestingAgentStore, row: Row): Promise<AgentId[] | undefined> {
    const modes = projectSetupOf(row).testingModes;
    return modes.includes("agent") && !modes.includes("code") ? store.chosen(String(row.id)) : undefined;
}

/**
 * Whether a job is a run of this agent: the agent it names. An older job names none: a test case run (plan-only) is Test Case
 * Generation's; an exploration that made its checks is each agent's whose switches it had on (testing-agents.ts agentsMatching).
 */
export function jobBelongsTo(job: Pick<JobRow, "options">, agentId: AgentId): boolean {
    const o = job.options;
    if (o.agentId) return o.agentId === agentId;
    if (agentId === "test-generation") return isCaseRun(job);
    return (o.mode ?? "generate") === "generate" && !o.planOnly && agentsMatching(o, ["web", "android"]).includes(agentId);
}

/**
 * An agent's status (SPEC §1): Running while its newest run is going; Needs input when it misses something it cannot run without;
 * else Not run yet, or what its newest run did: Done, Stopped (what it found is kept) or Failed.
 */
export function agentStatusOf(newest: Pick<JobRow, "status" | "error" | "cancelRequested"> | undefined, needs: readonly string[]): AgentStatus {
    if (newest && !TERMINAL_STATES.includes(newest.status)) return "running";
    if (needs.length) return "needs-input";
    if (!newest) return "not-run";
    const s = runStatusOf(newest);
    return s === "completed" ? "done" : s === "stopped" ? "stopped" : "failed";
}

/**
 * What the project's saved results are now, outside its runs that are going: it changes when a test, a result, a finding or a picture
 * is added, changed or removed, whoever wrote it (the worker may be another process).
 */
export async function resultsStamp(sql: Sql, projectId: string, going: readonly string[]): Promise<string> {
    const notGoing = (col: string) => (going.length ? `(${col} IS NULL OR ${col} NOT IN (${going.map(() => "?").join(",")}))` : "1 = 1");
    const r = await sql.get<Row>(
        `SELECT (SELECT COUNT(*) FROM test_cases WHERE project_id = ? AND ${notGoing("job_id")}) AS tests,
                (SELECT MAX(updated_at) FROM test_cases WHERE project_id = ? AND ${notGoing("job_id")}) AS tests_at,
                (SELECT COUNT(*) FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ? AND ${notGoing("e.job_id")}) AS results,
                (SELECT MAX(e.finished_at) FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ? AND ${notGoing("e.job_id")}) AS results_at,
                (SELECT COUNT(*) FROM candidate_findings WHERE project_id = ? AND ${notGoing("last_job_id")}) AS findings,
                (SELECT MAX(updated_at) FROM candidate_findings WHERE project_id = ? AND ${notGoing("last_job_id")}) AS findings_at,
                (SELECT COUNT(*) FROM artifacts WHERE project_id = ? AND ${notGoing("job_id")}) AS files,
                (SELECT COUNT(pruned_at) FROM artifacts WHERE project_id = ? AND ${notGoing("job_id")}) AS pruned,
                (SELECT MAX(created_at) FROM artifacts WHERE project_id = ? AND ${notGoing("job_id")}) AS files_at`,
        ...Array.from({ length: 9 }, () => [projectId, ...going]).flat(),
    );
    return Object.values(r ?? {}).join("|");
}

/** Each card's headline, by project and agent, with what it was worked out from (small, in-process; oldest dropped first). */
const headlines = new Map<string, { key: string; at: number; headline: string | null }>();
const HEADLINES_MAX = 500;
// shortcut: two changes in the same millisecond with the same counts can hide from the stamp; this bounds that to a minute.
const HEADLINE_MAX_AGE_MS = 60_000;

/**
 * A card's headline, worked out again only when it can have changed (M6): while one of the agent's runs is going (its results change
 * by the second), or when its runs or the project's other saved results changed since (`stamp`, resultsStamp).
 */
export async function headlineOf(projectId: string, agentId: AgentId, runs: readonly JobRow[], stamp: string, compute: () => Promise<string | null>): Promise<string | null> {
    const id = `${projectId}:${agentId}`;
    if (runs.some((j) => !TERMINAL_STATES.includes(j.status))) {
        headlines.delete(id);
        return compute();
    }
    const key = `${stamp}#${runs.map((j) => `${j.id}:${j.status}:${j.updatedAt}`).join(",")}`;
    const hit = headlines.get(id);
    headlines.delete(id);
    if (hit && hit.key === key && Date.now() - hit.at < HEADLINE_MAX_AGE_MS) {
        headlines.set(id, hit);
        return hit.headline;
    }
    const headline = await compute();
    if (headlines.size >= HEADLINES_MAX) headlines.delete(headlines.keys().next().value!);
    headlines.set(id, { key, at: Date.now(), headline });
    return headline;
}
