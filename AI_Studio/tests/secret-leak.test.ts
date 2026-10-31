/**
 * Leak audit: one real job with sentinel secrets (default sign-in, authenticator secret, API token, two named accounts with
 * passwords and tokens), then a search of EVERYTHING the platform produced for any trace of them — every API answer, the
 * database and its journal, stored scripts and evidence, the scratch directory the scripts ran from, the downloadable zip, the
 * JUnit file and the shareable report (HTML and PDF). Secrets are stored encrypted by design, so none may appear in readable form.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { SecretBox } from "../src/platform/secrets.js";
import { UserStore } from "../src/platform/user-store.js";
import { failedRun, FakeAgent, defaultCaps, viaInject } from "./fixtures/fake-agent.js";

const PORT = 5460;
const BASE = `http://127.0.0.1:${PORT}`;
/** Distinct, greppable values. The base32 ones are valid authenticator secrets. */
const SECRETS = {
    password: "LEAKCHECK-Password-7f3a91",
    totp: "KRSXG5CTMVRXEZLUKN2XGZLSOBXXK3DQ",
    apiToken: "LEAKCHECK-ApiToken-c41d82",
    userPassword: "LEAKCHECK-UserPw-5be07c",
    userToken: "LEAKCHECK-UserTok-2a9f63",
    adminPassword: "LEAKCHECK-AdminPw-d8e124",
    adminTotp: "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
    adminToken: "LEAKCHECK-AdminTok-91b7ea",
    // A named environment's own sign-in, token, authenticator secret and Authorization header (write-only, encrypted).
    envPassword: "LEAKCHECK-EnvPw-3c58f1",
    envToken: "LEAKCHECK-EnvTok-e7a204",
    envTotp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    envAuthHeader: "X-Env-Key: LEAKCHECK-EnvHdr-b19d36",
    // An email alert channel's own mail-server login (write-only, encrypted) and a Teams webhook address (a secret like Slack's).
    smtpUser: "LEAKCHECK-SmtpUser-6e0b17",
    smtpPassword: "LEAKCHECK-SmtpPw-a54c9d",
    teamsHook: "LEAKCHECK-TeamsHook-82f1b0",
    // The tokens of a Notion issue tracker and of a Sentry connection (write-only, encrypted).
    notionToken: "LEAKCHECK-NotionTok-4d7e61",
    sentryToken: "LEAKCHECK-SentryTok-b30a8f",
    // A run sent to a runner agent: the sign-in and API token travel in the task (encrypted at rest), the agent's own answer echoes
    // them, and the agent token itself (added at run time) is shown once and stored only as a hash.
    agentPassword: "LEAKCHECK-AgentPw-6a1d93",
    agentApiToken: "LEAKCHECK-AgentTok-f20c58",
    // The header value of a test data reset request (write-only, encrypted; frames-uploads-popups.md).
    resetHeader: "LEAKCHECK-ResetHdr-0d9b47",
};
const ALL = Object.values(SECRETS);

