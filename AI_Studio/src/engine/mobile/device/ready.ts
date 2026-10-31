/**
 * "Is this phone ready?": what Settings, Mobile app (and a runner's check-computer) say about a connected Android phone or emulator before a test
 * runs on it. Read-only: every call is on the READ list of setup-commands.ts. The two changes a person can ask for (animations off for tests,
 * keep the screen on while charging) are separate functions at the end, each reversible with the values the phone had before.
 *
 * What is checked, each with a plain sentence and, when something needs doing, the exact steps:
 *   USB debugging allowed · Android version · screen on and not locked · stay awake while charging · animations · battery ·
 *   the app installed for the phone's current user (a second user such as OnePlus "Parallel apps" is noticed and explained) ·
 *   the app's launcher activity (from the shared resolver when it is there) · the test helper (UiAutomator2 server) · tips for the phone's maker.
 *
 * Nothing here is a test verdict: a phone that is not ready is a phone that is not ready.
 */
import { ANIMATION_KEYS, STAY_ON_KEY, type AnimationKey, type ReadyProp } from "./setup-commands.js";
import { isLockedFromWindowDump } from "./uiautomator.js";

/** Runs one call of the READ (or CHANGE) list and returns its text. `Adb.forReadiness().setupCall` in production, recorded outputs in tests. */
export type ReadyCall = (args: string[]) => Promise<string>;

/** The shared launcher resolver's answer for this check: the component that opens the app, or why there is none. */
export interface LauncherAnswer {
    component?: string;
    /** Plain words when the app cannot be opened (no launcher for this user, only the chooser). */
    problem?: string;
}
export type LauncherResolver = (pkg: string, user: number) => Promise<LauncherAnswer>;

export type CheckStatus = "ok" | "attention" | "problem" | "info";
export type ReadyCheckId = "authorized" | "android" | "screen" | "stay-awake" | "animations" | "battery" | "app" | "launcher" | "users" | "helper";
export type ReadyAction = "animations-off" | "animations-restore" | "stay-awake-on" | "stay-awake-restore";

export interface ReadyCheck {
    id: ReadyCheckId;
    status: CheckStatus;
    /** One sentence: what was found. */
    title: string;
    /** Why it matters, when it is not obvious. */
    detail?: string;
    /** Exact steps on the phone, when something needs doing. */
    steps?: string[];
    /** A button that does it for the person (reversible). */
    action?: ReadyAction;
}

export type MakerId = "oneplus" | "xiaomi" | "samsung" | "vivo" | "huawei" | "google" | "other";

export interface OemTip {
    title: string;
    why: string;
    steps: string[];
}

export type ReadyState = "ready" | "attention" | "not-ready";

export interface PhoneReadiness {
    serial: string;
    emulator: boolean;
    model?: string;
    manufacturer?: string;
    maker: MakerId;
    androidVersion?: string;
    sdk?: number;
    state: ReadyState;
    /** One sentence for the phone's row. */
    summary: string;
    checks: ReadyCheck[];
    animations?: { window: string; transition: string; animator: string; off: boolean };
    stayAwake?: { value: string; on: boolean };
    battery?: { level: number; charging: boolean };
    users?: { current: number; list: Array<{ id: number; name: string }>; appFor: number[] };
    launcher?: string;
    /** What the phone's maker needs on top (empty for Google and unknown makers). */
    tips: OemTip[];
}

export interface ReadyInput {
    serial: string;
    /** adb's state for the device: "device" is usable; "unauthorized", "offline" and others are not. */
    adbState: string;
    emulator: boolean;
    model?: string;
    /** The project's app. Without one the app checks are left out. */
    appPackage?: string;
    /** The project has an uploaded .apk: a missing app is installed from it, so that is not a problem. */
    hasApk?: boolean;
    /** The shared resolver (mobile/device/launcher.ts); without it the check asks `cmd package resolve-activity` for the user itself. */
    resolveLauncher?: LauncherResolver;
    /** Values this project saved before it turned animations off (so "Restore animations" can be offered). */
    savedAnimations?: { window: string; transition: string; animator: string };
    savedStayAwake?: string;
}

