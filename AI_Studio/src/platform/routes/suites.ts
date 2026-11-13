import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    MAX_PROPOSED_SUITES,
    MAX_SCRIPTS_FOR_AI,
    NO_MODEL_FOR_SUITES,
    proposalFromAnswer,
    proposeSuites,
    requirementSuiteName,
    scriptsByRequirement,
    type ProposalAnswer,
    type ScriptForSuites,
} from "../../engine/authoring/suite-plan.js";
import { ENV_NAME } from "../../engine/environments/env.js";
import { classifyLlmError, describeLlmError } from "../../engine/llm/errors.js";
import { JobMeter } from "../../engine/llm/metered.js";
import { EXTRA_VARIANT_IDS } from "../../engine/validation/variants.js";
import { getAgentServices } from "../agent-services.js";
import { aiOwnerOfActor, personLlm } from "../ai-config.js";
import { currentActor } from "../auth/actor.js";
import { assertHoldsHere } from "../auth/access.js";
import { actorLabel } from "../auth/actor.js";
import { PRODUCTION_CONFIRM_MESSAGE } from "../environment-run.js";
import { findEnvironment } from "../environments-store.js";
import { HttpError } from "../http-error.js";
import { ManualCaseStore } from "../manual-case-store.js";
import type { TestRow } from "../repo.js";
import { RequirementStore } from "../requirement-store.js";
import { SUITE_LIMITS, SuiteSettingsSchema, DEFAULT_SUITE_SETTINGS, type Suite, type SuiteSettings } from "../suite-store.js";
import { chooseVersionsToRun, runsCanStartHere, splitExecutable, suiteJobOptions, suiteStoreFor, suiteTests } from "../suite-run.js";
import { aiSkipReason, usageStoreFor } from "../usage-store.js";
import { startEnvironmentRun } from "./environments.js";
import type { RouteCtx } from "./types.js";

