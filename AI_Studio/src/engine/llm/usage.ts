/**
 * AI usage: counting, budget rules and the price table. Pure functions only (no database, no clock of its own,
 * no model), so every rule here is covered by fast unit tests. The wrapper that applies these rules to a model
 * client is `metered.ts`; the storage is `platform/usage-store.ts`.
 *
 * Only counts and labels ever pass through this module: never a prompt, an answer or an image.
 */

/** What a model call was for. A call site passes one of these when it is cheap to do so; otherwise "other". */
export type LlmPurpose = "analysis" | "planning" | "authoring" | "repair" | "vision" | "plain" | "other";
export const PURPOSES: readonly LlmPurpose[] = ["analysis", "planning", "authoring", "repair", "vision", "plain", "other"];

export function normalisePurpose(p: unknown): LlmPurpose {
    return typeof p === "string" && (PURPOSES as readonly string[]).includes(p) ? (p as LlmPurpose) : "other";
}

/**
 * Not a call's purpose: rows under this label count how often the fast model handed a step to the main model (routing.ts). Their
 * `calls` column holds the number of escalations and they carry no tokens (the calls themselves are counted under their own purpose).
 */
export const ESCALATION_PURPOSE = "escalation";

/** The purpose label as stored: a call's purpose, or the escalation label. */
export const storedPurpose = (p: unknown): string => (p === ESCALATION_PURPOSE ? ESCALATION_PURPOSE : normalisePurpose(p));

// ── estimates ────────────────────────────────────────────────────────────────

/** When a client reports no usage at all, a call is counted as characters / 4 (a rule of thumb for English and code). */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
    return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── prompt-cache weights (prompt-cache.ts) ───────────────────────────────────

/**
 * How much a cached input token counts against a token limit, compared with an ordinary input token: Anthropic's published rates for
 * the 5-minute cache (a read costs a tenth, a write a quarter more). Other providers differ (OpenAI reports reads only, at a tenth to a
 * half); these weights are the documented approximation. Money uses the prices people type in instead.
 */
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;

/**
 * Tokens as a limit counts them: input and output, with cache reads and writes (which are part of the input) at their weight.
 * Without any cache tokens this is exactly input + output.
 */
export function budgetTokens(c: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
    const input = Math.max(0, c.inputTokens);
    const read = Math.min(Math.max(0, c.cacheReadTokens ?? 0), input);
    const write = Math.min(Math.max(0, c.cacheWriteTokens ?? 0), input - read);
    if (read === 0 && write === 0) return input + Math.max(0, c.outputTokens);
    return Math.round(input - read * (1 - CACHE_READ_WEIGHT) + write * (CACHE_WRITE_WEIGHT - 1)) + Math.max(0, c.outputTokens);
}

/** The same sum in SQL over the usage table's columns, so totals read from the database agree with the meter's own count. */
export const BUDGET_TOKENS_SQL = `(input_tokens + output_tokens - ROUND(cache_read_tokens * ${1 - CACHE_READ_WEIGHT}) + ROUND(cache_write_tokens * ${CACHE_WRITE_WEIGHT - 1}))`;

// ── time keys (UTC, so the worker and the API process always agree) ──────────

export const monthOf = (d: Date | number): string => new Date(d).toISOString().slice(0, 7);
export const dayOf = (d: Date | number): string => new Date(d).toISOString().slice(0, 10);

/** First day of a month ("2026-10") and of the next one, as day keys: usage of the month is `day >= from AND day < to`. */
export function monthBounds(month: string): { from: string; to: string } {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    return { from: `${month}-01`, to: `${next}-01` };
}

/** Day keys from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
    const out: string[] = [];
    const end = Date.parse(`${to}T00:00:00Z`);
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) out.push(dayOf(t));
    return out;
}

// ── budget rules ─────────────────────────────────────────────────────────────

/**
 * job = this one job, project = this project in the calendar month, month = all projects in the calendar month.
 * Order matters: when several caps are hit the most specific one is reported.
 */
export type CapKind = "job" | "project" | "month";
export const CAP_ORDER: readonly CapKind[] = ["job", "project", "month"];

/** Limits in tokens (input + output). Missing, null or undefined = no limit. */
export interface Caps {
    job?: number | null;
    project?: number | null;
    month?: number | null;
}
export interface Used {
    job: number;
    project: number;
    month: number;
}
export interface CapHit {
    cap: CapKind;
    used: number;
    limit: number;
    /** used / limit, in whole percent (can pass 100 after an in-flight call). */
    percent: number;
}
export interface Decision {
    allowed: boolean;
    /** Why the call is refused (the most specific cap that is hit). */
    blocked?: CapHit;
    /** Every other cap that has passed the warning threshold. */
    warnings: CapHit[];
}

