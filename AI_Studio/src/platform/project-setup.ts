/**
 * What a project tests and how (US-010, D-12, D-19, D-21; migration slot 35): its platforms (web, Android, iOS), its testing modes
 * (agent: the AI explores and writes or runs; code: scripts written or recorded), and the code engines, which follow from the
 * platforms and are never chosen by hand (Playwright for web, Taqwright for Android and iOS).
 *
 * The three are stored as JSON text on `projects`. They decide what AI Studio asks for and warns about (the setup check below);
 * they never delete or hide data: turning a platform or mode off leaves every test of that kind in place and listed.
 *
 * `c4t_project_id` is the optional reference to a Crowd4Test project of the same organisation (US-011, D-27). It grants nobody access.
 */
import { z } from "zod";

export const PLATFORMS = ["web", "android", "ios"] as const;
export const TESTING_MODES = ["agent", "code"] as const;
export type ProjectPlatform = (typeof PLATFORMS)[number];
export type TestingMode = (typeof TESTING_MODES)[number];
export interface CodeEngines {
    web?: "playwright";
    mobile?: "taqwright";
}

export const DEFAULT_PLATFORMS: ProjectPlatform[] = ["web"];
/** A row from before slot 35 reads as both modes (what it had then); a new project left without a mode gets agent mode. */
export const DEFAULT_TESTING_MODES: TestingMode[] = ["agent", "code"];
export const NEW_PROJECT_TESTING_MODES: TestingMode[] = ["agent"];

/**
 * Round 37: a project has exactly one platform and one testing mode. New choices are refused with more than one; a project made
 * before keeps the several it has (nothing is changed on upgrade) until its settings are saved with one choice.
 */
export const ONE_PLATFORM = "A project tests one platform. Choose web, android or ios.";
export const ONE_TESTING_MODE = "A project has one testing mode. Choose agent or code.";

/**
 * Portable SQL only (POSTGRES_S3_MIGRATION.md §1.2, §5.3). Existing projects get web and both modes; a project whose latest
 * application carries a mobile app also gets Android or iOS (or both) and Taqwright. The JSON is matched as text with LIKE (no
 * json_extract): config_json is written by JSON.stringify, so the keys appear exactly as `"appPackage":"`, and only the mobile
 * target has these keys.
 */
const LATEST_CONFIG = "(SELECT a.config_json FROM applications a WHERE a.project_id = projects.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1)";
export const PROJECT_SETUP_MIGRATION = `
ALTER TABLE projects ADD COLUMN platforms TEXT NOT NULL DEFAULT '["web"]';
ALTER TABLE projects ADD COLUMN testing_modes TEXT NOT NULL DEFAULT '["agent","code"]';
ALTER TABLE projects ADD COLUMN code_engines TEXT NOT NULL DEFAULT '{"web":"playwright"}';
ALTER TABLE projects ADD COLUMN c4t_project_id TEXT;
UPDATE projects SET platforms = '["web","android"]', code_engines = '{"web":"playwright","mobile":"taqwright"}'
    WHERE ${LATEST_CONFIG} LIKE '%"appPackage":"%' OR ${LATEST_CONFIG} LIKE '%"apkPath":"%';
UPDATE projects SET platforms = CASE WHEN platforms = '["web","android"]' THEN '["web","android","ios"]' ELSE '["web","ios"]' END,
    code_engines = '{"web":"playwright","mobile":"taqwright"}'
    WHERE ${LATEST_CONFIG} LIKE '%"iosBundleId":"%';
`;

/** In catalogue order, without repeats. */
const ordered = <T extends string>(all: readonly T[], picked: readonly T[]): T[] => all.filter((x) => picked.includes(x));

/** The engines that follow from the platforms (D-12). */
export function codeEnginesFor(platforms: readonly ProjectPlatform[]): CodeEngines {
    return {
        ...(platforms.includes("web") ? { web: "playwright" as const } : {}),
        ...(platforms.includes("android") || platforms.includes("ios") ? { mobile: "taqwright" as const } : {}),
    };
}

export const PlatformsSchema = z
    .array(z.string(), { error: "Platforms are a list, such as [\"web\", \"android\"]." })
    .max(PLATFORMS.length * 2)
    .superRefine((list, ctx) => {
        const unknown = list.find((x) => !(PLATFORMS as readonly string[]).includes(x));
        if (unknown !== undefined) ctx.addIssue({ code: "custom", message: `"${String(unknown).slice(0, 40)}" is not a platform. Choose web, android or ios.` });
        else if (list.length === 0) ctx.addIssue({ code: "custom", message: "Choose at least one platform." });
        else if (new Set(list).size > 1) ctx.addIssue({ code: "custom", message: ONE_PLATFORM });
    })
    .transform((list) => ordered(PLATFORMS, list as ProjectPlatform[]));

