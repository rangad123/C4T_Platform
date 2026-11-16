/**
 * The project's sign-in, end to end on this server (a real platform, the real worker, Playwright, a local stand-in site that records
 * what each form received): what Project settings → Sign-in saves (PUT /api/projects/:id/sign-in) is what every kind of test types:
 *  - a text test's {{credentials.username}}, {{credentials.password}} and {{credentials.totp}} (a valid one-time code);
 *  - a code test's TEST_USERNAME, TEST_PASSWORD and TEST_TOTP_SECRET;
 *  - a named test account's {{credentials.admin.*}} and TEST_ADMIN_PASSWORD;
 *  - a login form without labels next to a signup form (the login form's own fields);
 *  - an environment: its own sign-in; the project's only at exactly the project's address; never on production.
 * A changed sign-in is what the very next run types; a removed one fails the test with where to enter it, and the site never receives
 * a literal "{{credentials...}}" or an empty password. A downloaded test carries placeholders and variable names, never the secret,
 * and no secret appears in any API answer or in the data folder.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/sign-in-everywhere.test.ts
 * Ports: 5641 (the project's site), 5642 (a staging copy of it).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { totp } from "../src/engine/identity/totp.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5641;
const STAGING_PORT = 5642;
const SITE = `http://127.0.0.1:${PORT}`;
const STAGING = `http://127.0.0.1:${STAGING_PORT}`;
const KEY = "sign-in-everywhere-key-41c7";
/** Distinct, greppable values; the base32 ones are valid authenticator secrets. */
const S = {
    user1: "first@practice.test",
    pw1: "SIGNEVERY-Pw1-7b2e90",
    totp1: "JBSWY3DPEHPK3PXP",
    user2: "second@practice.test",
    pw2: "SIGNEVERY-Pw2-c05a13",
    adminUser: "admin@practice.test",
    adminPw: "SIGNEVERY-AdminPw-4f6d21",
    stageUser: "stage@practice.test",
    stagePw: "SIGNEVERY-StagePw-9e3b77",
    stageTotp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};
const SECRETS = [S.pw1, S.totp1, S.pw2, S.adminPw, S.stagePw, S.stageTotp];

/** Accounts the stand-in site accepts: user name → password and authenticator secret. */
const accounts = new Map<string, { password: string; totp?: string }>([
    [S.user1, { password: S.pw1, totp: S.totp1 }],
    [S.user2, { password: S.pw2 }],
    [S.adminUser, { password: S.adminPw }],
    [S.stageUser, { password: S.stagePw }],
]);
/** Everything a form on the site received, in order. */
const received: Array<{ port: number; path: string; fields: Record<string, string> }> = [];
const sessions = new Map<string, string>();

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const LOGIN = '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>';
const LOGIN_PLAIN =
    '<section><h2>Login to your account</h2><form method="post" action="/login"><input type="email" name="email" placeholder="Email Address"><input type="password" name="password" placeholder="Password"><button type="submit">Login</button></form></section>' +
    '<section><h2>New User Signup!</h2><form method="post" action="/signup"><input type="text" name="name" placeholder="Name"><input type="email" name="email" placeholder="Email Address"><button type="submit">Signup</button></form></section>';
const OTP = '<form method="post" action="/otp"><label>6-digit code <input name="code" inputmode="numeric"></label><button type="submit">Verify</button></form>';

