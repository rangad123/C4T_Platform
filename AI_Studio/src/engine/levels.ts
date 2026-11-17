/**
 * How much one exploration does. Thorough is the default and the minimum: every request without a level (and every
 * job stored before levels existed) runs as thorough, and explicit page/depth/scenario numbers never go below it.
 * Every count that scales with an exploration reads this table; nobody hard-codes them.
 */
export const LEVELS = ["thorough", "deep", "everything"] as const;
export type ExploreLevel = (typeof LEVELS)[number];

export interface LevelSettings {
    /** Most pages the crawl visits. */
    maxPages: number;
    /** Most clicks away from the start page. */
    maxDepth: number;
    /** Most AI-written test scenarios. */
    maxScenarios: number;
    /** Pages kept per URL pattern (e.g. /product/:id). */
    perPattern: number;
    /** Key pages that get accessibility, health and visual checks (Infinity: every key page). */
    checkPages: number;
    /** Key pages whose forms get unusual-input checks. */
    inputPages: number;
    /** Key pages the AI looks at for visual problems. */
    visionPages: number;
    /**
     * Times the usual number of key pages of one type (e.g. 3 forms, 1 detail page) checks may pick; Infinity: no per-type limit.
     * Without it, the few page types of an application would cap the key pages well below checkPages.
     */
    perTypeScale: number;
    /** Key pages that get page-speed checks. */
    speedPages: number;
    /** API endpoints that get latency checks / workflow steps. */
    apiEndpoints: number;
    /** Most steps the AI takes while writing one test. */
    authoringMaxSteps: number;
    /** How many times a failing new test is repaired. */
    repairAttempts: number;
    /** Elements per page in the digest the AI reads. */
    digestElementsPerPage: number;
    /** AI screen review (visionChecks) is on when the request says nothing, provided the model can read images. */
    visionByDefault: boolean;
    /** Validated web tests replayed with deliberate faults to check they notice breakage (mutation/strength.ts; Infinity: all). */
    strengthTests: number;
    /** Extra runs a newly written web test must pass before it is validated (any failure makes it flaky). */
    repeatPasses: number;
    /** Conditions (validation/variants.ts) the key validated web tests also run under, without being asked. */
    conditionVariants: readonly string[];
    /**
     * One objective-driven exploration session (Phase 3, explore/loop.ts): how many objectives it pursues and what it may spend in all.
     * Inside the level's own limits: the AI calls never exceed what the level's test writing may use (maxScenarios × authoringMaxSteps),
     * and each objective gets at most the objective agent's limits (agent/objective.ts AGENT_LIMITS). Never from the request or the page.
     */
    exploration: Readonly<ExplorationBudgets>;
}

/** The session budgets of objective-driven exploration (the loop's `Budgets`, explore/loop.ts) and each objective's share. */
export interface ExplorationBudgets {
    /** Objectives pursued in one session (each operator of an objective is one pursuit). */
    objectives: number;
    /** Browser actions in the whole session. */
    actions: number;
    /** AI calls in the whole session, counted by the engine. */
    aiCalls: number;
    /** AI tokens (input + output) in the whole session. */
    tokens: number;
    minutes: number;
    /** How often one state may be visited in one pursuit. */
    depth: number;
    /** Per objective: AI minutes and tokens (steps are the level's authoringMaxSteps). */
    perObjective: { minutes: number; tokens: number };
}

