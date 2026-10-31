/**
 * R24 (EXPLORE): reading screens that never settle, on the FAKE adb (tests/fixtures/fake-adb.mjs: no phone, no emulator, no adb server).
 * `uiautomator dump` fails with "could not get idle state" on such screens: the session tries again, then the compressed dump, then the
 * UiAutomator2 server already installed on the phone (here the fake's stand-in, an HTTP server on a forwarded port), and stops that server
 * again when it closes. Also: the activities the phone lists for the app, and a whole map exploration through the real local session.
 *
 * Spawns fake adb processes and one local HTTP server (port 7391): run under the browser lock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { allowedCommand, allowedServerCommand } from "../src/engine/mobile/device/adb.js";
import { openLocalDeviceSession } from "../src/engine/mobile/device/session.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { explore, ModelBudget } from "../src/engine/mobile/explore/explorer.js";

const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const PORT = 7391;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-map-device-"));
let n = 0;

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function phone(extra: Record<string, string> = {}) {
    const state = path.join(tmp, `state-${++n}.json`);
    const log = path.join(tmp, `log-${n}.jsonl`);
    const env: NodeJS.ProcessEnv = { ...process.env, AITP_ADB_PATH: FAKE_ADB, AITP_FAKE_APP: "shop", AITP_FAKE_DEVICES: "emulator", AITP_FAKE_STATE: state, AITP_FAKE_ADB_LOG: log, AITP_UIA2_PORT: String(PORT), TAQWRIGHT_HOME: path.join(tmp, "no-toolchain"), ...extra };
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\n/).filter(Boolean).map((l) => (JSON.parse(l) as string[]).join(" ")) : []);
    const app = () => JSON.parse(fs.readFileSync(state, "utf8"));
    return { env, calls, app };
}

const llm: LlmClient = { modelName: "scripted", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => ({})) as LlmClient["object"] };

describe("reading a screen that never settles", () => {
    it("the closed adb lists: the compressed dump for the session; the server's calls only through forServerSource", () => {
        expect(allowedCommand(["exec-out", "uiautomator", "dump", "--compressed", "/dev/tty"])).toBe(true);
        expect(allowedCommand(["exec-out", "uiautomator", "dump", "--compressed", "/sdcard/x.xml"])).toBe(false);
        expect(allowedCommand(["forward", `tcp:${PORT}`, "tcp:6790"])).toBe(false);
        expect(allowedServerCommand(["forward", `tcp:${PORT}`, "tcp:6790"])).toBe(true);
        expect(allowedServerCommand(["forward", "--remove", `tcp:${PORT}`])).toBe(true);
        expect(allowedServerCommand(["forward", "tcp:80", "tcp:6790"])).toBe(false);
        expect(allowedServerCommand(["forward", `tcp:${PORT}`, "tcp:5037"])).toBe(false);
        expect(allowedServerCommand(["shell", "am", "instrument", "-w", "-e", "disableAnalytics", "true", "io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner"])).toBe(true);
        expect(allowedServerCommand(["shell", "am", "instrument", "-w", "com.evil/.Runner"])).toBe(false);
        expect(allowedServerCommand(["shell", "rm", "-rf", "/"])).toBe(false);
    });

    it("falls back to the compressed dump when the plain one cannot get an idle state, and keeps using it", async () => {
        const p = phone({ AITP_FAKE_FAULTS: "idle-never" });
        const lines: string[] = [];
        const s = await openLocalDeviceSession({ appPackage: "com.example.shop", env: p.env, log: (l) => lines.push(l) });
        try {
            const snap = await s.snapshot();
            expect(snap.package).toBe("com.google.android.permissioncontroller");
            const r = await s.act({ kind: "tap", index: snap.elements.find((e) => e.text === "Don't allow")!.index });
            expect(r.ok).toBe(true);
            expect(r.snapshot!.elements.some((e) => e.text === "Products")).toBe(true);
        } finally {
            await s.close();
        }
        expect(lines.some((l) => /compressed form/.test(l))).toBe(true);
        const dumps = p.calls().filter((c) => c.includes("uiautomator dump"));
        // After the switch every read is the compressed one.
        const firstCompressed = dumps.findIndex((c) => c.includes("--compressed"));
        expect(firstCompressed).toBeGreaterThan(0);
        expect(dumps.slice(firstCompressed).every((c) => c.includes("--compressed"))).toBe(true);
    }, 120_000);

    it("reads the screen through the installed UiAutomator2 server when no dump works, and stops that server when it is done", async () => {
        const p = phone({ AITP_FAKE_FAULTS: "no-uidump", AITP_FAKE_UIA2: "installed" });
        const lines: string[] = [];
        const s = await openLocalDeviceSession({ appPackage: "com.example.shop", env: p.env, log: (l) => lines.push(l) });
        let products = false;
        try {
            const snap = await s.snapshot();
            const r = await s.act({ kind: "tap", index: snap.elements.find((e) => e.text === "Don't allow")!.index });
            products = r.snapshot!.elements.some((e) => e.text === "Products" && e.id === "products_button");
        } finally {
            await s.close();
        }
        expect(products).toBe(true);
        expect(lines.some((l) => /UiAutomator2 server/.test(l))).toBe(true);
        const st = p.app();
        expect(st.uia2.sessions).toBe(1);
        expect(st.uia2.settings).toBe(1);
        expect(st.uia2.sources).toBeGreaterThan(2);
        expect(st.uia2.deleted).toBe(1);
        expect(st.forward).toBeNull();
        const calls = p.calls();
        expect(calls.some((c) => c.endsWith("am force-stop io.appium.uiautomator2.server"))).toBe(true);
        expect(calls.some((c) => c.endsWith("am force-stop io.appium.uiautomator2.server.test"))).toBe(true);
        // The server process this session started is gone: nothing answers on the port any more.
        await expect(fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    }, 120_000);

    it("without the server on the phone, a screen that never settles is said in plain words", async () => {
        const p = phone({ AITP_FAKE_FAULTS: "no-uidump" });
        await expect(openLocalDeviceSession({ appPackage: "com.example.shop", env: p.env })).rejects.toThrow(/could not|never settles|could not do that/i);
        expect(p.calls().some((c) => c.includes("am instrument"))).toBe(false);
    }, 120_000);
});

describe("a map exploration through the local session", () => {
    it("explores the fake shop signed in, counts the activities the phone lists, and records the device", async () => {
        const p = phone({ AITP_FAKE_ACTIVITIES: "listed" });
        const s = await openLocalDeviceSession({ appPackage: "com.example.shop", env: p.env, credentials: { username: "tester", password: "Fake-Pass-1234" }, maxActions: 400 });
        expect(s.listedActivities).toBeTypeOf("function");
        const events: Array<{ kind: string; message: string }> = [];
        let model;
        try {
            model = await explore({ ctx: { config: {} as never, llm, emit: (e) => events.push(e) }, session: s, appPackage: "com.example.shop", credentialsGiven: true, allowDataChanges: false, secrets: ["tester", "Fake-Pass-1234"], strategy: "map", depth: "quick" }, new ModelBudget(20));
        } finally {
            await s.close();
        }
        expect(model.stats.stop).toBe("explored");
        expect(model.signedIn).toBe(true);
        expect(p.app().app.loggedIn).toBe(true);
        expect(p.app().app.deleted).toBeFalsy();
        expect(model.coverage).toMatchObject({ depth: "quick", activitiesListed: 6, stop: "explored" });
        const skipped = model.skipped.map((x) => x.message);
        expect(skipped).toContain("Skipped “Delete account” because it looks destructive");
        expect(skipped).toContain("Skipped “Check out” because it looks like a payment or purchase");
        expect(skipped).toContain("Skipped “Log out” because signing out would end the session the exploration uses");
        expect(model.coverage!.activitiesSeen).toEqual(expect.arrayContaining(["MainActivity", "SignInActivity", "ProductsActivity", "CartActivity"]));
        expect(model.device).toMatchObject({ serial: "emulator-5554", emulator: true, name: expect.stringContaining("emulator-5554") });
        const done = events.find((e) => e.kind === "mobile_exploration_done")!;
        expect(done.message).toMatch(/of the 6 the phone lists for the app/);
        expect(JSON.stringify(model)).not.toContain("Fake-Pass-1234");
    }, 300_000);

    // The map-mode versions of what tests/mobile-explore.test.ts guards for the AI-led loop.
    it("a hostile screen changes nothing: never pays, deletes, sends or logs out, and the run ends cleanly", async () => {
        const p = phone({ AITP_FAKE_FAULTS: "hostile" });
        const s = await openLocalDeviceSession({ appPackage: "com.example.shop", env: p.env, credentials: { username: "tester", password: "Fake-Pass-1234" }, maxActions: 400 });
        const events: Array<{ kind: string; message: string; level?: string }> = [];
        let model;
        try {
            model = await explore({ ctx: { config: {} as never, llm, emit: (e) => events.push(e) }, session: s, appPackage: "com.example.shop", credentialsGiven: true, allowDataChanges: false, secrets: ["tester", "Fake-Pass-1234"], strategy: "map", depth: "quick" }, new ModelBudget(20));
        } finally {
            await s.close();
        }
        expect(model.stats.stop).toBe("explored");
        expect(events.some((e) => e.kind === "mobile_hostile_text" && e.level === "warn")).toBe(true);
        const app = p.app().app;
        expect(app.deleted).toBeFalsy();
        expect(app.paid).toBeFalsy();
        // The hostile line asks to "tap Delete my account": the screen reads as a deletion screen, so the safety filter refuses every
        // tap on it but the ways out (as for the AI-led loop), and the exploration ends with what it could do safely.
        const skipped = model.skipped.map((x) => x.message);
        expect(skipped).toContain("Skipped “Delete account” because it looks destructive");
        expect(skipped.some((m) => /because this screen looks destructive/.test(m))).toBe(true);
        const taps = p.calls().filter((c) => / input tap /.test(c));
        // Delete account sits at y 432-480 of the home screen: never tapped.
        expect(taps.filter((c) => { const y = Number(c.split(" ").at(-1)); return y >= 432 && y < 480; })).toEqual([]);
        // Nothing the screen said reached the AI: the one AI call is the naming at the end, and its prompt has no orders in it.
        expect(JSON.stringify(model)).not.toMatch(/ignore previous instructions/i);
    }, 300_000);

    it("without a test account it never types into a user name, password, e-mail or code field; a search word is fine", async () => {
        const p = phone();
        const s = await openLocalDeviceSession({ appPackage: "com.example.shop", env: p.env, maxActions: 400 });
        const events: Array<{ kind: string; message: string }> = [];
        let model;
        try {
            model = await explore({ ctx: { config: {} as never, llm, emit: (e) => events.push(e) }, session: s, appPackage: "com.example.shop", credentialsGiven: false, allowDataChanges: false, strategy: "map", depth: "quick" }, new ModelBudget(20));
        } finally {
            await s.close();
        }
        const typed = p.app().typed as Array<{ field: string; text: string }>;
        expect(typed.filter((t) => /user|pass|mail|code|otp/i.test(t.field))).toEqual([]);
        // Typing a harmless word into the search box is part of exploring.
        expect(typed).toContainEqual({ field: "search", text: "test" });
        expect(model.signInNeeded).toBe(true);
        expect(events.some((e) => e.kind === "mobile_sign_in_needed")).toBe(true);
        expect(model.stats.stop).toBe("explored");
    }, 300_000);
});
