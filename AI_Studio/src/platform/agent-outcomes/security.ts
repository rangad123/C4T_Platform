/**
 * The Security Testing Agent's outcome (SPEC §3), read from what its runs saved:
 *
 *   checks    each check its runs made or ran: test meta `security` (headers, cookies, CORS and HTTPS; exposed files and version banners)
 *             and meta `access` (pages and API calls that must stay closed to lesser accounts and visitors), with its result and the
 *             state of the finding its problem became
 *   findings  the verified ones only (Phase 5 lifecycle: reproduced, confirmed, classified, reported), each with its reproduction: the
 *             check's steps and how many verification replays failed the same way
 *
 * Tests without those metas are another agent's and are left out. The Security Assessment module keeps its own findings; the web links
 * to it and nothing of it is repeated here.
 */
import { reproduction } from "../../engine/findings/classify.js";
import { STATE_LABEL, type FindingState } from "../../engine/findings/lifecycle.js";
import { accessFinding } from "../../engine/identity/access.js";
import { securityFinding } from "../../engine/security/specs.js";
import type { ScriptRun } from "../../engine/validation/runner.js";
import { redactText } from "../../shared/redact-text.js";
import type { Platform } from "../bootstrap.js";
import { CandidateFindingStore, type CandidateFindingRecord } from "../candidate-finding-store.js";
import type { Row } from "../db.js";
import { fromCandidate } from "../findings/adapters.js";
import type { TestRow } from "../repo.js";
import type { AgentOutcomeModule } from "./types.js";

export type SecurityArea = "access" | "headers" | "exposure";
export type CheckResult = "passed" | "problem" | "could-not-check" | "not-run";

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
}

/** Verified: the engine reproduced it, then it may have been confirmed, classified and reported (engine/findings/lifecycle.ts). */
export const VERIFIED_STATES: readonly FindingState[] = ["reproduced", "confirmed", "classified", "reported"];

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
async function securityOutcome(p: Platform, projectId: string, runIds: readonly string[], run?: string): Promise<SecurityOutcome> {
    const tests = testsOfRuns(p, projectId, runIds, (t) => areaOf(t) !== undefined);
    const findingOf = await findingsOfTests(p, projectId, new Set(tests.map((t) => t.id)));
    const checks: SecurityCheckItem[] = [];
    const findings: SecurityFindingItem[] = [];
    for (const t of tests) {
        const area = areaOf(t)!;
        const own = run ? resultInRun(p, t, run) : undefined;
        const result = own?.result ?? RESULT[t.validationStatus] ?? "not-run";
        const f = findingOf.get(t.id);
        const verified = f !== undefined && VERIFIED_STATES.includes(f.state);
        checks.push({
            testId: t.id,
            testKey: t.testKey,
            title: t.title,
            area,
            result,
            reason: own ? own.reason : result === "problem" || result === "could-not-check" ? redactText(t.validationReason ?? "", 600) || null : null,
            finding: f ? { id: f.id, state: f.state, label: STATE_LABEL[f.state], verified } : null,
        });
        if (!verified) continue;
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
    return { runs: runIds.length, checks, findings };
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const outcome: AgentOutcomeModule<SecurityOutcome> = {
    outcome: (ctx) => securityOutcome(ctx.p, ctx.projectId, ctx.runs.map((j) => j.id)),
    runOutcome: (ctx, jobId) => securityOutcome(ctx.p, ctx.projectId, [jobId], jobId),
    headline: (o) => {
        if (!o.checks.length) return null;
        const passed = `${o.checks.filter((c) => c.result === "passed").length} of ${counted(o.checks.length, "check")} passed`;
        return o.findings.length ? `${counted(o.findings.length, "verified finding")}, ${passed}` : `${passed}, no verified findings`;
    },
};
