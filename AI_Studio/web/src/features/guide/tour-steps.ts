import { routes, type LibrarySection, type ReleaseSection, type RunsSection, type SettingsSection, type SetupSection } from "../../lib/router.js";

/**
 * The guided tour: chapters and steps, in order. Each step points at a real element marked `data-tour="<target>"` in the app.
 * `page` is where the element is; the tour takes the person there. It only ever opens pages: it never clicks anything, never opens
 * a dialog or a menu, and never sends anything but GET requests. A step whose need is missing is left out when the tour starts;
 * a step whose element is not on the page is passed over quietly while the tour runs, and the counter says the real number.
 */

export type ChapterId = "around" | "making" | "running" | "release" | "phones" | "security" | "help";

export interface Chapter {
    id: ChapterId;
    title: string;
    /** One line for the chapter list. */
    about: string;
}

export const CHAPTERS: Chapter[] = [
    { id: "around", title: "Getting around", about: "The sidebar and the places of a project." },
    { id: "making", title: "Making tests", about: "Every way to make a test, and the page of one test." },
    { id: "running", title: "Running and results", about: "Starting and stopping runs, and reading what happened." },
    { id: "release", title: "Release and settings", about: "Signing off a version, and where and how tests run." },
    { id: "phones", title: "Phones", about: "Your phone app, and the AI exploring it." },
    { id: "security", title: "Security assessment", about: "Authorized, read-only checks of a client’s application." },
    { id: "help", title: "Help", about: "Where to find answers, and this tour again." },
];

export const chapterTitle = (id: ChapterId): string => CHAPTERS.find((c) => c.id === id)!.title;

/** Where a step's element is. Pages inside a project use the tour's project; `test` and `failing` use one of its tests. */
export type TourPage =
    | { kind: "any" }
    | { kind: "home" }
    | { kind: "project" }
    | { kind: "tests" }
    | { kind: "test"; tab: "steps" | "text" | "code" | "history" }
    /** A test that is failing (the first one), else the first test: its last run shows the failure. */
    | { kind: "failing" }
    | { kind: "runs"; section: RunsSection }
    /** The latest run of the project. */
    | { kind: "run" }
    | { kind: "library"; section: LibrarySection }
    | { kind: "release"; section: ReleaseSection }
    /** The latest release of the project. */
    | { kind: "release-detail" }
    | { kind: "setup"; section: SetupSection }
    /** Your runner in Settings (round 45: one runner per person, no Runners pages). */
    | { kind: "runners" }
    | { kind: "settings"; section: SettingsSection }
    | { kind: "security-home" }
    | { kind: "security"; section: "overview" | "applications" | "findings" | "reports" }
    | { kind: "guide" };

/**
 * What a step cannot do without.
 * project: a project to show. test: one of its tests. job: a run of it. release: a release of it. functional: the project is for
 * functional testing (not security assessment only). phone: it has a phone app. module: the Security Assessment module is on.
 * security: the project includes security assessment. account: a person (or key) is signed in, so the account is in the sidebar.
 */
export type Need = "project" | "test" | "job" | "release" | "functional" | "phone" | "module" | "security" | "account";

export interface TourStep {
    id: string;
    chapter: ChapterId;
    /** The `data-tour` value of the element to point at. A step without one is a plain card. */
    target?: string;
    /** Another element on the same page to point at when the target is not there (for example Run, when no run is going). */
    alt?: string;
    page: TourPage;
    needs?: Need[];
    title: string;
    text: string;
}

const P: Need[] = ["project", "functional"];
const any = { kind: "any" } as const;
const project = { kind: "project" } as const;
const tests = { kind: "tests" } as const;

