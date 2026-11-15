/**
 * Test-selection preview against a real platform (no browser, no worker, no AI): coverage read from stored tests and stored run
 * evidence, the preview's buckets and reasons, project isolation, malformed specs, and deploy triggers still running every runnable test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runnableTestIds } from "../src/platform/scheduler.js";
import { buildServer } from "../src/platform/server.js";

const API_KEY = "test-api-key-0123456789";
const APP = "http://127.0.0.1:9651";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let projectA: string;
let projectB: string;
const ids: Record<string, string> = {};

type Method = "GET" | "POST";
const send = async (method: Method, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": API_KEY }) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};

const web = (title: string, steps: unknown[]) => ({ title, kind: "web", category: "Functional", steps: [...steps, { action: "assert", check: "visible", locator: { by: "text", value: "Orders" } }] });
const api = (title: string, steps: unknown[]) => ({ title, kind: "api", category: "API", steps: [...steps, { action: "assertResponse", check: "status", expected: 200 }] });

async function importSpecs(projectId: string, specs: unknown[]) {
    const res = await send("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return platform.repo.listTests(projectId);
}

type Req = { method: string; type: string; path: string; host?: string };
/** A start time `days` days before now (at `minute` past midnight UTC), so recorded runs stay inside the freshness window whenever the test runs. */
const ago = (days: number, minute = 600): string => {
    const d = new Date(Date.now() - days * 86_400_000);
    d.setUTCHours(0, minute, 0, 0);
    return d.toISOString();
};
/** The footprint the evidence helper writes for these requests (pages from documents and routes, endpoints from the rest). */
const footprintOf = (requests: Req[], extra: Record<string, unknown> = {}) => ({
    pages: requests.filter((r) => r.type === "document" || r.type === "route").map((r) => ({ path: `${r.host ?? ""}${r.path.split("?")[0]}`, step: 1 })),
    endpoints: requests.filter((r) => r.type !== "document" && r.type !== "route").map((r) => ({ method: r.method, path: r.path.split("?")[0], ...(r.host ? { host: r.host } : {}), step: 1, n: 1, statuses: [200] })),
    ...extra,
});
/**
 * A run of the test's script with stored evidence. `record`: "footprint" as a passing run leaves it, "full" as a failed run (or a run with
 * evidence on) leaves it (with its footprint), "legacy" as runs made before the footprint left it (full evidence, no footprint).
 */
async function storeRun(testId: string, scriptId: string, status: string, startedAt: string, requests: Req[], record: "footprint" | "full" | "legacy" = "full", fpExtra: Record<string, unknown> = {}) {
    const execId = platform.repo.addExecution({ testId, scriptId, jobId: null, attempt: 1, status, durationMs: 1000, startedAt, steps: [] });
    // As a finished run records it (review-store.ts finishRun): the version it ran, the latest approved one.
    platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", testId, execId);
    const real = requests.filter((r) => r.type !== "route");
    const evidence = {
        v: 1,
        durationMs: 1000,
        counts: { requests: real.length, requestsKept: record === "footprint" ? 0 : real.length, console: 0, consoleKept: 0 },
        steps: [],
        requests: record === "footprint" ? [] : real.map((r, i) => ({ t: i, step: 1, status: 200, ...r })),
        console: [],
        ...(record === "legacy" ? {} : { footprint: footprintOf(requests, fpExtra) }),
    };
    const key = `${projectA}/_artifacts/sel/${execId}/evidence.json`;
    const body = JSON.stringify(evidence);
    await platform.store.put(key, body);
    platform.repo.addArtifact({ projectId: projectA, testId, executionId: execId, kind: "evidence", path: key, size: body.length });
}

