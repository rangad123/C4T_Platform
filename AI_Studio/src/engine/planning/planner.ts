/**
 * Test planning: AppModel → a prioritised list of test scenarios.
 *
 * The planning prompt is shaped by autospec's planner ("cover the most important user journeys
 * with the fewest steps; formulate specs from intended functionality, not current state") and
 * QAAgency's planner (critical flows + regression/error paths), but produces structured
 * scenarios — id, category, priority, preconditions, expected results, required data — rather
 * than one-line specs.
 */
import { z } from "zod";
import type { EngineContext } from "../context.js";
import { ScenarioSchema, type Scenario } from "../spec/schema.js";
import type { Requirement } from "../requirements/parse.js";
import type { AppModel } from "../understanding/app-model.js";

const PlanSchema = z.object({ scenarios: z.array(ScenarioSchema.omit({ scenarioId: true })) });

export interface PlanOptions {
    maxScenarios: number;
    hasCredentials: boolean;
    /** Free text restricting what to test, e.g. "checkout and cart only". */
    scope?: string;
    /** Requirements from an uploaded document: scenarios should cover them and cite their ids. */
    requirements?: Requirement[];
    /** Bounded "previously known" section from site memory (context only; never a reason to plan for UI that is not in the model). */
    memory?: string;
}

/** Bounds on how much of a requirements document goes into the planning prompt. */
const MAX_PROMPT_REQUIREMENTS = 150;
const MAX_REQUIREMENT_CHARS = 240;

function requirementsBlock(reqs: Requirement[]): string {
    const shown = reqs.slice(0, MAX_PROMPT_REQUIREMENTS);
    const lines = shown.map((r) => {
        const text = r.text.length > MAX_REQUIREMENT_CHARS ? `${r.text.slice(0, MAX_REQUIREMENT_CHARS)}…` : r.text;
        return `- [${r.id}] (${r.kind}${r.section ? `, ${r.section}` : ""}) ${text}`;
    });
    const more = reqs.length > shown.length ? `\n(${reqs.length - shown.length} further requirements omitted for length)` : "";
    return `Requirements to cover (from the owner's requirements document):
${lines.join("\n")}${more}

Requirements rules:
- Plan scenarios that verify these requirements against the application above. List the ids each scenario verifies in "requirements"
  (only ids from this list). One scenario may cover several requirements; important requirements may need a positive and a negative scenario.
- The requirements say WHAT to test; the discovered pages say HOW. Only plan a scenario when the needed UI exists in the model —
  never invent pages or controls. Requirements you cannot map to discovered UI are reported as uncovered; do not fake coverage.
- Non-functional requirements (performance, availability...) that a UI test cannot observe should be left uncovered.`;
}

/**
 * Which requirements have at least one planned scenario citing them. Deterministic — computed from the
 * final scenario list, so scenarios dropped later (e.g. needing credentials we don't have) don't count.
 */
export function requirementsCoverage(reqs: Requirement[], scenarios: Scenario[]): { covered: string[]; uncovered: Array<{ id: string; text: string }> } {
    const cited = new Set(scenarios.flatMap((s) => s.requirements));
    return {
        covered: reqs.filter((r) => cited.has(r.id)).map((r) => r.id),
        uncovered: reqs.filter((r) => !cited.has(r.id)).map((r) => ({ id: r.id, text: r.text })),
    };
}

