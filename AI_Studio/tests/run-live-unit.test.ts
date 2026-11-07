/**
 * The live view of a run on a runner, folded from its stored events (web/src/features/runs/live-run.ts): phases, the test and step
 * it is on, steps done, results so far, failures with their text, screenshots, log lines, a new attempt, a retried test, a
 * protocol-1 runner that only sends text, and the words. Pure: no browser, no network.
 */
import { describe, expect, it } from "vitest";
import type { EventRow } from "../web/src/api.js";
import { currentLine, foldLiveRun, phaseSentence, runPhase, shotCaption, taskPhaseOf, TASK_PHASES, liveShotUrl, withLive } from "../web/src/features/runs/live-run.js";


let id = 0;
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 10, 0, s)).toISOString();
const ev = (kind: string, data?: Record<string, unknown>, message = "", level = "info"): EventRow => ({ id: ++id, stage: "validation", kind, level, message, createdAt: at(id), ...(data ? { data } : {}) });

describe("folding a runner's events", () => {
    it("follows phases, the current test and step, steps done and results so far", () => {
        id = 0;
        const events = [
            ev("agent_task_queued", undefined, "Sent 2 script(s) to a runner agent."),
            ev("runner_phase", { phase: "assigned" }),
            ev("runner_phase", { phase: "accepted" }),
            ev("runner_phase", { phase: "preparing" }),
            ev("runner_test_started", { testId: "WEB-001", title: "Sign in" }),
            ev("runner_step", { testId: "WEB-001", index: 0, title: "Open the page", state: "started" }),
            ev("runner_step", { testId: "WEB-001", index: 0, title: "Open the page", state: "finished", status: "passed", durationMs: 300 }),
            ev("runner_step", { testId: "WEB-001", index: 1, title: "Click Sign in", state: "started" }),
        ];
        const mid = foldLiveRun(events);
        expect(mid.phase).toBe("running");
        expect(mid.detailed).toBe(true);
        expect(mid.startedAt).toBe(at(3));
        expect(mid.current && currentLine(mid.current)).toBe("Sign in (WEB-001), step 2: Click Sign in");
        expect(mid.stepsDone).toBe(1);
        expect([mid.passed, mid.failed]).toEqual([0, 0]);
        expect(mid.lines.map((l) => l.text)).toEqual(["Sent 2 script(s) to a runner agent."]);

        const more = [
            ...events,
            ev("runner_step", { testId: "WEB-001", index: 1, title: "Click Sign in", state: "finished", status: "passed" }),
            ev("runner_test_finished", { testId: "WEB-001", status: "passed", durationMs: 900 }),
            ev("runner_test_started", { testId: "WEB-002", title: "Checkout" }),
            ev("runner_step", { testId: "WEB-002", index: 0, title: "Click Pay", state: "finished", status: "failed", error: "Timed out waiting for Pay" }),
            ev("runner_screenshot", { testId: "WEB-002", step: 0, ref: "WEB-002-step1.png", taskId: "task_1", attempt: 1 }),
            ev("runner_test_finished", { testId: "WEB-002", status: "failed", error: "Timed out waiting for Pay", stack: "at checkout.spec.ts:12" }),
            ev("runner_log", undefined, "Closing the browser", "info"),
            ev("runner_phase", { phase: "uploading" }),
        ];
        // Order of arrival does not matter: events are folded by id.
        const end = foldLiveRun([...more].reverse());
        expect(end.phase).toBe("uploading");
        expect(end.current).toBeNull();
        expect([end.passed, end.failed, end.stepsDone]).toEqual([1, 1, 3]);
        expect(end.failures).toEqual([{ testKey: "WEB-002", testTitle: "Checkout", step: "Step 1: Click Pay", error: "Timed out waiting for Pay", stack: "at checkout.spec.ts:12" }]);
        expect(end.shots).toHaveLength(1);
        expect(liveShotUrl("p1", "j1", end.shots[0]!)).toBe("/api/projects/p1/runs/j1/runner-files/task_1/WEB-002-step1.png");
        expect(shotCaption(end.shots[0]!, end.tests)).toBe("WEB-002 Checkout, step 1: Click Pay");
        expect(end.lines.map((l) => l.text)).toEqual(["Sent 2 script(s) to a runner agent.", "Closing the browser"]);
        expect(end.furthest).toBe(5);
    });

    it("starts the tests over on a new attempt, and a retried test starts over too", () => {
        id = 0;
        const run = foldLiveRun([
            ev("runner_test_started", { testId: "WEB-001", attempt: 1 }),
            ev("runner_test_finished", { testId: "WEB-001", status: "failed", error: "first", attempt: 1 }),
            ev("runner_requeued", { reason: "lost", attempt: 1 }, "maya-laptop stopped answering; offering the run again."),
            ev("runner_attempt", { attempt: 2 }, "Offered to the runner “maya-laptop” (attempt 2)."),
            ev("runner_test_started", { testId: "WEB-001", attempt: 2 }),
        ]);
        expect(run.tests).toHaveLength(1);
        expect(run.tests[0]!.status).toBe("running");
        expect(run.failed).toBe(0);
        // The reason stays in the log.
        expect(run.lines.map((l) => l.text)).toEqual(["maya-laptop stopped answering; offering the run again.", "Offered to the runner “maya-laptop” (attempt 2)."]);

        const retried = foldLiveRun([ev("runner_test_started", { testId: "WEB-009" }), ev("runner_test_finished", { testId: "WEB-009", status: "failed", error: "x" }), ev("runner_test_started", { testId: "WEB-009" }), ev("runner_test_finished", { testId: "WEB-009", status: "passed" })]);
        expect([retried.passed, retried.failed, retried.tests.length]).toEqual([1, 0, 1]);
    });

    it("a protocol-1 runner: a phase from its queued and started lines, and its text as the log", () => {
        id = 0;
        const run = foldLiveRun([
            ev("agent_task_queued", undefined, "Sent 3 script(s) to a runner agent."),
            ev("agent_task_started", undefined, "Running on the runner agent “maya-laptop”."),
            ev("agent_progress", undefined, "maya-laptop: Finished 1 of 3"),
            ev("validation_started", undefined, "Not a runner line"),
        ]);
        expect(run.detailed).toBe(false);
        expect(run.phase).toBe("running");
        expect(run.lines.map((l) => l.text)).toEqual(["Sent 3 script(s) to a runner agent.", "Running on the runner agent “maya-laptop”.", "maya-laptop: Finished 1 of 3"]);
    });

    it("ignores what it cannot use: no test id, an unsafe artifact id, an unknown phase", () => {
        id = 0;
        const run = foldLiveRun([ev("runner_step", { index: 0, title: "x" }), ev("runner_screenshot", { taskId: "t1", ref: "../../etc/passwd" }), ev("runner_phase", { phase: "dancing" })]);
        expect(run.tests).toEqual([]);
        expect(liveShotUrl("p", "j", run.shots[0]!)).toBeNull();
        expect(run.phase).toBeNull();
    });
});

