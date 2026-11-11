/**
 * A runner with no Android tools at all gets Google's phone tools itself when a phone session arrives, against a REAL platform on real HTTP and
 * the REAL agent program, with a LOCAL stand-in for dl.google.com (the real address is never contacted):
 *  - it says so in its capabilities ("can-fetch") and may therefore host a phone session;
 *  - the session arrives, the runner fetches the list and the archive once, checks them, unpacks adb into its own work folder and points
 *    ANDROID_HOME there; the person sees each step and the "Allow USB debugging" steps;
 *  - this computer has no real adb, so the stand-in adb.exe cannot start: the session ends with that plain sentence (not a test verdict);
 *  - afterwards it reports the tools as ready, and a restart uses them without downloading again.
 * Browser-free (the agent's browser choice is switched off). Ports: platform 6911, stand-in Google 6912.
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-tools-agent.test.ts
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { DeviceSessionError } from "../src/engine/mobile/device/errors.js";
import { deviceOptions, openDeviceSession } from "../src/platform/agent-device.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6911;
const GOOGLE_PORT = 6912;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = `http://127.0.0.1:${GOOGLE_PORT}/android/repository/`;
const API_KEY = "phone-tools-admin-key-81c2";
const SHOP = "com.example.shop";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let google: http.Server;
let dataDir: string;
let work: string;
const googleRequests: Array<{ url: string; auth: boolean }> = [];
const sentByAgent: string[] = [];

const zip = Buffer.from(zipSync({ "platform-tools/adb.exe": Buffer.from("not a real program"), "platform-tools/adb": Buffer.from("not a real program"), "platform-tools/NOTICE.txt": Buffer.from("stand-in") }));
const sha1 = createHash("sha1").update(zip).digest("hex");
const list = `<?xml version="1.0" ?><sdk:sdk-repository xmlns:sdk="x"><channel id="channel-0">stable</channel>
${["windows", "macosx", "linux"].map((os) => `<remotePackage path="platform-tools"><revision><major>35</major><minor>0</minor><micro>2</micro></revision><channelRef ref="channel-0"/><archives><archive><complete><size>${zip.length}</size><checksum type="sha1">${sha1}</checksum><url>platform-tools_r35.0.2-${os}.zip</url></complete><host-os>${os}</host-os></archive></archives></remotePackage>`).join("\n")}
</sdk:sdk-repository>`;

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/** A computer with no Android tools: no AITP_ADB_PATH, no ANDROID_HOME, no Taqwright toolchain, no emulators. */
function bareEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, AITP_PHONE_TOOLS: "auto", AITP_PHONE_TOOLS_REPO: REPO, ANDROID_HOME: "", ANDROID_AVD_HOME: path.join(work, "no-avds"), TAQWRIGHT_HOME: path.join(work, "no-taqwright") };
    for (const k of ["AITP_ADB_PATH", "AITP_EMULATOR_PATH", "ANDROID_SDK_ROOT"]) delete env[k];
    return env;
}

async function startAgent(projectId: string, token: string, workDir: string, env: NodeJS.ProcessEnv) {
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: { baseUrl: BASE, token, name: "USB laptop", concurrency: 1, workDir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
        log,
        env,
        browsers: false,
        heartbeatMs: 300,
        backoff: { baseMs: 100, maxMs: 500 },
        fetchImpl: async (input, init) => {
            if (typeof init?.body === "string") sentByAgent.push(init.body);
            return fetch(input, init);
        },
    });
    const done = agent.run();
    const me = await until(async () => ((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ id: string; name: string; online: boolean; capabilities: Record<string, any> }>).find((a) => a.online && a.name === "USB laptop"), "the runner to connect");
    return { agent, done, lines, me };
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phonetools-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phonetools-work-"));
    fs.mkdirSync(path.join(work, "no-avds"));
    google = http.createServer((req, res) => {
        googleRequests.push({ url: req.url ?? "", auth: Boolean(req.headers.authorization) });
        const name = (req.url ?? "").replace(/^\/android\/repository\//, "");
        if (name === "repository2-3.xml") return void res.writeHead(200).end(list);
        if (/^platform-tools_r35\.0\.2-(windows|macosx|linux)\.zip$/.test(name)) return void res.writeHead(200, { "content-length": String(zip.length) }).end(zip);
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => google.listen(GOOGLE_PORT, "127.0.0.1", () => r()));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    Object.assign(deviceOptions, { remote: { lostContactMs: 20_000, claimWaitMs: 10_000, startWaitMs: 60_000, commandWaitMs: 20_000, settleMs: 8_000 } });
}, 60_000);

