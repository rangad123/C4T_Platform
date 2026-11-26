/**
 * Miss analysis (testing-engine Phase 7 B4, PHASE_5_7_SPEC §7.1 item 3): for each seed a trial missed, the stage it was lost at, and for
 * each false positive its source. ROW233-ROOT-CAUSE.md's method in code (its r233/tally.py), from the result and the saved platform data
 * (effectiveness.ts readSavedTrial), never from a model.
 *
 * A sighting of a seed is a test whose author described the seed's wrong behaviour (the seed's signature over the test's title and the
 * "Observed:" part of the author's explanation), or a finding a person labelled with the seed. Each sighting is lost at one stage:
 *
 *   misclassified        Phase 5 classified the finding as something other than an application defect
 *   weak_assertion       a finding whose saved test passes on the seeded app (observed only: no failing check kept)
 *   reproduction_failed  a finding that fails on the clean app too (the test leans on earlier state), one no single seed makes fail,
 *                        one confirmed for another seed, or a test the engine held back because it depends on earlier state
 *   not_executed         a test that never became a finding: its own-steps replay stopped (timeout, ERR_ABORTED) or validation failed
 * A seed without a sighting is lost before any test saw it:
 *   layer_unavailable    the layer the seed shows in was not checked (C12 layer report)
 *   context_insufficient no rule from the seed's requirement reached the planner (the app model has none, or no rules at all)
 *   not_generated        the rule was there, but no test exercised the seed's trigger and saw it
 * The seed's main stage in a trial is the stage with the most sightings; a tie goes to the stage further down the pipeline (STAGES order).
 *
 * A false positive's source: `state` (the test leans on what the account held before: leftovers, the engine's state events or its
 * reason, or its author saw a seed, ROW233 §4), `assumption` (its expectation cites no requirement and pursues no objective: the AI's own), else `observation` (the
 * expectation is stated, the app is right there: the check or the observation was wrong).
 */
import type { Layer } from "../../engine/validation/layers.js";
import type { CatalogueDefect } from "./catalogue.js";
import { eventTestKey, type SavedTrial } from "./effectiveness.js";
import { notReportedByEngine } from "./metrics.js";
import type { BenchAppResult, BenchFinding, ReplayVerdict } from "./schema.js";

/** Pipeline order: a tie in sightings goes to the later stage. */
export const STAGES = ["context_insufficient", "not_generated", "layer_unavailable", "not_executed", "weak_assertion", "reproduction_failed", "misclassified"] as const;
export type Stage = (typeof STAGES)[number];

type Field = "title" | "obs" | "both";
/** One condition: the field (obs:N = the first N characters of the observation) matches, or with `false` must not. */
type Cond = readonly [Field | `obs:${number}`, RegExp, boolean?];
const r = (s: string) => new RegExp(s, "is");

/**
 * Per seed: the requirement of the bench's requirements document it breaks (the doc's own numbering, which the answer keys do not use)
 * and the signature of its wrong behaviour. bench-shop's are ROW233's tally (hand-checked there, ±10% recall). bench-rbac's were
 * hand-checked on five paid rbac trials (2026-11-23/24, 98 author explanations): every explanation of BR-01, BR-07 and BR-08 behaviour
 * matches, no other explanation does. No author explanation in them showed BR-02 … BR-06 (those seeds were caught only
 * by the deterministic checks, which keep no explanation), so their signatures are tightened from the catalogue's wording to match none
 * of the 98 that do not describe them (the owner's own edits, the admin's People page).
 */
