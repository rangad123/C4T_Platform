/**
 * Carries rule decisions from one analysis to the next.
 *
 * Which stored rule a new rule is: a rule read from a document has an anchor (model.ts Rule.anchor), the fingerprints of the document it
 * cites and of the lines it cites. Those do not change when the same text is read again; the model's wording, kind and links do (a
 * re-reading rewords most rules). So a new rule is the stored rule that has the same anchor (the same document text, or the same cited
 * lines), and among several such, the one whose fingerprint is the same, then the one worded most alike. A rule whose cited text changed
 * is never the stored rule, even when it is worded the same: the person decided about other words. Rules without an anchor on either
 * side (other sources, rules stored before anchors existed) are matched by fingerprint (kind, what it expects, what it is linked to).
 *
 * - A matched rule keeps its stored id, ref and status, and takes the new analysis's wording, source and evidence.
 * - A stored rule the new analysis did not state again, but whose document it read again unchanged (`stated`), still has its evidence:
 *   it is kept as it was, with its status, and not marked (a re-reading that leaves a rule out is not a change in the text).
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
    /** Why, when it was not a later analysis: the requirement the rule came from was retired or deleted. */
    reason?: "requirement_retired";
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
    ...(r.anchor ? { anchor: r.anchor } : {}),
});

/** Both rules were read from the same text: the same document, or the same cited lines. */
const sameText = (a: Rule, b: Rule) => Boolean(a.anchor && b.anchor && (a.anchor.text === b.anchor.text || a.anchor.lines === b.anchor.lines));

const wordsOf = new WeakMap<Rule, Set<string>>();
function words(r: Rule): Set<string> {
    let w = wordsOf.get(r);
    if (!w) wordsOf.set(r, (w = new Set(`${r.description} ${r.expected}`.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1))));
    return w;
}
/** How alike two rules are worded (shared words / all words), with a little more for the same kind: only to choose among same-text rules. */
function alike(a: Rule, b: Rule): number {
    const x = words(a);
    const y = words(b);
    const shared = [...x].filter((w) => y.has(w)).length;
    const all = x.size + y.size - shared;
    return (all ? shared / all : 0) + (a.kind === b.kind ? 0.1 : 0);
}

export function carryForward(previous: readonly PreviousRule[], next: readonly Rule[], mark: EvidenceGone, o: { stated?: ReadonlySet<string> } = {}): CarryForwardResult {
    const found = new Map<string, Rule>();
    for (const r of next) {
        const fp = ruleFingerprint(r);
        if (!found.has(fp)) found.set(fp, r);
    }
    const prints = previous.map((p) => p.fingerprint || ruleFingerprint(p));
    const news = [...found];

    // Every pair that may be the same rule, best first: same fingerprint (and, when both are anchored, same text), then same text worded
    // most alike. Without an anchor on one side, only the same fingerprint.
    const byPrint = new Map<string, number[]>();
    const byText = new Map<string, number[]>();
    const add = (m: Map<string, number[]>, k: string, i: number) => m.set(k, [...(m.get(k) ?? []), i]);
    previous.forEach((p, i) => {
        add(byPrint, prints[i]!, i);
        if (p.anchor) (add(byText, `t:${p.anchor.text}`, i), add(byText, `l:${p.anchor.lines}`, i));
    });
    const pairs: { p: number; n: number; score: number }[] = [];
    news.forEach(([fp, r], n) => {
        const near = new Set([...(byPrint.get(fp) ?? []), ...(r.anchor ? [...(byText.get(`t:${r.anchor.text}`) ?? []), ...(byText.get(`l:${r.anchor.lines}`) ?? [])] : [])]);
        for (const p of near) {
            const old = previous[p]!;
            const anchored = Boolean(old.anchor && r.anchor);
            if (anchored && !sameText(old, r)) continue;
            if (!anchored && prints[p] !== fp) continue;
            pairs.push({ p, n, score: (prints[p] === fp ? 2 : 0) + alike(old, r) });
        }
    });
    pairs.sort((a, b) => b.score - a.score || a.p - b.p || a.n - b.n);
    const matchOf = new Map<number, number>();
    const taken = new Set<number>();
    // A rule worded the same may stand for several stored rules (as before anchors); one found only by its text stands for one.
    for (const { p, n, score } of pairs) {
        if (matchOf.has(p) || (taken.has(n) && score < 2)) continue;
        matchOf.set(p, n);
        taken.add(n);
    }

    const summary = { carried: 0, added: 0, evidenceGone: 0 };
    const rules: CarriedRule[] = previous.map((p, i) => {
        const fingerprint = prints[i]!;
        const n = matchOf.get(i);
        if (n !== undefined) {
            if (p.status !== "unverified") summary.carried++;
            return { ...ruleOnly(news[n]![1]), ref: p.ref, id: p.id, fingerprint, status: p.status };
        }
        if (p.anchor && o.stated?.has(p.anchor.text)) {
            if (p.status !== "unverified") summary.carried++;
            return { ...ruleOnly(p), id: p.id, fingerprint, status: p.status };
        }
        summary.evidenceGone++;
        return { ...ruleOnly(p), id: p.id, fingerprint, status: p.status, evidenceGone: p.evidenceGone ?? mark };
    });
    news.forEach(([fingerprint, r], n) => {
        if (taken.has(n)) return;
        summary.added++;
        rules.push({ ...ruleOnly(r), fingerprint, status: "unverified" });
    });
    return { rules, summary };
}
