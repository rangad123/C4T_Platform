/**
 * Validation-only pipeline: existing canonical specs (user-imported, edited exports, or previously
 * generated tests being re-validated) → render → execute → validate → persist.
 *
 * Discovery, understanding, planning and generation are skipped; everything from rendering onwards
 * is the same as in the full pipeline (orchestrator.ts): the same validator, the same repair loop
 * and the same GenerationSink persistence, so an imported test ends up exactly like a generated one.
 */
import { resolveApiToken, type OAuth2ClientCredentials } from "./api/oauth.js";
import { throwIfAborted, type EngineContext } from "./context.js";
import { launchChromium } from "./discovery/browser.js";
import { isPrivateHost } from "../platform/net-guard.js";
import { MobileTargetSchema, type MobileTarget } from "./mobile/target.js";
import { startStateSentence } from "./mobile/state/clean-start.js";
import { mobileAvailability } from "./mobile/toolchain.js";
import { localPhoneRunsProblem } from "./mobile/device/choose.js";
import { effectiveRunsOn } from "./mobile/phone-settings.js";
import type { MobileRunEnv } from "./validation/mobile-runner.js";
import type { IosRunEnv } from "./mobile/ios-runner.js";
import type { Framework, RenderContext } from "./generators/index.js";
import { adapterForSpec, getAdapter, hasAdapter, needsDevice, renderWithAdapter, type FrameworkAdapter } from "./frameworks/index.js";
import { explainMissingFramework } from "./frameworks/plugin-loader.js";
import { deleteOperationsOf, deleteOperationsOfSpec, mergeOperations } from "./cleanup/helper.js";
import type { CleanupRequest } from "./cleanup/run.js";
import type { GenerationSink, GenerationSummary, PhaseName, JobStatusName, TestHandle } from "./orchestrator.js";
import type { Scenario, TestSpec } from "./spec/schema.js";
import { dataSetNameOf, resolveRows, truncationNote } from "./testdata/dataset.js";
import type { AppModel } from "./understanding/app-model.js";
import { validateBatch, type TestUnderValidation, type ValidationOutcome } from "./validation/validator.js";
import { runVariantChecks, type VariantTest } from "./validation/variants.js";

export interface ValidationOnlyRequest {
    /** Application URL; its origin is BASE_URL for web tests. */
    url: string;
    apiBaseUrl?: string;
    credentials?: { username?: string; password?: string; totpSecret?: string; apiToken?: string; apiAuthHeader?: string; oauth2?: OAuth2ClientCredentials };
    /** Named test accounts, for scripts that sign in as them. */
    roles?: Array<{ name: string; username: string; password: string; totpSecret?: string; apiToken?: string }>;
    /** The app mobile (Taqwright) tests run against. Without it, mobile tests stay PENDING. */
    mobile?: MobileTarget;
    /** Latest known application model. Only used for repair context; a minimal one is used if absent. */
    model?: AppModel | null;
    /** Extra browsers / screen sizes to re-run the tests that validate on (opt-in; never changes a test's own status). */
    variants?: string[];
    /** Re-run each failing test this many times straight away (scheduled runs use this to spot flaky tests). */
    retryFailures?: number;
    /** The project's test data sets, for specs that name one (rendered once per row). */
    dataSets?: RenderContext["dataSets"];
    /** Remove the records data-changing API tests create once the run ends (see ./cleanup). Absent: scripts remove their own records. */
    cleanup?: CleanupRequest;
    /** DELETE operations known beyond the application model (for example the project's other tests spell some out): what a record created by a POST can be removed with. */
    deleteOps?: string[];
    /** Shared helper modules the hand-written tests import (./helpers/<name>). */
    helpers?: Array<{ name: string; content: string }>;
    /** Run the tests one at a time, in the order given, and stop at the first that does not pass; the tests after it are not run. */
    stopOnFirstFailure?: boolean;
}

