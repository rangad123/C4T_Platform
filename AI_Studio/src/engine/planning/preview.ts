/**
 * The plan an exploration hands back before anything is created: what was found, the test ideas, and how many tests each
 * kind of check would create. Pure: it only reads the application model (what discovery found) and calls the same generators
 * the orchestrator calls in its generation phase, with the same limits, so the numbers shown to a person are the numbers the
 * platform then produces (tests/onboarding-plan.test.ts compares them against a real run).
 *
 * What it cannot know: how many of the browser journeys the AI will manage to author (each is tried in a real browser and
 * some do not work out), and the signed-in speed and visual checks (they need a sign-in that is only tried during creation).
 * Both are said plainly in the answer rather than guessed.
 */
import { generateApiSpecs } from "../api/test-specs.js";
import { generateApiWorkflowSpecs } from "../api/workflows.js";
import { generateA11ySpecs } from "../a11y/specs.js";
import { generateHealthSpecs } from "../health/specs.js";
import { generateAccessSpecs, generateApiAccessSpecs, type ApiAccessRow, type Reach } from "../identity/access.js";
import { generateInputSpecs } from "../inputs/specs.js";
import { generateLatencySpecs } from "../performance/latency.js";
import { generateLoadSpecs, LOAD_MAX_ENDPOINTS } from "../performance/load.js";
import { generatePerformanceSpecs } from "../performance/specs.js";
import { generateSecuritySpecs } from "../security/specs.js";
import type { Scenario } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import { generateVisionSpecs } from "../vision/specs.js";
import { generateVisualSpecs } from "../visual/baseline.js";
import { FAMILY_LABEL, PHONE_FAMILIES, type PhoneFamily, type PhonePlan } from "../mobile/explore/types.js";
import { qualityCounts } from "../mobile/quality/findings.js";

/** What an exploration keeps so that creating the tests can start from it instead of exploring again. */
export interface StoredPlan {
    version: 1;
    createdAt: string;
    /** The application model after discovery and (for the web) understanding. */
    model: AppModel;
    /** Test ideas for browser journeys, as the planner wrote them. Empty for an API-only plan. */
    scenarios: Scenario[];
    /** True when the AI understanding step ran, so site memory may be updated when the tests are created. */
    analysed: boolean;
    /** Only for an Android app explored on a phone: the test ideas with their finished tests (the same function counted them and will create them). */
    mobile?: PhonePlan;
    /** Whether the API description's own `servers` address may receive test traffic (decided during discovery). */
    specBaseTrusted: boolean;
    accessReach: Reach[];
    apiAccess: ApiAccessRow[];
    /** Plain sentences about what could not be planned (for example "the AI model is not set up"). */
    warnings: string[];
}

/** The switches that decide which kinds of check are created; `targets` decides web and API. */
export interface PlanOptions {
    targets: Array<"web" | "api" | "mobile">;
    accessibility?: boolean;
    healthChecks?: boolean;
    securityChecks?: boolean;
    performanceChecks?: boolean;
    loadChecks?: boolean;
    inputChecks?: boolean;
    visionChecks?: boolean;
    contractChecks?: boolean;
    accessChecks?: boolean;
    visual?: boolean;
    allowMutatingApiTests?: boolean;
    performanceBudgets?: string;
    loadBudgets?: string;
    /** Test ideas the person left out (scenarioIds). */
    excludeIdeas?: string[];
    /** The project has an API credential, so load checks may use endpoints that need one. */
    hasCredential?: boolean;
}

export type FamilyId = "phoneStart" | "phoneSignIn" | "phoneNavigation" | "phoneForms" | "phoneLists" | "phoneBack" | "phoneTabs" | "phoneSearch" | "phoneSettings" | "phoneJourneys" | "phoneCrashes" | "phoneStartup" | "phoneAccessibility" | "journeys" | "api" | "contract" | "accessibility" | "health" | "input" | "security" | "performance" | "load" | "visual" | "vision" | "access";