export const DEFAULT_WARN_PERCENT = 80;

const active = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Decide whether the next model call may start.
 *  - refused when a cap has no room left (`used >= limit`), or when the call's own input, estimated up front, would not fit
 *    (`used + incoming > limit`). Exactly at the limit therefore refuses; one token under it with nothing incoming allows.
 *  - a call that is allowed can still push a cap over its limit, because its answer size is unknown until it ends. That
 *    overshoot is at most one call per process that is running one.
 *  - a cap at or over `warnPercent` of its limit (and not refusing) is returned as a warning.
 */
export function decideBudget(used: Used, caps: Caps, opts: { incoming?: number; warnPercent?: number } = {}): Decision {
    const incoming = Math.max(0, opts.incoming ?? 0);
    const warnPercent = opts.warnPercent ?? DEFAULT_WARN_PERCENT;
    const warnings: CapHit[] = [];
    let blocked: CapHit | undefined;
    for (const cap of CAP_ORDER) {
        const limit = caps[cap];
        if (!active(limit)) continue;
        const u = used[cap];
        const hit: CapHit = { cap, used: u, limit, percent: limit === 0 ? 100 : Math.floor((u / limit) * 100) };
        if (u >= limit || u + incoming > limit) {
            blocked ??= hit;
        } else if (u * 100 >= warnPercent * limit) {
            warnings.push(hit);
        }
    }
    return blocked ? { allowed: false, blocked, warnings } : { allowed: true, warnings };
}

/** The sentence a job stops with (and the Overview shows). Same text for every cap kind but the scope word. */
export function capMessage(cap: CapKind): string {
    return `The AI token limit for this ${cap === "job" ? "job" : cap === "project" ? "project" : "month"} was reached`;
}

const SCOPE_LABEL: Record<CapKind, string> = { job: "This job", project: "This project this month", month: "All projects this month" };
export const capScope = (cap: CapKind): string => SCOPE_LABEL[cap];

const n = (v: number) => v.toLocaleString("en-US");

/** The numbers behind a refusal, for the job's event log: "This project this month: 52,000 of 50,000 tokens used." */
export function capDetail(hit: CapHit): string {
    return `${capScope(hit.cap)}: ${n(hit.used)} of ${n(hit.limit)} tokens used.`;
}

/** "AI use has reached 85% of the limit for this project this month (42,500 of 50,000 tokens)." */
export function warningMessage(hit: CapHit): string {
    return `AI use has reached ${hit.percent}% of the limit for ${capScope(hit.cap).toLowerCase()} (${n(hit.used)} of ${n(hit.limit)} tokens).`;
}

/** Thrown instead of a model call that would pass a cap. Never a silent truncation: the caller sees a typed error. */
export class BudgetExceeded extends Error {
    readonly hit: CapHit;
    constructor(hit: CapHit) {
        super(capMessage(hit.cap));
        this.name = "BudgetExceeded";
        this.hit = hit;
    }
}

export const isBudgetExceeded = (e: unknown): e is BudgetExceeded => e instanceof BudgetExceeded || (e instanceof Error && e.name === "BudgetExceeded");

// ── prices and cost ──────────────────────────────────────────────────────────

/** What the user typed in: money per million tokens. There are no built-in prices on purpose; they would go stale. */
export interface Price {
    inputPerMTok: number;
    outputPerMTok: number;
    /** Optional: the price of input read from the prompt cache. Without it, cache reads are charged at the input price. */
    cachedInputPerMTok?: number;
    /** Optional: the price of input written to the prompt cache. Without it, cache writes are charged at the input price. */
    cacheWritePerMTok?: number;
}

/** `cache`: how many of the input tokens were cache reads and writes (each priced at its own price when one is set). */
export function costOf(inputTokens: number, outputTokens: number, price: Price, cache: { read?: number; write?: number } = {}): number {
    const read = Math.min(Math.max(0, cache.read ?? 0), inputTokens);
    const write = Math.min(Math.max(0, cache.write ?? 0), inputTokens - read);
    const plain = inputTokens - read - write;
    return (
        (plain / 1_000_000) * price.inputPerMTok +
        (read / 1_000_000) * (price.cachedInputPerMTok ?? price.inputPerMTok) +
        (write / 1_000_000) * (price.cacheWritePerMTok ?? price.inputPerMTok) +
        (outputTokens / 1_000_000) * price.outputPerMTok
    );
}

// ── aggregation ──────────────────────────────────────────────────────────────

