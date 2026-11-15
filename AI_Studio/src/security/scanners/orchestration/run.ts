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
import { egressCoverage, egressTargetProblem, startEgressGuard, type EgressGuard } from "../../egress/guard.js";
import { isolationSupport, proveIsolation, setIsolationFor, startIsolatedEgress, type IsolatedEgress, type IsolationSupport } from "../../egress/isolation.js";
import type { Resolver } from "../../scope.js";

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
    /**
     * The assessment's start gate judged now (store.ts gateCheck): why it may no longer run, or undefined. Asked before the scanners
     * start and before each one, so a withdrawn or expired approval, a replaced authorization or the switch turned off stops the next tool.
     */
    gateRefusal?: () => string | undefined;
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
    /**
     * Options for the request guard every scanner's traffic goes through (../../egress/guard.ts). Always used for the adapters the
     * platform builds, whatever is passed here; with injected test `adapters` only when this is set. Private targets follow
     * `allowPrivateTargets` (the platform's loaded SECURITY_ALLOW_PRIVATE_TARGETS) unless `allowPrivate` says otherwise.
     */
    egress?: false | { allowPrivate?: boolean; port?: number; resolver?: Resolver; isolation?: IsolationSupport };
    /**
     * SECURITY_ALLOW_PRIVATE_TARGETS as the platform loaded it (SecuritySettings.allowPrivateTargets), the same answer its own checks use:
     * never read from the process environment here, so the two cannot disagree. Absent: private targets are refused.
     */
    allowPrivateTargets?: boolean;
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
    const refusedNow = input.gateRefusal?.();
    if (refusedNow) {
        return { results, outcomes, health: health.map((h) => (h.status === "available" ? { ...h, status: "off" as const, reason: `${h.name} was not run: ${refusedNow}` } : h)) };
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
    // Every adapter the platform builds goes through the request guard. Injected test doubles (`adapters`) send nothing of their own,
    // so for them the guard is used only when the caller asks for it with `egress`.
    const enforce = input.adapters ? Boolean(input.egress) : true;
    const egressOptions = input.egress || {};
    const allowPrivate = egressOptions.allowPrivate ?? input.allowPrivateTargets ?? false;
    // Above passive the guard alone is not enough: the scanners must run where they cannot reach anything but the guard, and that is
    // proved from their own context before any of them starts (../../egress/isolation.ts). No proof, no scanner.
    const isolate = enforce && input.profile !== "passive";
    let isolationLine: string | undefined;
    let support: IsolationSupport | undefined;
    if (isolate && usable.adapters.length) {
        support = egressOptions.isolation ?? isolationSupport();
        const proof = egressTargetProblem(input.target)
            ? undefined
            : await proveIsolation(support, { app: input.application, origin: input.target.origin, allowPrivate, signal: input.signal, ...(egressOptions.port ? { port: egressOptions.port } : {}), ...(egressOptions.resolver ? { resolver: egressOptions.resolver } : {}) });
        if (proof && !proof.ok) {
            for (const adapter of usable.adapters) {
                const run = createRun(input.db, { assessmentId: input.assessmentId, projectId: input.application.projectId, applicationId: input.application.id, scanner: adapter.id, profile: input.profile, approval: input.approval ?? null });
                outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", proof.reason, 0, { inspected: [], notInspected: [proof.reason] }, null, Date.now()));
            }
            input.log?.("scanner-isolation-refused", { reason: proof.reason.slice(0, 200) });
            return { results, outcomes, health };
        }
        isolationLine = proof?.line;
    }

    for (const adapter of usable.adapters) {
        if (input.signal.aborted) break;
        const startedAt = Date.now();
        const refused = input.gateRefusal?.();
        if (refused) {
            const why = `${adapter.name} was not run: ${refused}`;
            const stopped = createRun(input.db, { assessmentId: input.assessmentId, projectId: input.application.projectId, applicationId: input.application.id, scanner: adapter.id, profile: input.profile, approval: input.approval ?? null });
            outcomes.push(finish(input.db, stopped.id, adapter.id, "FAILED", why, 0, { inspected: [], notInspected: [why] }, null, startedAt));
            continue;
        }
        const run = createRun(input.db, { assessmentId: input.assessmentId, projectId: input.application.projectId, applicationId: input.application.id, scanner: adapter.id, profile: input.profile, approval: input.approval ?? null });
        updateRun(input.db, run.id, { state: "RUNNING", startedAt: new Date().toISOString() });
        input.onProgress?.(`Running ${adapter.name}…`);

        let handle: Awaited<ReturnType<ScannerAdapter["start"]>> | undefined;
        let guard: EgressGuard | undefined;
        let iso: IsolatedEgress | undefined;
        // The request guard's record joins whatever coverage this run ends with, success or failure.
        const guarded = (coverage: ScannerCoverage): ScannerCoverage => {
            if (!guard) return coverage;
            const g = egressCoverage(adapter.name, guard);
            return { inspected: [...coverage.inspected, ...(iso && isolationLine ? [isolationLine] : []), ...g.inspected], notInspected: [...coverage.notInspected, ...g.notInspected], requestLog: g.requestLog };
        };
        try {
            const target = buildTarget(input, adapter, spec);
            const scope = await adapter.validateScope(target, input.signal);
            if (!scope.ok) {
                outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", `No in-scope address could be given to ${adapter.name}.`, 0, { inspected: [], notInspected: scope.refused.slice(0, 5).map((r) => `${r.url}: ${r.reason}`) }, null, startedAt));
                continue;
            }
            if (enforce) {
                const problem = egressAdapterProblem(adapter) ?? egressTargetProblem(target) ?? (isolate ? isolationAdapterProblem(adapter) : undefined);
                if (problem) {
                    outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", problem, 0, { inspected: [], notInspected: [problem] }, null, startedAt));
                    continue;
                }
                // Above passive a tool runs isolated or not at all: never on the plain guard below, whatever an earlier check let through.
                if (isolate && !support?.ok) {
                    const why = `${adapter.name} was not run: above passive a scanner runs only where it can reach nothing but the request guard, and that could not be set up here.`;
                    outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", why, 0, { inspected: [], notInspected: [why] }, null, startedAt));
                    continue;
                }
                try {
                    const guardOptions = {
                        source: `scanner:${adapter.id}`,
                        app: { ...input.application, maxRequestsPerSecond: target.maxRequestsPerSecond },
                        allowPrivate,
                        maxRequests: target.requestBudget,
                        signal: input.signal,
                        ...(egressOptions.port !== undefined ? { port: egressOptions.port } : {}),
                        ...(egressOptions.resolver ? { resolver: egressOptions.resolver } : {}),
                    };
                    if (isolate) {
                        if (!support?.ok) throw new Error("the isolated network is not available");
                        // The guard listens on a Unix socket only; the adapter starts its tool with `isolationFor(target).wrap`.
                        iso = await startIsolatedEgress(support, guardOptions);
                        guard = iso.guard;
                        setIsolationFor(target, iso);
                    } else guard = await startEgressGuard(guardOptions);
                } catch (e) {
                    const why = `${adapter.name} was not run: the platform's request guard could not be started (${(e as Error).message.split("\n")[0]!.slice(0, 120)}), so the scan was refused.`;
                    outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", why, 0, { inspected: [], notInspected: [why] }, null, startedAt));
                    continue;
                }
                target.egress = { proxyUrl: guard.url };
            }
            handle = await adapter.start(target, input.profile, { signal: input.signal, approval: input.approval ?? null, onProgress: (p) => input.onProgress?.(`${adapter.name}: ${p.message}`), log: (event, data) => input.log?.(`${adapter.id}.${event}`, data) });
            const out = await handle.results();
            if (guard && guard.counts().allowed === 0) {
                // A tool that finished without one request through the guard either did nothing or went round it; one whose every request
                // the guard refused (or that failed) reached nothing. Either way its results cannot be shown to come from allowed requests
                // only, so they are not used.
                const sent = guard.counts().total;
                const why = sent
                    ? `${adapter.name} had none of its ${sent} request${sent === 1 ? "" : "s"} allowed by the platform's request guard, so nothing was inspected through it. Its results were not used.`
                    : `${adapter.name} sent no request through the platform's request guard, so its traffic cannot be shown to have stayed within GET, HEAD and OPTIONS on in-scope addresses. Its results were not used.`;
                outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", why, 0, guarded({ inspected: [], notInspected: [why] }), out.reference ?? null, startedAt));
                input.log?.("scanner-failed", { scanner: adapter.id, error: "no request through the request guard" });
                continue;
            }
            const deduped = dedupeFindings(out.findings ?? []);
            for (const finding of deduped.findings) results.push(scannerFindingToRaw(adapter.id, finding, observedAt));
            const notInspected = [...(out.coverage?.notInspected ?? [])];
            if (deduped.folded) notInspected.push(`${deduped.folded} report${deduped.folded === 1 ? "" : "s"} from ${adapter.name} repeated the same rule on the same address and were kept as one finding.`);
            if (deduped.dropped) notInspected.push(`${deduped.dropped} report${deduped.dropped === 1 ? "" : "s"} from ${adapter.name} were beyond this run's limit and were not stored.`);
            outcomes.push(finish(input.db, run.id, adapter.id, "COMPLETED", `${adapter.name} finished.`, deduped.findings.length, guarded({ inspected: out.coverage?.inspected ?? [], notInspected }), out.reference, startedAt));
            input.log?.("scanner-finished", { scanner: adapter.id, findings: deduped.findings.length, tookMs: Date.now() - startedAt });
        } catch (e) {
            // One tool failing is never the assessment failing: the reason is recorded and the next tool still runs.
            const message = scannerErrorMessage(e);
            outcomes.push(finish(input.db, run.id, adapter.id, "FAILED", message, 0, guarded({ inspected: [], notInspected: [message] }), null, startedAt));
            input.log?.("scanner-failed", { scanner: adapter.id, error: message.slice(0, 200) });
        } finally {
            await handle?.cleanup().catch(() => undefined);
            await (iso ? iso.close() : guard?.close())?.catch(() => undefined);
        }
    }

    // Everything that could run, did not: say so plainly in the coverage list rather than leaving a client to assume it was covered.
    for (const not of usable.unavailable) {
        if (not.status === "off" || not.status === "not-allowed") continue;
        outcomes.push({ scanner: not.id, state: "SKIPPED", reason: `${not.name} did not run: ${not.reason || "it is not available here."}`, findings: 0, coverage: { inspected: [], notInspected: [not.reason] }, reference: null, tookMs: 0 });
    }

    return { results, outcomes, health };
}

