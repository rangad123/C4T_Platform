/**
 * The finding report on the real V10 cases (V10-RESULT.md; the paid trials eng-paid shop-5 and rbac-5, rows copied to
 * tests/fixtures/v10-findings.json): the headline says what differed, the steps keep methods, bodies and values, the report names the
 * account, an access check's report carries the requests it sent, an Expected line never quotes a check that passed, a finding whose
 * replays did not reproduce is never Confirmed alone, a destructive test's own side effects are no reproduction, and a confirmed
 * finding has a severity. Browser-free; expected values come from what the V10 reviewer saw on the app.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { reproduction } from "../src/engine/findings/classify.js";
import { carriedOver, verdictOf } from "../src/engine/findings/reproduce.js";
import { severityOf } from "../src/engine/findings/score.js";
import { failsAsCaptured } from "../src/engine/explore/independence.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { attemptNote, type ScriptRun } from "../src/engine/validation/runner.js";
import { CandidateFindingStore, type CandidateFindingRecord } from "../src/platform/candidate-finding-store.js";
import { Db } from "../src/platform/db.js";
import { accountOf, attemptOf, executionFinding, fromCandidate, headlineOf } from "../src/platform/findings/adapters.js";
import { harvestExecutionFindings, verifyFindings } from "../src/platform/findings/verify-service.js";
import { accessHelper, fakeBrowser, setAccounts } from "./identity-fake-browser.js";

type Row = { id: string; projectId: string; testId: string; fingerprint: string; state: string; finding: CandidateFindingRecord["finding"]; attempts: unknown[]; firstSeenAt: string; test: { id: string; title: string; spec: unknown; meta: Record<string, unknown> | null; testKey: string } };
const V10 = JSON.parse(fs.readFileSync(new URL("./fixtures/v10-findings.json", import.meta.url), "utf8")) as Record<string, Row>;
const testOf = (k: string) => ({ ...V10[k]!.test, spec: TestSpecSchema.parse(V10[k]!.test.spec) });
const record = (k: string, over: Partial<CandidateFindingRecord> = {}): CandidateFindingRecord => {
    const r = V10[k]!;
    return {
        id: r.id, projectId: r.projectId, status: "candidate", firstJobId: null, lastJobId: null, testId: r.testId, fingerprint: r.fingerprint, confidence: r.finding.confidence, capture: r.finding.capture,
        seenCount: 1, firstSeenAt: r.firstSeenAt, lastSeenAt: r.firstSeenAt, finding: r.finding, state: r.state, findingClass: "app_defect", severity: null, confidenceDetail: null, groupId: null, attempts: r.attempts, appVersion: null,
        ...over,
    } as CandidateFindingRecord;
};
const view = (k: string) => fromCandidate(record(k), testOf(k));
const clean = { clean: true, note: "on a newly registered account each time" };
const run = (o: Partial<ScriptRun>): ScriptRun => ({ testId: "T", status: "failed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...o });

describe("the headline says what differed, not the assertion's words (V10 gap 2)", () => {
    it("R3, R5 and R2 as stored: the difference from the attempts' error", () => {
        expect(view("R3").observed).toBe("Expected 409, got 200");
        expect(view("R5").observed).toBe("response.total: expected integer, got string");
        expect(view("R2").observed).toMatch(/^A signed-in “alice” user can call GET \/api\/orders\/ord-1001 \(HTTP 200\), a record listed for the “bob” account/);
        // A narrative observation is kept as written.
        expect(view("R10").observed).toBe(V10.R10!.finding.observed);
    });

    it("a new failed run is stored with its first line only (no unmasked value), and Playwright's typed Expected/Received pair reads the same way", () => {
        const err = (V10.R3!.attempts[0] as { error: string }).error;
        const t = testOf("R3");
        expect(executionFinding(t, run({ failedStepIndex: 3, steps: [{ index: 3, title: "4. assertResponse", status: "failed", error: err }] })).observed).toBe("Error: expect(received).toBe(expected) // Object.is equality");
        expect(headlineOf('Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId("subtotal")\nExpected string: "$21.00"\nReceived string: "$16.75"')).toBe('Expected "$21.00", got "$16.75"');
        expect(headlineOf("Error: Relation check failed (7.3): name == $a. Values: name = \"x\".")).toBe("Error: Relation check failed (7.3): name == $a. Values: name = \"x\".");
    });
});

describe("the steps keep methods, bodies and values (V10 gap 3)", () => {
    it("R3's requests name their method and the check its value; R1's write keeps its body; R10's typed title is there", () => {
        const s = view("R3").steps;
        expect(s[2]).toEqual({ action: "request", method: "POST", target: "/api/orders/ord-1000/cancel" });
        expect(s[3]).toMatchObject({ action: "assertResponse", value: "409" });
        expect(view("R1").steps[2]).toMatchObject({ method: "PUT", target: "/api/profile", body: '{"name":"test-name-{{unique}}","address":"test-address-{{unique}}"}' });
        expect(view("R10").steps[5]).toMatchObject({ action: "fill", target: "Title", value: "<b>qa1x0y</b> {{unique}}" });
    });

    it("a secret typed into a secret field, or sent under a secret key, is hidden; a placeholder is not", () => {
        const spec = TestSpecSchema.parse({
            ...(V10.R1!.test.spec as object),
            steps: [
                { action: "request", method: "POST", path: "/api/login", body: { email: "a@b.test", password: "hunter2!", token: "{{credentials.password}}" }, auth: "none" },
                { action: "navigate", url: "/login" },
                { action: "fill", locator: { by: "label", value: "Password" }, value: "hunter2!" },
                { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
            ],
        });
        const steps = fromCandidate(record("R1"), { ...testOf("R1"), spec }).steps;
        expect(steps[0]!.body).not.toContain("hunter2!");
        expect(steps[2]!.value).toBe("[hidden]");
        expect(steps[3]!.value).toBe("{{credentials.password}}");
    });
});

describe("the report names the account that signed in (V10 gap 4)", () => {
    it("an access check's own accounts, the project's account, a self-registered one", () => {
        expect(view("R7").account).toBe("the “ana” test account");
        expect(view("R2").account).toBe("the “alice” test account, and the “bob” test account");
        expect(view("R9").account).toBe("the “mia” test account");
        expect(view("R3").account).toBe("the project's test account");
        expect(view("R10").account).toBe("the project's test account");
        expect(view("R1").account).toBe("an account the test registers itself");
        expect(accountOf(TestSpecSchema.parse({ ...(V10.R10!.test.spec as object), steps: [{ action: "navigate", url: "/" }] }))).toBe("no account (signed out)");
    });
});

describe("an access check's report carries the requests it sent (V10 gap 1)", () => {
    it("R7's owner write: method, the real path, the body as sent with secret-named values hidden, and the status", async () => {
        setAccounts(["ana"]);
        const RECORD = { id: "n3", title: "Team lunch", body: "Ramen", owner: "Ben", apiToken: "tok-123456" };
        const b = fakeBrowser({ answer: (c) => ({ status: 200, body: JSON.stringify(RECORD) }) });
        const cfg = { identityWrite: "owner", as: "ana", method: "PUT", path: "/api/notes/n3", documented: "403 or 404", sev: "high" };
        const error = await accessHelper.accessAssert(b.page, "http://127.0.0.1:9000/", JSON.stringify(cfg)).then(() => "", (e: Error) => `Error: ${e.message}`);
        expect(error).toMatch(/^Error: Access control check failed: 1 write may be open to an account that is not the owner/);
        expect(error).not.toContain("tok-123456");
        const a = attemptOf(run({ failedStepIndex: 1, steps: [{ index: 1, title: "2. PUT /api/notes/n3 is refused", status: "failed", error }] }), testOf("R7").spec);
        expect(a.requests).toEqual([{ method: "PUT", path: "/api/notes/n3", status: 200, own: true, body: '{"id":"n3","title":"Team lunch","body":"Ramen","owner":"Ben","apiToken":"[hidden]"}' }]);
        expect(headlineOf(error)).toMatch(/^A signed-in “ana” user, who reads this record but does not own it, sent PUT \/api\/notes\/n3 and it was accepted \(HTTP 200\)/);
    });

    it("R9's role write: the real id, the body, the account's own role, and the change back", async () => {
        setAccounts(["ana", "mia", "ada"]);
        const ROLES: Record<string, string> = { ana: "user", mia: "manager", ada: "admin" };
        const b = fakeBrowser({ answer: (c) => (c.url.endsWith("/api/me") ? { status: 200, body: JSON.stringify({ id: `u-${c.who}`, role: ROLES[c.who] }) } : c.method === "PATCH" ? { status: 200, body: "{}" } : { status: 404, body: "{}" }) });
        const cfg = JSON.parse(String((testOf("R9").spec.steps[1] as { expected: string }).expected));
        const error = await accessHelper.accessAssert(b.page, "http://127.0.0.1:9000/", JSON.stringify({ ...cfg, pool: ["ana", "ada"] })).then(() => "", (e: Error) => `Error: ${e.message}`);
        expect(error).toMatch(/“mia” user gave its own account the role “admin” of “ada”, in place of its own “manager”, with PATCH \/api\/admin\/users\/u-mia/);
        const a = attemptOf(run({ failedStepIndex: 1, steps: [{ index: 1, title: "2. PATCH", status: "failed", error }] }), testOf("R9").spec);
        expect(a.requests).toEqual([
            { method: "PATCH", path: "/api/admin/users/u-mia", status: 200, own: true, body: '{"role":"admin"}' },
            { method: "PATCH", path: "/api/admin/users/u-mia", status: 200, own: true, body: '{"role":"manager"}' },
        ]);
    });

    it("an attempt that skipped itself is not a failure, and three empty failures are not the same failure (R7, R9's attempts)", () => {
        const skipped = attemptOf(run({ status: "skipped" }), testOf("R7").spec);
        expect(skipped).toMatchObject({ outcome: "error", environment: expect.stringMatching(/did not run: the test skipped itself/) });
        expect(verdictOf(view("R7"), [skipped, skipped, skipped], clean).to).toBe("environment_issue");
        // As stored in the trial: three failed attempts with nothing in them were counted 3 of 3.
        expect(reproduction(view("R7").attempts)).toEqual({ same: 0, of: 3 });
        expect(verdictOf(view("R7"), view("R7").attempts, clean).to).not.toBe("reproduced");
    });
});

describe("a report does not contradict itself (V10 gap 5, R10)", () => {
    it("the Expected line is the expected result the failing check names, not the one that passed", () => {
        const e = view("R10").expected;
        expect(e.source).toBe("expected:1");
        expect(e.text).toBe(testOf("R10").spec.expectedResults[0]);
        // A finding whose stored expectation is the failing one keeps it.
        expect(view("R3").expected.text).toBe(V10.R3!.finding.expected.text);
    });

    it("replays that differ only in the run's {{unique}} value fail as captured", () => {
        expect(failsAsCaptured("qa1x0y 1795482092564", 'Error: expect(locator).toContainText(expected) failed\n\nExpected substring: "a < b"\nReceived: "qa1x0y 1795482141912"')).toBe(true);
        expect(failsAsCaptured("qa1x0y 1795482092564", 'Error: expect(locator).toContainText(expected) failed\n\nReceived: "qa1x0y bold"')).toBe(false);
    });

    it("attempts that reproduce it cannot confirm a finding whose replays said they do not", () => {
        const r10 = view("R10");
        expect(r10.independence).toBe("state_dependent");
        const v = verdictOf(r10, r10.attempts, clean);
        expect(v.to).toBe("needs_manual_review");
        expect(v.reason).toMatch(/replays when it was found did not reproduce it/);
        expect(verdictOf({ ...r10, independence: "independent" }, r10.attempts, clean).to).toBe("reproduced");
    });
});

describe("a destructive test does not count its own side effects (V10 gap 6, R3)", () => {
    it("without a reset, attempts that started from attempt 1's cancel do not count, and it is not Confirmed", () => {
        const tried = carriedOver(view("R3").attempts);
        expect(tried[0]!.environment).toBeUndefined();
        expect(tried[1]!.environment).toMatch(/^It started from the data an earlier attempt changed \(attempt 1 sent POST \/api\/orders\/ord-1000\/cancel, answered 200\), so it stopped at step 2/);
        expect(tried[2]!.environment).toMatch(/attempt 1 sent POST/);
        const v = verdictOf(view("R3"), tried, clean);
        expect(v.to).toBe("needs_manual_review");
        expect(v.reason).toMatch(/2 of 3 attempts started from what an earlier attempt changed, so only 1 count \(1 of them failed\)/);
        // Three attempts that each fail the check itself are not side effects of one another.
        const same = [0, 0, 0].map(() => view("R3").attempts[0]!);
        expect(carriedOver(same).every((a) => !a.environment)).toBe(true);
    });

    it("with a reset before each attempt, every attempt starts from a shipped order: Confirmed 3 of 3, with a severity", async () => {
        const at = "2026-11-24T10:00:00.000Z";
        const db = new Db(":memory:");
        db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "p1", "u-1", "p1", at, at);
        db.run("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES (?,?,?,?,?)", "s-1", "p1", "S", "s", at);
        const t = testOf("R3");
        db.run("INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", "t-1", "p1", "s-1", t.testKey, t.title, "api", t.spec.type, t.spec.priority, "NEEDS_REVIEW", "playwright-api", JSON.stringify(t.spec), at, at);
        const store = new CandidateFindingStore(db.sql);
        const test = { ...t, id: "t-1", framework: "playwright-api" };
        // The bench app: ord-1000 is shipped after a reset; a cancel is (wrongly) accepted and cancels it.
        let order = "shipped";
        const resets: number[] = [];
        const attemptRun = (note: string): ScriptRun => {
            if (order === "shipped") {
                order = "cancelled";
                return run({ notes: [note], failedStepIndex: 3, steps: [{ index: 3, title: "4. Refused with the documented HTTP 409", status: "failed", error: "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 409\nReceived: 200" }], responses: [{ method: "GET", path: "/api/orders/ord-1000", status: 200 }, { method: "POST", path: "/api/orders/ord-1000/cancel", status: 200 }] });
            }
            return run({ notes: [note], failedStepIndex: 1, steps: [{ index: 1, title: "2. It is still shipped", status: "failed", error: 'Error: expect(received).toEqual(expected) // deep equality\n\nExpected: "shipped"\nReceived: "cancelled"' }], responses: [{ method: "GET", path: "/api/orders/ord-1000", status: 200 }] });
        };
        const [f] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test, run: attemptRun("x") }] });
        const asked: number[] = [];
        const deps = {
            store, projectId: "p1", testOf: () => test, appUrl: "http://127.0.0.1:7550", env: { baseUrl: "http://127.0.0.1:7550", headless: true },
            render: { baseUrl: "http://127.0.0.1:7550" }, scratchDir: "/nonexistent", ranOn: "the platform", dataChanges: true, emit: () => undefined,
            execute: async (_a: string, _b: unknown, _e: unknown, opts: { attempts?: number }) => {
                asked.push(opts.attempts ?? 0);
                return Array.from({ length: opts.attempts ?? 1 }, (_, i) => attemptRun(attemptNote(i + 1, opts.attempts ?? 1)));
            },
        };
        // Without a reset: attempt 1 cancels the order, the other two stop at the precondition, so it is not confirmed.
        order = "shipped";
        await verifyFindings({ ...deps, findings: [f!] });
        let stored = (await store.get("p1", f!.id))!;
        expect([stored.state, (await store.history("p1", f!.id)).at(-1)?.reason]).toEqual(["needs_manual_review", expect.stringMatching(/2 of 3 attempts started from what an earlier attempt changed/)]);
        expect(asked).toEqual([3]);

        order = "shipped";
        const [g] = await harvestExecutionFindings(store, { projectId: "p1", jobId: null, failed: [{ test: { ...test, spec: TestSpecSchema.parse({ ...t.spec, testId: "API-902" }) }, run: attemptRun("x") }] });
        asked.length = 0;
        const r = await verifyFindings({ ...deps, findings: [g!], reset: { hook: { method: "POST", url: "/__bench/reset" }, send: async () => (resets.push(1), (order = "shipped"), { ok: true, message: "reset" }) } });
        expect(resets).toHaveLength(3);
        expect(asked).toEqual([1, 1, 1]);
        expect(r.verified[0]).toMatchObject({ to: "reproduced", reason: expect.stringMatching(/3 of 3 attempts/) });
        stored = (await store.get("p1", g!.id))!;
        expect(stored.state).toBe("confirmed");
        expect(fromCandidate(stored, test).observed).toBe("Expected 409, got 200");
        // V10 gap 7: a confirmed finding has a severity.
        expect(stored.severity).toBe(severityOf(fromCandidate(stored, test)).severity);
        expect(["critical", "high", "medium", "low"]).toContain(stored.severity);
        expect((stored.attempts as Array<{ account?: string }>).map((a) => a.account)).toEqual(["in a fresh browser", "in a fresh browser", "in a fresh browser"]);
    });
});
