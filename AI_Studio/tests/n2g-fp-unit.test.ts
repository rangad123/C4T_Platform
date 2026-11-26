/**
 * The practice-store full run (N2F): its three wrong outcomes, built from the run's own tests, requirement text and failing checks.
 * Real platform (SQLite), scripted executor; no browser, no AI.
 *   1. WEB-032: the test typed an 81-character title into a field with maxlength="80" to see it refused. Found at the message check
 *      (step 16); verification stopped earlier, at a value check on a note id the new account does not have (step 11), whose own text
 *      names no length. The finding's cited expectation does: the test's own problem (automation), never Confirmed.
 *   2. WEB-038: Confirmed at a check that a "definition" named "8" (the shared account's order count) is visible, which the cited
 *      expectation ("the user's number of notes and number of orders", requirement 10.2) does not state. A role locator's name is judged
 *      as a text locator's is: an incorrect expectation, never Confirmed.
 *   3. WEB-027: Confirmed at an address check, /spa/#/dashboard, which only the test's own expected result states; requirement 10.1, the
 *      one it cites, names the hash routes but not that /spa/ rewrites the address. An address check is judged against the requirement.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { harvestExecutionFindings, verifyDepsOf, verifyFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RequirementStore } from "../src/platform/requirement-store.js";

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-n2g-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "n2g-fp-secret-key-0123456789abcdef0123", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** The store's requirements as N2F's requirements table holds them (title is the text). */
const REQS = {
    "3.4": "Signing in with a correct email and password must open /account (or the page named in ?next= when it is a path on this site).",
    "10.1": "/spa/ is a single-page area with hash routes #/dashboard, #/notes and #/notes/:id; moving between them must not reload the page, and the Back button must work.",
    "10.2": "The dashboard must show the user's number of notes and orders, loaded with fetch.",
    "10.8": 'A note title that is empty or longer than 80 characters must show "Enter a title of 1 to 80 characters."',
};
const NOTES_MODEL = {
    pages: [{ id: "page-notes", path: "/spa/#/notes", forms: [{ name: "New note", fields: [{ name: "title", label: "Title", type: "text", required: true, maxLength: 80 }, { name: "body", label: "Body", type: "textarea" }] }] }],
};

const run = (spec: TestSpec, step: number, error: string): ScriptRun => ({
    testId: spec.testId,
    status: "failed",
    durationMs: 1,
    failedStepIndex: step - 1,
    steps: spec.steps.slice(0, step).map((s, i) => ({ index: i, title: `${i + 1}. ${s.action}`, status: i === step - 1 ? ("failed" as const) : ("passed" as const), ...(i === step - 1 ? { error } : {}) })),
    artifacts: [],
    responses: [],
});

/** Harvests the finding from the run that found it (`found`), then verifies it with three attempts that fail as `verified`. */
async function verify(spec: TestSpec, found: ScriptRun, verified: ScriptRun, reqs: Record<string, string> = REQS) {
    const projectId = String(platform.repo.createProject({ name: `n2g ${spec.testId} ${Math.random()}` }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:7651", { ...DEFAULT_JOB_OPTIONS }, { username: "user@practice.test", password: "pw-n2g" });
    await new AppIntelStore(platform.sql).addVersion({ projectId, applicationId: appId, model: NOTES_MODEL });
    const rs = new RequirementStore(platform.sql);
    for (const [ref, title] of Object.entries(reqs)) await rs.create(projectId, { ref, title, status: "active" }, "imported");
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Notes SPA", "notes-spa");
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "NEEDS_REVIEW" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const t = platform.repo.getTest(testId)!;
    const store = new CandidateFindingStore(platform.sql);
    const [finding] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: found }] });
    const execute: VerifyDeps["execute"] = async () => [verified, verified, verified];
    await verifyFindings({ ...verifyDepsOf(platform, job, { execute }), findings: [finding!] });
    return { r: (await store.get(projectId, finding!.id))!, history: (await store.history(projectId, finding!.id)).map((e) => e.reason ?? "").join("\n") };
}

