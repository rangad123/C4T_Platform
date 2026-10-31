/**
 * AI phone exploration through the whole platform: HTTP API -> job queue -> worker -> the real local device session -> the FAKE adb (tests/fixtures/fake-adb.mjs,
 * a mock shop app: no emulator, no phone, no adb server) -> a scripted model (never a real one) -> a plan the person approves -> tests created from it -> run
 * through the existing mobile runner with the Taqwright stand-in (tests/fixtures/fake-taqwright.mjs).
 *
 * Nothing real is ever started. Run alone:
 *   node node_modules/vitest/vitest.mjs run tests/mobile-explore.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { createLlmClientOrUnavailable, type LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { frameHub } from "../src/platform/frame-hub.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { scriptedPhoneModel, type Intent, type ScriptedPhoneModel } from "./fixtures/phone-model.js";

const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const OBSERVED = path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json");
const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);
const PASSWORD = "Fake-Pass-1234";
const PKG = "com.example.shop";

/** A pretend Android toolchain, so the platform believes it can run phone tests (the runner itself is the stand-in). */
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
let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};

/** The model the next job gets. */
let model: LlmClient = createLlmClientOrUnavailable(loadConfig({ DATA_DIR: os.tmpdir() }));
let stateCount = 0;
/** A fresh mock app for the next exploration (the fake keeps the app's state in a file). */
const freshPhone = (faults = "") => {
    setEnv({ AITP_FAKE_STATE: path.join(tmp, `phone-state-${++stateCount}.json`), AITP_FAKE_FAULTS: faults || undefined });
    return process.env.AITP_FAKE_STATE!;
};
const appState = (file: string) => (JSON.parse(fs.readFileSync(file, "utf8")) as { app?: { deleted?: boolean; paid?: boolean; loggedIn?: boolean; cart: number[] }; taps: number[][] }).app;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mobile-explore-"));
    setEnv({ ...fakeToolchain(tmp), MOBILE_RUNNER_CLI: FAKE_CLI, AITP_ADB_PATH: FAKE_ADB, AITP_FAKE_APP: "shop", AITP_FAKE_DEVICES: "emulator", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_API_KEY: "" });
    dataDir = path.join(tmp, "data");
    // This file covers the AI-led explorer (PHONE_EXPLORER=ai); the map explorer is covered in tests/phone-explore-map-*.test.ts.
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MOBILE_KEEP_EMULATOR: "true", SECRET_KEY: "test-secret-key-0123456789", PHONE_EXPLORER: "ai" }));
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
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers?: Record<string, string>) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function finished(jobId: string): Promise<any> {
    for (let i = 0; i < 1200; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (DONE.includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("job did not finish");
}
const newProject = async (name: string, mobile: Record<string, unknown> | null = { appPackage: PKG }) => {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    if (mobile) expect((await call("PUT", `/api/projects/${id}/mobile-app`, mobile)).status).toBe(200);
    return id;
};
const eventsOf = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; message: string; level?: string }>;
const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; title: string; validationStatus: string; validationReason: string | null; kind: string }>;

/** What the model does on the shop: refuse-bait first, sign in, walk the products, leave the app through the terms link, look at the cart. */
const shopTour = (): Intent[] => [
    { tap: "Delete account" },
    { tap: "Sign in" },
    { type: "Username", text: "tester" },
    { type: "Password", text: "hunter2" },
    { tap: "Log in" },
    { tap: "Products" },
    { tap: "Product 1" },
    { back: true },
    { back: true },
    { tap: "Terms and conditions" },
    { tap: "Cart" },
    { tap: "Check out" },
    { finish: true },
];

async function explorePlan(projectId: string, script: Intent[], body: Record<string, unknown> = {}, o: { faults?: string } = {}) {
    const state = freshPhone(o.faults);
    const llm = scriptedPhoneModel(script);
    model = llm;
    const started = await call("POST", `/api/projects/${projectId}/test-generation`, { targets: ["mobile"], plan: true, credentials: { username: "tester", password: PASSWORD }, ...body });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const job = await finished(started.body.jobId);
    return { jobId: started.body.jobId as string, job, state, llm };
}

