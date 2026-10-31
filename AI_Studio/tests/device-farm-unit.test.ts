/**
 * Device farms, the parts that need no network: reading rendered phone scripts back into steps, the provider table (addresses, capabilities, links,
 * the rules that keep credentials on the provider's own servers), page-source conversion, sharing tests out among phones, the executor wrapper's
 * "defaults change nothing", and the store (credentials encrypted and write-only, the choice, the session log). Fast tier.
 */
import { describe, expect, it } from "vitest";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { evaluate, evaluateData, readFarmScript, readLine, ScriptReadError } from "../src/engine/mobile/cloud/script-reader.js";
import { authHeader, capabilitiesFor, connectionProblem, endpointsFor, scrubSecrets, sessionLink, statusRequest } from "../src/engine/mobile/cloud/providers.js";
import { xpathLiteral } from "../src/engine/mobile/cloud/farm-runner.js";
import { appiumSourceToDump } from "../src/engine/mobile/cloud/farm-session.js";
import { shareOut } from "../src/engine/mobile/cloud/local-parallel.js";
import { withDeviceChoice } from "../src/engine/mobile/cloud/farm-executor.js";
import { parseHierarchy } from "../src/engine/mobile/device/uiautomator.js";
import type { FarmConnection } from "../src/engine/mobile/cloud/types.js";
import type { ScriptExecutor } from "../src/engine/frameworks/types.js";
import { Db } from "../src/platform/db.js";
import { SecretBox } from "../src/platform/secrets.js";
import { Repo } from "../src/platform/repo.js";
import { DeviceFarmStore, farmChosen, SESSIONS_KEPT } from "../src/platform/device-farm-store.js";

const render = (steps: unknown[], extra: Record<string, unknown> = {}) =>
    renderScript(TestSpecSchema.parse({ testId: "MOB-001", title: "Signing in works", kind: "mobile", category: "Mobile", steps, ...extra }), "taqwright", { baseUrl: "android-app://com.example.shop" }).content;

const KEY = "farm-key-SENTINEL-7f3a9c";
const bs: FarmConnection = { id: "c1", provider: "browserstack", label: "BS", devices: [{ name: "Google Pixel 8", osVersion: "14" }], username: "maya_ab12", accessKey: KEY };

