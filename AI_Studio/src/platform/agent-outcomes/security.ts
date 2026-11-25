/**
 * The Security Testing Agent's outcome (SPEC §3), read from what its runs saved:
 *
 *   checks    each check its runs made or ran: test meta `security` (headers, cookies, CORS and HTTPS; exposed files and version banners)
 *             and meta `access` (pages and API calls that must stay closed to lesser accounts and visitors), with its result, the
 *             state of the finding its problem became, and the newest of the runs that made or ran it
 *   problems  a rule-based check's failure is a fact, as an axe rule is for Accessibility: each "- [severity]" line of its message,
 *             with what was requested; counted whatever its finding's state. An access problem depends on the accounts' state, so it
 *             counts once verified, else as not verified yet. A rule-based problem a person marked "not a bug" is dismissed: listed,
 *             never counted (as Accessibility, dismissedTests)
 *   findings  the verified access problems only (VERIFIED_STATES), each with its reproduction: the check's steps and how many
 *             verification replays failed the same way
 *
 * Tests without those metas are another agent's and are left out. The Security Assessment module keeps its own findings; the web links
 * to it and nothing of it is repeated here.
 */
import { reproduction } from "../../engine/findings/classify.js";
import { worstTag } from "../../engine/health/checks.js";
import { STATE_LABEL, type FindingState } from "../../engine/findings/lifecycle.js";
import { accessFinding, parseAccessReason } from "../../engine/identity/access.js";
import { securityFinding } from "../../engine/security/specs.js";
import type { ScriptRun } from "../../engine/validation/runner.js";
import { redactText } from "../../shared/redact-text.js";
import type { Platform } from "../bootstrap.js";
import { CandidateFindingStore, type CandidateFindingRecord } from "../candidate-finding-store.js";
import type { Row } from "../db.js";
import { fromCandidate } from "../findings/adapters.js";
import type { TestRow } from "../repo.js";
import { dismissedTests } from "./accessibility.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";

export type SecurityArea = "access" | "headers" | "exposure";
export type CheckResult = "passed" | "problem" | "could-not-check" | "not-run";
export type Severity = "critical" | "high" | "medium" | "low";

export interface SecurityCheckItem {
    testId: string;
    testKey: string;
    title: string;
    area: SecurityArea;
    result: CheckResult;
    /** Why it found a problem or could not check, in the run's words. */
    reason: string | null;
    /** The finding its problem became: its state in words, `verified` when it is one of `findings`. */
    finding: { id: string; state: FindingState; label: string; verified: boolean } | null;
    /** The worst of its problems; an access problem's from its finding, else its message. Null unless it found a problem. */
    severity: Severity | null;
    /** A rule-based check's problems, in its message's words (what came back); empty for an access check. */
    problems: Array<{ severity: Severity; text: string }>;
    /** What it requested, as "GET /path". */
    requested: string[];
    /** The newest of the agent's runs that made or ran it: its link opens that run. */
    jobId: string | null;
    /** A rule-based problem a person marked "not a bug": who said so and why. It is listed and never counted. */
    dismissed: string | null;
}

export interface SecurityFindingItem {
    id: string;
    testId: string;
    testKey: string;
    title: string;
    area: SecurityArea;
    state: FindingState;
    label: string;
    severity: string | null;
    expected: string;
    observed: string;
    /** How to see it again: the check's steps in its own words. */
    steps: string[];
    /** Verification replays that failed the same way, of all of them. */
    reproduced: { same: number; of: number };
    firstSeenAt: string;
}

export interface SecurityOutcome {
    runs: number;
    checks: SecurityCheckItem[];
    findings: SecurityFindingItem[];
    /** Rule-based problems and verified access findings by severity; access problems not verified yet apart. */
    counts: Record<Severity, number> & { notVerified: number };
}

/**
 * Verified, for every agent: confirmed (by the engine at high confidence, or a person), then classified and reported
 * (engine/findings/lifecycle.ts). Reproduced alone is not yet.
 */
export const VERIFIED_STATES: readonly FindingState[] = ["confirmed", "classified", "reported"];
const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

