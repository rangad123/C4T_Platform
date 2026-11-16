/**
 * Scores one analysis against an answer key: criteria U1–U7 of the understanding benchmark, as pure functions. Each ratio states its
 * numerator, denominator and what was missed. Matching is deterministic first; where it cannot decide, a person's recorded judgement
 * decides. There is no AI judge.
 *
 * Definitions:
 * - U1 screens: answer-key screens with at least one model page whose path matches / answer-key screens; screens the harness marks as
 *   not reachable by any crawl are left out of both and listed.
 * - U2 endpoints: answer-key endpoints marked documented that the model holds as documented / answer-key documented endpoints; and the
 *   model's documented endpoints the document does not describe.
 * - U3 workflows: catalogue workflows identified / catalogue workflows of the app. Each model workflow identifies at most one key
 *   workflow: by id or name; else by best overlap, where its steps cover every write (non-GET) endpoint of the key workflow (every endpoint
 *   when it has none, every screen when it has no endpoint; every screen, too, when the model workflow's steps name pages but no
 *   endpoint) and more than half of its own steps of that kind belong to it; a tie for the best waits for a recorded workflow link (listed
 *   in needsJudgement). A key workflow is credited at most once. A key workflow no single model workflow identifies is still identified
 *   when several model workflows, each lying wholly inside it (every one of its writes, or for a key workflow without writes every one of
 *   its endpoints, is the key workflow's), together cover all it needs: a key workflow names a feature ("Pay or cancel an order"), and an
 *   analysis that lists each of its actions as its own workflow has identified it (U3 asks whether the workflow is identified, PHASE 2
 *   spec 8.2, not at which granularity). A model workflow that mixes in another feature's writes never contributes, and nothing is
 *   composed from pages. Only screen journeys compose (owner decision): a part needs a step on a page the crawl saw, so a list of one
 *   workflow per endpoint cannot add up to a key workflow.
 * - U3-precision: model workflows that lie wholly inside one key workflow / model workflows (workflowPrecision below). U3 passes only
 *   when recall and precision both meet their targets: recall alone does not count workflows that lie outside the key or mix features.
 * - U4 defect rules: defect rules stated by at least one model rule that carries evidence or a source reference / defect rules. A model
 *   rule is linked first to the key rules whose requirement it cites (an evidence item naming the requirement id, e.g. "4.9#L1", or
 *   quoting its line) AND whose wording it shares: the rule's description and expectation share at least two content words with the key
 *   statement, and at least half of the smaller of the two word sets (key statements often add detail from neighbouring lines, so half of
 *   the key's words alone would refuse a correct short rule). Content words: the text lower-cased and split on anything but letters and
 *   digits; one-letter words and the function words of STOP_WORDS dropped; a final "s" dropped from words of four letters or more
 *   ("totals" = "total"). The wording check keeps a different rule from the same requirement line from being linked by its citation
 *   alone. Failing that, a rule is linked to the key
 *   rules it shares endpoints with; failing that, workflows; failing that, entities. One candidate links; several (or none) wait for a
 *   recorded judgement, which never overrides a deterministic link. "Explicit citing" also needs the rule explicit and one evidence item
 *   quoting the cited requirement line or naming its id.
 * - U5 provenance: rules with evidence or a source reference, explicitness matching the source type and a source other than "observed" /
 *   rules; plus rules confirmed without a person and rules sourced from observed behaviour.
 * - U6 wrong rules: recorded "contradicts" verdicts / reviewed rules, explicit and inferred apart; unreviewed rules listed.
 * - U7 incremental: decisions (confirmed, rejected) on rules read from text that did not change, found again with their rule / those
 *   decisions; a decision on a rule whose source the rerun changed must not follow (listed when it did); a rerun with no change makes no
 *   version and no AI call for unchanged sources; a rerun with one changed source re-processes exactly that source.
 *   "Found again" means the analysis matched the stored rule to a rule it read (same ref, same status, no "evidence gone" mark). A
 *   decision merely kept on the stored rule is reported apart ("kept") and does not count: a rule the analysis no longer recognises
 *   keeps its decision with "evidence gone", so "kept" is 1 whatever the matching does, while the rule read again arrives as a new
 *   unverified rule the person must decide about once more.
 */
import { explicitnessOf, type AppModel, type Rule, type RuleStatus } from "../../../engine/intel/model.js";
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
export type ScoredRule = Rule & { status: RuleStatus; decidedBy: string | null; evidenceGone?: unknown };

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

