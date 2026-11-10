import { z } from "zod";
import { defaultAdapterFor } from "../../engine/frameworks/index.js";
import { caseDuplicates, ENV_NAME, MAX_ENVIRONMENTS, MAX_VARIABLES, MAX_VARIABLE_VALUE, VARIABLE_NAME } from "../../engine/environments/env.js";
import {
    checkDataSet,
    DATA_FORMATS,
    DATA_SET_NAME,
    DataSetError,
    dataSetNameOf,
    formatFromFilename,
    MAX_DATA_COLUMNS,
    MAX_DATA_ROWS,
    MAX_ROWS_PER_SPEC,
    parseDataSet,
    resolveRows,
    sniffFormat,
    truncationNote,
    unknownPlaceholders,
    type DataSet,
} from "../../engine/testdata/dataset.js";
import { assessSeverity } from "../../engine/validation/severity.js";
import { blockView } from "../block-store.js";
import { assertEnvironmentTargets, assertMayRun, environmentStore, planEnvironmentRun } from "../environment-run.js";
import { DataSetStore, environmentResultsFor, environmentResultsForProject, type Environment } from "../environments-store.js";
import { HttpError } from "../http-error.js";
import { DEFAULT_JOB_OPTIONS, type JobRow, type Repo, type TestRow } from "../repo.js";
import { refuseUnlessRunsStart } from "../suite-run.js";
import type { Platform } from "../bootstrap.js";
import type { RouteCtx } from "./types.js";

/** Routes for the "environments" feature: named environments with a read-only production mode, and test data sets. */

// ── input ───────────────────────────────────────────────────────────────────

/** The site's own address: scheme, host and port. Paths come from the tests (the main run uses the origin only, too). */
const SiteAddress = z
    .string()
    .trim()
    .url("Use a full address like https://staging.example.com")
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address")
    .refine((u) => {
        const x = new URL(u);
        return (x.pathname === "/" || x.pathname === "") && !x.search && !x.hash && !x.username;
    }, "Use just the site's address (like https://staging.example.com): the pages and endpoints come from the tests.")
    .transform((u) => new URL(u).origin);
const ApiAddress = z
    .string()
    .trim()
    .url("Use a full address like https://api.staging.example.com")
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address");

const Variables = z
    .record(z.string(), z.string().max(MAX_VARIABLE_VALUE, `A value can be at most ${MAX_VARIABLE_VALUE} characters.`))
    .superRefine((v, ctx) => {
        const names = Object.keys(v);
        if (names.length > MAX_VARIABLES) ctx.addIssue({ code: "custom", message: `At most ${MAX_VARIABLES} variables.` });
        for (const n of names) if (!VARIABLE_NAME.test(n)) ctx.addIssue({ code: "custom", message: `The variable name “${n}” is not allowed: use letters, digits and _, starting with a letter (at most 40 characters).` });
        const dup = caseDuplicates(names);
        if (dup) ctx.addIssue({ code: "custom", message: `The variable names ${dup} differ only by capital letters, so they would collide.` });
    });

const Name = z.string().trim().regex(ENV_NAME, "Use lower-case letters, digits, - or _, starting with a letter (at most 24 characters).");

const CreateBody = z.object({
    name: Name,
    baseUrl: SiteAddress,
    apiBaseUrl: ApiAddress.optional(),
    production: z.boolean().default(false),
    useProjectAccounts: z.boolean().default(true),
    variables: Variables.default({}),
    isDefault: z.boolean().default(false),
});
const UpdateBody = z
    .object({ baseUrl: SiteAddress, apiBaseUrl: ApiAddress.nullable(), production: z.boolean(), useProjectAccounts: z.boolean(), variables: Variables })
    .partial()
    .strict();
/** Write-only. A field left out keeps what is saved; an empty string removes it. */
const SecretsBody = z
    .object({
        username: z.string().max(300),
        password: z.string().max(300),
        totpSecret: z.union([z.literal(""), z.string().max(200).regex(/^[A-Za-z2-7\s=-]+$/, "must be the base32 setup key (letters A-Z and digits 2-7)")]),
        apiToken: z.string().max(4000),
        apiAuthHeader: z.string().max(4000),
    })
    .partial()
    .strict();
const RunBody = z.object({ testIds: z.array(z.string().min(1).max(100)).max(2000).optional(), confirmProduction: z.boolean().optional() });

const DataBody = z
    .object({
        name: z.string().trim().regex(DATA_SET_NAME, "Use letters, digits, - or _, starting with a letter (at most 40 characters)."),
        /** The file's text (CSV, JSON or YAML). */
        content: z.string().max(2_000_000, "That file is too large for a data set."),
        format: z.enum(DATA_FORMATS).optional(),
        /** Only used to recognise the format and to say plainly that Excel files are not supported. */
        filename: z.string().max(260).optional(),
    })
    .strict();

