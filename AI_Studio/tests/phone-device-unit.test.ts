/**
 * Round 24, DEVICE (fast tier, no adb, no phone, no browser): "Is this phone ready?" on recorded adb answers per phone maker, animations off and
 * back, keep the screen on and back, the closed command lists, the project's phone settings, and the sign-in helper on the in-memory phone
 * (filling from the test account, an e-mail first then a password, details refused, a one-time code that pauses for a person, a captcha,
 * "Already signed in on this phone", never tapping log out).
 */
import { describe, expect, it } from "vitest";
import { allowedChangeCommand, allowedReadCommand } from "../src/engine/mobile/device/setup-commands.js";
import { batteryFrom, checkPhoneReady, freeDataBytesFrom, keepScreenOn, launcherFrom, makerOf, OEM_TIPS, restoreAnimations, restoreScreenOn, screenOnFrom, turnAnimationsOff, usersFrom, type ReadyCall, type ReadyInput } from "../src/engine/mobile/device/ready.js";
import { DEPTHS, PHONE_DEPTHS, chosenSerial, effectiveRunsOn, keptPhoneSettings, phoneSettingsProblem, publicPhoneSettings, runsOnSentence, startRules } from "../src/engine/mobile/phone-settings.js";
import { MobileTargetSchema } from "../src/engine/mobile/target.js";
import { PERSON_MESSAGES, readAuthScreen, signInOnPhone, type PersonAnswer, type PersonGate, type PersonQuestion } from "../src/engine/mobile/explore/signin.js";
import type { ScreenElement, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { MemoryDevice, type AppDef } from "./fixtures/memory-device.js";
import { coverageCounts, coverageOf, coverageSentence, currentChoiceKey, openQuestionOf, timeLeft, whereChoices, type PhoneSettingsAnswer, type Phone } from "../web/src/features/phonedevice/phonedevice.js";
import { phoneReadyLine } from "../src/agent/phone-ready-lines.js";

// ── a recorded phone ─────────────────────────────────────────────────────────

interface FakePhone {
    maker?: [manufacturer: string, brand: string, model: string];
    release?: string;
    sdk?: string;
    screen?: "on" | "off";
    locked?: boolean;
    battery?: { level: number; usb: boolean };
    settings?: Record<string, string>;
    users?: Array<[number, string]>;
    /** Packages per user. */
    packages?: Record<number, string[]>;
    resolve?: string;
    refuse?: boolean;
    /** Answers that pretend to change but do not. */
    ignoresPuts?: boolean;
}

/** A ReadyCall that answers like a phone (Windows line ends, \r\n, on purpose) and keeps the settings it is given. */
function fakePhone(p: FakePhone): ReadyCall & { calls: string[]; settings: Record<string, string> } {
    const settings: Record<string, string> = { window_animation_scale: "1.0", transition_animation_scale: "1.0", animator_duration_scale: "1.0", stay_on_while_plugged_in: "0", ...p.settings };
    const calls: string[] = [];
    const users = p.users ?? [[0, "Owner"]];
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const fn = (async (args: string[]) => {
        const line = args.join(" ");
        calls.push(line);
        if (!allowedReadCommand(args) && !allowedChangeCommand(args)) throw new Error(`refused: ${line}`);
        const [, a, b, c, d, e] = args;
        if (a === "getprop") {
            const m = p.maker ?? ["Google", "google", "Pixel 7"];
            const v = { "ro.build.version.release": p.release ?? "14", "ro.build.version.sdk": p.sdk ?? "34", "ro.product.manufacturer": m[0], "ro.product.brand": m[1], "ro.product.model": m[2], "ro.build.display.id": "X" }[b!];
            return crlf(`${v ?? ""}\n`);
        }
        if (a === "dumpsys" && b === "power") return crlf(`POWER MANAGER\n  mWakefulness=${p.screen === "off" ? "Asleep" : "Awake"}\n`);
        // A genuinely locked phone has the keyguard in front and no app focused; unlocked shows the app. (Some emulators leave the flag set on the home screen, covered in device-session-unit.)
        if (a === "dumpsys" && b === "window") return crlf(p.locked === true ? `  mCurrentFocus=Window{1 u0 StatusBar}\n  mFocusedApp=null\n  isKeyguardShowing=true\n` : `  mCurrentFocus=Window{1 u0 com.x/.Main}\n  isKeyguardShowing=false\n`);
        if (a === "dumpsys" && b === "battery") return crlf(`Current Battery Service state:\n  AC powered: false\n  USB powered: ${p.battery?.usb ?? true}\n  status: ${p.battery?.usb === false ? 3 : 2}\n  level: ${p.battery?.level ?? 80}\n`);
        if (a === "settings" && b === "get") return crlf(`${settings[d!] ?? "null"}\n`);
        if (a === "settings" && b === "put") {
            if (p.refuse) return "Exception occurred while executing 'put':\njava.lang.SecurityException: Permission denial: writing to settings requires:android.permission.WRITE_SECURE_SETTINGS\n";
            if (!p.ignoresPuts) settings[d!] = e!;
            return "";
        }
        if (a === "am" && b === "get-current-user") return "0\r\n";
        if (a === "pm" && b === "list" && c === "users") return crlf(`Users:\n${users.map(([id, n]) => `\tUserInfo{${id}:${n}:c13} running`).join("\n")}\n`);
        if (a === "pm" && b === "list" && c === "packages") return crlf(`${(p.packages?.[Number(e)] ?? []).map((x) => `package:${x}`).join("\n")}\n`);
        if (a === "cmd") return crlf(p.resolve ?? "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.linkedin.android/.authenticator.LaunchActivity\n");
        throw new Error(`no answer for ${line}`);
    }) as ReadyCall & { calls: string[]; settings: Record<string, string> };
    fn.calls = calls;
    fn.settings = settings;
    return fn;
}

const LI = "com.linkedin.android";
const base: ReadyInput = { serial: "R58N20ABCDE", adbState: "device", emulator: false, appPackage: LI };
const byId = (r: Awaited<ReturnType<typeof checkPhoneReady>>, id: string) => r.checks.find((c) => c.id === id);

describe("Is this phone ready? (recorded answers per maker)", () => {
    it("a OnePlus with Android 15 and a parallel-apps user: the second user is explained, the OnePlus tips are given, animations are offered", async () => {
        const phone = fakePhone({ maker: ["OnePlus", "OnePlus", "CPH2467"], release: "15", sdk: "35", users: [[0, "Owner"], [999, "MultiApp"]], packages: { 0: [LI], 999: [LI, "com.whatsapp"] } });
        const r = await checkPhoneReady(phone, base);
        expect(r.maker).toBe("oneplus");
        expect(r.model).toBe("CPH2467");
        expect(r.androidVersion).toBe("15");
        expect(r.sdk).toBe(35);
        expect(byId(r, "android")!.title).toBe("Android 15 (API 35)");
        expect(byId(r, "app")!.status).toBe("ok");
        expect(byId(r, "launcher")!.title).toBe("The app opens with .authenticator.LaunchActivity");
        expect(r.launcher).toBe(`${LI}/.authenticator.LaunchActivity`);
        const users = byId(r, "users")!;
        expect(users.status).toBe("info");
        expect(users.title).toBe("This phone has another user: MultiApp (user 999)");
        expect(users.detail).toMatch(/current user .*only/);
        expect(r.users).toEqual({ current: 0, list: [{ id: 0, name: "Owner" }, { id: 999, name: "MultiApp" }], appFor: [0, 999] });
        expect(byId(r, "animations")).toMatchObject({ status: "attention", action: "animations-off" });
        expect(byId(r, "stay-awake")).toMatchObject({ status: "attention", action: "stay-awake-on" });
        expect(r.state).toBe("attention");
        expect(r.summary).toBe("CPH2467: the screen turns off while the phone charges");
        expect(r.tips.map((t) => t.title)).toEqual(["Turn on Disable permission monitoring", "Let the test helper run in the background"]);
        expect(r.tips[1]!.steps.join(" ")).toContain("io.appium.uiautomator2.server");
        expect(r.tips[1]!.steps.join(" ")).toContain("Allow background activity");
        // read-only: nothing but the READ list was asked
        expect(phone.calls.every((c) => allowedReadCommand(c.split(" ")))).toBe(true);
        expect(phone.calls.some((c) => c.includes(" put "))).toBe(false);
    });

    it("the app only in the parallel-apps user is a problem, said in words, and not a test verdict", async () => {
        const r = await checkPhoneReady(fakePhone({ maker: ["OnePlus", "OnePlus", "CPH2467"], users: [[0, "Owner"], [999, "MultiApp"]], packages: { 0: ["com.whatsapp"], 999: [LI] } }), base);
        expect(r.state).toBe("not-ready");
        expect(byId(r, "app")).toMatchObject({ status: "problem", title: `${LI} is installed only for MultiApp (user 999), not for the phone’s main user` });
        expect(byId(r, "app")!.steps!.join(" ")).toMatch(/main user/);
        expect(byId(r, "launcher")).toBeUndefined();
    });

    it("with an uploaded .apk a missing app is not a problem (the platform installs it)", async () => {
        const r = await checkPhoneReady(fakePhone({ packages: { 0: [] } }), { ...base, hasApk: true });
        expect(byId(r, "app")).toMatchObject({ status: "info", title: `${LI} is not on the phone yet` });
        const missing = await checkPhoneReady(fakePhone({ packages: { 0: [] } }), base);
        expect(byId(missing, "app")).toMatchObject({ status: "problem", title: `${LI} is not installed on this phone` });
    });

    it("Xiaomi, Samsung, vivo and Huawei phones each get their own exact menu steps; a Pixel and an emulator get none", async () => {
        const tipsOf = async (maker: [string, string, string]) => (await checkPhoneReady(fakePhone({ maker, packages: { 0: [LI] } }), base)).tips.map((t) => t.title);
        expect(await tipsOf(["Xiaomi", "Redmi", "23090RA98G"])).toEqual(["Turn on USB debugging (Security settings)", "Let the test helper start by itself"]);
        expect(await tipsOf(["samsung", "samsung", "SM-A546B"])).toEqual(["Turn off Auto Blocker", "Let the test helper run without battery limits"]);
        expect(await tipsOf(["vivo", "vivo", "V2312"])).toEqual(["Allow installing and controlling over USB"]);
        expect(await tipsOf(["HUAWEI", "HUAWEI", "ELS-NX9"])).toEqual(["Keep USB debugging on while charging"]);
        expect(await tipsOf(["Google", "google", "Pixel 7"])).toEqual([]);
        expect(OEM_TIPS.xiaomi[0]!.steps.join(" ")).toContain("USB debugging (Security settings)");
        const emu = await checkPhoneReady(fakePhone({ packages: { 0: [LI] } }), { ...base, serial: "emulator-5554", emulator: true });
        expect(emu.tips).toEqual([]);
        expect(byId(emu, "stay-awake")).toBeUndefined();
        expect(byId(emu, "battery")).toBeUndefined();
        expect(makerOf("OPPO")).toBe("oneplus");
        expect(makerOf("realme")).toBe("oneplus");
        expect(makerOf("Xiaomi", "POCO")).toBe("xiaomi");
        expect(makerOf("HONOR")).toBe("huawei");
        expect(makerOf("motorola")).toBe("other");
    });

    it("a phone that is ready says so in one sentence", async () => {
        const r = await checkPhoneReady(fakePhone({ settings: { window_animation_scale: "0.0", transition_animation_scale: "0", animator_duration_scale: "0", stay_on_while_plugged_in: "3" }, packages: { 0: [LI, "io.appium.uiautomator2.server", "io.appium.uiautomator2.server.test"] } }), base);
        expect(r.state).toBe("ready");
        expect(r.summary).toBe("Pixel 7 is ready for tests");
        expect(byId(r, "animations")).toMatchObject({ status: "ok" });
        expect(byId(r, "animations")!.action).toBeUndefined();
        expect(byId(r, "helper")).toMatchObject({ status: "info", title: "The test helper (UiAutomator2 server) is installed" });
        // With values saved by this project, the undo is offered.
        const saved = await checkPhoneReady(fakePhone({ settings: { window_animation_scale: "0", transition_animation_scale: "0", animator_duration_scale: "0" }, packages: { 0: [LI] } }), { ...base, savedAnimations: { window: "1.0", transition: "1.0", animator: "0.5" } });
        expect(byId(saved, "animations")!.action).toBe("animations-restore");
    });

    it("locked, screen off, low battery, too old: each in words with what to do", async () => {
        const locked = await checkPhoneReady(fakePhone({ locked: true, packages: { 0: [LI] } }), base);
        expect(byId(locked, "screen")).toMatchObject({ status: "problem", title: "The phone is locked" });
        expect(locked.state).toBe("not-ready");
        const off = await checkPhoneReady(fakePhone({ screen: "off", packages: { 0: [LI] } }), base);
        expect(byId(off, "screen")).toMatchObject({ status: "attention", title: "The screen is off" });
        const low = await checkPhoneReady(fakePhone({ battery: { level: 12, usb: false }, packages: { 0: [LI] } }), base);
        expect(byId(low, "battery")).toMatchObject({ status: "attention", title: "The battery is low (12%) and not charging" });
        const old = await checkPhoneReady(fakePhone({ release: "4.4", sdk: "19", packages: { 0: [LI] } }), base);
        expect(byId(old, "android")).toMatchObject({ status: "problem", title: "Android 4.4 is too old for phone tests" });
    });

    it("unauthorized and offline phones stop at the first check with the steps to fix them", async () => {
        const phone = fakePhone({});
        const u = await checkPhoneReady(phone, { ...base, adbState: "unauthorized" });
        expect(u.state).toBe("not-ready");
        expect(u.checks).toHaveLength(1);
        expect(u.checks[0]).toMatchObject({ id: "authorized", status: "problem", title: "This computer is not allowed to use the phone yet" });
        expect(u.checks[0]!.steps!.join(" ")).toContain("Allow USB debugging?");
        expect(phone.calls).toEqual([]);
        const o = await checkPhoneReady(phone, { ...base, adbState: "offline" });
        expect(o.checks[0]!.title).toBe("The phone is connected but offline");
    });

    it("the launcher: the shared resolver when given, the chooser refused, \\r trimmed", async () => {
        const viaShared = await checkPhoneReady(fakePhone({ packages: { 0: [LI] } }), { ...base, resolveLauncher: async (pkg, user) => ({ component: `${pkg}/.Shared${user}` }) });
        expect(viaShared.launcher).toBe(`${LI}/.Shared0`);
        const chooser = await checkPhoneReady(fakePhone({ packages: { 0: [LI] }, resolve: "priority=0\nandroid/com.android.internal.app.ResolverActivity\n" }), base);
        expect(byId(chooser, "launcher")).toMatchObject({ status: "problem" });
        expect(byId(chooser, "launcher")!.detail).toMatch(/choice of apps/);
        expect(launcherFrom(`x\r\n${LI}/.Main \r\n`, LI)).toEqual({ component: `${LI}/.Main` });
        expect(launcherFrom("No activity found\r\n", LI).problem).toMatch(/no screen/);
    });

    it("parses the phone's own words", () => {
        expect(screenOnFrom("Display Power: state=OFF")).toBe(false);
        expect(screenOnFrom("mWakefulness=Dozing")).toBe(false);
        expect(screenOnFrom("nothing")).toBeUndefined();
        expect(batteryFrom("  level: 55\r\n  AC powered: true\r\n")).toEqual({ level: 55, charging: true });
        expect(usersFrom("Users:\r\n\tUserInfo{0:Owner:c13} running\r\n\tUserInfo{10:Work profile:1030}\r\n")).toEqual([{ id: 0, name: "Owner" }, { id: 10, name: "Work profile" }]);
        // df -k: the Available column (before Use%) × 1024, even when the mount path differs; unreadable output is undefined.
        expect(freeDataBytesFrom("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-73 109051904 106000000 3051904 98% /data\n")).toBe(3051904 * 1024);
        expect(freeDataBytesFrom("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-73 104857600 104448000 409600 100% /storage/emulated/999/Android/data\n")).toBe(409600 * 1024);
        expect(freeDataBytesFrom("")).toBeUndefined();
        expect(freeDataBytesFrom("df: /data: Permission denied")).toBeUndefined();
    });
});

describe("animations off for tests, and back (reversible)", () => {
    it("saves what the phone had, sets the three scales to 0, then puts exactly those back", async () => {
        const phone = fakePhone({ settings: { window_animation_scale: "1.0", transition_animation_scale: "0.5", animator_duration_scale: "1.5" } });
        const saved = await turnAnimationsOff(phone, "google");
        expect(saved).toEqual({ window: "1.0", transition: "0.5", animator: "1.5" });
        expect([phone.settings.window_animation_scale, phone.settings.transition_animation_scale, phone.settings.animator_duration_scale]).toEqual(["0", "0", "0"]);
        await restoreAnimations(phone, "google", saved);
        expect([phone.settings.window_animation_scale, phone.settings.transition_animation_scale, phone.settings.animator_duration_scale]).toEqual(["1.0", "0.5", "1.5"]);
        // Nothing saved (or saved as off): Android's default, 1.
        await restoreAnimations(phone, "google", { window: "0", transition: "0", animator: "0" });
        expect(phone.settings.window_animation_scale).toBe("1");
    });

    it("a OnePlus that refuses says to turn on Disable permission monitoring; a phone that ignores the change is caught by reading back", async () => {
        await expect(turnAnimationsOff(fakePhone({ refuse: true }), "oneplus")).rejects.toThrow("The phone refused to turn animations off. Turn on Disable permission monitoring in Developer options (see the tips for this phone), then try again.");
        await expect(turnAnimationsOff(fakePhone({ refuse: true }), "xiaomi")).rejects.toThrow(/USB debugging \(Security settings\)/);
        await expect(turnAnimationsOff(fakePhone({ ignoresPuts: true }), "samsung")).rejects.toThrow(/Change it by hand in Developer options/);
    });

    it("keeps the screen on while charging and puts the old value back", async () => {
        const phone = fakePhone({ settings: { stay_on_while_plugged_in: "0" } });
        const before = await keepScreenOn(phone, "google");
        expect(before).toBe("0");
        expect(phone.settings.stay_on_while_plugged_in).toBe("3");
        await restoreScreenOn(phone, "google", before);
        expect(phone.settings.stay_on_while_plugged_in).toBe("0");
    });
});

describe("the closed command lists", () => {
    it("allows exactly the ready check's reads and the four reversible settings", () => {
        expect(allowedReadCommand(["shell", "getprop", "ro.build.version.release"])).toBe(true);
        expect(allowedReadCommand(["shell", "getprop", "persist.sys.something"])).toBe(false);
        expect(allowedReadCommand(["shell", "settings", "get", "global", "window_animation_scale"])).toBe(true);
        expect(allowedReadCommand(["shell", "settings", "get", "secure", "android_id"])).toBe(false);
        expect(allowedReadCommand(["shell", "pm", "list", "packages", "--user", "999"])).toBe(true);
        expect(allowedReadCommand(["shell", "pm", "list", "packages", "--user", "0;reboot"])).toBe(false);
        expect(allowedReadCommand(["shell", "df", "-k", "/data"])).toBe(true);
        expect(allowedReadCommand(["shell", "df", "-k", "/system"])).toBe(false);
        expect(allowedReadCommand(["shell", "df"])).toBe(false);
        expect(allowedReadCommand(["shell", "cmd", "package", "resolve-activity", "--brief", "--user", "0", "-c", "android.intent.category.LAUNCHER", LI])).toBe(true);
        expect(allowedReadCommand(["shell", "dumpsys", "package", LI])).toBe(false);
        expect(allowedChangeCommand(["shell", "settings", "put", "global", "window_animation_scale", "0"])).toBe(true);
        expect(allowedChangeCommand(["shell", "settings", "put", "global", "window_animation_scale", "0; reboot"])).toBe(false);
        expect(allowedChangeCommand(["shell", "settings", "put", "global", "adb_enabled", "0"])).toBe(false);
        expect(allowedChangeCommand(["shell", "settings", "put", "global", "stay_on_while_plugged_in", "3.5"])).toBe(false);
        expect(allowedChangeCommand(["shell", "settings", "put", "secure", "window_animation_scale", "0"])).toBe(false);
        // A change is never a read.
        expect(allowedReadCommand(["shell", "settings", "put", "global", "window_animation_scale", "0"])).toBe(false);
    });
});

describe("the project's phone settings", () => {
    const explored = { serial: "R58N20ABCDE", model: "CPH2467", emulator: false };
    it("defaults: the phone the AI explored on when it was a real phone, else automatic", () => {
        expect(effectiveRunsOn(undefined)).toEqual({ kind: "auto" });
        expect(effectiveRunsOn({ exploredOn: explored })).toEqual({ kind: "explored" });
        expect(effectiveRunsOn({ exploredOn: { ...explored, serial: "emulator-5554", emulator: true } })).toEqual({ kind: "auto" });
        expect(effectiveRunsOn({ runsOn: { kind: "emulator" }, exploredOn: explored })).toEqual({ kind: "emulator" });
        expect(chosenSerial({ exploredOn: explored })).toBe("R58N20ABCDE");
        expect(chosenSerial({ runsOn: { kind: "phone", serial: "R58M", model: "Galaxy" } })).toBe("R58M");
        expect(runsOnSentence({ exploredOn: explored })).toBe("Phone tests run on the phone the AI explored on, CPH2467 (R58N20ABCDE).");
        expect(runsOnSentence(undefined)).toBe("Phone tests run on a connected phone that has the app, else on an emulator.");
    });

    it("keeps what a change leaves out, clears with null, stores nothing for defaults", () => {
        const cur = { runsOn: { kind: "emulator" as const }, depth: "thorough" as const, keepSignedIn: true, exploredOn: explored };
        expect(keptPhoneSettings(cur, {})).toEqual(cur);
        expect(keptPhoneSettings(cur, { depth: null, runsOn: { kind: "auto" } })).toEqual({ keepSignedIn: true, exploredOn: explored });
        expect(keptPhoneSettings(undefined, { depth: "standard", keepSignedIn: false })).toEqual({});
        expect(publicPhoneSettings({ depth: "quick", phoneSetup: { animations: { a: { window: "1", transition: "1", animator: "1" } } } })).toEqual({ depth: "quick" });
    });

    it("Already signed in and a clean start cannot be on together; it needs the package", () => {
        expect(phoneSettingsProblem({ keepSignedIn: true, cleanStart: true, appPackage: LI })).toMatch(/has to be off/);
        expect(phoneSettingsProblem({ keepSignedIn: true })).toMatch(/package name/);
        expect(phoneSettingsProblem({ keepSignedIn: true, appPackage: LI })).toBeUndefined();
        expect(startRules({ keepSignedIn: true, cleanStart: true })).toEqual({ clearData: false, keepAppData: true });
        expect(startRules({ cleanStart: true })).toEqual({ clearData: true, keepAppData: false });
    });

    it("the depths say their numbers, and the mobile app schema keeps the new fields", () => {
        expect(PHONE_DEPTHS).toEqual(["quick", "standard", "thorough"]);
        expect([DEPTHS.quick.screens, DEPTHS.standard.screens, DEPTHS.thorough.screens]).toEqual([40, 150, 300]);
        expect([DEPTHS.quick.actions, DEPTHS.standard.actions, DEPTHS.thorough.actions]).toEqual([150, 600, 1200]);
        expect([DEPTHS.quick.ideas, DEPTHS.standard.ideas, DEPTHS.thorough.ideas]).toEqual([15, 40, 80]);
        const t = MobileTargetSchema.parse({ appPackage: LI, runsOn: { kind: "phone", serial: "R58N20ABCDE", model: "CPH2467" }, depth: "quick", keepSignedIn: true, exploredOn: explored });
        expect(t).toMatchObject({ runsOn: { kind: "phone", serial: "R58N20ABCDE" }, depth: "quick", keepSignedIn: true });
        expect(MobileTargetSchema.safeParse({ appPackage: LI, runsOn: { kind: "phone", serial: "bad serial; rm" } }).success).toBe(false);
        expect(MobileTargetSchema.safeParse({ appPackage: LI, depth: "endless" }).success).toBe(false);
    });
});

// ── sign-in on the in-memory phone ──────────────────────────────────────────

const el = (o: Partial<ScreenElement> & { index: number }): ScreenElement => ({ cls: "TextView", text: "", desc: "", id: "", clickable: false, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, o.index * 50, 360, o.index * 50 + 44], ...o });
const snapOf = (elements: ScreenElement[]): ScreenSnapshot => ({ package: LI, width: 360, height: 640, elements, fingerprint: "f", keyboard: false, outsideApp: false });