export interface TestToValidate {
    handle: TestHandle;
    spec: TestSpec;
    /** Planned scenario, when the test was generated from one — enables LLM web repair. */
    scenario?: Scenario;
    /** Endpoint description for the API repair prompt. */
    endpointDoc?: unknown;
    /** A hand-written test: the script that runs, as stored (never rendered from the spec, never repaired). */
    custom?: { filename: string; content: string; scriptId: string | null };
    /** Set only for a test stored for an adapter plug-in framework (platform/plugin-gate.ts); every other test is run by the framework its kind belongs to. */
    framework?: string;
}

const SKIPPED: Array<[JobStatusName, PhaseName]> = [
    ["DISCOVERING", "discovery"],
    ["ANALYZING", "understanding"],
    ["PLANNING", "planning"],
    ["GENERATING", "generation"],
];

export async function runValidationOnly(ctx: EngineContext, req: ValidationOnlyRequest, tests: TestToValidate[], sink: GenerationSink): Promise<GenerationSummary> {
    const summary: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    for (const [status, phase] of SKIPPED) await sink.phase(status, phase, "skipped");

    const origin = new URL(req.url).origin;
    const model = req.model && req.model.origin === origin ? req.model : stubModel(req.url, origin);
    const renderCtx: RenderContext = { baseUrl: origin, apiBaseUrl: apiBase(req, model, origin), ...(req.dataSets ? { dataSets: req.dataSets } : {}), deleteOps: mergeOperations(deleteOperationsOf(model.apis), req.deleteOps, ...tests.map((t) => deleteOperationsOfSpec(t.spec))) };
    const creds = req.credentials?.username && req.credentials.password ? { username: req.credentials.username, password: req.credentials.password, ...(req.credentials.totpSecret ? { totpSecret: req.credentials.totpSecret } : {}) } : undefined;

    const mobile = resolveMobile(ctx, req.mobile, undefined, phoneMemoryOf(sink, req.mobile));
    const ios = resolveIos(ctx, req.mobile);
    // Tests whose framework cannot run here (no Android device, or no app to test) stay PENDING —
    // they are stored, never reported as passed.
    const runnable: Array<TestToValidate & { framework: Framework }> = [];
    for (const t of tests) {
        let adapter: FrameworkAdapter;
        if (t.framework) {
            // A plug-in framework: it must be loaded now and run this kind of test. Otherwise the test is left as it is (never run by another framework) and the job says why.
            if (!hasAdapter(t.framework)) {
                const why = explainMissingFramework(t.framework);
                ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.handle.testId} was not run. ${why}` });
                summary.errors.push(why);
                continue;
            }
            adapter = getAdapter(t.framework);
            if (!adapter.kinds.includes(t.spec.kind)) {
                const why = `${adapter.label} does not run ${t.spec.kind} tests.`;
                ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.handle.testId} was not run. ${why}` });
                summary.errors.push(`${t.handle.testId} not run: ${why}`);
                continue;
            }
        } else adapter = adapterForSpec(t.spec);
        const framework = adapter.id;
        // The project switched this framework off (Runners, Frameworks): the test is left out, with the reason in plain words.
        const off = ctx.frameworkOff?.(framework);
        if (off) {
            // Deliberate, so it is an event but not an error: a run of the tests that are on is a complete run.
            ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.handle.testId} was not run: ${off}` });
        } else if (adapter.needs.ios && !ios.env) {
            ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.handle.testId} is an iOS test and was not run: ${ios.reason}` });
            summary.errors.push(`${t.handle.testId} not run: ${ios.reason}`);
        } else if (!adapter.needs.ios && needsDevice(adapter) && !mobile.env) {
            ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.handle.testId} is a mobile test and was not run: ${mobile.reason}` });
            summary.errors.push(`${t.handle.testId} not run: ${mobile.reason}`);
        } else if (adapter.executable) runnable.push({ ...t, framework });
        else ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.handle.testId} is a ${t.spec.kind} test (${framework}); it is stored but not executed here` });
    }
    summary.testsGenerated = runnable.length;
    await sink.counters({ testsGenerated: runnable.length });
    if (runnable.length === 0) {
        summary.errors.push("No executable tests to validate");
        await sink.phase("VALIDATING", "validation", "skipped");
        return summary;
    }
    throwIfAborted(ctx.signal);

    await sink.phase("VALIDATING", "validation", "running");
    ctx.emit({ stage: "validation", kind: "validation_only_started", message: `Validating ${runnable.length} existing test(s) against ${origin}` });
    // A data set larger than one test renders is cut short; say so plainly (the script itself carries a comment too).
    for (const t of runnable) {
        const name = dataSetNameOf(t.spec.testData);
        const rows = name && req.dataSets?.[name] ? resolveRows(name, req.dataSets) : undefined;
        if (rows?.truncated) ctx.emit({ stage: "validation", kind: "data_set_truncated", level: "warn", message: `${t.handle.testId}: ${truncationNote(name!, rows.total)}` });
    }
    const validationStartedAt = new Date().toISOString();
    const handles = new Map<string, TestHandle>();
    /** Current script row per test, so executions always reference the script version that ran. */
    const scriptIds = new Map<string, string>();
    const pending: TestUnderValidation[] = [];
    /** With stopOnFirstFailure: the test whose failure ended the run. */
    let stoppedBy: string | undefined;
    for (const t of runnable) {
        handles.set(t.spec.testId, t.handle);
        await sink.updateTest(t.handle, { validation: "VALIDATING" });
        // A hand-written test: the stored script is the source of truth and runs as it is.
        if (t.custom) {
            if (t.custom.scriptId) scriptIds.set(t.spec.testId, t.custom.scriptId);
            pending.push({ spec: t.spec, framework: t.framework, custom: { filename: t.custom.filename, content: t.custom.content } });
            continue;
        }
        // The spec is the source of truth: re-render so the script that runs always matches it.
        try {
            scriptIds.set(t.spec.testId, await sink.saveScript(t.handle, renderWithAdapter(t.spec, t.framework, renderCtx), true));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await sink.updateTest(t.handle, { validation: "FAILED_VALIDATION", reason: `Script could not be rendered: ${msg}` });
            summary.testsFailedValidation++;
            summary.errors.push(`${t.spec.testId}: ${msg}`);
            // Stopping at the first failure: a test that cannot even be rendered is that failure; the tests after it are not touched.
            if (req.stopOnFirstFailure) {
                stoppedBy = t.spec.testId;
                break;
            }
            continue;
        }
        // Visual tests compare against their approved baselines (none yet → this run captures them).
        const baselines = await sink.loadBaselines(t.handle);
        pending.push({ spec: t.spec, framework: t.framework, scenario: t.scenario, endpointDoc: t.endpointDoc, baselines: baselines.length ? baselines : undefined });
    }

    /** Tests that finished validation, for the optional browser / screen-size step that follows. */
    const validated: VariantTest[] = [];
    if (pending.length) {
        // A mobile-only batch needs no browser (and on a small machine the emulator needs the memory).
        // When the scripts run on a runner agent, the application may only be reachable from the agent's network: this machine's browser must not go there, so repair is skipped for a private address.
        const agentOnlyTarget = ctx.executor?.remote === true && isPrivateHost(new URL(req.url).hostname.replace(/^\[|\]$/g, ""));
        const wantsRepairBrowser = pending.some((t) => !t.custom && getAdapter(t.framework).traits.browserRepair);
        // EXECUTION_MODE=runners: this server opens no browser (platform/runner-only.ts), so a failing test gets no repair suggestion that needs one.
        const noServerBrowser = ctx.config.EXECUTION_MODE === "runners";
        if (noServerBrowser && wantsRepairBrowser) ctx.emit({ stage: "validation", kind: "repair_browser_skipped", message: "Repair suggestions that need a browser are not made for this run: tests run only on runners here, and the platform opens no browser of its own." });
        const browser = !agentOnlyTarget && !noServerBrowser && wantsRepairBrowser ? await launchChromium(ctx.config.HEADLESS) : undefined;
        try {
            const apiToken = await resolveApiToken(ctx, req.credentials);
            const batch = (items: TestUnderValidation[]): Promise<ValidationOutcome[]> => validateBatch(
                ctx,
                {
                    browser,
                    scratchDir: ctx.config.scratchDir,
                    env: { baseUrl: origin, apiBaseUrl: renderCtx.apiBaseUrl, credentials: creds, roles: req.roles, apiToken, apiAuthHeader: req.credentials?.apiAuthHeader, headless: ctx.config.HEADLESS },
                    render: renderCtx,
                    model,
                    // These are existing tests, run as approved: a repair waits for review and is not run in this job.
                    maxRepairAttempts: Math.min(ctx.config.MAX_REPAIR_ATTEMPTS, 1),
                    repairsAreDrafts: true,
                    workers: ctx.config.CONCURRENCY,
                    retryFailures: req.retryFailures,
                    mobile: mobile.env,
                    ...(ios.env ? { ios: ios.env } : {}),
                    cleanup: req.cleanup,
                    ...(req.helpers?.length ? { helpers: req.helpers } : {}),
                },
                items,
                {
                    onCleanup: sink.saveCleanup ? (items) => sink.saveCleanup!(items) : undefined,
                    async onAttempt(t, attempt, _script, run) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.recordExecution(h, scriptIds.get(t.spec.testId) ?? null, attempt, run, attempt === 1 ? validationStartedAt : new Date(Date.now() - run.durationMs).toISOString());
                        await sink.updateTest(h, { attempts: attempt });
                    },
                    async onRepaired(t, spec) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.updateTest(h, { spec });
                        scriptIds.set(t.spec.testId, await sink.saveScript(h, renderWithAdapter(spec, t.framework, renderCtx), true));
                    },
                    async onFinal(t, outcome) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.updateTest(h, { validation: outcome.status, reason: outcome.reason ?? null, attempts: outcome.attempts, spec: outcome.spec });
                    },
                    async onNewBaselines(t, files) {
                        await sink.saveBaselines(handles.get(t.spec.testId)!, files);
                    },
                    // A test the cancel came before: it keeps its earlier status, reason and history (nothing was recorded for it).
                    onNotRun: async (t) => await sink.restoreTest?.(handles.get(t.spec.testId)!),
                    // Repair suggestions for missing elements are stored where the host keeps them; without storage they are not computed.
                    onHealing: sink.saveHealing ? async (t, heal) => void (await sink.saveHealing!(handles.get(t.spec.testId)!, heal)) : undefined,
                },
            );
            let outcomes: ValidationOutcome[];
            if (!req.stopOnFirstFailure) outcomes = await batch(pending);
            else {
                // One at a time, in order: the first test that does not pass ends the run, and the tests after it keep what they had.
                outcomes = [];
                for (let i = 0; i < pending.length; i++) {
                    const [o] = await batch([pending[i]!]);
                    if (o) outcomes.push(o);
                    const failed = o && o.status !== "VALIDATED" && o.status !== "NOT_RUN";
                    if (failed || ctx.signal?.aborted) {
                        if (failed) stoppedBy = o!.spec.testId;
                        for (const rest of pending.slice(i + 1)) await sink.restoreTest?.(handles.get(rest.spec.testId)!);
                        break;
                    }
                }
            }
            for (const o of outcomes) {
                if (o.status === "NOT_RUN") continue;
                validated.push({ handle: handles.get(o.spec.testId)!, spec: o.spec, validationStatus: o.status, scriptId: scriptIds.get(o.spec.testId), ...(pending.find((p) => p.spec.testId === o.spec.testId)?.custom ? { custom: pending.find((p) => p.spec.testId === o.spec.testId)!.custom } : {}) });
                if (o.status === "VALIDATED") summary.testsValidated++;
                else if (o.status === "NEEDS_REVIEW") summary.testsNeedingReview++;
                else summary.testsFailedValidation++;
            }
        } finally {
            await browser?.close().catch(() => undefined);
        }
    }
    if (stoppedBy) {
        const ran = new Set([...validated.map((v) => v.spec.testId), stoppedBy]);
        const notRun = runnable.filter((t) => !ran.has(t.spec.testId)).length;
        ctx.emit({ stage: "validation", kind: "stopped_on_failure", level: "warn", message: `Stopped at the first failure (${stoppedBy})${notRun ? `: ${notRun} test(s) after it were not run` : ""}.`, data: { testId: stoppedBy, notRun } });
    }
    await sink.counters({
        testsValidated: summary.testsValidated,
        testsFailedValidation: summary.testsFailedValidation,
        testsNeedingReview: summary.testsNeedingReview,
        llmInputTokens: ctx.llm.usage.inputTokens,
        llmOutputTokens: ctx.llm.usage.outputTokens,
    });
    if (req.variants?.length && validated.length) {
        throwIfAborted(ctx.signal);
        await runVariantChecks(ctx, { scratchDir: ctx.config.scratchDir, env: { baseUrl: origin, credentials: creds, roles: req.roles, headless: ctx.config.HEADLESS }, render: renderCtx, workers: ctx.config.CONCURRENCY, sink, ...(req.helpers?.length ? { helpers: req.helpers } : {}) }, validated, req.variants);
    }
    await sink.phase("VALIDATING", "validation", "done");
    // Cancellation during validation: results so far are recorded truthfully, but the job ends as cancelled.
    throwIfAborted(ctx.signal);
    ctx.emit({
        stage: "orchestration",
        kind: "job_summary",
        message: `${summary.testsGenerated} tests executed, ${summary.testsValidated} validated, ${summary.testsNeedingReview} need review, ${summary.testsFailedValidation} failed validation`,
    });
    return summary;
}

