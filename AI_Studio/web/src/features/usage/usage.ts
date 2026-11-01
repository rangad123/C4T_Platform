import type { Tone } from "../../lib/labels";

/** Shapes the usage routes answer with (see src/platform/routes/usage.ts). Only counts and labels. */
export interface UsageTotals {
    calls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    images: number;
    estimated: boolean;
    cost: number | null;
    unpricedTokens: number;
    /** Of the input: read from / written to the provider's prompt cache. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** What counts toward the limits (cached tokens at their weight). */
    budgetTokens?: number;
    /** Times the fast model handed a step to the main model (model routing). */
    escalations?: number;
}
export interface UsageGroup extends UsageTotals {
    key: string;
    label?: string;
}
export type Level = "none" | "ok" | "warning" | "reached";
export interface MonthBlock {
    month: string;
    usedTokens: number;
    limitTokens: number | null;
    percent: number | null;
    level: Level;
    warnPercent: number;
}
export type GroupBy = "project" | "purpose" | "model" | "billing";
export interface UsageAnswer {
    from: string;
    to: string;
    groupBy: string;
    currency: string;
    totals: UsageTotals;
    groups: UsageGroup[];
    series: UsageGroup[];
    month: MonthBlock;
    pricing: string | null;
}
export interface PlatformBudget {
    monthlyTokens: number | null;
    jobTokens: number | null;
    warnPercent: number;
    monthlySource: "app" | "environment" | "none";
    jobSource: "app" | "environment" | "none";
}
export interface BudgetsAnswer {
    platform: PlatformBudget;
    month: MonthBlock;
    projects: Array<{ projectId: string; name: string; monthlyTokens: number | null; jobTokens: number | null; usedTokens: number }>;
}
export interface ProjectBudget {
    projectId: string;
    monthlyTokens: number | null;
    jobTokens: number | null;
    usedTokens: number;
    warnPercent: number;
}
export interface PricesAnswer {
    currency: string;
    prices: Array<{ model: string; inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number; cacheWritePerMTok?: number }>;
}
export interface JobUsage {
    jobId: string;
    currency: string;
    totals: UsageTotals;
    byPurpose: UsageGroup[];
    summary: string;
    stop: { cap: "job" | "project" | "month"; scope: string; message: string; usedTokens: number; limitTokens: number; at: string } | null;
    /** Smaller page snapshots in this job (estimated tokens); null or missing when they were not used. */
    snapshotSavings?: { sessions: number; baselineTokens: number; sentTokens: number; savedTokens: number; wholePageLooks: number; summary: string } | null;
    /** Repairs made without AI and unchanged pages not sent to the AI again in this job; null or missing when none. */
    withoutAi?: { repairs: number; repairsByKind: Record<string, number>; pagesReused: number; summary: string } | null;
}

/** What each kind of model call was for, in the words the rest of the app uses. */
export const PURPOSE_LABEL: Record<string, string> = {
    analysis: "Understanding the application",
    planning: "Planning tests",
    authoring: "Writing web tests",
    repair: "Repairing tests",
    vision: "Looking at screenshots",
    plain: "Plain-English tests",
    other: "Other",
};

export const LEVEL_TONE: Record<Level, Tone> = { none: "neutral", ok: "success", warning: "warning", reached: "danger" };

/** 41200 becomes "41.2K", 1500000 becomes "1.5M". */
export function tokensText(v: number): string {
    if (v < 1000) return String(v);
    if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
    return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

export const exact = (v: number): string => v.toLocaleString("en-US");

/** A cost with the currency label the user picked ("EUR 1.23"); no label means a bare number. */
export function costText(cost: number | null, currency: string): string {
    if (cost === null) return "";
    const n = cost < 0.01 && cost > 0 ? cost.toFixed(4) : cost.toFixed(2);
    return currency ? `${currency} ${n}` : n;
}

/** "" or text of digits (spaces, commas and underscores allowed) to a limit; null = no limit; undefined = not a valid number. */
export function parseLimit(text: string): number | null | undefined {
    const t = text.trim();
    if (!t) return null;
    const n = Number(t.replace(/[\s,_]/g, ""));
    return Number.isInteger(n) && n >= 1 && n <= 1_000_000_000_000 ? n : undefined;
}

export const limitText = (v: number | null): string => (v === null ? "" : String(v));

export function monthName(month: string): string {
    const [y, m] = month.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}
