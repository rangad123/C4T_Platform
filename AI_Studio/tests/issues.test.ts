/**
 * Issue creation from findings: GitHub Issues and Jira, exercised over real HTTP against local mock servers
 * that implement the documented endpoints (auth checks, 401/403/404/rate-limit answers, create-issue payloads).
 * No browser and no LLM.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildIssueDraft, toAdf, toMarkdown } from "../src/platform/issues/content.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { buildServer } from "../src/platform/server.js";

const GH_PORT = 5275;
const JIRA_PORT = 5276;
const GH = `http://127.0.0.1:${GH_PORT}`;
const JIRA = `http://127.0.0.1:${JIRA_PORT}`;
const GH_TOKEN = "ghp_validTokenForTests1234567890";
const JIRA_TOKEN = "jira-api-token-for-tests-abcdef";
const JIRA_EMAIL = "qa@example.com";

interface Recorded {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
}
const ghCalls: Recorded[] = [];
const jiraCalls: Recorded[] = [];
let ghRevoked = false;
let jiraRevoked = false;
let ghIssueNo = 0;
let jiraIssueNo = 0;
const servers: http.Server[] = [];

function mock(port: number, handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse, rec: Recorded) => void, calls: Recorded[]) {
    return new Promise<void>((resolve) => {
        const s = http.createServer((req, res) => {
            let raw = "";
            req.on("data", (d) => (raw += d));
            req.on("end", () => {
                let body: any;
                try {
                    body = raw ? JSON.parse(raw) : undefined;
                } catch {
                    body = raw;
                }
                const rec = { method: req.method!, url: req.url!, headers: req.headers, body };
                calls.push(rec);
                handler(req, body, res, rec);
            });
        });
        servers.push(s);
        s.listen(port, "127.0.0.1", resolve);
    });
}
const send = (res: http.ServerResponse, code: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
};

/** GitHub: https://docs.github.com/rest/issues/issues#create-an-issue and /rest/repos/repos#get-a-repository */
const githubHandler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}` || ghRevoked) return send(res, 401, { message: "Bad credentials" });
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/issues)?$/.exec(req.url!.split("?")[0]!);
    if (!m) return send(res, 404, { message: "Not Found" });
    const [, owner, repo, issues] = m;
    if (repo === "missing") return send(res, 404, { message: "Not Found" });
    if (repo === "locked") return send(res, 403, { message: "Resource not accessible by personal access token" });
    if (repo === "limited") return send(res, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    if (repo === "noissues" && !issues) return send(res, 200, { full_name: `${owner}/${repo}`, has_issues: false });
    if (req.method === "GET" && !issues) return send(res, 200, { full_name: `${owner}/${repo}`, has_issues: true, archived: false });
    if (req.method === "POST" && issues) {
        if (typeof body?.title !== "string" || !Array.isArray(body?.labels)) return send(res, 422, { message: "Validation Failed" });
        const n = ++ghIssueNo;
        return send(res, 201, { number: n, html_url: `https://github.example/${owner}/${repo}/issues/${n}` });
    }
    send(res, 404, { message: "Not Found" });
};

/** Jira Cloud v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/ */
const jiraHandler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => {
    const basic = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
    if (req.headers.authorization !== `Basic ${basic}` || jiraRevoked) return send(res, 401, { errorMessages: ["You are not authenticated."] });
    const url = req.url!.split("?")[0]!;
    if (url === "/rest/api/3/myself") return send(res, 200, { displayName: "QA Bot", accountId: "abc" });
    const pm = /^\/rest\/api\/3\/project\/([A-Za-z0-9_]+)$/.exec(url);
    if (pm) return pm[1] === "SHOP" ? send(res, 200, { key: "SHOP", name: "Shop Platform" }) : send(res, 404, { errorMessages: ["No project could be found with key."] });
    if (url === "/rest/api/3/issue" && req.method === "POST") {
        const f = body?.fields;
        if (!f?.project?.key || !f?.summary || !f?.issuetype?.name || f?.description?.type !== "doc") return send(res, 400, { errors: { description: "Operation value must be an Atlassian Document" } });
        const key = `${f.project.key}-${++jiraIssueNo}`;
        return send(res, 201, { id: String(10000 + jiraIssueNo), key, self: `${JIRA}/rest/api/3/issue/${key}` });
    }
    send(res, 404, { errorMessages: ["not found"] });
};

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
const tests: Record<"finding" | "failed" | "passed" | "pending", string> = { finding: "", failed: "", passed: "", pending: "" };

