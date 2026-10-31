/**
 * Phone reliability, really executed against the FAKE adb (tests/fixtures/fake-adb.mjs, a mock shop app; no emulator, no phone, no adb server), a
 * Taqwright stand-in that fails a step whose element is "gone" (tests/fixtures/fake-taqwright-steps.mjs), a Java/bundletool stand-in
 * (tests/fixtures/fake-java.mjs) and scripted AI doubles (never a real model):
 *  - a clean start and granted permissions before EACH phone test, in that order, and a test the phone could not be prepared for never runs;
 *  - the explorer's permission answer becomes the first step of every written test;
 *  - typing beyond ASCII through ADBKeyboard when it is the phone's keyboard;
 *  - the Mobile app settings, the permission checklist, .aab uploads;
 *  - phone self-repair: a missing element, the AI's choice on the real (fake) screen, one re-run, a suggestion a person applies.
 * Starts a platform in-process (no browser). Run alone, under the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-reliability.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { openLocalDeviceSession } from "../src/engine/mobile/device/session.js";
import { explore, ModelBudget } from "../src/engine/mobile/explore/explorer.js";
import { buildCandidates } from "../src/engine/mobile/explore/candidates.js";
import { buildPlan, chooseIdeas } from "../src/engine/mobile/explore/planner.js";
import { AAB_REFUSAL } from "../src/engine/mobile/state/bundle.js";
import { REPAIR_SYSTEM } from "../src/engine/mobile/repair/phone-repair.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runMobileScripts } from "../src/engine/validation/mobile-runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { parseScreen, scriptedPhoneModel } from "./fixtures/phone-model.js";

const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const FAKE_TQ = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright-steps.mjs");
const FAKE_JAVA = path.join(REPO_ROOT, "tests/fixtures/fake-java.mjs");
const TQ_SETTINGS = path.join(os.tmpdir(), "aitp-fake-tq-steps.json");
const PKG = "com.example.shop";
const PASSWORD = "Fake-Pass-1234";
const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

function fakeToolchain(root: string) {
    fs.mkdirSync(path.join(root, "sdk/platform-tools"), { recursive: true });
    fs.mkdirSync(path.join(root, "jdk/bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "sdk/platform-tools", exe("adb")), "");
    fs.writeFileSync(path.join(root, "jdk/bin", exe("java")), "");
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    fs.writeFileSync(path.join(root, "home/manifest.json"), JSON.stringify({ androidHome: path.join(root, "sdk"), javaHome: path.join(root, "jdk") }));
    fs.mkdirSync(path.join(root, "avd"), { recursive: true });
    fs.writeFileSync(path.join(root, "avd/Pixel_Test.ini"), "target=android-34\n");
    return { TAQWRIGHT_HOME: path.join(root, "home"), ANDROID_AVD_HOME: path.join(root, "avd"), ANDROID_HOME: "" };
}

let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let model: LlmClient;
const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};
let n = 0;
/** A fresh mock phone and fresh logs. */
const freshPhone = (extra: Record<string, string | undefined> = {}) => {
    n++;
    const log = path.join(tmp, `adb-${n}.log`);
    const observed = path.join(tmp, `tq-${n}.jsonl`);
    setEnv({ AITP_FAKE_STATE: path.join(tmp, `state-${n}.json`), AITP_FAKE_ADB_LOG: log, AITP_FAKE_IME: undefined, AITP_FAKE_GRANT_FAIL: undefined, ...extra });
    return { log, observed, state: process.env.AITP_FAKE_STATE! };
};
const tq = (o: { missing?: string[]; log: string; observed: string }) => fs.writeFileSync(TQ_SETTINGS, JSON.stringify({ missing: o.missing ?? [], log: o.log, observed: o.observed }));
const lines = (file: string): string[][] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The log without the serial, as "shell pm clear com.example.shop" or "taqwright X.spec.ts". */
const calls = (file: string) => lines(file).map((a) => (a[0] === "-s" ? a.slice(2) : a).join(" "));
const phoneState = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-rel-"));
    setEnv({ ...fakeToolchain(tmp), MOBILE_RUNNER_CLI: FAKE_TQ, AITP_ADB_PATH: FAKE_ADB, AITP_FAKE_APP: "shop", AITP_FAKE_DEVICES: "emulator", AITP_JAVA_PATH: path.join(tmp, "no-java"), BUNDLETOOL_JAR: undefined, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_API_KEY: "" });
    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MOBILE_KEEP_EMULATOR: "true", SECRET_KEY: "test-secret-key-0123456789" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => model }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(TQ_SETTINGS, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers?: Record<string, string>) => {
    const res = await server.inject({ method, url, payload: payload as never, ...(headers ? { headers } : {}) });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
async function finished(jobId: string): Promise<any> {
    for (let i = 0; i < 1200; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("job did not finish");
}
const events = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; message: string }>;
const newProject = async (name: string, mobile: Record<string, unknown> = { appPackage: PKG }) => {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    const r = await call("PUT", `/api/projects/${id}/mobile-app`, mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return id;
};

const spec = (title: string, steps: unknown[]) => TestSpecSchema.parse({ testId: "MOB-001", title, kind: "mobile", steps, source: { origin: "imported" } });
const scriptOf = (testId: string, s: ReturnType<typeof spec>) => {
    const r = renderWithAdapter({ ...s, testId }, "taqwright", { baseUrl: `android-app://${PKG}` });
    return { testId, filename: r.filename, content: r.content };
};

// ── clean start ────────────────────────────────────────────────────────────────

describe("a clean start before each phone test", () => {
    const tests = [scriptOf("MOB-001", spec("Shop opens", [{ action: "assert", check: "visible", locator: { by: "testId", value: "toolbar_title" } }])), scriptOf("MOB-002", spec("Products open", [{ action: "click", locator: { by: "testId", value: "products_button" } }]))];

    it("clears the app's data and grants the permissions in front of every test, each test in its own run", async () => {
        const p = freshPhone();
        tq({ log: p.log, observed: p.observed });
        const runs = await runMobileScripts(path.join(tmp, "scratch-a"), tests, { target: { appPackage: PKG, cleanStart: true, grantPermissions: ["android.permission.CAMERA", "android.permission.POST_NOTIFICATIONS"] }, avd: "Pixel_Test", cliPath: FAKE_TQ, manageEmulator: false });
        expect(runs.map((r) => [r.testId, r.status])).toEqual([["MOB-001", "passed"], ["MOB-002", "passed"]]);
        const order = calls(p.log).filter((c) => /pm (clear|grant)|force-stop|^taqwright/.test(c));
        const prep = [`shell am force-stop ${PKG}`, `shell pm clear ${PKG}`, `shell pm grant ${PKG} android.permission.CAMERA`, `shell pm grant ${PKG} android.permission.POST_NOTIFICATIONS`];
        expect(order).toEqual([...prep, `taqwright ${tests[0]!.filename}`, ...prep, `taqwright ${tests[1]!.filename}`]);
        expect(phoneState(p.state).cleared).toBe(2);
    });

    it("a test the phone could not be prepared for is an error with the reason and never runs; the others still run", async () => {
        const p = freshPhone({ AITP_FAKE_GRANT_FAIL: "android.permission.CAMERA" });
        tq({ log: p.log, observed: p.observed });
        const runs = await runMobileScripts(path.join(tmp, "scratch-b"), tests, { target: { appPackage: PKG, grantPermissions: ["android.permission.CAMERA"] }, avd: "Pixel_Test", cliPath: FAKE_TQ, manageEmulator: false });
        expect(runs.map((r) => r.status)).toEqual(["error", "error"]);
        expect(runs[0]!.error).toBe("The phone could not be prepared for this test, so it did not run: the permission Camera (android.permission.CAMERA) could not be granted; check that the app asks for it.");
        expect(calls(p.log).some((c) => c.startsWith("taqwright"))).toBe(false);
    });

    it("off (the default): one run for all tests and no clear, exactly as before", async () => {
        const p = freshPhone();
        tq({ log: p.log, observed: p.observed });
        const runs = await runMobileScripts(path.join(tmp, "scratch-c"), tests, { target: { appPackage: PKG }, avd: "Pixel_Test", cliPath: FAKE_TQ, manageEmulator: false });
        expect(runs.map((r) => r.status)).toEqual(["passed", "passed"]);
        // (The phone quality checks read the crash log around a run; only clearing, granting and runs matter here.)
        expect(calls(p.log).filter((c) => /pm (clear|grant)|^taqwright/.test(c))).toEqual([`taqwright ${tests[0]!.filename} ${tests[1]!.filename}`]);
    });
});

// ── permission answers become steps; typing beyond ASCII ──────────────────────

describe("on the phone itself", () => {
    it("the explorer's answer to the permission question becomes the first step of every written test", async () => {
        freshPhone();
        const llm = scriptedPhoneModel([{ tap: "Products" }, { back: true }, { finish: true }]);
        const ctx = { llm, emit: () => undefined } as never;
        const session = await openLocalDeviceSession({ appPackage: PKG });
        let found;
        try {
            found = await explore({ ctx, session, appPackage: PKG, credentialsGiven: false, allowDataChanges: false });
        } finally {
            await session.close();
        }
        expect(found.permissions).toEqual([{ question: "send you notifications", choice: "Don't allow", allowed: false }]);
        const { candidates, dropped } = buildCandidates(found);
        const { chosen } = await chooseIdeas(ctx, found, candidates, new ModelBudget(10), 10);
        const plan = buildPlan(found, chosen, dropped);
        expect(plan.ideas.length).toBeGreaterThan(0);
        for (const idea of plan.ideas) {
            const steps = (idea.draft as { steps: Array<Record<string, unknown>> }).steps;
            expect(steps[0]).toEqual({ action: "press", key: "device:permission", locator: { by: "text", value: "Don't allow" }, description: `Don't allow "send you notifications" when asked` });
            expect(steps.filter((s) => s.key === "device:permission")).toHaveLength(1);
        }
    }, 60_000);

    it("types any text through ADBKeyboard when it is the phone's keyboard, as base64 and never through a shell; without it, refuses as before", async () => {
        const p = freshPhone({ AITP_FAKE_IME: "adbkeyboard" });
        const session = await openLocalDeviceSession({ appPackage: PKG });
        try {
            let s = await session.snapshot();
            const deny = s.elements.find((e) => e.text === "Don't allow")!;
            s = (await session.act({ kind: "tap", index: deny.index })).snapshot!;
            const search = s.elements.find((e) => e.id === "search_box")!;
            const r = await session.act({ kind: "type", index: search.index, text: "Café ☕ 日本語; rm -rf /" });
            expect(r.ok, r.error).toBe(true);
            expect(r.snapshot!.elements.find((e) => e.id === "search_box")!.text).toBe("Café ☕ 日本語; rm -rf /");
        } finally {
            await session.close();
        }
        const st = phoneState(p.state);
        expect(st.typed.at(-1)).toEqual({ field: "search", text: "Café ☕ 日本語; rm -rf /", ime: true });
        expect(st.injected).toEqual([]);
        const sent = calls(p.log).find((c) => c.includes("ADB_INPUT_B64"))!;
        expect(sent).toMatch(/^shell am broadcast -a ADB_INPUT_B64 --es msg [A-Za-z0-9+/=]+$/);

        freshPhone();
        const plain = await openLocalDeviceSession({ appPackage: PKG });
        try {
            let s = await plain.snapshot();
            s = (await plain.act({ kind: "tap", index: s.elements.find((e) => e.text === "Don't allow")!.index })).snapshot!;
            const r = await plain.act({ kind: "type", index: s.elements.find((e) => e.id === "search_box")!.index, text: "Café" });
            expect(r).toMatchObject({ ok: false, error: "That text has characters the phone can't type here. Use plain letters, digits and common symbols." });
        } finally {
            await plain.close();
        }
    }, 60_000);
});

// ── the platform ───────────────────────────────────────────────────────────────

describe("Mobile app settings", () => {
    it("saves the options, shows them back only when on, and refuses what cannot work", async () => {
        freshPhone();
        const id = await newProject("Settings");
        expect((await call("GET", `/api/projects/${id}`)).body.mobile).toEqual({ appPackage: PKG, apk: null, avd: null });
        const on = await call("PUT", `/api/projects/${id}/mobile-app`, { cleanStart: true, grantPermissions: ["android.permission.CAMERA"] });
        expect(on.body.mobile).toEqual({ appPackage: PKG, apk: null, avd: null, cleanStart: true, grantPermissions: ["android.permission.CAMERA"] });
        // A request that leaves the options out keeps them; null switches one off.
        expect((await call("PUT", `/api/projects/${id}/mobile-app`, { avd: "Pixel_Test" })).body.mobile.cleanStart).toBe(true);
        expect((await call("PUT", `/api/projects/${id}/mobile-app`, { cleanStart: null })).body.mobile).toEqual({ appPackage: PKG, apk: null, avd: "Pixel_Test", grantPermissions: ["android.permission.CAMERA"] });
        const bad = await call("PUT", `/api/projects/${id}/mobile-app`, { grantPermissions: ["android.permission.CAMERA; reboot"] });
        expect(bad.status).toBe(400);
        const ios = (await call("POST", "/api/projects", { name: "iOS only" })).body.id as string;
        const noPkg = await call("PUT", `/api/projects/${ios}/mobile-app`, { iosBundleId: "com.example.App", cleanStart: true });
        expect(noPkg.status).toBe(400);
        expect(noPkg.body.message ?? noPkg.body.error).toMatch(/need the app's package name/);
    });

    it("lists the permissions the app asks for, read from the connected phone", async () => {
        freshPhone();
        const id = await newProject("Permissions");
        const r = await call("GET", `/api/projects/${id}/mobile-app/permissions`);
        expect(r.body).toEqual({
            available: true,
            permissions: [
                { name: "android.permission.POST_NOTIFICATIONS", label: "Post notifications", granted: false },
                { name: "android.permission.CAMERA", label: "Camera", granted: false },
            ],
        });
        freshPhone({ AITP_FAKE_DEVICES: "none" });
        const none = await call("GET", `/api/projects/${id}/mobile-app/permissions`);
        expect(none.body).toMatchObject({ available: false, permissions: [] });
        expect(none.body.reason).toMatch(/^No phone or emulator is connected/);
        setEnv({ AITP_FAKE_DEVICES: "emulator" });
    });

    it("refuses an .aab in plain words without bundletool, and turns it into an APK with it", async () => {
        const id = await newProject("Bundle");
        const head = Buffer.alloc(4);
        head.writeUInt32LE(0x04034b50, 0);
        const aab = Buffer.concat([head, Buffer.from("x".repeat(200) + " base/manifest/AndroidManifest.xml BundleConfig.pb")]);
        const send = (data: Buffer, filename = "shop.aab") => server.inject({ method: "POST", url: `/api/projects/${id}/mobile-app/apk?filename=${filename}`, payload: data, headers: { "content-type": "application/octet-stream" } });
        const refused = await send(aab);
        expect(refused.statusCode).toBe(400);
        expect(JSON.parse(refused.body).message ?? JSON.parse(refused.body).error).toBe(AAB_REFUSAL);

        const jar = path.join(tmp, "bundletool.jar");
        fs.writeFileSync(jar, "not really a jar");
        setEnv({ AITP_JAVA_PATH: FAKE_JAVA, BUNDLETOOL_JAR: jar });
        try {
            const ok = await send(aab);
            expect(ok.statusCode, ok.body).toBe(200);
            expect(JSON.parse(ok.body).mobile).toMatchObject({ appPackage: PKG, apk: "app.apk" });
            const stored = path.join(platform.config.artifactsDir, `${id}/_apps/app.apk`);
            expect(fs.readFileSync(stored, "utf8")).toContain("fake universal apk");
            expect(fs.existsSync(path.join(platform.config.artifactsDir, `${id}/_apps/app.aab`))).toBe(false);
            const broken = await send(Buffer.concat([aab, Buffer.from("BROKEN-BUNDLE")]));
            expect(broken.statusCode).toBe(400);
            expect(JSON.parse(broken.body).message ?? JSON.parse(broken.body).error).toMatch(/^bundletool could not turn the bundle into an app: .*could not be parsed/);
        } finally {
            setEnv({ AITP_JAVA_PATH: path.join(tmp, "no-java"), BUNDLETOOL_JAR: undefined });
        }
    }, 60_000);

    it("a run of phone tests with a clean start says so and prepares the phone in front of the test", async () => {
        const p = freshPhone();
        tq({ log: p.log, observed: p.observed });
        model = scriptedPhoneModel([]);
        const id = await newProject("Clean run", { appPackage: PKG, cleanStart: true });
        const made = await call("POST", `/api/projects/${id}/specs`, { specs: [{ title: "Shop opens", kind: "mobile", category: "Phone", steps: [{ action: "assert", check: "visible", locator: { by: "testId", value: "toolbar_title" } }] }], validate: false });
        expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
        const testId = (await call("GET", `/api/projects/${id}/tests`)).body[0].id as string;
        const jobId = (await call("POST", `/api/tests/${testId}/validate`)).body.jobId as string;
        const job = await finished(jobId);
        expect(job.status).toBe("COMPLETED");
        expect((await events(jobId)).find((e) => e.kind === "phone_start_state")?.message).toBe("Each phone test starts from a fresh copy of the app's data (the app's data is cleared before each test).");
        const order = calls(p.log).filter((c) => /pm clear|^taqwright/.test(c));
        expect(order[0]).toBe(`shell pm clear ${PKG}`);
        expect(order[1]).toMatch(/^taqwright /);
    }, 60_000);
});

// ── self-repair ────────────────────────────────────────────────────────────────

/** A scripted model for the repair question: picks the element whose id is `pick` (or answers null), and remembers every prompt. */
function repairModel(pick: string | null) {
    const prompts: string[] = [];
    const m: LlmClient & { prompts: string[] } = {
        modelName: "scripted",
        model: {} as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        prompts,
        text: async () => "",
        object: (async ({ system, prompt }: { system: string; prompt: string }) => {
            if (system !== REPAIR_SYSTEM) throw new Error("unexpected question");
            prompts.push(prompt);
            const e = pick === null ? undefined : parseScreen(prompt).find((x) => x.id === pick);
            return { index: e ? e.index : null, reason: e ? "Same button, its id was renamed" : "Nothing like it" };
        }) as LlmClient["object"],
    };
    return m;
}

describe("phone self-repair", () => {
    let projectId: string;
    let testId: string;
    const broken = { title: "Open the sign-in screen", kind: "mobile", category: "Phone", steps: [{ action: "click", locator: { by: "testId", value: "signin_old" } }, { action: "assert", check: "visible", locator: { by: "testId", value: "username_field" } }] };

    beforeAll(async () => {
        projectId = await newProject("Repair");
        const made = await call("POST", `/api/projects/${projectId}/specs`, { specs: [broken], validate: false });
        expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
        testId = (await call("GET", `/api/projects/${projectId}/tests`)).body[0].id as string;
    });

    const runIt = async (pick: string | null) => {
        const p = freshPhone();
        tq({ missing: ["signin_old"], log: p.log, observed: p.observed });
        const llm = repairModel(pick);
        model = llm;
        const jobId = (await call("POST", `/api/tests/${testId}/validate`)).body.jobId as string;
        const job = await finished(jobId);
        return { job, llm, p, ev: await events(jobId) };
    };

    it("looks at the phone at the failing step, asks the AI among that screen's elements, tries once, and suggests the repair", async () => {
        const { job, llm, p, ev } = await runIt("signin_button");
        expect((await call("GET", `/api/tests/${testId}`)).body.validationStatus).toBe("FAILED_VALIDATION");
        expect(ev.map((e) => e.kind)).toContain("phone_repair_started");
        expect(ev.find((e) => e.kind === "healing_proposed")?.message).toMatch(/the AI suggests a repair \(high confidence\); it waits for approval/);
        // The AI saw the app's own screen, as untrusted data, never the password.
        expect(llm.prompts).toHaveLength(1);
        expect(llm.prompts[0]).toContain("It looked for the element marked “signin_old”");
        expect(llm.prompts[0]).toMatch(/<screen untrusted-app-data>[\s\S]*id=signin_button[\s\S]*<\/screen>/);
        expect(JSON.stringify(ev) + llm.prompts.join("")).not.toContain(PASSWORD);
        // The test was tried once with the choice, on the device, after the session let go of it.
        const runs = calls(p.log).filter((c) => c.startsWith("taqwright"));
        expect(runs).toHaveLength(2);
        expect(fs.readFileSync(p.observed, "utf8")).toContain('getByTestId(\\"signin_button\\")');

        const healing = (await call("GET", `/api/tests/${testId}/healing`)).body;
        expect(healing.proposals).toHaveLength(1);
        const prop = healing.proposals[0];
        expect(prop).toMatchObject({ stepIndex: 0, oldLocator: { by: "testId", value: "signin_old" }, newLocator: { by: "testId", value: "signin_button" }, confidenceLabel: "high", canApply: true, status: "proposed" });
        expect(prop.reason).toBe("The AI looked at the phone's screen at this step and chose “Sign in” (Same button, its id was renamed). The test passed when it was run once with it.");
        expect(job.status).toBeDefined();

        // Nothing changed until a person applies it; then the test runs again and passes.
        expect((await call("GET", `/api/tests/${testId}`)).body.spec.steps[0].locator.value).toBe("signin_old");
        const applied = await call("POST", `/api/tests/${testId}/healing/${prop.id}/apply`);
        expect(applied.status, JSON.stringify(applied.body)).toBe(202);
        await finished(applied.body.jobId);
        const after = (await call("GET", `/api/tests/${testId}`)).body;
        expect(after.spec.steps[0].locator).toEqual({ by: "testId", value: "signin_button" });
        expect(after.validationStatus).toBe("VALIDATED");
    }, 120_000);

    it("suggests nothing when the AI finds no clear match, or chooses something the safety rules forbid", async () => {
        // Break the test again (a fresh import of the same broken test).
        const made = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ ...broken, title: "Open the sign-in screen again" }], validate: false });
        expect(made.status).toBeLessThan(300);
        testId = ((await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>).find((t) => t.title === "Open the sign-in screen again")!.id;

        const nothing = await runIt(null);
        expect(nothing.ev.find((e) => e.kind === "phone_repair_none")?.message).toBe("MOB-002: no repair suggested: the AI found no element on the screen that is clearly the same: Nothing like it");
        expect(calls(nothing.p.log).filter((c) => c.startsWith("taqwright"))).toHaveLength(1);

        const unsafe = await runIt("delete_account_link");
        expect(unsafe.ev.find((e) => e.kind === "phone_repair_none")?.message).toMatch(/the AI chose “Delete account”, which the safety rules do not allow \(Skipped “Delete account” because it looks destructive\)$/);
        expect(phoneState(unsafe.p.state).app?.deleted ?? false).toBe(false);
        expect((await call("GET", `/api/tests/${testId}/healing`)).body.proposals).toEqual([]);
    }, 120_000);
});
