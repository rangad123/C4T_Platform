/**
 * Running a suite a person built. Nothing here is a new way of running tests: a suite run is the same validation job "run these
 * tests" queues (or the same environment job), for exactly the suite's tests in the suite's order, with the suite's settings.
 * A schedule that points at a suite starts it through `startSuiteForSchedule`, with the checks every scheduled run has.
 */
import { isAppUri } from "../engine/desktop/target.js";
import { getAdapter, hasAdapter } from "../engine/frameworks/index.js";
import { normalizeVariants } from "../engine/validation/variants.js";
import { assertRunTarget } from "./agent-services.js";
import type { Platform } from "./bootstrap.js";
import { noteCustomSkipped } from "./custom-policy.js";
import { assertEnvironmentTargets } from "./environment-run.js";
import { findEnvironment } from "./environments-store.js";
import { HttpError } from "./http-error.js";
import { assertAllowedTarget } from "./net-guard.js";
import { readHeartbeat } from "./ops/heartbeat.js";
import { notePluginSkipped } from "./plugin-policy.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobRow, type Repo, type TestRow } from "./repo.js";
import type { Schedule } from "./schedule-store.js";
import { activeJobOf, OverlapError, runnableTestIds, scheduleStarter } from "./scheduler.js";
import { SuiteStore, type Suite, type SuiteSettings } from "./suite-store.js";
import { ReviewStore } from "./review-store.js";
import { dispatchAlive, DISPATCH_DOWN_MESSAGE, runnersOnly } from "./runner-only.js";

/** A worker that last said it was alive longer ago than this is gone (GET /readyz uses the same 90 seconds). */
const WORKER_GONE_MS = 90_000;

export const NO_WORKER_MESSAGE = "Tests do not run on this server: nothing here picks up a run, so a run started now would wait in the queue and never start. Run the suite where tests run (your own installation, or once tests are switched on here).";

/**
 * Can a run started now actually start? Only when a worker runs in this process, or another process said it is alive just now.
 * EXECUTION_MODE=runners: while the dispatch worker is alive (it starts with the API process); every project then goes to runners,
 * and the job gate refuses a run plainly when no runner the project may use is online.
 */
export function runsCanStartHere(p: Pick<Platform, "config" | "db">, nowMs: number = Date.now()): { ok: true } | { ok: false; reason: string } {
    const beat = () => {
        const at = readHeartbeat(p.db);
        return at !== undefined && nowMs - at <= WORKER_GONE_MS;
    };
    if (runnersOnly(p.config)) return dispatchAlive(p.db) || beat() ? { ok: true } : { ok: false, reason: DISPATCH_DOWN_MESSAGE };
    if (p.config.WORKER_EMBEDDED) return { ok: true };
    if (beat()) return { ok: true };
    return { ok: false, reason: NO_WORKER_MESSAGE };
}

/** What a refused run or exploration says while tests are switched off on this server (no worker picks up a job). */
export const RUNS_OFF_MESSAGE = "Tests are switched off on this server: nothing here picks up a run, so a run started now would wait in the queue and never start. Run your tests where tests run (your own installation), or once tests are switched on here.";
/** "Describe it": the AI writes the test inside a job, and opens the site to check it, so it needs a worker as a run does. */
export const PLAIN_OFF_MESSAGE = "Tests are switched off on this server: the AI writes a described test inside a run, and nothing here picks up a run. Build the steps by hand or write the test as text instead.";
/** An import asked to run what it imports while tests are switched off: the tests are kept and the answer says this. */
export const IMPORTED_NOT_RUN = "Saved but not run: tests are switched off on this server, so nothing here would pick up the run.";
export const EXPLORING_OFF_MESSAGE = "Tests are switched off on this server: nothing here picks up an exploration, so it would wait in the queue and never start. Explore where tests run (your own installation), or once tests are switched on here.";

/**
 * The refusal of every route that queues a job a worker must pick up: 409 with `cannotRunHere`, before anything is queued (the
 * suite run route says the same in its own words). A route that saves something first and only then runs it keeps what it saved
 * and says the run did not start instead.
 */
export function refuseUnlessRunsStart(p: Pick<Platform, "config" | "db">, message: string = RUNS_OFF_MESSAGE): void {
    if (runnersOnly(p.config)) {
        // An exploration and a described test go to the starter's runner (rounds 51 and 52), so they need the dispatch worker like a run; the job
        // gate says whether their runner can take it.
        const can = runsCanStartHere(p);
        if (!can.ok) throw new HttpError(409, can.reason, { cannotRunHere: true, executionMode: "runners" });
        return;
    }
    if (!runsCanStartHere(p).ok) throw new HttpError(409, message, { cannotRunHere: true });
}

export interface HeldTest {
    id: string;
    testId: string;
    reason: string;
}

/**
 * Which version of each of the suite's tests a run uses, and which tests are held back. The ONE place a suite run decides it.
 *
 * Drafts never run (review-store.ts): each test runs its latest approved version (its steps as approved; the job runner also
 * runs a person's code as approved), and a test with none is held back with the reason. Keep the order of `tests`.
 */
