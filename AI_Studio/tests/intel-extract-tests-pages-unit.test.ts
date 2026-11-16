/**
 * Rules and workflows from existing tests (explicit, source = the test) and from pages (inferred only; unchanged pages not sent), with a
 * scripted model (no AI provider, fast tier).
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { extractFromPages, pageDocument } from "../src/engine/intel/extract/from-pages.js";
import { extractFromTests } from "../src/engine/intel/extract/from-tests.js";
import { ModelFragmentSchema } from "../src/engine/intel/fragment.js";
import { AppModelSchema } from "../src/engine/intel/model.js";
import { existingTestDocuments } from "../src/engine/intel/sources/existing-tests.js";
import type { LlmClient } from "../src/engine/llm/provider.js";

function scripted(answers: unknown[]): LlmClient & { prompts: string[] } {
    const prompts: string[] = [];
    let i = 0;
    return {
        modelName: "scripted",
        prompts,
        async object<T extends z.ZodTypeAny>(args: { prompt: string; schema: T }): Promise<z.infer<T>> {
            prompts.push(args.prompt);
            return args.schema.parse(answers[Math.min(i++, answers.length - 1)]);
        },
    } as unknown as LlmClient & { prompts: string[] };
}

const NOW = "2026-11-16T00:00:00.000Z";
const empty = { rules: [], workflows: [], roles: [], transitions: [] };

const { documents: TESTS } = existingTestDocuments({
    cases: [
        { ref: "TC-001", title: "A shipped order cannot be cancelled", steps: [{ action: "Open a shipped order" }, { action: "Press Cancel", expected: "The page says the order has shipped" }] },
        { ref: "TC-002", title: "Quantity limits", steps: [{ action: "Enter 11 as the quantity", expected: "The page refuses quantities above 10" }] },
    ],
    scripts: [],
});

const PAGES = AppModelSchema.parse({
    pages: [
        {
            id: "cart",
            path: "/cart",
            purpose: "The customer's cart with totals",
            elements: [{ role: "button", name: "Check out", kind: "button" }],
            forms: [{ name: "Add item", fields: [{ name: "qty", label: "Quantity", type: "number", required: true, min: "1", max: "10", message: "Quantity must be between 1 and 10" }] }],
            structures: [{ kind: "table", name: "Items", headers: ["Product", "Price"] }],
        },
        { id: "about", path: "/about", purpose: "About the shop" },
    ],
}).pages;

describe("rules from existing tests", () => {
    it("are explicit, with the test as source and its lines as evidence", async () => {
        const llm = scripted([
            { ...empty, rules: [{ kind: "constraint", description: "Quantity limit", expected: "Quantities above 10 are refused", doc: "manual-case:TC-002", lines: [3], quote: "The page refuses quantities above 10", confidence: 0.8 }] },
        ]);
        const f = await extractFromTests(llm, TESTS, { now: NOW });
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
        expect(f.source).toMatchObject({ kind: "existing_tests", status: "processed" });
        expect(f.rules[0]).toMatchObject({ sourceType: "existing_test", explicitness: "explicit", sourceRef: "manual-case:TC-002", evidence: [{ kind: "quote", ref: "manual-case:TC-002#L3" }] });
    });

    it("a rule citing the wrong test is dropped; one citing no test is attributed to the one test where its quote is at the cited lines", async () => {
        const quoteOf2 = { kind: "constraint", description: "d", expected: "Quantities above 10 are refused", lines: [3], quote: "The page refuses quantities above 10", confidence: 0.8 };
        const noDoc = { kind: "workflow", description: "d", expected: "A shipped order can be opened", lines: [2], quote: "Open a shipped order", confidence: 0.8 };
        const f = await extractFromTests(scripted([{ ...empty, rules: [{ ...quoteOf2, doc: "manual-case:TC-001" }, quoteOf2, noDoc] }]), TESTS, { now: NOW });
        expect(f.rules.map((r) => [r.expected, r.sourceRef])).toEqual([
            ["Quantities above 10 are refused", "manual-case:TC-002"],
            ["A shipped order can be opened", "manual-case:TC-001"],
        ]);
        expect(f.notes.join(" ")).toMatch(/1 item was dropped: 1 quote is not in the text at the lines cited/);
    });

    it("workflows from tests carry the test as their source", async () => {
        const f = await extractFromTests(
            scripted([{ ...empty, workflows: [{ name: "Cancel a shipped order", steps: ["Open a shipped order", "Press Cancel"], doc: "manual-case:TC-001", lines: [2, 3], quote: "Open a shipped order" }] }]),
            TESTS,
            { now: NOW },
        );
        expect(f.model.workflows[0]).toMatchObject({ sourceType: "existing_test", evidence: [{ ref: "manual-case:TC-001#L2-L3" }] });
    });

    it("a rule from a test is linked to the workflow the same test states", async () => {
        const f = await extractFromTests(
            scripted([
                {
                    ...empty,
                    workflows: [{ name: "Cancel a shipped order", steps: ["Open a shipped order", "Press Cancel"], doc: "manual-case:TC-001", lines: [2, 3], quote: "Open a shipped order" }],
                    rules: [{ kind: "permission", description: "d", expected: "A shipped order shows that it cannot be cancelled", doc: "manual-case:TC-001", lines: [4], quote: "The page says the order has shipped", confidence: 0.8, workflows: ["Cancel a shipped order"] }],
                },
            ]),
            TESTS,
            { now: NOW },
        );
        expect(f.rules[0]!.workflows).toEqual([f.model.workflows[0]!.id]);
        expect(f.rules[0]!.sourceType).toBe("existing_test");
    });

    it("a rule from a test can be linked to a known workflow passed in", async () => {
        const f = await extractFromTests(
            scripted([{ ...empty, rules: [{ kind: "constraint", description: "d", expected: "Quantities above 10 are refused", doc: "manual-case:TC-002", lines: [3], quote: "The page refuses quantities above 10", confidence: 0.8, workflows: ["wf-buy"] }] }]),
            TESTS,
            { knownWorkflows: [{ id: "wf-buy", name: "Buy a product" }], now: NOW },
        );
        expect(f.rules[0]!.workflows).toEqual(["wf-buy"]);
    });
});

describe("rules from pages", () => {
    it("a page becomes lines with its purpose, controls, field constraints, messages and table headers", () => {
        expect(pageDocument(PAGES[0]!).lines).toEqual([
            "Page /cart",
            "Purpose: The customer's cart with totals",
            'button: "Check out"',
            'Form "Add item"',
            'Field "Quantity" (number; required; min 1; max 10)',
            'Message for "Quantity": Quantity must be between 1 and 10',
            'Table "Items" with columns Product, Price',
        ]);
    });

    it("no page-derived rule is explicit, and page transitions are never expectations", async () => {
        const llm = scripted([
            {
                ...empty,
                rules: [{ kind: "constraint", description: "Quantity", expected: "Quantity is between 1 and 10", doc: "page:/cart", lines: [6], quote: "Quantity must be between 1 and 10", confidence: 1 }],
                transitions: [{ entity: "Cart", from: "open", to: "checked out", trigger: "Check out", doc: "page:/cart", lines: [3], quote: "Check out" }],
            },
        ]);
        const f = await extractFromPages(llm, PAGES, { now: NOW });
        expect(f.rules).toHaveLength(1);
        expect(f.rules.every((r) => r.explicitness === "inferred" && r.sourceType === "inferred")).toBe(true);
        expect(f.model.transitions.every((t) => !t.expectation)).toBe(true);
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
    });

    it("a page-derived rule linked to a known workflow stays inferred", async () => {
        const llm = scripted([{ ...empty, rules: [{ kind: "constraint", description: "Quantity", expected: "Quantity is between 1 and 10", doc: "page:/cart", lines: [6], quote: "Quantity must be between 1 and 10", confidence: 1, workflows: ["wf-buy"] }] }]);
        const f = await extractFromPages(llm, PAGES, { knownWorkflows: [{ id: "wf-buy", name: "Buy a product" }], now: NOW });
        expect(f.rules[0]).toMatchObject({ workflows: ["wf-buy"], explicitness: "inferred", sourceType: "inferred" });
    });

    it("pages unchanged since the last exploration are not sent", async () => {
        const llm = scripted([empty]);
        const f = await extractFromPages(llm, PAGES, { unchanged: new Set(["/about"]), now: NOW });
        expect(llm.prompts.join("\n")).toContain("Page /cart");
        expect(llm.prompts.join("\n")).not.toContain("/about");
        expect(f.notes.join(" ")).toMatch(/1 page has not changed/);
    });

    it("when every page is unchanged, the model is not called at all", async () => {
        const llm = scripted([empty]);
        const f = await extractFromPages(llm, PAGES, { unchanged: new Set(["/cart", "/about"]), now: NOW });
        expect(llm.prompts).toEqual([]);
        expect(f.source.status).toBe("processed");
    });
});
