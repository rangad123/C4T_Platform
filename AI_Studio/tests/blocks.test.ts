/**
 * Reusable steps (blocks) end to end, with real work: the real API, the real worker running specs under Playwright against a small fixture
 * app, the real database. No model is configured (and none is used).
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/blocks.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changesData } from "../src/engine/environments/env.js";
import { loadConfig } from "../src/config.js";
import { isLoadSpec } from "../src/engine/performance/load.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { blockView } from "../src/platform/block-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startBlocksApp, type NotesMode } from "./fixtures/blocks-app.js";

const PORT = 6250;
const APP = `http://127.0.0.1:${PORT}`;
const ELSEWHERE = "http://127.0.0.1:6251/";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let notes: http.Server;
let setMode: (m: NotesMode) => void;
let pid: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-blocks-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    ({ server: notes, setMode } = await startBlocksApp(PORT));
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    notes?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = async (method: Method, url: string, payload?: unknown, app = server, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: payload as never, headers });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, raw: res.rawPayload, headers: res.headers };
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
const detail = async (key: string) => (await call("GET", `/api/tests/${ids[key]}`)).body;
const script = async (key: string) => (await detail(key)).scripts[0].content as string;
const blocksUrl = (project = pid) => `/api/projects/${project}/blocks`;
const blockUrl = (name: string, project = pid) => `${blocksUrl(project)}/${encodeURIComponent(name)}`;
const specsUrl = () => `/api/projects/${pid}/specs`;

// ── building blocks the tests use ───────────────────────────────────────────
const nick = { by: "label", value: "Nickname" };
const signInButton = (name: string) => ({ by: "role", role: "button", value: name, exact: true });
const status = { by: "role", role: "status" };
const signInSteps = (button = "Sign in") => [
    { action: "navigate", url: "/" },
    { action: "fill", locator: nick, value: "{{nickname}}" },
    { action: "click", locator: signInButton(button) },
    { action: "assert", check: "text", locator: status, expected: "Signed in as {{nickname}}" },
];
const SIGN_IN = { name: "Sign in", description: "Sign in with a nickname", kind: "web", params: [{ name: "nickname", description: "Who signs in", default: "Ada" }], steps: signInSteps() };
const spec = (title: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({ title, kind: "web", category: "Notes", steps, ...extra });
const use = (block: string, args?: Record<string, string>) => ({ action: "useBlock", block, ...(args ? { args } : {}) });
const addNote = { action: "click", locator: { by: "role", role: "button", value: "Add note", exact: true } };
const counter = (text: string) => ({ action: "assert", check: "text", locator: { by: "text", value: "Notes:" }, expected: text });

describe("creating and reading blocks", () => {
    it("starts with none and says what the editor needs", async () => {
        pid = (await call("POST", "/api/projects", { name: "Notes with reusable steps" })).body.id;
        const empty = await call("GET", blocksUrl());
        expect(empty.status).toBe(200);
        expect(empty.body).toMatchObject({ total: 0, limit: 100, blocks: [] });
        expect(empty.body.catalog.limits.steps).toBe(100);
        expect(empty.body.placeholders.credentials).toContain("credentials.password");
        // the project needs an application before tests can use blocks: import a plain test first (it is run, and it passes)
        const imp = await call("POST", specsUrl(), { baseUrl: APP, specs: [spec("The page is there", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Notes" } }])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.T0 = imp.body.tests[0].id;
        expect((await waitJob(imp.body.jobId)).status).toBe("COMPLETED");
        expect((await detail("T0")).validationStatus).toBe("VALIDATED");
    }, 120_000);

    it("creates a block with parameters and returns it with its steps, version and who uses it", async () => {
        const r = await call("POST", blocksUrl(), SIGN_IN);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body).toMatchObject({ name: "Sign in", kind: "web", stepCount: 4, version: 1, params: [{ name: "nickname", default: "Ada" }], usedBy: { count: 0, blocks: [], tests: [] } });
        expect(r.body.steps).toHaveLength(4);
        const one = await call("GET", blockUrl("Sign in"));
        expect(one.status).toBe(200);
        expect(one.body.steps[1]).toMatchObject({ action: "fill", value: "{{nickname}}" });
        // names are looked up ignoring case, and listed without their steps
        expect((await call("GET", blockUrl("sign IN"))).status).toBe(200);
        const list = await call("GET", blocksUrl());
        expect(list.body.total).toBe(1);
        expect(list.body.blocks[0].steps).toBeUndefined();
        expect((await call("GET", `${blocksUrl()}?q=nick`)).body.blocks).toHaveLength(1);
        expect((await call("GET", `${blocksUrl()}?q=zzz`)).body.blocks).toEqual([]);
        expect((await call("GET", `${blocksUrl()}?kind=api`)).body.blocks).toEqual([]);
    });

    it("refuses bad input with a plain message, and a name that is taken (ignoring case)", async () => {
        const post = (b: unknown) => call("POST", blocksUrl(), b);
        expect((await post({ ...SIGN_IN, name: "" })).status).toBe(400);
        expect((await post({ ...SIGN_IN, name: "bad <name>" })).body.error).toMatch(/Names start with a letter/);
        expect((await post({ ...SIGN_IN, name: "Other", steps: [] })).body.error).toMatch(/at least one step/i);
        expect((await post({ ...SIGN_IN, name: "Other", steps: [{ action: "teleport" }] })).body.error).toMatch(/Step 1/);
        expect((await post({ ...SIGN_IN, name: "Other", params: [{ name: "a.b" }] })).body.error).toMatch(/letters, numbers and underscores/);
        expect((await post({ ...SIGN_IN, name: "Other", kind: "tablet" })).status).toBe(400);
        const dup = await post({ ...SIGN_IN, name: "SIGN IN" });
        expect(dup.status).toBe(409);
        expect(dup.body.error).toMatch(/already has reusable steps called/);
        expect((await call("GET", blockUrl("Nope"))).status).toBe(404);
        expect((await call("GET", `/api/projects/nope/blocks`)).status).toBe(404);
    });

    it("refuses a typed secret, a real-looking key, a step of the wrong kind and steps that need a missing block, saving nothing", async () => {
        const post = (name: string, steps: unknown[], extra: Record<string, unknown> = {}) => call("POST", blocksUrl(), { name, kind: "web", params: [], steps, ...extra });
        const typed = await post("Typed secret", [{ action: "fill", locator: { by: "label", value: "Password" }, value: "hunter2-for-real" }]);
        expect(typed.status).toBe(400);
        expect(typed.body.error).toMatch(/holds a secret/);
        const key = await post("Real key", [{ action: "fill", locator: nick, value: "sk-abcdefghijklmnopqrstuvwxyz0123" }]);
        expect(key.status).toBe(400);
        expect(key.body.error).toMatch(/real key, token or password/);
        const wrongKind = await post("Wrong kind", [{ action: "request", method: "GET", path: "/x", auth: "none" }]);
        expect(wrongKind.status).toBe(400);
        expect(wrongKind.body.error).toMatch(/belongs in an API test/);
        const missing = await post("Needs another", [use("Does not exist")]);
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/“Does not exist”.*not in this project/);
        // a default that is a typed secret is refused too
        const dflt = await post("Secret default", [{ action: "fill", locator: { by: "label", value: "Password" }, value: "{{pw}}" }], { params: [{ name: "pw", default: "hunter2-for-real" }] });
        expect(dflt.status).toBe(400);
        expect((await call("GET", blocksUrl())).body.total).toBe(1);
    });
});

describe("tests that use a block", () => {
    it("import: two tests use the same block, the stored spec stays small, the scripts are written out, both pass", async () => {
        const imp = await call("POST", specsUrl(), {
            specs: [
                spec("Grace adds a note", [use("Sign in", { nickname: "Grace" }), addNote, counter("Notes: 1")]),
                spec("Ada is signed in", [use("Sign in"), { action: "assert", check: "visible", locator: { by: "text", value: "Signed in as Ada" } }]),
            ],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.A = imp.body.tests[0].id;
        ids.B = imp.body.tests[1].id;
        const job = await waitJob(imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        for (const k of ["A", "B"]) expect((await detail(k)).validationStatus, k).toBe("VALIDATED");

        const a = await detail("A");
        // the stored spec is three steps, one of them the use
        expect(a.spec.steps).toHaveLength(3);
        expect(a.spec.steps[0]).toMatchObject({ action: "useBlock", block: "Sign in", args: { nickname: "Grace" } });
        // the script has the block's steps with the value filled in, and no trace of the block
        const sa = await script("A");
        expect(sa).toContain("Grace");
        expect(sa).toContain('getByLabel("Nickname")');
        expect(sa).not.toMatch(/useBlock|reusable/i);
        expect(await script("B")).toContain("Ada");
        // the run's step results follow the steps that ran; the page gets them with the stored step each belongs to
        expect(a.runSteps.map((s: any) => [s.from, s.block ?? null])).toEqual([[0, "Sign in"], [0, "Sign in"], [0, "Sign in"], [0, "Sign in"], [1, null], [2, null]]);
        expect(a.executions[0].steps).toHaveLength(6);
        // a test without blocks has no such list
        expect((await detail("T0")).runSteps).toBeUndefined();
    }, 180_000);

    it("shows who uses a block, directly and in the usage answer", async () => {
        const b = (await call("GET", blockUrl("Sign in"))).body;
        expect(b.usedBy.count).toBe(2);
        expect(b.usedBy.tests.map((t: any) => t.title).sort()).toEqual(["Ada is signed in", "Grace adds a note"]);
        const u = (await call("GET", `${blockUrl("Sign in")}/usage`)).body;
        expect(u.tests.map((t: any) => [t.title, t.steps, t.validationStatus]).sort()).toEqual([["Ada is signed in", 1, "VALIDATED"], ["Grace adds a note", 1, "VALIDATED"]]);
        expect(u.blocks).toEqual([]);
    });

    it("leaves a test without blocks exactly as it was: same script, still its first version", async () => {
        const t0 = await detail("T0");
        expect(t0.scripts).toHaveLength(1);
        expect(t0.scripts[0].version).toBe(1);
        expect(t0.scripts[0].content).not.toMatch(/useBlock/);
    });

    it("changing a step of the block renders both tests again and validates them again; they pass", async () => {
        setMode("renamed");
        const before = await script("A");
        expect(before).toContain("Sign in");
        const edit = await call("PUT", blockUrl("Sign in"), { steps: signInSteps("Log in"), expectedVersion: 1 });
        expect(edit.status, JSON.stringify(edit.body)).toBe(200);
        expect(edit.body).toMatchObject({ version: 2, appliesTo: 2, revalidation: { status: "started" }, problems: [] });
        expect(edit.body.tests.map((t: any) => t.title).sort()).toEqual(["Ada is signed in", "Grace adds a note"]);
        // the scripts already follow the change
        expect(await script("A")).toContain("Log in");
        expect(await script("B")).toContain("Log in");
        const job = await waitJob(edit.body.revalidation.jobId);
        expect(job.status).toBe("COMPLETED");
        for (const k of ["A", "B"]) expect((await detail(k)).validationStatus, k).toBe("VALIDATED");
        // the stored specs did not change
        expect((await detail("A")).spec.steps[0]).toMatchObject({ action: "useBlock", block: "Sign in", args: { nickname: "Grace" } });
        // someone else changed it meanwhile
        const stale = await call("PUT", blockUrl("Sign in"), { description: "x", expectedVersion: 1 });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toMatch(/Someone changed/);
    }, 180_000);

    it("changing only the description does not touch the tests", async () => {
        const r = await call("PUT", blockUrl("Sign in"), { description: "Sign in with any nickname" });
        expect(r.status).toBe(200);
        // the tests that use it are told about, but nothing is rendered again or run again
        expect(r.body).toMatchObject({ description: "Sign in with any nickname", appliesTo: 2, revalidation: { status: "none" } });
        expect((await detail("A")).validationStatus).toBe("VALIDATED");
    });

    it("does not offer to repair a test that uses reusable steps", async () => {
        const h = await call("GET", `/api/tests/${ids.A}/healing`);
        expect(h.status).toBe(200);
        expect(h.body.proposals ?? []).toEqual([]);
    });
});

describe("what a change to a block must not break", () => {
    it("refuses a change that would make a test send the stored password to another site, listing the test, and saves nothing", async () => {
        expect((await call("POST", blocksUrl(), { name: "Type nickname", kind: "web", params: [{ name: "who", default: "Grace" }], steps: [{ action: "fill", locator: nick, value: "{{who}}" }] })).status).toBe(201);
        // this test visits another site first (a page that is never opened here), then types: fine while the block types a nickname
        const imp = await call("POST", specsUrl(), { validate: false, specs: [spec("Visits elsewhere then types", [{ action: "navigate", url: ELSEWHERE }, use("Type nickname")])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.W = imp.body.tests[0].id;
        const risky = await call("PUT", blockUrl("Type nickname"), { steps: [{ action: "fill", locator: nick, value: "{{credentials.password}}" }] });
        expect(risky.status).toBe(409);
        expect(risky.body.error).toMatch(/would break 1 test/);
        expect(risky.body.error).toContain("Visits elsewhere then types");
        expect(risky.body.error).toMatch(/Stored sign-in details can only be used on the application's own site/);
        expect(risky.body.error).toMatch(/Nothing was saved/);
        expect(risky.body.details.tests).toEqual([expect.objectContaining({ title: "Visits elsewhere then types" })]);
        const still = (await call("GET", blockUrl("Type nickname"))).body;
        expect(still.version).toBe(1);
        expect(still.steps[0].value).toBe("{{who}}");
        // the same use, with the password given to a parameter, is refused when the TEST is saved too
        const viaArgs = await call("POST", specsUrl(), { validate: false, specs: [spec("Password through a value", [{ action: "navigate", url: ELSEWHERE }, use("Type nickname", { who: "{{credentials.password}}" })])] });
        expect(viaArgs.status).toBe(400);
        expect(JSON.stringify(viaArgs.body)).toMatch(/Stored sign-in details can only be used on the application's own site/);
    });

    it("refuses a change that takes away a parameter or adds one without a default while a test gives it a value", async () => {
        const gone = await call("PUT", blockUrl("Sign in"), { params: [] });
        expect(gone.status).toBe(409);
        expect(gone.body.error).toMatch(/have no parameters, so “nickname” can't be given/);
        const needs = await call("PUT", blockUrl("Sign in"), { params: [{ name: "nickname", default: "Ada" }, { name: "extra" }], steps: [...signInSteps("Log in"), { action: "fill", locator: nick, value: "{{extra}}" }] });
        expect(needs.status).toBe(409);
        expect(needs.body.error).toMatch(/need a value for “extra”/);
        expect((await call("GET", blockUrl("Sign in"))).body.version).toBe(3);
    });

    it("refuses a block whose steps can't be turned into a script", async () => {
        const r = await call("PUT", blockUrl("Sign in"), { steps: [{ action: "navigate", url: "/" }, { action: "press", key: "" }] });
        expect(r.status).toBe(400);
    });
});

describe("blocks that use blocks", () => {
    it("allows three levels, refuses a fourth and a circle, each with a plain message", async () => {
        const mk = (name: string, steps: unknown[]) => call("POST", blocksUrl(), { name, kind: "web", params: [], steps });
        expect((await mk("D4", [{ action: "wait", ms: 10 }])).status).toBe(201);
        expect((await mk("D3", [use("D4")])).status).toBe(201);
        expect((await mk("D2", [use("D3")])).status).toBe(201);
        const tooDeep = await mk("D1", [use("D2")]);
        expect(tooDeep.status).toBe(400);
        expect(tooDeep.body.error).toMatch(/“D1” reach 4 levels.*at most 3 levels/);
        // a circle: D4 using D2 would close D2 → D3 → D4 → D2
        const circle = await call("PUT", blockUrl("D4"), { steps: [use("D2")] });
        expect(circle.status).toBe(400);
        expect(circle.body.error).toMatch(/in a circle: “D\d”, which uses “D\d”/);
        expect((await call("GET", blockUrl("D4"))).body.steps[0].action).toBe("wait");
        // a block using itself
        const self = await call("PUT", blockUrl("D4"), { steps: [use("D4")] });
        expect(self.status).toBe(400);
        expect(self.body.error).toMatch(/in a circle/);
    });

    it("lists the blocks that use a block, and refuses to delete one that is used by a test or a block", async () => {
        const d3 = (await call("GET", blockUrl("D3"))).body;
        expect(d3.usedBy.blocks).toEqual(["D2"]);
        const refused = await call("DELETE", blockUrl("D3"));
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/is used by the reusable steps “D2”/);
        expect(refused.body.details.blocks).toEqual(["D2"]);
        const used = await call("DELETE", blockUrl("Sign in"));
        expect(used.status).toBe(409);
        expect(used.body.error).toMatch(/used by 2 tests: .*Ada is signed in/);
        expect(used.body.details.tests).toHaveLength(2);
        expect((await call("GET", blockUrl("Sign in"))).status).toBe(200);
        // a block used only through another block still has the test as its user
        expect((await call("POST", specsUrl(), { validate: false, specs: [spec("Uses the deepest", [use("D2")])] })).status).toBe(202);
        const d4 = (await call("GET", `${blockUrl("D4")}/usage`)).body;
        expect(d4.tests.map((t: any) => t.title)).toEqual(["Uses the deepest"]);
        expect(d4.blocks).toEqual(["D3"]);
    });

    it("renaming a block follows everywhere it is used", async () => {
        const r = await call("PUT", blockUrl("D4"), { name: "Pause" });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.name).toBe("Pause");
        expect((await call("GET", blockUrl("D3"))).body.steps[0]).toMatchObject({ action: "useBlock", block: "Pause" });
        expect((await call("GET", blockUrl("D4"))).status).toBe(404);
        const taken = await call("PUT", blockUrl("Pause"), { name: "sign in" });
        expect(taken.status).toBe(409);
    });
});

describe("taking steps out of a test", () => {
    it("turns consecutive steps into a block; the test's script stays the same and it keeps passing", async () => {
        const imp = await call("POST", specsUrl(), {
            specs: [spec("Linus adds a note", [{ action: "navigate", url: "/" }, { action: "fill", locator: nick, value: "Linus" }, { action: "click", locator: signInButton("Log in") }, { action: "assert", check: "text", locator: status, expected: "Signed in as Linus" }, addNote, counter("Notes: 1")])],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.C = imp.body.tests[0].id;
        expect((await waitJob(imp.body.jobId)).status).toBe("COMPLETED");
        expect((await detail("C")).validationStatus).toBe("VALIDATED");
        const scriptBefore = await script("C");
        const versionBefore = (await detail("C")).scripts[0].version;

        const r = await call("POST", `${blocksUrl()}/from-steps`, { testId: ids.C, from: 1, to: 3, name: "Quick sign in", params: [{ name: "who", description: "Who signs in", replace: "Linus" }] });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body).toMatchObject({ testId: ids.C, steps: 3, block: { name: "Quick sign in", kind: "web", params: [{ name: "who", default: "Linus" }] } });
        expect(r.body.block.steps[0]).toMatchObject({ action: "fill", value: "{{who}}" });
        expect(r.body.block.steps[2]).toMatchObject({ action: "assert", expected: "Signed in as {{who}}" });

        const c = await detail("C");
        expect(c.spec.steps).toHaveLength(4);
        expect(c.spec.steps[1]).toMatchObject({ action: "useBlock", block: "Quick sign in", args: { who: "Linus" } });
        // byte for byte the same script, no new version, still validated, nothing waiting to be run
        expect(c.scripts[0].content).toBe(scriptBefore);
        expect(c.scripts[0].version).toBe(versionBefore);
        expect(c.validationStatus).toBe("VALIDATED");
        // and the history shows what happened
        const versions = (await call("GET", `/api/tests/${ids.C}/spec-versions`)).body as Array<{ version: number; note: string | null }>;
        expect(versions.map((v) => v.version)).toEqual([2, 1]);
        expect(versions[0]!.note).toMatch(/Steps 2 to 4 became the reusable steps “Quick sign in”/);
        // running it again passes
        const app = platform.repo.getLatestApplicationPublic(pid)!;
        const job = await waitJob((await platform.repo.createJob(pid, app.id as string, { ...(await import("../src/platform/repo.js")).DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [ids.C!] })).id);
        expect(job.status).toBe("COMPLETED");
        expect((await detail("C")).validationStatus).toBe("VALIDATED");
    }, 240_000);

    it("refuses a name that is taken, steps that are not there, text that is not in the steps and a parameter without a value", async () => {
        const url = `${blocksUrl()}/from-steps`;
        const base = { testId: ids.C, from: 0, to: 0, name: "Fresh" };
        expect((await call("POST", url, { ...base, name: "sign in" })).status).toBe(409);
        expect((await call("POST", url, { ...base, from: 3, to: 1 })).body.error).toMatch(/consecutive steps/);
        expect((await call("POST", url, { ...base, to: 99 })).body.error).toMatch(/consecutive steps of this test \(it has 4\)/);
        expect((await call("POST", url, { ...base, params: [{ name: "x", replace: "no such text" }] })).body.error).toMatch(/is not in the steps you chose/);
        expect((await call("POST", url, { ...base, params: [{ name: "x" }] })).body.error).toMatch(/needs a default value/);
        expect((await call("POST", url, { ...base, testId: "nope" })).status).toBe(404);
        expect((await call("POST", url, { ...base, name: "bad <name>" })).status).toBe(400);
        // nothing was created by any of that
        expect((await call("GET", blockUrl("Fresh"))).status).toBe(404);
    });

    it("refuses a range that would break the sign-in rule, and a hand-written test", async () => {
        // an older test that already sends the password elsewhere (stored before the rule existed, so it can be in the database)
        const suiteId = platform.repo.getOrCreateSuite(pid, "Notes", "notes");
        const leaking = TestSpecSchema.parse({ testId: "WEB-900", title: "Leaks from the past", kind: "web", category: "Notes", steps: [{ action: "navigate", url: ELSEWHERE }, { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" }], source: { origin: "manual" } });
        ids.L = platform.repo.insertTest({ projectId: pid, suiteId, jobId: null, spec: leaking, framework: "playwright", validationStatus: "PENDING" });
        const r = await call("POST", `${blocksUrl()}/from-steps`, { testId: ids.L, from: 1, to: 1, name: "Type the password" });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/can't become reusable steps.*Stored sign-in details can only be used/);
        expect((await call("GET", blockUrl("Type the password"))).status).toBe(404);
        expect((await detail("L")).spec.steps).toHaveLength(2);

        // a hand-written test has no steps to take
        new CustomScriptStore(platform.db).mark(ids.L!, pid, { origin: "taken-over", specArchive: leaking });
        const hand = await call("POST", `${blocksUrl()}/from-steps`, { testId: ids.L, from: 0, to: 0, name: "Nothing" });
        expect(hand.status).toBe(409);
        expect(hand.body.error).toMatch(/code test/);
        // and the step editor does not edit it either
        expect((await call("PUT", `/api/tests/${ids.L}/spec`, { spec: { title: "Leaks from the past", steps: [use("Sign in")] } })).status).toBe(409);
    });
});

describe("the step editor and blocks", () => {
    it("saves a test that uses a block and says which step is wrong when it does not fit", async () => {
        const t = (await call("GET", `/api/tests/${ids.T0}/spec`)).body;
        expect(t.editable).toBe(true);
        const ok = await call("POST", `/api/tests/${ids.T0}/spec/preview`, { spec: { ...t.spec, steps: [use("Sign in", { nickname: "Zed" }), ...t.spec.steps] } });
        expect(ok.body).toMatchObject({ ok: true });
        expect(ok.body.script).toContain("Zed");
        expect(ok.body.script).not.toMatch(/useBlock/);
        const missing = await call("POST", `/api/tests/${ids.T0}/spec/preview`, { spec: { ...t.spec, steps: [...t.spec.steps, use("Nope")] } });
        expect(missing.body.ok).toBe(false);
        expect(missing.body.diagnostics[0]).toMatchObject({ severity: "error", stepIndex: 2 });
        expect(missing.body.diagnostics[0].message).toMatch(/^Step 3: .*“Nope”/);
        // a typed secret given to a value of a block
        const pwBlock = await call("POST", blocksUrl(), { name: "Type password", kind: "web", params: [{ name: "pw", default: "{{credentials.password}}" }], steps: [{ action: "fill", locator: { by: "label", value: "Password" }, value: "{{pw}}" }] });
        expect(pwBlock.status, JSON.stringify(pwBlock.body)).toBe(201);
        const secret = await call("POST", `/api/tests/${ids.T0}/spec/preview`, { spec: { ...t.spec, steps: [...t.spec.steps, use("Type password", { pw: "hunter2-for-real" })] } });
        expect(secret.body.ok).toBe(false);
        expect(secret.body.diagnostics[0].message).toMatch(/^Step 3: in the reusable steps “Type password”, this field holds a secret/);
        // a test saved with a block keeps the use, the block shows up as used, and the test is queued to run
        const saved = await call("PUT", `/api/tests/${ids.T0}/spec`, { spec: { ...t.spec, steps: [use("Sign in", { nickname: "Zed" }), ...t.spec.steps.slice(1)] } });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.changed).toBe(true);
        expect((await detail("T0")).spec.steps[0]).toMatchObject({ action: "useBlock", block: "Sign in" });
        expect((await call("GET", blockUrl("Sign in"))).body.usedBy.count).toBe(3);
        if (saved.body.jobId) await waitJob(saved.body.jobId);
    }, 180_000);
});

describe("shared elements inside blocks", () => {
    it("a block that uses a shared element keeps it from being deleted, follows its rename and reaches the tests that use the block", async () => {
        const el = await call("POST", `/api/projects/${pid}/objects`, { name: "Notes / Add note button", kind: "web", locator: { by: "role", role: "button", value: "Add note", exact: true } });
        expect(el.status, JSON.stringify(el.body)).toBe(201);
        expect((await call("POST", blocksUrl(), { name: "Add a note", kind: "web", params: [], steps: [{ action: "click", locator: { ref: "Notes / Add note button" } }] })).status).toBe(201);
        const imp = await call("POST", specsUrl(), { validate: false, specs: [spec("Adds a note through steps and an element", [use("Sign in"), use("Add a note"), counter("Notes: 1")])] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.E = imp.body.tests[0].id;
        // the script holds the element's real locator
        expect(await script("E")).toContain('getByRole("button", { name: "Add note", exact: true })');

        const del = await call("DELETE", `/api/projects/${pid}/objects/${el.body.id}`);
        expect(del.status).toBe(409);
        expect(del.body.error).toMatch(/used by 1 test: .*Adds a note through steps and an element/);

        // the element's users include the test that reaches it only through the block
        const one = (await call("GET", `/api/projects/${pid}/objects/${el.body.id}`)).body;
        expect(one.name).toBe("Notes / Add note button");
        const renamed = await call("PUT", `/api/projects/${pid}/objects/${el.body.id}`, { name: "Notes / Add" });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        expect((await call("GET", blockUrl("Add a note"))).body.steps[0].locator).toEqual({ ref: "Notes / Add" });
        expect(await script("E")).toContain('getByRole("button", { name: "Add note", exact: true })');
    }, 120_000);
});

describe("production safety looks inside blocks", () => {
    it("sees a data-changing request and a load check that only exist inside a block", async () => {
        const post = await call("POST", blocksUrl(), { name: "Create a note", kind: "api", params: [], steps: [{ action: "request", method: "POST", path: "/api/notes", auth: "none", body: { text: "x" } }] });
        expect(post.status, JSON.stringify(post.body)).toBe(201);
        const load = await call("POST", blocksUrl(), { name: "Load the list", kind: "api", params: [], steps: [{ action: "request", method: "GET", path: "/api/notes", auth: "none" }, { action: "assertResponse", check: "load", expected: "users:2 seconds:2" }] });
        expect(load.status, JSON.stringify(load.body)).toBe(201);
        const view = blockView(platform.db, pid);
        const apiSpec = (steps: unknown[]) => TestSpecSchema.parse({ testId: "API-950", title: "Uses blocks", kind: "api", steps });
        const creates = apiSpec([use("Create a note")]);
        expect(changesData(creates)).toBe(false);
        expect(changesData(view(creates))).toBe(true);
        const loads = apiSpec([use("Load the list")]);
        expect(isLoadSpec(loads)).toBe(false);
        expect(isLoadSpec(view(loads))).toBe(true);
    });

    it("runs an API test that uses an API block against the fixture", async () => {
        expect((await call("POST", blocksUrl(), { name: "Read notes", kind: "api", params: [], steps: [{ action: "request", method: "GET", path: "/api/notes", auth: "none" }, { action: "assertResponse", check: "status", expected: 200 }] })).status).toBe(201);
        const imp = await call("POST", specsUrl(), { specs: [{ title: "Notes can be read", kind: "api", category: "Notes API", steps: [use("Read notes")] }] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ids.API = imp.body.tests[0].id;
        expect((await waitJob(imp.body.jobId)).status).toBe("COMPLETED");
        const t = await detail("API");
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.scripts[0].content).toContain("/api/notes");
        expect(t.scripts[0].content).not.toMatch(/useBlock/);
    }, 120_000);
});

describe("other projects", () => {
    it("a test can only use the blocks of its own project", async () => {
        const other = (await call("POST", "/api/projects", { name: "Another project" })).body.id as string;
        expect((await call("GET", blocksUrl(other))).body.total).toBe(0);
        expect((await call("GET", blockUrl("Sign in", other))).status).toBe(404);
        const imp = await call("POST", `/api/projects/${other}/specs`, { baseUrl: APP, validate: false, specs: [spec("Borrows a block", [use("Sign in")])] });
        expect(imp.status).toBe(400);
        expect(JSON.stringify(imp.body)).toMatch(/“Sign in”, which are not in this project/);
        // the other project's blocks do not show up here either
        expect((await call("POST", blocksUrl(other), { ...SIGN_IN, name: "Only there" })).status).toBe(201);
        expect((await call("GET", blockUrl("Only there"))).status).toBe(404);
        // a test can't be reached across projects through the extraction route
        const r = await call("POST", `${blocksUrl(other)}/from-steps`, { testId: ids.C, from: 0, to: 0, name: "Stolen" });
        expect(r.status).toBe(404);
        // deleting a project takes its blocks with it
        expect((await call("DELETE", blockUrl("Only there", other))).status).toBe(204);
        expect((await call("GET", blockUrl("Only there", other))).status).toBe(404);
    }, 60_000);
});

describe("backup and restore", () => {
    let zip: Buffer;
    let files: Record<string, Uint8Array>;

    it("carries the blocks with the tests and brings them back, tests working", async () => {
        const r = await call("GET", `/api/projects/${pid}/backup`);
        expect(r.status).toBe(200);
        zip = Buffer.from(r.raw);
        files = unzipSync(new Uint8Array(zip));
        const docs = JSON.parse(strFromU8(files["blocks.json"]!)) as Array<{ name: string }>;
        expect(docs.map((b) => b.name)).toContain("Sign in");
        expect(JSON.parse(strFromU8(files["manifest.json"]!)).counts.blocks).toBe(docs.length);

        const restored = await call("POST", "/api/projects/restore", zip, server, { "content-type": "application/zip" });
        expect(restored.status, JSON.stringify(restored.body)).toBe(201);
        expect(restored.body.restored.blocks).toBe(docs.length);
        const rid = restored.body.project.id as string;
        const list = (await call("GET", blocksUrl(rid))).body;
        expect(list.total).toBe(docs.length);
        expect(list.blocks.find((b: any) => b.name === "Sign in")).toMatchObject({ kind: "web", usedBy: { count: 4 } });
        const tests = (await call("GET", `/api/projects/${rid}/tests`)).body as Array<{ id: string; testId: string; title: string }>;
        const grace = tests.find((t) => t.title === "Grace adds a note")!;
        const d = (await call("GET", `/api/tests/${grace.id}`)).body;
        expect(d.spec.steps[0]).toMatchObject({ action: "useBlock", block: "Sign in", args: { nickname: "Grace" } });
        expect(d.scripts[0].content).toContain("Grace");
        expect(d.scripts[0].content).not.toMatch(/useBlock/);
    });

    const hostile = async (change: (f: Record<string, Uint8Array>) => void) => {
        const copy = { ...files };
        change(copy);
        const bad = Buffer.from(zipSync(copy));
        const before = (await call("GET", "/api/projects")).body.length as number;
        const r = await call("POST", "/api/projects/restore", bad, server, { "content-type": "application/zip" });
        expect((await call("GET", "/api/projects")).body.length, "nothing may be created").toBe(before);
        return r;
    };
    const docsOf = () => JSON.parse(strFromU8(files["blocks.json"]!)) as Array<Record<string, any>>;

    it("refuses a backup whose blocks use each other in a circle", async () => {
        const r = await hostile((f) => {
            const d = docsOf().filter((b) => b.name === "Sign in");
            d.push({ name: "P", kind: "web", params: [], steps: [{ action: "useBlock", block: "Q" }] }, { name: "Q", kind: "web", params: [], steps: [{ action: "useBlock", block: "P" }] });
            f["blocks.json"] = strToU8(JSON.stringify(d));
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/in a circle/);
    });

    it("refuses a backup with a block that is too large, one with a typed secret and one used by a test but missing", async () => {
        const big = await hostile((f) => (f["blocks.json"] = strToU8(JSON.stringify([{ name: "Huge", kind: "web", params: [], steps: Array.from({ length: 41 }, () => ({ action: "wait", ms: 10 })) }]))));
        expect(big.status).toBe(400);
        expect(big.body.error).toMatch(/at most 40 steps/);
        const wide = await hostile((f) => (f["blocks.json"] = strToU8(JSON.stringify([{ name: "Wide", kind: "web", params: [], steps: Array.from({ length: 30 }, () => ({ action: "navigate", url: `/${"x".repeat(900)}` })) }]))));
        expect(wide.status).toBe(400);
        expect(wide.body.error).toMatch(/too large/);
        const secret = await hostile((f) => (f["blocks.json"] = strToU8(JSON.stringify([{ name: "Leaky", kind: "web", params: [], steps: [{ action: "fill", locator: { by: "label", value: "Password" }, value: "hunter2-for-real" }] }]))));
        expect(secret.status).toBe(400);
        expect(secret.body.error).toMatch(/real secret/);
        const missing = await hostile((f) => delete f["blocks.json"]);
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/cannot use its reusable steps/);
        const tooMany = await hostile((f) => (f["blocks.json"] = strToU8(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ name: `B${i}`, kind: "web", params: [], steps: [{ action: "wait", ms: 10 }] }))))));
        expect(tooMany.status).toBe(400);
    });

    it("leaves a backup of a project without blocks exactly as before (no blocks.json)", async () => {
        const other = (await call("POST", "/api/projects", { name: "No blocks here" })).body.id as string;
        const r = await call("GET", `/api/projects/${other}/backup`);
        expect(Object.keys(unzipSync(new Uint8Array(r.raw)))).not.toContain("blocks.json");
    });
});

describe("deleting", () => {
    it("deletes a block nothing uses, and refuses the 101st block", async () => {
        const gone = await call("DELETE", blockUrl("Read notes"));
        // used by the API test: refused; the blocks that nothing uses can go
        expect(gone.status).toBe(409);
        expect((await call("DELETE", blockUrl("Load the list"))).status).toBe(204);
        expect((await call("GET", blockUrl("Load the list"))).status).toBe(404);
        expect((await call("DELETE", blockUrl("Load the list"))).status).toBe(404);
        // the cap
        const count = (await call("GET", blocksUrl())).body.total as number;
        const fill = platform.db;
        for (let i = count; i < 100; i++) {
            fill.run("INSERT INTO step_blocks (id, project_id, name, name_key, description, kind, params_json, steps_json, version, created_at, updated_at) VALUES (?,?,?,?,NULL,'web','[]',?,1,?,?)", `filler-${i}`, pid, `Filler ${i}`, `filler ${i}`, JSON.stringify([{ action: "wait", ms: 10, description: "" }]), new Date().toISOString(), new Date().toISOString());
        }
        const over = await call("POST", blocksUrl(), { name: "One too many", kind: "web", params: [], steps: [{ action: "wait", ms: 10 }] });
        expect(over.status).toBe(400);
        expect(over.body.error).toMatch(/at most 100 sets of reusable steps/);
    });
});

describe("the API key", () => {
    it("protects every route", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-blocks-key-"));
        const guardedPlatform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY: "block-test-key-0123456789" }));
        const guarded = await buildServer(guardedPlatform);
        try {
            const routes: Array<[Method, string, unknown?]> = [
                ["GET", "/api/projects/p/blocks"],
                ["POST", "/api/projects/p/blocks", SIGN_IN],
                ["POST", "/api/projects/p/blocks/from-steps", { testId: "t", from: 0, to: 0, name: "x" }],
                ["GET", "/api/projects/p/blocks/x"],
                ["PUT", "/api/projects/p/blocks/x", { description: "y" }],
                ["DELETE", "/api/projects/p/blocks/x"],
                ["GET", "/api/projects/p/blocks/x/usage"],
            ];
            for (const [m, u, b] of routes) expect((await call(m, u, b, guarded)).status, `${m} ${u}`).toBe(401);
            // with the key the request reaches the real checks
            expect((await call("GET", "/api/projects/p/blocks", undefined, guarded, { "x-api-key": "block-test-key-0123456789" })).status).toBe(404);
        } finally {
            await guarded.close();
            guardedPlatform.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
