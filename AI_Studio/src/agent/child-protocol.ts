/**
 * Messages between the agent and the process that runs one task's scripts.
 *
 * Each task runs in its own Node process (src/agent/task-child.ts) so the agent can kill the whole process tree on cancel
 * or timeout, and so a crash in a test runner cannot take the agent down. The task's credentials travel over this
 * in-memory channel only: never in the command line, never in a file.
 */
import type { LiveResultWire, RecordCommand } from "../agent-protocol/schema.js";
import type { BrowserLaunch } from "../engine/browsers/choice.js";
import type { RecState } from "../engine/recorder/session.js";
import type { MobileTarget } from "../engine/mobile/target.js";
import type { LiveRunEvent, RunEnv, RunnerProject, ScriptInput, ScriptRun } from "../engine/validation/runner.js";

/** What to run on a device (the part of MobileRunEnv that can be sent as data; `log` is wired up inside the child). */
export interface MobileDescriptor {
    target: MobileTarget;
    avd: string;
    /** Taqwright entry point override (the test seam MOBILE_RUNNER_CLI, or the wrapper that selects a phone). */
    cliPath?: string;
    /** false when a stand-in CLI or a physical phone is used: no emulator is started or stopped. */
    manageEmulator: boolean;
    keepEmulator?: boolean;
    /** Where the run happens, for the sentence naming the device ("a phone on the runner's computer"). */
    where?: string;
}

/** What to run on an iOS simulator (the part of IosRunEnv that can be sent as data; `log` is wired up inside the child). */
export interface IosDescriptor {
    target: { iosBundleId?: string; simulator?: string };
    defaultSimulator?: string;
    keepSimulator?: boolean;
    /** Taqwright entry point override (the test seam IOS_RUNNER_CLI). */
    cliPath?: string;
    /** false when a stand-in CLI is used: no simulator is started or stopped. */
    manageSimulator: boolean;
}

export interface ChildRun {
    type: "run";
    adapterId: string;
    scratchDir: string;
    scripts: ScriptInput[];
    run: RunEnv;
    mobile?: MobileDescriptor;
    /** iOS tests: the app, the simulator choice and the seams. */
    ios?: IosDescriptor;
    /** Windows desktop tests: the applications THIS computer allows (from the agent's own settings, never from the task). */
    desktop?: { allowApps: string[] };
    /** The agent was started with --allow-custom-scripts, and the task carries helper modules for hand-written scripts. */
    allowCustom?: boolean;
    helpers?: Array<{ name: string; content: string }>;
    /** The installed Chrome or Edge this runner uses for web tests (from its own browser setting). Absent: Playwright's own Chromium. */
    browser?: BrowserLaunch;
    opts: { workers: number; timeoutMs?: number; projects?: RunnerProject[]; testTimeoutMs?: number; startTimeoutMs?: number };
    /** Protocol 2: report each test, step and failure screenshot as it happens (`live` messages). Absent: the run is exactly as before. */
    live?: boolean;
}

export type ToChild = ChildRun;

export type FromChild = { type: "log"; line: string } | { type: "result"; runs: ScriptRun[] } | { type: "error"; message: string } | { type: "live"; event: LiveRunEvent };

// ── a recording session (record tasks) ──────────────────────────────────────
// A record task runs the shared recorder core (src/engine/recorder/session.ts) in its own process, like a script run, so a crash or hang cannot take the
// agent down and the browser dies with the task. The agent talks to the platform; this process only holds the session and the browser.

export interface RecordStart {
    type: "record";
    startUrl: string;
    headed: boolean;
    idleMs: number;
    totalMs: number;
    maxSteps: number;
    /** The installed Chrome or Edge to record in (the runner's browser setting). Absent: Playwright's own Chromium. */
    browser?: BrowserLaunch;
    /** The agent's address guard on 127.0.0.1 (a runner that refuses private addresses, address-guard.ts): every request of the browser goes through it. */
    guardProxy?: string;
}

/** What the agent tells the recording process. */
export type RecordToChild = RecordStart | { type: "command"; command: RecordCommand } | { type: "stop" };

/** What the recording process tells the agent. `ended` is sent once the browser has been closed and its process id checked. */
export type RecordFromChild =
    | { type: "state"; state: RecState; pid?: number; acked: string[]; ended?: boolean }
    /** The answer to an `act` or `snapshot` command (never logged; it may hold a picture of the page). */
    | { type: "result"; result: LiveResultWire }
    | { type: "log"; line: string };
