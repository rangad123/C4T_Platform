/**
 * Test-selection preview (pure parts): coverage freshness (coverage.ts freshnessOf), for API tests too, a shared part
 * changed after the latest run (held.ts changedAfterRun), runner capability parity with deploy triggers (parity.ts compareSets,
 * preview.ts), and the worked example of the review pack: one sample project with a test in each state and the exact reason shown for
 * it. No platform, no browser, no AI.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_FRESH_DAYS, extractCoverage, freshDaysFrom, freshnessOf, type CurrentVersion, type LatestRun, type ObservedRun, type TestFacts } from "../src/platform/selection/coverage.js";
import { changedAfterRun, heldWhy } from "../src/platform/selection/held.js";
import { compareSets, triggerName, type TriggerParity } from "../src/platform/selection/parity.js";
import { previewSelection, readChanges } from "../src/platform/selection/preview.js";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const CURRENT: CurrentVersion = { versionId: "v2", version: 2, scriptId: "s2" };
const latest = (over: Partial<LatestRun> = {}): LatestRun => ({ executionId: "e1", status: "passed", startedAt: "2026-11-13T10:00:00.000Z", versionId: "v2", scriptId: "s2", ...over });
const run = (over: Partial<ObservedRun> = {}): ObservedRun => ({ executionId: "e1", status: "passed", startedAt: "2026-11-13T10:00:00.000Z", complete: true, queryUnknown: true, requests: [], ...over });
const web = (id: string, testKey: string, runs: ObservedRun[], last: LatestRun | undefined, current: CurrentVersion = CURRENT, steps: unknown[] = [{ action: "navigate", url: "/" }]): TestFacts => ({
    id,
    testKey,
    title: testKey,
    kind: "web",
    spec: { steps },
    runs,
    freshness: freshnessOf(last, current, NOW),
});

describe("1. freshness: only the latest relevant run can make a test complete", () => {
    it("is fresh only for a recent passing run of the current version and script", () => {
        expect(freshnessOf(latest(), CURRENT, NOW)).toEqual({ fresh: true, executionId: "e1" });
        expect(freshnessOf(undefined, CURRENT, NOW)).toMatchObject({ fresh: false, never: true, why: "No run of it has been recorded yet, so what it touches is only known from its steps." });
        expect(freshnessOf(latest(), {}, NOW)).toMatchObject({ fresh: false, never: true, why: "It has no approved version, so no run of what it would run now exists." });
    });

    it("is stale when the latest run failed, errored, was cancelled or has not finished, whatever passed before", () => {
        const why = (status: string) => (freshnessOf(latest({ status }), CURRENT, NOW) as { why: string }).why;
        expect(why("failed")).toBe("Its latest run (2026-11-13) failed, so earlier passing runs no longer show what it touches.");
        expect(why("error")).toBe("Its latest run (2026-11-13) ended with an error, so earlier passing runs no longer show what it touches.");
        expect(why("cancelled")).toBe("Its latest run (2026-11-13) was cancelled, so earlier passing runs no longer show what it touches.");
        expect(why("running")).toBe("Its latest run (2026-11-13) did not pass (running), so earlier passing runs no longer show what it touches.");
    });

    it("is stale when the test changed after its latest run, or the run is not linked to a version", () => {
        expect(freshnessOf(latest({ versionId: "v1" }), CURRENT, NOW)).toMatchObject({ fresh: false, why: "It changed after its latest run (2026-11-13): version 2 has not run yet." });
        expect(freshnessOf(latest({ versionId: null }), CURRENT, NOW)).toMatchObject({ fresh: false, why: "Its latest run (2026-11-13) is not linked to a version of the test, so it may have run older steps." });
        expect(freshnessOf(latest({ scriptId: "s1" }), CURRENT, NOW)).toMatchObject({ fresh: false, why: "Its code changed after its latest run (2026-11-13), and the new code has not run yet." });
    });

    it("is stale past the freshness window (14 days by default, SELECTION_FRESH_DAYS)", () => {
        expect(DEFAULT_FRESH_DAYS).toBe(14);
        const old = latest({ startedAt: "2026-10-30T11:00:00.000Z" }); // 15 days and an hour before NOW
        expect(freshnessOf(old, CURRENT, NOW)).toMatchObject({ fresh: false, why: "Its latest run (2026-10-30) is older than 14 days, so it may no longer show what the test touches." });
        expect(freshnessOf(old, CURRENT, NOW, 30)).toEqual({ fresh: true, executionId: "e1" });
        expect(freshnessOf(latest({ startedAt: "not a date" }), CURRENT, NOW).fresh).toBe(false);
        expect([freshDaysFrom(undefined), freshDaysFrom(""), freshDaysFrom("7"), freshDaysFrom("0"), freshDaysFrom("2.5"), freshDaysFrom("400"), freshDaysFrom("x")]).toEqual([14, 14, 7, 14, 14, 14, 14]);
    });

    it("never takes completeness from an older passing run; it still adds what that run touched", () => {
        const older = run({ executionId: "e0", startedAt: "2026-11-12T10:00:00.000Z", requests: [{ method: "POST", type: "fetch", path: "/api/orders" }] });
        const failed = run({ executionId: "e1", status: "failed", requests: [{ method: "GET", type: "document", path: "/cart" }] });
        const c = extractCoverage(web("w", "WEB-001", [failed, older], latest({ status: "failed" })));
        expect(c.completeness).toBe("partial");
        expect(c.stale).toBe("Its latest run (2026-11-13) failed, so earlier passing runs no longer show what it touches.");
        expect(c.limits[0]).toBe(c.stale);
        expect(c.items.map((i) => `${i.source} ${i.method ?? "page"} ${i.path}`)).toEqual(["observed POST /api/orders", "declared page /", "observed page /cart"]);
        // The same older run, with a fresh latest run that kept no record: not complete either.
        const noRecord = extractCoverage(web("w", "WEB-001", [older], latest()));
        expect(noRecord.completeness).toBe("partial");
        expect(noRecord.stale).toBeUndefined();
        expect(noRecord.limits[0]).toBe("Its latest run kept no readable record of what it touched, so what it touches now is not known.");
        // A fresh latest run with a complete footprint is.
        const ok = extractCoverage(web("w", "WEB-001", [run({ requests: [{ method: "GET", type: "route", path: "/cart" }] }), older], latest()));
        expect(ok).toMatchObject({ completeness: "observed-complete", completeFrom: "the passing run of 2026-11-13" });
    });

    it("4. requires a full run for stale coverage, even when the stale test matched the change", () => {
        const older = run({ executionId: "e0", startedAt: "2026-11-12T10:00:00.000Z", requests: [{ method: "POST", type: "fetch", path: "/api/orders" }] });
        const c = extractCoverage(web("w", "WEB-001", [older], latest({ status: "failed" })));
        const p = previewSelection([c], readChanges({ endpoints: ["POST /api/orders"] }).changes);
        expect(p.matched.map((t) => t.testKey)).toEqual(["WEB-001"]);
        expect(p.fullRunReasons).toEqual(["1 test's recorded coverage is out of date (the latest run did not pass, ran an older version, is older than the freshness window, or ran before a shared part it uses changed), so what it touches now is not known."]);
    });

    it("an API test counts as covered only with a fresh passing run of its current version, as a web test does", () => {
        const health = (last: LatestRun | undefined, current: CurrentVersion = CURRENT) =>
            extractCoverage({ id: "a", testKey: "API-001", title: "a", kind: "api", spec: { steps: [{ action: "request", method: "GET", path: "/health" }] }, runs: [], freshness: freshnessOf(last, current, NOW) });
        // Fresh: complete from its steps; no record of the run is needed (API runs keep no footprint).
        expect(health(latest())).toMatchObject({ completeness: "declared-complete", completeFrom: "its steps" });
        expect(health(latest()).stale).toBeUndefined();
        // Never ran: unknown rather than out of date, and the reason comes first.
        const never = health(undefined);
        expect(never).toMatchObject({ completeness: "partial", limits: ["No run of it has been recorded yet, so what it touches is only known from its steps."] });
        expect(never.stale).toBeUndefined();
        // Failed, older version, older code, outside the window: stale, each with its reason.
        expect(health(latest({ status: "failed" }))).toMatchObject({ completeness: "partial", stale: "Its latest run (2026-11-13) failed, so earlier passing runs no longer show what it touches." });
        expect(health(latest({ versionId: "v1" })).stale).toBe("It changed after its latest run (2026-11-13): version 2 has not run yet.");
        expect(health(latest({ scriptId: "s1" })).stale).toBe("Its code changed after its latest run (2026-11-13), and the new code has not run yet.");
        expect(health(latest({ startedAt: "2026-10-01T10:00:00.000Z" })).stale).toBe("Its latest run (2026-10-01) is older than 14 days, so it may no longer show what the test touches.");
        // Not matched only when fresh; a stale one is proposed and a full run is required.
        const { changes } = readChanges({ endpoints: ["POST /orders"] });
        expect(previewSelection([health(latest())], changes).notMatched.map((t) => t.testKey)).toEqual(["API-001"]);
        const stale = previewSelection([health(latest({ status: "error" }))], changes);
        expect(stale.notMatched).toEqual([]);
        expect(stale.unknown[0]!.why).toBe("Proposed because its recorded coverage is out of date: its latest run (2026-11-13) ended with an error, so earlier passing runs no longer show what it touches.");
        expect(stale.fullRunRequired).toBe(true);
        const never2 = previewSelection([health(undefined)], changes);
        expect(never2.unknown[0]!.why).toBe("Proposed because what it touches is not fully known: No run of it has been recorded yet, so what it touches is only known from its steps.");
        expect(never2.fullRunReasons).toEqual(["What 1 test touches is not fully known, so the preview cannot rule out that it reaches the change."]);
    });

    it("a shared part changed after the latest run makes it out of date when runs use the change without a new approval", () => {
        // Held back by runs (the policy asks for approval): no out-of-date words, the route lists it as Cannot run.
        expect(changedAfterRun({ held: true, what: "the reusable steps “Log in”" }, "2026-11-13T10:00:00.000Z")).toBeUndefined();
        expect(heldWhy("the reusable steps “Log in”")).toBe("Cannot run: the reusable steps “Log in” changed after its approval, so runs hold it back until it is approved again.");
        // Approved again at once by the policy at the next run: until then, the latest run is from before the change.
        expect(changedAfterRun({ held: false, what: "the reusable steps “Log in”" }, "2026-11-13T10:00:00.000Z")).toBe("The reusable steps “Log in” changed after its latest run (2026-11-13), and no run on the deploy target has used the change yet.");
        // Approved again by a run (a variant's, say) at `since`: a deploy-target run after it is fine, one before it is not.
        const again = { held: false as const, what: "a shared part it uses", since: "2026-11-12T09:00:00.000Z" };
        expect(changedAfterRun(again, "2026-11-13T10:00:00.000Z")).toBeUndefined();
        expect(changedAfterRun(again, "2026-11-11T10:00:00.000Z")).toBe("A shared part it uses changed after its latest run (2026-11-11), and no run on the deploy target has used the change yet.");
    });
});

describe("2. runner capability parity with deploy triggers", () => {
    it("compares the viewer's runnable set with a trigger's maker's", () => {
        expect(compareSets(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual({ onlyViewer: ["a"], onlyTrigger: ["c"] });
        expect(compareSets(new Set(["a"]), new Set(["a"]))).toEqual({ onlyViewer: [], onlyTrigger: [] });
        expect(triggerName("CI", "ab12")).toBe("“CI” (…ab12)");
        expect(triggerName(null, "ab12")).toBe("…ab12");
    });

    it("says so and requires a full run when a trigger's set differs or its maker cannot be resolved; the same set adds nothing", () => {
        const c = extractCoverage({ id: "a", testKey: "API-001", title: "a", kind: "api", spec: { steps: [{ action: "request", method: "GET", path: "/health" }] }, runs: [], freshness: freshnessOf(latest(), CURRENT, NOW) });
        const { changes } = readChanges({ endpoints: ["POST /orders"] });
        const same = previewSelection([c], changes, [], { parity: [{ trigger: "“CI” (…ab12)", onlyViewer: [], onlyTrigger: [] }] });
        expect(same.fullRunRequired).toBe(false);
        expect(same.triggers).toEqual([{ trigger: "“CI” (…ab12)", parity: "same" }]);
        const differ = previewSelection([c], changes, [], { parity: [{ trigger: "“CI” (…ab12)", onlyViewer: ["a"], onlyTrigger: [] }] });
        expect(differ.fullRunReasons).toEqual(["The deploy trigger “CI” (…ab12) runs on the runner of the person who made it, which can run a different set of tests than yours (1 test only your runner can run), so this preview does not describe its runs."]);
        expect(differ.notMatched[0]!.notes).toEqual(["The deploy trigger “CI” (…ab12) runs on the runner of the person who made it, which cannot run this test, so its runs leave it out."]);
        const unresolved: TriggerParity = { trigger: "…cd34", unresolvedWhy: "the person who made it no longer has an active account, so whose runner it uses is not known", onlyViewer: [], onlyTrigger: [] };
        const u = previewSelection([c], changes, [], { parity: [unresolved] });
        expect(u.fullRunReasons).toEqual(["The deploy trigger …cd34 cannot be compared with your runner: the person who made it no longer has an active account, so whose runner it uses is not known."]);
        expect(u.triggers[0]).toMatchObject({ parity: "unresolved" });
    });

    it("5. a test no runner runs (no approved version) is listed as Cannot run without requiring a full run", () => {
        const c = extractCoverage({ id: "d", testKey: "WEB-009", title: "d", kind: "web", spec: { steps: [{ action: "navigate", url: "/" }] }, runs: [], freshness: freshnessOf(undefined, {}, NOW) });
        const p = previewSelection([c], readChanges({ pages: ["/"] }).changes, [], { cannotRun: new Map([["d", { why: "Cannot run: it has no approved version yet, and runs leave it out until one is approved.", nowhere: true }]]) });
        expect(p.cannotRun.map((t) => t.why)).toEqual(["Cannot run: it has no approved version yet, and runs leave it out until one is approved."]);
        expect(p.fullRunRequired).toBe(false);
    });
});

/** The sample project of the review pack's worked example. */
function sampleProject() {
    const orders = { method: "POST", type: "fetch", path: "/api/orders" };
    const tests: TestFacts[] = [
        // matched, fresh: its latest run passed on version 2 yesterday and recorded POST /api/orders.
        web("w1", "WEB-001", [run({ requests: [{ method: "GET", type: "document", path: "/checkout" }, orders] })], latest()),
        // matched, but stale: an older passing run called POST /api/orders; its latest run failed.
        web("w2", "WEB-002", [run({ executionId: "e2", status: "failed", requests: [{ method: "GET", type: "document", path: "/cart" }] }), run({ executionId: "e1", startedAt: "2026-11-12T10:00:00.000Z", requests: [orders] })], latest({ executionId: "e2", status: "failed" })),
        // older version: its latest run passed, but on version 1; version 2 has not run.
        web("w3", "WEB-003", [run({ requests: [{ method: "GET", type: "document", path: "/profile" }] })], latest({ versionId: "v1" })),
        // no footprint: a record from before runs kept one.
        web("w4", "WEB-004", [run({ complete: false, incompleteWhy: "The recorded runs were made before runs kept their full footprint (pages reached inside the page), so they show only part of what the test does.", requests: [{ method: "GET", type: "document", path: "/help" }] })], latest()),
        // truncated footprint.
        web("w5", "WEB-005", [run({ complete: false, incompleteWhy: "A passing run's record was cut to its size limit, so it shows only part of what the test does.", requests: [{ method: "GET", type: "route", path: "/search" }] })], latest()),
        // unclassified traffic.
        web("w6", "WEB-006", [run({ unclassified: 2, requests: [{ method: "GET", type: "route", path: "/account" }] })], latest()),
        // capability mismatch: fresh and complete, touches only /about; the deploy trigger's runner cannot run it.
        web("w7", "WEB-007", [run({ requests: [{ method: "GET", type: "document", path: "/about" }] })], latest()),
        // unreadable steps.
        { id: "a1", testKey: "API-001", title: "API-001", kind: "api", spec: undefined, specUnreadable: true, runs: [], freshness: freshnessOf(undefined, CURRENT, NOW) },
        // outside the viewer's runner set (a phone test); the deploy trigger's runner can run it.
        { id: "m1", testKey: "MOB-001", title: "MOB-001", kind: "mobile", spec: { steps: [{ action: "tap" }] }, runs: [], freshness: freshnessOf(undefined, CURRENT, NOW) },
        // fully known from its steps (its latest run passed on version 2), not in the change.
        { id: "a2", testKey: "API-002", title: "API-002", kind: "api", spec: { steps: [{ action: "request", method: "GET", path: "/api/health" }] }, runs: [], freshness: freshnessOf(latest(), CURRENT, NOW) },
        // An API test that calls POST /api/orders, whose latest run failed: matched, and stale.
        { id: "a3", testKey: "API-003", title: "API-003", kind: "api", spec: { steps: [{ action: "request", method: "POST", path: "/api/orders" }] }, runs: [], freshness: freshnessOf(latest({ status: "failed" }), CURRENT, NOW) },
        // Held back by runs, its reusable steps changed after approval (the route lists it as Cannot run).
        web("w8", "WEB-008", [run({ requests: [{ method: "GET", type: "document", path: "/search" }] })], latest()),
        // Its reusable steps changed after its latest run, and the policy approves it again at the next run.
        { ...web("w9", "WEB-009", [run({ requests: [{ method: "GET", type: "document", path: "/faq" }] })], latest()), freshness: { fresh: false, why: changedAfterRun({ held: false, what: "the reusable steps “Log in”" }, "2026-11-13T10:00:00.000Z")! } },
    ];
    const coverage = tests.map((t) => extractCoverage(t, { appHost: "shop.example.test" }));
    const { changes, ignored, notProcessed } = readChanges({ endpoints: ["POST /api/orders"], pages: ["/orders/{id}"] }, { appHost: "shop.example.test" });
    const cannotRun = new Map([
        ["a1", { why: "Cannot run: its stored steps cannot be read. Open it to fix or delete it.", unreadable: true }],
        ["m1", { why: "Cannot run on your runner: mobile tests need a device or a runner set up for them." }],
        ["w8", { why: heldWhy("the reusable steps “Search box”"), nowhere: true, held: true }],
    ]);
    const parity: TriggerParity[] = [
        { trigger: triggerName("CI", "ab12"), onlyViewer: ["w7"], onlyTrigger: ["m1"] },
        // Its maker is no longer active on Crowd4Test (the trigger's own check, parity.ts ownerCheck).
        { trigger: triggerName("Nightly", "cd34"), unresolvedWhy: "Crowd4Test says the person who made it no longer has an active account, so its runs do not start", onlyViewer: [], onlyTrigger: [] },
    ];
    return previewSelection(coverage, changes, ignored, { notProcessed, cannotRun, parity });
}

