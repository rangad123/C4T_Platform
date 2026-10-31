/**
 * The test recorder and inspector end to end. Real work only: the real API, a real headless Chromium that the platform launches for the
 * recording, and the test plays the person by driving that browser through Playwright (click, fill, select, goto). A fixture
 * application serves the pages. Saved recordings are validated by the real worker. No model, no external site.
 * Runs browsers: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/recorder.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { pidAlive, RecorderService, type Recording } from "../src/platform/recorder-service.js";
import { recorderOf, recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startRecorderApp } from "./fixtures/recorder-app.js";

const PORT = 5990;
const FIXTURE = `http://127.0.0.1:${PORT}`;
const SENTINEL = "TYPED-SENTINEL-4471-zq";
const SENTINEL2 = "OTHER-SENTINEL-8820-xk";
const PROJECT_PASSWORD = "project-pw-9";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let app: http.Server;
let keyed: { dir: string; platform: Platform; server: Awaited<ReturnType<typeof buildServer>> } | undefined;
const launched: Browser[] = [];
const taps: string[] = [];
const standalone: RecorderService[] = [];
let pidA: string;
let pidB: string;

const blockLoopback2 = async (url: string) => {
    if (new URL(url).hostname === "127.0.0.2") throw new Error("Target resolves to a private/loopback address");
};
const launch = async (headless: boolean) => {
    const b = await chromium.launch({ headless });
    launched.push(b);
    return b;
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recorder-"));
    Object.assign(recorderOptions, { launch, guard: blockLoopback2, tap: (m: unknown) => void taps.push(JSON.stringify(m)) });
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    app = await startRecorderApp(PORT);
    pidA = (await call("POST", "/api/projects", { name: "Recorder A" })).body.id;
    pidB = (await call("POST", "/api/projects", { name: "Recorder B" })).body.id;
    // Project A already has an application with sign-in details: a saved recording's password step runs with them.
    platform.repo.createApplication(pidA, FIXTURE, { ...DEFAULT_JOB_OPTIONS }, { username: "tester", password: PROJECT_PASSWORD });
}, 60_000);

afterAll(async () => {
    await Promise.all(standalone.map((s) => s.closeAll().catch(() => undefined)));
    await worker?.stop();
    await server?.close();
    if (keyed) {
        await keyed.server.close();
        keyed.platform.db.close();
        fs.rmSync(keyed.dir, { recursive: true, force: true });
    }
    for (const b of launched) await b.close().catch(() => undefined);
    app?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const call = async (method: Method, url: string, payload?: unknown, headers?: Record<string, string>) => {
    const res = await server.inject({ method, url, payload: payload as never, ...(headers ? { headers } : {}) });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, text };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}
const getRec = async (rid: string): Promise<Recording> => (await call("GET", `/api/recordings/${rid}`)).body;
const stepsAre = (rid: string, n: number) => until(async () => ((await getRec(rid)).steps.length >= n ? await getRec(rid) : undefined), `${n} steps`);

/** Starts a headless recording and returns the page the platform's browser opened, once the first page is loaded. */
async function startRec(projectId: string, pathname: string, extra: Record<string, unknown> = {}) {
    const before = launched.length;
    const res = await call("POST", `/api/projects/${projectId}/recordings`, { url: `${FIXTURE}${pathname}`, headed: false, ...extra });
    expect(res.status, res.text ?? "").toBe(201);
    expect(res.body.status).toBe("starting");
    const rid = res.body.id as string;
    const page = await until<Page>(() => (launched.length > before ? launched[before]!.contexts()[0]?.pages()[0] : undefined), "the recording browser");
    await until(async () => (await getRec(rid)).status === "recording" && page.url().startsWith(FIXTURE) && (await getRec(rid)).steps.length > 0, "recording status");
    await page.waitForLoadState("domcontentloaded");
    await sleep(150); // the first document report reaches the platform
    return { rid, page };
}
const stepsOf = async (rid: string) => (await getRec(rid)).steps;
const quiet = async (ms = 700) => sleep(ms);

async function waitJob(jobId: string) {
    for (let i = 0; i < 400; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await sleep(300);
    }
    throw new Error(`job ${jobId} did not finish`);
}

