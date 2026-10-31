/**
 * Creating a phone plan's check tests (crash, start-up, accessibility): each is stored as Needs a look with the facts the phone reported while the AI
 * explored, and is checked again on the phone whenever it runs. They are not run straight away: a crash that does not happen twice in a row is
 * still a crash a person should look at, so the first verdict is what was really seen.
 */
import type { EngineContext } from "../../context.js";
import { secretProblems } from "../../builder/index.js";
import { renderWithAdapter } from "../../frameworks/index.js";
import type { GenerationSink, GenerationSummary } from "../../orchestrator.js";
import { TestSpecSchema } from "../../spec/schema.js";
import { formatMs } from "./startup.js";
import type { PhoneQualityPlan } from "./types.js";

/** Plain sentences for the plan's warnings: only what a person must know before creating (crashes, a slow start). */
export function qualityWarnings(q: PhoneQualityPlan | undefined): string[] {
    if (!q) return [];
    const out: string[] = [];
    const crashes = q.crashes.filter((c) => c.crash.kind !== "anr").length;
    const anrs = q.crashes.length - crashes;
    if (crashes) out.push(`The app crashed ${crashes === 1 ? "once" : `${crashes} different ways`} while the AI explored it. Creating the plan keeps ${crashes === 1 ? "it" : "each"} as a test that needs a look, with the stack trace and the steps.`);
    if (anrs) out.push(`The app stopped responding ${anrs === 1 ? "once" : `${anrs} times`} while the AI explored it. Creating the plan keeps it as a test that needs a look.`);
    if (q.startup?.overBudget && q.startup.measure) out.push(`The app took ${formatMs(q.startup.measure.totalMs)} to open from a cold start, more than the budget of ${formatMs(q.startup.budgetMs)}.`);
    return out;
}

export async function createQualityTests(
    ctx: EngineContext,
    sink: GenerationSink,
    q: PhoneQualityPlan | undefined,
    o: { appPackage: string; accessibility: boolean; summary: GenerationSummary },
): Promise<number> {
    let made = 0;
    for (const t of q?.tests ?? []) {
        if (t.kind === "accessibility" && !o.accessibility) continue;
        try {
            const key = await sink.nextTestKey("MOB");
            const spec = TestSpecSchema.parse({ ...t.draft, testId: key });
            // A plan is read back from storage: it is checked again before anything is created from it.
            const bad = spec.steps.flatMap((s) => secretProblems(s))[0];
            if (bad) throw new Error(bad);
            if (spec.kind !== "mobile") throw new Error("It is not a phone test");
            const h = await sink.createTest({ spec, framework: "taqwright", validation: "NEEDS_REVIEW", reason: t.reason, meta: { model: ctx.llm.modelName, authoring: "exploration", explanation: spec.description, phone: { appPackage: o.appPackage, ideaId: t.id, check: t.kind } } });
            await sink.saveScript(h, renderWithAdapter(spec, "taqwright", { baseUrl: `android-app://${o.appPackage}`, apiBaseUrl: `android-app://${o.appPackage}` }), true);
            await sink.counters({ testsGenerated: 1, testsNeedingReview: 1 }, true);
            o.summary.testsGenerated++;
            made++;
            ctx.emit({ stage: "generation", kind: "script_generated", message: `${key} ${spec.title} (needs a look: ${t.reason.split("\n")[0]!.slice(0, 160)})` });
        } catch (e) {
            o.summary.errors.push(`${t.title}: ${e instanceof Error ? e.message : String(e)}`);
            ctx.emit({ stage: "generation", kind: "scenario_failed", level: "warn", message: `${t.title} could not be written: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    return made;
}
