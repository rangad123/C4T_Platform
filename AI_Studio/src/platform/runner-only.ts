/**
 * EXECUTION_MODE=runners: the hosted platform runs tests only on runners (docs/features/runner-only-mode.md).
 *
 * In this mode the server never runs test code and never opens a browser for a run:
 *  - every project routes to runners, whatever its stored setting says (agent-store.ts `getRunner`); the stored setting is kept as it is;
 *  - an exploration runs on the runner of the person who started it, the AI staying on the server (round 51, explore-task.ts); one a schedule
 *    or a deploy trigger starts goes to its creator's runner, and so do a test described in words, an agent run and an exploration of a
 *    phone app (on the phone attached to that runner) (round 52);
 *  - a security assessment runs as a whole on its starter's runner, its checks leaving from there (src/security/assessment/on-runner.ts);
 *  - a dispatch worker in the API process takes only the jobs a runner can do and looks after several at once (worker.ts);
 *  - as the last line, the server's own browser launches and its local script runs throw, so a path that was missed fails loudly
 *    instead of running here. A report PDF is the one exception: the platform's own static page, scripts off (pdf.ts).
 *
 * `local` (the default) keeps everything as it was.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { Config } from "../config.js";
import { refuseLocalExecution } from "../engine/frameworks/executor.js";
import type { AgentService } from "./agent-services.js";
import type { Platform } from "./bootstrap.js";
import { HttpError } from "./http-error.js";
import { EXPLORE_ADAPTER_ID, exploreProblem } from "./explore-task.js";
import type { JobMode, JobOptions } from "./repo.js";

export const runnersOnly = (config: Pick<Config, "EXECUTION_MODE">): boolean => config.EXECUTION_MODE === "runners";

/**
 * Jobs a runner can do: the ones that only run existing tests (their scripts go to a runner), and from round 51 an exploration ("generate"),
 * which goes to the starter's runner as a whole (explore-task.ts); from round 52 a test described in words ("plain") and an agent run ("agent"),
 * the same way. Nothing in them needs this server's browser.
 */
export const RUNNER_JOB_MODES: readonly JobMode[] = ["validate", "variants", "environment", "generate", "plain", "agent"];

/** Databases a dispatch worker in this process is looking after right now (worker.ts adds and removes them; runsCanStartHere asks). */
export const dispatching = new Set<object>();
export const dispatchAlive = (db: object): boolean => dispatching.has(db);

/** A job of a kind no runner does (none is left since round 52; kept for a kind added later). */
export const SERVER_WORK_MESSAGE = "This kind of job is not available here: it would need a browser on the server, and this platform runs tests only on runners.";
/** The dispatch worker is not alive (it starts with the API process): a run started now would wait and never start. */
export const DISPATCH_DOWN_MESSAGE = "Runs cannot start right now: the part of this platform that hands runs to runners is not running. Try again in a minute. If it stays like this, tell the platform's administrator.";
/** No runner this project may use is online (the job gate's answer in this mode). */
/** Round 45: one runner per person, set up in Settings, used for every run of theirs. Where the refusals below send people. */
export const RUNNER_SETTINGS_LINK = "#/settings#runner";
export const RUNNER_NOT_SET_UP = "Set up your runner in Settings to run tests.";
export const RUNNER_OFFLINE = "Your runner is offline. Start it on your computer, then try again.";
/** A run started with the server's shared access key: nobody's, so no runner may take it (a person's own API token is that person). */
export const KEY_HAS_NO_RUNNER = "Runs started with the server's access key have no owner. Use your own API token, so the run goes to your runner.";
export const SCHEDULE_HAS_NO_OWNER = "This schedule has no owner. Open it and save it again to run it on your computer.";
export const TRIGGER_HAS_NO_OWNER = "This deploy trigger has no owner. Make a new deploy trigger token, so its runs go to your computer.";
/**
 * A runner credential the platform does not know (removed, replaced by another computer, or from before migration 57 removed every runner),
 * at every runner route. An installed runner prints it after "The platform no longer accepts this runner." and stops.
 */