describe("recorder: access, limits and safety", () => {
    it("is protected by the API key like every other route", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recorder-key-"));
        const p2 = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY: "recorder-key-1" }));
        keyed = { dir, platform: p2, server: await buildServer(p2) };
        const id = "00000000-0000-4000-8000-000000000000";
        const no = await keyed.server.inject({ method: "GET", url: `/api/recordings/${id}` });
        expect(no.statusCode).toBe(401);
        expect((await keyed.server.inject({ method: "POST", url: "/api/projects/x/recordings", payload: { url: FIXTURE } })).statusCode).toBe(401);
        expect((await keyed.server.inject({ method: "POST", url: `/api/recordings/${id}/save`, payload: { title: "abc" } })).statusCode).toBe(401);
        const ok = await keyed.server.inject({ method: "GET", url: `/api/recordings/${id}`, headers: { "x-api-key": "recorder-key-1" } });
        expect(ok.statusCode).toBe(200);
    });

    it("refuses bad input with plain messages: addresses, missing project, headed without a screen", async () => {
        expect((await call("POST", "/api/projects/nope/recordings", { url: FIXTURE })).status).toBe(404);
        const notUrl = await call("POST", `/api/projects/${pidA}/recordings`, { url: "not a url", headed: false });
        expect(notUrl.status).toBe(400);
        expect(notUrl.body.error).toMatch(/http:\/\/ or https:\/\//);
        expect((await call("POST", `/api/projects/${pidA}/recordings`, { url: "file:///etc/passwd", headed: false })).status).toBe(400);
        expect((await call("GET", "/api/recordings/not-an-id")).status).toBe(404);
        expect((await call("POST", "/api/recordings/not-an-id/stop")).status).toBe(404);
        // Linux with no display server: a headed window cannot be watched there
        const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")!;
        const savedDisplay = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY };
        try {
            Object.defineProperty(process, "platform", { value: "linux" });
            delete process.env.DISPLAY;
            delete process.env.WAYLAND_DISPLAY;
            const headed = await call("POST", `/api/projects/${pidA}/recordings`, { url: FIXTURE });
            expect(headed.status).toBe(422);
            expect(headed.body.error).toMatch(/no screen.*Show the browser|turn .*off/i);
        } finally {
            Object.defineProperty(process, "platform", platformDesc);
            if (savedDisplay.d !== undefined) process.env.DISPLAY = savedDisplay.d;
            if (savedDisplay.w !== undefined) process.env.WAYLAND_DISPLAY = savedDisplay.w;
        }
    });

    it("an environment supplies the base address; production needs the same confirmation as a run", async () => {
        expect((await call("POST", `/api/projects/${pidB}/environments`, { name: "staging", baseUrl: FIXTURE })).status).toBe(201);
        expect((await call("POST", `/api/projects/${pidB}/environments`, { name: "live", baseUrl: FIXTURE, production: true })).status).toBe(201);
        const unknown = await call("POST", `/api/projects/${pidB}/recordings`, { url: "/shop", headed: false, environment: "nowhere" });
        expect(unknown.status).toBe(404);
        const refused = await call("POST", `/api/projects/${pidB}/recordings`, { url: "/shop", headed: false, environment: "live" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/production/);
        const elsewhere = await call("POST", `/api/projects/${pidB}/recordings`, { url: "http://example.invalid/", headed: false, environment: "staging" });
        expect(elsewhere.status).toBe(400);
        const { rid, page } = await startRec(pidB, "", { url: "/shop", environment: "staging" });
        const r = await getRec(rid);
        expect(r.startUrl).toBe(`${FIXTURE}/shop`);
        expect(r.environment).toBe("staging");
        expect(page.url()).toBe(`${FIXTURE}/shop`);
        expect((await call("DELETE", `/api/recordings/${rid}`)).status).toBe(200);
        const confirmed = await startRec(pidB, "", { url: "/", environment: "live", confirmProduction: true });
        expect((await getRec(confirmed.rid)).environment).toBe("live");
        expect((await call("DELETE", `/api/recordings/${confirmed.rid}`)).status).toBe(200);
    }, 60_000);
});

