/**
 * UX-D, the parts that need no browser: where a test came from (provenance wording from stored facts only), the script split that
 * folds the platform's setup code away (run on the REAL generators' output), the decided vocabulary, and the glossary behind <Term>.
 */
import { describe, expect, it } from "vitest";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { sameLocator } from "../web/src/features/healing/healing.js";
import { originOf, type OriginInput } from "../web/src/features/provenance/provenance.js";
import { GLOSSARY, jobLabel, phaseText, VALIDATION } from "../web/src/lib/labels.js";
import { splitScript } from "../web/src/lib/script.js";

const base = (over: Partial<OriginInput> = {}): OriginInput => ({
    testId: "API-007",
    type: "functional",
    priority: "high",
    validationStatus: "VALIDATED",
    attempts: 1,
    spec: { description: "Reads one product", source: { origin: "openapi" } },
    generationMeta: null,
    ...over,
});

describe("provenance: where a test came from", () => {
    it("says an OpenAPI test came from the document and names the endpoint, without inventing a model", () => {
        const o = originOf(base({ generationMeta: { endpoint: "GET /api/products/{id}" } }));
        expect(o.parts).toEqual(["Created from the OpenAPI document", "from the endpoint GET /api/products/{id}"]);
        expect(o.autoFix).toBeNull();
    });

    it("says an exploration test was made by exploration, with the journey, start page, model and the date of its first script", () => {
        const o = originOf(
            base({
                spec: { description: "Adds a product", source: { origin: "browser-agent", journey: "Checkout" } },
                generationMeta: { model: "claude-sonnet", scenario: { description: "A shopper puts a product in the cart", startPath: "/products/1", priority: "high" } },
                scripts: [{ createdAt: "2026-10-12T10:00:00.000Z" }, { createdAt: "2026-10-13T10:00:00.000Z" }],
            }),
        );
        expect(o.parts.slice(0, 4)).toEqual(["Created by exploration", "journey “Checkout”", "starting at /products/1", "model claude-sonnet"]);
        expect(o.parts).toHaveLength(5);
        expect(o.why.map((w) => w.label)).toEqual(["The idea behind it", "How it is rated"]);
        expect(o.why[0]!.text).toBe("A shopper puts a product in the cart");
        expect(o.why[1]!.text).toBe("Functional test, high priority.");
    });

    it("covers written, recorded, imported, built and code tests", () => {
        expect(originOf(base({ spec: { source: { origin: "plain-english" } }, generationMeta: { plain: { description: "Add a mug to the cart" }, model: "m1" } })).parts).toEqual(["Written from your description", "model m1"]);
        expect(originOf(base({ spec: { source: { origin: "plain-english" } }, generationMeta: { plain: { description: "Add a mug to the cart" } } })).why[0]).toEqual({ label: "You asked for", text: "Add a mug to the cart" });
        expect(originOf(base({ spec: { source: { origin: "recorded" } } })).parts[0]).toBe("Recorded in a browser");
        expect(originOf(base({ spec: { source: { origin: "imported" } }, generationMeta: { imported: true } })).parts[0]).toBe("Imported from a file");
        expect(originOf(base({ spec: { source: { origin: "manual" } }, generationMeta: { authoring: "built-in-editor" } })).parts[0]).toBe("Built step by step in the editor");
        expect(originOf(base({ custom: { origin: "written", since: "2026-10-12T00:00:00Z" } })).parts[0]).toBe("Written as code");
        expect(originOf(base({ custom: { origin: "taken-over", since: "2026-10-12T00:00:00Z" } })).parts[0]).toBe("Switched to code");
        expect(originOf(base({ custom: { origin: "git", since: "2026-10-12T00:00:00Z", git: { host: "github.com", path: "acme/tests", ref: "main" } } })).parts[0]).toBe("Imported from Git (github.com/acme/tests, main)");
    });

    it("leaves out everything the answer does not carry (no date, model, endpoint or reasons)", () => {
        const o = originOf(base({ spec: { source: { origin: "security-check" } } }));
        expect(o.parts).toEqual(["Created by the security check"]);
        expect(o.why).toEqual([]);
    });

    it("lists the failed attempts of a test that passed only after more than one try, and nothing for a clean pass", () => {
        const fixed = originOf(
            base({
                attempts: 3,
                executions: [
                    { attempt: 3, status: "passed", error: null, startedAt: "2026-10-12T10:03:00Z" },
                    { attempt: 2, status: "failed", error: "Error: expect(locator).toBeVisible() failed\nLocator: getByText('Added')", startedAt: "2026-10-12T10:02:00Z" },
                    { attempt: 1, status: "failed", error: "locator.click: Timeout 5000ms exceeded.", startedAt: "2026-10-12T10:01:00Z" },
                ],
            }),
        );
        expect(fixed.autoFix?.attempts).toBe(3);
        expect(fixed.autoFix?.failed.map((f) => f.attempt)).toEqual([1, 2]);
        expect(originOf(base({ attempts: 1 })).autoFix).toBeNull();
        expect(originOf(base({ attempts: 2, validationStatus: "FAILED_VALIDATION" })).autoFix).toBeNull();
    });
});

