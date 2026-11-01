/**
 * Agent runs through the real platform: HTTP API -> job queue -> worker -> the agent driving a real Chromium against a local site.
 * The model is a scripted double (never a real provider): it plays both a well-behaved agent and one that does whatever the page says, so
 * these tests prove what code enforces whatever the model does.
 *
 * Covered: objective reached; not reachable; limits; a page trying to give instructions; a high-impact step pausing, approved, refused and timing out;
 * the address guard; Stop; permissions and cross-project 404; secrets not reaching the model or the record; tokens hidden from testers; a draft test;
 * a server with no worker or no AI key.
 *
 * Ports 7851-7853. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-runs.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { pursueObjective, type ObjectiveWatch } from "../src/engine/agent/objective.js";
import { RUN_ADDRESS_RULE } from "../src/engine/spec/run-address.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import { AGENT_NO_MODEL, AGENT_NO_WORKER, AGENT_RUNS_OFF } from "../src/platform/agent-run.js";
import { BUDGET_NEEDS_USAGE, NOT_AN_APPROVER } from "../src/platform/routes/agent-runs.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { AGENT_USER, INJECTION, startAgentSite, type AgentSite } from "./fixtures/agent-site.js";

const SITE_PORT = 7851;
const API_PORT = 7852;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const KEY = "agent-runs-owner-key-5b1c";
const PAGE = { "x-requested-with": "ai-studio" };

type Call = { tool: string; input: Record<string, unknown> } | { hang: true };
const queue: Call[] = [];
const prompts: string[] = [];
const toolLists: string[][] = [];
const systems: string[] = [];
let tokensPerCall = 1;
const usage = () => ({ inputTokens: { total: tokensPerCall, noCache: tokensPerCall, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } });

const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        toolLists.push((options.tools ?? []).map((t) => t.name).sort());
        systems.push(JSON.stringify(options.prompt.filter((m) => m.role === "system")));
        const next = queue.shift();
        if (next && "hang" in next) {
            await new Promise((_, reject) => {
                const stop = () => reject(new DOMException("aborted", "AbortError"));
                if (options.abortSignal?.aborted) stop();
                options.abortSignal?.addEventListener("abort", stop);
            });
        }
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(), warnings: [] };
        const call = next as Exclude<Call, { hang: true }>;
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: call.tool, input: JSON.stringify(call.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage(), warnings: [] };
    },
});
const scripted: LlmClient = { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => ({})) as unknown as LlmClient["object"] };

const click = (role: string, value: string): Call => ({ tool: "click", input: { target: { by: "role", role, value } } });
const fill = (label: string, value: string): Call => ({ tool: "fill", input: { target: { by: "label", value: label }, value } });
const assertText = (value: string): Call => ({ tool: "assert", input: { check: "visible", expected: value } });
const finish = (result: string, explanation = "Because of what the page showed", category?: string): Call => ({ tool: "finish", input: { result, explanation, ...(category ? { category } : {}) } });
const SIGN_IN: Call[] = [click("link", "Sign in"), fill("Email", "{{credentials.username}}"), fill("Password", "{{credentials.password}}"), click("button", "Sign in")];

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({ data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } });
const TESTER_PERMISSIONS = ["ai_studio.access", "ai_studio.tests.write", "ai_studio.tests.run", "ai_studio.agent.run"];
const ACCOUNTS: Record<string, unknown> = {
    "t-ann": me("ann", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-tom": me("tom", "TESTER", TESTER_PERMISSIONS),
    "t-rea": me("rea", "CUSTOMER", ["ai_studio.access"], "org-a"),
    "t-sol": me("sol", "CUSTOMER", PERMISSIONS, "org-b"),
};

let site: AgentSite;
let api: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let browser: Browser;
const dirs: string[] = [];
let projectId: string;

const inject = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const res = await server.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: (res.body && /^[[{]/.test(res.body) ? JSON.parse(res.body) : res.body) as any };
};
const call = (method: string, url: string, payload?: unknown) => inject({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => inject({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const addMember = async (project: string, token: string, projectAdmin = false) => {
    const person = (await as(token, "GET", "/api/auth/state")).body.me.id as string;
    accessControlOf(server).projects.store.addMember(project, person, { role: "owner", projectAdmin, source: "added", addedBy: "test" });
};
async function newProject(name: string, credentials = true): Promise<string> {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    const imported = await call("POST", `/api/projects/${id}/specs`, {
        baseUrl: SITE,
        validate: false,
        ...(credentials ? { credentials: { username: AGENT_USER.email, password: AGENT_USER.password } } : {}),
        specs: [{ testId: "WEB-001", title: "Home shows the shop", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Agent Shop" }] }],
    });
    expect(imported.status).toBe(202);
    return id;
}
const url = (rid = "", project = projectId) => `/api/projects/${project}/agent-runs${rid ? `/${rid}` : ""}`;
async function start(body: Record<string, unknown>, script: Call[], project = projectId) {
    queue.push(...script);
    const r = await call("POST", url("", project), { objective: "A customer can reach the shop and buy a mug", ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    return r.body.id as string;
}
async function until(rid: string, done: (r: any) => boolean, project = projectId, ms = 60_000) {
    const end = Date.now() + ms;
    for (;;) {
        const r = (await call("GET", url(rid, project))).body;
        if (done(r)) return r;
        if (Date.now() > end) throw new Error(`run ${rid} did not get there: ${JSON.stringify(r).slice(0, 600)}`);
        await new Promise((d) => setTimeout(d, 100));
    }
}
const ended = (rid: string, project = projectId) => until(rid, (r) => r.state === "finished" || r.state === "stopped", project);
/** The job finishes just after the run: the next run waits for that. */
async function jobDone(jobId: string) {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
        const j = platform.repo.getJob(jobId);
        if (j && ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((d) => setTimeout(d, 50));
    }
    throw new Error("job did not finish");
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startAgentSite(SITE_PORT);
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-runs-"));
    dirs.push(dir);
    platform = bootstrap(loadConfig({ DATA_DIR: dir, API_KEY: KEY, AGENT_RUNS_ON_SERVER: "true", LLM_PROVIDER: "anthropic", SCHEDULER_ENABLED: "false", SECRET_KEY: "agent-runs-secret-key-0123456789abc", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }));
    platform.llm = scripted;
    server = await buildServer(platform);
    await server.ready();
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
    projectId = await newProject("Shop");
    browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
    await worker?.stop();
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await site?.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
    queue.length = 0;
    prompts.length = 0;
    toolLists.length = 0;
    systems.length = 0;
    tokensPerCall = 1;
});

