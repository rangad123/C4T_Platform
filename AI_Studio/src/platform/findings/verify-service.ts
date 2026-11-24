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
import { attemptsSetting, carriedOver, resetHookProblem, verdictOf, withinBudget, VERIFY_BUDGET, type AttemptAccount, type BudgetRun, type VerifyBudget } from "../../engine/findings/reproduce.js";
import { confidenceScore, severityOf } from "../../engine/findings/score.js";
import { concurrencyAllowed, riskyGateFor } from "../../engine/api/concurrency.js";
import { hasCurrentAuthorization } from "../../security/authorization-gate.js";
import type { Attempt } from "../../engine/findings/view.js";
import { getAdapter, hasAdapter, renderWithAdapter, type ExecutionBatch, type ExecutionEnv, type ExecutionOptions } from "../../engine/frameworks/index.js";
import type { RenderContext } from "../../engine/generators/types.js";
import { parseEvidence, type Evidence } from "../../engine/evidence/model.js";
import { attemptNote, parseAttemptNote, type RunEnv, type ScriptRun } from "../../engine/validation/runner.js";
import { testStepFault } from "../../engine/validation/test-fault.js";
import { startingIdsOf } from "../../engine/web/leftovers.js";
import { clip, HIDDEN, redactText } from "../../shared/redact-text.js";
import { namesASecret, runSecretValues } from "../../engine/evidence/secret-policy.js";
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
import { attemptOf, executionFinding, fromCandidate, withStepRequests, type TestOf } from "./adapters.js";
import { judgePageCheck } from "../../engine/findings/expectation.js";

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
        await noteNotVerified(d.store, d.projectId, run.left.map((r) => r.f), run.stopped);
    }
    await confirmAndGroup(d, out);
    return out;
}

/**
 * After the attempts: the engine confirms each finding it reproduced at high confidence (the lifecycle refuses it below), and each
 * finding in no group yet joins its duplicates (findings/dedupe.ts: same source and two strong signals, never on the message alone): the
 * group they are in, else a new one. A person's split is kept. Grouping is a convenience: a failure to group leaves each finding alone.
 */
async function confirmAndGroup(d: VerifyDeps, out: VerifyResult): Promise<void> {
    for (const v of out.verified) {
        if (v.to !== "reproduced") continue;
        const r = await d.store.get(d.projectId, v.id);
        if (r?.state !== "reproduced" || r.confidenceDetail?.confidence !== "high") continue;
        const t = r.testId ? d.testOf(r.testId) : undefined;
        // A confirmed finding carries its severity (V10: it was null on every one), from the same rules the card shows.
        const severity = r.severity ?? severityOf(fromCandidate(r, t ? { id: t.id, title: t.title, spec: t.spec, meta: t.meta } : undefined)).severity;
        await d.store.transition(d.projectId, v.id, { to: "confirmed", by: "engine", reason: `Confirmed at high confidence. ${v.reason}`, set: { severity } });
    }
    try {
        const all = await d.store.list(d.projectId);
        if (all.every((r) => r.groupId)) return;
        // A person's split (routes/findings.ts: the finding's new group names the one it left) keeps those findings apart from then on.
        const stored = await d.store.groups(d.projectId);
        const members = new Map(stored.map((g) => [g.id, g.findingIds]));
        const apart: Array<[string, string]> = [];
        for (const g of stored) {
            const from = (g.signature as { splitFrom?: unknown } | null)?.splitFrom;
            if (typeof from === "string") for (const x of g.findingIds) for (const y of members.get(from) ?? []) apart.push([x, y]);
        }
        const views = all.map((r) => {
            const t = r.testId ? d.testOf(r.testId) : undefined;
            return fromCandidate(r, t ? { id: t.id, title: t.title, spec: t.spec, meta: t.meta } : undefined);
        });
        const groupOf = new Map(all.map((r) => [r.id, r.groupId]));
        for (const g of dedupe(views, apart)) {
            const loose = g.memberIds.filter((m) => !groupOf.get(m));
            if (!loose.length) continue;
            // A new sighting joins the group its first grouped match is in; findings that match only each other form a new group.
            const home = g.memberIds.map((m) => groupOf.get(m)).find((x): x is string => Boolean(x));
            if (home) await d.store.addToGroup(d.projectId, home, loose);
            else if (loose.length > 1) await d.store.group(d.projectId, loose, { why: g.why });
        }
    } catch (e) {
        d.emit(`The findings were not grouped as duplicates: ${redactText(e instanceof Error ? e.message : String(e), 300)}`, "warn");
    }
}