export const TOUR_STEPS: TourStep[] = [
    // ── Getting around ──
    { id: "nav-dashboard", chapter: "around", target: "nav-dashboard", page: any, title: "Dashboard", text: "How all your projects are doing, the machines that run them, and the AI they use." },
    { id: "projects", chapter: "around", target: "nav-projects", page: any, title: "Your projects", text: "Each project is one application you test. Projects lists them all, with how each one is doing." },
    { id: "nav-agents", chapter: "around", target: "nav-agents", page: any, title: "Agents", text: "The kinds of checking the AI does when it explores an application. Open one to see what it checks and which projects use it." },
    { id: "nav-develop", chapter: "around", target: "nav-develop", page: any, title: "Test development", text: "Start writing tests in any of your projects: with the AI, by recording, step by step or as code." },
    { id: "nav-libraries", chapter: "around", target: "nav-libraries", page: any, title: "Reusable libraries", text: "Reusable steps, helpers and shared elements your organisation's projects share. A project takes a copy and updates it when it chooses." },
    { id: "nav-integrations", chapter: "around", target: "nav-integrations", page: any, title: "Integrations", text: "Issue trackers, Sentry, alert channels and the other systems your projects connect to. Set one up once, then choose the projects that use it." },
    { id: "nav-settings", chapter: "around", target: "nav-settings", page: any, title: "Settings", text: "Your runner, and how the platform itself is set up: the AI model, and people and their access." },
    { id: "nav-help", chapter: "around", target: "nav-help", page: any, title: "Help in the sidebar", text: "Opens the Help panel for the page you are on. The full Guide is one click from there." },
    { id: "account", chapter: "around", target: "nav-account", page: any, needs: ["account"], title: "Who you are", text: "Who is using the platform, and their role. Sign out here, or forget the access key, when you are done." },
    { id: "places", chapter: "around", target: "project-tabs", page: project, needs: P, title: "The places of a project", text: "An AI agent project has Dashboard, Runs, Requirements and Settings. A code project also has Test cases, Test scripts and Test suites." },
    { id: "tab-overview", chapter: "around", target: "tab-overview", page: project, needs: P, title: "Dashboard: is it healthy?", text: "The latest results, the tests that need you, and the next scheduled run. A good first stop each day." },
    { id: "tab-requirements", chapter: "around", target: "tab-requirements", page: project, needs: P, title: "Requirements", text: "What the application must do, and which test cases check it." },
    { id: "tab-tests", chapter: "around", target: "tab-tests", page: project, needs: P, title: "Test cases: the written checks", text: "Code projects: each test case's steps, what should happen and its requirement. Automated ones can become test scripts; Manual ones are done by a person." },
    { id: "tab-scripts", chapter: "around", target: "tab-scripts", page: project, needs: P, title: "Test scripts: what runs", text: "Code projects: every runnable test script, in the DSL and as code. Run them, make new ones, review their versions, and share steps, elements and helpers." },
    { id: "tab-suites", chapter: "around", target: "tab-suites", page: project, needs: P, title: "Test suites", text: "Code projects: groups of test cases that run together." },
    { id: "runs", chapter: "around", target: "tab-runs", page: project, needs: P, title: "Runs: what happened", text: "Every exploration and every run of tests is kept here, with schedules and trends." },
    { id: "tab-settings", chapter: "around", target: "tab-settings", page: project, needs: P, title: "Settings: the project's setup", text: "Members, the app, environments, test data and accounts, alerts, the issue tracker and storage. Most of it is set once." },

    // ── Making tests ──
    { id: "new-test", chapter: "making", target: "new-test", page: tests, needs: P, title: "Make a test script", text: "New test script lists every way to make one. Each way says in a line what it does and what it needs." },
    { id: "new-describe", chapter: "making", target: "new-test", page: tests, needs: P, title: "Describe it in words", text: "Choose Describe it and say what the test should do. The AI writes the steps, and you can read and change every one." },
    { id: "new-build", chapter: "making", target: "new-test", page: tests, needs: P, title: "Build it step by step", text: "Choose Build steps by hand to add steps one at a time, or Write it as text for one line per step. The script is made for you." },
    { id: "new-code", chapter: "making", target: "new-test", page: tests, needs: P, title: "Write code", text: "Choose Write code to write the script yourself. A code test runs only where code tests are allowed." },
    { id: "new-import", chapter: "making", target: "new-test", page: tests, needs: P, title: "Import scripts", text: "Choose Import scripts… to bring scripts from a JSON file, Maestro flows or a Git repository. Import beside it does the same." },
    { id: "test-tabs", chapter: "making", target: "workbench-tabs", page: { kind: "test", tab: "steps" }, needs: [...P, "test"], title: "One page for each test", text: "DSL, Code, Steps and History show the same test in four ways. Change it in one and the others follow." },
    { id: "wb-steps", chapter: "making", target: "wb-steps", page: { kind: "test", tab: "steps" }, needs: [...P, "test"], title: "Steps", text: "Each step in plain words. Add, change, move or remove steps here." },
    { id: "wb-save", chapter: "making", target: "wb-edit", page: { kind: "test", tab: "steps" }, needs: [...P, "test"], title: "Save, or Save and run", text: "Change a step and a bar shows Save and Save and run, with what changed. Saving never starts a run by itself." },
    { id: "wb-text", chapter: "making", target: "wb-text", page: { kind: "test", tab: "text" }, needs: [...P, "test"], title: "DSL", text: "The same test as one line per step, in fixed words. Some people find typing faster than clicking." },
    { id: "wb-code", chapter: "making", target: "wb-code", page: { kind: "test", tab: "code" }, needs: [...P, "test"], title: "Code", text: "The script that runs, made from the steps. Switch to code when you want to change the script by hand." },
    { id: "wb-history", chapter: "making", target: "wb-history", page: { kind: "test", tab: "history" }, needs: [...P, "test"], title: "History", text: "Every saved version and what changed in it. Restore this version takes the test back to any of them." },
    { id: "lib-steps", chapter: "making", target: "scripts-steps", page: { kind: "library", section: "steps" }, needs: P, title: "Reusable steps", text: "Named groups of steps, such as signing in, that many tests use. Change them here once." },
    { id: "lib-elements", chapter: "making", target: "scripts-elements", page: { kind: "library", section: "elements" }, needs: P, title: "Shared elements", text: "Buttons and fields named once and used by many tests. When one moves on the page, fix it here once." },
    { id: "lib-data", chapter: "making", target: "settings-data", page: { kind: "library", section: "data" }, needs: P, title: "Test data", text: "Tables of values tests read, files they upload, the reset before a run, and the records tests create." },

    // ── Running and results ──
    { id: "run", chapter: "running", target: "run", page: tests, needs: P, title: "Run tests", text: "Run starts tests now. Its panel asks which tests, on which computer, and against which environment when you have more than one." },
    { id: "run-strip", chapter: "running", target: "run-strip", alt: "run", page: tests, needs: P, title: "Watch and stop a run", text: "While tests run, a strip on this page shows each test as it finishes. Stop run stops it and keeps the results so far." },
    { id: "runs-all", chapter: "running", target: "runs-runs", page: { kind: "runs", section: "runs" }, needs: P, title: "All runs", text: "Every exploration and every run, newest first. Open one to see what happened." },
    { id: "run-detail", chapter: "running", target: "run-tests", page: { kind: "run" }, needs: [...P, "job"], title: "One run", text: "Each test’s result in this run, failures first, and what changed since the run before." },
    { id: "failure", chapter: "running", target: "last-run", page: { kind: "failing" }, needs: [...P, "test"], title: "Why a test failed", text: "Last run says how the test did. A failure shows the step, expected and actual, and the screenshot, recording and trace when there are some." },
    { id: "schedules", chapter: "running", target: "runs-schedules", page: { kind: "runs", section: "schedules" }, needs: P, title: "Schedules", text: "Run tests on a timetable, such as every night, and get told when something changes." },
    { id: "trends", chapter: "running", target: "runs-trends", page: { kind: "runs", section: "trends" }, needs: P, title: "Trends and unreliable tests", text: "How results develop over time, and which tests pass and fail on the same code. Quarantine holds those back from alarms." },

    // ── Release and Setup ──
    { id: "releases", chapter: "release", target: "runs-releases", page: { kind: "release", section: "releases" }, needs: P, title: "Releases", text: "One release per version you want to ship, with its automated results and manual checks together." },
    { id: "signoff", chapter: "release", target: "release-signoff", page: { kind: "release-detail" }, needs: [...P, "release"], title: "The decision", text: "Sign-off lists anything that stands in the way of approval. Approve or Reject records who decided, when and why." },
    { id: "manual", chapter: "release", target: "tests-manual", page: { kind: "release", section: "manual" }, needs: P, title: "Manual test cases", text: "Test cases a person does by hand. Manual shows only them; a release counts them in its sign-off." },
    { id: "compliance", chapter: "release", target: "runs-compliance", page: { kind: "release", section: "compliance" }, needs: P, title: "Compliance", text: "Which security-control topics your tests touch, from the tests you already have." },
    { id: "runners", chapter: "release", target: "your-runner", page: { kind: "runners" }, needs: P, title: "Your runner", text: "A runner is the program on your computer that runs your tests. Set it up once here: download it, start it, and every run you start goes to it." },
    { id: "environments", chapter: "release", target: "settings-environments", page: { kind: "setup", section: "environments" }, needs: P, title: "Environments", text: "Staging, production and other addresses to run against. Production is read-only: nothing risky runs there without asking." },
    { id: "alerts", chapter: "release", target: "settings-alerts", page: { kind: "setup", section: "alerts" }, needs: P, title: "Alerts", text: "Who is told when a run finds something: Slack, Teams, email or a webhook." },
    { id: "issues", chapter: "release", target: "settings-issues", page: { kind: "setup", section: "issues" }, needs: P, title: "Issue tracker", text: "Connect GitHub, Jira or Notion to file a problem straight from a failing test." },
    { id: "device-farms", chapter: "release", target: "mobile-app", page: { kind: "setup", section: "mobile" }, needs: P, title: "Device farms", text: "Under Mobile app, a device farm runs phone tests on real phones in the cloud instead of a phone on this computer." },
    { id: "storage", chapter: "release", target: "settings-storage", page: { kind: "setup", section: "storage" }, needs: P, title: "Storage and backup", text: "What the files use, how long they are kept, and a backup of the project to download or restore." },
    { id: "testing-type", chapter: "release", target: "testing-type", page: { kind: "settings", section: "general" }, needs: ["project", "module"], title: "Testing type", text: "Functional testing, security assessment, or both. Changing it never deletes anything." },

    // ── Phones ──
    { id: "phone-app", chapter: "phones", target: "settings-mobile", page: { kind: "setup", section: "mobile" }, needs: [...P, "phone"], title: "Your phone app", text: "Mobile app holds the Android or iPhone app your phone tests run against. Change it here." },
    { id: "explore-phone", chapter: "phones", target: "explore-phone", page: { kind: "setup", section: "mobile" }, needs: [...P, "phone"], title: "Explore the phone app", text: "Explore with AI first says what the AI will do. It taps through your Android app and stops at a plan for you to approve." },
    { id: "phone-ready", chapter: "phones", target: "phone-ready", alt: "settings-mobile", page: { kind: "setup", section: "mobile" }, needs: [...P, "phone"], title: "Is the phone ready?", text: "Each connected phone is checked before tests run on it, with the exact steps for anything to fix. Phone test settings below say where tests run and how thorough the AI is." },
    { id: "explorer-view", chapter: "phones", target: "explorer-view", alt: "tab-overview", page: project, needs: [...P, "phone"], title: "Watch the AI explore", text: "While the AI explores, Overview has a Watch live switch. It shows the screen the AI sees, as it happens." },

    // ── Security assessment ──
    { id: "sec-home", chapter: "security", target: "sec-projects", page: { kind: "security-home" }, needs: ["project", "module", "security"], title: "Security home", text: "Every project that includes security assessment. Open one to see its own pages." },
    { id: "sec-tabs", chapter: "security", target: "sec-overview", page: { kind: "security", section: "overview" }, needs: ["project", "module", "security"], title: "A project’s security work", text: "Its own tabs, apart from the tests. Overview counts the open findings and what awaits review." },
    { id: "sec-apps", chapter: "security", target: "sec-applications", page: { kind: "security", section: "applications" }, needs: ["project", "module", "security"], title: "Applications and authorization", text: "Register what may be assessed, then record the client’s authorization. Nothing is sent to the application before that." },
    { id: "sec-new", chapter: "security", target: "sec-new", page: { kind: "security", section: "overview" }, needs: ["project", "module", "security"], title: "New assessment", text: "A passive, read-only look at one authorized application. It makes only the requests a visitor’s browser makes." },
    { id: "sec-assessments", chapter: "security", target: "sec-assessments", page: { kind: "security", section: "overview" }, needs: ["project", "module", "security"], title: "Assessment progress", text: "Assessments lists every one. Open one to follow its progress while it runs, and its coverage and limits after." },
    { id: "sec-stop", chapter: "security", target: "sec-stop", page: { kind: "security", section: "overview" }, needs: ["project", "module", "security"], title: "Emergency stop", text: "Stops every running assessment of this project within seconds. You confirm first, and what they found is kept." },
    { id: "sec-findings", chapter: "security", target: "sec-findings", page: { kind: "security", section: "findings" }, needs: ["project", "module", "security"], title: "Findings and their states", text: "Each finding has a state: Needs a look, Probable, Confirmed, Risk accepted, Not a problem or Fixed. Change it as you check them." },
    { id: "sec-reports", chapter: "security", target: "sec-downloads", alt: "sec-reports", page: { kind: "security", section: "reports" }, needs: ["project", "module", "security"], title: "Reports and Excel", text: "Download the report as a PDF for the client, or the findings as CSV or as an Excel workbook." },
    { id: "sec-activity", chapter: "security", target: "sec-activity", page: { kind: "security", section: "overview" }, needs: ["project", "module", "security"], title: "Activity", text: "Who did what in this project’s security work, and when. Newest first." },
    { id: "sec-notifications", chapter: "security", target: "sec-notifications", page: { kind: "security", section: "overview" }, needs: ["project", "module", "security"], title: "Notifications", text: "Who is told when an assessment ends, and when: for example only when it finds something critical or high." },

    // ── Help ──
    { id: "help", chapter: "help", target: "help", page: any, title: "Help is always here", text: "The Help button explains the page you are on, answers questions and brings you back to this tour." },
    { id: "guide", chapter: "help", target: "guide-wants", page: { kind: "guide" }, title: "The Guide", text: "Every topic in plain words, starting with what you want to do. Words lists every term the platform uses." },
    { id: "tips", chapter: "help", page: any, title: "Question marks and tips", text: "A question mark beside a field, number or heading explains it. Rest the pointer on a button, or tab to it, to see what it does." },
    { id: "again", chapter: "help", target: "guide-tour", page: { kind: "guide" }, title: "Take the tour again", text: "Start it here or from Help, from the beginning or at one chapter. If you stop early, it offers to go on where you stopped." },
];