function site(port: number) {
    return http.createServer(async (req, res) => {
        const p = (req.url ?? "/").split("?")[0]!;
        const html = (status: number, content: string, h: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "text/html", ...h }), res.end(content));
        const who = sessions.get(/sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
        if (req.method === "POST") {
            let raw = "";
            for await (const c of req) raw += c;
            const fields = Object.fromEntries(new URLSearchParams(raw));
            received.push({ port, path: p, fields });
            if (p === "/login") {
                const a = accounts.get(fields.email ?? "");
                if (!a || a.password !== fields.password) return html(401, page("Sign in", '<p role="alert">Invalid email or password</p>' + LOGIN));
                const sid = Math.random().toString(16).slice(2, 12);
                sessions.set(sid, fields.email!);
                return html(200, page("Your account", `<p>Welcome ${fields.email}</p>`), { "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
            }
            if (p === "/otp") {
                const secret = who ? accounts.get(who)?.totp : undefined;
                const now = Date.now();
                const ok = Boolean(secret) && [now - 30_000, now, now + 30_000].some((t) => totp(secret!, { now: t }) === fields.code);
                return html(ok ? 200 : 401, page("Two-step sign-in", ok ? "<p>Code accepted</p>" : '<p role="alert">Wrong code</p>'));
            }
            return html(200, page("Thanks", "<p>Received</p>"));
        }
        if (p === "/login") return html(200, page("Sign in", LOGIN));
        if (p === "/login-plain") return html(200, page("Login or sign up", LOGIN_PLAIN));
        if (p === "/otp") return html(200, page("Two-step sign-in", OTP));
        html(200, page("Practice site", '<a href="/login">Log in</a>'));
    });
}

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir = "";
const servers: http.Server[] = [];
const answers: string[] = [];

const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, headers: { "x-api-key": KEY, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    answers.push(`${method} ${url}\n${res.body}`);
    return { status: res.statusCode, body: res.body && /^[[{]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
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
/** What the forms received since `from` (an index into `received`). */
const since = (from: number) => received.slice(from);
const runTests = async (projectId: string, testIds: string[]) => {
    const r = await call("POST", `/api/projects/${projectId}/runs`, { testIds });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await waitJob(r.body.jobId);
    return r.body.jobId as string;
};

const TEXT_SIGN_IN = `Test: Signs in with the project's sign-in
Category: Sign in

Go to /login
Type "{{credentials.username}}" into the "Email" field
Type "{{credentials.password}}" into the "Password" field
Click the "Log in" button
Expect the page to contain the text "Welcome"
`;
const TEXT_TOTP = `Test: Two-step sign-in with a one-time code
Category: Sign in

Go to /login
Type "{{credentials.username}}" into the "Email" field
Type "{{credentials.password}}" into the "Password" field
Click the "Log in" button
Go to /otp
Type "{{credentials.totp}}" into the "6-digit code" field
Click the "Verify" button
Expect the page to contain the text "Code accepted"
`;
const TEXT_ADMIN = `Test: Signs in as the admin account
Category: Sign in

Go to /login
Type "{{credentials.admin.username}}" into the "Email" field
Type "{{credentials.admin.password}}" into the "Password" field
Click the "Log in" button
Expect the page to contain the text "Welcome"
`;
const TEXT_PLAIN_FORMS = `Test: Logs in on a page with a login and a signup form
Category: Sign in

Go to /login-plain
Type "{{credentials.username}}" into the "Email Address" field
Type "{{credentials.password}}" into the "Password" field
Click the "Login" button
Expect the page to contain the text "Welcome"
`;
const CODE_SIGN_IN = `import { test, expect } from "@playwright/test";
test("code signs in with the project's sign-in", async ({ page }) => {
  await page.goto(process.env.BASE_URL + "/login");
  await page.getByLabel("Email").fill(process.env.TEST_USERNAME ?? "");
  await page.getByLabel("Password").fill(process.env.TEST_PASSWORD ?? "");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Welcome")).toBeVisible();
  const r = await page.request.post(process.env.BASE_URL + "/seen", { form: { totpSecret: process.env.TEST_TOTP_SECRET ?? "", adminUser: process.env.TEST_ADMIN_USERNAME ?? "", adminPassword: process.env.TEST_ADMIN_PASSWORD ?? "" } });
  expect(r.ok()).toBe(true);
});
`;

let projectId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
    for (const [port, s] of [[PORT, site(PORT)], [STAGING_PORT, site(STAGING_PORT)]] as const) {
        servers.push(s);
        await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sign-in-everywhere-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "sign-in-everywhere-secret-0123456789", API_KEY: KEY, ALLOW_CUSTOM_SCRIPTS: "true", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", SCHEDULER_ENABLED: "false", LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 150);
    worker.start();

    projectId = (await call("POST", "/api/projects", { name: "Sign-in everywhere", platforms: ["web"], testingModes: ["code"] })).body.id;
    expect((await call("PUT", `/api/projects/${projectId}/app-details`, { webUrl: `${SITE}/` })).status).toBe(200);
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    for (const s of servers) await new Promise((r) => s.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the sign-in saved in Settings is what every test types", () => {
    it("Settings saves it, with a named admin account beside it", async () => {
        const saved = await call("PUT", `/api/projects/${projectId}/sign-in`, { username: S.user1, password: S.pw1, totpSecret: S.totp1 });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body).toEqual({ username: S.user1, hasPassword: true, hasTotp: true, site: `${SITE}/` });
        const roles = await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "admin", username: S.adminUser, password: S.adminPw }] });
        expect(roles.status, JSON.stringify(roles.body)).toBe(200);
    });

    it("a text test types the user name and password into the login form", async () => {
        const from = received.length;
        const made = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: TEXT_SIGN_IN });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.text = made.body.testId;
        await waitJob(made.body.jobId);
        expect(await latest(ids.text!)).toMatchObject({ status: "passed" });
        expect(since(from)).toEqual([{ port: PORT, path: "/login", fields: { email: S.user1, password: S.pw1 } }]);
    }, 120_000);

    it("a text test types a valid one-time code from the saved authenticator secret", async () => {
        const from = received.length;
        const made = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: TEXT_TOTP });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.totp = made.body.testId;
        await waitJob(made.body.jobId);
        const run = await latest(ids.totp!);
        expect(run, JSON.stringify(run)).toMatchObject({ status: "passed" });
        const otp = since(from).find((r) => r.path === "/otp");
        expect(otp?.fields.code).toMatch(/^\d{6}$/);
    }, 120_000);

    it("a text test signs in as a named account with that account's user name and password", async () => {
        const from = received.length;
        const made = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: TEXT_ADMIN });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.admin = made.body.testId;
        await waitJob(made.body.jobId);
        expect(await latest(ids.admin!)).toMatchObject({ status: "passed" });
        expect(since(from)).toEqual([{ port: PORT, path: "/login", fields: { email: S.adminUser, password: S.adminPw } }]);
    }, 120_000);

    it("on a page with a login form and a signup form, both without labels, it types into the login form's own fields", async () => {
        const from = received.length;
        const made = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: TEXT_PLAIN_FORMS });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.plain = made.body.testId;
        await waitJob(made.body.jobId);
        const run = await latest(ids.plain!);
        expect(run, JSON.stringify(run)).toMatchObject({ status: "passed" });
        expect(since(from)).toEqual([{ port: PORT, path: "/login", fields: { email: S.user1, password: S.pw1 } }]);
    }, 120_000);

    it("a code test gets TEST_USERNAME, TEST_PASSWORD, TEST_TOTP_SECRET and the named account's variables", async () => {
        const from = received.length;
        const made = await call("POST", `/api/projects/${projectId}/custom-tests`, { title: "Code signs in", kind: "web", content: CODE_SIGN_IN });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.code = made.body.testId;
        await waitJob(made.body.jobId);
        const run = await latest(ids.code!);
        expect(run, JSON.stringify(run)).toMatchObject({ status: "passed" });
        expect(since(from)).toEqual([
            { port: PORT, path: "/login", fields: { email: S.user1, password: S.pw1 } },
            { port: PORT, path: "/seen", fields: { totpSecret: S.totp1, adminUser: S.adminUser, adminPassword: S.adminPw } },
        ]);
    }, 120_000);
});

