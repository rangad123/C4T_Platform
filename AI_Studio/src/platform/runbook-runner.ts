/**
 * Runbooks wired to one platform: starts a run, drives it step by step through the jobs the platform already has, and records
 * every step so a person can watch it.
 *
 * Nothing here is a new way of running tests. A "run tests" step creates the same validation job a schedule does (same checks,
 * same environment rules, same production confirmation) and waits for it; "analyze" creates the same analysis job a schedule
 * with kind "generate" does. The one-active-job-per-project rule still holds: a run waits for its own job, never starts two,
 * and a project has at most one active runbook run (enforced by a unique index).
 *
 * A run is driven by the process that started it. It beats a heartbeat; a run whose driver stopped beating (the platform was
 * restarted or crashed) is marked "interrupted" and never resumed.
 */
import { noteCustomSkipped } from "./custom-policy.js";
import { notePluginSkipped } from "./plugin-policy.js";
import { randomUUID } from "node:crypto";
import { isAppUri } from "../engine/desktop/target.js";
import { defaultAdapterFor, needsDevice } from "../engine/frameworks/index.js";
import { isLoadSpec } from "../engine/performance/load.js";
import { evaluateCondition, finalStatus, nextAfter, passRateOf, stepTitle, type Facts, type RunStatus } from "../engine/runbook/flow.js";
import { renderTemplate, type NotifyStepT, type RunbookDefinition, type RunStepT, type AnalyzeStepT, type Step, type ConditionStepT, type WaitStepT } from "../engine/runbook/schema.js";
import { assessSeverity } from "../engine/validation/severity.js";
import type { Platform } from "./bootstrap.js";
import { buildDashboard } from "./dashboard.js";
import { apiChanges } from "./drift-store.js";
import { assertEnvironmentTargets } from "./environment-run.js";
import { findEnvironment } from "./environments-store.js";
import { HttpError } from "./http-error.js";
import { loadTargetProblem } from "./load-guard.js";
import { assertAllowedTarget } from "./net-guard.js";
import { gateJob } from "./quarantine-service.js";
import { DEFAULT_JOB_OPTIONS, TERMINAL_STATES, type JobOptions, type JobRow } from "./repo.js";
import { blockView } from "./block-store.js";
import { RunbookBusy, RunbookStore, type Runbook, type RunbookRun, type RunStepRow, type RunTrigger } from "./runbook-store.js";
import { getScheduleServices } from "./schedule-services.js";
import { activeJobOf, OverlapError, runnableTestIds, type RunbookStart } from "./scheduler.js";
import type { Schedule } from "./schedule-store.js";
import { isArchived, PROJECT_ARCHIVED } from "./project-folders.js";
import { currentActor } from "./auth/actor.js";
import { jobOwnerId, ownerIdOfActor } from "./agent-store.js";

/** The longest one step may take, and the longest a whole run may take. Tests inject small values. */
export const STEP_CAP_MS = 30 * 60_000;
export const TOTAL_CAP_MS = 60 * 60_000;

export interface RunbookServiceOptions {
    clock?: () => number;
    /** How often a running step looks at its job. */
    pollMs?: number;
    stepCapMs?: number;
    totalCapMs?: number;
    /** How long one "second" of a wait step lasts (1000 in production; tests shorten it). */
    waitUnitMs?: number;
    heartbeatMs?: number;
    /** A run whose driver has not beaten for this long is considered dead. */
    staleMs?: number;
}

export type StartedBy = { kind: "manual" } | { kind: "schedule"; scheduleId: string; /** Whose runner runs it: a "Run now" clicker, else the schedule's maker. */ ownerId?: string | null } | { kind: "deploy"; tokenId: string; commit?: string; environment?: string; label?: string };

/** A second runbook run for a project that already has one going. */
export class RunbookOverlapError extends OverlapError {
    constructor(
        readonly runId: string,
        readonly runbookName: string,
    ) {
        super(runId, "running");
        this.message = `The runbook “${runbookName}” is still running for this project; the new run will be tried again at the next check`;
    }
}

