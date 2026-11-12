/**
 * The whole runner journey, end to end, with real programs (tests/helpers/runner-stack.ts): the platform started as its own program
 * on a temporary data folder, a stand-in application, the real runner program from source, and a real browser. Round 45: one runner
 * per person, set up in Settings and used for every run they start.
 *
 *   A person (an editor: may run tests) opens Your runner in Settings and downloads the runner (the download carries a one-time code,
 *   read here from the zip the browser saved); the runner program trades it and shows as online; they let it test local addresses;
 *   they run the project's Playwright tests from the Test scripts page with no runner to choose (none is sent); they watch the run
 *   while the application holds the first test half way, refresh the page and still see it; they see the results, the failure and its
 *   screenshot; the runner program stops (offline) and starts again with the credential it saved (online); a second run works; a second
 *   person has no runner, cannot use the first person's, and is told to set up their own; no code or credential ends up in output,
 *   files or the repository.
 *
 * RUNNER_JOURNEY=local runs the journey on a platform in local mode (the project set to run on a runner) instead of runners mode.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/runner-journey-ui.test.ts
 * Needs web/dist (vite build). Ports: platform 8795, stand-in application 8796. About 3 minutes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { unzipSync } from "fflate";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { startRunnerStack, waitFor, type AgentProcess, type RunnerStack } from "./helpers/runner-stack.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const PORT = 8795;
const APP_PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNNERS_MODE = !(process.env.RUNNER_JOURNEY ?? "").split(",").map((x) => x.trim()).includes("local");

const RUNNER = "Ada laptop";
const CHECKOUT = "The checkout page loads";
const RECEIPT = "The receipt shows the total";
const people = {
    ada: { email: "ada@example.com", name: "Ada Lovelace", role: "editor" as const, password: "Ada's long journey password" },
    ben: { email: "ben@example.com", name: "Ben Okafor", role: "editor" as const, password: "Ben's long journey password" },
};

let stack: RunnerStack;
let browser: Browser;
let ctxA: BrowserContext;
let pageA: Page;
let projectId = "";
const ids: Record<"checkout" | "receipt", string> = { checkout: "", receipt: "" };
let agent: AgentProcess | undefined;
const agents: AgentProcess[] = [];
let runnerId = "";
const teamToken = "";
let enrollCode = "";
let firstJob = "";
let repoBefore: string[] = [];
let kitDir = "";

/** Entries of the repository's top level and of src/agent: a runner from a checkout must not leave its files there. */
const repoEntries = () => [...fs.readdirSync(REPO_ROOT).map((n) => n), ...fs.readdirSync(path.join(REPO_ROOT, "src/agent")).map((n) => `src/agent/${n}`)];
const RUNNER_FILE = /runner\.(enroll|token|credential|json)$|credential|machine-id|\.agent-work/i;