// ── what the shared routes use ──────────────────────────────────────────────

export interface EnvironmentRunDeps {
    repo: Repo;
    p: Pick<Platform, "config">;
    applicationFor(projectId: string): Promise<{ id: string; url: string }>;
    assertNoActiveJob(projectId: string): Promise<void>;
}

/**
 * Queue a run of existing tests against a named environment. Refuses early, in plain words, when the environment does not exist,
 * is production and was not confirmed, points somewhere the platform may not call, or when every selected test would be skipped.
 */
export async function startEnvironmentRun(deps: EnvironmentRunDeps, projectId: string, tests: TestRow[], environment: string, confirmProduction: boolean | undefined) {
    const { repo } = deps;
    refuseUnlessRunsStart({ config: deps.p.config, db: repo.db }); // tests switched off on this server: nothing is queued
    const env = await assertMayRun(environmentStore(repo, deps.p.config).get(projectId, environment), environment, confirmProduction);
    const plan = planEnvironmentRun(tests, env, blockView(repo.db, projectId));
    if (plan.willRun.length === 0) {
        throw new HttpError(422, tests.length ? `None of these tests can run on “${env.name}”. ${plan.skipped[0]!.reason}` : "There are no tests to run yet.", { skipped: plan.skipped });
    }
    const application = await deps.applicationFor(projectId);
    // Right before creating the job, with no await in between (one active job per project).
    await deps.assertNoActiveJob(projectId);
    // Tests that will be skipped are handed to the job too, so it records *why* next to each of them.
    const job = await repo.createJob(projectId, application.id, {
        ...DEFAULT_JOB_OPTIONS,
        mode: "environment",
        testIds: tests.map((t) => t.id),
        environment: env.name,
        ...(env.production ? { confirmProduction: true } : {}),
    });
    return startedAnswer(job, env, tests, plan);
}

function startedAnswer(job: JobRow, env: Environment, tests: TestRow[], plan: ReturnType<typeof planEnvironmentRun>) {
    return {
        jobId: job.id,
        status: job.status,
        environment: env.name,
        production: env.production,
        tests: tests.filter((t) => plan.willRun.includes(t.id)).map((t) => ({ id: t.id, testId: t.testKey })),
        skipped: plan.skipped,
        testCount: plan.willRun.length,
    };
}

/** Optional `environment` / `confirmProduction` of a run request (the existing validation endpoints accept them). */
export const EnvironmentChoice = z.object({ environment: Name.optional(), confirmProduction: z.boolean().optional() });

/** Added to GET /api/tests/:id: the newest result per environment, and what the test's data set does. */
export function testEnvironmentInfo(repo: Repo, t: TestRow) {
    const results = Object.fromEntries(
        Object.entries(environmentResultsFor(repo.db, t.id)).map(([name, e]) => [
            name,
            { ...e, ...(e.status === "finding" ? { severity: assessSeverity(t.spec, "NEEDS_REVIEW", e.reason) ?? null } : {}) },
        ]),
    );
    const setName = dataSetNameOf(t.spec.testData);
    const set = setName ? new DataSetStore(repo.db).get(t.projectId, setName) : undefined;
    const rows = setName ? safeRows(setName, set) : undefined;
    return {
        environmentResults: results,
        dataDriven: setName ? { dataSet: setName, found: Boolean(set), rows: rows?.rows.length ?? 0, total: rows?.total ?? 0, truncated: rows?.truncated ?? false, ...(rows?.truncated ? { note: truncationNote(setName, rows.total) } : {}) } : null,
    };
}

const safeRows = (name: string, set: DataSet | undefined) => {
    try {
        return resolveRows(name, set ? { [name]: set } : undefined);
    } catch {
        return undefined;
    }
};

/** For the spec import: every spec that names a data set must find it and use only its columns. Same shape as the import's other errors. */
export function dataDrivenSpecIssues(repo: Repo, projectId: string, specs: Array<{ testData: Record<string, string>; steps: unknown[] }>): Array<{ index: number; issues: unknown }> {
    const sets = new DataSetStore(repo.db).asMap(projectId);
    const out: Array<{ index: number; issues: unknown }> = [];
    specs.forEach((spec, index) => {
        const name = dataSetNameOf(spec.testData);
        if (!name) return;
        const path = ["testData", "dataSet"];
        const set = sets[name];
        if (!set) {
            out.push({ index, issues: [{ path, message: `This project has no data set called “${name}”. Import it first (Tests → More actions → Test data).` }] });
            return;
        }
        const unknown = unknownPlaceholders(spec, set.columns);
        if (unknown.length) out.push({ index, issues: [{ path: ["steps"], message: `${unknown.map((u) => `{{${u}}}`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not a column of the data set “${name}” (its columns: ${set.columns.join(", ")}).` }] });
    });
    return out;
}

