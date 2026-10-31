/**
 * Orchestration: turning an assessment into one or more scanner runs, and their results back into the platform's own findings.
 *
 * The contract with the rest of the platform:
 *   - In: one assessment's application, the profile it runs at, the approval (if any) and the scope guard that already resolved and
 *     refused addresses. Out: `RawResult[]` in exactly the shape the platform's own read-only checks produce, so scanner findings go
 *     through the same redaction, deduplication, history and retest code (../findings/ingest.ts).
 *   - One scanner failing never fails the assessment. Each tool's outcome is recorded separately; the assessment finishes
 *     COMPLETED when everything ran and PARTIALLY_COMPLETED when a tool did not, with the plain reason in the coverage list.
 *   - A tool that is not installed, not configured, not allowed for the project or refused for the profile is reported as such and
 *     produces no findings. There is no path here where a missing tool becomes a clean result.
 *
 * The target each adapter receives is built here and nowhere else. It contains only addresses the scope guard has already pinned and
 * approved, the rate the client agreed to, the request budget, the time limit, the uploaded API document and the configured AI
 * interface. An adapter that wants anything else has to say so, not fetch it.
 */
import type { Db } from "../../../platform/db.js";
import type { SecurityApplication } from "../../contract.js";
import type { RawResult } from "../../findings/ingest.js";
import { apiDocumentText } from "../../extras.js";
import { dedupeFindings, scannerFindingToRaw } from "../normalize.js";
import { SCAN_PROFILES } from "../profiles.js";
import type { ScanApproval, ScanIntensity, ScanTarget, ScannerAdapter, ScannerCoverage, ScannerId } from "../contract.js";
import { createRun, projectScanners, updateRun, type ScanRun } from "../store.js";
import { scannerSettings, type ScannerSettings } from "../settings.js";
import { scannerHealth, usableAdapters, type ScannerHealth } from "../registry.js";

/** Where the addresses of one assessment come from. The guard has already resolved and refused them; this never widens them. */
export interface ScanTargetSource {
    /** Every in-scope address discovered for this application, already filtered by the scope guard. */
    urls: string[];
    /** The application's own origin. */
    origin: string;
}

/** One tool's outcome, for the coverage list and the assessment's own record. */
export interface ScannerRunOutcome {
    scanner: ScannerId;
    state: ScanRun["state"];
    /** Plain sentence: what happened. Never contains a key or an address with a query string. */
    reason: string;
    findings: number;
    coverage: ScannerCoverage;
    /** The tool's own run id, kept for traceability. */
    reference: string | null;
    tookMs: number;
}

export interface RunScannersInput {
    db: Db;
    application: SecurityApplication;
    assessmentId: string;
    profile: ScanIntensity;
    approval?: ScanApproval | null;
    /** Aborted on cancel, on the assessment's time limit, and when the authorization stops being current. */
    signal: AbortSignal;
    /** The addresses the scope guard allowed. */
    target: ScanTargetSource;
    settings?: ScannerSettings;
    /** Saved sign-in presented as one header. Never logged, never in evidence. */
    authHeader?: { name: string; value: string } | null;
    /** The configured AI interface, when the client set one. Without it the AI adapter refuses to run. */
    aiInterface?: ScanTarget["aiInterface"];
    onProgress?: (text: string) => void;
    log?: (event: string, data: Record<string, unknown>) => void;
    /** For tests: which adapters to use instead of building them. */
    adapters?: ScannerAdapter[];
}

export interface RunScannersResult {
    /** The platform's own results, ready for the findings pipeline. */
    results: RawResult[];
    outcomes: ScannerRunOutcome[];
    /** What was available and what was not, for the report's coverage list. */
    health: ScannerHealth[];
}

