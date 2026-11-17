/**
 * A sign-in fill lands in the field it names and no other (Phase 3 P3-05; D1 tests WEB-031/033/034, WEB-027/028).
 *
 * The D1 authoring agent often sent the sign-in as several tool calls in one turn (fill Email, fill Password, click Sign in). The AI SDK
 * runs one turn's tool calls at the same time, so two fills ran together on one page: Playwright's fill focuses its field and then types
 * with the page keyboard, and the second fill's focus moved the keyboard before the first one typed. The email went into the Password
 * field ("the Password field showed the email and the password together", Email empty), the sign-in did not happen, and the agent's
 * retries and checks of the half-filled form were saved; replayed, the first sign-in works and those leftover steps fail on the clean app.
 * Now executeStep (web/interpreter.ts) runs the steps of one page one at a time, in the order they were started.
 *
 * The fixture page has a sign-in form and a profile form with the same kind of fields ("Email" in both, "Name"); the steps pick the
 * sign-in form's fields by their exact labels.
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { ScenarioSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { nearbyTargets } from "../src/engine/web/label-fallback.js";

const PORT = 9873;
const BASE = `http://127.0.0.1:${PORT}`;
const CREDS = { username: "alice@example.test", password: "Password1!" };

// A sign-in form beside a profile form whose fields read alike: "Email" in both, a Name, an address.
const PAGE = `<!doctype html><html lang="en"><head><title>Sign in</title></head><body><h1>Sign in</h1>
<form method="post" action="/login"><label>Email <input name="email" type="email" required></label>
<label>Password <input name="password" type="password" required></label><button type="submit">Sign in</button></form>
<h2>Profile</h2><form method="post" action="/profile"><label>Name <input name="name" value="Alice Moreau"></label>
<label>Contact email <input name="contact" type="email" value="alice.contact@example.test"></label>
<label>Default delivery address <textarea name="address">12 Harbour Street, Leeds</textarea></label><button type="submit">Save</button></form>
</body></html>`;

const logins: Array<Record<string, string>> = [];
const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/login") {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
            const f = Object.fromEntries(new URLSearchParams(b));
            logins.push(f);
            const ok = f.email === CREDS.username && f.password === CREDS.password;
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!doctype html><html lang="en"><head><title>${ok ? "Account" : "Sign in"}</title></head><body><h1>${ok ? "Your account" : "Email or password is wrong."}</h1></body></html>`);
        });
        return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
});

let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server.close();
});

const signIn: Step[] = [
    { action: "navigate", url: "/", description: "Open the sign-in page" },
    { action: "fill", locator: { by: "label", value: "Email", exact: true }, value: "{{credentials.username}}", description: "Enter the email" },
    { action: "fill", locator: { by: "label", value: "Password", exact: true }, value: "{{credentials.password}}", description: "Enter the password" },
];
const fieldValues = (page: import("playwright").Page) =>
    page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("input, textarea")).map((el) => [(el as HTMLInputElement).name, (el as HTMLInputElement).value])));
const untouchedProfile = { name: "Alice Moreau", contact: "alice.contact@example.test", address: "12 Harbour Street, Leeds" };

describe("a sign-in fill lands in its own field", () => {
    it("two fills started together on one page each fill the field they name and no other", async () => {
        for (let round = 0; round < 5; round++) {
            const context = await browser.newContext();
            const page = await context.newPage();
            try {
                const data = runtimeData({}, CREDS);
                await executeStep(page, signIn[0]!, data, BASE);
                // As the AI SDK runs the tool calls of one model turn: both at once.
                await Promise.all([1, 2].map((i) => executeStep(page, signIn[i]!, data, BASE, 6_000, { near: nearbyTargets(signIn, i) })));
                expect(await fieldValues(page)).toEqual({ email: CREDS.username, password: CREDS.password, ...untouchedProfile });
            } finally {
                await context.close();
            }
        }
    }, 60_000);

    it("a sign-in the agent sends as one turn signs in while authoring, and the saved steps replay the same", async () => {
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        const call = (id: string, toolName: string, input: unknown) => ({ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) });
        // One turn with the whole sign-in (as Haiku sent it in the D1 run), then the outcome check and the finish.
        const turns = [
            [
                call("a", "fill", { target: { by: "label", value: "Email", exact: true }, value: "{{credentials.username}}" }),
                call("b", "fill", { target: { by: "label", value: "Password", exact: true }, value: "{{credentials.password}}" }),
            ],
            [call("c", "click", { target: { by: "role", role: "button", value: "Sign in", exact: true } })],
            [call("d", "assert", { check: "visible", target: { by: "role", role: "heading", value: "Your account", exact: true } })],
            [call("e", "finish", { result: "complete", explanation: "Signed in" })],
        ];
        let turn = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                const content = turns[turn++];
                if (!content) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
                return { content, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
            },
        });
        const ctx: EngineContext = {
            config: loadConfig({}),
            emit: () => undefined,
            llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "OK" },
        };
        const appModel: AppModel = {
            url: BASE, origin: BASE, siteType: "other", purpose: "fixture", features: [], pages: [], navigation: [], apis: [], journeys: [],
            authentication: { required: true, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
            stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
        };
        const scenario = ScenarioSchema.parse({ scenarioId: "S-900", title: "Sign in", description: "Sign in with the test account", category: "Authentication", startPath: "/", expectedResults: ["The account page shows"], requiresAuth: true });
        logins.length = 0;
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: appModel, scenario, credentials: CREDS });
        expect(out.status).toBe("complete");
        // Every sign-in the session sent (authoring, and the clean replay that prunes stale steps) carried each value in its own field.
        expect(logins.length).toBeGreaterThan(0);
        for (const l of logins) expect(l).toEqual({ email: CREDS.username, password: CREDS.password });
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert"]);

        // The saved steps, replayed in a fresh browser: each fill fills the field it names and no other.
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            const data = runtimeData({}, CREDS);
            for (const [i, s] of out.steps.slice(0, 3).entries()) await executeStep(page, s, data, BASE, 6_000, { near: nearbyTargets(out.steps, i) });
            expect(await fieldValues(page)).toEqual({ email: CREDS.username, password: CREDS.password, ...untouchedProfile });
        } finally {
            await context.close();
        }
    }, 90_000);
});
