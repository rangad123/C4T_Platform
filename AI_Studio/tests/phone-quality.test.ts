/**
 * Phone quality checks for real, against the FAKE adb (tests/fixtures/fake-adb.mjs: no emulator, no phone, no adb server) and the Taqwright stand-in
 * (tests/fixtures/fake-taqwright.mjs), with a scripted model (never a real one):
 *  - the mobile runner: a crash or freeze logged during a run fails the test with the stack trace (a finding), never a silent pass; another app's
 *    crash is ignored; start-up checks are measured with `am start -W`; an accessibility check test reads the screen it ended on;
 *  - the whole platform: the AI explores the "crashy" app, the crash is recorded and the app restarted, the plan lists it with the start-up time,
 *    creating the plan keeps it as a test that needs a look, and running that test again checks it on the phone;
 *  - accessibility of phone screens as an opt-in check family.
 *
 * Starts a platform server in-process (server.inject, no port) and many fake adb processes: run under the shared lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-quality.test.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { createLlmClientOrUnavailable, type LlmClient } from "../src/engine/llm/provider.js";
import { TAG_A11Y, TAG_STARTUP, budgetTag } from "../src/engine/mobile/quality/findings.js";
import { taqwrightGenerator } from "../src/engine/generators/taqwright.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runMobileScripts } from "../src/engine/validation/mobile-runner.js";
import { classifyFailedRun } from "../src/engine/validation/validator.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { scriptedPhoneModel, type Intent } from "./fixtures/phone-model.js";

const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

let tmp: string;
let stateCount = 0;
const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};

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

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-quality-"));
});
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ── the mobile runner ─────────────────────────────────────────────────────────

const specOf = (id: string, o: Partial<TestSpec> = {}): TestSpec =>
    TestSpecSchema.parse({ testId: id, title: `Phone test ${id}`, kind: "mobile", platform: "android", category: "Phone", steps: [{ action: "wait", ms: 100 }], tags: ["phone"], source: { scenarioId: id, origin: "exploration" }, ...o });
const scriptOf = (spec: TestSpec) => {
    const r = taqwrightGenerator.render(spec, { baseUrl: "android-app://x" });
    return { testId: spec.testId, filename: r.filename, content: r.content };
};

/** One run through the real mobile runner, with the fake phone running `app` and the given faults. */
async function run(specs: TestSpec[], o: { app?: string; faults?: string; adb?: string | null; budgetMs?: number; prepare?: (env: NodeJS.ProcessEnv) => void } = {}) {
    const app = o.app ?? "crashy";
    const pkg = `com.example.${app}`;
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        AITP_FAKE_STATE: path.join(tmp, `runner-${++stateCount}.json`),
        AITP_FAKE_APP: app,
        AITP_FAKE_DEVICES: "emulator",
        AITP_FAKE_FAULTS: o.faults ?? "",
        AITP_FAKE_ADB_LOG: path.join(tmp, `runner-${stateCount}.jsonl`),
    };
    if (o.adb === null) env.AITP_ADB_PATH = path.join(tmp, "no-such-adb.mjs");
    else env.AITP_ADB_PATH = o.adb ?? FAKE_ADB;
    o.prepare?.(env);
    const lines: string[] = [];
    const runs = await runMobileScripts(path.join(tmp, "scratch"), specs.map(scriptOf), { target: { appPackage: pkg, ...(o.budgetMs ? { startupBudgetMs: o.budgetMs } : {}) }, avd: "Fake_AVD", sourceEnv: env, cliPath: FAKE_CLI, manageEmulator: false, log: (m) => lines.push(m) });
    const adbCalls = fs.existsSync(env.AITP_FAKE_ADB_LOG!) ? fs.readFileSync(env.AITP_FAKE_ADB_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
    return { runs, lines, env, adbCalls };
}

