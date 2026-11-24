/**
 * Reproduction on bench-shop from a dirty start (Phase 5 V1, browser lock): a run of saved tests left two failed tests on the shared test
 * account, whose cart already holds what earlier tests put there. After the run, verifyAfterJob writes them as execution findings and runs
 * each 3 times through the real Playwright runner, each attempt in a fresh browser as an account it registers first, with no video:
 *  - the seed (BS-02: the cart's last line is counted once, whatever its quantity) fails the same check 3 of 3: Reproduced, then Confirmed at high confidence;
 *  - the state-bound test (it expects one line's total, and failed only because of the shared cart's leftovers) passes 3 of 3 on new
 *    accounts: Unconfirmed, with the reason;
 *  - each attempt keeps an evidence package, video off, and no AI call is made (counted).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ calls: 0 }));
vi.mock("ai", async (orig) => {
    const real = await orig<Record<string, unknown>>();
    const counted = (name: string) => (...args: unknown[]) => {
        ai.calls++;
        return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
    return { ...real, generateText: counted("generateText"), generateObject: counted("generateObject"), streamText: counted("streamText"), streamObject: counted("streamObject") };
});

const { loadConfig } = await import("../src/config.js");
const { TestSpecSchema } = await import("../src/engine/spec/schema.js");
const { bootstrap } = await import("../src/platform/bootstrap.js");
const { CandidateFindingStore } = await import("../src/platform/candidate-finding-store.js");
const { DEFAULT_JOB_OPTIONS } = await import("../src/platform/repo.js");
const { verifyAfterJob } = await import("../src/platform/findings/verify-service.js");
type Platform = import("../src/platform/bootstrap.js").Platform;

const PORT = 9871;
const SHOP = `http://127.0.0.1:${PORT}`;
const ALICE = { username: "alice@example.test", password: "Password1!" };
let shop: ChildProcess;
let platform: Platform;
let dataDir: string;

async function call(pathname: string, body: unknown, cookie?: string): Promise<{ status: number; cookie?: string }> {
    const res = await fetch(`${SHOP}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), redirect: "manual" });
    await res.arrayBuffer();
    return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

beforeAll(async () => {
    shop = spawn(process.execPath, ["examples/bench-shop/server.mjs", String(PORT)], { env: { ...process.env, BENCH_DEFECTS: "BS-02" }, stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
        if (await fetch(`${SHOP}/`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    // The dirty start: earlier tests left three pairs of headphones in the shared account's cart.
    const signedIn = await call("/api/login", { email: ALICE.username, password: ALICE.password });
    expect(signedIn.status).toBe(200);
    expect((await call("/api/cart/items", { productId: "p4", quantity: 3 }, signedIn.cookie)).status).toBeLessThan(300);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reproduce-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "findings-reproduce-secret-0123456789" }));
}, 60_000);

afterAll(() => {
    platform?.db.close();
    shop?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const signIn = [
    { action: "navigate", url: "/login" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Products" } },
];
const add = (product: string, quantity: string) => [
    { action: "navigate", url: `/products/${product}` },
    { action: "fill", locator: { by: "label", value: "Quantity" }, value: quantity },
    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Your cart" } },
];
const spec = (testId: string, title: string, steps: unknown[]) =>
    TestSpecSchema.parse({ testId, title, kind: "web", category: "Cart", source: { origin: "browser-agent", requirements: ["R-2"] }, expectedResults: ["The cart adds up its lines: $21.00 for one p1 and two p3, $17.50 for one p1 with shipping"], steps });
// BS-02: Trail Mug $12.50 + 2 × Pocket Notebook $4.25 is $21.00; the seed counts the last line once ($16.75).
const seed = spec("WEB-021", "Subtotal of two lines", [...signIn, ...add("p1", "1"), ...add("p3", "2"), { action: "assert", check: "exactText", locator: { by: "testId", value: "subtotal" }, expected: "$21.00", source: "R-2" }]);
// One Trail Mug and shipping is $17.50: true on a new account, not on the shared one (its leftover headphones are in the total).
const stateBound = spec("WEB-022", "Total of one line", [...signIn, ...add("p1", "1"), { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$17.50", source: "R-2" }]);

describe("verification on bench-shop from a dirty start", () => {
    it("reproduces the seed 3 of 3, leaves the state-bound test Unconfirmed with the reason, records no video and makes no AI call", async () => {
        const project = String(platform.repo.createProject({ name: "Bench shop" }).id);
        const appId = platform.repo.createApplication(project, SHOP, { ...DEFAULT_JOB_OPTIONS, allowMutatingApiTests: true }, ALICE) as string;
        platform.repo.setAppModel(appId, { origin: SHOP, pages: [{ path: "/register", type: "register" }], apis: [], authentication: { signupPath: "/register", loginPath: "/login" } } as never);
        const job = await platform.repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const suiteId = platform.repo.getOrCreateSuite(project, "Cart", "cart");
        const at = new Date().toISOString();
        for (const [s, error] of [[seed, 'Expected "$21.00", received "$23.25"'], [stateBound, 'Expected "$17.50", received "$192.47"']] as const) {
            const testId = platform.repo.insertTest({ projectId: project, suiteId, jobId: job.id, spec: s, framework: "playwright", validationStatus: "FAILED_VALIDATION" });
            const last = s.steps.length - 1;
            platform.repo.addExecution({ testId, scriptId: null, jobId: job.id, attempt: 1, status: "failed", durationMs: 1, error: `Error: expect(locator).toHaveText(expected) failed. ${error}`, startedAt: at, steps: [{ index: last, title: `${last + 1}. check`, status: "failed", error: `Error: expect(locator).toHaveText(expected) failed. ${error}` }] });
        }
        platform.repo.setJobStatus(job.id, "COMPLETED");
        const before = ai.calls;

        const result = await verifyAfterJob(platform, platform.repo.getJob(job.id)!);

        expect(ai.calls - before).toBe(0);
        const store = new CandidateFindingStore(platform.sql);
        const findings = await store.list(project);
        expect(findings).toHaveLength(2);
        const byKey = (k: string) => findings.find((f) => platform.repo.getTest(f.testId!)?.testKey === k)!;
        const s = (await store.get(project, byKey("WEB-021").id))!;
        const b = (await store.get(project, byKey("WEB-022").id))!;
        expect(result?.verified.find((v) => v.id === s.id), JSON.stringify(result)).toMatchObject({ to: "reproduced", reason: expect.stringMatching(/3 of 3 attempts, on a newly registered account each time/) });
        expect(s).toMatchObject({ state: "confirmed", findingClass: "app_defect" });
        expect(s.attempts).toHaveLength(3);
        expect(s.attempts.every((a) => (a as { outcome: string; failedStep?: number }).outcome === "failed" && (a as { failedStep?: number }).failedStep === seed.steps.length)).toBe(true);
        expect(b.state, JSON.stringify(result)).toBe("unconfirmed");
        const why = (await store.history(project, b.id)).at(-1)!.reason!;
        expect(why).toMatch(/passed in 3 of 3 attempts on a newly registered account each time: .*state-bound/);

        // Evidence per attempt: a package (masked, video off) and the screenshot of a failed attempt, kept with the finding's test.
        const arts = platform.repo.db.all<{ kind: string; path: string; test_case_id: string }>("SELECT kind, path, test_case_id FROM artifacts WHERE job_id = ?", job.id);
        const packages = arts.filter((a) => a.kind === "evidence" && a.path.endsWith("package.json"));
        expect(packages).toHaveLength(6);
        expect(arts.some((a) => a.kind === "video")).toBe(false);
        expect(arts.filter((a) => a.kind === "screenshot" && a.test_case_id === s.testId).length).toBeGreaterThanOrEqual(3);
        const pkg = JSON.parse(fs.readFileSync(path.join(platform.config.artifactsDir, packages[0]!.path), "utf8").toString()) as Record<string, unknown>;
        expect(pkg).toMatchObject({ of: 3, cleanState: true, video: "off", appVersion: "unknown", environment: { appUrl: SHOP } });
        // The failing step's response bodies from the attempt's trace (masked, at most 8 KB each; eng-fix3-verify).
        expect(Array.isArray(pkg.responseBodies)).toBe(true);
        for (const x of pkg.responseBodies as Array<{ body: string }>) expect(Buffer.byteLength(x.body)).toBeLessThanOrEqual(8 * 1024);
        expect(JSON.stringify(pkg)).not.toContain(ALICE.password);
    }, 600_000);
});
