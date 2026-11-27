import { runnerOwnerOf } from "./agent-store.js";
/**
 * Deploy triggers wired to one platform: start a re-run of the project's tests for a token, report its progress and result,
 * and deliver the optional callback when the run ends. The job is the same one a schedule starts (a "validate" job over every
 * test this machine can run), labelled as started by a deploy. In an Agent Workspace project a token runs one agent (D1): the run its
 * Explore again schedule would start, of the agent the token keeps.
 */
import { noteCustomSkipped } from "./custom-policy.js";
import { notePluginSkipped } from "./plugin-policy.js";
import { z } from "zod";
import { isAppUri } from "../engine/desktop/target.js";
import type { Platform } from "./bootstrap.js";
import { deliver, type DeliveryOptions } from "./alerts.js";
import { HttpError } from "./http-error.js";
import { refuseTestsInCaseAgentProject } from "./case-agent.js";
import { assertRunTarget } from "./agent-services.js";
import { assertAllowedTarget } from "./net-guard.js";
import { assertC4tOwnerMayRun } from "./c4t-service.js";
import { ignoredNote } from "../engine/quarantine/rules.js";
import { passRate } from "../engine/summary/pass-rate.js";
import { gateJob } from "./quarantine-service.js";
import { DEFAULT_JOB_OPTIONS, TERMINAL_STATES, type JobOptions, type JobRow } from "./repo.js";
import { activeJobOf, OverlapError, runnableTestIds, startScheduledJob } from "./scheduler.js";
import { workspaceAgents } from "./agent-workspace.js";
import { runAgentOf, TestingAgentStore } from "./testing-agents.js";
import { refuseUnlessRunsStart } from "./suite-run.js";
import { SecretBox } from "./secrets.js";
import { projectCoverage } from "./selection/facts.js";
import { focusedSelection, MAX_CHANGES } from "./selection/preview.js";
import { TriggerStore, type TriggerToken } from "./trigger-store.js";

/** One accepted run per token per this long. */
export const MIN_RUN_GAP_MS = 30_000;

export const TriggerRunBody = z.object({
    /** A label for where the deploy went ("staging"); stored and shown, never interpreted. */
    environment: z.string().trim().min(1).max(60).regex(/^[\w .:/-]+$/, "environment may contain letters, digits, spaces and . : / _ -").optional(),
    /** The commit (or build) that was deployed. */
    commit: z.string().trim().min(1).max(80).regex(/^[\w./@:+-]+$/, "commit may contain letters, digits and . / @ : + _ -").optional(),
    /** Run against this address instead (a preview deployment). Honoured only when the token allows it and the address is allowed. */
    url: z.string().max(2000).optional(),
    /** Where to POST the result when the run has finished. */
    callbackUrl: z.string().url().max(2000).optional(),
    /**
     * "full" (the default): every runnable test, as before. "focused": only the tests the selection preview proposes for the changed
     * `pages` and `endpoints` (selection/preview.ts focusedSelection). Focused is never chosen for a pipeline: only this field picks it.
     */
    selection: z.enum(["focused", "full"]).default("full"),
    pages: z.array(z.string().trim().min(1).max(500)).max(MAX_CHANGES).optional(),
    endpoints: z.array(z.string().trim().min(1).max(500)).max(MAX_CHANGES).optional(),
});
export type TriggerRunInput = z.infer<typeof TriggerRunBody>;

/** Thrown when a token asks for a run sooner than its rate limit allows. */
export class RateLimited extends HttpError {
    constructor(readonly retryAfterSec: number) {
        super(429, `This token can start one run every ${MIN_RUN_GAP_MS / 1000} seconds; try again in ${retryAfterSec} second${retryAfterSec === 1 ? "" : "s"}`);
    }
}

export type TriggerState = "queued" | "running" | "passed" | "failed" | "error" | "cancelled";