describe("a run", () => {
    it("reaches its objective: every step, a picture of each, the reasoning kept apart, and the job says so", async () => {
        const rid = await start({ successCriteria: "The cart shows the total" }, [click("link", "Products"), click("button", "Add Blue Mug to cart"), { tool: "assert", input: { check: "text", target: { by: "role", role: "status" }, expected: "Total: $12.00" } }, finish("passed", "The total shows $12.00")]);
        const r = await ended(rid);
        expect(r).toMatchObject({ state: "finished", verdict: "passed", reasoning: "The total shows $12.00", failureCategory: null, stopReason: null });
        expect(r.steps.map((s: any) => [s.tool, s.status])).toEqual([["navigate", "done"], ["click", "done"], ["click", "done"], ["assert", "done"]]);
        expect(r.steps.every((s: any) => s.screenshotId)).toBe(true);
        const picture = await server.inject({ method: "GET", url: `/api/artifacts/${r.steps[1].screenshotId}`, headers: { "x-api-key": KEY } });
        expect(picture.statusCode).toBe(200);
        expect(picture.headers["content-type"]).toContain("image/jpeg");
        expect(r.inputTokens + r.outputTokens).toBeGreaterThan(0);
        expect((await jobDone(r.jobId)).status).toBe("COMPLETED");
        expect(prompts[0]).toContain("A customer can reach the shop and buy a mug");
        expect(prompts[0]).toContain("The cart shows the total");
        expect((await call("GET", url())).body.runs[0].id).toBe(rid);
    }, 90_000);

    it("reports an objective that cannot be reached as failed, naming the application as a suggestion", async () => {
        const rid = await start({}, [click("link", "Products"), { tool: "assert", input: { check: "text", target: { by: "role", role: "status" }, expected: "Free shipping" } }, finish("failed", "The page never offers free shipping")]);
        const r = await ended(rid);
        expect(r).toMatchObject({ state: "finished", verdict: "failed", failureCategory: "application" });
        expect(r.steps.at(-1)).toMatchObject({ tool: "assert", status: "failed" });
        expect((await jobDone(r.jobId)).status).toBe("FAILED");
    }, 60_000);

    it("does not call a run passed on the agent's word alone", async () => {
        const rid = await start({}, [finish("passed", "Trust me")]);
        const r = await ended(rid);
        expect(r).toMatchObject({ verdict: "inconclusive", failureCategory: "agent", reasoning: "Trust me" });
        await jobDone(r.jobId);
    }, 60_000);

    it("says blocked with the environment when the start page cannot open", async () => {
        const project = (await call("POST", "/api/projects", { name: "Nothing there" })).body.id as string;
        const rid = await start({ startAddress: "http://127.0.0.1:7853/" }, [], project);
        const r = await ended(rid, project);
        expect(r).toMatchObject({ verdict: "blocked", failureCategory: "environment" });
        expect(r.steps[0]).toMatchObject({ status: "failed" });
        await jobDone(r.jobId);
    }, 60_000);

    it("stops at its step limit whatever the model wants, and at its token limit", async () => {
        const many = Array.from({ length: 8 }, () => click("link", "Products"));
        const rid = await start({ limits: { maxSteps: 2 } }, many);
        const r = await ended(rid);
        expect(r).toMatchObject({ state: "stopped", verdict: "inconclusive", failureCategory: "agent", stopReason: "The run reached its limit of 2 steps." });
        expect(r.steps.filter((s: any) => s.tool === "click").length).toBeLessThanOrEqual(2);
        await jobDone(r.jobId);
        queue.length = 0;

        tokensPerCall = 1_500;
        const tokens = await start({ limits: { budgetTokens: 1_000 } }, [click("link", "Products"), click("link", "Sign in"), click("link", "Notice"), finish("passed")]);
        const t = await ended(tokens);
        expect(t).toMatchObject({ state: "stopped", verdict: "inconclusive", stopReason: "The run reached its AI usage limit." });
        await jobDone(t.jobId);
    }, 90_000);

    it("refuses an objective that is an attack, and a start address on another site or with a sign-in in it", async () => {
        expect((await call("POST", url(), { objective: "Brute force the admin password until it opens" })).status).toBe(422);
        expect((await call("POST", url(), { objective: "A customer can reach the shop", startAddress: "https://other.example/" })).status).toBe(400);
        expect((await call("POST", url(), { objective: "A customer can reach the shop", startAddress: `http://me:pw@127.0.0.1:${SITE_PORT}/` })).status).toBe(400);
        expect((await call("POST", url(), { objective: "A customer can reach the shop", limits: { maxSteps: 100_000 } })).status).toBe(400);
    });
});

