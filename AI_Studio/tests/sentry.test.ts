/**
 * Sentry context for failed tests: ranking (pure), then the whole path over real HTTP against a local receiver shaped like
 * Sentry's project issues API (extra fields that must be dropped, 401/403/404/429/500, a slow answer, a wrong shape).
 * Also: Sentry is never an issue tracker. No browser and no LLM; nothing leaves this machine.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { SecretBox } from "../src/platform/secrets.js";
import { SentrySettings } from "../src/platform/sentry/client.js";
import { MAX_SHOWN, WEIGHTS, normalizePath, parseIssues, pathMatch, rankRelated, searchWindow, sentryTime, uniquePaths, type Candidate } from "../src/platform/sentry/match.js";
import { RelatedCache, CACHE_TTL_MS, relatedCache, relatedErrors } from "../src/platform/sentry/related.js";
import { SentryStore } from "../src/platform/sentry/store.js";
import { buildServer } from "../src/platform/server.js";

const SENTRY_PORT = 5732;
const GITHUB_PORT = 5733;
const SENTRY = `http://127.0.0.1:${SENTRY_PORT}`;
const GH = `http://127.0.0.1:${GITHUB_PORT}`;
const TOKEN = "sntrys_SentinelSentryToken0123456789abcdef";
const GH_TOKEN = "ghp_validTokenForSentryTests1234567890";
/** Things Sentry sends that must never reach an answer of ours. */
const FORBIDDEN = ["STACKTRACE-SENTINEL", "person@private.example", "BREADCRUMB-SENTINEL", "TAG-SENTINEL", "SECRET-VALUE-SENTINEL"];

// ── ranking, without a server ───────────────────────────────────────────────────

const T0 = new Date("2026-03-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const win = searchWindow(T0.toISOString(), 60_000);
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, title: `Issue ${id}`, level: "warning", count: 0, firstSeen: at(-3_600_000), lastSeen: at(10_000), ...over });
const rank = (cs: Candidate[], paths: string[] = [], max?: number) => rankRelated(cs, { window: win, paths: uniquePaths(paths), link: (c) => `https://s.example/${c.id}`, max });

describe("the time window", () => {
    it("is the run plus two minutes on each side", () => {
        expect(win.run.start.toISOString()).toBe("2026-03-01T10:00:00.000Z");
        expect(win.run.end.toISOString()).toBe("2026-03-01T10:01:00.000Z");
        expect(win.start.toISOString()).toBe("2026-03-01T09:58:00.000Z");
        expect(win.end.toISOString()).toBe("2026-03-01T10:03:00.000Z");
        // an unknown duration counts as an instant
        expect(searchWindow(T0.toISOString(), null).end.toISOString()).toBe("2026-03-01T10:02:00.000Z");
    });
    it("is written for Sentry in UTC to the second", () => {
        expect(sentryTime(win.start)).toBe("2026-03-01T09:58:00");
        expect(sentryTime(new Date("2026-03-01T10:03:00.987Z"))).toBe("2026-03-01T10:03:00");
    });
    it("leaves out issues that were not around while the run happened", () => {
        const out = rank([
            cand("in"),
            cand("ended-before", { lastSeen: at(-130_000) }), // last seen 10 s before the window opens
            cand("starts-after", { firstSeen: at(3 * 60_000 + 1000), lastSeen: at(4 * 60_000) }),
            cand("edge-start", { lastSeen: at(-120_000) }),
            cand("edge-end", { firstSeen: at(3 * 60_000), lastSeen: at(3 * 60_000) }),
            cand("no-times", { firstSeen: undefined, lastSeen: undefined }),
        ]);
        expect(out.map((i) => i.id).sort()).toEqual(["edge-end", "edge-start", "in"]);
    });
});

describe("matching a failed request to an issue", () => {
    it.each([
        ["/api/cart", "/api/cart"],
        ["GET /Api/Cart/", "/api/cart"],
        ["POST https://shop.example/api/cart?x=1#top", "/api/cart"],
        ["/api//cart", "/api/cart"],
        ["/", "/"],
        ["/api/caf%C3%A9", "/api/café"],
    ])("normalises %s", (raw, expected) => expect(normalizePath(raw)).toBe(expected));

    const m = (title: string, culprit?: string, paths = ["/api/cart"]) => pathMatch({ title, culprit }, uniquePaths(paths))?.kind;
    it("equal: the location is the failed path", () => {
        expect(m("Boom", "/api/cart")).toBe("equal");
        expect(m("Boom", "GET /api/cart")).toBe("equal");
        expect(m("Boom", "get /API/cart/?id=3")).toBe("equal");
    });
    it("mention: the title or location names the path as a whole path", () => {
        expect(m("HTTP 500 at /api/cart")).toBe("mention");
        expect(m("Failed: GET /api/cart.")).toBe("mention");
        expect(m("Boom", "handler for /api/cart (v1)")).toBe("mention");
        expect(m("HTTP 500 at /API/CART")).toBe("mention");
    });
    it.each(["HTTP 500 at /v2/api/cart", "/api/cart-items failed", "/api/cart/42 failed", "/api/carts", "no path here", "/api"])("does not match %j", (title) => {
        expect(m(title)).toBeUndefined();
    });
    it("ignores the root and very short paths in text", () => {
        expect(m("Error at / of the site", undefined, ["/"])).toBeUndefined();
        expect(m("Error at /a", undefined, ["/a"])).toBeUndefined();
        expect(m("Boom", "/", ["/"])).toBe("equal");
    });
    it("keeps a list of distinct, normalised paths", () => {
        expect(uniquePaths(["/api/cart?a=1", "GET /api/cart/", "https://x.test/api/cart", "not a path", "/b"])).toEqual(["/api/cart", "/b"]);
    });
});

