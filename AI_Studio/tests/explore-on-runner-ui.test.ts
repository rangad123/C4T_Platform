/**
 * Round 51: exploring an application in runners mode (EXECUTION_MODE=runners) runs on the runner of the person who starts it
 * (docs/features/explore-on-runner.md). In a real browser against a real platform: the explore page and the first card of New project
 * say before the click when the person's runner is not set up, is offline or too old to explore, with the same words and link as a
 * run's refusal, and keep the start off; with the runner online they name it and start; a refusal after the click shows the server's
 * sentence with the link to Your runner; while exploring, the job says which runner it explores on. Also the pure rules.
 *
 * Stand-ins (browser routes, no runner and no worker here): `/api/config` gains `executionMode`, `GET /api/me/runner` answers the
 * contract's shape, the exploration start is recorded and answered (or refused), and the project's answer can carry a running job.
 * Everything else is the real platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs web-build -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/explore-on-runner-ui.test.ts
 * Ports: platform 9055.
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
import { exploreNeedsUpdate } from "../src/platform/explore-task.js";
import { RUNNER_NOT_SET_UP as SERVER_NOT_SET_UP, RUNNER_OFFLINE as SERVER_OFFLINE, RUNNER_SETTINGS_LINK } from "../src/platform/runner-only.js";
import { exploresOnRunner, exploringOn } from "../web/src/features/runs/runs-here.js";
import { readiness, runnerProblem, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, type RunnerMine } from "../web/src/features/runners/my-runner.js";

const PORT = 9055;
const BASE = `http://127.0.0.1:${PORT}`;
const SETTINGS = "#/settings#runner";
// The server's own sentence for a runner too old to explore (also in GET /api/me/runner can.explore.why).
const UPDATE_WHY = exploreNeedsUpdate("Office laptop");

const runnerOf = (over: Partial<RunnerMine> = {}): RunnerMine => ({
    id: "tok-mine",
    name: "Office laptop",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    os: "win32",
    arch: "x64",
    version: "2.0.0",
    switches: { codeScripts: true, privateTargets: false, realPhone: false },
    ...over,
});
const MINE = runnerOf();
const OFF = runnerOf({ status: "offline", lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() });
const CAN_ALL = { web: { ok: true }, phone: { ok: true }, ios: { ok: true }, windows: { ok: true }, record: { ok: true }, recordHeaded: { ok: true }, phoneSession: { ok: true } };
const OLD = runnerOf({ can: { ...CAN_ALL, explore: { ok: false, why: UPDATE_WHY } } });

describe("the rules (no browser)", () => {
    it("uses the run refusal's words, and the runner's own sentence when it can't explore", () => {
        // The page says before the click what the server answers after it.
        expect(RUNNER_NOT_SET_UP).toBe(SERVER_NOT_SET_UP);
        expect(RUNNER_OFFLINE).toBe(SERVER_OFFLINE);
        expect(RUNNER_SETTINGS_LINK).toBe(SETTINGS);
        const needs = { can: ["web", "explore"] as const };
        expect(runnerProblem({ runner: null }, needs)).toBe(RUNNER_NOT_SET_UP);
        expect(runnerProblem({ runner: OFF }, needs)).toBe(RUNNER_OFFLINE);
        expect(runnerProblem({ runner: OLD }, needs)).toBe(UPDATE_WHY);
        // An older server sends no `explore`: the server decides at the click.
        expect(runnerProblem({ runner: runnerOf({ can: CAN_ALL }) }, needs)).toBeNull();
        expect(readiness("runners", { runsHere: true } as never, { data: { runner: OLD }, loading: false }, needs)).toMatchObject({ ready: false, reason: UPDATE_WHY, runnerReason: true });
        expect(exploresOnRunner("Office laptop")).toBe("Explores on your runner, Office laptop. The browser opens on that computer; the AI works from the platform.");
        expect(exploringOn("Office laptop")).toBe("Exploring on Office laptop");
        expect(exploringOn(undefined)).toBe("Exploring on your runner");
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
const consoleErrors: string[] = [];

const fake = {
    mine: null as RunnerMine | null,
    /** The answer an exploration start gets (null: 202). */
    refuse: null as null | { status: number; json: Record<string, unknown> },
    /** A running exploration the project's answer carries (null: as the platform answers). */
    job: null as null | Record<string, unknown>,
};
const starts: Array<{ url: string; body: Record<string, unknown> | null }> = [];