/** The target one adapter may be given, clamped to the tighter of the application's rate and the platform's ceiling. */
export function buildTarget(input: RunScannersInput, adapter: ScannerAdapter, spec: { fileName: string; text: string } | null): ScanTarget {
    const settings = input.settings ?? scannerSettings({});
    const rate = Math.max(1, Math.min(settings.maxRequestsPerSecond, input.application.maxRequestsPerSecond));
    return {
        applicationId: input.application.id,
        origin: input.target.origin,
        urls: input.target.urls,
        excludedPaths: input.application.excludedPaths,
        maxRequestsPerSecond: rate,
        requestBudget: settings.requestBudget,
        timeoutMs: settings.runTimeoutMs,
        authHeader: input.authHeader ?? null,
        // The API document is only handed to a spec-driven adapter, and only from the one the client uploaded.
        spec: adapter.capabilities.specDriven ? spec : null,
        // The AI interface is only handed to an AI-driven adapter, and only when one was configured.
        aiInterface: adapter.capabilities.aiDriven ? (input.aiInterface ?? null) : null,
    };
}

/** The uploaded API document for this application, or null. Read once per run, not per adapter. */
export function specOf(db: Db, applicationId: string): { fileName: string; text: string } | null {
    const document = apiDocumentText(db, applicationId);
    return document ? { fileName: document.summary.fileName, text: document.text } : null;
}

/**
 * Run every scanner allowed for this project at this profile, one after another, and collect the findings.
 *
 * Order matters and is fixed: ZAP (broad coverage) then nuclei (specific known problems) then schemathesis (API contract) then
 * promptfoo (AI interface). Sequential, never parallel: the client agreed to a rate, and a scan that respects its own limits cannot be
 * one that quietly opens several streams.
 */
export async function runScanners(input: RunScannersInput): Promise<RunScannersResult> {
    const settings = input.settings ?? scannerSettings({});
    const allowed = projectScanners(input.db, input.application.projectId);
    const results: RawResult[] = [];
    const outcomes: ScannerRunOutcome[] = [];
    const health = await scannerHealth(settings, allowed, input.profile, input.signal, input.adapters ? { resolve: () => input.adapters! } : {});

    if (!allowed.length) {
        // Not an error: a project that allows no scanners simply gets none, and the report says so.
        return { results, outcomes, health };
    }
    if (SCAN_PROFILES[input.profile].requiresApproval && !input.approval) {
        return {
            results,
            outcomes,
            health: health.map((h) => (h.status === "available" ? { ...h, status: "off" as const, reason: `${h.name} was not run: the ${input.profile} profile needs a recorded approval, and there was none.` } : h)),
        };
    }

    const usable = input.adapters
        ? await usableAdapters(settings, allowed, input.profile, input.signal, { resolve: () => input.adapters! })
        : await usableAdapters(settings, allowed, input.profile, input.signal);
    const spec = specOf(input.db, input.application.id);
    const observedAt = new Date().toISOString();

    for (const adapter of usable.adapters) {
        if (input.signal.aborted) break;
        const startedAt = Date.now();
        const run = createRun(input.db, { assessmentId: input.assessmentId, projectId: input.application.projectId, applicationId: input.application.id, scanner: adapter.id, profile: input.profile, approval: input.approval ?? null });
        updateRun(input.db, run.id, { state: "RUNNING", startedAt: new Date().toISOString() });
        input.onProgress?.(`Running ${adapter.name}…`);

        let handle: Awaited<ReturnType<ScannerAdapter["start"]>> | undefined;
        try {
            const target = buildTarget(input, adapter, spec);
            const scope = await adapter.validateScope(target, input.signal);
            if (!scope.ok) {
                outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", `No in-scope address could be given to ${adapter.name}.`, 0, { inspected: [], notInspected: scope.refused.slice(0, 5).map((r) => `${r.url}: ${r.reason}`) }, null, startedAt));
                continue;
            }
            handle = await adapter.start(target, input.profile, { signal: input.signal, approval: input.approval ?? null, onProgress: (p) => input.onProgress?.(`${adapter.name}: ${p.message}`), log: (event, data) => input.log?.(`${adapter.id}.${event}`, data) });
            const out = await handle.results();
            const deduped = dedupeFindings(out.findings ?? []);
            for (const finding of deduped.findings) results.push(scannerFindingToRaw(adapter.id, finding, observedAt));
            const notInspected = [...(out.coverage?.notInspected ?? [])];
            if (deduped.folded) notInspected.push(`${deduped.folded} report${deduped.folded === 1 ? "" : "s"} from ${adapter.name} repeated the same rule on the same address and were kept as one finding.`);
            if (deduped.dropped) notInspected.push(`${deduped.dropped} report${deduped.dropped === 1 ? "" : "s"} from ${adapter.name} were beyond this run's limit and were not stored.`);
            outcomes.push(finish(input.db, run.id, adapter.id, "COMPLETED", `${adapter.name} finished.`, deduped.findings.length, { inspected: out.coverage?.inspected ?? [], notInspected }, out.reference, startedAt));
            input.log?.("scanner-finished", { scanner: adapter.id, findings: deduped.findings.length, tookMs: Date.now() - startedAt });
        } catch (e) {
            // One tool failing is never the assessment failing: the reason is recorded and the next tool still runs.
            const message = scannerErrorMessage(e);
            outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", message, 0, { inspected: [], notInspected: [message] }, null, startedAt));
            input.log?.("scanner-failed", { scanner: adapter.id, error: message.slice(0, 200) });
        } finally {
            await handle?.cleanup().catch(() => undefined);
        }
    }

    // Everything that could run, did not: say so plainly in the coverage list rather than leaving a client to assume it was covered.
    for (const not of usable.unavailable) {
        if (not.status === "off" || not.status === "not-allowed") continue;
        outcomes.push({ scanner: not.id, state: "SKIPPED", reason: `${not.name} did not run: ${not.reason || "it is not available here."}`, findings: 0, coverage: { inspected: [], notInspected: [not.reason] }, reference: null, tookMs: 0 });
    }

    return { results, outcomes, health };
}

