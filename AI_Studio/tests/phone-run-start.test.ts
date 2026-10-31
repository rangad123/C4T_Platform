/**
 * How phone tests start and what they do about system dialogs (round 24, RUN), through REAL Taqwright (its CLI, the Playwright runner, its fixtures
 * and locators) against a scripted Appium server written here: no phone, no emulator, no Appium.
 *
 *  - an old-style stored script (beforeEach: terminateApp + launchApp, the way scripts were written before) starts through the run configuration's
 *    explicit start (`mobile: startActivity` on the resolved component) and never calls `mobile: activateApp`; without the resolved component the same
 *    script hits the owner's error ("Unable to resolve the launchable activity"), which is what the configuration fixes;
 *  - the session asks for the resolved activity, a wildcard wait activity, a forced restart and no idle wait;
 *  - a generated script starts the same way, its dialog watch answers a permission question the test did not, and brings the app back once when
 *    another app came to the front.
 * The Appium port is a local one picked here; PATH has no adb, so nothing ever talks to a real device.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { MOBILE_RUN_CONFIG, runTaqwrightCli } from "../src/engine/validation/mobile-runner.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const PKG = "com.example.shop";
const COMPONENT = `${PKG}/.MainActivity`;
const PERMISSION = "com.google.android.permissioncontroller";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const PORT = 7371;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface El {
    id: string;
    text: string;
    act?: () => void;
}

/** The scripted Appium server: one app (the shop's first screen), the permission question, a browser; every command is recorded. */
class ScriptedAppium {
    server!: http.Server;
    log: Array<{ cmd: string; body: any }> = [];
    sessions: any[] = [];
    fg = "";
    permissionPending = false;
    activateFails = false;
    /** How many times "isn't responding" shows (after the start, and again after Wait). */
    anrShows = 0;

    screen(): El[] {
        if (this.fg === PKG) return [{ id: `${PKG}:id/toolbar_title`, text: "Shop" }, { id: `${PKG}:id/terms_link`, text: "Terms and conditions", act: () => (this.fg = "com.android.chrome") }];
        if (this.fg === PERMISSION)
            return [
                { id: "com.android.permissioncontroller:id/permission_allow_button", text: "Allow", act: () => ((this.permissionPending = false), (this.fg = PKG)) },
                { id: "com.android.permissioncontroller:id/permission_deny_button", text: "Don't allow", act: () => ((this.permissionPending = false), (this.fg = PKG)) },
            ];
        if (this.fg === "com.android.chrome") return [{ id: "com.android.chrome:id/url_bar", text: "example.test/terms" }];
        if (this.fg === "android")
            return [
                { id: "android:id/aerr_wait", text: "Wait", act: () => (this.fg = --this.anrShows > 0 ? "android" : PKG) },
                { id: "android:id/aerr_close", text: "Close app", act: () => ((this.anrShows = 0), (this.fg = PKG)) },
            ];
        return [];
    }

