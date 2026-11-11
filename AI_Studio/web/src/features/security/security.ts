/**
 * Security Assessment (round 18): the words, routes and small data helpers every security page uses.
 *
 * The shapes come from src/security/contract.ts (imported as types only, so nothing of the server is bundled). Answers the pages read
 * beyond the contract (the overview, the status, the authorization state) are typed here with every extra field optional: a field the
 * server does not send is simply not shown.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { useFetch } from "../../lib/hooks";
import type { Tone } from "../../lib/labels";
import type {
    AssessmentState,
    Confidence,
    FindingCategory,
    SecurityApplication,
    SecurityAssessment,
    SecurityAuthorization,
    SecurityEnvironment,
    SecurityFinding,
    Severity,
    ValidationState,
} from "../../../../src/security/contract";

export type { ApiDocumentSummary, AssessmentState, Confidence, Evidence, FindingCategory, SecurityApplication, SecurityAssessment, SecurityAuthorization, SecurityEnvironment, SecurityFinding, SensitiveWorkflow, Severity, ValidationState } from "../../../../src/security/contract";

/** Every security route lives under this prefix (the `api` helper adds `/api`). */
export const SEC = "/v1/security";

// ── the lists the server also has (kept in step with src/security/contract.ts) ──
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
export const VALIDATION_ORDER: ValidationState[] = ["needs-review", "probable", "confirmed", "accepted-risk", "false-positive", "fixed"];
export const CATEGORY_ORDER: FindingCategory[] = ["headers", "cookies", "tls", "cors", "exposed-files", "information-disclosure", "configuration", "injection", "xss", "ssrf", "path-traversal", "access-control", "secrets", "ai-security", "other"];
export const ENVIRONMENT_ORDER: SecurityEnvironment[] = ["development", "staging", "production", "other"];
export const RUNNING_STATES: AssessmentState[] = ["QUEUED", "DISCOVERING", "SCANNING", "VALIDATING", "GENERATING_REPORT"];
export const isRunning = (s: AssessmentState | undefined | null) => !!s && RUNNING_STATES.includes(s);

// ── words ─────────────────────────────────────────────────────────────────────
export const SEVERITY_WORDS: Record<Severity, { label: string; tone: Tone }> = {
    critical: { label: "Critical", tone: "danger" },
    high: { label: "High", tone: "danger" },
    medium: { label: "Medium", tone: "warning" },
    low: { label: "Low", tone: "neutral" },
    info: { label: "Information", tone: "info" },
};

export const VALIDATION_WORDS: Record<ValidationState, { label: string; tone: Tone; help: string }> = {
    "needs-review": { label: "Needs a look", tone: "warning", help: "Nobody has checked this finding yet, or it was seen again after being marked fixed." },
    probable: { label: "Probable", tone: "warning", help: "The evidence points to a real problem; a person has not confirmed it yet." },
    confirmed: { label: "Confirmed", tone: "danger", help: "A person checked it and it is a real problem." },
    "accepted-risk": { label: "Risk accepted", tone: "neutral", help: "A real problem the client decided to live with, for a stated reason." },
    "false-positive": { label: "Not a problem", tone: "neutral", help: "A person checked it and it is not a real problem here." },
    fixed: { label: "Fixed", tone: "success", help: "Not seen any more, or a person marked it fixed. It opens again if a later assessment sees it." },
};
/** Validation states that still need work. */
export const OPEN_VALIDATION: ValidationState[] = ["needs-review", "probable", "confirmed"];
export const isOpen = (v: ValidationState) => OPEN_VALIDATION.includes(v);

export const CATEGORY_WORDS: Record<FindingCategory, string> = {
    headers: "Security headers",
    cookies: "Cookies",
    tls: "HTTPS and certificate",
    cors: "Cross-site access (CORS)",
    "exposed-files": "Files that should not be public",
    "information-disclosure": "Information shown to visitors",
    configuration: "Configuration",
    other: "Other",
    injection: "Injection",
    xss: "Cross-site scripting",
    ssrf: "Server-side request forgery",
    "path-traversal": "Path traversal",
    "access-control": "Access control",
    secrets: "Exposed secrets",
    "ai-security": "AI application security",
};

export const CONFIDENCE_WORDS: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

export const ENVIRONMENT_WORDS: Record<SecurityEnvironment, string> = { development: "Development", staging: "Staging", production: "Production", other: "Other" };

