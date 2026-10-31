/**
 * First run: the plan an exploration hands back before anything is created, and the words used for it.
 * The numbers come from the platform (GET /api/projects/:id/plans/:jobId); nothing is estimated here except adding up
 * the families a person switched on or off in the plan.
 */
import { plural } from "../../lib/format.js";

/** The switch a kind of test is sent as. A plan for a phone app has kinds of its own, named by the platform, so any word is allowed. */
export type FamilyOption = "web" | "api" | "accessibility" | "healthChecks" | "securityChecks" | "performanceChecks" | "loadChecks" | "inputChecks" | "visionChecks" | "contractChecks" | "accessChecks" | "visual" | (string & {});

export interface PlanFamily {
    id: string;
    label: string;
    about: string;
    /** How many tests it would create. */
    count: number;
    on: boolean;
    option: FamilyOption;
    needs: "web" | "api" | "both" | "mobile";
    note?: string;
    /** A family with a web part and an API part: how many tests each would create. */
    split?: { web: number; api: number };
}

export interface PlanIdea {
    id: string;
    title: string;
    journey: string | null;
    priority: "critical" | "high" | "medium" | "low";
    type: string;
    /** Which kind of test the idea belongs to, when the kind is made of ideas (a phone plan). Absent: a journey. */
    family?: string;
    /** What the test checks, in a sentence (a phone plan). */
    goal?: string;
    /** The screens it goes through, for example ["Home", "Sign in", "Home"] (a phone plan). */
    path?: string[];
}

/** A screen of a phone app that the exploration found. A picture is shown only when the platform gives one. */
export interface PlanScreen {
    name: string;
    path?: string[];
    thumbnail?: string;
}

/** What the platform adds to the plan of an Android app (the `phone` part of the plan answer). */
export interface PhonePart {
    appPackage?: string;
    appName?: string;
    screens: Array<{ id?: string; title: string; kind?: string }>;
    ideas: Array<{ id: string; title: string; goal?: string; family: string; priority: PlanIdea["priority"]; path?: string[]; /** R24: what the idea covers and why ("Covers the Jobs tab."). */ why?: string }>;
    /** Ideas the AI could not turn into a test, with the plain reason. */
    couldNotWrite?: Array<{ title: string; reason: string }>;
    /** Things the AI saw and did not touch, with the plain sentence that says why. */
    skipped?: Array<{ message: string; why?: string }>;
    signInNeeded?: boolean;
    signedIn?: boolean;
    /** Phone reliability: how each test will start (fresh app data, permissions granted), only when that is switched on. */
    startState?: string;
    /** Permission questions the exploration answered; each test starts by giving the same answer if asked. */
    permissionAnswers?: Array<{ question: string; choice: string; step: string }>;
    /** How much of the app the exploration saw and why it stopped (round 24). */
    coverage?: { screens: number; activitiesSeen?: string[]; activitiesListed?: number; actions?: number; aiCalls?: number; stoppedBecause?: string };
}

/** What the platform says about a plan that is not ready yet, and about one that is. */
export type PlanAnswer =
    | { ready: false; jobId: string; status: string }
    | {
          ready: true;
          jobId: string;
          status: string;
          createdAt: string;
          url: string;
          targets: Array<"web" | "api" | "mobile">;
          found: { pages: number; apiEndpoints: number; forms: number; journeys: number; screens?: number };
          about: { siteType: string; purpose: string; features: string[] } | null;
          pages: Array<{ path: string; title: string; type: string }>;
          /** Phone app plans: the screens found, and the app they belong to. */
          screens?: PlanScreen[];
          app?: string;
          /** The platform's own part for a phone plan. `normalizePlan` turns it into the fields around it. */
          phone?: PhonePart;
          /** Phone plans: ideas that could not be written (from `phone.couldNotWrite`), and what was left alone (from `phone.skipped`). */
          couldNotWrite?: Array<{ title: string; reason: string }>;
          skipped?: string[];
          /** Phone app plans: the app asked for a sign-in and no test account was given. */
          signInNeeded?: boolean;
          ideas: PlanIdea[];
          families: PlanFamily[];
          total: number;
          warnings: string[];
          signInDetails: boolean;
          used: { jobId: string } | null;
      };
