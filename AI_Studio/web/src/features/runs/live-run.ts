/**
 * A run on a runner, rebuilt from its stored events: which phase the runner's task is in, the test and step it is on, the steps and
 * tests done, live log lines, the screenshots that arrived and the failures with their text. Pure (no React, no network), so the
 * same events always give the same picture: the page reads every stored event again after a refresh or when someone comes back
 * later, and folds them here.
 *
 * The events (kinds stored on the job: the runner's live events, protocol 2, see LIVE_EVENT_KINDS in src/agent-protocol/schema.ts,
 * and the platform's own task events):
 *   runner_phase          data { phase }                                   the task moved (queued, assigned, accepted, preparing, ...)
 *   runner_test_started   data { testId, title? }                          testId is the test's key (WEB-001)
 *   runner_step           data { testId, index, title, state, status? }    state "started" | "finished"; status "passed" | "failed"
 *   runner_test_finished  data { testId, status, durationMs, error?, stack? }
 *   runner_screenshot     data { testId, ref, step?, taskId }               shown through the run's runner-files route (liveShotUrl)
 *   runner_log, runner_rejected, runner_requeued, runner_lost, ...         their message is a line of the runner log
 * Every runner event carries data.attempt: a new attempt (the run was offered again) starts the tests over.
 * A protocol-1 runner sends none of these; its lines (agent_task_queued, agent_task_started, agent_progress) still give a phase and a log.
 */
import type { EventRow, Job } from "../../api.js";
import type { RunTest } from "./run-text.js";

export type TaskPhase = "queued" | "assigned" | "accepted" | "preparing" | "running" | "uploading" | "completed" | "rejected" | "failed" | "cancelled" | "timed_out" | "lost_connection";
export const TASK_PHASES: readonly TaskPhase[] = ["queued", "assigned", "accepted", "preparing", "running", "uploading", "completed", "rejected", "failed", "cancelled", "timed_out", "lost_connection"];
/** The way a run normally goes, in order: the steps shown on the run page. */
export const PHASE_STEPS: readonly TaskPhase[] = ["queued", "assigned", "accepted", "preparing", "running", "uploading", "completed"];
export const PHASE_STEP_WORD: Record<TaskPhase, string> = {
    queued: "Queued",
    assigned: "Offered",
    accepted: "Accepted",
    preparing: "Getting ready",
    running: "Running",
    uploading: "Sending results",
    completed: "Done",
    rejected: "Turned down",
    failed: "Did not finish",
    cancelled: "Stopped",
    timed_out: "Took too long",
    lost_connection: "Lost contact",
};
const ENDED: ReadonlySet<TaskPhase> = new Set(["completed", "rejected", "failed", "cancelled", "timed_out", "lost_connection"]);
export const phaseEnded = (p: TaskPhase | null): boolean => p !== null && ENDED.has(p);
export const isPhase = (v: unknown): v is TaskPhase => typeof v === "string" && (TASK_PHASES as readonly string[]).includes(v);

/** One sentence for the phase, with the runner's name where it helps. */
export function phaseSentence(phase: TaskPhase, runner: string | null, reason?: string | null): string {
    const who = runner ?? "the runner";
    const Who = runner ?? "The runner";
    const why = reason ? ` ${reason.replace(/\s+$/, "")}${/[.?]$/.test(reason.trim()) ? "" : "."}` : "";
    switch (phase) {
        case "queued":
            return "Waiting for a runner to take this run.";
        case "assigned":
            return `Offered to ${who}, waiting for it to accept.`;
        case "accepted":
            return `${Who} accepted the run.`;
        case "preparing":
            return `${Who} is getting ready: it fetches the tests and the files they need.`;
        case "running":
            return `Running on ${who}.`;
        case "uploading":
            return `${Who} is sending the results.`;
        case "completed":
            return `Finished on ${who}.`;
        case "rejected":
            return `${Who} turned the run down.${why}`;
        case "failed":
            return `The run did not finish on ${who}.${why}`;
        case "cancelled":
            return "The run was stopped.";
        case "timed_out":
            return `The run took longer than its time limit, so ${who} was told to stop.`;
        case "lost_connection":
            return `${Who} stopped answering, so the run did not finish.${why}`;
    }
}

export type LiveStatus = "running" | "passed" | "failed" | "skipped";

export interface LiveStep {
    index: number;
    title: string;
    status: LiveStatus;
    durationMs?: number;
    error?: string;
}

