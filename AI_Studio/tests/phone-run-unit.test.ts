/**
 * Phone test runs on the right device (round 24, RUN), the pure parts: the device choice table, the launcher resolution on recorded phone answers
 * (resolve-activity, dumpsys package, monkey; the "Open with" chooser refused; \r trimmed; a parallel-apps user), pre-flight sentences, infrastructure
 * labelling and its classification, the generated start (no activateApp), and the generated script type-checks against Taqwright's real types.
 * Never a real phone: every adb answer here is a recorded string.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { chooseDevice, exploredOnFromName, ranOnSentence, CHOICE_WORDS, type DeviceFacts } from "../src/engine/mobile/device/choose.js";
import { componentFromDumpsys, componentFromResolve, parseLaunchableActivityNames, resolveLauncher, RESOLVER_ACTIVITY, type LauncherCall } from "../src/engine/mobile/device/launcher.js";
import { preflight, PREFLIGHT_WORDS } from "../src/engine/mobile/device/preflight.js";
import { asInfrastructure, infraKind, isPhoneInfrastructure, PHONE_INFRA_PREFIX } from "../src/engine/mobile/device/infra.js";
import { MESSAGES } from "../src/engine/mobile/device/adb.js";
import { classifyFailedRun } from "../src/engine/validation/validator.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { LAUNCH_APP_PATCH } from "../src/engine/mobile/device/start-script.js";
import { MOBILE_RUN_CONFIG } from "../src/engine/validation/mobile-runner.js";

const PKG = "com.linkedin.android";
const phone = (serial: string, o: Partial<DeviceFacts> = {}): DeviceFacts => ({ serial, state: "device", emulator: false, model: "CPH2467", ...o });
const emu = (serial = "emulator-5554", o: Partial<DeviceFacts> = {}): DeviceFacts => ({ serial, state: "device", emulator: true, ...o });

// ── device choice ──────────────────────────────────────────────────────────

describe("which device a phone run uses", () => {
    const explored = { serial: "R58N20ABCDE", model: "CPH2467", emulator: false };
    const table: Array<[string, Parameters<typeof chooseDevice>[0], { kind: string; serial?: string; avd?: string }]> = [
        ["the phone the AI explored on, by default, even with an emulator set up", { exploredOn: explored, devices: [phone("R58N20ABCDE"), emu()], avd: "Pixel_Test" }, { kind: "phone", serial: "R58N20ABCDE" }],
        ["the phone the AI explored on, chosen explicitly", { runsOn: { kind: "explored" }, exploredOn: explored, devices: [phone("OTHER1", { hasApp: true }), phone("R58N20ABCDE")], avd: "Pixel_Test" }, { kind: "phone", serial: "R58N20ABCDE" }],
        ["a named phone", { runsOn: { kind: "phone", serial: "R58M12ABCDE", model: "Pixel 7" }, devices: [phone("R58N20ABCDE", { hasApp: true }), phone("R58M12ABCDE", { model: "Pixel 7" })], avd: "Pixel_Test" }, { kind: "phone", serial: "R58M12ABCDE" }],
        ["an emulator, even with a ready phone that has the app", { runsOn: { kind: "emulator" }, exploredOn: explored, devices: [phone("R58N20ABCDE", { hasApp: true })], avd: "Pixel_Test" }, { kind: "emulator", avd: "Pixel_Test" }],
        ["no choice: a connected phone that has the app", { devices: [emu(), phone("R58N20ABCDE", { hasApp: true })], avd: "Pixel_Test" }, { kind: "phone", serial: "R58N20ABCDE" }],
        ["no choice: a phone without the app is not used", { devices: [phone("R58N20ABCDE", { hasApp: false })], avd: "Pixel_Test" }, { kind: "emulator", avd: "Pixel_Test" }],
        ["no choice: an unauthorized phone is not used", { devices: [phone("R58N20ABCDE", { state: "unauthorized", hasApp: true })], avd: "Pixel_Test" }, { kind: "emulator", avd: "Pixel_Test" }],
        ["the explored phone is gone: a phone with the app", { exploredOn: explored, devices: [phone("R58M12ABCDE", { hasApp: true })], avd: "Pixel_Test" }, { kind: "phone", serial: "R58M12ABCDE" }],
        ["the explored phone is gone and no other: the emulator", { exploredOn: explored, devices: [], avd: "Pixel_Test" }, { kind: "emulator", avd: "Pixel_Test" }],
        ["explored on an emulator: that running emulator", { exploredOn: { serial: "emulator-5556", emulator: true }, runsOn: { kind: "explored" }, devices: [emu("emulator-5556")], avd: "Pixel_Test" }, { kind: "emulator", serial: "emulator-5556" }],
        ["no AVD here, an emulator already running", { devices: [emu()], avd: "" }, { kind: "emulator", serial: "emulator-5554" }],
        ["a runner that may not start emulators uses a running one", { devices: [emu()], avd: "Pixel_Test", canStartEmulator: false }, { kind: "emulator", serial: "emulator-5554" }],
        ["nothing at all", { devices: [], avd: "" }, { kind: "none" }],
    ];
    for (const [name, input, want] of table) {
        it(name, () => {
            const got = chooseDevice(input);
            expect(got.kind).toBe(want.kind);
            if (want.serial) expect("serial" in got ? got.serial : undefined).toBe(want.serial);
            if (want.avd) expect("avd" in got ? got.avd : undefined).toBe(want.avd);
        });
    }

    it("says which device and why, in plain words", () => {
        const d = chooseDevice({ exploredOn: { serial: "R58N20ABCDE", model: "CPH2467", emulator: false }, devices: [phone("R58N20ABCDE")], avd: "Pixel_Test" });
        expect(d.kind === "phone" && d.why).toBe("Phone tests run on CPH2467 (R58N20ABCDE), the phone the AI explored on, on this computer.");
        expect(ranOnSentence(d as Extract<typeof d, { kind: "phone" }>)).toBe("Ran on CPH2467 (R58N20ABCDE), a phone on this computer.");
        const gone = chooseDevice({ runsOn: { kind: "phone", serial: "R58N20ABCDE", model: "CPH2467" }, devices: [], avd: "Pixel_Test" });
        expect(gone.kind === "emulator" && gone.why).toBe("The phone chosen for this project, CPH2467 (R58N20ABCDE), is not connected to this computer, so phone tests run on the emulator Pixel_Test.");
        const none = chooseDevice({ devices: [], avd: "" });
        expect(none.kind === "none" && none.problem).toBe(CHOICE_WORDS.noDevice);
        expect(ranOnSentence({ kind: "emulator", serial: "emulator-5554", avd: "Pixel_Test", why: "" }, "the runner's computer", true)).toBe("Ran on the emulator emulator-5554 (Pixel_Test) on the runner's computer, started for this run.");
    });

    it("reads the device an exploration used from its session's name", () => {
        expect(exploredOnFromName("CPH2467 (R58N20ABCDE)", new Date(0))).toEqual({ serial: "R58N20ABCDE", model: "CPH2467", emulator: false, at: "1970-01-01T00:00:00.000Z" });
        expect(exploredOnFromName("Android device (emulator-5554)")).toMatchObject({ serial: "emulator-5554", emulator: true });
        expect(exploredOnFromName("Android device (emulator-5554)")!.model).toBeUndefined();
        expect(exploredOnFromName("Pixel 7 (Android 14)")).toBeUndefined(); // a device farm's label, not an adb serial
        expect(exploredOnFromName("")).toBeUndefined();
    });
});

// ── the screen that opens the app ──────────────────────────────────────────

/** A recorded phone: each answer by the joined command line; anything else answers "". */
function recorded(answers: Record<string, string>, seen: string[] = []): LauncherCall {
    return async (args) => {
        const key = args.join(" ");
        seen.push(key);
        for (const [k, v] of Object.entries(answers)) if (key === k || (k.endsWith("*") && key.startsWith(k.slice(0, -1)))) return v;
        return "";
    };
}

