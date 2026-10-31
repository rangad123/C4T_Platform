/**
 * Running tests against a named environment (staging, production...).
 *
 * The test's own state is never touched: an environment run only adds a *result for that environment*. The script is
 * rendered exactly as it is for the main run (so what is stored and downloaded does not change) and the environment's
 * address, credentials and variables reach it through the environment variables every script already reads
 * (BASE_URL, API_BASE_URL, TEST_USERNAME..., TEST_ENV_<NAME>). One attempt, no automatic repair: a model rewriting a test to fit
 * one environment would hide exactly the difference this feature exists to show.
 *
 * Production is read-only: tests that change data are skipped and say so.
 */
import { throwIfAborted, type EngineContext } from "../context.js";
import type { RenderContext } from "../generators/index.js";
import { defaultAdapterFor, groupByRuntime, localExecutor, renderWithAdapter, type ScriptExecutor } from "../frameworks/index.js";
import type { GenerationSink, GenerationSummary, TestHandle } from "../orchestrator.js";
import type { TestSpec } from "../spec/schema.js";
import { CleanupCollector, finishCleanup, type CleanupRequest } from "../cleanup/run.js";
import { isLoadSpec, LOAD_PRODUCTION_SKIP_REASON } from "../performance/load.js";
import { hasScreenshotStep } from "../visual/baseline.js";
import { classifyFailedRun, summarise } from "../validation/validator.js";
import type { RunEnv, ScriptRun } from "../validation/runner.js";
import { changesData, MOBILE_SKIP_REASON, PRODUCTION_SKIP_REASON, type EnvStatus } from "./env.js";

/** What a run needs to know about the environment (secrets already decrypted; never logged, never stored in a result). */
export interface EnvironmentTarget {
    name: string;
    production: boolean;
    baseUrl: string;
    apiBaseUrl?: string;
    credentials?: { username?: string; password?: string; totpSecret?: string; apiToken?: string; apiAuthHeader?: string };
    vars: Record<string, string>;
}

export interface EnvironmentTest {
    handle: TestHandle;
    spec: TestSpec;
    scriptId?: string | null;
    /** A hand-written test: this script runs as it is (never rendered from the spec). */
    custom?: { filename: string; content: string };
}

export interface EnvironmentRecord {
    environment: string;
    status: EnvStatus;
    reason?: string;
    /** The real Playwright result (absent for skipped tests). */
    run?: ScriptRun;
}

export interface EnvironmentRunRequest {
    target: EnvironmentTarget;
    /** Named test accounts of the project, when the environment uses them. */
    roles?: RunEnv["roles"];
    /** How the main run renders scripts (the application's own address, the project's data sets). */
    render: RenderContext;
    /** Remove the records data-changing API tests create (never on production, which is read-only and runs no such test). */
    cleanup?: CleanupRequest;
    /** Where the scripts run. Default: the job's executor (`ctx.executor`), else this machine. */
    executor?: ScriptExecutor;
    /** Shared helper modules the code tests import (./helpers/<name>). */
    helpers?: Array<{ name: string; content: string }>;
}

/** Why a test is not run in this environment, or undefined when it is. */
export function skipReason(spec: TestSpec, target: Pick<EnvironmentTarget, "production">): string | undefined {
    if (spec.kind === "mobile") return MOBILE_SKIP_REASON;
    if (spec.kind === "desktop") return "Windows desktop tests start an application on a Windows computer, so they are not run per environment.";
    if (!defaultAdapterFor(spec.kind).executable) return `${spec.kind} tests are stored but not executed by this platform.`;
    if (spec.type === "visual" || hasScreenshotStep(spec)) return "Visual comparisons use the main run's approved screenshots, so they are not repeated per environment.";
    // A `looksRight` step only saves a screenshot in the script; the model that judges it belongs to the main validation, so a pass here would prove nothing.
    if (spec.steps.some((s) => s.action === "assert" && s.check === "looksRight")) return "AI judgement of a screenshot runs only in the main validation, so it is not repeated per environment.";
    if (target.production && changesData(spec)) return PRODUCTION_SKIP_REASON;
    // A load check only reads, but it sends up to 300 requests: never to a live production system.
    if (target.production && isLoadSpec(spec)) return LOAD_PRODUCTION_SKIP_REASON;
    return undefined;
}

