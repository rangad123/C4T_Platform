/**
 * Round 51: the dispatch worker's side of an exploration on a runner (see explore-task.ts for how it works): send the explore task to the
 * job's starter's runner and wait for its summary, as RemoteExecutor waits for a run (agent-services.ts).
 */
import { randomUUID } from "node:crypto";
import type { ResultRequest, TaskOffer } from "../agent-protocol/schema.js";
import type { EngineEvent } from "../engine/context.js";
import type { GenerationRequest, GenerationSummary } from "../engine/orchestrator.js";
import { RunnerAgentError, type AgentService } from "./agent-services.js";
import { refusalsOf } from "./agent-store.js";
import { forgetExploreLlm } from "./explore-llm.js";
import { exploreRepoSink, forgetExploreSink } from "./explore-sink.js";
import { EXPLORE_ADAPTER_ID, EXPLORE_NO_SUMMARY, EXPLORE_PLATFORM_RESTART, EXPLORE_RUNNER_GONE, exploreOffer, exploreProblem, requestSecrets } from "./explore-task.js";
import type { JobLlmDeps } from "./job-runner.js";
import type { JobRow } from "./repo.js";

/** What builds each exploration's model: the job's own runner deps (the worker's), so the AI is made exactly as for a job on the server. */
const llmDeps = new Map<string, JobLlmDeps>();
/** The deps the explore llm route builds this task's model with (explore-llm.ts), or undefined when this process does not look after it. */
export const exploreLlmDeps = (taskId: string): JobLlmDeps | undefined => llmDeps.get(taskId);

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });

/**
 * Hand the exploration to the job's starter's runner and wait for its summary. Throws "Job cancelled" when the job's signal ends it (a person's
 * stop, the time limit, a lost lease: the task is stopped in every case, never resumed), a RunnerAgentError when the runner could not do it.
 */
export async function exploreOnRunner(
    svc: AgentService,
    o: { deps: JobLlmDeps; job: JobRow; request: GenerationRequest; modelName: string; frameworkSettings?: unknown; signal: AbortSignal; emit: (e: EngineEvent) => void },
): Promise<GenerationSummary> {
    const { job, signal } = o;
    if (signal.aborted) throw new Error("Job cancelled");
    if (svc.draining) throw new RunnerAgentError(EXPLORE_PLATFORM_RESTART);
    const taskId = randomUUID();
    const secrets = requestSecrets(o.request, svc.projectSecrets(job.projectId));
    let offer: TaskOffer;
    try {
        offer = exploreOffer({ taskId, job, request: o.request, modelName: o.modelName, frameworkSettings: o.frameworkSettings, secrets, leaseSeconds: svc.limits.leaseSeconds });
    } catch (e) {
        throw new RunnerAgentError(`This exploration cannot be sent to your runner: ${e instanceof Error ? e.message.split("\n")[0] : "invalid request"}`);
    }
    llmDeps.set(taskId, o.deps);
    svc.store.enqueue({ id: taskId, projectId: job.projectId, jobId: job.id, adapterId: EXPLORE_ADAPTER_ID, payloadEnc: svc.encrypt(offer), files: [] });
    o.emit({ stage: "orchestration", kind: "explore_queued", message: "Sent the exploration to your runner." });
    let stopped = false;
    try {
        return await waitForExplore(svc, taskId, job, o.emit, signal);
    } catch (e) {
        stopped = signal.aborted;
        throw e;
    } finally {
        if (signal.aborted || svc.draining) svc.store.requestCancel(taskId);
        // A stopped exploration is not a verdict on a test: the ones that had no result yet go back to what they were (as runJobAs does on a cancel).
        if (stopped) await exploreRepoSink(taskId)?.restoreInterrupted().catch(() => 0);
        // What the runner saved is stored before the job's final status (runJobAs's finish), and the task's AI state goes with the task.
        await forgetExploreSink(taskId).catch(() => undefined);
        await Promise.resolve(forgetExploreLlm(taskId)).catch(() => undefined);
        llmDeps.delete(taskId);
    }
}

async function waitForExplore(svc: AgentService, taskId: string, job: JobRow, emit: (e: EngineEvent) => void, signal: AbortSignal): Promise<GenerationSummary> {
    const starter = svc.jobStarter(job.id);
    let announced = false;
    let noAgentSince: number | undefined;
    for (;;) {
        if (signal.aborted) throw new Error("Job cancelled");
        if (svc.draining) throw new RunnerAgentError(EXPLORE_PLATFORM_RESTART);
        svc.sweep();
        const t = svc.store.getTask(taskId);
        if (!t) throw new RunnerAgentError("The exploration was removed before it finished.");
        if (t.status === "queued") {
            // The same rules as offering: the starter's own runner, online, and one that can explore.
            const own = svc.ownRunner(starter.ownerId, job.projectId);
            const a = own?.online ? own.agent : undefined;
            const refused = new Set(refusalsOf(t).map((r) => r.agentId));
            if (a && !refused.has(a.id) && !exploreProblem(a)) noAgentSince = undefined;
            else if (refusalsOf(t).length > 0) {
                const reasons = [...new Map(refusalsOf(t).map((r) => [r.agentId, r.message])).values()].join(" ");
                svc.store.failQueuedOrRunning(taskId, `Your runner did not take the exploration. ${reasons}`.slice(0, 1000), "rejected");
            } else if (a && exploreProblem(a)) svc.store.failQueuedOrRunning(taskId, exploreProblem(a)!, "rejected");
            else {
                noAgentSince ??= svc.clock();
                if (svc.clock() - noAgentSince >= svc.limits.noAgentGraceMs) svc.store.failQueuedOrRunning(taskId, svc.noRunnerSentence(job.id));
            }
        } else if (t.status === "running") {
            if (!announced) {
                announced = true;
                const a = t.agentId ? svc.store.getAgent(t.agentId) : undefined;
                emit({ stage: "orchestration", kind: "explore_on_runner", message: `Exploring on your runner “${(a ? svc.runnerName(a) : undefined) ?? "your computer"}”.` });
            }
        } else if (t.status === "done") {
            const result = svc.decrypt<ResultRequest>(t.resultEnc!);
            const s = result.explore;
            if (!s) throw new RunnerAgentError(EXPLORE_NO_SUMMARY);
            return { model: (s.model ?? null) as GenerationSummary["model"], testsGenerated: s.testsGenerated, testsValidated: s.testsValidated, testsFailedValidation: s.testsFailedValidation, testsNeedingReview: s.testsNeedingReview, errors: s.errors, ...(s.plan ? { plan: s.plan as GenerationSummary["plan"] } : {}) };
        } else if (t.status === "cancelled") {
            throw new Error("Job cancelled");
        } else {
            if (t.phase === "lost_connection") throw new RunnerAgentError(EXPLORE_RUNNER_GONE);
            const unclaimed = t.phase === "timed_out" && !t.agentId;
            throw new RunnerAgentError(unclaimed ? svc.noRunnerSentence(job.id) : (t.error ?? "Your runner could not explore the application."));
        }
        await sleep(svc.limits.watchMs, signal);
    }
}
