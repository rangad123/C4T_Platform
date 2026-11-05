import { z } from "zod";
import { EXTRA_VARIANT_IDS, normalizeVariants, publicVariants, variantEligibility, detectBrowsers, variantAvailability, type ExtraVariantId } from "../../engine/validation/variants.js";
import { HttpError } from "../http-error.js";
import { DEFAULT_JOB_OPTIONS, type Repo, type TestRow } from "../repo.js";
import { refuseUnlessRunsStart } from "../suite-run.js";
import { compatibilityFor, compatForProject, type CompatBrief } from "../variants-store.js";
import type { RouteCtx } from "./types.js";

/** Routes for the "variants" feature: re-run validated web tests on other browsers and screen sizes. */

const VariantsSchema = z.object({ variants: z.array(z.enum(EXTRA_VARIANT_IDS)).min(1, "Choose at least one browser or screen size").max(EXTRA_VARIANT_IDS.length) });
const ProjectBody = VariantsSchema.extend({ testIds: z.array(z.string().min(1).max(100)).max(2000).optional() });

/** The `variants` field of a generation request (the job runs them after the main validation). Validated here, used by the core route. */
export const JobVariantsSchema = z.array(z.enum(EXTRA_VARIANT_IDS)).max(EXTRA_VARIANT_IDS.length);

/** Added to GET /api/config: which browsers exist on this machine, and the variants with whether each can run here. */
export function variantsConfig() {
    const browsers = detectBrowsers();
    return { browsers, variants: publicVariants(browsers) };
}

/** Added to GET /api/tests/:id: the matrix (newest result per variant) and why a test may not be eligible. */
export function testCompatibility(repo: Repo, t: TestRow) {
    const compat = compatibilityFor(repo.db, t.id);
    const base = (repo.listExecutions(t.id)[0] as { startedAt: string } | undefined)?.startedAt;
    const compatibility = Object.fromEntries(
        Object.entries(compat)
            // A result recorded before the test's latest main run may describe an older version of the test.
            .map(([variant, e]) => [variant, { ...e, stale: Boolean(base && base > e.ranAt) }]),
    );
    const e = variantEligibility(t.spec, t.validationStatus);
    return { compatibility, variantCheck: e.eligible ? { eligible: true } : { eligible: false, reason: e.reason } };
}

/** Added to GET /api/projects/:id/tests: a compact per-test summary (failing variants), null when never checked. */
export function projectCompat(repo: Repo, projectId: string): (testDbId: string) => CompatBrief | null {
    const map = compatForProject(repo.db, projectId);
    return (id) => map.get(id) ?? null;
}

export function registerVariantRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;

    /** Queue one compatibility job. `candidates` are the tests the user asked about; ineligible ones are reported, not silently dropped. */
    async function queue(projectId: string, candidates: TestRow[], variants: ExtraVariantId[]) {
        refuseUnlessRunsStart(ctx.p); // tests switched off on this server: nothing is queued
        const eligible: TestRow[] = [];
        const skipped: Array<{ id: string; testId: string; reason: string }> = [];
        for (const t of candidates) {
            const e = variantEligibility(t.spec, t.validationStatus);
            if (e.eligible) eligible.push(t);
            else skipped.push({ id: t.id, testId: t.testKey, reason: e.reason });
        }
        if (eligible.length === 0) {
            throw new HttpError(422, candidates.length ? `None of these tests can be checked on other browsers. ${skipped[0]!.reason}` : "There are no tests to check yet.", { skipped });
        }
        const application = await ctx.applicationFor(projectId);
        // Web tests that cannot be repeated are handed to the job too, so it records *why* next to each of them.
        const explained = skipped.filter((s) => candidates.find((c) => c.id === s.id)!.kind === "web").map((s) => s.id);
        // Right before creating the job, with no await in between (one active job per project).
        await ctx.assertNoActiveJob(projectId);
        const job = await repo.createJob(projectId, application.id, { ...DEFAULT_JOB_OPTIONS, mode: "variants", testIds: [...eligible.map((t) => t.id), ...explained], variants });
        const browsers = detectBrowsers();
        return {
            jobId: job.id,
            status: job.status,
            variants,
            tests: eligible.map((t) => ({ id: t.id, testId: t.testKey })),
            skipped,
            // Chosen variants this machine cannot run: they will be reported as "couldn't run", never as failures.
            unavailable: variants.map((v) => ({ variant: v, ...variantAvailability(v, browsers) })).filter((a) => !a.available).map((a) => ({ variant: a.variant, reason: a.reason! })),
        };
    }

    app.post("/api/projects/:id/variants", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = ProjectBody.parse(req.body);
        const all = repo.listTests(id);
        let candidates = all;
        if (body.testIds) {
            const byId = new Map(all.map((t) => [t.id, t]));
            const unknown = body.testIds.filter((x) => !byId.has(x));
            if (unknown.length) throw new HttpError(400, `Unknown test: ${unknown[0]}`);
            candidates = [...new Set(body.testIds)].map((x) => byId.get(x)!);
        }
        return reply.code(202).send(await queue(id, candidates, normalizeVariants(body.variants)));
    });

    app.post("/api/tests/:id/variants", async (req, reply) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        const body = VariantsSchema.parse(req.body);
        return reply.code(202).send(await queue(t.projectId, [t], normalizeVariants(body.variants)));
    });
}
