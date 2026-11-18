/**
 * AI Orchestrator: URL → discovery → understanding → planning → generation → validation.
 *
 * Pure engine logic. All persistence goes through `GenerationSink`, so the same pipeline can be
 * driven by the platform's job worker (platform/repo-sink.ts) or by any other host.
 * Phases fail independently where possible: e.g. if the web path fails because no LLM is
 * configured, deterministic OpenAPI-driven API tests can still be generated and validated.
 */
import { resolveApiToken, type OAuth2ClientCredentials } from "./api/oauth.js";
import type { Browser, Page } from "playwright";
import { shootPage } from "./frames/shoot.js";
import { fillPath as fillApiPath, generateApiSpecs, type DraftSpec } from "./api/test-specs.js";
import { probeOpenApi } from "./api/openapi.js";
import { mapLanes, throwIfAborted, type EngineContext } from "./context.js";
import { isBudgetExceeded } from "./llm/usage.js";
import { LlmNotConfiguredError } from "./llm/provider.js";
import { login, type Credentials } from "./discovery/auth.js";
import { BrowserSession, launchChromium, settle } from "./discovery/browser.js";
import { addSignedOutPages, crawl } from "./discovery/crawler.js";
import { documentedApiModels, scrapeDocumentationPages } from "./discovery/docs.js";
import type { Framework, RenderedScript } from "./generators/index.js";
import { renderWithAdapter } from "./frameworks/index.js";
import { deleteOperationsOf } from "./cleanup/helper.js";
import type { FinishedItem } from "./cleanup/ledger.js";
import { cleanupHeaders, type CleanupRequest } from "./cleanup/run.js";
import { generateA11ySpecs } from "./a11y/specs.js";
import { generateHealthSpecs } from "./health/specs.js";
import { generateAccessSpecs, generateApiAccessSpecs, rolePageBudget, surveyAccess, surveyApiAccess, type ApiAccessRow, type Reach, type RoleLogin } from "./identity/access.js";
import { generateInputSpecs } from "./inputs/specs.js";
import { generateVisionSpecs } from "./vision/specs.js";
import { generateLatencySpecs } from "./performance/latency.js";
import { generateLoadSpecs, LOAD_MAX_ENDPOINTS, LOAD_MAX_REQUESTS } from "./performance/load.js";
import { defaultAccount, planSignedIn, type SignedInPlan } from "./identity/signed-in.js";
import { generatePerformanceSpecs, generateSignedInPerformanceSpecs } from "./performance/specs.js";
import { generateSecuritySpecs } from "./security/specs.js";
import { generateSignedInVisualSpecs, generateVisualSpecs } from "./visual/baseline.js";
import { generateApiWorkflowSpecs } from "./api/workflows.js";
import { planScenarios, requirementsCoverage, rulesForScenario } from "./planning/planner.js";
import type { StoredPlan } from "./planning/preview.js";
import { openMemory, secretValues, type MemoryStorage } from "./memory/session.js";
import { reuseMessage } from "./memory/reuse.js";
import { EVENT_PAGES_REUSED, explorationReuseOn } from "./llm/without-ai.js";
import { levelSettings, visionOn, type ExploreLevel } from "./levels.js";
import { buildScreenMap, coverWithTests, type CrawlTransition, type RoleCrawl } from "./screenmap/map.js";
import { asRole, roleCredentials, roleDifferences } from "./identity/role-differences.js";
import { refusedBy } from "./memory/notes.js";
import { createTestData } from "./testdata/generate.js";
import { parseRequirements } from "./requirements/parse.js";
import { assertCredentialsStayHome } from "./spec/credential-origin.js";
import { TestSpecSchema, type Scenario, type TestSpec } from "./spec/schema.js";
import { analyzeApplication } from "./understanding/analyzer.js";
import type { ApiEndpointModel, AppModel } from "./understanding/app-model.js";
import { validateBatch, type TestUnderValidation, type ValidationOutcome } from "./validation/validator.js";
import { isKeyTest, runVariantChecks, type VariantRecord } from "./validation/variants.js";
import type { ScriptRun } from "./validation/runner.js";
import { authorWebSpec, statedSource, toSpec, type AuthorOutcome } from "./web/author.js";
import { findLeftoverUse, leftoverReason } from "./web/leftovers.js";
import { checkStrength } from "./mutation/strength.js";
import { CANDIDATE_FINDING_LIMITS, CandidateFindingSchema, confidenceOf, findingFingerprint, type CandidateFinding, type CaptureState, type FindingConfidence } from "./explore/finding.js";
import { checkIndependence, replayOwnSteps, type IndependenceCheck } from "./explore/independence.js";
import type { KnowledgeRule } from "./planning/planner.js";
import type { MobileTarget } from "./mobile/target.js";
import { createHash } from "node:crypto";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { LlmClient } from "./llm/provider.js";
import { inputClassesFor } from "./explore/input-classes.js";
import { runExploration, type ActionLogRow, type Budgets, type ExplorationResult, type LoopObjective, type ObjectiveContext, type ObjectiveOutcome, type ObjectiveRun, type StopReason } from "./explore/loop.js";
import { MAX_EXPLORED, OBJECTIVE_REF_MAX, objectivesFrom, type Objective, type ObjectiveField, type ObjectiveOperator } from "./explore/objectives.js";
import { operatorApplied, scenariosFor, type OperatorCheck, type PerturbOptions } from "./explore/perturb.js";
import { coverageOf, pursuitKey, type CoverageModel, type CoverageRecord, type CoverageTest, type SkippedOperator } from "./explore/coverage.js";
import { pathPattern } from "./explore/state.js";
import { usableRules, type AppKnowledge } from "./planning/planner.js";
import { runMobileGeneration } from "./mobile/explore/pipeline.js";

export type JobStatusName = "DISCOVERING" | "ANALYZING" | "PLANNING" | "GENERATING" | "VALIDATING";
export type PhaseName = "discovery" | "understanding" | "planning" | "generation" | "validation";

export interface GenerationRequest {
    url: string;
    /** How much to explore (./levels): sets how many key pages and endpoints get each check. Absent: thorough. */
    level?: ExploreLevel;
    maxPages: number;
    maxDepth: number;
    maxScenarios: number;
    scope?: string;
    includePaths?: string[];
    /** "mobile": the AI explores the project's Android app on a phone or emulator (see ./mobile/explore). Alone or together with web and API. */
    targets: Array<"web" | "api" | "mobile">;
    /** The app the "mobile" target explores (package, optional APK and emulator). */
    mobile?: MobileTarget;
    allowMutatingApiTests: boolean;
    openApiUrl?: string;
    apiBaseUrl?: string;
    credentials?: { username?: string; password?: string; totpSecret?: string; apiToken?: string; apiAuthHeader?: string; oauth2?: OAuth2ClientCredentials };
    /** Named test accounts (user, admin...): used to survey what each can reach and to generate access-control checks. */
    roles?: RoleLogin[];
    /** Generate access-control checks when the project has test accounts. Default true. */
    accessChecks?: boolean;
    /** Plan and write functional test cases for the journeys (web target). Default true; false: only the checks are generated. */
    functionalTests?: boolean;
    /** Generate axe-core accessibility audits for key pages (web target). Default true. */
    accessibility?: boolean;
    /** Generate page health checks (JavaScript errors, failed requests, broken links...) for key pages (web target). Default true. */
    healthChecks?: boolean;
    /** Generate passive, read-only security checks (headers, cookies, CORS, exposed files, TLS) for the application origin. Default true. */
    securityChecks?: boolean;
    /** Generate page-speed checks (median of 3 cold loads vs budgets) for key pages (web target). Default false. */
    performanceChecks?: boolean;
    /** Basic load check for up to 3 safe GET endpoints (API target). Default false: it sends up to 300 requests per endpoint. */
    loadChecks?: boolean;
    /** Lower limits for the load check, e.g. "p95:500 users:5"; clamped to the caps. */
    loadBudgets?: string;
    /** Probe the safe forms of key pages with harmless unusual input (web target). Default true. */
    inputChecks?: boolean;
    /**
     * AI judgement (needs a vision-capable model): the authoring agent may ask whether a screen looks right, and key pages get a
     * replayable "looks right" check. Absent: the level decides (on at deep and everything when the model can read images, see
     * levels.ts visionOn); an explicit false always wins. Every screenshot is a paid model call and the verdict is a judgement.
     */
    visionChecks?: boolean;
    /** Check API responses against the documented schema (OpenAPI). Default true. */
    contractChecks?: boolean;
    /** Budget overrides, e.g. "lcp:3000 weight:5000000 slow-4g". */
    performanceBudgets?: string;
    /** Generate visual-regression baselines for key pages (web target). Default false: noisy on dynamic pages. */
    visual?: boolean;
    /** Requirements document (already converted to text) that planning must cover. */
    requirements?: { name: string; text: string };
    /** Extra browsers / screen sizes to re-run validated web tests on after the main validation (opt-in). */
    variants?: string[];
    /** Start the analysis from what earlier analyses of this application learned, and save what this one learns. Default true. */
    useMemory?: boolean;
    /** The project's notes for the AI (memory/notes.ts): the analysis, the plan and the test writers read them; a "never" note is a hard rule. */
    siteNotes?: import("./memory/notes.js").SiteNote[];
    /** false: crawl without the page understanding additions (what an older runner sends). Default true. */
    pageUnderstanding?: boolean;
    /** What is known about the application (its latest model version): the plan and the test writers read its usable rules and workflows. */
    appKnowledge?: import("./planning/planner.js").AppKnowledge;
    /** Send every page to the AI again, even those unchanged since the last exploration (exploration reuse off for this job). Default false. */
    fullExploration?: boolean;
    /** Remove the records data-changing API tests create once the run ends (see ./cleanup). Absent: scripts remove their own records. */
    cleanup?: CleanupRequest;
    /** A saved signed-in session (hard sign-ins, see ./auth/*): exploration starts signed in with it and does not fill the sign-in form. */
    savedSession?: { storageState: import("./auth/storage-state.js").StorageState; landingUrl: string };
    /**
     * Explore and plan, then stop: nothing is generated or run. The plan comes back in `GenerationSummary.plan` so a person can look at it
     * and choose what to create. Absent: the whole pipeline runs, exactly as before.
     */
    planOnly?: boolean;
    /** Start from the plan an earlier `planOnly` run returned: discovery, understanding and planning are not repeated. */
    plan?: StoredPlan;
    /** With `plan`: test ideas (scenarioIds) the person left out. */
    excludeIdeas?: string[];
    /**
     * Explore by objectives (Phase 3): after planning, the objectives of `appKnowledge.objectiveInputs` are pursued one operator at a time
     * by the test writer inside the level's session budgets (levels.ts `exploration`, explore/loop.ts). Only a runner that lists the
     * "objectives" explore mode gets it; absent or false: the job is exactly what it was before.
     */
    objectives?: boolean;
    /**
     * The server allows data-changing operators (EXPLORE_DATA_OPERATORS=true, Decision 6). They run only with this and
     * `allowMutatingApiTests` both true; otherwise they are skipped with the reason "data changes off".
     */
    dataOperators?: boolean;
    /**
     * With `objectives`: the source refs of the objectives the project's last exploration by objectives pursued (the platform reads them
     * from that job's record, exploration-store.ts `exploredSources`). The others get priority.ts's "not explored yet" points. Absent:
     * nothing is known about earlier sessions, so no objective gets them.
     */
    exploredObjectives?: string[];
}

export interface TestHandle {
    id: string;
    testId: string;
}

/**
 * Everything the orchestrator needs persisted. Every method that reads or writes returns a promise and the engine awaits it, so the stores
 * behind it can become asynchronous (POSTGRES_S3_MIGRATION.md 3.2). `agentAction` alone stays synchronous: it is called from inside an
 * agent's tool loop, and the host queues it in order with the job's events (platform/job-write-queue.ts).
 */
