/**
 * The runner agent program against a fake platform written in this file (tests/fixtures/fake-platform.ts speaks the protocol and
 * holds canned tasks) and the REAL runner: web and API scripts really run through Playwright against a local fixture application,
 * artifacts really come back as uploaded bytes, baselines are downloaded and compared, cancel really kills the process tree,
 * agent-side cleanup really deletes records in a fixture API. Mobile uses the stand-in Taqwright CLI (no emulator).
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/agent-program.test.ts
 * Ports: fixture application 5875, cleanup application 5876, fake platforms 5877-5882.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { Agent } from "../src/agent/agent.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import type { AgentConfig } from "../src/agent/config.js";
import { memoryLogger } from "../src/agent/log.js";
import { REPO_ROOT } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { FileRef, TaskOffer, WireRun } from "../src/agent-protocol/schema.js";
import { startCleanupApp, type CleanupApp } from "./fixtures/cleanup-app.js";
import { FakePlatform, sha256Hex, type FakeTask } from "./fixtures/fake-platform.js";

const APP_PORT = 5875;
const CLEAN_PORT = 5876;
const APP = `http://127.0.0.1:${APP_PORT}`;
const CLEAN = `http://127.0.0.1:${CLEAN_PORT}`;
const TOKEN = "aitg_IntegrationToken0123456789abcdefghijk";
const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const OBSERVED = path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json");

// Greppable values: none may appear in the agent's output or on its disk.
const SECRET = {
    password: "AGT-Password-7c1f93ab",
    totp: "AGT-Totp-2d84e0",
    adminPassword: "AGT-AdminPw-61b7aa",
    apiToken: "AGT-ApiToken-9e05c2",
    header: "AGT-HeaderValue-48d1f7",
};

let tmp: string;
let workDir: string;
let app: http.Server;
let shopVariant: "a" | "b" = "a";
let clean: CleanupApp;
const seenByApp: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
let active = 0;
let peakActive = 0;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-int-"));
    workDir = path.join(tmp, "work"); // outside the checkout on purpose: the agent links the checkout's node_modules into it
    app = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", APP);
        seenByApp.push({ path: url.pathname, headers: req.headers });
        const send = (status: number, type: string, body: string) => (res.writeHead(status, { "content-type": type }), res.end(body));
        if (url.pathname === "/") return send(200, "text/html", `<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
        if (url.pathname === "/shop") {
            const [color, label] = shopVariant === "a" ? ["#1f2937", "Welcome to the shop"] : ["#b91c1c", "Welcome to the NEW shop"];
            return send(200, "text/html", `<!doctype html><body style="margin:0;font:28px sans-serif"><header style="background:${color};color:#fff;padding:24px">${label}</header><p style="padding:24px">Static content.</p></body>`);
        }
        if (url.pathname === "/api/health") return send(200, "application/json", JSON.stringify({ status: "ok" }));
        if (url.pathname === "/api/secure") return send(200, "application/json", JSON.stringify({ ok: true }));
        if (url.pathname === "/api/slow") {
            active++;
            peakActive = Math.max(peakActive, active);
            return void setTimeout(() => {
                active--;
                send(200, "application/json", JSON.stringify({ slow: true }));
            }, 2500);
        }
        return send(404, "application/json", "{}");
    });
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", () => r()));
    clean = await startCleanupApp(CLEAN_PORT, { token: "clean-token-4471" });
}, 60_000);

afterAll(async () => {
    app?.closeAllConnections();
    await new Promise((r) => app?.close(r));
    await clean?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

const spec = (testId: string, title: string, kind: "web" | "api" | "mobile", steps: unknown[]) => TestSpecSchema.parse({ testId, title, kind, category: "Agent", steps });
const script = (s: ReturnType<typeof spec>, fw: "playwright" | "playwright-api" | "taqwright", ctx: { deleteOps?: string[]; baseUrl?: string } = {}) => {
    const r = renderScript(s, fw, { baseUrl: ctx.baseUrl ?? APP, ...(ctx.deleteOps ? { deleteOps: ctx.deleteOps } : {}) });
    return { testId: s.testId, filename: r.filename, content: r.content };
};
const handWritten = (testId: string, body: string) => ({ testId, filename: `${testId}.spec.ts`, content: `import { test, expect } from "@playwright/test";\n${body}\n` });

const visible = (text: string) => ({ action: "assert", check: "visible", locator: { by: "text", value: text } });
const webPass = () => script(spec("WEB-001", "The home page greets people", "web", [{ action: "navigate", url: `${APP}/` }, visible("Welcome to the fixture")]), "playwright");
const webFail = () => script(spec("WEB-002", "A missing heading is reported", "web", [{ action: "navigate", url: `${APP}/` }, visible("Nothing like this")]), "playwright");
const apiPass = () => script(spec("API-001", "The health endpoint answers", "api", [{ action: "request", method: "GET", path: "/api/health", auth: "default", description: "" }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" }]), "playwright-api");

let counter = 0;
const offer = (adapterId: string, scripts: TaskOffer["scripts"], env: Partial<TaskOffer["env"]> = {}, extra: Partial<TaskOffer> = {}): TaskOffer => ({
    taskId: `task-${++counter}-${Math.random().toString(16).slice(2, 8)}`,
    jobId: "job-1",
    adapterId,
    leaseSeconds: 60,
    workers: 2,
    timeoutMs: 120_000,
    scripts,
    env: { baseUrl: APP, apiBaseUrl: APP, headless: true, ...env },
    ...extra,
});

const refOf = (name: string, bytes: Buffer): FileRef => ({ ref: name, size: bytes.length, sha256: sha256Hex(bytes) });

function agentConfig(fake: FakePlatform, over: Partial<AgentConfig> = {}): AgentConfig {
    return { baseUrl: fake.url, token: TOKEN, name: "Test agent", concurrency: 2, workDir, allowInsecure: false, cacheBytes: 256 * 1024 * 1024, tokenSource: "env", ...over };
}

interface Running {
    agent: Agent;
    lines: string[];
    done: Promise<number>;
    stop(): Promise<number>;
}

function startAgent(fake: FakePlatform, over: Partial<AgentConfig> = {}, extra: { env?: NodeJS.ProcessEnv; probe?: CapabilityProbe } = {}): Running {
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: agentConfig(fake, over),
        log,
        env: { ...process.env, ...extra.env },
        ...(extra.probe ? { probe: extra.probe } : {}),
        heartbeatMs: 300,
        backoff: { baseMs: 50, maxMs: 200 },
        deleteTimeoutMs: 5000,
    });
    const done = agent.run();
    return {
        agent,
        lines,
        done,
        stop: async () => {
            agent.stop();
            return done;
        },
    };
}

const waitFor = async (what: string, cond: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
};

const runOf = (r: { runs: WireRun[] }, testId: string): WireRun => r.runs.find((x) => x.testId === testId)!;
const uploadsOf = (fake: FakePlatform, taskId: string) => fake.uploads.get(taskId) ?? new Map();
const bytesOf = (fake: FakePlatform, taskId: string, ref: string): Buffer => {
    const u = uploadsOf(fake, taskId).get(ref);
    if (!u) throw new Error(`no upload ${ref}`);
    return u.bytes;
};

/** Every file under a folder, read as text (binary files are read as latin1 so a secret would still be found). */
function filesUnder(dir: string): Array<{ file: string; text: string }> {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isSymbolicLink()) continue; // the node_modules link back into the checkout
            if (e.isDirectory()) walk(p);
            else out.push({ file: p, text: fs.readFileSync(p).toString("latin1") });
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ── the real runner, through the fake platform ──────────────────────────────