/** A finished run of a test with no stored record (as an API test's run leaves it), on the latest approved version. */
function recordRun(testId: string, status: string, startedAt: string): string {
    const scriptId = (platform.repo.getCurrentScript(testId) as { id: string } | undefined)?.id ?? null;
    const execId = platform.repo.addExecution({ testId, scriptId, jobId: null, attempt: 1, status, durationMs: 500, startedAt, steps: [] });
    platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", testId, execId);
    return execId;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-selection-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
    server = await buildServer(platform);
    projectA = (await send("POST", "/api/projects", { name: "Shop" })).body.id;
    projectB = (await send("POST", "/api/projects", { name: "Other shop" })).body.id;
    const a = await importSpecs(projectA, [
        { ...api("Create an order", [{ action: "request", method: "POST", path: "/orders/{{orderId}}", query: { dry: "1" } }]), testData: { orderId: "41" } },
        api("Health answers", [{ action: "request", method: "GET", path: "/health" }]),
        web("Order page shows the order", [{ action: "navigate", url: "/orders/42?tab=details" }]),
        web("Checkout from the home page", [{ action: "navigate", url: "/" }]),
        web("Cart opens", [{ action: "navigate", url: "/app#/cart/7" }]),
        api("Broken one", [{ action: "request", method: "GET", path: "/broken" }]),
    ]);
    for (const t of a) ids[t.title] = t.id;
    const b = await importSpecs(projectB, [web("Other order page", [{ action: "navigate", url: "/orders/1" }]), api("Other create order", [{ action: "request", method: "POST", path: "/orders/9" }])]);
    for (const t of b) ids[`B:${t.title}`] = t.id;

    // API tests count as covered only with a fresh passing run of their current version: both passed yesterday.
    recordRun(ids["Create an order"]!, "passed", ago(1));
    recordRun(ids["Health answers"]!, "passed", ago(1));

    // Observed coverage: a passing run of the current script of "Checkout from the home page" kept every request it made.
    const checkout = ids["Checkout from the home page"]!;
    const current = platform.repo.getCurrentScript(checkout) as { id: string };
    await storeRun(
        checkout,
        current.id,
        "passed",
        ago(2),
        [
            { method: "GET", type: "document", path: "/checkout" },
            { method: "POST", type: "fetch", path: "/orders/5?coupon=[hidden]" },
            { method: "GET", type: "xhr", path: "/collect", host: "analytics.example.test" },
        ],
        "footprint",
    );
    // A run of an older script of "Cart opens" (its current script is another one): what it did no longer counts.
    const cart = ids["Cart opens"]!;
    const old = platform.repo.addScript(cart, { framework: "playwright", filename: "old.spec.ts", content: "// old", hash: "old", storagePath: "old.spec.ts", executable: true, current: false });
    await storeRun(cart, old, "failed", ago(3), [{ method: "DELETE", type: "fetch", path: "/orders/5" }]);
    // A test whose stored steps cannot be read.
    platform.db.run("UPDATE test_cases SET spec_json = ? WHERE id = ?", "{not json", ids["Broken one"]!);
}, 60_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("test coverage", () => {
    it("lists declared and observed pages and endpoints per test, and says what is unknown", async () => {
        const res = await send("GET", `/api/projects/${projectA}/test-coverage`);
        expect(res.status).toBe(200);
        const byTitle = Object.fromEntries((res.body.tests as Array<{ title: string }>).map((t) => [t.title, t])) as Record<string, any>;
        expect(byTitle["Create an order"]).toMatchObject({ completeness: "declared-complete", items: [{ kind: "endpoint", method: "POST", path: "/orders/{}", query: ["dry"], source: "declared" }] });
        expect(byTitle["Order page shows the order"]).toMatchObject({ completeness: "partial", items: [{ kind: "page", path: "/orders/{}", query: ["tab"], source: "declared" }] });
        const checkout = byTitle["Checkout from the home page"];
        // Its run called another site (analytics) and the project has no API address set, so whether that site is the
        // application's own API is not known: the complete record does not make the test complete.
        expect(checkout.completeness).toBe("partial");
        expect(checkout.limits[0]).toBe("A run called endpoints on another site, and the application's API address is not set, so whether they are the application's own API is not known.");
        expect(checkout.items.map((i: any) => `${i.source} ${i.method ?? "page"} ${i.host ? `//${i.host}` : ""}${i.path}${i.external ? " external" : ""}`)).toEqual([
            "observed POST /orders/{}",
            "observed GET //analytics.example.test/collect external",
            "declared page /",
            "observed page /checkout",
        ]);
        // The older script's run is not used.
        expect(JSON.stringify(byTitle["Cart opens"].items)).not.toContain("DELETE");
        expect(byTitle["Cart opens"].items).toEqual([{ kind: "page", path: "/app#/cart/{}", query: [], source: "declared", seenIn: ["step 1"] }]);
        expect(byTitle["Broken one"]).toMatchObject({ completeness: "unknown", items: [], limits: ["The test's stored steps could not be read."] });
    });

    it("keeps each project's tests to itself (10)", async () => {
        const a = (await send("GET", `/api/projects/${projectA}/test-coverage`)).body.tests as Array<{ testId: string }>;
        const b = (await send("GET", `/api/projects/${projectB}/test-coverage`)).body.tests as Array<{ testId: string }>;
        expect(a.map((t) => t.testId)).not.toContain(ids["B:Other order page"]);
        expect(b.map((t) => t.testId).sort()).toEqual([ids["B:Other create order"], ids["B:Other order page"]].sort());
        expect((await send("GET", "/api/projects/nope/test-coverage")).status).toBe(404);
    });
});

