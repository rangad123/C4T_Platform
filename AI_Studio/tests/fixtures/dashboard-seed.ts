/**
 * Seeding for the dashboard tests: projects, tests, finished jobs, executions and run summaries written the way the worker
 * writes them (through the repo and the real summarizing functions), with no model and no browser.
 */
import { defaultFramework } from "../../src/engine/generators/index.js";
import { TestSpecSchema, type Priority } from "../../src/engine/spec/schema.js";
import type { Platform } from "../../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../../src/platform/repo.js";
import { saveRunSummary, summarizeJob } from "../../src/platform/trends.js";

const DAY = 86_400_000;
const framework = defaultFramework("api");
// The endpoint reads the real clock, so seeded times are relative to the real "now".
export const SEED_NOW = Date.now();

export interface Seed {
    projectId: string;
    appId: string;
    tests: Map<string, string>;
    scripts: Map<string, string>;
}

const repoOf = (p: Platform) => p.repo;

export function seedProject(p: Platform, name: string, url: string | null = "http://127.0.0.1:5590"): Seed {
    const project = repoOf(p).createProject({ name });
    const appId = url ? repoOf(p).createApplication(project.id, url, { ...DEFAULT_JOB_OPTIONS }) : "";
    return { projectId: project.id, appId, tests: new Map(), scripts: new Map() };
}

export function addTest(p: Platform, s: Seed, key: string, priority: Priority = "medium"): string {
    const spec = TestSpecSchema.parse({ testId: `API-${String(s.tests.size + 1).padStart(3, "0")}`, title: `Check ${key}`, kind: "api", category: "API", priority, steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
    const suite = repoOf(p).getOrCreateSuite(s.projectId, "API", "api");
    const id = repoOf(p).insertTest({ projectId: s.projectId, suiteId: suite, jobId: null, spec, framework, validationStatus: "PENDING" });
    s.tests.set(key, id);
    s.scripts.set(key, repoOf(p).addScript(id, { framework, filename: `${key}.spec.ts`, content: "v1", hash: `h-${key}`, storagePath: `x/${key}`, executable: true }));
    return id;
}

export type Outcome = "pass" | "fail" | "flaky" | `review:${string}`;
let tick = 0;

/** A finished validation job, executions and test statuses written the way the worker writes them, then summarized with the real functions. */
export async function seedRun(p: Platform, s: Seed, outcomes: Record<string, Outcome>, opts: { daysAgo?: number; jobStatus?: "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED"; error?: string } = {}) {
    const r = repoOf(p);
    const job = await r.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: Object.keys(outcomes).map((k) => s.tests.get(k)!), trigger: "manual" });
    const failing = Object.values(outcomes).some((o) => o !== "pass" && o !== "flaky");
    r.setJobStatus(job.id, opts.jobStatus ?? (failing ? "PARTIALLY_COMPLETED" : "COMPLETED"), opts.error);
    const end = new Date(SEED_NOW - (opts.daysAgo ?? 1) * DAY + ++tick * 1000);
    r.db.run("UPDATE generation_jobs SET started_at = ?, finished_at = ?, created_at = ? WHERE id = ?", new Date(end.getTime() - 5000).toISOString(), end.toISOString(), new Date(end.getTime() - 6000).toISOString(), job.id);
    let n = 0;
    const exec = (key: string, attempt: number, status: "passed" | "failed") => {
        const id = r.addExecution({ testId: s.tests.get(key)!, scriptId: s.scripts.get(key)!, jobId: job.id, attempt, status, durationMs: 5, error: status === "failed" ? "boom" : undefined, startedAt: new Date(end.getTime() - 4000 + n).toISOString(), steps: [] });
        r.db.run("UPDATE test_executions SET started_at = ?, finished_at = ? WHERE id = ?", new Date(end.getTime() - 4000 + n).toISOString(), new Date(end.getTime() - 4000 + n).toISOString(), id);
        n++;
    };
    for (const [key, o] of Object.entries(outcomes)) {
        const id = s.tests.get(key)!;
        if (o === "pass") (exec(key, 1, "passed"), r.updateTest(id, { validationStatus: "VALIDATED", reason: null }));
        else if (o === "flaky") (exec(key, 1, "failed"), exec(key, 2, "passed"), r.updateTest(id, { validationStatus: "VALIDATED", reason: null }));
        else if (o === "fail") (exec(key, 1, "failed"), r.updateTest(id, { validationStatus: "FAILED_VALIDATION", reason: "Step failed: element not found" }));
        else (exec(key, 1, "failed"), r.updateTest(id, { validationStatus: "NEEDS_REVIEW", reason: o.slice("review:".length) }));
    }
    const done = r.getJob(job.id)!;
    saveRunSummary(p.db, summarizeJob(r, done, "low"));
    return done;
}

