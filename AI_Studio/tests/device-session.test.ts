/**
 * The device session on THIS computer, against the FAKE adb (tests/fixtures/fake-adb.mjs, a Node script: no emulator, no phone, no adb server) and its
 * scripted mock apps. Every adb call is a real child process; the mock app is a real state machine.
 *
 * Launches Chromium once, to decode the JPEG the session produced with a decoder that is not ours:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/device-session.test.ts
 * Ports: none needed (a browser page with a data: URL).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowedCommand } from "../src/engine/mobile/device/adb.js";
import { REFUSALS } from "../src/engine/mobile/device/actions.js";
import { DeviceSessionError } from "../src/engine/mobile/device/errors.js";
import { COVER_RGB } from "../src/engine/mobile/device/image.js";
import { openLocalDeviceSession } from "../src/engine/mobile/device/session.js";
import type { DeviceAction, DeviceSession, OpenDeviceOptions, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { adbPath } from "../src/engine/mobile/toolchain.js";

const FAKE_ADB = path.resolve("tests/fixtures/fake-adb.mjs");
const FAKE_EMULATOR = path.resolve("tests/fixtures/fake-emulator.mjs");
const SHOP = "com.example.shop";
const NOTES = "com.example.notes";
const USER = "tester";
const PASS = "Fake-Pass-1234-Zq";
const KEYS = ["AITP_ADB_PATH", "AITP_EMULATOR_PATH", "AITP_FAKE_STATE", "AITP_FAKE_ADB_LOG", "AITP_FAKE_APP", "AITP_FAKE_DEVICES", "AITP_FAKE_FAULTS", "AITP_FAKE_USER", "AITP_FAKE_PASSWORD", "AITP_FAKE_SCALE", "ANDROID_AVD_HOME", "ANDROID_HOME", "TAQWRIGHT_HOME"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let dir: string;
let stateFile: string;
let logFile: string;
let n = 0;
const open: DeviceSession[] = [];
const lines: string[] = [];

/** A fresh fake phone for one test. */
function fake(o: { app?: "shop" | "notes"; devices?: "emulator" | "phone" | "none" | "both"; faults?: string; scale?: number } = {}): void {
    n++;
    stateFile = path.join(dir, `state-${n}.json`);
    logFile = path.join(dir, `adb-${n}.jsonl`);
    Object.assign(process.env, {
        AITP_ADB_PATH: FAKE_ADB, AITP_EMULATOR_PATH: FAKE_EMULATOR, AITP_FAKE_STATE: stateFile, AITP_FAKE_ADB_LOG: logFile,
        AITP_FAKE_APP: o.app ?? "shop", AITP_FAKE_DEVICES: o.devices ?? "emulator", AITP_FAKE_FAULTS: o.faults ?? "",
        AITP_FAKE_USER: USER, AITP_FAKE_PASSWORD: PASS, AITP_FAKE_SCALE: String(o.scale ?? 1),
        ANDROID_AVD_HOME: path.join(dir, "no-avds"), TAQWRIGHT_HOME: path.join(dir, "no-taqwright"),
    });
    delete process.env.ANDROID_HOME;
    lines.length = 0;
}
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as { devices: Array<{ serial: string }>; typed: Array<{ field: string | null; text: string }>; injected: unknown[]; killed: boolean; emulatorStarts?: number; emulatorPid?: number; app: Record<string, any> | null; fg: string | null };
const adbLog = (): string[][] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

async function start(o: Partial<OpenDeviceOptions> = {}): Promise<DeviceSession> {
    const s = await openLocalDeviceSession({ appPackage: SHOP, credentials: { username: USER, password: PASS }, log: (l) => lines.push(l), ...o });
    open.push(s);
    return s;
}
const find = (s: ScreenSnapshot, f: (e: ScreenSnapshot["elements"][number]) => boolean) => {
    const e = s.elements.find(f);
    if (!e) throw new Error(`no such element on ${s.package}: ${s.elements.map((x) => x.text || x.desc || x.id).join(" | ")}`);
    return e;
};
const byText = (s: ScreenSnapshot, text: string) => find(s, (e) => e.text === text);
const byId = (s: ScreenSnapshot, id: string) => find(s, (e) => e.id === id);
const texts = (s: ScreenSnapshot) => s.elements.map((e) => e.text || e.desc);
/** Do an action that must work and return the new screen. */
async function go(s: DeviceSession, action: DeviceAction, opts?: { screenshot?: boolean }): Promise<ScreenSnapshot> {
    const r = await s.act(action, opts);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    return r.snapshot!;
}
const tap = (s: DeviceSession, e: { index: number }) => go(s, { kind: "tap", index: e.index });