/**
 * Test suites a person builds (suite-store.ts): create, rename, describe, delete, add and remove tests, reorder, duplicate, and run.
 * `GET /api/projects/:id/suites` (the automatic groups by area) is unchanged; these live under `/test-suites`.
 * Reading needs access to the project; changing needs ai_studio.tests.write; running needs ai_studio.tests.run (auth/roles.ts).
 *
 * Suites made from test scripts (engine/authoring/suite-plan.ts), all saved with the default settings. Every change that checks names or
 * the number of suites takes its turn per project (inTurn), the existing create, rename and duplicate included:
 *   POST /test-suites/from-scripts  { name, description?, testIds }        one suite of the scripts chosen on Test scripts
 *   POST /test-suites/generate      { by: "requirement", dryRun? }         one suite per requirement, no AI (dryRun: what it would do)
 *   POST /test-suites/propose       {}                                     the AI proposes suites; nothing is saved
 *   POST /test-suites/batch         { suites: [{ name, description?, testIds }] }   saves the suites the person approved, all or none
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
const NewSuite = z.object({ name: Name, description: Description.optional(), testIds: TestIds.min(1, "Choose at least one test script") }).strict();
const BatchBody = z.object({ suites: z.array(NewSuite).min(1, "Choose at least one suite to save").max(MAX_PROPOSED_SUITES) }).strict();
const GenerateBody = z.object({ by: z.literal("requirement"), dryRun: z.boolean().optional() }).strict();

export const NO_SCRIPTS_FOR_SUITES = "This project has no test scripts yet. Add or generate test scripts first, then group them into suites.";
export const SUITES_BEING_PROPOSED = "The AI is already proposing suites for this project. Wait for that proposal, then try again.";
/** Why a requirement got no suite from "Generate suites" (by requirement). */
export type RequirementSkip = "no-scripts" | "retired" | "limit" | "full";
const requirementSuiteDescription = (ref: string) =>
    `The test scripts that check ${ref}, through its test cases or linked to it directly. Generating suites by requirement again adds scripts that are new to this requirement; it never removes a script, and a script you take out of this suite is not put back.`;

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
    /**
     * Changes that check names or the number of suites and then save take turns per project (this server runs one process): creating,
     * renaming, duplicating, and the routes below that make suites. Nothing in the database enforces unique names or the limit, so two
     * at once could each pass the checks. A call waits for the one before it; it is not refused.
     */
    // Each turn has a number, so the last one can tell it is still the last one without comparing promises.
    const turns = new Map<string, { tail: Promise<unknown>; turn: number }>();
    let turnCount = 0;
    const inTurn = <T>(pid: string, work: () => Promise<T>): Promise<T> => {
        const next = (turns.get(pid)?.tail ?? Promise.resolve()).then(work, work);
        const tail = next.then(
            () => undefined,
            () => undefined,
        );
        const turn = ++turnCount;
        turns.set(pid, { tail, turn });
        void tail.then(() => {
            if (turns.get(pid)?.turn === turn) turns.delete(pid);
        });
        return next;
    };
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
        const made = await inTurn(id, async () => {
            if ((await store.list(id)).length >= SUITE_LIMITS.suitesPerProject) throw new HttpError(409, `A project can have up to ${SUITE_LIMITS.suitesPerProject} suites.`);
            await uniqueName(id, body.name);
            const tests = testsOf(id, body.testIds ?? []);
            const settings = settle(id, DEFAULT_SUITE_SETTINGS, body.settings);
            return store.create({ projectId: id, name: body.name, description: body.description, settings, testIds: tests.map((t) => t.id), createdBy: actorLabel() });
        });
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
        await suiteOf(id, sid);
        const body = PatchBody.parse(req.body ?? {});
        return inTurn(id, async () => {
            const cur = await suiteOf(id, sid);
            if (body.name !== undefined) await uniqueName(id, body.name, sid);
            const settings = settle(id, cur.settings, body.settings);
            return publicSuite((await store.update(sid, { name: body.name, description: body.description, settings }))!);
        });
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
        const made = await inTurn(id, async () => {
            if ((await store.list(id)).length >= SUITE_LIMITS.suitesPerProject) throw new HttpError(409, `A project can have up to ${SUITE_LIMITS.suitesPerProject} suites.`);
            let name = body.name;
            if (name) await uniqueName(id, name);
            else {
                const base = `Copy of ${s.name}`.slice(0, SUITE_LIMITS.nameLength);
                name = base;
                for (let n = 2; await store.findByName(id, name); n++) name = `${base.slice(0, SUITE_LIMITS.nameLength - 5)} (${n})`;
            }
            return (await store.duplicate(sid, name, actorLabel()))!;
        });
        return reply.code(201).send(publicSuite(made));
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

    // ── suites made from test scripts (engine/authoring/suite-plan.ts) ──────────

    const cases = new ManualCaseStore(p.db);
    const requirements = new RequirementStore(p.sql);
    /** Projects the AI is proposing suites for right now: a second proposal would be a second paid model call for the same thing. */
    const proposing = new Set<string>();
    /** Scripts of this project by id, each once in the order given. Another project's id, or one that does not exist, is a 404. */
    const scriptIdsOf = (pid: string, ids: string[]): string[] => {
        const out = [...new Set(ids)];
        for (const x of out) if (repo.getTest(x)?.projectId !== pid) throw new HttpError(404, `Not a test script of this project: ${x}`);
        return out;
    };
    /** The project's scripts (in key order, with the requirements each covers), its requirements, and the scripts of each requirement. */
    const groundsOf = async (pid: string) => {
        const tests = repo.listTests(pid);
        const reqs = await requirements.list(pid);
        const known = new Set(reqs.map((r) => r.id));
        const links = await requirements.allLinks(pid);
        // A written case comes from its requirement (manual_cases.requirement_id) and from requirements linked to it; its scripts are linkedTestIds.
        const linkedToCase = new Map<string, string[]>();
        for (const l of links) if (l.kind === "manual") linkedToCase.set(l.testId, [...(linkedToCase.get(l.testId) ?? []), l.requirementId]);
        const caseLinks = cases.listCases(pid).map((c) => ({ requirementIds: [...(c.requirementId ? [c.requirementId] : []), ...(linkedToCase.get(c.id) ?? [])].filter((r) => known.has(r)), scriptIds: c.linkedTestIds }));
        const direct = links.filter((l) => l.kind === "automated").map((l) => ({ requirementId: l.requirementId, scriptId: l.testId }));
        const scriptsOfReq = scriptsByRequirement({ cases: caseLinks, direct, scripts: tests.map((t) => ({ id: t.id, key: t.testKey })) });
        const refsOf = new Map<string, string[]>();
        for (const r of reqs) for (const sid of scriptsOfReq.get(r.id) ?? []) refsOf.set(sid, [...(refsOf.get(sid) ?? []), r.ref]);
        const scripts: ScriptForSuites[] = tests
            .map((t) => ({ id: t.id, key: t.testKey, title: t.title, kind: t.kind, type: t.type, priority: t.priority, area: t.suite, requirements: refsOf.get(t.id) ?? [] }))
            .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id));
        return { scripts, reqs, scriptsOfReq };
    };
    /** Saves new suites of chosen scripts, all or none: the project has room, every name is free (in the project and in the list), every script is the project's. */
    const createSuites = async (pid: string, list: Array<z.infer<typeof NewSuite>>): Promise<Suite[]> => {
        const existing = await store.list(pid);
        if (existing.length + list.length > SUITE_LIMITS.suitesPerProject)
            throw new HttpError(409, `A project can have up to ${SUITE_LIMITS.suitesPerProject} suites, and this one has ${existing.length}. ${list.length === 1 ? "Delete a suite first." : `Save fewer suites, or delete some first.`}`);
        const names = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s.name]));
        const inList = new Set<string>();
        for (const s of list) {
            const key = s.name.trim().toLowerCase();
            const hit = names.get(key);
            if (hit) throw new HttpError(409, `This project already has a suite called “${hit}”. Choose another name.`, { name: s.name });
            if (inList.has(key)) throw new HttpError(409, `Two of these suites are called “${s.name}”. Give each its own name.`, { name: s.name });
            inList.add(key);
        }
        const checked = list.map((s) => ({ ...s, testIds: scriptIdsOf(pid, s.testIds) }));
        // One transaction: a failing insert (a script deleted meanwhile, a database error) undoes the suites before it.
        return store.createMany(checked.map((s) => ({ projectId: pid, name: s.name, description: s.description, settings: DEFAULT_SUITE_SETTINGS, testIds: s.testIds, createdBy: actorLabel() })));
    };

    /** "Create suite from selection" on Test scripts: one new suite of exactly the chosen scripts, in the order given. */
    app.post("/api/projects/:id/test-suites/from-scripts", async (req, reply) => {
        const { id: pid } = req.params as { id: string };
        ctx.project(pid);
        const body = NewSuite.parse(req.body ?? {});
        const [made] = await inTurn(pid, () => createSuites(pid, [body]));
        return reply.code(201).send(publicSuite(made!));
    });

    /** Saves the suites the person approved (the AI's proposal after their edits), all or none. */
    app.post("/api/projects/:id/test-suites/batch", async (req, reply) => {
        const { id: pid } = req.params as { id: string };
        ctx.project(pid);
        const body = BatchBody.parse(req.body ?? {});
        const made = await inTurn(pid, () => createSuites(pid, body.suites));
        return reply.code(201).send({ suites: made.map(publicSuite) });
    });

    /**
     * "Generate suites", by requirement, no AI: one suite per requirement that has test scripts, named "REQ-1: its title". The suite
     * remembers its requirement (its origin, suite-store.ts), so a later run finds it by the requirement whatever it or the requirement is
     * called now, and never touches a suite a person made. A later run adds only scripts that are new to the requirement, at the end:
     * nothing is removed, the order and settings stay, and a script a person took out is not put back. The plan names the schedules
     * that run an updated suite. Retired requirements and requirements without scripts get none. `dryRun` saves nothing.
     */
    app.post("/api/projects/:id/test-suites/generate", async (req) => {
        const { id: pid } = req.params as { id: string };
        ctx.project(pid);
        const body = GenerateBody.parse(req.body ?? {});
        const dryRun = Boolean(body.dryRun);
        const work = async () => {
            const { reqs, scriptsOfReq } = await groundsOf(pid);
            const existing = await store.list(pid);
            let room = SUITE_LIMITS.suitesPerProject - existing.length;
            const suites: Array<{
                requirementId: string;
                ref: string;
                title: string;
                action: "create" | "add" | "up-to-date";
                suiteId: string | null;
                name: string;
                testIds: string[];
                adding: number;
                /** Scripts of the requirement a person took out of its suite: they stay out. */
                keptOut: number;
                /** The schedules that run the suite: their next run includes the added scripts. */
                schedules: Array<{ id: string; name: string; enabled: boolean }>;
            }> = [];
            const names = new Set(existing.map((s) => s.name.trim().toLowerCase()));
            const skipped: Array<{ requirementId: string; ref: string; title: string; reason: RequirementSkip; detail: string }> = [];
            const max = SUITE_LIMITS.testsPerSuite;
            for (const r of reqs) {
                const base = { requirementId: r.id, ref: r.ref, title: r.title };
                const ids = scriptsOfReq.get(r.id) ?? [];
                if (r.status === "retired") {
                    skipped.push({ ...base, reason: "retired", detail: `${r.ref} is retired, so it gets no suite.` });
                    continue;
                }
                if (!ids.length) {
                    skipped.push({ ...base, reason: "no-scripts", detail: `${r.ref} has no test scripts yet.` });
                    continue;
                }
                const mine = existing.find((s) => s.origin?.kind === "requirement" && s.origin.requirementId === r.id);
                if (mine) {
                    const have = new Set(await store.testIds(mine.id));
                    const handled = new Set(mine.origin!.added);
                    // New to the requirement since the last run; a script handled before and not in the suite now was taken out by a person.
                    const fresh = ids.filter((x) => !handled.has(x) && !have.has(x));
                    const keptOut = ids.filter((x) => handled.has(x) && !have.has(x)).length;
                    const fits = fresh.slice(0, Math.max(0, max - have.size));
                    if (fits.length < fresh.length) skipped.push({ ...base, reason: "full", detail: `${fresh.length - fits.length} of ${r.ref}'s scripts did not fit in “${mine.name}”: a suite can have up to ${max} scripts.` });
                    // Remembered as handled: what is in the suite now or added now (one that did not fit is tried again next time).
                    const seen = ids.filter((x) => have.has(x) || fits.includes(x));
                    if (!dryRun && (fits.length || seen.some((x) => !handled.has(x)))) await store.addGenerated(mine.id, fits, seen);
                    const schedules = fits.length ? await store.schedulesOf(mine.id) : [];
                    suites.push({ ...base, action: fits.length ? "add" : "up-to-date", suiteId: mine.id, name: mine.name, testIds: fits, adding: fits.length, keptOut, schedules });
                    continue;
                }
                if (room <= 0) {
                    skipped.push({ ...base, reason: "limit", detail: `${r.ref} got no suite: a project can have up to ${SUITE_LIMITS.suitesPerProject} suites.` });
                    continue;
                }
                room--;
                // A suite a person made may already have the name: this one gets a number, and theirs is left alone.
                const base0 = requirementSuiteName(r.ref, r.title, SUITE_LIMITS.nameLength);
                let name = base0;
                for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base0.slice(0, SUITE_LIMITS.nameLength - 5).trimEnd()} (${n})`;
                names.add(name.toLowerCase());
                const testIds = ids.slice(0, max);
                if (testIds.length < ids.length) skipped.push({ ...base, reason: "full", detail: `${ids.length - max} of ${r.ref}'s scripts did not fit in its suite: a suite can have up to ${max} scripts.` });
                const origin = { kind: "requirement" as const, requirementId: r.id, added: testIds };
                const suiteId = dryRun ? null : (await store.create({ projectId: pid, name, description: requirementSuiteDescription(r.ref), settings: DEFAULT_SUITE_SETTINGS, testIds, createdBy: actorLabel(), origin })).id;
                suites.push({ ...base, action: "create", suiteId, name, testIds, adding: testIds.length, keptOut: 0, schedules: [] });
            }
            return { dryRun, suites, skipped, created: suites.filter((s) => s.action === "create").length, updated: suites.filter((s) => s.action === "add").length };
        };
        return dryRun ? work() : inTurn(pid, work);
    });

    /**
     * "Generate suites using AI": the project's AI proposes suites from the scripts' titles, kinds, types, priorities, areas and
     * requirements. Nothing is saved: the page shows the proposal to the person, who edits and approves it (then POST …/batch).
     */
    app.post("/api/projects/:id/test-suites/propose", async (req) => {
        const { id: pid } = req.params as { id: string };
        ctx.project(pid);
        // ROUTE_PERMISSIONS asks for the AI's permission (ai_studio.tests.generate); the proposal is there to be saved, so changing tests is needed too.
        assertHoldsHere(app, req, pid, "ai_studio.tests.write");
        z.object({}).strict().parse(req.body ?? {});
        const { scripts, reqs } = await groundsOf(pid);
        if (!scripts.length) throw new HttpError(409, NO_SCRIPTS_FOR_SUITES);
        const existing = await store.list(pid);
        const room = SUITE_LIMITS.suitesPerProject - existing.length;
        if (room <= 0) throw new HttpError(409, `A project can have up to ${SUITE_LIMITS.suitesPerProject} suites. Delete some before making more.`);
        // The project's AI and who pays for it (ai-config.ts), as the other AI routes do.
        const { llm, billing, blocked } = await personLlm(p, aiOwnerOfActor(currentActor()));
        if (llm.modelName === "unavailable") throw new HttpError(422, blocked ?? NO_MODEL_FOR_SUITES, { modelMissing: true });
        const usage = usageStoreFor(p.db, p.config);
        if (aiSkipReason(usage, pid)) throw new HttpError(409, "The AI token limit was reached, so the AI cannot propose suites now. You can still make suites by requirement or by hand.");
        const sent = scripts.slice(0, MAX_SCRIPTS_FOR_AI);
        // One proposal per project at a time (taken with no await before it): two tabs would pay for the same answer twice.
        if (proposing.has(pid)) throw new HttpError(409, SUITES_BEING_PROPOSED);
        proposing.add(pid);
        const meter = new JobMeter({ backend: usage, jobId: `suites-${randomUUID()}`, projectId: pid, billing });
        let answer: ProposalAnswer;
        try {
            answer = await proposeSuites(
                meter.wrap(llm),
                sent,
                reqs.filter((r) => r.status !== "retired"),
            );
        } catch (e) {
            throw new HttpError(502, `The AI could not propose suites now, so nothing was made. ${describeLlmError(classifyLlmError(e))}`.trim());
        } finally {
            meter.finish();
            proposing.delete(pid);
        }
        const maxSuites = Math.min(MAX_PROPOSED_SUITES, room);
        const proposal = proposalFromAnswer(answer, sent, { maxSuites, nameLength: SUITE_LIMITS.nameLength, descriptionLength: SUITE_LIMITS.descriptionLength, testsPerSuite: SUITE_LIMITS.testsPerSuite, existingNames: existing.map((s) => s.name) });
        const notes: string[] = [];
        if (sent.length < scripts.length) notes.push(`The project has ${scripts.length} test scripts; the AI grouped the first ${sent.length} by key. Add the others to suites by hand.`);
        if (proposal.dropped.unknownScripts) notes.push(`The AI named ${proposal.dropped.unknownScripts === 1 ? "a script" : `${proposal.dropped.unknownScripts} scripts`} this project does not have; ${proposal.dropped.unknownScripts === 1 ? "it was" : "they were"} left out.`);
        if (proposal.dropped.suites) notes.push(`${proposal.dropped.suites === 1 ? "One suite" : `${proposal.dropped.suites} suites`} the AI proposed ${proposal.dropped.suites === 1 ? "was" : "were"} left out: empty, or more than the ${maxSuites} a proposal can hold.`);
        if (!proposal.suites.length) notes.push("The AI proposed no suites that could be used. Try again, or generate suites by requirement.");
        const used = new Set(proposal.suites.flatMap((s) => s.testIds));
        return {
            suites: proposal.suites,
            scripts: sent.filter((s) => used.has(s.id)).map((s) => ({ id: s.id, testId: s.key, title: s.title, kind: s.kind, area: s.area })),
            notes,
            limits: { suites: maxSuites, nameLength: SUITE_LIMITS.nameLength },
        };
    });
}
