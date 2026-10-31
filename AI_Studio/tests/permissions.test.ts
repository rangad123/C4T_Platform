/**
 * Permission-based access for Crowd4Test accounts (ACCESS_MODEL.md; US-001 to US-006, US-010), against a stand-in Crowd4Test API
 * on a local port, as tests/crowd4test-signin.test.ts does: without `ai_studio.access` an account is refused; ADMIN holds every code
 * and reaches every project; SUB_ADMIN, CUSTOMER and TESTER reach only the projects they were added to; the never-lists of testers
 * and customers hold whatever Crowd4Test says; customers stay in their organisation; a project keeps its last Project Admin; each
 * code is the one thing between a route's refusal and its answer; and a tester never sees cost or tokens on any GET route.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf, registeredRoutes } from "../src/platform/auth/access.js";
import { COST_FIELDS } from "../src/platform/auth/cost-hiding.js";
import { NO_AI_STUDIO } from "../src/platform/auth/crowd4test.js";
import { NEVER_FOR_CUSTOMER, NEVER_FOR_TESTER, PERMISSION_WORDS, PERMISSIONS, type Permission } from "../src/platform/auth/permissions.js";
import { classifyRoute } from "../src/platform/auth/project-scope.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { LAST_PROJECT_ADMIN, OTHER_ORGANIZATION } from "../src/platform/routes/members.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "perm-owner-key-5c1d77ab";
const SITE = "https://crowd4test.example";
const PAGE = { "x-requested-with": "ai-studio" };
const dirs: string[] = [];

const accounts = new Map<string, { status: number; body: unknown }>();
let api: http.Server;
let platform: Platform;
let app: App;

const c4t = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    status: 200,
    body: { data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } },
});
const ALL_CODES: readonly string[] = PERMISSIONS;

const as = (token: string, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, text: r.body, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));

/** The person here behind a Crowd4Test token (made on its first request). */
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;

let PA: string; // organisation org-a
let PB: string; // organisation org-b
let jobA: string;
let testA: string;

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        const answer = req.url === "/v1/auth/me" ? accounts.get(token) : undefined;
        res.writeHead(answer?.status ?? 401, { "content-type": "application/json" });
        res.end(JSON.stringify(answer?.body ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const port = (api.address() as AddressInfo).port;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-perm-"));
    dirs.push(dir);
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "perm-test-secret-key-0123456789", SECURITY_ASSESSMENT: "on", C4T_API_ORIGIN: `http://127.0.0.1:${port}`, C4T_SITE_URL: SITE }),
    );
    app = await buildServer(platform);
    await app.ready();

    accounts.set("t-admin", c4t("ada", "ADMIN", []));
    accounts.set("t-sub", c4t("sid", "SUB_ADMIN", ["ai_studio.access", "ai_studio.tests.write", "ai_studio.project.members"]));
    accounts.set("t-cust", c4t("cora", "CUSTOMER", ALL_CODES, "org-a"));
    accounts.set("t-cust-b", c4t("bea", "CUSTOMER", ALL_CODES, "org-b"));
    accounts.set("t-tester", c4t("tim", "TESTER", ALL_CODES));
    accounts.set("t-none", c4t("nell", "CUSTOMER", ["project.read"], "org-a"));

    // Two projects of two organisations, made by staff (the access key here), and a finished job whose counters carry AI tokens.
    PA = (await asKey("POST", "/api/projects", { name: "Alpha", organizationId: "org-a" })).body.id;
    PB = (await asKey("POST", "/api/projects", { name: "Bravo", organizationId: "org-b" })).body.id;
    const { repo, db } = platform;
    const appId = repo.createApplication(PA, "http://127.0.0.1:7301/", {});
    jobA = (await repo.createJob(PA, appId, { ...DEFAULT_JOB_OPTIONS })).id;
    repo.updateCounters(jobA, { llmInputTokens: 123_456, llmOutputTokens: 7_890, testsGenerated: 2 });
    repo.addEvent(jobA, { stage: "orchestration", kind: "ai_budget_stop", level: "warn", message: "Monthly token limit reached: used 1,000,000 of 1,000,000 tokens.", data: { used: 1_000_000, limit: 1_000_000 } });
    db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ? WHERE id = ?", new Date().toISOString(), jobA);
    const spec = TestSpecSchema.parse({ testId: "API-001", title: "Cart", kind: "api", category: "Checkout", priority: "high", steps: [{ action: "request", method: "GET", path: "/api/cart" }] });
    testA = repo.insertTest({ projectId: PA, suiteId: repo.getOrCreateSuite(PA, "Checkout", "checkout"), jobId: jobA, spec, framework: "playwright-api", validationStatus: "PENDING" });
}, 60_000);

