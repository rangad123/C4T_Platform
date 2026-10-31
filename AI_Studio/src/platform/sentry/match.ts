/**
 * Which Sentry issues might be related to a failed test run, ranked by evidence that can be checked, never guessed.
 * Pure functions only (no network, no clock): the table of weights below is the whole ranking, and it is tested as such.
 *
 * What is kept from Sentry is deliberately small: issue id, title, level, event count, first/last seen, the link, and the
 * "culprit" (the function or route Sentry blames), which is only used here to compare with the failed request and is never
 * passed on. Every other field of an answer (event bodies, stack traces, tags, users, breadcrumbs, metadata) is dropped at
 * the door by the schema below.
 */
import { z } from "zod";

/** How far around the failed run to look, on each side. */
export const WINDOW_PAD_MS = 2 * 60_000;
/** Most issues asked of Sentry, and most shown. */
export const MAX_FETCHED = 25;
export const MAX_SHOWN = 5;

/** The ranking, in points. A higher total ranks first; ties fall back to the most recently seen, then the id. */
export const WEIGHTS = {
    /** The issue's location is exactly the path of a request that failed in the run. */
    pathEqual: 100,
    /** The issue's title or location mentions the path of a request that failed in the run. */
    pathMention: 60,
    /** Sentry saw this error for the first time while the test ran (a new error, not an old one). */
    newInWindow: 40,
    /** Level error or fatal. */
    errorLevel: 10,
    /** Event count: log10(count + 1) * 2, at most this many points. */
    countMax: 8,
} as const;

const LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;
export type SentryLevel = (typeof LEVELS)[number] | "unknown";

// eslint-disable-next-line no-control-regex
const text = (max: number) => z.string().transform((s) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max));
const timestamp = z
    .string()
    .max(64)
    .refine((s) => !Number.isNaN(Date.parse(s)));

/** The only fields read from a Sentry issue. z.object drops every other key. */
const IssueSchema = z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)),
    title: text(300).pipe(z.string().min(1)),
    culprit: text(300).optional().catch(undefined),
    level: z.string().max(20).optional().catch(undefined),
    count: z.union([z.string(), z.number()]).optional().catch(undefined),
    firstSeen: timestamp.optional().catch(undefined),
    lastSeen: timestamp.optional().catch(undefined),
    permalink: z.string().max(500).optional().catch(undefined),
});

/** An issue as read from Sentry: what ranking needs. `culprit` stays inside this module's callers and is never returned. */
export interface Candidate {
    id: string;
    title: string;
    culprit?: string;
    level: SentryLevel;
    count: number;
    firstSeen?: Date;
    lastSeen?: Date;
    permalink?: string;
}

/** An issue as the API shows it. */
export interface RelatedIssue {
    id: string;
    title: string;
    level: SentryLevel;
    count: number;
    firstSeen: string | null;
    lastSeen: string | null;
    url: string;
    /** Why it might be related, in plain words. Never claims a cause. */
    reason: string;
}

/** Reads Sentry's list answer; undefined when it is not a list at all. Entries that do not fit are skipped. */
export function parseIssues(json: unknown): Candidate[] | undefined {
    if (!Array.isArray(json)) return undefined;
    const out: Candidate[] = [];
    for (const item of json.slice(0, MAX_FETCHED * 4)) {
        const p = IssueSchema.safeParse(item);
        if (!p.success) continue;
        const d = p.data;
        const count = Number.parseInt(String(d.count ?? "0"), 10);
        out.push({
            id: d.id,
            title: d.title,
            ...(d.culprit ? { culprit: d.culprit } : {}),
            level: (LEVELS as readonly string[]).includes(d.level ?? "") ? (d.level as SentryLevel) : "unknown",
            count: Number.isFinite(count) && count > 0 ? count : 0,
            ...(d.firstSeen ? { firstSeen: new Date(d.firstSeen) } : {}),
            ...(d.lastSeen ? { lastSeen: new Date(d.lastSeen) } : {}),
            ...(d.permalink ? { permalink: d.permalink } : {}),
        });
    }
    return out;
}

export interface Run {
    start: Date;
    end: Date;
}
export interface SearchWindow extends Run {
    /** The run itself, without the padding. */
    run: Run;
}

/** The run's own time, and the window asked of Sentry: the run plus two minutes on each side. */
export function searchWindow(startedAt: string, durationMs: number | null | undefined): SearchWindow {
    const start = new Date(startedAt);
    const end = new Date(start.getTime() + Math.max(0, durationMs ?? 0));
    return { start: new Date(start.getTime() - WINDOW_PAD_MS), end: new Date(end.getTime() + WINDOW_PAD_MS), run: { start, end } };
}

/** The window as Sentry's `start` and `end` parameters (UTC, to the second, no zone suffix). */
export const sentryTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "");

// ── paths ────────────────────────────────────────────────────────────────────

