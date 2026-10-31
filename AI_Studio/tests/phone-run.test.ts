/**
 * Phone test runs on the right device (round 24, RUN), through the real mobile runner with the fake adb (tests/fixtures/fake-adb.mjs) and a stand-in
 * Taqwright CLI written here: which device a run uses (a ready phone with the app beats the emulator, and no emulator is started then), the screen that
 * opens the app resolved on that device (resolve-activity, the chooser refused in favour of dumpsys package, Windows line ends, a parallel-apps user),
 * pre-flight that stops a run in words, and a failure of the phone itself retried once and then reported as the phone's.
 * Never a real phone or emulator: adb is the fake, the "emulator program" only leaves a mark if anything starts it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { runMobileScripts, type MobileRunEnv, type UsedDevice } from "../src/engine/validation/mobile-runner.js";
import { PHONE_INFRA_PREFIX } from "../src/engine/mobile/device/infra.js";
import type { ScriptInput } from "../src/engine/validation/runner.js";

const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const PKG = "com.example.shop";
let tmp: string;
let stub: string;
let emulatorMark: string;
let behaviour: string;
let n = 0;

/** The stand-in Taqwright CLI: records what it was given, then passes every test, except that `behaviour.json` can make a test fail with a given error for its first N runs. */
const STAND_IN = (dir: string) => `import fs from "node:fs";
import path from "node:path";
const cwd = process.cwd();
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(path.join(dir, "observed.jsonl"), JSON.stringify({ env: process.env, config: fs.readFileSync(path.join(cwd, "taqwright.config.ts"), "utf8"), files: fs.readdirSync(cwd).filter((f) => f.endsWith(".spec.ts")) }) + "\\n");
let b = {};
try { b = JSON.parse(fs.readFileSync(path.join(dir, "behaviour.json"), "utf8")); } catch {}
const specs = [];
for (const file of fs.readdirSync(cwd).filter((f) => f.endsWith(".spec.ts"))) {
    const id = file.split(".")[0];
    const rule = b[id];
    let error;
    if (rule && rule.times > 0) { rule.times--; error = rule.error; fs.writeFileSync(path.join(dir, "behaviour.json"), JSON.stringify(b)); }
    specs.push({ title: file, file, tests: [{ status: error ? "unexpected" : "expected", results: [{ status: error ? "failed" : "passed", duration: 50, steps: [{ title: "1. Open", duration: 5, ...(error ? { error: { message: error } } : {}) }], ...(error ? { error: { message: error } } : {}), attachments: [] }] }] });
}
fs.writeFileSync(path.join(cwd, "report.json"), JSON.stringify({ suites: [{ file: "x", specs, suites: [] }], errors: [] }));
`;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-run-"));
    stub = path.join(tmp, "stand-in-taqwright.mjs");
    fs.writeFileSync(stub, STAND_IN(tmp));
    behaviour = path.join(tmp, "behaviour.json");
    emulatorMark = path.join(tmp, "emulator-started");
    // The "emulator program": it only leaves a mark (and exits), so a test can prove nothing started it.
    fs.writeFileSync(path.join(tmp, "emulator.mjs"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(emulatorMark)}, process.argv.slice(2).join(" "));\n`);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Case {
    devices?: "phone" | "emulator" | "both" | "none";
    faults?: string;
    resolve?: string;
    target?: Partial<MobileRunEnv["target"]>;
    avd?: string;
    manageEmulator?: boolean;
    scripts?: ScriptInput[];
    behaviour?: Record<string, { times: number; error: string }>;
}

const script = (id: string): ScriptInput => ({ testId: id, filename: `${id}.mobile.spec.ts`, content: `// ${id}\n` });