export interface RunbookServices {
    store: RunbookStore;
    limits: { stepCapMs: number; totalCapMs: number };
    /** Start a run now. Throws HttpError (404 unknown runbook, 409 a runbook or a job is already running). */
    start(runbookId: string, by: StartedBy): Promise<RunbookRun>;
    /** A schedule's start: undefined when the schedule is not linked to a runbook. Throws OverlapError when the project is busy. */
    startForSchedule(s: Schedule): Promise<RunbookStart | undefined>;
    cancel(runId: string): boolean;
    /** Mark runs whose driver is gone as interrupted. Safe to call often. */
    sweep(): RunbookRun[];
    /** Start-up: same as sweep (a run found running whose driver is gone is interrupted, never resumed). */
    recover(): RunbookRun[];
    /** Public shape of a run, with its steps. */
    publicRun(run: RunbookRun, withSteps?: boolean): Record<string, unknown>;
    /** Plain-language notes about choices that match no tests right now (shown, not blocking). */
    warnings(projectId: string, def: RunbookDefinition): Promise<string[]>;
    /** Wait until every run this process drives has ended (shutdown, tests). */
    flush(): Promise<void>;
    /** Shut down: runs still going are marked interrupted, because nothing will drive them any more. */
    stop(): Promise<void>;
}

const cache = new WeakMap<Platform, RunbookServices>();

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function duration(ms: number): string {
    if (ms < 1_000) return `${ms} ms`;
    if (ms < 60_000) return `${Math.round(ms / 100) / 10} seconds`;
    return plural(Math.round(ms / 6_000) / 10, "minute");
}

type Outcome = {
    status: "passed" | "failed" | "timed_out" | "stopped";
    reason: string;
    measured?: string;
    detail?: Record<string, unknown>;
    /** A step that reports a problem but never fails the run (a message that could not be delivered). */
    soft?: boolean;
};

interface Ctx {
    lastJob: JobRow | undefined;
    firstFailure: { title: string; reason: string } | undefined;
}

