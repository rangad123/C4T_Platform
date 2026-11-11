/**
 * Runner agent, platform side, browser-free: token hashing, the exact route matcher and its path tricks, the task state machine
 * (claim, lease, one re-offer, cancel, expiry, pruning), capability matching, the wire form of a run, path anchoring, secret
 * scrubbing, rate limits and the cleanup ledger an agent reports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_TOKEN_PREFIX, Capabilities, TaskOffer, WireRunEnv, type Capabilities as Caps } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { listAdapters, getAdapter } from "../src/engine/frameworks/index.js";
import type { RunEnv } from "../src/engine/validation/runner.js";
import { AgentStore, hashToken, MAX_OFFERS, newAgentToken, ONLINE_MS, OPEN_OWNER_ID, QUEUE_MAX_MS, TASK_KEEP_MS } from "../src/platform/agent-store.js";
import { agentRouteOf, anchoredPath, bearerToken, capabilityProblem, envSecrets, isAgentRoute, RateLimiter, scrubSecrets, toWireEnv } from "../src/platform/agent-routing.js";
import { agentLimits, ledgerFromAgent } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

let platform: Platform;
let dataDir: string;
let projectId: string;
let otherProject: string;
let now = 1_000_000_000_000;
const clock = () => now;
let store: AgentStore;

const caps = (over: Partial<Caps> = {}): Caps => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], ...over });
const hello = (name = "laptop", c: Caps = caps()) => ({ name, version: "1.0.0", capabilities: c, concurrency: 2 });

beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-unit-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir }));
    projectId = platform.repo.createProject({ name: "Agents" }).id as string;
    otherProject = platform.repo.createProject({ name: "Others" }).id as string;
    store = new AgentStore(platform.db, clock);
    // A platform with no accounts and no access key is open: its runs and its runner belong to OPEN_OWNER_ID (round 45).
    store.openMode = () => true;
});
/** Round 45: a person's own runner is the only kind; these tests use the open server's. */
const personalToken = (label?: string) => store.createPersonalToken({ ownerId: OPEN_OWNER_ID, label: label ?? "", createdBy: "test" });
afterAll(() => {
    platform.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("agent tokens", () => {
    it("have the prefix, 32 random bytes, and only their hash is stored", () => {
        const a = newAgentToken();
        expect(a.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
        expect(a.length).toBe(AGENT_TOKEN_PREFIX.length + 43);
        expect(newAgentToken()).not.toBe(a);
        const { secret, record } = personalToken("  Maya's laptop ");
        expect(record.label).toBe("Maya's laptop");
        expect(record.hint).toBe(secret.slice(-4));
        const raw = JSON.stringify(platform.db.all("SELECT * FROM agent_tokens"));
        expect(raw).not.toContain(secret);
        expect(raw).toContain(hashToken(secret));
    });

    it("are found by the presented token only; unknown and retired look the same; each belongs to one person", () => {
        const { secret, record } = personalToken();
        expect(store.findToken(secret)?.id).toBe(record.id);
        expect(store.findToken(secret)?.ownerId).toBe(OPEN_OWNER_ID);
        expect(store.findToken(secret + "x")).toBeUndefined();
        expect(store.findToken("aitg_" + "A".repeat(43))).toBeUndefined();
        expect(store.retireToken(record.id)).toBe(true);
        expect(store.findToken(secret)).toBeUndefined();
        expect(store.retireToken(record.id)).toBe(false);
        // the row stays, marked retired
        expect(store.getToken(record.id)?.revokedAt).toBeTruthy();
    });

    it("last_used_at is written at most every 30 seconds", () => {
        const { record } = personalToken();
        store.touchToken(record.id);
        const first = store.getToken(record.id)!.lastUsedAt;
        expect(first).toBeTruthy();
        now += 10_000;
        store.touchToken(record.id);
        expect(store.getToken(record.id)!.lastUsedAt).toBe(first);
        now += 40_000;
        store.touchToken(record.id);
        expect(store.getToken(record.id)!.lastUsedAt).not.toBe(first);
    });

    it("the bearer header is read exactly", () => {
        const t = newAgentToken();
        expect(bearerToken(`Bearer ${t}`)).toBe(t);
        for (const bad of [undefined, "", t, `bearer ${t}`, `Bearer  ${t}`, `Bearer ${t} `, "Bearer aitg_short", "Bearer notours_" + "A".repeat(40), `Basic ${t}`]) expect(bearerToken(bad as string | undefined), String(bad)).toBeUndefined();
    });
});

describe("the six agent routes: exact, anchored match", () => {
    const id = "0b9e3c2a-1d4f-4a67-9d52-7c1e8a3b5f10";
    it("accepts exactly the protocol's method and path pairs", () => {
        const ok: Array<[string, string, string]> = [
            ["POST", "/api/agent/hello", "hello"],
            ["POST", "/api/agent/poll", "poll"],
            ["POST", `/api/agent/tasks/${id}/heartbeat`, "heartbeat"],
            ["GET", `/api/agent/tasks/${id}/files/baseline-1.png`, "download"],
            ["PUT", `/api/agent/tasks/${id}/files/WEB-001-failure.png`, "upload"],
            ["POST", `/api/agent/tasks/${id}/result`, "result"],
        ];
        for (const [m, p, kind] of ok) expect(agentRouteOf(m, p)?.kind, p).toBe(kind);
        expect(agentRouteOf("PUT", `/api/agent/tasks/${id}/files/a.png`)).toMatchObject({ taskId: id, name: "a.png" });
    });

    it("rejects the wrong method, trailing slashes, case changes, prefixes, doubled slashes and traversal", () => {
        const bad: Array<[string, string]> = [
            ["GET", "/api/agent/hello"],
            ["PUT", "/api/agent/hello"],
            ["POST", "/api/agent/hello/"],
            ["POST", "/api/agent/Hello"],
            ["POST", "/API/agent/hello"],
            ["POST", "/api/AGENT/hello"],
            ["POST", "/api/agent/hello/extra"],
            ["POST", "/api/agent/hellox"],
            ["POST", "//api/agent/hello"],
            ["POST", "/api//agent/hello"],
            ["POST", "/api/agent//hello"],
            ["POST", "/api/agent/poll/"],
            ["POST", " /api/agent/poll"],
            ["POST", "/api/agent/poll "],
            ["POST", "/x/api/agent/poll"],
            ["POST", "/api/agent/tasks/../hello"],
            ["POST", "/api/agent/tasks/abc/heartbeat"], // task ids are 8+ characters
            ["POST", `/api/agent/tasks/${id}/heartbeat/`],
            ["POST", `/api/agent/tasks/${id}/Heartbeat`],
            ["POST", `/api/agent/tasks/${id}/../../projects`],
            ["GET", `/api/agent/tasks/${id}/files/`],
            ["GET", `/api/agent/tasks/${id}/files/..`],
            ["GET", `/api/agent/tasks/${id}/files/../x`],
            ["GET", `/api/agent/tasks/${id}/files/a/b`],
            ["GET", `/api/agent/tasks/${id}/files/.hidden`],
            ["GET", `/api/agent/tasks/${id}/files/a\\b.png`],
            ["GET", `/api/agent/tasks/${id}/files/${"a".repeat(121)}`],
            ["PUT", `/api/agent/tasks/${id}/files/a.png/`],
            ["DELETE", `/api/agent/tasks/${id}/files/a.png`],
            ["POST", `/api/agent/tasks/${id}/files/a.png`],
            ["GET", "/api/agent"],
            ["GET", "/api/agent/"],
            ["GET", "/api/agents"],
            ["GET", "/api/projects/x/agents"],
            ["POST", "/api/agent/hello\n"],
            ["POST", "/api/agent/hello\u0000"],
            ["post", "/api/agent/hello"],
        ];
        for (const [m, p] of bad) expect(isAgentRoute(m, p), `${m} ${JSON.stringify(p)}`).toBe(false);
    });

    it("never treats an admin route as an agent route", () => {
        for (const p of ["/api/projects/p1/agent-tokens", "/api/projects/p1/runner", "/api/triggers/aitt_xxxxxxxxxxxxxxxxxxxxxxxx/run", "/api/config", "/api/artifacts/1"]) for (const m of ["GET", "POST", "PUT", "DELETE"]) expect(isAgentRoute(m, p)).toBe(false);
    });
});

describe("the task state machine", () => {
    const newTask = (over: { project?: string; job?: string; adapter?: string } = {}) => {
        const id = crypto.randomUUID();
        store.enqueue({ id, projectId: over.project ?? projectId, jobId: over.job ?? "job-" + id, adapterId: over.adapter ?? "playwright", payloadEnc: "enc", files: [], ownerId: OPEN_OWNER_ID });
        return id;
    };
    const agentFor = (name: string) => {
        const { record } = personalToken(name);
        return { token: record, agent: store.upsertAgent(record, hello(name)) };
    };
    const LEASE = 60_000;

    it("queued tasks are handed out first in, first out, per project", () => {
        const first = newTask();
        now += 5;
        const second = newTask();
        const elsewhere = newTask({ project: otherProject });
        expect(store.queued(projectId).map((t) => t.id).filter((id) => id === first || id === second)).toEqual([first, second]);
        expect(store.queued(otherProject).map((t) => t.id)).toContain(elsewhere);
        expect(store.queued(projectId).map((t) => t.id)).not.toContain(elsewhere);
    });

    it("exactly one agent claims a task; only the claiming agent can heartbeat or finish it; a result is accepted once", () => {
        const id = newTask();
        const a = agentFor("a");
        const b = agentFor("b");
        expect(store.claimFor(id, a.agent, LEASE)?.status).toBe("running");
        expect(store.claimFor(id, b.agent, LEASE)).toBeUndefined();
        expect(store.getTask(id)!.agentId).toBe(a.agent.id);
        expect(store.heartbeat(id, b.agent.id, LEASE, { done: 1 })).toBe(false);
        expect(store.heartbeat(id, a.agent.id, LEASE, { done: 1, total: 3, log: ["booting"] })).toBe(true);
        expect(store.getTask(id)).toMatchObject({ progress: { done: 1, total: 3 }, log: ["booting"] });
        expect(store.finish(id, b.agent.id, { status: "done", resultEnc: "x" })).toBe(false);
        expect(store.finish(id, a.agent.id, { status: "done", resultEnc: "x" })).toBe(true);
        expect(store.finish(id, a.agent.id, { status: "done", resultEnc: "y" })).toBe(false);
        expect(store.getTask(id)).toMatchObject({ status: "done", resultEnc: "x" });
        expect(store.heartbeat(id, a.agent.id, LEASE, {})).toBe(false);
    });

    it("a task whose lease ran out is offered once more, then fails (and a lost agent can no longer answer)", () => {
        const id = newTask();
        const a = agentFor("lost");
        store.claimFor(id, a.agent, LEASE);
        now += LEASE - 1;
        expect(store.sweep().requeued).toBe(0);
        now += 2;
        expect(store.sweep().requeued).toBeGreaterThanOrEqual(1);
        const q = store.getTask(id)!;
        expect(q).toMatchObject({ status: "queued", agentId: null, offers: 1 });
        // the old agent is no longer the owner
        expect(store.finish(id, a.agent.id, { status: "done", resultEnc: "late" })).toBe(false);
        // second offer (to another agent), lost again: now it fails with a plain message
        const b = agentFor("second");
        expect(store.claimFor(id, b.agent, LEASE)?.offers).toBe(MAX_OFFERS);
        now += LEASE + 1;
        const swept = store.sweep();
        expect(swept.failed).toBeGreaterThanOrEqual(1);
        expect(store.getTask(id)).toMatchObject({ status: "failed" });
        expect(store.getTask(id)!.error).toMatch(/stopped responding/);
    });

    it("a heartbeat keeps the lease alive", () => {
        const id = newTask();
        const a = agentFor("steady");
        store.claimFor(id, a.agent, LEASE);
        for (let i = 0; i < 4; i++) {
            now += LEASE - 5_000;
            expect(store.heartbeat(id, a.agent.id, LEASE, {})).toBe(true);
            store.sweep();
        }
        expect(store.getTask(id)!.status).toBe("running");
    });

    it("cancel: a queued task ends at once, a running one is stopped through the agent and then ends as cancelled", () => {
        const q = newTask();
        store.requestCancel(q);
        expect(store.getTask(q)!.status).toBe("cancelled");
        const id = newTask();
        const a = agentFor("cancelled");
        store.claimFor(id, a.agent, LEASE);
        store.requestCancel(id);
        expect(store.getTask(id)).toMatchObject({ status: "running", cancelRequested: true });
        // the agent answers ok=false: recorded as cancelled, never as a failure of the tests
        expect(store.finish(id, a.agent.id, { status: "failed", error: "stopped" })).toBe(true);
        expect(store.getTask(id)!.status).toBe("cancelled");
        // an agent that never answers: the lease ends it as cancelled instead of re-offering it
        const lost = newTask();
        const b = agentFor("silent");
        store.claimFor(lost, b.agent, LEASE);
        store.requestCancel(lost);
        now += LEASE + 1;
        store.sweep();
        expect(store.getTask(lost)!.status).toBe("cancelled");
    });

    it("a task nobody picked up for 30 minutes fails; a task whose job is over is cancelled", async () => {
        const stale = newTask();
        now += QUEUE_MAX_MS + 1;
        store.sweep();
        expect(store.getTask(stale)).toMatchObject({ status: "failed", error: "No runner agent picked up this run within 30 minutes." });

        const job = await platform.repo.createJob(projectId, platform.repo.createApplication(projectId, "http://example.test", { ...DEFAULT_JOB_OPTIONS }, undefined), { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const t = newTask({ job: job.id });
        store.sweep();
        expect(store.getTask(t)!.status).toBe("queued"); // the job is still queued
        platform.repo.setJobStatus(job.id, "FAILED", "Cancelled");
        store.sweep();
        expect(store.getTask(t)!.status).toBe("cancelled");
    });

    it("a task that ran longer than the queue limit and lost its runner is offered again, not failed as never picked up", () => {
        const id = newTask();
        const a = agentFor("long-run");
        store.claimFor(id, a.agent, LEASE);
        // The runner works on it, beating, for longer than a task may wait in the queue.
        for (let ran = 0; ran <= QUEUE_MAX_MS; ran += LEASE - 5_000) {
            now += LEASE - 5_000;
            expect(store.heartbeat(id, a.agent.id, LEASE, {})).toBe(true);
        }
        // Then it goes silent: the sweep puts the task back for its one re-offer.
        now += LEASE + 1;
        store.sweep();
        expect(store.getTask(id)).toMatchObject({ status: "queued", offers: 1 });
        // It still waits in the queue its full time from being put back, and only then times out.
        now += QUEUE_MAX_MS - 1;
        store.sweep();
        expect(store.getTask(id)!.status).toBe("queued");
        now += 2;
        store.sweep();
        expect(store.getTask(id)).toMatchObject({ status: "failed", error: "No runner agent picked up this run within 30 minutes." });
    });

    it("finished tasks are removed after 24 hours, with their files listed for removal; long-gone agents are forgotten", () => {
        const id = newTask();
        const a = agentFor("prune");
        store.claimFor(id, a.agent, LEASE);
        store.addFile({ taskId: id, direction: "out", ref: "shot.png", path: "p/_agent/x/out/shot.png", size: 3, sha256: "0".repeat(64) });
        store.finish(id, a.agent.id, { status: "done", resultEnc: "r" });
        expect(store.pruneTasks().map((t) => t.id)).not.toContain(id);
        now += TASK_KEEP_MS + 1;
        const pruned = store.pruneTasks();
        expect(pruned.map((t) => t.id)).toContain(id);
        expect(store.getTask(id)).toBeUndefined();
        expect(store.getFile(id, "out", "shot.png")).toBeUndefined();
        expect(store.pruneAgents()).toBeGreaterThanOrEqual(0);
        now += 31 * 24 * 3600_000;
        expect(store.pruneAgents()).toBeGreaterThan(0);
    });

    it("the registry: hello creates or refreshes one agent per token and name; online means seen in the last 45 seconds", () => {
        const owner = "registry-owner";
        const { record } = store.createPersonalToken({ ownerId: owner, label: "reg", createdBy: "test" });
        const one = store.upsertAgent(record, hello("same"));
        const again = store.upsertAgent(record, { ...hello("same", caps({ browsers: ["chromium", "firefox"] })), version: "2.0.0" });
        expect(again.id).toBe(one.id);
        expect(again.version).toBe("2.0.0");
        expect(again.capabilities.browsers).toEqual(["chromium", "firefox"]);
        expect(store.runnerOf(owner)).toMatchObject({ online: true, agent: { id: one.id } });
        now += ONLINE_MS + 1;
        expect(store.runnerOf(owner)!.online).toBe(false);
        store.touchAgent(one.id);
        expect(store.runnerOf(owner)!.online).toBe(true);
        // never anyone else's
        expect(store.runnerOf("someone-else")).toBeUndefined();
    });

    it("the runner setting defaults to the platform and is kept per project; a pinned runner is no longer read (round 45)", () => {
        expect(store.getRunner(projectId)).toEqual({ runOn: "platform", agentId: null });
        store.setRunner(projectId, { runOn: "agent", agentId: "abc" });
        expect(store.getRunner(projectId)).toEqual({ runOn: "agent", agentId: null });
        expect(store.getRunner(otherProject).runOn).toBe("platform");
        store.setRunner(projectId, { runOn: "platform", agentId: "abc" });
        expect(store.getRunner(projectId)).toEqual({ runOn: "platform", agentId: null });
    });
});

describe("what an agent needs to run an adapter", () => {
    const adapter = (id: string) => getAdapter(id);
    it("web and API need an installed browser; the web adapter needs chromium specifically", () => {
        expect(capabilityProblem(adapter("playwright"), caps())).toBeUndefined();
        expect(capabilityProblem(adapter("playwright-api"), caps())).toBeUndefined();
        expect(capabilityProblem(adapter("playwright"), caps({ browsers: [] }))).toMatch(/no browsers installed/);
        expect(capabilityProblem(adapter("playwright-api"), caps({ browsers: [] }))).toMatch(/no browsers installed/);
        expect(capabilityProblem(adapter("playwright"), caps({ browsers: ["firefox"] }))).toMatch(/chromium/);
    });
    it("mobile needs adb and a phone or an emulator", () => {
        const t = adapter("taqwright");
        expect(capabilityProblem(t, caps())).toMatch(/Android tools/);
        expect(capabilityProblem(t, caps({ android: { adb: false, devices: [], avds: [] } }))).toMatch(/Android tools/);
        expect(capabilityProblem(t, caps({ android: { adb: true, devices: [], avds: [] } }))).toMatch(/no Android phone connected/);
        expect(capabilityProblem(t, caps({ android: { adb: true, devices: [{ serial: "R58", state: "unauthorized", emulator: false }], avds: [] } }))).toMatch(/no Android phone connected/);
        expect(capabilityProblem(t, caps({ android: { adb: true, devices: [{ serial: "R58", state: "device", emulator: false }], avds: [] } }))).toBeUndefined();
        expect(capabilityProblem(t, caps({ android: { adb: true, devices: [], avds: ["Pixel_7"] } }))).toBeUndefined();
    });
    it("iOS needs a Mac with Xcode, an iOS simulator and the XCUITest driver, and Windows needs are refused plainly elsewhere", () => {
        const fake = { id: "x", runtime: "x", needs: { node: true, ios: true } };
        expect(capabilityProblem(fake, caps({ ios: { xcode: true, simulators: [] } }))).toBe("it is not a Mac");
        expect(capabilityProblem(fake, caps({ os: "darwin", ios: { xcode: true, simulators: ["iPhone 15 (Shutdown)"], iosSimulators: 1, xcuitest: true } }))).toBeUndefined();
        expect(capabilityProblem(fake, caps({ os: "darwin", ios: { xcode: true, simulators: [] } }))).toMatch(/simulator/);
        expect(capabilityProblem({ ...fake, needs: { node: true, windows: true } }, caps())).toMatch(/Windows/);
    });
    it("every registered adapter can be judged", () => {
        for (const a of listAdapters()) expect(() => capabilityProblem(a, caps())).not.toThrow();
    });
});

describe("a run's environment on the wire", () => {
    const env: RunEnv = {
        baseUrl: "http://10.0.0.5:3000",
        apiBaseUrl: "http://10.0.0.5:3000/api",
        credentials: { username: "u", password: "pw-pw-1", totpSecret: "KRSXG5CTMVRXEZLU" },
        roles: [{ name: "admin", username: "a", password: "pw-pw-2", apiToken: "tok-tok-3" }],
        apiToken: "tok-tok-4",
        apiAuthHeader: "X-Key: key-key-5",
        vars: { REGION: "eu" },
        cleanup: "platform",
        headless: true,
        // The saved sign-in travels like the credentials (see src/engine/auth/run-session.ts).
        storageState: '{"cookies":[],"origins":[]}',
    };
    it("round-trips against the protocol's schema, with cleanup moved to the agent", () => {
        const wire = toWireEnv(env);
        expect(WireRunEnv.parse(wire)).toEqual(wire);
        expect(wire).toMatchObject({ baseUrl: env.baseUrl, apiBaseUrl: env.apiBaseUrl, credentials: env.credentials, roles: env.roles, apiToken: "tok-tok-4", apiAuthHeader: "X-Key: key-key-5", vars: { REGION: "eu" }, cleanup: "agent", headless: true });
        expect(toWireEnv({ ...env, cleanup: "off" }).cleanup).toBe("off");
        expect(toWireEnv({ ...env, cleanup: undefined }).cleanup).toBeUndefined();
        expect(toWireEnv({ baseUrl: "http://x.test", headless: false })).toEqual({ baseUrl: "http://x.test", headless: false });
    });
    it("RunEnv and WireRunEnv have the same keys (kept in sync)", () => {
        const wireKeys = Object.keys(WireRunEnv.shape).sort();
        const runKeys = Object.keys(toWireEnv(env)).sort();
        expect(runKeys).toEqual(wireKeys);
    });
    it("a whole task offer is valid for the protocol", () => {
        const offer = TaskOffer.parse({ taskId: "t1", jobId: "j1", adapterId: "playwright", leaseSeconds: 60, workers: 2, scripts: [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "// x", baselines: [{ name: "home.png", file: { ref: "b0-aaaaaaaaaaaa.png", size: 3, sha256: "a".repeat(64) } }] }], env: toWireEnv(env) });
        expect(offer.scripts).toHaveLength(1);
        expect(() => TaskOffer.parse({ ...offer, scripts: [{ testId: "x", filename: "../evil.ts", content: "" }] })).toThrow();
    });
    it("a Capabilities object from a real machine passes the schema", () => {
        expect(() => Capabilities.parse(caps({ android: { adb: true, devices: [{ serial: "emulator-5554", state: "device", emulator: true }], avds: ["Pixel_7"] } }))).not.toThrow();
    });
});

describe("paths, secrets, limits", () => {
    it("a client-supplied name is only ever joined to a folder after it passes the safe-name rule", () => {
        const base = path.join(dataDir, "task", "out");
        expect(anchoredPath(base, "shot-1.png")).toBe(path.join(base, "shot-1.png"));
        for (const bad of ["..", "../x", "..\\x", "a/b", "a\\b", ".hidden", "", " a", "a ", "a\u0000b", "C:\\x", "/etc/passwd", "con:", "a".repeat(121), "x/../../y"]) expect(() => anchoredPath(base, bad), JSON.stringify(bad)).toThrow();
    });

    it("scrubs every secret of the run wherever it appears, including nested values", () => {
        const secrets = envSecrets({ credentials: { username: "someone", password: "pw-SECRET-1", totpSecret: "KRSXG5CTMVRXEZLU" }, roles: [{ name: "a", username: "a", password: "pw-SECRET-2", apiToken: "tok-SECRET-3" }], apiToken: "tok-SECRET-4", apiAuthHeader: "X-Key: key-SECRET-5" });
        expect(secrets).toEqual(expect.arrayContaining(["pw-SECRET-1", "KRSXG5CTMVRXEZLU", "tok-SECRET-3", "tok-SECRET-4", "key-SECRET-5", "X-Key: key-SECRET-5"]));
        expect(secrets).not.toContain("someone");
        const dirty = { error: "login failed for pw-SECRET-1 and tok-SECRET-4", steps: [{ error: "sent X-Key: key-SECRET-5" }], deep: { a: ["pw-SECRET-2"], n: 4, ok: true } };
        const clean = scrubSecrets(dirty, secrets);
        const text = JSON.stringify(clean);
        for (const s of secrets) expect(text).not.toContain(s);
        expect(clean.error).toBe("login failed for [hidden] and [hidden]");
        expect(clean.deep).toEqual({ a: ["[hidden]"], n: 4, ok: true });
        // short strings are not secrets
        expect(scrubSecrets("abc", ["abc"])).toBe("abc");
    });

    it("rate limits are per key and slide", () => {
        let t = 0;
        const rl = new RateLimiter(3, 1000, () => t);
        expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true, false]);
        expect(rl.take("b")).toBe(true);
        t = 1001;
        expect(rl.take("a")).toBe(true);
    });

    it("the limits come from the environment, clamped", () => {
        expect(agentLimits({}).pollSeconds).toBe(25);
        expect(agentLimits({ AGENT_POLL_SECONDS: "1" }).pollSeconds).toBe(1);
        expect(agentLimits({ AGENT_POLL_SECONDS: "9999" }).pollSeconds).toBe(55);
        expect(agentLimits({ AGENT_MAX_FILE_BYTES: "nope" }).maxFileBytes).toBe(64 * 1024 * 1024);
        expect(agentLimits({ AGENT_MAX_FILE_BYTES: "1" }).maxFileBytes).toBe(1024);
        expect(agentLimits({}).leaseSeconds).toBe(60);
    });
});

describe("the cleanup ledger an agent reports", () => {
    it("keeps lines that say what became of a record, with the platform's own test id and a normalised shape", () => {
        const items = ledgerFromAgent(
            [
                { testId: "OTHER-9", method: "POST", path: "/things", id: "7", deletePath: "/things/7", status: "removed", createdAt: "2026-01-01T10:00:00Z" },
                { path: "/things", id: "8", status: "failed", reason: "The application answered HTTP 500." },
                { path: "/things", id: "9", status: "no-delete-operation" },
            ],
            "API-003",
            { origin: "http://10.0.0.5:3000", environment: "staging" },
            10,
        );
        expect(items.map((i) => [i.testId, i.seq, i.id, i.status, i.deletePath])).toEqual([
            ["API-003", 10, "7", "removed", "/things/7"],
            ["API-003", 11, "8", "failed", undefined],
            ["API-003", 12, "9", "no-delete-operation", undefined],
        ]);
        expect(items[0]).toMatchObject({ origin: "http://10.0.0.5:3000", environment: "staging", createdAt: "2026-01-01T10:00:00.000Z" });
    });
    it("a raw created line (never removed) is kept as failed, so the record is not forgotten", () => {
        const [i] = ledgerFromAgent([{ k: "created", path: "/things", id: "5", at: "2026-01-01T10:00:00Z" }, { k: "deleted", path: "/things/5", status: 204 }], "API-001", {}, 0);
        expect(i).toMatchObject({ id: "5", status: "failed" });
        expect(i!.reason).toMatch(/did not say/);
    });
    it("drops anything that is not a safe path, an id or a known status", () => {
        const items = ledgerFromAgent(
            [
                { path: "//evil.test/x", id: "1", status: "removed" },
                { path: "/ok", id: "bad\nid", status: "removed" },
                { path: "/ok", id: "x".repeat(201), status: "removed" },
                { path: "/ok", id: "1", status: "weird" },
                { path: "/ok", id: "2", status: "removed", deletePath: "https://evil.test/x" },
                { path: "relative", id: "3", status: "removed" },
                null as never,
                "string" as never,
            ],
            "API-001",
            {},
            0,
        );
        expect(items.map((i) => [i.id, i.deletePath])).toEqual([["2", undefined]]);
    });
});
