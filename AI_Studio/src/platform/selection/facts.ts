/**
 * What the coverage mapping reads (coverage.ts), from one project's own rows only: its tests (reusable steps put in place), the current
 * script of each, the stored evidence of runs of that script (its footprint when it has one), the application's address and its API base
 * address, and for freshness (coverage.ts freshnessOf) each test's latest approved version and its latest run on the deploy target (no
 * variant, no named environment). Declared steps are read from the latest approved version, the one runs execute, not from a draft.
 * Also which tests a run holds back because a shared part they use changed after their approval, and which run anyway after such a
 * change (held.ts, read-only: the first makes them "Cannot run", the second makes an older latest run out of date).
 * Reads only; nothing is stored.
 *
 * Also the change set the platform itself detected (`detectedChanges`): the API drift between the last two recorded runs and the
 * site memory's comparison with the analysis before. Both are what earlier jobs saw, not what a coming deploy will change.
 */
import type { TestSpec } from "../../engine/spec/schema.js";
import { parseEvidence, type Evidence } from "../../engine/evidence/model.js";
import { blockView } from "../block-store.js";
import { apiChanges } from "../drift-store.js";
import { latestMemory } from "../memory-store.js";
import type { Repo } from "../repo.js";
import type { ArtifactStore } from "../storage.js";
import { changedAfterRun, sharedPartChanges } from "./held.js";
import { extractCoverage, freshDaysFrom, freshnessOf, type AppFacts, type CurrentVersion, type LatestRun, type ObservedRun, type TestCoverage, type TestFacts } from "./coverage.js";

/** Evidence files read per test (the newest runs of its current script). */
const RUNS_PER_TEST = 3;

export interface ProjectCoverage {
    tests: TestCoverage[];
    app: AppFacts;
    /** The path of the API's base address ("/api"), when it has one. */
    apiPrefix?: string;
    /** The freshness window used, in days (SELECTION_FRESH_DAYS, default 14). */
    freshDays: number;
    /** Tests a run holds back (a shared part changed after their approval), by id, with what changed in words (held.ts). */
    held: Map<string, string>;
}

export interface CoverageOptions {
    /** Only these test ids (ids of another project are simply not found). */
    only?: ReadonlySet<string>;
    /** Epoch ms; the clock by default. */
    now?: number;
    /** The freshness window; SELECTION_FRESH_DAYS (or 14) by default. */
    freshDays?: number;
    /** More templates a captured path part can resolve to, beside the app model's (a PR's analysis: the repository's route registrations). */
    templates?: ReadonlyArray<{ method: string; path: string }>;
}

function hostOf(url: unknown): string | undefined {
    if (typeof url !== "string") return undefined;
    try {
        return new URL(url).host.toLowerCase() || undefined;
    } catch {
        return undefined;
    }
}

function prefixOf(url: unknown): string | undefined {
    if (typeof url !== "string") return undefined;
    try {
        const p = new URL(url).pathname.replace(/\/+$/, "");
        return p && p !== "/" ? p : undefined;
    } catch {
        return undefined;
    }
}

