/**
 * The run policy for code tests: THE security boundary of the feature.
 *
 * A hand-written script is arbitrary code. It may run only where its owner agreed:
 *   - on the platform host, only when the platform was started with ALLOW_CUSTOM_SCRIPTS=true (default off) and not with Crowd4Test sign-in (config.ts), or
 *   - on a runner agent that reports `customScripts: true`, which it does only when it was started with --allow-custom-scripts.
 *
 * One decision function (`customRunDecision`) is used everywhere a run is created. Layers, outside in:
 *   1. `Repo.createJob` (every job, whoever creates it: a person, a schedule, a trigger, a runbook) asks `customGate`: a plain HTTP 409
 *      before a job exists.
 *   2. Schedules, triggers and runbooks leave custom tests out of their runs when they may not run (`customSkippedNote`), the rest still runs.
 *   3. A job whose tests include custom ones gets `CustomPolicyExecutor` around its executor: on this machine it refuses the scripts
 *      (an error result, nothing started) unless the host allows them, and tells the runner it may run them only then.
 *   4. `runScripts` itself refuses a script marked custom unless it was told `allowCustom`, and checks every custom script and
 *      helper with the guard again. The runner agent does the same with its own flag.
 * So forgetting one layer still fails closed.
 */
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ScriptExecutor } from "../engine/frameworks/types.js";
import type { ScriptRun } from "../engine/validation/runner.js";
import type { Platform } from "./bootstrap.js";
import { CustomScriptStore } from "./custom-script-store.js";
import { HttpError } from "./http-error.js";
import { runnerRefusal } from "./runner-only.js";
import type { JobOptions, Repo } from "./repo.js";
import { getAgentServices, jobOwnerId, ownerOfNewJob, type RunContext } from "./agent-services.js";

export const CUSTOM_REFUSAL = "This project has code tests, and no runner is set up for this run. Set up your runner in Settings (with code scripts switched on), or set ALLOW_CUSTOM_SCRIPTS=true on the server.";
const AGENT_REFUSAL = "This project has code tests, and code scripts are switched off on your runner. Switch them on for your runner in Settings.";
const HOST_REFUSAL = "This project has code tests, and this server does not run them. Set ALLOW_CUSTOM_SCRIPTS=true on the server, or run the project on a runner agent started with --allow-custom-scripts.";

export interface PolicyInput {
    /** ALLOW_CUSTOM_SCRIPTS on the platform. */
    hostAllowed: boolean;
    /** The project's scripts run on a runner agent. */
    runsOnAgent: boolean;
    /** The agents that may take the project's work (online, and the chosen one if the project picked one). */
    agents: ReadonlyArray<{ customScripts?: boolean }>;
    /** Why the switch was asked for but is not in force (ALLOW_CUSTOM_SCRIPTS without an API_KEY), appended to the refusal so the person knows what to fix. */
    hostNote?: string;
}

export type PolicyDecision = { allowed: true } | { allowed: false; message: string };

/** Pure: may a hand-written script run for this project right now? */
export function customRunDecision(i: PolicyInput): PolicyDecision {
    if (i.runsOnAgent) {
        // Only an agent that said so, with its own flag, ever receives one. The platform's switch does not widen that.
        if (i.agents.some((a) => a.customScripts === true)) return { allowed: true };
        return { allowed: false, message: i.agents.length > 0 ? AGENT_REFUSAL : CUSTOM_REFUSAL };
    }
    return i.hostAllowed ? { allowed: true } : { allowed: false, message: i.hostNote ? `${HOST_REFUSAL} ${i.hostNote}` : HOST_REFUSAL };
}

/** The decision for a project, from the live platform (config and runner agents). */
export function customPolicyFor(p: Pick<Platform, "config" | "db" | "repo"> & Partial<Platform>, projectId: string, who?: RunContext): PolicyDecision {
    const svc = getAgentServices(p as Platform);
    const runsOnAgent = svc.routesToAgent(projectId);
    return customRunDecision({
        // The effective value: ALLOW_CUSTOM_SCRIPTS counts only with an API_KEY (config.ts).
        hostAllowed: p.config?.ALLOW_CUSTOM_SCRIPTS === true,
        ...(p.config?.customScriptsReason ? { hostNote: p.config.customScriptsReason } : {}),
        runsOnAgent,
        // The same rule as offering (agent-services.ts mayRunCodeScripts): the owner's switch for their runner, as it last reported itself,
        // online or not (an offline runner is the job gate's refusal, or a schedule's wait, never a silent drop of its code tests).
        agents: runsOnAgent ? svc.lastKnownRunner(projectId, who).map((a) => ({ customScripts: svc.mayRunCodeScripts(a) })) : [],
    });
}

/** The test ids of a job that are hand-written (jobs that run existing tests only; a generate job runs none). */
export function customIdsOfJob(repo: Repo, options: JobOptions): string[] {
    const mode = options.mode ?? "generate";
    if (mode !== "validate" && mode !== "environment" && mode !== "variants") return [];
    return new CustomScriptStore(repo.db).customAmong(options.testIds ?? []);
}

