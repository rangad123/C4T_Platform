/**
 * The project's sign-in on a runner: the real runner program (src/agent) against a real platform and worker, and a local stand-in site
 * that records what its login form received. What Project settings → Sign-in saves is what a text test ({{credentials.*}}) and a code
 * test (TEST_USERNAME, TEST_PASSWORD, TEST_TOTP_SECRET) type on the runner, a changed sign-in is what the next run on the runner types,
 * and neither the runner's output nor its folder keeps the secrets.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/sign-in-on-runner.test.ts
 * Ports: platform 5651, the site 5652.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner } from "./helpers/personal-runner.js";

const PLATFORM_PORT = 5651;
const SITE_PORT = 5652;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const S = { user1: "first@practice.test", pw1: "SIGNRUNNER-Pw1-2d8c4a", totp1: "JBSWY3DPEHPK3PXP", user2: "second@practice.test", pw2: "SIGNRUNNER-Pw2-81f0e3" };
const SECRETS = [S.pw1, S.totp1, S.pw2];
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const accounts = new Map([
    [S.user1, S.pw1],
    [S.user2, S.pw2],
]);
const received: Array<{ path: string; fields: Record<string, string> }> = [];
const LOGIN = '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>';
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let site: http.Server;
let agent: Agent;
let agentDone: Promise<number>;
let agentLines: string[] = [];
let dataDir = "";
let agentWork = "";

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: /^[[{]/.test(text) ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
async function waitJob(jobId: string): Promise<any> {
    for (let i = 0; i < 600; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job ${jobId} did not finish`);
}
const latest = async (testId: string) => ((await call("GET", `/api/tests/${testId}/executions`)).body as Array<{ status: string; error?: string | null }>)[0]!;

const TEXT = `Test: Signs in on the runner
Category: Sign in

Go to /login
Type "{{credentials.username}}" into the "Email" field
Type "{{credentials.password}}" into the "Password" field
Click the "Log in" button
Expect the page to contain the text "Welcome"
`;
const CODE = `import { test, expect } from "@playwright/test";
test("code signs in on the runner", async ({ page }) => {
  await page.goto(process.env.BASE_URL + "/login");
  await page.getByLabel("Email").fill(process.env.TEST_USERNAME ?? "");
  await page.getByLabel("Password").fill(process.env.TEST_PASSWORD ?? "");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Welcome")).toBeVisible();
  const r = await page.request.post(process.env.BASE_URL + "/seen", { form: { totpSecret: process.env.TEST_TOTP_SECRET ?? "" } });
  expect(r.ok()).toBe(true);
});
`;

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer(async (req, res) => {
        const p = (req.url ?? "/").split("?")[0]!;
        const html = (status: number, content: string) => (res.writeHead(status, { "content-type": "text/html" }), res.end(content));
        if (req.method === "POST") {
            let raw = "";
            for await (const c of req) raw += c;
            const fields = Object.fromEntries(new URLSearchParams(raw));
            received.push({ path: p, fields });
            if (p === "/login") return accounts.get(fields.email ?? "") === fields.password ? html(200, page("Your account", `<p>Welcome ${fields.email}</p>`)) : html(401, page("Sign in", '<p role="alert">Invalid email or password</p>' + LOGIN));
            return html(200, page("Thanks", "<p>Received</p>"));
        }
        if (p === "/login") return html(200, page("Sign in", LOGIN));
        html(200, page("Practice site", '<a href="/login">Log in</a>'));
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sign-in-runner-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sign-in-runner-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 60_000);

afterAll(async () => {
    agent?.stop();
    await agentDone;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => site?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentWork, { recursive: true, force: true });
});

describe("the project's sign-in on a runner", () => {
    let projectId = "";
    const ids: Record<string, string> = {};

    it("a runner connects and the project's runs go to it", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Sign-in on a runner", platforms: ["web"], testingModes: ["code"] })).body.id;
        expect((await call("PUT", `/api/projects/${projectId}/app-details`, { webUrl: `${SITE}/` })).status).toBe(200);
        const saved = await call("PUT", `/api/projects/${projectId}/sign-in`, { username: S.user1, password: S.pw1, totpSecret: S.totp1 });
        expect(saved.status, saved.text).toBe(200);
        const { log, lines } = memoryLogger();
        agentLines = lines;
        agent = new Agent({ config: { baseUrl: BASE, token: personalRunner(platform, { label: "sign-in" }).secret, name: "sign-in runner", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 } });
        agentDone = agent.run();
        for (let i = 0; i < 100; i++) {
            const list = (await call("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean }>;
            if (list?.some((a) => a.online)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const set = await call("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
        expect(set.status, set.text).toBe(200);
    }, 60_000);

    it("a text test and a code test type the saved sign-in on the runner", async () => {
        const from = received.length;
        const text = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: TEXT });
        expect(text.status, text.text).toBe(201);
        ids.text = text.body.testId;
        const job = await waitJob(text.body.jobId);
        expect(job.ranOn, JSON.stringify(job)).toMatchObject({ kind: "agent" });
        const code = await call("POST", `/api/projects/${projectId}/custom-tests`, { title: "Code signs in on the runner", kind: "web", content: CODE });
        expect(code.status, code.text).toBe(201);
        ids.code = code.body.testId;
        expect((await waitJob(code.body.jobId)).ranOn).toMatchObject({ kind: "agent" });
        for (const id of [ids.text!, ids.code!]) {
            const run = await latest(id);
            expect(run, JSON.stringify(run)).toMatchObject({ status: "passed" });
        }
        expect(received.slice(from)).toEqual([
            { path: "/login", fields: { email: S.user1, password: S.pw1 } },
            { path: "/login", fields: { email: S.user1, password: S.pw1 } },
            { path: "/seen", fields: { totpSecret: S.totp1 } },
        ]);
    }, 240_000);

    it("a changed sign-in is what the next run on the runner types", async () => {
        expect((await call("PUT", `/api/projects/${projectId}/sign-in`, { username: S.user2, password: S.pw2 })).status).toBe(200);
        const from = received.length;
        const r = await call("POST", `/api/projects/${projectId}/runs`, { testIds: [ids.text!, ids.code!] });
        expect(r.status, r.text).toBe(202);
        expect((await waitJob(r.body.jobId)).ranOn).toMatchObject({ kind: "agent" });
        for (const id of [ids.text!, ids.code!]) expect(await latest(id)).toMatchObject({ status: "passed" });
        const logins = received.slice(from).filter((x) => x.path === "/login");
        expect(logins).toEqual([
            { path: "/login", fields: { email: S.user2, password: S.pw2 } },
            { path: "/login", fields: { email: S.user2, password: S.pw2 } },
        ]);
    }, 240_000);

    it("the secrets are not in the runner's output, its folder or the platform's data", async () => {
        const out = agentLines.join("\n");
        for (const s of SECRETS) expect(out, "runner output").not.toContain(s);
        for (let i = 0; i < 50 && fs.existsSync(path.join(agentWork, "tasks")) && fs.readdirSync(path.join(agentWork, "tasks")).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const leaks: string[] = [];
        const scan = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isSymbolicLink()) continue;
                if (e.isDirectory()) scan(full);
                else {
                    const b = fs.readFileSync(full);
                    for (const s of SECRETS) if (b.toString("latin1").includes(s) || b.toString("utf16le").includes(s)) leaks.push(`${s} in ${full}`);
                }
            }
        };
        scan(agentWork);
        scan(dataDir);
        expect(leaks).toEqual([]);
    });
});
