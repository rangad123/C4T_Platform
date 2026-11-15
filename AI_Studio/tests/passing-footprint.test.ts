/**
 * The evidence helper every web script carries (src/engine/evidence/capture.ts): a passing test keeps a compact footprint (pages and
 * endpoints touched, counts; no text, bodies or header values), a failing one its full evidence; and a response's allow-listed
 * correlation header (x-request-id, traceparent, ...) is kept, masked and capped, while nothing is ever added to a request.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEvidenceRuntime } from "../src/engine/evidence/capture.js";
import { sanitizeEvidence, type Evidence } from "../src/engine/evidence/model.js";

const rt = loadEvidenceRuntime();
const PORT = 9652;
const SECRET = "Footprint-Secret-7733";
const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
let server: http.Server;
let browser: Browser;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        seenHeaders.push({ ...req.headers });
        const url = new URL(req.url!, "http://x");
        if (url.pathname.startsWith("/api/")) {
            res.setHeader("content-type", "application/json");
            res.setHeader("x-request-id", url.pathname === "/api/secret" ? `req-${SECRET}` : url.pathname === "/api/missing" ? `9f8e7d6c-1a2b-4c3d-8e9f-0a1b2c3d4e5f ${"x ".repeat(200)}` : "3b241101-e2bb-4255-8caf-4136c566a962");
            res.setHeader("set-cookie", `sid=${SECRET}; HttpOnly`);
            res.setHeader("x-internal-token", SECRET);
            res.statusCode = url.pathname === "/api/missing" ? 404 : 200;
            res.end(JSON.stringify({ body: SECRET }));
            return;
        }
        if (url.pathname === "/events") {
            res.setHeader("content-type", "text/event-stream");
            res.write("data: hi\n\n");
            setTimeout(() => res.end(), 100);
            return;
        }
        if (url.pathname === "/beacon" || url.pathname === "/login") {
            res.end("ok");
            return;
        }
        res.setHeader("content-type", "text/html");
        if (url.pathname === "/spa") {
            // A single-page app: routes by pushState and by hash, a form sent to the server, a stream, a beacon and a WebSocket.
            res.end(`<title>Spa</title><form method="post" action="/login"><button>Sign in</button></form><script>
                history.pushState({}, "", "/spa/orders/42"); location.hash = "#/cart/7?coupon=${SECRET}";
                new EventSource("/events"); navigator.sendBeacon("/beacon", "x");
                try { new WebSocket("ws://127.0.0.1:${PORT}/live"); } catch (e) {}
            </script>`);
            return;
        }
        if (url.pathname === "/token") {
            // A token handed over in the fragment is never a route.
            res.end(`<title>Token</title><script>location.hash = "#access_token=${SECRET}";</script>`);
            return;
        }
        res.end(`<title>Page ${url.pathname}</title><script>
            fetch("/api/items?token=${SECRET}&page=1"); fetch("/api/items?page=2"); fetch("/api/secret"); fetch("/api/missing");
        </script>`);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
});

async function record(withEvidence = true) {
    const page = await browser.newPage();
    const rec = withEvidence ? rt.installEvidence(page, `http://127.0.0.1:${PORT}/`) : undefined;
    await page.goto(`http://127.0.0.1:${PORT}/shop`);
    if (rec) rt.evidenceStep(page, 1);
    await page.waitForTimeout(400);
    await page.goto(`http://127.0.0.1:${PORT}/cart?coupon=${SECRET}`);
    if (rec) rt.evidenceStep(page, 2);
    await page.waitForTimeout(400);
    return { page, rec };
}

describe("a passing test's footprint", () => {
    it("lists pages and endpoints touched (method, path without query values, statuses, counts), within about 5 KB, with no text or header value", async () => {
        const { page, rec } = await record();
        const fp = rt.evidenceFootprint(rec, [SECRET]) as Evidence & { footprint: { pages: Array<{ path: string }>; endpoints: Array<{ method: string; path: string; n: number; statuses: number[] }> } };
        await page.close();
        const text = JSON.stringify(fp);
        expect(text.length).toBeLessThanOrEqual(6000);
        expect(text).not.toContain(SECRET);
        expect(fp.requests).toEqual([]);
        expect(fp.console).toEqual([]);
        expect(fp.footprint.pages.map((p) => p.path)).toEqual(expect.arrayContaining(["/shop", "/cart"]));
        const items = fp.footprint.endpoints.find((e) => e.path === "/api/items")!;
        expect(items).toMatchObject({ method: "GET", n: 4, statuses: [200] });
        expect(fp.footprint.endpoints.find((e) => e.path === "/api/missing")!.statuses).toEqual([404]);
        for (const bad of ["set-cookie", "x-internal-token", "req-", "coupon", "token="]) expect(text, bad).not.toContain(bad);
        // The platform stores it as it is, masked again.
        const stored = sanitizeEvidence(fp, [SECRET])!;
        expect(stored.footprint!.endpoints.length).toBe(fp.footprint.endpoints.length);
        expect(JSON.stringify(stored)).not.toContain(SECRET);
    }, 60_000);

    it("stays small when a test touches very many endpoints", async () => {
        const page = await browser.newPage();
        const rec = rt.installEvidence(page, `http://127.0.0.1:${PORT}/`);
        await page.goto(`http://127.0.0.1:${PORT}/many`);
        rt.evidenceStep(page, 1);
        await page.evaluate(async () => {
            await Promise.all(Array.from({ length: 150 }, (_, i) => fetch(`/api/e${i}`)));
        });
        await page.waitForTimeout(300);
        const fp = rt.evidenceFootprint(rec, []) as { footprint: { endpoints: unknown[]; truncated?: boolean } };
        await page.close();
        expect(JSON.stringify(fp).length).toBeLessThanOrEqual(6000);
        expect(fp.footprint.endpoints.length).toBeGreaterThan(10);
        // What was left out to stay small is said, so the selection preview never takes the footprint as complete.
        expect(fp.footprint.truncated).toBe(true);
        expect(sanitizeEvidence(fp)!.footprint!.truncated).toBe(true);
    }, 60_000);

    it("attaches the footprint for a passing test, full evidence (with its footprint) for a failing one, nothing for a passing one with AITP_EVIDENCE=failures", async () => {
        // The run's secret, as a script gets it from its environment.
        process.env.TEST_PASSWORD = SECRET;
        const { page } = await record();
        const attached: Array<{ name: string; body: string }> = [];
        const info = (status: string) => ({ status, expectedStatus: "passed", attach: async (name: string, o: { body: string }) => void attached.push({ name, body: o.body }) });
        await rt.evidenceAttach(page, info("passed"));
        await rt.evidenceAttach(page, info("failed"));
        process.env.AITP_EVIDENCE = "failures";
        await rt.evidenceAttach(page, info("passed"));
        process.env.AITP_EVIDENCE = "always";
        await rt.evidenceAttach(page, info("passed"));
        delete process.env.AITP_EVIDENCE;
        delete process.env.TEST_PASSWORD;
        await page.close();
        expect(attached.length).toBe(3);
        const [pass, fail, always] = attached.map((a) => JSON.parse(a.body));
        expect(pass.footprint).toBeDefined();
        expect(pass.requests).toEqual([]);
        // Full evidence carries the footprint too, so a run kept in full still says everything it touched.
        expect(fail.footprint.pages.map((p: { path: string }) => p.path)).toEqual(expect.arrayContaining(["/shop", "/cart"]));
        expect(fail.requests.length).toBeGreaterThan(0);
        expect(always.footprint.endpoints.length).toBe(pass.footprint.endpoints.length);
        expect(always.requests.length).toBeGreaterThan(0);
        for (const a of attached) expect(a.body).not.toContain(SECRET);
    }, 60_000);
});

describe("what the footprint records for the selection preview", () => {
    it("records routes reached inside the page (pushState and hash), a form sent to the server, a stream, a beacon and a WebSocket", async () => {
        const page = await browser.newPage();
        const rec = rt.installEvidence(page, `http://127.0.0.1:${PORT}/`);
        await page.goto(`http://127.0.0.1:${PORT}/spa`);
        rt.evidenceStep(page, 1);
        await page.waitForTimeout(600);
        await page.getByRole("button", { name: "Sign in" }).click();
        rt.evidenceStep(page, 2);
        await page.waitForTimeout(400);
        const fp = rt.evidenceFootprint(rec, [SECRET]) as Evidence;
        await page.close();
        const f = fp.footprint!;
        expect(f.pages.map((p) => p.path)).toEqual(expect.arrayContaining(["/spa", "/spa/orders/42", "/spa/orders/42#/cart/7", "/login"]));
        const ends = f.endpoints.map((e) => `${e.method} ${e.path} ${e.type ?? "fetch"}`);
        expect(ends).toEqual(expect.arrayContaining(["POST /login document", "GET /events eventsource", "POST /beacon beacon", "GET /live websocket"]));
        expect(f.unclassified).toBeUndefined();
        expect(f.truncated).toBeUndefined();
        expect(JSON.stringify(fp)).not.toContain(SECRET);
        // Stored as it is: the hash route survives the platform's cleaning, the query of the route does not.
        const stored = sanitizeEvidence(fp, [SECRET])!;
        expect(stored.footprint!.pages.map((p) => p.path)).toEqual(f.pages.map((p) => p.path));
        expect(stored.footprint!.endpoints.find((e) => e.type === "websocket")).toMatchObject({ method: "GET", path: "/live" });
    }, 60_000);

    it("never keeps a fragment that is not a route (a token handed over in it)", async () => {
        const page = await browser.newPage();
        const rec = rt.installEvidence(page, `http://127.0.0.1:${PORT}/`);
        await page.goto(`http://127.0.0.1:${PORT}/token`);
        rt.evidenceStep(page, 1);
        await page.waitForTimeout(300);
        const fp = rt.evidenceFootprint(rec, []) as Evidence;
        await page.close();
        expect(fp.footprint!.pages.map((p) => p.path)).toEqual(["/token"]);
        expect(JSON.stringify(fp)).not.toContain("access_token");
    }, 60_000);

    it("counts requests it cannot classify, and marks the footprint truncated when the recorder had to stop listing", () => {
        const page = new EventEmitter() as EventEmitter & { context(): { on(): void }; mainFrame(): unknown };
        page.context = () => ({ on: () => undefined });
        page.mainFrame = () => undefined;
        const rec = rt.installEvidence(page, "http://app.test/");
        const req = (url: string, type: string) => page.emit("request", { url: () => url, method: () => "GET", resourceType: () => type });
        req("http://app.test/a.css", "stylesheet");
        req("http://app.test/x", "other");
        req("http://app.test/y", "prefetch");
        req("http://app.test/api/z", "fetch");
        const fp = (rt.evidenceFootprint(rec, []) as Evidence).footprint!;
        expect(fp.unclassified).toBe(2);
        expect(fp.truncated).toBeUndefined();
        expect(fp.endpoints.map((e) => e.path)).toEqual(["/api/z"]);
        expect(sanitizeEvidence({ v: 1, durationMs: 1, counts: { requests: 4, requestsKept: 0, console: 0, consoleKept: 0 }, steps: [], requests: [], console: [], footprint: fp })!.footprint!.unclassified).toBe(2);
        for (let i = 0; i < 450; i++) req(`http://app.test/api/n${i}`, "xhr");
        expect((rt.evidenceFootprint(rec, []) as Evidence).footprint!.truncated).toBe(true);
    });

    it("says truncated when the platform drops entries that do not fit its caps or its schema", () => {
        const base = { v: 1, durationMs: 1, counts: { requests: 0, requestsKept: 0, console: 0, consoleKept: 0 }, steps: [], requests: [], console: [] };
        const many = sanitizeEvidence({ ...base, footprint: { pages: Array.from({ length: 41 }, (_, i) => ({ path: `/p${i}`, step: 1 })), endpoints: [] } })!;
        expect(many.footprint).toMatchObject({ truncated: true });
        expect(many.footprint!.pages).toHaveLength(40);
        const bad = sanitizeEvidence({ ...base, footprint: { pages: [{ path: "/a", step: 1 }, { path: 7 }], endpoints: [] } })!;
        expect(bad.footprint!.truncated).toBe(true);
        // A footprint that fits stays as it is (no flag added).
        expect(sanitizeEvidence({ ...base, footprint: { pages: [{ path: "/a", step: 1 }], endpoints: [] } })!.footprint).toEqual({ pages: [{ path: "/a", step: 1 }], endpoints: [] });
    });
});

describe("correlation headers", () => {
    it("keeps one allow-listed response header per request, masked and capped; never any other header", async () => {
        const { page, rec } = await record();
        const full = rt.evidenceSerialize(rec, [SECRET]) as Evidence & { requests: Array<{ path: string; corr?: string }> };
        await page.close();
        const secretOne = full.requests.find((r) => r.path === "/api/secret")!;
        expect(secretOne.corr).toBe("x-request-id: req-[hidden]");
        // An ordinary id is kept as it is; a long value is cut.
        expect(full.requests.find((r) => r.path.startsWith("/api/items"))!.corr).toBe("x-request-id: 3b241101-e2bb-4255-8caf-4136c566a962");
        const long = full.requests.find((r) => r.path === "/api/missing")!;
        expect(long.corr!.startsWith("x-request-id: 9f8e7d6c-1a2b-4c3d-8e9f-0a1b2c3d4e5f")).toBe(true);
        expect(long.corr!.length).toBeLessThanOrEqual(160);
        const text = JSON.stringify(full);
        for (const bad of ["set-cookie", "x-internal-token", SECRET]) expect(text, bad).not.toContain(bad);
        expect(full.requests.find((r) => r.path === "/shop")!.corr).toBeUndefined();
    }, 60_000);

    it("adds no header to any request", async () => {
        seenHeaders.length = 0;
        await (await record(false)).page.close();
        const without = seenHeaders.map((h) => Object.keys(h).sort().join(","));
        seenHeaders.length = 0;
        await (await record(true)).page.close();
        const withIt = seenHeaders.map((h) => Object.keys(h).sort().join(","));
        expect(new Set(withIt)).toEqual(new Set(without));
    }, 60_000);
});
