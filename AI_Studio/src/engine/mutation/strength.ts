/**
 * After validation: score the validated web tests against deliberate faults (./faults.ts), send each test that missed some once
 * through the authoring review path ("add an assertion that would fail when ..."), and score the stronger version. A stronger
 * version is kept only when it still passes against the real application and catches more faults than before.
 */
import type { Browser } from "playwright";
import { mapLimit, throwIfAborted, type EngineContext } from "../context.js";
import { localExecutor, renderWithAdapter } from "../frameworks/index.js";
import { firstN } from "../levels.js";
import type { Scenario, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { authorWebSpec } from "../web/author.js";
import { faultEligibility, scoreTests, strengthenNote, strengthText, type FaultDeps, type Strength } from "./faults.js";

export interface StrengthDeps extends FaultDeps {
    /** Needed to strengthen (the authoring agent's browser); without it tests are only scored. */
    browser?: Browser;
    baseUrl: string;
    model: AppModel;
    credentials?: { username: string; password: string };
    maxSteps?: number;
    /** How many tests are checked (the level's strengthTests; Infinity: all). */
    limit: number;
}

export interface StrengthTest {
    spec: TestSpec;
    validationStatus: string;
    scenario?: Scenario;
}

export interface StrengthHooks {
    /** A stronger version passed against the real application: store its steps and its (real, fault-free) run. */
    onStrengthened?(testId: string, spec: TestSpec, run: ScriptRun): Promise<void>;
    onScored(testId: string, strength: Strength): Promise<void>;
}

export interface StrengthSummary {
    checked: number;
    caught: number;
    total: number;
    strengthened: number;
}

export async function checkStrength(ctx: EngineContext, deps: StrengthDeps, tests: StrengthTest[], hooks: StrengthHooks): Promise<StrengthSummary> {
    const summary: StrengthSummary = { checked: 0, caught: 0, total: 0, strengthened: 0 };
    const chosen = firstN(tests.filter((t) => faultEligibility(t.spec, t.validationStatus).eligible), deps.limit);
    if (!chosen.length) return summary;
    ctx.emit({ stage: "validation", kind: "strength_started", message: `Checking that ${chosen.length} test(s) notice deliberate faults` });
    const scores = await scoreTests(ctx, deps, chosen.map((t) => t.spec));

    // Tests that missed a fault: once through the review path, in the authoring browser.
    const weak = ctx.llm.modelName === "unavailable" ? [] : chosen.filter((t) => (scores.get(t.spec.testId)?.missed.length ?? 0) > 0 && t.scenario && deps.browser);
    const proposals = (
        await mapLimit(weak, Math.max(1, ctx.config.CONCURRENCY), async (t) => {
            throwIfAborted(ctx.signal);
            const note = strengthenNote(scores.get(t.spec.testId)!.missed);
            try {
                const out = await authorWebSpec({ ctx, browser: deps.browser!, baseUrl: deps.baseUrl, model: deps.model, scenario: t.scenario!, credentials: deps.credentials, maxSteps: deps.maxSteps, resume: { prefix: t.spec.steps, failure: note, review: true } });
                if (out.status !== "complete" || out.steps.length <= t.spec.steps.length) return [];
                return [{ t, spec: { ...t.spec, steps: out.steps, testData: { ...t.spec.testData, ...out.testData } } as TestSpec }];
            } catch (err) {
                ctx.emit({ stage: "validation", kind: "strengthen_failed", level: "warn", message: `${t.spec.testId}: could not be given a stronger check: ${err instanceof Error ? err.message : String(err)}` });
                return [];
            }
        })
    ).flatMap((r) => (r.ok ? r.value : []));

    // A stronger version must still pass against the real application (no fault), then catch more.
    const kept = new Map<string, { spec: TestSpec; run: ScriptRun }>();
    if (proposals.length) {
        const scripts = proposals.map((p) => {
            const s = renderWithAdapter(p.spec, "playwright", deps.render);
            return { testId: p.spec.testId, filename: s.filename, content: s.content, framework: "playwright" };
        });
        const runs = await (deps.executor ?? ctx.executor ?? localExecutor).execute("playwright", { scratchDir: deps.scratchDir, scripts }, { run: deps.env }, { workers: Math.max(1, deps.workers), signal: ctx.signal });
        const passing = proposals.filter((_, i) => runs[i]?.status === "passed");
        const again = await scoreTests(ctx, deps, passing.map((p) => p.spec));
        passing.forEach((p) => {
            const before = scores.get(p.spec.testId)!;
            const after = again.get(p.spec.testId);
            if (!after || after.caught <= before.caught) return;
            kept.set(p.spec.testId, { spec: p.spec, run: runs[proposals.indexOf(p)]! });
            scores.set(p.spec.testId, { ...after, strengthened: true });
        });
    }

    for (const t of chosen) {
        const s = scores.get(t.spec.testId);
        if (!s) continue;
        const k = kept.get(t.spec.testId);
        if (k) (await hooks.onStrengthened?.(t.spec.testId, k.spec, k.run), summary.strengthened++);
        await hooks.onScored(t.spec.testId, s);
        summary.checked++;
        summary.caught += s.caught;
        summary.total += s.total;
        ctx.emit({ stage: "validation", kind: "strength_scored", level: s.missed.length ? "warn" : "info", message: `${t.spec.testId} ${strengthText(s)}${s.strengthened ? " (after a stronger check was added)" : ""}${s.missed.length ? `; misses when ${s.missed.join(", ")}` : ""}`, data: { testId: t.spec.testId, caught: s.caught, total: s.total } });
    }
    ctx.emit({ stage: "validation", kind: "strength_done", message: `Test strength: ${summary.checked} test(s) catch ${summary.caught} of ${summary.total} deliberate faults; ${summary.strengthened} given a stronger check` });
    return summary;
}
