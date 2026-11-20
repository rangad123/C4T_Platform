/**
 * Test scripts made from written test cases (Test cases, Generate test scripts) through the real platform: HTTP API -> one plain job per
 * case, one after the other -> the real authoring agent signing in with the project's saved sign-in in a real Chromium against a local
 * application whose signed-in page says "Account" (never "Dashboard") -> real validation run -> stored test, linked to its case.
 * The model is a scripted double (MockLanguageModelV3 for the agent's tool calls): no real model is called, so this proves the
 * pipeline, not model quality.
 *
 *   a case's script checks what the application shows after signing in: the agent's guess ("Dashboard") fails on the page and is not
 *   kept, the "Account" it sees is, and the script passes; the next case's job starts on its own and gets its script too;
 *   the same case gives the same script from Test cases as from Test scripts, Describe it (one pipeline).
 *
 * Fixture application: port 5694. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/case-scripts-account.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { caseDescription } from "../src/platform/case-scripts.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { saveSignIn } from "../src/platform/routes/project-sign-in.js";
import { buildServer } from "../src/platform/server.js";
import { buildXlsx } from "../src/security/findings/xlsx.js";
import { Worker } from "../src/platform/worker.js";
import { ACCOUNT_USER, startAccountSite, type AccountSite } from "./fixtures/account-site.js";

const PORT = 5694;
const SITE = `http://127.0.0.1:${PORT}`;

let site: AccountSite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

// ── the scripted model ────────────────────────────────────────────────────────
type Call = { tool: string; input: Record<string, unknown> };
const queue: Call[] = [];
const seenPrompts: string[] = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        seenPrompts.push(JSON.stringify(options.prompt));
        const next = queue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async () => {
        throw new Error("no scripted plan");
    }) as LlmClient["object"],
};

const heading = (value: string) => ({ by: "role", role: "heading", value });
/**
 * Signing in the way a model does it: with the saved sign-in's placeholders, then a first check that guesses the page after it
 * ("Dashboard", what the issue's script looked for) and fails on the page, then the "Account" heading the page really shows.
 */
const SIGN_IN: Call[] = [
    { tool: "click", input: { target: { by: "role", role: "link", value: "Sign in" } } },
    { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
    { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
    { tool: "click", input: { target: { by: "role", role: "button", value: "Sign in" } } },
    { tool: "assert", input: { check: "visible", target: heading("Dashboard") } },
    { tool: "assert", input: { check: "visible", target: heading("Account") } },
    { tool: "finish", input: { result: "complete", explanation: "Signed in; the page after it is Account" } },
];
const OPEN_HOME: Call[] = [
    { tool: "assert", input: { check: "visible", target: heading("Workspace") } },
    { tool: "finish", input: { result: "complete", explanation: "The home page shows Workspace" } },
];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startAccountSite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-account-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SCHEDULER_ENABLED: "false" }));
    platform.llm = scripted;
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: (res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body) as any };
};
/** A code-based web project for the fixture application, with its sign-in saved in Settings, Sign-in. */
function project(name: string): string {
    const pid = platform.repo.createProject({ name, platforms: ["web"], testingModes: ["code"] }).id as string;
    platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS });
    saveSignIn(platform, pid, SITE, { username: ACCOUNT_USER.email, password: ACCOUNT_USER.password });
    return pid;
}
const addCase = async (pid: string, title: string, steps: Array<{ action: string; expected: string }>) => {
    const r = await call("POST", `/api/projects/${pid}/manual-cases`, { title, priority: "high", automation: "automated", steps });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; title: string; ref: string; steps: Array<{ action: string; expected: string }>; linkedTestIds: string[] };
};
/** Until every job of the project has ended (a case's job starts the next one when it ends). */
async function settle(pid: string, ms = 200_000) {
    const end = Date.now() + ms;
    for (let quiet = 0; quiet < 3; ) {
        const jobs = platform.repo.listJobs(pid);
        quiet = jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) ? quiet + 1 : 0;
        if (Date.now() > end) throw new Error(`jobs did not finish: ${jobs.map((j) => j.status).join(", ")}`);
        await new Promise((r) => setTimeout(r, 400));
    }
    return platform.repo.listJobs(pid);
}
const caseOf = async (pid: string, id: string) => (await call("GET", `/api/projects/${pid}/manual-cases/${id}`)).body as { linkedTestIds: string[] };
const detail = async (id: string) => (await call("GET", `/api/tests/${id}`)).body;
/** The steps of a stored test without what names the test itself. */
const stepsOf = (spec: any) => spec.steps.map(({ description: _d, ...s }: any) => s);

const SIGN_IN_CASE = { title: "Sign in with valid credentials", steps: [{ action: "Open the sign-in page, type the saved email and password and click Sign in", expected: "The user is signed in" }] };

