/**
 * Regression intelligence (testing-engine Phase 6 X1, spec §6 item 4): a fix is linked to a finding, checked on the build that has it, and
 * the finding is Fixed only when that check passes. Never assumed fixed.
 *
 *  - Link: a pull request whose title or commit messages say "Fixes #n" (closes, resolves) for an issue filed from a finding
 *    (issue_links, routes/integrations.ts), or a person's "Check the fix" on the finding (routes/findings.ts). A change that only touches
 *    where a finding happened is shown as such by the pull request's impact analysis (code-host/pr-impact.ts, reasons.findings): a
 *    suggestion, never a link, so it never starts a check.
 *  - Check: a verification job (mode "verify", job-runner.ts) runs the finding's test again through V1 (verify-service.ts attemptsOn: a
 *    fresh browser per attempt, a new account where one can be registered, no video), on the project's runner when its tests run there.
 *  - Fixed only when every attempt passes. Otherwise the finding keeps its state, and its history says "Fix claimed — still reproduces".
 *  - A fixed finding's test joins the project's "Regression" suite (suite-store.ts) with its sourced check, and the tests of the finding's
 *    area are recommended (the selection preview: a recommendation only, nothing is selected or run).
 *  - Reopen: a later run in which a Fixed finding's test fails, or that finds it again, moves it back to Verification pending.
 * No AI calls.
 */
import { STATE_LABEL, type FindingState } from "../../engine/findings/lifecycle.js";
import { redactText } from "../../shared/redact-text.js";
import type { Platform } from "../bootstrap.js";
import { CandidateFindingStore, type CandidateFindingRecord } from "../candidate-finding-store.js";
import type { CodeHostStore } from "../code-host/store.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobRow } from "../repo.js";
import { projectCoverage } from "../selection/facts.js";
import { previewSelection, readChanges, RECOMMENDATION_NOTE } from "../selection/preview.js";
import { SuiteStore } from "../suite-store.js";
import { pastFindings } from "./past.js";
import { attemptsSetting, VERIFY_BUDGET, withinBudget } from "../../engine/findings/reproduce.js";
import { attemptsOn, verifyDepsOf, type VerifyDeps, type VerifyTest } from "./verify-service.js";

/** States a fix is checked from: a bug a person or the engine stands behind. */
export const FIX_STATES: readonly FindingState[] = ["confirmed", "classified", "reported", "needs_manual_review"];
export const REGRESSION_SUITE = "Regression";
export const STILL_REPRODUCES = "Fix claimed — still reproduces";

export type FixCheck = NonNullable<JobOptions["fixCheck"]>;

const REF = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b\s*:?\s*#(\d{1,9})\b/gi;

/** The issue numbers a text says it fixes ("Fixes #12", "closes #3"), as GitHub issue ids ("#12"). */
export function fixReferences(text: string): string[] {
    return [...new Set([...text.slice(0, 200_000).matchAll(REF)].map((m) => `#${Number(m[1])}`))];
}

/** The issue address is one of this repository's issues (GitHub numbers issues per repository). */
const sameRepo = (url: string, repo: { owner: string; repo: string }) => url.toLowerCase().includes(`/${repo.owner}/${repo.repo}/issues/`.toLowerCase());

/** The findings a text links a fix to: those whose test carries a GitHub issue it names (with the issue's group mates), in a fixable state. */
export async function findingsFixedBy(p: Platform, projectId: string, text: string, repo?: { owner: string; repo: string }): Promise<CandidateFindingRecord[]> {
    const refs = fixReferences(text);
    if (!refs.length) return [];
    const links = p.db.all<{ test_case_id: string; url: string }>(
        `SELECT l.test_case_id, l.url FROM issue_links l JOIN test_cases t ON t.id = l.test_case_id WHERE t.project_id = ? AND l.provider = 'github' AND l.external_id IN (${refs.map(() => "?").join(",")})`,
        projectId,
        ...refs,
    );
    const tests = new Set(links.filter((l) => !repo || sameRepo(l.url, repo)).map((l) => l.test_case_id));
    const all = await new CandidateFindingStore(p.sql).list(projectId);
    const named = all.filter((f) => f.testId && tests.has(f.testId));
    const groups = new Set(named.map((f) => f.groupId).filter(Boolean));
    return all.filter((f) => (named.includes(f) || (f.groupId && groups.has(f.groupId))) && FIX_STATES.includes(f.state));
}

