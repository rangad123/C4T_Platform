/**
 * Shared shapes of AI phone exploration (the explorer loop, the app model, the plan and the tests written from it).
 * Android only. Everything here is plain data: it is stored in the job's application model and in the plan the person approves.
 */
import type { DeviceSession, OpenDeviceOptions } from "../device/types.js";
import type { Locator } from "../../spec/schema.js";
import { DEPTHS, type PhoneDepth } from "../phone-settings.js";

/** The stand-ins a written test types for the project's sign-in details. The real values never leave the machine that owns the phone. */
export const USERNAME_PLACEHOLDER = "{{credentials.username}}";
export const PASSWORD_PLACEHOLDER = "{{credentials.password}}";

/** Opens the conversation with a phone or emulator (this computer's adb, or a runner agent). The platform decides which; the explorer only asks. */
export type DeviceOpener = (opts: OpenDeviceOptions) => Promise<DeviceSession>;

/** Every cap of one exploration. All of them are enforced by the loop, not by the prompt. */
export interface ExploreLimits {
    /** Actions the AI may take in all (refused and failed ones count). */
    maxActions: number;
    /** Wall-clock time of the loop. */
    maxMs: number;
    /** Distinct screens kept; reaching it ends the exploration. */
    maxScreens: number;
    /** Calls to the AI model in all, retries and the planning call included. */
    maxModelCalls: number;
    /** The same action on the same screen this many times in a row is refused the next time. */
    maxIdentical: number;
    /** This many actions in a row without any visible change end the exploration. */
    stallActions: number;
    /** Most in-screen actions (typing, scrolling) kept to replay in front of one navigation. */
    maxPrelude: number;
    /** Most edges (navigations) kept. */
    maxEdges: number;
    /** Most navigations a written test walks through to reach its screen. */
    maxPathEdges: number;
    /** Most test ideas planned. */
    maxIdeas: number;
    // ── the map explorer only (explore/map-explorer.ts); the AI-led loop ignores them ──
    /** This many actions in a row without a new screen or a new activity end the exploration ("the app looks fully explored"). */
    plateauActions?: number;
    /** This many actions in a row without a new screen make the explorer ask the AI once which untried action is most promising. */
    aiStallActions?: number;
    /** Most items of one list opened per screen (a feed is never opened item by item). */
    maxListItems?: number;
    /** Model calls kept for planning the test ideas after the exploration. */
    reserveModelCalls?: number;
}

/** How thorough an exploration is (project setting "How thorough", phone-settings.ts). */
export type ExploreDepth = PhoneDepth;

/**
 * The limits of the map explorer for each depth. Screens, actions, minutes, ideas and AI calls are the numbers the person is told
 * (phone-settings.ts DEPTHS); the rest are how the explorer gets there. The exploration usually ends earlier, on a plateau.
 */
export function depthLimits(depth: ExploreDepth): ExploreLimits & Required<Pick<ExploreLimits, "plateauActions" | "aiStallActions" | "maxListItems" | "reserveModelCalls">> {
    const d = DEPTHS[depth];
    const by = <T>(quick: T, standard: T, thorough: T): T => (depth === "quick" ? quick : depth === "standard" ? standard : thorough);
    return {
        maxActions: d.actions,
        maxMs: d.minutes * 60_000,
        maxScreens: d.screens,
        maxModelCalls: d.aiCalls,
        maxIdentical: 3,
        stallActions: by(12, 15, 20),
        maxPrelude: 8,
        maxEdges: d.actions * 2,
        maxPathEdges: by(6, 8, 10),
        maxIdeas: d.ideas,
        plateauActions: by(50, 80, 150),
        aiStallActions: by(25, 40, 60),
        maxListItems: by(2, 3, 4),
        reserveModelCalls: by(6, 10, 15),
    };
}

export const DEFAULT_LIMITS: ExploreLimits = {
    maxActions: 60,
    maxMs: 12 * 60_000,
    maxScreens: 25,
    maxModelCalls: 100,
    maxIdentical: 3,
    stallActions: 3,
    maxPrelude: 8,
    maxEdges: 200,
    maxPathEdges: 5,
    maxIdeas: 25,
};

