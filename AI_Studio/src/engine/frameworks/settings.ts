/**
 * Per-project framework settings: the few things that genuinely change how a project's tests run, with defaults equal to what the
 * platform always did. Pure (no database, no network): the schema, defaults, clamping, merge, and the decision "what would a run
 * use here" (`effectiveSettings`). The store lives in src/platform/framework-settings-store.ts, the part that applies the values to
 * a run in settings-executor.ts.
 *
 * What is deliberately NOT a setting:
 *  - Retries. A retry hides a flaky test; the platform reports flakiness instead (see docs/features/framework-settings.md).
 *  - The Windows application allow-list. It stays on the computer that runs the tests (a project must not widen it).
 *  - Headed browsers on the platform host. Headed is for a person watching a run on a runner agent.
 */
import { z } from "zod";
import { SIMULATOR_NAME } from "../mobile/target.js";

export const FRAMEWORK_IDS = ["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

/** Plain names for messages ("Android tests are turned off for this project"). */
export const FRAMEWORK_NOUN: Record<FrameworkId, string> = {
    playwright: "Web",
    "playwright-api": "API",
    taqwright: "Android",
    "windows-uia": "Windows desktop",
    "taqwright-ios": "iOS",
};

export const LIMITS = {
    /** Per-test time limit, seconds. */
    timeoutSeconds: { min: 30, max: 300 },
    /** Parallel browser processes. The platform's own CONCURRENCY (at most 8) is the upper bound a run really uses. */
    workers: { min: 1, max: 8 },
    /** How long a Windows application may take to show its window, seconds. */
    startTimeoutSeconds: { min: 5, max: 60 },
} as const;

export interface FrameworkSettings {
    enabled: Record<FrameworkId, boolean>;
    web: {
        /** false = headed (a visible window). Only honoured when the run executes on a runner agent. */
        headless: boolean;
        /** null = the platform's own value (CONCURRENCY). A number can only lower it. */
        workers: number | null;
        testTimeoutSeconds: number;
    };
    api: { testTimeoutSeconds: number };
    android: {
        keepEmulator: boolean;
        /** "" = today's resolution (the project's app emulator, MOBILE_AVD, then the first one found). */
        defaultAvd: string;
        testTimeoutSeconds: number;
    };
    windows: { testTimeoutSeconds: number; startTimeoutSeconds: number };
    ios: {
        /** "" = the app's own simulator, else a booted one, else the first available one on the Mac. */
        defaultSimulator: string;
        keepSimulator: boolean;
        testTimeoutSeconds: number;
    };
}

/** What the platform did before this feature existed (golden: a test compares it with the runner's own numbers). */
export const DEFAULT_FRAMEWORK_SETTINGS: Readonly<FrameworkSettings> = Object.freeze({
    enabled: Object.freeze({ playwright: true, "playwright-api": true, taqwright: true, "windows-uia": true, "taqwright-ios": true }),
    web: Object.freeze({ headless: true, workers: null, testTimeoutSeconds: 60 }),
    api: Object.freeze({ testTimeoutSeconds: 60 }),
    android: Object.freeze({ keepEmulator: false, defaultAvd: "", testTimeoutSeconds: 180 }),
    windows: Object.freeze({ testTimeoutSeconds: 120, startTimeoutSeconds: 15 }),
    ios: Object.freeze({ defaultSimulator: "", keepSimulator: false, testTimeoutSeconds: 180 }),
}) as Readonly<FrameworkSettings>;

export const defaultFrameworkSettings = (): FrameworkSettings => structuredClone(DEFAULT_FRAMEWORK_SETTINGS) as FrameworkSettings;

// ── input ────────────────────────────────────────────────────────────────────

const num = (label: string) => z.number({ error: `${label} must be a number.` }).finite(`${label} must be a number.`);
const flag = (label: string) => z.boolean({ error: `${label} must be on or off.` });

/** A partial update: every group and field is optional; unknown fields are refused (a typo must not be silently ignored). */
export const FrameworkSettingsInput = z
    .object({
        enabled: z.object({ playwright: flag("Web tests"), "playwright-api": flag("API tests"), taqwright: flag("Android tests"), "windows-uia": flag("Windows desktop tests"), "taqwright-ios": flag("iOS tests") }).partial().strict(),
        web: z.object({ headless: flag("Headless"), workers: num("Workers").nullable(), testTimeoutSeconds: num("The web test time limit") }).partial().strict(),
        api: z.object({ testTimeoutSeconds: num("The API test time limit") }).partial().strict(),
        android: z.object({ keepEmulator: flag("Keep the emulator running"), defaultAvd: z.string({ error: "The emulator name must be text." }).trim().max(64, "The emulator name is too long."), testTimeoutSeconds: num("The Android test time limit") }).partial().strict(),
        windows: z.object({ testTimeoutSeconds: num("The Windows test time limit"), startTimeoutSeconds: num("The start time limit") }).partial().strict(),
        ios: z
            .object({
                keepSimulator: flag("Keep the simulator running"),
                defaultSimulator: z.string({ error: "The simulator name must be text." }).trim().max(64, "The simulator name is too long.").refine((v) => v === "" || SIMULATOR_NAME.test(v), "The simulator name has characters that are not allowed."),
                testTimeoutSeconds: num("The iOS test time limit"),
            })
            .partial()
            .strict(),
    })
    .partial()
    .strict();
export type FrameworkSettingsInput = z.infer<typeof FrameworkSettingsInput>;

const clampInt = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

/** Plain-language list of what clamping changed, so the API can say so. */
export interface Clamped {
    settings: FrameworkSettings;
    adjusted: string[];
}

/**
 * Put every number in its allowed range (rounding to whole numbers). Never throws: a value outside the range is moved to the nearest
 * allowed one and described in `adjusted` ("The web test time limit was set to 300 seconds, the most allowed.").
 */
export function clampSettings(s: FrameworkSettings): Clamped {
    const adjusted: string[] = [];
    const bound = (label: string, v: number, min: number, max: number, unit: string, set: (n: number) => void) => {
        const c = clampInt(v, min, max);
        if (v > max || v < min) adjusted.push(`${label} was set to ${c}${unit}, the ${v > max ? "most" : "least"} allowed.`);
        set(c);
    };
    const out = structuredClone(s);
    bound("The web test time limit", s.web.testTimeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, " seconds", (n) => (out.web.testTimeoutSeconds = n));
    bound("The API test time limit", s.api.testTimeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, " seconds", (n) => (out.api.testTimeoutSeconds = n));
    bound("The Android test time limit", s.android.testTimeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, " seconds", (n) => (out.android.testTimeoutSeconds = n));
    bound("The iOS test time limit", s.ios.testTimeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, " seconds", (n) => (out.ios.testTimeoutSeconds = n));
    bound("The Windows test time limit", s.windows.testTimeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, " seconds", (n) => (out.windows.testTimeoutSeconds = n));
    bound("The start time limit", s.windows.startTimeoutSeconds, LIMITS.startTimeoutSeconds.min, LIMITS.startTimeoutSeconds.max, " seconds", (n) => (out.windows.startTimeoutSeconds = n));
    if (s.web.workers !== null) bound("The number of workers", s.web.workers, LIMITS.workers.min, LIMITS.workers.max, "", (n) => (out.web.workers = n));
    out.android.defaultAvd = s.android.defaultAvd.trim();
    out.ios.defaultSimulator = s.ios.defaultSimulator.trim();
    return { settings: out, adjusted };
}

/** `base` with the fields of `patch` laid over it (groups merge field by field). Does not clamp. */
export function mergeSettings(base: FrameworkSettings, patch: FrameworkSettingsInput): FrameworkSettings {
    const out = structuredClone(base);
    Object.assign(out.enabled, patch.enabled ?? {});
    Object.assign(out.web, patch.web ?? {});
    Object.assign(out.api, patch.api ?? {});
    Object.assign(out.android, patch.android ?? {});
    Object.assign(out.windows, patch.windows ?? {});
    Object.assign(out.ios, patch.ios ?? {});
    return out;
}

/**
 * Read what was stored (or sent). Anything that does not fit is ignored field by field and replaced by the default, so a stored value
 * from an older or damaged row can never stop a run.
 */
export function normalizeSettings(raw: unknown): FrameworkSettings {
    const base = defaultFrameworkSettings();
    const parsed = FrameworkSettingsInput.safeParse(raw);
    if (parsed.success) return clampSettings(mergeSettings(base, parsed.data)).settings;
    // Field by field: keep whatever is valid.
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    for (const group of ["enabled", "web", "api", "android", "windows", "ios"] as const) {
        const g = o[group];
        if (!g || typeof g !== "object") continue;
        for (const key of Object.keys(g)) {
            const one = FrameworkSettingsInput.safeParse({ [group]: { [key]: g[key] } });
            if (one.success) Object.assign(base, mergeSettings(base, one.data));
        }
    }
    return clampSettings(base).settings;
}

/** A readable message for the first problem of a refused update. */
export function inputProblem(error: z.ZodError): string {
    const issue = error.issues[0];
    if (!issue) return "These settings could not be read.";
    if (issue.code === "unrecognized_keys") return `Unknown setting: ${issue.keys.join(", ")}.`;
    return issue.message && issue.message !== "Required" ? issue.message : `The setting ${issue.path.join(".")} is not valid.`;
}

export const sameSettings = (a: FrameworkSettings, b: FrameworkSettings): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── what a run would use ─────────────────────────────────────────────────────

export interface RunContext {
    /** The project's tests run on a runner agent (a person can watch them there). */
    onAgent: boolean;
    /** The platform's own CONCURRENCY. */
    platformWorkers: number;
}

export interface EffectiveSettings {
    enabled: Record<FrameworkId, boolean>;
    /** `workers`: what a run would use. `workersLimit`: the cap the project set (null = none; the platform's own value applies). */
    web: { headless: boolean; workers: number; workersLimit: number | null; testTimeoutSeconds: number };
    api: { testTimeoutSeconds: number };
    android: { keepEmulator: boolean; defaultAvd: string; testTimeoutSeconds: number };
    windows: { testTimeoutSeconds: number; startTimeoutSeconds: number };
    ios: { keepSimulator: boolean; defaultSimulator: string; testTimeoutSeconds: number };
    /** Things that were changed by the place the run executes ("Headed runs only happen on a runner agent"). */
    notes: string[];
}

/** The values a run would use after clamping and after the constraints of where it runs (headed only on an agent, workers at most the platform's). */
export function effectiveSettings(settings: FrameworkSettings, ctx: RunContext): EffectiveSettings {
    const s = clampSettings(settings).settings;
    const notes: string[] = [];
    const platformWorkers = clampInt(ctx.platformWorkers, LIMITS.workers.min, LIMITS.workers.max);
    let workers = platformWorkers;
    if (s.web.workers !== null) {
        workers = Math.min(s.web.workers, platformWorkers);
        if (s.web.workers > platformWorkers) notes.push(`This server allows ${platformWorkers} browser worker${platformWorkers === 1 ? "" : "s"} at most, so ${platformWorkers} will be used.`);
    }
    let headless = s.web.headless;
    if (!headless && !ctx.onAgent) {
        headless = true;
        notes.push("Headed browsers only open on a runner agent. While this project runs on this server, the browser runs without a window.");
    }
    return {
        enabled: { ...s.enabled },
        web: { headless, workers, workersLimit: s.web.workers === null ? null : workers, testTimeoutSeconds: s.web.testTimeoutSeconds },
        api: { ...s.api },
        android: { ...s.android },
        windows: { ...s.windows },
        ios: { ...s.ios },
        notes,
    };
}

/** The message for a framework that is switched off (also used by the API and the engine). */
export const turnedOffMessage = (id: FrameworkId): string => `${FRAMEWORK_NOUN[id]} tests are turned off for this project. Turn them on under Runners, Frameworks.`;

/** The first disabled framework among `ids`, as a plain message, or undefined. */
export function firstTurnedOff(settings: Pick<FrameworkSettings, "enabled">, ids: readonly string[]): string | undefined {
    for (const id of ids) if ((FRAMEWORK_IDS as readonly string[]).includes(id) && settings.enabled[id as FrameworkId] === false) return turnedOffMessage(id as FrameworkId);
    return undefined;
}

/** Plain words for every setting that differs from the defaults (empty = a run is exactly what it always was). */
export function describeDeviations(settings: FrameworkSettings, eff: EffectiveSettings): string[] {
    const d = DEFAULT_FRAMEWORK_SETTINGS;
    const out: string[] = [];
    for (const id of FRAMEWORK_IDS) if (!settings.enabled[id]) out.push(`${FRAMEWORK_NOUN[id].toLowerCase()} tests turned off`);
    if (!eff.web.headless) out.push("a visible browser window");
    if (eff.web.workersLimit !== null) out.push(`at most ${eff.web.workersLimit} browser worker${eff.web.workersLimit === 1 ? "" : "s"}`);
    if (eff.web.testTimeoutSeconds !== d.web.testTimeoutSeconds) out.push(`a ${eff.web.testTimeoutSeconds} s test timeout for web tests`);
    if (eff.api.testTimeoutSeconds !== d.api.testTimeoutSeconds) out.push(`a ${eff.api.testTimeoutSeconds} s test timeout for API tests`);
    if (eff.android.testTimeoutSeconds !== d.android.testTimeoutSeconds) out.push(`a ${eff.android.testTimeoutSeconds} s test timeout for Android tests`);
    if (eff.android.keepEmulator) out.push("the emulator kept running");
    if (eff.android.defaultAvd) out.push(`the emulator ${eff.android.defaultAvd}`);
    if (eff.windows.testTimeoutSeconds !== d.windows.testTimeoutSeconds) out.push(`a ${eff.windows.testTimeoutSeconds} s test timeout for Windows tests`);
    if (eff.windows.startTimeoutSeconds !== d.windows.startTimeoutSeconds) out.push(`a ${eff.windows.startTimeoutSeconds} s start timeout for Windows applications`);
    if (eff.ios.testTimeoutSeconds !== d.ios.testTimeoutSeconds) out.push(`a ${eff.ios.testTimeoutSeconds} s test timeout for iOS tests`);
    if (eff.ios.keepSimulator) out.push("the simulator kept running");
    if (eff.ios.defaultSimulator) out.push(`the simulator ${eff.ios.defaultSimulator}`);
    return out;
}

/** A one-line summary of a change for the log: which fields moved. */
export function describeChange(before: FrameworkSettings, after: FrameworkSettings): string {
    const parts: string[] = [];
    for (const id of FRAMEWORK_IDS) if (before.enabled[id] !== after.enabled[id]) parts.push(`${FRAMEWORK_NOUN[id]} tests ${after.enabled[id] ? "turned on" : "turned off"}`);
    const field = (label: string, a: unknown, b: unknown, fmt: (v: any) => string = String) => {
        if (a !== b) parts.push(`${label} ${fmt(a)} to ${fmt(b)}`);
    };
    field("Browser", before.web.headless, after.web.headless, (v) => (v ? "hidden" : "visible"));
    field("Workers", before.web.workers, after.web.workers, (v) => (v === null ? "platform value" : String(v)));
    field("Web time limit", before.web.testTimeoutSeconds, after.web.testTimeoutSeconds, (v) => `${v} s`);
    field("API time limit", before.api.testTimeoutSeconds, after.api.testTimeoutSeconds, (v) => `${v} s`);
    field("Keep emulator", before.android.keepEmulator, after.android.keepEmulator, (v) => (v ? "on" : "off"));
    field("Default emulator", before.android.defaultAvd, after.android.defaultAvd, (v) => (v ? String(v) : "automatic"));
    field("Android time limit", before.android.testTimeoutSeconds, after.android.testTimeoutSeconds, (v) => `${v} s`);
    field("Windows time limit", before.windows.testTimeoutSeconds, after.windows.testTimeoutSeconds, (v) => `${v} s`);
    field("Windows start limit", before.windows.startTimeoutSeconds, after.windows.startTimeoutSeconds, (v) => `${v} s`);
    field("Keep simulator", before.ios.keepSimulator, after.ios.keepSimulator, (v) => (v ? "on" : "off"));
    field("Default simulator", before.ios.defaultSimulator, after.ios.defaultSimulator, (v) => (v ? String(v) : "automatic"));
    field("iOS time limit", before.ios.testTimeoutSeconds, after.ios.testTimeoutSeconds, (v) => `${v} s`);
    return parts.join("; ") || "Saved with no changes";
}