const DUMPSYS = [
    "Activity Resolver Table:",
    "  Non-Data Actions:",
    "      android.intent.action.MAIN:",
    "        2a2d1f0 com.linkedin.android/.deeplink.DeepLinkHelperActivity filter 8c1e7a2",
    "          Action: \"android.intent.action.MAIN\"",
    "          Category: \"android.intent.category.DEFAULT\"",
    "      android.intent.action.MAIN:",
    "        5f3e2d1 com.linkedin.android/.authenticator.LaunchActivity filter 1b2c3d4",
    "          Action: \"android.intent.action.MAIN\"",
    "          Category: \"android.intent.category.LAUNCHER\"",
    "",
    "Packages:",
    "  Package [com.linkedin.android] (abc123):",
].join("\r\n");

describe("resolving the launcher activity on the phone", () => {
    it("asks resolve-activity with the launcher category for the current user, trimming Windows line ends", async () => {
        const seen: string[] = [];
        const r = await resolveLauncher(
            recorded({ "shell am get-current-user": "0\r\n", "shell pm list packages --user 0": "package:com.whatsapp\r\npackage:com.linkedin.android\r\n", "shell cmd package resolve-activity --brief --user 0 -c android.intent.category.LAUNCHER com.linkedin.android": "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\ncom.linkedin.android/.authenticator.LaunchActivity\r\n" }, seen),
            "com.linkedin.android\r",
        );
        expect(r).toMatchObject({ component: "com.linkedin.android/.authenticator.LaunchActivity", activity: ".authenticator.LaunchActivity", user: 0, via: "resolve-activity" });
        expect(r.component).not.toMatch(/\r/);
        expect(seen).toContain("shell cmd package resolve-activity --brief --user 0 -c android.intent.category.LAUNCHER com.linkedin.android");
        expect(seen.some((s) => s.startsWith("shell monkey"))).toBe(false);
    });

    it("never takes the \"Open with\" chooser: falls back to dumpsys package (MAIN + LAUNCHER, ported from appium-adb)", async () => {
        const r = await resolveLauncher(
            recorded({ "shell am get-current-user": "0", "shell pm list packages --user 0": "package:com.linkedin.android", "shell cmd package resolve-activity*": `priority=0\r\n${RESOLVER_ACTIVITY}\r\n`, "shell dumpsys package com.linkedin.android": DUMPSYS }),
            PKG,
        );
        expect(r).toMatchObject({ component: "com.linkedin.android/.authenticator.LaunchActivity", via: "dumpsys" });
        expect(r.notes[0]).toMatch(/chooser/);
        expect(componentFromResolve(`x\n${RESOLVER_ACTIVITY}\n`, PKG)).toEqual({ chooser: true });
    });

    it("the dumpsys parser prefers the LAUNCHER block and lists every MAIN activity on old phones without categories", () => {
        expect(parseLaunchableActivityNames(DUMPSYS)).toEqual(["com.linkedin.android/.authenticator.LaunchActivity"]);
        const old = "      android.intent.action.MAIN:\n        1 com.app/.A filter 2\n        3 com.app/.B filter 4\n";
        expect(parseLaunchableActivityNames(old)).toEqual(["com.app/.A", "com.app/.B"]);
        expect(componentFromDumpsys("nothing here", "com.app")).toBeUndefined();
    });

    it("last resort: monkey opens the app and the window in front names the activity", async () => {
        const r = await resolveLauncher(
            recorded({ "shell am get-current-user": "0", "shell pm list packages --user 0": "package:com.example.notes", "shell cmd package resolve-activity*": "No activity found", "shell monkey -p com.example.notes -c android.intent.category.LAUNCHER 1": "Events injected: 1", "shell dumpsys window": "  mCurrentFocus=Window{4f2a1c u0 com.example.notes/com.example.notes.ui.NotesActivity}\r\n" }),
            "com.example.notes",
        );
        expect(r).toMatchObject({ component: "com.example.notes/.ui.NotesActivity", via: "monkey" });
    });

    it("an app only in the parallel-apps user (999) is not installed for the current user: said plainly, nothing started", async () => {
        const seen: string[] = [];
        const r = await resolveLauncher(recorded({ "shell am get-current-user": "0", "shell pm list packages --user 0": "package:com.whatsapp\r\n" }, seen), PKG);
        expect(r.component).toBeUndefined();
        expect(r.problem).toBe("The app com.linkedin.android is not installed for the phone's current user (user 0). Install it for that user, or switch the phone to the user that has it.");
        expect(seen.some((s) => s.includes("monkey") || s.includes("resolve-activity"))).toBe(false);
    });

    it("resolves for the phone's current user when it is not user 0", async () => {
        const seen: string[] = [];
        const r = await resolveLauncher(recorded({ "shell am get-current-user": "10\r\n", "shell pm list packages --user 10": "package:com.linkedin.android", "shell cmd package resolve-activity --brief --user 10 -c android.intent.category.LAUNCHER com.linkedin.android": "com.linkedin.android/.authenticator.LaunchActivity" }, seen), PKG);
        expect(r).toMatchObject({ user: 10, component: "com.linkedin.android/.authenticator.LaunchActivity" });
    });

    it("nothing found anywhere: a plain problem; a bad package name is refused before any call", async () => {
        const r = await resolveLauncher(recorded({ "shell pm list packages --user 0": "package:com.example.notes", "shell monkey*": "** No activities found to run, monkey aborted." }), "com.example.notes");
        expect(r.problem).toMatch(/found no screen that opens com\.example\.notes/);
        const seen: string[] = [];
        expect((await resolveLauncher(recorded({}, seen), "com.x; rm -rf /")).problem).toBe("The app's package name is not usable.");
        expect(seen).toEqual([]);
    });
});