async function run(c: Case) {
    const id = ++n;
    const state = path.join(tmp, `state-${id}.json`);
    const adbLog = path.join(tmp, `adb-${id}.jsonl`);
    fs.rmSync(path.join(tmp, "observed.jsonl"), { force: true });
    fs.rmSync(emulatorMark, { force: true });
    if (c.behaviour) fs.writeFileSync(behaviour, JSON.stringify(c.behaviour));
    else fs.rmSync(behaviour, { force: true });
    const sourceEnv: NodeJS.ProcessEnv = {
        AITP_ADB_PATH: FAKE_ADB,
        AITP_EMULATOR_PATH: path.join(tmp, "emulator.mjs"),
        AITP_FAKE_STATE: state,
        AITP_FAKE_ADB_LOG: adbLog,
        AITP_FAKE_APP: "shop",
        AITP_FAKE_DEVICES: c.devices ?? "both",
        AITP_FAKE_FAULTS: c.faults ?? "",
        ...(c.resolve ? { AITP_FAKE_RESOLVE: c.resolve } : {}),
        // Never the real Android tools of this computer.
        TAQWRIGHT_HOME: path.join(tmp, "no-taqwright"),
        ANDROID_HOME: "",
        ANDROID_AVD_HOME: path.join(tmp, "no-avd"),
        SYSTEMROOT: process.env.SYSTEMROOT,
    };
    const log: string[] = [];
    const used: UsedDevice[] = [];
    const runs = await runMobileScripts(path.join(tmp, `scratch-${id}`), c.scripts ?? [script("MOB-001")], {
        target: { appPackage: PKG, ...(c.target ?? {}) },
        avd: c.avd ?? "Fake_AVD",
        sourceEnv,
        cliPath: stub,
        manageEmulator: c.manageEmulator ?? true,
        keepEmulator: true,
        log: (m) => log.push(m),
        onDevice: (d) => void used.push(d),
    });
    const observed = fs.existsSync(path.join(tmp, "observed.jsonl"))
        ? fs
              .readFileSync(path.join(tmp, "observed.jsonl"), "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l) as { env: Record<string, string>; config: string; files: string[] })
        : [];
    const adb = fs.existsSync(adbLog)
        ? fs
              .readFileSync(adbLog, "utf8")
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l) as string[])
              .map((a) => (a[0] === "-s" ? `${a[1]}: ${a.slice(2).join(" ")}` : a.join(" ")))
        : [];
    return { runs, log, used, observed, adb, emulatorStarted: fs.existsSync(emulatorMark) };
}

describe("the device a phone run uses", () => {
    it("a ready phone that has the app is used, and no emulator is started although one is set up", async () => {
        const r = await run({ devices: "both" });
        expect(r.runs.map((x) => x.status)).toEqual(["passed"]);
        expect(r.emulatorStarted).toBe(false);
        const env = r.observed[0]!.env;
        expect(env).toMatchObject({ MOBILE_UDID: "R58M12ABCDE", MOBILE_DEVICE_KIND: "phone", MOBILE_APP_COMPONENT: `${PKG}/.MainActivity`, MOBILE_APP_USER: "0", MOBILE_PERMISSION_ANSWER: "allow" });
        expect(r.log).toContain("Phone tests run on Pixel 7 (R58M12ABCDE), a phone on this computer that has the app.");
        expect(r.log).toContain("Ran on Pixel 7 (R58M12ABCDE), a phone on this computer.");
        expect(r.runs[0]!.notes).toEqual(["Ran on Pixel 7 (R58M12ABCDE), a phone on this computer."]);
        expect(r.used).toEqual([{ serial: "R58M12ABCDE", model: "Pixel 7", emulator: false, component: `${PKG}/.MainActivity`, user: 0, sentence: "Ran on Pixel 7 (R58M12ABCDE), a phone on this computer." }]);
        // The launcher was asked for the current user on that phone, with the launcher category; never the emulator.
        expect(r.adb).toContain(`R58M12ABCDE: shell cmd package resolve-activity --brief --user 0 -c android.intent.category.LAUNCHER ${PKG}`);
        expect(r.adb.some((c) => c.startsWith("emulator-5554:"))).toBe(false);
    }, 60_000);

    it("the phone the AI explored on is used even when another phone with the app comes first", async () => {
        const r = await run({ devices: "both", target: { exploredOn: { serial: "emulator-5554", emulator: true }, runsOn: { kind: "explored" } } });
        expect(r.observed[0]!.env).toMatchObject({ MOBILE_UDID: "emulator-5554", MOBILE_APP_COMPONENT: `${PKG}/.MainActivity` });
        expect(r.observed[0]!.env.MOBILE_DEVICE_KIND).toBeUndefined();
        expect(r.emulatorStarted).toBe(false);
        expect(r.log).toContain("Phone tests run on the emulator emulator-5554, the one the AI explored on.");
    }, 60_000);

    it("\"An emulator\" is respected even with a ready phone: the running emulator of the project's AVD is used, nothing new starts", async () => {
        const r = await run({ devices: "both", target: { runsOn: { kind: "emulator" } } });
        expect(r.observed[0]!.env.MOBILE_UDID).toBe("emulator-5554");
        expect(r.emulatorStarted).toBe(false);
        expect(r.log).toContain("Using the emulator that is already running (emulator-5554)");
        expect(r.log).toContain("Ran on the emulator emulator-5554 (Fake_AVD) on this computer.");
    }, 60_000);

    it("a chosen phone that is not connected falls back, and the run says so", async () => {
        const r = await run({ devices: "emulator", target: { runsOn: { kind: "phone", serial: "R58N20ABCDE", model: "CPH2467" } } });
        expect(r.log).toContain("The phone chosen for this project, CPH2467 (R58N20ABCDE), is not connected to this computer, so phone tests run on the emulator Fake_AVD.");
        expect(r.observed[0]!.env.MOBILE_UDID).toBe("emulator-5554");
    }, 60_000);

    it("no phone with the app and no emulator: the phone could not run the tests, in words, and nothing ran", async () => {
        const r = await run({ devices: "phone", avd: "", target: { appPackage: "com.example.missing" } });
        expect(r.runs[0]).toMatchObject({ status: "error" });
        expect(r.runs[0]!.error).toBe(`${PHONE_INFRA_PREFIX}No phone with the app is connected and no emulator is set up on this computer. Plug in a phone with USB debugging on and the app installed, or create an emulator.`);
        expect(r.observed).toEqual([]);
        expect(r.emulatorStarted).toBe(false);
    }, 60_000);

    it("a stand-in runner with no choice made keeps the device it was given (the platform's own tests, as before)", async () => {
        const r = await run({ devices: "both", manageEmulator: false });
        expect(r.observed[0]!.env.MOBILE_UDID).toBe("");
        expect(r.observed[0]!.env.MOBILE_APP_COMPONENT).toBeUndefined();
        expect(r.adb.some((c) => c.includes("resolve-activity --brief --user"))).toBe(false);
    }, 60_000);
});

