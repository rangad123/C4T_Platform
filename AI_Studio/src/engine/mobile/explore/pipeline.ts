/**
 * The Android branch of test generation: open the app on a phone or emulator, let the AI explore it, plan test ideas, write the tests, and run them
 * on the device. The same promises as the web branch: the person can watch, approves a plan before anything is created (plan mode), can stop at any
 * time, and sign-in details never leave the machine that owns the phone.
 *
 * Called by `runGeneration` when the request's targets include "mobile". Nothing here runs unless they do.
 */
import { throwIfAborted, type EngineContext } from "../../context.js";
import { renderWithAdapter } from "../../frameworks/index.js";
import { LlmNotConfiguredError } from "../../llm/provider.js";
import type { GenerationRequest, GenerationSink, GenerationSummary, TestHandle } from "../../orchestrator.js";
import { TestSpecSchema } from "../../spec/schema.js";
import { secretProblems } from "../../builder/index.js";
import { phoneMemoryOf, resolveMobile, stubModel } from "../../validate-only.js";
import { exploredOnFromName } from "../device/choose.js";
import type { ExploredOn } from "../phone-settings.js";
import { validateBatch, type TestUnderValidation, type ValidationOutcome } from "../../validation/validator.js";
import type { StoredPlan } from "../../planning/preview.js";
import type { AppModel } from "../../understanding/app-model.js";
import { buildCandidates } from "./candidates.js";
import { explore, ModelBudget } from "./explorer.js";
import { buildPlan, chooseIdeas, ideaScenarios, phoneIdeaCap } from "./planner.js";
import { appNameOf } from "./spec-builder.js";
import { DEFAULT_LIMITS, depthLimits, FAMILY_LABEL, type ExploreCoverage, type PhonePlan } from "./types.js";
import { depthOf } from "../phone-settings.js";
import { QualityCollector } from "../quality/explore.js";
import { createQualityTests, qualityWarnings } from "../quality/create.js";

export const NEEDS_MODEL = "Phone exploration needs the AI model. Set it up in Settings, then explore again.";
export const NO_ACCESS = "Phone exploration is not available on this server: it cannot reach a phone or emulator. Connect a runner on a computer with one (Settings, Runners), or install the Android tools here.";
export const NO_PACKAGE = "Phone exploration needs the app's package name, for example com.example.shop. Add it under Settings, Mobile app.";

const isPhoneIdea = (id: string) => /^M-\d+$/.test(id);

