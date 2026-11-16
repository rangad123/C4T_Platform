/**
 * The understanding benchmark's scorer (src/eval/bench/understanding/score.ts): criteria U1–U7 as pure functions over a model, its
 * rules, an answer key, recorded judgements and run counters. Every expected number below is worked out by hand from the criterion's
 * definition (comments show the count), never taken from a run of the scorer.
 */
import { describe, expect, it } from "vitest";
import { AppModelSchema, ruleFingerprint, type Rule } from "../src/engine/intel/model.js";
import { AnswerKeySchema, type Judgements } from "../src/eval/bench/understanding/answer-key.js";
import {
    defectRuleRecall,
    endpointRecall,
    incremental,
    matchesPath,
    provenance,
    scoreUnderstanding,
    screenRecall,
    workflowRecall,
    wrongRules,
    type ScoredRule,
} from "../src/eval/bench/understanding/score.js";

const key = AnswerKeySchema.parse({
    app: "x-shop",
    version: "1",
    review: "approved",
    catalogueVersion: "test-1",
    requirementsDocument: "x-shop-requirements.md",
    screens: [
        { id: "products", path: "/", name: "Products", signIn: false },
        { id: "product", path: "/products/:id", name: "Product", signIn: false },
        { id: "cart", path: "/cart", name: "Cart", signIn: true },
        { id: "checkout", path: "/checkout", name: "Checkout", signIn: true },
    ],
    workflows: [
        { id: "browse", name: "Browse", screens: ["products", "product"], endpoints: ["GET /api/products", "GET /api/products/:id"] },
        { id: "cart", name: "Change the cart", screens: ["cart"], endpoints: ["GET /api/products", "POST /api/cart/items"] },
        { id: "cart-discount", name: "Apply a code", screens: ["cart"], endpoints: ["POST /api/cart/discount"] },
        { id: "checkout", name: "Place an order", screens: ["checkout"], endpoints: ["POST /api/orders"] },
    ],
    entities: [
        { id: "cart", name: "Cart" },
        { id: "order", name: "Order" },
    ],
    endpoints: [
        { method: "GET", path: "/api/products", documented: true },
        { method: "GET", path: "/api/products/:id", documented: true },
        { method: "POST", path: "/api/cart/items", documented: true },
        { method: "POST", path: "/api/cart/discount", documented: true },
        { method: "POST", path: "/api/orders", documented: true },
        { method: "POST", path: "/login", documented: false },
    ],
    roles: [{ id: "customer", name: "Customer" }],
    rules: [
        { defectId: "XS-01", kind: "calculation", statement: "Subtotal is the sum of the lines.", requirement: { id: "1.1", line: 3 }, workflows: ["cart"], endpoints: ["POST /api/cart/items"], entities: ["cart"] },
        { defectId: "XS-02", kind: "constraint", statement: "No order from an empty cart.", requirement: { id: "1.2", line: 4 }, workflows: ["checkout"], endpoints: ["POST /api/orders"], entities: ["order"] },
        { defectId: "XS-03", kind: "calculation", statement: "SAVE10 takes 10% off.", requirement: { id: "1.3", line: 5 }, workflows: ["cart-discount"], endpoints: ["POST /api/cart/discount"], entities: ["cart"] },
    ],
});
const requirementsText = "# Shop\n\n- 1.1 The cart subtotal is the sum of every line total.\n- 1.2 An order cannot be placed with an empty cart.\n- 1.3 Code SAVE10 takes 10% off the subtotal.\n";
const catalogueWorkflows = ["cart", "cart-discount", "checkout"];

const openapi = (p: string) => [{ kind: "openapi" as const, ref: p }];
const model = AppModelSchema.parse({
    pages: [
        { id: "p1", path: "/" },
        { id: "p2", path: "/products/7" },
        { id: "p3", path: "http://127.0.0.1:9731/cart/?tab=1" },
        { id: "p4", path: "/account" },
    ],
    endpoints: [
        { method: "GET", path: "/api/products", origin: "documented", evidence: openapi("/api/products") },
        { method: "get", path: "/api/products/{id}", origin: "documented", evidence: openapi("/api/products/{id}") },
        { method: "POST", path: "/api/cart/items", origin: "observed", evidence: [{ kind: "page", ref: "/cart" }] },
        { method: "POST", path: "/api/orders", origin: "documented", evidence: openapi("/api/orders") },
        { method: "DELETE", path: "/api/cart", origin: "documented", evidence: openapi("/api/cart") },
    ],
    workflows: [
        { id: "w1", name: "Add to cart", sourceType: "inferred", steps: [{ order: 0, action: "Add", page: "p3", endpoint: "POST /api/cart/items" }] },
        { id: "checkout", name: "Pay", sourceType: "inferred" },
        { id: "w3", name: "Look around", sourceType: "inferred", steps: [{ order: 0, action: "Open", page: "p1" }] },
    ],
    entities: [{ id: "e-cart", name: "Cart" }],
});

