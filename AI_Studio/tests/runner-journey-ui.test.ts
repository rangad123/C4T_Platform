/**
 * The whole runner journey, end to end, with real programs (tests/helpers/runner-stack.ts): the platform started as its own program
 * on a temporary data folder, a stand-in application, the real runner program from source, and a real browser.
 *
 *   A person (an editor: may run tests, may not manage team runners) adds their own computer from the Runners page with a one-time
 *   enrollment code; the runner shows as online; they run the project's Playwright tests on it from the Test scripts page; they watch
 *   the run while the application holds the first test half way, refresh the page and still see it; they see the results, the failure
 *   and its screenshot; the runner program stops (offline) and starts again with the credential it saved (online); a second run works;
 *   a second person can neither see nor use the first person's computer; no code or credential ends up in output, files or the repository.
 *
 * Parts of this round's work land at different times. Each flag in BUILT names one piece; a step that needs a missing piece is an
 * `it.todo`, and a step that has today's equivalent runs that instead (noted at the step), so the rest of the journey is still checked.
 * Turn a flag on when its piece lands (or run with RUNNER_JOURNEY=all, or a comma list of flag names; "local" runs the journey on a
 * platform in local mode instead).
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/runner-journey-ui.test.ts
 * Needs web/dist (vite build). Ports: platform 8180, stand-in application 8181. About 3 minutes.
 */
import fs from "node:fs";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { startRunnerStack, waitFor, type AgentProcess, type RunnerStack } from "./helpers/runner-stack.js";

const PORT = 8180;
const APP_PORT = 8181;
const BASE = `http://127.0.0.1:${PORT}`;

const PIECES = ["runnersMode", "enrollment", "personal", "addComputerUi", "runPanel", "liveEvents", "liveView"] as const;
type Piece = (typeof PIECES)[number];
/**
 * What has landed, one flag per piece of work:
 *  runnersMode    EXECUTION_MODE=runners: the platform runs nothing itself and hands every run to runners (runner-only execution).
 *                 Off: the platform runs in local mode with its embedded worker and the project set to "On a runner".
 *  enrollment     POST /api/runners/enroll, POST /api/agent/enroll, the runner's --enroll and its saved credential (identity and access).
 *                 Off: a team runner registered with the access key, started with a token file.
 *  personal       personal runners: owner-only runs, GET /api/projects/:id/runner-choices, the owner's switches, runnerId (identity and access).
 *  addComputerUi  the Runners page's "Add this computer" (website: Runners pages). Off: the code is made through the API.
 *  runPanel       the Run panel lists runner-choices and sends runnerId for this run only, no "This server" in runners mode (website: Run panel).
 *  liveEvents     protocol 2 live events stored as runner_* job events, and the task phase on the run (lifecycle and live events).
 *  liveView       the run page's live panel: phase, current test and step, screenshots (website: live run view).
 */
// Every piece has landed (round 39 integration); a flag can still be turned off by hand to run the older equivalent of a step.
const BUILT: Record<Piece, boolean> = { runnersMode: true, enrollment: true, personal: true, addComputerUi: true, runPanel: true, liveEvents: true, liveView: true };
for (const name of (process.env.RUNNER_JOURNEY ?? "").split(",").map((s) => s.trim())) {
    if (name === "all") for (const p of PIECES) BUILT[p] = true;
    else if (name === "local") BUILT.runnersMode = false;
    else if ((PIECES as readonly string[]).includes(name)) BUILT[name as Piece] = true;
}
// A piece only counts once what it stands on is there too.
const ENROLL = BUILT.enrollment;
const PERSONAL = BUILT.personal && ENROLL;
const UI_ENROLL = BUILT.addComputerUi && ENROLL;
const when = (on: boolean) => (on ? it : it.todo);

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
let teamToken = "";
let enrollCode = "";
let firstJob = "";
let repoBefore: string[] = [];

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

