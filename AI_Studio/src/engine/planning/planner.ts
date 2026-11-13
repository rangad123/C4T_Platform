/**
 * Test planning: AppModel → a prioritised list of test scenarios.
 *
 * The planning prompt is shaped by autospec's planner ("cover the most important user journeys
 * with the fewest steps; formulate specs from intended functionality, not current state") and
 * QAAgency's planner (critical flows + regression/error paths), but produces structured
 * scenarios — id, category, priority, preconditions, expected results, required data — rather
 * than one-line specs.
 *
 * A large app is planned in batches: one call per area (pages grouped by path prefix) with the whole-app summary as context, one
 * call for end-to-end journeys across areas, and calls for the requirements. A coverage-gap pass then plans for pages and forms no
 * scenario touches yet, given a short functionality-level list of what is already covered.
 */
import { z } from "zod";
import { mapLimit, throwIfAborted, type EngineContext } from "../context.js";
import { LEVEL_SETTINGS } from "../levels.js";
import { notesBlock, type SiteNote } from "../memory/notes.js";
import { isBudgetExceeded } from "../llm/usage.js";
import { ScenarioSchema, type Scenario } from "../spec/schema.js";
import type { Requirement } from "../requirements/parse.js";
import { testDataPlanningRule } from "../testdata/generate.js";
import type { AppModel, PageModel } from "../understanding/app-model.js";
import { uncoveredTransitions } from "../screenmap/map.js";

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
    /** The project's notes for the AI (memory/notes.ts): every planning call, the coverage-gap pass included, sees all of them. */
    notes?: SiteNote[];
    /** Elements per page the planner sees (the exploration level's digestElementsPerPage). Default: thorough's. */
    digestElementsPerPage?: number;
    /** Names of the project's test accounts, when there are several. */
    roles?: string[];
    /** Plain sentences about a partial plan (a reached AI limit, a failed batch) are added here. */
    warnings?: string[];
    /** What differs between the test accounts (../identity/role-differences.ts): planned as role scenarios in a call of their own. */
    roleDifferences?: string[];
    /** Data-changing tests are on: scenarios may create, edit and delete records with generated data carrying this run tag. */
    testData?: { tag?: string };
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
- Plan in three styles: normal paths (what most users do), curious use (unusual but valid: other filters, back and forth, optional
  fields, a second item) and edge cases (empty, too long, boundary values, wrong formats, error messages).
- Where the app allows, the plan must include: multi-step end-to-end journeys across pages; form validation (required fields,
  formats, boundary lengths and values); negative paths with the error message shown; state that must persist (after reload, back,
  sign out and in again); search, filter, sort and pagination results.
- Derive expected behaviour from the intended functionality, but only reference UI that exists in the model.
- Each scenario must be independently runnable from a clean browser session, starting at "startPath".
- Each scenario needs 1-3 concrete, observable expectedResults that depend on its steps: name the element and its state before and
  after where it changes (e.g. "the cart badge shows N+1 after adding, N before"), the text shown, the URL reached, the count of
  results. "The page loads" or "it works" is never an expected result.
- These are UI tests: expected results must be visible in the browser UI. Never expect anything about API endpoints,
  JSON responses or network calls — API behaviour is covered by separate, generated API tests.
- NEVER plan actions that cause irreversible or external effects against a live site: no real payments, no account deletion,
  no sending emails/messages to real people, no bulk data changes. Stop one step before the irreversible action and assert on the
  confirmation UI instead.
- Sign-up scenarios must use unique throwaway data via "{{unique}}" (e.g. qa+{{unique}}@example.com) — say so in requiredData.
- Scenarios that need a logged-in user set requiresAuth=true and may use credentials {{credentials.username}} / {{credentials.password}}.
- Priority: critical = core revenue/auth journeys, high = main features, medium = secondary, low = edge polish.
- Titles are short imperative statements ("Login fails with an incorrect password").`;

/** Pages per area call: an app this small or smaller is planned in one call. */
const AREA_PAGES = 15;
/** Requirements per requirements call. */
const REQ_BATCH = 40;
/** Untouched pages and forms per gap call, and the most gap rounds. */
const GAP_BATCH = 20;
const GAP_ROUNDS = 3;
/** Prompt caps in characters (about 4 per token): the whole-app summary, one call's page detail, the "already covered" list. */
const SUMMARY_CHARS = 30_000;
const DETAIL_CHARS = 80_000;
const COVERED_CHARS = 12_000;

type Planned = z.infer<typeof PlanSchema>["scenarios"][number];

const bare = (path: string) => path.split("?")[0] || "/";
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(cut for length)` : text);
const fieldName = (x: { label?: string; placeholder?: string; name?: string; type: string }) => x.label || x.placeholder || x.name || x.type;

