/**
 * Scores one analysis against an answer key: criteria U1–U7 of the understanding benchmark, as pure functions. Each ratio states its
 * numerator, denominator and what was missed. Matching is deterministic first; where it cannot decide, a person's recorded judgement
 * decides. There is no AI judge.
 *
 * Definitions:
 * - U1 screens: answer-key screens with at least one model page whose path matches / answer-key screens.
 * - U2 endpoints: answer-key endpoints marked documented that the model holds as documented / answer-key documented endpoints; and the
 *   model's documented endpoints the document does not describe.
 * - U3 workflows: catalogue workflows identified / catalogue workflows of the app. Each model workflow identifies at most one key
 *   workflow: by id or name; else by best overlap, where its steps cover every write (non-GET) endpoint of the key workflow (every endpoint
 *   when it has none, every screen when it has no endpoint) and more than half of its own steps of that kind belong to it; a tie
 *   for the best waits for a recorded workflow link (listed in needsJudgement). A key workflow is credited at most once.
 * - U4 defect rules: defect rules stated by at least one model rule that carries evidence or a source reference / defect rules. A model
 *   rule is linked to the key rules it shares endpoints with; failing that, workflows; failing that, entities. One candidate links; several
 *   (or none) wait for a recorded judgement, which never overrides a deterministic link. "Explicit citing" also needs the rule explicit and
 *   one evidence item quoting the cited requirement line or naming its id.
 * - U5 provenance: rules with evidence or a source reference, explicitness matching the source type and a source other than "observed" /
 *   rules; plus rules confirmed without a person and rules sourced from observed behaviour.
 * - U6 wrong rules: recorded "contradicts" verdicts / reviewed rules, explicit and inferred apart; unreviewed rules listed.
 * - U7 incremental: decisions (confirmed, rejected) carried forward by rule fingerprint / decisions before; a rerun with no change makes no
 *   version and no AI call for unchanged sources; a rerun with one changed source re-processes exactly that source.
 */
import { explicitnessOf, ruleFingerprint, type AppModel, type Rule, type RuleStatus } from "../../../engine/intel/model.js";
import { endpointRef, type AnswerKey, type Judgements } from "./answer-key.js";

export interface Ratio {
    found: number;
    total: number;
    /** found / total; null when there is nothing to find. */
    value: number | null;
    /** What was not found, sorted. */
    missed: string[];
}

/** A stored rule as the scorer sees it. */
export type ScoredRule = Rule & { status: RuleStatus; decidedBy: string | null };

const ratio = (found: number, total: number, missed: string[]): Ratio => ({ found, total, value: total === 0 ? null : found / total, missed: [...missed].sort() });

