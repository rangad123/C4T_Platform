/**
 * Sheet #8 stage 5, "What the explorer knows", against a real platform (no worker, no browser): the job's events, its saved model, its
 * tests, its AI usage rows and its page thumbnails are recorded as an exploration records them, and read back through the HTTP API with
 * Crowd4Test sign-ins (a stand-in Crowd4Test API on a local port, as tests/permissions.test.ts does).
 *
 * - GET /api/projects/:id/jobs/:jobId/knowledge: the site map from the recorded model (paths, titles, the tests that start on each page,
 *   the thumbnail while its file is kept), what was reused and why, the reasons reuse was switched off, and the cache figures, which are
 *   left out for a person without ai_studio.usage.view. Another project's job is a 404.
 * - A thumbnail is a screenshot artifact with a .jpg name: a viewer of the project gets it as image/jpeg through GET /api/artifacts/:id,
 *   another project's is a 404. RepoSink keeps only a JPEG within the size cap, under a thumbnail's name, within the run's caps.
 * - "Keep page thumbnails": on when never saved, off once saved off, and a sign-in saved afterwards does not turn it back on; the request a
 *   job is given follows it.
 * - Retention: a thumbnail (a screenshot with no test run) expires as a failed run's screenshots do.
 * - The site map's tree (web/src/features/explore/knowledge.ts siteTree).
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { THUMBNAIL_LIMITS, THUMBNAIL_RUN_LIMITS } from "../src/engine/discovery/thumbnails.js";
import { planPrune } from "../src/engine/retention/rules.js";
import { DEFAULT_POLICY } from "../src/engine/retention/policy.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { buildServer } from "../src/platform/server.js";
import { UsageStore } from "../src/platform/usage-store.js";
import { siteTree, type KnowledgePage } from "../web/src/features/explore/knowledge.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "knowledge-owner-key-5c1d77ab";
const PAGE = { "x-requested-with": "ai-studio" };
const SITE = "http://127.0.0.1:7391";

const accounts = new Map<string, { status: number; body: unknown }>();
let api: http.Server;
let platform: Platform;
let app: App;
let dir: string;
let PA: string;
let PB: string;
let jobA: string;
let jobB: string;
let thumbA: string;
let thumbB: string;
let prunedThumb: string;
let testProducts: string;

/** A small JPEG (its start marker is what the platform checks; the rest is a real 1x1 picture). */
const JPEG = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
);

