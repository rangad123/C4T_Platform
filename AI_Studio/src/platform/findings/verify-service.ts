/**
 * Finding verification after a run (testing-engine Phase 5 V1, spec §5.1 item 2, Q4–Q6): the run's new candidate findings are each run
 * again `attempts` times (validation/runner.ts, hook H1), each attempt in a fresh browser and, where the test signs in as the project's
 * account and the project allows tests that change data, as a newly registered account; no video. The verdict (findings/reproduce.ts)
 * moves the finding out of Verification pending, with the attempts, the class and the confidence; each attempt keeps an evidence package
 * (masked JSON) and its screenshot and scrubbed trace as artifacts of the finding's test, so the retention hold keeps them while the
 * finding is open.
 *
 * A run of saved tests (mode validate) also writes its failed tests into candidate_findings first: a failure that is not the test's own
 * step is an execution (or, with test meta `layer`, a layer) finding. Budget: at most 30 findings per run, 10 minutes each; the rest wait.
 * No AI calls: nothing here is given a model.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { cleanReplayPlan, signupPathOf } from "../../engine/explore/clean-account.js";
import { dedupe } from "../../engine/findings/dedupe.js";
import { attemptsSetting, resetHookProblem, verdictOf, withinBudget, VERIFY_BUDGET, type AttemptAccount, type BudgetRun, type VerifyBudget } from "../../engine/findings/reproduce.js";
import { confidenceScore } from "../../engine/findings/score.js";
import type { Attempt } from "../../engine/findings/view.js";
import { getAdapter, hasAdapter, renderWithAdapter, type ExecutionBatch, type ExecutionEnv, type ExecutionOptions } from "../../engine/frameworks/index.js";
import type { RenderContext } from "../../engine/generators/types.js";
import { parseEvidence, type Evidence } from "../../engine/evidence/model.js";
import { parseAttemptNote, type RunEnv, type ScriptRun } from "../../engine/validation/runner.js";
import { testStepFault } from "../../engine/validation/test-fault.js";
import { startingIdsOf } from "../../engine/web/leftovers.js";
import { clip, HIDDEN, redactText } from "../../shared/redact-text.js";
import { isSecretSettingName, runSecretValues } from "../../engine/evidence/secret-policy.js";
import { maskText, maskValue } from "../redact-text.js";
import { tryExpandBlocks } from "../../engine/blocks/expand.js";
import { localExecutor } from "../../engine/frameworks/index.js";
import { tryResolveSpecRefs } from "../../engine/locators/refs.js";
import { getAgentServices } from "../agent-services.js";
import { blocksFor } from "../block-store.js";
import type { Platform } from "../bootstrap.js";
import { CANDIDATE_FINDINGS_LIST_MAX, CandidateFindingStore, type CandidateFindingRecord } from "../candidate-finding-store.js";
import { IdentityStore } from "../identity-store.js";
import { LocatorStore } from "../locator-store.js";
import { DEFAULT_JOB_OPTIONS, type JobRow } from "../repo.js";
import { SecretBox } from "../secrets.js";
import { ResetHookStore, sendResetRequest } from "../test-data-reset-store.js";
import { attemptOf, executionFinding, fromCandidate, type TestOf } from "./adapters.js";

/** A test the verification can run: its key, steps and framework. */
export interface VerifyTest extends TestOf {
    testKey: string;
    framework: string;
}

/** One attempt's evidence package (plan V1), every text masked; artifact ids name the stored screenshot and trace. */
export interface EvidencePackage {
    attempt: number;
    of: number;
    account: string;
    cleanState: boolean;
    outcome: Attempt["outcome"];
    failedStep?: number;
    steps: Array<{ index: number; title: string; status: string; error?: string }>;
    preconditions: string[];
    data: Record<string, string>;
    appVersion: string;
    browser: string;
    environment: { appUrl: string; ranOn: string };
    /** "GET /api/cart -> 200" lines of the failing step (else the attempt's last ones). */
    requests: string[];
    /** Masked response bodies (<= 8 KB) of those requests: Phase 4's step capture; until then not available. */
    responseBodies: "not available";
    console: string[];
    screenshot?: string;
    trace?: string;
    video: "off";
    notes: string[];
}