describe("ranking", () => {
    const p = ["/api/cart"];
    it("pins the weights", () => {
        expect(WEIGHTS).toEqual({ pathEqual: 100, pathMention: 60, newInWindow: 40, errorLevel: 10, countMax: 8 });
    });
    it("orders by evidence: equal path, mention, new in the window, error level, event count", () => {
        const out = rank(
            [
                cand("count", { count: 100_000 }), // 8
                cand("level", { level: "fatal" }), // 10
                cand("new", { firstSeen: at(5000) }), // 40
                cand("mention", { title: "Failed at /api/cart" }), // 60
                cand("equal", { culprit: "GET /api/cart" }), // 100
            ],
            p,
        );
        expect(out.map((i) => i.id)).toEqual(["equal", "mention", "new", "level", "count"]);
    });
    it("adds the evidence up", () => {
        // equal (100) + new (40) + error (10) + log10(41)*2 = 3  =>  beats a mention (60) with a huge count and error level (60 + 10 + 8)
        const out = rank([cand("big", { title: "At /api/cart", level: "error", count: 10_000_000 }), cand("both", { culprit: "/api/cart", firstSeen: at(1000), level: "error", count: 40 })], p);
        expect(out.map((i) => i.id)).toEqual(["both", "big"]);
    });
    it("caps the count at 8 points however large it is", () => {
        const same = rank([cand("b", { count: 10_000_000_000 }), cand("a", { count: 10_000 })]);
        expect(same.map((i) => i.id)).toEqual(["a", "b"]); // equal scores, equal last seen: by id
    });
    it("breaks ties by last seen, newest first, then by id", () => {
        const out = rank([cand("b", { lastSeen: at(5000) }), cand("a", { lastSeen: at(5000) }), cand("c", { lastSeen: at(20_000) })]);
        expect(out.map((i) => i.id)).toEqual(["c", "a", "b"]);
    });
    it("returns at most five", () => {
        const many = Array.from({ length: 12 }, (_, i) => cand(String(i + 1), { count: i }));
        expect(rank(many)).toHaveLength(MAX_SHOWN);
        expect(MAX_SHOWN).toBe(5);
    });
    it("is deterministic: the same input in any order gives the same answer", () => {
        const list = [cand("1", { count: 5 }), cand("2", { level: "error" }), cand("3", { title: "x /api/cart" }), cand("4", { culprit: "/api/cart" })];
        const first = rank(list, p).map((i) => i.id);
        expect(rank([...list].reverse(), p).map((i) => i.id)).toEqual(first);
    });
});

describe("the reason in plain words, never a cause", () => {
    const reason = (c: Candidate, paths: string[] = []) => rank([c], paths)[0]!.reason;
    it("says when it was first seen, relative to the failed run", () => {
        expect(reason(cand("1", { firstSeen: at(40_000) }))).toBe("First seen 40 seconds into the failed run.");
        expect(reason(cand("1", { firstSeen: at(1000) }))).toBe("First seen 1 second into the failed run.");
        expect(reason(cand("1", { firstSeen: at(-30_000) }))).toBe("First seen 30 seconds before the failed run started.");
        expect(reason(cand("1", { firstSeen: at(60_000 + 100_000), lastSeen: at(170_000) }))).toBe("First seen 2 minutes after the failed run ended.");
    });
    it("names the path that matched", () => {
        expect(reason(cand("1", { firstSeen: at(40_000), culprit: "GET /api/cart" }), ["/api/cart"])).toBe("First seen 40 seconds into the failed run and is reported at /api/cart, which failed in this run.");
        expect(reason(cand("1", { title: "500 from /api/cart" }), ["/api/cart"])).toBe("Was active while the test ran and mentions /api/cart, which failed in this run.");
    });
    it("falls back to the plain fact that it was around", () => {
        expect(reason(cand("1"))).toBe("Was active while the test ran.");
    });
    it("never uses the words of a cause", () => {
        const all = rank([cand("1", { firstSeen: at(40_000), culprit: "/api/cart", level: "fatal" }), cand("2", { title: "x /api/cart" }), cand("3")], ["/api/cart"]).map((i) => i.reason).join(" ");
        expect(all).not.toMatch(/caus|because|root|due to|responsible|led to/i);
    });
});

