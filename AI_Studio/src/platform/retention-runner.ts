/**
 * Applies a retention policy: works out what may go (preview), removes it (run), and does the daily pass from the scheduler.
 *
 * Safety, in the order it matters:
 *  - nothing is removed unless the project's policy is enabled; a manual run also needs the caller to say `confirm`;
 *  - a project with a job in flight is never pruned (the job is writing the very files and rows this reads);
 *  - preview and run call the same `planFor`, so they cannot disagree about which files are involved;
 *  - only files named by artifact rows of the project are touched, each resolved inside the artifact folder, as a plain file
 *    (a link or a folder is skipped), one by one; a file that cannot be removed is logged and skipped, never fatal;
 *  - the artifact row stays, marked pruned, and so do the execution rows: run history, trends and flaky detection do not change.
 */
import { formatBytes, previewSentence } from "../engine/retention/format.js";
import type { RetentionPolicy } from "../engine/retention/policy.js";
import { planPrune, type PrunePlan, type RetentionArtifact, type RetentionExecution } from "../engine/retention/rules.js";
import type { Platform } from "./bootstrap.js";
import type { Row } from "./db.js";
import { HttpError } from "./http-error.js";
import { LocalDiskStore } from "./object-store.js";
import { RetentionStore } from "./retention-store.js";
import { activeJobOf } from "./scheduler.js";
import { forgetUsage } from "./storage-usage.js";

const SAMPLE = 20;
/** At most one scheduled run per project in this long. */
export const SCHEDULED_EVERY_MS = 24 * 60 * 60 * 1000;

const ms = (iso: string | null | undefined): number => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? 0 : t;
};

export const retentionStore = (p: Platform): RetentionStore => new RetentionStore(p.db, p.config.RETENTION_DEFAULT_DAYS);

export interface PlannedFile {
    id: string;
    kind: string;
    size: number;
    path: string;
    reason: string;
    /** The test key (WEB-001...) the file belongs to, when it belongs to one. */
    test: string | null;
}

export interface FullPlan {
    plan: PrunePlan;
    /** The files to remove, with the paths the run needs (never sent to a client). */
    files: PlannedFile[];
}

/** Everything the rules need, read from the database for one project. */
export function planFor(p: Platform, projectId: string, policy: RetentionPolicy, now: number): FullPlan {
    const execRows = p.db.all<Row>(
        `SELECT e.id, e.test_case_id, e.status, e.started_at, e.variant, e.environment
         FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?`,
        projectId,
    );
    const executions: RetentionExecution[] = execRows.map((r) => ({
        id: r.id,
        testId: r.test_case_id,
        group: r.variant ? `variant:${r.variant}` : r.environment ? `env:${r.environment}` : "",
        startedAt: ms(r.started_at),
        passed: r.status === "passed",
    }));
    const startedAt = new Map(executions.map((e) => [e.id, e.startedAt]));

    const rows = p.db.all<Row>("SELECT id, kind, path, size, execution_id, test_case_id, created_at FROM artifacts WHERE project_id = ? AND pruned_at IS NULL", projectId);
    const pathOf = new Map(rows.map((r) => [r.id as string, { path: r.path as string, test: (r.test_case_id as string | null) ?? null }]));
    const artifacts: RetentionArtifact[] = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        size: Number(r.size ?? 0),
        executionId: r.execution_id ?? null,
        at: (r.execution_id ? startedAt.get(r.execution_id) : undefined) ?? ms(r.created_at),
    }));

    // No issue state is stored (an issue lives in the tracker), so every filed issue counts as open.
    const issueTimes = new Map<string, number[]>();
    for (const r of p.db.all<Row>("SELECT l.test_case_id, l.created_at FROM issue_links l JOIN test_cases t ON t.id = l.test_case_id WHERE t.project_id = ?", projectId)) {
        const list = issueTimes.get(r.test_case_id) ?? [];
        list.push(ms(r.created_at));
        issueTimes.set(r.test_case_id, list);
    }
    const releaseMoments = p.db
        .all<Row>("SELECT signed_at, snapshot_at, created_at FROM releases WHERE project_id = ?", projectId)
        .map((r) => ms(r.signed_at ?? r.snapshot_at ?? r.created_at));

    const plan = planPrune({ now, policy, executions, artifacts, issueTimes, releaseMoments });
    const tests = new Map(p.db.all<Row>("SELECT id, test_key FROM test_cases WHERE project_id = ?", projectId).map((r) => [r.id as string, r.test_key as string]));
    const files = plan.prune.map((x) => ({ id: x.id, kind: x.kind, size: x.size, path: pathOf.get(x.id)?.path ?? "", reason: x.reason, test: pathOf.get(x.id)?.test ? (tests.get(pathOf.get(x.id)!.test!) ?? null) : null }));
    return { plan, files };
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

/** What the API shows for a plan: counts, sizes, dates and the first few files as ids (never a path on this computer). */
export function publicPlan(policy: RetentionPolicy, full: FullPlan) {
    const { plan } = full;
    return {
        enabled: policy.enabled,
        files: plan.files,
        bytes: plan.bytes,
        size: formatBytes(plan.bytes),
        oldest: iso(plan.oldest),
        newest: iso(plan.newest),
        byKind: plan.byKind,
        byReason: plan.byReason,
        kept: plan.protectedFiles,
        sentence: previewSentence(plan, policy),
        sample: full.files.slice(0, SAMPLE).map((f) => ({ id: f.id, kind: f.kind, size: f.size, test: f.test })),
        sampleOf: Math.min(SAMPLE, plan.files),
    };
}

