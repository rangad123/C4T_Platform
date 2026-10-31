/**
 * UXP item 4: the text format can express every test the platform itself generates. Specs from the real generation paths (API
 * generation from OpenAPI, workflows, latency, load and access checks, the page-check families, the recorder, hand-written web
 * steps with every locator and action) are printed as text, the text is read back, and the test it gives is the test we started
 * with. Anything that cannot be written must be refused with a reason, never written wrong. No browser, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { comparableSpec, printSpec, printStep } from "../src/engine/dsl/printer.js";
import { parseDsl } from "../src/engine/dsl/parser.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { generatedSpecs } from "./fixtures/spec-corpus.js";

const corpus = generatedSpecs();

describe("the corpus is real", () => {
    it("covers every generation path", () => {
        const paths = new Set(corpus.map((c) => c.path));
        for (const p of ["api: openapi", "api: workflows", "api: latency", "api: load", "api: access", "checks: health", "checks: security", "checks: accessibility", "checks: input handling", "checks: page speed", "checks: ai judgement", "checks: visual", "checks: access control", "recorder", "plain english", "web steps"]) expect(paths, p).toContain(p);
        expect(corpus.length).toBeGreaterThan(60);
    });
});

describe("every generated test can be written as text and read back as itself", () => {
    for (const { path, spec } of corpus) {
        it(`${path}: ${spec.title}`, () => {
            const printed = printSpec(spec);
            expect(printed.reasons, printed.text).toEqual([]);
            expect(printed.expressible).toBe(true);
            const back = parseDsl(printed.text);
            expect(back.diagnostics, printed.text).toEqual([]);
            expect(comparableSpec(back.spec!)).toBe(comparableSpec(TestSpecSchema.parse(spec)));
        });
    }
});

describe("what really cannot be written is refused with a reason, never written wrong", () => {
    it("a mobile test, a desktop test and a step with an unknown setting", () => {
        const mobile = TestSpecSchema.parse({ testId: "MOB-001", title: "Phone test", kind: "mobile", steps: [{ action: "click", locator: { by: "text", value: "Go" } }] });
        expect(printSpec(mobile)).toMatchObject({ expressible: false });
        expect(printSpec(mobile).reasons.join(" ")).toMatch(/Mobile tests cannot be written as text/);
        const odd = TestSpecSchema.parse({ testId: "WEB-001", title: "Odd locator", kind: "web", steps: [{ action: "click", locator: { by: "css", value: "a", role: "link" } }] });
        const r = printSpec(odd);
        expect(r.expressible).toBe(false);
        expect(r.reasons[0]).toMatch(/Step 1 .* has settings that text cannot show/);
        expect(printStep(odd.steps[0]!)).toBeUndefined();
    });
});

describe("through the platform: a plain generated test opens as text and saves from text", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    let testId: string;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-dsl-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir }));
        server = await buildServer(platform);
        const project = platform.repo.createProject({ name: "Text shop" });
        platform.repo.createApplication(project.id, "http://127.0.0.1:6354", {});
        // The audit's test: three steps, the last one checks a status message that has no accessible name.
        const spec = TestSpecSchema.parse({
            testId: "WEB-001",
            title: "Add a product to the cart",
            kind: "web",
            category: "Shop",
            source: { origin: "browser-agent" },
            steps: [
                { action: "navigate", url: "/products/1" },
                { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
                { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Added to the cart" },
            ],
        });
        testId = platform.repo.insertTest({ projectId: project.id, suiteId: platform.repo.getOrCreateSuite(project.id, "Shop", "shop"), jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
    });
    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("GET /api/tests/:id/dsl no longer says it cannot be edited as text", async () => {
        const res = await server.inject({ method: "GET", url: `/api/tests/${testId}/dsl` });
        const body = JSON.parse(res.body);
        expect(res.statusCode).toBe(200);
        expect(body).toMatchObject({ expressible: true, reasons: [], editable: true });
        expect(body.text).toContain('Expect the role "status" to contain the text "Added to the cart"');
        expect(body.editReason).toBeUndefined();
    });

    it("the text saves, and reads back as the same test", async () => {
        const got = JSON.parse((await server.inject({ method: "GET", url: `/api/tests/${testId}/dsl` })).body);
        const edited = got.text.replace("Added to the cart", "Added to your cart");
        const saved = await server.inject({ method: "PUT", url: `/api/tests/${testId}/dsl`, payload: { text: edited } });
        expect(saved.statusCode, saved.body).toBeLessThan(300);
        const again = JSON.parse((await server.inject({ method: "GET", url: `/api/tests/${testId}/dsl` })).body);
        expect(again.text).toContain("Added to your cart");
        expect(again.expressible).toBe(true);
    });
});