export interface LiveTest {
    /** The id the runner used: the test's key (WEB-001) or its id. */
    key: string;
    title?: string;
    status: LiveStatus;
    startedAt: string;
    durationMs?: number;
    error?: string;
    stack?: string;
    steps: LiveStep[];
}

export interface LiveShot {
    /** The event's id (stable, so a refresh draws the same list). */
    id: number;
    /** The task and the file name the runner uploaded it under (null when the event did not name a usable one). */
    taskId: string | null;
    ref: string | null;
    testKey?: string;
    stepIndex?: number;
    title?: string;
    at: string;
}

export interface LiveLine {
    id: number;
    at: string;
    level: string;
    text: string;
}

export interface LiveFailure {
    testKey: string;
    testTitle?: string;
    step?: string;
    error: string;
    stack?: string;
}

export interface LiveRun {
    /** The phase the events last named (null: none did). The page prefers the platform's own answer when it gives one (runPhase). */
    phase: TaskPhase | null;
    phaseReason: string | null;
    /** When the runner took the run (accepted, or started its first test), as the events say. */
    startedAt: string | null;
    tests: LiveTest[];
    current: { test: LiveTest; step: LiveStep | null } | null;
    stepsDone: number;
    passed: number;
    failed: number;
    skipped: number;
    lines: LiveLine[];
    shots: LiveShot[];
    failures: LiveFailure[];
    /** The furthest step of PHASE_STEPS the events reached (-1: none), so a run that ended badly still shows how far it got. */
    furthest: number;
    /** True when the runner sent step-level events (protocol 2); false for a runner that only sends text lines. */
    detailed: boolean;
    /** The newest event id folded in. */
    lastId: number;
}

/** Kinds that become structure, not log lines. */
const STRUCTURED = new Set(["runner_test_started", "runner_step", "runner_test_finished", "runner_screenshot"]);
/** The events a live view needs; everything else of the job is left to the activity log. */
export const isRunnerEvent = (e: Pick<EventRow, "kind">): boolean => e.kind.startsWith("runner_") || e.kind.startsWith("agent_task") || e.kind === "agent_progress" || e.kind === "agent_browser";

export const LINES_KEPT = 300;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Where a live screenshot is shown from: the run's runner-files route (an image of a task of this run, kept with the task for a day). */
export const liveShotUrl = (projectId: string, jobId: string, s: Pick<LiveShot, "taskId" | "ref">): string | null =>
    s.taskId && s.ref ? `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(jobId)}/runner-files/${encodeURIComponent(s.taskId)}/${encodeURIComponent(s.ref)}` : null;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function finishedStatus(v: unknown): LiveStatus | undefined {
    const s = str(v)?.toLowerCase();
    if (!s) return undefined;
    if (s === "passed" || s === "ok" || s === "expected") return "passed";
    if (s === "skipped") return "skipped";
    if (s === "failed" || s === "error" || s === "timedout" || s === "timed_out" || s === "interrupted" || s === "unexpected") return "failed";
    return undefined;
}

