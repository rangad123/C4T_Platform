/**
 * The scanner adapter contract: what every external security tool the platform drives must be able to do, in one typed place.
 *
 * An adapter is a thin, stateless wrapper around ONE real tool. It knows how to find that tool, how to configure it, how to hand it a
 * scope the platform already checked, how to follow and stop it, and how to turn its output into `ScannerFinding`s. It never decides
 * what is in scope, never invents findings, and never reports success for a tool it could not run.
 *
 * The contract, part by part:
 *   availability + version ....... available()
 *   configuration validation ..... validateConfig()
 *   scan-profile compatibility ... supports(profile)
 *   scope validation ............. validateScope(target) -> ScannerScopeCheck
 *   starting a scan .............. start(target, profile, options)
 *   progress (where supported) ... ScanHandle.progress()
 *   cancelling (where supported) . ScanHandle.cancel()
 *   structured results ........... ScanHandle.results()
 *   normalized errors ............ ScannerError / ScannerErrorCode
 *   cleaning up .................. ScanHandle.cleanup() (always called, never throws)
 *
 * Safety rules every adapter keeps (enforced by tests and by ./process.ts, not by good intentions):
 *   - No shell. Every tool is started with an argument array; nothing anybody typed is ever concatenated into a command line.
 *   - No new destinations. An adapter only ever receives the addresses in `ScanTarget.urls`, which src/security/scope.ts has already
 *     resolved, pinned and refused where needed. An adapter that wants a different address must say so, not fetch it.
 *   - No secrets outward. API keys stay in the process environment of the tool or in the server's config; they are never in findings,
 *     never in evidence and never in an answer to the browser.
 *   - Honest state. A tool that is not installed is `unavailable`; a tool that is installed but has nothing to connect to is
 *     `not_configured`. Neither ever produces findings.
 */

import type { Confidence, Evidence, FindingCategory, Severity } from "../contract.js";

/** Stable ids of the scanners this module knows. Adding one is additive. */
export const SCANNER_IDS = ["zap", "nuclei", "schemathesis", "promptfoo"] as const;
export type ScannerId = (typeof SCANNER_IDS)[number];

/** How much a scanner is allowed to do. Every adapter must answer `supports` truthfully; the platform never runs a tool above this. */
export const SCAN_INTENSITIES = ["passive", "conservative-active", "advanced"] as const;
export type ScanIntensity = (typeof SCAN_INTENSITIES)[number];

/**
 * What the platform can tell about a tool right now. `available` is the only state that lets a scan start.
 *
 *   available       the tool answered: it is installed, configured and usable here.
 *   unavailable     not installed (or its runtime is missing). `reason` names what to install and where to put it.
 *   not_configured  installed but nothing tells it where to run or how to authenticate (no API key, no address).
 *   misconfigured   installed and configured, but the configuration does not work (bad API key, version refused, too old).
 *   unknown         it could not be checked right now (a timeout, a locked file). Never treated as available.
 */
export const SCANNER_STATES = ["available", "unavailable", "not_configured", "misconfigured", "unknown"] as const;
export type ScannerState = (typeof SCANNER_STATES)[number];

export interface ScannerAvailability {
    scanner: ScannerId;
    state: ScannerState;
    /** The tool's own version string when it answered ("v3.11.1", "2.16.1"). */
    version?: string;
    /** One plain sentence a person can act on. Never contains a key, a token or a password. */
    reason?: string;
    /** What to install or set, when the state is not `available`. */
    remedy?: string;
    checkedAt: string;
    /** How long the check took, so a slow tool is visible. */
    tookMs?: number;
}

export const isUsable = (a: ScannerAvailability): boolean => a.state === "available";

/** How an adapter can be driven. An adapter that cannot do something says so here rather than throwing later. */
export interface ScannerCapabilities {
    progress: boolean;
    cancel: boolean;
    /** The tool serves many scans from one long-lived process (a ZAP daemon). */
    sharedDaemon: boolean;
    /** The tool needs a document, not a set of pages (an OpenAPI file for Schemathesis). */
    specDriven: boolean;
    /** The tool evaluates an AI interface with test cases, not a website (Promptfoo). */
    aiDriven: boolean;
}

/** The outcome of `validateConfig`: problems are plain sentences, never raw tool output with keys in it. */
export interface ConfigCheck {
    ok: boolean;
    /** Plain problems, most important first. Empty when `ok`. */
    problems: string[];
    /** What was checked and answered, for the scanner health page. Never secrets. */
    checked: string[];
}

