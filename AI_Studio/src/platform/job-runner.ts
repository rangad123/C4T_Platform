import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { executorFor, isBuiltInAdapterId } from "../engine/frameworks/index.js";
import { createLlmClientOrUnavailable, type LlmClient } from "../engine/llm/provider.js";
import { runGeneration, type GenerationSummary } from "../engine/orchestrator.js";
import type { Scenario } from "../engine/spec/schema.js";
import { runValidationOnly, type TestToValidate } from "../engine/validate-only.js";
import { runVariantsJob, type VariantTest } from "../engine/validation/variants.js";
import { runEnvironmentJob } from "../engine/environments/run.js";
import { deleteOperationsOf, deleteOperationsOfSpec, mergeOperations } from "../engine/cleanup/helper.js";
import type { CleanupRequest } from "../engine/cleanup/run.js";
import { CleanupStore } from "./cleanup-store.js";
import { applyFrameworkSettings } from "./framework-settings-store.js";
import { applyDeviceFarm } from "./device-farm-run.js";
import { applyExecutorPolicy, customRunInputs } from "./custom-run.js";
import { assertAllowedTarget } from "./net-guard.js";
import { guardedFetch } from "./guarded-fetch.js";
import { isLoadSpec } from "../engine/performance/load.js";
import { loadTargetProblem } from "./load-guard.js";
import { prepareEnvironmentRun } from "./environment-run.js";
import { runPlainJob } from "./plain-run.js";
import { runAgentJob } from "./agent-run.js";
import { resetBeforeRun } from "./test-data-reset-run.js";
import { DataSetStore } from "./environments-store.js";
import { IdentityStore } from "./identity-store.js";
import { tryExpandBlocks } from "../engine/blocks/expand.js";
import { blocksFor, blockView } from "./block-store.js";
import { LocatorStore } from "./locator-store.js";
import { tryResolveSpecRefs } from "../engine/locators/refs.js";
import { cancelSummary } from "./cancel-summary.js";
import { createFrameSink } from "../engine/frames/sink.js";
import { frameHub } from "./frame-hub.js";
import { PLAN_ARTIFACT, PLAN_FILE, planOptionsOf, requireStoredPlan } from "./plan-store.js";
import { planFamilies, planTotal } from "../engine/planning/preview.js";
import { RepoSink } from "./repo-sink.js";
import { nothingRanMessage, pinRunVersions, ReviewStore, withJobStarter } from "./review-store.js";
import { deviceOpenerFor } from "./phone-device.js";
import { MobileTargetSchema } from "../engine/mobile/target.js";
import type { DeviceOpener } from "../engine/mobile/explore/types.js";
import { SecretBox } from "./secrets.js";
import { prepareJobSignIn, type JobSignIn } from "./hard-signin-service.js";
import { meterFor } from "./usage-store.js";
import { routedLlmForJob } from "./llm-routing.js";
import { configuredLlmForJob, resolveProjectAi } from "./ai-config.js";
import { jobPersonGate } from "./phone-person-gate.js";
import { RunnerAgentError } from "./agent-services.js";
import { LEASE_LOST, onHandover } from "./runner-handover.js";
import { TERMINAL_STATES, type JobRow, type Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";

const LEASE_MS = 60_000;

export interface RunnerDeps {
    repo: Repo;
    store: ArtifactStore;
    config: Config;
    llm: LlmClient;
    /** Builds the per-job model client. Tests hand in a scripted double; production leaves it unset. */
    makeLlm?: (config: Config) => LlmClient;
    /** Builds the per-job fast model client (model routing). Tests hand in a scripted double; production builds it from LLM_MODEL_FAST / Settings. */
    makeFastLlm?: (config: Config) => LlmClient;
    /** Opens the phone for AI phone exploration. Tests hand in an in-memory phone or the fake adb; production leaves it unset (this computer's adb or a runner, see phone-device.ts). */
    openDevice?: DeviceOpener;
    /** Called once after a job's final status is recorded (run summaries, alerts). Failures here never reach the job. */
    onJobFinished?: (job: JobRow) => void | Promise<void>;
}

/** The heartbeat failing this many times in a row counts as a lost lease: about half a lease, so the job stops before another worker takes it. */
const MAX_BEAT_FAILURES = 6;

export const jobOverTime = (minutes: number) => `This job was stopped because it ran longer than ${minutes} minute${minutes === 1 ? "" : "s"}, the limit on this server (JOB_MAX_MINUTES).`;

/**
 * One tick of a job's lease timer. A throw from here would have no one to catch it (and take the whole worker down), so a database that fails is
 * counted instead, and only a run of failures gives the job up.
 */
export function leaseTick(o: { beat: () => boolean; cancelRequested: () => boolean; lost: () => void; cancel: () => void }): () => void {
    let failures = 0;
    return () => {
        try {
            if (!o.beat()) o.lost();
            if (o.cancelRequested()) o.cancel();
            failures = 0;
        } catch (err) {
            console.warn("[job] heartbeat failed:", err);
            if (++failures >= MAX_BEAT_FAILURES) o.lost();
        }
    };
}

/** Executes one claimed job end to end and records its final state. Never throws. */
export async function runJob(deps: RunnerDeps, job: JobRow, owner: string): Promise<void> {
    // What the AI writes in this job is the change of the person who started it, for review (review-store.ts).
    return withJobStarter(job.options.startedBy, () => runJobAs(deps, job, owner));
}

async function runJobAs(deps: RunnerDeps, job: JobRow, owner: string): Promise<void> {
    const { repo, store, config } = deps;
    // Which AI this job uses and who pays: read once, here, so the engine never waits for it (ai-config.ts).
    const ai = await resolveProjectAi({ sql: repo.db.sql, config }, job.projectId);
    // A client per job so its token usage is this job's alone (the shared client's counters span jobs).
    // Every model call of the job is counted and checked against the AI budgets before it is made (engine/llm/metered.ts).
    const meter = meterFor(repo, config, job, undefined, ai.billing);
    // The job's events and its agents' actions go through this sink's ordered queue, with the sink's database-only writes (repo-sink.ts).
    const sink = new RepoSink(repo, store, { id: job.id, projectId: job.projectId, applicationId: job.applicationId, mode: job.options.mode });
    // Set when a graceful restart hands this job over (runner-handover.ts): from then on the engine's writes for it are not made.
    let handingOver = false;
    // The engine's sink calls that are still going: the hand-over waits for them before it releases the lease.
    const going = new Set<Promise<unknown>>();
    // What the engine writes through: the same sink, closed by a hand-over (fenceSink).
    const engineSink = fenceSink(sink, () => handingOver, going);
    // With a fast model set, routine steps go to it and hard ones (or ones it fumbles) to the main model; without one this is the main client itself (llm-routing.ts).
    // A project's own configuration keeps to its own models: the server's fallback and fast models are never used for it (ai-config.ts).
    const rawLlm =
        ai.source === "server"
            ? routedLlmForJob(
                  { db: repo.db, config, emit: (e) => (job.options.mode === "validate" || handingOver ? undefined : sink.event(e)) },
                  job,
                  (deps.makeLlm ?? createLlmClientOrUnavailable)(config),
                  deps.makeFastLlm ? { fast: deps.makeFastLlm(config) } : {},
              )
            : configuredLlmForJob({ sql: repo.db.sql, db: repo.db, config }, job, ai, deps.makeLlm);
    const llm = meter ? meter.wrap(rawLlm) : rawLlm;
    const app = repo.getApplication(job.applicationId);
    if (!app) {
        repo.setJobStatus(job.id, "FAILED", "Application record not found");
        return;
    }

    const abort = new AbortController();
    let leaseLost = false;
    // Set when the job ran past JOB_MAX_MINUTES: the reason it is recorded as failed.
    let overTime: string | undefined;
    const ticker = setInterval(
        leaseTick({
            beat: () => repo.heartbeat(job.id, LEASE_MS, owner),
            cancelRequested: () => repo.isCancelRequested(job.id),
            lost: () => {
                leaseLost = true;
                // The reason tells a runner executor not to cancel its task: the attempt that takes the job next picks it up (runner-handover.ts).
                abort.abort(LEASE_LOST);
            },
            cancel: () => {
                abort.abort();
                // A stopped job shows nothing more.
                frameHub.drop(job.id);
            },
        }),
        5_000,
    );
    const maxMinutes = config.JOB_MAX_MINUTES ?? 120;
    const deadline =
        maxMinutes > 0
            ? setTimeout(() => {
                  overTime = jobOverTime(maxMinutes);
                  abort.abort();
              }, maxMinutes * 60_000)
            : undefined;
    // Terminal writes only while we still hold the lease; otherwise another worker owns the job now.
    // Everything the job wrote before is stored first, so its final status never comes before its last event.
    const finish = async (status: "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED", error?: string) => {
        await sink.writes.flush();
        if (repo.ownsJob(job.id, owner)) repo.setJobStatus(job.id, status, error);
        else console.warn(`[job ${job.id.slice(0, 8)}] lease lost; not recording final status ${status}`);
    };
    const emit: EngineContext["emit"] = (e) => {
        // Handed over: the next platform process writes this job's events now.
        if (handingOver) return;
        sink.event(e);
        const line = `[job ${job.id.slice(0, 8)}] ${e.stage}/${e.kind}: ${e.message}`;
        if (e.level === "error") console.error(line);
        else if (process.env.LOG_LEVEL === "debug") console.log(line);
    };
    const o = job.options;
    const validateOnly = o.mode === "validate";
    // A graceful restart while this job waits for a runner (runner-handover.ts): the runner keeps going and the next platform process takes the
    // job up again. Here, in this order, so that nothing of this attempt is written after the lease is released, even with several tests of the
    // job going at once: no more lease beats; no new write starts (the engine's calls, its events, the runner executor's: isHandedOver); the
    // writes already going are waited for and stored; the tests without a result go back to what they were; the queue is closed; the lease
    // is released.
    const unhook = onHandover(job.id, async () => {
        handingOver = true;
        clearInterval(ticker);
        clearTimeout(deadline);
        await Promise.allSettled([...going]);
        await sink.writes.flush();
        const restored = await sink.restoreInterrupted();
        sink.event({ stage: "orchestration", kind: "job_handed_over", level: "warn", message: `The platform is restarting. This run carries on on its runner, and the platform takes it up again when it is back. A test is not run again unless it changed meanwhile.${restored ? ` ${restored === 1 ? "One test without a result yet is" : `${restored} tests without a result yet are`} back to what ${restored === 1 ? "it was" : "they were"} until then.` : ""}` });
        await sink.writes.flush();
        sink.writes.close();
        if (!repo.handOverJob(job.id, owner)) console.warn(`[job ${job.id.slice(0, 8)}] could not be handed over: its lease had moved on`);
        frameHub.drop(job.id);
        meter?.finish();
    });

    try {
        // A project on its own key that cannot be used: the AI work stops here, in plain words. A run of existing tests needs no AI and goes on.
        if (ai.blocked && !validateOnly) throw new Error(ai.blocked);
        const ctx: EngineContext = {
            config,
            llm,
            signal: abort.signal,
            // Where this job's scripts run: this machine today (see engine/frameworks/executor.ts).
            executor: executorFor({ projectId: job.projectId, jobId: job.id, mode: job.options.mode }),
            emit,
        };
        // Retries, fallback models, paused providers and which model answered are told to this job (ai-model-reliability.md).
        rawLlm.setEventSink?.((e) => ctx.emit(e));

        // AI phone exploration: the explorer asks for a phone only when the job's targets include one.
        if (o.targets?.includes("mobile") && (o.mode ?? "generate") === "generate" && !o.fromPlan) ctx.openDevice = deviceOpenerFor(job, deps.openDevice);
        // A phone sign-in that needs a person (a one-time code, a captcha) pauses the exploration and asks on the job page (phone-person-gate.ts).
        if (o.targets?.includes("mobile") && (o.mode ?? "generate") === "generate" && !o.fromPlan) ctx.askPerson = jobPersonGate(repo, job.id);
        // Phone repair suggestions (engine/mobile/repair): a run of existing tests may look at the phone after a phone test could not find its element. Opened only then.
        if (o.mode === "validate" && !ctx.openDevice) ctx.openDevice = deviceOpenerFor(job, deps.openDevice);
        // The project's named test accounts (decrypted here, handed only to the engine; never logged or returned).
        let roles: ReturnType<IdentityStore["get"]> = [];
        try {
            roles = new IdentityStore(repo.db, new SecretBox(config.dataDir, config.SECRET_KEY)).get(job.projectId);
        } catch {
            // Accounts that cannot be read (for example after the encryption key changed) only disable the checks that need them.
        }
        // The project's test data sets: a spec that names one is rendered once per row, wherever it is rendered.
        const dataSets = new DataSetStore(repo.db).asMap(job.projectId);
        // Shared elements (object repository): a test that refers to one is resolved here, so the engine only ever sees concrete locators.
        // The reference stays in the stored spec (repo.updateTest folds it back); a name that cannot be resolved is a plain failure, never a guess.
        const objects = new LocatorStore(repo.db).index(job.projectId);
        // A repair without AI may try a shared element's other locators (engine/healing/deterministic.ts).
        if (objects) ctx.sharedElements = objects;
        // Reusable steps (blocks) are put in place first, in the same way: the engine only ever sees plain steps (see engine/blocks/expand.ts).
        const blocks = blocksFor(repo.db, job.projectId);
        const view = blockView(repo.db, job.projectId);
        const resolveRefs = (t: { testKey: string; spec: Parameters<typeof tryResolveSpecRefs>[0] }) => {
            const expanded = tryExpandBlocks(t.spec, blocks);
            const r = expanded.ok ? tryResolveSpecRefs(expanded.spec, objects) : { ok: false as const, error: expanded.error };
            if (!r.ok) ctx.emit({ stage: "validation", kind: "test_unrunnable", level: "warn", message: `${t.testKey}: not run. ${r.error}` });
            return r;
        };
        // Records data-changing API tests create are removed after the run, unless this run or the project says otherwise.
        let cleanupEnabled = true;
        try {
            cleanupEnabled = o.cleanupAfter ?? new CleanupStore(repo.db).getEnabled(job.projectId) ?? true;
        } catch {
            /* an unreadable switch keeps cleanup on: leaving records behind is the worse mistake */
        }
        const cleanup: CleanupRequest = { enabled: cleanupEnabled, guard: assertAllowedTarget, fetch: guardedFetch };
        /** DELETE operations the application description knows plus the ones this project's tests spell out: what records created by a POST can be removed with. */
        const projectDeleteOps = (apis: Parameters<typeof deleteOperationsOf>[0]) => mergeOperations(deleteOperationsOf(apis), ...repo.listTests(job.projectId).map((t) => deleteOperationsOfSpec(view(t.spec))));
        ctx.emit({
            stage: "orchestration",
            kind: "job_started",
            message: o.mode === "agent" ? `Agent run started for ${app.url}` : o.mode === "plain" ? `Building a test from your description for ${app.url}` : o.mode === "environment" ? `Run against the environment “${o.environment}” started: ${o.testIds?.length ?? 0} test(s)` : o.mode === "variants" ? `Browser and screen-size check started for ${app.url}: ${o.testIds?.length ?? 0} test(s) on ${(o.variants ?? []).join(", ")}` : validateOnly ? `Validation job started (attempt ${job.attempts}) for ${app.url}: ${o.testIds?.length ?? 0} test(s)` : `Job started (attempt ${job.attempts}) for ${app.url}`,
        });
        // Where the project's phone tests run (a device farm, several phones at once): before the framework settings so their time limits still apply. Defaults: nothing changes.
        applyDeviceFarm(ctx, repo, config, job);
        // The project's framework settings (Runners, Frameworks): time limits, workers, headed on an agent, switched-off frameworks. Nothing changes while they are the defaults.
        applyFrameworkSettings(ctx, repo, job);
        // The Explorer view: an exploration and a test built from a sentence may be watched. A picture is only ever taken while someone reads it (platform/frame-hub.ts),
        // and the stored sign-in details are listed so that no field holding one can appear in a picture.
        if (o.mode === "plain" || ((o.mode ?? "generate") === "generate" && !o.fromPlan)) {
            frameHub.addSecrets(job.id, [app.credentials?.password, app.credentials?.totpSecret, app.credentials?.apiToken, ...roles.flatMap((r) => [r.password, r.totpSecret, r.apiToken])]);
            ctx.frames = createFrameSink(frameHub.targetFor(job.id), { secrets: () => frameHub.secretsOf(job.id) });
        }
        // Drafts never run (review-store.ts): each test runs its latest approved version, recorded against this run; a test
        // with none is left out and said to be waiting for approval. The AI writing tests (generate, plain) tries its own drafts.
        const runsTests = o.mode === "validate" || o.mode === "variants" || o.mode === "environment";
        const pins = runsTests ? pinRunVersions(repo.db, job.id, o.testIds ?? []) : undefined;
        if (pins) {
            sink.keepSteps = pins.stale;
            for (const id of pins.waiting) ctx.emit({ stage: "validation", kind: pins.held.has(id) ? "shared_part_changed" : "waiting_for_approval", level: "warn", message: `${repo.getTest(id)?.testKey ?? id}: not run. ${pins.held.get(id) ?? "It is waiting for approval: only approved versions run."}` });
            for (const id of pins.stale) ctx.emit({ stage: "validation", kind: "approved_version_ran", message: `${repo.getTest(id)?.testKey ?? id}: ran its approved version. A newer draft is waiting for approval.` });
            if (pins.waiting.length) {
                const waiting = new Set(pins.waiting);
                o.testIds = (o.testIds ?? []).filter((id) => !waiting.has(id));
                if (o.testIds.length === 0) {
                    await finish("FAILED", nothingRanMessage(pins.waiting.length));
                    return;
                }
            }
        }
        // Code tests in this job: the run policy goes around the executor, and their scripts and helpers are loaded once.
        const custom = customRunInputs(repo, job.projectId, runsTests ? (o.testIds ?? []) : []);
        pins?.applyCustom(custom);
        applyExecutorPolicy(ctx, config, custom.byTest.size > 0);
        for (const name of custom.missing) ctx.emit({ stage: "validation", kind: "custom_helper_missing", level: "warn", message: `A code test imports the helper “${name}”, which this project does not have. Add it on the Code page, or the test will fail.` });

        // The test data reset (when the project or environment has one switched on) comes first: a failure stops the run before any test is touched.
        const reset = await resetBeforeRun(repo, config, job, app, ctx);
        if (reset.stop) {
            await finish("FAILED", reset.stop);
            return;
        }
        // Hard sign-ins: a saved sign-in is checked first ("Still signed in?"); a stale one stops the run before any test is touched.
        // Tests and exploration then start signed in, and email steps read the project's test mailbox (hard-signin-service.ts).
        const signIn: JobSignIn = o.mode === "environment" ? {} : await prepareJobSignIn(ctx, repo.db, config, job.projectId, app.url);
        if (signIn.stop) {
            ctx.emit({ stage: "orchestration", kind: "sign_in_expired", level: "error", message: signIn.stop });
            await finish("FAILED", signIn.stop);
            return;
        }
        if (o.mode === "agent") {
            // The AI pursues an objective and keeps its own record (agent-run.ts): the job only says how it ended.
            const ended = await runAgentJob({ repo, store, config, ctx, job, app, roles, ...(signIn.savedSession ? { storageState: signIn.savedSession.storageState } : {}) });
            await finish(ended.status, ended.error);
            return;
        }
        let summary: GenerationSummary;
        if (o.mode === "environment") {
            // Results for one named environment only: the tests' own validation status and history are never touched.
            const prepared = await prepareEnvironmentRun(repo, config, job, app, roles);
            // The approved version's steps and code, where a newer draft waits (review-store.ts).
            if (pins) {
                prepared.tests = prepared.tests.map((et) => {
                    if (!pins.stale.has(et.handle.id)) return et;
                    const { custom: hand, ...rest } = et;
                    const approved = custom.byTest.get(et.handle.id);
                    return { ...rest, spec: view(pins.test({ id: et.handle.id, spec: et.spec }).spec), ...(hand && approved ? { custom: { ...hand, content: approved.content } } : {}) };
                });
            }
            for (const id of prepared.missing) ctx.emit({ stage: "validation", kind: "test_missing", level: "warn", message: `Test ${id} no longer exists; skipped` });
            for (const note of prepared.notes) ctx.emit({ stage: "validation", kind: "project_accounts_withheld", level: "warn", message: note });
            summary = await runEnvironmentJob(ctx, { ...prepared.request, render: { ...prepared.request.render, deleteOps: projectDeleteOps((app.model ?? repo.getLatestAppModel(job.projectId))?.apis) }, cleanup, ...(custom.helpers.length ? { helpers: custom.helpers } : {}) }, prepared.tests, engineSink);
        } else if (o.mode === "plain") {
            // One test described in plain words: built, run for real, stored (see engine/authoring/plain.ts).
            const model = app.model ?? repo.getLatestAppModel(job.projectId);
            summary = await runPlainJob({ repo, config, ctx, job, app: { ...app, model }, roles, sink: engineSink, cleanup, dataSets, deleteOps: projectDeleteOps(model?.apis) });
        } else if (o.mode === "variants") {
            // Compatibility checks only: the tests' own validation status is never touched.
            const tests: VariantTest[] = [];
            for (const id of o.testIds ?? []) {
                const found = repo.getTest(id);
                const t = found && pins ? pins.test(found) : found;
                if (!t || t.projectId !== job.projectId) {
                    ctx.emit({ stage: "validation", kind: "test_missing", level: "warn", message: `Test ${id} no longer exists; skipped` });
                    continue;
                }
                const resolved = resolveRefs(t);
                if (!resolved.ok) continue;
                tests.push({ handle: { id: t.id, testId: t.testKey }, spec: resolved.spec, validationStatus: t.validationStatus, scriptId: repo.getCurrentScript(t.id)?.id as string | undefined, ...(custom.byTest.has(t.id) ? { custom: { filename: custom.byTest.get(t.id)!.filename, content: custom.byTest.get(t.id)!.content } } : {}) });
            }
            summary = await runVariantsJob(ctx, { url: app.url, credentials: app.credentials, roles, dataSets, ...(custom.helpers.length ? { helpers: custom.helpers } : {}) }, tests, o.variants ?? [], engineSink);
        } else if (validateOnly) {
            // A newer application (e.g. created by a spec import) may not have been discovered yet.
            const model = app.model ?? repo.getLatestAppModel(job.projectId);
            const tests: TestToValidate[] = [];
            // Load checks only go to an allowed address that is not a production environment; decided once, before any is run.
            let loadRefusal: string | undefined | null = null;
            for (const id of o.testIds ?? []) {
                const found = repo.getTest(id);
                const t = found && pins ? pins.test(found) : found;
                if (!t || t.projectId !== job.projectId) {
                    ctx.emit({ stage: "validation", kind: "test_missing", level: "warn", message: `Test ${id} no longer exists; skipped` });
                    continue;
                }
                if (isLoadSpec(view(t.spec))) {
                    if (loadRefusal === null) loadRefusal = await loadTargetProblem(repo.db, job.projectId, [app.config.apiBaseUrl ?? o.apiBaseUrl, app.url]);
                    if (loadRefusal) {
                        ctx.emit({ stage: "validation", kind: "load_skipped", level: "warn", message: `${t.testKey}: not run. ${loadRefusal}` });
                        continue;
                    }
                }
                const resolved = resolveRefs(t);
                if (!resolved.ok) {
                    repo.updateTest(t.id, { validationStatus: "FAILED_VALIDATION", reason: `Script could not be rendered: ${resolved.error}` });
                    continue;
                }
                const meta = t.generationMeta ?? {};
                const endpoint = typeof meta.endpoint === "string" ? model?.apis.find((a) => `${a.method} ${a.path}` === meta.endpoint) : undefined;
                tests.push({
                    handle: { id: t.id, testId: t.testKey },
                    spec: resolved.spec,
                    scenario: (meta.scenario as Scenario | undefined) ?? undefined,
                    endpointDoc: endpoint ? { method: endpoint.method, path: endpoint.path, statuses: endpoint.statuses, requiresAuth: endpoint.requiresAuth, summary: endpoint.summary, spec: endpoint.spec } : undefined,
                    // A test stored for an adapter plug-in framework runs with it (and fails early if it is gone); all others are decided by their kind.
                    ...(isBuiltInAdapterId(t.framework) ? {} : { framework: t.framework }),
                    ...(custom.byTest.has(t.id) ? { custom: custom.byTest.get(t.id)! } : {}),
                });
            }
            summary = await runValidationOnly(ctx, { url: app.url, apiBaseUrl: app.config.apiBaseUrl ?? o.apiBaseUrl, credentials: app.credentials, roles, mobile: app.config.mobile, model, retryFailures: o.retryFailures, variants: o.variants, dataSets, cleanup, deleteOps: projectDeleteOps(model?.apis), ...(custom.helpers.length ? { helpers: custom.helpers } : {}), ...(o.stopOnFirstFailure ? { stopOnFirstFailure: true } : {}) }, tests, engineSink);
        } else {
            // Creating from a plan the person approved: the plan is read back here, so a missing one fails before anything is touched.
            const fromPlan = o.fromPlan ? await requireStoredPlan(repo, store, o.fromPlan) : undefined;
            summary = await runGeneration(
                ctx,
                {
                    ...(o.planOnly ? { planOnly: true } : {}),
                    ...(fromPlan ? { plan: fromPlan, excludeIdeas: o.excludeIdeas } : {}),
                    url: app.url,
                    maxPages: o.maxPages,
                    maxDepth: o.maxDepth,
                    maxScenarios: o.maxScenarios,
                    scope: o.scope,
                    includePaths: o.includePaths,
                    targets: o.targets,
                    ...(o.targets?.includes("mobile") && MobileTargetSchema.safeParse(app.config.mobile).success ? { mobile: MobileTargetSchema.parse(app.config.mobile) } : {}),
                    allowMutatingApiTests: o.allowMutatingApiTests,
                    openApiUrl: o.openApiUrl,
                    apiBaseUrl: o.apiBaseUrl,
                    ...(o.functionalTests === false ? { functionalTests: false } : {}),
                    accessibility: o.accessibility,
                    healthChecks: o.healthChecks,
                    securityChecks: o.securityChecks,
                    performanceChecks: o.performanceChecks,
                    loadChecks: o.loadChecks === true && !(await loadTargetProblem(repo.db, job.projectId, [app.config.apiBaseUrl ?? o.apiBaseUrl, app.url])) ? true : undefined,
                    loadBudgets: o.loadBudgets,
                    inputChecks: o.inputChecks,
                    visionChecks: o.visionChecks,
                    contractChecks: o.contractChecks,
                    performanceBudgets: o.performanceBudgets,
                    visual: o.visual,
                    requirements: o.requirementsText ? { name: o.requirementsName ?? "requirements", text: o.requirementsText } : undefined,
                    variants: o.variants,
                    credentials: app.credentials,
                    roles,
                    accessChecks: o.accessChecks,
                    useMemory: o.useMemory,
                    ...(o.fullExploration ? { fullExploration: true } : {}),
                    cleanup,
                    ...(signIn.savedSession ? { savedSession: signIn.savedSession } : {}),
                },
                engineSink,
            );
        }

        // A run that stops at the abort may simply end: a job past its limit is still a failed one, whatever it got done.
        if (overTime) throw new Error(overTime);

        if (summary.model) {
            await sink.saveTextArtifact("app-model", "application-model.json", JSON.stringify(summary.model, null, 2));
        }

        if (summary.plan) {
            // An exploration that stops at a plan: keep the plan for the person, and say plainly whether there is anything to create.
            await sink.saveTextArtifact(PLAN_ARTIFACT, PLAN_FILE, JSON.stringify(summary.plan));
            const planOpts = planOptionsOf(o, app.credentials);
            const possible = planTotal(planFamilies(summary.plan, planOpts), planOpts.targets);
            if (possible === 0) await finish("FAILED", summary.errors[0] ?? "Nothing to test was found at this address");
            else await finish(summary.errors.length ? "PARTIALLY_COMPLETED" : "COMPLETED", summary.errors.length ? summary.errors.join(" | ").slice(0, 900) : undefined);
            return;
        }
        const total = summary.testsGenerated;
        if (total === 0) {
            await finish("FAILED", summary.errors[0] ?? (o.mode === "variants" ? "None of the selected tests can be checked on other browsers" : validateOnly ? "No executable tests to validate" : "No tests could be generated for this application"));
        } else if (summary.testsValidated === total && summary.errors.length === 0) {
            // A stage that errored (e.g. no LLM for web planning) means part of the job did not run:
            // never report COMPLETED then, even if every test that *was* produced validated.
            await finish("COMPLETED");
        } else {
            const note = summary.errors.length ? summary.errors.join(" | ").slice(0, 900) : undefined;
            await finish("PARTIALLY_COMPLETED", note);
        }
    } catch (err) {
        const cancelled = abort.signal.aborted && repo.isCancelRequested(job.id);
        const msg = cancelled ? "Cancelled" : (overTime ?? (err instanceof Error ? err.message : String(err)));
        emit({ stage: "orchestration", kind: cancelled ? "job_cancelled" : "job_failed", level: cancelled ? "warn" : "error", message: msg });
        // The job's writes so far, this event included, are stored before any test is put back or the status changes.
        await sink.writes.flush();
        if (!leaseLost) {
            if (repo.ownsJob(job.id, owner)) {
                if (cancelled) {
                    // A cancel is not a verdict on any test: the ones that did not get to run go back to what they were (status, reason, history).
                    await sink.restoreInterrupted();
                    repo.setJobStatus(job.id, "FAILED", msg);
                    const facts = cancelSummary(repo.getJob(job.id) ?? { ...job, status: "FAILED", error: msg });
                    if (facts) emit({ stage: "orchestration", kind: "cancel_summary", message: facts.note, data: { planned: facts.planned, ran: facts.ran, notRun: facts.notRun } });
                } else if (validateOnly && err instanceof RunnerAgentError) {
                    // The runner, not a test, failed (it stopped answering, could not start, refused): no test gets a verdict from that.
                    // Tests that had no result yet go back to what they were, as on a cancel, and the run says why (runner-agent.md).
                    const restored = await sink.restoreInterrupted();
                    if (restored) emit({ stage: "orchestration", kind: "runner_failed_tests_restored", level: "warn", message: `The runner could not finish this run, so ${restored === 1 ? "one test that had no result yet is" : `${restored} tests that had no result yet are`} back to what ${restored === 1 ? "it was" : "they were"}. Tests that finished keep their result.` });
                    await sink.writes.flush();
                } else if (validateOnly) {
                    // Tests this job had started must not stay VALIDATING forever (runs that finished were recorded).
                    repo.resetValidatingTests(o.testIds ?? [], "FAILED_VALIDATION", `Validation interrupted: ${msg}`);
                }
            }
            await finish("FAILED", msg);
        }
    } finally {
        unhook();
        clearInterval(ticker);
        clearTimeout(deadline);
        // Nothing about the Explorer view outlives its job.
        frameHub.drop(job.id);
        meter?.finish();
        // Writes still waiting (a lease lost, an early return) are stored before the finished-job hook reads the job.
        await sink.writes.flush();
        // Each execution names the test version it ran (review-store.ts).
        try {
            new ReviewStore(repo.db).finishRun(job.id);
        } catch (e) {
            console.warn(`[job ${job.id.slice(0, 8)}] could not record the test versions this run ran: ${e instanceof Error ? e.message : String(e)}`);
        }
        await cleanScratch(config.scratchDir).catch(() => undefined);
        await notifyFinished(deps, job.id);
    }
}

/** The sink's fire-and-forget calls (nobody waits for them): once the job is handed over they are dropped. */
const SINK_EVENTS = new Set<PropertyKey>(["event", "agentAction"]);

/**
 * The job's sink as the engine sees it, for the hand-over (runner-handover.ts): while `closed()` is false every call goes straight to the
 * sink, and one that returns a promise is in `going` until it settles; once it is true a call makes no write at all: an event is dropped,
 * any other call returns a promise that never settles, so that part of the job stops right there while the process stops.
 */
export function fenceSink<T extends object>(sink: T, closed: () => boolean, going: Set<Promise<unknown>>): T {
    return new Proxy(sink, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver) as unknown;
            if (typeof v !== "function") return v;
            return (...args: unknown[]) => {
                if (closed()) return SINK_EVENTS.has(prop) ? undefined : new Promise<never>(() => undefined);
                const r = (v as (...a: unknown[]) => unknown).apply(target, args);
                if (r && typeof (r as { then?: unknown }).then === "function") {
                    const p = Promise.resolve(r);
                    going.add(p);
                    const done = () => void going.delete(p);
                    void p.then(done, done);
                }
                return r;
            };
        },
    });
}

/** Run the finished-job hook for a job that reached a terminal state (not one another worker now owns). */
async function notifyFinished(deps: RunnerDeps, jobId: string): Promise<void> {
    if (!deps.onJobFinished) return;
    try {
        const done = deps.repo.getJob(jobId);
        if (done && TERMINAL_STATES.includes(done.status)) await deps.onJobFinished(done);
    } catch (err) {
        console.error(`[job ${jobId.slice(0, 8)}] finished-job hook failed:`, err);
    }
}

/** Remove validation scratch directories older than an hour (concurrent jobs keep theirs). */
async function cleanScratch(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith("run-")) continue;
        const full = path.join(dir, e.name);
        const st = await fs.stat(full).catch(() => null);
        if (st && Date.now() - st.mtimeMs > 60 * 60_000) await fs.rm(full, { recursive: true, force: true });
    }
}