describe("what a screen asks for", () => {
    it("a user name and password, an e-mail first, a code (by words or by boxes), a captcha, nothing", () => {
        const pw = readAuthScreen(snapOf([el({ index: 0, text: "Sign in" }), el({ index: 1, cls: "EditText", editable: true, clickable: true, text: "Email or phone", id: "username" }), el({ index: 2, cls: "EditText", editable: true, clickable: true, password: true, id: "password" }), el({ index: 3, cls: "Button", clickable: true, text: "Forgot password?" }), el({ index: 4, cls: "Button", clickable: true, text: "Sign in" })]));
        expect(pw.kind).toBe("password");
        if (pw.kind === "password") {
            expect(pw.user?.id).toBe("username");
            expect(pw.submit?.text).toBe("Sign in");
        }
        const first = readAuthScreen(snapOf([el({ index: 0, text: "Sign in to LinkedIn" }), el({ index: 1, cls: "EditText", editable: true, clickable: true, text: "Email or phone" }), el({ index: 2, cls: "Button", clickable: true, text: "Continue" }), el({ index: 3, cls: "Button", clickable: true, text: "Continue with Google" })]));
        expect(first).toMatchObject({ kind: "identifier", submit: { text: "Continue" } });
        expect(readAuthScreen(snapOf([el({ index: 0, text: "Enter the 6-digit code we sent to your phone" }), el({ index: 1, cls: "EditText", editable: true, clickable: true, text: "" }), el({ index: 2, cls: "Button", clickable: true, text: "Verify" })])).kind).toBe("code");
        expect(readAuthScreen(snapOf([el({ index: 0, cls: "EditText", editable: true, clickable: true, id: "verification_code" })])).kind).toBe("code");
        const boxes = [0, 1, 2, 3, 4, 5].map((n) => el({ index: n, cls: "EditText", editable: true, clickable: true, bounds: [20 + n * 50, 300, 60 + n * 50, 350] }));
        expect(readAuthScreen(snapOf(boxes)).kind).toBe("code");
        expect(readAuthScreen(snapOf([el({ index: 0, text: "Let’s do a quick security check" }), el({ index: 1, text: "I'm not a robot", clickable: true, checkable: true })])).kind).toBe("captcha");
        expect(readAuthScreen(snapOf([el({ index: 0, text: "Home" }), el({ index: 1, cls: "EditText", editable: true, clickable: true, text: "Search" })])).kind).toBe("none");
    });
});

