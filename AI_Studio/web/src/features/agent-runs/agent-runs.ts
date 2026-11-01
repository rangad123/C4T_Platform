import type { Tone } from "../../lib/labels";

export type AgentRunState = "queued" | "running" | "waiting_approval" | "finished" | "stopped";
export type AgentVerdict = "passed" | "failed" | "blocked" | "inconclusive";
export type FailureCategory = "application" | "agent" | "environment" | "runner";

export interface AgentRun {
    id: string;
    projectId: string;
    jobId: string;
    objective: string;
    successCriteria: string | null;
    environment: string | null;
    startAddress: string;
    /** `budgetTokens` is left out for anyone who may not see AI usage. */
    limits: { maxSteps: number; maxMinutes: number; budgetTokens?: number; approvalSeconds: number };
    state: AgentRunState;
    verdict: AgentVerdict | null;
    reasoning: string | null;
    stopReason: string | null;
    failureCategory: FailureCategory | null;
    stepsTaken: number;
    /** Left out for anyone who may not see AI usage. */
    inputTokens?: number;
    outputTokens?: number;
    startedBy: { id: string | null; name: string };
    draftTestId: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface AgentRunStep {
    seq: number;
    tool: string;
    summary: string;
    status: "done" | "failed" | "refused";
    detail: string | null;
    url: string;
    screenshotId: string | null;
    at: string;
}

export interface AgentApproval {
    id: string;
    action: string;
    kind: "delete" | "pay" | "send" | "submit";
    why: string;
    url: string;
    state: "pending" | "approved" | "refused" | "timed_out" | "stopped";
    expiresAt: string;
    decidedBy: string | null;
    decidedAt: string | null;
}

export interface AgentRunDetail extends AgentRun {
    steps: AgentRunStep[];
    approvals: AgentApproval[];
    /** The person reading may answer approval requests (a Project Admin who may approve tests). */
    canApprove?: boolean;
}

type Bounds = { min: number; max: number; default: number };

export interface AgentRunList {
    runs: AgentRun[];
    canStart: { ok: true } | { ok: false; reason: string };
    agentModeOn: boolean;
    whereItRuns: string;
    /** `budgetTokens` is left out for anyone who may not see AI usage. */
    limits: { steps: Bounds; minutes: Bounds; budgetTokens?: Bounds; approvalSeconds: Bounds };
    address: string | null;
    environments: string[];
}

export const isActive = (r: Pick<AgentRun, "state">): boolean => r.state === "queued" || r.state === "running" || r.state === "waiting_approval";

const STATE_WORDS: Record<AgentRunState, { label: string; tone: Tone }> = {
    queued: { label: "Queued", tone: "neutral" },
    running: { label: "Running", tone: "info" },
    waiting_approval: { label: "Waiting for approval", tone: "warning" },
    finished: { label: "Finished", tone: "neutral" },
    stopped: { label: "Stopped", tone: "neutral" },
};

const VERDICT_WORDS: Record<AgentVerdict, { label: string; tone: Tone; help: string }> = {
    passed: { label: "Passed", tone: "success", help: "The agent reached the objective, and at least one check of the page passed." },
    failed: { label: "Failed", tone: "danger", help: "A check of the page failed: the application does not do what the objective expects." },
    blocked: { label: "Blocked", tone: "warning", help: "The agent could not get further." },
    inconclusive: { label: "Inconclusive", tone: "neutral", help: "This run does not show whether the objective can be reached." },
};

export const CATEGORY_WORDS: Record<FailureCategory, string> = {
    application: "The application",
    agent: "The agent",
    environment: "The environment",
    runner: "The computer running it",
};

export const APPROVAL_WORDS: Record<AgentApproval["state"], string> = {
    pending: "Waiting",
    approved: "Approved",
    refused: "Refused",
    timed_out: "Nobody answered in time",
    stopped: "Run stopped",
};

/** The badge of a run: its result once it has one, otherwise where it is. */
export function runBadge(r: Pick<AgentRun, "state" | "verdict">): { label: string; tone: Tone; help?: string } {
    if (r.verdict) {
        const v = VERDICT_WORDS[r.verdict];
        return r.state === "stopped" ? { ...v, label: `Stopped, ${v.label.toLowerCase()}` } : v;
    }
    return STATE_WORDS[r.state];
}
