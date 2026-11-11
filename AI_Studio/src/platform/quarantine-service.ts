/**
 * Quarantine rules applied to real data: who may be quarantined, what to suggest, what a quarantined test looks like, and how a
 * job's numbers read once quarantined tests are left out. The pure rules live in `engine/quarantine/rules.ts`; storage and the
 * gating set in `quarantine-store.ts`.
 */
import {
    assessEligibility,
    autoReason,
    daysLeft,
    DEFAULT_DAYS,
    evidenceText,
    MAX_DAYS,
    MAX_REASON,
    suggestRelease,
    type Eligibility,
    type FlakyEvidence,
    type QuarantineGate,
    type QuarantineSource,
    type ReleaseSuggestion,
} from "../engine/quarantine/rules.js";
import { HttpError } from "./http-error.js";
import { quarantineGate, recentExecutions, type HistoryRow, type QuarantineEntry, type QuarantineStore } from "./quarantine-store.js";
import type { Repo, TestRow } from "./repo.js";
import { collectResults, detectFlaky, type FlakyTest, type TestResult } from "./trends.js";
import type { JobRow } from "./repo.js";

const toEvidence = (f: FlakyTest | undefined): FlakyEvidence | null => (f ? { executions: f.executions, passes: f.passes, fails: f.fails, flips: f.flips, flakyPasses: f.flakyPasses } : null);

/** Flaky tests of a project by test id (the same detection the Flaky tab uses). */
function flakyById(repo: Repo, projectId: string): Map<string, FlakyTest> {
    return new Map(detectFlaky(repo.db, projectId, 1000).map((f) => [f.id, f]));
}

export function eligibilityOf(repo: Repo, test: TestRow, flaky: Map<string, FlakyTest> = flakyById(repo, test.projectId)): { eligibility: Eligibility; evidence: FlakyEvidence | null } {
    const evidence = toEvidence(flaky.get(test.id));
    const recent = (recentExecutions(repo.db, [test.id]).get(test.id) ?? []).map((p) => p.status);
    return { eligibility: assessEligibility({ spec: test.spec, reason: test.validationReason, evidence, recent }), evidence };
}

export interface Suggestion {
    testId: string;
    testKey: string;
    title: string;
    evidence: string;
    stats: FlakyEvidence;
    suggestedReason: string;
    lastRunAt: string;
}