afterAll(async () => {
    await app?.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("who may open AI Studio, and with which permissions", () => {
    it("refuses an account without ai_studio.access with the plain sentence, and makes no person for it", async () => {
        const res = await as("t-none", "GET", "/api/projects");
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: NO_AI_STUDIO, details: { crowd4test: "refused", portalUrl: `${SITE}/app` } });
        expect((await as("t-none", "GET", "/api/auth/state")).body.crowd4test).toMatchObject({ status: "refused", message: NO_AI_STUDIO });
        expect(accessControlOf(app).users.list().some((p) => p.email === "nell@people.example")).toBe(false);
    });

    it("gives Crowd4Test ADMIN every code and every project", async () => {
        const me = (await as("t-admin", "GET", "/api/auth/state")).body.me;
        expect(me).toMatchObject({ side: "admin", organizationId: null, permissions: [...PERMISSIONS] });
        expect((await as("t-admin", "GET", "/api/projects")).body.map((p: { id: string }) => p.id).sort()).toEqual([PA, PB].sort());
        const alpha = (await as("t-admin", "GET", `/api/projects/${PA}`)).body;
        expect(alpha.access).toEqual({ projectAdmin: false, permissions: [...PERMISSIONS] });
        expect(alpha.organization_id).toBe("org-a");
    });

    it("drops the never-lists: testers lose five codes, customers platform settings, whatever Crowd4Test sent", async () => {
        const tester = (await as("t-tester", "GET", "/api/auth/state")).body.me;
        expect(tester.side).toBe("tester");
        expect(tester.permissions).toEqual(PERMISSIONS.filter((c) => !NEVER_FOR_TESTER.has(c)));
        for (const code of NEVER_FOR_TESTER) expect(tester.permissions).not.toContain(code);
        const customer = (await as("t-cust", "GET", "/api/auth/state")).body.me;
        expect(customer).toMatchObject({ side: "customer", organizationId: "org-a" });
        expect(customer.permissions).toEqual(PERMISSIONS.filter((c) => !NEVER_FOR_CUSTOMER.has(c)));
        // And the routes agree.
        expect(await as("t-tester", "POST", "/api/projects", { name: "Mine" })).toMatchObject({ status: 403, body: { error: "You don't have permission to create projects. Ask your Crowd4Test administrator." } });
        expect((await as("t-tester", "GET", `/api/usage?projectId=${PA}`)).status).toBe(403);
        expect((await as("t-cust", "PUT", "/api/llm/fallbacks", { models: [] })).body.error).toBe(`You don't have permission to ${PERMISSION_WORDS["ai_studio.platform.settings"]}. Ask your Crowd4Test administrator.`);
    });
});