// ── the journey ───────────────────────────────────────────────────────────────

describe("explore a phone app, approve the plan, create and run the tests", () => {
    let projectId: string;
    let planJob: string;
    let plan: any;
    let planState: string;
    let planModel: ScriptedPhoneModel;
    let watched: { note: string; type: string; url: string; title: string } | undefined;
    const accepted0 = frameHub.accepted;

    it("explores the shop app on the fake phone, skips what looks destructive or paid, and keeps a plan", async () => {
        projectId = await newProject("Shop app");
        const state = freshPhone();
        planModel = scriptedPhoneModel(shopTour());
        model = planModel;
        const started = await call("POST", `/api/projects/${projectId}/test-generation`, { targets: ["mobile"], plan: true, credentials: { username: "tester", password: PASSWORD } });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        expect(started.body.plan).toBe(true);
        planJob = started.body.jobId;
        // Somebody watches while it explores: reading the picture is what asks for pictures.
        for (let i = 0; i < 400 && !watched; i++) {
            const job = (await call("GET", `/api/test-generation/${planJob}`)).body;
            if (DONE.includes(job.status)) break;
            const f = (await call("GET", `/api/projects/${projectId}/jobs/${planJob}/frame`)).body;
            if (f.available === true && f.imageBase64) {
                const jpeg = Buffer.from(f.imageBase64 as string, "base64");
                expect(jpeg[0]).toBe(0xff);
                expect(jpeg[1]).toBe(0xd8);
                watched = { note: f.note, type: f.mime, url: f.url, title: f.title };
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        const job = await finished(planJob);
        expect(job.status, job.error ?? "").toBe("COMPLETED");
        planState = state;

        // The phone was left as a person would leave it: the destructive and the payment screens were never entered or confirmed.
        const app = appState(state)!;
        expect(app.deleted).toBeFalsy();
        expect(app.paid).toBeFalsy();
        expect(app.loggedIn).toBe(true);
        // Nothing was created by an exploration that stops at a plan.
        expect(await testsOf(projectId)).toEqual([]);
    }, 240_000);

    it("showed a picture of the phone and a plain line about what it had just done, only while watched", () => {
        expect(watched, "no picture arrived while the job was exploring").toBeTruthy();
        expect(watched!.type).toBe("image/jpeg");
        expect(watched!.url).toBe(`android-app://${PKG}`);
        expect(watched!.note).toMatch(/^(Opened|Tapped|Went back|Typed|Answered|Scrolled|Opened the app)/);
        expect(frameHub.accepted).toBeGreaterThan(accepted0);
    });

    it("records in plain words what it skipped and why, and handled the permission question and the other app", async () => {
        const events = await eventsOf(planJob);
        const skipped = events.filter((e) => e.kind === "mobile_action_skipped").map((e) => e.message);
        expect(skipped).toContain("Skipped “Delete account” because it looks destructive");
        expect(skipped).toContain("Skipped “Check out” because it looks like a payment or purchase");
        // Answering a permission question and coming back from another app are noted, but are not "skipped".
        const notes = events.filter((e) => e.kind === "mobile_note").map((e) => e.message);
        expect(notes.some((m) => /permission question with “Don't allow”/.test(m))).toBe(true);
        expect(notes.some((m) => /left the app/i.test(m))).toBe(true);
        expect(skipped.every((m) => /^Skipped /.test(m))).toBe(true);
        expect(events.some((e) => e.kind === "plan_ready")).toBe(true);
        expect(events.some((e) => e.kind === "mobile_screen_found")).toBe(true);
    });

    it("answers the plan: screens found, test ideas with their path, counts per family that add up", async () => {
        const r = await call("GET", `/api/projects/${projectId}/plans/${planJob}`);
        expect(r.status).toBe(200);
        plan = r.body;
        expect(plan.ready).toBe(true);
        expect(plan.targets).toEqual(["mobile"]);
        expect(plan.url).toBe(`android-app://${PKG}`);
        expect(plan.found.screens).toBeGreaterThanOrEqual(5);
        expect(plan.phone.appName).toBe("Shop");
        const screenTitles = plan.phone.screens.map((s: { title: string }) => s.title);
        expect(screenTitles).toEqual(expect.arrayContaining(["Shop", "Products", "Sign in", "Cart"]));
        expect(plan.phone.ideas.length).toBeGreaterThanOrEqual(6);
        for (const i of plan.phone.ideas) {
            expect(i.id).toMatch(/^M-\d+$/);
            expect(i.path.length).toBeGreaterThan(0);
            expect(i.goal.length).toBeGreaterThan(5);
        }
        expect(plan.phone.ideas.some((i: { family: string }) => i.family === "signIn")).toBe(true);
        expect(plan.phone.skipped.map((s: { message: string }) => s.message)).toContain("Skipped “Delete account” because it looks destructive");
        expect(plan.phone.signInNeeded).toBe(false);
        expect(plan.phone.signedIn).toBe(true);
        // The ideas are also the plan's test ideas, so the same routes can leave some out.
        expect(plan.ideas.map((i: { id: string }) => i.id)).toEqual(plan.phone.ideas.map((i: { id: string }) => i.id));
        const phoneFamilies = plan.families.filter((f: { needs: string }) => f.needs === "mobile");
        expect(phoneFamilies.length).toBeGreaterThan(2);
        expect(phoneFamilies.reduce((n: number, f: { effective: number }) => n + f.effective, 0)).toBe(plan.phone.ideas.length);
        expect(plan.total).toBe(plan.phone.ideas.length);
        // The web and API families are not counted for a phone-only plan.
        expect(plan.families.every((f: { needs: string }) => f.needs === "mobile")).toBe(true);
        expect(plan.warnings).toEqual([]);
    });

    it("counts every AI call of the exploration in the job's usage", async () => {
        const u = (await call("GET", `/api/jobs/${planJob}/usage`)).body;
        expect(u.totals.calls).toBe(planModel.calls);
        expect(u.totals.calls).toBeGreaterThan(8);
        expect(u.totals.calls).toBeLessThanOrEqual(100);
        expect(JSON.stringify(u.byPurpose)).toContain("planning");
        expect(u.stop).toBeNull();
    });

    it("lists the plan's ideas by what the exploration really saw, in the model's words", () => {
        const wordedPrompts = planModel.plans;
        expect(wordedPrompts).toHaveLength(1);
        expect(wordedPrompts[0]).toContain("Candidates (the exploration really did each of these)");
        expect(wordedPrompts[0]).not.toContain(PASSWORD);
    });

    it("creates exactly the planned tests, minus the idea left out, and runs them on the phone stand-in", async () => {
        const leave = plan.phone.ideas.find((i: { family: string }) => i.family === "back" || i.family === "lists" || i.family === "navigation").id as string;
        const expected = plan.phone.ideas.filter((i: { id: string }) => i.id !== leave);
        const created = await call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, { excludeIdeas: [leave] });
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        // The model is not asked again: creating from a plan explores nothing.
        const callsBefore = planModel.calls;
        const job = await finished(created.body.jobId);
        expect(planModel.calls).toBe(callsBefore);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const tests = await testsOf(projectId);
        expect(tests).toHaveLength(expected.length);
        expect(tests.every((t) => t.kind === "mobile" && /^MOB-\d{3}$/.test(t.testId))).toBe(true);
        expect(tests.map((t) => t.title).sort()).toEqual(expected.map((i: { title: string }) => i.title).sort());
        // They really ran, through the existing phone runner, and passed.
        for (const t of tests) expect(t.validationStatus, `${t.testId} ${t.validationReason ?? ""}`).toBe("VALIDATED");
        expect(job.status).toBe("COMPLETED");
        // Counts per family in the plan are the counts of what was created (the same function made both).
        const detailTags = await Promise.all(tests.map(async (t) => ((await call("GET", `/api/tests/${t.id}`)).body.spec.tags as string[])));
        for (const f of plan.families as Array<{ id: string; label: string; effective: number }>) {
            const inFamily = expected.filter((i: { familyLabel: string }) => i.familyLabel === f.label).length;
            expect(inFamily, f.label).toBe(f.effective - plan.phone.ideas.filter((i: { id: string; familyLabel: string }) => i.id === leave && i.familyLabel === f.label).length);
        }
        const tagCount = (tag: string) => detailTags.filter((t) => t.includes(tag)).length;
        expect(tagCount("ai-explored")).toBe(expected.length);
        expect(tagCount("signIn")).toBe(expected.filter((i: { family: string }) => i.family === "signIn").length);
        expect(job.testsGenerated).toBe(expected.length);
        expect(job.testsValidated).toBe(expected.length);
        const seen = JSON.parse(fs.readFileSync(OBSERVED, "utf8")) as { env: Record<string, string> };
        expect(seen.env.MOBILE_APP_PACKAGE).toBe(PKG);
        // The test account reaches the test run through its environment (never through a script).
        expect(seen.env.TEST_USERNAME).toBe("tester");

        // Each test renders with the Taqwright generator and carries where it came from.
        const signIn = tests.find((t) => /Sign in/.test(t.title))!;
        const detail = (await call("GET", `/api/tests/${signIn.id}`)).body;
        expect(detail.spec.kind).toBe("mobile");
        expect(detail.spec.source.origin).toBe("exploration");
        expect(detail.spec.source.journey).toContain("→");
        expect(detail.generationMeta.phone.path.length).toBeGreaterThan(1);
        const script = detail.scripts.find((s: { framework: string }) => s.framework === "taqwright").content as string;
        expect(script).toContain('from "@taqwright/taqwright"');
        expect(script).toContain("mobile.getByTestId(");
        expect(script).toContain("process.env.TEST_PASSWORD");
        expect(detail.executions[0].status).toBe("passed");
    }, 240_000);

    it("never keeps the real password: not in events, plan, tests, scripts, the model's prompts or anything stored on the platform", async () => {
        const events = JSON.stringify(await eventsOf(planJob));
        const all = JSON.stringify(plan) + events + planModel.turns.join("\n") + planModel.plans.join("\n");
        expect(all).not.toContain(PASSWORD);
        const tests = await testsOf(projectId);
        for (const t of tests) {
            const detail = JSON.stringify((await call("GET", `/api/tests/${t.id}`)).body);
            expect(detail).not.toContain(PASSWORD);
        }
        const hits: string[] = [];
        const scan = (dir: string) => {
            for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, f.name);
                if (f.isDirectory()) scan(full);
                else if (fs.readFileSync(full).includes(PASSWORD)) hits.push(path.relative(dataDir, full));
            }
        };
        scan(dataDir);
        expect(hits).toEqual([]);
        // On the phone the real password was typed (that is the point), by the session, on the machine that owns the phone.
        expect(fs.readFileSync(planState, "utf8")).toContain("tester");
    });

    it("takes the stored plan once only, and another project cannot see the job or the plan", async () => {
        const again = await call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, {});
        expect(again.status).toBe(409);
        const other = await newProject("Another project");
        expect((await call("GET", `/api/projects/${other}/plans/${planJob}`)).status).toBe(404);
        expect((await call("GET", `/api/projects/${other}/jobs/${planJob}/frame`)).status).toBe(404);
        expect((await call("POST", `/api/projects/${other}/plans/${planJob}/create`, {})).status).toBe(404);
    });
});