export type ReadyPlan = Extract<PlanAnswer, { ready: true }>;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The plan of a phone app as the screens use it. The platform sends the phone's own facts in `phone` (screens by title, ideas with their goal, kind and
 * path, what was left alone and why); the kinds of test in `families` are named after them ("phoneSignIn" for the ideas of kind "signIn"). This joins
 * the two, once, so that the rest is the same code as for a website. A plan without `phone` is returned as it is.
 */
export function normalizePlan(a: PlanAnswer): PlanAnswer {
    if (!a.ready || !a.phone) return a;
    const p = a.phone;
    const known = new Map(p.ideas.map((i) => [i.id, i]));
    const ideas: PlanIdea[] = [];
    for (const i of a.ideas) {
        const x = known.get(i.id);
        if (!x) {
            ideas.push(i);
            continue;
        }
        ideas.push({ ...i, family: `phone${cap(x.family)}`, goal: x.why ? `${x.goal ?? ""} ${x.why}`.trim() : x.goal, path: x.path, priority: x.priority ?? i.priority });
        known.delete(i.id);
    }
    // An idea the platform lists only in its phone part still counts and can be left out.
    for (const x of known.values()) ideas.push({ id: x.id, title: x.title, journey: null, priority: x.priority, type: "functional", family: `phone${cap(x.family)}`, goal: x.why ? `${x.goal ?? ""} ${x.why}`.trim() : x.goal, path: x.path });
    return {
        ...a,
        ideas,
        app: a.app ?? p.appName ?? p.appPackage,
        screens: a.screens ?? p.screens.map((s) => ({ name: s.title })),
        signInNeeded: a.signInNeeded ?? (p.signInNeeded === true && p.signedIn !== true),
        couldNotWrite: a.couldNotWrite ?? p.couldNotWrite,
        skipped: a.skipped ?? p.skipped?.map((s) => s.message),
    };
}

/** What a person can change in the plan: kinds of test on or off, and test ideas left out. */
export interface PlanChoice {
    /** option -> on, for every family. */
    switches: Partial<Record<FamilyOption, boolean>>;
    /** Test ideas (ids) left out. */
    left: string[];
}

export const initialChoice = (plan: ReadyPlan): PlanChoice => ({
    switches: Object.fromEntries(plan.families.map((f) => [f.option, f.on])) as PlanChoice["switches"],
    left: [],
});

/**
 * The targets the choice leaves on. Only the API side can be switched off here: leaving every journey out and every web check off
 * already means no web test is created, and the web side keeps what it found.
 */
export function targetsOf(plan: ReadyPlan, c: PlanChoice): ReadyPlan["targets"] {
    return plan.targets.filter((t) => t !== "api" || c.switches.api !== false);
}

/** A plan for a phone app and nothing else: its wording says phone tests and screens. */
export const phoneOnlyPlan = (plan: Pick<ReadyPlan, "targets">): boolean => plan.targets.length > 0 && plan.targets.every((t) => t === "mobile");

/** The test ideas that make up one kind of test: journeys for the one that has no ideas of its own, else the ideas that name it. */
export const ideasOf = (plan: ReadyPlan, f: PlanFamily): PlanIdea[] => plan.ideas.filter((i) => (i.family ?? "journeys") === f.id);
/** Is this kind made of ideas the person can leave out one by one? */
const madeOfIdeas = (plan: ReadyPlan, f: PlanFamily): boolean => f.id === "journeys" || ideasOf(plan, f).length > 0;

/** Is this kind of test on? Journeys are on while at least one test idea is kept. */
export function isOn(plan: ReadyPlan, f: PlanFamily, c: PlanChoice): boolean {
    return madeOfIdeas(plan, f) ? ideasOf(plan, f).some((i) => !c.left.includes(i.id)) : c.switches[f.option] !== false;
}