export interface VerifyDeps {
    store: CandidateFindingStore;
    projectId: string;
    findings: readonly CandidateFindingRecord[];
    testOf: (testId: string) => VerifyTest | undefined;
    appUrl: string;
    env: RunEnv;
    render: RenderContext;
    scratchDir: string;
    /** Where the attempts run (the job's executor: this machine, or the starter's runner). */
    execute: (adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions) => Promise<ScriptRun[]>;
    ranOn: string;
    /** The project's setting (1-5, default 3). */
    attempts?: number;
    /** The project allows tests that change data (needed to register a new account). */
    dataChanges: boolean;
    signupPath?: string;
    loginPath?: string;
    startingIds?: ReadonlySet<string>;
    /** The project's reset request, sent before each finding's attempts when it passes resetHookProblem. */
    reset?: { hook: { method: string; url: string }; send: (signal: AbortSignal) => Promise<{ ok: boolean; message: string }> };
    appVersion?: () => Promise<string | null>;
    /** Stores one attempt's file (screenshot, trace, package): its artifact id, or undefined when it could not be kept. */
    keep?: (f: CandidateFindingRecord, test: VerifyTest, attempt: number, file: { kind: string; path?: string; json?: unknown; name: string }) => Promise<string | undefined>;
    emit: (message: string, level?: "info" | "warn") => void;
    budget?: VerifyBudget;
    signal?: AbortSignal;
}

export interface VerifyResult {
    verified: Array<{ id: string; to: string; reason: string }>;
    skipped: Array<{ id: string; why: string }>;
    stopped?: string;
}

const isVerifiable = (state: string) => state === "candidate" || state === "verification_pending";

/** Verifies the given findings within the budget. Never throws for one finding: its reason is recorded and the next one goes on. */
export async function verifyFindings(d: VerifyDeps): Promise<VerifyResult> {
    const out: VerifyResult = { verified: [], skipped: [] };
    const attempts = attemptsSetting(d.attempts);
    type Ready = { f: CandidateFindingRecord; test: VerifyTest; adapterId: string };
    const ready: Ready[] = [];
    for (const f of d.findings) {
        if (!isVerifiable(f.state)) continue;
        const test = f.testId ? d.testOf(f.testId) : undefined;
        const why = !test
            ? "its test no longer exists"
            : !hasAdapter(test.framework) || getAdapter(test.framework).runtime !== "playwright"
              ? `${test.spec.kind} tests are not verified yet (web and API tests are)`
              : undefined;
        if (why) out.skipped.push({ id: f.id, why });
        else ready.push({ f, test: test!, adapterId: getAdapter(test!.framework).id });
    }
    const resetWhy = d.reset ? resetHookProblem(d.reset.hook, d.appUrl) : undefined;
    if (resetWhy) d.emit(`Verification does not reset the application: ${resetWhy}`, "warn");
    let run: BudgetRun<Ready, { to: string; reason: string }>;
    try {
        run = await withinBudget(ready, (r, signal) => verifyOne(d, r, attempts, resetWhy ? undefined : d.reset, signal), d.budget ?? VERIFY_BUDGET, d.signal);
    } catch (e) {
        // Stopped part way (the run was stopped, the platform shuts down): the finding cut short says so instead of waiting silently.
        for (const { f } of ready) if ((await d.store.get(d.projectId, f.id).catch(() => undefined))?.state === "verification_pending") await settle(d, f, "unconfirmed", "Verification was stopped before its attempts finished (the run was stopped or the platform shut down).");
        throw e;
    }
    for (const { item, result } of run.done) out.verified.push({ id: item.f.id, ...result });
    for (const { item, why } of run.timedOut) out.verified.push({ id: item.f.id, ...(await settle(d, item.f, "unconfirmed", why)) });
    if (run.stopped) {
        out.stopped = run.stopped;
        d.emit(run.stopped, "warn");
    }
    await confirmAndGroup(d, out);
    return out;
}