/**
 * Queues the check of a claimed fix: one verification job for the findings that can be checked, each with a history line. A finding not
 * in a fixable state, or without a test, is refused with why. Throws what creating the job throws (no runner online, for example).
 */
export async function claimFix(
    p: Platform,
    projectId: string,
    claim: FixCheck & { actor?: { id: string | null; label: string } },
): Promise<{ jobId?: string; refused: Array<{ id: string; why: string }> }> {
    const store = new CandidateFindingStore(p.sql);
    const ok: CandidateFindingRecord[] = [];
    const refused: Array<{ id: string; why: string }> = [];
    for (const id of [...new Set(claim.findingIds)]) {
        const f = await store.get(projectId, id);
        if (!f) refused.push({ id, why: "Finding not found." });
        else if (!FIX_STATES.includes(f.state)) refused.push({ id, why: `A fix is checked on a confirmed finding; this one is ${STATE_LABEL[f.state]}.` });
        else if (!f.testId || !p.repo.getTest(f.testId)) refused.push({ id, why: "This finding has no saved test to check the fix with." });
        else ok.push(f);
    }
    if (!ok.length) return { refused };
    const appId = p.repo.getLatestApplicationPublic(projectId)?.id as string | undefined;
    if (!appId) return { refused: [...refused, ...ok.map((f) => ({ id: f.id, why: "The project has no application to check the fix on." }))] };
    // A pull request's claim runs as the person whose run found the bug (their runner); a person's claim runs as that person (createJob).
    const startedBy = claim.by === "issue" ? p.repo.getJob(ok[0]!.lastJobId ?? ok[0]!.firstJobId ?? "")?.options.startedBy : undefined;
    const { actor, ...fixCheck } = claim;
    const job = await p.repo.createJob(projectId, appId, {
        ...DEFAULT_JOB_OPTIONS,
        mode: "verify",
        testIds: [...new Set(ok.map((f) => f.testId!))],
        fixCheck: { ...fixCheck, findingIds: ok.map((f) => f.id) },
        ...(startedBy ? { startedBy } : {}),
    });
    for (const f of ok) await store.note(projectId, f.id, { by: actor ? "person" : "engine", ...(actor ? { actor } : {}), reason: `Fix claimed by ${claim.source}: it is checked on the fixed build (verification run ${job.id.slice(0, 8)}).` });
    return { jobId: job.id, refused };
}

export interface FixOutcome {
    id: string;
    fixed: boolean;
    reason: string;
    /** Fixed only: the tests of the same area recommended next (none is run or selected). */
    related?: string[];
}