describe("a plan approved when no phone can run the tests", () => {
    it("writes the tests, keeps them as not run with the reason, and never reports them as passing", async () => {
        const project = await newProject("No runner later");
        const { jobId } = await explorePlan(project, shopTour());
        const toolchain = process.env.TAQWRIGHT_HOME;
        setEnv({ TAQWRIGHT_HOME: path.join(tmp, "nowhere") });
        try {
            const created = await call("POST", `/api/projects/${project}/plans/${jobId}/create`, {});
            expect(created.status, JSON.stringify(created.body)).toBe(202);
            const job = await finished(created.body.jobId);
            expect(job.status).toBe("PARTIALLY_COMPLETED");
            expect(job.error).toMatch(/were not run: .*taqwright install/);
            const tests = await testsOf(project);
            expect(tests.length).toBeGreaterThan(3);
            expect(tests.every((t) => t.validationStatus === "PENDING")).toBe(true);
            expect(job.testsValidated).toBe(0);
        } finally {
            setEnv({ TAQWRIGHT_HOME: toolchain });
        }
    }, 240_000);
});

describe("what the AI refuses, whatever a screen says", () => {
    it("does not follow a hostile screen, and no picture is made while nobody watches", async () => {
        const project = await newProject("Hostile");
        const before = frameHub.accepted;
        // The model is fooled by the line on the home screen and asks for the delete button by every name it can see.
        const { job, jobId, state, llm } = await explorePlan(project, [{ tap: "Delete my account" }, { tap: "Delete account" }, { tap: "Sign in" }, { tap: "Products" }, { finish: true }], {}, { faults: "hostile" });
        expect(job.status, job.error ?? "").toBe("COMPLETED");
        // The person is told the screen carried text meant for the AI, and that it was left out.
        expect((await eventsOf(jobId)).some((e) => e.kind === "mobile_hostile_text" && e.level === "warn")).toBe(true);
        expect(appState(state)!.deleted).toBeFalsy();
        expect(llm.turns.length).toBeGreaterThan(2);
        expect(llm.turns.every((p) => !/ignore previous instructions/i.test(p))).toBe(true);
        expect(frameHub.accepted).toBe(before);
    }, 240_000);

    it("leaves the sign-in screen alone when no test account was given, and says so in the plan", async () => {
        const project = await newProject("No account");
        const state = freshPhone();
        model = scriptedPhoneModel([{ tap: "Sign in" }, { type: "Username" }, { type: "Password" }, { back: true }, { tap: "Products" }, { finish: true }]);
        const started = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["mobile"], plan: true });
        expect(started.status).toBe(202);
        const job = await finished(started.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const plan = (await call("GET", `/api/projects/${project}/plans/${started.body.jobId}`)).body;
        expect(plan.phone.signInNeeded).toBe(true);
        expect(plan.warnings.join(" ")).toMatch(/no test account was given/i);
        expect(plan.phone.ideas.some((i: { usesSignIn: boolean }) => i.usesSignIn)).toBe(false);
        expect((JSON.parse(fs.readFileSync(state, "utf8")) as { typed: unknown[] }).typed).toEqual([]);
    }, 240_000);
});