/** Folds a run's stored events (any order, any kinds) into what its live view shows. */
export function foldLiveRun(events: readonly EventRow[]): LiveRun {
    const rows = [...events].sort((a, b) => a.id - b.id);
    let phase: TaskPhase | null = null;
    let phaseReason: string | null = null;
    let startedAt: string | null = null;
    let attempt: string | number | null = null;
    let detailed = false;
    let furthest = -1;
    let tests: LiveTest[] = [];
    let shots: LiveShot[] = [];
    const lines: LiveLine[] = [];
    let lastId = 0;

    const testFor = (key: string, at: string): LiveTest => {
        let t = tests.find((x) => x.key === key);
        if (!t) {
            t = { key, status: "running", startedAt: at, steps: [] };
            tests.push(t);
        }
        return t;
    };

    for (const e of rows) {
        lastId = Math.max(lastId, e.id);
        if (phase) furthest = Math.max(furthest, PHASE_STEPS.indexOf(phase));
        const d = obj(e.data);
        if (e.kind.startsWith("runner_")) {
            const a = num(d.attempt) ?? str(d.attemptId) ?? null;
            // The run was offered again: what the earlier attempt did is no longer the run's story (its lines stay in the log).
            if (a !== null && attempt !== null && a !== attempt) {
                tests = [];
                shots = [];
                startedAt = null;
                furthest = -1;
            }
            if (a !== null) attempt = a;
        }
        switch (e.kind) {
            case "runner_phase": {
                if (isPhase(d.phase)) {
                    phase = d.phase;
                    phaseReason = str(d.reason) ?? (ENDED.has(d.phase) && d.phase !== "completed" ? (str(e.message) ?? null) : null);
                    if ((d.phase === "accepted" || d.phase === "preparing" || d.phase === "running") && !startedAt) startedAt = e.createdAt;
                }
                break;
            }
            case "agent_task_queued":
                if (!phase) phase = "queued";
                break;
            case "agent_task_started":
                if (!phase || phase === "queued") phase = "running";
                startedAt ??= e.createdAt;
                break;
            case "runner_test_started": {
                detailed = true;
                const key = str(d.testId);
                if (!key) break;
                startedAt ??= e.createdAt;
                // A test started, so the runner is past getting ready (an ended phase stays: only a phase event moves it on).
                const at = phase === null ? -1 : PHASE_STEPS.indexOf(phase);
                if (phase === null || (at >= 0 && at < PHASE_STEPS.indexOf("running"))) phase = "running";
                const known = tests.find((x) => x.key === key);
                // The same test started again (a retry of a failing test): it starts over.
                if (known && known.status !== "running") tests = tests.filter((x) => x !== known);
                const t = testFor(key, e.createdAt);
                t.title = str(d.title) ?? t.title;
                break;
            }
            case "runner_step": {
                detailed = true;
                const key = str(d.testId);
                if (!key) break;
                const t = testFor(key, e.createdAt);
                const index = num(d.index) ?? num(d.stepIndex) ?? t.steps.length;
                const title = str(d.title) ?? str(d.name) ?? `Step ${index + 1}`;
                const state = str(d.state) ?? (str(d.type) === "step_started" ? "started" : str(d.type) === "step_finished" ? "finished" : undefined);
                const status: LiveStatus = state === "started" ? "running" : (finishedStatus(d.status) ?? (state === "finished" ? "passed" : "running"));
                let step = t.steps.find((s) => s.index === index);
                if (!step) {
                    step = { index, title, status };
                    t.steps.push(step);
                    t.steps.sort((x, y) => x.index - y.index);
                }
                step.title = title;
                step.status = status;
                const ms = num(d.durationMs);
                if (ms !== undefined) step.durationMs = ms;
                const err = str(d.error);
                if (err) step.error = err;
                break;
            }
            case "runner_test_finished": {
                detailed = true;
                const key = str(d.testId);
                if (!key) break;
                const t = testFor(key, e.createdAt);
                t.title = str(d.title) ?? t.title;
                t.status = finishedStatus(d.status) ?? "failed";
                const ms = num(d.durationMs);
                if (ms !== undefined) t.durationMs = ms;
                t.error = str(d.error) ?? (t.status === "failed" ? t.steps.find((s) => s.status === "failed")?.error : undefined);
                t.stack = str(d.stack);
                // A step still "running" when its test ended did not finish.
                for (const s of t.steps) if (s.status === "running") s.status = t.status === "passed" ? "passed" : "skipped";
                break;
            }
            case "runner_screenshot": {
                detailed = true;
                const taskId = str(d.taskId);
                const ref = str(d.ref);
                const usable = taskId && ref && SAFE_ID.test(taskId) && SAFE_NAME.test(ref);
                shots.push({ id: e.id, taskId: usable ? taskId : null, ref: usable ? ref : null, testKey: str(d.testId), stepIndex: num(d.step) ?? num(d.index), title: str(d.title), at: e.createdAt });
                break;
            }
            default:
                break;
        }
        if (isRunnerEvent(e) && !STRUCTURED.has(e.kind) && str(e.message)) lines.push({ id: e.id, at: e.createdAt, level: e.level, text: e.message });
    }

    const running = [...tests].reverse().find((t) => t.status === "running") ?? null;
    const step = running ? ([...running.steps].reverse().find((s) => s.status === "running") ?? running.steps.at(-1) ?? null) : null;
    const failures: LiveFailure[] = tests
        .filter((t) => t.status === "failed")
        .map((t) => {
            const bad = t.steps.find((s) => s.status === "failed");
            return { testKey: t.key, testTitle: t.title, step: bad ? `Step ${bad.index + 1}: ${bad.title}` : undefined, error: t.error ?? bad?.error ?? "The test failed.", stack: t.stack };
        });
    return {
        phase,
        phaseReason,
        startedAt,
        tests,
        current: running ? { test: running, step } : null,
        stepsDone: tests.reduce((n, t) => n + t.steps.filter((s) => s.status !== "running").length, 0),
        passed: tests.filter((t) => t.status === "passed").length,
        failed: tests.filter((t) => t.status === "failed").length,
        skipped: tests.filter((t) => t.status === "skipped").length,
        lines: lines.slice(-LINES_KEPT),
        shots,
        failures,
        detailed,
        furthest: Math.max(furthest, phase ? PHASE_STEPS.indexOf(phase) : -1),
        lastId,
    };
}

