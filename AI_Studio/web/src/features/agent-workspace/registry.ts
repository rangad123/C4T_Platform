/**
 * Each testing agent's screens on its agent page (AgentPage.tsx), one file per agent in ./agents (CONTRACT.md in
 * .scratch/agent-workspace/). A builder fills only its own agent's file; a part left out falls back to the page's plain default.
 */
import type { ComponentType } from "react";
import type { AgentId } from "../testing-agents/testing-agents";
import type { WorkspaceAgent } from "./workspace";
import { view as accessibility } from "./agents/accessibility";
import { view as api } from "./agents/api";
import { view as performance } from "./agents/performance";
import { view as responsiveUi } from "./agents/responsive-ui";
import { view as security } from "./agents/security";
import { view as testGeneration } from "./agents/test-generation";
import { view as ux } from "./agents/ux";

export interface AgentView {
    /** The Outcome tab: this agent's result only (GET /api/projects/:id/workspace/:agentId/outcome). */
    Outcome: ComponentType<{ projectId: string }>;
    /** The Runs tab; default: the list of this agent's runs (GET …/workspace/:agentId/runs). */
    Runs?: ComponentType<{ projectId: string }>;
    /** One of its runs (`#/projects/:id/agents/:agentId/runs/:jobId`); default: the run page every project has. */
    Run?: ComponentType<{ projectId: string; jobId: string }>;
    /** What it uses, on the Settings tab under its saved defaults: this agent's inputs only; default: what the agent needs, with where each is kept. */
    Setup?: ComponentType<{ projectId: string }>;
    /** What its Workspace card shows below the summary; default: the card's one line (headline). */
    Card?: ComponentType<{ projectId: string; agent: WorkspaceAgent }>;
}

/** By agent id; null: not built yet (the Outcome tab says so). Edit an agent's own file, never this map. */
export const AGENT_VIEWS: Record<AgentId, AgentView | null> = {
    api,
    accessibility,
    security,
    chatbot: null,
    "responsive-ui": responsiveUi,
    ux,
    performance,
    "test-generation": testGeneration,
};
