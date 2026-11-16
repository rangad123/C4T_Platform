/**
 * Who is at fault in a failed web run, without a browser: the test's own step (element not found, several match, the field-by-label
 * sentence, a timeout waiting for the element) is a test to fix with no severity; a captcha counts only when the evidence says a person
 * could see its widget (an ad script loading reCAPTCHA's hidden frame does not); blocked third-party fonts and console errors never decide.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { testStepFault } from "../src/engine/validation/test-fault.js";
import { classifyFailedRun } from "../src/engine/validation/validator.js";

const LABEL_SENTENCE =
    'Error: No field labelled "Email", and 2 fields have a placeholder that starts with it ("Email Address" in the login and signup forms), so the step does not pick one. Point the step at one field, for example inside its form or by its placeholder. Fields on this page: "Email Address" (textbox, 2 fields: login and signup), "Name" (textbox).';

const spec = TestSpecSchema.parse({
    testId: "WEB-001",
    title: "Login with correct username and password",
    kind: "web",
    priority: "medium",
    source: { origin: "browser-agent" },
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "assert", check: "visible", expected: "Logged in as" },
    ],
});

function evidenceFile(extra: Record<string, unknown> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-"));
    const file = path.join(dir, "evidence.json");
    // The page's own noise: blocked http stylesheets of fonts.googleapis.com, and ad scripts that load reCAPTCHA's hidden frame.
    fs.writeFileSync(
        file,
        JSON.stringify({
            v: 1,
            durationMs: 4000,
            counts: { requests: 5, requestsKept: 5, console: 2, consoleKept: 2 },
            steps: [{ n: 1, t: 0 }, { n: 2, t: 2300 }],
            requests: [
                { t: 10, step: 1, method: "GET", type: "document", path: "/login", status: 200 },
                { t: 20, step: 1, method: "GET", type: "stylesheet", host: "fonts.googleapis.com", path: "/css?family=Roboto", failed: "net::ERR_BLOCKED_BY_CLIENT" },
                { t: 30, step: 2, method: "GET", type: "script", host: "pagead2.googlesyndication.com", path: "/pagead/js/adsbygoogle.js", status: 200 },
                { t: 40, step: 2, method: "GET", type: "script", host: "ep2.adtrafficquality.google", path: "/sodar/sodar2.js", status: 200 },
                { t: 50, step: 2, method: "GET", type: "document", host: "www.google.com", path: "/recaptcha/api2/aframe", status: 200 },
            ],
            console: [
                { t: 15, step: 1, type: "error", text: "Mixed Content: The page at 'https://automationexercise.com/login' was loaded over HTTPS, but requested an insecure stylesheet 'http://fonts.googleapis.com/css?family=Roboto'. This request has been blocked; the content must be served over HTTPS." },
                { t: 16, step: 1, type: "error", text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT" },
            ],
            ...extra,
        }),
    );
    return file;
}

const run = (error: string, evidence: string, at = 1, title = "Type “your test username” into the “Email” field"): ScriptRun => ({
    testId: "WEB-001",
    status: "failed",
    durationMs: 4000,
    failedStepIndex: at,
    steps: [
        { index: 0, title: "Open /login", status: "passed" },
        { index: at, title, status: "failed", error },
    ],
    artifacts: [{ kind: "evidence", path: evidence }],
    responses: [],
});

describe("the reported run: a locator failure on a page whose ads load a hidden reCAPTCHA frame", () => {
    const r = run(LABEL_SENTENCE, evidenceFile());

    it("is not a captcha and is not decided as a finding without a repair", () => {
        expect(classifyFailedRun(spec, r)).toBeUndefined();
    });

    it("is the test's own step: says so and what to change", () => {
        const why = testStepFault(r, spec.steps[1]);
        expect(why).toMatch(/^The test needs fixing, not your application: Step 2 \(Type “your test username” into the “Email” field\) could not use its element\. No field labelled "Email"/);
        expect(why).toContain("Point the step at one field");
        expect(why).not.toMatch(/captcha|Mixed Content|fonts\.googleapis/i);
    });

    it("gets no severity as a broken test", () => {
        expect(assessSeverity(spec, "FAILED_VALIDATION", testStepFault(r, spec.steps[1]))).toBeUndefined();
    });
});

describe("a captcha counts only when its widget was seen", () => {
    it("a visible reCAPTCHA widget in the login form is named, with where it was seen, and has no severity", () => {
        const seen = run(LABEL_SENTENCE, evidenceFile({ captcha: { kind: "reCAPTCHA", w: 304, h: 78, inForm: true, form: "login", path: "/login" } }));
        const c = classifyFailedRun(spec, seen);
        expect(c).toEqual({
            status: "NEEDS_REVIEW",
            reason: 'This page has a captcha (reCAPTCHA) at /login; use a saved session or ask the site to turn it off for tests. Seen: a visible reCAPTCHA widget (304×78) inside the form "login".',
        });
        // A captcha needs a person but is not a defect of the application: no severity.
        expect(assessSeverity(spec, c!.status, c!.reason)).toBeUndefined();
    });

    it("malformed captcha evidence is ignored", () => {
        expect(classifyFailedRun(spec, run(LABEL_SENTENCE, evidenceFile({ captcha: { kind: "Something", w: 1, h: 1, path: "/" } })))).toBeUndefined();
    });
});

describe("only the test's own step is a test fault", () => {
    const ev = evidenceFile();

    it("an action that timed out waiting for its element, and several elements matching, are faults of the test", () => {
        const timeout = run("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Log in' })", ev);
        expect(testStepFault(timeout, { action: "click", locator: { by: "role", role: "button", value: "Log in" } } as never)).toMatch(/^The test needs fixing.*Check that the element is on the page/);
        const strict = run("Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Welcome')\nError: strict mode violation: getByText('Welcome') resolved to 2 elements", ev, 2, "Check “Welcome” is shown");
        expect(testStepFault(strict, spec.steps[2])).toMatch(/Several elements match/);
        // A code test (no stored step): judged from the error alone.
        expect(testStepFault(timeout)).toMatch(/^The test needs fixing/);
    });

    it("a check of what the application shows that fails is not a test fault, and stays a finding with its severity", () => {
        const assertion = run("Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Logged in as')\nExpected: visible\nReceived: <element(s) not found>\nCall log:\n  - waiting for getByText('Logged in as')", ev, 2, "Check “Logged in as” is shown");
        expect(testStepFault(assertion, spec.steps[2])).toBeUndefined();
        expect(testStepFault(assertion)).toBeUndefined();
        const text = run("Error: expect(locator).toHaveText(expected) failed\n\nExpected: \"3 items\"\nReceived: \"2 items\"", ev, 2, "Check the cart");
        expect(testStepFault(text, spec.steps[2])).toBeUndefined();
        expect(assessSeverity(spec, "NEEDS_REVIEW", "The application did not behave as expected: the cart shows 2 items")).toEqual({ severity: "medium", basis: "defect on a medium-priority journey" });
    });

    it("a passing run or an error with no element in it is not a test fault", () => {
        expect(testStepFault({ ...run(LABEL_SENTENCE, ev), status: "passed" })).toBeUndefined();
        expect(testStepFault(run("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/", ev, 0, "Open /login"))).toBeUndefined();
    });
});
