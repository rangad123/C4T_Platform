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