export async function chooseVersionsToRun(repo: Repo, _projectId: string, tests: TestRow[]): Promise<{ run: TestRow[]; held: HeldTest[] }> {
    const reviews = new ReviewStore(repo.db);
    const run: TestRow[] = [];
    const held: HeldTest[] = [];
    for (const t of tests) {
        reviews.track(t.id); // a change written outside the usual paths is a version before it is judged
        // An approved test whose shared parts (reusable steps, elements, helpers) changed since its approval is held back too.
        const pick = reviews.toRun(t.id);
        const v = pick.version;
        if (v) run.push({ ...t, spec: v.spec as TestRow["spec"] });
        else held.push({ id: t.id, testId: t.testKey, reason: pick.held ? `${t.testKey}: ${pick.held}` : `${t.testKey} is waiting for approval: only approved versions run.` });
    }
    return { run, held };
}

/** The suite's tests that still exist, in suite order. */
export async function suiteTests(repo: Repo, store: SuiteStore, suite: Suite): Promise<TestRow[]> {
    const ids = await store.testIds(suite.id);
    return ids.map((id) => repo.getTest(id)).filter((t): t is TestRow => Boolean(t && t.projectId === suite.projectId));
}

/** The job options of a suite run against the project's own address (environment runs are made by the environment route). */
export function suiteJobOptions(settings: SuiteSettings, testIds: string[]): JobOptions {
    const variants = settings.browsers.length ? normalizeVariants(settings.browsers) : [];
    return {
        ...DEFAULT_JOB_OPTIONS,
        mode: "validate",
        testIds,
        ...(settings.retries ? { retryFailures: settings.retries } : {}),
        ...(variants.length ? { variants } : {}),
        ...(settings.stopOnFirstFailure ? { stopOnFirstFailure: true } : {}),
    };
}

/** Tests nothing here can execute (stored only): named, not silently left out. Same rule as "run these tests". */
export function splitExecutable(tests: TestRow[]): { run: TestRow[]; skipped: HeldTest[] } {
    const skipped: HeldTest[] = [];
    const run = tests.filter((t) => {
        if (hasAdapter(t.framework) && !getAdapter(t.framework).executable) {
            skipped.push({ id: t.id, testId: t.testKey, reason: `${t.testKey} is stored but this platform cannot execute it.` });
            return false;
        }
        return true;
    });
    return { run, skipped };
}

const stores = new WeakMap<Platform, SuiteStore>();
export function suiteStoreFor(p: Platform): SuiteStore {
    let s = stores.get(p);
    if (!s) stores.set(p, (s = new SuiteStore(p.sql)));
    return s;
}

/**
 * A schedule's start when it points at a suite: undefined for any other schedule. The same checks as every scheduled run (the
 * application's address, the environment and its production confirmation, one job per project), and the automated-run rules for
 * what may run (tests a person must start on purpose, switched-off frameworks, hand-written tests where they may not run).
 * Throws a plain Error when nothing can run, and OverlapError when the project is busy.
 */
export async function startSuiteForSchedule(p: Platform, s: Schedule): Promise<JobRow | undefined> {
    const store = suiteStoreFor(p);
    const suiteId = await store.scheduleLink(s.id);
    if (!suiteId) return undefined;
    const suite = await store.get(suiteId);
    if (!suite || suite.projectId !== s.projectId) throw new Error("The suite this schedule runs no longer exists. Edit the schedule and choose another.");
    const can = runsCanStartHere(p);
    if (!can.ok) throw new Error(can.reason);
    const { repo } = p;
    const app = repo.getLatestApplicationPublic(s.projectId);
    if (!app) throw new Error("This project has no application yet. Run an analysis or import tests first.");
    const url = app.url as string;
    if (!isAppUri(url)) await assertRunTarget(s.projectId, url);
    const settings = suite.settings;
    const shape = settings.environment ? "environment" : "validate";
    const allowed = new Set(await runnableTestIds(repo, s.projectId, shape, s.createdBy ?? null));
    const chosen = await chooseVersionsToRun(repo, s.projectId, await suiteTests(repo, store, suite));
    const testIds = chosen.run.filter((t) => allowed.has(t.id)).map((t) => t.id);
    if (testIds.length === 0) throw new Error(`The suite “${suite.name}” has no tests that can run automatically here.`);
    let options: JobOptions;
    if (settings.environment) {
        const env = findEnvironment(repo.db, s.projectId, settings.environment);
        if (!env) throw new Error(`The environment “${settings.environment}” of the suite “${suite.name}” no longer exists.`);
        if (env.production && !settings.confirmProduction) throw new Error(`“${env.name}” is a production environment and the suite “${suite.name}” was not confirmed for it. Change the suite's settings and confirm.`);
        await assertEnvironmentTargets(env);
        options = { ...DEFAULT_JOB_OPTIONS, mode: "environment", testIds, environment: env.name, ...(env.production ? { confirmProduction: true } : {}) };
    } else {
        for (const extra of [(app.config as Record<string, unknown> | undefined)?.apiBaseUrl]) if (typeof extra === "string" && extra) await assertAllowedTarget(extra);
        options = suiteJobOptions(settings, testIds);
    }
    options.trigger = "schedule";
    options.scheduleId = s.id;
    options.startedBy = scheduleStarter(s);
    const busy = await activeJobOf(repo, s.projectId);
    if (busy) throw new OverlapError(busy.id, busy.status);
    const job = await repo.createJob(s.projectId, app.id as string, options);
    await noteCustomSkipped(repo, job.id, s.projectId);
    await notePluginSkipped(repo, job.id, s.projectId, shape);
    await store.recordRun({ suiteId: suite.id, jobId: job.id, trigger: "schedule", scheduleId: s.id, testCount: testIds.length });
    return job;
}
