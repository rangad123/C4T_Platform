/**
 * The Agent runs page in a real browser, with a real worker, a local site and a scripted model: no Planned card remains; the form starts a run; the live
 * view shows steps and the approval prompt; Approve and Stop work; the result labels the reasoning a suggestion and turns the run into a draft test; what
 * the page says where runs cannot start; accessibility; a phone-sized screen.
 * Needs web/dist (build it first, inside the lock). Runs a browser:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-runs-ui.test.ts
 * Ports: platform 7854, site 7855.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { AGENT_USER, startAgentSite, type AgentSite } from "./fixtures/agent-site.js";

const PORT = 7854;
const SITE_PORT = 7855;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

type Call = { tool: string; input: Record<string, unknown> } | { hang: true };
const queue: Call[] = [];
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        const next = queue.shift();
        if (next && "hang" in next) {
            await new Promise((_, reject) => {
                const stop = () => reject(new DOMException("aborted", "AbortError"));
                if (options.abortSignal?.aborted) stop();
                options.abortSignal?.addEventListener("abort", stop);
            });
        }
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        const call = next as Exclude<Call, { hang: true }>;
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: call.tool, input: JSON.stringify(call.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => ({})) as unknown as LlmClient["object"] };
const click = (role: string, value: string): Call => ({ tool: "click", input: { target: { by: "role", role, value } } });
const fill = (label: string, value: string): Call => ({ tool: "fill", input: { target: { by: "label", value: label }, value } });
const SIGN_IN: Call[] = [click("link", "Sign in"), fill("Email", "{{credentials.username}}"), fill("Password", "{{credentials.password}}"), click("button", "Sign in")];

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let site: AgentSite;
let dataDir: string;
let projectId: string;

const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(BASE + url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return res.json() as Promise<any>;
};
const startRun = async (objective: string) => {
    await page.getByLabel("Objective").fill(objective);
    await page.getByRole("button", { name: "Start agent run" }).click();
    const refused = page.getByText("The run did not start");
    await pwExpect(page.getByRole("heading", { name: objective }).or(refused)).toBeVisible();
    if (await refused.isVisible()) throw new Error(`Refused: ${await page.getByRole("form", { name: "Start an agent run" }).innerText()}`);
};
const openIndex = async () => {
    await page.goto(`${BASE}/#/projects/${projectId}/agent`);
    await pwExpect(page.getByRole("form", { name: "Start an agent run" })).toBeVisible();
};
/** The worker finishes the job just after the run: a next run waits for that. */
const noActiveJob = async () => {
    for (let i = 0; i < 200; i++) {
        const active = platform.db.all("SELECT id FROM generation_jobs WHERE project_id = ? AND status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED')", projectId);
        if (active.length === 0) return;
        await new Promise((d) => setTimeout(d, 50));
    }
    throw new Error("a job is still active");
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startAgentSite(SITE_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, AGENT_RUNS_ON_SERVER: "true", SECRET_KEY: "agent-runs-ui-secret-key-01234567", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", LLM_PROVIDER: "anthropic" }));
    platform.llm = scripted;
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
    projectId = (await api("POST", "/api/projects", { name: "Agent shop" })).id;
    const imported = await api("POST", `/api/projects/${projectId}/specs`, { baseUrl: SITE, validate: false, credentials: { username: AGENT_USER.email, password: AGENT_USER.password }, specs: [{ testId: "WEB-001", title: "Home shows the shop", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Agent Shop" }] }] });
    expect(imported.jobId ?? imported).toBeTruthy();
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
}, 120_000);

afterAll(async () => {
    await worker?.stop();
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await site?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
    queue.length = 0;
});

describe("the agent runs page", () => {
    it("has the form and an empty list, and no Planned card", async () => {
        await openIndex();
        await pwExpect(page.getByText("No agent runs yet")).toBeVisible();
        await pwExpect(page.getByText("They cannot go to a runner yet.")).toBeVisible();
        expect(await page.locator("[data-testid=planned-agent-runs]").count()).toBe(0);
        await pwExpect(page.getByText("Phase 5")).toHaveCount(0);
    });

    it("runs an objective: live steps, the approval prompt, Approve, then the result, with the reasoning a suggestion", async () => {
        queue.push(...SIGN_IN, click("button", "Delete account"), { tool: "assert", input: { check: "visible", expected: "Your account is gone." } }, { tool: "finish", input: { result: "passed", explanation: "The account page said it was gone." } });
        await startRun("A customer can delete their own account");
        const prompt = page.getByTestId("agent-approval");
        await pwExpect(prompt.getByText("The agent is waiting for your approval")).toBeVisible({ timeout: 30_000 });
        await pwExpect(prompt.getByRole("strong")).toContainText("Delete account");
        // What the page really shows, beside the model's words.
        await pwExpect(prompt.getByTestId("agent-approval-element")).toContainText("“Delete account”");
        await pwExpect(prompt).toContainText("at most 10 minutes");
        await pwExpect(prompt.getByText(/deletes or ends something/)).toBeVisible();
        await pwExpect(page.getByRole("img", { name: /The page after step/ })).toBeVisible();
        expect(site.deleted).toBe(0);
        await prompt.getByRole("button", { name: "Approve" }).click();
        await pwExpect(page.getByRole("heading", { name: "Result: Passed" })).toBeVisible({ timeout: 30_000 });
        expect(site.deleted).toBe(1);
        await pwExpect(page.getByText("AI suggestion")).toBeVisible();
        await pwExpect(page.getByText("Nobody has confirmed it.")).toBeVisible();
        await pwExpect(page.getByText("The account page said it was gone.")).toBeVisible();
        await pwExpect(page.getByText(/AI usage: \d+ tokens/)).toBeVisible();
        await pwExpect(page.getByRole("list").filter({ hasText: "Sign in" }).first()).toBeVisible();
        await pwExpect(page.getByText(/Approved/)).toBeVisible();
    }, 90_000);

    it("turns the finished run into a draft test and opens it", async () => {
        await page.getByRole("button", { name: "Turn into a draft test" }).click();
        const open = page.getByRole("link", { name: "Open the draft test" });
        await pwExpect(open).toBeVisible();
        await open.click();
        await pwExpect(page).toHaveURL(/#\/tests\//);
        await noActiveJob();
    }, 30_000);

    it("Stop ends a running agent, and the list shows it", async () => {
        await openIndex();
        queue.push({ hang: true });
        await startRun("A customer can reach the shop and stay there");
        await pwExpect(page.getByText("Steps", { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "What the agent sees" })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "Stop" }).click();
        await pwExpect(page.getByRole("heading", { name: "Result: Stopped, inconclusive" })).toBeVisible({ timeout: 30_000 });
        await pwExpect(page.getByText("A person stopped this run.")).toBeVisible();
        await noActiveJob();
        await page.getByRole("link", { name: "All agent runs" }).click();
        const list = page.getByRole("list", { name: "Agent runs" });
        await pwExpect(list.getByText("Stopped, inconclusive")).toBeVisible();
        await pwExpect(list.getByText("Passed")).toBeVisible();
    }, 90_000);

    it("shows a refusal from the server in plain words", async () => {
        await openIndex();
        await page.getByLabel("Objective").fill("Brute force the admin password");
        await page.getByRole("button", { name: "Start agent run" }).click();
        await pwExpect(page.getByText("The run did not start")).toBeVisible();
        await pwExpect(page.getByText(/break in or attack/)).toBeVisible();
    });

    it("says plainly when runs cannot start here, and when agent mode is off", async () => {
        platform.config.WORKER_EMBEDDED = false;
        try {
            await page.reload();
            await pwExpect(page.getByText("Agent runs cannot start here")).toBeVisible();
            await pwExpect(page.locator("#content").getByText(/nothing here picks up a run/).first()).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Start agent run" })).toHaveAttribute("aria-disabled", "true");
        } finally {
            platform.config.WORKER_EMBEDDED = true;
        }
        platform.repo.updateProject(projectId, { testingModes: ["code"] });
        try {
            await page.reload();
            await pwExpect(page.getByText("Agent mode is off for this project", { exact: true })).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Start agent run" })).toHaveAttribute("aria-disabled", "true");
        } finally {
            platform.repo.updateProject(projectId, { testingModes: ["agent", "code"] });
        }
    });

    it("has no serious accessibility problems and fits a phone-sized screen", async () => {
        await openIndex();
        const index = await new AxeBuilder({ page }).include("main").analyze();
        expect(index.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        await page.getByRole("list", { name: "Agent runs" }).locator("a").first().click();
        await pwExpect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
        const one = await new AxeBuilder({ page }).include("main").analyze();
        expect(one.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        await page.setViewportSize({ width: 390, height: 800 });
        await pwExpect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await openIndex();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    }, 60_000);
});
