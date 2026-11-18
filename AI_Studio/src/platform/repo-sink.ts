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
import { retryOnUniqueViolation } from "./sql-dialect.js";
import { linkGeneratedTest } from "./requirement-store.js";
import type { EngineEvent } from "../engine/context.js";
import { CustomScriptStore } from "./custom-script-store.js";
import { maskOptional, maskText, maskValue } from "./redact-text.js";
import type { VersionSource } from "./review-store.js";
import { isJpeg, THUMBNAIL_LIMITS, THUMBNAIL_NAME, THUMBNAIL_RUN_LIMITS } from "../engine/discovery/thumbnails.js";
import { CandidateFindingStore } from "./candidate-finding-store.js";
import { CandidateFindingSchema } from "../engine/explore/finding.js";
import { FRAME_LIMITS } from "../engine/frames/shoot.js";

/**
 * Stores a rendered script as the test's current version for its framework. An unchanged script
 * (same content as the current version) is not versioned again — re-validation re-renders every
 * time, and identical versions would only bury the real history.
 */
export async function storeScript(repo: Repo, store: ArtifactStore, projectId: string, testDbId: string, suiteSlug: string, script: RenderedScript, executable: boolean, makeCurrent = true): Promise<string> {
    const rel = path.posix.join(projectId, suiteSlug, script.filename);
    const stored = await putText(store, rel, script.content);
    const current = repo.getCurrentScript(testDbId, script.framework);
    if (current && current.content === script.content && current.storage_path === rel && Boolean(current.executable) === executable) return current.id as string;
    return repo.addScript(testDbId, { framework: script.framework, filename: script.filename, content: script.content, hash: stored.hash, storagePath: rel, executable, current: makeCurrent });
}


/**
 * Why a finding's screenshot is not kept, or undefined when it is: it must be a JPEG (its first bytes say so, whatever the name), under a
 * .jpg/.jpeg name (so it cannot take the place of the job's other files in the same folder), and within the size a finding keeps.
 */
