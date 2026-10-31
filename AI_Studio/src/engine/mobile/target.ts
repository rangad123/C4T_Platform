import { z } from "zod";
import { PHONE_SETTINGS_FIELDS } from "./phone-settings.js";

/** Android application ids look like `com.example.app` (letters, digits, underscores; at least two segments). */
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** iOS bundle ids are reverse-DNS names: letters, digits and dashes in at least two dot-separated parts. */
export const IOS_BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
/** Simulator names such as "iPhone 15 Pro" or "iPad (10th generation)". */
export const SIMULATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
/** Android permission names: dotted words ending in an upper-case name, such as android.permission.CAMERA or com.example.permission.SYNC. */
export const PERMISSION_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.permission\.[A-Z][A-Z0-9_]{1,80}$/;
/** Most permissions a project may ask to grant before each test. */
export const MAX_GRANTED = 30;

/**
 * The app mobile tests run against: an application already on the device (`appPackage`, e.g. the
 * built-in Settings app) and/or an APK the platform installs first. One of the two is required.
 */
export const MobileTargetBase = z.object({
    appPackage: z.string().regex(PACKAGE, "must be an Android application id such as com.example.app").optional(),
    /** Absolute path of an APK on the machine running the platform (set by the upload endpoint). */
    apkPath: z.string().min(1).max(1024).optional(),
    /** Emulator (AVD) to use; defaults to the first one found. */
    avd: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "letters, digits, dot, dash and underscore only").optional(),
    /** iOS tests: the bundle id of an app already installed on the simulator, such as com.example.App (see ios-target.ts). */
    iosBundleId: z.string().regex(IOS_BUNDLE_ID, "must be an iOS bundle id such as com.example.App").optional(),
    /** iOS tests: the simulator to use, by name (for example iPhone 15). Unset: a booted one, else the first available. */
    simulator: z.string().regex(SIMULATOR_NAME, "letters, digits, spaces and . _ ( ) - only").optional(),
    /** Android: clear the app's data (`pm clear`, the configured package only) before every test, so each starts like a fresh install. Default off. See mobile/state/. */
    cleanStart: z.boolean().optional(),
    /** Android: the longest a cold start of the app may take before it is a finding (phone quality checks, mobile/quality). Unset: 5 s. */
    startupBudgetMs: z.number().int().min(500).max(60_000).optional(),
    /** Android: runtime permissions granted to the configured package (`pm grant`) before every test, for example android.permission.CAMERA. */
    grantPermissions: z.array(z.string().regex(PERMISSION_NAME, "must be an Android permission such as android.permission.CAMERA")).max(MAX_GRANTED).optional(),
    /**
     * Android (round 24, RUN): the screen that opens the app, as the last run resolved it on the phone (mobile/device/launcher.ts), for example
     * ".authenticator.LaunchActivity". Read-only for people (Settings, Mobile app shows it); every run resolves it again on its own device.
     */
    appActivity: z.string().regex(/^\.?[A-Za-z][A-Za-z0-9_$]*(\.[A-Za-z][A-Za-z0-9_$]*)*$/).max(300).optional(),
    /** Android (round 24, DEVICE): where phone tests run, how thorough an exploration is, "Already signed in on this phone", the device an exploration used, values to put back. See phone-settings.ts. */
    ...PHONE_SETTINGS_FIELDS,
});

export const MobileTargetSchema = MobileTargetBase.refine((t) => t.appPackage || t.apkPath || t.iosBundleId, { message: "Give an app package, an APK, an iOS bundle id, or a combination" });

export type MobileTarget = z.infer<typeof MobileTargetSchema>;