/** Coverage of the project's tests. */
export async function projectCoverage(repo: Repo, store: ArtifactStore, projectId: string, options: CoverageOptions = {}): Promise<ProjectCoverage> {
    const { only } = options;
    const now = options.now ?? Date.now();
    const freshDays = options.freshDays ?? freshDaysFrom(process.env.SELECTION_FRESH_DAYS);
    const appRow = repo.getLatestApplicationPublic(projectId);
    const apiBase = (appRow?.config as { apiBaseUrl?: unknown } | undefined)?.apiBaseUrl;
    const apiHost = hostOf(apiBase);
    const endpoints = [...modelEndpoints(repo, projectId), ...(options.templates ?? [])];
    const app: AppFacts = { appHost: hostOf(appRow?.url), ...(apiHost ? { apiHosts: [apiHost] } : {}), ...(endpoints.length ? { endpoints } : {}) };
    const apiPrefix = prefixOf(apiBase);
    // The application's address over time (a changed address is a new row): a run opened the address in force when it started.
    const addresses = repo.db
        .all<{ url: string; created_at: string }>(`SELECT url, created_at FROM applications WHERE project_id = ? ORDER BY created_at, ${repo.db.dialect.insertionOrder()}`, projectId)
        .map((r) => ({ host: hostOf(r.url), at: r.created_at }));
    const baseHostAt = (startedAt: string) => runBaseHost(addresses, startedAt);
    const rows = repo.db.all<{ id: string; test_key: string; title: string; kind: string; spec_json: string }>(
        "SELECT id, test_key, title, kind, spec_json FROM test_cases WHERE project_id = ? ORDER BY test_key",
        projectId,
    );
    const view = blockView(repo.db, projectId);
    const current = new Map(
        repo.db
            .all<{ id: string; test_case_id: string }>(
                "SELECT g.id, g.test_case_id FROM generated_scripts g JOIN test_cases t ON t.id = g.test_case_id WHERE t.project_id = ? AND g.is_current = 1",
                projectId,
            )
            .map((r) => [r.test_case_id, r.id] as const),
    );
    // Runs with stored evidence, newest first; only the default target (no variant, no named environment), as a test's history shows.
    const evidenceRows = repo.db.all<{ test_case_id: string; execution_id: string; status: string; started_at: string; script_id: string | null; path: string; pruned_at: string | null }>(
        `SELECT e.test_case_id, e.id AS execution_id, e.status, e.started_at, e.script_id, a.path, a.pruned_at
           FROM artifacts a JOIN test_executions e ON e.id = a.execution_id
          WHERE a.project_id = ? AND a.kind = 'evidence' AND e.variant IS NULL AND e.environment IS NULL
          ORDER BY e.started_at DESC`,
        projectId,
    );
    // What runs execute now: the latest approved version of each test.
    const approved = new Map<string, { id: string; version: number; spec_json: string }>();
    for (const v of repo.db.all<{ id: string; test_case_id: string; version: number; spec_json: string }>(
        "SELECT id, test_case_id, version, spec_json FROM test_versions WHERE project_id = ? AND state = 'approved' ORDER BY version DESC",
        projectId,
    )) {
        if (!approved.has(v.test_case_id)) approved.set(v.test_case_id, { id: v.id, version: Number(v.version), spec_json: v.spec_json });
    }
    // The latest run of each test on the deploy target, whatever its status and whether or not it kept a record (a retry: the later attempt).
    const latest = new Map<string, LatestRun & { attempt: number }>();
    for (const e of repo.db.all<{ id: string; test_case_id: string; status: string; started_at: string; script_id: string | null; test_version_id: string | null; attempt: number }>(
        `SELECT e.id, e.test_case_id, e.status, e.started_at, e.script_id, e.test_version_id, e.attempt
           FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id
          WHERE t.project_id = ? AND e.variant IS NULL AND e.environment IS NULL
            AND e.started_at = (SELECT MAX(x.started_at) FROM test_executions x WHERE x.test_case_id = e.test_case_id AND x.variant IS NULL AND x.environment IS NULL)`,
        projectId,
    )) {
        const had = latest.get(e.test_case_id);
        if (had && had.attempt >= Number(e.attempt)) continue;
        latest.set(e.test_case_id, { executionId: e.id, status: e.status, startedAt: e.started_at, versionId: e.test_version_id ?? null, scriptId: e.script_id ?? null, attempt: Number(e.attempt) });
    }
    const partChanges = sharedPartChanges(repo.db, projectId);
    const held = new Map<string, string>();
    for (const [id, c] of partChanges) if (c.held) held.set(id, c.what);
    const evidenceByTest = new Map<string, typeof evidenceRows>();
    for (const r of evidenceRows) {
        if (!r.script_id || r.script_id !== current.get(r.test_case_id) || r.pruned_at) continue;
        const list = evidenceByTest.get(r.test_case_id) ?? [];
        if (list.length < RUNS_PER_TEST) list.push(r);
        evidenceByTest.set(r.test_case_id, list);
    }

    const tests: TestCoverage[] = [];
    for (const row of rows) {
        if (only && !only.has(row.id)) continue;
        let spec: unknown;
        let specUnreadable = false;
        try {
            spec = JSON.parse(row.spec_json);
            // Runs execute the latest approved version: its steps are what a run touches, not a newer draft's.
            const v = approved.get(row.id);
            if (v) spec = JSON.parse(v.spec_json);
            if (spec && typeof spec === "object" && Array.isArray((spec as { steps?: unknown }).steps)) spec = view(spec as TestSpec);
        } catch {
            specUnreadable = true;
        }
        const runs: ObservedRun[] = [];
        for (const e of evidenceByTest.get(row.id) ?? []) {
            try {
                const ev = parseEvidence((await store.getBytes(e.path)).toString("utf8"));
                if (!ev) continue;
                const baseHost = baseHostAt(e.started_at);
                runs.push({ executionId: e.execution_id, status: e.status, startedAt: e.started_at, ...observedOf(ev), ...(baseHost ? { baseHost } : {}) });
            } catch {
                /* a file that is gone or unreadable adds nothing */
            }
        }
        const v = approved.get(row.id);
        const cur: CurrentVersion = { ...(v ? { versionId: v.id, version: v.version } : {}), ...(current.get(row.id) ? { scriptId: current.get(row.id) } : {}) };
        let freshness = freshnessOf(latest.get(row.id), cur, now, freshDays);
        // A shared part changed after the latest run and runs use the change without a new version: that run no longer vouches for it.
        const part = partChanges.get(row.id);
        const last = latest.get(row.id);
        // (Also for a latest run that only did not pass: an API test can still rest on it.)
        const vouches = () => freshness.fresh || freshness.notPassed === true;
        const partWhy = vouches() && part && last ? changedAfterRun(part, last.startedAt) : undefined;
        if (partWhy) freshness = { fresh: false, why: partWhy };
        // The application's address moved to another host after the latest run: it touched the old address, not what runs open now.
        const ranOn = vouches() && last ? baseHostAt(last.startedAt) : undefined;
        if (vouches() && last && ranOn && app.appHost && ranOn !== app.appHost) {
            freshness = { fresh: false, why: `The application's address changed after its latest run (${last.startedAt.slice(0, 10)}), so what it touched was on the old address.` };
        }
        const facts: TestFacts = { id: row.id, testKey: row.test_key, title: row.title, kind: row.kind, spec, ...(specUnreadable ? { specUnreadable } : {}), runs, freshness };
        tests.push(extractCoverage(facts, app));
    }
    return { tests, app, ...(apiPrefix ? { apiPrefix } : {}), freshDays, held };
}

