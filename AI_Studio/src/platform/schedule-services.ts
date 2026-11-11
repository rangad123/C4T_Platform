import type { Platform } from "./bootstrap.js";
import { AlertService, AlertStore, isAlertable, type DeliveryOptions } from "./alerts.js";
import { serverSmtp } from "./alert-email.js";
import { apiChanges } from "./drift-store.js";
import { QuarantineStore } from "./quarantine-store.js";
import type { JobRow } from "./repo.js";
import { runScheduledRetention } from "./retention-runner.js";
import { getRunbookServices } from "./runbook-runner.js";
import { AiLimitSkip, isRunbookStart, Scheduler, startScheduledJob, type RunbookStart } from "./scheduler.js";
import { aiSkipReason, usageStoreFor } from "./usage-store.js";
import { ScheduleStore, type Schedule } from "./schedule-store.js";
import { SecretBox } from "./secrets.js";
import { saveRunSummary, summarizeJob, type RunSummary } from "./trends.js";
import { getAgentServices } from "./agent-services.js";
import { getTriggerServices } from "./trigger-services.js";
import { refuseUnlessRunsStart, startSuiteForSchedule } from "./suite-run.js";

export interface ScheduleServiceOptions {
    clock?: () => number;
    delivery?: DeliveryOptions;
    startRun?: (s: Schedule) => Promise<JobRow | RunbookStart>;
}

/** The schedules feature wired to one platform: shared by the API routes, the scheduler and the worker hook. */
export interface ScheduleServices {
    store: ScheduleStore;
    alertStore: AlertStore;
    alerts: AlertService;
    scheduler: Scheduler;
    /** Pass to the worker (RunnerDeps.onJobFinished): records the run summary and sends alerts. Never throws. */
    onJobFinished: (job: JobRow) => Promise<void>;
    /**
     * Start a schedule's job now, whether or not it is due. Throws OverlapError / Error with a plain message. `startedBy` (a "Run now" from a
     * request: the clicker's user id, or null for a key) becomes the run's owner instead of the schedule's maker.
     */
    runNow: (scheduleId: string, startedBy?: string | null) => Promise<JobRow | RunbookStart>;
    /** Wait for alert deliveries still in flight (shutdown, tests). */
    flush: () => Promise<void>;
}

const cache = new WeakMap<Platform, ScheduleServices>();

