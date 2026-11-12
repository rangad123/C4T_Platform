/**
 * Round 51: what an exploration job running on a runner saves, sent to the platform (POST /api/agent/tasks/:id/explore/sink).
 *
 * One message per GenerationSink method (src/engine/orchestrator.ts), a union on `method`, sent in batches in the order the engine made
 * them: `{ calls: [...] }`, answered `{ results: [...] }` (one entry per call, null for the methods that return nothing). What the platform
 * makes (test handles, script ids, agent run ids) only ever comes back in an answer: the runner never invents a database id, and a handle
 * is an opaque name the platform maps to its own test. Files travel as bytes (base64), never as paths.
 */
import { z } from "zod";
import { LocatorSchema, StepSchema, TestSpecSchema } from "../engine/spec/schema.js";
import { MemoryChangesSchema, SiteKnowledgeSchema } from "../engine/memory/types.js";
import { ExploredOnSchema } from "../engine/mobile/phone-settings.js";
import { CLEANUP_STATUSES } from "../engine/cleanup/ledger.js";
import { EXTRA_VARIANT_IDS } from "../engine/validation/variants.js";
import { SafeName } from "./schema.js";

/** One file's bytes at most (raw, before base64) inside a call. Larger evidence is uploaded in chunks first (`fileChunk`); a baseline over it is refused. */
export const EXPLORE_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** All files of one call at most (raw). The runner leaves out evidence that would pass it. */
export const EXPLORE_CALL_FILES_MAX_BYTES = 16 * 1024 * 1024;
/** All files of one task attempt at most (raw), both ways. */
export const EXPLORE_TASK_MAX_BYTES = 256 * 1024 * 1024;
/** The largest request body the sink route must accept: one call at the file cap, base64, with room for its JSON. */
export const EXPLORE_SINK_BODY_MAX = Math.ceil((EXPLORE_CALL_FILES_MAX_BYTES * 4) / 3) + 2 * 1024 * 1024;
/** One chunk of an upload at most (raw). */
export const EXPLORE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Calls in one batch at most. */
export const EXPLORE_SINK_MAX_CALLS = 200;

/** The platform's name for a test of this job (opaque; it means something only to the platform that made it). */
export const WireHandle = z.object({ id: z.string().regex(/^h_[A-Za-z0-9_-]{8,64}$/), testId: z.string().min(1).max(80) });
const Id = z.string().min(1).max(80);
const Text = (n: number) => z.string().max(n);
const Meta = z.record(z.string(), z.unknown());
const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64");

/** A file's bytes. `name` is a plain file name, never a path. */
export const WireFile = z.object({ name: SafeName, data: Base64 });
export type WireFile = z.infer<typeof WireFile>;

/** An upload of this attempt (`fileChunk`), named by the runner: a short counter, never a path. */
export const UploadId = z.string().regex(/^u[0-9]{1,6}$/);

const ArtifactKind = z.enum(["screenshot", "trace", "video", "visual-actual", "visual-diff", "vision-shot", "evidence"]);

/** What RepoSink keeps of a ScriptRun (src/engine/validation/runner.ts), with the evidence files as bytes. */
export const WireSinkRun = z.object({
    testId: z.string().max(80),
    status: z.enum(["passed", "failed", "timedOut", "skipped", "error"]),
    durationMs: z.number(),
    error: Text(4000).optional(),
    failedStepIndex: z.number().int(),
    steps: z.array(z.object({ index: z.number().int(), title: Text(500), status: z.enum(["passed", "failed"]), error: Text(2000).optional() })).max(500),
    /** A file in the call, or one uploaded in chunks before it (`size`: its whole length, checked by the platform). */
    artifacts: z.array(z.union([z.object({ kind: ArtifactKind, file: WireFile }), z.object({ kind: ArtifactKind, upload: z.object({ id: UploadId, name: SafeName, size: z.number().int().min(0) }) })])).max(50),
    notes: z.array(Text(500)).max(50).optional(),
    visionJudged: z.enum(["ok", "finding", "unavailable"]).optional(),
    responses: z.array(z.object({ method: Text(16), path: Text(2000), status: z.number(), obs: z.unknown().optional() })).max(500),
    metrics: z.array(z.object({ metric: Text(80), value: z.number(), unit: Text(20), budget: z.number().optional() })).max(100).optional(),
    variant: Text(60).optional(),
});
export type WireSinkRun = z.infer<typeof WireSinkRun>;

