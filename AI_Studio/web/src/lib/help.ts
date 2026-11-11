/**
 * What things mean: the one place the UI's statuses, states, levels and numbers are defined in a sentence or two. Badges, tables,
 * metrics and tooltips read their definition from here (`help(group, key)`), so a word means the same thing on every page.
 *
 * Every sentence is written from the code that decides the value (named next to each group); change the sentence when that code
 * changes. Writing rules (docs/features/tooltips.md): say what it means, why, or what happens; one short sentence, two at most;
 * decided vocabulary (Passing, Failing, Needs a look, Not run yet, Exploration, Run, Runner, Shared elements, Reusable steps,
 * Code test, Repair, Auto-fix, Run sequence); never repeat the visible label; never "Click here".
 *
 * Words a tester may not know (finding, repair, runner ...) stay in GLOSSARY in labels.ts and are shown with `<Term>`.
 * Adding a definition: add the key to the right group below (or a new group, then add it to HELP). For an enum the group is typed
 * `Record<TheEnum, string>`, so a new enum value fails the typecheck until it has a sentence; tests/tooltips-unit.test.ts checks the
 * enums the UI shows against these groups.
 */
// Type-only imports with .js endings: the Node tests import this file too (tests/tooltips-unit.test.ts).
import type { JobStatus, PhaseState, Severity, ValidationStatus } from "../api.js";
import type { AssessmentState, Confidence, FindingCategory, Severity as SecuritySeverity, ValidationState } from "../../../src/security/contract.js";

// ── Tests (labels.ts VALIDATION; set by the validator after a run) ──────────

/** A test's status (VALIDATION in labels.ts gives the word; this says what it means). */
export const TEST_STATUS: Record<ValidationStatus, string> = {
    VALIDATED: "The last run of this test passed: every step and check worked.",
    NEEDS_REVIEW: "The test ran, and a check found something in your application that may be a problem, such as a missing security header. The test itself works.",
    FAILED_VALIDATION: "The last run did not pass: a step or check failed, or the test could not run.",
    VALIDATING: "This test is running right now.",
    PENDING: "This test has not been run yet, so there is no result.",
};

/** Severity of a finding on a test (src/engine/validation/severity.ts): only tests that need a look have one. */
export const SEVERITY_HELP: Record<Severity, string> = {
    critical: "Fix first. The check rated the problem critical, or it broke a journey marked critical.",
    high: "Fix soon. The check rated the problem high, or it broke a high-priority journey.",
    medium: "Worth fixing. The check rated the problem medium, or it broke a medium-priority journey.",
    low: "Minor. The check rated the problem low, or it broke a low-priority journey.",
};

/** How a test did in one run (src/platform/run-view.ts, run-text.ts STATE_WORD). */
export const RUN_TEST_STATE: Record<"waiting" | "running" | "passed" | "failed" | "finding" | "not_run", string> = {
    waiting: "The run has not reached this test yet.",
    running: "This test is part of the run in progress; its result is saved when it finishes.",
    passed: "This test passed in this run.",
    failed: "This test did not pass in this run, or could not run. Its reason is shown.",
    finding: "This test ran and found something in your application that may be a problem.",
    not_run: "This test was planned but produced no result in this run, for example because the run was stopped first.",
};

/** The run ribbon and its legend (ui.tsx Ribbon): one tick per test. */
export const RIBBON_TICK: Record<"pass" | "attention" | "fail" | "idle", string> = {
    pass: "Tests whose last result is passing.",
    attention: "Tests that ran and found something that may be a problem in your application.",
    fail: "Tests that did not pass or could not run.",
    idle: "Tests with no result yet.",
};

// ── Explorations and runs (labels.ts jobLabel; the job's status and mode) ──