describe("reading Sentry's answer", () => {
    const raw = {
        id: "101",
        title: "TypeError: cart is undefined",
        culprit: "GET /api/cart",
        level: "error",
        count: "40",
        firstSeen: "2026-03-01T10:00:40Z",
        lastSeen: "2026-03-01T10:00:50Z",
        permalink: "https://acme.sentry.io/issues/101/",
        // none of this may survive
        metadata: { value: "SECRET-VALUE-SENTINEL", filename: "/srv/app.js" },
        tags: [{ key: "x", value: "TAG-SENTINEL" }],
        user: { email: "person@private.example" },
        stacktrace: "STACKTRACE-SENTINEL",
        annotations: ["BREADCRUMB-SENTINEL"],
    };
    it("keeps the few fields it needs and nothing else", () => {
        const [c] = parseIssues([raw])!;
        expect(Object.keys(c!).sort()).toEqual(["count", "culprit", "firstSeen", "id", "lastSeen", "level", "permalink", "title"]);
        expect(JSON.stringify(c)).not.toMatch(new RegExp(FORBIDDEN.join("|")));
    });
    it("skips entries that are not issues and rejects an answer that is not a list", () => {
        expect(parseIssues([null, 3, "x", { title: "no id" }, { id: "abc", title: "bad id" }, { id: 7, title: "" }, raw])!.map((c) => c.id)).toEqual(["101"]);
        expect(parseIssues({ detail: "nope" })).toBeUndefined();
        expect(parseIssues(undefined)).toBeUndefined();
    });
    it("tolerates odd values: unknown levels, bad numbers, bad dates, control characters", () => {
        const [c] = parseIssues([{ id: 5, title: "a\u0000b\nc", level: "weird", count: "many", firstSeen: "yesterday", lastSeen: 12 }])!;
        expect(c).toMatchObject({ id: "5", title: "a b c", level: "unknown", count: 0 });
        expect(c!.firstSeen).toBeUndefined();
        expect(c!.lastSeen).toBeUndefined();
    });
    it("clips a very long title", () => {
        expect(parseIssues([{ ...raw, title: "t".repeat(5000) }])![0]!.title).toHaveLength(300);
    });
});

describe("the cache", () => {
    it("keeps an answer for ten minutes and then forgets it", () => {
        let now = 1_000_000;
        const cache = new RelatedCache(() => now);
        const value = { connected: true as const, state: "ok" as const, issues: [], note: "n", checkedAt: "x", cached: false, window: { start: "a", end: "b" } };
        cache.set("t:e", "p1", value);
        expect(cache.get("t:e")).toBe(value);
        now += CACHE_TTL_MS;
        expect(cache.get("t:e")).toBe(value);
        now += 1;
        expect(cache.get("t:e")).toBeUndefined();
        expect(CACHE_TTL_MS).toBe(600_000);
    });
    it("is cleared per project when a connection changes", () => {
        const cache = new RelatedCache();
        const value = { connected: true as const, state: "ok" as const, issues: [], note: "n", checkedAt: "x", cached: false, window: { start: "a", end: "b" } };
        cache.set("a", "p1", value);
        cache.set("b", "p2", value);
        cache.clearProject("p1");
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe(value);
    });
});

describe("the settings a user enters", () => {
    it("default to sentry.io, trim a trailing slash and accept self-hosted addresses", () => {
        expect(SentrySettings.parse({ organization: "acme", project: "shop", token: "t" }).baseUrl).toBe("https://sentry.io");
        expect(SentrySettings.parse({ baseUrl: "https://sentry.corp.example/", organization: "acme", project: "shop", token: "t" }).baseUrl).toBe("https://sentry.corp.example");
    });
    it("refuse names that are not short names", () => {
        for (const bad of [{ organization: "acme corp" }, { project: "../x" }, { organization: "" }, { token: "" }, { baseUrl: "not a url" }]) {
            expect(SentrySettings.safeParse({ organization: "acme", project: "shop", token: "t", ...bad }).success).toBe(false);
        }
    });
});

// ── with a platform and a receiver shaped like Sentry ──────────────────────────

interface Recorded {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
}
const sentryCalls: Recorded[] = [];
const ghBodies: any[] = [];
let issueList: unknown[] = [];
const servers: http.Server[] = [];
/** Per project slug: how the receiver behaves. */
const behaviour: Record<string, { status?: number; delayMs?: number; body?: unknown; headers?: Record<string, string> }> = {};

let runStart = new Date();
const iso = (ms: number) => new Date(runStart.getTime() + ms).toISOString();
const issuesFor = (): unknown[] => [
    // the one that matches the failed request and appeared during the run
    { id: "101", shortId: "SHOP-1", title: "TypeError: cart is undefined", culprit: "GET /api/cart", level: "error", count: "40", userCount: 12, firstSeen: iso(40_000), lastSeen: iso(50_000), permalink: "https://acme.sentry.example/issues/101/", status: "unresolved", metadata: { value: "SECRET-VALUE-SENTINEL" }, tags: [{ key: "k", value: "TAG-SENTINEL" }], user: { email: "person@private.example" }, stacktrace: "STACKTRACE-SENTINEL", annotations: ["BREADCRUMB-SENTINEL"] },
    // old issue that is still going on and mentions the path
    { id: "103", title: "Cannot read properties of null in /api/cart handler", culprit: "cartHandler", level: "error", count: 500, firstSeen: iso(-86_400_000), lastSeen: iso(10_000), permalink: "javascript:alert(1)" },
    // active but unrelated
    { id: "102", title: "Slow query", culprit: "db.query", level: "warning", count: "3", firstSeen: iso(-3_600_000), lastSeen: iso(5000), permalink: "https://acme.sentry.example/issues/102/" },
    // not around during the run
    { id: "104", title: "Old and quiet", culprit: "x", level: "error", count: "9", firstSeen: iso(-7_200_000), lastSeen: iso(-3_600_000) },
    { id: "105", title: "Appeared much later", culprit: "y", level: "error", count: "9", firstSeen: iso(3_600_000), lastSeen: iso(3_700_000) },
    // junk
    { id: "not-a-number", title: "bad id" },
    null,
];

function sentryHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    sentryCalls.push({ method: req.method!, url: req.url!, headers: req.headers });
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
    };
    if (req.method !== "GET") return send(405, { detail: "Method not allowed" });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "Invalid token" });
    const m = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/(issues\/)?(?:\?.*)?$/.exec(req.url!);
    if (!m || m[1] !== "acme") return send(404, { detail: "The requested resource does not exist" });
    const project = m[2]!;
    const b = behaviour[project];
    const reply = () => {
        if (b?.status) return send(b.status, b.body ?? { detail: "problem" }, b.headers);
        if (project !== "shop" && !b) return send(404, { detail: "The requested resource does not exist" });
        if (!m[3]) return send(200, { slug: project, name: "Shop (web)", organization: { slug: "acme" } });
        return send(200, b?.body ?? issueList);
    };
    if (b?.delayMs) setTimeout(reply, b.delayMs);
    else reply();
}

function githubHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
        const send = (code: number, obj: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
        if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
        if (req.method === "GET") return send(200, { full_name: "acme/shop", has_issues: true });
        const body = JSON.parse(raw);
        ghBodies.push(body);
        send(201, { number: ghBodies.length, html_url: `https://github.example/acme/shop/issues/${ghBodies.length}` });
    });
}

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
let store: SentryStore;

const spec = (testId: string, title: string, kind: "api" | "web" = "api"): TestSpec =>
    TestSpecSchema.parse(
        kind === "api"
            ? { testId, title, kind: "api", category: "Checkout", priority: "high", steps: [{ action: "request", method: "GET", path: "/api/cart" }, { action: "assertResponse", check: "statusBelow", expected: 500 }] }
            : { testId, title, kind: "web", category: "Checkout", priority: "high", steps: [{ action: "navigate", url: "/orders" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading" } }] },
    );

/** A failed test whose run started at `runStart` and lasted a minute. */
function seed(testSpec: TestSpec, reason: string, status: "NEEDS_REVIEW" | "FAILED_VALIDATION" | "VALIDATED" = "NEEDS_REVIEW", project = projectId): { testId: string; executionId: string } {
    const { repo } = platform;
    const id = repo.insertTest({ projectId: project, suiteId: repo.getOrCreateSuite(project, testSpec.category, "checkout"), jobId: null, spec: testSpec, framework: testSpec.kind === "api" ? "playwright-api" : "playwright", validationStatus: status });
    repo.updateTest(id, { reason, validationStatus: status });
    const executionId = repo.addExecution({
        testId: id,
        scriptId: null,
        jobId: null,
        attempt: 1,
        status: status === "VALIDATED" ? "passed" : "failed",
        durationMs: 60_000,
        startedAt: runStart.toISOString(),
        steps: [
            { index: 0, title: "step 1", status: "passed" },
            { index: 1, title: "step 2", status: status === "VALIDATED" ? "passed" : "failed", error: "boom" },
        ],
    });
    return { testId: id, executionId };
}

beforeAll(async () => {
    for (const [port, handler] of [[SENTRY_PORT, sentryHandler], [GITHUB_PORT, githubHandler]] as const) {
        const s = http.createServer(handler);
        servers.push(s);
        await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
    }
    runStart = new Date(Date.now() - 5 * 60_000);
    issueList = issuesFor();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sentry-"));
    process.env.PUBLIC_URL = "https://platform.example.test";
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir }));
    app = await buildServer(platform);
    store = new SentryStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY));
    projectId = platform.repo.createProject({ name: "Sentry demo" }).id as string;
    platform.repo.createApplication(projectId, "https://shop.example.test", {});
}, 30_000);

afterAll(async () => {
    delete process.env.PUBLIC_URL;
    delete process.env.BLOCK_PRIVATE_TARGETS;
    await app?.close();
    platform?.db.close();
    for (const s of servers) s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, text: res.body };
};
const connectSentry = (over: Record<string, unknown> = {}) => call("PUT", `/api/projects/${projectId}/sentry`, { baseUrl: SENTRY, organization: "acme", project: "shop", token: TOKEN, ...over });
const requestsToIssues = () => sentryCalls.filter((c) => c.url.includes("/issues/")).length;

describe("before Sentry is connected", () => {
    it("says so, and the test page has nothing to show", async () => {
        expect((await call("GET", `/api/projects/${projectId}/sentry`)).body).toEqual({ connected: false });
        const t = seed(spec("API-000", "Early"), "Server error: GET /api/cart returned 503");
        expect((await call("GET", `/api/tests/${t.testId}/sentry`)).body).toEqual({ connected: false });
        expect(sentryCalls).toHaveLength(0);
    });
    it("404 for a test or project that does not exist", async () => {
        expect((await call("GET", "/api/tests/nope/sentry")).status).toBe(404);
        expect((await call("GET", "/api/projects/nope/sentry")).status).toBe(404);
        expect((await call("PUT", "/api/projects/nope/sentry", { organization: "a", project: "b", token: "t" })).status).toBe(404);
    });
});