/** Flaky tests that may be quarantined and are not yet. The platform never quarantines by itself: a person confirms. */
export function suggestionsFor(repo: Repo, store: QuarantineStore, projectId: string): Suggestion[] {
    const already = new Set(store.list(projectId, "active").map((e) => e.testId));
    const out: Suggestion[] = [];
    const flaky = flakyById(repo, projectId);
    for (const f of flaky.values()) {
        if (already.has(f.id)) continue;
        const test = repo.getTest(f.id);
        if (!test) continue;
        const { eligibility, evidence } = eligibilityOf(repo, test, flaky);
        if (!eligibility.eligible || !evidence) continue;
        out.push({ testId: f.id, testKey: f.testKey, title: f.title, evidence: capitalise(evidenceText(evidence)), stats: evidence, suggestedReason: autoReason(evidence), lastRunAt: f.lastRunAt });
    }
    return out;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface QuarantineInput {
    testId: string;
    reason?: string;
    days?: number;
    by: string;
    /** True when the person is confirming a suggestion. */
    suggested?: boolean;
}

/** Put a flaky test in quarantine. Refused with a plain reason (409) when it is not eligible; there is no override. */
export function quarantineTest(repo: Repo, store: QuarantineStore, projectId: string, input: QuarantineInput): QuarantineEntry {
    const test = repo.getTest(input.testId);
    if (!test || test.projectId !== projectId) throw new HttpError(404, "Test not found in this project");
    const { eligibility, evidence } = eligibilityOf(repo, test);
    if (!eligibility.eligible) throw new HttpError(409, eligibility.why, { code: eligibility.code });
    const typed = (input.reason ?? "").trim();
    const source: QuarantineSource = input.suggested || !typed ? "suggested" : "manual";
    const reason = typed || autoReason(evidence!);
    return store.create({ projectId, testId: test.id, testKey: test.testKey, title: test.title, reason, source, by: input.by, days: input.days }, evidence ? { ...evidence } : undefined);
}

export interface EntryView extends QuarantineEntry {
    daysLeft: number;
    /** False when the entry exists but the test counts again (it now fails every run, or turned out to be a check). */
    gating: boolean;
    note: string | null;
    release: ReleaseSuggestion;
}

export function viewEntry(repo: Repo, entry: QuarantineEntry, gate: QuarantineGate, nowMs: number): EntryView {
    const test = repo.getTest(entry.testId);
    let note: string | null = null;
    const gating = entry.status === "active" && gate.has(entry.testId);
    if (entry.status === "active" && !gating && test) {
        const { eligibility } = eligibilityOf(repo, test);
        if (eligibility.code === "protected-family" || eligibility.code === "consistent-failure") note = `${eligibility.why} It counts again.`;
    }
    const since = recentExecutions(repo.db, [entry.testId]).get(entry.testId) ?? [];
    const release = entry.status === "active" ? suggestRelease(since.filter((p) => p.at >= entry.since).map((p) => p.status)) : { suggest: false, passedInARow: 0, text: null };
    return { ...entry, daysLeft: entry.status === "active" ? daysLeft(entry.expiresAt, nowMs) : 0, gating, note, release };
}

export interface ProjectQuarantine {
    active: EntryView[];
    ended: EntryView[];
    suggestions: Suggestion[];
    /** "2 tests are in quarantine and not counted." or null. */
    summary: string | null;
    limits: { defaultDays: number; maxDays: number; maxReason: number };
}

export function projectView(repo: Repo, store: QuarantineStore, projectId: string, nowMs: number): ProjectQuarantine {
    const gate = quarantineGate(repo.db, nowMs, projectId);
    const all = store.list(projectId);
    const active = all.filter((e) => e.status === "active").map((e) => viewEntry(repo, e, gate, nowMs));
    const counting = active.filter((e) => e.gating).length;
    return {
        active,
        ended: all.filter((e) => e.status !== "active").slice(0, 20).map((e) => viewEntry(repo, e, gate, nowMs)),
        suggestions: suggestionsFor(repo, store, projectId),
        summary: counting ? `${counting} ${counting === 1 ? "test is" : "tests are"} in quarantine and not counted.` : null,
        limits: { defaultDays: DEFAULT_DAYS, maxDays: MAX_DAYS, maxReason: MAX_REASON },
    };
}

export interface TestQuarantine {
    entry: EntryView | null;
    eligible: boolean;
    code: string;
    why: string;
    evidence: string | null;
    suggestedReason: string | null;
    /** The last entry that ended, so the page can say "Quarantine ended; this test counts again." */
    lastEnded: EntryView | null;
    history: HistoryRow[];
}

export function testView(repo: Repo, store: QuarantineStore, test: TestRow, nowMs: number): TestQuarantine {
    const gate = quarantineGate(repo.db, nowMs, test.projectId);
    const active = store.activeFor(test.id);
    const history = store.history(test.projectId, { testId: test.id, limit: 50 });
    const lastEnded = store.list(test.projectId).find((e) => e.testId === test.id && e.status !== "active");
    const { eligibility, evidence } = eligibilityOf(repo, test);
    return {
        entry: active ? viewEntry(repo, active, gate, nowMs) : null,
        eligible: !active && eligibility.eligible,
        code: active ? "quarantined" : eligibility.code,
        why: active ? "This test is in quarantine." : eligibility.why,
        evidence: evidence ? capitalise(evidenceText(evidence)) : null,
        suggestedReason: evidence ? autoReason(evidence) : null,
        lastEnded: !active && lastEnded ? viewEntry(repo, lastEnded, gate, nowMs) : null,
        history,
    };
}

// ── jobs ───────────────────────────────────────────────────────────────────

export interface JobGating {
    /** The job's results for tests that are in quarantine. */
    held: TestResult[];
    passed: number;
    failed: number;
}

/**
 * The quarantined tests among a job's results; null when the project has none in force (so callers keep their old numbers).
 * Only tests that were really executed in the job count.
 */
export function gateJob(repo: Repo, job: JobRow, gate: QuarantineGate = quarantineGate(repo.db, Date.now(), job.projectId)): JobGating | null {
    if (gate.forProject(job.projectId).length === 0) return null;
    const held = collectResults(repo, job, gate).filter((r) => r.q);
    if (held.length === 0) return null;
    return { held, passed: held.filter((r) => r.s === "p").length, failed: held.filter((r) => r.s !== "p").length };
}