/** The documented and observed endpoint templates of the project's latest app model (engine/intel/model.ts), and its pages (opened with GET); none when it has no model. */
function modelEndpoints(repo: Repo, projectId: string): Array<{ method: string; path: string }> {
    const row = repo.db.get<{ model_json: string }>("SELECT model_json FROM app_model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1", projectId);
    try {
        const model = JSON.parse(row?.model_json ?? "{}") as { endpoints?: unknown; pages?: unknown };
        const endpoints = Array.isArray(model.endpoints) ? model.endpoints.flatMap((e) => (e && typeof e.method === "string" && typeof e.path === "string" ? [{ method: e.method, path: e.path }] : [])) : [];
        const pages = Array.isArray(model.pages) ? model.pages.flatMap((p) => (p && typeof p.path === "string" ? [{ method: "GET", path: p.path }] : [])) : [];
        return [...endpoints, ...pages];
    } catch {
        return [];
    }
}

/**
 * The host of the application's address in force when a run started: the newest address set at or before then. A run older than every
 * recorded address (data from before addresses were kept) is taken to have opened the first one.
 */
export function runBaseHost(addresses: ReadonlyArray<{ host?: string; at: string }>, startedAt: string): string | undefined {
    const t = Date.parse(startedAt);
    let found: { host?: string; at: string } | undefined;
    for (const a of addresses) {
        const at = Date.parse(a.at);
        if (Number.isFinite(t) && Number.isFinite(at) && at <= t) found = a;
    }
    return (found ?? addresses[0])?.host;
}