/** The whole app in one line per page, plus its journeys: the context every planning call gets. */
function appSummary(model: AppModel): string {
    const pages = model.pages
        .map((p) => {
            const forms = p.forms.map((f) => `${f.purpose}(${f.fields.map(fieldName).join(", ")})`).join("; ");
            return `- ${p.path} [${p.type}] ${p.purpose ?? p.title}${forms ? ` | forms: ${forms}` : ""}`;
        })
        .join("\n");
    const journeys = model.journeys
        .map((j) => `- (${j.priority}${j.requiresAuth ? ", auth" : ""}) ${j.name}: ${j.steps.join(" → ")}`)
        .join("\n");
    const documented = model.documentedTestCases.length
        ? `\nDocumented on the site itself (cover these):\n${model.documentedTestCases.slice(0, 40).map((t) => `- ${t.id ?? ""} ${t.name}`).join("\n")}`
        : "";
    return `Application: ${model.url}\nType: ${model.siteType}\nPurpose: ${model.purpose}\nFeatures: ${model.features.join(", ")}\n\nPages:\n${cut(pages, SUMMARY_CHARS)}\n\nJourneys:\n${journeys}${documented}`;
}

/** Each page in full: headings, forms with their fields, the first `elements` controls, what interaction revealed, API calls. */
function pageDetail(pages: PageModel[], elements: number): string {
    const share = Math.max(1_500, Math.floor(DETAIL_CHARS / Math.max(pages.length, 1)));
    return pages
        .map((p) => {
            const block = [
                `### ${p.path} [${p.type}] ${p.purpose ?? p.title}`,
                p.headings.length ? `  headings: ${p.headings.slice(0, 6).join(" | ")}` : "",
                ...p.forms.map(
                    (f) =>
                        `  form[${f.purpose}]${f.submitLabel ? ` submit "${f.submitLabel}"` : ""} fields: ${f.fields.map((x) => `${fieldName(x)}(${x.type}${x.required ? ",required" : ""})`).join(", ")}${
                            f.conditional?.length ? `\n  conditional fields (plan a scenario per branch): ${f.conditional.map((c) => `after ${c.when} it shows ${c.shows.join(", ")}`).join("; ")}` : ""
                        }`,
                ),
                p.components.length ? `  controls: ${p.components.slice(0, elements).map((c) => `${c.role}:"${c.name}"`).join(", ")}` : "",
                p.revealed.length ? `  revealed by interaction: ${p.revealed.slice(0, 6).join(" ; ")}` : "",
                p.apiCalls.length ? `  api calls: ${p.apiCalls.slice(0, 12).join(", ")}` : "",
            ]
                .filter(Boolean)
                .join("\n");
            return block.length > share ? `${block.slice(0, share)}…` : block;
        })
        .join("\n");
}

export interface PlanArea {
    name: string;
    pages: PageModel[];
}