describe("on other browsers and screen sizes", () => {
    it("a compatibility check types the same sign-in and a valid one-time code, in text and code tests", async () => {
        const from = received.length;
        for (const id of [ids.totp!, ids.code!]) {
            const r = await call("POST", `/api/tests/${id}/variants`, { variants: ["mobile-chrome"] });
            expect(r.status, JSON.stringify(r.body)).toBe(202);
            await waitJob(r.body.jobId);
            const t = (await call("GET", `/api/tests/${id}`)).body;
            expect(t.compatibility?.["mobile-chrome"], JSON.stringify(t.compatibility)).toMatchObject({ status: "passed" });
        }
        const got = since(from);
        expect(got.filter((r) => r.path === "/login").map((r) => r.fields)).toEqual([
            { email: S.user1, password: S.pw1 },
            { email: S.user1, password: S.pw1 },
        ]);
        expect(got.find((r) => r.path === "/seen")?.fields.totpSecret).toBe(S.totp1);
    }, 180_000);
});

describe("a changed or removed sign-in", () => {
    it("a changed sign-in is what the very next run types, in text and code tests alike", async () => {
        expect((await call("PUT", `/api/projects/${projectId}/sign-in`, { username: S.user2, password: S.pw2 })).status).toBe(200);
        const from = received.length;
        await runTests(projectId, [ids.text!, ids.code!]);
        expect(await latest(ids.text!)).toMatchObject({ status: "passed" });
        expect(await latest(ids.code!)).toMatchObject({ status: "passed" });
        const logins = since(from).filter((r) => r.path === "/login");
        expect(logins).toHaveLength(2);
        for (const l of logins) expect(l.fields).toEqual({ email: S.user2, password: S.pw2 });
    }, 180_000);

    it("a removed sign-in fails the tests that type it with where to enter it, and nothing is typed into the site", async () => {
        expect((await call("PUT", `/api/projects/${projectId}/sign-in`, { clear: ["all"] })).body).toMatchObject({ username: null, hasPassword: false, hasTotp: false });
        const from = received.length;
        const jobId = await runTests(projectId, [ids.text!, ids.code!, ids.totp!]);
        // The run says, test by test, that it was not run and where to enter the sign-in; the test itself failed with the same words.
        const detail = (await call("GET", `/api/projects/${projectId}/runs/${jobId}`)).body;
        for (const id of [ids.text!, ids.code!, ids.totp!]) {
            const row = (detail.tests as Array<{ id: string; state: string; reason?: string }>).find((t) => t.id === id);
            expect(row, JSON.stringify(detail.tests)).toMatchObject({ state: "not_run", reason: expect.stringContaining("Project settings → Sign-in") });
            const t = (await call("GET", `/api/tests/${id}`)).body;
            expect(t.validationStatus, JSON.stringify(t)).toBe("FAILED_VALIDATION");
            expect(JSON.stringify(t)).toContain("Project settings → Sign-in");
        }
        expect(since(from)).toEqual([]);
        expect(JSON.stringify(received)).not.toContain("{{");
        // The named account is the project's test account, not its sign-in: its test still signs in.
        const before = received.length;
        await runTests(projectId, [ids.admin!]);
        expect(await latest(ids.admin!)).toMatchObject({ status: "passed" });
        expect(since(before)).toEqual([{ port: PORT, path: "/login", fields: { email: S.adminUser, password: S.adminPw } }]);
    }, 180_000);
});

