/**
 * What the platform does around an agent run (the engine part is engine/agent/objective.ts): whether one can start here, resolving the address and
 * sign-in when it runs, saving steps and pictures through the normal artifact path, waiting for a person's approval, and turning a finished run
 * into a draft test.
 *
 * Where it runs: in a job, so on the worker that takes the job. A job of this mode cannot go to a runner yet: the runner protocol carries finished
 * scripts and recordings driven step by step by a person, not a model loop. On a server with no worker or no AI key a run is refused at the start.
 */
import path from "node:path";
import type { Config } from "../config.js";
import type { ApprovalAnswer, ApprovalRequest, ObjectiveLimits, ObjectiveOutcome } from "../engine/agent/objective.js";
import { pursueObjective } from "../engine/agent/objective.js";
import { launchChromium } from "../engine/discovery/browser.js";
import type { EngineContext } from "../engine/context.js";
import type { SessionOptions } from "../engine/discovery/browser.js";
import { TestSpecSchema, type Step, type TestSpec } from "../engine/spec/schema.js";
import { toSpec } from "../engine/web/author.js";
import { defaultFramework } from "../engine/generators/index.js";
import { projectAiGate } from "./ai-config.js";
import { AgentRunStore, isActiveRun, type AgentRun, type RunResult } from "./agent-run-store.js";
import type { Platform } from "./bootstrap.js";
import { HttpError } from "./http-error.js";
import type { Role } from "./identity-store.js";
import { assertAllowedTarget } from "./net-guard.js";
import { environmentCredentials, environmentFor, sameSite } from "./plain-run.js";
import type { JobRow, Repo } from "./repo.js";
import { withJobStarter } from "./review-store.js";
import { expandSecrets, totpCodesNear } from "./secret-variants.js";
import type { ArtifactStore } from "./storage.js";
import { runsCanStartHere } from "./suite-run.js";
import { runnersOnly, serverWorkMessage } from "./runner-only.js";

export const NO_RUNNER_YET = "Agent runs use the browser of this platform's worker. They cannot go to a runner yet.";
export const AGENT_NO_WORKER = "Agent runs do not start on this server: nothing here picks up a run, so it would wait in the queue and never start. Start it where tests run (your own installation, or once tests are switched on here).";
/** Said on the page and in a refused start while agent runs are switched off on this server (AGENT_RUNS_ON_SERVER). */
export const AGENT_RUNS_OFF = "Agent runs wait for runner support. Until a runner can take them they would use this server's own browser, so they are switched off here.";
export const AGENT_NO_MODEL = "Agent runs need an AI model, and none is set up on this server. Add an API key in the server settings, then try again.";

const stores = new WeakMap<object, AgentRunStore>();
export function agentRunStoreFor(p: Pick<Platform, "sql">): AgentRunStore {
    let s = stores.get(p.sql);
    if (!s) stores.set(p.sql, (s = new AgentRunStore(p.sql)));
    return s;
}

/** Can a run started now actually run? Said on the page before the form is used, and checked again at the start. */
export async function agentRunsCanStart(p: Pick<Platform, "config" | "db" | "llm" | "sql">, projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    // First, whatever the worker state: the explicit setting (decision: AI browsers run only on runners).
    if (!p.config.AGENT_RUNS_ON_SERVER) return { ok: false, reason: AGENT_RUNS_OFF };
    // EXECUTION_MODE=runners: the server opens no browser, whatever AGENT_RUNS_ON_SERVER says (runner-only.ts).
    if (runnersOnly(p.config)) return { ok: false, reason: serverWorkMessage("agent") };
    if (!runsCanStartHere(p).ok) return { ok: false, reason: AGENT_NO_WORKER };
    // The project's AI: its own key counts, and a key that cannot be used says why.
    const ai = await projectAiGate(p, projectId);
    if (!ai.ok) return { ok: false, reason: ai.reason ?? AGENT_NO_MODEL };
    return { ok: true };
}