/** The raw job status, for places that show one without the job's mode. */
export const JOB_STATUS: Record<JobStatus, string> = {
    QUEUED: "Queued. It starts when the server is free to pick it up.",
    DISCOVERING: "Opening your application and finding its pages and API endpoints.",
    ANALYZING: "The AI is working out the journeys a user takes through what was found.",
    PLANNING: "The AI is choosing which tests to write for those journeys.",
    GENERATING: "Writing the test scripts.",
    VALIDATING: "Running each new test to check that it works.",
    COMPLETED: "Finished without a problem, and every test passed.",
    PARTIALLY_COMPLETED: "Finished, but some tests are failing or need a look, or part of the work could not be done; the reason is shown.",
    FAILED: "It stopped with a problem before it finished; the reason is shown.",
};

/** The definition for the word JobBadge shows (same branches as jobLabel in labels.ts). */
export function jobHelp(job: { status: JobStatus; error?: string | null; mode?: string | null; planOnly?: boolean }): string {
    const stopped = job.status === "FAILED" && job.error === "Cancelled";
    if (job.status === "QUEUED") return JOB_STATUS.QUEUED;
    if (job.status === "FAILED" && /^Nothing ran: /.test(job.error ?? "")) return "No test ran: every test in this run is a draft waiting for approval. Nothing went wrong.";
    if (stopped) return "Someone stopped it. Results recorded before that are kept; tests that did not finish keep their previous result.";
    if (job.planOnly) {
        if (job.status === "COMPLETED" || job.status === "PARTIALLY_COMPLETED") return "The exploration made a plan of tests. Nothing is created until you choose what to make from it.";
        if (job.status === "FAILED") return "The exploration stopped with a problem before the plan was ready; the reason is shown.";
        return "The AI is exploring your application to plan tests. Nothing is created yet.";
    }
    if (job.mode === "variants") {
        if (job.status === "COMPLETED") return "Every test that was checked passed on the other browsers and screen sizes.";
        if (job.status === "PARTIALLY_COMPLETED") return "The check finished; some tests failed or found something on another browser or screen size.";
        if (job.status === "FAILED") return "The browser check stopped with a problem; the reason is shown.";
        return "Running your tests on other browsers or screen sizes.";
    }
    if (job.mode === "agent") {
        if (job.status === "COMPLETED") return "The agent reached the objective and a check of the page passed.";
        if (job.status === "FAILED") return "The agent run ended without a pass; its result says why.";
        return "The AI is working towards an objective in a real browser. Its page shows each step.";
    }
    if (job.mode === "plain") {
        if (job.status === "COMPLETED") return "The test was built from your description and passed its first run.";
        if (job.status === "PARTIALLY_COMPLETED") return "The test was built, and its first run found something that needs a look.";
        if (job.status === "FAILED") return "The test could not be built from the description; the reason is shown.";
        return "The AI is building a test from your description, step by step on the page.";
    }
    const rerun = job.mode === "validate" || job.mode === "environment";
    if (job.status === "COMPLETED") return rerun ? "The run finished and every test that ran passed." : "The exploration finished: tests were created and every one passed its first run.";
    if (job.status === "PARTIALLY_COMPLETED") return rerun ? "The run finished; some tests are failing or need a look, or part of it could not run." : "Tests were created; some are failing or need a look, or part of the exploration could not be done.";
    if (job.status === "FAILED") return rerun ? "The run stopped with a problem before it finished; the reason is shown." : "The exploration stopped with a problem before it finished; the reason is shown.";
    if (rerun) return job.mode === "environment" ? "Running your tests against the chosen environment." : "Running your tests now.";
    return JOB_STATUS[job.status];
}

/** A step of an exploration (labels.ts phaseText). */
export const PHASE_STATE: Record<PhaseState, string> = {
    pending: "Not started yet.",
    running: "Happening now.",
    done: "This step is finished.",
    skipped: "Not needed for this exploration, so it was left out.",
    failed: "This step stopped with a problem.",
};

// ── Schedules and deploy triggers (src/platform/scheduler.ts, routes/triggers.ts) ──

export const SCHEDULE_HELP = {
    on: "The schedule starts a run at its next time.",
    off: "Paused: the schedule starts nothing until you turn it back on.",
    started: "At its last time the schedule started a run.",
    skipped: "At its last time nothing was started, because another run was going or the month's AI limit was used up. The next time is unchanged.",
    error: "At its last time the run could not be started; the reason is shown.",
    retry: "A test that fails in a scheduled run is run once more before it counts as failing.",
    schedulerOff: "Schedules are switched off on this server, so none of them start runs until it is switched on.",
} as const;