describe("phone test runs watch the app", { timeout: 120_000 }, () => {
    it("a crash logged during the run fails the test with the exception and the stack (a finding); another app's crash is ignored", async () => {
        const spec = specOf("MOB-001");
        const { runs, lines } = await run([spec], { faults: "crash-in-run" });
        expect(runs[0]!.status).toBe("failed");
        expect(runs[0]!.error).toMatch(/^The app crashed: java\.lang\.NullPointerException: Attempt to read cart on a null object/);
        expect(runs[0]!.error).toContain("Stack trace (cut):");
        expect(runs[0]!.error).not.toContain("not our app");
        // secrets in the log are scrubbed
        expect(runs[0]!.error).toContain("token=[hidden]");
        expect(classifyFailedRun(spec, runs[0]!)).toMatchObject({ status: "NEEDS_REVIEW" });
        expect(lines.join("\n")).toMatch(/The app crashed during the run/);
    });

    it("a freeze (ANR) fails the test as 'stopped responding'", async () => {
        const { runs } = await run([specOf("MOB-002")], { faults: "anr-in-run" });
        expect(runs[0]!.error).toMatch(/^The app stopped responding: Input dispatching timed out/);
    });

    it("without a crash the test passes as before; with several tests that all passed, the crash goes on the last and says so", async () => {
        const quiet = await run([specOf("MOB-003")]);
        expect(quiet.runs[0]!.status).toBe("passed");
        // only the fixed read-only commands were used, and the log was marked and read
        expect(quiet.adbCalls.filter((a) => a.includes("logcat")).length).toBe(2);
        const many = await run([specOf("MOB-004"), specOf("MOB-005")], { faults: "crash-in-run" });
        expect(many.runs.map((r) => r.status)).toEqual(["passed", "failed"]);
        expect(many.runs[1]!.error).toContain("it could not be told which one");
    });

    it("a phone that cannot be reached never fails a plain test, and the run says what was not checked", async () => {
        const { runs, lines } = await run([specOf("MOB-006")], { adb: null });
        expect(runs[0]!.status).toBe("passed");
        expect(lines.join("\n")).toMatch(/Crashes and freezes are not checked in this run/);
    });

    it("an unreadable log is said once; the test still passes", async () => {
        const { runs, lines } = await run([specOf("MOB-007")], { faults: "no-logcat" });
        expect(runs[0]!.status).toBe("passed");
        expect(lines.join("\n")).toContain("crash log could not be read");
    });

    it("start-up checks: over the budget is a finding with the numbers, within it passes with the number noted", async () => {
        const startup = specOf("MOB-008", { tags: ["phone", TAG_STARTUP, budgetTag(5000)] });
        const slow = await run([startup], { faults: "slow-start" });
        expect(slow.runs[0]!.error).toMatch(/^Slow start-up: the app took 7\.4 s to show its first screen from a cold start; the budget is 5 s\./);
        expect(classifyFailedRun(startup, slow.runs[0]!)).toMatchObject({ status: "NEEDS_REVIEW" });
        expect(slow.adbCalls.some((a) => a.join(" ").endsWith("am start -S -W -n com.example.crashy/.MainActivity"))).toBe(true);
        const fast = await run([startup]);
        expect(fast.runs[0]!.status).toBe("passed");
        expect(fast.runs[0]!.notes?.join(" ")).toContain("Start-up: 850 ms from a cold start (budget 5 s)");
        // the project's budget wins over the one written into the test
        const strict = await run([startup], { budgetMs: 800 });
        expect(strict.runs[0]!.error).toMatch(/budget is 800 ms/);
    });

    it("an accessibility check test reads the screen it ended on; it runs on its own", async () => {
        const check = specOf("MOB-009", { tags: ["phone", TAG_A11Y] });
        const open = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [FAKE_ADB, "shell", "monkey", "-p", "com.example.inaccessible", "-c", "android.intent.category.LAUNCHER", "1"], { env });
        const { runs } = await run([specOf("MOB-010"), check], { app: "inaccessible", prepare: open });
        expect(runs.map((r) => r.testId)).toEqual(["MOB-010", "MOB-009"]);
        expect(runs[0]!.status).toBe("passed");
        const a11y = runs[1]!;
        expect(a11y.error).toMatch(/^Phone accessibility: 4 problems on “Inaccessible”\./);
        expect(a11y.error).toContain("- [medium] The image button with id “gear” has no content description");
        expect(a11y.error).toContain("2 buttons are all called “Open”");
        expect(classifyFailedRun(check, a11y)).toMatchObject({ status: "NEEDS_REVIEW" });
        // the phone is not showing the app: the check says so instead of passing
        const away = await run([check], { app: "inaccessible" });
        expect(away.runs[0]!.status).toBe("failed");
        expect(away.runs[0]!.error).toContain("after the test the phone did not show it");
        expect(classifyFailedRun(check, away.runs[0]!)).toBeUndefined();
    });
});

// ── the whole platform ───────────────────────────────────────────────────────

