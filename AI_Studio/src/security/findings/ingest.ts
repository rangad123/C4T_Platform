/**
 * FIND's entry point for the assessment job (RUN): store what a passive assessment found as findings.
 *
 *   import { ingest, fromCheckFailure, type RawResult } from "../findings/ingest.js";
 *   const results: RawResult[] = [];
 *   for (const call of responsesSeen)                       // one SecurityCall per response, judged on its own
 *       for (const check of SECURITY_CHECKS) {
 *           const msg = await evaluateSecurity(check, [call]);
 *           if (msg) results.push(...fromCheckFailure(check, msg, call));
 *       }
 *   const summary = await ingest(store, assessment, results);  // store: CORE's SecurityStore (or the platform Db)
 *
 * What ingest does, in order:
 * 1. normalize every raw result to the contract's finding shape (title, category, severity, confidence, location, description, impact,
 *    remediation, browser reproduction steps, evidence) and **redact** everything (redact.ts);
 * 2. group the results of this run by fingerprint (category + check + rule + normalized location), so a header missing on 40 pages is
 *    one finding whose evidence lists the pages it was seen on;
 * 3. **upsert by fingerprint** per application: a new finding starts `probable` (direct evidence) or `needs-review`, never `confirmed`;
 *    one seen before gets its latest evidence, last-seen time and last assessment, and keeps the validation people gave it (a finding
 *    marked `fixed` that is seen again is reopened as `needs-review`, with a history note);
 * 4. for a retest (`assessment.retestOf`): the original assessment's open findings that were not seen again become `fixed` (history names
 *    the retest), the ones seen again get a "still present" note. Pass `{ retestComplete: false }` when the retest could not look at every
 *    location (cancelled, partly failed): nothing is then marked fixed, and the history says why.
 *
 * Calling it twice for the same assessment never duplicates a finding (the second call only refreshes last-seen and evidence).
 */
import type { Db } from "../../platform/db.js";
import type { SecurityAssessment, Severity } from "../contract.js";
import { SEVERITIES } from "../contract.js";
import { SecurityStore, securityStoreFor } from "../store.js";
import { normalize, type FindingDraft, type RawResult } from "./normalize.js";
import { redactEvidence } from "./redact.js";

export { fromCheckFailure, type RawResult, type ObservedResponse, type CustomProblem } from "./normalize.js";

/** Most raw results one ingest call takes (the rest are ignored and counted in the summary). */
export const MAX_RESULTS = 10_000;
/** Most addresses listed in a finding's "seen on" note. */
export const MAX_SEEN_ON = 20;

export interface IngestOptions {
    /** For a retest: false when it could not re-check every location, so no finding is marked fixed. Default true. */
    retestComplete?: boolean;
    now?: Date;
}

export interface IngestSummary {
    /** Raw results received, and the ones that were not problem lines or were over the cap. */
    received: number;
    ignored: number;
    created: number;
    updated: number;
    reopened: number;
    /** Retest only. */
    markedFixed: number;
    stillPresent: number;
}

export type IngestAssessment = Pick<SecurityAssessment, "id" | "applicationId" | "projectId" | "retestOf">;

const rank = (s: Severity) => SEVERITIES.indexOf(s);
const OPEN = new Set(["confirmed", "probable", "needs-review"]);

export function isOpen(validation: string): boolean {
    return OPEN.has(validation);
}

/** A draft with what the other drafts of the same fingerprint brought: the addresses, and the rules that folded into it. */
type GroupedDraft = FindingDraft & { seenOnAll: string[]; alsoReported: string[] };

/** How a draft names its own rule when it is folded into another one. */
const ruleLabel = (d: FindingDraft): string => (d.rule.startsWith(`${d.check}:`) ? d.rule : `${d.check}:${d.rule}`);