const spec = (testId: string, title: string, extra: Partial<TestSpec> = {}): TestSpec =>
    TestSpecSchema.parse({
        testId,
        title,
        kind: "api",
        category: "Checkout",
        priority: "high",
        steps: [
            { action: "request", method: "GET", path: "/api/cart" },
            { action: "assertResponse", check: "statusBelow", expected: 500 },
        ],
        expectedResults: ["The cart loads without a server error"],
        ...extra,
    });

function seed(testSpec: TestSpec, status: "NEEDS_REVIEW" | "FAILED_VALIDATION" | "VALIDATED" | "PENDING", reason: string | null): string {
    const { repo } = platform;
    const suiteId = repo.getOrCreateSuite(projectId, testSpec.category, "checkout");
    const id = repo.insertTest({ projectId, suiteId, jobId: null, spec: testSpec, framework: "playwright-api", validationStatus: status });
    repo.updateTest(id, { reason, validationStatus: status });
    if (status !== "PENDING") {
        repo.addExecution({
            testId: id,
            scriptId: null,
            jobId: null,
            attempt: 1,
            status: status === "VALIDATED" ? "passed" : "failed",
            durationMs: 120,
            startedAt: new Date().toISOString(),
            steps: [
                { index: 0, title: "GET /api/cart", status: "passed" },
                ...(status === "VALIDATED" ? [{ index: 1, title: "Verify response", status: "passed" }] : [{ index: 1, title: "Verify response", status: "failed", error: "boom" }]),
            ],
        });
    }
    return id;
}

beforeAll(async () => {
    await mock(GH_PORT, githubHandler, ghCalls);
    await mock(JIRA_PORT, jiraHandler, jiraCalls);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-issues-"));
    process.env.PUBLIC_URL = "https://platform.example.test";
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir }));
    server = await buildServer(platform);
    projectId = platform.repo.createProject({ name: "Issues demo" }).id as string;
    platform.repo.createApplication(projectId, "https://shop.example.test", {});
    tests.finding = seed(spec("API-001", "Cart loads for a signed-in shopper", { priority: "critical" }), "NEEDS_REVIEW", "Server error: GET /api/cart returned 503 (step \"Verify response\").");
    tests.failed = seed(spec("API-002", "Coupon code is applied"), "FAILED_VALIDATION", "Verify response — expected 200 but got 404");
    tests.passed = seed(spec("API-003", "Products list loads"), "VALIDATED", null);
    tests.pending = seed(spec("API-004", "Not run yet"), "PENDING", null);
}, 30_000);

afterAll(async () => {
    delete process.env.PUBLIC_URL;
    delete process.env.BLOCK_PRIVATE_TARGETS;
    await server?.close();
    platform?.db.close();
    for (const s of servers) s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, text: res.body };
};
const connectGithub = (over: Record<string, unknown> = {}) => call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH, ...over });
const connectJira = (over: Record<string, unknown> = {}) => call("POST", `/api/projects/${projectId}/integrations`, { kind: "jira", baseUrl: JIRA, projectKey: "shop", email: JIRA_EMAIL, token: JIRA_TOKEN, ...over });

