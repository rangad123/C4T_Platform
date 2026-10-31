/**
 * Named environments with a read-only production mode, run for real: the same imported tests are validated on the project's own
 * address and then against a "staging" fixture server (one harmless bug) and a "production" fixture server (correct). Each
 * environment keeps its own stored result; the main run, the test's status and the JUnit file never change. Also: write-only
 * encrypted secrets that really reach the scripts, the production confirmation and read-only rules, the SSRF guard, schedules
 * that run against an environment, and the `ai-test run --env` command.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/environments.test.ts
 * Ports: staging 5510, production 5511, platform 5512.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { changesData, caseDuplicates, envVarFor, variableEnv } from "../src/engine/environments/env.js";
import { classifyEnvironmentRun, skipReason } from "../src/engine/environments/run.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { ENV_SPECS, startEnvironmentsApp, type EnvironmentsApp } from "./fixtures/environments-app.js";

const STAGING_PORT = 5510;
const PROD_PORT = 5511;
const PLATFORM_PORT = 5512;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const STAGING = `http://127.0.0.1:${STAGING_PORT}`;
const PROD = `http://127.0.0.1:${PROD_PORT}`;
const PROD_TOKEN = "prod-token-6c1f0a";
const STAGING_TOKEN = "stg-token-92be4d";

let staging: EnvironmentsApp;
let prod: EnvironmentsApp;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let projectId: string;
const saved = process.env.BLOCK_PRIVATE_TARGETS;

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; text: string; body: any };
};

async function idle(): Promise<void> {
    for (let i = 0; i < 480; i++) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("project never became idle");
}

const tests = async () => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; validationStatus: string }>;
const idOf = async (key: string) => (await tests()).find((t) => t.testId === key)!.id;
const results = async (env: string) => {
    const r = (await call("GET", `/api/projects/${projectId}/environments/${env}/results`)).body;
    return { summary: r.summary, by: Object.fromEntries(r.tests.map((t: any) => [t.testId, t.result])) as Record<string, any> };
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    staging = await startEnvironmentsApp(STAGING_PORT, { label: "staging", bug: true, token: STAGING_TOKEN });
    prod = await startEnvironmentsApp(PROD_PORT, { label: "production", bug: false, token: PROD_TOKEN });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-env-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    // Wired like the real server, so a finished job also goes through the run-summary hook.
    worker = new Worker({ ...platform, onJobFinished: getScheduleServices(platform).onJobFinished }, 200);
    worker.start();
}, 60_000);

afterAll(async () => {
    if (saved === undefined) delete process.env.BLOCK_PRIVATE_TARGETS;
    else process.env.BLOCK_PRIVATE_TARGETS = saved;
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await staging?.close();
    await prod?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the rules (no browser)", () => {
    const spec = (o: Record<string, unknown>) => TestSpecSchema.parse({ testId: "API-001", title: "A test", kind: "api", steps: [{ action: "request", method: "GET", path: "/x" }], ...o });

    it("recognises tests that change data, and says why production skips them", () => {
        expect(changesData(spec({}))).toBe(false);
        for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) expect(changesData(spec({ steps: [{ action: "request", method, path: "/x" }] })), method).toBe(true);
        for (const method of ["GET", "HEAD", "OPTIONS"] as const) expect(changesData(spec({ steps: [{ action: "request", method, path: "/x" }] })), method).toBe(false);
        const web = (expected: string) => spec({ kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "inputHandling", expected }] });
        expect(changesData(web("safe"))).toBe(false);
        expect(changesData(web("all"))).toBe(true);
        expect(changesData(web("all nolimits"))).toBe(true);
        expect(changesData(spec({ tags: ["Changes-Data"] }))).toBe(true); // a person can say so for tests the steps cannot reveal
        expect(skipReason(spec({ steps: [{ action: "request", method: "POST", path: "/x" }] }), { production: true })).toMatch(/production is read-only/);
        expect(skipReason(spec({ steps: [{ action: "request", method: "POST", path: "/x" }] }), { production: false })).toBeUndefined();
        expect(skipReason(spec({ kind: "mobile", steps: [{ action: "navigate", url: "/" }] }), { production: false })).toMatch(/device/);
        expect(skipReason(spec({ kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot" }] }), { production: false })).toMatch(/Visual/);
    });

    it("hands variables to scripts as TEST_ENV_<NAME> and refuses names that would collide", () => {
        expect(envVarFor("greeting_name")).toBe("TEST_ENV_GREETING_NAME");
        expect(variableEnv({ Region: "eu", token_id: "7" })).toEqual({ TEST_ENV_REGION: "eu", TEST_ENV_TOKEN_ID: "7" });
        expect(caseDuplicates(["Region", "REGION"])).toBeTruthy();
        expect(caseDuplicates(["Region", "Zone"])).toBeUndefined();
    });

    it("sorts a finished run into passed, an application finding, or a plain failure", () => {
        const run = (o: Partial<ScriptRun>): ScriptRun => ({ testId: "API-001", status: "failed", durationMs: 5, failedStepIndex: 1, steps: [{ index: 1, title: "2. GET /x", status: "failed", error: "expected 200" }], artifacts: [], responses: [], ...o });
        expect(classifyEnvironmentRun(spec({}), run({ status: "passed", steps: [] }))).toEqual({ status: "passed" });
        const failed = classifyEnvironmentRun(spec({}), run({}));
        expect(failed.status).toBe("failed");
        expect(failed.reason).toContain("2. GET /x");
        // A 5xx is a fact about the application, not about the test.
        const finding = classifyEnvironmentRun(spec({}), run({ responses: [{ method: "GET", path: "/x", status: 503 }] }));
        expect(finding.status).toBe("finding");
        expect(finding.reason).toMatch(/Server error/);
    });
});

describe("a project validated on its own address first", () => {
    it("imports the tests against the production-like server and they all validate", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Environments" })).body.id;
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: ENV_SPECS, baseUrl: PROD, credentials: { apiToken: PROD_TOKEN } });
        expect(imported.status, imported.text).toBe(202);
        await idle();
        const all = await tests();
        expect(all.map((t) => t.validationStatus)).toEqual(["VALIDATED", "VALIDATED", "VALIDATED", "VALIDATED", "VALIDATED"]);
        prod.reset();
    }, 240_000);
});

describe("environments: the API", () => {
    it("creates, lists and validates environments in plain words", async () => {
        const bad = await call("POST", `/api/projects/${projectId}/environments`, { name: "Bad Name", baseUrl: STAGING });
        expect(bad.status).toBe(400);
        const path = await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: `${STAGING}/shop` });
        expect(path.status).toBe(400);
        expect(JSON.stringify(path.body.details)).toMatch(/just the site's address/);
        const dupVars = await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: STAGING, variables: { Region: "a", REGION: "b" } });
        expect(dupVars.status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: STAGING, variables: { "bad-name": "x" } })).status).toBe(400);

        const created = await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: `${STAGING}/`, variables: { GREETING_NAME: "Ada" } });
        expect(created.status, created.text).toBe(201);
        expect(created.body).toMatchObject({ name: "staging", baseUrl: STAGING, production: false, isDefault: true, useProjectAccounts: true, variables: { GREETING_NAME: "Ada" }, hasPassword: false, hasApiToken: false });
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: STAGING })).status).toBe(400); // duplicate name

        const prodEnv = await call("POST", `/api/projects/${projectId}/environments`, { name: "production", baseUrl: PROD, production: true, variables: { GREETING_NAME: "Grace" } });
        expect(prodEnv.status, prodEnv.text).toBe(201);
        expect(prodEnv.body.production).toBe(true);
        expect(prodEnv.body.isDefault).toBe(false);
        // Nothing should run on production by accident: it can never be the default.
        expect((await call("POST", `/api/projects/${projectId}/environments/production/default`)).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "prod2", baseUrl: PROD, production: true, isDefault: true })).status).toBe(400);
        const list = (await call("GET", `/api/projects/${projectId}/environments`)).body;
        expect(list.environments.map((e: any) => e.name)).toEqual(["staging", "production"]);
    });

    it("keeps sign-in details write-only and encrypted", async () => {
        const put = await call("PUT", `/api/projects/${projectId}/environments/staging/secrets`, { apiToken: STAGING_TOKEN, username: "stg-user", password: "stg-password-77d1" });
        expect(put.status).toBe(200);
        expect(put.body).toMatchObject({ hasApiToken: true, hasPassword: true, username: "stg-user" });
        expect(put.text).not.toContain(STAGING_TOKEN);
        expect(put.text).not.toContain("stg-password-77d1");
        expect((await call("PUT", `/api/projects/${projectId}/environments/production/secrets`, { apiToken: PROD_TOKEN })).status).toBe(200);
        // Everything the API says about environments, in every shape.
        for (const url of ["", "/staging/results", "/production/results"]) {
            const text = (await call("GET", `/api/projects/${projectId}/environments${url}`)).text;
            expect(text, url).not.toContain(STAGING_TOKEN);
            expect(text, url).not.toContain(PROD_TOKEN);
            expect(text, url).not.toContain("stg-password-77d1");
        }
        // At rest: one encrypted blob that the platform's own key opens.
        const row = platform.db.get<{ secrets_enc: string }>("SELECT secrets_enc FROM project_environments WHERE name = 'staging'")!;
        expect(row.secrets_enc).not.toContain(STAGING_TOKEN);
        expect(row.secrets_enc).not.toContain("stg-user");
        const opened = new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY).decrypt<Record<string, string>>(row.secrets_enc);
        expect(opened.apiToken).toBe(STAGING_TOKEN);
        // Leaving a field out keeps it; an empty string removes it.
        await call("PUT", `/api/projects/${projectId}/environments/staging/secrets`, { username: "" });
        const after = (await call("GET", `/api/projects/${projectId}/environments`)).body.environments.find((e: any) => e.name === "staging");
        expect(after).toMatchObject({ username: null, hasApiToken: true, hasPassword: true });
    });

    it("applies the outbound-address guard to every environment address", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const created = await call("POST", `/api/projects/${projectId}/environments`, { name: "internal", baseUrl: "http://127.0.0.1:9" });
            expect(created.status).toBe(400);
            expect(created.text).toMatch(/private|loopback/i);
            const api = await call("PUT", `/api/projects/${projectId}/environments/staging`, { apiBaseUrl: "http://localhost:9/v1" });
            expect(api.status).toBe(400);
            // A run refuses too (the guard is checked when the run starts, not only when the environment was saved).
            const run = await call("POST", `/api/projects/${projectId}/environments/staging/runs`, {});
            expect(run.status).toBe(400);
        } finally {
            if (saved === undefined) delete process.env.BLOCK_PRIVATE_TARGETS;
            else process.env.BLOCK_PRIVATE_TARGETS = saved;
        }
        expect((await call("GET", `/api/projects/${projectId}/environments`)).body.environments).toHaveLength(2);
    });
});

describe("the same tests against staging and production", () => {
    let junitBefore = "";
    let execBefore: Record<string, number> = {};

    it("runs against staging with its own address, token and variables, and stores the result for staging only", async () => {
        junitBefore = (await call("GET", `/api/projects/${projectId}/junit`)).text;
        for (const t of await tests()) execBefore[t.testId] = ((await call("GET", `/api/tests/${t.id}/executions`)).body as unknown[]).length;
        staging.reset();
        const started = await call("POST", `/api/projects/${projectId}/environments/staging/runs`, {});
        expect(started.status, started.text).toBe(202);
        expect(started.body).toMatchObject({ environment: "staging", production: false, testCount: 5 });
        await idle();

        const r = await results("staging");
        expect(r.summary).toMatchObject({ passed: 4, failed: 1, findings: 0, skipped: 0, notRun: 0 });
        expect(r.by["WEB-001"].status).toBe("failed"); // the harmless staging bug: "$5O"
        expect(r.by["WEB-001"].reason).toMatch(/5O|over/);
        expect(r.by["WEB-001"].failedStep).toMatchObject({ index: 1 });
        expect(r.by["WEB-001"].artifacts.some((a: any) => a.kind === "screenshot")).toBe(true);
        for (const key of ["WEB-002", "API-001", "API-002", "API-003"]) expect(r.by[key].status, key).toBe("passed");
        // The environment's own variable reached the script, and its own token reached the request.
        expect(staging.lastGreeting).toBe("Ada");
        expect(staging.hits.find((h) => h.path === "/api/me")?.auth).toBe(`Bearer ${STAGING_TOKEN}`);
        expect(staging.mutations).toBe(1); // staging is not read-only
        expect(prod.hits).toHaveLength(0); // nothing went to the project's own address
        const job = (await call("GET", `/api/projects/${projectId}/jobs`)).body[0];
        expect(job).toMatchObject({ mode: "environment", status: "PARTIALLY_COMPLETED" });
    }, 240_000);

    it("leaves the main run, the test's status and the JUnit file exactly as they were", async () => {
        expect((await call("GET", `/api/projects/${projectId}/junit`)).text).toBe(junitBefore);
        for (const t of await tests()) {
            expect(t.validationStatus, t.testId).toBe("VALIDATED");
            expect(((await call("GET", `/api/tests/${t.id}/executions`)).body as unknown[]).length, t.testId).toBe(execBefore[t.testId]);
        }
        const detail = (await call("GET", `/api/tests/${await idOf("WEB-001")}`)).body;
        expect(detail.validationStatus).toBe("VALIDATED");
        expect(detail.executions).toHaveLength(1);
        expect(detail.environmentResults.staging).toMatchObject({ status: "failed" });
        expect(detail.environmentResults.production).toBeUndefined();
        // Browser matrix and trends know nothing about environment rows.
        expect(detail.compatibility).toEqual({});
        const flaky = (await call("GET", `/api/projects/${projectId}/flaky`)).body;
        expect(JSON.stringify(flaky)).not.toContain("WEB-001");
    });

    it("refuses production without a confirmation, and creates no job for it", async () => {
        const before = ((await call("GET", `/api/projects/${projectId}/jobs`)).body as unknown[]).length;
        const refused = await call("POST", `/api/projects/${projectId}/environments/production/runs`, {});
        expect(refused.status).toBe(409);
        expect(refused.body.details).toMatchObject({ requiresConfirmation: true });
        expect(refused.body.error).toMatch(/production/);
        for (const [url, body] of [
            [`/api/tests/${await idOf("WEB-001")}/validate`, { environment: "production" }],
            [`/api/projects/${projectId}/validation`, { environment: "production" }],
        ] as const) {
            const r = await call("POST", url, body);
            expect(r.status, url).toBe(409);
            expect(r.body.details, url).toMatchObject({ requiresConfirmation: true });
        }
        expect(((await call("GET", `/api/projects/${projectId}/jobs`)).body as unknown[]).length).toBe(before);
        expect(prod.hits).toHaveLength(0);
    });

    it("runs on production only when confirmed, never changes data there, and says why a test was skipped", async () => {
        prod.reset();
        const started = await call("POST", `/api/projects/${projectId}/environments/production/runs`, { confirmProduction: true });
        expect(started.status, started.text).toBe(202);
        expect(started.body).toMatchObject({ production: true, testCount: 4 });
        expect(started.body.skipped).toEqual([expect.objectContaining({ testId: "API-002", reason: expect.stringMatching(/production is read-only/) })]);
        await idle();

        const r = await results("production");
        expect(r.by["API-002"]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/production is read-only/) });
        for (const key of ["WEB-001", "WEB-002", "API-001", "API-003"]) expect(r.by[key].status, key).toBe("passed");
        expect(prod.mutations).toBe(0); // the one test that would have created an item never ran
        expect(prod.hits.some((h) => h.path === "/api/items" && h.method === "POST")).toBe(false);
        expect(prod.lastGreeting).toBe("Grace");
        // Different environments, different stored results for the very same test.
        expect((await results("staging")).by["WEB-001"].status).toBe("failed");
        expect(r.by["WEB-001"].status).toBe("passed");
    }, 240_000);

    it("does not pile up identical 'skipped' rows when production is run again, and the single-test route works", async () => {
        const skippedRows = () => platform.db.all("SELECT 1 FROM test_executions WHERE environment = 'production' AND status = 'skipped'").length;
        expect(skippedRows()).toBe(1);
        const again = await call("POST", `/api/projects/${projectId}/validation`, { environment: "production", confirmProduction: true });
        expect(again.status, again.text).toBe(202);
        await idle();
        expect(skippedRows()).toBe(1);
        const one = await call("POST", `/api/tests/${await idOf("WEB-001")}/validate`, { environment: "staging" });
        expect(one.status, one.text).toBe(202);
        expect(one.body.testCount).toBe(1);
        await idle();
        const detail = (await call("GET", `/api/tests/${await idOf("WEB-001")}`)).body;
        expect(Object.keys(detail.environmentResults).sort()).toEqual(["production", "staging"]);
        expect(detail.executions).toHaveLength(1); // still only the main run
    }, 300_000);

    it("refuses a run in which nothing could run, with the reason", async () => {
        const only = await call("POST", `/api/projects/${projectId}/environments/production/runs`, { testIds: [await idOf("API-002")], confirmProduction: true });
        expect(only.status).toBe(422);
        expect(only.body.error).toMatch(/production is read-only/);
        expect((await call("POST", `/api/projects/${projectId}/environments/nowhere/runs`, {})).status).toBe(404);
        expect((await call("POST", `/api/projects/${projectId}/environments/staging/runs`, { testIds: ["nope"] })).status).toBe(400);
    });
});

describe("schedules that run against an environment", () => {
    let scheduleId = "";

    it("saves the environment on a re-run schedule, and asks for the production confirmation", async () => {
        const body = { kind: "validate", cadence: { type: "daily", time: "03:00" }, environment: "staging" };
        const created = await call("POST", `/api/projects/${projectId}/schedules`, body);
        expect(created.status, created.text).toBe(201);
        expect(created.body).toMatchObject({ environment: "staging", confirmProduction: false });
        scheduleId = created.body.id;
        const plain = await call("POST", `/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "04:00" } });
        expect(plain.body).toMatchObject({ environment: null });
        await call("DELETE", `/api/projects/${projectId}/schedules/${plain.body.id}`);

        expect((await call("POST", `/api/projects/${projectId}/schedules`, { ...body, environment: "production" })).status).toBe(409);
        expect((await call("POST", `/api/projects/${projectId}/schedules`, { ...body, kind: "generate", environment: "staging" })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/schedules`, { ...body, environment: "nowhere" })).status).toBe(404);
        const listed = (await call("GET", `/api/projects/${projectId}/schedules`)).body.schedules;
        expect(listed).toHaveLength(1);
        expect(listed[0].environment).toBe("staging");
    });

    it("runs the schedule against that environment and keeps the result there", async () => {
        const before = (await results("staging")).by["API-001"].ranAt;
        const run = await call("POST", `/api/projects/${projectId}/schedules/${scheduleId}/run`);
        expect(run.status, run.text).toBe(202);
        expect(run.body.job).toMatchObject({ mode: "environment", trigger: "schedule" });
        await idle();
        expect((await results("staging")).by["API-001"].ranAt > before).toBe(true);
        // A run against an environment is not the project's main run: it does not enter trends.
        const runs = (await call("GET", `/api/projects/${projectId}/trends`)).body.runs as Array<{ mode: string }>;
        expect(runs.length).toBeGreaterThan(0); // the main runs are there...
        expect(runs.some((x) => x.mode === "environment")).toBe(false); // ...the environment runs are not
    }, 240_000);

    it("will not delete an environment a schedule still uses, and removes an environment's results with it", async () => {
        const blocked = await call("DELETE", `/api/projects/${projectId}/environments/staging`);
        expect(blocked.status).toBe(409);
        expect(blocked.body.error).toMatch(/schedule/);
        await call("DELETE", `/api/projects/${projectId}/schedules/${scheduleId}`);
        const id = await idOf("WEB-001");
        expect((await call("DELETE", `/api/projects/${projectId}/environments/staging`)).status).toBe(200);
        const detail = (await call("GET", `/api/tests/${id}`)).body;
        expect(Object.keys(detail.environmentResults)).toEqual(["production"]);
        expect(detail.executions).toHaveLength(1);
        expect(detail.validationStatus).toBe("VALIDATED");
        expect(platform.db.all("SELECT 1 FROM test_executions WHERE environment = 'staging'")).toHaveLength(0);
    });
});

/** Run `ai-test` as a pipeline would: a separate process, arguments, environment, exit code. */
function ai(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin/ai-test.mjs"), ...args], { cwd: REPO_ROOT, env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...env } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`ai-test timed out\n${stdout}\n${stderr}`));
        }, 240_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

