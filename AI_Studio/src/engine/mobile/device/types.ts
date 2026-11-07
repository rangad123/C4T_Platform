/**
 * The contract between the three parts of AI phone exploration, fixed here so they can be built in parallel:
 *  - the DEVICE SESSION (adb on this computer or on a runner agent): reads the screen, performs one action at a time;
 *  - the EXPLORER (platform side, drives an AI model with what the session returns, plans and writes the tests);
 *  - the SCREENS (start, live picture, plan, results).
 * Android only (UI Automator through adb). Pure types: no code.
 */

/** One thing on the screen, from the UI Automator hierarchy. Only what a person could see or touch is kept. */
export interface ScreenElement {
    /** Position in the list the session returned: the only way an action names an element (never raw coordinates from the AI). */
    index: number;
    /** Short class name, for example "Button", "EditText", "TextView", "ImageView", "CheckBox", "Switch", "RecyclerView". */
    cls: string;
    /** Visible text (cut to 80 characters; empty for a password field, whose value is never read). */
    text: string;
    /** Accessibility label (content-desc), cut to 80 characters. */
    desc: string;
    /** Resource id without the package prefix ("login_button"), the best stable name an app gives an element; empty when none. */
    id: string;
    clickable: boolean;
    longClickable: boolean;
    scrollable: boolean;
    /** A text input (EditText or similar). */
    editable: boolean;
    /** A password input: typing into it is refused unless the text is a credential placeholder (see DeviceAction). */
    password: boolean;
    checkable: boolean;
    checked: boolean;
    enabled: boolean;
    focused: boolean;
    /** [left, top, right, bottom] in screen pixels. */
    bounds: [number, number, number, number];
    // ── added by PLAN (R24), all optional: where the element sits, so a written test can anchor a locator (mobile/explore/locators.ts) ──
    /** Resource ids (without package prefix) of the enclosing views that have one, kept on the list or not: outermost first, the nearest last, at most 6. */
    scopes?: string[];
    /** Inside a view that scrolls (a list or a feed): its content changes by itself and may need scrolling to reach. */
    inScroll?: true;
    /** The view reports itself selected (a selected tab). */
    selected?: true;
    /** The resource id has no `package:id/` prefix (a Jetpack Compose test tag): Appium's id lookup does not find it as it is. */
    bareId?: true;
}

export interface ScreenSnapshot {
    /** Application package that owns the foreground window, for example "com.example.shop". */
    package: string;
    /** Foreground activity when known. */
    activity?: string;
    width: number;
    height: number;
    /** Interactive and text-bearing elements, in reading order (top to bottom, left to right), at most 120. */
    elements: ScreenElement[];
    /**
     * The STRUCTURAL fingerprint of the screen (package, activity, class + resource id of what is on it, repeated list rows collapsed, text inside
     * lists and changing numbers ignored; see uiautomator.ts fingerprintOf): equal for the same screen, also when a feed was scrolled or refreshed.
     */
    fingerprint: string;
    /** Added in R24 (optional): a fingerprint WITH the texts (the earlier definition): changes whenever anything visible changes (settling, evidence). */
    textFingerprint?: string;
    /** A small JPEG (base64, max 640 px wide, 120 KB) when asked for; password fields covered. */
    screenshot?: string;
    /** True when the keyboard is showing. */
    keyboard: boolean;
    /** The screen shows a permission dialog, a system dialog or leaves the app under test: the explorer must handle or go back. */
    outsideApp: boolean;
}

/**
 * What the explorer may do. Everything names an element by its `index` in the LAST snapshot (a stale index is refused), so the AI model
 * can never tap arbitrary coordinates, open another app, or run a shell command.
 */