export const STATE_WORDS: Record<AssessmentState, { label: string; tone: Tone; help: string }> = {
    QUEUED: { label: "Waiting to start", tone: "info", help: "The assessment is queued and starts in a moment." },
    DISCOVERING: { label: "Finding pages", tone: "info", help: "Opening the application like a visitor, signed in when it has a saved sign-in, and listing its pages, forms and API calls. Nothing is submitted." },
    SCANNING: { label: "Checking", tone: "info", help: "Reading the answers for configuration problems: headers, cookies, HTTPS, cross-site access, public files." },
    VALIDATING: { label: "Sorting the results", tone: "info", help: "Turning what was seen into findings and comparing them with earlier ones." },
    GENERATING_REPORT: { label: "Writing the report", tone: "info", help: "Putting the report together." },
    COMPLETED: { label: "Finished", tone: "success", help: "Every step finished." },
    PARTIALLY_COMPLETED: { label: "Finished with gaps", tone: "warning", help: "Some steps did not finish; the reason is shown and the coverage says what was not inspected." },
    FAILED: { label: "Did not finish", tone: "danger", help: "The assessment stopped with a problem; the reason is shown." },
    CANCELLED: { label: "Stopped", tone: "neutral", help: "Someone stopped it. What was found before that is kept." },
};

/** The steps a progress page shows, in order. */
export const STEPS: Array<{ state: AssessmentState; label: string }> = [
    { state: "DISCOVERING", label: "Find pages" },
    { state: "SCANNING", label: "Check what was seen" },
    { state: "VALIDATING", label: "Sort the results" },
    { state: "GENERATING_REPORT", label: "Write the report" },
];

// ── routes (#/projects/:id/security/...) ─────────────────────────────────────
const q = (o: Record<string, string | undefined | null>) => {
    const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v) as Array<[string, string]>).toString();
    return s ? `?${s}` : "";
};
export const sec = {
    home: "#/security",
    overview: (id: string) => `#/projects/${id}/security`,
    applications: (id: string) => `#/projects/${id}/security/applications`,
    newApplication: (id: string) => `#/projects/${id}/security/applications/new`,
    application: (id: string, appId: string, opts?: { authorize?: boolean }) => `#/projects/${id}/security/applications/${appId}${q({ authorize: opts?.authorize ? "1" : undefined })}`,
    newAssessment: (id: string, appId?: string, retestOf?: string) => `#/projects/${id}/security/new${q({ app: appId, retest: retestOf })}`,
    assessments: (id: string) => `#/projects/${id}/security/assessments`,
    assessment: (id: string, aid: string) => `#/projects/${id}/security/assessments/${aid}`,
    findings: (id: string, filters?: Record<string, string | undefined>) => `#/projects/${id}/security/findings${q(filters ?? {})}`,
    finding: (id: string, fid: string) => `#/projects/${id}/security/findings/${fid}`,
    newFinding: (id: string, appId?: string) => `#/projects/${id}/security/findings/new${q({ app: appId })}`,
    reports: (id: string, aid?: string) => `#/projects/${id}/security/reports${q({ assessment: aid })}`,
    activity: (id: string, filters?: Record<string, string | undefined>) => `#/projects/${id}/security/activity${q(filters ?? {})}`,
    notifications: (id: string) => `#/projects/${id}/security/notifications`,
};

// ── answers beyond the contract ─────────────────────────────────────────────

export interface SecurityStatus {
    enabled: boolean;
    limits?: Record<string, number | boolean | string | null>;
}

/** Whether an application's recorded authorization covers its current target, scope and limits. */
export interface AuthorizationState {
    state: "current" | "stale" | "none" | "revoked";
    /** The server's plain sentence for the state. */
    message?: string;
    authorizationId?: string | null;
}

/** The security routes answer objects (`{ applications: [...] }`); this reads the list either way. */
export function listOf<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[];
    const v = (data as Record<string, unknown> | undefined)?.[key];
    return Array.isArray(v) ? (v as T[]) : [];
}
/** A project's applications (GET /projects/:id/applications), as a list. */
export function useApps(projectId: string) {
    const f = useFetch<unknown>(`${SEC}/projects/${projectId}/applications`);
    return { ...f, list: listOf<AppRow>(f.data, "applications") };
}
/** A project's assessments (GET /projects/:id/assessments), as a list; asked again every few seconds while one runs, when `poll`. */
export function useAssessments(projectId: string, poll = false) {
    const f = useFetch<unknown>(`${SEC}/projects/${projectId}/assessments`, poll ? (d) => (listOf<AssessmentRow>(d, "assessments").some((a) => isRunning(a.state)) ? 3000 : null) : undefined);
    return { ...f, list: listOf<AssessmentRow>(f.data, "assessments") };
}
/** The one object of an answer like `{ application: {...}, ... }`, or the answer itself. */
export function oneOf<T>(data: unknown, key: string): T | undefined {
    if (!data || typeof data !== "object") return undefined;
    const v = (data as Record<string, unknown>)[key];
    return (v && typeof v === "object" ? v : data) as T;
}