export interface GenerationSink {
    phase(status: JobStatusName, phase: PhaseName, state: "running" | "done" | "skipped" | "failed"): Promise<void>;
    counters(patch: Partial<Record<string, number>>, add?: boolean): Promise<void>;
    saveModel(model: AppModel): Promise<void>;
    nextTestKey(prefix: string): Promise<string>;
    createTest(args: { spec: TestSpec; framework: Framework; validation: "PENDING" | "NEEDS_REVIEW"; reason?: string; meta?: Record<string, unknown> }): Promise<TestHandle>;
    updateTest(h: TestHandle, patch: { spec?: TestSpec; validation?: "VALIDATING" | "VALIDATED" | "FAILED_VALIDATION" | "NEEDS_REVIEW"; reason?: string | null; attempts?: number; meta?: Record<string, unknown> }): Promise<void>;
    /**
     * Put a test back as it was before this run began validating it: the job was cancelled before the test could run, so it has no
     * result and its stored status, reason and history stay exactly as they were. Hosts without persistence may leave it out.
     */
    restoreTest?(h: TestHandle): Promise<void>;
    saveScript(h: TestHandle, script: RenderedScript, executable: boolean): Promise<string>;
    recordExecution(h: TestHandle, scriptId: string | null, attempt: number, run: ScriptRun, startedAt: string): Promise<void>;
    /** Store one browser / screen-size compatibility result next to (never instead of) the test's base runs. */
    recordVariant?(h: TestHandle, scriptId: string | null, r: VariantRecord, startedAt: string): Promise<void>;
    /** Store one run against a named environment (staging, production...), tagged with it, next to the test's own runs. */
    recordEnvironment?(h: TestHandle, scriptId: string | null, r: import("./environments/run.js").EnvironmentRecord, startedAt: string): Promise<void>;
    saveTextArtifact(kind: string, name: string, content: string): Promise<void>;
    /**
     * Store one picture of the job (a JPEG of at most FRAME_LIMITS.maxBytes, its secret fields already covered) and answer its artifact
     * id: a candidate finding's screenshot, referenced by that id. Hosts without persistence may leave it out (no pictures are taken).
     */
    saveImageArtifact?(kind: "screenshot", name: string, jpeg: Uint8Array): Promise<string>;
    /** Store (or clear) the locator-repair suggestion for a test that failed because an element was missing. Suggestions only; never applied by the engine. */
    saveHealing?(h: TestHandle, result: import("./healing/heal.js").HealResult): Promise<void>;
    /** Store the ledger of records the run's tests created and what became of each (test-data cleanup). */
    saveCleanup?(items: FinishedItem[]): Promise<void>;
    /** Site memory (optional: hosts without persistence simply have none). */
    loadMemory?(origin: string): Promise<import("./memory/types.js").MemoryLoad>;
    saveMemory?(...args: Parameters<NonNullable<MemoryStorage["saveMemory"]>>): Promise<void>;
    /** Store/replace a test's approved baseline screenshots (visual regression). */
    saveBaselines(h: TestHandle, files: Array<{ name: string; path: string }>): Promise<void>;
    /** A test's approved baselines, as absolute file paths. */
    loadBaselines(h: TestHandle): Promise<Array<{ name: string; path: string }>>;
    startAgentRun(role: string, subject: string): Promise<string>;
    agentAction(runId: string, a: { tool: string; args: unknown; ok: boolean; observation: string }): void;
    finishAgentRun(runId: string, status: string, summary?: string): Promise<void>;
    /** Round 24 (optional): keep what a phone exploration or run learned about the device with the project's mobile app (platform/phone-run-store.ts). */
    rememberPhone?(d: PhoneMemory): Promise<void>;
}

/** What a phone exploration or run learned: the device it used, and the screen that opens the app there. */
export interface PhoneMemory {
    exploredOn?: import("./mobile/phone-settings.js").ExploredOn;
    appActivity?: { appPackage: string; activity: string };
}

export interface GenerationSummary {
    model: AppModel | null;
    testsGenerated: number;
    testsValidated: number;
    testsFailedValidation: number;
    testsNeedingReview: number;
    errors: string[];
    /** Set by a `planOnly` run. */
    plan?: StoredPlan;
    /** Set when the job explored by objectives (`GenerationRequest.objectives`): how the session ended and what each pursuit did. */
    exploration?: ExplorationSummary;
}

/** One objective-driven exploration session, as the job keeps it. */
export interface ExplorationSummary {
    stopReason: StopReason;
    stopDetail: string;
    /** The session budgets used (from the level, never from the request or a page). */
    budgets: Budgets & { steps: number };
    objectives: Array<Pick<Objective, "id" | "kind" | "priority" | "reason" | "operators"> & { source: string }>;
    /** Objectives the session cap left out. */
    overCap: number;
    /** Operators that did not become a pursuit, and why (e.g. "data changes off"). */
    skipped: SkippedOperator[];
    outcomes: Array<ObjectiveOutcome<PursuitResult>>;
    usage: ExplorationResult["usage"];
    /** What the session exercised and what it left (explore/coverage.ts), from the whole action log and the tests it saved. */
    coverage: CoverageRecord;
    /** The loop's action log, its first ACTION_LOG_CAP rows; `actionLogOmitted` counts the rows left out. */
    actionLog: ActionLogRow[];
    actionLogOmitted: number;
}

/** At most this many action-log rows are kept in the job summary. */
export const ACTION_LOG_CAP = 2_000;

/** The action log as the job summary keeps it: the first ACTION_LOG_CAP rows and how many were left out. */
export function boundedActionLog(rows: readonly ActionLogRow[]): { actionLog: ActionLogRow[]; actionLogOmitted: number } {
    return { actionLog: rows.slice(0, ACTION_LOG_CAP), actionLogOmitted: Math.max(0, rows.length - ACTION_LOG_CAP) };
}

/**
 * The model coverage is measured against: the crawled pages with their named elements (a page the objectives know by id keeps that id,
 * so workflow steps naming it match), objective pages the crawl did not reach, the endpoints, and the knowledge's transitions and
 * workflow steps.
 */
export function coverageModelOf(model: Pick<AppModel, "pages">, inputs: NonNullable<AppKnowledge["objectiveInputs"]>, apis: ReadonlyArray<Pick<ApiEndpointModel, "method" | "path">>): CoverageModel {
    const idOf = new Map(inputs.pages.map((p) => [p.path, p.id]));
    const crawled = new Set(model.pages.map((p) => p.path));
    return {
        pages: [
            ...model.pages.map((p) => ({ id: idOf.get(p.path) ?? p.path, path: p.path, elements: p.components.map((c) => ({ role: c.role, name: c.name })) })),
            ...inputs.pages.filter((p) => !crawled.has(p.path)).map((p) => ({ id: p.id, path: p.path })),
        ],
        workflows: inputs.workflowSteps.map((w) => ({ id: w.workflowId, steps: w.steps })),
        transitions: inputs.transitions.map((t) => ({ entity: t.entity, from: t.from, to: t.to })),
        endpoints: apis.map((a) => ({ method: a.method, path: a.path })),
    };
}

/** What one pursuit left: the saved test, or why nothing was saved. */
export interface PursuitResult {
    /** False: the recorded steps did not apply the operator, so nothing was saved for it. */
    applied?: boolean;
    authoring?: AuthorOutcome["status"];
    testKey?: string;
    /** Why the pursuit ended without a saved test. */
    ended?: string;
}

const NOISE_PATH = /^\/(_next|static|assets|cdn-cgi|__|favicon|sockjs|hot-update)/i;

const templateKey = (method: string, p: string) => `${method} ${p.replace(/\{[^}]*\}/g, "{}")}`;

function mergeApis(openapi: ApiEndpointModel[], observed: ApiEndpointModel[], allowedOrigins: Set<string>): ApiEndpointModel[] {
    const out = [...openapi];
    const have = new Set(openapi.map((o) => templateKey(o.method, o.path)));
    for (const o of observed) {
        if (!allowedOrigins.has(o.origin) || NOISE_PATH.test(o.path)) continue;
        const k = templateKey(o.method, o.path);
        if (have.has(k)) {
            // Enrich the documented operation with what was seen on the wire.
            const doc = out.find((x) => templateKey(x.method, x.path) === k)!;
            doc.usedIn = [...new Set([...doc.usedIn, ...o.usedIn])];
            doc.requiresAuth ||= o.requiresAuth;
            continue;
        }
        have.add(k);
        out.push(o);
    }
    return out;
}

export async function runGeneration(ctx: EngineContext, req: GenerationRequest, sink: GenerationSink): Promise<GenerationSummary> {
    if (!req.targets.includes("mobile")) return runWebAndApiGeneration(ctx, req, sink);
    const webAndApi = req.targets.filter((t): t is "web" | "api" => t !== "mobile");
    // Phone only: no browser is started at all.
    if (webAndApi.length === 0) return runMobileGeneration(ctx, req, sink);
    // Website or API together with the phone app: the website and API first (exactly as before), then the phone.
    const first = await runWebAndApiGeneration(ctx, { ...req, targets: webAndApi }, sink);
    const phone = await runMobileGeneration(ctx, req, sink);
    const merged: GenerationSummary = {
        model: first.model ?? phone.model,
        testsGenerated: first.testsGenerated + phone.testsGenerated,
        testsValidated: first.testsValidated + phone.testsValidated,
        testsFailedValidation: first.testsFailedValidation + phone.testsFailedValidation,
        testsNeedingReview: first.testsNeedingReview + phone.testsNeedingReview,
        errors: [...first.errors, ...phone.errors],
    };
    if (first.plan && phone.plan) {
        merged.plan = { ...first.plan, model: { ...first.plan.model, ...(phone.plan.model.mobile ? { mobile: phone.plan.model.mobile } : {}) }, scenarios: [...first.plan.scenarios, ...phone.plan.scenarios], mobile: phone.plan.mobile, warnings: [...first.plan.warnings, ...phone.plan.warnings] };
    }
    return merged;
}

