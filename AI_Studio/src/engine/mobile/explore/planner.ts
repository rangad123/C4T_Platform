/**
 * Planning the test ideas of a phone exploration. The code lists what can really be written (candidates.ts); the model chooses among them and words
 * them in plain language. It cannot add a candidate, a step or an expected result: those come from what the exploration saw.
 */
import { z } from "zod";
import type { EngineContext } from "../../context.js";
import { isBudgetExceeded } from "../../llm/usage.js";
import { LlmNotConfiguredError } from "../../llm/provider.js";
import type { Scenario } from "../../spec/schema.js";
import type { Candidate, Dropped } from "./candidates.js";
import { ModelBudget } from "./explorer.js";
import { PLAN_SYSTEM, SCREEN_CLOSE, SCREEN_OPEN } from "./prompts.js";
import { PRIORITY_OF, buildSpec, appNameOf } from "./spec-builder.js";
import { cleanAppText } from "./text.js";
import { FAMILY_LABEL, PHONE_FAMILIES, type MobileAppModel, type PhoneFamily, type PhoneIdea, type PhonePlan } from "./types.js";
import { DEFAULT_DEPTH, DEPTHS, type PhoneDepth } from "../phone-settings.js";

/**
 * Most test ideas one plan offers, by how thorough the exploration was (R24: Quick 15, Standard 40, Thorough 80). A project that asked for fewer
 * scenarios than the platform's default of 25 keeps its smaller number.
 */
export function phoneIdeaCap(depth: PhoneDepth | undefined, maxScenarios?: number): number {
    const cap = DEPTHS[depth ?? DEFAULT_DEPTH].ideas;
    return maxScenarios !== undefined && maxScenarios < 25 ? Math.max(1, Math.min(cap, maxScenarios)) : cap;
}

export const PlanReply = z.object({
    ideas: z
        .array(
            z.object({
                id: z.string().min(1).max(12),
                title: z.string().min(3).max(200),
                goal: z.string().max(400).optional(),
                priority: z.enum(["critical", "high", "medium", "low"]).optional(),
            }),
        )
        .max(100),
});

/** Fewest ideas to offer when the app has that many candidates (the model may choose fewer, the code tops up). */
export const MIN_IDEAS = 6;

const ORDER: Record<PhoneFamily, number> = Object.fromEntries(PHONE_FAMILIES.map((f, i) => [f, i])) as Record<PhoneFamily, number>;

export function describeCandidates(model: MobileAppModel, candidates: readonly Candidate[], maxIdeas: number): string {
    const lines = candidates.slice(0, 120).map((c) => `${c.id} [${c.family}] ${cleanAppText(c.title, 100)}. Path: ${c.path.map((p) => cleanAppText(p, 30)).join(" > ")}. ${cleanAppText(c.facts, 300)}`);
    return `App: ${model.appPackage}\nScreens found: ${model.screens.length}\nMaximum ideas to choose: ${maxIdeas}\nCandidates (the exploration really did each of these):\n${SCREEN_OPEN}\n${lines.join("\n")}\n${SCREEN_CLOSE}\nChoose and word the test ideas.`;
}

export interface Chosen {
    candidate: Candidate;
    title: string;
    goal: string;
    priority: "critical" | "high" | "medium" | "low";
}

