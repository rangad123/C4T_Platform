/**
 * Which tests a change would call for: a recommendation, never a decision. Nothing here starts, skips or chooses a run; a deploy
 * trigger still runs every runnable test (trigger-services.ts).
 *
 * A test is
 *   proposed          when one of its pages or endpoints (declared or observed, coverage.ts) is one the change names;
 *   proposed, unknown when nothing matches but its coverage is not complete (it may still reach the change: by a click, a request a
 *                     page makes, a step the mapping cannot read). A missing mapping never leaves a test out;
 *   not matched       only when its coverage is complete and none of it is in the change (each with its own reason);
 *   cannot run        its stored steps cannot be read, it has no approved version, runs hold it back because a shared part it uses
 *                     changed after its approval (held.ts), or the viewer's runner leaves it out of runs (each with its reason).
 * When anything is incomplete (entries past the limit, entries that are not a page or an endpoint, a test whose coverage is out of date
 * (coverage.ts freshnessOf) or not fully known, tests not judged because they cannot run on the viewer's runner, any test held back
 * because a shared part it uses changed after its approval (held.ts: the deploy then tests less than the project has), a deploy trigger whose
 * maker's runner can run a different set of tests or cannot be resolved (parity.ts)) the preview says a full run is required
 * (`fullRunRequired`, with the reasons). Nothing incomplete ever leaves a test out.
 * Matching follows the URL semantics written down in coverage.ts. When the API's base address has a path (`https://x.test/api`), `/items`
 * in a request step and `/api/items` seen in a page's traffic are the same endpoint.
 */
import type { TriggerParity } from "./parity.js";
import { fullRunRecommendation, riskOf, type ImpactSummary, type Risk, type RiskFacts } from "./risk.js";
import { UNKNOWN_SITE_LIMIT, isOwnHost, pageKey, parseEndpoint, splitAddress, type AppFacts, type CoverageItem, type CoverageSource, type HTTP_METHODS, type TestCoverage } from "./coverage.js";

export const RECOMMENDATION_NOTE = "This is a recommendation only. No test was skipped or run, and deploy triggers still run every runnable test.";
/** Entries of a change set the preview compares (pages and endpoints together). More is reported, never dropped silently. */
export const MAX_CHANGES = 200;

export interface ChangeItem {
    kind: "page" | "endpoint";
    /** As the person or the detected change wrote it. */
    given: string;
    path: string;
    method?: (typeof HTTP_METHODS)[number];
    host?: string;
    /** The host is not one of the application's: it matches only that host. */
    external?: true;
    /** Query parameter names the change names: a test must be known to use them (or keep no query names). */
    query: string[];
}

export interface Reason {
    change: string;
    matched: string;
    source: CoverageSource;
    seenIn: string[];
    sentence: string;
}

export interface PreviewTest {
    testId: string;
    testKey: string;
    title: string;
    kind: string;
    completeness: TestCoverage["completeness"];
    reasons: Reason[];
    /** Why it is in its group, for unknown, not-matched and cannot-run tests. */
    why?: string;
    /** What a deploy trigger does differently with this test (its maker's runner can or cannot run it). */
    notes?: string[];
    /** Proposed tests only: the risk score (risk.ts) they are ordered by, highest first. */
    risk?: Risk;
}

export interface Preview {
    recommendationOnly: true;
    note: string;
    changes: ChangeItem[];
    /** Entries that could not be read as a page or an endpoint, with why. */
    ignored: Array<{ given: string; why: string }>;
    /** Entries past MAX_CHANGES, as given: not compared with any test. */
    notProcessed: string[];
    /** Tests whose known pages or endpoints match the change (proposed). */
    matched: PreviewTest[];
    /** Tests proposed because their coverage is not fully known. */
    unknown: PreviewTest[];
    notMatched: PreviewTest[];
    /** Tests that cannot run (unreadable steps, or the viewer's runner leaves them out), with why. Not judged. */
    cannotRun: PreviewTest[];
    /** Changes no test's known coverage reaches. */
    uncoveredChanges: string[];
    /** The preview could not judge everything: only a full run is safe. */
    fullRunRequired: boolean;
    fullRunReasons: string[];
    /** Each active deploy trigger compared with the viewer's runner: the same tests, different ones, or not resolvable. */
    triggers: Array<{ trigger: string; parity: "same" | "different" | "unresolved"; why?: string }>;
    /** proposed = matched + unknown: every test the preview recommends (it runs nothing). */
    counts: { tests: number; matched: number; unknown: number; proposed: number; notMatched: number; cannotRun: number };
}

