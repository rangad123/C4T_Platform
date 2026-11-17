/**
 * The one place fragments meet: every source's fragment merged into one application model, plus the rules they found.
 *
 * - Pages are one per path, endpoints one per method and path, entities one per name, workflows and scenarios one per id, roles one per
 *   name. Links to a page or entity that was folded into another point at the one kept.
 * - An endpoint an OpenAPI document describes takes the document's record; traffic that showed it stays as evidence. An endpoint seen
 *   only in traffic stays "observed". Only endpoints a fragment lists are recorded: a request named elsewhere (a control, a rule, a
 *   workflow step) never becomes one.
 * - A workflow only the exploration found becomes stated when stated rules read from a document belong to it: it cites their lines.
 * - Rules are one per fingerprint; a rule a source states wins over a guessed one. An entity takes the source type of a source that
 *   names it over one that only infers it.
 * - The result does not depend on the order of the fragments: they are put in one fixed order first.
 * - Whatever a limit cuts off is listed as missing context, never dropped silently.
 *
 * Fragments are the whole input: every connected source's fragment is passed in (a source not re-processed passes its last fragment).
 * `previous` only decides `changed`. The application version is set by the caller.
 */
import { HIDDEN } from "../../shared/redact-text.js";
import type { ModelFragment } from "./fragment.js";
import { missingContext, type MissingContextOptions } from "./missing-context.js";
import { AppModelSchema, CONTEXT_SOURCES, endpointKey, ruleFingerprint, SOURCE_KINDS, STATING_SOURCES, type AppModel, type Endpoint, type Evidence, type MissingContext, type Rule } from "./model.js";

export interface MergeResult {
    model: AppModel;
    rules: Rule[];
    /** False when the merged model equals `previous` (ignoring the application version and when sources were processed). */
    changed: boolean;
}

const MAX_RULES = 2000;

/** JSON with object keys sorted, so equal content gives equal text. */
const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const norm = (t: string) => t.trim().toLowerCase();

/** Groups items by key, keeping first-seen order of keys and of items within a key. */
function group<T>(xs: readonly T[], key: (x: T) => string): T[][] {
    const m = new Map<string, T[]>();
    for (const x of xs) {
        const k = key(x);
        const g = m.get(k);
        if (g) g.push(x);
        else m.set(k, [x]);
    }
    return [...m.values()];
}

const union = <T>(...lists: (readonly T[] | undefined)[]): T[] => group(lists.flatMap((l) => l ?? []), stable).map((g) => g[0]!);
const first = <T>(xs: readonly (T | undefined)[]): T | undefined => xs.find((x) => x !== undefined && x !== "");

