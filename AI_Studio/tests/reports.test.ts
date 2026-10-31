/** Shareable project report: HTML safety and content, evidence, secrets never included, and a real PDF. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { gatherReport, renderReportHtml } from "../src/platform/reports/project-report.js";
import { buildServer } from "../src/platform/server.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const HOSTILE = `<script>alert("xss")</script> & <img src=x onerror=alert(1)>`;
const SECRET = "hunter2-very-secret-password";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir: string;
let projectId: string;
let emptyProjectId: string;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-report-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    const { repo } = platform;

    projectId = repo.createProject({ name: `Shop ${HOSTILE}` }).id as string;
    repo.createApplication(projectId, "https://shop.example.test", {}, { username: "qa@example.test", password: SECRET, apiToken: `tok-${SECRET}` });
    emptyProjectId = repo.createProject({ name: "Empty" }).id as string;

    const add = (testId: string, title: string, steps: unknown[], status: string, reason?: string, kind = "web") => {
        const spec = TestSpecSchema.parse({ testId, title, kind, category: "Checkout", priority: "high", steps });
        const id = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Checkout", "checkout"), jobId: null, spec, framework: kind === "api" ? "playwright-api" : "playwright", validationStatus: "PENDING" });
        repo.updateTest(id, { validationStatus: status as "VALIDATED", reason });
        return id;
    };
    const navigate = { action: "navigate", url: "/" };
    // Each test checks something different, so only the deliberately weak one is flagged.
    const check = (n: string) => ({ action: "assert", check: "text", locator: { by: "css", value: "#c" }, expected: n });
    add("WEB-001", "Add to cart updates the count", [navigate, check("1")], "VALIDATED");
    const finding = add("WEB-002", HOSTILE, [navigate, check("2")], "NEEDS_REVIEW", `Server error: GET /api/cart returned 503. ${HOSTILE}`);
    add("WEB-003", "Opens the shop page", [navigate], "VALIDATED"); // weak: checks nothing
    add("WEB-004", "Cannot be validated", [navigate, check("4")], "FAILED_VALIDATION", "Timeout waiting for the button");
    add("WEB-005", "Not run yet", [navigate, check("5")], "PENDING");

    const exec = repo.addExecution({ testId: finding, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 50, startedAt: new Date().toISOString(), steps: [] });
    const rel = path.posix.join(projectId, "_artifacts", "WEB-002", "attempt-1", "screenshot.png");
    fs.mkdirSync(path.dirname(path.join(platform.config.artifactsDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(platform.config.artifactsDir, rel), PNG);
    repo.addArtifact({ projectId, testId: finding, executionId: exec, kind: "screenshot", path: rel, size: PNG.length });
}, 30_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("report data", () => {
    it("summarises counts, severity, weak tests and evidence", async () => {
        const d = (await gatherReport(platform.repo, platform.store, projectId))!;
        expect(d.total).toBe(5);
        expect(d.counts).toEqual({ validated: 2, needsReview: 1, failed: 1, notRun: 1 });
        expect(d.passRate).toBe(50); // 2 of the 4 that ran
        expect(d.bySeverity.high).toBe(1);
        expect(d.findings[0]!.image).toMatch(/^data:image\/png;base64,/);
        expect(d.weak.map((w) => w.key)).toEqual(["WEB-003"]);
        expect(d.areas).toEqual([{ name: "Checkout", total: 5, validated: 2, attention: 2 }]);
    });
    it("returns nothing for an unknown project", async () => {
        expect(await gatherReport(platform.repo, platform.store, "nope")).toBeUndefined();
    });
});

describe("HTML report", () => {
    const get = async (id: string, query = "") => server.inject({ method: "GET", url: `/api/projects/${id}/report${query}` });

    it("is a self-contained page that escapes everything from the app", async () => {
        const res = await get(projectId);
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/html");
        expect(res.headers["content-disposition"]).toMatch(/attachment; filename="report-shop-.*\.html"/);
        const html = res.body;
        expect(html).not.toContain("<script");
        expect(html).not.toContain("<img src=x"); // the markup arrives as harmless text
        expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
        expect(html).not.toMatch(/<(?:link|script)[^>]+(?:src|href)=["']https?:/); // no external assets
        expect(html).toContain("@media print");
        expect(html).toContain("<img alt=\"Screenshot of the problem\" src=\"data:image/png;base64,");
    });

    it("says in words what needs attention", async () => {
        const html = (await get(projectId)).body;
        expect(html).toContain("1 finding (1 high) needs attention, and 1 test could not be validated.");
        expect(html).toContain("Tests that check very little (1)");
        expect(html).toContain("Opens the shop page");
        expect(html).toContain("Security control coverage");
    });

    it("never contains credentials, tokens or server paths", async () => {
        const html = (await get(projectId)).body;
        expect(html).not.toContain(SECRET);
        expect(html).not.toContain("qa@example.test");
        expect(html).not.toContain(dir);
        expect(html).not.toContain("tok-");
    });

    it("handles a project with no tests and a bad format", async () => {
        const empty = await get(emptyProjectId);
        expect(empty.statusCode).toBe(200);
        expect(empty.body).toContain("There are no tests yet.");
        expect((await get(projectId, "?format=docx")).statusCode).toBe(400);
        expect((await get("nope")).statusCode).toBe(404);
    });

    it("caps inlined evidence", async () => {
        const d = (await gatherReport(platform.repo, platform.store, projectId))!;
        const big = { ...d, findings: d.findings.map((f) => ({ ...f, image: undefined })) };
        expect(renderReportHtml(big)).not.toContain("<img");
    });
});

describe("PDF report", () => {
    it("is a real PDF containing the report's text", async () => {
        const res = await server.inject({ method: "GET", url: `/api/projects/${projectId}/report?format=pdf` });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("application/pdf");
        expect(res.headers["content-disposition"]).toMatch(/filename="report-shop-.*\.pdf"/);
        const bytes = res.rawPayload;
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        expect(pdf.numPages).toBeGreaterThanOrEqual(1);
        const { text } = await extractText(pdf, { mergePages: true });
        expect(text).toContain("What needs attention");
        expect(text).toContain("Add to cart updates the count");
        expect(text).toContain("Opens the shop page");
        expect(text).not.toContain(SECRET);
    }, 90_000);
});
