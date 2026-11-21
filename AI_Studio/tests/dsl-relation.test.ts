/**
 * Text tests for the Phase 4 steps (T11c): relation checks, database checks and response waits that keep the answer, as lines of text;
 * and every stored test fixture (the generated corpus, the saved C1c trial specs and the relation tests) surviving a round trip through
 * the text format unchanged. No browser, no server.
 */
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { comparableSpec, normalizeStep, printSpec, printStep } from "../src/engine/dsl/printer.js";
import { parseDsl } from "../src/engine/dsl/parser.js";
import { StepSchema, TestSpecSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";
import { generatedSpecs } from "./fixtures/spec-corpus.js";

const read = (kind: "web" | "api", ...lines: string[]) => parseDsl(`Test: Relation steps\nKind: ${kind}\n${lines.join("\n")}\n`);
const stepOf = (kind: "web" | "api", line: string) => {
    const r = read(kind, line);
    expect(r.diagnostics, line).toEqual([]);
    // the schema's defaults (an empty description) are part of a read step
    const { description, ...step } = r.spec!.steps[0]! as Step & { description?: string };
    return (description ? { ...step, description } : step) as Step;
};

describe("the new steps as lines of text", () => {
    it("a relation, with and without its source, in API and web tests", () => {
        for (const kind of ["api", "web"] as const) {
            expect(stepOf(kind, 'Expect the relation "subtotal == sum(lines[*].lineTotal)" to hold as stated in "3.9"')).toEqual({ action: "assertResponse", check: "relation", expression: "subtotal == sum(lines[*].lineTotal)", source: "3.9" });
            expect(stepOf(kind, 'Expect the relation "$disc > 0" to hold')).toEqual({ action: "assertResponse", check: "relation", expression: "$disc > 0" });
        }
    });
    it("a database check", () => {
        expect(stepOf("api", 'Expect the database check "orders-have-lines" to pass as stated in "5.11"')).toEqual({ action: "assertResponse", check: "dbCheck", name: "orders-have-lines", source: "5.11" });
    });
    it("a response wait that keeps the answer and remembers values", () => {
        const line = 'Wait for a response from "/api/cart" and remember "subtotal" from "subtotal" and remember "lines" from "lines"';
        const step = stepOf("web", line);
        expect(step).toEqual({ action: "wait", until: "response", value: "/api/cart", ms: 0, extract: { subtotal: "subtotal", lines: "lines" } });
        expect(printStep(step)).toBe(line);
        // without values to remember it is the plain wait, written as before
        const plain = stepOf("web", 'Wait for a response from "/api/cart"');
        expect(plain).toEqual({ action: "wait", until: "response", value: "/api/cart", ms: 0 });
        expect(printStep(plain)).toBe('Wait for a response from "/api/cart"');
    });
    it("an expression with quotes and backslashes prints escaped and reads back", () => {
        const step = StepSchema.parse({ action: "assertResponse", check: "relation", expression: 'code == "SAVE10" or contains(note, "a\\\\b")', source: 'req "4.1"' }) as Step;
        const line = printStep(step)!;
        expect(line).toBe('Expect the relation "code == \\"SAVE10\\" or contains(note, \\"a\\\\\\\\b\\")" to hold as stated in "req \\"4.1\\""');
        expect(normalizeStep(stepOf("api", line))).toBe(normalizeStep(step));
    });
    it("any check can name what it proves, before its note; other steps cannot", () => {
        const line = 'Expect the text "Discount (SAVE10)" to be visible in the popup as stated in "expected:1" note "Discount line"';
        const step = stepOf("web", line);
        expect(step).toMatchObject({ action: "assert", check: "visible", inPopup: true, source: "expected:1", description: "Discount line" });
        expect(printStep(step)).toBe(line);
        expect(read("web", 'Click the "Pay" button as stated in "4.1"').diagnostics[0]!.message).toBe("Only a check can say what it proves (as stated in ...).");
    });
    it("an expression outside the grammar is refused on its line, with the reason", () => {
        const r = read("api", 'Send a GET request to /api/cart', 'Expect the relation "process.exit(1)" to hold');
        expect(r.spec).toBeNull();
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]!.line).toBe(4);
        expect(r.diagnostics[0]!.message).toMatch(/^Not a relation the grammar allows: unexpected "\(" at position 13/);
    });
    it("remembering with request options after a wait is refused, not dropped", () => {
        expect(read("web", 'Wait for a response from "/api/cart" and remember "a" from "b" with the query "x" = "1"').diagnostics).not.toEqual([]);
    });
});

// ── every stored fixture ───────────────────────────────────────────────────

