/**
 * The benchmark controller: measures how many known, seeded defects the existing pipeline finds in the benchmark apps.
 *
 *   1. For each app: start it with its seeded behaviours switched on (discovery) or off (regression), and run the normal evaluation entry
 *      through the platform's API (harness.ts: explore and plan, create the tests from the plan, rerun them). Nothing in the platform or the
 *      engine is told about the defects: it gets the app's address and its seeded sign-in account, nothing else.
 *   2. Findings are the tests the platform reported as possible application problems (validation status NEEDS_REVIEW) when their creation
 *      ended, read before the harness reruns them (a rerun moves a test out of review); in regression mode, the created tests that fail when
 *      they run against the app with the defects in. A run that resumes past creation has no rerun and reads them as they are.
 *   3. Each finding is replayed through the platform's own run route, with no model: with the defects on again, with all off, and with each
 *      seeded defect alone (only for findings that failed with them on and passed with them off). metrics.ts turns the verdicts into a
 *      category and the defects it is attributed to.
 *   4. The numbers (metrics.ts) per app and overall; everything recorded (engine commit, prompt fingerprints, model, options, app and
 *      catalogue versions, prices).
 * The apps' data is fresh for every exploration and every replay (each start resets it). With `isolatedReplays` each finding is replayed
 * alone, in a job of its own on a freshly started app, in every replay stage: one test's changes never reach the next (slower; no AI).
 *
 * Stops without losing work: when the AI provider's rate limit or the daily call cap stops an app, the app is marked "stopped", the tests
 * made so far are still judged, and the state is saved after every app so `--resume` runs only what did not finish. The model is never
 * switched (the AI layer retries a rate-limited call on the same model).
 */
import type { Verification } from "./verify-score.js";
import { FixtureHost } from "../fixtures.js";
import { ok, type PlatformClient } from "../client.js";
import type { CorpusEntry } from "../corpus.js";
import { runCorpus } from "../harness.js";
import { overallOf } from "../metrics.js";
import type { EntryResult, EvalRun } from "../run.js";
import { registerBenchProbe } from "../../engine/database/bench-data.js";
import { BenchAppHost, requirementsDocument, workflowsReached, type BenchApp, type BenchDatabase, type Switches } from "./apps.js";
import { defectsOf, isExtension, isUnreachable, type Catalogue } from "./catalogue.js";
import { benchMetrics, categorize, combineExtension, combineMetrics, extensionScore, layerCounts, SCORING_VERSION } from "./metrics.js";
import { candidateOf, sessionsFromEvents } from "./observed.js";
import type { BenchAppResult, BenchConfig, BenchFinding, BenchHeadline, Benchmark, ExplorationSession, ReplayVerdict } from "./schema.js";

const CHECK_TYPES = new Set(["accessibility", "health", "performance", "input", "visual", "vision"]);
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
const MAX_FINDINGS = 500;
const MAX_DETAILS = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failing = (v: ReplayVerdict) => v === "failed" || v === "finding";
/** The AI layer's words for a rate-limited provider (engine/llm/errors.ts), and the provider's own. */
export const RATE_LIMITED = /rate[ _-]?limit|too many requests|\b429\b|limiting how many requests/i;
export const RATE_LIMIT_STOP = "stopped: provider rate limit";
export const DAILY_CAP_STOP = "stopped: daily call cap reached";

export interface BenchOptions {
    apps: Array<{ app: BenchApp; port: number }>;
    catalogue: Catalogue;
    mode: "discovery" | "regression";
    /** Seeded behaviours to switch on per app; default every catalogue defect of the app. */
    defects?: string[];
    /** Extra exploration options (level, page and scenario limits, check families, data-changing tests on the benchmark apps). */
    exploration: Record<string, unknown>;
    repeat: number;
    model: string;
    config: BenchConfig;
    baseline: boolean;
    /** A person's labels for findings the replays could not verify: `<app>/<testKey>` → defect id or "false_positive". */
    labels?: Record<string, string>;
    /** Stop the run when the platform's priced usage passes this many dollars. */
    budget?: number;
    /** How the apps' sign-in forms are sent (default html; js measures sign-in through a script-sent form on its own). */
    login?: "html" | "js";
    /** Stop the run when the platform has made this many AI calls today (UTC). */
    dailyCallCap?: number;
    /** A resumed run: what the earlier attempt finished (apps with status "done" are kept and not run again). */
    previous?: { startedAt: string; apps: BenchAppResult[]; entries: EntryResult[]; notes: string[] };
    /** Called after each app with everything so far (the command saves it, so a stop can be resumed). */
    onProgress?: (state: { startedAt: string; apps: BenchAppResult[]; entries: EntryResult[]; notes: string[] }) => void;
    signal?: AbortSignal;
    log?: (line: string) => void;
    pollMs?: number;
    /** Longest the exploration, a creation and each replay job may take (default the harness's 45 minutes; the command's --job-timeout-min). */
    jobTimeoutMs?: number;
    /** One test per replay job, the app started fresh before each, in every replay stage (the command's --isolated-replays). */
    isolatedReplays?: boolean;
    /** For tests: how long a stopped job gets to wind down (default WIND_DOWN_MS), and the validation run of a continued app (default CONTINUED_VALIDATION_MS). */
    windDownMs?: number;
    continuedValidationMs?: number;
    /** Where the apps' requirements documents are read from (default the repository root). */
    root?: string;
    /**
     * Test accounts set on each app's project before it is explored (the command's --roles catalogue: the catalogue's accounts of the app),
     * the way an owner adds them in Settings; every job of the project reads them. Only names, usernames and passwords.
     */
    roles?: (appId: string) => Array<{ name: string; username: string; password: string }>;
    /**
     * The trial's database back end (the command's --db; spec 4.4 D-a or D-b). Each app is started with it, the engine is handed a
     * read-only probe of the app's stored data (by the app's address, in this process only), and the seeds seen only in the stored data
     * count as reachable. None: as Phase 3.
     */
    database?: BenchDatabase;
    /** `--verify-attempts`: verifies the findings of the app's jobs (with its defects in) and returns what it left (cli.ts verifierOf). */
    verify?: (projectId: string, jobIds: string[], findingTests?: ReadonlySet<string>) => Promise<Verification>;
}

