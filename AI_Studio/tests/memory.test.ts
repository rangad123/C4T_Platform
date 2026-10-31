/**
 * Site memory without a browser: what is distilled (and what must never be), fingerprints, the change summary
 * (a table of cases), size and version handling, corrupted records, the bounded prompt section, and the API.
 * The two-analysis journey through real jobs is in memory-pipeline.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MAX_CONTEXT_CHARS, MEMORY_HEADING, memoryContext } from "../src/engine/memory/context.js";
import { diffKnowledge } from "../src/engine/memory/diff.js";
import { distillKnowledge, memoryPath, pageFingerprint, scrubText } from "../src/engine/memory/distill.js";
import { openMemory, secretValues } from "../src/engine/memory/session.js";
import { MAX_MEMORY_BYTES, MEMORY_VERSION, SiteKnowledgeSchema, type SiteKnowledge } from "../src/engine/memory/types.js";
import type { EngineEvent } from "../src/engine/context.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { forgetMemory, latestMemory, loadMemory, saveMemory } from "../src/platform/memory-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

// ── builders ──────────────────────────────────────────────────────────────────
const page = (p: string, over: Partial<PageModel> = {}): PageModel => ({
    url: `http://shop.test${p}`, path: p, title: `Title of ${p}`, type: "content", depth: 1, status: 200, headings: [`Heading of ${p}`], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], ...over,
});
const model = (over: Partial<AppModel> = {}): AppModel => ({
    url: "http://shop.test/", origin: "http://shop.test", siteType: "ecommerce", purpose: "Sells things", features: [], navigation: [], apis: [],
    pages: [page("/"), page("/products")], journeys: [], externalDependencies: [], documentedTestCases: [],
    authentication: { required: false, mechanisms: [], loggedIn: false },
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 }, ...over,
});
const api = (method: string, p: string) => ({ method, path: p, origin: "http://shop.test", statuses: [200], queryParams: [], source: "network" as const, usedIn: [] });
const journey = (name: string, pages: string[] = ["/"]) => ({ name, description: "d", steps: ["s"], priority: "high" as const, pages, requiresAuth: false });

// ── what is stored, and what never is ─────────────────────────────────────────
describe("distillation keeps structure only", () => {
    const S = { user: "sentinel-user-4410", pass: "SentinelPass-4410!", token: "tok-SENTINEL-4410-abcdef", text: "SENTINEL-PAGE-TEXT-1", link: "SENTINEL-LINK-2", label: "SENTINEL-LABEL-3", placeholder: "SENTINEL-PLACEHOLDER-4", step: "SENTINEL-STEP-5", body: "SENTINEL-BODY-6", revealed: "SENTINEL-REVEALED-7" };
    const hostile = model({
        purpose: `Shop where ${S.user} signs in with ${S.pass}`,
        pages: [
            page("/login?next=/account&token=" + S.token, {
                title: `Sign in ${S.user}@example.test`,
                type: "login",
                headings: ["Sign in"],
                aria: S.text, text: S.text, revealed: [S.revealed],
                links: [{ text: S.link, href: "/x" }],
                forms: [{ purpose: "login", fields: [{ type: "email", name: "email", label: S.label, placeholder: S.placeholder, required: true }, { type: "password", name: "password", required: true }] }],
                components: [{ role: "button", name: S.text, locatorHint: S.text }],
                apiCalls: [`GET /secret?t=${S.token}`],
            }),
            page("/users/alice@example.test/orders"),
            page("/orders/123e4567-e89b-12d3-a456-426614174000"),
        ],
        apis: [{ ...api("get", "/api/me"), examplePath: `/api/me?token=${S.token}`, sampleRequestBody: { password: S.pass, note: S.body } }, api("GET", "/api/orders/{id}")],
        journeys: [{ ...journey(`Sign in as ${S.user}`, ["/login"]), steps: [`Type ${S.pass} into the password box`, S.step], description: S.step }],
        authentication: { required: true, loginPath: "/login?next=/account", mechanisms: ["form"], loggedIn: true, loginError: S.text },
    });
    const knowledge = distillKnowledge(hostile, {
        secrets: [S.user, S.pass, S.token],
        scenarios: [{ title: `Log in with ${S.pass}`, journey: `Sign in as ${S.user}`, startPath: "/login", validated: true }],
    });
    const stored = JSON.stringify(knowledge);

    it("stores none of the credential, text, label, placeholder, step or body sentinels", () => {
        for (const v of Object.values(S)) expect(stored, v).not.toContain(v);
        expect(stored).not.toContain("example.test"); // e-mail addresses are replaced, including those in paths
        expect(stored).not.toContain("123e4567");
    });

    it("keeps the structural facts", () => {
        expect(knowledge.pages.map((p) => p.path)).toEqual(["/login", "/orders/{id}", "/users/{email}/orders"]);
        expect(knowledge.pages.find((p) => p.path === "/login")!.type).toBe("login");
        expect(knowledge.loginPath).toBe("/login");
        expect(knowledge.apis.map((a) => `${a.method} ${a.path}`)).toEqual(["GET /api/me", "GET /api/orders/{}"]);
        expect(knowledge.journeys).toHaveLength(1);
        expect(knowledge.journeys[0]!.validated).toHaveLength(1);
        expect(knowledge.learned).toMatch(/ecommerce site, 3 pages, 1 journey \(1 with validated tests\), 2 API endpoints, sign-in at \/login/);
        expect(SiteKnowledgeSchema.safeParse(knowledge).success).toBe(true);
    });

    it("finds every credential value of a request, including the part after a scheme", () => {
        const found = secretValues({ credentials: { username: "u1234", password: "p1234", apiAuthHeader: "Bearer abc.def.ghi", oauth2: { clientId: "cid", clientSecret: "csecret" } }, roles: [{ username: "admin", password: "adminpw", apiToken: "role-tok" }] });
        expect(found).toEqual(expect.arrayContaining(["u1234", "p1234", "Bearer abc.def.ghi", "abc.def.ghi", "csecret", "adminpw", "role-tok"]));
    });
});

describe("scrubbing and path normalising (table)", () => {
    const text: Array<[string, string[], string]> = [
        ["write to me@example.com", [], "write to [email]"],
        ["hunter2-secret was typed", ["hunter2-secret"], "[redacted] was typed"],
        ["Authorization: Bearer abcdefghij1234", [], "Authorization: [token]"],
        ["key sk1234567890abcdefghij12345678", [], "key [token]"],
        ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", [], "[token]"],
        ["plain words only", [], "plain words only"],
        ["ab", ["ab"], "ab"], // too short to be treated as a secret
    ];
    for (const [input, secrets, out] of text) it(`text: ${input}`, () => expect(scrubText(input, secrets)).toBe(out));

    const paths: Array<[string, string]> = [
        ["/products?id=5#top", "/products"],
        ["http://x.test/a/b/?q=1", "/a/b"],
        ["/", "/"],
        ["", "/"],
        ["/orders/42", "/orders/42"],
        ["/orders/1234567890123", "/orders/{id}"],
        ["/u/alice@example.test", "/u/{email}"],
        ["/u/alice%40example.test", "/u/{email}"],
        ["/files/0123456789abcdef0123", "/files/{token}"],
        ["/s/abcDEF123456789012345678901", "/s/{token}"],
        ["/a//b", "/a/b"],
    ];
    for (const [input, out] of paths) it(`path: ${JSON.stringify(input)}`, () => expect(memoryPath(input)).toBe(out));
});

// ── fingerprints ──────────────────────────────────────────────────────────────
describe("page fingerprints", () => {
    const form = (names: string[], purpose: "search" | "login" = "search") => ({ purpose, fields: names.map((n) => ({ type: "text", name: n, required: false })) });
    const fp = (headings: string[], forms: ReturnType<typeof form>[] = []) => pageFingerprint({ headings, forms });

    it("is stable across calls, field order, case, spacing and changing numbers", () => {
        expect(fp(["Products"])).toBe(fp(["Products"]));
        expect(fp(["Products"], [form(["q", "sort"])])).toBe(fp(["Products"], [form(["sort", "q"])]));
        expect(fp(["Our  PRODUCTS"])).toBe(fp(["our products"]));
        expect(fp(["Cart (3 items)"])).toBe(fp(["Cart (12 items)"]));
        expect(fp(["Orders"], [form(["a"]), form(["b"], "login")])).toBe(fp(["Orders"], [form(["b"], "login"), form(["a"])]));
    });

    it("changes when headings or form fields change, and ignores page text", () => {
        const base = fp(["Products"], [form(["q"])]);
        expect(fp(["All products"], [form(["q"])])).not.toBe(base);
        expect(fp(["Products", "Filters"], [form(["q"])])).not.toBe(base);
        expect(fp(["Products"], [form(["q", "page"])])).not.toBe(base);
        expect(fp(["Products"], [])).not.toBe(base);
        const a = page("/p", { headings: ["Products"], text: "one", aria: "x", links: [{ text: "a", href: "/a" }] });
        const b = page("/p", { headings: ["Products"], text: "something else entirely", aria: "y", links: [] });
        expect(pageFingerprint(a)).toBe(pageFingerprint(b));
    });

    it("is a 16-character hex string and never contains the heading", () => {
        expect(fp(["Secret heading"])).toMatch(/^[0-9a-f]{16}$/);
    });
});

// ── change summary ────────────────────────────────────────────────────────────
describe("change summary (table of cases)", () => {
    const base = (): SiteKnowledge => distillKnowledge(model({
        pages: [page("/"), page("/products"), page("/about"), page("/contact")],
        apis: [api("GET", "/api/items"), api("GET", "/api/legacy"), api("POST", "/api/cart")],
        journeys: [journey("Browse"), journey("Read about us", ["/about"])],
    }), { scenarios: [{ title: "Browse works", journey: "Browse", startPath: "/", validated: true }, { title: "About works", journey: "Read about us", startPath: "/about", validated: true }] });

    const next = (m: Partial<AppModel>, validated: string[] = ["Browse works", "About works"]) =>
        distillKnowledge(model({ pages: [page("/"), page("/products"), page("/about"), page("/contact")], apis: [api("GET", "/api/items"), api("GET", "/api/legacy"), api("POST", "/api/cart")], journeys: [journey("Browse"), journey("Read about us", ["/about"])], ...m }), {
            scenarios: [{ title: "Browse works", journey: "Browse", startPath: "/", validated: validated.includes("Browse works") }, { title: "About works", journey: "Read about us", startPath: "/about", validated: validated.includes("About works") }],
        });

    const cases: Array<{ name: string; current: SiteKnowledge; text: string; counts: Partial<ReturnType<typeof diffKnowledge>["counts"]>; lists?: Partial<Record<keyof ReturnType<typeof diffKnowledge>, unknown>> }> = [
        { name: "nothing changed", current: next({}), text: "Since the last analysis: nothing changed.", counts: {} },
        { name: "two pages added", current: next({ pages: [page("/"), page("/products"), page("/about"), page("/contact"), page("/news"), page("/blog")] }), text: "Since the last analysis: 2 new pages.", counts: { pagesAdded: 2 }, lists: { pagesAdded: ["/blog", "/news"] } },
        { name: "one page not found", current: next({ pages: [page("/"), page("/products"), page("/about")] }), text: "Since the last analysis: 1 page no longer found.", counts: { pagesRemoved: 1 }, lists: { pagesRemoved: ["/contact"] } },
        { name: "one page changed (heading)", current: next({ pages: [page("/"), page("/products", { headings: ["Everything"] }), page("/about"), page("/contact")] }), text: "Since the last analysis: 1 page changed.", counts: { pagesChanged: 1 }, lists: { pagesChanged: ["/products"] } },
        { name: "one page changed (new form field)", current: next({ pages: [page("/"), page("/products"), page("/about"), page("/contact", { forms: [{ purpose: "contact", fields: [{ type: "text", name: "msg", required: true }] }] })] }), text: "Since the last analysis: 1 page changed.", counts: { pagesChanged: 1 }, lists: { pagesChanged: ["/contact"] } },
        { name: "endpoint gone, endpoint new", current: next({ apis: [api("GET", "/api/items"), api("POST", "/api/cart"), api("GET", "/api/orders")] }), text: "Since the last analysis: 1 new endpoint, 1 endpoint gone.", counts: { endpointsAdded: 1, endpointsRemoved: 1 }, lists: { endpointsAdded: ["GET /api/orders"], endpointsRemoved: ["GET /api/legacy"] } },
        { name: "same path, other method is a new endpoint", current: next({ apis: [api("GET", "/api/items"), api("GET", "/api/legacy"), api("POST", "/api/cart"), api("DELETE", "/api/cart")] }), text: "Since the last analysis: 1 new endpoint.", counts: { endpointsAdded: 1 }, lists: { endpointsAdded: ["DELETE /api/cart"] } },
        { name: "a journey stops validating", current: next({}, ["Browse works"]), text: "Since the last analysis: 1 journey no longer validating.", counts: { journeysNoLongerValidating: 1 }, lists: { journeysNoLongerValidating: ["Read about us"] } },
        { name: "a journey disappears", current: next({ journeys: [journey("Browse")] }), text: "Since the last analysis: 1 journey no longer validating.", counts: { journeysNoLongerValidating: 1 } },
        { name: "everything at once", current: next({ pages: [page("/"), page("/products", { headings: ["X"] }), page("/news")], apis: [api("GET", "/api/items")] }, ["Browse works"]), text: "Since the last analysis: 1 new page, 1 page changed, 2 pages no longer found, 2 endpoints gone, 1 journey no longer validating.", counts: { pagesAdded: 1, pagesChanged: 1, pagesRemoved: 2, endpointsRemoved: 2, journeysNoLongerValidating: 1 } },
    ];
    for (const c of cases) {
        it(c.name, () => {
            const d = diffKnowledge(base(), c.current);
            expect(d.text).toBe(c.text);
            expect(d.counts).toEqual({ pagesAdded: 0, pagesRemoved: 0, pagesChanged: 0, endpointsAdded: 0, endpointsRemoved: 0, journeysNoLongerValidating: 0, ...c.counts });
            for (const [k, v] of Object.entries(c.lists ?? {})) expect((d as unknown as Record<string, unknown>)[k]).toEqual(v);
        });
    }

    it("does not judge journeys when the new analysis validated nothing (carried over, not measured)", () => {
        const before = base();
        const noScenarios = distillKnowledge(model({ pages: before.pages.map((p) => page(p.path)), apis: [api("GET", "/api/items")], journeys: [journey("Browse"), journey("Read about us", ["/about"])] }), { previous: before });
        expect(noScenarios.validationKnown).toBe(false);
        expect(noScenarios.journeys.map((j) => j.validated.length)).toEqual([1, 1]); // carried forward
        expect(diffKnowledge(before, noScenarios).counts.journeysNoLongerValidating).toBe(0);
    });

    it("caps the listed items but keeps true counts", () => {
        const many = distillKnowledge(model({ pages: Array.from({ length: 120 }, (_, i) => page(`/p${i}`)) }));
        const d = diffKnowledge(distillKnowledge(model({ pages: [] })), many);
        expect(d.pagesAdded).toHaveLength(50);
        expect(d.counts.pagesAdded).toBe(120);
        expect(d.text).toBe("Since the last analysis: 120 new pages.");
    });
});

// ── size ──────────────────────────────────────────────────────────────────────
describe("size cap", () => {
    it("a huge site is distilled to under the limit and still validates", () => {
        const huge = model({
            pages: Array.from({ length: 3000 }, (_, i) => page(`/section-${i}/item-${i}-with-a-reasonably-long-path-name`, { title: "T".repeat(200) })),
            apis: Array.from({ length: 2000 }, (_, i) => api("GET", `/api/resource-${i}/with/a/long/path/${i}`)),
            journeys: Array.from({ length: 200 }, (_, i) => journey(`Journey ${i}`, Array.from({ length: 40 }, (_, j) => `/p${j}`))),
        });
        const k = distillKnowledge(huge);
        expect(Buffer.byteLength(JSON.stringify(k))).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
        expect(SiteKnowledgeSchema.safeParse(k).success).toBe(true);
        expect(k.pages.length).toBeGreaterThan(0);
        expect(k.journeys.length).toBeLessThanOrEqual(40);
    });
});

// ── the prompt section ────────────────────────────────────────────────────────
describe("prompt section", () => {
    const small = distillKnowledge(model({ pages: [page("/"), page("/about")], apis: [api("GET", "/api/items")], journeys: [journey("Browse")] }), { scenarios: [{ title: "Browse works", journey: "Browse", startPath: "/", validated: true }] });

    it("names what is known and tells the model the crawl stays the source of truth", () => {
        const text = memoryContext(small, "understanding");
        expect(text).toContain(MEMORY_HEADING);
        expect(text).toContain("/about [content]");
        expect(text).toContain(`"Browse"`);
        expect(text).toContain("GET /api/items");
        expect(text).toMatch(/Do NOT describe a page, feature or journey that the crawl data does not show/);
        expect(memoryContext(small, "planning")).toMatch(/Do NOT plan scenarios for pages or controls that are not in the model/);
    });

    it("includes what the new crawl shows, using 'not found' wording", () => {
        const now = distillKnowledge(model({ pages: [page("/"), page("/news")], apis: [] }));
        const text = memoryContext(small, "understanding", diffKnowledge(small, now, { journeys: false }));
        expect(text).toContain("new pages: /news");
        expect(text).toContain("not found in this crawl: /about");
        expect(text).toContain("endpoints not seen now: GET /api/items");
    });

    it("is bounded even for a huge record, and the closing rule always survives", () => {
        const huge = distillKnowledge(model({ pages: Array.from({ length: 400 }, (_, i) => page(`/long-section-name-${i}/with/many/parts`, { title: "A fairly long title for the page" })), apis: Array.from({ length: 300 }, (_, i) => api("GET", `/api/long/endpoint/${i}`)), journeys: Array.from({ length: 60 }, (_, i) => journey(`A long journey name number ${i}`)) }));
        for (const stage of ["understanding", "planning"] as const) {
            const text = memoryContext(huge, stage);
            expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
            expect(text.startsWith(MEMORY_HEADING)).toBe(true);
            expect(text).toMatch(stage === "understanding" ? /Do NOT describe/ : /Do NOT plan/);
        }
        expect(memoryContext(huge, "understanding")).toMatch(/and \d+ more/);
    });
});

// ── persistence, versions, corruption, isolation, API ────────────────────────
describe("storage and API", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-memory-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server?.close();
        platform.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const db = () => platform.db;
    const newProject = (name: string) => (platform.repo.createProject({ name }) as { id: string }).id;
    const get = async (url: string) => {
        const res = await server.inject({ method: "GET", url });
        return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    const first = distillKnowledge(model({ pages: [page("/"), page("/about")], apis: [api("GET", "/api/items")], journeys: [journey("Browse")] }));

    it("saves, loads, replaces and survives a restart of the database", () => {
        const p = newProject("persist");
        expect(loadMemory(db(), p, "http://shop.test")).toEqual({ knowledge: null });
        saveMemory(db(), { projectId: p, knowledge: first, changes: null });
        expect(loadMemory(db(), p, "http://shop.test").knowledge).toEqual(first);
        const second = distillKnowledge(model({ pages: [page("/")] }));
        saveMemory(db(), { projectId: p, knowledge: second, changes: diffKnowledge(first, second) });
        const stored = latestMemory(db(), p)!;
        expect(stored.knowledge.pages).toHaveLength(1);
        expect(stored.changes!.text).toBe("Since the last analysis: 1 page no longer found, 1 endpoint gone.");
        expect(db().all("SELECT * FROM site_memory WHERE project_id = ?", p)).toHaveLength(1);
        // "restart": a second connection to the same file sees the same record
        const again = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        expect(loadMemory(again.db, p, "http://shop.test").knowledge).toEqual(second);
        again.db.close();
    });

    it("keeps one memory per application and only a handful per project", () => {
        const p = newProject("origins");
        for (let i = 0; i < 8; i++) saveMemory(db(), { projectId: p, knowledge: { ...first, origin: `http://site${i}.test` }, changes: null, now: new Date(2026, 0, 1 + i).toISOString() });
        const origins = db().all<{ origin: string }>("SELECT origin FROM site_memory WHERE project_id = ? ORDER BY origin", p).map((r) => r.origin);
        expect(origins).toEqual(["http://site3.test", "http://site4.test", "http://site5.test", "http://site6.test", "http://site7.test"]);
        expect(loadMemory(db(), p, "http://site0.test").knowledge).toBeNull();
        expect(latestMemory(db(), p)!.knowledge.origin).toBe("http://site7.test");
    });

    it("ignores a record from an unknown version (and keeps it), without failing", () => {
        const p = newProject("version");
        saveMemory(db(), { projectId: p, knowledge: first, changes: null });
        db().run("UPDATE site_memory SET version = ? WHERE project_id = ?", MEMORY_VERSION + 1, p);
        const r = loadMemory(db(), p, "http://shop.test");
        expect(r.knowledge).toBeNull();
        expect(r.warning).toMatch(/different version/);
        expect(db().all("SELECT 1 FROM site_memory WHERE project_id = ?", p)).toHaveLength(1);
        expect(latestMemory(db(), p)).toBeNull();
    });

    it("drops a corrupted record with a warning", () => {
        for (const bad of ["{not json", JSON.stringify({ version: MEMORY_VERSION, origin: "http://shop.test", pages: "nope" }), JSON.stringify({ ...first, pages: [{ path: "/", type: "alien", title: "", fp: "zz" }] })]) {
            const p = newProject("corrupt");
            saveMemory(db(), { projectId: p, knowledge: first, changes: null });
            db().run("UPDATE site_memory SET knowledge_json = ? WHERE project_id = ?", bad, p);
            const r = loadMemory(db(), p, "http://shop.test");
            expect(r.knowledge).toBeNull();
            expect(r.warning).toMatch(/damaged or too large/);
            expect(db().all("SELECT 1 FROM site_memory WHERE project_id = ?", p)).toHaveLength(0);
        }
    });

    it("drops an oversized record, and refuses to store one", () => {
        const p = newProject("oversized");
        saveMemory(db(), { projectId: p, knowledge: first, changes: null });
        db().run("UPDATE site_memory SET knowledge_json = ?, size_bytes = ? WHERE project_id = ?", JSON.stringify({ ...first, learned: "x".repeat(MAX_MEMORY_BYTES) }), MAX_MEMORY_BYTES + 10, p);
        expect(loadMemory(db(), p, "http://shop.test").warning).toMatch(/damaged or too large/);
        expect(() => saveMemory(db(), { projectId: p, knowledge: { ...first, learned: "x".repeat(601) }, changes: null })).toThrow();
    });

    it("a project never sees another project's memory, and forgetting is per project", () => {
        const a = newProject("iso-a");
        const b = newProject("iso-b");
        saveMemory(db(), { projectId: a, knowledge: first, changes: null });
        expect(loadMemory(db(), b, "http://shop.test").knowledge).toBeNull();
        expect(latestMemory(db(), b)).toBeNull();
        saveMemory(db(), { projectId: b, knowledge: { ...first, siteType: "blog" }, changes: null });
        expect(forgetMemory(db(), a)).toBe(1);
        expect(loadMemory(db(), a, "http://shop.test").knowledge).toBeNull();
        expect(loadMemory(db(), b, "http://shop.test").knowledge!.siteType).toBe("blog");
    });

    it("is removed with its project", () => {
        const p = newProject("cascade");
        saveMemory(db(), { projectId: p, knowledge: first, changes: null });
        db().run("DELETE FROM projects WHERE id = ?", p);
        expect(db().all("SELECT 1 FROM site_memory WHERE project_id = ?", p)).toHaveLength(0);
    });

    it("GET says nothing is remembered yet, then gives a summary without fingerprints or raw records", async () => {
        const p = newProject("api");
        const empty = await get(`/api/projects/${p}/memory`);
        expect(empty.status).toBe(200);
        expect(empty.body.remembered).toBe(false);
        expect(empty.body.message).toMatch(/Nothing has been learned/);

        saveMemory(db(), { projectId: p, knowledge: first, changes: diffKnowledge(first, distillKnowledge(model({ pages: [page("/"), page("/new")], apis: [] }))) });
        const res = await get(`/api/projects/${p}/memory`);
        expect(res.body).toMatchObject({ remembered: true, origin: "http://shop.test", siteType: "ecommerce", counts: { pages: 2, journeys: 1, endpoints: 1 } });
        expect(res.body.changes.text).toBe("Since the last analysis: 1 new page, 1 page no longer found, 1 endpoint gone.");
        expect(res.body.pages).toEqual([{ path: "/", type: "content", title: "Title of /" }, { path: "/about", type: "content", title: "Title of /about" }]);
        const raw = JSON.stringify(res.body);
        for (const pg of first.pages) expect(raw).not.toContain(pg.fp);
        expect(raw).not.toContain('"fp"');
        expect(raw).not.toContain("knowledge_json");
    });

    it("DELETE forgets, repeats harmlessly, and unknown projects are 404", async () => {
        const p = newProject("api-forget");
        saveMemory(db(), { projectId: p, knowledge: first, changes: null });
        const del = await server.inject({ method: "DELETE", url: `/api/projects/${p}/memory` });
        expect(del.statusCode).toBe(200);
        expect(JSON.parse(del.body)).toEqual({ forgotten: true });
        expect((await get(`/api/projects/${p}/memory`)).body.remembered).toBe(false);
        expect(JSON.parse((await server.inject({ method: "DELETE", url: `/api/projects/${p}/memory` })).body)).toEqual({ forgotten: false });
        expect((await get("/api/projects/does-not-exist/memory")).status).toBe(404);
        expect((await server.inject({ method: "DELETE", url: "/api/projects/does-not-exist/memory" })).statusCode).toBe(404);
    });

    it("the useMemory job option defaults to on, is stored when given, and must be a boolean", async () => {
        expect(DEFAULT_JOB_OPTIONS.useMemory).toBe(true);
        const p = newProject("option");
        const bad = await server.inject({ method: "POST", url: `/api/projects/${p}/test-generation`, payload: { url: "http://127.0.0.1:9", useMemory: "no" } });
        expect(bad.statusCode).toBe(400);
        const ok = await server.inject({ method: "POST", url: `/api/projects/${p}/test-generation`, payload: { url: "http://127.0.0.1:9", useMemory: false } });
        expect(ok.statusCode).toBe(202);
        expect(platform.repo.listJobs(p)[0]!.options.useMemory).toBe(false);
    });
});

// ── the per-run session ───────────────────────────────────────────────────────
describe("memory session", () => {
    const events: EngineEvent[] = [];
    const ctx = () => ({ config: loadConfig({}), llm: undefined as never, emit: (e: EngineEvent) => void events.push(e) });
    const prev = distillKnowledge(model({ pages: [page("/"), page("/about")], apis: [api("GET", "/api/old")] }));

    it("is a complete no-op when switched off: nothing is loaded or saved, no context", async () => {
        let touched = 0;
        const s = await openMemory(ctx(), { loadMemory: () => ((touched++), { knowledge: prev }), saveMemory: () => void touched++ }, { origin: "http://shop.test", enabled: false, secrets: [] });
        s.noteCrawl(model());
        s.analysed(model());
        await s.remember([]);
        expect(s.context("understanding")).toBeUndefined();
        expect(touched).toBe(0);
    });

    it("does not save before an analysis succeeded, and reports a storage failure as a warning", async () => {
        events.length = 0;
        let saved = 0;
        const s = await openMemory(ctx(), { loadMemory: () => ({ knowledge: null }), saveMemory: () => void saved++ }, { origin: "http://shop.test", enabled: true, secrets: [] });
        await s.remember([]);
        expect(saved).toBe(0);
        const failing = await openMemory(ctx(), { loadMemory: () => ({ knowledge: null }), saveMemory: () => { throw new Error("disk full"); } }, { origin: "http://shop.test", enabled: true, secrets: [] });
        failing.analysed(model());
        await expect(failing.remember([])).resolves.toBeUndefined();
        expect(events.some((e) => e.kind === "memory_warning" && e.level === "warn" && /disk full/.test(e.message))).toBe(true);
    });

    it("turns a load warning or a throwing store into a warning event and carries on without memory", async () => {
        events.length = 0;
        const warned = await openMemory(ctx(), { loadMemory: () => ({ knowledge: null, warning: "damaged" }) }, { origin: "http://shop.test", enabled: true, secrets: [] });
        expect(warned.context("planning")).toBeUndefined();
        const thrown = await openMemory(ctx(), { loadMemory: () => { throw new Error("boom"); } }, { origin: "http://shop.test", enabled: true, secrets: [] });
        expect(thrown.hasPrevious).toBe(false);
        expect(events.filter((e) => e.kind === "memory_warning")).toHaveLength(2);
    });

    it("computes the change summary and emits it after the analysis", async () => {
        events.length = 0;
        let savedChanges: unknown;
        const s = await openMemory(ctx(), { loadMemory: () => ({ knowledge: prev }), saveMemory: (_k, c) => void (savedChanges = c) }, { origin: "http://shop.test", enabled: true, secrets: [] });
        expect(events.find((e) => e.kind === "memory_used")).toBeTruthy();
        const now = model({ pages: [page("/"), page("/news")], apis: [] });
        s.noteCrawl(now);
        expect(s.context("understanding")).toContain("not found in this crawl: /about");
        s.analysed(now);
        await s.remember([]);
        expect(s.changes!.text).toBe("Since the last analysis: 1 new page, 1 page no longer found, 1 endpoint gone.");
        expect(savedChanges).toEqual(s.changes);
        expect(events.find((e) => e.kind === "memory_changes")!.message).toBe(s.changes!.text);
    });
});
