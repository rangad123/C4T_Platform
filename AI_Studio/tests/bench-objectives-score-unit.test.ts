/**
 * E5 objective coverage (src/eval/bench/understanding/objectives-score.ts, fast tier, pure): over one stored model version, its rules and
 * an answer key, the share of explicit or confirmed rules with a checkable expected result that at least one objective cites, and the
 * share of catalogue workflows identified (as U3 identifies them) by a model workflow that has a workflow objective. The objectives are
 * built from the model alone: the answer key never reaches `objectivesFrom`. Every expected number is worked out by hand below.
 */
import { describe, expect, it } from "vitest";
import { objectivesFrom } from "../src/engine/explore/objectives.js";
import { AppModelSchema } from "../src/engine/intel/model.js";
import { AnswerKeySchema, type Judgements } from "../src/eval/bench/understanding/answer-key.js";
import { objectiveCoverage } from "../src/eval/bench/understanding/objectives-score.js";
import type { ScoredRule } from "../src/eval/bench/understanding/score.js";

const key = AnswerKeySchema.parse({
    app: "x-shop",
    version: "1",
    review: "approved",
    catalogueVersion: "test-1",
    requirementsDocument: "x-shop-requirements.md",
    screens: [
        { id: "products", path: "/", name: "Products", signIn: false },
        { id: "cart", path: "/cart", name: "Cart", signIn: true },
        { id: "checkout", path: "/checkout", name: "Checkout", signIn: true },
    ],
    workflows: [
        { id: "browse", name: "Browse", screens: ["products"], endpoints: ["GET /api/products"] },
        { id: "cart", name: "Change the cart", screens: ["cart"], endpoints: ["GET /api/products", "POST /api/cart/items"] },
        { id: "cart-discount", name: "Apply a code", screens: ["cart"], endpoints: ["POST /api/cart/discount"] },
        { id: "checkout", name: "Place an order", screens: ["checkout"], endpoints: ["POST /api/orders"] },
    ],
    endpoints: [
        { method: "GET", path: "/api/products", documented: true },
        { method: "POST", path: "/api/cart/items", documented: true },
        { method: "POST", path: "/api/cart/discount", documented: true },
        { method: "POST", path: "/api/orders", documented: true },
    ],
    rules: [
        { defectId: "XS-01", kind: "calculation", statement: "KEYONLY subtotal is the sum of the lines.", requirement: { id: "1.1", line: 3 }, workflows: ["cart"] },
        { defectId: "XS-02", kind: "constraint", statement: "KEYONLY no order from an empty cart.", requirement: { id: "1.2", line: 4 }, workflows: ["checkout"] },
        { defectId: "XS-03", kind: "calculation", statement: "KEYONLY SAVE10 takes 10% off.", requirement: { id: "1.3", line: 5 }, workflows: ["cart-discount"] },
    ],
});
const catalogueWorkflows = ["cart", "cart-discount", "checkout"];

// w-add: stated by a requirement; its one write is the key workflow cart's write -> identifies cart; a workflow objective.
// w-code: identifies cart-discount by its write, but only inferred -> a workflow objective that is not stated (ranked last).
// checkout: identifies checkout by id; stated by a prd -> a workflow objective.
const modelOf = (codeSource: "inferred" | "requirement") =>
    AppModelSchema.parse({
        pages: [
            { id: "p1", path: "/" },
            { id: "p2", path: "/cart", forms: [{ name: "code", fields: [{ name: "code", required: true }] }] },
            { id: "p3", path: "/checkout" },
        ],
        workflows: [
            { id: "w-add", name: "Add to cart", sourceType: "requirement", evidence: [{ kind: "quote", ref: "1.1" }], steps: [{ order: 0, action: "Add", page: "p2", endpoint: "POST /api/cart/items" }] },
            { id: "w-code", name: "Use a code", sourceType: codeSource, evidence: [{ kind: "quote", ref: "1.3" }], steps: [{ order: 0, action: "Apply", page: "p2", endpoint: "POST /api/cart/discount" }] },
            { id: "checkout", name: "Pay", sourceType: "prd", evidence: [{ kind: "quote", ref: "1.2" }], steps: [{ order: 0, action: "Pay", page: "p3", endpoint: "POST /api/orders" }] },
        ],
    });
