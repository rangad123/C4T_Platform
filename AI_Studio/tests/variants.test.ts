/**
 * Cross-browser and responsive checks ("variants"): real Playwright runs of validated web tests on Firefox, WebKit,
 * a phone and a tablet against a local fixture app whose behaviour depends on the browser and the screen width.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/variants.test.ts
 * Fixture port: 5230.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/platform/db.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { parseReport, type ScriptRun } from "../src/engine/validation/runner.js";
import { classifyVariantRun, detectBrowsers, EXTRA_VARIANT_IDS, normalizeVariants, publicVariants, runVariantChecks, VARIANTS, variantEligibility, type VariantRecord } from "../src/engine/validation/variants.js";
import { FIXTURE_SPECS, startVariantsApp } from "./fixtures/variants-app.js";

const PORT = 5230;
const BASE = `http://127.0.0.1:${PORT}`;

const spec = (o: Record<string, unknown>) => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", steps: [{ action: "navigate", url: "/" }], ...o });

describe("variant definitions", () => {
    it("defines the fixed set with plain-language labels and the sizes the brief asks for", () => {
        expect(Object.keys(VARIANTS)).toEqual(["chromium-desktop", "firefox", "webkit", "mobile-chrome", "tablet"]);
        expect(VARIANTS.firefox.label).toBe("Firefox");
        expect(VARIANTS.webkit.label).toBe("Safari (WebKit)");
        expect(VARIANTS["mobile-chrome"]).toMatchObject({ label: "Phone", browser: "chromium", viewport: { width: 390, height: 844 } });
        expect(VARIANTS.tablet).toMatchObject({ label: "Tablet", viewport: { width: 820, height: 1180 } });
        expect(EXTRA_VARIANT_IDS).not.toContain("chromium-desktop"); // the base run is not something you ask for
        expect(normalizeVariants(["tablet", "firefox", "nope", "firefox"])).toEqual(["firefox", "tablet"]);
    });

    it("says which variants can run from the installed browsers, with a plain reason when one cannot", () => {
        const list = publicVariants({ chromium: true, firefox: true, webkit: false });
        expect(list.find((v) => v.id === "firefox")!.available).toBe(true);
        const safari = list.find((v) => v.id === "webkit")!;
        expect(safari.available).toBe(false);
        expect(safari.reason).toMatch(/isn't installed/);
        expect(list.find((v) => v.id === "tablet")!.available).toBe(true); // phone and tablet only need Chromium
    });

    it("lets an environment override stand in for the installed-browser check", () => {
        const before = process.env.INSTALLED_BROWSERS_OVERRIDE;
        try {
            process.env.INSTALLED_BROWSERS_OVERRIDE = "chromium,webkit";
            expect(detectBrowsers()).toEqual({ chromium: true, firefox: false, webkit: true });
            delete process.env.INSTALLED_BROWSERS_OVERRIDE;
            // This machine has all three (see the brief); the real check looks on disk.
            expect(detectBrowsers()).toEqual({ chromium: true, firefox: true, webkit: true });
        } finally {
            if (before === undefined) delete process.env.INSTALLED_BROWSERS_OVERRIDE;
            else process.env.INSTALLED_BROWSERS_OVERRIDE = before;
        }
    });
});

describe("which tests are repeated", () => {
    it("repeats validated browser-dependent web tests only, and explains every exclusion", () => {
        expect(variantEligibility(spec({}), "VALIDATED")).toEqual({ eligible: true });
        const no = (s: ReturnType<typeof spec>, status = "VALIDATED") => (variantEligibility(s, status) as { reason: string }).reason;
        expect(no(spec({}), "NEEDS_REVIEW")).toMatch(/main run/);
        expect(no(spec({}), "FAILED_VALIDATION")).toMatch(/main run/);
        expect(no(spec({ kind: "api", steps: [{ action: "request", method: "GET", path: "/x" }] }))).toMatch(/Only web/);
        expect(no(spec({ type: "accessibility" }))).toMatch(/Accessibility/);
        expect(no(spec({ steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "a11y" }] }))).toMatch(/Accessibility/);
        expect(no(spec({ type: "visual" }))).toMatch(/per browser and screen size/);
        // A screenshot assert inside an ordinary test also rules it out (baselines are per browser and size).
        expect(no(spec({ steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot" }] }))).toMatch(/per browser and screen size/);
        expect(no(spec({ type: "security" }))).toMatch(/Security and health/);
        expect(no(spec({ tags: ["health"] }))).toMatch(/Security and health/);
    });
});

describe("reading a variant run", () => {
    const run = (o: Partial<ScriptRun>): ScriptRun => ({ testId: "WEB-001", status: "failed", durationMs: 10, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...o });

    it("tells 'fails here' from 'could not run here'", () => {
        expect(classifyVariantRun(run({ status: "passed" }), "firefox")).toEqual({ status: "passed" });
        const failed = classifyVariantRun(run({ steps: [{ index: 1, title: "2. Click “Menu”", status: "failed", error: "locator.click: Timeout 10000ms exceeded." }] }), "mobile-chrome");
        expect(failed.status).toBe("failed");
        expect(failed.reason).toContain("2. Click “Menu”");
        // Playwright could not even start the browser: the application was never reached.
        const launch = classifyVariantRun(run({ error: "browserType.launch: Executable doesn't exist at C:\\x\\firefox.exe\nRun npx playwright install" }), "firefox");
        expect(launch.status).toBe("unavailable");
        expect(launch.reason).toMatch(/Firefox couldn't be started/);
        // The same words after the test had started stepping are a real failure.
        expect(classifyVariantRun(run({ steps: [{ index: 0, title: "1. Open /", status: "failed", error: "browserType.launch: boom" }] }), "firefox").status).toBe("failed");
        // No result at all (report missing / run killed) is also "could not run", never a pass or an app failure.
        expect(classifyVariantRun(run({ status: "error", error: "Validation run exceeded its time limit" }), "webkit").status).toBe("unavailable");
    });

    it("parses a report per (script, variant) and tags every run with its variant", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-variants-parse-"));
        try {
            const test = (projectName: string, status: string, steps: unknown[] = []) => ({ projectName, status, results: [{ status, duration: 5, steps, attachments: [] }] });
            fs.writeFileSync(
                path.join(dir, "report.json"),
                JSON.stringify({ suites: [{ file: "WEB-001.spec.ts", specs: [{ file: "WEB-001.spec.ts", tests: [test("firefox", "passed", [{ title: "1. Open /" }]), test("tablet", "failed", [{ title: "1. Open /", error: { message: "no" } }])] }] }] }),
            );
            const runs = await parseReport(dir, [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "" }, { testId: "WEB-002", filename: "WEB-002.spec.ts", content: "" }], "", false, "Playwright", ["firefox", "tablet"]);
            expect(runs.map((r) => [r.testId, r.variant, r.status])).toEqual([
                ["WEB-001", "firefox", "passed"],
                ["WEB-001", "tablet", "failed"],
                ["WEB-002", "firefox", "error"], // not in the report: reported as such, not guessed
                ["WEB-002", "tablet", "error"],
            ]);
            expect(runs[1]!.failedStepIndex).toBe(0);
            // Without variants the result shape is exactly what it always was.
            const plain = await parseReport(dir, [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "" }], "", false);
            expect(plain).toHaveLength(1);
            expect("variant" in plain[0]!).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("storage", () => {
    it("adds a nullable variant column and keeps variant rows out of a test's own run history", () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aitp-variants-db-")), "t.db");
        const db = new Db(file);
        try {
            const cols = db.all<{ name: string }>("PRAGMA table_info(test_executions)").map((c) => c.name);
            expect(cols).toContain("variant");
        } finally {
            db.close();
            fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
    });
});

/** Everything below launches real browsers. */
describe("cross-browser and responsive runs (real Firefox, WebKit, phone, tablet)", () => {
    let fixture: http.Server;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let dataDir: string;
    let projectId: string;
    const ids: Record<string, string> = {}; // testId -> test row id
    const savedOverride = process.env.INSTALLED_BROWSERS_OVERRIDE;

    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as any });
        return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
    };
    async function finish(jobId: string): Promise<any> {
        for (let i = 0; i < 600; i++) {
            const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("job did not finish");
    }
    const detail = async (testId: string) => (await call("GET", `/api/tests/${ids[testId]}`)).body;

    beforeAll(async () => {
        delete process.env.INSTALLED_BROWSERS_OVERRIDE;
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        fixture = await startVariantsApp(PORT);
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-variants-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, CONCURRENCY: "3" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();

        // Real base validation first: the tests must genuinely be VALIDATED on desktop Chrome before they are compared.
        projectId = (await call("POST", "/api/projects", { name: "Variants" })).body.id;
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: FIXTURE_SPECS, baseUrl: BASE });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        for (const t of imported.body.tests) ids[t.testId] = t.id;
        await finish(imported.body.jobId);
    }, 240_000);

    afterAll(async () => {
        if (savedOverride === undefined) delete process.env.INSTALLED_BROWSERS_OVERRIDE;
        else process.env.INSTALLED_BROWSERS_OVERRIDE = savedOverride;
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        fixture?.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("starts from honest base results: the matrix tests validate, the broken one does not", async () => {
        const status = async (k: string) => (await detail(k)).validationStatus;
        for (const k of ["WEB-001", "WEB-002", "WEB-003", "WEB-004", "WEB-005", "WEB-006", "API-001"]) expect(await status(k), k).toBe("VALIDATED");
        expect(await status("WEB-007")).toBe("FAILED_VALIDATION");
    });

    it("exposes the installed browsers and the variants in /api/config", async () => {
        const cfg = (await call("GET", "/api/config")).body;
        expect(cfg.browsers).toEqual({ chromium: true, firefox: true, webkit: true });
        expect(cfg.variants.map((v: any) => [v.id, v.label, v.available])).toEqual([
            ["firefox", "Firefox", true],
            ["webkit", "Safari (WebKit)", true],
            ["mobile-chrome", "Phone", true],
            ["tablet", "Tablet", true],
        ]);
    });

    it("rejects bad requests clearly", async () => {
        expect((await call("POST", `/api/projects/${projectId}/variants`, { variants: [] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/variants`, { variants: ["netscape"] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/variants`, { variants: ["firefox"], testIds: ["no-such-test"] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/variants`, { variants: ["chromium-desktop"] })).status).toBe(400);
        // An accessibility test cannot be repeated: 422 with the reason, and no job is created.
        const a11y = await call("POST", `/api/tests/${ids["WEB-005"]}/variants`, { variants: ["firefox"] });
        expect(a11y.status).toBe(422);
        expect(a11y.body.error).toMatch(/Accessibility/);
        expect((await call("POST", `/api/tests/${ids["API-001"]}/variants`, { variants: ["firefox"] })).status).toBe(422);
        expect((await call("POST", "/api/tests/nope/variants", { variants: ["firefox"] })).status).toBe(404);
        expect((await call("GET", `/api/projects/${projectId}/jobs`)).body.filter((j: any) => j.mode === "variants")).toHaveLength(0);
    });

    describe("all four variants, whole project", () => {
        let queued: any;
        let job: any;
        beforeAll(async () => {
            queued = await call("POST", `/api/projects/${projectId}/variants`, { variants: ["tablet", "firefox", "webkit", "mobile-chrome"] });
            if (queued.status === 202) {
                // one active job per project
                expect((await call("POST", `/api/projects/${projectId}/variants`, { variants: ["firefox"] })).status).toBe(409);
                job = await finish(queued.body.jobId);
            }
        }, 300_000);

        it("queues a 'variants' job for the eligible tests only and reports what it left out and why", () => {
            expect(queued.status, JSON.stringify(queued.body)).toBe(202);
            expect(queued.body.variants).toEqual(["firefox", "webkit", "mobile-chrome", "tablet"]);
            expect(queued.body.tests.map((t: any) => t.testId)).toEqual(["WEB-001", "WEB-002", "WEB-003", "WEB-004"]);
            const skipped = Object.fromEntries(queued.body.skipped.map((s: any) => [s.testId, s.reason]));
            expect(Object.keys(skipped).sort()).toEqual(["API-001", "WEB-005", "WEB-006", "WEB-007"]);
            expect(skipped["WEB-005"]).toMatch(/Accessibility/);
            expect(skipped["WEB-006"]).toMatch(/Visual/i);
            expect(skipped["WEB-007"]).toMatch(/main run/);
            expect(skipped["API-001"]).toMatch(/Only web/);
            expect(queued.body.unavailable).toEqual([]);
        });

        it("finishes as 'needs attention' (some tests differ) and counts the checks", () => {
            expect(job.mode).toBe("variants");
            expect(job.status).toBe("PARTIALLY_COMPLETED");
            expect(job.progress.validation).toBe("done");
            expect(job.progress.discovery).toBe("skipped");
            expect(job.testsGenerated).toBe(4); // tests compared
            expect(job.testsValidated).toBe(1); // WEB-001 behaves the same everywhere
            expect(job.testsNeedingReview).toBe(3);
            expect(job.counters.variantChecks).toBe(16);
            expect(job.counters.variantFailures).toBe(4); // WEB-002 phone, WEB-003 firefox, WEB-004 firefox + webkit
        });

        it("shows a truthful matrix: passes where the page works, fails where it does not", async () => {
            const cell = async (k: string) => Object.fromEntries(Object.entries((await detail(k)).compatibility).map(([v, e]: [string, any]) => [v, e.status]));
            expect(await cell("WEB-001")).toEqual({ firefox: "passed", webkit: "passed", "mobile-chrome": "passed", tablet: "passed" });
            expect(await cell("WEB-002")).toEqual({ firefox: "passed", webkit: "passed", "mobile-chrome": "failed", tablet: "passed" }); // links hidden below 600px
            expect(await cell("WEB-003")).toEqual({ firefox: "failed", webkit: "passed", "mobile-chrome": "passed", tablet: "passed" }); // offer hidden in Firefox
            expect(await cell("WEB-004")).toEqual({ firefox: "failed", webkit: "failed", "mobile-chrome": "passed", tablet: "passed" }); // Chromium-only prompt
        });

        it("keeps the failing step and evidence for each failure, and explains skipped tests", async () => {
            const phone = (await detail("WEB-002")).compatibility["mobile-chrome"];
            expect(phone).toMatchObject({ status: "failed", failedStep: { index: 1 }, stale: false });
            expect(phone.failedStep.title).toMatch(/^2\./);
            expect(phone.reason).toMatch(/Timeout|visible|expect/i);
            expect(phone.executionId).toBeTruthy();
            expect(phone.ranAt).toBeTruthy();
            const kinds = phone.artifacts.map((a: any) => a.kind);
            expect(kinds).toContain("screenshot");
            expect(kinds).toContain("video");
            const png = await server.inject({ method: "GET", url: `/api/artifacts/${phone.artifacts.find((a: any) => a.kind === "screenshot").id}` });
            expect(png.statusCode).toBe(200);
            expect(png.headers["content-type"]).toBe("image/png");
            expect(png.rawPayload.length).toBeGreaterThan(500);

            const a11y = (await detail("WEB-005")).compatibility;
            expect(Object.keys(a11y).sort()).toEqual(["firefox", "mobile-chrome", "tablet", "webkit"]);
            expect(a11y.firefox).toMatchObject({ status: "skipped" });
            expect(a11y.firefox.reason).toMatch(/Accessibility/);
            expect((await detail("WEB-006")).compatibility.webkit.reason).toMatch(/Visual/i);
            expect((await detail("WEB-007")).compatibility.tablet.reason).toMatch(/main run/);
            expect((await detail("API-001")).compatibility).toEqual({}); // an API test has no browser: nothing recorded
        });

        it("never touches the base result: status, run history and results export are unchanged", async () => {
            for (const k of ["WEB-001", "WEB-002", "WEB-003", "WEB-004"]) {
                const d = await detail(k);
                expect(d.validationStatus, k).toBe("VALIDATED");
                expect(d.severity).toBeNull();
                expect(d.executions, k).toHaveLength(1); // only the base run
                expect(d.executions[0].status).toBe("passed");
            }
            expect((await call("GET", `/api/tests/${ids["WEB-002"]}/executions`)).body).toHaveLength(1);
            const xml = (await server.inject({ method: "GET", url: `/api/projects/${projectId}/junit` })).body;
            expect(xml).not.toMatch(/<failure[^>]*WEB-002/); // a phone-only failure is not a failure of the main run
        });

        it("summarises the differences per test for the tests list", async () => {
            const list = (await call("GET", `/api/projects/${projectId}/tests`)).body as any[];
            const by = Object.fromEntries(list.map((t) => [t.testId, t.compat]));
            expect(by["WEB-001"]).toMatchObject({ failing: [], unavailable: [], passed: ["firefox", "webkit", "mobile-chrome", "tablet"], severity: null });
            expect(by["WEB-002"].failing).toEqual(["mobile-chrome"]);
            expect(by["WEB-003"].failing).toEqual(["firefox"]);
            expect(by["WEB-004"].failing).toEqual(["firefox", "webkit"]);
            expect(by["WEB-004"].severity.severity).toBe("medium"); // a compatibility finding
            expect(by["WEB-004"].severity.basis).toMatch(/Firefox, Safari \(WebKit\)/);
            expect(by["WEB-005"]).toBeNull(); // only skipped: nothing to badge
            expect(by["API-001"]).toBeNull();
            // The list still carries the unchanged base status.
            expect(list.find((t) => t.testId === "WEB-002").validationStatus).toBe("VALIDATED");
        });

        it("records events for the run and its results", async () => {
            const events = (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body as any[];
            const kinds = new Set(events.map((e) => e.kind));
            expect(kinds.has("variants_started")).toBe(true);
            expect(kinds.has("variant_failed")).toBe(true);
            expect(kinds.has("variant_passed")).toBe(true);
            expect(kinds.has("variant_skipped")).toBe(true);
            expect(kinds.has("variants_done")).toBe(true);
            expect(events.some((e) => /WEB-002 on Phone: failed/.test(e.message))).toBe(true);
        });
    });

    describe("a browser that is not installed", () => {
        it("is reported as 'unavailable' with a reason - the test is not failed and the other variants still run", async () => {
            process.env.INSTALLED_BROWSERS_OVERRIDE = "chromium,firefox"; // as in the Docker image minus Firefox: no WebKit here
            try {
                const cfg = (await call("GET", "/api/config")).body;
                expect(cfg.browsers.webkit).toBe(false);
                expect(cfg.variants.find((v: any) => v.id === "webkit")).toMatchObject({ available: false });

                const q = await call("POST", `/api/tests/${ids["WEB-001"]}/variants`, { variants: ["webkit", "firefox"] });
                expect(q.status, JSON.stringify(q.body)).toBe(202);
                expect(q.body.unavailable).toEqual([{ variant: "webkit", reason: expect.stringMatching(/isn't installed/) }]);
                const job = await finish(q.body.jobId);
                // Something could not run, so the job says "needs attention" - but nothing failed.
                expect(job.status).toBe("PARTIALLY_COMPLETED");
                expect(job.error).toMatch(/isn't installed/);
                expect(job.counters.variantFailures).toBe(0);

                const d = await detail("WEB-001");
                expect(d.compatibility.webkit).toMatchObject({ status: "unavailable" });
                expect(d.compatibility.webkit.reason).toMatch(/Safari's engine \(WebKit\) isn't installed/);
                expect(d.compatibility.webkit.artifacts).toEqual([]);
                expect(d.compatibility.firefox.status).toBe("passed"); // really re-run just now
                expect(d.compatibility.tablet.status).toBe("passed"); // older result for a variant not asked this time is kept
                expect(d.validationStatus).toBe("VALIDATED");

                const list = (await call("GET", `/api/projects/${projectId}/tests`)).body as any[];
                const c = list.find((t) => t.testId === "WEB-001").compat;
                expect(c.unavailable).toEqual(["webkit"]);
                expect(c.failing).toEqual([]);
                expect(c.severity).toBeNull(); // "could not run" is not a compatibility finding
            } finally {
                delete process.env.INSTALLED_BROWSERS_OVERRIDE;
            }
        }, 180_000);

        it("is also handled by the engine directly through an injected installed-browser check", async () => {
            const recorded: Array<{ testId: string; r: VariantRecord }> = [];
            const events: string[] = [];
            const summary = await runVariantChecks(
                { config: loadConfig({ DATA_DIR: dataDir }), llm: platform.llm, emit: (e) => events.push(`${e.kind}`) },
                {
                    scratchDir: platform.config.scratchDir,
                    env: { baseUrl: BASE, headless: true },
                    render: { baseUrl: BASE },
                    workers: 1,
                    detect: () => ({ chromium: true, firefox: false, webkit: false }),
                    sink: { counters: async () => undefined, recordVariant: async (h, _s, r) => void recorded.push({ testId: h.testId, r }) },
                },
                [
                    { handle: { id: "a", testId: "WEB-002" }, spec: TestSpecSchema.parse(FIXTURE_SPECS[1]), validationStatus: "VALIDATED" },
                    { handle: { id: "b", testId: "WEB-005" }, spec: TestSpecSchema.parse(FIXTURE_SPECS[4]), validationStatus: "VALIDATED" },
                ],
                ["firefox", "tablet"],
            );
            const got = Object.fromEntries(recorded.map(({ testId, r }) => [`${testId}/${r.variant}`, r.status]));
            expect(got).toEqual({ "WEB-005/firefox": "skipped", "WEB-005/tablet": "skipped", "WEB-002/firefox": "unavailable", "WEB-002/tablet": "passed" });
            expect(summary).toMatchObject({ checked: 1, clean: 0, differing: [], cells: { passed: 1, failed: 0, unavailable: 1, skipped: 2 } });
            expect(events).toContain("variants_done");
        }, 120_000);
    });

    describe("as an option of a validation job", () => {
        it("re-runs what validated on the chosen variants after the main run, and leaves the main result alone", async () => {
            // The same path generation jobs use (`variants` on the job options), driven on a validation job.
            const application = await server.inject({ method: "GET", url: `/api/projects/${projectId}` });
            const appId = JSON.parse(application.body).application.id as string;
            const job = await platform.repo.createJob(projectId, appId, { maxPages: 1, maxDepth: 0, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [ids["WEB-003"]!, ids["WEB-005"]!], variants: ["firefox", "webkit"] });
            const done = await finish(job.id);
            expect(done.mode).toBe("validate");
            expect(done.testsValidated).toBe(2);
            const d = await detail("WEB-003");
            expect(d.validationStatus).toBe("VALIDATED");
            expect(d.compatibility.firefox.status).toBe("failed");
            expect(d.compatibility.webkit.status).toBe("passed");
            expect(d.executions.length).toBe(2); // base run from the first import + this re-validation
            expect((await detail("WEB-005")).compatibility.firefox.status).toBe("skipped");
        }, 240_000);

        it("accepts a `variants` option when a generation job is requested, and refuses unknown ones", async () => {
            const bad = await call("POST", `/api/projects/${(await call("POST", "/api/projects", { name: "Gen" })).body.id}/test-generation`, { url: BASE, targets: ["api"], variants: ["netscape"] });
            expect(bad.status).toBe(400);
        });
    });
});
