import { randomUUID } from "node:crypto";
import type { EngineEvent } from "../engine/context.js";
import type { Framework } from "../engine/generators/types.js";
import { collapseBlocks } from "../engine/blocks/expand.js";
import { collapseRefs, refNames } from "../engine/locators/refs.js";
import type { TestSpec } from "../engine/spec/schema.js";
import { syncLocatorUsage } from "./locator-store.js";
import type { AppModel } from "../engine/understanding/app-model.js";
import { Db, type Row } from "./db.js";
import { SecretBox } from "./secrets.js";
import { retryOnUniqueViolation } from "./sql-dialect.js";
import { eventBus } from "./event-bus.js";
import { codeEnginesFor, DEFAULT_PLATFORMS, DEFAULT_TESTING_MODES, type ProjectPlatform, type TestingMode } from "./project-setup.js";
import { HttpError } from "./http-error.js";
import { trackTestVersion, type VersionSource } from "./review-store.js";
import { currentActor } from "./auth/actor.js";
import { isArchived, PROJECT_ARCHIVED } from "./project-folders.js";
import { requestedRunnerId } from "./run-request.js";
import { HANDED_OVER } from "./runner-handover.js";

export const JOB_STATES = [
    "QUEUED",
    "DISCOVERING",
    "ANALYZING",
    "PLANNING",
    "GENERATING",
    "VALIDATING",
    "COMPLETED",
    "PARTIALLY_COMPLETED",
    "FAILED",
] as const;
export type JobStatus = (typeof JOB_STATES)[number];
export const ACTIVE_STATES: JobStatus[] = ["DISCOVERING", "ANALYZING", "PLANNING", "GENERATING", "VALIDATING"];
export const TERMINAL_STATES: JobStatus[] = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

export type ValidationState = "PENDING" | "VALIDATING" | "VALIDATED" | "FAILED_VALIDATION" | "NEEDS_REVIEW";

export interface Credentials {
    username?: string;
    password?: string;
    apiToken?: string;
    apiAuthHeader?: string;
    /** Authenticator-app secret (base32) for logins with a one-time code. Stored encrypted with the rest of this object. */
    totpSecret?: string;
    /** OAuth2 client-credentials grant; the secret is stored encrypted with the rest of this object. */
    oauth2?: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string; audience?: string; authMethod?: "basic" | "body" };
}

/** The person (or key) acting now, as a job records its starter; undefined for a schedule, a trigger, a runner or the system. */
function startedByOf(): { kind: string; id: string | null } | undefined {
    const a = currentActor();
    return a.kind === "user" || a.kind === "key" || a.kind === "open" ? { kind: a.kind, id: a.id ?? null } : undefined;
}

export interface JobOptions {
    /**
     * Who started the job (set by createJob from the person acting). A schedule's job says which schedule and who made it
     * (`{ kind: "schedule", id: <scheduleId>, ownerId: <user id or null> }`), so a person's own runner can take their own schedules.
     */
    startedBy?: { kind: string; id: string | null; ownerId?: string | null };
    /** The runner a person chose for this one run (an agent_tokens id). Carried only: the job gate checks it, the dispatch offers it only to that runner. */
    runner?: { id: string };
    maxPages: number;
    maxDepth: number;
    maxScenarios: number;
    scope?: string;
    includePaths?: string[];
    /** "mobile": the AI explores the project's Android app on a phone or emulator and writes phone tests (see engine/mobile/explore). */
    targets: Array<"web" | "api" | "mobile">;
    /** POST/PUT/PATCH/DELETE API tests change state on the live app; off unless explicitly enabled. */
    allowMutatingApiTests: boolean;
    openApiUrl?: string;
    apiBaseUrl?: string;
    /**
     * "generate" (default, also for jobs stored before modes existed): the full pipeline.
     * "validate": execute + validate existing tests (`testIds`) only — no discovery/planning/generation.
     */
    mode?: JobMode;
    /** validate mode: test_cases.id values to execute. */
    testIds?: string[];
    /** Plan and write the functional test cases of the journeys (web target). Default true; false when the project's testing agents leave out the Test Case Generation Agent (testing-agents.ts). */
    functionalTests?: boolean;
    /** Generate axe-core accessibility audits (web target). Default true. */
    accessibility?: boolean;
    /** Generate page health checks (JavaScript errors, failed requests, broken links...) for key pages (web target). Default true. */
    healthChecks?: boolean;
    /** Generate passive, read-only security checks (headers, cookies, CORS, exposed files, TLS). Default true. */
    securityChecks?: boolean;
    /** Generate page-speed checks for key pages (web target). Default false: timings depend on the environment and the checks take longer. */
    performanceChecks?: boolean;
    /** Basic load check (up to 3 safe GET endpoints, up to 10 users at once, at most 300 requests each). Default false; never run by schedules or on production. */
    loadChecks?: boolean;
    /** Lower limits for the load check, e.g. "p95:500 errors:2 users:5 seconds:5". Clamped to the caps. */
    loadBudgets?: string;
    /** Probe search-type (GET) forms with harmless unusual input. Default true. Data-sending forms only when allowMutatingApiTests is on. */
    inputChecks?: boolean;
    /** AI judgement: a vision-capable model looks at screenshots (authoring + "looks right" checks). Default false. */
    visionChecks?: boolean;
    /** Check API responses against the documented schema (OpenAPI). Default true. */
    contractChecks?: boolean;
    /** Check that restricted pages stay closed to lesser accounts and visitors (needs test accounts). Default true. */
    accessChecks?: boolean;
    /** Start from (and update) what earlier analyses learned about this application. Default true; false = neither read nor write site memory. */
    useMemory?: boolean;
    /** Send every page to the AI again, even pages unchanged since the last exploration (exploration reuse off for this job). Default false. */
    fullExploration?: boolean;
    /** Budget overrides for the page-speed checks, e.g. "lcp:3000 weight:5000000 slow-4g". */
    performanceBudgets?: string;
    /** Generate visual-regression baselines (web target). Default false. */
    visual?: boolean;
    /** Requirements document converted to text at submit time (bounded by the extractor). */
    requirementsName?: string;
    requirementsText?: string;
    /** Extra browsers / screen sizes (variant ids) to re-run validated web tests on. Empty or absent = off. */
    variants?: string[];
    /** Who started the job. Absent = a person (stored jobs from before schedules). */
    trigger?: "manual" | "schedule" | "deploy";
    scheduleId?: string;
    /** Set when a runbook step started this job (the run's id, see runbook-runner.ts). */
    runbookRunId?: string;
    /** trigger "deploy": what the pipeline said about the deploy (labels only; shown in the Runs list). */
    deploy?: { commit?: string; environment?: string; label?: string };
    /** validate mode: re-run a failing test this many times straight away; a pass after a fail is a flaky pass. */
    retryFailures?: number;
    /** validate mode: run the tests one at a time in the order given and stop at the first that does not pass (test suites); the rest are not run. */
    stopOnFirstFailure?: boolean;
    /** environment mode: the project's named environment (staging, production...) the tests run against. */
    environment?: string;
    /** environment mode: the person (or schedule) confirmed that this run may touch a production environment. */
    confirmProduction?: boolean;
    /** Remove the records data-changing API tests create once the run ends. Absent: the project's own switch (on unless it was turned off). */
    cleanupAfter?: boolean;
    /** plain mode: the test described in the person's own words (see engine/authoring/plain.ts). `environment` (above) is the project environment it is built on, if any. */
    plainDescription?: string;
    plainKind?: "web" | "api";
    /** agent mode: the agent run this job carries out (agent-run.ts). */
    agentRunId?: string;
    /** plain mode: rebuild this existing test (test_cases.id) from the new description instead of adding one. */
    rewriteTestId?: string;
    /** Set when the project's scripts run on a runner agent (stamped by the job gate in agent-services.ts). */
    runOn?: "platform" | "agent";
    /** generate mode: explore and plan only. The plan is kept for the person to look at; nothing is created or run (see routes/plans.ts). */
    planOnly?: boolean;
    /** generate mode: start from the plan an earlier plan-only job (this id) kept, instead of exploring again. */
    fromPlan?: string;
    /** With `fromPlan`: test ideas (scenarioIds) the person left out of the plan. */
    excludeIdeas?: string[];
}