export async function runMobileGeneration(ctx: EngineContext, req: GenerationRequest, sink: GenerationSink): Promise<GenerationSummary> {
    const summary: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    const appPackage = req.plan?.mobile?.appPackage ?? req.mobile?.appPackage;
    if (!appPackage) throw new Error(NO_PACKAGE);
    const appUri = `android-app://${appPackage}`;
    const creds = req.credentials?.username && req.credentials.password ? { username: req.credentials.username, password: req.credentials.password } : undefined;
    const secrets = [creds?.username, creds?.password].filter((x): x is string => Boolean(x));

    let phone: PhonePlan;
    let stub: AppModel;
    // Round 24 (RUN): the device this exploration used; the tests it writes run there (mobile/device/choose.ts), and the project keeps it.
    let exploredOn: ExploredOn | undefined;
    const warnings: string[] = [];

    if (req.plan?.mobile) {
        // The exploration was done and approved earlier: nothing is explored again.
        phone = req.plan.mobile;
        stub = req.plan.model;
        summary.model = stub;
        await sink.counters({ pagesDiscovered: stub.mobile?.screens.length ?? 0, scenariosPlanned: phone.ideas.length });
        await sink.saveModel(stub);
        await sink.phase("DISCOVERING", "discovery", "done");
        await sink.phase("ANALYZING", "understanding", "skipped");
        await sink.phase("PLANNING", "planning", "done");
        ctx.emit({ stage: "discovery", kind: "plan_reused", message: `Starting from the plan you approved: ${stub.mobile?.screens.length ?? 0} screens and ${phone.ideas.length} test ideas (the app is not explored again)` });
    } else {
        // ── explore ─────────────────────────────────────────────────────────
        await sink.phase("DISCOVERING", "discovery", "running");
        ctx.emit({ stage: "discovery", kind: "application_discovered", message: `Starting to explore ${appPackage} on a phone` });
        if (ctx.llm.modelName === "unavailable") throw new Error(NEEDS_MODEL);
        if (!ctx.openDevice) throw new Error(NO_ACCESS);
        throwIfAborted(ctx.signal);
        const t = req.mobile;
        // R24: the map explorer (default) with the limits of the project's "How thorough"; PHONE_EXPLORER=ai keeps the AI-led loop and its limits.
        const strategy: "map" | "ai" = ctx.config?.PHONE_EXPLORER === "ai" ? "ai" : "map";
        const depth = depthOf(t);
        const limits = strategy === "map" ? depthLimits(depth) : DEFAULT_LIMITS;
        // A phone the project named is the one explored; an emulator choice uses an emulator even when a phone is connected; else a ready phone before an emulator.
        const named = t?.runsOn?.kind === "phone" ? t.runsOn.serial : undefined;
        const session = await ctx.openDevice({
            appPackage,
            ...(named ? { serial: named } : {}),
            ...(t?.runsOn?.kind === "emulator" ? { emulatorOnly: true } : {}),
            ...(strategy === "map" ? { maxActions: limits.maxActions + 60, maxMinutes: Math.ceil(limits.maxMs / 60_000) + 5 } : {}),
            ...(t?.apkPath ? { apkPath: t.apkPath } : {}),
            ...(t?.avd ? { avd: t.avd } : {}),
            ...(creds ? { credentials: creds } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            log: (line) => ctx.emit({ stage: "discovery", kind: "device", message: line.slice(0, 300) }),
        });
        exploredOn = ctx.deviceFarm ? undefined : exploredOnFromName(session.deviceName);
        if (exploredOn) await sink.rememberPhone?.({ exploredOn });
        const budget = new ModelBudget(limits.maxModelCalls);
        // Phone quality checks (mobile/quality): crashes and freezes, cold start time, accessibility of each new screen.
        const quality = new QualityCollector({ ctx, session, ...(req.mobile?.startupBudgetMs !== undefined ? { budgetMs: req.mobile.startupBudgetMs } : {}) });
        let found;
        try {
            found = await explore(
                {
                    ctx,
                    session,
                    appPackage,
                    credentialsGiven: Boolean(creds),
                    allowDataChanges: req.allowMutatingApiTests,
                    secrets,
                    quality: quality.hooks(),
                    ...(strategy === "map" ? { strategy, depth, ...(t?.keepSignedIn ? { keepSignedIn: true } : {}), ...(ctx.askPerson ? { personGate: ctx.askPerson } : {}) } : {}),
                },
                budget,
            );
        } catch (e) {
            if (e instanceof LlmNotConfiguredError) throw new Error(NEEDS_MODEL);
            throw e;
        } finally {
            await session.close().catch(() => undefined);
        }
        stub = {
            ...stubModel(appUri, appUri),
            siteType: "android app",
            purpose: `The Android app ${appPackage}, explored by the AI`,
            features: found.screens.map((s) => s.title).slice(0, 12),
            stats: { pagesVisited: found.screens.length, pagesSkipped: found.skipped.length, apisFound: 0, durationMs: found.stats.durationMs },
            mobile: found,
        };
        summary.model = stub;
        await sink.counters({ pagesDiscovered: found.screens.length });
        await sink.saveModel(stub);
        await sink.phase("DISCOVERING", "discovery", "done");
        await sink.phase("ANALYZING", "understanding", "skipped");
        throwIfAborted(ctx.signal);

        // ── plan ────────────────────────────────────────────────────────────
        await sink.phase("PLANNING", "planning", "running");
        try {
            // R24 (PLAN): paths as long and plans as large as the depth of the exploration allows (Quick 15, Standard 40, Thorough 80 ideas).
            const depth = found.coverage?.depth ?? req.mobile?.depth;
            const { candidates, dropped } = buildCandidates(found, depth ? { maxPathEdges: depthLimits(depth).maxPathEdges } : DEFAULT_LIMITS);
            const { chosen, usedModel, limitMessage } = await chooseIdeas(ctx, found, candidates, budget, phoneIdeaCap(depth, req.maxScenarios));
            phone = buildPlan(found, chosen, dropped);
            phone.quality = quality.plan(found, { appPackage });
            warnings.push(...qualityWarnings(phone.quality));
            if (limitMessage) warnings.push(`${limitMessage} The test ideas have standard names.`);
            else if (!usedModel && candidates.length > 0) warnings.push("The AI's wording of the test ideas could not be used, so they have standard names.");
        } catch (e) {
            if (e instanceof LlmNotConfiguredError) throw new Error(NEEDS_MODEL);
            throw e;
        }
        if (found.stats.aiLimit) warnings.push(`${found.stats.aiLimit} The exploration stopped there; the plan covers what it had seen.`);
        if (found.signInNeeded) warnings.push(creds ? "The app has a sign-in screen and the test account was not accepted, so screens behind it were not explored." : "The app has a sign-in screen and no test account was given, so screens behind it were not explored. Add one under Advanced options and explore again.");
        // A map exploration that ran out of things to try, or found nothing new for a while, is complete: said as coverage, not as a warning.
        const complete = found.stats.stop === "explored" || found.stats.stop === "plateau";
        if (found.stats.stoppedBecause && !complete && !/seen enough|done/i.test(found.stats.stoppedBecause)) warnings.push(`${found.stats.stoppedBecause}, so the exploration stopped there.`);
        // The coverage is a fact of the plan, not a warning: said as an event (the plan page reads model.coverage).
        if (found.coverage) ctx.emit({ stage: "discovery", kind: "mobile_coverage", message: coverageSentence(found.coverage), data: { ...found.coverage } });
        if (phone.dropped.length) warnings.push(`${phone.dropped.length} test idea${phone.dropped.length === 1 ? "" : "s"} could not be written: ${phone.dropped[0]!.reason}.`);
        await sink.counters({ scenariosPlanned: phone.ideas.length, journeysIdentified: found.screens.length });
        await sink.phase("PLANNING", "planning", phone.ideas.length ? "done" : "failed");
        if (phone.ideas.length === 0) summary.errors.push(`The AI could not write any test from ${appNameOf(appPackage)}${phone.dropped[0] ? `: ${phone.dropped[0].reason}` : ""}.`);
        throwIfAborted(ctx.signal);
    }

    if (req.planOnly) {
        await sink.phase("GENERATING", "generation", "skipped");
        await sink.phase("VALIDATING", "validation", "skipped");
        const stored: StoredPlan = { version: 1, createdAt: new Date().toISOString(), model: stub, scenarios: ideaScenarios(phone), analysed: true, specBaseTrusted: false, accessReach: [], apiAccess: [], warnings: [...warnings, ...summary.errors], mobile: phone };
        summary.plan = stored;
        await sink.counters({ llmInputTokens: ctx.llm.usage.inputTokens, llmOutputTokens: ctx.llm.usage.outputTokens });
        const counts = (Object.keys(FAMILY_LABEL) as Array<keyof typeof FAMILY_LABEL>).map((f) => [f, phone.ideas.filter((i) => i.family === f).length] as const).filter(([, n]) => n > 0);
        ctx.emit({ stage: "orchestration", kind: "plan_ready", message: `Plan ready: ${stub.mobile?.screens.length ?? 0} screens and ${phone.ideas.length} test ideas (${counts.map(([f, n]) => `${FAMILY_LABEL[f].toLowerCase()} ${n}`).join(", ") || "none"}). Nothing was created yet.` });
        return summary;
    }

    // ── write the tests ─────────────────────────────────────────────────────
    await sink.phase("GENERATING", "generation", "running");
    const left = new Set(req.excludeIdeas ?? []);
    const renderCtx = { baseUrl: appUri, apiBaseUrl: appUri };
    const pending: TestUnderValidation[] = [];
    const handles = new Map<string, TestHandle>();
    const scriptIds = new Map<string, string>();
    for (const idea of phone.ideas) {
        if (left.has(idea.id)) continue;
        throwIfAborted(ctx.signal);
        try {
            const key = await sink.nextTestKey("MOB");
            const spec = TestSpecSchema.parse({ ...idea.draft, testId: key });
            // A plan is read back from storage: it is checked again before anything is created from it.
            const bad = spec.steps.flatMap((s) => secretProblems(s))[0];
            if (bad) throw new Error(bad);
            if (spec.kind !== "mobile") throw new Error("It is not a phone test");
            const meta = { model: ctx.llm.modelName, scenario: ideaScenarios({ ...phone, ideas: [idea] })[0], authoring: "exploration", explanation: idea.goal, phone: { appPackage, ideaId: idea.id, family: idea.family, path: idea.path } };
            const h = await sink.createTest({ spec, framework: "taqwright", validation: "PENDING", meta });
            handles.set(spec.testId, h);
            scriptIds.set(spec.testId, await sink.saveScript(h, renderWithAdapter(spec, "taqwright", renderCtx), true));
            await sink.counters({ testsGenerated: 1 }, true);
            summary.testsGenerated++;
            pending.push({ spec, framework: "taqwright" });
            ctx.emit({ stage: "generation", kind: "script_generated", message: `${key} ${spec.title} (${spec.steps.length} steps)` });
        } catch (e) {
            summary.errors.push(`${idea.title}: ${e instanceof Error ? e.message : String(e)}`);
            ctx.emit({ stage: "generation", kind: "scenario_failed", level: "warn", message: `${idea.title} could not be written: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    // Phone quality findings (crashes, slow start, accessibility when switched on): kept as tests that need a look (mobile/quality/create.ts).
    await createQualityTests(ctx, sink, phone.quality, { appPackage, accessibility: req.accessibility === true, summary });
    await sink.phase("GENERATING", "generation", summary.testsGenerated > 0 ? "done" : "failed");
    throwIfAborted(ctx.signal);

    // ── run them on the phone ───────────────────────────────────────────────
    if (pending.length === 0) {
        await sink.phase("VALIDATING", "validation", "skipped");
        return summary;
    }
    // Right after exploring, the tests run on the device the AI explored on (unless the project chose another place).
    const runTarget = { ...(req.mobile ?? { appPackage }), ...(exploredOn ? { exploredOn } : {}) };
    const device = resolveMobile(ctx, runTarget, creds, phoneMemoryOf(sink, runTarget));
    if (!device.env) {
        // Written, kept, not run: never reported as passing.
        const why = device.reason ?? "no phone or emulator can be used";
        for (const t of pending) ctx.emit({ stage: "validation", kind: "validation_not_executed", level: "warn", message: `${t.spec.testId} is a phone test and was not run: ${why}` });
        summary.errors.push(`The new tests were not run: ${why}`);
        await sink.phase("VALIDATING", "validation", "skipped");
        return summary;
    }
    await sink.phase("VALIDATING", "validation", "running");
    const startedAt = new Date().toISOString();
    for (const t of pending) await sink.updateTest(handles.get(t.spec.testId)!, { validation: "VALIDATING" });
    const outcomes: ValidationOutcome[] = await validateBatch(
        ctx,
        { scratchDir: ctx.config.scratchDir, env: { baseUrl: appUri, apiBaseUrl: appUri, ...(creds ? { credentials: creds } : {}), headless: ctx.config.HEADLESS }, render: renderCtx, model: stub, maxRepairAttempts: 0, workers: 1, mobile: device.env },
        pending,
        {
            async onAttempt(t, attempt, _script, run) {
                const h = handles.get(t.spec.testId)!;
                await sink.recordExecution(h, scriptIds.get(t.spec.testId) ?? null, attempt, run, attempt === 1 ? startedAt : new Date(Date.now() - run.durationMs).toISOString());
                await sink.updateTest(h, { attempts: attempt });
            },
            async onFinal(t, outcome) {
                await sink.updateTest(handles.get(t.spec.testId)!, { validation: outcome.status, reason: outcome.reason ?? null, attempts: outcome.attempts, spec: outcome.spec });
            },
            onNotRun: async (t) => await sink.restoreTest?.(handles.get(t.spec.testId)!),
        },
    );
    for (const o of outcomes) {
        if (o.status === "NOT_RUN") continue;
        if (o.status === "VALIDATED") summary.testsValidated++;
        else if (o.status === "NEEDS_REVIEW") summary.testsNeedingReview++;
        else summary.testsFailedValidation++;
    }
    await sink.counters({ testsValidated: summary.testsValidated, testsFailedValidation: summary.testsFailedValidation, testsNeedingReview: summary.testsNeedingReview }, true);
    await sink.phase("VALIDATING", "validation", "done");
    await sink.counters({ llmInputTokens: ctx.llm.usage.inputTokens, llmOutputTokens: ctx.llm.usage.outputTokens });
    throwIfAborted(ctx.signal);
    ctx.emit({ stage: "orchestration", kind: "job_summary", message: `${summary.testsGenerated} phone tests generated, ${summary.testsValidated} validated, ${summary.testsNeedingReview} need review, ${summary.testsFailedValidation} failed validation` });
    return summary;
}

export { isPhoneIdea };

/**
 * The coverage of a map exploration in one sentence for the plan: "Explored 142 screens in 31 activities (the phone lists 40 for the app),
 * with 600 actions and 12 AI calls. It stopped because: no new screens after 80 actions: the app looks fully explored."
 */
export function coverageSentence(c: ExploreCoverage): string {
    const acts = c.activitiesSeen.length;
    const of = c.activitiesListed ? ` (the phone lists ${c.activitiesListed} for the app)` : "";
    const why = c.stoppedBecause.replace(/\.$/, "");
    return `Explored ${c.screens} screen${c.screens === 1 ? "" : "s"} in ${acts} activit${acts === 1 ? "y" : "ies"}${of}, with ${c.actions} actions and ${c.aiCalls} AI call${c.aiCalls === 1 ? "" : "s"}. It stopped because: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`;
}