const rule = (over: Partial<ScoredRule> & Pick<ScoredRule, "ref">): ScoredRule => ({
    kind: "other",
    description: "d",
    expected: `expected of ${over.ref}`,
    sourceType: "inferred",
    sourceRef: "",
    evidence: [],
    explicitness: "inferred",
    confidence: 0.5,
    entities: [],
    workflows: [],
    endpoints: [],
    status: "unverified",
    decidedBy: null,
    ...over,
});
// R-1: shares the endpoint of XS-01 only; explicit; its quote is the text of line 3.
// R-2: no shared endpoint; its workflow "checkout" identifies the key workflow checkout, whose only rule is XS-02.
// R-3: no shared endpoint or workflow; its entity (Cart) is linked by XS-01 and XS-03: ambiguous.
// R-4: shares the endpoint of XS-02; explicit, but its quote is not line 4 and it does not name 1.2.
const rules: ScoredRule[] = [
    rule({ ref: "R-1", kind: "calculation", sourceType: "requirement", explicitness: "explicit", sourceRef: "requirements", evidence: [{ kind: "quote", ref: "requirements", excerpt: "the cart subtotal is the sum of every  line total" }], endpoints: ["POST /api/cart/items"] }),
    rule({ ref: "R-2", kind: "constraint", evidence: [{ kind: "page", ref: "/checkout" }], workflows: ["checkout"] }),
    rule({ ref: "R-3", evidence: [{ kind: "note", ref: "cart page" }], entities: ["e-cart"] }),
    rule({ ref: "R-4", sourceType: "prd", explicitness: "explicit", sourceRef: "requirements", evidence: [{ kind: "quote", ref: "requirements", excerpt: "Orders ship within a day." }], endpoints: ["POST /api/orders"] }),
];

const judgements = (over: Partial<Judgements> = {}): Judgements => ({
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
    workflowLinks: [],
    reviews: [],
    ...over,
});

describe("path matching", () => {
    it("a key parameter matches any one segment; {id} and :id are the same; origin, query and trailing slash are ignored", () => {
        expect(matchesPath("/products/:id", "/products/7")).toBe(true);
        expect(matchesPath("/products/:id", "/products/{id}")).toBe(true);
        expect(matchesPath("/cart", "http://127.0.0.1:9731/cart/?tab=1")).toBe(true);
        expect(matchesPath("/products/:id", "/products/7/reviews")).toBe(false);
    });
    it("a model parameter does not claim a fixed key segment (/notes/{id} is not /notes/new)", () => {
        expect(matchesPath("/notes/new", "/notes/{id}")).toBe(false);
        expect(matchesPath("/notes/new", "/notes/new")).toBe(true);
    });
});

describe("U1 screen recall", () => {
    it("found / answer-key screens", () => {
        // products ← "/", product ← "/products/7", cart ← ".../cart/?tab=1"; checkout has no page; "/account" is not in the key.
        expect(screenRecall(model, key)).toEqual({ found: 3, total: 4, value: 0.75, missed: ["checkout"] });
    });
});

describe("U2 endpoint recall", () => {
    it("documented operations in the model as documented / documented operations in the key, and documented ones the document lacks", () => {
        // Key documented: 5. In the model as documented: GET /api/products, GET /api/products/:id, POST /api/orders = 3.
        // POST /api/cart/items is only observed; POST /api/cart/discount is absent. DELETE /api/cart is documented but not in the key.
        expect(endpointRecall(model, key)).toEqual({ found: 3, total: 5, value: 0.6, missed: ["POST /api/cart/discount", "POST /api/cart/items"], documentedNotInDocument: ["DELETE /api/cart"] });
    });
});