export const SEED_SIGNS: Record<string, { requirement: string; sign: readonly Cond[] }> = {
    "BS-01": { requirement: "4.1", sign: [["both", r("save10|discount")], ["obs", r("(−|-)\\s?\\$\\d")], ["obs", r("10 ?% of|instead of|not (the )?(−|-)?\\$|expected (−|-)?\\$|which (is|does) not|too small|first (cart )?line|only th|does not match|not 10|is not 10|rather than")]] },
    "BS-02": { requirement: "3.9", sign: [["obs", r("sum of (the |its |their )?(visible )?line|line totals? (sum|add|total)|their sum|sum is \\$|lines? totals? \\$[\\d.]+ \\+|lines total|sum \\$")], ["obs", r("but|however|instead|whereas|while the|not equal|does not|apparently|less\\)|left out|missing|≠|is \\$[\\d.]+ less")], ["obs", r("equals the sum|matches the sum|which equals"), false]] },
    "BS-03": { requirement: "3.6", sign: [["title", r("up to 10|above 10|more than 10|over 10|limit|refuse|exceed|beyond 10|an 11th|\\b11\\b")], ["obs", r("(\\b11\\b|11th).{0,250}(accepted|was not refused|did not refuse|no .{0,40}message|not enforced|did not show|added .{0,30}at quantity 11|shows? .{0,30}quantity 11|now shows quantity 11|line (now |became )?(shows )?quantity 11|became quantity 11|changed to quantity 11)|limit not enforced|app (accepted|did not refuse)")]] },
    "BS-04": { requirement: "1.6", sign: [["title", r("email")], ["both", r("invalid|malformed|not.an.email|no at sign")], ["obs", r("accepted|account (was )?created|created the account|signed (the user )?in|navigated|was not refused|led to the home|never appeared|did not show")], ["title", r("empty name|blank name|password shorter"), false]] },
    "BS-05": { requirement: "6.8", sign: [["obs", r("shipped")], ["obs", r("cancel")], ["obs", r('(status|it) (changed to|became|is now|shows?) "?cancelled|cancelling .{0,40}succeed|was cancelled')], ["obs:200", r("placed order|ord-10(0[2-9]|[1-9]\\d)"), false]] },
    "BS-06": { requirement: "7.3", sign: [["title", r("account|address|name|profile|saved")], ["obs", r("saved")], ["obs", r("(reload|sign(ing)? (out|in) again|signing in again|navigat|next checkout|after .{0,30}(reload|sign)).{0,250}(old|original|previous|revert|still shows the (old|original)|did not persist|not persist|instead of|came back|was lost|not kept)|did not persist|reverts? to")]] },
    "BS-07": { requirement: "5.8", sign: [["obs", r("plac")], ["obs", r('after (placing|place order|the order).{0,160}(cart|/cart).{0,80}(still|not (been )?(emptied|empty|cleared))|cart (was |is )?not (emptied|cleared)|was not emptied|placed a second|second (identical )?order|(again|second time).{0,80}(created|placed) (order )?ord-|instead of showing "your cart is empty"')]] },
    "BS-08": { requirement: "6.6", sign: [["obs", r("(belongs to (another|a different) (customer|person|user)|another customer.s order|other customer.s order|other person.s order).{0,300}(display|shows|showed|opened|loads|visible|instead of)|ord-1001.{0,120}(opens|is shown|detail page)")], ["obs:150", r('shows? "?order not found'), false]] },
    "BS-09": { requirement: "3.4", sign: [["obs", r("(unknown|non-?existent|does not exist|invalid|fake|nope) product.{0,250}(200|accepted|no error|not refused|ok)")]] },
    "BS-10": { requirement: "5.4", sign: [["obs", r("checkout/review")], ["obs", r('did not (send|redirect|go back)|does not send|did NOT send|not redirect|showed the .{0,30}review your order|empty "?deliver to|place order" button with an empty|stayed on /checkout/review|instead of sending')]] },
    "BS-11": { requirement: "4.5", sign: [["obs", r("exactly \\$?50(\\.00)?|reaches exactly|\\$50\\.00 subtotal|subtotal (of |is |reaches )?\\$50\\.00|at \\$50\\.00")], ["obs", r("(shipping|charge).{0,60}\\$5\\.00|\\$5\\.00.{0,40}shipping|still (shows|charges) shipping|not free|instead of free")]] },
    "BS-12": { requirement: "6.3", sign: [["obs", r("orders? (list|page)|/orders")], ["obs", r("(does not|doesn.t|did not|never) (list|show|include|contain|appear)|is missing from|not listed|not in the (orders )?list|missing: the list|is not listed|newest row is|never appears in|omits")], ["obs", r("ord-1001"), false]] },
    "BR-01": { requirement: "3.8", sign: [["obs", r("(another|other|someone else.s|not (the )?owner|not shared).{0,200}note.{0,200}(opened|shown|showed|shows|displayed|visible|loaded|could (read|open|see)|200)")]] },
    "BR-02": { requirement: "3.10", sign: [["obs", r("\\b(as|signed in as|the) (colleague|person (it|the note) (is|was) shared with|shared (user|person|account)|non-?owner|account (it|the note) (is|was) shared with)[^.]{0,200}(PUT|changed|updated|saved)[^.]{0,100}(200|accepted|succeeded|was saved|took effect)")]] },
    "BR-03": { requirement: "5.3", sign: [["obs", r("/api/admin/users|people (list|api)|list of (people|accounts|users|everyone)")], ["obs", r("(user|manager|non-?admin|not an admin)[^.]{0,200}(200|received|returned|got)[^.]{0,80}(list|emails|roles)")]] },
    "BR-04": { requirement: "5.4", sign: [["obs", r("manager.{0,250}(changed|made .{0,30}admin|role (became|changed|is now)|accepted|200)")]] },
    "BR-05": { requirement: "2.12", sign: [["obs", r("(sign(ed|ing)? out|logout|log(ged)? out).{0,300}(still (works|worked|valid|gives|gave)|old (session|cookie).{0,80}(works|worked|accepted|200)|200)")]] },
    "BR-06": { requirement: "4.6", sign: [["obs", r("(stop(ped)? sharing|removed|unshar).{0,300}(still (read|open|see|access)|could (still )?(read|open)|200)")]] },
    "BR-07": { requirement: "2.7", sign: [["both", r("password")], ["obs", r("(short|[1-7].character|three.character|seven.character|fewer than 8|less than 8).{0,250}(accepted|created|signed in|was not refused|no (error|message)|not enforced)|accepted a password (below|under|shorter than)")]] },
    "BR-08": { requirement: "3.4", sign: [["both", r("title")], ["obs", r("(empty|blank|no|without( a)?) title.{0,250}(created|accepted|201|saved|was not refused|no (error|message))|(saved|created) (the |a )?note (with (an? )?(empty|blank) title|without (a )?title)|\\(untitled\\)")]] },
};