/**
 * The phase to show: the platform's own answer about the task when it gives one (the run's `ranOn.phase`, or a `phase` beside the job),
 * else what the events say, and once the run is over, what the job itself says (a runner that never named its phases still finished).
 */
export function runPhase(job: Pick<Job, "status" | "cancelled" | "ranOn">, live: Pick<LiveRun, "phase">, active: boolean, answer?: object): TaskPhase | null {
    const said = obj(job.ranOn).phase ?? obj(job).phase ?? obj(answer).phase;
    if (isPhase(said)) return said;
    if (!active && !phaseEnded(live.phase)) {
        if (job.cancelled) return "cancelled";
        if (job.status === "FAILED") return live.phase || job.ranOn?.kind === "agent" ? "failed" : null;
        if (job.status === "COMPLETED" || job.status === "PARTIALLY_COMPLETED") return live.phase || job.ranOn?.kind === "agent" ? "completed" : null;
    }
    return live.phase;
}

/** The runner a run went to (its `agent_tokens` id, the id of its page), when the platform names it on `ranOn`. */
export function runnerIdOf(job: Pick<Job, "ranOn">): string | undefined {
    const id = obj(job.ranOn).runnerId;
    return typeof id === "string" && SAFE_ID.test(id) ? id : undefined;
}

/** The task phase the platform put on the run's `ranOn`, if it did. */
export function taskPhaseOf(job: Pick<Job, "ranOn">): TaskPhase | null {
    const p = obj(job.ranOn).phase;
    return isPhase(p) ? p : null;
}

/** "WEB-003, step 4: Click Pay": what a screenshot shows. */
export function shotCaption(s: LiveShot, tests: readonly LiveTest[]): string {
    const t = s.testKey ? tests.find((x) => x.key === s.testKey) : undefined;
    const step = s.stepIndex !== undefined ? t?.steps.find((x) => x.index === s.stepIndex) : undefined;
    const parts = [s.testKey ? (t?.title ? `${s.testKey} ${t.title}` : s.testKey) : null, step ? `step ${step.index + 1}: ${step.title}` : s.stepIndex !== undefined ? `step ${s.stepIndex + 1}` : null, s.title && !step ? s.title : null].filter(Boolean);
    return parts.length ? parts.join(", ") : "Screenshot";
}

/** The one line that says where a running test is: "Checkout (WEB-003), step 4: Click Pay". */
export function currentLine(c: NonNullable<LiveRun["current"]>): string {
    const name = c.test.title ? `${c.test.title} (${c.test.key})` : c.test.key;
    return c.step ? `${name}, step ${c.step.index + 1}: ${c.step.title}` : name;
}

const LIVE_STATE = { running: "running", passed: "passed", failed: "failed", skipped: "not_run" } as const;

/**
 * A test's row as the runner reports it while its result is not stored yet: the platform records a runner's results when the runner
 * sends them all, so until then a test it already ran says what the runner said (and the step a running test is on).
 */
export function withLive(t: RunTest, live: LiveRun | undefined): RunTest & { step?: string } {
    if (!live || (t.state !== "waiting" && t.state !== "running")) return t;
    const lt: LiveTest | undefined = live.tests.find((x) => x.key === t.testId) ?? live.tests.find((x) => x.key === t.id);
    if (!lt) return t;
    const running = lt.status === "running" ? [...lt.steps].reverse().find((s) => s.status === "running") ?? lt.steps.at(-1) : undefined;
    return {
        ...t,
        state: LIVE_STATE[lt.status],
        ...(lt.error && lt.status === "failed" ? { reason: lt.error } : {}),
        ...(lt.durationMs !== undefined ? { durationMs: lt.durationMs } : {}),
        ...(running ? { step: `Step ${running.index + 1}: ${running.title}` } : {}),
    };
}