const model = modelOf("inferred");

const rule = (over: Partial<ScoredRule> & Pick<ScoredRule, "ref">): ScoredRule => ({
    kind: "other",
    description: `Rule ${over.ref}`,
    expected: `Expected result of ${over.ref}`,
    sourceType: "requirement",
    sourceRef: "requirements",
    evidence: [{ kind: "quote", ref: "1.1" }],
    explicitness: "explicit",
    confidence: 0.9,
    entities: [],
    workflows: [],
    endpoints: [],
    status: "unverified",
    decidedBy: null,
    ...over,
});
// Counted (3): R-1 explicit; R-2 inferred but confirmed by a person; R-8 explicit and confirmed.
// Not counted: R-3 an unconfirmed guess; R-4 rejected; R-5 evidence gone; R-6 "TBD" and R-7 "-" say nothing checkable.
const rules: ScoredRule[] = [
    rule({ ref: "R-1" }),
    rule({ ref: "R-2", sourceType: "inferred", explicitness: "inferred", status: "confirmed", decidedBy: "lead" }),
    rule({ ref: "R-3", sourceType: "inferred", explicitness: "inferred" }),
    rule({ ref: "R-4", status: "rejected", decidedBy: "lead" }),
    rule({ ref: "R-5", evidenceGone: { version: 2, at: "2026-11-16T10:00:00.000Z" } }),
    rule({ ref: "R-6", expected: "TBD" }),
    rule({ ref: "R-7", expected: "-" }),
    rule({ ref: "R-8", status: "confirmed", decidedBy: "owner" }),
];

