import { z } from "zod";
import { ENV_NAME } from "../../engine/environments/env.js";
import { EXTRA_VARIANT_IDS } from "../../engine/validation/variants.js";
import { getAgentServices } from "../agent-services.js";
import { actorLabel } from "../auth/actor.js";
import { PRODUCTION_CONFIRM_MESSAGE } from "../environment-run.js";
import { findEnvironment } from "../environments-store.js";
import { HttpError } from "../http-error.js";
import type { TestRow } from "../repo.js";
import { SUITE_LIMITS, SuiteSettingsSchema, DEFAULT_SUITE_SETTINGS, type Suite, type SuiteSettings } from "../suite-store.js";
import { chooseVersionsToRun, runsCanStartHere, splitExecutable, suiteJobOptions, suiteStoreFor, suiteTests } from "../suite-run.js";
import { startEnvironmentRun } from "./environments.js";
import type { RouteCtx } from "./types.js";

/**
 * Test suites a person builds (suite-store.ts): create, rename, describe, delete, add and remove tests, reorder, duplicate, and run.
 * `GET /api/projects/:id/suites` (the automatic groups by area) is unchanged; these live under `/test-suites`.
 * Reading needs access to the project; changing needs ai_studio.tests.write; running needs ai_studio.tests.run (auth/roles.ts).
 */

const Name = z.string().trim().min(1, "Give the suite a name").max(SUITE_LIMITS.nameLength);
const Description = z.string().trim().max(SUITE_LIMITS.descriptionLength);
const TestIds = z.array(z.string().min(1).max(100)).max(SUITE_LIMITS.testsPerSuite);
const SettingsPatch = z
    .object({
        environment: z.string().regex(ENV_NAME).nullable(),
        confirmProduction: z.boolean(),
        browsers: z.array(z.enum(EXTRA_VARIANT_IDS)).max(EXTRA_VARIANT_IDS.length),
        retries: z.number().int().min(0).max(2),
        stopOnFirstFailure: z.boolean(),
    })
    .partial()
    .strict();
const CreateBody = z.object({ name: Name, description: Description.optional(), testIds: TestIds.optional(), settings: SettingsPatch.optional() }).strict();
const PatchBody = z.object({ name: Name, description: Description, settings: SettingsPatch }).partial().strict();
const AddBody = z.object({ testIds: TestIds.min(1, "Choose at least one test"), position: z.number().int().min(0).optional() }).strict();
const OrderBody = z.object({ testIds: TestIds }).strict();
const DuplicateBody = z.object({ name: Name.optional() }).strict();

export const ENVIRONMENT_RUN_LIMITS =
    "A run against an environment checks desktop Chrome only, runs each test once and runs every test, so other browsers, retries and stopping at the first failure apply only to runs against the project's own address.";

