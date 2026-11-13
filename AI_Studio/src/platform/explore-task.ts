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
/**
 * Round 52: the job kinds that run on a runner as an explore task. "generate" is an exploration; the others need `exploreModes`: "plain" and
 * "agent" (builder A), "mobile" (an exploration of a phone app, on the phone attached to the runner) and "assessment" (a security assessment,
 * src/security/assessment/on-runner.ts: its task has no job).
 */
export type ExploreMode = "generate" | "plain" | "agent" | "mobile" | "assessment";
export const isExploreMode = (mode: string | undefined): mode is ExploreMode => mode === undefined || mode === "generate" || mode === "plain" || mode === "agent" || mode === "mobile" || mode === "assessment";
const MODE_WORDS: Record<Exclude<ExploreMode, "generate">, string> = {
    plain: "build a test from your description",
    agent: "do an agent run",
    mobile: "explore a phone app",
    assessment: "run a security assessment",
};
export const modeNeedsUpdate = (runner: string, mode: Exclude<ExploreMode, "generate">): string => `Your runner “${runner}” is too old to ${MODE_WORDS[mode]}. Update your runner in Settings, Your runner, then try again.`;

/** Why this computer cannot do this kind of job (its runner program is older than round 51, or round 52 for the other modes), or undefined. */
export function exploreProblem(agent: { name: string; capabilities: { explore?: boolean; exploreModes?: string[] } }, mode: ExploreMode = "generate"): string | undefined {
    if (agent.capabilities.explore !== true) return mode === "generate" ? exploreNeedsUpdate(agent.name) : modeNeedsUpdate(agent.name, mode);
    if (mode === "generate" || agent.capabilities.exploreModes?.includes(mode)) return undefined;
    return modeNeedsUpdate(agent.name, mode);
}

/** An exploration job's mode on a runner: "mobile" when its targets include a phone app (the request's own targets), else the job's. */
export const exploreModeOfRequest = (mode: ExploreMode | undefined, request: { targets?: unknown }): ExploreMode =>
    (mode ?? "generate") === "generate" && Array.isArray(request.targets) && request.targets.includes("mobile") ? "mobile" : (mode ?? "generate");

/** The mode of an explore task's offer (absent: an exploration). */
export const offerMode = (offer: { explore?: { mode?: ExploreMode } }): ExploreMode => offer.explore?.mode ?? "generate";

/** Every secret the request carries, as exact strings (the runner masks them in what it logs and sends; the platform scrubs its lines). */
export function requestSecrets(req: Partial<Pick<GenerationRequest, "credentials" | "roles" | "savedSession">>, more: string[] = []): string[] {
    const c = req.credentials;
    const out = [c?.password, c?.totpSecret, c?.apiToken, c?.apiAuthHeader, c?.oauth2?.clientSecret, ...(req.roles ?? []).flatMap((r) => [r.password, r.totpSecret, r.apiToken]), ...more];
    // A saved sign-in's cookies and stored values are secrets too.
    const state = req.savedSession?.storageState as { cookies?: Array<{ value?: unknown }>; origins?: Array<{ localStorage?: Array<{ value?: unknown }> }> } | undefined;
    for (const k of state?.cookies ?? []) out.push(typeof k.value === "string" ? k.value : undefined);
    for (const o of state?.origins ?? []) for (const v of o.localStorage ?? []) out.push(typeof v.value === "string" ? v.value : undefined);
    return [...new Set(out.filter((s): s is string => typeof s === "string" && s.length >= 4))].slice(0, 500);
}

/**
 * What an explore task carries, by mode: the engine's GenerationRequest (generate), PlainRequest (plain), or the agent run's facts (agent,
 * AgentOnRunnerRequest in agent-on-runner.ts). Each has the address it works on as `url`, so the offer's address rules apply to all three.
 */
export type ExploreRequest = { url: string; apiBaseUrl?: string; cleanup?: { enabled: boolean } };

/** The offer of an explore task: the request as data (the runner adds its own cleanup guard), with everything to mask. */
/** Whether the work drives a web browser that "Show the browser while exploring" can make visible: an exploration of a web app, a web test described in words. */
export function showsBrowserWindow(mode: ExploreMode, request: { kind?: unknown }): boolean {
    return mode === "generate" || (mode === "plain" && request.kind !== "api");
}

export function exploreOffer(o: { taskId: string; job: Pick<JobRow, "id">; mode?: ExploreMode; request: ExploreRequest; modelName: string; frameworkSettings?: unknown; secrets: string[]; leaseSeconds: number; showBrowser?: boolean }): TaskOffer {
    const { cleanup, ...rest } = o.request;
    const mode = o.mode ?? "generate";
    const explore: ExploreTask = {
        ...(mode !== "generate" ? { mode } : {}),
        request: JSON.parse(JSON.stringify(rest)) as Record<string, unknown>,
        modelName: o.modelName.slice(0, 200),
        ...(cleanup?.enabled ? { cleanup: true } : {}),
        ...(o.frameworkSettings !== undefined ? { frameworkSettings: o.frameworkSettings } : {}),
        ...(o.showBrowser === true && showsBrowserWindow(mode, o.request as { kind?: unknown }) ? { showBrowser: true } : {}),
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

