/**
 * The Agent Workspace (.scratch/agent-workspace/SPEC.md, owner decisions D1–D4): a project tested by the AI agent alone, with its agents
 * chosen, shows one card per agent. Each run is one agent's (`JobOptions.agentId`, testing-agents.ts agentRunOptions); this file says
 * which runs are an agent's and what its status is. Code and mixed projects, and agent projects with no choice saved, have no Workspace.
 */
import { isCaseRun, runStatusOf } from "./case-outcome.js";
import { projectSetupOf } from "./project-setup.js";
import type { Row } from "./db.js";
import { TERMINAL_STATES, type JobRow } from "./repo.js";
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
