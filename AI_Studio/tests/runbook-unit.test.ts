/**
 * Runbooks, the browser-free part: what a valid definition is (forward routes only, no loops, limits, placeholders, production
 * confirmation), how a run moves from step to step, how a check judges the run before it, message templates, the presets, and
 * the store's guarantees (one active run per project, interrupted runs, links to schedules and tokens).
 */
import { describe, expect, it } from "vitest";
import { evaluateCondition, finalStatus, nextAfter, passRateOf, stepTitle, type Facts } from "../src/engine/runbook/flow.js";
import { PRESETS, presetDefinition } from "../src/engine/runbook/presets.js";
import { MAX_STEPS, PLACEHOLDERS, parseDefinition, projectProblems, renderTemplate, templateProblems, type RunbookDefinition } from "../src/engine/runbook/schema.js";
import { Db } from "../src/platform/db.js";
import { RunbookBusy, RunbookStore } from "../src/platform/runbook-store.js";

const run = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "run", scope: "all", ...extra });
const def = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, name: "Release gate", steps, ...extra });
const ok = (input: unknown): RunbookDefinition => {
    const r = parseDefinition(input);
    if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(" | "));
    return r.definition;
};
const errors = (input: unknown) => {
    const r = parseDefinition(input);
    return r.ok ? [] : r.errors.map((e) => e.message);
};

