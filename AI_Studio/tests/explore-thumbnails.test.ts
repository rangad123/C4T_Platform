/**
 * Sheet #8 stage 5: page thumbnails kept with an exploration (owner 2026-11-21: per project, "Keep page thumbnails", on by default).
 *
 * - Covered: a thumbnail of a page with a password field shows the cover where the field is (checked on the picture's pixels) while an
 *   ordinary field next to it shows as it is, and the page itself is left unchanged.
 * - Fails closed: a page that cannot be covered (more frames than are looked at) gets no thumbnail; nothing is stored.
 * - Through a real job on the embedded worker (HTTP API -> queue -> worker -> a real crawl of a small local site, a scripted model double
 *   for reading and planning): with the switch never saved, every page gets a covered JPEG of at most 320 px and 40 KB, kept as a
 *   screenshot artifact of the job and named on the page of the saved model; with the switch saved off, none is taken or stored.
 *
 * node scripts/with-lock.mjs browser -- npx vitest run tests/explore-thumbnails.test.ts
 * Ports: fixture site 6763.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createThumbnailer, THUMBNAIL_LIMITS } from "../src/engine/discovery/thumbnails.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import type { PageModel } from "../src/engine/understanding/app-model.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6763;
const SITE = `http://127.0.0.1:${PORT}`;
/** The cover frames/shoot.ts paints over a secret field. */
const COVER = [0x47, 0x55, 0x69];

/** A sign-in page: a large password field (red, holding a value) at the left, a large ordinary field (red) at the right. */
const SIGN_IN = `<h1 style="margin:0;height:200px">Sign in</h1>
<input type="password" name="password" value="hunter2-secret" aria-label="Password" style="position:absolute;left:0;top:200px;width:600px;height:200px;border:0;background:#ff0000;color:#00ff00;font-size:120px">
<input type="text" name="nickname" value="Visible" aria-label="Nickname" style="position:absolute;left:660px;top:200px;width:600px;height:200px;border:0;background:#ff0000;color:#ff0000;font-size:120px">
<a href="/products" style="position:absolute;top:500px">Products</a>`;
const PAGES: Record<string, string> = {
    "/": SIGN_IN,
    "/products": `<h1>Products</h1><a href="/">Home</a>`,
};
const html = (body: string) => `<!doctype html><html lang="en"><head><title>Shop</title></head><body style="margin:0">${body}</body></html>`;

let site: http.Server;
let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

const scripted: LlmClient = {
    modelName: "scripted",
    model: undefined as never,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        if (/list what they state about its intended behaviour/.test(system)) return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
        if (/analysing a web application/.test(system)) {
            return { siteType: "ecommerce", purpose: "A small shop", features: ["Browse products"], pagePurposes: [], journeys: [{ name: "Browse", description: "Look", steps: ["Open products"], priority: "high", pages: ["/products"], requiresAuth: false }], authenticationMechanisms: [] };
        }
        return { scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Browse the product list", description: "Browse", category: "Browsing", priority: "high", journey: "Browse", startPath: "/products", expectedResults: ["Products is shown"] })] };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", "http://x").pathname;
        const body = PAGES[p];
        if (!body) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html(body));
    });
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", () => r()));
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-thumbs-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0", SECRET_KEY: "test-secret-key-0123456789", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await browser?.close();
    site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

/** The colour of one pixel of a JPEG, read by the browser (no image library needed). */
async function pixel(jpeg: Uint8Array, x: number, y: number): Promise<{ rgb: number[]; width: number; height: number }> {
    const viewer = await browser.newPage();
    try {
        return await viewer.evaluate(
            async ([b64, px, py]) => {
                const img = new Image();
                img.src = `data:image/jpeg;base64,${b64}`;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const g = c.getContext("2d")!;
                g.drawImage(img, 0, 0);
                const d = g.getImageData(px as number, py as number, 1, 1).data;
                return { rgb: [d[0]!, d[1]!, d[2]!], width: img.naturalWidth, height: img.naturalHeight };
            },
            [Buffer.from(jpeg).toString("base64"), x, y] as [string, number, number],
        );
    } finally {
        await viewer.close();
    }
}
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const stubModel = (): PageModel => ({ url: SITE, path: "/", title: "", type: "other", depth: 0, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] });

