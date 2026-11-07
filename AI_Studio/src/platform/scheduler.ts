import { noteCustomSkipped, splitCustom } from "./custom-policy.js";
import { notePluginSkipped, pluginSkips, type RunShape } from "./plugin-policy.js";
import { droppedChecksNote, narrowedByChoice, TestingAgentStore, type AgentSwitch, type AskedSwitches } from "./testing-agents.js";
import { adapterForSpec, needsDevice } from "../engine/frameworks/index.js";
import { localPhoneRunsProblem } from "../engine/mobile/device/choose.js";
import { isAppUri } from "../engine/desktop/target.js";
import { blockView } from "./block-store.js";
import { assertEnvironmentTargets } from "./environment-run.js";
import { findEnvironment, scheduleEnvironment } from "./environments-store.js";
import { agentCanRunIos, agentCanRunMobile, assertRunTarget } from "./agent-services.js";
import { FrameworkSettingsStore } from "./framework-settings-store.js";
import { farmChosen } from "./device-farm-store.js";
import { assertAllowedTarget } from "./net-guard.js";
import { isLoadSpec } from "../engine/performance/load.js";
import { DEFAULT_JOB_OPTIONS, TERMINAL_STATES, type JobOptions, type JobRow, type Repo } from "./repo.js";
import { nextRunAfter, type Schedule, type ScheduleStore } from "./schedule-store.js";
import { ACTOR_WORDS, runAs } from "./auth/actor.js";

/** The project already has a job in flight; a scheduled run must wait (one active job per project). */
export class OverlapError extends Error {
    constructor(
        readonly activeJobId: string,
        readonly activeStatus: string,
    ) {
        super(`A job is still ${activeStatus.toLowerCase().replace(/_/g, " ")}; the run will be tried again at the next check`);
    }
}

/** A run that needs the AI model is not started because the month's AI token limit is already used up. The slot is skipped, not retried every tick. */
export class AiLimitSkip extends Error {}

/** The project's job that has not finished yet, if any (QUEUED counts: it is about to run). */
export async function activeJobOf(repo: Repo, projectId: string): Promise<{ id: string; status: string } | undefined> {
    const terminal = TERMINAL_STATES.map((s) => `'${s}'`).join(",");
    return repo.db.get<{ id: string; status: string }>(`SELECT id, status FROM generation_jobs WHERE project_id = ? AND status NOT IN (${terminal}) LIMIT 1`, projectId);
}

/**
 * Every test of the project that this machine can execute (mobile tests only with an app and an emulator). Used by the AUTOMATED
 * starters (schedules, deploy triggers): load checks are left out, because a person has to start those on purpose.
 */
export async function runnableTestIds(repo: Repo, projectId: string, shape: RunShape = "validate"): Promise<string[]> {
    const config = (repo.getLatestApplicationPublic(projectId)?.config ?? {}) as Record<string, any>;
    // A project whose phone tests run on a device farm needs no phone here (device-farms.md).
    const mobileOk = Boolean(config.mobile) && (farmChosen(repo.db, projectId) || (agentCanRunMobile(projectId) ?? !localPhoneRunsProblem()));
    // iOS tests run only on a runner agent on a Mac, and only for a project that has an iOS app set up.
    const iosOk = Boolean(config.mobile?.iosBundleId) && agentCanRunIos(projectId) === true;
    // Frameworks the project switched off (Runners, Frameworks) are left out of every automated run.
    const switchedOff = new FrameworkSettingsStore(repo.db).get(projectId).enabled;
    // A load check inside reusable steps is still a load check.
    const view = blockView(repo.db, projectId);
    // Tests of an adapter plug-in that is not loaded (or cannot run where the project runs) are left out, not allowed to fail the whole run.
    const pluginOut = (await pluginSkips(repo, projectId, shape)).ids;
    const ids = repo
        .listTests(projectId)
        .filter((t) => {
            if (pluginOut.has(t.id)) return false;
            const adapter = adapterForSpec(t.spec);
            return adapter.executable && (!needsDevice(adapter) || (adapter.needs.ios ? iosOk : mobileOk)) && !isLoadSpec(view(t.spec)) && switchedOff[adapter.id as keyof typeof switchedOff] !== false;
        })
        .map((t) => t.id);
    // Hand-written tests are left out of automated runs where they may not run (the rest still runs; the job says so, see noteCustomSkipped).
    return (await splitCustom(repo, projectId, ids)).ids;
}

/**
 * Create the job a schedule stands for. "validate" re-runs every test that can run on this machine (no LLM
 * needed); "generate" analyzes the application again with the settings its latest analysis was started with.
 * Throws a plain-language Error when there is nothing to run, and OverlapError when the project is busy.
 */