/** The two packages of the test helper Appium installs on the phone (UiAutomator2 server and its instrumentation). */
export const HELPER_PACKAGES = ["io.appium.uiautomator2.server", "io.appium.uiautomator2.server.test"] as const;
export const MIN_SDK = 21;
const LOW_BATTERY = 20;

// ── reading what the phone says ─────────────────────────────────────────────

/** Every line without the Windows carriage return adb adds on some computers, and trimmed. */
const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.replace(/\r/g, "").trim());
const clean = (text: string): string => text.replace(/\r/g, "").trim();

/** "1", "1.0", "0.5" (or "null" when never set: Android's default, 1). */
export function scaleOf(text: string): string {
    const v = clean(text);
    return /^\d{1,2}(\.\d{1,2})?$/.test(v) ? v : "1";
}
export const isOff = (scale: string): boolean => Number(scale) === 0;

/** `dumpsys power`: is the screen on? undefined when the phone does not say. */
export function screenOnFrom(dump: string): boolean | undefined {
    const w = /mWakefulness=(\w+)/.exec(dump)?.[1];
    if (w) return w === "Awake";
    const d = /Display Power: state=(\w+)/.exec(dump)?.[1];
    if (d) return d === "ON";
    const i = /mInteractive=(true|false)/.exec(dump)?.[1];
    return i ? i === "true" : undefined;
}

/**
 * `dumpsys window`: is the lock screen actually in front? The same check the device session uses (uiautomator.ts): a keyguard flag alone is
 * not enough, because some emulator images leave it set on the home screen. A real locked phone has the keyguard/shade focused or nothing
 * focused, so it still reads as locked.
 */
export function lockedFrom(dump: string): boolean {
    return isLockedFromWindowDump(dump);
}

/** `dumpsys battery`: level and whether it is charging. */
export function batteryFrom(dump: string): { level: number; charging: boolean } | undefined {
    const level = Number(/^\s*level:\s*(\d+)/m.exec(dump)?.[1]);
    if (!Number.isFinite(level)) return undefined;
    const powered = /(AC|USB|Wireless|Dock) powered:\s*true/i.test(dump);
    const status = Number(/^\s*status:\s*(\d+)/m.exec(dump)?.[1]);
    return { level: Math.max(0, Math.min(100, level)), charging: powered || status === 2 || status === 5 };
}

/**
 * Free bytes on the data partition, from `df -k /data` (1-KiB blocks). The Avail column is the one just before the "Use%" column, so a
 * mount path with spaces does not throw it off. Undefined when the output cannot be read (the check then does not block the run).
 */
