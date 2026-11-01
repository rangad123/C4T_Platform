/**
 * Locator healing end to end, with real work: a fixture shop whose button is renamed between the spec's recording and the run,
 * the real worker running the specs under Playwright, the real API. No model is configured (and none is used).
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/healing.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startHealingApp, type ShopMode } from "./fixtures/healing-app.js";

const FIXTURE_PORT = 5530;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let shop: http.Server;
let setMode: (m: ShopMode) => void;
let projectId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-healing-"));
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

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
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
/** Re-validate these tests in one job (the same job the "Run again" button starts, for several tests). */
async function revalidate(...keys: string[]) {
    const app = platform.repo.getLatestApplicationPublic(projectId)!;
    const job = await platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: keys.map((k) => ids[k]!) });
    return waitJob(job.id);
}
const test_ = async (key: string) => (await call("GET", `/api/tests/${ids[key]}`)).body;
const proposals = async (key: string) => (await call("GET", `/api/tests/${ids[key]}/healing`)).body.proposals as any[];
const stepLocator = async (key: string, step: number) => (await test_(key)).spec.steps[step].locator;

const addButton = { by: "role", role: "button", value: "Add to cart", exact: true };
const cartAssert = { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Cart: 1 item" };
const spec = (title: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({ title, kind: "web", category: "Shop", steps, ...extra });
const addToCart = (title: string, extra: Record<string, unknown> = {}) => spec(title, [{ action: "navigate", url: "/" }, { action: "click", locator: addButton }, cartAssert], extra);

describe("locator healing", () => {
    it("records the shop while its button is still called “Add to cart”: every test passes", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Shop that changes" })).body.id;
        // This file is about applying a fix and seeing it run: with the default policy a fix is a draft and waits for approval (tests/reviews-api.test.ts).
        await call("PUT", `/api/projects/${projectId}/review-policy`, { healing: false });
        const imp = await call("POST", `/api/projects/${projectId}/specs`, {
            baseUrl: FIXTURE,
            specs: [
                addToCart("Add an item to the cart"), // T1: heals and is applied
                spec("The add button is shown", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: addButton }]), // T2: assertion about a control
                addToCart("Add an item (edited later)"), // T3: goes stale
                spec("The welcome heading is shown", [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Welcome back" } }]), // T4: a claim, never healed
                addToCart("Add an item (button later duplicated)"), // T5: ambiguous
                addToCart("Add an item (cart later broken)"), // T6: a real defect
                addToCart("Built-in check that clicks", { source: { origin: "health-check" } }), // T7: a check family, never healed
            ],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        for (const t of imp.body.tests as Array<{ id: string; testId: string }>) ids[`T${Object.keys(ids).length + 1}`] = t.id;
        const job = await waitJob(imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        for (const k of Object.keys(ids)) expect((await test_(k)).validationStatus, k).toBe("VALIDATED");
    }, 180_000);

    it("a renamed button gets one proposal with a plain-language reason and nothing is changed", async () => {
        setMode("renamed");
        await revalidate("T1", "T2", "T3", "T4", "T7");
        const t1 = await test_("T1");
        expect(t1.validationStatus).toBe("FAILED_VALIDATION");
        // the failure is real: the run's own error says the element was never found
        expect(t1.executions[0].steps.find((s: any) => s.status === "failed").error).toMatch(/waiting for getByRole/);

        const [p] = await proposals("T1");
        expect(await proposals("T1")).toHaveLength(1);
        expect(p).toMatchObject({
            stepIndex: 1,
            status: "proposed",
            canApply: true,
            oldLocator: addButton,
            newLocator: { by: "role", role: "button", value: "Add to basket", exact: true },
            oldDescription: "the “Add to cart” button",
            newDescription: "the “Add to basket” button",
            confidenceLabel: "high",
        });
        expect(p.confidence).toBeGreaterThanOrEqual(0.9);
        expect(p.reason).toBe("The “Add to cart” button is no longer on the page. The only close match is the button “Add to basket”, which means the same thing.");
        // the "Add to wishlist" button next to it was not a candidate

        // never applied silently: the spec still looks for the old button
        expect(await stepLocator("T1", 1)).toEqual(addButton);
        expect(t1.scripts[0].content).toContain("Add to cart");
    }, 240_000);

    it("a missing control in an assertion about its state is healed too, because the check itself is unchanged", async () => {
        const [p] = await proposals("T2");
        expect(p).toMatchObject({ stepIndex: 1, status: "proposed", newLocator: { by: "role", role: "button", value: "Add to basket", exact: true } });
        expect((await test_("T2")).spec.steps[1]).toMatchObject({ action: "assert", check: "visible" });
    });

    it("never proposes for a claim about the page (a heading), nor for a built-in check family", async () => {
        expect((await test_("T4")).validationStatus).not.toBe("VALIDATED");
        expect(await proposals("T4")).toEqual([]);
        expect((await test_("T7")).validationStatus).not.toBe("VALIDATED");
        expect(await proposals("T7")).toEqual([]);
    });

    it("applying a proposal edits only that step's locator, re-renders the script and the re-run validates", async () => {
        const [p] = await proposals("T1");
        const before = (await test_("T1")).spec;
        const applied = await call("POST", `/api/tests/${ids.T1}/healing/${p.id}/apply`);
        expect(applied.status, JSON.stringify(applied.body)).toBe(202);
        expect(applied.body.proposal).toMatchObject({ status: "applied", canApply: false });
        const job = await waitJob(applied.body.jobId);
        expect(job.status).toBe("COMPLETED");

        const t1 = await test_("T1");
        expect(t1.validationStatus).toBe("VALIDATED");
        expect(t1.spec.steps[1].locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
        expect({ ...t1.spec, steps: t1.spec.steps.map((s: any, i: number) => (i === 1 ? { ...s, locator: addButton } : s)) }).toEqual(before);
        expect(t1.scripts[0].content).toContain("Add to basket");
        expect(t1.scripts[0].content).not.toContain("Add to cart");
        expect((await proposals("T1"))[0]).toMatchObject({ status: "applied", canApply: false });
        // a second apply is refused
        expect((await call("POST", `/api/tests/${ids.T1}/healing/${p.id}/apply`)).status).toBe(409);
    }, 240_000);

    it("refuses a stale proposal (the test changed since) and one for a test that now passes", async () => {
        const [p] = await proposals("T3");
        expect(p.canApply).toBe(true);
        const original = platform.repo.getTest(ids.T3!)!.spec;
        const edited = { ...original, steps: original.steps.map((s, i) => (i === 1 ? { ...s, locator: { by: "role", role: "button", value: "Buy now" } } : s)) } as typeof original;
        platform.repo.updateTest(ids.T3!, { spec: edited });
        const stale = await call("POST", `/api/tests/${ids.T3}/healing/${p.id}/apply`);
        expect(stale.status).toBe(409);
        expect(stale.body.error).toMatch(/changed since/);
        expect((await proposals("T3"))[0]).toMatchObject({ status: "proposed", canApply: false });
        expect((await test_("T3")).spec.steps[1].locator.value).toBe("Buy now");

        platform.repo.updateTest(ids.T3!, { spec: original, validationStatus: "VALIDATED" });
        const passing = await call("POST", `/api/tests/${ids.T3}/healing/${p.id}/apply`);
        expect(passing.status).toBe(409);
        expect(passing.body.error).toMatch(/did not pass/);
        expect((await test_("T3")).spec).toEqual(original);
        platform.repo.updateTest(ids.T3!, { validationStatus: "FAILED_VALIDATION" });
    });

    it("dismiss: the suggestion is closed, cannot be applied and is not made again by the next failing run", async () => {
        const [p] = await proposals("T2");
        const d = await call("POST", `/api/tests/${ids.T2}/healing/${p.id}/dismiss`);
        expect(d.status).toBe(200);
        expect(d.body).toMatchObject({ status: "dismissed", canApply: false });
        expect((await call("POST", `/api/tests/${ids.T2}/healing/${p.id}/apply`)).status).toBe(409);
        expect((await call("POST", `/api/tests/${ids.T2}/healing/${p.id}/dismiss`)).status).toBe(409);
        await revalidate("T2");
        const list = await proposals("T2");
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: p.id, status: "dismissed" });
        expect((await call("GET", `/api/tests/00000000-0000-0000-0000-000000000000/healing`)).status).toBe(404);
        expect((await call("POST", `/api/tests/${ids.T2}/healing/nope/apply`)).status).toBe(404);
    }, 240_000);

    it("two equally good replacements: no proposal (it would be guessing)", async () => {
        setMode("ambiguous");
        await revalidate("T5");
        const t5 = await test_("T5");
        expect(t5.validationStatus).toBe("FAILED_VALIDATION");
        expect(await proposals("T5")).toEqual([]);
        expect(await stepLocator("T5", 1)).toEqual(addButton);
    }, 240_000);

    it("a failing expectation is a result about the application: the button is found, the cart is wrong, nothing is proposed", async () => {
        setMode("broken");
        await revalidate("T6");
        const t6 = await test_("T6");
        expect(t6.validationStatus).not.toBe("VALIDATED");
        const failed = t6.executions[0].steps.find((s: any) => s.status === "failed");
        expect(failed.index).toBe(2);
        expect(failed.error).toMatch(/Cart: 0 items/);
        expect(await proposals("T6")).toEqual([]);
        expect(t6.spec.steps[2].expected).toBe("Cart: 1 item");
    }, 240_000);
});