export const TRIGGER_HELP = {
    active: "A deploy pipeline can use this token to start a run of this project.",
    revoked: "This token no longer starts anything.",
    allowUrl: "A pipeline may send another address, such as a preview deploy, and the run then tests that address instead of the project's own.",
} as const;

// ── Runners and phones (src/platform/agent-store.ts ONLINE_MS, web/src/features/agents/agents.ts) ──

export const RUNNER_HELP = {
    online: "The runner was heard from in the last 45 seconds and can take tests.",
    offline: "Nothing heard from the runner in the last 45 seconds. A run waits a short while for your runner, then fails if it is still offline.",
    busy: "The runner is running tests now. It takes more when it has a free slot.",
    thisServer: "Tests run on the platform's own server, not on a runner.",
} as const;

/** What adb says about a connected phone (agents.ts deviceState). */
export const DEVICE_STATE: Record<"device" | "offline" | "unauthorized", string> = {
    device: "Connected and ready for tests.",
    offline: "Connected, but the phone is not answering. Unplug it and plug it back in.",
    unauthorized: "Unlock the phone and allow USB debugging for this computer when it asks.",
};

/** "Is this phone ready?" for one phone (src/engine/mobile/device/ready.ts checkPhoneReady: the worst of its checks). */
export const PHONE_READY: Record<"ready" | "attention" | "not-ready", string> = {
    ready: "Every check passed: phone tests can run on this phone now.",
    attention: "Tests can run, but something makes them slower or less steady, such as animations or a screen that turns off. Each line says what to do.",
    "not-ready": "Something stops tests from running on this phone, such as USB debugging not allowed or the app missing. Each line says what to do.",
};

/** One line of the ready check (ready.ts CheckStatus). */
export const PHONE_CHECK: Record<"ok" | "attention" | "problem" | "info", string> = {
    ok: "This is as tests need it.",
    attention: "Tests can run, but this makes them slower or less steady.",
    problem: "Tests cannot run on this phone until this is fixed.",
    info: "Worth knowing; nothing needs doing.",
};

/** The runner's Android phone tools (agents.ts phoneToolsSentence). */
export const PHONE_TOOLS: Record<"ready" | "can-fetch" | "fetching" | "failed" | "off" | "unsupported", string> = {
    ready: "The runner has Google's Android phone tools and can talk to a phone with USB debugging on.",
    "can-fetch": "The runner downloads Google's Android phone tools itself the first time a phone session needs them.",
    fetching: "The runner is downloading Google's Android phone tools now.",
    failed: "The runner could not get the Android phone tools; the reason is shown.",
    off: "Getting the Android phone tools is switched off on this runner.",
    unsupported: "The Android phone tools are not available for this computer's system.",
};

/** A device farm result (features/devicefarm). */
export const DEVICE_FARM_RESULT: Record<"passed" | "failed" | "other", string> = {
    passed: "The test passed on this farm device.",
    failed: "The test did not pass on this farm device.",
    other: "The farm did not run the test to the end, so there is no verdict.",
};

// ── Security Assessment (src/security/contract.ts, findings/normalize.ts, findings/overview.ts) ──

export const ASSESSMENT_STATE: Record<AssessmentState, string> = {
    QUEUED: "The assessment is queued and starts in a moment.",
    // Round 20: signed in with a saved sign-in when the application names one; an uploaded API document's GET operations are requested here too.
    DISCOVERING: "Opening the application like a visitor, signed in when it has a saved sign-in, and listing its pages, forms and API calls; an uploaded API document's read-only operations are requested too. Nothing is submitted.",
    SCANNING: "Reading the answers for configuration problems: headers, cookies, HTTPS, cross-site access, public files.",
    VALIDATING: "Turning what was seen into findings and comparing them with earlier ones.",
    GENERATING_REPORT: "Putting the report together.",
    COMPLETED: "Every step finished.",
    PARTIALLY_COMPLETED: "Some steps did not finish. The coverage says what was not inspected.",
    FAILED: "The assessment stopped with a problem; the reason is shown.",
    CANCELLED: "Someone stopped it. What was found before that is kept.",
};

