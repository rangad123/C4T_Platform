import { CleanupStore } from "./cleanup-store.js";
import { recordObservations } from "./drift-store.js";
import { addEnvironmentExecution, isRepeatedEnvironmentSkip } from "./environments-store.js";
import { HealingStore } from "./healing-store.js";
import { loadMemory, saveMemory } from "./memory-store.js";
import { recordMetrics } from "./perf-store.js";
import { testFilesFor } from "./test-data-reset-store.js";
import path from "node:path";
import type { RenderedScript } from "../engine/generators/index.js";
import type { GenerationSink, TestHandle } from "../engine/orchestrator.js";
import type { ScriptRun } from "../engine/validation/runner.js";
import type { Repo, JobCounters, JobMode, ValidationState } from "./repo.js";
import { slugify, type ArtifactStore } from "./storage.js";
import { localPathOf, putText } from "./object-store.js";
import { addVariantExecution, isRepeatedSkip } from "./variants-store.js";
import { rememberPhone } from "./phone-run-store.js";
import { JobWriteQueue } from "./job-write-queue.js";
import type { EngineEvent } from "../engine/context.js";

/**
 * Stores a rendered script as the test's current version for its framework. An unchanged script
 * (same content as the current version) is not versioned again — re-validation re-renders every
 * time, and identical versions would only bury the real history.
 */
export async function storeScript(repo: Repo, store: ArtifactStore, projectId: string, testDbId: string, suiteSlug: string, script: RenderedScript, executable: boolean): Promise<string> {
    const rel = path.posix.join(projectId, suiteSlug, script.filename);
    const stored = await putText(store, rel, script.content);
    const current = repo.getCurrentScript(testDbId, script.framework);
    if (current && current.content === script.content && current.storage_path === rel && Boolean(current.executable) === executable) return current.id as string;
    return repo.addScript(testDbId, { framework: script.framework, filename: script.filename, content: script.content, hash: stored.hash, storagePath: rel, executable });
}

/**
 * Persists engine output for one job into SQLite + the artifact store. The engine's events, its agents' actions and the methods that only
 * touch the database go through one ordered queue (job-write-queue.ts), so they land in the order they were made whether the stores behind
 * them are synchronous (today) or not. The methods that store files do not. The job runner flushes the queue before the job's final status.
 */
export class RepoSink implements GenerationSink {
    private readonly suiteSlugByTest = new Map<string, string>();
    /** This job's writes, in order. */
    readonly writes = new JobWriteQueue();

    constructor(
        private readonly repo: Repo,
        private readonly store: ArtifactStore,
        private readonly job: { id: string; projectId: string; applicationId: string; mode?: JobMode },
    ) {}

    /** One engine event for this job, in order with the job's other writes (the engine's `emit` stays synchronous). */
    event(e: EngineEvent): void {
        this.writes.push(() => this.repo.addEvent(this.job.id, e));
    }

    phase: GenerationSink["phase"] = (status, phase, state) =>
        this.writes.run(() => {
            if (state === "running") this.repo.setJobStatus(this.job.id, status);
            this.repo.setPhase(this.job.id, phase, state);
        });

    counters: GenerationSink["counters"] = (patch, add = false) => this.writes.run(() => this.repo.updateCounters(this.job.id, patch as Partial<JobCounters>, add));

    saveModel: GenerationSink["saveModel"] = (model) => this.writes.run(() => this.repo.setAppModel(this.job.applicationId, model));

    /** The device a phone exploration or run used, and the screen that opens the app there (phone-run-store.ts): this job's project only. */
    rememberPhone: NonNullable<GenerationSink["rememberPhone"]> = (d) => this.writes.run(() => rememberPhone(this.repo, this.job.projectId, d));

    /** Site memory is per project: this job's project id is the only one these ever touch. */
    loadMemory: NonNullable<GenerationSink["loadMemory"]> = (origin) => this.writes.run(() => loadMemory(this.repo.db, this.job.projectId, origin));

    saveMemory: NonNullable<GenerationSink["saveMemory"]> = (knowledge, changes) => this.writes.run(() => saveMemory(this.repo.db, { projectId: this.job.projectId, jobId: this.job.id, knowledge, changes }));

    nextTestKey: GenerationSink["nextTestKey"] = (prefix) => this.writes.run(() => this.repo.db.tx(() => this.repo.nextTestKey(this.job.projectId, prefix)));

    createTest: GenerationSink["createTest"] = ({ spec, framework, validation, reason, meta }) =>
        this.writes.run(() => {
            const slug = slugify(spec.category);
            const suiteId = this.repo.getOrCreateSuite(this.job.projectId, spec.category, slug);
            const id = this.repo.insertTest({ projectId: this.job.projectId, suiteId, jobId: this.job.id, spec, framework, validationStatus: validation, meta });
            if (reason) this.repo.updateTest(id, { reason });
            this.suiteSlugByTest.set(id, slug);
            return { id, testId: spec.testId };
        });

    /** What each test was before this job began validating it (status and reason), so a cancelled job can put it back. */
    private readonly before = new Map<string, { status: ValidationState; reason: string | null }>();

