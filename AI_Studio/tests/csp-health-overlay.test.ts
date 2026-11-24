/**
 * Page health checks on a page with a strict style-src policy (no 'unsafe-inline'), through the platform's real run path (runScripts with its
 * Playwright config). The failure video used to draw step titles as markup with an inline style; the page's policy refused it with a console
 * error, and the health check reported that error as the page's own. A clean strict page must pass, a page that really uses an inline style
 * must still be reported. No video is recorded any more (owner 2026-11-24, V9), and the failing test keeps none.
 *
 * Fixture port: 9541.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { generateHealthSpecs, healthFinding } from "../src/engine/health/specs.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { modelFor } from "./fixtures/checks-app.js";

const PORT = 9541;
const origin = `http://127.0.0.1:${PORT}`;
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'";
const page = (body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Strict page</title><link rel="stylesheet" href="/s.css"><script src="/a.js"></script></head><body><main><h1>Strict page</h1>${body}</main></body></html>`;
let server: http.Server;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const h = { "Content-Security-Policy": CSP };
        if (req.url === "/s.css") return res.writeHead(200, { ...h, "content-type": "text/css" }).end("h1{color:#333}");
        if (req.url === "/a.js") return res.writeHead(200, { ...h, "content-type": "text/javascript" }).end("document.documentElement.dataset.ready='1';");
        if (req.url === "/favicon.ico") return res.writeHead(204, h).end();
        if (req.url === "/bad") return res.writeHead(200, { ...h, "content-type": "text/html; charset=utf-8" }).end(page('<p style="color:red">An inline style the page itself uses.</p>'));
        return res.writeHead(200, { ...h, "content-type": "text/html; charset=utf-8" }).end(page("<p>No inline style here.</p>"));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
}, 30_000);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("page health on a strict style-src page", () => {
    it("reports no inline-style error the test's own recording caused, still reports the page's own, and records no video", async () => {
        const specs: TestSpec[] = generateHealthSpecs(modelFor(origin, [{ path: "/", type: "home" }, { path: "/bad", type: "content" }]), { maxPages: 6 }).map((d, i) => TestSpecSchema.parse({ ...d, testId: `WEB-${String(i + 1).padStart(3, "0")}` }));
        const clean = specs.find((s) => (s.steps[0] as { url: string }).url === "/")!;
        const bad = specs.find((s) => (s.steps[0] as { url: string }).url === "/bad")!;
        const scripts = [clean, bad].map((spec) => {
            const r = renderScript(spec, "playwright", { baseUrl: origin });
            return { testId: spec.testId, filename: r.filename, content: r.content };
        });
        const runs = new Map((await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: origin, headless: true }, { workers: 2 })).map((r) => [r.testId, r]));

        const cleanRun = runs.get(clean.testId)!;
        expect(cleanRun.error ?? "", "the clean strict page").not.toMatch(/Content Security Policy/i);
        expect(healthFinding(clean, cleanRun)).toBeUndefined();
        expect(cleanRun.status).toBe("passed");

        const badRun = runs.get(bad.testId)!;
        expect(badRun.status).not.toBe("passed");
        expect(healthFinding(bad, badRun) ?? "").toMatch(/inline style violates the following Content Security Policy/i);
        // Exactly the page's own violation: one error, not one more from the recording.
        expect(badRun.error ?? "").toMatch(/1 JavaScript error was reported/);
        expect(badRun.artifacts.some((a) => a.kind === "video")).toBe(false);
    }, 180_000);
});