/** An application as the list answers it: the contract's fields, plus what the server adds (authorization state, last assessment). */
export type AppRow = SecurityApplication & {
    authorization?: AuthorizationState | SecurityAuthorization | null;
    authorizationState?: AuthorizationState["state"];
    authorizationCurrent?: boolean;
    scopeFingerprint?: string;
    lastAssessment?: SecurityAssessment | null;
    /** The assessment running now, if any. */
    activeAssessmentId?: string | null;
};

/** GET /applications/:appId (CORE). */
export interface AppAnswer {
    application: AppRow;
    authorization?: AuthorizationState;
    currentAuthorization?: SecurityAuthorization | null;
    /** The specific sentence the person confirms (names the organization, target and scope). */
    statement?: string;
    activeAssessmentId?: string | null;
}

/** An assessment as the routes answer it (RUN adds the application's name and whether a stop was asked for). */
export type AssessmentRow = SecurityAssessment & { applicationName?: string | null; cancelRequested?: boolean };

/** One row of a finding's validation history (FIND). */
export interface HistoryRow {
    id?: string | number;
    at?: string;
    actor?: string;
    from?: ValidationState | null;
    to?: ValidationState | null;
    comment?: string | null;
    assessmentId?: string | null;
}

/**
 * The application's authorization state from whatever the server answers: an explicit state, a boolean, or the list of
 * authorizations (the newest not revoked one whose fingerprint matches the application's, when both are known).
 */
export function authStateOf(app: AppRow | undefined, auths?: Array<SecurityAuthorization & { current?: boolean; stale?: boolean }>): AuthorizationState["state"] {
    if (!app) return "none";
    const a = app.authorization as (AuthorizationState & Partial<SecurityAuthorization>) | null | undefined;
    if (a && typeof a === "object" && typeof (a as AuthorizationState).state === "string" && ["current", "stale", "none", "revoked"].includes((a as AuthorizationState).state)) return (a as AuthorizationState).state;
    if (app.authorizationState) return app.authorizationState;
    if (typeof app.authorizationCurrent === "boolean" && app.authorizationCurrent) return "current";
    const list = auths ?? (a && typeof a === "object" && "confirmedAt" in a ? [a as SecurityAuthorization] : []);
    const live = list.filter((x) => !x.revokedAt).sort((x, y) => y.confirmedAt.localeCompare(x.confirmedAt));
    if (!live.length) return list.length ? "revoked" : app.authorizationCurrent === false ? "stale" : "none";
    const newest = live[0] as SecurityAuthorization & { current?: boolean; stale?: boolean };
    if (newest.current === true) return "current";
    if (newest.stale === true || newest.current === false) return "stale";
    if (app.scopeFingerprint && newest.scopeFingerprint) return app.scopeFingerprint === newest.scopeFingerprint ? "current" : "stale";
    return app.authorizationCurrent === false ? "stale" : "current";
}

export const AUTH_WORDS: Record<AuthorizationState["state"], { label: string; tone: Tone; text: string }> = {
    current: { label: "Authorized", tone: "success", text: "A current authorization covers this application: its scope, limits, saved sign-in and sensitive workflows." },
    stale: { label: "Authorization out of date", tone: "warning", text: "The target, scope, exclusions, request limit, saved sign-in or sensitive workflows changed after the authorization was recorded. Confirm it again before the next assessment." },
    none: { label: "Not authorized yet", tone: "warning", text: "Record the client’s authorization before the first assessment." },
    revoked: { label: "Authorization withdrawn", tone: "neutral", text: "The authorization was withdrawn, or it came back withdrawn from a restored backup. Record a new one before the next assessment." },
};

/** A finding as a list shows it (the overview sends only these fields; a fixed one says when and by which retest). */
export type FindingBrief = Pick<SecurityFinding, "id" | "title" | "severity" | "location" | "applicationId"> & Partial<Pick<SecurityFinding, "validation" | "lastSeenAt">> & { fixedAt?: string; retestId?: string | null };

/** What GET /projects/:id/overview answers (FIND, src/security/findings/overview.ts). Every part optional: a partial answer still shows what it has. */
export interface OverviewAnswer {
    applications?: Array<{ id: string; name: string; targetUrl?: string; environment?: string; openFindings?: number; lastAssessment?: Pick<SecurityAssessment, "id" | "state" | "finishedAt" | "createdAt"> | null }>;
    counts?: Partial<{
        applications: number;
        applicationsAssessed: number;
        assessmentsCompleted: number;
        openCriticalHigh: number;
        awaitingReview: number;
        fixedAfterRetest: number;
        remediationRemaining: number;
        falsePositives: number;
        acceptedRisks: number;
    }>;
    risk?: { level?: string; label?: string; reason?: string; openBySeverity?: Partial<Record<Severity, number>>; rules?: readonly string[] } | null;
    needsAttention?: FindingBrief[];
    fixedRecently?: FindingBrief[];
}

