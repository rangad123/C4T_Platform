/**
 * The result of a CI run in one neutral shape. Every output (console, JSON, SARIF, HTML, Markdown, JUnit,
 * PR comment) is rendered from this, so they can never disagree with each other.
 */
import { HEALTH_FAILURE_PREFIX } from "../engine/health/checks.js";
import { CONTRACT_FAILURE_PREFIX } from "../engine/contracts/check.js";
import { ACCESS_FAILURE_PREFIX } from "../engine/identity/access.js";
import { INPUT_FAILURE_PREFIX } from "../engine/inputs/checks.js";
import { VISION_FAILURE_PREFIX } from "../engine/vision/verdict.js";
import { PERFORMANCE_FAILURE_PREFIX } from "../engine/performance/checks.js";
import { LATENCY_FAILURE_PREFIX } from "../engine/performance/latency.js";
import { LOAD_FAILURE_PREFIX } from "../engine/performance/load.js";
import { SECURITY_FAILURE_PREFIX } from "../engine/security/checks.js";
import { SEVERITIES, type Severity } from "../engine/validation/severity.js";
import type { ApiClient } from "./client.js";
import type { FailOn } from "./args.js";
import { PHONE_ANR_PREFIX, PHONE_CRASH_PREFIX, PHONE_SLOW_START_PREFIX } from "../engine/mobile/quality/findings.js";

export const REPORT_SCHEMA_VERSION = 1;

export type TestOutcome = "passed" | "finding" | "failed" | "not_run";

export interface EvidenceItem {
    kind: "screenshot" | "visual-diff" | "visual-actual" | "vision-shot" | "video" | "trace";
    /** Path under --evidence-dir, when evidence was saved. */
    file?: string;
    /** In memory only (never in the JSON report): used to inline screenshots in the HTML report. */
    data?: Buffer;
}

export interface CiTest {
    /** Platform id (use it with the API). */
    id: string;
    /** Human key, like WEB-001. */
    testId: string;
    title: string;
    suite: string;
    kind: string;
    type: string;
    priority: string;
    outcome: TestOutcome;
    /** The platform's own status: VALIDATED, NEEDS_REVIEW, FAILED_VALIDATION, PENDING. */
    validation: string;
    severity?: Severity;
    severityBasis?: string;
    /** Why it is a finding or failed, without terminal colour codes. */
    reason?: string;
    category?: FindingCategory;
    durationMs: number;
    attempts: number;
    failedStep?: { number: number; title: string };
    /** Link to the test in the platform (remote mode). */
    link?: string;
    /** Set while the test is in quarantine: it still runs and is reported, but its failure decides nothing. */
    quarantine?: { reason: string; expiresAt: string };
    evidence: EvidenceItem[];
}

export type FindingCategory = "security" | "security-check" | "page-health" | "performance" | "load" | "input-handling" | "ai-judgement" | "api-contract" | "access-control" | "server-error" | "accessibility" | "visual-change" | "functional-defect" | "app-crash";

export interface GateResult {
    failOn: FailOn;
    failOnFailedValidation: boolean;
    passed: boolean;
    /** Plain sentences saying why the gate failed (empty when it passed). */
    reasons: string[];
    exitCode: 0 | 1;
}

export interface CiSummary {
    total: number;
    passed: number;
    findings: number;
    failedValidation: number;
    notRun: number;
    bySeverity: Record<Severity, number>;
    /** Quarantined tests that did not pass: left out of `findings`, `failedValidation` and the gate. Present only when there are some. */
    quarantined?: number;
}

