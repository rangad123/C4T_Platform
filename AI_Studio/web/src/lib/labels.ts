/**
 * The only place internal states, raw errors and recorded steps become plain language.
 * The backend keeps its precise states (VALIDATED, NEEDS_REVIEW, DISCOVERING ...); the UI never shows them.
 */
import type { Counters, Job, JobStatus, PhaseKey, PhaseState, Severity, ValidationStatus } from "../api.js";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

// ── Validation status of a test ─────────────────────────────────────────────

export const VALIDATION: Record<ValidationStatus, { label: string; tone: Tone; help: string }> = {
    VALIDATED: { label: "Passing", tone: "success", help: "This test was run and passed." },
    NEEDS_REVIEW: { label: "Needs a look", tone: "warning", help: "This test found something that may be a problem in your application." },
    FAILED_VALIDATION: { label: "Failing", tone: "danger", help: "This test did not pass: a check failed, or it could not run." },
    VALIDATING: { label: "Running…", tone: "info", help: "This test is being run right now." },
    PENDING: { label: "Not run yet", tone: "neutral", help: "This test hasn’t been run yet." },
};

export const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
    critical: { label: "Critical", tone: "danger" },
    high: { label: "High", tone: "danger" },
    medium: { label: "Medium", tone: "warning" },
    low: { label: "Low", tone: "neutral" },
};

export const PRIORITY_LABEL = { critical: "Critical priority", high: "High priority", medium: "Medium priority", low: "Low priority" } as const;

export const KIND_LABEL = { web: "Web", api: "API", mobile: "Phone", desktop: "Windows app" } as const;

