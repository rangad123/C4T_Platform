/**
 * Validation loop:  render → run → pass? → VALIDATED
 *                               └ fail → analyse → (fixable) regenerate → re-run … up to N attempts
 *
 * A test only becomes VALIDATED if the rendered script really executed and passed under Playwright.
 *   VALIDATED          passed when executed
 *   NEEDS_REVIEW       failure is (or may be) a real application defect — a human should look
 *   FAILED_VALIDATION  could not be made to pass (environment problem, unfixable, attempts exhausted)
 */
import { captchaFinding } from "../auth/captcha-run.js";
import type { Browser } from "playwright";
import { mapLimit, type EngineContext } from "../context.js";
import { LlmNotConfiguredError } from "../llm/provider.js";
import { isBudgetExceeded } from "../llm/usage.js";
import { deleteOperationsOfSpec, mergeOperations } from "../cleanup/helper.js";
import type { FinishedItem } from "../cleanup/ledger.js";
import { CleanupCollector, finishCleanup } from "../cleanup/run.js";
import type { Framework, RenderContext, RenderedScript } from "../generators/index.js";
import { groupByRuntime, localExecutor, renderWithAdapter, type ScriptExecutor } from "../frameworks/index.js";
import type { Scenario, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import { a11yFinding } from "../a11y/specs.js";
import { contractFinding } from "../contracts/specs.js";
import { healthFinding } from "../health/specs.js";
import { accessFinding } from "../identity/access.js";
import { signInFailure } from "../identity/signed-in.js";
import { inputFinding } from "../inputs/specs.js";
import { latencyFinding } from "../performance/latency.js";
import { isLoadSpec, loadFinding } from "../performance/load.js";
import { performanceFinding } from "../performance/specs.js";
import { securityFinding } from "../security/specs.js";
import { applyVisionJudgement } from "../vision/judge.js";
import { isVisionFailure, visionFinding, visionUnavailable } from "../vision/specs.js";
import { isMissingBaseline, visualFinding } from "../visual/baseline.js";
import { proposeHeal, type HealResult } from "../healing/heal.js";
import { phoneRepairTarget, proposePhoneRepair } from "../mobile/repair/phone-repair.js";
import { phoneQualityFinding } from "../mobile/quality/findings.js";
import { repairApi, repairWeb } from "./repair.js";
import { repairWithoutAi } from "./det-repair.js";
import { deterministicRepairOn } from "../llm/without-ai.js";
import type { MobileRunEnv } from "./mobile-runner.js";
import type { IosRunEnv } from "../mobile/ios-runner.js";
import { missingApiTokenReason } from "../evidence/failure-facts.js";
import { KNOWN_BUG_FIXED, markUnfinishedAsNotRun, type RunEnv, type ScriptInput, type ScriptRun } from "./runner.js";
// A phone run the phone itself could not carry out (device/infra.ts): said plainly, never a failing test of the app, never repaired.
import { isPhoneInfrastructure } from "../mobile/device/infra.js";

export type ValidationStatus = "VALIDATED" | "FAILED_VALIDATION" | "NEEDS_REVIEW";

export interface TestUnderValidation {
    spec: TestSpec;
    framework: Framework;
    scenario?: Scenario;
    /** OpenAPI/observed-endpoint description handed to the API repair prompt. */
    endpointDoc?: unknown;
    /** Approved baseline screenshots (visual tests). Absent on a test's first validation. */
    baselines?: Array<{ name: string; path: string }>;
    /** A hand-written test: this script runs as it is. It is never re-rendered from the spec, repaired or healed. */
    custom?: { filename: string; content: string };
}

export interface ValidationOutcome {
    /** NOT_RUN: the job was cancelled before this test finished. It has no result, and nothing about the test is to change. */
    status: ValidationStatus | "NOT_RUN";
    reason?: string;
    spec: TestSpec;
    script: RenderedScript;
    attempts: number;
    lastRun: ScriptRun;
}

/** An outcome that is a result: the test ran. */
export type FinishedOutcome = ValidationOutcome & { status: ValidationStatus };

export interface ValidationHooks {
    /** Called after every execution (including repaired re-runs). */
    onAttempt(t: TestUnderValidation, attempt: number, script: RenderedScript, run: ScriptRun): Promise<void>;
    /** Called when a repair produced a new spec version. */
    onRepaired?(t: TestUnderValidation, spec: TestSpec, reason: string): Promise<void>;
    onFinal(t: TestUnderValidation, outcome: FinishedOutcome): Promise<void>;
    /** Called instead of onFinal for a test the job was cancelled before it could finish: put back whatever it was before the run. */
    onNotRun?(t: TestUnderValidation): void | Promise<void>;
    /** Called when a visual test's first run captured baseline screenshots; persist them. */
    onNewBaselines?(t: TestUnderValidation, files: Array<{ name: string; path: string }>): Promise<void>;
    /**
     * Called after a web test that did not pass was recorded, with the outcome of the locator-healing analysis: a proposal when
     * its element is missing and exactly one clear replacement exists, otherwise "none". Suggestions only; nothing is changed.
     * Present only where proposals are stored.
     */
    onHealing?(t: TestUnderValidation, result: HealResult): Promise<void>;
    /** Called once, after every test is done, with the ledger of records the tests created and what became of each (see ../cleanup/run.ts). Only when records were created. */
    onCleanup?(items: FinishedItem[]): void | Promise<void>;
}

/** Said on a failed run of an approved test whose repair was saved instead of run. */
export const REPAIR_WAITS_FOR_REVIEW = "A repair was saved as a new version for review. It was not run: only approved versions run.";

export interface ValidationDeps {
    /** Needed only to repair web tests; a mobile-only batch runs without a browser. */
    browser?: Browser;
    scratchDir: string;
    env: RunEnv;
    render: RenderContext;
    model: AppModel;
    maxRepairAttempts: number;
    /**
     * Runs of tests a person already approved: a repair is kept as a new version for review and is never run here (only approved versions run).
     * The run's failure stands as it is. Repairs that need test runs to find (det-repair.ts) are not tried.
     */
    repairsAreDrafts?: boolean;
    workers: number;
    /**
     * A new authored web test that is about to be reported as not validated runs once more first, so the reason says whether it is
     * flaky ("passed 1 of 2 runs") or broken ("fails every time at ..."), with a healing candidate when one exists. Default off.
     */
    confirmFailures?: boolean;
    /**
     * A new authored web test that passed runs this many times more before it is VALIDATED (the level's repeatPasses); any failure
     * among them makes it flaky. Default 0.
     */
    repeatPasses?: number;
    /** Re-run a failing script this many times before analysing/repairing it (scheduled runs). Default 0. */
    retryFailures?: number;
    /** Where Taqwright (mobile) scripts run. Absent: such scripts report an error instead of running. */
    mobile?: MobileRunEnv;
    /** Where iOS (taqwright-ios) scripts run. Absent: such scripts report an error instead of running. */
    ios?: IosRunEnv;
    /** Where scripts run. Default: the job's executor (`ctx.executor`), else this machine. */
    executor?: ScriptExecutor;
    /**
     * Test-data cleanup: set it and the scripts only write down the records they create; after the last test the platform removes them
     * (or, with enabled=false, only lists them). Unset: scripts clean up after themselves, as a downloaded script does.
     */
    cleanup?: { enabled: boolean; /** Outbound guard for every DELETE (the platform passes assertAllowedTarget). */ guard?: (url: string) => Promise<void>; fetch?: typeof fetch; /** Set by validateBatch. */ collect?: (testId: string, run: ScriptRun) => void };
    /** Shared helper modules the hand-written tests of this batch import (./helpers/<name>). */
    helpers?: Array<{ name: string; content: string }>;
}

/**
 * Run scripts with the runner their framework needs; results come back in input order. Scripts whose adapters share a runtime
 * (Playwright web and API) go out as one batch; batches run in adapter registration order (web first, then mobile), through the executor.
 */
async function execute(ctx: EngineContext, deps: ValidationDeps, items: Array<ScriptInput & { framework: Framework }>, workers: number): Promise<ScriptRun[]> {
    const out: ScriptRun[] = new Array(items.length);
    const executor = deps.executor ?? ctx.executor ?? localExecutor;
    for (const { adapter, entries } of groupByRuntime(items, (item) => item.framework)) {
        const group = entries.map(({ item, index }) => ({ item, i: index }));
        // `run` is what Playwright-style frameworks read, `mobile` what device frameworks read; each adapter ignores the other.
        const env = { run: deps.cleanup && adapter.traits.cleanupLedger ? { ...deps.env, cleanup: deps.cleanup.enabled ? ("platform" as const) : ("off" as const) } : deps.env, mobile: deps.mobile, ...(deps.ios ? { ios: deps.ios } : {}) };
        let runs: ScriptRun[];
        try {
            runs = await executor.execute(adapter.id, { scratchDir: deps.scratchDir, scripts: group.map(({ item }) => item), ...(deps.helpers?.length && group.some(({ item }) => item.custom) ? { helpers: deps.helpers } : {}) }, env, { workers, signal: ctx.signal });
        } catch (err) {
            // A cancelled job: whatever was on its way has no result. That is "not run", not a failure of any test.
            if (!ctx.signal?.aborted) throw err;
            runs = group.map(({ item }): ScriptRun => ({ testId: item.testId, status: "error", durationMs: 0, error: "The run was cancelled before this test finished.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
        }
        markUnfinishedAsNotRun(runs, ctx.signal);
        group.forEach(({ i }, k) => (out[i] = runs[k]!));
        if (adapter.traits.cleanupLedger && deps.cleanup?.collect) group.forEach(({ item }, k) => deps.cleanup!.collect!(item.testId, runs[k]!));
        // AI judgement of the screenshots of `looksRight` steps is folded into the run here, so recording, classification, severity
        // and retries all see one picture. Only runs that carry such screenshots cost anything (see ../vision/judge.ts).
        if (adapter.traits.visionJudgement) for (const { i } of group) await applyVisionJudgement(ctx, deps.browser, out[i]!);
    }
    return out;
}

export async function validateBatch(
    ctx: EngineContext,
    deps: ValidationDeps,
    tests: TestUnderValidation[],
    hooks: ValidationHooks,
): Promise<ValidationOutcome[]> {
    const current = tests.map((t) => ({ ...t }));
    const scripts = current.map((t) => (t.custom ? { framework: t.framework, filename: t.custom.filename, content: t.custom.content, language: "typescript" as const } : renderWithAdapter(t.spec, t.framework, deps.render)));
    /** What goes to the runner for a test: a hand-written script is marked so the machine can refuse or check it. */
    const input = (t: TestUnderValidation, s: { filename: string; content: string }) => ({ testId: t.spec.testId, filename: s.filename, content: s.content, baselines: t.baselines, framework: t.framework, ...(t.custom ? { custom: true } : {}) });
    // Records data-changing API tests create are collected from every run (repairs and retries included) and removed at the end.
    const collector = deps.cleanup ? new CleanupCollector(mergeOperations(deps.render.deleteOps, ...current.map((t) => deleteOperationsOfSpec(t.spec)))) : undefined;
    if (collector && deps.cleanup) deps = { ...deps, cleanup: { ...deps.cleanup, collect: (testId, run) => { const t = current.find((c) => c.spec.testId === testId); if (t) collector.addRun(t.spec, run); } } };

    ctx.emit({ stage: "validation", kind: "validation_started", message: `Executing ${tests.length} generated scripts` });
    const firstRuns = await execute(
        ctx,
        deps,
        scripts.map((s, i) => input(current[i]!, s)),
        deps.workers,
    );

    /** Another run of one script. Undefined when the job was cancelled before it gave a result (the run before it then stands). */
    const runAgain = async (t: TestUnderValidation, script: { filename: string; content: string }): Promise<ScriptRun | undefined> => {
        const [next] = (await execute(ctx, deps, [input(t, script)], 1)) as [ScriptRun];
        return next.notRun ? undefined : next;
    };
    /** A test that ran and failed, whose repair or re-run the cancel cut off: the failure it had stays, with the reason said. */
    const cancelledOutcome = (t: TestUnderValidation, script: RenderedScript, run: ScriptRun, attempt: number): FinishedOutcome => ({ status: "FAILED_VALIDATION", reason: `${summarise(run)} (repair skipped: job cancelled)`, spec: t.spec, script, attempts: attempt, lastRun: run });
    /** A test the cancel arrived before: no result, no record; whatever it was before the run is put back. */
    const notRun = async (t: TestUnderValidation, script: RenderedScript, run: ScriptRun): Promise<ValidationOutcome> => {
        await hooks.onNotRun?.(t);
        return { status: "NOT_RUN", spec: t.spec, script, attempts: 0, lastRun: run };
    };

    const results = await mapLimit(current, Math.max(1, deps.workers), async (t, i) => {
        // No abort check here: a run that already happened must be recorded truthfully (a test that
        // passed stays VALIDATED even if the job is being cancelled). Cancellation only stops repairs.
        let script = scripts[i]!;
        let run = firstRuns[i]!;
        let attempt = 1;
        let repairs = 0;
        // Cancelled before this test finished: nothing is recorded for it and nothing about it changes.
        if (run.notRun) return await notRun(t, script, run);
        await hooks.onAttempt(t, attempt, script, run);
        logRun(ctx, t.spec, run, attempt);

        let outcome: FinishedOutcome | undefined;
        if (isMissingBaseline(run)) {
            // First visual run: Playwright just wrote the baselines. Keep them, then re-run once against
            // them — a page that differs between two consecutive loads cannot be baselined reliably.
            const fresh = run.newBaselines!;
            await hooks.onNewBaselines?.(t, fresh);
            t.baselines = [...(t.baselines ?? []), ...fresh];
            ctx.emit({ stage: "validation", kind: "baseline_captured", message: `${t.spec.testId}: captured ${fresh.length} baseline screenshot(s); checking stability` });
            attempt++;
            const again = await runAgain(t, script);
            if (again) {
                run = again;
                await hooks.onAttempt(t, attempt, script, run);
                logRun(ctx, t.spec, run, attempt);
            } else outcome = cancelledOutcome(t, script, run, attempt);
            if (!outcome && run.status !== "passed") {
                const unstable = visualFinding(t.spec, run);
                outcome = {
                    status: "FAILED_VALIDATION",
                    reason: unstable
                        ? `Page is not visually stable between two consecutive loads (dynamic content?), so it cannot be baselined. ${unstable.replace(/^Visual change: /, "")}`
                        : summarise(run),
                    spec: t.spec,
                    script,
                    attempts: attempt,
                    lastRun: run,
                };
            }
        }
        // Scheduled re-runs: a failure gets another go straight away with the very same script. A pass after
        // a fail is a flaky pass (both results are recorded as executions), not a regression.
        // A load check is never run again straight away: a second round of up to 300 requests is exactly what it must not send (it confirms itself).
        for (let retries = isLoadSpec(t.spec) ? 0 : (deps.retryFailures ?? 0); run.status !== "passed" && !outcome && retries > 0 && !ctx.signal?.aborted && !isVisionFailure(run); retries--) {
            ctx.emit({ stage: "validation", kind: "validation_retry", level: "warn", message: `${t.spec.testId} failed; running it again to tell a flaky test from a real failure` });
            attempt++;
            const again = await runAgain(t, script);
            if (!again) {
                outcome = cancelledOutcome(t, script, run, attempt);
                break;
            }
            run = again;
            await hooks.onAttempt(t, attempt, script, run);
            logRun(ctx, t.spec, run, attempt);
            if (run.status === "passed") ctx.emit({ stage: "validation", kind: "flaky_pass", level: "warn", message: `${t.spec.testId} passed on the re-run after failing: flagged as flaky` });
        }
        while (run.status !== "passed" && !outcome) {
            // A hand-written test is never repaired: nothing here may rewrite the person's code. It fails as it is, with the real reason.
            if (t.custom) {
                outcome = { status: "FAILED_VALIDATION", reason: summarise(run), spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            // What the run proves comes first, whatever is left of the repair budget or whether a cancel has arrived: facts beat models,
            // and the class of a result (finding or failure) never depends on how many times the test was run on the way here.
            const known = classifyFailedRun(t.spec, run);
            if (known) {
                outcome = { ...known, spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            // The application refused the request because no API token is saved for the project: name that, instead of a mismatch no repair could fix.
            const noToken = missingApiTokenReason(t.spec, run, { apiToken: deps.env.apiToken, apiAuthHeader: deps.env.apiAuthHeader });
            if (noToken) {
                outcome = { status: "FAILED_VALIDATION", reason: noToken, spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            // Health / security checks are deterministic: a model cannot "repair" a page that did not load or a
            // request that could not be made, so such a run is reported as it is.
            if (isLoadSpec(t.spec) || t.spec.source.origin === "health-check" || t.spec.source.origin === "security-check" || t.spec.source.origin === "performance-check" || t.spec.source.origin === "input-check" || t.spec.source.origin === "access-check" || t.spec.source.origin === "vision-check") {
                outcome = { status: "FAILED_VALIDATION", reason: summarise(run), spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            // Repairs are counted on their own: an immediate re-run of a failing script (scheduled runs) is not a repair attempt.
            if (repairs >= deps.maxRepairAttempts) {
                outcome = { status: "FAILED_VALIDATION", reason: summarise(run), spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            if (ctx.signal?.aborted) {
                outcome = cancelledOutcome(t, script, run, attempt);
                break;
            }
            // Repair without AI first (det-repair.ts): plain-rule fixes for a missing element, each tried with a real run; the model is asked only when none passes.
            if (!deps.repairsAreDrafts && t.spec.kind === "web" && t.scenario && deps.browser && deterministicRepairOn(ctx.config)) {
                const det = await repairWithoutAi({ ctx, browser: deps.browser, baseUrl: deps.render.baseUrl, spec: t.spec, run, credentials: deps.env.credentials, rerun: (spec) => runAgain(t, renderWithAdapter(spec, t.framework, deps.render)) });
                if (det.status === "stopped") {
                    outcome = cancelledOutcome(t, script, run, attempt);
                    break;
                }
                if (det.status === "fixed") {
                    t.spec = det.spec;
                    await hooks.onRepaired?.(t, det.spec, det.reason);
                    attempt++;
                    repairs++;
                    script = renderWithAdapter(t.spec, t.framework, deps.render);
                    run = det.run;
                    await hooks.onAttempt(t, attempt, script, run);
                    logRun(ctx, t.spec, run, attempt);
                    continue;
                }
            }
            let repair;
            try {
                if (t.spec.kind === "web" && t.scenario && deps.browser) {
                    repair = await repairWeb({
                        ctx,
                        browser: deps.browser,
                        baseUrl: deps.render.baseUrl,
                        model: deps.model,
                        scenario: t.scenario,
                        spec: t.spec,
                        run,
                        credentials: deps.env.credentials,
                        attempt,
                    });
                } else if (t.spec.kind === "api") {
                    repair = await repairApi(ctx, t.spec, run, t.endpointDoc);
                } else {
                    repair = { verdict: "unfixable" as const, reason: summarise(run) };
                }
            } catch (err) {
                // A reached AI limit degrades like a missing model: the failure stays as it is and is not repaired.
                const capped = isBudgetExceeded(err);
                const unavailable = capped || err instanceof LlmNotConfiguredError;
                repair = {
                    verdict: "unfixable" as const,
                    // Keep the real failure primary; the repair problem is secondary context.
                    reason: unavailable
                        ? `${summarise(run)} (automatic repair skipped: ${capped ? (err as Error).message : "no LLM configured"})`
                        : `${summarise(run)} (automatic repair failed: ${err instanceof Error ? err.message : String(err)})`,
                };
            }

            if (repair.verdict === "app_defect") {
                outcome = { status: "NEEDS_REVIEW", reason: repair.reason, spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            if (repair.verdict !== "fixed" || !repair.spec) {
                outcome = { status: "FAILED_VALIDATION", reason: repair.reason || summarise(run), spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }

            t.spec = repair.spec;
            await hooks.onRepaired?.(t, repair.spec, repair.reason);
            if (deps.repairsAreDrafts) {
                // Kept for a person to review; the approved version's failure is the result of this run.
                ctx.emit({ stage: "validation", kind: "repair_saved_for_review", level: "warn", message: `${t.spec.testId}: a repair was saved as a new version for review. It was not run.` });
                outcome = { status: "FAILED_VALIDATION", reason: `${summarise(run)} ${REPAIR_WAITS_FOR_REVIEW}`, spec: t.spec, script, attempts: attempt, lastRun: run };
                break;
            }
            ctx.emit({ stage: "validation", kind: "script_regenerated", message: `${t.spec.testId} regenerated (attempt ${attempt + 1}): ${repair.reason}` });
            attempt++;
            repairs++;
            script = renderWithAdapter(t.spec, t.framework, deps.render);
            const repaired = await runAgain(t, script);
            if (!repaired) {
                outcome = cancelledOutcome(t, script, run, attempt);
                break;
            }
            run = repaired;
            await hooks.onAttempt(t, attempt, script, run);
            logRun(ctx, t.spec, run, attempt);
        }

        // Flaky or broken: one more run of the final script before a new test is called unreliable (test weakness, never a defect).
        let heal: HealResult | undefined;
        if (outcome?.status === "FAILED_VALIDATION" && deps.confirmFailures && t.scenario && !t.custom && t.spec.kind === "web" && run.status !== "passed" && !ctx.signal?.aborted) {
            const again = await runAgain(t, script);
            if (again) {
                attempt++;
                await hooks.onAttempt(t, attempt, script, again);
                logRun(ctx, t.spec, again, attempt);
                if (again.status !== "passed" && deps.browser) {
                    heal = await proposeHeal({ browser: deps.browser, baseUrl: deps.render.baseUrl, spec: t.spec, run: again, credentials: deps.env.credentials }).catch(() => undefined);
                }
                outcome = { ...outcome, reason: reliabilityReason(run, again, outcome.reason, heal), attempts: attempt, lastRun: again.status === "passed" ? run : again };
            }
        }
        // A new test that passed must keep passing: it runs again (one runner process, one run after the other); any failure makes it flaky.
        const repeats = deps.repeatPasses ?? 0;
        if (!outcome && run.status === "passed" && repeats > 0 && t.scenario && !t.custom && t.spec.kind === "web" && !ctx.signal?.aborted) {
            const copies = Array.from({ length: repeats }, (_, k) => ({ ...input(t, script), filename: script.filename.replace(/(\.spec\.ts)?$/, (ext) => `.repeat${k + 1}${ext}`) }));
            const again = (await execute(ctx, deps, copies, 1)).filter((r) => !r.notRun);
            const failing = again.find((r) => r.status !== "passed");
            if (failing) {
                attempt++;
                await hooks.onAttempt(t, attempt, script, failing);
                logRun(ctx, t.spec, failing, attempt);
                const passed = 1 + again.filter((r) => r.status === "passed").length;
                outcome = { status: "FAILED_VALIDATION", reason: `Flaky: passed ${passed} of ${again.length + 1} runs. The failing run stopped at ${summarise(failing)}`.slice(0, 600), spec: t.spec, script, attempts: attempt, lastRun: failing };
                ctx.emit({ stage: "validation", kind: "flaky_pass", level: "warn", message: `${t.spec.testId} passed ${passed} of ${again.length + 1} runs: flagged as flaky` });
            }
        }
        // A passing run may carry plain notes (a low-confidence AI judgement): kept as the reason so a reviewer can see them.
        outcome ??= { status: "VALIDATED", ...(run.notes?.length ? { reason: run.notes.join("\n") } : {}), spec: t.spec, script, attempts: attempt, lastRun: run };
        await hooks.onFinal(t, outcome);
        // A test that could not find its element may get a repair SUGGESTION (never applied here). Deterministic, no model.
        if (outcome.status !== "VALIDATED" && !t.custom && hooks.onHealing && deps.browser && outcome.spec.kind === "web" && !ctx.signal?.aborted) {
            try {
                heal ??= await proposeHeal({ browser: deps.browser, baseUrl: deps.render.baseUrl, spec: outcome.spec, run: outcome.lastRun, credentials: deps.env.credentials });
                await hooks.onHealing(t, heal);
                if (heal.status === "proposed") ctx.emit({ stage: "validation", kind: "healing_proposed", message: `${t.spec.testId}: a likely replacement for a missing element was found (${heal.proposal.confidenceLabel} confidence); it waits for approval` });
            } catch (err) {
                ctx.emit({ stage: "validation", kind: "healing_failed", level: "warn", message: `${t.spec.testId}: could not look for a replacement element: ${err instanceof Error ? err.message : String(err)}` });
            }
        }
        // A phone test that could not find its element: the AI looks at the phone at that step and the test is tried once with its choice; a SUGGESTION
        // only, stored like a web one (mobile/repair/phone-repair.ts). Needs the phone (ctx.openDevice) and the project's Android app.
        if (outcome.status !== "VALIDATED" && !t.custom && hooks.onHealing && outcome.spec.kind === "mobile" && ctx.openDevice && deps.mobile?.target.appPackage && !ctx.signal?.aborted && phoneRepairTarget(outcome.spec, outcome.lastRun).ok) {
            ctx.emit({ stage: "validation", kind: "phone_repair_started", message: `${t.spec.testId}: an element was not found; the AI is looking at the phone to suggest a repair` });
            const heal = await proposePhoneRepair({
                ctx,
                spec: outcome.spec,
                run: outcome.lastRun,
                target: deps.mobile.target,
                credentials: deps.mobile.credentials ?? deps.env.credentials,
                rerun: (spec) => runAgain(t, renderWithAdapter(spec, t.framework, deps.render)),
            });
            await hooks.onHealing(t, heal);
            ctx.emit(
                heal.status === "proposed"
                    ? { stage: "validation", kind: "healing_proposed", message: `${t.spec.testId}: the AI suggests a repair (${heal.proposal.confidenceLabel} confidence); it waits for approval` }
                    : { stage: "validation", kind: "phone_repair_none", message: `${t.spec.testId}: no repair suggested: ${heal.reason}` },
            );
        }
        return outcome;
    });

    const crashed: Array<Promise<void>> = [];
    const outcomes = results.map((r, i) => {
        if (r.ok) return r.value;
        // An unexpected exception must never turn into a silent pass.
        const t = current[i]!;
        const script = scripts[i]!;
        const reason = r.error instanceof Error ? r.error.message : String(r.error);
        const outcome: FinishedOutcome = {
            status: "FAILED_VALIDATION",
            reason: `Validation crashed: ${reason}`,
            spec: t.spec,
            script,
            attempts: 1,
            lastRun: firstRuns[i]!,
        };
        crashed.push(
            hooks.onFinal(t, outcome).catch((e) =>
                ctx.emit({ stage: "validation", kind: "persist_failed", level: "error", message: `${t.spec.testId}: ${e instanceof Error ? e.message : String(e)}` }),
            ),
        );
        return outcome;
    });
    await Promise.all(crashed);
    // Cleanup never changes a test's result and never fails the job: it is reported in the ledger and as a plain job event.
    if (collector && deps.cleanup) {
        try {
            const finished = await finishCleanup(ctx, collector, { enabled: deps.cleanup.enabled, apiBaseUrl: deps.env.apiBaseUrl ?? deps.env.baseUrl, credentials: { apiToken: deps.env.apiToken, apiAuthHeader: deps.env.apiAuthHeader }, guard: deps.cleanup.guard, fetch: deps.cleanup.fetch });
            if (finished.length) await hooks.onCleanup?.(finished);
        } catch (err) {
            ctx.emit({ stage: "validation", kind: "cleanup_failed", level: "warn", message: `Records the tests created could not be removed: ${err instanceof Error ? err.message : String(err)}` });
        }
    }
    return outcomes;
}

/**
 * What a failed run proves by itself, without a model: a signed-in check whose sign-in did not work, an AI judgement that could not
 * run (both plain failures, nothing a repair could change) or an application finding. Undefined = the run needs the repair step
 * (or is a plain failure). The ONE place that decides this: the validation loop (first analysis, re-runs, schedules, triggers,
 * runbooks) and runs against a named environment all call it, so a finding is a finding wherever the test runs.
 */
export function classifyFailedRun(spec: TestSpec, run: ScriptRun): { status: "NEEDS_REVIEW" | "FAILED_VALIDATION"; reason: string } | undefined {
    // A test that tracks a known bug passed: the bug seems fixed. Said as it is, never repaired (a repair would only make it fail again).
    if (run.error?.startsWith(KNOWN_BUG_FIXED)) return { status: "FAILED_VALIDATION", reason: run.error };
    // The phone could not run the test (its test helper crashed twice, it went offline, pre-flight stopped the run): the reason as it is, no repair.
    if (spec.kind === "mobile" && run.status === "error" && isPhoneInfrastructure(run)) return { status: "FAILED_VALIDATION", reason: run.error! };
    // A signed-in check whose sign-in did not work never reached the page under test: a plain failure, not a finding and not repairable.
    const noSignIn = signInFailure(spec, run);
    if (noSignIn) return { status: "FAILED_VALIDATION", reason: noSignIn };
    // An AI judgement that could not run (no model, no image support, unusable answer) says nothing about the page:
    // a plain failure with its plain reason, not a finding and not something a repair could change.
    const noVision = visionUnavailable(spec, run);
    if (noVision) return { status: "FAILED_VALIDATION", reason: noVision };
    // A page that loaded a captcha stopped the test: said plainly, never sent to repair (hard sign-ins, ../auth/captcha-run.ts).
    const captcha = captchaFinding(spec, run);
    if (captcha) return { status: "NEEDS_REVIEW", reason: captcha };
    // Facts beat models: some API failures are unambiguous application findings.
    const finding = deterministicFinding(spec, run);
    if (finding) return { status: "NEEDS_REVIEW", reason: finding };
    return undefined;
}

/**
 * The finding (an application problem, not a test problem) a failed run proves by itself, if any. Shared by the validation loop and
 * by runs against a named environment, which classify results the same way but never repair.
 */
export function deterministicFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    return spec.kind === "api"
        ? (securityFinding(spec, run) ?? accessFinding(spec, run) ?? contractFinding(spec, run) ?? latencyFinding(spec, run) ?? loadFinding(spec, run) ?? apiFinding(spec, run))
        : (phoneQualityFinding(spec, run) ?? a11yFinding(spec, run) ?? healthFinding(spec, run) ?? performanceFinding(spec, run) ?? inputFinding(spec, run) ?? accessFinding(spec, run) ?? visionFinding(spec, run) ?? visualFinding(spec, run));
}

/**
 * Deterministic classification of API failures that are application findings, not test bugs:
 *  - any 5xx response (a server error is never the correct answer);
 *  - a "no credentials" test whose endpoint answered 2xx (documented auth not enforced).
 */
export function apiFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    const failed = run.steps.find((s) => s.status === "failed");
    if (!failed) return undefined;
    // Responses received up to and including the failing step.
    const upTo = spec.steps.slice(0, failed.index + 1).filter((s) => s.action === "request").length;
    const last = run.responses.slice(0, upTo).at(-1);
    if (!last) return undefined;
    if (last.status >= 500) {
        return `Server error: ${last.method} ${last.path} returned ${last.status} (step "${failed.title}").`;
    }
    const noAuth = spec.steps.slice(0, failed.index + 1).some((s) => s.action === "request" && s.auth === "none");
    if (spec.tags.includes("auth") && noAuth && last.status >= 200 && last.status < 300) {
        return `Possible security issue: ${last.method} ${last.path} is documented as requiring authentication but returned ${last.status} without credentials.`;
    }
    return undefined;
}

/**
 * Why a new test could not be made reliable, from its last failing run and one more run of the same script: flaky (passed once) or
 * broken (failed both times, at the same step or not), with the healing candidate when an equivalent element exists. Any analysis
 * that differs from the plain failure is kept after it.
 */
export function reliabilityReason(failed: ScriptRun, again: ScriptRun, analysis: string | undefined, heal?: HealResult): string {
    const extra = analysis && analysis !== summarise(failed) ? ` Analysis: ${analysis}` : "";
    if (again.status === "passed") return `Flaky: passed 1 of 2 runs. The failing run stopped at ${summarise(failed)}${extra}`.slice(0, 600);
    const step = (r: ScriptRun) => r.steps.find((s) => s.status === "failed")?.title;
    const where = step(failed) === step(again) ? `Fails every time at ${summarise(again)}` : `Failed on both runs, at different steps: ${summarise(failed)}; then ${summarise(again)}`;
    const replacement = heal?.status === "proposed" ? ` ${heal.proposal.oldDescription} is gone; a likely replacement is ${heal.proposal.newDescription} (it waits for approval).` : "";
    return `${where.replace(/\.$/, "")}.${replacement}${extra}`.slice(0, 800);
}

export function summarise(run: ScriptRun): string {
    const failed = run.steps.find((s) => s.status === "failed");
    return `${failed ? failed.title + " — " : ""}${(failed?.error ?? run.error ?? run.status).split("\n")[0]}`.slice(0, 400);
}

function logRun(ctx: EngineContext, spec: TestSpec, run: ScriptRun, attempt: number) {
    ctx.emit({
        stage: "validation",
        kind: run.status === "passed" ? "validation_passed" : "validation_failed",
        level: run.status === "passed" ? "info" : "warn",
        message: `${spec.testId} ${run.status === "passed" ? "passed" : "failed"} (attempt ${attempt}, ${run.durationMs}ms)${run.status === "passed" ? "" : ": " + summarise(run)}`,
        data: { testId: spec.testId, attempt, status: run.status },
    });
}