/**
 * "variants": only add browser / screen-size compatibility results for existing tests (`testIds`, `variants`).
 * "environment": run existing tests (`testIds`) against a named environment and store the results for it (`environment`).
 * "plain": build one test from a description in plain words (`plainDescription`), run it, store it.
 * "agent": the AI pursues an objective in a browser and reports what it found (`agentRunId`, see agent-run.ts). Nothing here runs a test.
 */
/** Why a job whose worker was lost three times is given up (reclaimStaleJobs). */
export const WORKER_LOST_GIVE_UP = "This run was given up: the platform lost track of it three times, because the process looking after it stopped each time. No test got a result from it, so tests that had not finished are back to not run yet.";

export type JobMode = "generate" | "validate" | "variants" | "environment" | "plain" | "agent";

export const DEFAULT_JOB_OPTIONS: JobOptions = {
    maxPages: 25,
    maxDepth: 3,
    maxScenarios: 25,
    targets: ["web", "api"],
    allowMutatingApiTests: false,
    healthChecks: true,
    securityChecks: true,
    performanceChecks: false,
    loadChecks: false,
    inputChecks: true,
    visionChecks: false,
    contractChecks: true,
    accessChecks: true,
    useMemory: true,
};

export const PHASES = ["discovery", "understanding", "planning", "generation", "validation"] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseState = "pending" | "running" | "done" | "skipped" | "failed";
export type JobProgress = Record<Phase, PhaseState>;

export interface JobCounters {
    pagesDiscovered: number;
    apisDiscovered: number;
    journeysIdentified: number;
    scenariosPlanned: number;
    testsGenerated: number;
    testsValidated: number;
    testsFailedValidation: number;
    testsNeedingReview: number;
    scenariosSkipped: number;
    /** Requirements-driven jobs: requirements extracted / covered by at least one planned scenario. */
    requirementsTotal: number;
    requirementsCovered: number;
    llmInputTokens: number;
    llmOutputTokens: number;
    /** Browser / screen-size checks that really ran (passed + failed), and how many of them failed. */
    variantChecks: number;
    variantFailures: number;
}

export const emptyCounters = (): JobCounters => ({
    pagesDiscovered: 0,
    apisDiscovered: 0,
    journeysIdentified: 0,
    scenariosPlanned: 0,
    testsGenerated: 0,
    testsValidated: 0,
    testsFailedValidation: 0,
    testsNeedingReview: 0,
    scenariosSkipped: 0,
    requirementsTotal: 0,
    requirementsCovered: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    variantChecks: 0,
    variantFailures: 0,
});
export const emptyProgress = (): JobProgress => ({ discovery: "pending", understanding: "pending", planning: "pending", generation: "pending", validation: "pending" });

const now = () => new Date().toISOString();
const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export interface JobRow {
    id: string;
    projectId: string;
    applicationId: string;
    status: JobStatus;
    options: JobOptions;
    progress: JobProgress;
    counters: JobCounters;
    error: string | null;
    attempts: number;
    cancelRequested: boolean;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    updatedAt: string;
}

const toJob = (r: Row): JobRow => ({
    id: r.id,
    projectId: r.project_id,
    applicationId: r.application_id,
    status: r.status,
    options: JSON.parse(r.options_json),
    progress: JSON.parse(r.progress_json),
    counters: JSON.parse(r.counters_json),
    error: r.error,
    attempts: r.attempts,
    cancelRequested: Boolean(r.cancel_requested),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
});