/** A verification job with a fix check: each finding's test runs again; Fixed only when every attempt passes. */
export async function checkFix(p: Platform, job: JobRow, o: { execute: VerifyDeps["execute"]; signal?: AbortSignal; ranOn?: string; emit?: VerifyDeps["emit"] }): Promise<FixOutcome[]> {
    const claim = job.options.fixCheck;
    if (!claim) return [];
    const store = new CandidateFindingStore(p.sql);
    const deps = verifyDepsOf(p, job, { execute: o.execute, ...(o.ranOn ? { ranOn: o.ranOn } : {}), ...(o.emit ? { emit: o.emit } : {}) });
    const signal = o.signal ?? new AbortController().signal;
    const on = claim.headSha ? `on the build of ${claim.headSha.slice(0, 7)}` : "on the application as it is now";
    const out: FixOutcome[] = [];
    const note = async (f: CandidateFindingRecord, reason: string) => (await store.note(job.projectId, f.id, { by: "engine", reason }), out.push({ id: f.id, fixed: false, reason }));
    const ready: Array<{ f: CandidateFindingRecord; test: VerifyTest }> = [];
    for (const id of claim.findingIds) {
        const f = await store.get(job.projectId, id);
        if (!f || !FIX_STATES.includes(f.state)) {
            out.push({ id, fixed: false, reason: "It no longer waits for a fix check." });
            continue;
        }
        const test = f.testId ? deps.testOf(f.testId) : undefined;
        if (!test) await note(f, `Fix claimed — not checked: its test no longer exists or cannot be run.`);
        else ready.push({ f, test });
    }
    const asked = attemptsSetting(deps.attempts);
    // The verification budget holds here too: at most so many findings, each for at most so long; the rest keep their state with why.
    const run = await withinBudget(ready, async ({ f, test }, each): Promise<void> => {
        let r: Awaited<ReturnType<typeof attemptsOn>>;
        try {
            r = await attemptsOn(deps, f, test, each, asked);
        } catch (e) {
            if (each.aborted) throw e;
            return void (await note(f, `Fix claimed — not checked: ${redactText(e instanceof Error ? e.message.split("\n")[0]! : String(e), 600)}`));
        }
        const n = r.tried.length;
        const failed = r.tried.filter((a) => a.outcome !== "passed").length;
        if (n === 0 || failed > 0) {
            return void (await note(f, n === 0 ? `Fix claimed — not checked: no attempt ran ${on}.` : `${STILL_REPRODUCES}: it failed in ${failed} of ${n} attempts ${on} (${claim.source}). ${r.verdict.reason}`));
        }
        // Never assumed fixed: every asked attempt ran, on clean state (leftovers on the shared account can make a pass as well as a failure).
        if (n < asked) return void (await note(f, `Fix claimed — not checked: only ${n} of ${asked} attempts ran ${on}.`));
        if (!r.account.clean) return void (await note(f, `Fix claimed — not checked on clean state: it passed in ${n} of ${n} attempts, but ${r.account.note}.`));
        const reason = `Fixed: it passed in ${n} of ${n} attempts (${r.account.note}) ${on}, after the fix ${claim.source} claimed.`;
        await store.transition(job.projectId, f.id, { to: "fixed", by: "engine", reason });
        // Its issue links stay, resolved: the test no longer expects the failure (job-runner.ts knownBugsOf), until a reopen.
        const issues = p.db.all<{ external_id: string }>("SELECT DISTINCT external_id FROM issue_links WHERE test_case_id = ? ORDER BY external_id", test.id).map((r) => r.external_id);
        if (issues.length) await store.note(job.projectId, f.id, { by: "engine", reason: `Its issue ${issues.join(", ")} no longer marks ${test.testKey} as expected to fail: resolved by the fix in ${claim.headSha ? claim.headSha.slice(0, 7) : "the application as it is now"}. A reopen makes it count again.` });
        await promoteToRegression(p, job.projectId, test.id);
        const related = await relatedTests(p, job.projectId, f.id, test.id);
        await store.note(job.projectId, f.id, { by: "engine", reason: `Its test ${test.testKey} is in the “${REGRESSION_SUITE}” suite now. ${related.note}` });
        out.push({ id: f.id, fixed: true, reason, related: related.testIds });
    }, VERIFY_BUDGET, signal);
    for (const { item, why } of run.timedOut) await note(item.f, `Fix claimed — not checked: ${why}`);
    for (const { f } of run.left) await note(f, `Fix claimed — not checked: ${run.stopped ?? "the verification budget was used."}`);
    return out;
}

/** The finding's test joins the project's Regression suite (made on first use); a test already there is not added twice. */
export async function promoteToRegression(p: Platform, projectId: string, testId: string): Promise<string> {
    const suites = new SuiteStore(p.sql);
    const suite =
        (await suites.findByName(projectId, REGRESSION_SUITE)) ??
        (await suites.create({ projectId, name: REGRESSION_SUITE, description: "Tests of bugs that were fixed: each fails again if its bug comes back." }));
    await suites.addTests(suite.id, [testId]);
    return suite.id;
}