describe("splitScript on the real generators' output", () => {
    const web = TestSpecSchema.parse({
        testId: "WEB-001",
        title: "Add a product to the cart",
        kind: "web",
        category: "Cart",
        steps: [{ action: "navigate", url: "/products/1" }, { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } }, { action: "assert", check: "text", expected: "Added to the cart" }],
    });
    const api = TestSpecSchema.parse({
        testId: "API-001",
        title: "Reads one product",
        kind: "api",
        category: "API",
        steps: [{ action: "request", method: "GET", path: "/api/products/1" }, { action: "assertResponse", check: "status", expected: 200 }],
    });

    for (const [name, spec, framework] of [["web", web, "playwright"], ["api", api, "playwright-api"]] as const) {
        it(`${name}: the test is the body, the platform's code is the setup, and nothing is lost`, () => {
            const script = renderWithAdapter(spec, framework, { baseUrl: "http://127.0.0.1:1" }).content;
            const parts = splitScript(script);
            expect(parts, "a generated script has a body marker").not.toBeNull();
            expect(parts!.body.startsWith("test(")).toBe(true);
            expect(parts!.body).toContain(spec.title);
            expect(parts!.body).not.toMatch(/EVIDENCE_|function installEvidence|assertOwnOrigin\(/);
            expect(parts!.setup).toMatch(/EVIDENCE_MAX_REQUESTS|BASE_URL/);
            expect(parts!.setupLines).toBeGreaterThanOrEqual(8);
            // Folding is only a way of showing: the two parts are the two ends of the script.
            expect(script.endsWith(parts!.body)).toBe(true);
            expect(script.startsWith(parts!.setup)).toBe(true);
        });
    }

    it("a data-driven test starts at its loop, so the rows stay with the test", () => {
        const driven = TestSpecSchema.parse({ ...web, testData: { dataSet: "products" } });
        const script = renderWithAdapter(driven, "playwright", { baseUrl: "http://127.0.0.1:1", dataSets: { products: { columns: ["name"], rows: [{ name: "Mug" }, { name: "Cup" }] } } }).content;
        const parts = splitScript(script);
        expect(parts).not.toBeNull();
        expect(parts!.body.startsWith("for (const [rowIndex, row] of ROWS.entries()) {")).toBe(true);
    });

    it("does not fold a short script, a script with no test, or a script that is mostly its own test", () => {
        expect(splitScript('import { test } from "@playwright/test";\n\ntest("a", async () => {});\n')).toBeNull();
        expect(splitScript("# a PowerShell script\nWrite-Host 1\n")).toBeNull();
        expect(splitScript("")).toBeNull();
    });

    it("finds test.describe as the start of a hand-written script that has a long preamble", () => {
        const pre = Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`).join("\n");
        const parts = splitScript(`${pre}\n\ntest.describe("group", () => {\n  test("a", async () => {});\n});\n`);
        expect(parts?.body.startsWith("test.describe(")).toBe(true);
        expect(parts?.setupLines).toBe(10);
    });
});

describe("the decided vocabulary", () => {
    it("names a test's status Passing, Needs a look, Failing, Running and Not run yet", () => {
        expect(VALIDATION.VALIDATED.label).toBe("Passing");
        expect(VALIDATION.NEEDS_REVIEW.label).toBe("Needs a look");
        expect(VALIDATION.FAILED_VALIDATION.label).toBe("Failing");
        expect(VALIDATION.VALIDATING.label).toBe("Running…");
        expect(VALIDATION.PENDING.label).toBe("Not run yet");
    });

    it("says Run and Exploration, never Validating, Analysis or scenarios, in job and phase wording", () => {
        const words = [
            ...(["QUEUED", "DISCOVERING", "ANALYZING", "PLANNING", "GENERATING", "VALIDATING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED"] as const).flatMap((status) => [jobLabel({ status, error: null, mode: "validate" }).label, jobLabel({ status, error: null }).label]),
            ...(["discovery", "understanding", "planning", "generation", "validation"] as const).flatMap((p) => (["pending", "running", "done"] as const).map((s) => `${phaseText(p, s, { pagesDiscovered: 1, apisDiscovered: 1, journeysIdentified: 1, scenariosPlanned: 3, testsGenerated: 4, testsValidated: 3, testsFailedValidation: 0, testsNeedingReview: 1, scenariosSkipped: 0 }).title} ${phaseText(p, s, { pagesDiscovered: 1, apisDiscovered: 1, journeysIdentified: 1, scenariosPlanned: 3, testsGenerated: 4, testsValidated: 3, testsFailedValidation: 0, testsNeedingReview: 1, scenariosSkipped: 0 }).detail ?? ""}`)),
        ].join("\n");
        expect(words).not.toMatch(/validat|analy[sz]|scenario|needs? attention/i);
        expect(jobLabel({ status: "VALIDATING", error: null, mode: "validate" }).label).toBe("Running tests");
        expect(jobLabel({ status: "DISCOVERING", error: null }).label).toBe("Exploring your application");
        expect(jobLabel({ status: "FAILED", error: "boom" }).label).toBe("Exploration failed");
        expect(jobLabel({ status: "FAILED", error: "boom", mode: "validate" }).label).toBe("Run failed");
    });

    it("has one plain sentence for every glossary word, none with a banned word or an exclamation mark", () => {
        const words = Object.keys(GLOSSARY);
        expect(words).toEqual(expect.arrayContaining(["shared element", "reusable steps", "runner", "finding", "repair", "auto-fix", "quarantine", "trace", "run sequence", "control", "code test"]));
        for (const [word, text] of Object.entries(GLOSSARY)) {
            expect(text.length, word).toBeGreaterThan(30);
            expect(text.length, word).toBeLessThan(200);
            expect(text, word).not.toMatch(/!|seamless|leverage|unlock|empower|cutting-edge|game-changing/i);
            expect(text, word).toMatch(/[.]$/);
        }
    });
});

describe("sameLocator", () => {
    it("compares the fields that decide how an element is found", () => {
        expect(sameLocator({ by: "role", role: "button", value: "Add to cart" }, { by: "role", role: "button", value: "Add to cart" })).toBe(true);
        expect(sameLocator({ by: "role", role: "button", value: "Add to cart" }, { by: "role", role: "button", value: "Add to basket" })).toBe(false);
        expect(sameLocator({ by: "role", role: "button", value: "x", nth: 1 }, { by: "role", role: "button", value: "x" })).toBe(false);
        expect(sameLocator(undefined, undefined)).toBe(false);
        expect(sameLocator({ ref: "Cart button" }, { ref: "Cart button" })).toBe(false);
    });
});