describe("connecting GitHub", () => {
    let id = "";

    it("verifies the token with a real call, saves the connection and never returns the secret", async () => {
        const before = ghCalls.length;
        const res = await connectGithub();
        expect(res.status).toBe(201);
        id = res.body.id;
        expect(res.body).toMatchObject({ kind: "github", name: "GitHub acme/shop", config: { kind: "github", owner: "acme", repo: "shop" } });
        expect(res.text).not.toContain(GH_TOKEN);
        // the check used the documented repository endpoint with a Bearer token
        const check = ghCalls.slice(before).find((c) => c.method === "GET");
        expect(check?.url).toBe("/repos/acme/shop");
        expect(check?.headers.authorization).toBe(`Bearer ${GH_TOKEN}`);
        expect(String(check?.headers.accept)).toContain("application/vnd.github+json");

        const list = await call("GET", `/api/projects/${projectId}/integrations`);
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        expect(list.text).not.toContain(GH_TOKEN);
    });

    it("stores the token encrypted: not in the table, not in the database files", async () => {
        const row = platform.db.get<{ secret_enc: string; config_json: string }>("SELECT secret_enc, config_json FROM integrations WHERE id = ?", id)!;
        expect(row.secret_enc).not.toContain(GH_TOKEN);
        expect(row.config_json).not.toContain(GH_TOKEN);
        expect(row.secret_enc.split(".")).toHaveLength(3); // iv.tag.ciphertext (AES-256-GCM)
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        for (const f of fs.readdirSync(dataDir).filter((n) => n.startsWith("platform.db"))) {
            expect(fs.readFileSync(path.join(dataDir, f)).includes(GH_TOKEN)).toBe(false);
        }
    });

    it("explains a rejected token in plain words and saves nothing", async () => {
        const res = await connectGithub({ token: "ghp_wrongwrongwrong" });
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/did not accept the token/i);
        expect(res.body.details).toMatchObject({ code: "unauthorized", upstreamStatus: 401 });
        expect(res.text).not.toContain("ghp_wrongwrongwrong");
        expect((await call("GET", `/api/projects/${projectId}/integrations`)).body).toHaveLength(1);
    });

    it.each([
        ["missing", 502, "not_found", /could not find it/i],
        ["locked", 502, "forbidden", /not allowed/i],
        ["limited", 502, "rate_limited", /limiting how fast/i],
    ])("reports %s repository as %s", async (repo, status, code, message) => {
        const res = await connectGithub({ repo });
        expect(res.status).toBe(status);
        expect(res.body.details.code).toBe(code);
        expect(res.body.error).toMatch(message);
    });

    it("refuses a repository with Issues turned off", async () => {
        const res = await connectGithub({ repo: "noissues" });
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/Issues are turned off/);
    });

    it("validates input", async () => {
        expect((await call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "a b", repo: "x", token: "t" })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/integrations`, { kind: "svn" })).status).toBe(400);
        expect((await call("POST", `/api/projects/nope/integrations`, { kind: "github", owner: "a", repo: "b", token: "t" })).status).toBe(404);
    });

    it("tests a saved connection with a real call, and reports a revoked token as an answer", async () => {
        const ok = await call("POST", `/api/integrations/${id}/test`);
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ ok: true });
        expect(ok.body.message).toContain("acme/shop");
        ghRevoked = true;
        const bad = await call("POST", `/api/integrations/${id}/test`);
        ghRevoked = false;
        expect(bad.status).toBe(200);
        expect(bad.body).toMatchObject({ ok: false, code: "unauthorized" });
        expect((await call("POST", "/api/integrations/nope/test")).status).toBe(404);
    });

    it("can be renamed and have its token replaced", async () => {
        const res = await call("PATCH", `/api/integrations/${id}`, { name: "Shop repo", token: GH_TOKEN });
        expect(res.status).toBe(200);
        expect(res.body.name).toBe("Shop repo");
        expect(res.text).not.toContain(GH_TOKEN);
        expect((await call("POST", `/api/integrations/${id}/test`)).body.ok).toBe(true);
    });
});

describe("creating a GitHub issue from a finding", () => {
    let ghId = "";
    beforeAll(async () => {
        ghId = (await call("GET", `/api/projects/${projectId}/integrations`)).body[0].id;
    });

    it("sends a well-formed issue and records the link", async () => {
        const before = ghCalls.filter((c) => c.method === "POST").length;
        const res = await call("POST", `/api/tests/${tests.finding}/issue`, { integrationId: ghId });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ existing: false, link: { provider: "github", externalId: "#1", url: "https://github.example/acme/shop/issues/1" } });

        const posts = ghCalls.filter((c) => c.method === "POST");
        expect(posts).toHaveLength(before + 1);
        const sent = posts.at(-1)!;
        expect(sent.url).toBe("/repos/acme/shop/issues");
        expect(sent.headers.authorization).toBe(`Bearer ${GH_TOKEN}`);
        expect(sent.body.title).toBe("[Critical] Cart loads for a signed-in shopper"); // a 5xx on a critical journey
        expect(sent.body.labels).toEqual(expect.arrayContaining(["ai-testing", "severity-critical"]));
        const text: string = sent.body.body;
        expect(text).toContain("Server error: GET /api/cart returned 503");
        expect(text).toContain("Severity: Critical (server error on a critical journey)");
        expect(text).toContain("API-001");
        expect(text).toMatch(/1\. GET \/api\/cart/);
        expect(text).toContain("← failed here");
        expect(text).toContain("Application: https://shop.example.test");
        expect(text).toContain(`https://platform.example.test/#/tests/${tests.finding}`);
        expect(text).not.toContain(GH_TOKEN);
    });

    it("is idempotent: asking again returns the same issue and creates nothing new", async () => {
        const posts = () => ghCalls.filter((c) => c.method === "POST").length;
        const before = posts();
        const again = await call("POST", `/api/tests/${tests.finding}/issue`, { integrationId: ghId });
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ existing: true, link: { externalId: "#1" } });
        expect(posts()).toBe(before);
    });

    it("a double click creates one issue, not two", async () => {
        const before = ghCalls.filter((c) => c.method === "POST").length;
        const [a, b] = await Promise.all([call("POST", `/api/tests/${tests.failed}/issue`, { integrationId: ghId }), call("POST", `/api/tests/${tests.failed}/issue`, { integrationId: ghId })]);
        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect(a.body.link.id).toBe(b.body.link.id);
        expect(ghCalls.filter((c) => c.method === "POST").length).toBe(before + 1);
        const sent = ghCalls.filter((c) => c.method === "POST").at(-1)!;
        expect(sent.body.title).toBe("[Failing test] Coupon code is applied"); // a broken test has no severity
        expect(sent.body.labels).toEqual(expect.arrayContaining(["ai-testing", "test-failure"]));
    });

    it("lists the linked issues of a test", async () => {
        const res = await call("GET", `/api/tests/${tests.finding}/issues`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ provider: "github", externalId: "#1", integrationId: ghId });
        expect((await call("GET", "/api/tests/nope/issues")).status).toBe(404);
    });

    it("refuses tests that passed or have not run (422)", async () => {
        for (const id of [tests.passed, tests.pending]) {
            const res = await call("POST", `/api/tests/${id}/issue`, { integrationId: ghId });
            expect(res.status).toBe(422);
            expect(res.body.error).toMatch(/only be created/);
        }
    });

    it("rejects an unknown connection, or one from another project (404)", async () => {
        expect((await call("POST", `/api/tests/${tests.finding}/issue`, { integrationId: "nope" })).status).toBe(404);
        const other = platform.repo.createProject({ name: "Other" }).id as string;
        const foreign = (await call("POST", `/api/projects/${other}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH })).body.id;
        expect((await call("POST", `/api/tests/${tests.finding}/issue`, { integrationId: foreign })).status).toBe(404);
        expect((await call("POST", `/api/tests/${tests.finding}/issue`, {})).status).toBe(400);
    });

    it("turns tracker failures into plain-language errors and creates no link", async () => {
        // a connection whose repository disappeared after it was saved
        const row = platform.db.get<{ id: string; config_json: string }>("SELECT id, config_json FROM integrations WHERE id = ?", ghId)!;
        platform.db.run("UPDATE integrations SET config_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.config_json), repo: "missing" }), ghId);
        const t2 = seed(spec("API-010", "Another finding"), "NEEDS_REVIEW", "Server error: GET /api/x returned 500");
        const res = await call("POST", `/api/tests/${t2}/issue`, { integrationId: ghId });
        platform.db.run("UPDATE integrations SET config_json = ? WHERE id = ?", row.config_json, ghId);
        expect(res.status).toBe(502);
        expect(res.body.details.code).toBe("not_found");
        expect((await call("GET", `/api/tests/${t2}/issues`)).body).toEqual([]);

        // and a retry after the problem is fixed works
        const ok = await call("POST", `/api/tests/${t2}/issue`, { integrationId: ghId });
        expect(ok.status).toBe(201);
    });

    it("keeps the link when the connection is removed", async () => {
        const temp = (await connectGithub({ repo: "temp" })).body.id as string;
        const t3 = seed(spec("API-011", "Yet another finding"), "NEEDS_REVIEW", "Server error: GET /api/y returned 500");
        expect((await call("POST", `/api/tests/${t3}/issue`, { integrationId: temp })).status).toBe(201);
        expect((await call("DELETE", `/api/integrations/${temp}`)).status).toBe(204);
        const links = (await call("GET", `/api/tests/${t3}/issues`)).body;
        expect(links).toHaveLength(1);
        expect(links[0].integrationId).toBeNull();
        expect((await call("DELETE", `/api/integrations/${temp}`)).status).toBe(404);
    });
});

describe("Jira", () => {
    let jiraId = "";

    it("verifies the account and the project key, and saves the connection", async () => {
        const before = jiraCalls.length;
        const res = await connectJira();
        expect(res.status).toBe(201);
        jiraId = res.body.id;
        expect(res.body).toMatchObject({ kind: "jira", name: "Jira SHOP", config: { baseUrl: JIRA, projectKey: "SHOP", email: JIRA_EMAIL, issueType: "Bug" } });
        expect(res.text).not.toContain(JIRA_TOKEN);
        expect(jiraCalls.slice(before).map((c) => c.url)).toEqual(["/rest/api/3/myself", "/rest/api/3/project/SHOP"]);
        const row = platform.db.get<{ secret_enc: string; config_json: string }>("SELECT secret_enc, config_json FROM integrations WHERE id = ?", jiraId)!;
        expect(row.secret_enc + row.config_json).not.toContain(JIRA_TOKEN);
    });

    it("reports a wrong token, an unknown project and a bad address clearly", async () => {
        const token = await connectJira({ token: "nope-nope-nope" });
        expect(token.status).toBe(502);
        expect(token.body.details.code).toBe("unauthorized");
        const project = await connectJira({ projectKey: "NOPE" });
        expect(project.body.details.code).toBe("not_found");
        expect(project.body.error).toMatch(/project key/);
        const unreachable = await connectJira({ baseUrl: "http://127.0.0.1:5299" });
        expect(unreachable.status).toBe(502);
        expect(unreachable.body.details.code).toBe("unreachable");
        expect(unreachable.body.error).toMatch(/couldn’t reach Jira/);
    });

    it("creates an issue with an Atlassian Document description, the project and the issue type", async () => {
        const res = await call("POST", `/api/tests/${tests.finding}/issue`, { integrationId: jiraId });
        expect(res.status).toBe(201);
        expect(res.body.link).toMatchObject({ provider: "jira", externalId: "SHOP-1", url: `${JIRA}/browse/SHOP-1` });

        const sent = jiraCalls.filter((c) => c.method === "POST").at(-1)!;
        const basic = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
        expect(sent.headers.authorization).toBe(`Basic ${basic}`);
        const f = sent.body.fields;
        expect(f.project).toEqual({ key: "SHOP" });
        expect(f.issuetype).toEqual({ name: "Bug" });
        expect(f.summary).toBe("[Critical] Cart loads for a signed-in shopper");
        expect(f.labels).toEqual(expect.arrayContaining(["ai-testing", "severity-critical"]));
        expect(f.labels.every((l: string) => !/\s/.test(l))).toBe(true);
        expect(f.description).toMatchObject({ type: "doc", version: 1 });
        const types = f.description.content.map((n: any) => n.type);
        expect(types).toEqual(expect.arrayContaining(["heading", "paragraph", "codeBlock", "orderedList", "bulletList"]));
        const code = f.description.content.find((n: any) => n.type === "codeBlock");
        expect(code.content[0].text).toContain("Server error: GET /api/cart returned 503");
        const link = JSON.stringify(f.description).match(/"href":"([^"]+)"/)?.[1];
        expect(link).toBe(`https://platform.example.test/#/tests/${tests.finding}`);

        // idempotent per integration; the same test can have an issue in each tracker
        const again = await call("POST", `/api/tests/${tests.finding}/issue`, { integrationId: jiraId });
        expect(again.status).toBe(200);
        expect(again.body.link.externalId).toBe("SHOP-1");
        const links = (await call("GET", `/api/tests/${tests.finding}/issues`)).body;
        expect(links.map((l: any) => l.provider).sort()).toEqual(["github", "jira"]);
    });

    it("shows a revoked token when testing the saved connection", async () => {
        jiraRevoked = true;
        const bad = await call("POST", `/api/integrations/${jiraId}/test`);
        jiraRevoked = false;
        expect(bad.body).toMatchObject({ ok: false, code: "unauthorized" });
        expect(bad.body.message).not.toContain(JIRA_TOKEN);
    });
});

