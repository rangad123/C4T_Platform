/** Types of GET /api/dashboard and the small pure helpers the dashboard page uses. */
/** Same values as the run ribbon's `Tick` (kept local so this file has no component imports). */
type Tick = "pass" | "attention" | "fail" | "idle";

export type Readiness = "ready" | "needs-attention" | "blocked" | "unknown";

export interface Reason {
    code: string;
    text: string;
}

export interface FleetProject {
    id: string;
    name: string;
    host: string;
    readiness: { state: Readiness; label: string; reasons: Reason[]; stale: boolean };
    analysis: { status: string; at: string; active: boolean } | null;
    tests: { total: number; validated: number; needsAttention: number; couldNotValidate: number; waiting: number };
    latestRun: { jobId: string; finishedAt: string; trigger: string; mode: string; passRate: number | null; total: number; validated: number; failed: number; needsReview: number; sentence?: string; others?: string } | null;
    trend: Array<{ at: string; passRate: number | null }>;
    schedule: { exists: boolean; enabled: number; total: number; lastRunOk: boolean | null; lastRunAt: string | null; note: string | null };
    findings: { critical: number; high: number; medium: number; low: number; highOrCritical: number };
    flaky: number;
    apiBreakingChanges: number;
    lastRunAt: string | null;
}

export interface FleetSummary {
    total: number;
    ready: number;
    needsAttention: number;
    blocked: number;
    unknown: number;
    sentence: string;
}

export interface FleetData {
    generatedAt: string;
    summary: FleetSummary;
    projects: FleetProject[];
    rules: Array<{ state: Readiness; label: string; summary: string; when: string[] }>;
    staleDays: number;
}

export const STATE_ORDER: Readiness[] = ["blocked", "needs-attention", "unknown", "ready"];
export const STATE_LABEL: Record<Readiness, string> = { blocked: "Blocked", "needs-attention": "Needs attention", unknown: "Unknown", ready: "Ready" };

/**
 * What each readiness state means, in one or two sentences (the summary of src/platform/dashboard.ts READINESS_RULES; the full
 * rules are in "How readiness is decided"). Used where the rules are not in the answer, such as a release.
 */
export const STATE_HELP: Record<Readiness, string> = {
    blocked: "Do not release until this is dealt with: an open critical or high-severity finding, or the last run did not finish.",
    "needs-attention": "Look at it before releasing: failing, unreliable or not yet run tests, medium or low findings, a breaking API change, or a last run more than 7 days old.",
    unknown: "There is not enough information to say: never explored or run, no tests yet, or the data could not be read.",
    ready: "Nothing needs attention: every test passes, nothing else is open, and the last run is at most 7 days old.",
};

/** Counts of a state in the whole fleet (for the filter chips). */
export const countOf = (s: FleetSummary, state: Readiness): number => ({ blocked: s.blocked, "needs-attention": s.needsAttention, unknown: s.unknown, ready: s.ready })[state];

/** At most `max` ticks in proportion to the test counts; every verdict that has tests keeps at least one tick. */
export function ticksFor(t: FleetProject["tests"], max = 36): Tick[] {
    const groups: Array<[Tick, number]> = [
        ["pass", t.validated],
        ["attention", t.needsAttention],
        ["fail", t.couldNotValidate],
        ["idle", t.waiting],
    ];
    const total = groups.reduce((a, [, n]) => a + n, 0);
    if (total === 0) return [];
    const scale = total > max ? max / total : 1;
    return groups.flatMap(([tick, n]) => Array.from({ length: n === 0 ? 0 : Math.max(1, Math.round(n * scale)) }, () => tick));
}

/** Same matching as the API's `q`: name or host, case-insensitive. */
export const matches = (p: Pick<FleetProject, "name" | "host">, q: string): boolean => {
    const needle = q.trim().toLowerCase();
    return !needle || p.name.toLowerCase().includes(needle) || p.host.toLowerCase().includes(needle);
};

/** Pass rates as polyline segments in a w x h box (0% at the bottom). A missing rate breaks the line. */
export function sparkSegments(points: Array<{ passRate: number | null }>, w: number, h: number, pad = 3): Array<Array<[number, number]>> {
    const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
    const segments: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    points.forEach((p, i) => {
        if (p.passRate === null) {
            if (current.length) segments.push(current);
            current = [];
            return;
        }
        const x = points.length > 1 ? pad + i * step : w / 2;
        const y = pad + (1 - Math.max(0, Math.min(100, p.passRate)) / 100) * (h - pad * 2);
        current.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    });
    if (current.length) segments.push(current);
    return segments;
}

/** Where the "Attention list" link goes: the review list first, then the tests that could not be validated. */
export function attentionHref(p: FleetProject): string {
    const base = `#/projects/${p.id}/tests`;
    if (p.tests.needsAttention > 0) return `${base}?status=review`;
    if (p.tests.couldNotValidate > 0) return `${base}?status=failed`;
    return base;
}
