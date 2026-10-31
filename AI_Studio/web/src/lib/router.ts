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
 * testing lifecycle (docs/product-restructure/INFORMATION_ARCHITECTURE.md): Dashboard, Requirements, Test cases, Test suites, Test
 * scripts, Agent runs, Runs, Settings. The older places (Library, Release, Setup) are gone; their sections live on in these.
 */
export const CASES_SECTIONS = ["automated", "manual"] as const;
export const SCRIPTS_SECTIONS = ["scripts", "steps", "elements", "helpers"] as const;
export const RUNS_SECTIONS = ["runs", "schedules", "deploys", "trends", "releases", "compliance"] as const;
export const SETTINGS_SECTIONS = ["general", "members", "environments", "data", "accounts", "ai", "runners", "frameworks", "mobile", "alerts", "issues", "storage"] as const;
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
const releaseHome = (id: string, section: ReleaseSection = "releases") => (section === "manual" ? place(id, "tests", "automated", "manual") : place(id, "runs", "runs", section));

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
    tests: (id: string) => `#/projects/${id}/tests`,
    /** What happened: the run list, Schedules, After a deploy, Trends. */
    runs: (id: string, section?: RunsSection) => place(id, "runs", "runs", section),
    /** One run opened: its tests, what changed, ways to run again. */
    run: (id: string, jobId: string) => `#/projects/${id}/runs/${jobId}`,
    /** Scheduled runs (a run sequence message links to one run with `run`). */
    schedule: (id: string, run?: string) => place(id, "runs", "runs", "schedules", { run }),
    /** Requirements: what the application must do, and which test cases cover it. */
    requirements: (id: string) => `#/projects/${id}/requirements`,
    /** Test cases: automated and manual, one section open. */
    cases: (id: string, section?: CasesSection) => place(id, "tests", "automated", section),
    /** Test suites: ordered groups of test cases with how they run. */
    suites: (id: string) => `#/projects/${id}/suites`,
    /** Test scripts: the scripts themselves and the building blocks they share. `edit` opens one set of reusable steps. */
    scripts: (id: string, section?: ScriptsSection, edit?: string) => place(id, "scripts", "scripts", section, { edit }),
    /** Agent runs: the AI pursues an objective on a runner (flow B). */
    agentRuns: (id: string) => `#/projects/${id}/agent`,
    /** The project's settings, one section open. */
    projectSettings: (id: string, section?: SettingsSection) => place(id, "settings", "general", section),
    /** Where tests run: the runners this project may use. */
    runners: (id: string) => place(id, "settings", "general", "runners"),
    /** The old Setup place: each section is a Settings section of the same name. */
    setup: (id: string, section?: SetupSection) => place(id, "settings", "general", section ?? "runners"),
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
    /** One tab of a test's workbench (Steps, Text, Code, History). */
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
    folders: "#/folders",
    profile: "#/profile",
    settings: "#/settings",
    /** The in-app guide: the "I want to…" chooser, one topic, and the words page. */
    guide: "#/guide",
    guideTopic: (topicId: string) => `#/guide/${encodeURIComponent(topicId)}`,
    guideWords: "#/guide/words",
};
