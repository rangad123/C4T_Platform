/**
 * Shapes of the in-app guide content. Fixed here so the screens (Help panel, Guide page, tour) and the written content can be built in parallel.
 * All text is plain language for someone who has never tested software: short sentences, no jargon without a gloss, the product's own
 * words (Passing, Failing, Needs a look, Not run yet, Exploration, Run, Shared elements, Reusable steps, Runner, Code test, Repair, Auto-fix, Run sequence).
 */

/** The places a link in the guide can open. The screens resolve these with the router builders in `web/src/lib/router.ts`. */
export type WhereTo = {
    place: "projects" | "new-project" | "settings" | "overview" | "tests" | "runs" | "library" | "release" | "setup";
    /** The section inside a place (for example "schedules" in runs), exactly as the page's `?section=` value. */
    section?: string;
};

export type GroupId = "making" | "one-test" | "running" | "checks" | "big-picture" | "connect" | "platform";

export interface GuideStep {
    /** One short instruction, verb first. Button, tab and menu names are written exactly as on screen. */
    text: string;
    /** The on-screen names used in `text` (verbatim), so a test can confirm they exist in the web code. */
    ui?: string[];
}

export interface Topic {
    /** Stable kebab-case id, used in the address (`#/guide/<id>`). */
    id: string;
    group: GroupId;
    /** A short plain title, for example "Run tests every night". */
    title: string;
    /** What it is, in one plain sentence. */
    what: string;
    /** Why you would use it, in one line. */
    why: string;
    /** 2 to 6 short steps. May be empty for a pure explanation. */
    steps: GuideStep[];
    /** Honest limits and things to watch for, each one short. */
    goodToKnow?: string[];
    /** Where to do it in the app (needs a project for most places: the screens fill that in). */
    open?: { label: string; to: WhereTo };
    /** Glossary ids used in this topic. */
    words?: string[];
    /** Related topic ids. */
    related?: string[];
    /** Words a person might type to find it ("nightly", "cron", "schedule", "broken button"). */
    keywords?: string[];
    /** A deeper technical document in the repository, for example "docs/features/schedules.md". */
    moreDoc?: string;
}

export interface GlossaryEntry {
    id: string;
    term: string;
    /** One plain sentence, with an everyday comparison where it helps. */
    meaning: string;
    alsoCalled?: string[];
}

/** The "I want to..." chooser: plain goals, each pointing at one topic. */
export interface Want {
    text: string;
    topic: string;
}

export const GROUP_TITLES: Record<GroupId, string> = {
    making: "Making tests",
    "one-test": "Looking after one test",
    running: "Running tests",
    checks: "What the platform checks besides clicks",
    "big-picture": "Seeing the big picture",
    connect: "Connecting other tools",
    platform: "Looking after the platform",
};