describe("runbook definition", () => {
    it("accepts every step type and fills in defaults", () => {
        const d = ok(
            def([
                run("smoke", { scope: { type: "smoke" }, onFail: "tell" }),
                { id: "analyze", type: "analyze" },
                { id: "rate", type: "condition", condition: { check: "passRate", atLeast: 90 } },
                { id: "wait", type: "wait", seconds: 5 },
                { id: "tell", type: "notify", channelId: "c1", message: "{{project}} {{status}} {{passRate}} {{failed}} {{runUrl}}" },
            ]),
        );
        expect(d.steps).toHaveLength(5);
        const first = d.steps[0]!;
        expect(first.type === "run" && first.retries).toBe(1);
        const analyze = d.steps[1]!;
        // Nothing risky is switched on by default.
        expect(analyze.type === "analyze" && analyze.allowMutatingApiTests).toBeUndefined();
        expect(analyze.type === "analyze" && analyze.loadChecks).toBeUndefined();
    });

    it("limits: at most 12 steps, at least 1, a name of 1 to 80 characters, version 1", () => {
        const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => run(`s${i}`));
        expect(errors(def(many)).join(" ")).toMatch(/up to 12 steps/);
        expect(parseDefinition(def(many.slice(0, MAX_STEPS))).ok).toBe(true);
        expect(errors(def([]))).toEqual(["A runbook needs at least one step"]);
        expect(errors(def([run("a")], { name: "x".repeat(81) })).join(" ")).toMatch(/up to 80 characters/);
        expect(parseDefinition(def([run("a")], { name: "x".repeat(80) })).ok).toBe(true);
        expect(errors(def([run("a")], { name: "   " })).join(" ")).toMatch(/Give the runbook a name/);
        expect(errors({ ...def([run("a")]), version: 2 }).join(" ")).toMatch(/version must be 1/);
    });

    it("routes only forward: a step cannot send the run back, to itself, or to a step that does not exist", () => {
        expect(errors(def([run("a"), run("b", { onFail: "a" })])).join(" ")).toMatch(/comes before this step.*never loop/);
        expect(errors(def([run("a", { onPass: "a" })])).join(" ")).toMatch(/cannot send the run back to itself/);
        expect(errors(def([run("a", { onFail: "nope" }), run("b")])).join(" ")).toMatch(/no step with the id “nope”/);
        // A longer loop (a to c, c back to b) is just as impossible.
        expect(errors(def([run("a", { onPass: "c" }), run("b"), run("c", { onFail: "b" })])).join(" ")).toMatch(/comes before this step/);
        // Forward references are fine, including to the last step and to the routing words.
        expect(parseDefinition(def([run("a", { onPass: "c", onFail: "stop" }), run("b"), run("c", { onPass: "next" })])).ok).toBe(true);
    });

    it("rejects duplicate ids, routing words as ids, unknown settings and bad step shapes", () => {
        expect(errors(def([run("a"), run("a")])).join(" ")).toMatch(/Two steps use the id “a”/);
        expect(errors(def([run("next")])).join(" ")).toMatch(/routing word/);
        expect(errors(def([run("A B")])).join(" ")).toMatch(/lowercase letter/);
        expect(errors(def([run("a", { surprise: 1 })])).join(" ")).toMatch(/“surprise” is not a setting/);
        expect(errors(def([{ id: "a", type: "teleport" }])).join(" ")).toMatch(/step type must be one of/);
        expect(errors(def([run("a", { scope: {} })])).join(" ")).toMatch(/Choose a suite, a tag/);
        expect(errors(def([run("a", { retries: 3 })])).length).toBeGreaterThan(0);
    });

    it("wait is 1 to 300 seconds; a wait or notify step has no failure route", () => {
        expect(parseDefinition(def([{ id: "w", type: "wait", seconds: 300 }])).ok).toBe(true);
        expect(errors(def([{ id: "w", type: "wait", seconds: 301 }])).length).toBeGreaterThan(0);
        expect(errors(def([{ id: "w", type: "wait", seconds: 0 }])).length).toBeGreaterThan(0);
        expect(errors(def([{ id: "w", type: "wait", seconds: 5, onFail: "stop" }])).join(" ")).toMatch(/always moves on/);
        expect(errors(def([{ id: "n", type: "notify", channelId: "c", message: "hi", onFail: "stop" }])).join(" ")).toMatch(/always moves on/);
    });

    it("a check needs a run or analyze step before it, except the readiness check on its own project", () => {
        expect(errors(def([{ id: "c", type: "condition", condition: { check: "noFailures" } }])).join(" ")).toMatch(/needs a “run tests” or “analyze” step before it/);
        expect(parseDefinition(def([run("a"), { id: "c", type: "condition", condition: { check: "noFailures" } }])).ok).toBe(true);
        expect(parseDefinition(def([{ id: "a", type: "analyze" }, { id: "c", type: "condition", condition: { check: "noHighSeverity" } }])).ok).toBe(true);
        expect(errors(def([run("a"), { id: "c", type: "condition", condition: { check: "passRate", atLeast: 101 } }])).length).toBeGreaterThan(0);
        expect(errors(def([run("a"), { id: "c", type: "condition", condition: { check: "vibes" } }])).length).toBeGreaterThan(0);
    });

    it("message placeholders: only project, status, passRate, failed and runUrl; a stray brace is caught", () => {
        const notify = (message: string) => def([{ id: "n", type: "notify", channelId: "c", message }]);
        expect(parseDefinition(notify("{{ project }} is {{status}}")).ok).toBe(true);
        expect(errors(notify("Hello {{user}}")).join(" ")).toMatch(/“{{user}}” is not a placeholder you can use/);
        expect(errors(notify("Hello {{project}")).join(" ")).toMatch(/missing a brace/);
        expect(errors(notify("Hello }}")).join(" ")).toMatch(/missing a brace/);
        expect(errors(notify("{{}}")).join(" ")).toMatch(/not a placeholder/);
        expect(errors(notify("x".repeat(501))).length).toBeGreaterThan(0);
        expect(templateProblems("{{project}} {{runUrl}}")).toEqual([]);
        expect(PLACEHOLDERS).toEqual(["project", "status", "passRate", "failed", "runUrl"]);
    });

    it("renders a template with the values and leaves the text itself alone (escaping is the channel's job)", () => {
        const values = { project: "Shop <b>&", status: "failed", passRate: "92.5%", failed: "3", runUrl: "https://x.test/#/p?run=1" };
        expect(renderTemplate("{{project}}: {{status}}, {{ passRate }} passed, {{failed}} failing. {{runUrl}}", values)).toBe("Shop <b>&: failed, 92.5% passed, 3 failing. https://x.test/#/p?run=1");
        // A value that looks like a placeholder is not expanded again.
        expect(renderTemplate("{{project}}", { ...values, project: "{{status}}" })).toBe("{{status}}");
    });

    it("a production step needs confirmProduction (checked when saving, with the project's environments); missing environments and channels are named", () => {
        const d = ok(def([run("prod", { environment: "production" }), run("stage", { environment: "staging" }), { id: "n", type: "notify", channelId: "gone", message: "hi" }]));
        const lookups = { environment: (n: string) => (n === "production" ? { production: true } : n === "staging" ? { production: false } : undefined), channelExists: (id: string) => id === "here" };
        const problems = projectProblems(d, lookups);
        expect(problems.map((p) => p.path)).toEqual(["steps.0.confirmProduction", "steps.2.channelId"]);
        expect(problems[0]).toMatchObject({ requiresConfirmation: true });
        expect(problems[0]!.message).toMatch(/production environment/);
        // Confirmed: fine.
        expect(projectProblems(ok(def([run("prod", { environment: "production", confirmProduction: true })])), lookups)).toEqual([]);
        // An environment that does not exist.
        expect(projectProblems(ok(def([run("x", { environment: "qa" })])), lookups)[0]!.message).toMatch(/no environment called “qa”/);
        // Confirming without an environment is a mistake worth saying out loud.
        expect(errors(def([run("x", { confirmProduction: true })])).join(" ")).toMatch(/only applies to a step that names an environment/);
    });
});