/** V3: a finding the budget left out still says why it waits, in its own history (its state stays Candidate until a run verifies it). */
async function noteNotVerified(store: CandidateFindingStore, projectId: string, left: readonly CandidateFindingRecord[], why: string): Promise<void> {
    for (const f of left) await store.note(projectId, f.id, { by: "engine", reason: `Not verified: budget used. ${why} The next run verifies it.` }).catch(() => undefined);
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
export async function attemptsOn(d: Omit<VerifyDeps, "findings">, f: CandidateFindingRecord, test: VerifyTest, signal: AbortSignal, attempts = attemptsSetting(d.attempts), reset?: VerifyDeps["reset"]) {
    const { spec } = test;
    const adapterId = getAdapter(test.framework).id;
    // Who the attempts run as: a new account per attempt where it is safe (explore/clean-account.ts), else the reason it is not.
    const plan = cleanReplayPlan({ steps: spec.steps, roleAccount: spec.tags.some((t) => t.startsWith("role:")), dataChanges: d.dataChanges, ...(d.signupPath ? { signupPath: d.signupPath } : {}), ...(d.startingIds ? { startingIds: d.startingIds } : {}) });
    const script = renderWithAdapter(spec, adapterId, d.render);
    const run = (n: number) =>
        d.execute(adapterId, { scratchDir: d.scratchDir, scripts: [{ testId: spec.testId, filename: script.filename, content: script.content }] }, { run: d.env }, {
            workers: 1,
            signal,
            attempts: n,
            video: false,
            ...(plan.register ? { freshAccount: { signupPath: plan.signupPath, ...(d.loginPath ? { loginPath: d.loginPath } : {}) } } : {}),
        });
    let runs: ScriptRun[] = [];
    if (reset) {
        // Q5: the application is reset before each attempt, so a test that changes data starts every attempt from the same data (V10 R3).
        for (let i = 1; i <= attempts; i++) {
            const sent = await reset.send(signal);
            if (!sent.ok) throw new Error(`the application could not be reset before attempt ${i} (${sent.message})`);
            const one = await run(1);
            const note = parseAttemptNote(one[0]?.notes?.[0]);
            runs.push(...one.map((x) => ({ ...x, notes: [attemptNote(i, attempts, note?.clean !== undefined ? { clean: note.clean, note: note.note } : undefined), ...(x.notes ?? []).slice(1)] })));
        }
    } else runs = await run(attempts);
    if (signal.aborted) throw signal.reason ?? new Error("stopped");
    const notes = runs.map((x) => parseAttemptNote(x.notes?.[0]));
    const account: AttemptAccount = plan.register
        ? { clean: notes.every((n) => n?.clean === true), note: notes.find((n) => n?.clean === false)?.note ?? "on a newly registered account each time" }
        : { clean: plan.clean, note: plan.why };
    const secrets = runSecretValues(d.env);
    const tried = await Promise.all(
        runs.map(async (x) => {
            const file = x.artifacts.find((a) => a.kind === "evidence");
            const ev = file ? parseEvidence(await fs.readFile(file.path, "utf8").catch(() => ""), secrets) : undefined;
            const a = withStepRequests(attemptOf(x, spec), ev);
            const who = parseAttemptNote(x.notes?.[0])?.note;
            return who ? { ...a, account: who } : a;
        }),
    );
    // Without a reset, an attempt that began from an earlier attempt's changes is not a reproduction (findings/reproduce.ts).
    if (!reset) tried.splice(0, tried.length, ...carriedOver(tried));
    const view = judgedView(fromCandidate(f, test), f, test, tried);
    let verdict = verdictOf(view.view, tried, account);
    // An amount no API answer was compared with is never confirmed by the vote alone: a person checks it.
    if (view.review && verdict.to === "reproduced")
        verdict = { to: "needs_manual_review", reason: `${verdict.reason} ${view.review}`, classification: { ...verdict.classification, class: "open", candidates: ["app_defect", "incorrect_expectation"] } };
    return { runs, notes, account, tried, view: view.view, verdict };
}

/** The view with the expectation check before the vote (findings/expectation.ts): an unstated or API-contradicted expectation, or why a person checks it. */
function judgedView(view: ReturnType<typeof fromCandidate>, f: CandidateFindingRecord, test: VerifyTest, tried: readonly Attempt[]): { view: ReturnType<typeof fromCandidate>; review?: string } {
    const failedStep = tried.find((a) => a.outcome === "failed" && !a.stepFault)?.failedStep;
    const correlated = Boolean(f.finding.evidence.layers?.length || view.correlated?.disagreed.length);
    const j = judgePageCheck({ spec: test.spec, ...(failedStep !== undefined ? { failedStep } : {}), cited: view.expected.text, apiAmount: test.meta?.apiAmount, correlated });
    if (!j) return { view };
    const expected = { ...view.expected, ...(j.unstated ? { stated: "none" as const } : {}), ...(j.contradictedBy ? { contradictedBy: j.contradictedBy.slice(0, 300) } : {}) };
    return { view: { ...view, expected }, ...(j.review ? { review: j.review } : {}) };
}

async function verifyOne(d: VerifyDeps, r: { f: CandidateFindingRecord; test: VerifyTest; adapterId: string }, attempts: number, reset: VerifyDeps["reset"], signal: AbortSignal): Promise<{ to: string; reason: string }> {
    const { f, test } = r;
    if (f.state === "candidate") await d.store.transition(d.projectId, f.id, { to: "verification_pending", by: "engine" });
    try {
        const { runs, notes, account, tried: raw, view, verdict } = await attemptsOn(d, f, test, signal, attempts, reset);
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
        data: Object.fromEntries(Object.entries(test.spec.testData).map(([k, v]) => [line(k, 100), namesASecret(k) ? HIDDEN : line(v)])),
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
export async function verifyAfterJob(p: Platform, job: JobRow, o: VerifyAfterOptions = {}): Promise<(VerifyResult & { queuedJobId?: string }) | undefined> {
    // One verification of a project at a time: two runs that finish close together would each pick up the same waiting finding, and the
    // second's refused move settled it Unconfirmed while the first's attempts were still going. The next one reads the states afresh.
    // shortcut: in this process only; a second worker process could still overlap, upgrade with a claim on the finding row.
    const mine = (verifying.get(job.projectId) ?? Promise.resolve()).then(() => verifyAfterJobNow(p, job, o));
    // The turn's end, never its result or error: one settled promise per project is all that stays.
    verifying.set(job.projectId, mine.then(() => undefined, () => undefined));
    return mine;
}

const verifying = new Map<string, Promise<void>>();

type VerifyAfterOptions = {
    budget?: VerifyBudget;
    signal?: AbortSignal;
    attempts?: number;
    execute?: VerifyDeps["execute"];
    ranOn?: string;
    harvested?: boolean;
    /** The tests a creation job left as findings, when their statuses have changed since (the benchmark reruns and replays first). */
    findingTests?: ReadonlySet<string>;
    /** A reset of the application in place of the project's saved one (the benchmark's own app reset). */
    reset?: VerifyDeps["reset"];
};

async function verifyAfterJobNow(p: Platform, job: JobRow, o: VerifyAfterOptions): Promise<(VerifyResult & { queuedJobId?: string }) | undefined> {
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
        const cap = Math.max(0, Math.floor((o.budget ?? VERIFY_BUDGET).findingsPerRun));
        const batch = findings.slice(0, cap);
        const n = `${batch.length} finding${batch.length === 1 ? "" : "s"}`;
        if (findings.length > cap) await noteNotVerified(store, job.projectId, findings.slice(cap), `The verification budget of ${cap} finding${cap === 1 ? "" : "s"} per run was used.`);
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
        ...(o.reset ? { reset: o.reset } : {}),
        findings,
        ...(o.attempts !== undefined ? { attempts: o.attempts } : {}),
        ...(o.budget ? { budget: o.budget } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
    });
}

/** Why a verification job's findings are Unconfirmed when the job was given up (repo.ts reclaimStaleJobs, after three lost workers). */
export const VERIFY_LOST =
    "It could not be verified: the platform lost track of its verification run three times (the process looking after it stopped each time). The next run verifies it again if it fails again.";

/** A verification job given up: the findings it had moved to Verification pending are Unconfirmed with why, never left waiting. */
export async function settleGivenUpVerification(p: Platform, jobId: string): Promise<number> {
    const job = p.repo.getJob(jobId);
    if (!job || job.options.mode !== "verify") return 0;
    const tests = new Set(job.options.testIds ?? []);
    const store = new CandidateFindingStore(p.sql);
    let n = 0;
    for (const f of await store.inStates(job.projectId, ["verification_pending"])) {
        if (!f.testId || !tests.has(f.testId)) continue;
        if (await store.transition(job.projectId, f.id, { to: "unconfirmed", by: "engine", reason: VERIFY_LOST }).catch(() => undefined)) n++;
    }
    return n;
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
    const apiBaseUrl = (app.config.apiBaseUrl as string | undefined) ?? origin;
    const dataChanges = job.options.allowMutatingApiTests === true || app.config.allowMutatingApiTests === true;
    // The risky-checks gate a run of these tests had (job-runner.ts riskyChecksGateOf): without it an access write skips itself, and its
    // attempts verify nothing (V10 R7, R9).
    const gate = riskyGateFor(p.config.BENCH_RISKY_CHECKS ? "bench" : hasCurrentAuthorization(p.db, job.projectId, app.url) ? "authorization" : undefined, app.url, apiBaseUrl);
    const riskyChecks = gate && concurrencyAllowed({ dataChanges, appUrl: apiBaseUrl, gate }).allowed ? gate : undefined;
    const env: RunEnv = {
        baseUrl: origin,
        apiBaseUrl,
        ...(c?.username && c.password ? { credentials: { username: c.username, password: c.password, ...(c.totpSecret ? { totpSecret: c.totpSecret } : {}) } } : {}),
        ...(roles.length ? { roles } : {}),
        ...(c?.apiToken ? { apiToken: c.apiToken } : {}),
        ...(c?.apiAuthHeader ? { apiAuthHeader: c.apiAuthHeader } : {}),
        headless: true,
        ...(riskyChecks ? { riskyChecks } : {}),
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
        dataChanges,
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