/**
 * After the attempts: the engine confirms each finding it reproduced at high confidence (the lifecycle refuses it below), and the project's
 * findings that are in no group yet are grouped as duplicates (findings/dedupe.ts: same source and two strong signals, never on the
 * message alone). Grouping is a convenience: a failure to group leaves each finding on its own.
 */
async function confirmAndGroup(d: VerifyDeps, out: VerifyResult): Promise<void> {
    for (const v of out.verified) {
        if (v.to !== "reproduced") continue;
        const r = await d.store.get(d.projectId, v.id);
        if (r?.state !== "reproduced" || r.confidenceDetail?.confidence !== "high") continue;
        await d.store.transition(d.projectId, v.id, { to: "confirmed", by: "engine", reason: `Confirmed at high confidence. ${v.reason}` });
    }
    try {
        // shortcut: a new sighting that matches an existing group starts its own group; upgrade with a store method that adds members.
        const loose = (await d.store.list(d.projectId)).filter((r) => !r.groupId);
        const views = loose.map((r) => {
            const t = r.testId ? d.testOf(r.testId) : undefined;
            return fromCandidate(r, t ? { id: t.id, title: t.title, spec: t.spec, meta: t.meta } : undefined);
        });
        for (const g of dedupe(views)) if (g.memberIds.length > 1) await d.store.group(d.projectId, g.memberIds, { why: g.why });
    } catch (e) {
        d.emit(`The findings were not grouped as duplicates: ${redactText(e instanceof Error ? e.message : String(e), 300)}`, "warn");
    }
}

/** Moves a finding that waits in Verification pending to `to` with only a reason (an attempt that could not run). */
async function settle(d: VerifyDeps, f: CandidateFindingRecord, to: "unconfirmed", reason: string): Promise<{ to: string; reason: string }> {
    await d.store.transition(d.projectId, f.id, { to, by: "engine", reason }).catch(() => undefined);
    return { to, reason };
}

/**
 * Runs a finding's test `attempts` times as V1 does (a fresh browser each, a new account where it is safe, no video) and judges them.
 * Changes no finding. Also the regression service's check of a claimed fix (regression-service.ts). Throws when the attempts cannot run.
 */
export async function attemptsOn(d: Omit<VerifyDeps, "findings">, f: CandidateFindingRecord, test: VerifyTest, signal: AbortSignal, attempts = attemptsSetting(d.attempts)) {
    const { spec } = test;
    const adapterId = getAdapter(test.framework).id;
    // Who the attempts run as: a new account per attempt where it is safe (explore/clean-account.ts), else the reason it is not.
    const plan = cleanReplayPlan({ steps: spec.steps, roleAccount: spec.tags.some((t) => t.startsWith("role:")), dataChanges: d.dataChanges, ...(d.signupPath ? { signupPath: d.signupPath } : {}), ...(d.startingIds ? { startingIds: d.startingIds } : {}) });
    const script = renderWithAdapter(spec, adapterId, d.render);
    const runs = await d.execute(adapterId, { scratchDir: d.scratchDir, scripts: [{ testId: spec.testId, filename: script.filename, content: script.content }] }, { run: d.env }, {
        workers: 1,
        signal,
        attempts,
        video: false,
        ...(plan.register ? { freshAccount: { signupPath: plan.signupPath, ...(d.loginPath ? { loginPath: d.loginPath } : {}) } } : {}),
    });
    if (signal.aborted) throw signal.reason ?? new Error("stopped");
    const notes = runs.map((x) => parseAttemptNote(x.notes?.[0]));
    const account: AttemptAccount = plan.register
        ? { clean: notes.every((n) => n?.clean === true), note: notes.find((n) => n?.clean === false)?.note ?? "on a newly registered account each time" }
        : { clean: plan.clean, note: plan.why };
    const tried = runs.map((x) => attemptOf(x, spec));
    const view = fromCandidate(f, test);
    return { runs, notes, account, tried, view, verdict: verdictOf(view, tried, account) };
}

