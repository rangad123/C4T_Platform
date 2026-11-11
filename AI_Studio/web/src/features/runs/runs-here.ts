import type { PlatformConfig } from "../../api.js";
import { useConfig, type Fetched } from "../../lib/hooks.js";
import { runnerProblem, useMyRunner, type MyRunnerAnswer, type RunnerMine } from "../runners/my-runner.js";
export { RUNNER_NOT_SET_UP, RUNNER_OFFLINE, RUNNER_SETTINGS_HREF } from "../runners/my-runner.js";

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

/** Why the Run controls are off for a person who may look at this project but not run its tests (the server refuses them too). */
export const NO_RUN_PERMISSION = "Running tests needs permission to run tests in this project. Ask a Project Admin.";

/** What the platform answers in runners mode when an exploration or a described test is asked for (src/platform/runner-only.ts), said before the click. */
export const EXPLORING_ON_RUNNERS = "Exploring an application is not available here yet: the AI explores it with a browser on the server, and this platform runs tests only on runners. Build tests by hand, record them on your runner, or import them.";
export const PLAIN_ON_RUNNERS = "Describing a test in your own words is not available here yet: the AI builds and checks it with a browser on the server, and this platform runs tests only on runners. Build the steps by hand or write the test as text instead.";

/** Before a run sends code scripts to the person's own computer. */
export function codeScriptsNotice(authors: string[]): string {
    const names = authors.length <= 1 ? authors.join("") : `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}`;
    return names ? `This run includes code scripts written by ${names}. They run on your computer with your user’s rights.` : "This run includes code scripts. They run on your computer with your user’s rights.";
}

/** Runners mode, while the part of the platform that hands runs to runners is not running (the server says runs cannot start). */
export const DISPATCH_OFF = "Runs can’t start right now: the part of this platform that hands runs to runners isn’t running. Try again in a few minutes.";
/** The title over the "your runner can't take this" notice. */
export const NO_RUNNER_TITLE = "Your runner can’t take runs right now";

/** What a run needs from the runner that takes it. */
export interface RunNeeds {
    web: boolean;
    mobile: boolean;
    code: boolean;
}
export const NO_NEEDS: RunNeeds = { web: false, mobile: false, code: false };

export interface RunReadiness {
    mode: ExecutionMode;
    /** Still asking (Run stays disabled in runners mode until the answer is in). */
    loading: boolean;
    /** A run started now has somewhere to go. */
    ready: boolean;
    /** Why not, in one sentence (null when ready). */
    reason: string | null;
    /** The person's runner (runners mode), null when not set up, undefined until known. */
    runner: RunnerMine | null | undefined;
}

/**
 * Can this person start a run now? Local mode: when the server can run tests (as before). Runners mode: when the platform hands runs
 * out and the person's own runner is set up and connected (every run goes to its starter's runner; a busy one makes the run wait).
 */
export function useRunReadiness(_projectId?: string): RunReadiness {
    const config = useConfig();
    const mode = executionModeOf(config);
    const me = useMyRunner(15_000, mode === "runners");
    return readiness(mode, config, me);
}

export function readiness(mode: ExecutionMode, config: PlatformConfig | undefined, me: Pick<Fetched<MyRunnerAnswer>, "data" | "loading">, needs: Partial<RunNeeds> = {}): RunReadiness {
    if (mode === "local") {
        const off = config?.runsHere === false;
        return { mode, loading: false, ready: !off, reason: off ? RUNS_OFF_TIP : null, runner: me.data?.runner };
    }
    if (config?.runsHere === false) return { mode, loading: false, ready: false, reason: DISPATCH_OFF, runner: me.data?.runner };
    // The answer could not be read: the server decides at the click (and says why with a link to Settings).
    if (!me.data) return { mode, loading: me.loading, ready: !me.loading, reason: null, runner: undefined };
    const why = runnerProblem(me.data, needs);
    return { mode, loading: false, ready: !why, reason: why, runner: me.data.runner };
}