const c4t = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    status: 200,
    body: { data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } },
});
const as = (token: string, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, type: String(r.headers["content-type"] ?? ""), raw: r.rawPayload, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;

/** Events as crawler.ts, orchestrator.ts and planner.ts record them for a repeat exploration whose reuse a spot check switched off. */
const EVENTS = [
    { stage: "analysis", kind: "memory_used", message: "Using what was learned on 2026-11-10: 3 pages, 1 journey", data: { pages: 3, journeys: 1, endpoints: 0 } },
    { stage: "discovery", kind: "signin_reused", message: "reused: went straight to the sign-in page known since 2026-11-10 (/login); the form was filled and the sign-in checked as usual.", data: { path: "/login", since: "2026-11-10T08:00:00.000Z" } },
    { stage: "discovery", kind: "page_visited", message: "Visited / (home, 0 forms, 4 controls); unchanged since 2026-11-10, so its menus...", data: { url: `${SITE}/`, status: 200, depth: 0, type: "home", reusedFrom: "2026-11-10T08:00:00.000Z" } },
    { stage: "discovery", kind: "page_visited", message: "Visited /products (listing, 0 forms, 1 controls)", data: { url: `${SITE}/products`, status: 200, depth: 1, type: "listing" } },
    { stage: "discovery", kind: "page_visited", message: "Visited /products/7 (detail, 1 forms, 3 controls); unchanged since 2026-11-10, so its menus...", data: { url: `${SITE}/products/7`, status: 200, depth: 2, type: "detail", reusedFrom: "2026-11-10T08:00:00.000Z" } },
    { stage: "discovery", kind: "reuse_off", level: "warn", message: "Reuse of the last exploration is off for the rest of this run: a spot check of /products found it behaves differently from the last exploration (its menus, conditional fields or validation messages changed). Every page is tried again, including the 2 whose results were already taken.", data: { reason: "a spot check of /products found it behaves differently from the last exploration (its menus, conditional fields or validation messages changed)", changed: 0, spotChecked: 1 } },
    { stage: "discovery", kind: "reuse_reprobed", message: "Tried again the 1 page whose earlier results were taken before reuse was switched off.", data: { pages: 1 } },
    { stage: "discovery", kind: "probes_reused", message: "reused: 1 page unchanged since 2026-11-10. ...", data: { pages: 1, since: "2026-11-10T08:00:00.000Z", spotChecked: 1, expired: 0, changed: 0, paths: ["/"] } },
    { stage: "discovery", kind: "pages_from_memory", message: "Started from 2 pages the last exploration knew", data: { pages: 2, gone: 0 } },
    { stage: "analysis", kind: "understanding_reused", message: "2 unchanged pages were not sent to the AI again", data: { pages: 2, of: 3 } },
    { stage: "planning", kind: "requirements_retrieved", message: "4 of 5 requirements reached the planning...", data: { total: 5, inAreas: 4, catchAll: 1, notShown: 0 } },
];

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-knowledge-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "knowledge-test-secret-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${port}`, C4T_SITE_URL: "https://crowd4test.example" }));
    app = await buildServer(platform);
    await app.ready();

    accounts.set("t-admin", c4t("ada", "ADMIN", []));
    // A customer who may only read (no ai_studio.usage.view), and one who may see AI usage too.
    accounts.set("t-viewer", c4t("vic", "CUSTOMER", ["ai_studio.access"], "org-a"));
    accounts.set("t-usage", c4t("ula", "CUSTOMER", PERMISSIONS, "org-a"));

    PA = (await asKey("POST", "/api/projects", { name: "Alpha", organizationId: "org-a", platforms: ["web"], testingModes: ["agent"] })).body.id;
    PB = (await asKey("POST", "/api/projects", { name: "Bravo", organizationId: "org-b", platforms: ["web"], testingModes: ["agent"] })).body.id;
    for (const t of ["t-viewer", "t-usage"]) expect((await as("t-admin", "POST", `/api/projects/${PA}/members`, { personId: await personOf(t) })).status).toBe(201);

    const { repo, store } = platform;
    const appA = repo.createApplication(PA, SITE, {});
    const appB = repo.createApplication(PB, "http://127.0.0.1:7392", {});
    jobA = (await repo.createJob(PA, appA, { ...DEFAULT_JOB_OPTIONS, targets: ["web"] })).id;
    jobB = (await repo.createJob(PB, appB, { ...DEFAULT_JOB_OPTIONS, targets: ["web"] })).id;
    for (const e of EVENTS) repo.addEvent(jobA, e as never);

    // The thumbnails, kept as the crawl keeps them (RepoSink.savePageThumbnail).
    const sinkA = new RepoSink(repo, store, { id: jobA, projectId: PA, applicationId: appA });
    thumbA = (await sinkA.savePageThumbnail("thumb-1.jpg", JPEG))!;
    prunedThumb = (await sinkA.savePageThumbnail("thumb-2.jpg", JPEG))!;
    platform.db.run("UPDATE artifacts SET pruned_at = ?, pruned_reason = 'age-failed' WHERE id = ?", new Date().toISOString(), prunedThumb);
    thumbB = (await new RepoSink(repo, store, { id: jobB, projectId: PB, applicationId: appB }).savePageThumbnail("thumb-1.jpg", JPEG))!;

    // The model the job saved (job-runner.ts: the app-model artifact). /products/7 was tried again after reuse went off: no reusedFrom.
    const model = {
        pages: [
            { url: `${SITE}/`, path: "/", title: "Shop home", type: "home", depth: 0, reusedFrom: { at: "2026-11-10T08:00:00.000Z" }, thumbnail: thumbA },
            { url: `${SITE}/products`, path: "/products", title: "All products", type: "listing", depth: 1, thumbnail: prunedThumb },
            { url: `${SITE}/products/7`, path: "/products/7", title: "Blue kettle", type: "detail", depth: 2, thumbnail: thumbB },
            { url: `${SITE}/help/faq`, path: "/help/faq", title: "Questions", type: "content", depth: 1 },
        ],
    };
    await sinkA.saveTextArtifact("app-model", "application-model.json", JSON.stringify(model));

    // Its tests: one written for an idea that starts on /products, one check of the home page.
    const suite = repo.getOrCreateSuite(PA, "Browsing", "browsing");
    const spec = (testId: string, title: string, url: string) => TestSpecSchema.parse({ testId, title, kind: "web", category: "Browsing", steps: [{ action: "navigate", url }] });
    testProducts = repo.insertTest({ projectId: PA, suiteId: suite, jobId: jobA, spec: spec("WEB-001", "Browse the product list", "/"), framework: "playwright", validationStatus: "VALIDATED", meta: { scenario: { startPath: "/products?sort=new" } } });
    repo.insertTest({ projectId: PA, suiteId: suite, jobId: jobA, spec: spec("WEB-002", "Page health: Home", "/"), framework: "playwright", validationStatus: "VALIDATED" });

    // Its AI usage: 3 calls, 10,000 input tokens of which 6,000 were read from the prompt cache.
    const usage = new UsageStore(platform.db);
    usage.addUsage({ jobId: jobA, projectId: PA, purpose: "planning", model: "claude-haiku-4-5", at: new Date(), calls: 2, failedCalls: 0, inputTokens: 8000, outputTokens: 900, images: 0, estimatedCalls: 0, cacheReadTokens: 6000, cacheWriteTokens: 1500 });
    usage.addUsage({ jobId: jobA, projectId: PA, purpose: "analysis", model: "claude-haiku-4-5", at: new Date(), calls: 1, failedCalls: 0, inputTokens: 2000, outputTokens: 300, images: 0, estimatedCalls: 0 });
}, 60_000);

