import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { zipSync, strToU8 } from "fflate";
import { z } from "zod";
import { REPO_ROOT } from "../config.js";
import { adapterForSpec, defaultAdapterFor, getAdapter, listAdapters, renderWithAdapter } from "../engine/frameworks/index.js";
import { iosSpecIssues } from "../engine/mobile/ios-spec.js";
import { allowedCredentialOrigins, credentialOriginProblems } from "../engine/spec/credential-origin.js";
import { interpolate, TEST_KINDS, TestSpecSchema, type TestSpec } from "../engine/spec/schema.js";
import type { Platform } from "./bootstrap.js";
import { extractDocumentText, RequirementsDocumentError } from "../engine/requirements/extract.js";
import { assessSeverity } from "../engine/validation/severity.js";
import { MobileTargetBase, MobileTargetSchema, type MobileTarget } from "../engine/mobile/target.js";
import { keptStartState, preparationProblem } from "../engine/mobile/state/clean-start.js";
import { keptPhoneSettings, phoneSettingsProblem, publicPhoneSettings } from "../engine/mobile/phone-settings.js";
import { AAB_REFUSAL, bundleSupport, convertBundle, looksLikeBundle } from "../engine/mobile/state/bundle.js";
import { mobileAvailability } from "../engine/mobile/toolchain.js";
import { localPhoneRunsProblem } from "../engine/mobile/device/choose.js";
import { DESKTOP_APP_URL, isAppUri } from "../engine/desktop/target.js";
import { desktopSpecIssues } from "../engine/desktop/spec.js";
import { complianceReport, FRAMEWORKS, mapControls, type Framework as ComplianceFramework } from "../engine/compliance/map.js";
import { hasScreenshotStep } from "../engine/visual/baseline.js";
import { storeScript } from "./repo-sink.js";
import { quarantineGate } from "./quarantine-store.js";
import type { QuarantineGate } from "../engine/quarantine/rules.js";
import { DEFAULT_JOB_OPTIONS, type JobRow, type JobOptions } from "./repo.js";
import { cancelSummary } from "./cancel-summary.js";
import { asExecutions, failureSummary, withFailureFacts } from "./failure-view.js";
import { assessProjectQuality } from "../engine/quality/rules.js";
import { HttpError } from "./http-error.js";
import { assertFrameworkLoaded, frameworkForImport, pluginStatusFor } from "./plugin-gate.js";
import { CustomScriptStore, customInfo, type CustomState } from "./custom-script-store.js";
import { GUARD_RULES } from "../engine/custom/guard.js";
import { MAX_SCRIPT_BYTES } from "../engine/custom/guard.js";
import { placeholderCanMoveAddress } from "../engine/spec/run-address.js";
import { assertAllowedTarget } from "./net-guard.js";
import { loadTargetProblem } from "./load-guard.js";
import { isLoadSpec, LOAD_MAX_ENDPOINTS, LOAD_MAX_REQUESTS } from "../engine/performance/load.js";
import { registerFeatureRoutes } from "./routes/index.js";
import { checkedAgentChoice, testingAgentsOf, withAgentChoice } from "./routes/testing-agents.js";
import { missingForExploration, missingInputsMessage, projectRequirementsDocument, savedInputsForExploration } from "./routes/agent-inputs.js";
import { JobVariantsSchema, projectCompat, testCompatibility, variantsConfig } from "./routes/variants.js";
import { dataDrivenSpecIssues, dataSetsFor, EnvironmentChoice, startEnvironmentRun, testEnvironmentInfo } from "./routes/environments.js";
import { exportObjectsUsedBy, importObjectsFor, objectsFor } from "./routes/locators.js";
import { tryResolveSpecRefs } from "../engine/locators/refs.js";
import { tryExpandBlocks } from "../engine/blocks/expand.js";
import { MAX_BLOCKS } from "../engine/blocks/model.js";
import { blocksFor, exportBlocksUsedBy, runStepsOf, withExpandedSpecs } from "./block-store.js";
import { qualityOfTest } from "./test-quality.js";
import { BlockService } from "./block-service.js";
import type { RouteCtx } from "./routes/types.js";
import { buildJunit } from "./reports/junit.js";
import { CleanupStore } from "./cleanup-store.js";
import { slugify } from "./storage.js";
import { localPathOf, putText } from "./object-store.js";
import { prunedMessage } from "../engine/retention/format.js";
import { redactTriggerUrl } from "./trigger-store.js";
import { redactStreamUrl } from "./stream-core.js";
import { EXPLORING_OFF_MESSAGE, IMPORTED_NOT_RUN, refuseUnlessRunsStart, runsCanStartHere } from "./suite-run.js";
import { agentCanRunIos, agentCanRunMobile, assertRunTarget, IOS_NEEDS_AGENT_MESSAGE, jobRanOn } from "./agent-services.js";
import { farmChosen } from "./device-farm-store.js";
import { assertPhoneExploration } from "./phone-explore.js";
import { localDeviceProblem } from "./agent-device.js";
import { watchState } from "./frame-hub.js";
import { FrameworkSettingsStore, turnedOffForSpecs } from "./framework-settings-store.js";
import { PROTOCOL_VERSION } from "../agent-protocol/schema.js";
import { actorOf, installAccessControl } from "./auth/access.js";
import { installRunnerChoice } from "./run-request.js";
import { actorLabel, isCrowd4TestActor, sideOf } from "./auth/actor.js";
import { sortedPermissions } from "./auth/permissions.js";
import { visibleProjectsOf } from "./auth/project-scope.js";
import { exportPath, portableFiles, type ExportScript } from "./portable-export.js";
import { c4tServiceOf, clientIpOf } from "./c4t-service.js";
import { NEW_PROJECT_TESTING_MODES, PlatformsSchema, TestingModesSchema } from "./project-setup.js";
import { AppDetailsBody, checkedAppDetails, registerProjectAppRoutes } from "./routes/project-app.js";
import { linkedC4tProject, parsePlain, withSetup } from "./routes/project-settings.js";
import { isProjectNameTaken, projectNameTaken } from "./project-folders.js";

const CredentialsSchema = z
    .object({
        username: z.string().max(300).optional(),
        password: z.string().max(300).optional(),
        apiToken: z.string().max(4000).optional(),
        apiAuthHeader: z.string().max(4000).optional(),
        /** Authenticator-app secret (base32; spaces allowed) for logins that ask for a one-time code. */
        totpSecret: z
            .string()
            .max(200)
            .regex(/^[A-Za-z2-7\s=-]+$/, "must be the base32 secret shown by the authenticator setup (letters A-Z and digits 2-7)")
            .optional(),
        oauth2: z
            .object({
                tokenUrl: z.string().url(),
                clientId: z.string().min(1).max(500),
                clientSecret: z.string().min(1).max(4000),
                scope: z.string().max(1000).optional(),
                audience: z.string().max(1000).optional(),
                authMethod: z.enum(["basic", "body"]).optional(),
            })
            .optional(),
    })
    .optional();