export const RUNNER_TOKEN_GONE = "This runner's token is no longer valid: the runner was removed or replaced. Download the new runner in Settings, Your runner, and use that one instead.";
/** The typed refusal codes of a run that cannot start on its owner's runner (details.code), each linkable to Settings. */
export type RunnerRefusalCode = "RUNNER_NOT_SET_UP" | "RUNNER_OFFLINE" | "RUNNER_CANNOT_RUN";
export const runnerRefusal = (code: RunnerRefusalCode, message: string): HttpError => new HttpError(409, message, { code, link: RUNNER_SETTINGS_LINK });
export const NO_RUNNER_MESSAGE = "Your runner is not online, and tests run only on runners here. Start the runner on your computer, or set it up in Settings.";
/** PUT /api/projects/:id/runner with "platform". */
export const PLATFORM_SETTING_REFUSED = "Tests run only on runners on this platform, so a project cannot be set to run on the server. Each run goes to the runner of the person who starts it.";
/** Saved sign-ins: checking or capturing one opens a browser. */
export const SIGN_IN_BROWSER_REFUSED = "Checking or saving a sign-in in a browser is not available here: it would open a browser on the server, and this platform runs tests only on runners. The saved sign-in goes to the runner with the tests, and a test that finds it expired says so.";
/** A recording or a phone session asked for on the server. */
export const ON_SERVER_REFUSED = (what: "Recording" | "A phone session") => `${what} on the server is not available here: this platform runs tests only on runners. Use your runner instead.`;
/** Round 52: the external scanner tools (ZAP, nuclei...) run on the platform's computer, so an assessment on a runner leaves them out and says so. */
export const SCANNERS_NOT_ON_RUNNER = "The external security scanners were not run: they run on the platform's computer, and this assessment ran on your runner, so nothing was sent from the platform.";
/** What the last-line guard throws: a path that should have gone to a runner tried to run here. */
export const SERVER_RUN_REFUSED = "This server does not run tests or open browsers (EXECUTION_MODE=runners): this work should have gone to a runner. Nothing was run here.";

/** Refuse (409) a job that cannot go to a runner. Repo.createJob calls it for every way a job is made. */
export function assertRunsOnRunner(config: Pick<Config, "EXECUTION_MODE">, options: Pick<JobOptions, "mode" | "targets">): void {
    if (!runnersOnly(config)) return;
    const mode = options.mode ?? "generate";
    if (!RUNNER_JOB_MODES.includes(mode)) throw new HttpError(409, SERVER_WORK_MESSAGE, { cannotRunHere: true, executionMode: "runners" });
    // An exploration goes to its starter's runner (round 51), or a schedule's or deploy trigger's creator's (round 52), and so does one of a phone app.
}

/**
 * Round 52: an exploration of a phone app runs on a runner that knows the "mobile" mode. Checked when the owner's runner is online (no runner, or
 * an offline one, is the job gate's refusal, with its own words); whether that runner has a phone is the job gate's adapter check (taqwright).
 */
export function assertPhoneExploreRunner(agents: Pick<AgentService, "ownRunner">, ownerId: string | null, projectId: string, options: Pick<JobOptions, "mode" | "targets" | "fromPlan">): void {
    if ((options.mode ?? "generate") !== "generate" || !options.targets?.includes("mobile")) return;
    const own = agents.ownRunner(ownerId, projectId);
    const agent = own?.online ? own.agent : undefined;
    const why = agent ? exploreProblem(agent, "mobile") : undefined;
    if (why) throw runnerRefusal("RUNNER_CANNOT_RUN", why);
}

/** Cancel the runner tasks of a job's earlier attempt (a job re-queued after its worker was lost): a runner must not run it twice. */
export function cancelRunnerTasksOf(agents: Pick<AgentService, "store">, jobId: string): number {
    let n = 0;
    for (const t of agents.store.tasksOfJob(jobId)) {
        if (t.status !== "queued" && t.status !== "running") continue;
        agents.store.requestCancel(t.id);
        n++;
    }
    return n;
}

// ── the last-line guard ─────────────────────────────────────────────────────

const exempt = new AsyncLocalStorage<true>();
let refusals = 0;
let restore: Array<() => void> | undefined;
const LAUNCHES = ["launch", "launchPersistentContext", "launchServer"] as const;

/** Run `fn` with the server's browser allowed: only for the report PDF (the platform's own static page, scripts off, no address of anyone's). */
export function allowServerBrowser<T>(fn: () => T): T {
    return exempt.run(true, fn);
}

/** How many times the guard refused a browser or a local script run in this process (tests prove it stays 0). */
export function serverRunRefusals(): number {
    return refusals;
}