const APP = "com.example.signin";
/** A small app: home with Sign in; an e-mail screen; a password screen; optionally a code screen; a signed-in home with Log out. */
function signinApp(o: { code?: boolean; captcha?: boolean; oneScreen?: boolean } = {}): AppDef {
    return {
        pkg: APP,
        start: "welcome",
        screens: {
            welcome: { activity: `${APP}.Welcome`, els: () => [{ text: "Welcome" }, { text: "Sign in", tap: o.oneScreen ? "login" : "email" }] },
            email: { activity: `${APP}.Email`, els: () => [{ text: "Sign in to Example" }, { text: "Email or phone", field: "email", id: "email_field" }, { text: "Continue", tap: "password" }, { text: "Continue with Google", tap: "google" }] },
            password: {
                activity: `${APP}.Password`,
                els: (d) => [
                    { text: "Enter your password" },
                    { field: "password", password: true, id: "password_field" },
                    { text: "Forgot password?", tap: "forgot" },
                    {
                        text: "Sign in",
                        tap: (dev) => {
                            if (dev.fields.password === "right-pass") dev.goto(o.captcha ? "captcha" : o.code ? "code" : "home");
                            else dev.state.error = "Wrong password";
                        },
                    },
                    ...(d.state.error ? [{ text: String(d.state.error) }] : []),
                ],
            },
            login: {
                activity: `${APP}.Login`,
                els: () => [{ text: "Log in" }, { field: "user", id: "username", text: "User name" }, { field: "password", password: true, id: "password" }, { text: "Log in", id: "login_button", tap: (dev) => dev.goto(dev.fields.user === "tester" && dev.fields.password === "right-pass" ? "home" : "login") }],
            },
            code: { activity: `${APP}.Code`, els: () => [{ text: "Enter the code we sent to your phone" }, { field: "code", id: "otp_input" }, { text: "Verify", tap: (dev) => dev.goto(dev.fields.code === "123456" ? "home" : "code") }] },
            captcha: { activity: `${APP}.Captcha`, els: () => [{ text: "Security check" }, { text: "I'm not a robot", tap: "home" }] },
            home: { activity: `${APP}.Home`, els: () => [{ text: "Feed" }, { text: "Log out", tap: "welcome" }] },
            forgot: { activity: `${APP}.Forgot`, els: () => [{ text: "Reset your password" }] },
            google: { pkg: "com.google.android.gms", els: () => [{ text: "Choose an account" }] },
        },
    };
}

