/**
 * Session ends on sign-out, on bench-rbac in a real browser: the check is generated from the app's API description and the access survey,
 * then run through the access helper the generated scripts carry. Red on BR-05 (the old session still works), green on the clean app.
 * The bench server runs on a loopback port and is stopped by this test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { ACCESS_HELPER_SOURCE, surveyAccess } from "../src/engine/identity/access.js";
import { generateSessionEndSpecs } from "../src/engine/identity/session-end.js";

const helper = new Function("totpCode", "createHmac", "IGNORE_HTTPS_ERRORS", `${ACCESS_HELPER_SOURCE}\nreturn { accessAssert };`)(() => "000000", createHmac, false) as { accessAssert: (page: unknown, base: string, spec: string) => Promise<void> };
const ROOT = path.resolve(__dirname, "..");
process.env.TEST_ANA_USERNAME = "ana@example.test";
process.env.TEST_ANA_PASSWORD = "Password1!";

let port = 9660;
const children: ChildProcess[] = [];
async function start(defects: string): Promise<string> {
    const p = port++;
    const child = spawn(process.execPath, [path.join(ROOT, "examples", "bench-rbac", "server.mjs"), String(p)], { env: { ...process.env, BENCH_DEFECTS: defects, BENCH_LOGIN: "html" }, stdio: "ignore" });
    children.push(child);
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${base}/openapi.json`)).ok) return base;
        } catch {
            /* not up yet */
        }
        await sleep(100);
    }
    throw new Error("bench-rbac did not start");
}

let browser: Browser;
beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    for (const c of children) c.kill();
});

async function run(defects: string): Promise<{ title: string; error?: Error }> {
    const base = await start(defects);
    const ctx = { config: loadConfig(), llm: undefined as never, emit: () => undefined };
    const apis = parseOpenApi(await (await fetch(`${base}/openapi.json`)).json(), `${base}/openapi.json`).operations;
    const reach = await surveyAccess(ctx, browser, `${base}/`, [{ name: "ana", username: "ana@example.test", password: "Password1!" }], { maxPages: 10, maxDepth: 2 });
    const specs = generateSessionEndSpecs({ apis, reach });
    expect(specs).toHaveLength(1);
    const page = await (await browser.newContext()).newPage();
    try {
        const error = await helper.accessAssert(page, `${base}/`, String((specs[0]!.steps[1] as { expected: string }).expected)).then(() => undefined, (e: Error) => e);
        return { title: specs[0]!.title, ...(error ? { error } : {}) };
    } finally {
        await page.context().close();
    }
}

describe("session ends on sign-out (bench-rbac)", () => {
    it("is red on BR-05 and green on the clean app", async () => {
        const seeded = await run("BR-05");
        expect(seeded.title).toBe("“ana” account: the session ends on sign-out");
        expect(seeded.error?.message).toMatch(/^Access control check failed: 1 session may still work after signing out\n- \[high\] After the “ana” account signed out, its old session cookies still opened GET \/api\/me \(HTTP 200\)/);
        expect(seeded.error?.message).not.toMatch(/sid=|Password1/);
        expect(await run("none")).toEqual({ title: "“ana” account: the session ends on sign-out" });
    }, 180_000);
});
