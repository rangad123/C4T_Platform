/**
 * The run path with library items: reusable steps taken from the library run on the real worker under Playwright against a small
 * fixture app exactly like the project's own steps (the copy is the project's own, so the same expansion and rendering apply), a
 * library update reaches the tests only when the project applies it, and a code test that imports a library helper is still held
 * by the custom-code switch. No model is configured (and none is used).
 * Runs a browser: node scripts/with-lock.mjs browser -- npx vitest run tests/libraries-run.test.ts
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { blockView } from "../src/platform/block-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startBlocksApp } from "./fixtures/blocks-app.js";

const PORT = 7661;
const APP = `http://127.0.0.1:${PORT}`;

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let notes: http.Server;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-libraries-run-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    ({ server: notes } = await startBlocksApp(PORT));
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    notes?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = async (method: Method, url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitJob(jobId: string) {
    for (let i = 0; i < 600; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await sleep(300);
    }
    throw new Error(`job ${jobId} did not finish`);
}

const nick = { by: "label", value: "Nickname" };
const signIn = (expected: string) => ({
    kind: "web",
    description: "Sign in with a nickname",
    params: [{ name: "nickname", default: "Ada" }],
    steps: [
        { action: "navigate", url: "/" },
        { action: "fill", locator: nick, value: "{{nickname}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true } },
        { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected },
    ],
});
const spec = (title: string, steps: unknown[]) => ({ title, kind: "web", category: "Notes", steps });

describe("library items on the run path", () => {
    let pid = "";
    let item = "";
    let testId = "";

    it("runs a test that uses reusable steps taken from the library, like the project's own", async () => {
        const made = await call("POST", "/api/libraries/items", { organizationId: null, kind: "steps", name: "Sign in", content: signIn("Signed in as {{nickname}}") });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        item = made.body.item.id;
        pid = (await call("POST", "/api/projects", { name: "Notes", url: APP })).body.id;
        expect((await call("POST", `/api/projects/${pid}/library/use`, { itemId: item })).status).toBe(201);
        const imp = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, specs: [spec("Grace signs in", [{ action: "useBlock", block: "Sign in", args: { nickname: "Grace" } }])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        testId = imp.body.tests[0].id;
        expect((await waitJob(imp.body.jobId)).status).toBe("COMPLETED");
        const t = (await call("GET", `/api/tests/${testId}`)).body;
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.scripts[0].content).toContain("Grace");
        expect(t.scripts[0].content).not.toMatch(/useBlock|library/i);
        // What the worker expands is the library version's steps, unchanged.
        const expanded = blockView(platform.db, pid)(t.spec);
        expect(expanded.steps.map((s: { action: string }) => s.action)).toEqual(["navigate", "fill", "click", "assert"]);
    }, 180_000);

    it("a new library version changes nothing in the project until the project updates its copy, then the tests are checked again", async () => {
        // A version the fixture app does not satisfy: if it reached the test on its own, the next run would fail.
        expect((await call("PUT", `/api/libraries/items/${item}/content`, { content: signIn("Signed in as nobody {{nickname}}"), note: "Wrong on purpose" })).body.added).toBe(true);
        const block = (await call("GET", `/api/projects/${pid}/blocks/${encodeURIComponent("Sign in")}`)).body;
        expect(block.steps[3].expected).toBe("Signed in as {{nickname}}");
        const app = platform.repo.getLatestApplicationPublic(pid)!;
        const job = await platform.repo.createJob(pid, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
        expect((await waitJob(job.id)).status).toBe("COMPLETED");
        expect((await call("GET", `/api/tests/${testId}`)).body.validationStatus).toBe("VALIDATED");

        // Now the project takes it: the project's block route re-renders and re-validates the test, which fails against the app.
        const up = await call("POST", `/api/projects/${pid}/library/update`, { itemId: item });
        expect(up.status, JSON.stringify(up.body)).toBe(200);
        expect(up.body.project.appliesTo).toBe(1);
        expect(up.body.project.revalidation.status, JSON.stringify(up.body.project.revalidation)).toBe("started");
        const jobId = up.body.project.revalidation.jobId as string | undefined;
        expect(jobId).toBeTruthy();
        await waitJob(jobId!);
        expect((await call("GET", `/api/tests/${testId}`)).body.validationStatus).not.toBe("VALIDATED");
    }, 180_000);

    it("a code test importing a library helper is still held by the custom-code switch", async () => {
        const helper = await call("POST", "/api/libraries/items", { organizationId: null, kind: "helper", name: "open-notes", content: { content: 'import type { Page } from "@playwright/test";\nexport async function open(page: Page) {\n  await page.goto("/");\n}\n' } });
        expect(helper.status, JSON.stringify(helper.body)).toBe(201);
        expect((await call("POST", `/api/projects/${pid}/library/use`, { itemId: helper.body.item.id })).status).toBe(201);
        const code = `import { test, expect } from "@playwright/test";\nimport { open } from "./helpers/open-notes";\ntest("opens", async ({ page }) => {\n  await open(page);\n  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();\n});\n`;
        const made = await call("POST", `/api/projects/${pid}/custom-tests`, { title: "Opens notes", kind: "web", content: code });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        // No helper-missing warning: the copy is the project's helper.
        expect((made.body.diagnostics as Array<{ rule: string }>).map((d) => d.rule)).not.toContain("helper-missing");
        if (made.body.jobId) await waitJob(made.body.jobId);
        const t = (await call("GET", `/api/tests/${made.body.testId}`)).body;
        expect(t.validationStatus).not.toBe("VALIDATED");
        expect(JSON.stringify([made.body.note ?? "", t.validationReason ?? "", t.reason ?? "", t.lastError ?? ""])).toMatch(/ALLOW_CUSTOM_SCRIPTS|allow-custom-scripts/);
    }, 180_000);
});
