/**
 * A project that has a website AND a phone app: one exploration covers both. The website and API part runs first, exactly as before; then the AI explores the
 * phone. The plan carries both, the counts add up, and creating from it makes the checks of both and runs each where it belongs.
 *
 * Starts a real browser for the website part, so it runs under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/mobile-explore-mixed.test.ts
 * The website is a tiny local server on port 6670; the phone is the fake adb's shop app; the AI model is a scripted double.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { scriptedPhoneModel } from "./fixtures/phone-model.js";

const PORT = 6670;
const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

let tmp: string;
let site: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let model: LlmClient;
const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mobile-mixed-"));
    for (const d of ["sdk/platform-tools", "jdk/bin", "home", "avd"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sdk/platform-tools", exe("adb")), "");
    fs.writeFileSync(path.join(tmp, "jdk/bin", exe("java")), "");
    fs.writeFileSync(path.join(tmp, "home/manifest.json"), JSON.stringify({ androidHome: path.join(tmp, "sdk"), javaHome: path.join(tmp, "jdk") }));
    fs.writeFileSync(path.join(tmp, "avd/Pixel_Test.ini"), "target=android-34\n");
    setEnv({
        TAQWRIGHT_HOME: path.join(tmp, "home"),
        ANDROID_AVD_HOME: path.join(tmp, "avd"),
        ANDROID_HOME: "",
        MOBILE_RUNNER_CLI: FAKE_CLI,
        AITP_ADB_PATH: FAKE_ADB,
        AITP_FAKE_APP: "shop",
        AITP_FAKE_STATE: path.join(tmp, "phone.json"),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        LLM_API_KEY: "",
    });
    site = http.createServer((req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html><html lang='en'><head><title>Shop site</title></head><body><main><h1>Shop site</h1></main></body></html>");
        } else {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
        }
    });
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", r));
    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MOBILE_KEEP_EMULATOR: "true", SECRET_KEY: "test-secret-key-0123456789" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => model }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.close();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
async function finished(jobId: string): Promise<any> {
    for (let i = 0; i < 1200; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("job did not finish");
}

describe("a website and a phone app in one project", () => {
    it("plans both, counts both, creates both and runs each where it belongs", async () => {
        const id = (await call("POST", "/api/projects", { name: "Both" })).body.id as string;
        expect((await call("PUT", `/api/projects/${id}/mobile-app`, { appPackage: "com.example.shop" })).status).toBe(200);
        const llm = scriptedPhoneModel([{ tap: "Products" }, { tap: "Product 1" }, { back: true }, { tap: "Cart" }, { finish: true }]);
        model = llm;
        const started = await call("POST", `/api/projects/${id}/test-generation`, { url: `http://127.0.0.1:${PORT}`, targets: ["api", "mobile"], plan: true, maxPages: 3 });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const planJob = await finished(started.body.jobId);
        expect(planJob.status, planJob.error ?? "").toMatch(/COMPLETED/);

        const plan = (await call("GET", `/api/projects/${id}/plans/${started.body.jobId}`)).body;
        expect(plan.targets).toEqual(["api", "mobile"]);
        expect(plan.phone.ideas.length).toBeGreaterThan(2);
        const families = plan.families as Array<{ id: string; effective: number; needs: string }>;
        const phone = families.filter((f) => f.needs === "mobile");
        const other = families.filter((f) => f.needs !== "mobile");
        expect(phone.reduce((n, f) => n + f.effective, 0)).toBe(plan.phone.ideas.length);
        expect(other.length).toBeGreaterThan(0);
        // The browser journeys count none of the phone ideas.
        expect(families.find((f) => f.id === "journeys")?.effective ?? 0).toBe(0);
        expect(plan.total).toBe(families.reduce((n, f) => n + f.effective, 0));
        expect((await call("GET", `/api/projects/${id}/tests`)).body).toEqual([]);

        const callsBefore = llm.calls;
        const created = await call("POST", `/api/projects/${id}/plans/${started.body.jobId}/create`, {});
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        const job = await finished(created.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const tests = (await call("GET", `/api/projects/${id}/tests`)).body as Array<{ testId: string; kind: string; validationStatus: string }>;
        const mobile = tests.filter((t) => t.kind === "mobile");
        expect(mobile).toHaveLength(plan.phone.ideas.length);
        expect(mobile.every((t) => t.validationStatus === "VALIDATED")).toBe(true);
        expect(tests.length).toBeGreaterThan(mobile.length);
        expect(tests.length).toBe(plan.total);
        // The phone was not explored a second time.
        expect(llm.turns.length).toBeGreaterThan(0);
        expect(llm.calls).toBe(callsBefore);
    }, 300_000);
});