describe("the phase shown", () => {
    const job = { status: "VALIDATING" as const, cancelled: null, ranOn: { kind: "agent" as const, agentId: "r1", name: "maya-laptop" } };
    it("prefers the platform's own answer, then the events, then the job once it is over", () => {
        expect(runPhase({ ...job, ranOn: { ...job.ranOn, phase: "preparing" } as typeof job.ranOn }, { phase: "running" }, true)).toBe("preparing");
        expect(runPhase(job, { phase: "assigned" }, true, { phase: "accepted" })).toBe("accepted");
        expect(runPhase(job, { phase: "running" }, true)).toBe("running");
        expect(runPhase({ ...job, status: "COMPLETED" }, { phase: "running" }, false)).toBe("completed");
        expect(runPhase({ ...job, status: "FAILED" }, { phase: null }, false)).toBe("failed");
        expect(runPhase({ ...job, status: "FAILED", cancelled: { planned: 2, ran: 0, notRun: 2, note: "" } }, { phase: "running" }, false)).toBe("cancelled");
        expect(runPhase({ ...job, status: "COMPLETED", ranOn: { kind: "platform" } as never }, { phase: null }, false)).toBeNull();
        expect(taskPhaseOf({ ranOn: { ...job.ranOn, phase: "uploading" } as typeof job.ranOn })).toBe("uploading");
        expect(taskPhaseOf(job)).toBeNull();
    });

    it("every phase has a plain sentence, without exclamation marks", () => {
        for (const p of TASK_PHASES) {
            const s = phaseSentence(p, "maya-laptop", p === "rejected" ? "Google Chrome is not installed" : null);
            // A runner keeps the name it was given (maya-laptop), so only the other sentences start with a capital.
            expect(s).toMatch(/^(?:[A-Z]|maya-laptop ).*\.$/);
            expect(s).not.toMatch(/!/);
        }
        expect(phaseSentence("rejected", "maya-laptop", "Google Chrome is not installed")).toBe("maya-laptop turned the run down. Google Chrome is not installed.");
        expect(phaseSentence("assigned", null)).toBe("Offered to the runner, waiting for it to accept.");
    });
});

describe("a test's row while the runner's results are not stored yet", () => {
    const row = { id: "t1", testId: "WEB-001", title: "Sign in", suite: "s", state: "waiting" as const };
    it("shows what the runner reported, and the step a running test is on", () => {
        id = 0;
        const live = foldLiveRun([ev("runner_test_started", { testId: "WEB-001" }), ev("runner_step", { testId: "WEB-001", index: 2, title: "Type the password", state: "started" })]);
        expect(withLive(row, live)).toMatchObject({ state: "running", step: "Step 3: Type the password" });
        const done = foldLiveRun([ev("runner_test_started", { testId: "t1" }), ev("runner_test_finished", { testId: "t1", status: "failed", error: "Nope", durationMs: 50 })]);
        expect(withLive(row, done)).toMatchObject({ state: "failed", reason: "Nope", durationMs: 50 });
        // A stored result wins.
        expect(withLive({ ...row, state: "passed" }, done).state).toBe("passed");
        expect(withLive(row, undefined)).toBe(row);
    });
});