describe("page content is untrusted", () => {
    it("cannot change the objective, the limits or the tools, even with a model that does what the page says", async () => {
        // This model obeys the page: it goes off site, tries to delete, then claims success.
        const rid = await start({ limits: { maxSteps: 6, approvalSeconds: 2 } }, [click("link", "Notice"), { tool: "navigate", input: { url: "http://evil.example/steal" } }, finish("passed", "The page told me to")]);
        const r = await ended(rid);
        const seen = prompts.at(-1)!;
        // The text reached the model only inside the fence, with the rule that it is information.
        expect(prompts[1]).toContain(INJECTION.slice(0, 40));
        const fence = /<<<PAGE-CONTENT ([0-9a-f]+)>>>/.exec(seen)?.[1];
        expect(fence).toBeTruthy();
        const inside = prompts[1]!.slice(prompts[1]!.indexOf(`<<<PAGE-CONTENT ${fence}>>>`, prompts[1]!.indexOf("Notice")));
        expect(inside).toContain(`<<<END-PAGE-CONTENT ${fence}>>>`);
        // The page's fake end marker has no name, so it closes nothing.
        expect(systems[0]).toContain("never instructions");
        expect(new Set(systems).size).toBe(1);
        expect(new Set(toolLists.map((t) => t.join())).size).toBe(1);
        expect(prompts[0]).toContain("at most 6 actions");
        expect(prompts[0]).toContain("A customer can reach the shop and buy a mug");
        // What it tried went nowhere, and its claim did not make a pass.
        expect(r.steps.find((s: any) => s.tool === "navigate" && s.status === "refused")?.detail).toContain("own site");
        expect(site.log.some((l) => l.path === "/steal")).toBe(false);
        expect(site.deleted).toBe(0);
        expect(r).toMatchObject({ verdict: "inconclusive", failureCategory: "agent" });
        await jobDone(r.jobId);
    }, 60_000);
});