describe("how a run moves", () => {
    const d = ok(def([run("smoke", { onFail: "tell" }), run("full", { onPass: "stop" }), { id: "tell", type: "notify", channelId: "c", message: "hi" }]));

    it("pass follows onPass (default next), fail follows onFail (default stop), stop ends, the last step's next ends", () => {
        expect(nextAfter(d, 0, true)).toEqual({ kind: "goto", index: 1 }); // default onPass: next
        expect(nextAfter(d, 0, false)).toEqual({ kind: "goto", index: 2 }); // onFail: tell
        expect(nextAfter(d, 1, true)).toEqual({ kind: "stop" }); // onPass: stop
        expect(nextAfter(d, 1, false)).toEqual({ kind: "stop" }); // default onFail: stop
        expect(nextAfter(d, 2, true)).toEqual({ kind: "end" }); // next after the last step
    });

    it("the final status: end after a failure is failed, stop after a failure is stopped, a clean early stop is passed", () => {
        expect(finalStatus("end", false)).toBe("passed");
        expect(finalStatus("end", true)).toBe("failed");
        expect(finalStatus("stop", true)).toBe("stopped");
        expect(finalStatus("stop", false)).toBe("passed");
    });

    it("every run terminates: following any routes from any step only ever moves forward", () => {
        const long = ok(def([run("a", { onPass: "d", onFail: "c" }), run("b", { onFail: "d" }), run("c", { onPass: "e" }), run("d", { onFail: "e" }), run("e")]));
        for (let start = 0; start < long.steps.length; start++) {
            for (const pass of [true, false]) {
                let at = start;
                let guard = 0;
                for (;;) {
                    const next = nextAfter(long, at, pass);
                    if (next.kind !== "goto") break;
                    expect(next.index).toBeGreaterThan(at);
                    at = next.index;
                    expect(++guard).toBeLessThan(20);
                }
            }
        }
    });
});

describe("checks", () => {
    const facts = (over: Partial<Facts> = {}): Facts => ({ hasRun: true, jobError: null, total: 50, passed: 48, failed: 2, highSeverity: 0, apiBreaking: 0, readiness: null, ...over });

    it("pass rate", () => {
        expect(passRateOf({ total: 50, passed: 48 })).toBe(96);
        expect(passRateOf({ total: 0, passed: 0 })).toBeNull();
        expect(evaluateCondition({ check: "passRate", atLeast: 95 }, facts())).toMatchObject({ passed: true, measured: "96% passed (48 of 50)" });
        expect(evaluateCondition({ check: "passRate", atLeast: 96 }, facts())).toMatchObject({ passed: true });
        const low = evaluateCondition({ check: "passRate", atLeast: 97 }, facts());
        expect(low).toMatchObject({ passed: false });
        expect(low.reason).toMatch(/96% passed, below the 97% needed/);
        expect(evaluateCondition({ check: "passRate", atLeast: 1 }, facts({ total: 0, passed: 0 }))).toMatchObject({ passed: false, measured: "no tests ran" });
    });

    it("no failures, no high severity, no API breaking change", () => {
        expect(evaluateCondition({ check: "noFailures" }, facts({ failed: 0 }))).toMatchObject({ passed: true });
        expect(evaluateCondition({ check: "noFailures" }, facts())).toMatchObject({ passed: false, measured: "2 failing tests" });
        expect(evaluateCondition({ check: "noFailures" }, facts({ failed: 1 })).measured).toBe("1 failing test");
        expect(evaluateCondition({ check: "noHighSeverity" }, facts({ highSeverity: 0 }))).toMatchObject({ passed: true });
        expect(evaluateCondition({ check: "noHighSeverity" }, facts({ highSeverity: 3 }))).toMatchObject({ passed: false, measured: "3 high-severity findings" });
        expect(evaluateCondition({ check: "noApiBreakingChange" }, facts({ apiBreaking: 0 }))).toMatchObject({ passed: true });
        expect(evaluateCondition({ check: "noApiBreakingChange" }, facts({ apiBreaking: 2 }))).toMatchObject({ passed: false, measured: "2 breaking API changes" });
        // Nothing to compare is not a breaking change, and the record says so.
        const none = evaluateCondition({ check: "noApiBreakingChange" }, facts({ apiBreaking: null }));
        expect(none.passed).toBe(true);
        expect(none.measured).toBe("nothing to compare yet");
    });

    it("readiness is about the project and needs no earlier run; the others fail without one or when the run did not finish", () => {
        const readyFacts = facts({ hasRun: false, readiness: { state: "ready", label: "Ready", reasons: [] } });
        expect(evaluateCondition({ check: "readiness" }, readyFacts)).toMatchObject({ passed: true, measured: "Ready" });
        const blocked = evaluateCondition({ check: "readiness" }, facts({ hasRun: false, readiness: { state: "blocked", label: "Blocked", reasons: ["1 critical finding", "The last run failed"] } }));
        expect(blocked.passed).toBe(false);
        expect(blocked.reason).toMatch(/Blocked.*1 critical finding; The last run failed/);
        expect(evaluateCondition({ check: "readiness" }, facts({ readiness: null })).passed).toBe(false);
        expect(evaluateCondition({ check: "noFailures" }, facts({ hasRun: false })).reason).toMatch(/no earlier run/);
        expect(evaluateCondition({ check: "passRate", atLeast: 1 }, facts({ jobError: "The application was unreachable" })).reason).toMatch(/did not finish: The application was unreachable/);
    });

    it("steps get a plain default title unless the author gave one", () => {
        const d = ok(def([run("a"), run("b", { scope: { suite: "Checkout" }, environment: "staging" }), run("c", { scope: { testIds: ["x", "y"] } }), { id: "w", type: "wait", seconds: 1 }, { id: "c2", type: "condition", condition: { check: "passRate", atLeast: 90 } }, { id: "n", type: "notify", channelId: "c", message: "m", title: "Ping the team" }]));
        expect(d.steps.map(stepTitle)).toEqual(["Run all tests", "Run the “Checkout” suite on staging", "Run 2 chosen tests", "Wait 1 second", "Check that at least 90% passed", "Ping the team"]);
    });
});