describe("stopping and failing", () => {
    it("a reached AI limit ends the exploration with what it has seen, in the limit's own words", async () => {
        const project = await newProject("Capped");
        // The stand-in model counts 15 tokens a call; the job may use 60.
        expect((await call("PUT", `/api/projects/${project}/usage-budget`, { jobTokens: 60 })).status).toBe(200);
        const { job, jobId } = await explorePlan(project, shopTour());
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const plan = (await call("GET", `/api/projects/${project}/plans/${jobId}`)).body;
        expect(plan.ready).toBe(true);
        expect(plan.phone.ideas.length).toBeGreaterThan(0);
        expect(plan.phone.ideas[0].family).toBe("start");
        expect(plan.warnings.join(" ")).toMatch(/limit/i);
        expect(plan.phone.stats.stoppedBecause).toMatch(/limit/i);
        const usage = (await call("GET", `/api/jobs/${jobId}/usage`)).body;
        expect(usage.stop).toBeTruthy();
        expect(usage.totals.calls).toBeLessThanOrEqual(6);
    }, 240_000);

    it("Stop ends the exploration, keeps what exists and creates nothing", async () => {
        const project = await newProject("Stop");
        // A test that was already there is not touched by an exploration that is stopped.
        const imported = await call("POST", `/api/projects/${project}/specs`, { validate: false, specs: [{ title: "An imported phone test", kind: "mobile", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Shop" } }] }] });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        const before = await testsOf(project);
        expect(before).toHaveLength(1);
        freshPhone();
        model = scriptedPhoneModel(Array.from({ length: 120 }, (_, i) => (i % 2 ? { back: true as const } : { tap: "Products" })));
        const started = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["mobile"], plan: true });
        expect(started.status).toBe(202);
        for (let i = 0; i < 200; i++) {
            if ((await eventsOf(started.body.jobId)).some((e) => e.kind === "mobile_started")) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        expect((await call("DELETE", `/api/test-generation/${started.body.jobId}`)).status).toBe(202);
        const job = await finished(started.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe("Cancelled");
        expect(await testsOf(project)).toEqual(before);
        expect((await call("GET", `/api/projects/${project}/plans/${started.body.jobId}`)).status).toBe(409);
    }, 120_000);

    it("says plainly when the AI model is not set up, and never makes up a pass", async () => {
        const project = await newProject("No model");
        freshPhone();
        model = createLlmClientOrUnavailable(loadConfig({ DATA_DIR: os.tmpdir(), LLM_PROVIDER: "anthropic" }));
        const started = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["mobile"], plan: true });
        expect(started.status).toBe(202);
        const job = await finished(started.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe("Phone exploration needs the AI model. Set it up in Settings, then explore again.");
        expect(await testsOf(project)).toEqual([]);
        expect((await call("GET", "/api/config")).body.phoneExploration.thisServer).toEqual({ canExplore: true, reason: null });
    }, 60_000);
});

describe("refusals before a job is queued", () => {
    it("a project with no phone app, or an APK only, is told what to add", async () => {
        const none = await newProject("No app", null);
        const r1 = await call("POST", `/api/projects/${none}/test-generation`, { targets: ["mobile"], plan: true });
        expect(r1.status).toBe(422);
        expect(r1.body.error).toBe("This project has no mobile app set up. Add an app package or an APK first.");
        const noPackage = await newProject("Only a Windows-style address", null);
        expect((await call("PUT", `/api/projects/${noPackage}/mobile-app`, { iosBundleId: "com.example.Shop" })).status).toBe(200);
        const r2 = await call("POST", `/api/projects/${noPackage}/test-generation`, { targets: ["mobile"], plan: true });
        expect(r2.status).toBe(422);
        expect(r2.body.error).toMatch(/package name/);
    });
    it("a computer with no Android tools says so", async () => {
        const project = await newProject("No tools");
        const toolchain = process.env.TAQWRIGHT_HOME;
        setEnv({ AITP_ADB_PATH: undefined, ANDROID_HOME: "", TAQWRIGHT_HOME: path.join(tmp, "nowhere") });
        try {
            const r = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["mobile"], plan: true });
            expect(r.status).toBe(409);
            expect(r.body.error).toMatch(/no Android tools/i);
            expect(await testsOf(project)).toEqual([]);
        } finally {
            setEnv({ AITP_ADB_PATH: FAKE_ADB, TAQWRIGHT_HOME: toolchain });
        }
    });
    it("another job in the project must finish first", async () => {
        const project = await newProject("Busy");
        freshPhone();
        model = scriptedPhoneModel(Array.from({ length: 120 }, (_, i) => (i % 2 ? { back: true as const } : { tap: "Products" })));
        const first = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["mobile"], plan: true });
        expect(first.status).toBe(202);
        const second = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["mobile"], plan: true });
        expect(second.status).toBe(409);
        await call("DELETE", `/api/test-generation/${first.body.jobId}`);
        await finished(first.body.jobId);
    }, 120_000);
    it("a website address is still required when the phone is not the only target", async () => {
        const project = await newProject("Both");
        const r = await call("POST", `/api/projects/${project}/test-generation`, { targets: ["web", "mobile"], plan: true });
        expect(r.status).toBe(400);
    });
    it("is protected by the API key like every route", async () => {
        const dir = path.join(tmp, "keyed");
        const keyed = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", API_KEY: "a-long-test-api-key-0123456789", SECRET_KEY: "test-secret-key-0123456789" }));
        const s = await buildServer(keyed);
        try {
            const id = (await s.inject({ method: "POST", url: "/api/projects", payload: { name: "k" }, headers: { "x-api-key": "a-long-test-api-key-0123456789" } })).json().id as string;
            const refused = await s.inject({ method: "POST", url: `/api/projects/${id}/test-generation`, payload: { targets: ["mobile"], plan: true } });
            expect(refused.statusCode).toBe(401);
            expect((await s.inject({ method: "GET", url: `/api/projects/${id}/plans/x` })).statusCode).toBe(401);
        } finally {
            await s.close();
            keyed.db.close();
        }
    });
});