// ── reading the module switch and the project's testing type ─────────────────

let statusPromise: Promise<SecurityStatus> | undefined;
/** Whether the Security Assessment module is on (fetched once per page load). A server without the module answers 404: that is "off". */
export function loadSecurityStatus(): Promise<SecurityStatus> {
    statusPromise ??= api<SecurityStatus>(`${SEC}/status`).then(
        (s) => ({ ...s, enabled: s?.enabled === true }),
        (e) => {
            // Off (404) is an answer; anything else (the server unreachable) is tried again on the next page.
            if (!(e instanceof ApiError && (e.status === 404 || e.status === 403))) statusPromise = undefined;
            return { enabled: false };
        },
    );
    return statusPromise;
}

export function useSecurityStatus(): SecurityStatus | undefined {
    const [s, setS] = useState<SecurityStatus>();
    useEffect(() => {
        let gone = false;
        void loadSecurityStatus().then((x) => !gone && setS(x));
        return () => {
            gone = true;
        };
    }, []);
    return s;
}

export type TestingType = "functional" | "security" | "both";
export const TESTING_TYPES: Array<{ value: TestingType; label: string; hint: string }> = [
    { value: "functional", label: "Functional testing", hint: "Tests that check the application works: journeys, pages, API, accessibility." },
    { value: "security", label: "Security assessment", hint: "A passive, read-only look at an authorized application’s configuration, with findings and reports." },
    { value: "both", label: "Both", hint: "Functional tests and security assessments in one project. Their results stay apart." },
];
export const includesSecurity = (t: TestingType | undefined) => t === "security" || t === "both";

/** What the project's testing type answer says, and whether the choice can be shown at all. */
export interface TestingTypeInfo {
    type: TestingType;
    /** False when the module is off (the choice is hidden). */
    available: boolean;
    /** Set when the module is on but the project's type could not be read (it is treated as functional). */
    problem?: string;
}

const typeCache = new Map<string, Promise<TestingTypeInfo>>();
const typeListeners = new Set<() => void>();

export function loadTestingType(projectId: string): Promise<TestingTypeInfo> {
    let p = typeCache.get(projectId);
    if (!p) {
        p = loadSecurityStatus().then(async (s) => {
            if (!s.enabled) return { type: "functional" as const, available: false };
            try {
                const a = await api<{ testingType: TestingType }>(`${SEC}/projects/${encodeURIComponent(projectId)}/testing-type`);
                return { type: TESTING_TYPES.some((t) => t.value === a.testingType) ? a.testingType : "functional", available: true };
            } catch (e) {
                typeCache.delete(projectId);
                if (e instanceof ApiError && e.status === 404) return { type: "functional" as const, available: true, problem: "This server cannot keep a project’s testing type yet." };
                return { type: "functional" as const, available: true, problem: e instanceof Error ? e.message : String(e) };
            }
        });
        typeCache.set(projectId, p);
    }
    return p;
}

export async function saveTestingType(projectId: string, testingType: TestingType): Promise<void> {
    await api(`${SEC}/projects/${encodeURIComponent(projectId)}/testing-type`, { method: "PUT", body: { testingType } });
    typeCache.set(projectId, Promise.resolve({ type: testingType, available: true }));
    for (const l of typeListeners) l();
}

export function useTestingType(projectId: string | undefined): TestingTypeInfo | undefined {
    const [info, setInfo] = useState<TestingTypeInfo>();
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const on = () => setTick((t) => t + 1);
        typeListeners.add(on);
        return () => void typeListeners.delete(on);
    }, []);
    useEffect(() => {
        if (!projectId) return;
        let gone = false;
        void loadTestingType(projectId).then((x) => !gone && setInfo(x));
        return () => {
            gone = true;
        };
    }, [projectId, tick]);
    return info;
}

/**
 * The type chosen on the New project page before the project exists: whichever way the person then starts creates the project,
 * and the first thing done with its id is to store this type. Cleared once used.
 */
let pendingType: TestingType | undefined;
export const setPendingTestingType = (t: TestingType | undefined) => {
    pendingType = t;
};
export const getPendingTestingType = () => pendingType;
export async function applyPendingTestingType(projectId: string): Promise<void> {
    const t = pendingType;
    if (!t || t === "functional") return;
    pendingType = undefined;
    try {
        await saveTestingType(projectId, t);
    } catch {
        // The project exists and works for functional testing; Setup shows the type and lets the person set it again.
    }
}

// ── small helpers ─────────────────────────────────────────────────────────────

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