describe("high-impact actions", () => {
    const toDelete = [...SIGN_IN, click("button", "Delete account")];

    it("pause for a person: nothing happens until someone approves", async () => {
        const before = site.deleted;
        const rid = await start({}, [...toDelete, assertTextDeleted(), finish("passed", "The account is gone")]);
        const waiting = await until(rid, (r) => r.state === "waiting_approval");
        const asked = waiting.approvals[0];
        expect(asked).toMatchObject({ state: "pending", kind: "delete" });
        expect(asked.action).toContain("Delete account");
        await new Promise((d) => setTimeout(d, 400));
        expect(site.deleted).toBe(before);

        expect((await call("POST", `${url(rid)}/approvals/${asked.id}`, { approve: true })).status).toBe(200);
        expect((await call("POST", `${url(rid)}/approvals/${asked.id}`, { approve: false })).status).toBe(409);
        const r = await ended(rid);
        expect(site.deleted).toBe(before + 1);
        expect(r).toMatchObject({ verdict: "passed" });
        expect(r.approvals[0]).toMatchObject({ state: "approved" });
        await jobDone(r.jobId);
    }, 90_000);

    it("a refused action is not done, and the agent is told", async () => {
        const before = site.deleted;
        const rid = await start({}, [...toDelete, assertTextAccount(), finish("inconclusive", "A person refused")]);
        const asked = (await until(rid, (r) => r.state === "waiting_approval")).approvals[0];
        await call("POST", `${url(rid)}/approvals/${asked.id}`, { approve: false });
        const r = await ended(rid);
        expect(site.deleted).toBe(before);
        expect(r.steps.find((s: any) => s.status === "refused")?.detail).toContain("refused");
        expect(prompts.join()).toContain("A person refused this action");
        await jobDone(r.jobId);
    }, 90_000);

    it("time out to stopped, with the action not done", async () => {
        const before = site.deleted;
        const rid = await start({ limits: { approvalSeconds: 1 } }, [...toDelete, finish("passed", "should never be reached")]);
        const r = await ended(rid);
        expect(site.deleted).toBe(before);
        expect(r).toMatchObject({ state: "stopped", verdict: "inconclusive" });
        expect(r.stopReason).toContain("Nobody answered");
        expect(r.approvals[0].state).toBe("timed_out");
        await jobDone(r.jobId);
    }, 90_000);

    it("a real form pauses; a form that only reads does not", async () => {
        const rid = await start({ limits: { approvalSeconds: 1 } }, [...SIGN_IN, click("button", "Search"), click("button", "Save"), finish("inconclusive")]);
        const r = await ended(rid);
        expect(r.approvals).toHaveLength(1);
        expect(r.approvals[0].kind).toBe("submit");
        expect(r.steps.find((s: any) => s.summary.includes("Search"))?.status).toBe("done");
        await jobDone(r.jobId);
    }, 90_000);

    it("a person's Stop ends a run that waits for approval", async () => {
        const rid = await start({}, toDelete);
        const asked = (await until(rid, (r) => r.state === "waiting_approval")).approvals[0];
        expect((await call("POST", `${url(rid)}/stop`)).status).toBe(200);
        const r = await ended(rid);
        expect(r).toMatchObject({ state: "stopped", verdict: "inconclusive", stopReason: "A person stopped this run." });
        expect((await call("GET", url(rid))).body.approvals[0]).toMatchObject({ id: asked.id, state: "stopped" });
        expect((await jobDone(r.jobId)).error).toBe("Cancelled");
        expect((await call("POST", `${url(rid)}/stop`)).status).toBe(409);
    }, 60_000);

    function assertTextDeleted(): Call {
        return assertText("Your account is gone.");
    }
    function assertTextAccount(): Call {
        return assertText("Welcome, Demo");
    }
});