const TYPE_LABEL: Record<string, string> = {
    functional: "Functional",
    negative: "Negative case",
    boundary: "Boundary",
    security: "Security",
    smoke: "Smoke",
    validation: "Validation",
    navigation: "Navigation",
    accessibility: "Accessibility",
    workflow: "Workflow",
    visual: "Visual",
    health: "Health check",
    performance: "Page speed",
    input: "Input handling",
    vision: "AI judgement",
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

/** "Playwright (TypeScript)" instead of "playwright-api". */
export function frameworkLabel(framework: string): string {
    if (framework === "playwright") return "Playwright (TypeScript)";
    if (framework === "playwright-api") return "Playwright API (TypeScript)";
    if (framework === "taqwright") return "Taqwright (Appium, TypeScript)";
    if (framework === "windows-uia") return "Windows UI Automation (PowerShell)";
    if (framework === "taqwright-ios") return "Taqwright iOS (Appium, TypeScript)";
    return framework;
}

// ── Analysis (job) status ───────────────────────────────────────────────────

export const isActive = (s: JobStatus | undefined | null) => !!s && !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(s);

/** A run of only drafts: no test was allowed to run. Nothing went wrong, so it is not shown as a failure (review-store.ts). */
export const nothingRan = (job: { status: JobStatus; error?: string | null }) => job.status === "FAILED" && /^Nothing ran: /.test(job.error ?? "");

export function jobLabel(job: Pick<Job, "status" | "error" | "mode"> & { planOnly?: boolean; targets?: Job["targets"] }): { label: string; tone: Tone } {
    if (nothingRan(job)) return { label: "Nothing ran", tone: "neutral" };
    // An exploration of an Android app and nothing else says so.
    const exploring = job.targets?.length && job.targets.every((t) => t === "mobile") ? "Exploring your phone app" : "Exploring your application";
    // An exploration that stops at a plan has created nothing yet: say that, not "Test suite ready".
    if (job.planOnly) {
        if (job.status === "QUEUED") return { label: "Waiting to start", tone: "neutral" };
        if (job.status === "COMPLETED" || job.status === "PARTIALLY_COMPLETED") return { label: "Plan ready", tone: "info" };
        if (job.status === "FAILED") return job.error === "Cancelled" ? { label: "Stopped", tone: "neutral" } : { label: "Exploration failed", tone: "danger" };
        return { label: exploring, tone: "info" };
    }
    // An agent run has its own result on its own page: here it only says how the job went.
    if (job.mode === "agent") {
        if (job.status === "QUEUED") return { label: "Waiting to start", tone: "neutral" };
        if (job.status === "COMPLETED") return { label: "Agent run passed", tone: "success" };
        if (job.status === "PARTIALLY_COMPLETED") return { label: "Agent run finished", tone: "warning" };
        if (job.status === "FAILED") return job.error === "Cancelled" ? { label: "Stopped", tone: "neutral" } : { label: "Agent run did not pass", tone: "warning" };
        return { label: "Agent run in progress", tone: "info" };
    }
    // A browser / screen-size check is not an analysis: say what it is.
    if (job.mode === "variants") {
        if (job.status === "QUEUED") return { label: "Waiting to start", tone: "neutral" };
        if (job.status === "COMPLETED") return { label: "Browser check finished", tone: "success" };
        if (job.status === "PARTIALLY_COMPLETED") return { label: "Check finished, some tests need a look", tone: "warning" };
        if (job.status === "FAILED") return job.error === "Cancelled" ? { label: "Stopped", tone: "neutral" } : { label: "Browser check failed", tone: "danger" };
        return { label: "Checking other browsers", tone: "info" };
    }
    // A test built from a description is not an analysis either.
    if (job.mode === "plain") {
        if (job.status === "QUEUED") return { label: "Waiting to start", tone: "neutral" };
        if (job.status === "COMPLETED") return { label: "Test ready", tone: "success" };
        if (job.status === "PARTIALLY_COMPLETED") return { label: "Test needs a look", tone: "warning" };
        if (job.status === "FAILED") return job.error === "Cancelled" ? { label: "Stopped", tone: "neutral" } : { label: "Test not built", tone: "danger" };
        return { label: "Building your test", tone: "info" };
    }
    // A run against a named environment (staging, production...) is not an analysis either.
    if (job.mode === "environment") {
        if (job.status === "QUEUED") return { label: "Waiting to start", tone: "neutral" };
        if (job.status === "COMPLETED") return { label: "Run finished", tone: "success" };
        if (job.status === "PARTIALLY_COMPLETED") return { label: "Run finished, some tests need a look", tone: "warning" };
        if (job.status === "FAILED") return job.error === "Cancelled" ? { label: "Stopped", tone: "neutral" } : { label: "Run failed", tone: "danger" };
        return { label: "Running on an environment", tone: "info" };
    }
    // A run of tests that already exist (mode "validate") is a run; creating tests starts with an exploration.
    const rerun = job.mode === "validate";
    switch (job.status) {
        case "QUEUED":
            return { label: "Waiting to start", tone: "neutral" };
        case "DISCOVERING":
            return { label: rerun ? "Running tests" : exploring, tone: "info" };
        case "ANALYZING":
            return { label: "Understanding your application", tone: "info" };
        case "PLANNING":
            return { label: "Planning tests", tone: "info" };
        case "GENERATING":
            return { label: "Creating test scripts", tone: "info" };
        case "VALIDATING":
            return { label: "Running tests", tone: "info" };
        case "COMPLETED":
            return { label: rerun ? "Run finished" : "Test suite ready", tone: "success" };
        case "PARTIALLY_COMPLETED":
            return { label: rerun ? "Run finished, some tests need a look" : "Ready, some tests need a look", tone: "warning" };
        case "FAILED":
            return job.error === "Cancelled" ? { label: "Stopped", tone: "neutral" } : { label: rerun ? "Run failed" : "Exploration failed", tone: "danger" };
    }
}

export const PHASES: PhaseKey[] = ["discovery", "understanding", "planning", "generation", "validation"];

/** One line per phase: what it is while pending, running, and what it achieved when done. */
export function phaseText(phase: PhaseKey, state: PhaseState, c: Counters): { title: string; detail?: string } {
    const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
    switch (phase) {
        case "discovery": {
            if (state === "done") {
                const parts = [c.pagesDiscovered ? n(c.pagesDiscovered, "page") : "", c.apisDiscovered ? n(c.apisDiscovered, "API endpoint") : ""].filter(Boolean);
                return { title: "Application explored", detail: parts.length ? `Found ${parts.join(" and ")}` : undefined };
            }
            return { title: state === "running" ? "Exploring your application…" : "Explore your application", detail: state === "running" && c.pagesDiscovered ? `${n(c.pagesDiscovered, "page")} so far` : undefined };
        }
        case "understanding":
            return state === "done"
                ? { title: "User journeys identified", detail: c.journeysIdentified ? `${n(c.journeysIdentified, "journey")} found` : undefined }
                : { title: state === "running" ? "Identifying user journeys…" : "Identify user journeys" };
        case "planning":
            return state === "done"
                ? { title: "Test ideas planned", detail: c.scenariosPlanned ? `${n(c.scenariosPlanned, "test idea")}` : undefined }
                : { title: state === "running" ? "Planning test ideas…" : "Plan test ideas" };
        case "generation":
            return state === "done"
                ? { title: "Test scripts created", detail: c.testsGenerated ? `${n(c.testsGenerated, "script")}` : undefined }
                : { title: state === "running" ? "Creating test scripts…" : "Create test scripts", detail: state === "running" && c.testsGenerated ? `${n(c.testsGenerated, "script")} so far` : undefined };
        case "validation":
            return state === "done"
                ? { title: "Tests run", detail: c.testsGenerated ? `${c.testsValidated} of ${c.testsGenerated} passed` : undefined }
                : { title: state === "running" ? "Running the tests…" : "Run the tests", detail: state === "running" ? "Running every test to make sure it works" : undefined };
    }
}

/** Overall progress 0–100 from phase states. */
export function progressPercent(job: Pick<Job, "progress" | "status">): number {
    if (!isActive(job.status)) return 100;
    const weights: Record<PhaseState, number> = { done: 1, skipped: 1, failed: 1, running: 0.5, pending: 0 };
    const total = PHASES.reduce((a, p) => a + weights[job.progress[p]], 0);
    return Math.max(4, Math.round((total / PHASES.length) * 100));
}

/**
 * Make an engine failure reason readable: drop boilerplate lead-ins and translate test-framework and
 * repair-loop fragments into plain words.
 */
export function cleanReason(r: string | null | undefined): string {
    return (r ?? "")
        .replace(/^The application did not behave as expected:\s*/i, "")
        // A missing API token: the advice stored with it (older runs named a place that is gone) is said by the failure summary instead.
        .replace(/^(The test needs the project's API token, and none is saved\.).*$/s, "$1")
        // Health / security findings: one "• problem" per line, in plain words.
        .replace(/^Page health check failed:\s*/i, "Page health check: ")
        .replace(/^Security check failed:\s*/i, "Security check: ")
        .replace(/^Page speed check failed:\s*/i, "Page speed: ")
        .replace(/^API speed check failed:\s*/i, "API speed: ")
        .replace(/^Load check failed:\s*/i, "Load check: ")
        .replace(/^Input handling check failed:\s*/i, "Input handling: ")
        .replace(/^API contract check failed:\s*/i, "API contract: ")
        .replace(/^Access control check failed:\s*/i, "Access control: ")
        .replace(/\s*-\s\[(?:critical|high|medium|low)\]\s*/g, " • ")
        // A second finding headline ("2 requests to this site failed") or the fix advice starts a new sentence.
        .replace(/([^.\s])\s*\n(?=\d+ [A-Za-z(]|How to fix:|How to check:)/g, "$1. ")
        // Playwright / assertion-library noise → what it means.
        .replace(/Error:\s*expect\([^)]*\)\.\w+\([^)]*\)(\s*\/\/\s*Object\.is equality)?(\s+failed)?/g, "the result didn’t match what the test expected")
        .replace(/Error:\s*expect\(locator\)\.\w+\(\)\s*failed/g, "the element wasn’t in the expected state")
        .replace(/locator\.\w+: Timeout \d+ms exceeded\.?/g, "the element couldn’t be found in time")
        // The automatic-repair afterthought.
        .replace(/\s*\(automatic repair skipped: no LLM configured\)/g, ". Automatic fixing isn’t available because the AI model isn’t set up.")
        .replace(/\s*\(automatic repair (?:failed|skipped)[^)]*\)/g, ". An automatic fix was tried but didn’t work.")
        .replace(/\s*\(proposed fix rejected:[^)]*\)/g, ". An automatic fix was proposed but rejected as unsafe.")
        .replace(/\s+/g, " ")
        .replace(/\.\s*\./g, ".")
        .trim();
}