export interface BenchOutcome {
    run: EvalRun;
    benchmark: Benchmark;
    /** Every app finished (none stopped, skipped or failed). */
    complete: boolean;
}

export async function runBenchmark(client: PlatformClient, o: BenchOptions): Promise<BenchOutcome> {
    const log = o.log ?? (() => undefined);
    const startedAt = o.previous?.startedAt ?? new Date().toISOString();
    const ac = new AbortController();
    if (o.signal?.aborted) ac.abort();
    else o.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const notes: string[] = [...(o.previous?.notes ?? [])];
    const stopReason = { value: undefined as string | undefined };
    const stopMonitor = usageMonitor(client, o, ac, log, notes, stopReason, (o.pollMs ?? 1000) * 5, startedAt);
    const entries: EntryResult[] = [];
    const results: BenchAppResult[] = [];
    try {
        for (const { app, port } of o.apps) {
            const kept = o.previous?.apps.find((a) => a.id === app.id && a.status === "done");
            const resumable = o.previous?.apps.find((a) => a.id === app.id && a.status === "stopped" && a.projectId && a.jobs?.planJobId);
            if (kept) {
                log(`\n${app.id}: finished in the earlier attempt, kept`);
                results.push(kept);
                const e = o.previous!.entries.find((x) => x.id === app.id);
                if (e) entries.push(e);
                continue;
            }
            const host = new BenchAppHost(app, port, undefined, o.login ?? "html", o.database);
            const all = defectsOf(o.catalogue, app.id);
            const seeded = (o.defects ? all.filter((d) => o.defects!.includes(d.id)) : all).map((d) => d.id);
            const version = o.config.apps.find((a) => a.id === app.id)?.version ?? "unknown";
            const base = { id: app.id, entryId: app.id, appVersion: version, seededDefects: seeded, defects: [], findings: [] };
            if (ac.signal.aborted) {
                // An app an earlier attempt stopped keeps its project and jobs (and the AI work in them), so a later --resume continues it.
                const earlier = o.previous?.apps.find((a) => a.id === app.id && a.status === "stopped" && a.projectId);
                if (earlier) results.push(earlier);
                else results.push({ ...base, status: stopReason.value ? "stopped" : "skipped", reason: stopReason.value ?? "The benchmark was stopped before this app started.", metrics: emptyMetrics(originalOf(o.catalogue, app.id, seeded)) });
            } else {
                log(`\n${app.id}: ${seeded.length} seeded behaviours, ${o.mode}`);
                const probe = host.probe();
                const forget = probe ? registerBenchProbe(host.url, probe) : undefined;
                // The jobs of an app being continued, kept here so that a failure half way still knows the creations it started.
                const carried: AppJobs | undefined = resumable ? { ...resumable.jobs!, createJobIds: [...resumable.jobs!.createJobIds], validationJobIds: [...(resumable.jobs!.validationJobIds ?? [])] } : undefined;
                try {
                    const r = resumable ? await continueApp(client, host, app, seeded, o, ac.signal, log, startedAt, stopReason, resumable, carried!) : await benchApp(client, host, app, seeded, o, ac.signal, log, startedAt, stopReason);
                    if (r.entry) entries.push(r.entry);
                    results.push(r.result);
                } catch (e) {
                    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
                    log(`  could not finish: ${reason}`);
                    // A continued app that fails keeps its project and jobs (the tests and the AI work in them): still "stopped", so the
                    // next --resume continues it instead of exploring the app from the start.
                    if (resumable) results.push({ ...resumable, jobs: carried!, reason: `stopped: could not be continued (${reason})`.slice(0, 1000) });
                    else results.push({ ...base, status: "failed", reason, metrics: emptyMetrics(originalOf(o.catalogue, app.id, seeded)) });
                } finally {
                    forget?.();
                    await host.stop();
                }
            }
            o.onProgress?.({ startedAt, apps: [...results], entries: [...entries], notes: [...notes] });
        }
    } finally {
        stopMonitor();
    }
    const metrics = combineMetrics(results.map((r) => r.metrics));
    const extension = combineExtension(results.map((r) => r.extension));
    const benchmark: Benchmark = { format: 1, scoring: SCORING_VERSION, mode: o.mode, baseline: o.baseline, config: o.config, apps: results, metrics, ...(extension ? { extension } : {}), notes: notes.slice(0, 40) };
    const overall = { ...overallOf(entries), benchmark: headlineOf(benchmark) };
    const run: EvalRun = {
        format: 1,
        corpus: `benchmark-${o.mode}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        repeat: o.repeat,
        planOnly: false,
        platform: { mode: client.mode, model: o.model.slice(0, 200) },
        entries,
        overall,
        benchmark,
    };
    return { run, benchmark, complete: results.every((r) => r.status === "done") };
}

export function headlineOf(b: Benchmark): BenchHeadline {
    const m = b.metrics;
    return { mode: b.mode, scoring: b.scoring ?? 1, seeded: m.seeded, detected: m.detected, falsePositives: m.falsePositives, detectionRate: m.detectionRate, precision: m.precision, falsePositiveRate: m.falsePositiveRate, reproductionRate: m.reproductionRate, cost: m.cost };
}

/** The seeds of the original score: every seed that is not an extension seed (those are scored apart, never in `metrics`). */
const originalOf = (c: Catalogue, appId: string, seeded: string[]): string[] => {
    const ext = new Set(defectsOf(c, appId).filter(isExtension).map((d) => d.id));
    return seeded.filter((id) => !ext.has(id));
};

/** The catalogue's accounts of an app as test accounts (--roles catalogue): named after the email's local part, nothing else of the catalogue. */
export function catalogueRoles(accounts: Array<{ email: string; password: string }>): Array<{ name: string; username: string; password: string }> {
    return accounts.map((a) => ({ name: a.email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "").slice(0, 24) || "account", username: a.email, password: a.password }));
}

function emptyMetrics(seeded: string[]) {
    return benchMetrics({ seeded, findings: [], startedAt: new Date().toISOString(), cost: null, testsGenerated: 0, workflows: 0, workflowsCovered: 0, executionFailures: 0, flaky: 0, durationMs: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

type TestRow = { id: string; testId: string; title: string; type: string; validationStatus: string; validationReason?: string | null };
/** The project's tests as their creation left them, and when they were read (before any rerun ran them again). */
type Collected = { at: string; tests: TestRow[] };

async function benchApp(
    client: PlatformClient,
    host: BenchAppHost,
    app: BenchApp,
    seeded: string[],
    o: BenchOptions,
    signal: AbortSignal,
    log: (s: string) => void,
    benchStart: string,
    stopReason: { value?: string },
): Promise<{ entry?: EntryResult; result: BenchAppResult }> {
    const t0 = Date.now();
    await host.start(o.mode === "discovery" ? seeded : "none");
    const key = app.id.replace(/\W/g, "_").toUpperCase();
    const user = `BENCH_${key}_USER`;
    const pass = `BENCH_${key}_PASSWORD`;
    const entry: CorpusEntry = { id: app.id, kind: "web", url: host.url, ...(app.credentials ? { credentials: { username: user, password: pass } } : {}) };
    let collected: Collected | undefined;
    const run = await runCorpus(client, { name: `benchmark-${o.mode}`, entries: [entry] }, {
        repeat: o.repeat,
        planOnly: false,
        fixtures: new FixtureHost({ mode: client.mode }),
        model: o.model,
        signal,
        log,
        env: app.credentials ? { [user]: app.credentials.username, [pass]: app.credentials.password } : {},
        pollMs: o.pollMs,
        jobTimeoutMs: o.jobTimeoutMs,
        exploration: o.exploration,
        onCreated: ({ at, tests }) => {
            collected = { at, tests: tests as TestRow[] };
        },
        onProject: async (projectId) => {
            await attachRequirements(client, projectId, app, o.root, log);
            const roles = o.roles?.(app.id);
            if (roles?.length) {
                ok(await client.call("PUT", `/api/projects/${projectId}/roles`, { roles }), "Setting the test accounts");
                log(`  test accounts: ${roles.map((r) => r.name).join(", ")}`);
            }
        },
    });
    const e = run.entries[0]!;
    // Stopped by the provider's rate limit or the daily cap: judge what was made so far. A job that finished only partly because the model
    // stayed rate-limited says so in its error, even when the entry itself is done.
    let stopped = e.status !== "done" ? (stopReason.value ?? (RATE_LIMITED.test(e.reason ?? "") ? RATE_LIMIT_STOP : undefined)) : undefined;
    if (!stopped && e.status === "done") {
        for (const id of [e.planJobId, e.createJobId]) {
            if (!id) continue;
            const j = await client.call("GET", `/api/test-generation/${id}`);
            if (j.status === 200 && j.body?.status !== "COMPLETED" && RATE_LIMITED.test(String(j.body?.error ?? ""))) stopped = RATE_LIMIT_STOP;
        }
    }
    if (e.status !== "done" && (!stopped || !e.projectId)) throw new Error(stopped ?? e.reason ?? "The exploration did not finish.");
    const projectId = e.projectId!;
    const jobs: AppJobs = { ...(e.planJobId ? { planJobId: e.planJobId } : {}), createJobIds: e.createJobId ? [e.createJobId] : [] };
    // The platform's own usage records count every call of the jobs; the harness's figures can miss the calls of a job that was stopped.
    const recorded = await jobsUsage(client, [e.planJobId, e.createJobId]);
    const usage =
        e.metrics && e.metrics.aiCalls >= recorded.aiCalls
            ? { aiCalls: e.metrics.aiCalls, inputTokens: e.metrics.inputTokens, outputTokens: e.metrics.outputTokens, cost: e.metrics.cost, cacheReadTokens: e.usage?.cacheReadTokens ?? 0, cacheWriteTokens: e.usage?.cacheWriteTokens ?? 0 }
            : recorded;
    if (stopped) return { result: await stoppedResult(client, app, seeded, o, projectId, jobs, usage, stopped, log) };
    return judgeApp(client, host, app, seeded, o, log, benchStart, t0, projectId, jobs, usage, e.metrics?.flaky ?? 0, e.status === "done" ? e : undefined, [], collected);
}

/**
 * The app's requirements document, imported into the project before it is explored, the way an owner does on the Requirements tab: the
 * platform's own reading without AI (import/preview), then every requirement it found saved (import). The project's analysis then reads
 * them as its requirements source. Both sides of a comparison get the same document this way; a document that yields nothing, or a
 * project that does not keep every requirement, stops the app instead of exploring it without its document.
 */
export async function attachRequirements(client: PlatformClient, projectId: string, app: Pick<BenchApp, "id" | "requirements">, root: string | undefined, log: (s: string) => void): Promise<void> {
    const doc = requirementsDocument(app, root);
    if (!doc) return;
    const preview = ok(await client.call("POST", `/api/projects/${projectId}/requirements/import/preview`, { text: doc.text }), "Reading the requirements document") as { candidates: Array<{ ref: string; title: string; description: string }> };
    const requirements = preview.candidates.map((c) => ({ ref: c.ref, title: c.title, description: c.description }));
    if (!requirements.length) throw new Error(`The requirements document ${doc.file} has no requirement the platform can read.`);
    const saved = ok(await client.call("POST", `/api/projects/${projectId}/requirements/import`, { requirements }), "Importing the requirements document") as { created: number };
    if (saved.created !== requirements.length) throw new Error(`Only ${saved.created} of the ${requirements.length} requirements of ${doc.file} were imported.`);
    log(`  requirements: ${saved.created} imported from ${doc.file} (sha256 ${doc.sha256.slice(0, 12)})`);
}

type Usage = Awaited<ReturnType<typeof jobsUsage>>;
type AppJobs = NonNullable<BenchAppResult["jobs"]>;

/** An app the daily cap or the rate limit stopped: nothing is judged yet; its jobs are kept so `--resume` continues it in the same project. */
async function stoppedResult(client: PlatformClient, app: BenchApp, seeded: string[], o: BenchOptions, projectId: string, jobs: AppJobs, usage: Usage, stopped: string, log: (s: string) => void): Promise<BenchAppResult> {
    await settledJobs(client, [jobs.planJobId, ...jobs.createJobIds], o);
    const tests = ok(await client.call("GET", `/api/projects/${projectId}/tests`), "Reading the tests") as TestRow[];
    log(`  ${stopped}: ${tests.length} tests made so far; --resume continues this app with the planned tests not made yet`);
    const version = o.config.apps.find((a) => a.id === app.id)?.version ?? "unknown";
    const metrics = { ...emptyMetrics(originalOf(o.catalogue, app.id, seeded)), testsGenerated: tests.length, aiCalls: usage.aiCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, cost: usage.cost };
    return { id: app.id, entryId: app.id, projectId, status: "stopped", reason: stopped.slice(0, 1000), appVersion: version, seededDefects: seeded, defects: [], findings: [], metrics, jobs };
}

/**
 * Continue an app a stop interrupted, in the same project: create the plan's ideas that have no test yet (and that the stopped job did not
 * decide to skip), then validate the tests still waiting for it with an ordinary run, then judge everything as for an uninterrupted app.
 * The differences from one uninterrupted run are written as caveats.
 */
async function continueApp(client: PlatformClient, host: BenchAppHost, app: BenchApp, seeded: string[], o: BenchOptions, signal: AbortSignal, log: (s: string) => void, benchStart: string, stopReason: { value?: string }, prev: BenchAppResult, jobs: AppJobs): Promise<{ entry?: EntryResult; result: BenchAppResult }> {
    const t0 = Date.now();
    const projectId = prev.projectId!;
    await host.start(o.mode === "discovery" ? seeded : "none");
    await settledJobs(client, [jobs.planJobId, ...jobs.createJobIds], o);
    const call = async (method: "GET" | "POST", url: string, what: string, body?: unknown) => ok(await client.call(method, url, body), what);
    const { made, decided } = await madeAndDecided(client, projectId, jobs.createJobIds);
    const exclude = [...new Set([...made, ...decided])];
    log(`  continuing: ${made.size} ideas already made, ${decided.size} skipped by the stopped creation`);
    let stopped: string | undefined;
    const created = await client.call("POST", `/api/projects/${projectId}/plans/${jobs.planJobId}/create`, { continueStopped: true, excludeIdeas: exclude, runTestCases: true });
    if (created.status === 400 && /Nothing is (left|selected) to create/.test(String(created.body?.error ?? ""))) log("  every planned idea is made");
    else {
        const job = ok(created, "Continuing the creation");
        jobs.createJobIds.push(job.jobId);
        const end = Date.now() + (o.jobTimeoutMs ?? 12 * 60 * 60_000);
        for (;;) {
            const j = ok(await client.call("GET", `/api/test-generation/${job.jobId}`), "Reading the creation");
            if (DONE.includes(j.status)) {
                // As for a first creation: one that ended only partly because the model stayed rate-limited is stopped, not done.
                if (j.status !== "COMPLETED" && RATE_LIMITED.test(String(j.error ?? ""))) stopped = stopReason.value ?? RATE_LIMIT_STOP;
                break;
            }
            if (signal.aborted || Date.now() > end) {
                await client.call("DELETE", `/api/test-generation/${job.jobId}`).catch(() => undefined);
                stopped = stopReason.value ?? (signal.aborted ? "stopped" : "stopped: the creation took longer than the job time limit");
                break;
            }
            await sleep(o.pollMs ?? 1000);
        }
    }
    if (stopped) {
        const usage = await jobsUsage(client, [jobs.planJobId, ...jobs.createJobIds, ...(jobs.validationJobIds ?? [])]);
        return { result: await stoppedResult(client, app, seeded, o, projectId, jobs, usage, stopped, log) };
    }

    // Tests made by a creation that was stopped never went through its validation: run them once now (an ordinary run: no model writes
    // them again, and a repair is only a draft).
    const waiting = ((await call("GET", `/api/projects/${projectId}/tests`, "Reading the tests")) as TestRow[]).filter((t) => t.validationStatus === "PENDING");
    const caveats: string[] = [`Made across ${jobs.createJobIds.length} creations: the daily call cap stopped the earlier ones and the rest of the plan was created later.`];
    if (waiting.length) {
        log(`  validating ${waiting.length} tests the stopped creation made`);
        const r = ok(await client.call("POST", `/api/projects/${projectId}/runs`, { testIds: waiting.map((t) => t.id) }), "Validating the stopped creation's tests");
        jobs.validationJobIds!.push(r.jobId);
        await settledJobs(client, [r.jobId], o, Math.max(o.jobTimeoutMs ?? 0, o.continuedValidationMs ?? CONTINUED_VALIDATION_MS));
        caveats.push(`${waiting.length} tests were validated by an ordinary run instead of their creation's own validation (a failing one got a repair draft, not an applied repair).`);
    }
    const total = await jobsUsage(client, [jobs.planJobId, ...jobs.createJobIds, ...(jobs.validationJobIds ?? [])]);
    return judgeApp(client, host, app, seeded, o, log, benchStart, t0, projectId, jobs, total, 0, undefined, caveats);
}