// ── pre-flight ─────────────────────────────────────────────────────────────

describe("pre-flight before a phone run", () => {
    const fine = {
        "shell dumpsys power": "mWakefulness=Awake\r\n",
        "shell dumpsys window": "isKeyguardShowing=false\r\n",
        "shell dumpsys battery": "  AC powered: false\r\n  USB powered: true\r\n  status: 2\r\n  level: 80\r\n",
        "shell am get-current-user": "0",
        "shell pm list packages --user 0": "package:com.linkedin.android\r\npackage:io.appium.uiautomator2.server\r\n",
        "shell cmd package resolve-activity*": "com.linkedin.android/.authenticator.LaunchActivity\r\n",
        "shell df -k /data": "Filesystem     1K-blocks      Used Available Use% Mounted on\n/dev/block/dm-73 109051904 106000000   3051904  98% /data\n",
    };
    const dev = phone("R58N20ABCDE");

    it("a ready phone: the launcher and no notes", async () => {
        const r = await preflight(recorded(fine), { device: dev, appPackage: PKG });
        expect(r).toMatchObject({ ok: true, launch: { component: "com.linkedin.android/.authenticator.LaunchActivity" }, notes: [] });
    });

    it("never a test verdict: each problem in its own sentence", async () => {
        expect((await preflight(recorded(fine), { device: { ...dev, state: "unauthorized" }, appPackage: PKG })).problem).toBe(MESSAGES.unauthorized);
        expect((await preflight(recorded(fine), { device: { ...dev, state: "offline" }, appPackage: PKG })).problem).toBe(MESSAGES.offline);
        expect((await preflight(recorded({ ...fine, "shell dumpsys window": "mDreamingLockscreen=true isKeyguardShowing=true" }), { device: dev, appPackage: PKG })).problem).toBe(PREFLIGHT_WORDS.locked);
        expect((await preflight(recorded({ ...fine, "shell dumpsys battery": "  USB powered: false\n  status: 3\n  level: 6\n" }), { device: dev, appPackage: PKG })).problem).toBe("The phone's battery is at 6% and it is not charging. Charge it, then run the tests again.");
        expect((await preflight(recorded({ ...fine, "shell pm list packages --user 0": "package:com.whatsapp" }), { device: dev, appPackage: PKG })).problem).toMatch(/not installed for the phone's current user \(user 0\)/);
    });

    it("wakes a screen that is off once; a screen that stays off is a problem", async () => {
        const seen: string[] = [];
        let n = 0;
        const call: LauncherCall = async (args) => {
            const k = args.join(" ");
            seen.push(k);
            if (k === "shell dumpsys power") return n++ === 0 ? "mWakefulness=Asleep" : "mWakefulness=Awake";
            return recorded(fine)(args);
        };
        expect((await preflight(call, { device: dev, appPackage: PKG })).ok).toBe(true);
        expect(seen).toContain("shell input keyevent KEYCODE_WAKEUP");
        expect((await preflight(recorded({ ...fine, "shell dumpsys power": "Display Power: state=OFF" }), { device: dev, appPackage: PKG })).problem).toBe(PREFLIGHT_WORDS.screenOff);
    });

    it("notes that do not stop the run: low battery, the test helper not installed yet (and the Xiaomi switch)", async () => {
        const r = await preflight(recorded({ ...fine, "shell dumpsys battery": "  USB powered: false\n  status: 3\n  level: 15\n", "shell pm list packages --user 0": "package:com.linkedin.android", "shell getprop ro.product.manufacturer": "Xiaomi\r\n" }), { device: dev, appPackage: PKG });
        expect(r.ok).toBe(true);
        expect(r.notes).toEqual([PREFLIGHT_WORDS.lowBattery(15), PREFLIGHT_WORDS.helperMissing, PREFLIGHT_WORDS.helperXiaomi]);
    });

    it("an emulator's battery is not looked at; an APK that is not installed yet is not a problem", async () => {
        const seen: string[] = [];
        const r = await preflight(recorded({ ...fine, "shell pm list packages --user 0": "package:other.app" }, seen), { device: emu(), appPackage: PKG, apkGiven: true });
        expect(r.ok).toBe(true);
        expect(r.launch).toBeUndefined();
        expect(seen).not.toContain("shell dumpsys battery");
    });

    it("too little free storage stops the run with a plain message, not a raw install error", async () => {
        // 409,600 KB ≈ 400 MB free: below Android's low-storage reserve, so the test helper could not install.
        const low = { ...fine, "shell df -k /data": "Filesystem     1K-blocks      Used Available Use% Mounted on\n/dev/block/dm-73 109051904 108642304    409600 100% /data\n" };
        const r = await preflight(recorded(low), { device: dev, appPackage: PKG });
        expect(r.ok).toBe(false);
        expect(r.problem).toBe(PREFLIGHT_WORDS.lowStorage(400));
    });

    it("plenty of free storage is fine, and unreadable df never blocks the run", async () => {
        expect((await preflight(recorded(fine), { device: dev, appPackage: PKG })).ok).toBe(true);
        // df that cannot be read (empty, or an error): the check does not block, so a quirk never stops a run on its own.
        expect((await preflight(recorded({ ...fine, "shell df -k /data": "df: /data: Permission denied" }), { device: dev, appPackage: PKG })).ok).toBe(true);
    });
});

// ── infrastructure ─────────────────────────────────────────────────────────

const runOf = (error: string, status: ScriptRun["status"] = "failed"): ScriptRun => ({ testId: "MOB-001", status, durationMs: 10, error, failedStepIndex: 0, steps: [], artifacts: [], responses: [] });

describe("failures of the phone itself", () => {
    it("are told apart from failures of the app", () => {
        expect(infraKind(runOf("WebDriverError: An unknown server-side error occurred while processing the command. Original error: 'POST /element' cannot be proxied to UiAutomator2 server because the instrumentation process is not running (probably crashed)."))).toMatch(/UiAutomator2\) stopped/);
        expect(infraKind(runOf("Error: socket hang up"))).toMatch(/connection to the phone dropped/);
        expect(infraKind(runOf("error: device offline"))).toMatch(/went offline/);
        expect(infraKind(runOf("WebDriverError: A new session could not be created. Details: Unable to resolve the launchable activity of 'com.linkedin.android'"))).toMatch(/session could not be started/);
        expect(infraKind(runOf("expect(locator).toBeVisible() failed"))).toBeUndefined();
        expect(infraKind({ ...runOf("socket hang up"), status: "passed" })).toBeUndefined();
    });

    it("are labelled as the phone's, and the validator never calls them a failing test of the app or sends them to repair", () => {
        const r = asInfrastructure(runOf("Error: socket hang up\n    at x"), "the connection to the phone dropped while the test ran.", 2);
        expect(r.status).toBe("error");
        expect(r.error).toBe(`${PHONE_INFRA_PREFIX}the connection to the phone dropped while the test ran. It was tried twice. This is a problem of the phone or its connection, not a failing test of the app.\nDetails: Error: socket hang up`);
        expect(isPhoneInfrastructure(r)).toBe(true);
        expect(infraKind(r)).toBeUndefined(); // never labelled twice
        const spec = TestSpecSchema.parse({ testId: "MOB-001", title: "Feed opens", kind: "mobile", steps: [{ action: "assert", check: "visible", locator: { by: "testId", value: "feed" } }], source: { origin: "imported" } });
        expect(classifyFailedRun(spec, r)).toEqual({ status: "FAILED_VALIDATION", reason: r.error });
        // A web test with the same words is not a phone matter.
        expect(classifyFailedRun({ ...spec, kind: "web" } as never, r)).toBeUndefined();
    });
});

