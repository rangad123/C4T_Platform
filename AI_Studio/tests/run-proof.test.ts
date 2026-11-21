/**
 * Proof of a web test run: every web test keeps a screenshot (at its end when it passes, at the failing step when it fails) and its
 * recording, with secret fields covered in the picture, and the Run page shows them per test.
 *
 * 1. The run itself (runScripts, the code both the platform and a runner's test process use), real Playwright and Chromium against a
 *    local fixture: a passing and a failing hand-written test each keep a screenshot and a video; the failing one's picture is of the
 *    failing moment, not of what its afterEach did next; a one-time-code field is covered and an ordinary field is not.
 * 2. The real platform with the REAL runner program: a code project's run of the two tests lists the proof per test; a viewer of the
 *    project sees the run and opens the pictures; a person of another project gets 404; the picture the runner sent is covered too.
 * 3. The Run page in a real browser, signed in as the viewer: thumbnails per test that open larger, and the recording with controls.
 *
 * Browser-launching, needs web/dist:
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/run-proof.test.ts"
 * Ports: platform 9940, fixture application 9941.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { isSensitiveField, PROOF_SECRET_FIELDS } from "../src/engine/evidence/proof-style.js";
import { secretKindOfField, type FieldFacts } from "../src/engine/recorder/act.js";
import { runScripts, type ScriptRun } from "../src/engine/validation/runner.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { SYSTEM_ACTOR } from "../src/platform/auth/actor.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9940;
const APP_PORT = 9941;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const KEY = "run-proof-admin-key-5d02";
const SECRET_CODE = "WWWW-8841-QQQQ";
const COVER = [71, 85, 105]; // #475569, the cover of a secret field (src/engine/evidence/proof-style.ts)
const RED = [200, 0, 0];
const BLUE = [0, 0, 200];
const SHOTS = process.env.RUN_PROOF_SHOTS ?? path.join(os.tmpdir(), "run-proof-shots");
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A page with fixed places: a one-time-code field, an ordinary field, and a button that turns the page red.
const field = (name: string, top: number) => `<input name="${name}" aria-label="${name}" style="position:absolute;left:20px;top:${top}px;width:400px;height:60px;font-size:40px;border:0;padding:0 8px;background:#ffffff;color:#000000">`;
const HOME = `<!doctype html><html lang="en"><head><title>Proof shop</title></head><body style="margin:0;background:#ffffff">${field("otp", 20)}${field("city", 120)}<button style="position:absolute;left:20px;top:220px" onclick="document.body.style.background='rgb(200,0,0)';document.getElementById('s').textContent='Clicked'">Go</button><p id="s" style="position:absolute;left:20px;top:300px">Idle</p></body></html>`;
const AFTER = `<!doctype html><html lang="en"><head><title>After</title></head><body style="margin:0;background:rgb(0,0,200)"><p>After</p></body></html>`;

const HEAD = `import { test, expect } from "@playwright/test";\n`;
const PASSING = `${HEAD}test("fills the form", async ({ page }) => {\n  await page.goto(process.env.BASE_URL + "/");\n  await page.getByLabel("otp").fill(${JSON.stringify(SECRET_CODE)});\n  await page.getByLabel("city").fill("Visible city");\n  await expect(page.getByLabel("city")).toHaveValue("Visible city");\n});\n`;
const FAILING = `${HEAD}test.afterEach(async ({ page }) => {\n  await page.goto(process.env.BASE_URL + "/after");\n});\ntest("finds a heading nobody wrote", async ({ page }) => {\n  await page.goto(process.env.BASE_URL + "/");\n  await page.getByRole("button", { name: "Go" }).click();\n  await expect(page.getByText("Never there")).toBeVisible({ timeout: 1000 });\n});\n`;

let app: http.Server;
let browser: Browser;

/** The colours of a PNG at some points, and whether a box of it is one colour, read by drawing it on a canvas. */
async function pixels(png: Buffer, points: Array<[number, number]>, boxes: Array<[number, number, number, number]> = []): Promise<{ at: number[][]; uniform: boolean[]; boxColour: number[][] }> {
    const page = await browser.newPage();
    try {
        return await page.evaluate(
            async ({ src, points, boxes }) => {
                const img = new Image();
                img.src = src;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = img.width;
                c.height = img.height;
                const g = c.getContext("2d")!;
                g.drawImage(img, 0, 0);
                const at = points.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
                const uniform: boolean[] = [];
                const boxColour: number[][] = [];
                for (const [x, y, w, h] of boxes) {
                    const d = g.getImageData(x, y, w, h).data;
                    let same = true;
                    for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) same = false;
                    uniform.push(same);
                    boxColour.push([d[0]!, d[1]!, d[2]!]);
                }
                return { at, uniform, boxColour };
            },
            { src: `data:image/png;base64,${png.toString("base64")}`, points, boxes },
        );
    } finally {
        await page.close();
    }
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 6);
// Inside the one-time-code field and inside the ordinary field (inside the padding, where the typed text is drawn).
const OTP_BOX: [number, number, number, number] = [24, 26, 380, 48];
const CITY_BOX: [number, number, number, number] = [24, 126, 380, 48];