describe("selection preview", () => {
    it("proposes matched tests with reasons and sources, proposes unknown ones, and runs or skips nothing", async () => {
        const jobsBefore = platform.db.all("SELECT id FROM generation_jobs").length;
        const res = await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["POST /orders/{id}"], pages: ["/legal"] });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const p = res.body;
        expect(p.recommendationOnly).toBe(true);
        expect(p.note).toMatch(/No test was skipped or run/);
        expect(p.matched.map((t: any) => t.title)).toEqual(["Create an order", "Checkout from the home page"]);
        expect(p.matched.find((t: any) => t.title === "Create an order").reasons[0]).toMatchObject({ source: "declared", matched: "POST /orders/{}" });
        expect(p.matched.find((t: any) => t.title === "Checkout from the home page").reasons[0]).toMatchObject({ source: "observed", seenIn: [`run of ${ago(2).slice(0, 10)}`] });
        // The web tests whose coverage is partial are proposed anyway; only the complete API test is not matched.
        expect(p.unknown.map((t: any) => t.title).sort()).toEqual(["Cart opens", "Order page shows the order"]);
        expect(p.notMatched.map((t: any) => t.title)).toEqual(["Health answers"]);
        expect(p.notMatched[0].why).toMatch(/^Not proposed: what it touches is fully known from its steps/);
        // The test whose steps cannot be read is not hidden: it is listed as "Cannot run", with why.
        expect(p.cannotRun.map((t: any) => [t.title, t.why])).toEqual([["Broken one", "Cannot run: its stored steps cannot be read. Open it to fix or delete it."]]);
        expect(p.uncoveredChanges).toEqual(["/legal"]);
        expect(p.counts).toMatchObject({ tests: 6, matched: 2, unknown: 2, proposed: 4, notMatched: 1, cannotRun: 1 });
        // Three tests' coverage is not fully known: the preview says a full run is required. "Cart opens" is out of date: its latest run
        // (of an older script) failed; "Order page shows the order" never ran; "Checkout from the home page" (matched) called another
        // site while no API address is set.
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons).toEqual([
            "1 test's recorded coverage is out of date (the latest run did not pass, ran an older version, is older than the freshness window, or ran before a shared part it uses changed), so what it touches now is not known.",
            "1 test's recorded runs called endpoints on another site (analytics, or the application's own API at another address), and the application's API address is not set, so whether a change to an endpoint reaches it is not known. Set the API address in the application's settings to tell them apart.",
            "What 2 tests touch is not fully known, so the preview cannot rule out that they reach the change.",
        ]);
        expect(p.unknown.find((t: any) => t.title === "Cart opens").why).toBe(`Proposed because its recorded coverage is out of date: its latest run (${ago(3).slice(0, 10)}) failed, so earlier passing runs no longer show what it touches.`);
        expect(p.triggers).toEqual([]);
        expect(p.freshDays).toBe(14);
        // Another project's test that calls the same endpoint is not part of it.
        expect(JSON.stringify(p)).not.toContain(ids["B:Other create order"]);
        // Nothing was started.
        expect(platform.db.all("SELECT id FROM generation_jobs").length).toBe(jobsBefore);
    });

    it("refuses an empty change set and reports entries it could not read", async () => {
        expect((await send("POST", `/api/projects/${projectA}/selection-preview`, {})).status).toBe(400);
        expect((await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["FETCH /x"] })).status).toBe(400);
        const res = await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["FETCH /x", "GET /health"] });
        expect(res.body.ignored).toEqual([{ given: "FETCH /x", why: expect.stringMatching(/^Not an endpoint/) }]);
        expect(res.body.matched.map((t: any) => t.title)).toEqual(["Health answers"]);
        expect((await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["GET /a"], extra: 1 })).status).toBe(400);
    });

    it("offers the changes the platform detected, and says so plainly when there are none yet", async () => {
        const res = await send("GET", `/api/projects/${projectA}/selection-preview/detected-changes`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ pages: [], endpoints: [], sources: [] });
        expect(res.body.message).toMatch(/No change has been detected yet/);
    });
});

