/**
 * Specs and classification for the AI "looks right" check.
 *  - generateVisionSpecs: one spec per important anonymous page (opt-in: job option `visionChecks`);
 *  - visionFinding / visionUnavailable: how the validator reads a run after the platform judged its screenshots
 *    (see judge.ts, which folds verdicts into the run) — a finding is a NEEDS_REVIEW result, "could not run" is a plain failure.
 */
import { pinToday } from "../web/conditions.js";
import { selectKeyPages } from "../a11y/specs.js";
import type { DraftSpec } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { VISION_ADVICE, VISION_FAILURE_PREFIX, VISION_UNAVAILABLE_PREFIX } from "./verdict.js";

export interface VisionGenOptions {
    maxPages: number;
    /** Times the usual per-type limit of key pages (engine/levels perTypeScale); default 1. */
    perTypeScale?: number;
}

export const isVisionStep = (s: Step | undefined): boolean => s?.action === "assert" && s.check === "looksRight";

/** Generated checks look at the most important pages only: every screenshot is a paid model call. */
export function generateVisionSpecs(model: AppModel, opts: VisionGenOptions): DraftSpec[] {
    return selectKeyPages(model, opts.maxPages, opts.perTypeScale).map(({ page, label, priority }) => {
        const path = page.path || "/";
        const name = page.title?.trim() || path;
        const steps: Step[] = [
            { action: "navigate", url: path, description: `Open ${path}` },
            { action: "assert", check: "looksRight", expected: "", description: "The page looks right: nothing overlaps or is cut off, text and images show properly" },
        ];
        return {
            title: `${label ? `${label} page` : "Page"} looks right to an AI reviewer (${path})`,
            description: `Takes a screenshot of "${name}" and asks a vision-capable AI model whether the screen looks right (overlapping or clipped elements, broken images, unreadable text). The verdict is a judgement, not a measurement: a problem is reported as "please look" with the screenshot attached.`,
            kind: "web",
            category: "AI judgement",
            type: "vision",
            priority,
            preconditions: [],
            steps,
            expectedResults: ["The screen looks right: no overlapping or cut-off elements, no missing images, readable text"],
            testData: {},
            tags: ["vision", "ai"],
            source: { origin: "vision-check" },
            // The same screen every day: a date on the page is not something to judge.
            pinnedTime: pinToday(),
        };
    });
}

/** The failure text of one step, from the prefix on (minus any call log Playwright appended). */
function ownMessage(text: string, prefix: string): string | undefined {
    const at = text.indexOf(prefix);
    return at < 0 ? undefined : text.slice(at).trim();
}

/** Failure messages of the failed `looksRight` steps of a run that start with `prefix`. */
function stepMessages(spec: TestSpec, run: ScriptRun, prefix: string): string[] {
    const out: string[] = [];
    for (const st of run.steps) {
        if (st.status === "failed" && isVisionStep(spec.steps[st.index])) {
            const m = ownMessage(st.error ?? "", prefix);
            if (m) out.push(m);
        }
    }
    return out;
}

/** True when the platform judged this run and either found a problem or could not judge (so no retry or repair makes sense). */
export function isVisionFailure(run: ScriptRun): boolean {
    return run.visionJudged === "finding" || run.visionJudged === "unavailable";
}

/**
 * A failed run is an application finding only when the model said (with high or medium confidence) that a screen looks wrong.
 * One headline for all screens, then each problem as its own tagged line.
 */
export function visionFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const messages = stepMessages(spec, run, VISION_FAILURE_PREFIX);
    if (!messages.length) return undefined;
    const lines = messages.flatMap((m) => m.split("\n").filter((l) => l.startsWith("- ")));
    const n = messages.length;
    return `${VISION_FAILURE_PREFIX} ${n === 1 ? "a screen" : `${n} screens`} may not look right\n${lines.join("\n")}\nHow to check: ${VISION_ADVICE}`.slice(0, 2500);
}

/** The plain reason a `looksRight` test could not be judged (no model, no image support, unusable answer...), if that is why it failed. */
export function visionUnavailable(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const first = stepMessages(spec, run, VISION_UNAVAILABLE_PREFIX)[0];
    return first?.split("\n")[0]?.slice(0, 600);
}

/** Worst severity of an AI-judgement finding reason (undefined if it is not one). */
export function parseVisionReason(reason: string): "medium" | "low" | undefined {
    if (!reason.includes(VISION_FAILURE_PREFIX)) return undefined;
    const body = reason.split(/^how to check:/im)[0] ?? "";
    return /^- \[medium\]/m.test(body) ? "medium" : "low";
}