describe("recorder: one long journey (login, inspect, shop, edit, share, stop, save, validate)", () => {
    let rid: string;
    let page: Page;
    let otherRid: string;
    let pid: number | undefined;
    let mainBrowser: Browser;
    let savedTestId: string;

    it("starts a session, one per project, and another project may record at the same time", async () => {
        ({ rid, page } = await startRec(pidA, "/login"));
        const r = await getRec(rid);
        expect(r).toMatchObject({ projectId: pidA, status: "recording", startUrl: `${FIXTURE}/login`, headed: false, canSave: false, inspect: { on: false, mode: "locator" } });
        expect(r.steps).toHaveLength(1);
        expect(r.steps[0]).toMatchObject({ index: 0, kind: "goto", url: `${FIXTURE}/login`, describe: `Open ${FIXTURE}/login` });
        mainBrowser = launched[launched.length - 1]!;
        pid = recorderOf(server)!.pidOf(rid);
        expect(pid).toBeTypeOf("number");
        expect(pidAlive(pid!)).toBe(true);

        const second = await call("POST", `/api/projects/${pidA}/recordings`, { url: FIXTURE, headed: false });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already has a recording/);
        expect(second.body.details).toEqual({ recordingId: rid }); // another tab can offer to watch it

        // project B records at the same time, independently
        const b = await startRec(pidB, "/shop");
        otherRid = b.rid;
        await b.page.click("#add");
        const bSteps = (await stepsAre(otherRid, 2)).steps;
        expect(bSteps.map((s) => s.kind)).toEqual(["goto", "click"]);
        expect((await getRec(rid)).steps).toHaveLength(1);
        expect((await getRec(otherRid)).projectId).toBe(pidB);
    }, 60_000);

    it("records a login: typed values, a password that never leaves the page, a click that navigates without a goto", async () => {
        await page.fill("#email", "tester@example.test");
        await page.fill("#pw", SENTINEL);
        await page.click("text=Sign in");
        await page.waitForURL("**/welcome");
        const r = await stepsAre(rid, 4);
        await quiet();
        const steps = (await getRec(rid)).steps;
        expect(steps.map((s) => s.kind)).toEqual(["goto", "fill", "fill", "click"]);

        expect(steps[1]!.locator).toMatchObject({ strategy: "role", value: "textbox", name: "Email", exact: true });
        expect(steps[1]!.value).toBe("tester@example.test");
        expect(steps[1]!.matches).toBe(1);
        expect(steps[1]!.alternatives!.map((a) => a.locator.strategy)).toContain("label");
        expect(steps[1]!.describe).toBe('Type "tester@example.test" into the text field "Email"');

        expect(steps[2]).toMatchObject({ kind: "fill", secret: true, value: "{{credentials.password}}" });
        expect(steps[2]!.locator).toMatchObject({ strategy: "label", value: "Password" });
        expect(steps[2]!.describe).toBe('Type the password into the field labelled "Password"');

        expect(steps[3]!.locator).toMatchObject({ strategy: "role", value: "button", name: "Sign in" });
        expect(steps[3]!.describe).toBe('Click the button "Sign in"');
        expect(r.currentUrl).toContain("/welcome");

        // nothing the person typed into the password field is anywhere the platform can see
        expect(taps.length).toBeGreaterThan(3);
        expect(taps.join("\n")).not.toContain(SENTINEL);
        expect(JSON.stringify(r)).not.toContain(SENTINEL);
        expect(taps.join("\n")).toContain("tester@example.test"); // ordinary fields are recorded as typed
    });

    it("assertion mode: a click appends an assert step and does not act on the page", async () => {
        const on = await call("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "text" });
        expect(on.status).toBe(200);
        expect(on.body.inspect).toEqual({ on: true, mode: "assertion", assertCheck: "text" });
        await page.click("h1");
        const r = await stepsAre(rid, 5);
        expect(r.steps[4]).toMatchObject({ kind: "assert", assert: { check: "text", expected: "Welcome back" }, matches: 1 });
        expect(r.steps[4]!.locator).toEqual({ strategy: "testId", value: "welcome" });
        expect(r.picked).toMatchObject({ tag: "h1", text: "Welcome back" });
        expect(r.steps[4]!.describe).toBe('Check that the element with test id "welcome" shows "Welcome back"');
        const off = await call("POST", `/api/recordings/${rid}/inspect`, { on: false });
        expect(off.body.inspect.on).toBe(false);
        await page.click("a"); // normal behaviour again: the click goes through, is recorded, and the navigation is not a goto
        await page.waitForURL("**/shop");
        const after = await stepsAre(rid, 6);
        await quiet();
        const steps = (await getRec(rid)).steps;
        expect(steps.map((s) => s.kind)).toEqual(["goto", "fill", "fill", "click", "assert", "click"]);
        expect(steps[5]!.locator).toMatchObject({ strategy: "role", value: "link", name: "Shop" });
        expect(after.currentUrl).toContain("/shop");
    });

    it("locator mode: hovering shows an overlay, a click only picks (candidates with match counts) and the page does not change", async () => {
        await call("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "locator" });
        await page.hover("#add");
        const label = await until(async () => {
            // the overlay is in a closed shadow root: only its box is visible from outside, as a fixed element at the end of <html>
            return page.evaluate(() => document.documentElement.lastElementChild?.tagName === "DIV" && (document.documentElement.lastElementChild as HTMLElement).style.zIndex === "2147483647");
        }, "the inspector overlay");
        expect(label).toBe(true);
        await page.click("#add");
        await sleep(400);
        expect(await page.textContent("#status")).toBe("Nothing in the cart");
        const r = await until(async () => ((await getRec(rid)).picked ? await getRec(rid) : undefined), "a pick");
        expect(r.steps).toHaveLength(6);
        expect(r.picked!.locator).toMatchObject({ strategy: "role", value: "button", name: "Add to cart" });
        expect(r.picked!.tag).toBe("button");
        expect(r.picked!.alternatives.length).toBeGreaterThan(0);
        expect(r.picked!.alternatives.length).toBeLessThanOrEqual(4);
        expect(r.picked!.alternatives.every((a) => a.matches >= 1)).toBe(true);
        await call("POST", `/api/recordings/${rid}/inspect`, { on: false });
        // and the overlay is gone
        expect(await page.evaluate(() => (document.documentElement.lastElementChild as HTMLElement).style.zIndex)).not.toBe("2147483647");
    });

    it("records clicks, select, check/uncheck, one fill per field with the final value, Enter, and merges a double fill", async () => {
        await page.click("#add");
        await stepsAre(rid, 7);
        expect(await page.textContent("#status")).toBe("Cart: 1 item");
        await call("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "text" });
        await page.click("#status");
        const withAssert = await stepsAre(rid, 8);
        expect(withAssert.steps[7]).toMatchObject({ kind: "assert", assert: { check: "text", expected: "Cart: 1 item" } });
        // the text looks generated (a counter), so the locator is the element's id, not its text
        expect(withAssert.steps[7]!.locator).toEqual({ strategy: "css", value: "#status" });
        await call("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "count" });
        await page.click("#items");
        const withCount = await stepsAre(rid, 9);
        expect(withCount.steps[8]).toMatchObject({ kind: "assert", assert: { check: "count", expected: 3 }, matches: 3 });
        expect(withCount.steps[8]!.locator).toEqual({ strategy: "css", value: "#items > li" });
        await call("POST", `/api/recordings/${rid}/inspect`, { on: false });

        await page.selectOption("#colour", "blue");
        await page.check("#gift");
        await page.uncheck("#gift");
        await page.fill("#code", "SAVE");
        await page.fill("#code", "SAVE10");
        await page.press("#code", "Enter");
        await until(async () => (await stepsOf(rid)).some((s) => s.kind === "press"), "the Enter key press");
        const steps = await stepsOf(rid);
        expect(steps.slice(9).map((s) => s.kind)).toEqual(["select", "check", "uncheck", "fill", "press"]);
        expect(steps[9]).toMatchObject({ value: "blue", locator: { strategy: "role", value: "combobox", name: "Colour" } });
        expect(steps[10]!.locator).toMatchObject({ strategy: "role", value: "checkbox", name: "Gift wrap" });
        expect(steps[10]!.describe).toBe('Tick the checkbox "Gift wrap"');
        expect(steps[11]!.describe).toBe('Untick the checkbox "Gift wrap"');
        expect(steps[12]).toMatchObject({ value: "SAVE10", describe: 'Type "SAVE10" into the text field "Coupon code"' });
        expect(steps[13]).toMatchObject({ value: "Enter", describe: 'Press Enter in the text field "Coupon code"' });

        // value assertion on the field, then a refused one on the password field
        await call("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "value" });
        await page.click("#code");
        const v = await stepsAre(rid, 15);
        expect(v.steps[14]).toMatchObject({ kind: "assert", assert: { check: "value", expected: "SAVE10" } });
        await call("POST", `/api/recordings/${rid}/inspect`, { on: false });
    }, 60_000);

    it("a position-based locator is used when a name is shared, and says so; ambiguous candidates keep their counts", async () => {
        await page.click("#items li:nth-child(2) .del");
        const r = await stepsAre(rid, 16);
        const del = r.steps[15]!;
        expect(del.kind).toBe("click");
        expect(del.locator!.strategy).toBe("css");
        expect(del.matches).toBe(1);
        expect(del.describe).toContain("found by its place on the page");
        const byName = del.alternatives!.find((a) => a.locator.strategy === "role");
        expect(byName).toMatchObject({ matches: 3, locator: { value: "button", name: "Delete" } });
        expect(await page.locator("#items li").count()).toBe(2);
    });

    it("a file chosen in the page becomes an upload step by name only, and the recorder asks for the file in the test files", async () => {
        // Changed with the frames/uploads/popups work: uploads are now recorded (the file's name only; the content comes from the project's test files).
        const file = path.join(dataDir, "upload.txt");
        fs.writeFileSync(file, "hello");
        const before = (await getRec(rid)).steps.length;
        await page.setInputFiles("#file", file);
        const r = await until(async () => ((await getRec(rid)).notes.some((n) => /add “upload.txt” to the project's test files/.test(n)) ? await getRec(rid) : undefined), "the upload note");
        expect(r.steps).toHaveLength(before + 1);
        const up = r.steps[r.steps.length - 1]!;
        expect(up.kind).toBe("upload");
        expect(JSON.stringify(up)).not.toContain("hello"); // the file's content never reaches the platform
        // remove it so the rest of the journey keeps its step numbers
        await call("DELETE", `/api/recordings/${rid}/steps/${r.steps.length - 1}`);
        expect((await getRec(rid)).steps).toHaveLength(before);
    });

    it("a typed address becomes a goto; a test id beats a role name that is shared; text is used when it is all there is", async () => {
        await sleep(2800); // longer than the time an action is credited for a navigation
        await page.goto(`${FIXTURE}/testid`);
        await until(async () => (await stepsOf(rid)).some((s) => s.kind === "goto" && s.url?.endsWith("/testid")), "a goto");
        await page.click("[data-testid=buy-now]");
        const r = await stepsAre(rid, 18);
        const buy = r.steps[17]!;
        expect(buy.locator).toEqual({ strategy: "testId", value: "buy-now" });
        expect(buy.matches).toBe(1);
        expect(buy.alternatives!.find((a) => a.locator.strategy === "role")).toMatchObject({ matches: 2 });
        expect(buy.alternatives!.some((a) => /btn-a8f3k2x1/.test(a.locator.value))).toBe(false);

        await sleep(2800);
        await page.goto(`${FIXTURE}/textonly`);
        await until(async () => (await stepsOf(rid)).some((s) => s.kind === "goto" && s.url?.endsWith("/textonly")), "a second goto");
        await page.click("#toggle");
        const t = await stepsAre(rid, 20);
        expect(t.steps[19]!.locator).toMatchObject({ strategy: "text", value: "Show details", exact: true });
        expect(t.steps[19]!.matches).toBe(1);
    }, 60_000);

    it("a new tab is not recorded and the recorder says so", async () => {
        await sleep(2800);
        await page.goto(`${FIXTURE}/newtab`);
        await until(async () => (await stepsOf(rid)).some((s) => s.kind === "goto" && s.url?.endsWith("/newtab")), "a goto to the new tab page");
        const popup = page.waitForEvent("popup");
        await page.click("a");
        await popup;
        const r = await until(async () => ((await getRec(rid)).notes.some((n) => /new tab/i.test(n)) ? await getRec(rid) : undefined), "the new tab note");
        expect(r.steps.filter((s) => s.kind === "click").pop()!.locator).toMatchObject({ strategy: "role", value: "link" }); // the click itself is recorded
        await popup.then((p) => p.close());
        // remove the last two steps (the new-tab page and its link) so the saved test stays on one page
        await call("DELETE", `/api/recordings/${rid}/steps/${r.steps.length - 1}`);
        await call("DELETE", `/api/recordings/${rid}/steps/${r.steps.length - 2}`);
        expect((await getRec(rid)).steps).toHaveLength(20);
    }, 60_000);

    it("editing: choose another locator, edit a typed value and an assertion, delete a step; a secret's value cannot be edited", async () => {
        const base = await getRec(rid);
        // pick another locator from the alternatives (the Email field: role -> label)
        const email = base.steps[1]!;
        const label = email.alternatives!.find((a) => a.locator.strategy === "label")!;
        const p1 = await call("PATCH", `/api/recordings/${rid}/steps/1`, { locator: label.locator });
        expect(p1.status).toBe(200);
        expect(p1.body.steps[1].locator).toMatchObject({ strategy: "label", value: "Email" });
        expect(p1.body.steps[1].matches).toBe(label.matches);
        expect(p1.body.steps[1].alternatives.some((a: { locator: { strategy: string } }) => a.locator.strategy === "role")).toBe(true);
        expect(p1.body.steps[1].describe).toBe('Type "tester@example.test" into the field labelled "Email"');

        const p2 = await call("PATCH", `/api/recordings/${rid}/steps/1`, { value: "someone@example.test" });
        expect(p2.body.steps[1].value).toBe("someone@example.test");
        expect(p2.body.steps[1].describe).toContain("someone@example.test");

        const secret = await call("PATCH", `/api/recordings/${rid}/steps/2`, { value: "my-real-password" });
        expect(secret.status).toBe(400);
        expect(secret.body.error).toMatch(/secret/);
        expect((await getRec(rid)).steps[2]!.value).toBe("{{credentials.password}}");

        const a1 = await call("PATCH", `/api/recordings/${rid}/steps/4`, { assert: { check: "text", expected: "Welcome" } });
        expect(a1.body.steps[4].assert).toEqual({ check: "text", expected: "Welcome" });
        expect(a1.body.steps[4].describe).toContain('shows "Welcome"');
        expect((await call("PATCH", `/api/recordings/${rid}/steps/4`, { assert: { check: "text", expected: "" } })).status).toBe(400);
        expect((await call("PATCH", `/api/recordings/${rid}/steps/1`, { assert: { check: "visible" } })).status).toBe(400);
        expect((await call("PATCH", `/api/recordings/${rid}/steps/99`, { value: "x" })).status).toBe(404);
        expect((await call("PATCH", `/api/recordings/${rid}/steps/1`, {})).status).toBe(400);
        // put both back so the test that is saved later is the one that was recorded
        await call("PATCH", `/api/recordings/${rid}/steps/1`, { locator: email.locator, value: "tester@example.test" });
        await call("PATCH", `/api/recordings/${rid}/steps/4`, { assert: { check: "text", expected: "Welcome back" } });

        // delete: indexes close up (the "untick" step goes; the checkbox simply stays ticked in the replay)
        expect(base.steps[11]!.kind).toBe("uncheck");
        const del = await call("DELETE", `/api/recordings/${rid}/steps/11`);
        expect(del.body.steps.map((s: { index: number }) => s.index)).toEqual([...Array(19).keys()]);
        expect((await call("DELETE", `/api/recordings/${rid}/steps/99`)).status).toBe(404);
    }, 60_000);

    it("a step's locator can be shared as an element of the object repository", async () => {
        const steps = await stepsOf(rid);
        const idx = steps.findIndex((s) => s.kind === "click" && s.locator?.name === "Sign in");
        const shared = await call("POST", `/api/recordings/${rid}/steps/${idx}/share`, { name: "Login / Sign in button" });
        expect(shared.status).toBe(200);
        expect(shared.body.steps[idx].ref).toBe("Login / Sign in button");
        const objects = (await call("GET", `/api/projects/${pidA}/objects`)).body;
        expect(objects.elements.map((e: { name: string }) => e.name)).toContain("Login / Sign in button");
        const el = objects.elements.find((e: { name: string }) => e.name === "Login / Sign in button");
        expect(el.kind).toBe("web");
        expect(el.locator).toMatchObject({ by: "role", role: "button", value: "Sign in" });
        // the same name with another locator is refused; the same name and locator is reused
        const clash = await call("POST", `/api/recordings/${rid}/steps/${steps.findIndex((s) => s.kind === "click" && s.locator?.name === "Shop")}/share`, { name: "Login / Sign in button" });
        expect(clash.status).toBe(409);
        expect((await call("POST", `/api/recordings/${rid}/steps/${idx}/share`, { name: "Login / Sign in button" })).status).toBe(200);
        expect((await call("POST", `/api/recordings/${rid}/steps/0/share`, { name: "Not an element" })).status).toBe(400);
        expect((await call("POST", `/api/recordings/${rid}/steps/${idx}/share`, { name: "bad/name%%" })).status).toBe(400);
    });

    it("stop closes the browser, keeps the steps, and a stopped recording cannot be inspected", async () => {
        await stepsAre(rid, 19);
        const stopped = await call("POST", `/api/recordings/${rid}/stop`);
        expect(stopped.status).toBe(200);
        expect(stopped.body.status).toBe("stopped");
        expect(stopped.body.stoppedAt).toBeTruthy();
        expect(stopped.body.canSave).toBe(true);
        expect(stopped.body.steps.length).toBeGreaterThan(15);
        expect(pidAlive(pid!)).toBe(false);
        expect(mainBrowser.isConnected()).toBe(false);
        expect((await call("POST", `/api/recordings/${rid}/inspect`, { on: true })).status).toBe(409);
        // project B's recording was not affected
        expect((await getRec(otherRid)).status).toBe("recording");
        expect((await call("POST", `/api/recordings/${otherRid}/stop`)).body.status).toBe("stopped");
        expect(taps.join("\n")).not.toContain(SENTINEL);
    });

    it("saves a normal web test (origin recorded) and a real run of the recorded steps validates it", async () => {
        const saved = await call("POST", `/api/recordings/${rid}/save`, { title: "Sign in, shop and check", category: "Recorded flows" });
        expect(saved.status, saved.text ?? "").toBe(201);
        expect(saved.body.testKey).toMatch(/^WEB-\d+$/);
        expect(saved.body.jobId).toBeTruthy();
        savedTestId = saved.body.testId;
        const rec = await getRec(rid);
        expect(rec).toMatchObject({ status: "saved", savedTestId });
        expect((await call("POST", `/api/recordings/${rid}/save`, { title: "Again please" })).status).toBe(409);

        const test = (await call("GET", `/api/tests/${savedTestId}`)).body;
        expect(test.spec).toMatchObject({ kind: "web", title: "Sign in, shop and check", category: "Recorded flows", source: { origin: "recorded" } });
        const specText = JSON.stringify(test.spec);
        expect(specText).not.toContain(SENTINEL);
        expect(specText).toContain("{{credentials.password}}");
        expect(test.spec.steps.some((s: { locator?: { ref?: string } }) => s.locator?.ref === "Login / Sign in button")).toBe(true);
        const script = test.scripts[0].content as string;
        expect(script).not.toContain(SENTINEL);
        expect(script).toContain('getByRole("button", { name: "Sign in"');

        const job = await waitJob(saved.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const after = (await call("GET", `/api/tests/${savedTestId}`)).body;
        expect(after.validationStatus, JSON.stringify(after.validationReason)).toBe("VALIDATED");
        // nothing typed in the password field reached the database, the stored scripts or the artifacts
        const hay = [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((f) => fs.existsSync(f));
        for (const f of hay) expect(fs.readFileSync(f).includes(Buffer.from(SENTINEL))).toBe(false);
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
        for (const f of walk(dataDir).filter((f) => /\.(json|txt|ts|js|log|html|md)$/.test(f))) expect(fs.readFileSync(f, "utf8")).not.toContain(SENTINEL);
        // project A has the new test; project B has none
        expect((await call("GET", `/api/projects/${pidA}/tests`)).body.some((t: { id: string }) => t.id === savedTestId)).toBe(true);
        expect((await call("GET", `/api/projects/${pidB}/tests`)).body).toEqual([]);
    }, 180_000);
});

describe("recorder: secrets, inspect refusals and a recording that fails on replay", () => {
    it("a password's value cannot be asserted, one-time codes and card fields are redacted too, and nothing typed reaches the platform", async () => {
        const { rid, page } = await startRec(pidB, "/login");
        await page.fill("#pw", SENTINEL2);
        await page.evaluate(() => {
            const i = document.createElement("input");
            i.id = "otp";
            i.setAttribute("autocomplete", "one-time-code");
            i.setAttribute("aria-label", "Code");
            document.body.appendChild(i);
            const c = document.createElement("input");
            c.id = "card";
            c.setAttribute("aria-label", "Card number");
            c.setAttribute("autocomplete", "cc-number");
            document.body.appendChild(c);
        });
        await page.fill("#otp", "123456-OTPSENTINEL");
        await page.fill("#card", "4242424242424242");
        await page.fill("#email", "p@example.test");
        await page.click("h1"); // leaving the field ends the typing
        const r = await until(async () => ((await getRec(rid)).steps.length >= 5 ? await getRec(rid) : undefined), "five steps");
        expect(r.steps.map((s) => [s.kind, s.value])).toEqual([
            ["goto", undefined], ["fill", "{{credentials.password}}"], ["fill", "{{credentials.totp}}"], ["fill", "{{secret.card_number}}"], ["fill", "p@example.test"],
        ]);
        expect(r.steps.slice(1, 4).every((s) => s.secret === true)).toBe(true);
        expect(r.steps[4]!.secret).toBeUndefined();
        const all = taps.join("\n") + JSON.stringify(r);
        for (const bad of [SENTINEL2, "OTPSENTINEL", "4242424242424242"]) expect(all).not.toContain(bad);

        // asserting the value of a secret field is refused (nothing appended, and the pick carries no value)
        await call("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "value" });
        await page.click("#pw");
        const picked = await until(async () => ((await getRec(rid)).picked ? await getRec(rid) : undefined), "a pick");
        expect(picked.steps).toHaveLength(5);
        expect(picked.notes.join(" ")).toMatch(/never recorded/);
        expect(JSON.stringify(picked.picked)).not.toContain(SENTINEL2);
        await call("POST", `/api/recordings/${rid}/inspect`, { on: false });

        // a secret step is also protected from edits and deleting it keeps the rest
        expect((await call("PATCH", `/api/recordings/${rid}/steps/1`, { value: "typed-by-hand" })).status).toBe(400);
        expect((await call("DELETE", `/api/recordings/${rid}/steps/1`)).body.steps).toHaveLength(4);
        await call("DELETE", `/api/recordings/${rid}`);
    }, 60_000);

    it("a recording that does not replay is saved as a test that is not validated (never passing)", async () => {
        const { rid, page } = await startRec(pidA, "/shop");
        await page.click("#add");
        await stepsAre(rid, 2);
        // the person (or an edit) points the click at something that is not on the page
        expect((await call("PATCH", `/api/recordings/${rid}/steps/1`, { locator: { strategy: "css", value: "#does-not-exist" } })).status).toBe(200);
        const saved = await call("POST", `/api/recordings/${rid}/save`, { title: "Broken on replay" });
        expect(saved.status, saved.text ?? "").toBe(201);
        expect((await getRec(rid)).status).toBe("saved");
        expect(recorderOf(server)!.pidOf(rid)).toSatisfy((p: number | undefined) => p === undefined || !pidAlive(p));
        const job = await waitJob(saved.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"]).toContain(job.status);
        const t = (await call("GET", `/api/tests/${saved.body.testId}`)).body;
        expect(t.validationStatus).not.toBe("VALIDATED");
        expect(["FAILED_VALIDATION", "NEEDS_REVIEW"]).toContain(t.validationStatus);
    }, 180_000);

    it("a recording with nothing but the first page cannot be saved; discard closes the browser and forgets the session", async () => {
        const { rid } = await startRec(pidB, "/shop");
        const pid = recorderOf(server)!.pidOf(rid)!;
        const save = await call("POST", `/api/recordings/${rid}/save`, { title: "Nothing here" });
        expect(save.status).toBe(409);
        expect(save.body.error).toMatch(/nothing to save/i);
        expect((await getRec(rid)).status).toBe("recording"); // a refused save leaves the session running
        const discarded = await call("DELETE", `/api/recordings/${rid}`);
        expect(discarded.body).toEqual({ ok: true });
        expect(pidAlive(pid)).toBe(false);
        const gone = await getRec(rid);
        expect(gone.status).toBe("failed");
        expect(gone.error).toMatch(/gone/);
        expect((await call("POST", `/api/recordings/${rid}/stop`)).status).toBe(404);
    }, 60_000);

    it("closing the recording window ends the session with the steps kept and no browser left", async () => {
        const { rid, page } = await startRec(pidB, "/shop");
        const pid = recorderOf(server)!.pidOf(rid)!;
        await page.click("#add");
        await stepsAre(rid, 2);
        await page.close();
        const r = await until(async () => ((await getRec(rid)).status === "stopped" ? await getRec(rid) : undefined), "the session to stop");
        expect(r.steps).toHaveLength(2);
        expect(r.canSave).toBe(true);
        await until(() => !pidAlive(pid), "the browser process to end");
        await call("DELETE", `/api/recordings/${rid}`);
    }, 60_000);
});

describe("recorder: timeouts, blocked addresses, step cap (service level, short caps)", () => {
    const make = (caps: ConstructorParameters<typeof RecorderService>[0] = {}) => {
        const s = new RecorderService({ launch, guard: blockLoopback2, ...caps });
        standalone.push(s);
        return s;
    };
    // On a time-out, say where the session actually ended (a bare "timed out" hid that the flaky case ended as failed, not stopped).
    const waitStatus = (s: RecorderService, id: string, status: Recording["status"]) =>
        until(() => (s.get(id)!.status === status ? s.get(id)! : undefined), `status ${status}`, 60_000).catch((e: Error) => {
            throw new Error(`${e.message}; it is ${s.get(id)?.status}: ${s.get(id)?.error ?? ""}`);
        });
    const pageOf = (before: number) => until<Page>(() => (launched.length > before ? launched[before]!.contexts()[0]?.pages()[0] : undefined), "the browser");

    it("ends after the idle time and after the total time, keeping the steps and closing the browser", async () => {
        const idle = make({ caps: { idleMs: 1_500, totalMs: 120_000 } });
        const before = launched.length;
        const r = idle.start("p-idle", { url: `${FIXTURE}/shop`, headed: false });
        await pageOf(before);
        const stopped = await waitStatus(idle, r.id, "stopped");
        expect(stopped.notes.join(" ")).toMatch(/without activity/);
        expect(stopped.steps).toHaveLength(1);
        expect(idle.pidOf(r.id)).toSatisfy((p: number | undefined) => p !== undefined && !pidAlive(p));

        const total = make({ caps: { idleMs: 120_000, totalMs: 2_000 } });
        const b2 = launched.length;
        const t = total.start("p-total", { url: `${FIXTURE}/shop`, headed: false });
        const page = await pageOf(b2);
        const stoppedAfterTotal = await waitStatus(total, t.id, "stopped");
        expect(stoppedAfterTotal.notes.join(" ")).toMatch(/longest a recording may run/);
        expect(page.isClosed()).toBe(true);
        expect(total.pidOf(t.id)).toSatisfy((p: number | undefined) => p !== undefined && !pidAlive(p));
    }, 90_000);

    it("a start address the guard refuses never opens a browser; a move to a refused address stops the session", async () => {
        const s = make();
        const count = launched.length;
        const bad = s.start("p-bad", { url: `http://127.0.0.2:${PORT}/`, headed: false });
        const failed = await waitStatus(s, bad.id, "failed");
        expect(failed.error).toMatch(/private\/loopback/);
        expect(launched.length).toBe(count);

        const before = launched.length;
        const ok = s.start("p-redirect", { url: `${FIXTURE}/`, headed: false });
        const page = await pageOf(before);
        await until(() => s.get(ok.id)!.status === "recording", "recording");
        await page.goto(`${FIXTURE}/redirect`).catch(() => undefined); // the browser is refused at the hop to 127.0.0.2
        const stopped = await waitStatus(s, ok.id, "stopped");
        expect(stopped.error).toMatch(/127\.0\.0\.2.*does not allow testing/);
        expect(stopped.steps.map((x) => x.kind)).toEqual(["goto"]);
        expect(s.pidOf(ok.id)).toSatisfy((p: number | undefined) => p !== undefined && !pidAlive(p));
    }, 150_000);

    it("moving on while the start page still loads is not a failed recording: the move to a refused address stops it, an allowed one keeps recording", async () => {
        // The root cause of the old flaky test above: the start page's aborted load used to fail the whole session ("Could not open …").
        const s = make();
        const b1 = launched.length;
        const refused = s.start("p-race-1", { url: `${FIXTURE}/slow`, headed: false });
        const page1 = await pageOf(b1);
        await until(() => s.get(refused.id)!.status === "recording", "recording");
        await page1.goto(`${FIXTURE}/redirect`).catch(() => undefined);
        const stopped = await waitStatus(s, refused.id, "stopped");
        expect(stopped.error).toMatch(/127\.0\.0\.2.*does not allow testing/);

        const b2 = launched.length;
        const allowed = s.start("p-race-2", { url: `${FIXTURE}/slow`, headed: false });
        const page2 = await pageOf(b2);
        await until(() => s.get(allowed.id)!.status === "recording", "recording");
        await page2.goto(`${FIXTURE}/shop`);
        await sleep(1_500); // longer than the recorder's wait for the replacing navigation
        expect(s.get(allowed.id)!.status).toBe("recording");
        expect(s.get(allowed.id)!.error).toBeUndefined();
        await s.stop(allowed.id);
    }, 90_000);

    it("stops recording at the step cap and says so", async () => {
        const s = make({ caps: { maxSteps: 3 } });
        const before = launched.length;
        const r = s.start("p-cap", { url: `${FIXTURE}/shop`, headed: false });
        const page = await pageOf(before);
        await until(() => s.get(r.id)!.status === "recording", "recording");
        await sleep(200);
        for (let i = 0; i < 4; i++) {
            await page.click("#add");
            await sleep(250);
        }
        const rec = await until(() => (s.get(r.id)!.notes.some((n) => /3-step limit/.test(n)) ? s.get(r.id)! : undefined), "the cap note");
        expect(rec.steps).toHaveLength(3);
        await s.stop(r.id);
        expect(pidAlive(s.pidOf(r.id)!)).toBe(false);
    }, 60_000);

    it("closeAll (platform shutdown) closes every browser it started", async () => {
        const s = make();
        const before = launched.length;
        const a = s.start("p-a", { url: `${FIXTURE}/shop`, headed: false });
        await pageOf(before);
        await until(() => s.get(a.id)!.status === "recording", "recording");
        const pid = s.pidOf(a.id)!;
        expect(pidAlive(pid)).toBe(true);
        await s.closeAll();
        expect(pidAlive(pid)).toBe(false);
    }, 60_000);
});