/** A footprint page's path: `/path#route`, or `host/path` for another host's page. */
function footprintPage(path: string): { path: string; host?: string } {
    if (path.startsWith("/")) return { path };
    const at = path.indexOf("/");
    return at > 0 ? { host: path.slice(0, at), path: path.slice(at) } : { host: path, path: "/" };
}

/**
 * What one stored record says a run touched. A footprint is the whole story unless it says it was cut or could not classify a request;
 * an older record without one (only the requests it kept) never is: it does not hold the pages reached inside the page.
 */
export function observedOf(ev: Evidence): Pick<ObservedRun, "complete" | "incompleteWhy" | "queryUnknown" | "unclassified" | "requests"> {
    const fp = ev.footprint;
    if (!fp) {
        return {
            complete: false,
            incompleteWhy: "The recorded runs were made before runs kept their full footprint (pages reached inside the page), so they show only part of what the test does.",
            requests: ev.requests.map((r) => ({ method: r.method, type: r.type, path: r.path, ...(r.host ? { host: r.host } : {}) })),
        };
    }
    const requests: ObservedRun["requests"] = [
        ...fp.pages.map((p) => ({ method: "GET", type: "route", ...footprintPage(p.path) })),
        ...fp.endpoints.map((e) => ({ method: e.method, type: e.type ?? "fetch", path: e.path, ...(e.host ? { host: e.host } : {}) })),
    ];
    const why = fp.truncated ? "A passing run's record was cut to its size limit, so it shows only part of what the test does." : undefined;
    return { complete: !fp.truncated, ...(why ? { incompleteWhy: why } : {}), queryUnknown: true, ...(fp.unclassified ? { unclassified: fp.unclassified } : {}), requests };
}

export interface DetectedChanges {
    pages: string[];
    endpoints: string[];
    /** Where each list came from, in words, and what it cannot know. */
    sources: string[];
    message?: string;
}

/** The changes the platform itself saw in earlier jobs, as a change set a person can preview (and edit). */
export function detectedChanges(repo: Repo, projectId: string): DetectedChanges {
    const pages = new Set<string>();
    const endpoints = new Set<string>();
    const sources: string[] = [];
    const drift = apiChanges(repo.db, projectId);
    if (drift?.from && drift.to) {
        for (const c of [...drift.breaking, ...drift.nonBreaking]) endpoints.add(c.operation);
        sources.push(`API responses: what changed between the runs of ${drift.from.at.slice(0, 10)} and ${drift.to.at.slice(0, 10)} (${drift.breaking.length} breaking, ${drift.nonBreaking.length} other).`);
    }
    const memory = latestMemory(repo.db, projectId);
    const m = memory?.changes;
    if (m) {
        for (const p of [...m.pagesChanged, ...m.pagesAdded, ...m.pagesRemoved]) pages.add(p);
        for (const e of [...m.endpointsAdded, ...m.endpointsRemoved]) endpoints.add(e);
        sources.push(`Site memory: pages and endpoints that differed from the analysis of ${m.since.slice(0, 10)} at the analysis of ${memory.updatedAt.slice(0, 10)}.`);
    }
    return {
        pages: [...pages].sort(),
        endpoints: [...endpoints].sort(),
        sources,
        ...(sources.length ? {} : { message: "No change has been detected yet: that needs two runs with API tests, or two analyses of the application. Enter the changed pages or endpoints yourself." }),
    };
}
