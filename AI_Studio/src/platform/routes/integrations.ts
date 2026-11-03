import { z } from "zod";
import { defaultAdapterFor } from "../../engine/frameworks/index.js";
import { assessSeverity } from "../../engine/validation/severity.js";
import { HttpError } from "../http-error.js";
import { blockView } from "../block-store.js";
import { evidenceSentence } from "../evidence-read.js";
import { buildIssueDraft } from "../issues/content.js";
import { TrackerError } from "../issues/http.js";
import { IntegrationStore, providerFor, splitSettings } from "../issues/store.js";
import { IntegrationSettings, NotionDatabaseId } from "../issues/types.js";
import { assertAllowedTarget } from "../net-guard.js";
import { cachedTopIssue } from "../sentry/related.js";
import { DEFAULT_JOB_OPTIONS } from "../repo.js";
import { SecretBox } from "../secrets.js";
import { sharedOrigin, sharedRowMessage } from "../shared-integrations.js";
import { EnvironmentChoice, startEnvironmentRun } from "./environments.js";
import { NEW_SECRET_NEEDED } from "./shared-integrations.js";
import type { RouteCtx } from "./types.js";

/**
 * Routes for the "integrations" feature: issue-tracker connections (GitHub, Jira), creating issues from
 * findings, and the CI entry point the `ai-test` command uses to re-run a project's tests.
 */