/** A person on the job page, scripted: what they answer, and what they do on the phone first. */
function person(answer: PersonAnswer, onPhone?: () => void): PersonGate & { asked: PersonQuestion[] } {
    const asked: PersonQuestion[] = [];
    return {
        asked,
        async ask(q) {
            asked.push(q);
            onPhone?.();
            return answer;
        },
    };
}

async function at(dev: MemoryDevice, screen: string): Promise<ScreenSnapshot> {
    dev.goto(screen);
    return dev.snapshot();
}

describe("signing in on the phone", () => {
    const creds = { username: "tester@example.com", password: "right-pass" };

    it("an e-mail first, then the password: both from the test account, as placeholders, and the app is signed in", async () => {
        const dev = new MemoryDevice(signinApp(), { credentials: creds });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true } });
        expect(r.status).toBe("signed-in");
        expect(dev.screen).toBe("home");
        expect(dev.realTyped).toEqual([{ field: "email", text: "tester@example.com" }, { field: "password", text: "right-pass" }]);
        // What is returned (and recorded by the explorer) carries only placeholders, never a value.
        expect(r.steps.filter((s) => s.action.kind === "type").map((s) => (s.action as { text: string }).text)).toEqual(["{{credentials.username}}", "{{credentials.password}}"]);
        // The password never comes back at all; the user name only where the app itself shows it in its field (the explorer scrubs screens it stores).
        expect(JSON.stringify(r)).not.toContain("right-pass");
        expect(JSON.stringify([r.message, r.steps.map((s) => [s.action, s.label])])).not.toContain("tester@example.com");
        expect(dev.tapped).toEqual(["Continue", "Sign in"]);
        expect(r.message).toBe("Signed in with the project's test account.");
    });

    it("a user name and password on one screen, tapped by the button's id", async () => {
        const dev = new MemoryDevice(signinApp({ oneScreen: true }), { credentials: { username: "tester", password: "right-pass" } });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "login"), details: { username: true, password: true } });
        expect(r.status).toBe("signed-in");
        expect(dev.screen).toBe("home");
    });

    it("details the app does not accept: rejected, in words, and never Forgot password", async () => {
        const dev = new MemoryDevice(signinApp(), { credentials: { username: "tester@example.com", password: "wrong" } });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true } });
        expect(r.status).toBe("rejected");
        expect(r.message).toMatch(/were not accepted/);
        expect(dev.tapped).not.toContain("Forgot password?");
    });

    it("no details given: says so and does nothing", async () => {
        const dev = new MemoryDevice(signinApp());
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: false, password: false } });
        expect(r.status).toBe("no-details");
        expect(dev.acts).toEqual([]);
    });

    it("a one-time code pauses and asks a person; the person enters it on the phone and chooses Continue", async () => {
        const dev = new MemoryDevice(signinApp({ code: true }), { credentials: creds });
        const gate = person("continue", () => {
            dev.fields.code = "123456";
            dev.goto("home");
        });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true }, ask: gate, waitMs: 120_000 });
        expect(gate.asked).toEqual([{ kind: "code", message: PERSON_MESSAGES.code, timeoutMs: 120_000, screen: "Enter the code we sent to your phone" }]);
        expect(PERSON_MESSAGES.code).toContain("Enter the code on the phone, then choose Continue.");
        expect(r).toMatchObject({ status: "person-done", asked: "code" });
        expect(dev.screen).toBe("home");
        // The code itself was never typed by the platform.
        expect(dev.realTyped.map((t) => t.field)).toEqual(["email", "password"]);
    });

    it("the person chooses to go on without signing in, or nobody answers in time, or nobody can be asked", async () => {
        for (const [answer, status, words] of [
            ["skip", "person-skipped", /chose to go on without signing in/],
            ["timeout", "no-answer", /No one answered within 2 minutes/],
        ] as const) {
            const dev = new MemoryDevice(signinApp({ code: true }), { credentials: creds });
            const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true }, ask: person(answer), waitMs: 120_000 });
            expect(r.status).toBe(status);
            expect(r.message).toMatch(words);
            expect(dev.screen).toBe("code");
        }
        const dev = new MemoryDevice(signinApp({ code: true }), { credentials: creds });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true } });
        expect(r.status).toBe("no-answer");
        expect(r.message).toMatch(/no one can be asked/);
    });

    it("Continue while the code screen is still there goes on without signing in; a stop while waiting is a stop", async () => {
        const dev = new MemoryDevice(signinApp({ code: true }), { credentials: creds });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true }, ask: person("continue") });
        expect(r.status).toBe("person-skipped");
        expect(r.message).toMatch(/still showing/);
        const dev2 = new MemoryDevice(signinApp({ code: true }), { credentials: creds });
        expect((await signInOnPhone({ session: dev2, snap: await at(dev2, "email"), details: { username: true, password: true }, ask: person("stopped") })).status).toBe("failed");
    });

    it("a captcha is answered by a person too, never tapped by the platform", async () => {
        const dev = new MemoryDevice(signinApp({ captcha: true }), { credentials: creds });
        const gate = person("continue", () => dev.goto("home"));
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: true, password: true }, ask: gate });
        expect(gate.asked[0]!.kind).toBe("captcha");
        expect(r.status).toBe("person-done");
        expect(dev.tapped).not.toContain("I'm not a robot");
    });

    it("Already signed in on this phone, but the app asks to sign in and no details are given: a person signs in by hand", async () => {
        const dev = new MemoryDevice(signinApp());
        const gate = person("continue", () => dev.goto("home"));
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "email"), details: { username: false, password: false }, keepSignedIn: true, ask: gate });
        expect(gate.asked[0]).toMatchObject({ kind: "signed-out", message: PERSON_MESSAGES["signed-out"] });
        expect(r.status).toBe("person-done");
        expect(dev.acts).toEqual([]);
    });

    it("never taps log out, and a screen that is not a sign-in is left alone", async () => {
        const dev = new MemoryDevice(signinApp(), { credentials: creds });
        const r = await signInOnPhone({ session: dev, snap: await at(dev, "home"), details: { username: true, password: true } });
        expect(r.status).toBe("not-sign-in");
        expect(dev.tapped).toEqual([]);
        // A sign-in screen whose only button reads as log out: nothing is tapped.
        const odd = readAuthScreen(snapOf([el({ index: 0, text: "Sign in" }), el({ index: 1, cls: "EditText", editable: true, clickable: true, password: true }), el({ index: 2, cls: "Button", clickable: true, text: "Log out" })]));
        expect(odd.kind === "password" && odd.submit).toBeFalsy();
    });
});

