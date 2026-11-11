/**
 * Runs that go only to runners (EXECUTION_MODE=runners, the hosted platform), round 45: one runner per person, set up in Settings and
 * used for every run they start. In a real browser against a real platform: the Run panel offers no runner to choose and sends no
 * `runnerId`; it reads `GET /api/me/runner` and says before the click when the person's runner is not set up, is offline, or has code
 * scripts off, linking to Your runner in Settings; the line under the header, the test page's Run button, a suite's Run and the
 * Schedules panel follow the same answer; a refusal from the server shows its sentence with the link it carries. Also the pure rules.
 *
 * Stand-ins (browser routes, no runner and no worker here): `/api/config` gains `executionMode`, `GET /api/me/runner` answers the
 * contract's shape, and run starts are recorded and answered 202 (or refused). Everything else is the real platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs web-build -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/run-on-runner-ui.test.ts
 * Ports: platform 8780.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { whereOptions } from "../web/src/features/phone/phone.js";
import { EXPLORING_ON_RUNNERS_MESSAGE, PLAIN_ON_RUNNERS_MESSAGE } from "../src/platform/runner-only.js";
import { codeScriptsNotice, EXPLORING_ON_RUNNERS, executionModeOf, PLAIN_ON_RUNNERS, readiness, DISPATCH_OFF, RUNS_OFF_TIP } from "../web/src/features/runs/runs-here.js";
import { isRunnerRefusal, refusalLink, runnerProblem, runsOnSentence, RUNNER_CODE_OFF, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, type RunnerMine } from "../web/src/features/runners/my-runner.js";
import { ApiError } from "../web/src/api.js";

const PORT = 8780;
const BASE = `http://127.0.0.1:${PORT}`;

const runnerOf = (over: Partial<RunnerMine> = {}): RunnerMine => ({
    id: "tok-mine",
    name: "Priya’s laptop",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    os: "darwin",
    arch: "arm64",
    version: "2.0.0",
    switches: { codeScripts: true, privateTargets: false, realPhone: false },
    ...over,
});
const MINE = runnerOf();
const OFF = runnerOf({ status: "offline", lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() });
const BUSY = runnerOf({ status: "busy" });
const NO_CODE = runnerOf({ switches: { codeScripts: false, privateTargets: false, realPhone: false } });

describe("the rules (no browser)", () => {
    it("says why the person's runner can't take a run, in one sentence, and a busy one still can", () => {
        expect(runnerProblem({ runner: null })).toBe(RUNNER_NOT_SET_UP);
        expect(RUNNER_NOT_SET_UP).toBe("Set up your runner in Settings to run tests.");
        expect(runnerProblem({ runner: OFF })).toBe(RUNNER_OFFLINE);
        expect(RUNNER_OFFLINE).toBe("Your runner is offline. Start it on your computer, then try again.");
        expect(runnerProblem({ runner: BUSY })).toBeNull();
        expect(runnerProblem({ runner: MINE }, { code: true })).toBeNull();
        expect(runnerProblem({ runner: NO_CODE }, { code: true })).toBe(RUNNER_CODE_OFF);
        expect(runnerProblem({ runner: NO_CODE })).toBeNull();
        expect(runnerProblem(undefined)).toBeNull();
        expect(runsOnSentence(BUSY)).toBe("Runs on your runner, Priya’s laptop (busy)");
    });

    it("is ready only with the person's runner connected in runners mode, and as before in local mode", () => {
        const config = { runsHere: true } as never;
        expect(readiness("local", config, { data: undefined, loading: false }).ready).toBe(true);
        expect(readiness("local", { runsHere: false } as never, { data: undefined, loading: false })).toMatchObject({ ready: false, reason: RUNS_OFF_TIP });
        expect(readiness("runners", { runsHere: false } as never, { data: { runner: MINE }, loading: false })).toMatchObject({ ready: false, reason: DISPATCH_OFF });
        expect(readiness("runners", config, { data: undefined, loading: true })).toMatchObject({ ready: false, loading: true });
        expect(readiness("runners", config, { data: { runner: null }, loading: false })).toMatchObject({ ready: false, reason: RUNNER_NOT_SET_UP });
        expect(readiness("runners", config, { data: { runner: OFF }, loading: false })).toMatchObject({ ready: false, reason: RUNNER_OFFLINE });
        expect(readiness("runners", config, { data: { runner: BUSY }, loading: false })).toMatchObject({ ready: true, reason: null });
        expect(executionModeOf({ executionMode: "runners" } as never)).toBe("runners");
        expect(executionModeOf(undefined)).toBe("local");
    });

    it("reads the server's typed refusal and the link it carries", () => {
        const refused = new ApiError(409, "Your runner is offline. Start it on your computer, then try again.", { code: "RUNNER_OFFLINE", link: "#/settings#runner" });
        expect(isRunnerRefusal(refused)).toBe(true);
        expect(refusalLink(refused)).toBe("#/settings#runner");
        // A link that leaves the site is never followed; the runner's Settings stand in.
        expect(refusalLink(new ApiError(409, "x", { code: "RUNNER_CANNOT_RUN", link: "https://elsewhere.example" }))).toBe("#/settings#runner");
        expect(isRunnerRefusal(new ApiError(409, "Job 1 is running", undefined))).toBe(false);
        expect(refusalLink(new ApiError(400, "bad", undefined))).toBeNull();
    });

    it("says who wrote the code scripts that go to your computer, when known, and the platform's own words for refused AI work", () => {
        expect(codeScriptsNotice([])).toBe("This run includes code scripts. They run on your computer with your user’s rights.");
        expect(codeScriptsNotice(["Ana", "Ben", "Chen"])).toBe("This run includes code scripts written by Ana, Ben and Chen. They run on your computer with your user’s rights.");
        expect(EXPLORING_ON_RUNNERS.length).toBeGreaterThan(20);
        expect(PLAIN_ON_RUNNERS).toBe(PLAIN_ON_RUNNERS_MESSAGE);
        expect(typeof EXPLORING_ON_RUNNERS_MESSAGE).toBe("string");
    });

    it("never offers this server for a phone exploration in runners mode", () => {
        const mobile = { available: true, avds: ["Pixel_6"], toolchain: "managed" as const };
        expect(whereOptions({ mobile } as never, []).map((o) => o.id)).toEqual(["platform"]);
        expect(whereOptions({ mobile, executionMode: "runners" } as never, [])).toEqual([]);
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let suiteId: string;
const idOf: Record<string, string> = {};
const consoleErrors: string[] = [];

/** What the stand-ins answer, changed by each test. */
const fake = {
    mode: "runners" as "runners" | "local",
    runsHere: true,
    /** GET /api/me/runner: the person's own runner (null: not set up). */
    mine: null as RunnerMine | null,
    /** The answer a run start gets (null: 202). */
    refuse: null as null | { status: number; json: Record<string, unknown> },
    /** Permissions on the project, when the project's answer should carry them (null: as the platform answers). */
    permissions: null as string[] | null,
    schedules: null as null | { schedulerEnabled: boolean },
    /** Test title the tests list marks as a code script (stand-in for a hand-written script). */
    codeTest: null as string | null,
};
const runStarts: Array<{ url: string; body: Record<string, unknown> | null }> = [];
const runnerPuts: Array<Record<string, unknown>> = [];
const meCalls: string[] = [];

