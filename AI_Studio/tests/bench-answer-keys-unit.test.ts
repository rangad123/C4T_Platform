/**
 * The understanding benchmark's answer keys (src/eval/bench/answers/*.json) and recorded judgements: their schema, and the checks that
 * keep a key complete against the defect catalogue and keep the requirements documents (src/eval/bench/inputs/*) free of the answers.
 * Pure: reads files, starts no app, platform or model.
 */
import { describe, expect, it } from "vitest";
import { loadCatalogue, parseCatalogue } from "../src/eval/bench/catalogue.js";
import { ANSWERS_DIR, INPUTS_DIR, checkAnswerKeys, parseAnswerKey, parseJudgements, readBenchFiles, requireApprovedKey } from "../src/eval/bench/understanding/answer-key.js";

const catalogue = parseCatalogue(
    JSON.stringify({
        version: "test-1",
        defects: [
            { id: "XS-01", app: "x-shop", workflow: "cart", category: "calculation", severity: "high", actual: "The subtotal leaves out the last line." },
            { id: "XS-02", app: "x-shop", workflow: "checkout", category: "boundary", severity: "low", actual: "An empty cart can be ordered." },
        ],
    }),
);

const sampleKey = () => ({
    app: "x-shop",
    version: "1",
    review: "awaiting-owner",
    catalogueVersion: "test-1",
    requirementsDocument: "x-shop-requirements.md",
    screens: [
        { id: "cart", path: "/cart", name: "Cart", signIn: true },
        { id: "checkout", path: "/checkout", name: "Checkout", signIn: true },
    ],
    workflows: [
        { id: "cart", name: "Change the cart", screens: ["cart"], endpoints: ["POST /api/cart/items"] },
        { id: "checkout", name: "Place an order", screens: ["checkout"], endpoints: ["POST /api/orders"] },
    ],
    entities: [{ id: "order", name: "Order", fields: ["id", "total"] }],
    endpoints: [
        { method: "POST", path: "/api/cart/items", documented: true },
        { method: "POST", path: "/api/orders", documented: true },
    ],
    roles: [{ id: "customer", name: "Customer" }],
    rules: [
        { defectId: "XS-01", kind: "calculation", statement: "The subtotal is the sum of the line totals.", requirement: { id: "1.1", line: 3 }, workflows: ["cart"] },
        { defectId: "XS-02", kind: "constraint", statement: "An order needs at least one item.", requirement: { id: "1.2", line: 4 }, workflows: ["checkout"], endpoints: ["POST /api/orders"], entities: ["order"] },
    ],
});
const doc = "# Shop requirements\n\n- 1.1 The cart subtotal is the sum of every line total.\n- 1.2 An order cannot be placed with an empty cart.\n";
const keyFile = (k: unknown, file = "x-shop.json") => ({ file, text: JSON.stringify(k) });
const inputs = [{ file: "x-shop-requirements.md", text: doc }];
const check = (k: unknown, ins = inputs) => checkAnswerKeys({ catalogue, keys: [keyFile(k)], inputs: ins });

describe("the answer keys in the repository", () => {
    it("are complete and the requirements documents do not give them away (passes with no keys present)", () => {
        const problems = checkAnswerKeys({ catalogue: loadCatalogue(), keys: readBenchFiles(ANSWERS_DIR, ".json"), inputs: readBenchFiles(INPUTS_DIR, ".md") });
        expect(problems).toEqual([]);
    });
});

