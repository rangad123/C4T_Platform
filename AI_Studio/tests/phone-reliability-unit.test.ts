/**
 * Phone reliability without a phone: the permission list read from `dumpsys package`, the closed adb lists for preparing a test and for the
 * ADBKeyboard keyboard, the start-state options and their sentences, permission answers as steps (rendering and the text format), typing beyond
 * ASCII, and the pure parts of phone self-repair. Fast tier (no browser, no server, no child process).
 */
import { describe, expect, it } from "vitest";
import { allowedCommand, allowedPrepareCommand } from "../src/engine/mobile/device/adb.js";
import { planAction, REFUSALS } from "../src/engine/mobile/device/actions.js";
import type { ScreenElement, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { keptStartState, needsPreparation, preparationProblem, startStateSentence } from "../src/engine/mobile/state/clean-start.js";
import { cleanGrantList, parseRequestedPermissions, permissionLabel } from "../src/engine/mobile/state/permissions.js";
import { isPermissionStep, permissionAnswerOf, permissionSteps, questionOf, renderPermissionStep } from "../src/engine/mobile/state/permission-step.js";
import { adbKeyboardSelected, encodeForAdbKeyboard, unicodeProblem } from "../src/engine/mobile/state/unicode.js";
import { AAB_REFUSAL, bundleSupport, looksLikeBundle } from "../src/engine/mobile/state/bundle.js";
import { MobileTargetSchema } from "../src/engine/mobile/target.js";
import { phoneElementMissing, phoneRepairTarget, repairPrompt } from "../src/engine/mobile/repair/phone-repair.js";
import { matchesOnScreen } from "../src/engine/mobile/repair/screen-match.js";
import { parseDsl, printStep, readStepLine } from "../src/engine/dsl/index.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";

const PKG = "com.example.shop";

const el = (o: Partial<ScreenElement> & { index: number }): ScreenElement => ({ cls: "Button", text: "", desc: "", id: "", clickable: true, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, o.index * 50, 300, o.index * 50 + 48], ...o });
const snap = (elements: ScreenElement[], o: Partial<ScreenSnapshot> = {}): ScreenSnapshot => ({ package: PKG, width: 360, height: 640, elements, fingerprint: "f", keyboard: false, outsideApp: false, ...o });

describe("the permissions an app asks for", () => {
    const DUMP = `Packages:
  Package [com.example.shop] (a1b2c3):
    requested permissions:
      android.permission.INTERNET
      android.permission.POST_NOTIFICATIONS
      android.permission.CAMERA
      $(rm -rf /)
    install permissions:
      android.permission.INTERNET: granted=true
    User 0: ceDataInode=1
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]
        android.permission.CAMERA: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED ]
        not a permission; echo hi`;

    it("lists the runtime permissions with their state, never install-time ones or junk", () => {
        expect(parseRequestedPermissions(DUMP)).toEqual([
            { name: "android.permission.POST_NOTIFICATIONS", label: "Post notifications", granted: true },
            { name: "android.permission.CAMERA", label: "Camera", granted: false },
        ]);
    });

    it("falls back to the known runtime permissions among the requested ones when the phone lists no runtime section", () => {
        const old = "    requested permissions:\n      android.permission.INTERNET\n      android.permission.READ_CONTACTS\n    install permissions:\n";
        expect(parseRequestedPermissions(old).map((p) => p.name)).toEqual(["android.permission.READ_CONTACTS"]);
        expect(parseRequestedPermissions("")).toEqual([]);
        expect(permissionLabel("android.permission.ACCESS_FINE_LOCATION")).toBe("Access fine location");
    });

    it("the project setting takes only well-formed permission names, without repeats", () => {
        expect(MobileTargetSchema.safeParse({ appPackage: PKG, grantPermissions: ["android.permission.CAMERA"] }).success).toBe(true);
        for (const bad of ["CAMERA", "android.permission.camera", "android.permission.CAMERA; rm -rf /", "android.permission.CAMERA $(id)", ""]) {
            expect(MobileTargetSchema.safeParse({ appPackage: PKG, grantPermissions: [bad] }).success, bad).toBe(false);
        }
        expect(MobileTargetSchema.safeParse({ appPackage: PKG, grantPermissions: Array.from({ length: 31 }, (_, i) => `android.permission.P${i}X`) }).success).toBe(false);
        expect(cleanGrantList(["android.permission.CAMERA", "android.permission.CAMERA", "nope"])).toEqual(["android.permission.CAMERA"]);
    });
});