afterAll(async () => {
    await app?.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

const knowledge = (token: string, project = PA, job = jobA) => as(token, "GET", `/api/projects/${project}/jobs/${job}/knowledge`);

describe("what the explorer knows, from a recorded exploration", () => {
    it("draws the site map from the saved model: paths, titles, the tests that start on each page, and only thumbnails still kept here", async () => {
        const res = await knowledge("t-usage");
        expect(res.status).toBe(200);
        const pages = res.body.siteMap.pages as KnowledgePage[];
        expect(res.body.siteMap.from).toBe("model");
        expect(pages.map((p) => [p.path, p.title])).toEqual([
            ["/", "Shop home"],
            ["/products", "All products"],
            ["/products/7", "Blue kettle"],
            ["/help/faq", "Questions"],
        ]);
        const by = new Map(pages.map((p) => [p.path, p]));
        // The idea's start page decides (its query left out); the check that opens / starts on /.
        expect(by.get("/products")!.tests).toEqual([{ id: testProducts, testKey: "WEB-001", title: "Browse the product list" }]);
        expect(by.get("/")!.tests.map((t) => t.testKey)).toEqual(["WEB-002"]);
        expect(by.get("/help/faq")!.tests).toEqual([]);
        // The kept one is named; an expired file and another project's picture are not.
        expect(by.get("/")!.thumbnail).toBe(thumbA);
        expect(by.get("/products")!.thumbnail).toBeUndefined();
        expect(by.get("/products/7")!.thumbnail).toBeUndefined();
        expect(res.body.thumbnails).toEqual({ keep: true, count: 1 });
    });

    it("says what was reused and why reuse was switched off; a page tried again is not called reused", async () => {
        const { body } = await knowledge("t-usage");
        expect(body.reused.pages).toEqual([{ path: "/", since: "2026-11-10T08:00:00.000Z" }]);
        expect(new Map((body.siteMap.pages as KnowledgePage[]).map((p) => [p.path, p.reusedFrom])).get("/products/7")).toBeUndefined();
        expect(body.reused).toMatchObject({ total: 1, spotChecked: 1, reprobed: 1, signIn: { path: "/login", since: "2026-11-10T08:00:00.000Z" }, pagesFromMemory: { pages: 2, gone: 0 }, understanding: { pages: 2, of: 3 }, requirements: { total: 5, inAreas: 4, catchAll: 1, notShown: 0 } });
        expect(body.reuseOff).toEqual([{ reason: expect.stringMatching(/^a spot check of \/products found it behaves differently/), message: expect.stringContaining("Reuse of the last exploration is off") }]);
    });

    it("shows the cache figures to a person who may see AI usage, and leaves them out for one who may not", async () => {
        const seen = (await knowledge("t-usage")).body;
        expect(seen.cacheSavings).toEqual({ aiCalls: 3, inputTokens: 10_000, cacheReadTokens: 6000, cacheWriteTokens: 1500, cacheReadPercent: 60, aiCallsSaved: 0 });
        const viewer = await knowledge("t-viewer");
        expect(viewer.status).toBe(200);
        expect(viewer.body).not.toHaveProperty("cacheSavings");
        expect(JSON.stringify(viewer.body)).not.toMatch(/cacheRead|cacheWrite|inputTokens|aiCalls|6000|10000/);
        // The rest is the same for both.
        expect(viewer.body.siteMap).toEqual(seen.siteMap);
        expect(viewer.body.reused).toEqual(seen.reused);
    });

    it("answers 404 for another project's job, through either project", async () => {
        expect((await knowledge("t-viewer", PA, jobB)).status).toBe(404);
        expect((await knowledge("t-viewer", PB, jobB)).status).toBe(404);
        expect((await knowledge("t-admin", PA, jobB)).body).toEqual({ error: "Job not found" });
    });
});

describe("thumbnails as job artifacts", () => {
    it("a viewer of the project gets its thumbnail as a JPEG; another project's thumbnail is a 404", async () => {
        const own = await as("t-viewer", "GET", `/api/artifacts/${thumbA}`);
        expect(own.status).toBe(200);
        expect(own.type).toBe("image/jpeg");
        expect(Buffer.from(own.raw).equals(JPEG)).toBe(true);
        expect((await as("t-viewer", "GET", `/api/artifacts/${thumbB}`)).status).toBe(404);
        // An expired one says so.
        expect((await as("t-viewer", "GET", `/api/artifacts/${prunedThumb}`)).status).toBe(410);
    });

    it("keeps only a JPEG within the size cap, under a thumbnail's name, within the run's caps", async () => {
        const { repo, store } = platform;
        const appId = repo.createApplication(PA, SITE, {});
        const job = (await repo.createJob(PA, appId, { ...DEFAULT_JOB_OPTIONS })).id;
        const sink = new RepoSink(repo, store, { id: job, projectId: PA, applicationId: appId });
        expect(await sink.savePageThumbnail("thumb-1.jpg", Buffer.from("not a picture"))).toBeNull();
        expect(await sink.savePageThumbnail("../thumb-1.jpg", JPEG)).toBeNull();
        expect(await sink.savePageThumbnail("thumb-1.png", JPEG)).toBeNull();
        const big = Buffer.concat([JPEG, Buffer.alloc(THUMBNAIL_LIMITS.maxBytes)]);
        expect(await sink.savePageThumbnail("thumb-1.jpg", big)).toBeNull();
        const id = await sink.savePageThumbnail("thumb-1.jpg", JPEG);
        expect(repo.getArtifact(id!)).toMatchObject({ kind: "screenshot", job_id: job, execution_id: null, size: JPEG.length });
        // The same name twice is kept once.
        expect(await sink.savePageThumbnail("thumb-1.jpg", JPEG)).toBeNull();
        // The run's byte cap, counted from what the job stored (as a runner's pictures arrive over many requests).
        const near = Buffer.concat([JPEG, Buffer.alloc(THUMBNAIL_LIMITS.maxBytes - JPEG.length - 10)]);
        let kept = 1;
        for (let i = 2; i < 400 && (await sink.savePageThumbnail(`thumb-${i}.jpg`, near)); i++) kept++;
        expect(kept).toBeLessThanOrEqual(THUMBNAIL_RUN_LIMITS.count);
        const total = platform.db.get<{ b: number }>("SELECT SUM(size) AS b FROM artifacts WHERE job_id = ?", job)!.b;
        expect(total).toBeLessThanOrEqual(THUMBNAIL_RUN_LIMITS.bytes);
        expect(total).toBeGreaterThan(THUMBNAIL_RUN_LIMITS.bytes - THUMBNAIL_LIMITS.maxBytes);
        // A new sink for the same job (a platform restart, another request) still counts what was stored.
        expect(await new RepoSink(repo, store, { id: job, projectId: PA, applicationId: appId }).savePageThumbnail("thumb-999.jpg", near)).toBeNull();
    });

    it("expire as a failed run's screenshots do (they belong to no test run)", () => {
        const day = 86_400_000;
        const now = Date.parse("2026-11-20T00:00:00Z");
        const plan = planPrune({
            now,
            policy: { ...DEFAULT_POLICY, keepFailedDays: 7 },
            executions: [],
            artifacts: [
                { id: "old-thumb", kind: "screenshot", size: 30_000, executionId: null, at: now - 8 * day, createdAt: now - 8 * day },
                { id: "new-thumb", kind: "screenshot", size: 30_000, executionId: null, at: now - 2 * day, createdAt: now - 2 * day },
                { id: "model", kind: "app-model", size: 9_000, executionId: null, at: now - 30 * day, createdAt: now - 30 * day },
            ],
        });
        expect(plan.prune.map((p) => [p.id, p.reason])).toEqual([["old-thumb", "age-failed"]]);
        expect(plan.protectedFiles["no-run"]).toBe(1);
    });
});

describe('"Keep page thumbnails"', () => {
    it("is on when never saved, off once saved off, and a sign-in saved later leaves it off", async () => {
        expect((await asKey("GET", `/api/projects/${PB}/agent-inputs`)).body.keepThumbnails).toBe(true);
        const off = await asKey("PUT", `/api/projects/${PB}/agent-inputs`, { keepThumbnails: false });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body.keepThumbnails).toBe(false);
        expect((await asKey("PUT", `/api/projects/${PB}/sign-in`, { username: "ann", password: "pw-123456" })).status).toBe(200);
        expect((await asKey("GET", `/api/projects/${PB}/agent-inputs`)).body.keepThumbnails).toBe(false);
        // Saving something else on the same card keeps it too.
        expect((await asKey("PUT", `/api/projects/${PB}/agent-inputs`, { allowMutatingApiTests: true })).body.keepThumbnails).toBe(false);
        expect((await knowledge("t-admin", PB, jobB)).body.thumbnails.keep).toBe(false);
        expect((await asKey("PUT", `/api/projects/${PB}/agent-inputs`, { keepThumbnails: "yes" })).body.error).toBe("Keep page thumbnails is on or off (true or false).");
        expect((await asKey("PUT", `/api/projects/${PB}/agent-inputs`, { keepThumbnails: true })).body.keepThumbnails).toBe(true);
    });

    it("may be changed only by someone who may change the project's settings", async () => {
        const res = await as("t-viewer", "PUT", `/api/projects/${PA}/agent-inputs`, { keepThumbnails: false });
        expect(res.status).toBe(403);
        expect((await asKey("GET", `/api/projects/${PA}/agent-inputs`)).body.keepThumbnails).toBe(true);
    });
});

describe("the site map's tree", () => {
    const page = (p: string): KnowledgePage => ({ path: p, title: p, type: "other", depth: 0, tests: [] });
    it("nests pages under the page of their parent address, groups under an address with no page, and lifts a group of one", () => {
        const tree = siteTree([page("/products/7"), page("/"), page("/products"), page("/help/faq"), page("/help/contact"), page("/a/b/c")]);
        const show = (ns: ReturnType<typeof siteTree>): unknown => ns.map((n) => (n.children.length ? { [`${n.path}${n.page ? "" : " (group)"}`]: show(n.children) } : `${n.path}${n.page ? "" : " (group)"}`));
        expect(show(tree)).toEqual(["/", "/a/b/c", { "/help (group)": ["/help/contact", "/help/faq"] }, { "/products": ["/products/7"] }]);
    });
});