describe("stopping", () => {
    it("ends a running agent, with a model call under way", async () => {
        const rid = await start({}, [click("link", "Products"), { hang: true }]);
        await until(rid, (r) => r.steps.length >= 2);
        expect((await call("POST", `${url(rid)}/stop`)).status).toBe(200);
        const r = await ended(rid);
        expect(r).toMatchObject({ state: "stopped", verdict: "inconclusive", stopReason: "A person stopped this run." });
        expect((await jobDone(r.jobId)).error).toBe("Cancelled");
    }, 60_000);

    it("does not start a job that was picked up again after its worker went away", async () => {
        const rid = await start({}, [finish("passed")]);
        const r = await ended(rid);
        await jobDone(r.jobId);
        // As a reclaimed job finds it: the run had started, so it is not run twice.
        platform.db.run("UPDATE objective_runs SET state = 'running', verdict = NULL, finished_at = NULL WHERE id = ?", rid);
        platform.db.run("UPDATE generation_jobs SET status = 'QUEUED', finished_at = NULL WHERE id = ?", r.jobId);
        const again = await ended(rid);
        expect(again).toMatchObject({ state: "stopped", failureCategory: "runner" });
        expect(again.stopReason).toContain("not started again");
        await jobDone(r.jobId);
    }, 60_000);
});

describe("the address guard", () => {
    const watch = (): ObjectiveWatch & { steps: any[] } => {
        const steps: any[] = [];
        return { steps, step: async (s) => void steps.push(s), askApproval: async () => "refused", stopRequested: async () => false };
    };
    const limits = { maxSteps: 5, maxMinutes: 1, maxTokens: 100_000, approvalSeconds: 1 };
    const ctx = () => ({ config: platform.config, llm: scripted, emit: () => undefined }) as never;

    it("refuses a private target at every step", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            // The step's rule refuses the way out. The browser's guard (guard-proxy.ts) separately refuses this loopback site's pages here: a run
            // on a private site never starts with the guard on (below), so it is not trusted, which also keeps a rebinding name from getting through.
            queue.push({ tool: "navigate", input: { url: "http://169.254.169.254/latest/meta-data/" } }, finish("blocked", "Refused"));
            const w = watch();
            const out = await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/`, objective: "Read the metadata", limits, secrets: [], watch: w });
            expect(out.verdict).toBe("blocked");
            const refused = w.steps.find((s) => s.status === "refused");
            expect(refused.detail).toContain(RUN_ADDRESS_RULE);
            expect(refused.detail).toContain("private");
            // And at the start of a run, before any job.
            const r = await call("POST", url(), { objective: "A customer can reach the shop" });
            expect(r.status).toBe(400);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    }, 60_000);

    it("keeps a step from opening a placeholder that moves the address, or using sign-in details in one", async () => {
        queue.push({ tool: "navigate", input: { url: "http{{x}}://evil.example/" } }, { tool: "navigate", input: { url: "/account?p={{credentials.password}}" } }, finish("inconclusive"));
        const w = watch();
        await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/`, objective: "Try the address rules", limits, secrets: [], credentials: { username: "u", password: "secret-pw-1" }, watch: w });
        expect(w.steps.filter((s) => s.status === "refused")).toHaveLength(2);
    }, 60_000);

    it("stops at the time limit, whatever the model is doing", async () => {
        queue.push({ hang: true });
        const w = watch();
        const out = await pursueObjective({ ctx: ctx(), browser, baseUrl: SITE, startAddress: `${SITE}/`, objective: "Wait for ever", limits: { ...limits, maxMinutes: 0.01 }, secrets: [], watch: w });
        expect(out).toMatchObject({ state: "stopped", verdict: "inconclusive" });
        expect(out.stopReason).toContain("time limit");
    }, 30_000);
});