/** The layer a catalogue category shows in, for the extension seeds (catalogue 2026-11-21.1); other categories show on the page. */
const LAYER_OF: Record<string, Layer> = {
    "frontend-api-consistency": "api",
    "response-schema": "api",
    "sensitive-data": "api",
    "rate-limiting": "api",
    "api-contract": "api",
    concurrency: "api",
    transaction: "storedData",
    "referential-integrity": "database",
    "unique-constraint": "database",
};

export interface Sighting {
    testKey: string;
    stage: Stage;
    detail: string;
}
export interface SeedMiss {
    seed: string;
    stage: Stage;
    detail: string;
    sightings: Sighting[];
}
export interface FpSource {
    testKey: string;
    source: "state" | "assumption" | "observation";
    detail: string;
}
export interface MissAnalysis {
    seeds: SeedMiss[];
    falsePositives: FpSource[];
}

const failing = (v: ReplayVerdict | null | undefined) => v === "failed" || v === "finding";
const get = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function matches(sign: readonly Cond[], title: string, obs: string): boolean {
    return sign.every(([f, re, want = true]) => {
        const text = f === "title" ? title : f === "both" ? `${title}${obs}` : f === "obs" ? obs : obs.slice(0, Number(f.slice(4)));
        return re.test(text) === want;
    });
}

/** The stage of the seed with the most sightings (tie: the later stage). */
export const mainStage = (counts: Partial<Record<Stage, number>>): Stage =>
    STAGES.reduce<Stage | undefined>((best, s) => ((counts[s] ?? 0) > 0 && (!best || (counts[s] ?? 0) >= (counts[best] ?? 0)) ? s : best), undefined) ?? "not_generated";

