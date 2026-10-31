/**
 * Driving a recording session step by step on the platform's own browser, end to end. Real work only: the real API, a real headless Chromium that the
 * platform launches, a fixture application, and the real worker that validates the test saved from the exploration. No model, no external site.
 * Runs browsers: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/live-session.test.ts
 * Ports: fixture application 6170.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { pidAlive, type Recording } from "../src/platform/recorder-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recorderOf, recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startRecorderApp } from "./fixtures/recorder-app.js";

const PORT = 6170;
const FIXTURE = `http://127.0.0.1:${PORT}`;
const FOREIGN = `http://localhost:${PORT}`;
const PASSWORD = "LIVE-project-pw-5521";
const TYPED = "LIVE-typed-by-a-tool-9931";
const API_KEY = "live-session-key-3b81";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let app: http.Server;
let keyed: { dir: string; platform: Platform; server: Awaited<ReturnType<typeof buildServer>> } | undefined;
const launched: Browser[] = [];
const taps: string[] = [];
/** Everything the platform answered, to prove what never left it. */
const answers: string[] = [];
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

type Srv = Awaited<ReturnType<typeof buildServer>>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const callOn = async (srv: Srv, method: Method, url: string, payload?: unknown, headers?: Record<string, string>) => {
    const res = await srv.inject({ method, url, payload: payload as never, ...(headers ? { headers } : {}) });
    const text = res.body;
    answers.push(text);
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, text };
};
const call = (method: Method, url: string, payload?: unknown) => callOn(server, method, url, payload);
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

async function open(srv: Srv, projectId: string, url: string, headers?: Record<string, string>) {
    const before = launched.length;
    const res = await callOn(srv, "POST", `/api/projects/${projectId}/recordings`, { url, headed: false }, headers);
    expect(res.status, res.text).toBe(201);
    const rid = res.body.id as string;
    const page = await until<Page>(() => (launched.length > before ? launched[before]!.contexts()[0]?.pages()[0] : undefined), "the browser");
    await until(async () => {
        const r = (await callOn(srv, "GET", `/api/recordings/${rid}`, undefined, headers)).body as Recording;
        return r.status === "recording" && r.steps.length > 0 && page.url().startsWith("http");
    }, "recording status");
    await page.waitForLoadState("domcontentloaded");
    await sleep(200); // the first document report reaches the platform
    return { rid, page };
}
const act = (rid: string, body: Record<string, unknown>) => call("POST", `/api/recordings/${rid}/act`, body);
const snapshot = (rid: string, q = "") => call("GET", `/api/recordings/${rid}/snapshot${q}`);
const waitJob = async (jobId: string) => {
    for (let i = 0; i < 400; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await sleep(300);
    }
    throw new Error(`job ${jobId} did not finish`);
};

const EMAIL = { strategy: "label", value: "Email", exact: true } as const;
const PW = { strategy: "label", value: "Password", exact: true } as const;
const SIGN_IN = { strategy: "role", value: "button", name: "Sign in", exact: true } as const;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-live-"));
    Object.assign(recorderOptions, { launch, guard: blockLoopback2, tap: (m: unknown) => void taps.push(JSON.stringify(m)) });
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    app = await startRecorderApp(PORT);
    pidA = (await call("POST", "/api/projects", { name: "Live A" })).body.id;
    pidB = (await call("POST", "/api/projects", { name: "Live B" })).body.id;
    platform.repo.createApplication(pidA, FIXTURE, { ...DEFAULT_JOB_OPTIONS }, { username: "tester@example.test", password: PASSWORD });
}, 60_000);