// ── Errors ──────────────────────────────────────────────────────────────────

export interface FriendlyError {
    title: string;
    body: string;
    /** Where to send the user to fix it. */
    fix?: { label: string; href: string };
}

/** Raw backend/engine error text → what happened, why, and what to do. */
export function friendlyError(message: string | null | undefined): FriendlyError {
    const m = (message ?? "").trim();
    if (!m) return { title: "Something went wrong", body: "No further details are available. Try again." };
    if (/No credentials for LLM provider|LLM_BASE_URL/i.test(m)) {
        return {
            title: "The AI model isn’t set up yet",
            body: "Exploring web applications needs access to an AI model. Add your API key in the server settings, then try again. API-only testing works without one.",
            fix: { label: "Open settings", href: "#/settings" },
        };
    }
    if (/AI token limit for this (job|project|month) was reached/i.test(m)) {
        return {
            title: "AI limit reached",
            body: `${m.replace(/^.*?(The AI token limit for this (?:job|project|month) was reached).*$/i, "$1")}. Raise the limit in Settings, or wait until next month. Tests that were already created are kept.`,
            fix: { label: "Open settings", href: "#/settings" },
        };
    }
    if (/Cannot connect to API|openrouter|anthropic|rate.?limit|429|overloaded/i.test(m)) {
        return { title: "We couldn’t reach the AI service", body: "The AI service didn’t respond (network problem or rate limit). Wait a moment and try again." };
    }
    if (/found no loadable pages|ENOTFOUND|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|Could not open|net::ERR|Timeout \d+ms exceeded.*navigat/i.test(m)) {
        return { title: "We couldn’t access this application", body: "The address didn’t load. Check that the URL is correct and that the application is running and reachable from this server, then try again." };
    }
    if (/no mobile app set up/i.test(m)) {
        return { title: "Mobile tests need an app to test", body: "Choose the Android app first: open Settings, then Mobile app → Change, and add an app package or upload an .apk. Then run the tests again." };
    }
    if (/taqwright install|No Android toolchain|no emulator exists|does not exist here/i.test(m)) {
        return { title: "This computer can’t run mobile tests yet", body: "Mobile tests run on an Android emulator. On the computer that runs the platform, run “npx @taqwright/taqwright install --with-avd”, then try again." };
    }
    // A run the phone itself could not carry out (engine/mobile/device/infra.ts): the phone's problem in its own words, never a failing test of the app.
    if (/^The phone could not run the test: /.test(m)) {
        return { title: "The phone could not run the test", body: `${m.replace(/^The phone could not run the test: /, "").replace(/\nDetails:[\s\S]*$/, "").replace(/^./, (c) => c.toUpperCase())} Fix it, then run the test again; nothing about the app was judged.` };
    }
    if (/Taqwright produced no report|No Android device is set up|Validation run exceeded its time limit/i.test(m)) {
        return { title: "The Android emulator didn’t respond", body: "The emulator or its test driver didn’t start in time. An emulator needs about 3 GB of free memory — close other heavy programs and run the tests again." };
    }
    if (/isn't installed on the computer that runs the platform/i.test(m)) {
        return { title: "A browser isn’t installed here", body: `${m} To include it, run “npx playwright install” for that browser on the computer that runs the platform.` };
    }
    if (/^Nothing ran: /.test(m)) return { title: "Nothing ran", body: `${m.replace(/^Nothing ran: /, "").replace(/^./, (c) => c.toUpperCase())} Only approved versions run. Once a Project Admin approves a test, run it again.` };
    // The pages show the run's own facts (how many tests finished) when they have them; this is what is always true.
    if (/^Cancelled$/i.test(m)) return { title: "This run was stopped", body: "Tests that had not finished kept the results they had before. You can start a new run at any time." };
    if (/Worker lost|lease expired/i.test(m)) return { title: "The run was interrupted", body: "The server restarted or stopped while working. Start it again." };
    if (/No tests could be generated/i.test(m)) return { title: "No tests could be created", body: "We couldn’t build any tests for this application. Try adding a test account, or narrow the scope." };
    if (/could not be authored/i.test(m)) return { title: "Some test ideas couldn’t be turned into tests", body: m.replace(/^Scenario \S+ /, "").replace(/scenarios?/gi, (w) => (w.toLowerCase() === "scenario" ? "test idea" : "test ideas")) };
    return { title: "Something went wrong", body: m.length > 280 ? `${m.slice(0, 280)}…` : m };
}