export interface CiReport {
    schemaVersion: typeof REPORT_SCHEMA_VERSION;
    tool: { name: "ai-test"; version: string };
    generatedAt: string;
    mode: "replay" | "analyze" | "remote-replay" | "remote-analyze" | "remote-rerun";
    target: string;
    /** Set when the run was against a named environment of the project (`--env`). */
    environment?: string;
    project: { name: string; id?: string };
    durationMs: number;
    summary: CiSummary;
    gate: GateResult;
    tests: CiTest[];
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function cleanReason(reason: string | null | undefined): string | undefined {
    const text = (reason ?? "")
        .replace(ANSI, "")
        .replace(/\s*\(automatic repair skipped: no LLM configured\)/, "")
        .trim();
    return text ? text.slice(0, 1500) : undefined;
}

export function categorize(reason: string | undefined): FindingCategory {
    const r = reason ?? "";
    // A model-written problem text could contain any phrase below, so the AI-judgement prefix is checked first.
    if (r.includes(VISION_FAILURE_PREFIX)) return "ai-judgement";
    if (/possible security issue/i.test(r)) return "security";
    // The platform's passive security-header / exposed-file checks and page-health checks tag their failures with these prefixes.
    if (r.includes(SECURITY_FAILURE_PREFIX)) return "security-check";
    if (r.includes(HEALTH_FAILURE_PREFIX)) return "page-health";
    if (r.includes(LOAD_FAILURE_PREFIX)) return "load";
    if (r.includes(PERFORMANCE_FAILURE_PREFIX) || r.includes(LATENCY_FAILURE_PREFIX)) return "performance";
    if (r.includes(INPUT_FAILURE_PREFIX)) return "input-handling";
    if (r.includes(CONTRACT_FAILURE_PREFIX)) return "api-contract";
    if (r.includes(ACCESS_FAILURE_PREFIX)) return "access-control";
    // Phone quality checks: crashes and freezes; a slow cold start is a speed finding; phone accessibility falls to "accessibility" below.
    if (r.startsWith(PHONE_CRASH_PREFIX) || r.startsWith(PHONE_ANR_PREFIX)) return "app-crash";
    if (r.startsWith(PHONE_SLOW_START_PREFIX)) return "performance";
    if (/server error/i.test(r)) return "server-error";
    if (/accessibility/i.test(r)) return "accessibility";
    if (/^visual change/i.test(r)) return "visual-change";
    return "functional-defect";
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** True when a finding of this severity trips `--fail-on`. */
export function meetsThreshold(severity: Severity, failOn: FailOn): boolean {
    if (failOn === "none") return false;
    if (failOn === "any") return true;
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[failOn];
}

export function evaluateGate(tests: CiTest[], failOn: FailOn, failOnFailedValidation: boolean): GateResult {
    const reasons: string[] = [];
    const blocking = tests.filter((t) => t.outcome === "finding" && !t.quarantine && meetsThreshold(t.severity ?? "medium", failOn));
    if (blocking.length) {
        const worst = blocking.map((t) => t.severity ?? "medium").sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0]!;
        const label = failOn === "any" ? "any severity" : `${failOn} or higher`;
        reasons.push(`${blocking.length} finding${blocking.length === 1 ? "" : "s"} at ${label} severity (worst: ${worst}).`);
    }
    const failed = tests.filter((t) => t.outcome === "failed" && !t.quarantine);
    if (failOnFailedValidation && failed.length) reasons.push(`${failed.length} test${failed.length === 1 ? "" : "s"} could not be validated (the test failed, which may mean the application is broken or the test is out of date).`);
    return { failOn, failOnFailedValidation, passed: reasons.length === 0, reasons, exitCode: reasons.length ? 1 : 0 };
}

/** A quarantined test that did not pass: reported, but it decides nothing. */
export const isQuarantinedFailure = (t: CiTest): boolean => Boolean(t.quarantine) && (t.outcome === "finding" || t.outcome === "failed");

export function summarize(tests: CiTest[]): CiSummary {
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const t of tests) if (t.outcome === "finding" && t.severity && !t.quarantine) bySeverity[t.severity]++;
    const held = tests.filter(isQuarantinedFailure).length;
    return {
        total: tests.length,
        passed: tests.filter((t) => t.outcome === "passed").length,
        findings: tests.filter((t) => t.outcome === "finding" && !t.quarantine).length,
        failedValidation: tests.filter((t) => t.outcome === "failed" && !t.quarantine).length,
        notRun: tests.filter((t) => t.outcome === "not_run").length,
        bySeverity,
        ...(held ? { quarantined: held } : {}),
    };
}