/** The plan idea a created test came from (the engine records it in the test's source). */
const ideaOf = (spec: unknown): string | undefined => {
    const s = spec as { source?: { scenarioId?: unknown }; scenarioId?: unknown } | null | undefined;
    const id = s?.source?.scenarioId ?? s?.scenarioId;
    return typeof id === "string" && id ? id : undefined;
};

/** Ideas that already have a test in the project, and ideas the earlier creations decided not to author (they stay skipped). */
async function madeAndDecided(client: PlatformClient, projectId: string, createJobIds: string[]): Promise<{ made: Set<string>; decided: Set<string> }> {
    const call = async (url: string, what: string) => ok(await client.call("GET", url), what);
    const made = new Set<string>();
    for (const t of (await call(`/api/projects/${projectId}/tests`, "Reading the tests")) as TestRow[]) {
        const id = ideaOf((await call(`/api/tests/${t.id}`, "Reading a test")).spec);
        if (id) made.add(id);
    }
    const decided = new Set<string>();
    for (const id of createJobIds) {
        for (const ev of (await call(`/api/test-generation/${id}/events`, "Reading a creation's events")) as Array<{ kind: string; message?: string }>) {
            if (ev.kind !== "scenario_skipped") continue;
            const m = /^([A-Z]+-\d+)\b/.exec(ev.message ?? "");
            if (m) decided.add(m[1]!);
        }
    }
    return { made, decided };
}

