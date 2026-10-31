/**
 * The validator's step "repair without AI first": before the model is asked to analyse and repair a web test that could not find its
 * element, the fixes found by plain rules (../healing/deterministic.ts) are tried, each with a real run of the test. The first fix with
 * which the test PASSES is kept; only when none passes is the model asked, exactly as before. Which rule fixed it is said in the job log
 * (`repaired_without_ai`, counted as AI usage saved) and in the reason handed to the host.
 *
 * Off (`LLM_DETERMINISTIC_REPAIR=false`, or Settings): nothing here runs and repair is what it always was.
 */
import type { Browser } from "playwright";
import type { EngineContext } from "../context.js";
import { applyLocator } from "../healing/apply.js";
import { findDeterministicFixes, fixSentence, FIX_KIND_WORDS, type DetFix } from "../healing/deterministic.js";
import { refOf } from "../locators/refs.js";
import { EVENT_REPAIRED_WITHOUT_AI } from "../llm/without-ai.js";
import type { Locator, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "./runner.js";

export type RepairWithoutAi = { status: "fixed"; spec: TestSpec; run: ScriptRun; fix: DetFix; reason: string } | { status: "none"; reason: string } | { status: "stopped" };

export interface RepairWithoutAiInput {
    ctx: Pick<EngineContext, "emit" | "signal" | "sharedElements">;
    browser: Browser;
    baseUrl: string;
    spec: TestSpec;
    run: ScriptRun;
    credentials?: { username: string; password: string; totpSecret?: string };
    /** One run of the test with this spec (rendered and executed the normal way). Undefined: the job was stopped before it gave a result. */
    rerun: (spec: TestSpec) => Promise<ScriptRun | undefined>;
}

/** The other locators of the shared element the failing step uses, if it uses one and some are on record. */
function alternativesOf(ctx: RepairWithoutAiInput["ctx"], spec: TestSpec, run: ScriptRun): Locator[] {
    const step = spec.steps[run.failedStepIndex];
    const name = step && "locator" in step ? refOf(step.locator) : undefined;
    return name ? (ctx.sharedElements?.get(name)?.alternatives ?? []) : [];
}

export async function repairWithoutAi(i: RepairWithoutAiInput): Promise<RepairWithoutAi> {
    const found = await findDeterministicFixes({ browser: i.browser, baseUrl: i.baseUrl, spec: i.spec, run: i.run, credentials: i.credentials, alternatives: alternativesOf(i.ctx, i.spec, i.run) });
    if (found.status === "none") return { status: "none", reason: found.reason };
    for (const fix of found.fixes) {
        if (i.ctx.signal?.aborted) return { status: "stopped" };
        const patched = applyLocator(i.spec, fix.stepIndex, fix.oldLocator, fix.newLocator);
        if (!patched.ok) continue;
        const run = await i.rerun(patched.spec);
        if (!run) return { status: "stopped" };
        if (run.status === "passed") {
            const reason = `Fixed without AI: ${fixSentence(fix.oldLocator, fix)}.`;
            i.ctx.emit({ stage: "validation", kind: EVENT_REPAIRED_WITHOUT_AI, message: `${i.spec.testId}: ${reason}`, data: { testId: i.spec.testId, kind: fix.kind, stepIndex: fix.stepIndex } });
            return { status: "fixed", spec: patched.spec, run, fix, reason };
        }
        i.ctx.emit({ stage: "validation", kind: "repair_without_ai_tried", message: `${i.spec.testId}: tried ${fix.newDescription} (found by ${FIX_KIND_WORDS[fix.kind]}); the test still did not pass with it` });
    }
    return { status: "none", reason: "none of the fixes found without AI made the test pass" };
}