beforeAll(async () => {
    app = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end((req.url ?? "/").startsWith("/after") ? AFTER : HOME);
    });
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", () => r()));
    browser = await chromium.launch();
    fs.mkdirSync(SHOTS, { recursive: true });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    app?.closeAllConnections();
    await new Promise((r) => app?.close(r));
});

describe("the secret-field cover", () => {
    it("covers every field the recorder's rule calls secret, and leaves ordinary fields alone", async () => {
        const secret: FieldFacts[] = [
            { tag: "input", type: "password" },
            { tag: "input", type: "PASSWORD" },
            { tag: "input", autocomplete: "one-time-code" },
            { tag: "input", autocomplete: "cc-number" },
            { tag: "input", autocomplete: "cc-csc" },
            { tag: "input", autocomplete: "current-password" },
            { tag: "input", autocomplete: "section-x new-password" },
            { tag: "input", name: "user_password" },
            { tag: "input", id: "Passwd" },
            { tag: "input", ariaLabel: "Passcode" },
            { tag: "input", placeholder: "Your OTP" },
            { tag: "input", name: "one-time" },
            { tag: "input", name: "onetime" },
            { tag: "input", ariaLabel: "One time code" },
            { tag: "input", placeholder: "Verification code" },
            { tag: "input", name: "cvv" },
            { tag: "input", id: "card-cvc" },
            { tag: "input", ariaLabel: "Security code" },
            { tag: "input", name: "cardNumber" },
            { tag: "input", name: "card_no" },
        ];
        // Personal data and other secrets the recorder types as they are: covered in the picture too (P5 L-7).
        const personal: FieldFacts[] = [
            { tag: "input", type: "email", name: "email" },
            { tag: "input", type: "tel", name: "phone" },
            { tag: "input", autocomplete: "street-address" },
            { tag: "input", name: "address" },
            { tag: "input", name: "token" },
            { tag: "input", name: "api_key" },
            { tag: "input", ariaLabel: "Session" },
            { tag: "input", name: "dsn" },
            { tag: "textarea", name: "shipping_address" },
        ];
        const ordinary: FieldFacts[] = [{ tag: "input", name: "city" }, { tag: "input", type: "search", placeholder: "Search" }, { tag: "input", id: "username" }, { tag: "textarea", name: "password" }];
        for (const f of secret) expect(secretKindOfField(f), JSON.stringify(f)).not.toBe("");
        for (const f of ordinary) expect(secretKindOfField(f), JSON.stringify(f)).toBe("");
        const page = await browser.newPage();
        try {
            const matched = await page.evaluate(
                ({ fields, selector }) =>
                    fields.map((f) => {
                        const el = document.createElement(f.tag);
                        for (const [k, a] of [["type", "type"], ["autocomplete", "autocomplete"], ["name", "name"], ["id", "id"], ["ariaLabel", "aria-label"], ["placeholder", "placeholder"]] as const) {
                            const v = (f as unknown as Record<string, string | undefined>)[k];
                            if (v !== undefined) el.setAttribute(a, v);
                        }
                        document.body.appendChild(el);
                        return el.matches(selector);
                    }),
                { fields: [...secret, ...personal, ...ordinary], selector: PROOF_SECRET_FIELDS },
            );
            expect(matched).toEqual([...secret.map(() => true), ...personal.map(() => true), ...ordinary.map(() => false)]);
            // The same rule for code that has a field's attributes, not the element (trace masking).
            const attrsOf = (f: FieldFacts) => Object.fromEntries(Object.entries({ type: f.type, autocomplete: f.autocomplete, name: f.name, id: f.id, "aria-label": f.ariaLabel, placeholder: f.placeholder }).filter(([, v]) => v !== undefined));
            expect([...secret, ...personal, ...ordinary].filter((f) => f.tag === "input").map((f) => isSensitiveField(attrsOf(f)))).toEqual([...secret, ...personal, ...ordinary].filter((f) => f.tag === "input").map((f) => !ordinary.includes(f)));
        } finally {
            await page.close();
        }
    }, 60_000);
});