async function runWebAndApiGeneration(ctx: EngineContext, req: GenerationRequest, sink: GenerationSink): Promise<GenerationSummary> {
    const started = Date.now();
    const origin = new URL(req.url).origin;
    const summary: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
    const wantWeb = req.targets.includes("web");
    // AI screen review: the request's own choice, else the level's default when the model can read images.
    const wantVision = visionOn(req, typeof ctx.llm.imageObject === "function" && ctx.llm.modelName !== "unavailable");
    // Data-changing tests on: one generator for the run, so every value it gives carries the same run tag (testdata/generate.ts).
    const testData = req.allowMutatingApiTests ? createTestData() : undefined;
    const wantApi = req.targets.includes("api");
    const creds: Credentials | undefined = req.credentials?.username && req.credentials.password ? { username: req.credentials.username, password: req.credentials.password, ...(req.credentials.totpSecret ? { totpSecret: req.credentials.totpSecret } : {}) } : undefined;

    const browser = await launchChromium(ctx.config.HEADLESS);
    try {
        let authState: AppModel["authentication"] = { required: false, mechanisms: [], loggedIn: false };
        let pages: AppModel["pages"] = [];
        let navigation: AppModel["navigation"] = [];
        /** Links and controls the crawls saw, and each test account's crawl (the screen map). */
        let crawlTransitions: CrawlTransition[] = [];
        const roleCrawls: RoleCrawl[] = [];
        let skipped = 0;
        let landingUrl: string | undefined;
        let apis: ApiEndpointModel[] = [];
        let openApiInfo: AppModel["openApi"];
        /** Whether the spec's own `servers` URL may receive test traffic (see below). */
        let specBaseTrusted = false;
        /** What the app shows to visitors and to each named test account (access-control checks). */
        let accessReach: Reach[] = [];
        /** What each account is answered by privileged-looking API endpoints (access-control checks of the API). */
        let apiAccess: ApiAccessRow[] = [];
        if (req.plan) {
            // The exploration was done and approved earlier: start from what it found (nothing is explored again).
            const stored = req.plan.model;
            pages = stored.pages;
            navigation = stored.navigation;
            apis = stored.apis;
            openApiInfo = stored.openApi;
            authState = stored.authentication;
            specBaseTrusted = req.plan.specBaseTrusted;
            accessReach = req.plan.accessReach;
            apiAccess = req.plan.apiAccess;
            await sink.counters({ pagesDiscovered: pages.length, apisDiscovered: apis.length });
            await sink.saveModel(stored);
            summary.model = stored;
            await sink.phase("DISCOVERING", "discovery", "done");
            ctx.emit({ stage: "discovery", kind: "plan_reused", message: `Starting from the plan you approved: ${pages.length} pages and ${apis.length} API endpoints (nothing is explored again)` });
        } else {
            // ── 1. DISCOVERY ───────────────────────────────────────────────────────
            await sink.phase("DISCOVERING", "discovery", "running");
            ctx.emit({ stage: "discovery", kind: "application_discovered", message: `Starting discovery of ${req.url}` });

            // The project's API credential rides on the browser's own calls to the app and its API base only (never logged).
            const exploreAuth = cleanupHeaders({ apiToken: req.credentials?.apiToken || req.credentials?.oauth2 ? await resolveApiToken(ctx, req.credentials) : undefined, apiAuthHeader: req.credentials?.apiAuthHeader });
            const session = await BrowserSession.launch(browser, {
                startUrl: req.url,
                allowedHosts: req.apiBaseUrl ? [new URL(req.apiBaseUrl).host] : [],
                ...(req.savedSession ? { storageState: req.savedSession.storageState } : {}),
                authHeaders: { headers: exploreAuth, origins: [origin, ...(req.apiBaseUrl ? [req.apiBaseUrl] : [])] },
                ...(req.siteNotes?.length ? { notes: req.siteNotes } : {}),
                secrets: authoringSecretsOf(req),
            });
            try {
                if (req.savedSession) {
                    // Signed in by hand earlier and checked just before this job: no form to fill.
                    authState = { required: true, mechanisms: ["saved-session"], loggedIn: true };
                    landingUrl = req.savedSession.landingUrl;
                    ctx.emit({ stage: "discovery", kind: "auth_succeeded", message: "Exploring signed in with the saved sign-in" });
                } else if (creds) {
                    const r = await login(session, req.url, creds, ctx.frames);
                    authState = { required: true, loginPath: r.loginPath, mechanisms: r.mechanisms, loggedIn: r.ok, loginError: r.error };
                    landingUrl = r.ok ? r.landingUrl : undefined;
                    ctx.emit({ stage: "discovery", kind: r.ok ? "auth_succeeded" : "auth_failed", level: r.ok ? "info" : "warn", message: r.ok ? `Logged in via ${r.loginPath}` : `Login failed: ${r.error}` });
                }

                if (wantWeb) {
                    const result = await crawl(session, ctx, {
                        startUrl: req.url,
                        maxPages: req.maxPages,
                        maxDepth: req.maxDepth,
                        maxPerPattern: levelSettings(req).perPattern,
                        includePaths: req.includePaths,
                        seedUrls: landingUrl ? [landingUrl] : undefined,
                        // Signed in with the project's credentials: a session that ends mid-crawl is renewed once.
                        ...(creds && authState.loggedIn ? { relogin: async () => (await login(session, req.url, creds)).ok } : {}),
                        ...(req.siteNotes?.length ? { refuse: refusedBy(req.siteNotes) } : {}),
                        ...(req.pageUnderstanding === false ? { pageUnderstanding: false } : {}),
                    });
                    // Signed in: the sign-in page and the public pages are read in one short pass signed out, within the same page cap.
                    if (authState.loggedIn) {
                        await addSignedOutPages(result, ctx, {
                            launch: () => BrowserSession.launch(browser, { startUrl: req.url, ...(req.siteNotes?.length ? { notes: req.siteNotes } : {}), secrets: authoringSecretsOf(req) }),
                            startUrl: req.url,
                            ...(authState.loginPath ? { signInPath: authState.loginPath } : {}),
                            maxPages: req.maxPages,
                            maxPerPattern: levelSettings(req).perPattern,
                            ...(req.includePaths ? { includePaths: req.includePaths } : {}),
                            ...(req.siteNotes?.length ? { refuse: refusedBy(req.siteNotes) } : {}),
                            ...(req.pageUnderstanding === false ? { pageUnderstanding: false } : {}),
                        });
                    }
                    pages = result.pages;
                    navigation = result.navigation;
                    crawlTransitions = result.transitions;
                    skipped = result.skipped;
                    if (!authState.required) {
                        const loginPage = pages.find((p) => p.type === "login");
                        if (loginPage) authState = { ...authState, required: true, loginPath: loginPage.path, mechanisms: ["form"] };
                        const signup = pages.find((p) => p.type === "register");
                        if (signup) authState.signupPath = signup.path;
                    }
                }

                // Who can reach what: a small crawl as a visitor and as each named test account.
                if (wantWeb && req.accessChecks !== false && req.roles?.length) {
                    try {
                        // Each viewer gets its share of the level's page budget (at least 20) and the level's depth.
                        accessReach = await surveyAccess(ctx, browser, req.url, req.roles, {
                            maxPages: rolePageBudget(req.maxPages, req.roles.length),
                            maxDepth: req.maxDepth,
                            perPattern: levelSettings(req).perPattern,
                            ...(req.siteNotes?.length ? { refuse: refusedBy(req.siteNotes) } : {}),
                            ...(req.apiBaseUrl ? { apiHosts: [req.apiBaseUrl] } : {}),
                            onCrawl: (who, r) => {
                                if (who !== "anonymous") roleCrawls.push({ who, pages: r.pages, transitions: r.transitions });
                            },
                        });
                        ctx.emit({ stage: "discovery", kind: "access_survey_done", message: `Access survey: ${accessReach.map((r) => `${r.who} reaches ${r.pages.length} pages`).join(", ")}` });
                    } catch (e) {
                        ctx.emit({ stage: "discovery", kind: "access_survey_failed", level: "warn", message: `Access survey failed: ${e instanceof Error ? e.message : String(e)}` });
                    }
                }

                if (!wantWeb) {
                    // API-only jobs still load the start page once so traffic (and any spec fetch) is observed.
                    session.network.setCurrentPage(req.url);
                    await session.page.goto(req.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
                    await settle(session.page);
                }

                // API discovery: OpenAPI/Swagger documents + traffic observed while crawling.
                const apiOrigin = req.apiBaseUrl ? new URL(req.apiBaseUrl).origin : origin;
                let probe = wantApi || wantWeb ? await probeOpenApi(session.context.request, apiOrigin, req.openApiUrl) : null;
                if (!probe && !req.openApiUrl) {
                    // Swagger-UI style apps fetch their own spec; try spec-looking URLs seen on the wire.
                    const ours = new Set([origin, apiOrigin]);
                    for (const ep of session.network.getDiscoveredEndpoints().filter((e) => e.method === "GET" && ours.has(e.origin) && /openapi|swagger|api-docs/i.test(e.path)).slice(0, 3)) {
                        probe = await probeOpenApi(session.context.request, ep.origin, ep.origin + (ep.examplePath ?? ep.path));
                        if (probe) break;
                    }
                }
                if (probe) {
                    // A spec's `servers` URL is attacker/third-party controlled input: if it points anywhere other
                    // than the app under test (or the explicit apiBaseUrl), test traffic — and the user's API token —
                    // would follow it there (production, cloud metadata endpoints...). Only trust same-origin.
                    specBaseTrusted = [origin, apiOrigin].includes(new URL(probe.parsed.baseUrl).origin);
                    if (!specBaseTrusted) {
                        ctx.emit({
                            stage: "discovery",
                            kind: "api_base_ignored",
                            level: "warn",
                            message: `OpenAPI servers URL ${probe.parsed.baseUrl} is not the application's origin; API tests will target ${apiOrigin} instead (set apiBaseUrl to override)`,
                        });
                    }
                    openApiInfo = { url: probe.url, version: probe.parsed.version, title: probe.parsed.title, operationCount: probe.parsed.operations.length, baseUrl: probe.parsed.baseUrl };
                    ctx.emit({ stage: "discovery", kind: "api_discovered", message: `OpenAPI document found at ${probe.url} (${probe.parsed.operations.length} operations)` });
                }
                const allowed = new Set([origin, apiOrigin, ...(probe && specBaseTrusted ? [new URL(probe.parsed.baseUrl).origin] : [])]);
                const specPath = probe ? new URL(probe.url).pathname : undefined;
                apis = mergeApis(probe?.parsed.operations ?? [], session.network.getDiscoveredEndpoints(), allowed).filter(
                    // The API description document itself is not an endpoint under test.
                    (a) => a.path !== specPath && !/\/(openapi|swagger)(\.json|\.ya?ml)?$|\/api-docs$/i.test(a.path),
                );
                // Who is answered by privileged-looking endpoints: one GET each as a visitor and per account with an API token.
                if (wantApi && req.accessChecks !== false && req.roles?.some((r) => r.apiToken)) {
                    try {
                        const callable = apis.flatMap((a) => {
                            if (a.method !== "GET") return [];
                            const called = a.source === "openapi" ? fillApiPath(a.path, a) : (a.examplePath ?? a.path);
                            return called && !called.includes("{") ? [{ method: a.method, path: a.path, called }] : [];
                        });
                        apiAccess = await surveyApiAccess(session.context.request, apiOrigin, callable, req.roles);
                        ctx.emit({ stage: "discovery", kind: "api_access_survey_done", message: `API access survey: ${apiAccess.length} privileged-looking endpoints called as ${["a visitor", ...req.roles.filter((r) => r.apiToken).map((r) => r.name)].join(", ")}` });
                    } catch (e) {
                        ctx.emit({ stage: "discovery", kind: "api_access_survey_failed", level: "warn", message: `API access survey failed: ${e instanceof Error ? e.message : String(e)}` });
                    }
                }
                for (const a of apis.filter((x) => x.source === "network")) {
                    ctx.emit({ stage: "discovery", kind: "api_discovered", message: `Observed ${a.method} ${a.path} → ${a.statuses.join("/")}` });
                }
                if (authState.loggedIn === false && session.network.getAuthSchemes().length) authState.mechanisms = [...new Set([...authState.mechanisms, ...session.network.getAuthSchemes()])];

                // Tests/APIs the site documents about itself (/test_cases, /api_list). Documented
                // endpoints only fill gaps: OpenAPI and observed traffic are more precise.
                let documentedTestCases: AppModel["documentedTestCases"] = [];
                if (wantWeb) {
                    const docs = await scrapeDocumentationPages(session, ctx, origin, pages.flatMap((p) => p.links));
                    documentedTestCases = docs.testCases;
                    const have = new Set(apis.map((a) => templateKey(a.method, a.path)));
                    for (const a of documentedApiModels(docs.apis, origin)) {
                        const k = templateKey(a.method, a.path);
                        if (!allowed.has(a.origin) || have.has(k)) continue;
                        have.add(k);
                        apis.push(a);
                    }
                }

                const external = session.network.getExternalHosts();
                const base: Omit<AppModel, "siteType" | "purpose" | "features" | "journeys"> = {
                    url: req.url,
                    origin,
                    pages,
                    navigation,
                    apis,
                    openApi: openApiInfo,
                    authentication: authState,
                    externalDependencies: external,
                    ...(session.network.getWebSockets().length ? { webSockets: session.network.getWebSockets() } : {}),
                    documentedTestCases,
                    stats: { pagesVisited: pages.length, pagesSkipped: skipped, apisFound: apis.length, durationMs: Date.now() - started },
                    ...(wantWeb && pages.length ? { screenMap: buildScreenMap({ pages, transitions: crawlTransitions }, roleCrawls) } : {}),
                };
                await sink.counters({ pagesDiscovered: pages.length, apisDiscovered: apis.length });
                await sink.saveModel({ ...base, siteType: "unknown", purpose: "", features: [], journeys: [] });
                summary.model = { ...base, siteType: "unknown", purpose: "", features: [], journeys: [] };
                await sink.phase("DISCOVERING", "discovery", "done");

                if (wantWeb && pages.length === 0) throw new Error(`Discovery found no loadable pages at ${req.url}`);
            } finally {
                await session.close();
            }
        }
        throwIfAborted(ctx.signal);

        // ── 2-3. UNDERSTANDING + PLANNING (LLM, web) ──────────────────────────
        let scenarios: Scenario[] = [];
        /** The ids of the job's requirements, as the planner keeps them: an expected result naming one its scenario covers is stated (author.ts statedSource). */
        let requirementIds: string[] = [];
        let model: AppModel = summary.model!;
        // Site memory informs the prompts below and the change summary; the crawl above already ran in full.
        const memory = await openMemory(ctx, sink, { origin, enabled: req.useMemory !== false, secrets: secretValues(req) });
        const validatedScenarioIds = new Set<string>();
        /** Whether the AI understanding step ran (site memory is only updated after it). */
        let analysed = Boolean(req.plan?.analysed);
        /** Why planning failed, when it did after the understanding step answered. */
        let planningFailed: string | undefined;
        /** Why the AI could not read the application, when an AI model is set up but the understanding call failed. */
        let readingFailed: string | undefined;
        if (req.plan) {
            // The test ideas were planned and shown earlier; the person may have left some out.
            const left = new Set(req.excludeIdeas ?? []);
            // Test ideas for a phone app (M-01...) belong to the phone branch, never to the browser.
            scenarios = wantWeb ? req.plan.scenarios.filter((x) => !left.has(x.scenarioId) && !/^M-\d+$/.test(x.scenarioId)) : [];
            // The project's testing agents may have dropped the Test Case Generation Agent since the plan was made: its ideas are left out.
            if (req.functionalTests === false && scenarios.length) {
                ctx.emit({ stage: "planning", kind: "functional_tests_off", message: `No functional test cases are created: this project's testing agents do not include the Test Case Generation Agent any more, so the plan's ${scenarios.length} test idea(s) are left out.` });
                scenarios = [];
            }
            if (analysed) memory.analysed(model);
            await sink.counters({ journeysIdentified: model.journeys.length, scenariosPlanned: scenarios.length });
            await sink.phase("ANALYZING", "understanding", analysed ? "done" : "skipped");
            await sink.phase("PLANNING", "planning", analysed ? "done" : "skipped");
        } else if (wantWeb && pages.length > 0) {
            try {
                await sink.phase("ANALYZING", "understanding", "running");
                const { siteType: _s, purpose: _p, features: _f, journeys: _j, ...base } = model;
                memory.noteCrawl(model);
                // Exploration reuse (memory/reuse.ts): pages unchanged since the last exploration are not sent to the AI again.
                const reuse = explorationReuseOn(ctx.config) && !req.fullExploration ? memory.reusable(model) : undefined;
                if (req.fullExploration && memory.hasPrevious) ctx.emit({ stage: "analysis", kind: "full_exploration", message: "Exploring every page again, as asked: nothing is reused from the last exploration." });
                if (reuse?.pages.size) ctx.emit({ stage: "analysis", kind: EVENT_PAGES_REUSED, message: reuseMessage(reuse, model.pages.length), data: { pages: reuse.pages.size, of: model.pages.length } });
                model = await analyzeApplication(ctx, base, { memory: memory.context("understanding"), notes: req.siteNotes, digestElementsPerPage: levelSettings(req).digestElementsPerPage, ...(reuse?.pages.size ? { reuse } : {}), ...(req.pageUnderstanding === false ? { linkSteps: false } : {}) });
                memory.analysed(model);
                analysed = true;
                summary.model = model;
                await sink.saveModel(model);
                await sink.counters({ journeysIdentified: model.journeys.length });
                await sink.phase("ANALYZING", "understanding", "done");
                throwIfAborted(ctx.signal);

                await sink.phase("PLANNING", "planning", "running");
                const warningsBefore = summary.errors.length;
                const requirements = req.requirements ? await parseRequirements(ctx, req.requirements.text) : undefined;
                requirementIds = requirements?.map((r) => r.id) ?? [];
                if (req.requirements) {
                    ctx.emit({ stage: "planning", kind: "requirements_parsed", message: `${requirements!.length} requirements extracted from ${req.requirements.name}` });
                }
                // The project's testing agents leave out the Test Case Generation Agent: no journeys are planned, only the checks run.
                if (req.functionalTests === false) ctx.emit({ stage: "planning", kind: "functional_tests_off", message: "No functional test cases are planned: this project's testing agents do not include the Test Case Generation Agent." });
                scenarios =
                    req.functionalTests === false
                        ? []
                        : await planScenarios(ctx, model, {
                              maxScenarios: req.maxScenarios,
                              hasCredentials: Boolean(creds && authState.loggedIn),
                              scope: req.scope,
                              requirements,
                              memory: memory.context("planning"),
                              notes: req.siteNotes,
                              ...(req.appKnowledge ? { knowledge: req.appKnowledge } : {}),
                              digestElementsPerPage: levelSettings(req).digestElementsPerPage,
                              roles: req.roles?.map((r) => r.name),
                              roleDifferences: roleDifferences(accessReach),
                              warnings: summary.errors,
                              ...(testData ? { testData: { tag: testData.tag } } : {}),
                          });
                // A planning call that did not finish is said as a warning when the others answered (planner.ts).
                if (summary.errors.length > warningsBefore) planningFailed = summary.errors[summary.errors.length - 1];
                await sink.counters({ scenariosPlanned: scenarios.length });
                if (requirements?.length) {
                    const coverage = requirementsCoverage(requirements, scenarios);
                    await sink.counters({ requirementsTotal: requirements.length, requirementsCovered: coverage.covered.length });
                    for (const u of coverage.uncovered) {
                        ctx.emit({ stage: "planning", kind: "requirement_uncovered", level: "warn", message: `${u.id} not covered by any scenario: ${u.text.slice(0, 160)}` });
                    }
                    await sink.saveTextArtifact(
                        "requirements-coverage",
                        "requirements-coverage.json",
                        JSON.stringify({ document: req.requirements!.name, requirements, ...coverage, scenarios: scenarios.map((s) => ({ scenarioId: s.scenarioId, title: s.title, requirements: s.requirements })) }, null, 2),
                    );
                }
                await sink.phase("PLANNING", "planning", "done");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // A reached AI limit is reported in its own plain words (see engine/llm/usage.ts), not as a failure of the analysis.
                if (analysed) planningFailed = msg;
                // No AI model or key on purpose keeps today's way (checks only); a model that is set up but failed to read the app fails the job.
                else if (!(err instanceof LlmNotConfiguredError || (err instanceof Error && err.name === "LlmNotConfiguredError"))) readingFailed = msg;
                summary.errors.push(isBudgetExceeded(err) ? msg : `Web analysis/planning failed: ${msg}`);
                ctx.emit({ stage: "analysis", kind: "stage_failed", level: isBudgetExceeded(err) ? "warn" : "error", message: msg });
                await sink.phase("ANALYZING", "understanding", "failed");
                await sink.phase("PLANNING", "planning", "failed");
            }
        } else {
            await sink.phase("ANALYZING", "understanding", "skipped");
            await sink.phase("PLANNING", "planning", "skipped");
        }
        throwIfAborted(ctx.signal);
        // An AI model is set up but reading the application failed: the job fails and says why, rather than ending with only its checks.
        if (readingFailed) throw new Error(`The application could not be read with AI: ${readingFailed.trim().replace(/\.+$/, "")}.`);
        // Functional test cases were wanted, planning failed and nothing was planned: the job fails and says why, rather than ending
        // with only its checks. An empty plan on purpose (functional test cases off) or one where nothing failed goes on as before.
        if (planningFailed && !scenarios.length && req.functionalTests !== false) {
            throw new Error(`No test ideas were planned because planning failed: ${planningFailed.trim().replace(/\.+$/, "")}.`);
        }

        if (req.planOnly) {
            // The person looks at the plan and chooses; nothing is generated or run until they do.
            await sink.phase("GENERATING", "generation", "skipped");
            await sink.phase("VALIDATING", "validation", "skipped");
            summary.plan = { version: 1, createdAt: new Date().toISOString(), model, scenarios, analysed, specBaseTrusted, accessReach, apiAccess, warnings: [...summary.errors] };
            await sink.counters({ llmInputTokens: ctx.llm.usage.inputTokens, llmOutputTokens: ctx.llm.usage.outputTokens });
            ctx.emit({ stage: "orchestration", kind: "plan_ready", message: `Plan ready: ${pages.length} pages, ${apis.length} API endpoints and ${scenarios.length} journeys planned. Nothing was created yet.` });
            return summary;
        }

        // ── 4. GENERATION ─────────────────────────────────────────────────────
        await sink.phase("GENERATING", "generation", "running");
        const pending: TestUnderValidation[] = [];
        const handles = new Map<string, TestHandle>();
        /** Current script row per test, so executions always reference the script version that ran. */
        const scriptIds = new Map<string, string>();
        const renderCtx = { baseUrl: origin, apiBaseUrl: req.apiBaseUrl ?? (specBaseTrusted ? model.openApi?.baseUrl : undefined) ?? origin, deleteOps: deleteOperationsOf(model.apis), ...(req.siteNotes?.length ? { notes: req.siteNotes } : {}) };

        /** What each new test was created with, so later additions (its strength) keep the rest. */
        const metas = new Map<string, Record<string, unknown>>();
        const persistNew = async (spec: TestSpec, framework: Framework, validation: "PENDING" | "NEEDS_REVIEW", reason?: string, meta?: Record<string, unknown>) => {
            // Stored sign-in details only go to the application's own site: refused before anything is created.
            assertCredentialsStayHome(spec, renderCtx);
            // Which model version of the application the test was made from, when the exploration had one.
            if (req.appKnowledge) meta = { ...meta, modelVersion: req.appKnowledge.modelVersionId };
            const h = await sink.createTest({ spec, framework, validation, reason, meta });
            // The host takes the key at save (another scenario may have saved under the one asked for): the spec, its script and
            // everything after go by the key the test was saved under.
            spec.testId = h.testId;
            handles.set(spec.testId, h);
            metas.set(spec.testId, meta ?? {});
            const script = renderWithAdapter(spec, framework, renderCtx);
            scriptIds.set(spec.testId, await sink.saveScript(h, script, true));
            await sink.counters({ testsGenerated: 1 }, true);
            summary.testsGenerated++;
            return h;
        };

        /**
         * Saves what the test writer made of a scenario: a defect test with its candidate finding (S1, replayed twice in fresh browsers
         * without AI) for review, or a complete test for validation. Returns the saved test's key.
         */
        const keepAuthored = async (scenario: Scenario, outcome: Exclude<AuthorOutcome, { status: "blocked" }>, asAccount: ReturnType<typeof roleCredentials>, scenarioRules: KnowledgeRule[]): Promise<string> => {
            const key = await sink.nextTestKey("WEB");
            const written = toSpec(scenario, outcome, key);
            const spec = TestSpecSchema.parse(asAccount ? asRole(written, asAccount.name) : written);
            const meta = { model: ctx.llm.modelName, scenario, authoring: outcome.status, explanation: outcome.explanation, ...(outcome.observations?.length ? { visionObservations: outcome.observations } : {}) };
            // The leftover check (web/leftovers.ts, no AI): a test that still acts on or checks an item its own steps never added or opened,
            // after its second try, leans on what the account held. Saved for review, never validated, and never a finding.
            const leftovers = findLeftoverUse(written.steps);
            if (leftovers.length) {
                const why = leftoverReason(leftovers);
                const h = await persistNew(spec, "playwright", "NEEDS_REVIEW", `${outcome.status === "defect" ? "Not reported as a finding" : "Not validated"}: ${why.replace(/\.$/, "")}. The test writer's account: ${outcome.explanation.trim().replace(/\.+$/, "").slice(0, 1_000)}.`, { ...meta, leftovers });
                summary.testsNeedingReview++;
                await sink.counters({ testsNeedingReview: 1 }, true);
                ctx.emit({ stage: "generation", kind: "depends_on_earlier_state", level: "warn", message: `${h.testId} ${spec.title}: saved for review; ${why}`, data: { testKey: h.testId, steps: leftovers.map((u) => u.step) } });
                return h.testId;
            }
            if (outcome.status === "defect") {
                // S1: a captured defect is replayed twice in fresh browsers (no AI), and the test carries its candidate finding.
                const capture = outcome.capture ?? "observed_only";
                const replayed = { steps: written.steps, testData: written.testData, ...(asAccount ? { credentials: asAccount.credentials } : creds && authState.loggedIn ? { credentials: creds } : {}) };
                // An observed-only defect test holds only steps that passed while authoring: replayed once (no AI), a step it stops at means
                // the test cannot pass its own steps, so it is a broken test, not a finding. Saved as a failed test, without a candidate finding.
                const own = capture === "observed_only" ? await replayOwnSteps(browser, origin, replayed).catch(() => undefined) : undefined;
                if (own?.outcome === "failed") {
                    const h = await persistNew(spec, "playwright", "PENDING", undefined, { ...meta, capture, ownReplay: own });
                    await sink.updateTest(h, {
                        validation: "FAILED_VALIDATION",
                        reason: `Not reported as a finding: the saved test did not pass a replay of its own steps (${own.summary.replace(/\.+$/, "")}), so it does not show the problem the test writer reported: ${outcome.explanation.trim().replace(/\.+$/, "").slice(0, 1_000)}.`,
                    });
                    summary.testsFailedValidation++;
                    await sink.counters({ testsFailedValidation: 1 }, true);
                    ctx.emit({
                        stage: "generation",
                        kind: "defect_unverified",
                        level: "warn",
                        message: `${h.testId} ${spec.title}: not reported as a finding; its saved test stopped at step ${own.failedStep} when replayed on its own`,
                        data: { testKey: h.testId, capture, failedStep: own.failedStep ?? null },
                    });
                    return h.testId;
                }
                // Row 173: where a replay stops, a picture with the secret fields covered (as the Explorer view's) is kept as the finding's evidence.
                const shoot = sink.saveImageArtifact ? findingShooter(sink.saveImageArtifact.bind(sink), authoringSecretsOf(req), key) : undefined;
                const independence =
                    capture === "captured"
                        ? await checkIndependence(browser, origin, replayed, shoot ? { shoot } : {}).catch(() => ({ independence: "not_run" as const, replays: [] }))
                        : { independence: "not_run" as const, replays: [] };
                const found = defectFinding({ scenario, rules: scenarioRules, requirementIds, outcome, capture, independence, stepCount: spec.steps.length, modelVersion: req.appKnowledge?.modelVersionId ?? null });
                const defectMeta = { ...meta, capture, ...(outcome.capturedCheck ? { capturedCheck: outcome.capturedCheck } : {}), ...(found.finding ? { finding: found.finding } : {}) };
                const saved = (await persistNew(spec, "playwright", "NEEDS_REVIEW", `The application did not behave as expected: ${outcome.explanation.trim().replace(/\.+$/, "")}. ${found.basis}`, defectMeta)).testId;
                if (!found.finding) ctx.emit({ stage: "generation", kind: "finding_invalid", level: "warn", message: `${saved} ${spec.title}: its candidate finding could not be built (${found.problem}); the test is saved for review without it.` });
                summary.testsNeedingReview++;
                await sink.counters({ testsNeedingReview: 1 }, true);
                ctx.emit({
                    stage: "generation",
                    kind: "possible_defect",
                    level: "warn",
                    message: `${saved} ${spec.title}: ${outcome.explanation}`,
                    data: { testKey: saved, capture, confidence: found.confidence, independence: independence.independence, source: found.source },
                });
                return saved;
            }
            await persistNew(spec, "playwright", "PENDING", undefined, meta);
            pending.push({ spec, framework: "playwright", scenario, ...(scenarioRules.length ? { rules: scenarioRules } : {}), ...(requirementIds.length ? { requirementIds } : {}) });
            ctx.emit({ stage: "generation", kind: "script_generated", message: `${spec.testId} ${spec.title} (${spec.steps.length} steps)` });
            return spec.testId;
        };

        // 4a. Web: author every scenario in a real browser, one agent run per scenario.
        if (scenarios.length) {
            // One lane per account: scenarios that sign in as the same account share its state on the server (cart, discount,
            // profile), so they are written one at a time; signed-out ones and other accounts' run beside them, up to CONCURRENCY.
            const laneOf = (scenario: Scenario): string | undefined => {
                const role = roleCredentials(scenario, req.roles);
                if (role) return `role:${role.name.toLowerCase().replace(/-/g, "_")}`;
                return scenario.requiresAuth && creds && authState.loggedIn ? "main" : undefined;
            };
            const sharing = scenarios.filter((s, _, all) => laneOf(s) !== undefined && all.filter((o) => laneOf(o) === laneOf(s)).length > 1).length;
            if (sharing) ctx.emit({ stage: "generation", kind: "account_lanes", message: `${sharing} scenarios that sign in as the same account are written one at a time` });
            const results = await mapLanes(scenarios, ctx.config.CONCURRENCY, laneOf, async (scenario) => {
                throwIfAborted(ctx.signal);
                const runId = await sink.startAgentRun("web-authoring", `${scenario.scenarioId} ${scenario.title}`);
                try {
                    // A role scenario is written signed in as its own test account, and its script runs as that account.
                    const asAccount = roleCredentials(scenario, req.roles);
                    const scenarioRules = rulesForScenario(scenario, req.appKnowledge);
                    const outcome = await authorWebSpec({
                        ctx,
                        browser,
                        baseUrl: origin,
                        model,
                        scenario,
                        credentials: asAccount ? asAccount.credentials : creds && authState.loggedIn ? creds : undefined,
                        onAction: (a) => sink.agentAction(runId, a),
                        vision: wantVision,
                        maxSteps: levelSettings(req).authoringMaxSteps,
                        review: true,
                        retryBlocked: true,
                        leftoverCheck: true,
                        ...(testData ? { testData } : {}),
                        ...(req.siteNotes?.length ? { notes: req.siteNotes } : {}),
                        ...(scenarioRules.length ? { rules: scenarioRules } : {}),
                        ...(requirementIds.length ? { requirementIds } : {}),
                        // Masking only: what the application shows the AI is cleaned of every secret of the run, not just the sign-in password.
                        secrets: authoringSecretsOf(req),
                    });
                    await sink.finishAgentRun(runId, outcome.status, outcome.explanation);
                    if (outcome.status === "blocked") {
                        await sink.counters({ scenariosSkipped: 1 }, true);
                        // Planned coverage was not delivered, so the job must not report COMPLETED.
                        summary.errors.push(`Scenario ${scenario.scenarioId} "${scenario.title}" could not be authored`);
                        ctx.emit({ stage: "generation", kind: "scenario_skipped", level: "warn", message: `${scenario.scenarioId} "${scenario.title}" could not be authored: ${outcome.explanation}` });
                        return;
                    }
                    await keepAuthored(scenario, outcome, asAccount, scenarioRules);
                } catch (err) {
                    await sink.finishAgentRun(runId, "error", err instanceof Error ? err.message : String(err));
                    throw err;
                }
            });
            for (const r of results) {
                if (!r.ok) {
                    await sink.counters({ scenariosSkipped: 1 }, true);
                    const msg = r.error instanceof Error ? r.error.message : String(r.error);
                    if (isBudgetExceeded(r.error)) {
                        // One line for the whole job, however many scenarios were still waiting when the limit was reached.
                        if (!summary.errors.includes(msg)) summary.errors.push(msg);
                        ctx.emit({ stage: "generation", kind: "scenario_skipped", level: "warn", message: `${r.item.scenarioId} was not authored: ${msg}` });
                        continue;
                    }
                    summary.errors.push(`Authoring "${r.item.title}": ${msg}`);
                    ctx.emit({ stage: "generation", kind: "scenario_failed", level: "error", message: `${r.item.scenarioId}: ${msg}` });
                }
            }
        }

        // 4a2. Objective-driven exploration (Phase 3, only when asked): the objectives of the application's model, one operator at a
        // time, written by the test writer inside the level's session budgets. Objectives and budgets are fixed here, before any page of
        // the session is read; the loop (explore/loop.ts) counts actions and AI calls itself and ends the session with one stop reason.
        if (wantWeb && req.objectives === true) {
            const knowledge = req.appKnowledge;
            if (!knowledge?.objectiveInputs) {
                ctx.emit({ stage: "generation", kind: "objectives_unavailable", level: "warn", message: "Exploring by objectives needs an analysed model of the application, and there is none yet, so this exploration ran without objectives." });
            } else {
                const lv = levelSettings(req);
                const b = lv.exploration;
                const dataOperators = req.dataOperators === true && req.allowMutatingApiTests === true;
                const requiresAuth = Boolean(creds && authState.loggedIn);
                const built = objectivePursuits(knowledge, { maxObjectives: b.objectives, steps: lv.authoringMaxSteps, perObjective: b.perObjective, dataOperators, requiresAuth, ...(req.exploredObjectives ? { explored: req.exploredObjectives } : {}) });
                const budgets: Budgets = { objectives: b.objectives, actions: b.actions, aiCalls: b.aiCalls, tokens: b.tokens, minutes: b.minutes, depth: b.depth };
                ctx.emit({
                    stage: "generation",
                    kind: "objectives_planned",
                    message: `${built.objectives.length} objective(s) to explore as ${built.pursuits.length} pursuit(s); ${built.skipped.length} operator(s) not run${built.overCap ? `; ${built.overCap} objective(s) over the session's limit of ${b.objectives}` : ""}.`,
                    data: { objectives: built.objectives.length, pursuits: built.pursuits.length, skipped: built.skipped.length, overCap: built.overCap, budgets: { ...budgets, steps: lv.authoringMaxSteps } },
                });
                // The run's own AI counter: every call the test writer makes in this stage goes through `gatedLlm` and is counted there.
                const calls = { n: 0 };
                // The tests this stage saved, for the coverage record.
                const saved: CoverageTest[] = [];
                const tokensNow = () => ctx.llm.usage.inputTokens + ctx.llm.usage.outputTokens;
                const pursue = async (p: ObjectivePursuit, loop: ObjectiveContext): Promise<ObjectiveRun<PursuitResult>> => {
                    const startedAt = Date.now();
                    const tokensAt = tokensNow();
                    const gate = () => {
                        const stop = loop.check();
                        if (stop) throw new ExplorationStopped(`The session stopped (${stop}).`);
                        if (loop.signal.aborted) throw new ExplorationStopped("The exploration ended this pursuit.");
                        if (Date.now() - startedAt >= p.objective.budget.minutes * 60_000) throw new ExplorationStopped(`The objective's time limit of ${p.objective.budget.minutes} minutes was reached.`);
                        if (tokensNow() - tokensAt >= p.objective.budget.tokens) throw new ExplorationStopped(`The objective's limit of ${p.objective.budget.tokens} AI tokens was reached.`);
                        calls.n += 1;
                    };
                    const signal = ctx.signal ? AbortSignal.any([ctx.signal, loop.signal]) : loop.signal;
                    const state = actionTracker(new URL(p.scenario.startPath, origin).href);
                    const rules = p.objective.kind === "rule" ? usableRules(knowledge.rules).filter((r) => r.ref === p.objective.source.ref) : rulesForScenario(p.scenario, knowledge);
                    const runId = await sink.startAgentRun("web-authoring", `${p.scenario.scenarioId} ${p.scenario.title}`);
                    let outcome: AuthorOutcome;
                    try {
                        outcome = await authorWebSpec({
                            ctx: { ...ctx, llm: gatedLlm(ctx.llm, gate), signal },
                            browser,
                            baseUrl: origin,
                            model,
                            scenario: p.scenario,
                            credentials: requiresAuth ? creds : undefined,
                            onAction: (a) => {
                                sink.agentAction(runId, a);
                                // Told after the action ran (the test writer has no hook before it): a refusal ends the pursuit before its next model call.
                                if (a.tool !== "finish") loop.act(state(a));
                            },
                            vision: wantVision,
                            maxSteps: Math.min(lv.authoringMaxSteps, p.objective.budget.steps),
                            review: true,
                            leftoverCheck: true,
                            ...(testData ? { testData } : {}),
                            ...(req.siteNotes?.length ? { notes: req.siteNotes } : {}),
                            ...(rules.length ? { rules } : {}),
                            secrets: authoringSecretsOf(req),
                        });
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        await sink.finishAgentRun(runId, "error", msg);
                        // Ended by the loop or by the objective's own limits: an ended pursuit, not a broken environment.
                        if (loop.signal.aborted || err instanceof ExplorationStopped || (err instanceof Error && err.cause instanceof ExplorationStopped)) return { status: "completed", result: { ended: err instanceof ExplorationStopped ? msg : "The exploration ended this pursuit." } };
                        if (isBudgetExceeded(err) && !summary.errors.includes(msg)) summary.errors.push(msg);
                        return { status: "environment_failure", reason: msg };
                    }
                    await sink.finishAgentRun(runId, outcome.status, outcome.explanation);
                    if (outcome.status === "blocked" || loop.signal.aborted) {
                        ctx.emit({ stage: "generation", kind: "objective_not_written", message: `${p.scenario.scenarioId}: no test was saved (${loop.signal.aborted ? "the exploration ended this pursuit" : outcome.explanation}).` });
                        return { status: "completed", result: { authoring: outcome.status, ended: loop.signal.aborted ? "The exploration ended this pursuit." : outcome.explanation } };
                    }
                    if (!operatorApplied(outcome.steps, p.operator, p.check)) {
                        ctx.emit({ stage: "generation", kind: "operator_not_applied", level: "warn", message: `${p.scenario.scenarioId}: the recorded steps do not apply the operator "${p.operator}", so no test was saved for it.` });
                        return { status: "completed", result: { applied: false, authoring: outcome.status } };
                    }
                    const testKey = await keepAuthored(p.scenario, outcome, undefined, rules);
                    saved.push({ objective: { id: p.objective.id, operator: p.operator }, steps: outcome.steps });
                    return { status: "completed", result: { applied: true, authoring: outcome.status, testKey } };
                };
                const session = await runExploration<ObjectivePursuit, PursuitResult>({
                    objectives: built.pursuits,
                    budgets,
                    runObjective: pursue,
                    now: Date.now,
                    usage: () => ({ aiCalls: calls.n, tokens: tokensNow() }),
                    // Each pursuit's test writer opens a new browser context of its own; the reset checks the browser is still there.
                    reset: async () => {
                        if (!browser.isConnected()) throw new Error("The browser is no longer running.");
                    },
                    ...(ctx.signal ? { cancel: ctx.signal } : {}),
                    // Row 173: the run page's live list. Ids and operator names only: no page text, no prompts.
                    onPursuit: (p, done) => {
                        const data = { objectiveId: p.objective.id, operator: p.operator, ...(done ? { outcome: done.status } : {}) };
                        ctx.emit({ stage: "generation", kind: done ? "objective_finished" : "objective_started", message: `${p.objective.id} ${p.operator}: ${done ? `finished (${done.status})` : "started"}`, data });
                    },
                });
                summary.exploration = {
                    stopReason: session.stopReason,
                    stopDetail: session.stopDetail,
                    budgets: { ...budgets, steps: lv.authoringMaxSteps },
                    objectives: built.objectives.map((o) => ({ id: o.id, kind: o.kind, source: o.source.ref, priority: o.priority, reason: o.reason, operators: o.operators })),
                    overCap: built.overCap,
                    skipped: built.skipped,
                    outcomes: session.outcomes,
                    usage: session.usage,
                    coverage: coverageOf({ model: coverageModelOf(model, knowledge.objectiveInputs, apis), objectives: built.objectives, outcomes: session.outcomes, actionLog: session.actionLog, tests: saved, skipped: built.skipped }),
                    ...boundedActionLog(session.actionLog),
                };
                ctx.emit({
                    stage: "generation",
                    kind: "exploration_stopped",
                    level: session.stopReason === "objectives_done" ? "info" : "warn",
                    message: `Exploring by objectives stopped: ${session.stopDetail}`,
                    data: { stopReason: session.stopReason, pursued: session.usage.objectives, actions: session.usage.actions, aiCalls: session.usage.aiCalls },
                });
                throwIfAborted(ctx.signal);
            }
        }

        // 4b. API: deterministic from OpenAPI / observed traffic.
        if (wantApi && apis.length) {
            const { specs, skippedMutating } = generateApiSpecs(apis, { allowMutating: req.allowMutatingApiTests, maxPerEndpoint: 6, contractChecks: req.contractChecks !== false });
            if (skippedMutating) {
                ctx.emit({ stage: "generation", kind: "api_mutating_skipped", message: `Skipped ${skippedMutating} state-changing endpoints (enable allowMutatingApiTests to include them)` });
            }
            const docs = new Map(apis.map((a) => [`${a.method} ${a.path}`, a]));
            for (const d of specs as DraftSpec[]) {
                const key = await sink.nextTestKey("API");
                const spec = TestSpecSchema.parse({ ...d, testId: key });
                const endpointKey = d.title.split(":")[0]!;
                const ep = docs.get(endpointKey);
                await persistNew(spec, "playwright-api", "PENDING", undefined, { endpoint: endpointKey });
                pending.push({ spec, framework: "playwright-api", endpointDoc: ep ? { method: ep.method, path: ep.path, statuses: ep.statuses, requiresAuth: ep.requiresAuth, summary: ep.summary, spec: ep.spec } : undefined });
            }
            ctx.emit({ stage: "generation", kind: "api_tests_generated", message: `${specs.length} API tests generated from ${apis.length} endpoints` });

            // 4b1. Access control for API endpoints (deterministic): a visitor or a lesser account must be refused.
            if (req.accessChecks !== false && apiAccess.length) {
                const access = generateApiAccessSpecs(apiAccess);
                for (const d of access) {
                    const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("API") });
                    await persistNew(spec, "playwright-api", "PENDING", undefined, { access: true });
                    pending.push({ spec, framework: "playwright-api" });
                }
                if (access.length) ctx.emit({ stage: "generation", kind: "api_access_tests_generated", message: `${access.length} API access-control checks generated` });
            }

            // 4b2. API latency (opt-in): a few safe GET endpoints, called one at a time.
            if (req.performanceChecks === true) {
                const lat = generateLatencySpecs(apis, { maxEndpoints: levelSettings(req).apiEndpoints, budgets: req.performanceBudgets });
                for (const d of lat) {
                    const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("API") });
                    await persistNew(spec, "playwright-api", "PENDING", undefined, { performance: true, endpoint: d.title.split(":")[0]! });
                    pending.push({ spec, framework: "playwright-api" });
                }
                if (lat.length) ctx.emit({ stage: "generation", kind: "latency_tests_generated", message: `${lat.length} API speed checks generated` });
            }

            // 4b3. Basic load check (opt-in, strictly `true`): up to 3 safe GET endpoints, a small fixed profile (see performance/load.ts).
            if (req.loadChecks === true) {
                const c = req.credentials;
                const load = generateLoadSpecs(apis, { maxEndpoints: LOAD_MAX_ENDPOINTS, budgets: req.loadBudgets, hasCredential: Boolean(c?.apiToken || c?.apiAuthHeader || c?.oauth2) });
                for (const d of load) {
                    const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("API") });
                    await persistNew(spec, "playwright-api", "PENDING", undefined, { performance: true, load: true, endpoint: d.title.split(":")[0]! });
                    pending.push({ spec, framework: "playwright-api" });
                }
                if (load.length) ctx.emit({ stage: "generation", kind: "load_tests_generated", message: `${load.length} load checks generated (up to ${LOAD_MAX_REQUESTS} requests each)` });
                else ctx.emit({ stage: "generation", kind: "load_tests_skipped", message: "No safe GET endpoint to put under load was found (sign-in, payment and data-changing endpoints are never used)" });
            }

            // 4c. Multi-request workflows (list → detail, create → read → delete, login → secured call).
            const wf = generateApiWorkflowSpecs(apis, { allowMutating: req.allowMutatingApiTests, maxWorkflows: levelSettings(req).apiEndpoints });
            for (const d of wf.specs) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("API") });
                await persistNew(spec, "playwright-api", "PENDING", undefined, { workflow: true });
                pending.push({ spec, framework: "playwright-api" });
            }
            if (wf.specs.length || wf.skippedMutating) {
                ctx.emit({
                    stage: "generation",
                    kind: "api_workflows_generated",
                    message: `${wf.specs.length} API workflow tests generated${wf.skippedMutating ? `; ${wf.skippedMutating} state-changing workflows skipped` : ""}`,
                });
            }
        }

        // 4d. Accessibility audits (deterministic, axe-core) for key discovered pages.
        if (wantWeb && req.accessibility !== false && model.pages.length) {
            const a11y = generateA11ySpecs(model, { maxPages: levelSettings(req).checkPages, perTypeScale: levelSettings(req).perTypeScale });
            for (const d of a11y) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { accessibility: true });
                pending.push({ spec, framework: "playwright" });
            }
            if (a11y.length) ctx.emit({ stage: "generation", kind: "a11y_tests_generated", message: `${a11y.length} accessibility audits generated` });
        }

        // 4d2. Page health checks (deterministic): script errors, failed requests, broken links, mixed content, basics.
        if (wantWeb && req.healthChecks !== false && model.pages.length) {
            const health = generateHealthSpecs(model, { maxPages: levelSettings(req).checkPages, perTypeScale: levelSettings(req).perTypeScale });
            for (const d of health) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { health: true });
                pending.push({ spec, framework: "playwright" });
            }
            if (health.length) ctx.emit({ stage: "generation", kind: "health_tests_generated", message: `${health.length} page health checks generated` });
        }

        // 4d3. Passive security checks (deterministic, GET-only) for the application origin.
        // 4d2a. Access control (deterministic): pages some account reached that a lesser account (or a visitor) may not open.
        if (wantWeb && req.accessChecks !== false && accessReach.length > 1) {
            const access = generateAccessSpecs(accessReach, { maxSpecs: 8, maxOrdinary: 3, appUrl: req.url, ...(req.apiBaseUrl ? { apiHosts: [req.apiBaseUrl] } : {}) });
            for (const d of access) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { access: true });
                pending.push({ spec, framework: "playwright" });
            }
            if (access.length) ctx.emit({ stage: "generation", kind: "access_tests_generated", message: `${access.length} access-control checks generated` });
        }

        // 4d2b. Input handling (deterministic): harmless unusual input in search-type forms (data-sending forms only if allowed).
        if (wantWeb && req.inputChecks !== false && model.pages.length) {
            const inputs = generateInputSpecs(model, { maxPages: levelSettings(req).inputPages, allowMutating: req.allowMutatingApiTests });
            for (const d of inputs) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { input: true });
                pending.push({ spec, framework: "playwright" });
            }
            if (inputs.length) ctx.emit({ stage: "generation", kind: "input_tests_generated", message: `${inputs.length} input-handling checks generated` });
        }

        // 4d2c. AI judgement (opt-in): "does this screen look right?" for the most important pages. The checks are generated even
        // without a usable model — they then fail validation with a plain reason instead of silently doing nothing.
        if (wantWeb && wantVision && model.pages.length) {
            const vision = generateVisionSpecs(model, { maxPages: levelSettings(req).visionPages, perTypeScale: levelSettings(req).perTypeScale });
            for (const d of vision) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { vision: true });
                pending.push({ spec, framework: "playwright" });
            }
            if (vision.length) ctx.emit({ stage: "generation", kind: "vision_tests_generated", message: `${vision.length} AI "looks right" checks generated` });
            if (ctx.llm.modelName === "unavailable") ctx.emit({ stage: "generation", kind: "vision_unavailable", level: "warn", message: "AI judgement is switched on but no AI model is set up: those checks cannot run and will be reported as not validated." });
        }

        // 4d3a. Pages behind a login (only when speed or visual checks are on and someone can sign in): which pages need a
        // sign-in, so those get signed-in specs and the anonymous speed / visual specs leave them out.
        let signedIn: SignedInPlan | undefined;
        if (wantWeb && model.pages.length && (req.performanceChecks === true || req.visual) && (creds || accessReach.length > 1)) {
            try {
                signedIn = await planSignedIn(ctx, browser, {
                    model,
                    defaultAccount: creds && authState.loggedIn ? defaultAccount(authState.mechanisms.includes("totp")) : undefined,
                    roles: req.roles ?? [],
                    reach: accessReach,
                });
            } catch (e) {
                ctx.emit({ stage: "generation", kind: "signed_in_failed", level: "warn", message: `Signed-in speed and visual checks were skipped: ${e instanceof Error ? e.message : String(e)}` });
            }
        }

        // 4d3. Page speed (opt-in): median of 3 cold loads per key page against budgets.
        if (wantWeb && req.performanceChecks === true && model.pages.length) {
            const perf = [...generatePerformanceSpecs(model, { maxPages: levelSettings(req).speedPages, perTypeScale: levelSettings(req).perTypeScale, budgets: req.performanceBudgets, excludePaths: signedIn?.gated }), ...(signedIn ? generateSignedInPerformanceSpecs(signedIn, { budgets: req.performanceBudgets }) : [])];
            for (const d of perf) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { performance: true, ...(d.tags.includes("signed-in") ? { signedIn: true } : {}) });
                pending.push({ spec, framework: "playwright" });
            }
            if (perf.length) ctx.emit({ stage: "generation", kind: "performance_tests_generated", message: `${perf.length} page speed checks generated` });
        }

        if (req.securityChecks !== false) {
            const security = generateSecuritySpecs(model);
            for (const d of security) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("API") });
                await persistNew(spec, "playwright-api", "PENDING", undefined, { security: true });
                pending.push({ spec, framework: "playwright-api" });
            }
            ctx.emit({ stage: "generation", kind: "security_tests_generated", message: `${security.length} passive security checks generated` });
        }

        // 4e. Visual regression baselines (opt-in): captured on this run, compared on later validations.
        if (wantWeb && req.visual && model.pages.length) {
            const visual = [...generateVisualSpecs(model, { maxPages: levelSettings(req).checkPages, perTypeScale: levelSettings(req).perTypeScale, excludePaths: signedIn?.gated }), ...(signedIn ? generateSignedInVisualSpecs(signedIn) : [])];
            for (const d of visual) {
                const spec = TestSpecSchema.parse({ ...d, testId: await sink.nextTestKey("WEB") });
                await persistNew(spec, "playwright", "PENDING", undefined, { visual: true, ...(d.tags.includes("signed-in") ? { signedIn: true } : {}) });
                pending.push({ spec, framework: "playwright" });
            }
            if (visual.length) ctx.emit({ stage: "generation", kind: "visual_tests_generated", message: `${visual.length} visual baseline tests generated` });
        }
        await sink.phase("GENERATING", "generation", summary.testsGenerated > 0 ? "done" : "failed");
        throwIfAborted(ctx.signal);

        // ── 5. VALIDATION ─────────────────────────────────────────────────────
        if (pending.length) {
            await sink.phase("VALIDATING", "validation", "running");
            const validationStartedAt = new Date().toISOString();
            for (const t of pending) await sink.updateTest(handles.get(t.spec.testId)!, { validation: "VALIDATING" });

            const outcomes: ValidationOutcome[] = await validateBatch(
                ctx,
                {
                    browser,
                    scratchDir: ctx.config.scratchDir,
                    env: { baseUrl: origin, apiBaseUrl: renderCtx.apiBaseUrl, credentials: creds, roles: req.roles, apiToken: await resolveApiToken(ctx, req.credentials), apiAuthHeader: req.credentials?.apiAuthHeader, headless: ctx.config.HEADLESS },
                    render: renderCtx,
                    model,
                    // The level decides; a setting below the default (tests, the local CLI) lowers it.
                    maxRepairAttempts: ctx.config.MAX_REPAIR_ATTEMPTS < 2 ? ctx.config.MAX_REPAIR_ATTEMPTS : levelSettings(req).repairAttempts,
                    // A new test that still fails runs once more, so its reason says flaky or broken.
                    confirmFailures: true,
                    // A new test that passed runs the level's number of times more; any failure makes it flaky.
                    repeatPasses: levelSettings(req).repeatPasses,
                    workers: ctx.config.CONCURRENCY,
                    // Saved tests of one account replay one at a time, as they were written.
                    accountLanes: true,
                    cleanup: req.cleanup,
                },
                pending,
                {
                    onCleanup: sink.saveCleanup ? (items) => sink.saveCleanup!(items) : undefined,
                    async onAttempt(t, attempt, _script, run) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.recordExecution(h, scriptIds.get(t.spec.testId) ?? null, attempt, run, attempt === 1 ? validationStartedAt : new Date(Date.now() - run.durationMs).toISOString());
                        await sink.updateTest(h, { attempts: attempt });
                    },
                    async onRepaired(t, spec) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.updateTest(h, { spec });
                        const script = renderWithAdapter(spec, t.framework, renderCtx);
                        scriptIds.set(t.spec.testId, await sink.saveScript(h, script, true));
                    },
                    async onFinal(t, outcome) {
                        const h = handles.get(t.spec.testId)!;
                        await sink.updateTest(h, { validation: outcome.status, reason: outcome.reason ?? null, attempts: outcome.attempts, spec: outcome.spec });
                    },
                    async onNewBaselines(t, files) {
                        await sink.saveBaselines(handles.get(t.spec.testId)!, files);
                    },
                    onNotRun: async (t) => await sink.restoreTest?.(handles.get(t.spec.testId)!),
                },
            );
            for (const o of outcomes) {
                if (o.status === "NOT_RUN") continue;
                if (o.status === "VALIDATED") {
                    const planned = pending.find((t) => t.spec.testId === o.spec.testId)?.scenario;
                    if (planned) validatedScenarioIds.add(planned.scenarioId);
                }
                if (o.status === "VALIDATED") summary.testsValidated++;
                else if (o.status === "NEEDS_REVIEW") summary.testsNeedingReview++;
                else summary.testsFailedValidation++;
            }
            await sink.counters({
                testsValidated: summary.testsValidated,
                testsFailedValidation: summary.testsFailedValidation,
                testsNeedingReview: summary.testsNeedingReview,
            });
            // Opt-in: repeat the validated web tests on other browsers / screen sizes. Never changes a test's own status.
            if (req.variants?.length) {
                throwIfAborted(ctx.signal);
                await runVariantChecks(
                    ctx,
                    { scratchDir: ctx.config.scratchDir, env: { baseUrl: origin, credentials: creds, roles: req.roles, headless: ctx.config.HEADLESS }, render: renderCtx, workers: ctx.config.CONCURRENCY, sink },
                    outcomes.flatMap((o) => (o.status === "NOT_RUN" ? [] : [{ handle: handles.get(o.spec.testId)!, spec: o.spec, validationStatus: o.status, scriptId: scriptIds.get(o.spec.testId) }])),
                    req.variants,
                );
            }
            // Deep and Everything: the key validated web tests also run under the level's conditions (dark mode, another locale), unless asked for already.
            const levelConditions = levelSettings(req).conditionVariants.filter((v) => !req.variants?.includes(v));
            if (levelConditions.length) {
                throwIfAborted(ctx.signal);
                await runVariantChecks(
                    ctx,
                    { scratchDir: ctx.config.scratchDir, env: { baseUrl: origin, credentials: creds, roles: req.roles, headless: ctx.config.HEADLESS }, render: renderCtx, workers: ctx.config.CONCURRENCY, sink },
                    outcomes.flatMap((o) => (o.status === "NOT_RUN" || !isKeyTest(o.spec) ? [] : [{ handle: handles.get(o.spec.testId)!, spec: o.spec, validationStatus: o.status, scriptId: scriptIds.get(o.spec.testId) }])),
                    levelConditions,
                );
            }
            // Testing the tests: validated web tests replayed with deliberate faults in their browser; one that misses some is given a stronger check once.
            throwIfAborted(ctx.signal);
            const strength = await checkStrength(
                ctx,
                { scratchDir: ctx.config.scratchDir, env: { baseUrl: origin, apiBaseUrl: renderCtx.apiBaseUrl, credentials: creds, roles: req.roles, headless: ctx.config.HEADLESS }, render: renderCtx, workers: ctx.config.CONCURRENCY, browser, baseUrl: origin, model, credentials: creds && authState.loggedIn ? creds : undefined, maxSteps: levelSettings(req).authoringMaxSteps, secrets: authoringSecretsOf(req), limit: levelSettings(req).strengthTests, webSockets: Boolean(model.webSockets?.length) },
                outcomes.flatMap((o) => (o.status === "NOT_RUN" ? [] : [{ spec: o.spec, validationStatus: o.status, scenario: pending.find((t) => t.spec.testId === o.spec.testId)?.scenario }])),
                {
                    async onStrengthened(testId, spec, run) {
                        const h = handles.get(testId)!;
                        await sink.updateTest(h, { spec });
                        scriptIds.set(testId, await sink.saveScript(h, renderWithAdapter(spec, "playwright", renderCtx), true));
                        await sink.recordExecution(h, scriptIds.get(testId) ?? null, 1, run, new Date(Date.now() - run.durationMs).toISOString());
                    },
                    async onScored(testId, s) {
                        const meta = { ...(metas.get(testId) ?? {}), strength: s };
                        metas.set(testId, meta);
                        await sink.updateTest(handles.get(testId)!, { meta });
                    },
                },
            );
            if (strength.checked) await sink.counters({ strengthChecked: strength.checked, faultsCaught: strength.caught, faultsInjected: strength.total, testsStrengthened: strength.strengthened });
            await sink.phase("VALIDATING", "validation", "done");
        } else {
            await sink.phase("VALIDATING", "validation", "skipped");
        }

        // The screen map: which transitions the authored web tests follow (and the ones they took that the crawl did not see).
        if (model.screenMap) {
            const web = pending.filter((t) => t.scenario).map((t) => t.spec);
            if (web.length) {
                coverWithTests(model.screenMap, web, origin);
                await sink.saveModel(model);
            }
        }
        await sink.counters({ llmInputTokens: ctx.llm.usage.inputTokens, llmOutputTokens: ctx.llm.usage.outputTokens });
        // Cancellation during validation: results so far are recorded truthfully, but the job ends as cancelled.
        throwIfAborted(ctx.signal);
        // Site memory: save what this analysis learned (and what changed since the last one). A cancelled run saved nothing
        // (its validation was partial); never fails the job.
        await memory.remember(scenarios.map((s) => ({ title: s.title, journey: s.journey, startPath: s.startPath, validated: validatedScenarioIds.has(s.scenarioId) })));
        ctx.emit({
            stage: "orchestration",
            kind: "job_summary",
            message: `${summary.testsGenerated} tests generated, ${summary.testsValidated} validated, ${summary.testsNeedingReview} need review, ${summary.testsFailedValidation} failed validation`,
        });
        return summary;
    } finally {
        await closeBrowser(browser);
    }
}

