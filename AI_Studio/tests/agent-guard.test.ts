/**
 * Agent runs, with a real Chromium and a scripted model (never a real provider): the address guard for every request, frame and redirect hop;
 * a run that leaves its site; stored sign-in details in a frame from another site; one action at a time; what a person approves; page text
 * kept inside the fence. The review's proof script poc2-redirect is the first test.
 *
 * Ports 7990-7992. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-guard.test.ts
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { pursueObjective, type ApprovalRequest, type ObjectiveWatch } from "../src/engine/agent/objective.js";
import { GuardProxy, PRIVATE_ADDRESS_REFUSED } from "../src/engine/discovery/guard-proxy.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { CREDENTIAL_ORIGIN_RULE } from "../src/engine/spec/credential-origin.js";

const OWN = 7990;
const OTHER = 7991;
const SITE = `http://127.0.0.1:${OWN}`;
const OTHER_SITE = `http://localhost:${OTHER}`;

const html = (body: string) => `<!doctype html><html><head><title>Guard site</title></head><body>${body}</body></html>`;
const otherHits: string[] = [];
const own = http.createServer((req, res) => {
    if (req.url === "/out") {
        res.writeHead(302, { location: `${OTHER_SITE}/landing` });
        return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/frames") return res.end(html(`<h1>Own</h1><iframe src="/out" title="hop"></iframe><img src="http://127.0.0.1:${OTHER}/img" alt="x">`));
    if (req.url === "/signin") return res.end(html(`<h1>Sign in</h1><iframe name="login" src="${OTHER_SITE}/login"></iframe>`));
    if (req.url === "/two") return res.end(html(`<h1>Two buttons</h1><button id="go" onclick="document.title='first'"><span>Delete everything</span></button><button onclick="document.title=document.title+'-second'">Next</button>`));
    res.end(html(`<h1>Home</h1><a href="/out">Leave</a><p>A page with nothing to ask.</p>`));
});
const other = http.createServer((req, res) => {
    otherHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html(req.url === "/login" ? `<label>Password <input type="password" name="password"></label>` : `<h1>OTHER-SITE-CONTENT</h1>`));
});

type Call = { tool: string; input: Record<string, unknown> };
const turns: Call[][] = [];
const prompts: string[] = [];
const usage = () => ({ inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } });
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        const calls = turns.shift();
        if (!calls) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(), warnings: [] };
        return { content: calls.map((c) => ({ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: c.tool, input: JSON.stringify(c.input) })), finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage(), warnings: [] };
    },
});
const scripted: LlmClient = { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => ({})) as unknown as LlmClient["object"] };
const finish = (result = "inconclusive"): Call => ({ tool: "finish", input: { result, explanation: "Done" } });
const limits = { maxSteps: 6, maxMinutes: 1, maxTokens: 100_000, approvalSeconds: 5 };
const ctx = () => ({ config: loadConfig({}), llm: scripted, emit: () => undefined }) as never;
const watch = (answer: (r: ApprovalRequest) => Promise<"approved" | "refused"> = async () => "refused"): ObjectiveWatch & { steps: any[]; asked: ApprovalRequest[] } => {
    const steps: any[] = [];
    const asked: ApprovalRequest[] = [];
    return { steps, asked, step: async (s) => void steps.push(s), askApproval: async (r) => (asked.push(r), answer(r)), stopRequested: async () => false };
};

let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => own.listen(OWN, "127.0.0.1", r));
    await new Promise<void>((r) => other.listen(OTHER, "127.0.0.1", r));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => own.close(r));
    await new Promise((r) => other.close(r));
});
beforeEach(() => {
    turns.length = 0;
    prompts.length = 0;
    otherHits.length = 0;
});

describe("the address guard (poc2-redirect)", () => {
    it("refuses a private address on a redirect hop, in a frame and for an image; the private server is never reached", async () => {
        // The own site stands in for a public one; the other port is the private target.
        const guard = await GuardProxy.start({ trust: [`127.0.0.1:${OWN}`] });
        const context = await browser.newContext({ proxy: { server: guard.address, bypass: "<-loopback>" } });
        try {
            const page = await context.newPage();
            await page.goto(`${SITE}/out`).catch(() => undefined);
            expect(await page.textContent("body")).toContain(PRIVATE_ADDRESS_REFUSED);
            await page.goto(`${SITE}/frames`);
            await page.waitForTimeout(500);
            expect(await page.frames()[1]!.textContent("body")).toContain(PRIVATE_ADDRESS_REFUSED);
            expect(otherHits).toEqual([]);
            expect(guard.refused.length).toBeGreaterThanOrEqual(3);
        } finally {
            await context.close();
            await guard.close();
        }
    }, 60_000);
});

describe("a run", () => {
    it("stops when the page leaves the application's own site, and keeps nothing from there", async () => {
        turns.push([{ tool: "click", input: { target: { by: "role", role: "link", value: "Leave" } } }], [finish("passed")]);
        const w = watch();
        const out = await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/`, objective: "Look around the site", limits, secrets: [], watch: w });
        expect(out).toMatchObject({ state: "stopped", verdict: "inconclusive", failureCategory: "environment" });
        expect(out.stopReason).toContain("left the application's own site");
        expect(out.steps.map((s) => s.action)).toEqual(["navigate"]);
        expect(prompts.join("\n")).not.toContain("OTHER-SITE-CONTENT");
    }, 60_000);

    it("never types stored sign-in details into a frame from another site", async () => {
        const password = "frame-secret-pw-77";
        turns.push([{ tool: "fill", input: { target: { by: "label", value: "Password", frame: [{ by: "name", value: "login" }] }, value: "{{credentials.password}}" } }], [finish()]);
        const w = watch();
        await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/signin`, objective: "Sign in", limits, secrets: [password], credentials: { username: "u@x.example", password }, watch: w });
        const refused = w.steps.find((s) => s.tool === "fill");
        expect(refused?.status).toBe("refused");
        expect(refused?.detail).toContain(CREDENTIAL_ORIGIN_RULE);
    }, 60_000);

    it("does one action at a time, and a person sees what the page really shows beside the model's words", async () => {
        // One turn with two tool calls: the first waits for a person, the second must not run meanwhile.
        turns.push([{ tool: "click", input: { target: { by: "css", value: "#go" }, why: "Open the next page" } }, { tool: "click", input: { target: { by: "role", role: "button", value: "Next" } } }], [finish()]);
        const w = watch(async () => {
            await new Promise((r) => setTimeout(r, 400));
            return "approved";
        });
        await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/two`, objective: "Press the buttons", limits, secrets: [], watch: w });
        expect(w.asked).toHaveLength(1);
        expect(w.asked[0]!.action).toContain("On the page: “Delete everything”");
        const clicks = w.steps.filter((s) => s.tool === "click");
        expect(clicks.map((s) => s.summary)).toEqual([expect.stringContaining("Open the next page"), expect.stringContaining("Next")]);
        // The page's own text and address reach the model only inside the fence.
        const later = prompts[1]!;
        expect(later).not.toMatch(/\\"url\\":/);
        expect(later).toMatch(/PAGE-CONTENT [0-9a-f]+>>>\\nAddress: /);
    }, 60_000);
});

describe("an element that is not there", () => {
    it("fails the step without asking a person, and nothing is clicked", async () => {
        turns.push([{ tool: "click", input: { target: { by: "role", role: "button", value: "No such button" } } }], [finish()]);
        const w = watch();
        await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/`, objective: "Look around the site", limits, secrets: [], watch: w });
        expect(w.asked).toHaveLength(0);
        expect(w.steps.find((s) => s.tool === "click")).toMatchObject({ status: "failed", detail: expect.stringContaining("nothing was done") });
    }, 60_000);
});

describe("a browser session with BLOCK_PRIVATE_TARGETS on", () => {
    it("really goes through the guard: loopback does not go around it, and the guard closes with the session", async () => {
        const { BrowserSession } = await import("../src/engine/discovery/browser.js");
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const session = await BrowserSession.launch(browser, { startUrl: SITE });
            expect(session.guard).toBeDefined();
            await session.page.goto(`${SITE}/`);
            expect(await session.page.textContent("body")).toContain(PRIVATE_ADDRESS_REFUSED);
            const refused = [...session.guard!.refused];
            await session.close();
            expect(refused).toContain(`127.0.0.1:${OWN}`);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
        const off = await BrowserSession.launch(browser, { startUrl: SITE });
        expect(off.guard).toBeUndefined();
        await off.close();
    }, 60_000);
});
