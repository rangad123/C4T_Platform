/**
 * Reproduction without a browser (Phase 5 V1): the verdict that moves a finding out of Verification pending, the attempts setting, the
 * budget (30 findings per run, 10 minutes each), the reset request's address rule, and verifyFindings on a real store with a scripted
 * executor: what it asks the runner for (attempts, a new account, no video), what it records, and that it makes no AI call.
 * Expected values come from the plan's acceptance lines and spec Q4–Q6.
 */
import { describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ calls: 0 }));
vi.mock("ai", async (orig) => {
    const real = await orig<Record<string, unknown>>();
    const counted = (name: string) => (...args: unknown[]) => {
        ai.calls++;
        return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
    return { ...real, generateText: counted("generateText"), generateObject: counted("generateObject"), streamText: counted("streamText"), streamObject: counted("streamObject") };
});

const { attemptsSetting, resetHookProblem, verdictOf, withinBudget, VERIFY_ATTEMPTS, VERIFY_BUDGET } = await import("../src/engine/findings/reproduce.js");
const { CandidateFindingStore } = await import("../src/platform/candidate-finding-store.js");
const { Db } = await import("../src/platform/db.js");
const { executionFinding, fromCandidate } = await import("../src/platform/findings/adapters.js");
const { harvestExecutionFindings, verifyFindings } = await import("../src/platform/findings/verify-service.js");
const { attemptNote, parseAttemptNote } = await import("../src/engine/validation/runner.js");
const { TestSpecSchema } = await import("../src/engine/spec/schema.js");
type ScriptRun = import("../src/engine/validation/runner.js").ScriptRun;
type ExecutionOptions = import("../src/engine/frameworks/types.js").ExecutionOptions;

const { AttemptSchema } = await import("../src/engine/findings/view.js");
const failedAt = (step: number, value = "$21.00", extra: Record<string, string> = {}) => AttemptSchema.parse({ outcome: "failed", failedStep: step, check: "exactText", target: "subtotal", value, ...extra });
const passed = AttemptSchema.parse({ outcome: "passed" });
const sourced = { expected: { text: "Subtotal is the sum of the lines", source: "R-2", stated: "explicit" as const } };
const clean = { clean: true, note: "on a newly registered account each time" };
const shared = { clean: false, note: "on the shared test account (the project does not allow tests that change data, so no account is registered for the replay), so not checked on clean state" };

describe("the verdict of the verification attempts", () => {
    it("a real failure that comes back 3 of 3 on clean state is Reproduced", () => {
        const v = verdictOf(sourced, [failedAt(5), failedAt(5), failedAt(5)], clean);
        expect(v.to).toBe("reproduced");
        expect(v.reason).toMatch(/3 of 3 attempts/);
        expect(v.classification.class).toBe("app_defect");
    });

    it("a state-bound test (fails on the shared account's leftovers, passes on new accounts) is Unconfirmed with the reason", () => {
        const v = verdictOf(sourced, [passed, passed, passed], clean);
        expect(v.to).toBe("unconfirmed");
        expect(v.reason).toMatch(/state-bound/);
        expect(v.reason).toMatch(/3 of 3 attempts/);
    });

    it("the same failure only on the shared account stays Unconfirmed until clean state reproduces it", () => {
        const v = verdictOf(sourced, [failedAt(5), failedAt(5), failedAt(5)], shared);
        expect(v.to).toBe("unconfirmed");
        expect(v.reason).toMatch(/only on the shared test account/);
    });

    it("mixed attempts are Flaky; the test's own step is an automation issue; a passing run on the shared account is not state-bound", () => {
        expect(verdictOf(sourced, [failedAt(5), passed, passed], clean).to).toBe("flaky");
        expect(verdictOf(sourced, [failedAt(2, "$21.00", { stepFault: "Step 2 clicks a button the page never shows." }), failedAt(2, "$21.00", { stepFault: "Step 2 clicks a button the page never shows." })], clean).to).toBe("automation_issue");
        const v = verdictOf(sourced, [passed, passed], shared);
        expect(v.to).toBe("unconfirmed");
        expect(v.reason).not.toMatch(/state-bound/);
        expect(verdictOf(sourced, [], clean).to).toBe("unconfirmed");
    });
});

describe("the attempts setting and the budget", () => {
    it("attempts are 1 to 5, default 3 (Q4)", () => {
        expect(VERIFY_ATTEMPTS).toEqual({ min: 1, max: 5, default: 3 });
        expect([attemptsSetting(undefined), attemptsSetting(0), attemptsSetting(6), attemptsSetting(2.5), attemptsSetting("2"), attemptsSetting(1), attemptsSetting(5)]).toEqual([3, 3, 3, 3, 3, 1, 5]);
    });

    it("at most 30 findings per run and 10 minutes each (Q4); past the cap the rest wait, with the stop reason", async () => {
        expect(VERIFY_BUDGET).toEqual({ findingsPerRun: 30, minutesEach: 10 });
        const seen: number[] = [];
        const r = await withinBudget(Array.from({ length: 33 }, (_, i) => i), async (i) => (seen.push(i), i));
        expect(seen).toHaveLength(30);
        expect(r.left).toEqual([30, 31, 32]);
        expect(r.stopped).toMatch(/budget of 30 findings per run was used: 3 more wait for the next run/);
    });

    it("an item past its time is stopped with the reason, and the next one still runs", async () => {
        const hang = (_: number, signal: AbortSignal) => new Promise<number>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
        const r = await withinBudget([1, 2], (i, signal) => (i === 1 ? hang(i, signal) : Promise.resolve(i)), { findingsPerRun: 30, minutesEach: 0.001 });
        expect(r.timedOut).toEqual([{ item: 1, why: expect.stringMatching(/longer than the 0.001 minutes/) }]);
        expect(r.done).toEqual([{ item: 2, result: 2 }]);
        expect(r.stopped).toBeUndefined();
    });
});

describe("the reset request before verification (Q5)", () => {
    const app = "https://shop.example.test/app";
    it("goes only to the application's own origin, as a POST, with no sign-in in the address", () => {
        expect(resetHookProblem({ method: "POST", url: "/__bench/reset" }, app)).toBeUndefined();
        expect(resetHookProblem({ method: "post", url: "https://shop.example.test/reset" }, app)).toBeUndefined();
        expect(resetHookProblem({ method: "POST", url: "https://other.example.test/reset" }, app)).toMatch(/only to the application's own site \(https:\/\/shop\.example\.test\), not to https:\/\/other\.example\.test/);
        expect(resetHookProblem({ method: "POST", url: "https://shop.example.test:8443/reset" }, app)).toMatch(/own site/);
        expect(resetHookProblem({ method: "POST", url: "http://shop.example.test/reset" }, app)).toMatch(/own site/);
        expect(resetHookProblem({ method: "DELETE", url: "/reset" }, app)).toMatch(/POST only/);
        expect(resetHookProblem({ method: "POST", url: "https://admin:pw@shop.example.test/reset" }, app)).toMatch(/sign-in details/);
    });

    it("an administrator's allow-list for run resets does not widen it", () => {
        const saved = process.env.RESET_ALLOWED_ORIGINS;
        process.env.RESET_ALLOWED_ORIGINS = "https://other.example.test";
        try {
            expect(resetHookProblem({ method: "POST", url: "https://other.example.test/reset" }, app)).toMatch(/own site/);
        } finally {
            if (saved === undefined) delete process.env.RESET_ALLOWED_ORIGINS;
            else process.env.RESET_ALLOWED_ORIGINS = saved;
        }
    });
});

describe("attempt notes", () => {
    it("say which attempt and on what account, and read back", () => {
        expect(attemptNote(2, 3, { clean: true, note: "as a newly registered account" })).toBe("Attempt 2 of 3 (clean state): as a newly registered account");
        expect(parseAttemptNote(attemptNote(2, 3, { clean: false, note: "on the shared test account (x)" }))).toEqual({ attempt: 2, of: 3, clean: false, note: "on the shared test account (x)" });
        expect(parseAttemptNote(attemptNote(1, 1))).toEqual({ attempt: 1, of: 1, note: "in a fresh browser" });
        expect(parseAttemptNote("A low-confidence judgement")).toBeUndefined();
    });
});

// ── verifyFindings on a real store, with a scripted executor ────────────────

const at = "2026-11-22T10:00:00.000Z";
const spec = TestSpecSchema.parse({
    testId: "WEB-007",
    title: "Subtotal of two lines",
    kind: "web",
    category: "Cart",
    source: { origin: "browser-agent" },
    expectedResults: ["The subtotal is the sum of the lines"],
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
        { action: "assert", check: "exactText", locator: { by: "testId", value: "subtotal" }, expected: "$21.00", source: "R-2" },
    ],
});
const failingRun = (note?: string): ScriptRun => ({ testId: "WEB-007", status: "failed", durationMs: 5, error: "expect(locator).toHaveText: $16.75", failedStepIndex: 4, steps: [{ index: 4, title: "5. assert subtotal", status: "failed", error: 'Expected "$21.00", received "$16.75"' }], artifacts: [], responses: [], ...(note ? { notes: [note] } : {}) });

async function setup() {
    const db = new Db(":memory:");
    db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
    for (const p of ["p1", "p2"]) db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", p, "u-1", p, at, at);
    db.run("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES (?,?,?,?,?)", "s-1", "p1", "S", "s", at);
    db.run("INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", "t-1", "p1", "s-1", "WEB-007", spec.title, "web", spec.type, spec.priority, "FAILED_VALIDATION", "playwright", JSON.stringify(spec), at, at);
    const store = new CandidateFindingStore(db.sql);
    const test = { id: "t-1", title: spec.title, spec, meta: null, testKey: "WEB-007", framework: "playwright" };
    return { db, store, test };
}

describe("verifyFindings", () => {
    it("writes a failed run of an ordinary test as an execution finding, and a layer check as a layer finding; a test-step fault is not one", async () => {
        const { store, test } = await setup();
        const [f] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: failingRun() }] });
        expect(f).toMatchObject({ state: "candidate", testId: "t-1", capture: "captured" });
        expect(fromCandidate(f!, test).source.kind).toBe("execution");
        expect(fromCandidate(f!, { ...test, meta: { layer: "api" } })).toMatchObject({ source: { kind: "layer" }, layer: "api" });
        // The same failure again is the same finding, seen twice.
        const [again] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: failingRun() }] });
        expect(again).toMatchObject({ id: f!.id, seenCount: 2 });
        // An exploration finding of the same check stays an exploration finding.
        const exploration = { ...executionFinding(test, failingRun()), fingerprint: "e".repeat(64) };
        const { finding: x } = await store.upsert({ projectId: "p1", testId: "t-1", finding: exploration });
        expect(fromCandidate(x, test).source.kind).toBe("exploration");
        const fault: ScriptRun = { ...failingRun(), error: "locator.click: Timeout 10000ms exceeded.", failedStepIndex: 3, steps: [{ index: 3, title: "4. click Sign in", status: "failed", error: "locator.click: Timeout 10000ms exceeded.\nwaiting for getByRole('button', { name: 'Sign in' })" }] };
        const stepFault = TestSpecSchema.parse({ ...spec, testId: "WEB-008" });
        expect(await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test: { ...test, spec: stepFault, testKey: "WEB-008" }, run: fault }] })).toEqual([]);
    });

    it("asks for 3 attempts on new accounts with no video, moves the finding to Reproduced with its attempts, and makes no AI call", async () => {
        const { store, test } = await setup();
        const [f] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: failingRun() }] });
        const asked: ExecutionOptions[] = [];
        const events: string[] = [];
        const before = ai.calls;
        const r = await verifyFindings({
            store, projectId: "p1", findings: [f!], testOf: () => test, appUrl: "http://127.0.0.1:1", env: { baseUrl: "http://127.0.0.1:1", headless: true, credentials: { username: "alice@example.test", password: "Password1!" } },
            render: { baseUrl: "http://127.0.0.1:1" }, scratchDir: "/nonexistent", ranOn: "the platform", dataChanges: true, signupPath: "/register", loginPath: "/login",
            execute: async (_a, _b, _e, opts) => (asked.push(opts), [1, 2, 3].map((i) => failingRun(attemptNote(i, 3, { clean: true, note: "as a newly registered account" })))),
            emit: (m) => events.push(m),
        });
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ attempts: 3, video: false, freshAccount: { signupPath: "/register", loginPath: "/login" }, workers: 1 });
        expect(r.verified).toEqual([{ id: f!.id, to: "reproduced", reason: expect.stringMatching(/3 of 3 attempts/) }]);
        const stored = (await store.get("p1", f!.id))!;
        expect(stored).toMatchObject({ state: "reproduced", findingClass: "app_defect" });
        expect(stored.attempts).toHaveLength(3);
        expect(stored.confidenceDetail?.factors.reproduction.value).toBe("high");
        expect((await store.history("p1", f!.id)).map((e) => e.to)).toEqual(["verification_pending", "reproduced"]);
        expect(events.join("\n")).toMatch(/WEB-007: reproduced/);
        expect(ai.calls - before).toBe(0);
    });

    it("without data changes it runs on the shared account and stays Unconfirmed; the budget leaves the rest as candidates with the reason", async () => {
        const { store, test } = await setup();
        const [a] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: failingRun() }] });
        const other = TestSpecSchema.parse({ ...spec, testId: "WEB-009" });
        const { finding: b } = await store.upsert({ projectId: "p1", testId: "t-1", finding: { ...executionFinding({ ...test, spec: other }, failingRun()), fingerprint: "b".repeat(64) } });
        const asked: ExecutionOptions[] = [];
        const events: string[] = [];
        const r = await verifyFindings({
            store, projectId: "p1", findings: [a!, b], testOf: () => test, appUrl: "http://127.0.0.1:1", env: { baseUrl: "http://127.0.0.1:1", headless: true },
            render: { baseUrl: "http://127.0.0.1:1" }, scratchDir: "/nonexistent", ranOn: "the platform", dataChanges: false, signupPath: "/register", budget: { findingsPerRun: 1, minutesEach: 10 },
            execute: async (_a, _b, _e, opts) => (asked.push(opts), [1, 2, 3].map((i) => failingRun(attemptNote(i, 3)))),
            emit: (m) => events.push(m),
        });
        expect(asked[0]!.freshAccount).toBeUndefined();
        expect(r.verified).toEqual([{ id: a!.id, to: "unconfirmed", reason: expect.stringMatching(/only on the shared test account/) }]);
        expect(r.stopped).toMatch(/budget of 1 finding per run was used: 1 more waits/);
        expect(events.join("\n")).toMatch(/budget of 1 finding/);
        expect((await store.get("p1", b.id))!.state).toBe("candidate");
    });

    it("an attempt that cannot run (an older runner's sentence) leaves the finding Unconfirmed with that sentence", async () => {
        const { store, test } = await setup();
        const [f] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: failingRun() }] });
        const r = await verifyFindings({
            store, projectId: "p1", findings: [f!], testOf: () => test, appUrl: "http://127.0.0.1:1", env: { baseUrl: "http://127.0.0.1:1", headless: true },
            render: { baseUrl: "http://127.0.0.1:1" }, scratchDir: "/nonexistent", ranOn: "a runner", dataChanges: false,
            execute: async () => {
                throw new Error("Your runner “Laptop” is too old to verify findings: it would run the test once, with a recording.");
            },
            emit: () => undefined,
        });
        expect(r.verified[0]).toMatchObject({ to: "unconfirmed", reason: expect.stringMatching(/could not be verified: Your runner “Laptop” is too old/) });
        expect((await store.get("p1", f!.id))!.state).toBe("unconfirmed");
    });

    it("a reset request to another origin is not sent, and the attempts still run", async () => {
        const { store, test } = await setup();
        const [f] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: failingRun() }] });
        const send = vi.fn(async () => ({ ok: true, message: "sent" }));
        const events: string[] = [];
        await verifyFindings({
            store, projectId: "p1", findings: [f!], testOf: () => test, appUrl: "http://127.0.0.1:1", env: { baseUrl: "http://127.0.0.1:1", headless: true },
            render: { baseUrl: "http://127.0.0.1:1" }, scratchDir: "/nonexistent", ranOn: "the platform", dataChanges: false,
            reset: { hook: { method: "POST", url: "https://reset.example.test/wipe" }, send },
            execute: async () => [1, 2, 3].map((i) => failingRun(attemptNote(i, 3))),
            emit: (m) => events.push(m),
        });
        expect(send).not.toHaveBeenCalled();
        expect(events.join("\n")).toMatch(/does not reset the application: .*own site/);
    });
});
