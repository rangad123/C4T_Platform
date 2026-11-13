/**
 * Where an exploration keeps its plan until a person confirms it. The plan (what discovery found, the test ideas) is one JSON
 * artifact of the plan-only job; creating the tests reads it back, so the application is not explored twice.
 *
 * Nothing secret is in it: it holds what the application showed to a visitor, never the project's sign-in details.
 */
import type { Credentials, JobOptions, Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";
import type { PlanOptions, StoredPlan } from "../engine/planning/preview.js";

export const PLAN_ARTIFACT = "plan";
export const PLAN_FILE = "plan.json";

export const PLAN_GONE = "The plan is no longer available, so nothing was created. Explore the application again to get a new plan.";

export type LoadedPlan = { ok: true; plan: StoredPlan } | { ok: false; reason: "missing" | "removed" | "unreadable" };

const isPlan = (v: unknown): v is StoredPlan => {
    const p = v as StoredPlan | null;
    return !!p && p.version === 1 && Array.isArray(p.scenarios) && Array.isArray(p.accessReach) && Array.isArray(p.apiAccess) && !!p.model && Array.isArray(p.model.pages) && Array.isArray(p.model.apis);
};

export async function loadStoredPlan(repo: Repo, store: ArtifactStore, jobId: string): Promise<LoadedPlan> {
    const row = repo.db.get<{ path: string; pruned_at: string | null }>(`SELECT path, pruned_at FROM artifacts WHERE job_id = ? AND kind = ? ORDER BY created_at DESC, ${repo.db.dialect.insertionOrder()} DESC LIMIT 1`, jobId, PLAN_ARTIFACT);
    if (!row) return { ok: false, reason: "missing" };
    if (row.pruned_at) return { ok: false, reason: "removed" };
    try {
        const parsed: unknown = JSON.parse((await store.getBytes(row.path)).toString("utf8"));
        return isPlan(parsed) ? { ok: true, plan: parsed } : { ok: false, reason: "unreadable" };
    } catch {
        return { ok: false, reason: "unreadable" };
    }
}

/** Throw the plain sentence when the plan cannot be used. */
export async function requireStoredPlan(repo: Repo, store: ArtifactStore, jobId: string): Promise<StoredPlan> {
    const r = await loadStoredPlan(repo, store, jobId);
    if (!r.ok) throw new Error(PLAN_GONE);
    return r.plan;
}

/** Forget a plan the person decided not to use. */
export async function discardStoredPlan(repo: Repo, store: ArtifactStore, jobId: string): Promise<boolean> {
    const rows = repo.db.all<{ id: string; path: string }>("SELECT id, path FROM artifacts WHERE job_id = ? AND kind = ?", jobId, PLAN_ARTIFACT);
    for (const r of rows) {
        repo.db.run("DELETE FROM artifacts WHERE id = ?", r.id);
        await store.delete(r.path).catch(() => undefined);
    }
    return rows.length > 0;
}

/** The switches of a plan (or of the job that creates from it) as the estimate reads them. */
export function planOptionsOf(o: JobOptions, credentials?: Credentials): PlanOptions {
    const c = credentials;
    return {
        targets: o.targets?.length ? o.targets : ["web", "api"],
        accessibility: o.accessibility,
        healthChecks: o.healthChecks,
        securityChecks: o.securityChecks,
        performanceChecks: o.performanceChecks,
        loadChecks: o.loadChecks,
        inputChecks: o.inputChecks,
        visionChecks: o.visionChecks,
        contractChecks: o.contractChecks,
        accessChecks: o.accessChecks,
        visual: o.visual,
        allowMutatingApiTests: o.allowMutatingApiTests,
        performanceBudgets: o.performanceBudgets,
        loadBudgets: o.loadBudgets,
        excludeIdeas: o.excludeIdeas,
        hasCredential: Boolean(c?.apiToken || c?.apiAuthHeader || c?.oauth2),
        ...(o.level ? { level: o.level } : {}),
    };
}