export function screenshotProblem(name: string, bytes: Uint8Array): string | undefined {
    if (bytes.byteLength > FRAME_LIMITS.maxBytes) return "A screenshot larger than a finding keeps was not saved.";
    if (!/\.jpe?g$/i.test(path.posix.basename(name))) return "A finding's screenshot is saved only under a .jpg name.";
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return "A finding's screenshot that is not a JPEG picture was not saved.";
    return undefined;
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

    /** The run's own secrets (sign-in passwords, authenticator secrets, API tokens), masked in everything this sink writes as text. */
    private readonly secrets = new Set<string>();
    addSecrets(list: ReadonlyArray<string | null | undefined>): void {
        for (const s of list) if (typeof s === "string" && s.length >= 4) this.secrets.add(s);
    }
    /** Text as this job stores it: its secrets and the shared patterns masked (redact-text.ts). */
    mask(text: string): string {
        return maskText(text, [...this.secrets]);
    }
    private maskReason<T extends string | null | undefined>(reason: T): T {
        return maskOptional(reason, [...this.secrets]);
    }
    /** A run's step results with each step's error masked (titles come from the test's own steps and stay). */
    private maskSteps<S extends { error?: string }>(steps: readonly S[]): S[] {
        return steps.map((st) => (typeof st.error === "string" ? { ...st, error: this.mask(st.error) } : st));
    }

    /** One engine event for this job, in order with the job's other writes (the engine's `emit` stays synchronous). Masked on write. */
    event(e: EngineEvent): void {
        const secrets = [...this.secrets];
        const masked: EngineEvent = { ...e, message: maskText(e.message, secrets), ...(e.data === undefined ? {} : { data: maskValue(e.data, secrets) }) };
        this.writes.push(() => this.repo.addEvent(this.job.id, masked));
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

    /** The highest number this job has handed out per prefix: ideas written side by side ask before either test is saved. */
    private readonly handedKeys = new Map<string, number>();
    nextTestKey: GenerationSink["nextTestKey"] = (prefix) =>
        this.writes.run(() =>
            this.repo.db.tx(() => {
                const stored = Number(this.repo.nextTestKey(this.job.projectId, prefix).slice(prefix.length + 1));
                const n = Math.max(stored, (this.handedKeys.get(prefix) ?? 0) + 1);
                this.handedKeys.set(prefix, n);
                return `${prefix}-${String(n).padStart(3, "0")}`;
            }),
        );

    /**
     * What a test's provenance says the model was: set when the job runs on a person's own key, whose model nobody else may learn (the same
     * placeholder as the usage pages, usage-store.ts). Unset: the model's own name.
     */
    modelShownAs: string | undefined;
    private shown<M extends Record<string, unknown> | undefined>(meta: M): M {
        return this.modelShownAs && meta && "model" in meta ? ({ ...meta, model: this.modelShownAs } as M) : meta;
    }

    createTest: GenerationSink["createTest"] = ({ spec, framework, validation, reason, meta: given }) =>
        this.writes.run(() => {
            const meta = this.shown(given);
            const slug = slugify(spec.category);
            const suiteId = this.repo.getOrCreateSuite(this.job.projectId, spec.category, slug);
            // The key is taken here, with the insert: the one the engine asked for (nextTestKey) is only a proposal, and another scenario
            // or job may have saved under it since (a defect replays its failure for seconds before it is saved). Taken: the next free
            // key of the same prefix. On PostgreSQL a writer that commits the same key between the read and the insert meets the unique
            // index, and the whole transaction runs again.
            const projectId = this.job.projectId;
            const prefix = /^([A-Z]+)-\d+$/.exec(spec.testId)?.[1];
            const { id, testId } = retryOnUniqueViolation(this.repo.db.dialect, () =>
                this.repo.db.tx(() => {
                    const free = prefix && this.repo.existingTestKeys(projectId, [spec.testId]).length ? { ...spec, testId: this.repo.nextTestKey(projectId, prefix) } : spec;
                    return { id: this.repo.insertTest({ projectId, suiteId, jobId: this.job.id, spec: free, framework, validationStatus: validation, meta, versionSource: this.versionSource }), testId: free.testId };
                }),
            );
            if (reason) this.repo.updateTest(id, { reason: this.maskReason(reason) });
            // A test written from a requirements document names the requirements it covers: each that is a requirement record of the
            // project (by its reference) gets a link (requirement-store.ts).
            linkGeneratedTest(this.repo.db, this.job.projectId, id, spec.source.requirements);
            this.suiteSlugByTest.set(id, slug);
            if (testId !== spec.testId) this.rekeyed.set(id, testId);
            // A defect saved for review carries its candidate finding (engine/explore/finding.ts): one row per project and fingerprint.
            if (validation === "NEEDS_REVIEW" && meta?.finding !== undefined) return this.saveFinding(id, testId, meta.finding).then(() => ({ id, testId }));
            return { id, testId };
        });

    /** The finding is parsed again here (the boundary); one that does not parse, or cannot be stored, is skipped with a warning and the test stays. */
    private async saveFinding(testDbId: string, testKey: string, given: unknown): Promise<void> {
        const parsed = CandidateFindingSchema.safeParse(given);
        const skip = (why: string) => this.event({ stage: "generation", kind: "finding_skipped", level: "warn", message: `${testKey}: its candidate finding was not stored (${why}); the test is saved for review.` });
        if (!parsed.success) return skip(parsed.error.issues.map((i) => `${i.path.join(".") || "finding"}: ${i.message}`).join("; "));
        try {
            await new CandidateFindingStore(this.repo.db.sql).upsert({ projectId: this.job.projectId, jobId: this.job.id, testId: testDbId, finding: parsed.data });
        } catch (err) {
            skip(err instanceof Error ? err.message : String(err));
        }
    }

    /** Tests this job saved under another key than the engine asked for (createTest): test id -> the key it was saved under. */
    private readonly rekeyed = new Map<string, string>();

    /** What each test was before this job began validating it (status and reason), so a cancelled job can put it back. */
    private readonly before = new Map<string, { status: ValidationState; reason: string | null }>();

    updateTest: GenerationSink["updateTest"] = (h, patch) =>
        this.writes.run(() => {
            if (patch.validation === "VALIDATING" && !this.before.has(h.id)) {
                const t = this.repo.getTest(h.id);
                if (t) this.before.set(h.id, { status: t.validationStatus as ValidationState, reason: t.validationReason ?? null });
            }
            // A test that ran its approved version while a newer draft waits: the run's steps are never written over the draft.
            // A test saved under another key than the one asked for (createTest) keeps it, whatever key the engine's copy of its spec carries.
            const rekeyed = this.rekeyed.get(h.id);
            const spec = this.keepSteps.has(h.id) ? undefined : patch.spec && rekeyed ? { ...patch.spec, testId: rekeyed } : patch.spec;
            this.repo.updateTest(h.id, { spec, validationStatus: patch.validation, reason: this.maskReason(patch.reason), attempts: patch.attempts, meta: this.shown(patch.meta), versionSource: this.versionSource });
        });

    /** Tests whose steps this run must not write back (set by the job runner from the versions it pinned, review-store.ts). */
    keepSteps: ReadonlySet<string> = new Set();

    /** Review and approval: what this job writes is the AI's work while it writes tests, and a repair when it runs existing ones. */
    private get versionSource(): VersionSource {
        const mode = this.job.mode ?? "generate";
        return mode === "generate" || mode === "plain" ? "ai" : "healing";
    }

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

    // A run of the approved version while a newer draft waits: the script it made is only that run's record. What the test holds (the
    // draft's steps and the script made from them, or a person's draft code) stays current, so the Code tab, the download and a later
    // switch to code keep following the saved steps.
    saveScript: GenerationSink["saveScript"] = (h, script, executable) => storeScript(this.repo, this.store, this.job.projectId, h.id, this.suiteSlug(h.id), script, executable, !this.keepSteps.has(h.id));

    recordExecution: GenerationSink["recordExecution"] = async (h: TestHandle, scriptId: string | null, attempt: number, run: ScriptRun, startedAt: string) => {
        const executionId = this.repo.addExecution({
            testId: h.id,
            scriptId,
            jobId: this.job.id,
            attempt,
            status: run.status,
            durationMs: run.durationMs,
            error: this.maskReason(run.error),
            startedAt,
            steps: this.maskSteps(run.steps),
        });
        if (run.metrics?.length) await recordMetrics(this.repo.db.sql, { projectId: this.job.projectId, testId: h.id, executionId, samples: run.metrics });
        // API drift: the shape (never the values) of what the API answered; never throws.
        if (run.responses.length) recordObservations(this.repo.db, { projectId: this.job.projectId, jobId: this.job.id, responses: run.responses });
        // Validation-only jobs run the same test again later; keep each run's artifacts apart so an
        // earlier execution's screenshot/trace is never overwritten by a re-validation.
        const runDir = this.job.mode === "validate" || this.job.mode === "plain" ? path.posix.join(`job-${this.job.id.slice(0, 8)}`, `attempt-${attempt}`) : `attempt-${attempt}`;
        const named = new Set<string>();
        for (const a of run.artifacts) {
            try {
                // Visual images keep Playwright's name (<snapshot>-actual.png / -diff.png): one test can have several
                // screenshots, and accepting a new baseline maps each actual back to its snapshot name.
                // The same goes for AI-judgement screenshots (one per `looksRight` step).
                const base = a.kind.startsWith("visual-") || a.kind === "vision-shot" ? path.basename(a.path) : `${a.kind}${path.extname(a.path)}`;
                // A test with a popup keeps a picture of each page: the second one never overwrites the first.
                let file = base;
                for (let n = 2; named.has(file); n++) file = `${path.basename(base, path.extname(base))}-${n}${path.extname(base)}`;
                named.add(file);
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
        const reason = this.maskReason(r.reason);
        if (r.status === "skipped" && reason && isRepeatedSkip(this.repo.db, h.id, r.variant, reason)) return;
        const run = r.run;
        const executionId = addVariantExecution(this.repo.db, {
            testId: h.id,
            scriptId,
            jobId: this.job.id,
            variant: r.variant,
            status: r.status,
            reason,
            durationMs: run?.durationMs ?? 0,
            startedAt,
            steps: this.maskSteps(run?.steps ?? []),
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
        const reason = this.maskReason(r.reason);
        if (r.status === "skipped" && reason && isRepeatedEnvironmentSkip(this.repo.db, h.id, r.environment, reason)) return;
        const run = r.run;
        const executionId = addEnvironmentExecution(this.repo.db, {
            testId: h.id,
            scriptId,
            jobId: this.job.id,
            environment: r.environment,
            status: r.status,
            reason,
            durationMs: run?.durationMs ?? 0,
            startedAt,
            steps: this.maskSteps(run?.steps ?? []),
        });
        if (r.status === "skipped") return;
        // A passed run keeps its proof (the screenshot and the recording); a run that went wrong keeps everything.
        for (const a of (run?.artifacts ?? []).filter((x) => r.status !== "passed" || x.kind === "screenshot" || x.kind === "video")) {
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

    /**
     * One covered page thumbnail (engine/discovery/thumbnails.ts), kept as a job artifact of kind `screenshot` (so it follows screenshot
     * retention, project deletion and GET /api/artifacts/:id with its project's read access). Anything that is not a JPEG within the size
     * cap, under a thumbnail's name and within the run's caps is not kept (null).
     */
    savePageThumbnail: NonNullable<GenerationSink["savePageThumbnail"]> = async (name, jpeg) => {
        if (!THUMBNAIL_NAME.test(name) || !isJpeg(jpeg) || jpeg.byteLength > THUMBNAIL_LIMITS.maxBytes) return null;
        // The run's caps, counted from what this job already stored (a runner's pictures arrive from another machine, over many requests).
        const rel = path.posix.join(this.job.projectId, "_artifacts", this.job.id, "thumbnails", name);
        const had = this.repo.db.get<{ n: number; b: number | null }>("SELECT COUNT(*) AS n, SUM(size) AS b FROM artifacts WHERE job_id = ? AND kind = 'screenshot' AND path LIKE ?", this.job.id, `%/thumbnails/thumb-%`);
        if (Number(had?.n ?? 0) >= THUMBNAIL_RUN_LIMITS.count || Number(had?.b ?? 0) + jpeg.byteLength > THUMBNAIL_RUN_LIMITS.bytes) return null;
        if (this.repo.db.get("SELECT 1 FROM artifacts WHERE job_id = ? AND path = ?", this.job.id, rel)) return null;
        const saved = await this.store.put(rel, Buffer.from(jpeg), { contentType: "image/jpeg" });
        return this.repo.addArtifact({ projectId: this.job.projectId, jobId: this.job.id, kind: "screenshot", path: rel, size: saved.size });
    };

    /** A finding's screenshot (row 173): stored next to the job's other artifacts; the answer is its artifact id. */
    saveImageArtifact: NonNullable<GenerationSink["saveImageArtifact"]> = async (kind, name, jpeg) => {
        const problem = screenshotProblem(name, jpeg);
        if (problem) throw new Error(problem);
        const rel = path.posix.join(this.job.projectId, "_artifacts", this.job.id, path.posix.basename(name));
        const saved = await this.store.put(rel, jpeg, { contentType: "image/jpeg" });
        return this.repo.addArtifact({ projectId: this.job.projectId, jobId: this.job.id, kind, path: rel, size: saved.size });
    };

    startAgentRun: GenerationSink["startAgentRun"] = (role, subject) => this.writes.run(() => this.repo.startAgentRun(this.job.id, role, subject));
    /**
     * An authoring agent's tool call is not stored: nothing reads it, and it held page addresses, error text and
     * typed values. The engine still reports each one (routing, observability), so the call stays and does nothing here.
     */
    agentAction: GenerationSink["agentAction"] = () => undefined;
    finishAgentRun: GenerationSink["finishAgentRun"] = (runId, status, summary) => this.writes.run(() => this.repo.finishAgentRun(runId, status, this.maskReason(summary)));
}
