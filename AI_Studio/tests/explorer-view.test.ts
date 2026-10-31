/**
 * The Explorer view through the real platform: HTTP API -> job queue -> worker -> a REAL exploration of a slow local site in a real Chromium (and a real
 * plain-English build on a second site), with the picture route polled the way the UI polls it. The model is a scripted double: no real model, no
 * external site.
 *
 *   no picture is ever taken while nobody reads the route (the hub is given nothing)
 *   pictures arrive while someone reads: JPEG, right address and title, a plain activity line, the phase, pages seen; `since` answers "unchanged" without the picture
 *   the sign-in page: the password is covered IN the pictures (pixels), the cover was on while a picture was taken and off afterwards (reported by the page itself)
 *   no stored secret or typed value is in any answer
 *   the job answer says canWatch only while a watchable part runs; nothing to show while the AI analyses ("Nothing to show right now.")
 *   frames are gone once the job ends; a stopped job drops its picture at once; at most 3 reads a second (429); another project's job is a 404
 *   the API key protects the route
 *   a test built from a sentence shows its browser, phase "building"
 *
 * Ports: slow site 6630, plain-English site 6631. The platform is driven through `server.inject`. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/explorer-view.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { frameHub } from "../src/platform/frame-hub.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { EXPLORER_USER, LOGIN_PASSWORD_BOX, LOGIN_PREFILL, startExplorerSite, type ExplorerSite } from "./fixtures/explorer-site.js";
import { startPlainSite, type PlainSite } from "./fixtures/plain-site.js";

const SITE_PORT = 6630;
const PLAIN_PORT = 6631;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PLAIN = `http://127.0.0.1:${PLAIN_PORT}`;

let site: ExplorerSite;
let plainSite: PlainSite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;
let browser: Browser;
let reader: Page;

// ── the scripted model ────────────────────────────────────────────────────────
/** Held while a test wants the exploration to stay in "understanding"; released by the test. */
let gate: Promise<void> | null = null;
/** Pause before each tool call of the plain-English agent, so the build lasts long enough to be watched. */
let agentPauseMs = 0;
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        if (agentPauseMs) await new Promise((r) => setTimeout(r, agentPauseMs));
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system }: { system: string }) => {
        if (/analysing a web application/.test(system)) {
            if (gate) await gate;
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Read pricing"],
                pagePurposes: [],
                journeys: [{ name: "Read pricing", description: "Look at pricing", steps: ["Open pricing"], priority: "high", pages: ["/", "/pricing"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        return { scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Read the pricing", description: "Read the pricing", category: "Browsing", priority: "high", journey: "Read pricing", startPath: "/pricing", expectedResults: ["Pricing plans is shown"] })] };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startExplorerSite(SITE_PORT);
    plainSite = await startPlainSite(PLAIN_PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explorer-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "test-secret-key-0123456789" }));
    platform.llm = scripted;
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
    browser = await chromium.launch();
    reader = await (await browser.newContext()).newPage();
}, 90_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    await browser?.close();
    platform?.db.close();
    await site?.close();
    await plainSite?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────
type Answer = { status: number; body: any; headers: Record<string, unknown> };
const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers?: Record<string, string>): Promise<Answer> => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body, headers: res.headers };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
const getJob = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}`)).body;
async function finished(jobId: string, ms = 180_000) {
    const end = Date.now() + ms;
    for (;;) {
        const job = await getJob(jobId);
        if (DONE.includes(job.status)) return job;
        if (Date.now() > end) throw new Error(`job ${jobId} did not finish (${job.status})`);
        await sleep(300);
    }
}
const frameUrl = (projectId: string, jobId: string, since?: string) => `/api/projects/${projectId}/jobs/${jobId}/frame${since ? `?since=${encodeURIComponent(since)}` : ""}`;
const START = { url: SITE, maxPages: 10, targets: ["web"], plan: true, credentials: { username: EXPLORER_USER.email, password: EXPLORER_USER.password } };

/** What the UI does: read the route every 450 ms (under the 3 a second allowance) with the last picture's time, until the job ends. */
async function watch(projectId: string, jobId: string) {
    const answers: any[] = [];
    const canWatch: boolean[] = [];
    let since: string | undefined;
    for (;;) {
        const job = await getJob(jobId);
        canWatch.push(job.canWatch);
        if (DONE.includes(job.status)) break;
        const r = await call("GET", frameUrl(projectId, jobId, since));
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        answers.push(r.body);
        if (r.body.available && r.body.at) since = r.body.at;
        await sleep(450);
    }
    return { answers, canWatch, job: await getJob(jobId) };
}

/** The mean colour of a region of a picture, and how far any pixel is from it. */
async function look(b64: string, regions: Array<{ x: number; y: number; w: number; h: number }>) {
    return reader.evaluate(
        async ([data, rs]) => {
            const img = new Image();
            img.src = `data:image/jpeg;base64,${data}`;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0);
            return {
                w: img.naturalWidth,
                regions: (rs as Array<{ x: number; y: number; w: number; h: number }>).map((r) => {
                    const d = g.getImageData(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)).data;
                    const n = d.length / 4;
                    const mean = [0, 0, 0];
                    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) mean[k]! += d[i + k]! / n;
                    let spread = 0;
                    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(d[i + k]! - mean[k]!));
                    return { mean, spread };
                }),
            };
        },
        [b64, regions] as [string, typeof regions],
    );
}

// ── the journey ───────────────────────────────────────────────────────────────
describe("the Explorer view: an exploration", () => {
    it("takes no picture while nobody reads the route", async () => {
        const projectId = await newProject("Nobody watching");
        const before = frameHub.accepted;
        const started = await call("POST", `/api/projects/${projectId}/test-generation`, START);
        expect(started.status).toBe(202);
        const job = await finished(started.body.jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        expect(job.counters.pagesDiscovered).toBeGreaterThan(3);
        // The exploration really ran in a browser, and not one picture was taken or kept.
        expect(frameHub.accepted).toBe(before);
        expect(frameHub.latest(started.body.jobId)).toBeUndefined();
    }, 240_000);

    let projectId = "";
    let jobId = "";
    let watched: Awaited<ReturnType<typeof watch>>;

    it("shows pictures while the route is read: a JPEG, the address, the title, what just happened, the phase and the pages seen", async () => {
        projectId = await newProject("Watching");
        const started = await call("POST", `/api/projects/${projectId}/test-generation`, START);
        expect(started.status).toBe(202);
        jobId = started.body.jobId;
        // The job answer says whether the browser can be watched at all.
        expect(typeof (await getJob(jobId)).canWatch).toBe("boolean");
        watched = await watch(projectId, jobId);
        expect(watched.job.status).toBe("COMPLETED");

        const withPicture = watched.answers.filter((a) => a.available && a.imageBase64);
        expect(withPicture.length, `answers: ${JSON.stringify(watched.answers.map((a) => ({ ...a, imageBase64: a.imageBase64 ? "…" : undefined })))}`).toBeGreaterThanOrEqual(3);
        for (const a of withPicture) {
            expect(a).toMatchObject({ mime: "image/jpeg", watching: true });
            const bytes = Buffer.from(a.imageBase64, "base64");
            expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
            expect(bytes.byteLength).toBeLessThanOrEqual(120 * 1024);
            expect(a.url.startsWith(SITE)).toBe(true);
            expect(a.title.length).toBeGreaterThan(0);
            expect(a.note).toMatch(/^(Opened \/|Read \d+ links?|Filled in the sign-in form|Signed in|Tried to sign in)/);
            expect(["exploring", "signing-in"]).toContain(a.phase);
            expect(a.pagesSeen).toBeGreaterThanOrEqual(0);
            expect(typeof a.ageMs).toBe("number");
        }
        // It followed the exploration through several pages, with the title the page has.
        const titles = new Set(withPicture.map((a) => a.title));
        expect(titles.size).toBeGreaterThanOrEqual(2);
        expect([...titles].some((t) => ["Explorer Shop", "Pricing", "About", "Docs", "Team", "Sign in", "Your account"].includes(t))).toBe(true);
        expect(withPicture.some((a) => /^Opened \//.test(a.note))).toBe(true);
        // The first answers say they are waiting, in words.
        const waiting = watched.answers.find((a) => !a.available);
        if (waiting) expect(waiting).toMatchObject({ why: expect.stringMatching(/waiting|nothing/), reason: expect.any(String) });
        // Pictures were at most a second apart in time of taking (a new picture each time `at` changed).
        const ats = [...new Set(withPicture.map((a) => a.at as string))].map((t) => new Date(t).getTime()).sort((x, y) => x - y);
        for (let i = 1; i < ats.length; i++) expect(ats[i]! - ats[i - 1]!).toBeGreaterThanOrEqual(900);
    }, 240_000);

    it("answers 'unchanged' without the picture when nothing is new", () => {
        const unchanged = watched.answers.filter((a) => a.unchanged);
        expect(unchanged.length).toBeGreaterThanOrEqual(1);
        for (const a of unchanged) {
            expect(a).toMatchObject({ available: true, mime: "image/jpeg", watching: true });
            expect(a.imageBase64).toBeUndefined();
            expect(a.at).toEqual(expect.any(String));
        }
    });

    it("says canWatch only while the browser can be watched", () => {
        expect(watched.canWatch.some((c) => c === true)).toBe(true);
        expect(watched.canWatch[watched.canWatch.length - 1]).toBe(false);
    });

    it("covers the password in the pictures of the sign-in page, and the page reports the cover on during a picture and off after", async () => {
        const login = watched.answers.filter((a) => a.available && a.imageBase64 && new URL(a.url).pathname === "/login");
        expect(login.length, "at least one picture of the sign-in page").toBeGreaterThanOrEqual(1);
        expect(login.some((a) => a.phase === "signing-in")).toBe(true);
        const scale = 0.5;
        const b = LOGIN_PASSWORD_BOX;
        const inner = { x: (b.x + 8) * scale, y: (b.y + 8) * scale, w: (b.w - 16) * scale, h: (b.h - 16) * scale };
        for (const a of login) {
            const seen = await look(a.imageBase64, [inner]);
            const r = seen.regions[0]!;
            const [R, G, B] = r.mean as [number, number, number];
            expect(Math.abs(R - 71) <= 25 && Math.abs(G - 85) <= 25 && Math.abs(B - 105) <= 25, `password field is the cover colour (${[R, G, B].map(Math.round)})`).toBe(true);
            expect(r.spread).toBeLessThan(40);
        }
        // The page itself saw the marker appear and disappear around every picture it was in.
        expect(site.beacons.some((n) => n >= 1)).toBe(true);
        expect(site.beacons[site.beacons.length - 1]).toBe(0);
    }, 60_000);

    it("never carries a stored secret, a typed value or the page's own values in any answer", () => {
        const all = JSON.stringify(watched.answers.map((a) => ({ ...a, imageBase64: undefined })));
        for (const secret of [EXPLORER_USER.password, LOGIN_PREFILL]) expect(all).not.toContain(secret);
        // The sign-in line says what was done, not what was typed.
        const lines = [...new Set(watched.answers.filter((a) => a.note).map((a) => a.note as string))];
        expect(lines.every((l) => l.length <= 80)).toBe(true);
    });

    it("keeps nothing after the job ends", async () => {
        expect(frameHub.latest(jobId)).toBeUndefined();
        const r = await call("GET", frameUrl(projectId, jobId));
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ available: false, why: "finished", mime: "image/jpeg" });
        expect(r.body.imageBase64).toBeUndefined();
        expect(frameHub.isWatched(jobId)).toBe(false);
    });

    it("is a 404 for another project's job, an unknown job or an unknown project", async () => {
        const other = await newProject("Someone else");
        expect((await call("GET", frameUrl(other, jobId))).status).toBe(404);
        expect((await call("GET", frameUrl(projectId, "not-a-job"))).status).toBe(404);
        expect((await call("GET", frameUrl("not-a-project", jobId))).status).toBe(404);
    });

    it("says there is nothing to show while the AI is analysing (no browser part is running), and then recovers", async () => {
        const p = await newProject("Analysing");
        let release: () => void = () => undefined;
        gate = new Promise<void>((r) => (release = r));
        try {
            const started = await call("POST", `/api/projects/${p}/test-generation`, { ...START, credentials: undefined });
            const id = started.body.jobId as string;
            let state = "";
            for (let i = 0; i < 400 && state !== "ANALYZING"; i++) {
                state = (await getJob(id)).status;
                if (state !== "ANALYZING") await sleep(150);
            }
            expect(state).toBe("ANALYZING");
            const job = await getJob(id);
            expect(job.canWatch).toBe(false);
            const r = await call("GET", frameUrl(p, id));
            expect(r.body).toMatchObject({ available: false, why: "nothing", reason: "Nothing to show right now." });
            release();
            expect((await finished(id)).status).toBe("COMPLETED");
        } finally {
            release();
            gate = null;
        }
    }, 240_000);

    it("allows three reads a second, and a stopped job drops its picture at once", async () => {
        const p = await newProject("Stopping");
        const started = await call("POST", `/api/projects/${p}/test-generation`, START);
        const id = started.body.jobId as string;
        // Wait until the first picture is held (reading is what makes the platform take pictures).
        let got = false;
        for (let i = 0; i < 200 && !got; i++) {
            const r = await call("GET", frameUrl(p, id));
            got = r.body.available === true && Boolean(r.body.imageBase64);
            if (!got) await sleep(450);
        }
        expect(got).toBe(true);
        await sleep(1100);
        const burst = await Promise.all(Array.from({ length: 8 }, () => call("GET", frameUrl(p, id))));
        const limited = burst.filter((r) => r.status === 429);
        expect(limited.length).toBeGreaterThanOrEqual(1);
        expect(burst.filter((r) => r.status === 200).length).toBeLessThanOrEqual(3);
        expect(limited[0]!.headers["retry-after"]).toBe("1");
        expect(limited[0]!.body.error).toMatch(/three pictures a second/);
        expect(frameHub.latest(id)).toBeDefined();

        await sleep(1100);
        const stop = await call("DELETE", `/api/test-generation/${id}`);
        expect(stop.status).toBe(202);
        const after = await call("GET", frameUrl(p, id));
        expect(after.body).toMatchObject({ available: false, why: "stopping" });
        expect(after.body.imageBase64).toBeUndefined();
        expect(frameHub.latest(id)).toBeUndefined();
        const job = await finished(id);
        expect(job.status).toBe("FAILED");
        expect(frameHub.latest(id)).toBeUndefined();
    }, 240_000);
});

describe("the Explorer view: a test built from a sentence", () => {
    it("shows the browser while the test is built: phase 'building', the address and what was done", async () => {
        const p = await newProject("Plain watch");
        const imported = await call("POST", `/api/projects/${p}/specs`, {
            baseUrl: PLAIN,
            validate: false,
            specs: [{ testId: "WEB-001", title: "Home shows the shop name", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Plain Shop" } }] }],
        });
        expect(imported.status).toBe(202);
        if (imported.body.jobId) await finished(imported.body.jobId);
        const click = (role: string, name: string) => ({ tool: "click", input: { target: { by: "role", role, value: name } } });
        toolQueue.push(
            click("link", "Products"),
            click("button", "Add Blue Mug to cart"),
            { tool: "assert", input: { check: "text", target: { by: "role", role: "status" }, expected: "Total: $12.00" } },
            { tool: "finish", input: { result: "complete", explanation: "Added the mug and saw the total" } },
        );
        agentPauseMs = 1100;
        try {
            const started = await call("POST", `/api/projects/${p}/plain-tests`, { description: "Add the Blue Mug to the cart and check the total shows $12.00" });
            expect(started.status, JSON.stringify(started.body)).toBe(202);
            const w = await watch(p, started.body.jobId);
            expect(w.job.status, JSON.stringify(w.job)).toBe("COMPLETED");
            const pictures = w.answers.filter((a) => a.available && a.imageBase64);
            expect(pictures.length).toBeGreaterThanOrEqual(2);
            for (const a of pictures) {
                expect(a.phase).toBe("building");
                expect(a.url.startsWith(PLAIN)).toBe(true);
                expect(a.title).toBe("Plain Shop");
                expect(a.note).toMatch(/^(Opened \/|Clicked (Products|Add Blue Mug to cart)|Checked what the page shows)/);
            }
            expect(w.canWatch.some((c) => c === true)).toBe(true);
            expect(frameHub.latest(started.body.jobId)).toBeUndefined();
        } finally {
            agentPauseMs = 0;
        }
    }, 240_000);
});

describe("the Explorer view: the API key", () => {
    it("protects the route like every route under /api", async () => {
        const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explorer-key-"));
        const p2 = bootstrap(loadConfig({ DATA_DIR: keyDir, API_KEY: "explorer-test-key", SECRET_KEY: "test-secret-key-0123456789" }));
        const s2 = await buildServer(p2);
        try {
            const project = await s2.inject({ method: "POST", url: "/api/projects", payload: { name: "Keyed" }, headers: { "x-api-key": "explorer-test-key" } });
            const id = JSON.parse(project.body).id as string;
            const url = `/api/projects/${id}/jobs/anything/frame`;
            expect((await s2.inject({ method: "GET", url })).statusCode).toBe(401);
            expect((await s2.inject({ method: "GET", url, headers: { "x-api-key": "wrong" } })).statusCode).toBe(401);
            expect((await s2.inject({ method: "GET", url, headers: { "x-api-key": "explorer-test-key" } })).statusCode).toBe(404);
        } finally {
            await s2.close();
            p2.db.close();
            fs.rmSync(keyDir, { recursive: true, force: true });
        }
    });
});
