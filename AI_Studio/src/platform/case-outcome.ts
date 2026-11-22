/**
 * The outcome of a Test Case Generation project (founder 2026-11-19, SPEC D2, P3, R10; PLAN.md C4): one tree of the application's pages
 * and the test cases written for them, built on read from what each of the project's runs saved. Nothing here changes a run.
 *
 * A run is a plan-only exploration of the project (case-agent.ts makes every exploration of such a project one). What a run found:
 *   - pages and navigation: the model in its plan (plan-store.ts), else its `app-model` artifact, else its `page_visited` events (a run
 *     stopped while exploring saved only those);
 *   - test cases: the test ideas of its plan, else its `scenario_planned` events;
 *     (a run from the requirements alone, SPEC R16, has only those: its cases have no page and hang on a node per requirement area);
 *   - addresses that could not be opened: its `page_failed` events. They are never pages; they are counted once, as `notOpened`.
 *
 * Runs are merged oldest first (SPEC R10): a page is one node however many runs saw it (keyed by its path), and a later run's non-empty
 * title, address and purpose win; a test case is one row however many runs planned it (keyed by its normalised title and its own start page, so a later run's pages never renumber it) and keeps
 * the TC number of its first appearance. A run's `addedPages` and `addedCases` count what it was first to find.
 *
 * The tree (SPEC P3.3): the root is "/" when it is a page, else the oldest run's first page. A page's parent is the page the explorer first
 * reached it from (navigation edges, oldest run first); without one, its nearest URL-path ancestor that is a page; else the root. A
 * parent that would close a loop is replaced the same way, so the tree always ends at the root. A test case belongs to the node of its
 * start page (the same fallbacks), so every case's page is a node; a case whose own start page is not a page keeps it as `start`. Requirement
 * areas are nodes with no page: they are never counted as pages (case-outcome-types.ts outcomeCounts).
 *
 * "Forget what we learned" also forgets the outcome: the time is kept in the object store (`<project>/case-outcome/forgotten.json`) and
 * runs started before it are left out. A finished run never changes, so what it found is kept in memory by job id.
 */
import type { Platform } from "./bootstrap.js";
import type { CaseOutcome, CaseOutcomeCase, CaseOutcomePage, CaseOutcomePriority, CaseOutcomeRun, CaseOutcomeRunStatus, CaseOutcomeTreeNode } from "./case-outcome-types.js";
import { isCaseAgentProject } from "./case-agent.js";
import { loadStoredPlan } from "./plan-store.js";
import type { JobRow } from "./repo.js";

/** What one run found, before it is merged with the others. Pages and cases are in the order the run found them. */
export interface CaseRunPart {
    pages: CaseOutcomePage[];
    /** Navigation edges (from → to, by page path), in the order they were followed. */
    edges: Array<{ from: string; to: string }>;
    /**
     * The run's test cases; `page` is the start path as planned ("" when unknown). A case written from the requirements alone (SPEC R16)
     * has an `area` (its requirement): its tree node is that area and its page stays empty.
     */
    cases: Array<Omit<CaseOutcomeCase, "id"> & { area?: string }>;
    /** Paths of the addresses that failed to load. */
    failed: string[];
}

export interface CaseRunInput {
    run: Omit<CaseOutcomeRun, "addedPages" | "addedCases">;
    part: CaseRunPart;
}

export interface MergedRuns {
    runs: CaseOutcomeRun[];
    pages: CaseOutcomePage[];
    tree: CaseOutcomeTreeNode[];
    cases: CaseOutcomeCase[];
    notOpened: number;
    /** By job id: how many distinct test cases the run wrote (new or already known). */
    written: Map<string, number>;
    /** By job id: what the run found, new or already known: its pages (node paths), its test cases (TC ids) and the paths it could not open. */
    byRun: Map<string, { pages: string[]; cases: string[]; failed: string[] }>;
}

const PRIORITIES: readonly CaseOutcomePriority[] = ["critical", "high", "medium", "low"];
const TERMINAL = new Set(["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"]);
const MAX_MISSING = 20;
export const FORGOTTEN_KEY = (projectId: string) => `${projectId}/case-outcome/forgotten.json`;