/** One stored row, summed over jobs (the store already keeps one row per job, purpose, model and day). */
export interface UsageRow {
    day: string;
    projectId: string;
    purpose: string;
    model: string;
    calls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    images: number;
    estimatedCalls: number;
    /** Of the input tokens: read from / written to the provider's prompt cache (0 or missing when nothing was cached). */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** Who pays for these tokens; missing = Crowd4Test (the server's key). */
    billingOwner?: BillingOwner;
}

/** Who pays for a model call: Crowd4Test (managed AI, the server's key) or the customer's organisation (its own key). Nothing is charged here. */
export type BillingOwner = "crowd4test" | "organization";
export interface UsageBilling {
    owner: BillingOwner;
    /** The organisation that pays; null for Crowd4Test, and for a project on its own key that has no organisation. */
    organizationId?: string | null;
}

export type GroupBy = "day" | "project" | "purpose" | "model" | "billing";
export const GROUP_BYS: readonly GroupBy[] = ["day", "project", "purpose", "model", "billing"];

export interface Totals {
    calls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    images: number;
    /** Some tokens were estimated (characters / 4) because the model client reported none. */
    estimated: boolean;
    /** Cost of the rows whose model has a price; null when none has. */
    cost: number | null;
    /** Tokens of rows whose model has no price, so a cost shown is partial. */
    unpricedTokens: number;
    /** Of `inputTokens`: read from the prompt cache, and written to it (prompt-cache.ts). */
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** What counts against the limits: cache reads and writes at their weight (`budgetTokens`); equals totalTokens without caching. */
    budgetTokens: number;
    /** Times the fast model handed a step to the main model (model-routing.md). */
    escalations: number;
}
export interface Group extends Totals {
    key: string;
}

const emptyTotals = (): Totals => ({ calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, images: 0, estimated: false, cost: null, unpricedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, budgetTokens: 0, escalations: 0 });

function add(t: Totals, r: UsageRow, prices: ReadonlyMap<string, Price>): void {
    // An escalation row is a count, not a call (see ESCALATION_PURPOSE).
    if (r.purpose === ESCALATION_PURPOSE) {
        t.escalations += r.calls;
        return;
    }
    t.calls += r.calls;
    t.failedCalls += r.failedCalls;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.totalTokens += r.inputTokens + r.outputTokens;
    t.images += r.images;
    t.cacheReadTokens += r.cacheReadTokens ?? 0;
    t.cacheWriteTokens += r.cacheWriteTokens ?? 0;
    t.budgetTokens += budgetTokens(r);
    if (r.estimatedCalls > 0) t.estimated = true;
    const price = prices.get(r.model);
    if (price) t.cost = (t.cost ?? 0) + costOf(r.inputTokens, r.outputTokens, price, { read: r.cacheReadTokens, write: r.cacheWriteTokens });
    else t.unpricedTokens += r.inputTokens + r.outputTokens;
}

export function totalsOf(rows: readonly UsageRow[], prices: ReadonlyMap<string, Price> = new Map()): Totals {
    const t = emptyTotals();
    for (const r of rows) add(t, r, prices);
    return t;
}

/** Group rows by one dimension; largest first (days in date order). */
export function groupRows(rows: readonly UsageRow[], by: GroupBy, prices: ReadonlyMap<string, Price> = new Map()): Group[] {
    const map = new Map<string, Group>();
    for (const r of rows) {
        // Escalations belong to no purpose of their own: they show in the totals and by day, project and model.
        if (by === "purpose" && r.purpose === ESCALATION_PURPOSE) continue;
        const key = by === "day" ? r.day : by === "project" ? r.projectId : by === "purpose" ? r.purpose : by === "billing" ? (r.billingOwner ?? "crowd4test") : r.model;
        let g = map.get(key);
        if (!g) map.set(key, (g = { key, ...emptyTotals() }));
        add(g, r, prices);
    }
    const out = [...map.values()];
    return by === "day" ? out.sort((a, b) => a.key.localeCompare(b.key)) : out.sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
}

/** One entry per day of the range, zeros included, so a chart has no gaps. */
export function daySeries(rows: readonly UsageRow[], from: string, to: string, prices: ReadonlyMap<string, Price> = new Map()): Group[] {
    const byDay = new Map(groupRows(rows, "day", prices).map((g) => [g.key, g]));
    return daysBetween(from, to).map((day) => byDay.get(day) ?? { key: day, ...emptyTotals() });
}

/** A whole number of tokens as a short text for people: 41200 -> "41.2K", 1500000 -> "1.5M". */
export function shortTokens(v: number): string {
    if (v < 1000) return String(v);
    if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
    return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}