/** Passed, an application finding, or a plain failure. The same facts the main validation uses; no repair. */
export function classifyEnvironmentRun(spec: TestSpec, run: ScriptRun): { status: EnvStatus; reason?: string } {
    if (run.status === "passed") return { status: "passed" };
    // The same decision the main validation makes (one function), so a finding is a finding here too.
    const known = classifyFailedRun(spec, run);
    if (known) return { status: known.status === "NEEDS_REVIEW" ? "finding" : "failed", reason: known.reason };
    return { status: "failed", reason: summarise(run) };
}

export async function runEnvironmentJob(ctx: EngineContext, req: EnvironmentRunRequest, tests: EnvironmentTest[], sink: GenerationSink): Promise<GenerationSummary> {
    const summary: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    for (const [status, phase] of [["DISCOVERING", "discovery"], ["ANALYZING", "understanding"], ["PLANNING", "planning"], ["GENERATING", "generation"]] as const) await sink.phase(status, phase, "skipped");
    await sink.phase("VALIDATING", "validation", "running");
    const { target } = req;
    const startedAt = new Date().toISOString();
    const record = async (t: EnvironmentTest, r: Omit<EnvironmentRecord, "environment">) => {
        await sink.recordEnvironment?.(t.handle, t.scriptId ?? null, { environment: target.name, ...r }, startedAt);
        ctx.emit({
            stage: "validation",
            kind: `environment_${r.status}`,
            level: r.status === "passed" || r.status === "skipped" ? "info" : "warn",
            message: `${t.spec.testId} on ${target.name}: ${r.status}${r.reason ? ` (${r.reason.split("\n")[0]!.slice(0, 200)})` : ""}`,
            data: { testId: t.spec.testId, environment: target.name, status: r.status },
        });
    };

    const runnable: Array<{ t: EnvironmentTest; framework: string; script: { testId: string; filename: string; content: string; custom?: boolean } }> = [];
    let skipped = 0;
    for (const t of tests) {
        // Production is read-only. What a hand-written script changes cannot be known without running it, so it is not run there.
        const why = t.custom && target.production ? "Code tests are not run on production: what they change cannot be checked beforehand, and production is read-only." : skipReason(t.spec, target);
        if (why) {
            skipped++;
            await record(t, { status: "skipped", reason: why });
            continue;
        }
        const off = ctx.frameworkOff?.(defaultAdapterFor(t.spec.kind).id);
        if (off) {
            skipped++;
            await record(t, { status: "skipped", reason: off });
            continue;
        }
        try {
            const framework = defaultAdapterFor(t.spec.kind).id;
            if (t.custom) {
                runnable.push({ t, framework, script: { testId: t.spec.testId, filename: t.custom.filename, content: t.custom.content, custom: true } });
                continue;
            }
            const rendered = renderWithAdapter(t.spec, framework, req.render);
            runnable.push({ t, framework, script: { testId: t.spec.testId, filename: rendered.filename, content: rendered.content } });
        } catch (e) {
            const message = `Script could not be rendered: ${e instanceof Error ? e.message : String(e)}`;
            summary.testsGenerated++;
            summary.testsFailedValidation++;
            summary.errors.push(`${t.spec.testId}: ${message}`);
            await record(t, { status: "failed", reason: message });
        }
    }

    if (runnable.length) {
        throwIfAborted(ctx.signal);
        ctx.emit({ stage: "validation", kind: "environment_started", message: `Running ${runnable.length} test(s) against ${target.name}${target.production ? " (production: read-only)" : ""}` });
        const c = target.credentials;
        const cleanupOn = Boolean(req.cleanup) && !target.production;
        const collector = cleanupOn ? new CleanupCollector(req.render.deleteOps ?? []) : undefined;
        const env: RunEnv = {
            baseUrl: target.baseUrl,
            apiBaseUrl: target.apiBaseUrl ?? target.baseUrl,
            credentials: c?.username && c.password ? { username: c.username, password: c.password, ...(c.totpSecret ? { totpSecret: c.totpSecret } : {}) } : undefined,
            roles: req.roles,
            apiToken: c?.apiToken,
            apiAuthHeader: c?.apiAuthHeader,
            vars: target.vars,
            ...(cleanupOn ? { cleanup: req.cleanup!.enabled ? ("platform" as const) : ("off" as const) } : {}),
            headless: ctx.config.HEADLESS,
        };
        const executor = req.executor ?? ctx.executor ?? localExecutor;
        const runs: ScriptRun[] = [];
        for (const { adapter, entries } of groupByRuntime(runnable, (r) => r.framework)) {
            runs.push(...(await executor.execute(adapter.id, { scratchDir: ctx.config.scratchDir, scripts: entries.map(({ item }) => ({ ...item.script, framework: item.framework })), ...(req.helpers?.length && entries.some(({ item }) => item.script.custom) ? { helpers: req.helpers } : {}) }, { run: env }, { workers: Math.max(1, ctx.config.CONCURRENCY), signal: ctx.signal })));
        }
        const byId = new Map(runs.map((r) => [r.testId, r]));
        if (collector) {
            for (const { t } of runnable) collector.add(t.spec, byId.get(t.spec.testId)?.created);
            // Whatever the tests created on this environment is removed from this environment, with its credentials; the result of a test never changes.
            try {
                const finished = await finishCleanup(ctx, collector, { enabled: req.cleanup!.enabled, apiBaseUrl: env.apiBaseUrl ?? env.baseUrl, credentials: { apiToken: c?.apiToken, apiAuthHeader: c?.apiAuthHeader }, guard: req.cleanup!.guard, environment: target.name });
                if (finished.length) await sink.saveCleanup?.(finished);
            } catch (err) {
                ctx.emit({ stage: "validation", kind: "cleanup_failed", level: "warn", message: `Records the tests created could not be removed: ${err instanceof Error ? err.message : String(err)}` });
            }
        }
        for (const { t } of runnable) {
            const run = byId.get(t.spec.testId);
            summary.testsGenerated++;
            if (!run) {
                summary.testsFailedValidation++;
                await record(t, { status: "failed", reason: "The run returned no result for this test." });
                continue;
            }
            const c2 = classifyEnvironmentRun(t.spec, run);
            if (c2.status === "passed") summary.testsValidated++;
            else if (c2.status === "finding") summary.testsNeedingReview++;
            else summary.testsFailedValidation++;
            await record(t, { ...c2, run });
        }
    }
    if (summary.testsGenerated === 0) summary.errors.push(skipped ? `Nothing was run on ${target.name}: every selected test was skipped (see each test for the reason).` : `There was nothing to run on ${target.name}.`);
    await sink.counters({ testsGenerated: summary.testsGenerated, testsValidated: summary.testsValidated, testsFailedValidation: summary.testsFailedValidation, testsNeedingReview: summary.testsNeedingReview });
    await sink.phase("VALIDATING", "validation", "done");
    ctx.emit({
        stage: "orchestration",
        kind: "job_summary",
        message: `${target.name}: ${summary.testsGenerated} test(s) run, ${summary.testsValidated} passed, ${summary.testsNeedingReview} findings, ${summary.testsFailedValidation} failed${skipped ? `, ${skipped} skipped` : ""}`,
    });
    throwIfAborted(ctx.signal);
    return summary;
}