    find(using: string, value: string): string[] {
        const els = this.screen();
        const hit = (e: El): boolean => {
            if (using === "id") return e.id === value || e.id.endsWith(`:id/${value}`);
            if (using === "accessibility id") return false;
            if (using === "-android uiautomator") {
                const rm = /resourceIdMatches\("((?:[^"\\]|\\.)*)"\)/.exec(value);
                if (rm) return new RegExp(`^${rm[1]}$`).test(e.id);
                const rid = /resourceId\("([^"]*)"\)/.exec(value);
                if (rid) return e.id === rid[1];
                const t = /text\("([^"]*)"\)/.exec(value);
                if (t) return e.text === t[1];
                return false;
            }
            return [...value.matchAll(/["']([^"']+)["']/g)].some((m) => e.id.endsWith(`:id/${m[1]}`) || e.id === m[1] || e.text === m[1]);
        };
        return els.filter(hit).map((e) => `${this.fg}#${e.id}`);
    }

    start(): Promise<void> {
        this.server = http.createServer((req, res) => {
            let raw = "";
            req.on("data", (d) => (raw += d));
            req.on("end", () => {
                const body = raw ? JSON.parse(raw) : {};
                const url = (req.url ?? "").replace(/\/+$/, "");
                const send = (value: unknown, status = 200) => {
                    res.writeHead(status, { "content-type": "application/json" });
                    res.end(JSON.stringify({ value }));
                };
                const fail = (error: string, message: string, status = 500) => send({ error, message, stacktrace: "" }, status);
                if (req.method === "POST" && url === "/session") {
                    const caps = body.capabilities?.alwaysMatch ?? {};
                    this.sessions.push(caps);
                    this.log.push({ cmd: "newSession", body: caps });
                    return send({ sessionId: `s${this.sessions.length}`, capabilities: { ...caps, platformName: "Android" } });
                }
                const m = /^\/session\/[^/]+(\/.*)?$/.exec(url);
                if (!m) return send(null);
                const rest = m[1] ?? "";
                if (req.method === "DELETE" && rest === "") return send(null);
                if (rest === "/execute/sync") {
                    const script = String(body.script);
                    const arg = (body.args ?? [])[0] ?? {};
                    this.log.push({ cmd: script, body: arg });
                    if (script === "mobile: startActivity") {
                        if (arg.component !== COMPONENT) return fail("unknown error", `Activity ${arg.component} does not exist`);
                        this.fg = this.permissionPending ? PERMISSION : this.anrShows > 0 ? "android" : PKG;
                        return send("Status: ok");
                    }
                    if (script === "mobile: terminateApp") {
                        this.fg = "";
                        return send(true);
                    }
                    if (script === "mobile: activateApp") {
                        if (this.activateFails) return fail("unknown error", `An unknown server-side error occurred while processing the command. Original error: Unable to resolve the launchable activity of '${PKG}'. Original error: No activity found`);
                        this.fg = PKG;
                        return send(null);
                    }
                    if (script === "mobile: getCurrentPackage") return send(this.fg || "com.android.launcher3");
                    if (script === "mobile: queryAppState") return send(this.fg === PKG ? 4 : 1);
                    return send(null);
                }
                if (rest === "/elements" || rest === "/element") {
                    const ids = this.find(body.using, body.value);
                    if (rest === "/elements") return send(ids.map((id) => ({ [ELEMENT]: id })));
                    return ids[0] ? send({ [ELEMENT]: ids[0] }) : fail("no such element", "An element could not be located on the page using the given search parameters.", 404);
                }
                const el = /^\/element\/([^/]+)\/(\w+)/.exec(rest);
                if (el) {
                    const id = decodeURIComponent(el[1]!);
                    const [fg, rid] = [id.slice(0, id.indexOf("#")), id.slice(id.indexOf("#") + 1)];
                    const e = fg === this.fg ? this.screen().find((x) => x.id === rid) : undefined;
                    if (!e) return fail("stale element reference", "The element is no longer on the screen", 404);
                    if (el[2] === "click") {
                        this.log.push({ cmd: "click", body: rid });
                        e.act?.();
                        return send(null);
                    }
                    if (el[2] === "displayed" || el[2] === "enabled") return send(true);
                    if (el[2] === "rect") return send({ x: 10, y: 10, width: 200, height: 48 });
                    if (el[2] === "text") return send(e.text);
                    if (el[2] === "attribute") return send(rest.endsWith("/displayed") || rest.endsWith("/enabled") ? "true" : e.text);
                    return send(null);
                }
                if (rest === "/screenshot") return send(PNG);
                if (rest === "/source") return send(`<hierarchy><node package="${this.fg}"/></hierarchy>`);
                if (rest === "/window/rect") return send({ x: 0, y: 0, width: 1080, height: 2400 });
                return send(null);
            });
        });
        return new Promise((r) => this.server.listen(PORT, "127.0.0.1", () => r()));
    }

    reset(o: { permissionPending?: boolean; activateFails?: boolean; anrShows?: number } = {}) {
        this.anrShows = o.anrShows ?? 0;
        this.log = [];
        this.sessions = [];
        this.fg = "";
        this.permissionPending = o.permissionPending ?? false;
        this.activateFails = o.activateFails ?? false;
    }
}

const appium = new ScriptedAppium();
let root: string;

