/**
 * Round 52: the platform end of an AI agent run on a runner (docs/features/explore-on-runner.md). The runner's child runs pursueObjective
 * (src/agent/agent-mode.ts) and sends what the run records through the explore sink route (explore-sink.ts hands these calls here, after the
 * route checked the runner token, the task's owner and its attempt).
 *
 * The run is always the job's own (its options.agentRunId): no run id is taken from the runner, an approval id is answered only when it is one
 * of that run, and a step's picture is counted against the attempt's file cap like every other file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SinkCall, WireFile } from "../agent-protocol/explore-sink.js";
import type { ObjectiveOutcome } from "../engine/agent/objective.js";
import { AgentRunStore } from "./agent-run-store.js";
import type { Platform } from "./bootstrap.js";
import type { ExploreTaskRef } from "./explore-task.js";
import { HttpError } from "./http-error.js";

type AgentCall = Extract<SinkCall, { method: "agentStep" | "agentTokens" | "agentApproval" | "approvalState" | "agentOutcome" }>;
/** What the runner said at the end, kept until the job's runAgentJob takes it (keyed by run id). */
const outcomes = new Map<string, Omit<ObjectiveOutcome, "steps">>();

/** The outcome the runner sent for this run, once (undefined when it sent none). */
export function takeAgentOutcome(runId: string): Omit<ObjectiveOutcome, "steps"> | undefined {
    const o = outcomes.get(runId);
    outcomes.delete(runId);
    return o;
}

export async function applyAgentCall(p: Platform, task: ExploreTaskRef, receive: (files: WireFile[]) => Promise<{ dir: string; paths: string[] }>, c: AgentCall): Promise<unknown> {
    const job = p.repo.getJob(task.jobId);
    const runs = new AgentRunStore(p.repo.db.sql);
    const run = job?.options.mode === "agent" && job.options.agentRunId ? await runs.get(job.options.agentRunId) : undefined;
    if (!job || !run || run.projectId !== task.projectId || run.jobId !== job.id) throw new HttpError(400, "This task is not an agent run.");
    switch (c.method) {
        case "agentStep": {
            const { picture, ...s } = c.s;
            let screenshotId: string | undefined;
            if (picture) {
                // Counted and checked like every file a runner sends; stored through the normal artifact path.
                const got = await receive([picture]);
                try {
                    const rel = path.posix.join(job.projectId, "_artifacts", job.id, `agent-step-${String(s.seq).padStart(3, "0")}.jpg`);
                    const saved = await p.store.put(rel, await fs.readFile(got.paths[0]!), { contentType: "image/jpeg" });
                    screenshotId = p.repo.addArtifact({ projectId: job.projectId, jobId: job.id, kind: "vision-shot", path: rel, size: saved.size });
                } finally {
                    await fs.rm(got.dir, { recursive: true, force: true }).catch(() => undefined);
                }
            }
            await runs.addStep(run.id, { ...s, ...(screenshotId ? { screenshotId } : {}) });
            return null;
        }
        case "agentTokens":
            await runs.setTokens(run.id, c.used);
            return null;
        case "agentApproval":
            return (await runs.openApproval(run.id, c.r)).id;
        case "approvalState": {
            const asked = await runs.approval(c.id);
            if (!asked || asked.runId !== run.id) throw new HttpError(400, "The runner named an approval this run did not ask for.");
            if (asked.state !== "pending") return asked.state;
            // As on a server worker (agent-run.ts waitForPerson): a stop or the time limit decides, unless a person's answer came first.
            const state = p.repo.isCancelRequested(job.id) ? "stopped" : Date.now() >= Date.parse(asked.expiresAt) ? "timed_out" : undefined;
            if (!state) return "pending";
            if (await runs.decide(asked.id, state)) return state;
            return (await runs.approval(asked.id))?.state ?? state;
        }
        case "agentOutcome":
            outcomes.set(run.id, c.o);
            return null;
    }
}