/** A run whose job ended without it (stopped while queued, or the worker went away): it gets an honest end instead of showing as running for ever. */
export async function reconcileRun(store: AgentRunStore, repo: Repo, run: AgentRun): Promise<AgentRun> {
    // No job yet: the route is creating it.
    if (!isActiveRun(run) || !run.jobId) return run;
    const job = repo.getJob(run.jobId);
    if (job && !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return run;
    await store.finish(run.id, job?.error === "Cancelled" ? { state: "stopped", verdict: "inconclusive", stopReason: "A person stopped this run." } : { state: "stopped", verdict: "inconclusive", stopReason: job?.error || "The job behind this run ended before the run did.", failureCategory: job?.error ? "environment" : "runner" });
    return (await store.get(run.id)) ?? run;
}

interface AppFacts {
    url: string;
    credentials?: { username?: string; password?: string; totpSecret?: string; apiToken?: string; apiAuthHeader?: string; oauth2?: { clientSecret?: string } };
}

/** "X-Api-Key: abc" -> "abc": the value alone can show on a page or in an error too. */
const headerValue = (h: string | undefined) => (h && h.includes(":") ? h.slice(h.indexOf(":") + 1).trim() : undefined);

/** The sign-in a run may use and every secret that must stay out of the model and the record. */
export function secretsOf(credentials: AppFacts["credentials"], roles: Role[]): string[] {
    const raw = [credentials?.password, credentials?.apiToken, credentials?.totpSecret, credentials?.apiAuthHeader, headerValue(credentials?.apiAuthHeader), credentials?.oauth2?.clientSecret, ...roles.flatMap((r) => [r.password, r.apiToken, r.totpSecret])].filter((s): s is string => Boolean(s));
    return [...expandSecrets(raw), ...totpCodesNear(credentials?.totpSecret)];
}

export interface AgentJobArgs {
    repo: Repo;
    store: ArtifactStore;
    config: Pick<Config, "dataDir" | "SECRET_KEY">;
    ctx: EngineContext;
    job: JobRow;
    app: AppFacts;
    roles: Role[];
    storageState?: SessionOptions["storageState"];
    /** Used by tests; the worker launches a real browser. */
    launch?: () => ReturnType<typeof launchChromium>;
}

const POLL_MS = 250;

/** Run the job of an agent run and record its end. Returns what the job's own status should say. */
export async function runAgentJob(args: AgentJobArgs): Promise<{ status: "COMPLETED" | "FAILED"; error?: string }> {
    const { repo, store, job, ctx } = args;
    const runs = new AgentRunStore(repo.db.sql);
    const run = job.options.agentRunId ? await runs.get(job.options.agentRunId) : undefined;
    if (!run || run.projectId !== job.projectId) return { status: "FAILED", error: "This job has no agent run." };

    const end = async (r: RunResult): Promise<{ status: "COMPLETED" | "FAILED"; error?: string }> => {
        await runs.finish(run.id, r);
        ctx.emit({ stage: "orchestration", kind: "agent_run_finished", level: r.verdict === "passed" ? "info" : "warn", message: `Agent run ${r.state}: ${r.verdict}` });
        if (r.verdict === "passed") return { status: "COMPLETED" };
        if (r.stopReason === "A person stopped this run.") return { status: "FAILED", error: "Cancelled" };
        return { status: "FAILED", error: (r.stopReason ?? `The agent run ended as ${r.verdict}.`).slice(0, 900) };
    };

    // Switched off on this server: a job queued before the setting changed still does not start a browser.
    if (!ctx.config.AGENT_RUNS_ON_SERVER) return end({ state: "finished", verdict: "blocked", stopReason: AGENT_RUNS_OFF, failureCategory: "environment" });
    // A job picked up again after its worker went away: the first attempt may have done things, and an approved action must not happen twice.
    if (run.startedAt) return end({ state: "stopped", verdict: "inconclusive", stopReason: "The worker running this agent run went away. It was not started again, so nothing is done twice.", failureCategory: "runner" });

    let baseUrl = args.app.url;
    let credentials = args.app.credentials;
    let roles = args.roles;
    try {
        if (run.environment) {
            const { env, secrets } = await environmentFor(repo, args.config, job.projectId, run.environment);
            baseUrl = env.baseUrl;
            // Its own sign-in; the project's fills the gaps only on the application's own site (plain-run.ts).
            credentials = environmentCredentials(args.app.url, args.app.credentials, env.baseUrl, secrets);
            roles = env.useProjectAccounts && sameSite(args.app.url, env.baseUrl) ? args.roles : [];
        }
        await assertAllowedTarget(run.startAddress);
    } catch (e) {
        return end({ state: "finished", verdict: "blocked", stopReason: e instanceof Error ? e.message : String(e), failureCategory: "environment" });
    }

    await runs.started(run.id);
    let browser: Awaited<ReturnType<typeof launchChromium>>;
    try {
        browser = await (args.launch ?? (() => launchChromium(ctx.config.HEADLESS)))();
    } catch (e) {
        return end({ state: "finished", verdict: "blocked", stopReason: `The browser could not start: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`, failureCategory: "runner" });
    }

    const limits: ObjectiveLimits = { maxSteps: run.limits.maxSteps, maxMinutes: run.limits.maxMinutes, maxTokens: run.limits.budgetTokens, approvalSeconds: run.limits.approvalSeconds };
    const signIn = credentials?.username && credentials.password ? { username: credentials.username, password: credentials.password, ...(credentials.totpSecret ? { totpSecret: credentials.totpSecret } : {}) } : undefined;
    let outcome: ObjectiveOutcome;
    try {
        outcome = await pursueObjective({
            ctx,
            browser,
            baseUrl,
            startAddress: run.startAddress,
            objective: run.objective,
            ...(run.successCriteria ? { successCriteria: run.successCriteria } : {}),
            limits,
            ...(signIn ? { credentials: signIn } : {}),
            secrets: secretsOf(credentials, roles),
            // A saved sign-in belongs to the application's own address, not to an environment.
            ...(args.storageState && !run.environment ? { storageState: args.storageState } : {}),
            watch: {
                step: async (s) => {
                    let screenshotId: string | undefined;
                    if (s.picture) {
                        // The normal artifact path: the file goes to the store, the row makes it readable by project and subject to retention.
                        const rel = path.posix.join(job.projectId, "_artifacts", job.id, `agent-step-${String(s.seq).padStart(3, "0")}.jpg`);
                        const saved = await store.put(rel, s.picture, { contentType: "image/jpeg" });
                        screenshotId = repo.addArtifact({ projectId: job.projectId, jobId: job.id, kind: "vision-shot", path: rel, size: saved.size });
                    }
                    await runs.addStep(run.id, { seq: s.seq, tool: s.tool, summary: s.summary, status: s.status, url: s.url, ...(s.detail ? { detail: s.detail } : {}), ...(s.step ? { step: s.step } : {}), ...(screenshotId ? { screenshotId } : {}) });
                },
                tokens: (used) => runs.setTokens(run.id, used),
                askApproval: (r, signal) => waitForPerson(runs, repo, run, job.id, r, signal),
                stopRequested: async () => repo.isCancelRequested(job.id),
            },
        });
    } catch (e) {
        return end({ state: "finished", verdict: "inconclusive", stopReason: `The run could not go on: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`, failureCategory: "runner" });
    } finally {
        await browser.close().catch(() => undefined);
    }
    await runs.setTokens(run.id, { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens });
    return end({ state: outcome.state, verdict: outcome.verdict, ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {}), ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}), ...(outcome.failureCategory ? { failureCategory: outcome.failureCategory } : {}) });
}