beforeAll(async () => {
    await appium.start();
    fs.mkdirSync(path.join(REPO_ROOT, ".validation"), { recursive: true });
    root = fs.mkdtempSync(path.join(REPO_ROOT, ".validation", "phone-run-start-"));
});
afterAll(async () => {
    await new Promise<void>((r) => appium.server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
});

/** A stored script exactly as the generator wrote phone tests before round 24. */
const OLD_STYLE = `import { test, expect } from "@taqwright/taqwright";

test.beforeEach(async ({ mobile }) => {
    // Every test starts from the app's first screen: stop the app if it is running, then open it.
    const appId = process.env.MOBILE_APP_PACKAGE;
    if (appId) {
        await mobile.terminateApp(appId).catch(() => undefined);
        await mobile.launchApp(appId);
    }
});

test("MOB-001: Shop opens", async ({ mobile }) => {
    await test.step("1. Verify visible of testId \\"toolbar_title\\"", async () => {
        await expect(mobile.getByTestId("toolbar_title")).toBeVisible();
    });
});
`;

let runs = 0;
async function runReal(content: string, env: Record<string, string>) {
    const dir = path.join(root, `run-${++runs}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "taqwright.config.ts"), MOBILE_RUN_CONFIG);
    fs.writeFileSync(path.join(dir, "MOB-001.mobile.spec.ts"), content);
    const sys = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "";
    const childEnv: NodeJS.ProcessEnv = {
        // No adb anywhere on this PATH: Taqwright's own device lookups find nothing and no real device is ever asked.
        PATH: [path.dirname(process.execPath), sys ? path.join(sys, "System32") : "/usr/bin:/bin"].join(path.delimiter),
        ...(sys ? { SYSTEMROOT: sys } : {}),
        TEMP: os.tmpdir(),
        TMP: os.tmpdir(),
        HOME: os.tmpdir(),
        USERPROFILE: os.tmpdir(),
        FORCE_COLOR: "0",
        MOBILE_AVD: "Fake_AVD",
        MOBILE_UDID: "",
        MOBILE_APPIUM_PORT: String(PORT),
        MOBILE_APP_PACKAGE: PKG,
        MOBILE_APK_PATH: "",
        MOBILE_TEST_TIMEOUT_MS: "60000",
        MOBILE_PERMISSION_ANSWER: "allow",
        ...env,
    };
    const [run] = await runTaqwrightCli({ runDir: dir, childEnv, scripts: [{ testId: "MOB-001", filename: "MOB-001.mobile.spec.ts", content }], timeoutMs: 180_000 });
    return run!;
}

describe("a stored script written before the explicit start", () => {
    it("starts through the run configuration's explicit start and passes without being explored or written again", async () => {
        appium.reset({ activateFails: true });
        const run = await runReal(OLD_STYLE, { MOBILE_APP_COMPONENT: COMPONENT, MOBILE_APP_USER: "0" });
        expect(run.status, run.error).toBe("passed");
        const cmds = appium.log.map((l) => l.cmd);
        expect(cmds).not.toContain("mobile: activateApp");
        expect(appium.log.find((l) => l.cmd === "mobile: startActivity")?.body).toMatchObject({ component: COMPONENT, action: "android.intent.action.MAIN", categories: "android.intent.category.LAUNCHER", stop: true, wait: true, user: "0" });
        // The session opens exactly the resolved screen, waits for any screen of the app, restarts it, and does not wait for idle.
        expect(appium.sessions[0]).toMatchObject({ "appium:appPackage": PKG, "appium:appActivity": ".MainActivity", "appium:appWaitActivity": "*", "appium:forceAppLaunch": true, "appium:noReset": true, "appium:disableWindowAnimation": true, "appium:ignoreUnimportantViews": false, "appium:settings": { waitForIdleTimeout: 100 } });
        expect(appium.sessions[0]["appium:udid"]).toBeUndefined();
        expect(appium.sessions[0]["appium:avd"]).toBeUndefined();
    }, 240_000);

    it("without the resolved screen the same script meets the owner's error: that is what the start fixes", async () => {
        appium.reset({ activateFails: true });
        const run = await runReal(OLD_STYLE, {});
        expect(run.status).not.toBe("passed");
        expect(`${run.error}\n${run.steps.map((s) => s.error).join("\n")}`).toMatch(/Unable to resolve the launchable activity/);
        expect(appium.sessions[0]["appium:appActivity"]).toBeUndefined();
    }, 240_000);
});

describe("a generated phone test", () => {
    const spec = TestSpecSchema.parse({
        testId: "MOB-001",
        title: "Terms open and the shop comes back",
        kind: "mobile",
        steps: [
            { action: "assert", check: "visible", locator: { by: "testId", value: "toolbar_title" } },
            { action: "click", locator: { by: "testId", value: "terms_link" } },
            { action: "assert", check: "visible", locator: { by: "testId", value: "toolbar_title" } },
        ],
        source: { origin: "imported" },
    });

    it("starts the resolved screen, answers a permission question the test did not, and brings the app back once", async () => {
        appium.reset({ permissionPending: true, activateFails: true });
        const script = renderWithAdapter(spec, "taqwright", { baseUrl: `android-app://${PKG}` }).content;
        const run = await runReal(script, { MOBILE_APP_COMPONENT: COMPONENT, MOBILE_APP_USER: "0" });
        expect(run.status, `${run.error}\n${run.steps.map((s) => s.error).join("\n")}`).toBe("passed");
        const cmds = appium.log.map((l) => l.cmd);
        expect(cmds).not.toContain("mobile: activateApp");
        // The question was answered with the project's answer (allow).
        expect(appium.log.filter((l) => l.cmd === "click").map((l) => l.body)).toContain("com.android.permissioncontroller:id/permission_allow_button");
        // Two starts: the test's own (stop and wait) and the bring-back after the browser came to the front (no stop).
        const starts = appium.log.filter((l) => l.cmd === "mobile: startActivity").map((l) => l.body);
        expect(starts[0]).toMatchObject({ component: COMPONENT, stop: true });
        expect(starts.slice(1)).toEqual([{ component: COMPONENT, flags: "0x10200000", wait: true }]);
    }, 240_000);

    it("\"isn't responding\": waits once; when it comes back the test fails saying so (the freeze itself is reported from the phone's log)", async () => {
        appium.reset({ anrShows: 2 });
        const script = renderWithAdapter({ ...spec, steps: spec.steps.slice(0, 1) }, "taqwright", { baseUrl: `android-app://${PKG}` }).content;
        const run = await runReal(script, { MOBILE_APP_COMPONENT: COMPONENT, MOBILE_APP_USER: "0" });
        expect(run.status).toBe("failed");
        expect(`${run.error}`).toMatch(/The app stopped responding: Android showed that it isn't responding, the test waited once, and it happened again\./);
        expect(appium.log.filter((l) => l.cmd === "click").map((l) => l.body)).toEqual(["android:id/aerr_wait", "android:id/aerr_close"]);
    }, 240_000);
});