/**
 * For the estimate of a resumed run: how many planned tests a stopped app still has to make (the plan's ideas without a test that the
 * stopped creation did not decide to skip; phone ideas are not created on the web). Undefined when the plan cannot be read (the app is
 * then estimated as a new one).
 */
export async function plannedTestsLeft(client: PlatformClient, prev: BenchAppResult): Promise<{ planned: number; made: number; skipped: number; left: number } | undefined> {
    if (!prev.projectId || !prev.jobs?.planJobId) return undefined;
    const plan = await client.call("GET", `/api/projects/${prev.projectId}/plans/${prev.jobs.planJobId}`);
    if (plan.status !== 200 || !Array.isArray(plan.body?.ideas)) return undefined;
    const ideas = (plan.body.ideas as Array<{ id?: unknown }>).map((x) => String(x.id ?? "")).filter((id) => id && !/^M-\d+$/.test(id));
    const { made, decided } = await madeAndDecided(client, prev.projectId, prev.jobs.createJobIds ?? []);
    const left = ideas.filter((id) => !made.has(id) && !decided.has(id)).length;
    return { planned: ideas.length, made: ideas.filter((id) => made.has(id)).length, skipped: ideas.filter((id) => !made.has(id) && decided.has(id)).length, left };
}

/** Judge an app's finished tests: replay the findings with and without the defects, attribute them, and work out the numbers. */
async function judgeApp(client: PlatformClient, host: BenchAppHost, app: BenchApp, seeded: string[], o: BenchOptions, log: (s: string) => void, benchStart: string, t0: number, projectId: string, jobs: AppJobs, usage: Usage, flaky: number, entry: EntryResult | undefined, caveats: string[], collected?: Collected): Promise<{ entry?: EntryResult; result: BenchAppResult }> {
    const call = async (method: "GET" | "POST", url: string, what: string, body?: unknown) => ok(await client.call(method, url, body), what);
    const now = (await call("GET", `/api/projects/${projectId}/tests`, "Reading the tests")) as TestRow[];
    // Judged on the statuses (and reasons) the creation left, not what the harness's rerun made of them: a defect test in review becomes
    // VALIDATED or FAILED_VALIDATION once it has run. A run that resumed past creation had no rerun: its tests are read as they are now.
    // So a resumed run and one that was not collect the same tests.
    const at = collected?.at ?? new Date().toISOString();
    const left = new Map((collected?.tests ?? now).map((t) => [t.id, t]));
    const tests = now.map((t) => {
        const c = left.get(t.id);
        return c ? { ...t, validationStatus: c.validationStatus, validationReason: c.validationReason } : t;
    });
    // Which areas the tests reached, from their own steps.
    const paths: string[] = [];
    const details = new Map<string, { generationMeta?: { capture?: unknown; finding?: unknown; layer?: unknown } | null }>();
    for (const t of tests.slice(0, MAX_DETAILS)) {
        const d = await call("GET", `/api/tests/${t.id}`, "Reading a test");
        details.set(t.id, d);
        for (const s of (d.spec?.steps ?? []) as Array<{ action?: string; url?: string; path?: string }>) {
            const u = s.url ?? s.path;
            if (!u || (s.action !== "navigate" && s.action !== "request")) continue;
            try {
                paths.push(new URL(u.replace(/\{\{[^}]+\}\}/g, "x"), host.url).pathname);
            } catch {
                /* not an address */
            }
        }
    }
    const reached = workflowsReached(app, paths);

    // Replays use no AI. A job that was stopped has to end first: a run cannot start beside it.
    await settledJobs(client, [jobs.planJobId, ...jobs.createJobIds, ...(jobs.validationJobIds ?? [])], o);
    const replaySignal = new AbortController();
    o.signal?.addEventListener("abort", () => replaySignal.abort(), { once: true });
    const replayStart = new Date().toISOString();
    let candidates: TestRow[];
    const verdicts = new Map<string, BenchFinding["replay"]>();
    if (o.mode === "discovery") {
        candidates = tests.filter((t) => t.validationStatus === "NEEDS_REVIEW").slice(0, MAX_FINDINGS);
        log(`  ${candidates.length} reported findings; replaying them`);
        if (candidates.length) {
            const again = await replayStage(client, host, seeded, projectId, candidates.map((t) => t.id), o, replaySignal.signal);
            for (const t of candidates) verdicts.set(t.id, { seeded: again.get(t.id) ?? "not_run", clean: null, single: {} });
        }
    } else {
        // Regression: the tests made on the correct app, run with the defects in; the failing ones are the findings.
        const runnable = tests.filter((t) => t.validationStatus === "VALIDATED");
        const first = await replayStage(client, host, seeded, projectId, runnable.map((t) => t.id), o, replaySignal.signal);
        candidates = runnable.filter((t) => failing(first.get(t.id) ?? "not_run")).slice(0, MAX_FINDINGS);
        log(`  ${candidates.length} of ${runnable.length} tests fail with the defects in; replaying them`);
        for (const t of candidates) verdicts.set(t.id, { seeded: first.get(t.id)!, clean: null, single: {} });
    }
    const reproduced = candidates.filter((t) => failing(verdicts.get(t.id)!.seeded));
    if (reproduced.length) {
        const clean = await replayStage(client, host, "none", projectId, reproduced.map((t) => t.id), o, replaySignal.signal);
        for (const t of reproduced) verdicts.get(t.id)!.clean = clean.get(t.id) ?? "not_run";
        const toPin = reproduced.filter((t) => verdicts.get(t.id)!.clean === "passed");
        for (const d of toPin.length ? seeded : []) {
            if (replaySignal.signal.aborted) break;
            const one = await replayStage(client, host, [d], projectId, toPin.map((t) => t.id), o, replaySignal.signal);
            for (const t of toPin) verdicts.get(t.id)!.single[d] = one.get(t.id) ?? "not_run";
        }
    }

    // --verify-attempts: the findings of the app's jobs verified as the platform does after a job, on the app with its defects in.
    // shortcut: a regression-mode trial's failing replays are not verified (their jobs are not kept); upgrade by keeping the first replay's job id.
    let verification: Verification | undefined;
    if (o.verify && !replaySignal.signal.aborted) {
        await host.start(seeded);
        // The creation's findings as collected: the harness's rerun and the replays have moved their statuses on since the job ended.
        const findingTests = o.mode === "discovery" ? new Set(candidates.map((t) => t.id)) : undefined;
        verification = await o.verify(projectId, [jobs.planJobId, ...jobs.createJobIds, ...(jobs.validationJobIds ?? [])].filter((x): x is string => Boolean(x)), findingTests);
    }

    const findings: BenchFinding[] = [];
    for (const t of candidates) {
        const replayed = verdicts.get(t.id)!;
        const { category, defects } = categorize(replayed);
        const execs = (await call("GET", `/api/tests/${t.id}/executions`, "Reading a test's runs")) as Array<{ status: string; startedAt: string }>;
        // Runs before the tests were collected: none for a defect test the author stopped, even after the harness's rerun ran it.
        const before = execs.filter((x) => x.startedAt < at);
        const firstFail = before.filter((x) => x.status !== "passed" && x.status !== "skipped").map((x) => x.startedAt).sort()[0];
        const label = o.labels?.[`${app.id}/${t.testId}`];
        // What the author recorded when it stopped the test as a defect (the observed-vs-captured report's "author recorded" column).
        const meta = (details.get(t.id) ?? (await call("GET", `/api/tests/${t.id}`, "Reading a test")))?.generationMeta;
        const capture = meta?.capture;
        const layer = layerOf(meta?.layer);
        const source: BenchFinding["source"] = CHECK_TYPES.has(t.type) ? "check" : before.length ? "validation" : "authoring";
        findings.push({
            id: t.id,
            testKey: t.testId,
            title: t.title.slice(0, 500),
            ...(t.validationReason ? { reason: t.validationReason.slice(0, 500) } : {}),
            source,
            replay: replayed,
            category,
            defects: defects.filter((d) => seeded.includes(d)),
            ...(label && category === "unreproduced" && (label === "false_positive" || seeded.includes(label)) ? { label } : {}),
            ...(capture === "captured" || capture === "observed_only" ? { capture } : {}),
            ...(layer ? { layer } : {}),
            firstSeenAt: firstFail ? new Date(firstFail).toISOString() : null,
            // A defect the author stopped is a candidate finding: its objective and the E7 fields it lacks (observed.ts).
            ...(o.mode === "discovery" && source === "authoring" ? { candidate: candidateOf(meta?.finding, t.testId) } : {}),
        });
    }
    // The objective sessions of the app's jobs, from their events (E6, stop reasons).
    const sessions: ExplorationSession[] = [];
    for (const id of [jobs.planJobId, ...jobs.createJobIds]) if (id) sessions.push(...sessionsFromEvents(id, await jobEvents(client, id)));

    const catalogue = new Map(defectsOf(o.catalogue, app.id).map((d) => [d.id, d]));
    const extensionSeeds = seeded.filter((id) => catalogue.get(id)?.set === "extension");
    // A seed seen only in the stored data is reachable only in a trial with a database back end (spec 4.4, D-a/D-b).
    const unreachable = seeded.filter((id) => catalogue.has(id) && isUnreachable(catalogue.get(id)!, !!o.database));
    const inputs = {
        seeded: seeded.filter((id) => !extensionSeeds.includes(id)),
        findings,
        unreachable,
        startedAt: benchStart,
        cost: usage.cost,
        testsGenerated: tests.length,
        workflows: app.workflows.length,
        workflowsCovered: reached.length,
        executionFailures: tests.filter((t) => t.validationStatus === "FAILED_VALIDATION").length,
        flaky,
        durationMs: Date.now() - t0,
        aiCalls: usage.aiCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
    };
    const metrics = benchMetrics(inputs);
    const extension = extensionSeeds.length ? extensionScore({ ...inputs, seeded: extensionSeeds }) : undefined;
    // Tests per layer (the engine's meta.layer; "unlabelled" for a test without one), from the tests whose details were read.
    const layers = layerCounts([...details.values()].map((d) => layerOf(d?.generationMeta?.layer)), findings);
    const defects = seeded.map((id) => {
        const d = catalogue.get(id)!;
        const by = findings.filter((f) => f.category === "confirmed" && f.defects.includes(id)).map((f) => f.testKey);
        const labeled = findings.filter((f) => f.label === id).map((f) => f.testKey);
        return { id, category: d.category.slice(0, 60), workflow: d.workflow.slice(0, 120), severity: d.severity.slice(0, 20), detected: by.length > 0, labeledOnly: by.length === 0 && labeled.length > 0, ...(unreachable.includes(id) ? { unreachable: true } : {}), ...(d.set ? { set: d.set } : {}), findings: [...by, ...labeled].slice(0, 100) };
    });
    log(`  detected ${metrics.detected} of ${metrics.seeded}; ${metrics.falsePositives} false positives; ${metrics.unreproduced} not reproduced${extension ? `; extension seeds: detected ${extension.detected} of ${extension.seeded}` : ""}`);
    const version = o.config.apps.find((a) => a.id === app.id)?.version ?? "unknown";
    return {
        ...(entry ? { entry } : {}),
        result: { id: app.id, entryId: app.id, projectId, status: "done", appVersion: version, seededDefects: seeded, defects, findings, metrics, ...(extension ? { extension } : {}), layers, jobs, exploration: { sessions: sessions.slice(0, 30) }, ...(caveats.length ? { caveats } : {}), ...(verification ? { verification } : {}) },
    };
}