describe("a complete sample key", () => {
    it("has no problems", () => {
        expect(check(sampleKey())).toEqual([]);
    });
    it("parses, with the sha256 of its text so a score names the key it used", () => {
        const text = JSON.stringify(sampleKey());
        const parsed = parseAnswerKey(text, "x-shop.json");
        expect(parsed.key.rules.map((r) => r.defectId)).toEqual(["XS-01", "XS-02"]);
        expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("completeness against the catalogue", () => {
    it("a catalogue defect without a rule is a problem", () => {
        const k = sampleKey();
        k.rules = k.rules.filter((r) => r.defectId !== "XS-02");
        expect(check(k).join("\n")).toMatch(/XS-02.*no rule/);
    });
    it("two rules for one defect is a problem", () => {
        const k = sampleKey();
        k.rules.push({ ...k.rules[0] });
        expect(check(k).join("\n")).toMatch(/XS-01.*2 rules/);
    });
    it("a rule for a defect of another app, or one not in the catalogue, is a problem", () => {
        const k = sampleKey();
        k.rules.push({ ...k.rules[0], defectId: "XS-99" });
        expect(check(k).join("\n")).toMatch(/XS-99.*not a catalogue defect/);
    });
    it("a catalogue workflow missing from the key is a problem", () => {
        const k = sampleKey();
        k.workflows = k.workflows.filter((w) => w.id !== "checkout");
        expect(check(k).join("\n")).toMatch(/workflow “checkout”/);
    });
    it("a rule that does not link the workflow its defect sits in is a problem", () => {
        const k = sampleKey();
        k.rules[1].workflows = ["cart"];
        expect(check(k).join("\n")).toMatch(/XS-02.*checkout/);
    });
    it("a key written against another catalogue version is a problem", () => {
        expect(check({ ...sampleKey(), catalogueVersion: "test-0" }).join("\n")).toMatch(/catalogue version/);
    });
    it("a key whose file name is not its app is a problem", () => {
        expect(checkAnswerKeys({ catalogue, keys: [keyFile(sampleKey(), "shop.json")], inputs }).join("\n")).toMatch(/shop\.json/);
    });
});

describe("the key's own consistency", () => {
    it("a link to a workflow, endpoint, entity, screen or role the key does not list is refused", () => {
        const bad = [
            (k: ReturnType<typeof sampleKey>) => (k.rules[0].workflows = ["cart", "returns"]),
            (k: ReturnType<typeof sampleKey>) => (k.rules[1].endpoints = ["DELETE /api/orders"]),
            (k: ReturnType<typeof sampleKey>) => (k.rules[1].entities = ["invoice"]),
            (k: ReturnType<typeof sampleKey>) => (k.workflows[0].screens = ["wishlist"]),
            (k: ReturnType<typeof sampleKey>) => ((k.screens[0] as { roles?: string[] }).roles = ["auditor"]),
        ];
        for (const edit of bad) {
            const k = sampleKey();
            edit(k);
            expect(check(k).join("\n")).toMatch(/does not list/);
        }
    });
    it("a duplicate id is refused", () => {
        const k = sampleKey();
        k.screens.push({ ...k.screens[0] });
        expect(check(k).join("\n")).toMatch(/twice/);
    });
    it("an unknown field is refused (a typo would otherwise go unscored)", () => {
        expect(check({ ...sampleKey(), screen: [] }).join("\n")).toMatch(/screen/);
    });
    it("a rule must cite a line of the requirements document that has text", () => {
        const k = sampleKey();
        k.rules[0].requirement.line = 2;
        expect(check(k).join("\n")).toMatch(/line 2.*blank/);
        k.rules[0].requirement.line = 40;
        expect(check(k).join("\n")).toMatch(/line 40.*only 4 lines/);
    });
    it("the cited line must be the requirement the rule names by id (ids are stable, lines are checked)", () => {
        const k = sampleKey();
        k.rules[0].requirement = { id: "1.2", line: 3 };
        expect(check(k).join("\n")).toMatch(/XS-01.*line 3.*not requirement 1\.2/);
        k.rules[0].requirement = { id: "1.1", line: 3 };
        expect(check(k)).toEqual([]);
    });
    it("a requirement id is dotted numbers", () => {
        const k = sampleKey();
        k.rules[0].requirement.id = "one";
        expect(check(k).join("\n")).toMatch(/requirement\.id/);
    });
    it("a key whose requirements document is missing is a problem", () => {
        expect(check(sampleKey(), []).join("\n")).toMatch(/x-shop-requirements\.md.*not in/);
    });
});

describe("owner review of a key", () => {
    it("a key awaiting the owner is fine for checks but refused for a measured run", () => {
        const awaiting = parseAnswerKey(JSON.stringify(sampleKey()), "x-shop.json").key;
        expect(check(sampleKey())).toEqual([]);
        expect(() => requireApprovedKey(awaiting, "x-shop.json")).toThrow(/x-shop\.json.*not approved/);
    });
    it("an approved key is accepted for a measured run", () => {
        const approved = parseAnswerKey(JSON.stringify({ ...sampleKey(), review: "approved" }), "x-shop.json").key;
        expect(() => requireApprovedKey(approved, "x-shop.json")).not.toThrow();
    });
    it("review is required and only awaiting-owner or approved", () => {
        const { review: _r, ...noReview } = sampleKey();
        expect(check(noReview).join("\n")).toMatch(/review/);
        expect(check({ ...sampleKey(), review: "reviewed" }).join("\n")).toMatch(/review/);
    });
});

describe("requirements documents never give the answers away", () => {
    const leaks = (text: string) => check(sampleKey(), [{ file: "x-shop-requirements.md", text: doc + text }]).join("\n");
    it("a defect id is a problem, in any case", () => {
        expect(leaks("See xs-01.\n")).toMatch(/XS-01/);
    });
    it("a catalogue actual-behaviour text is a problem, whatever the spacing and case", () => {
        expect(leaks("Note: the  subtotal leaves out\nthe last line.\n")).toMatch(/actual behaviour of XS-01/);
    });
    it("an answer-key file name is a problem", () => {
        expect(leaks("Scored with x-shop.json.\n")).toMatch(/x-shop\.json/);
    });
    it("a document is checked even when no key exists yet", () => {
        expect(checkAnswerKeys({ catalogue, keys: [], inputs: [{ file: "notes.md", text: "XS-02 is known." }] }).join("\n")).toMatch(/notes\.md.*XS-02/);
    });
});

describe("recorded judgements", () => {
    const judgements = () => ({
        app: "x-shop",
        inputs: "full",
        engine: "candidate",
        trial: 1,
        modelVersion: 3,
        answerKeySha256: "a".repeat(64),
        recordedBy: "lead",
        ownerReviewed: false,
        recordedAt: "2026-11-16T10:00:00.000Z",
        links: [
            { ruleRef: "R-4", defectId: "XS-01", reason: "States the subtotal rule in other words." },
            { ruleRef: "R-7", defectId: null, reason: "About shipping, not a seeded defect." },
        ],
        reviews: [{ ruleRef: "R-4", verdict: "consistent", note: "" }],
    });
    it("parse", () => {
        const j = parseJudgements(JSON.stringify(judgements()));
        expect(j.links.map((l) => l.defectId)).toEqual(["XS-01", null]);
        expect(j.reviews[0].verdict).toBe("consistent");
    });
    it("one rule judged twice is refused", () => {
        const j = judgements();
        j.links.push({ ...j.links[0] });
        expect(() => parseJudgements(JSON.stringify(j))).toThrow(/R-4.*twice/);
    });
    it("a link needs a reason, and a verdict is consistent or contradicts", () => {
        const j = judgements();
        j.links[0].reason = "";
        expect(() => parseJudgements(JSON.stringify(j))).toThrow(/reason/);
        const k = judgements();
        k.reviews[0].verdict = "maybe";
        expect(() => parseJudgements(JSON.stringify(k))).toThrow(/verdict/);
    });
    it("one model workflow judged twice is refused", () => {
        const link = { workflowId: "w-2", keyWorkflowId: "cart", reason: "Adds items." };
        expect(() => parseJudgements(JSON.stringify({ ...judgements(), workflowLinks: [link, { ...link, keyWorkflowId: null }] }))).toThrow(/w-2.*twice/);
    });
    it("an AI judge is not a recorder", () => {
        expect(() => parseJudgements(JSON.stringify({ ...judgements(), recordedBy: "model" }))).toThrow(/recordedBy/);
    });
});
