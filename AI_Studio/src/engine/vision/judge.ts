/**
 * Asking the model "does this screen look right?" — and turning its answer into something honest.
 *
 * Rules (the brief's, enforced here and tested with scripted model doubles):
 *  - a verdict must match the zod schema; anything else counts as "the model could not judge", never as a pass;
 *  - no model, a model without image support, a failed call, an image that cannot be prepared, or an exhausted image
 *    budget all end the same way: the test FAILS validation with a plain reason (never a pass, never a finding);
 *  - ok=false with high or medium confidence is a finding (medium / low severity); low confidence is only a note;
 *  - images are shrunk and counted: per test, per job, and (while authoring) per scenario.
 */
import fs from "node:fs/promises";
import type { Browser } from "playwright";
import type { EngineContext } from "../context.js";
import type { ScriptRun } from "../validation/runner.js";
import { prepareImage, VisionImageError } from "./image.js";
import {
    clipProblem,
    describeModelFailure,
    judgePrompt,
    JUDGE_SYSTEM,
    VerdictSchema,
    VISION_FAILURE_PREFIX,
    VISION_MAX_IMAGES_PER_JOB,
    VISION_MAX_IMAGES_PER_TEST,
    VISION_MAX_OUTPUT_TOKENS,
    VISION_UNAVAILABLE_PREFIX,
    weigh,
    type Confidence,
    type Verdict,
    type VisionSeverity,
} from "./verdict.js";

export type Judged = { state: "unavailable"; reason: string } | { state: "verdict"; verdict: Verdict; image: { width: number; height: number; bytes: number; downscaled: boolean } };

/** Images sent so far in one job (one EngineContext); the cap keeps a large project from running up a bill. */
const budgets = new WeakMap<object, { used: number }>();
export function visionImagesSent(ctx: EngineContext): number {
    return budgets.get(ctx)?.used ?? 0;
}
function takeFromBudget(ctx: EngineContext): boolean {
    const b = budgets.get(ctx) ?? { used: 0 };
    budgets.set(ctx, b);
    if (b.used >= VISION_MAX_IMAGES_PER_JOB) return false;
    b.used++;
    return true;
}

/**
 * Judge one screenshot. Never throws: every way it can go wrong is `{ state: "unavailable", reason }`.
 * `reason` is plain text that finishes the sentence "AI judgement could not run: ...".
 */
export async function judgeImage(ctx: EngineContext, browser: Browser | undefined, args: { image: Buffer; expected?: string; context?: string }): Promise<Judged> {
    if (typeof ctx.llm.imageObject !== "function") return { state: "unavailable", reason: "the configured AI connection cannot send images to a model" };
    if (!takeFromBudget(ctx)) return { state: "unavailable", reason: `this job already sent its limit of ${VISION_MAX_IMAGES_PER_JOB} screenshots to the model` };
    let prepared;
    try {
        prepared = await prepareImage(browser, args.image);
    } catch (err) {
        if (err instanceof VisionImageError) return { state: "unavailable", reason: err.message };
        return { state: "unavailable", reason: `the screenshot could not be prepared (${err instanceof Error ? err.message : String(err)})` };
    }
    let raw: unknown;
    try {
        raw = await ctx.llm.imageObject({
            system: JUDGE_SYSTEM,
            prompt: judgePrompt({ expected: args.expected, context: args.context }),
            images: [{ data: prepared.data, mediaType: prepared.mediaType }],
            schema: VerdictSchema,
            temperature: 0,
            maxOutputTokens: VISION_MAX_OUTPUT_TOKENS,
            purpose: "vision",
        });
    } catch (err) {
        return { state: "unavailable", reason: describeModelFailure(err) };
    }
    // The provider already validated against the schema; a client double (or a gateway) may not have.
    const parsed = VerdictSchema.safeParse(raw);
    if (!parsed.success) return { state: "unavailable", reason: "the model's answer was not a usable verdict (it did not say ok, confidence and problems)" };
    return { state: "verdict", verdict: parsed.data, image: { width: prepared.width, height: prepared.height, bytes: prepared.data.length, downscaled: prepared.downscaled } };
}

