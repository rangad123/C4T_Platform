/**
 * Flaky-test quarantine: the rules, as pure functions (no database, no clock of their own).
 *
 * A quarantined test still runs and still stores its results; it only stops *gating* (pass rates, alerts, readiness,
 * runbook checks, sign-off, CI exit codes). Quarantine is for unreliable tests, never a way to hide a real defect, so:
 *   - a test whose purpose is a finding from a check family (security, page health, accessibility, API contract, access
 *     control, input handling, page speed, AI judgement) is never eligible;
 *   - a test that failed on every one of its last runs is not flaky, it is broken or the application is: not eligible;
 *   - a quarantine whose test starts failing every time is lifted from gating again at read time (see `gateEntries`).
 * There is deliberately no override.
 */
import { A11Y_FAILURE_PREFIX } from "../a11y/audit.js";
import { CONTRACT_FAILURE_PREFIX } from "../contracts/check.js";
import { HEALTH_FAILURE_PREFIX } from "../health/checks.js";
import { ACCESS_FAILURE_PREFIX } from "../identity/access.js";
import { INPUT_FAILURE_PREFIX } from "../inputs/checks.js";
import { LATENCY_FAILURE_PREFIX } from "../performance/latency.js";
import { LOAD_FAILURE_PREFIX } from "../performance/load.js";
import { PERFORMANCE_FAILURE_PREFIX } from "../performance/checks.js";
import { SECURITY_FAILURE_PREFIX } from "../security/checks.js";
import { VISION_FAILURE_PREFIX } from "../vision/verdict.js";
import type { TestSpec } from "../spec/schema.js";

export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 60;
export const MAX_REASON = 300;
export const MAX_BY = 80;
/** A test that failed on each of this many latest runs is a consistent failure, not a flaky test. */
export const CONSISTENT_RUNS = 5;
/** Passing this many runs in a row while quarantined suggests releasing it. */
export const STABLE_RUNS = 10;
const DAY_MS = 86_400_000;

export type QuarantineSource = "manual" | "suggested";
export type QuarantineStatus = "active" | "released" | "expired";
export type HistoryKind = "quarantined" | "released" | "expired" | "reviewed";

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// ── protected families ─────────────────────────────────────────────────────

/** Tests the platform generates as a check of one family; their failures are findings, not unreliability. */
const PROTECTED_ORIGINS = new Set(["a11y-audit", "health-check", "security-check", "performance-check", "input-check", "contract-check", "access-check", "vision-check"]);
const PROTECTED_TYPES = new Set(["security", "accessibility", "health", "performance", "input", "vision"]);
const FAMILY_PREFIXES: Array<[string, string]> = [
    [SECURITY_FAILURE_PREFIX, "security"],
    [HEALTH_FAILURE_PREFIX, "page health"],
    [A11Y_FAILURE_PREFIX, "accessibility"],
    [CONTRACT_FAILURE_PREFIX, "API contract"],
    [ACCESS_FAILURE_PREFIX, "access control"],
    [INPUT_FAILURE_PREFIX, "input handling"],
    [PERFORMANCE_FAILURE_PREFIX, "page speed"],
    [LATENCY_FAILURE_PREFIX, "API speed"],
    [LOAD_FAILURE_PREFIX, "load"],
    [VISION_FAILURE_PREFIX, "AI judgement"],
];

/** What a test needs to show for the family check: its spec and the reason of its latest failure. */
export type FamilyInput = { spec: Pick<TestSpec, "type" | "category" | "tags" | "steps" | "source">; reason?: string | null };