describe("environments", () => {
    it("an environment with its own sign-in types that; one at exactly the project's address borrows the project's; production never does", async () => {
        expect((await call("PUT", `/api/projects/${projectId}/sign-in`, { username: S.user1, password: S.pw1, totpSecret: S.totp1 })).status).toBe(200);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: STAGING })).status).toBe(201);
        expect((await call("PUT", `/api/projects/${projectId}/environments/staging/secrets`, { username: S.stageUser, password: S.stagePw, totpSecret: S.stageTotp })).status).toBe(200);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "mirror", baseUrl: SITE })).status).toBe(201);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "bare", baseUrl: STAGING })).status).toBe(201);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "live", baseUrl: SITE, production: true })).status).toBe(201);

        const runIn = async (env: string, confirmProduction?: boolean) => {
            const from = received.length;
            const r = await call("POST", `/api/projects/${projectId}/environments/${env}/runs`, { testIds: [ids.text!, ids.code!], ...(confirmProduction ? { confirmProduction } : {}) });
            expect(r.status, JSON.stringify(r.body)).toBe(202);
            await waitJob(r.body.jobId);
            const results = (await call("GET", `/api/projects/${projectId}/environments/${env}/results`)).body;
            const of = (id: string) => (results.tests as Array<{ id: string; result: { status: string; reason?: string | null } | null }>).find((t) => t.id === id)?.result;
            return { got: since(from), text: of(ids.text!), code: of(ids.code!) };
        };

        const staging = await runIn("staging");
        expect(staging.text?.status, JSON.stringify(staging)).toBe("passed");
        expect(staging.code?.status, JSON.stringify(staging)).toBe("passed");
        expect(staging.got.filter((r) => r.path === "/login")).toEqual([
            { port: STAGING_PORT, path: "/login", fields: { email: S.stageUser, password: S.stagePw } },
            { port: STAGING_PORT, path: "/login", fields: { email: S.stageUser, password: S.stagePw } },
        ]);
        expect(staging.got.find((r) => r.path === "/seen")?.fields.totpSecret).toBe(S.stageTotp);

        const mirror = await runIn("mirror");
        expect(mirror.text?.status, JSON.stringify(mirror)).toBe("passed");
        expect(mirror.code?.status, JSON.stringify(mirror)).toBe("passed");
        expect(mirror.got.filter((r) => r.path === "/login")).toEqual([
            { port: PORT, path: "/login", fields: { email: S.user1, password: S.pw1 } },
            { port: PORT, path: "/login", fields: { email: S.user1, password: S.pw1 } },
        ]);
        expect(mirror.got.find((r) => r.path === "/seen")?.fields.totpSecret).toBe(S.totp1);

        // Another address without a sign-in of its own: the project's is not sent there.
        const bare = await runIn("bare");
        expect(bare.got).toEqual([]);
        for (const r of [bare.text, bare.code]) {
            expect(r?.status, JSON.stringify(bare)).toBe("failed");
            expect(r?.reason ?? "").toContain("not sent to an address other than the project's own");
        }

        // Production: the text test is not given the project's sign-in, and a code test never runs there at all.
        const live = await runIn("live", true);
        expect(live.got).toEqual([]);
        expect(live.text, JSON.stringify(live)).toMatchObject({ status: "failed", reason: expect.stringContaining("not sent to a production environment") });
        expect(live.code, JSON.stringify(live)).toMatchObject({ status: "skipped", reason: expect.stringContaining("Code tests are not run on production") });
    }, 300_000);
});

