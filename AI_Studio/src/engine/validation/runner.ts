/**
 * Executes rendered scripts with the real Playwright Test runner and parses its JSON report.
 * Nothing here is simulated: a script is "passed" only if Playwright says so.
 *
 * Scripts are written to an isolated directory *inside the repo tree* (config.scratchDir) so they
 * resolve `@playwright/test` from this project's node_modules.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createdFileName } from "../cleanup/helper.js";
import { EVIDENCE_ATTACHMENT } from "../evidence/capture.js";
import { parseEvidence, secretsOfRun } from "../evidence/model.js";
import { parseCreatedLog, type CreatedLine } from "../cleanup/ledger.js";
import { parseMetrics } from "../performance/specs.js";
import { checkScript, describeErrors } from "../custom/guard.js";
import { helperPath } from "../custom/helpers.js";
import { prepareRunExtras } from "../auth/run-session.js";
import type { MailSource } from "../auth/mail.js";
import type { BrowserLaunch } from "../browsers/choice.js";
import { withTestProxy } from "../net/test-proxy.js";

export interface RunEnv {
    baseUrl: string;
    apiBaseUrl?: string;
    credentials?: { username: string; password: string; totpSecret?: string };
    /** Named test accounts: TEST_<NAME>_USERNAME / _PASSWORD / _TOTP_SECRET for scripts that sign in as them. */
    roles?: Array<{ name: string; username: string; password: string; totpSecret?: string; apiToken?: string }>;
    apiToken?: string;
    apiAuthHeader?: string;
    /** Variables of a named environment, read by scripts as TEST_ENV_<NAME> ({{env.NAME}}). */
    vars?: Record<string, string>;
    /**
     * Who removes the records data-changing API tests create (see ../cleanup/helper.ts). Unset: the script removes them itself (a script run
     * on its own). "platform": the platform does after the run; "off": nobody does. Either way the script only writes down what it created.
     */
    cleanup?: "platform" | "off";
    headless: boolean;
    /**
     * The project's saved sign-in (a Playwright storage state as JSON text; see ../auth/run-session.ts). Scripts marked `session` start
     * signed in with it. Written to the run folder for the run only. A secret: never logged, never stored with a result.
     */
    storageState?: string;
}

export interface ScriptInput {
    testId: string;
    filename: string;
    content: string;
    /** Approved baseline screenshots for this test's screenshot assertions (visual regression). */
    baselines?: Array<{ name: string; path: string }>;
    /** Which framework the script belongs to (a web and an API script share one Playwright process; project settings differ per framework). Not sent anywhere. */
    framework?: string;
    /** A hand-written script (taken over, written or imported). It runs only when the machine allowed it, and only after the guard passed it again. */
    custom?: boolean;
    /** Start this script signed in with RunEnv.storageState (the project's saved sign-in). Ignored when the run has none. */
    session?: boolean;
}

export interface StepResult {
    index: number;
    title: string;
    status: "passed" | "failed";
    error?: string;
}

export interface ScriptRun {
    testId: string;
    status: "passed" | "failed" | "timedOut" | "skipped" | "error";
    durationMs: number;
    error?: string;
    /** 0-based index of the first failing recorded step, or -1 if unknown. */
    failedStepIndex: number;
    steps: StepResult[];
    artifacts: Array<{ kind: "screenshot" | "trace" | "video" | "visual-actual" | "visual-diff" | "vision-shot" | "evidence"; path: string }>;
    /** Screenshots the script took for its `looksRight` steps (step = 0-based step index) and what the check looks for. Judged by the platform, see ../vision/judge.ts. */
    vision?: Array<{ step: number; path: string; expected?: string }>;
    /** Plain notes to keep with a passing run (for example a low-confidence AI judgement). */
    notes?: string[];
    /** Set once the platform judged this run's screenshots. */
    visionJudged?: "ok" | "finding" | "unavailable";
    /** Baseline screenshots Playwright wrote during this run because none existed (first visual run). */
    newBaselines?: Array<{ name: string; path: string }>;
    /** API tests only: every HTTP response the script received, in order. */
    responses: Array<{ method: string; path: string; status: number; /** Shape (types only) of a successful GET body, or null; see contracts/drift.ts. */ obs?: unknown }>;
    /** Page-speed runs: the measured values (also when within budget). */
    metrics?: Array<{ metric: string; value: number; unit: string; budget?: number }>;
    /** Cross-browser / responsive runs only: the Playwright project (variant id) this result belongs to. */
    variant?: string;
    /** API tests with RunEnv.cleanup set: what the script wrote down about records it created (and DELETEs it made), in order. Paths and ids only. */
    created?: CreatedLine[];
    /**
     * The run was cancelled before this script finished, so there is no result for it: neither a pass nor a failure. Set by the
     * validation loop (never by the runner of a finished batch); such a run is never stored as an execution.
     */
    notRun?: true;
}

/**
 * One extra Playwright project (a browser + device profile) for cross-browser / responsive runs.
 * `device` is a name from Playwright's built-in device list; `viewport` overrides its screen size.
 */
export interface RunnerProject {
    name: string;
    device: string;
    viewport?: { width: number; height: number };
}