// ── the screens' words (web/src/features/phonedevice/phonedevice.ts) and the runner's check line ──


const settingsAnswer = (o: Partial<PhoneSettingsAnswer> = {}): PhoneSettingsAnswer => ({
    hasApp: true, appPackage: LI, runsOn: null, effective: { kind: "auto" }, sentence: "", exploredOn: null, depth: "standard",
    depths: [], keepSignedIn: false, cleanStart: false, farm: { connections: [], chosen: null }, ...o,
});
const phoneOf = (o: Partial<Phone> = {}): Phone => ({ serial: "R58N20ABCDE", emulator: false, model: "CPH2467", maker: "oneplus", state: "ready", summary: "", checks: [], tips: [], ...o });

describe("the screens' words", () => {
    it("offers each place, says why one cannot be chosen, and keeps a chosen phone that is unplugged", () => {
        const c = whereChoices(settingsAnswer(), [phoneOf(), phoneOf({ serial: "emulator-5554", emulator: true, model: "sdk" })]);
        expect(c.map((x) => [x.label, x.off ?? ""])).toEqual([
            ["Choose for me", ""],
            ["The phone the AI explored on", "Explore the app first."],
            ["CPH2467 (R58N20ABCDE)", ""],
            ["An emulator", ""],
            ["A device farm", "No device farm is set up."],
        ]);
        const unplugged = whereChoices(settingsAnswer({ runsOn: { kind: "phone", serial: "R58M", model: "Galaxy" }, exploredOn: { serial: "R58N20ABCDE", model: "CPH2467", emulator: false } }), []);
        expect(unplugged.find((x) => x.label === "Galaxy (R58M)")!.detail).toMatch(/not connected/);
        expect(unplugged[1]!.off).toBeUndefined();
        expect(currentChoiceKey(settingsAnswer({ runsOn: { kind: "phone", serial: "R58M" } }))).toBe("phone:R58M");
        expect(currentChoiceKey(settingsAnswer({ farm: { connections: [{ id: "f", label: "BS" }], chosen: { id: "f", label: "BS" } } }))).toBe("farm");
    });

    it("reads the exploration's counters and stop reason from its events, and the plan's coverage line", () => {
        const ev = (kind: string, data: unknown, message = "") => ({ id: 1, stage: "discovery", level: "info", kind, message, createdAt: "", data });
        expect(coverageOf([])).toBeUndefined();
        const running = coverageOf([ev("mobile_progress", { screens: 12, activities: 4, actions: 40, aiCalls: 3 })])!;
        expect(coverageCounts(running)).toBe("12 screens seen, 4 activities, 40 actions, 3 AI calls");
        expect(running.done).toBe(false);
        const done = coverageOf([ev("mobile_progress", { screens: 12, activities: 4, actions: 40, aiCalls: 3 }), ev("mobile_exploration_done", { screens: 142, activitiesSeen: Array(31).fill("A"), activitiesListed: 40, actions: 588, aiCalls: 1, stoppedBecause: "No new screens after 80 actions: the app looks fully explored" })])!;
        expect(coverageCounts(done)).toBe("142 screens seen, 31 activities of 40, 588 actions, 1 AI call");
        expect(coverageSentence(done)).toBe("Explored 142 screens across 31 activities (the phone lists 40 for the app); stopped because no new screens after 80 actions: the app looks fully explored.");
    });

    it("finds the question an exploration waits on until it is answered or too late", () => {
        const now = Date.parse("2026-10-24T10:00:00Z");
        const wait = { id: 1, stage: "discovery", level: "warn", kind: "mobile_sign_in_waiting", message: PERSON_MESSAGES.code, createdAt: "", data: { requestId: "r1", kind: "code", deadline: "2026-10-24T10:04:05Z", screen: "Verify" } };
        expect(openQuestionOf([wait], now)).toMatchObject({ requestId: "r1", kind: "code", message: PERSON_MESSAGES.code, screen: "Verify" });
        expect(openQuestionOf([wait, { ...wait, id: 2, kind: "mobile_sign_in_answer", data: { requestId: "r1", choice: "continue" } }], now)).toBeUndefined();
        expect(openQuestionOf([wait], Date.parse("2026-10-24T10:05:00Z"))).toBeUndefined();
        expect(timeLeft("2026-10-24T10:04:05Z", now)).toBe("4 min 05 s left");
        expect(timeLeft("2026-10-24T10:00:30Z", now)).toBe("less than a minute left");
    });

    it("the runner's check-computer line for a phone", async () => {
        const ready = await checkPhoneReady(fakePhone({ settings: { window_animation_scale: "0", transition_animation_scale: "0", animator_duration_scale: "0", stay_on_while_plugged_in: "3" } }), { serial: "R58M", adbState: "device", emulator: false });
        expect(phoneReadyLine(ready)).toEqual({ id: "phone-ready", status: "ok", title: "Phone Pixel 7 (R58M), Android 14: ready for tests" });
        const onePlus = await checkPhoneReady(fakePhone({ maker: ["OnePlus", "OnePlus", "CPH2467"] }), { serial: "R58N20ABCDE", adbState: "device", emulator: false });
        const l = phoneReadyLine(onePlus, 1);
        expect(l).toMatchObject({ id: "phone-ready-two", status: "optional", title: "Phone CPH2467 (R58N20ABCDE): the screen turns off while the phone charges" });
        expect(l.fix).toContain("Also for this phone: Turn on Disable permission monitoring.");
    });
});