afterAll(async () => {
    delete deviceOptions.remote;
    await server?.close();
    platform?.db.close();
    await new Promise<void>((r) => google.close(() => r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
});

describe("a runner without Android tools gets Google's phone tools when a phone session arrives", { timeout: 120_000 }, () => {
    it("offers, fetches once into its own folder, says what to do on the phone, reports them ready, and reuses them after a restart", async () => {
        const projectId = (await admin("POST", "/api/projects", { name: "USB phone" })).body.id as string;
        const token = personalRunner(platform, { label: "USB laptop", replace: true, realPhone: true }).secret;
        const workDir = fs.mkdtempSync(path.join(work, "agent-"));
        const env = bareEnv();
        const a = await startAgent(projectId, token, workDir, env);
        try {
            // before: nothing downloaded, the runner offers to get the tools, so it may host a phone session
            expect(a.me.capabilities.phoneTools).toEqual({ state: "can-fetch", note: "The runner gets the Android phone tools from Google when a phone session arrives." });
            expect(a.me.capabilities.deviceSession).toBe(true);
            expect(a.me.capabilities.android).toBeUndefined();
            expect(googleRequests).toEqual([]);
            expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: a.me.id })).status).toBe(200);

            // the session arrives: the runner fetches, then tries the phone; the stand-in adb cannot start on this computer, said in words
            const e = await openDeviceSession({ appPackage: SHOP }, { agents: getAgentServices(platform), projectId, startedBy: OPEN_OWNER_ID }).then(
                () => undefined,
                (x: unknown) => x as Error,
            );
            expect(e).toBeInstanceOf(DeviceSessionError);
            expect(e!.message).toMatch(process.platform === "win32" ? /The Android tools \(adb\) on this computer could not be started/ : /could not be started|could not do that|not found/);
            expect(googleRequests.map((r) => r.url)).toEqual(["/android/repository/repository2-3.xml", `/android/repository/platform-tools_r35.0.2-${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : "linux"}.zip`]);
            // the platform's token never went to Google
            expect(googleRequests.every((r) => !r.auth)).toBe(true);
            const pushed = sentByAgent.join("\n");
            expect(pushed).toContain("This computer has no Android phone tools (adb). The runner gets them from Google");
            expect(pushed).toContain("Downloading the Android phone tools 35.0.2");
            expect(pushed).toContain("Checked the download against Google's size and checksum");
            expect(pushed).toContain("turn on USB debugging");
            expect(pushed).not.toContain(token);

            // in the runner's own folder, nowhere else; ANDROID_HOME of the runner points there
            const adb = path.join(workDir, "phone-tools", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
            expect(fs.existsSync(adb)).toBe(true);
            expect(env.ANDROID_HOME).toBe(path.join(workDir, "phone-tools"));
            expect(process.env.ANDROID_HOME ?? "").not.toBe(env.ANDROID_HOME);

            // afterwards: the tools are ready; with no phone seen the runner no longer claims a phone session
            const after = await until(async () => {
                const row = ((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ id: string; capabilities: Record<string, any> }>).find((x) => x.id === a.me.id);
                return row?.capabilities.phoneTools?.state === "ready" ? row : undefined;
            }, "the tools to be reported ready");
            expect(after.capabilities.phoneTools).toEqual({ state: "ready", version: "35.0.2" });
            expect(after.capabilities.android).toMatchObject({ adb: true, devices: [] });
            expect(after.capabilities.deviceSession).toBeUndefined();
        } finally {
            a.agent.stop();
            await a.done;
        }

        // a restart uses the tools from its folder at once, without a download
        const before = googleRequests.length;
        const env2 = bareEnv();
        const b = await startAgent(projectId, token, workDir, env2);
        try {
            // (the row found first may still be the stopped runner's; wait for the new one's own words and its first poll)
            await until(() => b.lines.some((l) => l.includes("Android phone tools: using the ones the runner fetched before (version 35.0.2)")), "the restarted runner to find its tools");
            await until(() => b.agent.status().state === "connected", "the restarted runner to connect");
            const row = ((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean; capabilities: Record<string, any> }>).find((x) => x.name === "USB laptop" && x.online)!;
            expect(row.capabilities.phoneTools).toEqual({ state: "ready", version: "35.0.2" });
            expect(env2.ANDROID_HOME).toBe(path.join(workDir, "phone-tools"));
            expect(googleRequests.length).toBe(before);
        } finally {
            b.agent.stop();
            await b.done;
        }
    });

    it("a runner set to off (the default for a checkout) offers nothing and is not sent a phone session", async () => {
        const projectId = (await admin("POST", "/api/projects", { name: "Off" })).body.id as string;
        const token = personalRunner(platform, { label: "USB laptop", replace: true, realPhone: true }).secret;
        const env = bareEnv();
        delete env.AITP_PHONE_TOOLS;
        const before = googleRequests.length;
        const a = await startAgent(projectId, token, fs.mkdtempSync(path.join(work, "agent-")), env);
        try {
            expect(a.me.capabilities.phoneTools).toBeUndefined();
            expect(a.me.capabilities.deviceSession).toBeUndefined();
            expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: a.me.id })).status).toBe(200);
            await expect(openDeviceSession({ appPackage: SHOP }, { agents: getAgentServices(platform), projectId, startedBy: OPEN_OWNER_ID })).rejects.toThrow(/USB laptop can't be used to explore a phone: it has no Android tools/);
            expect(googleRequests.length).toBe(before);
        } finally {
            a.agent.stop();
            await a.done;
        }
    });
});
