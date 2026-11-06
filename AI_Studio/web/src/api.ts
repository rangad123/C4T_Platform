export interface Counters {
    pagesDiscovered: number;
    apisDiscovered: number;
    journeysIdentified: number;
    scenariosPlanned: number;
    testsGenerated: number;
    testsValidated: number;
    testsFailedValidation: number;
    testsNeedingReview: number;
    scenariosSkipped: number;
    requirementsTotal?: number;
    requirementsCovered?: number;
    llmInputTokens?: number;
    llmOutputTokens?: number;
    /** Browser / screen-size checks that ran, and how many of them failed. */
    variantChecks?: number;
    variantFailures?: number;
    /** Phone exploration (additive, present only for a phone job): screens the AI has seen and actions it has taken so far. */
    screensSeen?: number;
    actionsTaken?: number;
}
export type PhaseState = "pending" | "running" | "done" | "skipped" | "failed";
export type PhaseKey = "discovery" | "understanding" | "planning" | "generation" | "validation";
export type JobStatus = "QUEUED" | "DISCOVERING" | "ANALYZING" | "PLANNING" | "GENERATING" | "VALIDATING" | "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED";

export interface Job {
    jobId: string;
    projectId: string;
    status: JobStatus;
    mode?: "generate" | "validate" | "variants" | "environment" | "plain" | "agent";
    /** An exploration that stops at a plan: nothing is created or run until the person confirms it (see features/onboarding). */
    planOnly?: boolean;
    /** Creation that starts from the plan an earlier exploration kept (that plan job's id). */
    fromPlan?: string;
    /** Name of the environment (staging, production...) a run in "environment" mode targeted. */
    environment?: string | null;
    /** Who started the run: a person, a schedule, or a deploy pipeline. */
    trigger?: "manual" | "schedule" | "deploy";
    scheduleId?: string | null;
    /** Where a validation, variant or environment run happened (the platform server or a runner agent). */
    ranOn?: RanOn;
    /** True while this job is in a browser-driven part a person can watch (the Explorer view). */
    canWatch?: boolean;
    /** What an exploration looks at ("mobile" is an Android app on a phone or emulator). Absent on jobs made before phone exploration. */
    targets?: Array<"web" | "api" | "mobile">;
    /** Deploy runs: what the pipeline said about the deploy. */
    deploy?: { commit?: string; environment?: string; label?: string } | null;
    progress: Record<PhaseKey, PhaseState>;
    counters: Counters;
    error: string | null;
    /** Only for a run that was cancelled: how many tests reached a result and how many did not run, and a sentence made from those facts. */
    cancelled?: { planned: number; ran: number; notRun: number; note: string } | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export type ValidationStatus = "PENDING" | "VALIDATING" | "VALIDATED" | "FAILED_VALIDATION" | "NEEDS_REVIEW";
/** Where a run happened (a small field on the job objects). */
export type RanOn = { kind: "platform" } | { kind: "agent"; agentId: string; name: string; /** The browser the runner's web tests used (from a runner that reports it). */ browser?: WebBrowserUsed };
/** A Chromium-family browser on a runner: Playwright's own Chromium (already there, or downloaded by the runner) or the computer's Chrome or Edge. */
export interface WebBrowserUsed {
    name: "chromium" | "chrome" | "msedge";
    version?: string;
    source: "installed" | "downloaded" | "bundled";
}
export type Severity = "critical" | "high" | "medium" | "low";

export interface TestSummary {
    id: string;
    projectId: string;
    testId: string;
    title: string;
    suite: string;
    kind: "web" | "api" | "mobile" | "desktop";
    type: string;
    priority: "critical" | "high" | "medium" | "low";
    framework: string;
    validationStatus: ValidationStatus;
    validationReason: string | null;
    attempts: number;
    /** Only for NEEDS_REVIEW findings. */
    severity: { severity: Severity; basis: string } | null;
    /** Does the test check anything? Advice only; never changes the test's status. */
    quality?: { level: "good" | "weak"; reasons: string[] } | null;
    /** Other browsers / screen sizes this test was checked on (null = never checked). */
    compat?: import("./features/variants/variants.js").CompatBrief | null;
    /** Present only while the test is in quarantine: it still runs and is shown, but counts for nothing. */
    quarantine?: { reason: string; since: string; expiresAt: string };
    /** Present only for a hand-written test: its script, not a specification, is the source of truth. */
    custom?: import("./features/code/code.js").CustomInfo;
    updatedAt: string;
}

export interface ProjectRow {
    id: string;
    name: string;
    created_at: string;
    test_count: number;
    validated_count: number;
    url: string | null;
    last_job_status: JobStatus | null;
    /** Round 34: the folder the project is in, and when it was archived (archived ones are listed only with ?archived=include). */
    folder_id?: string | null;
    archived_at?: string | null;
    organization_id?: string | null;
    /** What the project tests and how (the server sends them with every row); read through `projectKind`. */
    platforms?: Platform[];
    testingModes?: TestingMode[];
    /** How many written test cases the project has (absent from older servers). */
    case_count?: number;
}

export interface ProjectDetail {
    id: string;
    name: string;
    created_at: string;
    test_count: number;
    validated_count: number;
    /** How many written test cases the project has (absent from older servers). */
    case_count?: number;
    application: { id: string; url: string; config: Record<string, unknown> } | null;
    latestJob: Job | null;
    suites: Array<{ id: string; name: string; slug: string; total: number; validated: number }>;
    mobile: MobileApp | null;
    /** Round 26 (US-010): what the project tests and how. Absent from older servers; read through `projectShape`. */
    platforms?: Platform[];
    testingModes?: TestingMode[];
    codeEngines?: { web?: "playwright"; mobile?: "taqwright" };
    organization_id?: string | null;
    /** The Crowd4Test project this one is linked to, for reference only (it grants nobody access). */
    c4tProject?: { id: string; reference: string | null; title: string | null } | null;
    /** What the person asking may do on this project, and whether they are its Project Admin. */
    access?: { projectAdmin: boolean; permissions: string[] };
    /** Round 34: set while the project is archived (read-only, no runs). */
    archived_at?: string | null;
    folder_id?: string | null;
}

export type Platform = "web" | "android" | "ios";
export type TestingMode = "agent" | "code";
export const PLATFORM_WORDS: Record<Platform, string> = { web: "Web", android: "Android", ios: "iOS" };
export const MODE_WORDS: Record<TestingMode, string> = { agent: "AI agent", code: "Code" };
/** A project's platforms and modes, with the defaults an older server or an older project implies. */
export function projectShape(p: Pick<ProjectDetail, "platforms" | "testingModes"> | null | undefined): { platforms: Platform[]; testingModes: TestingMode[] } {
    return { platforms: p?.platforms?.length ? p.platforms : ["web"], testingModes: p?.testingModes?.length ? p.testingModes : ["agent", "code"] };
}
/** The kind of project, which decides its tabs and dashboard: "agent" (tested by the AI agent only), "code" (code only), or "mixed" (both modes, made before a project had one). */
export type ProjectKind = "agent" | "code" | "mixed";
export function projectKind(p: Pick<ProjectDetail, "platforms" | "testingModes"> | null | undefined): ProjectKind {
    const m = projectShape(p).testingModes;
    return m.includes("agent") && m.includes("code") ? "mixed" : m.includes("code") ? "code" : "agent";
}

export interface EventRow {
    id: number;
    stage: string;
    kind: string;
    level: string;
    message: string;
    createdAt: string;
    /** The event's facts when it has some (phone explorations: counters, the stop reason, a question waiting for a person). */
    data?: unknown;
}

export interface MobileApp {
    appPackage: string | null;
    apk: string | null;
    avd: string | null;
    /** iOS app already installed on the simulator, and the simulator by name (present only when set). */
    iosBundleId?: string;
    simulator?: string;
    /** Android: clear the app's data before every test, and permissions granted before every test (present only when on). */
    cleanStart?: boolean;
    grantPermissions?: string[];
    /** Android (round 24): the screen that opens the app, as the last run resolved it on the phone (read-only). */
    appActivity?: string;
}

export interface PlatformConfig {
    llm: { provider: string; model: string; configured: boolean };
    /** Whether a run or an exploration started now would start: false while tests are switched off on this server (no worker). */
    runsHere?: boolean;
    /** Can this machine run mobile tests (Android toolchain + emulator)? */
    mobile?: { available: boolean; reason?: string; avds: string[]; toolchain: "managed" | "system" | "none" };
    authRequired: boolean;
    /** Which Playwright browsers are installed on the computer that runs the platform. */
    browsers?: { chromium: boolean; firefox: boolean; webkit: boolean };
    /** The extra browsers / screen sizes a user can ask for, and whether each can run here. */
    variants?: Array<{ id: string; label: string; description: string; available: boolean; reason?: string }>;
    frameworks: Array<{ framework: string; kind: string; executable: boolean }>;
    /** Every testing framework this server has; the ones added by an adapter plug-in carry `plugin`. */
    adapters?: Array<{ id: string; label: string; kinds: string[]; executable: boolean; plugin?: { name: string; version: string } }>;
    /** Adapter plug-ins: whether they are on, what loaded, and what did not and why (names only, never server paths). */
    adapterPlugins?: {
        requested: boolean;
        enabled: boolean;
        configured: number;
        reason?: string;
        loaded: Array<{ name: string; version: string; description: string; adapters: Array<{ id: string; label: string }> }>;
        problems: Array<{ plugin: string; message: string }>;
    };
}

const KEY = "aitp.apiKey";
// Browser storage can be blocked (private windows, strict settings): the key then lives for this visit only, and the app still opens.
let keyInMemory = "";
export const getKey = () => {
    try {
        return localStorage.getItem(KEY) ?? keyInMemory;
    } catch {
        return keyInMemory;
    }
};
export const setKey = (k: string) => {
    keyInMemory = k;
    try {
        localStorage.setItem(KEY, k);
    } catch {
        /* kept in memory */
    }
};

/**
 * A signed-in browser proves each change comes from this page: it echoes the session's CSRF token (a cookie the page can read,
 * set at sign-in) in a header. Reads need nothing; without a session (access key, open platform) there is no cookie and no header.
 */
export function csrfHeader(method = "GET"): Record<string, string> {
    if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return {};
    const m = /(?:^|;\s*)aitp_csrf=([^;]+)/.exec(typeof document === "undefined" ? "" : document.cookie);
    // Signed in with Crowd4Test there is no CSRF cookie; this header is the proof instead (a page elsewhere cannot add it).
    return m ? { "x-csrf-token": decodeURIComponent(m[1]!), "x-requested-with": "ai-studio" } : { "x-requested-with": "ai-studio" };
}

/** What a refusal says when the person signs in on crowd4test.com (see the server's auth/crowd4test.ts). */
export interface Crowd4TestLinks {
    crowd4test: "sign-in" | "renew" | "refused" | "unreachable";
    signInUrl: string;
    refreshUrl: string;
    portalUrl: string;
}
export const crowd4testOf = (details: unknown): Crowd4TestLinks | undefined =>
    details && typeof details === "object" && typeof (details as Crowd4TestLinks).crowd4test === "string" ? (details as Crowd4TestLinks) : undefined;

/**
 * When this tab was last sent to crowd4test.com to sign in (sessionStorage, so it lasts through the round trip). crowd4test.com sends
 * a signed-in person straight back; if their sign-in still does not arrive here, going again would bounce between the two sites
 * until the browser gives up with "too many redirects".
 */
const SIGN_IN_TRIPS = "aitp_c4t_sign_in_trips";
const TRIP_WINDOW_MS = 60_000;
const TRIPS_BEFORE_STOPPING = 2;

function recentSignInTrips(now = Date.now()): number[] {
    try {
        const list = JSON.parse(sessionStorage.getItem(SIGN_IN_TRIPS) ?? "[]") as unknown;
        return Array.isArray(list) ? list.filter((t): t is number => typeof t === "number" && now - t < TRIP_WINDOW_MS) : [];
    } catch {
        return [];
    }
}

/** This tab came back from crowd4test.com twice within a minute and is still not signed in here: sending it again would loop. */
export function crowd4testSignInStuck(): boolean {
    return recentSignInTrips().length >= TRIPS_BEFORE_STOPPING;
}

/** Signed in, or the person asked to try again: the next trip to crowd4test.com starts a fresh count. */
export function forgetCrowd4TestTrips(): void {
    try {
        sessionStorage.removeItem(SIGN_IN_TRIPS);
    } catch {
        // storage not available: nothing was counted
    }
}

/** crowd4test.com's hand-off, back to the page open now once the person has signed in there. False when that would loop. */
export function crowd4testSignIn(signInUrl: string): boolean {
    if (crowd4testSignInStuck()) return false;
    try {
        sessionStorage.setItem(SIGN_IN_TRIPS, JSON.stringify([...recentSignInTrips(), Date.now()]));
    } catch {
        // storage not available: the trip is not counted
    }
    const page = location.hash.replace(/^#/, "") || "/";
    location.assign(`${signInUrl}?to=${encodeURIComponent(page)}`);
    return true;
}

let renewing: Promise<void> | null = null;
/**
 * Asks crowd4test.com to renew an expired session. Its answer cannot be read from here (another address), and does not need to
 * be: the renewed cookies arrive with it, and the request that was refused is simply sent again. Calls made together share one.
 */
export function renewCrowd4Test(refreshUrl: string): Promise<void> {
    renewing ??= fetch(refreshUrl, { mode: "no-cors", credentials: "include", cache: "no-store" })
        .then(() => undefined, () => undefined)
        .finally(() => setTimeout(() => (renewing = null), 2_000));
    return renewing;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }, renewed = false): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, {
            method: init?.method ?? "GET",
            // Only declare JSON when sending some: Fastify rejects an empty body labelled application/json.
            headers: { ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader(init?.method) },
            body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
    } catch {
        throw new ApiError(0, "Could not reach the platform server");
    }
    const text = await res.text();
    const data = text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text;
    if (!res.ok) {
        // Signed in with Crowd4Test: an expired session is renewed and the call made once more; signed out there, sign in there.
        const c4t = crowd4testOf(data?.details);
        if (c4t?.crowd4test === "renew" && !renewed) {
            await renewCrowd4Test(c4t.refreshUrl);
            return api<T>(path, init, true);
        }
        if (c4t && (c4t.crowd4test === "sign-in" || c4t.crowd4test === "renew")) crowd4testSignIn(c4t.signInUrl);
        throw new ApiError(res.status, (data && data.error) || res.statusText, data?.details);
    }
    return data as T;
}