/** Read the person's (or the detected) change set. Duplicates are dropped; entries past MAX_CHANGES are returned in `notProcessed`. */
export function readChanges(input: { pages?: string[]; endpoints?: string[] }, app: AppFacts | string = {}): { changes: ChangeItem[]; ignored: Preview["ignored"]; notProcessed: string[] } {
    const facts: AppFacts = typeof app === "string" ? { appHost: app } : app;
    const changes = new Map<string, ChangeItem>();
    const ignored: Preview["ignored"] = [];
    const hostOf = (h?: string) => (h && h !== facts.appHost ? { host: h, ...(isOwnHost(h, facts) ? {} : { external: true as const }) } : {});
    for (const given of input.pages ?? []) {
        const a = typeof given === "string" ? splitAddress(given) : undefined;
        if (!a) {
            ignored.push({ given: String(given).slice(0, 200), why: "Not a page address." });
            continue;
        }
        const item: ChangeItem = { kind: "page", given: given.trim().slice(0, 300), path: pageKey(a), ...hostOf(a.host), query: a.query };
        changes.set(`page|${item.host ?? ""}|${item.path}|${a.query.join(",")}`, item);
    }
    for (const given of input.endpoints ?? []) {
        const e = typeof given === "string" ? parseEndpoint(given) : undefined;
        if (!e) {
            ignored.push({ given: String(given).slice(0, 200), why: "Not an endpoint: write it as a method and a path, such as POST /orders/{id}." });
            continue;
        }
        const item: ChangeItem = { kind: "endpoint", given: given.trim().slice(0, 300), path: e.path, ...(e.method ? { method: e.method } : {}), ...hostOf(e.host), query: e.query };
        changes.set(`endpoint|${item.host ?? ""}|${e.method ?? "*"}|${e.path}|${e.query.join(",")}`, item);
    }
    const all = [...changes.values()];
    return { changes: all.slice(0, MAX_CHANGES), ignored, notProcessed: all.slice(MAX_CHANGES).map((c) => c.given) };
}

/** Same number of segments, each equal or `{}` on either side. */
function samePattern(a: string, b: string): boolean {
    if (a === b) return true;
    const x = a.split("/");
    const y = b.split("/");
    return x.length === y.length && x.every((s, i) => s === y[i] || s === "{}" || y[i] === "{}");
}

const samePath = (a: string, b: string, prefix?: string): boolean => samePattern(a, b) || (prefix ? samePattern(`${prefix}${a}`, b) || samePattern(a, `${prefix}${b}`) : false);

const splitRoute = (key: string): [string, string | undefined] => {
    const at = key.indexOf("#");
    return at >= 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, undefined];
};

/**
 * Whether a change names this page or endpoint. Hosts: a change on an external host matches only that host; any other change matches every
 * page or endpoint of the application's own hosts (coverage.ts isOwnHost: its address and hosts under its name, its API). While the application's API address is not set,
 * a test whose run called another site's endpoints is never complete (coverage.ts unknownSite): they may be its own API. Pages: a change without a route matches the page
 * and every route of it, and also a hash route equal to its path; a change with a route matches that route of that page.
 */
export function matchesChange(change: ChangeItem, item: CoverageItem, apiPrefix?: string): boolean {
    if (change.kind !== item.kind) return false;
    if (change.external ? item.host !== change.host : item.external) return false;
    if (change.query.length && !item.queryUnknown && !change.query.every((q) => item.query.includes(q))) return false;
    if (change.kind === "page") {
        const [cb, cr] = splitRoute(change.path);
        const [ib, ir] = splitRoute(item.path);
        if (cr === undefined) return samePattern(cb, ib) || (ir !== undefined && samePattern(cb, ir));
        return ir !== undefined && samePattern(cb, ib) && samePattern(cr, ir);
    }
    if (change.method && change.method !== item.method) return false;
    return samePath(change.path, item.path, apiPrefix);
}