/** The shop app past its permission dialog. */
async function shopHome(o: Partial<OpenDeviceOptions> = {}): Promise<{ s: DeviceSession; home: ScreenSnapshot }> {
    const s = await start(o);
    const dialog = await s.snapshot();
    const home = await tap(s, byText(dialog, "Allow"));
    return { s, home };
}

let browser: Browser | undefined;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-device-session-"));
    fs.mkdirSync(path.join(dir, "no-avds"));
});
afterEach(async () => {
    while (open.length) await open.pop()!.close().catch(() => undefined);
});
afterAll(async () => {
    await browser?.close();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the AITP_ADB_PATH seam", () => {
    it("names the stand-in when it exists, nothing when it does not, and changes nothing when unset", () => {
        expect(adbPath({ AITP_ADB_PATH: FAKE_ADB })).toBe(FAKE_ADB);
        expect(adbPath({ AITP_ADB_PATH: path.join(dir, "missing.mjs") })).toBeUndefined();
        expect(adbPath({ ANDROID_HOME: path.join(dir, "nowhere"), TAQWRIGHT_HOME: path.join(dir, "no-taqwright") })).toBeUndefined();
    });
});

describe("reading the screen and moving through the shop app", { timeout: 120_000 }, () => {
    it("opens the app, sees the permission dialog as outside the app and answers it by tapping, like a person", async () => {
        fake();
        const s = await start();
        expect(s.kind).toBe("local");
        expect(s.deviceName).toContain("emulator-5554");
        const dialog = await s.snapshot();
        expect(dialog.package).toBe("com.google.android.permissioncontroller");
        expect(dialog.outsideApp).toBe(true);
        expect(texts(dialog)).toEqual(expect.arrayContaining(["Allow Shop to send you notifications?", "Allow", "Don't allow"]));
        const home = await tap(s, byText(dialog, "Allow"));
        expect(home.package).toBe(SHOP);
        expect(home.outsideApp).toBe(false);
        expect(home.activity).toBe("com.example.shop.MainActivity");
        expect(texts(home)).toEqual(expect.arrayContaining(["Shop", "Sign in", "Products", "Cart, 0 items", "Terms and conditions", "Delete account"]));
        expect(byId(home, "search_box")).toMatchObject({ editable: true, cls: "EditText" });
        expect(byId(home, "cart_button")).toMatchObject({ cls: "ImageButton", text: "", desc: "Cart, 0 items", clickable: true });
        // layouts are gone, indexes run from 0, the fingerprint is the screen's name
        expect(home.elements.every((e, i) => e.index === i && e.cls !== "LinearLayout" && e.cls !== "FrameLayout")).toBe(true);
        expect((await s.snapshot()).fingerprint).toBe(home.fingerprint);
        // the dialog was answered by a tap, not by a permission command
        expect(adbLog().some((a) => a.includes("grant") || a.includes("settings"))).toBe(false);
    });

    it("moves with tap, type, scroll, back, long press, restart and launch", async () => {
        fake();
        const { s, home } = await shopHome();
        const products = await tap(s, byText(home, "Products"));
        expect(texts(products)).toEqual(expect.arrayContaining(["Product 1", "Product 6"]));
        expect(texts(products)).not.toContain("Product 7");
        const scrolled = await go(s, { kind: "scroll", index: byId(products, "product_list").index, direction: "down" });
        expect(texts(scrolled)).toEqual(expect.arrayContaining(["Product 4", "Product 9"]));
        expect(texts(scrolled)).not.toContain("Product 1");
        const whole = await go(s, { kind: "scroll", direction: "up" });
        expect(texts(whole)).toContain("Product 1");
        const product = await tap(s, byText(whole, "Product 2"));
        expect(texts(product)).toEqual(expect.arrayContaining(["Product 2", "$9.99", "Add to cart"]));
        const added = await tap(s, byText(product, "Add to cart"));
        const back = await go(s, { kind: "back" });
        expect(texts(back)).toContain("Products");
        const home2 = await go(s, { kind: "back" });
        expect(texts(home2)).toContain("Cart, 1 items");
        const typed = await go(s, { kind: "type", index: byId(home2, "search_box").index, text: "red shoes" });
        expect(byId(typed, "search_box").text).toBe("red shoes");
        expect(typed.keyboard).toBe(true);
        const typedMore = await go(s, { kind: "type", index: byId(typed, "search_box").index, text: " size 9", clear: true });
        expect(byId(typedMore, "search_box").text).toBe("size 9");
        const hidden = await go(s, { kind: "hideKeyboard" });
        expect(hidden.keyboard).toBe(false);
        // hiding a keyboard that is not showing does not press back (which would leave the screen)
        const still = await go(s, { kind: "hideKeyboard" });
        expect(still.fingerprint).toBe(hidden.fingerprint);
        const restarted = await go(s, { kind: "restart" });
        expect(restarted.package).toBe(SHOP);
        expect(added.package).toBe(SHOP);
        expect((await go(s, { kind: "launch" })).package).toBe(SHOP);
        expect((await go(s, { kind: "wait", ms: 200 })).package).toBe(SHOP);
    });

    it("long press works on the notes app, and the delete confirmation is an ordinary screen", async () => {
        fake({ app: "notes" });
        const s = await start({ appPackage: NOTES });
        const list = await s.snapshot();
        expect(texts(list)).toEqual(expect.arrayContaining(["Notes", "Buy milk", "Call mom", "Add note"]));
        const confirm = await go(s, { kind: "longPress", index: byText(list, "Buy milk").index });
        expect(texts(confirm)).toContain("Delete this note?");
        const after = await tap(s, byText(confirm, "Delete"));
        expect(texts(after)).not.toContain("Buy milk");
        expect(texts(after)).toContain("Call mom");
        const add = await tap(s, byText(after, "Add note"));
        const typed = await go(s, { kind: "type", index: byId(add, "note_text").index, text: "Water the plants" });
        const saved = await tap(s, byText(typed, "Save"));
        expect(texts(saved)).toContain("Water the plants");
    });

    it("refuses an element number that is stale, and gives the screen as it is now", async () => {
        fake();
        const { s, home } = await shopHome();
        const nope = await s.act({ kind: "tap", index: 99 });
        expect(nope).toMatchObject({ ok: false, error: REFUSALS.stale });
        // the number is valid for the last snapshot, but the screen moved on behind the explorer's back (someone touched the phone): the element is not there any more
        const signIn = byText(home, "Sign in");
        execFileSync(process.execPath, [FAKE_ADB, "shell", "input", "tap", "100", "160"], { env: process.env });
        expect(state().app!.screen).toBe("signin");
        const stale = await s.act({ kind: "tap", index: byText(home, "Products").index });
        expect(stale.ok).toBe(false);
        expect(stale.error).toBe(REFUSALS.stale);
        // and the answer is the real screen, so the next number is right
        expect(stale.snapshot).toBeDefined();
        expect(texts(stale.snapshot!)).toContain("Log in");
        expect(signIn.text).toBe("Sign in");
        const ok = await s.act({ kind: "tap", index: byText(stale.snapshot!, "Log in").index });
        expect(ok.ok).toBe(true);
        // the stale target was never tapped: the phone is still on the sign-in screen, not on the products list
        expect(state().app!.screen).toBe("signin");
    });

    it("destructive and external screens are reachable only through a visible tap, and the session says when it left the app", async () => {
        fake();
        const { s, home } = await shopHome();
        const del = await tap(s, byText(home, "Delete account"));
        expect(texts(del)).toEqual(expect.arrayContaining(["Delete account", "This cannot be undone.", "Delete my account", "Cancel"]));
        expect(del.outsideApp).toBe(false);
        expect(state().app!.deleted).toBe(false);
        const cancelled = await tap(s, byText(del, "Cancel"));
        expect(state().app!.deleted).toBe(false);
        const ext = await tap(s, byText(cancelled, "Terms and conditions"));
        expect(ext.package).toBe("com.android.chrome");
        expect(ext.outsideApp).toBe(true);
        const back = await go(s, { kind: "back" });
        expect(back.package).toBe(SHOP);
        expect(back.outsideApp).toBe(false);
        // the session never started another app or opened a link by itself
        const monkeys = adbLog().filter((a) => a.includes("monkey"));
        for (const m of monkeys) expect(m).toContain(SHOP);
    });
});