/** "GET https://x.test/Api/Cart/?a=1" and "/api/cart" both become "/api/cart". */
export function normalizePath(raw: string): string {
    let p = raw.trim().replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "");
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
    p = p.split(/[?#]/)[0] ?? "";
    try {
        p = decodeURI(p);
    } catch {
        /* keep as is */
    }
    p = p.toLowerCase().replace(/\/{2,}/g, "/");
    return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The paths of the requests that failed in the run, normalised, without duplicates. */
export function uniquePaths(paths: string[], max = 20): string[] {
    const out: string[] = [];
    for (const raw of paths) {
        const p = normalizePath(raw);
        if (p.startsWith("/") && !out.includes(p)) out.push(p);
        if (out.length >= max) break;
    }
    return out;
}

const PATH_CHAR = /[a-z0-9_\-/%]/i;
/** Does `haystack` mention `path` as a whole path (not as the tail of /v2/api/cart or the head of /api/cart-items)? */
function mentions(haystack: string, path: string): boolean {
    if (path.length < 3) return false;
    const h = haystack.toLowerCase();
    let from = 0;
    for (;;) {
        const at = h.indexOf(path, from);
        if (at < 0) return false;
        const before = at === 0 ? "" : h[at - 1]!;
        const after = h[at + path.length] ?? "";
        if (!(before && /[a-z0-9_\-.]/i.test(before)) && !(after && PATH_CHAR.test(after))) return true;
        from = at + 1;
    }
}

/** "equal" beats "mention"; undefined when the issue says nothing about any failed path. */
export function pathMatch(c: Pick<Candidate, "title" | "culprit">, paths: string[]): { kind: "equal" | "mention"; path: string } | undefined {
    const culprit = c.culprit ? normalizePath(c.culprit) : "";
    for (const p of paths) if (culprit && culprit === p) return { kind: "equal", path: p };
    for (const p of paths) if (mentions(c.title, p) || (c.culprit && mentions(c.culprit, p))) return { kind: "mention", path: p };
    return undefined;
}

// ── ranking ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
function span(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? plural(s, "second") : plural(Math.round(s / 60), "minute");
}

export interface Scored {
    candidate: Candidate;
    score: number;
    parts: { path?: { kind: "equal" | "mention"; path: string }; newInWindow: boolean; errorLevel: boolean; countPoints: number };
}

/** Points for one issue, or undefined when it was not around while the run happened. */
export function score(c: Candidate, w: SearchWindow, paths: string[]): Scored | undefined {
    const first = c.firstSeen ?? c.lastSeen;
    const last = c.lastSeen ?? c.firstSeen;
    // It must overlap the window: seen at or after the start, and not first seen after the end.
    if (!first || !last || last.getTime() < w.start.getTime() || first.getTime() > w.end.getTime()) return undefined;
    const path = pathMatch(c, paths);
    const newInWindow = Boolean(c.firstSeen && c.firstSeen.getTime() >= w.start.getTime() && c.firstSeen.getTime() <= w.end.getTime());
    const errorLevel = c.level === "error" || c.level === "fatal";
    const countPoints = Math.min(WEIGHTS.countMax, Math.floor(Math.log10(c.count + 1) * 2));
    const total = (path ? (path.kind === "equal" ? WEIGHTS.pathEqual : WEIGHTS.pathMention) : 0) + (newInWindow ? WEIGHTS.newInWindow : 0) + (errorLevel ? WEIGHTS.errorLevel : 0) + countPoints;
    return { candidate: c, score: total, parts: { ...(path ? { path } : {}), newInWindow, errorLevel, countPoints } };
}

/** The reason in words: what is true of the issue, never what it caused. */
export function reasonFor(s: Scored, w: SearchWindow): string {
    const c = s.candidate;
    const clauses: string[] = [];
    if (s.parts.newInWindow && c.firstSeen) {
        const t = c.firstSeen.getTime();
        if (t < w.run.start.getTime()) clauses.push(`First seen ${span(w.run.start.getTime() - t)} before the failed run started`);
        else if (t > w.run.end.getTime()) clauses.push(`First seen ${span(t - w.run.end.getTime())} after the failed run ended`);
        else clauses.push(`First seen ${span(t - w.run.start.getTime())} into the failed run`);
    } else {
        clauses.push("Was active while the test ran");
    }
    if (s.parts.path) clauses.push(s.parts.path.kind === "equal" ? `is reported at ${s.parts.path.path}, which failed in this run` : `mentions ${s.parts.path.path}, which failed in this run`);
    return `${clauses.join(" and ")}.`;
}

export interface RankOptions {
    window: SearchWindow;
    /** Failed request paths, already through `uniquePaths`. */
    paths: string[];
    /** Where an issue opens: the link Sentry gave, if it is a web address, else the one built from the connection. */
    link: (c: Candidate) => string;
    max?: number;
}

/** Issues that were around during the run, best evidence first, at most five. */
export function rankRelated(candidates: Candidate[], o: RankOptions): RelatedIssue[] {
    const scored = candidates.map((c) => score(c, o.window, o.paths)).filter((s): s is Scored => Boolean(s));
    scored.sort((a, b) => b.score - a.score || (b.candidate.lastSeen?.getTime() ?? 0) - (a.candidate.lastSeen?.getTime() ?? 0) || a.candidate.id.localeCompare(b.candidate.id));
    return scored.slice(0, o.max ?? MAX_SHOWN).map((s) => ({
        id: s.candidate.id,
        title: s.candidate.title,
        level: s.candidate.level,
        count: s.candidate.count,
        firstSeen: s.candidate.firstSeen?.toISOString() ?? null,
        lastSeen: s.candidate.lastSeen?.toISOString() ?? null,
        url: o.link(s.candidate),
        reason: reasonFor(s, o.window),
    }));
}