describe("connecting Sentry", () => {
    it("needs a token the first time", async () => {
        const res = await call("PUT", `/api/projects/${projectId}/sentry`, { baseUrl: SENTRY, organization: "acme", project: "shop" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/token/i);
    });

    it("checks the project with a real read-only call, saves it and never returns the token", async () => {
        const before = sentryCalls.length;
        const res = await connectSentry();
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ connected: true, connection: { projectId, baseUrl: SENTRY, organization: "acme", project: "shop", name: "Sentry acme/shop" } });
        expect(res.text).not.toContain(TOKEN);
        const sent = sentryCalls.slice(before);
        expect(sent.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/0/projects/acme/shop/"]);
        expect(sent[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const get = await call("GET", `/api/projects/${projectId}/sentry`);
        expect(get.body).toMatchObject({ connected: true, connection: { organization: "acme", project: "shop" } });
        expect(get.text).not.toContain(TOKEN);
    });

    it("stores the token encrypted: not in the table, not in the database files", () => {
        const row = platform.db.get<{ secret_enc: string; config_json: string; kind: string }>("SELECT * FROM integrations WHERE project_id = ? AND kind = 'sentry'", projectId)!;
        expect(row.secret_enc + row.config_json).not.toContain(TOKEN);
        expect(row.secret_enc.split(".")).toHaveLength(3);
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        for (const f of fs.readdirSync(dataDir).filter((n) => n.startsWith("platform.db"))) expect(fs.readFileSync(path.join(dataDir, f)).includes(TOKEN)).toBe(false);
    });

    it("explains each way it can go wrong in plain words and saves nothing new", async () => {
        const bad = await connectSentry({ token: "sntrys_wrong" });
        expect(bad.status).toBe(502);
        expect(bad.body.error).toBe("Sentry didn’t accept the token. Connect Sentry again with a new token.");
        expect(bad.body.details).toMatchObject({ code: "unauthorized", upstreamStatus: 401 });
        expect(bad.text).not.toContain("sntrys_wrong");
        const org = await connectSentry({ organization: "nobody" });
        expect(org.body.details.code).toBe("not_found");
        expect(org.body.error).toMatch(/can’t find that organisation or project/);
        const project = await connectSentry({ project: "nothing" });
        expect(project.body.details.code).toBe("not_found");
        const unreachable = await connectSentry({ baseUrl: "http://127.0.0.1:5739" });
        expect(unreachable.status).toBe(502);
        expect(unreachable.body.details.code).toBe("unreachable");
        expect((await call("GET", `/api/projects/${projectId}/sentry`)).body.connection).toMatchObject({ project: "shop", baseUrl: SENTRY });
    });

    it("validates input", async () => {
        for (const bad of [{ organization: "a b" }, { project: "" }, { token: "" }, { baseUrl: "ftp://x" }]) {
            expect((await connectSentry(bad)).status).toBe(400);
        }
    });

    it("tests the saved connection with a real call and reports a bad answer as an answer", async () => {
        const ok = await call("POST", `/api/projects/${projectId}/sentry/test`);
        expect(ok.body).toEqual({ ok: true, message: "Connected to the Sentry project Shop (web)." });
        behaviour.shop = { status: 401, body: { detail: "Invalid token" } };
        const bad = await call("POST", `/api/projects/${projectId}/sentry/test`);
        delete behaviour.shop;
        expect(bad.status).toBe(200);
        expect(bad.body).toMatchObject({ ok: false, code: "unauthorized" });
        expect((await call("POST", `/api/projects/${platform.repo.createProject({ name: "Empty" }).id}/sentry/test`)).status).toBe(404);
    });

    it("can be changed without entering the token again (the stored one is checked and kept)", async () => {
        const res = await call("PUT", `/api/projects/${projectId}/sentry`, { baseUrl: SENTRY, organization: "acme", project: "shop" });
        expect(res.status).toBe(200);
        expect(res.body.connection.project).toBe("shop");
        expect((await call("POST", `/api/projects/${projectId}/sentry/test`)).body.ok).toBe(true);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM integrations WHERE kind = 'sentry' AND project_id = ?", projectId)!.n).toBe(1);
    });

    it("is refused for a private address when BLOCK_PRIVATE_TARGETS is on, without sending anything", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const hits = sentryCalls.length;
            const res = await connectSentry();
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/private|loopback/i);
            expect((await connectSentry({ baseUrl: "http://169.254.169.254" })).status).toBe(400);
            // an already saved connection is refused on use, too
            const test = await call("POST", `/api/projects/${projectId}/sentry/test`);
            expect(test.body).toMatchObject({ ok: false, code: "blocked" });
            const t = seed(spec("API-050", "Guarded"), "Server error: GET /api/cart returned 503");
            const related = await call("GET", `/api/tests/${t.testId}/sentry`);
            expect(related.status).toBe(200);
            expect(related.body).toMatchObject({ connected: true, state: "unavailable", code: "blocked" });
            expect(sentryCalls.length).toBe(hits);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("never follows a redirect (the token would travel with it)", async () => {
        const redirect = http.createServer((_req, res) => (res.writeHead(302, { location: `${SENTRY}/api/0/projects/acme/shop/` }), res.end()));
        await new Promise<void>((r) => redirect.listen(5734, "127.0.0.1", r));
        const before = sentryCalls.length;
        const res = await connectSentry({ baseUrl: "http://127.0.0.1:5734" });
        redirect.close();
        expect(res.status).toBe(502);
        expect(res.body.details.code).toBe("rejected");
        expect(sentryCalls.length).toBe(before);
    });
});

describe("Sentry is never an issue tracker", () => {
    let sentryId = "";
    let ghId = "";
    beforeAll(async () => {
        sentryId = store.get(projectId)!.id;
        ghId = (await call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH })).body.id;
    });

    it("is not in the list of trackers", async () => {
        const list = await call("GET", `/api/projects/${projectId}/integrations`);
        expect(list.body.map((i: { kind: string }) => i.kind)).toEqual(["github"]);
        expect(list.text).not.toContain(sentryId);
        expect(list.text).not.toMatch(/sentry/i);
    });
    it("cannot be connected as a tracker", async () => {
        const res = await call("POST", `/api/projects/${projectId}/integrations`, { kind: "sentry", baseUrl: SENTRY, organization: "acme", project: "shop", token: TOKEN });
        expect(res.status).toBe(400);
    });
    it("cannot be changed, tested or removed through the tracker routes", async () => {
        expect((await call("PATCH", `/api/integrations/${sentryId}`, { name: "x" })).status).toBe(404);
        expect((await call("POST", `/api/integrations/${sentryId}/test`)).status).toBe(404);
        expect((await call("DELETE", `/api/integrations/${sentryId}`)).status).toBe(404);
        expect(store.get(projectId)).toBeDefined();
    });
    it("cannot be used to create an issue, and nothing is sent", async () => {
        const t = seed(spec("API-060", "No issue in Sentry"), "Server error: GET /api/cart returned 503");
        const hits = sentryCalls.length;
        const res = await call("POST", `/api/tests/${t.testId}/issue`, { integrationId: sentryId });
        expect(res.status).toBe(404);
        expect(sentryCalls.length).toBe(hits);
        expect((await call("GET", `/api/tests/${t.testId}/issues`)).body).toEqual([]);
        // a real tracker still works next to it
        expect((await call("POST", `/api/tests/${t.testId}/issue`, { integrationId: ghId })).status).toBe(201);
    });
});

