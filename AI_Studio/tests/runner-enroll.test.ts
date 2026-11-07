/**
 * Round 39: enrollment codes, machine binding, rotation and downloads that carry no credential, against real HTTP (a stand-in Crowd4Test
 * sign-in on 8020, the platform on 8021). A protocol-1 agent with an old aitg_ token keeps working unchanged.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";
import { Agent } from "../src/agent/agent.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { parseAgentArgs } from "../src/agent/config.js";
import { CREDENTIAL_FILE, loadCredential, MACHINE_ID_FILE } from "../src/agent/credential-store.js";
import { Logger } from "../src/agent/log.js";

const C4T_PORT = 8020;
const PORT = 8021;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "enroll-owner-key-51b0a3";
const PAGE = { "x-requested-with": "ai-studio" };
const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-ada": me("ada", "ADMIN", []),
    "t-tess": me("tess", "TESTER", ["ai_studio.access", "ai_studio.tests.run"]),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
};
const M1 = "11111111-aaaa-4bbb-8ccc-000000000001";
const M2 = "22222222-aaaa-4bbb-8ccc-000000000002";

let c4t: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let tmp = "";
const saved = { poll: process.env.AGENT_POLL_SECONDS, kit: process.env.RUNNER_KIT_DIR };

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body, raw: r.rawPayload, headers: r.headers } as { status: number; body: any; raw: Buffer; headers: Record<string, unknown> };
};
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const enroll = async (code: string, machineId: string, extra: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}/api/agent/enroll`, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ code, name: "Tess laptop", machineId }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const hello = (token: string, over: Record<string, unknown> = {}) => new FakeAgent(viaFetch(BASE), token, { name: "Tess laptop", capabilities: defaultCaps({ runnerSwitches: true }) }).hello(over);
const rotate = async (token: string) => {
    const res = await fetch(`${BASE}/api/agent/rotate`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const personalCode = async (who = "t-tess") => {
    const r = await as(who, "POST", "/api/runners/enroll", { kind: "personal" });
    return r.body as { id: string; code: string; expiresAt: string };
};

beforeAll(async () => {
    process.env.AGENT_POLL_SECONDS = "1";
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-enroll-"));
    // A stand-in runner bundle (the kit routes check its manifest and hashes; nothing here runs it).
    const bundle = path.join(tmp, "bundle");
    fs.mkdirSync(bundle);
    const files = ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"].map((name) => {
        const bytes = Buffer.from(`// ${name}\n`);
        fs.writeFileSync(path.join(bundle, name), bytes);
        return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ format: 1, platformVersion: "0.0.0", hash: "a".repeat(64), kitVersion: "0.0.0+test", nodeMin: 20, files }));
    process.env.RUNNER_KIT_DIR = bundle;
    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "enroll-test-secret-key-0123456789", PUBLIC_URL: "https://tests.example.com", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }));
    app = await buildServer(platform);
    await app.listen({ port: PORT, host: "127.0.0.1" });
    // Tess runs tests in one project, so she may add her own computer.
    const projectId = (await asKey("POST", "/api/projects", { name: "Tess's project" })).body.id as string;
    const tessId = (await as("t-tess", "GET", "/api/auth/state")).body.me.id as string;
    accessControlOf(app).projects.store.addMember(projectId, tessId, { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });
}, 60_000);

afterAll(async () => {
    // Long-polls and kept-alive connections of the runners above end now, so closing does not wait for them.
    app?.server.closeAllConnections();
    await app?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["AGENT_POLL_SECONDS", saved.poll], ["RUNNER_KIT_DIR", saved.kit]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe("enrollment codes", () => {
    it("are made for a person's own computer, used once, and say plainly when used, expired or unknown", async () => {
        const made = await personalCode();
        expect(made.code).toMatch(/^aite_[A-Za-z0-9_-]{40,}$/);
        expect(Date.parse(made.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
        // Never stored in plain text.
        expect(JSON.stringify(platform.db.all("SELECT * FROM runner_enrollments"))).not.toContain(made.code);

        const first = await enroll(made.code, M1);
        expect(first.status).toBe(201);
        expect(first.body).toMatchObject({ kind: "personal" });
        expect(first.body.token).toMatch(/^aitg_/);
        const again = await enroll(made.code, M2);
        expect(again.status).toBe(410);
        expect(again.body.error ?? again.body.message).toBe("This code was already used. Make a new one on the Runners page.");

        const old = await personalCode();
        platform.db.run("UPDATE runner_enrollments SET expires_ms = ? WHERE id = ?", Date.now() - 1, old.id);
        const expired = await enroll(old.code, M1);
        expect(expired.status).toBe(410);
        expect(expired.body.error ?? expired.body.message).toBe("This code has expired. Make a new one on the Runners page.");
        expect((await enroll(`aite_${"x".repeat(43)}`, M1)).status).toBe(404);
        // A runner credential is never accepted in place of a code.
        expect((await enroll((await personalCode()).code, M1, { authorization: `Bearer ${first.body.token}` })).status).toBe(400);
        // The maker can see when it was used, and by which runner.
        const state = await as("t-tess", "GET", `/api/runners/enrollments/${made.id}`);
        expect(state.body).toMatchObject({ status: "used", runnerId: first.body.runnerId });
        expect((await as("t-cora", "GET", `/api/runners/enrollments/${made.id}`)).status).toBe(404);
    });

    it("a lost answer: the same computer may ask again while the new credential is unused; anyone else gets 'already used'", async () => {
        const made = await personalCode();
        const one = await enroll(made.code, M1);
        const two = await enroll(made.code, M1);
        expect(two.status).toBe(201);
        expect(two.body.token).not.toBe(one.body.token);
        expect(two.body.runnerId).toBe(one.body.runnerId);
        expect((await hello(one.body.token, { machineId: M1 })).status).toBe(404);
        expect((await enroll(made.code, M2)).status).toBe(410);
        expect((await hello(two.body.token, { machineId: M1 })).status).toBe(200);
        // Once the credential was used, asking again is refused (it was not lost).
        expect((await enroll(made.code, M1)).status).toBe(410);
    });

    it("binds the credential to the computer that first used it, and writes a refusal to Activity", async () => {
        const made = await personalCode();
        const got = await enroll(made.code, M1);
        expect((await hello(got.body.token, { machineId: M1 })).status).toBe(200);
        const other = await hello(got.body.token, { machineId: M2 });
        expect(other.status).toBe(409);
        expect(other.json.error ?? other.json.message).toContain("belongs to another computer");
        // A runner made with a code always sends its install id: without one it is refused too.
        expect((await hello(got.body.token)).status).toBe(409);
        const rows = platform.db.all<{ action: string; detail: string }>("SELECT action, detail FROM activity WHERE action = 'runner-refused'");
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(rows)).not.toContain(got.body.token);
    });

    it("rotates with a grace: the old credential works until the new one is used, and a lost answer does not lock the runner out", async () => {
        const got = await enroll((await personalCode()).code, M1);
        const t1 = got.body.token as string;
        expect((await hello(t1, { machineId: M1 })).status).toBe(200);
        const r1 = await rotate(t1);
        expect(r1.status).toBe(200);
        const t2 = r1.body.token as string;
        expect(Date.parse(r1.body.previousValidUntil) - Date.now()).toBeGreaterThan(23 * 3_600_000);
        // The answer was lost: the runner still has t1, which works, and the platform asks it to rotate again.
        const still = await hello(t1, { machineId: M1 });
        expect(still.status).toBe(200);
        expect(still.json.rotate).toBe(true);
        const r2 = await rotate(t1);
        const t3 = r2.body.token as string;
        expect((await hello(t2, { machineId: M1 })).status).toBe(404); // the unused one from the lost answer is gone
        const fresh = await hello(t3, { machineId: M1 });
        expect(fresh.status).toBe(200);
        expect(fresh.json.rotate).toBeUndefined();
        // The new one was used: the old one stops at once.
        expect((await hello(t1, { machineId: M1 })).status).toBe(404);
    });
});

describe("old runners and downloads", () => {
    it("a protocol-1 agent with an old aitg_ token still connects and runs a task, without an install id", async () => {
        const projectId = (await asKey("POST", "/api/projects", { name: "Old runner shop" })).body.id as string;
        const reg = await asKey("POST", "/api/runners", { name: "Lab PC" });
        expect(reg.status).toBe(201);
        expect((await asKey("PUT", `/api/projects/${projectId}/runner-access/${reg.body.runner.id}`)).status).toBe(200);
        const agent = new FakeAgent(viaFetch(BASE), reg.body.secret, { name: "lab-pc" });
        const h = await agent.hello();
        expect(h.status).toBe(200);
        expect(h.json.protocol).toBe(1);
        const svc = getAgentServices(platform);
        const taskId = randomUUID();
        const offer = TaskOffer.parse({ taskId, jobId: randomUUID(), adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "http://app.example", headless: true } });
        svc.store.enqueue({ id: taskId, projectId, jobId: offer.jobId, adapterId: "playwright", payloadEnc: svc.encrypt(offer), files: [] });
        const got = await agent.poll(1);
        expect(got.offer?.taskId).toBe(taskId);
        expect((await agent.result(taskId, { ok: true, runs: [] })).status).toBe(200);
    });

    it("a project's kit and a personal kit carry a single-use code, never a runner credential", async () => {
        const projectId = (await asKey("POST", "/api/projects", { name: "Kit shop" })).body.id as string;
        const kit = await asKey("POST", `/api/projects/${projectId}/runner-kits`, { name: "Desk PC", platform: "unix", kind: "files" });
        expect(kit.status).toBe(200);
        expect(String(kit.headers["x-runner-enrollment-id"])).toMatch(/^[0-9a-f-]{36}$/);
        expect(kit.headers["x-runner-token-id"]).toBeUndefined();
        const entries = unzipSync(new Uint8Array(kit.raw));
        const names = Object.keys(entries);
        const enrollFile = names.find((n) => n.endsWith("/runner.enroll"));
        expect(enrollFile).toBeDefined();
        expect(Buffer.from(entries[enrollFile!]!).toString("utf8").trim()).toMatch(/^aite_/);
        expect(names.some((n) => n.endsWith("runner.token"))).toBe(false);
        for (const n of names) expect(Buffer.from(entries[n]!).toString("utf8")).not.toMatch(/aitg_[A-Za-z0-9_-]{20,}/);
        // No runner exists until the code is traded.
        expect((await asKey("GET", `/api/projects/${projectId}/agent-tokens`)).body).toEqual([]);
        const code = Buffer.from(entries[enrollFile!]!).toString("utf8").trim();
        const got = await enroll(code, M2);
        expect(got.body.kind).toBe("team");
        expect((await asKey("GET", `/api/projects/${projectId}/agent-tokens`)).body).toHaveLength(1);

        const mine = await as("t-tess", "POST", "/api/runners/kits", { runner: "personal", name: "Tess laptop", platform: "windows", kind: "files" });
        expect(mine.status).toBe(200);
        const mineEntries = unzipSync(new Uint8Array(mine.raw));
        expect(Object.keys(mineEntries).some((n) => n.endsWith("/runner.enroll"))).toBe(true);
        for (const n of Object.keys(mineEntries)) expect(Buffer.from(mineEntries[n]!).toString("utf8")).not.toMatch(/aitg_[A-Za-z0-9_-]{20,}/);
    });

    it("only Crowd4Test staff make shared runners; a runner made from a project with no organisation serves only that project", async () => {
        // A tester never makes a team runner; a customer's team code is always for their own organisation.
        expect((await as("t-tess", "POST", "/api/runners/enroll", { kind: "team" })).status).toBe(403);
        const coraCode = await as("t-cora", "POST", "/api/runners/enroll", { kind: "team", organizationId: null });
        expect(coraCode.status).toBe(201);
        const coraRunner = await enroll(coraCode.body.code, "33333333-aaaa-4bbb-8ccc-000000000003");
        expect(getAgentServices(platform).store.getToken(coraRunner.body.runnerId)?.organizationId).toBe("org-a");

        const p0 = (await asKey("POST", "/api/projects", { name: "No org one" })).body.id as string;
        const p1 = (await asKey("POST", "/api/projects", { name: "No org two" })).body.id as string;
        const kit = await asKey("POST", `/api/projects/${p0}/runner-kits`, { name: "P0 box", platform: "unix", kind: "files" });
        const entries = unzipSync(new Uint8Array(kit.raw));
        const code = Buffer.from(entries[Object.keys(entries).find((n) => n.endsWith("/runner.enroll"))!]!).toString("utf8").trim();
        const got = await enroll(code, "44444444-aaaa-4bbb-8ccc-000000000004");
        const t = getAgentServices(platform).store.getToken(got.body.runnerId)!;
        expect(t).toMatchObject({ organizationId: null, projectId: p0, kind: "team" });
        const grant = await asKey("PUT", `/api/projects/${p1}/runner-access/${t.id}`);
        expect(grant.status).toBe(409);
        expect((await asKey("GET", `/api/projects/${p1}/runner-access`)).body.available.map((r: { id: string }) => r.id)).not.toContain(t.id);
    });
});

describe("the real agent program", () => {
    it("trades a code from a file for its credential, keeps it in a 0600 file (Linux), deletes the code, and connects bound to its install id", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-enroll-agent-"));
        try {
            const code = (await personalCode()).code;
            const file = path.join(dir, "runner.enroll");
            fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
            const parsed = parseAgentArgs(["--url", BASE, "--enroll-file", file, "--work-dir", path.join(dir, "work"), "--name", "Tess real laptop"], { AITP_CREDENTIAL_DIR: dir });
            expect(parsed.kind).toBe("run");
            if (parsed.kind !== "run") return;
            const lines: string[] = [];
            const agent = new Agent({
                config: parsed.config,
                log: new Logger({ out: (l) => lines.push(l), err: (l) => lines.push(l) }),
                env: { PATH: process.env.PATH ?? "", TAQWRIGHT_HOME: "/nonexistent-taqwright" },
                probe: new CapabilityProbe({ env: { TAQWRIGHT_HOME: path.join(dir, "no-taqwright") }, browsers: () => [], exec: async () => undefined }),
                backoff: { baseMs: 50, maxMs: 200 },
            });
            const running = agent.run();
            const until = Date.now() + 20_000;
            while (agent.status().state !== "connected" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
            expect(agent.status().state).toBe("connected");
            agent.stop();
            await running;
            const token = await loadCredential(dir, { platform: "linux" });
            expect(token).toMatch(/^aitg_/);
            expect(fs.statSync(path.join(dir, CREDENTIAL_FILE)).mode & 0o777).toBe(0o600);
            expect(fs.existsSync(file)).toBe(false);
            const machineId = fs.readFileSync(path.join(dir, MACHINE_ID_FILE), "utf8").trim();
            const t = getAgentServices(platform).store.findToken(token!)!;
            expect(t).toMatchObject({ kind: "personal", machineId });
            // The real agent reports that it applies the platform's switches (code scripts, private addresses).
            expect(getAgentServices(platform).store.agentsOfToken(t.id)[0]?.capabilities.runnerSwitches).toBe(true);
            // Neither the code nor the credential reached the agent's output.
            expect(lines.join("\n")).not.toContain(code);
            expect(lines.join("\n")).not.toContain(token!);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
