import { z } from "zod";
import { familyCount, planFamilies, planFound, planTotal, type StoredPlan } from "../../engine/planning/preview.js";
import { FAMILY_LABEL } from "../../engine/mobile/explore/types.js";
import { MobileTargetSchema } from "../../engine/mobile/target.js";
import { startStateSentence } from "../../engine/mobile/state/clean-start.js";
import { permissionTitle } from "../../engine/mobile/state/permission-step.js";
import { HttpError } from "../http-error.js";
import { loadTargetProblem } from "../load-guard.js";
import { discardStoredPlan, loadStoredPlan, planOptionsOf, PLAN_GONE } from "../plan-store.js";
import { ACTIVE_STATES, type JobOptions, type JobRow } from "../repo.js";
import { EXPLORING_OFF_MESSAGE, refuseUnlessRunsStart } from "../suite-run.js";
import type { RouteCtx } from "./types.js";
import { droppedChecksNote, narrowedByChoice, type AskedSwitches } from "../testing-agents.js";
import { testingAgentsOf } from "./testing-agents.js";

/**
 * Explore first, create after the person has looked.
 *
 * `POST /api/projects/:id/test-generation` with `plan: true` explores the application and plans, then stops (a normal job that creates and
 * runs nothing, see platform/job-runner.ts). These routes read that plan back and confirm it:
 *   GET    /api/projects/:id/plans/:jobId          what was found, the test ideas, and how many tests each kind of check would create
 *   POST   /api/projects/:id/plans/:jobId/create   create the tests from the plan with the choices made (a normal generation job that starts
 *                                                  from the plan: nothing is explored again)
 *   DELETE /api/projects/:id/plans/:jobId          forget a plan that will not be used
 * Callers that never pass `plan` (the CLI, the MCP server, schedules, the old form) behave exactly as before.
 */

/** What may change when the person confirms: which kinds of check to create and which test ideas to leave out. Nothing that widens what the exploration was allowed to touch. */
const CreateBody = z
    .object({
        targets: z.array(z.enum(["web", "api", "mobile"])).min(1).max(3).optional(),
        accessibility: z.boolean().optional(),
        healthChecks: z.boolean().optional(),
        securityChecks: z.boolean().optional(),
        performanceChecks: z.boolean().optional(),
        loadChecks: z.boolean().optional(),
        inputChecks: z.boolean().optional(),
        visionChecks: z.boolean().optional(),
        contractChecks: z.boolean().optional(),
        accessChecks: z.boolean().optional(),
        visual: z.boolean().optional(),
        excludeIdeas: z.array(z.string().min(1).max(100)).max(500).optional(),
    })
    .strict();

/** What a person sees of a phone plan (no element details, no locators, no steps: those are in the tests once created). */
function phoneAnswer(plan: NonNullable<StoredPlan["mobile"]>, found: NonNullable<StoredPlan["model"]["mobile"]>, _excluded?: string[]) {
    return {
        appPackage: plan.appPackage,
        appName: plan.appName,
        screens: found.screens.map((s) => ({ id: s.id, title: s.title, kind: s.kind, elements: s.elements.length, visits: s.visits })),
        ideas: plan.ideas.map((i) => ({ id: i.id, title: i.title, goal: i.goal, family: i.family, familyLabel: FAMILY_LABEL[i.family], priority: i.priority, path: i.path, usesSignIn: i.usesSignIn, ...(i.why ? { why: i.why } : {}), ...(i.covers?.length ? { covers: i.covers } : {}), steps: Array.isArray((i.draft as { steps?: unknown[] }).steps) ? (i.draft as { steps: unknown[] }).steps.length : 0 })),
        couldNotWrite: plan.dropped.slice(0, 20),
        skipped: found.skipped.slice(0, 30).map((s) => ({ message: s.message, why: s.why })),
        signInNeeded: found.signInNeeded,
        signedIn: found.signedIn,
        stats: found.stats,
        // How much of the app the exploration saw and why it stopped (explore/types.ts ExploreCoverage), for the plan's coverage line.
        ...(found.coverage ? { coverage: found.coverage } : {}),
        // Phone quality checks (mobile/quality): crashes and freezes seen, the cold start time, accessibility per screen, and the check tests they become.
        ...(plan.quality
            ? {
                  quality: {
                      crashes: plan.quality.crashes.map((c) => ({ kind: c.crash.kind, exception: c.crash.exception, stack: c.crash.stack.slice(0, 12), screen: c.screen.title, steps: c.steps.slice(-15), times: c.times ?? 1 })),
                      startup: plan.quality.startup ?? null,
                      accessibility: plan.quality.accessibility.map((s) => ({ screen: s.screen, title: s.title, checked: s.checked, issues: s.issues, ...(s.densityAssumed ? { densityAssumed: true } : {}) })),
                      tests: (plan.quality.tests ?? []).map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
                      couldNotWrite: (plan.quality.couldNotWrite ?? []).slice(0, 20),
                      notes: plan.quality.notes,
                  },
              }
            : {}),
    };
}