describe("related errors for a failed test", () => {
    let t = { testId: "", executionId: "" };
    beforeAll(() => {
        relatedCache.clear();
        t = seed(spec("API-001", "Cart loads for a signed-in shopper"), "Server error: GET /api/cart returned 503 (step \"Verify response\").");
    });

    it("asks Sentry once for issues around the run and ranks what comes back", async () => {
        const before = sentryCalls.length;
        const res = await call("GET", `/api/tests/${t.testId}/sentry`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ connected: true, state: "ok", cached: false });

        const sent = sentryCalls.slice(before);
        expect(sent).toHaveLength(1);
        const url = new URL(sent[0]!.url, SENTRY);
        expect(sent[0]!.method).toBe("GET");
        expect(url.pathname).toBe("/api/0/projects/acme/shop/issues/");
        const w = searchWindow(runStart.toISOString(), 60_000);
        expect(url.searchParams.get("start")).toBe(sentryTime(w.start));
        expect(url.searchParams.get("end")).toBe(sentryTime(w.end));
        expect(url.searchParams.get("limit")).toBe("25");
        expect(url.searchParams.has("statsPeriod")).toBe(false);
        expect(sent[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(sent[0]!.url).not.toContain(TOKEN);

        expect(res.body.issues.map((i: { id: string }) => i.id)).toEqual(["101", "103", "102"]);
        expect(res.body.window).toEqual({ start: w.start.toISOString(), end: w.end.toISOString() });
    });

    it("returns title, level, count, times, link and the reason, and nothing else", async () => {
        const res = await call("GET", `/api/tests/${t.testId}/sentry`);
        const [first, second, third] = res.body.issues;
        expect(first).toEqual({
            id: "101",
            title: "TypeError: cart is undefined",
            level: "error",
            count: 40,
            firstSeen: new Date(runStart.getTime() + 40_000).toISOString(),
            lastSeen: new Date(runStart.getTime() + 50_000).toISOString(),
            url: "https://acme.sentry.example/issues/101/",
            reason: "First seen 40 seconds into the failed run and is reported at /api/cart, which failed in this run.",
        });
        expect(second.reason).toBe("Was active while the test ran and mentions /api/cart, which failed in this run.");
        expect(third.reason).toBe("Was active while the test ran.");
    });

    it("drops every field it does not need: no stack traces, users, tags, breadcrumbs or event data in the answer", async () => {
        const res = await call("GET", `/api/tests/${t.testId}/sentry`);
        for (const secret of FORBIDDEN) expect(res.text).not.toContain(secret);
        for (const key of ["metadata", "tags", "user", "stacktrace", "annotations", "culprit", "shortId", "userCount", "status"]) expect(res.text).not.toContain(`"${key}"`);
        for (const i of res.body.issues) expect(Object.keys(i).sort()).toEqual(["count", "firstSeen", "id", "lastSeen", "level", "reason", "title", "url"]);
    });

    it("opens an issue only on a web address: a hostile link is replaced by one built from the connection", async () => {
        const res = await call("GET", `/api/tests/${t.testId}/sentry`);
        const hostile = res.body.issues.find((i: { id: string }) => i.id === "103");
        expect(hostile.url).toBe(`${SENTRY}/organizations/acme/issues/103/`);
        for (const i of res.body.issues) expect(i.url).toMatch(/^https?:\/\//);
    });

    it("never claims a cause", async () => {
        const res = await call("GET", `/api/tests/${t.testId}/sentry`);
        expect(res.body.note).toMatch(/might be related/);
        expect(res.body.note).toMatch(/cannot tell us that one of them caused it/);
        const words = res.body.issues.map((i: { reason: string }) => i.reason).join(" ");
        expect(words).not.toMatch(/caus|because|root|due to|responsible|led to/i);
    });

    it("answers from memory for ten minutes (one request per page view at most) and again on request", async () => {
        const before = requestsToIssues();
        const a = await call("GET", `/api/tests/${t.testId}/sentry`);
        const b = await call("GET", `/api/tests/${t.testId}/sentry`);
        expect(a.body.cached).toBe(true);
        expect(b.body.cached).toBe(true);
        expect(requestsToIssues()).toBe(before);
        const again = await call("GET", `/api/tests/${t.testId}/sentry?refresh=1`);
        expect(again.body.cached).toBe(false);
        expect(requestsToIssues()).toBe(before + 1);
    });

    it("makes one request when the page is opened twice at once", async () => {
        const t2 = seed(spec("API-002", "Coupon"), "Server error: GET /api/coupon returned 500");
        const before = requestsToIssues();
        const [a, b] = await Promise.all([call("GET", `/api/tests/${t2.testId}/sentry`), call("GET", `/api/tests/${t2.testId}/sentry`)]);
        expect(a.body.state).toBe("ok");
        expect(b.body.state).toBe("ok");
        expect(requestsToIssues()).toBe(before + 1);
    });

    it("forgets what it found when the connection is replaced", async () => {
        const before = requestsToIssues();
        expect((await connectSentry()).status).toBe(200);
        expect((await call("GET", `/api/tests/${t.testId}/sentry`)).body.cached).toBe(false);
        expect(requestsToIssues()).toBe(before + 1);
    });

    it("also uses the failed requests recorded for a web test", async () => {
        // A web test: its evidence says GET /api/orders answered 500. The failure message names nothing.
        issueList = [
            { id: "201", title: "OrdersController failed", culprit: "/api/orders", level: "error", count: "7", firstSeen: iso(20_000), lastSeen: iso(30_000), permalink: "https://acme.sentry.example/issues/201/" },
            { id: "202", title: "Cart", culprit: "/api/cart", level: "error", count: "7", firstSeen: iso(20_000), lastSeen: iso(30_000), permalink: "https://acme.sentry.example/issues/202/" },
        ];
        try {
            const web = seed(spec("WEB-001", "Orders page lists orders", "web"), "Timed out waiting for the heading", "NEEDS_REVIEW");
            const evidence = { v: 1, durationMs: 5000, counts: { requests: 2, requestsKept: 2, console: 0, consoleKept: 0 }, steps: [{ n: 1, t: 0 }, { n: 2, t: 900 }], requests: [{ t: 100, step: 1, method: "GET", type: "fetch", path: "/api/orders?page=1", status: 500, ms: 80 }, { t: 120, step: 1, method: "GET", type: "fetch", path: "/api/cart", status: 200, ms: 20 }], console: [] };
            const file = await platform.store.put(`evidence-test/${web.executionId}.json`, JSON.stringify(evidence));
            platform.repo.addArtifact({ projectId, testId: web.testId, executionId: web.executionId, kind: "evidence", path: file.key, size: file.size });
            const res = await call("GET", `/api/tests/${web.testId}/sentry`);
            expect(res.body.state).toBe("ok");
            // /api/orders failed, /api/cart did not: only the orders issue is "reported at" a failed path
            expect(res.body.issues.map((i: { id: string; reason: string }) => [i.id, /reported at \/api\/orders/.test(i.reason)])).toEqual([["201", true], ["202", false]]);
        } finally {
            issueList = issuesFor();
        }
    });

    it("says plainly that a passing test has nothing to look up", async () => {
        const passed = seed(spec("API-003", "Passes"), "", "VALIDATED");
        const hits = sentryCalls.length;
        const res = await call("GET", `/api/tests/${passed.testId}/sentry`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ connected: true, state: "unavailable", code: "not_failed" });
        expect(sentryCalls.length).toBe(hits);
    });

    it("says plainly that a test that never ran has no run to look up", async () => {
        const { repo } = platform;
        const id = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Checkout", "checkout"), jobId: null, spec: spec("API-004", "Never ran"), framework: "playwright-api", validationStatus: "NEEDS_REVIEW" });
        const res = await call("GET", `/api/tests/${id}/sentry`);
        expect(res.body).toMatchObject({ connected: true, state: "unavailable", code: "not_run" });
    });
});

describe("when Sentry cannot answer", () => {
    const failing = (project: string, b: (typeof behaviour)[string]) => {
        behaviour[project] = b;
        return call("PUT", `/api/projects/${projectId}/sentry`, { baseUrl: SENTRY, organization: "acme", project, token: TOKEN, verify: false });
    };
    afterAll(async () => {
        delete behaviour.limited;
        await connectSentry();
    });

    let lookups = 0;
    const lookup = async (name: string) => {
        const t = seed(spec(`API-${100 + ++lookups}`, `Lookup ${name}`), "Server error: GET /api/cart returned 503");
        const before = requestsToIssues();
        const res = await call("GET", `/api/tests/${t.testId}/sentry`);
        return { res, requests: requestsToIssues() - before, t };
    };

    it("a rejected token is a sentence, not an error page, and is not retried", async () => {
        await failing("denied-token", { status: 401, body: { detail: "Invalid token" } });
        const { res, requests } = await lookup("401");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ connected: true, state: "unavailable", code: "unauthorized", message: "Sentry didn’t accept the token. Connect Sentry again with a new token." });
        expect(requests).toBe(1);
        expect(res.text).not.toContain(TOKEN);
    });

    it("a rate limit is a sentence and is not retried", async () => {
        await failing("limited", { status: 429, body: { detail: "Rate limit" }, headers: { "retry-after": "30" } });
        const { res, requests } = await lookup("429");
        expect(res.body).toMatchObject({ state: "unavailable", code: "rate_limited", message: "Sentry is limiting how fast we can ask. Try again in a minute." });
        expect(requests).toBe(1);
    });

    it("a token that may not read the project is explained", async () => {
        await failing("denied", { status: 403, body: { detail: "You do not have permission" } });
        const { res } = await lookup("403");
        expect(res.body).toMatchObject({ state: "unavailable", code: "forbidden" });
        expect(res.body.message).toMatch(/isn’t allowed to read this project/);
    });

    it("a project that is gone is explained", async () => {
        await failing("gone", { status: 404 });
        const { res } = await lookup("404");
        expect(res.body).toMatchObject({ state: "unavailable", code: "not_found" });
    });

    it("Sentry being down is tried once more, then reported", async () => {
        await failing("down", { status: 503, body: { detail: "maintenance" } });
        const { res, requests } = await lookup("503");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ state: "unavailable", code: "unreachable" });
        expect(res.body.message).toMatch(/having problems right now/);
        expect(requests).toBe(2);
    });

    it("an answer in the wrong shape is reported, not shown", async () => {
        await failing("weird", { status: 200, body: { detail: "this is not a list", stacktrace: "STACKTRACE-SENTINEL" } });
        const { res } = await lookup("weird!");
        expect(res.body).toMatchObject({ state: "unavailable", code: "rejected" });
        expect(res.text).not.toContain("STACKTRACE-SENTINEL");
    });

    it("an address nobody listens on is reported, with one more try", async () => {
        await call("PUT", `/api/projects/${projectId}/sentry`, { baseUrl: "http://127.0.0.1:5739", organization: "acme", project: "shop", token: TOKEN, verify: false });
        const { res } = await lookup("closed port");
        expect(res.body).toMatchObject({ state: "unavailable", code: "unreachable" });
        expect(res.body.message).toMatch(/couldn’t reach Sentry/);
    });

    it("a failure is not remembered: the next view asks again", async () => {
        await failing("limited", { status: 429 });
        const { t } = await lookup("first");
        const before = requestsToIssues();
        await call("GET", `/api/tests/${t.testId}/sentry`);
        expect(requestsToIssues()).toBe(before + 1);
    });

    it("a slow answer is given up on at the timeout, without a second try", async () => {
        await failing("slow", { delayMs: 1500, body: [] });
        const t = seed(spec("API-300", "Slow lookup"), "Server error: GET /api/cart returned 503");
        const before = requestsToIssues();
        const started = Date.now();
        const answer = await relatedErrors({ repo: platform.repo, artifacts: platform.store, sentry: store, cache: new RelatedCache(), timeoutMs: 300 }, t.testId);
        expect(Date.now() - started).toBeLessThan(1400);
        expect(answer).toMatchObject({ connected: true, state: "unavailable", code: "unreachable" });
        expect((answer as { message: string }).message).toMatch(/did not answer in time/);
        expect(requestsToIssues()).toBe(before + 1);
    });

    it("the default timeout is eight seconds", () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, "src/platform/sentry/client.ts"), "utf8");
        expect(src).toMatch(/const TIMEOUT_MS = 8000;/);
    });
});

