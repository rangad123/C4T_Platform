/**
 * The verdict of a failed web run, with real runs: the real validator runs the rendered scripts under Playwright against fixture pages,
 * and a scripted model (never a real one) always blames the application.
 *   - a sign-in page whose ad script loads reCAPTCHA's hidden frame, with blocked stylesheets and console errors, and a step whose field
 *     is ambiguous: the test needs fixing (no captcha, no finding, no severity), for a generated test and for a code test;
 *   - a page that shows a reCAPTCHA widget: the captcha sentence, saying where it was seen, with no severity;
 *   - a check of what the page shows that fails: still a finding, with its severity.
 * Port 9850. Runs a browser: node scripts/with-lock.mjs browser -- npx vitest run tests/captcha-verdict.test.ts
 */
import http from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { detectCaptcha } from "../src/engine/auth/captcha.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { localExecutor, renderWithAdapter, type ScriptExecutor } from "../src/engine/frameworks/index.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { validateBatch, type ValidationOutcome } from "../src/engine/validation/validator.js";

const PORT = 9850;
const FIX = `http://127.0.0.1:${PORT}`;
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

// As on the reported site: two forms whose email fields have only placeholders, a stylesheet the browser blocks, a console error, and
// an ad script that adds reCAPTCHA's ad-quality frame (0x0, hidden). No captcha is shown anywhere.
const LOGIN = page(
    "Login",
    `<link rel="stylesheet" href="http://127.0.0.1:1/css?family=Roboto">
<h1>Login to your account</h1>
<form name="login" action="/login"><input type="email" placeholder="Email Address"><input type="password" placeholder="Password"><button>Login</button></form>
<h2>New User Signup!</h2>
<form name="signup" action="/signup"><input type="text" placeholder="Name"><input type="email" placeholder="Email Address"><button>Signup</button></form>
<script>console.error("Mixed Content: an insecure stylesheet was blocked");
var f = document.createElement("iframe"); f.src = "/recaptcha/api2/aframe"; f.width = "0"; f.height = "0"; f.style.display = "none"; document.body.appendChild(f);</script>`,
);
// A form with a reCAPTCHA box as the widget draws it (304x78).
const CONTACT = page("Contact", `<h1>Contact us</h1><form id="contact"><textarea></textarea><div class="g-recaptcha" data-sitekey="test" style="width:304px;height:78px"></div><button>Send</button></form>`);
const CART = page("Cart", `<h1>Cart</h1><p id="msg">2 items</p>`);

let server: http.Server;
let browser: Browser;
const config = loadConfig({ LLM_DETERMINISTIC_REPAIR: "false" });

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", FIX).pathname;
        const body = p === "/login" ? LOGIN : p === "/contact" ? CONTACT : p === "/cart" ? CART : p === "/recaptcha/api2/aframe" ? "<!doctype html><title>a</title>" : undefined;
        res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
        res.end(body ?? "not found");
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 60_000);

afterAll(async () => {
    await browser?.close().catch(() => undefined);
    server?.close();
});

const emptyModel: AppModel = {
    url: FIX, origin: FIX, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};

/** A model that always blames the application: what it says must never turn a broken step into a finding. */
const blamesTheApp: LlmClient = {
    modelName: "scripted",
    model: {} as never,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async () => ({ category: "app_defect", fixable: false, reason: "The scripted model blames the application." })) as LlmClient["object"],
};

let n = 0;
const spec = (title: string, steps: unknown[]): TestSpec =>
    TestSpecSchema.parse({ testId: `WEB-${String(++n).padStart(3, "0")}`, title, kind: "web", priority: "medium", category: "Shop", source: { origin: "browser-agent" }, steps });
const scenario = ScenarioSchema.parse({ scenarioId: "S-1", title: "Use the shop", description: "Use the shop", category: "Shop", expectedResults: ["It works"] });

describe("the verdict of a failed web run", () => {
    it("a broken step is the test's to fix; only a shown captcha is a captcha; a failing check stays a finding", async () => {
        const login = spec("Login with correct username and password", [
            { action: "navigate", url: "/login" },
            { action: "fill", locator: { by: "label", value: "Email" }, value: "someone@example.com" },
            { action: "assert", check: "visible", expected: "Logged in as" },
        ]);
        const asCode = { ...login, testId: "WEB-900", title: "Login (code test)" };
        const contact = spec("Contact form", [{ action: "navigate", url: "/contact" }, { action: "assert", check: "visible", expected: "Message sent" }]);
        const cart = spec("Cart count", [{ action: "navigate", url: "/cart" }, { action: "assert", check: "text", locator: { by: "css", value: "#msg" }, expected: "3 items" }]);
        const code = renderWithAdapter(asCode, "playwright", { baseUrl: FIX });
        const ctx: EngineContext = { config, llm: blamesTheApp, emit: () => undefined };
        // This machine agrees to run code tests (as a runner started with --allow-custom-scripts does).
        const executor: ScriptExecutor = { name: "local", execute: (id, batch, env, opts) => localExecutor.execute(id, batch, env, { ...opts, allowCustom: true }) };
        const outcomes: ValidationOutcome[] = await validateBatch(
            ctx,
            { browser, scratchDir: config.scratchDir, env: { baseUrl: FIX, headless: true }, render: { baseUrl: FIX }, model: emptyModel, maxRepairAttempts: 1, workers: 2, executor },
            [
                { spec: login, framework: "playwright", scenario },
                { spec: asCode, framework: "playwright", custom: { filename: code.filename, content: code.content } },
                { spec: contact, framework: "playwright", scenario },
                { spec: cart, framework: "playwright", scenario },
            ],
            { async onAttempt() {}, async onFinal() {} },
        );
        const by = (s: TestSpec) => outcomes.find((o) => o.spec.testId === s.testId)!;

        for (const s of [login, asCode]) {
            const o = by(s);
            expect(o.status, `${s.testId}: ${o.reason}`).toBe("FAILED_VALIDATION");
            expect(o.reason).toMatch(/^The test needs fixing, not your application: Step 2 .*No field labelled "Email"/);
            expect(o.reason).not.toMatch(/captcha|Mixed Content/i);
            expect(assessSeverity(o.spec, o.status, o.reason)).toBeUndefined();
        }

        const c = by(contact);
        expect(c.status).toBe("NEEDS_REVIEW");
        expect(c.reason).toBe('This page has a captcha (reCAPTCHA) at /contact; use a saved session or ask the site to turn it off for tests. Seen: a visible reCAPTCHA widget (304×78) inside the form "contact".');
        expect(assessSeverity(c.spec, c.status, c.reason)).toBeUndefined();

        const f = by(cart);
        expect(f.status, f.reason).toBe("NEEDS_REVIEW");
        expect(assessSeverity(f.spec, f.status, f.reason)).toEqual({ severity: "medium", basis: "defect on a medium-priority journey" });
    }, 240_000);

    it("a live page: a hidden frame an ad script loaded is no captcha, a shown widget is", async () => {
        const p = await browser.newPage();
        try {
            await p.goto(`${FIX}/login`);
            await p.waitForFunction(() => document.querySelector("iframe") !== null);
            expect(await detectCaptcha(p)).toBeUndefined();
            await p.goto(`${FIX}/contact`);
            expect(await detectCaptcha(p)).toBe("reCAPTCHA");
        } finally {
            await p.close();
        }
    }, 60_000);
});
