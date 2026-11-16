/**
 * Carrying rule decisions from one analysis to the next. Pure (fast tier).
 *
 * Expected values come from the versioning rules: a rule is matched across analyses by its fingerprint (kind, what it expects, what it
 * is linked to); a person's confirm or reject decision carries forward; a rule whose evidence disappeared is kept and marked "evidence
 * gone", never deleted and never confirmed by the system; every new rule starts unverified, whatever the extraction claimed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { carryForward, type PreviousRule } from "../src/engine/intel/carry-forward.js";
import { RuleSchema, ruleFingerprint, type Rule } from "../src/engine/intel/model.js";

const rule = (over: Record<string, unknown> = {}): Rule =>
    RuleSchema.parse({
        ref: "R-1",
        kind: "constraint",
        description: "Quantity limit",
        expected: "The quantity is between 1 and 10.",
        sourceType: "requirement",
        sourceRef: "requirements.md:12",
        explicitness: "explicit",
        confidence: 0.9,
        entities: ["cart", "item"],
        workflows: ["checkout"],
        ...over,
    });

const stored = (r: Rule, id: string, status: PreviousRule["status"], over: Partial<PreviousRule> = {}): PreviousRule => ({ ...r, id, status, fingerprint: ruleFingerprint(r), ...over });
const MARK = { version: 7, at: "2026-11-16T10:00:00Z" };

describe("carryForward", () => {
    const quantity = rule();
    const refund = rule({ ref: "R-2", kind: "calculation", description: "Refund", expected: "A refund returns the full amount." });
    const guest = rule({ ref: "R-3", kind: "permission", description: "Guests", expected: "Guests cannot check out." });
    const previous = [stored(quantity, "id-1", "confirmed"), stored(refund, "id-2", "rejected"), stored(guest, "id-3", "unverified")];

    it("carries every decision when the fingerprints match, even when wording, ref, source and link order changed", () => {
        const next = [
            rule({ ref: "R-7", description: "Cart quantity", expected: "  The quantity is between 1   and 10. ", entities: ["item", "cart"], confidence: 0.6 }),
            rule({ ref: "R-8", kind: "calculation", description: "Refunds", expected: "A refund returns the full amount.", sourceType: "existing_test", sourceRef: "refund.spec.ts:4" }),
            rule({ ref: "R-9", kind: "permission", description: "Guest checkout", expected: "Guests cannot check out." }),
        ];
        const { rules, summary } = carryForward(previous, next, MARK);
        expect(rules.map((r) => [r.id, r.ref, r.status])).toEqual([
            ["id-1", "R-1", "confirmed"],
            ["id-2", "R-2", "rejected"],
            ["id-3", "R-3", "unverified"],
        ]);
        // The new analysis's wording and evidence are kept; nothing is marked gone.
        expect(rules.map((r) => r.description)).toEqual(["Cart quantity", "Refunds", "Guest checkout"]);
        expect(rules[1]!.sourceRef).toBe("refund.spec.ts:4");
        expect(rules.every((r) => r.evidenceGone === undefined)).toBe(true);
        expect(summary).toEqual({ carried: 2, added: 0, evidenceGone: 0 });
    });

    it("keeps a new rule unverified even when the extraction claims it is confirmed", () => {
        const claimed = { ...rule({ ref: "R-20", expected: "Totals include tax." }), status: "confirmed", decidedBy: "model" } as unknown as Rule;
        const { rules, summary } = carryForward([], [claimed], MARK);
        expect(rules).toHaveLength(1);
        expect(rules[0]!.status).toBe("unverified");
        expect(rules[0]!.id).toBeUndefined();
        expect("decidedBy" in rules[0]!).toBe(false);
        expect(rules[0]!.fingerprint).toBe(ruleFingerprint(claimed));
        expect(summary).toEqual({ carried: 0, added: 1, evidenceGone: 0 });
    });

    it("keeps a rule whose evidence disappeared, marks it for a person and leaves its decision as it was", () => {
        const { rules, summary } = carryForward(previous, [quantity], MARK);
        expect(rules.map((r) => r.id)).toEqual(["id-1", "id-2", "id-3"]);
        expect(rules.map((r) => [r.status, r.evidenceGone])).toEqual([
            ["confirmed", undefined],
            ["rejected", MARK],
            ["unverified", MARK],
        ]);
        expect(summary).toEqual({ carried: 1, added: 0, evidenceGone: 2 });
    });

    it("keeps the first evidence-gone mark, and clears it without changing the decision when the evidence returns", () => {
        const earlier = { version: 3, at: "2026-11-01T00:00:00Z" };
        const gone = [stored(refund, "id-2", "rejected", { evidenceGone: earlier })];
        expect(carryForward(gone, [], MARK).rules[0]!.evidenceGone).toEqual(earlier);
        const back = carryForward(gone, [refund], MARK).rules[0]!;
        expect([back.status, back.evidenceGone]).toEqual(["rejected", undefined]);
    });

    it("treats a changed expectation as a new unverified rule; the old decision stays on the old rule", () => {
        const changed = rule({ expected: "The quantity is between 1 and 20." });
        const { rules, summary } = carryForward([stored(quantity, "id-1", "confirmed")], [changed], MARK);
        expect(rules.map((r) => [r.id, r.status, r.expected, r.evidenceGone])).toEqual([
            ["id-1", "confirmed", quantity.expected, MARK],
            [undefined, "unverified", changed.expected, undefined],
        ]);
        expect(summary).toEqual({ carried: 0, added: 1, evidenceGone: 1 });
    });

    it("matches a stored rule that has no fingerprint yet by computing it", () => {
        const old = { ...quantity, id: "id-1", status: "confirmed" } as PreviousRule;
        expect(carryForward([old], [rule({ ref: "R-5" })], MARK).rules.map((r) => [r.id, r.status])).toEqual([["id-1", "confirmed"]]);
    });

    it("adds a rule found twice in one analysis only once", () => {
        const { rules } = carryForward([], [rule(), rule({ ref: "R-2", description: "Same rule again" })], MARK);
        expect(rules).toHaveLength(1);
    });
});

/**
 * A rule read from a document carries an anchor: fingerprints of the document it cites and of the lines it cites. Expected values come
 * from the brief: a re-reading of unchanged text keeps every rule and its decision however the model words it (the model rewords most
 * rules on every reading); a rule whose cited text changed never takes the old decision, even worded the same.
 */