/** A job's stored error can be several errors joined with " | ". */
export function friendlyJobErrors(error: string | null | undefined): FriendlyError[] {
    if (!error) return [];
    const parts = error.split(" | ").map((p) => p.trim()).filter(Boolean);
    const seen = new Set<string>();
    const out: FriendlyError[] = [];
    for (const p of parts) {
        const f = friendlyError(p);
        const key = f.title + (f.title === "Something went wrong" ? f.body : "");
        if (!seen.has(key)) {
            seen.add(key);
            out.push(f);
        }
    }
    return out;
}

/** API errors from user actions → a sentence for the user. */
export function describeApiError(e: unknown): string {
    if (e instanceof Error) {
        const status = (e as { status?: number }).status;
        if (status === 0) return "We couldn’t reach the platform server. Check that it is running and try again.";
        if (status === 409) return e.message.startsWith("Job ") ? "A run is already in progress for this project. Wait for it to finish or stop it first." : e.message;
        if (status === 401) return "The server requires an API key. Add it in Settings.";
        if (status === 400 && /private|loopback/i.test(e.message)) return "This server is configured to block private or local addresses.";
        return e.message;
    }
    return String(e);
}

// ── Steps in plain language ─────────────────────────────────────────────────

type Loc = { by?: string; role?: string; value?: string; nth?: number; ref?: string } | undefined;