async function verifyOne(d: VerifyDeps, r: { f: CandidateFindingRecord; test: VerifyTest; adapterId: string }, attempts: number, reset: VerifyDeps["reset"], signal: AbortSignal): Promise<{ to: string; reason: string }> {
    const { f, test } = r;
    if (f.state === "candidate") await d.store.transition(d.projectId, f.id, { to: "verification_pending", by: "engine" });
    try {
        if (reset) {
            const sent = await reset.send(signal);
            if (!sent.ok) return await settle(d, f, "unconfirmed", `It could not be verified: the application could not be reset first (${sent.message}).`);
        }
        const { runs, notes, account, tried: raw, view, verdict } = await attemptsOn(d, f, test, signal, attempts);
        const tried = maskValue(raw, runSecretValues(d.env));
        const appVersion = (await d.appVersion?.().catch(() => null)) ?? null;
        for (const [i, x] of runs.entries()) await keepEvidence(d, f, test, x, tried[i]!, i + 1, runs.length, account, notes[i]?.note, appVersion);
        const confidence = confidenceScore({ ...view, attempts: tried, independence: account.clean ? "independent" : "not_on_clean_state" });
        const c = verdict.classification;
        await d.store.transition(d.projectId, f.id, { to: verdict.to, by: "engine", reason: verdict.reason, set: { attempts: tried, findingClass: c.class === "open" ? null : c.class, confidence, appVersion } });
        d.emit(`${test.testKey}: ${verdict.to === "reproduced" ? "reproduced" : verdict.to.replace(/_/g, " ")}. ${verdict.reason}`, verdict.to === "reproduced" ? "warn" : "info");
        return { to: verdict.to, reason: verdict.reason };
    } catch (e) {
        if (signal.aborted) throw e;
        // An older runner, a runner that is off, a script that cannot be made: the finding says why it is not verified.
        const why = clip(maskText(e instanceof Error ? e.message.split("\n")[0]! : String(e), runSecretValues(d.env)), 600);
        return await settle(d, f, "unconfirmed", `It could not be verified: ${why}`);
    }
}

async function keepEvidence(d: VerifyDeps, f: CandidateFindingRecord, test: VerifyTest, run: ScriptRun, attempt: Attempt, i: number, n: number, account: AttemptAccount, note: string | undefined, appVersion: string | null): Promise<void> {
    if (!d.keep) return;
    const secrets = runSecretValues(d.env);
    const line = (s: string, max = 300) => clip(maskText(s, secrets), max);
    const shot = run.artifacts.find((a) => a.kind === "screenshot");
    const trace = run.artifacts.find((a) => a.kind === "trace");
    const evidenceFile = run.artifacts.find((a) => a.kind === "evidence");
    let ev: Evidence | undefined;
    if (evidenceFile) ev = parseEvidence(await fs.readFile(evidenceFile.path, "utf8").catch(() => ""), secrets);
    const step = attempt.failedStep;
    const own = ev?.requests.filter((q) => step !== undefined && q.step === step) ?? [];
    const requests = (own.length ? own : (ev?.requests ?? []).slice(-20)).slice(0, 20).map((q) => line(`${q.method} ${q.path} -> ${q.status ?? q.failed ?? "no answer"}`));
    const pkg: EvidencePackage = {
        attempt: i,
        of: n,
        account: line(note ?? account.note),
        cleanState: account.clean,
        outcome: attempt.outcome,
        ...(attempt.failedStep ? { failedStep: attempt.failedStep } : {}),
        steps: run.steps.map((s) => ({ index: s.index, title: line(s.title), status: s.status, ...(s.error ? { error: line(s.error, 800) } : {}) })),
        preconditions: test.spec.preconditions.map((p) => line(p)),
        data: Object.fromEntries(Object.entries(test.spec.testData).map(([k, v]) => [line(k, 100), isSecretSettingName(k) ? HIDDEN : line(v)])),
        appVersion: appVersion ?? "unknown",
        browser: "Chromium (headless)",
        environment: { appUrl: line(d.appUrl), ranOn: d.ranOn },
        requests: requests.length ? requests : run.responses.slice(-20).map((x) => line(`${x.method} ${x.path} -> ${x.status}`)),
        responseBodies: "not available",
        console: (ev?.console ?? []).slice(-20).map((c) => line(`${c.type}: ${c.text}`, 600)),
        video: "off",
        notes: (run.notes ?? []).slice(0, 10).map((x) => line(x, 500)),
    };
    if (shot) pkg.screenshot = await d.keep(f, test, i, { kind: "screenshot", path: shot.path, name: `screenshot${path.extname(shot.path)}` });
    if (trace) pkg.trace = await d.keep(f, test, i, { kind: "trace", path: trace.path, name: `trace${path.extname(trace.path)}` });
    await d.keep(f, test, i, { kind: "evidence", json: pkg, name: "package.json" });
}

