/**
 * Hand-written scripts and the runner agent: the REAL agent program (and the real Playwright it starts) against
 *   - a fake platform that offers tasks (so every case of "what the agent does with a script marked custom" can be offered directly), and
 *   - the real platform on real HTTP, with the real worker.
 * An agent started without --allow-custom-scripts refuses a custom script and never runs it; an agent started with it runs it (and its
 * helpers) after checking it again with its own copy of the guard. Nothing is simulated: the fixture application records what scripts did.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/custom-agent.test.ts
 * Ports: fixture application 6072, real platform 6071, fake platforms 6073-6074.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { parseAgentArgs, USAGE, type AgentConfig } from "../src/agent/config.js";
import { describeCapabilities } from "../src/agent/capabilities.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { FakePlatform } from "./fixtures/fake-platform.js";

const APP_PORT = 6072;
const APP = `http://127.0.0.1:${APP_PORT}`;
const PLATFORM_PORT = 6071;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const TOKEN = "aitg_CustomAgentToken0123456789abcdefghijk";
const KEY = "custom-agent-key-1";

let tmp: string;
let app: http.Server;
const hits: string[] = [];
const hitsOf = (n: string) => hits.filter((h) => h === n).length;
const marker = path.join(os.tmpdir(), `aitp-custom-agent-marker-${process.pid}.txt`);

const HEAD = `import { test, expect } from "@playwright/test";\n`;
const hitScript = (name: string) => `${HEAD}test("hand", async ({ page }) => {\n  await page.goto(process.env.BASE_URL + "/");\n  await page.request.get(process.env.BASE_URL + "/__hit?name=${name}");\n  await expect(page.getByRole("heading", { name: "Hello shop" })).toBeVisible();\n});\n`;
const helperUser = `import { test, expect } from "@playwright/test";\nimport { visit } from "./helpers/open-shop";\ntest("with helper", async ({ page }) => {\n  await visit(page);\n  await expect(page.getByRole("heading", { name: "Hello shop" })).toBeVisible();\n});\n`;
const helper = (name: string) => `import type { Page } from "@playwright/test";\nexport async function visit(page: Page) {\n  await page.goto(process.env.BASE_URL + "/");\n  await page.request.get(process.env.BASE_URL + "/__hit?name=${name}");\n}\n`;
const sneaky = `import fs from "node:fs";\nimport { test } from "@playwright/test";\ntest("sneaky", async () => { fs.writeFileSync(${JSON.stringify(marker)}, "it ran"); });\n`;

let counter = 0;
const offer = (scripts: TaskOffer["scripts"], extra: Partial<TaskOffer> = {}): TaskOffer => ({
    taskId: `ctask-${++counter}-${Math.random().toString(16).slice(2, 8)}`,
    jobId: "job-1",
    adapterId: "playwright",
    leaseSeconds: 60,
    workers: 1,
    timeoutMs: 120_000,
    scripts,
    env: { baseUrl: APP, apiBaseUrl: APP, headless: true },
    ...extra,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what: string, cond: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
};

function startAgent(baseUrl: string, workDir: string, over: Partial<AgentConfig> = {}, token = TOKEN) {
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: { baseUrl, token, name: over.allowCustomScripts ? "flagged agent" : "plain agent", concurrency: 1, workDir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env", ...over },
        log,
        heartbeatMs: 300,
        backoff: { baseMs: 50, maxMs: 200 },
    });
    const done = agent.run();
    return { agent, lines, done, stop: async () => (agent.stop(), done) };
}

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-custom-agent-"));
    app = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", APP);
        if (url.pathname === "/__hit") {
            hits.push(url.searchParams.get("name") ?? "");
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end("{}");
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture shop</title></head><body><main><h1>Hello shop</h1></main></body></html>`);
    });
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", () => r()));
}, 30_000);
afterAll(async () => {
    app?.closeAllConnections();
    await new Promise((r) => app?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
});

describe("the agent's command line", () => {
    const base = ["--url", "https://tests.example.com", "--token", TOKEN];
    it("takes --allow-custom-scripts or AITP_ALLOW_CUSTOM_SCRIPTS, and is off otherwise", () => {
        const off = parseAgentArgs(base, {});
        expect(off.kind).toBe("run");
        expect(off.kind === "run" && off.config.allowCustomScripts).toBeUndefined();
        const flag = parseAgentArgs([...base, "--allow-custom-scripts"], {});
        expect(flag.kind === "run" && flag.config.allowCustomScripts).toBe(true);
        for (const v of ["1", "true", "yes", "on"]) {
            const env = parseAgentArgs(base, { AITP_ALLOW_CUSTOM_SCRIPTS: v });
            expect(env.kind === "run" && env.config.allowCustomScripts, v).toBe(true);
        }
        for (const v of ["", "0", "false", "no"]) {
            const env = parseAgentArgs(base, { AITP_ALLOW_CUSTOM_SCRIPTS: v });
            expect(env.kind === "run" && env.config.allowCustomScripts, JSON.stringify(v)).toBeUndefined();
        }
        // the existing options are untouched
        expect(parseAgentArgs([...base, "--allow-app", "calc.exe"], {})).toMatchObject({ kind: "run", config: { allowApps: ["calc.exe"] } });
    });
    it("explains it in the help, and in what the agent reports about itself", () => {
        expect(USAGE).toMatch(/--allow-custom-scripts/);
        expect(USAGE).toMatch(/AITP_ALLOW_CUSTOM_SCRIPTS/);
        expect(describeCapabilities({ os: "linux", arch: "x64", node: "v24", browsers: ["chromium"], customScripts: true })).toMatch(/hand-written scripts: allowed/);
        expect(describeCapabilities({ os: "linux", arch: "x64", node: "v24", browsers: ["chromium"] })).not.toMatch(/hand-written/);
    });
});

describe("an agent started without --allow-custom-scripts", () => {
    let fake: FakePlatform;
    let a: ReturnType<typeof startAgent>;
    beforeAll(async () => {
        fake = new FakePlatform(6073, { token: TOKEN });
        await fake.start();
        a = startAgent(fake.url, path.join(tmp, "plain"));
        await waitFor("hello", () => fake.hellos.length > 0);
        await waitFor("the agent to log that it connected", () => a.lines.join("\n").includes("Connected to the platform"));
    }, 60_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("does not report the capability", () => {
        expect(fake.hellos[0]!.capabilities.customScripts).toBeUndefined();
    });

    it("refuses a script marked custom with a plain infrastructure message, and runs nothing", async () => {
        const before = hitsOf("plain-refused");
        const t = offer([{ testId: "C-1", filename: "C-1.spec.ts", content: hitScript("plain-refused"), custom: true }]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/hand-written scripts/);
        expect(r.error).toMatch(/--allow-custom-scripts/);
        expect(hitsOf("plain-refused")).toBe(before);
    }, 60_000);

    it("refuses a custom script even when it comes with helpers, and one custom script among generated ones refuses the whole task", async () => {
        const t = offer(
            [
                { testId: "C-2", filename: "C-2.spec.ts", content: helperUser, custom: true },
                { testId: "G-1", filename: "G-1.spec.ts", content: hitScript("generated-in-refused-task") },
            ],
            { helpers: [{ name: "open-shop", content: helper("refused-helper") }] },
        );
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(hitsOf("refused-helper")).toBe(0);
        expect(hitsOf("generated-in-refused-task")).toBe(0);
    }, 60_000);

    it("still runs scripts that are not hand-written, exactly as before", async () => {
        const t = offer([{ testId: "G-2", filename: "G-2.spec.ts", content: hitScript("plain-generated") }]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs[0]).toMatchObject({ testId: "G-2", status: "passed" });
        expect(hitsOf("plain-generated")).toBeGreaterThan(0);
    }, 90_000);
});

describe("an agent started with --allow-custom-scripts", () => {
    let fake: FakePlatform;
    let a: ReturnType<typeof startAgent>;
    beforeAll(async () => {
        fake = new FakePlatform(6074, { token: TOKEN });
        await fake.start();
        a = startAgent(fake.url, path.join(tmp, "flagged"), { allowCustomScripts: true });
        await waitFor("hello", () => fake.hellos.length > 0);
        await waitFor("the agent to log that it connected", () => a.lines.join("\n").includes("Connected to the platform"));
    }, 60_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("reports the capability and says in its log that it runs hand-written code", () => {
        expect(fake.hellos[0]!.capabilities.customScripts).toBe(true);
        expect(a.lines.join("\n")).toMatch(/Hand-written scripts are allowed on this agent/);
    });

    it("runs a custom script, with a helper written next to it", async () => {
        const t = offer([{ testId: "C-3", filename: "C-3.spec.ts", content: helperUser, custom: true }], { helpers: [{ name: "open-shop", content: helper("agent-helper-ran") }] });
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs[0]).toMatchObject({ testId: "C-3", status: "passed" });
        expect(hitsOf("agent-helper-ran")).toBeGreaterThan(0);
    }, 90_000);

    it("checks the code again itself: a script that fails its own guard is not run, even though the platform said custom", async () => {
        fs.rmSync(marker, { force: true });
        const t = offer([{ testId: "C-4", filename: "C-4.spec.ts", content: sneaky, custom: true }]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/did not pass this agent's safety check/);
        expect(fs.existsSync(marker)).toBe(false);
    }, 60_000);

    it("checks the helpers too", async () => {
        const t = offer([{ testId: "C-5", filename: "C-5.spec.ts", content: helperUser, custom: true }], { helpers: [{ name: "open-shop", content: `import fs from "node:fs";\nexport const visit = fs;\n` }] });
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/helper open-shop/);
    }, 60_000);

    it("a script that is NOT marked custom gets no such leniency: the guard is only about hand-written code, and the marking comes from the platform", async () => {
        // The platform marks what is hand-written. An unmarked script is a generated one and runs as it always did.
        const t = offer([{ testId: "G-3", filename: "G-3.spec.ts", content: hitScript("unmarked") }]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.runs[0]).toMatchObject({ status: "passed" });
    }, 90_000);
});

describe("the real platform with real agents", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let dataDir: string;
    let pid = "";
    let testId = "";

    const admin = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
    };
    const jobDone = async (jobId: string) => {
        for (let i = 0; i < 300; i++) {
            const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
            await sleep(300);
        }
        throw new Error("job did not finish");
    };
    const online = async (name: string) => {
        for (let i = 0; i < 150; i++) {
            const list = (await admin("GET", `/api/projects/${pid}/agents`)).body as Array<{ name: string; online: boolean; capabilities: { customScripts?: boolean } }>;
            const found = list.find((x) => x.name === name && x.online);
            if (found) return found;
            await sleep(200);
        }
        throw new Error(`${name} did not come online`);
    };
    let savedMaxTokens: string | undefined;

    beforeAll(async () => {
        Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
        // Two runners in one project on purpose (with and without the flag); the one-runner default is covered in runner-limit-unit.test.ts.
        savedMaxTokens = process.env.AGENT_MAX_TOKENS;
        process.env.AGENT_MAX_TOKENS = "25";
        delete process.env.BLOCK_PRIVATE_TARGETS;
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-custom-agent-pf-"));
        // this server does NOT allow hand-written scripts itself: only an agent that agreed can run them
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
        server = await buildServer(platform);
        await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
        worker = new Worker(platform, 150);
        worker.start();
    }, 60_000);
    // A job can still be waiting for its agent when the tests end (lease 20 s): stopping the worker waits for it, so allow more than 30 s.
    afterAll(async () => {
        if (savedMaxTokens === undefined) delete process.env.AGENT_MAX_TOKENS;
        else process.env.AGENT_MAX_TOKENS = savedMaxTokens;
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }, 90_000);

    it("an agent without the flag: hand-written tests are refused before a job exists, generated ones run", async () => {
        pid = (await admin("POST", "/api/projects", { name: "Custom on agents" })).body.id;
        const tok1 = (await admin("POST", `/api/projects/${pid}/agent-tokens`, { label: "plain" })).body.secret as string;
        const imp = await admin("POST", `/api/projects/${pid}/specs`, {
            baseUrl: APP,
            validate: false,
            specs: [
                { title: "A generated test", kind: "web", category: "Web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "text", value: "Hello shop" } }] },
                { title: "To be hand-written", kind: "web", category: "Web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "text", value: "Hello shop" } }] },
            ],
        });
        const generated = imp.body.tests[0].id as string;
        testId = imp.body.tests[1].id as string;
        const plain = startAgent(BASE, path.join(tmp, "pf-plain"), {}, tok1);
        try {
            const agent = await online("plain agent");
            expect(agent.capabilities.customScripts).toBeUndefined();
            expect((await admin("PUT", `/api/projects/${pid}/runner`, { runOn: "agent" })).status).toBe(200);
            expect((await admin("POST", `/api/tests/${testId}/take-over`, { confirm: true })).status).toBe(200);
            const saved = await admin("PUT", `/api/tests/${testId}/script`, { content: hitScript("via-real-agent") });
            expect(saved.status, saved.text).toBe(200);
            expect(saved.body.jobId).toBeNull();
            expect(saved.body.note).toMatch(/--allow-custom-scripts/);
            const refused = await admin("POST", `/api/tests/${testId}/validate`, {});
            expect(refused.status).toBe(409);
            expect(refused.body.error).toMatch(/none of its connected runner agents was started with --allow-custom-scripts/);
            // a generated test runs on the very same agent
            const ok = await admin("POST", `/api/tests/${generated}/validate`, {});
            expect(ok.status, ok.text).toBe(202);
            const job = await jobDone(ok.body.jobId);
            expect(job.ranOn).toMatchObject({ kind: "agent", name: "plain agent" });
            expect((await admin("GET", `/api/tests/${generated}`)).body.validationStatus).toBe("VALIDATED");
            expect(hitsOf("via-real-agent")).toBe(0);
        } finally {
            await plain.stop();
        }
    }, 240_000);

    it("an agent with the flag runs the hand-written test, with its helper, and the platform stores the result like any other", async () => {
        const tok2 = (await admin("POST", `/api/projects/${pid}/agent-tokens`, { label: "flagged" })).body.secret as string;
        expect((await admin("PUT", `/api/projects/${pid}/helpers/open-shop`, { content: helper("real-agent-helper") })).status).toBe(200);
        const flagged = startAgent(BASE, path.join(tmp, "pf-flagged"), { allowCustomScripts: true }, tok2);
        try {
            const agent = await online("flagged agent");
            expect(agent.capabilities.customScripts).toBe(true);
            const saved = await admin("PUT", `/api/tests/${testId}/script`, { content: helperUser, note: "Use the helper" });
            expect(saved.status, saved.text).toBe(200);
            expect(typeof saved.body.jobId).toBe("string");
            const job = await jobDone(saved.body.jobId);
            expect(job.ranOn).toMatchObject({ kind: "agent", name: "flagged agent" });
            const t = (await admin("GET", `/api/tests/${testId}`)).body;
            expect(t.validationStatus, JSON.stringify(t.executions)).toBe("VALIDATED");
            expect(t.executions[0]).toMatchObject({ status: "passed" });
            expect(hitsOf("real-agent-helper")).toBeGreaterThan(0);
            expect(t.custom).toMatchObject({ origin: "taken-over" });
            expect(flagged.lines.join("\n")).toMatch(/Task .* finished/);
        } finally {
            await flagged.stop();
        }
    }, 240_000);
});