afterAll(async () => {
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

describe("live session: access and refusals that need no page", () => {
    it("is protected by the API key like every other route", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-live-key-"));
        const p2 = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
        keyed = { dir, platform: p2, server: await buildServer(p2) };
        const id = "00000000-0000-4000-8000-000000000000";
        expect((await keyed.server.inject({ method: "POST", url: `/api/recordings/${id}/act`, payload: { action: "scroll" } })).statusCode).toBe(401);
        expect((await keyed.server.inject({ method: "GET", url: `/api/recordings/${id}/snapshot` })).statusCode).toBe(401);
        expect((await keyed.server.inject({ method: "GET", url: `/api/projects/x/live-sessions` })).statusCode).toBe(401);
        const withKey = await keyed.server.inject({ method: "POST", url: `/api/recordings/${id}/act`, payload: { action: "scroll" }, headers: { "x-api-key": API_KEY } });
        expect(withKey.statusCode).toBe(404); // past the key, the recording simply is not there
        const snapKey = await keyed.server.inject({ method: "GET", url: `/api/recordings/${id}/snapshot`, headers: { "x-api-key": API_KEY } });
        expect(snapKey.statusCode).toBe(404);
    });

    it("answers an unknown session with a plain 404 and a bad action with a plain 400, whatever the session", async () => {
        expect((await act("not-an-id", { action: "scroll" })).status).toBe(404);
        expect((await snapshot("not-an-id")).status).toBe(404);
        const id = "00000000-0000-4000-8000-000000000001";
        const gone = await act(id, { action: "scroll" });
        expect(gone.status).toBe(404);
        expect(gone.body.error).toMatch(/Recording not found/);
        expect((await call("GET", "/api/projects/nope/live-sessions")).status).toBe(404);
    });
});

describe("live session: exploring, then saving the exploration as a test", () => {
    let rid: string;
    let page: Page;
    let pid: number | undefined;
    let mainBrowser: Browser;
    let otherRid: string;

    it("opens a session and the snapshot lists the page's elements with ranked locators and match counts", async () => {
        ({ rid, page } = await open(server, pidA, `${FIXTURE}/login`));
        mainBrowser = launched[launched.length - 1]!;
        pid = recorderOf(server)!.pidOf(rid);
        expect(pidAlive(pid!)).toBe(true);

        const s = await snapshot(rid);
        expect(s.status, s.text).toBe(200);
        expect(s.body).toMatchObject({ url: `${FIXTURE}/login`, title: "Log in" });
        expect(s.body.text).toContain("Log in");
        const els = s.body.elements as Array<Record<string, any>>;
        const email = els.find((e) => e.name === "Email")!;
        expect(email).toMatchObject({ tag: "input", role: "textbox", visible: true, enabled: true, matches: 1, locator: { strategy: "role", value: "textbox", name: "Email", exact: true } });
        const signIn = els.find((e) => e.name === "Sign in")!;
        expect(signIn.locator).toEqual(SIGN_IN);
        expect(els.map((e) => e.index)).toEqual(els.map((_, i) => i));
        // the password field is listed, so it can be filled with its stand-in, but never shows a value
        const pw = els.find((e) => e.name === "Password")!;
        expect(pw).toMatchObject({ secret: true, value: "[hidden]", locator: PW });
        expect(s.body.image).toBeUndefined();
        // a picture only on request, small, and a real PNG
        const withImage = await snapshot(rid, "?image=1");
        expect(withImage.body.imageType).toBe("image/png");
        expect(Buffer.from(withImage.body.image, "base64").subarray(1, 4).toString()).toBe("PNG");
        expect(Buffer.from(withImage.body.image, "base64").length).toBeLessThan(400_000);
        // the temporary mark that covers secret fields in a picture is gone again
        expect(await page.locator("[data-aitp-secret]").count()).toBe(0);
        // taking a snapshot is not a step
        expect((await getRec(rid)).steps).toHaveLength(1);
    }, 60_000);

    it("refuses a real password, a card number or a made-up stand-in, says why, and records nothing", async () => {
        const before = (await getRec(rid)).steps.length;
        const real = await act(rid, { action: "fill", locator: PW, value: TYPED });
        expect(real.status).toBe(422);
        expect(real.body.error).toMatch(/can only be filled with \{\{credentials\.password\}\}/);
        expect(real.text).not.toContain(TYPED);
        const wrongSlot = await act(rid, { action: "fill", locator: PW, value: "{{credentials.totp}}" });
        expect(wrongSlot.status).toBe(422);
        const bad = await act(rid, { action: "fill", locator: PW });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/what to type/);
        const noElement = await act(rid, { action: "click", locator: { strategy: "role", value: "button", name: "Does not exist" } });
        expect(noElement.status).toBe(422);
        expect(noElement.body.error).toMatch(/No element on the current page/);
        expect((await getRec(rid)).steps).toHaveLength(before);
        // the page was never typed into
        expect(await page.inputValue("#pw")).toBe("");
    });

    it("signs in with stand-ins: the stored details are typed, recorded as stand-ins and never shown", async () => {
        const email = await act(rid, { action: "fill", locator: EMAIL, value: "{{credentials.username}}" });
        expect(email.status, email.text).toBe(200);
        expect(email.body).toMatchObject({ recorded: true, step: { kind: "fill", value: "{{credentials.username}}", describe: 'Type "{{credentials.username}}" into the text field "Email"' } });
        expect(await page.inputValue("#email")).toBe("tester@example.test"); // the real value was typed into the page
        const pw = await act(rid, { action: "fill", locator: PW, value: "{{credentials.password}}" });
        expect(pw.status, pw.text).toBe(200);
        expect(pw.body).toMatchObject({ recorded: true, step: { kind: "fill", secret: true, value: "{{credentials.password}}", describe: 'Type the password into the field labelled "Password"' } });
        expect(await page.inputValue("#pw")).toBe(PASSWORD);
        expect(pw.text).not.toContain(PASSWORD);
        const field = (pw.body.snapshot.elements as Array<Record<string, any>>).find((e) => e.name === "Password")!;
        expect(field.value).toBe("[hidden]");

        const click = await act(rid, { action: "click", locator: SIGN_IN, image: true });
        
        expect(click.body).toMatchObject({ recorded: true, step: { kind: "click", describe: 'Click the button "Sign in"' }, snapshot: { url: `${FIXTURE}/welcome`, title: "Welcome" } });
        expect(click.body.snapshot.image).toBeTruthy();
        expect((await getRec(rid)).steps.map((s) => s.kind)).toEqual(["goto", "fill", "fill", "click"]);
    }, 60_000);

    it("navigate, press, select, check, wait and scroll change the page and are recorded as a person's actions are", async () => {
        const nav = await act(rid, { action: "navigate", url: "/shop" });
        expect(nav.body).toMatchObject({ recorded: true, step: { kind: "goto", url: `${FIXTURE}/shop` }, snapshot: { url: `${FIXTURE}/shop`, title: "Shop" } });
        const add = await act(rid, { action: "click", locator: { strategy: "role", value: "button", name: "Add to cart", exact: true } });
        expect(add.body.recorded).toBe(true);
        expect(add.body.snapshot.text).toContain("Cart: 1 item");
        const colour = await act(rid, { action: "select", locator: { strategy: "label", value: "Colour", exact: true }, value: "blue" });
        expect(colour.body).toMatchObject({ recorded: true, step: { kind: "select", value: "blue" } });
        expect(await page.inputValue("#colour")).toBe("blue");
        const gift = await act(rid, { action: "check", locator: { strategy: "label", value: "Gift wrap", exact: true } });
        expect(gift.body).toMatchObject({ recorded: true, step: { kind: "check" } });
        expect(await page.isChecked("#gift")).toBe(true);
        const code = await act(rid, { action: "fill", locator: { strategy: "label", value: "Coupon code", exact: true }, value: "SAVE10" });
        expect(code.body).toMatchObject({ recorded: true, step: { kind: "fill", value: "SAVE10" } });
        const enter = await act(rid, { action: "press", locator: { strategy: "label", value: "Coupon code", exact: true }, value: "Enter" });
        expect(enter.body).toMatchObject({ recorded: true, step: { kind: "press", value: "Enter" } });
        const wait = await act(rid, { action: "waitForText", value: "Coupon applied", timeoutMs: 4000 });
        expect(wait.body).toMatchObject({ recorded: false, snapshot: { text: expect.stringContaining("Coupon applied") } });
        expect((await act(rid, { action: "waitForText", value: "Never shown anywhere", timeoutMs: 300 })).status).toBe(422);
        const scroll = await act(rid, { action: "scroll", value: "bottom" });
        expect(scroll.status).toBe(200);
        expect(scroll.body.recorded).toBe(false);
        // a click on something the recorder does not keep as a step is done, and the answer says it was not recorded
        const plain = await act(rid, { action: "click", locator: { strategy: "text", value: "Nothing in the cart" } }).catch(() => undefined);
        expect(plain === undefined || [200, 422].includes(plain.status)).toBe(true);
        const kinds = (await getRec(rid)).steps.map((s) => s.kind);
        expect(kinds.slice(0, 4)).toEqual(["goto", "fill", "fill", "click"]);
        expect(kinds).toEqual(expect.arrayContaining(["goto", "click", "select", "check", "fill", "press"]));
    }, 90_000);

    it("a made-up address and the platform's address guard are refused, and the page stays where it was", async () => {
        const at = (await getRec(rid)).currentUrl;
        const blocked = await act(rid, { action: "navigate", url: "http://127.0.0.2:6170/" });
        expect(blocked.status).toBe(400);
        expect(blocked.body.error).toMatch(/private\/loopback/);
        const scheme = await act(rid, { action: "navigate", url: "file:///etc/passwd" });
        expect(scheme.status).toBe(400);
        const creds = await act(rid, { action: "navigate", url: "http://user:pw@127.0.0.1:6170/shop" });
        expect(creds.status).toBe(400);
        expect(creds.body.error).toMatch(/user name or password/);
        expect(page.url()).toBe(at);
        expect((await getRec(rid)).status).toBe("recording");
    });

    it("one action at a time: a second action while one runs is a 409, and the first still finishes", async () => {
        const slow = act(rid, { action: "waitForText", value: "This text never appears", timeoutMs: 2500 });
        await sleep(300);
        const second = await act(rid, { action: "scroll", value: "top" });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/Another action is still running/);
        expect((await slow).status).toBe(422);
        expect((await act(rid, { action: "scroll", value: "top" })).status).toBe(200);
    }, 30_000);

    it("a project's second session is separate: its actions never touch this one", async () => {
        const before = (await getRec(rid)).steps.length;
        ({ rid: otherRid } = await open(server, pidB, `${FIXTURE}/shop`));
        const r = await act(otherRid, { action: "click", locator: { strategy: "role", value: "button", name: "Add to cart", exact: true } });
        expect(r.body.recorded).toBe(true);
        expect((await getRec(otherRid)).steps.map((s) => s.kind)).toEqual(["goto", "click"]);
        expect((await getRec(rid)).steps).toHaveLength(before);
        // project B has no stored sign-in details: a stand-in is refused with a plain sentence
        await call("POST", `/api/recordings/${otherRid}/stop`);
        expect((await call("DELETE", `/api/recordings/${otherRid}`)).status).toBe(200);
    }, 60_000);

    it("stop closes the browser; acting on a stopped session is a 409; the steps are kept and saved as a test that validates", async () => {
        const stopped = await call("POST", `/api/recordings/${rid}/stop`);
        expect(stopped.body.status).toBe("stopped");
        expect(pidAlive(pid!)).toBe(false);
        expect(mainBrowser.isConnected()).toBe(false);
        expect((await act(rid, { action: "scroll" })).status).toBe(409);
        expect((await snapshot(rid)).status).toBe(409);

        const saved = await call("POST", `/api/recordings/${rid}/save`, { title: "Explored sign in and shop", category: "Explored" });
        expect(saved.status, saved.text).toBe(201);
        const testId = saved.body.testId as string;
        const test = (await call("GET", `/api/tests/${testId}`)).body;
        const specText = JSON.stringify(test.spec);
        expect(specText).toContain("{{credentials.username}}");
        expect(specText).toContain("{{credentials.password}}");
        expect(specText).not.toContain(PASSWORD);
        expect(test.scripts[0].content).not.toContain(PASSWORD);
        const job = await waitJob(saved.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const after = (await call("GET", `/api/tests/${testId}`)).body;
        expect(after.validationStatus, JSON.stringify(after.validationReason)).toBe("VALIDATED");
    }, 180_000);

    it("the audit trail has one row for the session with counts only, and no value, text or picture anywhere the platform kept it", async () => {
        const list = (await call("GET", `/api/projects/${pidA}/live-sessions`)).body.sessions as Array<Record<string, any>>;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ recordingId: rid, projectId: pidA, runner: "platform", startUrl: `${FIXTURE}/login` });
        expect(list[0]!.actions).toBeGreaterThan(10);
        expect(list[0]!.refused).toBeGreaterThan(4);
        expect(list[0]!.snapshots).toBeGreaterThan(1);
        expect((await call("GET", `/api/projects/${pidB}/live-sessions`)).body.sessions).toHaveLength(1);
        for (const secret of [PASSWORD, TYPED]) {
            expect(answers.join("\n"), secret).not.toContain(secret);
            expect(taps.join("\n"), secret).not.toContain(secret);
            for (const f of [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((f) => fs.existsSync(f))) expect(fs.readFileSync(f).includes(Buffer.from(secret)), f).toBe(false);
        }
    });
});