/** The "- [severity] problem." lines of a rule-based check's message. */
function problemsOf(reason: string): SecurityCheckItem["problems"] {
    return reason.split("\n").flatMap((l) => {
        const m = /^- \[(critical|high|medium|low)\] (.+)$/.exec(l.trim());
        return m ? [{ severity: m[1] as Severity, text: m[2]! }] : [];
    });
}

const HEADER_CHECKS = new Set(["securityHeaders", "cookieFlags", "corsPolicy", "tlsCertificate"]);

/** The check's area, or undefined for a test that is not the security agent's. */
export function areaOf(t: Pick<TestRow, "generationMeta" | "spec">): SecurityArea | undefined {
    if (t.generationMeta?.access === true) return "access";
    if (t.generationMeta?.security !== true) return undefined;
    const check = t.spec.steps.find((s) => s.action === "assertResponse") as { check?: string } | undefined;
    return check?.check && HEADER_CHECKS.has(check.check) ? "headers" : "exposure";
}

/**
 * The project's tests that `keep` picks and one of these runs made or ran (a later run re-runs the tests the shared memory carried
 * over), in the tests list's order.
 */
export function testsOfRuns(p: Platform, projectId: string, runIds: readonly string[], keep: (t: TestRow) => boolean): TestRow[] {
    if (!runIds.length) return [];
    const runs = new Set(runIds);
    const ran = new Set(
        p.repo.db
            .all<Row>(`SELECT DISTINCT e.test_case_id AS id FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ? AND e.job_id IN (${runIds.map(() => "?").join(",")})`, projectId, ...runIds)
            .map((r) => String(r.id)),
    );
    return p.repo.listTests(projectId).filter((t) => !t.unreadable && ((t.jobId !== null && runs.has(t.jobId)) || ran.has(t.id)) && keep(t));
}

/** Each test's newest finding among these (CandidateFindingStore.list answers newest seen first). */
export async function findingsOfTests(p: Platform, projectId: string, testIds: ReadonlySet<string>): Promise<Map<string, CandidateFindingRecord>> {
    const out = new Map<string, CandidateFindingRecord>();
    for (const r of await new CandidateFindingStore(p.sql).list(projectId)) if (r.testId && testIds.has(r.testId) && !out.has(r.testId)) out.set(r.testId, r);
    return out;
}

const RESULT: Partial<Record<string, CheckResult>> = { VALIDATED: "passed", NEEDS_REVIEW: "problem", FAILED_VALIDATION: "could-not-check" };

/**
 * What a check found in one run, from that run's own last execution of it, judged as the validator judges a failed run: a finding is the
 * check's own message (security or access), anything else could not check. Undefined when that run holds the check's newest execution:
 * the check's current result (the validator's verdict, repairs included) is then that run's.
 */
function resultInRun(p: Platform, t: TestRow, jobId: string): { result: CheckResult; reason: string | null } | undefined {
    const db = p.repo.db;
    const runs = db.all<Row>(`SELECT id, job_id, status, error FROM test_executions WHERE test_case_id = ? AND variant IS NULL AND environment IS NULL ORDER BY started_at DESC, ${db.dialect.insertionOrder()} DESC`, t.id);
    const mine = runs.find((e) => e.job_id === jobId);
    if (!mine) return { result: "not-run", reason: null };
    if (mine === runs[0]) return undefined;
    if (mine.status === "passed") return { result: "passed", reason: null };
    const steps = db.all<Row>("SELECT idx, title, status, error FROM test_execution_steps WHERE execution_id = ? ORDER BY idx", mine.id).map((x) => ({ index: Number(x.idx), title: String(x.title), status: String(x.status), ...(x.error ? { error: String(x.error) } : {}) }));
    const run = { status: mine.status, steps, error: mine.error ?? undefined } as unknown as ScriptRun;
    const found = securityFinding(t.spec, run) ?? accessFinding(t.spec, run);
    return { result: found ? "problem" : "could-not-check", reason: redactText(found ?? String(mine.error ?? steps.find((x) => x.status === "failed")?.error ?? ""), 600) || null };
}