/** One run row closed out with the plain words a client reads. */
function finish(db: Db, runId: string, scanner: ScannerId, state: ScanRun["state"], reason: string, findings: number, coverage: ScannerCoverage, reference: string | null, startedAt: number): ScannerRunOutcome {
    const finishedAt = new Date().toISOString();
    const tookMs = Date.now() - startedAt;
    updateRun(db, runId, { state, reference, finishedAt, tookMs, findingsCount: findings, coverage });
    return { scanner, state, reason, findings, coverage, reference, tookMs };
}

/** A scanner's failure in one plain sentence, keeping the platform's own wording for the errors it raised itself. */
export function scannerErrorMessage(e: unknown): string {
    if (e && typeof e === "object" && "scanner" in e && "code" in e) {
        const err = e as { message?: string; code?: string };
        const suffix = err.code === "timeout" ? " (the time limit was reached)" : err.code === "cancelled" ? " (the assessment was stopped)" : "";
        return `${err.message ?? "The scanner could not finish."}${suffix}`;
    }
    const message = e instanceof Error ? e.message : String(e);
    return `The scanner could not finish: ${message.split("\n")[0]!.slice(0, 300)}`;
}

/**
 * What the report should say about a set of outcomes, in the same plain words the platform uses elsewhere: every tool that did not run,
 * and why. A client reading the report must never have to guess whether a tool that was available was actually used.
 */
export function scannerCoverageLines(outcomes: readonly ScannerRunOutcome[]): string[] {
    const lines: string[] = [];
    for (const o of outcomes) {
        if (o.state === "COMPLETED") {
            lines.push(`${o.scanner}: ${o.findings} finding${o.findings === 1 ? "" : "s"}${o.tookMs > 1_000 ? ` (${Math.round(o.tookMs / 1000)}s)` : ""}.`);
            lines.push(...o.coverage.notInspected.map((n) => `${o.scanner}: ${n}`));
        } else if (o.state === "SKIPPED") lines.push(o.reason);
        else lines.push(o.reason);
    }
    return lines;
}

/** Whether the profile this run used is the most the tool list can do, for the report's profile statement. */
export function profileStatementFor(profile: ScanIntensity, ran: readonly ScannerRunOutcome[]): string {
    const completed = ran.filter((o) => o.state === "COMPLETED").map((o) => o.scanner);
    return `Ran at the ${profile} profile. External scanners used: ${completed.length ? completed.join(", ") : "none"}.`;
}