/**
 * Group drafts of one run by fingerprint: the most serious wording wins, the addresses are collected.
 *
 * One weakness can be named by more than one rule - two ZAP rules that share a CWE (`zap:cwe-693` is both "Content-Security-Policy
 * missing" and "X-Content-Type-Options missing"), or one problem seen by a scanner and by the platform's own checks. The most serious
 * wording wins, but nothing of the other is thrown away: its evidence is kept and its rule is named. Without that, a rule folded in
 * here lost its evidence and left no trace at all, and a client fixing the problem the finding names could still have the other one
 * open with nothing in the record to say so.
 */
function group(drafts: FindingDraft[]): GroupedDraft[] {
    const by = new Map<string, GroupedDraft>();
    for (const d of drafts) {
        const g = by.get(d.fingerprint);
        if (!g) {
            by.set(d.fingerprint, { ...d, evidence: [...d.evidence], seenOnAll: [d.seenOn], alsoReported: [] });
            continue;
        }
        if (!g.seenOnAll.includes(d.seenOn)) g.seenOnAll.push(d.seenOn);
        g.alsoReported.push(ruleLabel(d));
        for (const e of d.evidence) if (!g.evidence.some((x) => x.label === e.label && x.value === e.value)) g.evidence.push(e);
        if (rank(d.severity) < rank(g.severity)) Object.assign(g, d, { evidence: g.evidence, seenOnAll: g.seenOnAll, alsoReported: g.alsoReported });
    }
    return [...by.values()];
}

function withSeenOn(d: GroupedDraft, at: string): FindingDraft {
    // Said before the "seen on" note, and said even when there is only one address: the rules that folded in are what a reader needs to
    // know exists, and one address is exactly the case where nothing else in the record would mention them.
    if (d.alsoReported.length) d.evidence = [...d.evidence, redactEvidence({ kind: "note", label: "Also matched by", value: [...new Set(d.alsoReported)].join("\n"), observedAt: at })];
    if (d.seenOnAll.length <= 1 && d.seenOnAll[0] === d.location) return d;
    const shown = d.seenOnAll.slice(0, MAX_SEEN_ON);
    const more = d.seenOnAll.length - shown.length;
    const note = redactEvidence({
        kind: "note",
        label: d.seenOnAll.length === 1 ? "Seen on" : `Seen on ${d.seenOnAll.length} addresses`,
        value: shown.join("\n") + (more > 0 ? `\n…and ${more} more` : ""),
        observedAt: at,
    });
    return { ...d, evidence: [...d.evidence, note] };
}


const storeOf = (x: Db | SecurityStore): SecurityStore => (x instanceof SecurityStore ? x : securityStoreFor(x));

/** Store the results of one assessment as findings. `target` is CORE's SecurityStore or the platform Db. See the file comment for the rules. */
export async function ingest(target: Db | SecurityStore, assessment: IngestAssessment, results: RawResult[], options: IngestOptions = {}): Promise<IngestSummary> {
    const store = storeOf(target);
    const now = (options.now ?? new Date()).toISOString();
    const taken = results.slice(0, MAX_RESULTS);
    const drafts = taken.map((r) => normalize(r, now)).filter((d): d is FindingDraft => d !== undefined);
    const summary: IngestSummary = { received: results.length, ignored: results.length - drafts.length, created: 0, updated: 0, reopened: 0, markedFixed: 0, stillPresent: 0 };
    const seenIds = new Set<string>();
    for (const g of group(drafts)) {
        const outcome = upsertDraft(store, assessment, withSeenOn(g, now), now);
        seenIds.add(outcome.id);
        if (outcome.created) summary.created++;
        else summary.updated++;
        if (outcome.reopened) summary.reopened++;
    }
    if (assessment.retestOf) retest(store, assessment, seenIds, options.retestComplete !== false, summary);
    return summary;
}

