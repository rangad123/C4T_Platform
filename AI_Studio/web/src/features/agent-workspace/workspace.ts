/**
 * The Agent Workspace on the web side (src/platform/routes/agent-workspace.ts; .scratch/agent-workspace/SPEC.md). A project has it when it
 * is tested by the AI agent alone and its agents are chosen (the same rule as the server's agent-workspace.ts workspaceAgents): its landing
 * is the Workspace and each agent has its own page. Every other project keeps its Dashboard.
 */
import type { Job } from "../../api";
import type { Tone } from "../../lib/labels";
import { progressPercent } from "../../lib/labels";
import { relativeTime } from "../../lib/format";
import type { AgentId } from "../testing-agents/testing-agents";

export type AgentStatus = "not-run" | "running" | "done" | "stopped" | "failed" | "needs-input";

/** One card: GET /api/projects/:id/workspace `agents[]`. */
export interface WorkspaceAgent {
    id: AgentId;
    name: string;
    summary: string;
    status: AgentStatus;
    /** What it cannot run without, as sentences (status needs-input). */
    needs: string[];
    runs: number;
    lastRun: Job | null;
    headline: string | null;
}
export interface WorkspaceAnswer {
    workspace: boolean;
    agents: WorkspaceAgent[];
}

/** True when a project of these modes and this agent choice (GET /testing-agents) has the Workspace. */
export const hasWorkspace = (modes: readonly string[], agents: { applies: boolean; source: string } | undefined): boolean => modes.includes("agent") && !modes.includes("code") && agents?.applies === true && agents.source === "chosen";

/** The status as the card says it (SPEC §1): Not run yet, Running n%, Done (when), Stopped (what it found is kept), Failed, Needs input. */
export function statusWords(a: Pick<WorkspaceAgent, "status" | "lastRun">): { label: string; tone: Tone } {
    const run = a.lastRun;
    switch (a.status) {
        case "running":
            return { label: `Running ${run ? progressPercent(run) : 0}%`, tone: "info" };
        case "done":
            return { label: `Done ${relativeTime(run?.finishedAt ?? run?.createdAt)}`, tone: "success" };
        case "stopped":
            return { label: "Stopped, what it found is kept", tone: "warning" };
        case "failed":
            return { label: "Failed", tone: "danger" };
        case "needs-input":
            return { label: "Needs input", tone: "warning" };
        default:
            return { label: "Not run yet", tone: "neutral" };
    }
}