/**
 * Phone reliability (engine/mobile/state), only when there is something to say: how every test will start (fresh app data, permissions granted), and
 * the permission questions the tests answer the way the exploration did.
 */
function phoneStartAnswer(mobile: unknown, answers: Array<{ question: string; choice: string; allowed: boolean }> | undefined) {
    const parsed = MobileTargetSchema.safeParse(mobile);
    const startState = parsed.success ? startStateSentence(parsed.data) : undefined;
    return {
        ...(startState ? { startState } : {}),
        ...(answers?.length ? { permissionAnswers: answers.slice(0, 6).map((a) => ({ question: a.question, choice: a.choice, step: permissionTitle(a) })) } : {}),
    };
}

export function registerPlanRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;

    /** The plan-only job this URL names, in this project. */
    const planJob = (projectId: string, jobId: string): JobRow => {
        ctx.project(projectId);
        const job = repo.getJob(jobId);
        if (!job || job.projectId !== projectId || !job.options.planOnly) throw new HttpError(404, "Plan not found");
        return job;
    };
    const usedBy = (projectId: string, jobId: string): JobRow | undefined => repo.listJobs(projectId).find((j) => j.options.fromPlan === jobId);

    app.get("/api/projects/:id/plans/:jobId", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        const job = planJob(id, jobId);
        if (ACTIVE_STATES.includes(job.status) || job.status === "QUEUED") return { jobId, status: job.status, ready: false };
        if (job.status === "FAILED") throw new HttpError(409, job.error === "Cancelled" ? "Exploring was stopped, so there is no plan." : "This exploration did not produce a plan.");
        const loaded = await loadStoredPlan(repo, p.store, jobId);
        if (!loaded.ok) throw new HttpError(410, PLAN_GONE);
        const plan = loaded.plan;
        const app0 = repo.getApplication(job.applicationId);
        const opts = planOptionsOf(job.options, app0?.credentials);
        const families = planFamilies(plan, opts);
        const model = plan.model;
        const used = usedBy(id, jobId);
        return {
            ready: true,
            jobId,
            status: job.status,
            createdAt: job.finishedAt ?? job.createdAt,
            url: app0?.url ?? model.url,
            targets: opts.targets,
            found: planFound(model),
            // What the AI made of the application: only when its understanding step ran.
            about: plan.analysed && (model.purpose || model.features.length) ? { siteType: model.siteType, purpose: model.purpose, features: model.features.slice(0, 8) } : null,
            pages: model.pages.slice(0, 50).map((pg) => ({ path: pg.path || "/", title: pg.title, type: pg.type })),
            ideas: plan.scenarios.map((s) => ({ id: s.scenarioId, title: s.title, journey: s.journey ?? null, priority: s.priority, type: s.type })),
            // Only for an Android app explored on a phone: the screens found, the test ideas with their goal, family and path, what was skipped for safety and why.
            ...(plan.mobile && model.mobile ? { phone: { ...phoneAnswer(plan.mobile, model.mobile, job.options.excludeIdeas), ...phoneStartAnswer((app0?.config as { mobile?: unknown } | undefined)?.mobile, model.mobile.permissions) } } : {}),
            families: families.map((f) => ({ ...f, count: f.count, effective: familyCount(f, opts.targets) })),
            total: planTotal(families, opts.targets),
            warnings: plan.warnings,
            signInDetails: Boolean(app0?.credentials?.username || app0?.credentials?.apiToken || app0?.credentials?.oauth2),
            used: used ? { jobId: used.id } : null,
        };
    });

    app.post("/api/projects/:id/plans/:jobId/create", async (req, reply) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        const job = planJob(id, jobId);
        if (job.status === "FAILED" || ACTIVE_STATES.includes(job.status) || job.status === "QUEUED") throw new HttpError(409, "This exploration has no plan to create tests from.");
        const body = CreateBody.parse(req.body ?? {});
        if (usedBy(id, jobId)) throw new HttpError(409, "The tests for this plan were already created. Explore again to get a new plan.");
        const loaded = await loadStoredPlan(repo, p.store, jobId);
        if (!loaded.ok) throw new HttpError(410, PLAN_GONE);
        const plan = loaded.plan;
        const planned = repo.getApplication(job.applicationId);
        if (!planned) throw new HttpError(409, "The application of this plan no longer exists.");

        // The exploration only looked at what it was told to: the choice can narrow that, never widen it.
        const explored = job.options.targets?.length ? job.options.targets : (["web", "api"] as Array<"web" | "api" | "mobile">);
        const targets = body.targets ?? explored;
        const widened = targets.find((t) => !explored.includes(t));
        if (widened) throw new HttpError(400, `This plan only explored the ${explored.join(" and ")} side of the application, so ${widened === "web" ? "web journeys" : widened === "mobile" ? "phone tests" : "API tests"} can't be added to it. Explore again to include them.`);
        const known = new Set(plan.scenarios.map((s) => s.scenarioId));
        const unknown = (body.excludeIdeas ?? []).find((x) => !known.has(x));
        if (unknown) throw new HttpError(400, `Unknown test idea: ${unknown}`);

        // Who started the plan is not who creates its tests: the person acting now is recorded (createJob), so their AI key and runner are used.
        const { planOnly: _p, fromPlan: _f, excludeIdeas: _e, requirementsText: _r, startedBy: _s, ...kept } = job.options;
        const { targets: _t, excludeIdeas: _x, ...switches } = body;
        const asked: JobOptions = {
            ...kept,
            ...Object.fromEntries(Object.entries(switches).filter(([, v]) => v !== undefined)),
            targets,
            fromPlan: jobId,
            ...(body.excludeIdeas?.length ? { excludeIdeas: [...new Set(body.excludeIdeas)] } : {}),
        };
        // The project's current testing agents decide the checks, by narrowing: a check whose agent was removed since the plan was made is
        // left out (the job's events say which), never refused.
        const narrowed = await narrowedByChoice(testingAgentsOf(p, repo), ctx.project(id), asked, asked as unknown as AskedSwitches);
        const options = narrowed.options;
        // Never wider than what the plan explored (a phone-only plan stays phone-only).
        options.targets = (options.targets ?? targets).filter((t) => targets.includes(t));
        if (options.loadChecks === true && targets.includes("api")) {
            // Load is only ever sent to an allowed address that is not a production environment of this project.
            const refused = await loadTargetProblem(repo.db, id, [options.apiBaseUrl, planned.url]);
            if (refused) throw new HttpError(409, refused);
        }
        // Without the Test Case Generation Agent the plan's journeys are not created: they are not counted either.
        const webIdeas = options.functionalTests === false ? plan.scenarios.map((s) => s.scenarioId).filter((x) => !/^M-\d+$/.test(x)) : [];
        const chosen = planOptionsOf(webIdeas.length ? { ...options, excludeIdeas: [...new Set([...(options.excludeIdeas ?? []), ...webIdeas])] } : options, planned.credentials);
        const families = planFamilies(plan, chosen);
        if (!options.targets.length || planTotal(families, options.targets) === 0)
            throw new HttpError(400, narrowed.dropped.length ? `Nothing is left to create. ${droppedChecksNote(narrowed.dropped)}` : "Nothing is selected to create. Choose at least one kind of test.");

        refuseUnlessRunsStart(ctx.p, EXPLORING_OFF_MESSAGE); // tests switched off on this server: nothing is queued
        await ctx.assertNoActiveJob(id);
        // The application keeps the generation settings and the sign-in details of the plan, minus the one-off plan fields.
        const { fromPlan: _a, excludeIdeas: _b, startedBy: _c, ...config } = options;
        const keptMobile = planned.config.mobile;
        const appId = repo.createApplication(id, planned.url, keptMobile ? { ...config, mobile: keptMobile } : config, planned.credentials);
        const created = await repo.createJob(id, appId, options);
        if (narrowed.dropped.length) repo.addEvent(created.id, { stage: "planning", kind: "agent_checks_dropped", level: "warn", message: droppedChecksNote(narrowed.dropped), data: { dropped: narrowed.dropped } });
        return reply.code(202).send({ jobId: created.id, status: created.status });
    });

    app.delete("/api/projects/:id/plans/:jobId", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        const job = planJob(id, jobId);
        if (ACTIVE_STATES.includes(job.status) || job.status === "QUEUED") throw new HttpError(409, "This exploration is still going. Stop it instead.");
        return { discarded: await discardStoredPlan(repo, p.store, jobId) };
    });
}