/** One set of services per platform object; the first caller may inject a clock/delivery settings (tests). */
export function getScheduleServices(p: Platform, opts: ScheduleServiceOptions = {}): ScheduleServices {
    const hit = cache.get(p);
    if (hit) return hit;

    const store = new ScheduleStore(p.db, opts.clock);
    // Round 45: schedules made before their creator was recorded get one from Activity where that is certain (else refused at their next fire).
    try {
        store.backfillOwners();
    } catch {
        /* a database without the activity table yet: nothing to attribute */
    }
    const alertStore = new AlertStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY), () => serverSmtp(p.config));
    const alerts = new AlertService({ store: alertStore, config: p.config, delivery: opts.delivery });
    const startPlain = opts.startRun ?? ((s: Schedule) => startScheduledJob(p.repo, s));
    // An analysis needs the AI model: when the month's AI limit is already used up it is skipped with a reason instead of creating a job that cannot run.
    const plainStart = async (s: Schedule): Promise<JobRow | RunbookStart> => {
        if (s.kind === "generate") {
            const why = aiSkipReason(usageStoreFor(p.db, p.config, opts.clock), s.projectId);
            if (why) throw new AiLimitSkip(why);
        }
        return startPlain(s);
    };
    // A schedule linked to a runbook starts a run of it (see runbook-runner.ts); one that points at a suite runs the suite (suite-run.ts);
    // every other schedule starts its plain job.
    // Nothing starts that nothing would pick up (a plain 409 for "Run now", a recorded error for the tick): in both modes, before a job is made.
    const startRun = async (s: Schedule): Promise<JobRow | RunbookStart> => {
        refuseUnlessRunsStart(p);
        return (await getRunbookServices(p).startForSchedule(s)) ?? (await startSuiteForSchedule(p, s)) ?? plainStart(s);
    };
    // The daily retention pass (old evidence files) rides on the scheduler's tick; it only acts on projects that switched retention on.
    const scheduler = new Scheduler({ store, repo: p.repo, startRun, clock: opts.clock, tickMs: p.config.SCHEDULER_TICK_MS, onTick: (now) => {
        void new QuarantineStore(p.db, () => now).sweep(now);
        void getAgentServices(p).maintain().catch((err) => console.error("[agents] housekeeping failed:", err));
    }, afterPass: (nowMs) => runScheduledRetention(p, nowMs) });

    // Deliveries run in the background: a receiver that is down must not hold up the worker's next job.
    const inFlight = new Set<Promise<unknown>>();
    const track = (promise: Promise<unknown>) => {
        const wrapped = promise.catch((err) => console.error("[alerts] delivery failed:", err)).finally(() => inFlight.delete(wrapped));
        inFlight.add(wrapped);
    };

    const notify = (summary: RunSummary) => {
        const project = p.repo.getProject(summary.projectId);
        if (!project) return;
        const app = p.repo.getLatestApplicationPublic(summary.projectId);
        track(alerts.notifyRun(alerts.subject({ id: project.id, name: project.name, url: (app?.url as string | undefined) ?? null }), summary));
    };

    const services: ScheduleServices = {
        store,
        alertStore,
        alerts,
        scheduler,
        async onJobFinished(job) {
            // A deploy trigger may have asked to be told how its run ended (cancelled runs included); runs in the background like alerts.
            track(getTriggerServices(p, { clock: opts.clock, delivery: opts.delivery }).onJobFinished(job));
            try {
                // A cancelled job says nothing about the application.
                if (job.error === "Cancelled") return;
                // A browser-compatibility check re-runs already-validated tests on other browsers; it is not a
                // run of the suite, so it must not count in trends or raise regression alerts.
                if ((job.options.mode as string | undefined) === "variants") return;
                // Likewise a run against a named environment: its results are kept per environment, and trends,
                // flaky detection and regression alerts describe the project's main run only.
                if ((job.options.mode as string | undefined) === "environment") return;
                // Building one test from a description adds a test; it is not a run of the suite either.
                if ((job.options.mode as string | undefined) === "plain") return;
                // An agent run has its own result (agent-run.ts); it is not a run of the suite.
                if ((job.options.mode as string | undefined) === "agent") return;
                // An exploration that stopped at a plan created and ran nothing: there is no run to count.
                if (job.options.planOnly) return;
                const summary = summarizeJob(p.repo, job, "low");
                saveRunSummary(p.db, summary);
                if (isAlertable(summary)) notify(summary);
            } catch (err) {
                console.error(`[job ${job.id.slice(0, 8)}] could not record the run summary:`, err);
            }
            // The live API may have changed shape since the previous run; a failure here never touches the job.
            try {
                const changes = apiChanges(p.db, job.projectId, { to: job.id });
                const project = p.repo.getProject(job.projectId);
                if (changes?.from && changes.to && project) {
                    const app = p.repo.getLatestApplicationPublic(job.projectId);
                    track(alerts.notifyApiDrift(alerts.subject({ id: project.id, name: project.name, url: (app?.url as string | undefined) ?? null }), { from: changes.from, to: changes.to, breaking: changes.breaking, nonBreakingCount: changes.nonBreaking.length }));
                }
            } catch (err) {
                console.error(`[job ${job.id.slice(0, 8)}] could not check the API for changes:`, err);
            }
        },
        async runNow(scheduleId, startedBy) {
            const s = store.get(scheduleId);
            if (!s) throw new Error("Schedule not found");
            const job = await startRun(startedBy === undefined ? s : { ...s, createdBy: startedBy });
            const at = new Date((opts.clock ?? Date.now)()).toISOString();
            if (isRunbookStart(job)) store.recordRun(scheduleId, { outcome: "started", note: `Started the runbook “${job.runbookName}”`, at });
            else store.recordRun(scheduleId, { outcome: "started", jobId: job.id, at });
            return job;
        },
        async flush() {
            while (inFlight.size) await Promise.allSettled([...inFlight]);
        },
    };
    cache.set(p, services);
    return services;
}