/** The lines of one verdict as they appear in a finding. */
export function problemLines(step: number, verdict: Verdict, severity: VisionSeverity): string[] {
    const problems = verdict.problems.length ? verdict.problems : ["The model says something looks wrong but did not say what"];
    return problems.slice(0, 5).map((p) => `- [${severity}] Step ${step + 1} (${verdict.confidence} confidence): ${clipProblem(p)}`);
}

function failStep(run: ScriptRun, step: number, message: string): void {
    run.status = "failed";
    const st = run.steps.find((s) => s.index === step);
    if (st) {
        st.status = "failed";
        st.error = message;
    }
    if (run.failedStepIndex < 0 || step < run.failedStepIndex) run.failedStepIndex = step;
    run.error ??= message;
}

/**
 * Judge the screenshots a passed run captured for its `looksRight` steps and fold the verdicts into the run, so that
 * everything downstream (recording, classification, severity, retries) sees one consistent picture:
 *  - a finding fails the step with a message that starts with VISION_FAILURE_PREFIX;
 *  - an unavailable judgement fails the step with VISION_UNAVAILABLE_PREFIX (a test problem, not a finding);
 *  - low confidence only adds a note (`run.notes`) and the run stays passed.
 * A run that did not pass is left alone: nothing is sent to the model for a test that already failed.
 */
export async function applyVisionJudgement(ctx: EngineContext, browser: Browser | undefined, run: ScriptRun): Promise<void> {
    if (run.status !== "passed" || !run.vision?.length) return;
    const shots = [...run.vision].sort((a, b) => a.step - b.step);
    const judged = shots.slice(0, VISION_MAX_IMAGES_PER_TEST);
    const notes: string[] = [];
    if (shots.length > judged.length) notes.push(`AI judgement note: only the first ${judged.length} of ${shots.length} screenshots of this test were judged (limit per test).`);

    const findings: Array<{ step: number; severity: VisionSeverity; confidence: Confidence; lines: string[] }> = [];
    for (const shot of judged) {
        let image: Buffer;
        try {
            image = await fs.readFile(shot.path);
        } catch {
            image = Buffer.alloc(0);
        }
        const res = image.length
            ? await judgeImage(ctx, browser, { image, expected: shot.expected, context: `${run.testId}, step ${shot.step + 1}` })
            : ({ state: "unavailable", reason: "the screenshot taken by the test could not be read" } as const);
        if (res.state === "unavailable") {
            run.visionJudged = "unavailable";
            failStep(run, shot.step, `${VISION_UNAVAILABLE_PREFIX} ${res.reason}. Nothing was judged, so this test is neither passed nor flagged.`);
            ctx.emit({ stage: "validation", kind: "vision_unavailable", level: "warn", message: `${run.testId}: AI judgement could not run: ${res.reason}` });
            return;
        }
        const w = weigh(res.verdict);
        if (w.kind === "finding") {
            findings.push({ step: shot.step, severity: w.severity, confidence: res.verdict.confidence, lines: problemLines(shot.step, res.verdict, w.severity) });
        } else if (w.kind === "note") {
            const what = res.verdict.problems.length ? res.verdict.problems.slice(0, 3).map((p) => clipProblem(p, 120)).join("; ") : "something";
            notes.push(`AI judgement note (not sure): step ${shot.step + 1} — the model thought this might look wrong (${what}) but was not confident, so the test still passes.`);
        }
    }

    if (findings.length) {
        run.visionJudged = "finding";
        findings.sort((a, b) => a.step - b.step);
        for (const f of findings) {
            failStep(run, f.step, `${VISION_FAILURE_PREFIX} the screen may not look right (${f.confidence} confidence)\n${f.lines.join("\n")}`);
        }
        ctx.emit({ stage: "validation", kind: "vision_finding", level: "warn", message: `${run.testId}: AI judgement says ${findings.length === 1 ? "a screen" : `${findings.length} screens`} may not look right: please look` });
    } else {
        run.visionJudged = "ok";
    }
    if (notes.length) run.notes = [...(run.notes ?? []), ...notes];
}