describe("a page thumbnail", () => {
    it("covers the password field (pixel check), shows an ordinary field as it is, and leaves the page unchanged", async () => {
        await page.goto(`${SITE}/`);
        const saved: Array<{ name: string; jpeg: Uint8Array }> = [];
        const thumbs = createThumbnailer({ save: async (name, jpeg) => (saved.push({ name, jpeg }), `id-${saved.length}`), secrets: [] });
        const model = stubModel();
        await thumbs.take(page, model);
        expect(saved).toHaveLength(1);
        expect(saved[0]!.name).toBe("thumb-1.jpg");
        expect(model.thumbnail).toBe("id-1");
        const jpeg = saved[0]!.jpeg;
        expect(jpeg.byteLength).toBeLessThanOrEqual(THUMBNAIL_LIMITS.maxBytes);
        // 1280 CSS px shrink to 320: the password field (x 0-600, y 200-400) is at x 0-150, y 50-100; the ordinary one at x 165-315.
        const secret = await pixel(jpeg, 75, 75);
        expect(secret.width).toBe(320);
        expect(near(secret.rgb, COVER), `password field pixel ${secret.rgb}`).toBe(true);
        const plain = await pixel(jpeg, 240, 75);
        expect(near(plain.rgb, [255, 0, 0]), `ordinary field pixel ${plain.rgb}`).toBe(true);
        // The cover is gone again: the field shows its own colours and value.
        expect(await page.locator('input[type="password"]').evaluate((el) => [getComputedStyle(el).backgroundColor, (el as HTMLInputElement).value, el.hasAttribute("data-aitp-xmask")])).toEqual(["rgb(255, 0, 0)", "hunter2-secret", false]);
    });

    it("is not taken, and nothing is stored, when the page cannot be covered", async () => {
        // More frames than the cover looks at (frames/shoot.ts MAX_FRAMES): the cover refuses, so no picture is taken.
        await page.goto(`${SITE}/`);
        await page.evaluate(() => {
            for (let i = 0; i < 13; i++) document.body.appendChild(Object.assign(document.createElement("iframe"), { srcdoc: '<input type="password" value="x">' }));
        });
        await page.waitForFunction(() => document.querySelectorAll("iframe").length === 13 && Array.from(document.querySelectorAll("iframe")).every((f) => f.contentDocument?.readyState === "complete"));
        expect(page.frames().length).toBeGreaterThan(12);
        let calls = 0;
        const thumbs = createThumbnailer({ save: async () => (calls++, "id"), secrets: [] });
        const model = stubModel();
        await thumbs.take(page, model);
        expect(calls).toBe(0);
        expect(model.thumbnail).toBeUndefined();
        expect(thumbs.kept).toBe(0);
        // The same page with a frame that can be covered gets its picture (the refusal above came from the cover, nothing else).
        await page.goto(`${SITE}/`);
        await page.evaluate(() => document.body.appendChild(Object.assign(document.createElement("iframe"), { srcdoc: '<input type="password" value="x">' })));
        await thumbs.take(page, model);
        expect(calls).toBe(1);
    });
});

describe("explorations keep thumbnails as the project says", () => {
    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, type: String(res.headers["content-type"] ?? ""), raw: res.rawPayload, body: /^[[{]/.test(res.body) ? JSON.parse(res.body) : res.body };
    };
    const explore = async (projectId: string) => {
        const s = await call("POST", `/api/projects/${projectId}/test-generation`, { url: SITE, maxPages: 10, targets: ["web"], plan: true, useMemory: false });
        expect(s.status, JSON.stringify(s.body)).toBe(202);
        const end = Date.now() + 240_000;
        let j: { status: string; error?: string } = { status: "" };
        while (Date.now() < end && !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes((j = (await call("GET", `/api/test-generation/${s.body.jobId}`)).body).status)) await new Promise((r) => setTimeout(r, 200));
        expect(j.status, JSON.stringify(j)).toBe("COMPLETED");
        return s.body.jobId as string;
    };
    const shotsOf = (jobId: string) => platform.db.all<{ id: string; path: string; size: number }>("SELECT id, path, size FROM artifacts WHERE job_id = ? AND kind = 'screenshot'", jobId);
    const newProject = async (name: string) => {
        const id = (await call("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"] })).body.id as string;
        platform.repo.createApplication(id, SITE, {});
        return id;
    };

    it("never saved (on): each page gets a covered JPEG kept with the job, named on its page and served as image/jpeg", async () => {
        const projectId = await newProject("Thumbs on");
        expect((await call("GET", `/api/projects/${projectId}/agent-inputs`)).body.keepThumbnails).toBe(true);
        const jobId = await explore(projectId);
        const shots = shotsOf(jobId);
        expect(shots.length).toBeGreaterThanOrEqual(2);
        for (const s of shots) {
            expect(s.path).toMatch(new RegExp(`^${projectId}/_artifacts/${jobId}/thumbnails/thumb-\\d+\\.jpg$`));
            expect(s.size).toBeLessThanOrEqual(THUMBNAIL_LIMITS.maxBytes);
        }
        const model = platform.repo.getLatestAppModel(projectId) as { pages: PageModel[] };
        const home = model.pages.find((p) => p.path === "/")!;
        expect(shots.map((s) => s.id)).toContain(home.thumbnail);
        const served = await call("GET", `/api/artifacts/${home.thumbnail}`);
        expect(served.status).toBe(200);
        expect(served.type).toBe("image/jpeg");
        expect(near((await pixel(served.raw, 75, 75)).rgb, COVER)).toBe(true);
        // What the explorer knows names it on its page.
        const k = (await call("GET", `/api/projects/${projectId}/jobs/${jobId}/knowledge`)).body;
        expect(k.siteMap.pages.find((p: { path: string }) => p.path === "/").thumbnail).toBe(home.thumbnail);
    }, 300_000);

    it("saved off: none is taken or stored", async () => {
        const projectId = await newProject("Thumbs off");
        const off = await call("PUT", `/api/projects/${projectId}/agent-inputs`, { keepThumbnails: false });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        const jobId = await explore(projectId);
        expect(shotsOf(jobId)).toEqual([]);
        const model = platform.repo.getLatestAppModel(projectId) as { pages: PageModel[] };
        expect(model.pages.length).toBeGreaterThanOrEqual(2);
        expect(model.pages.some((p) => p.thumbnail)).toBe(false);
    }, 300_000);
});
