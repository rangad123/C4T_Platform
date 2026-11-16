/**
 * A step that types into a field by its label, on a page whose fields have no label, only a placeholder: the pattern of many practice
 * and shop sites (a login form and a signup form side by side, each with an "Email Address" placeholder, plus a newsletter field).
 * Without a match the step used to wait out the 10 s action timeout on getByLabel. Now (web/label-fallback.ts): the one field whose
 * placeholder starts with the label is used; two such fields fail at once with a sentence naming what the page has; a real label still
 * wins. Two such fields in two forms: the one in the form that also holds the test's next steps (its "Password" field, its "Login" button)
 * is used; with no such clue, or clues pointing at both forms, the step still fails with the sentence. The rendered script and the live
 * interpreter behave the same, and the saved sign-in is what gets typed.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts, type RunEnv, type ScriptInput } from "../src/engine/validation/runner.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { nearbyTargets } from "../src/engine/web/label-fallback.js";

const PORT = 9840;
const BASE = `http://127.0.0.1:${PORT}`;
const SAVED = { username: "ada@shop.example", password: "Saved-Pw-41c9" };

// The real markup pattern: unlabelled inputs with placeholders and data-qa attributes, two "Email Address" fields in two forms.
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><title>Login</title></head><body>
<div class="login-form"><h2>Login to your account</h2><form action="/login" method="POST">
<input type="hidden" name="csrf" value="x">
<input type="email" data-qa="login-email" placeholder="Email Address" name="email" required />
<input type="password" data-qa="login-password" placeholder="Password" name="password" required />
<button type="submit" data-qa="login-button">Login</button></form></div>
<h2>OR</h2>
<div class="signup-form"><h2>New User Signup!</h2><form action="/signup" method="POST">
<input type="text" data-qa="signup-name" placeholder="Name" name="name" required />
<input type="email" data-qa="signup-email" placeholder="Email Address" name="email" required />
<button type="submit" data-qa="signup-button">Signup</button></form></div>
<iframe title="ad" srcdoc="<input placeholder='Email Address'>"></iframe>
<footer><form class="searchform" method="POST"><input type="email" id="susbscribe_email" placeholder="Your email address" /></form></footer>
</body></html>`;
// A field with a real label next to a decoy whose placeholder starts with the same word: the label wins.
const LABELLED_PAGE = `<!doctype html><html lang="en"><head><title>Labelled</title></head><body><form action="/labelled" method="POST">
<input placeholder="Email updates" name="decoy"><label for="e">Email</label><input id="e" name="email"></form></body></html>`;

const received: Array<Record<string, string>> = [];
const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", BASE);
    if (req.method === "POST" && (u.pathname === "/login" || u.pathname === "/signup")) {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
            received.push({ form: u.pathname, ...Object.fromEntries(new URLSearchParams(b)) });
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!doctype html><html lang="en"><head><title>Account</title></head><body><p id="who">Logged in</p></body></html>`);
        });
        return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(u.pathname === "/labelled" ? LABELLED_PAGE : LOGIN_PAGE);
});

const spec = (testId: string, steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId, kind: "web", title: "Login with correct username and password", steps: [{ action: "navigate", url: "/login" }, ...steps] });
const script = (t: TestSpec): ScriptInput => {
    const r = renderWithAdapter(t, "playwright", { baseUrl: BASE });
    return { testId: t.testId, filename: r.filename, content: r.content, framework: "playwright" };
};
const env: RunEnv = { baseUrl: BASE, headless: true, credentials: SAVED };
const fill = (locator: Record<string, unknown>, value: string) => ({ action: "fill", locator, value });
const signIn = [fill({ by: "label", value: "Password" }, "{{credentials.password}}"), { action: "click", locator: { by: "role", role: "button", value: "Login" } }, { action: "assert", check: "text", locator: { by: "css", value: "#who" }, expected: "Logged in" }];

const AMBIGUOUS =
    'No field labelled "Email", and 2 fields have a placeholder that starts with it ("Email Address" in the login and signup forms), so the step does not pick one. Point the step at one field, for example inside its form or by its placeholder. ' +
    'Fields on this page: "Email Address" (placeholder, 2 fields: login and signup), "Password" (placeholder), "Name" (placeholder), "Your email address" (placeholder).';

let scratch: string;
let browser: Browser;
beforeAll(async () => {
    fs.mkdirSync(path.join(process.cwd(), ".validation"), { recursive: true });
    scratch = fs.mkdtempSync(path.join(process.cwd(), ".validation", "k-label-"));
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(scratch, { recursive: true, force: true });
});

/** Runs the steps live in the interpreter; the error it ends with, if any. */
async function live(t: TestSpec): Promise<string | undefined> {
    const p = await browser.newPage();
    try {
        const data = runtimeData({}, SAVED);
        for (const [i, step] of t.steps.entries()) await executeStep(p, step, data, BASE, 6_000, { near: nearbyTargets(t.steps, i) });
        return undefined;
    } catch (e) {
        return (e as Error).message;
    } finally {
        await p.close();
    }
}