/** What a pipeline needs to know about a run. */
export interface TriggerStatus {
    jobId: string;
    state: TriggerState;
    finished: boolean;
    /** True/false once finished; null while the run is going. */
    passed: boolean | null;
    summary: { total: number; passed: number; failed: number; needsReview: number; passRate: number | null };
    /** The tests that did not pass (up to 20), once finished. */
    failures: Array<{ testId: string; title: string; status: string }>;
    /** Quarantined tests that did not pass. They are left out of `passed`, `failures` and the pass rate. Present only when there are some. */
    quarantined?: Array<{ testId: string; title: string; status: string }>;
    commit: string | null;
    environment: string | null;
    createdAt: string;
    finishedAt: string | null;
    message?: string;
}

export interface TriggerServiceOptions {
    clock?: () => number;
    delivery?: DeliveryOptions;
    minGapMs?: number;
}

export interface TriggerServices {
    store: TriggerStore;
    /** The shortest time between two accepted runs of one token (runbook starts by a token use it too). */
    minGapMs: number;
    run(token: string, input: unknown): Promise<{ job: JobRow; testCount: number; ignored: string[]; selection: "focused" | "full"; fullRunReasons?: string[] }>;
    status(token: string, jobId: string): TriggerStatus;
    /** Worker hook: delivers the callback of a finished deploy run. Never throws. */
    onJobFinished(job: JobRow): Promise<void>;
}

const cache = new WeakMap<Platform, TriggerServices>();
const notFound = () => new HttpError(404, "Not found");

/** An old deploy token (no agent kept) in a Workspace project with several agents and no Test Case Generation: how to fix it. */
export const OLD_TOKEN_NO_AGENT = "This deploy token was made before tokens named an agent, and this project has several testing agents. On the Workspace open After a deploy, choose New token and the agent to run, put the new token in your pipeline, then revoke this one.";

