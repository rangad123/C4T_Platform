import { CustomScriptStore } from "../custom-script-store.js";
import { z } from "zod";
import { detectKind, NO_MODEL_MESSAGE, PLAIN_MAX_LENGTH, PLAIN_MIN_LENGTH, PLAIN_ORIGIN, refusalFor } from "../../engine/authoring/describe.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { environmentFor } from "../plain-run.js";
import { DEFAULT_JOB_OPTIONS } from "../repo.js";
import type { RouteCtx } from "./types.js";

/**
 * Plain-English test authoring routes (Builder T): describe a test in words, the platform builds it in a real browser (or from the
 * known API operations), runs it, and stores it. The work happens in a normal job of mode "plain" (see ../plain-run.ts).
 */

const Description = z.string().trim().min(PLAIN_MIN_LENGTH, "Describe the test in a few words.").max(PLAIN_MAX_LENGTH, `Keep the description under ${PLAIN_MAX_LENGTH} characters.`);
const EnvironmentName = z.string().trim().min(1).max(40);

const CreateBody = z.object({
    description: Description,
    kind: z.enum(["web", "api"]).optional(),
    /** A project environment to build the test on (never a production one). */
    environment: EnvironmentName.optional(),
    /** The application address, when the project has none yet. */
    baseUrl: z.string().trim().url().max(2000).optional(),
});
const RewriteBody = z.object({ description: Description, environment: EnvironmentName.optional() });

export function registerAuthoringRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;

    /** Everything that can be refused before a job exists, with plain words. Returns what the job needs. */
    async function prepare(projectId: string, body: { description: string; kind?: "web" | "api"; environment?: string; baseUrl?: string }, fixedKind?: "web" | "api") {
        const latest = repo.getLatestApplicationPublic(projectId);
        const allowChanges = latest?.config?.allowMutatingApiTests === true;
        const refused = refusalFor(body.description, { allowChanges });
        if (refused) throw new HttpError(422, refused, { refused: true });
        if (p.llm.modelName === "unavailable") throw new HttpError(422, NO_MODEL_MESSAGE, { modelMissing: true });

        let baseUrl = body.baseUrl;
        if (body.environment) {
            const { env } = await environmentFor(repo, p.config, projectId, body.environment);
            // A project that only has environments so far: the environment's address is the application.
            if (!latest && !baseUrl) baseUrl = env.baseUrl;
        }
        // Guards the address and creates the application row when a new address was given.
        const application = await ctx.applicationFor(projectId, baseUrl);
        if (application.url.startsWith("android-app://") || application.url.startsWith("ios-app://")) throw new HttpError(422, "Plain-English tests are built for web and API applications, not mobile apps.");
        // The test is written by exploring the page from THIS machine (even when its scripts later run on a runner agent), so the usual outbound guard applies.
        await assertAllowedTarget(application.url);

        const apis = repo.getLatestAppModel(projectId)?.apis ?? [];
        const kind = fixedKind ?? body.kind ?? detectKind(body.description, apis);
        if (kind === "api" && apis.length === 0) {
            throw new HttpError(422, "This project has no known API operations yet, so there is nothing to build an API test from. Run an analysis with the API description (OpenAPI) first, or describe a test of the pages instead.");
        }
        return { application, kind, allowChanges };
    }

    app.post("/api/projects/:id/plain-tests", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = CreateBody.parse(req.body);
        const { application, kind, allowChanges } = await prepare(id, body);
        // Right before creating the job, with no await in between (one active job per project).
        await ctx.assertNoActiveJob(id);
        const job = await repo.createJob(id, application.id, {
            ...DEFAULT_JOB_OPTIONS,
            mode: "plain",
            plainDescription: body.description,
            plainKind: kind,
            allowMutatingApiTests: allowChanges,
            ...(body.environment ? { environment: body.environment } : {}),
        });
        return reply.code(202).send({ jobId: job.id, status: job.status, kind });
    });

    /** Rebuild a plain-English test from a changed description: same test, same history, a new script version. */
    app.post("/api/tests/:id/plain-rewrite", async (req, reply) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        if (new CustomScriptStore(repo.db).isCustom(t.id)) throw new HttpError(409, "This is a code test, so it cannot be rebuilt from a description. Restore the generated version first, or edit the code.");
        if (t.spec.source.origin !== PLAIN_ORIGIN) throw new HttpError(422, "Only tests that were written in plain English can be rebuilt from a new description.");
        const body = RewriteBody.parse(req.body);
        const { application, kind, allowChanges } = await prepare(t.projectId, body, t.kind === "api" ? "api" : "web");
        await ctx.assertNoActiveJob(t.projectId);
        const job = await repo.createJob(t.projectId, application.id, {
            ...DEFAULT_JOB_OPTIONS,
            mode: "plain",
            plainDescription: body.description,
            plainKind: kind,
            rewriteTestId: t.id,
            allowMutatingApiTests: allowChanges,
            ...(body.environment ? { environment: body.environment } : {}),
        });
        return reply.code(202).send({ jobId: job.id, status: job.status, kind });
    });
}
