/**
 * Carries rule decisions from one analysis to the next. A rule is matched by its fingerprint (kind, what it expects, what it is linked
 * to), so rewording, renumbering or a different source does not lose a person's decision.
 *
 * - A matched rule keeps its stored id, ref and status, and takes the new analysis's wording, source and evidence.
 * - A stored rule the new analysis no longer finds is kept with its status and marked "evidence gone" for a person; it is never deleted.
 * - A new rule is always unverified, whatever the extraction said: only a person confirms or rejects a rule.
 *
 * `next` is every rule the new analysis knows (merge() returns them), so a stored rule missing from it really lost its evidence.
 */
import { ruleFingerprint, type Rule, type RuleStatus } from "./model.js";

/** When a rule's evidence was first found missing: the model version and the time. */
export interface EvidenceGone {
    version: number;
    at: string;
}

export interface PreviousRule extends Rule {
    id: string;
    status: RuleStatus;
    /** Stored fingerprint; computed when absent (rules stored before fingerprints existed). */
    fingerprint?: string;
    evidenceGone?: EvidenceGone | null;
}

export interface CarriedRule extends Rule {
    /** The stored rule this one updates; absent for a new rule. */
    id?: string;
    fingerprint: string;
    status: RuleStatus;
    evidenceGone?: EvidenceGone;
}

export interface CarryForwardResult {
    rules: CarriedRule[];
    /** carried: confirmed or rejected decisions matched; added: new rules; evidenceGone: stored rules not found again. */
    summary: { carried: number; added: number; evidenceGone: number };
}

/** Only the rule's own fields: anything else an extraction added (a status, who decided) is dropped. */
const ruleOnly = (r: Rule): Rule => ({
    ref: r.ref,
    kind: r.kind,
    description: r.description,
    expected: r.expected,
    sourceType: r.sourceType,
    sourceRef: r.sourceRef,
    evidence: r.evidence,
    explicitness: r.explicitness,
    confidence: r.confidence,
    entities: r.entities,
    workflows: r.workflows,
    endpoints: r.endpoints,
});

export function carryForward(previous: readonly PreviousRule[], next: readonly Rule[], mark: EvidenceGone): CarryForwardResult {
    const found = new Map<string, Rule>();
    for (const r of next) {
        const fp = ruleFingerprint(r);
        if (!found.has(fp)) found.set(fp, r);
    }
    const summary = { carried: 0, added: 0, evidenceGone: 0 };
    const known = new Set<string>();
    const rules: CarriedRule[] = previous.map((p) => {
        const fingerprint = p.fingerprint || ruleFingerprint(p);
        known.add(fingerprint);
        const now = found.get(fingerprint);
        if (now) {
            if (p.status !== "unverified") summary.carried++;
            return { ...ruleOnly(now), ref: p.ref, id: p.id, fingerprint, status: p.status };
        }
        summary.evidenceGone++;
        return { ...ruleOnly(p), id: p.id, fingerprint, status: p.status, evidenceGone: p.evidenceGone ?? mark };
    });
    for (const [fingerprint, r] of found) {
        if (known.has(fingerprint)) continue;
        summary.added++;
        rules.push({ ...ruleOnly(r), fingerprint, status: "unverified" });
    }
    return { rules, summary };
}