/** A test's layer as the engine recorded it (meta.layer: page, api, storedData, database), or undefined. */
const layerOf = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v) ? v : undefined);

/** How long a stopped job gets to wind down, and how long the validation run of a continued app may take. */
export const WIND_DOWN_MS = 10 * 60_000;
export const CONTINUED_VALIDATION_MS = 2 * 60 * 60_000;

/** Wait until these jobs have ended; gives up after `limitMs` (default: a stopped job winding down, at most WIND_DOWN_MS). */
async function settledJobs(client: PlatformClient, jobIds: Array<string | undefined>, o: BenchOptions, limitMs = Math.min(o.jobTimeoutMs ?? o.windDownMs ?? WIND_DOWN_MS, o.windDownMs ?? WIND_DOWN_MS)): Promise<void> {
    const end = Date.now() + limitMs;
    for (const id of jobIds) {
        if (!id) continue;
        for (;;) {
            const j = await client.call("GET", `/api/test-generation/${id}`);
            if (j.status !== 200 || DONE.includes(String(j.body?.status)) || Date.now() > end) break;
            await sleep(o.pollMs ?? 1000);
        }
    }
}

/** Events read per job, at most (500 a page): enough for an objective session's `objectives_planned` and `exploration_stopped`. */
const MAX_EVENT_PAGES = 200;

