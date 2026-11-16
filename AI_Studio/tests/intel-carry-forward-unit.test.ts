/**
 * Carrying rule decisions from one analysis to the next. Pure (fast tier).
 *
 * Expected values come from the versioning rules: a rule is matched across analyses by its fingerprint (kind, what it expects, what it
 * is linked to); a person's confirm or reject decision carries forward; a rule whose evidence disappeared is kept and marked "evidence
 * gone", never deleted and never confirmed by the system; every new rule starts unverified, whatever the extraction claimed.
 */
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