describe("a web test run keeps proof", () => {
    let runs: ScriptRun[];
    // Inside the platform's own scratch folder, where the test runner finds @playwright/test.
    const scratch = loadConfig({}).scratchDir;
    const shot = (r: ScriptRun) => fs.readFileSync(r.artifacts.find((a) => a.kind === "screenshot")!.path);

    it("a passing and a failing test each keep a screenshot and a recording", async () => {
        runs = await runScripts(
            scratch,
            [
                { testId: "WEB-001", filename: "WEB-001.spec.ts", content: PASSING, custom: true },
                { testId: "WEB-002", filename: "WEB-002.spec.ts", content: FAILING, custom: true },
            ],
            { baseUrl: APP, headless: true },
            { workers: 2, allowCustom: true },
        );
        expect(runs.map((r) => [r.testId, r.status])).toEqual([["WEB-001", "passed"], ["WEB-002", "failed"]]);
        for (const r of runs) {
            const kinds = r.artifacts.map((a) => a.kind);
            expect(kinds, r.testId).toEqual(expect.arrayContaining(["screenshot", "video"]));
            for (const a of r.artifacts.filter((x) => x.kind === "screenshot" || x.kind === "video")) expect(fs.statSync(a.path).size, `${r.testId} ${a.kind}`).toBeGreaterThan(100);
            expect(shot(r).subarray(0, 8).toString("hex"), r.testId).toBe("89504e470d0a1a0a");
        }
        // A trace stays for failures only.
        expect(runs[0]!.artifacts.some((a) => a.kind === "trace")).toBe(false);
        expect(runs[1]!.artifacts.some((a) => a.kind === "trace")).toBe(true);
    }, 180_000);

    it("the failing test's picture is of the failing step, not of what its afterEach did next", async () => {
        const p = await pixels(shot(runs[1]!), [[1200, 700]]);
        expect(near(p.at[0]!, RED), JSON.stringify(p.at[0])).toBe(true);
        expect(near(p.at[0]!, BLUE)).toBe(false);
    }, 60_000);

    it("covers the one-time-code field in the picture and shows the ordinary one", async () => {
        const p = await pixels(shot(runs[0]!), [], [OTP_BOX, CITY_BOX]);
        fs.writeFileSync(path.join(SHOTS, "run-proof-covered.png"), shot(runs[0]!));
        expect(p.uniform[0], "the one-time code is covered").toBe(true);
        expect(near(p.boxColour[0]!, COVER), JSON.stringify(p.boxColour[0])).toBe(true);
        expect(p.uniform[1], "the city is readable").toBe(false);
    }, 60_000);
});

