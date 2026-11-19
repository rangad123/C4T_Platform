/**
 * The candidate finding (testing-engine Phase 3, spec §3, plan Decisions 4 and 9): what a captured defect carries in its test's
 * `meta.finding`, and what the platform stores in `candidate_findings` (platform/candidate-finding-store.ts). Built by the engine
 * (orchestrator defect branch), parsed again by the platform before it is stored, so the parse here is the boundary: strict objects,
 * capped lists, and every free text redacted (shared/redact-text.ts) and cut.
 *
 * A candidate finding is never "confirmed": confirmation is Phase 5 (two of three clean replays + a sourced expectation). Its confidence
 * is stated, not learned, and must agree with `confidenceOf` (Decision 9).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactText } from "../../shared/redact-text.js";

export const CANDIDATE_FINDING_LIMITS = {
    /** Observed, expected and summary text (characters, after redaction). */
    textMax: 2000,
    /** A short reference: a rule ref, an objective id, a screenshot artifact path, a label. */
    refMax: 300,
    screenshotsMax: 10,
    requestsMax: 20,
    consoleMax: 20,
    lineMax: 1000,
    replaysMax: 5,
    stepsMax: 500,
} as const;
const L = CANDIDATE_FINDING_LIMITS;

const text = (max: number) => z.string().transform((s) => redactText(s, max));
const ref = z.string().min(1).max(L.refMax);

export const CAPTURE_STATES = ["captured", "observed_only"] as const;
/**
 * `not_on_clean_state` (row 229): both replays failed the same way, but on the shared test account (no account could be registered for
 * them, clean-account.ts), so what earlier tests left there may be why: never `independent`, so never high.
 */
export const INDEPENDENCE_RESULTS = ["independent", "state_dependent", "not_run", "not_on_clean_state"] as const;
export const FINDING_CONFIDENCE = ["high", "medium", "low"] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];
export type IndependenceResult = (typeof INDEPENDENCE_RESULTS)[number];
export type FindingConfidence = (typeof FINDING_CONFIDENCE)[number];

/**
 * Decision 9: `high` = sourced expectation + captured failing check + independence check passed (on clean account state); `medium` =
 * sourced + captured, independence not run, state-dependent or not checked on clean state; `low` = a defect claimed without a captured sourced check ("observed only").
 */
export function confidenceOf(f: { sourced: boolean; capture: CaptureState; independence: IndependenceResult }): FindingConfidence {
    if (!f.sourced || f.capture !== "captured") return "low";
    return f.independence === "independent" ? "high" : "medium";
}

export const CandidateFindingSchema = z
    .object({
        /** The objective pursued; null when the finding came from planned generation without objectives. */
        objective: z.object({ id: ref, kind: z.enum(["rule", "workflow", "constraint", "transition", "coverage-gap"]), source: ref, operator: ref.optional() }).strict().nullable(),
        /** The action sequence is the saved test's steps (the reproduction); the platform links the test when it stores the row. */
        actions: z.object({ stepCount: z.number().int().min(0).max(L.stepsMax) }).strict(),
        /** What should have happened and where that comes from (a rule ref or `expected:<n>`); never from what the app did. */
        expected: z.object({ text: text(L.textMax), source: ref.nullable() }).strict(),
        observed: text(L.textMax),
        evidence: z
            .object({
                /** Artifact references, not image data. */
                screenshots: z.array(ref).max(L.screenshotsMax),
                /** Request/response summaries ("POST /api/cart -> 500"). */
                requests: z.array(text(L.lineMax)).max(L.requestsMax),
                console: z.array(text(L.lineMax)).max(L.consoleMax),
            })
            .strict(),
        capture: z.enum(CAPTURE_STATES),
        independence: z.enum(INDEPENDENCE_RESULTS),
        confidence: z.enum(FINDING_CONFIDENCE),
        /** findingFingerprint: one finding per project and fingerprint. */
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        /** The application model version the objective came from; null without a model. */
        modelVersion: ref.nullable(),
        replays: z
            .array(
                z
                    .object({
                        label: ref,
                        outcome: z.enum(["failed", "passed", "error"]),
                        /** 1-based step the replay stopped at. */
                        failedStep: z.number().int().min(1).max(L.stepsMax).optional(),
                        summary: text(L.textMax),
                    })
                    .strict(),
            )
            .max(L.replaysMax),
    })
    .strict()
    .superRefine((f, ctx) => {
        if (f.capture === "captured" && f.expected.source === null)
            ctx.addIssue({ code: "custom", path: ["expected", "source"], message: "A captured check names the source of its expected result." });
        const stated = confidenceOf({ sourced: f.expected.source !== null, capture: f.capture, independence: f.independence });
        if (f.confidence !== stated) ctx.addIssue({ code: "custom", path: ["confidence"], message: `Confidence is ${stated} for this capture and independence result.` });
    });

/** What the engine writes (before redaction and cutting). */
export type CandidateFindingInput = z.input<typeof CandidateFindingSchema>;
/** What the platform stores and shows. */
export type CandidateFinding = z.output<typeof CandidateFindingSchema>;

const normalise = (s: string | null | undefined) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Same source, same expected result and same scenario = the same finding across runs (sha256, hex). Spacing and case do not matter.
 * The scenario keeps observed-only findings (no source, no expected text) of different scenarios apart.
 */
export function findingFingerprint(p: { source: string | null; expected: string; scenario: string }): string {
    return createHash("sha256").update([normalise(p.source), normalise(p.expected), normalise(p.scenario)].join("\n")).digest("hex");
}