describe("reading a rendered phone script", () => {
    it("reads every step the generator writes, with placeholders kept as placeholders", () => {
        const script = render(
            [
                { action: "click", locator: { by: "text", value: "Sign in" } },
                { action: "fill", locator: { by: "testId", value: "username_field" }, value: "{{credentials.username}}" },
                { action: "fill", locator: { by: "placeholder", value: "Password" }, value: "{{credentials.password}}" },
                { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
                { action: "assert", check: "text", locator: { by: "testId", value: "welcome" }, expected: "Hello, {{who}}" },
                { action: "assert", check: "visible", locator: { by: "label", value: "Cart, 0 items" } },
                { action: "press", key: "device:back" },
                { action: "press", key: "device:scroll:down" },
                { action: "press", key: "device:swipe:left" },
                { action: "press", key: "Enter" },
                { action: "wait", ms: 500 },
                { action: "hover", locator: { by: "text", value: "x" } },
                { action: "assert", check: "count", locator: { by: "role", role: "button" }, expected: 3 },
            ],
            { testData: { who: "tester" } },
        );
        const r = readFarmScript(script);
        expect(r.title).toBe("MOB-001: Signing in works");
        expect(r.steps.map((s) => s.op.op)).toEqual(["click", "fill", "fill", "click", "expectText", "expect", "back", "scroll", "scroll", "key", "wait", "noop", "expectCount"]);
        const vars = { TEST_USERNAME: "tester", TEST_PASSWORD: "Fake-Pass-1234" };
        const data = evaluateData(r, vars, "123");
        const fill = r.steps[2]!.op as Extract<(typeof r.steps)[number]["op"], { op: "fill" }>;
        expect(fill.loc).toMatchObject({ by: "placeholder" });
        expect(evaluate(fill.text, { vars, data, unique: "123" })).toBe("Fake-Pass-1234");
        const text = r.steps[4]!.op as Extract<(typeof r.steps)[number]["op"], { op: "expectText" }>;
        expect(evaluate(text.expected, { vars, data, unique: "123" })).toBe("Hello, tester");
        expect(r.steps[8]!.op).toEqual({ op: "scroll", direction: "left", swipe: true });
        // the password is a placeholder in the script, never a value
        expect(script).not.toContain("Fake-Pass-1234");
    });

    it("refuses anything that is not the platform's own output, in words", () => {
        const ok = render([{ action: "click", locator: { by: "text", value: "Sign in" } }]);
        expect(() => readFarmScript(ok.replace("await mobile.getByText", "await require('child_process').exec('x'); await mobile.getByText"))).toThrow(ScriptReadError);
        expect(() => readFarmScript(ok.replace("Generated by AI Testing Platform", "Written by hand"))).toThrow(/changed by hand or is a code test/);
        expect(() => readFarmScript(ok.replace("});\n", "});\nconsole.log(1);\n"))).toThrow(ScriptReadError);
        expect(() => readLine("await mobile.getByText(`${process.exit(1)}`).click();")).toThrow(ScriptReadError);
        expect(() => readLine("await mobile.getByText(`${data.x}`).click();")).toThrow(ScriptReadError);
        expect(() => readFarmScript(render([{ action: "click", locator: { by: "css", value: ".x" } }]))).toThrow(/CSS selector/);
        expect(() => readFarmScript(render([{ action: "fill", locator: { by: "text", value: "Code" }, value: "{{credentials.totp}}" }]))).toThrow(/one-time sign-in code/);
    });
});

describe("providers", () => {
    it("have fixed addresses per provider, so an account only reaches its own provider", () => {
        const prev = process.env.AITP_FARM_BASE;
        delete process.env.AITP_FARM_BASE;
        try {
            expect(endpointsFor(bs).hub).toBe("https://hub-cloud.browserstack.com/wd/hub");
            expect(endpointsFor({ provider: "saucelabs", region: "eu-central-1" }).hub).toBe("https://ondemand.eu-central-1.saucelabs.com/wd/hub");
            expect(endpointsFor({ provider: "lambdatest" }).hub).toBe("https://mobile-hub.lambdatest.com/wd/hub");
            expect(endpointsFor({ provider: "appium", hubUrl: "https://appium.example.com/wd/hub/" }).hub).toBe("https://appium.example.com/wd/hub");
        } finally {
            if (prev !== undefined) process.env.AITP_FARM_BASE = prev;
        }
    });

    it("ask for sessions in each provider's own dialect", () => {
        const dev = { name: "Google Pixel 8", osVersion: "14" };
        expect(capabilitiesFor(bs, dev, { appRef: "bs://x", name: "t", build: "b" })).toMatchObject({ platformName: "Android", "appium:app": "bs://x", "bstack:options": { deviceName: "Google Pixel 8", osVersion: "14" } });
        expect(capabilitiesFor({ ...bs, provider: "saucelabs" }, dev, { appRef: "storage:1", name: "t", build: "b" })).toMatchObject({ "appium:deviceName": "Google Pixel 8", "appium:platformVersion": "14", "appium:app": "storage:1" });
        expect(capabilitiesFor({ ...bs, provider: "lambdatest" }, dev, { appRef: "lt://1", name: "t", build: "b" })).toMatchObject({ "lt:options": { deviceName: "Google Pixel 8", platformVersion: "14", app: "lt://1", isRealMobile: true } });
        expect(capabilitiesFor({ ...bs, provider: "appium" }, dev, { appPackage: "com.example.shop", name: "t", build: "b" })).toMatchObject({ "appium:appPackage": "com.example.shop" });
        // no capability carries the account
        for (const p of ["browserstack", "saucelabs", "lambdatest", "appium"] as const) expect(JSON.stringify(capabilitiesFor({ ...bs, provider: p }, dev, { name: "t", build: "b" }))).not.toContain(KEY);
    });

    it("report results and link sessions without credentials", () => {
        const ep = endpointsFor(bs);
        expect(statusRequest(bs, ep, "abc123", false, "Element not found")).toMatchObject({ method: "PUT", url: "https://api-cloud.browserstack.com/app-automate/sessions/abc123.json" });
        expect(sessionLink(bs, ep, "abc123")).toBe("https://app-automate.browserstack.com/dashboard/v2/sessions/abc123");
        expect(sessionLink(bs, ep, "../../evil")).toBeUndefined();
        expect(sessionLink({ ...bs, provider: "appium", hubUrl: "https://a.example.com" }, ep, "abc")).toBeUndefined();
        expect(authHeader(bs)).toBe(`Basic ${Buffer.from(`maya_ab12:${KEY}`).toString("base64")}`);
        expect(scrubSecrets(`refused ${KEY} for maya_ab12 (${authHeader(bs)!.slice(6)})`, bs)).not.toMatch(/SENTINEL|maya_ab12|bWF5/);
    });

    it("say plainly what is missing, and never send credentials over plain http", () => {
        expect(connectionProblem({ ...bs, accessKey: undefined })).toMatch(/user name and an access key/);
        expect(connectionProblem({ ...bs, devices: [] })).toMatch(/at least one phone/);
        const appium: FarmConnection = { id: "a", provider: "appium", label: "Lab", devices: [{ name: "Pixel" }], hubUrl: "http://10.0.0.5:4723/wd/hub" };
        expect(connectionProblem(appium)).toBeUndefined();
        expect(connectionProblem({ ...appium, username: "u", accessKey: "k" })).toMatch(/only sent over https/);
        expect(connectionProblem({ ...appium, hubUrl: "http://127.0.0.1:4723", username: "u", accessKey: "k" })).toBeUndefined();
        expect(connectionProblem({ ...appium, hubUrl: "https://u:p@appium.example.com" })).toMatch(/own fields/);
        expect(connectionProblem({ ...appium, hubUrl: "file:///etc/passwd" })).toMatch(/http/);
        expect(connectionProblem({ ...appium, hubUrl: "not a url" })).toMatch(/address/);
    });

    it("write XPath literals as Taqwright does", () => {
        expect(xpathLiteral("Sign in")).toBe("'Sign in'");
        expect(xpathLiteral("Don't")).toBe(`"Don't"`);
        expect(xpathLiteral(`a'b"c`)).toBe(`concat('a', "'", 'b"c')`);
    });
});

describe("Appium page source", () => {
    it("is read by the same screen parser as uiautomator dump", () => {
        const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy index="0" class="hierarchy" rotation="0" width="360" height="640"><android.widget.FrameLayout index="0" package="com.example.shop" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" long-clickable="false" password="false" scrollable="false" selected="false" bounds="[0,0][360,640]"><android.widget.Button index="1" package="com.example.shop" class="android.widget.Button" text="Sign in &lt;now&gt;" resource-id="com.example.shop:id/signin_button" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" long-clickable="false" password="false" scrollable="false" selected="false" bounds="[16,136][344,184]" /></android.widget.FrameLayout></hierarchy>`;
        const dump = appiumSourceToDump(xml);
        expect(dump).toContain("<node ");
        expect(dump).toContain("</node></hierarchy>");
        const p = parseHierarchy(dump, { appPackage: "com.example.shop" });
        expect(p.ok).toBe(true);
        if (p.ok) expect(p.snapshot.elements.find((e) => e.id === "signin_button")?.text).toBe("Sign in <now>");
    });
});

describe("sharing tests out among phones", () => {
    it("keeps every test once, in a group per phone, with its place", () => {
        const g = shareOut(["a", "b", "c", "d", "e"], 2);
        expect(g.map((x) => x.map((y) => y.item))).toEqual([["a", "c", "e"], ["b", "d"]]);
        expect(shareOut(["a"], 4)).toHaveLength(1);
    });

    it("changes nothing with the defaults", () => {
        const inner: ScriptExecutor = { name: "local", execute: async () => [] };
        expect(withDeviceChoice(inner, {})).toBe(inner);
        expect(withDeviceChoice(inner, { localParallel: 1 })).toBe(inner);
        expect(withDeviceChoice(inner, { localParallel: 3 })).not.toBe(inner);
    });
});

describe("the store", () => {
    it("keeps credentials encrypted and write-only, and the project's choice", () => {
        const db = new Db(":memory:");
        const box = new SecretBox("", "a-test-secret-key-of-enough-length");
        const projectId = String(new Repo(db, box).createProject({ name: "P" }).id);
        const s = new DeviceFarmStore(db, box);
        const f = s.create(projectId, { provider: "browserstack", label: "Team BS", devices: bs.devices, username: "maya_ab12", accessKey: KEY });
        expect(f).toMatchObject({ provider: "browserstack", label: "Team BS", credentialsSet: true });
        expect(JSON.stringify(s.list(projectId))).not.toContain(KEY);
        expect(JSON.stringify(s.list(projectId))).not.toContain("maya_ab12");
        expect(JSON.stringify(db.all("SELECT * FROM device_farms"))).not.toContain(KEY);
        expect(s.connection(projectId, f.id)?.accessKey).toBe(KEY);

        // an update without credentials keeps them; an empty one removes it
        s.update(projectId, f.id, { label: "Renamed" });
        expect(s.connection(projectId, f.id)?.accessKey).toBe(KEY);
        s.update(projectId, f.id, { accessKey: "" });
        expect(s.connection(projectId, f.id)?.accessKey).toBeUndefined();
        s.update(projectId, f.id, { accessKey: KEY });

        expect(s.choice(projectId)).toEqual({ runOn: "device", farmId: null, parallel: 1, matrix: false });
        expect(farmChosen(db, projectId)).toBe(false);
        s.setChoice(projectId, { runOn: "farm", farmId: f.id, parallel: 3, matrix: true });
        expect(farmChosen(db, projectId)).toBe(true);
        expect(s.plan(projectId)).toMatchObject({ parallel: 3, matrix: true, connection: { provider: "browserstack", accessKey: KEY } });

        for (let i = 0; i < SESSIONS_KEPT + 5; i++) s.addSession(projectId, "j1", f.id, { testId: `MOB-${i}`, provider: "browserstack", device: "Pixel", sessionId: `s${i}`, status: "passed", link: `https://x/${i}` });
        expect(s.sessions(projectId, { limit: 200 })).toHaveLength(200);
        expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM device_farm_sessions")!.n).toBe(SESSIONS_KEPT);

        // removing the farm sends the phone tests back where they ran before
        s.delete(projectId, f.id);
        expect(s.choice(projectId).runOn).toBe("device");
        expect(farmChosen(db, projectId)).toBe(false);
        db.close();
    });
});
