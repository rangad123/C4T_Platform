/**
 * Shapes of the phone quality checks (crashes, freezes, start-up time, accessibility of phone screens). Plain data: stored in a plan, in a test's
 * reason, or in a job's events. Android only.
 */
import type { RecordedAction } from "../explore/types.js";

/** One crash or freeze of the app under test, read from the phone's own log (`adb logcat`). Text is cleaned, cut and scrubbed of secrets. */
export interface AppCrash {
    /** crash: a Java/Kotlin exception ended the app; native: the app's process died on a signal; anr: the app stopped responding. */
    kind: "crash" | "native" | "anr";
    /** The package the log line names (the app under test, or one of its processes such as `com.example.app:sync`). */
    package: string;
    /** First line: the exception and its message ("java.lang.IllegalStateException: Cart is null"), the signal, or the ANR reason. */
    exception: string;
    /** The stack trace (or the ANR details), at most MAX_STACK_LINES lines of at most 200 characters. */
    stack: string[];
    /** The phone's clock when it was logged (seconds since 1970, with milliseconds). */
    at: number;
}

/** A cold start of the app, as `am start -W` reports it. */
export interface StartupMeasure {
    /** Time until the first screen was drawn (TotalTime). */
    totalMs: number;
    /** WaitTime, when reported (includes the system's own work). */
    waitMs?: number;
    /** COLD, WARM or HOT when the phone says so (Android 10 and later). */
    launchState?: string;
}

export type PhoneA11yRule = "no-label" | "image-no-description" | "small-target" | "duplicate-label";

export interface PhoneA11yIssue {
    rule: PhoneA11yRule;
    /** low or medium: how much it gets in the way of a person using a screen reader or with limited dexterity. */
    severity: "low" | "medium";
    /** One plain sentence naming the element ("The button “x” is 24 × 24 dp; touch targets should be at least 48 × 48 dp"). */
    message: string;
}

/** The accessibility of one distinct screen. */
export interface ScreenA11y {
    /** Screen id of the exploration (S1, S2...) or a short name in a test run. */
    screen: string;
    title: string;
    /** Elements looked at (things that can be touched or read). */
    checked: number;
    issues: PhoneA11yIssue[];
    /** The screen's density was not reported, so sizes in dp are estimated from its width. */
    densityAssumed?: true;
}

/** A crash or freeze seen while the AI explored the app: what happened, where, and how to get there again. */
export interface ExploreCrash {
    crash: AppCrash;
    /** The screen the app showed just before (id, title and a few of its visible texts). */
    screen: { id: string; title: string; texts: string[] };
    /** What the AI did since the app was last (re)started, in plain lines ("Tapped “Settings”"). */
    steps: string[];
    /** How a test repeats it: the screen it happened on, what was done there first, and the action (absent: it happened without an action). */
    repro?: { screen: string; prelude: RecordedAction[]; action?: RecordedAction };
    /** How many times the same crash was seen in this exploration (absent: once). */
    times?: number;
}

export type QualityTestKind = "crash" | "startup" | "accessibility";

/** A check test the plan creates from a finding: stored as Needs a look with the facts, checked again on the phone whenever it runs. */
export interface QualityTest {
    /** Q-01, Q-02... */
    id: string;
    kind: QualityTestKind;
    title: string;
    /** The finding as it is stored with the test. */
    reason: string;
    /** The test as a spec without its id (the platform gives it one when the person creates it). */
    draft: Record<string, unknown>;
}

/** What a plan keeps of the quality checks of one exploration. */
export interface PhoneQualityPlan {
    crashes: ExploreCrash[];
    startup?: { measure?: StartupMeasure; budgetMs: number; overBudget: boolean; note?: string };
    /** Every distinct screen that was checked (also those without problems). */
    accessibility: ScreenA11y[];
    /** Plain sentences: what could not be checked and why. */
    notes: string[];
    /** The check tests creating the plan makes (accessibility ones only when Accessibility is switched on). */
    tests?: QualityTest[];
    /** Findings that could not be written as a test, with the plain reason. */
    couldNotWrite?: Array<{ title: string; reason: string }>;
}
