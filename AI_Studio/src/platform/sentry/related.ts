/**
 * "Related errors in Sentry" for a failed test: find the failed run, ask Sentry for issues around it, rank them with
 * `match.ts`, remember the answer for ten minutes. A problem on the Sentry side is an answer ("unavailable", with a plain
 * sentence), never an error status, so the test page always loads.
 */
import { isFailedRequest } from "../../engine/evidence/summary.js";
import { TrackerError } from "../issues/http.js";
import { runStepsOf } from "../block-store.js";
import { evidenceView } from "../evidence-read.js";
import type { Repo } from "../repo.js";
import type { ArtifactStore } from "../storage.js";
import { rankRelated, searchWindow, uniquePaths, type Candidate, type RelatedIssue, type SearchWindow } from "./match.js";
import type { SentryStore } from "./store.js";

export const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 500;
export const NOT_CAUSATION = "These errors might be related to the failure. Sentry cannot tell us that one of them caused it.";

export type RelatedAnswer =
    | { connected: false }
    | { connected: true; state: "ok"; issues: RelatedIssue[]; note: string; checkedAt: string; cached: boolean; window: { start: string; end: string } }
    | { connected: true; state: "unavailable"; code: string; message: string };

interface Entry {
    projectId: string;
    at: number;
    value: Extract<RelatedAnswer, { state: "ok" }>;
}

/** Answers per (test, run), kept in memory for ten minutes. Nothing from Sentry is written to disk. */
export class RelatedCache {
    private readonly entries = new Map<string, Entry>();
    constructor(private readonly now: () => number = Date.now) {}

    get(key: string): Extract<RelatedAnswer, { state: "ok" }> | undefined {
        const e = this.entries.get(key);
        if (!e) return undefined;
        if (this.now() - e.at > CACHE_TTL_MS) {
            this.entries.delete(key);
            return undefined;
        }
        return e.value;
    }
    set(key: string, projectId: string, value: Extract<RelatedAnswer, { state: "ok" }>): void {
        this.entries.set(key, { projectId, at: this.now(), value });
        while (this.entries.size > MAX_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    }
    /** A connection was replaced or removed: what it found no longer applies. */
    clearProject(projectId: string): void {
        for (const [k, e] of this.entries) if (e.projectId === projectId) this.entries.delete(k);
    }
    clear(): void {
        this.entries.clear();
    }
}

/** One cache for the whole process, so that issue creation can reuse what the test page already found. */
export const relatedCache = new RelatedCache();
const cacheKey = (testId: string, executionId: string) => `${testId}:${executionId}`;

interface FailedRun {
    id: string;
    startedAt: string;
    durationMs: number | null;
    steps: Array<{ index: number; status: string }>;
}

/** The latest run that did not pass: the one the test page explains. */
export function failedRun(repo: Repo, testId: string): FailedRun | undefined {
    return (repo.listExecutions(testId) as unknown as Array<FailedRun & { status: string }>).find((e) => e.status !== "passed");
}

/** The most likely related Sentry issue the test page has already looked up for this test's failed run, if any. */
export function cachedTopIssue(repo: Repo, testId: string): { title: string; url: string } | undefined {
    const run = failedRun(repo, testId);
    const top = run ? relatedCache.get(cacheKey(testId, run.id))?.issues[0] : undefined;
    return top ? { title: top.title, url: top.url } : undefined;
}

const METHOD_PATH = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'`)\]>,;]*)/g;

/** Addresses that failed in the run: from the recorded network calls, the failure message and the step that failed. */
export async function failedPathsOf(repo: Repo, artifacts: ArtifactStore, testId: string, run: FailedRun): Promise<string[]> {
    const found: string[] = [];
    try {
        const view = await evidenceView(repo, artifacts, testId, run.id);
        if (view?.available && view.evidence) found.push(...view.evidence.requests.filter(isFailedRequest).map((r) => r.path));
    } catch {
        /* evidence is a bonus */
    }
    const test = repo.getTest(testId);
    for (const m of (test?.validationReason ?? "").matchAll(METHOD_PATH)) found.push(m[1]!);
    const failedIndex = run.steps.find((s) => s.status === "failed")?.index;
    // The numbers of a run's steps follow the steps that ran (reusable steps put in place), not the small list a test with blocks stores.
    const ran = test ? runStepsOf(repo.db, test.projectId, test.spec) : undefined;
    const step = failedIndex !== undefined ? ((ran ? ran[failedIndex]?.step : test?.spec.steps[failedIndex]) as { path?: unknown; url?: unknown } | undefined) : undefined;
    if (typeof step?.path === "string") found.push(step.path);
    if (typeof step?.url === "string") found.push(step.url);
    return uniquePaths(found);
}

const inFlight = new Map<string, Promise<RelatedAnswer>>();

export interface RelatedDeps {
    repo: Repo;
    artifacts: ArtifactStore;
    sentry: SentryStore;
    cache?: RelatedCache;
    timeoutMs?: number;
}

const web = (u: string | undefined): string | undefined => {
    try {
        return u && /^https?:$/.test(new URL(u).protocol) ? u : undefined;
    } catch {
        return undefined;
    }
};

export async function relatedErrors(deps: RelatedDeps, testId: string, opts: { refresh?: boolean } = {}): Promise<RelatedAnswer | undefined> {
    const test = deps.repo.getTest(testId);
    if (!test) return undefined;
    const conn = deps.sentry.get(test.projectId);
    if (!conn) return { connected: false };
    const unavailable = (code: string, message: string): RelatedAnswer => ({ connected: true, state: "unavailable", code, message });
    if (test.validationStatus !== "NEEDS_REVIEW" && test.validationStatus !== "FAILED_VALIDATION") return unavailable("not_failed", "Related errors are looked up for tests that found a problem or could not pass.");
    const run = failedRun(deps.repo, testId);
    if (!run) return unavailable("not_run", "This test has not been run yet, so there is no run to look up.");

    const cache = deps.cache ?? relatedCache;
    const key = cacheKey(testId, run.id);
    if (!opts.refresh) {
        const hit = cache.get(key);
        if (hit) return { ...hit, cached: true };
    }
    // Two page views at once make one request to Sentry.
    const pending = inFlight.get(key);
    if (pending) return pending;
    const work = (async (): Promise<RelatedAnswer> => {
        const client = deps.sentry.client(test.projectId, { timeoutMs: deps.timeoutMs });
        if (!client) return { connected: false };
        const window: SearchWindow = searchWindow(run.startedAt, run.durationMs);
        let candidates: Candidate[];
        try {
            candidates = await client.issuesIn(window);
        } catch (e) {
            if (e instanceof TrackerError) return unavailable(e.code, e.message);
            return unavailable("unreachable", "We couldn’t get an answer from Sentry. Try again in a moment.");
        }
        const base = conn.baseUrl.replace(/\/+$/, "");
        const issues = rankRelated(candidates, {
            window,
            paths: await failedPathsOf(deps.repo, deps.artifacts, testId, run),
            link: (c) => web(c.permalink) ?? `${base}/organizations/${encodeURIComponent(conn.organization)}/issues/${c.id}/`,
        });
        const value = { connected: true as const, state: "ok" as const, issues, note: NOT_CAUSATION, checkedAt: new Date().toISOString(), cached: false, window: { start: window.start.toISOString(), end: window.end.toISOString() } };
        cache.set(key, test.projectId, value);
        return value;
    })();
    inFlight.set(key, work);
    try {
        return await work;
    } finally {
        inFlight.delete(key);
    }
}