/**
 * A run of saved tests: each failed test whose failure is not its own step becomes an execution (or layer) finding, one row per project
 * and test (its fingerprint, adapters.ts executionFinding), counted seen again when it fails again. Returns the findings it wrote.
 */
export async function harvestExecutionFindings(
    store: CandidateFindingStore,
    x: { projectId: string; jobId: string | null; failed: ReadonlyArray<{ test: VerifyTest; run: ScriptRun }> },
): Promise<CandidateFindingRecord[]> {
    const out: CandidateFindingRecord[] = [];
    for (const { test, run } of x.failed) {
        if (run.status === "passed" || run.status === "skipped") continue;
        const step = run.failedStepIndex >= 0 ? test.spec.steps[run.failedStepIndex] : undefined;
        if (testStepFault(run, step)) continue;
        const finding = executionFinding(test, run);
        out.push((await store.upsert({ projectId: x.projectId, jobId: x.jobId, testId: test.id, finding })).finding);
    }
    return out;
}

/** The engine-side inputs of a project the verification needs from its discovery model (sign-up page, starting records). */
export function modelFacts(model: unknown): { signupPath?: string; loginPath?: string; startingIds: Set<string> } {
    const m = model as { authentication?: { signupPath?: string; loginPath?: string }; pages?: Array<{ path: string; type?: string }> } | null | undefined;
    const signupPath = m ? signupPathOf(m as never) : undefined;
    return { ...(signupPath ? { signupPath } : {}), ...(m?.authentication?.loginPath ? { loginPath: m.authentication.loginPath } : {}), startingIds: startingIdsOf(model) };
}


/**
 * After a job (schedule-services.ts onJobFinished, when VERIFY_FINDINGS is on): an exploration's new candidate findings, and a run's
 * failed tests (written as findings first), are verified on this machine. A project whose tests run on a runner gets a verification job
 * instead (mode "verify", job-runner.ts): a runner task belongs to a live job, and this one has ended. That job calls this again with its
 * executor (`execute`, the runner's attempts through hook H1) and `harvested`, the failed tests being findings already.
 * Undefined when there is nothing to do.
 */
