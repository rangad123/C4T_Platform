/**
 * Framework adapters: the one place that knows what a testing framework is.
 *
 * An adapter bundles what the platform needs from a framework: how to turn a canonical spec into a script
 * (`render`), how to run a batch of scripts and get the neutral result back (`execute`), and what kind of
 * machine can run them (`needs`). The core (validator, variants, environments, schedules, routes) asks the
 * registry instead of switching on framework ids, so a new framework is an addition, not a change to the core.
 * Stored ids ("playwright", "playwright-api", "taqwright") are unchanged.
 */
import type { TestKind, TestSpec } from "../spec/schema.js";
import type { RenderContext, RenderedScript } from "../generators/types.js";
import type { MobileRunEnv } from "../validation/mobile-runner.js";
import type { IosRunEnv } from "../mobile/ios-runner.js";
import type { LiveRunEvent, RunEnv, RunnerProject, ScriptInput, ScriptRun } from "../validation/runner.js";
import type { MailSource } from "../auth/mail.js";
import type { BrowserLaunch } from "../browsers/choice.js";

export type { RenderContext, RenderedScript, RunEnv, MobileRunEnv, IosRunEnv, RunnerProject, ScriptInput, ScriptRun };

/** What a script is rendered to. Same shape the generators always produced. */
export type GeneratedScript = RenderedScript;

export type BrowserEngine = "chromium" | "firefox" | "webkit";

/** What the machine that RUNS the scripts (the platform host, or later a runner agent) must have. */
export interface RunnerNeeds {
    /** Node.js with this project's dependencies (every built-in framework runs on it). */
    node: boolean;
    /** Browser engines that must be installed. Omitted or empty: none. */
    browsers?: readonly BrowserEngine[];
    /** An Android emulator or device with the Android SDK. */
    android?: boolean;
    /** A Mac with Xcode, an iOS simulator and the Appium XCUITest driver (adapter `taqwright-ios`). */
    ios?: boolean;
    /** A Windows desktop session. Reserved for a later adapter. */
    windows?: boolean;
}

/** A batch of scripts to run together. `scratchDir` is where the run may create its working folder. */
export interface ExecutionBatch {
    scratchDir: string;
    scripts: ScriptInput[];
    /** Shared helper modules the hand-written scripts import as ./helpers/<name> (written next to the scripts for the run). */
    helpers?: Array<{ name: string; content: string }>;
}

/**
 * Everything the machine needs to know about WHERE the scripts run. Playwright-style frameworks read `run`
 * (address, accounts, variables); device frameworks read `mobile` (app and emulator). A framework ignores
 * the part it does not use. Contains secrets: it is passed to the runner and never logged or stored.
 */
export interface ExecutionEnv {
    run: RunEnv;
    mobile?: MobileRunEnv;
    /**
     * Windows desktop frameworks only: the allow-list of applications THIS computer keeps (a runner agent passes its own). Absent on
     * the platform host, which reads DESKTOP_ALLOWED_APPS. It never comes from a spec or from the platform's task.
     */
    desktop?: { allowApps: readonly string[] };
    /** iOS only (adapter `taqwright-ios`): the app and simulator choice. Absent: iOS scripts report that no simulator is set up. */
    ios?: IosRunEnv;
}

