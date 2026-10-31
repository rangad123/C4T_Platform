/**
 * Pre-flight before phone tests run on a device: is the device in a state to run them at all? Plain sentences, never a test verdict.
 *
 *   online and authorized (from adb's device list) · the screen on (woken once if it is off) and not locked · the app installed for the phone's
 *   current user · its launcher activity resolvable (launcher.ts) · the test helper (UiAutomator2 server) present or installable · enough battery.
 *
 * A failed pre-flight stops the run before any test starts; every test of the run is then reported as "the phone could not run the test", with the
 * reason (mobile-runner.ts). Read-only, except waking a screen that is off (`input keyevent KEYCODE_WAKEUP`, what a press of the power button does).
 */
import { MESSAGES, type Adb, type AdbDevice } from "./adb.js";
import { launcherCall, resolveLauncher, type LaunchResolution, type LauncherCall } from "./launcher.js";
import { batteryFrom, freeDataBytesFrom, lockedFrom, screenOnFrom, listed, HELPER_PACKAGES } from "./ready.js";

/** Below this, with no charger, a run is not started: a phone that switches itself off halfway is not a test result. */
export const MIN_BATTERY = 10;
/** Below this, with no charger, the run says so but goes ahead. */
export const LOW_BATTERY = 20;
/**
 * Below this much free space, the run is not started: Android keeps a low-storage reserve (around 500 MB, more on a large device) under
 * which it refuses to install anything, so the test helper (UiAutomator2) cannot be installed and every test would fail at set-up with a
 * raw adb error. A plain message up front is clearer than that.
 */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

export const PREFLIGHT_WORDS = {
    locked: "The phone is locked. Unlock it, and for test runs set its screen lock to None or Swipe, then run the tests again.",
    screenOff: "The phone's screen is off and did not turn on. Turn the screen on and unlock the phone, then run the tests again.",
    battery: (level: number) => `The phone's battery is at ${level}% and it is not charging. Charge it, then run the tests again.`,
    lowBattery: (level: number) => `The phone's battery is at ${level}% and it is not charging; plug it in so it does not switch off during the tests.`,
    helperMissing: "The test helper (UiAutomator2) is not on the phone yet: it is installed at the start of the first run. If the phone asks whether to allow the installation, allow it.",
    helperXiaomi: "On a Xiaomi, Redmi or POCO phone, \"Install via USB\" and \"USB debugging (Security settings)\" must be on in Developer options for the test helper to install.",
    unreachable: "The phone stopped answering before the tests could start. Check the USB cable, unlock the phone, then run the tests again.",
    lowStorage: (freeMb: number) => `The phone has only ${freeMb} MB of free storage, too little to install the test helper (Android keeps about 500 MB in reserve). Free up space on the phone (aim for at least 1 GB free), then run the tests again.`,
} as const;

export interface PreflightInput {
    /** The device as adb lists it. */
    device: AdbDevice;
    /** The app under test (unset: an APK-only project, nothing to resolve). */
    appPackage?: string | undefined;
    /** An APK is installed at the start of the session: a missing app is not a problem then. */
    apkGiven?: boolean | undefined;
}

export interface PreflightResult {
    ok: boolean;
    /** Why the device cannot run the tests, in words for a person. */
    problem?: string;
    /** The launcher resolution, when the app is installed. */
    launch?: LaunchResolution;
    /** Things worth saying that do not stop the run. */
    notes: string[];
}

/** The adb calls pre-flight makes (an Adb bound to the device), or recorded answers in tests. */
export function preflightCall(adb: Adb): LauncherCall {
    // Waking the screen and the maker are the device session's own calls (adb.ts); the rest are the ready check's read-only list or the resolver's.
    return launcherCall(adb);
}

export async function preflight(call: LauncherCall, i: PreflightInput): Promise<PreflightResult> {
    const notes: string[] = [];
    const d = i.device;
    if (d.state === "unauthorized") return { ok: false, problem: MESSAGES.unauthorized, notes };
    if (d.state !== "device") return { ok: false, problem: MESSAGES.offline, notes };
    try {
        // The screen: woken once when it is off (a phone left alone turns it off), then it must be on and unlocked.
        let on = screenOnFrom(await call(["shell", "dumpsys", "power"]).catch(() => ""));
        if (on === false) {
            await call(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => "");
            await new Promise((r) => setTimeout(r, 600));
            on = screenOnFrom(await call(["shell", "dumpsys", "power"]).catch(() => ""));
            if (on === false) return { ok: false, problem: PREFLIGHT_WORDS.screenOff, notes };
        }
        if (lockedFrom(await call(["shell", "dumpsys", "window"]))) return { ok: false, problem: PREFLIGHT_WORDS.locked, notes };

        // Battery (a real phone only: an emulator always reports a full one).
        if (!d.emulator) {
            const b = batteryFrom(await call(["shell", "dumpsys", "battery"]).catch(() => ""));
            if (b && !b.charging && b.level < MIN_BATTERY) return { ok: false, problem: PREFLIGHT_WORDS.battery(b.level), notes };
            if (b && !b.charging && b.level < LOW_BATTERY) notes.push(PREFLIGHT_WORDS.lowBattery(b.level));
        }

        // Free storage: too little and the test helper cannot install, so the whole run would fail at set-up. Unreadable df does not block.
        const free = freeDataBytesFrom(await call(["shell", "df", "-k", "/data"]).catch(() => ""));
        if (free !== undefined && free < MIN_FREE_BYTES) return { ok: false, problem: PREFLIGHT_WORDS.lowStorage(Math.round(free / (1024 * 1024))), notes };

        // The app and the screen that opens it, for the phone's current user.
        let launch: LaunchResolution | undefined;
        if (i.appPackage) {
            const r = await resolveLauncher(call, i.appPackage, { allowMonkey: true });
            const missing = /is not installed for the phone's current user/.test(r.problem ?? "");
            if (r.component) launch = r;
            else if (!(missing && i.apkGiven)) return { ok: false, problem: r.problem ?? "The app cannot be opened on this phone.", notes: [...notes, ...r.notes] };
            notes.push(...r.notes);
            // The helper: installed by Appium at the first run; on some makers the phone has to allow that.
            const user = r.user;
            const pkgs = await call(["shell", "pm", "list", "packages", "--user", String(user)]).catch(() => "");
            if (/package:/.test(pkgs) && !listed(pkgs, HELPER_PACKAGES[0])) {
                notes.push(PREFLIGHT_WORDS.helperMissing);
                const maker = (await call(["shell", "getprop", "ro.product.manufacturer"]).catch(() => "")).replace(/\r/g, "").trim();
                if (/xiaomi|redmi|poco/i.test(maker)) notes.push(PREFLIGHT_WORDS.helperXiaomi);
            }
        }
        return { ok: true, ...(launch ? { launch } : {}), notes };
    } catch (e) {
        // A phone that does not answer at all: the plain adb words when there are any.
        const msg = e instanceof Error && e.name === "AdbError" ? e.message : PREFLIGHT_WORDS.unreachable;
        return { ok: false, problem: msg, notes };
    }
}