// ── the generated start ────────────────────────────────────────────────────

describe("how a generated phone test starts", () => {
    const spec = TestSpecSchema.parse({ testId: "MOB-001", title: "Feed opens", kind: "mobile", steps: [{ action: "assert", check: "visible", locator: { by: "testId", value: "feed_list" } }], source: { origin: "imported" } });
    const script = renderWithAdapter(spec, "taqwright", { baseUrl: `android-app://${PKG}` }).content;

    it("starts the resolved launcher activity with mobile: startActivity, never activateApp first", () => {
        expect(script).toContain('"mobile: startActivity"');
        expect(script).toContain("process.env.MOBILE_APP_COMPONENT");
        expect(script).toContain('categories: "android.intent.category.LAUNCHER"');
        expect(script).toContain("stop: true, wait: true");
        // The old way only as the fallback of a copy run without the platform's runner.
        expect(script.indexOf("mobile.launchApp(appId)")).toBeGreaterThan(script.indexOf("if (component)"));
        expect(script).toContain("watchSystemDialogs(mobile)");
        expect(script).not.toMatch(/sk-|api_key|TEST_PASSWORD|password:/i);
    });

    it("the run configuration starts the resolved activity for old scripts too, and sets the session for screens that never go idle", () => {
        expect(MOBILE_RUN_CONFIG).toContain(LAUNCH_APP_PATCH);
        expect(MOBILE_RUN_CONFIG).toContain("Mobile.prototype.launchApp = async function");
        for (const cap of ['"appium:appActivity": activity', '"appium:appWaitActivity": "*"', '"appium:forceAppLaunch": true', '"appium:noReset": true', '"appium:settings": { waitForIdleTimeout: 100 }', '"appium:disableWindowAnimation": true', '"appium:ignoreUnimportantViews": false'])
            expect(MOBILE_RUN_CONFIG).toContain(cap);
        expect(MOBILE_RUN_CONFIG).toContain('process.env.MOBILE_DEVICE_KIND === "phone" ? "local-device" : "emulator"');
    });

    it("the script and the run configuration type-check against Taqwright's real types", () => {
        const dir = fs.mkdtempSync(path.join(REPO_ROOT, ".validation", "phone-run-check-"));
        try {
            const file = path.join(dir, "MOB-001.mobile.spec.ts");
            const config = path.join(dir, "taqwright.config.ts");
            fs.writeFileSync(file, script);
            fs.writeFileSync(config, MOBILE_RUN_CONFIG);
            const program = ts.createProgram([file, config], { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
            const mine = (f: string) => [file, config].some((x) => x.replace(/\\/g, "/") === f.replace(/\\/g, "/"));
            const problems = ts.getPreEmitDiagnostics(program).filter((d) => d.file && mine(d.file.fileName));
            expect(problems.map((d) => `${path.basename(d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