const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-on-runner-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "explore-on-runner-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Runner shop", platforms: ["web"], testingModes: ["agent"] })).body.id;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.route("**/api/config", async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        // The AI model is set up (its answer only: nothing here calls a provider).
        await route.fulfill({ response: res, json: { ...json, executionMode: "runners", runsHere: true, llm: { ...json.llm, configured: true } } });
    });
    // The person's AI is ready (its answer only: nothing here calls a provider).
    await page.route("**/api/me/ai", (route) => route.fulfill({ json: { chosen: null, problem: null, personal: [], organisational: [], canManageOrganisational: false, openServer: { configured: true, provider: "anthropic", model: "stand-in" } } }));
    await page.route("**/api/me/runner", (route) => route.fulfill({ json: { runner: fake.mine } }));
    await page.route("**/api/projects/*/test-generation", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        starts.push({ url: new URL(route.request().url()).pathname, body: (route.request().postDataJSON() as Record<string, unknown> | null) ?? null });
        if (fake.refuse) return route.fulfill({ status: fake.refuse.status, json: fake.refuse.json });
        await route.fulfill({ status: 202, json: { jobId: "stand-in-job" } });
    });
    await page.route(`**/api/projects/${projectId}`, async (route) => {
        if (route.request().method() !== "GET" || !fake.job) return route.continue();
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), latestJob: fake.job } });
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
const exploreAgain = () => visit(`#/new?project=${projectId}`);
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}

describe("before the click", () => {
    it("says when the runner is not set up, offline or too old, with the way to Settings, and keeps the start off", async () => {
        for (const [mine, why] of [[null, RUNNER_NOT_SET_UP], [OFF, RUNNER_OFFLINE], [OLD, UPDATE_WHY]] as const) {
            fake.mine = mine;
            await exploreAgain();
            const note = page.getByTestId("explore-runner-problem");
            await pwExpect(note).toContainText(why);
            await pwExpect(note.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", SETTINGS);
            await pwExpect(page.getByRole("button", { name: "Explore again" })).toBeDisabled();
            await pwExpect(page.getByTestId("explore-on-hint")).toHaveCount(0);
        }
        await axeBoth();
        expect(starts).toEqual([]);
    }, 120_000);

    it("the first card of New project says the same and does not start", async () => {
        fake.mine = OFF;
        await visit("#/new");
        await pwExpect(page.getByTestId("explore-runner-problem")).toContainText(RUNNER_OFFLINE);
        await pwExpect(page.getByRole("button", { name: "Explore my app" })).toBeDisabled();
        fake.mine = MINE;
        await visit("#/new");
        await pwExpect(page.getByTestId("explore-on-hint")).toHaveText(exploresOnRunner("Office laptop"));
        await pwExpect(page.getByRole("button", { name: "Explore my app" })).toBeEnabled();
        expect(starts).toEqual([]);
    }, 120_000);

    it("names the runner when it is online, and starts", async () => {
        fake.mine = MINE;
        await exploreAgain();
        await pwExpect(page.getByTestId("explore-on-hint")).toHaveText(exploresOnRunner("Office laptop"));
        await pwExpect(page.getByTestId("explore-runner-problem")).toHaveCount(0);
        await page.locator("#url").fill("https://shop.example.test");
        await page.getByRole("button", { name: "Explore again" }).click();
        await pwExpect.poll(() => starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ url: `/api/projects/${projectId}/test-generation`, body: { url: "https://shop.example.test/", plan: true } });
        await axeBoth();
    }, 120_000);

    it("a refusal after the click shows the server's sentence with the link to Your runner", async () => {
        fake.mine = MINE;
        fake.refuse = { status: 409, json: { error: SERVER_OFFLINE, details: { code: "RUNNER_OFFLINE", link: RUNNER_SETTINGS_LINK } } };
        try {
            await exploreAgain();
            await page.locator("#url").fill("https://shop.example.test");
            await page.getByRole("button", { name: "Explore again" }).click();
            const err = page.getByTestId("run-start-error");
            await pwExpect(err).toContainText(SERVER_OFFLINE);
            await pwExpect(err.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", SETTINGS);
        } finally {
            fake.refuse = null;
        }
    }, 120_000);
});

describe("while exploring", () => {
    it("the job says which runner it explores on", async () => {
        fake.mine = MINE;
        const now = new Date().toISOString();
        fake.job = {
            jobId: "stand-in-job",
            projectId,
            status: "DISCOVERING",
            mode: "generate",
            planOnly: true,
            targets: ["web"],
            ranOn: { kind: "agent", agentId: "tok-mine", name: "Office laptop" },
            progress: { discovery: "running", understanding: "pending", planning: "pending", generation: "pending", validation: "pending" },
            counters: { pagesDiscovered: 1, apisDiscovered: 0, journeysIdentified: 0, scenariosPlanned: 0, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, scenariosSkipped: 0 },
            error: null,
            createdAt: now,
            startedAt: now,
            finishedAt: null,
        };
        try {
            await visit(`#/projects/${projectId}`);
            await pwExpect(page.getByTestId("exploring-on")).toContainText("Exploring on Office laptop.");
            await axeBoth();
        } finally {
            fake.job = null;
        }
    }, 120_000);

    it("left no console errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