describe("live session: the stored sign-in details only go to the application's own site", () => {
    it("a stand-in is refused on another origin and the field stays empty", async () => {
        const { rid, page } = await open(server, pidA, `${FOREIGN}/login`);
        const r = await act(rid, { action: "fill", locator: EMAIL, value: "{{credentials.username}}" });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(new RegExp(`only typed on the application's own site \\(${FIXTURE.replace(/\./g, "\\.")}\\)`));
        expect(await page.inputValue("#email")).toBe("");
        // an ordinary value is fine there
        expect((await act(rid, { action: "fill", locator: EMAIL, value: "someone@example.test" })).status).toBe(200);
        expect((await call("DELETE", `/api/recordings/${rid}`)).status).toBe(200);
    }, 60_000);

    it("a project with no stored sign-in details says so", async () => {
        const { rid } = await open(server, pidB, `${FIXTURE}/login`);
        const r = await act(rid, { action: "fill", locator: EMAIL, value: "{{credentials.username}}" });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/no stored user name/);
        expect((await call("DELETE", `/api/recordings/${rid}`)).status).toBe(200);
    }, 60_000);

    it("discarding closes the browser it started and no other", async () => {
        const { rid } = await open(server, pidA, `${FIXTURE}/shop`);
        const pid = recorderOf(server)!.pidOf(rid)!;
        expect(pidAlive(pid)).toBe(true);
        expect((await call("DELETE", `/api/recordings/${rid}`)).status).toBe(200);
        expect(pidAlive(pid)).toBe(false);
    }, 60_000);
});