describe("U3 workflow recall", () => {
    it("catalogue workflows identified by id, or by a model workflow whose writes cover the key workflow's and are mostly its", () => {
        // cart: needs {POST /api/cart/items} (its GET is not a write); w1 writes only that: covered, 1 of 1 → cart.
        // checkout ← model id "checkout". cart-discount: no model workflow writes POST /api/cart/discount.
        expect(workflowRecall(model, key, catalogueWorkflows)).toEqual({ found: 2, total: 3, value: 2 / 3, missed: ["cart-discount"], needsJudgement: [] });
    });
    it("a recorded judgement adds a workflow the deterministic link did not find", () => {
        const j = judgements({ workflowLinks: [{ workflowId: "w3", keyWorkflowId: "cart-discount", reason: "Applies a code." }] });
        expect(workflowRecall(model, key, catalogueWorkflows, j)).toEqual({ found: 3, total: 3, value: 1, missed: [], needsJudgement: [] });
    });
    it("a judgement never moves a model workflow the deterministic link already assigned", () => {
        const j = judgements({ workflowLinks: [{ workflowId: "w1", keyWorkflowId: "cart-discount", reason: "wrong" }] });
        expect(workflowRecall(model, key, catalogueWorkflows, j).missed).toEqual(["cart-discount"]);
    });
    it("a model workflow that touches everything credits at most one key workflow", () => {
        // "shop" writes cart items, the code and the order (3). Each catalogue workflow needs one of them: covered, but it is 1 of the
        // model workflow's 3 writes, not a majority → none credited (before this rule it credited all three).
        const coarse = AppModelSchema.parse({
            workflows: [
                { id: "shop", name: "Shop", sourceType: "inferred", steps: ["POST /api/cart/items", "POST /api/cart/discount", "POST /api/orders"].map((endpoint, order) => ({ order, action: "Do", endpoint })) },
            ],
        });
        const r = workflowRecall(coarse, key, catalogueWorkflows);
        expect(r.found).toBeLessThanOrEqual(1);
        expect(r).toEqual({ found: 0, total: 3, value: 0, missed: ["cart", "cart-discount", "checkout"], needsJudgement: [] });
    });
    it("a model workflow that fits two key workflows equally waits for a recorded judgement", () => {
        // cart and cart-again both need exactly {POST /api/cart/items}; w1 fits both with overlap 1 → tie.
        const tied = AnswerKeySchema.parse({ ...key, workflows: [...key.workflows, { id: "cart-again", name: "Change the cart again", screens: ["cart"], endpoints: ["POST /api/cart/items"] }] });
        expect(workflowRecall(model, tied, catalogueWorkflows)).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["cart", "cart-discount"], needsJudgement: ["w1"] });
        const j = judgements({ workflowLinks: [{ workflowId: "w1", keyWorkflowId: "cart", reason: "Adds items to the cart." }] });
        expect(workflowRecall(model, tied, catalogueWorkflows, j)).toEqual({ found: 2, total: 3, value: 2 / 3, missed: ["cart-discount"], needsJudgement: [] });
    });
    it("a model workflow without endpoint steps is matched on its step pages to a key workflow's screens", () => {
        // w-look opens / and /products/7: browse's screens are products (/) and product (/products/:id), both covered, 2 of 2 pages → browse.
        const looking = AppModelSchema.parse({ ...model, workflows: [{ id: "w-look", name: "Look at products", sourceType: "inferred", steps: [{ order: 0, action: "Open", page: "p1" }, { order: 1, action: "Open", page: "/products/7" }] }] });
        expect(workflowRecall(looking, key, ["browse"])).toEqual({ found: 1, total: 1, value: 1, missed: [], needsJudgement: [] });
    });
    it("screens follow the one-to-one rule: a tie on screens waits for a recorded workflow link", () => {
        // w-cart opens only /cart: cart and cart-discount both have the one screen cart → tie, nothing credited until a link is recorded.
        const onCart = AppModelSchema.parse({ ...model, workflows: [{ id: "w-cart", name: "Cart page", sourceType: "inferred", steps: [{ order: 0, action: "Open", page: "p3" }] }] });
        expect(workflowRecall(onCart, key, catalogueWorkflows)).toEqual({ found: 0, total: 3, value: 0, missed: ["cart", "cart-discount", "checkout"], needsJudgement: ["w-cart"] });
        const j = judgements({ workflowLinks: [{ workflowId: "w-cart", keyWorkflowId: "cart-discount", reason: "Applies a code on the cart page." }] });
        expect(workflowRecall(onCart, key, catalogueWorkflows, j)).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["cart", "checkout"], needsJudgement: [] });
    });
});

