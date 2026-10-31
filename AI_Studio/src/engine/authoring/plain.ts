/**
 * Plain-English test authoring: a person describes a test in their own words, the platform builds it, really runs it, and stores it
 * like any other test.
 *
 *   web  the description becomes ONE scenario for the existing authoring agent (src/engine/web/author.ts), which drives a real
 *        browser against the application and records only the steps that worked, plus the assertions it verified.
 *   api  the model chooses one known operation and what the answer should contain (./api.ts); the spec is built from that choice.
 *
 * Either way the spec goes through the normal validator (rendered script, real execution, repair loop). Honesty rules:
 *   - A test is VALIDATED only after a real run passed. Anything the agent could not finish is kept as NEEDS_REVIEW with its own
 *     explanation (never dropped, never run, never green).
 *   - A test that passes but checks almost nothing (the quality rules in ../quality/rules.ts) is NEEDS_REVIEW, not green.
 * Persistence goes through GenerationSink, so the same engine runs under the platform's job worker and under tests.
 */
import type { Browser } from "playwright";
import { resolveApiToken, type OAuth2ClientCredentials } from "../api/oauth.js";
import { throwIfAborted, type EngineContext } from "../context.js";
import { launchChromium } from "../discovery/browser.js";
import type { CleanupRequest } from "../cleanup/run.js";
import type { Framework, RenderContext } from "../generators/index.js";
import { renderWithAdapter } from "../frameworks/index.js";
import type { RoleLogin } from "../identity/access.js";
import type { GenerationSink, GenerationSummary, TestHandle } from "../orchestrator.js";
import { assessQuality } from "../quality/rules.js";
import { assertCredentialsStayHome } from "../spec/credential-origin.js";
import { TestSpecSchema, type Scenario, type TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import { stubModel } from "../validate-only.js";
import { validateBatch, type TestUnderValidation, type ValidationOutcome } from "../validation/validator.js";
import { authorWebSpec, toSpec, type AuthorOutcome } from "../web/author.js";
import { apiDraft, buildApiSteps, planApiCall } from "./api.js";
import { PLAIN_CATEGORY, PLAIN_MAX_STEPS, PLAIN_ORIGIN, refusalFor, scenarioFor, startPathOf } from "./describe.js";

export interface PlainRequest {
    description: string;
    kind: "web" | "api";
    /** The address the test is built and checked on: the application, or the chosen environment's address. */
    url: string;
    apiBaseUrl?: string;
    /** What is known about the application (pages and API operations). Absent: only the address is known. */
    model: AppModel | null;
    credentials?: { username?: string; password?: string; totpSecret?: string; apiToken?: string; apiAuthHeader?: string; oauth2?: OAuth2ClientCredentials };
    roles?: RoleLogin[];
    /** The project's "include tests that change data" switch. */
    allowChanges: boolean;
    /** Name of the project environment the test was built on (recorded with the test). */
    environment?: string;
    dataSets?: RenderContext["dataSets"];
    deleteOps?: string[];
    cleanup?: CleanupRequest;
    /** Rebuild this test from the new description instead of adding one (same id, new script version, history kept). */
    replace?: { handle: TestHandle; spec: TestSpec };
}

/** Plain-language text for a test that passed but checks very little. */
export function weakNote(reasons: string[]): string {
    return `The test ran and passed, but it checks very little. ${reasons.join(" ")} We have not counted it as validated. Say what the test should check (for example “check that the total shows $20”) and rebuild it.`;
}

/** The status a finished run ends with: a pass of a test that checks almost nothing is a request to look, not a green test. */
export function finalVerdict(outcome: ValidationOutcome): { status: Exclude<ValidationOutcome["status"], "NOT_RUN">; reason?: string } {
    if (outcome.status === "VALIDATED") {
        const q = assessQuality(outcome.spec);
        if (q.level === "weak") return { status: "NEEDS_REVIEW", reason: weakNote(q.reasons) };
    }
    // A test that did not run is handled before this is asked (onNotRun); it is never given a verdict.
    return { status: outcome.status === "NOT_RUN" ? "FAILED_VALIDATION" : outcome.status, reason: outcome.reason };
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export async function runPlainAuthoring(ctx: EngineContext, req: PlainRequest, sink: GenerationSink): Promise<GenerationSummary> {
    const summary: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    const description = req.description.trim();
    await sink.phase("DISCOVERING", "discovery", "skipped");
    await sink.phase("ANALYZING", "understanding", "skipped");

    // The same refusal as the API gives up front; checked again here because a job can be queued by another route or an older version.
    const refused = refusalFor(description, { allowChanges: req.allowChanges });
    if (refused) {
        summary.errors.push(refused);
        await sink.phase("PLANNING", "planning", "failed");
        return summary;
    }
    if (ctx.llm.modelName === "unavailable") {
        summary.errors.push("The AI model isn’t set up yet, so the description could not be turned into a test. Add your API key in the server settings, then try again.");
        await sink.phase("PLANNING", "planning", "failed");
        return summary;
    }

    const origin = new URL(req.url).origin;
    const model = req.model && req.model.origin === origin ? req.model : stubModel(req.url, origin);
    const apiBaseUrl = req.apiBaseUrl ?? origin;
    const renderCtx: RenderContext = { baseUrl: origin, apiBaseUrl, ...(req.dataSets ? { dataSets: req.dataSets } : {}), ...(req.deleteOps ? { deleteOps: req.deleteOps } : {}) };
    const creds = req.credentials?.username && req.credentials.password ? { username: req.credentials.username, password: req.credentials.password, ...(req.credentials.totpSecret ? { totpSecret: req.credentials.totpSecret } : {}) } : undefined;
    // A project with only named accounts: the first one signs in for the test.
    const role = !creds ? req.roles?.[0] : undefined;
    const login = creds ? { username: creds.username, password: creds.password } : role ? { username: role.username, password: role.password } : undefined;

    const handles = new Map<string, TestHandle>();
    const scriptIds = new Map<string, string>();
    const meta = (extra: Record<string, unknown>) => ({ model: ctx.llm.modelName, plain: { description, kind: req.kind, ...(req.environment ? { environment: req.environment } : {}) }, ...extra });

    /** Store the spec as a new test, or as the next version of the test being rebuilt. */
    const store = async (spec: TestSpec, framework: Framework, status: "PENDING" | "NEEDS_REVIEW", reason: string | undefined, extra: Record<string, unknown>): Promise<TestHandle> => {
        // Stored sign-in details only go to the application's own site: refused before anything is created.
        assertCredentialsStayHome(spec, renderCtx);
        let h: TestHandle;
        if (req.replace) {
            h = req.replace.handle;
            await sink.updateTest(h, { spec, validation: status === "PENDING" ? "VALIDATING" : "NEEDS_REVIEW", reason: reason ?? null, attempts: 0, meta: meta(extra) });
        } else {
            h = await sink.createTest({ spec, framework, validation: status, reason, meta: meta(extra) });
        }
        handles.set(spec.testId, h);
        scriptIds.set(spec.testId, await sink.saveScript(h, renderWithAdapter(spec, framework, renderCtx), true));
        await sink.counters({ testsGenerated: 1 }, true);
        summary.testsGenerated++;
        return h;
    };
    const keep = async () => {
        summary.testsNeedingReview++;
        await sink.counters({ testsNeedingReview: 1 }, true);
    };
    /** A rebuild that could not be finished leaves the existing test exactly as it was. */
    const keepOld = (why: string) => {
        summary.errors.push(`We couldn’t rebuild this test from the new description: ${why} The test was left as it was.`);
        ctx.emit({ stage: "generation", kind: "rewrite_not_applied", level: "warn", message: `Rebuild not applied: ${why}` });
    };
    const specId = async (prefix: string) => req.replace?.spec.testId ?? (await sink.nextTestKey(prefix));

    const pending: TestUnderValidation[] = [];
    let browser: Browser | undefined;
    try {
        // ── 1. Read the description ───────────────────────────────────────────
        await sink.phase("PLANNING", "planning", "running");
        const scenario: Scenario | undefined =
            req.kind === "web"
                ? scenarioFor(description, {
                      startPath: startPathOf(description) ?? (() => { const u = new URL(req.url); return u.pathname === "/" && !u.search ? "/" : `${u.pathname}${u.search}`; })(),
                      requiresAuth: Boolean(login),
                  })
                : undefined;
        await sink.counters({ scenariosPlanned: 1 });
        ctx.emit({ stage: "planning", kind: "plain_read", message: `Building a ${req.kind === "api" ? "API" : "web"} test from the description${req.environment ? ` on ${req.environment}` : ""}` });
        await sink.phase("PLANNING", "planning", "done");
        throwIfAborted(ctx.signal);

        // ── 2. Build the test ─────────────────────────────────────────────────
        await sink.phase("GENERATING", "generation", "running");
        if (req.kind === "web") {
            browser = await launchChromium(ctx.config.HEADLESS);
            const runId = await sink.startAgentRun("plain-authoring", scenario!.title);
            let outcome: AuthorOutcome;
            try {
                outcome = await authorWebSpec({
                    ctx,
                    browser,
                    baseUrl: origin,
                    model,
                    scenario: scenario!,
                    credentials: login,
                    onAction: (a) => sink.agentAction(runId, a),
                    maxSteps: PLAIN_MAX_STEPS,
                    // The Explorer view: only this builder shows its browser (the exploration's test writers do not).
                    frames: ctx.frames,
                });
                await sink.finishAgentRun(runId, outcome.status, outcome.explanation);
            } catch (err) {
                await sink.finishAgentRun(runId, "error", err instanceof Error ? err.message : String(err));
                throw err;
            }
            const key = await specId("WEB");
            const steps = outcome.steps.length ? outcome.steps : [{ action: "navigate" as const, url: scenario!.startPath, description: `Open ${scenario!.startPath}` }];
            const base = toSpec(scenario!, { ...outcome, steps }, key);
            const spec = TestSpecSchema.parse({
                ...base,
                // The sentence itself is the test's intent; the title is its first line.
                description,
                category: req.replace?.spec.category ?? PLAIN_CATEGORY,
                tags: ["plain-english", scenario!.type],
                source: { ...base.source, origin: PLAIN_ORIGIN },
            });
            const extra = { scenario, authoring: outcome.status, explanation: outcome.explanation };

            if (outcome.status === "blocked") {
                // Could not be finished: kept with the agent's own explanation, never run (a half-built test could pass by accident).
                const why = clean(outcome.explanation) || "The test could not be completed.";
                if (req.replace) keepOld(why);
                else {
                    await store(spec, "playwright", "NEEDS_REVIEW", why, extra);
                    await keep();
                    ctx.emit({ stage: "generation", kind: "plain_not_built", level: "warn", message: `${key} ${spec.title}: ${why}` });
                }
            } else if (outcome.status === "defect") {
                const why = `The application did not behave as described: ${clean(outcome.explanation)}`;
                if (req.replace) keepOld(why);
                else {
                    await store(spec, "playwright", "NEEDS_REVIEW", why, extra);
                    await keep();
                    ctx.emit({ stage: "generation", kind: "possible_defect", level: "warn", message: `${key} ${spec.title}: ${clean(outcome.explanation)}` });
                }
            } else {
                await store(spec, "playwright", "PENDING", undefined, extra);
                pending.push({ spec, framework: "playwright", scenario });
                ctx.emit({ stage: "generation", kind: "script_generated", message: `${key} ${spec.title} (${spec.steps.length} steps)` });
            }
        } else {
            const apis = model.apis ?? [];
            if (!apis.length) {
                summary.errors.push("This project has no known API operations yet. Run an analysis with the API description (OpenAPI) first.");
            } else {
                const plan = await planApiCall(ctx.llm, description, apis);
                const built = buildApiSteps(plan, apis, { allowChanges: req.allowChanges });
                const key = await specId("API");
                const spec = TestSpecSchema.parse({ ...apiDraft(description, built, built.ok && built.ep.requiresAuth === true), testId: key, ...(req.replace ? { category: req.replace.spec.category } : {}) });
                const extra = { authoring: built.ok ? "complete" : "blocked", explanation: built.ok ? built.explanation : built.reason, ...(built.ep ? { endpoint: `${built.ep.method} ${built.ep.path}` } : {}) };
                if (!built.ok) {
                    if (req.replace) keepOld(built.reason);
                    else {
                        await store(spec, "playwright-api", "NEEDS_REVIEW", clean(built.reason), extra);
                        await keep();
                        ctx.emit({ stage: "generation", kind: "plain_not_built", level: "warn", message: `${key} ${spec.title}: ${clean(built.reason)}` });
                    }
                } else {
                    await store(spec, "playwright-api", "PENDING", undefined, extra);
                    const ep = built.ep;
                    pending.push({ spec, framework: "playwright-api", endpointDoc: { method: ep.method, path: ep.path, statuses: ep.statuses, requiresAuth: ep.requiresAuth, summary: ep.summary, spec: ep.spec } });
                    ctx.emit({ stage: "generation", kind: "script_generated", message: `${key} ${spec.title} (${spec.steps.length} steps)` });
                }
            }
        }
        await sink.phase("GENERATING", "generation", summary.testsGenerated > 0 ? "done" : "failed");
        throwIfAborted(ctx.signal);

        // ── 3. Run it for real ────────────────────────────────────────────────
        if (!pending.length) {
            await sink.phase("VALIDATING", "validation", "skipped");
        } else {
            await sink.phase("VALIDATING", "validation", "running");
            const startedAt = new Date().toISOString();
            for (const t of pending) await sink.updateTest(handles.get(t.spec.testId)!, { validation: "VALIDATING" });
            const finals = new Map<string, ReturnType<typeof finalVerdict>>();
            const outcomes = await validateBatch(
                ctx,
                {
                    browser,
                    scratchDir: ctx.config.scratchDir,
                    env: { baseUrl: origin, apiBaseUrl, credentials: login, roles: req.roles, apiToken: await resolveApiToken(ctx, req.credentials), apiAuthHeader: req.credentials?.apiAuthHeader, headless: ctx.config.HEADLESS },
                    render: renderCtx,
                    model,
                    maxRepairAttempts: ctx.config.MAX_REPAIR_ATTEMPTS,
                    workers: 1,
                    cleanup: req.cleanup,
                },
                pending,
                {
                    onCleanup: sink.saveCleanup ? (items) => sink.saveCleanup!(items) : undefined,
                    async onAttempt(t, attempt, _script, run) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.recordExecution(h, scriptIds.get(t.spec.testId) ?? null, attempt, run, attempt === 1 ? startedAt : new Date(Date.now() - run.durationMs).toISOString());
                        await sink.updateTest(h, { attempts: attempt });
                    },
                    async onRepaired(t, spec) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.updateTest(h, { spec });
                        scriptIds.set(t.spec.testId, await sink.saveScript(h, renderWithAdapter(spec, t.framework, renderCtx), true));
                    },
                    onNotRun: async (t) => await sink.restoreTest?.(handles.get(t.spec.testId)!),
                    async onFinal(t, outcome) {
                        const h = handles.get(t.spec.testId)!;
                        const verdict = finalVerdict(outcome);
                        finals.set(t.spec.testId, verdict);
                        await sink.updateTest(h, { validation: verdict.status, reason: verdict.reason ?? null, attempts: outcome.attempts, spec: outcome.spec });
                    },
                },
            );
            for (const o of outcomes) {
                if (o.status === "NOT_RUN") continue;
                const status = finals.get(o.spec.testId)?.status ?? o.status;
                if (status === "VALIDATED") summary.testsValidated++;
                else if (status === "NEEDS_REVIEW") summary.testsNeedingReview++;
                else summary.testsFailedValidation++;
            }
            await sink.counters({ testsValidated: summary.testsValidated, testsFailedValidation: summary.testsFailedValidation, testsNeedingReview: summary.testsNeedingReview });
            await sink.phase("VALIDATING", "validation", "done");
        }

        await sink.counters({ llmInputTokens: ctx.llm.usage.inputTokens, llmOutputTokens: ctx.llm.usage.outputTokens });
        throwIfAborted(ctx.signal);
        ctx.emit({
            stage: "orchestration",
            kind: "job_summary",
            message: `${summary.testsGenerated} test built, ${summary.testsValidated} validated, ${summary.testsNeedingReview} need review, ${summary.testsFailedValidation} failed validation`,
        });
        return summary;
    } finally {
        await browser?.close().catch(() => undefined);
    }
}