/** Shown instead of the steps that need a project, when there is none yet. */
export const NO_PROJECT_STEP: TourStep = { id: "no-project", chapter: "around", page: any, title: "The rest needs a project", text: "You have no project yet. Start one from the welcome page, then take the tour again from Help to see the tabs, New test and Run." };

/** What the tour found when it started. Every field is read with GET requests only. */
export interface TourHave {
    project?: string;
    test?: string;
    /** A failing test of the project, if there is one. */
    failing?: string;
    job?: string;
    release?: string;
    /** The project's testing type leaves out functional testing (security assessment only). */
    securityOnly?: boolean;
    phone?: boolean;
    module?: boolean;
    security?: boolean;
    account?: boolean;
}

function has(need: Need, h: TourHave): boolean {
    switch (need) {
        case "project":
            return Boolean(h.project);
        case "test":
            return Boolean(h.test);
        case "job":
            return Boolean(h.job);
        case "release":
            return Boolean(h.release);
        case "functional":
            return !h.securityOnly;
        case "phone":
            return Boolean(h.phone);
        case "module":
            return Boolean(h.module);
        case "security":
            return Boolean(h.security);
        case "account":
            return Boolean(h.account);
    }
}

/** The steps that apply to this person right now: with no project, the ones that need one become one plain card. */
export function stepsFor(h: TourHave): TourStep[] {
    const out: TourStep[] = [];
    let noted = false;
    for (const s of TOUR_STEPS) {
        const needs = s.needs ?? [];
        if (needs.every((n) => has(n, h))) out.push(s);
        else if (needs.includes("project") && !h.project && !noted) {
            out.push(NO_PROJECT_STEP);
            noted = true;
        }
    }
    return out;
}