export function merge(previous: AppModel | undefined, fragments: readonly ModelFragment[], o: MissingContextOptions = {}): MergeResult {
    const cut = new Map<string, { n: number; max: number; per: string }>();
    const cap = <T>(xs: T[], max: number, what: string, per: string): T[] => {
        if (xs.length <= max) return xs;
        const c = cut.get(what) ?? { n: 0, max, per };
        c.n += xs.length - max;
        cut.set(what, c);
        return xs.slice(0, max);
    };
    const evidence = (lists: (readonly Evidence[] | undefined)[], max = 20) => cap(union(...lists), max, "Evidence items", "item");

    // One fixed order: by source kind, then reference, then content.
    const fs = [...fragments]
        .map((f) => ({ f, key: stable(f) }))
        .sort((a, b) => SOURCE_KINDS.indexOf(a.f.source.kind) - SOURCE_KINDS.indexOf(b.f.source.kind) || cmp(a.f.source.ref, b.f.source.ref) || cmp(a.key, b.key))
        .map((x) => x.f);
    const all = <K extends keyof AppModel>(k: K) => fs.flatMap((f) => f.model[k] as AppModel[K] & unknown[]) as AppModel[K];

    // Pages: one per path; the ids folded away are remembered so links follow the page kept.
    const pageId = new Map<string, string>();
    const pages = group(all("pages"), (p) => p.path).map((g) => {
        const kept = g[0]!;
        for (const p of g) pageId.set(p.id, kept.id);
        const reachableBy = union(...g.map((p) => p.reachableBy));
        return {
            ...kept,
            purpose: first(g.map((p) => p.purpose)) ?? "",
            requiresSignIn: first(g.map((p) => p.requiresSignIn)),
            screenId: first(g.map((p) => p.screenId)),
            reachableBy: reachableBy.length ? cap(reachableBy, 20, "Roles reaching a page", "page") : undefined,
            elements: cap(union(...g.map((p) => p.elements)), 300, "Page elements", "page"),
            forms: cap(union(...g.map((p) => p.forms)), 30, "Forms", "page"),
            structures: cap(union(...g.map((p) => p.structures)), 100, "Dialogs, menus and tables", "page"),
            interactions: cap(union(...g.map((p) => p.interactions)), 200, "Requests by control", "page"),
        };
    });
    const page = (id: string) => pageId.get(id) ?? id;

    // Entities: one per name.
    const entityId = new Map<string, string>();
    const entities = group(all("entities"), (e) => norm(e.name)).map((g) => {
        const kept = g[0]!;
        for (const e of g) entityId.set(e.id, kept.id);
        const fields = group(g.flatMap((e) => e.fields), (f) => norm(f.name)).map((fg) => ({
            ...fg[0]!,
            type: first(fg.map((f) => f.type)),
            constraints: cap(union(...fg.map((f) => f.constraints)), 20, "Field constraints", "field"),
        }));
        // A source that names the entity wins over one that only infers it (as for workflows and rules); the id stays the first one's.
        const named = g.find((e) => e.sourceType && STATING_SOURCES.has(e.sourceType)) ?? g.find((e) => e.sourceType);
        const provenance = named ? { sourceType: named.sourceType, explicitness: named.explicitness } : {};
        return { ...kept, ...provenance, fields: cap(fields, 100, "Entity fields", "entity"), evidence: evidence(g.map((e) => e.evidence)) };
    });
    const entity = (id: string) => entityId.get(id) ?? id;

    // Endpoints: one per method and path; the document's record wins, every evidence item is kept (the document's first).
    const endpoints = group(all("endpoints"), endpointKey).map((g): Endpoint => {
        const ordered = [...g.filter((e) => e.origin === "documented"), ...g.filter((e) => e.origin !== "documented")];
        return { ...ordered[0]!, method: ordered[0]!.method.toUpperCase(), evidence: evidence(ordered.map((e) => e.evidence)) };
    });

    // Workflows: one per id; one a source states wins over one inferred or observed. An id that was hidden names nothing: such a
    // workflow is one per content, never folded into another whose id was hidden too.
    // A workflow no source states (one the exploration followed) that a stated rule read from a document belongs to is described by
    // that rule's lines: it cites them and takes the rule's source type, keeping its own steps. Only a rule's quote that was checked
    // against the lines it cites when it was read (it has the anchor extract/rules.ts gives it) is cited; nothing else makes one stated.
    const citing = new Map<string, Rule[]>();
    for (const r of fs.flatMap((f) => f.rules)) {
        if (r.explicitness !== "explicit" || !STATING_SOURCES.has(r.sourceType) || !r.anchor || r.evidence[0]?.kind !== "quote") continue;
        for (const id of new Set(r.workflows)) citing.set(id, [...(citing.get(id) ?? []), r]);
    }
    const workflows = group(all("workflows"), (w) => (w.id.includes(HIDDEN) ? stable(w) : w.id)).map((g) => {
        const kept = g.find((w) => STATING_SOURCES.has(w.sourceType)) ?? g[0]!;
        const steps = kept.steps.map((s) => (s.page ? { ...s, page: page(s.page) } : s));
        const cites = STATING_SOURCES.has(kept.sourceType) || kept.id.includes(HIDDEN) ? [] : (citing.get(kept.id) ?? []);
        if (!cites.length) return { ...kept, steps, evidence: evidence(g.map((w) => w.evidence)) };
        const quotes = cites.map((r) => ({ ev: r.evidence[0]!, anchor: { ref: r.evidence[0]!.ref, ...r.anchor! } }));
        const ev = evidence([quotes.map((q) => q.ev), ...g.map((w) => w.evidence)]);
        const anchors = union(quotes.filter((q) => ev.some((e) => stable(e) === stable(q.ev))).map((q) => q.anchor)).slice(0, 20);
        return { ...kept, steps, sourceType: (cites.find((r) => r.sourceType === "requirement") ?? cites[0]!).sourceType, evidence: ev, anchors };
    });

    const scenarios = group(all("scenarios"), (s) => s.id).map((g) => {
        const s = g[0]!;
        return { ...s, covers: { ...s.covers, pages: union(s.covers.pages.map(page)) } };
    });

    const relationships = group(
        all("relationships").map((r) => ({ ...r, from: entity(r.from), to: entity(r.to) })),
        (r) => stable([r.from, r.to, r.kind]),
    ).map((g) => ({ ...g[0]!, evidence: evidence(g.map((r) => r.evidence)) }));

    const navigation = group(
        all("navigation").map((n) => ({ ...n, from: page(n.from), to: page(n.to) })),
        (n) => stable([n.from, n.to, n.control]),
    ).map((g) => ({ ...g[0]!, evidence: evidence(g.map((n) => n.evidence), 5) }));

    const roles = group(all("roles"), (r) => norm(r.name)).map((g) => ({
        ...g[0]!,
        reaches: cap(union(...g.map((r) => r.reaches.map(page))), 200, "Pages a role reaches", "role"),
        differs: cap(union(...g.map((r) => r.differs)), 50, "Role differences", "role"),
        evidence: evidence(g.map((r) => r.evidence)),
    }));

    const transitions = group(
        all("transitions").map((t) => ({ ...t, entity: entity(t.entity) })),
        (t) => stable([t.entity, t.from, t.to, t.trigger, t.sourceType, t.expectation]),
    ).map((g) => ({ ...g[0]!, evidence: evidence(g.map((t) => t.evidence)) }));

    // Rules: one per fingerprint; stated before guessed, then the surest, then the fixed order.
    const rules = cap(
        group(
            fs.flatMap((f) => f.rules),
            ruleFingerprint,
        ).map((g) => {
            const kept = [...g].sort((a, b) => Number(b.explicitness === "explicit") - Number(a.explicitness === "explicit") || b.confidence - a.confidence)[0]!;
            return { ...kept, evidence: evidence(g.map((r) => r.evidence)) };
        }),
        MAX_RULES,
        "Rules",
        "analysis",
    );

    const sources = cap(
        group(
            fs.map((f) => f.source),
            (s) => stable([s.kind, s.ref]),
        ).map((g) => g[0]!),
        200,
        "Sources",
        "model",
    );

    const model = {
        appType: first(fs.map((f) => f.model.appType)) ?? "",
        contextSources: union(...fs.map((f) => f.model.contextSources)).sort((a, b) => CONTEXT_SOURCES.indexOf(a) - CONTEXT_SOURCES.indexOf(b)),
        pages: cap(pages, 2000, "Pages", "model"),
        workflows: cap(workflows, 500, "Workflows", "model"),
        entities: cap(entities, 500, "Entities", "model"),
        relationships: cap(relationships, 2000, "Relationships", "model"),
        scenarios: cap(scenarios, 2000, "Scenarios", "model"),
        endpoints: cap(endpoints, 2000, "Endpoints", "model"),
        navigation: cap(navigation, 5000, "Navigation links", "model"),
        roles: cap(roles, 50, "Roles", "model"),
        transitions: cap(transitions, 500, "State transitions", "model"),
        sources,
        missingContext: [] as MissingContext[],
    };

    const notes: MissingContext[] = [
        ...missingContext(model, sources, o),
        ...fs.flatMap((f) => [...f.model.missingContext, ...f.notes.map((text) => ({ text, source: f.source.kind }))]),
        ...[...cut].map(([what, c]) => ({ text: `${what}: ${c.n} left out, more than ${c.max} per ${c.per}.` })),
    ];
    const unique = group(notes, (m) => m.text).map((g) => g[0]!);
    model.missingContext = unique.length > 100 ? [...unique.slice(0, 99), { text: `${unique.length - 99} more notes about missing context are not shown.` }] : unique;

    const merged = AppModelSchema.parse(model);
    const comparable = (m: AppModel) => stable({ ...m, appVersion: undefined, sources: m.sources.map((s) => ({ ...s, processedAt: undefined })) });
    return { model: merged, rules, changed: !previous || comparable(AppModelSchema.parse(previous)) !== comparable(merged) };
}