describe("E5 objective coverage", () => {
    it("counts the rules a person may rely on that an objective cites, and the catalogue workflows a workflow objective covers", () => {
        const c = objectiveCoverage({ model, rules, key, catalogueWorkflows });
        expect(c.rules).toEqual({ found: 3, total: 3, value: 1, missed: [] });
        // cart (w-add) and checkout are covered; cart-discount is identified only by an inferred workflow, whose objective is not stated.
        expect(c.workflows).toEqual({ found: 3, total: 3, value: 1, missed: [] });
        expect(c.met).toBe(true);
        // Objectives: rules R-1, R-2, R-8; workflows w-add, checkout and the inferred one; one constraint (the required code field). None left out by a cap.
        expect(c.objectives).toEqual({ total: 7, overCap: 0, byKind: { rule: 3, workflow: 3, constraint: 1, transition: 0, "coverage-gap": 0 } });
    });

    it("is met when every counted rule and every catalogue workflow has its objective", () => {
        const c = objectiveCoverage({ model: modelOf("requirement"), rules, key, catalogueWorkflows });
        expect(c.workflows).toEqual({ found: 3, total: 3, value: 1, missed: [] });
        expect(c.met).toBe(true);
    });

    it("a rule or workflow without an objective is missed and named", () => {
        // Objectives that cite only R-1 and only the model workflow checkout.
        const few = ((m, r, w, o) => {
            const all = objectivesFrom(m, r, w, o).objectives;
            return { objectives: all.filter((x) => (x.kind === "rule" && x.source.ref === "R-1") || (x.kind === "workflow" && x.source.ref === "checkout")), overCap: 0 };
        }) as typeof objectivesFrom;
        const c = objectiveCoverage({ model: modelOf("requirement"), rules, key, catalogueWorkflows }, few);
        expect(c.rules).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["R-2", "R-8"] });
        expect(c.workflows).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["cart", "cart-discount"] });
        expect(c.met).toBe(false);
    });

    it("a workflow objective covers a catalogue workflow only through a model workflow that identifies it", () => {
        // A rule objective citing the id of the key workflow cart is not a workflow objective, and a workflow objective for a workflow the
        // key does not have covers nothing.
        // A real objective to copy (the constraint on the code field), relabelled.
        const base = objectivesFrom(model, [], [], { maxObjectives: 1, budget: { steps: 1, minutes: 1, tokens: 1000 } }).objectives[0]!;
        const wrong = (() => ({
            objectives: [
                { ...base, kind: "rule" as const, source: { ref: "cart" } },
                { ...base, kind: "workflow" as const, source: { ref: "w-elsewhere" } },
            ],
            overCap: 0,
        })) as unknown as typeof objectivesFrom;
        const c = objectiveCoverage({ model: modelOf("requirement"), rules, key, catalogueWorkflows }, wrong);
        expect(c.workflows.found).toBe(0);
    });

    it("a recorded workflow link counts as U3 counts it", () => {
        // w-vague names no page or endpoint; the owner linked it to cart-discount.
        const m = AppModelSchema.parse({ ...model, workflows: [...model.workflows.filter((w) => w.id !== "w-code"), { id: "w-vague", name: "Vague", sourceType: "requirement", evidence: [{ kind: "quote", ref: "1.3" }], steps: [{ order: 0, action: "Do it" }] }] });
        const j: Judgements = {
            app: "x-shop",
            inputs: "full",
            engine: "candidate",
            trial: 1,
            modelVersion: 1,
            answerKeySha256: "b".repeat(64),
            recordedBy: "lead",
            ownerReviewed: false,
            recordedAt: "2026-11-16T10:00:00.000Z",
            links: [],
            workflowLinks: [{ workflowId: "w-vague", keyWorkflowId: "cart-discount", reason: "applies a code" }],
            reviews: [],
        };
        expect(objectiveCoverage({ model: m, rules, key, catalogueWorkflows }).workflows.missed).toEqual(["cart-discount"]);
        expect(objectiveCoverage({ model: m, rules, key, catalogueWorkflows, judgements: j }).workflows).toEqual({ found: 3, total: 3, value: 1, missed: [] });
    });

    it("reports the active requirements a counted rule cites, by source ref or evidence, as a line apart from met", () => {
        const more = [...rules, rule({ ref: "R-9", status: "rejected", decidedBy: "lead", evidence: [{ kind: "quote", ref: "1.12" }] }), rule({ ref: "R-10", sourceRef: "requirements 2.3", evidence: [] })];
        const c = objectiveCoverage({ model, rules: more, key, catalogueWorkflows, requirements: ["1.1", "1.12", "1.2", "2.3", "1.1"] });
        // 1.1 (R-1, R-2, R-8 evidence) and 2.3 (R-10's source ref) are cited; 1.12 only by a rejected rule; 1.2 by none ("1.1" is not "1.12").
        expect(c.requirements).toEqual({ found: 2, total: 4, value: 0.5, missed: ["1.12", "1.2"] });
        expect(c.met).toBe(true);
        expect(objectiveCoverage({ model, rules, key, catalogueWorkflows }).requirements).toBeUndefined();
    });

    it("the objectives are built once, from the stored model, its rules and its workflows: nothing of the answer key reaches them", () => {
        const calls: unknown[][] = [];
        const spy = ((...args: Parameters<typeof objectivesFrom>) => {
            calls.push(args);
            return objectivesFrom(...args);
        }) as typeof objectivesFrom;
        objectiveCoverage({ model, rules, key, catalogueWorkflows }, spy);
        expect(calls).toHaveLength(1);
        const [m, r, w] = calls[0] as Parameters<typeof objectivesFrom>;
        expect(m).toBe(model);
        expect(r.map((x) => x.ref)).toEqual(rules.map((x) => x.ref));
        expect(w.map((x) => x.id)).toEqual(model.workflows.map((x) => x.id));
        const sent = JSON.stringify(calls[0]);
        for (const k of key.rules) {
            expect(sent).not.toContain(k.defectId);
            expect(sent).not.toContain(k.statement);
        }
        expect(sent).not.toContain("KEYONLY");
        expect(sent).not.toContain("cart-discount");
        expect(sent).not.toContain("Change the cart");
    });
});
