/**
 * Mobile (Taqwright) plumbing, without an emulator: a stand-in for the Taqwright CLI writes a real
 * Playwright-format report, so toolchain detection, the runner's config and environment, report
 * parsing, artifacts, and the platform API/persistence are all exercised for real. Running tests on an
 * actual emulator is covered by tests/mobile-device.test.ts (opt-in: MOBILE_E2E=1).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { mobileAvailability } from "../src/engine/mobile/toolchain.js";
import { MobileTargetSchema } from "../src/engine/mobile/target.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runMobileScripts } from "../src/engine/validation/mobile-runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const OBSERVED = path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json");
const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

const passing = { title: "Network settings are listed", kind: "mobile", category: "Mobile · Settings", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Network & internet" } }, { action: "click", locator: { by: "text", value: "Network & internet" } }] };
const failing = { title: "A missing item is shown [fail]", kind: "mobile", category: "Mobile · Settings", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Nothing like this [fail]" } }] };

/** A pretend Android toolchain + emulator, so availability checks can say "yes" on any machine. */
function fakeToolchain(root: string, withAvd = true) {
    fs.mkdirSync(path.join(root, "sdk/platform-tools"), { recursive: true });
    fs.mkdirSync(path.join(root, "jdk/bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "sdk/platform-tools", exe("adb")), "");
    fs.writeFileSync(path.join(root, "jdk/bin", exe("java")), "");
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    fs.writeFileSync(path.join(root, "home/manifest.json"), JSON.stringify({ androidHome: path.join(root, "sdk"), javaHome: path.join(root, "jdk") }));
    fs.mkdirSync(path.join(root, "avd"), { recursive: true });
    if (withAvd) fs.writeFileSync(path.join(root, "avd/Pixel_Test.ini"), "target=android-34\n");
    return { TAQWRIGHT_HOME: path.join(root, "home"), ANDROID_AVD_HOME: path.join(root, "avd"), ANDROID_HOME: "" } as NodeJS.ProcessEnv;
}

let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mobile-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("toolchain detection", () => {
    it("explains what is missing, in order", () => {
        const empty = fs.mkdtempSync(path.join(tmp, "none-"));
        const none = mobileAvailability({ TAQWRIGHT_HOME: path.join(empty, "x"), ANDROID_AVD_HOME: path.join(empty, "avd") });
        expect(none).toMatchObject({ available: false, toolchain: "none" });
        expect(none.reason).toMatch(/taqwright install/);

        const noAvd = mobileAvailability(fakeToolchain(fs.mkdtempSync(path.join(tmp, "noavd-")), false));
        expect(noAvd).toMatchObject({ available: false, toolchain: "managed", avds: [] });
        expect(noAvd.reason).toMatch(/no emulator/i);

        expect(mobileAvailability(fakeToolchain(fs.mkdtempSync(path.join(tmp, "ok-"))))).toEqual({ available: true, toolchain: "managed", avds: ["Pixel_Test"] });
    });
});

describe("mobile target", () => {
    it("needs an app package or an APK, and rejects malformed values", () => {
        expect(MobileTargetSchema.safeParse({}).success).toBe(false);
        expect(MobileTargetSchema.safeParse({ appPackage: "com.android.settings" }).success).toBe(true);
        expect(MobileTargetSchema.safeParse({ appPackage: "not a package" }).success).toBe(false);
        expect(MobileTargetSchema.safeParse({ appPackage: "com.example.app", avd: "../../etc" }).success).toBe(false);
    });
});

describe("generated mobile script", () => {
    const spec = TestSpecSchema.parse({ ...passing, testId: "MOB-001" });
    const script = renderScript(spec, "taqwright", { baseUrl: "http://x" }).content;
    it("uses Taqwright's API and attaches a screenshot when the test fails", () => {
        expect(script).toContain('from "@taqwright/taqwright"');
        expect(script).toContain("mobile.getByText(");
        expect(script).toContain("test.afterEach");
        expect(script).toContain("mobile.screenshot()");
        // each test starts from the app's first screen
        expect(script).toContain("test.beforeEach");
        expect(script).toContain("mobile.terminateApp(appId)");
        expect(script).toContain("mobile.launchApp(appId)");
    });
    it("does not embed secrets", () => {
        expect(script).not.toMatch(/sk-|password/i);
    });
});

describe("mobile runner", () => {
    it("runs scripts with a clean environment and maps results, steps and artifacts", async () => {
        process.env.OPENROUTER_API_KEY = "sk-secret-do-not-leak";
        process.env.API_KEY = "platform-api-key";
        const scripts = [
            { testId: "MOB-001", filename: "MOB-001.mobile.spec.ts", content: renderScript(TestSpecSchema.parse({ ...passing, testId: "MOB-001" }), "taqwright", { baseUrl: "http://x" }).content },
            { testId: "MOB-002", filename: "MOB-002.mobile.spec.ts", content: renderScript(TestSpecSchema.parse({ ...failing, testId: "MOB-002" }), "taqwright", { baseUrl: "http://x" }).content },
        ];
        const runs = await runMobileScripts(
            path.join(tmp, "scratch"),
            scripts,
            { target: { appPackage: "com.android.settings", apkPath: "C:/apps/demo.apk" }, avd: "Pixel_Test", cliPath: FAKE_CLI, keepEmulator: true, manageEmulator: false },
            { timeoutMs: 60_000 },
        );
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.API_KEY;

        const [ok, bad] = runs as [(typeof runs)[number], (typeof runs)[number]];
        expect(ok.status).toBe("passed");
        expect(ok.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
        expect(bad.status).toBe("failed");
        expect(bad.failedStepIndex).toBe(0);
        expect(bad.steps[0]!.error).toMatch(/toBeVisible/);
        // the inline screenshot became a file; video and the self-contained trace are kept
        expect(bad.artifacts.map((a) => a.kind).sort()).toEqual(["screenshot", "trace", "video"]);
        const shot = bad.artifacts.find((a) => a.kind === "screenshot")!;
        expect(fs.readFileSync(shot.path).subarray(1, 4).toString()).toBe("PNG");

        const seen = JSON.parse(fs.readFileSync(OBSERVED, "utf8")) as { args: string[]; env: Record<string, string>; config: string };
        expect(seen.args).toEqual(expect.arrayContaining(["test", "--workers=1"]));
        // target and device reach the child through the environment, not through interpolated source
        expect(seen.env.MOBILE_AVD).toBe("Pixel_Test");
        expect(seen.env.MOBILE_APP_PACKAGE).toBe("com.android.settings");
        expect(seen.env.MOBILE_APK_PATH).toBe("C:/apps/demo.apk");
        expect(seen.config).not.toContain("Pixel_Test");
        expect(seen.config).toContain("workers: 1");
        // the platform's own secrets never reach generated scripts
        expect(JSON.stringify(seen.env)).not.toContain("sk-secret-do-not-leak");
        expect(JSON.stringify(seen.env)).not.toContain("platform-api-key");
    });

    it("reports an error, not a pass, when the runner produces no report", async () => {
        const broken = path.join(tmp, "broken-cli.mjs");
        fs.writeFileSync(broken, 'console.error("[ADB] noisy line"); console.error("Appium could not start"); process.exit(1);');
        const [run] = await runMobileScripts(path.join(tmp, "scratch"), [{ testId: "MOB-009", filename: "MOB-009.mobile.spec.ts", content: "// x" }], { target: { appPackage: "com.android.settings" }, avd: "Pixel_Test", cliPath: broken, keepEmulator: true, manageEmulator: false }, { timeoutMs: 30_000 });
        expect(run!.status).toBe("error");
        expect(run!.error).toContain("Taqwright produced no report");
        expect(run!.error).toContain("Appium could not start");
        expect(run!.error).not.toContain("noisy line"); // adb chatter is filtered from diagnostics
    });

    it("kills a runner that exceeds its time limit", async () => {
        const hang = path.join(tmp, "hang-cli.mjs");
        fs.writeFileSync(hang, "setInterval(() => {}, 1000);");
        const t0 = Date.now();
        const [run] = await runMobileScripts(path.join(tmp, "scratch"), [{ testId: "MOB-010", filename: "MOB-010.mobile.spec.ts", content: "// x" }], { target: { appPackage: "com.android.settings" }, avd: "Pixel_Test", cliPath: hang, keepEmulator: true, manageEmulator: false }, { timeoutMs: 1500 });
        expect(Date.now() - t0).toBeLessThan(20_000);
        expect(run!.status).toBe("error");
        expect(run!.error).toMatch(/time limit/);
    });
});

describe("platform", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dataDir: string;
    const saved: Record<string, string | undefined> = {};
    const setEnv = (e: Record<string, string | undefined>) => {
        for (const [k, v] of Object.entries(e)) {
            if (!(k in saved)) saved[k] = process.env[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };

    beforeAll(async () => {
        setEnv({ ...fakeToolchain(fs.mkdtempSync(path.join(tmp, "plat-"))), MOBILE_RUNNER_CLI: FAKE_CLI, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_API_KEY: "" });
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mobileplat-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", MOBILE_KEEP_EMULATOR: "true" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers?: Record<string, string>) => {
        const res = await server.inject({ method, url, payload: payload as never, headers });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    async function waitForJob(jobId: string) {
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("job did not finish");
    }
    const testsOf = async (projectId: string) =>
        Object.fromEntries(((await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ testId: string; validationStatus: string; validationReason: string | null; id: string }>).map((t) => [t.testId, t]));

    it("reports whether this machine can run mobile tests", async () => {
        const cfg = (await call("GET", "/api/config")).body;
        expect(cfg.mobile).toEqual({ available: true, toolchain: "managed", avds: ["Pixel_Test"] });
    });

    it("keeps mobile tests pending, with the reason, until the project has an app", async () => {
        const project = (await call("POST", "/api/projects", { name: "Mobile" })).body.id as string;
        // a mobile-only project has no web address; importing needs no baseUrl once an app is given later
        const noApp = await call("POST", `/api/projects/${project}/specs`, { specs: [passing] });
        expect(noApp.status).toBe(400); // nothing to run against yet

        const first = await call("POST", `/api/projects/${project}/specs`, { specs: [passing, failing], validate: false, mobile: { appPackage: "com.android.settings" } });
        expect(first.status).toBe(202);
        const t = await testsOf(project);
        expect(t["MOB-001"]!.validationStatus).toBe("PENDING");
        expect(t["MOB-002"]!.validationStatus).toBe("PENDING");

        const detail = (await call("GET", `/api/projects/${project}`)).body;
        expect(detail.mobile).toEqual({ appPackage: "com.android.settings", apk: null, avd: null });
        expect(detail.application.url).toBe("android-app://com.android.settings");
    });

    it("runs mobile tests on the configured app and stores real results", async () => {
        const project = (await call("POST", "/api/projects", { name: "Mobile run" })).body.id as string;
        const imported = await call("POST", `/api/projects/${project}/specs`, { specs: [passing, failing], mobile: { appPackage: "com.android.settings" } });
        expect(imported.status).toBe(202);
        const job = await waitForJob(imported.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");

        const t = await testsOf(project);
        expect(t["MOB-001"]!.validationStatus).toBe("VALIDATED");
        expect(t["MOB-002"]!.validationStatus).toBe("FAILED_VALIDATION");
        expect(t["MOB-002"]!.validationReason).toMatch(/Nothing like this/);

        const detail = (await call("GET", `/api/tests/${t["MOB-002"]!.id}`)).body;
        expect(detail.executions[0].status).toBe("failed");
        expect(detail.executions[0].artifacts.map((a: { kind: string }) => a.kind).sort()).toEqual(["screenshot", "trace", "video"]);
        const shot = detail.executions[0].artifacts.find((a: { kind: string }) => a.kind === "screenshot");
        const img = await server.inject({ method: "GET", url: `/api/artifacts/${shot.id}` });
        expect(img.statusCode).toBe(200);
        expect(img.headers["content-type"]).toContain("image/png");

        // re-running a mobile test goes through the same path
        const again = await call("POST", `/api/tests/${t["MOB-001"]!.id}/validate`);
        expect(again.status).toBe(202);
        expect((await waitForJob(again.body.jobId)).status).toBe("COMPLETED");
    }, 60_000);

    it("fails a mobile-only job with a clear reason when no emulator exists on this machine", async () => {
        const project = (await call("POST", "/api/projects", { name: "No device" })).body.id as string;
        const made = await call("POST", `/api/projects/${project}/specs`, { specs: [passing], validate: false, mobile: { appPackage: "com.android.settings" } });
        const id = made.body.tests[0].id as string;
        const prev = { H: process.env.TAQWRIGHT_HOME, A: process.env.ANDROID_AVD_HOME };
        process.env.TAQWRIGHT_HOME = path.join(tmp, "nowhere");
        process.env.ANDROID_AVD_HOME = path.join(tmp, "nowhere-avd");
        try {
            const res = await call("POST", `/api/tests/${id}/validate`);
            expect(res.status).toBe(422);
            expect(res.body.error).toMatch(/taqwright install/);
        } finally {
            process.env.TAQWRIGHT_HOME = prev.H;
            process.env.ANDROID_AVD_HOME = prev.A;
        }
    });

    it("saves the app settings, accepts an APK, and never exposes server paths", async () => {
        const project = (await call("POST", "/api/projects", { name: "Settings" })).body.id as string;
        expect((await call("PUT", `/api/projects/${project}/mobile-app`, {})).status).toBe(400); // nothing to run against

        const set = await call("PUT", `/api/projects/${project}/mobile-app`, { appPackage: "com.example.shop", avd: "Pixel_Test" });
        expect(set.status).toBe(200);
        expect(set.body.mobile).toEqual({ appPackage: "com.example.shop", apk: null, avd: "Pixel_Test" });

        // not an APK
        const bad = await server.inject({ method: "POST", url: `/api/projects/${project}/mobile-app/apk?filename=app.apk`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("just text, not an app") });
        expect(bad.statusCode).toBe(400);

        // a zip that contains AndroidManifest.xml
        const fakeApk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40), Buffer.from("AndroidManifest.xml"), Buffer.alloc(60)]);
        const up = await server.inject({ method: "POST", url: `/api/projects/${project}/mobile-app/apk?filename=shop.apk`, headers: { "content-type": "application/vnd.android.package-archive" }, payload: fakeApk });
        expect(up.statusCode).toBe(200);
        expect(JSON.parse(up.body).mobile).toEqual({ appPackage: "com.example.shop", apk: "app.apk", avd: "Pixel_Test" });

        const detail = (await call("GET", `/api/projects/${project}`)).body;
        expect(JSON.stringify(detail)).not.toContain(dataDir.replaceAll("\\", "\\\\"));
        expect(JSON.stringify(detail.application.config)).not.toContain("apkPath");

        const cleared = await call("PUT", `/api/projects/${project}/mobile-app`, { clearApk: true });
        expect(cleared.body.mobile).toEqual({ appPackage: "com.example.shop", apk: null, avd: "Pixel_Test" });
    });

    it("applies the SSRF guard to every URL an imported spec can reach", async () => {
        setEnv({ BLOCK_PRIVATE_TARGETS: "true" });
        try {
            const project = (await call("POST", "/api/projects", { name: "SSRF" })).body.id as string;
            const spec = { title: "Sneaky", kind: "web", steps: [{ action: "navigate", url: "http://169.254.169.254/latest/meta-data/" }] };
            const res = await call("POST", `/api/projects/${project}/specs`, { specs: [spec], baseUrl: "http://93.184.216.34", validate: false });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/specs\[0\]\.steps\[0\]/);
            expect((await call("GET", `/api/projects/${project}/tests`)).body).toHaveLength(0);
        } finally {
            setEnv({ BLOCK_PRIVATE_TARGETS: undefined });
        }
    });
});
