/**
 * Security Assessment module: the shapes every part of src/security agrees on.
 *
 * The module is separate from functional testing (own tables, routes, jobs, pages, reports). It may use shared platform infrastructure
 * (projects, people and roles, Activity, the database, report export, the read-only discovery code) but functional testing never imports
 * src/security, and SECURITY_ASSESSMENT=off leaves functional testing exactly as it is.
 *
 * Scope of this module: passive, read-only assessment of an application its owner authorized: ordinary requests a normal visitor's
 * browser makes, read and judged for configuration problems. Findings can also be entered by hand (from the client's own tools).
 * Change this file only additively, and say so in your report.
 */

export const ENVIRONMENTS = ["development", "staging", "production", "other"] as const;
export type SecurityEnvironment = (typeof ENVIRONMENTS)[number];

/** An application registered for assessment. Belongs to one project (the tenant boundary). */
export interface SecurityApplication {
    id: string;
    projectId: string;
    name: string;
    targetUrl: string;
    environment: SecurityEnvironment;
    /** Extra authorized origins or host patterns ("https://api.example.com", "*.example.com"). The target's own origin is always in scope. */
    scope: string[];
    /** Path prefixes never requested ("/admin/billing"). */
    excludedPaths: string[];
    /** Most requests per second the assessment may send (1-10, default 2). */
    maxRequestsPerSecond: number;
    apiSpecUrl: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
    /**
     * Round 20 (SIGN), additive. The saved sign-in the assessment loads ("main" = the project's own, or a test account's name), or null to
     * visit as an anonymous visitor. The assessment never types a password or submits a sign-in form. Part of the scope fingerprint.
     */
    signInAccount?: string | null;
    /** Workflows never requested (always excluded like `excludedPaths`), shown in the statement, the assessment and the report. Part of the fingerprint. */
    sensitiveWorkflows?: SensitiveWorkflow[];
    /** The uploaded API document (OpenAPI / Swagger), summarized; its text is never returned. */
    apiDocument?: ApiDocumentSummary | null;
}

/** A part of the application that must never be touched (payments, account deletion …): its path prefixes are never requested. */
export interface SensitiveWorkflow {
    name: string;
    pathPrefixes: string[];
    note: string | null;
}

/** What the platform tells about an uploaded API document (never its text). */
export interface ApiDocumentSummary {
    fileName: string;
    format: "json" | "yaml";
    sizeBytes: number;
    sha256: string;
    title: string | null;
    version: string | null;
    /** Every operation the document lists. */
    operations: number;
    /** GET operations without required parameters: the only ones an assessment may request (through the scope guard). */
    requestable: number;
    uploadedAt: string;
    uploadedBy: string;
}

/**
 * The recorded authorization. No assessment starts without a current one. It is tied to a fingerprint of the target, scope and
 * exclusions: any change to those makes it stale and a new confirmation is needed.
 */
export interface SecurityAuthorization {
    id: string;
    applicationId: string;
    /** "owner" (we own it) or "client-permission" (the owner gave documented permission). */
    basis: "owner" | "client-permission";
    approverName: string;
    approverEmail: string | null;
    /** Free text: reference to the engagement letter or permission document. */
    documentReference: string | null;
    restrictions: string | null;
    confirmedByUserId: string | null;
    confirmedByName: string;
    confirmedAt: string;
    scopeFingerprint: string;
    revokedAt: string | null;
}

/**
 * Additive (SCAN): how much the assessment is allowed to do. "passive" is what every assessment made before this change, and remains
 * the default, so an existing row keeps its meaning. The two higher levels are refused without the stated conditions (see
 * src/security/scanners/profiles.ts) and are stored so a report can say which level produced it.
 */
export const ASSESSMENT_KINDS = ["passive", "conservative-active", "advanced"] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];

export const ASSESSMENT_STATES = ["QUEUED", "DISCOVERING", "SCANNING", "VALIDATING", "GENERATING_REPORT", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"] as const;
export type AssessmentState = (typeof ASSESSMENT_STATES)[number];
export const FINISHED_STATES: readonly AssessmentState[] = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"];

export interface SecurityAssessment {
    id: string;
    applicationId: string;
    projectId: string;
    authorizationId: string;
    /** The profile this assessment runs at. Existing rows read back as "passive", which is what they always were. */
    kind: AssessmentKind;
    /** Additive (SCAN): the recorded approval covering an intrusive profile, when there is one. Never contains a credential. */
    approval?: {
        profile: AssessmentKind;
        approvedByUserId: string;
        approvedByName: string;
        approvedAt: string;
        environment: string;
        statement: string;
    } | null;
    state: AssessmentState;
    /** 0-100 and a plain sentence of what is happening now. */
    progress: number;
    progressText: string;
    /** What was looked at and what could not be: never presented as complete when it was not. */
    coverage: { pagesSeen: number; formsSeen: number; apiCallsSeen: number; notInspected: string[] } | null;
    error: string | null;
    startedBy: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /** Set when this run re-checks earlier findings. */
    retestOf: string | null;
}

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];
export const VALIDATION_STATES = ["confirmed", "probable", "needs-review", "false-positive", "fixed", "accepted-risk"] as const;
export type ValidationState = (typeof VALIDATION_STATES)[number];
/**
 * Additive (SCAN): the last seven are what external scanners report. The passive checks keep their own eight; a scanner maps its
 * taxonomy onto these (src/security/scanners/normalize.ts), so one vocabulary reaches the store, the API and the report.
 */
export const CATEGORIES = [
    "headers",
    "cookies",
    "tls",
    "cors",
    "exposed-files",
    "information-disclosure",
    "configuration",
    "other",
    "injection",
    "xss",
    "ssrf",
    "path-traversal",
    "access-control",
    "secrets",
    "ai-security",
] as const;
export type FindingCategory = (typeof CATEGORIES)[number];

/** Evidence is observed fact (a header as received, a status code), redacted before it is stored. */
export interface Evidence {
    kind: "response-header" | "cookie" | "status" | "body-excerpt" | "tls" | "note";
    label: string;
    value: string;
    observedAt: string;
}

export interface SecurityFinding {
    id: string;
    projectId: string;
    applicationId: string;
    /** The assessment that found it first, and the last one that saw it. */
    firstAssessmentId: string | null;
    lastAssessmentId: string | null;
    /** Stable key for deduplication: category + check + normalized location. */
    fingerprint: string;
    title: string;
    category: FindingCategory;
    severity: Severity;
    confidence: Confidence;
    location: string;
    description: string;
    impact: string;
    remediation: string;
    reproduction: string | null;
    evidence: Evidence[];
    /**
     * "built-in" for the platform's own read-only checks, "manual" for findings entered by a person, and (additive, SCAN) "external"
     * for a finding an external scanner reported. `checkId` then holds the tool's own rule id and the evidence keeps the tool's own
     * reference, so the original stays available for review and nothing a scanner said is ever presented as verified.
     */
    source: "built-in" | "manual" | "external";
    /** Anything an AI model suggested is kept apart from evidence and never makes a finding confirmed. */
    aiNote: string | null;
    validation: ValidationState;
    firstSeenAt: string;
    lastSeenAt: string;
}