export function getRunbookServices(p: Platform, opts: RunbookServiceOptions = {}): RunbookServices {
    const hit = cache.get(p);
    if (hit) return hit;

    const { repo } = p;
    const clock = opts.clock ?? Date.now;
    const pollMs = opts.pollMs ?? 1_000;
    /** Read at every step, so a test can shorten the caps for one scenario. */
    const caps = { stepCapMs: opts.stepCapMs ?? STEP_CAP_MS, totalCapMs: opts.totalCapMs ?? TOTAL_CAP_MS };
    const waitUnitMs = opts.waitUnitMs ?? 1_000;
    const heartbeatMs = opts.heartbeatMs ?? 5_000;
    const staleMs = opts.staleMs ?? 20_000;
    const store = new RunbookStore(p.db, clock);
    /** Identifies this process as the driver of the runs it starts. */
    const owner = randomUUID();
    const drivers = new Map<string, { done: Promise<void>; abort: AbortController }>();
    let stopping = false;

    const alerts = () => getScheduleServices(p);

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Sleep that a cancel can cut short. */
    const sleep = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
            if (signal.aborted || ms <= 0) return resolve();
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
            };
            const timer = setTimeout(done, ms);
            signal.addEventListener("abort", done, { once: true });
        });

    const capText = (ms: number) => duration(ms);

    /** Tests a "run tests" step stands for, or the reason it stands for none. */
    async function selectTests(projectId: string, step: RunStepT, ownerId: string | null): Promise<{ ids: string[]; problem?: string }> {
        // The run's owner decides what their runner may take (code tests, a phone, an iOS device), as for any run of theirs.
        const runnable = new Set(await runnableTestIds(repo, projectId, step.environment ? "environment" : "validate", ownerId));
        let pool = repo.listTests(projectId);
        const scope = step.scope;
        if (scope !== "all") {
            if (scope.testIds) {
                const wanted = new Set(scope.testIds);
                const missing = scope.testIds.filter((w) => !pool.some((t) => t.id === w || t.testKey === w));
                if (missing.length) return { ids: [], problem: `${missing.length === 1 ? `The test ${missing[0]} no longer exists` : `${missing.length} chosen tests no longer exist (${missing.slice(0, 3).join(", ")})`}. Edit the runbook to choose again.` };
                pool = pool.filter((t) => wanted.has(t.id) || wanted.has(t.testKey));
            }
            if (scope.suite) pool = pool.filter((t) => t.suite.toLowerCase() === scope.suite!.toLowerCase() || slug(t.suite) === slug(scope.suite!));
            if (scope.tag) pool = pool.filter((t) => (t.spec.tags ?? []).some((x) => x.toLowerCase() === scope.tag!.toLowerCase()));
            if (scope.type) pool = pool.filter((t) => t.type.toLowerCase() === scope.type!.toLowerCase());
        }
        // Mobile tests only when the step asks for them; load checks are started on purpose by a person, never by a runbook.
        const view = blockView(repo.db, projectId);
        const ids = pool.filter((t) => runnable.has(t.id) && !isLoadSpec(view(t.spec)) && (step.includeMobile === true || !needsDevice(defaultAdapterFor(t.spec.kind)))).map((t) => t.id);
        if (ids.length === 0) {
            const what = scope === "all" ? "" : ` (${[scope.suite && `suite “${scope.suite}”`, scope.tag && `tag “${scope.tag}”`, scope.type && `type “${scope.type}”`, scope.testIds && "the chosen tests"].filter(Boolean).join(", ")})`;
            return { ids, problem: scope === "all" ? "This project has no tests that can be run yet." : `No tests match this step’s choice${what}, or none of them can be run on this machine. Edit the runbook to choose again.` };
        }
        return { ids };
    }

    /** The application's own addresses must still pass the outbound guard, as for any scheduled run. */
    async function assertAppTargets(app: { url: string; config?: Record<string, any> | null }): Promise<void> {
        if (!isAppUri(app.url)) await assertAllowedTarget(app.url);
        const config = (app.config ?? {}) as Record<string, any>;
        for (const extra of [config.openApiUrl, config.apiBaseUrl]) if (typeof extra === "string" && extra) await assertAllowedTarget(extra);
    }

    /**
     * Whose runner runs the run's steps (round 45): who started it (by hand, or "Run now" on its schedule), else the schedule's or deploy
     * trigger's creator (a run resumed after a restart, when what was kept in memory is gone).
     */
    function starterOf(run: RunbookRun): JobOptions["startedBy"] {
        const starter = starters.get(run.id);
        if (starter) return starter;
        if (run.trigger === "schedule") {
            const owner = run.triggerRef ? (repo.db.get<{ created_by: string | null }>("SELECT created_by FROM schedules WHERE id = ?", run.triggerRef)?.created_by ?? null) : null;
            return { kind: "schedule", id: run.triggerRef ?? null, ownerId: owner };
        }
        if (run.trigger === "deploy") {
            const owner = run.triggerRef ? (repo.db.get<{ created_by: string | null }>("SELECT created_by FROM trigger_tokens WHERE id = ?", run.triggerRef)?.created_by ?? null) : null;
            return { kind: "trigger", id: run.triggerRef ?? null, ownerId: owner };
        }
        return undefined;
    }

    function labelOptions(run: RunbookRun, options: JobOptions): JobOptions {
        options.runbookRunId = run.id;
        options.trigger = run.trigger === "schedule" ? "schedule" : run.trigger === "deploy" ? "deploy" : "manual";
        if (run.trigger === "schedule" && run.triggerRef) options.scheduleId = run.triggerRef;
        if (run.trigger === "deploy") options.deploy = deployInfo.get(run.id) ?? {};
        const starter = starterOf(run);
        if (starter) options.startedBy = starter;
        return options;
    }
    /** Who started a runbook by hand (kept in memory for its jobs' owner; a run resumed after a restart is attributed by the request that resumes it). */
    const starters = new Map<string, NonNullable<JobOptions["startedBy"]>>();
    /** What a deploy trigger said about the deploy, kept in memory for the labels of this run's jobs. */
    const deployInfo = new Map<string, { commit?: string; environment?: string; label?: string }>();

    /**
     * Create the job once the project is free. A job somebody else started (a person, a schedule) is waited for until the
     * step's deadline; the check and the insert happen with nothing awaited between them.
     */
    async function createJobWhenFree(run: RunbookRun, build: () => Promise<{ applicationId: string; options: JobOptions }>, signal: AbortSignal, deadlineAt: number): Promise<JobRow | "timeout" | "cancelled"> {
        for (;;) {
            const { applicationId, options } = await build();
            if (!(await activeJobOf(repo, run.projectId))) {
                const created = await repo.createJob(run.projectId, applicationId, labelOptions(run, options));
                await noteCustomSkipped(repo, created.id, run.projectId);
                if (options.mode === "validate" || options.mode === "environment") await notePluginSkipped(repo, created.id, run.projectId, options.mode);
                return created;
            }
            if (signal.aborted || store.isCancelRequested(run.id)) return "cancelled";
            if (clock() >= deadlineAt) return "timeout";
            await sleep(Math.min(pollMs, Math.max(1, deadlineAt - clock())), signal);
        }
    }

    /** Wait for a job to reach a final state. */
    async function waitForJob(run: RunbookRun, jobId: string, signal: AbortSignal, deadlineAt: number): Promise<JobRow | "timeout" | "cancelled" | "gone"> {
        for (;;) {
            const job = repo.getJob(jobId);
            if (!job) return "gone";
            if (TERMINAL_STATES.includes(job.status)) return job;
            if (signal.aborted || store.isCancelRequested(run.id)) return "cancelled";
            if (clock() >= deadlineAt) return "timeout";
            await sleep(Math.min(pollMs, Math.max(1, deadlineAt - clock())), signal);
        }
    }

    function jobCounts(job: JobRow) {
        const c = job.counters;
        const total = c.testsGenerated;
        // Quarantined tests (flaky, known) decide nothing: leave them out of the counts a step or a check judges.
        const held = gateJob(repo, job);
        if (!held) return { total, passed: c.testsValidated, failed: c.testsFailedValidation + c.testsNeedingReview, quarantined: 0 };
        return { total: total - held.held.length, passed: c.testsValidated - held.passed, failed: Math.max(0, c.testsFailedValidation + c.testsNeedingReview - held.failed), quarantined: held.held.length };
    }

    /** The step's outcome from the job it waited for (the same words the deploy trigger would use). */
    function outcomeOfJob(step: Step, job: JobRow): Outcome {
        const { total, passed, failed, quarantined } = jobCounts(job);
        const detail = { jobId: job.id, total, passed, failed, passRate: passRateOf({ total, passed }), ...(quarantined ? { quarantined } : {}) };
        if (job.status === "FAILED") {
            const cancelled = job.error === "Cancelled";
            return { status: "failed", reason: cancelled ? "The job was cancelled before it finished." : `The job could not finish: ${(job.error ?? "it failed").slice(0, 300)}`, detail };
        }
        if (step.type === "analyze") {
            return job.status === "COMPLETED" ? { status: "passed", reason: `The analysis finished and ${plural(total, "test")} ${total === 1 ? "was" : "were"} checked.`, detail } : { status: "failed", reason: `The analysis finished with ${plural(failed, "test")} that failed or need review${job.error ? `: ${job.error.slice(0, 200)}` : ""}.`, detail };
        }
        if (job.status === "COMPLETED") return { status: "passed", reason: `All ${plural(total, "test")} passed.`, detail };
        // Every failure was a quarantined test: the step passes, and says so.
        if (quarantined > 0 && failed <= 0) return { status: "passed", reason: `All ${plural(total, "test")} passed (${plural(quarantined, "quarantined test")} ignored).`, detail };
        return { status: "failed", reason: `${passed} of ${plural(total, "test")} passed; ${failed} failed or need review.`, detail };
    }

    // ── steps ────────────────────────────────────────────────────────────────

    async function runStep(run: RunbookRun, index: number, step: RunStepT, ctx: Ctx, signal: AbortSignal, deadlineAt: number): Promise<Outcome> {
        const build = async () => {
            const app = repo.getLatestApplicationPublic(run.projectId);
            if (!app) throw new StepProblem("This project has no application yet. Run an analysis or import tests first.");
            await assertAppTargets({ url: app.url as string, config: app.config as Record<string, any> });
            const { ids, problem } = await selectTests(run.projectId, step, jobOwnerId({ startedBy: starterOf(run) }));
            if (problem) throw new StepProblem(problem);
            let options: JobOptions;
            if (step.environment) {
                const env = findEnvironment(p.db, run.projectId, step.environment);
                if (!env) throw new StepProblem(`The environment “${step.environment}” no longer exists.`);
                // Re-checked here: the environment may have been marked production after the runbook was saved.
                if (env.production && !step.confirmProduction) throw new StepProblem(`“${env.name}” is a production environment and this step was not confirmed for it. Edit the runbook and confirm.`);
                await assertEnvironmentTargets(env);
                options = { ...DEFAULT_JOB_OPTIONS, mode: "environment", testIds: ids, environment: env.name, ...(env.production ? { confirmProduction: true } : {}) };
            } else {
                options = { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: ids, retryFailures: step.retries };
            }
            return { applicationId: app.id as string, options };
        };
        return jobStep(run, index, step, ctx, build, signal, deadlineAt);
    }

    async function analyzeStep(run: RunbookRun, index: number, step: AnalyzeStepT, ctx: Ctx, signal: AbortSignal, deadlineAt: number): Promise<Outcome> {
        const build = async () => {
            const app = repo.getLatestApplicationPublic(run.projectId);
            if (!app) throw new StepProblem("This project has no application yet. Run an analysis first.");
            await assertAppTargets({ url: app.url as string, config: app.config as Record<string, any> });
            const config = (app.config ?? {}) as Record<string, any>;
            // Saved settings of the latest analysis, minus anything that belongs to another kind of job. Data-changing tests
            // and the load check are off unless this step switches them on.
            // Never who started an earlier job (an older application kept it): this run's own starter is recorded (labelOptions).
            const { mobile: _m, mode: _mode, testIds: _t, trigger: _tr, scheduleId: _s, runbookRunId: _r, retryFailures: _rf, requirementsText: _rt, startedBy: _sb, ...saved } = config;
            const options = { ...DEFAULT_JOB_OPTIONS, ...saved, mode: "generate", allowMutatingApiTests: step.allowMutatingApiTests === true, loadChecks: step.loadChecks === true } as JobOptions;
            if (options.loadChecks) {
                const refused = await loadTargetProblem(p.db, run.projectId, [options.apiBaseUrl, app.url as string]);
                if (refused) throw new StepProblem(refused);
            }
            return { applicationId: app.id as string, options };
        };
        return jobStep(run, index, step, ctx, build, signal, deadlineAt);
    }

    /** Shared by the two steps that start a job: start it, remember it, wait for it. */
    async function jobStep(run: RunbookRun, index: number, step: Step, ctx: Ctx, build: () => Promise<{ applicationId: string; options: JobOptions }>, signal: AbortSignal, deadlineAt: number): Promise<Outcome> {
        let job: JobRow | "timeout" | "cancelled";
        try {
            job = await createJobWhenFree(run, build, signal, deadlineAt);
        } catch (e) {
            if (e instanceof StepProblem) return { status: "failed", reason: e.message };
            if (e instanceof HttpError) return { status: "failed", reason: e.message };
            throw e;
        }
        if (job === "cancelled") return { status: "stopped", reason: "The run was cancelled before this step could start." };
        if (job === "timeout") return { status: "timed_out", reason: "Another job kept the project busy until the time for this step ran out." };
        store.setStepJob(run.id, index, job.id);
        const done = await waitForJob(run, job.id, signal, deadlineAt);
        if (done === "gone") return { status: "failed", reason: "The job no longer exists." };
        if (done === "cancelled" || done === "timeout") {
            // The platform is stopping (a deploy), not a person: a job that already runs on a runner is handed over and finishes there, with
            // nothing run twice (runner-handover.ts), so it is not stopped. The run sequence itself ends here, as interrupted.
            if (done === "cancelled" && stopping && !store.isCancelRequested(run.id)) {
                const now = repo.getJob(job.id);
                if (now?.options.runOn === "agent" && now.status !== "QUEUED") return { status: "stopped", reason: "The platform restarted. This step's test run carries on on its runner and finishes on its own; the steps after it were not run.", detail: { jobId: job.id } };
            }
            // The job belongs to this step: stop it too, or it would keep the project busy.
            repo.requestCancel(job.id);
            return done === "cancelled" ? { status: "stopped", reason: "The run was cancelled and the job was asked to stop.", detail: { jobId: job.id } } : { status: "timed_out", reason: "The job did not finish in time and was asked to stop.", detail: { jobId: job.id } };
        }
        ctx.lastJob = done;
        return outcomeOfJob(step, done);
    }

    function factsFor(run: RunbookRun, ctx: Ctx, check: ConditionStepT["condition"]["check"]): Facts {
        const job = ctx.lastJob ? (repo.getJob(ctx.lastJob.id) ?? ctx.lastJob) : undefined;
        const facts: Facts = { hasRun: Boolean(job), jobError: null, total: null, passed: null, failed: null, highSeverity: null, apiBreaking: null, readiness: null };
        if (job) {
            const { total, passed, failed, quarantined } = jobCounts(job);
            Object.assign(facts, { total, passed, failed, ...(quarantined ? { quarantined } : {}), jobError: job.status === "FAILED" ? (job.error ?? "the job failed") : null });
            if (check === "noHighSeverity") {
                const ids = job.options.testIds ?? repo.listTests(run.projectId, { jobId: job.id }).map((t) => t.id);
                let high = 0;
                for (const id of ids) {
                    const t = repo.getTest(id);
                    if (!t || t.validationStatus !== "NEEDS_REVIEW") continue;
                    const sev = assessSeverity(t.spec, t.validationStatus, t.validationReason)?.severity;
                    if (sev === "high" || sev === "critical") high++;
                }
                facts.highSeverity = high;
            }
            if (check === "noApiBreakingChange") {
                const changes = apiChanges(p.db, run.projectId, { to: job.id });
                facts.apiBreaking = changes && changes.from && changes.to ? changes.breaking.length : null;
            }
        }
        if (check === "readiness") {
            const mine = buildDashboard(p.db).projects.find((x) => x.id === run.projectId);
            facts.readiness = mine ? { state: mine.readiness.state, label: mine.readiness.label, reasons: mine.readiness.reasons.map((r) => r.text) } : null;
        }
        return facts;
    }

    function conditionStep(run: RunbookRun, step: ConditionStepT, ctx: Ctx): Outcome {
        const r = evaluateCondition(step.condition, factsFor(run, ctx, step.condition.check));
        return { status: r.passed ? "passed" : "failed", reason: r.reason, measured: r.measured };
    }

    async function waitStep(step: WaitStepT, signal: AbortSignal, deadlineAt: number): Promise<Outcome> {
        const wanted = step.seconds * waitUnitMs;
        const room = deadlineAt - clock();
        await sleep(Math.min(wanted, Math.max(0, room)), signal);
        if (signal.aborted) return { status: "stopped", reason: "The run was cancelled while waiting." };
        if (wanted > room) return { status: "timed_out", reason: "The time left for this step ran out while waiting." };
        return { status: "passed", reason: `Waited ${plural(step.seconds, "second")}.` };
    }

    function templateValues(run: RunbookRun, ctx: Ctx, anyFailure: boolean) {
        const project = repo.getProject(run.projectId);
        const job = ctx.lastJob ? (repo.getJob(ctx.lastJob.id) ?? ctx.lastJob) : undefined;
        const counts = job ? jobCounts(job) : undefined;
        const rate = counts ? passRateOf(counts) : null;
        return {
            project: (project?.name as string | undefined) ?? "the project",
            status: anyFailure ? "failed" : "passed",
            passRate: rate === null ? "not measured" : `${rate}%`,
            failed: counts ? String(counts.failed) : "not measured",
            runUrl: `${alerts().alerts.baseUrl()}/#/projects/${run.projectId}/schedule?run=${run.id}`,
        };
    }

    async function notifyStep(run: RunbookRun, step: NotifyStepT, ctx: Ctx): Promise<Outcome> {
        const svc = alerts();
        const channel = svc.alertStore.get(step.channelId);
        if (!channel || channel.projectId !== run.projectId) return { status: "failed", soft: true, reason: "The alert channel for this message no longer exists, so nothing was sent." };
        if (!channel.enabled) return { status: "failed", soft: true, reason: `The alert channel “${channel.name}” is paused, so nothing was sent.` };
        const current = store.getRun(run.id)!;
        const values = templateValues(run, ctx, current.anyFailure);
        const text = renderTemplate(step.message, values);
        const project = repo.getProject(run.projectId);
        const app = repo.getLatestApplicationPublic(run.projectId);
        const subject = svc.alerts.subject({ id: run.projectId, name: (project?.name as string | undefined) ?? "Project", url: (app?.url as string | undefined) ?? null });
        const result = await svc.alerts.sendRunbookMessage(channel, subject, { runbookName: run.runbookName, status: values.status, text, link: values.runUrl, runId: run.id });
        return result.ok ? { status: "passed", reason: `Sent to “${channel.name}”.` } : { status: "failed", soft: true, reason: `The message to “${channel.name}” was not delivered: ${result.error ?? "no answer"}. The run carried on.` };
    }

    // ── the driver ───────────────────────────────────────────────────────────

    async function drive(runId: string, signal: AbortSignal): Promise<void> {
        const run = store.getRun(runId);
        if (!run) return;
        const def = run.definition;
        const startedAt = clock();
        const ctx: Ctx = { lastJob: undefined, firstFailure: undefined };
        const heartbeat = setInterval(() => {
            try {
                store.heartbeat(runId);
            } catch {
                /* the database is gone (shutdown); nothing to beat */
            }
        }, heartbeatMs);
        heartbeat.unref?.();

        const end = (status: Exclude<RunStatus, "running">, reason: string, notReached: string) => {
            store.skipPending(runId, notReached);
            store.finishRun(runId, status, reason);
        };

        try {
            let index = 0;
            for (;;) {
                // Somebody else ended this run (a sweep from another process): stop quietly.
                const current = store.getRun(runId);
                if (!current || current.status !== "running") return;
                if (signal.aborted || store.isCancelRequested(runId)) {
                    if (store.isCancelRequested(runId)) end("cancelled", "Cancelled before it finished.", "Not reached: the run was cancelled.");
                    else end("interrupted", "The platform was shut down while this run was going. It was not resumed; start it again if you still need it.", "Not reached: the run was interrupted.");
                    return;
                }
                const left = caps.totalCapMs - (clock() - startedAt);
                if (left <= 0) {
                    end("timed_out", `The runbook took longer than ${capText(caps.totalCapMs)} and was ended.`, "Not reached: the runbook ran out of time.");
                    return;
                }
                const step = def.steps[index]!;
                const title = stepTitle(step);
                store.startStep(runId, index);
                const capped = Math.min(caps.stepCapMs, left);
                const deadlineAt = clock() + capped;

                let out: Outcome;
                try {
                    out =
                        step.type === "run" ? await runStep(run, index, step, ctx, signal, deadlineAt)
                        : step.type === "analyze" ? await analyzeStep(run, index, step, ctx, signal, deadlineAt)
                        : step.type === "condition" ? conditionStep(run, step, ctx)
                        : step.type === "notify" ? await notifyStep(run, step, ctx)
                        : await waitStep(step, signal, deadlineAt);
                } catch (e) {
                    if (!p.db.raw.isOpen) return;
                    out = { status: "failed", reason: `The step could not run: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
                }

                store.finishStep(runId, index, { status: out.status, reason: out.reason, measured: out.measured, detail: out.detail });

                if (out.status === "stopped") {
                    if (store.isCancelRequested(runId)) end("cancelled", `Cancelled during “${title}”.`, "Not reached: the run was cancelled.");
                    else end("interrupted", "The platform was shut down while this run was going. It was not resumed; start it again if you still need it.", "Not reached: the run was interrupted.");
                    return;
                }
                if (out.status === "timed_out") {
                    store.markAnyFailure(runId);
                    // Which limit was the binding one: the whole run's, or this step's own.
                    const wholeRun = left <= caps.stepCapMs;
                    end("timed_out", wholeRun ? `The runbook took longer than ${capText(caps.totalCapMs)} and was ended during “${title}”.` : `“${title}” took longer than ${capText(caps.stepCapMs)} and the runbook was ended.`, "Not reached: the runbook ran out of time.");
                    return;
                }

                const failedForReal = out.status === "failed" && !out.soft;
                if (failedForReal) {
                    store.markAnyFailure(runId);
                    ctx.firstFailure ??= { title, reason: out.reason };
                }
                const route = nextAfter(def, index, out.status === "passed" || Boolean(out.soft));
                if (route.kind === "goto") {
                    for (let skipped = index + 1; skipped < route.index; skipped++) store.skipStep(runId, skipped, `Skipped: the run went from “${title}” to “${stepTitle(def.steps[route.index]!)}”.`);
                    index = route.index;
                    continue;
                }
                const anyFailure = store.getRun(runId)?.anyFailure ?? false;
                const status = finalStatus(route.kind, anyFailure);
                const fail = ctx.firstFailure;
                const reason =
                    status === "passed" ? (route.kind === "end" ? "All steps finished." : `Finished early at “${title}”.`)
                    : status === "failed" ? `Finished, but “${fail?.title ?? title}” failed: ${fail?.reason ?? out.reason}`
                    : `Stopped after “${fail?.title ?? title}” failed: ${fail?.reason ?? out.reason}`;
                end(status, reason, route.kind === "stop" ? `Not reached: the run stopped at “${title}”.` : "Not reached.");
                return;
            }
        } catch (e) {
            // The database closing under a driver at shutdown is not worth a message.
            if (p.db.raw.isOpen) {
                console.error(`[runbook ${runId.slice(0, 8)}] the run stopped unexpectedly:`, e);
                try {
                    end("failed", `The run stopped because of an unexpected problem: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), "Not reached: the run stopped unexpectedly.");
                } catch {
                    /* ignore */
                }
            }
        } finally {
            clearInterval(heartbeat);
        }
    }

    function launch(run: RunbookRun): void {
        const abort = new AbortController();
        const done = drive(run.id, abort.signal)
            .catch(() => undefined)
            .finally(() => {
                drivers.delete(run.id);
                deployInfo.delete(run.id);
            });
        drivers.set(run.id, { done, abort });
    }

    // ── the public surface ───────────────────────────────────────────────────

    const services: RunbookServices = {
        store,
        limits: caps,

        async start(runbookId, by) {
            const runbook: Runbook | undefined = store.get(runbookId);
            if (!runbook) throw new HttpError(404, "Runbook not found");
            if (stopping) throw new HttpError(503, "The platform is shutting down");
            // An archived project runs nothing, a runbook started by a deploy trigger included (project-folders.ts).
            if (isArchived(repo.db, runbook.projectId)) throw new HttpError(409, PROJECT_ARCHIVED);
            services.sweep();
            // From here to the insert only the check below is awaited, which yields to nothing else while the stores are synchronous: no other job or run can slip in between the checks and the create.
            const activeRun = store.activeRun(runbook.projectId);
            if (activeRun) throw new RunbookOverlapError(activeRun.id, activeRun.runbookName);
            const busy = await activeJobOf(repo, runbook.projectId);
            if (busy) throw new OverlapError(busy.id, busy.status);
            const trigger: RunTrigger = by.kind;
            let run: RunbookRun;
            try {
                run = store.createRun({
                    runbook,
                    trigger,
                    triggerRef: by.kind === "schedule" ? by.scheduleId : by.kind === "deploy" ? by.tokenId : undefined,
                    triggerLabel: by.kind === "deploy" ? [by.label, by.commit, by.environment].filter(Boolean).join(", ") || undefined : undefined,
                    owner,
                    titles: runbook.definition.steps.map(stepTitle),
                });
            } catch (e) {
                if (e instanceof RunbookBusy) throw new RunbookOverlapError(e.activeRunId, "another runbook");
                throw e;
            }
            if (by.kind === "manual") {
                const a = currentActor();
                if (a.kind === "user" || a.kind === "open" || a.kind === "key") starters.set(run.id, { kind: a.kind, id: a.id ?? null });
            }
            if (by.kind === "schedule" && by.ownerId !== undefined) starters.set(run.id, { kind: "schedule", id: by.scheduleId, ownerId: by.ownerId });
            if (by.kind === "deploy") deployInfo.set(run.id, { ...(by.commit ? { commit: by.commit } : {}), ...(by.environment ? { environment: by.environment } : {}), ...(by.label ? { label: by.label } : {}) });
            launch(run);
            return run;
        },

        async startForSchedule(s) {
            const runbookId = store.scheduleLink(s.id);
            if (!runbookId) return undefined;
            // "Run now" passes the clicker as createdBy (schedule-services.ts runNow): their runner runs it, not the maker's.
            const run = await services.start(runbookId, { kind: "schedule", scheduleId: s.id, ownerId: s.createdBy ?? null });
            return { runbookRunId: run.id, runbookName: run.runbookName };
        },

        cancel(runId) {
            const run = store.getRun(runId);
            if (!run) return false;
            if (!store.requestCancel(runId)) return false;
            // Ask the job of the step in progress to stop right away, and wake a sleeping driver.
            const active = store.runSteps(runId).find((s) => s.status === "running" && s.jobId);
            if (active?.jobId) repo.requestCancel(active.jobId);
            drivers.get(runId)?.abort.abort();
            return true;
        },

        sweep() {
            return store.interruptStale(owner, staleMs);
        },
        recover() {
            return store.interruptStale(owner, staleMs);
        },

        publicRun(run, withSteps = true) {
            const steps = store.runSteps(run.id);
            const finished = run.status !== "running";
            const created = new Date(run.createdAt).getTime();
            return {
                runId: run.id,
                runbookId: run.runbookId,
                runbookName: run.runbookName,
                status: run.status,
                finished,
                // Did everything that matters pass? Null while the run is going; an interrupted or cancelled run proves nothing.
                passed: finished ? (run.status === "passed" ? true : run.status === "failed" || run.status === "stopped" || run.status === "timed_out" ? false : null) : null,
                reason: run.reason,
                trigger: run.trigger,
                triggerLabel: run.triggerLabel,
                cancelRequested: run.cancelRequested,
                createdAt: run.createdAt,
                finishedAt: run.finishedAt,
                durationMs: run.finishedAt ? Math.max(0, new Date(run.finishedAt).getTime() - created) : null,
                ticks: steps.map((s) => s.status),
                ...(withSteps ? { steps: steps.map(publicStep) } : {}),
            };
        },

        async warnings(projectId, def) {
            const out: string[] = [];
            for (const [i, s] of def.steps.entries()) {
                if (s.type !== "run") continue;
                const { problem } = await selectTests(projectId, s, ownerIdOfActor(currentActor()));
                if (problem) out.push(`Step ${i + 1}: ${problem}`);
            }
            return out;
        },

        async flush() {
            while (drivers.size) await Promise.allSettled([...drivers.values()].map((d) => d.done));
        },

        async stop() {
            stopping = true;
            for (const d of drivers.values()) d.abort.abort();
            await Promise.allSettled([...drivers.values()].map((d) => d.done));
        },
    };
    cache.set(p, services);
    return services;
}

/** A reason a step cannot start, in words for a person. */
class StepProblem extends Error {}

const publicStep = (s: RunStepRow) => ({
    index: s.index,
    id: s.stepId,
    type: s.type,
    title: s.title,
    status: s.status,
    jobId: s.jobId,
    reason: s.reason,
    measured: s.measured,
    detail: s.detail,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
});