const GenerateSchema = z.object({
    /** The website or API address. Left out only when the project's own Android app is explored (targets: ["mobile"]). */
    url: z.string().url().optional(),
    credentials: CredentialsSchema,
    scope: z.string().max(500).optional(),
    includePaths: z.array(z.string().startsWith("/")).max(20).optional(),
    targets: z.array(z.enum(["web", "api", "mobile"])).min(1).optional(),
    maxPages: z.number().int().min(1).max(100).optional(),
    maxDepth: z.number().int().min(0).max(6).optional(),
    maxScenarios: z.number().int().min(1).max(100).optional(),
    allowMutatingApiTests: z.boolean().optional(),
    openApiUrl: z.string().url().optional(),
    apiBaseUrl: z.string().url().optional(),
    /** Generate axe-core accessibility audits for key pages (default true). */
    accessibility: z.boolean().optional(),
    /** Page health checks for key pages: script errors, failed requests, broken links (default true). */
    healthChecks: z.boolean().optional(),
    /** Passive, read-only security checks of the application origin (default true). */
    securityChecks: z.boolean().optional(),
    /** Page-speed checks for key pages (default false). */
    performanceChecks: z.boolean().optional(),
    /** Basic load check: up to 3 safe GET endpoints, up to 10 users at once, at most 300 requests each (default false; refused for production). */
    loadChecks: z.boolean().optional(),
    /** Lower limits for the load check, e.g. "p95:500 users:5 seconds:5"; the numbers are clamped to the caps. */
    loadBudgets: z.string().max(120).regex(/^[\w:.\s,;=-]*$/, "limits look like p95:500 errors:2 users:5 seconds:5").optional(),
    /** Check how search-type forms handle unusual input (default true). */
    inputChecks: z.boolean().optional(),
    /** AI judgement of screenshots by a vision-capable model (default false). */
    visionChecks: z.boolean().optional(),
    /** Check API responses against the documented schema (default true). */
    contractChecks: z.boolean().optional(),
    /** Access-control checks when the project has test accounts (default true). */
    accessChecks: z.boolean().optional(),
    /** Start from what earlier analyses learned about the application, and save what this one learns (default true). */
    useMemory: z.boolean().optional(),
    /** Send every page to the AI again, even pages unchanged since the last exploration (default false). */
    fullExploration: z.boolean().optional(),
    /** Remove the records that data-changing API tests create once the run ends (default true; also becomes the project's switch). */
    cleanupAfter: z.boolean().optional(),
    /** Budget overrides, e.g. "lcp:3000 weight:5000000 slow-4g". */
    performanceBudgets: z.string().max(200).regex(/^[\w:.\s,;=-]*$/, "budgets look like lcp:3000 cls:0.1 slow-4g").optional(),
    /** Capture visual-regression baselines for key pages (default false). */
    visual: z.boolean().optional(),
    /** Also re-run the tests that validate on these browsers / screen sizes (default none). */
    variants: JobVariantsSchema.optional(),
    /** Explore and plan only: the plan is kept for a person to look at and nothing is created or run (confirm it with POST /api/projects/:id/plans/:jobId/create). */
    plan: z.boolean().optional(),
    /** Requirements document (txt, md, pdf, docx) the generated tests should cover. */
    requirements: z
        .object({
            filename: z.string().min(1).max(200),
            // ~5 MB file after base64; the extractor enforces the real size limit.
            contentBase64: z.string().max(7_200_000),
        })
        .optional(),
});

/** An imported spec: canonical, except that the platform assigns the testId when it is omitted. */
const ImportedSpecSchema = TestSpecSchema.extend({ testId: TestSpecSchema.shape.testId.optional() });
type ImportedSpec = z.infer<typeof ImportedSpecSchema>;

const ImportSchema = z.object({
    /** Validated one by one below so every invalid spec is reported, not just the first. */
    specs: z.array(z.unknown()).min(1).max(500),
    baseUrl: z.string().url().optional(),
    apiBaseUrl: z.string().url().optional(),
    credentials: CredentialsSchema,
    validate: z.boolean().default(true),
});

const KEY_PREFIX: Record<TestSpec["kind"], string> = { web: "WEB", api: "API", mobile: "MOB", desktop: "DSK" };
const isExecutable = (kind: TestSpec["kind"]) => defaultAdapterFor(kind).executable;

/**
 * Imported specs are user input that the platform executes: every URL a step can reach must pass the
 * same SSRF guard as the application URL. Steps resolve against the base like the rendered scripts do
 * (`new URL(x, BASE_URL)`), so absolute and protocol-relative URLs are caught too.
 */