const saved = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "c1c-leftover-specs.json"), "utf8")) as Record<string, { title: string; steps: unknown[] }>;
const c1c = Object.entries(saved)
    .filter(([k]) => k !== "_source")
    .map(([testId, s]) => ({ path: `saved: ${testId}`, spec: TestSpecSchema.parse({ testId, title: s.title, kind: "web", steps: s.steps }) }));
const relationSpecs: Array<{ path: string; spec: TestSpec }> = [
    {
        path: "relation: api",
        spec: TestSpecSchema.parse({
            testId: "API-001",
            title: "Cart amounts follow the stated rules",
            kind: "api",
            steps: [
                { action: "request", method: "POST", path: "/api/cart/items", body: { productId: "p1", quantity: 4 }, auth: "default" },
                { action: "assertResponse", check: "relation", expression: "(subtotal - discount >= 5000) implies shipping == 0", source: "4.5" },
                { action: "request", method: "POST", path: "/api/cart/discount", body: { code: "SAVE10" }, auth: "default", extract: { disc: "discount" } },
                { action: "assertResponse", check: "relation", expression: "discount == round(subtotal * 0.10)", source: "4.1" },
                { action: "assertResponse", check: "dbCheck", name: "cart-lines-have-carts" },
            ],
        }),
    },
    {
        path: "relation: web",
        spec: TestSpecSchema.parse({
            testId: "WEB-001",
            title: "The cart the page builds follows the stated rules",
            kind: "web",
            steps: [
                { action: "navigate", url: "/products/p1" },
                { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
                { action: "wait", until: "response", value: "/api/cart/items", extract: { first: "subtotal", lines: "lines" } },
                { action: "assertResponse", check: "relation", expression: "subtotal == sum(lines[*].lineTotal)", source: "3.9" },
                { action: "assertResponse", check: "relation", expression: "$first == 2500 and count($lines) == 1" },
            ],
        }),
    },
];

describe("every stored test fixture survives a round trip through text unchanged", () => {
    const all = [...generatedSpecs(), ...c1c, ...relationSpecs];
    it("the fixtures are all there", () => {
        expect(c1c.length).toBe(7);
        // the saved trial specs use what text has to carry: sources on checks, containers and text filters
        const steps = c1c.flatMap((c) => c.spec.steps) as Array<Record<string, unknown>>;
        expect(steps.some((x) => x.source !== undefined)).toBe(true);
        expect(steps.some((x) => (x.locator as { within?: unknown } | undefined)?.within)).toBe(true);
        expect(steps.some((x) => (x.locator as { filter?: unknown } | undefined)?.filter)).toBe(true);
        expect(all.length).toBeGreaterThan(70);
    });
    // The one stored step the text format refuses on purpose: a visible check whose element is given AND a text it never compares
    // (the renderer ignores the text). It is refused with its reason, never written without it (tests/dsl-unit.test.ts, "extra fields").
    const REFUSED: Record<string, string[]> = { "saved: WEB-021": ["Step 13 (Validation message shows quantity must be at least 1) has settings that text cannot show."] };
    for (const { path: p, spec } of all) {
        it(`${p}: ${spec.title}`, () => {
            const printed = printSpec(spec);
            expect(printed.reasons, printed.text).toEqual(REFUSED[p] ?? []);
            if (REFUSED[p]) return;
            const back = parseDsl(printed.text);
            expect(back.diagnostics, printed.text).toEqual([]);
            expect(comparableSpec(back.spec!)).toBe(comparableSpec(spec));
            expect(printSpec(back.spec!).text).toBe(printed.text);
        });
    }
});

describe("random relation steps print and read back the same (fast-check)", () => {
    const value = fc.constantFrom("a", "lines[*].lineTotal", "items[0].p", "$v", "1.5", '"x\\"y"', "round(a / 3, 2)", "sum(lines[*].q)", "count(lines)");
    const expression = fc.tuple(value, fc.constantFrom("==", "!=", "<", ">="), value, fc.option(fc.tuple(fc.constantFrom("and", "or", "implies"), value, value))).map(([l, op, r, more]) => `${l} ${op} ${r}${more ? ` ${more[0]} ${more[1]} == ${more[2]}` : ""}`);
    it("relation and database check steps with any source text", () => {
        fc.assert(
            fc.property(expression, fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }), fc.boolean(), (expr, source, db) => {
                const step = StepSchema.parse(db ? { action: "assertResponse", check: "dbCheck", name: expr.slice(0, 100), ...(source ? { source } : {}) } : { action: "assertResponse", check: "relation", expression: expr, ...(source ? { source } : {}) }) as Step;
                const line = printStep(step);
                expect(line, JSON.stringify(step)).toBeDefined();
                expect(normalizeStep(stepOf("api", line!))).toBe(normalizeStep(step));
            }),
            { numRuns: 400, seed: 1911 },
        );
    });
});