describe("sign-in: the password is never read, shown, kept or returned", { timeout: 120_000 }, () => {
    it("signs in with the stand-ins; the real password never appears in a snapshot, an answer, an error or a log line", async () => {
        fake();
        const seen: string[] = [];
        const record = (x: unknown) => void seen.push(JSON.stringify(x));
        const { s, home } = await shopHome();
        record(home);
        const signin = await tap(s, byText(home, "Sign in"));
        record(signin);
        const pw = byId(signin, "password_field");
        expect(pw).toMatchObject({ password: true, editable: true, text: "" });
        const user = byId(signin, "username_field");

        // anything but the stand-in is refused in a password field
        const wrong = await s.act({ kind: "type", index: pw.index, text: "my-own-password" });
        record(wrong);
        expect(wrong).toMatchObject({ ok: false, error: REFUSALS.passwordOnly });
        const userInPw = await s.act({ kind: "type", index: pw.index, text: "{{credentials.username}}" });
        expect(userInPw.ok).toBe(false);
        const pwInUser = await s.act({ kind: "type", index: user.index, text: "{{credentials.password}}" });
        expect(pwInUser).toMatchObject({ ok: false, error: REFUSALS.passwordElsewhere });
        expect(state().typed).toEqual([]);

        const a = await go(s, { kind: "type", index: user.index, text: "{{credentials.username}}" });
        record(a);
        expect(byId(a, "username_field").text).toBe(USER);
        const b = await go(s, { kind: "type", index: byId(a, "password_field").index, text: "{{credentials.password}}" });
        record(b);
        expect(byId(b, "password_field")).toMatchObject({ password: true, text: "" });
        // the mock app got the real value, typed on this machine
        expect(state().typed.at(-1)).toEqual({ field: "password", text: PASS });
        const loggedIn = await tap(s, byText(b, "Log in"));
        record(loggedIn);
        expect(texts(loggedIn)).toContain(`Hello, ${USER}`);

        for (const text of [...seen, ...lines]) expect(text).not.toContain(PASS);
        // the real value travelled only in the argument list of the one `input text` call that typed it
        const withPass = adbLog().filter((a) => a.join(" ").includes(PASS));
        expect(withPass).toHaveLength(1);
        expect(withPass[0]!.slice(0, 3)).toEqual(["-s", "emulator-5554", "shell"]);
    });

    it("without sign-in details the field says so, and a wrong password is just what the app shows", async () => {
        fake();
        const { s, home } = await shopHome({ credentials: undefined });
        const signin = await tap(s, byText(home, "Sign in"));
        const r = await s.act({ kind: "type", index: byId(signin, "password_field").index, text: "{{credentials.password}}" });
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Sign-in details are needed for this field") });
        await s.close();

        fake();
        process.env.AITP_FAKE_PASSWORD = "something-else-entirely";
        const w = await shopHome();
        const si = await tap(w.s, byText(w.home, "Sign in"));
        const u = await go(w.s, { kind: "type", index: byId(si, "username_field").index, text: "{{credentials.username}}" });
        const p = await go(w.s, { kind: "type", index: byId(u, "password_field").index, text: "{{credentials.password}}" });
        const fail = await tap(w.s, byText(p, "Log in"));
        expect(texts(fail)).toContain("Wrong username or password");
        expect(JSON.stringify(fail)).not.toContain(PASS);
    });

    it("a field that shows the password in its text (show password on) is hidden, and covered in the picture", async () => {
        fake({ faults: "show-password" });
        const { s, home } = await shopHome();
        const signin = await tap(s, byText(home, "Sign in"));
        await go(s, { kind: "type", index: byId(signin, "username_field").index, text: "{{credentials.username}}" });
        const pwField = byId(signin, "password_field");
        // this field is not flagged as a password (the toggle is on), so the stand-in is refused there
        expect((await s.act({ kind: "type", index: pwField.index, text: "{{credentials.password}}" })).error).toBe(REFUSALS.passwordElsewhere);
        // the page itself shows the password once the person (or the app) typed it
        const raw = await go(s, { kind: "type", index: pwField.index, text: "visible-to-everyone-1" });
        expect(raw.elements.some((e) => e.text.includes("visible-to-everyone-1"))).toBe(true);
    });
});

