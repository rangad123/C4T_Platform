/**
 * Alert channels for Microsoft Teams and email, against local receivers: a fake Teams webhook (checks the Adaptive Card
 * payload) and a fake SMTP server (checks the message that arrives, the login, retries and refusals). Browser-free.
 * Ports 5670 (Teams receiver), 5676 (SMTP), 5677 (SMTP for the server-wide settings); 5679 is left closed on purpose.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { buildEmail, serverSmtp } from "../src/platform/alert-email.js";
import { teamsPayload } from "../src/platform/alerts.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { parseMail, startFakeSmtp, type FakeSmtp } from "./fixtures/fake-smtp.js";

const TEAMS_PORT = 5670;
const SMTP_PORT = 5676;
const SERVER_SMTP_PORT = 5677;
const DEAD_PORT = 5679;
const PUBLIC_URL = "https://qa.example.test";
const TEAMS_URL = `http://127.0.0.1:${TEAMS_PORT}/workflows/very-secret-teams-token-77`;
const SMTP_USER = "smtp-login-sentinel-user";
const SMTP_PASS = "SMTP-Sentinel-Pw-91c4";
const SERVER_USER = "server-login-sentinel-user";
const SERVER_PASS = "SERVER-Sentinel-Pw-3b7e";

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let teams: http.Server;
let smtp: FakeSmtp;
const posted: any[] = [];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-notify-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: `${PUBLIC_URL}/`, ALERT_MIN_SEVERITY: "low" }));
    svc = getScheduleServices(platform, { delivery: { backoffMs: [5, 5], timeoutMs: 2_000 } });
    server = await buildServer(platform);
    teams = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            posted.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            res.writeHead(202).end("1");
        });
    });
    await new Promise<void>((r) => teams.listen(TEAMS_PORT, "127.0.0.1", r));
    smtp = await startFakeSmtp(SMTP_PORT);
}, 30_000);

afterAll(async () => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    teams?.close();
    await smtp?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    posted.length = 0;
    smtp.mails.length = 0;
    smtp.commands.length = 0;
    smtp.requireAuth = undefined;
    smtp.rejectRcpt = undefined;
    smtp.failNext = 0;
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.body };
};

// ── seeding a finished run, the way the worker leaves it ────────────────────

const repo = () => platform.repo;
const framework = defaultFramework("api");
let seq = 0;
const T0 = Date.now() - 5 * 86_400_000;
const at = (n: number) => new Date(T0 + n * 60_000).toISOString();

function seedProject(name: string) {
    const project = repo().createProject({ name });
    const appId = repo().createApplication(project.id, `http://127.0.0.1:${TEAMS_PORT}`, { ...DEFAULT_JOB_OPTIONS });
    return { projectId: project.id, appId, tests: new Map<string, string>(), scripts: new Map<string, string>() };
}
type Seed = ReturnType<typeof seedProject>;

function addTest(s: Seed, key: string, title: string): void {
    const spec = TestSpecSchema.parse({ testId: key, title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
    const id = repo().insertTest({ projectId: s.projectId, suiteId: repo().getOrCreateSuite(s.projectId, "API", "api"), jobId: null, spec, framework, validationStatus: "PENDING" });
    s.tests.set(key, id);
    s.scripts.set(key, repo().addScript(id, { framework, filename: `${key}.spec.ts`, content: "v1", hash: `h-${key}`, storagePath: `x/${key}`, executable: true }));
}

async function seedRun(s: Seed, outcomes: Record<string, "pass" | "fail">) {
    const job = await repo().createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [...s.tests.values()], trigger: "schedule" });
    repo().setJobStatus(job.id, Object.values(outcomes).includes("fail") ? "PARTIALLY_COMPLETED" : "COMPLETED");
    const start = ++seq * 10;
    repo().db.run("UPDATE generation_jobs SET started_at = ?, finished_at = ? WHERE id = ?", at(start), at(start + 5), job.id);
    let tick = start;
    for (const [key, o] of Object.entries(outcomes)) {
        const id = s.tests.get(key)!;
        const exec = repo().addExecution({ testId: id, scriptId: s.scripts.get(key)!, jobId: job.id, attempt: 1, status: o === "pass" ? "passed" : "failed", durationMs: 5, error: o === "fail" ? "boom" : undefined, startedAt: at(tick), steps: [] });
        repo().db.run("UPDATE test_executions SET started_at = ?, finished_at = ? WHERE id = ?", at(tick), at(tick), exec);
        tick++;
        repo().updateTest(id, o === "pass" ? { validationStatus: "VALIDATED", reason: null } : { validationStatus: "FAILED_VALIDATION", reason: "Step failed: element not found" });
    }
    await svc.onJobFinished(repo().getJob(job.id)!);
    await svc.flush();
}

const ownSmtp = (extra: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: SMTP_PORT, from: "alerts@platform.test", username: SMTP_USER, password: SMTP_PASS, ...extra });
const mailChannel = async (s: Seed, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "email", recipients: ["qa@example.test", "lead@example.test"], smtp: ownSmtp(), ...extra });
    expect(r.status, r.raw).toBe(201);
    return r.body as { id: string };
};
const sendTest = async (s: Seed, channelId: string) => (await call("POST", `/api/projects/${s.projectId}/alert-channels/${channelId}/test`)).body as { ok: boolean; error: string | null; attempts: number };

// ───────────────────────────────────────────────────────────────────────────

describe("Microsoft Teams", () => {
    it("sends an Adaptive Card in the message format Teams Workflows webhooks accept", async () => {
        const s = seedProject("Teams shop");
        const made = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "teams", url: TEAMS_URL, name: "Teams QA" });
        expect(made.status, made.raw).toBe(201);
        expect(made.body).toMatchObject({ kind: "teams", name: "Teams QA", host: `127.0.0.1:${TEAMS_PORT}`, enabled: true });
        // the address is a secret: only the host is ever shown
        expect(made.raw).not.toContain("very-secret-teams-token-77");

        const r = (await call("POST", `/api/projects/${s.projectId}/alert-channels/${made.body.id}/test`)).body;
        expect(r).toMatchObject({ ok: true, httpStatus: 202 });
        expect(posted).toHaveLength(1);
        expect(posted[0].url).toBe("/workflows/very-secret-teams-token-77");
        expect(posted[0].headers["content-type"]).toContain("application/json");
        const msg = posted[0].body;
        expect(msg.type).toBe("message");
        expect(msg.attachments).toHaveLength(1);
        expect(msg.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
        const card = msg.attachments[0].content;
        expect(card).toMatchObject({ type: "AdaptiveCard", version: "1.4", $schema: "http://adaptivecards.io/schemas/adaptive-card.json" });
        expect(card.body[0]).toMatchObject({ type: "TextBlock", text: "Test message: Teams shop", weight: "Bolder", wrap: true });
        expect(card.body.every((b: { type: string; text?: string }) => b.type === "TextBlock" && typeof b.text === "string")).toBe(true);
        expect(card.actions).toEqual([{ type: "Action.OpenUrl", title: "Open project", url: `${PUBLIC_URL}/#/projects/${s.projectId}` }]);
        const log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body;
        expect(log[0]).toMatchObject({ channelKind: "teams", status: "sent", event: "test", httpStatus: 202 });
    });

    it("tells about a failing run with the same content as Slack, and keeps findings from turning into links", async () => {
        const s = seedProject("Teams run");
        addTest(s, "API-001", "Checkout [click](https://evil.test) *works*");
        addTest(s, "API-002", "Search answers");
        await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "teams", url: TEAMS_URL });
        await seedRun(s, { "API-001": "fail", "API-002": "pass" });
        expect(posted).toHaveLength(1);
        const card = posted[0].body.attachments[0].content;
        const texts = card.body.map((b: { text?: string; facts?: unknown }) => b.text ?? "").join("\n");
        expect(card.body[0].text).toMatch(/^(Regression found|Test run failed): Teams run$/);
        expect(card.body.find((b: { type: string }) => b.type === "FactSet").facts).toEqual(expect.arrayContaining([{ title: "Passed", value: "1 of 2 (50%)" }, { title: "Failing", value: "1" }]));
        expect(texts).toContain("Top findings");
        // markdown characters are escaped, so the title cannot become a link or emphasis
        expect(texts).toContain("Checkout \\[click\\]\\(https://evil.test\\) \\*works\\*");
        expect(texts).not.toMatch(/(^|[^\\])\[click\]\(/);
    });

    it("refuses a private address when the platform blocks them", async () => {
        const s = seedProject("Teams guard");
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        expect((await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "teams", url: TEAMS_URL })).status).toBe(400);
    });

    it("builds the card from plain content (unit)", () => {
        const card = teamsPayload({ title: "T", headline: "H", subjectDetail: "", facts: [], findingsHeading: "", findings: [], link: "https://x.test/" }) as any;
        expect(card.attachments[0].content.body).toHaveLength(2);
        expect(card.attachments[0].content.body.some((b: { type: string }) => b.type === "FactSet")).toBe(false);
    });
});

describe("email channels: creating", () => {
    it("explains what to set when no mail server is configured", async () => {
        const s = seedProject("Mail setup");
        const r = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "email", recipients: ["qa@example.test"] });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/SMTP_HOST/);
        expect(r.body.error).toMatch(/SMTP_FROM/);
        expect((await call("GET", `/api/projects/${s.projectId}/alert-options`)).body).toEqual({ email: { serverMail: null, maxRecipients: 10 } });
    });

    it("validates recipients and mail settings", async () => {
        const s = seedProject("Mail validation");
        const post = (body: Record<string, unknown>) => call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "email", smtp: ownSmtp(), ...body });
        expect((await post({ recipients: ["not-an-address"] })).status).toBe(400);
        expect((await post({ recipients: [] })).status).toBe(400);
        expect((await post({})).status).toBe(400);
        expect((await post({ recipients: Array.from({ length: 11 }, (_, i) => `u${i}@example.test`) })).status).toBe(400);
        expect((await post({ recipients: ["a@example.test\r\nBcc: x@example.test"] })).status).toBe(400);
        expect((await post({ recipients: ["a@example.test"], smtp: ownSmtp({ host: "http://mail.test" }) })).status).toBe(400);
        expect((await post({ recipients: ["a@example.test"], smtp: ownSmtp({ port: 70000 }) })).status).toBe(400);
        expect((await post({ recipients: ["a@example.test"], smtp: ownSmtp({ from: "nobody" }) })).status).toBe(400);
        expect((await post({ recipients: ["a@example.test"], smtp: { ...ownSmtp(), surprise: true } })).status).toBe(400);
        // ten is allowed; duplicates (any case) collapse
        const ten = await post({ recipients: Array.from({ length: 10 }, (_, i) => `u${i}@example.test`) });
        expect(ten.status).toBe(201);
        const dup = await post({ recipients: ["A@example.test", "a@EXAMPLE.test", "b@example.test"] });
        expect(dup.body.recipients).toEqual(["A@example.test", "b@example.test"]);
    });

    it("refuses a mail server on a private address when the platform blocks them", async () => {
        const s = seedProject("Mail guard");
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        const r = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "email", recipients: ["a@example.test"], smtp: ownSmtp() });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/private/i);
    });

    it("never shows the login, only that there is one", async () => {
        const s = seedProject("Mail secrets");
        const made = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "email", recipients: ["qa@example.test"], smtp: ownSmtp() });
        expect(made.body).toMatchObject({ kind: "email", name: "Email to qa@example.test", host: "qa@example.test", recipients: ["qa@example.test"], smtp: { source: "channel", host: "127.0.0.1", port: SMTP_PORT, secure: false, from: "alerts@platform.test", hasLogin: true } });
        const texts = [made.raw, (await call("GET", `/api/projects/${s.projectId}/alert-channels`)).raw, (await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${made.body.id}`, { enabled: false })).raw];
        for (const t of texts) for (const secret of [SMTP_USER, SMTP_PASS]) expect(t).not.toContain(secret);
        // stored encrypted: readable only by the platform
        const row = platform.db.get<{ url_enc: string; url_host: string }>("SELECT url_enc, url_host FROM alert_channels WHERE id = ?", made.body.id)!;
        expect(row.url_enc + row.url_host).not.toContain(SMTP_PASS);
        expect(row.url_enc).not.toContain(SMTP_USER);
        expect(svc.alertStore.emailOf(made.body.id).smtp).toMatchObject({ user: SMTP_USER, password: SMTP_PASS });
    });
});

describe("email channels: delivery to a fake SMTP server", () => {
    it("sends a test message with the project name, the recipients and no secrets", async () => {
        const s = seedProject("Mail shop");
        smtp.requireAuth = { user: SMTP_USER, pass: SMTP_PASS };
        const ch = await mailChannel(s);
        const r = await sendTest(s, ch.id);
        expect(r).toMatchObject({ ok: true, attempts: 1, error: null });
        expect(smtp.mails).toHaveLength(1);
        const mail = smtp.mails[0]!;
        expect(mail).toMatchObject({ from: "alerts@platform.test", to: ["qa@example.test", "lead@example.test"], user: SMTP_USER, pass: SMTP_PASS });
        const parsed = parseMail(mail.data);
        expect(parsed.headers.subject).toBe("Test message: Mail shop");
        expect(parsed.headers["auto-submitted"]).toBe("auto-generated");
        expect(parsed.text).toContain("This is a test message from the AI Testing Platform for Mail shop");
        expect(parsed.text).toContain(`${PUBLIC_URL}/#/projects/${s.projectId}`);
        expect(parsed.html).toContain("<h1");
        expect(parsed.html).toContain(`href="${PUBLIC_URL}/#/projects/${s.projectId}"`);
        // neither the login nor the password is in the message (headers or either body)
        for (const secret of [SMTP_USER, SMTP_PASS]) expect(mail.data + parsed.text + parsed.html).not.toContain(secret);
        const log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body;
        expect(log[0]).toMatchObject({ channelKind: "email", status: "sent", event: "test", attempts: 1 });
    });

    it("tells about a failing run: subject with project and status, escaped content, and not again for the same failure", async () => {
        const s = seedProject("Mail run");
        addTest(s, "API-001", "Checkout <script>alert(1)</script> & more");
        addTest(s, "API-002", "Search answers");
        await mailChannel(s);
        await seedRun(s, { "API-001": "fail", "API-002": "pass" });
        expect(smtp.mails).toHaveLength(1);
        const parsed = parseMail(smtp.mails[0]!.data);
        expect(parsed.headers.subject).toMatch(/^(Regression found|Test run failed): Mail run \(1 of 2 passed\)$/);
        expect(parsed.text).toContain("Passed: 1 of 2 (50%)");
        expect(parsed.text).toContain("Checkout <script>alert(1)</script> & more");
        // the HTML version escapes it, so it cannot run in a mail client
        expect(parsed.html).toContain("Checkout &lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
        expect(parsed.html).not.toContain("<script>");
        // the same failure again is not announced again
        await seedRun(s, { "API-001": "fail", "API-002": "pass" });
        expect(smtp.mails).toHaveLength(1);
    });

    it("keeps a project name from adding mail headers", () => {
        const mail = buildEmail({ title: "Test run failed: Evil\r\nBcc: x@example.test", headline: "h", subjectDetail: "", facts: [], findingsHeading: "", findings: [], link: "https://x.test/" });
        expect(mail.subject).toBe("Test run failed: Evil Bcc: x@example.test");
        expect(mail.subject).not.toMatch(/[\r\n]/);
    });

    it("says plainly when the sign-in is refused, tries once, and never logs the password", async () => {
        const s = seedProject("Mail auth");
        smtp.requireAuth = { user: SMTP_USER, pass: "a-different-password" };
        const ch = await mailChannel(s);
        const r = await sendTest(s, ch.id);
        expect(r).toMatchObject({ ok: false, attempts: 1 });
        expect(r.error).toBe("The mail server refused the sign-in. Check the user name and password.");
        expect(smtp.mails).toHaveLength(0);
        const log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body;
        expect(log[0]).toMatchObject({ status: "failed", channelKind: "email" });
        expect(JSON.stringify(log)).not.toContain(SMTP_PASS);
        expect(JSON.stringify(log)).not.toContain(SMTP_USER);
    });

    it("demands a login when the server does: a channel without one is refused", async () => {
        const s = seedProject("Mail no login");
        smtp.requireAuth = { user: SMTP_USER, pass: SMTP_PASS };
        const ch = await mailChannel(s, { smtp: ownSmtp({ username: undefined, password: undefined }) });
        const r = await sendTest(s, ch.id);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/refused/);
        expect(smtp.mails).toHaveLength(0);
    });

    it("retries a temporary failure and then delivers once", async () => {
        const s = seedProject("Mail retry");
        addTest(s, "API-001", "Checkout works");
        await mailChannel(s);
        smtp.failNext = 1;
        await seedRun(s, { "API-001": "fail" });
        expect(smtp.mails).toHaveLength(1);
        const log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body;
        expect(log[0]).toMatchObject({ status: "sent", attempts: 2 });
    });

    it("a test message is tried once, so the answer is the real one", async () => {
        const s = seedProject("Mail once");
        const ch = await mailChannel(s);
        smtp.failNext = 1;
        const r = await sendTest(s, ch.id);
        expect(r).toMatchObject({ ok: false, attempts: 1 });
        expect(r.error).toMatch(/try again later \(SMTP 451\)/);
    });

    it("reports a refused recipient without retrying, and an unreachable server in plain words", async () => {
        const s = seedProject("Mail refused");
        const ch = await mailChannel(s);
        smtp.rejectRcpt = () => true;
        const refused = await sendTest(s, ch.id);
        expect(refused).toMatchObject({ ok: false, attempts: 1 });
        expect(refused.error).toMatch(/refused/);

        const dead = await mailChannel(s, { smtp: ownSmtp({ port: DEAD_PORT }), name: "Dead server" });
        const r = await sendTest(s, dead.id);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(new RegExp(`^Could not reach the mail server 127\\.0\\.0\\.1:${DEAD_PORT} \\(E[A-Z]+\\)\\.$`));
    });

    it("does not send to a private mail server that has since been blocked", async () => {
        const s = seedProject("Mail blocked later");
        const ch = await mailChannel(s);
        const before = smtp.connections;
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        const r = await sendTest(s, ch.id);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/private/i);
        expect(smtp.connections).toBe(before); // not even a connection was opened
        expect(smtp.mails).toHaveLength(0);
    });

    it("changes recipients and the password without ever returning it, and can go back to the server's settings", async () => {
        const s = seedProject("Mail edit");
        smtp.requireAuth = { user: SMTP_USER, pass: "rotated-password-5d2" };
        const ch = await mailChannel(s);
        expect((await sendTest(s, ch.id)).ok).toBe(false); // the stored password is the old one

        const patched = await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { recipients: ["new@example.test"], smtp: { password: "rotated-password-5d2" } });
        expect(patched.status, patched.raw).toBe(200);
        expect(patched.body.recipients).toEqual(["new@example.test"]);
        expect(patched.body.smtp).toMatchObject({ source: "channel", hasLogin: true });
        expect(patched.raw).not.toContain("rotated-password-5d2");
        expect(await sendTest(s, ch.id)).toMatchObject({ ok: true });
        expect(smtp.mails[0]!.to).toEqual(["new@example.test"]);
        expect(smtp.mails[0]!.user).toBe(SMTP_USER); // the user name was kept

        // bad changes are refused before anything is saved
        expect((await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { recipients: ["nope"] })).status).toBe(400);
        expect((await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { url: "http://x.test" })).status).toBe(400);
        // without own settings and without the server's, there is nowhere to send from
        const back = await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { smtp: null });
        expect(back.status).toBe(422);
        expect((await call("GET", `/api/projects/${s.projectId}/alert-channels`)).body[0].smtp.source).toBe("channel");
    });

    it("a webhook channel cannot take email settings", async () => {
        const s = seedProject("Webhook fields");
        const w = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "webhook", url: TEAMS_URL });
        expect((await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${w.body.id}`, { recipients: ["a@example.test"] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "webhook", url: TEAMS_URL, recipients: ["a@example.test"] })).status).toBe(201); // extra keys on create are ignored like before
    });
});

describe("email through the server-wide settings", () => {
    it("reads them from the environment, sends with them, and shows none of the login", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-notify-env-"));
        const mailbox = await startFakeSmtp(SERVER_SMTP_PORT);
        mailbox.requireAuth = { user: SERVER_USER, pass: SERVER_PASS };
        const p2 = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: PUBLIC_URL, SMTP_HOST: "127.0.0.1", SMTP_PORT: String(SERVER_SMTP_PORT), SMTP_USER: SERVER_USER, SMTP_PASSWORD: SERVER_PASS, SMTP_FROM: "tests@platform.test" }));
        getScheduleServices(p2, { delivery: { backoffMs: [], timeoutMs: 2_000 } });
        const srv = await buildServer(p2);
        try {
            const inject = async (method: "GET" | "POST", url: string, payload?: unknown) => {
                const res = await srv.inject({ method, url, payload: payload as never });
                return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body };
            };
            const id = (await inject("POST", "/api/projects", { name: "Env mail" })).body.id;
            const opts = await inject("GET", `/api/projects/${id}/alert-options`);
            expect(opts.body).toEqual({ email: { serverMail: { host: "127.0.0.1", port: SERVER_SMTP_PORT, secure: false, from: "tests@platform.test", hasLogin: true }, maxRecipients: 10 } });
            const made = await inject("POST", `/api/projects/${id}/alert-channels`, { kind: "email", recipients: ["qa@example.test"] });
            expect(made.status, made.raw).toBe(201);
            expect(made.body.smtp).toMatchObject({ source: "server", host: "127.0.0.1", from: "tests@platform.test", hasLogin: true });
            const sent = await inject("POST", `/api/projects/${id}/alert-channels/${made.body.id}/test`);
            expect(sent.body).toMatchObject({ ok: true });
            expect(mailbox.mails).toHaveLength(1);
            expect(mailbox.mails[0]).toMatchObject({ from: "tests@platform.test", to: ["qa@example.test"], user: SERVER_USER, pass: SERVER_PASS });
            for (const text of [opts.raw, made.raw, sent.raw, (await inject("GET", `/api/projects/${id}/alert-channels`)).raw, (await inject("GET", `/api/projects/${id}/alert-log`)).raw, mailbox.mails[0]!.data]) {
                expect(text).not.toContain(SERVER_USER);
                expect(text).not.toContain(SERVER_PASS);
            }
            // nothing about the login reaches the database either (the channel stores no settings of its own)
            p2.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            const db = fs.readFileSync(path.join(dir, "platform.db"));
            expect(db.includes(Buffer.from(SERVER_PASS))).toBe(false);
        } finally {
            await srv.close();
            p2.db.close();
            await mailbox.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it("reads the environment leniently: empty values count as not set, port 465 means a secure connection", () => {
        const base = { SMTP_HOST: "mail.test", SMTP_PORT: undefined, SMTP_SECURE: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, SMTP_FROM: "a@b.test" };
        expect(serverSmtp({ ...base, SMTP_HOST: "" })).toBeUndefined();
        expect(serverSmtp({ ...base, SMTP_FROM: " " })).toBeUndefined();
        expect(serverSmtp({ ...base, SMTP_PORT: "abc" })).toBeUndefined();
        expect(serverSmtp(base)).toEqual({ host: "mail.test", port: 587, secure: false, from: "a@b.test" });
        expect(serverSmtp({ ...base, SMTP_PORT: "465" })).toMatchObject({ port: 465, secure: true });
        expect(serverSmtp({ ...base, SMTP_PORT: "465", SMTP_SECURE: "false" })).toMatchObject({ secure: false });
        expect(serverSmtp({ ...base, SMTP_USER: "u", SMTP_PASSWORD: "p" })).toMatchObject({ user: "u", password: "p" });
        expect(serverSmtp({ ...base, SMTP_USER: "", SMTP_PASSWORD: "p" })).not.toHaveProperty("user");
    });
});