    updateTest: GenerationSink["updateTest"] = (h, patch) =>
        this.writes.run(() => {
            if (patch.validation === "VALIDATING" && !this.before.has(h.id)) {
                const t = this.repo.getTest(h.id);
                if (t) this.before.set(h.id, { status: t.validationStatus as ValidationState, reason: t.validationReason ?? null });
            }
            this.repo.updateTest(h.id, { spec: patch.spec, validationStatus: patch.validation, reason: patch.reason, attempts: patch.attempts, meta: patch.meta });
        });

    /**
     * A cancelled job did not get to this test: its status and reason go back to what they were before the job marked it as being
     * validated. Nothing was recorded for it (no execution, no artifact), so its history is untouched too.
     */
    restoreTest: NonNullable<GenerationSink["restoreTest"]> = (h) => this.writes.run(() => this.restoreNow(h));

    private restoreNow(h: TestHandle): void {
        const was = this.before.get(h.id);
        if (!was) return;
        const now = this.repo.getTest(h.id);
        // Only a test still waiting on this job: a result recorded since (the test finished) is never undone.
        if (now?.validationStatus === "VALIDATING") this.repo.updateTest(h.id, { validationStatus: was.status, reason: was.reason });
        this.before.delete(h.id);
    }

    /** After a cancel: every test this job left in "being validated" goes back to what it was. How many were put back. */
    restoreInterrupted(): Promise<number> {
        return this.writes.run(() => {
            let n = 0;
            for (const id of [...this.before.keys()]) {
                if (this.repo.getTest(id)?.validationStatus !== "VALIDATING") continue;
                this.restoreNow({ id, testId: "" });
                n++;
            }
            return n;
        });
    }

    /** Suite folder of a test; tests this job did not create (re-validation) are looked up. */
    private suiteSlug(testDbId: string): string {
        let slug = this.suiteSlugByTest.get(testDbId);
        if (!slug) {
            const t = this.repo.getTest(testDbId);
            slug = (t && (this.repo.getSuite(t.suiteId)?.slug as string | undefined)) ?? "general";
            this.suiteSlugByTest.set(testDbId, slug);
        }
        return slug;
    }

    saveScript: GenerationSink["saveScript"] = (h, script, executable) => storeScript(this.repo, this.store, this.job.projectId, h.id, this.suiteSlug(h.id), script, executable);

    recordExecution: GenerationSink["recordExecution"] = async (h: TestHandle, scriptId: string | null, attempt: number, run: ScriptRun, startedAt: string) => {
        const executionId = this.repo.addExecution({
            testId: h.id,
            scriptId,
            jobId: this.job.id,
            attempt,
            status: run.status,
            durationMs: run.durationMs,
            error: run.error,
            startedAt,
            steps: run.steps,
        });
        if (run.metrics?.length) await recordMetrics(this.repo.db.sql, { projectId: this.job.projectId, testId: h.id, executionId, samples: run.metrics });
        // API drift: the shape (never the values) of what the API answered; never throws.
        if (run.responses.length) recordObservations(this.repo.db, { projectId: this.job.projectId, jobId: this.job.id, responses: run.responses });
        // Validation-only jobs run the same test again later; keep each run's artifacts apart so an
        // earlier execution's screenshot/trace is never overwritten by a re-validation.
        const runDir = this.job.mode === "validate" || this.job.mode === "plain" ? path.posix.join(`job-${this.job.id.slice(0, 8)}`, `attempt-${attempt}`) : `attempt-${attempt}`;
        for (const a of run.artifacts) {
            try {
                // Visual images keep Playwright's name (<snapshot>-actual.png / -diff.png): one test can have several
                // screenshots, and accepting a new baseline maps each actual back to its snapshot name.
                // The same goes for AI-judgement screenshots (one per `looksRight` step).
                const file = a.kind.startsWith("visual-") || a.kind === "vision-shot" ? path.basename(a.path) : `${a.kind}${path.extname(a.path)}`;
                const rel = path.posix.join(this.job.projectId, "_artifacts", h.testId, runDir, file);
                const saved = await this.store.putFile(rel, a.path);
                this.repo.addArtifact({ projectId: this.job.projectId, jobId: this.job.id, testId: h.id, executionId, kind: a.kind, path: rel, size: saved.size });
            } catch {
                /* artifact vanished with its scratch dir — non-fatal */
            }
        }
    };