describe("projects in reach: only the ones a person was added to", () => {
    it("shows SUB_ADMIN, CUSTOMER and TESTER nothing until they are added, then only that project", async () => {
        for (const t of ["t-sub", "t-cust", "t-tester"]) {
            expect((await as(t, "GET", "/api/projects")).body).toEqual([]);
            expect((await as(t, "GET", `/api/projects/${PA}`)).status).toBe(404);
            expect((await as(t, "GET", `/api/tests/${testA}`)).status).toBe(404);
            expect((await as("t-admin", "POST", `/api/projects/${PA}/members`, { personId: await personOf(t) })).status).toBe(201);
            expect((await as(t, "GET", "/api/projects")).body.map((p: { id: string }) => p.id)).toEqual([PA]);
            expect((await as(t, "GET", `/api/projects/${PA}`)).body.access.projectAdmin).toBe(false);
            expect((await as(t, "GET", `/api/projects/${PB}`))).toMatchObject({ status: 404, body: { error: "Project not found" } });
            expect((await as(t, "GET", "/api/dashboard")).body.projects.map((p: { id: string }) => p.id)).toEqual([PA]);
        }
        const members = (await as("t-admin", "GET", `/api/projects/${PA}/members`)).body;
        expect(members.organizationId).toBe("org-a");
        expect(members.members.map((m: { kind: string }) => m.kind).sort()).toEqual(["admin", "customer", "tester"]);
        // Removing a person closes the project at once.
        const tim = await personOf("t-tester");
        expect((await as("t-admin", "DELETE", `/api/projects/${PA}/members/${tim}`)).status).toBe(200);
        expect((await as("t-tester", "GET", `/api/projects/${PA}`)).status).toBe(404);
        expect((await as("t-admin", "POST", `/api/projects/${PA}/members`, { personId: tim })).status).toBe(201);
    });

    it("never adds a customer to another organisation's project, and does not offer them", async () => {
        const cora = await personOf("t-cust");
        await personOf("t-cust-b");
        expect(await as("t-admin", "POST", `/api/projects/${PB}/members`, { personId: cora })).toMatchObject({ status: 403, body: { error: OTHER_ORGANIZATION } });
        const offered = (await as("t-admin", "GET", `/api/projects/${PB}/members/candidates`)).body;
        expect(offered.source).toBe("signed-in");
        expect(offered.people.map((p: { personId: string }) => p.personId)).not.toContain(cora);
        expect(offered.people.map((p: { email: string }) => p.email)).toContain("bea@people.example");
        expect((await as("t-admin", "GET", `/api/projects/${PA}/members/candidates?q=bea`)).body.people).toEqual([]);
        // A project without an organisation takes no customer at all.
        const free = (await asKey("POST", "/api/projects", { name: "No organisation" })).body.id;
        expect((await as("t-admin", "POST", `/api/projects/${free}/members`, { personId: cora })).status).toBe(403);
        // A customer whose project moved to another organisation loses it, membership or not (the organization rule).
        accessControlOf(app).projects.store.setProjectOrganization(PA, "org-b");
        expect((await as("t-cust", "GET", `/api/projects/${PA}`)).status).toBe(404);
        accessControlOf(app).projects.store.setProjectOrganization(PA, "org-a");
        expect((await as("t-cust", "GET", `/api/projects/${PA}`)).status).toBe(200);
    });

    it("puts a customer's new project in their organisation, with them as its Project Admin", async () => {
        expect(await as("t-cust", "POST", "/api/projects", { name: "Elsewhere", organizationId: "org-b" })).toMatchObject({ status: 403 });
        const made = await as("t-cust", "POST", "/api/projects", { name: "Cora's" });
        expect(made.status).toBe(201);
        expect(made.body.organization_id).toBe("org-a");
        const id = made.body.id as string;
        expect((await as("t-cust", "GET", "/api/projects")).body.map((p: { id: string }) => p.id).sort()).toEqual([PA, id].sort());
        expect((await as("t-cust", "GET", `/api/projects/${id}`)).body.access.projectAdmin).toBe(true);
        expect((await as("t-cust", "GET", `/api/projects/${id}/members`)).body.members).toMatchObject([{ email: "cora@people.example", projectAdmin: true, source: "creator" }]);
        // Staff choose the organisation; the creator becomes Project Admin too.
        const staff = await as("t-admin", "POST", "/api/projects", { name: "For org-b", organizationId: "org-b" });
        expect(staff.body.organization_id).toBe("org-b");
        expect((await as("t-admin", "GET", `/api/projects/${staff.body.id}`)).body.access.projectAdmin).toBe(true);
    });

    it("lets a customer find only people on their organisation's projects, or someone by exact email", async () => {
        const mine = (await as("t-cust", "GET", "/api/projects")).body.find((p: { name: string }) => p.name === "Cora's").id as string;
        accessControlOf(app).users.create({ email: "stranger@people.example", name: "Stranger", role: "viewer" });
        const emails = async (token: string, q: string) => (await as(token, "GET", `/api/projects/${mine}/members/candidates?q=${encodeURIComponent(q)}`)).body.people.map((x: { email: string }) => x.email);
        // tim works on Alpha, an org-a project: offered to its customer
        expect(await emails("t-cust", "tim")).toEqual(["tim@people.example"]);
        expect(await emails("t-cust", "stranger")).toEqual([]);
        expect(await emails("t-cust", "")).not.toContain("stranger@people.example");
        expect(await emails("t-cust", "STRANGER@people.example")).toEqual(["stranger@people.example"]);
        // staff still browse everyone
        expect(await emails("t-admin", "stranger")).toEqual(["stranger@people.example"]);
    });

    it("keeps the last Project Admin, and records every change in Activity", async () => {
        const id = (await as("t-cust", "POST", "/api/projects", { name: "Admins" })).body.id as string;
        const cora = await personOf("t-cust");
        const tim = await personOf("t-tester");
        expect(await as("t-cust", "PATCH", `/api/projects/${id}/members/${cora}`, { projectAdmin: false })).toMatchObject({ status: 409, body: { error: LAST_PROJECT_ADMIN } });
        expect(await as("t-cust", "DELETE", `/api/projects/${id}/members/${cora}`)).toMatchObject({ status: 409, body: { error: LAST_PROJECT_ADMIN } });
        expect((await as("t-cust", "POST", `/api/projects/${id}/members`, { personId: tim, projectAdmin: true })).status).toBe(201);
        expect((await as("t-cust", "POST", `/api/projects/${id}/members`, { personId: tim })).status).toBe(409);
        expect((await as("t-cust", "PATCH", `/api/projects/${id}/members/${cora}`, { projectAdmin: false })).body.member.projectAdmin).toBe(false);
        expect((await as("t-tester", "GET", `/api/projects/${id}`)).body.access.projectAdmin).toBe(true);
        expect(await as("t-cust", "DELETE", `/api/projects/${id}/members/${tim}`)).toMatchObject({ status: 409, body: { error: LAST_PROJECT_ADMIN } });
        // A tester can never manage members (D-26), even as Project Admin.
        expect((await as("t-tester", "GET", `/api/projects/${id}/members`)).status).toBe(403);
        const rows: Array<{ action: string; status: number; detail: string | null }> = (await asKey("GET", `/api/activity?project=${id}&limit=200`)).body.activity;
        expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["added to project", "no longer Project Admin"]));
        // The refused attempts are there too, with their answer.
        expect(rows.filter((r) => r.status === 409).length).toBeGreaterThanOrEqual(2);
        // And a refusal for a missing permission names it.
        await as("t-tester", "POST", `/api/projects/${id}/members`, { personId: cora });
        expect((await asKey("GET", `/api/activity?project=${id}&limit=5`)).body.activity[0]).toMatchObject({ status: 403, detail: "Refused: needs ai_studio.project.members" });
    });
});