/** A page path without its query and hash route. */
const bare = (path: string): string => path.split(/[?#]/)[0] || "/";
const titleKey = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[.!?\s]+$/, "").trim();
const priorityOf = (v: unknown): CaseOutcomePriority => (PRIORITIES.includes(v as CaseOutcomePriority) ? (v as CaseOutcomePriority) : "medium");

/** The path the crawler gives a page (path + query; crawler.ts pagePath, without the hash route), or undefined for a bad address. */
export function pathOfAddress(address: string): string | undefined {
    try {
        const u = new URL(address);
        return u.pathname + u.search;
    } catch {
        return undefined;
    }
}

/** The run's status as the outcome names it. */
export function runStatusOf(job: Pick<JobRow, "status" | "error" | "cancelRequested">): CaseOutcomeRunStatus {
    if (job.status === "COMPLETED" || job.status === "PARTIALLY_COMPLETED") return "completed";
    if (job.status === "FAILED") return job.error === "Cancelled" || job.cancelRequested ? "stopped" : "failed";
    return "running";
}

/** True for a run that counts towards the outcome: a plan-only exploration (not a creation from a plan). */
export function isCaseRun(job: Pick<JobRow, "options">): boolean {
    const o = job.options;
    return (o.mode ?? "generate") === "generate" && o.planOnly === true && !o.fromPlan;
}

/** Merge the runs (oldest first) into one outcome (SPEC R10, P3.3). Pure. */
export function mergeCaseRuns(inputs: readonly CaseRunInput[]): MergedRuns {
    // ── pages: one per path, later non-empty facts win ──
    const pages = new Map<string, CaseOutcomePage>();
    const firstFrom = new Map<string, string>();
    const failed = new Set<string>();
    for (const { part } of inputs) {
        for (const pg of part.pages) {
            const had = pages.get(pg.path);
            pages.set(pg.path, had ? { path: pg.path, url: pg.url || had.url, title: pg.title || had.title, purpose: pg.purpose || had.purpose } : { ...pg });
        }
        for (const e of part.edges) if (e.from !== e.to && !firstFrom.has(e.to)) firstFrom.set(e.to, e.from);
        for (const f of part.failed) failed.add(f);
    }
    const nodes = new Set(pages.keys());
    const firstPage = inputs.find((i) => i.part.pages.length)?.part.pages[0]?.path;
    const root = nodes.has("/") ? "/" : firstPage;

    /** The nearest URL-path ancestor of `path` that is a page (never `path` itself). */
    const ancestor = (path: string): string | undefined => {
        const segs = bare(path).split("/").filter(Boolean);
        if (bare(path) !== path && nodes.has(bare(path))) return bare(path);
        while (segs.length) {
            segs.pop();
            const up = "/" + segs.join("/");
            if (up !== path && nodes.has(up)) return up;
        }
        return undefined;
    };
    /** The node a test case's start path belongs to. */
    const nodeOf = (start: string): string => {
        if (!root) return start;
        if (start && nodes.has(start)) return start;
        if (start && nodes.has(bare(start))) return bare(start);
        return (start && ancestor(start)) || root;
    };

    // ── the tree: first reached from, else URL-path ancestor, else the root; never a loop ──
    const parent = new Map<string, string | null>();
    const closesLoop = (node: string, candidate: string): boolean => {
        for (let at: string | null | undefined = candidate, n = 0; at && n <= nodes.size; at = parent.get(at), n++) if (at === node) return true;
        return false;
    };
    for (const node of nodes) {
        if (node === root) {
            parent.set(node, null);
            continue;
        }
        const from = firstFrom.get(node);
        const choices = [from && nodes.has(from) ? from : undefined, ancestor(node), root];
        parent.set(node, choices.find((c): c is string => Boolean(c) && c !== node && !closesLoop(node, c!)) ?? null);
    }

    // ── test cases: one per normalised title and start page; TC numbers by first appearance ──
    const cases = new Map<string, CaseOutcomeCase>();
    /** By case key: the requirement area a case written from the requirements alone hangs on. */
    const areaOf = new Map<string, string>();
    const runs: CaseOutcomeRun[] = [];
    const written = new Map<string, number>();
    const keysOf = new Map<string, Set<string>>();
    const seenPages = new Set<string>();
    for (const { run, part } of inputs) {
        let addedPages = 0;
        for (const pg of part.pages) {
            if (seenPages.has(pg.path)) continue;
            seenPages.add(pg.path);
            addedPages++;
        }
        let addedCases = 0;
        const mine = new Set<string>();
        for (const { area, ...c } of part.cases) {
            const title = c.title.trim();
            if (!title) continue;
            const page = area ? "" : nodeOf(c.page);
            // Keyed on the case's own start page (or its requirement area), not its node: a later run's pages move nodes, never TC numbers (F3 M3).
            const key = `${titleKey(title)}\u0000${area ? `\u0000${area}` : c.page || "/"}`;
            mine.add(key);
            if (area) areaOf.set(key, area);
            const had = cases.get(key);
            if (!had) {
                addedCases++;
                cases.set(key, { ...c, title, page, ...(area ? { area } : {}), ...(!area && c.page && c.page !== page ? { start: c.page } : {}), id: `TC-${String(cases.size + 1).padStart(3, "0")}` });
                continue;
            }
            // A later run's non-empty facts win; the number stays.
            cases.set(key, {
                ...had,
                title,
                type: c.type,
                priority: c.priority,
                preconditions: c.preconditions.length ? c.preconditions : had.preconditions,
                steps: c.steps.length ? c.steps : had.steps,
                expected: c.expected.length ? c.expected : had.expected,
                requirement: c.requirement || had.requirement,
            });
        }
        written.set(run.jobId, mine.size);
        keysOf.set(run.jobId, mine);
        runs.push({ ...run, addedPages, addedCases });
    }
    const byRun = new Map<string, { pages: string[]; cases: string[]; failed: string[] }>();
    for (const { run, part } of inputs) {
        const mine = keysOf.get(run.jobId) ?? new Set<string>();
        byRun.set(run.jobId, { pages: [...new Set(part.pages.map((pg) => pg.path))], cases: [...mine].map((k) => cases.get(k)!.id), failed: [...new Set(part.failed)] });
    }

    const count = new Map<string, number>();
    for (const c of cases.values()) count.set(c.page, (count.get(c.page) ?? 0) + 1);
    // The requirement areas are nodes of their own, after the pages: no page, no parent (SPEC R16).
    const areas = new Map<string, number>();
    for (const a of areaOf.values()) areas.set(a, (areas.get(a) ?? 0) + 1);
    const list = [...pages.values()];
    return {
        runs: runs.reverse(),
        pages: list,
        tree: [...list.map((pg) => ({ node: pg.path, parent: parent.get(pg.path) ?? null, page: pg.path, title: pg.title, cases: count.get(pg.path) ?? 0 })), ...[...areas].map(([a, n]) => ({ node: a, parent: null, page: "", title: a, cases: n }))],
        cases: [...cases.values()],
        notOpened: [...failed].filter((f) => !nodes.has(f)).length,
        written,
        byRun,
    };
}

// ── reading what a run saved ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Platformish = Pick<Platform, "repo" | "store" | "db">;
interface EventRow {
    kind: string;
    message: string;
    data_json: string | null;
}
interface ModelLike {
    pages?: Array<{ path?: unknown; url?: unknown; title?: unknown; purpose?: unknown }>;
    navigation?: Array<{ from?: unknown; to?: unknown }>;
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())) : []);