describe("outbound address guard", () => {
    it("refuses private and local addresses when BLOCK_PRIVATE_TARGETS is on, when saving and when calling", async () => {
        // a connection saved while local addresses were allowed...
        const id = (await connectGithub({ repo: "guarded" })).body.id as string;
        const t = seed(spec("API-020", "Guard finding"), "NEEDS_REVIEW", "Server error: GET /api/z returned 500");
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            // ...is refused on use,
            const use = await call("POST", `/api/tests/${t}/issue`, { integrationId: id });
            expect(use.status).toBe(502);
            expect(use.body.details.code).toBe("blocked");
            // and new ones are refused when saved.
            const local = await connectGithub();
            expect(local.status).toBe(400);
            expect(local.body.error).toMatch(/private|loopback/i);
            const metadata = await connectJira({ baseUrl: "http://169.254.169.254" });
            expect(metadata.status).toBe(400);
            const hits = ghCalls.length + jiraCalls.length;
            await connectGithub({ apiUrl: "http://localhost:5275" });
            expect(ghCalls.length + jiraCalls.length).toBe(hits); // nothing was sent
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("never follows a redirect (the Authorization header would travel with it)", async () => {
        const redirect = http.createServer((_req, res) => {
            res.writeHead(302, { location: `${GH}/repos/acme/shop` });
            res.end();
        });
        await new Promise<void>((r) => redirect.listen(5277, "127.0.0.1", r));
        const before = ghCalls.length;
        const res = await connectGithub({ apiUrl: "http://127.0.0.1:5277" });
        redirect.close();
        expect(res.status).toBe(502);
        expect(res.body.details.code).toBe("rejected");
        expect(ghCalls.length).toBe(before);
    });
});

describe("issue text", () => {
    const base = {
        testKey: "WEB-001",
        title: "Checkout works",
        suite: "Checkout",
        spec: spec("WEB-001", "Checkout works"),
        validationStatus: "NEEDS_REVIEW" as const,
        stepResults: [],
        testUrl: "https://p.example/#/tests/1",
    };

    it("keeps backticks and terminal colours in a failure message from breaking the Markdown", () => {
        const draft = buildIssueDraft({ ...base, reason: "\u001b[31mExpected ```code``` to be shown\u001b[0m\nCall log:\n  - noisy line", severity: { severity: "low", basis: "x" } });
        const md = toMarkdown(draft.blocks);
        expect(md).not.toContain("\u001b");
        expect(md).not.toContain("noisy line");
        expect(md).toContain("````\nExpected ```code``` to be shown\n````");
        expect(draft.title).toBe("[Low] Checkout works");
    });

    it("builds valid ADF for any content", () => {
        const doc = toAdf(buildIssueDraft({ ...base, reason: null }).blocks) as { type: string; content: Array<{ type: string }> };
        expect(doc.type).toBe("doc");
        expect(doc.content.length).toBeGreaterThan(5);
        expect(JSON.stringify(doc)).toContain("No further detail was recorded.");
    });
});

describe("JUnit endpoint (shared writer with the ai-test command)", () => {
    it("reports findings, broken tests, passes and never-run tests", async () => {
        const res = await server.inject({ method: "GET", url: `/api/projects/${projectId}/junit` });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/xml");
        const xml = res.body;
        expect(xml).toContain('name="Issues demo"');
        expect(xml).toContain('<failure type="application-finding" message="Server error: GET /api/cart returned 503');
        expect(xml).toContain('<failure type="test-failure" message="Verify response');
        expect(xml).toContain("<skipped");
        expect(xml).toMatch(/name="API-003: Products list loads" time="0\.120">\s*<properties>/);
    });
});