describe("U4 defect-rule recall", () => {
    it("deterministic links first; a rule matching several key rules waits for a judgement", () => {
        const r = defectRuleRecall(model, rules, key, { requirementsText });
        // XS-01 ← R-1 (endpoint); XS-02 ← R-2 (workflow) and R-4 (endpoint); XS-03: R-3 is ambiguous (XS-01, XS-03).
        expect(r.any).toEqual({ found: 2, total: 3, value: 2 / 3, missed: ["XS-03"] });
        expect(r.needsJudgement).toEqual(["R-3"]);
        expect(r.links).toEqual({ "R-1": "XS-01", "R-2": "XS-02", "R-4": "XS-02" });
    });
    it("explicit and citing the requirement line: only R-1 (its quote is line 3); R-4's quote is not line 4", () => {
        expect(defectRuleRecall(model, rules, key, { requirementsText }).explicitCiting).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["XS-02", "XS-03"] });
    });
    it("an explicit rule citing the requirement by its id counts as citing", () => {
        const byId = [rule({ ref: "R-9", sourceType: "requirement", explicitness: "explicit", evidence: [{ kind: "quote", ref: "requirements 1.2" }], endpoints: ["POST /api/orders"] })];
        expect(defectRuleRecall(model, byId, key, { requirementsText }).explicitCiting.found).toBe(1);
    });
    it("first by the requirement the rule cites, when its wording matches the key rule: no endpoint needed", () => {
        // R-20 cites 1.3 by its line id and states SAVE10 off the subtotal; its entity (Cart) alone would be ambiguous (XS-01, XS-03).
        // Key words of XS-03: save10, take, 10, off; all 4 are in the rule → linked to XS-03.
        const cited = [rule({ ref: "R-20", sourceType: "requirement", explicitness: "explicit", description: "SAVE10 takes 10% off the cart subtotal", evidence: [{ kind: "quote", ref: "1.3#L1", excerpt: "Code SAVE10 takes 10% off the subtotal." }], entities: ["e-cart"] })];
        const r = defectRuleRecall(model, cited, key, { requirementsText });
        expect(r.links).toEqual({ "R-20": "XS-03" });
        expect(r.needsJudgement).toEqual([]);
        expect(r.explicitCiting).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["XS-01", "XS-02"] });
    });
    it("the cited requirement comes before a shared endpoint", () => {
        // R-21 quotes line 3 (1.1) and states the subtotal rule, but names the order endpoint of XS-02: the citation wins → XS-01.
        const cited = [rule({ ref: "R-21", sourceType: "requirement", explicitness: "explicit", description: "The subtotal is the sum of every line", evidence: [{ kind: "quote", ref: "requirements", excerpt: "The cart subtotal is the sum of every line total." }], endpoints: ["POST /api/orders"] })];
        expect(defectRuleRecall(model, cited, key, { requirementsText }).links).toEqual({ "R-21": "XS-01" });
    });
    it("a rule citing the requirement in other words is not linked by the citation", () => {
        // R-22 cites 1.3 but says something else: key words found 1 of 4 (save10) → below half; the entity tier is ambiguous → judgement.
        const other = [rule({ ref: "R-22", sourceType: "requirement", explicitness: "explicit", description: "Discount codes ignore letter case", expected: "save10 and Save10 both work", evidence: [{ kind: "quote", ref: "1.3#L1" }], entities: ["e-cart"] })];
        const r = defectRuleRecall(model, other, key, { requirementsText });
        expect(r.links).toEqual({});
        expect(r.needsJudgement).toEqual(["R-22"]);
    });
    it("a recorded judgement settles an ambiguous rule, but never overrides a deterministic link", () => {
        const j = judgements({ links: [ { ruleRef: "R-3", defectId: "XS-03", reason: "Discount on the cart." }, { ruleRef: "R-1", defectId: "XS-02", reason: "wrong" } ] });
        const r = defectRuleRecall(model, rules, key, { requirementsText, judgements: j });
        expect(r.any).toEqual({ found: 3, total: 3, value: 1, missed: [] });
        expect(r.links["R-1"]).toBe("XS-01");
        expect(r.needsJudgement).toEqual([]);
    });
    it("a linked rule without evidence or a source reference does not count", () => {
        const bare = [rule({ ref: "R-5", endpoints: ["POST /api/cart/discount"] })];
        const r = defectRuleRecall(model, bare, key, { requirementsText });
        expect(r.links).toEqual({ "R-5": "XS-03" });
        expect(r.any.found).toBe(0);
    });
});