/** The run waits here, with its browser open, until a person answers, the time runs out, or someone stops it. */
async function waitForPerson(runs: AgentRunStore, repo: Repo, run: AgentRun, jobId: string, r: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    const asked = await runs.openApproval(run.id, { action: r.action, kind: r.impact.kind, why: r.impact.why, url: r.url, seconds: r.seconds });
    const deadline = Date.parse(asked.expiresAt);
    for (;;) {
        const now = await runs.approval(asked.id);
        if (now && now.state !== "pending") return now.state;
        const stopped = signal.aborted || repo.isCancelRequested(jobId);
        const over = Date.now() >= deadline;
        if (stopped || over) {
            const state = stopped ? "stopped" : "timed_out";
            // A person's answer that arrived in the same moment stands.
            if (await runs.decide(asked.id, state)) return state;
            continue;
        }
        await new Promise((done) => setTimeout(done, POLL_MS));
    }
}

/**
 * The steps a run recorded, as a draft test. The test goes through review like any draft: the review policy decides its state (review-store.ts), and
 * the steps carry stand-ins, so sign-in details stay out of it.
 */
export function draftFromRun(repo: Repo, run: AgentRun, steps: Step[]): { id: string; testKey: string } {
    if (!steps.some((s) => s.action === "assert")) throw new HttpError(422, "This run checked nothing that passed, so a test made from it would verify nothing.");
    const testKey = repo.nextTestKey(run.projectId, "AGENT");
    const title = run.objective.length > 120 ? `${run.objective.slice(0, 119)}…` : run.objective;
    const scenario = {
        scenarioId: `agent-run-${run.id.slice(0, 8)}`,
        title: title.length >= 3 ? title : `Agent run ${run.id.slice(0, 8)}`,
        description: run.objective,
        category: "Agent runs",
        type: "functional" as const,
        priority: "medium" as const,
        startPath: "/",
        preconditions: [],
        expectedResults: run.successCriteria ? run.successCriteria.split("\n").map((l) => l.trim()).filter(Boolean) : [run.objective],
        requiresAuth: false,
        requiredData: [],
        requirements: [],
    };
    const spec: TestSpec = TestSpecSchema.parse(toSpec(scenario, { status: "complete", steps, testData: {}, explanation: "" }, testKey));
    const suiteId = repo.getOrCreateSuite(run.projectId, "Agent runs", "agent-runs");
    // The person who started the run is the author of the AI's draft, so someone else approves it.
    const starter = run.startedBy.id ? { kind: "user", id: run.startedBy.id } : (repo.getJob(run.jobId ?? "")?.options.startedBy ?? undefined);
    const id = withJobStarter(starter, () => repo.insertTest({ projectId: run.projectId, suiteId, jobId: run.jobId, spec, framework: defaultFramework(spec.kind), validationStatus: "PENDING", meta: { scenario, agentRunId: run.id }, versionSource: "ai" }));
    return { id, testKey };
}