describe("on the platform, from a person's runner", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let dataDir: string;
    let agentWork: string;
    let agent: Agent | undefined;
    let agentDone: Promise<number> | undefined;
    let owner: { id: string; token: string };
    let viewer: { id: string; token: string };
    let outsider: { id: string; token: string };
    let projectId = "";
    let otherProject = "";
    let jobId = "";
    const ids: Record<string, string> = {};
    let answer: any;

    const call = async (token: string, method: string, url: string, body?: unknown) => {
        const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
    };
    const jobDone = async (id: string) => {
        for (let i = 0; i < 400; i++) {
            const j = (await call(owner.token, "GET", `/api/test-generation/${id}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j?.status)) return j;
            await new Promise((r) => setTimeout(r, 300));
        }
        throw new Error("job did not finish");
    };

    beforeAll(async () => {
        Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "10" });
        delete process.env.BLOCK_PRIVATE_TARGETS;
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-proof-pf-"));
        agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-proof-agent-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, SECRET_KEY: "run-proof-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", SCHEDULER_ENABLED: "false" }));
        server = await buildServer(platform);
        await server.listen({ port: PORT, host: "127.0.0.1" });
        worker = new Worker(platform, 150);
        worker.start();
        owner = testPerson(platform);
        projectId = platform.repo.createProject({ name: "Test web code", platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(projectId, APP, {} as never);
        otherProject = platform.repo.createProject({ name: "Someone else's shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(otherProject, APP, {} as never);
        const users = accessControlOf(server).users;
        const scope = accessControlOf(server).projects.store;
        const member = async (email: string, project: string) => {
            const u = users.create({ email, name: email.split("@")[0]!, role: "viewer" });
            users.setPassword(u.id, await hashPassword(`${email} long password`));
            scope.setMode(u.id, "only");
            scope.addMember(project, u.id, { role: "viewer", projectAdmin: false, source: "added", addedBy: "test" });
            return { id: u.id, token: users.createToken(u.id, { name: "t", role: "viewer" }).token };
        };
        viewer = await member("vera@example.com", projectId);
        outsider = await member("otto@example.com", otherProject);
        const { log } = memoryLogger();
        const secret = personalRunner(platform, { ownerId: owner.id, label: "proof runner", replace: true }).secret;
        agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "proof runner", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env", allowCustomScripts: true }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 } });
        agentDone = agent.run();
    }, 60_000);
    afterAll(async () => {
        agent?.stop();
        await agentDone;
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        await worker?.stop();
        server?.server.closeAllConnections();
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(agentWork, { recursive: true, force: true });
    }, 90_000);

    it("a run of a passing and a failing code test lists a screenshot and a recording for each", async () => {
        // The project's tests run on runners: the server itself does not run code tests.
        for (let i = 0; i < 100 && !(await call(owner.token, "GET", `/api/projects/${projectId}/agents`)).body?.some?.((a: { online: boolean }) => a.online); i++) await new Promise((r) => setTimeout(r, 200));
        const reviews = new ReviewStore(platform.db);
        const where = await call(owner.token, "PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
        expect(where.status, where.text).toBe(200);
        for (const [key, title, content] of [["pass", "Fills the form", PASSING], ["fail", "Finds a heading nobody wrote", FAILING]] as const) {
            const made = await call(owner.token, "POST", `/api/projects/${projectId}/custom-tests`, { title, kind: "web", content });
            expect(made.status, made.text).toBe(201);
            ids[key] = made.body.testId;
            if (made.body.jobId) await jobDone(made.body.jobId);
            // Only approved versions run: a Project Admin's approval, made directly (the review flow has its own tests).
            const v = reviews.latest(ids[key]!)!;
            if (v.state !== "approved") reviews.approve(v, SYSTEM_ACTOR, null);
        }
        const started = await call(owner.token, "POST", `/api/projects/${projectId}/runs`, { testIds: [ids.pass, ids.fail] });
        expect(started.status, started.text).toBe(202);
        jobId = started.body.jobId;
        const job = await jobDone(jobId);
        expect(job.ranOn).toMatchObject({ kind: "agent" });
        const r = await call(viewer.token, "GET", `/api/projects/${projectId}/runs/${jobId}`);
        expect(r.status, r.text).toBe(200);
        answer = r.body;
        const byId = new Map(answer.tests.map((t: any) => [t.id, t]));
        expect((byId.get(ids.pass) as any).state, JSON.stringify({ tests: answer.tests, heldBack: answer.heldBack, error: job.error })).toBe("passed");
        expect((byId.get(ids.fail) as any).state).toBe("failed");
        for (const key of ["pass", "fail"]) {
            const proof = (byId.get(ids[key]!) as any).proof as Array<{ id: string; kind: string; moment?: string }>;
            expect(proof?.map((p) => p.kind).sort(), key).toEqual(["screenshot", "video"]);
        }
        expect((byId.get(ids.pass) as any).proof.find((p: any) => p.kind === "screenshot").moment).toBe("end");
        expect((byId.get(ids.fail) as any).proof.find((p: any) => p.kind === "screenshot").moment).toBe("failure");
    }, 300_000);

    it("a viewer of the project opens the pictures and the recording; a person of another project gets 404", async () => {
        const proofOf = (key: string) => answer.tests.find((t: any) => t.id === ids[key]).proof as Array<{ id: string; kind: string }>;
        for (const key of ["pass", "fail"]) {
            for (const p of proofOf(key)) {
                const res = await fetch(`${BASE}/api/artifacts/${p.id}`, { headers: { authorization: `Bearer ${viewer.token}` } });
                expect(res.status, `${key} ${p.kind}`).toBe(200);
                expect(res.headers.get("content-type"), `${key} ${p.kind}`).toBe(p.kind === "video" ? "video/webm" : "image/png");
                const away = await fetch(`${BASE}/api/artifacts/${p.id}`, { headers: { authorization: `Bearer ${outsider.token}` } });
                expect(away.status, `${key} ${p.kind} from another project`).toBe(404);
            }
        }
        // Nor the run itself.
        expect((await call(outsider.token, "GET", `/api/projects/${projectId}/runs/${jobId}`)).status).toBe(404);
    }, 60_000);

    it("the picture the runner sent has the one-time-code field covered", async () => {
        const shotId = (answer.tests.find((t: any) => t.id === ids.pass).proof as Array<{ id: string; kind: string }>).find((p) => p.kind === "screenshot")!.id;
        const res = await fetch(`${BASE}/api/artifacts/${shotId}`, { headers: { authorization: `Bearer ${viewer.token}` } });
        const p = await pixels(Buffer.from(await res.arrayBuffer()), [], [OTP_BOX, CITY_BOX]);
        expect(p.uniform[0]).toBe(true);
        expect(near(p.boxColour[0]!, COVER), JSON.stringify(p.boxColour[0])).toBe(true);
        expect(p.uniform[1]).toBe(false);
    }, 60_000);

    it("the Run page shows each test's proof: thumbnails that open larger, and the recording with controls", async () => {
        if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        try {
            await page.goto(BASE);
            await page.getByLabel("Email").fill("vera@example.com");
            await page.getByLabel("Password").fill("vera@example.com long password");
            await page.getByRole("button", { name: "Sign in" }).click();
            await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
            await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
            const list = page.getByRole("list", { name: "Tests in this run" });
            await pwExpect(list.getByRole("link", { name: "Fills the form" })).toBeVisible();
            const passRow = list.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Fills the form" }) });
            const failRow = list.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Finds a heading nobody wrote" }) });
            const passShot = passRow.getByRole("button", { name: /screenshot at the end/i });
            const failShot = failRow.getByRole("button", { name: /screenshot at the failing step/i });
            await pwExpect(passShot).toBeVisible();
            await pwExpect(failShot).toBeVisible();
            // Under the recording, in plain words: it is not masked.
            await pwExpect(failRow.getByText("Recordings are not masked: anyone who can view this project sees what was on the screen (password fields show as dots).")).toBeVisible();
            // The thumbnail has loaded (a picture that failed to load has no size).
            await pwExpect.poll(() => passShot.locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(100);
            await page.screenshot({ path: path.join(SHOTS, "run-proof-run-page.png"), fullPage: true });

            await failShot.click();
            const dialog = page.getByRole("dialog");
            await pwExpect(dialog).toBeVisible();
            const big = dialog.getByRole("img");
            await pwExpect.poll(() => big.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1280);
            expect(await big.evaluate((i: HTMLImageElement) => i.getBoundingClientRect().width)).toBeGreaterThan(600);
            await page.screenshot({ path: path.join(SHOTS, "run-proof-picture.png") });
            await page.keyboard.press("Escape");
            await pwExpect(dialog).toBeHidden();

            await failRow.getByRole("button", { name: /recording/i }).click();
            const video = page.getByRole("dialog").locator("video");
            await pwExpect(video).toBeVisible();
            expect(await video.evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
            await pwExpect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
            await page.screenshot({ path: path.join(SHOTS, "run-proof-recording.png") });
            await page.keyboard.press("Escape");

            // Phone width: the proof stays inside the row.
            await page.setViewportSize({ width: 390, height: 844 });
            await pwExpect(passShot).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
            await page.screenshot({ path: path.join(SHOTS, "run-proof-run-page-390.png"), fullPage: true });
        } finally {
            await context.close();
        }
    }, 120_000);

    it("a recording the 7-day rule removed says so on the Run page and at its link", async () => {
        const video = (answer.tests.find((t: any) => t.id === ids.pass).proof as Array<{ id: string; kind: string }>).find((p) => p.kind === "video")!;
        const removedOn = "2026-11-12T03:00:00.000Z";
        platform.db.run("UPDATE artifacts SET pruned_at = ?, pruned_reason = ? WHERE id = ?", removedOn, "recording-age", video.id);
        const SENTENCE = "This recording was removed after 7 days, on Nov 12, 2026: recordings are kept for 7 days (the project's retention policy).";
        const proof = (await call(viewer.token, "GET", `/api/projects/${projectId}/runs/${jobId}`)).body.tests.find((t: any) => t.id === ids.pass).proof;
        expect(proof.find((p: any) => p.id === video.id)).toMatchObject({ kind: "video", removedAt: removedOn, removedReason: "recording-age" });
        const gone = await call(viewer.token, "GET", `/api/artifacts/${video.id}`);
        expect(gone.status).toBe(410);
        expect(gone.body.error).toBe(SENTENCE);
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        try {
            await page.goto(BASE);
            await page.getByLabel("Email").fill("vera@example.com");
            await page.getByLabel("Password").fill("vera@example.com long password");
            await page.getByRole("button", { name: "Sign in" }).click();
            await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
            await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
            const passRow = page.getByRole("list", { name: "Tests in this run" }).getByRole("listitem").filter({ has: page.getByRole("link", { name: "Fills the form" }) });
            await pwExpect(passRow.getByText(SENTENCE)).toBeVisible();
            await pwExpect(passRow.getByRole("button", { name: /recording/i })).toHaveCount(0);
            await pwExpect(passRow.getByRole("button", { name: /screenshot at the end/i })).toBeVisible();
            await page.screenshot({ path: path.join(SHOTS, "run-proof-removed-recording.png"), fullPage: true });
        } finally {
            await context.close();
        }
    }, 120_000);
});