export function registerIntegrationRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    // Same key as the repository's own SecretBox (derived from SECRET_KEY or the data dir's key file).
    const store = new IntegrationStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));

    /** Upstream failures are reported as 502 with a plain sentence and a machine-readable code. */
    const upstream = (e: unknown): never => {
        if (e instanceof TrackerError) throw new HttpError(502, e.message, { code: e.code, upstreamStatus: e.upstreamStatus });
        throw e;
    };

    const integration = (id: string) => {
        const i = store.get(id);
        if (!i) throw new HttpError(404, "Issue tracker connection not found");
        return i;
    };
    /** A connection shared from Integrations is changed and removed there, never from one project. */
    const notShared = (id: string) => {
        const origin = sharedOrigin(p.db, id);
        if (origin) throw new HttpError(409, sharedRowMessage(origin.name), { code: "shared_integration", integrationId: origin.integrationId });
    };

    /** Settings are checked against the outbound-URL guard when saved, and again on every call. */
    const guardUrls = async (s: { kind: string; apiUrl?: string; baseUrl?: string }) => {
        const url = s.kind === "github" || s.kind === "notion" ? s.apiUrl : s.baseUrl;
        if (url) await assertAllowedTarget(url);
    };

    // ── connections ────────────────────────────────────────────────────────────
    app.get("/api/projects/:id/integrations", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return store.list(id);
    });

    const CreateExtras = z.object({ name: z.string().max(120).optional(), verify: z.boolean().default(true) });
    app.post("/api/projects/:id/integrations", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const settings = IntegrationSettings.parse(req.body);
        const extras = CreateExtras.parse(req.body ?? {});
        await guardUrls(settings);
        // Prove the credentials before saving them, so a typo is caught here and not at the first issue.
        if (extras.verify) {
            const { config, token } = splitSettings(settings);
            try {
                await providerFor(config, token).verify();
            } catch (e) {
                upstream(e);
            }
        }
        return reply.code(201).send(store.create(id, settings, extras.name));
    });

    const UpdateSchema = z.object({
        name: z.string().max(120).optional(),
        token: z.string().min(1).max(500).optional(),
        owner: z.string().min(1).max(100).optional(),
        repo: z.string().min(1).max(100).optional(),
        apiUrl: z.string().url().max(300).optional(),
        baseUrl: z.string().url().max(300).optional(),
        projectKey: z.string().min(1).max(20).optional(),
        email: z.string().email().max(200).optional(),
        issueType: z.string().min(1).max(60).optional(),
        databaseId: NotionDatabaseId.optional(),
        titleProperty: z.string().trim().min(1).max(100).optional(),
    });
    app.patch("/api/integrations/:id", async (req) => {
        const { id } = req.params as { id: string };
        const cur = integration(id);
        notShared(id);
        const b = UpdateSchema.parse(req.body);
        const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => (b as Record<string, unknown>)[k] !== undefined).map((k) => [k, (b as Record<string, unknown>)[k]]));
        const config = cur.kind === "github" ? pick(["owner", "repo", "apiUrl"]) : cur.kind === "notion" ? pick(["databaseId", "titleProperty", "apiUrl"]) : pick(["baseUrl", "projectKey", "email", "issueType"]);
        if (typeof config.projectKey === "string") config.projectKey = config.projectKey.toUpperCase();
        // The stored token is only sent where it was entered for: a new address needs it again.
        const was = { ...(cur.kind === "github" ? { apiUrl: "https://api.github.com" } : cur.kind === "notion" ? { apiUrl: "https://api.notion.com" } : {}), ...(cur.config as { apiUrl?: string; baseUrl?: string }) };
        const moved = (["apiUrl", "baseUrl"] as const).some((k) => typeof config[k] === "string" && String(config[k]).replace(/\/+$/, "") !== String(was[k] ?? "").replace(/\/+$/, ""));
        if (moved && !b.token) throw new HttpError(400, NEW_SECRET_NEEDED);
        await guardUrls({ kind: cur.kind, ...(config as { apiUrl?: string; baseUrl?: string }) });
        return store.update(id, { name: b.name, token: b.token, config })!;
    });

    app.delete("/api/integrations/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        integration(id);
        notShared(id);
        store.remove(id);
        return reply.code(204).send();
    });

    /** A real call to the tracker. A failed check is an answer, not a server error. */
    app.post("/api/integrations/:id/test", async (req) => {
        const { id } = req.params as { id: string };
        integration(id);
        try {
            return { ok: true, message: await store.provider(id)!.verify() };
        } catch (e) {
            if (e instanceof TrackerError) return { ok: false, code: e.code, message: e.message };
            throw e;
        }
    });

    // ── issues from findings ───────────────────────────────────────────────────
    const getTest = (id: string) => {
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return t;
    };

    app.get("/api/tests/:id/issues", async (req) => store.linksForTest(getTest((req.params as { id: string }).id).id));

    /** Requests in flight per test + integration: a double click must not create two issues. */
    const inFlight = new Map<string, Promise<unknown>>();

    app.post("/api/tests/:id/issue", async (req, reply) => {
        const t = getTest((req.params as { id: string }).id);
        const { integrationId } = z.object({ integrationId: z.string().min(1) }).parse(req.body);
        const conn = store.get(integrationId);
        if (!conn || conn.projectId !== t.projectId) throw new HttpError(404, "Issue tracker connection not found for this project");
        if (t.validationStatus !== "NEEDS_REVIEW" && t.validationStatus !== "FAILED_VALIDATION") {
            throw new HttpError(422, "Issues can only be created for a test that found something or could not be made to pass.");
        }
        const existing = store.linkFor(t.id, integrationId);
        if (existing) return reply.code(200).send({ link: existing, existing: true });

        const key = `${t.id}:${integrationId}`;
        const pending = inFlight.get(key);
        if (pending) {
            await pending.catch(() => undefined);
            const made = store.linkFor(t.id, integrationId);
            if (made) return reply.code(200).send({ link: made, existing: true });
        }
        const work = (async () => {
            const last = repo.listExecutions(t.id)[0] as { status: string; startedAt: string; durationMs: number | null; steps: Array<{ index: number; status: string }> } | undefined;
            const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/+$/, "");
            const draft = buildIssueDraft({
                testKey: t.testKey,
                title: t.title,
                suite: t.suite,
                // The steps that ran (reusable steps put in place): the run's step numbers, and so "failed here", follow them.
                spec: blockView(repo.db, t.projectId)(t.spec),
                validationStatus: t.validationStatus as "NEEDS_REVIEW" | "FAILED_VALIDATION",
                reason: t.validationReason,
                severity: assessSeverity(t.spec, t.validationStatus, t.validationReason),
                stepResults: last?.steps ?? [],
                lastRun: last ? { status: last.status, startedAt: last.startedAt, durationMs: last.durationMs } : undefined,
                appUrl: repo.getLatestApplicationPublic(t.projectId)?.url as string | undefined,
                testUrl: `${base}/#/tests/${t.id}`,
                evidenceSummary: await evidenceSentence(repo, ctx.p.store, t.id),
                relatedSentry: cachedTopIssue(repo, t.id),
            });
            try {
                const issue = await store.provider(integrationId)!.createIssue(draft);
                return store.addLink({ testId: t.id, integrationId, provider: conn.kind, externalId: issue.externalId, url: issue.url, title: draft.title });
            } catch (e) {
                return upstream(e);
            }
        })();
        inFlight.set(key, work);
        try {
            return reply.code(201).send({ link: await work, existing: false });
        } finally {
            inFlight.delete(key);
        }
    });

    // ── CI: re-run a project's tests ───────────────────────────────────────────
    const CiCredentials = z
        .object({ username: z.string().max(300).optional(), password: z.string().max(300).optional(), apiToken: z.string().max(4000).optional(), apiAuthHeader: z.string().max(4000).optional() })
        .optional();
    /**
     * Validate every executable test of a project against an address (what `ai-test run --server` does after
     * importing specs). Mobile tests need an emulator and are left alone. Credentials, when given, are stored
     * encrypted on a new application record like any other run.
     */
    app.post("/api/projects/:id/validation", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ baseUrl: z.string().url().optional(), apiBaseUrl: z.string().url().optional(), credentials: CiCredentials, ...EnvironmentChoice.shape }).parse(req.body ?? {});
        const tests = repo.listTests(id).filter((t) => t.kind !== "mobile" && t.kind !== "desktop" && defaultAdapterFor(t.spec.kind).executable);
        if (tests.length === 0) throw new HttpError(422, "This project has no tests that can be run yet.");
        // Against a named environment (staging, production...): its own address, credentials and variables; results are stored for it.
        if (body.environment) {
            const started = await startEnvironmentRun({ repo, p: ctx.p, applicationFor: (pid) => ctx.applicationFor(pid), assertNoActiveJob: ctx.assertNoActiveJob }, id, tests, body.environment, body.confirmProduction);
            return reply.code(202).send({ ...started, testCount: started.testCount });
        }
        await ctx.assertNoActiveJob(id);
        let application: { id: string; url: string };
        const hasCredentials = Boolean(body.credentials && Object.keys(body.credentials).length);
        if (hasCredentials || body.apiBaseUrl) {
            const latest = repo.getLatestApplicationPublic(id);
            const url = body.baseUrl ?? (latest?.url as string | undefined);
            if (!url) throw new HttpError(400, "This project has no application yet; provide baseUrl");
            await assertAllowedTarget(url);
            if (body.apiBaseUrl) await assertAllowedTarget(body.apiBaseUrl);
            const apiBaseUrl = body.apiBaseUrl ?? latest?.config?.apiBaseUrl;
            const kept = { ...DEFAULT_JOB_OPTIONS, ...(apiBaseUrl ? { apiBaseUrl } : {}) };
            application = { id: repo.createApplication(id, url, kept, hasCredentials ? body.credentials : undefined), url };
        } else {
            application = await ctx.applicationFor(id, body.baseUrl);
        }
        const job = await ctx.startValidationJob(id, application.id, tests.map((t) => t.id));
        return reply.code(202).send({ jobId: job.id, testCount: tests.length });
    });
}