export type DeviceAction =
    | { kind: "tap"; index: number }
    | { kind: "longPress"; index: number }
    /** `text` is typed into the element. A password element accepts only "{{credentials.password}}" (and the user name field "{{credentials.username}}"); the session fills the real value on the machine that owns the device and never returns it. */
    | { kind: "type"; index: number; text: string; clear?: boolean }
    | { kind: "scroll"; index?: number; direction: "up" | "down" | "left" | "right" }
    | { kind: "back" }
    | { kind: "hideKeyboard" }
    /** Start the app under test (only the package the project configured; any other package is refused). */
    | { kind: "launch" }
    /** Stop and restart the app under test from its first screen (clears nothing else). */
    | { kind: "restart" }
    | { kind: "wait"; ms: number };

export interface ActResult {
    ok: boolean;
    /** Plain-words refusal or failure ("That element is not on the screen any more"). */
    error?: string;
    /** The screen after the action (already settled, ≤ 3 s of waiting). */
    snapshot?: ScreenSnapshot;
}

/** One open conversation with a phone or emulator. Local (adb on this computer) or remote (through a runner agent): same interface. */
export interface DeviceSession {
    readonly kind: "local" | "agent";
    readonly deviceName: string;
    snapshot(opts?: { screenshot?: boolean }): Promise<ScreenSnapshot>;
    /** `screenshot: true` adds the picture to the returned snapshot (one round trip instead of two). Added by MX-A; optional, so existing callers are unaffected. */
    act(action: DeviceAction, opts?: { screenshot?: boolean }): Promise<ActResult>;
    close(): Promise<void>;
    /** Added by PQ (optional): what the phone itself reports about the app under test. Absent on a session whose phone cannot be read this way (a runner today). */
    health?: AppHealth;
    // ── added by EXPLORE (R24), all optional ──
    /** The adb serial of the device, its model and whether it is an emulator, when the session knows them (the exploration records them). */
    readonly serial?: string;
    readonly model?: string;
    readonly emulator?: boolean;
    /** The session's own caps (actions, minutes), when it has them: the explorer stops before reaching them. */
    readonly actionLimit?: number;
    readonly minuteLimit?: number;
    /** The app's activities the phone lists (`dumpsys package`), short names; undefined when they cannot be read. For the coverage numbers only. */
    listedActivities?(): Promise<string[] | undefined>;
}

/** The phone's own view of the app under test (phone quality checks, see mobile/quality). Each call is a fixed adb command; none takes text from the AI. */
export interface AppHealth {
    /** Crashes and freezes of the app logged since the session opened, or since the last call. */
    crashes(): Promise<import("../quality/types.js").AppCrash[]>;
    /** Stops the app and starts it cold, measured by Android; the app is left on its first screen. */
    coldStart(): Promise<{ measure?: import("../quality/types.js").StartupMeasure; problem?: string }>;
    /** Screen density in dpi, when the phone reports it. */
    densityDpi(): Promise<number | undefined>;
    /** Set when the phone's log cannot be read (crashes are then not checked): the plain reason. */
    readonly unavailable?: string | undefined;
}

export interface OpenDeviceOptions {
    /** The app under test: package (required to explore) and an APK to install first when given. */
    appPackage: string;
    apkPath?: string;
    avd?: string;
    /** Credentials the session may type for {{credentials.*}} placeholders (kept on the machine that owns the device). */
    credentials?: { username?: string; password?: string };
    signal?: AbortSignal;
    log?: (line: string) => void;
    // ── added by MX-A (all optional) ──
    /** Use this adb serial (a phone the person chose) instead of the first ready device. */
    serial?: string;
    /** Explore on an emulator even when a real phone is connected (project setting runsOn=emulator): pick a running emulator, else start an AVD. */
    emulatorOnly?: boolean;
    /** A person's own computer whose owner did not allow their connected phone (round 39): never a real phone, named or not; only an emulator. */
    noRealPhone?: boolean;
    /** On a real phone, uninstall the app when the session closes if this session installed it (it was not on the phone before). */
    removeInstalledApp?: boolean;
    /** Hard caps for one session (defaults: 200 actions, 20 minutes). */
    maxActions?: number;
    maxMinutes?: number;
    /** The environment the Android tools are looked up in (default process.env); an agent passes its own. */
    env?: NodeJS.ProcessEnv;
}