const SYSTEM = `You are a senior QA lead planning a web test suite for one application, from a model of what was discovered.
Produce meaningful, independent scenarios — NOT one test per button.
Rules:
- Group by feature area ("category"), e.g. Authentication, Search, Cart, Checkout, Navigation.
- For every important journey include the happy path AND the realistic negative/validation cases a QA engineer would add
  (invalid credentials, empty required fields, invalid formats, no-results search, unauthorised access...).
- Derive expected behaviour from the intended functionality, but only reference UI that exists in the model.
- Each scenario must be independently runnable from a clean browser session, starting at "startPath".
- Each scenario needs 1-3 concrete, observable expectedResults (text shown, URL change, element visible/hidden, count...).
- These are UI tests: expected results must be visible in the browser UI. Never expect anything about API endpoints,
  JSON responses or network calls — API behaviour is covered by separate, generated API tests.
- NEVER plan actions that cause irreversible or external effects against a live site: no real payments, no account deletion,
  no sending emails/messages to real people, no bulk data changes. Stop one step before the irreversible action and assert on the
  confirmation UI instead.
- Sign-up scenarios must use unique throwaway data via "{{unique}}" (e.g. qa+{{unique}}@example.com) — say so in requiredData.
- Scenarios that need a logged-in user set requiresAuth=true and may use credentials {{credentials.username}} / {{credentials.password}}.
- Priority: critical = core revenue/auth journeys, high = main features, medium = secondary, low = edge polish.
- Titles are short imperative statements ("Login fails with an incorrect password").`;

function modelDigest(model: AppModel): string {
    const pages = model.pages
        .map((p) => {
            const forms = p.forms.map((f) => `${f.purpose}(${f.fields.map((x) => x.label || x.placeholder || x.name || x.type).join(", ")})`).join("; ");
            return `- ${p.path} [${p.type}] ${p.purpose ?? p.title}${forms ? ` | forms: ${forms}` : ""}`;
        })
        .join("\n");
    const journeys = model.journeys
        .map((j) => `- (${j.priority}${j.requiresAuth ? ", auth" : ""}) ${j.name}: ${j.steps.join(" → ")}`)
        .join("\n");
    const documented = model.documentedTestCases.length
        ? `\nDocumented on the site itself (cover these):\n${model.documentedTestCases.slice(0, 40).map((t) => `- ${t.id ?? ""} ${t.name}`).join("\n")}`
        : "";
    return `Application: ${model.url}\nType: ${model.siteType}\nPurpose: ${model.purpose}\nFeatures: ${model.features.join(", ")}\n\nPages:\n${pages}\n\nJourneys:\n${journeys}${documented}`;
}

export async function planScenarios(ctx: EngineContext, model: AppModel, opts: PlanOptions): Promise<Scenario[]> {
    const plan = await ctx.llm.object({
        system: SYSTEM,
        schema: PlanSchema,
        maxOutputTokens: 12_000,
        purpose: "planning",
        prompt: `${modelDigest(model)}${opts.memory ? `\n\n${opts.memory}` : ""}

Constraints:
- Plan at most ${opts.maxScenarios} scenarios (fewer if the app is small).
- Test credentials ${opts.hasCredentials ? "ARE available" : "are NOT available: do not plan scenarios that require a successful login, but DO plan login-failure and validation scenarios"}.
${opts.scope ? `- Testing scope requested by the owner: ${opts.scope}` : "- Scope: the whole application."}
${model.authentication.required ? "" : "- No login form was detected; do not plan authentication scenarios."}${
            opts.requirements?.length ? `

${requirementsBlock(opts.requirements)}` : ""
        }`,
    });
    const knownIds = new Set((opts.requirements ?? []).map((r) => r.id));

    const scenarios: Scenario[] = [];
    const titles = new Set<string>();
    for (const s of plan.scenarios) {
        if (opts.hasCredentials === false && s.requiresAuth) continue;
        const key = s.title.trim().toLowerCase();
        if (titles.has(key)) continue;
        titles.add(key);
        // Keep only requirement ids that exist, so coverage can't be inflated by invented ids.
        scenarios.push({ ...s, requirements: s.requirements.filter((id) => knownIds.has(id)), scenarioId: `S-${String(scenarios.length + 1).padStart(3, "0")}` });
        if (scenarios.length >= opts.maxScenarios) break;
    }
    for (const s of scenarios) {
        ctx.emit({
            stage: "planning",
            kind: "scenario_planned",
            message: `${s.scenarioId} [${s.category}/${s.priority}] ${s.title}`,
        });
    }
    return scenarios;
}