const TYPE_WORDS: Record<string, string> = { form: "form", websocket: "WebSocket", eventsource: "event stream", beacon: "beacon" };
const itemText = (i: CoverageItem) => `${i.method ? `${i.method} ` : ""}${i.host ? `//${i.host}` : ""}${i.path}${i.type ? ` (${TYPE_WORDS[i.type]})` : ""}${i.external ? " (external)" : ""}`;
const changeText = (c: ChangeItem) =>
    `${c.kind === "endpoint" ? `${c.method ?? "any method"} ` : ""}${c.host ? `//${c.host}` : ""}${c.path}${c.query.length ? `?${c.query.join("&")}` : ""}${c.external ? " (external)" : ""}`;

export interface PreviewOptions {
    /** The path of the API's base address ("/api"), if any. */
    apiPrefix?: string;
    /** Entries past MAX_CHANGES (from readChanges). */
    notProcessed?: string[];
    /**
     * Tests that cannot run, by id, with why: listed under "Cannot run" instead of being judged. `unreadable` (or `nowhere`): no runner
     * runs it (its steps cannot be read, it has no approved version), so it does not make a full run required by itself. `held`: every run
     * holds it back because a shared part it uses changed after its approval (held.ts): a deploy then tests less than the project has, so
     * any held test makes a full run required, with a reason naming it.
     */
    cannotRun?: ReadonlyMap<string, { why: string; unreadable?: boolean; nowhere?: boolean; held?: boolean }>;
    /** Each active deploy trigger compared with the viewer's runnable set (parity.ts). */
    parity?: TriggerParity[];
    /** The risk facts of each test, by id (risk.ts); a test without any scores on change impact alone. */
    risk?: ReadonlyMap<string, RiskFacts>;
    /** From impact analysis of a PR: too much unmapped, or a shared part changed, makes a full run required (risk.ts). */
    impact?: ImpactSummary;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The preview for a set of tests. */
export function previewSelection(coverage: TestCoverage[], changes: ChangeItem[], ignored: Preview["ignored"] = [], options: PreviewOptions | string = {}): Preview {
    const opts: PreviewOptions = typeof options === "string" ? { apiPrefix: options } : options;
    const matched: PreviewTest[] = [];
    const unknown: PreviewTest[] = [];
    const notMatched: PreviewTest[] = [];
    const cannotRun: PreviewTest[] = [];
    const reached = new Set<ChangeItem>();
    const notProcessed = opts.notProcessed ?? [];
    // A change list that was not read in full can hide the entry a test touches: then no test is "not matched".
    const changesIncomplete = notProcessed.length > 0 || ignored.length > 0;
    const notes = new Map<string, string[]>();
    const note = (id: string, text: string) => notes.set(id, [...(notes.get(id) ?? []), text]);
    for (const t of opts.parity ?? []) {
        for (const id of t.onlyViewer) note(id, `The deploy trigger ${t.trigger} runs on the runner of the person who made it, which cannot run this test, so its runs leave it out.`);
        for (const id of t.onlyTrigger) note(id, `The deploy trigger ${t.trigger} runs on the runner of the person who made it, which runs this test.`);
    }
    for (const c of [...coverage].sort((a, b) => a.testKey.localeCompare(b.testKey))) {
        const base = { testId: c.testId, testKey: c.testKey, title: c.title, kind: c.kind, completeness: c.completeness, ...(notes.has(c.testId) ? { notes: notes.get(c.testId)! } : {}) };
        const out = opts.cannotRun?.get(c.testId);
        if (out) {
            cannotRun.push({ ...base, reasons: [], why: out.why });
            continue;
        }
        const reasons: Reason[] = [];
        for (const item of c.items) {
            for (const change of changes) {
                if (!matchesChange(change, item, opts.apiPrefix)) continue;
                reached.add(change);
                const how = item.source === "declared" ? `its steps ${item.kind === "page" ? "open" : "call"}` : `a recorded run ${item.kind === "page" ? "opened" : "called"}`;
                reasons.push({
                    change: changeText(change),
                    matched: itemText(item),
                    source: item.source,
                    seenIn: item.seenIn,
                    sentence: `The change names ${changeText(change)}, and ${how} ${itemText(item)} (${item.seenIn.join(", ")}).`,
                });
            }
        }
        if (reasons.length) matched.push({ ...base, reasons });
        else if (changesIncomplete && (c.completeness === "declared-complete" || c.completeness === "observed-complete")) {
            unknown.push({ ...base, reasons, why: "Proposed because the change list was not read in full, so the entry it touches may be among those not compared." });
        } else if (c.completeness === "declared-complete" || c.completeness === "observed-complete") {
            const n = c.items.length;
            notMatched.push({ ...base, reasons, why: `Not proposed: what it touches is fully known from ${c.completeFrom ?? "its record"} (${n === 1 ? "1 page or endpoint" : `${n} pages and endpoints`}), and none of it is in the change.` });
        } else if (c.stale) unknown.push({ ...base, reasons, why: `Proposed because its recorded coverage is out of date: ${lowerFirst(c.stale)}` });
        else unknown.push({ ...base, reasons, why: `Proposed because what it touches is not fully known: ${c.limits[0] ?? "no page or endpoint of it is known."}` });
    }
    // The score orders the proposed tests and never removes one.
    for (const t of [...matched, ...unknown]) t.risk = riskOf(new Set(t.reasons.map((r) => r.change)).size, opts.risk?.get(t.testId));
    const byRisk = (a: PreviewTest, b: PreviewTest) => b.risk!.score - a.risk!.score || a.testKey.localeCompare(b.testKey);
    matched.sort(byRisk);
    unknown.sort(byRisk);
    const uncoveredChanges = changes.filter((c) => !reached.has(c)).map(changeText);
    const fullRunReasons: string[] = opts.impact ? fullRunRecommendation(opts.impact) : [];
    if (notProcessed.length) {
        fullRunReasons.push(`The change names ${changes.length + notProcessed.length} pages and endpoints; the preview compares at most ${MAX_CHANGES}, so ${notProcessed.length} ${notProcessed.length === 1 ? "was" : "were"} not compared with any test.`);
    }
    if (ignored.length) fullRunReasons.push(`${ignored.length} ${ignored.length === 1 ? "entry is" : "entries are"} not a page or an endpoint, so which tests ${ignored.length === 1 ? "it calls" : "they call"} for is not known.`);
    const staleIds = new Set(coverage.filter((c) => c.stale).map((c) => c.testId));
    const stale = [...matched, ...unknown].filter((t) => staleIds.has(t.testId));
    if (stale.length) fullRunReasons.push(`${plural(stale.length, "test's", "tests'")} recorded coverage is out of date (the latest run did not pass, ran an older version, is older than the freshness window, or ran before a shared part it uses changed), so what ${stale.length === 1 ? "it touches" : "they touch"} now is not known.`);
    // Matched tests count too: unknown, stale or incomplete coverage always requires a full run.
    const coverageUnknown = [...matched, ...unknown].filter((t) => t.completeness !== "declared-complete" && t.completeness !== "observed-complete" && !staleIds.has(t.testId));
    // Analytics or other-site endpoints with no API address set: say so on its own, since setting the address is what resolves it.
    const unknownSiteIds = new Set(coverage.filter((c) => c.limits.includes(UNKNOWN_SITE_LIMIT)).map((c) => c.testId));
    const otherSite = [...matched, ...unknown].filter((t) => unknownSiteIds.has(t.testId)).length;
    if (otherSite) fullRunReasons.push(`${plural(otherSite, "test's", "tests'")} recorded runs called endpoints on another site (analytics, or the application's own API at another address), and the application's API address is not set, so whether a change to an endpoint reaches ${otherSite === 1 ? "it" : "them"} is not known. Set the API address in the application's settings to tell them apart.`);
    if (coverageUnknown.length) fullRunReasons.push(`What ${coverageUnknown.length} test${coverageUnknown.length === 1 ? " touches is" : "s touch is"} not fully known, so the preview cannot rule out that ${coverageUnknown.length === 1 ? "it reaches" : "they reach"} the change.`);
    const notJudged = cannotRun.filter((t) => !opts.cannotRun?.get(t.testId)?.unreadable && !opts.cannotRun?.get(t.testId)?.nowhere).length;
    if (notJudged) fullRunReasons.push(`${notJudged} test${notJudged === 1 ? "" : "s"} cannot run on your runner, so the preview did not judge ${notJudged === 1 ? "it" : "them"}; a deploy run on another runner may still run ${notJudged === 1 ? "it" : "them"}.`);
    const held = cannotRun.filter((t) => opts.cannotRun?.get(t.testId)?.held);
    if (held.length) {
        const named = held.map((t) => `${t.testKey} “${t.title}” (${lowerFirst((t.why ?? "").replace(/^Cannot run: /, "")).replace(/\.$/, "")})`).join("; ");
        fullRunReasons.push(`${plural(held.length, "test is", "tests are")} held back because a shared part ${held.length === 1 ? "it uses" : "they use"} changed after ${held.length === 1 ? "its" : "their"} approval, so runs leave ${held.length === 1 ? "it" : "them"} out until approved again and the deploy tests less than the project has: ${named}.`);
    }
    const triggers: Preview["triggers"] = [];
    for (const t of opts.parity ?? []) {
        if (t.unresolvedWhy) {
            triggers.push({ trigger: t.trigger, parity: "unresolved", why: t.unresolvedWhy });
            fullRunReasons.push(`The deploy trigger ${t.trigger} cannot be compared with your runner: ${t.unresolvedWhy}.`);
        } else if (t.onlyViewer.length || t.onlyTrigger.length) {
            const parts = [...(t.onlyViewer.length ? [`${plural(t.onlyViewer.length, "test", "tests")} only your runner can run`] : []), ...(t.onlyTrigger.length ? [`${plural(t.onlyTrigger.length, "test", "tests")} only its runner can run`] : [])];
            const why = `runs on the runner of the person who made it, which can run a different set of tests than yours (${parts.join(", ")})`;
            triggers.push({ trigger: t.trigger, parity: "different", why });
            fullRunReasons.push(`The deploy trigger ${t.trigger} ${why}, so this preview does not describe its runs.`);
        } else triggers.push({ trigger: t.trigger, parity: "same" });
    }
    return {
        recommendationOnly: true,
        note: RECOMMENDATION_NOTE,
        changes,
        ignored,
        notProcessed,
        matched,
        unknown,
        notMatched,
        cannotRun,
        uncoveredChanges,
        fullRunRequired: fullRunReasons.length > 0,
        fullRunReasons,
        triggers,
        counts: { tests: coverage.length, matched: matched.length, unknown: unknown.length, proposed: matched.length + unknown.length, notMatched: notMatched.length, cannotRun: cannotRun.length },
    };
}

/**
 * The tests a focused run runs: every test the preview proposes (matched and unknown) among those that can run. Chosen only by a person
 * or an explicit API field, never automatically; `fullRunReasons` says when only a full run is safe.
 */
export function focusedSelection(coverage: TestCoverage[], runnable: ReadonlySet<string>, input: { pages?: string[]; endpoints?: string[] }, app: AppFacts, apiPrefix?: string): { testIds: string[]; fullRunReasons: string[] } {
    const { changes, ignored, notProcessed } = readChanges(input, app);
    const p = previewSelection(coverage.filter((c) => runnable.has(c.testId)), changes, ignored, { apiPrefix, notProcessed });
    return { testIds: [...p.matched, ...p.unknown].map((t) => t.testId), fullRunReasons: p.fullRunReasons };
}