/** Every event of a job, page by page (the route returns at most 500 after an id). An unreadable page ends the reading. */
async function jobEvents(client: PlatformClient, jobId: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let after = 0;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const r = await client.call("GET", `/api/test-generation/${jobId}/events?after=${after}`);
        if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) break;
        all.push(...(r.body as unknown[]));
        const last = (r.body[r.body.length - 1] as { id?: unknown })?.id;
        if (typeof last !== "number" || r.body.length < 500) break;
        after = last;
    }
    return all;
}

/** The AI use of these jobs from the platform's usage records (for an app stopped before the harness could add it up). */
async function jobsUsage(client: PlatformClient, jobIds: Array<string | undefined>) {
    const t = { aiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null as number | null };
    for (const id of jobIds) {
        if (!id) continue;
        const u = await client.call("GET", `/api/jobs/${id}/usage`);
        if (u.status !== 200) continue;
        const x = u.body?.totals ?? {};
        t.aiCalls += x.calls ?? 0;
        t.inputTokens += x.inputTokens ?? 0;
        t.outputTokens += x.outputTokens ?? 0;
        t.cacheReadTokens += x.cacheReadTokens ?? 0;
        t.cacheWriteTokens += x.cacheWriteTokens ?? 0;
        if (typeof x.cost === "number") t.cost = (t.cost ?? 0) + x.cost;
    }
    return t;
}