/** The check family a test belongs to ("security", "accessibility", ...), or undefined for an ordinary test. */
export function protectedFamily(t: FamilyInput): string | undefined {
    const { spec } = t;
    const reason = t.reason ?? "";
    for (const [prefix, family] of FAMILY_PREFIXES) if (reason.includes(prefix)) return family;
    if (/possible security issue/i.test(reason)) return "security";
    if (/accessibility audit failed/i.test(reason)) return "accessibility";
    switch (spec.source.origin) {
        case "a11y-audit": return "accessibility";
        case "health-check": return "page health";
        case "security-check": return "security";
        case "performance-check": return "page speed";
        case "input-check": return "input handling";
        case "contract-check": return "API contract";
        case "access-check": return "access control";
        case "vision-check": return "AI judgement";
    }
    if (PROTECTED_ORIGINS.has(spec.source.origin)) return "check";
    if (PROTECTED_TYPES.has(spec.type)) return spec.type === "accessibility" ? "accessibility" : spec.type;
    if (spec.steps.some((s) => s.action === "assert" && s.check === "a11y")) return "accessibility";
    if (/compliance/i.test([spec.category, ...spec.tags].join(" "))) return "compliance";
    return undefined;
}

// ── eligibility ────────────────────────────────────────────────────────────

/** The flaky signal for a test: the same numbers `detectFlaky` reports. */
export interface FlakyEvidence {
    executions: number;
    passes: number;
    fails: number;
    flips: number;
    flakyPasses: number;
}

export type EligibilityCode = "eligible" | "protected-family" | "consistent-failure" | "not-flaky";

export interface Eligibility {
    eligible: boolean;
    code: EligibilityCode;
    /** One plain sentence: why the test can be quarantined, or why not. */
    why: string;
}

/** True when the test failed on each of its latest `runs` executions (and there are that many). `recent` is oldest to newest. */
export function isConsistentFailure(recent: readonly string[], runs = CONSISTENT_RUNS): boolean {
    return recent.length >= runs && recent.slice(-runs).every((s) => s !== "passed");
}

const times = (c: number) => (c === 1 ? "once" : c === 2 ? "twice" : `${c} times`);

/** "Failed 3 of the last 10 runs, passed on re-run twice." */
export function evidenceText(e: FlakyEvidence): string {
    const parts = [`failed ${e.fails} of the last ${n(e.executions, "run")}`];
    if (e.flakyPasses > 0) parts.push(`passed on re-run ${times(e.flakyPasses)}`);
    return parts.join(", ");
}

/** What the automatic reason of a suggested entry says. */
export function autoReason(e: FlakyEvidence): string {
    const count = Math.max(e.flips, e.flakyPasses, 1);
    return `Passed and failed on identical runs ${count} times`;
}

/**
 * Eligible = the platform flags the test as flaky AND it is not a check-family test AND it did not fail every one of its
 * last runs. `recent` are the statuses of the test's latest executions of its current script, oldest to newest.
 * Order of the checks is the order of the most useful explanation.
 */
export function assessEligibility(i: FamilyInput & { evidence: FlakyEvidence | null; recent: readonly string[] }): Eligibility {
    const family = protectedFamily(i);
    if (family) return { eligible: false, code: "protected-family", why: `This is a ${family} check. Its failures are findings about the application, so it cannot be put in quarantine.` };
    if (isConsistentFailure(i.recent)) return { eligible: false, code: "consistent-failure", why: `It failed on each of its last ${CONSISTENT_RUNS} runs. That is a real problem, not flakiness, so it cannot be put in quarantine.` };
    if (!i.evidence) return { eligible: false, code: "not-flaky", why: "It has not shown a mix of passes and failures on the same script, so it is not flaky. Only unreliable tests can be put in quarantine." };
    return { eligible: true, code: "eligible", why: `It is flaky: ${evidenceText(i.evidence)}.` };
}

// ── time ───────────────────────────────────────────────────────────────────

/** Days asked for, within 1 to MAX_DAYS; the default when none. */
export function clampDays(days: number | undefined): number {
    if (days === undefined) return DEFAULT_DAYS;
    return Math.min(MAX_DAYS, Math.max(1, Math.round(days)));
}

