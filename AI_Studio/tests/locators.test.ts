/**
 * Object repository (shared locators) end to end, with real work: the real API, the real worker running specs under Playwright
 * against a fixture shop whose button is renamed between runs. No model is configured (and none is used).
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/locators.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startHealingApp, type ShopMode } from "./fixtures/healing-app.js";

const FIXTURE_PORT = 5930;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let shop: http.Server;
let setMode: (m: ShopMode) => void;
let pid: string;
const ids: Record<string, string> = {};
const els: Record<string, string> = {};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-locators-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    ({ server: shop, setMode } = await startHealingApp(FIXTURE_PORT));
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    shop?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = async (method: Method, url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null, raw: res };
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
async function revalidate(...keys: string[]) {
    const app = platform.repo.getLatestApplicationPublic(pid)!;
    const job = await platform.repo.createJob(pid, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: keys.map((k) => ids[k]!) });
    return waitJob(job.id);
}
const test_ = async (key: string) => (await call("GET", `/api/tests/${ids[key]}`)).body;
const proposals = async (key: string) => (await call("GET", `/api/tests/${ids[key]}/healing`)).body.proposals as any[];
const objectsUrl = (project = pid) => `/api/projects/${project}/objects`;
const element = async (key: string, project = pid) => (await call("GET", `${objectsUrl(project)}/${els[key]}`)).body;
const script = async (key: string) => (await test_(key)).scripts[0].content as string;

const addButton = { by: "role", role: "button", value: "Add to cart", exact: true };
const statusBox = { by: "role", role: "status" };
const spec = (title: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({ title, kind: "web", category: "Shop", steps, ...extra });
const NAMES = { add: "Shop / Add to cart button", status: "Shop / Cart status" };
const viaRefs = (title: string) => spec(title, [{ action: "navigate", url: "/" }, { action: "click", locator: { ref: NAMES.add } }, { action: "assert", check: "text", locator: { ref: NAMES.status }, expected: "Cart: 1 item" }]);
const concrete = (title: string) => spec(title, [{ action: "navigate", url: "/" }, { action: "click", locator: addButton }, { action: "assert", check: "text", locator: statusBox, expected: "Cart: 1 item" }]);

describe("object repository: elements", () => {
    it("creates, reads and lists elements, with the locator in words and a version", async () => {
        pid = (await call("POST", "/api/projects", { name: "Shop with shared locators" })).body.id;
        const empty = await call("GET", objectsUrl());
        expect(empty.body).toEqual({ total: 0, limit: 1000, elements: [] });

        const add = await call("POST", objectsUrl(), { name: NAMES.add, kind: "web", page: "Shop", locator: addButton, notes: "The main call to action" });
        expect(add.status, JSON.stringify(add.body)).toBe(201);
        expect(add.body).toMatchObject({ name: NAMES.add, kind: "web", page: "Shop", locator: addButton, description: 'Button "Add to cart"', notes: "The main call to action", version: 1, usedBy: { count: 0, tests: [] } });
        els.add = add.body.id;
        const status = await call("POST", objectsUrl(), { name: NAMES.status, kind: "web", locator: statusBox });
        expect(status.status).toBe(201);
        els.status = status.body.id;
        expect(status.body.description).toBe("Status");

        const list = await call("GET", objectsUrl());
        expect(list.body.total).toBe(2);
        // grouped by page: the element without a page first
        expect(list.body.elements.map((e: any) => e.name)).toEqual([NAMES.status, NAMES.add]);
        expect((await call("GET", `${objectsUrl()}/${els.add}`)).body).toMatchObject({ id: els.add, name: NAMES.add, version: 1 });
        expect((await call("GET", `${objectsUrl()}?q=cart`)).body.elements.map((e: any) => e.name)).toEqual([NAMES.status, NAMES.add]);
        expect((await call("GET", `${objectsUrl()}?q=zzz`)).body.elements).toEqual([]);
        expect((await call("GET", `${objectsUrl()}?kind=mobile`)).body.elements).toEqual([]);
    });

    it("refuses bad input with a plain message, and a name that is taken (ignoring case)", async () => {
        const post = (b: unknown) => call("POST", objectsUrl(), b);
        expect((await post({ name: "", kind: "web", locator: addButton })).status).toBe(400);
        expect((await post({ name: "bad <name>", kind: "web", locator: addButton })).body.error).toMatch(/Names start with a letter/);
        expect((await post({ name: "No value", kind: "web", locator: { by: "label" } })).body.error).toMatch(/needs a value/);
        expect((await post({ name: "Bad by", kind: "web", locator: { by: "xpath", value: "//a" } })).status).toBe(400);
        expect((await post({ name: "Bad kind", kind: "tablet", locator: addButton })).status).toBe(400);
        expect((await post({ name: "A ref", kind: "web", locator: { ref: NAMES.add } })).status).toBe(400);
        expect((await post({ name: "x".repeat(81), kind: "web", locator: addButton })).body.error).toMatch(/at most 80/);
        const dup = await post({ name: NAMES.add.toUpperCase(), kind: "web", locator: addButton });
        expect(dup.status).toBe(409);
        expect(dup.body.error).toMatch(/already has an element called/);
        expect((await call("GET", `${objectsUrl()}/nope`)).status).toBe(404);
        expect((await call("GET", `/api/projects/nope/objects`)).status).toBe(404);
        expect((await call("PUT", `${objectsUrl()}/${els.add}`, { kind: "mobile" })).status).toBe(400);
    });

    it("imports specs that use the elements: scripts hold the concrete locator and no reference, and the tests pass", async () => {
        const imp = await call("POST", `/api/projects/${pid}/specs`, {
            baseUrl: FIXTURE,
            specs: [viaRefs("Add an item to the cart"), spec("The add button is shown", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { ref: NAMES.add } }]), concrete("Add an item (written out)")],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        ["T1", "T2", "T3"].forEach((k, i) => (ids[k] = imp.body.tests[i].id));
        const job = await waitJob(imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        for (const k of ["T1", "T2", "T3"]) expect((await test_(k)).validationStatus, k).toBe("VALIDATED");

        const t1 = await test_("T1");
        // the stored spec keeps the reference; the script is self-contained
        expect(t1.spec.steps[1].locator).toEqual({ ref: NAMES.add });
        expect(t1.spec.steps[2].locator).toEqual({ ref: NAMES.status });
        const code = await script("T1");
        expect(code).toContain('page.getByRole("button", { name: "Add to cart", exact: true }).click()');
        expect(code).toContain('page.getByRole("status")');
        expect(code).not.toMatch(/Shop \/|\bref\b|shared element/);
        // and it is the same script as for the locator written out
        const written = (await script("T3")).replace(/WEB-00\d/g, "WEB-00X").replace(/Add an item \(written out\)/g, "Add an item to the cart");
        expect(code.replace(/WEB-00\d/g, "WEB-00X")).toBe(written);
        // the downloaded script of a validated test runs on its own: nothing refers to the platform
        expect((await call("GET", `/api/tests/${ids.T1}/script`)).body).toContain("getByRole");
    }, 240_000);

    it("shows where each element is used, from the specs", async () => {
        const list = (await call("GET", objectsUrl())).body.elements as any[];
        const add = list.find((e) => e.name === NAMES.add);
        const status = list.find((e) => e.name === NAMES.status);
        expect(add.usedBy).toMatchObject({ count: 2, steps: 2 });
        expect(add.usedBy.tests.map((t: any) => t.title).sort()).toEqual(["Add an item to the cart", "The add button is shown"]);
        expect(status.usedBy).toMatchObject({ count: 1 });
        const detail = await element("add");
        expect(detail.usedBy.tests).toHaveLength(2);
        expect((await call("GET", `${objectsUrl()}?test=${ids.T1}`)).body.elements.map((e: any) => e.name).sort()).toEqual([NAMES.add, NAMES.status].sort());
        expect((await call("GET", `${objectsUrl()}?test=${ids.T3}`)).body.elements).toEqual([]);
    });

    it("refuses a spec that refers to an unknown element or one of another kind, and stores nothing", async () => {
        const before = (await call("GET", `/api/projects/${pid}/tests`)).body.length;
        const unknown = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: FIXTURE, validate: false, specs: [spec("Uses a missing element", [{ action: "click", locator: { ref: "Cart / Missing button" } }])] });
        expect(unknown.status).toBe(400);
        expect(JSON.stringify(unknown.body.details)).toContain("This test refers to 'Cart / Missing button', which is not in the object repository.");
        const phone = await call("POST", objectsUrl(), { name: "Phone / Login button", kind: "mobile", locator: { by: "testId", value: "login" } });
        expect(phone.status).toBe(201);
        const mismatch = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: FIXTURE, validate: false, specs: [spec("Uses a phone element", [{ action: "click", locator: { ref: "Phone / Login button" } }])] });
        expect(mismatch.status).toBe(400);
        expect(JSON.stringify(mismatch.body.details)).toContain("which is a mobile element; a web test can only use web elements.");
        expect((await call("GET", `/api/projects/${pid}/tests`)).body.length).toBe(before);
        expect((await call("DELETE", `${objectsUrl()}/${phone.body.id}`)).status).toBe(204);
    });
});

describe("object repository: change propagation", () => {
    const put = (key: string, body: unknown) => call("PUT", `${objectsUrl()}/${els[key]}`, body);

    it("a new locator re-renders every test that uses it and validates them again; one fix repairs both", async () => {
        const broken = await put("add", { locator: { by: "role", role: "button", value: "Buy it now", exact: true } });
        expect(broken.status, JSON.stringify(broken.body)).toBe(200);
        expect(broken.body).toMatchObject({ version: 2, appliesTo: 2, revalidation: { status: "started" } });
        expect(broken.body.tests.map((t: any) => t.title).sort()).toEqual(["Add an item to the cart", "The add button is shown"]);
        expect(broken.body.problems).toEqual([]);
        // both scripts changed at once, the test that writes its locator out did not
        for (const k of ["T1", "T2"]) expect(await script(k)).toContain('name: "Buy it now"');
        expect(await script("T3")).toContain('name: "Add to cart"');
        const job = await waitJob(broken.body.revalidation.jobId);
        expect(job.status).not.toBe("FAILED");
        for (const k of ["T1", "T2"]) {
            const t = await test_(k);
            expect(t.validationStatus, k).toBe("FAILED_VALIDATION");
        }
        expect((await test_("T1")).spec.steps[1].locator).toEqual({ ref: NAMES.add }); // the run did not copy the locator into the test
        expect((await test_("T3")).validationStatus).toBe("VALIDATED");

        const fixed = await put("add", { locator: addButton, expectedVersion: 2 });
        expect(fixed.status).toBe(200);
        expect(fixed.body).toMatchObject({ version: 3, appliesTo: 2, revalidation: { status: "started" } });
        await waitJob(fixed.body.revalidation.jobId);
        for (const k of ["T1", "T2"]) expect((await test_(k)).validationStatus, k).toBe("VALIDATED");
        expect(await script("T1")).toContain('name: "Add to cart"');
    }, 300_000);

    it("refuses a change based on an old version, and a change that changes nothing is not a new version", async () => {
        const stale = await put("add", { notes: "x", expectedVersion: 1 });
        expect(stale.status).toBe(409);
        const same = await put("add", { locator: addButton });
        expect(same.status).toBe(200);
        expect(same.body).toMatchObject({ version: 3, appliesTo: 0, revalidation: { status: "none" } });
        const notes = await put("add", { notes: "The main call to action, edited" });
        expect(notes.body).toMatchObject({ version: 4, notes: "The main call to action, edited", revalidation: { status: "none" } });
        expect((await put("add", { locator: { by: "role", value: "no role" } })).status).toBe(400);
    });

    it("while another run is in progress the tests are marked as waiting for a run instead", async () => {
        const app = platform.repo.getLatestApplicationPublic(pid)!;
        const stuck = await platform.repo.createJob(pid, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.db.run("UPDATE generation_jobs SET status = 'VALIDATING' WHERE id = ?", stuck.id); // same tick: the worker cannot claim it
        const r = await put("add", { locator: { by: "role", role: "button", value: "Add to cart", exact: false } });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ appliesTo: 2, revalidation: { status: "waiting" } });
        expect(r.body.revalidation.message).toMatch(/run is in progress/);
        for (const k of ["T1", "T2"]) {
            const t = await test_(k);
            expect(t.validationStatus).toBe("PENDING");
            expect(t.validationReason).toMatch(/shared element “Shop \/ Add to cart button” changed/);
            expect(await script(k)).toContain('name: "Add to cart" }'); // already re-rendered
        }
        platform.repo.setJobStatus(stuck.id, "COMPLETED");
        // put it back and run again so the later tests start from passing ones
        const back = await put("add", { locator: addButton });
        await waitJob(back.body.revalidation.jobId);
        for (const k of ["T1", "T2"]) expect((await test_(k)).validationStatus, k).toBe("VALIDATED");
    }, 240_000);
});

describe("object repository: repair suggestions", () => {
    it("a renamed button: one applied suggestion updates the element once, after the person confirms that it changes other tests", async () => {
        setMode("renamed");
        await revalidate("T1", "T2", "T3");
        for (const k of ["T1", "T2", "T3"]) expect((await test_(k)).validationStatus, k).toBe("FAILED_VALIDATION");

        const [p1] = await proposals("T1");
        expect(p1).toMatchObject({ stepIndex: 1, status: "proposed", canApply: true, oldLocator: addButton, newLocator: { by: "role", role: "button", value: "Add to basket", exact: true } });
        expect(p1.shared).toMatchObject({ name: NAMES.add, otherTests: 1 });
        expect(p1.shared.tests[0].title).toBe("The add button is shown");
        // a step that writes its locator out has no "shared" part at all: the answer is what it always was
        const [p3] = await proposals("T3");
        expect(p3).toMatchObject({ canApply: true, oldLocator: addButton });
        expect("shared" in p3).toBe(false);

        const before = (await element("add")).version;
        const unconfirmed = await call("POST", `/api/tests/${ids.T1}/healing/${p1.id}/apply`);
        expect(unconfirmed.status).toBe(409);
        expect(unconfirmed.body.error).toMatch(/This also changes 1 other test/);
        expect(unconfirmed.body.details).toMatchObject({ requiresConfirmation: true, otherTests: 1 });
        expect((await element("add")).version).toBe(before); // nothing changed
        expect((await proposals("T1"))[0].status).toBe("proposed");

        const applied = await call("POST", `/api/tests/${ids.T1}/healing/${p1.id}/apply`, { acceptSharedChange: true });
        expect(applied.status, JSON.stringify(applied.body)).toBe(202);
        expect(applied.body).toMatchObject({ proposal: { status: "applied", canApply: false }, shared: { name: NAMES.add, appliesTo: 2, revalidation: { status: "started" } } });
        expect(applied.body.jobId).toBe(applied.body.shared.revalidation.jobId);
        const job = await waitJob(applied.body.jobId);
        expect(job.status).toBe("COMPLETED");
        // one fix, both tests pass; the element holds the new locator; the tests still refer to it
        for (const k of ["T1", "T2"]) expect((await test_(k)).validationStatus, k).toBe("VALIDATED");
        const el = await element("add");
        expect(el.locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
        expect(el.version).toBe(before + 1);
        expect((await test_("T1")).spec.steps[1].locator).toEqual({ ref: NAMES.add });
        expect((await test_("T2")).spec.steps[1].locator).toEqual({ ref: NAMES.add });
        expect(await script("T2")).toContain("Add to basket");
        // the test that writes its locator out is not touched by the shared fix
        expect((await test_("T3")).spec.steps[1].locator).toEqual(addButton);
        expect((await test_("T3")).validationStatus).toBe("FAILED_VALIDATION");
        // the other test's own suggestion is stale now
        const [p2] = await proposals("T2");
        expect(p2).toMatchObject({ status: "proposed", canApply: false });
        expect(typeof p2.blockedReason).toBe("string"); // it passes now, and the element it was about has a new locator
    }, 360_000);

    it("a step without a reference is repaired exactly as before: only that step's locator", async () => {
        const [p3] = await proposals("T3");
        const applied = await call("POST", `/api/tests/${ids.T3}/healing/${p3.id}/apply`);
        expect(applied.status, JSON.stringify(applied.body)).toBe(202);
        expect("shared" in applied.body).toBe(false);
        await waitJob(applied.body.jobId);
        const t3 = await test_("T3");
        expect(t3.validationStatus).toBe("VALIDATED");
        expect(t3.spec.steps[1].locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
        expect(JSON.stringify(t3.spec)).not.toContain("ref");
    }, 240_000);
});

describe("object repository: delete and rename", () => {
    it("refuses to delete an element that is used, naming the tests", async () => {
        const r = await call("DELETE", `${objectsUrl()}/${els.add}`);
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/used by 2 tests/);
        expect(r.body.error).toContain("Add an item to the cart");
        expect(r.body.details.tests).toHaveLength(2);
        expect((await call("GET", `${objectsUrl()}/${els.add}`)).status).toBe(200);
    });

    it("deletes one nobody uses", async () => {
        const tmp = await call("POST", objectsUrl(), { name: "Scratch / Unused", kind: "web", locator: { by: "css", value: "#nothing" } });
        expect((await call("DELETE", `${objectsUrl()}/${tmp.body.id}`)).status).toBe(204);
        expect((await call("GET", `${objectsUrl()}/${tmp.body.id}`)).status).toBe(404);
        expect((await call("DELETE", `${objectsUrl()}/${tmp.body.id}`)).status).toBe(404);
    });

    it("rename rewrites every spec at once and leaves the scripts as they were", async () => {
        const codeBefore = await script("T1");
        const versionsBefore = (await test_("T1")).scripts.length;
        const renamed = await call("PUT", `${objectsUrl()}/${els.add}`, { name: "  Shop /  Add button " });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        expect(renamed.body).toMatchObject({ name: "Shop / Add button", appliesTo: 2, revalidation: { status: "none" } });
        for (const k of ["T1", "T2"]) expect((await test_(k)).spec.steps[1].locator).toEqual({ ref: "Shop / Add button" });
        expect(await script("T1")).toBe(codeBefore);
        expect((await test_("T1")).scripts.length).toBe(versionsBefore);
        expect((await element("add")).usedBy.count).toBe(2);
        // the old name is gone for good
        const old = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: FIXTURE, validate: false, specs: [spec("Old name", [{ action: "click", locator: { ref: NAMES.add } }])] });
        expect(old.status).toBe(400);
        NAMES.add = "Shop / Add button";
    });

    it("rename refuses a name that is taken or invalid, and then changes nothing", async () => {
        const taken = await call("PUT", `${objectsUrl()}/${els.add}`, { name: NAMES.status.toLowerCase() });
        expect(taken.status).toBe(409);
        expect((await call("PUT", `${objectsUrl()}/${els.add}`, { name: "bad/<name>" })).status).toBe(400);
        expect((await element("add")).name).toBe("Shop / Add button");
        expect((await test_("T1")).spec.steps[1].locator).toEqual({ ref: "Shop / Add button" });
    });
});

describe("object repository: export and import", () => {
    let other: string;

    it("exports the repository as JSON and imports it into another project, safely", async () => {
        const exp = await call("GET", `${objectsUrl()}/export`);
        expect(exp.status).toBe(200);
        expect(exp.raw.headers["content-disposition"]).toMatch(/object-repository\.json/);
        expect(exp.body.version).toBe(1);
        expect(exp.body.elements.map((e: any) => e.name).sort()).toEqual([NAMES.add, NAMES.status].sort());
        expect(exp.body.elements[0]).not.toHaveProperty("id");

        other = (await call("POST", "/api/projects", { name: "Second shop" })).body.id;
        const imp = await call("POST", `${objectsUrl(other)}/import`, exp.body);
        expect(imp.status, JSON.stringify(imp.body)).toBe(200);
        expect(imp.body).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
        expect((await call("GET", objectsUrl(other))).body.elements.map((e: any) => e.name).sort()).toEqual([NAMES.add, NAMES.status].sort());
        // again: nothing to do
        expect((await call("POST", `${objectsUrl(other)}/import`, exp.body)).body).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
        // a different locator under an existing name is not applied unless the person says so
        const changed = { elements: exp.body.elements.map((e: any) => (e.name === NAMES.add ? { ...e, locator: { by: "css", value: "#x" } } : e)) };
        const refused = await call("POST", `${objectsUrl(other)}/import`, changed);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/different locator/);
        expect((await call("GET", objectsUrl(other))).body.elements.find((e: any) => e.name === NAMES.add).locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
        const forced = await call("POST", `${objectsUrl(other)}/import`, { ...changed, overwrite: true });
        expect(forced.body).toMatchObject({ updated: 1, unchanged: 1 });
        expect((await call("GET", objectsUrl(other))).body.elements.find((e: any) => e.name === NAMES.add).locator).toEqual({ by: "css", value: "#x" });
        // the project we exported from is untouched
        expect((await element("add")).locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
    });

    it("validates a whole import before storing anything", async () => {
        const url = `${objectsUrl(other)}/import`;
        const good = { name: "Fresh one", kind: "web", locator: { by: "css", value: "#f" } };
        const mixed = await call("POST", url, { elements: [good, { name: "bad<>", kind: "web", locator: { by: "css", value: "#f" } }, { ...good, name: "FRESH ONE" }, { name: "__proto__", kind: "web", locator: { by: "css", value: "a" } }, { name: "Ref", kind: "web", locator: { ref: "x" } }] });
        expect(mixed.status).toBe(400);
        expect(mixed.body.details.map((d: any) => d.index)).toEqual([1, 2, 3, 4]);
        expect((await call("GET", objectsUrl(other))).body.elements.some((e: any) => e.name === "Fresh one")).toBe(false);
        const tooMany = await call("POST", url, { elements: Array.from({ length: 1001 }, (_, i) => ({ name: `E ${i}`, kind: "web", locator: { by: "css", value: "a" } })) });
        expect(tooMany.status).toBe(400);
        expect((await call("POST", url, { elements: "no" })).status).toBe(400);
        expect((await call("POST", url, [])).status).toBe(400);
        // unknown keys on an element cannot smuggle anything in
        const extra = await call("POST", url, { elements: [{ ...good, name: "Extra keys", id: "x", projectId: "y", locator: { by: "css", value: "#f", constructor: "x" } }] });
        expect(extra.status).toBe(400);
    });

    it("a spec export carries the elements it needs, and importing it elsewhere works and validates", async () => {
        const exp = await call("GET", `/api/projects/${pid}/specs`);
        expect(exp.status).toBe(200);
        expect(exp.body.objects.map((e: any) => e.name).sort()).toEqual([NAMES.add, NAMES.status].sort());
        expect(exp.body.specs.find((s: any) => s.title === "Add an item to the cart").steps[1].locator).toEqual({ ref: NAMES.add });
        const third = (await call("POST", "/api/projects", { name: "Third shop" })).body.id;
        const imp = await call("POST", `/api/projects/${third}/specs`, { baseUrl: FIXTURE, specs: exp.body.specs, objects: exp.body.objects });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const job = await waitJob(imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const tests = (await call("GET", `/api/projects/${third}/tests`)).body as any[];
        expect(tests).toHaveLength(3);
        expect(tests.every((t) => t.validationStatus === "VALIDATED")).toBe(true);
        expect((await call("GET", objectsUrl(third))).body.elements.map((e: any) => [e.name, e.usedBy.count]).sort()).toEqual([[NAMES.add, 2], [NAMES.status, 1]].sort());
        // without the elements the same import is refused
        const empty = (await call("POST", "/api/projects", { name: "No elements" })).body.id;
        const bare = await call("POST", `/api/projects/${empty}/specs`, { baseUrl: FIXTURE, validate: false, specs: [exp.body.specs[0]] });
        expect(bare.status).toBe(400);
        expect(JSON.stringify(bare.body.details)).toContain("not in the object repository");
    }, 300_000);

    it("a spec export of a project that uses no element has exactly the shape it always had", async () => {
        const noRefs = (await call("POST", "/api/projects", { name: "No shared locators" })).body.id;
        const imp = await call("POST", `/api/projects/${noRefs}/specs`, { baseUrl: FIXTURE, validate: false, specs: [concrete("Written out")] });
        expect(imp.status).toBe(202);
        const exp = await call("GET", `/api/projects/${noRefs}/specs`);
        expect(Object.keys(exp.body)).toEqual(["specs"]);
        const zip = await server.inject({ method: "GET", url: `/api/projects/${noRefs}/download?includeUnvalidated=true` });
        expect(Object.keys(unzipSync(new Uint8Array(zip.rawPayload))).some((n) => n.includes("objects.json"))).toBe(false);
        const withRefs = await server.inject({ method: "GET", url: `/api/projects/${pid}/download?includeUnvalidated=true` });
        const files = unzipSync(new Uint8Array(withRefs.rawPayload));
        expect(JSON.parse(strFromU8(files["objects.json"]!)).elements.map((e: any) => e.name).sort()).toEqual([NAMES.add, NAMES.status].sort());
        expect(JSON.parse(strFromU8(files[Object.keys(files).find((n) => n.startsWith("specs/"))!]!)).steps.some((s: any) => s.locator?.ref)).toBe(true);
    });
});

describe("object repository: extract and share", () => {
    const wishlist = { by: "role", role: "button", value: "Add to wishlist", exact: true };
    const wish = (title: string) => spec(title, [{ action: "navigate", url: "/" }, { action: "click", locator: wishlist }, { action: "assert", check: "visible", locator: wishlist }]);
    let wishKey = "";
    const extract = (body: unknown) => call("POST", `${objectsUrl()}/extract`, body);

    it("a preview proposes named elements for locators used in two places and changes nothing", async () => {
        const imp = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: FIXTURE, validate: false, specs: [wish("Wish one"), wish("Wish two"), spec("Once only", [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "css", value: "#wish" } }])] });
        expect(imp.status).toBe(202);
        ["T4", "T5", "T6"].forEach((k, i) => (ids[k] = imp.body.tests[i].id));
        const specsBefore = [await test_("T4"), await test_("T5")].map((t) => JSON.stringify(t.spec));
        const countBefore = (await call("GET", objectsUrl())).body.total;

        for (const body of [{}, { dryRun: true }]) {
            const dry = await extract(body);
            expect(dry.status, JSON.stringify(dry.body)).toBe(200);
            expect(dry.body.dryRun).toBe(true);
            const w = dry.body.proposals.find((x: any) => x.locator.value === "Add to wishlist");
            expect(w).toMatchObject({ name: "Home / Add to wishlist button", kind: "web", page: "Home", uses: 4, testCount: 2, existing: null, description: 'Button "Add to wishlist"' });
            expect(w.tests.map((t: any) => t.title).sort()).toEqual(["Wish one", "Wish two"]);
            wishKey = w.key;
            // the locator used once is not proposed
            expect(dry.body.proposals.some((x: any) => x.locator.value === "#wish")).toBe(false);
        }
        expect((await call("GET", objectsUrl())).body.total).toBe(countBefore);
        expect([await test_("T4"), await test_("T5")].map((t) => JSON.stringify(t.spec))).toEqual(specsBefore);
    }, 120_000);

    it("never rewrites anything unless the person says which proposals to apply", async () => {
        const r = await extract({ dryRun: false });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/Choose which shared elements/);
        expect((await extract({ dryRun: false, apply: [{ key: "something-else" }] })).status).toBe(409);
        expect((await test_("T4")).spec.steps[1].locator).toEqual(wishlist);
    });

    it("applying creates the element, points those steps at it, and the scripts stay the same", async () => {
        const scriptsBefore = [await script("T4"), await script("T5")];
        const clash = await extract({ dryRun: false, apply: [{ key: wishKey, name: NAMES.status }] });
        expect(clash.status).toBe(409);
        const bad = await extract({ dryRun: false, apply: [{ key: wishKey, name: "no <good>" }] });
        expect(bad.status).toBe(400);
        const done = await extract({ dryRun: false, apply: [{ key: wishKey, name: "Shop / Wishlist button" }] });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        expect(done.body).toMatchObject({ dryRun: false, reused: 0, tests: 2, steps: 4, skipped: [] });
        expect(done.body.created).toHaveLength(1);
        expect(done.body.created[0]).toMatchObject({ name: "Shop / Wishlist button", locator: wishlist, usedBy: { count: 2 } });
        els.wish = done.body.created[0].id;
        for (const k of ["T4", "T5"]) {
            const t = await test_(k);
            expect(t.spec.steps[1].locator).toEqual({ ref: "Shop / Wishlist button" });
            expect(t.spec.steps[2].locator).toEqual({ ref: "Shop / Wishlist button" });
        }
        expect(await script("T4")).toBe(scriptsBefore[0]);
        expect(await script("T5")).toBe(scriptsBefore[1]);
        expect((await test_("T6")).spec.steps[1].locator).toEqual({ by: "css", value: "#wish" });
        expect((await element("wish")).usedBy).toMatchObject({ count: 2, steps: 4 });
        // and the tests still pass, now through the element
        setMode("original");
        const job = await revalidate("T4", "T5");
        expect(job.status).toBe("COMPLETED");
        for (const k of ["T4", "T5"]) expect((await test_(k)).validationStatus, k).toBe("VALIDATED");
        expect((await extract({})).body.proposals.some((x: any) => x.locator.value === "Add to wishlist")).toBe(false);
    }, 240_000);

    it("a locator that an element already has is pointed at, not duplicated", async () => {
        const all = await extract({ minUses: 1 });
        const existing = all.body.proposals.find((x: any) => x.existing === NAMES.status);
        expect(existing).toBeTruthy();
        expect(existing.locator).toEqual(statusBox);
        const count = (await call("GET", objectsUrl())).body.total;
        const done = await extract({ dryRun: false, apply: [{ key: existing.key }] });
        expect(done.body).toMatchObject({ reused: 1, created: [] });
        expect((await call("GET", objectsUrl())).body.total).toBe(count);
        expect(JSON.stringify((await test_("T3")).spec)).toContain(`"ref":"${NAMES.status}"`);
    });

    it("\"Make shared\" on one step creates (or reuses) an element for that step only, or everywhere on request", async () => {
        const t6 = ids.T6!;
        const only = await call("POST", `/api/tests/${t6}/steps/1/share`, { name: "Shop / Wish area" });
        expect(only.status, JSON.stringify(only.body)).toBe(201);
        expect(only.body).toMatchObject({ steps: 1, tests: 1, element: { name: "Shop / Wish area", locator: { by: "css", value: "#wish" }, usedBy: { count: 1 } } });
        expect((await test_("T6")).spec.steps[1].locator).toEqual({ ref: "Shop / Wish area" });
        expect((await call("POST", `/api/tests/${t6}/steps/1/share`, { name: "Again" })).status).toBe(409); // already shared
        expect((await call("POST", `/api/tests/${t6}/steps/0/share`, {})).status).toBe(409); // a navigate step has no element
        expect((await call("POST", `/api/tests/${t6}/steps/9/share`, {})).status).toBe(404);
        expect((await call("POST", `/api/tests/nope/steps/1/share`, {})).status).toBe(404);
        const none = await call("POST", `/api/tests/${ids.T3}/steps/0/share`, {});
        expect(none.status).toBe(409);
    });
});

describe("object repository: projects are apart, and the API key protects everything", () => {
    it("an element of another project cannot be read, changed or deleted, and a spec cannot refer to it", async () => {
        const stranger = (await call("POST", "/api/projects", { name: "Stranger" })).body.id;
        for (const [m, body] of [["GET", undefined], ["PUT", { notes: "x" }], ["DELETE", undefined]] as const) {
            expect((await call(m, `${objectsUrl(stranger)}/${els.add}`, body)).status, m).toBe(404);
        }
        expect((await call("GET", objectsUrl(stranger))).body.elements).toEqual([]);
        // the same name can be used in the other project; it is a different element there
        const same = await call("POST", objectsUrl(stranger), { name: NAMES.add, kind: "web", locator: { by: "css", value: "#stranger" } });
        expect(same.status).toBe(201);
        const r = await call("POST", `/api/projects/${stranger}/specs`, { baseUrl: FIXTURE, validate: false, specs: [spec("Uses it", [{ action: "click", locator: { ref: NAMES.status } }])] });
        expect(r.status).toBe(400); // the status element belongs to the first project
        expect((await element("add")).locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
        // sharing a step of one project's test never touches another project's elements
        expect((await call("GET", `${objectsUrl()}?test=${ids.T1}`)).body.elements.map((e: any) => e.id)).toContain(els.add);
    });

    it("every route needs the key when the server has one", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-locators-key-"));
        const keyed = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY: "locators-key" }));
        const srv = await buildServer(keyed);
        try {
            const withKey = { "x-api-key": "locators-key" };
            const project = JSON.parse((await srv.inject({ method: "POST", url: "/api/projects", headers: withKey, payload: { name: "Keyed" } })).body).id as string;
            const created = JSON.parse((await srv.inject({ method: "POST", url: `/api/projects/${project}/objects`, headers: withKey, payload: { name: "A", kind: "web", locator: { by: "css", value: "a" } } })).body);
            const routes: Array<[Method, string, unknown]> = [
                ["GET", `/api/projects/${project}/objects`, undefined],
                ["POST", `/api/projects/${project}/objects`, { name: "B", kind: "web", locator: { by: "css", value: "b" } }],
                ["GET", `/api/projects/${project}/objects/export`, undefined],
                ["POST", `/api/projects/${project}/objects/import`, { elements: [] }],
                ["POST", `/api/projects/${project}/objects/extract`, {}],
                ["GET", `/api/projects/${project}/objects/${created.id}`, undefined],
                ["PUT", `/api/projects/${project}/objects/${created.id}`, { notes: "n" }],
                ["DELETE", `/api/projects/${project}/objects/${created.id}`, undefined],
                ["POST", `/api/tests/anything/steps/0/share`, {}],
            ];
            for (const [method, url, payload] of routes) {
                const denied = await srv.inject({ method, url, payload: payload as never });
                expect(denied.statusCode, `${method} ${url}`).toBe(401);
                const wrong = await srv.inject({ method, url, headers: { "x-api-key": "wrong" }, payload: payload as never });
                expect(wrong.statusCode, `${method} ${url}`).toBe(401);
            }
            expect((await srv.inject({ method: "GET", url: `/api/projects/${project}/objects`, headers: withKey })).statusCode).toBe(200);
        } finally {
            await srv.close();
            keyed.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