export async function verifyAfterJob(
    p: Platform,
    job: JobRow,
    o: {
        budget?: VerifyBudget;
        signal?: AbortSignal;
        attempts?: number;
        execute?: VerifyDeps["execute"];
        ranOn?: string;
        harvested?: boolean;
        /** The tests a creation job left as findings, when their statuses have changed since (the benchmark reruns and replays first). */
        findingTests?: ReadonlySet<string>;
    } = {},
): Promise<(VerifyResult & { queuedJobId?: string }) | undefined> {
    const mode = job.options.mode ?? "generate";
    if ((mode !== "validate" && mode !== "generate") || job.options.planOnly || job.error === "Cancelled") return undefined;
    const app = p.repo.getApplication(job.applicationId);
    if (!app || app.projectId !== job.projectId) return undefined;
    const emit = jobEmitter(p, job.id);
    const store = new CandidateFindingStore(p.sql);
    const testOf = testsOf(p, job.projectId);
    // A run's failed tests are findings; a creation job's are only the ones it left as findings (Needs review: Phase 4 layer checks among
    // them), not the tests it could not make pass for their own reasons.
    const isFinding = (id: string) => (o.findingTests ? o.findingTests.has(id) : p.repo.getTest(id)?.validationStatus === "NEEDS_REVIEW");
    const failed = o.harvested ? [] : failedRunsOf(p, job, testOf).filter((x) => mode === "validate" || isFinding(x.test.id));
    if (failed.length) await harvestExecutionFindings(store, { projectId: job.projectId, jobId: job.id, failed });
    // This run's new findings first, then older ones still waiting, oldest first. withinBudget caps the whole list; findings it cannot
    // verify (another kind of test) cost no budget, so the older ones are read past them.
    const own = (await store.list(job.projectId, { jobId: job.id })).filter((f) => isVerifiable(f.state) && f.testId);
    const older = (await store.waiting(job.projectId, CANDIDATE_FINDINGS_LIST_MAX)).filter((f) => !own.some((x) => x.id === f.id));
    const findings = [...own, ...older];
    if (findings.length === 0) return undefined;
    if (!o.execute && getAgentServices(p).routesToAgent(job.projectId)) {
        const batch = findings.slice(0, Math.max(0, Math.floor((o.budget ?? VERIFY_BUDGET).findingsPerRun)));
        const n = `${batch.length} finding${batch.length === 1 ? "" : "s"}`;
        try {
            // The run's starter's runner does the attempts, as it ran the run (agent-services.ts assertJobAllowed picks it).
            const testIds = [...new Set(batch.map((f) => f.testId!))];
            const queued = await p.repo.createJob(job.projectId, job.applicationId, { ...DEFAULT_JOB_OPTIONS, mode: "verify", verifyJobId: job.id, testIds, ...(job.options.startedBy ? { startedBy: job.options.startedBy } : {}) });
            emit(`${n} will be verified on the runner (verification run ${queued.id.slice(0, 8)}).`);
            return { verified: [], skipped: [], queuedJobId: queued.id };
        } catch (e) {
            const why = redactText(e instanceof Error ? e.message : String(e), 400);
            emit(`${n} wait${batch.length === 1 ? "s" : ""} for verification: the verification run on the runner could not start. ${why}`, "warn");
            return { verified: [], skipped: batch.map((f) => ({ id: f.id, why })) };
        }
    }
    return verifyFindings({
        ...verifyDepsOf(p, job, { emit, ...(o.execute ? { execute: o.execute } : {}), ...(o.ranOn ? { ranOn: o.ranOn } : {}) }),
        findings,
        ...(o.attempts !== undefined ? { attempts: o.attempts } : {}),
        ...(o.budget ? { budget: o.budget } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
    });
}

/** The job's events say what verification did; an event is a convenience. */
const jobEmitter = (p: Platform, jobId: string) => (message: string, level: "info" | "warn" = "info") => {
    try {
        p.repo.addEvent(jobId, { stage: "validation", kind: "finding_verification", level, message: redactText(message, 2000) });
    } catch {
        /* an event is a convenience */
    }
};

/** A project's tests as verification runs them: shared steps and elements put in place as a run does; one that cannot be is undefined. */
function testsOf(p: Platform, projectId: string): (id: string) => VerifyTest | undefined {
    const blocks = blocksFor(p.repo.db, projectId);
    const objects = new LocatorStore(p.repo.db).index(projectId);
    return (id) => {
        const t = p.repo.getTest(id);
        if (!t || t.projectId !== projectId || t.unreadable) return undefined;
        // As job-runner.ts resolveRefs.
        const expanded = tryExpandBlocks(t.spec, blocks);
        const r = expanded.ok ? tryResolveSpecRefs(expanded.spec, objects) : undefined;
        return r?.ok ? { id: t.id, title: t.title, spec: r.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework } : undefined;
    };
}

/**
 * What verification needs to run a project's tests again for `job` (the run whose findings, or the verification job itself): the
 * application's address and accounts, its reset request, its sign-up page, and where the evidence is kept. Throws when the job's
 * application is not the project's.
 */
export function verifyDepsOf(p: Platform, job: JobRow, o: { execute?: VerifyDeps["execute"]; ranOn?: string; emit?: VerifyDeps["emit"] } = {}): Omit<VerifyDeps, "findings"> {
    const app = p.repo.getApplication(job.applicationId);
    if (!app || app.projectId !== job.projectId) throw new Error("The run's application is not this project's.");
    const origin = new URL(app.url).origin;
    const c = app.credentials;
    const roles = new IdentityStore(p.repo.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).get(job.projectId);
    const env: RunEnv = {
        baseUrl: origin,
        apiBaseUrl: (app.config.apiBaseUrl as string | undefined) ?? origin,
        ...(c?.username && c.password ? { credentials: { username: c.username, password: c.password, ...(c.totpSecret ? { totpSecret: c.totpSecret } : {}) } } : {}),
        ...(roles.length ? { roles } : {}),
        ...(c?.apiToken ? { apiToken: c.apiToken } : {}),
        ...(c?.apiAuthHeader ? { apiAuthHeader: c.apiAuthHeader } : {}),
        headless: true,
    };
    const hook = new ResetHookStore(p.repo.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).secret(job.projectId, "");
    const facts = modelFacts(app.model ?? p.repo.getLatestAppModel(job.projectId));
    return {
        store: new CandidateFindingStore(p.sql),
        projectId: job.projectId,
        testOf: testsOf(p, job.projectId),
        appUrl: app.url,
        env,
        render: { baseUrl: origin, apiBaseUrl: env.apiBaseUrl },
        scratchDir: p.config.scratchDir,
        execute: o.execute ?? ((a, b, e, x) => localExecutor.execute(a, b, e, x)),
        ranOn: o.ranOn ?? "the platform",
        dataChanges: job.options.allowMutatingApiTests === true || app.config.allowMutatingApiTests === true,
        ...(facts.signupPath ? { signupPath: facts.signupPath } : {}),
        ...(facts.loginPath ? { loginPath: facts.loginPath } : {}),
        startingIds: facts.startingIds,
        ...(hook?.enabled ? { reset: { hook, send: async (signal: AbortSignal) => sendResetRequest(hook, app.url, signal) } } : {}),
        keep: async (f, test, attempt, file) => {
            const rel = path.posix.join(job.projectId, "_artifacts", test.testKey, `verify-${f.id.slice(0, 8)}`, `attempt-${attempt}`, file.name);
            try {
                const saved = file.json !== undefined
                    ? await p.store.put(rel, Buffer.from(JSON.stringify(file.json)), { contentType: "application/json" })
                    : await p.store.putFile(rel, file.path!);
                // Kept with the finding's test: the retention hold keeps a test's run-less files while a finding on it is open.
                return p.repo.addArtifact({ projectId: job.projectId, jobId: job.id, testId: test.id, kind: file.kind, path: rel, size: saved.size });
            } catch {
                return undefined;
            }
        },
        emit: o.emit ?? jobEmitter(p, job.id),
    };
}

/** The last run of each test in this job that failed, rebuilt from its stored execution (the steps' results, not the files). */
function failedRunsOf(p: Platform, job: JobRow, testOf: (id: string) => VerifyTest | undefined): Array<{ test: VerifyTest; run: ScriptRun }> {
    const rows = p.repo.db.all<{ id: string; test_case_id: string; status: string; error: string | null; attempt: number }>(
        "SELECT e.id, e.test_case_id, e.status, e.error, e.attempt FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE e.job_id = ? AND t.project_id = ? ORDER BY e.attempt, e.started_at",
        job.id,
        job.projectId,
    );
    const last = new Map<string, (typeof rows)[number]>();
    for (const r of rows) last.set(r.test_case_id, r);
    const out: Array<{ test: VerifyTest; run: ScriptRun }> = [];
    for (const r of last.values()) {
        if (r.status !== "failed" && r.status !== "timedOut") continue;
        const test = testOf(r.test_case_id);
        if (!test) continue;
        const steps = p.repo.db.all<{ idx: number; title: string; status: string; error: string | null }>("SELECT idx, title, status, error FROM test_execution_steps WHERE execution_id = ? ORDER BY idx", r.id);
        const failed = steps.find((s) => s.status === "failed");
        out.push({
            test,
            run: {
                testId: test.testKey,
                status: r.status as ScriptRun["status"],
                durationMs: 0,
                ...(r.error ? { error: r.error } : {}),
                failedStepIndex: failed ? Number(failed.idx) : -1,
                steps: steps.map((s) => ({ index: Number(s.idx), title: s.title, status: s.status === "failed" ? "failed" : "passed", ...(s.error ? { error: s.error } : {}) })),
                artifacts: [],
                responses: [],
            },
        });
    }
    return out;
}