const ROLE_NOUN: Record<string, string> = {
    button: "button",
    link: "link",
    textbox: "field",
    searchbox: "search box",
    checkbox: "checkbox",
    radio: "option",
    combobox: "dropdown",
    heading: "heading",
    tab: "tab",
    menuitem: "menu item",
    img: "image",
    listitem: "list item",
    status: "message",
    alert: "alert",
};

function humanValue(v: unknown): string {
    return String(v ?? "")
        .replace(/\{\{\s*credentials\.username\s*\}\}/g, "your test username")
        .replace(/\{\{\s*credentials\.password\s*\}\}/g, "your test password")
        .replace(/\{\{\s*unique\s*\}\}/g, "a unique value");
}
const q = (v: unknown) => `“${humanValue(v)}”`;

function target(l: Loc): string {
    const t = plainTarget(l);
    // An element inside frames says which (inner frame first), the way a person would point at it.
    const frames = (l as { frame?: Array<{ by: string; value: string }> } | undefined)?.frame;
    return frames?.length ? `${t} ${[...frames].reverse().map((f) => `inside the frame ${f.by === "title" ? "titled " : f.by === "url" ? "at " : ""}${q(f.value)}`).join(" ")}` : t;
}

function plainTarget(l: Loc): string {
    if (!l) return "the page";
    // A step that uses a shared element (object repository) names the element.
    if (l.ref !== undefined && l.by === undefined) return `the shared element “${l.ref}”`;
    const name = l.value ? ` ${q(l.value)}` : "";
    if (l.by === "role") return `the${name} ${ROLE_NOUN[l.role ?? ""] ?? l.role ?? "element"}`.replace("the “", "the “");
    if (l.by === "label" || l.by === "placeholder") return `the${name} field`;
    if (l.by === "text") return `${q(l.value)}`;
    if (l.by === "testId") return `the ${q(l.value)} element`;
    return "the element";
}

/** The passive security checks, in plain words (their step carries no value worth showing). */
const SECURITY_SENTENCE: Record<string, string> = {
    securityHeaders: "Check that the browser security headers are set",
    cookieFlags: "Check that session cookies are protected",
    corsPolicy: "Check that other websites can’t use your visitors’ logins across origins",
    noExposedFiles: "Check that none of these sensitive files can be downloaded",
    noInfoDisclosure: "Check that the server doesn’t reveal software versions or list folders",
    tlsCertificate: "Check that the HTTPS certificate is valid and not about to expire",
};