export const FINDING_VALIDATION: Record<ValidationState, string> = {
    // A finding marked fixed that an assessment sees again comes back here (src/security/findings/ingest.ts).
    "needs-review": "Nobody has checked this finding yet, or it came back after being marked fixed. It counts as open.",
    probable: "The evidence points to a real problem; a person has not confirmed it yet. It counts as open.",
    confirmed: "A person checked it and it is a real problem. It counts as open until it is fixed.",
    "accepted-risk": "A real problem the client decided to live with, for a stated reason. It no longer counts as open.",
    "false-positive": "A person checked it and it is not a real problem here. It no longer counts as open.",
    fixed: "A retest did not see it again, or a person marked it fixed. It opens again if a later assessment sees it.",
};

export const SECURITY_SEVERITY: Record<SecuritySeverity, string> = {
    critical: "The most serious level: fix it before anything else. Any open critical finding makes the risk high.",
    high: "A serious weakness to fix soon. Any open high finding makes the risk high.",
    medium: "A weakness worth fixing. Open medium findings make the risk medium when nothing is critical or high.",
    low: "A minor weakness, usually hardening. Only low or information findings open means low risk.",
    info: "Not a weakness in itself: something worth knowing, such as a version number the server shows.",
};

export const CONFIDENCE_HELP: Record<Confidence, string> = {
    high: "The platform's checks recognised this exact problem, or the person who entered it is sure of it. A finding an assessment made with evidence starts as Probable.",
    medium: "The default: the checks could not match the problem to a known rule, or the person who entered it did not choose. An assessment's finding then starts as Needs a look.",
    low: "Set by the person who entered the finding when they are unsure. It does not change the finding's state.",
};

export const FINDING_CATEGORY: Record<FindingCategory, string> = {
    headers: "Response headers that tell browsers how to protect the page, such as Content-Security-Policy.",
    cookies: "Flags on cookies, such as Secure and HttpOnly, that keep them from being read or sent where they should not be.",
    tls: "The HTTPS connection and its certificate: valid, trusted and not about to expire.",
    cors: "Whether other websites may read this site's answers in a visitor's browser.",
    "exposed-files": "Files that should not be downloadable, such as backups or configuration files.",
    "information-disclosure": "Details the server shows that help an attacker, such as software versions or folder listings.",
    configuration: "Other server settings that weaken protection.",
    other: "A problem that does not fit the other categories, often entered by hand.",
    injection: "Input reaching an interpreter: SQL, command, code or template injection.",
    xss: "Script from this site running in a visitor's browser.",
    ssrf: "The server being made to fetch an address it should not reach.",
    "path-traversal": "Files outside the intended folder being read through a crafted address.",
    "access-control": "Data or actions reachable by someone who should not have them.",
    secrets: "Credentials or keys published where anyone can read them.",
    "ai-security": "An AI feature that can be steered away from what it should do.",
};

/** The risk levels, one per rule in RISK_RULES (src/security/findings/overview.ts). */
export const RISK_LEVEL: Record<"not-assessed" | "high" | "medium" | "low" | "no-open-findings", string> = {
    high: "At least one open critical or high finding.",
    medium: "No open critical or high finding, and at least one open medium finding.",
    low: "Only open low or informational findings.",
    "no-open-findings": "Nothing open was found by the checks that ran. It does not mean the application is secure: see what was not inspected.",
    "not-assessed": "No assessment of this project has finished yet, and no finding was entered by hand.",
};

export const AUTHORIZATION_STATE: Record<"current" | "stale" | "none" | "revoked", string> = {
    current: "A recorded authorization covers the current address, scope, exclusions, request limit, saved sign-in and sensitive workflows, so assessments can start.",
    stale: "The address, scope, exclusions, request limit, saved sign-in or sensitive workflows changed after the authorization was recorded. Record a new one before assessing.",
    none: "No authorization is recorded. No assessment starts without one.",
    // A restored backup brings authorizations back as history, withdrawn (src/security/backup.ts importSecurityData).
    revoked: "The authorization was withdrawn, or it came back withdrawn from a restored backup. No assessment starts until a new one is recorded.",
};