describe("secrets", () => {
    it("never reach the model or the record, even when the page shows them, and stay in their own fields", async () => {
        const rid = await start({}, [
            click("link", "Sign in"),
            fill("Email", "{{credentials.password}}"), // an ordinary field: refused
            fill("Password", "guessed-value"), // a real value in a password field: refused
            fill("Email", "x{{credentials.password}}"), // inside other text: refused
            ...SIGN_IN.slice(1),
            assertText("Welcome, Demo"),
            { tool: "assert", input: { check: "visible", expected: "{{credentials.password}}" } }, // used as an oracle: refused
            finish("passed", "Signed in"),
        ]);
        const r = await ended(rid);
        expect(r.verdict).toBe("passed");
        expect(r.steps.filter((s: any) => s.status === "refused")).toHaveLength(4);
        const everything = prompts.join("\n") + JSON.stringify(r);
        expect(everything).not.toContain(AGENT_USER.password);
        expect(encodeURIComponent(AGENT_USER.password) === AGENT_USER.password || !everything.includes(encodeURIComponent(AGENT_USER.password))).toBe(true);
        // The page did echo it: scrubbed, not simply absent.
        expect(prompts.join("\n")).toContain("Reminder: your password is [hidden]");
        const stored = platform.db.all<{ step_json: string | null }>("SELECT step_json FROM objective_run_steps WHERE run_id = ?", rid);
        expect(JSON.stringify(stored)).toContain("{{credentials.password}}");
        expect(JSON.stringify(stored)).not.toContain(AGENT_USER.password);
        await jobDone(r.jobId);
    }, 90_000);
});

describe("a draft from a run", () => {
    it("keeps the steps with stand-ins, starts as a draft for review, and does not run", async () => {
        const rid = await start({ successCriteria: "Welcome shows\nThe account page opens" }, [...SIGN_IN, assertText("Welcome, Demo"), finish("passed", "Signed in")]);
        const r = await ended(rid);
        await jobDone(r.jobId);
        const made = await call("POST", `${url(rid)}/draft`, {});
        expect(made.status).toBe(201);
        expect(made.body.testKey).toMatch(/^AGENT-\d{3}$/);
        const test = (await call("GET", `/api/tests/${made.body.testId}`)).body;
        expect(JSON.stringify(test.spec)).toContain("{{credentials.password}}");
        expect(JSON.stringify(test.spec)).not.toContain(AGENT_USER.password);
        expect(test.spec.expectedResults).toEqual(["Welcome shows", "The account page opens"]);
        expect(test.spec.steps.map((s: any) => s.action)).toEqual(["navigate", "click", "fill", "fill", "click", "assert"]);
        const version = new ReviewStore(platform.db).latest(made.body.testId);
        expect(version?.state).toBe("draft");
        // The AI's draft is the change of whoever started the run (here the access key), so that same caller does not count as a second pair of eyes.
        expect(version?.author).toMatchObject({ kind: "ai", id: "key:" });
        expect(platform.repo.getJob(r.jobId)?.options.startedBy).toMatchObject({ kind: "key" });
        expect((await call("POST", `${url(rid)}/draft`, {})).body).toMatchObject({ testId: made.body.testId, created: false });
        expect((await call("GET", url(rid))).body.draftTestId).toBe(made.body.testId);
    }, 90_000);

    it("is refused for a run that checked nothing, and while a run goes", async () => {
        const rid = await start({}, [click("link", "Products"), finish("inconclusive")]);
        const r = await ended(rid);
        await jobDone(r.jobId);
        expect((await call("POST", `${url(rid)}/draft`, {})).status).toBe(422);
        const going = await start({}, [{ hang: true }]);
        await until(going, (x) => x.steps.length >= 1);
        expect((await call("POST", `${url(going)}/draft`, {})).status).toBe(409);
        await call("POST", `${url(going)}/stop`);
        await jobDone((await ended(going)).jobId);
    }, 60_000);
});