export interface PlanFamily {
    id: FamilyId;
    /** What it is called to a person. */
    label: string;
    /** One sentence: what these tests check. */
    about: string;
    /** How many tests it would create (as far as it can be known; see the module note for journeys). */
    count: number;
    /** On by the options this plan was made with. */
    on: boolean;
    /** The request field that switches it ("web" and "api" are `targets`). */
    option: "web" | "api" | "mobile" | "accessibility" | "healthChecks" | "securityChecks" | "performanceChecks" | "loadChecks" | "inputChecks" | "visionChecks" | "contractChecks" | "accessChecks" | "visual";
    /** Needs a web target / an API target. */
    needs: "web" | "api" | "both" | "mobile";
    /** Plain reason it cannot create anything here, when count is 0 and that is not obvious. */
    note?: string;
    /** For a family that has a web part and an API part: how many tests each part would create (they add up to `count`). */
    split?: { web: number; api: number };
}

/** Defaults of every switch, as the platform applies them when a field is left out. */
const DEFAULT_ON: Record<PlanFamily["option"], boolean> = {
    web: true,
    api: true,
    mobile: true,
    accessibility: true,
    healthChecks: true,
    securityChecks: true,
    performanceChecks: false,
    loadChecks: false,
    inputChecks: true,
    visionChecks: false,
    contractChecks: true,
    accessChecks: true,
    visual: false,
};

function switchOf(o: PlanOptions, option: PlanFamily["option"]): boolean {
    if (option === "web") return o.targets.includes("web");
    if (option === "api") return o.targets.includes("api");
    if (option === "mobile") return o.targets.includes("mobile");
    const v = o[option as keyof PlanOptions];
    return typeof v === "boolean" ? v : DEFAULT_ON[option];
}

const PHONE_ABOUT: Record<PhoneFamily, [FamilyId, string]> = {
    start: ["phoneStart", "Opens the app on the phone and checks that its first screen shows."],
    signIn: ["phoneSignIn", "Signs in with the project's test account and checks the screen that follows."],
    navigation: ["phoneNavigation", "Opens screens the AI reached by tapping and checks that each one shows."],
    forms: ["phoneForms", "Fills in or sends a form as the AI did and checks what the app showed."],
    lists: ["phoneLists", "Opens an item from a list and checks the screen that follows."],
    back: ["phoneBack", "Goes back and checks that the earlier screen shows again."],
    tabs: ["phoneTabs", "Opens each main tab or bottom navigation entry and checks the screen it shows."],
    search: ["phoneSearch", "Searches as the AI did and opens a result, checking each screen on the way."],
    settings: ["phoneSettings", "Opens the settings pages the AI reached and checks that each one shows."],
    journeys: ["phoneJourneys", "Walks a longer path through the app and checks every screen on the way."],
};

/** The families of a phone plan: exact counts, because the finished tests are what creating the plan makes. */
function phoneFamilies(phone: PhonePlan, o: PlanOptions): PlanFamily[] {
    const excluded = new Set(o.excludeIdeas ?? []);
    return PHONE_FAMILIES.flatMap((family): PlanFamily[] => {
        const count = phone.ideas.filter((i) => i.family === family && !excluded.has(i.id)).length;
        if (count === 0) return [];
        const [id, about] = PHONE_ABOUT[family];
        return [{ id, label: FAMILY_LABEL[family], about, count, on: switchOf(o, "mobile"), option: "mobile" as const, needs: "mobile" as const }];
    }).concat(phoneQualityFamilies(phone, o));
}

/**
 * Phone quality findings (mobile/quality) as families with exact counts: crashes and a slow start whenever the exploration saw them; accessibility only
 * when Accessibility was switched on for this plan (it is opt-in for phones: the results are always in the plan's `phone.quality`).
 */
