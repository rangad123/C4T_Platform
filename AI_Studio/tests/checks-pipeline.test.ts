/**
 * Page health + passive security checks through the whole platform (no LLM): HTTP API -> job queue ->
 * worker -> real discovery -> deterministic spec generation -> real Playwright validation -> findings
 * with severities in the API. Also the job options: `healthChecks` / `securityChecks` default to on,
 * are stored on the job, and switch their families off when false.
 *
 * Fixture ports: weak 5222, hardened 5223 (examples/checks-app).
 */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startChecksApp } from "./fixtures/checks-app.js";

const WEAK = "http://127.0.0.1:5222";
const HARDENED = "http://127.0.0.1:5223";
const children: ChildProcess[] = [];
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    children.push(await startChecksApp(5222, "weak"), await startChecksApp(5223, "hardened"));
    // no LLM: the AI web path cannot run, the deterministic families still do
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-checks-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, CONCURRENCY: "3" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    for (const c of children) c.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const json = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};

interface TestRow {
    id: string;
    testId: string;
    title: string;
    suite: string;
    type: string;
    validationStatus: string;
    validationReason: string | null;
    severity: { severity: string; basis: string } | null;
}

async function runJob(name: string, url: string, options: Record<string, unknown>) {
    const project = (await json("POST", "/api/projects", { name })).body;
    const queued = await json("POST", `/api/projects/${project.id}/test-generation`, { url, maxPages: 8, ...options });
    expect(queued.status).toBe(202);
    let job: { status: string; error: string | null; testsGenerated: number };
    for (let i = 0; i < 360; i++) {
        job = (await json("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    const tests = (await json("GET", `/api/projects/${project.id}/tests`)).body as TestRow[];
    return { projectId: project.id as string, jobId: queued.body.jobId as string, job: job!, tests };
}

describe("job options", () => {
    it("default to on, and a request can switch each family off", async () => {
        expect(DEFAULT_JOB_OPTIONS).toMatchObject({ healthChecks: true, securityChecks: true });
        expect(((await json("GET", "/api/config")).body as { defaults: Record<string, unknown> }).defaults).toMatchObject({ healthChecks: true, securityChecks: true });
        const project = (await json("POST", "/api/projects", { name: "options" })).body;
        // validated by the API schema: a non-boolean is rejected
        expect((await json("POST", `/api/projects/${project.id}/test-generation`, { url: WEAK, healthChecks: "yes" })).status).toBe(400);
    });
});

describe("weak application, default options", () => {
    let out: Awaited<ReturnType<typeof runJob>>;
    beforeAll(async () => {
        out = await runJob("Weak", WEAK, { targets: ["web"] });
    }, 300_000);

    it("stores the options on the job and generates both families (web analysis itself fails without an LLM)", () => {
        const job = platform.repo.getJob(out.jobId)!;
        expect(job.options).toMatchObject({ healthChecks: true, securityChecks: true });
        expect(out.job.status).toBe("PARTIALLY_COMPLETED");
        expect(out.job.error).toMatch(/No credentials for LLM provider/);
        const categories = new Set(out.tests.map((t) => t.suite));
        expect(categories.has("Health checks")).toBe(true);
        expect(categories.has("Security checks")).toBe(true);
    });

    it("turns the weak app's problems into findings with the right severities", () => {
        const health = out.tests.filter((t) => t.suite === "Health checks");
        const home = health.find((t) => t.title.startsWith("Home page is healthy"))!;
        expect(home.type).toBe("health");
        expect(home.validationStatus).toBe("NEEDS_REVIEW");
        expect(home.validationReason).toContain("Page health check failed:");
        expect(home.severity).toEqual({ severity: "high", basis: "request to the site failed" });

        const security = out.tests.filter((t) => t.suite === "Security checks");
        const sev = (start: string) => security.find((t) => t.title.startsWith(start))!;
        expect(sev("Secret and source-control").severity).toEqual({ severity: "critical", basis: "sensitive file readable by anyone" });
        expect(sev("Secret and source-control").validationReason).toContain("/.env can be downloaded by anyone");
        expect(sev("Cross-origin").severity?.severity).toBe("high");
        expect(sev("Browser security headers").severity?.severity).toBe("medium");
        expect(sev("Session cookies").severity?.severity).toBe("medium");
        expect(sev("The server does not reveal").severity?.severity).toBe("medium");
        // nothing readable in the second file group on this server: that test simply passes
        expect(sev("Backups").validationStatus).toBe("VALIDATED");
        // a finding is a NEEDS_REVIEW, never a broken test
        expect(security.filter((t) => t.validationStatus === "FAILED_VALIDATION")).toEqual([]);
        expect(health.filter((t) => t.validationStatus === "FAILED_VALIDATION")).toEqual([]);
    });

    it("keeps health tests numbered WEB-, security tests API-, and the downloadable scripts runnable on their own", async () => {
        const home = out.tests.find((t) => t.title.startsWith("Home page is healthy"))!;
        expect(home.testId).toMatch(/^WEB-\d{3}$/);
        const sec = out.tests.find((t) => t.suite === "Security checks")!;
        expect(sec.testId).toMatch(/^API-\d{3}$/);
        const script = (await json("GET", `/api/tests/${home.id}/script`)).body as string;
        expect(script).toContain("installHealthCollector(page, new URL(BASE_URL).origin)");
        expect(script).toContain("process.env.BASE_URL");
        const secScript = (await json("GET", `/api/tests/${sec.id}/script`)).body as string;
        expect(secScript).toContain("async function secAssert");
        expect(secScript).toContain("process.env.BASE_URL");
    });
});

describe("hardened application, default options", () => {
    it("validates every health and security check (nothing to report)", async () => {
        const out = await runJob("Hardened", HARDENED, { targets: ["web"] });
        const mine = out.tests.filter((t) => t.suite === "Health checks" || t.suite === "Security checks");
        expect(mine.length).toBeGreaterThanOrEqual(8); // 2+ health pages, 6 security checks (http: no certificate check)
        for (const t of mine) expect(t.validationStatus, `${t.title}: ${t.validationReason}`).toBe("VALIDATED");
        expect(mine.some((t) => /certificate/i.test(t.title))).toBe(false);
    }, 300_000);
});

describe("API-only job and switched-off families", () => {
    it("an API-only job still gets the security checks but no health checks", async () => {
        const out = await runJob("API only", HARDENED, { targets: ["api"] });
        expect(out.tests.filter((t) => t.suite === "Health checks")).toEqual([]);
        expect(out.tests.filter((t) => t.suite === "Security checks").length).toBeGreaterThanOrEqual(6);
        expect(out.tests.every((t) => t.testId.startsWith("API-"))).toBe(true);
    }, 300_000);

    it("healthChecks:false and securityChecks:false generate nothing from those families", async () => {
        const off = await runJob("Off", HARDENED, { targets: ["web"], healthChecks: false, securityChecks: false });
        expect(platform.repo.getJob(off.jobId)!.options).toMatchObject({ healthChecks: false, securityChecks: false });
        expect(off.tests.filter((t) => t.suite === "Health checks" || t.suite === "Security checks")).toEqual([]);
        // accessibility audits (a different, still-default family) are unaffected
        expect(off.tests.some((t) => t.type === "accessibility")).toBe(true);
    }, 300_000);
});