async function assertSpecTargets(spec: ImportedSpec, index: number, baseUrl: string, apiBaseUrl: string): Promise<void> {
    for (const [i, step] of spec.steps.entries()) {
        const raw = step.action === "navigate" ? step.url : step.action === "request" ? step.path : undefined;
        if (raw === undefined) continue;
        const value = interpolate(raw, spec.testData).trim();
        const where = `specs[${index}].steps[${i}]`;
        // A leading runtime placeholder could expand to any host; only allowed when private targets are allowed anyway.
        if (/^\{\{/.test(value) && process.env.BLOCK_PRIVATE_TARGETS === "true") throw new HttpError(400, `${where}: URL must not start with a runtime placeholder`);
        // So must one that could still change the scheme or the host (`f{{p}}`, `https://{{p}}.example/`, `/{{p}}`).
        if (placeholderCanMoveAddress(value) && process.env.BLOCK_PRIVATE_TARGETS === "true") throw new HttpError(400, `${where}: a runtime placeholder must come after the host in a URL`);
        const base = step.action === "navigate" ? baseUrl : apiBaseUrl;
        let target: URL;
        try {
            target = new URL(value, base);
        } catch {
            throw new HttpError(400, `${where}: invalid URL "${raw}"`);
        }
        if (target.origin === new URL(base).origin) continue;
        try {
            await assertAllowedTarget(target.href);
        } catch (e) {
            throw new HttpError(400, `${where}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

const publicJob = (j: JobRow) => ({
    jobId: j.id,
    projectId: j.projectId,
    status: j.status,
    mode: j.options.mode ?? "generate",
    trigger: j.options.trigger ?? "manual",
    scheduleId: j.options.scheduleId ?? null,
    runbookRunId: j.options.runbookRunId ?? null,
    environment: j.options.environment ?? null,
    // Only for an exploration that stops at a plan, and for creation that starts from one (see routes/plans.ts).
    ...(j.options.planOnly ? { planOnly: true } : {}),
    ...(j.options.fromPlan ? { fromPlan: j.options.fromPlan } : {}),
    ranOn: jobRanOn(j),
    // Whether a person can watch the browser of this job right now (the Explorer view, see routes/explorer.ts).
    canWatch: watchState(j).canWatch,
    deploy: j.options.trigger === "deploy" ? (j.options.deploy ?? {}) : null,
    progress: j.progress,
    counters: j.counters,
    testsGenerated: j.counters.testsGenerated,
    testsValidated: j.counters.testsValidated,
    testsFailedValidation: j.counters.testsFailedValidation,
    testsNeedingReview: j.counters.testsNeedingReview,
    error: j.error,
    // Only for a run that was cancelled: how many tests reached a result and how many did not run, and a sentence made from those facts.
    ...(cancelSummary(j) ? { cancelled: cancelSummary(j) } : {}),
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
});

export async function buildServer(p: Platform): Promise<FastifyInstance> {
    // A deploy-trigger token travels in the URL; whatever the logger writes about a request must not contain it.
    // With PUBLIC_URL the server stands behind a proxy on this machine: only that proxy is believed, so rate limits see each visitor, not 127.0.0.1.
    const app = Fastify({ logger: { level: process.env.LOG_LEVEL === "debug" ? "debug" : "warn", serializers: { req: (req: { method?: string; url?: string }) => ({ method: req.method, url: redactStreamUrl(redactTriggerUrl(req.url ?? "")) }) } }, bodyLimit: 8_000_000, ...(p.config.PUBLIC_URL?.trim() ? { trustProxy: "127.0.0.1" } : {}) });
    await app.register(cors, { origin: true });
    // Body-less POSTs (re-validate, accept baseline) often still carry `content-type: application/json`;
    // treat an empty JSON body as "no body" instead of Fastify's default 400.
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        const text = String(body);
        if (text.trim() === "") return done(null, undefined);
        try {
            done(null, JSON.parse(text));
        } catch {
            done(new HttpError(400, "Malformed JSON body"), undefined);
        }
    });

    app.setErrorHandler((err: any, _req, reply) => {
        if (err instanceof HttpError) return reply.code(err.status).send(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details });
        if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", details: err.issues });
        app.log.error(err);
        return reply.code(err.statusCode ?? 500).send({ error: err.statusCode && err.statusCode < 500 ? err.message : "Internal server error" });
    });

    // ── access: the access key (owner level), people's sessions and API tokens, roles per route (auth/access.ts) ──
    // Registered before any route, so it also sees every route as it is added (the route-to-role table test reads that list).
    // Trigger, runner, stream-ticket and health routes keep their own credentials exactly as before.
    const access = installAccessControl(app, p);
    // The runner a person chose for one run (`runnerId` in a run-start body), read before any route checks its body (run-request.ts).
    installRunnerChoice(app);

    const repo = p.repo;
    const project = (id: string) => {
        const row = repo.getProject(id);
        if (!row) throw new HttpError(404, "Project not found");
        return row;
    };

    // ── meta ───────────────────────────────────────────────────────────────────
    app.get("/api/health", async () => ({ status: "ok" }));
    app.get("/api/config", async () => ({
        llm: { provider: p.config.LLM_PROVIDER, model: p.llm.modelName, configured: p.llm.modelName !== "unavailable" },
        authRequired: Boolean(p.config.API_KEY),
        // Whether a run or an exploration started now would start (suite-run.ts): false while tests are switched off on this server.
        runsHere: runsCanStartHere(p).ok,
        // "local": tests run here or on a runner, per project; "runners": only on runners, and nothing runs on this server (runner-only.ts).
        executionMode: p.config.EXECUTION_MODE,
        frameworks: listAdapters().map((a) => ({ framework: a.id, kind: a.kinds[0]!, executable: a.executable })),
        adapters: listAdapters().map((a) => a.describe()),
        defaults: DEFAULT_JOB_OPTIONS,
        mobile: mobileAvailability(),
        // AI phone exploration: whether the phone can be reached from this computer (a runner is judged per project, on the Runners page).
        phoneExploration: { thisServer: localDeviceProblem() ? { canExplore: false, reason: localDeviceProblem()! } : { canExplore: true, reason: null } },
        agentProtocol: PROTOCOL_VERSION,
        ...variantsConfig(),
        // Hand-written tests: whether this server runs them, and the rules the editor shows (platform/custom-policy.ts, engine/custom/guard.ts).
        // `platform` is the effective value; `reason` says why a requested switch is not in force (no API_KEY), see config.ts.
        // Adapter plug-ins (platform/plugin-gate.ts, engine/frameworks/plugin-loader.ts): the switch as asked for and as in force, what loaded, and what did not and why (plug-in names, never server paths).
        adapterPlugins: pluginStatusFor(p.config),
        customScripts: { platform: p.config.ALLOW_CUSTOM_SCRIPTS === true, ...(p.config.customScriptsReason ? { reason: p.config.customScriptsReason } : {}), maxBytes: MAX_SCRIPT_BYTES, guard: GUARD_RULES },
    }));

    // ── projects ───────────────────────────────────────────────────────────────
    /**
     * A new project belongs to an organization (D-14): a customer's own, always; staff may name one (`organizationId`, the Crowd4Test
     * organisation id); a local install has none. A Crowd4Test account that creates a project becomes its first member and Project
     * Admin (people with access to all projects reach it anyway).
     */
    const ProjectListQuery = z.object({
        archived: z.string().max(20).optional(),
        q: z.string().max(200, "Search for at most 200 characters.").optional(),
        folder: z.string().max(64).optional(),
        limit: z.coerce.number({ error: "limit is a number from 1 to 100." }).int().min(1, "limit is a number from 1 to 100.").max(100, "limit is a number from 1 to 100.").optional(),
        offset: z.coerce.number({ error: "offset is a whole number, 0 or more." }).int().min(0, "offset is a whole number, 0 or more.").optional(),
    });
    app.post("/api/projects", async (req, reply) => {
        const body = z
            .object({
                // Round 37: the name is always typed by the person; it is never made from the application's address.
                name: z.string().trim().min(1, "Give the project a name.").max(120, "A project name is at most 120 characters."),
                description: z.string().max(1000).optional(),
                organizationId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "An organization id is letters, digits, - and _ (at most 64).").optional(),
            })
            .parse(req.body);
        // Platforms and testing modes (US-010): one of each (round 37). Left out, web and agent mode, so older clients (CLI, MCP) keep working.
        const setup = parsePlain(z.object({ platforms: PlatformsSchema.optional(), testingModes: TestingModesSchema.optional() }), req.body);
        // The app by platform (routes/project-app.ts): checked before anything is created, saved right after.
        const appDetails = await checkedAppDetails(parsePlain(AppDetailsBody, req.body));
        // The testing agents (routes/testing-agents.ts): checked before anything is created, saved right after. Left out: none saved.
        const agentChoice = checkedAgentChoice(req.body, setup.platforms, setup.testingModes ?? NEW_PROJECT_TESTING_MODES);
        const actor = actorOf(req);
        let organizationId = body.organizationId ?? null;
        if (actor && sideOf(actor) === "customer") {
            if (!actor.organizationId) throw new HttpError(403, "Your Crowd4Test account is not part of an organisation, so it cannot create projects. Ask your Crowd4Test administrator.");
            if (organizationId && organizationId !== actor.organizationId) throw new HttpError(403, "You can create projects in your own organisation only.");
            organizationId = actor.organizationId;
        } else if (organizationId) {
            // Staff (and the access key) choose the organisation: with Crowd4Test's service, it must exist there and be active.
            const service = c4tServiceOf(p);
            const org = service ? await service.organisation(organizationId, clientIpOf(req)) : undefined;
            if (service && !org) throw new HttpError(404, "Crowd4Test has no organisation with that id.");
            if (org && org.status && org.status !== "ACTIVE") throw new HttpError(409, `That organisation is ${org.status.toLowerCase()} on Crowd4Test, so projects cannot be created in it.`);
            if (org) {
                access.projects.store.ensureOrganization(org.id);
                access.projects.store.recordOrganization(org.id, org.name, org.status);
            }
        }
        const scope = access.projects;
        // One name per organisation (archived projects count too), so people can tell their projects apart (project-folders.ts).
        const name = body.name;
        if (isProjectNameTaken(p.db, name, organizationId)) throw new HttpError(409, projectNameTaken(name));
        const made = repo.createProject({ name, description: body.description, platforms: setup.platforms, testingModes: setup.testingModes ?? NEW_PROJECT_TESTING_MODES });
        const id = made.id as string;
        if (organizationId) scope.store.setProjectOrganization(id, organizationId);
        if (actor && isCrowd4TestActor(actor) && actor.id) scope.store.addMember(id, actor.id, { role: actor.role, projectAdmin: true, source: "creator", addedBy: actorLabel(actor) });
        await projectApp.apply(id, appDetails);
        if (agentChoice) await testingAgentsOf(p).set(id, agentChoice, actor ? actorLabel(actor) : null);
        return reply.code(201).send(withSetup(organizationId ? repo.getProject(id)! : made));
    });
    // A person limited to some projects sees only those (auth/project-scope.ts).
    // Archived projects are left out unless `?archived=include` asks for them (project-folders.ts).
    // Round 37: `q` (name or address), `folder` (a folder id, or "none") and paging (`limit`, `offset`). With `limit` or `offset` the
    // answer is { projects, total, limit, offset }; without either it is the plain list, as before.
    app.get("/api/projects", async (req) => {
        const visible = visibleProjectsOf(req, actorOf(req));
        const query = parsePlain(ProjectListQuery, req.query);
        const needle = query.q?.trim().toLowerCase();
        const rows = (visible ? repo.listProjects().filter((r) => visible.has(r.id as string)) : repo.listProjects())
            .filter((r) => query.archived === "include" || !r.archived_at)
            .filter((r) => !query.folder || (query.folder === "none" ? !r.folder_id : r.folder_id === query.folder))
            .filter((r) => !needle || `${String(r.name ?? "")} ${String(r.url ?? "")}`.toLowerCase().includes(needle));
        if (query.limit === undefined && query.offset === undefined) return rows.map(withSetup);
        const limit = query.limit ?? 20;
        const offset = query.offset ?? 0;
        return { projects: rows.slice(offset, offset + limit).map(withSetup), total: rows.length, limit, offset };
    });
    app.get("/api/projects/:id", async (req) => {
        const { id } = req.params as { id: string };
        const jobs = repo.listJobs(id);
        const actor = actorOf(req);
        // What the asker may do here (the page shows and hides actions by it; every route checks it again): the codes that count in
        // this project, and whether they are its Project Admin (who approves, with ai_studio.tests.approve).
        const here = actor ? access.projects.permissionsIn(actor, id) : undefined;
        const accessHere = { projectAdmin: actor ? access.projects.isProjectAdmin(actor, id) : false, permissions: here ? sortedPermissions(here) : [] };
        const row = project(id);
        // The linked Crowd4Test project (US-011): a reference only, from the service's 5-minute cache.
        const c4tProject = await linkedC4tProject(p, row, clientIpOf(req));
        return { ...withSetup(row), c4tProject, application: publicApplication(repo.getLatestApplicationPublic(id)), mobile: publicMobile(latestMobile(id)), latestJob: jobs[0] ? publicJob(jobs[0]) : null, suites: repo.listSuites(id), access: accessHere };
    });

    /** The app mobile tests run against, from the project's latest application. */
    const latestMobile = (projectId: string): MobileTarget | undefined => {
        const m = repo.getLatestApplicationPublic(projectId)?.config?.mobile;
        const parsed = MobileTargetSchema.safeParse(m);
        return parsed.success ? parsed.data : undefined;
    };
    /** Never expose the server's file paths to the browser. */
    const publicMobile = (m: MobileTarget | undefined) => (m ? { appPackage: m.appPackage ?? null, apk: m.apkPath ? path.basename(m.apkPath) : null, avd: m.avd ?? null, ...(m.iosBundleId ? { iosBundleId: m.iosBundleId } : {}), ...(m.simulator ? { simulator: m.simulator } : {}), ...(m.cleanStart ? { cleanStart: true } : {}), ...(m.grantPermissions?.length ? { grantPermissions: m.grantPermissions } : {}), ...(m.startupBudgetMs !== undefined ? { startupBudgetMs: m.startupBudgetMs } : {}), ...publicPhoneSettings(m), ...(m.appActivity ? { appActivity: m.appActivity } : {}) } : null);
    const publicApplication = (a: ReturnType<typeof repo.getLatestApplicationPublic>) => {
        if (!a) return null;
        const { mobile: _mobile, ...config } = (a.config ?? {}) as Record<string, unknown>;
        return { ...a, config };
    };

    /** One active job per project. Await it right before creating the job: nothing but this check and the job's gates may run in between. */
    const assertNoActiveJob = async (projectId: string) => {
        const active = repo.listJobs(projectId).find((j) => !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status));
        if (active) throw new HttpError(409, `Job ${active.id} is still ${active.status}; wait for it to finish or cancel it`);
    };

    // ── generation jobs ────────────────────────────────────────────────────────
    app.post("/api/projects/:id/test-generation", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body0 = GenerateSchema.parse(req.body);
        refuseUnlessRunsStart(p, EXPLORING_OFF_MESSAGE); // tests switched off on this server: said before anything is saved or queued
        // The AI explores the project's Android app on a phone or emulator: checked now, in plain words, before a job is queued.
        const wantsPhone = body0.targets?.includes("mobile") === true;
        if (wantsPhone) assertPhoneExploration(id, latestMobile(id));
        const phoneOnly = wantsPhone && body0.targets!.every((t) => t === "mobile");
        const phoneUrl = phoneOnly ? `android-app://${latestMobile(id)!.appPackage}` : undefined;
        if (!body0.url && !phoneUrl) throw new HttpError(400, "Give the address of the website or API to test");
        // What the request leaves out comes from the inputs saved on the Requirements tab (routes/agent-inputs.ts), on the same site only;
        // saved credentials never go to an API address or OpenAPI document nobody saved them for (409). Exploring never changes them.
        const saved = savedInputsForExploration(p, id, (body0.url ?? phoneUrl)!, body0);
        const body = { ...body0, url: (body0.url ?? phoneUrl)!, credentials: body0.credentials ?? saved.credentials, openApiUrl: body0.openApiUrl ?? saved.openApiUrl, allowMutatingApiTests: body0.allowMutatingApiTests ?? saved.allowMutatingApiTests };
        if (!phoneOnly) await assertAllowedTarget(body.url);
        if (body.openApiUrl) await assertAllowedTarget(body.openApiUrl);
        if (body.apiBaseUrl) await assertAllowedTarget(body.apiBaseUrl);
        if (body.credentials?.oauth2) await assertAllowedTarget(body.credentials.oauth2.tokenUrl);
        if (body.loadChecks === true && (body.targets ?? ["web", "api"]).includes("api") && !phoneOnly) {
            // Load is only ever sent to an address the platform allows and that is not a production environment of this project.
            const refused = await loadTargetProblem(repo.db, id, [body.apiBaseUrl, body.url]);
            if (refused) throw new HttpError(409, refused);
        }
        await assertNoActiveJob(id);

        const asked: JobOptions = {
            ...DEFAULT_JOB_OPTIONS,
            ...(body.plan ? { planOnly: true } : {}),
            ...Object.fromEntries(Object.entries({ scope: body.scope, includePaths: body.includePaths, targets: body.targets, maxPages: body.maxPages, maxDepth: body.maxDepth, maxScenarios: body.maxScenarios, allowMutatingApiTests: body.allowMutatingApiTests, openApiUrl: body.openApiUrl, apiBaseUrl: body.apiBaseUrl, accessibility: body.accessibility, healthChecks: body.healthChecks, securityChecks: body.securityChecks, performanceChecks: body.performanceChecks, loadChecks: body.loadChecks, loadBudgets: body.loadBudgets, inputChecks: body.inputChecks, visionChecks: body.visionChecks,contractChecks: body.contractChecks, accessChecks: body.accessChecks, useMemory: body.useMemory, fullExploration: body.fullExploration, cleanupAfter: body.cleanupAfter, performanceBudgets: body.performanceBudgets, visual: body.visual, variants: body.variants?.length ? body.variants : undefined }).filter(([, v]) => v !== undefined)),
        } as JobOptions;
        // The project's chosen testing agents decide which checks run (routes/testing-agents.ts); a project with none saved runs as asked.
        const options = await withAgentChoice(p, project(id), asked, body);
        // The chosen agents' mandatory inputs (routes/agent-inputs.ts): refused in the words the Explore page's pop-up uses. No saved choice, no refusal.
        const missing = await missingForExploration(p, project(id), { openApiUrl: body.openApiUrl }, options.targets);
        if (missing.length) throw new HttpError(409, missingInputsMessage(missing));
        if (body.requirements) {
            // Convert at submit time so an unreadable document is rejected now, not mid-job.
            try {
                options.requirementsText = await extractDocumentText({ name: body.requirements.filename, data: Buffer.from(body.requirements.contentBase64, "base64") });
                options.requirementsName = body.requirements.filename;
            } catch (e) {
                if (e instanceof RequirementsDocumentError) throw new HttpError(400, e.message);
                throw e;
            }
        } else {
            // No document: the project's own active requirements, as the text a document gives.
            const doc = await projectRequirementsDocument(p, id);
            if (doc) {
                options.requirementsText = doc.text;
                options.requirementsName = doc.name;
            }
        }
        // The application keeps the generation settings, minus the (possibly large) requirements text.
        const { requirementsText: _text, ...appConfig } = options;
        const keptMobile = latestMobile(id);
        const appId = repo.createApplication(id, body.url, keptMobile ? { ...appConfig, mobile: keptMobile } : appConfig, body.credentials);
        // The choice made when generating also becomes the project's switch for every later run (see routes/cleanup.ts).
        if (body.cleanupAfter !== undefined) new CleanupStore(repo.db).setEnabled(id, body.cleanupAfter);
        const job = await repo.createJob(id, appId, options);
        return reply.code(202).send({ jobId: job.id, status: job.status, ...(body.plan ? { plan: true } : {}) });
    });

    // ── user-supplied specs: import, export, re-validate ─────────────────────
    const KEY_PREFIX: Record<TestSpec["kind"], string> = { web: "WEB", api: "API", mobile: "MOB", desktop: "DSK" };
    const ImportSchema = z.object({
        specs: z.array(z.unknown()).min(1).max(500),
        /** Required when the project has no application yet; otherwise the latest application is used. */
        baseUrl: z.string().url().optional(),
        credentials: CredentialsSchema,
        /** The app mobile tests run against (needed to execute mobile tests). An app file comes from the upload route only: a path here could name another project's. */
        mobile: MobileTargetBase.omit({ apkPath: true }).strict().refine((t) => t.appPackage || t.iosBundleId, { message: "Give an app package or an iOS bundle id" }).optional(),
        validate: z.boolean().default(true),
        /** Shared elements (object repository) the specs refer to, as a spec export carries them. */
        objects: z.array(z.unknown()).max(1000).optional(),
        /** Reusable steps (blocks) the specs use, as a spec export carries them; each is checked like one saved through the blocks API. */
        blocks: z.array(z.unknown()).max(MAX_BLOCKS).optional(),
        /** Store every spec of this import for an adapter plug-in framework (its id from GET /api/config adapters). Absent: each spec's own kind decides, as always. */
        framework: z.string().min(1).max(40).optional(),
    });

    /** Application a validation job runs against. A new one is created when a URL or credentials are given. */
    const applicationFor = async (projectId: string, baseUrl?: string, credentials?: z.infer<typeof CredentialsSchema>, mobile?: MobileTarget, desktopOnly?: boolean) => {
        const latest = repo.getLatestApplicationPublic(projectId);
        const target = mobile ?? latestMobile(projectId);
        // A project that only tests a mobile app has no web address; use the standard Android app URI.
        const url = baseUrl ?? (latest?.url as string | undefined) ?? (target ? (target.appPackage || target.apkPath || !target.iosBundleId ? `android-app://${target.appPackage ?? "apk"}` : `ios-app://${target.iosBundleId}`) : desktopOnly ? DESKTOP_APP_URL : undefined);
        if (!url) throw new HttpError(400, "This project has no application yet; provide baseUrl");
        if (!isAppUri(url)) await assertRunTarget(projectId, url);
        if (credentials?.oauth2) await assertAllowedTarget(credentials.oauth2.tokenUrl);
        if (!baseUrl && !credentials && !mobile && latest) return { id: latest.id as string, url };
        // Keep the project's earlier settings (apiBaseUrl, mobile app) on the new application row.
        const kept = { ...DEFAULT_JOB_OPTIONS, ...(latest?.config?.apiBaseUrl ? { apiBaseUrl: latest.config.apiBaseUrl } : {}), ...(target ? { mobile: target } : {}) };
        return { id: repo.createApplication(projectId, url, kept, credentials), url };
    };

    let routeCtx: RouteCtx;
    const startValidationJob = async (projectId: string, applicationId: string, testIds: string[]) => {
        refuseUnlessRunsStart(p); // a run no worker would pick up is not queued (each caller says the run did not start, or refuses)
        return repo.createJob(projectId, applicationId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds });
    };

    app.post("/api/projects/:id/specs", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = ImportSchema.parse(req.body);
        // Shared elements the specs refer to: those already in the project plus the ones the export brings along.
        const importObjects = importObjectsFor(repo, id, body.objects);
        // Reusable steps a spec uses must be in the project already or come with this import; the checks below look at the steps the spec really has.
        const blockImport = await new BlockService(routeCtx).prepareImport(id, body.blocks, importObjects.index);
        const importBlocks = blockImport.index;

        // All-or-nothing: validate every spec before storing any. testId is optional on import.
        const details: Array<{ index: number; issues: unknown }> = [];
        const parsed: Array<{ spec: TestSpec; keepId: boolean; seen: TestSpec }> = [];
        body.specs.forEach((raw, index) => {
            const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
            const keepId = typeof obj.testId === "string" && obj.testId.length > 0;
            const r = TestSpecSchema.safeParse({ ...obj, testId: keepId ? obj.testId : "IMP-000" });
            if (r.success) {
                // A desktop spec must also follow the desktop rules (target, first step, locators): say exactly what is wrong.
                const expanded = tryExpandBlocks(r.data, importBlocks);
                const refd = expanded.ok ? tryResolveSpecRefs(expanded.spec, importObjects.index) : { ok: false as const, error: expanded.error };
                const desktopIssues = refd.ok ? [...desktopSpecIssues(refd.spec), ...iosSpecIssues(refd.spec)] : [refd.error];
                if (desktopIssues.length) details.push({ index, issues: desktopIssues.map((message) => ({ message })) });
                else parsed.push({ spec: r.data, keepId, seen: refd.ok ? refd.spec : r.data });
            } else details.push({ index, issues: r.error.issues });
        });
        if (details.length) return reply.code(400).send({ error: "Invalid specs", details });
        // A framework the project switched off (Runners, Frameworks) takes no new tests either.
        const switchedOff = turnedOffForSpecs(new FrameworkSettingsStore(repo.db), id, parsed.map((x) => x.spec));
        if (switchedOff) throw new HttpError(409, switchedOff);
        // Each load check sends up to 300 requests: an import carries only a few of them.
        if (parsed.filter((x) => isLoadSpec(x.seen)).length > LOAD_MAX_ENDPOINTS) return reply.code(400).send({ error: "Invalid specs", details: [{ message: `Import at most ${LOAD_MAX_ENDPOINTS} load checks at a time (each sends up to ${LOAD_MAX_REQUESTS} requests)` }] });
        // A spec that names a test data set must find it and use only its columns.
        const dataIssues = dataDrivenSpecIssues(repo, id, parsed.map((x) => x.seen));
        if (dataIssues.length) return reply.code(400).send({ error: "Invalid specs", details: dataIssues });
        const dataSets = dataSetsFor(repo, id);

        const taken = new Set(repo.listTests(id).map((t) => t.testKey));
        for (const { spec, keepId } of parsed) {
            if (!keepId) continue;
            if (taken.has(spec.testId)) throw new HttpError(409, `testId ${spec.testId} already exists in this project (omit testId to assign a new one)`);
            taken.add(spec.testId);
        }
        if (body.validate) await assertNoActiveJob(id);
        const checkBase = body.baseUrl ?? (repo.getLatestApplicationPublic(id)?.url as string | undefined);
        if (checkBase && !isAppUri(checkBase)) {
            await assertRunTarget(id, checkBase);
            const base = new URL(checkBase).origin;
            for (const [i, { seen: spec }] of parsed.entries()) if (spec.kind !== "mobile" && spec.kind !== "desktop") await assertSpecTargets(spec, i, base, base);
            // Stored sign-in details only go to the application's own site: a step that sends them elsewhere refuses the whole import, with the step named.
            const apiBase = repo.getLatestApplicationPublic(id)?.config?.apiBaseUrl as string | undefined;
            const leaks = parsed.flatMap(({ seen: spec }, index) =>
                spec.kind === "web" || spec.kind === "api" ? [{ index, issues: credentialOriginProblems(spec, allowedCredentialOrigins(spec.kind, base, apiBase)).map((p) => ({ message: p.message })) }].filter((d) => d.issues.length) : [],
            );
            if (leaks.length) return reply.code(400).send({ error: "Invalid specs", details: leaks });
        }
        const application = await applicationFor(id, body.baseUrl, body.credentials, body.mobile, parsed.every((x) => x.spec.kind === "desktop"));
        const origin = isAppUri(application.url) ? application.url : new URL(application.url).origin;

        // Render everything first so an unrenderable spec rejects the whole import.
        const prepared = parsed.map(({ spec, keepId }) => {
            const framework = frameworkForImport(spec, body.framework);
            const withSource: TestSpec = { ...spec, source: { ...spec.source, origin: spec.source.origin === "manual" ? "imported" : spec.source.origin } };
            try {
                renderWithAdapter({ ...withSource, testId: keepId ? spec.testId : `${KEY_PREFIX[spec.kind]}-000` }, framework, { baseUrl: origin, dataSets, ...(importObjects.index ? { objects: importObjects.index } : {}), ...(importBlocks ? { blocks: importBlocks } : {}) });
            } catch (e) {
                throw new HttpError(422, `Spec "${spec.title}" cannot be rendered: ${e instanceof Error ? e.message : String(e)}`);
            }
            return { spec: withSource, keepId, framework };
        });

        importObjects.persist();
        blockImport.persist();
        const created: Array<{ id: string; testId: string; executable: boolean }> = [];
        for (const item of prepared) {
            const testId = item.keepId ? item.spec.testId : repo.db.tx(() => repo.nextTestKey(id, KEY_PREFIX[item.spec.kind]));
            const spec: TestSpec = { ...item.spec, testId };
            const slug = slugify(spec.category);
            const suiteId = repo.getOrCreateSuite(id, spec.category, slug);
            const executable = getAdapter(item.framework).executable;
            const testDbId = repo.insertTest({ projectId: id, suiteId, jobId: null, spec, framework: item.framework, validationStatus: "PENDING", meta: { imported: true } });
            await storeScript(repo, p.store, id, testDbId, slug, renderWithAdapter(spec, item.framework, { baseUrl: origin, dataSets, ...(importObjects.index ? { objects: importObjects.index } : {}), ...(importBlocks ? { blocks: importBlocks } : {}) }), executable);
            created.push({ id: testDbId, testId, executable });
        }

        const toRun = created.filter((c) => c.executable).map((c) => c.id);
        // A desktop run this computer is not set up for (for example an application that is not on the allow-list) is a setup problem, not a bad import:
        // the tests are stored and the answer says plainly why they were not run.
        let job: Awaited<ReturnType<typeof startValidationJob>> | null = null;
        let notRun: string | undefined;
        if (body.validate && toRun.length && !runsCanStartHere(p).ok) notRun = IMPORTED_NOT_RUN; // tests switched off here: kept, not run
        else if (body.validate && toRun.length) {
            try {
                job = await startValidationJob(id, application.id, toRun);
            } catch (e) {
                if (!(e instanceof HttpError) || e.status !== 409 || !prepared.some((x) => x.spec.kind === "desktop")) throw e;
                notRun = e.message;
            }
        }
        return reply.code(202).send({ jobId: job?.id ?? null, ...(notRun ? { notRun } : {}), tests: created.map(({ id: tid, testId }) => ({ id: tid, testId })) });
    });

    /** Export every canonical spec of a project; the output can be POSTed back to /specs. */
    app.get("/api/projects/:id/specs", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        // Hand-written tests have no spec to export (their script goes out with the download); a taken-over test's spec is archived, not exported.
        const specs = repo.listTests(id).filter((t) => !customStore.isCustom(t.id)).map((t) => t.spec);
        // Specs that use shared elements travel with those elements (only then: otherwise the answer is exactly what it always was).
        // Reusable steps the specs use come along too (with the shared elements those steps refer to), for the same reason.
        const blocks = exportBlocksUsedBy(repo.db, id, specs);
        const objects = exportObjectsUsedBy(repo, id, [...specs, ...blocks.map((b) => ({ steps: b.steps }) as TestSpec)]);
        return { specs, ...(objects.length ? { objects } : {}), ...(blocks.length ? { blocks } : {}) };
    });

    /**
     * Accept the latest run's screenshots as the new approved baselines (an intended visual change),
     * then re-validate so the acceptance is confirmed by an actual passing run.
     */
    app.post("/api/tests/:id/baseline", async (req, reply) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        if (!hasScreenshotStep(t.spec)) throw new HttpError(422, "This test has no screenshot assertion");
        refuseUnlessRunsStart(p); // accepting means confirming by a run: nothing is accepted when no run can start
        await assertNoActiveJob(t.projectId);
        const latest = repo.listExecutions(t.id)[0] as { artifacts: Array<{ kind: string; path: string }> } | undefined;
        const actuals = (latest?.artifacts ?? []).filter((a) => a.kind === "visual-actual");
        if (!actuals.length) throw new HttpError(409, "The latest run has no new screenshot to accept (it matched the baseline or did not reach the screenshot)");

        const accepted: string[] = [];
        for (const a of actuals) {
            const name = path.posix.basename(a.path).replace(/-actual\.png$/, ".png");
            const rel = path.posix.join(t.projectId, "_baselines", t.testKey, name);
            const saved = await p.store.copy(a.path, rel);
            repo.replaceArtifact({ projectId: t.projectId, testId: t.id, kind: "baseline", path: rel, size: saved.size });
            accepted.push(name);
        }
        const application = await applicationFor(t.projectId);
        const job = await startValidationJob(t.projectId, application.id, [t.id]);
        return reply.code(202).send({ accepted, jobId: job.id });
    });

    app.post("/api/tests/:id/validate", async (req, reply) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        assertFrameworkLoaded(t.framework); // a test of an adapter plug-in that is not loaded: say so in words
        const adapter = getAdapter(t.framework);
        if (!adapter.executable) throw new HttpError(422, `${t.framework} tests cannot be executed by this platform`);
        if (adapter.needs.ios) {
            if (!latestMobile(t.projectId)?.iosBundleId) throw new HttpError(422, "This project has no iOS app set up. Add the app's bundle id first.");
            // iOS tests never run on this server: they need a runner agent on a Mac (the job gate names what the agent is missing).
            if (agentCanRunIos(t.projectId) === undefined) throw new HttpError(409, IOS_NEEDS_AGENT_MESSAGE);
        }
        if (adapter.needs.android) {
            const avail = mobileAvailability();
            if (!latestMobile(t.projectId)) throw new HttpError(422, "This project has no mobile app set up. Add an app package or an APK first.");
            // On a runner agent the agent's devices count (the job gate names what is missing); otherwise this machine's.
            // A project whose phone tests run on a device farm needs no phone here (device-farms.md).
            // A connected phone needs only the Android tools here, not an emulator (mobile/device/choose.ts).
            if (agentCanRunMobile(t.projectId) === undefined && !avail.available && localPhoneRunsProblem() && !farmChosen(repo.db, t.projectId)) throw new HttpError(422, avail.reason ?? "No Android device is available");
        }
        // "Run against <environment>": the result is stored for that environment and the test's own status is untouched.
        const choice = EnvironmentChoice.parse(req.body ?? {});
        refuseUnlessRunsStart(p);
        if (choice.environment) {
            return reply.code(202).send(await startEnvironmentRun({ repo, p, applicationFor: (pid) => applicationFor(pid), assertNoActiveJob }, t.projectId, [t], choice.environment, choice.confirmProduction));
        }
        await assertNoActiveJob(t.projectId);
        const application = await applicationFor(t.projectId);
        const job = await startValidationJob(t.projectId, application.id, [t.id]);
        return reply.code(202).send({ jobId: job.id, status: job.status });
    });

    // ── mobile app (what mobile tests run against) ─────────────────────────────
    const MobileSettingsSchema = z.object({
        appPackage: MobileTargetBase.shape.appPackage.nullable().optional(),
        avd: MobileTargetBase.shape.avd.nullable().optional(),
        /** iOS: the bundle id of an app already installed on the simulator, and the simulator to use by name. */
        iosBundleId: MobileTargetBase.shape.iosBundleId.nullable().optional(),
        simulator: MobileTargetBase.shape.simulator.nullable().optional(),
        /** Forget the uploaded APK. */
        clearApk: z.boolean().optional(),
        /** Android: clear the app's data before each test, and the permissions granted before each test (engine/mobile/state). */
        cleanStart: z.boolean().nullable().optional(),
        grantPermissions: MobileTargetBase.shape.grantPermissions.nullable().optional(),
        /** Android: the longest a cold start may take before it is a finding (phone quality checks); null goes back to the 5 s default. */
        startupBudgetMs: MobileTargetBase.shape.startupBudgetMs.nullable().optional(),
    });
    const saveMobile = async (projectId: string, next: Partial<MobileTarget>) => {
        const parsed = MobileTargetSchema.safeParse(next);
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid mobile app settings");
        const application = await applicationFor(projectId, undefined, undefined, parsed.data);
        return { applicationId: application.id, mobile: publicMobile(parsed.data) };
    };

    app.put("/api/projects/:id/mobile-app", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        await assertNoActiveJob(id);
        const body = MobileSettingsSchema.parse(req.body);
        const cur = latestMobile(id);
        const next: Partial<MobileTarget> = {
            appPackage: body.appPackage === undefined ? cur?.appPackage : (body.appPackage ?? undefined),
            avd: body.avd === undefined ? cur?.avd : (body.avd ?? undefined),
            apkPath: body.clearApk ? undefined : cur?.apkPath,
            iosBundleId: body.iosBundleId === undefined ? cur?.iosBundleId : (body.iosBundleId ?? undefined),
            simulator: body.simulator === undefined ? cur?.simulator : (body.simulator ?? undefined),
            ...keptStartState(cur, body),
            // Where phone tests run, how thorough, already signed in (phone-settings.ts): kept as they are; routes/phone-device.ts changes them.
            ...keptPhoneSettings(cur),
            // The screen that opens the app, as a run resolved it on the phone (mobile/device/launcher.ts): kept while the app stays the same one.
            ...(cur?.appActivity && (body.appPackage === undefined || body.appPackage === cur.appPackage) ? { appActivity: cur.appActivity } : {}),
            // Phone quality checks: the start-up budget (left out: kept; null: back to the default).
            ...((b) => (b !== undefined ? { startupBudgetMs: b } : {}))(body.startupBudgetMs === undefined ? cur?.startupBudgetMs : (body.startupBudgetMs ?? undefined)),
        };
        const problem = preparationProblem(next) ?? phoneSettingsProblem(next);
        if (problem) throw new HttpError(400, problem);
        return saveMobile(id, next);
    });

    // An APK is sent as the raw request body (it can be large); 512 MB is generous for any app.
    app.addContentTypeParser(["application/vnd.android.package-archive", "application/octet-stream"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    app.post("/api/projects/:id/mobile-app/apk", { bodyLimit: 512 * 1024 * 1024 }, async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        await assertNoActiveJob(id);
        const { filename } = z.object({ filename: z.string().max(200).default("app.apk") }).parse(req.query);
        const data = req.body as Buffer;
        // An APK is a zip archive containing AndroidManifest.xml; refuse anything else before storing it.
        if (!Buffer.isBuffer(data) || data.length < 100 || data.readUInt32LE(0) !== 0x04034b50 || !data.includes("AndroidManifest.xml")) {
            throw new HttpError(400, "That doesn't look like an Android app (.apk) file.");
        }
        const rel = path.posix.join(id, "_apps", "app.apk");
        // An Android App Bundle: turned into one universal APK when this computer has Java and bundletool, refused in plain words otherwise (engine/mobile/state/bundle.ts).
        if (/\.aab$/i.test(filename) || looksLikeBundle(data)) {
            if (!bundleSupport().ok) throw new HttpError(400, AAB_REFUSAL);
            // bundletool needs real files: both live in a temporary folder, and only the APK is stored.
            const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aitp-upload-"));
            try {
                const aab = path.join(work, "app.aab");
                const apk = path.join(work, "app.apk");
                await fs.promises.writeFile(aab, data);
                try {
                    await convertBundle(aab, apk);
                } catch (e) {
                    throw new HttpError(400, e instanceof Error ? e.message : String(e));
                }
                await p.store.putFile(rel, apk, { contentType: "application/vnd.android.package-archive" });
            } finally {
                await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
            }
        } else {
            if (!/\.apk$/i.test(filename)) throw new HttpError(400, "The file name must end in .apk");
            await p.store.put(rel, data, { contentType: "application/vnd.android.package-archive" });
        }
        // Phone runs on this machine install the app from a path: the stored file on local disk (another store keeps the key; see agent-services.ts).
        const full = localPathOf(p.store, rel) ?? rel;
        const cur = latestMobile(id);
        return saveMobile(id, { appPackage: cur?.appPackage, avd: cur?.avd, apkPath: full, iosBundleId: cur?.iosBundleId, simulator: cur?.simulator, ...keptStartState(cur, {}), ...(cur?.startupBudgetMs !== undefined ? { startupBudgetMs: cur.startupBudgetMs } : {}), ...keptPhoneSettings(cur), ...(cur?.appActivity ? { appActivity: cur.appActivity } : {}) });
    });

    // The app by platform (round 37): store links and the iPhone app (routes/project-app.ts). Create project uses `apply` too.
    const projectApp = registerProjectAppRoutes({
        app,
        p,
        repo,
        project,
        assertNoActiveJob,
        latestMobile,
        saveMobile,
        // A new application row with the new address; the earlier settings (mobile app, API address) stay, and sign-in details
        // stay only when the address is on the same site, so they are never sent to another one.
        setWebAddress: async (projectId, url) => {
            const latest = repo.getLatestApplicationPublic(projectId);
            if (latest?.url === url) return;
            await assertRunTarget(projectId, url);
            const full = latest ? repo.getApplication(latest.id as string) : undefined;
            const sameSite = Boolean(full && !isAppUri(full.url) && /^https?:/i.test(full.url) && new URL(full.url).origin === new URL(url).origin);
            repo.createApplication(projectId, url, { ...DEFAULT_JOB_OPTIONS, ...(full?.config ?? {}) }, sameSite ? full?.credentials : undefined);
        },
    });

    app.get("/api/test-generation/:jobId", async (req) => {
        const job = repo.getJob((req.params as { jobId: string }).jobId);
        if (!job) throw new HttpError(404, "Job not found");
        return publicJob(job);
    });
    app.get("/api/test-generation/:jobId/events", async (req) => {
        const { jobId } = req.params as { jobId: string };
        const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
        if (!repo.getJob(jobId)) throw new HttpError(404, "Job not found");
        return repo.listEvents(jobId, after);
    });
    app.delete("/api/test-generation/:jobId", async (req, reply) => {
        const { jobId } = req.params as { jobId: string };
        if (!repo.getJob(jobId)) throw new HttpError(404, "Job not found");
        return reply.code(202).send({ cancelRequested: repo.requestCancel(jobId) });
    });
    app.get("/api/projects/:id/jobs", async (req) => repo.listJobs((req.params as { id: string }).id).map(publicJob));

    // ── tests ──────────────────────────────────────────────────────────────────
    const customStore = new CustomScriptStore(p.db);
    /** The `custom` block of a hand-written test; nothing at all for a generated one (its answers stay exactly as they were). */
    const customBlock = (testId: string, known?: Map<string, CustomState>) => {
        const c = known ? known.get(testId) : customStore.get(testId);
        return c ? { custom: customInfo(c) } : {};
    };
    const summary = (t: ReturnType<typeof repo.getTest> & {}, gate?: QuarantineGate, customs?: Map<string, CustomState>) => ({
        id: t.id,
        projectId: t.projectId,
        testId: t.testKey,
        title: t.title,
        suite: t.suite,
        kind: t.kind,
        type: t.type,
        priority: t.priority,
        framework: t.framework,
        validationStatus: t.validationStatus,
        validationReason: t.validationReason,
        severity: assessSeverity(t.spec, t.validationStatus, t.validationReason) ?? null,
        attempts: t.attempts,
        updatedAt: t.updatedAt,
        // Only while the test is quarantined (it still runs and is shown; it just decides nothing).
        ...(gate?.has(t.id) ? { quarantine: { reason: gate.get(t.id)!.reason, since: gate.get(t.id)!.since, expiresAt: gate.get(t.id)!.expiresAt } } : {}),
        ...customBlock(t.id, customs),
    });

    app.get("/api/projects/:id/tests", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const q = z.object({ kind: z.enum(TEST_KINDS).optional(), validationStatus: z.string().optional(), suite: z.string().optional(), jobId: z.string().optional(), q: z.string().optional() }).parse(req.query);
        const compat = projectCompat(repo, id);
        // Duplicates are judged against the whole project, so quality is computed on all tests, then filtered.
        const customs = customStore.forProject(id);
        // Quality is judged on steps; a hand-written test has none that mean anything, so it is left out (and gets no score).
        const quality = assessProjectQuality(withExpandedSpecs(repo.db, id, repo.listTests(id).filter((t) => !customs.has(t.id))));
        const gate = quarantineGate(repo.db, Date.now(), id);
        return repo.listTests(id, q).map((t) => ({ ...summary(t, gate, customs), compat: compat(t.id), quality: quality.get(t.id) ?? null }));
    });
    /** Indicative mapping of the project's tests to NIST / HIPAA / ISO controls (computed on read). */
    app.get("/api/projects/:id/compliance", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { frameworks } = z.object({ frameworks: z.string().optional() }).parse(req.query);
        const wanted = frameworks ? frameworks.split(",").map((f) => f.trim()).filter(Boolean) : [...FRAMEWORKS];
        const unknown = wanted.filter((f) => !(FRAMEWORKS as readonly string[]).includes(f));
        if (unknown.length) throw new HttpError(400, `Unknown framework: ${unknown.join(", ")}. Available: ${FRAMEWORKS.join(", ")}`);
        const tests = withExpandedSpecs(repo.db, id, repo.listTests(id, {})).map((t) => ({ id: t.id, testKey: t.testKey, spec: t.spec, validationStatus: t.validationStatus }));
        return { disclaimer: "Indicative mapping of test coverage to control topics. It is not a compliance assessment or certification.", testCount: tests.length, frameworks: complianceReport(tests, wanted as ComplianceFramework[]) };
    });
    app.get("/api/projects/:id/suites", async (req) => repo.listSuites((req.params as { id: string }).id));
    app.get("/api/projects/:id/application-model", async (req) => {
        const a = repo.getLatestApplicationPublic((req.params as { id: string }).id);
        if (!a) throw new HttpError(404, "No application yet");
        const full = repo.getApplication(a.id as string);
        return full?.model ?? null;
    });

    const testDetail = (testId: string) => {
        const t = repo.getTest(testId);
        if (!t) throw new HttpError(404, "Test not found");
        const runSteps = runStepsOf(repo.db, t.projectId, t.spec);
        // What each failed step expected and got, read from the errors the runs stored (by the steps that really ran).
        const executions = withFailureFacts(asExecutions(repo.listExecutions(t.id)), runSteps ? runSteps.map((r) => r.step) : t.spec.steps);
        const failure = t.validationStatus === "FAILED_VALIDATION" || t.validationStatus === "NEEDS_REVIEW" ? failureSummary(executions, t.validationReason) : undefined;
        // Only this test's reusable steps are put in place (the others only when they could be a duplicate of it): see test-quality.ts.
        const quality = customStore.isCustom(t.id) ? null : qualityOfTest(repo.db, t.projectId, repo.listTests(t.projectId), t.id);
        return {
            ...summary(t, quarantineGate(repo.db, Date.now(), t.projectId)),
            quality,
            spec: t.spec,
            controls: mapControls(withExpandedSpecs(repo.db, t.projectId, [t])[0]!.spec).map((c) => ({ id: c.id, framework: c.framework, title: c.title })),
            // Only for a test that uses reusable steps: the steps that really run, so a run's step results can be read against them.
            ...(runSteps ? { runSteps } : {}),
            generationMeta: t.generationMeta,
            scripts: repo.listScripts(t.id).map((s) => ({ id: s.id, framework: s.framework, filename: s.filename, version: s.version, executable: Boolean(s.executable), content: s.content, createdAt: s.created_at })),
            executions,
            ...(failure ? { failure } : {}),
            ...testCompatibility(repo, t),
            ...testEnvironmentInfo(repo, t),
        };
    };
    app.get("/api/tests/:id", async (req) => testDetail((req.params as { id: string }).id));
    app.get("/api/tests/:id/executions", async (req) => repo.listExecutions((req.params as { id: string }).id));
    app.get("/api/tests/:id/script", async (req, reply) => {
        const { id } = req.params as { id: string };
        const { framework } = z.object({ framework: z.string().optional() }).parse(req.query);
        const s = repo.getCurrentScript(id, framework);
        if (!s) throw new HttpError(404, "No script for this test");
        // A hand-written test says so in a header (the body stays the plain script).
        if (customStore.isCustom(id)) reply.header("x-custom-script", "true");
        return reply.header("content-type", "text/plain; charset=utf-8").header("content-disposition", `inline; filename="${s.filename}"`).send(s.content);
    });

    /** Render the canonical spec for another framework (e.g. Taqwright/Appium). Stored, but not executed here. */
    app.post("/api/tests/:id/scripts", async (req, reply) => {
        const { id } = req.params as { id: string };
        const { framework } = z.object({ framework: z.enum(listAdapters().map((a) => a.id) as [string, ...string[]]) }).parse(req.body);
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        if (customStore.isCustom(t.id)) throw new HttpError(409, "This test is hand-written, so its script cannot be created from steps. Restore the generated version first.");
        const gen = getAdapter(framework);
        const origin = new URL(repo.getLatestApplicationPublic(t.projectId)?.url as string).origin;
        let script;
        try {
            script = renderWithAdapter(t.spec, framework, { baseUrl: origin, dataSets: dataSetsFor(repo, t.projectId), ...(objectsFor(repo, t.projectId) ? { objects: objectsFor(repo, t.projectId) } : {}), ...(blocksFor(repo.db, t.projectId) ? { blocks: blocksFor(repo.db, t.projectId) } : {}) });
        } catch (e) {
            throw new HttpError(422, e instanceof Error ? e.message : "Cannot render this spec for that framework");
        }
        const rel = path.posix.join(t.projectId, "_other", script.filename);
        const stored = await putText(p.store, rel, script.content);
        const sid = repo.addScript(t.id, { framework: script.framework, filename: script.filename, content: script.content, hash: stored.hash, storagePath: rel, executable: gen.executable });
        return reply.code(201).send({ id: sid, framework: script.framework, filename: script.filename, executable: gen.executable, validation: gen.executable ? "PENDING" : "NOT_EXECUTED (no device infrastructure)", content: script.content });
    });

    app.get("/api/artifacts/:id", async (req, reply) => {
        const a = repo.getArtifact((req.params as { id: string }).id);
        if (!a) throw new HttpError(404, "Artifact not found");
        // A file the retention policy removed: say so honestly instead of failing on a missing file.
        if (a.pruned_at) throw new HttpError(410, prunedMessage(String(a.kind), String(a.pruned_at)));
        const TYPES: Record<string, string> = {
            screenshot: "image/png",
            video: "video/webm",
            "app-model": "application/json",
            "requirements-coverage": "application/json",
            baseline: "image/png",
            "visual-actual": "image/png",
            "visual-diff": "image/png",
            "vision-shot": "image/jpeg",
            trace: "application/zip",
        };
        const type = TYPES[a.kind as string] ?? "application/octet-stream";
        // An object store with short-lived links (S3, M4) sends the browser there, recorded in Activity; local disk has none and is served as always.
        const signed = await p.store.signedUrl(a.path as string, { ttlSeconds: 300, contentType: type, ...(a.kind === "trace" ? { filename: path.posix.basename(a.path as string) } : {}) });
        if (signed) {
            const actor = actorOf(req);
            if (actor) access.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action: "GET /api/artifacts/:id", path: `/api/artifacts/${a.id as string}`, projectId: (a.project_id as string | null) ?? null, status: 302, detail: String(a.kind) });
            return reply.code(302).header("location", signed).header("cache-control", "no-store").send();
        }
        return reply.header("content-type", type).send(await p.store.getBytes(a.path));
    });

    /**
     * JUnit XML of each test's most recent validation run — for CI systems and test-management tools.
     * Never-executed tests are <skipped/>; NEEDS_REVIEW findings are failures (type "application-finding").
     */
    // The XML writer lives in reports/junit.ts so the `ai-test` command produces identical files.
    const junitXml = (suiteName: string, tests: ReturnType<typeof repo.listTests>): string => {
        const gate = tests[0] ? quarantineGate(repo.db, Date.now(), tests[0].projectId) : undefined;
        return buildJunit(
            suiteName,
            tests.map((t) => ({ ...t, last: repo.listExecutions(t.id)[0] as { status: string; durationMs: number | null; error: string | null } | undefined, ...(gate?.has(t.id) ? { quarantine: { reason: gate.get(t.id)!.reason } } : {}) })),
        );
    };

    app.get("/api/projects/:id/junit", async (req, reply) => {
        const { id } = req.params as { id: string };
        const p = project(id);
        return reply.header("content-type", "application/xml; charset=utf-8").send(junitXml(p.name as string, repo.listTests(id)));
    });

    /** Download every validated script (and the canonical specs) of a project as a zip. */
    app.get("/api/projects/:id/download", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        // z.coerce.boolean() would turn the string "false" into true.
        const { includeUnvalidated } = z.object({ includeUnvalidated: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).parse(req.query);
        const files: Record<string, Uint8Array> = {};
        const manifest: unknown[] = [];
        const zippedSpecs: TestSpec[] = [];
        /** Folders that hold a hand-written script: its shared helpers go next to it (./helpers/<name>). */
        const handWritten = new Map<string, string[]>();
        /** What the download's package.json, lockfile, config and README are made for. */
        const exported: ExportScript[] = [];
        for (const t of repo.listTests(id)) {
            if (!includeUnvalidated && t.validationStatus !== "VALIDATED") continue;
            const s = repo.getCurrentScript(t.id);
            if (!s) continue;
            const slug = (s.storage_path as string).split("/")[1] ?? "general";
            // Phone tests go to phone-tests/ (they run with Taqwright, not `npx playwright test`); see portable-export.ts.
            const file = exportPath(s.framework as string, slug, s.filename as string);
            files[file] = strToU8(s.content);
            exported.push({ path: file, framework: s.framework as string, content: s.content as string });
            if (customStore.isCustom(t.id)) handWritten.set(slug, [...(handWritten.get(slug) ?? []), s.content as string]);
            files[`specs/${t.testKey}.json`] = strToU8(JSON.stringify(t.spec, null, 2));
            zippedSpecs.push(t.spec);
            manifest.push({ testId: t.testKey, title: t.title, suite: t.suite, kind: t.kind, priority: t.priority, validation: t.validationStatus, severity: assessSeverity(t.spec, t.validationStatus, t.validationReason)?.severity, controls: mapControls(t.spec).map((c) => c.id), file });
        }
        for (const [slug, codes] of handWritten)
            for (const h of customStore.helpersFor(id, codes).helpers) {
                files[`tests/${slug}/helpers/${h.name}.ts`] = strToU8(h.content);
                exported.push({ path: `tests/${slug}/helpers/${h.name}.ts`, framework: "playwright", content: h.content });
            }
        files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
        // Specs that refer to shared elements come with those elements, so the specs can be imported elsewhere.
        // Reusable steps the zipped specs use come along in blocks.json (and the elements those steps refer to), so those specs import elsewhere too.
        const sharedBlocks = exportBlocksUsedBy(repo.db, id, zippedSpecs);
        const sharedElements = exportObjectsUsedBy(repo, id, [...repo.listTests(id).map((t) => t.spec), ...sharedBlocks.map((b) => ({ steps: b.steps }) as TestSpec)]);
        if (sharedBlocks.length) files["blocks.json"] = strToU8(JSON.stringify({ version: 1, blocks: sharedBlocks }, null, 2));
        if (sharedElements.length) files["objects.json"] = strToU8(JSON.stringify({ version: 1, elements: sharedElements }, null, 2));
        files["results/validation-junit.xml"] = strToU8(junitXml(project(id).name as string, repo.listTests(id).filter((t) => includeUnvalidated || t.validationStatus === "VALIDATED")));
        // package.json with the exact versions, the lockfile, .nvmrc, playwright.config.ts (and taqwright.config.ts), README.md, .gitignore.
        for (const [name, text] of Object.entries(portableFiles({ projectName: project(id).name as string, scripts: exported }).files)) files[name] = strToU8(text);
        return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="tests-${id.slice(0, 8)}.zip"`).send(Buffer.from(zipSync(files)));
    });

    // ── feature modules (each owns its routes, tables and UI; see src/platform/routes/) ──
    // Declared here (after the helpers it holds) and read by handlers above, which only run once the server is up.
    routeCtx = {
        app,
        p,
        repo,
        project,
        assertNoActiveJob,
        applicationFor: (projectId, baseUrl) => applicationFor(projectId, baseUrl),
        startValidationJob,
        testDetail,
        publicJob: (j) => publicJob(j),
    };
    registerFeatureRoutes(routeCtx);

    // ── UI (built by `npm run build:web`) ─────────────────────────────────────
    const webDist = path.join(REPO_ROOT, "web", "dist");
    if (fs.existsSync(webDist)) {
        await app.register(fastifyStatic, { root: webDist });
        app.setNotFoundHandler((req, reply) => {
            if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
            return reply.sendFile("index.html");
        });
    }
    return app;
}
