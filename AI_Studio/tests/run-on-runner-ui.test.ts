/**
 * Runs that go only to runners (EXECUTION_MODE=runners, the hosted platform), in a real browser against a real platform: the Run
 * panel offers no "This server", lists the runners this person may use (their own computers first) with the reason a runner can't
 * take this run before Start, sends `runnerId` for this run only and never changes the project's setting; with none online it says
 * what to do and links to "Add this computer"; the line under the Tests header, the test page's Run button, a suite's Run and the
 * Schedules panel follow the same answer; "Where this project's tests run" offers only a default runner and the switch
 * "Allow people's own computers" with the plain note about test accounts. Also the pure rules behind them.
 *
 * Stand-ins (browser routes, no runner agent and no worker here): `/api/config` gains `executionMode`, `GET /runner-choices` answers
 * the contract's shape, `/runner` answers and records a PUT, and run starts are recorded and answered 202. Everything else (pages,
 * projects, tests, suites) is the real platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/run-on-runner-ui.test.ts
 * Ports: platform 8120.
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
import { codeScriptsNotice, defaultChoice, EXPLORING_ON_RUNNERS, executionModeOf, NO_NEEDS, PLAIN_ON_RUNNERS, readiness, sortChoices, whyNotRunner, type RunnerChoiceRow, type RunnerChoices } from "../web/src/features/runs/runs-here.js";

const PORT = 8120;
const BASE = `http://127.0.0.1:${PORT}`;

const row = (over: Partial<RunnerChoiceRow> & Pick<RunnerChoiceRow, "id" | "name">): RunnerChoiceRow => ({
    kind: "team",
    mine: false,
    online: true,
    busy: false,
    machine: { os: "win32", osVersion: "10.0.22631", arch: "x64" },
    canRunWeb: true,
    canRunMobile: false,
    codeScripts: false,
    problem: null,
    ...over,
});
const MINE = row({ id: "tok-mine", name: "Priya’s laptop", kind: "personal", mine: true, codeScripts: true, machine: { os: "darwin", osVersion: "15.1", arch: "arm64" } });
const LAB = row({ id: "tok-lab", name: "Lab Mac", busy: true });
const BOX = row({ id: "tok-box", name: "Build box", canRunWeb: false });
const OLD = row({ id: "tok-old", name: "Old desktop", online: false });

describe("the rules (no browser)", () => {
    it("says why a runner can't take a run, in one sentence, and a busy one still can", () => {
        expect(whyNotRunner(LAB, { web: true, mobile: false, code: false })).toBeNull();
        expect(whyNotRunner(BOX, { web: true, mobile: false, code: false })).toBe("It can’t run web or API tests.");
        expect(whyNotRunner(BOX, NO_NEEDS)).toBeNull();
        expect(whyNotRunner(OLD, NO_NEEDS)).toBe("Offline.");
        expect(whyNotRunner({ ...MINE, online: false }, NO_NEEDS)).toBe("Offline. Start it on your computer, or sign in to that computer.");
        expect(whyNotRunner(LAB, { web: false, mobile: true, code: false })).toBe("It can’t run phone tests: no phone or emulator is ready on it.");
        expect(whyNotRunner(LAB, { web: false, mobile: false, code: true })).toBe("It doesn’t run code scripts.");
        expect(whyNotRunner({ ...MINE, codeScripts: false }, { web: false, mobile: false, code: true })).toBe("Code scripts are switched off on it. Switch them on in its settings on the Runners page.");
        // The project does not allow people's own computers; the server's own sentence wins when it gives one.
        expect(whyNotRunner(MINE, NO_NEEDS, false)).toBe("This project doesn’t allow people’s own computers.");
        expect(whyNotRunner({ ...MINE, problem: "You can no longer run tests in this project" }, NO_NEEDS)).toBe("You can no longer run tests in this project.");
    });

    it("lists your own computers first, then online ones, then by name; and picks the default the platform would use", () => {
        expect(sortChoices([OLD, LAB, BOX, MINE]).map((r) => r.name)).toEqual(["Priya’s laptop", "Build box", "Lab Mac", "Old desktop"]);
        const c: RunnerChoices = { runners: [OLD, LAB, BOX, MINE], allowPersonal: true, defaultRunnerId: null };
        // Two can take a web run and no default is set: any of them.
        expect(defaultChoice(c, { web: true, mobile: false, code: false })).toBe("any");
        // Only the person's own computer runs code scripts.
        expect(defaultChoice(c, { web: true, mobile: false, code: true })).toBe("tok-mine");
        expect(defaultChoice({ ...c, defaultRunnerId: "tok-lab" }, { web: true, mobile: false, code: false })).toBe("tok-lab");
        // The default can't take it (offline): the first that can, never "any" (the platform would wait for the default).
        expect(defaultChoice({ ...c, defaultRunnerId: "tok-old" }, { web: true, mobile: false, code: false })).toBe("tok-mine");
        expect(defaultChoice({ ...c, runners: [OLD] }, NO_NEEDS)).toBeNull();
    });

    it("is ready only with a runner online in runners mode, and as before in local mode", () => {
        const choices = (data?: RunnerChoices) => ({ data, loading: false, error: undefined });
        const runners = { runsHere: true, executionMode: "runners" } as never;
        expect(executionModeOf(runners)).toBe("runners");
        expect(executionModeOf({ runsHere: true } as never)).toBe("local");
        expect(executionModeOf(undefined)).toBe("local");
        expect(readiness("runners", runners, choices({ runners: [OLD], allowPersonal: true, defaultRunnerId: null }))).toMatchObject({ ready: false, reason: "No runner you can use for this project is online." });
        expect(readiness("runners", runners, choices({ runners: [OLD, LAB], allowPersonal: true, defaultRunnerId: null }))).toMatchObject({ ready: true, reason: null });
        // A personal runner in a project that does not allow them does not count.
        expect(readiness("runners", runners, choices({ runners: [MINE], allowPersonal: false, defaultRunnerId: null })).ready).toBe(false);
        expect(readiness("runners", { runsHere: false, executionMode: "runners" } as never, choices({ runners: [LAB], allowPersonal: true, defaultRunnerId: null })).reason).toMatch(/^Runs can’t start right now/);
        expect(readiness("runners", runners, { data: undefined, loading: true, error: undefined })).toMatchObject({ ready: false, loading: true, reason: null });
        expect(readiness("local", { runsHere: false } as never, choices()).ready).toBe(false);
        expect(readiness("local", { runsHere: true } as never, choices()).ready).toBe(true);
    });

    it("says who wrote the code scripts that go to your computer, when known, and the platform's own words for refused AI work", () => {
        expect(codeScriptsNotice([])).toBe("This run includes code scripts. They run on your computer with your user’s rights.");
        expect(codeScriptsNotice(["Asha"])).toBe("This run includes code scripts written by Asha. They run on your computer with your user’s rights.");
        expect(codeScriptsNotice(["Asha", "Ben", "Chen"])).toBe("This run includes code scripts written by Asha, Ben and Chen. They run on your computer with your user’s rights.");
        // The website says before the click exactly what the platform answers after it (src/platform/runner-only.ts).
        expect(EXPLORING_ON_RUNNERS).toBe(EXPLORING_ON_RUNNERS_MESSAGE);
        expect(PLAIN_ON_RUNNERS).toBe(PLAIN_ON_RUNNERS_MESSAGE);
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
    choices: { runners: [] as RunnerChoiceRow[], allowPersonal: true, defaultRunnerId: null as string | null },
    /** Permissions on the project, when the project's answer should carry them (null: as the platform answers). */
    permissions: null as string[] | null,
    schedules: null as null | { schedulerEnabled: boolean },
    /** Test title the tests list marks as a code script (stand-in for a hand-written script). */
    codeTest: null as string | null,
};
const runStarts: Array<{ url: string; body: Record<string, unknown> | null }> = [];
const runnerPuts: Array<Record<string, unknown>> = [];

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
    await page.route("**/api/projects/*/runner-choices", (route) => route.fulfill({ json: fake.choices }));
    await page.route("**/api/projects/*/runner", async (route) => {
        if (route.request().method() === "PUT") runnerPuts.push(route.request().postDataJSON() as Record<string, unknown>);
        const last = runnerPuts.at(-1);
        const allowPersonal = typeof last?.allowPersonal === "boolean" ? last.allowPersonal : fake.choices.allowPersonal;
        await route.fulfill({ json: { runOn: "agent", agentId: null, status: "Runs on any connected runner.", canRunWeb: true, canRunMobile: false, unavailableReason: null, allowPersonal } });
    });
    const recordStart = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
        if (route.request().method() !== "POST") return route.continue();
        runStarts.push({ url: new URL(route.request().url()).pathname, body: (route.request().postDataJSON() as Record<string, unknown> | null) ?? null });
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
const setChoices = (runners: RunnerChoiceRow[], more: Partial<RunnerChoices> = {}) => {
    fake.choices = { runners, allowPersonal: true, defaultRunnerId: null, ...more };
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

describe("runners mode, no runner online", () => {
    it("says so under the header and in the Run panel, links to Add this computer, and starts nothing", async () => {
        setChoices([{ ...MINE, online: false }, OLD]);
        await scripts();
        const line = page.getByTestId("runs-on");
        await pwExpect(line).toContainText("No runner you can use for this project is online.");
        await pwExpect(line.getByRole("link", { name: "Add this computer" })).toHaveAttribute("href", "#/runners?add=computer");
        await pwExpect(line.getByRole("link", { name: "See runners" })).toHaveAttribute("href", `#/runners?project=${projectId}`);

        await openPanel();
        await pwExpect(panel().getByRole("radio", { name: "This server" })).toHaveCount(0);
        const none = panel().getByTestId("no-runner");
        await pwExpect(none).toContainText("No runner you can use is online");
        await pwExpect(none).toContainText("Add this computer, or start a runner you added.");
        await pwExpect(none.getByRole("link", { name: "Add this computer" })).toHaveAttribute("href", "#/runners?add=computer");
        // Each runner says why before any click: your own computer first.
        const mine = panel().getByRole("radio", { name: /Priya’s laptop/ });
        await pwExpect(mine).toBeDisabled();
        await pwExpect(panel().locator("label.run-opt[data-runner]").first()).toContainText("Priya’s laptop");
        await pwExpect(panel().locator('label[data-runner="tok-mine"]')).toContainText("Offline. Start it on your computer, or sign in to that computer.");
        await pwExpect(panel().locator('label[data-runner="tok-mine"]')).toContainText("Yours · offline");
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("No runner you can use for this project is online.");
        await pwExpect(panel().getByRole("button", { name: "Start run" })).toBeDisabled();
        await axeBoth();
        await panel().getByRole("button", { name: "Close", exact: true }).click();
        expect(runStarts).toEqual([]);
    }, 120_000);

    it("a project that allows no personal computers points to team runners and offers no Add this computer", async () => {
        setChoices([MINE, OLD], { allowPersonal: false });
        await scripts();
        await pwExpect(page.getByTestId("runs-on")).toContainText("No runner you can use for this project is online.");
        await pwExpect(page.getByTestId("runs-on").getByRole("link", { name: "Add this computer" })).toHaveCount(0);
        await openPanel();
        await pwExpect(panel().getByTestId("no-runner")).toContainText("This project runs tests on team runners only.");
        await pwExpect(panel().getByTestId("no-runner").getByRole("link", { name: "Add this computer" })).toHaveCount(0);
        await pwExpect(panel().locator('label[data-runner="tok-mine"]')).toContainText("This project doesn’t allow people’s own computers.");
        await pwExpect(panel().getByRole("radio", { name: /Priya’s laptop/ })).toBeDisabled();
        await page.keyboard.press("Escape");
    });

    it("the test page's Run again waits too, and says why", async () => {
        setChoices([OLD]);
        await visit(`#/tests/${idOf["Home answers"]}`);
        const again = page.getByRole("button", { name: "Run again", exact: true });
        await pwExpect(again).toBeVisible();
        await pwExpect(again).toBeDisabled();
        expect(runStarts).toEqual([]);
    });
});

describe("runners mode, runners online", () => {
    it("lists the runners you may use, yours first, filtered for this run with the reason, and offers any runner", async () => {
        setChoices([OLD, LAB, BOX, MINE]);
        await scripts();
        // The line does not know which tests will run, so it counts every runner online that this person may use (Build box too).
        await pwExpect(page.getByTestId("runs-on")).toContainText("Runs on a runner that is online (3 you can use).");
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await pwExpect(panel().getByRole("radio", { name: "This server" })).toHaveCount(0);
        await pwExpect(panel().getByTestId("no-runner")).toHaveCount(0);
        await pwExpect(panel().locator("label.run-opt[data-runner]")).toHaveText([/^Priya’s laptop/, /^Build box/, /^Lab Mac/, /^Old desktop/]);
        await pwExpect(panel().locator('label[data-runner="tok-mine"]')).toContainText("Yours · online");
        await pwExpect(panel().locator('label[data-runner="tok-box"]')).toContainText("It can’t run web or API tests.");
        await pwExpect(panel().getByRole("radio", { name: /Build box/ })).toBeDisabled();
        await pwExpect(panel().locator('label[data-runner="tok-lab"]')).toContainText("Busy with another run: this one waits until it is free.");
        await pwExpect(panel().locator('label[data-runner="tok-lab"]')).toContainText("Team · busy");
        // No default runner and two can take it: any of them, said in the sentence; nothing is sent as runnerId.
        await pwExpect(panel().getByRole("radio", { name: /Any runner that is online/ })).toBeChecked();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 2 tests on a runner that is online. Results replace the last results of these tests.");
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(panel()).toHaveCount(0);
        expect(runStarts.at(-1)).toEqual({ url: `/api/projects/${projectId}/runs`, body: {} });
        expect(runnerPuts).toEqual([]);
    }, 120_000);

    it("a runner picked in the panel is sent as runnerId for this run only, and the project's setting is not touched", async () => {
        setChoices([OLD, LAB, BOX, MINE]);
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await panel().getByRole("radio", { name: /Priya’s laptop/ }).check();
        await pwExpect(panel().getByTestId("run-sentence")).toHaveText("Runs 2 tests on Priya’s laptop. Results replace the last results of these tests.");
        await pwExpect(panel().getByText("Only this run goes there. Where the project runs its tests does not change.")).toBeVisible();
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect(panel()).toHaveCount(0);
        expect(runStarts.at(-1)).toEqual({ url: `/api/projects/${projectId}/runs`, body: { runnerId: "tok-mine" } });
        // One test from its page, through the panel: the test's own run route carries the choice too.
        await visit(`#/tests/${idOf["Cart answers"]}`);
        await page.getByRole("button", { name: "More ways to run" }).click();
        await pwExpect(panel()).toBeVisible();
        await panel().getByRole("radio", { name: /Priya’s laptop/ }).check();
        await panel().getByRole("button", { name: "Start run" }).click();
        await pwExpect.poll(() => runStarts.at(-1)?.url).toBe(`/api/tests/${idOf["Cart answers"]}/validate`);
        expect(runStarts.at(-1)?.body).toEqual({ runnerId: "tok-mine" });
        expect(runnerPuts).toEqual([]);
    }, 120_000);

    it("starts on the project's default runner, and the line under the header names it", async () => {
        setChoices([OLD, LAB, BOX, MINE], { defaultRunnerId: "tok-lab" });
        await scripts();
        await pwExpect(page.getByTestId("runs-on")).toContainText("Runs on Lab Mac (busy).");
        await pwExpect(page.getByTestId("runs-on").getByRole("link", { name: "Change" })).toHaveAttribute("href", `#/runners?project=${projectId}`);
        await openPanel();
        await pwExpect(panel().getByRole("radio", { name: /Lab Mac/ })).toBeChecked();
        await pwExpect(panel().getByRole("radio", { name: /Any runner that is online/ })).toHaveCount(0);
        await pwExpect(panel().getByTestId("run-sentence")).toContainText("on Lab Mac.");
        await page.keyboard.press("Escape");
    });

    it("the test page's Run again starts at once on the project's runners, without a runnerId", async () => {
        setChoices([LAB]);
        const before = runStarts.length;
        await visit(`#/tests/${idOf["Home answers"]}`);
        const again = page.getByRole("button", { name: "Run again", exact: true });
        await pwExpect(again).toBeEnabled();
        await again.click();
        await pwExpect.poll(() => runStarts.length).toBe(before + 1);
        expect(runStarts.at(-1)).toEqual({ url: `/api/tests/${idOf["Home answers"]}/validate`, body: null });
    });

    it("fits a phone and passes axe in both colour schemes", async () => {
        setChoices([OLD, LAB, BOX, MINE]);
        await page.setViewportSize({ width: 390, height: 844 });
        await scripts();
        await openPanel();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
        await axeBoth();
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 120_000);
});

describe("code scripts going to your own computer", () => {
    it("says so before Start, with a link to the runner's page, and only for your own computer", async () => {
        setChoices([LAB, MINE]);
        fake.codeTest = "Cart answers";
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        // Only your computer runs code scripts here; the team runner says why not.
        await pwExpect(panel().locator('label[data-runner="tok-lab"]')).toContainText("It doesn’t run code scripts.");
        await pwExpect(panel().getByRole("radio", { name: /Priya’s laptop/ })).toBeChecked();
        const notice = panel().getByTestId("code-on-own");
        await pwExpect(notice).toContainText("This run includes code scripts. They run on your computer with your user’s rights.");
        await pwExpect(notice.getByRole("link", { name: "Open Priya’s laptop’s page to switch code scripts off" })).toHaveAttribute("href", "#/runners/tok-mine");
        // Without the code script, nothing to say.
        await page.keyboard.press("Escape");
        fake.codeTest = null;
        await scripts();
        await openPanel();
        await panel().getByRole("radio", { name: "All tests (2)" }).check();
        await panel().getByRole("radio", { name: /Priya’s laptop/ }).check();
        await pwExpect(panel().getByTestId("code-on-own")).toHaveCount(0);
        await page.keyboard.press("Escape");
    }, 120_000);
});

describe("AI work the platform refuses in runners mode", () => {
    it("Describe it and exploring say so before the click and cannot be started", async () => {
        setChoices([LAB]);
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
    it("waits for a runner and says what to do, then runs once one is online", async () => {
        setChoices([OLD]);
        await visit(`#/projects/${projectId}/suites/${suiteId}`);
        const run = page.getByRole("button", { name: "Run suite" });
        await pwExpect(run).toBeDisabled();
        await pwExpect(page.getByTestId("suite-no-runner")).toContainText("No runner you can use for this project is online.");
        await pwExpect(page.getByTestId("suite-no-runner").getByRole("link", { name: "Add this computer" })).toHaveAttribute("href", "#/runners?add=computer");
        await pwExpect(page.getByText("on the Runners page; it applies to every run of the project.")).toBeVisible();

        setChoices([LAB]);
        await visit(`#/projects/${projectId}/suites/${suiteId}`);
        await pwExpect(page.getByRole("button", { name: "Run suite" })).toBeEnabled();
        await pwExpect(page.getByTestId("suite-no-runner")).toHaveCount(0);
        await page.getByRole("button", { name: "Run suite" }).click();
        await pwExpect.poll(() => runStarts.at(-1)?.url).toBe(`/api/projects/${projectId}/test-suites/${suiteId}/run`);
    }, 120_000);
});

describe("the Schedules panel says whether schedules really start", () => {
    it("in runners mode while runs can start, and while the dispatch is down", async () => {
        setChoices([LAB]);
        fake.schedules = { schedulerEnabled: true };
        await visit(`#/projects/${projectId}/runs?section=schedules`);
        await pwExpect(page.getByTestId("schedules-fire")).toContainText("Schedules start their runs on time. Each run goes to a runner of this project that is online then, or to a computer of the person who made the schedule.");
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

describe("where this project's tests run, in runners mode", () => {
    const where = () => page.getByRole("form", { name: "Where tests run" });

    it("offers only a default runner and the switch for people's own computers, with the note about test accounts", async () => {
        setChoices([LAB, MINE]);
        runnerPuts.length = 0;
        await visit(`#/runners?project=${projectId}`);
        await pwExpect(where()).toBeVisible({ timeout: 20_000 });
        await pwExpect(where().getByRole("radio", { name: /On this server/ })).toHaveCount(0);
        await pwExpect(where().getByTestId("runners-only")).toContainText("Tests run on runners only");
        await pwExpect(where().getByLabel("Default runner")).toHaveValue("");
        await pwExpect(where().getByLabel("Default runner").locator("option").first()).toHaveText("Any runner that is online");
        const allow = where().getByRole("checkbox", { name: /Allow people’s own computers/ });
        await pwExpect(allow).toBeChecked();
        await pwExpect(where().getByTestId("allow-personal")).toContainText("this project’s test accounts (passwords, one-time code secrets, API tokens and saved sign-ins) are sent to that computer");
        await pwExpect(where().getByRole("button", { name: "Save" })).toBeDisabled();
        await allow.uncheck();
        await where().getByRole("button", { name: "Save" }).click();
        await pwExpect(where().getByText("Saved.")).toBeVisible();
        // Only the switch changed, so only the switch is sent.
        expect(runnerPuts).toEqual([{ allowPersonal: false }]);
        await pwExpect(allow).not.toBeChecked();
    }, 120_000);

    it("is read-only for someone who may not change the project's settings", async () => {
        fake.permissions = ["ai_studio.access", "ai_studio.tests.run"];
        await visit(`#/runners?project=${projectId}`);
        await pwExpect(where()).toBeVisible({ timeout: 20_000 });
        await pwExpect(where().getByTestId("runner-readonly")).toHaveText("Only someone who may change this project’s settings can change this.");
        await pwExpect(where().getByRole("checkbox", { name: /Allow people’s own computers/ })).toBeDisabled();
        await pwExpect(where().getByLabel("Default runner")).toBeDisabled();
        await pwExpect(where().getByRole("button", { name: "Save" })).toHaveCount(0);
        fake.permissions = null;
    }, 120_000);
});

describe("no page errors", () => {
    it("logged no errors in the browser console", () => {
        expect(consoleErrors.filter((e) => !/stand-in-job|Run not found|not found/i.test(e))).toEqual([]);
    });
});