export async function startScheduledJob(repo: Repo, s: Schedule): Promise<JobRow> {
    const app = repo.getLatestApplicationPublic(s.projectId);
    if (!app) throw new Error("This project has no application yet. Run an analysis or import tests first.");
    const url = app.url as string;
    const config = (app.config ?? {}) as Record<string, any>;
    // The address (or the platform's rules about addresses) may have changed since the schedule was made.
    // A project whose scripts run on a runner agent reaches its application from the agent's network (validation only: an analysis browses it from here).
    if (!isAppUri(url)) await (s.kind === "validate" ? assertRunTarget(s.projectId, url) : assertAllowedTarget(url));
    for (const extra of [config.openApiUrl, config.apiBaseUrl]) if (typeof extra === "string" && extra) await assertAllowedTarget(extra);

    let options: JobOptions;
    let dropped: AgentSwitch[] = [];
    if (s.kind === "validate") {
        let testIds = await runnableTestIds(repo, s.projectId);
        if (testIds.length === 0) throw new Error("This project has no tests that can be run yet.");
        options = { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds, retryFailures: s.retryFailures };
        // A schedule can run against a named environment instead (results are kept for that environment).
        const target = scheduleEnvironment(repo.db, s.id);
        if (target.environment) {
            const env = findEnvironment(repo.db, s.projectId, target.environment);
            if (!env) throw new Error(`The environment “${target.environment}” of this schedule no longer exists.`);
            if (env.production && !target.confirmProduction) throw new Error(`“${env.name}” is a production environment and this schedule was not confirmed for it. Edit the schedule and confirm.`);
            await assertEnvironmentTargets(env);
            // A run against an environment leaves plug-in tests out altogether (the gate refuses them there).
            testIds = await runnableTestIds(repo, s.projectId, "environment");
            if (testIds.length === 0) throw new Error("This project has no tests that can be run against an environment yet.");
            options = { ...DEFAULT_JOB_OPTIONS, mode: "environment", testIds, environment: env.name, ...(env.production ? { confirmProduction: true } : {}) };
        }
    } else {
        // Saved generation settings, minus anything that only makes sense for another kind of job.
        const { mobile: _m, mode: _mode, testIds: _t, trigger: _tr, scheduleId: _s, retryFailures: _r, requirementsText: _rt, ...saved } = config;
        // A schedule never turns the load check on again, whatever the saved settings say (a person starts that on purpose).
        options = { ...DEFAULT_JOB_OPTIONS, ...saved, mode: "generate", loadChecks: false } as JobOptions;
        // The project's current testing agents decide the checks, not only what the last exploration ran with: a removed agent's checks
        // are left out (the job's events say which), a chosen agent's checks are on.
        const row = repo.getProject(s.projectId);
        if (row) {
            const narrowed = await narrowedByChoice(new TestingAgentStore(repo.db.sql, repo), row, options, saved as AskedSwitches, { followChoice: true });
            options = { ...narrowed.options, loadChecks: false };
            dropped = narrowed.dropped;
        }
    }
    options.trigger = "schedule";
    options.scheduleId = s.id;
    // Who the run belongs to: the schedule and the person who made it (a person's own runner takes only that person's runs).
    options.startedBy = scheduleStarter(s);

    // Synchronous from here to the insert: no other job can slip in between the check and the create.
    const busy = await activeJobOf(repo, s.projectId);
    if (busy) throw new OverlapError(busy.id, busy.status);
    const job = await repo.createJob(s.projectId, app.id as string, options);
    await noteCustomSkipped(repo, job.id, s.projectId);
    if (dropped.length) repo.addEvent(job.id, { stage: "planning", kind: "agent_checks_dropped", level: "warn", message: droppedChecksNote(dropped), data: { dropped } });
    if (s.kind === "validate") await notePluginSkipped(repo, job.id, s.projectId, options.mode === "environment" ? "environment" : "validate");
    return job;
}

/** The `startedBy` of a schedule's job (COMMON contract): the schedule, and the person who made it (null for older schedules). */
export const scheduleStarter = (s: Pick<Schedule, "id" | "createdBy">): NonNullable<JobOptions["startedBy"]> => ({ kind: "schedule", id: s.id, ownerId: s.createdBy ?? null });

/** What starting a schedule that is linked to a runbook returns instead of a job: the run that now drives the steps. */
export interface RunbookStart {
    runbookRunId: string;
    runbookName: string;
}
export const isRunbookStart = (r: JobRow | RunbookStart): r is RunbookStart => "runbookRunId" in r;

export interface TickResult {
    scheduleId: string;
    result: "started" | "skipped" | "error" | "lost";
    jobId?: string;
    /** The schedule started a runbook run instead of a plain job. */
    runbookRunId?: string;
    note?: string;
}