const require = createRequire(import.meta.url);
// eslint-disable-next-line no-control-regex
export const ANSI = /\u001b\[[0-9;]*m/g;

/** Environment variables the Playwright child may inherit (compared upper-case; Windows names vary in case). */
export const CHILD_ENV_ALLOW = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMDATA",
    "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME",
    "LANG", "LC_ALL", "TZ", "PLAYWRIGHT_BROWSERS_PATH", "DISPLAY", "WAYLAND_DISPLAY",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    // Company networks (engine/net, agent/net.ts): the same certificate trust as the runner, and --proxy-tests.
    "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "AITP_PROXY_TESTS",
    // The address check every generated script makes when a step runs (engine/spec/run-address.ts).
    "BLOCK_PRIVATE_TARGETS",
    // A runner's own address guard (src/agent/address-guard.ts, engine/net/test-proxy.ts); the platform never sets it.
    "AITP_ADDRESS_GUARD",
]);

function playwrightCli(): string {
    return require.resolve("@playwright/test/cli");
}

const CONFIG = `import { defineConfig } from "@playwright/test";
export default defineConfig({
    testDir: ".",
    testMatch: /.*\\.spec\\.ts$/,
    timeout: 60_000,
    expect: { timeout: 8_000 },
    retries: 0,
    fullyParallel: true,
    reporter: [["json", { outputFile: "report.json" }]],
    outputDir: "artifacts",
    // Approved baselines are placed here by the validator; missing ones are written here (see runScripts).
    snapshotPathTemplate: "{testDir}/__baselines__/{arg}{ext}",
    use: {
        headless: process.env.PW_HEADLESS !== "false",
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        // Recorded for every run but kept only when a test fails, so reviewers can watch what happened.
        video: "retain-on-failure",
        actionTimeout: 10_000,
        navigationTimeout: 30_000,
        viewport: { width: 1280, height: 800 },
    },
});
`;

/**
 * The same config with one Playwright project per browser / screen-size variant. Without projects it is
 * exactly the base config, so the normal validation run is untouched.
 */
export function configFor(projects: RunnerProject[], testTimeoutMs?: number, browser?: BrowserLaunch): string {
    // The project's own per-test limit (framework settings); unset, or equal to the usual 60 s, the config is exactly the base one.
    const timed = testTimeoutMs !== undefined && testTimeoutMs !== 60_000 ? CONFIG.replace("    timeout: 60_000,", () => `    timeout: ${Math.round(testTimeoutMs)},`) : CONFIG;
    // A runner that uses the computer's Chrome or Edge (../browsers/choice.ts): Chromium tests run in it. Firefox and WebKit variants keep their own engine.
    const launch = browser?.channel || browser?.executablePath ? `${browser.channel ? `channel: ${JSON.stringify(browser.channel)}, ` : ""}${browser.executablePath ? `launchOptions: { executablePath: ${JSON.stringify(browser.executablePath)} }, ` : ""}`.replace(/, $/, "") : "";
    // No video tool on this computer (a runner using an installed browser that has not fetched it yet): no failure video, rather than no test.
    const filmed = browser?.video === false ? timed.replace('video: "retain-on-failure",', () => 'video: "off",') : timed;
    const base = launch && projects.length === 0 ? filmed.replace("    use: {\n", () => `    use: {\n        ${launch},\n`) : filmed;
    if (projects.length === 0) return base;
    const list = projects
        .map((p) => `        { name: ${JSON.stringify(p.name)}, use: { ...devices[${JSON.stringify(p.device)}]${p.viewport ? `, viewport: ${JSON.stringify(p.viewport)}` : ""}${launch ? `, ...(devices[${JSON.stringify(p.device)}]?.defaultBrowserType === "firefox" || devices[${JSON.stringify(p.device)}]?.defaultBrowserType === "webkit" ? {} : { ${launch} })` : ""} } },`)
        .join("\n");
    return base.replace("import { defineConfig }", () => "import { defineConfig, devices }").replace("    use: {", () => `    projects: [\n${list}\n    ],\n    use: {`);
}

/** One test finished (Playwright's list reporter, read from the runner's output). Only produced when a caller asks for progress. */
export interface RunProgress {
    done: number;
    total: number;
    status: "passed" | "failed" | "skipped";
    /** The test's title as the script named it (no file name, no browser tag). */
    title: string;
}

const BASE_REPORTER = 'reporter: [["json", { outputFile: "report.json" }]],';

/** The same config plus extra reporters (each a Playwright reporter entry written as source text). With none it is the base config itself. */
function withReporters(config: string, extra: string[]): string {
    return extra.length ? config.replace(BASE_REPORTER, () => `reporter: [["json", { outputFile: "report.json" }], ${extra.join(", ")}],`) : config;
}

/** Name of the file the partial-results reporter writes next to the config (one JSON line per finished test). */
const PARTIAL_FILE = "partial-results.ndjson";

/**
 * A tiny reporter that writes every test's result the moment it ends. Playwright's own JSON report is written only when the whole
 * run ends, so a run that is cancelled (and killed) half way would lose the results of the tests that had already finished.
 * Plain JavaScript, no dependencies; it only appends to a file and never throws into the run.
 */