describe("carryForward with anchors (rules read from a document)", () => {
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    const anchor = (doc: string, lines = doc) => ({ text: h(`doc ${doc}`), lines: h(`lines ${lines}`) });
    const read1 = [
        rule({ ref: "R-a", kind: "constraint", description: "Quantity limit", expected: "Quantity above 10 is refused with a message.", anchor: anchor("4.6") }),
        rule({ ref: "R-b", kind: "constraint", description: "Review needs an address", expected: "Opening review without an address redirects to step 1.", anchor: anchor("6.4", "6.4-L1") }),
        rule({ ref: "R-c", kind: "constraint", description: "Placing needs an address", expected: "Placing an order without an address is refused (API 409).", anchor: anchor("6.4", "6.4-L2") }),
        rule({ ref: "R-d", kind: "workflow", description: "Sign-out", expected: "After sign-out the person is a visitor.", anchor: anchor("2.9") }),
    ];
    const previous = read1.map((r, i) => stored(r, `id-${i}`, i % 2 ? "rejected" : "confirmed"));

    it("a reworded re-reading of unchanged text keeps every rule and its decision: wording, kind, links and cited lines may all differ", () => {
        const read2 = [
            // Same document, other cited lines (L1-L2 instead of L1), other words, other entities.
            rule({ ref: "R-x", kind: "constraint", description: "Max quantity", expected: "An item quantity over 10 is rejected and a message is shown.", entities: ["item"], anchor: anchor("4.6", "4.6-L1-L2") }),
            // Two rules from one document, read in the other order and reworded: each finds its own by its words.
            rule({ ref: "R-y", kind: "invariant", description: "Address before placing", expected: "An order without an address cannot be placed (API: 409).", anchor: anchor("6.4", "6.4-L2") }),
            rule({ ref: "R-z", kind: "constraint", description: "Review step", expected: "The review step without a delivery address sends the customer to step 1.", anchor: anchor("6.4", "6.4-L1") }),
            // Another kind.
            rule({ ref: "R-w", kind: "transition", description: "Signing out", expected: "After signing out the person is a visitor again.", workflows: [], anchor: anchor("2.9") }),
        ];
        const { rules, summary } = carryForward(previous, read2, MARK);
        expect(rules.map((r) => [r.id, r.ref, r.status, r.evidenceGone])).toEqual([
            ["id-0", "R-a", "confirmed", undefined],
            ["id-1", "R-b", "rejected", undefined],
            ["id-2", "R-c", "confirmed", undefined],
            ["id-3", "R-d", "rejected", undefined],
        ]);
        // The new reading's wording is what the rule now says (the store keeps a decided rule's wording beside it).
        expect(rules.map((r) => r.expected)).toEqual([read2[0]!.expected, read2[2]!.expected, read2[1]!.expected, read2[3]!.expected]);
        expect(summary).toEqual({ carried: 4, added: 0, evidenceGone: 0 });
    });

    it("a rule whose cited text changed never takes the old decision, even worded exactly the same", () => {
        // Requirement 2.9 was edited: its document and its lines have new fingerprints; the model words the rule as before.
        const edited = rule({ ...read1[3]!, anchor: anchor("2.9 edited") });
        const { rules, summary } = carryForward([previous[3]!], [edited], MARK);
        expect(rules.map((r) => [r.id, r.status, r.evidenceGone])).toEqual([
            ["id-3", "rejected", MARK],
            [undefined, "unverified", undefined],
        ]);
        expect(summary).toEqual({ carried: 0, added: 1, evidenceGone: 1 });
    });

    it("the same cited lines in an edited document are the same text; other lines of it are not", () => {
        // One document holds every requirement: an edit elsewhere changes the document's fingerprint, not that of the lines cited.
        const old = stored(rule({ expected: "Quantity above 10 is refused.", anchor: { text: h("whole v1"), lines: h("line 12") } }), "id-1", "confirmed");
        const sameLines = rule({ expected: "A quantity over 10 is rejected.", anchor: { text: h("whole v2"), lines: h("line 12") } });
        expect(carryForward([old], [sameLines], MARK).rules.map((r) => [r.id, r.status, r.evidenceGone])).toEqual([["id-1", "confirmed", undefined]]);
        const otherLines = rule({ expected: "A quantity over 10 is rejected.", anchor: { text: h("whole v2"), lines: h("line 12 edited") } });
        expect(carryForward([old], [otherLines], MARK).summary).toEqual({ carried: 0, added: 1, evidenceGone: 1 });
    });

    it("one new rule from a text stands for one stored rule; the other is kept with its evidence gone", () => {
        const one = rule({ expected: "An address is needed before review and before placing.", anchor: anchor("6.4", "6.4-L1-L2") });
        const { rules, summary } = carryForward([previous[1]!, previous[2]!], [one], MARK);
        expect(rules.filter((r) => r.evidenceGone).length).toBe(1);
        expect(summary).toEqual({ carried: 1, added: 0, evidenceGone: 1 });
    });

    it("a stored rule without an anchor (stored before anchors) is still found by its fingerprint", () => {
        const legacy = stored(rule({ expected: "Quantity above 10 is refused with a message." }), "id-9", "confirmed");
        const { rules } = carryForward([legacy], [read1[0]!], MARK);
        expect(rules.map((r) => [r.id, r.status, r.evidenceGone])).toEqual([["id-9", "confirmed", undefined]]);
        expect(rules[0]!.anchor).toEqual(read1[0]!.anchor);
    });
});