    /** A browser / screen-size result: stored as an execution tagged with its variant, with its own evidence files. */
    recordVariant: NonNullable<GenerationSink["recordVariant"]> = async (h, scriptId, r, startedAt) => {
        if (r.status === "skipped" && r.reason && isRepeatedSkip(this.repo.db, h.id, r.variant, r.reason)) return;
        const run = r.run;
        const executionId = addVariantExecution(this.repo.db, {
            testId: h.id,
            scriptId,
            jobId: this.job.id,
            variant: r.variant,
            status: r.status,
            reason: r.reason,
            durationMs: run?.durationMs ?? 0,
            startedAt,
            steps: run?.steps ?? [],
        });
        // Only a run that failed has evidence worth keeping (Playwright keeps screenshot / video / trace on failure).
        if (r.status !== "failed") return;
        for (const a of run?.artifacts ?? []) {
            try {
                const rel = path.posix.join(this.job.projectId, "_artifacts", h.testId, `job-${this.job.id.slice(0, 8)}`, `variant-${r.variant}`, `${a.kind}${path.extname(a.path)}`);
                const saved = await this.store.putFile(rel, a.path);
                this.repo.addArtifact({ projectId: this.job.projectId, jobId: this.job.id, testId: h.id, executionId, kind: a.kind, path: rel, size: saved.size });
            } catch {
                /* artifact vanished with its scratch dir — non-fatal */
            }
        }
    };

    /** A result for one named environment: an execution tagged with it, plus the evidence of a run that went wrong. */
    recordEnvironment: NonNullable<GenerationSink["recordEnvironment"]> = async (h, scriptId, r, startedAt) => {
        if (r.status === "skipped" && r.reason && isRepeatedEnvironmentSkip(this.repo.db, h.id, r.environment, r.reason)) return;
        const run = r.run;
        const executionId = addEnvironmentExecution(this.repo.db, {
            testId: h.id,
            scriptId,
            jobId: this.job.id,
            environment: r.environment,
            status: r.status,
            reason: r.reason,
            durationMs: run?.durationMs ?? 0,
            startedAt,
            steps: run?.steps ?? [],
        });
        if (r.status === "passed" || r.status === "skipped") return;
        for (const a of run?.artifacts ?? []) {
            try {
                const rel = path.posix.join(this.job.projectId, "_artifacts", h.testId, `job-${this.job.id.slice(0, 8)}`, `env-${r.environment}`, `${a.kind}${path.extname(a.path)}`);
                const saved = await this.store.putFile(rel, a.path);
                this.repo.addArtifact({ projectId: this.job.projectId, jobId: this.job.id, testId: h.id, executionId, kind: a.kind, path: rel, size: saved.size });
            } catch {
                /* artifact vanished with its scratch dir — non-fatal */
            }
        }
    };

    saveBaselines: GenerationSink["saveBaselines"] = async (h, files) => {
        for (const f of files) {
            const rel = path.posix.join(this.job.projectId, "_baselines", h.testId, f.name);
            const saved = await this.store.putFile(rel, f.path);
            this.repo.replaceArtifact({ projectId: this.job.projectId, jobId: this.job.id, testId: h.id, kind: "baseline", path: rel, size: saved.size });
        }
    };

    loadBaselines: GenerationSink["loadBaselines"] = (h) => this.writes.run(() => this.baselinesOf(h));

    private baselinesOf(h: TestHandle): Array<{ name: string; path: string }> {
        return [
            ...this.repo
                .listArtifacts({ testId: h.id })
                .filter((a) => a.kind === "baseline")
                // A path on this machine for the engine: the stored file on local disk (object-store.ts, localPathOf; async with M1).
                .flatMap((a) => {
                    const file = localPathOf(this.store, a.path as string);
                    return file ? [{ name: path.posix.basename(a.path as string), path: file }] : [];
                }),
            // The test files its upload steps use travel with the baselines (to this machine's run folder or a runner's), see engine/web/pages.ts.
            ...testFilesFor(this.repo, this.store, this.job.projectId, h.id),
        ];
    }

    /** The locator-repair suggestion for a failed test replaces the ones still open for it (none = the analysis found nothing to suggest). */
    saveHealing: NonNullable<GenerationSink["saveHealing"]> = (h, result) =>
        this.writes.run(() => {
            new HealingStore(this.repo.db).record(h.id, this.job.id, result.status === "proposed" ? result.proposal : undefined);
        });

    /** The ledger of records this run's tests created and what became of each (ids and paths only). */
    saveCleanup: NonNullable<GenerationSink["saveCleanup"]> = (items) =>
        this.writes.run(() => {
            new CleanupStore(this.repo.db).record({ projectId: this.job.projectId, jobId: this.job.id, items });
        });

    saveTextArtifact: GenerationSink["saveTextArtifact"] = async (kind, name, content) => {
        const rel = path.posix.join(this.job.projectId, "_artifacts", this.job.id, name);
        const saved = await putText(this.store, rel, content);
        this.repo.addArtifact({ projectId: this.job.projectId, jobId: this.job.id, kind, path: rel, size: saved.size });
    };

    startAgentRun: GenerationSink["startAgentRun"] = (role, subject) => this.writes.run(() => this.repo.startAgentRun(this.job.id, role, subject));
    /** Synchronous for the engine (it is called inside an agent's tool loop): queued in order, so it is written before the run is finished. */
    agentAction: GenerationSink["agentAction"] = (runId, a) => this.writes.push(() => this.repo.addAgentAction(runId, a));
    finishAgentRun: GenerationSink["finishAgentRun"] = (runId, status, summary) => this.writes.run(() => this.repo.finishAgentRun(runId, status, summary));
}
