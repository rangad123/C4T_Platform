/**
 * The process that runs one task's scripts, seen from the agent.
 *
 * Why a process per task: cancelling or timing out a run has to stop the test runner AND everything it started (workers,
 * browsers, an Appium server). The platform's own runner only kills the process it started; here the agent owns the whole
 * tree and kills it all (taskkill /T on Windows, a process group elsewhere). A crash in a runner also cannot take the agent down.
 */
import { spawn, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LiveRunEvent, ScriptRun } from "../engine/validation/runner.js";
import { CHILD_ENV_ALLOW } from "../engine/validation/runner.js";
import type { ChildRun, FromChild } from "./child-protocol.js";

export type TaskOutcome = { kind: "result"; runs: ScriptRun[] } | { kind: "error"; message: string } | { kind: "crashed"; detail: string };

/** Kill a process and everything below it. */
export function killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill("SIGKILL"));
        return;
    }
    try {
        process.kill(-pid, "SIGKILL"); // the child leads its own process group (see `detached` below)
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            /* already gone */
        }
    }
}

/** Variables the runner may read from the agent's own environment. The agent's token and settings are not among them. */
const MOBILE_ENV = ["TAQWRIGHT_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_AVD_HOME", "ANDROID_USER_HOME", "JAVA_HOME", "APPIUM_HOME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "DEVELOPER_DIR"];
/** Test seams: stand-ins for the Taqwright CLI (the platform's own tests use the same variable) and, for iOS, for Taqwright and `xcrun`. */
const SEAM = ["MOBILE_RUNNER_CLI", "IOS_RUNNER_CLI", "IOS_XCRUN_CLI"];

export function childEnvFrom(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const allow = new Set([...CHILD_ENV_ALLOW, ...MOBILE_ENV, ...SEAM]);
    return Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== undefined && allow.has(k.toUpperCase())));
}

const ENTRY = fileURLToPath(new URL("./task-child.mjs", import.meta.url));

export class TaskProcess {
    private readonly child: ChildProcess;
    private settled?: (o: TaskOutcome) => void;
    private outcome?: TaskOutcome;
    private tail = "";
    readonly done: Promise<TaskOutcome>;
    /** Protocol 2: the child's live events (set before `start`). */
    onLive?: (e: LiveRunEvent) => void;

    constructor(source: NodeJS.ProcessEnv, private readonly onLog: (line: string) => void, entry: string = ENTRY) {
        this.child = fork(entry, [], {
            env: childEnvFrom(source),
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        this.done = new Promise((resolve) => {
            this.settled = resolve;
        });
        const keep = (d: Buffer) => {
            this.tail = `${this.tail}${d}`.slice(-1500);
        };
        this.child.stdout?.on("data", keep);
        this.child.stderr?.on("data", keep);
        this.child.on("message", (raw) => {
            const m = raw as FromChild;
            if (m?.type === "log" && typeof m.line === "string") this.onLog(m.line);
            else if (m?.type === "live" && m.event && typeof m.event === "object") this.onLive?.(m.event);
            else if (m?.type === "result" && Array.isArray(m.runs)) this.finish({ kind: "result", runs: m.runs });
            else if (m?.type === "error") this.finish({ kind: "error", message: String(m.message).slice(0, 500) });
        });
        this.child.on("error", (e) => this.finish({ kind: "crashed", detail: `The test runner could not be started (${e.message}).` }));
        this.child.on("exit", (code, signal) => {
            // A message may still be on its way when the exit event fires; give it a moment.
            setTimeout(() => this.finish({ kind: "crashed", detail: `The test runner stopped unexpectedly (${signal ?? `exit code ${code}`}).` }), 200);
        });
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    private finish(o: TaskOutcome): void {
        if (this.outcome) return;
        this.outcome = o;
        this.settled?.(o);
    }

    /** What the process wrote to its output before it ended (for a crash, after secrets are masked by the caller). */
    get output(): string {
        return this.tail;
    }

    start(msg: ChildRun): void {
        this.child.send(msg, (err) => {
            if (err) this.finish({ kind: "crashed", detail: "The test runner did not accept the task." });
        });
    }

    /** Kill the runner and everything it started, now (cancel, time-out, shutdown). Killing the whole tree at once also catches workers and browsers that would be orphans if only the top process died. */
    kill(): void {
        killTree(this.child);
    }
}
