/**
 * One file per testing agent in this folder (Agent Workspace, .scratch/agent-workspace/CONTRACT.md): each exports `outcome`, the agent's
 * single outcome computed on read from that agent's own runs, or null until its wave builds it (the route then answers 501).
 */
import type { Platform } from "../bootstrap.js";
import type { AppModelReader } from "../case-outcome.js";
import type { JobRow } from "../repo.js";
import type { AgentId } from "../testing-agents.js";

export interface AgentOutcomeCtx {
    p: Platform;
    projectId: string;
    agentId: AgentId;
    /** This agent's runs only, newest first (agent-workspace.ts jobBelongsTo). */
    runs: JobRow[];
    /** The project's latest application model (routes/app-intel.ts latestAppModel). */
    appModel: AppModelReader;
}

export interface AgentOutcomeModule<T = unknown> {
    /** The agent's outcome: GET /api/projects/:id/workspace/:agentId/outcome. Only this agent's items (SPEC §3 table). */
    outcome(ctx: AgentOutcomeCtx): Promise<T>;
    /** What one of its runs found (`?run=<jobId>`, a run of this agent: the route checks); undefined answers 404. */
    runOutcome(ctx: AgentOutcomeCtx, jobId: string): Promise<T | undefined>;
    /** The Workspace card's one line ("5 pages, 12 test cases"), or null while there is nothing to say. */
    headline(outcome: T): string | null;
}