/** The outcome over these runs; with `run`, that one run's part, each check as that run found it. */
async function securityOutcome(ctx: AgentOutcomeCtx, runIds: readonly string[], run?: string): Promise<SecurityOutcome> {
    const { p, projectId } = ctx;
    const notABug = await dismissedTests(ctx);
    const tests = testsOfRuns(p, projectId, runIds, (t) => areaOf(t) !== undefined);
    const findingOf = await findingsOfTests(p, projectId, new Set(tests.map((t) => t.id)));
    const ranIn = new Set(
        runIds.length ? p.repo.db.all<Row>(`SELECT DISTINCT job_id, test_case_id FROM test_executions WHERE job_id IN (${runIds.map(() => "?").join(",")})`, ...runIds).map((r) => `${r.job_id} ${r.test_case_id}`) : [],
    );
    const checks: SecurityCheckItem[] = [];
    const findings: SecurityFindingItem[] = [];
    const counts = { critical: 0, high: 0, medium: 0, low: 0, notVerified: 0 };
    for (const t of tests) {
        const area = areaOf(t)!;
        const own = run ? resultInRun(p, t, run) : undefined;
        const result = own?.result ?? RESULT[t.validationStatus] ?? "not-run";
        const f = findingOf.get(t.id);
        const verified = f !== undefined && VERIFIED_STATES.includes(f.state);
        const reason = own ? own.reason : result === "problem" || result === "could-not-check" ? redactText(t.validationReason ?? "", 1500) || null : null;
        const problems = result === "problem" && area !== "access" ? problemsOf(reason ?? "") : [];
        // An access message's severity defaults to low, as parseAccessReason judges it.
        const severity = result !== "problem" ? null : area === "access" ? ((SEVERITIES as readonly string[]).includes(f?.severity ?? "") ? (f!.severity as Severity) : (parseAccessReason(reason ?? "") ?? "low")) : (worstTag(reason ?? "") ?? null);
        const dismissed = result === "problem" && area !== "access" ? (notABug.get(t.id) ?? null) : null;
        if (area !== "access") for (const x of dismissed ? [] : problems) counts[x.severity]++;
        else if (severity) verified ? counts[severity]++ : counts.notVerified++;
        checks.push({
            testId: t.id,
            testKey: t.testKey,
            title: t.title,
            area,
            result,
            reason,
            finding: f ? { id: f.id, state: f.state, label: STATE_LABEL[f.state], verified } : null,
            severity,
            problems,
            requested: t.spec.steps.flatMap((s) => (s.action === "request" ? [`${s.method} ${s.path}`] : [])),
            jobId: runIds.find((r) => r === t.jobId || ranIn.has(`${r} ${t.id}`)) ?? null,
            dismissed,
        });
        if (!verified || area !== "access") continue;
        const v = fromCandidate(f, { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta });
        findings.push({
            id: f.id,
            testId: t.id,
            testKey: t.testKey,
            title: t.title,
            area,
            state: f.state,
            label: STATE_LABEL[f.state],
            severity: f.severity,
            expected: v.expected.text,
            observed: v.observed,
            steps: t.spec.steps.map((s) => redactText(s.description || s.action, 300)),
            reproduced: reproduction(v.attempts),
            firstSeenAt: f.firstSeenAt,
        });
    }
    return { runs: runIds.length, checks, findings, counts };
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const outcome: AgentOutcomeModule<SecurityOutcome> = {
    outcome: (ctx) => securityOutcome(ctx, ctx.runs.map((j) => j.id)),
    runOutcome: (ctx, jobId) => securityOutcome(ctx, [jobId], jobId),
    headline: (o) => {
        if (!o.checks.length) return null;
        const parts = SEVERITIES.flatMap((s) => (o.counts[s] ? [`${o.counts[s]} ${s}`] : []));
        if (o.counts.notVerified) parts.push(`${counted(o.counts.notVerified, "access problem")} not verified yet`);
        return [...parts, `${o.checks.filter((c) => c.result === "passed").length} of ${counted(o.checks.length, "check")} passed`].join(", ");
    },
};