interface ApiTestSummary {
    id: string;
    testId: string;
    title: string;
    suite: string;
    kind: string;
    type: string;
    priority: string;
    validationStatus: string;
    validationReason: string | null;
    severity: { severity: Severity; basis: string } | null;
    attempts: number;
    quarantine?: { reason: string; expiresAt: string };
}
interface ApiTestDetail {
    executions: Array<{ durationMs: number | null; steps: Array<{ index: number; title: string; status: string }>; artifacts: Array<{ id: string; kind: string }> }>;
}

const IMAGE_KINDS = new Set(["screenshot", "visual-diff", "visual-actual", "vision-shot"]);
const FILE_KINDS = new Set(["video", "trace"]);
/** Videos can be large; evidence is for humans looking at a failure, not an archive. */
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

export interface CollectOptions {
    /** Also fetch videos and traces (only useful when they will be saved to a folder). */
    files: boolean;
    /** Base address to build links to tests; omit when there is no reachable UI. */
    platformUrl?: string;
}

/** Read the final state of a project's tests (and the evidence of those that need attention) through the API. */
export async function collectTests(client: ApiClient, projectId: string, opts: CollectOptions): Promise<CiTest[]> {
    const summaries = await client.json<ApiTestSummary[]>("GET", `/projects/${projectId}/tests`);
    const out: CiTest[] = [];
    for (const s of summaries) {
        const outcome: TestOutcome = s.validationStatus === "VALIDATED" ? "passed" : s.validationStatus === "NEEDS_REVIEW" ? "finding" : s.validationStatus === "FAILED_VALIDATION" ? "failed" : "not_run";
        const test: CiTest = {
            id: s.id,
            testId: s.testId,
            title: s.title,
            suite: s.suite,
            kind: s.kind,
            type: s.type,
            priority: s.priority,
            outcome,
            validation: s.validationStatus,
            reason: outcome === "passed" || outcome === "not_run" ? undefined : cleanReason(s.validationReason),
            durationMs: 0,
            attempts: s.attempts,
            evidence: [],
            ...(opts.platformUrl ? { link: `${opts.platformUrl.replace(/\/+$/, "")}/#/tests/${s.id}` } : {}),
            ...(s.quarantine ? { quarantine: { reason: s.quarantine.reason, expiresAt: s.quarantine.expiresAt } } : {}),
        };
        if (outcome === "finding") {
            test.severity = s.severity?.severity ?? "medium";
            test.severityBasis = s.severity?.basis;
            test.category = categorize(test.reason);
        }
        if (outcome !== "not_run") {
            const detail = await client.json<ApiTestDetail>("GET", `/tests/${s.id}`);
            const last = detail.executions[0];
            test.durationMs = last?.durationMs ?? 0;
            const failed = last?.steps.find((x) => x.status === "failed");
            if (failed) test.failedStep = { number: failed.index + 1, title: failed.title };
            if (last && outcome !== "passed") {
                for (const a of last.artifacts) {
                    const image = IMAGE_KINDS.has(a.kind);
                    if (!image && !(opts.files && FILE_KINDS.has(a.kind))) continue;
                    try {
                        const data = await client.bytes(`/artifacts/${a.id}`);
                        if (data.length <= MAX_EVIDENCE_BYTES) test.evidence.push({ kind: a.kind as EvidenceItem["kind"], data });
                    } catch {
                        /* evidence that vanished is not worth failing the run for */
                    }
                }
            }
        }
        out.push(test);
    }
    return out;
}