describe("test scripts from test cases", () => {
    let fromCase: any;

    it("a case's script checks what the application shows after signing in (Account), and passes; the next case gets its script too", async () => {
        const pid = project("Account app");
        const signIn = await addCase(pid, SIGN_IN_CASE.title, SIGN_IN_CASE.steps);
        const home = await addCase(pid, "Home page opens", [{ action: "Open the home page", expected: "The page shows Workspace" }]);
        queue.push(...SIGN_IN, ...OPEN_HOME);

        const r = await call("POST", `/api/projects/${pid}/manual-cases/generate-scripts`, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.started.caseIds).toEqual([signIn.id, home.id]);
        const jobs = await settle(pid);
        expect(jobs).toHaveLength(2);
        for (const j of jobs) expect(j.status, j.error ?? "").toBe("COMPLETED");

        const [script] = (await caseOf(pid, signIn.id)).linkedTestIds;
        expect(script).toBeTruthy();
        fromCase = await detail(script!);
        expect(fromCase.validationStatus).toBe("VALIDATED");
        expect(fromCase.executions[0].status).toBe("passed");
        expect(fromCase.spec.title).toBe(SIGN_IN_CASE.title);
        // The check after signing in is the page the agent saw; the guessed page name failed there and is not in the script.
        const checks = fromCase.spec.steps.filter((s: any) => s.action === "assert").map((s: any) => s.locator?.value);
        expect(checks).toEqual(["Account"]);
        expect(JSON.stringify(fromCase.spec) + JSON.stringify(fromCase.scripts)).not.toMatch(/dashboard/i);
        // Signed in with the saved sign-in, never a copy of it.
        expect(JSON.stringify(fromCase.spec)).toContain("{{credentials.password}}");
        expect(JSON.stringify(fromCase)).not.toContain(ACCOUNT_USER.password);
        // The agent was given the case's own words.
        expect(seenPrompts.join("\n")).toContain("type the saved email and password and click Sign in");

        // The second case's job started when the first ended, and its test is that case's script.
        const [second] = (await caseOf(pid, home.id)).linkedTestIds;
        expect((await detail(second!)).validationStatus).toBe("VALIDATED");
    }, 300_000);

    it("a case imported from the test case workbook starts on its page and gives the agent its preconditions and expected result (SPEC R6.5)", async () => {
        const pid = project("Account app, imported");
        const wb = buildXlsx([
            {
                name: "Test cases",
                header: true,
                rows: [
                    ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"],
                    ["TC-009", "Sign in from the sign-in page", "Automated", "High", "/login", "The saved account exists", "Type in the old way => ignored", "The Account page opens", ""],
                ],
            },
        ]);
        const imp = await call("POST", `/api/projects/${pid}/manual-cases/import`, { format: "xlsx", content: Buffer.from(wb).toString("base64") });
        expect(imp.status, JSON.stringify(imp.body)).toBe(201);
        // Already on the sign-in page: no "Sign in" link to click first.
        queue.push(...SIGN_IN.slice(1));
        seenPrompts.length = 0;
        const r = await call("POST", `/api/projects/${pid}/manual-cases/generate-scripts`, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const [job] = await settle(pid);
        expect(job!.status, job!.error ?? "").toBe("COMPLETED");
        const prompts = seenPrompts.join("\n");
        expect(prompts).toContain("The saved account exists");
        expect(prompts).toContain("The Account page opens");
        expect(prompts).not.toContain("Type in the old way");
        const t = ((await call("GET", `/api/projects/${pid}/tests`)).body as any[])[0];
        const made = await detail(t.id);
        expect(made.validationStatus).toBe("VALIDATED");
        // It starts on the case's page: the first step opens /login.
        expect(made.spec.steps[0].action).toBe("navigate");
        expect(JSON.stringify(made.spec.steps[0])).toContain("/login");
        expect(made.spec.expectedResults).toEqual(["The Account page opens"]);
    }, 300_000);

    it("the same case gives the same script from Test scripts, Describe it as from Test cases", async () => {
        expect(fromCase).toBeTruthy();
        const pid = project("Account app, described");
        queue.push(...SIGN_IN);
        seenPrompts.length = 0;
        const r = await call("POST", `/api/projects/${pid}/plain-tests`, { description: caseDescription(SIGN_IN_CASE) });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        const [job] = await settle(pid);
        expect(job!.status, job!.error ?? "").toBe("COMPLETED");
        const t = ((await call("GET", `/api/projects/${pid}/tests`)).body as any[])[0];
        const described = await detail(t.id);
        expect(described.validationStatus).toBe("VALIDATED");
        expect(described.spec.title).toBe(fromCase.spec.title);
        expect(described.spec.description).toBe(fromCase.spec.description);
        expect(described.spec.expectedResults).toEqual(fromCase.spec.expectedResults);
        expect(stepsOf(described.spec)).toEqual(stepsOf(fromCase.spec));
    }, 300_000);
});
