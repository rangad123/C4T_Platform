/**
 * The Test Case Generation outcome and its workbook over the API (founder 2026-11-19, SPEC R3, R4.1, R4.2, R9, P3.2; PLAN.md C4), with
 * Crowd4Test accounts against a stand-in Crowd4Test API on a local port (as tests/permissions.test.ts does):
 *   - who may read the project gets its outcome; the workbook also needs ai_studio.reports.export (403 without it);
 *   - another organisation's project is a 404 for both, and its outcome is never sent;
 *   - the workbook is `<project name> test cases.xlsx`, an attachment, with the three sheets and the Q3 headers, and as many Pages rows as
 *     the outcome has pages and tree nodes;
 *   - no runs: 404 with a sentence; not a Test Case Generation project: caseAgent false, empty lists, and no workbook;
 *   - more than 5,000 test cases (the Import's limit): the workbook still downloads with every case, and its first sheet says how many more
 *     there are than the Import takes (lead decision 2026-11-20);
 *   - the CI validation of such a project is refused before it saves a new application record (FX4).
 * No browser, no AI: runs are seeded as a plan-only job would leave them (its plan artifact and events).
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { StoredPlan } from "../src/engine/planning/preview.js";
import { ScenarioSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CASE_AGENT_RUN_REFUSED } from "../src/platform/case-agent.js";
import { XLSX_MAX_ROWS as CASE_IMPORT_MAX_ROWS } from "../src/engine/manual/xlsx-read.js";
import { PLAN_ARTIFACT } from "../src/platform/plan-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { NO_CASE_RUNS, NOT_A_CASE_AGENT_PROJECT } from "../src/platform/routes/case-outcome.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "case-workbook-key-38d1a0";
const PAGE = { "x-requested-with": "ai-studio" };
const SITE = "http://127.0.0.1:6531";
const accounts = new Map<string, { status: number; body: unknown }>();
let api: http.Server;
let platform: Platform;
let app: App;
let dir = "";

const c4t = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    status: 200,
    body: { data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } },
});
const as = (token: string, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, headers: r.headers, raw: r.rawPayload, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, headers: r.headers, raw: r.rawPayload, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;

// ── reading a workbook back (fflate; nothing from the writer) ──
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
function sheets(bytes: Uint8Array): Array<{ name: string; rows: string[][] }> {
    const files = Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
    const rels = Object.fromEntries([...files["xl/_rels/workbook.xml.rels"]!.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    return [...files["xl/workbook.xml"]!.matchAll(/<sheet name="([^"]+)" sheetId="\d+" r:id="(rId\d+)"\/>/g)].map((m) => {
        const xml = files[`xl/${rels[m[2]!]}`]!;
        const rows: string[][] = [];
        for (const r of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
            const row: string[] = [];
            for (const c of r[2]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
                let col = 0;
                for (const ch of c[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
                const t = /<t xml:space="preserve">(.*?)<\/t>/s.exec(c[3] ?? "");
                row[col - 1] = t ? unesc(t[1]!) : "";
            }
            rows[Number(r[1]) - 1] = Array.from(row, (v) => v ?? "");
        }
        return { name: unesc(m[1]!), rows };
    });
}

// ── seeding a project and its runs ──
async function tcgProject(name: string, organizationId: string, agents = ["test-generation"], testingModes = ["agent"]): Promise<string> {
    const made = await asKey("POST", "/api/projects", { name, organizationId, platforms: ["web"], testingModes, agents });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    platform.repo.createApplication(made.body.id, SITE, { ...DEFAULT_JOB_OPTIONS });
    return made.body.id as string;
}
const model = (paths: string[]) => ({
    url: SITE,
    origin: SITE,
    pages: paths.map((p, i) => ({ url: `${SITE}${p}`, path: p, title: `Page ${p}`, purpose: `What ${p} is for`, type: "other", depth: i ? 1 : 0, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] })),
    navigation: paths.slice(1).map((p) => ({ from: "/", to: p, label: p })),
    apis: [],
    authentication: { required: false, mechanisms: [], loggedIn: false },
    externalDependencies: [],
    documentedTestCases: [],
    stats: { pagesVisited: paths.length, pagesSkipped: 0, apisFound: 0, durationMs: 1 },
    siteType: "ecommerce",
    purpose: "A shop",
    features: [],
    journeys: [],
});
async function seededRun(pid: string, paths: string[], ideas: Array<{ title: string; startPath: string }>, failed: string[] = []): Promise<string> {
    const appId = platform.repo.getLatestApplicationPublic(pid)!.id as string;
    const job = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, planOnly: true, targets: ["web"], functionalTests: true });
    const plan: StoredPlan = {
        version: 1,
        createdAt: new Date().toISOString(),
        model: model(paths) as never,
        scenarios: ideas.map((s, i) => ScenarioSchema.parse({ scenarioId: `S-${i + 1}`, title: s.title, description: s.title, category: "Browsing", priority: "high", startPath: s.startPath, preconditions: ["The shop is open"], expectedResults: [`${s.title}: done`] })),
        analysed: true,
        specBaseTrusted: false,
        accessReach: [],
        apiAccess: [],
        warnings: [],
    };
    const rel = `${pid}/_artifacts/${job.id}/plan.json`;
    const body = JSON.stringify(plan);
    await platform.store.put(rel, body);
    platform.repo.addArtifact({ projectId: pid, jobId: job.id, kind: PLAN_ARTIFACT, path: rel, size: body.length });
    for (const f of failed) platform.repo.addEvent(job.id, { stage: "discovery", kind: "page_failed", level: "warn", message: `Could not load ${SITE}${f}: net::ERR_CONNECTION_REFUSED` });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    return job.id;
}

let PA = ""; // a Test Case Generation project of org-a
let PB = ""; // one of org-b

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-workbook-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "case-workbook-secret-0123456789abcd", C4T_API_ORIGIN: `http://127.0.0.1:${port}`, C4T_SITE_URL: "https://crowd4test.example" } as never));
    app = await buildServer(platform);
    await app.ready();

    accounts.set("t-cora", c4t("cora", "CUSTOMER", PERMISSIONS, "org-a"));
    accounts.set("t-bea", c4t("bea", "CUSTOMER", PERMISSIONS, "org-b"));
    accounts.set("t-reader", c4t("rita", "SUB_ADMIN", ["ai_studio.access"]));
    PA = await tcgProject("Alpha Shop", "org-a");
    PB = await tcgProject("Bravo Shop", "org-b");
    for (const t of ["t-cora", "t-reader"]) expect((await asKey("POST", `/api/projects/${PA}/members`, { personId: await personOf(t) })).status).toBe(201);
    expect((await asKey("POST", `/api/projects/${PB}/members`, { personId: await personOf("t-bea") })).status).toBe(201);
    await seededRun(PA, ["/", "/products", "/about"], [{ title: "Browse the products", startPath: "/products" }, { title: "Read about us", startPath: "/about" }], ["/broken"]);
    await seededRun(PA, ["/", "/products", "/cart"], [{ title: "Browse the products", startPath: "/products" }, { title: "Add a product to the cart", startPath: "/cart" }]);
    await seededRun(PB, ["/", "/secret-page-of-bravo"], [{ title: "Bravo's own test case", startPath: "/" }]);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the outcome", () => {
    it("is the union of the project's runs, for anyone who may read the project", async () => {
        for (const who of ["t-cora", "t-reader"]) {
            const r = await as(who, "GET", `/api/projects/${PA}/outcome`);
            expect(r.status, who).toBe(200);
            expect(r.body.caseAgent).toBe(true);
            expect(r.body.pages.map((p: { path: string }) => p.path)).toEqual(["/", "/products", "/about", "/cart"]);
            expect(r.body.tree.map((t: { node: string }) => t.node)).toEqual(["/", "/products", "/about", "/cart"]);
            expect(r.body.cases.map((c: { id: string; title: string; page: string }) => [c.id, c.title, c.page])).toEqual([
                ["TC-001", "Browse the products", "/products"],
                ["TC-002", "Read about us", "/about"],
                ["TC-003", "Add a product to the cart", "/cart"],
            ]);
            expect(r.body.runs.map((x: { addedPages: number; addedCases: number; status: string }) => [x.status, x.addedPages, x.addedCases])).toEqual([
                ["completed", 1, 1],
                ["completed", 3, 2],
            ]);
            // The failed address is counted apart, never as a page.
            expect(r.body.notOpened).toBe(1);
        }
    });

    it("is a 404 for another organisation's project, and nothing of it is sent", async () => {
        for (const url of [`/api/projects/${PB}/outcome`, `/api/projects/${PB}/outcome/workbook`]) {
            const r = await as("t-cora", "GET", url);
            expect(r.status, url).toBe(404);
            expect(JSON.stringify(r.body)).not.toMatch(/Bravo|secret-page/);
        }
        // Its own organisation reads it.
        expect((await as("t-bea", "GET", `/api/projects/${PB}/outcome`)).body.pages.map((p: { path: string }) => p.path)).toEqual(["/", "/secret-page-of-bravo"]);
    });

    it("answers caseAgent false and empty lists for a project that is not a Test Case Generation project, which has no workbook", async () => {
        for (const [name, agents, modes] of [["Accessibility only", ["accessibility"], ["agent"]], ["Mixed", ["test-generation"], ["agent", "code"]], ["Code", undefined, ["code"]]] as const) {
            const made = await asKey("POST", "/api/projects", { name, organizationId: "org-a", platforms: ["web"], testingModes: modes.length > 1 ? ["agent"] : modes, ...(agents ? { agents } : {}) });
            expect(made.status, JSON.stringify(made.body)).toBe(201);
            const pid = made.body.id as string;
            // A mixed project cannot be made through the API any more; this one is turned into one.
            if (modes.length > 1) platform.db.run("UPDATE projects SET testing_modes = ? WHERE id = ?", JSON.stringify(modes), pid);
            platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS });
            await seededRun(pid, ["/", "/x"], [{ title: "Something", startPath: "/" }]);
            expect((await asKey("GET", `/api/projects/${pid}/outcome`)).body).toEqual({ caseAgent: false, runs: [], pages: [], tree: [], cases: [], notOpened: 0, missing: [] });
            expect((await asKey("GET", `/api/projects/${pid}/outcome/workbook`)).body).toEqual({ error: NOT_A_CASE_AGENT_PROJECT });
        }
    });
});

describe("the workbook", () => {
    it("downloads as `<project name> test cases.xlsx` with the three sheets, the Q3 headers and one Pages row per tree node", async () => {
        const r = await as("t-cora", "GET", `/api/projects/${PA}/outcome/workbook`);
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        expect(r.headers["content-disposition"]).toBe(`attachment; filename="Alpha Shop test cases.xlsx"; filename*=UTF-8''Alpha%20Shop%20test%20cases.xlsx`);
        const book = sheets(new Uint8Array(r.raw));
        expect(book.map((s) => s.name)).toEqual(["Test cases", "Pages", "Tree"]);
        const [cases, pages, tree] = book.map((s) => s.rows);
        // R3: exactly the Q3 columns, no script column.
        expect(cases![0]).toEqual(["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement", "Test data", "Check"]);
        expect(pages![0]).toEqual(["Page", "Address", "Purpose"]);
        expect(tree![0]).toEqual(["Node", "Parent", "Page"]);
        const outcome = (await as("t-cora", "GET", `/api/projects/${PA}/outcome`)).body;
        // P3.2: one count everywhere.
        expect(pages!.length - 1).toBe(outcome.pages.length);
        expect(tree!.length - 1).toBe(outcome.tree.length);
        expect(cases!.slice(1).map((c) => [c[0], c[1], c[2], c[4], c[5], c[6], c[7]])).toEqual([
            ["TC-001", "Browse the products", "Automated", "/products", "The shop is open", "", "Browse the products: done"],
            ["TC-002", "Read about us", "Automated", "/about", "The shop is open", "", "Read about us: done"],
            ["TC-003", "Add a product to the cart", "Automated", "/cart", "The shop is open", "", "Add a product to the cart: done"],
        ]);
        expect(tree!.slice(1)).toEqual([
            ["/", "", "/"],
            ["/products", "/", "/products"],
            ["/about", "/", "/about"],
            ["/cart", "/", "/cart"],
        ]);
    });

    it("needs ai_studio.reports.export: 403 for a reader, who still gets the outcome", async () => {
        const r = await as("t-reader", "GET", `/api/projects/${PA}/outcome/workbook`);
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/permission/);
        expect((await as("t-reader", "GET", `/api/projects/${PA}/outcome`)).status).toBe(200);
    });

    it("is a 404 with a sentence for a project with no runs yet", async () => {
        const pid = await tcgProject("No runs yet", "org-a");
        expect(await asKey("GET", `/api/projects/${pid}/outcome/workbook`)).toMatchObject({ status: 404, body: { error: NO_CASE_RUNS } });
        expect((await asKey("GET", `/api/projects/${pid}/outcome`)).body).toMatchObject({ caseAgent: true, runs: [], pages: [], cases: [] });
    });

    it("still downloads past the Import's 5,000 test cases, with every case, and says on its first sheet how many more there are", async () => {
        const pid = await tcgProject("Big shop", "org-a");
        const total = CASE_IMPORT_MAX_ROWS + 3;
        await seededRun(pid, ["/"], Array.from({ length: total }, (_, i) => ({ title: `Case number ${i + 1}`, startPath: "/" })));
        const r = await asKey("GET", `/api/projects/${pid}/outcome/workbook`);
        expect(r.status).toBe(200);
        const rows = sheets(new Uint8Array(r.raw))[0]!.rows;
        const caseRows = rows.slice(1).filter((x) => x[1]);
        expect(caseRows).toHaveLength(total);
        const note = rows.at(-1)!;
        expect(note[0]).toContain("5,003 test cases, 3 more than a code project's Import takes (5,000)");
        // The note is in the ID column only, so an Import never reads it as a test case (it has no title).
        expect(note.slice(1).every((c) => c === "")).toBe(true);
        // At the limit there is no note.
        const atLimit = await tcgProject("Shop at the limit", "org-a");
        await seededRun(atLimit, ["/"], Array.from({ length: 2 }, (_, i) => ({ title: `Case ${i}`, startPath: "/" })));
        const small = sheets(new Uint8Array((await asKey("GET", `/api/projects/${atLimit}/outcome/workbook`)).raw))[0]!.rows;
        expect(small.every((x) => !/^Note:/.test(x[0] ?? ""))).toBe(true);
    }, 60_000);
});

describe("the CI validation of a Test Case Generation project (FX4)", () => {
    it("is refused before a new application record is saved", async () => {
        const pid = await tcgProject("CI shop", "org-a");
        // An old test saved before, so the route gets as far as the address and sign-in it was sent.
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Open the home page", kind: "web", category: "Browsing", priority: "medium", steps: [{ action: "navigate", url: "/" }] });
        platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "Web", "web"), jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
        const before = platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE project_id = ?", pid)!.n;
        const r = await asKey("POST", `/api/projects/${pid}/validation`, { baseUrl: SITE, apiBaseUrl: `${SITE}/api`, credentials: { username: "ci", password: "ci-pass" } });
        expect(r).toMatchObject({ status: 409, body: { error: CASE_AGENT_RUN_REFUSED } });
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE project_id = ?", pid)!.n).toBe(before);
    });
});