/** The data sets of a project as the generators take them. */
export const dataSetsFor = (repo: Repo, projectId: string): Record<string, DataSet> => new DataSetStore(repo.db).asMap(projectId);

// ── the routes ──────────────────────────────────────────────────────────────

export function registerEnvironmentRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;
    const store = environmentStore(repo, p.config);
    const data = new DataSetStore(repo.db);

    const need = (projectId: string, name: string): Environment => {
        const env = store.get(projectId, name);
        if (!env) throw new HttpError(404, `This project has no environment called “${name}”.`);
        return env;
    };
    const listAnswer = (projectId: string) => ({ environments: store.list(projectId).map((e) => store.toPublic(e)), max: MAX_ENVIRONMENTS });

    // ── environments ────────────────────────────────────────────────────────
    app.get("/api/projects/:id/environments", async (req) => {
        const id = (req.params as { id: string }).id;
        ctx.project(id);
        return listAnswer(id);
    });

    app.post("/api/projects/:id/environments", async (req, reply) => {
        const id = (req.params as { id: string }).id;
        ctx.project(id);
        const body = CreateBody.parse(req.body);
        if (store.get(id, body.name)) throw new HttpError(400, `This project already has an environment called “${body.name}”.`);
        if (store.list(id).length >= MAX_ENVIRONMENTS) throw new HttpError(400, `At most ${MAX_ENVIRONMENTS} environments per project.`);
        if (body.isDefault && body.production) throw new HttpError(400, "A production environment can't be the default: nothing should run there by accident.");
        await assertEnvironmentTargets({ baseUrl: body.baseUrl, apiBaseUrl: body.apiBaseUrl ?? null });
        const env = store.create(id, body);
        if (body.isDefault) store.makeDefault(env);
        return reply.code(201).send(store.toPublic(store.get(id, body.name)!));
    });

    app.put("/api/projects/:id/environments/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const env = need(id, name);
        const body = UpdateBody.parse(req.body);
        if (body.production && env.isDefault) throw new HttpError(400, "The default environment can't be production. Choose another default first.");
        await assertEnvironmentTargets({ baseUrl: body.baseUrl ?? env.baseUrl, apiBaseUrl: body.apiBaseUrl === undefined ? env.apiBaseUrl : body.apiBaseUrl });
        return store.toPublic(store.update(env, body));
    });

    /** Sign-in details of this environment. Write-only: the answer only says what is saved. */
    app.put("/api/projects/:id/environments/:name/secrets", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const env = need(id, name);
        store.patchSecrets(env, SecretsBody.parse(req.body));
        return store.toPublic(env);
    });

    app.post("/api/projects/:id/environments/:name/default", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const env = need(id, name);
        if (env.production) throw new HttpError(400, "A production environment can't be the default: nothing should run there by accident.");
        store.makeDefault(env);
        return listAnswer(id);
    });

    app.delete("/api/projects/:id/environments/:name", async (req, reply) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const env = need(id, name);
        const scheduled = repo.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules WHERE project_id = ? AND environment = ?", id, env.name)?.n ?? 0;
        if (scheduled) throw new HttpError(409, `${scheduled} schedule${scheduled === 1 ? " runs" : "s run"} against “${env.name}”. Change or remove ${scheduled === 1 ? "it" : "them"} first.`);
        store.delete(env);
        return reply.code(200).send(listAnswer(id));
    });

    /** Run the project's tests (or the ones given) against this environment. */
    app.post("/api/projects/:id/environments/:name/runs", async (req, reply) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const body = RunBody.parse(req.body ?? {});
        const all = repo.listTests(id).filter((t) => t.kind !== "mobile" && t.kind !== "desktop" && defaultAdapterFor(t.spec.kind).executable);
        let tests = all;
        if (body.testIds) {
            const byId = new Map(all.map((t) => [t.id, t]));
            const unknown = body.testIds.filter((x) => !byId.has(x));
            if (unknown.length) throw new HttpError(400, `Unknown test: ${unknown[0]}`);
            tests = [...new Set(body.testIds)].map((x) => byId.get(x)!);
        }
        return reply.code(202).send(await startEnvironmentRun({ repo, p, applicationFor: (pid) => ctx.applicationFor(pid), assertNoActiveJob: ctx.assertNoActiveJob }, id, tests, name, body.confirmProduction));
    });

    /** The newest result of every test in this environment (what `ai-test run --env` reports and the UI summarises). */
    app.get("/api/projects/:id/environments/:name/results", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const env = need(id, name);
        const results = environmentResultsForProject(repo.db, id, env.name);
        const tests = repo.listTests(id).map((t) => {
            const r = results.get(t.id);
            return {
                id: t.id,
                testId: t.testKey,
                title: t.title,
                suite: t.suite,
                kind: t.kind,
                type: t.type,
                priority: t.priority,
                result: r ? { ...r, ...(r.status === "finding" ? { severity: assessSeverity(t.spec, "NEEDS_REVIEW", r.reason) ?? null } : {}) } : null,
            };
        });
        const count = (s: string) => tests.filter((t) => t.result?.status === s).length;
        return { environment: store.toPublic(env), summary: { passed: count("passed"), failed: count("failed"), findings: count("finding"), skipped: count("skipped"), notRun: tests.filter((t) => !t.result).length }, tests };
    });

    // ── test data ───────────────────────────────────────────────────────────
    const usedBy = (projectId: string, name: string) => repo.listTests(projectId).filter((t) => dataSetNameOf(t.spec.testData) === name);
    const brief = (d: { name: string; columns: string[]; rows: unknown[]; updatedAt: string }, projectId: string) => {
        const using = usedBy(projectId, d.name);
        return { name: d.name, columns: d.columns, rowCount: d.rows.length, testedRows: Math.min(d.rows.length, MAX_ROWS_PER_SPEC), truncated: d.rows.length > MAX_ROWS_PER_SPEC, usedBy: using.length, updatedAt: d.updatedAt };
    };
    const limits = { maxRows: MAX_DATA_ROWS, maxColumns: MAX_DATA_COLUMNS, maxRowsPerTest: MAX_ROWS_PER_SPEC, formats: ["csv", "json", "yaml"], excel: "Excel files aren't supported: save the sheet as CSV first." };

    app.get("/api/projects/:id/test-data", async (req) => {
        const id = (req.params as { id: string }).id;
        ctx.project(id);
        return { dataSets: data.list(id).map((d) => brief(d, id)), limits };
    });

    app.get("/api/projects/:id/test-data/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const d = data.get(id, name);
        if (!d) throw new HttpError(404, `This project has no data set called “${name}”.`);
        return { ...brief(d, id), rows: d.rows, tests: usedBy(id, name).map((t) => ({ id: t.id, testId: t.testKey, title: t.title })) };
    });

    function parseBody(raw: unknown): { name: string; set: DataSet } {
        const body = DataBody.parse(raw);
        const fromName = formatFromFilename(body.filename);
        if (fromName === "excel") throw new HttpError(400, "Excel files aren't supported yet. Save the sheet as CSV (File → Save as → CSV) and import that.");
        if (!body.content.trim()) throw new HttpError(400, "The file is empty.");
        const format = body.format ?? fromName ?? sniffFormat(body.content);
        try {
            return { name: body.name, set: parseDataSet(body.content, format) };
        } catch (e) {
            if (e instanceof DataSetError) throw new HttpError(400, e.message);
            throw e;
        }
    }

    /** A data set that tests already use must keep every column they refer to. */
    function assertStillFits(projectId: string, name: string, set: DataSet): void {
        const broken = usedBy(projectId, name).flatMap((t) => {
            const unknown = unknownPlaceholders(t.spec, set.columns);
            return unknown.length ? [`${t.testKey} uses ${unknown.map((u) => `{{${u}}}`).join(", ")}`] : [];
        });
        if (broken.length) throw new HttpError(400, `This would break tests that use “${name}”: ${broken.slice(0, 3).join("; ")}. Keep those columns, or change the tests first.`);
    }

    app.post("/api/projects/:id/test-data", async (req, reply) => {
        const id = (req.params as { id: string }).id;
        ctx.project(id);
        const { name, set } = parseBody(req.body);
        if (data.get(id, name)) throw new HttpError(400, `This project already has a data set called “${name}”. Choose another name, or replace it.`);
        return reply.code(201).send(brief(data.save(id, name, checkDataSet(set)), id));
    });

    app.put("/api/projects/:id/test-data/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        if (!data.get(id, name)) throw new HttpError(404, `This project has no data set called “${name}”.`);
        const parsed = parseBody({ ...(req.body as object), name });
        assertStillFits(id, name, parsed.set);
        return brief(data.save(id, name, parsed.set), id);
    });

    app.delete("/api/projects/:id/test-data/:name", async (req, reply) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        if (!data.get(id, name)) throw new HttpError(404, `This project has no data set called “${name}”.`);
        const using = usedBy(id, name);
        if (using.length) throw new HttpError(409, `${using.length} test${using.length === 1 ? " uses" : "s use"} this data set (${using.slice(0, 3).map((t) => t.testKey).join(", ")}${using.length > 3 ? ", ..." : ""}). Change those tests first.`);
        data.delete(id, name);
        return reply.code(200).send({ dataSets: data.list(id).map((d) => brief(d, id)), limits });
    });
}
