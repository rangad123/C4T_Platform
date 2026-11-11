/**
 * Runner updates end to end: a REAL platform serving runner version B and REAL runners of version A, both built from this checkout with
 * build:runner into temp folders under two different version strings (so every program file differs), both trusting a TEST update key and
 * signed with it (round 39: a runner installs only a signed update). The runner downloads come through the person's own route
 * (POST /api/me/runner/download, round 45) and trade their one-time code at the first start; node_modules is a junction to this
 * repository's (nothing is installed). Settings (GET /api/me/runner) shows the runner's update state.
 *
 *  - start-runner.cmd (Windows) runs a runner of version A; while it runs a slow API test the platform moves to B; the test finishes and
 *    its result is stored, then the runner updates itself, exits 75, the script starts the new version at once, and it runs another test;
 *    Settings says "updated", Activity has a row, and the files are B's.
 *  - A file damaged on the way (a relay between runner and platform flips one byte) is refused: nothing changes, Settings says why and
 *    when it tries again, and the runner keeps running tests on version A.
 *  - `--rollback` by hand back to A: the runner then stays on A (the version it went back from is not tried again by itself) until the
 *    person chooses "Update now" in Settings (POST /api/me/runner/update).
 *
 * Browser lock (a platform server and runners): node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-update.test.ts
 * Ports: platform 8809, fixture application 8810, relay 8811.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { generateKeyPairSync } from "node:crypto";
import { getAgentServices } from "../src/platform/agent-services.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { allowPrivateAddresses, downloadRunner, myOnlineRunner, personToken, retireMyRunner } from "./fixtures/runner-person.js";
// @ts-expect-error plain JavaScript script (no type declarations)
import { publicKeyOf, signUpdate } from "../scripts/sign-runner-update.mjs";
import { Worker } from "../src/platform/worker.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLATFORM_PORT = 8809;
const APP_PORT = 8810;
const RELAY_PORT = 8811;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "upd-admin-key-5c2e81f0a3";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "RUNNER_KIT_DIR", "RUNNER_COMPLETE_DIR", "RUNNER_INSTALLER_DIR", "RUNNER_KIT_RATE_PER_MINUTE", "RUNNER_UPDATE_PUBLIC_KEYS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let tmp: string;
let bundleA: string;
let bundleB: string;
let versionA: string;
let versionB: string;
let appServer: http.Server;
let relay: http.Server;
const children: ChildProcess[] = [];
const links: string[] = [];

/** The person whose runner this is (an owner with their own API token, made in beforeAll). */
let person = { id: "", token: "" };
let stopBeat: (() => void) | undefined;
/** The runner takes the computer's own name (the download names none). */
const NAME = os.hostname().trim().slice(0, 64) || "agent";
/** A TEST update key: both bundles trust it and are signed with it, each signature with a larger sequence. */
const TEST_KEY = generateKeyPairSync("ed25519");
const TEST_PEM = TEST_KEY.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
let sequence = 2_000_000;
const sign = (dir: string) => signUpdate({ kitDir: dir, privateKeyPem: TEST_PEM, sequence: ++sequence });
const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${person.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    return { status: res.status, headers: res.headers, buf, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; headers: Headers; buf: Buffer; text: string; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, ms = 90_000, more?: () => string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}${more ? `\n${more()}` : ""}`);
        await sleep(250);
    }
}

function unpack(zip: Buffer, label: string): string {
    const root = fs.mkdtempSync(path.join(tmp, `${label}-`));
    let top = "";
    for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip)))) {
        top = name.split("/")[0]!;
        const dest = path.join(root, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
    }
    const kit = path.join(root, top);
    const link = path.join(kit, "node_modules");
    fs.symlinkSync(path.join(REPO, "node_modules"), link, "junction");
    links.push(link);
    return kit;
}

interface Running {
    child: ChildProcess;
    out: string[];
    exited: Promise<number | null>;
}
function launch(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Running {
    const overridden = new Set(Object.keys(extraEnv).map((k) => k.toUpperCase()));
    const inherited = Object.entries(process.env).filter(([k]) => !overridden.has(k.toUpperCase()));
    const env: NodeJS.ProcessEnv = Object.fromEntries([...inherited, ...Object.entries(extraEnv)].filter(([k]) => !/^(AGENT_|RUNNER_KIT_|RUNNER_COMPLETE_)/.test(k)));
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const out: string[] = [];
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => out.push(String(d)));
    return { child, out, exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
}
const output = (r: Running) => r.out.join("");
function killOurs(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
}

type AgentRow = { id: string; name: string; online: boolean; activeTasks: number; capabilities: { kitVersion?: string }; update?: { can: boolean; auto: boolean; latest?: string; outOfDate: boolean; requested: boolean; state?: string; error?: string; retryAt?: string; from?: string; to?: string } };
/** The person's runner while it is connected, as Settings shows it, with the kit version its runner process reports (from the platform's store). */
const onlineAgent = async (_p?: string): Promise<AgentRow | undefined> => {
    const mine = (await myOnlineRunner(BASE, person.token)) as (Awaited<ReturnType<typeof myOnlineRunner>> & { currentRun?: unknown }) | undefined;
    if (!mine) return undefined;
    const a = getAgentServices(platform).store.agentsOfToken(mine.id)[0];
    return { id: mine.id, name: mine.name, online: true, activeTasks: mine.currentRun ? 1 : 0, capabilities: { kitVersion: a?.capabilities.kitVersion }, update: mine.update as AgentRow["update"] };
};

/** The person's download (Windows plain files: no installer or complete build here). One runner per person: the last test's is removed first. */
async function newKit(projectName: string, label: string) {
    const p = (await admin("POST", "/api/projects", { name: projectName })).body.id as string;
    expect((await admin("PUT", `/api/projects/${p}/review-policy`, { aiGenerated: false, edits: false, healing: false })).status).toBe(200);
    await retireMyRunner(BASE, person.token);
    const dl = await downloadRunner(BASE, person.token, "windows");
    expect(dl.status, dl.text).toBe(200);
    const kit = unpack(dl.buf, label);
    return { p, kit, code: fs.readFileSync(path.join(kit, "runner.enroll"), "utf8").trim() };
}

/** An API test against the fixture (optionally a slow one), its runs sent to the runner; returns the test id. */
async function apiTest(p: string, slow: boolean): Promise<string> {
    const specs = [{ title: slow ? "The slow endpoint answers" : "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: slow ? "/slow" : "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] }];
    const imp = await admin("POST", `/api/projects/${p}/specs`, { baseUrl: APP, validate: false, specs });
    expect(imp.status, imp.text).toBe(202);
    // No runner is chosen: the run goes to the person's own runner. The fixture is on this computer: private addresses on.
    expect(await allowPrivateAddresses(BASE, person.token)).toBe(200);
    return (imp.body.tests as Array<{ id: string }>)[0]!.id;
}
async function startRun(testId: string): Promise<string> {
    const started = await admin("POST", `/api/tests/${testId}/validate`);
    expect(started.status, started.text).toBe(202);
    return started.body.jobId as string;
}
async function finished(jobId: string, testId: string) {
    const job = await until("the job to finish", async () => {
        const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
        return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
    }, 180_000);
    return { job, execution: ((await admin("GET", `/api/tests/${testId}/executions`)).body as Array<{ status: string; error?: string }>)[0]! };
}
const activity = async (_p?: string) => ((await admin("GET", "/api/activity?limit=100")).body.activity as Array<{ action: string; detail: string | null; actor: { kind: string; name: string } }>);
const fileOf = (dir: string, f: string) => fs.readFileSync(path.join(dir, f));

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "30", RUNNER_KIT_RATE_PER_MINUTE: "50" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-upd-"));
    bundleA = path.join(tmp, "bundle-a");
    bundleB = path.join(tmp, "bundle-b");
    const updateKeys = [publicKeyOf(TEST_KEY.privateKey).raw];
    versionA = (await buildRunner({ outDir: bundleA, platformVersion: "9.1.0", updateKeys })).kitVersion;
    versionB = (await buildRunner({ outDir: bundleB, platformVersion: "9.2.0", updateKeys })).kitVersion;
    sign(bundleA);
    sign(bundleB);
    // The platform trusts the same test key (the runners have it built in), so it offers the signed update.
    process.env.RUNNER_UPDATE_PUBLIC_KEYS = updateKeys.join(",");
    expect(versionA).not.toBe(versionB);
    expect(fileOf(bundleA, "runner.mjs").equals(fileOf(bundleB, "runner.mjs"))).toBe(false);
    process.env.RUNNER_KIT_DIR = bundleA;
    process.env.RUNNER_COMPLETE_DIR = path.join(tmp, "no-complete");
    process.env.RUNNER_INSTALLER_DIR = path.join(tmp, "no-installer");
    appServer = http.createServer((req, res) => {
        const answer = () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        if (req.url === "/slow") return void setTimeout(answer, 6000);
        answer();
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    // Stands between a runner and the platform and damages one update file on the way (one bit of its last byte).
    relay = http.createServer((req, res) => {
        const up = http.request({ host: "127.0.0.1", port: PLATFORM_PORT, path: req.url, method: req.method, headers: req.headers }, (ur) => {
            res.writeHead(ur.statusCode ?? 502, ur.headers);
            if (req.url !== "/api/agent/update/files/task-child.mjs") return void ur.pipe(res);
            const parts: Buffer[] = [];
            ur.on("data", (c: Buffer) => parts.push(c));
            ur.on("end", () => {
                const b = Buffer.concat(parts);
                if (b.length) b[b.length - 1] = b[b.length - 1]! ^ 1;
                res.end(b);
            });
        });
        up.on("error", () => res.destroy());
        req.pipe(up);
    });
    await new Promise<void>((r) => relay.listen(RELAY_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-upd-data-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: BASE, CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", EXECUTION_MODE: "runners" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
    // EXECUTION_MODE=runners takes runs only while the part that hands them to runners is alive.
    stopBeat = startHeartbeat(platform.db);
    person = personToken(server);
}, 240_000);

afterAll(async () => {
    for (const c of children) killOurs(c);
    await sleep(500);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    stopBeat?.();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    await new Promise((r) => relay.close(r));
    for (const l of links) {
        try {
            fs.rmdirSync(l);
        } catch {
            /* already gone */
        }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch {
        /* the operating system cleans the temp folder later */
    }
    if (!fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))) throw new Error("The repository's node_modules was damaged by the cleanup");
});

describe("a runner keeps itself up to date", () => {
    it.skipIf(process.platform !== "win32")("updates between tasks: the running test finishes and is stored, then it switches, start-runner.cmd starts the new version at once", async () => {
        process.env.RUNNER_KIT_DIR = bundleA;
        const { p, kit, code: token } = await newKit("Updates between tasks", "cmd");
        const run = launch("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1" });
        const first = await until("the runner on version A to be online", () => onlineAgent(p), 120_000, () => output(run));
        expect(first.capabilities.kitVersion).toBe(versionA);
        expect(first.update).toMatchObject({ can: true, auto: true, latest: versionA, outOfDate: false });

        // A slow test starts on version A. While it runs, the platform moves to version B.
        const slow = await apiTest(p, true);
        const job = await startRun(slow);
        await until("the runner to take the task", async () => (await onlineAgent(p))?.activeTasks === 1, 60_000, () => output(run));
        process.env.RUNNER_KIT_DIR = bundleB;
        const { job: done, execution } = await finished(job, slow);
        expect(done.ranOn).toMatchObject({ kind: "agent", name: NAME });
        expect(execution.status, execution.error).toBe("passed");

        const updated = await until("the runner on version B", async () => {
            const a = await onlineAgent(p);
            return a?.capabilities.kitVersion === versionB && a.update?.state === "updated" ? a : undefined;
        }, 180_000, () => output(run));
        expect(updated.update).toMatchObject({ can: true, outOfDate: false, latest: versionB, from: versionA, to: versionB });
        const text = output(run);
        expect(text).toContain(`The platform runs runner version ${versionB} (this runner: ${versionA})`);
        expect(text).toContain(`Switched to version ${versionB}`);
        expect(text).toContain("The runner updated itself. Starting the new version.");
        expect(text).not.toContain("stopped unexpectedly");
        expect(text).toContain(`This runner updated itself from version ${versionA} to ${versionB}.`);
        // The switch came after the running test had finished (its result was stored first).
        // The platform moved to B while the slow test ran; the runner switched only after that test's result was sent.
        const noticed = text.indexOf(`The platform runs runner version ${versionB}`);
        const sent = text.search(/Task \S+: result sent \(ok\)/);
        const switched = text.indexOf("Switched to version");
        expect(sent, text).toBeGreaterThan(-1);
        expect(switched).toBeGreaterThan(sent);
        expect(text.indexOf("Task ")).toBeLessThan(noticed);
        for (const f of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) expect(fileOf(kit, f).equals(fileOf(bundleB, f)), f).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8"))).toMatchObject({ url: BASE, kitVersion: versionB });
        expect(fileOf(path.join(kit, ".update", "previous"), "runner.mjs").equals(fileOf(bundleA, "runner.mjs"))).toBe(true);
        const rows = await activity(p);
        expect(rows.find((r) => r.action === "runner-updated")).toMatchObject({ actor: { kind: "runner", name: NAME }, detail: `Runner “${NAME}” updated itself from ${versionA} to ${versionB}.` });

        // The new version runs tests.
        const quick = await apiTest(p, false);
        const after = await finished(await startRun(quick), quick);
        expect(after.execution.status, after.execution.error).toBe("passed");
        expect(output(run)).not.toContain(token);
        killOurs(run.child);
    }, 600_000);

    it("refuses a file damaged on the way: nothing changes, the row says why and when it tries again, and tests still run on version A", async () => {
        process.env.RUNNER_KIT_DIR = bundleA;
        const { p, kit } = await newKit("Damaged update", "damaged");
        const before = fileOf(kit, "task-child.mjs");
        const run = launch(process.execPath, ["runner.mjs"], kit, { AITP_URL: `http://127.0.0.1:${RELAY_PORT}` });
        await until("the runner to be online", () => onlineAgent(p), 120_000, () => output(run));
        process.env.RUNNER_KIT_DIR = bundleB;
        const failed = await until("the update to fail", async () => {
            const a = await onlineAgent(p);
            return a?.update?.state === "failed" ? a : undefined;
        }, 120_000, () => output(run));
        expect(failed.capabilities.kitVersion).toBe(versionA);
        expect(failed.update).toMatchObject({ outOfDate: true, to: versionB, error: "The file task-child.mjs of the update arrived damaged (its size or checksum does not match what the platform announced). Nothing was changed." });
        expect(Date.parse(failed.update!.retryAt!)).toBeGreaterThan(Date.now() + 4 * 60_000);
        expect(fileOf(kit, "task-child.mjs").equals(before)).toBe(true);
        expect(fs.existsSync(path.join(kit, ".update", "next"))).toBe(false);
        expect(output(run)).toContain(`Could not update to version ${versionB}`);
        const rows = await activity(p);
        expect(rows.find((r) => r.action === "runner-update-failed")?.detail).toContain(`Still on version ${versionA}`);
        // Backing off, it takes work again on version A.
        const t = await apiTest(p, false);
        const r = await finished(await startRun(t), t);
        expect(r.execution.status, r.execution.error).toBe("passed");
        expect(run.child.exitCode).toBeNull();
        killOurs(run.child);
    }, 400_000);

    it("--rollback goes back by hand and stays there, until the person chooses Update now in Settings", async () => {
        process.env.RUNNER_KIT_DIR = bundleA;
        const { p, kit } = await newKit("Rollback", "rollback");
        // Not on the newest version yet: "Update now" says so plainly.
        let run = launch(process.execPath, ["runner.mjs"], kit);
        await until("the runner to be online", () => onlineAgent(p), 120_000, () => output(run));
        const already = await admin("POST", "/api/me/runner/update");
        expect(already.status).toBe(409);
        expect(already.body.error).toMatch(/already on version/);

        // The platform moves to B: the runner updates itself (this test is the launcher: the runner exits 75 and is started again).
        process.env.RUNNER_KIT_DIR = bundleB;
        expect(await Promise.race([run.exited, sleep(120_000).then(() => "timeout")]), output(run)).toBe(75);
        run = launch(process.execPath, ["runner.mjs"], kit);
        await until("the runner on version B", async () => {
            const x = await onlineAgent(p);
            return x?.capabilities.kitVersion === versionB && x.update?.state === "updated" ? x : undefined;
        }, 120_000, () => output(run));

        // Back by hand: stop it, --rollback, start it again on A. The platform does not push B again by itself.
        killOurs(run.child);
        await run.exited;
        const back = spawnSync(process.execPath, ["runner.mjs", "--rollback"], { cwd: kit, encoding: "utf8", windowsHide: true, timeout: 60_000 });
        expect(back.status, back.stderr).toBe(0);
        expect(back.stdout).toContain(`Went back from version ${versionB} to version ${versionA}`);
        expect(fileOf(kit, "runner.mjs").equals(fileOf(bundleA, "runner.mjs"))).toBe(true);
        run = launch(process.execPath, ["runner.mjs"], kit);
        const c = await until("the runner back on version A", async () => {
            const x = await onlineAgent(p);
            return x?.capabilities.kitVersion === versionA && x.update?.state === "rolled-back" ? x : undefined;
        }, 120_000, () => output(run));
        expect(c.update).toMatchObject({ outOfDate: true, to: versionB, error: "Rolled back by hand (--rollback)." });
        expect((await activity(p)).some((r) => r.action === "runner-rolled-back")).toBe(true);
        await sleep(6000);
        expect((await onlineAgent(p))?.capabilities.kitVersion).toBe(versionA);

        // "Update now" in Settings: the runner takes B again.
        const asked = await admin("POST", "/api/me/runner/update");
        expect(asked.status, asked.text).toBe(200);
        expect(asked.body.runner.update).toMatchObject({ requested: true, outOfDate: true });
        expect(await Promise.race([run.exited, sleep(120_000).then(() => "timeout")]), output(run)).toBe(75);
        run = launch(process.execPath, ["runner.mjs"], kit);
        await until("the runner on version B again", async () => {
            const x = await onlineAgent(p);
            return x?.capabilities.kitVersion === versionB && x.update?.state === "updated" ? x : undefined;
        }, 120_000, () => output(run));
        killOurs(run.child);
    }, 600_000);
});