export const LEVEL_SETTINGS: Readonly<Record<ExploreLevel, Readonly<LevelSettings>>> = {
    thorough: {
        maxPages: 60,
        maxDepth: 4,
        maxScenarios: 50,
        perPattern: 3,
        checkPages: 12,
        perTypeScale: 1,
        inputPages: 8,
        visionPages: 5,
        speedPages: 8,
        apiEndpoints: 12,
        authoringMaxSteps: 30,
        repairAttempts: 2,
        digestElementsPerPage: 60,
        visionByDefault: false,
        strengthTests: 15,
        repeatPasses: 3,
        conditionVariants: [],
        exploration: { objectives: 25, actions: 25 * 30, aiCalls: 25 * 30, tokens: 25 * 300_000, minutes: 90, depth: 8, perObjective: { minutes: 10, tokens: 300_000 } },
    },
    deep: {
        maxPages: 120,
        maxDepth: 5,
        maxScenarios: 100,
        perPattern: 5,
        checkPages: 24,
        perTypeScale: 2,
        inputPages: 16,
        visionPages: 10,
        speedPages: 16,
        apiEndpoints: 24,
        authoringMaxSteps: 40,
        repairAttempts: 3,
        digestElementsPerPage: 90,
        visionByDefault: true,
        strengthTests: 40,
        repeatPasses: 3,
        conditionVariants: ["dark", "locale"],
        exploration: { objectives: 50, actions: 50 * 40, aiCalls: 50 * 40, tokens: 50 * 300_000, minutes: 150, depth: 10, perObjective: { minutes: 10, tokens: 300_000 } },
    },
    everything: {
        maxPages: 250,
        maxDepth: 6,
        maxScenarios: 150,
        perPattern: 8,
        checkPages: Infinity,
        perTypeScale: Infinity,
        inputPages: Infinity,
        visionPages: Infinity,
        speedPages: Infinity,
        apiEndpoints: Infinity,
        authoringMaxSteps: 50,
        repairAttempts: 4,
        digestElementsPerPage: 120,
        visionByDefault: true,
        strengthTests: Infinity,
        repeatPasses: 5,
        conditionVariants: ["dark", "locale"],
        exploration: { objectives: 100, actions: 100 * 50, aiCalls: 100 * 50, tokens: 100 * 300_000, minutes: 180, depth: 12, perObjective: { minutes: 10, tokens: 300_000 } },
    },
};

export function isLevel(v: unknown): v is ExploreLevel {
    return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** The level an exploration's options ask for; missing or unknown -> thorough. */
export function levelOf(options?: { level?: unknown } | null): ExploreLevel {
    return isLevel(options?.level) ? options.level : "thorough";
}

/** The settings of an exploration's level. */
export function levelSettings(options?: { level?: unknown } | null): Readonly<LevelSettings> {
    return LEVEL_SETTINGS[levelOf(options)];
}

/**
 * The crawl/AI limits a job really uses: the level's numbers, unless the request names larger ones.
 * Explicit numbers never go below thorough's.
 */
export function effectiveLimits(options: { level?: unknown; maxPages?: number; maxDepth?: number; maxScenarios?: number }): {
    maxPages: number;
    maxDepth: number;
    maxScenarios: number;
} {
    const min = LEVEL_SETTINGS.thorough;
    const lv = levelSettings(options);
    const pick = (explicit: number | undefined, level: number, floor: number) =>
        Math.max(floor, Number.isFinite(explicit) ? (explicit as number) : level);
    return {
        maxPages: pick(options.maxPages, lv.maxPages, min.maxPages),
        maxDepth: pick(options.maxDepth, lv.maxDepth, min.maxDepth),
        maxScenarios: pick(options.maxScenarios, lv.maxScenarios, min.maxScenarios),
    };
}

/** First `n` of a list, where Infinity means all of it. */
export function firstN<T>(list: readonly T[], n: number): T[] {
    return Number.isFinite(n) ? list.slice(0, n) : list.slice();
}

/**
 * Whether an exploration runs the AI screen review: an explicit true or false in the request wins; otherwise the level's default,
 * and only when the model can read images (screenshots then go to the person's AI provider).
 */
export function visionOn(options: { level?: unknown; visionChecks?: boolean }, canReadImages: boolean): boolean {
    if (typeof options.visionChecks === "boolean") return options.visionChecks;
    return levelSettings(options).visionByDefault && canReadImages;
}
