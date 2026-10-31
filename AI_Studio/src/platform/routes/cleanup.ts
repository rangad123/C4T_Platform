import { z } from "zod";
import { isAppUri } from "../../engine/desktop/target.js";
import { resolveApiToken } from "../../engine/api/oauth.js";
import { cleanupHeaders, deleteRecord } from "../../engine/cleanup/run.js";
import type { EngineContext } from "../../engine/context.js";
import { changesData } from "../../engine/environments/env.js";
import { blockView } from "../block-store.js";
import { CleanupStore, type LedgerRow } from "../cleanup-store.js";
import { environmentStore } from "../environment-run.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import type { RouteCtx } from "./types.js";

/**
 * Test-data cleanup routes: what the data-changing API tests created, what was removed and what was left behind.
 *
 *   GET  /api/projects/:id/cleanup            switch, whether any test changes data, the latest run (with items) and recent runs
 *   PUT  /api/projects/:id/cleanup/settings   { cleanupAfter } the project's switch
 *   POST /api/projects/:id/cleanup/retry      try the failed items of the latest run again, with the ids recorded then
 *   GET  /api/tests/:id/cleanup               what the latest run created for one test
 */

/** Longest a retry may take in one request; items not reached stay as they were and can be retried again. */
const RETRY_BUDGET_MS = 60_000;
const retrying = new Set<string>();

const isOrigin = (a: string, b: string | undefined): boolean => {
    if (!b) return false;
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
};

export function registerCleanupRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    const store = () => new CleanupStore(repo.db);
    const enabledFor = (projectId: string) => store().getEnabled(projectId) ?? true;

    app.get("/api/projects/:id/cleanup", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const s = store();
        const view = blockView(repo.db, id);
        const dataChanging = repo.listTests(id).filter((t) => t.spec.kind === "api" && changesData(view(t.spec))).length;
        return { enabled: enabledFor(id), dataChangingTests: dataChanging, latest: s.latestRun(id), runs: s.runs(id, 10) };
    });

    app.put("/api/projects/:id/cleanup/settings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ cleanupAfter: z.boolean() }).parse(req.body);
        store().setEnabled(id, body.cleanupAfter);
        return { enabled: body.cleanupAfter };
    });

    app.get("/api/tests/:id/cleanup", async (req) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        return { enabled: enabledFor(t.projectId), latest: store().latestForTest(t.id) };
    });

    app.post("/api/projects/:id/cleanup/retry", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        if (retrying.has(id)) throw new HttpError(409, "A retry is already running for this project.");
        const s = store();
        const rows = s.retryable(id);
        if (rows.length === 0) throw new HttpError(409, "Nothing to retry: the latest run has no record that failed to be removed.");
        // A running job may still be creating records; wait for it so the ledger and the application agree.
        await ctx.assertNoActiveJob(id);
        retrying.add(id);
        try {
            const started = Date.now();
            let removed = 0;
            let failedAgain = 0;
            let notReached = 0;
            const credentialsCache = new Map<string, Promise<{ headers: Record<string, string>; allowed: string[] } | { problem: string }>>();
            for (const row of rows) {
                if (Date.now() - started > RETRY_BUDGET_MS) {
                    notReached++;
                    continue;
                }
                const key = row.environment ?? "";
                if (!credentialsCache.has(key)) credentialsCache.set(key, resolveCredentials(ctx, id, row));
                const creds = await credentialsCache.get(key)!;
                if ("problem" in creds) {
                    s.update(row.id, "failed", creds.problem);
                    failedAgain++;
                    continue;
                }
                if (!row.origin || !creds.allowed.some((o) => isOrigin(row.origin!, o))) {
                    s.update(row.id, "failed", "The recorded address is outside the application, so it was not touched.");
                    failedAgain++;
                    continue;
                }
                const r = await deleteRecord({ apiBaseUrl: row.origin, deletePath: row.deletePath!, headers: creds.headers, guard: assertAllowedTarget });
                s.update(row.id, r.status, r.reason);
                if (r.status === "failed") failedAgain++;
                else removed++;
            }
            return { retried: rows.length - notReached, removed, failedAgain, notReached, latest: s.latestRun(id) };
        } finally {
            retrying.delete(id);
        }
    });

    /** The credentials the run used for this record's address: the application's, or the named environment's. */
    async function resolveCredentials(c: RouteCtx, projectId: string, row: LedgerRow): Promise<{ headers: Record<string, string>; allowed: string[] } | { problem: string }> {
        if (row.environment) {
            const envs = environmentStore(c.repo, c.p.config);
            const env = envs.get(projectId, row.environment);
            if (!env) return { problem: `The environment “${row.environment}” no longer exists, so it was not touched.` };
            // Production is read-only: whatever was recorded there, nothing is sent to it from here.
            if (env.production) return { problem: "Production is read-only, so nothing is deleted there." };
            const secrets = envs.secretsOf(env);
            return { headers: cleanupHeaders({ apiToken: secrets?.apiToken, apiAuthHeader: secrets?.apiAuthHeader }), allowed: [env.baseUrl, env.apiBaseUrl].filter((x): x is string => Boolean(x)) };
        }
        const job = c.repo.getJob(row.jobId);
        const applicationId = job?.applicationId ?? (c.repo.getLatestApplicationPublic(projectId)?.id as string | undefined);
        const application = applicationId ? c.repo.getApplication(applicationId) : undefined;
        if (!application || application.projectId !== projectId) return { problem: "The application this run used no longer exists, so the credentials are not known." };
        // Same token the run used; an OAuth2 client gets a fresh one (the old one has expired).
        const token = await resolveApiToken({ emit: () => undefined } as unknown as EngineContext, application.credentials);
        const allowed = [application.url, application.config.apiBaseUrl as string | undefined, job?.options.apiBaseUrl].filter((x): x is string => Boolean(x) && !isAppUri(x!));
        return { headers: cleanupHeaders({ apiToken: token, apiAuthHeader: application.credentials?.apiAuthHeader }), allowed };
    }
}