/** The sign-in steps stand in for the run's own three (Email, Password, Sign in) without the shared account, as N2F's new accounts did. */
const sign = [
    { action: "fill", locator: { by: "label", value: "Email" }, value: "user{{unique}}@practice.test" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "pw-{{unique}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true } },
];

// ── 1. WEB-032 ── (its role:customer tag left out: a fresh browser on the project's account stands in for the run's new account)
const web032 = (first: string, second: string) =>
    TestSpecSchema.parse({
        testId: "WEB-032",
        title: "Title length boundary: 80 accepted, 81 refused",
        kind: "web",
        category: "Notes SPA",
        type: "boundary",
        priority: "high",
        steps: [
            { action: "navigate", url: "/spa/#/notes" },
            ...sign,
            { action: "click", locator: { by: "role", role: "link", value: "Notes", exact: true } },
            { action: "fill", locator: { by: "role", role: "textbox", value: "Title", exact: true }, value: first },
            { action: "fill", locator: { by: "role", role: "textbox", value: "Body", exact: true }, value: "Boundary test body qan8oy" },
            { action: "fill", locator: { by: "role", role: "textbox", value: "Title", exact: true }, value: second },
            { action: "click", locator: { by: "role", role: "button", value: "Create note", exact: true } },
            { action: "navigate", url: "http://127.0.0.1:8351/spa/#/notes/14" },
            { action: "assert", check: "value", locator: { by: "role", role: "textbox", value: "Title", exact: true }, expected: second.slice(0, 80), source: "expected:2", description: `Verify value of textbox "Title" = ${second.slice(0, 80)}` },
            { action: "navigate", url: "http://127.0.0.1:8351/spa/#/notes" },
            { action: "assert", check: "attribute", locator: { by: "role", role: "textbox", value: "Title", exact: true }, expected: 80, name: "maxlength", source: "expected:1" },
            { action: "assert", check: "visible", locator: { by: "role", role: "link", value: second.slice(0, 80), exact: true }, source: "expected:2" },
            { action: "navigate", url: "http://127.0.0.1:8351/spa/#/notes/14" },
            { action: "assert", check: "visible", locator: { by: "text", value: "Enter a title of 1 to 80 characters" }, source: "expected:1", description: 'Verify visible of text "Enter a title of 1 to 80 characters"' },
        ],
        expectedResults: ["A title of 81 characters shows Enter a title of 1 to 80 characters. (requirement 10.8)", "A title of 80 characters creates a note listed in the Notes list (requirement 10.3.b)"],
        source: { origin: "browser-agent", requirements: ["10.3.b", "10.8"] },
    });
const T81A = "qasv97-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const T81B = "qan8oy-abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcd";
const NOT_FOUND = (loc: string) => `Error: expect(locator).toHaveValue(expected) failed\n\nLocator: ${loc}\nTimeout: 8000ms\nError: element(s) not found`;
const MSG_MISSING = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Enter a title of 1 to 80 characters')\nExpected: visible";

describe("1. WEB-032: a value the field's maxlength cut, verified at an earlier check of the same test", () => {
    it("the finding's cited expectation names the limit: automation, never Confirmed, and it says why", async () => {
        expect(T81A.length).toBe(82);
        expect(T81B.length).toBe(81);
        const spec = web032(T81A, T81B);
        const { r, history } = await verify(spec, run(spec, 16, MSG_MISSING), run(spec, 11, NOT_FOUND("getByRole('textbox', { name: 'Title', exact: true })")));
        expect(r.findingClass).toBe("automation");
        expect(r.state).toBe("automation_issue");
        expect(history).toMatch(/maxlength is 80/);
    });
    it("the same failures with titles the field takes whole stay the application's", async () => {
        const spec = web032(T81A.slice(0, 80), T81B.slice(0, 80));
        const { r } = await verify(spec, run(spec, 16, MSG_MISSING), run(spec, 11, NOT_FOUND("getByRole('textbox', { name: 'Title', exact: true })")));
        expect(r.findingClass).toBe("app_defect");
    });
});

// ── 2. WEB-038 ──
const web038 = (second: string) =>
    TestSpecSchema.parse({
        testId: "WEB-038",
        title: "Sign in redirects to the notes dashboard from a hash ?next",
        kind: "web",
        category: "Authentication",
        type: "navigation",
        priority: "high",
        steps: [
            { action: "navigate", url: "/login?next=%2Fspa%2F#/dashboard" },
            ...sign,
            { action: "assert", check: "exactText", locator: { by: "role", role: "heading", value: "Dashboard", exact: true }, expected: "Dashboard", source: "expected:1" },
            { action: "assert", check: "visible", locator: { by: "role", role: "definition", value: "8" }, source: "expected:2", description: "Orders count shown" },
        ],
        expectedResults: ["The browser opens /spa/#/dashboard, the page named in next (requirement 3.4)", second],
        source: { origin: "browser-agent", requirements: ["3.4", "10.2"] },
    });
const DD_MISSING = "Error: 6. Orders count shown\n\nexpect(locator).toBeVisible() failed\n\nLocator: getByRole('definition', { name: '8' })\nExpected: visible";

describe("2. WEB-038: a role locator's name the cited expectation does not state", () => {
    it("a definition named 8 against 'the user's number of notes and number of orders': an incorrect expectation, never Confirmed", async () => {
        const spec = web038("The dashboard shows the user's number of notes and number of orders (requirement 10.2)");
        const { r } = await verify(spec, run(spec, 6, DD_MISSING), run(spec, 6, DD_MISSING));
        expect(r.state).not.toBe("confirmed");
        expect(r.findingClass).toBe("incorrect_expectation");
    });
    it("the same check against an expectation that states 8 is still the application's, Confirmed", async () => {
        const spec = web038("The dashboard shows Orders 8 (requirement 10.2)");
        const { r } = await verify(spec, run(spec, 6, DD_MISSING), run(spec, 6, DD_MISSING));
        expect(r.findingClass).toBe("app_defect");
        expect(r.state).toBe("confirmed");
    });
});

// ── 3. WEB-027 ──
const address = (open: string, want: string, cited: string, reqs: string[]) =>
    TestSpecSchema.parse({
        testId: "WEB-027",
        title: "Opening /spa/ lands on the notes dashboard",
        kind: "web",
        category: "Notes SPA",
        type: "navigation",
        priority: "medium",
        steps: [{ action: "navigate", url: open }, ...sign, { action: "assert", check: "url", expected: want, source: "expected:1", description: "Address bar should show the dashboard hash route" }],
        expectedResults: [cited, "The Dashboard heading is visible"],
        source: { origin: "browser-agent", requirements: reqs },
    });
const URL_FAILED = (want: string, got: string) => `Error: expect(page).toHaveURL(expected) failed\n\nExpected pattern: /${want}/i\nReceived string:  "http://127.0.0.1:8351${got}"\nTimeout: 8000ms`;

describe("3. WEB-027: an address check is judged against the requirement it cites", () => {
    it("/spa/#/dashboard, which requirement 10.1 does not state: an incorrect expectation, never Confirmed", async () => {
        const spec = address("/spa/", "/spa/#/dashboard", "The address bar shows /spa/#/dashboard (requirement 10.1)", ["10.1"]);
        const fail = run(spec, 5, URL_FAILED("\\/spa\\/#\\/dashboard", "/spa/"));
        const { r } = await verify(spec, fail, fail);
        expect(r.state).not.toBe("confirmed");
        expect(r.findingClass).toBe("incorrect_expectation");
    });
    it("the same check when the requirement does state the address is Confirmed", async () => {
        const spec = address("/spa/", "/spa/#/dashboard", "The address bar shows /spa/#/dashboard (requirement 10.1)", ["10.1"]);
        const fail = run(spec, 5, URL_FAILED("\\/spa\\/#\\/dashboard", "/spa/"));
        const { r } = await verify(spec, fail, fail, { ...REQS, "10.1": "Opening /spa/ must change the address to /spa/#/dashboard." });
        expect(r.findingClass).toBe("app_defect");
        expect(r.state).toBe("confirmed");
    });
    it("an address the test itself sent in ?next= is stated by the test (requirement 3.4 names no page): Confirmed", async () => {
        const spec = address("/login?next=%2Forders", "/orders", "The browser opens /orders, the page named in next (requirement 3.4)", ["3.4"]);
        const fail = run(spec, 5, URL_FAILED("\\/orders", "/account"));
        const { r } = await verify(spec, fail, fail);
        expect(r.findingClass).toBe("app_defect");
        expect(r.state).toBe("confirmed");
    });
});
