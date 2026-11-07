import type { PlatformConfig } from "../../api.js";
import { useConfig, useFetch, type Fetched } from "../../lib/hooks.js";

/** Said before a click wherever a run or an exploration would start, while tests are switched off on this server (no worker). */
export const RUNS_OFF_HERE = "Tests are switched off on this server, so no run starts here.";
export const RUNS_OFF_TIP = "Tests are switched off on this server: a run started here would never start.";
export const EXPLORING_OFF_HERE = "Tests are switched off on this server, so exploring does not start here.";

/** False only when the server says runs cannot start here; true until it answers (and on an older server that does not say). */
export function useRunsHere(): boolean {
    return useConfig()?.runsHere !== false;
}

// ── runs that happen only on runners (EXECUTION_MODE=runners: the hosted platform never runs a test itself) ──────────────

/** "local": the server may run tests itself (self-hosting, development). "runners": every run goes to a runner on someone's computer. */
export type ExecutionMode = "local" | "runners";

/** The platform's execution mode; "local" until it answers and from a server that does not say. */
export function executionModeOf(config: PlatformConfig | undefined): ExecutionMode {
    return config?.executionMode === "runners" ? "runners" : "local";
}
export function useExecutionMode(): ExecutionMode {
    return executionModeOf(useConfig());
}

/** One runner the person may choose for a run in this project (`GET /api/projects/:id/runner-choices`): their own computers and the team runners given to the project. */
export interface RunnerChoiceRow {
    /** The runner's id: what a run-start route takes as `runnerId`. */
    id: string;
    name: string;
    /** "personal": one person's own computer, which takes only that person's runs. "team": a shared machine. */
    kind: "personal" | "team";
    /** The caller's own computer. */
    mine: boolean;
    online: boolean;
    /** Online, and working on another run right now: a run sent to it waits until it is free. */
    busy: boolean;
    machine: { os: string; osVersion?: string; arch: string } | null;
    canRunWeb: boolean;
    canRunMobile: boolean;
    /** It takes code scripts (hand-written, imported or from Git). */
    codeScripts: boolean;
    /** The server's sentence when the person cannot use it here (for example a personal runner in a project that does not allow them). */
    problem: string | null;
}
export interface RunnerChoices {
    runners: RunnerChoiceRow[];
    /** The project allows people's own computers ("Allow people's own computers" on the Runners page). */
    allowPersonal: boolean;
    /** The project's default runner, when one is set; without one any runner that may take the run does. */
    defaultRunnerId: string | null;
}

/** What the platform answers in runners mode when an exploration or a described test is asked for (src/platform/runner-only.ts), said before the click. */
export const EXPLORING_ON_RUNNERS = "Exploring an application is not available here yet: the AI explores it with a browser on the server, and this platform runs tests only on runners. Build tests by hand, record them on a runner, or import them.";
export const PLAIN_ON_RUNNERS = "Describing a test in your own words is not available here yet: the AI builds and checks it with a browser on the server, and this platform runs tests only on runners. Build the steps by hand or write the test as text instead.";

/** Before a run sends code scripts to the person's own computer. */
export function codeScriptsNotice(authors: string[]): string {
    const names = authors.length <= 1 ? authors.join("") : `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}`;
    return names ? `This run includes code scripts written by ${names}. They run on your computer with your user’s rights.` : "This run includes code scripts. They run on your computer with your user’s rights.";
}

/** Where people add their own computer: the Runners page opens "Add this computer" with `?add=computer` (features/runners/runners.ts ADD_COMPUTER_HREF). */
export const ADD_THIS_COMPUTER_HREF = "#/runners?add=computer";

export const NO_RUNNER_TITLE = "No runner you can use is online";
/** In runners mode, while no runner the person may use for this project is online. */
export const NO_RUNNER_ONLINE = "No runner you can use for this project is online.";
export const NO_RUNNER_PERSONAL_HINT = "Tests run on runners only: your own computer or a team runner. Add this computer, or start a runner you added. Runners you added start again when you sign in to that computer.";
export const NO_RUNNER_TEAM_HINT = "This project runs tests on team runners only. Ask someone who manages runners to start one, or to give one to this project.";
export const NO_RUNNER_TIP = "No runner you can use for this project is online. Open the Run panel to see why and what to do.";
/** Runners mode, while the part of the platform that hands runs to runners is not running (the server says runs cannot start). */
export const DISPATCH_OFF = "Runs can’t start right now: the part of this platform that hands runs to runners isn’t running. Try again in a few minutes.";