/** Finished runs never change: what each found, by job id (bounded; the oldest entries go first). */
const finished = new Map<string, CaseRunPart>();
const FINISHED_MAX = 2000;

async function appModelOf(p: Platformish, jobId: string): Promise<ModelLike | undefined> {
    const row = await p.repo.db.sql.get<{ path: string; pruned_at: string | null }>(`SELECT path, pruned_at FROM artifacts WHERE job_id = ? AND kind = 'app-model' ORDER BY created_at DESC LIMIT 1`, jobId);
    if (!row || row.pruned_at) return undefined;
    try {
        const m = JSON.parse((await p.store.getBytes(row.path)).toString("utf8")) as ModelLike;
        return m && Array.isArray(m.pages) ? m : undefined;
    } catch {
        return undefined;
    }
}

/** What one run found (SPEC D2): its plan, else its app model, else its events. */
export async function readCaseRun(p: Platformish, job: JobRow): Promise<CaseRunPart> {
    const done = TERMINAL.has(job.status);
    const hit = done ? finished.get(job.id) : undefined;
    if (hit) return hit;

    const events = await p.repo.db.sql.all<EventRow>("SELECT kind, message, data_json FROM agent_events WHERE job_id = ? AND kind IN ('page_visited','page_failed','scenario_planned') ORDER BY id LIMIT 20000", job.id);
    const dataOf = (e: EventRow): Record<string, unknown> => {
        try {
            const d = JSON.parse(e.data_json ?? "{}") as unknown;
            return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
        } catch {
            return {};
        }
    };
    const plan = await loadStoredPlan(p.repo, p.store, job.id);
    const model: ModelLike | undefined = plan.ok ? (plan.plan.model as ModelLike) : await appModelOf(p, job.id);

    const pages: CaseOutcomePage[] = [];
    const seen = new Set<string>();
    const add = (pg: CaseOutcomePage) => {
        if (!pg.path || seen.has(pg.path)) return;
        seen.add(pg.path);
        pages.push(pg);
    };
    if (model?.pages) {
        for (const pg of model.pages) add({ path: str(pg.path) || (pathOfAddress(str(pg.url)) ?? ""), url: str(pg.url), title: str(pg.title).slice(0, 300), purpose: str(pg.purpose).slice(0, 1000) });
    } else {
        for (const e of events) {
            if (e.kind !== "page_visited") continue;
            const d = dataOf(e);
            add({ path: /^Visited (\S+)/.exec(e.message)?.[1] ?? pathOfAddress(str(d.url)) ?? "", url: str(d.url), title: "", purpose: "" });
        }
    }
    const edges = (model?.navigation ?? []).flatMap((n) => (typeof n.from === "string" && typeof n.to === "string" ? [{ from: n.from, to: n.to }] : []));

    let cases: CaseRunPart["cases"];
    if (plan.ok) {
        cases = plan.plan.scenarios.map((s) => ({
            title: s.title,
            // Exploration test cases are Automated (SPEC D1): a title, a page, preconditions and expected results; no steps (Q1).
            type: "automated" as const,
            priority: priorityOf(s.priority),
            page: s.startPath || "/",
            preconditions: strings(s.preconditions),
            steps: [],
            expected: strings(s.expectedResults),
            requirement: strings(s.requirements).join(", "),
        }));
    } else {
        // A run stopped before its plan was saved keeps the test cases its planner had announced (planner.ts scenario_planned).
        cases = events
            .filter((e) => e.kind === "scenario_planned")
            .map((e) => {
                const m = /^\S+ \[[^/\]]*\/([a-z]+)\] (.*)$/.exec(e.message);
                const d = dataOf(e);
                // A case written from the requirements alone (case-agent.ts writeCasesFromRequirements) also says its type, steps and area.
                const steps = Array.isArray(d.steps) ? d.steps.map((s: { action?: unknown; expected?: unknown }) => ({ action: str(s?.action), expected: str(s?.expected) })).filter((s) => s.action) : [];
                return { title: str(d.title) || m?.[2] || "", type: d.type === "manual" ? ("manual" as const) : ("automated" as const), priority: priorityOf(m?.[1]), page: "", preconditions: [], steps, expected: [], requirement: str(d.requirement), ...(str(d.area) ? { area: str(d.area) } : {}) };
            });
    }
    // An address that could not be loaded (crawler.ts page_failed "Could not load <url>: ..."); "Could not try ... again" kept its page.
    const failed = events.flatMap((e) => {
        if (e.kind !== "page_failed") return [];
        const at = /^Could not load (\S+): /.exec(e.message)?.[1];
        const path = at ? pathOfAddress(at) : undefined;
        return path ? [path] : [];
    });

    const part: CaseRunPart = { pages, edges, cases, failed };
    if (done) {
        if (finished.size >= FINISHED_MAX) finished.delete(finished.keys().next().value!);
        finished.set(job.id, part);
    }
    return part;
}

