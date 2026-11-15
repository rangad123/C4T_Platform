/**
 * One request log for everything a security assessment sends: the external scanners' requests and the platform's own read-only checks
 * (discovery, the read-only checks, the API document's operations, the sign-in check, cross-account reads). Both go through the request
 * guard (./guard.ts), which adds each entry here with who sent it: "scanner:<id>" or "platform:<check family>". What the platform refuses
 * before a request reaches the guard (an out-of-scope address, a write method a page tried) is added by the platform with the same shape.
 *
 * Same rules as the guard's own log: time, method, host, path (never the query string, headers or bodies), verdict, status or reason, with
 * the path and the reason through the shared redaction.
 *
 * The cap is per source, so one sender never crowds another out of the log: the first MAX_PER_SOURCE entries of each source are kept
 * ("platform:discovery" and "platform:checks" are two sources, as are two scanners), and the totals, also per source, cover every request.
 */
import { redactText } from "../../shared/redact-text.js";
import type { EgressCounts, EgressEntry } from "./guard.js";

/** A request names its check family to the guard with this header ("platform:discovery"); the guard never passes it on. */
export const SOURCE_HEADER = "x-c4t-source";
/** On the guard's own refusals and failures ("refused" / "failed"), so a client can tell them from the site's answers. */
export const GUARD_MARK_HEADER = "x-c4t-guard";
/** Most entries kept per source (the same number a scanner run keeps). */
export const MAX_PER_SOURCE = 2_000;
const UNNAMED = "unknown";

/** A request log as it is stored and served: the kept entries (oldest first) and, per source, the counts of every request. */
export interface StoredRequestLog {
    entries: EgressEntry[];
    totals: Record<string, EgressCounts>;
}

const noCounts = (): EgressCounts => ({ total: 0, allowed: 0, refused: 0, failed: 0, byMethod: {} });
function count(c: EgressCounts, e: Pick<EgressEntry, "verdict" | "method">): void {
    c.total++;
    c[e.verdict]++;
    c.byMethod[e.method] = (c.byMethod[e.method] ?? 0) + 1;
}
function addCounts(into: EgressCounts, c: EgressCounts): void {
    into.total += Number(c.total) || 0;
    into.allowed += Number(c.allowed) || 0;
    into.refused += Number(c.refused) || 0;
    into.failed += Number(c.failed) || 0;
    for (const [m, n] of Object.entries(c.byMethod ?? {})) into.byMethod[m] = (into.byMethod[m] ?? 0) + (Number(n) || 0);
}

/** The counts of a log whose totals were not kept (a scanner run's): one count per listed entry, by its source. */
export function totalsOfEntries(entries: readonly EgressEntry[]): Record<string, EgressCounts> {
    const totals: Record<string, EgressCounts> = {};
    for (const e of entries) count((totals[e.source ?? UNNAMED] ??= noCounts()), e);
    return totals;
}

/**
 * Several logs as one: totals added up per source, entries in time order, at most MAX_PER_SOURCE of each source (the earliest ones), so a
 * busy source takes nothing from another's share.
 */
export function mergeRequestLogs(logs: ReadonlyArray<StoredRequestLog | undefined>): StoredRequestLog {
    const totals: Record<string, EgressCounts> = {};
    const all: EgressEntry[] = [];
    for (const log of logs) {
        if (!log) continue;
        for (const [source, c] of Object.entries(log.totals ?? {})) addCounts((totals[source] ??= noCounts()), c);
        all.push(...(log.entries ?? []));
    }
    all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const kept: Record<string, number> = {};
    const entries = all.filter((e) => (kept[e.source ?? UNNAMED] = (kept[e.source ?? UNNAMED] ?? 0) + 1) <= MAX_PER_SOURCE);
    return { entries, totals };
}

export class RequestLog {
    private readonly list: EgressEntry[] = [];
    private readonly c: EgressCounts = noCounts();
    private readonly totals: Record<string, EgressCounts> = {};

    /** An entry the guard already made (redacted there). */
    add(e: EgressEntry): void {
        count(this.c, e);
        const mine = (this.totals[e.source ?? UNNAMED] ??= noCounts());
        count(mine, e);
        if (mine.total <= MAX_PER_SOURCE) this.list.push(e);
    }

    /** As stored: the kept entries and the per-source totals. */
    stored(): StoredRequestLog {
        return mergeRequestLogs([{ entries: this.list, totals: this.totals }]);
    }

    /** Something the platform refused (or did itself) before the guard saw it: logged with the same shape, the query string never kept. */
    note(source: string, method: string, url: string, verdict: EgressEntry["verdict"], reason?: string): void {
        let host = "";
        let path = url.split(/[?#]/)[0]!;
        try {
            const u = new URL(url);
            host = u.host;
            path = u.pathname;
        } catch {
            /* keep the text without its query */
        }
        this.add({ at: new Date().toISOString(), source, method: method.toUpperCase(), host: host.slice(0, 255), path: redactText(path.slice(0, 500), 500), verdict, ...(reason ? { reason: redactText(reason.slice(0, 300), 300) } : {}) });
    }

    entries(): EgressEntry[] {
        return this.list.slice();
    }

    counts(): EgressCounts {
        return { ...this.c, byMethod: { ...this.c.byMethod } };
    }
}