export const TestingModesSchema = z
    .array(z.string(), { error: "Testing modes are a list, such as [\"agent\", \"code\"]." })
    .max(TESTING_MODES.length * 2)
    .superRefine((list, ctx) => {
        const unknown = list.find((x) => !(TESTING_MODES as readonly string[]).includes(x));
        if (unknown !== undefined) ctx.addIssue({ code: "custom", message: `"${String(unknown).slice(0, 40)}" is not a testing mode. Choose agent or code.` });
        else if (list.length === 0) ctx.addIssue({ code: "custom", message: "Choose at least one testing mode." });
        else if (new Set(list).size > 1) ctx.addIssue({ code: "custom", message: ONE_TESTING_MODE });
    })
    .transform((list) => ordered(TESTING_MODES, list as TestingMode[]));

const parseList = <T extends string>(raw: unknown, all: readonly T[], fallback: T[]): T[] => {
    try {
        const v = JSON.parse(String(raw ?? ""));
        const out = Array.isArray(v) ? ordered(all, v as T[]) : [];
        return out.length ? out : fallback;
    } catch {
        return fallback;
    }
};

export interface ProjectSetup {
    platforms: ProjectPlatform[];
    testingModes: TestingMode[];
    codeEngines: CodeEngines;
}

/** The camelCase view of a project row's columns (a row from before slot 35 reads as the defaults). */
export function projectSetupOf(row: Record<string, unknown>): ProjectSetup {
    const platforms = parseList(row.platforms, PLATFORMS, DEFAULT_PLATFORMS);
    return { platforms, testingModes: parseList(row.testing_modes, TESTING_MODES, DEFAULT_TESTING_MODES), codeEngines: codeEnginesFor(platforms) };
}

// ── the setup check (GET /api/projects/:id/setup-check) ──

export interface SetupItem {
    key: string;
    ok: boolean;
    text: string;
}

/** What the setup check knows about a project; gathered by the route, read-only. */
export interface SetupFacts {
    setup: ProjectSetup;
    /** A named environment, or an application with a web address. */
    hasWebAddress: boolean;
    hasAndroidApp: boolean;
    hasIosApp: boolean;
    /** Whether a connected runner (or this server) can run iOS tests. */
    canRunIos: boolean;
    aiConfigured: boolean;
    /** Where the tests run: this server, or runners (and whether one is online for the project). */
    runner: { runOn: "platform" } | { runOn: "agent"; online: number };
    /** Whether a run started now would start at all (suite-run.ts `runsCanStartHere`): false while tests are switched off on this server. */
    runsHere: boolean;
}

/**
 * Warnings, never blocks: one item per thing the chosen platforms and modes need, ok or not, so the page shows a full checklist.
 * Items for a platform or mode that is turned off are left out.
 */
export function setupItems(f: SetupFacts): SetupItem[] {
    const { platforms, testingModes } = f.setup;
    const items: SetupItem[] = [];
    if (platforms.includes("web"))
        items.push({ key: "web-address", ok: f.hasWebAddress, text: f.hasWebAddress ? "Web tests have an address to test." : "Web tests need an environment or the address of the site to test." });
    if (platforms.includes("android"))
        items.push({ key: "android-app", ok: f.hasAndroidApp, text: f.hasAndroidApp ? "An Android app is set." : "Android tests need an app: upload one or give its package name." });
    if (platforms.includes("ios")) {
        items.push({ key: "ios-app", ok: f.hasIosApp, text: f.hasIosApp ? "An iOS app is set." : "iOS tests need an app: give its bundle id." });
        items.push({ key: "ios-runner", ok: f.canRunIos, text: f.canRunIos ? "A runner can run iOS tests." : "iOS tests need a runner on a Mac with Xcode." });
    }
    if (testingModes.includes("agent"))
        items.push({ key: "ai-model", ok: f.aiConfigured, text: f.aiConfigured ? "Your AI key is set up." : "Agent mode needs your AI key. Add your own in Settings, AI keys, or ask an admin to assign one." });
    const r = f.runner;
    items.push(
        !f.runsHere
            ? { key: "runner", ok: false, text: "Tests are switched off on this server, so no run starts here. Tests you make are kept." }
            : r.runOn === "platform"
            ? { key: "runner", ok: true, text: "Tests run on this server." }
            : { key: "runner", ok: r.online > 0, text: r.online > 0 ? `Tests run on a runner (${r.online} online).` : "No runner is online for this project. Start one, or choose another." },
    );
    return items;
}
