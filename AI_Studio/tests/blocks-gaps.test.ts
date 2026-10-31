/**
 * Gaps left by the reusable-steps and adapter plug-in rounds, closed and proved with real work: the real API (with an API key), the real
 * worker running specs under Playwright against the fixture Notes app, the real example plug-in (examples/adapter-plugin) running API tests
 * as a Node child process, a local receiver shaped like GitHub's issue API. No model, no external site.
 *
 *  1. blocks travel with exported specs and the project zip, and a spec import checks them like the blocks API does
 *  2. the Objects page counts tests that reach an element through reusable steps
 *  3. (the plug-in label on the test page is in tests/plugin-ui.test.ts)
 *  4. a plug-in test that uses a block is expanded, rendered, run and validated
 *  5. a block edit that breaks the sign-in rule is refused with the affected tests listed (a {{param}} address, a placeholder host)
 *  6. step numbers of a run map to the steps that ran (Sentry lookup, issue text)
 *  7. a project routed to a runner agent says which plug-in framework cannot run there
 *
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/blocks-gaps.test.ts
 * Ports 6310 (Notes app), 6311 (another site, never listened on), 6312 (receiver shaped like GitHub).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { loadConfiguredPlugins, unloadPlugins } from "../src/engine/frameworks/plugin-loader.js";
import { checkBlockInput } from "../src/engine/blocks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { BlockStore } from "../src/platform/block-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { HttpError } from "../src/platform/http-error.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { failedPathsOf, failedRun } from "../src/platform/sentry/related.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startBlocksApp } from "./fixtures/blocks-app.js";

const PORT = 6310;
const APP = `http://127.0.0.1:${PORT}`;
const ELSEWHERE = "http://127.0.0.1:6311";
const GH_PORT = 6312;
const GH = `http://127.0.0.1:${GH_PORT}`;
const GH_TOKEN = "ghp_validTokenForBlocksGaps1234567890";
const KEY = "blocks-gaps-key-3e7a";
const EXAMPLE = path.join(REPO_ROOT, "examples", "adapter-plugin");
const quiet = { warn: () => undefined, log: () => undefined };

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let notes: http.Server;
let github: http.Server;
const ghBodies: Array<{ title: string; body: string }> = [];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-blocks-gaps-"));
    // The plug-in switch only counts together with an API key (see docs/features/adapter-plugins.md).
    const config = loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", API_KEY: KEY, ALLOW_ADAPTER_PLUGINS: "true", ADAPTER_PLUGINS: EXAMPLE });
    platform = bootstrap(config);
    await loadConfiguredPlugins(config, quiet);
    process.env.PUBLIC_URL = "https://platform.example.test";
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    ({ server: notes } = await startBlocksApp(PORT));
    github = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            const send = (code: number, obj: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
            if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
            if (req.method === "GET") return send(200, { full_name: "acme/notes", has_issues: true });
            ghBodies.push(JSON.parse(raw));
            send(201, { number: ghBodies.length, html_url: `https://github.example/acme/notes/issues/${ghBodies.length}` });
        });
    });
    await new Promise<void>((r) => github.listen(GH_PORT, "127.0.0.1", r));
}, 60_000);

afterAll(async () => {
    delete process.env.PUBLIC_URL;
    await worker?.stop();
    unloadPlugins();
    await server?.close();
    notes?.close();
    github?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = async (method: Method, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, raw: res.rawPayload };
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
const detail = async (id: string) => (await call("GET", `/api/tests/${id}`)).body;
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;

// ── what the tests build with ───────────────────────────────────────────────
const nickRef = { ref: "Notes / Nickname field" };
const signInButton = { by: "role", role: "button", value: "Sign in", exact: true };
const status = { by: "role", role: "status" };
const use = (block: string, args?: Record<string, string>) => ({ action: "useBlock", block, ...(args ? { args } : {}) });
const webSpec = (title: string, steps: unknown[]) => ({ title, kind: "web", category: "Notes", steps });
const apiSpec = (title: string, steps: unknown[]) => ({ title, kind: "api", category: "Notes API", steps });
const OPEN = { name: "Open the app", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] };
const SIGN_IN = {
    name: "Sign in",
    kind: "web",
    params: [{ name: "nickname", default: "Ada" }],
    steps: [use("Open the app"), { action: "fill", locator: nickRef, value: "{{nickname}}" }, { action: "click", locator: signInButton }, { action: "assert", check: "text", locator: status, expected: "Signed in as {{nickname}}" }],
};
const NICK_FIELD = { name: "Notes / Nickname field", kind: "web", locator: { by: "label", value: "Nickname" } };

// ═══ 1. blocks in exports ════════════════════════════════════════════════════

describe("1. reusable steps travel with exported specs and the project zip", () => {
    let src: string;
    const ids: Record<string, string> = {};
    let exported: { specs: Array<Record<string, any>>; objects?: Array<{ name: string }>; blocks?: Array<Record<string, any>> };

    it("sets up a project whose tests use reusable steps (one through another set) and a shared element held inside them", async () => {
        src = await newProject("Notes with blocks");
        // The project needs an application: a plain test establishes it.
        const plain = await call("POST", `/api/projects/${src}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("The page is there", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Notes" } }])] });
        expect(plain.status, JSON.stringify(plain.body)).toBe(202);
        expect((await call("POST", `/api/projects/${src}/objects`, NICK_FIELD)).status).toBe(201);
        for (const b of [OPEN, SIGN_IN, { name: "Unused", kind: "web", params: [], steps: [{ action: "wait", ms: 10 }] }]) {
            const r = await call("POST", `/api/projects/${src}/blocks`, b);
            expect(r.status, JSON.stringify(r.body)).toBe(201);
        }
        const imp = await call("POST", `/api/projects/${src}/specs`, { validate: false, specs: [webSpec("Ada signs in", [use("Sign in")]), webSpec("Grace signs in", [use("Sign in", { nickname: "Grace" })])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.ada = imp.body.tests[0].id;
        ids.grace = imp.body.tests[1].id;
    });

    it("exports the blocks the exported tests use, transitively, with the shared elements those blocks refer to", async () => {
        const r = await call("GET", `/api/projects/${src}/specs`);
        expect(r.status).toBe(200);
        exported = r.body;
        expect(Object.keys(exported)).toEqual(["specs", "objects", "blocks"]);
        // “Open the app” is only used by “Sign in”; “Unused” is used by nobody and stays home.
        expect(exported.blocks!.map((b) => b.name)).toEqual(["Open the app", "Sign in"]);
        expect(exported.blocks![1]).toMatchObject({ kind: "web", params: [{ name: "nickname", default: "Ada" }] });
        expect(exported.blocks![1]!.steps).toHaveLength(4);
        expect(exported.blocks![0]).not.toHaveProperty("id");
        // no test spells the element out; only a block does, and it still comes along
        expect(exported.objects!.map((o) => o.name)).toEqual(["Notes / Nickname field"]);
        expect(exported.specs.map((s) => s.steps[0]?.action)).toContain("useBlock");
    });

    it("round trip: the export imported into a fresh project brings the blocks and the elements, and the tests really validate", async () => {
        const dst = await newProject("Notes imported elsewhere");
        const imp = await call("POST", `/api/projects/${dst}/specs`, { ...exported, baseUrl: APP });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const job = await waitJob(imp.body.jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        const blocks = (await call("GET", `/api/projects/${dst}/blocks`)).body;
        expect(blocks.blocks.map((b: { name: string }) => b.name)).toEqual(["Open the app", "Sign in"]);
        expect(blocks.blocks[1].usedBy.count).toBe(2);
        expect((await call("GET", `/api/projects/${dst}/objects`)).body.elements.map((e: { name: string }) => e.name)).toEqual(["Notes / Nickname field"]);
        const tests = (await call("GET", `/api/projects/${dst}/tests`)).body as Array<{ id: string; title: string }>;
        expect(tests).toHaveLength(exported.specs.length);
        for (const t of tests) {
            const d = await detail(t.id);
            expect(d.validationStatus, `${t.title}: ${d.validationReason}`).toBe("VALIDATED");
        }
        const grace = await detail(tests.find((t) => t.title === "Grace signs in")!.id);
        expect(grace.spec.steps[0]).toMatchObject({ action: "useBlock", block: "Sign in", args: { nickname: "Grace" } });
        expect(grace.scripts[0].content).toContain("Grace");
        expect(grace.scripts[0].content).not.toMatch(/useBlock/);
    }, 240_000);

    it("reuses identical blocks, refuses a different one with the same name in plain words, and stores nothing when it refuses", async () => {
        const dst = await newProject("Notes imported twice");
        const body = { baseUrl: APP, validate: false, blocks: exported.blocks, objects: exported.objects, specs: exported.specs.map(({ testId: _drop, ...rest }) => rest) };
        const first = await call("POST", `/api/projects/${dst}/specs`, body);
        expect(first.status, JSON.stringify(first.body)).toBe(202);
        const again = await call("POST", `/api/projects/${dst}/specs`, body);
        expect(again.status, JSON.stringify(again.body)).toBe(202);
        expect((await call("GET", `/api/projects/${dst}/blocks`)).body.total).toBe(2);
        const testsBefore = (await call("GET", `/api/projects/${dst}/tests`)).body.length as number;
        const changed = exported.blocks!.map((b) => (b.name === "Sign in" ? { ...b, steps: b.steps.map((s: any) => (s.action === "click" ? { ...s, locator: { ...s.locator, value: "Log in" } } : s)) } : b));
        const clash = await call("POST", `/api/projects/${dst}/specs`, { ...body, blocks: changed });
        expect(clash.status).toBe(409);
        expect(clash.body.error).toMatch(/already has reusable steps called “Sign in” that are different from the ones in this import/);
        expect((await call("GET", `/api/projects/${dst}/tests`)).body).toHaveLength(testsBefore);
        // the same name in another case is a different block too
        const lower = await call("POST", `/api/projects/${dst}/specs`, { ...body, blocks: exported.blocks!.map((b) => ({ ...b, name: b.name.toLowerCase() })) });
        expect(lower.status).toBe(409);
        expect((await call("GET", `/api/projects/${dst}/blocks`)).body.total).toBe(2);
    });

    it("checks imported blocks like the blocks API: typed secrets, circles, depth, size, duplicates, missing elements, sign-in details sent elsewhere", async () => {
        const dst = await newProject("Hostile imports");
        // an application first, so addresses can be judged
        expect((await call("POST", `/api/projects/${dst}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("The page is there", [{ action: "navigate", url: "/" }])] })).status).toBe(202);
        const imp = (blocks: unknown[], specs: unknown[] = [webSpec("Uses one", [use("X")])]) => call("POST", `/api/projects/${dst}/specs`, { validate: false, blocks, specs });
        const web = (name: string, steps: unknown[], params: unknown[] = []) => ({ name, kind: "web", params, steps });
        const wait = [{ action: "wait", ms: 10 }];

        const secret = await imp([web("X", [{ action: "fill", locator: { by: "label", value: "Password" }, value: "hunter2-for-real" }])]);
        expect(secret.status).toBe(400);
        expect(JSON.stringify(secret.body.details)).toMatch(/real secret/);
        const circle = await imp([web("X", [use("Y")]), web("Y", [use("X")])]);
        expect(circle.status).toBe(400);
        expect(circle.body.error).toMatch(/in a circle/);
        const deep = await imp([web("X", [use("D2")]), web("D2", [use("D3")]), web("D3", [use("D4")]), web("D4", [use("D5")]), web("D5", wait)]);
        expect(deep.status).toBe(400);
        expect(deep.body.error).toMatch(/levels/);
        const huge = await imp([web("X", Array.from({ length: 41 }, () => wait[0]))]);
        expect(huge.status).toBe(400);
        expect(JSON.stringify(huge.body.details)).toMatch(/at most 40 steps/);
        const twice = await imp([web("X", wait), web("x", wait)]);
        expect(twice.status).toBe(400);
        expect(JSON.stringify(twice.body.details)).toMatch(/appear twice/);
        const unknownElement = await imp([web("X", [{ action: "click", locator: { ref: "Nowhere / Button" } }])]);
        expect(unknownElement.status).toBe(400);
        expect(unknownElement.body.error).toMatch(/not in the object repository/);
        const tooMany = await imp(Array.from({ length: 101 }, (_, i) => web(`B${i}`, wait)));
        expect(tooMany.status).toBe(400);
        const notBlocks = await imp([{ nope: true }]);
        expect(notBlocks.status).toBe(400);
        // a test that uses a set the import does not bring and the project does not have
        const missing = await imp([web("Other", wait)], [webSpec("Uses one", [use("Not there")])]);
        expect(missing.status).toBe(400);
        expect(JSON.stringify(missing.body)).toMatch(/“Not there”, which are not in this project/);
        // stored sign-in details sent to another site, on their own and through a test
        const leak = await imp([{ name: "Leak", kind: "api", params: [], steps: [{ action: "request", method: "GET", path: `${ELSEWHERE}/steal`, auth: "default" }] }], [apiSpec("Calls out", [use("Leak")])]);
        expect(leak.status).toBe(400);
        expect(JSON.stringify(leak.body)).toMatch(/Stored sign-in details can only be used on the application's own site/);
        // nothing from any refused import stayed behind
        expect((await call("GET", `/api/projects/${dst}/blocks`)).body.total).toBe(0);
        expect((await call("GET", `/api/projects/${dst}/tests`)).body).toHaveLength(1);
    });

    it("a project without blocks exports exactly what it always did", async () => {
        const bare = await newProject("No blocks here");
        expect((await call("POST", `/api/projects/${bare}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("Plain", [{ action: "navigate", url: "/" }])] })).status).toBe(202);
        const r = await call("GET", `/api/projects/${bare}/specs`);
        expect(Object.keys(r.body)).toEqual(["specs"]);
        const zip = unzipSync(new Uint8Array((await call("GET", `/api/projects/${bare}/download?includeUnvalidated=true`)).raw));
        expect(Object.keys(zip)).not.toContain("blocks.json");
        expect(Object.keys(zip)).not.toContain("objects.json");
    });

    it("the project zip carries blocks.json and objects.json, and what is in the zip imports into another project", async () => {
        const r = await call("GET", `/api/projects/${src}/download?includeUnvalidated=true`);
        expect(r.status).toBe(200);
        const files = unzipSync(new Uint8Array(r.raw));
        const blocks = JSON.parse(strFromU8(files["blocks.json"]!)) as { version: number; blocks: Array<{ name: string }> };
        expect(blocks.version).toBe(1);
        expect(blocks.blocks.map((b) => b.name)).toEqual(["Open the app", "Sign in"]);
        const objects = JSON.parse(strFromU8(files["objects.json"]!)) as { elements: Array<{ name: string }> };
        expect(objects.elements.map((e) => e.name)).toEqual(["Notes / Nickname field"]);
        const specs = Object.entries(files).filter(([k]) => /^specs\/.+\.json$/.test(k)).map(([, v]) => JSON.parse(strFromU8(v)));
        expect(specs.length).toBeGreaterThanOrEqual(3);
        const dst = await newProject("From the zip");
        const imp = await call("POST", `/api/projects/${dst}/specs`, { baseUrl: APP, validate: false, specs, blocks: blocks.blocks, objects: objects.elements });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        expect((await call("GET", `/api/projects/${dst}/blocks`)).body.total).toBe(2);
        expect((await call("GET", `/api/projects/${dst}/tests`)).body).toHaveLength(specs.length);
        // without the blocks the same specs are refused, in words
        const lost = await call("POST", `/api/projects/${await newProject("Zip without blocks")}/specs`, { baseUrl: APP, validate: false, specs });
        expect(lost.status).toBe(400);
        expect(JSON.stringify(lost.body)).toMatch(/which are not in this project/);
    });

    it("needs the API key like every other route", async () => {
        expect((await call("GET", `/api/projects/${src}/specs`, undefined, {})).status).toBe(401);
        expect((await call("POST", `/api/projects/${src}/specs`, { validate: false, blocks: [], specs: [] }, {})).status).toBe(401);
    });

    // ═══ 2. the Objects page counts use through blocks ═══
    describe("2. the shared-elements list counts tests that reach an element through reusable steps", () => {
        const list = async () => (await call("GET", `/api/projects/${src}/objects`)).body.elements as Array<Record<string, any>>;

        it("counts both tests, names the reusable steps, and says the set holds the element", async () => {
            const el = (await list()).find((e) => e.name === NICK_FIELD.name)!;
            expect(el.usedBy.count).toBe(2);
            expect(el.usedBy.steps).toBe(2);
            expect(el.usedBy.tests.map((t: any) => t.title).sort()).toEqual(["Ada signs in", "Grace signs in"]);
            expect(el.usedBy.tests.every((t: any) => JSON.stringify(t.viaBlocks) === JSON.stringify(["Sign in"]))).toBe(true);
            expect(el.usedBy.blocks).toEqual(["Sign in"]);
            const one = (await call("GET", `/api/projects/${src}/objects/${el.id}`)).body;
            expect(one.usedBy.count).toBe(2);
            expect(one.usedBy.tests[0].viaBlocks).toEqual(["Sign in"]);
        });

        it("counts a test once when it spells the element out and also reaches it through a block", async () => {
            const imp = await call("POST", `/api/projects/${src}/specs`, { validate: false, specs: [webSpec("Types twice", [{ action: "navigate", url: "/" }, { action: "fill", locator: nickRef, value: "x" }, use("Sign in")])] });
            expect(imp.status, JSON.stringify(imp.body)).toBe(202);
            const el = (await list()).find((e) => e.name === NICK_FIELD.name)!;
            expect(el.usedBy.count).toBe(3);
            expect(el.usedBy.steps).toBe(4);
            const twice = el.usedBy.tests.find((t: any) => t.title === "Types twice");
            expect(twice.viaBlocks).toEqual(["Sign in"]);
            // the filter "elements this test uses" follows blocks too
            const only = (await call("GET", `/api/projects/${src}/objects?test=${ids.ada}`)).body.elements;
            expect(only.map((e: any) => e.name)).toEqual([NICK_FIELD.name]);
        });

        it("an element held by reusable steps no test uses yet shows as held, and still cannot be deleted", async () => {
            const made = await call("POST", `/api/projects/${src}/objects`, { name: "Notes / Count", kind: "web", locator: { by: "text", value: "Notes:" } });
            expect(made.status).toBe(201);
            expect((await call("POST", `/api/projects/${src}/blocks`, { name: "Count it", kind: "web", params: [], steps: [{ action: "assert", check: "visible", locator: { ref: "Notes / Count" } }] })).status).toBe(201);
            const el = (await list()).find((e) => e.name === "Notes / Count")!;
            expect(el.usedBy).toMatchObject({ count: 0, tests: [], blocks: ["Count it"] });
            const del = await call("DELETE", `/api/projects/${src}/objects/${el.id}`);
            expect(del.status).toBe(409);
            expect(del.body.error).toMatch(/used by the reusable steps “Count it”/);
        });

        it("a project that uses no reusable steps answers exactly as before (no blocks key)", async () => {
            const other = await newProject("Objects only");
            expect((await call("POST", `/api/projects/${other}/objects`, NICK_FIELD)).status).toBe(201);
            const el = (await call("GET", `/api/projects/${other}/objects`)).body.elements[0];
            expect(el.usedBy).toEqual({ count: 0, steps: 0, tests: [] });
        });
    });
});

// ═══ 4. plug-in test with a block ════════════════════════════════════════════

describe("4. a plug-in framework test that uses a block of API steps", () => {
    let pid: string;
    let testId: string;
    const READ = (expected: string) => ({
        name: "Read the first note",
        kind: "api",
        params: [{ name: "path", default: "/api/notes" }],
        steps: [{ action: "request", method: "GET", path: "{{path}}", auth: "none" }, { action: "assertResponse", check: "status", expected: 200 }, { action: "assertResponse", check: "jsonPath", path: "notes.0.text", expected }],
    });

    it("is expanded before the plug-in renders it, then really run through the plug-in and validated", async () => {
        pid = await newProject("Plug-in with reusable steps");
        expect((await call("GET", "/api/config")).body.adapters.map((a: { id: string }) => a.id)).toContain("node-http-check");
        expect((await call("POST", `/api/projects/${pid}/blocks`, READ("First"))).status).toBe(201);
        const imp = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, framework: "node-http-check", specs: [apiSpec("The first note is readable", [use("Read the first note")])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        testId = imp.body.tests[0].id;
        const job = await waitJob(imp.body.jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        const d = await detail(testId);
        expect(d.framework).toBe("node-http-check");
        expect(d.validationStatus, d.validationReason).toBe("VALIDATED");
        expect(d.spec.steps).toHaveLength(1);
        expect(d.spec.steps[0].action).toBe("useBlock");
        // the stored copy is the small one; the script and the run are the expanded steps
        expect(d.runSteps.map((r: { block?: string; from: number }) => [r.block, r.from])).toEqual([["Read the first note", 0], ["Read the first note", 0], ["Read the first note", 0]]);
        expect(d.scripts[0].filename).toMatch(/\.node-http-check\.mjs$/);
        expect(d.scripts[0].content).toContain("/api/notes");
        expect(d.scripts[0].content).not.toMatch(/useBlock/);
        expect(d.executions[0].status).toBe("passed");
        expect(d.executions[0].steps).toHaveLength(3);
    }, 120_000);

    it("a change to the block reaches the plug-in test: it is rendered again, run again and fails with the plug-in's own reason", async () => {
        const wrong = await call("PUT", `/api/projects/${pid}/blocks/${encodeURIComponent("Read the first note")}`, READ("Second"));
        expect(wrong.status, JSON.stringify(wrong.body)).toBe(200);
        expect(wrong.body.appliesTo).toBe(1);
        expect(wrong.body.revalidation.status).toBe("started");
        await waitJob(wrong.body.revalidation.jobId);
        const failed = await detail(testId);
        expect(failed.validationStatus).toBe("FAILED_VALIDATION");
        expect(failed.validationReason).toContain("Expected notes.0.text to be Second but got First");
        expect(failed.scripts[0].content).toContain("Second");
        const fixed = await call("PUT", `/api/projects/${pid}/blocks/${encodeURIComponent("Read the first note")}`, READ("First"));
        await waitJob(fixed.body.revalidation.jobId);
        expect((await detail(testId)).validationStatus).toBe("VALIDATED");
    }, 180_000);

    it("is still refused in words on a runner agent, naming the plug-in framework and saying plug-ins run on the platform computer only", async () => {
        const svc = getAgentServices(platform);
        svc.store.setRunner(pid, { runOn: "agent", agentId: null });
        try {
            const app = platform.repo.getLatestApplicationPublic(pid)!;
            const attempt = () => platform.repo.createJob(pid, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] } as never);
            await expect(attempt()).rejects.toThrow(HttpError);
            await expect(attempt()).rejects.toThrow(/plug-in framework "Node HTTP check \(example plug-in\)" \(node-http-check\), which runs on the platform computer only: runner agents do not have plug-ins/);
            await expect(attempt()).rejects.toThrow(/This project runs its tests on a runner agent\. Run the project on the platform computer, or move these tests to another project\./);
            // and the same sentence reaches the person who presses Run again
            const run = await call("POST", `/api/tests/${testId}/validate`, {});
            expect(run.status).toBe(409);
            expect(run.body.error).toMatch(/runs on the platform computer only/);
        } finally {
            svc.store.setRunner(pid, { runOn: "platform", agentId: null });
        }
    });
});

// ═══ 5. block edits that break the sign-in rule ══════════════════════════════

describe("5. a block change that would send stored sign-in details elsewhere is refused with the tests listed", () => {
    let pid: string;
    const FETCH = (auth: "none" | "default") => ({ name: "Fetch from", kind: "api", params: [{ name: "host", default: APP }], steps: [{ action: "request", method: "GET", path: "{{host}}/api/notes", auth }] });

    it("through a {{param}} address: a test gives another site as the value, the change to auth default is refused, nothing is saved", async () => {
        pid = await newProject("Sign-in rule");
        expect((await call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [apiSpec("Plain", [{ action: "request", method: "GET", path: "/api/notes", auth: "none" }])] })).status).toBe(202);
        expect((await call("POST", `/api/projects/${pid}/blocks`, FETCH("none"))).status).toBe(201);
        // both of these import cleanly while the steps send no stored details
        const imp = await call("POST", `/api/projects/${pid}/specs`, {
            validate: false,
            specs: [apiSpec("Reads the other site", [use("Fetch from", { host: ELSEWHERE })]), apiSpec("Reads a site named by the environment", [use("Fetch from", { host: "{{env.TARGET}}" })]), apiSpec("Reads the application", [use("Fetch from")])],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const risky = await call("PUT", `/api/projects/${pid}/blocks/${encodeURIComponent("Fetch from")}`, FETCH("default"));
        expect(risky.status, JSON.stringify(risky.body)).toBe(409);
        expect(risky.body.error).toMatch(/would break 2 tests/);
        expect(risky.body.error).toContain("Reads the other site");
        expect(risky.body.error).toContain("Reads a site named by the environment");
        expect(risky.body.error).not.toContain("Reads the application");
        expect(risky.body.error).toMatch(/Stored sign-in details can only be used on the application's own site/);
        expect(risky.body.error).toMatch(/Nothing was saved/);
        expect(risky.body.details.tests.map((t: any) => t.title).sort()).toEqual(["Reads a site named by the environment", "Reads the other site"]);
        const messages = risky.body.details.tests.map((t: any) => t.problem).join(" | ");
        expect(messages).toMatch(/must not start with a \{\{placeholder\}\}/);
        expect(messages).toMatch(new RegExp(`this step is on ${ELSEWHERE.replace(/[.]/g, "\\.")}`));
        const still = (await call("GET", `/api/projects/${pid}/blocks/${encodeURIComponent("Fetch from")}`)).body;
        expect(still.version).toBe(1);
        expect(still.steps[0].auth).toBe("none");
        expect(JSON.stringify(still.usedBy)).toContain("Reads the other site");
    });

    it("the same use is refused when the TEST is saved, and a change that keeps the rule still goes through", async () => {
        const direct = await call("POST", `/api/projects/${pid}/blocks`, { ...FETCH("default"), name: "Fetch with sign-in" });
        expect(direct.status, JSON.stringify(direct.body)).toBe(201);
        const away = await call("POST", `/api/projects/${pid}/specs`, { validate: false, specs: [apiSpec("Sends it away", [use("Fetch with sign-in", { host: ELSEWHERE })])] });
        expect(away.status).toBe(400);
        expect(JSON.stringify(away.body)).toMatch(/Stored sign-in details can only be used on the application's own site/);
        const ok = await call("PUT", `/api/projects/${pid}/blocks/${encodeURIComponent("Fetch from")}`, { description: "Reads a page" });
        expect(ok.status).toBe(200);
    });

    it("a test written straight into the database (past the import checks) is judged the same way when its block changes", async () => {
        const fresh = await call("POST", `/api/projects/${pid}/blocks`, { name: "Read page", kind: "api", params: [{ name: "host", default: APP }], steps: [{ action: "request", method: "GET", path: "{{host}}/api/notes", auth: "none" }] });
        expect(fresh.status).toBe(201);
        const spec = { testId: "API-900", title: "Written through the store", kind: "api", category: "Notes API", priority: "medium", type: "functional", steps: [use("Read page", { host: ELSEWHERE })], source: { origin: "manual" } };
        const parsed = TestSpecSchema.parse(spec);
        platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "Notes API", "notes-api"), jobId: null, spec: parsed, framework: "playwright-api", validationStatus: "PENDING" });
        const risky = await call("PUT", `/api/projects/${pid}/blocks/${encodeURIComponent("Read page")}`, { steps: [{ action: "request", method: "GET", path: "{{host}}/api/notes", auth: "default" }] });
        expect(risky.status, JSON.stringify(risky.body)).toBe(409);
        expect(risky.body.details.tests.map((t: any) => t.title)).toEqual(["Written through the store"]);
        expect((await call("GET", `/api/projects/${pid}/blocks/${encodeURIComponent("Read page")}`)).body.steps[0].auth).toBe("none");
    });
});

// ═══ 6. step numbers follow the steps that ran ═══════════════════════════════

describe("6. a failed run's step numbers map to the steps that ran when a test uses reusable steps", () => {
    let pid: string;
    let testId: string;

    it("the paths Sentry is asked about come from the step that failed, not from the same number in the small stored list", async () => {
        pid = await newProject("Numbers that match");
        expect((await call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [apiSpec("Plain", [{ action: "request", method: "GET", path: "/api/notes", auth: "none" }])] })).status).toBe(202);
        const block = checkBlockInput({ name: "Call cart", kind: "api", params: [], steps: [{ action: "request", method: "GET", path: "/api/cart", auth: "none" }, { action: "assertResponse", check: "status", expected: 200 }] });
        if (!block.ok) throw new Error(block.error);
        new BlockStore(platform.db).create(pid, block.block);
        // stored: 3 steps. Run: 4 steps (the block is 2 of them): request /api/cart, check, request /api/after, check
        const imp = await call("POST", `/api/projects/${pid}/specs`, { validate: false, specs: [apiSpec("Cart then after", [use("Call cart"), { action: "request", method: "GET", path: "/api/after", auth: "none" }, { action: "assertResponse", check: "status", expected: 200 }])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        testId = imp.body.tests[0].id;
        const { repo } = platform;
        repo.updateTest(testId, { reason: "Expected status 200 but got 503", validationStatus: "NEEDS_REVIEW" });
        repo.addExecution({
            testId,
            scriptId: null,
            jobId: null,
            attempt: 1,
            status: "failed",
            durationMs: 1000,
            startedAt: new Date().toISOString(),
            steps: [
                { index: 0, title: "GET /api/cart", status: "passed" },
                { index: 1, title: "check", status: "passed" },
                { index: 2, title: "GET /api/after", status: "failed", error: "boom" },
            ],
        });
        const run = failedRun(repo, testId)!;
        // stored step 2 is a check without an address; the step that ran as number 3 is the request to /api/after
        expect(await failedPathsOf(repo, platform.store, testId, run)).toEqual(["/api/after"]);
    });

    it("the issue text lists the steps that ran and marks the one that failed", async () => {
        const gh = await call("POST", `/api/projects/${pid}/integrations`, { kind: "github", owner: "acme", repo: "notes", token: GH_TOKEN, apiUrl: GH });
        expect([200, 201], JSON.stringify(gh.body)).toContain(gh.status);
        const made = await call("POST", `/api/tests/${testId}/issue`, { integrationId: gh.body.id });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const body = ghBodies.at(-1)!.body;
        const steps = body.split("\n").filter((l) => /^\d+\. /.test(l));
        expect(steps).toHaveLength(4);
        expect(steps[0]).toMatch(/\/api\/cart/);
        expect(steps[2]).toMatch(/\/api\/after.*failed here/);
        expect(steps.filter((l) => /failed here/.test(l))).toHaveLength(1);
        expect(body).toContain("step 3 is where it went wrong");
        expect(body).not.toMatch(/useBlock|Run the reusable steps/);
    });

    it("a test without reusable steps keeps the numbers it always had", async () => {
        const imp = await call("POST", `/api/projects/${pid}/specs`, { validate: false, specs: [apiSpec("No blocks", [{ action: "request", method: "GET", path: "/api/one", auth: "none" }, { action: "request", method: "GET", path: "/api/two", auth: "none" }])] });
        const id = imp.body.tests[0].id as string;
        platform.repo.updateTest(id, { reason: "Expected status 200 but got 503", validationStatus: "NEEDS_REVIEW" });
        platform.repo.addExecution({ testId: id, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 10, startedAt: new Date().toISOString(), steps: [{ index: 0, title: "a", status: "passed" }, { index: 1, title: "b", status: "failed", error: "x" }] });
        expect(await failedPathsOf(platform.repo, platform.store, id, failedRun(platform.repo, id)!)).toEqual(["/api/two"]);
    });
});