/** When the outcome was last forgotten ("Forget what we learned"), or undefined. */
async function forgottenAt(p: Platformish, projectId: string): Promise<string | undefined> {
    try {
        const at = (JSON.parse((await p.store.getBytes(FORGOTTEN_KEY(projectId))).toString("utf8")) as { at?: unknown }).at;
        return typeof at === "string" ? at : undefined;
    } catch {
        return undefined;
    }
}

/** "Forget what we learned" forgets the outcome too: runs started before now are left out of it. */
export async function forgetCaseOutcome(p: Platformish, projectId: string, at: string = new Date().toISOString()): Promise<void> {
    await p.store.put(FORGOTTEN_KEY(projectId), JSON.stringify({ at }));
}

const EMPTY = (caseAgent: boolean): CaseOutcome => ({ caseAgent, runs: [], pages: [], tree: [], cases: [], notOpened: 0, missing: [] });

/** The project's runs that count, oldest first. */
async function caseRunsOf(p: Platformish, projectId: string): Promise<JobRow[]> {
    const order = await p.repo.db.sql.all<{ id: string }>(`SELECT id FROM generation_jobs WHERE project_id = ? ORDER BY created_at, ${p.repo.db.dialect.insertionOrder()}`, projectId);
    const byId = new Map(p.repo.listJobs(projectId).map((j) => [j.id, j]));
    const since = await forgottenAt(p, projectId);
    return order.flatMap((r) => {
        const j = byId.get(r.id);
        return j && isCaseRun(j) && !(since && j.createdAt <= since) ? [j] : [];
    });
}