const sessions = new Map<string, string>();
const shell = (title: string, body: string, nav = '<a href="/login">Log in</a>') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><nav>${nav}</nav><h1>${title}</h1>${body}</body></html>`;
const readForm = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => resolve(new URLSearchParams(raw)));
    });
const ACCOUNTS: Record<string, { password: string; role: string }> = { "demo@example.com": { password: SECRETS.password, role: "member" }, "user@example.com": { password: SECRETS.userPassword, role: "user" }, "admin@example.com": { password: SECRETS.adminPassword, role: "admin" } };
const app = http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    const sid = /sid=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const role = sessions.get(sid);
    const html = (status: number, content: string, h: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "text/html", ...h }), res.end(content));
    const redirect = (to: string, h: Record<string, string> = {}) => (res.writeHead(302, { location: to, ...h }), res.end());
    if (req.method === "POST" && p === "/login") {
        const f = await readForm(req);
        const a = ACCOUNTS[f.get("email") ?? ""];
        if (!a || a.password !== f.get("password")) return html(401, shell("Sign in", '<p role="alert">Invalid email or password</p>'));
        const id = Math.random().toString(16).slice(2, 12).padEnd(10, "0");
        sessions.set(id, a.role);
        return redirect("/account", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }
    const nav = role ? '<a href="/account">Account</a> <a href="/admin/users">Users</a>' : '<a href="/login">Log in</a>';
    if (p === "/" || p === "/about") return html(200, shell(p === "/" ? "Acme Portal" : "About", "<p>Hello.</p>", nav));
    if (p === "/login") return html(200, shell("Sign in", '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>'));
    if (p === "/account") return role ? html(200, shell("Your account", "<p>Details.</p>", nav)) : redirect("/login");
    if (p === "/admin/users") return !role ? redirect("/login") : role === "admin" ? html(200, shell("User management", "<p>All users.</p>", nav)) : html(403, shell("Forbidden", "<p>Access denied.</p>", nav));
    if (p === "/api/admin/users") return req.headers.authorization === `Bearer ${SECRETS.adminToken}` ? (res.writeHead(200, { "content-type": "application/json" }), res.end("[]")) : (res.writeHead(403, { "content-type": "application/json" }), res.end("{}"));
    if (p === "/openapi.json") return (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ openapi: "3.0.0", info: { title: "t", version: "1" }, servers: [{ url: BASE }], paths: { "/api/admin/users": { get: { responses: { "200": { description: "ok" } } } } } })));
    // Failure evidence: a page that puts the password (typed in by the test) into a request address, the console and a response header.
    if (p === "/evidence-leak") return html(200, shell("Password check", '<label for="pw">Password</label> <input id="pw" type="password"> <button id="go">Check</button><p id="msg" role="status"></p><script>document.getElementById("go").onclick = async () => { const pw = document.getElementById("pw").value; console.log("typed " + pw); const r = await fetch("/api/evidence-echo?u=" + encodeURIComponent(pw) + "&password=" + encodeURIComponent(pw)); document.getElementById("msg").textContent = r.ok ? "Accepted" : "Rejected"; };</script>', nav));
    if (p === "/api/evidence-echo") return (res.writeHead(401, { "content-type": "application/json", "x-echo": new URL(req.url ?? "/", "http://x").searchParams.get("u") ?? "" }), res.end("{}"));
    html(404, shell("Not found", "", nav));
});

let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let startedAt: number;
const answers: string[] = [];

const call = async (method: "GET" | "PUT" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    const text = res.rawPayload.toString("latin1");
    answers.push(`${method} ${url}\n${text}`);
    return { status: res.statusCode, body: res.headers["content-type"]?.toString().includes("json") ? JSON.parse(res.body) : null, raw: res.rawPayload };
};

beforeAll(async () => {
    startedAt = Date.now() - 1000;
    await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-leak-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 30_000);
afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => app.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function filesUnder(dir: string, since = 0): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesUnder(full, since));
        else if (fs.statSync(full).mtimeMs >= since) out.push(full);
    }
    return out;
}
/** Which secrets appear (as text, in any common encoding) in these bytes? */
function leaksIn(bytes: Buffer): string[] {
    const forms = [bytes.toString("latin1"), bytes.toString("utf16le")];
    return Object.entries(SECRETS).filter(([, v]) => forms.some((f) => f.includes(v)) || bytes.includes(Buffer.from(v).toString("base64").slice(0, 16))).map(([k]) => k);
}

describe("secrets never leave the encrypted store", () => {
    let projectId = "";
    let testIds: string[] = [];

    it("runs a real job with secrets in every place a secret can be entered", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Leak audit" })).body.id as string;
        expect((await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "user", username: "user@example.com", password: SECRETS.userPassword, apiToken: SECRETS.userToken }, { name: "admin", username: "admin@example.com", password: SECRETS.adminPassword, totpSecret: SECRETS.adminTotp, apiToken: SECRETS.adminToken }] })).status).toBe(200);
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
            url: BASE,
            targets: ["web", "api"],
            credentials: { username: "demo@example.com", password: SECRETS.password, totpSecret: SECRETS.totp, apiToken: SECRETS.apiToken },
            performanceChecks: true,
            visual: true,
        });
        expect(queued.status).toBe(202);
        for (let i = 0; i < 720; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; suite: string }>;
        testIds = tests.map((t) => t.id);
        // the audit is only meaningful if the job really produced the things that could leak
        expect(tests.length).toBeGreaterThan(5);
        expect(tests.some((t) => t.suite === "Access control")).toBe(true);

        // A named environment with every kind of secret, and a real run against it: the secrets reach the scripts
        // (as environment variables of the run) and must leave no trace anywhere else.
        const env = await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: BASE, variables: { REGION: "eu" } });
        expect(env.status).toBe(201);
        const secrets = await call("PUT", `/api/projects/${projectId}/environments/staging/secrets`, { username: "env-user@example.com", password: SECRETS.envPassword, totpSecret: SECRETS.envTotp, apiToken: SECRETS.envToken, apiAuthHeader: SECRETS.envAuthHeader });
        expect(secrets.body).toMatchObject({ hasPassword: true, hasTotp: true, hasApiToken: true, hasApiAuthHeader: true });
        const envRun = await call("POST", `/api/projects/${projectId}/environments/staging/runs`, { testIds: tests.slice(0, 4).map((t) => t.id) });
        expect(envRun.status).toBe(202);
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${envRun.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        expect((await call("GET", `/api/test-generation/${envRun.body.jobId}`)).body.mode).toBe("environment");
    }, 720_000);

    it("a deploy trigger: the token (hashed) and the callback address (encrypted) are stored and shown nowhere else", async () => {
        // A small project of its own, so the run is quick. Calls that carry the token in their address are made directly (the
        // helper above would record the address as an "answer"); what they return is added to the audited answers.
        const small = (await call("POST", "/api/projects", { name: "Trigger audit" })).body.id as string;
        const imp = await call("POST", `/api/projects/${small}/specs`, { baseUrl: BASE, specs: [{ title: "About page answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/about" }, { action: "assertResponse", check: "status", expected: 200 }] }] });
        expect(imp.status).toBe(202);
        for (let i = 0; i < 120; i++) {
            const j = (await call("GET", `/api/test-generation/${imp.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        const made = await server.inject({ method: "POST", url: `/api/projects/${small}/triggers`, payload: { label: "audit" } });
        const token = (JSON.parse(made.body) as { token: string }).token;
        (SECRETS as Record<string, string>).triggerToken = token; // shown once, in the answer above, and never again
        const run = await server.inject({ method: "POST", url: `/api/triggers/${token}/run`, payload: { commit: "abc1234", callbackUrl: `${BASE}/hook?k=LEAKCHECK-Callback-8d2f55` } });
        expect(run.statusCode).toBe(202);
        (SECRETS as Record<string, string>).callbackAddress = "LEAKCHECK-Callback-8d2f55";
        answers.push(`POST /api/triggers/[token]/run\n${run.body}`);
        for (let i = 0; i < 120; i++) {
            const s = await server.inject({ method: "GET", url: `/api/triggers/${token}/status/${JSON.parse(run.body).jobId}` });
            answers.push(`GET /api/triggers/[token]/status\n${s.body}`);
            if (JSON.parse(s.body).finished) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        await call("GET", `/api/projects/${small}/triggers`);
        await call("GET", `/api/projects/${small}/jobs`);
    }, 120_000);

    it("alert channels: the mail-server login and the Teams address are stored encrypted and shown nowhere", async () => {
        // Nothing listens on these ports: creating a channel never connects, and the test messages fail, which writes the alert log.
        const email = await call("POST", `/api/projects/${projectId}/alert-channels`, { kind: "email", recipients: ["qa@example.test"], smtp: { host: "127.0.0.1", port: 5679, from: "alerts@example.test", username: SECRETS.smtpUser, password: SECRETS.smtpPassword } });
        expect(email.status).toBe(201);
        expect(email.body.smtp).toMatchObject({ hasLogin: true });
        const teams = await call("POST", `/api/projects/${projectId}/alert-channels`, { kind: "teams", url: `http://127.0.0.1:5679/workflows/${SECRETS.teamsHook}` });
        expect(teams.status).toBe(201);
        for (const ch of [email.body, teams.body]) expect((await call("POST", `/api/projects/${projectId}/alert-channels/${ch.id}/test`)).body.ok).toBe(false);
        await call("PATCH", `/api/projects/${projectId}/alert-channels/${email.body.id}`, { smtp: { password: SECRETS.smtpPassword } });
    }, 60_000);

    it("a Notion tracker and a Sentry connection: their tokens are stored encrypted and shown nowhere", async () => {
        // verify: false keeps this offline: nothing is sent to notion.com or sentry.io.
        const notion = await call("POST", `/api/projects/${projectId}/integrations`, { kind: "notion", databaseId: "a1b2c3d4e5f64789abc0123456789abc", token: SECRETS.notionToken, verify: false });
        expect(notion.status).toBe(201);
        expect(notion.body.config).toMatchObject({ kind: "notion", titleProperty: "Name" });
        await call("PATCH", `/api/integrations/${notion.body.id}`, { token: SECRETS.notionToken });
        const sentry = await call("PUT", `/api/projects/${projectId}/sentry`, { organization: "acme", project: "shop", token: SECRETS.sentryToken, verify: false });
        expect(sentry.status).toBe(201);
        expect(sentry.body.connection).toMatchObject({ organization: "acme", project: "shop" });
        await call("GET", `/api/projects/${projectId}/sentry`);
        // Sentry is not a tracker: only the Notion connection is listed there.
        expect((await call("GET", `/api/projects/${projectId}/integrations`)).body.map((i: { kind: string }) => i.kind)).toEqual(["notion"]);
    });

    it("a device farm connection: its access key is stored encrypted and shown nowhere (device-farms.md)", async () => {
        // Nothing is sent to the provider: creating and listing a connection makes no outbound call.
        const farmKey = "LEAKCHECK-FarmKey-4c7e02";
        (SECRETS as Record<string, string>).farmKey = farmKey;
        const farm = await call("POST", `/api/projects/${projectId}/device-farms`, { provider: "browserstack", label: "Team farm", username: "leakcheck_user", accessKey: farmKey, devices: [{ name: "Google Pixel 8", osVersion: "14" }] });
        expect(farm.status).toBe(201);
        expect(farm.body.credentialsSet).toBe(true);
        await call("PUT", `/api/projects/${projectId}/device-farms/${farm.body.id}`, { accessKey: farmKey });
        await call("GET", `/api/projects/${projectId}/device-farms`);
    });

    it("a test data reset request: its header value is stored encrypted and shown nowhere (frames-uploads-popups.md)", async () => {
        // Saving and listing send nothing to the application.
        const saved = await call("PUT", `/api/projects/${projectId}/test-data-reset`, { enabled: false, method: "POST", url: "/test/reset", expectedStatus: 204, headers: [{ name: "X-Reset-Token", value: SECRETS.resetHeader }] });
        expect(saved.status).toBe(200);
        expect(saved.body.headerNames).toEqual(["X-Reset-Token"]);
        await call("GET", `/api/projects/${projectId}/test-data-reset`);
    });

    it("hard sign-ins: a saved session's cookie, the test mailbox password and forwarded mail are stored encrypted and shown nowhere (hard-sign-ins.md)", async () => {
        // A project of its own: a saved session would make this project's later runs check it first.
        Object.assign(SECRETS as Record<string, string>, { sessionCookie: "LEAKCHECK-SessionCookie-5b1d93", imapPassword: "LEAKCHECK-ImapPass-27c4e8", mailCode: "LEAKCHECK-MailBody-81f0a6" });
        const hs = (await call("POST", "/api/projects", { name: "Hard sign-ins" })).body.id as string;
        await call("POST", `/api/projects/${hs}/specs`, { baseUrl: BASE, validate: false, specs: [{ title: "Home opens", kind: "web", steps: [{ action: "navigate", url: "/" }] }] });
        const state = { cookies: [{ name: "sid", value: (SECRETS as Record<string, string>).sessionCookie, domain: new URL(BASE).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] };
        expect((await call("PUT", `/api/projects/${hs}/sessions/main`, { storageState: state })).status).toBe(200);
        expect((await call("PUT", `/api/projects/${hs}/mailbox`, { kind: "imap", imap: { host: "127.0.0.1", port: 5679, tls: false, user: "qa@example.test", password: (SECRETS as Record<string, string>).imapPassword } })).status).toBe(200);
        await call("GET", `/api/projects/${hs}/hard-sign-in`);
        const inbound = await call("PUT", `/api/projects/${hs}/mailbox`, { kind: "inbound" });
        expect((await call("POST", inbound.body.inboundPath, { to: "qa@example.test", subject: "Code", text: `Your code: ${(SECRETS as Record<string, string>).mailCode}` })).status).toBe(202);
        await call("GET", `/api/projects/${hs}/hard-sign-in`);
    });

    it("a run on a runner agent: the task carries the credentials, the agent's answer echoes them, and they are stored nowhere readable (the token only as a hash)", async () => {
        const small = (await call("POST", "/api/projects", { name: "Agent audit" })).body.id as string;
        const imp = await call("POST", `/api/projects/${small}/specs`, { baseUrl: BASE, validate: false, credentials: { username: "agent@example.com", password: SECRETS.agentPassword, apiToken: SECRETS.agentApiToken }, specs: [{ title: "About page answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/about" }, { action: "assertResponse", check: "status", expected: 200 }] }] });
        expect(imp.status).toBe(202);
        const testId = imp.body.tests[0].id as string;
        const made = await server.inject({ method: "POST", url: `/api/projects/${small}/agent-tokens`, payload: { label: "audit" } });
        const secret = (JSON.parse(made.body) as { secret: string }).secret;
        (SECRETS as Record<string, string>).agentToken = secret; // shown once, in the answer above, and never again
        const agent = new FakeAgent(viaInject(server), secret, { name: "audit-agent", capabilities: defaultCaps() });
        expect((await agent.hello()).status).toBe(200);
        expect((await call("PUT", `/api/projects/${small}/runner`, { runOn: "agent" })).status).toBe(200);
        const started = await call("POST", `/api/tests/${testId}/validate`);
        expect(started.status).toBe(202);
        const offer = (await agent.next(30_000))!;
        expect(offer.env.credentials?.password).toBe(SECRETS.agentPassword); // the agent really received it
        await agent.upload(offer.taskId, "shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
        const echoed = `HTTP 500 for ${SECRETS.agentPassword} with token ${SECRETS.agentApiToken}`;
        expect((await agent.result(offer.taskId, { ok: true, runs: [failedRun(offer.scripts[0]!.testId, echoed, { artifacts: [{ kind: "screenshot", ref: "shot.png" }], responses: [{ method: "GET", path: "/about", status: 500, obs: { echoed } }] })] })).status).toBe(200);
        for (let i = 0; i < 120; i++) {
            const j = (await call("GET", `/api/test-generation/${started.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        testIds.push(testId);
        await call("GET", `/api/test-generation/${started.body.jobId}/events`);
        await call("GET", `/api/projects/${small}/agents`);
        await call("GET", `/api/projects/${small}/agent-tokens`);
        await call("GET", `/api/projects/${small}/runner`);
        await call("GET", `/api/projects/${small}/cleanup`);
        // the run really stored the (scrubbed) failure
        const ex = (await call("GET", `/api/tests/${testId}/executions`)).body as Array<{ status: string; error: string }>;
        expect(ex[0]!.status).toBe("failed");
        expect(ex[0]!.error).toContain("[hidden]");
    }, 90_000);

    it("failure evidence: the password a failing web test types is hidden in the recorded address, console and everywhere stored (the page also sent it in a response header, which is never recorded)", async () => {
        // Imported without credentials of its own: it runs with the project's sign-in, i.e. with SECRETS.password.
        const imp = await call("POST", `/api/projects/${projectId}/specs`, {
            specs: [{ title: "The password check accepts the password", kind: "web", category: "Evidence", steps: [{ action: "navigate", url: "/evidence-leak" }, { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" }, { action: "click", locator: { by: "role", role: "button", value: "Check", exact: true } }, { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Accepted" }] }],
        });
        expect(imp.status).toBe(202);
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${imp.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        testIds.push(imp.body.tests[0].id);
        const ev = await call("GET", `/api/tests/${imp.body.tests[0].id}/evidence`);
        // the run really recorded the request and the console line, with the password hidden
        expect(ev.body.available).toBe(true);
        expect(ev.body.evidence.requests.find((r: { path: string }) => r.path.startsWith("/api/evidence-echo"))).toMatchObject({ path: "/api/evidence-echo?u=[hidden]&password=[hidden]", status: 401 });
        expect(ev.body.evidence.console.map((c: { text: string }) => c.text)).toContain("typed [hidden]");
        expect(ev.raw.toString("latin1")).not.toContain(SECRETS.password);
    }, 120_000);

    it("keeps secrets out of every API answer about the project, its tests, runs, events and exports", async () => {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string }>;
        for (const j of jobs) await call("GET", `/api/test-generation/${j.jobId}/events`);
        for (const path of ["", "/tests", "/suites", "/specs", "/roles", "/jobs", "/application-model", "/compliance", "/performance", "/api-changes", "/trends", "/flaky", "/alert-log", "/alert-channels", "/alert-options", "/integrations", "/sentry", "/schedules", "/junit", "/environments", "/environments/staging/results", "/test-data", "/storage", "/retention", "/report?format=html"]) await call("GET", `/api/projects/${projectId}${path}`);
        for (const id of testIds) {
            await call("GET", `/api/tests/${id}`);
            await call("GET", `/api/tests/${id}/script`);
            await call("GET", `/api/tests/${id}/executions`);
            await call("GET", `/api/tests/${id}/performance`);
            await call("GET", `/api/tests/${id}/evidence`);
        }
        const zip = await call("GET", `/api/projects/${projectId}/download?includeUnvalidated=true`);
        expect(zip.status).toBe(200);
        for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip.raw)))) answers.push(`zip:${name}\n${strFromU8(bytes)}`);
        // the project backup (no secrets by design) and the platform storage view
        const backup = await call("GET", `/api/projects/${projectId}/backup`);
        expect(backup.status).toBe(200);
        for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(backup.raw)))) answers.push(`backup:${name}\n${strFromU8(bytes)}`);
        await call("GET", "/api/storage");
        const pdf = await call("GET", `/api/projects/${projectId}/report?format=pdf`);
        expect(pdf.raw.subarray(0, 5).toString()).toBe("%PDF-");
        answers.push(`pdf-text\n${(await extractText(await getDocumentProxy(new Uint8Array(pdf.raw)), { mergePages: true })).text}`);

        expect(answers.length).toBeGreaterThan(40);
        const leaked = answers.flatMap((a) => leaksIn(Buffer.from(a, "latin1")).map((s) => `${s} in ${a.split("\n")[0]}`));
        expect(leaked).toEqual([]);
    }, 300_000);

    it("keeps secrets out of the database, its journal, stored scripts and evidence (they are encrypted at rest)", () => {
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const leaked = filesUnder(dataDir).flatMap((f) => leaksIn(fs.readFileSync(f)).map((s) => `${s} in ${path.relative(dataDir, f)}`));
        expect(leaked).toEqual([]);
        expect(filesUnder(dataDir).some((f) => f.endsWith("platform.db"))).toBe(true);
    });

    it("keeps secrets out of the scratch directories the scripts ran from, and artifacts they wrote", () => {
        const scratch = path.join(REPO_ROOT, ".validation");
        const files = fs.existsSync(scratch) ? filesUnder(scratch, startedAt).filter((f) => !/\.(mp4|webm|zip)$/i.test(f)) : [];
        expect(files.length).toBeGreaterThan(0); // the scripts really ran from here
        const leaked = files.flatMap((f) => leaksIn(fs.readFileSync(f)).map((s) => `${s} in ${path.relative(scratch, f)}`));
        expect(leaked).toEqual([]);
    });

    it("did store them, encrypted, so the audit above proves something (the platform can decrypt them)", async () => {
        const roles = (platform as unknown as { repo: unknown }).repo as { db: { get: (sql: string, ...p: unknown[]) => { roles_enc: string } | undefined } };
        const row = roles.db.get("SELECT roles_enc FROM project_roles WHERE project_id = ?", projectId);
        expect(row?.roles_enc).toBeTruthy();
        expect(row!.roles_enc).not.toContain("admin@example.com");
        const app = (await call("GET", `/api/projects/${projectId}`)).body;
        expect(app.application.hasCredentials).toBe(true);
        expect(JSON.stringify(app)).not.toContain("demo@example.com");
    });

    it("people and access: a password, a personal API token, a session and the single sign-on client secret are kept only as hashes or encrypted (people-and-access.md)", async () => {
        // Last on purpose: once a person exists, this platform asks everyone to sign in.
        const s = SECRETS as Record<string, string>;
        s.personPassword = "LEAKCHECK-PersonPw-71c0e5";
        s.ssoSecret = "LEAKCHECK-SsoSecret-0d93b4";
        const users = new UserStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY));
        const person = users.create({ email: "leak@example.com", name: "Leak", role: "owner", passwordHash: await hashPassword(s.personPassword) });
        users.saveSso({ issuer: "https://login.example.com", clientId: "c", allowedDomain: "example.com", defaultRole: "viewer", label: "" }, s.ssoSecret);
        s.personToken = users.createToken(person.id, { name: "leak", role: "owner" }).token;
        s.sessionValue = users.createSession(person.id, "password").token;
        expect(users.ssoSecret()).toBe(s.ssoSecret); // stored, and readable by the platform only
        const replies: string[] = [];
        for (const url of ["/api/users", "/api/sso-settings", "/api/me/tokens", "/api/auth/state", "/api/activity"]) {
            const r = await server.inject({ method: "GET", url, headers: { "x-api-key": s.personToken } });
            expect(r.statusCode, url).toBe(200);
            replies.push(r.body);
        }
        expect(replies.flatMap((a) => leaksIn(Buffer.from(a, "latin1")))).toEqual([]);
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const leaked = filesUnder(dataDir).flatMap((f) => leaksIn(fs.readFileSync(f)).map((k) => `${k} in ${path.relative(dataDir, f)}`));
        expect(leaked).toEqual([]);
    });
});

describe("the audit itself", () => {
    it("would notice a leak: planted secrets are found as plain text, UTF-16 and base64, and clean bytes pass", () => {
        for (const [key, value] of Object.entries(SECRETS)) {
            expect(leaksIn(Buffer.from(`prefix ${value} suffix`, "latin1")), key).toContain(key);
            expect(leaksIn(Buffer.from(`prefix ${value} suffix`, "utf16le")), key).toContain(key);
            expect(leaksIn(Buffer.from(`token=${Buffer.from(value).toString("base64")}`)), key).toContain(key);
        }
        expect(leaksIn(Buffer.from("nothing secret here, just words and numbers 12345"))).toEqual([]);
    });
});