describe("an agent running real tests for a fake platform", () => {
    let fake: FakePlatform;
    let a: Running;

    beforeAll(async () => {
        fake = new FakePlatform(5877, { token: TOKEN });
        await fake.start();
        // The agent's own settings are in its environment, as they would be when it is started from a shell script.
        a = startAgent(fake, {}, { env: { AITP_AGENT_TOKEN: TOKEN, AITP_URL: fake.url } });
        await waitFor("the agent to say hello", () => fake.hellos.length > 0);
        // The platform sees the hello a moment before the agent logs that it connected (capability discovery can take seconds).
        await waitFor("the agent to log that it connected", () => a.lines.join("\n").includes('Connected to the platform as "Test agent"'));
    }, 60_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("says hello with what this computer can run, and is not a fixed copy of the platform", () => {
        const h = fake.hellos[0]!;
        expect(h).toMatchObject({ protocol: 1, name: "Test agent", concurrency: 2 });
        expect(h.capabilities.os).toBe(process.platform);
        expect(h.capabilities.node).toBe(process.version);
        expect(h.capabilities.browsers).toContain("chromium");
        expect(a.lines.join("\n")).toMatch(/Connected to the platform as "Test agent"/);
        expect(a.lines.join("\n")).toMatch(/Capabilities: .*browsers: chromium/);
    });

    it("runs a web script and an API script, uploads artifacts of the failing script only, and the bytes match", async () => {
        fake.failUploads = 2; // the first upload fails twice: the agent retries
        const t = offer("playwright", [webPass(), webFail(), apiPass()]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs.map((x) => [x.testId, x.status])).toEqual([["WEB-001", "passed"], ["WEB-002", "failed"], ["API-001", "passed"]]);

        // a passing script leaves nothing behind
        expect(runOf(r, "WEB-001").artifacts).toEqual([]);
        expect(runOf(r, "API-001").artifacts).toEqual([]);

        // the failing one has its screenshot, trace and video (and evidence) as uploaded files
        const failed = runOf(r, "WEB-002");
        const kinds = failed.artifacts.map((x) => x.kind);
        expect(kinds).toEqual(expect.arrayContaining(["screenshot", "trace", "video"]));
        expect(failed.error).toMatch(/Nothing like this|toBeVisible/);
        expect(failed.failedStepIndex).toBeGreaterThanOrEqual(0);
        expect(failed.steps.length).toBeGreaterThan(0);
        for (const art of failed.artifacts) {
            const up = uploadsOf(fake, t.taskId).get(art.ref);
            expect(up, art.ref).toBeTruthy();
            expect(up!.declaredLength).toBe(up!.bytes.length); // streamed with the right length
            expect(up!.bytes.length).toBeGreaterThan(50);
            expect(art.ref).toMatch(/^WEB-002-/);
        }
        expect(bytesOf(fake, t.taskId, failed.artifacts.find((x) => x.kind === "screenshot")!.ref).subarray(0, 4).equals(PNG)).toBe(true);
        const trace = bytesOf(fake, t.taskId, failed.artifacts.find((x) => x.kind === "trace")!.ref);
        expect(Object.keys(unzipSync(new Uint8Array(trace))).length).toBeGreaterThan(0); // a real, readable zip
        expect(bytesOf(fake, t.taskId, failed.artifacts.find((x) => x.kind === "video")!.ref).subarray(0, 4).toString("hex")).toBe("1a45dfa3"); // WebM
        const evidence = failed.artifacts.find((x) => x.kind === "evidence");
        if (evidence) expect(JSON.parse(bytesOf(fake, t.taskId, evidence.ref).toString("utf8"))).toBeTruthy();

        // nothing but the failing script's files was uploaded, and no local path leaked into the result
        expect([...uploadsOf(fake, t.taskId).keys()].every((n) => n.startsWith("WEB-002-"))).toBe(true);
        expect(JSON.stringify(r)).not.toContain(workDir);

        // heartbeats carried progress, and the scratch folder is gone
        const beats = fake.heartbeats.get(t.taskId) ?? [];
        expect(beats.length).toBeGreaterThan(0);
        expect(beats[0]).toMatchObject({ total: 3 });
        await waitFor("the scratch folder to be removed", () => fs.readdirSync(path.join(workDir, "tasks")).length === 0, 10_000);
    }, 180_000);

    it("downloads baselines once, compares them, and reports new baselines and visual differences", async () => {
        const visual = () => script(spec("VIS-001", "The shop looks as approved", "web", [{ action: "navigate", url: `${APP}/shop` }, { action: "assert", check: "screenshot", expected: 100 }]), "playwright");
        const looks = () => script(spec("WEB-004", "The home page looks right", "web", [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "looksRight", expected: "a plain welcome heading" }]), "playwright");

        // first run: no baseline exists, Playwright writes one, the agent uploads it and names it
        shopVariant = "a";
        const first = offer("playwright", [visual(), looks()]);
        fake.enqueue({ offer: first });
        const r1 = await fake.result(first.taskId);
        expect(r1.ok, r1.error).toBe(true);
        // exactly what a local run reports for a missing baseline (the platform recognises it by this text and the new baseline file)
        expect(runOf(r1, "VIS-001").status).toBe("failed");
        expect(runOf(r1, "VIS-001").error).toMatch(/A snapshot doesn.t exist/);
        const nb = runOf(r1, "VIS-001").newBaselines!;
        expect(nb).toHaveLength(1);
        const baselineBytes = bytesOf(fake, first.taskId, nb[0]!.ref);
        expect(baselineBytes.subarray(0, 4).equals(PNG)).toBe(true);
        // the "looks right" screenshot travels as a vision shot
        const vision = runOf(r1, "WEB-004").vision!;
        expect(vision).toHaveLength(1);
        expect(vision[0]!.expected).toBe("a plain welcome heading");
        expect(bytesOf(fake, first.taskId, vision[0]!.ref).length).toBeGreaterThan(100);

        // second run: the same baseline is downloaded and the unchanged page matches it
        const withBaseline = (id: string): FakeTask => {
            const v = visual();
            const task = offer("playwright", [{ testId: v.testId, filename: v.filename, content: v.content, baselines: [{ name: nb[0]!.name, file: refOf("baseline-1.png", baselineBytes) }] }]);
            task.taskId = id;
            return { offer: task, files: new Map([["baseline-1.png", baselineBytes]]) };
        };
        const second = withBaseline("task-baseline-same");
        fake.enqueue(second);
        const r2 = await fake.result(second.offer.taskId);
        expect(r2.ok, r2.error).toBe(true);
        expect(runOf(r2, "VIS-001")).toMatchObject({ status: "passed" });
        expect(runOf(r2, "VIS-001").newBaselines ?? []).toEqual([]);
        expect(fake.downloads).toContain("task-baseline-same/baseline-1.png");

        // third run: the page changed; the comparison fails, with the actual and the difference as files. The cache already holds the baseline.
        shopVariant = "b";
        const third = withBaseline("task-baseline-changed");
        fake.enqueue(third);
        const r3 = await fake.result(third.offer.taskId);
        shopVariant = "a";
        expect(r3.ok, r3.error).toBe(true);
        const changed = runOf(r3, "VIS-001");
        expect(changed.status).toBe("failed");
        expect(changed.artifacts.map((x) => x.kind)).toEqual(expect.arrayContaining(["visual-actual", "visual-diff"]));
        for (const art of changed.artifacts.filter((x) => x.kind.startsWith("visual-"))) expect(bytesOf(fake, "task-baseline-changed", art.ref).subarray(0, 4).equals(PNG)).toBe(true);
        expect(fake.downloads).not.toContain("task-baseline-changed/baseline-1.png"); // served from the cache by checksum
        expect(fs.readdirSync(path.join(workDir, "cache")).filter((f) => f.endsWith(".png"))).toHaveLength(1);
    }, 240_000);

    it("hands the task's credentials to the test process and nowhere else", async () => {
        const env = {
            credentials: { username: "agent-user", password: SECRET.password, totpSecret: SECRET.totp },
            roles: [{ name: "admin", username: "root", password: SECRET.adminPassword }],
            apiToken: SECRET.apiToken,
            apiAuthHeader: `X-Agent-Key: ${SECRET.header}`,
        };
        const send = handWritten(
            "SEC-001",
            `test("credentials reach the test process", async ({ request }) => {
    const res = await request.get(process.env.API_BASE_URL + "/api/secure", { headers: { "x-test-pw": process.env.TEST_PASSWORD ?? "", "x-test-totp": process.env.TEST_TOTP_SECRET ?? "", "x-admin-pw": process.env.TEST_ADMIN_PASSWORD ?? "", "x-bearer": process.env.API_TOKEN ?? "", "x-token-in-env": process.env.AITP_AGENT_TOKEN ?? "none", "x-url-in-env": process.env.AITP_URL ?? "none" } });
    expect(res.status()).toBe(200);
});`,
        );
        const leak = handWritten("SEC-002", `test("an error that quotes the password", async () => {\n    throw new Error("sign-in failed for admin with " + process.env.TEST_PASSWORD + " and token " + process.env.API_TOKEN);\n});`);
        seenByApp.length = 0;
        const t = offer("playwright", [send, leak], env);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(runOf(r, "SEC-001").status).toBe("passed");

        // the test process really had them ...
        const secure = seenByApp.find((s) => s.path === "/api/secure")!;
        expect(secure.headers["x-test-pw"]).toBe(SECRET.password);
        expect(secure.headers["x-test-totp"]).toBe(SECRET.totp);
        expect(secure.headers["x-admin-pw"]).toBe(SECRET.adminPassword);
        expect(secure.headers["x-bearer"]).toBe(SECRET.apiToken);
        // ... but not the agent's own token or settings
        expect(secure.headers["x-token-in-env"]).toBe("none");
        expect(secure.headers["x-url-in-env"]).toBe("none");

        // an error that quotes a secret is masked before it leaves the machine
        const failed = runOf(r, "SEC-002");
        expect(failed.status).toBe("failed");
        expect(failed.error).toContain("sign-in failed");
        expect(JSON.stringify(r)).not.toContain(SECRET.password);
        expect(JSON.stringify(r)).not.toContain(SECRET.apiToken);

        // not in the agent's output, not anywhere on its disk (once the task's scratch folder is removed)
        await waitFor("the scratch folder to be removed", () => fs.readdirSync(path.join(workDir, "tasks")).length === 0, 10_000);
        const everything = a.lines.join("\n");
        for (const s of [...Object.values(SECRET), TOKEN]) {
            expect(everything, s).not.toContain(s);
            expect(filesUnder(workDir).filter((f) => f.text.includes(s)).map((f) => f.file), s).toEqual([]);
        }
        // and the platform never saw the token inside anything it received
        expect(JSON.stringify([...fake.heartbeats.values()])).not.toContain(TOKEN);
    }, 120_000);

    it("runs two tasks at once and offers only the free slots", async () => {
        const slow = (id: string) => script(spec(id, "A slow endpoint answers", "api", [{ action: "request", method: "GET", path: "/api/slow", auth: "default", description: "" }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" }]), "playwright-api");
        peakActive = 0;
        const t1 = offer("playwright", [slow("API-011")]);
        const t2 = offer("playwright", [slow("API-012")]);
        fake.enqueue({ offer: t1 });
        fake.enqueue({ offer: t2 });
        const [r1, r2] = await Promise.all([fake.result(t1.taskId), fake.result(t2.taskId)]);
        expect(r1.ok && r2.ok).toBe(true);
        expect(runOf(r1, "API-011").status).toBe("passed");
        expect(runOf(r2, "API-012").status).toBe("passed");
        expect(peakActive).toBe(2); // the application saw both requests in flight together
        expect(a.agent.status().peakRunning).toBe(2);
        expect(fake.polls.some((p) => p.freeSlots === 1)).toBe(true); // while one task ran, one slot was offered
        expect(fake.polls.every((p) => p.freeSlots >= 1 && p.freeSlots <= 2)).toBe(true);
    }, 120_000);

    it("cancel from the heartbeat kills the whole process tree and posts ok=false", async () => {
        const slow = handWritten("SLOW-001", `test("never finishes", async () => {\n    await new Promise((r) => setTimeout(r, 120_000));\n});`);
        const t = offer("playwright", [slow], {}, { timeoutMs: 300_000 });
        fake.enqueue({ offer: t });
        await waitFor("the task to run", () => (fake.heartbeats.get(t.taskId)?.length ?? 0) >= 1 && a.agent.status().running.some((x) => x.taskId === t.taskId && x.pid));
        const pid = a.agent.status().running.find((x) => x.taskId === t.taskId)!.pid!;
        expect(() => process.kill(pid, 0)).not.toThrow(); // alive
        const started = Date.now();
        fake.cancel.add(t.taskId);
        const r = await fake.result(t.taskId, 30_000);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/cancelled/i);
        expect(r.runs).toEqual([]);
        expect(Date.now() - started).toBeLessThan(20_000);
        await waitFor("the runner process to be gone", () => {
            try {
                process.kill(pid, 0);
                return false;
            } catch {
                return true;
            }
        }, 10_000);
        await waitFor("the task to be forgotten", () => a.agent.status().running.length === 0, 10_000);
    }, 120_000);

    it("answers a task for an adapter it does not have with a plain ok=false", async () => {
        const t = offer("xcuitest", [{ testId: "IOS-001", filename: "IOS-001.spec.ts", content: "// x" }]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r).toMatchObject({ ok: false, error: "This agent can't run xcuitest tasks yet.", runs: [] });
    });

    it("answers a missing Playwright browser as a problem of the machine, not as a failing test", async () => {
        // The runner fails with Playwright's own "Executable doesn't exist" text.
        const broken = handWritten("WEB-090", `test("no browser here", async () => {\n    throw new Error("browserType.launch: Executable doesn't exist at /nowhere/chrome\\nLooks like Playwright Test or Playwright was just installed or updated.\\nPlease run: npx playwright install");\n});`);
        const t = offer("playwright", [broken]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/browsers are not installed on this agent/);
        expect(r.runs).toEqual([]);
    }, 60_000);

    it("a task with a broken script set is refused plainly", async () => {
        const same = handWritten("DUP-001", `test("a", async () => {});`);
        const t = offer("playwright", [same, { ...same, testId: "DUP-002" }]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r).toMatchObject({ ok: false });
        expect(r.error).toMatch(/share the file name DUP-001.spec.ts/);
    });

    it("carries on after answers that are not in the protocol", async () => {
        fake.garbagePolls = 3; // not json, a task that is missing fields, not json
        const t = offer("playwright", [apiPass()]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId, 60_000);
        expect(r.ok, r.error).toBe(true);
        const text = a.lines.join("\n");
        expect(text).toMatch(/was not readable/);
        expect(text).toMatch(/does not match the protocol/);
        expect(text).toMatch(/The agent carries on/);
    }, 90_000);

    it("removes the records a run created on the agent's side, newest first, and reports the ledger", async () => {
        clean.reset();
        clean.seed("items", ["100", "101"]); // already in the application: no test created them
        const post = (p: string, name: string) => ({ action: "request", method: "POST", path: p, auth: "default", description: "", body: { name } });
        const ok = { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" };
        const creating = script(spec("API-021", "Items and a note are created", "api", [post("/api/items", "first"), ok, post("/api/items", "second"), ok, post("/api/notes", "a note"), ok]), "playwright-api", { deleteOps: ["/api/items/{id}"], baseUrl: CLEAN });
        expect(creating.content).toContain('"/api/items/{id}"');
        const env = { baseUrl: CLEAN, apiBaseUrl: CLEAN, apiToken: "clean-token-4471", cleanup: "agent" as const };
        const t = offer("playwright", [creating], env);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(runOf(r, "API-021").status).toBe("passed");

        // the records the test created are gone, the seeded ones and the note (no way to delete it) are not
        expect([...clean.store.items!.keys()].sort()).toEqual(["100", "101"]);
        expect(clean.store.notes!.size).toBe(1);
        const deletes = clean.log.filter((l) => l.op === "delete");
        expect(deletes.map((d) => d.id)).toEqual(["2", "1"]); // newest first
        expect(deletes.every((d) => d.auth === "Bearer clean-token-4471")).toBe(true);
        expect(clean.log.filter((l) => l.op === "delete-refused")).toEqual([]);

        // the ledger lines come back with their outcome
        const lines = (runOf(r, "API-021").created ?? []) as Array<Record<string, unknown>>;
        expect(lines.map((l) => [l.path, l.status])).toEqual([["/api/items", "removed"], ["/api/items", "removed"], ["/api/notes", "no-delete-operation"]]);
        expect(lines[0]).toMatchObject({ k: "created", testId: "API-021", deletePath: "/api/items/1", origin: CLEAN });
        expect(JSON.stringify(lines)).not.toContain("clean-token-4471");
        expect(a.lines.join("\n")).toMatch(/Removed 2 of 3 records the tests created; 1 left behind/);

        // with "platform" cleanup the agent deletes nothing: it only reports what was created
        const before = clean.log.length;
        const platformSide = offer("playwright", [creating], { ...env, cleanup: "platform" as const });
        fake.enqueue({ offer: platformSide });
        const r2 = await fake.result(platformSide.taskId);
        expect(r2.ok, r2.error).toBe(true);
        expect(clean.log.slice(before).filter((l) => l.op !== "create")).toEqual([]);
        const raw = (runOf(r2, "API-021").created ?? []) as Array<Record<string, unknown>>;
        expect(raw.filter((l) => l.k === "created")).toHaveLength(3);
        expect(raw.every((l) => l.status === undefined)).toBe(true);
    }, 180_000);

    it("leaves no task folders or run folders behind", async () => {
        await waitFor("the scratch folders to be removed", () => fs.readdirSync(path.join(workDir, "tasks")).length === 0, 10_000);
        expect(fs.readdirSync(path.join(workDir, "cache")).every((f) => /^[0-9a-f]{64}(\.\w+)?$/.test(f))).toBe(true);
    });
});

// ── connection behaviour ────────────────────────────────────────────────────

describe("connection loop", () => {
    it("reconnects after the platform restarts and carries on", async () => {
        const fake = new FakePlatform(5878, { token: TOKEN });
        await fake.start();
        const a = startAgent(fake);
        await waitFor("hello", () => fake.hellos.length === 1);
        await fake.stop();
        await waitFor("the agent to notice", () => a.lines.some((l) => /Trying again in/.test(l)));
        const outageWarnings = a.lines.filter((l) => /Trying again in/.test(l)).length;
        await new Promise((r) => setTimeout(r, 600));
        expect(a.lines.filter((l) => /Trying again in/.test(l)).length).toBeGreaterThan(outageWarnings); // keeps trying
        expect(a.lines.filter((l) => /Trying again in/.test(l)).every((l) => /Could not reach 127\.0\.0\.1:5878/.test(l))).toBe(true);
        await fake.start();
        await waitFor("a second hello", () => fake.hellos.length === 2);
        expect(a.lines.join("\n")).toMatch(/Reconnected to the platform/);
        const t = offer("playwright", [apiPass()]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId, 60_000);
        expect(r.ok, r.error).toBe(true);
        expect(await a.stop()).toBe(0);
        await fake.stop();
    }, 120_000);

    it("stops with a plain message and its own exit code for a bad token, a revoked token, a refusal and a protocol mismatch", async () => {
        const cases: Array<{ reject?: 401 | 404 | 409; protocol?: number; code: number; message: RegExp }> = [
            { reject: 401, code: 3, message: /not valid or was revoked/ },
            { reject: 404, code: 3, message: /not valid or was revoked/ },
            { reject: 409, code: 5, message: /refused this agent.*Another agent with this name/ },
            // The agent speaks 1 and 2 (it offers both and falls back to 1); a platform answering a version it does not know stops it.
            { protocol: 3, code: 4, message: /speaks protocol 1 and 2 but the platform speaks protocol 3/ },
        ];
        for (const c of cases) {
            const fake = new FakePlatform(5879, { token: TOKEN, ...(c.protocol ? { protocol: c.protocol } : {}) });
            fake.rejectToken = c.reject;
            await fake.start();
            const a = startAgent(fake);
            const code = await a.done;
            expect(code, JSON.stringify(c)).toBe(c.code);
            expect(a.lines.join("\n")).toMatch(c.message);
            expect(a.lines.join("\n")).not.toContain(TOKEN);
            await fake.stop();
        }
    }, 60_000);

    it("stops for a revoked token in the middle of a run too (the next poll is refused)", async () => {
        const fake = new FakePlatform(5880, { token: TOKEN });
        await fake.start();
        const a = startAgent(fake);
        await waitFor("hello", () => fake.hellos.length === 1);
        fake.rejectToken = 404;
        expect(await a.done).toBe(3);
        await fake.stop();
    }, 30_000);

    it("a graceful stop cancels the running task, tells the platform, and exits with 0", async () => {
        const fake = new FakePlatform(5881, { token: TOKEN });
        await fake.start();
        const a = startAgent(fake);
        const slow = handWritten("SLOW-002", `test("never finishes", async () => {\n    await new Promise((r) => setTimeout(r, 120_000));\n});`);
        const t = offer("playwright", [slow], {}, { timeoutMs: 300_000 });
        fake.enqueue({ offer: t });
        await waitFor("the task to run", () => a.agent.status().running.some((x) => x.pid));
        const pid = a.agent.status().running[0]!.pid!;
        expect(await a.stop()).toBe(0);
        const r = fake.results.get(t.taskId)!;
        expect(r).toMatchObject({ ok: false, error: "The agent was stopped.", runs: [] });
        expect(() => process.kill(pid, 0)).toThrow();
        expect(a.agent.status().state).toBe("stopped");
        await fake.stop();
    }, 60_000);
});

// ── the real command line ───────────────────────────────────────────────────

describe("the command line program", () => {
    const launcher = path.join(REPO_ROOT, "bin/ai-test-agent.mjs");
    function runCli(args: string[], env: Record<string, string>): { output: () => string; exited: Promise<number | null>; kill(): void } {
        const child = spawn(process.execPath, [launcher, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env, AITP_URL: "", AITP_AGENT_TOKEN: "", ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
        return { output: () => out, exited, kill: () => child.kill() };
    }

    it("--help prints the usage and exits 0; a usage error exits 2; neither shows a token", async () => {
        const help = runCli(["--help"], {});
        expect(await help.exited).toBe(0);
        expect(help.output()).toMatch(/Usage:\n\s+ai-test-agent --url/);
        const bad = runCli(["--url", "http://example.com", "--token", TOKEN], {});
        expect(await bad.exited).toBe(2);
        expect(bad.output()).toMatch(/must use https/);
        expect(bad.output()).not.toContain(TOKEN);
    }, 60_000);

    it("a revoked token: a plain message, exit code 3, the token printed nowhere", async () => {
        const fake = new FakePlatform(5882, { token: TOKEN });
        fake.rejectToken = 404;
        await fake.start();
        const cli = runCli(["--work-dir", path.join(tmp, "cli-work-1")], { AITP_URL: fake.url, AITP_AGENT_TOKEN: TOKEN });
        expect(await cli.exited).toBe(3);
        expect(cli.output()).toMatch(/The agent token is not valid or was revoked/);
        expect(cli.output()).not.toContain(TOKEN);
        await fake.stop();
    }, 60_000);

    it("runs a task end to end; the token and the task's credentials appear in none of its output or files", async () => {
        const fake = new FakePlatform(5882, { token: TOKEN });
        await fake.start();
        const cliWork = path.join(tmp, "cli-work-2");
        const tokenFile = path.join(tmp, "token.txt");
        fs.writeFileSync(tokenFile, TOKEN);
        const cli = runCli(["--work-dir", cliWork, "--name", "Command line agent", "--token-file", tokenFile], { AITP_URL: fake.url, AITP_AGENT_TOKEN: "" });
        const probe = handWritten("SEC-010", `test("credentials reach the test process", async ({ request }) => {\n    const res = await request.get(process.env.API_BASE_URL + "/api/secure", { headers: { "x-test-pw": process.env.TEST_PASSWORD ?? "" } });\n    expect(res.status()).toBe(200);\n});`);
        const failing = handWritten("SEC-011", `test("quotes the password", async () => {\n    throw new Error("password was " + process.env.TEST_PASSWORD);\n});`);
        await waitFor("the command line agent to connect", () => fake.hellos.length > 0, 60_000);
        const t = offer("playwright", [probe, failing], { credentials: { username: "cli-user", password: SECRET.password } });
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId, 90_000);
        expect(r.ok, r.error).toBe(true);
        expect(runOf(r, "SEC-010").status).toBe("passed");
        expect(fake.hellos[0]).toMatchObject({ name: "Command line agent" });
        await waitFor("the scratch folder to be removed", () => !fs.existsSync(path.join(cliWork, "tasks")) || fs.readdirSync(path.join(cliWork, "tasks")).length === 0, 15_000);
        cli.kill();
        await cli.exited;
        expect(cli.output()).toMatch(/Connected to the platform as "Command line agent"/);
        expect(cli.output()).toMatch(/Task .* finished: 2 results/);
        for (const s of [TOKEN, SECRET.password]) {
            expect(cli.output(), s).not.toContain(s);
            expect(JSON.stringify(r), s).not.toContain(s);
            expect(filesUnder(cliWork).filter((f) => f.text.includes(s)).map((f) => f.file), s).toEqual([]);
        }
        await fake.stop();
    }, 180_000);
});

// ── mobile, through the stand-in Taqwright CLI ──────────────────────────────

describe("mobile tasks (stand-in CLI, no emulator)", () => {
    const apk = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("AndroidManifest.xml"), Buffer.alloc(300, 7)]);
    const passing = { title: "Network settings are listed", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Network & internet" } }] };
    const failing = { title: "A missing item is shown [fail]", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Nothing like this [fail]" } }] };
    const mobileScripts = () => [
        script(spec("MOB-001", passing.title, "mobile", passing.steps), "taqwright"),
        script(spec("MOB-002", failing.title, "mobile", failing.steps), "taqwright"),
    ];
    let fake: FakePlatform;
    let a: Running;
    const avdHome = () => {
        const dir = path.join(tmp, "avd");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "Pixel_Test.ini"), "target=android-34\n");
        return dir;
    };

    beforeAll(async () => {
        fake = new FakePlatform(5883, { token: TOKEN });
        await fake.start();
        // A pretend adb that lists one phone, so the agent has a device to select.
        const probe = new CapabilityProbe({
            env: { ANDROID_AVD_HOME: avdHome(), TAQWRIGHT_HOME: path.join(tmp, "no-taqwright") },
            browsers: () => [],
            exec: async (_file, args) => (args[0] === "version" ? "Android Debug Bridge" : args[0] === "devices" ? "List of devices attached\nR58M12ABCDE\tdevice usb:1-1 model:Pixel_7 transport_id:2\n" : undefined),
        });
        a = startAgent(fake, { concurrency: 2 }, { env: { MOBILE_RUNNER_CLI: FAKE_CLI, ANDROID_AVD_HOME: avdHome(), AITP_AGENT_TOKEN: TOKEN }, probe });
        await waitFor("hello", () => fake.hellos.length > 0);
    }, 60_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    const observed = () => JSON.parse(fs.readFileSync(OBSERVED, "utf8")) as { args: string[]; env: Record<string, string>; config: string };

    it("announces the phone and the emulators in its capabilities", () => {
        expect(fake.hellos[0]!.capabilities.android).toMatchObject({ adb: true, avds: ["Pixel_Test"], devices: [{ serial: "R58M12ABCDE", model: "Pixel 7", state: "device", emulator: false }] });
        expect(fake.hellos[0]!.capabilities.browsers).toEqual([]);
    });

    it("downloads the APK by checksum, runs through the Taqwright runner and uploads the failing test's files", async () => {
        const task = offer("taqwright", mobileScripts(), { baseUrl: "android-app://com.android.settings" }, { mobile: { appPackage: "com.android.settings", avd: "Pixel_Test", apk: refOf("app-1.apk", apk) }, workers: 1, timeoutMs: 60_000 });
        fake.enqueue({ offer: task, files: new Map([["app-1.apk", apk]]) });
        const r = await fake.result(task.taskId, 60_000);
        expect(r.ok, r.error).toBe(true);
        expect(runOf(r, "MOB-001")).toMatchObject({ status: "passed", artifacts: [] });
        const bad = runOf(r, "MOB-002");
        expect(bad.status).toBe("failed");
        expect(bad.steps[0]!.error).toMatch(/toBeVisible/);
        expect(bad.artifacts.map((x) => x.kind).sort()).toEqual(["screenshot", "trace", "video"]);
        expect(bytesOf(fake, task.taskId, bad.artifacts.find((x) => x.kind === "screenshot")!.ref).subarray(1, 4).toString()).toBe("PNG");

        // the runner saw the cached APK, the emulator name and nothing of the agent's own settings
        const seen = observed();
        expect(seen.env.MOBILE_AVD).toBe("Pixel_Test");
        expect(seen.env.MOBILE_APP_PACKAGE).toBe("com.android.settings");
        expect(path.basename(seen.env.MOBILE_APK_PATH)).toBe(`${sha256Hex(apk)}.apk`);
        expect(fs.readFileSync(seen.env.MOBILE_APK_PATH).equals(apk)).toBe(true);
        expect(seen.env.MOBILE_UDID).toBe("");
        expect(JSON.stringify(seen.env)).not.toContain(TOKEN);
        expect(seen.env.AITP_AGENT_TOKEN).toBeUndefined();
        expect(seen.args).toEqual(expect.arrayContaining(["test", "--workers=1"]));
    }, 90_000);

    it("a second task with the same APK does not download it again", async () => {
        const task = offer("taqwright", mobileScripts().slice(0, 1), { baseUrl: "android-app://com.android.settings" }, { mobile: { appPackage: "com.android.settings", apk: refOf("app-1.apk", apk) }, workers: 1, timeoutMs: 60_000 });
        fake.enqueue({ offer: task, files: new Map([["app-1.apk", apk]]) });
        const r = await fake.result(task.taskId, 60_000);
        expect(r.ok, r.error).toBe(true);
        expect(fake.downloads.filter((d) => d.endsWith("/app-1.apk"))).toHaveLength(1);
        expect(observed().env.MOBILE_AVD).toBe("Pixel_Test"); // the first emulator found, since the task named none
    }, 90_000);

    it("selects a connected phone by its serial", async () => {
        const task = offer("taqwright", mobileScripts().slice(0, 1), { baseUrl: "android-app://com.android.settings" }, { mobile: { appPackage: "com.android.settings", deviceSerial: "R58M12ABCDE" }, workers: 1, timeoutMs: 60_000 });
        fake.enqueue({ offer: task });
        const r = await fake.result(task.taskId, 60_000);
        expect(r.ok, r.error).toBe(true);
        expect(observed().env.MOBILE_UDID).toBe("R58M12ABCDE");
    }, 90_000);

    it("says plainly when the phone or the emulator is not there", async () => {
        const phone = offer("taqwright", mobileScripts().slice(0, 1), {}, { mobile: { appPackage: "com.android.settings", deviceSerial: "NOT-HERE" } });
        const avd = offer("taqwright", mobileScripts().slice(0, 1), {}, { mobile: { appPackage: "com.android.settings", avd: "Missing_AVD" } });
        const none = offer("taqwright", mobileScripts().slice(0, 1), {});
        for (const t of [phone, avd, none]) fake.enqueue({ offer: t });
        const [rp, ra, rn] = await Promise.all([phone, avd, none].map((t) => fake.result(t.taskId, 30_000)));
        expect(rp).toMatchObject({ ok: false, runs: [] });
        expect(rp!.error).toMatch(/NOT-HERE is not connected to this agent/);
        expect(ra!.error).toMatch(/The emulator "Missing_AVD" does not exist on this agent \(available: Pixel_Test\)/);
        expect(rn!.error).toMatch(/no mobile app settings/);
    }, 60_000);
});