describe("a related Sentry link in the issue body", () => {
    beforeAll(async () => {
        behaviour.shop = undefined as never;
        delete behaviour.shop;
        expect((await connectSentry()).status).toBe(200);
        relatedCache.clear();
    });

    it("is added when the test page has already looked it up, and says it only might be related", async () => {
        const t = seed(spec("API-400", "Cart again"), "Server error: GET /api/cart returned 503");
        expect((await call("GET", `/api/tests/${t.testId}/sentry`)).body.state).toBe("ok");
        const ghId = (await call("GET", `/api/projects/${projectId}/integrations`)).body[0].id;
        const before = requestsToIssues();
        const res = await call("POST", `/api/tests/${t.testId}/issue`, { integrationId: ghId });
        expect(res.status).toBe(201);
        expect(requestsToIssues()).toBe(before); // creating an issue never asks Sentry
        const body: string = ghBodies.at(-1).body;
        expect(body).toContain("This Sentry issue might be related");
        expect(body).toContain("[TypeError: cart is undefined](https://acme.sentry.example/issues/101/)");
        expect(body).toMatch(/does not mean it caused it/);
        for (const secret of FORBIDDEN) expect(body).not.toContain(secret);
        expect(body).not.toContain(TOKEN);
    });

    it("is left out when nothing was looked up, and Sentry is not asked", async () => {
        const t = seed(spec("API-401", "Cart once more"), "Server error: GET /api/cart returned 503");
        const ghId = (await call("GET", `/api/projects/${projectId}/integrations`)).body[0].id;
        const before = sentryCalls.length;
        expect((await call("POST", `/api/tests/${t.testId}/issue`, { integrationId: ghId })).status).toBe(201);
        expect(ghBodies.at(-1).body).not.toMatch(/sentry/i);
        expect(sentryCalls.length).toBe(before);
    });
});

describe("removing Sentry", () => {
    it("forgets the connection and what it found; the tests and their issues stay", async () => {
        expect((await call("DELETE", `/api/projects/${projectId}/sentry`)).status).toBe(204);
        expect((await call("GET", `/api/projects/${projectId}/sentry`)).body).toEqual({ connected: false });
        expect((await call("DELETE", `/api/projects/${projectId}/sentry`)).status).toBe(404);
        const t = seed(spec("API-500", "After removal"), "Server error: GET /api/cart returned 503");
        expect((await call("GET", `/api/tests/${t.testId}/sentry`)).body).toEqual({ connected: false });
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM integrations WHERE kind = 'sentry'")!.n).toBe(0);
        expect((await call("GET", `/api/projects/${projectId}/integrations`)).body).toHaveLength(1);
    });
});
