/**
 * Flaky-test quarantine, browser-free: the pure rules as tables (families, eligibility, expiry with an injected clock, release
 * suggestion, the gating set) and the store on a real database (append-only history, one active entry per test, expiry on read,
 * the gate dropping a quarantine whose test turned out to be a real defect).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
    assessEligibility,
    autoReason,
    CONSISTENT_RUNS,
    clampDays,
    DEFAULT_DAYS,
    evidenceText,
    expiryFrom,
    gateEntries,
    ignoredNote,
    isConsistentFailure,
    isExpired,
    latestExpiry,
    makeGate,
    MAX_DAYS,
    notCountedText,
    protectedFamily,
    STABLE_RUNS,
    suggestRelease,
    type FlakyEvidence,
    type GateEntry,
} from "../src/engine/quarantine/rules.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { QuarantineStore, quarantineGate } from "../src/platform/quarantine-store.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

const spec = (over: Record<string, unknown> = {}) =>
    TestSpecSchema.parse({ testId: "API-001", title: "Orders list answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }], ...over });
const flaky = (over: Partial<FlakyEvidence> = {}): FlakyEvidence => ({ executions: 10, passes: 7, fails: 3, flips: 4, flakyPasses: 2, ...over });
const passes = (n: number) => Array<string>(n).fill("passed");
const fails = (n: number) => Array<string>(n).fill("failed");

describe("which family a test belongs to", () => {
    const table: Array<[string, Parameters<typeof protectedFamily>[0], string | undefined]> = [
        ["an ordinary functional test", { spec: spec() }, undefined],
        ["a visual baseline test (a screenshot comparison is not a check family)", { spec: spec({ source: { origin: "visual-baseline" } }) }, undefined],
        ["an accessibility audit", { spec: spec({ source: { origin: "a11y-audit" } }) }, "accessibility"],
        ["a page-health check", { spec: spec({ source: { origin: "health-check" } }) }, "page health"],
        ["a passive security check", { spec: spec({ source: { origin: "security-check" } }) }, "security"],
        ["an API contract check", { spec: spec({ source: { origin: "contract-check" } }) }, "API contract"],
        ["an access-control check", { spec: spec({ source: { origin: "access-check" } }) }, "access control"],
        ["an input-handling check", { spec: spec({ source: { origin: "input-check" } }) }, "input handling"],
        ["a page-speed check", { spec: spec({ source: { origin: "performance-check" } }) }, "page speed"],
        ["an AI judgement check", { spec: spec({ source: { origin: "vision-check" } }) }, "AI judgement"],
        ["a test of type security", { spec: spec({ type: "security" }) }, "security"],
        ["a test of type accessibility", { spec: spec({ type: "accessibility" }) }, "accessibility"],
        ["an ordinary test that carries an accessibility step", { spec: spec({ kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "a11y" }] }) }, "accessibility"],
        ["a compliance-tagged test", { spec: spec({ tags: ["Compliance"] }) }, "compliance"],
        ["an ordinary test whose last failure is a security finding", { spec: spec(), reason: "Security check failed: - [high] missing header" }, "security"],
        ["an ordinary test whose last failure is a contract finding", { spec: spec(), reason: "API contract check failed: field missing" }, "API contract"],
        ["an ordinary test whose last failure says possible security issue", { spec: spec(), reason: "Possible security issue: no credentials needed" }, "security"],
        ["an ordinary test whose last failure is an accessibility audit", { spec: spec(), reason: "Accessibility audit failed: 2 violations" }, "accessibility"],
        ["an ordinary test with an ordinary failure", { spec: spec(), reason: "Step failed: element not found" }, undefined],
    ];
    it.each(table)("%s", (_name, input, family) => expect(protectedFamily(input)).toBe(family));
});

describe("consistent failure", () => {
    it("needs at least N runs, all failing", () => {
        expect(isConsistentFailure(fails(CONSISTENT_RUNS))).toBe(true);
        expect(isConsistentFailure(fails(CONSISTENT_RUNS - 1))).toBe(false); // too few runs to say
        expect(isConsistentFailure([...passes(1), ...fails(CONSISTENT_RUNS)])).toBe(true); // only the latest N matter
        expect(isConsistentFailure([...fails(CONSISTENT_RUNS - 1), "passed"])).toBe(false);
        expect(isConsistentFailure([])).toBe(false);
        expect(isConsistentFailure(["failed", "failed", "failed", "failed", "error"])).toBe(true);
    });
});

describe("eligibility", () => {
    const base = { spec: spec(), reason: null as string | null };
    const table: Array<[string, Parameters<typeof assessEligibility>[0], boolean, string]> = [
        ["a flaky ordinary test", { ...base, evidence: flaky(), recent: [...passes(3), "failed", "passed"] }, true, "eligible"],
        ["a flaky test that failed 4 of its last 5 runs (one short of consistent)", { ...base, evidence: flaky(), recent: ["passed", ...fails(4)] }, true, "eligible"],
        ["a flaky test that failed its last 5 runs", { ...base, evidence: flaky(), recent: ["passed", ...fails(CONSISTENT_RUNS)] }, false, "consistent-failure"],
        ["a test that shows no flakiness", { ...base, evidence: null, recent: passes(6) }, false, "not-flaky"],
        ["a test that failed once and stayed failed (a regression)", { ...base, evidence: null, recent: [...passes(4), "failed"] }, false, "not-flaky"],
        ["a flaky accessibility audit", { spec: spec({ source: { origin: "a11y-audit" } }), reason: null, evidence: flaky(), recent: [...passes(3), "failed", "passed"] }, false, "protected-family"],
        ["a flaky security check that also fails every run (the family is named first)", { spec: spec({ source: { origin: "security-check" } }), reason: null, evidence: flaky(), recent: fails(8) }, false, "protected-family"],
        ["a flaky test whose failure is a health finding", { spec: spec(), reason: "Page health check failed: broken link", evidence: flaky(), recent: ["passed", "failed"] }, false, "protected-family"],
    ];
    it.each(table)("%s", (_name, input, eligible, code) => {
        const r = assessEligibility(input);
        expect(r.eligible).toBe(eligible);
        expect(r.code).toBe(code);
        expect(r.why.length).toBeGreaterThan(10);
    });

    it("explains in plain words and offers no override", () => {
        expect(assessEligibility({ ...base, evidence: flaky(), recent: fails(5) }).why).toBe("It failed on each of its last 5 runs. That is a real problem, not flakiness, so it cannot be put in quarantine.");
        expect(assessEligibility({ spec: spec({ type: "security" }), reason: null, evidence: flaky(), recent: [] }).why).toMatch(/security check.*cannot be put in quarantine/);
        expect(assessEligibility({ ...base, evidence: flaky(), recent: ["passed", "failed"] }).why).toBe("It is flaky: failed 3 of the last 10 runs, passed on re-run twice.");
    });

    it("words the evidence and the automatic reason", () => {
        expect(evidenceText(flaky())).toBe("failed 3 of the last 10 runs, passed on re-run twice");
        expect(evidenceText(flaky({ flakyPasses: 1, fails: 1, executions: 1 }))).toBe("failed 1 of the last 1 run, passed on re-run once");
        expect(evidenceText(flaky({ flakyPasses: 0 }))).toBe("failed 3 of the last 10 runs");
        expect(autoReason(flaky())).toBe("Passed and failed on identical runs 4 times");
        expect(autoReason(flaky({ flips: 0, flakyPasses: 3 }))).toBe("Passed and failed on identical runs 3 times");
    });
});

describe("time", () => {
    it("clamps days to 1..60 and defaults to 14", () => {
        expect(clampDays(undefined)).toBe(DEFAULT_DAYS);
        expect(DEFAULT_DAYS).toBe(14);
        expect(clampDays(0)).toBe(1);
        expect(clampDays(-5)).toBe(1);
        expect(clampDays(61)).toBe(MAX_DAYS);
        expect(clampDays(999)).toBe(60);
        expect(clampDays(30)).toBe(30);
        expect(clampDays(2.4)).toBe(2);
    });

    it("expires exactly at the end instant, judged by the clock it is given", () => {
        const expiresAt = expiryFrom(T0, 14);
        expect(expiresAt).toBe(new Date(T0 + 14 * DAY).toISOString());
        const entry = { status: "active" as const, expiresAt };
        expect(isExpired(entry, T0)).toBe(false);
        expect(isExpired(entry, T0 + 14 * DAY - 1)).toBe(false);
        expect(isExpired(entry, T0 + 14 * DAY)).toBe(true);
        expect(isExpired(entry, T0 + 30 * DAY)).toBe(true);
        expect(isExpired({ status: "released", expiresAt }, T0 + 30 * DAY)).toBe(false); // already ended some other way
        expect(latestExpiry(new Date(T0).toISOString())).toBe(new Date(T0 + 60 * DAY).toISOString());
    });
});

describe("suggesting a release", () => {
    it("suggests only after K passes in a row, counted from the newest run", () => {
        expect(STABLE_RUNS).toBe(10);
        expect(suggestRelease(passes(9))).toMatchObject({ suggest: false, passedInARow: 9, text: null });
        expect(suggestRelease(passes(10))).toMatchObject({ suggest: true, passedInARow: 10, text: "Passed its last 10 runs. Stable again: release it from quarantine?" });
        expect(suggestRelease([...fails(1), ...passes(10)]).suggest).toBe(true);
        expect(suggestRelease([...passes(10), "failed", ...passes(3)])).toMatchObject({ suggest: false, passedInARow: 3 });
        expect(suggestRelease([])).toMatchObject({ suggest: false, passedInARow: 0 });
        expect(suggestRelease(passes(3), 3).suggest).toBe(true); // K is configurable
    });
});

describe("the gating set", () => {
    const entry = (testId: string, projectId = "p1"): GateEntry => ({ id: `q-${testId}`, projectId, testId, testKey: `K-${testId}`, title: `T ${testId}`, testStatus: "FAILED_VALIDATION", reason: "flaky", since: new Date(T0).toISOString(), expiresAt: new Date(T0 + DAY).toISOString() });

    it("answers has / get / per project, and an empty set gates nothing", () => {
        const g = makeGate([entry("a"), entry("b", "p2")]);
        expect(g.size).toBe(2);
        expect(g.has("a")).toBe(true);
        expect(g.has("zzz")).toBe(false);
        expect(g.get("b")?.reason).toBe("flaky");
        expect(g.forProject("p1").map((e) => e.testId)).toEqual(["a"]);
        expect(g.forProject("nope")).toEqual([]);
        expect(makeGate([]).size).toBe(0);
    });

    it("drops an entry whose test is now a check-family test or now fails every run", () => {
        const ordinary = { spec: spec(), reason: null };
        const kept = gateEntries(
            [
                { entry: entry("ok"), test: ordinary },
                { entry: entry("secure"), test: { spec: spec({ source: { origin: "security-check" } }), reason: null } },
                { entry: entry("broken"), test: ordinary },
                { entry: entry("finding"), test: { spec: spec(), reason: "Accessibility audit failed: 1 violation" } },
            ],
            new Map([
                ["ok", ["passed", "failed", "passed"]],
                ["broken", fails(CONSISTENT_RUNS)],
            ]),
        );
        expect(kept.map((e) => e.testId)).toEqual(["ok"]);
    });

    it("words the notes the way every screen and message uses them", () => {
        expect(ignoredNote(1)).toBe("(1 quarantined test ignored)");
        expect(ignoredNote(2)).toBe("(2 quarantined tests ignored)");
        expect(notCountedText(1)).toBe("1 quarantined test is not counted");
        expect(notCountedText(3)).toBe("3 quarantined tests are not counted");
    });
});

// ── the store, on a real database ───────────────────────────────────────────

describe("the store", () => {
    let dataDir: string;
    let platform: Platform;
    let seed: Seed;
    let clock = Date.now();
    let store: QuarantineStore;
    let n = 0;

    beforeAll(() => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quar-unit-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY: "test-api-key-0123456789" }));
        seed = seedProject(platform, "Quarantine unit");
        store = new QuarantineStore(platform.db, () => clock);
    });
    afterAll(() => {
        platform.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const fresh = (key: string) => {
        const id = addTest(platform, seed, `${key}${++n}`);
        const t = platform.repo.getTest(id)!;
        return { id, testKey: t.testKey, title: t.title };
    };
    const make = (t: ReturnType<typeof fresh>, over: Record<string, unknown> = {}) => store.create({ projectId: seed.projectId, testId: t.id, testKey: t.testKey, title: t.title, reason: "Passed and failed on identical runs 3 times", source: "suggested", by: "Dana", ...over });

    it("keeps an entry with who, why, since and expiry (14 days by default)", () => {
        const t = fresh("a");
        clock = Date.now();
        const e = make(t);
        expect(e).toMatchObject({ projectId: seed.projectId, testId: t.id, status: "active", by: "Dana", source: "suggested", reviewedAt: null, endedAt: null });
        expect(new Date(e.expiresAt).getTime() - new Date(e.since).getTime()).toBe(14 * DAY);
        expect(make(fresh("b"), { days: 90 }).expiresAt).toBe(new Date(new Date(store.list(seed.projectId)[0]!.since).getTime() + 60 * DAY).toISOString());
    });

    it("allows one active entry per test", () => {
        const t = fresh("one");
        make(t);
        expect(() => make(t)).toThrow(/already in quarantine/);
    });

    it("ends an entry that ran out when it is read, and records that once", () => {
        const t = fresh("exp");
        clock = Date.now();
        const e = make(t, { days: 2 });
        clock += 2 * DAY - 1;
        expect(store.get(e.id)!.status).toBe("active");
        clock += 1;
        const gone = store.get(e.id)!;
        expect(gone.status).toBe("expired");
        expect(gone.endedBy).toBe("system");
        expect(store.activeFor(t.id)).toBeUndefined();
        store.sweep(clock);
        store.sweep(clock);
        expect(store.history(seed.projectId, { testId: t.id }).filter((h) => h.kind === "expired")).toHaveLength(1);
        // it can be quarantined again after it ended
        clock = Date.now();
        expect(make(t).status).toBe("active");
    });

    it("lifts an expired entry out of the gate even before anything swept it", () => {
        const t = fresh("gate");
        clock = Date.now();
        make(t, { days: 1 });
        expect(quarantineGate(platform.db, clock, seed.projectId).has(t.id)).toBe(true);
        expect(quarantineGate(platform.db, clock + DAY, seed.projectId).has(t.id)).toBe(false);
    });

    it("releases early, refuses a second release, and keeps the trail", () => {
        const t = fresh("rel");
        const e = make(t);
        const done = store.release(e.id, "Sam", "fixed the wait");
        expect(done).toMatchObject({ status: "released", endedBy: "Sam" });
        expect(() => store.release(e.id, "Sam")).toThrow(/already released/);
        expect(quarantineGate(platform.db, Date.now(), seed.projectId).has(t.id)).toBe(false);
        expect(store.history(seed.projectId, { testId: t.id }).map((h) => h.kind)).toEqual(["released", "quarantined"]);
    });

    it("records a review, may extend but never past 60 days or shorten", () => {
        const t = fresh("rev");
        clock = Date.now();
        const e = make(t, { days: 14 });
        const later = store.review(e.id, "Dana", 30, "still flaky");
        expect(later.reviewedBy).toBe("Dana");
        expect(later.reviewedAt).not.toBeNull();
        expect(new Date(later.expiresAt).getTime()).toBeGreaterThan(new Date(e.expiresAt).getTime());
        const shorter = store.review(e.id, "Dana", 1);
        expect(shorter.expiresAt).toBe(later.expiresAt);
        const cap = store.review(e.id, "Dana", 60);
        expect(new Date(cap.expiresAt).getTime()).toBeLessThanOrEqual(new Date(e.since).getTime() + 60 * DAY);
        expect(() => store.review(e.id, "Dana", 60)).toThrow(/longest/);
    });

    it("has an append-only history: rows cannot be changed, and there is no way to delete one", () => {
        const t = fresh("hist");
        make(t);
        const id = store.history(seed.projectId, { testId: t.id })[0]!.id;
        expect(() => platform.db.run("UPDATE quarantine_history SET reason = 'x' WHERE id = ?", id)).toThrow(/cannot be changed/);
        expect(Object.getOwnPropertyNames(QuarantineStore.prototype).filter((m) => /delete|remove|update/i.test(m))).toEqual([]);
        expect(store.history(seed.projectId, { testId: t.id })[0]!.reason).toBe("Passed and failed on identical runs 3 times");
    });

    it("drops a quarantine from the gate when its test now fails every run", async () => {
        const t = fresh("real");
        // five runs, all failing: a real defect, whatever the quarantine says
        make(t);
        for (let i = 0; i < CONSISTENT_RUNS; i++) await seedRun(platform, seed, { [`real${n}`]: "fail" });
        expect(quarantineGate(platform.db, Date.now(), seed.projectId).has(t.id)).toBe(false);
        expect(store.activeFor(t.id)).toBeDefined(); // the entry is still there; it just does not gate
    });
});

// ── the places that gate, as pure functions ─────────────────────────────────

describe("runbook checks and CI output", () => {
    const facts = (over: Record<string, unknown> = {}) => ({ hasRun: true, jobError: null, total: 4, passed: 4, failed: 0, highSeverity: 0, apiBreaking: null, readiness: null, ...over });

    it("pass rate and no-failures say how many quarantined tests they ignored, and read exactly as before without any", async () => {
        const { evaluateCondition } = await import("../src/engine/runbook/flow.js");
        const q = { quarantined: 2 };
        expect(evaluateCondition({ check: "passRate", atLeast: 100 }, facts(q))).toEqual({ passed: true, measured: "100% passed (4 of 4) (2 quarantined tests ignored)", reason: "100% passed, which meets the 100% needed. (2 quarantined tests ignored)" });
        expect(evaluateCondition({ check: "noFailures" }, facts(q))).toEqual({ passed: true, measured: "no failing tests (2 quarantined tests ignored)", reason: "No test failed. (2 quarantined tests ignored)" });
        // a real failure still fails, and says what was ignored
        expect(evaluateCondition({ check: "noFailures" }, facts({ failed: 1, quarantined: 1 }))).toMatchObject({ passed: false, measured: "1 failing test (1 quarantined test ignored)" });
        // no quarantine: the old words, byte for byte
        expect(evaluateCondition({ check: "passRate", atLeast: 100 }, facts())).toEqual({ passed: true, measured: "100% passed (4 of 4)", reason: "100% passed, which meets the 100% needed." });
        expect(evaluateCondition({ check: "noFailures" }, facts())).toEqual({ passed: true, measured: "no failing tests", reason: "No test failed." });
        // high-severity findings are never softened by quarantine
        expect(evaluateCondition({ check: "noHighSeverity" }, facts({ highSeverity: 1, quarantined: 3 })).passed).toBe(false);
    });

    const test = (over: Record<string, unknown>) => ({ id: "i", testId: "API-1", title: "T", suite: "API", kind: "api", type: "functional", priority: "medium", outcome: "passed", validation: "VALIDATED", durationMs: 1, attempts: 1, evidence: [], ...over });

    it("the CI gate ignores a quarantined failure but not a plain one, and the summary says so only when it matters", async () => {
        const { evaluateGate, summarize } = await import("../src/cli/model.js");
        const flakyFinding = test({ id: "a", testId: "API-1", outcome: "finding", validation: "NEEDS_REVIEW", severity: "high", quarantine: { reason: "flaky", expiresAt: "2026-12-01T00:00:00.000Z" } });
        const flakyFailed = test({ id: "b", testId: "API-2", outcome: "failed", validation: "FAILED_VALIDATION", quarantine: { reason: "flaky", expiresAt: "2026-12-01T00:00:00.000Z" } });
        const plain = test({ id: "c", testId: "API-3", outcome: "failed", validation: "FAILED_VALIDATION" });
        const ok = test({ id: "d", testId: "API-4" });
        expect(evaluateGate([ok, flakyFinding, flakyFailed] as never, "any", true)).toMatchObject({ passed: true, exitCode: 0, reasons: [] });
        expect(evaluateGate([ok, flakyFinding, flakyFailed, plain] as never, "any", true)).toMatchObject({ passed: false, exitCode: 1 });
        expect(summarize([ok, flakyFinding, flakyFailed] as never)).toMatchObject({ total: 3, passed: 1, findings: 0, failedValidation: 0, quarantined: 2, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } });
        // without quarantine the summary has no new key at all
        expect(Object.keys(summarize([ok, plain] as never))).toEqual(["total", "passed", "findings", "failedValidation", "notRun", "bySeverity"]);
    });

    it("JUnit reports a quarantined failure as skipped with the reason, a plain one as a failure, and a passing one as a pass", async () => {
        const { buildJunit } = await import("../src/platform/reports/junit.js");
        const base = { suite: "API", kind: "api", priority: "medium", validationStatus: "FAILED_VALIDATION", validationReason: "boom" };
        const xml = buildJunit("S", [
            { ...base, testKey: "A-1", title: "held", last: { status: "failed", durationMs: 5, error: "boom" }, quarantine: { reason: "flaky <on> Fridays" } },
            { ...base, testKey: "A-2", title: "plain", last: { status: "failed", durationMs: 5, error: "boom" } },
            { ...base, testKey: "A-3", title: "fine", validationStatus: "VALIDATED", validationReason: null, last: { status: "passed", durationMs: 5, error: null }, quarantine: { reason: "flaky" } },
        ]);
        expect(xml).toContain('<skipped message="quarantined: flaky &lt;on&gt; Fridays"/>');
        expect(xml).toMatch(/failures="1" skipped="1"/);
        expect(xml.match(/<failure /g)).toHaveLength(1);
        // without any quarantine the file is the same as it always was
        const plainXml = buildJunit("S", [{ ...base, testKey: "A-2", title: "plain", last: { status: "failed", durationMs: 5, error: "boom" } }]);
        expect(plainXml).toBe(buildJunit("S", [{ ...base, testKey: "A-2", title: "plain", last: { status: "failed", durationMs: 5, error: "boom" }, quarantine: undefined }]));
        expect(plainXml).not.toMatch(/quarantine/i);
    });

    it("sign-off warns an approver about quarantined tests without blocking, and says nothing when there are none", async () => {
        const { evaluateSignoff } = await import("../src/engine/manual/signoff.js");
        const auto = { state: "ready" as const, reasons: [] };
        expect(evaluateSignoff({ automated: auto, items: [], quarantined: 2 })).toMatchObject({ canApprove: true, blocking: [], warnings: [{ code: "quarantined-tests", text: "2 quarantined tests were not counted; they are listed below" }] });
        expect(evaluateSignoff({ automated: auto, items: [], quarantined: 1 }).warnings[0]!.text).toBe("1 quarantined test was not counted; it is listed below");
        expect(evaluateSignoff({ automated: auto, items: [] })).toEqual({ blocking: [], warnings: [], canApprove: true });
    });

    it("readiness adds one information reason and leaves everything else alone", async () => {
        const { assessReadiness } = await import("../src/platform/dashboard.js");
        const input = { activeJob: false, latestJob: { status: "COMPLETED", mode: "validate" }, tests: { total: 4, validated: 4, needsReview: 0, failedValidation: 0, waiting: 0 }, findings: { critical: 0, high: 0, medium: 0, low: 0 }, latestRun: { failed: 0, needsReview: 0, total: 4 }, flaky: 0, breakingChanges: 0, lastRunAt: new Date().toISOString() };
        expect(assessReadiness(input)).toEqual({ state: "ready", label: "Ready", reasons: [], stale: false });
        expect(assessReadiness({ ...input, quarantined: 2 })).toEqual({ state: "ready", label: "Ready", reasons: [{ code: "quarantined-tests", text: "2 quarantined tests are not counted" }], stale: false });
        // a real problem still wins, and the note comes last
        const worse = assessReadiness({ ...input, findings: { critical: 1, high: 0, medium: 0, low: 0 }, quarantined: 1 });
        expect(worse.state).toBe("blocked");
        expect(worse.reasons.map((r) => r.code)).toEqual(["critical-findings", "quarantined-tests"]);
    });
});