/**
 * Make this process refuse to run test code or open a browser itself: Playwright's launch functions and the local script executor throw.
 * Process-wide (one process serves one platform in production). `removeServerExecutionGuard` undoes it (tests).
 */
export function installServerExecutionGuard(): void {
    if (restore) return;
    restore = [];
    const pw = createRequire(import.meta.url)("playwright") as typeof import("playwright");
    for (const type of [pw.chromium, pw.firefox, pw.webkit]) {
        for (const name of LAUNCHES) {
            const target = type as unknown as Record<string, unknown>;
            const own = Object.getOwnPropertyDescriptor(target, name);
            const original = target[name] as (...args: unknown[]) => Promise<unknown>;
            target[name] = function guarded(this: unknown, ...args: unknown[]) {
                if (exempt.getStore()) return original.apply(this, args);
                refusals++;
                console.error(`[runners-only] refused to open a ${type.name()} browser on the server`);
                return Promise.reject(new Error(SERVER_RUN_REFUSED));
            };
            restore.push(() => (own ? Object.defineProperty(target, name, own) : delete target[name]));
        }
    }
    refuseLocalExecution(() => {
        refusals++;
        console.error("[runners-only] refused to run test code on the server");
        return new Error(SERVER_RUN_REFUSED);
    });
    restore.push(() => refuseLocalExecution(undefined));
}

export function removeServerExecutionGuard(): void {
    for (const undo of (restore ?? []).reverse()) undo();
    restore = undefined;
}

/**
 * Wiring for one platform (bootstrap.ts). In every mode: a re-queued job's earlier runner tasks are cancelled before it runs again.
 * In runners mode: every project routes to runners, jobs that need the server's browser are refused when they are made, and the guard is on.
 */
export function installRunnerOnly(p: Platform, agents: AgentService): void {
    p.repo.beforeRequeue = (jobId, o) => {
        // A graceful restart hands an exploration over: its task keeps running and the next attempt picks it up (explore-dispatch.ts). Not after a
        // crash, not when the job is given up, and not for an agent run (agent-run.ts never resumes one): then its task is stopped first.
        const keepExplore = o.handedOver && !o.giveUp && p.repo.getJob(jobId)?.options.mode !== "agent";
        if (!keepExplore) for (const t of agents.store.tasksOfJob(jobId)) if (t.adapterId === EXPLORE_ADAPTER_ID && (t.status === "queued" || t.status === "running")) agents.store.requestCancel(t.id);
        const live = agents.store.tasksOfJob(jobId).filter((t) => t.adapterId !== EXPLORE_ADAPTER_ID).filter((t) => t.status === "queued" || (t.status === "running" && !t.cancelRequested));
        // The next attempt picks up a runner task that is still alive, or one whose result is stored (agent-services.ts RemoteExecutor), so
        // the runner's work is neither lost nor done twice. Not when the job is given up, or no longer goes to a runner.
        const projectId = live[0]?.projectId;
        if (!o.giveUp && (!projectId || agents.routesToAgent(projectId))) {
            if (o.handedOver) p.repo.addEvent(jobId, { stage: "orchestration", kind: "runner_job_resumed", message: "The platform is back. It picks this run up where it is on the runner." });
            else if (live.length) p.repo.addEvent(jobId, { stage: "orchestration", kind: "runner_attempt_kept", level: "warn", message: `The platform lost track of this run and takes it up again. The runner's work is kept (${live.length === 1 ? "one task" : `${live.length} tasks`}): it is picked up where it is, and a test is not run again unless it changed meanwhile.` });
            return;
        }
        const n = cancelRunnerTasksOf(agents, jobId);
        if (n) p.repo.addEvent(jobId, { stage: "orchestration", kind: "runner_attempt_cancelled", level: "warn", message: `The platform lost track of this run${o.giveUp ? " and gave it up" : ", so it starts again"}. The runner was told to stop the earlier attempt first (${n === 1 ? "one task" : `${n} tasks`}).` });
    };
    if (!runnersOnly(p.config)) return;
    agents.store.runnersOnly = true;
    p.repo.executionGate = async (projectId, options) => {
        assertRunsOnRunner(p.config, options);
        const { ownerOfNewJob } = await import("./agent-services.js");
        assertPhoneExploreRunner(agents, ownerOfNewJob(options), projectId, options);
    };
    installServerExecutionGuard();
}