/** The chapters these steps make, in order, each with its first index and its number of steps. */
export function chaptersOf(steps: TourStep[]): Array<Chapter & { first: number; count: number }> {
    const out: Array<Chapter & { first: number; count: number }> = [];
    steps.forEach((s, i) => {
        const last = out[out.length - 1];
        if (last && last.id === s.chapter) last.count++;
        else out.push({ ...CHAPTERS.find((c) => c.id === s.chapter)!, first: i, count: 1 });
    });
    return out;
}

/** The first step of the chapter after the one step `index` is in, or -1 when it is the last chapter. */
export function nextChapterStart(steps: TourStep[], index: number): number {
    const here = steps[index]?.chapter;
    for (let i = index + 1; i < steps.length; i++) if (steps[i]!.chapter !== here) return i;
    return -1;
}

/** The counter, leaving out steps passed over: "Step 7 of 31". */
export function counter(index: number, total: number, skipped: ReadonlySet<number>): { position: number; total: number } {
    let before = 0;
    for (const s of skipped) if (s < index) before++;
    return { position: index + 1 - before, total: total - skipped.size };
}

/** Where to take the person for a step, or null when the step can be shown on any page or needs something that is not there. */
export function pageHref(page: TourPage, h: TourHave): string | null {
    const p = h.project;
    switch (page.kind) {
        case "any":
            return null;
        case "home":
            return routes.home;
        case "guide":
            return routes.guide;
        case "security-home":
            return "#/security";
        case "test":
            return h.test ? routes.testTab(h.test, page.tab) : null;
        case "failing": {
            const t = h.failing ?? h.test;
            return t ? routes.testTab(t, "steps") : null;
        }
    }
    if (!p) return null;
    switch (page.kind) {
        case "project":
            return routes.project(p);
        case "tests":
            return routes.tests(p);
        case "runs":
            return routes.runs(p, page.section);
        case "run":
            return h.job ? routes.run(p, h.job) : null;
        case "library":
            return routes.library(p, page.section);
        case "release":
            return routes.releaseHub(p, page.section);
        case "release-detail":
            return h.release ? routes.release(p, h.release) : null;
        case "setup":
            return routes.setup(p, page.section);
        case "runners":
            return routes.allRunners;
        case "settings":
            return routes.projectSettings(p, page.section);
        case "security":
            return `#/projects/${p}/security${page.section === "overview" ? "" : `/${page.section}`}`;
    }
}

/** Whether the address is already the page a step is on (so the tour does not reload it). A step for any page is always there. */
export function onPage(page: TourPage, hash: string, h: TourHave): boolean {
    const href = pageHref(page, h);
    if (!href) return true;
    const norm = (x: string) => x.replace(/^#/, "").replace(/\/$/, "") || "/";
    return norm(hash) === norm(href);
}
