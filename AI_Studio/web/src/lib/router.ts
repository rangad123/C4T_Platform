import { useEffect, useState } from "react";

export interface Route {
    /** Path segments, e.g. ["projects", "<id>", "tests"]. */
    parts: string[];
    query: URLSearchParams;
}

function parse(hash: string): Route {
    const raw = hash.replace(/^#/, "") || "/";
    const [path, qs] = raw.split("?");
    return { parts: path!.split("/").filter(Boolean), query: new URLSearchParams(qs ?? "") };
}

export function useRoute(): Route {
    const [hash, setHash] = useState(location.hash);
    useEffect(() => {
        const on = () => setHash(location.hash);
        addEventListener("hashchange", on);
        return () => removeEventListener("hashchange", on);
    }, []);
    return parse(hash);
}

export const go = (href: string) => {
    location.hash = href.replace(/^#/, "");
};

/**
 * The sections of the project places that hold several (the first of each is what the bare place shows). The places follow the
 * testing lifecycle (docs/product-restructure/INFORMATION_ARCHITECTURE.md; round 37 order): Dashboard, Requirements, Test cases,
 * Test scripts, Test suites, Agent runs, Runs, Settings. The older places (Library, Release, Setup) are gone; their sections live on in these.
 */
/** Test cases is one list (round 38); its "sections" are the type filters, so the old `?section=automated|manual` links still filter it. */
export const CASES_SECTIONS = ["all", "automated", "manual"] as const;
export const SCRIPTS_SECTIONS = ["scripts", "review", "steps", "elements", "helpers", "library"] as const;
export const RUNS_SECTIONS = ["runs", "schedules", "deploys", "trends", "releases", "compliance"] as const;
// Round 37: runners are machine-level, so they are not a project setting: a project's runners are on the Runners page (`projectRunners`).
export const SETTINGS_SECTIONS = ["general", "members", "environments", "data", "accounts", "ai", "frameworks", "mobile", "alerts", "issues", "storage"] as const;
export type CasesSection = (typeof CASES_SECTIONS)[number];
export type ScriptsSection = (typeof SCRIPTS_SECTIONS)[number];
export type RunsSection = (typeof RUNS_SECTIONS)[number];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The sections the old places had: their links still work and land where each section lives now (lib/aliases.ts). */
export const LIBRARY_SECTIONS = ["steps", "elements", "helpers", "data", "accounts"] as const;
export const SETUP_SECTIONS = ["runners", "frameworks", "environments", "mobile", "alerts", "issues", "storage"] as const;
export const RELEASE_SECTIONS = ["releases", "manual", "compliance"] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];
export type SetupSection = (typeof SETUP_SECTIONS)[number];
export type ReleaseSection = (typeof RELEASE_SECTIONS)[number];

/** Where an old Library section lives now: shared building blocks under Test scripts, data and accounts under Settings. */
const libraryHome = (id: string, section: LibrarySection = "steps", extra?: Record<string, string | undefined>) =>
    section === "data" || section === "accounts" ? place(id, "settings", "general", section) : place(id, "scripts", "scripts", section, extra);
/** Where an old Release section lives now: manual checks with the test cases, releases and compliance with the runs. */
const releaseHome = (id: string, section: ReleaseSection = "releases") => (section === "manual" ? place(id, "tests", "all", "manual") : place(id, "runs", "runs", section));

/** `#/projects/:id/<place>` with `?section=` only when it is not the place's first section. */
function place(id: string, name: string, first: string, section?: string, extra?: Record<string, string | undefined>): string {
    const q = new URLSearchParams();
    if (section && section !== first) q.set("section", section);
    for (const [k, v] of Object.entries(extra ?? {})) if (v) q.set(k, v);
    const s = q.toString();
    return `#/projects/${id}/${name}${s ? `?${s}` : ""}`;
}

export const routes = {
    home: "#/",
    newProject: (opts?: { project?: string; url?: string }) => {
        const q = new URLSearchParams();
        if (opts?.project) q.set("project", opts.project);
        if (opts?.url) q.set("url", opts.url);
        const s = q.toString();
        return `#/new${s ? `?${s}` : ""}`;
    },
    /** Create a project: details, platforms and testing modes (US-010). Exploring with AI is a step from the new project's dashboard. */
    createProject: "#/create",
    project: (id: string) => `#/projects/${id}`,
    /** The runnable tests: the Test scripts list (round 38; the Test cases place holds the written cases, `cases`). No query, so `?status=` etc. can follow. */
    tests: (id: string) => `#/projects/${id}/scripts`,
    /** The Test scripts list with one way of making a script already open: described in words, or step by step. */
    newTest: (id: string, how: "describe" | "build") => `#/projects/${id}/scripts?start=${how}`,
    /** What happened: the run list, Schedules, After a deploy, Trends. */
    runs: (id: string, section?: RunsSection) => place(id, "runs", "runs", section),
    /** One run opened: its tests, what changed, ways to run again. */
    run: (id: string, jobId: string) => `#/projects/${id}/runs/${jobId}`,
    /** Scheduled runs (a run sequence message links to one run with `run`). */
    schedule: (id: string, run?: string) => place(id, "runs", "runs", "schedules", { run }),
    /** Requirements: what the application must do, and which test cases cover it. */
    requirements: (id: string) => `#/projects/${id}/requirements`,
    /** One requirement: what it says and the test cases that cover it. */
    requirement: (id: string, rid: string) => `#/projects/${id}/requirements/${rid}`,
    /** Test cases: the written cases, all of them or one type (automated, manual). */
    cases: (id: string, section?: CasesSection) => place(id, "tests", "all", section),
    /** One written test case opened on the Test cases list. */
    testCase: (id: string, caseId: string) => place(id, "tests", "all", undefined, { case: caseId }),
    /** Test suites: ordered groups of test cases with how they run. */
    suites: (id: string) => `#/projects/${id}/suites`,
    /** One suite a person built: its ordered tests, how it runs, its runs. */
    suite: (id: string, suiteId: string) => `#/projects/${id}/suites/${suiteId}`,
    /** Test scripts: the scripts themselves and the building blocks they share. `edit` opens one set of reusable steps. */
    scripts: (id: string, section?: ScriptsSection, edit?: string) => place(id, "scripts", "scripts", section, { edit }),
    /** Agent runs: the AI pursues an objective in a real browser (flow B). */
    agentRuns: (id: string) => `#/projects/${id}/agent`,
    /** One agent run: live while it goes, then its result. */
    agentRun: (id: string, runId: string) => `#/projects/${id}/agent/${runId}`,
    /** The project's settings, one section open. */
    projectSettings: (id: string, section?: SettingsSection) => place(id, "settings", "general", section),
    /** Where tests run: the runners this project may use, on the Runners page (round 37: not inside the project). */
    runners: (id: string) => `#/runners?project=${encodeURIComponent(id)}`,
    /** The old Setup place: each section is a Settings section of the same name; its Runners section is on the Runners page. */
    setup: (id: string, section?: SetupSection) => (section === "runners" ? `#/runners?project=${encodeURIComponent(id)}` : place(id, "settings", "general", section)),
    /** The old Library place: each section moved (`libraryHome`). */
    library: (id: string, section?: LibrarySection) => libraryHome(id, section),
    objects: (id: string) => libraryHome(id, "elements"),
    /** Reusable steps of a project. `edit` opens one set of them for change. */
    blocks: (id: string, edit?: string) => libraryHome(id, "steps", { edit }),
    record: (id: string, session?: string) => `#/projects/${id}/record${session ? `?session=${encodeURIComponent(session)}` : ""}`,
    /** The old Release place: each section moved (`releaseHome`). */
    releaseHub: (id: string, section?: ReleaseSection) => releaseHome(id, section),
    compliance: (id: string) => releaseHome(id, "compliance"),
    releases: (id: string) => releaseHome(id, "releases"),
    release: (id: string, releaseId: string) => `#/projects/${id}/release/${releaseId}`,
    manualCases: (id: string) => releaseHome(id, "manual"),
    /** A test's workbench: the bare route opens Steps. */
    test: (id: string) => `#/tests/${id}`,
    /** One tab of a test's workbench (DSL, Code, Steps, History; the DSL tab's route is `text`, and `dsl` is an alias of it). */
    testTab: (id: string, tab: "steps" | "text" | "code" | "history") => `#/tests/${id}/${tab}`,
    /** The script editor of a test (hand-written tests). `history` opens the version history, `job` shows the run a save started. */
    code: (id: string, opts?: { history?: boolean; job?: string | null; note?: string; version?: number; saved?: boolean }) => {
        const q = new URLSearchParams();
        if (opts?.history) q.set("history", "1");
        if (opts?.saved) q.set("saved", "1");
        if (opts?.job) q.set("job", opts.job);
        if (opts?.note) q.set("note", opts.note);
        if (opts?.version !== undefined) q.set("version", String(opts.version));
        const s = q.toString();
        return `#/tests/${id}/code${s ? `?${s}` : ""}`;
    },
    /** The step editor of a generated test: the Steps tab of its workbench (`#/tests/:id/builder` still opens it, as an alias). */
    builder: (id: string) => `#/tests/${id}/steps`,
    helpers: (id: string) => libraryHome(id, "helpers"),
    /** Write a test from scratch: the editor opens with a starter script for the chosen kind. */
    writeCode: (id: string, opts: { title: string; kind: "web" | "api"; category?: string }) => {
        const q = new URLSearchParams({ title: opts.title, kind: opts.kind });
        if (opts.category) q.set("category", opts.category);
        return `#/projects/${id}/write-code?${q.toString()}`;
    },
    /** The global places (docs/product-restructure/INFORMATION_ARCHITECTURE.md). `home` stays the project list. */
    dashboard: "#/dashboard",
    develop: "#/develop",
    allRunners: "#/runners",
    runner: (id: string) => `#/runners/${id}`,
    /** Integrations: every system the projects connect to, set up once for an organisation, and which projects use each. */
    integrations: "#/integrations",
    /** An old link (the Folders place of round 34): it lands on Reusable libraries (lib/aliases.ts). */
    folders: "#/folders",
    /** Reusable libraries of an organisation (round 37); `?org=&folder=&item=` (features/libraries/LibrariesPage.tsx, libraryHref). */
    libraries: "#/libraries",
    /** Grouping projects into folders, opened from the Projects page (it was the Folders place). */
    projectFolders: "#/project-folders",
    /** The testing agents, and one agent opened (features/testing-agents). */
    agents: "#/agents",
    agent: (id: string) => `#/agents/${encodeURIComponent(id)}`,
    profile: "#/profile",
    settings: "#/settings",
    /** The in-app guide: the "I want to…" chooser, one topic, and the words page. */
    guide: "#/guide",
    guideTopic: (topicId: string) => `#/guide/${encodeURIComponent(topicId)}`,
    guideWords: "#/guide/words",
};