describe("what leaves the platform", () => {
    it("a downloaded test carries placeholders and variable names, never the saved secrets", async () => {
        /** The downloaded zip's files, unpacked. */
        const download = async (id: string) => {
            const r = await server.inject({ method: "GET", url: `/api/tests/${id}/download`, headers: { "x-api-key": KEY } });
            expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
            const files = Object.entries(unzipSync(new Uint8Array(r.rawPayload))).map(([name, b]) => `${name}\n${Buffer.from(b).toString("utf8")}`);
            answers.push(`download ${id}\n${r.rawPayload.toString("latin1")}`, ...files.map((f) => `download ${id} ${f}`));
            return files.join("\n");
        };
        for (const id of [ids.text!, ids.totp!, ids.admin!, ids.code!]) {
            const text = await download(id);
            for (const s of SECRETS) expect(text, `${id} download`).not.toContain(s);
        }
        expect(await download(ids.text!)).toMatch(/process\.env\.TEST_PASSWORD/);
        expect(await download(ids.totp!)).toMatch(/TEST_TOTP_SECRET/);
        expect(await download(ids.admin!)).toMatch(/process\.env\.TEST_ADMIN_PASSWORD/);
        expect(await download(ids.code!)).toMatch(/process\.env\.TEST_PASSWORD/);
    });

    it("no secret is in any API answer about the project, its tests and runs", async () => {
        for (const url of [`/api/projects/${projectId}`, `/api/projects/${projectId}/tests`, `/api/projects/${projectId}/sign-in`, `/api/projects/${projectId}/roles`, `/api/projects/${projectId}/environments`, `/api/projects/${projectId}/jobs`]) await call("GET", url);
        for (const id of Object.values(ids)) {
            await call("GET", `/api/tests/${id}`);
            await call("GET", `/api/tests/${id}/executions`);
            await call("GET", `/api/tests/${id}/script`);
            await call("GET", `/api/tests/${id}/evidence`);
        }
        const leaks = answers.flatMap((a) => SECRETS.filter((s) => a.includes(s)).map((s) => `${s} in ${a.split("\n")[0]}`));
        expect(leaks).toEqual([]);
    });

    it("no secret is in the data folder in readable form (database, scripts, evidence, traces)", () => {
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const leaks: string[] = [];
        const scan = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) scan(full);
                else if (e.isFile()) {
                    const b = fs.readFileSync(full);
                    // A failure trace is a zip: its compressed text is searched too.
                    const zipped = b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? Object.values(unzipSync(new Uint8Array(b))).map((x) => Buffer.from(x)) : [];
                    const forms = [b, ...zipped].flatMap((x) => [x.toString("latin1"), x.toString("utf16le")]);
                    for (const s of SECRETS) if (forms.some((f) => f.includes(s))) leaks.push(`${s} in ${path.relative(dataDir, full)}`);
                }
            }
        };
        scan(dataDir);
        expect(leaks).toEqual([]);
    });
});
