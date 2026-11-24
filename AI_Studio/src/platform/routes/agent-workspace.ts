/**
 * The Agent Workspace (agent-workspace.ts; .scratch/agent-workspace/SPEC.md):
 *
 *   GET /api/projects/:id/workspace[?agent=]              → { workspace, agents: [{ id, name, summary, status, needs, runs, lastRun, headline }] }
 *                                                           workspace false and no agents for a project without one (code, mixed, no choice saved);
 *                                                           ?agent= answers that agent's card alone (an agent page); headlines: agent-workspace.ts headlineOf
 *   GET /api/projects/:id/workspace/:agentId/outcome[?run=]  → that agent's outcome (agent-outcomes/<agentId>.ts), or one run's part of it;
 *                                                           501 for an agent whose outcome is not built yet, 404 for an agent the project did not choose
 *   GET /api/projects/:id/workspace/:agentId/runs            → that agent's runs only, newest first (the jobs list's shape)
 *
 * Who may read the project reads all three (auth/roles.ts).
 */
import { agentStatusOf, headlineOf, jobBelongsTo, resultsStamp, workspaceAgents } from "../agent-workspace.js";
import { AGENT_OUTCOMES } from "../agent-outcomes/index.js";
import type { AgentOutcomeCtx } from "../agent-outcomes/types.js";
import { NO_ADDRESS_OR_REQUIREMENTS } from "../case-agent.js";
import type { AppModelReader } from "../case-outcome.js";
import { HttpError } from "../http-error.js";
import type { Row } from "../db.js";
import { TERMINAL_STATES } from "../repo.js";
import { RequirementStore } from "../requirement-store.js";
import { agentById, type AgentId } from "../testing-agents.js";
import { missingInputs, savedInputsFor } from "./agent-inputs.js";
import { testingAgentsOf } from "./testing-agents.js";
import type { RouteCtx } from "./types.js";

export const NOT_THIS_PROJECTS_AGENT = "This testing agent is not one of this project's agents.";
export const outcomeNotBuilt = (name: string) => `The ${name}'s outcome is not shown here yet.`;
export const NO_SUCH_AGENT_RUN = "This run is not one of this agent's runs.";

export function registerAgentWorkspaceRoutes(ctx: RouteCtx, appModel: AppModelReader): void {
    const { app, p, repo } = ctx;
    const store = testingAgentsOf(p, repo);

    /** What the agent cannot run without, as the sentences its refusal says (routes/agent-inputs.ts REQUIRED_INPUTS, case-agent.ts). */
    const needsOf = async (row: Row, agentId: AgentId): Promise<string[]> => {
        const id = String(row.id);
        const latest = repo.getLatestApplicationPublic(id);
        const openApiUrl = latest ? savedInputsFor(p, id, String(latest.url)).openApiUrl : undefined;
        const needs = missingInputs([agentId], { openApiUrl }).map((m) => m.text);
        if (agentId === "test-generation" && !latest?.url && !row.url && !latest?.config?.mobile) {
            if (!(await new RequirementStore(p.db.sql).list(id)).some((r) => r.status === "active")) needs.push(NO_ADDRESS_OR_REQUIREMENTS);
        }
        return needs;
    };
    const runsOf = (projectId: string, agentId: AgentId) => repo.listJobs(projectId).filter((j) => jobBelongsTo(j, agentId));
    /** The project row and one of its Workspace agents, or a 404. */
    const agentOf = async (id: string, raw: string) => {
        const row = ctx.project(id);
        const a = agentById(raw);
        if (!a || !(await workspaceAgents(store, row))?.includes(a.id)) throw new HttpError(404, NOT_THIS_PROJECTS_AGENT);
        return { row, agent: a };
    };
    const outcomeCtx = (projectId: string, agentId: AgentId): AgentOutcomeCtx => ({ p, projectId, agentId, runs: runsOf(projectId, agentId), appModel });

    app.get("/api/projects/:id/workspace", async (req) => {
        const { id } = req.params as { id: string };
        const row = ctx.project(id);
        const chosen = await workspaceAgents(store, row);
        if (!chosen) return { workspace: false, agents: [] };
        const only = (req.query as { agent?: unknown }).agent;
        const going = repo.listJobs(id).filter((j) => !TERMINAL_STATES.includes(j.status)).map((j) => j.id);
        const stamp = await resultsStamp(p.db.sql, id, going);
        const agents = [];
        for (const agentId of chosen) {
            if (typeof only === "string" && only && only !== agentId) continue;
            const a = agentById(agentId)!;
            const c = outcomeCtx(id, agentId);
            const needs = await needsOf(row, agentId);
            const module = AGENT_OUTCOMES[agentId];
            let headline: string | null = null;
            try {
                if (module && c.runs.length) headline = await headlineOf(id, agentId, c.runs, stamp, async () => module.headline(await module.outcome(c)));
            } catch (err) {
                // One agent's outcome that cannot be read leaves its card without a headline; the Workspace still shows.
                console.error(`[agents] the ${agentId} outcome of project ${id.slice(0, 8)} could not be read:`, err);
            }
            agents.push({ id: agentId, name: a.name, summary: a.summary, status: agentStatusOf(c.runs[0], needs), needs, runs: c.runs.length, lastRun: c.runs[0] ? ctx.publicJob(c.runs[0]) : null, headline });
        }
        return { workspace: true, agents };
    });

    app.get("/api/projects/:id/workspace/:agentId/outcome", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const { agent } = await agentOf(id, agentId);
        const module = AGENT_OUTCOMES[agent.id];
        if (!module) throw new HttpError(501, outcomeNotBuilt(agent.name));
        const c = outcomeCtx(id, agent.id);
        const run = (req.query as { run?: unknown }).run;
        if (typeof run === "string" && run) {
            const one = c.runs.some((j) => j.id === run) ? await module.runOutcome(c, run) : undefined;
            if (!one) throw new HttpError(404, NO_SUCH_AGENT_RUN);
            return one;
        }
        return module.outcome(c);
    });

    app.get("/api/projects/:id/workspace/:agentId/runs", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const { agent } = await agentOf(id, agentId);
        return runsOf(id, agent.id).map(ctx.publicJob);
    });
}