const PARTIAL_REPORTER = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(PARTIAL_FILE)});
const steps = (list, depth) => (depth > 6 ? [] : (list || []).filter((s) => s.category === "test.step").map((s) => ({ title: s.title, ...(s.error ? { error: { message: s.error.message } } : {}), steps: steps(s.steps, depth + 1) })));
export default class PartialReporter {
    onTestEnd(test, result) {
        try {
            const project = test.parent && test.parent.project ? test.parent.project() : undefined;
            const record = {
                file: test.location.file,
                title: test.title,
                project: project ? project.name : "",
                result: {
                    status: result.status,
                    duration: result.duration,
                    error: result.error ? { message: result.error.message } : undefined,
                    steps: steps(result.steps, 0),
                    attachments: result.attachments.map((a) => ({ name: a.name, contentType: a.contentType, path: a.path, body: a.body ? a.body.toString("base64") : undefined })),
                },
            };
            fs.appendFileSync(file, JSON.stringify(record) + "\\n");
        } catch {
            /* a result that cannot be written down is simply not kept */
        }
    }
    printsToStdio() {
        return false;
    }
}
`;

/**
 * A runner agent's live view of a run: each test and each top-level step as it starts and ends, and each failure screenshot once Playwright
 * has written it. Only produced when a caller asks (`onLive`); the run and its result are the same either way.
 */
export type LiveRunEvent =
    | { type: "test_started"; testId: string; variant?: string; title: string }
    | { type: "test_finished"; testId: string; variant?: string; title: string; status: ScriptRun["status"]; durationMs: number; error?: string; stack?: string }
    | { type: "step_started"; testId: string; variant?: string; index: number; title: string }
    | { type: "step_finished"; testId: string; variant?: string; index: number; title: string; status: "passed" | "failed"; durationMs: number; error?: string }
    | { type: "screenshot"; testId: string; variant?: string; path: string };

/** The prefix of a live reporter line on Playwright's output (a control character no test title or list-reporter line starts with). */
const LIVE_MARK = "\u001eAITP-LIVE ";
const LIVE_REPORTER_FILE = "live-reporter.mjs";

/**
 * The live reporter (plain JavaScript, no dependencies): one line per test or top-level step start and end, written to Playwright's own
 * output where the caller reads it. It works for every script as it is: generated scripts wrap each step in `test.step("N. ...")`, and a
 * hand-written script's own steps are reported too. It never throws into the run and prints nothing a person reads.
 */
const LIVE_REPORTER = `import path from "node:path";
const MARK = ${JSON.stringify("\u001eAITP-LIVE ")};
const out = (o) => { try { process.stdout.write(MARK + JSON.stringify(o) + "\\n"); } catch { /* a line that cannot be written is simply not live */ } };
const where = (test) => { const p = test.parent && test.parent.project ? test.parent.project() : undefined; return { file: path.basename(test.location.file), project: p ? p.name : "", title: test.title }; };
const top = (step) => step && step.category === "test.step" && !step.parent;
const msg = (e) => (e && typeof e.message === "string" ? e.message.slice(0, 2000) : undefined);
export default class LiveReporter {
    onTestBegin(test) { out({ t: "test_started", ...where(test) }); }
    onStepBegin(test, _result, step) { if (top(step)) out({ t: "step_started", ...where(test), step: step.title }); }
    onStepEnd(test, _result, step) { if (top(step)) out({ t: "step_finished", ...where(test), step: step.title, ok: !step.error, durationMs: step.duration, error: msg(step.error) }); }
    onTestEnd(test, result) {
        out({ t: "test_finished", ...where(test), status: result.status, durationMs: result.duration, error: msg(result.error), stack: result.error && typeof result.error.stack === "string" ? result.error.stack.slice(0, 4000) : undefined });
        for (const a of result.attachments || []) if (a.name === "screenshot" && a.path && /^image\\//.test(a.contentType || "")) out({ t: "screenshot", ...where(test), path: a.path });
    }
    printsToStdio() { return false; }
}
`;

/**
 * Reads the live reporter's lines from chunks of Playwright's output and turns them into LiveRunEvents with the script's test id (the
 * file name is the script's own) and step index ("3. ..." is step index 2; an unnumbered step counts on from the last one). Exported for
 * the unit tests.
 */
export class LiveParser {
    private buf = "";
    private readonly steps = new Map<string, number>();
    constructor(
        private readonly scripts: ReadonlyArray<{ testId: string; filename: string }>,
        private readonly variants: boolean,
        private readonly emit: (e: LiveRunEvent) => void,
    ) {}

    push(chunk: string): void {
        this.buf += chunk;
        let at: number;
        while ((at = this.buf.indexOf("\n")) >= 0) {
            this.line(this.buf.slice(0, at).replace(/\r$/, ""));
            this.buf = this.buf.slice(at + 1);
        }
        if (this.buf.length > 64_000) this.buf = "";
    }

    private line(text: string): void {
        const i = text.indexOf(LIVE_MARK);
        if (i < 0) return;
        let o: Record<string, unknown>;
        try {
            o = JSON.parse(text.slice(i + LIVE_MARK.length)) as Record<string, unknown>;
        } catch {
            return;
        }
        const script = this.scripts.find((s) => s.filename === o.file);
        if (!script) return;
        const str = (v: unknown, n: number): string | undefined => (typeof v === "string" && v ? v.replace(ANSI, "").slice(0, n) : undefined);
        const base = { testId: script.testId, ...(this.variants && typeof o.project === "string" && o.project ? { variant: o.project } : {}) };
        const title = str(o.title, 300) ?? script.testId;
        const key = `${script.testId}|${String(o.project ?? "")}|${title}`;
        const ms = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
        const indexOf = (stepTitle: string, starting: boolean): number => {
            const m = /^(\d+)\.\s/.exec(stepTitle);
            const last = this.steps.get(key) ?? -1;
            const index = m ? Number(m[1]) - 1 : starting ? last + 1 : Math.max(0, last);
            if (starting) this.steps.set(key, index);
            return index;
        };
        switch (o.t) {
            case "test_started":
                this.steps.delete(key);
                return this.emit({ type: "test_started", ...base, title });
            case "step_started": {
                const step = str(o.step, 300) ?? "";
                return this.emit({ type: "step_started", ...base, index: indexOf(step, true), title: step });
            }
            case "step_finished": {
                const step = str(o.step, 300) ?? "";
                const error = str(o.error, 800);
                return this.emit({ type: "step_finished", ...base, index: indexOf(step, false), title: step, status: o.ok === true ? "passed" : "failed", durationMs: ms(o.durationMs), ...(error ? { error } : {}) });
            }
            case "test_finished": {
                const status: ScriptRun["status"] = o.status === "passed" ? "passed" : o.status === "timedOut" ? "timedOut" : o.status === "skipped" ? "skipped" : o.status === "failed" ? "failed" : "error";
                const error = str(o.error, 2000);
                const stack = str(o.stack, 4000);
                return this.emit({ type: "test_finished", ...base, title, status, durationMs: ms(o.durationMs), ...(error ? { error } : {}), ...(stack ? { stack } : {}) });
            }
            case "screenshot":
                if (typeof o.path === "string" && o.path) this.emit({ type: "screenshot", ...base, path: o.path });
                return;
        }
    }
}

/** The config plus the list reporter, whose output lines say which test just finished. Used only when progress is wanted. */
function withProgressReporter(config: string): string {
    return withReporters(config, ['["list"]']);
}

/**
 * When a run was cancelled and killed, Playwright never wrote its report. The tests that had finished are in the partial file;
 * put them into a report of the same shape, so the one parser reads them. Tests that had not finished are simply absent. Returns
 * whether anything was written.
 */
export async function reportFromPartialResults(runDir: string): Promise<boolean> {
    const text = await fs.readFile(path.join(runDir, PARTIAL_FILE), "utf8").catch(() => "");
    const byFile = new Map<string, Array<{ title: string; file: string; tests: unknown[] }>>();
    let any = false;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line) as { file: string; title: string; project: string; result: { status: string } };
            const list = byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)!;
            list.push({ title: r.title, file: r.file, tests: [{ projectName: r.project, status: r.result.status === "passed" ? "expected" : "unexpected", results: [r.result] }] });
            any = true;
        } catch {
            /* a half-written last line: that test was still finishing */
        }
    }
    if (!any) return false;
    const report = { suites: [...byFile].map(([file, specs]) => ({ file, specs })), errors: [] };
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report));
    return true;
}

/**
 * After a cancelled job: a run that produced nothing at all (no steps, only an error) is not a result. Runs that finished before
 * the cancel keep what they found. Applied to every adapter, because each one stops differently.
 */
export function markUnfinishedAsNotRun(runs: ScriptRun[], signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    for (const r of runs) if (r.status === "error" && r.steps.length === 0 && r.artifacts.length === 0) r.notRun = true;
}

/**
 * Reads Playwright's list-reporter lines ("Running 12 tests using 2 workers", "  ok 3 file:1:1 › title (1.2s)") from chunks of output.
 * Anything else (failure details, summaries) is ignored. Exported for the unit tests.
 */
export class ProgressParser {
    private buf = "";
    private total = 0;
    private done = 0;
    constructor(private readonly emit: (p: RunProgress) => void) {}

    push(chunk: string): void {
        this.buf += chunk;
        let at: number;
        while ((at = this.buf.indexOf("\n")) >= 0) {
            this.line(this.buf.slice(0, at).replace(/\r$/, ""));
            this.buf = this.buf.slice(at + 1);
        }
        if (this.buf.length > 4000) this.buf = ""; // a runaway line is not progress
    }

    private line(text: string): void {
        const run = /^Running (\d+) tests?\b/.exec(text);
        if (run) {
            this.total = Number(run[1]);
            return;
        }
        // Playwright writes "ok"/"x" where the terminal has no Unicode and "✓"/"✘" where it has (Linux and macOS, also when piped).
        const m = /^\s*(ok|x|-|\u2713|\u2718)\s+(\d+)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?(?:ms|s|m)\))?$/.exec(text);
        if (!m || this.total === 0) return;
        const title = m[3]!.split(" › ").pop()!.trim().slice(0, 160);
        this.done = Math.min(this.total, this.done + 1);
        this.emit({ done: this.done, total: this.total, status: m[1] === "ok" || m[1] === "\u2713" ? "passed" : m[1] === "x" || m[1] === "\u2718" ? "failed" : "skipped", title });
    }
}

/** Why each hand-written script in the batch may not be started here (index -> plain sentence). Empty = all may run. Exported for the unit tests. */
export function customRefusals(scripts: ScriptInput[], helpers: ReadonlyArray<{ name: string; content: string }>, allow: boolean): Map<number, string> {
    const out = new Map<number, string>();
    if (!allow) {
        scripts.forEach((s, i) => s.custom && out.set(i, "Code tests are not allowed to run on this machine. Start the runner agent with --allow-custom-scripts, or set ALLOW_CUSTOM_SCRIPTS=true on the server."));
        return out;
    }
    const badHelper = helpers.map((h) => ({ h, r: checkScript(h.content, { kind: "helper" }) })).find((x) => !x.r.ok);
    scripts.forEach((s, i) => {
        if (!s.custom) return;
        const r = checkScript(s.content, { kind: "test" });
        if (!r.ok) out.set(i, `The script was not run because it did not pass the safety check: ${describeErrors(r.diagnostics)}`);
        else if (badHelper) out.set(i, `The script was not run because the helper “${badHelper.h.name}” did not pass the safety check: ${describeErrors(badHelper.r.diagnostics)}`);
    });
    return out;
}

export async function runScripts(
    scratchDir: string,
    scripts: ScriptInput[],
    env: RunEnv,
    opts: { workers: number; timeoutMs?: number; signal?: AbortSignal; /** Run every script once per project (cross-browser / responsive). */ projects?: RunnerProject[]; /** Per-test time limit in ms (project setting); unset = 60 s. */ testTimeoutMs?: number; /** Called as each test finishes. Leaves the run itself untouched. */ onProgress?: (p: RunProgress) => void; /** Called as each test and top-level step starts and ends, and when a failure screenshot is written (a runner agent's live view). Leaves the run itself untouched. */ onLive?: (e: LiveRunEvent) => void; /** This machine agreed to run code tests. Without it they are refused here, whoever asked. */ allowCustom?: boolean; /** Shared helper modules for code tests, written to ./helpers/<name>.ts in the run folder. */ helpers?: Array<{ name: string; content: string }>; /** Where email steps read their email (the project's test mailbox). Unset: email steps fail with a plain message. */ mail?: MailSource; /** A runner's installed Chrome or Edge for Chromium tests (in the config only). Unset: Playwright's own Chromium. */ browser?: BrowserLaunch } = { workers: 2 },
): Promise<ScriptRun[]> {
    if (scripts.length === 0) return [];
    if (opts.signal?.aborted) throw new Error("Job cancelled");
    // Code tests are arbitrary code. Whatever called this, they are not started unless the caller said this machine allows it, and
    // each one (and every helper) passes the guard again right before it is written. The others in the batch run as usual.
    if (scripts.some((s) => s.custom)) {
        const refusal = customRefusals(scripts, opts.helpers ?? [], opts.allowCustom === true);
        if (refusal.size > 0) {
            const rest = scripts.filter((_, i) => !refusal.has(i));
            const ran = rest.length ? await runScripts(scratchDir, rest, env, opts) : [];
            let k = 0;
            return scripts.map((s, i) => (refusal.has(i) ? { testId: s.testId, status: "error" as const, durationMs: 0, error: refusal.get(i)!, failedStepIndex: -1, steps: [], artifacts: [], responses: [] } : ran[k++]!));
        }
    }
    const projects = opts.projects ?? [];
    const runDir = path.join(scratchDir, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(runDir, { recursive: true });
    // A run that can be cancelled also keeps each finished test's result as it ends (a cancelled run is killed before Playwright writes its report).
    // --proxy-tests on a runner (AITP_PROXY_TESTS=1): the browser gets the proxy; otherwise the config is unchanged (engine/net/test-proxy.ts).
    const config = withTestProxy(configFor(projects, opts.testTimeoutMs, opts.browser), process.env);
    await fs.writeFile(path.join(runDir, "playwright.config.ts"), withReporters(config, [...(opts.onProgress ? ['["list"]'] : []), ...(opts.signal ? ['["./partial-reporter.mjs"]'] : []), ...(opts.onLive ? [`["./${LIVE_REPORTER_FILE}"]`] : [])]));
    if (opts.signal) await fs.writeFile(path.join(runDir, "partial-reporter.mjs"), PARTIAL_REPORTER);
    if (opts.onLive) await fs.writeFile(path.join(runDir, LIVE_REPORTER_FILE), LIVE_REPORTER);
    // Saved sign-in and email steps (see ../auth/run-session.ts): nothing changes for a run that uses neither.
    const extras = await prepareRunExtras(runDir, scripts, env.storageState, opts.mail);
    for (const s of scripts) await fs.writeFile(path.join(runDir, s.filename), extras.content(s));
    if (scripts.some((s) => s.custom) && opts.helpers?.length) {
        await fs.mkdir(path.join(runDir, "helpers"), { recursive: true });
        for (const h of opts.helpers) await fs.writeFile(helperPath(runDir, h.name), h.content);
    }
    const baselineDir = path.join(runDir, "__baselines__");
    const provided = new Set<string>();
    for (const s of scripts) {
        for (const b of s.baselines ?? []) {
            await fs.mkdir(baselineDir, { recursive: true });
            await fs.copyFile(b.path, path.join(baselineDir, b.name));
            provided.add(b.name);
        }
    }

    // Generated scripts derive from untrusted input (page content, OpenAPI documents, LLM output), so
    // the child gets only what Playwright needs to run — never the platform's own secrets
    // (LLM keys, SECRET_KEY, API_KEY) that live in process.env.
    const passthrough = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => CHILD_ENV_ALLOW.has(k.toUpperCase())),
    );
    const childEnv: NodeJS.ProcessEnv = {
        ...passthrough,
        BASE_URL: env.baseUrl,
        API_BASE_URL: env.apiBaseUrl ?? env.baseUrl,
        PW_HEADLESS: String(env.headless),
        FORCE_COLOR: "0",
        TEST_USERNAME: env.credentials?.username ?? "",
        TEST_PASSWORD: env.credentials?.password ?? "",
        TEST_TOTP_SECRET: env.credentials?.totpSecret ?? "",
        ...Object.fromEntries(
            (env.roles ?? []).flatMap((r) => {
                const k = `TEST_${r.name.toUpperCase().replace(/-/g, "_")}`;
                return [[`${k}_USERNAME`, r.username], [`${k}_PASSWORD`, r.password], [`${k}_TOTP_SECRET`, r.totpSecret ?? ""], [`${k}_API_TOKEN`, r.apiToken ?? ""]] as Array<[string, string]>;
            }),
        ),
        // AITP_EVIDENCE=always keeps the page's network/console evidence for passing tests too (it is only kept on failure otherwise).
        ...(process.env.AITP_EVIDENCE === "always" ? { AITP_EVIDENCE: "always" } : {}),
        API_TOKEN: env.apiToken ?? "",
        API_AUTH_HEADER: env.apiAuthHeader ?? "",
        ...(env.cleanup ? { AITP_CLEANUP: env.cleanup, AITP_CREATED_DIR: path.join(runDir, "created") } : {}),
        // {{env.NAME}} in a spec: the variables of the environment this run targets (TEST_ENV_<NAME>).
        ...Object.fromEntries(Object.entries(env.vars ?? {}).map(([k, val]) => [`TEST_ENV_${k.toUpperCase()}`, val])),
        ...extras.env,
    };

    const { stderr, timedOut } = await new Promise<{ stderr: string; timedOut: boolean }>((resolve) => {
        const child = spawn(process.execPath, [playwrightCli(), "test", "--config", "playwright.config.ts", `--workers=${opts.workers}`, "--update-snapshots=missing"], {
            cwd: runDir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        const progress = opts.onProgress ? new ProgressParser(opts.onProgress) : undefined;
        const onLive = opts.onLive;
        const live = onLive
            ? new LiveParser(scripts, projects.length > 0, (e) => {
                  try {
                      onLive(e);
                  } catch {
                      /* a live view that fails must not change the run */
                  }
              })
            : undefined;
        child.stdout.on("data", (d) => {
            progress?.push(String(d));
            live?.push(String(d));
        });
        const limit = opts.timeoutMs ?? Math.max(120_000, scripts.length * Math.max(1, projects.length) * (opts.testTimeoutMs ?? 60_000));
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
        }, limit);
        const onAbort = () => child.kill("SIGKILL");
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => {
            clearTimeout(timer);
            opts.signal?.removeEventListener("abort", onAbort);
            resolve({ stderr: err, timedOut: killed });
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ stderr: String(e), timedOut: false });
        });
    });
    await extras.end();

    // Cancelled while running: the tests that had finished still count; the others have no result.
    if (opts.signal?.aborted && !timedOut) await reportFromPartialResults(runDir).catch(() => false);
    const evidenceTexts = new Map<string, string>();
    const runs = await parseReport(runDir, scripts, stderr, timedOut, "Playwright", projects.map((p) => p.name), evidenceTexts);
    await storeEvidence(runDir, runs, evidenceTexts, [...secretsOfRun(env), ...extras.secrets]);
    // Records data-changing API tests created: written as they happened, so a run that was killed still reports them.
    if (env.cleanup && projects.length === 0) {
        for (const run of runs) {
            const text = await fs.readFile(path.join(runDir, "created", createdFileName(run.testId)), "utf8").catch(() => "");
            const lines = text ? parseCreatedLog(text) : [];
            if (lines.length) run.created = lines;
        }
    }
    // Baselines that did not exist before the run were just written by Playwright (first visual run).
    const written = (await fs.readdir(baselineDir).catch(() => [] as string[])).filter((f) => !provided.has(f));
    for (const run of runs) {
        run.newBaselines = written.filter((f) => f.startsWith(`${run.testId}-`)).map((name) => ({ name, path: path.join(baselineDir, name) }));
    }
    return runs;
}

/**
 * Failure evidence (see ../evidence): the script attached the page's network calls and console lines because the test failed.
 * Here, and only here, it becomes a file: parsed against the strict schema, masked again with the credentials of this run,
 * capped. The raw attachment is never written anywhere. Evidence that does not pass is dropped, the run is unaffected.
 */
async function storeEvidence(runDir: string, runs: ScriptRun[], texts: Map<string, string>, secrets: string[]): Promise<void> {
    for (const run of runs) {
        const text = texts.get(`${run.testId}|${run.variant ?? ""}`);
        if (!text) continue;
        const evidence = parseEvidence(text, secrets);
        if (!evidence) continue;
        const file = path.join(runDir, "artifacts", `${run.testId}${run.variant ? `-${run.variant}` : ""}-evidence.json`);
        try {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify(evidence));
            run.artifacts.push({ kind: "evidence", path: file });
        } catch {
            /* evidence is a bonus: a write problem must not change a result */
        }
    }
}

interface PwStep {
    title: string;
    error?: { message?: string };
    steps?: PwStep[];
}
interface PwResult {
    status: string;
    duration: number;
    error?: { message?: string };
    steps?: PwStep[];
    attachments?: Array<{ name: string; path?: string; body?: string; contentType: string }>;
}

interface Hit {
    file: string;
    project: string;
    result: PwResult | undefined;
    status: string;
    /** The test's title, which carries the row of a data-driven script ("... [row 2/5]"). */
    title: string;
}

function* walk(suite: any): Generator<Hit> {
    for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
            const results: PwResult[] = test.results ?? [];
            yield { file: spec.file ?? suite.file, project: test.projectName ?? "", result: results[results.length - 1], status: test.status, title: String(spec.title ?? "") };
        }
    }
    for (const child of suite.suites ?? []) yield* walk(child);
}

/**
 * A data-driven script (one test per data row, see testdata/dataset.ts) has several results under one file name: it passed only if
 * every row did, and the first failing row speaks for it. Durations add up and every row's HTTP responses are kept (drift,
 * findings). A script with one test (all of them, until now) is returned unchanged.
 */
function mergeRowResults(hits: Hit[] | undefined): { hit: Hit; row?: { n: number; of: number } } | undefined {
    if (!hits?.length) return undefined;
    if (hits.length === 1) return { hit: hits[0]! };
    const failing = hits.find((h) => !h.result || h.result.status !== "passed");
    const rep = failing ?? hits[0]!;
    const rowOf = (h: Hit) => /\[row (\d+)\/(\d+)\]\s*$/.exec(h.title);
    const m = failing ? rowOf(failing) : null;
    const responses: unknown[] = [];
    for (const h of hits) {
        for (const a of h.result?.attachments ?? []) {
            if (a.name !== "responses" || !a.body) continue;
            try {
                const list: unknown = JSON.parse(Buffer.from(a.body, "base64").toString("utf8"));
                if (Array.isArray(list)) responses.push(...list);
            } catch {
                /* malformed attachment — ignore */
            }
        }
    }
    if (!rep.result) return { hit: rep, ...(m ? { row: { n: Number(m[1]), of: Number(m[2]) } } : {}) };
    const result: PwResult = {
        ...rep.result,
        duration: hits.reduce((sum, h) => sum + (h.result?.duration ?? 0), 0),
        attachments: [...(rep.result.attachments ?? []).filter((a) => a.name !== "responses"), ...(responses.length ? [{ name: "responses", body: Buffer.from(JSON.stringify(responses)).toString("base64"), contentType: "application/json" }] : [])],
    };
    return { hit: { ...rep, result, status: failing ? rep.status : "passed" }, ...(m ? { row: { n: Number(m[1]), of: Number(m[2]) } } : {}) };
}

/**
 * `variants` (Playwright project names): results are matched per (script, project) and returned script by
 * script, variant by variant, each tagged with its `variant`. Without it, one result per script.
 */
export async function parseReport(runDir: string, scripts: ScriptInput[], stderr: string, timedOut: boolean, runnerName = "Playwright", variants: string[] = [], evidence?: Map<string, string>): Promise<ScriptRun[]> {
    const targets = variants.length ? scripts.flatMap((s) => variants.map((v) => ({ s, v }))) : scripts.map((s) => ({ s, v: undefined as string | undefined }));
    const tag = (v: string | undefined) => (v ? { variant: v } : {});
    let report: any;
    try {
        report = JSON.parse(await fs.readFile(path.join(runDir, "report.json"), "utf8"));
    } catch {
        const reason = timedOut ? "Validation run exceeded its time limit" : `${runnerName} produced no report: ${stderr.replace(ANSI, "").slice(0, 600)}`;
        return targets.map(({ s, v }) => ({ testId: s.testId, status: "error", durationMs: 0, error: reason, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...tag(v) }));
    }

    const byFile = new Map<string, Hit[]>();
    for (const suite of report.suites ?? []) {
        for (const r of walk(suite)) {
            const key = variants.length ? `${path.basename(r.file)}|${r.project}` : path.basename(r.file);
            byFile.set(key, [...(byFile.get(key) ?? []), r]);
        }
    }
    const topLevelErrors: string = (report.errors ?? []).map((e: any) => e.message).join("\n");

    return Promise.all(targets.map(async ({ s, v }): Promise<ScriptRun> => {
        const merged = mergeRowResults(byFile.get(v ? `${s.filename}|${v}` : s.filename));
        const hit = merged?.hit;
        if (!hit || !hit.result) {
            return {
                testId: s.testId,
                status: "error",
                durationMs: 0,
                error: (topLevelErrors || "Script did not execute (syntax or import error?)").replace(ANSI, "").slice(0, 1500),
                failedStepIndex: -1,
                steps: [],
                artifacts: [],
                responses: [],
                ...tag(v),
            };
        }
        const r = hit.result;
        const steps: StepResult[] = [];
        for (const st of r.steps ?? []) {
            const m = /^(\d+)\.\s/.exec(st.title);
            if (!m) continue;
            steps.push({
                index: Number(m[1]) - 1,
                // A data-driven script has one test per row: say which row a failing step belongs to.
                title: st.error && merged?.row ? `${st.title} (data row ${merged.row.n} of ${merged.row.of})` : st.title,
                status: st.error ? "failed" : "passed",
                error: st.error?.message?.replace(ANSI, "").slice(0, 800),
            });
        }
        const failed = steps.find((x) => x.status === "failed");
        const status = r.status === "passed" ? "passed" : r.status === "timedOut" ? "timedOut" : r.status === "skipped" ? "skipped" : "failed";
        const artifacts: ScriptRun["artifacts"] = [];
        let responses: ScriptRun["responses"] = [];
        let metrics: ScriptRun["metrics"];
        const notes: string[] = [];
        const visionShots: Array<{ step: number; path: string }> = [];
        const visionAsks = new Map<number, string>();
        for (const a of r.attachments ?? []) {
            // Handed to the caller as text, not kept in the result: it is stored only after redaction (storeEvidence).
            if (a.name === EVIDENCE_ATTACHMENT) {
                if (evidence && a.body) evidence.set(`${s.testId}|${v ?? ""}`, Buffer.from(a.body, "base64").toString("utf8"));
                continue;
            }
            if (a.name === "metrics" && a.body) {
                metrics = parseMetrics(Buffer.from(a.body, "base64").toString("utf8"));
                continue;
            }
            // Plain notes a passing check wants kept with its run (e.g. a load check that was stopped by a rate limit).
            if (a.name === "notes" && a.body) {
                try {
                    const parsed = JSON.parse(Buffer.from(a.body, "base64").toString("utf8")) as unknown;
                    if (Array.isArray(parsed)) notes.push(...parsed.filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 500)));
                } catch {
                    /* malformed attachment — ignore */
                }
                continue;
            }
            if (a.name === "responses" && a.body) {
                try {
                    responses = JSON.parse(Buffer.from(a.body, "base64").toString("utf8"));
                } catch {
                    /* malformed attachment — ignore */
                }
                continue;
            }
            // `looksRight` steps: the screenshot to judge and what to look for (see vision/capture.ts). Kept as evidence too.
            const shot = /^vision-shot-(\d+)$/.exec(a.name);
            if (shot && (a.path || a.body)) {
                const step = Number(shot[1]);
                let file = a.path;
                if (!file) {
                    file = path.join(runDir, "artifacts", `${s.testId}${v ? `-${v}` : ""}-vision-${step}.jpg`);
                    await fs.mkdir(path.dirname(file), { recursive: true });
                    await fs.writeFile(file, Buffer.from(a.body!, "base64"));
                }
                artifacts.push({ kind: "vision-shot", path: file });
                visionShots.push({ step, path: file });
                continue;
            }
            const ask = /^vision-ask-(\d+)$/.exec(a.name);
            if (ask && a.body) {
                try {
                    const parsed = JSON.parse(Buffer.from(a.body, "base64").toString("utf8")) as { expected?: unknown };
                    if (typeof parsed.expected === "string" && parsed.expected.trim()) visionAsks.set(Number(ask[1]), parsed.expected.trim());
                } catch {
                    /* malformed attachment — the screenshot is then judged without a specific question */
                }
                continue;
            }
            // Mobile scripts attach their failure screenshot inline (base64) instead of as a file.
            if (!a.path && a.name === "screenshot" && a.body && a.contentType === "image/png") {
                const file = path.join(runDir, "artifacts", `${s.testId}${v ? `-${v}` : ""}-failure.png`);
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, Buffer.from(a.body, "base64"));
                artifacts.push({ kind: "screenshot", path: file });
                continue;
            }
            if (!a.path) continue;
            if (a.name === "screenshot") artifacts.push({ kind: "screenshot", path: a.path });
            else if (a.name === "trace" || a.name === "taqwright-trace") artifacts.push({ kind: "trace", path: a.path });
            else if (a.name === "video" || a.name === "taqwright-video") artifacts.push({ kind: "video", path: a.path });
            else if (a.name.endsWith("-actual.png")) artifacts.push({ kind: "visual-actual", path: a.path });
            else if (a.name.endsWith("-diff.png")) artifacts.push({ kind: "visual-diff", path: a.path });
        }
        return {
            testId: s.testId,
            status,
            durationMs: r.duration,
            error: r.error?.message?.replace(ANSI, "").slice(0, 2000),
            failedStepIndex: failed ? failed.index : -1,
            steps,
            artifacts,
            responses,
            ...(metrics?.length ? { metrics } : {}),
            ...(notes.length ? { notes } : {}),
            ...(visionShots.length ? { vision: visionShots.map((x) => ({ ...x, ...(visionAsks.has(x.step) ? { expected: visionAsks.get(x.step) } : {}) })) } : {}),
            ...tag(v),
        };
    }));
}