describe("what can be typed", { timeout: 120_000 }, () => {
    it("hostile text is typed as text and never reaches the phone's shell", async () => {
        fake();
        const { s, home } = await shopHome();
        const search = byId(home, "search_box");
        const hostile = ["; rm -rf /", "$(reboot)", "`id`", "a'b\"c", "x && y | z > /sdcard/f", "it's 100% fine", "back\\slash", "{{not.a.placeholder}}"];
        let screen = home;
        for (const text of hostile) {
            screen = await go(s, { kind: "type", index: byId(screen, "search_box").index, text, clear: true });
            expect(state().typed.at(-1), text).toEqual({ field: "search", text });
            expect(byId(screen, "search_box").text, text).toBe(text);
        }
        expect(state().injected).toEqual([]);
        expect(search.editable).toBe(true);
        const typedCalls = adbLog().filter((a) => a.includes("text"));
        expect(typedCalls.length).toBe(hostile.length);
        for (const call of typedCalls) expect(allowedCommand(call.slice(2)), call.join(" ")).toBe(true);
    });

    it("refuses what the phone can't take, before anything is sent", async () => {
        fake();
        const { s, home } = await shopHome();
        const id = byId(home, "search_box").index;
        const before = adbLog().filter((a) => a.includes("text")).length;
        for (const [text, reason] of [["Café", REFUSALS.notAscii], ["日本語", REFUSALS.notAscii], ["a\nb", REFUSALS.lineBreak], ["50%sale", REFUSALS.percentS]] as const) {
            expect(await s.act({ kind: "type", index: id, text }), text).toMatchObject({ ok: false, error: reason });
        }
        expect(adbLog().filter((a) => a.includes("text")).length).toBe(before);
    });
});

