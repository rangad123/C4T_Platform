import type { PlatformConfig } from "../../api.js";
import { useConfig } from "../../lib/hooks.js";

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

/**
 * Round 51: in runners mode an exploration runs on the runner of the person who starts it (docs/features/explore-on-runner.md): the
 * browser opens there, the AI stays on the platform. Said before the click, and on the job while it explores.
 */
export const exploresOnRunner = (name: string): string => `Explores on your runner, ${name}. The browser opens on that computer; the AI works from the platform.`;
export const exploringOn = (name: string | undefined): string => (name ? `Exploring on ${name}` : "Exploring on your runner");
/** Round 52: the same for a described test being built and an agent run, by the job's mode. */
export const workingOn = (mode: string | undefined, name: string | undefined): string =>
    mode === "plain" ? (name ? `Building the test on ${name}` : "Building the test on your runner") : mode === "agent" ? (name ? `Working on ${name}` : "Working on your runner") : exploringOn(name);

/** Round 52: a scheduled exploration in runners mode runs on the runner of the person who made the schedule. */
export const SCHEDULED_EXPLORE_ON = "Explores on the runner of the person who made this schedule. If that runner is offline when the schedule fires, the exploration waits for it.";
/** Round 52: a described test and an agent run in runners mode work in a browser on the person's runner. */
export const BUILDS_ON_RUNNER = "The AI writes the steps from your words and checks them in a browser on your runner. Uses your AI key.";

/** Before a run sends code scripts to the person's own computer. */
export function codeScriptsNotice(authors: string[]): string {
    const names = authors.length <= 1 ? authors.join("") : `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}`;
    return names ? `This run includes code scripts written by ${names}. They run on your computer with your user’s rights.` : "This run includes code scripts. They run on your computer with your user’s rights.";
}

/** Runners mode, while the part of the platform that hands runs to runners is not running (the server says runs cannot start). */
export const DISPATCH_OFF = "Runs can’t start right now: the part of this platform that hands runs to runners isn’t running. Try again in a few minutes.";