describe("ai-test run --env", () => {
    let out: string;
    beforeAll(async () => {
        out = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-env-cli-"));
        // staging was deleted above: add it back, with its own variables and token.
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: STAGING, variables: { GREETING_NAME: "Ada" } })).status).toBe(201);
        await call("PUT", `/api/projects/${projectId}/environments/staging/secrets`, { apiToken: STAGING_TOKEN });
    });
    afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

    const project = () => "Environments";

    it("explains bad flags before doing anything", async () => {
        const noServer = await ai(["run", "--specs", "x.json", "--url", STAGING, "--env", "staging"]);
        expect(noServer.code).toBe(2);
        expect(noServer.stderr + noServer.stdout).toMatch(/--env needs --server/);
        const confirm = await ai(["run", "--server", BASE, "--project", project(), "--confirm-production"]);
        expect(confirm.code).toBe(2);
        expect(confirm.stderr + confirm.stdout).toMatch(/--confirm-production only applies together with --env/);
    });

    it("runs a project's tests against a named environment and reports that environment's results", async () => {
        const json = path.join(out, "staging.json");
        const junit = path.join(out, "staging.xml");
        const r = await ai(["run", "--server", BASE, "--project", project(), "--env", "staging", "--json", json, "--junit", junit]);
        // The staging bug is a failing test, so the gate fails (exit 1) exactly as it would for any failing run.
        expect(r.code, r.stdout + r.stderr).toBe(1);
        const report = JSON.parse(fs.readFileSync(json, "utf8"));
        expect(report).toMatchObject({ environment: "staging", target: expect.stringContaining("staging"), summary: { total: 5, passed: 4, failedValidation: 1, notRun: 0 } });
        expect(report.tests.find((t: any) => t.testId === "WEB-001")).toMatchObject({ outcome: "failed" });
        expect(fs.readFileSync(junit, "utf8")).toContain("WEB-001");
        // No secret of the environment in anything the command printed or wrote.
        expect(r.stdout + r.stderr + fs.readFileSync(json, "utf8")).not.toContain(STAGING_TOKEN);
    }, 300_000);

    it("needs --confirm-production for production, then skips data-changing tests as 'not run'", async () => {
        const refused = await ai(["run", "--server", BASE, "--project", project(), "--env", "production"]);
        expect(refused.code).toBe(2);
        expect(refused.stderr + refused.stdout).toMatch(/production environment/);
        const json = path.join(out, "production.json");
        prod.reset();
        const r = await ai(["run", "--server", BASE, "--project", project(), "--env", "production", "--confirm-production", "--json", json]);
        expect(r.code, r.stdout + r.stderr).toBe(0);
        const report = JSON.parse(fs.readFileSync(json, "utf8"));
        expect(report).toMatchObject({ environment: "production", summary: { total: 5, passed: 4, notRun: 1, failedValidation: 0 } });
        const skipped = report.tests.find((t: any) => t.testId === "API-002");
        expect(skipped.outcome).toBe("not_run");
        expect(skipped.reason).toMatch(/production is read-only/);
        expect(prod.mutations).toBe(0);
        // The project's own results (what the platform shows for the test) are still the main run's.
        expect((await tests()).every((t) => t.validationStatus === "VALIDATED")).toBe(true);
    }, 300_000);
});
