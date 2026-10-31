/**
 * Three project settings for phone tests (Settings, Mobile app), stored with the project's mobile app (`MobileTarget`, the application's config JSON):
 *
 *   Where phone tests run   `runsOn`        the phone the AI explored on, a named connected phone, an emulator, a device farm, or automatic
 *   How thorough            `depth`         how far an AI exploration goes (Quick, Standard, Thorough); the explorer turns it into its limits
 *   Already signed in       `keepSignedIn`  the app's data is kept (no clean start), so an app signed in by hand on the phone is explored and
 *                                           tested signed in
 *
 * Plus what other parts record here: `exploredOn` (the device an exploration used, written by the exploration) and `phoneSetup` (the values
 * the phone had before "Turn animations off for tests" or "Keep the screen on while charging" changed them, so they can be put back).
 *
 * This file is plain data and words; it imports nothing of the platform, so the engine, the runner and the web tests can all read it.
 * Device choice itself (which phone a run really uses) is decided by mobile/device/choose.ts; the explorer's limits by explore/types.ts.
 */
import { z } from "zod";

/** adb serials: letters, digits, dot, colon, dash, underscore (a Wi-Fi phone is host:port). */
export const SERIAL = /^[A-Za-z0-9._:-]{1,80}$/;

// ── Where phone tests run ───────────────────────────────────────────────────

export const RUNS_ON_KINDS = ["auto", "explored", "phone", "emulator", "farm"] as const;
export type RunsOnKind = (typeof RUNS_ON_KINDS)[number];

export const PhoneRunsOnSchema = z.discriminatedUnion("kind", [
    /** No choice made: the phone the AI explored on when it was a real phone, else a connected phone that has the app, else an emulator. */
    z.object({ kind: z.literal("auto") }),
    /** The device the last exploration used (recorded in `exploredOn`). */
    z.object({ kind: z.literal("explored") }),
    /** One connected phone, by its adb serial (the model is kept only to name it when it is not connected). */
    z.object({ kind: z.literal("phone"), serial: z.string().regex(SERIAL, "That device name is not usable."), model: z.string().max(60).optional() }),
    /** An emulator, even when a real phone is connected. */
    z.object({ kind: z.literal("emulator") }),
    /** The project's device farm (Settings, Mobile app, Device farm): the farm choice itself lives with the device farm connections. */
    z.object({ kind: z.literal("farm") }),
]);
export type PhoneRunsOn = z.infer<typeof PhoneRunsOnSchema>;

/** The device an exploration used, recorded by the exploration so the tests it writes run on the same one. */
export const ExploredOnSchema = z.object({
    serial: z.string().regex(SERIAL),
    model: z.string().max(60).optional(),
    emulator: z.boolean(),
    /** ISO time of the exploration. */
    at: z.string().max(40).optional(),
});
export type ExploredOn = z.infer<typeof ExploredOnSchema>;

// ── How thorough ────────────────────────────────────────────────────────────

export const PHONE_DEPTHS = ["quick", "standard", "thorough"] as const;
export type PhoneDepth = (typeof PHONE_DEPTHS)[number];
export const DEFAULT_DEPTH: PhoneDepth = "standard";

/**
 * What each depth means, in the numbers a person is told and the explorer and the planner use: at most this many distinct screens, actions and
 * minutes, and this many test ideas in the plan. The exploration stops earlier when it stops finding new screens (it then says so).
 */
export const DEPTHS: Record<PhoneDepth, { label: string; screens: number; actions: number; minutes: number; ideas: number; aiCalls: number; line: string }> = {
    quick: { label: "Quick", screens: 40, actions: 150, minutes: 10, ideas: 15, aiCalls: 60, line: "About 40 screens, 150 actions or 10 minutes. Good for a first look." },
    standard: { label: "Standard", screens: 150, actions: 600, minutes: 30, ideas: 40, aiCalls: 150, line: "About 150 screens, 600 actions or 30 minutes. Covers the main parts of most apps." },
    thorough: { label: "Thorough", screens: 300, actions: 1200, minutes: 60, ideas: 80, aiCalls: 300, line: "About 300 screens, 1,200 actions or 60 minutes. For large apps; uses more AI." },
};

// ── what is stored ──────────────────────────────────────────────────────────

const SCALE = /^\d{1,2}(\.\d{1,2})?$/;
/** The phone's own values before a change, kept per serial so the change can be undone exactly. */
export const PhoneSetupSchema = z.object({
    animations: z.record(z.string().regex(SERIAL), z.object({ window: z.string().regex(SCALE), transition: z.string().regex(SCALE), animator: z.string().regex(SCALE) })).optional(),
    stayAwake: z.record(z.string().regex(SERIAL), z.string().regex(/^\d{1,2}$/)).optional(),
});
export type PhoneSetup = z.infer<typeof PhoneSetupSchema>;

/** The fields MobileTarget (mobile/target.ts) gains, spread into its object so they are kept, parsed and capped like the rest. */
export const PHONE_SETTINGS_FIELDS = {
    /** Where phone tests run. Unset: automatic (see PhoneRunsOnSchema). */
    runsOn: PhoneRunsOnSchema.optional(),
    /** How far an AI exploration goes. Unset: standard. */
    depth: z.enum(PHONE_DEPTHS).optional(),
    /** "Already signed in on this phone": keep the app's data; never a clean start. Default off. */
    keepSignedIn: z.boolean().optional(),
    /** The device the last exploration used (written by the exploration, shown read-only). */
    exploredOn: ExploredOnSchema.optional(),
    /** Values to put back (animations, stay awake), per phone. */
    phoneSetup: PhoneSetupSchema.optional(),
};

