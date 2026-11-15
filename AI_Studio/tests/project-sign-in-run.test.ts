/**
 * A code project's run types the sign-in saved in Project settings → Sign-in (routes/project-sign-in.ts): a step test with
 * {{credentials.username}} and {{credentials.password}} runs in a real browser against a local sign-in page (port 9791), which receives
 * exactly the saved values; the password appears in no event the run wrote. A project with no sign-in saved fails that test with the
 * sentence that says where to enter it, and the page never receives a sign-in.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "project-sign-in-run-key-81f0c2";
const SITE_PORT = 9791;
const SITE = `http://127.0.0.1:${SITE_PORT}/`;
const PASSWORD = "Run-Saved-Pw-6c1f93";

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let site: http.Server;
let dataDir = "";
let stopBeat: (() => void) | undefined;
const received: Array<Record<string, string>> = [];

const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));

const PAGE = `<!doctype html><title>Sign in</title><form method="post" action="/login"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`;

beforeAll(async () => {
    site = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/login") {
            let data = "";
            req.on("data", (c) => (data += c));
            req.on("end", () => {
                received.push(Object.fromEntries(new URLSearchParams(data)));
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Home</title><h1>Welcome</h1>");
            });
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", () => r()));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sign-in-run-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "project-sign-in-run-secret-0123456789" }));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    await new Promise((r) => site?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A code project on the local site with one step test that signs in with the project's sign-in. */
async function codeProject(name: string): Promise<{ id: string; testId: string }> {
    const r = await call("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["code"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    expect((await call("PUT", `/api/projects/${id}/app-details`, { webUrl: SITE })).status).toBe(200);
    const spec = TestSpecSchema.parse({
        testId: "WEB-001",
        title: "Sign in with the project's account",
        kind: "web",
        category: "Auth",
        priority: "high",
        steps: [
            { action: "navigate", url: "/" },
            { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
            { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
            { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true } },
            { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Welcome", exact: true } },
        ],
    });
    const testId = platform.repo.insertTest({ projectId: id, suiteId: platform.repo.getOrCreateSuite(id, "Auth", "auth"), jobId: null, spec, framework: "playwright", validationStatus: "PENDING", versionSource: "person" });
    return { id, testId: String(testId) };
}

async function runTests(projectId: string, testId: string) {
    const appId = String(platform.repo.getLatestApplicationPublic(projectId)!.id);
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const claimed = platform.repo.claimNextJob(60_000, "sign-in-run")!;
    expect(claimed.id).toBe(job.id);
    await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm }, claimed, "sign-in-run");
    return { job: platform.repo.getJob(job.id)!, test: platform.repo.getTest(testId)!, events: platform.db.all<{ message: string; data_json: string | null }>("SELECT message, data_json FROM agent_events WHERE job_id = ?", job.id) };
}

describe("a code project's run and its sign-in", () => {
    it("types the sign-in saved in Project settings → Sign-in", async () => {
        const { id, testId } = await codeProject("Code run signs in");
        expect((await call("PUT", `/api/projects/${id}/sign-in`, { username: "qa@shop.example", password: PASSWORD })).status).toBe(200);
        received.length = 0;
        const { test, events } = await runTests(id, testId);
        expect(received).toEqual([{ email: "qa@shop.example", password: PASSWORD }]);
        expect(test.validationStatus, String(test.validationReason)).toBe("VALIDATED");
        for (const e of events) expect(`${e.message} ${e.data_json ?? ""}`).not.toContain(PASSWORD);
    }, 240_000);

    it("with no sign-in saved, fails the test with where to enter it, and types nothing", async () => {
        const { id, testId } = await codeProject("Code run without a sign-in");
        received.length = 0;
        const { test, events } = await runTests(id, testId);
        expect(received).toEqual([]);
        expect(test.validationStatus).toBe("FAILED_VALIDATION");
        expect(test.validationReason).toBe("WEB-001 signs in with the project's sign-in, and no user name and password are saved for this run, so it was not run. Enter the sign-in in Project settings → Sign-in, then run it again.");
        expect(events.some((e) => e.message === test.validationReason)).toBe(true);
    }, 240_000);
});