function upsertDraft(store: SecurityStore, a: IngestAssessment, d: FindingDraft, now: string): { id: string; created: boolean; reopened: boolean } {
    const before = store.findingByFingerprint(a.applicationId, d.fingerprint);
    const { finding, created } = store.upsertFinding({
        projectId: a.projectId,
        applicationId: a.applicationId,
        assessmentId: a.id,
        fingerprint: d.fingerprint,
        checkId: d.check,
        title: d.title,
        category: d.category,
        severity: d.severity,
        confidence: d.confidence,
        location: d.location,
        description: d.description,
        impact: d.impact,
        remediation: d.remediation,
        reproduction: d.reproduction,
        evidence: d.evidence,
        // Additive (SCAN): the draft says whether an outside tool reported this, so a scanner's finding is never stored as though
        // the platform's own checks had found it.
        source: d.source,
        initialValidation: d.initialValidation,
        seenAt: now,
    });
    if (created) {
        store.addFindingNote(finding.id, `Found by assessment ${a.id}; it starts as ${d.initialValidation === "probable" ? "probable (the evidence is a direct observation)" : "needs review"}.`, a.id);
        return { id: finding.id, created, reopened: false };
    }
    // A finding marked fixed that shows up again is open again: people decide from there.
    if (before?.validation === "fixed") {
        store.setValidation(finding.id, "needs-review", { comment: `Seen again by assessment ${a.id} after it was marked fixed.`, assessmentId: a.id });
        return { id: finding.id, created, reopened: true };
    }
    // Additive (SCAN): the same problem reported by a second source (another scanner, or a scanner and the platform's own checks).
    // The stored check_id is the first source that found it, so say plainly that another one saw it too instead of overwriting it.
    if (before && before.checkId && before.checkId !== d.check) {
        store.addFindingNote(finding.id, `Also reported by ${d.check} (rule ${d.rule}) in assessment ${a.id}. Both sources are kept in the evidence.`, a.id);
    }
    return { id: finding.id, created, reopened: false };
}

function retest(store: SecurityStore, a: IngestAssessment, seen: Set<string>, complete: boolean, s: IngestSummary): void {
    for (const id of store.findingIdsSeenIn(a.retestOf!)) {
        const f = store.getFinding(id);
        if (!f || f.applicationId !== a.applicationId) continue;
        if (seen.has(id)) {
            if (isOpen(f.validation)) {
                store.addFindingNote(id, `Still present in retest ${a.id}.`, a.id);
                s.stillPresent++;
            }
            continue;
        }
        if (!isOpen(f.validation)) continue;
        if (!complete) {
            store.addFindingNote(id, `Not seen in retest ${a.id}, but the retest did not finish checking every location, so it is not marked fixed.`, a.id);
            continue;
        }
        store.setValidation(id, "fixed", { comment: `Not seen again in retest ${a.id}.`, assessmentId: a.id });
        s.markedFixed++;
    }
}

/**
 * What a retest of `originalAssessmentId` should look at again: the original's open findings with the addresses they were seen on
 * (for site-wide settings, the addresses in the "seen on" note, else the location). RUN requests these through the scope guard.
 */
export function retestTargets(target: Db | SecurityStore, originalAssessmentId: string): Array<{ findingId: string; fingerprint: string; checkId: string | null; category: string; title: string; location: string; urls: string[] }> {
    const store = storeOf(target);
    const out: ReturnType<typeof retestTargets> = [];
    for (const id of store.findingIdsSeenIn(originalAssessmentId)) {
        const f = store.getFinding(id);
        if (!f || !isOpen(f.validation)) continue;
        const note = f.evidence.find((e) => e.kind === "note" && /^Seen on/.test(e.label));
        const urls = note ? note.value.split("\n").filter((u) => /^https?:\/\//.test(u)) : [];
        out.push({ findingId: f.id, fingerprint: f.fingerprint, checkId: f.checkId, category: f.category, title: f.title, location: f.location, urls: urls.length ? urls : [f.location] });
    }
    return out;
}