export type ScopeRefusalCode = "out-of-scope" | "excluded-path" | "no-targets" | "refused-address" | "unsupported-scheme";

export interface ScannerScopeCheck {
    ok: boolean;
    /** The addresses the adapter may actually hand to the tool (already filtered). */
    allowed: string[];
    /** `{ url, code, reason }` for every address that was taken out, with the reason. */
    refused: Array<{ url: string; code: ScopeRefusalCode; reason: string }>;
}

/**
 * Everything an adapter is allowed to touch for one scan. Built by src/security/scanners/orchestration/run.ts from the assessment's
 * application and the platform's scope guard; an adapter never builds one itself.
 */
export interface ScanTarget {
    applicationId: string;
    /** The site's own origin. */
    origin: string;
    /** Every address the tool may request. Already scope-checked, DNS-pinned and stripped of refusals. */
    urls: string[];
    /** Path prefixes the tool must never request (excluded paths and sensitive workflows). */
    excludedPaths: string[];
    /** Most requests a second the tool may send. The platform clamps this again inside the tool's own rate limit. */
    maxRequestsPerSecond: number;
    /** Most requests the whole scan may send, across every tool. */
    requestBudget: number;
    /** Hard time limit for this scan in ms. The tool is stopped when it passes. */
    timeoutMs: string | number extends never ? never : number;
    /**
     * A saved sign-in to present, as one header. Only ever sent to addresses inside `urls`. Never logged, never in evidence.
     * Kept out of the findings pipeline on purpose: `redactText` hides it again, but it should not get that far.
     */
    authHeader?: { name: string; value: string } | null;
    /** The uploaded API document as text, for spec-driven tools. The adapter writes it to a secure temporary file if its tool needs one. */
    spec?: { fileName: string; text: string } | null;
    /** For AI tools: the interface to evaluate. Required before an AI scanner may run at all. */
    aiInterface?: AiInterface | null;
}

/**
 * What an AI application actually exposes. The platform never guesses this from a page: a scan of an AI interface starts only when
 * somebody has configured one of these, because there is no supported way to test a model's internals from outside.
 */
export interface AiInterface {
    kind: "http-chat" | "openai-compatible";
    /** Where requests go. Must be inside the scan scope. */
    url: string;
    /** "openai-compatible": the model name to send. */
    model?: string | null;
    /** The message the evaluation cases are substituted into. */
    messageTemplate?: string | null;
    /** How to present the saved sign-in to the model endpoint, when it needs one. */
    authHeader?: { name: string; value: string } | null;
}

export const SCANNER_ERROR_CODES = ["not_configured", "unavailable", "invalid_config", "profile_unsupported", "out_of_scope", "timeout", "cancelled", "budget_exceeded", "tool_failed", "internal"] as const;
export type ScannerErrorCode = (typeof SCANNER_ERROR_CODES)[number];

/** Every adapter's failure in the platform's own words. `detail` keeps the tool's message for the log; it never reaches a report. */
export class ScannerError extends Error {
    constructor(
        readonly code: ScannerErrorCode,
        readonly scanner: ScannerId,
        message: string,
        readonly detail?: string,
        /**
         * The failure this one was raised from, kept so a caller can still tell WHY after the message has been rewritten in the
         * platform's own words (a refused connection from a closed ZAP API reads the same as one from a stopped daemon unless the
         * cause survives). Never sent anywhere: it holds the tool's own error, not a client's data.
         */
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "ScannerError";
    }
}

export const isScannerError = (e: unknown): e is ScannerError => e instanceof ScannerError;

/** A finding as an external tool reports it, before the platform's wording, category mapping and redaction. */
export interface ScannerFinding {
    /** The tool's own identifier for the rule that fired (a nuclei template id, a ZAP alert id, a Schemathesis test). */
    scannerRuleId: string;
    title: string;
    /** Already normalized to the platform's five severities by the adapter. */
    severity: Severity;
    /** Already mapped to the platform's finding categories by the adapter. */
    category: FindingCategory;
    /** Where it was seen. Always one of `ScanTarget.urls`, or a path on them. */
    url: string;
    /** What the tool observed, in plain words. Redacted before it is stored. */
    description: string;
    /** The tool's own evidence: the request it sent and the answer it got. Redacted before it is stored. */
    evidence: Array<Pick<Evidence, "kind" | "label"> & { value: string }>;
    /** The tool's remediation text, when it has one. */
    remediation?: string;
    /** What an attacker could do. Adapters that cannot say this leave it out; the report says so. */
    impact?: string;
    /** The tool's links (CWE, its own documentation). Shown as evidence, never fetched by the platform. */
    references?: string[];
    /** The tool's own confidence hint, when it has one. */
    confidence?: Confidence;
    /** The tool's CWE id ("CWE-79"), when it has one. */
    cwe?: string;
    observedAt?: string;
}