/** The tests that cover the finding's pages and endpoints (the selection preview), the finding's own test left out. A recommendation only. */
export async function relatedTests(p: Platform, projectId: string, findingId: string, ownTestId: string): Promise<{ testIds: string[]; note: string }> {
    const area = (await pastFindings(p.sql, p.repo, projectId)).find((x) => x.id === findingId);
    if (!area) return { testIds: [], note: "The finding names no page or endpoint, so no other test is recommended." };
    const c = await projectCoverage(p.repo, p.store, projectId);
    const { changes, ignored, notProcessed } = readChanges({ pages: area.pages, endpoints: area.endpoints }, c.app);
    const preview = previewSelection(c.tests, changes, ignored, { ...(c.apiPrefix ? { apiPrefix: c.apiPrefix } : {}), notProcessed });
    // The tests the area reaches; ones whose coverage is not known are not "the same area" (a full run is the place for them).
    const picked = preview.matched.filter((t) => t.testId !== ownTestId);
    if (!picked.length) return { testIds: [], note: "No other test covers the same area." };
    const keys = picked.slice(0, 10).map((t) => t.testKey);
    return { testIds: picked.map((t) => t.testId), note: `Tests of the same area to run next: ${keys.join(", ")}${picked.length > keys.length ? ` and ${picked.length - keys.length} more` : ""}. ${RECOMMENDATION_NOTE}` };
}

/**
 * After a run (schedule-services.ts onJobFinished): a Fixed finding whose test failed in this run, or that this run found again, came
 * back. It moves to Verification pending, so verification checks it again. Returns the findings reopened.
 */
export async function reopenReturned(p: Platform, job: JobRow): Promise<CandidateFindingRecord[]> {
    const store = new CandidateFindingStore(p.sql);
    const fixed = (await store.list(job.projectId)).filter((f) => f.state === "fixed");
    if (!fixed.length) return [];
    const rows = p.repo.db.all<{ test_case_id: string; status: string }>("SELECT test_case_id, status FROM test_executions WHERE job_id = ? ORDER BY attempt, started_at", job.id);
    const last = new Map(rows.map((r) => [r.test_case_id, r.status]));
    const out: CandidateFindingRecord[] = [];
    for (const f of fixed) {
        const status = f.testId ? last.get(f.testId) : undefined;
        const failed = status === "failed" || status === "timedOut";
        if (!failed && f.lastJobId !== job.id) continue;
        const key = f.testId ? p.repo.getTest(f.testId)?.testKey : undefined;
        const why = failed ? `${key ?? "its test"} failed again in run ${job.id.slice(0, 8)}` : `run ${job.id.slice(0, 8)} found it again`;
        const moved = await store.transition(job.projectId, f.id, { to: "verification_pending", by: "engine", reason: `Reopened: the bug came back (${why}).` }).catch(() => undefined);
        if (moved) out.push(moved);
    }
    return out;
}

/**
 * A successful deployment of a pull request's head commit (code-host/webhook.ts): the findings its "Fixes #n" (in its title or commit
 * messages; the description is not read, code-host/github.ts) link to are checked on it.
 * shortcut: the attempts go to the project's own address, where the deployment is taken to have landed, and only a pull request's head
 * commit is matched (a merge commit is not traced to its pull request); upgrade with per-deployment environments and GitHub's
 * commit-to-pull-request lookup.
 */
export async function checkFixesOfDeployment(p: Platform, codeHost: CodeHostStore, projectId: string, headSha: string): Promise<{ jobId?: string; skipped?: string; refused?: Array<{ id: string; why: string }> }> {
    const ev = p.db.get<{ pr: number | string }>("SELECT pr FROM pr_events WHERE project_id = ? AND head_sha = ? AND pr IS NOT NULL ORDER BY received_at DESC LIMIT 1", projectId, headSha);
    if (!ev) return { skipped: "No pull request of this repository has this commit as its head." };
    const pr = Number(ev.pr);
    const client = codeHost.client(projectId);
    const repo = codeHost.get(projectId);
    if (!client || !repo) return { skipped: "No repository is connected to this project." };
    const [info, commits] = await Promise.all([client.pr(pr), client.commits(pr)]);
    const linked = await findingsFixedBy(p, projectId, [info.title, ...commits.map((c) => c.message)].join("\n"), repo);
    if (!linked.length) return { skipped: `Pull request #${pr} names no issue filed from a confirmed finding (“Fixes #n”).` };
    return claimFix(p, projectId, { findingIds: linked.map((f) => f.id), by: "issue", source: `pull request #${pr}`, headSha });
}