describe("a label step on a page whose fields have only placeholders", () => {
    it("two fields start with the label: the one in the form that holds the next steps' Password field and Login button gets the saved sign-in", async () => {
        const t = spec("WEB-001", [fill({ by: "label", value: "Email" }, "{{credentials.username}}"), ...signIn]);
        const sent = received.length;
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        expect(received.slice(sent)).toEqual([{ form: "/login", csrf: "x", email: SAVED.username, password: SAVED.password }]);
        expect(await live(t)).toBeUndefined();
        expect(received.slice(sent + 1)).toEqual([{ form: "/login", csrf: "x", email: SAVED.username, password: SAVED.password }]);
    }, 120_000);

    it("the same field next to the Name field and the Signup button goes into the signup form", async () => {
        const t = spec("WEB-006", [fill({ by: "label", value: "Name" }, "Ada"), fill({ by: "label", value: "Email" }, "new@shop.example"), { action: "click", locator: { by: "role", role: "button", value: "Signup" } }]);
        const sent = received.length;
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        expect(received.slice(sent)).toEqual([{ form: "/signup", name: "Ada", email: "new@shop.example" }]);
    }, 120_000);

    it("no neighbouring clue: the step fails at once with what the page has, and nothing is typed or sent", async () => {
        const t = spec("WEB-005", [fill({ by: "label", value: "Email" }, "{{credentials.username}}"), { action: "assert", check: "visible", locator: { by: "text", value: "Login to your account" } }]);
        const sent = received.length;
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status).toBe("failed");
        expect(run!.failedStepIndex).toBe(1);
        expect(run!.error).toContain(AMBIGUOUS);
        // Not the 10 s action timeout on a locator that can never match.
        expect(run!.error).not.toMatch(/Timeout \d+ms exceeded/);
        expect(run!.steps.find((s) => s.index === 1)!.durationMs!).toBeLessThan(5_000);
        expect(await live(t)).toBe(AMBIGUOUS);
        expect(received.length).toBe(sent);
    }, 120_000);

    it("clues that point at both forms (the signup Name field and the Login button): still no guess", async () => {
        const t = spec("WEB-007", [fill({ by: "label", value: "Email" }, "{{credentials.username}}"), fill({ by: "label", value: "Name" }, "Ada"), { action: "click", locator: { by: "role", role: "button", value: "Login" } }]);
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status).toBe("failed");
        expect(run!.error).toContain(AMBIGUOUS);
        expect(await live(t)).toBe(AMBIGUOUS);
    }, 120_000);

    it("no field matches at all: the sentence lists the fields", async () => {
        const t = spec("WEB-002", [fill({ by: "label", value: "Phone" }, "123")]);
        const listed = 'No field labelled "Phone". Fields on this page: "Email Address" (placeholder, 2 fields: login and signup), "Password" (placeholder), "Name" (placeholder), "Your email address" (placeholder).';
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status).toBe("failed");
        expect(run!.error).toContain(listed);
        expect(await live(t)).toBe(listed);
    }, 120_000);

    it("inside the login form (or with a unique placeholder) the one matching field is used, and the saved sign-in is typed", async () => {
        const t = spec("WEB-003", [fill({ by: "label", value: "Email", within: { by: "css", value: "form[action='/login']" } }, "{{credentials.username}}"), ...signIn]);
        const sent = received.length;
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        expect(received.slice(sent)).toEqual([{ form: "/login", csrf: "x", email: SAVED.username, password: SAVED.password }]);
        expect(await live(t)).toBeUndefined();
        expect(received.slice(sent + 1)).toEqual([{ form: "/login", csrf: "x", email: SAVED.username, password: SAVED.password }]);
    }, 120_000);

    it("a real label wins over a placeholder that starts with the same word", async () => {
        const t = TestSpecSchema.parse({ testId: "WEB-004", kind: "web", title: "Labelled", steps: [{ action: "navigate", url: "/labelled" }, fill({ by: "label", value: "Email" }, "x@shop.example"), { action: "assert", check: "value", locator: { by: "css", value: "#e" }, expected: "x@shop.example" }, { action: "assert", check: "value", locator: { by: "css", value: "[name=decoy]" }, expected: "" }] });
        const [run] = await runScripts(scratch, [script(t)], env, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        expect(await live(t)).toBeUndefined();
    }, 120_000);
});