/** One sentence describing a recorded test step. */
export function stepSentence(s: any): string {
    switch (s.action) {
        case "navigate":
            return `Open ${s.url}`;
        case "click":
            return `Click ${target(s.locator)}${s.opensPopup ? " and wait for the popup" : ""}${s.inPopup ? " in the popup" : ""}`;
        case "upload":
            return `Upload the test file ${q(s.file)} to ${target(s.locator)}`;
        case "drag":
            return `Drag ${target(s.locator)} to ${target(s.target)}`;
        case "fill":
            return `Type ${q(s.value)} into ${target(s.locator)}`;
        case "select":
            return `Choose ${q(s.value)} in ${target(s.locator)}`;
        case "check":
            return `${s.checked === false ? "Uncheck" : "Check"} ${target(s.locator)}`;
        case "press":
            return `Press ${s.key}`;
        case "hover":
            return `Hover over ${target(s.locator)}`;
        case "wait":
            return `Wait ${s.ms} ms`;
        case "assert": {
            const t = target(s.locator);
            const subject = s.locator ? t : s.expected !== undefined && (s.check === "visible" || s.check === "hidden") ? q(s.expected) : "the page";
            switch (s.check) {
                case "visible":
                    return `Check that ${subject} is visible`;
                case "hidden":
                    return `Check that ${subject} is not visible`;
                case "text":
                    return `Check that ${s.locator ? t : "the page"} contains ${q(s.expected)}`;
                case "value":
                    return `Check that ${t} has the value ${q(s.expected)}`;
                case "enabled":
                    return `Check that ${t} is enabled`;
                case "disabled":
                    return `Check that ${t} is disabled`;
                case "count":
                    return `Check that there ${Number(s.expected) === 1 ? "is" : "are"} ${s.expected} of ${t}`;
                case "url":
                    return `Check that the address contains ${q(s.expected)}`;
                case "title":
                    return `Check that the page title contains ${q(s.expected)}`;
                case "a11y":
                    return `Check for accessibility problems (“${s.expected ?? "serious"}” or worse)`;
                case "screenshot":
                    return `Check that ${s.locator ? t : "the page"} looks the same as its approved screenshot`;
                case "noConsoleErrors":
                    return "Check that the page reports no script errors";
                case "noFailedRequests":
                    return "Check that no request to your site fails";
                case "noBrokenLinks":
                    return "Check that the page has no broken links";
                case "noMixedContent":
                    return "Check that no insecure (http://) content is loaded on the secure page";
                case "pageBasics":
                    return "Check that the page has a title, a language, a viewport setting and one main heading";
                case "pageSpeed":
                    return "Check that the page loads within its speed budgets (median of 3 fresh loads)";
                case "accessDenied":
                    return s.description || "Check that a restricted page stays closed to this account";
                case "looksRight":
                    return `Ask an AI reviewer whether ${s.locator ? t : "the page"} looks right${typeof s.expected === "string" && s.expected.trim() ? ` (look for: ${s.expected.trim()})` : ""}`;
                case "inputHandling":
                    return "Try harmless unusual input in the page’s forms and check nothing breaks or is shown as page markup";
            }
            return `Check ${s.check}`;
        }
        // API steps carry curated descriptions ("Send a valid GET request", "Request succeeds").
        case "request":
            return s.description || `Send ${s.method} ${s.path}`;
        case "assertResponse":
            if (SECURITY_SENTENCE[s.check]) return SECURITY_SENTENCE[s.check]!;
            return s.description || `Check the response (${s.check}${s.expected !== undefined ? ` = ${s.expected}` : ""})`;
        case "useBlock":
            return `Run the reusable steps “${s.block}”`;
        case "email":
            return s.use === "code" ? `Wait for an email to ${humanValue(s.to)} and type its code into ${target(s.locator)}` : `Wait for an email to ${humanValue(s.to)} and open its link`;
    }
    return s.description || s.action;
}

/** Status icon semantics for a step given the latest run. */
export type StepState = "passed" | "failed" | "unknown";

// ── Words that need one sentence of explanation ─────────────────────────────

/** One plain sentence for each word a tester may not know. `<Term word="…">` shows it in place (components/ui.tsx). */
export const GLOSSARY = {
    "shared element": "A button, field or link you name once, so every test that uses it finds it the same way. Fix it once and every test is fixed.",
    "reusable steps": "A set of steps you write once, like signing in, and use in many tests.",
    runner: "A computer that runs your tests, for example your own laptop or a shared team machine. It connects to this platform and takes the runs it may do.",
    finding: "Something the test noticed that may be a problem in your application, like a missing security header. The test itself works.",
    repair: "A suggested change to a test, for example for a button that was renamed. Nothing changes until you apply it.",
    "auto-fix": "A correction the platform made while it created the test, so the test would pass. The test’s history lists it.",
    quarantine: "A test in quarantine keeps running but stops counting toward pass rates, alerts and sign-off until you release it.",
    trace: "A recording of the run, step by step, with the page as it looked. Open it in the Playwright trace viewer.",
    "run sequence": "Several runs chained together, for example a quick check first and the full run only if it passes.",
    control: "A line in a security or privacy standard, such as NIST or ISO, that this test helps to show you cover.",
    "code test": "A test whose script you write and keep yourself. It is no longer made again from steps.",
} as const;
export type GlossaryWord = keyof typeof GLOSSARY;

/**
 * The platform's own sentences (readiness reasons, what changed since last time) were written before the words were decided. This puts
 * the decided words in them on screen without changing what the platform answers: an analysis is an exploration.
 */
export function plainWords(text: string): string {
    return text
        .replace(/\bnot been validated yet\b/g, "not been run yet")
        .replace(/\b([Aa])nalysed\b/g, (_m, c: string) => `${c === "A" ? "E" : "e"}xplored`)
        .replace(/\b([Aa])nalyzed\b/g, (_m, c: string) => `${c === "A" ? "E" : "e"}xplored`)
        .replace(/\b([Aa])nalysis\b/g, (_m, c: string) => `${c === "A" ? "E" : "e"}xploration`);
}