/** Areas planned one call each: pages grouped by their first path segment; groups under 3 pages share a call. */
export function planAreas(model: AppModel, size = AREA_PAGES): PlanArea[] {
    if (model.pages.length <= size) return [{ name: "the whole application", pages: model.pages }];
    const groups = new Map<string, PageModel[]>();
    for (const p of model.pages) {
        const seg = bare(p.path).split("/").filter(Boolean)[0];
        const key = seg ? `/${seg}` : "/";
        groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const areas: PlanArea[] = [];
    const small: PageModel[] = [];
    for (const [name, pages] of groups) {
        if (pages.length < 3) small.push(...pages);
        else for (let i = 0; i < pages.length; i += size) areas.push({ name, pages: pages.slice(i, i + size) });
    }
    for (let i = 0; i < small.length; i += size) {
        const pages = small.slice(i, i + size);
        areas.push({ name: [...new Set(pages.map((p) => `/${bare(p.path).split("/").filter(Boolean)[0] ?? ""}`))].join(", "), pages });
    }
    return areas;
}

const scenarioText = (s: Planned | Scenario) =>
    [s.title, s.description, s.journey ?? "", ...s.preconditions, ...s.expectedResults, ...s.requiredData].join(" \n ").toLowerCase();

const FORM_WORDS: Record<string, string[]> = {
    login: ["log in", "login", "sign in", "sign-in", "password"],
    signup: ["sign up", "signup", "register", "registration", "create an account"],
    search: ["search"],
    contact: ["contact", "message"],
    checkout: ["checkout", "check out", "order", "payment"],
    other: [],
};

export interface CoverageTarget {
    kind: "page" | "form" | "transition";
    page: string;
    label: string;
}

/**
 * Which pages and forms at least one scenario touches: it starts there, names the path, or follows a journey through it; a form
 * also needs the scenario to name the form (its kind, submit button or a field). Deterministic, from the scenario text.
 */
export function planCoverage(model: AppModel, scenarios: Array<Planned | Scenario>): { total: number; covered: number; untouched: CoverageTarget[] } {
    const journeyPages = new Map(model.journeys.map((j) => [j.name.toLowerCase(), j.pages.map(bare)]));
    const texts = new Map<string, string[]>();
    for (const s of scenarios) {
        const text = scenarioText(s);
        const hit = new Set([bare(s.startPath), ...(journeyPages.get((s.journey ?? "").toLowerCase()) ?? [])]);
        for (const p of model.pages) if (bare(p.path).length > 1 && text.includes(bare(p.path).toLowerCase())) hit.add(bare(p.path));
        for (const path of hit) texts.set(path, [...(texts.get(path) ?? []), text]);
    }
    const untouched: CoverageTarget[] = [];
    let total = 0;
    for (const p of model.pages) {
        const path = bare(p.path);
        const on = texts.get(path) ?? [];
        total++;
        if (!on.length) untouched.push({ kind: "page", page: path, label: `page ${path}` });
        for (const f of p.forms) {
            total++;
            const clues = [...(FORM_WORDS[f.purpose] ?? []), f.submitLabel ?? "", ...f.fields.map(fieldName)].map((c) => c.toLowerCase()).filter((c) => c.length >= 3);
            const named = on.some((t) => !clues.length || clues.some((c) => t.includes(c)));
            if (!named) untouched.push({ kind: "form", page: path, label: `${f.purpose} form on ${path} (fields: ${f.fields.map(fieldName).join(", ") || "none"})` });
        }
    }
    return { total, covered: total - untouched.length, untouched };
}

const VAGUE = /^(the )?(page|screen|site|app|application)( (loads|opens|works|renders|is (displayed|shown|loaded|visible|rendered)))( (correctly|successfully|properly|fine|as expected))?\.?$|^(it|everything) works( as expected)?\.?$|^no errors?( occurs?| appears?| (is|are) shown)?\.?$/i;
/** A scenario whose every expected result is "the page loads" or alike proves nothing: it is left out (the gap pass plans again). */
export const hasConcreteOutcome = (s: { expectedResults: string[] }) => s.expectedResults.some((r) => r.trim() && !VAGUE.test(r.trim()));

/** Title and intent, for removing duplicates: the same words in any order, from the same start page. */
const STOP = new Set(["a", "an", "the", "is", "are", "to", "of", "on", "in", "with", "and", "for", "from", "be", "can", "user", "users"]);
const intentKey = (s: Planned) =>
    `${bare(s.startPath)}|${[...new Set(s.title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).map((w) => w.replace(/s$/, "")))].sort().join(" ")}`;

function constraints(model: AppModel, opts: PlanOptions, quota: number): string {
    return `Constraints:
- Plan at most ${quota} scenarios (fewer if this part of the app is small).
- Test credentials ${opts.hasCredentials ? "ARE available" : "are NOT available: do not plan scenarios that require a successful login, but DO plan login-failure and validation scenarios"}.
${opts.scope ? `- Testing scope requested by the owner: ${opts.scope}` : "- Scope: the whole application."}
${model.authentication.required ? "" : "- No login form was detected; do not plan authentication scenarios.\n"}${
        opts.roles && opts.roles.length > 1
            ? `- Test accounts: ${opts.roles.join(", ")}. What each may reach is checked separately; where the UI shows the signed-in account role-dependent content (menus, disabled actions, "not allowed" messages), plan scenarios that assert it.\n`
            : ""
    }${opts.testData ? `${testDataPlanningRule(opts.testData)}\n` : ""}`;
}

export async function planScenarios(ctx: EngineContext, model: AppModel, opts: PlanOptions): Promise<Scenario[]> {
    const elements = opts.digestElementsPerPage ?? LEVEL_SETTINGS.thorough.digestElementsPerPage;
    const notes = notesBlock(opts.notes, model.pages);
    const summary = `${appSummary(model)}${opts.memory ? `\n\n${opts.memory}` : ""}${notes ? `\n\n${notes}` : ""}`;
    const max = opts.maxScenarios;
    const reqs = opts.requirements ?? [];
    const knownIds = new Set(reqs.map((r) => r.id));

    // One call per batch of requirements, per area, and (for several areas) one for journeys across them.
    const calls: Array<{ prompt: string; quota: number }> = [];
    for (let i = 0; i < reqs.length; i += REQ_BATCH) {
        const batch = reqs.slice(i, i + REQ_BATCH);
        const quota = Math.min(max, batch.length * 2);
        calls.push({ quota, prompt: `${summary}\n\n${constraints(model, opts, quota)}\n${requirementsBlock(batch)}\n\nPlan the scenarios for these requirements now.` });
    }
    const areas = planAreas(model);
    if (areas.length === 1) {
        calls.push({ quota: max, prompt: `${summary}\n\nPage detail:\n${pageDetail(areas[0]!.pages, elements)}\n\n${constraints(model, opts, max)}` });
    } else {
        const journeyQuota = Math.max(3, Math.ceil(max * 0.2));
        calls.push({
            quota: journeyQuota,
            prompt: `${summary}\n\nPlan now: multi-step end-to-end journeys that cross several areas of the app (start to goal, through several pages). Single-page checks are planned elsewhere.\n\n${constraints(model, opts, journeyQuota)}`,
        });
        for (const area of areas) {
            const quota = Math.max(3, Math.ceil(((max - journeyQuota) * area.pages.length) / model.pages.length));
            calls.push({
                quota,
                prompt: `${summary}\n\nPlan now: the area ${area.name} (${area.pages.length} pages). Other areas and cross-area journeys are planned in other calls.\nPage detail:\n${pageDetail(area.pages, elements)}\n\n${constraints(model, opts, quota)}`,
            });
        }
    }

    // Role scenarios: what one test account can see or do and another cannot (opening a page directly is the access checks' job).
    const roleNames = new Set(opts.roles ?? []);
    if (opts.roleDifferences?.length && roleNames.size > 1) {
        const quota = Math.min(opts.roleDifferences.length * 2, Math.max(3, Math.ceil(max * 0.2)));
        calls.push({
            quota,
            prompt: `${summary}\n\nPlan now: role scenarios. Exploring as each test account showed these differences:\n${opts.roleDifferences.map((d) => `- ${d}`).join("\n")}\n\nFor each difference plan a scenario signed in as the account named (set "role" to exactly that account name and requiresAuth=true) that starts on a page it can reach and asserts what it sees or can do there; for a control only one account sees, also plan one as the other account asserting the control is not shown. Do not plan opening a page by its address to see that it is refused: access checks do that.\n\n${constraints(model, opts, quota)}`,
        });
    }

    const kept: Planned[] = [];
    const titles = new Set<string>();
    const intents = new Set<string>();
    let vague = 0;
    const accept = (list: Planned[]): number => {
        let added = 0;
        for (const raw of list) {
            // Only the project's own account names count as a role; anything else is the project's account.
            const s = raw.role && !roleNames.has(raw.role) ? { ...raw, role: undefined } : raw;
            if (opts.hasCredentials === false && s.requiresAuth && !s.role) continue;
            const t = s.title.trim().toLowerCase();
            const k = intentKey(s);
            if (titles.has(t) || intents.has(k)) continue;
            if (!hasConcreteOutcome(s)) {
                vague++;
                continue;
            }
            titles.add(t);
            intents.add(k);
            // Keep only requirement ids that exist, so coverage can't be inflated by invented ids.
            kept.push({ ...s, requirements: s.requirements.filter((id) => knownIds.has(id)) });
            added++;
        }
        return added;
    };
    let stopped = false;
    /** Runs a round of calls concurrently; a failed call is said in plain words and the others are kept. */
    const round = async (batch: Array<{ prompt: string; quota: number }>) => {
        const results = await mapLimit(batch, ctx.config.CONCURRENCY, (c) =>
            ctx.llm.object({ system: SYSTEM, schema: PlanSchema, maxOutputTokens: Math.min(16_000, 2_000 + 320 * c.quota), purpose: "planning", prompt: c.prompt }),
        );
        const failed = results.flatMap((r) => (r.ok ? [] : [r.error]));
        const ok = results.flatMap((r) => (r.ok ? [r.value.scenarios] : []));
        if (!ok.length && !kept.length && failed.length) throw failed.find(isBudgetExceeded) ?? failed[0];
        let added = 0;
        for (const list of ok) added += accept(list);
        const limit = failed.find(isBudgetExceeded);
        if (limit) stopped = true;
        if (failed.length) {
            const first = limit ?? failed[0];
            const msg = `${first instanceof Error ? first.message : String(first)}: ${failed.length} of ${batch.length} planning call(s) did not finish, so the plan has the ${kept.length} test idea(s) made before that.`;
            opts.warnings?.push(msg);
            ctx.emit({ stage: "planning", kind: limit ? "planning_limit" : "planning_partial", level: "warn", message: msg });
        }
        return added;
    };

    await round(calls);

    // Coverage-gap pass: pages, forms and requirements no scenario touches yet get calls of their own.
    // Requirements are asked again even when the plan is full: they come first, so they push other ideas out.
    for (let r = 0; r < GAP_ROUNDS && !stopped; r++) {
        throwIfAborted(ctx.signal);
        const full = kept.length >= max;
        const transitionGaps: CoverageTarget[] = full ? [] : uncoveredTransitions(model.screenMap, kept, model.origin, model.journeys).map((g) => ({ kind: "transition" as const, ...g }));
        const gaps = full ? [] : [...planCoverage(model, kept).untouched, ...transitionGaps];
        const open = reqs.filter((q) => !kept.some((s) => s.requirements.includes(q.id)));
        if (!gaps.length && !open.length) break;
        const covered = cut(kept.map((s) => `- [${s.category}] ${s.title}`).join("\n"), COVERED_CHARS);
        const batch: Array<{ prompt: string; quota: number }> = [];
        for (let i = 0; i < Math.max(gaps.length, open.length ? 1 : 0); i += GAP_BATCH) {
            const part = gaps.slice(i, i + GAP_BATCH);
            const pages = model.pages.filter((p) => part.some((g) => g.page === bare(p.path)));
            const reqPart = i === 0 && open.length ? `\n\n${requirementsBlock(open)}` : "";
            const quota = Math.max(1, Math.min(max, (full ? 0 : Math.min(max - kept.length, part.length * 2)) + (reqPart ? open.length * 2 : 0)));
            batch.push({
                quota,
                prompt: `${summary}\n\nAlready covered by the plan (do not repeat these):\n${covered}\n\n${part.length ? "Not tested yet — plan scenarios that exercise each of these" : "Not tested yet — the requirements below"}:\n${part.map((g) => `- ${g.label}`).join("\n")}${pages.length ? `\nTheir page detail:\n${pageDetail(pages, elements)}` : ""}${reqPart}\n\n${constraints(model, opts, quota)}`,
            });
        }
        if (!(await round(batch))) break;
    }
    if (vague) ctx.emit({ stage: "planning", kind: "scenarios_vague", level: "warn", message: `${vague} test idea(s) were left out: they had no concrete expected outcome (only "the page loads" or alike).` });

    // Scenarios that verify a requirement come first, so the cap never cuts one of them for another idea.
    const ordered = [...kept.filter((s) => s.requirements.length), ...kept.filter((s) => !s.requirements.length)].slice(0, max);
    const scenarios: Scenario[] = ordered.map((s, i) => ({ ...s, scenarioId: `S-${String(i + 1).padStart(3, "0")}` }));
    const coverage = planCoverage(model, scenarios);
    if (coverage.total) ctx.emit({ stage: "planning", kind: "plan_coverage", message: `Coverage: ${coverage.covered} of ${coverage.total} pages and forms have a test`, data: { covered: coverage.covered, total: coverage.total } });
    for (const s of scenarios) {
        ctx.emit({
            stage: "planning",
            kind: "scenario_planned",
            message: `${s.scenarioId} [${s.category}/${s.priority}] ${s.title}`,
        });
    }
    return scenarios;
}
