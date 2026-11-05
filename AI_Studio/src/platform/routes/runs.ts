import { z } from "zod";
import { getAdapter, hasAdapter } from "../../engine/frameworks/index.js";
import { EXTRA_VARIANT_IDS, normalizeVariants } from "../../engine/validation/variants.js";
import { HttpError } from "../http-error.js";
import { DEFAULT_JOB_OPTIONS } from "../repo.js";
import { buildRunDetail } from "../run-view.js";
import { refuseUnlessRunsStart } from "../suite-run.js";
import type { RouteCtx } from "./types.js";

/**
 * Run control: start a run of chosen tests on this project's runner, and read one run test by test.
 *
 * `POST /api/projects/:id/runs` is the "run these tests" the other run routes lacked: a test's own validate route runs one test, a
 * schedule runs all, an environment run needs an environment. It queues the same validation job those do (nothing new runs), for
 * the tests it is given (default: every test this platform can execute).
 */

const StartBody = z
    .object({
        testIds: z.array(z.string().min(1).max(100)).min(1, "Choose at least one test").max(2000).optional(),
        /** Run each failing test once more straight away: a pass after a fail is reported as unreliable, not as a regression. */
        retryFailures: z.number().int().min(0).max(1).optional(),
        /** Also check the tests that pass on these browsers and screen sizes (the same option an analysis has). */
        variants: z.array(z.enum(EXTRA_VARIANT_IDS)).max(EXTRA_VARIANT_IDS.length).optional(),
    })
    .strict();

export function registerRunRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;

    app.post("/api/projects/:id/runs", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = StartBody.parse(req.body ?? {});
        // Said plainly before anything is queued: a run nothing will pick up is not a run.
        refuseUnlessRunsStart(ctx.p);
        const all = repo.listTests(id);
        let chosen = all;
        if (body.testIds) {
            const byId = new Map(all.map((t) => [t.id, t]));
            const unknown = body.testIds.filter((x) => !byId.has(x));
            if (unknown.length) throw new HttpError(400, `Unknown test: ${unknown[0]}`);
            chosen = [...new Set(body.testIds)].map((x) => byId.get(x)!);
        }
        // A test that is stored but cannot be executed by anything here is named, not silently left out (the job would only skip it too).
        const skipped: Array<{ id: string; testId: string; reason: string }> = [];
        const willRun = chosen.filter((t) => {
            if (hasAdapter(t.framework) && !getAdapter(t.framework).executable) {
                skipped.push({ id: t.id, testId: t.testKey, reason: `${t.testKey} is stored but this platform cannot execute it.` });
                return false;
            }
            return true;
        });
        if (willRun.length === 0) throw new HttpError(422, chosen.length ? `None of these tests can run here. ${skipped[0]!.reason}` : "There are no tests to run yet.", { skipped });
        const application = await ctx.applicationFor(id);
        // Right before creating the job, with no await in between (one active job per project).
        await ctx.assertNoActiveJob(id);
        const variants = body.variants?.length ? normalizeVariants(body.variants) : undefined;
        const job = await repo.createJob(id, application.id, {
            ...DEFAULT_JOB_OPTIONS,
            mode: "validate",
            testIds: willRun.map((t) => t.id),
            ...(body.retryFailures ? { retryFailures: body.retryFailures } : {}),
            ...(variants ? { variants } : {}),
        });
        return reply.code(202).send({ jobId: job.id, status: job.status, testCount: willRun.length, tests: willRun.map((t) => ({ id: t.id, testId: t.testKey })), skipped });
    });

    /** One run, test by test (see run-view.ts for what each state means and what it cannot say). */
    app.get("/api/projects/:id/runs/:jobId", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        ctx.project(id);
        const job = repo.getJob(jobId);
        if (!job || job.projectId !== id) throw new HttpError(404, "Run not found");
        return { job: ctx.publicJob(job), ...buildRunDetail(repo, job) };
    });
}