export interface TestRow {
    id: string;
    projectId: string;
    suiteId: string;
    suite: string;
    jobId: string | null;
    testKey: string;
    title: string;
    kind: string;
    type: string;
    priority: string;
    validationStatus: ValidationState;
    validationReason: string | null;
    framework: Framework;
    attempts: number;
    spec: TestSpec;
    generationMeta: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
}

const toTest = (r: Row): TestRow => ({
    id: r.id,
    projectId: r.project_id,
    suiteId: r.suite_id,
    suite: r.suite_name,
    jobId: r.job_id,
    testKey: r.test_key,
    title: r.title,
    kind: r.kind,
    type: r.type,
    priority: r.priority,
    validationStatus: r.validation_status,
    validationReason: r.validation_reason,
    framework: r.framework,
    attempts: r.attempts,
    spec: JSON.parse(r.spec_json),
    generationMeta: r.generation_meta_json ? JSON.parse(r.generation_meta_json) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const TEST_SELECT = `SELECT t.*, s.name AS suite_name FROM test_cases t JOIN test_suites s ON s.id = t.suite_id`;

export class Repo {
    constructor(
        readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    // ── users / projects ────────────────────────────────────────────────────
    ensureDefaultUser(): string {
        const existing = this.db.get<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1");
        if (existing) return existing.id;
        const id = randomUUID();
        this.db.run("INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)", id, "admin@localhost", "Default user", now());
        return id;
    }

    /** Platforms and modes left out are the defaults (web; agent and code); the engines always follow the platforms (project-setup.ts). */
    createProject(input: { name: string; description?: string; platforms?: ProjectPlatform[]; testingModes?: TestingMode[] }): Row {
        const id = randomUUID();
        const t = now();
        const platforms = input.platforms ?? DEFAULT_PLATFORMS;
        this.db.run(
            "INSERT INTO projects (id, owner_id, name, description, created_at, updated_at, platforms, testing_modes, code_engines) VALUES (?,?,?,?,?,?,?,?,?)",
            id,
            this.ensureDefaultUser(),
            input.name,
            input.description ?? null,
            t,
            t,
            JSON.stringify(platforms),
            JSON.stringify(input.testingModes ?? DEFAULT_TESTING_MODES),
            JSON.stringify(codeEnginesFor(platforms)),
        );
        return this.getProject(id)!;
    }

    /**
     * Changes what is given and leaves the rest. New platforms recompute the engines. Nothing else is touched: tests of a platform
     * or mode turned off stay as they are. `c4tProjectId` is checked by the caller (same organisation, through Crowd4Test).
     */
    updateProject(id: string, patch: { name?: string; description?: string | null; platforms?: ProjectPlatform[]; testingModes?: TestingMode[]; c4tProjectId?: string | null }): Row | undefined {
        const sets: string[] = [];
        const values: Array<string | null> = [];
        const set = (column: string, value: string | null) => {
            sets.push(`${column} = ?`);
            values.push(value);
        };
        if (patch.name !== undefined) set("name", patch.name);
        if (patch.description !== undefined) set("description", patch.description);
        if (patch.platforms !== undefined) {
            set("platforms", JSON.stringify(patch.platforms));
            set("code_engines", JSON.stringify(codeEnginesFor(patch.platforms)));
        }
        if (patch.testingModes !== undefined) set("testing_modes", JSON.stringify(patch.testingModes));
        if (patch.c4tProjectId !== undefined) set("c4t_project_id", patch.c4tProjectId);
        if (sets.length) this.db.run(`UPDATE projects SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...values, now(), id);
        return this.getProject(id);
    }

    getProject(id: string): Row | undefined {
        return this.db.get(
            `SELECT p.*,
                (SELECT COUNT(*) FROM test_cases t WHERE t.project_id = p.id) AS test_count,
                (SELECT COUNT(*) FROM test_cases t WHERE t.project_id = p.id AND t.validation_status = 'VALIDATED') AS validated_count,
                (SELECT COUNT(*) FROM manual_cases m WHERE m.project_id = p.id) AS case_count
             FROM projects p WHERE p.id = ?`,
            id,
        );
    }

    listProjects(): Row[] {
        return this.db.all(
            `SELECT p.*,
                (SELECT COUNT(*) FROM test_cases t WHERE t.project_id = p.id) AS test_count,
                (SELECT COUNT(*) FROM test_cases t WHERE t.project_id = p.id AND t.validation_status = 'VALIDATED') AS validated_count,
                (SELECT COUNT(*) FROM manual_cases m WHERE m.project_id = p.id) AS case_count,
                (SELECT url FROM applications a WHERE a.project_id = p.id ORDER BY created_at DESC, ${this.db.dialect.insertionOrder("a")} DESC LIMIT 1) AS url,
                (SELECT status FROM generation_jobs g WHERE g.project_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_job_status
             FROM projects p ORDER BY p.created_at DESC`,
        );
    }

    // ── applications ────────────────────────────────────────────────────────
    createApplication(projectId: string, url: string, config: Record<string, unknown>, credentials?: Credentials): string {
        const id = randomUUID();
        const origin = new URL(url).origin;
        this.db.tx(() => {
            this.db.run(
                "INSERT INTO applications (id, project_id, url, origin, config_json, credentials_enc, created_at) VALUES (?,?,?,?,?,?,?)",
                id,
                projectId,
                url,
                origin,
                JSON.stringify(config),
                credentials && Object.values(credentials).some(Boolean) ? this.secrets.encrypt(credentials) : null,
                now(),
            );
            this.db.run(
                "INSERT INTO environments (id, application_id, name, base_url, api_base_url, variables_json, is_default) VALUES (?,?,?,?,?,?,1)",
                randomUUID(),
                id,
                "default",
                origin,
                (config.apiBaseUrl as string | undefined) ?? null,
                null,
            );
        });
        return id;
    }

    getApplication(id: string): { id: string; projectId: string; url: string; origin: string; config: Record<string, any>; credentials?: Credentials; model: AppModel | null } | undefined {
        const r = this.db.get("SELECT * FROM applications WHERE id = ?", id);
        if (!r) return undefined;
        return {
            id: r.id,
            projectId: r.project_id,
            url: r.url,
            origin: r.origin,
            config: JSON.parse(r.config_json),
            credentials: r.credentials_enc ? this.secrets.decrypt<Credentials>(r.credentials_enc) : undefined,
            model: r.app_model_json ? JSON.parse(r.app_model_json) : null,
        };
    }

    /** Latest application of a project, never including credentials. */
    getLatestApplicationPublic(projectId: string): Row | undefined {
        const r = this.db.get(`SELECT * FROM applications WHERE project_id = ? ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC LIMIT 1`, projectId);
        if (!r) return undefined;
        return { id: r.id, url: r.url, origin: r.origin, config: JSON.parse(r.config_json), hasCredentials: Boolean(r.credentials_enc), modelUpdatedAt: r.model_updated_at };
    }

    /** Most recent application model of a project (a newer application may not have been discovered yet). */
    getLatestAppModel(projectId: string): AppModel | null {
        const r = this.db.get<{ m: string }>(`SELECT app_model_json AS m FROM applications WHERE project_id = ? AND app_model_json IS NOT NULL ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC LIMIT 1`, projectId);
        return r ? JSON.parse(r.m) : null;
    }

    setAppModel(applicationId: string, model: AppModel): void {
        this.db.run("UPDATE applications SET app_model_json = ?, model_updated_at = ? WHERE id = ?", JSON.stringify(model), now(), applicationId);
    }

    // ── jobs / queue ────────────────────────────────────────────────────────
    /**
     * Checked before every job is created, whoever creates it (a person, a schedule, a trigger, a runbook): throws a plain HTTP 409 when
     * the project's tests run on a runner agent and none can take this job. Installed by agent-services.ts; absent = no check.
     */
    jobGate?: (projectId: string, options: JobOptions) => Promise<void>;

    /** Checked first: refuses a job whose tests are all of frameworks the project switched off, and drops switched-off kinds from an analysis (framework-settings-store.ts). */
    frameworkGate?: (projectId: string, options: JobOptions) => Promise<void>;

    /** Refuses (HTTP 409) a job that includes tests of an adapter plug-in framework that is not loaded or cannot run here (platform/plugin-gate.ts). */
    pluginGate?: (projectId: string, options: JobOptions) => Promise<void>;

    /** Why tests of an adapter plug-in framework can't be part of an automated run of this shape right now (undefined = they can). Automated runs leave them out (platform/plugin-policy.ts). */
    pluginPolicy?: (projectId: string, framework: string, shape: "validate" | "environment") => Promise<string | undefined>;

    /** Refuses (HTTP 409) a job that would run hand-written tests where they may not run (platform/custom-policy.ts). */
    customGate?: (projectId: string, options: JobOptions) => Promise<void>;
    /** May hand-written tests run for this project right now? Schedules and runbooks leave them out when not (platform/custom-policy.ts). */
    customPolicy?: (projectId: string) => Promise<{ allowed: true } | { allowed: false; message: string }>;

    /** Refuses (HTTP 409) a job that cannot be handed to a runner when the platform runs tests only on runners (platform/runner-only.ts). */
    executionGate?: (projectId: string, options: JobOptions) => Promise<void>;

    /**
     * Called for each job `reclaimStaleJobs` is about to put back in the queue or give up (runner-only.ts): a runner task of the earlier
     * attempt that is still alive is kept for the next attempt to pick up, unless the job is given up (`giveUp`) or no longer goes to a
     * runner; then it is cancelled first. `handedOver`: the platform restarted gracefully while the job was on a runner (runner-handover.ts).
     */
    beforeRequeue?: (jobId: string, o: { giveUp: boolean; handedOver: boolean }) => void;

    /** Async because its gates are (POSTGRES_S3_MIGRATION.md 3.2): they will read asynchronous stores; the insert itself is unchanged. */
    async createJob(projectId: string, applicationId: string, options: JobOptions): Promise<JobRow> {
        // An archived project starts no run, whoever asks (a person, a schedule, a deploy trigger): project-folders.ts.
        if (isArchived(this.db, projectId)) throw new HttpError(409, PROJECT_ARCHIVED);
        // The runner the person chose for this run, from the request that starts it (run-request.ts): in the options before the gates read them.
        const chosen = options.runner ? undefined : requestedRunnerId();
        if (chosen) options = { ...options, runner: { id: chosen } };
        // EXECUTION_MODE=runners: a job that would need this server's browser is refused before anything else is checked (runner-only.ts).
        await this.executionGate?.(projectId, options);
        await this.pluginGate?.(projectId, options);
        await this.frameworkGate?.(projectId, options);
        await this.jobGate?.(projectId, options);
        await this.customGate?.(projectId, options);
        const id = randomUUID();
        const t = now();
        this.db.run(
            `INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            id,
            projectId,
            applicationId,
            "QUEUED",
            // Who started it: the AI's drafts of this job are that person's change for review (routes/reviews.ts).
            JSON.stringify(options.startedBy || !startedByOf() ? options : { ...options, startedBy: startedByOf() }),
            JSON.stringify(emptyProgress()),
            JSON.stringify(emptyCounters()),
            t,
            t,
        );
        return this.getJob(id)!;
    }

    getJob(id: string): JobRow | undefined {
        const r = this.db.get("SELECT * FROM generation_jobs WHERE id = ?", id);
        return r ? toJob(r) : undefined;
    }

    listJobs(projectId: string): JobRow[] {
        return this.db.all("SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC", projectId).map(toJob);
    }

    /**
     * Atomically claim the oldest QUEUED job and lease it to this worker. The outer `status = 'QUEUED'` matters under PostgreSQL's
     * READ COMMITTED: a worker that waited on the row re-checks only the outer condition, so without it two workers could both get
     * the job. `skipLocked` lets the next worker pass over a row being claimed instead of waiting for it.
     */
    claimNextJob(leaseMs: number, owner: string, modes?: readonly JobMode[]): JobRow | undefined {
        // The dispatch worker (EXECUTION_MODE=runners) takes only the kinds of job a runner can do; the mode is a fixed word list, never input.
        const only = modes ? ` AND ${this.db.dialect.jsonText("options_json", "mode")} IN (${modes.map((m) => `'${m.replace(/[^a-z]/g, "")}'`).join(",")})` : "";
        const r = this.db.get(
            `UPDATE generation_jobs
                SET status = CASE ${this.db.dialect.jsonText("options_json", "mode")} WHEN 'validate' THEN 'VALIDATING' ELSE 'DISCOVERING' END,
                    lease_until = ?, lease_owner = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?), updated_at = ?
              WHERE id = (SELECT id FROM generation_jobs WHERE status = 'QUEUED'${only} ORDER BY created_at LIMIT 1${this.db.dialect.skipLocked()}) AND status = 'QUEUED'
          RETURNING *`,
            Date.now() + leaseMs,
            owner,
            now(),
            now(),
        );
        return r ? toJob(r) : undefined;
    }

    /**
     * Queued jobs of kinds a dispatch worker never takes (made before the platform ran tests only on runners): ended with `reason`, so they do
     * not wait forever and hold their project's one active job. Returns how many.
     */
    failQueuedJobsExcept(modes: readonly JobMode[], reason: string): number {
        const mode = this.db.dialect.jsonText("options_json", "mode");
        const list = modes.map((m) => `'${m.replace(/[^a-z]/g, "")}'`).join(",");
        const rows = this.db.all<{ id: string }>(`SELECT id FROM generation_jobs WHERE status = 'QUEUED' AND (${mode} IS NULL OR ${mode} NOT IN (${list}))`);
        for (const { id } of rows) {
            this.db.run("UPDATE generation_jobs SET status = 'FAILED', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'", reason, now(), now(), id);
            eventBus.publish(id);
        }
        return rows.length;
    }

    /** The job `claimNextJob` would take next, without taking it. */
    nextQueuedJobId(): string | undefined {
        return this.db.get<{ id: string }>("SELECT id FROM generation_jobs WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1")?.id;
    }

    /** Renews the lease only while this worker still owns the job. False = ownership lost; stop work. */
    heartbeat(jobId: string, leaseMs: number, owner: string): boolean {
        const r = this.db.run(
            "UPDATE generation_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status IN ('DISCOVERING','ANALYZING','PLANNING','GENERATING','VALIDATING')",
            Date.now() + leaseMs,
            now(),
            jobId,
            owner,
        );
        return Number(r.changes) > 0;
    }

    /**
     * Jobs whose worker died (lease expired) are re-queued, or failed after 3 attempts. Partial output of
     * generation jobs is removed; validation-only jobs never own generated output (their tests were
     * imported or already existed), so those tests are only taken out of VALIDATING.
     */
    reclaimStaleJobs(): number {
        const stale = this.db.all<Row>(
            `SELECT id, attempts, lease_owner, ${this.db.dialect.jsonText("options_json", "mode")} AS mode, ${this.db.dialect.jsonText("options_json", "testIds")} AS test_ids
               FROM generation_jobs WHERE status IN ('DISCOVERING','ANALYZING','PLANNING','GENERATING','VALIDATING') AND lease_until < ?`,
            Date.now(),
        );
        for (const s of stale) {
            // A job handed over by a graceful restart was not lost: it goes back to the queue whatever its attempts (handOverJob did not count it).
            const handedOver = s.lease_owner === HANDED_OVER;
            const giveUp = !handedOver && s.attempts >= 3;
            // A runner may still be running the earlier attempt: the next attempt picks that task up (never a second one at once); a job
            // given up, or one that no longer goes to a runner, has it cancelled first.
            try {
                this.beforeRequeue?.(s.id, { giveUp, handedOver });
            } catch (err) {
                console.warn(`[job ${String(s.id).slice(0, 8)}] could not look after the earlier attempt's runner tasks:`, err);
            }
            this.db.tx(() => {
                if (s.mode === "validate") {
                    // Losing the worker is not a verdict on any test, the third time either: tests without a result go back to not run yet
                    // (what they were before the run is known only to the process that was lost), and the job says why it was given up.
                    const ids: string[] = s.test_ids ? JSON.parse(s.test_ids) : [];
                    this.resetValidatingTests(ids, "PENDING", null);
                } else {
                    this.db.run("DELETE FROM test_cases WHERE job_id = ?", s.id);
                }
                if (giveUp) {
                    this.db.run("UPDATE generation_jobs SET status='FAILED', error=?, finished_at=?, updated_at=? WHERE id=?", WORKER_LOST_GIVE_UP, now(), now(), s.id);
                } else {
                    this.db.run(
                        "UPDATE generation_jobs SET status='QUEUED', progress_json=?, counters_json=?, lease_until=NULL, lease_owner=NULL, updated_at=? WHERE id=?",
                        JSON.stringify(emptyProgress()),
                        JSON.stringify(emptyCounters()),
                        now(),
                        s.id,
                    );
                }
            });
        }
        return stale.length;
    }

    /**
     * A graceful restart hands a job that waits for a runner over to the next platform process (runner-handover.ts): its lease is released
     * at once with the HANDED_OVER mark, and the attempt is not counted (the claim that takes it again adds it back). Only while `owner`
     * still holds it. True when it was handed over.
     */
    handOverJob(jobId: string, owner: string): boolean {
        const r = this.db.run(
            "UPDATE generation_jobs SET lease_owner = ?, lease_until = 0, attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END, updated_at = ? WHERE id = ? AND lease_owner = ? AND status IN ('DISCOVERING','ANALYZING','PLANNING','GENERATING','VALIDATING')",
            HANDED_OVER,
            now(),
            jobId,
            owner,
        );
        return Number(r.changes) === 1;
    }

    /** Tests left in VALIDATING by an interrupted validation job get a truthful final state. */
    resetValidatingTests(ids: string[], status: "PENDING" | "FAILED_VALIDATION", reason: string | null): void {
        for (const id of ids) {
            this.db.run("UPDATE test_cases SET validation_status = ?, validation_reason = ?, updated_at = ? WHERE id = ? AND validation_status = 'VALIDATING'", status, reason, now(), id);
        }
    }

    /** True if `owner` still holds the job's lease. */
    ownsJob(jobId: string, owner: string): boolean {
        return Boolean(this.db.get("SELECT 1 FROM generation_jobs WHERE id = ? AND lease_owner = ?", jobId, owner));
    }

    setJobStatus(jobId: string, status: JobStatus, error?: string): void {
        const terminal = TERMINAL_STATES.includes(status);
        this.db.run(
            "UPDATE generation_jobs SET status = ?, error = COALESCE(?, error), finished_at = CASE WHEN ? THEN ? ELSE finished_at END, lease_until = CASE WHEN ? THEN NULL ELSE lease_until END, updated_at = ? WHERE id = ?",
            status,
            error ?? null,
            terminal ? 1 : 0,
            now(),
            terminal ? 1 : 0,
            now(),
            jobId,
        );
        eventBus.publish(jobId);
    }

    setPhase(jobId: string, phase: Phase, state: PhaseState): void {
        const job = this.getJob(jobId);
        if (!job) return;
        job.progress[phase] = state;
        this.db.run("UPDATE generation_jobs SET progress_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(job.progress), now(), jobId);
        eventBus.publish(jobId);
    }

    updateCounters(jobId: string, patch: Partial<JobCounters>, add = false): void {
        const job = this.getJob(jobId);
        if (!job) return;
        const next = { ...job.counters };
        for (const [k, v] of Object.entries(patch) as Array<[keyof JobCounters, number]>) next[k] = add ? next[k] + v : v;
        this.db.run("UPDATE generation_jobs SET counters_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(next), now(), jobId);
        eventBus.publish(jobId);
    }

    requestCancel(jobId: string): boolean {
        const r = this.db.run("UPDATE generation_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED')", now(), jobId);
        // A job that has not started can be cancelled immediately.
        this.db.run("UPDATE generation_jobs SET status='FAILED', error='Cancelled', finished_at=?, updated_at=? WHERE id=? AND status='QUEUED'", now(), now(), jobId);
        return Number(r.changes) > 0;
    }

    isCancelRequested(jobId: string): boolean {
        return Boolean(this.db.get<Row>("SELECT cancel_requested FROM generation_jobs WHERE id = ?", jobId)?.cancel_requested);
    }

    // ── events / agent runs ─────────────────────────────────────────────────
    addEvent(jobId: string, e: EngineEvent): void {
        this.db.run(
            "INSERT INTO agent_events (job_id, stage, kind, level, message, data_json, created_at) VALUES (?,?,?,?,?,?,?)",
            jobId,
            e.stage,
            e.kind,
            e.level ?? "info",
            e.message.slice(0, 1000),
            j(e.data),
            now(),
        );
        // Wakes live streams in this process at once; other processes are seen through the database (stream-core.ts).
        eventBus.publish(jobId);
    }

    listEvents(jobId: string, afterId = 0, limit = 500): Row[] {
        return this.db
            .all("SELECT * FROM agent_events WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?", jobId, afterId, limit)
            .map((r) => ({ id: r.id, stage: r.stage, kind: r.kind, level: r.level, message: r.message, data: r.data_json ? JSON.parse(r.data_json) : null, createdAt: r.created_at }));
    }

    startAgentRun(jobId: string, role: string, subject: string): string {
        const id = randomUUID();
        this.db.run("INSERT INTO agent_runs (id, job_id, role, subject, status, started_at) VALUES (?,?,?,?,?,?)", id, jobId, role, subject, "RUNNING", now());
        return id;
    }
    finishAgentRun(id: string, status: string, summary?: string): void {
        this.db.run("UPDATE agent_runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?", status, summary?.slice(0, 1000) ?? null, now(), id);
    }
    addAgentAction(runId: string, a: { tool: string; args: unknown; ok: boolean; observation: string }): void {
        this.db.run("INSERT INTO agent_actions (run_id, tool, args_json, ok, observation, created_at) VALUES (?,?,?,?,?,?)", runId, a.tool, j(a.args), a.ok ? 1 : 0, a.observation.slice(0, 500), now());
    }

    // ── suites / tests ──────────────────────────────────────────────────────
    getOrCreateSuite(projectId: string, name: string, slug: string): string {
        const hit = this.db.get<{ id: string }>("SELECT id FROM test_suites WHERE project_id = ? AND slug = ?", projectId, slug);
        if (hit) return hit.id;
        // A caller that created the same suite since the read wins; this one then uses its row instead of failing on UNIQUE (project_id, slug).
        const made = this.db.get<{ id: string }>("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES (?,?,?,?,?) ON CONFLICT (project_id, slug) DO NOTHING RETURNING id", randomUUID(), projectId, name, slug, now());
        return made?.id ?? this.db.get<{ id: string }>("SELECT id FROM test_suites WHERE project_id = ? AND slug = ?", projectId, slug)!.id;
    }

    getSuite(id: string): Row | undefined {
        return this.db.get("SELECT * FROM test_suites WHERE id = ?", id);
    }

    nextTestKey(projectId: string, prefix: string): string {
        const row = this.db.get<{ m: number | null }>(
            "SELECT MAX(CAST(SUBSTR(test_key, ?) AS INTEGER)) AS m FROM test_cases WHERE project_id = ? AND test_key LIKE ?",
            prefix.length + 2,
            projectId,
            `${prefix}-%`,
        );
        return `${prefix}-${String((row?.m ?? 0) + 1).padStart(3, "0")}`;
    }

    /** Which of `keys` already exist in the project. */
    existingTestKeys(projectId: string, keys: string[]): string[] {
        return keys.filter((k) => this.db.get("SELECT 1 FROM test_cases WHERE project_id = ? AND test_key = ?", projectId, k));
    }

    /** Attach tests to the job that created/imported them (reporting + `?jobId=` filtering). */
    setTestsJob(ids: string[], jobId: string): void {
        for (const id of ids) this.db.run("UPDATE test_cases SET job_id = ? WHERE id = ?", jobId, id);
    }

    insertTest(args: {
        projectId: string;
        suiteId: string;
        jobId: string | null;
        spec: TestSpec;
        framework: Framework;
        validationStatus: ValidationState;
        meta?: Record<string, unknown>;
        /** What made this test, for review and approval (review-store.ts); left out, it is inferred from who is acting. */
        versionSource?: VersionSource;
    }): string {
        const id = randomUUID();
        const t = now();
        this.db.run(
            `INSERT INTO test_cases (id, project_id, suite_id, job_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, generation_meta_json, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id,
            args.projectId,
            args.suiteId,
            args.jobId,
            args.spec.testId,
            args.spec.title,
            args.spec.kind,
            args.spec.type,
            args.spec.priority,
            args.validationStatus,
            args.framework,
            JSON.stringify(args.spec),
            j(args.meta),
            t,
            t,
        );
        if (refNames(args.spec).length) syncLocatorUsage(this.db, args.projectId, id, args.spec);
        // Review and approval: the new test's first version, a draft or approved as the project's policy says.
        trackTestVersion(this.db, id, args.versionSource);
        return id;
    }

    updateTest(id: string, patch: { spec?: TestSpec; validationStatus?: ValidationState; reason?: string | null; attempts?: number; meta?: Record<string, unknown>; versionSource?: VersionSource }): void {
        const sets: string[] = ["updated_at = ?"];
        const vals: Array<string | number | null> = [now()];
        // A hand-written test's script is its source of truth: its (archived) spec is never rewritten, whoever asks (repairs, healing, rewrites).
        // The refused change is told to review and approval, so the code's sync status says the steps moved on without it.
        let refusedSpec: string | undefined;
        if (patch.spec && this.db.get("SELECT 1 AS x FROM custom_tests WHERE test_case_id = ?", id)) (refusedSpec = JSON.stringify(collapseRefs(collapseBlocks(patch.spec)))), (patch = { ...patch, spec: undefined });
        if (patch.spec) {
            // The engine works on resolved specs; the stored form keeps the reference to a shared element (see engine/locators/refs.ts).
            // The same for reusable steps: unchanged expanded steps go back to the one `useBlock` step they came from.
            patch = { ...patch, spec: collapseRefs(collapseBlocks(patch.spec)) };
            sets.push("spec_json = ?", "title = ?", "priority = ?", "type = ?");
            vals.push(JSON.stringify(patch.spec), patch.spec!.title, patch.spec!.priority, patch.spec!.type);
        }
        if (patch.validationStatus) (sets.push("validation_status = ?"), vals.push(patch.validationStatus));
        if (patch.reason !== undefined) (sets.push("validation_reason = ?"), vals.push(patch.reason));
        if (patch.attempts !== undefined) (sets.push("attempts = ?"), vals.push(patch.attempts));
        if (patch.meta) (sets.push("generation_meta_json = ?"), vals.push(JSON.stringify(patch.meta)));
        this.db.run(`UPDATE test_cases SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
        if (patch.spec) {
            // Which shared elements the test uses follows its spec; a test that never used any costs one indexed delete.
            const names = refNames(patch.spec);
            const row = names.length ? this.db.get<{ project_id: string }>("SELECT project_id FROM test_cases WHERE id = ?", id) : undefined;
            if (row) syncLocatorUsage(this.db, row.project_id, id, patch.spec);
            else this.db.run("DELETE FROM locator_usage WHERE test_case_id = ?", id);
        }
        // Review and approval: changed steps make a new version (a draft or approved as the project's policy says).
        if (patch.spec || refusedSpec !== undefined) trackTestVersion(this.db, id, patch.versionSource, refusedSpec);
    }

    getTest(id: string): TestRow | undefined {
        const r = this.db.get(`${TEST_SELECT} WHERE t.id = ?`, id);
        return r ? toTest(r) : undefined;
    }

    listTests(projectId: string, f: { jobId?: string; kind?: string; validationStatus?: string; suite?: string; q?: string } = {}): TestRow[] {
        const where = ["t.project_id = ?"];
        const params: string[] = [projectId];
        if (f.jobId) (where.push("t.job_id = ?"), params.push(f.jobId));
        if (f.kind) (where.push("t.kind = ?"), params.push(f.kind));
        if (f.validationStatus) (where.push("t.validation_status = ?"), params.push(f.validationStatus));
        if (f.suite) (where.push("s.slug = ?"), params.push(f.suite));
        if (f.q) (where.push(`(${this.db.dialect.likeInsensitive("t.title")} OR ${this.db.dialect.likeInsensitive("t.test_key")})`), params.push(`%${f.q}%`, `%${f.q}%`));
        return this.db.all(`${TEST_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.test_key`, ...params).map(toTest);
    }

    listSuites(projectId: string): Row[] {
        return this.db.all(
            `SELECT s.id, s.name, s.slug,
                COUNT(t.id) AS total,
                SUM(CASE WHEN t.validation_status = 'VALIDATED' THEN 1 ELSE 0 END) AS validated
             FROM test_suites s LEFT JOIN test_cases t ON t.suite_id = s.id WHERE s.project_id = ? GROUP BY s.id ORDER BY s.name`,
            projectId,
        );
    }

    // ── scripts / executions / artifacts ────────────────────────────────────
    addScript(testId: string, s: { framework: Framework; filename: string; content: string; hash: string; storagePath: string; executable: boolean; /** False: kept as a record of a run, and what the test holds stays as it is. */ current?: boolean }): string {
        const current = s.current !== false;
        const id = randomUUID();
        // The unique index on (test_case_id, framework, version) turns a concurrent writer taking the same number into an error; the whole transaction is then tried again.
        retryOnUniqueViolation(this.db.dialect, () => this.db.tx(() => {
            const v = this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM generated_scripts WHERE test_case_id = ? AND framework = ?", testId, s.framework);
            if (current) this.db.run("UPDATE generated_scripts SET is_current = 0 WHERE test_case_id = ? AND framework = ?", testId, s.framework);
            this.db.run(
                "INSERT INTO generated_scripts (id, test_case_id, framework, filename, content, content_hash, storage_path, version, is_current, executable, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                id,
                testId,
                s.framework,
                s.filename,
                s.content,
                s.hash,
                s.storagePath,
                (v?.v ?? 0) + 1,
                current ? 1 : 0,
                s.executable ? 1 : 0,
                now(),
            );
        }));
        // A person's code is what such a test runs: new code is a new version for review and approval (review-store.ts).
        if (current && this.db.get("SELECT 1 AS x FROM custom_tests WHERE test_case_id = ?", testId)) trackTestVersion(this.db, testId);
        return id;
    }

    listScripts(testId: string, currentOnly = true): Row[] {
        return this.db.all(`SELECT * FROM generated_scripts WHERE test_case_id = ? ${currentOnly ? "AND is_current = 1" : ""} ORDER BY created_at DESC`, testId);
    }

    getCurrentScript(testId: string, framework?: string): Row | undefined {
        return framework
            ? this.db.get("SELECT * FROM generated_scripts WHERE test_case_id = ? AND framework = ? AND is_current = 1", testId, framework)
            : this.db.get("SELECT * FROM generated_scripts WHERE test_case_id = ? AND is_current = 1 AND executable = 1 ORDER BY created_at DESC LIMIT 1", testId);
    }

    addExecution(args: {
        testId: string;
        scriptId: string | null;
        jobId: string | null;
        attempt: number;
        status: string;
        durationMs: number;
        error?: string;
        startedAt: string;
        steps: Array<{ index: number; title: string; status: string; error?: string }>;
    }): string {
        const id = randomUUID();
        this.db.tx(() => {
            this.db.run(
                "INSERT INTO test_executions (id, test_case_id, script_id, job_id, attempt, status, duration_ms, error, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                id,
                args.testId,
                args.scriptId,
                args.jobId,
                args.attempt,
                args.status,
                args.durationMs,
                args.error ?? null,
                args.startedAt,
                now(),
            );
            for (const s of args.steps) {
                this.db.run("INSERT INTO test_execution_steps (id, execution_id, idx, title, status, error) VALUES (?,?,?,?,?,?)", randomUUID(), id, s.index, s.title, s.status, s.error ?? null);
            }
        });
        return id;
    }

    listExecutions(testId: string): Row[] {
        return this.db.all("SELECT * FROM test_executions WHERE test_case_id = ? AND variant IS NULL AND environment IS NULL ORDER BY started_at DESC", testId).map((e) => ({
            id: e.id,
            attempt: e.attempt,
            status: e.status,
            durationMs: e.duration_ms,
            error: e.error,
            startedAt: e.started_at,
            finishedAt: e.finished_at,
            steps: this.db
                .all("SELECT idx, title, status, error FROM test_execution_steps WHERE execution_id = ? ORDER BY idx", e.id)
                .map((s) => ({ index: s.idx, title: s.title, status: s.status, error: s.error })),
            artifacts: this.listArtifacts({ executionId: e.id }),
        }));
    }

    addArtifact(a: { projectId: string; jobId?: string; testId?: string; executionId?: string; kind: string; path: string; size: number }): string {
        const id = randomUUID();
        this.db.run("INSERT INTO artifacts (id, project_id, job_id, test_case_id, execution_id, kind, path, size, created_at) VALUES (?,?,?,?,?,?,?,?,?)", id, a.projectId, a.jobId ?? null, a.testId ?? null, a.executionId ?? null, a.kind, a.path, a.size, now());
        return id;
    }

    /** Insert an artifact, replacing any earlier row for the same test, kind and path (e.g. a baseline). */
    replaceArtifact(a: { projectId: string; jobId?: string; testId: string; kind: string; path: string; size: number }): string {
        return this.db.tx(() => {
            this.db.run("DELETE FROM artifacts WHERE test_case_id = ? AND kind = ? AND path = ?", a.testId, a.kind, a.path);
            return this.addArtifact(a);
        });
    }

    listArtifacts(f: { executionId?: string; testId?: string; jobId?: string }): Row[] {
        const col = f.executionId ? ["execution_id", f.executionId] : f.testId ? ["test_case_id", f.testId] : ["job_id", f.jobId ?? ""];
        return this.db.all(`SELECT id, kind, path, size, created_at, pruned_at FROM artifacts WHERE ${col[0]} = ? ORDER BY created_at`, col[1]!);
    }

    getArtifact(id: string): Row | undefined {
        return this.db.get("SELECT * FROM artifacts WHERE id = ?", id);
    }
}