describe("selection preview corrections", () => {
    it("reads the API host from the application's settings and matches a change that names it (6)", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectA)!;
        const before = platform.db.get<{ c: string }>("SELECT config_json AS c FROM applications WHERE id = ?", app.id)!.c;
        platform.db.run("UPDATE applications SET config_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(before), apiBaseUrl: "https://api.shop.test/v1" }), app.id);
        try {
            const res = await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["POST https://API.shop.test/v1/orders/{id}"] });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.matched.map((t: any) => t.title)).toEqual(["Create an order", "Checkout from the home page"]);
            const other = await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["POST https://elsewhere.test/orders/{id}"] });
            expect(other.body.matched).toEqual([]);
            expect(other.body.uncoveredChanges).toEqual(["POST //elsewhere.test/orders/{} (external)"]);
        } finally {
            platform.db.run("UPDATE applications SET config_json = ? WHERE id = ?", before, app.id);
        }
    });

    it("treats an older record without a footprint, a cut footprint and unclassified traffic as incomplete; a complete footprint keeps routes (2, 3)", async () => {
        const [t] = await importSpecs(projectA, [web("Spa orders", [{ action: "navigate", url: "/spa" }])]).then((all) => all.filter((x) => x.title === "Spa orders"));
        const script = (platform.repo.getCurrentScript(t!.id) as { id: string }).id;
        const coverage = async () => ((await send("GET", `/api/projects/${projectA}/test-coverage`)).body.tests as any[]).find((x) => x.title === "Spa orders");
        await storeRun(t!.id, script, "passed", ago(1, 600), [{ method: "GET", type: "document", path: "/spa" }], "legacy");
        expect((await coverage()).completeness).toBe("partial");
        await storeRun(t!.id, script, "passed", ago(1, 660), [{ method: "GET", type: "document", path: "/spa" }], "footprint", { truncated: true });
        expect((await coverage()).completeness).toBe("partial");
        await storeRun(t!.id, script, "passed", ago(1, 720), [{ method: "GET", type: "document", path: "/spa" }], "footprint", { unclassified: 3 });
        expect((await coverage()).limits.join(" ")).toMatch(/3 requests the mapping could not classify/);
        // Now a complete footprint with a route reached inside the page and a form sent to the server.
        await storeRun(t!.id, script, "passed", ago(1, 780), [{ method: "GET", type: "document", path: "/spa" }, { method: "GET", type: "route", path: "/spa#/orders/7" }]);
        const c = await coverage();
        expect(c.completeness).toBe("observed-complete");
        const res = await send("POST", `/api/projects/${projectA}/selection-preview`, { pages: ["/spa#/orders/{id}"] });
        expect(res.body.matched.map((x: any) => x.title)).toEqual(["Spa orders"]);
    });

    it("lists entries past the limit instead of dropping them, and requires a full run (5)", async () => {
        const pages = Array.from({ length: 150 }, (_, i) => `/p${i}`);
        const endpoints = [...Array.from({ length: 60 }, (_, i) => `GET /e${i}`), "GET /health"];
        const res = await send("POST", `/api/projects/${projectA}/selection-preview`, { pages, endpoints });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.notProcessed).toHaveLength(11);
        expect(res.body.notProcessed).toContain("GET /health");
        expect(res.body.fullRunRequired).toBe(true);
        expect(res.body.fullRunReasons[0]).toMatch(/^The change names 211 pages and endpoints; the preview compares at most 200, so 11 were not compared with any test\.$/);
        // The test that calls the dropped entry is not "not matched": no test is, while the change list was not read in full.
        expect(res.body.notMatched).toEqual([]);
        expect(res.body.unknown.find((t: any) => t.title === "Health answers").why).toMatch(/^Proposed because the change list was not read in full/);
    });
});