describe("worked example (review pack v4)", () => {
    it("shows the exact group and reason for a test in each state", () => {
        const p = sampleProject();
        const row = (t: { testKey: string; why?: string; reasons: Array<{ sentence: string }>; notes?: string[] }) => [t.testKey, t.why ?? t.reasons.map((r) => r.sentence).join(" "), ...(t.notes ?? [])];
        expect(p.matched.map(row)).toEqual([
            ["API-003", "The change names POST /api/orders, and its steps call POST /api/orders (step 1)."],
            ["WEB-001", "The change names POST /api/orders, and a recorded run called POST /api/orders (run of 2026-11-13)."],
            ["WEB-002", "The change names POST /api/orders, and a recorded run called POST /api/orders (run of 2026-11-12)."],
        ]);
        expect(p.unknown.map(row)).toEqual([
            ["WEB-003", "Proposed because its recorded coverage is out of date: it changed after its latest run (2026-11-13): version 2 has not run yet."],
            ["WEB-004", "Proposed because what it touches is not fully known: The recorded runs were made before runs kept their full footprint (pages reached inside the page), so they show only part of what the test does."],
            ["WEB-005", "Proposed because what it touches is not fully known: A passing run's record was cut to its size limit, so it shows only part of what the test does."],
            ["WEB-006", "Proposed because what it touches is not fully known: A passing run made 2 requests the mapping could not classify, so what it touched is not fully known."],
            ["WEB-009", "Proposed because its recorded coverage is out of date: the reusable steps “Log in” changed after its latest run (2026-11-13), and no run on the deploy target has used the change yet."],
        ]);
        expect(p.notMatched.map(row)).toEqual([
            ["API-002", "Not proposed: what it touches is fully known from its steps (1 page or endpoint), and none of it is in the change."],
            [
                "WEB-007",
                "Not proposed: what it touches is fully known from the passing run of 2026-11-13 (2 pages and endpoints), and none of it is in the change.",
                "The deploy trigger “CI” (…ab12) runs on the runner of the person who made it, which cannot run this test, so its runs leave it out.",
            ],
        ]);
        expect(p.cannotRun.map(row)).toEqual([
            ["API-001", "Cannot run: its stored steps cannot be read. Open it to fix or delete it."],
            ["MOB-001", "Cannot run on your runner: mobile tests need a device or a runner set up for them.", "The deploy trigger “CI” (…ab12) runs on the runner of the person who made it, which runs this test."],
            ["WEB-008", "Cannot run: the reusable steps “Search box” changed after its approval, so runs hold it back until it is approved again."],
        ]);
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons).toEqual([
            "4 tests' recorded coverage is out of date (the latest run did not pass, ran an older version, is older than the freshness window, or ran before a shared part it uses changed), so what they touch now is not known.",
            "What 3 tests touch is not fully known, so the preview cannot rule out that they reach the change.",
            "1 test cannot run on your runner, so the preview did not judge it; a deploy run on another runner may still run it.",
            // Approved policy: a held test always requires a full run, named with why.
            "1 test is held back because a shared part it uses changed after its approval, so runs leave it out until approved again and the deploy tests less than the project has: WEB-008 “WEB-008” (the reusable steps “Search box” changed after its approval, so runs hold it back until it is approved again).",
            "The deploy trigger “CI” (…ab12) runs on the runner of the person who made it, which can run a different set of tests than yours (1 test only your runner can run, 1 test only its runner can run), so this preview does not describe its runs.",
            "The deploy trigger “Nightly” (…cd34) cannot be compared with your runner: Crowd4Test says the person who made it no longer has an active account, so its runs do not start.",
        ]);
        expect(p.triggers.map((t) => t.parity)).toEqual(["different", "unresolved"]);
        expect(p.counts).toEqual({ tests: 13, matched: 3, unknown: 5, proposed: 8, notMatched: 2, cannotRun: 3 });
        expect(p.uncoveredChanges).toEqual(["/orders/{}"]);
    });
});
