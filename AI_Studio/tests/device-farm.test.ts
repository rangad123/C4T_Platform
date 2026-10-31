/**
 * Device farms against a local fake farm (tests/fixtures/fake-appium.ts: a W3C WebDriver server serving the mock shop app, plus fake provider REST
 * endpoints). Never a real farm. Covers: running rendered phone scripts on each provider (upload, capabilities, steps, results, evidence, status
 * reporting, links), several at once and every test on several phones, failures that are never passes, the farm device session the AI explorer uses,
 * and the platform end to end (connections with write-only credentials, the run choice, a real job, the session log, no secret anywhere).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runFarmScripts, type FarmRunEnv } from "../src/engine/mobile/cloud/farm-runner.js";
import { openFarmDeviceSession } from "../src/engine/mobile/cloud/farm-session.js";
import type { FarmConnection, FarmRunPlan } from "../src/engine/mobile/cloud/types.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { farmTestHooks } from "../src/platform/device-farm-run.js";
import { startFakeFarm, type FakeFarm } from "./fixtures/fake-appium.js";

const PORT = 6771;
const USER = "maya_ab12";
const KEY = "FARMKEY-SENTINEL-9d41c7";
const PASSWORD = "Fake-Pass-1234";

const spec = (testId: string, title: string, steps: unknown[]) => TestSpecSchema.parse({ testId, title, kind: "mobile", category: "Mobile", steps });
const script = (s: ReturnType<typeof spec>) => ({ testId: s.testId, filename: `${s.testId}.mobile.spec.ts`, content: renderScript(s, "taqwright", { baseUrl: "android-app://com.example.shop" }).content });

const signIn = spec("MOB-001", "Signing in shows the welcome", [
    { action: "click", locator: { by: "text", value: "Sign in" } },
    { action: "fill", locator: { by: "testId", value: "username_field" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "testId", value: "password_field" }, value: "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
    { action: "assert", check: "text", locator: { by: "testId", value: "welcome" }, expected: "Hello, tester" },
]);
const products = spec("MOB-002", "A product opens from the list", [
    { action: "click", locator: { by: "text", value: "Products" } },
    { action: "press", key: "device:scroll:down" },
    { action: "click", locator: { by: "text", value: "Product 6" } },
    { action: "assert", check: "visible", locator: { by: "testId", value: "add_to_cart_button" } },
    { action: "press", key: "device:back" },
    { action: "assert", check: "visible", locator: { by: "text", value: "Products" } },
]);
const failing = spec("MOB-003", "A missing banner shows", [
    { action: "assert", check: "visible", locator: { by: "label", value: "Cart, 0 items" } },
    { action: "assert", check: "visible", locator: { by: "text", value: "Summer sale" } },
]);

let farm: FakeFarm;
let tmp: string;
let apk: string;
const prevBase = process.env.AITP_FARM_BASE;

beforeAll(async () => {
    farm = await startFakeFarm({ port: PORT, user: USER, key: KEY, busyDevice: "Busy Phone" });
    process.env.AITP_FARM_BASE = farm.url;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-farm-"));
    apk = path.join(tmp, "shop.apk");
    fs.writeFileSync(apk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40), Buffer.from("AndroidManifest.xml"), Buffer.alloc(200)]));
});
afterAll(async () => {
    await farm?.close();
    if (prevBase === undefined) delete process.env.AITP_FARM_BASE;
    else process.env.AITP_FARM_BASE = prevBase;
    fs.rmSync(tmp, { recursive: true, force: true });
});

const conn = (o: Partial<FarmConnection> = {}): FarmConnection => ({ id: "c1", provider: "browserstack", label: "Team", devices: [{ name: "Google Pixel 8", osVersion: "14" }], username: USER, accessKey: KEY, ...o });
const env = (plan: Partial<FarmRunPlan> & { connection: FarmConnection }, extra: Partial<FarmRunEnv> = {}): FarmRunEnv => ({ plan: { parallel: 1, matrix: false, ...plan }, target: { appPackage: "com.example.shop", apkPath: apk }, credentials: { username: "tester", password: PASSWORD }, expectTimeoutMs: 1500, ...extra });

describe("running phone tests on a farm", () => {
    it("uploads the app once, runs each test in its own session, keeps evidence and reports the verdicts", async () => {
        const sessions: unknown[] = [];
        const before = farm.log.length;
        const runs = await runFarmScripts(path.join(tmp, "scratch"), [script(signIn), script(products), script(failing)], env({ connection: conn(), parallel: 2 }, { onSession: (s) => sessions.push(s) }));

        expect(runs.map((r) => r.status)).toEqual(["passed", "passed", "failed"]);
        expect(runs[0]!.steps.every((s) => s.status === "passed")).toBe(true);
        expect(runs[0]!.notes?.[0]).toMatch(/^Ran on BrowserStack App Automate, Google Pixel 8 \(Android 14\)\. Video and logs: http:\/\/127\.0\.0\.1:6771\/browserstack\/web\/dashboard\/v2\/sessions\//);
        const bad = runs[2]!;
        expect(bad.failedStepIndex).toBe(1);
        expect(bad.error).toMatch(/^Expected the text “Summer sale” to be visible, but it was not found \(waited 2 s\)\nRan on BrowserStack App Automate/);
        expect(bad.artifacts.map((a) => a.kind)).toEqual(["screenshot"]);
        expect(fs.readFileSync(bad.artifacts[0]!.path).subarray(1, 4).toString()).toBe("PNG");

        // one upload, with the account in the Authorization header only
        expect(farm.uploads.filter((u) => u.provider === "browserstack")).toHaveLength(1);
        const mine = farm.log.slice(before);
        expect(mine.every((r) => r.auth === `Basic ${Buffer.from(`${USER}:${KEY}`).toString("base64")}`)).toBe(true);
        expect(mine.some((r) => r.path.includes(KEY) || r.body.includes(KEY))).toBe(false);
        const created = mine.filter((r) => r.method === "POST" && r.path.endsWith("/hub/session")).map((r) => JSON.parse(r.body).capabilities.alwaysMatch);
        expect(created).toHaveLength(3);
        expect(created[0]).toMatchObject({ platformName: "Android", "appium:app": "bs://fakeapp123", "bstack:options": { deviceName: "Google Pixel 8", osVersion: "14" } });
        // two at once, then every session closed and reported
        expect(farm.maxConcurrent).toBe(2);
        expect([...farm.sessions.values()].every((s) => s.deleted)).toBe(true);
        expect(farm.statuses.filter((s) => s.provider === "browserstack").map((s) => (s.body as { status: string }).status).sort()).toEqual(["failed", "passed", "passed"]);
        expect(sessions).toHaveLength(3);

        // the password was typed on the farm's phone, and is in nothing the platform keeps
        expect(farm.typed).toContain(PASSWORD);
        expect(JSON.stringify(runs)).not.toContain(PASSWORD);
        expect(JSON.stringify(sessions)).not.toContain(KEY);
    }, 60_000);

    it("runs every test on every picked phone and says how it went on each", async () => {
        const runs = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], env({ connection: conn({ devices: [{ name: "Google Pixel 8", osVersion: "14" }, { name: "Samsung Galaxy S23", osVersion: "13" }] }), parallel: 2, matrix: true }));
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("passed");
        expect(runs[0]!.notes?.[0]).toBe("Passed on 2 phones. Google Pixel 8 (Android 14): passed; Samsung Galaxy S23 (Android 13): passed.");

        const mixed = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], env({ connection: conn({ devices: [{ name: "Google Pixel 8" }, { name: "Busy Phone" }] }), matrix: true }));
        expect(mixed[0]!.status).toBe("error");
        expect(mixed[0]!.error).toMatch(/^On Busy Phone: Not run on Busy Phone \(BrowserStack App Automate\): The device farm could not start a phone session: No device free/);
        expect(mixed[0]!.error).toMatch(/All phones: Google Pixel 8: passed; Busy Phone: could not run\./);
    }, 60_000);

    it("never reports a pass when the farm cannot run the test", async () => {
        const wrongKey = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], env({ connection: conn({ accessKey: "wrong-key-123" }) }));
        expect(wrongKey[0]!.status).toBe("error");
        expect(wrongKey[0]!.error).toMatch(/refused the sign-in details/);
        expect(wrongKey[0]!.error).not.toContain(USER);

        const noApk = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], { ...env({ connection: conn() }), target: { appPackage: "com.example.shop" } });
        expect(noApk[0]).toMatchObject({ status: "error", error: expect.stringMatching(/Upload the app's \.apk under Mobile app/) });

        const code = await runFarmScripts(path.join(tmp, "scratch"), [{ ...script(products), custom: true }], env({ connection: conn() }));
        expect(code[0]!.error).toMatch(/Code tests run only on a phone of this computer or a runner/);

        const noKey = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], env({ connection: conn({ accessKey: undefined }) }));
        expect(noKey[0]!.error).toMatch(/needs a user name and an access key/);
    }, 60_000);

    it("speaks each provider's dialect: Sauce Labs, LambdaTest and any Appium server", async () => {
        const sauce = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], env({ connection: conn({ provider: "saucelabs", region: "eu-central-1" }) }));
        expect(sauce[0]!.status).toBe("passed");
        const lt = await runFarmScripts(path.join(tmp, "scratch"), [script(products)], env({ connection: conn({ provider: "lambdatest" }) }));
        expect(lt[0]!.status).toBe("passed");
        const caps = farm.log.filter((r) => r.method === "POST" && /\/(saucelabs|lambdatest)\/hub\/session$/.test(r.path)).map((r) => JSON.parse(r.body).capabilities.alwaysMatch);
        expect(caps[0]).toMatchObject({ "appium:app": "storage:sauce-app-1", "appium:deviceName": "Google Pixel 8" });
        expect(caps[1]).toMatchObject({ "lt:options": { app: "lt://APP1001", deviceName: "Google Pixel 8", isRealMobile: true } });
        expect(farm.statuses.some((s) => s.provider === "saucelabs" && (s.body as { passed: boolean }).passed === true)).toBe(true);
        expect(farm.statuses.some((s) => s.provider === "lambdatest" && (s.body as { status_ind: string }).status_ind === "passed")).toBe(true);

        // Any Appium server: no upload (the app is already installed), no account needed, no links
        const uploads = farm.uploads.length;
        const appium = await runFarmScripts(path.join(tmp, "scratch"), [script(signIn)], env({ connection: conn({ provider: "appium", hubUrl: `${farm.url}/appium/wd/hub`, username: undefined, accessKey: undefined }) }));
        expect(appium[0]!.status).toBe("passed");
        expect(appium[0]!.notes?.[0]).toBe("Ran on Any Appium server, Google Pixel 8 (Android 14).");
        expect(farm.uploads.length).toBe(uploads);
    }, 60_000);
});

describe("the AI explorer's phone on a farm", () => {
    it("reads the screen, acts by element number only, types the password there and never returns it", async () => {
        const plan: FarmRunPlan = { connection: conn({ provider: "appium", hubUrl: `${farm.url}/appium/wd/hub`, username: undefined, accessKey: undefined }), parallel: 1, matrix: false };
        const s = await openFarmDeviceSession({ appPackage: "com.example.shop", credentials: { username: "tester", password: PASSWORD } }, plan);
        expect(s.deviceName).toBe("Google Pixel 8 (Android 14) on Any Appium server");
        const home = await s.snapshot({ screenshot: true });
        expect(home.package).toBe("com.example.shop");
        expect(home.screenshot?.length).toBeGreaterThan(100);
        const signInBtn = home.elements.find((e) => e.text === "Sign in")!;
        const r1 = await s.act({ kind: "tap", index: signInBtn.index });
        expect(r1.ok).toBe(true);
        const form = r1.snapshot!;
        const user = form.elements.find((e) => e.id === "username_field")!;
        const pass = form.elements.find((e) => e.id === "password_field")!;
        expect(pass.password).toBe(true);
        expect((await s.act({ kind: "type", index: pass.index, text: "guess" })).error).toMatch(/password field/);
        expect((await s.act({ kind: "tap", index: 999 })).ok).toBe(false);
        expect((await s.act({ kind: "tap", index: 0, x: 5, y: 5 } as never)).error).toMatch(/can only name an element/);
        await s.act({ kind: "type", index: user.index, text: "{{credentials.username}}" });
        const typed = await s.act({ kind: "type", index: pass.index, text: "{{credentials.password}}" });
        expect(typed.ok).toBe(true);
        const login = typed.snapshot!.elements.find((e) => e.text === "Log in")!;
        const after = await s.act({ kind: "tap", index: login.index });
        expect(after.snapshot!.elements.some((e) => e.text === "Hello, tester")).toBe(true);
        expect(JSON.stringify([home, form, typed, after])).not.toContain(PASSWORD);
        expect(farm.typed).toContain(PASSWORD);
        const id = [...farm.sessions.values()].at(-1)!;
        await s.close();
        expect(id.deleted).toBe(true);
    }, 60_000);
});

describe("platform", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dataDir: string;
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
        // This computer has no Android tools in this test: phone tests can only run because of the farm.
        for (const [k, v] of Object.entries({ TAQWRIGHT_HOME: path.join(tmp, "none"), ANDROID_AVD_HOME: path.join(tmp, "none-avd"), ANDROID_HOME: "", ANDROID_SDK_ROOT: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_API_KEY: "" })) {
            saved[k] = process.env[k];
            process.env[k] = v;
        }
        farmTestHooks.expectTimeoutMs = 1500;
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-farmplat-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        delete farmTestHooks.expectTimeoutMs;
        fs.rmSync(dataDir, { recursive: true, force: true });
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.body };
    };
    async function waitForJob(jobId: string) {
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("job did not finish");
    }

    it("connects a farm with write-only credentials, runs the project's phone tests there and keeps the links", async () => {
        const project = (await call("POST", "/api/projects", { name: "Farm" })).body.id as string;
        // a phone-only project; the tests are imported first and run later, on the farm
        expect((await call("POST", `/api/projects/${project}/specs`, { specs: [{ ...products, testId: undefined }, { ...failing, testId: undefined }], validate: false, mobile: { appPackage: "com.example.shop" } })).status).toBe(202);
        expect((await call("PUT", `/api/projects/${project}/mobile-app`, { appPackage: "com.example.shop" })).status).toBe(200);
        const up = await server.inject({ method: "POST", url: `/api/projects/${project}/mobile-app/apk?filename=shop.apk`, headers: { "content-type": "application/vnd.android.package-archive" }, payload: fs.readFileSync(apk) });
        expect(up.statusCode).toBe(200);

        // input is checked and bounded
        expect((await call("POST", `/api/projects/${project}/device-farms`, { provider: "browserstack", label: "x", devices: [] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${project}/device-farms`, { provider: "browserstack", label: "x", devices: [{ name: "Pixel" }], username: USER, accessKey: KEY, extra: 1 })).status).toBe(400);
        expect((await call("POST", `/api/projects/${project}/device-farms`, { provider: "browserstack", label: "x", devices: [{ name: "Pixel" }], username: USER, accessKey: KEY, hubUrl: "https://evil.example.com" })).status).toBe(400);
        const httpCreds = await call("POST", `/api/projects/${project}/device-farms`, { provider: "appium", label: "Lab", hubUrl: "http://10.1.2.3:4723/wd/hub", devices: [{ name: "Pixel" }], username: "u", accessKey: "k" });
        expect(httpCreds.status).toBe(400);
        expect(httpCreds.body.error).toMatch(/only sent over https/);

        const made = await call("POST", `/api/projects/${project}/device-farms`, { provider: "browserstack", label: "Team BrowserStack", devices: [{ name: "Google Pixel 8", osVersion: "14" }], username: USER, accessKey: KEY });
        expect(made.status).toBe(201);
        expect(made.body).toMatchObject({ provider: "browserstack", credentialsSet: true });
        const listed = await call("GET", `/api/projects/${project}/device-farms`);
        expect(listed.body.farms).toHaveLength(1);
        expect(listed.body.choice).toEqual({ runOn: "device", farmId: null, parallel: 1, matrix: false });
        expect(listed.body.providers.map((p: { id: string }) => p.id)).toEqual(["browserstack", "saucelabs", "lambdatest", "appium"]);
        expect(listed.raw).not.toContain(KEY);
        expect(listed.raw).not.toContain(USER);
        expect((await call("POST", `/api/projects/${project}/device-farms/${made.body.id}/check`)).body).toEqual({ ok: true, message: "Connected to BrowserStack App Automate. The sign-in details work." });

        // another project can't see or use it
        const other = (await call("POST", "/api/projects", { name: "Other" })).body.id as string;
        expect((await call("PUT", `/api/projects/${other}/device-farm-choice`, { runOn: "farm", farmId: made.body.id })).status).toBe(404);
        expect((await call("POST", `/api/projects/${other}/device-farms/${made.body.id}/check`)).status).toBe(404);

        expect((await call("PUT", `/api/projects/${project}/device-farm-choice`, { runOn: "farm", farmId: made.body.id, parallel: 2 })).body).toEqual({ runOn: "farm", farmId: made.body.id, parallel: 2, matrix: false });

        // no Android tools here: the tests run on the farm
        const imported = await call("POST", `/api/projects/${project}/runs`, {});
        expect(imported.status).toBe(202);
        const job = await waitForJob(imported.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        const tests = (await call("GET", `/api/projects/${project}/tests`)).body as Array<{ id: string; title: string; validationStatus: string; validationReason: string | null }>;
        const byTitle = Object.fromEntries(tests.map((t) => [t.title, t]));
        expect(byTitle["A product opens from the list"]!.validationStatus, String(byTitle["A product opens from the list"]!.validationReason)).toBe("VALIDATED");
        expect(byTitle["A missing banner shows"]!.validationStatus).toBe("FAILED_VALIDATION");
        expect(byTitle["A missing banner shows"]!.validationReason).toMatch(/Summer sale/);

        const events = await call("GET", `/api/test-generation/${imported.body.jobId}/events`);
        expect(events.raw).toMatch(/Phone tests run on BrowserStack App Automate \(“Team BrowserStack”\): Google Pixel 8 \(Android 14\), 2 at a time\./);

        const detail = await call("GET", `/api/tests/${byTitle["A missing banner shows"]!.id}`);
        expect(detail.body.executions[0].artifacts.map((a: { kind: string }) => a.kind)).toEqual(["screenshot"]);

        const sessions = (await call("GET", `/api/projects/${project}/device-farms/sessions`)).body.sessions as Array<{ status: string; link: string; device: string }>;
        expect(sessions.map((s) => s.status).sort()).toEqual(["failed", "passed"]);
        expect(sessions[0]!.link).toMatch(/\/browserstack\/web\/dashboard\/v2\/sessions\//);

        // a single test re-run is allowed even though this computer has no phone
        const again = await call("POST", `/api/tests/${byTitle["A product opens from the list"]!.id}/validate`);
        expect(again.status).toBe(202);
        expect((await waitForJob(again.body.jobId)).status).toBe("COMPLETED");

        // nothing the platform shows or stores has the access key in readable form
        for (const url of [`/api/projects/${project}`, `/api/projects/${project}/tests`, `/api/test-generation/${imported.body.jobId}/events`, `/api/tests/${byTitle["A missing banner shows"]!.id}`, `/api/projects/${project}/device-farms/sessions`]) expect((await call("GET", url)).raw).not.toContain(KEY);
        const rows = JSON.stringify(platform.db.all("SELECT * FROM device_farms"));
        expect(rows).not.toContain(KEY);
        expect(rows).not.toContain(USER);

        // removing the farm sends phone tests back where they ran before
        expect((await call("DELETE", `/api/projects/${project}/device-farms/${made.body.id}`)).status).toBe(204);
        expect((await call("GET", `/api/projects/${project}/device-farms`)).body.choice.runOn).toBe("device");
    }, 120_000);
});