export async function mergedOf(p: Platformish, projectId: string): Promise<MergedRuns> {
    const jobs = await caseRunsOf(p, projectId);
    const inputs: CaseRunInput[] = [];
    for (const j of jobs) inputs.push({ run: { jobId: j.id, startedAt: j.startedAt ?? j.createdAt, status: runStatusOf(j) }, part: await readCaseRun(p, j) });
    return mergeCaseRuns(inputs);
}

/** The project's latest application model, as its own route reads it (routes/app-intel.ts `latestAppModel`, handed in by routes/index.ts). */
export type AppModelReader = (projectId: string) => Promise<{ missingContext: ReadonlyArray<{ text: string }> } | undefined>;

/** The outcome of a project (PLAN.md "Outcome contract"). A project that is not a Test Case Generation project answers caseAgent false and empty lists. */
export async function caseOutcomeOf(p: Platformish, projectId: string, appModel: AppModelReader): Promise<CaseOutcome> {
    if (!(await isCaseAgentProject(p.repo, projectId))) return EMPTY(false);
    const { written: _w, byRun: _b, ...merged } = await mergedOf(p, projectId);
    let missing: string[] = [];
    try {
        missing = ((await appModel(projectId))?.missingContext ?? []).map((m) => m.text).slice(0, MAX_MISSING);
    } catch {
        missing = [];
    }
    return { caseAgent: true, ...merged, missing };
}

export const CASES_WRITTEN = (written: number, added: number) => `Test cases written: ${written} (${added} new)`;

/**
 * A run of a Test Case Generation project ends by saying what it wrote (founder 2026-11-19, R1): "Test cases written: N (M new)" as
 * its last event, after the engine's own words about the plan. Called by the worker's finished-job hook (schedule-services.ts) for a
 * run that completed or was stopped; a run that failed keeps its failure as its last word. Never throws.
 */
export async function noteCaseRunFinished(p: Platformish, job: JobRow): Promise<void> {
    try {
        if (!isCaseRun(job) || !TERMINAL.has(job.status)) return;
        if (runStatusOf(job) === "failed") return;
        if (!(await isCaseAgentProject(p.repo, job.projectId))) return;
        const merged = await mergedOf(p, job.projectId);
        const run = merged.runs.find((r) => r.jobId === job.id);
        if (!run) return;
        const written = merged.written.get(job.id) ?? 0;
        p.repo.addEvent(job.id, { stage: "orchestration", kind: "case_outcome_written", message: CASES_WRITTEN(written, run.addedCases), data: { written, added: run.addedCases, addedPages: run.addedPages } });
    } catch (err) {
        console.error(`[job ${job.id.slice(0, 8)}] could not say how many test cases were written:`, err);
    }
}