/** What the model's view of an element is kept as (no coordinates; text is already cleaned and capped). */
export interface StoredElement {
    cls: string;
    text: string;
    desc: string;
    id: string;
    clickable: boolean;
    scrollable: boolean;
    editable: boolean;
    password: boolean;
    checkable: boolean;
    /** How a written test finds it (undefined: it has no stable name). Chosen against the whole screen it was seen on. */
    loc?: Locator;
    /** Added by PLAN (R24): inside a list or feed. Its text is content that changes by itself, so a test never checks it. */
    inScroll?: true;
}

export type ScreenKind = "start" | "signin" | "form" | "list" | "detail" | "other";

export interface MobileScreen {
    /** S1, S2... in the order the screens were first seen. */
    id: string;
    title: string;
    package: string;
    activity?: string;
    kind: ScreenKind;
    /** Capped and cleaned; password fields carry no text. */
    elements: StoredElement[];
    visits: number;
    /** Has an input and a button that sends it. */
    hasForm: boolean;
    scrollable: boolean;
    // ── added by the map explorer (graph.ts); absent on screens of the AI-led loop ──
    /** Structural fingerprint (device/uiautomator.ts fingerprintOf): the same for a scrolled or refreshed feed. */
    fingerprint?: string;
    /** Fingerprints WITH text of the first few times the screen was seen (evidence; at most 5). */
    textFingerprints?: string[];
    /** The heading of the screen's toolbar or top bar, when it has one (static text, cleaned). */
    toolbarTitle?: string;
    /** The selected tab of the screen's tab bar or bottom navigation, when one is selected. */
    selectedTab?: string;
    /** The labels of the screen's tabs or bottom navigation entries (main navigation), in reading order. */
    tabs?: string[];
    /** The name the AI gave the screen at the end of the exploration (a few words), when it was asked. */
    aiName?: string;
    /** Fewest recorded navigations from the first screen (0 for the first screen; absent when it was only reached by going back). */
    depth?: number;
    /** Safe actions on the screen that were never tried (0 = everything on it was tried). */
    untried?: number;
}

/** One thing the AI did that a written test can repeat. The element is described by how a test finds it, never by position. */
export type RecordedAction =
    | { kind: "tap"; screen: string; label: string; loc?: Locator }
    | { kind: "type"; screen: string; label: string; loc?: Locator; /** Harmless test data or a {{credentials.*}} placeholder; never a real secret. */ text: string }
    | { kind: "scroll"; direction: "up" | "down" | "left" | "right" }
    | { kind: "back" }
    | { kind: "hideKeyboard" }
    | { kind: "wait"; ms: number };

/** The app moved from one screen to another. `prelude` is what was done on the first screen before the action that left it. */
export interface Edge {
    id: string;
    from: string;
    to: string;
    prelude: RecordedAction[];
    action: RecordedAction;
    /** More was done on the screen than a test replays in front of one step: a path through this edge is not offered. */
    incomplete?: true;
    // ── added by the map explorer (graph.ts) ──
    /** What kind of control the action used: main navigation (tab), a menu entry, a list item, a button, a form, signing in, going back. */
    via?: EdgeVia;
    /** Replaying the edge did not lead to the same screen (twice): a path through it is not trusted. */
    unreliable?: true;
    /** How often the explorer replayed the edge to reach a screen, and how often that failed. */
    replays?: { ok: number; failed: number };
}

/** What kind of control an edge's action used (map explorer). */
export type EdgeVia = "tab" | "menu" | "list-item" | "button" | "form" | "sign-in" | "back";

/**
 * A tap on the button of a form that stayed on the same screen and showed something new (an error message, a confirmation): the expected
 * result of a form test is what was really shown. `filled` is whether the fields were filled before the tap.
 */
export interface Submit {
    screen: string;
    filled: boolean;
    /** What was typed on the screen before the tap. */
    prelude: RecordedAction[];
    tap: RecordedAction;
    /** Texts that appeared (cleaned, capped), the facts the test checks. */
    shown: Array<{ text: string; loc?: Locator }>;
}

export interface SkipNote {
    /** Plain sentence, as it appears in the job's events. */
    message: string;
    why: "destructive" | "payment" | "sending" | "calling" | "social" | "data-change" | "outside-app" | "loop" | "sign-in" | "invalid";
}