/** Checked by `Repo.createJob`: a plain 409 when the job includes code tests that may not run. */
export function customGate(p: Platform, projectId: string, options: JobOptions): void {
    if (customIdsOfJob(p.repo, options).length === 0) return;
    const d = customPolicyFor(p, projectId, { ownerId: ownerOfNewJob(options) });
    // On a runner the refusal is about the person's own runner, so it carries the code that links to Settings.
    if (!d.allowed) throw getAgentServices(p).routesToAgent(projectId) ? runnerRefusal("RUNNER_CANNOT_RUN", d.message) : new HttpError(409, d.message);
}

/** Install the gate (and the lookup schedules and runbooks use) on the platform's repository. */
export function installCustomGate(p: Platform): void {
    p.repo.customGate = async (projectId, options) => customGate(p, projectId, options);
    p.repo.customPolicy = async (projectId, ownerId) => customPolicyFor(p, projectId, { ownerId: ownerId ?? null });
}

/**
 * For automated runs (schedules, triggers, runbooks): the tests among `ids` that may run, the hand-written ones left out when they may
 * not, and a plain sentence saying so (undefined when nothing was left out).
 */
export async function splitCustom(repo: Repo, projectId: string, ids: readonly string[], ownerId?: string | null): Promise<{ ids: string[]; skipped: string[]; note?: string }> {
    const customIds = new CustomScriptStore(repo.db).customAmong(ids);
    if (customIds.length === 0 || !repo.customPolicy) return { ids: [...ids], skipped: [] };
    const d = await repo.customPolicy(projectId, ownerId);
    if (d.allowed) return { ids: [...ids], skipped: [] };
    const drop = new Set(customIds);
    return {
        ids: ids.filter((i) => !drop.has(i)),
        skipped: customIds,
        note: `${customIds.length} code test${customIds.length === 1 ? " was" : "s were"} not run. ${d.message}`,
    };
}

// ── the executor wrapper (layer 3) ───────────────────────────────────────────

const refused = (testId: string, message: string): ScriptRun => ({ testId, status: "error", durationMs: 0, error: message, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

class CustomPolicyExecutor implements ScriptExecutor {
    constructor(
        private readonly inner: ScriptExecutor,
        private readonly hostAllowed: boolean,
    ) {}

    get name(): string {
        return this.inner.name;
    }
    get remote(): boolean | undefined {
        return this.inner.remote;
    }

    async execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        if (!batch.scripts.some((s) => s.custom)) return this.inner.execute(adapterId, batch, env, opts);
        // On a runner agent the agent decides (it was offered the scripts only if it reported the capability) and checks again itself.
        if (this.inner.remote) return this.inner.execute(adapterId, batch, env, opts);
        if (this.hostAllowed) return this.inner.execute(adapterId, batch, env, { ...opts, allowCustom: true });
        // Not allowed on this machine: the code tests are not started; the others run as they would have.
        const out: ScriptRun[] = new Array(batch.scripts.length);
        const rest = batch.scripts.flatMap((s, i) => (s.custom ? (void (out[i] = refused(s.testId, HOST_REFUSAL)), []) : [i]));
        if (rest.length) {
            const runs = await this.inner.execute(adapterId, { ...batch, scripts: rest.map((i) => batch.scripts[i]!) }, env, opts);
            rest.forEach((i, k) => (out[i] = runs[k]!));
        }
        return out;
    }
}

/** The executor with the run policy applied. Returns `inner` itself when `needed` is false (no code test in the run). */
export function withCustomPolicy(inner: ScriptExecutor, hostAllowed: boolean, needed: boolean): ScriptExecutor {
    return needed ? new CustomPolicyExecutor(inner, hostAllowed) : inner;
}

/** The plain sentence for a run that left code tests out because they may not run (undefined when none were left out). */
export async function customSkippedNote(repo: Repo, projectId: string, ownerId?: string | null): Promise<string | undefined> {
    if (!repo.customPolicy) return undefined;
    const d = await repo.customPolicy(projectId, ownerId);
    if (d.allowed) return undefined;
    const n = new CustomScriptStore(repo.db).countInProject(projectId);
    return n > 0 ? `${n} code test${n === 1 ? " was" : "s were"} not run. ${d.message}` : undefined;
}

/** Writes that sentence onto a job (an event), when there is one. Never throws. */
export async function noteCustomSkipped(repo: Repo, jobId: string, projectId: string): Promise<void> {
    try {
        // The job's owner (whose runner runs it): their runner's code-scripts switch decides.
        const job = repo.getJob(jobId);
        const message = await customSkippedNote(repo, projectId, job ? jobOwnerId(job.options) : null);
        if (message) repo.addEvent(jobId, { stage: "validation", kind: "custom_skipped", level: "warn", message });
    } catch {
        /* a note is a convenience */
    }
}