async function closeBrowser(b: Browser): Promise<void> {
    await b.close().catch(() => undefined);
}

/** Every secret of an exploration the authoring agent could see echoed by the application (masked before the AI or a record sees it). */
function authoringSecretsOf(req: Pick<GenerationRequest, "credentials" | "roles">): string[] {
    const c = req.credentials;
    const list = [c?.password, c?.totpSecret, c?.apiToken, c?.apiAuthHeader, ...(req.roles ?? []).flatMap((r) => [r.password, r.totpSecret, r.apiToken])];
    return list.filter((v): v is string => typeof v === "string" && v.length >= 4);
}

/**
 * Row 173: the `shoot` of a defect test's independence check. A picture of the page where a replay stopped, taken as the Explorer view
 * takes one (frames/shoot.ts: secret fields and fields holding one of `secrets` covered, small JPEG), stored through `save`; the answer
 * is the stored picture's reference, never its bytes.
 */
export function findingShooter(save: NonNullable<GenerationSink["saveImageArtifact"]>, secrets: readonly string[], testKey: string): (page: Page) => Promise<string | undefined> {
    let n = 0;
    return async (page) => {
        const shot = await shootPage(page, secrets);
        return shot ? await save("screenshot", `${testKey}-finding-${++n}.jpg`, shot.jpeg) : undefined;
    };
}