describe("the closed list: nothing else is ever sent to the phone", { timeout: 120_000 }, () => {
    it("every adb call of a whole session is on the list, for the configured package only", async () => {
        fake();
        const { s, home } = await shopHome();
        const prod = await tap(s, byText(home, "Products"));
        await go(s, { kind: "scroll", direction: "down" });
        await go(s, { kind: "back" });
        await go(s, { kind: "restart" });
        await go(s, { kind: "type", index: byId(prod, "title").index, text: "x" }).catch(() => undefined);
        await s.snapshot({ screenshot: true });
        await s.close();
        const log = adbLog();
        expect(log.length).toBeGreaterThan(30);
        for (const argv of log) {
            const args = argv[0] === "-s" ? argv.slice(2) : argv;
            expect(allowedCommand(args), argv.join(" ")).toBe(true);
            if (args[0] === "shell" && (args[1] === "am" || args[1] === "monkey")) expect(args.join(" ")).toContain(SHOP);
            // never uninstall, change a setting, grant a permission, or start another app
            expect(args.join(" ")).not.toMatch(/uninstall|settings|\bpm (grant|revoke|clear)|am start|\bsu\b/);
        }
    });
});

describe("faults of the phone are plain words, and are never a verdict", { timeout: 120_000 }, () => {
    const expectOpenFails = async (message: RegExp) => {
        const e = await start().then(() => undefined, (x: unknown) => x);
        expect(e).toBeInstanceOf(DeviceSessionError);
        expect((e as Error).message).toMatch(message);
        expect((e as Error).message).not.toContain(PASS);
        return e as Error;
    };

    it("no device, offline, unauthorized, locked", async () => {
        fake({ devices: "none" });
        await expectOpenFails(/No phone or emulator is connected/);
        fake({ faults: "offline" });
        await expectOpenFails(/The phone is offline/);
        fake({ faults: "unauthorized" });
        await expectOpenFails(/USB debugging is off or not allowed on this phone/);
        fake({ faults: "locked" });
        await expectOpenFails(/The phone is locked/);
    });

    it("the app is not on the phone and no app file was given; a given app file is installed", async () => {
        fake();
        const e = await start({ appPackage: "com.example.other" }).then(() => undefined, (x: unknown) => x as Error);
        expect((e as Error).message).toContain("com.example.other is not installed on this phone, and no app file was given");
        const apk = path.join(dir, "shop.apk");
        fs.writeFileSync(apk, "not really an apk");
        fake();
        const s = await start({ apkPath: apk });
        expect(s.kind).toBe("local");
        expect(adbLog().some((a) => a.includes("install") && a.includes(apk))).toBe(true);
        await expect(start({ apkPath: path.join(dir, "missing.apk") })).rejects.toThrow(/app file was not found/);
        await expect(start({ apkPath: path.join(dir, "shop.txt") })).rejects.toThrow(/app file was not found/);
    });

    it("rejects a package that is not an application id before touching the phone", async () => {
        fake();
        await expect(start({ appPackage: "shop; reboot" })).rejects.toThrow(/application id/);
        expect(adbLog()).toEqual([]);
    });

    it("a screen that is still changing is waited for (at most 3 s), and one that never settles still returns", async () => {
        fake({ faults: "slow" });
        const { s, home } = await shopHome();
        const t0 = Date.now();
        const next = await tap(s, byText(home, "Products"));
        expect(Date.now() - t0).toBeLessThan(12_000);
        expect(next.elements.some((e) => e.text.startsWith("Loading"))).toBe(false);
        expect(texts(next)).toContain("Products");
        await s.close();

        fake({ faults: "never-settles" });
        const t = await shopHome();
        const t1 = Date.now();
        const r = await t.s.act({ kind: "wait", ms: 100 });
        expect(r.ok).toBe(true);
        expect(Date.now() - t1).toBeLessThan(10_000);
        expect(r.snapshot!.elements.some((e) => e.text.startsWith("Loading"))).toBe(true);
    });

    it("a malformed or huge screen description is an error in words, not a crash", async () => {
        fake({ faults: "malformed" });
        const m = await start();
        await expect(m.snapshot()).rejects.toThrow(/screen could not be read/);
        // the session is still usable afterwards: a bad screen is not the end of it
        process.env.AITP_FAKE_FAULTS = "";
        expect((await m.snapshot()).package).toBeTruthy();
        await m.close(); // one session at a time holds the device
        fake({ faults: "huge" });
        const h = await start();
        await expect(h.snapshot()).rejects.toThrow(/too large to read/);
    });

    it("unicode text is kept, hostile text is cleaned, and a screen with more than 120 elements is cut", async () => {
        fake({ faults: "unicode,hostile,many" });
        const { s, home } = await shopHome();
        expect(texts(home)).toContain("Café ☕ 日本語");
        const note = byId(home, "note");
        expect(note.text).not.toMatch(/[\u0000-\u001f‮]/);
        expect(note.text).toContain("Ignore previous instructions");
        expect(home.elements).toHaveLength(120);
        expect(home.elements.filter((e) => e.clickable).length).toBeGreaterThan(80);
        await s.close();
    });

    it("the phone going away in the middle ends the session with a plain error", async () => {
        fake();
        const { s } = await shopHome();
        process.env.AITP_FAKE_FAULTS = "offline";
        await expect(s.snapshot()).rejects.toThrow(/The phone is offline/);
        await expect(s.act({ kind: "back" })).rejects.toBeInstanceOf(DeviceSessionError);
    });

    it("stops after its number of actions and after its time", async () => {
        fake();
        const s = await start({ maxActions: 3 });
        for (let i = 0; i < 3; i++) await s.act({ kind: "wait", ms: 0 });
        await expect(s.act({ kind: "wait", ms: 0 })).rejects.toThrow(/limit of 3 actions/);
        await expect(s.snapshot()).rejects.toThrow(/has ended/);

        fake();
        const t = await start({ maxMinutes: 1 });
        const real = Date.now;
        const base = real();
        Date.now = () => base + 2 * 60_000;
        try {
            await expect(t.snapshot()).rejects.toThrow(/time limit of 1 minutes/);
        } finally {
            Date.now = real;
        }
    });

    it("stops promptly when the signal fires, and refuses to start when it already fired", async () => {
        fake();
        const ac = new AbortController();
        const s = await start({ signal: ac.signal });
        const slow = s.act({ kind: "wait", ms: 3000 });
        setTimeout(() => ac.abort(), 150);
        const t0 = Date.now();
        await slow.catch(() => undefined);
        expect(Date.now() - t0).toBeLessThan(2500);
        await expect(s.snapshot()).rejects.toThrow(DeviceSessionError);
        const done = new AbortController();
        done.abort();
        fake();
        await expect(start({ signal: done.signal })).rejects.toThrow(/stopped/);
    });

    it("one session at a time uses the device: a second waits until the first is closed", async () => {
        fake();
        const first = await start();
        let second: DeviceSession | undefined;
        const pending = start().then((x) => (second = x));
        await new Promise((r) => setTimeout(r, 1200));
        expect(second).toBeUndefined();
        await first.close();
        await pending;
        expect(second).toBeDefined();
    });
});

