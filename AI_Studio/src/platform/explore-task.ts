/**
 * Round 51: an exploration job runs on the runner of the person who started it (docs/features/explore-on-runner.md).
 *
 * The dispatch worker still looks after the job (runJobAs in job-runner.ts: lease, cancel, time limit, final status). In runners mode it hands the
 * engine's `runGeneration` to that person's runner as one `explore` task and waits for it, like a run waits for its scripts (agent-services.ts
 * RemoteExecutor). While the task runs, the runner's child process calls the job's AI through POST .../explore/llm (explore-llm.ts) and saves
 * through POST .../explore/sink (explore-sink.ts); routes/agents.ts checks the runner token, the task's owner and its attempt first.
 *
 * The wait itself is explore-dispatch.ts (this file has no runtime imports of the platform, so every part may import it).
 *
 * Unlike a run, an explore task is never offered again: its browser, its sign-in and the AI's place in the work are on that computer. A runner
 * that stops answering fails the job with a plain sentence, and so does a platform restart (the AI's per-task state is in this process).
 */
import { TaskOffer, type ExploreTask } from "../agent-protocol/schema.js";
import type { GenerationRequest } from "../engine/orchestrator.js";
import type { JobRow } from "./repo.js";

/** The task the explore routes hand to the llm and sink handlers. The route has already checked the token, the owner and the attempt. */
export type ExploreTaskRef = {
    taskId: string;
    attempt: number;
    jobId: string;
    projectId: string;
    agentId: string;
};

/** agent_tasks.adapter_id of an exploration (not a framework adapter: offerTo and the sweep treat it apart). */
export const EXPLORE_ADAPTER_ID = "explore";
export const isExploreAdapter = (adapterId: string): boolean => adapterId === EXPLORE_ADAPTER_ID;

export const exploreNeedsUpdate = (runner: string): string => `Your runner “${runner}” is too old to explore an application. Update your runner in Settings, Your runner, then try again.`;
export const EXPLORE_RUNNER_GONE = "Your runner stopped answering while it explored, so the exploration ended. Its browser went with it, so the work is not moved to another computer. Start the exploration again.";
export const EXPLORE_PLATFORM_RESTART = "The platform restarted while your runner explored, so the exploration ended. Start it again.";
export const EXPLORE_NO_SUMMARY = "Your runner finished the exploration but did not say what it found. Update your runner in Settings, Your runner, then try again.";
/** Phone apps are not explored on a runner yet: the phone explorer drives the phone from the platform (agent-device.ts). */
export const PHONE_EXPLORE_ON_RUNNERS = "Exploring a phone app is not available here yet: this platform runs tests only on runners. Explore the website or API instead, or record the phone test on your runner.";

/** Why this computer cannot explore (its runner program is older than round 51), or undefined. */
export function exploreProblem(agent: { name: string; capabilities: { explore?: boolean } }): string | undefined {
    return agent.capabilities.explore === true ? undefined : exploreNeedsUpdate(agent.name);
}

/** Every secret the request carries, as exact strings (the runner masks them in what it logs and sends; the platform scrubs its lines). */
export function requestSecrets(req: GenerationRequest, more: string[] = []): string[] {
    const c = req.credentials;
    const out = [c?.password, c?.totpSecret, c?.apiToken, c?.apiAuthHeader, c?.oauth2?.clientSecret, ...(req.roles ?? []).flatMap((r) => [r.password, r.totpSecret, r.apiToken]), ...more];
    // A saved sign-in's cookies and stored values are secrets too.
    const state = req.savedSession?.storageState as { cookies?: Array<{ value?: unknown }>; origins?: Array<{ localStorage?: Array<{ value?: unknown }> }> } | undefined;
    for (const k of state?.cookies ?? []) out.push(typeof k.value === "string" ? k.value : undefined);
    for (const o of state?.origins ?? []) for (const v of o.localStorage ?? []) out.push(typeof v.value === "string" ? v.value : undefined);
    return [...new Set(out.filter((s): s is string => typeof s === "string" && s.length >= 4))].slice(0, 500);
}

/** The offer of an explore task: the request as data (the runner adds its own cleanup guard), with everything to mask. */
export function exploreOffer(o: { taskId: string; job: Pick<JobRow, "id">; request: GenerationRequest; modelName: string; frameworkSettings?: unknown; secrets: string[]; leaseSeconds: number }): TaskOffer {
    const { cleanup, ...rest } = o.request;
    const explore: ExploreTask = {
        request: JSON.parse(JSON.stringify(rest)) as Record<string, unknown>,
        modelName: o.modelName.slice(0, 200),
        ...(cleanup?.enabled ? { cleanup: true } : {}),
        ...(o.frameworkSettings !== undefined ? { frameworkSettings: o.frameworkSettings } : {}),
        secrets: o.secrets,
    };
    return TaskOffer.parse({
        taskId: o.taskId,
        jobId: o.job.id,
        adapterId: EXPLORE_ADAPTER_ID,
        kind: "explore",
        leaseSeconds: o.leaseSeconds,
        workers: 1,
        scripts: [],
        // What offerTo checks the private-address switch against, and the runner its own address rule.
        env: { baseUrl: o.request.url, ...(o.request.apiBaseUrl ? { apiBaseUrl: o.request.apiBaseUrl } : {}), headless: true },
        explore,
    });
}