/** Why this adapter cannot be run through the request guard, or undefined when it can. */
export function egressAdapterProblem(adapter: ScannerAdapter): string | undefined {
    if (adapter.capabilities.egressProxy === true) return undefined;
    if (adapter.capabilities.aiDriven)
        return `${adapter.name} was not run: it sends its test messages to the AI interface with POST, and the platform's request guard allows only GET, HEAD and OPTIONS.`;
    return `${adapter.name} was not run: it cannot be configured to send its requests through the platform's request guard.`;
}

/**
 * Why this adapter cannot run in the isolated network a profile above passive needs, or undefined when it can: its tool must be a
 * process the adapter starts itself, with `isolationFor(target).wrap` (`capabilities.egressIsolation`). A shared daemon (ZAP) runs
 * wherever it was started, so its direct network access cannot be blocked from here.
 */
export function isolationAdapterProblem(adapter: ScannerAdapter): string | undefined {
    if (adapter.capabilities.egressIsolation === true && !adapter.capabilities.sharedDaemon) return undefined;
    if (adapter.capabilities.sharedDaemon)
        return `${adapter.name} was not run: it runs as a separate service that the platform does not start, so it cannot be placed in the isolated network that profiles above passive need, and its direct access to the target cannot be blocked.`;
    return `${adapter.name} was not run: it does not yet start its tool inside the isolated network that profiles above passive need, so its direct access to the target cannot be blocked.`;
}

/** One run row closed out with the plain words a client reads. */
function finish(db: Db, runId: string, scanner: ScannerId, state: ScanRun["state"], reason: string, findings: number, coverage: ScannerCoverage, reference: string | null, startedAt: number): ScannerRunOutcome {
    const finishedAt = new Date().toISOString();
    const tookMs = Date.now() - startedAt;
    // A failed run keeps its reason, so the scans list and the report can say why (it said "(no reason given)" before).
    updateRun(db, runId, { state, reference, finishedAt, tookMs, findingsCount: findings, coverage, ...(state === "FAILED" ? { error: reason.slice(0, 500) } : {}) });
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