/** Send an Android app file as the raw request body (it can be large, so it is not wrapped in JSON). */
export async function uploadApk(projectId: string, file: File): Promise<void> {
    let res: Response;
    try {
        res = await fetch(`/api/projects/${projectId}/mobile-app/apk?filename=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/vnd.android.package-archive", ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader("POST") },
            body: file,
        });
    } catch {
        throw new ApiError(0, "Could not reach the platform server");
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(res.status, (data as { error?: string }).error || res.statusText);
    }
}

/** Round 37: the app a project tests, by platform (GET /api/projects/:id/app-details). */
export interface AppDetails {
    webUrl: string | null;
    android: { apk: string | null; appPackage: string | null; playStoreUrl: string | null };
    ios: { ipa: { name: string; bytes: number; uploadedAt: string } | null; bundleId: string | null; appStoreUrl: string | null };
}

/** Upload an iPhone app (.ipa). It is stored for runners; the server never opens or runs it. */
export async function uploadIpa(projectId: string, file: File): Promise<AppDetails> {
    let res: Response;
    try {
        res = await fetch(`/api/projects/${projectId}/app-details/ipa?filename=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream", ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader("POST") },
            body: file,
        });
    } catch {
        throw new ApiError(0, "Could not reach the platform server");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || res.statusText);
    return data as AppDetails;
}

/** One page of the project list (GET /api/projects with limit and offset). */
export interface ProjectPage {
    projects: ProjectRow[];
    total: number;
    limit: number;
    offset: number;
}

/** URL for an artifact (screenshot, video...) that works in <img>/<video>/<a>, including when an API key is required. */
export const artifactUrl = (id: string) => `/api/artifacts/${id}${getKey() ? `?key=${encodeURIComponent(getKey())}` : ""}`;
