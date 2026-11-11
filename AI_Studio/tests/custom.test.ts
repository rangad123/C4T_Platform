/**
 * Hand-written (custom) tests end to end, with real work: the real API, the real worker, real Chromium under Playwright against a
 * fixture shop, and the real backup. No model is configured (and none is used).
 *
 * Part 1 (the run policy ON): take over a generated test and edit it, bad edits refused with nothing saved, versions, restoring the
 *   generated version, writing from scratch, helpers and their change propagation, the re-render paths that must skip custom tests, the
 *   download, backup and restore, secrets and isolation between projects.
 * Part 2 (the run policy OFF, API key required): the policy as the security boundary. A script that WOULD write to the fixture (and one
 *   that would write a file) does not run when running custom scripts is not allowed; a runner agent without the flag is never offered one.
 *
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/custom.test.ts
 * Ports: fixture application 6070.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../src/config.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { defaultCaps, FakeAgent, passedRun, viaInject } from "./fixtures/fake-agent.js";

const APP_PORT = 6070;
const APP = `http://127.0.0.1:${APP_PORT}`;
const PASSWORD = "CUS-Password-5e21b07c";
const KEY = "custom-test-key-123";

// ── the fixture shop: a page, an API, and a log of every "hit" a hand-written script made on purpose ──
let appServer: http.Server;
const hits: string[] = [];
const hitsOf = (name: string) => hits.filter((h) => h === name).length;

const startApp = () =>
    new Promise<void>((resolve) => {
        appServer = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", APP);
            if (url.pathname === "/__hit") {
                hits.push(url.searchParams.get("name") ?? "");
                res.writeHead(200, { "content-type": "application/json" });
                return void res.end("{}");
            }
            if (url.pathname === "/api/health") {
                res.writeHead(200, { "content-type": "application/json" });
                return void res.end(JSON.stringify({ status: "ok" }));
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!doctype html><html lang="en"><head><title>Fixture shop</title></head><body><main><h1>Hello shop</h1><button id="b" onclick="document.getElementById('s').textContent='Done'">Add</button><p id="s" role="status">Idle</p></main></body></html>`);
        });
        appServer.listen(APP_PORT, "127.0.0.1", () => resolve());
    });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

interface Env {
    platform: Platform;
    server: Awaited<ReturnType<typeof buildServer>>;
    worker: Worker;
    dataDir: string;
    headers: Record<string, string>;
    call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; raw: any }>;
    waitJob(jobId: string): Promise<any>;
}

async function makeEnv(label: string, over: Record<string, string>, withWorker = true): Promise<Env> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aitp-custom-${label}-`));
    const platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", ...over }));
    const server = await buildServer(platform);
    const worker = new Worker({ ...platform }, 100);
    if (withWorker) worker.start();
    const headers: Record<string, string> = over.API_KEY ? { "x-api-key": over.API_KEY } : {};
    const call: Env["call"] = async (method, url, payload, hdr) => {
        const res = await server.inject({ method, url, payload: payload as never, headers: { ...(hdr ?? headers), ...(payload !== undefined && typeof payload !== "string" ? { "content-type": "application/json" } : {}) } });
        const text = res.body;
        return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, raw: res };
    };
    const waitJob: Env["waitJob"] = async (jobId) => {
        for (let i = 0; i < 400; i++) {
            const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (DONE.includes(job.status)) return job;
            await sleep(300);
        }
        throw new Error(`job ${jobId} did not finish`);
    };
    return { platform, server, worker, dataDir, headers, call, waitJob };
}
const close = async (e: Env | undefined) => {
    await e?.worker.stop();
    await e?.server.close();
    e?.platform.db.close();
    if (e) fs.rmSync(e.dataDir, { recursive: true, force: true });
};

// ── scripts ──
const HEAD = `import { test, expect } from "@playwright/test";\n`;
const web = (inner: string, title = "by hand") => `${HEAD}test("${title}", async ({ page }) => {\n${inner}\n});\n`;
const GOOD = (name: string) => web(`  await page.goto(process.env.BASE_URL + "/");\n  await page.request.get(process.env.BASE_URL + "/__hit?name=${name}");\n  await expect(page.getByRole("heading", { name: "Hello shop" })).toBeVisible();`);
const WRONG = web(`  await page.goto(process.env.BASE_URL + "/");\n  await expect(page.getByRole("heading", { name: "A heading nobody wrote" })).toBeVisible({ timeout: 1500 });`);
const API = (name: string) => `${HEAD}test("api by hand", async ({ request }) => {\n  const r = await request.get(process.env.API_BASE_URL + "/api/health");\n  expect(r.status()).toBe(200);\n  await request.get(process.env.API_BASE_URL + "/__hit?name=${name}");\n});\n`;
const WITH_HELPER = (helper: string) => `import { test, expect } from "@playwright/test";\nimport { visit } from "./helpers/${helper}";\ntest("uses a helper", async ({ page }) => {\n  await visit(page);\n  await expect(page.getByRole("heading", { name: "Hello shop" })).toBeVisible();\n});\n`;
const HELPER = (name: string) => `import type { Page } from "@playwright/test";\nexport async function visit(page: Page) {\n  await page.goto(process.env.BASE_URL + "/");\n  await page.request.get(process.env.BASE_URL + "/__hit?name=${name}");\n}\n`;

const spec = (title: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({ title, kind: "web", category: "Shop", steps, ...extra });
const goHome = { action: "navigate", url: "/" };
const seesHeading = { action: "assert", check: "visible", locator: { by: "text", value: "Hello shop" } };

// ═════════════════════════════════════════════════════════════════════════════
describe("hand-written tests, with the run policy on", () => {
    let e: Env;
    let pid = "";
    const ids: Record<string, string> = {};
    const original: Record<string, string> = {};
    let controlBefore = "";

    const script = async (key: string) => String((await e.call("GET", `/api/tests/${ids[key]}/script`)).body);
    const detail = async (key: string) => (await e.call("GET", `/api/tests/${ids[key]}`)).body;
    const versions = async (key: string) => (await e.call("GET", `/api/tests/${ids[key]}/script-versions`)).body as Array<{ version: number; kind: string; note: string | null; bytes: number }>;
    const put = (key: string, content: string, note?: string) => e.call("PUT", `/api/tests/${ids[key]}/script`, { content, ...(note ? { note } : {}) });
    const settled = async (key: string) => {
        for (let i = 0; i < 100; i++) {
            const t = await detail(key);
            if (!["PENDING", "VALIDATING"].includes(t.validationStatus)) return t;
            await sleep(300);
        }
        throw new Error(`${key} never settled`);
    };

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
        delete process.env.BLOCK_PRIVATE_TARGETS;
        await startApp();
        e = await makeEnv("on", { ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: KEY });
    }, 60_000);
    afterAll(async () => {
        await close(e);
        await new Promise((r) => appServer?.close(r));
    });

    it("imports generated tests and validates them (the starting point)", async () => {
        pid = (await e.call("POST", "/api/projects", { name: "Hand-written tests" })).body.id;
        const imp = await e.call("POST", `/api/projects/${pid}/specs`, {
            baseUrl: APP,
            credentials: { username: "demo@example.com", password: PASSWORD },
            specs: [
                spec("The shop greets people", [goHome, seesHeading]),
                { title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] },
                spec("The shop still greets people (never taken over)", [goHome, seesHeading]),
            ],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ["web", "api", "control"].forEach((k, i) => (ids[k] = imp.body.tests[i].id));
        expect((await e.waitJob(imp.body.jobId)).status).toBe("COMPLETED");
        for (const k of ["web", "api", "control"]) expect((await detail(k)).validationStatus, k).toBe("VALIDATED");
        for (const k of ["web", "api", "control"]) original[k] = await script(k);
        controlBefore = JSON.stringify(await detail("control"));
    }, 240_000);

    it("tells the interface what is allowed here", async () => {
        const cfg = (await e.call("GET", "/api/config")).body;
        expect(cfg.customScripts).toMatchObject({ platform: true, maxBytes: 200000 });
        expect(cfg.customScripts.guard.length).toBeGreaterThan(4);
        expect(cfg.customScripts.guard.join(" ")).toMatch(/not a security boundary/);
    });

    it("shows what taking a test over gives up, and needs a confirmation", async () => {
        const info = await e.call("GET", `/api/tests/${ids.web}/take-over`);
        expect(info.status).toBe(200);
        expect(info.body.allowed).toBe(true);
        expect(info.body.losses.join(" ")).toMatch(/Repair suggestions stop/);
        expect((await e.call("POST", `/api/tests/${ids.web}/take-over`, {})).status).toBe(400);
        expect((await e.call("POST", `/api/tests/${ids.web}/take-over`, { confirm: false })).status).toBe(400);
        expect((await e.call("POST", `/api/tests/nope/take-over`, { confirm: true })).status).toBe(404);
        expect((await detail("web")).custom).toBeUndefined();
    });

    it("takes a generated test over over HTTP: script kept, spec archived, versions started, nothing else changes", async () => {
        const specBefore = (await detail("web")).spec;
        const res = await e.call("POST", `/api/tests/${ids.web}/take-over`, { confirm: true });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.custom).toMatchObject({ origin: "taken-over", canRestoreGenerated: true });
        expect(typeof res.body.custom.since).toBe("string");
        expect(res.body.spec).toEqual(specBefore);
        expect(await script("web")).toBe(original.web);
        const raw = await e.call("GET", `/api/tests/${ids.web}/script`);
        expect(raw.raw.headers["x-custom-script"]).toBe("true");
        const again = await e.call("POST", `/api/tests/${ids.web}/take-over`, { confirm: true });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/already a code test/);
        expect((await e.call("GET", `/api/tests/${ids.web}/take-over`)).body).toMatchObject({ allowed: false });

        const api = await e.call("POST", `/api/tests/${ids.api}/take-over`, { confirm: true });
        expect(api.status, JSON.stringify(api.body)).toBe(200);

        const list = (await e.call("GET", `/api/projects/${pid}/tests`)).body as any[];
        expect(list.find((t) => t.id === ids.web).custom).toMatchObject({ origin: "taken-over" });
        expect(list.find((t) => t.id === ids.control)).not.toHaveProperty("custom");
        // the generated test is byte-identical to before
        expect(JSON.stringify(await detail("control"))).toBe(controlBefore);
        expect((await e.call("GET", `/api/tests/${ids.control}/script`)).raw.headers["x-custom-script"]).toBeUndefined();
    });

    it("keeps the generated script as version 0 and the taken-over one as version 1", async () => {
        const v = await versions("web");
        expect(v.map((x) => [x.version, x.kind])).toEqual([[1, "taken-over"], [0, "generated"]]);
        expect((await e.call("GET", `/api/tests/${ids.web}/script-versions/0`)).body).toEqual({ version: 0, content: original.web });
        expect((await e.call("GET", `/api/tests/${ids.web}/script-versions/1`)).body.content).toBe(original.web);
        expect((await e.call("GET", `/api/tests/${ids.web}/script-versions/99`)).status).toBe(404);
        expect((await e.call("GET", `/api/tests/${ids.web}/script-versions/abc`)).status).toBe(404);
    });

    it("refuses a bad edit with the reasons, and saves nothing", async () => {
        const before = await versions("web");
        const bad = await put("web", web(`  const fs = require("fs");\n  fs.writeFileSync("x", "y");`));
        expect(bad.status).toBe(422);
        expect(bad.body.error).toMatch(/not saved/);
        expect(bad.body.diagnostics.find((d: any) => d.rule === "require")).toMatchObject({ severity: "error", line: expect.any(Number), column: expect.any(Number) });
        const syntax = await put("web", web(`  const = ;`));
        expect(syntax.status).toBe(422);
        expect(syntax.body.diagnostics[0].rule).toBe("syntax");
        const big = await put("web", `// ${"x".repeat(210_000)}`);
        expect(big.status).toBe(400);
        expect((await e.call("PUT", `/api/tests/${ids.web}/script`, { nope: 1 })).status).toBe(400);
        expect(await versions("web")).toEqual(before);
        expect(await script("web")).toBe(original.web);
        expect((await detail("web")).validationStatus).toBe("VALIDATED"); // untouched: nothing was saved
        // only hand-written tests can be edited as code
        const generated = await put("control", GOOD("nope"));
        expect(generated.status).toBe(422);
        expect(generated.body.error).toMatch(/Switch the test to code first/);
        expect(await script("control")).toBe(original.control);
        expect((await e.call("PUT", `/api/tests/nope/script`, { content: "x" })).status).toBe(404);
    });

    it("checks code while typing without saving it (and not faster than five a second)", async () => {
        const before = await versions("web");
        const r = await e.call("POST", `/api/tests/${ids.web}/script/check`, { content: web(`  eval("1");`) });
        expect(r.status).toBe(200);
        expect(r.body.diagnostics.map((d: any) => d.rule)).toContain("eval");
        const ok = await e.call("POST", `/api/tests/${ids.web}/script/check`, { content: GOOD("check") });
        expect(ok.body.diagnostics.filter((d: any) => d.severity === "error")).toEqual([]);
        expect(await versions("web")).toEqual(before);
        const burst = await Promise.all(Array.from({ length: 12 }, () => e.call("POST", `/api/tests/${ids.web}/script/check`, { content: GOOD("check") })));
        expect(burst.some((x) => x.status === 429)).toBe(true);
        await sleep(1100);
    });

    it("saves a good edit as a new version, runs exactly that script, and does not touch the spec", async () => {
        const specBefore = (await detail("web")).spec;
        const res = await put("web", GOOD("edited-1"), "Check the heading and say hello");
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.version).toBe(2);
        expect(typeof res.body.jobId).toBe("string");
        expect((await detail("web")).validationStatus).toMatch(/PENDING|VALIDATING/);
        expect((await e.waitJob(res.body.jobId)).status).toBe("COMPLETED");
        const t = await settled("web");
        expect(t.validationStatus).toBe("VALIDATED");
        expect(hitsOf("edited-1")).toBeGreaterThan(0); // the edited script really ran
        expect(await script("web")).toBe(GOOD("edited-1"));
        expect(t.spec).toEqual(specBefore);
        expect((await versions("web"))[0]).toMatchObject({ version: 2, kind: "edited", note: "Check the heading and say hello" });
        // the same code again is not a new version
        const same = await put("web", GOOD("edited-1"));
        expect(same.status).toBe(200);
        expect(same.body).toMatchObject({ version: 2, jobId: null });
        expect(same.body.note).toMatch(/Nothing changed/);
        expect((await versions("web")).length).toBe(3);
    }, 240_000);

    it("runs a hand-written API test too", async () => {
        const res = await e.call("PUT", `/api/tests/${ids.api}/script`, { content: API("api-edit") });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await e.waitJob(res.body.jobId);
        expect((await settled("api")).validationStatus).toBe("VALIDATED");
        expect(hitsOf("api-edit")).toBeGreaterThan(0);
    }, 240_000);

    it("a failing hand-written test fails as it is: no repair, no rewrite, no suggestion", async () => {
        const res = await put("web", WRONG, "Expect something that is not there");
        expect(res.status).toBe(200);
        const job = await e.waitJob(res.body.jobId);
        const t = await settled("web");
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        expect(t.attempts).toBe(1);
        expect(await script("web")).toBe(WRONG);
        const events = (await e.call("GET", `/api/test-generation/${job.jobId}/events`)).body as Array<{ kind: string }>;
        expect(events.some((x) => x.kind === "script_regenerated" || x.kind === "healing_proposed")).toBe(false);
        const heal = await e.call("GET", `/api/tests/${ids.web}/healing`);
        expect(heal.status).toBe(200);
        expect(heal.body.proposals ?? []).toEqual([]);
    }, 240_000);

    it("puts an older version back as a new version", async () => {
        expect((await e.call("POST", `/api/tests/${ids.web}/script-versions/99/restore`)).status).toBe(404);
        const res = await e.call("POST", `/api/tests/${ids.web}/script-versions/2/restore`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.version).toBe(4);
        await e.waitJob(res.body.jobId);
        expect((await settled("web")).validationStatus).toBe("VALIDATED");
        expect(await script("web")).toBe(GOOD("edited-1"));
        const v = await versions("web");
        expect(v[0]).toMatchObject({ version: 4, kind: "restored", note: "Restored version 2" });
        expect(v.map((x) => x.version)).toEqual([4, 3, 2, 1, 0]);
    }, 240_000);

    it("goes back to the generated version: the archived spec is rendered again, history stays", async () => {
        const specBefore = (await detail("web")).spec;
        expect((await e.call("POST", `/api/tests/${ids.web}/restore-generated`, {})).status).toBe(400);
        const res = await e.call("POST", `/api/tests/${ids.web}/restore-generated`, { confirm: true });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.custom).toBeUndefined();
        expect(res.body.spec).toEqual(specBefore);
        expect(await script("web")).toBe(original.web);
        expect((await e.call("GET", `/api/tests/${ids.web}/script`)).raw.headers["x-custom-script"]).toBeUndefined();
        if (res.body.jobId) await e.waitJob(res.body.jobId);
        expect((await settled("web")).validationStatus).toBe("VALIDATED");
        // the history is kept, and the script can be edited by hand again only after taking it over again
        expect((await versions("web")).length).toBeGreaterThanOrEqual(5);
        expect((await e.call("POST", `/api/tests/${ids.web}/restore-generated`, { confirm: true })).status).toBe(409);
        expect((await put("web", GOOD("again"))).status).toBe(422);
        // and it can be taken over once more
        expect((await e.call("POST", `/api/tests/${ids.web}/take-over`, { confirm: true })).status).toBe(200);
        expect((await versions("web"))[0].kind).toBe("taken-over");
    }, 240_000);

    it("writes a test from scratch (web and API), with its own checks", async () => {
        const made = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "Written in the editor", kind: "web", content: GOOD("scratch-web"), category: "Hand-written" });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.scratch = made.body.testId;
        expect(made.body.version).toBe(1);
        await e.waitJob(made.body.jobId);
        const t = await settled("scratch");
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t).toMatchObject({ title: "Written in the editor", kind: "web", suite: "Hand-written" });
        expect(t.custom).toMatchObject({ origin: "written", canRestoreGenerated: false });
        expect(hitsOf("scratch-web")).toBeGreaterThan(0);
        expect((await e.call("POST", `/api/tests/${ids.scratch}/restore-generated`, { confirm: true })).body.error).toMatch(/written by hand/);
        expect((await versions("scratch")).map((v) => v.kind)).toEqual(["edited"]);

        const api = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "An API check by hand", kind: "api", content: API("scratch-api") });
        expect(api.status, JSON.stringify(api.body)).toBe(201);
        ids.scratchApi = api.body.testId;
        await e.waitJob(api.body.jobId);
        expect((await settled("scratchApi")).validationStatus).toBe("VALIDATED");

        const count = ((await e.call("GET", `/api/projects/${pid}/tests`)).body as any[]).length;
        const refused = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "Dangerous one", kind: "web", content: web(`  process.exit(1);`) });
        expect(refused.status).toBe(422);
        expect(refused.body.diagnostics.map((d: any) => d.rule)).toContain("process");
        expect(((await e.call("GET", `/api/projects/${pid}/tests`)).body as any[]).length).toBe(count);
        expect((await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "ab", kind: "web", content: GOOD("x") })).status).toBe(400);
        expect((await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "A desktop one", kind: "desktop", content: GOOD("x") })).status).toBe(400);
        const empty = (await e.call("POST", "/api/projects", { name: "No application yet" })).body.id;
        const noApp = await e.call("POST", `/api/projects/${empty}/custom-tests`, { title: "Needs an address", kind: "web", content: GOOD("x") });
        expect(noApp.status).toBe(400);
        expect(noApp.body.error).toMatch(/no application/);
        expect((await e.call("POST", `/api/projects/nope/custom-tests`, { title: "Nobody home", kind: "web", content: GOOD("x") })).status).toBe(404);
    }, 300_000);

    it("shares helpers: guarded, named safely, limited, and used by tests", async () => {
        const base = `/api/projects/${pid}/helpers`;
        expect((await e.call("GET", base)).body).toEqual([]);
        const bad = await e.call("PUT", `${base}/sneaky`, { content: `import fs from "fs";\nexport const x = fs;\n` });
        expect(bad.status).toBe(422);
        expect(bad.body.diagnostics.map((d: any) => d.rule)).toContain("import");
        expect((await e.call("GET", base)).body).toEqual([]);
        for (const name of ["Bad_Name", "con", "a.b", "1abc"]) expect((await e.call("PUT", `${base}/${encodeURIComponent(name)}`, { content: "export {};" })).status, name).toBe(400);
        expect((await e.call("PUT", `${base}/big`, { content: `// ${"x".repeat(100_100)}` })).status).toBe(400);

        const ok = await e.call("PUT", `${base}/open-shop`, { content: HELPER("helper-v1") });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.diagnostics.filter((d: any) => d.severity === "error")).toEqual([]);
        expect((await e.call("GET", base)).body).toMatchObject([{ name: "open-shop", usedBy: 0 }]);
        expect((await e.call("GET", `${base}/open-shop`)).body).toMatchObject({ name: "open-shop", content: HELPER("helper-v1") });
        expect((await e.call("GET", `${base}/nothing-here`)).status).toBe(404);

        const made = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "Uses a shared helper", kind: "web", content: WITH_HELPER("open-shop") });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        ids.helped = made.body.testId;
        expect(made.body.diagnostics.filter((d: any) => d.rule === "helper-missing")).toEqual([]);
        await e.waitJob(made.body.jobId);
        expect((await settled("helped")).validationStatus).toBe("VALIDATED");
        expect(hitsOf("helper-v1")).toBeGreaterThan(0);
        expect((await e.call("GET", base)).body[0]).toMatchObject({ name: "open-shop", usedBy: 1 });

        // a change re-validates the tests that import it
        const before = hitsOf("helper-v2");
        const changed = await e.call("PUT", `${base}/open-shop`, { content: HELPER("helper-v2") });
        expect(changed.status).toBe(200);
        expect(changed.body.revalidating).toMatchObject({ tests: 1 });
        expect(typeof changed.body.revalidating.jobId).toBe("string");
        await e.waitJob(changed.body.revalidating.jobId);
        expect((await settled("helped")).validationStatus).toBe("VALIDATED");
        expect(hitsOf("helper-v2")).toBeGreaterThan(before);

        // it cannot be deleted while a test imports it
        const refused = await e.call("DELETE", `${base}/open-shop`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/used by/);
        expect(refused.body.details.tests.map((t: any) => t.id)).toEqual([ids.helped]);

        // a missing helper is a warning when saving, and a plain failure when running
        const missing = await e.call("POST", `/api/tests/${ids.helped}/script/check`, { content: WITH_HELPER("not-there") });
        expect(missing.body.diagnostics.find((d: any) => d.rule === "helper-missing")).toMatchObject({ severity: "warning" });
        expect(missing.body.diagnostics.filter((d: any) => d.severity === "error")).toEqual([]);

        // a download carries the helper next to the script
        const zip = unzipSync(new Uint8Array(Buffer.from((await e.server.inject({ method: "GET", url: `/api/projects/${pid}/download?includeUnvalidated=true`, headers: e.headers })).rawPayload)));
        const names = Object.keys(zip);
        expect(names.find((n) => /^tests\/[^/]+\/helpers\/open-shop\.ts$/.test(n))).toBeTruthy();
        expect(strFromU8(zip[names.find((n) => n.endsWith("helpers/open-shop.ts"))!]!)).toBe(HELPER("helper-v2"));

        // at most 20
        const limit = (await e.call("GET", base)).body.length;
        for (let i = limit; i < 20; i++) expect((await e.call("PUT", `${base}/filler-${i}`, { content: "export {};\n" })).status).toBe(200);
        const over = await e.call("PUT", `${base}/one-too-many`, { content: "export {};\n" });
        expect(over.status).toBe(422);
        expect(over.body.error).toMatch(/at most 20/);
        // unused ones can go
        expect((await e.call("DELETE", `${base}/filler-1`)).status).toBe(204);
        expect((await e.call("DELETE", `${base}/filler-1`)).status).toBe(404);
        for (let i = 2; i < 20; i++) await e.call("DELETE", `${base}/filler-${i}`);
    }, 300_000);

    it("skips hand-written tests wherever a script would be made again from steps", async () => {
        const NAME = "Shop / Heading";
        const el = await e.call("POST", `/api/projects/${pid}/objects`, { name: NAME, kind: "web", locator: { by: "text", value: "Hello shop" } });
        expect(el.status, JSON.stringify(el.body)).toBe(201);
        const imp = await e.call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, specs: [spec("Uses a shared element", [goHome, { action: "assert", check: "visible", locator: { ref: NAME } }])] });
        ids.shared = imp.body.tests[0].id;
        await e.waitJob(imp.body.jobId);
        expect((await settled("shared")).validationStatus).toBe("VALIDATED");
        expect((await e.call("GET", `/api/projects/${pid}/objects/${el.body.id}`)).body.usedBy.count).toBe(1);
        const generatedScript = await script("shared");
        expect((await e.call("POST", `/api/tests/${ids.shared}/take-over`, { confirm: true })).status).toBe(200);
        // the element no longer lists the test, and changing it leaves the script and the status alone
        expect((await e.call("GET", `/api/projects/${pid}/objects/${el.body.id}`)).body.usedBy.count).toBe(0);
        const change = await e.call("PUT", `/api/projects/${pid}/objects/${el.body.id}`, { locator: { by: "text", value: "Something else entirely" } });
        expect(change.status, JSON.stringify(change.body)).toBe(200);
        expect(change.body.appliesTo).toBe(0);
        expect(await script("shared")).toBe(generatedScript);
        expect((await detail("shared")).validationStatus).toBe("VALIDATED");
        // no rewrite from a description, no script for another framework, no spec export, no quality score
        expect((await e.call("POST", `/api/tests/${ids.shared}/plain-rewrite`, { description: "Open the shop and look for the heading" })).status).toBe(409);
        expect((await e.call("POST", `/api/tests/${ids.shared}/scripts`, { framework: "taqwright" })).status).toBe(409);
        const specs = (await e.call("GET", `/api/projects/${pid}/specs`)).body.specs as Array<{ testId: string }>;
        const keys = new Set(specs.map((s) => s.testId));
        expect(keys.has((await detail("control")).testId)).toBe(true);
        expect(keys.has((await detail("shared")).testId)).toBe(false);
        expect((await detail("shared")).quality).toBeNull();
        // the shared-element suggestions do not offer to share into a hand-written test
        const sug = await e.call("GET", `/api/projects/${pid}/objects/suggestions`);
        expect([200, 404]).toContain(sug.status);
    }, 300_000);

    it("keeps hand-written tests, their history and helpers through a backup and a restore, and checks the code again", async () => {
        const res = await e.server.inject({ method: "GET", url: `/api/projects/${pid}/backup`, headers: e.headers });
        expect(res.statusCode).toBe(200);
        const bytes = new Uint8Array(res.rawPayload);
        const files = unzipSync(bytes);
        expect(Object.keys(files)).toContain("helpers.json");
        const tests = JSON.parse(strFromU8(files["tests.json"]!)) as Array<{ testKey: string; custom?: { origin: string; versions: unknown[] } }>;
        expect(tests.filter((t) => t.custom).length).toBeGreaterThanOrEqual(4);
        expect(tests.find((t) => !t.custom)).toBeTruthy(); // the control test has no custom block
        expect(strFromU8(files["tests.json"]!)).not.toContain(PASSWORD);

        const restored = await e.server.inject({ method: "POST", url: "/api/projects/restore", headers: { ...e.headers, "content-type": "application/zip" }, payload: Buffer.from(bytes) });
        expect(restored.statusCode, restored.body).toBe(201);
        const newPid = JSON.parse(restored.body).project.id as string;
        const oldTests = (await e.call("GET", `/api/projects/${pid}/tests`)).body as any[];
        const newTests = (await e.call("GET", `/api/projects/${newPid}/tests`)).body as any[];
        expect(newTests.length).toBe(oldTests.length);
        for (const t of oldTests) {
            const twin = newTests.find((n) => n.testId === t.testId)!;
            expect(Boolean(twin.custom), t.testId).toBe(Boolean(t.custom));
            if (t.custom) {
                expect(twin.custom.origin).toBe(t.custom.origin);
                expect(twin.custom.canRestoreGenerated).toBe(t.custom.canRestoreGenerated);
                const a = (await e.call("GET", `/api/tests/${t.id}/script-versions`)).body as any[];
                const b = (await e.call("GET", `/api/tests/${twin.id}/script-versions`)).body as any[];
                expect(b.map((v) => [v.version, v.kind])).toEqual(a.map((v) => [v.version, v.kind]));
                expect(String((await e.call("GET", `/api/tests/${twin.id}/script`)).body)).toBe(String((await e.call("GET", `/api/tests/${t.id}/script`)).body));
            }
        }
        const oldHelpers = (await e.call("GET", `/api/projects/${pid}/helpers`)).body as any[];
        const newHelpers = (await e.call("GET", `/api/projects/${newPid}/helpers`)).body as any[];
        expect(newHelpers.map((h) => h.name)).toEqual(oldHelpers.map((h) => h.name));
        expect((await e.call("GET", `/api/projects/${newPid}/helpers/open-shop`)).body.content).toBe(HELPER("helper-v2"));

        // a backup someone edited by hand to carry dangerous code is not restored
        const evil = { ...files };
        const edited = JSON.parse(strFromU8(files["tests.json"]!)) as Array<{ scripts: Array<{ content: string; executable: boolean }>; custom?: unknown }>;
        const victim = edited.find((t) => t.custom)!;
        victim.scripts[0]!.content = `import fs from "fs";\nfs.writeFileSync("pwned.txt", "x");\n`;
        evil["tests.json"] = strToU8(JSON.stringify(edited));
        const refused = await e.server.inject({ method: "POST", url: "/api/projects/restore", headers: { ...e.headers, "content-type": "application/zip" }, payload: Buffer.from(zipSync(evil)) });
        expect(refused.statusCode).toBe(400);
        expect(refused.body).toMatch(/safety check/);
    }, 120_000);

    it("keeps secrets out of scripts, versions, helpers, answers and backups", async () => {
        const everything: string[] = [];
        for (const t of (await e.call("GET", `/api/projects/${pid}/tests`)).body as any[]) {
            everything.push(JSON.stringify(t), JSON.stringify((await e.call("GET", `/api/tests/${t.id}`)).body), String((await e.call("GET", `/api/tests/${t.id}/script`)).body));
            for (const v of (await e.call("GET", `/api/tests/${t.id}/script-versions`)).body as any[]) everything.push(JSON.stringify((await e.call("GET", `/api/tests/${t.id}/script-versions/${v.version}`)).body));
        }
        for (const h of (await e.call("GET", `/api/projects/${pid}/helpers`)).body as any[]) everything.push(JSON.stringify((await e.call("GET", `/api/projects/${pid}/helpers/${h.name}`)).body));
        everything.push(JSON.stringify((await e.call("GET", "/api/config")).body));
        const zip = unzipSync(new Uint8Array((await e.server.inject({ method: "GET", url: `/api/projects/${pid}/backup`, headers: e.headers })).rawPayload));
        for (const [name, bytes] of Object.entries(zip)) everything.push(name, strFromU8(bytes));
        const dump = JSON.stringify(e.platform.db.all("SELECT content FROM custom_script_versions UNION ALL SELECT content FROM custom_helpers UNION ALL SELECT spec_json FROM custom_tests"));
        everything.push(dump);
        for (const text of everything) expect(text).not.toContain(PASSWORD);
        expect(everything.length).toBeGreaterThan(20);
    }, 60_000);

    it("keeps projects apart: another project has none of these helpers, and cannot run a script that needs them", async () => {
        const other = (await e.call("POST", "/api/projects", { name: "Somebody else's project" })).body.id;
        const imp = await e.call("POST", `/api/projects/${other}/specs`, { baseUrl: APP, validate: false, specs: [spec("Their own test", [goHome, seesHeading])] });
        expect((await e.call("GET", `/api/projects/${other}/helpers`)).body).toEqual([]);
        expect((await e.call("GET", `/api/projects/${other}/helpers/open-shop`)).status).toBe(404);
        expect((await e.call("DELETE", `/api/projects/${other}/helpers/open-shop`)).status).toBe(404);
        expect(imp.status).toBe(202);
        const made = await e.call("POST", `/api/projects/${other}/custom-tests`, { title: "Wants the other project's helper", kind: "web", content: WITH_HELPER("open-shop") });
        expect(made.status).toBe(201);
        expect(made.body.diagnostics.find((d: any) => d.rule === "helper-missing")).toBeTruthy();
        await e.waitJob(made.body.jobId);
        const t = (await e.call("GET", `/api/tests/${made.body.testId}`)).body;
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        expect(JSON.stringify(t.executions)).toMatch(/Cannot find module|helpers\/open-shop/);
    }, 240_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe("the run policy is the boundary: hand-written tests do not run where they are not allowed", () => {
    let e: Env;
    let pid = "";
    let hand = "";
    let plain = "";
    const marker = path.join(os.tmpdir(), `aitp-custom-marker-${process.pid}.txt`);
    const REFUSAL = /--allow-custom-scripts|code scripts|ALLOW_CUSTOM_SCRIPTS/;

    beforeAll(async () => {
        if (!appServer?.listening) await startApp();
        e = await makeEnv("off", { API_KEY: KEY }, true);
    }, 60_000);
    afterAll(async () => {
        await close(e);
        fs.rmSync(marker, { force: true });
        if (appServer?.listening) await new Promise((r) => appServer.close(r));
    });

    const waitSettled = async (id: string) => {
        for (let i = 0; i < 100; i++) {
            const t = (await e.call("GET", `/api/tests/${id}`)).body;
            if (!["PENDING", "VALIDATING"].includes(t.validationStatus)) return t;
            await sleep(300);
        }
        throw new Error("never settled");
    };

    it("needs the API key like everything else", async () => {
        for (const [m, u, b] of [["GET", "/api/tests/x/take-over"], ["POST", "/api/tests/x/take-over", { confirm: true }], ["PUT", "/api/tests/x/script", { content: "x" }], ["POST", "/api/tests/x/script/check", { content: "x" }], ["GET", "/api/tests/x/script-versions"], ["GET", "/api/projects/x/helpers"], ["PUT", "/api/projects/x/helpers/abc", { content: "x" }], ["POST", "/api/projects/x/custom-tests", {}]] as const) {
            const r = await e.call(m, u, b, {});
            expect(r.status, `${m} ${u}`).toBe(401);
        }
        expect((await e.call("GET", "/api/config")).body.customScripts).toMatchObject({ platform: false });
    });

    it("lets a person write, take over and save while running is off, and says plainly why nothing ran", async () => {
        pid = (await e.call("POST", "/api/projects", { name: "Policy off" })).body.id;
        const imp = await e.call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [spec("Generated and fine", [goHome, seesHeading]), spec("Soon hand-written", [goHome, seesHeading])] });
        expect(imp.status).toBe(202);
        plain = imp.body.tests[0].id;
        hand = imp.body.tests[1].id;
        // a generated test has no script until it was rendered by the import: it has, so it can be taken over
        expect((await e.call("POST", `/api/tests/${hand}/take-over`, { confirm: true })).status).toBe(200);
        const saved = await e.call("PUT", `/api/tests/${hand}/script`, { content: GOOD("must-not-run-1") });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.jobId).toBeNull();
        expect(saved.body.note).toMatch(REFUSAL);
        expect(saved.body.note).toMatch(/ALLOW_CUSTOM_SCRIPTS=true/);
        expect((await e.call("GET", `/api/tests/${hand}`)).body.validationStatus).toBe("PENDING");
        const made = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "Written while off", kind: "web", content: GOOD("must-not-run-2") });
        expect(made.status).toBe(201);
        expect(made.body.jobId).toBeNull();
        expect(made.body.note).toMatch(REFUSAL);
    });

    it("refuses to start a run that includes one, before any job exists, naming what to switch on", async () => {
        const jobsBefore = (await e.call("GET", `/api/projects/${pid}/jobs`)).body.length;
        const r = await e.call("POST", `/api/tests/${hand}/validate`, {});
        expect(r.status).toBe(409);
        expect(r.body.error).toBe("This project has code tests, and this server does not run them. Set ALLOW_CUSTOM_SCRIPTS=true on the server, or run the project on a runner agent started with --allow-custom-scripts.");
        expect((await e.call("GET", `/api/projects/${pid}/jobs`)).body.length).toBe(jobsBefore);
        await expect(e.platform.repo.createJob(pid, e.platform.repo.getLatestApplicationPublic(pid)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [hand] })).rejects.toThrow(/ALLOW_CUSTOM_SCRIPTS=true/);
        await expect(e.platform.repo.createJob(pid, e.platform.repo.getLatestApplicationPublic(pid)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "variants", variants: ["firefox"], testIds: [hand] })).rejects.toThrow(/code tests/);
        await expect(e.platform.repo.createJob(pid, e.platform.repo.getLatestApplicationPublic(pid)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "environment", environment: "staging", testIds: [hand] })).rejects.toThrow(/code tests/);
        // nothing ran
        expect(hitsOf("must-not-run-1") + hitsOf("must-not-run-2")).toBe(0);
    });

    it("a schedule leaves the hand-written tests out and still runs the others", async () => {
        const sched = await e.call("POST", `/api/projects/${pid}/schedules`, { name: "Nightly", kind: "validate", cadence: { type: "daily", time: "03:00" } });
        expect(sched.status, JSON.stringify(sched.body)).toBe(201);
        const run = await e.call("POST", `/api/projects/${pid}/schedules/${sched.body.id}/run`);
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        const job = await e.waitJob(run.body.jobId);
        const stored = e.platform.repo.getJob(job.jobId)!;
        const planned = stored.options.testIds ?? [];
        expect(planned).toContain(plain);
        expect(planned).not.toContain(hand);
        const events = (await e.call("GET", `/api/test-generation/${job.jobId}/events`)).body as Array<{ kind: string; message: string }>;
        expect(events.find((x) => x.kind === "custom_skipped")?.message).toMatch(/code tests? (was|were) not run/);
        expect(hitsOf("must-not-run-1")).toBe(0);
        expect((await e.call("GET", `/api/tests/${hand}`)).body.validationStatus).toBe("PENDING");
    }, 240_000);

    it("a script that would write a file does not run: the job refuses it even if a code path forgot the gate", async () => {
        // A script the guard would never let in is put in the database directly, standing for a bypass of the guard. Only the policy stands in its way.
        const sneaky = `import fs from "node:fs";\nimport { test } from "@playwright/test";\ntest("sneaky", async () => { fs.writeFileSync(${JSON.stringify(marker)}, "it ran"); });\n`;
        const imp = await e.call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [spec("Smuggled in", [goHome, seesHeading])] });
        const id = imp.body.tests[0].id as string;
        const store = new CustomScriptStore(e.platform.db);
        store.mark(id, pid, { origin: "written" });
        e.platform.repo.addScript(id, { framework: "playwright", filename: "SMUGGLED.spec.ts", content: sneaky, hash: "x", storagePath: `${pid}/x/SMUGGLED.spec.ts`, executable: true });
        fs.rmSync(marker, { force: true });

        // 1. the gate refuses the job
        await expect(e.platform.repo.createJob(pid, e.platform.repo.getLatestApplicationPublic(pid)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [id] })).rejects.toThrow(/ALLOW_CUSTOM_SCRIPTS/);

        // 2. the gate is taken away (a code path that forgot it): the executor still does not start the script
        const gate = e.platform.repo.customGate;
        e.platform.repo.customGate = undefined;
        let job;
        try {
            job = await e.platform.repo.createJob(pid, e.platform.repo.getLatestApplicationPublic(pid)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [id] });
        } finally {
            e.platform.repo.customGate = gate;
        }
        await e.waitJob(job.id);
        const t = await waitSettled(id);
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        expect(JSON.stringify(t.executions)).toMatch(/not allowed to run|does not run them/);
        expect(fs.existsSync(marker)).toBe(false);
    }, 240_000);

    it("the runner itself refuses a hand-written script unless told, and checks it again when told", async () => {
        const sneaky = `import fs from "node:fs";\nimport { test } from "@playwright/test";\ntest("sneaky", async () => { fs.writeFileSync(${JSON.stringify(marker)}, "it ran"); });\n`;
        fs.rmSync(marker, { force: true });
        // Inside the repository, where Playwright can be found (like every run folder).
        fs.mkdirSync(loadConfig().scratchDir, { recursive: true });
        const scratch = fs.mkdtempSync(path.join(loadConfig().scratchDir, "custom-run-"));
        const env = { baseUrl: APP, headless: true };
        try {
            const notTold = await runScripts(scratch, [{ testId: "S-1", filename: "S-1.spec.ts", content: sneaky, custom: true }], env, { workers: 1 });
            expect(notTold[0]).toMatchObject({ status: "error" });
            expect(notTold[0]!.error).toMatch(/not allowed to run on this machine/);
            expect(fs.existsSync(marker)).toBe(false);
            const told = await runScripts(scratch, [{ testId: "S-1", filename: "S-1.spec.ts", content: sneaky, custom: true }], env, { workers: 1, allowCustom: true });
            expect(told[0]!.error).toMatch(/did not pass the safety check/);
            expect(fs.existsSync(marker)).toBe(false);
            // a helper that fails the check stops its importers too
            const withHelper = `import { test } from "@playwright/test";\nimport { x } from "./helpers/evil";\ntest("t", async () => { void x; });\n`;
            const helped = await runScripts(scratch, [{ testId: "S-2", filename: "S-2.spec.ts", content: withHelper, custom: true }], env, { workers: 1, allowCustom: true, helpers: [{ name: "evil", content: `import fs from "fs";\nexport const x = fs;\n` }] });
            expect(helped[0]!.error).toMatch(/helper “evil”/);
            // the same runner still runs a script that is not hand-written, exactly as before
            const plainRun = await runScripts(scratch, [{ testId: "P-1", filename: "P-1.spec.ts", content: GOOD("plain-run") }], env, { workers: 1 });
            expect(plainRun[0]!.status).toBe("passed");
            expect(hitsOf("plain-run")).toBeGreaterThan(0);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    }, 120_000);

    it("a person's runner with code scripts switched off is never offered one; with the switch on it is (round 45)", async () => {
        // The run is a person's (runs started with the server's shared key have no owner); their runner takes it.
        const me = testPerson(e.platform);
        const mine = { "x-api-key": me.token };
        const send = viaInject(e.server);
        const runner = personalRunner(e.platform, { ownerId: me.id, label: "mine", codeScripts: false });
        const agent = new FakeAgent(send, runner.secret, { name: "mine", capabilities: defaultCaps({ runnerSwitches: true }) });
        expect((await agent.hello()).status).toBe(200);
        const set = await e.call("PUT", `/api/projects/${pid}/runner`, { runOn: "agent" });
        expect(set.status, JSON.stringify(set.body)).toBe(200);

        // code scripts off on the person's runner: refused before a job exists, with the code that links to Settings
        const refused = await e.call("POST", `/api/tests/${hand}/validate`, {}, mine);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(REFUSAL);
        expect(refused.body.details).toMatchObject({ code: "RUNNER_CANNOT_RUN" });
        // generated tests still go to it
        const fine = await e.call("POST", `/api/tests/${plain}/validate`, {}, mine);
        expect(fine.status, JSON.stringify(fine.body)).toBe(202);
        const offer = await agent.next(15_000);
        expect(offer?.scripts.map((s) => s.custom)).toEqual([undefined]);
        await agent.answer(offer!, { runs: offer!.scripts.map((s) => passedRun(s.testId)) });
        await e.waitJob(fine.body.jobId);

        // the owner switches code scripts on: the hand-written test goes to it
        expect((await e.call("PATCH", "/api/me/runner", { switches: { codeScripts: true } }, mine)).status).toBe(200);
        const started = await e.call("POST", `/api/tests/${hand}/validate`, {}, mine);
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const got = await agent.next(20_000);
        expect(got).toBeTruthy();
        expect(got!.scripts[0]).toMatchObject({ custom: true });
        await agent.answer(got!, { runs: got!.scripts.map((s) => passedRun(s.testId)) });
        await e.waitJob(started.body.jobId);
    }, 120_000);
});