describe("the closed adb lists", () => {
    it("the explorer's list still has no clear, grant or package description", () => {
        expect(allowedCommand(["shell", "pm", "clear", PKG])).toBe(false);
        expect(allowedCommand(["shell", "pm", "grant", PKG, "android.permission.CAMERA"])).toBe(false);
        expect(allowedCommand(["shell", "dumpsys", "package", PKG])).toBe(false);
    });

    it("preparing a test may clear and grant for one well-formed package and permission, nothing else", () => {
        expect(allowedPrepareCommand(["shell", "pm", "clear", PKG])).toBe(true);
        expect(allowedPrepareCommand(["shell", "pm", "grant", PKG, "android.permission.CAMERA"])).toBe(true);
        expect(allowedPrepareCommand(["shell", "dumpsys", "package", PKG])).toBe(true);
        for (const bad of [
            ["shell", "pm", "clear", "com.example.shop;reboot"],
            ["shell", "pm", "clear", PKG, "--user", "0"],
            ["shell", "pm", "grant", PKG, "android.permission.CAMERA;id"],
            ["shell", "pm", "revoke", PKG, "android.permission.CAMERA"],
            ["shell", "pm", "uninstall", PKG],
            ["shell", "dumpsys", "package"],
            ["pm", "clear", PKG],
            ["shell", "settings", "put", "global", "x", "1"],
        ]) expect(allowedPrepareCommand(bad), bad.join(" ")).toBe(false);
    });

    it("the keyboard broadcast carries base64 only", () => {
        const b64 = encodeForAdbKeyboard("Café ☕ 日本語");
        expect(allowedCommand(["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64])).toBe(true);
        expect(allowedCommand(["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", "abc;reboot"])).toBe(false);
        expect(allowedCommand(["shell", "am", "broadcast", "-a", "ADB_INPUT_TEXT", "--es", "msg", b64])).toBe(false);
        expect(allowedCommand(["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", "abc"])).toBe(false);
        expect(allowedCommand(["shell", "am", "start", "-n", "x/.y"])).toBe(false);
    });
});

describe("a clean start for every test", () => {
    it("is off unless asked, and says plainly what happens when on", () => {
        expect(needsPreparation({})).toBe(false);
        expect(startStateSentence({ appPackage: PKG })).toBeUndefined();
        expect(startStateSentence({ appPackage: PKG, cleanStart: true })).toBe("Each phone test starts from a fresh copy of the app's data (the app's data is cleared before each test).");
        expect(startStateSentence({ appPackage: PKG, cleanStart: true, grantPermissions: ["android.permission.CAMERA"] })).toBe("Each phone test starts from a fresh copy of the app's data, with these permissions granted: Camera.");
        expect(startStateSentence({ appPackage: PKG, grantPermissions: ["android.permission.CAMERA", "android.permission.READ_CONTACTS", "android.permission.RECORD_AUDIO", "android.permission.SEND_SMS"] })).toBe("These permissions are granted to the app before each phone test: Camera, Read contacts, Record audio and 1 more.");
    });

    it("needs the package name, keeps a field a request leaves out, and null switches it off", () => {
        expect(preparationProblem({ cleanStart: true })).toMatch(/package name/);
        expect(preparationProblem({ appPackage: PKG, cleanStart: true })).toBeUndefined();
        const cur = { cleanStart: true, grantPermissions: ["android.permission.CAMERA"] };
        expect(keptStartState(cur, {})).toEqual(cur);
        expect(keptStartState(cur, { cleanStart: null })).toEqual({ grantPermissions: ["android.permission.CAMERA"] });
        expect(keptStartState(cur, { grantPermissions: null, cleanStart: false })).toEqual({});
        expect(keptStartState(undefined, {})).toEqual({});
    });
});

describe("permission answers as steps", () => {
    const dialog = snap(
        [el({ index: 0, cls: "TextView", text: "Allow Shop to send you notifications?", clickable: false }), el({ index: 1, text: "Allow" }), el({ index: 2, text: "Don't allow" })],
        { package: "com.google.android.permissioncontroller", outsideApp: true },
    );

    it("keeps the question in short words and the button that was tapped", () => {
        expect(questionOf("Allow Shop to send you notifications?")).toBe("send you notifications");
        expect(questionOf("Shop needs your location")).toBe("Shop needs your location");
        expect(permissionAnswerOf(dialog, dialog.elements[2]!)).toEqual({ question: "send you notifications", choice: "Don't allow", allowed: false });
        expect(permissionAnswerOf(dialog, dialog.elements[1]!)).toEqual({ question: "send you notifications", choice: "Allow", allowed: true });
    });

    it("becomes one press step per question, titled the way a person reads it", () => {
        const steps = permissionSteps([
            { question: "send you notifications", choice: "Don't allow", allowed: false },
            { question: "send you notifications", choice: "Allow", allowed: true },
            { question: "use the camera", choice: "Allow", allowed: true },
        ]);
        expect(steps).toEqual([
            { action: "press", key: "device:permission", locator: { by: "text", value: "Don't allow" }, description: `Don't allow "send you notifications" when asked` },
            { action: "press", key: "device:permission", locator: { by: "text", value: "Allow" }, description: `Allow "use the camera" when asked` },
        ]);
        expect(isPermissionStep(steps[0]!)).toBe(true);
        expect(permissionSteps(undefined)).toEqual([]);
    });

    it("renders for Taqwright as: tap the same answer when it shows, go on when it does not", () => {
        const spec = TestSpecSchema.parse({ testId: "MOB-001", title: "App opens", kind: "mobile", steps: [...permissionSteps([{ question: "send you notifications", choice: "Don't allow", allowed: false }]), { action: "assert", check: "visible", locator: { by: "text", value: "Shop" } }], source: { origin: "exploration" } });
        const code = renderWithAdapter(spec, "taqwright", { baseUrl: `android-app://${PKG}` }).content;
        expect(code).toContain(`await test.step("1. Don't allow \\"send you notifications\\" when asked"`);
        expect(code).toContain(`const answer = mobile.getByText("Don't allow");`);
        expect(code).toContain("!(await answer.isVisible().catch(() => false)); i++) await mobile.waitForTimeout(500);");
        expect(code).toContain("if (await answer.isVisible().catch(() => false)) await answer.click().catch(() => undefined);");
        expect(renderPermissionStep("X")).not.toContain("expect(");
    });

    it("has a line in the text format that reads back to the same step; a web test refuses it", () => {
        const step = permissionSteps([{ question: "send you notifications", choice: "Don't allow", allowed: false }])[0]!;
        const line = printStep(step)!;
        expect(line).toBe(`When the phone asks for a permission, tap the text "Don't allow" note "Don't allow \\"send you notifications\\" when asked"`);
        expect(readStepLine(line)!.step).toEqual(step);
        const r = parseDsl(`Test: Phone step in a web test\nWhen the phone asks for a permission, tap the text "Allow"\n`);
        expect(r.spec).toBeNull();
        expect(r.diagnostics[0]!.message).toBe("This step is for phone tests, and phone tests cannot be written as text yet.");
        // An ordinary key press still prints as before.
        expect(printStep({ action: "press", key: "Enter", locator: { by: "label", value: "Search" }, description: "" } as Step)).toBe('Press the key "Enter" in the "Search" field');
    });
});

describe("typing beyond ASCII", () => {
    const field = snap([el({ index: 0, cls: "EditText", editable: true, text: "Search" })]);
    it("is refused as before without ADBKeyboard, and planned through it when it is the phone's keyboard", () => {
        expect(planAction({ kind: "type", index: 0, text: "Café" }, field)).toEqual({ ok: false, error: REFUSALS.notAscii });
        const p = planAction({ kind: "type", index: 0, text: "Café ☕ 日本語" }, field, undefined, { unicode: true });
        expect(p.ok && p.plan).toMatchObject({ kind: "type", text: "Café ☕ 日本語", unicode: true });
        // Plain ASCII keeps using `input text`, so nothing changes for it.
        const ascii = planAction({ kind: "type", index: 0, text: "shoes" }, field, undefined, { unicode: true });
        expect(ascii.ok && ascii.plan).not.toHaveProperty("unicode");
        expect(planAction({ kind: "type", index: 0, text: "Café\nrm" }, field, undefined, { unicode: true })).toEqual({ ok: false, error: REFUSALS.lineBreak });
        expect(unicodeProblem("x".repeat(1001))).toMatch(/at most 1000/);
    });

    it("knows ADBKeyboard only when it is the selected keyboard", () => {
        expect(adbKeyboardSelected("Input Method Service:\n  mCurMethodId=com.android.adbkeyboard/.AdbIME\n")).toBe(true);
        expect(adbKeyboardSelected("  mCurMethodId=com.google.android.inputmethod.latin/.LatinIME\n")).toBe(false);
        expect(adbKeyboardSelected("")).toBe(false);
        expect(Buffer.from(encodeForAdbKeyboard("日本語"), "base64").toString("utf8")).toBe("日本語");
    });
});

describe("app bundles", () => {
    it("are told apart from APKs, and refused in words without bundletool", () => {
        const zipHead = Buffer.alloc(4);
        zipHead.writeUInt32LE(0x04034b50, 0);
        const aab = Buffer.concat([zipHead, Buffer.from("x".repeat(120) + "base/manifest/AndroidManifest.xml BundleConfig.pb")]);
        const apk = Buffer.concat([zipHead, Buffer.from("x".repeat(120) + "AndroidManifest.xml classes.dex")]);
        expect(looksLikeBundle(aab)).toBe(true);
        expect(looksLikeBundle(apk)).toBe(false);
        expect(bundleSupport({ PATH: "", AITP_JAVA_PATH: "", TAQWRIGHT_HOME: "/nowhere-at-all" })).toEqual({ ok: false, reason: AAB_REFUSAL });
        expect(AAB_REFUSAL).toMatch(/^This is an Android App Bundle \(\.aab\)\. Upload an \.apk, or install Java and bundletool/);
    });
});

describe("phone self-repair, the parts that need no phone", () => {
    it("recognises Taqwright's words for an element that was never found, and nothing else", () => {
        expect(phoneElementMissing('waitFor: locator (id=signin_old) did not reach state "visible" within 15000ms')).toBe(true);
        expect(phoneElementMissing("assert visible: expected true within 15000ms (last: <unresolved>)")).toBe(true);
        expect(phoneElementMissing("Element (id=x) is visible but not enabled")).toBe(false);
        expect(phoneElementMissing("assert text: expected Hello within 15000ms (last: Bye)")).toBe(false);
        expect(phoneElementMissing(undefined)).toBe(false);
    });

    const spec = TestSpecSchema.parse({
        testId: "MOB-001",
        title: "Open sign in",
        kind: "mobile",
        steps: [...permissionSteps([{ question: "send you notifications", choice: "Don't allow", allowed: false }]), { action: "click", locator: { by: "testId", value: "signin_old" } }, { action: "assert", check: "visible", locator: { by: "text", value: "Sign in" } }],
        source: { origin: "imported" },
    });
    const run = (index: number, error: string) => ({ testId: "MOB-001", status: "failed" as const, durationMs: 1, failedStepIndex: index, steps: [{ index, title: "x", status: "failed" as const, durationMs: 1, error }], artifacts: [], responses: [] });

    it("looks only at a missing element of a step it may change", () => {
        expect(phoneRepairTarget(spec, run(1, 'waitFor: locator (id=signin_old) did not reach state "visible" within 15000ms') as never)).toMatchObject({ ok: true, stepIndex: 1, need: "tap" });
        expect(phoneRepairTarget(spec, run(1, "assert text: expected a (last: b)") as never)).toEqual({ ok: false, reason: "the failure is not a missing element" });
        // A check that finds its element by the very text it claims is about the app, not a broken locator.
        expect(phoneRepairTarget(spec, run(2, "assert visible: expected true within 1ms (last: <unresolved>)") as never).ok).toBe(false);
        expect(phoneRepairTarget(spec, run(0, 'waitFor: locator (-android uiautomator=x) did not reach state "visible" within 1ms') as never)).toEqual({ ok: false, reason: "a permission answer is never a failure to repair" });
        expect(phoneRepairTarget({ ...spec, source: { ...spec.source, origin: "security-check" } }, run(1, 'did not reach state "visible"') as never).ok).toBe(false);
    });

    it("finds elements on the screen the way the phone locators read them", () => {
        const els = [el({ index: 0, id: "signin_button", text: "Sign in" }), el({ index: 1, cls: "ImageButton", desc: "Cart, 0 items", id: "cart_button" }), el({ index: 2, cls: "EditText", editable: true, text: "Search products" }), el({ index: 3, cls: "TextView", text: "Product 1", clickable: false }), el({ index: 4, cls: "TextView", text: "Product 2", clickable: false })];
        expect(matchesOnScreen({ by: "testId", value: "signin_button" }, els).map((e) => e.index)).toEqual([0]);
        expect(matchesOnScreen({ by: "label", value: "cart, 0 items" }, els).map((e) => e.index)).toEqual([1]);
        expect(matchesOnScreen({ by: "placeholder", value: "Search products" }, els).map((e) => e.index)).toEqual([2]);
        expect(matchesOnScreen({ by: "role", role: "button", value: "Sign in" }, els).map((e) => e.index)).toEqual([0]);
        // No exact match: a partial one, like Taqwright's text locator ("Search products" contains it too).
        expect(matchesOnScreen({ by: "text", value: "Product" }, els).map((e) => e.index)).toEqual([2, 3, 4]);
        expect(matchesOnScreen({ by: "text", value: "Product 2" }, els).map((e) => e.index)).toEqual([4]);
        expect(matchesOnScreen({ by: "text", value: "Product", nth: 1 }, els).map((e) => e.index)).toEqual([3]);
        expect(matchesOnScreen({ by: "css", value: "#x" }, els)).toEqual([]);
    });

    it("shows the model the screen as untrusted data, with secrets scrubbed", () => {
        const s = snap([el({ index: 0, id: "signin_button", text: "Sign in" }), el({ index: 1, cls: "TextView", text: "Hello Fake-Pass-1234", clickable: false })]);
        const p = repairPrompt(spec.steps[1]!, { by: "testId", value: "signin_old" }, s, s.elements, ["Fake-Pass-1234"]);
        expect(p).toContain('<screen untrusted-app-data>\nactivity: unknown\n[0] Button "Sign in" id=signin_button\n[1] TextView "Hello');
        expect(p).not.toContain("Fake-Pass-1234");
    });
});