export function missAnalysis(trial: BenchAppResult, saved: SavedTrial, catalogue: ReadonlyArray<Pick<CatalogueDefect, "id" | "category"> & { requirement?: unknown }>): MissAnalysis {
    const byId = new Map(trial.findings.map((f) => [f.id, f]));
    const verified = new Map((trial.verification?.findings ?? []).filter((f) => f.testId).map((f) => [f.testId!, f]));
    const kinds = new Map<string, Set<string>>();
    for (const e of saved.events) {
        const k = eventTestKey(e);
        if (k) kinds.set(k, (kinds.get(k) ?? new Set()).add(e.kind));
    }
    const stageOf = (key: string, id: string, f: BenchFinding | undefined, validationStatus: string): Omit<Sighting, "testKey"> => {
        const c = verified.get(id)?.findingClass;
        if (c && c !== "app_defect" && c !== "open" && f?.category !== "confirmed") return { stage: "misclassified", detail: `classified ${c}` };
        if (f) {
            if (f.category === "confirmed") return { stage: "reproduction_failed", detail: `confirmed for ${f.defects.join(", ")} instead` };
            if (!failing(f.replay.seeded)) return { stage: "weak_assertion", detail: f.capture === "observed_only" ? "observed only: no failing check saved" : "its saved check passes on the seeded app" };
            if (failing(f.replay.clean)) return { stage: "reproduction_failed", detail: "fails on the clean app too (leans on earlier state)" };
            return { stage: "reproduction_failed", detail: "no single seed makes it fail" };
        }
        const k = kinds.get(key);
        if (k?.has("defect_unverified")) return { stage: "not_executed", detail: "its own-steps replay stopped; not reported" };
        if (k?.has("depends_on_earlier_state")) return { stage: "reproduction_failed", detail: "held back: depends on earlier state" };
        return { stage: "not_executed", detail: `not a finding (${validationStatus || "no status"})` };
    };

    // Every test the author stopped as a defect or the harness judged: who it saw.
    const seen = new Map<string, Sighting[]>();
    const sighted = new Map<string, string[]>();
    for (const t of saved.tests) {
        const f = byId.get(t.id);
        if (get(t.meta, "authoring") !== "defect" && !f) continue;
        const explanation = str(get(t.meta, "explanation")) || (f ? (t.validationReason ?? "") : "");
        const obs = explanation.split("Observed:").slice(1).join("Observed:") || explanation;
        const title = `${t.title} ${str(get(t.meta, "scenario", "title"))}`;
        const add = (seed: string) => {
            const list = seen.get(seed) ?? [];
            if (!list.some((s) => s.testKey === t.key)) list.push({ testKey: t.key, ...stageOf(t.key, t.id, f, t.validationStatus) });
            seen.set(seed, list);
            sighted.set(t.id, [...(sighted.get(t.id) ?? []), seed]);
        };
        for (const [seed, s] of Object.entries(SEED_SIGNS)) if (trial.seededDefects.includes(seed) && matches(s.sign, title, obs)) add(seed);
        if (f?.label && f.label !== "false_positive") add(f.label);
    }

    const defects = new Map(catalogue.map((d) => [d.id, d]));
    const seeds = trial.defects
        .filter((d) => !d.detected)
        .map((d): SeedMiss => {
            const sightings = seen.get(d.id) ?? [];
            if (sightings.length) {
                const counts: Partial<Record<Stage, number>> = {};
                for (const s of sightings) counts[s.stage] = (counts[s.stage] ?? 0) + 1;
                const stage = mainStage(counts);
                return { seed: d.id, stage, detail: `${counts[stage]} of ${sightings.length} sightings`, sightings };
            }
            const layer = LAYER_OF[defects.get(d.id)?.category ?? d.category];
            const state = layer && saved.layers?.[layer];
            if (state && state.status === "unavailable") return { seed: d.id, stage: "layer_unavailable", detail: `${layer}: ${state.reason}`, sightings };
            const requirement = SEED_SIGNS[d.id]?.requirement ?? (str(defects.get(d.id)?.requirement) || undefined);
            if (!saved.rules) return { seed: d.id, stage: "context_insufficient", detail: "the trial's app model has no rules (none reached the planner)", sightings };
            if (requirement && !saved.rules.some((x) => x.sourceRef === requirement)) return { seed: d.id, stage: "context_insufficient", detail: `no rule from requirement ${requirement} reached the planner`, sightings };
            return { seed: d.id, stage: "not_generated", detail: requirement ? `rule ${requirement} was there; no test saw the seeded behaviour` : "no test saw the seeded behaviour (the seed's requirement is not known here)", sightings };
        });

    const tests = new Map(saved.tests.map((t) => [t.id, t]));
    const falsePositives = trial.findings
        .filter((f) => !notReportedByEngine(f) && (f.category === "false_positive" || (f.category === "unreproduced" && f.label === "false_positive")))
        .map((f): FpSource => {
            const meta = tests.get(f.id)?.meta;
            const k = kinds.get(f.testKey);
            const leftovers = get(meta, "leftovers");
            if ((Array.isArray(leftovers) && leftovers.length) || k?.has("depends_on_earlier_state") || k?.has("leftover_redo") || /depends on what the account held|earlier state|leftover/i.test(f.reason ?? ""))
                return { testKey: f.testKey, source: "state", detail: "leans on what the account held before the test" };
            // ROW233 §4: a test whose author saw a seed and that fails on the clean app too asserts what the shared account held.
            if (sighted.has(f.id)) return { testKey: f.testKey, source: "state", detail: `its author saw ${sighted.get(f.id)!.join(", ")}; it fails on the clean app too` };
            const reqs = get(meta, "scenario", "requirements");
            if (!(Array.isArray(reqs) && reqs.length) && !get(meta, "scenario", "objective") && !f.candidate?.objective) return { testKey: f.testKey, source: "assumption", detail: "its expectation cites no requirement" };
            return { testKey: f.testKey, source: "observation", detail: "a stated expectation the app meets: the check or the observation was wrong" };
        });
    return { seeds, falsePositives };
}

/**
 * Each seed's main stage over several trials, as ROW233 ranks them: the stage with the most sightings over all the trials that missed it;
 * a seed never sighted takes its most frequent trial stage. Ties go to the later stage.
 */
export function mainStages(trials: readonly MissAnalysis[]): Record<string, Stage> {
    const sightings = new Map<string, Partial<Record<Stage, number>>>();
    const unsighted = new Map<string, Partial<Record<Stage, number>>>();
    for (const t of trials)
        for (const s of t.seeds) {
            const into = (m: typeof sightings, st: Stage) => {
                const c = m.get(s.seed) ?? {};
                c[st] = (c[st] ?? 0) + 1;
                m.set(s.seed, c);
            };
            if (s.sightings.length) for (const x of s.sightings) into(sightings, x.stage);
            else into(unsighted, s.stage);
        }
    const ids = [...new Set([...sightings.keys(), ...unsighted.keys()])].sort();
    return Object.fromEntries(ids.map((id) => [id, mainStage(sightings.get(id) ?? unsighted.get(id)!)]));
}