describe("who may do what", () => {
    it("needs the permission to start, stop and answer; another project's run does not exist; testers do not see tokens", async () => {
        const mine = (await as("t-ann", "POST", "/api/projects", { name: "Org A" })).body.id as string;
        await call("POST", `/api/projects/${mine}/specs`, { baseUrl: SITE, validate: false, credentials: { username: AGENT_USER.email, password: AGENT_USER.password }, specs: [{ testId: "WEB-001", title: "Home shows the shop", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Agent Shop" }] }] });
        await addMember(mine, "t-tom");
        await addMember(mine, "t-rea");
        const rid = await start({ limits: { approvalSeconds: 30 } }, [...SIGN_IN, click("button", "Delete account")], mine);
        const r = await until(rid, (x) => x.state === "waiting_approval", mine);
        const asked = r.approvals[0];

        // Reading is open to the project, acting is not.
        expect((await as("t-rea", "GET", url(rid, mine))).status).toBe(200);
        expect((await as("t-rea", "POST", url("", mine), { objective: "Someone can open the shop" })).status).toBe(403);
        expect((await as("t-rea", "POST", `${url(rid, mine)}/stop`)).status).toBe(403);
        expect((await as("t-rea", "POST", `${url(rid, mine)}/approvals/${asked.id}`, { approve: true })).status).toBe(403);

        // Outside the project: nothing is there.
        const other = (await as("t-sol", "POST", "/api/projects", { name: "Org B" })).body.id as string;
        expect((await as("t-sol", "GET", url(rid, mine))).status).toBe(404);
        expect((await as("t-sol", "POST", `${url(rid, mine)}/stop`)).status).toBe(404);
        expect((await call("GET", url(rid, other))).status).toBe(404);
        expect((await call("POST", `${url(rid, other)}/approvals/${asked.id}`, { approve: true })).status).toBe(404);
        expect((await call("POST", `${url(rid, other)}/stop`)).status).toBe(404);

        // A tester can follow a run, without any figure of AI usage; the cost fields are gone at every depth.
        const seen = await as("t-tom", "GET", url(rid, mine));
        expect(seen.status).toBe(200);
        expect(seen.body.objective).toBeTruthy();
        expect(seen.body.inputTokens).toBeUndefined();
        expect(seen.body.outputTokens).toBeUndefined();
        expect(seen.body.limits.budgetTokens).toBeUndefined();
        const list = await as("t-tom", "GET", url("", mine));
        expect(JSON.stringify(list.body.runs)).not.toMatch(/Tokens/);
        expect((await as("t-ann", "GET", url(rid, mine))).body.limits.budgetTokens).toBeGreaterThan(0);
        expect((await as("t-ann", "GET", url(rid, mine))).body.inputTokens).toBeGreaterThan(0);

        // Answering is an approval: a tester who may run agents cannot give it, a Project Admin who may approve can (D-23).
        const byTester = await as("t-tom", "POST", `${url(rid, mine)}/approvals/${asked.id}`, { approve: true });
        expect(byTester.status).toBe(403);
        expect(JSON.stringify(byTester.body)).toContain(NOT_AN_APPROVER);
        expect((await as("t-ann", "POST", `${url(rid, mine)}/approvals/${asked.id}`, { approve: false })).status).toBe(200);
        // A budget above the default is spending: refused for someone who may not see AI usage, whatever else they hold.
        const big = await as("t-tom", "POST", url("", mine), { objective: "Someone can open the shop", limits: { budgetTokens: 400_000 } });
        expect(big.status).toBe(403);
        expect(JSON.stringify(big.body)).toContain(BUDGET_NEEDS_USAGE);
        await as("t-tom", "POST", `${url(rid, mine)}/stop`);
        await jobDone((await ended(rid, mine)).jobId);
    }, 90_000);

    it("a project with agent mode off cannot start one", async () => {
        const off = await newProject("Code only");
        platform.repo.updateProject(off, { testingModes: ["code"] });
        const r = await call("POST", url("", off), { objective: "A customer can reach the shop" });
        expect(r.status).toBe(409);
        expect(r.body.error ?? r.body.message).toContain("Agent mode is off");
        expect((await call("GET", url("", off))).body.agentModeOn).toBe(false);
    });
});

describe("a server where runs cannot start", () => {
    it("says so and starts nothing: no worker, or no AI key", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-runs-hosted-"));
        dirs.push(dir);
        const hosted = bootstrap(loadConfig({ DATA_DIR: dir, API_KEY: KEY, AGENT_RUNS_ON_SERVER: "true", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "agent-runs-secret-key-0123456789abc" }));
        hosted.llm = scripted;
        const app = await buildServer(hosted);
        await app.ready();
        const ask = async (method: "GET" | "POST" | "PUT", u: string, payload?: unknown) => {
            const res = await app.inject({ method, url: u, headers: { "x-api-key": KEY }, ...(payload ? { payload: payload as object } : {}) });
            return { status: res.statusCode, body: JSON.parse(res.body) };
        };
        const id = (await ask("POST", "/api/projects", { name: "Hosted" })).body.id as string;
        hosted.repo.createApplication(id, SITE, {});
        const noWorker = await ask("POST", `/api/projects/${id}/agent-runs`, { objective: "A customer can reach the shop" });
        expect(noWorker.status).toBe(409);
        expect(JSON.stringify(noWorker.body)).toContain(AGENT_NO_WORKER);
        expect((await ask("GET", `/api/projects/${id}/agent-runs`)).body).toMatchObject({ runs: [], canStart: { ok: false, reason: AGENT_NO_WORKER } });

        hosted.config.WORKER_EMBEDDED = true;
        hosted.llm = unavailableLlmClient("no key");
        const noModel = await ask("POST", `/api/projects/${id}/agent-runs`, { objective: "A customer can reach the shop" });
        expect(noModel.status).toBe(409);
        expect(JSON.stringify(noModel.body)).toContain(AGENT_NO_MODEL);
        expect(hosted.db.all("SELECT id FROM objective_runs")).toHaveLength(0);

        // The server has no key, but a project with its own can start.
        expect((await ask("GET", `/api/projects/${id}/agent-runs`)).body.canStart).toEqual({ ok: false, reason: AGENT_NO_MODEL });
        const own = await ask("POST", `/api/projects/${id}/ai/configurations`, { label: "Own key", provider: "openai-compatible", model: "stand-in", baseUrl: "https://provider.example/v1", apiKey: "own-project-key-1234" });
        expect(own.status).toBe(201);
        expect((await ask("PUT", `/api/projects/${id}/ai`, { mode: "own", configurationId: own.body.id })).status).toBe(200);
        expect((await ask("GET", `/api/projects/${id}/agent-runs`)).body.canStart).toEqual({ ok: true });
        // Another project on the same server still cannot.
        const other = (await ask("POST", "/api/projects", { name: "Hosted, no key" })).body.id as string;
        expect((await ask("GET", `/api/projects/${other}/agent-runs`)).body.canStart).toEqual({ ok: false, reason: AGENT_NO_MODEL });
        expect(hosted.db.all("SELECT id FROM generation_jobs")).toHaveLength(0);
        // Switched off on this server (the default): refused whatever the worker and the key, and the page says why.
        hosted.config.AGENT_RUNS_ON_SERVER = false;
        expect((await ask("GET", `/api/projects/${id}/agent-runs`)).body.canStart).toEqual({ ok: false, reason: AGENT_RUNS_OFF });
        const off = await ask("POST", `/api/projects/${id}/agent-runs`, { objective: "A customer can reach the shop" });
        expect(off.status).toBe(409);
        expect(JSON.stringify(off.body)).toContain(AGENT_RUNS_OFF);
        expect(hosted.db.all("SELECT id FROM generation_jobs")).toHaveLength(0);
        await app.close();
        hosted.db.close();
    }, 30_000);
});