/**
 * One replay stage: the app started with these behaviours, then the tests run once. With `isolatedReplays`, each test runs alone, in a
 * job of its own, on an app started fresh just before it.
 */
async function replayStage(client: PlatformClient, host: BenchAppHost, switches: Switches, projectId: string, testIds: string[], o: BenchOptions, signal: AbortSignal): Promise<Map<string, ReplayVerdict>> {
    if (!o.isolatedReplays) {
        await host.start(switches);
        return replay(client, projectId, testIds, o, signal);
    }
    const out = new Map<string, ReplayVerdict>();
    for (const id of testIds) {
        if (signal.aborted) throw new Error("Stopped; the replays were stopped.");
        await host.start(switches);
        for (const [k, v] of await replay(client, projectId, [id], o, signal)) out.set(k, v);
    }
    return out;
}

/** Run these tests once through the platform's run route and read each one's verdict. No model is involved. */
async function replay(client: PlatformClient, projectId: string, testIds: string[], o: BenchOptions, signal: AbortSignal): Promise<Map<string, ReplayVerdict>> {
    const out = new Map<string, ReplayVerdict>();
    if (!testIds.length) return out;
    // Data changes are allowed in every trial: the replays of risky checks need it (engine/validation/risky.ts).
    const r = await client.call("POST", `/api/projects/${projectId}/runs`, { testIds, allowMutatingApiTests: true });
    if (r.status === 422) {
        for (const id of testIds) out.set(id, "not_run");
        return out;
    }
    const job = ok(r, "Starting a replay");
    const end = Date.now() + (o.jobTimeoutMs ?? 45 * 60_000);
    for (;;) {
        const j = ok(await client.call("GET", `/api/test-generation/${job.jobId}`), "Reading a replay");
        if (DONE.includes(j.status)) break;
        if (signal.aborted || Date.now() > end) {
            await client.call("DELETE", `/api/test-generation/${job.jobId}`).catch(() => undefined);
            throw new Error(signal.aborted ? "Stopped; the replay in progress was stopped on the platform." : "A replay took too long and was stopped.");
        }
        await sleep(o.pollMs ?? 1000);
    }
    const detail = ok(await client.call("GET", `/api/projects/${projectId}/runs/${job.jobId}`), "Reading a replay");
    for (const t of (detail.tests ?? []) as Array<{ id: string; state: string }>) out.set(t.id, t.state === "passed" || t.state === "failed" || t.state === "finding" ? t.state : "not_run");
    for (const id of testIds) if (!out.has(id)) out.set(id, "not_run");
    return out;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * What the whole run has used so far, from the platform's usage records since the day it first started (whatever month that was: a run
 * resumed on the 1st still counts the 30th), and the tokens the platform's monthly limit has counted this month. Days are whole UTC days,
 * so usage earlier on the first day counts too (it errs towards stopping sooner). Throws when the records cannot be read.
 */