const EXPECTED_SOURCE = /^expected:([1-9]\d{0,2})$/;
/** A candidate finding keeps at most this many screenshot references (the spec names no number). */
export const FINDING_SCREENSHOTS_MAX = 3;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The candidate finding of a defect test (explore/finding.ts, Decision 9), the sentence its review reason ends with, and what the
 * possible_defect event says. The expected result comes from the captured check's source (the scenario's n-th expected result, or a
 * rule given to the scenario), never from what the application did; an observed-only defect has no source and its scenario's expected
 * results as the expected text. Parsed with the contract (redacted, cut) before it goes on the test; no AI calls.
 */
export function defectFinding(p: {
    scenario: Scenario;
    rules: readonly KnowledgeRule[];
    /** The ids of the job's requirements (statedSource): an expected result naming one its scenario covers is stated. */
    requirementIds?: readonly string[];
    outcome: Extract<AuthorOutcome, { status: "defect" }>;
    capture: CaptureState;
    independence: IndependenceCheck;
    stepCount: number;
    modelVersion: string | null;
}): { finding?: CandidateFinding; problem?: string; basis: string; confidence: FindingConfidence; source: string | null } {
    const L = CANDIDATE_FINDING_LIMITS;
    // Only a stated source captures (author.ts statedSource, the rule the author applied): a check of the planner's own expected result does not.
    const cited = p.capture === "captured" ? (p.outcome.capturedCheck?.source ?? null) : null;
    const source = cited && statedSource(cited, p.scenario, p.rules, p.requirementIds) ? cited : null;
    const n = source ? EXPECTED_SOURCE.exec(source) : null;
    const rule = source && !n ? p.rules.find((r) => r.ref === source) : undefined;
    const expected = n ? (p.scenario.expectedResults[Number(n[1]) - 1] ?? "") : rule ? rule.expected || rule.description : p.scenario.expectedResults.join("; ");
    const capture: CaptureState = source ? p.capture : "observed_only";
    const confidence = confidenceOf({ sourced: source !== null, capture, independence: p.independence.independence });
    const named = n ? `expected result ${n[1]} (${cut(expected, 200)})` : rule ? `rule ${source}` : source ? `${source}` : "";
    const independent = { independent: "both fresh replays failed at it", state_dependent: "the fresh replays did not fail at it the same way", not_run: "the fresh replays could not be run" }[p.independence.independence];
    const basis = source
        ? `The failing check is of ${named}; ${independent} (confidence ${confidence}).`
        : `No failing check of a stated expectation was kept, so this is observed only (confidence ${confidence}).`;
    const problems = p.outcome.evidence ?? [];
    const isConsole = (line: string) => /^(Console error|Page error):/.test(line) || !/^[A-Z]+ \S+ (answered|failed)/.test(line);
    const o = p.scenario.objective;
    const input = {
        objective: o ? { id: o.id, kind: o.kind, source: cut(o.source, L.refMax), ...(o.operator ? { operator: o.operator } : {}) } : null,
        actions: { stepCount: Math.min(p.stepCount, L.stepsMax) },
        expected: { text: expected, source },
        observed: p.outcome.explanation,
        evidence: { screenshots: (p.independence.screenshots ?? []).slice(0, FINDING_SCREENSHOTS_MAX), requests: problems.filter((l) => !isConsole(l)).slice(0, L.requestsMax), console: problems.filter(isConsole).slice(0, L.consoleMax) },
        capture,
        independence: p.independence.independence,
        confidence,
        fingerprint: findingFingerprint({ source, expected, scenario: p.scenario.title }),
        modelVersion: p.modelVersion,
        replays: p.independence.replays.slice(0, L.replaysMax),
    };
    const parsed = CandidateFindingSchema.safeParse(input);
    const problem = parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join(".") || "finding"}: ${i.message}`).join("; ");
    return { ...(parsed.success ? { finding: parsed.data } : { problem }), basis, confidence, source };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Objective-driven exploration (Phase 3): what the stage above pursues, and the bounds it runs the test writer in.

/** One operator of one objective, as the loop pursues it. */
export interface ObjectivePursuit extends LoopObjective {
    objective: Objective;
    operator: ObjectiveOperator;
    scenario: Scenario;
    check: OperatorCheck;
}

const normRef = (t: string) => t.replace(/\s+/g, " ").trim();
const refOf = (t: string) => {
    const s = normRef(t);
    return s.length <= 500 ? s : `${s.slice(0, 499).trimEnd()}…`;
};

/**
 * The objectives of a model version and their pursuits, without AI or a browser: objectives (explore/objectives.ts) from the objective
 * inputs, rules and workflows; each allowed operator as a scenario (explore/perturb.ts), its workflow steps or its field's input classes
 * from the same inputs. A pursuit's fingerprint is the objective's with the scenario (operator, cancel step), so the loop pursues each
 * operator of an objective once and never takes the second operator for a repeat of the first. Operators that cannot run are listed
 * with their reason. Every number comes from `opts` (the level), nothing from the model's text.
 */
export function objectivePursuits(
    k: Pick<AppKnowledge, "rules" | "workflows" | "objectiveInputs">,
    opts: { maxObjectives: number; steps: number; perObjective: { minutes: number; tokens: number }; dataOperators: boolean; requiresAuth: boolean; /** GenerationRequest.exploredObjectives. */ explored?: readonly string[] },
): { objectives: Objective[]; overCap: number; pursuits: ObjectivePursuit[]; skipped: SkippedOperator[] } {
    const inputs = k.objectiveInputs ?? { pages: [], transitions: [], workflowSteps: [] };
    // From the request: only refs an objective could have (a longer one names nothing), at most MAX_EXPLORED.
    const explored = opts.explored ? { explored: opts.explored.filter((r) => typeof r === "string" && r.length <= OBJECTIVE_REF_MAX).slice(0, MAX_EXPLORED) } : {};
    const { objectives, overCap } = objectivesFrom(inputs, k.rules, k.workflows, { maxObjectives: opts.maxObjectives, budget: { steps: opts.steps, minutes: opts.perObjective.minutes, tokens: opts.perObjective.tokens }, ...explored });
    const fields = new Map<string, ObjectiveField>();
    for (const page of inputs.pages) for (const form of page.forms) for (const field of form.fields) fields.set(refOf(`${page.id}/${form.name?.trim() || "form"}/${field.name}`), field);
    const pursuits: ObjectivePursuit[] = [];
    const skipped: SkippedOperator[] = [];
    for (const o of objectives) {
        const options: PerturbOptions = { dataOperators: opts.dataOperators, requiresAuth: opts.requiresAuth };
        if (o.kind === "workflow") {
            const wf = k.workflows.find((w) => normRef(w.id) === normRef(o.source.ref));
            const paged = inputs.workflowSteps.find((w) => normRef(w.workflowId) === normRef(o.source.ref))?.steps;
            if (wf) options.workflow = { preconditions: wf.preconditions ?? [], steps: paged ?? wf.steps };
        }
        if (o.kind === "constraint") {
            const field = fields.get(o.source.ref);
            if (field) options.inputClasses = inputClassesFor(field, o.source.ref);
        }
        for (const r of scenariosFor(o, options)) {
            if (r.status === "skipped") {
                skipped.push({ objectiveId: o.id, operator: r.operator, reason: r.reason });
                continue;
            }
            pursuits.push({
                id: pursuitKey(o.id, r.operator),
                priority: o.priority,
                fingerprint: createHash("sha256").update(JSON.stringify(["pursuit", o.fingerprint, r.scenario.scenarioId])).digest("hex"),
                objective: o,
                operator: r.operator,
                scenario: r.scenario,
                check: r.check,
            });
        }
    }
    return { objectives, overCap, pursuits, skipped };
}

/** A model call refused because the session or the objective has spent its budget. */
export class ExplorationStopped extends Error {
    override name = "ExplorationStopped";
}

/**
 * The run's AI client for one pursuit: every call (each test-writer step, review and verdict) first passes `gate`, which counts it and
 * throws when a budget is spent. The usage object stays the run's own, so tokens are counted where they always were.
 */
export function gatedLlm(base: LlmClient, gate: () => void): LlmClient {
    let wrapped: LanguageModel | undefined;
    const gated: LlmClient = {
        get modelName() {
            return base.modelName;
        },
        get model() {
            if (wrapped === undefined) {
                const m = base.model;
                wrapped =
                    typeof m === "object" && m?.specificationVersion === "v3"
                        ? wrapLanguageModel({
                              model: m,
                              middleware: {
                                  specificationVersion: "v3",
                                  wrapGenerate: async ({ doGenerate }) => {
                                      gate();
                                      return doGenerate();
                                  },
                                  wrapStream: async ({ doStream }) => {
                                      gate();
                                      return doStream();
                                  },
                              },
                          })
                        : m;
            }
            return wrapped;
        },
        get usage() {
            return base.usage;
        },
        set usage(u) {
            base.usage = u;
        },
        text: async (a) => {
            gate();
            return base.text(a);
        },
        object: async (a) => {
            gate();
            return base.object(a);
        },
        ...(base.imageObject
            ? {
                  imageObject: (async (a: Parameters<NonNullable<LlmClient["imageObject"]>>[0]) => {
                      gate();
                      return base.imageObject!(a);
                  }) as LlmClient["imageObject"],
              }
            : {}),
        ...(base.setEventSink ? { setEventSink: (e: Parameters<NonNullable<LlmClient["setEventSink"]>>[0]) => base.setEventSink!(e) } : {}),
    };
    return gated;
}

/**
 * The loop's view of the test writer's actions: each as a stable key on a state. The test writer reports an action after it ran, with
 * the address it left the page on, and never the page's outline, so a state here is the address pattern with what was done since the
 * page was last loaded (the values typed, the action before). The same click twice in a row is two states (a double submit); the same
 * action again on the same state is a repeat the loop refuses.
 */
export function actionTracker(startUrl: string): (a: { tool: string; args: unknown; ok: boolean; observation: string }) => { state: string; action: string } {
    let url = startUrl;
    let typed: string[] = [];
    let previous = "";
    return (a) => {
        const action = `${a.tool} ${JSON.stringify(a.args ?? null) ?? ""}`;
        const digest = createHash("sha256").update(JSON.stringify([typed, previous])).digest("hex").slice(0, 12);
        const state = `${pathPattern(url)}|${digest}`;
        previous = action;
        const args = (a.args ?? {}) as { value?: unknown };
        if (a.ok && (a.tool === "fill" || a.tool === "select") && typeof args.value === "string") typed = [...typed, args.value].slice(-50);
        const moved = a.ok ? /^url=(\S+)/.exec(a.observation)?.[1] : undefined;
        if (moved && (moved !== url || a.tool === "navigate")) {
            url = moved;
            typed = [];
        }
        return { state, action };
    };
}