export const expiryFrom = (sinceMs: number, days: number): string => new Date(sinceMs + clampDays(days) * DAY_MS).toISOString();

/** The latest an entry may be extended to: MAX_DAYS after it began. */
export const latestExpiry = (sinceIso: string): string => new Date(new Date(sinceIso).getTime() + MAX_DAYS * DAY_MS).toISOString();

export function isExpired(e: { status: QuarantineStatus; expiresAt: string }, nowMs: number): boolean {
    return e.status === "active" && new Date(e.expiresAt).getTime() <= nowMs;
}

export const daysLeft = (expiresAt: string, nowMs: number): number => Math.max(0, Math.ceil((new Date(expiresAt).getTime() - nowMs) / DAY_MS));

// ── release suggestion ─────────────────────────────────────────────────────

export interface ReleaseSuggestion {
    suggest: boolean;
    /** Passing runs in a row, counted from the newest. */
    passedInARow: number;
    text: string | null;
}

/** `sinceQuarantine`: the statuses of the executions made while the test was in quarantine, oldest to newest. */
export function suggestRelease(sinceQuarantine: readonly string[], k = STABLE_RUNS): ReleaseSuggestion {
    let streak = 0;
    for (let i = sinceQuarantine.length - 1; i >= 0 && sinceQuarantine[i] === "passed"; i--) streak++;
    const suggest = streak >= k;
    return { suggest, passedInARow: streak, text: suggest ? `Passed its last ${k} runs. Stable again: release it from quarantine?` : null };
}

// ── the gating set ─────────────────────────────────────────────────────────

/** One quarantine that is currently in force. */
export interface GateEntry {
    id: string;
    projectId: string;
    testId: string;
    testKey: string;
    title: string;
    /** The test's validation status now (VALIDATED, NEEDS_REVIEW, FAILED_VALIDATION, ...). */
    testStatus: string;
    reason: string;
    since: string;
    expiresAt: string;
}

/**
 * The one answer to "does this test decide anything right now?". Every place that gates on a test's result asks this.
 * `has` is true only while the test is quarantined and still eligible to be.
 */
export interface QuarantineGate {
    readonly size: number;
    has(testId: string): boolean;
    get(testId: string): GateEntry | undefined;
    forProject(projectId: string): GateEntry[];
}

export function makeGate(entries: readonly GateEntry[]): QuarantineGate {
    const byTest = new Map(entries.map((e) => [e.testId, e]));
    const byProject = new Map<string, GateEntry[]>();
    for (const e of entries) (byProject.get(e.projectId) ?? byProject.set(e.projectId, []).get(e.projectId)!).push(e);
    return { size: byTest.size, has: (id) => byTest.has(id), get: (id) => byTest.get(id), forProject: (pid) => byProject.get(pid) ?? [] };
}

export const NO_GATE: QuarantineGate = makeGate([]);

/**
 * From the entries stored as active and not expired, the ones that still gate nothing: drops a test that is now a check-family
 * test or now fails every run. `recentByTest` are the latest execution statuses per test, oldest to newest.
 */
export function gateEntries(entries: ReadonlyArray<{ entry: GateEntry; test: FamilyInput }>, recentByTest: ReadonlyMap<string, readonly string[]>): GateEntry[] {
    return entries
        .filter((e) => !protectedFamily(e.test) && !isConsistentFailure(recentByTest.get(e.entry.testId) ?? []))
        .map((e) => e.entry);
}

// ── wording ────────────────────────────────────────────────────────────────

/** "(2 quarantined tests ignored)" appended to messages about counts. */
export const ignoredNote = (count: number): string => `(${n(count, "quarantined test")} ignored)`;
/** "2 quarantined tests are not counted" for the dashboard and overview. */
export const notCountedText = (count: number): string => `${n(count, "quarantined test")} ${count === 1 ? "is" : "are"} not counted`;
export const QUARANTINE_ENDED = "Quarantine ended; this test counts again.";