/** Keeps the screen a run found that opens the app (shown under Settings, Mobile app). Undefined when the host keeps nothing. */
export function phoneMemoryOf(sink: Pick<GenerationSink, "rememberPhone">, target: MobileTarget | undefined): MobileRunEnv["onDevice"] {
    if (!sink.rememberPhone || !target?.appPackage) return undefined;
    const appPackage = target.appPackage;
    return async (d) => {
        if (d.component?.startsWith(`${appPackage}/`)) await sink.rememberPhone!({ appActivity: { appPackage, activity: d.component.slice(appPackage.length + 1) } });
    };
}

/** Decide where mobile tests run: the project's app target on an emulator, if this machine has one. */
export function resolveMobile(ctx: EngineContext, target: MobileTarget | undefined, credentials?: { username: string; password: string }, onDevice?: MobileRunEnv["onDevice"]): { env?: MobileRunEnv; reason?: string } {
    if (!target) return { reason: "this project has no mobile app set up (give it an app package or an APK)" };
    const parsed = MobileTargetSchema.safeParse(target);
    if (!parsed.success) return { reason: `the mobile app settings are invalid (${parsed.error.issues[0]?.message ?? "unknown problem"})` };
    if (!parsed.data.appPackage && !parsed.data.apkPath) return { reason: "this project has no Android app set up (give it an app package or an APK)" };
    // How every phone test starts (fresh app data, permissions granted): said once in the run's events (mobile/state/clean-start.ts).
    const startState = startStateSentence(parsed.data);
    if (startState) ctx.emit({ stage: "validation", kind: "phone_start_state", message: startState });
    // On a device farm the farm's phones decide (engine/mobile/cloud): this computer needs no Android tools.
    if (ctx.deviceFarm) return { env: { target: parsed.data, avd: "", ...(credentials ? { credentials } : {}), log: (message) => ctx.emit({ stage: "validation", kind: "device_farm", message }) } };
    // On a runner agent the agent's devices decide (it is checked when the job is created and again when the task is offered), not this machine's.
    if (ctx.executor?.remote) return { env: { target: parsed.data, avd: parsed.data.avd ?? ctx.config.MOBILE_AVD ?? "", keepEmulator: ctx.config.MOBILE_KEEP_EMULATOR, ...(credentials ? { credentials } : {}), log: (message) => ctx.emit({ stage: "validation", kind: "emulator", message }) } };
    const avail = mobileAvailability();
    // A connected phone needs only the Android tools, not an emulator: the run picks the device (mobile/device/choose.ts) and says plainly when there is none.
    const phoneProblem = localPhoneRunsProblem();
    if (!avail.available && phoneProblem) return { reason: avail.reason };
    const named = effectiveRunsOn(parsed.data).kind === "phone" || effectiveRunsOn(parsed.data).kind === "explored";
    let avd = parsed.data.avd ?? ctx.config.MOBILE_AVD ?? avail.avds[0] ?? "";
    if (avd && !avail.avds.includes(avd)) {
        // A project whose tests run on a named phone does not need its emulator here; any other project does.
        if (!named) return { reason: `emulator "${avd}" does not exist here (available: ${avail.avds.join(", ") || "none"})` };
        avd = "";
    }
    // MOBILE_RUNNER_CLI replaces the Taqwright entry point; the test suite uses it to exercise this path without an emulator.
    const cliPath = process.env.MOBILE_RUNNER_CLI || undefined;
    return { env: { target: parsed.data, avd, keepEmulator: ctx.config.MOBILE_KEEP_EMULATOR, cliPath, manageEmulator: !cliPath, ...(credentials ? { credentials } : {}), log: (message) => ctx.emit({ stage: "validation", kind: "emulator", message }), ...(onDevice ? { onDevice } : {}) } };
}