const spec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });
const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-on-runner-ui-"));
    // No worker and no scheduler: nothing is run here. The browser is told runs go to runners (the stand-in config below).
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "run-on-runner-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    projectId = (await api("POST", "/api/projects", { name: "Runner shop" })).body.id;
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { baseUrl: "https://shop.example.test", specs: [spec("Home answers", "/api/home"), spec("Cart answers", "/api/cart")] });
    if (imp.status !== 202 && imp.status !== 201 && imp.status !== 200) throw new Error(JSON.stringify(imp.body));
    for (const t of (await api("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>) idOf[t.title] = t.id;
    const suite = await api("POST", `/api/projects/${projectId}/test-suites`, { name: "Smoke", testIds: Object.values(idOf) });
    if (suite.status >= 300) throw new Error(JSON.stringify(suite.body));
    suiteId = suite.body.id ?? suite.body.suite?.id;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.route("**/api/config", async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), executionMode: fake.mode, runsHere: fake.runsHere } });
    });
    await page.route("**/api/me/runner", (route) => {
        meCalls.push(route.request().method());
        return route.fulfill({ json: { runner: fake.mine } });
    });
    // The old routes must not be asked any more.
    await page.route("**/api/projects/*/runner-choices", (route) => {
        meCalls.push("runner-choices");
        return route.fulfill({ status: 404, json: { error: "gone" } });
    });
    await page.route("**/api/projects/*/runner", async (route) => {
        if (route.request().method() === "PUT") runnerPuts.push(route.request().postDataJSON() as Record<string, unknown>);
        const last = runnerPuts.at(-1);
        const allowPersonal = typeof last?.allowPersonal === "boolean" ? last.allowPersonal : true;
        await route.fulfill({ json: { runOn: "agent", agentId: null, status: "Runs on any connected runner.", canRunWeb: true, canRunMobile: false, unavailableReason: null, allowPersonal } });
    });
    const recordStart = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
        if (route.request().method() !== "POST") return route.continue();
        runStarts.push({ url: new URL(route.request().url()).pathname, body: (route.request().postDataJSON() as Record<string, unknown> | null) ?? null });
        if (fake.refuse) return route.fulfill({ status: fake.refuse.status, json: fake.refuse.json });
        await route.fulfill({ status: 202, json: { jobId: "stand-in-job", testCount: 1, skipped: [] } });
    };
    await page.route("**/api/projects/*/runs", recordStart);
    await page.route("**/api/tests/*/validate", recordStart);
    await page.route("**/api/projects/*/test-suites/*/run", recordStart);
    await page.route(`**/api/projects/${projectId}`, async (route) => {
        if (route.request().method() !== "GET" || !fake.permissions) return route.continue();
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), access: { projectAdmin: false, permissions: fake.permissions } } });
    });
    await page.route(`**/api/projects/*/test-suites/*`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const json = await res.json();
        // Runs can start (the stand-in dispatch is alive): the real platform here has no worker and would say they can't.
        await route.fulfill({ response: res, json: json && typeof json === "object" && "canRun" in json ? { ...json, canRun: fake.runsHere ? { ok: true } : json.canRun } : json });
    });
    await page.route("**/api/projects/*/tests", async (route) => {
        if (route.request().method() !== "GET" || !fake.codeTest) return route.continue();
        const res = await route.fetch();
        const list = (await res.json()) as Array<Record<string, unknown>>;
        await route.fulfill({ response: res, json: list.map((t) => (t.title === fake.codeTest ? { ...t, custom: { since: new Date().toISOString(), origin: "written", canRestoreGenerated: false } } : t)) });
    });
    await page.route("**/api/projects/*/schedules", async (route) => {
        if (route.request().method() !== "GET" || !fake.schedules) return route.continue();
        await route.fulfill({
            json: {
                serverTime: new Date().toISOString(),
                timezone: { name: "UTC", utcOffsetMinutes: 0 },
                schedulerEnabled: fake.schedules.schedulerEnabled,
                schedules: [{ id: "sch-1", name: "Every night", kind: "validate", kindLabel: "Re-run all tests", cadence: { type: "daily", time: "02:00" }, cadenceText: "Every day at 02:00", enabled: true, retryFailures: 0, nextRunAt: new Date(Date.now() + 3_600_000).toISOString(), lastRunAt: null, lastJobId: null, lastOutcome: null, lastOutcomeAt: null, lastNote: null }],
            },
        });
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
};
const scripts = () => visit(`#/projects/${projectId}/scripts`);
const panel = () => page.getByRole("group", { name: "Run settings" });
const openPanel = async () => {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await pwExpect(panel()).toBeVisible();
};
const setMine = (r: RunnerMine | null) => {
    fake.mine = r;
};
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const result = await new AxeBuilder({ page }).analyze();
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

const SETTINGS = "#/settings#runner";

describe("runners mode, runner not set up or offline", () => {
    it("says so under the header and in the Run panel, links to Your runner in Settings, and starts nothing", async () => {
        setMine(null);
        await scripts();
        const line = page.getByTestId("runs-on");
        await pwExpect(line).toContainText(RUNNER_NOT_SET_UP.replace(/\.$/, ""));
        await pwExpect(line.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", SETTINGS);

        await openPanel();
        await pwExpect(panel().getByRole("radio", { name: "This server" })).toHaveCount(0);
        await pwExpect(panel().locator("label.run-opt[data-runner]")).toHaveCount(0);
        const none = panel().getByTestId("no-runner");
        await pwExpect(none).toContainText(RUNNER_NOT_SET_UP);
        await pwExpect(none.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", SETTINGS);
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText(RUNNER_NOT_SET_UP);
        await pwExpect(panel().getByRole("button", { name: "Start run" })).toBeDisabled();
        await axeBoth();
        await panel().getByRole("button", { name: "Close", exact: true }).click();
        expect(runStarts).toEqual([]);
        expect(meCalls).not.toContain("runner-choices");
    }, 120_000);

    it("an offline runner says how to go on, and the test page's Run again waits too", async () => {
        setMine(OFF);
        await scripts();
        await pwExpect(page.getByTestId("runs-on")).toContainText(RUNNER_OFFLINE.replace(/\.$/, ""));
        await openPanel();
        await pwExpect(panel().getByTestId("no-runner")).toContainText(RUNNER_OFFLINE);
        await pwExpect(panel().getByTestId("run-where")).toContainText("Runs on your runner, Priya’s laptop (offline)");
        await page.keyboard.press("Escape");
        await visit(`#/tests/${idOf["Home answers"]}`);
        const again = page.getByRole("button", { name: "Run again", exact: true });
        await pwExpect(again).toBeVisible();
        await pwExpect(again).toBeDisabled();
        expect(runStarts).toEqual([]);
    }, 120_000);
});

describe("runners mode, runner online", () => {
    it("names your runner, offers no choice, and sends no runnerId", async () => {
        setMine(MINE);
        runStarts.length = 0;
        await scripts();
        await pwExpect(page.getByTestId("runs-on")).toContainText("Runs on your runner, Priya’s laptop (online).");
        await pwExpect(page.getByTestId("runs-on").getByRole("link", { name: "Your runner" })).toHaveAttribute("href", SETTINGS);
        await openPanel();
        await pwExpect(panel().getByTestId("no-runner")).toHaveCount(0);
        await pwExpect(panel().getByTestId("run-where")).toHaveText("Runs on your runner, Priya’s laptop (online).");
        await pwExpect(panel().getByRole("radio", { name: /Priya’s laptop/ })).toHaveCount(0);
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("Priya’s laptop");
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect.poll(() => runStarts.length).toBe(1);
        expect(runStarts[0]!.url).toBe(`/api/projects/${projectId}/runs`);
        expect(runStarts[0]!.body ?? {}).not.toHaveProperty("runnerId");
    }, 120_000);

    it("a busy runner still takes the run: it waits", async () => {
        setMine(BUSY);
        await scripts();
        await openPanel();
        await pwExpect(panel().getByTestId("run-where")).toContainText("It is busy with another run: this one waits until it is free.");
        await pwExpect(panel().getByRole("button", { name: "Start run" })).toBeEnabled();
        await page.keyboard.press("Escape");
    }, 120_000);

    it("the test page's Run again starts at once, without a runnerId", async () => {
        setMine(MINE);
        runStarts.length = 0;
        await visit(`#/tests/${idOf["Home answers"]}`);
        const again = page.getByRole("button", { name: "Run again", exact: true });
        await pwExpect(again).toBeEnabled();
        await again.click();
        await pwExpect.poll(() => runStarts.length).toBe(1);
        expect(runStarts[0]!.url).toBe(`/api/tests/${idOf["Home answers"]}/validate`);
        expect(runStarts[0]!.body ?? {}).not.toHaveProperty("runnerId");
    }, 120_000);

    it("a refusal from the server shows its sentence with a link to Settings", async () => {
        setMine(MINE);
        fake.refuse = { status: 409, json: { error: "Your runner cannot run phone tests: no emulator is ready on it.", details: { code: "RUNNER_CANNOT_RUN", link: SETTINGS } } };
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await panel().getByRole("button", { name: "Start run" }).click();
        const err = panel().getByTestId("run-start-error");
        await pwExpect(err).toContainText("Your runner cannot run phone tests: no emulator is ready on it.");
        await pwExpect(err.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", SETTINGS);
        fake.refuse = null;
        await page.keyboard.press("Escape");
    }, 120_000);

    it("fits a phone and passes axe in both colour schemes", async () => {
        setMine(MINE);
        await page.setViewportSize({ width: 390, height: 844 });
        await scripts();
        await openPanel();
        const box = await panel().boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= 390 + 1).toBe(true);
        await axeBoth();
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 120_000);
});

describe("code scripts going to your own computer", () => {
    it("says so before Start, with a link to Settings; with code scripts off it says so and does not start", async () => {
        setMine(MINE);
        fake.codeTest = "Cart answers";
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        const notice = panel().getByTestId("code-on-own");
        await pwExpect(notice).toContainText("This run includes code scripts. They run on your computer with your user’s rights.");
        await pwExpect(notice.getByRole("link", { name: "Switch code scripts off in Settings" })).toHaveAttribute("href", SETTINGS);
        await page.keyboard.press("Escape");

        setMine(NO_CODE);
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText(RUNNER_CODE_OFF);
        await pwExpect(panel().getByRole("button", { name: "Start run" })).toBeDisabled();
        await page.keyboard.press("Escape");

        fake.codeTest = null;
        setMine(MINE);
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await pwExpect(panel().getByTestId("code-on-own")).toHaveCount(0);
        await page.keyboard.press("Escape");
    }, 120_000);
});

describe("AI work the platform refuses in runners mode", () => {
    it("Describe it and exploring say so before the click and cannot be started", async () => {
        setMine(MINE);
        await scripts();
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        const describeIt = page.getByRole("menuitem", { name: /Describe it/ });
        await pwExpect(describeIt).toBeDisabled();
        await pwExpect(describeIt).toContainText("Describing a test in your own words is not available here yet");
        await page.keyboard.press("Escape");
        await visit(`#/new?project=${projectId}`);
        await pwExpect(page.getByTestId("exploring-off")).toHaveText(EXPLORING_ON_RUNNERS);
        await pwExpect(page.getByRole("button", { name: "Explore again" })).toBeDisabled();
    }, 120_000);
});

describe("a suite's Run in runners mode", () => {
    it("waits for your runner and says what to do, then runs once it is online", async () => {
        setMine(OFF);
        await visit(`#/projects/${projectId}/suites/${suiteId}`);
        const run = page.getByRole("button", { name: "Run suite" });
        await pwExpect(run).toBeDisabled();
        await pwExpect(page.getByTestId("suite-no-runner")).toContainText(RUNNER_OFFLINE);
        await pwExpect(page.getByTestId("suite-no-runner").getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", SETTINGS);
        await pwExpect(page.getByText("Every run goes to the runner of the person who starts it:")).toBeVisible();

        setMine(MINE);
        await visit(`#/projects/${projectId}/suites/${suiteId}`);
        await pwExpect(page.getByRole("button", { name: "Run suite" })).toBeEnabled();
        await pwExpect(page.getByTestId("suite-no-runner")).toHaveCount(0);
        await page.getByRole("button", { name: "Run suite" }).click();
        await pwExpect.poll(() => runStarts.at(-1)?.url).toBe(`/api/projects/${projectId}/test-suites/${suiteId}/run`);
        expect(runStarts.at(-1)!.body ?? {}).not.toHaveProperty("runnerId");
    }, 120_000);
});

describe("the Schedules panel says whether schedules really start", () => {
    it("in runners mode while runs can start, and while the dispatch is down", async () => {
        setMine(MINE);
        fake.schedules = { schedulerEnabled: true };
        await visit(`#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(page.getByTestId("schedules-fire")).toContainText("Each run goes to the runner of the person who made the schedule, so that computer needs to be on then.");
        await pwExpect(page.getByRole("button", { name: "Run now: Every night" })).toBeEnabled();

        fake.runsHere = false;
        await visit(`#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(page.getByTestId("schedules-fire")).toContainText("Scheduled runs don’t start right now");
        await pwExpect(page.getByTestId("schedules-fire")).toContainText("the part of this platform that hands runs to runners isn’t running");
        await pwExpect(page.getByRole("button", { name: "Run now: Every night" })).toBeDisabled();

        // Local mode, tests switched off (no worker): no promise that Run now works.
        fake.mode = "local";
        await visit(`#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(page.getByTestId("schedules-fire")).toContainText("Tests are switched off on this server, so a schedule’s run would never start");
        fake.schedules = { schedulerEnabled: false };
        await visit(`#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(page.getByTestId("schedules-fire")).toHaveText(/Schedules are saved but won’t start on their own\.$/);
        fake.runsHere = true;
        await visit(`#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(page.getByTestId("schedules-fire")).toContainText("Schedules are saved but won’t start on their own. “Run now” still works.");
        fake.mode = "runners";
        fake.schedules = null;
    }, 120_000);
});

describe("the old runner places", () => {
    it("open Your runner in Settings", async () => {
        setMine(MINE);
        for (const old of ["#/runners", "#/runners/tok-mine", "#/runners?add=computer", `#/runners?project=${projectId}`, `#/projects/${projectId}/runners`, `#/projects/${projectId}/settings?section=runners`, "#/settings?section=runners"]) {
            await visit(old);
            await pwExpect.poll(() => page.evaluate(() => location.hash), { message: old }).toBe(SETTINGS);
            await pwExpect(page.getByTestId("your-runner")).toBeVisible();
        }
        await pwExpect(page.locator("aside.sidebar a.nav-item", { hasText: /^Runners$/ })).toHaveCount(0);
    }, 120_000);
});

describe("no page errors", () => {
    it("logged no errors in the browser console", () => {
        expect(consoleErrors.filter((e) => !/stand-in-job|Run not found|not found/i.test(e))).toEqual([]);
    });
});