export interface MobileAppModel {
    appPackage: string;
    /** First screen after the app was started. */
    start: string;
    screens: MobileScreen[];
    edges: Edge[];
    submits: Submit[];
    /** A sign-in screen was found and no sign-in details were given (or the details were not accepted). */
    signInNeeded: boolean;
    /** Sign-in details were given and a sign-in screen was filled with them. */
    signedIn: boolean;
    skipped: SkipNote[];
    stats: {
        actions: number;
        modelCalls: number;
        durationMs: number;
        stoppedBecause: string;
        /** Set when an AI usage limit (see AI usage budgets) ended the exploration: the limit's own sentence. */ aiLimit?: string;
        /** Why it stopped, as a kind (map explorer): "explored" and "plateau" mean the app looks fully explored; the rest are limits. */
        stop?: StopKind;
    };
    /** Permission questions answered while the app was being opened: each written test starts by giving the same answer if asked (mobile/state/permission-step.ts). */
    permissions?: Array<{ question: string; choice: string; allowed: boolean }>;
    /** How much of the app the exploration saw (map explorer; see graph.ts). */
    coverage?: ExploreCoverage;
    /** The phone or emulator the exploration used, so the tests written from it run on the same one. */
    device?: ExploreDevice;
}

/** Why a map exploration ended. */
export type StopKind = "explored" | "plateau" | "screens" | "actions" | "time" | "ai-limit" | "outside-app" | "app-closed";

/** How much of the app an exploration saw: the numbers the job and the plan show. */
export interface ExploreCoverage {
    depth: ExploreDepth;
    screens: number;
    /** Activities of the app the explorer was on (short names, at most 200). */
    activitiesSeen: string[];
    /** Activities the phone lists for the app (`dumpsys package`: the ones with intent filters; a lower bound of what the app declares). Absent when unknown. */
    activitiesListed?: number;
    actions: number;
    aiCalls: number;
    /** Distinct actions tried, and safe ones left untried when it ended. */
    actionsTried: number;
    actionsLeft: number;
    stop: StopKind;
    stoppedBecause: string;
    /** Edges that did not replay. */
    unreliableEdges: number;
}

export interface ExploreDevice {
    serial?: string;
    model?: string;
    emulator?: boolean;
    /** "CPH2467 (R58N20ABCDE)" as the session names it. */
    name: string;
}

/** The families of test a plan counts (labels live in planning/preview.ts). */
/** R24 (PLAN) added: tabs (each main tab), search (search and open a result), settings (settings sub-pages), journeys (longer paths). */
export type PhoneFamily = "start" | "navigation" | "forms" | "signIn" | "lists" | "back" | "tabs" | "search" | "settings" | "journeys";

export const PHONE_FAMILIES: readonly PhoneFamily[] = ["start", "signIn", "tabs", "navigation", "lists", "search", "forms", "settings", "journeys", "back"];

/** What a person calls each family. */
export const FAMILY_LABEL: Record<PhoneFamily, string> = {
    start: "App start",
    signIn: "Signing in",
    navigation: "Moving between screens",
    forms: "Forms",
    lists: "Lists and details",
    back: "Going back",
    tabs: "Main navigation",
    search: "Searching",
    settings: "Settings pages",
    journeys: "Longer journeys",
};

/** A test idea the exploration can really write: the path, the checks and the finished steps. */
export interface PhoneIdea {
    /** M-01, M-02... (the scenario id of the plan). */
    id: string;
    family: PhoneFamily;
    title: string;
    goal: string;
    priority: "critical" | "high" | "medium" | "low";
    /** Screen titles from the first screen to the one under test. */
    path: string[];
    usesSignIn: boolean;
    /** The test as a spec without its id; the platform gives it one when the person creates it. */
    draft: Record<string, unknown>;
    /** Added by PLAN (R24): what the test covers and why it is in the plan, in a sentence ("Covers the Jobs tab and a job's details."). */
    why?: string;
    /** Added by PLAN (R24): the screens it goes through or checks, by name. */
    covers?: string[];
}

/** What a plan keeps for a phone exploration. */
export interface PhonePlan {
    appPackage: string;
    appName: string;
    ideas: PhoneIdea[];
    /** Ideas that could not be written, with the plain reason. */
    dropped: Array<{ title: string; reason: string }>;
    /** Added by PQ: what the phone quality checks found while exploring (crashes, start-up time, accessibility) and the check tests made of it. */
    quality?: import("../quality/types.js").PhoneQualityPlan;
}