/** What a run needs from the runner that takes it. */
export interface RunNeeds {
    web: boolean;
    mobile: boolean;
    code: boolean;
}
export const NO_NEEDS: RunNeeds = { web: false, mobile: false, code: false };
/** Local mode, a project that runs on this server: the platform refuses a runner chosen for one run (it asks for the project's setting first). */
export const PROJECT_ON_SERVER = "This project runs its tests on this server. To use a runner, choose “On a runner” on the Runners page first.";

/** Why this runner cannot take this run, in one sentence, or null when it can. A busy runner can: the run waits for it. */
export function whyNotRunner(r: RunnerChoiceRow, needs: RunNeeds, allowPersonal = true): string | null {
    const said = r.problem ? r.problem.trim().replace(/([^.?])$/, "$1.") : null;
    // Offline: your own computer gets the sentence that says what to do; otherwise the server's words, or "Offline."
    if (!r.online) return r.mine ? "Offline. Start it on your computer, or sign in to that computer." : (said ?? "Offline.");
    if (said) return said;
    if (r.kind === "personal" && !allowPersonal) return "This project doesn’t allow people’s own computers.";
    if (needs.web && !r.canRunWeb) return "It can’t run web or API tests.";
    if (needs.mobile && !r.canRunMobile) return "It can’t run phone tests: no phone or emulator is ready on it.";
    if (needs.code && !r.codeScripts) return r.mine ? "Code scripts are switched off on it. Switch them on in its settings on the Runners page." : "It doesn’t run code scripts.";
    return null;
}

/** Your own computers first, then team runners; online ones first within each, then by name. */
export function sortChoices(rows: RunnerChoiceRow[]): RunnerChoiceRow[] {
    return [...rows].sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/**
 * The runner a run goes to when the person does not choose: the project's default runner when it can take it, else the only one
 * that can, else "any" (several can, and without a default the platform gives it to whichever is free), else null (none can).
 */
export function defaultChoice(c: RunnerChoices, needs: RunNeeds): string | "any" | null {
    const usable = sortChoices(c.runners).filter((r) => !whyNotRunner(r, needs, c.allowPersonal));
    if (c.defaultRunnerId && usable.some((r) => r.id === c.defaultRunnerId)) return c.defaultRunnerId;
    if (usable.length === 0) return null;
    if (usable.length === 1 || c.defaultRunnerId) return usable[0]!.id;
    return "any";
}

/** "Yours" or "Team", for the small tag next to a runner's name. */
export const kindWord = (r: Pick<RunnerChoiceRow, "kind" | "mine">): string => (r.kind === "personal" ? (r.mine ? "Yours" : "Personal") : "Team");

/**
 * The runners this person may use in this project. Read only in runners mode (or when `always`): a local platform that runs tests
 * itself does not need to ask. Polled slowly while shown, so a runner that comes online unlocks Run within seconds.
 */
export function useRunnerChoices(projectId: string, on: boolean, pollMs = 15_000): Fetched<RunnerChoices> {
    return useFetch<RunnerChoices>(on ? `/projects/${projectId}/runner-choices` : null, () => (on && pollMs > 0 ? pollMs : null));
}

export interface RunReadiness {
    mode: ExecutionMode;
    /** Still asking (Run stays disabled in runners mode until the answer is in). */
    loading: boolean;
    /** A run started now has somewhere to go. */
    ready: boolean;
    /** Why not, in one sentence (null when ready). */
    reason: string | null;
    choices: RunnerChoices | undefined;
}

/**
 * Can this person start a run in this project now? Local mode: when the server can run tests (as before). Runners mode: when the
 * platform hands runs out and at least one runner this person may use here is online.
 */
export function useRunReadiness(projectId: string): RunReadiness {
    const config = useConfig();
    const mode = executionModeOf(config);
    const choices = useRunnerChoices(projectId, mode === "runners");
    return readiness(mode, config, choices);
}

export function readiness(mode: ExecutionMode, config: PlatformConfig | undefined, choices: Pick<Fetched<RunnerChoices>, "data" | "loading" | "error">): RunReadiness {
    if (mode === "local") {
        const off = config?.runsHere === false;
        return { mode, loading: false, ready: !off, reason: off ? RUNS_OFF_TIP : null, choices: choices.data };
    }
    if (config?.runsHere === false) return { mode, loading: false, ready: false, reason: DISPATCH_OFF, choices: choices.data };
    const c = choices.data;
    if (!c) return { mode, loading: choices.loading, ready: false, reason: choices.loading ? null : NO_RUNNER_ONLINE, choices: c };
    const ok = c.runners.some((r: RunnerChoiceRow) => !whyNotRunner(r, NO_NEEDS, c.allowPersonal));
    return { mode, loading: false, ready: ok, reason: ok ? null : NO_RUNNER_ONLINE, choices: c };
}