function phoneQualityFamilies(phone: PhonePlan, o: PlanOptions): PlanFamily[] {
    const n = qualityCounts(phone.quality, { accessibility: o.accessibility === true });
    const on = switchOf(o, "mobile");
    const out: PlanFamily[] = [];
    if (n.crash) out.push({ id: "phoneCrashes", label: "App crashes", about: "Repeats what the AI did before the app crashed or stopped responding. Kept as needing a look, with the stack trace.", count: n.crash, on, option: "mobile", needs: "mobile" });
    if (n.startup) out.push({ id: "phoneStartup", label: "Start-up time", about: "Starts the app from cold and checks that its first screen shows within the project's budget.", count: n.startup, on, option: "mobile", needs: "mobile" });
    if (n.accessibility) out.push({ id: "phoneAccessibility", label: "Phone accessibility", about: "Opens each screen that had problems and checks labels for screen readers, touch target sizes and duplicate labels.", count: n.accessibility, on: on && o.accessibility === true, option: "accessibility", needs: "mobile" });
    return out;
}

/** The families of a plan with their counts, computed from what discovery found. */
export function planFamilies(plan: StoredPlan, o: PlanOptions): PlanFamily[] {
    const phone = plan.mobile ? phoneFamilies(plan.mobile, o) : [];
    // A phone-only plan has no pages or endpoints: the web and API checks are not even counted.
    if (plan.mobile && !o.targets.some((t) => t === "web" || t === "api")) return phone;
    return [...webAndApiFamilies(plan, o), ...phone];
}

function webAndApiFamilies(plan: StoredPlan, o: PlanOptions): PlanFamily[] {
    const model = plan.model;
    const excluded = new Set(o.excludeIdeas ?? []);
    const allowMutating = o.allowMutatingApiTests === true;
    const apis = model.apis;
    const hasPages = model.pages.length > 0;

    const apiPlain = generateApiSpecs(apis, { allowMutating, maxPerEndpoint: 6, contractChecks: false }).specs.length;
    const apiWithContract = generateApiSpecs(apis, { allowMutating, maxPerEndpoint: 6, contractChecks: true }).specs.length;
    const workflows = generateApiWorkflowSpecs(apis, { allowMutating, maxWorkflows: 8 }).specs.length;
    const apiAccess = plan.apiAccess.length ? generateApiAccessSpecs(plan.apiAccess).length : 0;
    const webAccess = plan.accessReach.length > 1 ? generateAccessSpecs(plan.accessReach).length : 0;
    const pageSpeed = hasPages ? generatePerformanceSpecs(model, { maxPages: 5, budgets: o.performanceBudgets }).length : 0;
    const latency = generateLatencySpecs(apis, { maxEndpoints: 8, budgets: o.performanceBudgets }).length;
    const load = generateLoadSpecs(apis, { maxEndpoints: LOAD_MAX_ENDPOINTS, budgets: o.loadBudgets, hasCredential: o.hasCredential === true }).length;

    const f = (x: Omit<PlanFamily, "on">): PlanFamily => ({ ...x, on: switchOf(o, x.option) });
    return [
        f({ id: "journeys", label: "Journeys through the app", about: "The AI tries each journey in a real browser, such as searching or signing in, and saves it as a test.", count: plan.scenarios.filter((s) => !isPhoneIdea(s.scenarioId) && !excluded.has(s.scenarioId)).length, option: "web", needs: "web", ...(plan.scenarios.every((s) => isPhoneIdea(s.scenarioId)) ? { note: "No journeys were planned." } : {}) }),
        f({ id: "api", label: "API checks", about: "For each endpoint: a normal request, a request that should be refused, and the shape of the answer. Also a few multi-step flows.", count: apiPlain + workflows, option: "api", needs: "api" }),
        f({ id: "contract", label: "Answers match the documentation", about: "Real API answers are compared with the OpenAPI description: missing fields, wrong types.", count: Math.max(0, apiWithContract - apiPlain), option: "contractChecks", needs: "api", ...(apis.some((a) => a.source === "openapi") ? {} : { note: "No OpenAPI description was found." }) }),
        f({ id: "accessibility", label: "Accessibility", about: "Automatic checks of key pages against WCAG 2.1 AA.", count: hasPages ? generateA11ySpecs(model, { maxPages: 6 }).length : 0, option: "accessibility", needs: "web" }),
        f({ id: "health", label: "Page health", about: "Looks for script errors, failed requests, broken links and insecure content on key pages.", count: hasPages ? generateHealthSpecs(model, { maxPages: 6 }).length : 0, option: "healthChecks", needs: "web" }),
        f({ id: "input", label: "Form input", about: "Tries harmless unusual text in search forms. Forms that send data are only touched if data-changing tests are allowed.", count: hasPages ? generateInputSpecs(model, { maxPages: 4, allowMutating }).length : 0, option: "inputChecks", needs: "web" }),
        f({ id: "security", label: "Basic security", about: "A read-only look at security headers, cookies, exposed files and the HTTPS certificate. Nothing is attacked.", count: generateSecuritySpecs(model).length, option: "securityChecks", needs: "both" }),
        f({ id: "access", label: "Who can open what", about: "Pages and endpoints that one account can open must stay closed to a visitor or a lesser account.", count: webAccess + apiAccess, split: { web: webAccess, api: apiAccess }, option: "accessChecks", needs: "both", ...(plan.accessReach.length > 1 || plan.apiAccess.length ? {} : { note: "Needs test accounts (Library, Accounts)." }) }),
        f({ id: "performance", label: "Speed", about: "Loads key pages three times and times a few safe API endpoints. Takes longer.", count: pageSpeed + latency, split: { web: pageSpeed, api: latency }, option: "performanceChecks", needs: "both" }),
        f({ id: "load", label: "Load", about: "Up to 3 safe API endpoints with 10 people at once. Test environments only.", count: load, option: "loadChecks", needs: "api" }),
        f({ id: "visual", label: "Visual changes", about: "Saves a screenshot of key pages and flags later differences.", count: hasPages ? generateVisualSpecs(model, { maxPages: 6 }).length : 0, option: "visual", needs: "web" }),
        f({ id: "vision", label: "AI screen review", about: "The AI looks at screenshots of key pages. Needs a vision-capable model; screenshots go to your AI provider.", count: hasPages ? generateVisionSpecs(model, { maxPages: 3 }).length : 0, option: "visionChecks", needs: "web" }),
    ];
}