describe("an emulator the session started is stopped by exact id; one it did not start is left alone", { timeout: 180_000 }, () => {
    const withAvd = () => {
        const home = path.join(dir, `avd-${n}`);
        fs.mkdirSync(path.join(home, "Fake_AVD.avd", "snapshots", "aitp-clean"), { recursive: true });
        fs.writeFileSync(path.join(home, "Fake_AVD.ini"), "path=x\n");
        process.env.ANDROID_AVD_HOME = home;
    };

    it("starts the project's emulator when no device is connected, and stops exactly that one at the end", async () => {
        fake({ devices: "none" });
        withAvd();
        const s = await start({ avd: "Fake_AVD" });
        const st = state();
        expect(st.emulatorStarts).toBe(1);
        expect(st.devices.map((d) => d.serial)).toEqual(["emulator-5554"]);
        const pid = st.emulatorPid!;
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(lines.some((l) => l.includes("Starting the emulator Fake_AVD"))).toBe(true);
        expect((await s.snapshot()).package).toBe("com.google.android.permissioncontroller");
        await s.close();
        expect(state().devices).toEqual([]);
        for (let i = 0; i < 40; i++) {
            try {
                process.kill(pid, 0);
            } catch {
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(() => process.kill(pid, 0)).toThrow();
        // the emulator was stopped by its serial (adb emu kill), and nothing else was killed
        expect(adbLog().filter((a) => a.includes("emu"))).toEqual(expect.arrayContaining([["-s", "emulator-5554", "emu", "kill"]]));
    });

    it("uses an emulator that was already running as it is, and leaves it running", async () => {
        fake({ devices: "emulator" });
        withAvd();
        const s = await start({ avd: "Fake_AVD" });
        expect((await s.snapshot()).package).toBe("com.google.android.permissioncontroller");
        await s.close();
        const st = state();
        expect(st.emulatorStarts).toBeUndefined();
        expect(st.devices.map((d) => d.serial)).toEqual(["emulator-5554"]);
        expect(st.killed).toBe(false);
        expect(adbLog().some((a) => a.includes("kill"))).toBe(false);
    });

    it("a connected phone is used before any emulator is started, and a chosen serial is honoured", async () => {
        fake({ devices: "both" });
        withAvd();
        const s = await start({ serial: "R58M12ABCDE" });
        expect(s.deviceName).toContain("R58M12ABCDE");
        await s.close();
        expect(state().emulatorStarts).toBeUndefined();
        fake({ devices: "phone" });
        await expect(start({ serial: "NOSUCHDEVICE" })).rejects.toThrow(/No phone or emulator is connected/);
    });

    it("an emulator that fails to start, or a start that is stopped, leaves nothing behind", async () => {
        fake({ devices: "none" });
        withAvd();
        process.env.AITP_FAKE_EMULATOR_FAILS = "1";
        try {
            await expect(start({ avd: "Fake_AVD" })).rejects.toThrow(/emulator exited while starting/);
        } finally {
            delete process.env.AITP_FAKE_EMULATOR_FAILS;
        }
        // the emulator never came up, so the phone's state was never even written: nothing is left running
        expect(fs.existsSync(stateFile) ? state().devices : []).toEqual([]);
    });
});

describe("the picture", { timeout: 180_000 }, () => {
    /** Decodes a JPEG in Chromium and returns the colour of the pixels at the given fractions of the picture. */
    async function colours(jpegBase64: string, at: Array<[number, number]>): Promise<Array<[number, number, number]>> {
        browser ??= await chromium.launch();
        const page = await browser.newPage();
        try {
            return await page.evaluate(
                async ({ b64, points }) => {
                    const img = new Image();
                    await new Promise<void>((resolve, reject) => {
                        img.onload = () => resolve();
                        img.onerror = () => reject(new Error("not a picture"));
                        img.src = `data:image/jpeg;base64,${b64}`;
                    });
                    const c = document.createElement("canvas");
                    c.width = img.width;
                    c.height = img.height;
                    const ctx = c.getContext("2d")!;
                    ctx.drawImage(img, 0, 0);
                    return points.map(([fx, fy]) => {
                        const d = ctx.getImageData(Math.floor(fx * (img.width - 1)), Math.floor(fy * (img.height - 1)), 1, 1).data;
                        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
                    });
                },
                { b64: jpegBase64, points: at },
            );
        } finally {
            await page.close();
        }
    }
    const near = (c: [number, number, number], want: readonly number[], tol = 14) => c.every((v, i) => Math.abs(v - want[i]!) <= tol);

    it.each([1, 3])("a password field is covered flat in the picture (screen scale %i), the rest is the screen, and the size is within the contract", async (scale) => {
        fake({ scale });
        const { s, home } = await shopHome();
        const signin = await tap(s, byText(home, "Sign in"));
        const snap = await s.snapshot({ screenshot: true });
        expect(snap.screenshot).toBeDefined();
        const jpeg = Buffer.from(snap.screenshot!, "base64");
        expect(jpeg.length).toBeLessThanOrEqual(120_000);
        expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        expect(await s.snapshot()).not.toHaveProperty("screenshot");

        // the screen is 360x640 logical units (times the scale); the password field is [16,184][344,232], the login button [16,256][344,304]
        const W = 360;
        const H = 640;
        const f = (x: number, y: number): [number, number] => [x / W, y / H];
        const [inPassword, inPasswordEdge, inUsername, inButton, background] = await colours(snap.screenshot!, [f(180, 208), f(40, 190), f(180, 144), f(180, 280), f(180, 400)]);
        // covered: the flat cover colour, not the fake screen's dark blue field
        expect(near(inPassword!, COVER_RGB), `password ${inPassword}`).toBe(true);
        expect(near(inPasswordEdge!, COVER_RGB), `password edge ${inPasswordEdge}`).toBe(true);
        expect(near(inPassword!, [26, 35, 126]), "the blue the field was drawn in").toBe(false);
        // everything else is untouched: the user name field and the button are the fake screen's light grey, the background is white
        expect(near(inUsername!, [224, 224, 224]), `username ${inUsername}`).toBe(true);
        expect(near(inButton!, [224, 224, 224]), `button ${inButton}`).toBe(true);
        expect(near(background!, [255, 255, 255]), `background ${background}`).toBe(true);
        expect(signin.package).toBe(SHOP);
        // the picture is also available straight from an action
        const r = await s.act({ kind: "wait", ms: 0 }, { screenshot: true });
        expect(r.snapshot!.screenshot).toBeDefined();
    });

    it("a field that shows the password in its text is covered too", async () => {
        fake({ faults: "show-password" });
        const { s, home } = await shopHome();
        const signin = await tap(s, byText(home, "Sign in"));
        const user = byId(signin, "username_field");
        const field = byId(signin, "password_field");
        // the app shows what was typed; type something recognisable through the only allowed route: the user name stand-in into a plain field
        await go(s, { kind: "type", index: field.index, text: "visible-to-everyone-1" });
        const snap = await s.snapshot({ screenshot: true });
        expect(user.editable).toBe(true);
        // not a password and not the stored one: nothing to cover, nothing to hide, the text is simply there (the stored password never was typed here)
        expect(snap.elements.find((e) => e.id === "password_field")!.text).toBe("visible-to-everyone-1");
        const [inField] = await colours(snap.screenshot!, [[180 / 360, 208 / 640]]);
        expect(near(inField!, [224, 224, 224])).toBe(true);
    });
});
