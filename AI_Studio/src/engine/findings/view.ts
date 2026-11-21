/**
 * One finding view (testing-engine Phase 5, spec §5.1 items 1–2, §8; owner's H2 "one findings model"): what classify, dedupe and score
 * read, whatever produced the finding. Source kinds: an exploration finding (explore/finding.ts), a failed execution of an ordinary
 * test, a Phase 4 layer check (API, stored data, database, concurrency…), and a security finding (read through an adapter; the
 * security module keeps its own states, `sourceState`).
 *
 * The parse is the boundary (adapters build views from stored rows): strict objects, capped lists, free text redacted and cut. The
 * Phase 4 fields (`layer`, `origin`, `correlated`) are optional until Phase 4 lands (spec §8 stub), so Phase 3 rows parse as they are.
 */
import { z } from "zod";
import { redactText } from "../../shared/redact-text.js";
import { CAPTURE_STATES, FINDING_CONFIDENCE, INDEPENDENCE_RESULTS } from "../explore/finding.js";
import { PRIORITIES } from "../spec/schema.js";
import { SEVERITIES } from "../validation/severity.js";
import { FINDING_STATES } from "./lifecycle.js";

export const SOURCE_KINDS = ["exploration", "execution", "layer", "security"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const VIEW_LIMITS = { textMax: 2000, refMax: 300, lineMax: 1000, attemptsMax: 6, stepsMax: 500, requestsMax: 20, framesMax: 8, listMax: 20 } as const;
const L = VIEW_LIMITS;

const text = (max: number) => z.string().transform((s) => redactText(s, max));
const ref = z.string().min(1).max(L.refMax);

/** A request the failing step caused, as evidence shows it (path already masked). `own`: the application's own origin. */
const RequestSchema = z
    .object({
        method: z.string().min(1).max(10),
        path: text(L.lineMax),
        status: z.number().int().min(0).max(599).nullable(),
        own: z.boolean(),
        /** A transport error instead of an answer ("net::ERR_NAME_NOT_RESOLVED"). */
        error: text(L.lineMax).optional(),
    })
    .strict();

/** One run of the finding's steps: the detection itself, or a verification replay. */
export const AttemptSchema = z
    .object({
        outcome: z.enum(["failed", "passed", "error"]),
        /** 1-based step the attempt stopped at. */
        failedStep: z.number().int().min(1).max(L.stepsMax).optional(),
        /** The failing check's kind (`value`, `visible`, `exactText`, `status`…). */
        check: ref.optional(),
        /** What the failing step points at, as the step names it (a label, a role name, a request path). */
        target: text(L.refMax).optional(),
        /** The expected value of the failing check. */
        value: text(L.refMax).optional(),
        failureKind: z.enum(["value", "missing", "timeout"]).optional(),
        /** First lines of the error. */
        error: text(L.textMax).optional(),
        /** validation/test-fault.ts's sentence when the failure is the test's own step. */
        stepFault: text(L.textMax).optional(),
        /** The runner's own marker that the environment was not usable (sign-in refused, a run secret missing). */
        environment: text(L.lineMax).optional(),
        /** The address the attempt stopped on. */
        page: text(L.lineMax).optional(),
        requests: z.array(RequestSchema).max(L.requestsMax).default([]),
        /** Top stack frames of an application error, `file:function` (line numbers dropped by the adapter or here). */
        stack: z.array(text(L.refMax)).max(L.framesMax).default([]),
    })
    .strict();
export type Attempt = z.output<typeof AttemptSchema>;

export const FindingViewSchema = z
    .object({
        id: ref,
        projectId: ref,
        source: z.object({ kind: z.enum(SOURCE_KINDS), id: ref }).strict(),
        /** The security module's own state for a security finding (spec Q3); absent for the others. */
        sourceState: ref.optional(),
        state: z.enum(FINDING_STATES),
        title: text(L.refMax),
        testId: ref.nullable(),
        detectedAt: z.string().datetime({ offset: true }),
        expected: z
            .object({
                text: text(L.textMax),
                /** A rule ref, a requirement id, or `expected:<n>` (that test's own expected result). */
                source: ref.nullable(),
                /** confirmed: a person confirmed it; explicit: a source states it; inferred: the planner's guess; none: nothing states it. */
                stated: z.enum(["confirmed", "explicit", "inferred", "none"]),
                /** A stated source that says otherwise (Phase 4 C2 documented status). */
                contradictedBy: ref.optional(),
                /** A stated source that documents the behaviour as not supported. */
                unsupportedPer: ref.optional(),
            })
            .strict(),
        observed: text(L.textMax),
        /** The saved test's steps (the action sequence). */
        steps: z
            .array(z.object({ action: z.string().min(1).max(40), target: text(L.refMax).optional(), url: text(L.lineMax).optional() }).strict())
            .max(L.stepsMax),
        attempts: z.array(AttemptSchema).max(L.attemptsMax),
        requirements: z.array(ref).max(L.listMax).default([]),
        /** An issue the finding is linked to (GitHub/Jira/Notion key). */
        issueId: ref.optional(),
        /** The journey's priority (the test's). */
        priority: z.enum(PRIORITIES).optional(),
        /** validation/severity.ts's assessment, where the adapter could make one. */
        baseSeverity: z.object({ severity: z.enum(SEVERITIES), basis: text(L.refMax) }).strict().optional(),
        /** Phase 3 candidate-finding facts (explore/finding.ts). */
        capture: z.enum(CAPTURE_STATES).optional(),
        independence: z.enum(INDEPENDENCE_RESULTS).optional(),
        confidence: z.enum(FINDING_CONFIDENCE).optional(),
        /** A security finding's own severity, category and confidence. */
        security: z
            .object({ severity: z.enum(["critical", "high", "medium", "low", "info"]), category: ref, confidence: z.enum(FINDING_CONFIDENCE) })
            .strict()
            .optional(),
        /** Who it affects: how many roles saw it, and whether the page is public (signed out). */
        scope: z.object({ roles: z.number().int().min(0).max(1000), public: z.boolean() }).strict().optional(),
        // Phase 4 (spec §8), optional until it lands.
        /** The test's `meta.layer` (page, api, storedData, database, concurrency…). */
        layer: ref.optional(),
        /** The test's `source.origin`. */
        origin: ref.optional(),
        /** Correlated evidence: the layers that disagreed (the UI showed success while the API answered 500 = page + api). */
        correlated: z.object({ disagreed: z.array(ref).max(L.listMax) }).strict().optional(),
    })
    .strict();

export type FindingViewInput = z.input<typeof FindingViewSchema>;
export type FindingView = z.output<typeof FindingViewSchema>;