/** The ideas to offer: the model's choice where it gave a usable one, topped up by the code so a small app still gets a full plan. */
export async function chooseIdeas(ctx: EngineContext, model: MobileAppModel, candidates: readonly Candidate[], budget: ModelBudget, maxIdeas: number): Promise<{ chosen: Chosen[]; usedModel: boolean; limitMessage?: string }> {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picked = new Map<string, Chosen>();
    const template = (c: Candidate): Chosen => ({ candidate: c, title: c.title, goal: c.goal, priority: PRIORITY_OF[c.family] });
    let usedModel = false;
    let limitMessage: string | undefined;
    if (candidates.length > 0 && budget.left > 0) {
        budget.used++;
        try {
            const raw = await ctx.llm.object({ system: PLAN_SYSTEM, prompt: describeCandidates(model, candidates, maxIdeas), schema: PlanReply, maxOutputTokens: Math.min(8000, 1500 + 80 * maxIdeas), purpose: "planning" });
            const parsed = PlanReply.safeParse(raw);
            if (parsed.success) {
                for (const idea of parsed.data.ideas) {
                    const c = byId.get(idea.id);
                    if (!c || picked.has(c.id)) continue;
                    const title = cleanAppText(idea.title, 100);
                    if (title.length < 3) continue;
                    picked.set(c.id, { candidate: c, title, goal: cleanAppText(idea.goal ?? "", 240) || c.goal, priority: idea.priority ?? PRIORITY_OF[c.family] });
                    usedModel = true;
                }
            }
        } catch (e) {
            if (e instanceof LlmNotConfiguredError) throw e;
            // A reached AI limit, or an unusable answer: the plan is made from the standard names below, and the person is told.
            if (isBudgetExceeded(e)) limitMessage = e.message;
        }
    }
    // The app opening is always a test; the rest is topped up by importance (the candidates' score: main navigation and core flows first).
    const start = candidates.find((c) => c.family === "start");
    if (start && !picked.has(start.id)) picked.set(start.id, template(start));
    const want = Math.min(maxIdeas, usedModel ? Math.max(MIN_IDEAS, picked.size) : candidates.length, candidates.length);
    const byImportance = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || ORDER[a.family] - ORDER[b.family] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
    for (const c of byImportance) {
        if (picked.size >= want) break;
        if (!picked.has(c.id)) picked.set(c.id, template(c));
    }
    // Over the cap (the model chose more): the most important ones stay, then they are shown family by family.
    const rank = new Map(byImportance.map((c, i) => [c.id, i]));
    const kept = [...picked.values()].sort((a, b) => (a.candidate.family === "start" ? -1 : 0) - (b.candidate.family === "start" ? -1 : 0) || rank.get(a.candidate.id)! - rank.get(b.candidate.id)!).slice(0, maxIdeas);
    const chosen = kept.sort((a, b) => ORDER[a.candidate.family] - ORDER[b.candidate.family] || rank.get(a.candidate.id)! - rank.get(b.candidate.id)!);
    return { chosen, usedModel, ...(limitMessage ? { limitMessage } : {}) };
}

/** Ideas with their finished tests. Ones that cannot be written are listed with the reason. */
export function buildPlan(model: MobileAppModel, chosen: readonly Chosen[], droppedBefore: readonly Dropped[]): PhonePlan {
    const ideas: PhoneIdea[] = [];
    const dropped: Dropped[] = [...droppedBefore];
    for (const ch of chosen) {
        const id = `M-${String(ideas.length + 1).padStart(2, "0")}`;
        const r = buildSpec({ candidate: ch.candidate, id, title: ch.title, goal: ch.goal, priority: ch.priority, appPackage: model.appPackage, ...(model.permissions?.length ? { permissions: model.permissions } : {}) });
        if (!r.ok) {
            dropped.push({ title: ch.title, reason: r.reason });
            continue;
        }
        const { testId: _t, ...draft } = r.spec;
        ideas.push({ id, family: ch.candidate.family, title: ch.title, goal: ch.goal, priority: ch.priority, path: ch.candidate.path, usesSignIn: ch.candidate.usesSignIn, draft, ...(ch.candidate.why ? { why: ch.candidate.why } : {}), ...(ch.candidate.covers?.length ? { covers: ch.candidate.covers } : {}) });
    }
    return { appPackage: model.appPackage, appName: appNameOf(model.appPackage), ideas, dropped };
}

/** The plan's ideas as the scenarios every plan carries (the plan routes list and exclude ideas by scenario id). */
export function ideaScenarios(plan: PhonePlan): Scenario[] {
    return plan.ideas.map((i) => ({
        scenarioId: i.id,
        title: i.title,
        description: i.goal,
        category: `Phone · ${plan.appName}`,
        type: ((i.draft as { type?: Scenario["type"] }).type ?? "functional") as Scenario["type"],
        priority: i.priority,
        journey: FAMILY_LABEL[i.family],
        startPath: "/",
        preconditions: [],
        expectedResults: ((i.draft as { expectedResults?: string[] }).expectedResults ?? []).length ? ((i.draft as { expectedResults: string[] }).expectedResults) : [i.goal],
        requiresAuth: i.usesSignIn,
        requiredData: [],
        requirements: [],
    }));
}
