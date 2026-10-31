/**
 * AI phone tests, the screens against the REAL platform (MX-C, the journey that needs MX-A and MX-B): a person starts the exploration from the panel,
 * watches the phone, reads and edits the plan, creates the tests, and finds them in the Tests list. Underneath: the real server and worker, the real local
 * device session, the FAKE adb (tests/fixtures/fake-adb.mjs, a mock shop app: no emulator, no phone, no adb server), a scripted model (never a real one),
 * and the Taqwright stand-in for running the created tests. Nothing real is started.
 *
 * Skipped, with the reason printed, while the platform side is missing (the fake adb, the scripted model or the phone exploration route).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-ai-real.test.ts
 * Port: platform and UI 6691.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { createLlmClientOrUnavailable, type LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { frameHub } from "../src/platform/frame-hub.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6691;
const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const PHONE_MODEL = path.join(REPO_ROOT, "tests/fixtures/phone-model.ts");
const ROUTE = path.join(REPO_ROOT, "src/platform/phone-explore.ts");
const SHOTS = path.join(REPO_ROOT, ".scratch", "phone-ai", "shots");
const PASSWORD = "Fake-Pass-1234";
const PKG = "com.example.shop";

// What must exist before this journey can run. Said plainly when it does not.
const missing = [FAKE_ADB, PHONE_MODEL, ROUTE, path.join(REPO_ROOT, "web/dist/index.html")].filter((f) => !fs.existsSync(f)).map((f) => path.relative(REPO_ROOT, f));
if (missing.length) console.warn(`phone-ai-real: skipped, these are not there yet: ${missing.join(", ")}`);

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};

describe.skipIf(missing.length > 0)("the screens on the real platform with a fake phone", () => {
    let tmp: string;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let browser: Browser;
    let page: Page;
    let model: LlmClient;
    let projectId = "";
    const consoleErrors: string[] = [];
    let stateCount = 0;
    const base = `http://127.0.0.1:${PORT}`;

    const api = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(`${base}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
    };
    const dialog = () => page.getByRole("dialog", { name: "Explore the phone app (AI)", exact: true });
    const shot = async (name: string) => {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };

    beforeAll(async () => {
        const { scriptedPhoneModel } = await import("./fixtures/phone-model.js");
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-real-"));
        setEnv({ ...fakeToolchain(tmp), MOBILE_RUNNER_CLI: FAKE_CLI, AITP_ADB_PATH: FAKE_ADB, AITP_FAKE_APP: "shop", AITP_FAKE_DEVICES: "emulator", AITP_FAKE_STATE: path.join(tmp, `phone-state-${++stateCount}.json`), // A placeholder key only makes the platform report the AI model as set up (so the panel offers Start); the model every job gets is the scripted double below and nothing is ever sent.
        ANTHROPIC_API_KEY: "not-a-real-key-scripted-model-only", OPENAI_API_KEY: "", LLM_API_KEY: "" });
        model = createLlmClientOrUnavailable(loadConfig({ DATA_DIR: os.tmpdir() }));
        platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MOBILE_KEEP_EMULATOR: "true", SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
        server = await buildServer(platform);
        await server.listen({ port: PORT, host: "127.0.0.1" });
        frameHub.markLocal();
        worker = new Worker({ ...platform, makeLlm: () => model }, 100);
        worker.start();
        // The model the exploration gets: the tour of the shop app, slowed a little so that a person (and this test) can watch.
        const tour = scriptedPhoneModel([{ tap: "Delete account" }, { tap: "Sign in" }, { type: "Username", text: "tester" }, { type: "Password", text: "hunter2" }, { tap: "Log in" }, { tap: "Products" }, { tap: "Product 1" }, { back: true }, { back: true }, { tap: "Cart" }, { tap: "Check out" }, { finish: true }]);
        const object = tour.object.bind(tour);
        tour.object = (async (...a: Parameters<LlmClient["object"]>) => {
            await sleep(400);
            return object(...a);
        }) as LlmClient["object"];
        model = tour;
        browser = await chromium.launch();
        page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
        page.on("console", (m) => {
            if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
        });
        page.on("pageerror", (e) => consoleErrors.push(String(e)));
    }, 90_000);

    afterAll(async () => {
        await browser?.close();
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("starts the exploration from the panel: this server is offered, a test account is typed, and a plan-only job is queued", async () => {
        projectId = (await api("POST", "/api/projects", { name: "Shop app" })).body.id;
        expect((await api("PUT", `/api/projects/${projectId}/mobile-app`, { appPackage: PKG })).status).toBe(200);
        await page.goto(`${base}/#/projects/${projectId}/setup?section=mobile`);
        await pwExpect(page.getByTestId("setting-mobile")).toContainText(`Phone tests use ${PKG}. The AI can explore it and plan tests.`);
        await page.evaluate(() => localStorage.setItem("aitp.explorer.watch", "1"));
        await page.getByRole("button", { name: "Explore with AI", exact: true }).click();
        await pwExpect(dialog()).toBeVisible();
        // The platform really can: the fake toolchain makes this server a place the AI can use.
        await pwExpect(dialog().getByRole("radio", { name: /This server/ })).toBeChecked();
        await dialog().locator("summary", { hasText: "Advanced options" }).click();
        await dialog().getByLabel("Username or email").fill("tester");
        await dialog().getByLabel("Password").fill(PASSWORD);
        await shot("real-start-light-1280");
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${projectId}$`));
        const jobs = (await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ planOnly?: boolean }>;
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.planOnly).toBe(true);
    }, 60_000);

    it("shows the phone while it explores: a real picture, the app and screen, what it did, the screens found and what it left alone", async () => {
        await pwExpect(page.getByRole("heading", { name: "Exploring your phone app", exact: true })).toBeVisible({ timeout: 30_000 });
        // The switch was left on in this browser: the picture appears as soon as the platform has one.
        const panel = page.getByRole("region", { name: "Explorer view", exact: true });
        await pwExpect(panel.getByTestId("explorer-image")).toBeVisible({ timeout: 60_000 });
        const src = await panel.getByTestId("explorer-image").getAttribute("src");
        expect(src).toMatch(/^data:image\/jpeg;base64,/);
        await pwExpect(panel.getByTestId("explorer-app")).toHaveText(PKG);
        await pwExpect(panel.getByTestId("explorer-note")).toHaveText(/^(Opened|Tapped|Went back|Typed|Answered|Scrolled)/);
        await shot("real-explorer-light-1280");
        // The platform names what it found and what it left alone; both appear under the steps.
        await pwExpect(page.getByTestId("phone-counts")).toHaveText(/^\d+ screens? seen/, { timeout: 60_000 });
        await pwExpect(page.getByTestId("phone-skipped")).toContainText("Skipped “Delete account” because it looks destructive", { timeout: 60_000 });
        // And the person can see all of it without a sideways scroll or a contrast problem.
        const result = await new AxeBuilder({ page }).analyze();
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }, 120_000);

    it("ends at a plan in phone words, with the screens found, the ideas and their paths, and nothing created", async () => {
        const box = page.getByTestId("plan-preview");
        await pwExpect(box).toBeVisible({ timeout: 180_000 });
        await pwExpect(page.getByTestId("plan-found")).toHaveText(/^We found \d+ screens/);
        const sentence = (await page.getByTestId("plan-sentence").textContent())!;
        expect(sentence).toMatch(/^We will create about \d+ phone tests: /);
        expect((await api("GET", `/api/projects/${projectId}/tests`)).body).toEqual([]);
        const planned = Number(/about (\d+) phone test/.exec(sentence)![1]);
        // It must agree with the platform's own total.
        const jobId = ((await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string }>)[0]!.jobId;
        const plan = (await api("GET", `/api/projects/${projectId}/plans/${jobId}`)).body;
        expect(planned).toBe(plan.total);
        await box.locator("summary", { hasText: /^What we found/ }).click();
        await pwExpect(page.getByTestId("plan-screens").locator("li").first()).toBeVisible();
        await box.locator("summary", { hasText: /^What the AI left alone/ }).click();
        await pwExpect(box.getByTestId("phone-skipped")).toContainText("Skipped “Delete account” because it looks destructive");
        await shot("real-plan-light-1280");
        // Leave one idea out: the sentence and the platform agree on one test less.
        await box.locator("summary", { hasText: "Edit the plan" }).click();
        await pwExpect(box.getByTestId("idea-path").first()).toContainText("Path: ");
        await box.getByRole("list", { name: /^Test ideas/ }).first().getByRole("checkbox").first().uncheck();
        await pwExpect(page.getByTestId("plan-sentence")).toContainText(`about ${planned - 1} phone test`);
        await shot("real-plan-edit-light-1280");
    }, 240_000);

    it("creates what the plan said, minus the idea left out, and the Tests list shows them as phone tests of the app", async () => {
        await page.getByRole("button", { name: "Create the tests", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Creating your tests", exact: true })).toBeVisible({ timeout: 30_000 });
        await pwExpect(page.getByTestId("created-tests")).toBeVisible();
        // The platform finishes the job (they run on the stand-in for the phone runner).
        for (let i = 0; i < 480; i++) {
            const job = ((await api("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string; fromPlan?: string }>).find((j) => j.fromPlan);
            if (job && ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
            await sleep(250);
        }
        const tests = (await api("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; kind: string; validationStatus: string }>;
        expect(tests.length).toBeGreaterThan(2);
        expect(tests.every((t) => t.kind === "mobile")).toBe(true);
        await page.goto(`${base}/#/projects/${projectId}/tests`);
        const first = page.getByRole("link", { name: new RegExp(tests[0]!.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
        await pwExpect(first).toBeVisible();
        await pwExpect(first).toContainText(`Phone, ${PKG}`);
        expect(await first.textContent()).not.toMatch(/Mobile/);
        await shot("real-tests-light-1280");
        // A test says where it came from, with the screens it goes through.
        await first.click();
        await pwExpect(page.getByTestId("origin-line")).toContainText("Created by exploring the Android app", { timeout: 15_000 });
        await pwExpect(page.getByTestId("origin-line")).toContainText("path: ");
        await shot("real-test-origin-light-1280");
    }, 300_000);

    it("never shows the real password anywhere on the pages it visited, and the browser reported no error", async () => {
        for (const hash of [`#/projects/${projectId}`, `#/projects/${projectId}/tests`, `#/projects/${projectId}/setup?section=mobile`]) {
            await page.goto(`${base}/${hash}`);
            await page.waitForTimeout(500);
            expect(await page.content()).not.toContain(PASSWORD);
        }
        expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(PASSWORD);
        expect(consoleErrors).toEqual([]);
    });

    it("Stop exploring while it is going keeps what was there and says so", async () => {
        // A second project, a slower tour, and a person who changes their mind.
        const { scriptedPhoneModel } = await import("./fixtures/phone-model.js");
        const slow = scriptedPhoneModel([{ tap: "Sign in" }, { back: true }, { tap: "Products" }, { back: true }, { tap: "Cart" }, { back: true }, { tap: "Sign in" }, { back: true }, { finish: true }]);
        const object = slow.object.bind(slow);
        slow.object = (async (...a: Parameters<LlmClient["object"]>) => {
            await sleep(1500);
            return object(...a);
        }) as LlmClient["object"];
        model = slow;
        process.env.AITP_FAKE_STATE = path.join(tmp, `phone-state-${++stateCount}.json`);
        const other = (await api("POST", "/api/projects", { name: "Second shop" })).body.id as string;
        await api("PUT", `/api/projects/${other}/mobile-app`, { appPackage: PKG });
        await page.goto(`${base}/#/projects/${other}/setup?section=mobile&start=phone`);
        await pwExpect(dialog()).toBeVisible();
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        const panel = page.getByRole("region", { name: "Explorer view", exact: true });
        await pwExpect(panel.getByTestId("explorer-image")).toBeVisible({ timeout: 60_000 });
        await panel.getByRole("button", { name: "Stop exploring", exact: true }).click();
        const ask = page.getByRole("dialog", { name: "Stop exploring?", exact: true });
        await pwExpect(ask).toBeVisible();
        await ask.getByRole("button", { name: "Stop exploring", exact: true }).click();
        await pwExpect(page.getByText("Exploring was stopped", { exact: true })).toBeVisible({ timeout: 60_000 });
        await pwExpect(page.getByTestId("explorer-finished")).toHaveText(/^Exploration stopped: \d+ screens? seen$/);
        expect((await api("GET", `/api/projects/${other}/tests`)).body).toEqual([]);
        await pwExpect(page.getByRole("link", { name: "Explore again", exact: true }).first()).toHaveAttribute("href", `#/projects/${other}/setup?section=mobile&start=phone`);
    }, 180_000);
});