describe("each permission is what stands between a route and its answer", () => {
    /** One route per code, on Alpha (where the account is a member). Allowed means: past the permission check (not 403). */
    const ROUTE_FOR: Record<Permission, () => [string, string, unknown?]> = {
        "ai_studio.access": () => ["GET", `/api/projects/${PA}/tests`],
        "ai_studio.project.create": () => ["POST", "/api/projects", { name: "By permission" }],
        "ai_studio.project.settings": () => ["PUT", `/api/projects/${PA}/framework-settings`, {}],
        "ai_studio.project.members": () => ["GET", `/api/projects/${PA}/members`],
        "ai_studio.tests.write": () => ["POST", `/api/projects/${PA}/test-data`, {}],
        "ai_studio.tests.generate": () => ["POST", `/api/projects/${PA}/test-generation`, {}],
        "ai_studio.tests.approve": () => ["POST", "/api/v1/security/applications/no-such-app/authorizations", {}],
        "ai_studio.tests.run": () => ["POST", `/api/projects/${PA}/runs`, {}],
        "ai_studio.agent.run": () => ["POST", "/api/recordings/no-such-recording/act", {}],
        "ai_studio.reports.export": () => ["GET", `/api/projects/${PA}/junit`],
        "ai_studio.tests.delete": () => ["DELETE", `/api/projects/${PA}/test-data/no-such-set`],
        "ai_studio.runners.manage": () => ["GET", `/api/projects/${PA}/agent-tokens`],
        "ai_studio.ai_keys.manage": () => ["POST", `/api/projects/${PA}/integrations`, {}],
        "ai_studio.usage.view": () => ["GET", `/api/usage?projectId=${PA}`],
        "ai_studio.security.use": () => ["PUT", `/api/v1/security/projects/${PA}/testing-type`, {}],
        "ai_studio.platform.settings": () => ["GET", "/api/activity"],
    };

    it("names a route for every code, and each route's table rule is that code", () => {
        expect(Object.keys(ROUTE_FOR).sort()).toEqual([...PERMISSIONS].sort());
        for (const [code, route] of Object.entries(ROUTE_FOR)) {
            if (code === "ai_studio.access") continue;
            const [method, url] = route();
            const template = url.split("?")[0]!.replace(PA, ":id").replace("no-such-app", ":appId").replace("no-such-recording", ":rid").replace("no-such-set", ":name");
            expect(permissionRuleFor(method, template), `${method} ${template}`).toBe(code);
        }
    });

    it("refuses each route without its code and lets it through with it (a manager, SUB_ADMIN, a member of Alpha)", async () => {
        const wrong: string[] = [];
        for (const code of PERMISSIONS) {
            const [method, url, body] = ROUTE_FOR[code]();
            const without = `t-without-${code}`;
            const withIt = `t-with-${code}`;
            // The same person each time (one Crowd4Test id), with different grants under different tokens.
            accounts.set(without, c4t("max", "SUB_ADMIN", code === "ai_studio.access" ? [] : ALL_CODES.filter((c) => c !== code)));
            accounts.set(withIt, c4t("max", "SUB_ADMIN", ["ai_studio.access", code]));
            if (code === PERMISSIONS[0]) {
                await as(withIt, "GET", "/api/auth/state");
                await as("t-admin", "POST", `/api/projects/${PA}/members`, { personId: await personOf(withIt) });
            }
            const refused = await as(without, method, url, body);
            const allowed = await as(withIt, method, url, body);
            const words = code === "ai_studio.access" ? NO_AI_STUDIO : `You don't have permission to ${PERMISSION_WORDS[code]}. Ask your Crowd4Test administrator.`;
            if (refused.status !== 403 || refused.body?.error !== words) wrong.push(`${code} without: ${refused.status} ${refused.text.slice(0, 120)}`);
            if (allowed.status === 403) wrong.push(`${code} with: ${allowed.status} ${allowed.text.slice(0, 120)}`);
        }
        expect(wrong, wrong.join("\n")).toEqual([]);
    }, 60_000);
});