export function freeDataBytesFrom(df: string): number | undefined {
    const rows = lines(df).filter((l) => l && !/^Filesystem/i.test(l) && /\d/.test(l));
    if (!rows.length) return undefined;
    // Prefer the real data mount; fall back to the only data row.
    const row = rows.find((l) => /\/data\b|\/storage\/emulated/.test(l)) ?? rows[rows.length - 1]!;
    const cols = row.split(/\s+/);
    const pct = cols.findIndex((c) => /^\d+%$/.test(c));
    const availKb = Number(pct > 0 ? cols[pct - 1] : cols[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : undefined;
}

/** `pm list users`: "UserInfo{0:Owner:c13} running", "UserInfo{999:MultiApp:4001010} running". */
export function usersFrom(text: string): Array<{ id: number; name: string }> {
    const out: Array<{ id: number; name: string }> = [];
    for (const m of text.matchAll(/UserInfo\{(\d{1,6}):([^:}\r\n]{0,60}):[0-9a-fA-F]+\}/g)) out.push({ id: Number(m[1]), name: m[2]!.trim() || `user ${m[1]}` });
    return out.slice(0, 12);
}

/** `pm list packages --user N`: is this exact package in the list? */
export const listed = (text: string, pkg: string): boolean => lines(text).some((l) => l === `package:${pkg}`);

/**
 * `cmd package resolve-activity --brief ...`: the component on its own line ("com.app/.Main"), never the system chooser. Trims \r and spaces
 * (an adb on Windows ends lines with \r\n, and a component with a \r resolves nothing).
 */
export function launcherFrom(text: string, pkg: string): LauncherAnswer {
    const comps = lines(text).filter((l) => /^[A-Za-z][\w.]*\/[\w.$]+$/.test(l));
    if (comps.some((c) => /ResolverActivity$/.test(c)) && !comps.some((c) => c.startsWith(`${pkg}/`))) {
        return { problem: "Android offers a choice of apps instead of opening this one (two copies of the app may be installed, for example a parallel app)." };
    }
    const own = comps.find((c) => c.startsWith(`${pkg}/`));
    if (own) return { component: own };
    return { problem: "The phone found no screen that opens this app for its current user." };
}

export function makerOf(manufacturer: string | undefined, brand?: string): MakerId {
    const m = `${manufacturer ?? ""} ${brand ?? ""}`.toLowerCase();
    if (/oneplus|oppo|realme/.test(m)) return "oneplus";
    if (/xiaomi|redmi|poco/.test(m)) return "xiaomi";
    if (/samsung/.test(m)) return "samsung";
    if (/vivo|iqoo/.test(m)) return "vivo";
    if (/huawei|honor/.test(m)) return "huawei";
    if (/google/.test(m)) return "google";
    return "other";
}

// ── the maker's own settings (exact menu names; they move a little between versions) ──

const DEV_OPTIONS = "Open Settings, About phone, and tap Build number seven times to show Developer options (on some phones it is under Software information or Version).";

export const OEM_TIPS: Record<MakerId, OemTip[]> = {
    oneplus: [
        {
            title: "Turn on Disable permission monitoring",
            why: "OnePlus, OPPO and realme phones refuse setting changes and permission grants from a computer until this is on. Turning animations off for tests needs it.",
            steps: [DEV_OPTIONS, "Open Settings, System settings (Additional settings on older phones), Developer options.", "Turn on Disable permission monitoring (on some versions it is called Disable system optimization).", "Restart the phone if it asks."],
        },
        {
            title: "Let the test helper run in the background",
            why: "The phone's battery manager freezes the test helper between steps, which makes tests slow or stop with a broken connection.",
            steps: ["Run one phone test first, so the test helper is installed.", "Open Settings, Apps, App management, and find io.appium.uiautomator2.server.", "Open Battery usage and turn on Allow background activity (and Allow auto launch when it is there).", "Do the same for io.appium.uiautomator2.server.test."],
        },
    ],
    xiaomi: [
        {
            title: "Turn on USB debugging (Security settings)",
            why: "Without it a Xiaomi, Redmi or POCO phone lets the computer read the screen but not tap or type, and refuses setting changes.",
            steps: [DEV_OPTIONS, "Open Settings, Additional settings, Developer options.", "Turn on USB debugging (Security settings). The phone may ask you to sign in to a Mi account and to have a SIM card inserted.", "Turn on Install via USB as well, so the test helper can be installed."],
        },
        {
            title: "Let the test helper start by itself",
            why: "The phone's battery saver stops the test helper between steps.",
            steps: ["Run one phone test first, so the test helper is installed.", "Open Settings, Apps, Manage apps, and find io.appium.uiautomator2.server.", "Turn on Autostart, and under Battery saver choose No restrictions.", "Do the same for io.appium.uiautomator2.server.test."],
        },
    ],
    samsung: [
        {
            title: "Turn off Auto Blocker",
            why: "On newer Samsung phones Auto Blocker blocks commands sent over the USB cable, so tests cannot tap or type.",
            steps: ["Open Settings, Security and privacy, Auto Blocker.", "Turn it off while the phone is used for tests (turn it on again afterwards if you like)."],
        },
        {
            title: "Let the test helper run without battery limits",
            why: "Battery optimisation can put the test helper to sleep between steps.",
            steps: ["Run one phone test first, so the test helper is installed.", "Open Settings, Apps, and find io.appium.uiautomator2.server.", "Open Battery and choose Unrestricted.", "Do the same for io.appium.uiautomator2.server.test."],
        },
    ],
    vivo: [
        {
            title: "Allow installing and controlling over USB",
            why: "vivo and iQOO phones ask before an app is installed over USB and may block the test helper.",
            steps: [DEV_OPTIONS, "Open Settings, System management (or More settings), Developer options.", "Turn on USB debugging and Install via USB, and turn off Monitor apps installed via ADB if it is there.", "Under Settings, Battery, Background power consumption management, allow io.appium.uiautomator2.server to run in the background."],
        },
    ],
    huawei: [
        {
            title: "Keep USB debugging on while charging",
            why: "Huawei and Honor phones switch USB debugging off when the cable is set to charge only.",
            steps: [DEV_OPTIONS, "Open Settings, System and updates, Developer options.", "Turn on Allow ADB debugging in charge only mode, and turn off Monitor apps installed via ADB.", "Under Settings, Battery, App launch, set io.appium.uiautomator2.server to Manage manually and allow it to run in the background."],
        },
    ],
    google: [],
    other: [],
};

// ── the check ───────────────────────────────────────────────────────────────

const safe = async (call: ReadyCall, args: string[]): Promise<string | undefined> => {
    try {
        return await call(args);
    } catch {
        return undefined;
    }
};

function notConnected(i: ReadyInput): PhoneReadiness {
    const unauthorized = i.adbState === "unauthorized";
    const offline = i.adbState === "offline";
    const check: ReadyCheck = unauthorized
        ? {
              id: "authorized",
              status: "problem",
              title: "This computer is not allowed to use the phone yet",
              steps: ["Unlock the phone.", "Tap Allow on “Allow USB debugging?” (tick Always allow from this computer).", "If no question shows, unplug the cable and plug it in again, or turn USB debugging off and on in Developer options."],
          }
        : offline
          ? { id: "authorized", status: "problem", title: "The phone is connected but offline", steps: ["Unplug the cable and plug it in again.", "Unlock the phone.", "If it stays offline, restart the phone."] }
          : { id: "authorized", status: "problem", title: `The phone is not usable right now (adb says “${i.adbState.slice(0, 20)}”)`, steps: ["Unplug the cable and plug it in again, then unlock the phone."] };
    return { serial: i.serial, emulator: i.emulator, ...(i.model ? { model: i.model } : {}), maker: "other", state: "not-ready", summary: check.title, checks: [check], tips: [] };
}

/** Reads the phone and says whether tests can run on it. Never throws for something the phone says; a call that fails is a check it could not make. */
export async function checkPhoneReady(call: ReadyCall, i: ReadyInput): Promise<PhoneReadiness> {
    if (i.adbState !== "device") return notConnected(i);
    const prop = (name: ReadyProp) => safe(call, ["shell", "getprop", name]).then((t) => (t === undefined ? undefined : clean(t) || undefined));
    const [release, sdkText, manufacturer, brand, model] = await Promise.all([prop("ro.build.version.release"), prop("ro.build.version.sdk"), prop("ro.product.manufacturer"), prop("ro.product.brand"), prop("ro.product.model")]);
    const sdk = sdkText && /^\d+$/.test(sdkText) ? Number(sdkText) : undefined;
    const maker = i.emulator ? "google" : makerOf(manufacturer, brand);
    const checks: ReadyCheck[] = [{ id: "authorized", status: "ok", title: "USB debugging is allowed for this computer" }];

    // Android version
    if (sdk !== undefined && sdk < MIN_SDK) checks.push({ id: "android", status: "problem", title: `Android ${release ?? sdk} is too old for phone tests`, detail: "Phone tests need Android 5 or newer." });
    else checks.push({ id: "android", status: release || sdk ? "ok" : "info", title: release || sdk ? `Android ${release ?? "?"}${sdk ? ` (API ${sdk})` : ""}` : "The phone did not say its Android version" });

    // Screen on, not locked
    const [power, win] = await Promise.all([safe(call, ["shell", "dumpsys", "power"]), safe(call, ["shell", "dumpsys", "window"])]);
    const on = power === undefined ? undefined : screenOnFrom(power);
    const locked = win === undefined ? false : lockedFrom(win);
    if (locked) checks.push({ id: "screen", status: "problem", title: "The phone is locked", detail: "Tests cannot unlock a phone with a PIN, pattern or fingerprint.", steps: ["Unlock the phone.", "For a phone used only for tests, set Screen lock to None or Swipe (Settings, Security or Lock screen)."] });
    else if (on === false) checks.push({ id: "screen", status: "attention", title: "The screen is off", detail: "Tests wake the phone before they start, but a screen that locks itself stops them.", steps: ["Press the power button and unlock the phone.", "Turn on “Keep the screen on while charging” below so it stays on."] });
    else checks.push({ id: "screen", status: on === undefined ? "info" : "ok", title: on === undefined ? "The phone did not say whether the screen is on" : "The screen is on and unlocked" });

    // Stay awake while charging (emulators never sleep this way)
    let stayAwake: PhoneReadiness["stayAwake"];
    if (!i.emulator) {
        const v = await safe(call, ["shell", "settings", "get", "global", STAY_ON_KEY]);
        if (v !== undefined) {
            const value = /^\d+$/.test(clean(v)) ? clean(v) : "0";
            stayAwake = { value, on: Number(value) > 0 };
            if (stayAwake.on) checks.push({ id: "stay-awake", status: "ok", title: "The screen stays on while the phone charges", ...(i.savedStayAwake !== undefined ? { action: "stay-awake-restore" as const } : {}) });
            else checks.push({ id: "stay-awake", status: "attention", title: "The screen turns off while the phone charges", detail: "A screen that turns off in the middle of a run stops the test.", steps: ["Open Developer options and turn on Stay awake, or choose Keep the screen on while charging here."], action: "stay-awake-on" });
        }
    }

    // Animations
    let animations: PhoneReadiness["animations"];
    const scales = await Promise.all(ANIMATION_KEYS.map((k) => safe(call, ["shell", "settings", "get", "global", k])));
    if (scales.every((s) => s !== undefined)) {
        const [window, transition, animator] = scales.map((s) => scaleOf(s!)) as [string, string, string];
        animations = { window, transition, animator, off: [window, transition, animator].every(isOff) };
        if (animations.off) checks.push({ id: "animations", status: "ok", title: "Animations are off, so tests do not wait for them", ...(i.savedAnimations ? { action: "animations-restore" as const } : {}) });
        else checks.push({ id: "animations", status: "attention", title: "Animations are on", detail: "Moving screens make tests slower and less steady. Turning them off is the usual setting for test phones, and you can put them back at any time.", steps: ["Open Developer options and set Window animation scale, Transition animation scale and Animator duration scale to Animation off, or choose Turn animations off for tests here."], action: "animations-off" });
    }

    // Battery
    const batt = await safe(call, ["shell", "dumpsys", "battery"]);
    const battery = batt === undefined ? undefined : batteryFrom(batt);
    if (battery && !i.emulator) {
        if (battery.level < LOW_BATTERY && !battery.charging) checks.push({ id: "battery", status: "attention", title: `The battery is low (${battery.level}%) and not charging`, steps: ["Plug the phone into a charger or a USB port that charges it."] });
        else checks.push({ id: "battery", status: "ok", title: `Battery ${battery.level}%${battery.charging ? ", charging" : ""}` });
    }

    // Users: the current one, and any second user (work profile, parallel apps) explained
    const current = Number(clean((await safe(call, ["shell", "am", "get-current-user"])) ?? "0")) || 0;
    const userList = usersFrom((await safe(call, ["shell", "pm", "list", "users"])) ?? "");
    const others = userList.filter((u) => u.id !== current);
    let users: PhoneReadiness["users"];
    let launcher: string | undefined;

    if (i.appPackage) {
        const pkg = i.appPackage;
        const appFor: number[] = [];
        const helperListed: Record<string, boolean> = {};
        for (const u of userList.length ? userList : [{ id: current, name: "" }]) {
            const list = await safe(call, ["shell", "pm", "list", "packages", "--user", String(u.id)]);
            if (list === undefined) continue;
            if (listed(list, pkg)) appFor.push(u.id);
            if (u.id === current) for (const h of HELPER_PACKAGES) helperListed[h] = listed(list, h);
        }
        users = { current, list: userList, appFor };
        const nameOf = (id: number) => userList.find((u) => u.id === id)?.name ?? `user ${id}`;
        if (appFor.includes(current)) checks.push({ id: "app", status: "ok", title: `${pkg} is installed for the phone’s main user` });
        else if (appFor.length) {
            checks.push({
                id: "app",
                status: i.hasApk ? "attention" : "problem",
                title: `${pkg} is installed only for ${nameOf(appFor[0]!)} (user ${appFor[0]}), not for the phone’s main user`,
                detail: "Tests always use the phone’s current user, so they cannot open a copy that lives only in a second user (a parallel app, app twin or work profile).",
                steps: i.hasApk ? ["The platform installs the uploaded app for the main user before the first test."] : ["Install the app from the store on the phone’s main user (not as a parallel app), or upload its .apk under Mobile app."],
            });
        } else if (i.hasApk) checks.push({ id: "app", status: "info", title: `${pkg} is not on the phone yet`, detail: "The platform installs it from the uploaded app file before the first test." });
        else checks.push({ id: "app", status: "problem", title: `${pkg} is not installed on this phone`, steps: ["Install the app on the phone from its store, or upload its .apk under Mobile app."] });

        if (appFor.includes(current)) {
            const resolve: LauncherResolver = i.resolveLauncher ?? (async (p, u) => launcherFrom(await call(["shell", "cmd", "package", "resolve-activity", "--brief", "--user", String(u), "-c", "android.intent.category.LAUNCHER", p]), p));
            const r = await resolve(pkg, current).catch(() => ({ problem: "The phone did not answer which screen opens the app." }) as LauncherAnswer);
            if (r.component) {
                launcher = r.component;
                checks.push({ id: "launcher", status: "ok", title: `The app opens with ${r.component.replace(`${pkg}/`, "")}` });
            } else checks.push({ id: "launcher", status: "problem", title: "The app cannot be opened the usual way", detail: r.problem ?? "No launcher screen was found.", steps: ["Open the app once by hand on the phone and close it again.", "If the phone asks which copy to open, remove the parallel copy or choose Always for the main one."] });
        }

        // The test helper: installed by the first test; the maker may freeze it.
        if (!i.emulator && Object.keys(helperListed).length) {
            const installed = HELPER_PACKAGES.every((h) => helperListed[h]);
            const freezes = maker === "oneplus" || maker === "xiaomi" || maker === "samsung" || maker === "vivo" || maker === "huawei";
            checks.push({
                id: "helper",
                status: "info",
                title: installed ? "The test helper (UiAutomator2 server) is installed" : "The test helper (UiAutomator2 server) is installed by the first phone test",
                detail: installed ? (freezes ? "Let it run in the background (see the tips for this phone below), or tests may be slow or lose the connection." : "Nothing to do.") : "Accept the installation on the phone if it asks.",
            });
        }
    }
    if (others.length) {
        const list = others.map((u) => `${u.name} (user ${u.id})`).join(", ");
        checks.push({
            id: "users",
            status: "info",
            title: `This phone has another user: ${list}`,
            detail: `Tests and the AI use the phone’s current user (${current === 0 ? "the main user" : `user ${current}`}) only. Phones keep parallel apps, app twins and work profiles in such a user; the copy of the app there is never used, and Android may ask which copy to open, which the platform avoids by naming the user.`,
        });
    }

    const state: ReadyState = checks.some((c) => c.status === "problem") ? "not-ready" : checks.some((c) => c.status === "attention") ? "attention" : "ready";
    const firstIssue = checks.find((c) => c.status === "problem") ?? checks.find((c) => c.status === "attention");
    const name = model ?? i.model ?? i.serial;
    const summary = state === "ready" ? `${name} is ready for tests` : `${name}: ${firstIssue!.title.charAt(0).toLowerCase()}${firstIssue!.title.slice(1)}`;
    return {
        serial: i.serial,
        emulator: i.emulator,
        ...(model ?? i.model ? { model: model ?? i.model } : {}),
        ...(manufacturer ? { manufacturer } : {}),
        maker,
        ...(release ? { androidVersion: release } : {}),
        ...(sdk !== undefined ? { sdk } : {}),
        state,
        summary,
        checks,
        ...(animations ? { animations } : {}),
        ...(stayAwake ? { stayAwake } : {}),
        ...(battery ? { battery } : {}),
        ...(users ? { users } : {}),
        ...(launcher ? { launcher } : {}),
        tips: i.emulator ? [] : OEM_TIPS[maker],
    };
}

// ── the two reversible changes ──────────────────────────────────────────────

/** Words for a refused `settings put` (OnePlus without "Disable permission monitoring", Xiaomi without "USB debugging (Security settings)"). */
export function refusedChangeWords(maker: MakerId, what: string): string {
    if (maker === "oneplus") return `The phone refused to ${what}. Turn on Disable permission monitoring in Developer options (see the tips for this phone), then try again.`;
    if (maker === "xiaomi") return `The phone refused to ${what}. Turn on USB debugging (Security settings) in Developer options (see the tips for this phone), then try again.`;
    return `The phone refused to ${what}. Change it by hand in Developer options instead.`;
}

/** `settings put` answers nothing when it worked; a SecurityException or "Permission denial" when the phone refused. */
const refused = (out: string) => /exception|denial|not allowed|permission/i.test(out);

export type Saved = { window: string; transition: string; animator: string };

/** Sets the three animation scales to 0 and returns what they were, so they can be put back. Throws an Error with plain words when refused. */
export async function turnAnimationsOff(call: ReadyCall, maker: MakerId): Promise<Saved> {
    const before = await Promise.all(ANIMATION_KEYS.map(async (k) => scaleOf(await call(["shell", "settings", "get", "global", k]))));
    const saved: Saved = { window: before[0]!, transition: before[1]!, animator: before[2]! };
    await putAll(call, maker, "turn animations off", { window_animation_scale: "0", transition_animation_scale: "0", animator_duration_scale: "0" });
    return saved;
}

/** Puts the three animation scales back to what they were before (or to Android's default, 1, when nothing was saved). */
export async function restoreAnimations(call: ReadyCall, maker: MakerId, saved: Saved | undefined): Promise<void> {
    const s = saved ?? { window: "1", transition: "1", animator: "1" };
    // A saved "0" would leave them off: put back Android's default instead (the person asked to turn them on).
    const v = (x: string) => (isOff(x) ? "1" : x);
    await putAll(call, maker, "turn animations back on", { window_animation_scale: v(s.window), transition_animation_scale: v(s.transition), animator_duration_scale: v(s.animator) });
}

async function putAll(call: ReadyCall, maker: MakerId, what: string, values: Record<AnimationKey, string>): Promise<void> {
    for (const k of ANIMATION_KEYS) {
        let out = "";
        try {
            out = await call(["shell", "settings", "put", "global", k, values[k]]);
        } catch (e) {
            throw new Error(refusedChangeWords(maker, what), { cause: e });
        }
        if (refused(out)) throw new Error(refusedChangeWords(maker, what));
    }
    // Read back: some phones accept the command and change nothing.
    const after = await Promise.all(ANIMATION_KEYS.map(async (k) => scaleOf(await call(["shell", "settings", "get", "global", k]))));
    if (ANIMATION_KEYS.some((k, n) => Number(after[n]) !== Number(values[k]))) throw new Error(refusedChangeWords(maker, what));
}

/** USB (2) and AC (1) charging keep the screen on: 3. Returns the value before, to put back. */
export async function keepScreenOn(call: ReadyCall, maker: MakerId): Promise<string> {
    const before = clean(await call(["shell", "settings", "get", "global", STAY_ON_KEY]));
    await putStay(call, maker, "keep the screen on while charging", "3");
    return /^\d{1,2}$/.test(before) ? before : "0";
}

export async function restoreScreenOn(call: ReadyCall, maker: MakerId, saved: string | undefined): Promise<void> {
    await putStay(call, maker, "put the screen setting back", saved && /^\d{1,2}$/.test(saved) ? saved : "0");
}

async function putStay(call: ReadyCall, maker: MakerId, what: string, value: string): Promise<void> {
    let out = "";
    try {
        out = await call(["shell", "settings", "put", "global", STAY_ON_KEY, value]);
    } catch (e) {
        throw new Error(refusedChangeWords(maker, what), { cause: e });
    }
    if (refused(out)) throw new Error(refusedChangeWords(maker, what));
    const after = clean(await call(["shell", "settings", "get", "global", STAY_ON_KEY]));
    if (Number(after) !== Number(value)) throw new Error(refusedChangeWords(maker, what));
}