export function registerSuiteRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = suiteStoreFor(p);

    const suiteOf = async (projectId: string, sid: string): Promise<Suite> => {
        const s = await store.get(sid);
        if (!s || s.projectId !== projectId) throw new HttpError(404, "Suite not found");
        return s;
    };
    /** Tests of this project by id, in the order given, once each. An id of another project reads as unknown. */
    const testsOf = (projectId: string, ids: string[]): TestRow[] => {
        const out: TestRow[] = [];
        for (const id of [...new Set(ids)]) {
            const t = repo.getTest(id);
            if (!t || t.projectId !== projectId) throw new HttpError(400, `Unknown test: ${id}`);
            out.push(t);
        }
        return out;
    };
    const uniqueName = async (projectId: string, name: string, except?: string) => {
        const hit = await store.findByName(projectId, name);
        if (hit && hit.id !== except) throw new HttpError(409, `This project already has a suite called “${hit.name}”.`);
    };
    /** The settings a suite ends up with, checked: the environment exists, production is confirmed, and the options apply there. */
    const settle = (projectId: string, cur: SuiteSettings, patch: z.infer<typeof SettingsPatch> | undefined): SuiteSettings => {
        if (!patch) return cur;
        const environment = patch.environment === undefined ? cur.environment : patch.environment;
        // A different environment needs its own confirmation; the same one keeps what was confirmed unless the patch says otherwise.
        const confirmProduction = patch.confirmProduction ?? (environment === cur.environment ? cur.confirmProduction : false);
        const next: SuiteSettings = SuiteSettingsSchema.parse({ ...cur, ...patch, environment, confirmProduction: Boolean(environment) && confirmProduction });
        if (next.environment) {
            const env = findEnvironment(repo.db, projectId, next.environment);
            if (!env) throw new HttpError(404, `This project has no environment called “${next.environment}”.`);
            if (env.production && !next.confirmProduction) throw new HttpError(409, PRODUCTION_CONFIRM_MESSAGE(env.name), { requiresConfirmation: true });
            if (next.browsers.length || next.retries || next.stopOnFirstFailure) throw new HttpError(400, ENVIRONMENT_RUN_LIMITS);
        }
        return next;
    };
    const publicSuite = (s: Suite) => ({ id: s.id, projectId: s.projectId, name: s.name, description: s.description, settings: s.settings, testCount: s.testCount, createdBy: s.createdBy, createdAt: s.createdAt, updatedAt: s.updatedAt });
    const runsOf = async (sid: string, limit: number) =>
        (await store.runs(sid, limit)).flatMap((r) => {
            const job = repo.getJob(r.jobId);
            return job ? [{ jobId: r.jobId, trigger: r.trigger, scheduleId: r.scheduleId, testCount: r.testCount, createdAt: r.createdAt, job: ctx.publicJob(job) }] : [];
        });
    const where = (projectId: string): string | null => {
        try {
            return getAgentServices(p).runnerStatus(projectId).status;
        } catch {
            return null;
        }
    };

    app.get("/api/projects/:id/test-suites", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const suites = await store.list(id);
        const out = [];
        for (const s of suites) out.push({ ...publicSuite(s), lastRun: (await runsOf(s.id, 1))[0] ?? null });
        return { suites: out, automatic: repo.listSuites(id), canRun: runsCanStartHere(p), limits: SUITE_LIMITS };
    });

    app.post("/api/projects/:id/test-suites", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = CreateBody.parse(req.body ?? {});
        if ((await store.list(id)).length >= SUITE_LIMITS.suitesPerProject) throw new HttpError(409, `A project can have up to ${SUITE_LIMITS.suitesPerProject} suites.`);
        await uniqueName(id, body.name);
        const tests = testsOf(id, body.testIds ?? []);
        const settings = settle(id, DEFAULT_SUITE_SETTINGS, body.settings);
        const made = await store.create({ projectId: id, name: body.name, description: body.description, settings, testIds: tests.map((t) => t.id), createdBy: actorLabel() });
        return reply.code(201).send(publicSuite(made));
    });

    app.get("/api/projects/:id/test-suites/:sid", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        const s = await suiteOf(id, sid);
        const tests = (await suiteTests(repo, store, s)).map((t) => ({ id: t.id, testId: t.testKey, title: t.title, kind: t.kind, type: t.type, priority: t.priority, area: t.suite, framework: t.framework, validationStatus: t.validationStatus, validationReason: t.validationReason }));
        return { suite: publicSuite(s), tests, runs: await runsOf(sid, 10), schedules: await store.schedulesOf(sid), canRun: runsCanStartHere(p), where: where(id) };
    });

    app.patch("/api/projects/:id/test-suites/:sid", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        const cur = await suiteOf(id, sid);
        const body = PatchBody.parse(req.body ?? {});
        if (body.name !== undefined) await uniqueName(id, body.name, sid);
        const settings = settle(id, cur.settings, body.settings);
        return publicSuite((await store.update(sid, { name: body.name, description: body.description, settings }))!);
    });

    app.delete("/api/projects/:id/test-suites/:sid", async (req, reply) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        await suiteOf(id, sid);
        // A schedule that runs this suite would otherwise quietly start running something else.
        const used = await store.schedulesOf(sid);
        if (used.length) throw new HttpError(409, `The schedule “${used[0]!.name}” runs this suite. Change or delete ${used.length === 1 ? "that schedule" : `the ${used.length} schedules that run it`} first.`, { schedules: used });
        await store.delete(sid);
        return reply.code(204).send();
    });

    app.post("/api/projects/:id/test-suites/:sid/tests", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        const s = await suiteOf(id, sid);
        const body = AddBody.parse(req.body ?? {});
        const tests = testsOf(id, body.testIds);
        const have = new Set(await store.testIds(sid));
        const fresh = tests.filter((t) => !have.has(t.id));
        if (s.testCount + fresh.length > SUITE_LIMITS.testsPerSuite) throw new HttpError(409, `A suite can have up to ${SUITE_LIMITS.testsPerSuite} tests.`);
        const added = await store.addTests(sid, tests.map((t) => t.id), body.position);
        return { added, alreadyIn: tests.length - added, testIds: await store.testIds(sid) };
    });

    app.delete("/api/projects/:id/test-suites/:sid/tests/:testId", async (req) => {
        const { id, sid, testId } = req.params as { id: string; sid: string; testId: string };
        ctx.project(id);
        await suiteOf(id, sid);
        if (!(await store.removeTest(sid, testId))) throw new HttpError(404, "This test is not in the suite.");
        return { testIds: await store.testIds(sid) };
    });

    app.put("/api/projects/:id/test-suites/:sid/order", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        await suiteOf(id, sid);
        const body = OrderBody.parse(req.body ?? {});
        if (!(await store.reorder(sid, body.testIds))) throw new HttpError(400, "The new order must list every test of the suite exactly once. Reload the suite and try again.");
        return { testIds: await store.testIds(sid) };
    });

    app.post("/api/projects/:id/test-suites/:sid/duplicate", async (req, reply) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        const s = await suiteOf(id, sid);
        const body = DuplicateBody.parse(req.body ?? {});
        if ((await store.list(id)).length >= SUITE_LIMITS.suitesPerProject) throw new HttpError(409, `A project can have up to ${SUITE_LIMITS.suitesPerProject} suites.`);
        let name = body.name;
        if (name) await uniqueName(id, name);
        else {
            const base = `Copy of ${s.name}`.slice(0, SUITE_LIMITS.nameLength);
            name = base;
            for (let n = 2; await store.findByName(id, name); n++) name = `${base.slice(0, SUITE_LIMITS.nameLength - 5)} (${n})`;
        }
        return reply.code(201).send(publicSuite((await store.duplicate(sid, name, actorLabel()))!));
    });

    /** Queues a run of exactly the suite's tests, in its order, with its settings, through the same run path as "run these tests". */
    app.post("/api/projects/:id/test-suites/:sid/run", async (req, reply) => {
        const { id, sid } = req.params as { id: string; sid: string };
        ctx.project(id);
        const s = await suiteOf(id, sid);
        z.object({}).strict().parse(req.body ?? {});
        // Said plainly before anything is queued: a run nothing will pick up is not a run.
        const can = runsCanStartHere(p);
        if (!can.ok) throw new HttpError(409, can.reason, { cannotRunHere: true });
        const all = await suiteTests(repo, store, s);
        if (all.length === 0) throw new HttpError(422, "This suite has no tests yet. Add tests to it first.");
        const chosen = await chooseVersionsToRun(repo, id, all);
        if (chosen.run.length === 0) throw new HttpError(422, `None of this suite's tests can run. ${chosen.held[0]?.reason ?? ""}`.trim(), { skipped: chosen.held });
        if (s.settings.environment) {
            const started = await startEnvironmentRun({ repo, p, applicationFor: (pid) => ctx.applicationFor(pid), assertNoActiveJob: ctx.assertNoActiveJob }, id, chosen.run, s.settings.environment, s.settings.confirmProduction);
            await store.recordRun({ suiteId: sid, jobId: started.jobId, trigger: "manual", testCount: started.testCount });
            return reply.code(202).send({ ...started, skipped: [...chosen.held, ...started.skipped] });
        }
        const { run, skipped } = splitExecutable(chosen.run);
        if (run.length === 0) throw new HttpError(422, `None of this suite's tests can run here. ${skipped[0]!.reason}`, { skipped });
        const application = await ctx.applicationFor(id);
        // Right before creating the job, with no await in between (one active job per project).
        await ctx.assertNoActiveJob(id);
        const job = await repo.createJob(id, application.id, suiteJobOptions(s.settings, run.map((t) => t.id)));
        await store.recordRun({ suiteId: sid, jobId: job.id, trigger: "manual", testCount: run.length });
        return reply.code(202).send({ jobId: job.id, status: job.status, testCount: run.length, tests: run.map((t) => ({ id: t.id, testId: t.testKey })), skipped: [...chosen.held, ...skipped] });
    });
}