/** U1. Screens the harness marks as not reachable by any crawl (`notReachable`, answer-key screen ids) are left out and listed. */
export function screenRecall(model: AppModel, key: AnswerKey, notReachable: string[] = []): Ratio & { notReachable?: string[] } {
    const screens = key.screens.filter((s) => !notReachable.includes(s.id));
    const missed = screens.filter((s) => !model.pages.some((p) => matchesPath(s.path, p.path))).map((s) => s.id);
    const left = key.screens.filter((s) => notReachable.includes(s.id)).map((s) => s.id).sort();
    return { ...ratio(screens.length - missed.length, screens.length, missed), ...(left.length ? { notReachable: left } : {}) };
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
        // A model workflow whose steps name pages but no endpoint is matched on the key workflow's screens.
        if (endpoints.length === 0) {
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

/**
 * Key workflows identified by several model workflows together: each part lies wholly inside the key workflow (all its writes are the
 * key workflow's writes; for a key workflow without writes, all its endpoints are the key workflow's endpoints), and the parts together
 * cover every one of them. Matched on endpoints, never pages; but a part must be a screen journey: at least one of its steps names a page
 * the crawl saw (a page of the model, by id or path). A list of endpoints with no page never composes; it can still identify a key
 * workflow one-to-one.
 */
function composedWorkflows(model: AppModel, key: AnswerKey): Set<string> {
    const isWrite = (e: string) => {
        const m = parseEndpoint(e).method;
        return m !== null && m !== "GET";
    };
    const out = new Set<string>();
    const seen = (page: string) => model.pages.some((p) => p.id === page || matchesPath(p.path, page));
    const stepsOf = model.workflows.map((w) => (w.steps.some((s) => s.page && seen(s.page)) ? [...new Set(w.steps.flatMap((s) => (s.endpoint ? [s.endpoint] : [])))] : []));
    for (const kw of key.workflows) {
        const writes = kw.endpoints.filter(isWrite);
        const need = writes.length > 0 ? writes : kw.endpoints;
        if (need.length < 2) continue;
        const parts = stepsOf.map((eps) => (writes.length > 0 ? eps.filter(isWrite) : eps)).filter((have) => have.length > 0 && have.every((h) => need.some((n) => endpointMatches(n, h))));
        if (need.every((n) => parts.some((have) => have.some((h) => endpointMatches(n, h))))) out.add(kw.id);
    }
    return out;
}

/**
 * U3-precision: model workflows that are genuine / model workflows. A model workflow is genuine when it lies wholly inside one answer-key
 * workflow, by the test the composition rule uses: every write it sends is that key workflow's write; a workflow that writes nothing,
 * every endpoint it uses is that key workflow's endpoint. So it mixes in no other feature's writes. A model workflow whose steps name no
 * endpoint is judged on its step pages, as the one-to-one rule does: every page is a screen of that key workflow. A model workflow that
 * touches nothing any key workflow has (none of its endpoints, or with no endpoint none of its pages) is not genuine: the answer key lists
 * the app's workflows, so it is not one of them; it is listed in `outsideKey` too. A model workflow whose steps name neither a page nor
 * an endpoint gives nothing to compare: a recorded workflow link decides (a key workflow: genuine; null: not), and without one it is
 * listed in `needsJudgement` and counted as not genuine, so `value` is the lowest the precision can be.
 */
export function workflowPrecision(model: AppModel, key: AnswerKey, judgements?: Judgements): Ratio & { outsideKey: string[]; needsJudgement: string[] } {
    const isWrite = (e: string) => {
        const m = parseEndpoint(e).method;
        return m !== null && m !== "GET";
    };
    const pagePath = new Map(model.pages.map((p) => [p.id, p.path]));
    const screenPath = new Map(key.screens.map((s) => [s.id, s.path]));
    const keyScreens = key.workflows.map((kw) => kw.screens.map((id) => screenPath.get(id) ?? "").filter(Boolean));
    const within = (have: string[], allowed: string[], match: (n: string, h: string) => boolean) => have.length > 0 && have.every((h) => allowed.some((n) => match(n, h)));
    const genuine: string[] = [];
    const notGenuine: string[] = [];
    const outsideKey: string[] = [];
    const needsJudgement: string[] = [];
    const linked = new Map((judgements?.workflowLinks ?? []).map((l) => [l.workflowId, l.keyWorkflowId]));
    for (const w of model.workflows) {
        const endpoints = [...new Set(w.steps.flatMap((s) => (s.endpoint ? [s.endpoint] : [])))];
        const writes = endpoints.filter(isWrite);
        const pages = [...new Set(w.steps.flatMap((s) => (s.page ? [pagePath.get(s.page) ?? s.page] : [])))];
        let inside: boolean;
        let touches = true;
        if (endpoints.length === 0 && pages.length === 0) {
            inside = Boolean(linked.get(w.id));
            if (!linked.has(w.id)) needsJudgement.push(w.id);
        } else if (endpoints.length > 0) {
            inside = key.workflows.some((kw) => (writes.length > 0 ? within(writes, kw.endpoints.filter(isWrite), endpointMatches) : within(endpoints, kw.endpoints, endpointMatches)));
            touches = endpoints.some((h) => key.workflows.some((kw) => kw.endpoints.some((n) => endpointMatches(n, h))));
        } else {
            inside = keyScreens.some((screens) => within(pages, screens, matchesPath));
            touches = pages.some((h) => keyScreens.some((screens) => screens.some((n) => matchesPath(n, h))));
        }
        (inside ? genuine : notGenuine).push(w.id);
        if (!touches) outsideKey.push(w.id);
    }
    return { ...ratio(genuine.length, model.workflows.length, notGenuine), outsideKey: outsideKey.sort(), needsJudgement: needsJudgement.sort() };
}

export function workflowRecall(model: AppModel, key: AnswerKey, catalogueWorkflows: string[], judgements?: Judgements): Ratio & { needsJudgement: string[] } {
    const { assigned, needsJudgement } = assignWorkflows(model, key, judgements);
    const found = new Set([...assigned.values(), ...composedWorkflows(model, key)]);
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

/** Function words left out of the wording check (U4). */
const STOP_WORDS = new Set(
    "an the and or but nor of to in on at by for from with without into than then that this these those is are was were be been being has have had do does did it its as if so not no any all each every both either can cannot may must should will would only also more most less very same other such their there they them we you your our".split(" "),
);
/** The content words of a text, as the file header defines them. */
export function contentWords(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
            .map((w) => (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
    );
}
/** The rule's description and expectation share at least two content words with the key statement, and at least half of the smaller set. */
function sharesWording(r: Rule, statement: string): boolean {
    const key = contentWords(statement);
    const rule = contentWords(`${r.description} ${r.expected}`);
    const shared = [...key].filter((w) => rule.has(w)).length;
    return shared >= 2 && shared * 2 >= Math.min(key.size, rule.size);
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
    const lines = (opts.requirementsText ?? "").split(/\r?\n/);
    const links: Record<string, string> = {};
    const needsJudgement: string[] = [];
    for (const r of rules) {
        // A rule's workflow is a model workflow id (mapped to the key workflows it identifies) or, failing that, read as a key id.
        const keyWorkflows = new Set(r.workflows.flatMap((w) => (modelWorkflows.has(w) ? (assigned.has(w) ? [assigned.get(w)!] : []) : [slug(w)])));
        const keyEntities = new Set(r.entities.flatMap(keyEntity));
        const tiers: Array<(k: AnswerKey["rules"][number]) => boolean> = [
            (k) => citesLine(r, k.requirement, lines) && sharesWording(r, k.statement),
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
    /** The source refs (requirement records) the one-change rerun edited: decisions on their rules must not follow. */
    changedSourceRefs?: string[];
    /** A rerun with no source changed. */
    noChange?: { newVersion: boolean; aiCallsForUnchangedSources: number };
    /** A rerun with one source changed: which changed, which were re-processed (source kinds or refs). */
    oneChanged?: { changed: string[]; reprocessed: string[] };
}

export function incremental(input: IncrementalInput): {
    /** Decisions on rules from unchanged text found again with their rule. */
    decisions: Ratio;
    /** Decisions still on the stored rule, found again or not (reported, not judged). */
    kept: Ratio;
    /** Decisions on rules whose source changed, and those that followed anyway (should be none). */
    changedText: { decided: number; carried: string[] };
    noChange?: { newVersion: boolean; aiCallsForUnchangedSources: number; ok: boolean };
    oneChanged?: { extra: string[]; missing: string[]; ok: boolean };
} {
    // A stored rule keeps its ref across analyses (carry-forward.ts), so the same ref is the same stored rule.
    const after = new Map(input.after.map((r) => [r.ref, r]));
    const changed = new Set(input.changedSourceRefs ?? []);
    const decided = input.before.filter((r) => r.status !== "unverified");
    const followed = (r: ScoredRule) => {
        const a = after.get(r.ref);
        return Boolean(a && a.status === r.status && !a.evidenceGone);
    };
    const same = decided.filter((r) => !changed.has(r.sourceRef));
    const missed = same.filter((r) => !followed(r)).map((r) => r.ref);
    const lost = decided.filter((r) => after.get(r.ref)?.status !== r.status).map((r) => r.ref);
    const moved = decided.filter((r) => changed.has(r.sourceRef));
    const out: ReturnType<typeof incremental> = {
        decisions: ratio(same.length - missed.length, same.length, missed),
        kept: ratio(decided.length - lost.length, decided.length, lost),
        changedText: { decided: moved.length, carried: moved.filter(followed).map((r) => r.ref).sort() },
    };
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
    /** Answer-key screen ids no crawl can reach (the benchmark app's harness settings): left out of U1. */
    notReachableScreens?: string[];
    incremental?: IncrementalInput;
}

export interface UnderstandingScore {
    app: string;
    answerKeySha256: string;
    screens: ReturnType<typeof screenRecall>;
    endpoints: ReturnType<typeof endpointRecall>;
    workflows: ReturnType<typeof workflowRecall>;
    workflowPrecision: ReturnType<typeof workflowPrecision>;
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
        screens: screenRecall(model, key, input.notReachableScreens),
        endpoints: endpointRecall(model, key),
        workflows: workflowRecall(model, key, input.catalogueWorkflows, judgements),
        workflowPrecision: workflowPrecision(model, key, judgements),
        defectRules: defectRuleRecall(model, rules, key, { requirementsText: input.requirementsText, judgements }),
        provenance: provenance(rules),
        wrongRules: wrongRules(rules, judgements),
        ...(input.incremental ? { incremental: incremental(input.incremental) } : {}),
    };
}