/**
 * The saved sign-in a signed-in assessment loads (src/security/signin.ts statusOf; "ready" and "not-checked" from
 * platform/session-store.ts toPublic: known end date not passed or last check signed in, versus never checked and no end date).
 */
export const SIGN_IN_STATE: Record<"ready" | "not-checked" | "expired" | "missing" | "other-site" | "unreadable", string> = {
    ready: "Saved, its cookies have not run out, and its last check, if any, found it signed in. The assessment loads it.",
    "not-checked": "Saved, but never checked, and its cookies give no end date. The assessment loads it, and its coverage says so if the sign-in did not work.",
    expired: "Its cookies have run out, or the last check found it signed out. The assessment visits signed out until a new sign-in is saved under Test accounts.",
    missing: "No sign-in is saved for this account yet. The assessment visits signed out until one is saved under Test accounts or uploaded on the application's page.",
    "other-site": "It was saved for a site outside this application's scope, so it is never used here and the assessment visits signed out.",
    unreadable: "It can no longer be decrypted, because the platform's secret key changed. The assessment visits signed out until someone signs in again.",
};

/** Why a message about an assessment was sent (src/security/notify.ts NoticeReason, buildNotice). */
export const NOTIFY_REASON: Record<"new-critical-high" | "reopened-critical-high" | "failed" | "finished", string> = {
    "new-critical-high": "The assessment found critical or high findings that were not known before.",
    "reopened-critical-high": "Critical or high findings that were marked fixed were seen again by the assessment, so they are open again.",
    failed: "The assessment stopped with a problem before it finished. A stopped assessment or one finished with gaps does not count.",
    finished: "Every assessment that ends is reported, whatever its result, because that setting is on.",
};

/** What an assessment does with one operation of an uploaded API document (src/security/api-document.ts planOperations; "refused" from routes/signin.ts preview). */
export const API_OPERATION: Record<"request" | "not-get" | "needs-values" | "sign-out" | "bad-path" | "refused", string> = {
    request: "A GET operation without required parameters. An assessment requests it once, read-only, if the scope checks still allow it then (at most 50 per assessment).",
    "not-get": "Not a GET operation, so it is never called: other methods could change data.",
    "needs-values": "It needs values the platform would have to make up: path parameters, required parameters or a request body. It is not called.",
    "sign-out": "Its address looks like a sign-out address. It is never called, so a saved sign-in is not ended.",
    "bad-path": "Its address could not be made from the document, so it is not called.",
    refused: "Its address is outside the authorized scope, or under an excluded path or a sensitive workflow, so it is never called.",
};

// ── People: per-project access (src/platform/project-access-store.ts, auth/project-scope.ts, the route rules in auth/roles.ts) ──

/** "All projects" or "Only these projects" on the People screen. */
export const PROJECT_ACCESS: Record<"all" | "only", string> = {
    all: "Sees every project, including new ones, with their own role in each.",
    only: "Sees only the chosen projects, with the role chosen in each; other projects answer as if they did not exist. Platform-wide pages (people, Activity, storage, AI budgets, evaluation, new projects, restoring a backup) stay closed to them.",
};

/** A role in one project for a person limited to some projects. The lower of it and their own role counts. */
export const PROJECT_ROLE: Record<"viewer" | "editor" | "owner", string> = {
    viewer: "Looks at this project's tests, runs, findings and reports, and downloads reports. Changes nothing in it.",
    editor: "Also creates, changes and runs tests, and starts security assessments, in this project.",
    owner: "Also manages this project's alert and tracker connections, device farms, storage, backups and security authorizations.",
};

// ── Numbers (src/engine/summary/pass-rate.ts, src/platform/trends.ts, security overview counts, compliance map) ──