describe("U5 provenance integrity", () => {
    it("complete provenance / rules; confirmed without a person and observed-sourced rules listed", () => {
        const rs = [
            rule({ ref: "A", evidence: [{ kind: "page", ref: "/" }] }),
            rule({ ref: "B" }), // no evidence, no reference
            rule({ ref: "C", sourceRef: "doc", status: "confirmed", decidedBy: null }),
            rule({ ref: "D", sourceRef: "doc", status: "confirmed", decidedBy: "person-1" }),
            rule({ ref: "E", sourceRef: "doc", sourceType: "requirement" }), // explicitness says inferred: wrong for a requirement
            { ...rule({ ref: "F", sourceRef: "page" }), sourceType: "observed" as Rule["sourceType"] },
        ];
        // complete: A, C, D = 3 of 6 (F is observed, not a source of expected behaviour).
        expect(provenance(rs)).toEqual({ found: 3, total: 6, value: 0.5, missed: ["B", "E", "F"], confirmedWithoutPerson: ["C"], fromObserved: ["F"] });
    });
});

describe("U6 wrong rules", () => {
    it("explicit rules contradicting their source / reviewed explicit rules; inferred ones against the key reported apart; unreviewed listed", () => {
        const j = judgements({ reviews: [ { ruleRef: "R-1", verdict: "consistent", note: "" }, { ruleRef: "R-4", verdict: "contradicts", note: "" }, { ruleRef: "R-2", verdict: "contradicts", note: "" } ] });
        expect(wrongRules(rules, j)).toEqual({
            explicit: { total: 2, reviewed: 2, contradicting: 1, rate: 0.5, unreviewed: [] },
            inferred: { total: 2, reviewed: 1, contradicting: 1, rate: 1, unreviewed: ["R-3"] }, // rate = contradicting / reviewed
        });
    });
    it("no judgements: nothing reviewed, no rate", () => {
        expect(wrongRules(rules).explicit).toEqual({ total: 2, reviewed: 0, contradicting: 0, rate: null, unreviewed: ["R-1", "R-4"] });
    });
});

describe("U7 incremental", () => {
    const before = [rule({ ref: "R-1", status: "confirmed", decidedBy: "p" }), rule({ ref: "R-2", status: "rejected", decidedBy: "p" }), rule({ ref: "R-3" })];
    it("decisions carried forward by fingerprint; a rerun with no change makes no version and no AI call; only the changed source is re-processed", () => {
        // R-1 keeps its expectation and status (new ref, same fingerprint); R-2 comes back unverified: 1 of 2 decisions carried.
        const after = [rule({ ref: "R-10", expected: "expected of R-1", status: "confirmed", decidedBy: "p" }), rule({ ref: "R-2" }), rule({ ref: "R-3" })];
        expect(ruleFingerprint(after[0])).toBe(ruleFingerprint(before[0]));
        const r = incremental({ before, after, noChange: { newVersion: false, aiCallsForUnchangedSources: 0 }, oneChanged: { changed: ["openapi"], reprocessed: ["openapi", "requirements"] } });
        expect(r.decisions).toEqual({ found: 1, total: 2, value: 0.5, missed: ["R-2"] });
        expect(r.noChange).toEqual({ newVersion: false, aiCallsForUnchangedSources: 0, ok: true });
        expect(r.oneChanged).toEqual({ extra: ["requirements"], missing: [], ok: false });
    });
    it("a rerun with no change that made a version or an AI call is not ok", () => {
        expect(incremental({ before, after: before, noChange: { newVersion: true, aiCallsForUnchangedSources: 0 } }).noChange?.ok).toBe(false);
        expect(incremental({ before, after: before, noChange: { newVersion: false, aiCallsForUnchangedSources: 2 } }).noChange?.ok).toBe(false);
    });
});

describe("the whole score", () => {
    it("refuses judgements recorded for another app or another answer key", () => {
        const base = { model, rules, key, keySha256: "b".repeat(64), catalogueWorkflows, requirementsText };
        expect(() => scoreUnderstanding({ ...base, judgements: judgements({ app: "y-shop" }) })).toThrow(/y-shop/);
        expect(() => scoreUnderstanding({ ...base, judgements: judgements({ answerKeySha256: "c".repeat(64) }) })).toThrow(/answer key/);
        const s = scoreUnderstanding({ ...base, judgements: judgements() });
        expect([s.screens.value, s.endpoints.value, s.workflows.value, s.defectRules.any.value]).toEqual([0.75, 0.6, 2 / 3, 2 / 3]);
    });
});