/** Does this side of the application exist in the plan at all (it was explored)? */
export const explored = (plan: ReadyPlan, needs: PlanFamily["needs"]): boolean => (needs === "web" ? plan.targets.includes("web") : needs === "api" ? plan.targets.includes("api") : needs === "mobile" ? plan.targets.includes("mobile") : true);

/** How many tests one kind of check creates with the choice made. */
export function countOf(plan: ReadyPlan, f: PlanFamily, c: PlanChoice): number {
    const targets = targetsOf(plan, c);
    const web = targets.includes("web");
    const api = targets.includes("api");
    if (f.needs === "mobile") return targets.includes("mobile") ? (madeOfIdeas(plan, f) ? ideasOf(plan, f).filter((i) => !c.left.includes(i.id)).length : f.count) : 0;
    if (f.needs === "web" && !web) return 0;
    if (f.needs === "api" && !api) return 0;
    if (f.needs === "both" && !web && !api) return 0;
    if (madeOfIdeas(plan, f)) return ideasOf(plan, f).filter((i) => !c.left.includes(i.id)).length;
    if (f.split) return (web ? f.split.web : 0) + (api ? f.split.api : 0);
    return f.count;
}

export interface PlanLine {
    id: string;
    label: string;
    count: number;
}

/** The kinds of test that are on and would create something, in the order of the plan. */
export function planLines(plan: ReadyPlan, c: PlanChoice): PlanLine[] {
    return plan.families.filter((f) => isOn(plan, f, c) && explored(plan, f.needs)).map((f) => ({ id: f.id, label: f.label, count: countOf(plan, f, c) })).filter((l) => l.count > 0);
}

export const planTotal = (plan: ReadyPlan, c: PlanChoice): number => planLines(plan, c).reduce((n, l) => n + l.count, 0);

/** "We found 4 pages and 4 API endpoints." Says what was not found, too. */
export function foundSentence(f: ReadyPlan["found"], targets: ReadyPlan["targets"]): string {
    const parts: string[] = [];
    if (targets.includes("mobile")) parts.push(plural(f.screens ?? 0, "screen"));
    if (targets.includes("web")) parts.push(plural(f.pages, "page"));
    if (targets.includes("api") || f.apiEndpoints > 0) parts.push(plural(f.apiEndpoints, "API endpoint"));
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
    const forms = f.forms > 0 ? `, with ${plural(f.forms, "form")}` : "";
    return `We found ${list}${forms}.`;
}

/** "We will create about 15 tests: journeys 2, API checks 6 and security 7." */
export function createSentence(lines: PlanLine[], noun = "test"): string {
    const total = lines.reduce((n, l) => n + l.count, 0);
    if (total === 0) return "Nothing is selected to create yet.";
    // "journeys through the app 2", but "API checks 6": a name that starts with an acronym keeps its capitals.
    const lower = (s: string) => (/^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
    const names = lines.map((l) => `${lower(l.label)} ${l.count}`);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
    return `We will create about ${plural(total, noun)}: ${list}.`;
}

/** The body that confirms the plan with the choice made. Every switch is sent explicitly so what runs is what was shown. */
export function createBody(plan: ReadyPlan, c: PlanChoice): Record<string, unknown> {
    const body: Record<string, unknown> = { targets: targetsOf(plan, c) };
    for (const f of plan.families) {
        if (f.option === "web" || f.option === "api") continue;
        // A kind made of ideas is changed by leaving ideas out, below, not by a switch of its own.
        if (madeOfIdeas(plan, f)) continue;
        body[f.option] = c.switches[f.option] !== false;
    }
    if (c.left.length) body.excludeIdeas = c.left;
    return body;
}

/** The priority of a test idea in a few plain words. */
export const ideaPriority = (p: PlanIdea["priority"]): string => ({ critical: "Critical", high: "High priority", medium: "Medium priority", low: "Low priority" })[p];