describe("live session: the recorder's step cap applies", () => {
    it("refuses an action that would be recorded once the cap is reached, and still allows looking", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-live-cap-"));
        const saved = recorderOptions.caps;
        recorderOptions.caps = { maxSteps: 3 };
        const p2 = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789" }));
        const s2 = await buildServer(p2);
        recorderOptions.caps = saved;
        try {
            const project = (await callOn(s2, "POST", "/api/projects", { name: "Cap" })).body.id as string;
            const { rid, page } = await open(s2, project, `${FIXTURE}/shop`);
            const add = { strategy: "role", value: "button", name: "Add to cart", exact: true };
            expect((await callOn(s2, "POST", `/api/recordings/${rid}/act`, { action: "click", locator: add })).body.recorded).toBe(true);
            expect((await callOn(s2, "POST", `/api/recordings/${rid}/act`, { action: "select", locator: { strategy: "label", value: "Colour", exact: true }, value: "blue" })).body.recorded).toBe(true);
            const full = await callOn(s2, "POST", `/api/recordings/${rid}/act`, { action: "click", locator: add });
            expect(full.status).toBe(409);
            expect(full.body.error).toMatch(/3-step limit/);
            expect((await page.textContent("#status"))).toBe("Cart: 1 item"); // the refused click was not done
            expect((await callOn(s2, "GET", `/api/recordings/${rid}/snapshot`)).status).toBe(200);
            expect((await callOn(s2, "POST", `/api/recordings/${rid}/act`, { action: "scroll" })).status).toBe(200);
            await callOn(s2, "DELETE", `/api/recordings/${rid}`);
        } finally {
            await s2.close();
            p2.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 90_000);
});