export async function runUsageSoFar(client: PlatformClient, startedAt: string): Promise<{ cost: number | null; calls: number; monthUsedTokens: number }> {
    const from = (Number.isNaN(Date.parse(startedAt)) ? new Date() : new Date(startedAt)).toISOString().slice(0, 10);
    const to = today();
    const u = ok(await client.call("GET", `/api/usage?from=${from > to ? to : from}&to=${to}`), "Reading the AI usage of this run");
    return {
        cost: typeof u?.totals?.cost === "number" ? (u.totals.cost as number) : null,
        calls: typeof u?.totals?.calls === "number" ? (u.totals.calls as number) : 0,
        monthUsedTokens: typeof u?.month?.usedTokens === "number" ? (u.month.usedTokens as number) : 0,
    };
}

/**
 * Watches the platform's own usage records while the run goes: prints the AI calls made so far (and today's against the daily cap), and
 * stops the run (the signal) when the priced usage passes the budget or today's calls reach the cap. Returns the stopper.
 */
export function usageMonitor(client: PlatformClient, o: BenchOptions, ac: AbortController, log: (s: string) => void, notes: string[], stopReason: { value?: string }, everyMs: number, startedAt: string): () => void {
    if (o.budget === undefined && o.dailyCallCap === undefined) return () => undefined;
    let busy = false;
    let lastCalls = -1;
    const stop = (why: string, msg: string) => {
        stopReason.value = why;
        log(msg);
        notes.push(msg);
        ac.abort();
    };
    const timer = setInterval(async () => {
        if (busy || ac.signal.aborted) return;
        busy = true;
        try {
            // The budget is for the whole run, its resumes included: the cost since the run first started, not this month's.
            const cost = o.budget !== undefined ? await runUsageSoFar(client, startedAt).then((u) => u.cost, () => null) : null;
            const d = today();
            const day = await client.call("GET", `/api/usage?from=${d}&to=${d}`);
            const calls = day.status === 200 && typeof day.body?.totals?.calls === "number" ? (day.body.totals.calls as number) : null;
            if (calls !== null && calls !== lastCalls) {
                lastCalls = calls;
                log(`  AI calls today: ${calls}${o.dailyCallCap !== undefined ? ` of the daily cap ${o.dailyCallCap}` : ""}`);
            }
            if (o.budget !== undefined && cost !== null && cost > o.budget) stop("stopped: budget reached", `Stopped: the estimated AI cost of this run so far ($${cost.toFixed(2)}) passed the approved budget ($${o.budget.toFixed(2)}).`);
            else if (o.dailyCallCap !== undefined && calls !== null && calls >= o.dailyCallCap) stop(DAILY_CAP_STOP, `Stopped: ${calls} AI calls today reached the daily cap of ${o.dailyCallCap}. Run it again with --resume after midnight UTC.`);
        } finally {
            busy = false;
        }
    }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