const Script = z.object({ framework: Id, filename: SafeName, content: Text(2_000_000), language: z.literal("typescript") });
const Validation = z.enum(["VALIDATING", "VALIDATED", "FAILED_VALIDATION", "NEEDS_REVIEW"]);
const HealProposal = z.object({
    stepIndex: z.number().int(),
    oldLocator: LocatorSchema,
    newLocator: LocatorSchema,
    confidence: z.number(),
    confidenceLabel: z.enum(["high", "medium", "low"]),
    reason: Text(2000),
    oldDescription: Text(500),
    newDescription: Text(500),
});
const FinishedItem = z.object({
    testId: Text(80),
    seq: z.number().int(),
    method: z.literal("POST"),
    path: Text(2000),
    id: Text(500),
    deletePath: Text(2000).optional(),
    origin: Text(500).optional(),
    environment: Text(100).optional(),
    status: z.enum(CLEANUP_STATUSES as [string, ...string[]]),
    reason: Text(1000).optional(),
    createdAt: Text(40),
});
const Started = Text(40);
const ScriptId = Id.nullable();

export const SinkCall = z.discriminatedUnion("method", [
    z.object({ method: z.literal("phase"), status: z.enum(["DISCOVERING", "ANALYZING", "PLANNING", "GENERATING", "VALIDATING"]), phase: z.enum(["discovery", "understanding", "planning", "generation", "validation"]), state: z.enum(["running", "done", "skipped", "failed"]) }),
    z.object({ method: z.literal("counters"), patch: z.record(z.string().max(60), z.number()), add: z.boolean().optional() }),
    // The application model is the engine's own large structure (no schema of its own); it is stored as JSON, as the job does today.
    z.object({ method: z.literal("saveModel"), model: z.record(z.string(), z.unknown()) }),
    z.object({ method: z.literal("nextTestKey"), prefix: z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/) }),
    z.object({ method: z.literal("createTest"), spec: TestSpecSchema, framework: Id, validation: z.enum(["PENDING", "NEEDS_REVIEW"]), reason: Text(2000).optional(), meta: Meta.optional() }),
    z.object({ method: z.literal("updateTest"), h: WireHandle, patch: z.object({ spec: TestSpecSchema.optional(), validation: Validation.optional(), reason: Text(2000).nullable().optional(), attempts: z.number().int().min(0).optional(), meta: Meta.optional() }) }),
    z.object({ method: z.literal("restoreTest"), h: WireHandle }),
    z.object({ method: z.literal("saveScript"), h: WireHandle, script: Script, executable: z.boolean() }),
    z.object({ method: z.literal("recordExecution"), h: WireHandle, scriptId: ScriptId, attempt: z.number().int().min(0), run: WireSinkRun, startedAt: Started }),
    z.object({ method: z.literal("recordVariant"), h: WireHandle, scriptId: ScriptId, r: z.object({ variant: z.enum(EXTRA_VARIANT_IDS), status: z.enum(["passed", "failed", "unavailable", "skipped"]), reason: Text(2000).optional(), run: WireSinkRun.optional() }), startedAt: Started }),
    z.object({ method: z.literal("recordEnvironment"), h: WireHandle, scriptId: ScriptId, r: z.object({ environment: Text(100), status: z.enum(["passed", "failed", "finding", "skipped"]), reason: Text(2000).optional(), run: WireSinkRun.optional() }), startedAt: Started }),
    z.object({ method: z.literal("saveTextArtifact"), kind: Id, name: SafeName, content: Text(4_000_000) }),
    z.object({ method: z.literal("saveHealing"), h: WireHandle, result: z.discriminatedUnion("status", [z.object({ status: z.literal("proposed"), proposal: HealProposal }), z.object({ status: z.literal("none"), reason: Text(2000) })]) }),
    z.object({ method: z.literal("saveCleanup"), items: z.array(FinishedItem).max(5000) }),
    z.object({ method: z.literal("loadMemory"), origin: Text(500) }),
    z.object({ method: z.literal("saveMemory"), knowledge: SiteKnowledgeSchema, changes: MemoryChangesSchema.nullable() }),
    z.object({ method: z.literal("saveBaselines"), h: WireHandle, files: z.array(WireFile).max(50) }),
    z.object({ method: z.literal("loadBaselines"), h: WireHandle }),
    z.object({ method: z.literal("startAgentRun"), role: Id, subject: Text(500) }),
    z.object({ method: z.literal("agentAction"), runId: Id, a: z.object({ tool: Text(100), args: z.unknown(), ok: z.boolean(), observation: Text(20_000) }) }),
    z.object({ method: z.literal("finishAgentRun"), runId: Id, status: Text(40), summary: Text(4000).optional() }),
    // Round 52: a piece of a large evidence file, written at `offset` (so sending it again changes nothing); a later run names it by `upload`.
    z.object({ method: z.literal("fileChunk"), upload: UploadId, offset: z.number().int().min(0), data: Base64 }),
    z.object({ method: z.literal("rememberPhone"), d: z.object({ exploredOn: ExploredOnSchema.optional(), appActivity: z.object({ appPackage: Text(200), activity: Text(300) }).optional() }) }),
    // Round 52: an AI agent run on the runner (agent-on-runner.ts). The run is the job's own (its options.agentRunId): no run id comes from the runner.
    z.object({ method: z.literal("agentStep"), s: z.object({ seq: z.number().int().min(0), tool: Text(100), summary: Text(2000), status: z.enum(["done", "failed", "refused"]), detail: Text(4000).optional(), url: Text(4000), step: StepSchema.optional(), picture: WireFile.optional() }) }),
    z.object({ method: z.literal("agentTokens"), used: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }) }),
    z.object({ method: z.literal("agentApproval"), r: z.object({ action: Text(1000), kind: z.enum(["delete", "pay", "send", "submit"]), why: Text(1000), url: Text(4000), seconds: z.number().int().min(1).max(600) }) }),
    z.object({ method: z.literal("approvalState"), id: Id }),
    z.object({
        method: z.literal("agentOutcome"),
        o: z.object({ state: z.enum(["finished", "stopped"]), verdict: z.enum(["passed", "failed", "blocked", "inconclusive"]), reasoning: Text(8000), stopReason: Text(2000).optional(), failureCategory: z.enum(["application", "agent", "environment", "runner"]).optional(), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }),
    }),
]);
export type SinkCall = z.infer<typeof SinkCall>;
export type SinkMethod = SinkCall["method"];

/**
 * `seq` (round 52): the batch's number in this attempt, 1, 2, 3... The runner sends a batch again with the same number when it got no answer
 * (the platform restarted); the platform applies each number once and answers a repeat with what it answered the first time. Uploads go
 * without one (a chunk is written at its offset, so a repeat changes nothing).
 */
export const SinkRequest = z.object({ calls: z.array(SinkCall).min(1).max(EXPLORE_SINK_MAX_CALLS), seq: z.number().int().min(1).optional() });
export type SinkRequest = z.infer<typeof SinkRequest>;

/** One answer per call, in order. */
export const SinkResponse = z.object({ results: z.array(z.unknown()) });

/** What the value-returning methods answer. */
export const SinkAnswers = {
    nextTestKey: z.string().min(1).max(80),
    createTest: WireHandle,
    saveScript: Id,
    startAgentRun: Id,
    loadMemory: z.object({ knowledge: SiteKnowledgeSchema.nullable(), warning: Text(1000).optional() }),
    loadBaselines: z.array(WireFile).max(200),
    agentApproval: Id,
    approvalState: z.enum(["pending", "approved", "refused", "timed_out", "stopped"]),
} as const;