/** The Runners page lists the runner with this status word (it is reloaded until it does: status comes from heartbeats). */
async function runnerListed(page: Page, status: "Online" | "Offline", ms: number) {
    await pwExpect(async () => {
        await page.goto(`${BASE}/#/runners`);
        const row = page.getByRole("list", { name: "Runners" }).getByRole("listitem").filter({ hasText: RUNNER });
        await pwExpect(row.getByText(status, { exact: true })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: ms, intervals: [2000, 4000] });
}

/** From the Test scripts page: Run, all tests, this runner, Start run. Returns the new run's id and the request body sent. */
async function startRunFromScripts(page: Page): Promise<{ jobId: string; sent: Record<string, unknown> }> {
    await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const panel = page.getByRole("group", { name: "Run settings" });
    await pwExpect(panel).toBeVisible();
    await panel.getByRole("radio", { name: /^All tests/ }).check();
    if (BUILT.runPanel && BUILT.runnersMode) await pwExpect(panel.getByText("This server", { exact: true })).toHaveCount(0);
    // Online runners only (an earlier connection of the same computer may still be listed as offline).
    const mine = panel.getByRole("radio", { name: new RegExp(RUNNER), disabled: false });
    if (BUILT.runPanel) await mine.check({ timeout: 30_000 });
    // Before the Run panel's runner list lands, a panel that cannot list runners offers none: the project's runner takes the run.
    else if (await mine.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await mine.check();
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
    await pwExpect(page.getByTestId("run-summary")).toHaveText("0 of 2 tests have a result so far.");
    if (BUILT.liveView) {
        const live = page.getByTestId("run-live");
        await pwExpect(live.getByTestId("run-live-phase")).toContainText("Running");
        await pwExpect(live.getByTestId("run-live-runner")).toContainText(RUNNER);
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
    stack = await startRunnerStack({ port: PORT, appPort: APP_PORT, mode: BUILT.runnersMode ? "runners" : "local", people, label: "aitp-journey" });
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
});

describe("a person's own computer runs their tests, from adding it to a second run", () => {
    when(BUILT.runnersMode)("the platform hands every run to runners and refuses to run tests itself", async () => {
        const config = await stack.as("ada", "GET", "/api/config");
        expect(config.body.executionMode).toBe("runners");
        const here = await stack.admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "platform" });
        expect(here.status, here.text).toBe(409);
        expect(here.body?.error ?? here.text).toMatch(/runner/i);
        const ready = await fetch(`${BASE}/readyz`);
        expect(ready.status).toBe(200);
    });

    // Today's equivalent when enrollment has not landed: a team runner registered with the access key and started with its token.
    it("adds their computer and sees it online on the Runners page", async () => {
        if (UI_ENROLL) {
            await pageA.goto(`${BASE}/#/runners`);
            await pageA.getByRole("button", { name: "Add this computer" }).click();
            const choose = pageA.getByRole("form", { name: "Choose the computer" });
            await choose.getByLabel("Name", { exact: true }).fill(RUNNER);
            await choose.getByRole("button", { name: /^(Continue|Next)$/ }).click();
            const instead = pageA.getByText("Use a command instead", { exact: true });
            if (await instead.isVisible().catch(() => false)) await instead.click();
            await pageA.getByRole("button", { name: "Show the command" }).click();
            const command = await pageA.getByLabel("Command to add this computer").innerText();
            enrollCode = /aite_[A-Za-z0-9_-]{20,}/.exec(command)?.[0] ?? "";
            expect(enrollCode, command).not.toBe("");
            expect(command).toContain(`--url ${BASE}`);
            await pwExpect(pageA.getByTestId("code-life")).toBeVisible();
            agent = await stack.startAgent({ name: RUNNER, enrollCode });
            agents.push(agent);
            await pageA.getByRole("button", { name: "Continue" }).click();
            await pwExpect(pageA.getByTestId("kit-status")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
            await pwExpect(pageA.getByText(`Connected: ${RUNNER} is online`)).toBeVisible();
        } else if (ENROLL) {
            const made = await stack.as("ada", "POST", "/api/runners/enroll", { kind: "personal", label: RUNNER });
            expect([200, 201], made.text).toContain(made.status);
            enrollCode = made.body.code;
            expect(enrollCode).toMatch(/^aite_/);
            expect(Date.parse(made.body.expiresAt) - Date.now()).toBeGreaterThan(25 * 60_000);
            agent = await stack.startAgent({ name: RUNNER, enrollCode });
            agents.push(agent);
        } else {
            const made = await stack.admin("POST", "/api/runners", { name: RUNNER });
            expect(made.status, made.text).toBe(201);
            teamToken = made.body.secret;
            runnerId = made.body.runner.id;
            const grant = await stack.admin("PUT", `/api/projects/${projectId}/runner-access/${runnerId}`);
            expect(grant.status, grant.text).toBe(200);
            agent = await stack.startAgent({ name: RUNNER, token: teamToken });
            agents.push(agent);
        }
        await runnerListed(pageA, "Online", 60_000);

        if (PERSONAL) {
            const choices = await stack.as("ada", "GET", `/api/projects/${projectId}/runner-choices`);
            expect(choices.status, choices.text).toBe(200);
            expect(choices.body.allowPersonal).toBe(true);
            const mine = (choices.body.runners as Array<{ id: string; name: string }>).find((r) => r.name === RUNNER);
            expect(mine, choices.text).toMatchObject({ kind: "personal", mine: true, online: true, canRunWeb: true });
            runnerId = mine!.id;
        } else if (!runnerId) {
            const list = await stack.as("ada", "GET", "/api/runners");
            runnerId = (list.body.runners as Array<{ id: string; name: string }>).find((r) => r.name === RUNNER)!.id;
        }
        expect(runnerId).not.toBe("");
        if (!BUILT.runnersMode) {
            // Local mode: the project sends its runs to a runner (runners mode does that for every project).
            const set = await stack.admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
            expect(set.status, set.text).toBe(200);
        }
    }, 120_000);

    when(PERSONAL)("lets their computer test local addresses, from its page (the stand-in application is on 127.0.0.1)", async () => {
        if (UI_ENROLL) {
            await pageA.goto(`${BASE}/#/runners/${runnerId}`);
            await pageA.getByRole("checkbox", { name: /Test private and local addresses/ }).check();
            await pwExpect(pageA.getByText("Tests on this computer may now reach private and local addresses.")).toBeVisible();
        } else {
            const set = await stack.as("ada", "PATCH", `/api/runners/${runnerId}`, { allowPrivateTargets: true });
            expect(set.status, set.text).toBe(200);
        }
    });

    it("runs the project's tests on it from the Test scripts page and watches the run go", async () => {
        stack.app.hold("/checkout");
        const { jobId, sent } = await startRunFromScripts(pageA);
        firstJob = jobId;
        if (BUILT.runPanel) expect(sent).toMatchObject({ runnerId });
        // The first test is now on the runner, waiting for the application's answer.
        await stack.app.waitForHit("/checkout", 1, 90_000);
        await pageA.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        await seesRunGoing(pageA);
    }, 150_000);

    when(BUILT.liveEvents)("live events from the runner arrive while the test is still going", async () => {
        const events = await waitFor(
            async () => {
                const list = (await stack.as("ada", "GET", `/api/test-generation/${firstJob}/events`)).body as Array<{ kind: string }>;
                return list.some((e) => e.kind === "runner_test_started" && JSON.stringify(e).includes(CHECKOUT)) ? list : undefined;
            },
            10_000,
            "a runner_test_started event",
        );
        // The held test has not finished (the receipt test beside it may have: the two run side by side).
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
        if (BUILT.liveEvents) expect(job.phase ?? job.ranOn?.phase).toBe("completed");
        if (BUILT.liveView) {
            const live = pageA.getByTestId("run-live");
            await pwExpect(live.getByTestId("run-live-phase")).toContainText(`Finished on ${RUNNER}`);
            await pwExpect(live.getByTestId("run-live-failures")).toContainText(RECEIPT);
            await pwExpect(live.getByTestId("run-live-shots").getByRole("listitem").first()).toBeVisible();
        }
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
        await runnerListed(pageA, "Offline", 90_000);
        agent = await stack.startAgent({ name: RUNNER, workDir: agent!.workDir, ...(ENROLL ? { savedCredential: true } : { token: teamToken }) });
        agents.push(agent);
        await runnerListed(pageA, "Online", 60_000);
        if (ENROLL) {
            // The second start used the credential saved at enrollment: the code is gone from its folder and was not needed.
            expect(agent.output()).not.toMatch(/code has (expired|been used)/i);
        }
    }, 180_000);

    it("a second run works after the reconnect", async () => {
        const { jobId, sent } = await startRunFromScripts(pageA);
        if (BUILT.runPanel) expect(sent).toMatchObject({ runnerId });
        const job = await jobDone(jobId);
        expect(job.ranOn).toMatchObject({ kind: "agent", name: RUNNER });
        await pageA.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        await pwExpect(pageA.getByTestId("run-summary")).toHaveText("1 of 2 that ran passed, 1 failing.");
        await pwExpect(pageA.getByRole("region", { name: "Tests in this run" }).locator('li[data-state="passed"]').filter({ hasText: CHECKOUT })).toBeVisible();
        expect(stack.app.hits("/checkout")).toBe(2);
    }, 180_000);

    when(PERSONAL)("a second person in the same project can neither see nor use that computer", async () => {
        const choices = await stack.as("ben", "GET", `/api/projects/${projectId}/runner-choices`);
        expect(choices.status, choices.text).toBe(200);
        expect((choices.body.runners as Array<{ id: string }>).map((r) => r.id)).not.toContain(runnerId);
        const listed = await stack.as("ben", "GET", "/api/runners");
        expect((listed.body.runners as Array<{ id: string }>).map((r) => r.id)).not.toContain(runnerId);
        expect((await stack.as("ben", "GET", `/api/runners/${runnerId}`)).status).toBe(404);
        const chosen = await stack.as("ben", "POST", `/api/projects/${projectId}/runs`, { runnerId });
        expect(chosen.status, chosen.text).toBe(404);
        const any = await stack.as("ben", "POST", `/api/projects/${projectId}/runs`, {});
        expect(any.status, any.text).toBe(409);
        expect(any.body?.error ?? any.text).toMatch(/runner/i);
        expect(stack.app.hits("/checkout")).toBe(2);

        const ctxB = await browser.newContext();
        try {
            const pageB = await ctxB.newPage();
            await signIn(pageB, people.ben);
            if (BUILT.addComputerUi) {
                await pageB.goto(`${BASE}/#/runners`);
                await pwExpect(pageB.getByRole("heading", { name: "Runners", level: 1 })).toBeVisible();
                await pwExpect(pageB.getByText(RUNNER)).toHaveCount(0);
            }
            if (BUILT.runPanel) {
                await pageB.goto(`${BASE}/#/projects/${projectId}/scripts`);
                await pageB.getByRole("button", { name: "Run", exact: true }).click();
                const panel = pageB.getByRole("group", { name: "Run settings" });
                await pwExpect(panel).toBeVisible();
                await pwExpect(panel.getByText(/No runner/).first()).toBeVisible();
                await pwExpect(panel.getByRole("radio", { name: new RegExp(RUNNER) })).toHaveCount(0);
            }
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
