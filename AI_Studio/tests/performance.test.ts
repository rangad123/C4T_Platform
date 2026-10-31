/**
 * Page speed checks, really executed: imported specs are validated by the worker in real Chromium against a local app
 * with a fast page, a slow server, a layout-shifting page and a heavy page. Asserts on relations and severities,
 * not exact milliseconds.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadPerfRuntime, PERF_GOOD } from "../src/engine/performance/checks.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5300;
const BASE = `http://127.0.0.1:${PORT}`;
const hits: Record<string, number> = {};
// A valid script of this size: the browser downloads all of it (garbage "images" are aborted early).
const HEAVY = Buffer.from("/*" + "x".repeat(700_000) + "*/");

const page = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`;
const app = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    hits[url] = (hits[url] ?? 0) + 1;
    const html = (body: string, delay = 0, head = "") =>
        setTimeout(() => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(page(body, head));
        }, delay);
    if (url === "/fast") return html("<h1>Fast</h1><p>Hello</p>");
    if (url === "/slow") return html("<h1>Slow server</h1><p>Hello</p>", 1000);
    if (url === "/shifty") return html('<h1 id="h">Shifty</h1><p>Some text that will move.</p><script>setTimeout(()=>{const b=document.createElement("div");b.style.cssText="height:300px;background:#ddd";b.textContent="late banner";document.body.insertBefore(b,document.getElementById("h"));},300)</script>');
    if (url === "/heavy") return html('<h1>Heavy</h1><script src="/_big.js"></script>');
    if (url === "/_big.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        return res.end(HEAVY);
    }
    res.writeHead(404).end("nope");
});

let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-perf-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => app.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
async function waitForJob(jobId: string) {
    for (let i = 0; i < 600; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("job did not finish");
}
const speedSpec = (title: string, path: string, budgets?: string) => ({
    title,
    kind: "web",
    category: "Performance",
    type: "performance",
    priority: "high",
    source: { origin: "performance-check" },
    steps: [{ action: "navigate", url: path }, { action: "assert", check: "pageSpeed", ...(budgets ? { expected: budgets } : {}) }],
});

describe("helper", () => {
    it("parses budget overrides and takes medians", () => {
        const rt = loadPerfRuntime();
        expect(rt.perfParse("")).toEqual({ budgets: { ...PERF_GOOD }, throttle: false });
        expect(rt.perfParse("lcp:3000 cls=0.2, weight:5000000 slow-4g bogus:1")).toEqual({ budgets: { ...PERF_GOOD, lcp: 3000, cls: 0.2, weight: 5_000_000 }, throttle: true });
        expect(rt.perfMedian([900, 100, 500])).toBe(500);
        expect(rt.perfMedian([3, 1])).toBe(3);
    });
    it("is off by default", () => {
        expect(DEFAULT_JOB_OPTIONS.performanceChecks).toBe(false);
    });
});

describe("page speed on a real app", () => {
    let projectId = "";
    let by: Record<string, { id: string; testId: string; validationStatus: string; validationReason: string | null; severity: { severity: string } | null }> = {};

    it("flags only the pages that break their budgets, with the right severity", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Speed" })).body.id;
        const specs = [
            speedSpec("Fast page is quick", "/fast", "ttfb:500 fcp:1500 lcp:2000 cls:0.1"),
            speedSpec("Slow server is slow", "/slow", "ttfb:300"),
            speedSpec("Shifting page is unstable", "/shifty", "cls:0.01"),
            speedSpec("Heavy page is heavy", "/heavy", "weight:200000"),
        ];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs, baseUrl: BASE });
        expect(res.status).toBe(202);
        await waitForJob(res.body.jobId);
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<(typeof by)[string] & { title: string }>;
        by = Object.fromEntries(tests.map((t) => [t.title, t]));

        expect(by["Fast page is quick"]!.validationStatus).toBe("VALIDATED");

        const slow = by["Slow server is slow"]!;
        expect(slow.validationStatus).toBe("NEEDS_REVIEW");
        expect(slow.validationReason).toContain("Page speed check failed:");
        expect(slow.validationReason).toMatch(/The server takes 1\.\d s to start responding \(aim for under 300 ms\)/);
        expect(slow.validationReason).toContain("How to fix:");
        expect(slow.severity!.severity).toBe("high"); // 1 s is more than twice the scaled "poor" line for a 300 ms budget

        const shifty = by["Shifting page is unstable"]!;
        expect(shifty.validationStatus).toBe("NEEDS_REVIEW");
        expect(shifty.validationReason).toMatch(/layout shifts while loading, by 0\.\d+ \(aim for under 0\.01\)/);

        const heavy = by["Heavy page is heavy"]!;
        expect(heavy.validationStatus).toBe("NEEDS_REVIEW");
        expect(heavy.validationReason).toMatch(/downloads \d+ KB \(budget 195 KB\)/);
        expect(heavy.severity!.severity).toBe("low"); // weight is never more than a low finding
    }, 240_000);

    it("loads each page three extra times from scratch, never reusing a cache", () => {
        // 1 navigation by the test + 3 measurements, per validation run (one run here).
        expect(hits["/fast"]).toBe(4);
        expect(hits["/_big.js"]).toBe(4);
    });

    it("keeps every run's measurements as history, also when within budget", async () => {
        const fast = by["Fast page is quick"]!;
        const first = (await call("GET", `/api/tests/${fast.id}/performance`)).body;
        expect(first.history).toHaveLength(1);
        const metrics = Object.fromEntries(first.latest.map((m: { metric: string; value: number; unit: string; budget?: number }) => [m.metric, m]));
        expect(Object.keys(metrics)).toEqual(expect.arrayContaining(["ttfb", "fcp", "load", "weight", "requests"]));
        expect(metrics.ttfb.value).toBeLessThan(500);
        expect(metrics.ttfb.unit).toBe("ms");
        expect(metrics.ttfb.budget).toBe(500);
        expect(metrics.weight.unit).toBe("bytes");

        // a second run adds a second point
        const again = await call("POST", `/api/tests/${fast.id}/validate`);
        expect(again.status).toBe(202);
        await waitForJob(again.body.jobId);
        const second = (await call("GET", `/api/tests/${fast.id}/performance`)).body;
        expect(second.history).toHaveLength(2);
        expect(second.history[0].at <= second.history[1].at).toBe(true);
    }, 120_000);

    it("lists the slowest pages for the project, worst first", async () => {
        const { slowest } = (await call("GET", `/api/projects/${projectId}/performance`)).body as { slowest: Array<{ title: string; value: number; metric: string }> };
        expect(slowest.length).toBeGreaterThanOrEqual(2);
        expect(slowest[0]!.title).toBe("Slow server is slow");
        for (let i = 1; i < slowest.length; i++) expect(slowest[i - 1]!.value).toBeGreaterThanOrEqual(slowest[i]!.value);
        expect((await call("GET", "/api/projects/nope/performance")).status).toBe(404);
        expect((await call("GET", "/api/tests/nope/performance")).status).toBe(404);
    });

    it("re-renders the script identically and carries no secrets", async () => {
        const detail = (await call("GET", `/api/tests/${by["Slow server is slow"]!.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("async function pageSpeedAssert");
        expect(script).toContain('pageSpeedAssert(page, "ttfb:300"');
        // No secrets. (The helper may mention a password *field* — it checks that a carried session was accepted — so only credential-looking text is banned.)
        expect(script).not.toMatch(/sk-|api[_-]?key|TEST_PASSWORD|password\s*[:=]\s*["'`]/i);
    });
});