describe("presets", () => {
    it("every preset is a valid runbook, with and without a channel, and keeps to the rules", () => {
        for (const p of PRESETS) {
            for (const channel of [undefined, "chan-1"]) {
                const d = presetDefinition(p.id, channel);
                expect(d.steps.length).toBeGreaterThan(0);
                expect(d.steps.some((s) => s.type === "notify")).toBe(channel !== undefined);
                // A preset never turns on anything risky.
                for (const s of d.steps) {
                    if (s.type === "analyze") expect(s.allowMutatingApiTests).toBeUndefined();
                    if (s.type === "run") expect(s.environment).toBeUndefined();
                }
            }
        }
        const gate = presetDefinition("release-gate", "c");
        expect(gate.steps.map((s) => s.type)).toEqual(["run", "condition", "condition", "condition", "condition", "notify"]);
        const smoke = presetDefinition("smoke-then-full", "c");
        // Failing smoke tests go straight to the message, never to the full run.
        expect(nextAfter(smoke, 0, false)).toEqual({ kind: "goto", index: 2 });
        expect(nextAfter(smoke, 0, true)).toEqual({ kind: "goto", index: 1 });
        expect(nextAfter(smoke, 1, true)).toEqual({ kind: "stop" });
        const nightly = presetDefinition("nightly-with-alert", "c");
        expect(nextAfter(nightly, 0, true)).toEqual({ kind: "stop" });
        expect(nextAfter(nightly, 0, false)).toEqual({ kind: "goto", index: 1 });
    });
});