/** Whether a family can create anything for these targets. */
export function familyApplies(fam: Pick<PlanFamily, "needs">, targets: Array<"web" | "api" | "mobile">): boolean {
    if (fam.needs === "mobile") return targets.includes("mobile");
    const web = targets.includes("web");
    const api = targets.includes("api");
    return fam.needs === "web" ? web : fam.needs === "api" ? api : web || api;
}

/** How many tests one family would create for these targets (the parts of a split family that apply). */
export function familyCount(fam: PlanFamily, targets: Array<"web" | "api" | "mobile">): number {
    if (!familyApplies(fam, targets)) return 0;
    return fam.split ? (targets.includes("web") ? fam.split.web : 0) + (targets.includes("api") ? fam.split.api : 0) : fam.count;
}

/** How many tests the plan would create: the families that are switched on and apply to the targets. */
export function planTotal(families: PlanFamily[], targets: Array<"web" | "api" | "mobile">): number {
    return families.filter((x) => x.on).reduce((sum, x) => sum + familyCount(x, targets), 0);
}

/** What discovery found, in numbers a person can read. */
export function planFound(model: AppModel): { pages: number; apiEndpoints: number; forms: number; journeys: number; screens?: number } {
    return { pages: model.pages.length, apiEndpoints: model.apis.length, forms: model.pages.reduce((n, p) => n + p.forms.length, 0), journeys: model.journeys.length, ...(model.mobile ? { screens: model.mobile.screens.length } : {}) };
}

/** A scenario id that belongs to a phone idea (web plans never use the M- prefix). */
const isPhoneIdea = (id: string): boolean => /^M-\d+$/.test(id);