export function getTriggerServices(p: Platform, opts: TriggerServiceOptions = {}): TriggerServices {
    const hit = cache.get(p);
    if (hit) return hit;
    const { repo } = p;
    const clock = opts.clock ?? Date.now;
    const minGap = opts.minGapMs ?? MIN_RUN_GAP_MS;
    const secrets = new SecretBox(p.config.dataDir, p.config.SECRET_KEY);
    const store = new TriggerStore(p.db, secrets, clock);

    const failuresOf = (job: JobRow, skip: Set<string> = new Set()) =>
        (job.options.testIds ?? [])
            .filter((id) => !skip.has(id))
            .map((id) => repo.getTest(id))
            .filter((t): t is NonNullable<typeof t> => Boolean(t) && (t!.validationStatus === "FAILED_VALIDATION" || t!.validationStatus === "NEEDS_REVIEW"))
            .slice(0, 20)
            .map((t) => ({ testId: t.testKey, title: t.title, status: t.validationStatus }));

    const statusOf = (job: JobRow, run: { commit: string | null; environment: string | null }): TriggerStatus => {
        const finished = TERMINAL_STATES.includes(job.status);
        const c = job.counters;
        const total = c.testsGenerated;
        let state: TriggerState;
        if (!finished) state = job.status === "QUEUED" ? "queued" : "running";
        else if (job.status === "FAILED") state = job.error === "Cancelled" ? "cancelled" : "error";
        else state = job.status === "COMPLETED" ? "passed" : "failed";
        // Failures of quarantined tests do not fail the run: they are listed apart, and the message says so.
        const held = finished && job.status !== "FAILED" ? gateJob(repo, job) : null;
        const heldIds = new Set((held?.held ?? []).map((r) => r.id));
        if (held && state === "failed" && c.testsFailedValidation + c.testsNeedingReview - held.failed <= 0) state = "passed";
        const counted = held ? total - held.held.length : total;
        const countedPassed = held ? c.testsValidated - held.passed : c.testsValidated;
        const quarantined = (held?.held ?? []).filter((r) => r.s !== "p").map((r) => ({ testId: r.key, title: r.title, status: r.s === "r" ? "NEEDS_REVIEW" : "FAILED_VALIDATION" }));
        return {
            jobId: job.id,
            state,
            finished,
            passed: finished ? state === "passed" : null,
            summary: { total, passed: c.testsValidated, failed: c.testsFailedValidation, needsReview: c.testsNeedingReview, passRate: passRate(countedPassed, counted) },
            failures: finished ? failuresOf(job, heldIds) : [],
            ...(quarantined.length ? { quarantined } : {}),
            commit: run.commit,
            environment: run.environment,
            createdAt: job.createdAt,
            finishedAt: job.finishedAt,
            ...(state === "error" && job.error ? { message: job.error.slice(0, 300) } : {}),
            ...(held ? { message: `${state === "passed" ? "Passed" : "Failed"} ${ignoredNote(held.held.length)}` } : {}),
        };
    };

    /** The token's own run, or a 404: a token reveals nothing about other projects' jobs. */
    const runOf = (token: TriggerToken, jobId: string) => {
        const run = store.getRun(jobId);
        const job = run && run.tokenId === token.id ? repo.getJob(jobId) : undefined;
        if (!run || !job) throw notFound();
        return { run, job };
    };

    const services: TriggerServices = {
        store,
        minGapMs: minGap,

        async run(presented, rawInput) {
            const token = store.find(presented);
            if (!token) throw notFound();
            const wait = store.waitMs(token, minGap);
            if (wait > 0) throw new RateLimited(Math.ceil(wait / 1000));
            const input = TriggerRunBody.parse(rawInput ?? {});
            if (input.selection === "focused" && !input.pages?.length && !input.endpoints?.length) throw new HttpError(400, "A focused run needs the changed pages or endpoints.");
            // The run is the token maker's, with nobody signed in: a Crowd4Test maker is asked about first (c4t-service.ts).
            await assertC4tOwnerMayRun(p, token.createdBy);
            const row = repo.getProject(token.projectId);
            const agents = new TestingAgentStore(repo.db.sql, repo);
            const agentRun = Boolean(row && (await workspaceAgents(agents, row))?.length);
            if (!agentRun) await refuseTestsInCaseAgentProject(repo, token.projectId); // a Test Case Generation project runs no tests (case-agent.ts)
            if (agentRun && input.selection === "focused") throw new HttpError(400, "This token runs a testing agent, which explores the whole application: leave out selection, pages and endpoints.");

            const app = repo.getLatestApplicationPublic(token.projectId);
            if (!app) throw new HttpError(409, "This project has no application yet. Run an analysis or import tests first.");
            const ignored: string[] = [];
            let applicationId = app.id as string;
            let appUrl = app.url as string;

            // A different address (a preview deployment) only when the token was made to allow it and the platform allows the address.
            if (input.url) {
                try {
                    if (!token.allowUrl) throw new Error("this token may only run against the project's own address");
                    const target = new URL(input.url);
                    await assertRunTarget(token.projectId, target.href);
                    if (target.href !== appUrl) {
                        const full = repo.getApplication(applicationId);
                        applicationId = repo.createApplication(token.projectId, target.href, full?.config ?? {}, full?.credentials);
                        appUrl = target.href;
                    }
                } catch (e) {
                    ignored.push(`url ignored: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (!isAppUri(appUrl)) await assertRunTarget(token.projectId, appUrl);
            if (input.callbackUrl) await assertAllowedTarget(input.callbackUrl);

            refuseUnlessRunsStart(p); // tests switched off on this server: the pipeline is told, nothing is queued
            const startedBy = { kind: "trigger", id: token.id, ownerId: token.createdBy };
            const deploy = { ...(input.commit ? { commit: input.commit } : {}), ...(input.environment ? { environment: input.environment } : {}), ...(token.label ? { label: token.label } : {}) };
            if (agentRun) {
                // A token made before tokens kept an agent (migration 76) runs the project's default agent; with none, say how to fix it.
                if (!token.agentId && row) await runAgentOf(agents, row, undefined).catch((e) => Promise.reject(e instanceof HttpError && e.status === 400 ? new HttpError(400, OLD_TOKEN_NO_AGENT) : e));
                const busy = await activeJobOf(repo, token.projectId, { verifyYields: true });
                if (busy) throw new HttpError(409, `An agent is already running in this project (${busy.status.toLowerCase().replace(/_/g, " ")}). Try again when that run has finished.`);
                if (!store.claimSlot(token.id, minGap)) throw new RateLimited(Math.max(1, Math.ceil(store.waitMs(store.find(presented) ?? token, minGap) / 1000)));
                let job: JobRow;
                try {
                    job = await startScheduledJob(repo, { id: token.id, projectId: token.projectId, kind: "generate", agentId: token.agentId, createdBy: token.createdBy, retryFailures: 0 }, { trigger: "deploy", startedBy, deploy });
                } catch (e) {
                    if (e instanceof HttpError) throw e;
                    throw new HttpError(409, e instanceof OverlapError ? "An agent is already running in this project. Try again when that run has finished." : (e as Error).message);
                }
                store.addRun({ jobId: job.id, tokenId: token.id, commit: input.commit, environment: input.environment, callbackUrl: input.callbackUrl });
                return { job, testCount: 0, ignored, selection: "full" };
            }
            const coverage = input.selection === "focused" ? await projectCoverage(repo, p.store, token.projectId) : undefined;
            // From here to the insert nothing is awaited: no other job can slip in between the checks and the create.
            let testIds = await runnableTestIds(repo, token.projectId, "validate", runnerOwnerOf(token.createdBy));
            if (testIds.length === 0) throw new HttpError(409, "This project has no tests that can be run yet.");
            let fullRunReasons: string[] = [];
            if (coverage) {
                ({ testIds, fullRunReasons } = focusedSelection(coverage.tests, new Set(testIds), input, coverage.app, coverage.apiPrefix));
                if (testIds.length === 0) throw new HttpError(409, "No runnable test is proposed for this change. Run the full suite instead.");
            }
            const busy = await activeJobOf(repo, token.projectId, { verifyYields: true });
            if (busy) throw new HttpError(409, `Tests are already running for this project (${busy.status.toLowerCase().replace(/_/g, " ")}). Try again when that run has finished.`);
            if (!store.claimSlot(token.id, minGap)) throw new RateLimited(Math.max(1, Math.ceil(store.waitMs(store.find(presented) ?? token, minGap) / 1000)));

            const options: JobOptions = {
                ...DEFAULT_JOB_OPTIONS,
                mode: "validate",
                testIds,
                trigger: "deploy",
                // Whose runner runs it: the person who made the token (round 45; null for an older token, refused by the job gate).
                startedBy,
                deploy,
            };
            const job = await repo.createJob(token.projectId, applicationId, options);
            await noteCustomSkipped(repo, job.id, token.projectId);
            await notePluginSkipped(repo, job.id, token.projectId);
            store.addRun({ jobId: job.id, tokenId: token.id, commit: input.commit, environment: input.environment, callbackUrl: input.callbackUrl });
            return { job, testCount: testIds.length, ignored, selection: input.selection, ...(fullRunReasons.length ? { fullRunReasons } : {}) };
        },

        status(presented, jobId) {
            const token = store.find(presented);
            if (!token) throw notFound();
            store.touch(token.id);
            const { run, job } = runOf(token, jobId);
            return statusOf(job, run);
        },

        async onJobFinished(job) {
            try {
                if (job.options.trigger !== "deploy") return;
                const run = store.getRun(job.id);
                const url = run ? store.claimCallback(job.id) : undefined;
                if (!run || !url) return;
                const project = repo.getProject(job.projectId);
                const status = statusOf(job, run);
                const base = (p.config.PUBLIC_URL || `http://${p.config.HOST === "0.0.0.0" || p.config.HOST === "::" ? "localhost" : p.config.HOST}:${p.config.PORT}`).replace(/\/+$/, "");
                const result = await deliver(
                    url,
                    { event: "deploy_run_finished", sentAt: new Date().toISOString(), project: { id: job.projectId, name: project?.name ?? null }, link: `${base}/#/projects/${job.projectId}/runs`, ...status },
                    opts.delivery,
                );
                store.finishCallback(job.id, result.ok, result.ok ? undefined : (result.error ?? "not delivered"));
            } catch (err) {
                console.error(`[job ${job.id.slice(0, 8)}] trigger callback failed:`, err instanceof Error ? err.message : err);
            }
        },
    };
    cache.set(p, services);
    return services;
}