export interface PhoneSettings {
    runsOn?: PhoneRunsOn;
    depth?: PhoneDepth;
    keepSignedIn?: boolean;
    exploredOn?: ExploredOn;
    phoneSetup?: PhoneSetup;
}

/** The depth to use (unset means standard). */
export const depthOf = (s: Pick<PhoneSettings, "depth"> | undefined): PhoneDepth => s?.depth ?? DEFAULT_DEPTH;

/**
 * The device choice that applies: what was chosen, or, when nothing was, the phone the AI explored on when that was a real phone (the brief's
 * default), else automatic.
 */
export function effectiveRunsOn(s: Pick<PhoneSettings, "runsOn" | "exploredOn"> | undefined): PhoneRunsOn {
    if (s?.runsOn && s.runsOn.kind !== "auto") return s.runsOn;
    if (s?.exploredOn && !s.exploredOn.emulator) return { kind: "explored" };
    return { kind: "auto" };
}

/** The serial a choice names directly, when it names one (a phone, or the phone the AI explored on). */
export function chosenSerial(s: Pick<PhoneSettings, "runsOn" | "exploredOn"> | undefined): string | undefined {
    const r = effectiveRunsOn(s);
    if (r.kind === "phone") return r.serial;
    if (r.kind === "explored") return s?.exploredOn?.serial;
    return undefined;
}

/** "CPH2467 (R58N20ABCDE)", or the serial alone. */
export const deviceWords = (d: { serial: string; model?: string | undefined }): string => (d.model ? `${d.model} (${d.serial})` : d.serial);

/** The choice in one plain sentence, for Setup and the run's events. */
export function runsOnSentence(s: Pick<PhoneSettings, "runsOn" | "exploredOn"> | undefined): string {
    const r = effectiveRunsOn(s);
    switch (r.kind) {
        case "explored":
            return s?.exploredOn ? `Phone tests run on the phone the AI explored on, ${deviceWords(s.exploredOn)}.` : "Phone tests run on the phone the AI explores on. No exploration has run yet.";
        case "phone":
            return `Phone tests run on ${deviceWords(r)}.`;
        case "emulator":
            return "Phone tests run on an emulator, even when a phone is connected.";
        case "farm":
            return "Phone tests run on the project's device farm.";
        default:
            return "Phone tests run on a connected phone that has the app, else on an emulator.";
    }
}

/** What "Already signed in on this phone" means for a run: the app's data is never cleared and the session keeps it (noReset). */
export function startRules(s: Pick<PhoneSettings, "keepSignedIn"> & { cleanStart?: boolean | undefined } | undefined): { clearData: boolean; keepAppData: boolean } {
    const keep = s?.keepSignedIn === true;
    return { clearData: !keep && s?.cleanStart === true, keepAppData: keep || s?.cleanStart !== true };
}

/** Why these settings cannot be saved together, in words; undefined when they can. */
export function phoneSettingsProblem(s: PhoneSettings & { cleanStart?: boolean | undefined; appPackage?: string | undefined }): string | undefined {
    if (s.keepSignedIn && s.cleanStart) return "“Already signed in on this phone” keeps the app’s data, so “Start every test from a fresh install of the app’s data” has to be off. Turn one of them off.";
    if (s.keepSignedIn && !s.appPackage) return "“Already signed in on this phone” needs the app’s package name. Add it first.";
    return undefined;
}

/**
 * The settings after a change: a field the request leaves out keeps its value, null clears it. Only set fields are returned (so a project that
 * never touched them stores nothing new, and its answers stay as they were).
 */
export function keptPhoneSettings(cur: PhoneSettings | undefined, body: { runsOn?: PhoneRunsOn | null; depth?: PhoneDepth | null; keepSignedIn?: boolean | null } = {}): PhoneSettings {
    const runsOn = body.runsOn === undefined ? cur?.runsOn : (body.runsOn ?? undefined);
    const depth = body.depth === undefined ? cur?.depth : (body.depth ?? undefined);
    const keep = body.keepSignedIn === undefined ? cur?.keepSignedIn : (body.keepSignedIn ?? undefined);
    return {
        ...(runsOn && runsOn.kind !== "auto" ? { runsOn } : {}),
        ...(depth && depth !== DEFAULT_DEPTH ? { depth } : {}),
        ...(keep ? { keepSignedIn: true } : {}),
        ...(cur?.exploredOn ? { exploredOn: cur.exploredOn } : {}),
        ...(cur?.phoneSetup && (Object.keys(cur.phoneSetup.animations ?? {}).length || Object.keys(cur.phoneSetup.stayAwake ?? {}).length) ? { phoneSetup: cur.phoneSetup } : {}),
    };
}

/** What the browser may see of the settings (all of it is harmless: no paths, no secrets). Only set fields. */
export function publicPhoneSettings(s: PhoneSettings | undefined): Record<string, unknown> {
    if (!s) return {};
    return {
        ...(s.runsOn && s.runsOn.kind !== "auto" ? { runsOn: s.runsOn } : {}),
        ...(s.depth && s.depth !== DEFAULT_DEPTH ? { depth: s.depth } : {}),
        ...(s.keepSignedIn ? { keepSignedIn: true } : {}),
        ...(s.exploredOn ? { exploredOn: s.exploredOn } : {}),
    };
}