const PARAM = "\u0000";
function segments(p: string): string[] {
    let s = p.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
    s = s.split(/[?#]/)[0] ?? "";
    return s
        .split("/")
        .filter(Boolean)
        .map((x) => (/^(:\w+|\{\w+\}|\*)$/.test(x) ? PARAM : decodeURIComponentSafe(x).toLowerCase()));
}
function decodeURIComponentSafe(x: string): string {
    try {
        return decodeURIComponent(x);
    } catch {
        return x;
    }
}

/** Whether a model path is the answer-key path: a key parameter matches any one segment; a model parameter matches only a key parameter. */
export function matchesPath(keyPath: string, modelPath: string): boolean {
    const k = segments(keyPath);
    const m = segments(modelPath);
    return k.length === m.length && k.every((seg, i) => seg === PARAM || seg === m[i]);
}

function parseEndpoint(s: string): { method: string | null; path: string } {
    const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s.trim());
    return m ? { method: m[1].toUpperCase(), path: m[2] } : { method: null, path: s.trim() };
}
const endpointMatches = (keyRef: string, modelRef: string) => {
    const k = parseEndpoint(keyRef);
    const m = parseEndpoint(modelRef);
    return (m.method === null || m.method === k.method) && matchesPath(k.path, m.path);
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function screenRecall(model: AppModel, key: AnswerKey): Ratio {
    const missed = key.screens.filter((s) => !model.pages.some((p) => matchesPath(s.path, p.path))).map((s) => s.id);
    return ratio(key.screens.length - missed.length, key.screens.length, missed);
}

export function endpointRecall(model: AppModel, key: AnswerKey): Ratio & { documentedNotInDocument: string[] } {
    const documented = key.endpoints.filter((e) => e.documented).map(endpointRef);
    const modelDocumented = model.endpoints.filter((e) => e.origin === "documented").map((e) => `${e.method.toUpperCase()} ${e.path}`);
    const missed = documented.filter((k) => !modelDocumented.some((m) => endpointMatches(k, m)));
    const extra = modelDocumented.filter((m) => !documented.some((k) => endpointMatches(k, m)));
    return { ...ratio(documented.length - missed.length, documented.length, missed), documentedNotInDocument: [...new Set(extra)].sort() };
}

interface WorkflowAssignment {
    /** Model workflow id → the one key workflow it identifies. */
    assigned: Map<string, string>;
    /** Model workflows that fit several key workflows equally well and have no recorded workflow link. */
    needsJudgement: string[];
}

/**
 * Each model workflow identifies at most one key workflow, and each key workflow is credited at most once by overlap:
 * 1. id or name equal to the key workflow's id;
 * 2. otherwise by overlap of what the key workflow needs (its write endpoints; all its endpoints when it has no write; its screens when it
 *    has no endpoint) with the model workflow's steps of the same kind: the steps cover every need AND more than half of the model
 *    workflow's steps of that kind belong to the key workflow. The best Jaccard overlap wins; a tie for the best leaves the model workflow
 *    to a recorded workflow link; a key workflow already credited is not credited again;
 * 3. a recorded workflow link, only for a model workflow neither step assigned.
 */
function assignWorkflows(model: AppModel, key: AnswerKey, judgements?: Judgements): WorkflowAssignment {
    const pagePath = new Map(model.pages.map((p) => [p.id, p.path]));
    const screenPath = new Map(key.screens.map((s) => [s.id, s.path]));
    const assigned = new Map<string, string>();
    const taken = new Set<string>();
    for (const w of model.workflows) {
        const k = key.workflows.find((kw) => slug(w.id) === kw.id || slug(w.name) === kw.id);
        if (k) (assigned.set(w.id, k.id), taken.add(k.id));
    }
    const fit = (w: AppModel["workflows"][number], kw: AnswerKey["workflows"][number]): number | null => {
        const endpoints = w.steps.flatMap((s) => (s.endpoint ? [s.endpoint] : []));
        const writes = kw.endpoints.filter((e) => !e.startsWith("GET "));
        let need: string[];
        let have: string[];
        let match: (n: string, h: string) => boolean;
        if (writes.length > 0) {
            need = writes;
            have = endpoints.filter((e) => {
                const m = parseEndpoint(e).method;
                return m !== null && m !== "GET";
            });
            match = endpointMatches;
        } else if (kw.endpoints.length > 0) {
            need = kw.endpoints;
            have = endpoints;
            match = endpointMatches;
        } else {
            need = kw.screens.map((id) => screenPath.get(id) ?? "");
            have = w.steps.flatMap((s) => (s.page ? [pagePath.get(s.page) ?? s.page] : []));
            match = matchesPath;
        }
        have = [...new Set(have)];
        if (need.length === 0 || have.length === 0) return null;
        if (!need.every((n) => have.some((h) => match(n, h)))) return null;
        const matchedHave = have.filter((h) => need.some((n) => match(n, h))).length;
        if (matchedHave * 2 <= have.length) return null;
        return matchedHave / (have.length + need.length - matchedHave);
    };
    const needsJudgement: string[] = [];
    const proposals: Array<{ w: string; k: string; score: number; order: number }> = [];
    model.workflows.forEach((w, order) => {
        if (assigned.has(w.id)) return;
        const scored = key.workflows.filter((kw) => !taken.has(kw.id)).flatMap((kw) => {
            const score = fit(w, kw);
            return score === null ? [] : [{ k: kw.id, score }];
        });
        if (scored.length === 0) return;
        const best = Math.max(...scored.map((x) => x.score));
        const top = scored.filter((x) => x.score === best);
        if (top.length > 1) needsJudgement.push(w.id);
        else proposals.push({ w: w.id, k: top[0].k, score: best, order });
    });
    proposals.sort((a, b) => b.score - a.score || a.order - b.order);
    for (const p of proposals) if (!taken.has(p.k)) (assigned.set(p.w, p.k), taken.add(p.k));
    const known = new Set(model.workflows.map((w) => w.id));
    for (const l of judgements?.workflowLinks ?? []) if (l.keyWorkflowId && known.has(l.workflowId) && !assigned.has(l.workflowId)) assigned.set(l.workflowId, l.keyWorkflowId);
    return { assigned, needsJudgement: needsJudgement.filter((w) => !assigned.has(w)).sort() };
}

export function workflowRecall(model: AppModel, key: AnswerKey, catalogueWorkflows: string[], judgements?: Judgements): Ratio & { needsJudgement: string[] } {
    const { assigned, needsJudgement } = assignWorkflows(model, key, judgements);
    const found = new Set(assigned.values());
    const wanted = [...new Set(catalogueWorkflows)];
    const missed = wanted.filter((w) => !found.has(w));
    return { ...ratio(wanted.length - missed.length, wanted.length, missed), needsJudgement };
}

const hasProvenance = (r: Pick<Rule, "evidence" | "sourceRef">) => r.evidence.length > 0 || r.sourceRef.trim() !== "";
const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function citesLine(r: Rule, requirement: { id: string; line: number }, lines: string[]): boolean {
    const line = normText(lines[requirement.line - 1] ?? "").replace(/^[-*]\s+/, "");
    const lineText = line.startsWith(requirement.id) ? line.slice(requirement.id.length).trim() : line;
    const idToken = new RegExp(`(^|[^\\d.])${requirement.id.replace(/\./g, "\\.")}(?![.\\d])`);
    return r.evidence.some((e) => {
        const excerpt = normText(e.excerpt ?? "").replace(/[.\s]+$/, "");
        if (excerpt.length >= 12 && lineText && (lineText.includes(excerpt) || excerpt.includes(lineText.replace(/[.\s]+$/, "")))) return true;
        return idToken.test(e.ref) || idToken.test(e.excerpt ?? "");
    });
}

export function defectRuleRecall(
    model: AppModel,
    rules: ScoredRule[],
    key: AnswerKey,
    opts: { requirementsText?: string; judgements?: Judgements } = {},
): { any: Ratio; explicitCiting: Ratio; links: Record<string, string>; needsJudgement: string[] } {
    const { assigned } = assignWorkflows(model, key, opts.judgements);
    const modelWorkflows = new Set(model.workflows.map((w) => w.id));
    const entityName = new Map(model.entities.map((e) => [e.id, e.name]));
    const keyEntity = (modelEntity: string) => {
        const names = [slug(modelEntity), slug(entityName.get(modelEntity) ?? "")].filter(Boolean);
        return key.entities.filter((e) => names.includes(e.id) || names.includes(slug(e.name))).map((e) => e.id);
    };
    const judged = new Map((opts.judgements?.links ?? []).map((l) => [l.ruleRef, l.defectId]));
    const links: Record<string, string> = {};
    const needsJudgement: string[] = [];
    for (const r of rules) {
        // A rule's workflow is a model workflow id (mapped to the key workflows it identifies) or, failing that, read as a key id.
        const keyWorkflows = new Set(r.workflows.flatMap((w) => (modelWorkflows.has(w) ? (assigned.has(w) ? [assigned.get(w)!] : []) : [slug(w)])));
        const keyEntities = new Set(r.entities.flatMap(keyEntity));
        const tiers: Array<(k: AnswerKey["rules"][number]) => boolean> = [
            (k) => k.endpoints.some((ke) => r.endpoints.some((me) => endpointMatches(ke, me))),
            (k) => k.workflows.some((w) => keyWorkflows.has(w)),
            (k) => k.entities.some((e) => keyEntities.has(e)),
        ];
        let decided: string | null = null;
        let ambiguous = false;
        for (const tier of tiers) {
            const candidates = key.rules.filter(tier);
            if (candidates.length === 1) decided = candidates[0].defectId;
            ambiguous = candidates.length > 1;
            if (candidates.length > 0) break;
        }
        if (!decided && judged.has(r.ref)) decided = judged.get(r.ref) ?? null;
        else if (!decided && ambiguous) needsJudgement.push(r.ref);
        if (decided) links[r.ref] = decided;
    }
    const lines = (opts.requirementsText ?? "").split(/\r?\n/);
    const any: string[] = [];
    const citing: string[] = [];
    for (const k of key.rules) {
        const stating = rules.filter((r) => links[r.ref] === k.defectId && hasProvenance(r));
        if (stating.length > 0) any.push(k.defectId);
        if (stating.some((r) => r.explicitness === "explicit" && citesLine(r, k.requirement, lines))) citing.push(k.defectId);
    }
    const all = key.rules.map((k) => k.defectId);
    return {
        any: ratio(any.length, all.length, all.filter((d) => !any.includes(d))),
        explicitCiting: ratio(citing.length, all.length, all.filter((d) => !citing.includes(d))),
        links,
        needsJudgement: needsJudgement.sort(),
    };
}

export function provenance(rules: ScoredRule[]): Ratio & { confirmedWithoutPerson: string[]; fromObserved: string[] } {
    const missed = rules.filter((r) => r.sourceType === "observed" || !hasProvenance(r) || r.explicitness !== explicitnessOf(r.sourceType) || !(r.confidence >= 0 && r.confidence <= 1)).map((r) => r.ref);
    return {
        ...ratio(rules.length - missed.length, rules.length, missed),
        confirmedWithoutPerson: rules.filter((r) => r.status === "confirmed" && !r.decidedBy).map((r) => r.ref).sort(),
        fromObserved: rules.filter((r) => r.sourceType === "observed").map((r) => r.ref).sort(),
    };
}

export interface ReviewCount {
    total: number;
    reviewed: number;
    contradicting: number;
    /** contradicting / reviewed; null when none was reviewed. */
    rate: number | null;
    unreviewed: string[];
}

export function wrongRules(rules: ScoredRule[], judgements?: Judgements): { explicit: ReviewCount; inferred: ReviewCount } {
    const verdict = new Map((judgements?.reviews ?? []).map((r) => [r.ruleRef, r.verdict]));
    const count = (rs: ScoredRule[]): ReviewCount => {
        const reviewed = rs.filter((r) => verdict.has(r.ref));
        const contradicting = reviewed.filter((r) => verdict.get(r.ref) === "contradicts").length;
        return { total: rs.length, reviewed: reviewed.length, contradicting, rate: reviewed.length === 0 ? null : contradicting / reviewed.length, unreviewed: rs.filter((r) => !verdict.has(r.ref)).map((r) => r.ref).sort() };
    };
    return { explicit: count(rules.filter((r) => r.explicitness === "explicit")), inferred: count(rules.filter((r) => r.explicitness === "inferred")) };
}

export interface IncrementalInput {
    before: ScoredRule[];
    after: ScoredRule[];
    /** A rerun with no source changed. */
    noChange?: { newVersion: boolean; aiCallsForUnchangedSources: number };
    /** A rerun with one source changed: which changed, which were re-processed (source kinds or refs). */
    oneChanged?: { changed: string[]; reprocessed: string[] };
}

export function incremental(input: IncrementalInput): {
    decisions: Ratio;
    noChange?: { newVersion: boolean; aiCallsForUnchangedSources: number; ok: boolean };
    oneChanged?: { extra: string[]; missing: string[]; ok: boolean };
} {
    const afterStatus = new Map(input.after.map((r) => [ruleFingerprint(r), r.status]));
    const decided = input.before.filter((r) => r.status !== "unverified");
    const missed = decided.filter((r) => afterStatus.get(ruleFingerprint(r)) !== r.status).map((r) => r.ref);
    const out: ReturnType<typeof incremental> = { decisions: ratio(decided.length - missed.length, decided.length, missed) };
    if (input.noChange) out.noChange = { ...input.noChange, ok: !input.noChange.newVersion && input.noChange.aiCallsForUnchangedSources === 0 };
    if (input.oneChanged) {
        const { changed, reprocessed } = input.oneChanged;
        const extra = reprocessed.filter((s) => !changed.includes(s)).sort();
        const missing = changed.filter((s) => !reprocessed.includes(s)).sort();
        out.oneChanged = { extra, missing, ok: extra.length === 0 && missing.length === 0 };
    }
    return out;
}

export interface UnderstandingInput {
    model: AppModel;
    rules: ScoredRule[];
    key: AnswerKey;
    /** sha256 of the answer key's text; judgements must name the same key. */
    keySha256: string;
    catalogueWorkflows: string[];
    requirementsText?: string;
    judgements?: Judgements;
    incremental?: IncrementalInput;
}

export interface UnderstandingScore {
    app: string;
    answerKeySha256: string;
    screens: Ratio;
    endpoints: ReturnType<typeof endpointRecall>;
    workflows: ReturnType<typeof workflowRecall>;
    defectRules: ReturnType<typeof defectRuleRecall>;
    provenance: ReturnType<typeof provenance>;
    wrongRules: ReturnType<typeof wrongRules>;
    incremental?: ReturnType<typeof incremental>;
}

export function scoreUnderstanding(input: UnderstandingInput): UnderstandingScore {
    const { model, rules, key, judgements } = input;
    if (judgements && judgements.app !== key.app) throw new Error(`The judgements are for ${judgements.app}, but the answer key is for ${key.app}.`);
    if (judgements && judgements.answerKeySha256 !== input.keySha256) throw new Error("The judgements were recorded against another version of the answer key.");
    return {
        app: key.app,
        answerKeySha256: input.keySha256,
        screens: screenRecall(model, key),
        endpoints: endpointRecall(model, key),
        workflows: workflowRecall(model, key, input.catalogueWorkflows, judgements),
        defectRules: defectRuleRecall(model, rules, key, { requirementsText: input.requirementsText, judgements }),
        provenance: provenance(rules),
        wrongRules: wrongRules(rules, judgements),
        ...(input.incremental ? { incremental: incremental(input.incremental) } : {}),
    };
}
