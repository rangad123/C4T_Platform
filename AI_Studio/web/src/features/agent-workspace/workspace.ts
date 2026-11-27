/**
 * The Agent Workspace on the web side (src/platform/routes/agent-workspace.ts; .scratch/agent-workspace/SPEC.md). A project has it when it
 * is tested by the AI agent alone and its agents are chosen (the same rule as the server's agent-workspace.ts workspaceAgents): its landing
 * is the Workspace and each agent has its own page. Every other project keeps its Dashboard.
 */
import type { Job } from "../../api";
import type { Tone } from "../../lib/labels";
import { friendlyError, isActive, runningLabel } from "../../lib/labels";
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

/** One of an agent's runs as its Runs list answers it: a check agent's run with its own one line (what that run found). */
export type AgentRun = Job & { headline?: string | null };

/** What the status of one run is, by the CONTRACT's status rules (the card's words; agent-workspace.ts agentStatusOf). */
export const runStatusOf = (job: Pick<Job, "status" | "error" | "cancelled">): AgentStatus =>
    isActive(job.status) ? "running" : job.status !== "FAILED" ? "done" : job.error === "Cancelled" || job.cancelled ? "stopped" : "failed";

/** Each run status word, explained (the Runs list's key). */
export const RUN_STATUS_HELP: Partial<Record<AgentStatus, string>> = {
    running: "The run is going now.",
    done: "The run finished; what it found is part of the agent's outcome.",
    stopped: "Someone stopped the run; what it found before then is kept.",
    failed: "The run stopped with a problem; the reason is on its page. What it found before then is kept.",
};

/** A queued run, explained: what it waits for. */
export const QUEUED_HELP = "Nothing has started this run yet: it waits for the AI Studio worker, or for your runner when runs go to runners. It starts as soon as one is free.";

/** Why the agent's newest run failed, in the words its run page uses; null unless its status is Failed with a reason. */
export function failedWhy(a: Pick<WorkspaceAgent, "status" | "lastRun">): string | null {
    const e = a.status === "failed" ? a.lastRun?.error : null;
    return e && e !== "Cancelled" ? friendlyError(e).body : null;
}

/** The status as the card says it (SPEC §1): Not run yet, Running n%, Done (when), Stopped (what it found is kept), Failed, Needs input. */
export function statusWords(a: Pick<WorkspaceAgent, "status" | "lastRun">): { label: string; tone: Tone } {
    const run = a.lastRun;
    switch (a.status) {
        case "running":
            return run ? { label: runningLabel(run), tone: run.status === "QUEUED" ? "neutral" : "info" } : { label: "Running 0%", tone: "info" };
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