describe("deploy triggers are unchanged (13)", () => {
    it("still run every runnable test of the project, whatever the coverage says", async () => {
        // A test whose stored steps cannot be read makes the trigger itself fail today (repo.listTests parses every spec): a
        // limitation of the existing path, left as it is. Give it readable steps again for this check.
        platform.db.run("UPDATE test_cases SET spec_json = (SELECT spec_json FROM test_cases WHERE id = ?) WHERE id = ?", ids["Health answers"]!, ids["Broken one"]!);
        const token = (await send("POST", `/api/projects/${projectA}/triggers`, { label: "CI" })).body.token as string;
        const run = await send("POST", `/api/triggers/${token}/run`, { commit: "abc1234" }, {});
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        const job = platform.repo.getJob(run.body.jobId)!;
        const expected = await runnableTestIds(platform.repo, projectA, "validate", null);
        expect([...(job.options.testIds ?? [])].sort()).toEqual([...expected].sort());
        expect(run.body.testCount).toBe(expected.length);
        // The not-matched test is in the run too: the preview chooses nothing.
        expect(job.options.testIds).toContain(ids["Health answers"]);
    });
});

describe("selection preview: freshness and deploy trigger parity", () => {
    const coverageOf = async (title: string) => ((await send("GET", `/api/projects/${projectA}/test-coverage`)).body.tests as any[]).find((x) => x.title === title);
    /** As an approval would leave it: the latest version is the approved one, older approvals superseded. */
    const approveLatest = (testId: string) => {
        const v = platform.db.get<{ id: string }>("SELECT id FROM test_versions WHERE test_case_id = ? ORDER BY version DESC LIMIT 1", testId)!;
        platform.db.run("UPDATE test_versions SET state = 'superseded' WHERE test_case_id = ? AND id <> ? AND state = 'approved'", testId, v.id);
        platform.db.run("UPDATE test_versions SET state = 'approved' WHERE id = ?", v.id);
    };

    it("1. counts only the latest run on the deploy target: a newer version without a run, a cancelled run or an old run make it stale", async () => {
        const [t] = (await importSpecs(projectA, [web("Fresh check", [{ action: "navigate", url: "/fresh" }])])).filter((x) => x.title === "Fresh check");
        const script = (platform.repo.getCurrentScript(t!.id) as { id: string }).id;
        await storeRun(t!.id, script, "passed", ago(1), [{ method: "GET", type: "document", path: "/fresh" }], "footprint");
        expect(await coverageOf("Fresh check")).toMatchObject({ completeness: "observed-complete" });
        // A run of a browser variant is not the deploy target: a newer failed one changes nothing.
        await storeRun(t!.id, script, "failed", ago(0, 1), [], "footprint");
        platform.db.run("UPDATE test_executions SET variant = 'firefox' WHERE test_case_id = ? AND status = 'failed'", t!.id);
        expect(await coverageOf("Fresh check")).toMatchObject({ completeness: "observed-complete" });

        // A new approved version with other steps: stale until it runs, and its declared steps are the new version's.
        const spec = platform.repo.getTest(t!.id)!.spec as { steps: unknown[] };
        platform.repo.updateTest(t!.id, { spec: { ...spec, steps: [{ action: "navigate", url: "/fresh-v2" }, ...spec.steps.slice(1)] } as never });
        approveLatest(t!.id);
        const version = platform.db.get<{ version: number }>("SELECT version FROM test_versions WHERE test_case_id = ? AND state = 'approved'", t!.id)!.version;
        const changed = await coverageOf("Fresh check");
        expect(changed.completeness).toBe("partial");
        expect(changed.stale).toBe(`It changed after its latest run (${ago(1).slice(0, 10)}): version ${version} has not run yet.`);
        expect(changed.items.filter((i: any) => i.source === "declared").map((i: any) => i.path)).toEqual(["/fresh-v2"]);
        const p = (await send("POST", `/api/projects/${projectA}/selection-preview`, { pages: ["/elsewhere"] })).body;
        expect(p.unknown.find((x: any) => x.title === "Fresh check").why).toBe(`Proposed because its recorded coverage is out of date: it changed after its latest run (${ago(1).slice(0, 10)}): version ${version} has not run yet.`);
        expect(p.fullRunReasons[0]).toMatch(/recorded coverage is out of date/);

        // The new version runs and passes: complete again. Then a cancelled run: stale.
        await storeRun(t!.id, script, "passed", ago(0, 2), [{ method: "GET", type: "document", path: "/fresh-v2" }], "footprint");
        expect(await coverageOf("Fresh check")).toMatchObject({ completeness: "observed-complete" });
        await storeRun(t!.id, script, "cancelled", ago(0, 3), [], "footprint");
        expect((await coverageOf("Fresh check")).stale).toBe(`Its latest run (${ago(0).slice(0, 10)}) was cancelled, so earlier passing runs no longer show what it touches.`);

        // A passing run older than the window (SELECTION_FRESH_DAYS, default 14) is stale; a wider window accepts it.
        const [o] = (await importSpecs(projectA, [web("Old check", [{ action: "navigate", url: "/old" }])])).filter((x) => x.title === "Old check");
        await storeRun(o!.id, (platform.repo.getCurrentScript(o!.id) as { id: string }).id, "passed", ago(20), [{ method: "GET", type: "document", path: "/old" }], "footprint");
        expect((await coverageOf("Old check")).stale).toBe(`Its latest run (${ago(20).slice(0, 10)}) is older than 14 days, so it may no longer show what the test touches.`);
        const before = process.env.SELECTION_FRESH_DAYS;
        process.env.SELECTION_FRESH_DAYS = "30";
        try {
            expect(await coverageOf("Old check")).toMatchObject({ completeness: "observed-complete" });
            expect((await send("POST", `/api/projects/${projectA}/selection-preview`, { pages: ["/old"] })).body.freshDays).toBe(30);
        } finally {
            if (before === undefined) delete process.env.SELECTION_FRESH_DAYS;
            else process.env.SELECTION_FRESH_DAYS = before;
        }
    });

    it("5. lists a test with no approved version as Cannot run, without requiring a full run for it", async () => {
        const [w] = (await importSpecs(projectA, [api("Waiting one", [{ action: "request", method: "GET", path: "/waiting" }])])).filter((x) => x.title === "Waiting one");
        platform.db.run("UPDATE test_versions SET state = 'in_review' WHERE test_case_id = ?", w!.id);
        const p = (await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["GET /waiting"] })).body;
        expect(p.cannotRun.find((x: any) => x.title === "Waiting one").why).toBe("Cannot run: it has no approved version yet, and runs leave it out until one is approved.");
        expect(p.matched.map((x: any) => x.title)).not.toContain("Waiting one");
        expect(p.fullRunReasons.join(" ")).not.toMatch(/cannot run on your runner/);
    });

    it("2. compares each active deploy trigger's runner with the viewer's, and requires a full run when one cannot be resolved", async () => {
        // The "CI" token made with the access key above runs the same tests as the access key's viewer.
        const same = (await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["GET /health"] })).body;
        expect(same.triggers).toEqual([{ trigger: expect.stringMatching(/^“CI” \(…\w{4}\)$/), parity: "same" }]);
        expect(same.fullRunReasons.join(" ")).not.toMatch(/deploy trigger/);
        // An older token without a maker, a token whose maker has no active account, and a revoked one (ignored). Same time: by id.
        const now = new Date().toISOString();
        const add = (id: string, label: string | null, createdBy: string | null, revoked: string | null = null) =>
            platform.db.run("INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, allow_url, created_at, created_by, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)", id, projectA, label, `hash-${id}`, id.slice(-4), 0, now, createdBy, revoked);
        add("tok-old1", "Legacy", null);
        add("tok-gone", null, "no-such-person");
        add("tok-rev1", "Revoked", null, now);
        const p = (await send("POST", `/api/projects/${projectA}/selection-preview`, { endpoints: ["GET /health"] })).body;
        expect(p.triggers.map((t: any) => [t.trigger, t.parity])).toEqual([
            [expect.stringMatching(/^“CI”/), "same"],
            ["…gone", "unresolved"],
            ["“Legacy” (…old1)", "unresolved"],
        ]);
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons).toContain("The deploy trigger “Legacy” (…old1) cannot be compared with your runner: it was made before deploy triggers recorded who made them, so whose runner it uses is not known.");
        expect(p.fullRunReasons).toContain("The deploy trigger …gone cannot be compared with your runner: the person who made it no longer has an active account, so whose runner it uses is not known.");
        platform.db.run("DELETE FROM trigger_tokens WHERE id IN ('tok-old1', 'tok-gone', 'tok-rev1')");
    });
});