describe("testers never see AI cost or tokens", () => {
    const jobOf = (jobs: Array<{ jobId: string; counters: Record<string, number> }>) => jobs.find((j) => j.jobId === jobA)!;
    const costKeys = (v: unknown, at = "$"): string[] => {
        if (Array.isArray(v)) return v.flatMap((x, i) => costKeys(x, `${at}[${i}]`));
        if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => (COST_FIELDS.has(k) ? [`${at}.${k}`] : costKeys(x, `${at}.${k}`)));
        return [];
    };

    it("shows the counters to people who may see usage, so the sweep below has something to hide", async () => {
        expect(jobOf((await asKey("GET", `/api/projects/${PA}/jobs`)).body).counters).toMatchObject({ llmInputTokens: 123_456, llmOutputTokens: 7_890 });
        // A customer granted ai_studio.usage.view sees them too.
        expect(jobOf((await as("t-cust", "GET", `/api/projects/${PA}/jobs`)).body).counters.llmInputTokens).toBe(123_456);
    });

    it("answers no GET route with a cost or token field, and refuses the usage routes", async () => {
        const seen = new Set<string>();
        const gets = registeredRoutes(app).filter((r) => r.method === "GET" && r.url.startsWith("/api/") && !r.url.endsWith("/stream") && !seen.has(r.url) && seen.add(r.url));
        expect(gets.length).toBeGreaterThan(120);
        const fill = (template: string) =>
            template.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
                const scope = classifyRoute("GET", template, undefined);
                if (scope?.kind === "project" && name === "id") return PA;
                if (name === "jobId" || (scope?.kind === "object" && scope.object === "job")) return jobA;
                if (scope?.kind === "object" && scope.object === "test") return testA;
                return "x";
            });
        const leaks: string[] = [];
        let answered = 0;
        for (const r of gets) {
            const url = fill(r.url) + (r.url === "/api/usage" ? `?projectId=${PA}` : "");
            const res = await as("t-tester", "GET", url);
            if (permissionRuleFor("GET", r.url) === "ai_studio.usage.view") {
                if (res.status !== 403) leaks.push(`${r.url}: usage route answered ${res.status}`);
                continue;
            }
            if (res.status === 200) answered++;
            const found = typeof res.body === "object" ? costKeys(res.body) : /llmInputTokens|"inputTokens"|123456|123,456/.test(res.text) ? ["text"] : [];
            if (found.length) leaks.push(`${r.url}: ${found.slice(0, 3).join(", ")}`);
        }
        expect(leaks, leaks.join("\n")).toEqual([]);
        expect(answered).toBeGreaterThan(60);
    }, 120_000);

    it("keeps the job's other counters, hides the AI limit's numbers in its events, and leaves no cost in the HTML report", async () => {
        const job = jobOf((await as("t-tester", "GET", `/api/projects/${PA}/jobs`)).body);
        expect(job.counters.testsGenerated).toBe(2);
        expect(job.counters).not.toHaveProperty("llmInputTokens");
        const events = await as("t-tester", "GET", `/api/test-generation/${jobA}/events`);
        expect(events.text).toContain("The AI usage limit was reached.");
        expect(events.text).not.toContain("1,000,000");
        const report = await as("t-tester", "GET", `/api/projects/${PA}/report`);
        expect(report.status).toBe(200);
        expect(report.text).toContain("<html");
        expect(report.text).not.toMatch(/123,?456|llmInputTokens|tokens|cost/i);
    });

    it("hides them in the live-update stream too, through the ticket", async () => {
        // A real socket: a stream takes the response over, which an injected request does not finish.
        const port = 7302;
        await app.listen({ port, host: "127.0.0.1" });
        const read = async (url: string): Promise<{ status: number; text: string }> => {
            const res = await fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(15_000) });
            return { status: res.status, text: await res.text() };
        };
        const ticket = (await as("t-tester", "POST", "/api/stream-tickets", { path: `/api/test-generation/${jobA}/stream` })).body.ticket;
        const mine = await read(`/api/test-generation/${jobA}/stream?ticket=${ticket}&lastEventId=0`);
        expect(mine.status).toBe(200);
        expect(mine.text).toContain("event: job");
        expect(mine.text).toContain("testsGenerated");
        expect(mine.text).toContain("The AI usage limit was reached.");
        expect(mine.text).not.toContain("llmInputTokens");
        expect(mine.text).not.toContain("1,000,000");
        // A made-up ticket opens nothing, also on a server signed in through Crowd4Test (it has people, so tickets are always checked).
        expect((await read(`/api/test-generation/${jobA}/stream?ticket=st_madeup`)).status).toBe(401);
        const keyTicket = (await asKey("POST", "/api/stream-tickets", { path: `/api/test-generation/${jobA}/stream` })).body.ticket;
        expect((await read(`/api/test-generation/${jobA}/stream?ticket=${keyTicket}&lastEventId=0`)).text).toContain("llmInputTokens");
    }, 60_000);
});