describe("runbook store", () => {
    function setup() {
        const db = new Db(":memory:");
        let now = 1_000_000;
        const store = new RunbookStore(db, () => now);
        db.run("INSERT INTO users (id, email, created_at) VALUES ('u', 'u@x.test', 'now')");
        for (const id of ["p1", "p2"]) db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, 'u', ?, 'now', 'now')", id, `Project ${id}`);
        return { db, store, tick: (ms: number) => (now += ms) };
    }
    const definition = ok(def([run("a"), { id: "w", type: "wait", seconds: 1 }]));

    it("keeps runbooks per project and the run snapshot of the definition", () => {
        const { store } = setup();
        const rb = store.create("p1", definition);
        expect(store.list("p1").map((r) => r.id)).toEqual([rb.id]);
        expect(store.list("p2")).toEqual([]);
        const r = store.createRun({ runbook: rb, trigger: "manual", owner: "me", titles: ["Run all tests", "Wait 1 second"] });
        store.update(rb.id, ok(def([run("changed")], { name: "Renamed" })));
        // Editing the runbook does not change the run in progress.
        expect(store.getRun(r.id)!.definition.steps.map((s) => s.id)).toEqual(["a", "w"]);
        expect(store.runSteps(r.id).map((s) => [s.stepId, s.status, s.title])).toEqual([["a", "pending", "Run all tests"], ["w", "pending", "Wait 1 second"]]);
    });

    it("allows one active run per project (the database enforces it) and frees the project when the run ends", () => {
        const { store } = setup();
        const a = store.create("p1", definition);
        const b = store.create("p1", ok(def([run("x")], { name: "Other" })));
        const c = store.create("p2", definition);
        const first = store.createRun({ runbook: a, trigger: "manual", owner: "me", titles: ["a", "w"] });
        expect(() => store.createRun({ runbook: b, trigger: "manual", owner: "me", titles: ["x"] })).toThrow(RunbookBusy);
        // The failed attempt left nothing behind.
        expect(store.listRuns(b.id)).toEqual([]);
        // Another project is unaffected.
        expect(store.createRun({ runbook: c, trigger: "manual", owner: "me", titles: ["a", "w"] }).status).toBe("running");
        expect(store.finishRun(first.id, "passed", "All steps finished.")).toBe(true);
        // Ending twice does not overwrite the first ending.
        expect(store.finishRun(first.id, "failed", "later")).toBe(false);
        expect(store.getRun(first.id)).toMatchObject({ status: "passed", reason: "All steps finished." });
        expect(store.createRun({ runbook: b, trigger: "manual", owner: "me", titles: ["x"] }).status).toBe("running");
    });

    it("interrupts a run whose driver stopped beating, not one that is alive, and never one of the caller's own", () => {
        const { store, tick } = setup();
        const rb = store.create("p1", definition);
        const run1 = store.createRun({ runbook: rb, trigger: "schedule", triggerRef: "s1", owner: "dead-process", titles: ["a", "w"] });
        store.startStep(run1.id, 0);
        tick(10_000);
        // Still fresh: left alone.
        expect(store.interruptStale("other", 20_000)).toEqual([]);
        tick(15_000);
        // The caller's own run is never touched.
        expect(store.interruptStale("dead-process", 20_000)).toEqual([]);
        const ended = store.interruptStale("new-process", 20_000);
        expect(ended.map((r) => r.id)).toEqual([run1.id]);
        expect(store.getRun(run1.id)).toMatchObject({ status: "interrupted" });
        expect(store.getRun(run1.id)!.reason).toMatch(/restarted.*not resumed/);
        expect(store.runSteps(run1.id).map((s) => s.status)).toEqual(["stopped", "skipped"]);
        expect(store.activeRun("p1")).toBeUndefined();
    });

    it("heartbeats keep a run alive; cancel only applies to a running run", () => {
        const { store, tick } = setup();
        const rb = store.create("p1", definition);
        const r = store.createRun({ runbook: rb, trigger: "manual", owner: "me", titles: ["a", "w"] });
        tick(30_000);
        store.heartbeat(r.id);
        expect(store.interruptStale("other", 20_000)).toEqual([]);
        expect(store.requestCancel(r.id)).toBe(true);
        expect(store.isCancelRequested(r.id)).toBe(true);
        store.finishRun(r.id, "cancelled", "Cancelled");
        expect(store.requestCancel(r.id)).toBe(false);
    });

    it("links schedules and deploy tokens to runbooks and says what uses a runbook", () => {
        const { db, store } = setup();
        const rb = store.create("p1", definition);
        db.run("INSERT INTO schedules (id, project_id, name, kind, cadence_json, created_at, updated_at) VALUES ('s1', 'p1', 'Nightly', 'validate', '{}', 'now', 'now')");
        db.run("INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, created_at) VALUES ('t1', 'p1', 'CI', 'h', 'abcd', 'now')");
        store.setScheduleLink("s1", rb.id);
        store.setTokenLink("t1", rb.id);
        expect(store.scheduleLink("s1")).toBe(rb.id);
        expect(store.usedBy(rb.id)).toEqual({ schedules: [{ id: "s1", name: "Nightly" }], tokens: [{ id: "t1", label: "CI", hint: "abcd" }] });
        // A revoked token no longer counts as using the runbook.
        db.run("UPDATE trigger_tokens SET revoked_at = 'now' WHERE id = 't1'");
        expect(store.usedBy(rb.id).tokens).toEqual([]);
        store.setScheduleLink("s1", null);
        expect(store.scheduleLink("s1")).toBeNull();
        // Deleting the schedule removes its link.
        store.setScheduleLink("s1", rb.id);
        db.run("DELETE FROM schedules WHERE id = 's1'");
        expect(db.get("SELECT 1 FROM runbook_schedule_links WHERE schedule_id = 's1'")).toBeUndefined();
    });
});