export interface RunResult {
    files: number;
    bytes: number;
    errors: number;
    errorSample: string | null;
}

const running = new Set<string>();

/**
 * Remove what the plan lists. Reads the plan fresh (never trusts an earlier preview), refuses while a job runs, and records
 * the run in the log. The caller has already decided that removing is allowed (enabled, confirmed or scheduled).
 */
export async function pruneProject(p: Platform, projectId: string, policy: RetentionPolicy, trigger: "manual" | "scheduled", now = Date.now()): Promise<RunResult> {
    if (running.has(projectId)) throw new HttpError(409, "Files for this project are already being removed. Wait a moment and try again.");
    const busy = await activeJobOf(p.repo, projectId);
    if (busy) throw new HttpError(409, "A run is still going for this project. Files are only removed when nothing is running; try again when it has finished.");
    running.add(projectId);
    try {
        const full = planFor(p, projectId, policy, now);
        const stamp = new Date(now).toISOString();
        let files = 0;
        let bytes = 0;
        const problems: string[] = [];
        let errors = 0;
        for (const f of full.files) {
            try {
                const outcome = await removeOne(p, f.path);
                if (outcome === "skipped") throw new Error("it is not a plain file");
                p.db.run("UPDATE artifacts SET pruned_at = ?, pruned_reason = ? WHERE id = ? AND pruned_at IS NULL", stamp, f.reason, f.id);
                files++;
                bytes += f.size;
            } catch (e) {
                errors++;
                if (problems.length < 3) problems.push(`A ${f.kind} file could not be removed: ${e instanceof Error ? e.message.replace(/['"]?[A-Za-z]:\\[^\s'"]*|['"]?\/[^\s'"]+/g, "(path hidden)") : "unknown problem"}`);
            }
            // Large runs must not starve the server of the event loop.
            if ((files + errors) % 200 === 0) await new Promise((r) => setImmediate(r));
        }
        // Empty folders left behind are tidied up, but only folders below a project's _artifacts folder.
        await tidyEmptyFolders(p, projectId, full.files);
        const result: RunResult = { files, bytes, errors, errorSample: problems.length ? problems.join(" ") : null };
        retentionStore(p).log(projectId, { at: stamp, trigger, files, bytes, errors, errorSample: result.errorSample ?? undefined });
        forgetUsage(p);
        return result;
    } finally {
        running.delete(projectId);
    }
}

/** Remove one file below the artifact folder. A file that is already gone counts as removed. */
async function removeOne(p: Platform, rel: string): Promise<"removed" | "gone" | "skipped"> {
    if (!rel) return "skipped";
    // Throws when the key leaves the artifact folder, and for a link or a folder where a file should be.
    return (await p.store.delete(rel)) ? "removed" : "gone";
}

/** Empty folders left behind on local disk, only below the project's _artifacts folder. S3 has no folders, so nothing to do there. */
async function tidyEmptyFolders(p: Platform, projectId: string, files: PlannedFile[]): Promise<void> {
    if (!(p.store instanceof LocalDiskStore)) return;
    await p.store.removeEmptyFolders(
        files.flatMap((f) => (f.path ? [f.path] : [])),
        `${projectId}/_artifacts`,
    ).catch(() => undefined); // tidying is a nicety
}

/** A manual run: needs an enabled policy and an explicit confirm. */
export async function runNow(p: Platform, projectId: string, confirm: boolean): Promise<RunResult & { sentence: string }> {
    const policy = retentionStore(p).effective(projectId);
    if (!policy.enabled) throw new HttpError(409, "Retention is switched off for this project, so nothing is removed. Turn it on first.");
    if (confirm !== true) throw new HttpError(400, "Confirm that you want these files removed (send confirm: true).");
    const r = await pruneProject(p, projectId, policy, "manual");
    const base = r.files === 0 && r.errors === 0 ? "Nothing needed removing." : `Removed ${r.files} ${r.files === 1 ? "file" : "files"} (${formatBytes(r.bytes)}).`;
    return { ...r, sentence: r.errors ? `${base} ${r.errors} could not be removed and ${r.errors === 1 ? "was" : "were"} left in place.` : base };
}

/**
 * The daily pass, called from the scheduler's tick. For every project whose effective policy is enabled, at most once a day
 * and never while a job is running. Never throws: one project's problem must not stop the others.
 */
export async function runScheduledRetention(p: Platform, now = Date.now()): Promise<Array<{ projectId: string; result: "pruned" | "busy" | "recent" | "error"; files?: number }>> {
    const store = retentionStore(p);
    const out: Array<{ projectId: string; result: "pruned" | "busy" | "recent" | "error"; files?: number }> = [];
    for (const project of p.repo.listProjects()) {
        const projectId = project.id as string;
        try {
            const policy = store.effective(projectId);
            if (!policy.enabled) continue;
            const last = store.lastScheduledAt(projectId);
            if (last !== undefined && now - last < SCHEDULED_EVERY_MS) {
                out.push({ projectId, result: "recent" });
                continue;
            }
            if (await activeJobOf(p.repo, projectId)) {
                out.push({ projectId, result: "busy" });
                continue;
            }
            const r = await pruneProject(p, projectId, policy, "scheduled", now);
            out.push({ projectId, result: "pruned", files: r.files });
        } catch (e) {
            out.push({ projectId, result: "error" });
            console.error(`[retention] project ${projectId.slice(0, 8)}:`, e instanceof Error ? e.message : e);
        }
    }
    return out;
}