/**
 * Decide where iOS tests run: on a runner agent on a Mac, never on this server. The agent picks the simulator and checks its own tools
 * (it is checked when the job is created and again when the task is offered); here only the project's app is needed.
 */
function resolveIos(ctx: EngineContext, target: MobileTarget | undefined): { env?: IosRunEnv; reason?: string } {
    if (!ctx.executor?.remote) return { reason: "iOS tests need a runner agent on a Mac with Xcode, and this project's tests run on the server" };
    const parsed = target ? MobileTargetSchema.safeParse(target) : undefined;
    if (!parsed?.success || !parsed.data.iosBundleId) return { reason: "this project has no iOS app set up (give it an iOS bundle id)" };
    return { env: { target: { iosBundleId: parsed.data.iosBundleId, ...(parsed.data.simulator ? { simulator: parsed.data.simulator } : {}) }, log: (message) => ctx.emit({ stage: "validation", kind: "simulator", message }) } };
}

/** Same rule as the full pipeline: a spec's own `servers` URL is only trusted on the app's origin. */
function apiBase(req: ValidationOnlyRequest, model: AppModel, origin: string): string {
    if (req.apiBaseUrl) return req.apiBaseUrl;
    const specBase = model.openApi?.baseUrl;
    if (specBase) {
        try {
            if (new URL(specBase).origin === origin) return specBase;
        } catch {
            /* relative or malformed servers URL — fall back to the origin */
        }
    }
    return origin;
}

export function stubModel(url: string, origin: string): AppModel {
    return {
        url,
        origin,
        siteType: "unknown",
        purpose: "",
        features: [],
        pages: [],
        navigation: [],
        apis: [],
        authentication: { required: false, mechanisms: [], loggedIn: false },
        journeys: [],
        externalDependencies: [],
        documentedTestCases: [],
        stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    };
}