describe("the screen that opens the app, on the device", () => {
    it("the \"Open with\" chooser is never used: the app's own launcher comes from dumpsys package", async () => {
        const r = await run({ devices: "phone", resolve: "chooser" });
        expect(r.observed[0]!.env.MOBILE_APP_COMPONENT).toBe(`${PKG}/.launcher.SplashAlias`);
        expect(r.log.some((l) => /chooser/.test(l))).toBe(true);
        expect(r.log).toContain(`The app opens with ${PKG}/.launcher.SplashAlias (found by reading the app's description on the phone).`);
    }, 60_000);

    it("Windows line ends never reach the component", async () => {
        const r = await run({ devices: "phone", resolve: "crlf" });
        expect(r.observed[0]!.env.MOBILE_APP_COMPONENT).toBe(`${PKG}/.MainActivity`);
    }, 60_000);

    it("an app that is only in the parallel-apps user stops the run before it starts, in words", async () => {
        const r = await run({ devices: "phone", faults: "clone-only", target: { runsOn: { kind: "phone", serial: "R58M12ABCDE" } } });
        expect(r.runs[0]!.status).toBe("error");
        expect(r.runs[0]!.error).toBe(`${PHONE_INFRA_PREFIX}The app ${PKG} is not installed for the phone's current user (user 0). Install it for that user, or switch the phone to the user that has it.`);
        expect(r.observed).toEqual([]);
    }, 60_000);

    it("a locked phone stops the run with a sentence, never a test verdict", async () => {
        const r = await run({ devices: "phone", faults: "locked" });
        expect(r.runs[0]!.error).toBe(`${PHONE_INFRA_PREFIX}The phone is locked. Unlock it, and for test runs set its screen lock to None or Swipe, then run the tests again.`);
        expect(r.observed).toEqual([]);
    }, 60_000);
});

describe("a failure of the phone itself", () => {
    const crash = "WebDriverError: 'POST /element' cannot be proxied to UiAutomator2 server because the instrumentation process is not running (probably crashed)";

    it("is run once more after the test helper is stopped; a pass the second time is a pass", async () => {
        const r = await run({ devices: "phone", scripts: [script("MOB-001"), script("MOB-002")], behaviour: { "MOB-002": { times: 1, error: crash } } });
        expect(r.runs.map((x) => x.status)).toEqual(["passed", "passed"]);
        expect(r.observed.map((o) => o.files)).toEqual([["MOB-001.mobile.spec.ts", "MOB-002.mobile.spec.ts"], ["MOB-002.mobile.spec.ts"]]);
        expect(r.adb).toContain("R58M12ABCDE: shell am force-stop io.appium.uiautomator2.server");
        expect(r.log.some((l) => /A test could not run because of the phone \(the test helper on the phone \(UiAutomator2\) stopped while the test ran\); running it once more\./.test(l))).toBe(true);
    }, 60_000);

    it("twice is reported as the phone's problem, not as a failing test of the app", async () => {
        const r = await run({ devices: "phone", behaviour: { "MOB-001": { times: 2, error: "Error: socket hang up" } } });
        expect(r.runs[0]!.status).toBe("error");
        expect(r.runs[0]!.error).toMatch(/^The phone could not run the test: the connection to the phone dropped while the test ran\. It was tried twice\. This is a problem of the phone or its connection, not a failing test of the app\./);
        // A failure of the app is not retried.
        const app = await run({ devices: "phone", behaviour: { "MOB-001": { times: 1, error: "expect(locator).toBeVisible() failed" } } });
        expect(app.runs[0]!.status).toBe("failed");
        expect(app.observed).toHaveLength(1);
    }, 60_000);
});