async function signIn(page: Page, who: { email: string; password: string }) {
    await page.goto(BASE);
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel("Password").fill(who.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}

/** Your runner in Settings shows this state (reloaded until it does: the state comes from heartbeats). */
async function runnerState(page: Page, state: "online" | "offline", ms: number) {
    await pwExpect(async () => {
        await page.goto(`${BASE}/#/settings#runner`);
        await pwExpect(page.getByTestId("your-runner")).toHaveAttribute("data-state", state === "online" ? /^(online|busy)$/ : state, { timeout: 3000 });
    }).toPass({ timeout: ms, intervals: [2000, 4000] });
}

/** From the Test scripts page: Run, all tests, Start run (nothing to choose: the run goes to the person's runner). */
async function startRunFromScripts(page: Page): Promise<{ jobId: string; sent: Record<string, unknown> }> {
    await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const panel = page.getByRole("group", { name: "Run settings" });
    await pwExpect(panel).toBeVisible();
    await panel.getByRole("radio", { name: /^All tests/ }).check();
    if (RUNNERS_MODE) {
        await pwExpect(panel.getByText("This server", { exact: true })).toHaveCount(0);
        await pwExpect(panel.getByTestId("run-sentence")).toContainText(`on your runner, ${RUNNER}`, { timeout: 30_000 });
    }
    const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/projects/${projectId}/runs`);
    await panel.getByRole("button", { name: "Start run" }).click();
    const res = await answer;
    expect(res.status(), await res.text()).toBe(202);
    return { jobId: ((await res.json()) as { jobId: string }).jobId, sent: (res.request().postDataJSON() ?? {}) as Record<string, unknown> };
}

/** The run's page while the first test waits half way: running, on this computer, nothing finished yet. */
async function seesRunGoing(page: Page) {
    await pwExpect(page.getByText("Running", { exact: true }).first()).toBeVisible();
    await pwExpect(page.getByRole("region", { name: "About this run" }).getByText(`On ${RUNNER}`)).toBeVisible();
    // The runner's own report until the results are stored: nothing has passed and the held test is still running (the receipt test
    // may already have given up, as the comment below says).
    await pwExpect(page.getByTestId("run-summary")).toHaveText(/^So far: 0 passed, (0 failed, 2|1 failed, 1) running\.$/);
    {
        const live = page.getByTestId("run-live");
        // Four steps, now at Running; the runner is named once, in About this run, as the person's own computer.
        await pwExpect(live.getByRole("list", { name: "Where the run is" }).locator("[aria-current=step]")).toContainText("Running");
        const about = page.getByRole("region", { name: "About this run" });
        await pwExpect(about.getByTestId("run-live-runner")).toContainText(RUNNER);
        await pwExpect(about.getByText("Your computer", { exact: true })).toBeVisible();
        // The two tests run side by side: the receipt test is the latest one running until its check gives up, then only the held one is.
        await pwExpect(live.getByTestId("run-live-current")).toContainText(CHECKOUT, { timeout: 30_000 });
    }
}

const finished = (s: string) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(s);
async function jobDone(jobId: string, ms = 120_000): Promise<any> {
    return waitFor(async () => {
        const j = (await stack.as("ada", "GET", `/api/test-generation/${jobId}`)).body;
        return j && finished(j.status) ? j : undefined;
    }, ms, `run ${jobId} to finish`, 500);
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    repoBefore = repoEntries();
    // The runner download the platform serves: plain files (no installer or complete build here), built into a temporary folder.
    kitDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-journey-kit-"));
    await buildRunner({ outDir: path.join(kitDir, "bundle") });
    stack = await startRunnerStack({
        port: PORT,
        appPort: APP_PORT,
        mode: RUNNERS_MODE ? "runners" : "local",
        people,
        label: "aitp-journey",
        env: { RUNNER_KIT_DIR: path.join(kitDir, "bundle"), RUNNER_INSTALLER_DIR: path.join(kitDir, "no-installer"), RUNNER_COMPLETE_DIR: path.join(kitDir, "no-complete"), PUBLIC_URL: BASE },
    });
    const app = stack.app;
    app.page("/", `<!doctype html><html lang="en"><head><title>Corner shop</title></head><body><main><h1>Corner shop</h1></main></body></html>`);
    app.page("/checkout", `<!doctype html><html lang="en"><head><title>Checkout</title></head><body><main><h1>Checkout complete</h1><p>Your order is on its way.</p></main></body></html>`);
    app.page("/receipt", `<!doctype html><html lang="en"><head><title>Receipt</title></head><body><main><h1>Receipt</h1><p>Thank you for your order.</p></main></body></html>`);

    const made = await stack.admin("POST", "/api/projects", { name: "Corner shop" });
    expect(made.status, made.text).toBe(201);
    projectId = made.body.id;
    const imp = await stack.admin("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: app.url,
        validate: false,
        specs: [
            { title: CHECKOUT, kind: "web", category: "Web", steps: [{ action: "navigate", url: `${app.url}/checkout` }, { action: "assert", check: "visible", locator: { by: "text", value: "Checkout complete" } }] },
            { title: RECEIPT, kind: "web", category: "Web", steps: [{ action: "navigate", url: `${app.url}/receipt` }, { action: "assert", check: "visible", locator: { by: "text", value: "Total paid" } }] },
        ],
    });
    expect(imp.status, imp.text).toBe(202);
    // The answer lists the new tests in the order they were sent.
    const tests = imp.body.tests as Array<{ id: string }>;
    expect(tests).toHaveLength(2);
    [ids.checkout, ids.receipt] = [tests[0]!.id, tests[1]!.id];

    browser = await chromium.launch();
    ctxA = await browser.newContext();
    pageA = await ctxA.newPage();
    await signIn(pageA, people.ada);
}, 150_000);

afterEach((ctx) => {
    if (ctx.task.result?.state !== "fail") return;
    console.log(`--- platform (last lines) ---\n${stack?.platformOutput().slice(-3000)}`);
    for (const a of agents) console.log(`--- runner ${a.pid} (last lines) ---\n${a.output().slice(-3000)}`);
});

afterAll(async () => {
    await browser?.close();
    await stack?.stop();
    if (kitDir) fs.rmSync(kitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("a person's own runner runs their tests, from setting it up in Settings to a second run", () => {
    (RUNNERS_MODE ? it : it.skip)("the platform hands every run to runners and refuses to run tests itself", async () => {
        const config = await stack.as("ada", "GET", "/api/config");
        expect(config.body.executionMode).toBe("runners");
        const ready = await fetch(`${BASE}/readyz`);
        expect(ready.status).toBe(200);
    });

    it("downloads the runner from Your runner in Settings and sees it connect", async () => {
        await pageA.goto(`${BASE}/#/settings#runner`);
        const section = pageA.getByTestId("your-runner");
        await pwExpect(section).toHaveAttribute("data-state", "not-set-up", { timeout: 20_000 });
        await section.getByText("For another computer?", { exact: true }).click();
        await section.getByLabel("System").selectOption("linux");
        await section.getByLabel("Processor").selectOption(os.arch() === "arm64" ? "arm64" : "x64");
        const saved = pageA.waitForEvent("download");
        await section.getByRole("button", { name: /^Download for Linux/ }).click();
        const dl = await saved;
        const zipPath = await dl.path();
        const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath!)));
        const enrollFile = Object.keys(files).find((f) => f.endsWith("runner.enroll"));
        expect(enrollFile, Object.keys(files).join(", ")).toBeDefined();
        enrollCode = new TextDecoder().decode(files[enrollFile!]).trim();
        await dl.delete();
        expect(enrollCode).toMatch(/^aite_/);
        // The code lives only in the zip: never on the page.
        expect(await pageA.content()).not.toContain(enrollCode);
        await pwExpect(section.getByTestId("runner-wait")).toContainText("Waiting for the computer to connect");
        agent = await stack.startAgent({ name: RUNNER, enrollCode });
        agents.push(agent);
        await pwExpect(section).toHaveAttribute("data-state", /^(online|busy)$/, { timeout: 60_000 });
        const mine = await stack.as("ada", "GET", "/api/me/runner");
        expect(mine.status, mine.text).toBe(200);
        runnerId = mine.body.runner.id;
        expect(runnerId).not.toBe("");
        if (!RUNNERS_MODE) {
            // Local mode: the project sends its runs to a runner (runners mode does that for every project).
            const set = await stack.admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
            expect(set.status, set.text).toBe(200);
        }
    }, 150_000);

    it("names the runner after their choice and lets it test local addresses (the stand-in application is on 127.0.0.1)", async () => {
        await pageA.goto(`${BASE}/#/settings#runner`);
        const section = pageA.getByTestId("your-runner");
        // The runner is named after the computer; Ada renames it.
        await section.getByRole("button", { name: "Rename" }).click();
        await section.getByRole("textbox").fill(RUNNER);
        await section.getByRole("button", { name: "Save name" }).click();
        await pwExpect(section).toContainText(`Your runner is now called “${RUNNER}”.`);
        await section.getByRole("checkbox", { name: /Test private and local addresses/ }).check();
        await pwExpect(section.getByText("Tests on your computer may now reach private and local addresses.")).toBeVisible();
        expect((await stack.as("ada", "GET", "/api/me/runner")).body.runner.switches.privateTargets).toBe(true);
    }, 60_000);

    it("runs the project's tests on it from the Test scripts page and watches the run go", async () => {
        stack.app.hold("/checkout");
        const { jobId, sent } = await startRunFromScripts(pageA);
        firstJob = jobId;
        expect(sent).not.toHaveProperty("runnerId");
        // The first test is now on the runner, waiting for the application's answer.
        await stack.app.waitForHit("/checkout", 1, 90_000);
        await pageA.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        await seesRunGoing(pageA);
    }, 150_000);

    it("live events from the runner arrive while the test is still going", async () => {
        const events = await waitFor(
            async () => {
                const list = (await stack.as("ada", "GET", `/api/test-generation/${firstJob}/events`)).body as Array<{ kind: string }>;
                return list.some((e) => e.kind === "runner_test_started" && JSON.stringify(e).includes(CHECKOUT)) ? list : undefined;
            },
            10_000,
            "a runner_test_started event",
        );
        expect(events.some((e) => e.kind === "runner_test_finished" && JSON.stringify(e).includes(CHECKOUT))).toBe(false);
        const job = (await stack.as("ada", "GET", `/api/test-generation/${firstJob}`)).body;
        expect(job.phase ?? job.ranOn?.phase).toBe("running");
    });

    it("refreshes the page half way and still sees the run going", async () => {
        await pageA.reload();
        await seesRunGoing(pageA);
        expect(stack.app.hits("/checkout")).toBe(1);
    }, 30_000);

    it("sees the results, the failure and its screenshot", async () => {
        stack.app.release("/checkout");
        await pwExpect(pageA.getByText("Finished, with problems")).toBeVisible({ timeout: 120_000 });
        await pwExpect(pageA.getByTestId("run-summary")).toHaveText("1 of 2 that ran passed, 1 failing.");
        const list = pageA.getByRole("region", { name: "Tests in this run" });
        await pwExpect(list.locator('li[data-state="passed"]').filter({ hasText: CHECKOUT })).toBeVisible();
        await pwExpect(list.locator('li[data-state="failed"]').filter({ hasText: RECEIPT })).toBeVisible();
        const job = (await stack.as("ada", "GET", `/api/test-generation/${firstJob}`)).body;
        expect(job.ranOn).toMatchObject({ kind: "agent", name: RUNNER });
        expect(job.phase ?? job.ranOn?.phase).toBe("completed");
        const live = pageA.getByTestId("run-live");
        // Finished on the person's runner: every step done, no bad-ending sentence, and About this run still names that runner.
        await pwExpect(live.getByRole("list", { name: "Where the run is" }).locator("li.is-done")).toHaveCount(4);
        await pwExpect(live.getByTestId("run-live-phase")).toHaveCount(0);
        await pwExpect(pageA.getByRole("region", { name: "About this run" }).getByTestId("run-live-runner")).toContainText(RUNNER);
        await pwExpect(live.getByTestId("run-live-failures")).toContainText(RECEIPT);
        await pwExpect(live.getByTestId("run-live-shots").getByRole("listitem").first()).toBeVisible();
        const exec = (await stack.as("ada", "GET", `/api/tests/${ids.receipt}/executions`)).body;
        expect(exec[0].status).not.toBe("passed");
        expect(exec[0].error).toMatch(/Total paid|toBeVisible/);

        await pageA.goto(`${BASE}/#/tests/${ids.receipt}`);
        const shot = pageA.getByRole("img", { name: "Screenshot at the moment of failure" }).first();
        await pwExpect(shot).toBeVisible({ timeout: 30_000 });
        await pwExpect.poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    }, 180_000);

    it("the runner shows offline when its program stops, and online again when it starts with what it saved", async () => {
        const code = await agent!.stop();
        expect(code, agent!.output().slice(-1500)).toBe(0);
        // Nothing heard for 45 seconds is offline.
        await runnerState(pageA, "offline", 90_000);
        agent = await stack.startAgent({ name: RUNNER, workDir: agent!.workDir, savedCredential: true });
        agents.push(agent);
        await runnerState(pageA, "online", 60_000);
        // The second start used the credential saved at enrollment: the code is gone from its folder and was not needed.
        expect(agent.output()).not.toMatch(/code has (expired|been used)/i);
    }, 180_000);

    it("a second run works after the reconnect", async () => {
        const { jobId, sent } = await startRunFromScripts(pageA);
        expect(sent).not.toHaveProperty("runnerId");
        const job = await jobDone(jobId);
        expect(job.ranOn).toMatchObject({ kind: "agent", name: RUNNER });
        await pageA.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        await pwExpect(pageA.getByTestId("run-summary")).toHaveText("1 of 2 that ran passed, 1 failing.");
        await pwExpect(pageA.getByRole("region", { name: "Tests in this run" }).locator('li[data-state="passed"]').filter({ hasText: CHECKOUT })).toBeVisible();
        expect(stack.app.hits("/checkout")).toBe(2);
    }, 180_000);

    (RUNNERS_MODE ? it : it.skip)("a second person in the same project has no runner, cannot use the first person's, and is told to set up their own", async () => {
        expect((await stack.as("ben", "GET", "/api/me/runner")).body.runner).toBeNull();
        // Naming the first person's runner changes nothing: runnerId is ignored, and Ben's run has no runner to go to.
        for (const body of [{ runnerId }, {}]) {
            const r = await stack.as("ben", "POST", `/api/projects/${projectId}/runs`, body);
            expect(r.status, r.text).toBe(409);
            expect(r.body?.details?.code ?? r.text).toBe("RUNNER_NOT_SET_UP");
        }
        expect(stack.app.hits("/checkout")).toBe(2);

        const ctxB = await browser.newContext();
        try {
            const pageB = await ctxB.newPage();
            await signIn(pageB, people.ben);
            await pageB.goto(`${BASE}/#/settings#runner`);
            await pwExpect(pageB.getByTestId("your-runner")).toHaveAttribute("data-state", "not-set-up", { timeout: 20_000 });
            await pwExpect(pageB.getByText(RUNNER)).toHaveCount(0);
            await pageB.goto(`${BASE}/#/projects/${projectId}/scripts`);
            await pageB.getByRole("button", { name: "Run", exact: true }).click();
            const panel = pageB.getByRole("group", { name: "Run settings" });
            await pwExpect(panel).toBeVisible();
            await pwExpect(panel.getByTestId("no-runner")).toContainText("Set up your runner in Settings to run tests.");
            await pwExpect(panel.getByRole("radio", { name: new RegExp(RUNNER) })).toHaveCount(0);
        } finally {
            await ctxB.close();
        }
    }, 120_000);

    it("no enrollment code or runner credential shows up in output, in the runner's folder or in the repository", async () => {
        const full = /aitg_[A-Za-z0-9_-]{20,}|aitpu_[A-Za-z0-9_-]{20,}/;
        const outputs = [stack.platformOutput(), ...agents.map((a) => a.output())].join("\n");
        expect(outputs).not.toMatch(full);
        if (enrollCode) expect(outputs).not.toContain(enrollCode);
        if (teamToken) expect(outputs).not.toContain(teamToken);
        expect(outputs).not.toContain(stack.apiKey);

        // In the runner's folder: never the code (it is traded once, then deleted); a credential only in a file only this user can read.
        const found: string[] = [];
        const scan = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const file = path.join(dir, e.name);
                if (e.isSymbolicLink()) continue;
                if (e.isDirectory()) scan(file);
                else {
                    const text = fs.readFileSync(file).toString("latin1");
                    if (enrollCode && text.includes(enrollCode)) found.push(`the enrollment code in ${path.relative(agent!.workDir, file)}`);
                    if (full.test(text) && process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) found.push(`a credential readable by others in ${path.relative(agent!.workDir, file)}`);
                }
            }
        };
        scan(agent!.workDir);
        expect(found).toEqual([]);

        const added = repoEntries().filter((e) => !repoBefore.includes(e) && RUNNER_FILE.test(e));
        expect(added).toEqual([]);
    });
});