export interface SchedulerDeps {
    store: ScheduleStore;
    repo: Repo;
    /** Creates the schedule's job. Defaults to `startScheduledJob`; tests inject a counter. A schedule linked to a runbook starts a run of it instead. */
    startRun?: (s: Schedule) => Promise<JobRow | RunbookStart>;
    /** Injectable clock (epoch ms) so tests never wait for real time. */
    clock?: () => number;
    tickMs?: number;
    onError?: (err: unknown) => void;
    /** Quick housekeeping at the start of every pass (ending expired quarantines). Errors are logged, never thrown into the pass. */
    onTick?: (nowMs: number) => void;
    /** Runs at the end of every pass with the pass's clock reading (epoch ms). Used for the daily retention pass; must not be needed for schedules. */
    afterPass?: (nowMs: number) => Promise<unknown> | unknown;
}

/**
 * Looks for due schedules every tick and starts their jobs. Several scheduler processes may share one
 * database: a due schedule is taken with an atomic compare-and-swap on `next_run_at`, so only one of them
 * acts on it. A schedule that is due while its project is busy is not run and not advanced — it is simply
 * due again at the next tick, and the reason is stored for the user.
 *
 * After downtime a missed schedule is due immediately and runs once: its next run is computed from now,
 * so missed slots are never replayed.
 */
export class Scheduler {
    private timer?: NodeJS.Timeout;
    private ticking?: Promise<TickResult[]>;
    private readonly clock: () => number;
    private readonly startRun: (s: Schedule) => Promise<JobRow | RunbookStart>;

    constructor(private readonly deps: SchedulerDeps) {
        this.clock = deps.clock ?? Date.now;
        this.startRun = deps.startRun ?? ((s) => startScheduledJob(deps.repo, s));
    }

    /** Runs a first check right away (boot catch-up), then keeps checking. */
    start(): void {
        if (this.timer) return;
        const go = () => void this.tick().catch((e) => this.deps.onError?.(e) ?? console.error("[scheduler] tick failed:", e));
        this.timer = setInterval(go, this.deps.tickMs ?? 30_000);
        this.timer.unref?.();
        go();
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await this.ticking?.catch(() => undefined);
    }

    /** One pass over the due schedules. Overlapping calls share the pass already in progress. */
    tick(): Promise<TickResult[]> {
        // Whatever a schedule does is recorded as done by "Schedule" (auth/actor.ts), not by whoever happened to call tick().
        this.ticking ??= runAs({ kind: "schedule", name: ACTOR_WORDS.schedule, role: "editor" }, () => this.pass()).finally(() => (this.ticking = undefined));
        return this.ticking;
    }

    private async pass(): Promise<TickResult[]> {
        const { store, repo } = this.deps;
        const out: TickResult[] = [];
        const now = this.clock();
        try {
            this.deps.onTick?.(now);
        } catch (e) {
            console.error("[scheduler] housekeeping failed:", e);
        }
        for (const s of store.due(now)) {
            const at = new Date(now).toISOString();
            const busy = await activeJobOf(repo, s.projectId);
            if (busy) {
                const note = new OverlapError(busy.id, busy.status).message;
                store.recordRun(s.id, { outcome: "skipped", note, at });
                out.push({ scheduleId: s.id, result: "skipped", note });
                continue;
            }
            const nextRun = nextRunAfter(s.cadence, now);
            if (!store.claim(s.id, s.nextRunAt!, nextRun)) {
                out.push({ scheduleId: s.id, result: "lost" });
                continue;
            }
            try {
                const job = await this.startRun(s);
                if (isRunbookStart(job)) {
                    store.recordRun(s.id, { outcome: "started", note: `Started the runbook “${job.runbookName}”`, at });
                    out.push({ scheduleId: s.id, result: "started", runbookRunId: job.runbookRunId });
                    continue;
                }
                store.recordRun(s.id, { outcome: "started", jobId: job.id, at });
                out.push({ scheduleId: s.id, result: "started", jobId: job.id });
            } catch (e) {
                if (e instanceof OverlapError) {
                    // Someone started a job between the check and the create: give the slot back and wait.
                    store.unclaim(s.id, nextRun, s.nextRunAt!);
                    store.recordRun(s.id, { outcome: "skipped", note: e.message, at });
                    out.push({ scheduleId: s.id, result: "skipped", note: e.message });
                } else if (e instanceof AiLimitSkip) {
                    // Nothing was created: the schedule moves on to its next slot and the reason is kept for the user.
                    store.recordRun(s.id, { outcome: "skipped", note: e.message, at });
                    out.push({ scheduleId: s.id, result: "skipped", note: e.message });
                } else {
                    const note = e instanceof Error ? e.message : String(e);
                    store.recordRun(s.id, { outcome: "error", note: note.slice(0, 300), at });
                    out.push({ scheduleId: s.id, result: "error", note });
                }
            }
        }
        // Housekeeping that rides on the tick (the daily retention pass). Whatever happens there, schedules are unaffected.
        try {
            await this.deps.afterPass?.(now);
        } catch (e) {
            if (this.deps.onError) this.deps.onError(e);
            else console.error("[scheduler] housekeeping failed:", e);
        }
        return out;
    }
}