export const METRIC_HELP = {
    passRate: "Tests that passed, out of the tests that produced a result in that run. Tests not in the run and tests in quarantine are left out.",
    latestPassRate: "The pass rate of the most recent finished run in this period.",
    averagePassRate: "The average of the pass rates of the runs in this period.",
    passRateChange: "The latest run's pass rate minus the first run's in this period, in percentage points.",
    runs: "Finished runs in this period.",
    findings: "Tests that ran and found something that may be a problem in your application.",
    unreliable: "Tests whose recent results flip between passing and failing without a change.",
    flakyPass: "Passed only after a failed attempt in the same run.",
    breakingApiChanges: "Fields, types or endpoints that clients rely on and that changed since the previous run.",
    tests: "All the tests in this project.",
    passing: "Tests whose last run passed.",
    notPassing: "Tests that are failing or need a look.",
    lastExplored: "When the project's latest exploration or run finished, or when it started if it is still going.",
    complianceCovered: "Controls with at least one passing test and none failing or needing a look.",
    complianceAttention: "Controls with at least one related test that is failing or needs a look.",
    complianceGap: "Controls no test covers yet.",
    applicationsAssessed: "Applications with at least one finished assessment.",
    assessmentsCompleted: "Assessments that finished, including those that finished with gaps.",
    openCriticalHigh: "Open findings rated critical or high: confirmed, probable or not yet checked.",
    awaitingReview: "Open findings no person has checked yet: Needs a look or Probable.",
    fixedAfterRetest: "Findings a retest did not see again.",
    remediationRemaining: "All open findings: the fixing still to do.",
    falsePositives: "Findings a person marked as not a real problem.",
    acceptedRisks: "Real problems the client decided to live with.",
    pagesSeen: "Pages the assessment opened.",
    formsSeen: "Forms it found. They are listed, never submitted.",
    apiCallsSeen: "API requests the pages made while it looked, and the read-only operations of an uploaded API document it requested.",
    notInspected: "What the assessment did not or could not look at, and whether it was signed in. Findings say nothing about what was not looked at.",
} as const;

// ── One lookup for everything ───────────────────────────────────────────────

export const HELP = {
    testStatus: TEST_STATUS,
    severity: SEVERITY_HELP,
    runTest: RUN_TEST_STATE,
    ribbon: RIBBON_TICK,
    job: JOB_STATUS,
    phase: PHASE_STATE,
    schedule: SCHEDULE_HELP,
    trigger: TRIGGER_HELP,
    runner: RUNNER_HELP,
    device: DEVICE_STATE,
    phoneTools: PHONE_TOOLS,
    phoneReady: PHONE_READY,
    phoneCheck: PHONE_CHECK,
    deviceFarm: DEVICE_FARM_RESULT,
    assessment: ASSESSMENT_STATE,
    findingValidation: FINDING_VALIDATION,
    securitySeverity: SECURITY_SEVERITY,
    confidence: CONFIDENCE_HELP,
    category: FINDING_CATEGORY,
    risk: RISK_LEVEL,
    authorization: AUTHORIZATION_STATE,
    signIn: SIGN_IN_STATE,
    notifyReason: NOTIFY_REASON,
    apiOperation: API_OPERATION,
    projectAccess: PROJECT_ACCESS,
    projectRole: PROJECT_ROLE,
    metric: METRIC_HELP,
} as const;

export type HelpGroup = keyof typeof HELP;
export type HelpKey<G extends HelpGroup> = keyof (typeof HELP)[G] & string;

/** The definition of `key` in `group`, e.g. help("findingValidation", "probable"). Typed: a missing key is a compile error. */
export function help<G extends HelpGroup>(group: G, key: HelpKey<G>): string {
    return (HELP[group] as Record<string, string>)[key]!;
}

/** For values that arrive as plain strings from an answer: the definition, or undefined when there is none. */
export function helpFor(group: HelpGroup, key: string | null | undefined): string | undefined {
    if (key === null || key === undefined) return undefined;
    const g = HELP[group] as Record<string, string>;
    return Object.prototype.hasOwnProperty.call(g, key) ? g[key] : undefined;
}