describe("the AI explores a crashing app through the platform", { timeout: 300_000 }, () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let model: LlmClient = createLlmClientOrUnavailable(loadConfig({ DATA_DIR: os.tmpdir() }));

    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
    };
    const finished = async (jobId: string): Promise<any> => {
        for (let i = 0; i < 1200; i++) {
            const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("job did not finish");
    };
    const newProject = async (name: string, mobile: Record<string, unknown>) => {
        const id = (await call("POST", "/api/projects", { name })).body.id as string;
        const put = await call("PUT", `/api/projects/${id}/mobile-app`, mobile);
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        return id;
    };
    const explore = async (projectId: string, app: string, script: Intent[], faults = "", body: Record<string, unknown> = {}) => {
        setEnv({ AITP_FAKE_STATE: path.join(tmp, `platform-${++stateCount}.json`), AITP_FAKE_APP: app, AITP_FAKE_FAULTS: faults || undefined });
        model = scriptedPhoneModel(script);
        const started = await call("POST", `/api/projects/${projectId}/test-generation`, { targets: ["mobile"], plan: true, ...body });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const job = await finished(started.body.jobId);
        expect(job.status, job.error ?? "").toBe("COMPLETED");
        return started.body.jobId as string;
    };
    const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; validationStatus: string; validationReason: string | null }>;

    beforeAll(async () => {
        setEnv({ ...fakeToolchain(path.join(tmp, "tc")), MOBILE_RUNNER_CLI: FAKE_CLI, AITP_ADB_PATH: FAKE_ADB, AITP_FAKE_DEVICES: "emulator", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_API_KEY: "" });
        // This file covers the AI-led explorer (PHONE_EXPLORER=ai); the map explorer is covered in tests/phone-explore-map-*.test.ts.
        platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MOBILE_KEEP_EMULATOR: "true", SECRET_KEY: "test-secret-key-0123456789", PHONE_EXPLORER: "ai" }));
        server = await buildServer(platform);
        worker = new Worker({ ...platform, makeLlm: () => model }, 100);
        worker.start();
    }, 60_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
    });

    let projectId: string;
    let planJob: string;

    it("records the crash, restarts the app, measures the start, and the plan lists them with exact counts", async () => {
        projectId = await newProject("Crashy app", { appPackage: "com.example.crashy", startupBudgetMs: 3000 });
        expect((await call("GET", `/api/projects/${projectId}`)).body.mobile.startupBudgetMs).toBe(3000);
        planJob = await explore(projectId, "crashy", [{ tap: "Settings" }, { tap: "Crash now" }, { tap: "About" }, { finish: true }], "slow-start");
        const events = (await call("GET", `/api/test-generation/${planJob}/events`)).body as Array<{ kind: string; message: string; level?: string }>;
        expect(events.find((e) => e.kind === "mobile_app_crashed")?.message).toMatch(/^The app crashed: java\.lang\.IllegalStateException: Settings are not loaded/);
        expect(events.some((e) => e.kind === "mobile_startup_time" && /7\.4 s/.test(e.message) && e.level === "warn")).toBe(true);
        // it went on after the crash: About was reached
        expect(events.some((e) => e.kind === "mobile_screen_found" && /About/.test(e.message))).toBe(true);

        const plan = (await call("GET", `/api/projects/${projectId}/plans/${planJob}`)).body;
        const q = plan.phone.quality;
        expect(q.crashes).toHaveLength(1);
        expect(q.crashes[0].screen).toBe("Settings");
        expect(q.crashes[0].steps.at(-1)).toBe("Tapped “Crash now”");
        expect(JSON.stringify(q)).not.toContain("tester@example.test");
        expect(JSON.stringify(q)).not.toContain("abcd1234secretvalue");
        expect(q.startup).toMatchObject({ budgetMs: 3000, overBudget: true, measure: { totalMs: 7400 } });
        expect(q.tests.map((t: { kind: string }) => t.kind)).toEqual(["crash", "startup"]);
        expect(q.accessibility.length).toBe(plan.phone.screens.length);
        const fam = Object.fromEntries((plan.families as Array<{ id: string; effective: number }>).map((f) => [f.id, f.effective]));
        expect(fam.phoneCrashes).toBe(1);
        expect(fam.phoneStartup).toBe(1);
        expect(plan.total).toBe(plan.phone.ideas.length + 2);
        expect(plan.warnings.join(" ")).toMatch(/The app crashed once while the AI explored it/);
    });

    it("creating the plan keeps the crash and the slow start as tests that need a look, with the facts", async () => {
        const created = await call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, {});
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        const job = await finished(created.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const tests = await testsOf(projectId);
        const crash = tests.find((t) => t.title === "The app does not crash on “Settings”")!;
        expect(crash.validationStatus).toBe("NEEDS_REVIEW");
        expect(crash.validationReason).toMatch(/^The app crashed: java\.lang\.IllegalStateException: Settings are not loaded/);
        expect(crash.validationReason).toContain("Steps that led to it:");
        expect(crash.validationReason).toContain("[e-mail hidden]");
        const detail = (await call("GET", `/api/tests/${crash.id}`)).body;
        expect(detail.spec.steps.map((s: { action: string }) => s.action)).toEqual(["click", "click", "wait"]);
        expect(detail.severity?.severity ?? detail.severity).toBe("high");
        const slow = tests.find((t) => t.title === "The app opens within 3 s")!;
        expect(slow.validationStatus).toBe("NEEDS_REVIEW");
        expect(slow.validationReason).toMatch(/^Slow start-up: the app took 7\.4 s/);
        expect(job.testsGenerated).toBe(tests.length);
    });

    it("running the crash test again checks it on the phone: a crash in that run keeps it as a finding, a quiet run passes", async () => {
        const crash = (await testsOf(projectId)).find((t) => t.title === "The app does not crash on “Settings”")!;
        setEnv({ AITP_FAKE_STATE: path.join(tmp, `platform-${++stateCount}.json`), AITP_FAKE_FAULTS: "crash-in-run" });
        const again = await call("POST", `/api/tests/${crash.id}/validate`, {});
        expect(again.status, JSON.stringify(again.body)).toBe(202);
        await finished(again.body.jobId);
        let t = (await testsOf(projectId)).find((x) => x.id === crash.id)!;
        expect(t.validationStatus).toBe("NEEDS_REVIEW");
        expect(t.validationReason).toMatch(/^The app crashed: java\.lang\.NullPointerException/);
        setEnv({ AITP_FAKE_STATE: path.join(tmp, `platform-${++stateCount}.json`), AITP_FAKE_FAULTS: undefined });
        const quiet = await call("POST", `/api/tests/${crash.id}/validate`, {});
        await finished(quiet.body.jobId);
        t = (await testsOf(projectId)).find((x) => x.id === crash.id)!;
        expect(t.validationStatus).toBe("VALIDATED");
    });

    it("phone accessibility is opt-in: listed and created only when Accessibility is switched on", async () => {
        const project = await newProject("Inaccessible app", { appPackage: "com.example.inaccessible" });
        const intents: Intent[] = [{ tap: "About" }, { finish: true }];
        const off = await explore(project, "inaccessible", intents);
        const offPlan = (await call("GET", `/api/projects/${project}/plans/${off}`)).body;
        expect(offPlan.families.some((f: { id: string }) => f.id === "phoneAccessibility")).toBe(false);
        const home = offPlan.phone.quality.accessibility.find((s: { title: string }) => s.title === "Inaccessible");
        expect(home.issues.map((i: { rule: string }) => i.rule).sort()).toEqual(["duplicate-label", "image-no-description", "no-label", "small-target"]);
        expect(offPlan.phone.quality.notes.join(" ")).toMatch(/Text size and colour contrast are not checked/);

        const on = await explore(project, "inaccessible", intents, "", { accessibility: true });
        const onPlan = (await call("GET", `/api/projects/${project}/plans/${on}`)).body;
        expect(onPlan.families.find((f: { id: string }) => f.id === "phoneAccessibility")).toMatchObject({ count: 1, on: true, label: "Phone accessibility" });
        const created = await call("POST", `/api/projects/${project}/plans/${on}/create`, { accessibility: true });
        await finished(created.body.jobId);
        const t = (await testsOf(project)).find((x) => x.title === "Accessibility of “Inaccessible”")!;
        expect(t.validationStatus).toBe("NEEDS_REVIEW");
        expect(t.validationReason).toMatch(/^Phone accessibility: 4 problems on “Inaccessible”\./);
        const detail = (await call("GET", `/api/tests/${t.id}`)).body;
        expect(detail.spec.tags).toContain(TAG_A11Y);
    });
});