/** What one run of one tool actually looked at, and what it did not. Never a claim of completeness the run cannot support. */
export interface ScannerCoverage {
    /** Plain sentences: what this run looked at. */
    inspected: string[];
    /** Plain sentences: what this run could not or did not cover. A report prints these as the tool's limitations. */
    notInspected: string[];
}

export interface ScanProgress {
    /** 0-100. Adapters whose tool cannot report progress return 0 until they finish, and `capabilities.progress` is false. */
    percent: number;
    /** One plain sentence of what is happening now. */
    message: string;
    done: boolean;
}

export interface ScanResultSet {
    findings: ScannerFinding[];
    coverage: ScannerCoverage;
    /** The tool's own run identifier (a ZAP scan id, a nuclei run id), kept with the scan run for traceability. */
    reference: string | null;
}

/** The recorded human approval a profile that may change data needs before a scan may start. */
export interface ScanApproval {
    profile: ScanIntensity;
    approvedByUserId: string;
    approvedByName: string;
    approvedAt: string;
    /** The environment the approval covers ("staging", "production", ...). An approval for staging does not cover production. */
    environment: string;
    /** The exact sentence the person confirmed, stored in the audit trail. */
    statement: string;
}

export interface StartOptions {
    /** Aborted on cancel, on the assessment's time limit and when the authorization stops being current. */
    signal: AbortSignal;
    /** The approval a profile that needs one required. The adapter must refuse to start without it. */
    approval?: ScanApproval | null;
    /** Progress for the assessment's own progress line. */
    onProgress?: (progress: ScanProgress) => void;
    /** Secret-free structured logging (ids, counts, exit codes: never addresses with queries, keys or bodies). */
    log?: (event: string, data: Record<string, unknown>) => void;
}

/** A started scan. `cleanup()` is always called, in a `finally`, and must never throw. */
export interface ScanHandle {
    readonly scanner: ScannerId;
    /** Set as soon as the tool reports its own run id. */
    readonly reference: string | null;
    progress(): Promise<ScanProgress>;
    /** Ask the tool to stop. Returns when it has stopped or has been killed. Never throws. */
    cancel(): Promise<void>;
    /** The findings this run produced. Safe to call once, after the tool has finished. */
    results(): Promise<ScanResultSet>;
    /** Release processes, files and ports. Always called; never throws. */
    cleanup(): Promise<void>;
}

/** One external security tool, driven by the platform. */
export interface ScannerAdapter {
    readonly id: ScannerId;
    /** The tool's own name, as its project writes it. */
    readonly name: string;
    /** Where the tool is documented. Printed in the adapter documentation. */
    readonly documentationUrl: string;
    readonly capabilities: ScannerCapabilities;
    /** The words a person should see next to the tool's name. */
    readonly description: string;

    /** Is the tool here and usable? Must not throw: a scanner that cannot be checked returns `state: "unknown"` with the reason. */
    available(signal?: AbortSignal): Promise<ScannerAvailability>;
    /** Is the configuration complete and correct? Checks values; does not start a scan. */
    validateConfig(signal?: AbortSignal): Promise<ConfigCheck>;
    /** May this tool run at this intensity? */
    supports(profile: ScanIntensity): boolean;
    /** Which of the target's addresses may the tool be given, and why the others were taken out. */
    validateScope(target: ScanTarget, signal?: AbortSignal): Promise<ScannerScopeCheck>;

    /**
     * Start one scan. Returns as soon as the tool is running; follow it with `progress()`, `results()` and `cleanup()`.
     * Throws `ScannerError` with a code from `SCANNER_ERROR_CODES`, never a raw tool error.
     */
    start(target: ScanTarget, profile: ScanIntensity, options: StartOptions): Promise<ScanHandle>;
}

/** The adapter's own view of one tool's exit: the plain words the platform shows, plus the tool's own text for the log. */
export function toolFailed(scanner: ScannerId, what: string, detail: string): ScannerError {
    return new ScannerError("tool_failed", scanner, `The ${what} could not be finished by the scanner.`, detail);
}