export interface ExecutionOptions {
    workers: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Cross-browser / screen-size variants (Playwright frameworks only; others ignore it). */
    projects?: RunnerProject[];
    /** The project's per-test time limit, when it differs from the framework's usual one (see settings.ts). Unset: the usual limit. */
    testTimeoutMs?: number;
    /** Called as each test finishes (Playwright frameworks only). Asking for it changes nothing about the run. */
    onProgress?: (p: { done: number; total: number; status: "passed" | "failed" | "skipped"; title: string }) => void;
    /**
     * Called as each test and each numbered step starts and ends, and when a failure screenshot is ready (Playwright web and API frameworks
     * only; a runner agent sends these to the platform as they happen). Asking for it changes nothing about the run or its result.
     */
    onLive?: (e: LiveRunEvent) => void;
    /** Windows desktop only: how long an application may take to show its window, when the project changes it. Unset: the usual 15 s. */
    startTimeoutMs?: number;
    /** The machine running the scripts agreed to run hand-written ones (set by the run policy only). Without it a script marked custom is refused. */
    allowCustom?: boolean;
    /** Where email steps read their email: the project's test mailbox, read by the platform (see ../auth/mail-rpc.ts). A remote executor ignores it. */
    mail?: MailSource;
    /**
     * Playwright frameworks on a runner only: the installed Chrome or Edge to run Chromium tests in (the runner's browser setting, see
     * ../browsers/choice.ts). It goes into the run's Playwright config, never into the test file. Unset: Playwright's own Chromium, as before.
     */
    browser?: BrowserLaunch;
}

/**
 * Things the validator does around a batch that only make sense for some frameworks. Declared by the adapter
 * so the validator never asks "is this Playwright?".
 */
export interface AdapterTraits {
    /** Screenshots of "looks right" steps can be judged by the model after the run. */
    visionJudgement: boolean;
    /** Scripts record the data they create so the platform can remove it afterwards (test-data cleanup). */
    cleanupLedger: boolean;
    /** Failing scripts can be repaired / healed with a platform-side browser (locator repair needs one). */
    browserRepair: boolean;
}

/** JSON-safe summary of an adapter for `GET /api/config` and the UI. */
export interface AdapterDescription {
    id: string;
    label: string;
    kinds: TestKind[];
    /** Whether the platform can run this framework's scripts at all (false: stored and downloadable only). */
    executable: boolean;
    /** Adapters sharing a runtime are executed together, in one batch. */
    runtime: string;
    needs: RunnerNeeds;
    traits: AdapterTraits;
    /** Set only for an adapter added by a plug-in (src/engine/frameworks/plugin-loader.ts): which plug-in. Absent for the built-ins. */
    plugin?: { name: string; version: string };
}

export interface FrameworkAdapter {
    /** Stored in databases and backups; never rename a shipped id. */
    readonly id: string;
    /** Plain-language name shown to people, e.g. "Playwright (TypeScript)". */
    readonly label: string;
    /** The test kinds this framework renders and runs. */
    readonly kinds: readonly TestKind[];
    /** Extra kinds it can render a script for but that do not run natively (e.g. a web spec as a mobile script). */
    readonly alsoRenders?: readonly TestKind[];
    /** Whether the platform runs its scripts (false: rendered and stored only). */
    readonly executable: boolean;
    /** Scripts of adapters with the same runtime go to one `execute` call, in registration order of the first adapter. */
    readonly runtime: string;
    readonly needs: RunnerNeeds;
    readonly traits: AdapterTraits;
    /** Pure: spec in, script out. Wraps the framework's generator. */
    render(spec: TestSpec, ctx: RenderContext): GeneratedScript;
    /** Run the scripts and return one result per script, in input order. Must honour `opts.signal`. */
    execute(batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]>;
    describe(): AdapterDescription;
}

/**
 * The only way callers run scripts. `LocalExecutor` runs them on this machine; a later implementation sends them to
 * a runner agent. Callers pick an executor with `executorFor(scope)` and never import a runner directly.
 */
export interface ScriptExecutor {
    readonly name: string;
    /** True when the scripts run on another machine (a runner agent): devices and addresses are then that machine's, not this one's. */
    readonly remote?: boolean;
    execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]>;
}

/** What `executorFor` is told about the work that is about to run. */
export interface ExecutorScope {
    projectId?: string;
    jobId?: string;
    mode?: string;
    /** Adapter ids the work will use, when known (a remote executor can check its agents' capabilities). */
    adapters?: readonly string[];
}
